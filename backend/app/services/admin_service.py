"""The administrative service: one gated surface over users, posts, comments and categories.

This module owns requirement **R11** in full - "a role-gated administrative route group backed by
an administrator-only API namespace exposing listing, state mutation, and deletion for users,
posts, comments, and categories, plus aggregate counts for an overview screen". It is the only
service in the backend that composes across every entity, because the overview screen asks one
question about four relations at once and no single relation can answer it.

Authority is checked here, and that is not redundant by accident
---------------------------------------------------------------
``require_admin`` from ``app.core.dependencies`` is applied at **router level** on the whole
administrative namespace, so no individual administrative route can omit it. Every public method
below *also* calls :meth:`AdminService._require_admin`, and the duplication is deliberate: route
protection is defence in depth rather than a substitute. These methods are reachable from anywhere
in the process - a management command, the seed, a future scheduled job, a test - and a rule
enforced only at whichever entry point happens to exist today is a rule the next entry point
bypasses in silence. Hiding a control in a client is not a security boundary at all.

The predicate is :func:`~app.core.dependencies.is_admin`, called rather than re-implemented. A
second spelling of "does this principal hold ADMIN" is a second place for the answer to drift, and
the version that drifts is always the copy that was not the one being read during review.

Delegation, not duplication
---------------------------
Two rules that belong to sibling services are reached through them rather than restated here:

* **Category lifecycle** goes to :class:`~app.services.category_service.CategoryService`. That
  service derives the slug on creation, deliberately leaves it alone on rename so a canonical URL
  never changes, and refuses to delete a category any post is still filed under. That in-use guard
  is only unavoidable if every path runs through it.
* **Comment moderation** goes to :class:`~app.services.comment_service.CommentService`. Its
  ``set_status`` is the single definition of the moderation transition and of the audit line that
  records it; ``delete`` is the single definition of the ownership predicate and of the
  cascade-not-Python rule for a comment subtree.

Both are constructed with the **same injected session** this service was handed, so a delegated
call participates in one transaction rather than opening a second unit of work beside it.

The import edges run one way. This module imports those two services; neither of them imports this
one, and neither may. The rationale is the one the retired surface supplies: ``app.py`` raised
``HTTPException(status_code=404, detail="Item not found")`` at three separate call sites
(``app.py:L31,L40,L49``), which is what a rule looks like just before the copies begin to disagree.
One declaration, reached from every path, is the replacement.

What this module never does
---------------------------
* **No SQL.** No ``select``, no ``func``, no statement construction of any kind. Every query lives
  in ``app.repositories``, and every aggregate figure comes from a dedicated ``count_*`` method
  rather than from ``len()`` over a listing - which is precisely the whole-collection traversal the
  retired ``GET /items`` performed on every read.
* **No HTTP concern.** No ``fastapi`` import, no ``HTTPException``, no ``Request``, no status-code
  literal. Failures are the typed domain errors in ``app.core.exceptions``, which
  ``app.main``'s registered handlers render as one machine-readable problem document.
* **No response envelope of its own.** Collections return the single
  :class:`~app.core.pagination.Page` envelope; single resources return the mapped entity for the
  router to project. The
  two-member ``message``/``data`` wrapper at ``app.py:L18,L39`` is abolished rather than moved.
* **No content authoring.** ``bleach`` is not imported. Sanitisation belongs to ``post_service``
  and ``comment_service``, and delegating to them is how an administrative edit stays sanitised.
* **No child-row sweep.** Every foreign key in the schema carries ``ON DELETE CASCADE`` and every
  owning relationship carries ``passive_deletes=True``, so one ``DELETE`` removes a user's posts,
  comments, likes and refresh tokens, and a post's comments and likes. A Python-side sweep would be
  slower, would load rows nobody reads, and would be a second definition of a rule the schema
  already guarantees.
* **No configuration read.** The environment is not consulted here by any spelling, and
  ``app.core.config`` is not imported: nothing on this surface needs a setting.

Transaction boundary
--------------------
``app.repositories`` flushes and never commits, leaving the boundary to the service. Each mutating
method here commits once on success and lets exceptions propagate, so ``get_db`` rolls the session
back on the way out and nothing partial survives. ``session.begin()`` is never called: the suite
wraps each test in an outer transaction it rolls back, and a nested explicit begin would break it.
The session is injected and never constructed - this module does not import ``app.db.session`` -
which is what lets a delegated call share the caller's unit of work.

Where a delegate commits, this service does not commit again on top of it. Committing twice is not
an error in SQLAlchemy, but the second call would end a transaction this method never opened, and
the audit line would then describe a write that a different method had already made durable.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import is_admin
from app.core.exceptions import ConflictError, ForbiddenError, NotFoundError
from app.core.logging import get_logger, log_safe_text
from app.core.pagination import Page, build_page
from app.models import Comment, CommentStatus, Post, PostStatus, User, UserRole
from app.repositories import (
    CategoryRepository,
    CommentRepository,
    PostRepository,
    RefreshTokenRepository,
    UserRepository,
)
from app.schemas.admin import (
    AdminComment,
    AdminCommentStatusUpdate,
    AdminPost,
    AdminPostStatusUpdate,
    AdminStats,
    AdminUser,
    AdminUserUpdate,
    CategoryCreate,
    CategoryUpdate,
)
from app.schemas.category import CategoryPublic
from app.services.category_service import CategoryService
from app.services.comment_service import CommentService

__all__ = ["AdminService"]


# ---------------------------------------------------------------------------------------
# Error detail strings
#
# Named and module-level for the same reason the sibling services name theirs: each one is
# published to a client inside a problem document, so it is part of the API's observable
# behaviour rather than an implementation detail, and a reviewer should be able to read every
# message this module can emit without reading the methods that emit them. None of them names
# a column, a constraint or an identifier: a message a caller is not entitled to act on is a
# message that only helps someone enumerating the system.
# ---------------------------------------------------------------------------------------

_USER_NOT_FOUND: Final[str] = "User not found"
_POST_NOT_FOUND: Final[str] = "Post not found"

_SELF_DEMOTION: Final[str] = (
    "An administrator cannot remove their own administrator role. Ask another administrator to "
    "make this change."
)
_SELF_DEACTIVATION: Final[str] = (
    "An administrator cannot deactivate their own account. Ask another administrator to make "
    "this change."
)
_SELF_DELETION: Final[str] = (
    "An administrator cannot delete their own account. Ask another administrator to make this "
    "change."
)


# ---------------------------------------------------------------------------------------
# Payload member names
#
# The keys `model_dump(exclude_unset=True)` produces, spelled once each. A literal repeated
# between the membership test and the audit line is a typo away from an update that silently
# applies nothing, and a mistyped name is not a type error a checker can see.
# ---------------------------------------------------------------------------------------

_FIELD_ROLE: Final[str] = "role"
_FIELD_IS_ACTIVE: Final[str] = "is_active"


def _offset(page: int, page_size: int) -> int:
    """Translate a 1-based page and its size into the SQL ``OFFSET`` a repository wants.

    The arithmetic :attr:`~app.core.dependencies.PageParams.offset` performs, restated for
    callers that pass the page and its size as plain integers rather than the dependency
    object. Four listing methods need it, so it is written once here: repeating
    ``(page - 1) * page_size`` four times is four chances to write ``page * page_size`` and
    lose the first row of every page.

    Stating it as a function rather than reaching for ``PageParams`` keeps every method on this
    service callable from a unit test with no request, and from the seed, with no dependency
    object to fabricate.

    Args:
        page: The 1-based page requested. Bounded to ``>= 1`` by ``PageParams`` long before it
            arrives here, so the result is never negative on any request-driven path.
        page_size: Rows per page. Bounded to ``1..100`` by ``PageParams``.

    Returns:
        Rows to skip to reach the requested page: zero for the first page.

    Examples:
        >>> _offset(1, 20)
        0
        >>> _offset(3, 20)
        40
    """
    return (page - 1) * page_size


def _publication_instant() -> datetime:
    """Return the instant to stamp on a post becoming public: now, timezone-aware, in UTC.

    ``posts.published_at`` is ``TIMESTAMPTZ``, so a naive value would be interpreted against the
    connection's time zone and would make a publication date depend on where the process happens to
    be running. Named rather than inlined so the one instant this module records is produced in one
    place, and so a test can see what it is asserting about.

    It intentionally mirrors the helper ``app.services.post_service`` uses for its own publish
    transition rather than importing it: that name is private to that module, and reaching across a
    module boundary for a private helper is a coupling that no signature declares and no reader
    expects. The behaviour, not the function, is what has to agree between the two - and what
    agrees is documented on :meth:`AdminService.set_post_status`.

    Returns:
        ``datetime.now(UTC)`` - aware, and in UTC.
    """
    return datetime.now(UTC)


class AdminService:
    """Every operation the administrative dashboard performs, behind one authority check.

    Constructed per request from the session ``get_db`` yielded, and consumed by
    ``app.api.v1.routers.admin``::

        service = AdminService(session)

        # GET /api/v1/admin/stats - four aggregates, no rows.
        stats = await service.get_stats(actor=administrator)

        # GET /api/v1/admin/posts - the one listing that spans DRAFT, PUBLISHED and ARCHIVED.
        table = await service.list_posts(actor=administrator, page=1, page_size=20)

        # PATCH /api/v1/admin/users/{id} - a promotion.
        await service.update_user(
            user.id, AdminUserUpdate(role=UserRole.AUTHOR), actor=administrator
        )

    Instances are cheap, cache nothing between calls, and are exactly as concurrency-safe as the
    :class:`~sqlalchemy.ext.asyncio.AsyncSession` they wrap - which is to say they must not be
    shared between concurrent tasks, because a session is one unit of work over one connection.

    Attributes:
        session: The unit of work every statement is issued through, and the object whose
            transaction this class commits. Stored, never replaced, and shared with the two
            delegate services below so a delegated call stays inside one transaction.
    """

    def __init__(self, session: AsyncSession) -> None:
        """Bind the service to one unit of work and assemble its collaborators.

        Args:
            session: The request-scoped session. Supplied by the caller - ``get_db`` in the API
                tier, the transactional fixture in the suite - because a service that opened a
                session of its own could not participate in a caller's transaction, and every
                test in the suite depends on being able to roll one back.

        Note:
            **Five repositories, one per relation this surface reports on, plus the token
            relation.** ``UserRepository``, ``PostRepository``, ``CommentRepository`` and
            ``CategoryRepository`` back the four tables and the four aggregate figures.
            ``RefreshTokenRepository`` is here for exactly one reason: suspending an account
            withdraws the tokens it still holds, and token bookkeeping belongs to the repository
            that owns the relation rather than to this module.

            ``LikeRepository`` is deliberately absent. :class:`~app.schemas.admin.AdminStats`
            declares four counts and no like count, and a figure this service gathered but never
            published would be a round trip with no reader.

            **Two delegate services, both handed this same session.** That is what makes a
            delegated category write or comment transition part of the caller's transaction
            instead of a second unit of work racing beside it.
        """
        self.session = session

        self._users = UserRepository(session)
        self._posts = PostRepository(session)
        self._comments = CommentRepository(session)
        self._categories = CategoryRepository(session)
        self._refresh_tokens = RefreshTokenRepository(session)

        self._category_service = CategoryService(session)
        self._comment_service = CommentService(session)

    # -----------------------------------------------------------------------------------
    # Authority
    # -----------------------------------------------------------------------------------

    def _require_admin(self, actor: User) -> None:
        """Raise unless the principal holds ``ADMIN``. Called first in every public method.

        Synchronous and pure: it performs no I/O, reads no request and touches no session, so
        ``backend/tests/unit/test_permissions.py`` can exercise it against a fabricated user with
        nothing running. That testability is the reason it is a method rather than an inline
        ``if`` in fifteen places.

        Args:
            actor: The resolved principal, loaded on this request. A stale instance would answer
                with a stale role, which is why the API tier resolves the user per request rather
                than trusting a role claim carried in a token.

        Raises:
            ForbiddenError: The principal does not hold ``ADMIN``. Raised bare, so the response
                is the class's own 403 problem document and reveals nothing about what the
                operation would have touched. 403 rather than 404 is correct throughout this
                namespace: the routes are documented in ``/openapi.json``, so their existence is
                public knowledge and concealing it would protect nothing.

        Note:
            :func:`~app.core.dependencies.is_admin` is the predicate, never a local re-spelling
            of it. It compares enum members rather than strings, which makes a misspelt role name
            an ``AttributeError`` at import time instead of an authorisation bypass at runtime.

            Ownership plays no part here, so ``ensure_can_modify`` is not used: an administrator
            acts on content they do not own, and that is the entire privilege the role expresses.
        """
        if not is_admin(actor):
            raise ForbiddenError

    # -----------------------------------------------------------------------------------
    # Overview
    # -----------------------------------------------------------------------------------

    async def get_stats(self, *, actor: User) -> AdminStats:
        """Gather the four aggregate figures the overview screen renders.

        Behind ``GET /api/v1/admin/stats``. The one place in the product where four relations are
        reported on together, and the reason this service exists as something more than the sum of
        its siblings.

        Args:
            actor: The resolved principal. Must hold ``ADMIN``.

        Returns:
            :class:`~app.schemas.admin.AdminStats` carrying ``user_count``, ``post_count``,
            ``comment_count`` and ``category_count`` - exactly the four members that model
            declares, and no fifth figure this method happened to have to hand.

        Raises:
            ForbiddenError: The principal does not hold ``ADMIN``.

        Note:
            **Four aggregates by design, not four listings.** Each call is a dedicated
            ``count_*`` method that emits ``SELECT count(*)`` and constructs no entity, so the
            cost is four round trips regardless of how large the relations are.
            ``len(await ...list_users(...))`` would be the alternative, and it would be the
            retired system's defining performance characteristic brought back: the in-memory
            service traversed its whole collection on every read, and an overview built from
            listings would traverse four.

            **Four separate statements rather than one composed query, also by design.** The
            relations share no join key that would make a single statement cheaper - counting
            users and counting categories have nothing in common to join on - so a ``UNION`` or a
            set of correlated sub-selects would be a more complex statement with the same number
            of index-only scans behind it, and a harder one to read.

            **Unfiltered totals.** Every count is taken over the whole relation, with no status,
            role or moderation narrowing, because the overview reports the size of the system
            rather than the size of a queue. Narrowed figures are available from the same
            repository methods - ``count_comments(statuses=(CommentStatus.PENDING,))`` is the
            pending queue - and adding one here would need a member on ``AdminStats`` first.

            **Not a snapshot.** Each statement takes its own snapshot under READ COMMITTED, so a
            row inserted between the first and the fourth call is visible to the later ones and
            not the earlier. That is correct for a dashboard figure and is not worth a repeatable
            -read transaction: an overview is read to see orders of magnitude, and the alternative
            would hold a snapshot open across four round trips to make four numbers agree about an
            instant that has already passed.
        """
        self._require_admin(actor)

        user_count = await self._users.count_users()
        post_count = await self._posts.count_posts()
        comment_count = await self._comments.count_comments()
        category_count = await self._categories.count_categories()

        return AdminStats(
            user_count=user_count,
            post_count=post_count,
            comment_count=comment_count,
            category_count=category_count,
        )

    # -----------------------------------------------------------------------------------
    # Users
    # -----------------------------------------------------------------------------------

    async def list_users(
        self,
        *,
        actor: User,
        q: str | None = None,
        role: UserRole | None = None,
        is_active: bool | None = None,
        page: int,
        page_size: int,
    ) -> Page[AdminUser]:
        """Window the account table for the administrative users screen.

        Behind ``GET /api/v1/admin/users``. The three filters compose, and ``total`` counts the
        filtered set rather than the relation, so the page controls describe the result the
        administrator is actually looking at.

        Args:
            actor: The resolved principal. Must hold ``ADMIN``.
            q: Optional free-text term matched against ``username`` and ``email``. Whitespace-only
                and ``None`` are equivalent - the repository normalises that - so an empty search
                box does not add a predicate matching everything.
            role: Optional exact authority filter, for "show me the administrators".
            is_active: Optional exact activity filter. ``False`` is meaningful rather than falsy
                here - "show me the suspended accounts" is why the filter exists - and the
                repository tests it against ``None`` for that reason.
            page: The 1-based page requested. A page past the last one is not an error: it returns
                an empty ``items`` list beside the real ``pages``.
            page_size: Rows per page.

        Returns:
            The one page envelope every collection in this API returns, its items projected
            through :class:`~app.schemas.admin.AdminUser`.

        Raises:
            ForbiddenError: The principal does not hold ``ADMIN``.
            ValueError: Propagated from ``build_page`` if ``page_size`` is not positive, which can
                only arrive from a defect in a caller: request values are bounded to
                ``1..100`` by ``PageParams`` well before they reach here.

        Note:
            **``AdminUser`` exposes ``email``, ``role`` and ``is_active``, which
            :class:`~app.schemas.user.UserPublic` withholds.** That asymmetry is the entire reason
            a separate projection exists, and it runs one way only: the administrative model is
            widened for this gated surface, and the public model is never widened to serve it.

            **``password_hash`` is not a member of that model and must never become one.** The
            projection is what enforces it - ``AdminUser`` has eight declared fields and no
            ``extra="allow"`` - so the hash cannot reach a response even though the entity this
            method reads carries it.

            **One statement plus its count.** The repository composes the filters, the total
            ordering and the window into a single query; nothing here loops, re-filters or
            re-sorts what came back.
        """
        self._require_admin(actor)

        rows, total = await self._users.list_users(
            q=q,
            role=role,
            is_active=is_active,
            limit=page_size,
            offset=_offset(page, page_size),
        )
        items = [AdminUser.model_validate(row) for row in rows]
        return build_page(items, total, page, page_size)

    async def update_user(
        self,
        user_id: uuid.UUID,
        payload: AdminUserUpdate,
        *,
        actor: User,
    ) -> User:
        """Change an account's authority, its activity, or both.

        Behind ``PATCH /api/v1/admin/users/{user_id}``. A genuine partial update: only the members
        the caller actually sent are applied, which replaces the whole-object replacement the
        retired ``PUT /items/{item_id}`` performed at ``app.py:L34-L40`` and required a client to
        resend every field it was not changing.

        This is also the only path to ``ADMIN`` in the product. ``auth_service.register`` grants
        ``AUTHOR`` and carries no ``role`` member at all, so administrator authority is granted by
        the seed or by an existing administrator here, and by nothing else.

        Args:
            user_id: The account's server-generated identifier, from the URL path.
            payload: The validated body. ``role`` and ``is_active`` are both optional; an omitted
                member means "leave unchanged", and the schema rejects an explicit null rather
                than treating it as a third spelling of nothing.
            actor: The resolved principal. Must hold ``ADMIN``.

        Returns:
            The updated account, with the ``updated_at`` PostgreSQL just re-derived.

        Raises:
            ForbiddenError: The principal does not hold ``ADMIN``.
            NotFoundError: No account carries that identifier. Resolved **before** the lockout
                guards below, because "this account does not exist" and "this change may not be
                made" are different answers and a caller needs the one that is true.
            ConflictError: The actor is trying to remove their own administrator role or suspend
                their own account. See the note - this is a lockout guard, not an authority rule.

        Note:
            **The two lockout guards are not authority rules, and 409 rather than 403 says so.**
            The actor demonstrably holds the authority for this operation - they passed
            :meth:`_require_admin` - so a 403 would be a lie about why the request failed. What is
            refused is applying *this particular change* to *this particular account*, which is
            exactly what 409 means. Both are refused unconditionally rather than only when the
            actor is the last remaining administrator: counting administrators and then acting on
            the count is a race between the count and the write, and the remedy for the
            unconditional rule is trivial and always available - another administrator makes the
            change. A system with one administrator who can demote themselves has a route to a
            state no one can recover from without database access.

            Note what is *not* guarded. An administrator may freely change any other account's
            role, including demoting another administrator, and may suspend any other account.
            That is the privilege the role exists to express.

            **Suspending an account withdraws the refresh tokens it still holds.** The decision is
            deliberate and it is defence in depth rather than a fix: ``authenticate`` refuses a
            deactivated account with 403, ``rotate_refresh_token`` refuses one with 401, and
            ``get_current_active_user`` refuses one on every request, so the flag is already
            honoured on all three paths. Revoking is what stops a suspended account's outstanding
            tokens from lying dormant as live credentials that spring back the moment the account
            is restored - restoration should be a decision to let someone back in, not a decision
            to reinstate every session they had open. It is done through
            ``RefreshTokenRepository.revoke_all_for_user``, because no token logic belongs in this
            module, and it is a single bulk ``UPDATE`` whose cost does not grow with the number of
            sessions. Only the count is logged; no token and no token hash is ever recorded.

            The reverse transition does not restore tokens, and cannot: a revoked token is
            withdrawn, not paused, and the account signs in again to obtain a new one.

            **The row is fetched under ``FOR UPDATE``.** Two administrators editing one account
            concurrently would otherwise both read the same role and both write, and the later
            write would silently discard the earlier decision. The lock serialises them, and it is
            released by the commit below or by the rollback ``get_db`` performs on its way out.
        """
        self._require_admin(actor)

        user = await self._users.get_by_id(user_id, for_update=True)
        if user is None:
            raise NotFoundError(_USER_NOT_FOUND)

        # `exclude_unset` is what distinguishes "leave this alone" (member absent) from a value
        # the caller actually sent. The KEYS are the instruction set; the VALUES are read from the
        # model's attributes below, because `model_dump` widens every value to `Any` while the
        # attribute carries the validated type the schema declares.
        changes = payload.model_dump(exclude_unset=True)
        if not changes:
            # Nothing was sent, so nothing is written and nothing is committed. An empty patch is a
            # successful no-op rather than an error: a management form submitted without edits is
            # legitimate client behaviour.
            return user

        # Lockout guards. Deliberately placed after the not-found resolution and before any
        # assignment, so a refused request leaves the row exactly as it was.
        if user.id == actor.id:
            # `is not None` is the test for "was sent", because the schema's own validator rejects
            # an explicit null - so a role that is not None is a role the caller chose. Promoting
            # oneself is impossible by definition (the actor already holds ADMIN) and re-sending
            # ADMIN is a harmless no-op, so only a move *away* from ADMIN is refused.
            if payload.role is not None and payload.role is not UserRole.ADMIN:
                raise ConflictError(_SELF_DEMOTION)
            # `is False` rather than `not payload.is_active`: None means the member was omitted and
            # True is a request to keep the account active, neither of which is a lockout.
            if payload.is_active is False:
                raise ConflictError(_SELF_DEACTIVATION)

        previous_role = user.role
        previous_is_active = user.is_active

        if _FIELD_ROLE in changes:
            role = payload.role
            # `users.role` is NOT NULL, so a null that slipped past the schema's validator must not
            # reach the column and surface as a 500 describing an integrity violation several
            # layers from the request member that caused it. Skipping is the safe branch.
            if role is not None:
                user.role = role

        if _FIELD_IS_ACTIVE in changes:
            active = payload.is_active
            # Same reasoning: `users.is_active` is NOT NULL with a server default of true.
            if active is not None:
                user.is_active = active

        # `save` flushes the UPDATE and reloads the row, so the returned entity carries the
        # `updated_at` PostgreSQL just re-derived rather than an attribute a response serialiser
        # would find stale.
        await self._users.save(user)

        # Ordered after the account write and before the commit, so the suspension and the
        # withdrawal are one atomic decision: an account cannot end up suspended with live tokens,
        # nor have its tokens withdrawn while remaining active.
        revoked = 0
        if previous_is_active and not user.is_active:
            revoked = await self._refresh_tokens.revoke_all_for_user(user.id)

        await self.session.commit()

        # Obtained here rather than at module scope. `app.core.logging` documents that
        # `get_logger` must not be called at import time - a logger bound while a module is being
        # imported can memoise structlog's unconfigured defaults and never notice
        # `configure_logging` running afterwards - and every logging module in this backend
        # follows that contract.
        get_logger(__name__).info(
            "admin user updated",
            user_id=str(user.id),
            actor_id=str(actor.id),
            changed=sorted(changes),
            previous_role=previous_role.value,
            role=user.role.value,
            previous_is_active=previous_is_active,
            is_active=user.is_active,
            refresh_tokens_revoked=revoked,
        )
        return user

    async def delete_user(self, user_id: uuid.UUID, *, actor: User) -> None:
        """Delete an account and, through the schema, everything that hung off it.

        Behind ``DELETE /api/v1/admin/users/{user_id}``, which answers ``204`` with no body - hence
        the ``None`` return. Irreversible, and the blunter of the two moderation tools:
        :meth:`update_user` with ``is_active=False`` suspends an account reversibly and leaves its
        content in place, which is the one to reach for first.

        Args:
            user_id: The account's server-generated identifier, from the URL path.
            actor: The resolved principal. Must hold ``ADMIN``.

        Returns:
            ``None``. There is no body to model and nothing to project.

        Raises:
            ForbiddenError: The principal does not hold ``ADMIN``.
            NotFoundError: No account carries that identifier. Resolved first, before the
                self-deletion guard, for the same reason as in :meth:`update_user`.
            ConflictError: The actor is trying to delete their own account. A lockout guard rather
                than an authority rule - see :meth:`update_user`.

        Note:
            **Nothing here deletes a child row, and nothing may.** Every foreign key referencing
            ``users.id`` carries ``ON DELETE CASCADE``, and every owning relationship on
            :class:`~app.models.user.User` carries ``passive_deletes=True``, which is what stops
            SQLAlchemy loading each collection in order to delete rows PostgreSQL was going to
            remove anyway. One statement therefore removes the account's posts, its comments, its
            likes and its refresh tokens - and, cascading again from each post, that post's own
            comments and likes.

            A Python-side sweep would be redundant, slower, and a second definition of a rule the
            schema already guarantees. It would also be the copy that forgets a relation added
            later, which is the specific way a duplicated rule fails.

            **The row is fetched before it is deleted rather than removed by key.** The fetch is
            what makes the 404 and the self-deletion guard possible, and it takes the lock that
            serialises this delete against a concurrent update of the same account.
        """
        self._require_admin(actor)

        user = await self._users.get_by_id(user_id, for_update=True)
        if user is None:
            raise NotFoundError(_USER_NOT_FOUND)

        if user.id == actor.id:
            raise ConflictError(_SELF_DELETION)

        # Captured before the row goes: the instance is deleted by the statement below, so reading
        # either attribute for the audit line afterwards would fail.
        deleted_id = str(user.id)
        deleted_role = user.role.value

        await self._users.delete(user)
        await self.session.commit()

        get_logger(__name__).info(
            "admin user deleted",
            user_id=deleted_id,
            actor_id=str(actor.id),
            role=deleted_role,
        )

    # -----------------------------------------------------------------------------------
    # Posts
    # -----------------------------------------------------------------------------------

    async def list_posts(
        self,
        *,
        actor: User,
        q: str | None = None,
        status: PostStatus | None = None,
        author_id: uuid.UUID | None = None,
        page: int,
        page_size: int,
    ) -> Page[AdminPost]:
        """Window every post, in every lifecycle state, for the administrative posts screen.

        Behind ``GET /api/v1/admin/posts``. This is the one listing in the product that spans
        ``DRAFT``, ``PUBLISHED`` and ``ARCHIVED``, and that is exactly the point of an
        administrative table: a moderator who can see only what a reader can see cannot moderate.

        Args:
            actor: The resolved principal. Must hold ``ADMIN``.
            q: Optional search term - ranked full-text matching over title, excerpt and body,
                OR-ed with typo-tolerant trigram matching on the title. Whitespace-only and
                ``None`` are equivalent.
            status: Optional single-state filter, for a per-status tab. ``None`` means every state.
            author_id: Optional restriction to one author's posts, taken as an identifier rather
                than a username because this surface addresses accounts by key.
            page: The 1-based page requested.
            page_size: Rows per page.

        Returns:
            The one page envelope, its items projected through
            :class:`~app.schemas.admin.AdminPost`.

        Raises:
            ForbiddenError: The principal does not hold ``ADMIN``.
            ValueError: Propagated from ``build_page`` if ``page_size`` is not positive.

        Note:
            **This deliberately bypasses the public status scope, and it is safe only because the
            surface is gated twice.** Every reader-facing listing narrows itself with
            ``visible_statuses_for``; this one passes ``statuses=None``, the repository's spelling
            for "every lifecycle state". ``require_admin`` gates the router and
            :meth:`_require_admin` re-checks here, so there is no path to this breadth that has
            not already established the caller's authority.

            **``None`` rather than an exhaustive tuple, and the difference is a query plan.**
            Enumerating every enum value produces ``status IN ('DRAFT','PUBLISHED','ARCHIVED')``,
            which is a predicate the planner has to satisfy - and one that no single index can
            satisfy *in this listing's global order*. ``ix_posts_status_published_at`` leads with
            ``status``, so it orders rows within a state; a three-value ``IN`` would have to merge
            three ordered groups, so PostgreSQL sorts the whole relation before applying ``LIMIT``.
            ``None`` emits no status predicate at all, which is what lets
            ``ix_posts_published_at_id`` - declared ``(published_at DESC NULLS LAST, id DESC)``
            for exactly this surface - supply the ordering directly. A tuple naming every state
            and no tuple at all return identical rows; only one of them is answerable from an
            index.

            **``statuses`` is an argument the caller decides, never a decision the repository
            takes.** That separation is what lets one composed query serve the public feed, an
            author's profile, the author workspace and this table, with the authority question
            answered once per surface in the service layer.

            **The repository eager-loads ``author`` and narrows every column to what this model
            serialises**, so ``AdminPost.model_validate`` finds the byline already present and the
            statement fetches no article body, no search vector and no private ``users`` column.
            Nothing here loops to fetch a relation, which under an async session would raise
            ``MissingGreenlet`` rather than quietly issuing a query per row - an N+1 surfaces as a
            failure instead of as a slow page. ``categories`` is deliberately not loaded at all:
            :class:`~app.schemas.admin.AdminPost` has no such member, and a relation nothing renders
            is a statement with no consumer.

            **No ``sort`` argument.** The repository's default ordering is recency, which is what a
            management table wants: an administrator scanning for what changed recently is not
            reading a relevance-ranked feed. Ordering is total - the tiebreaker is the primary key -
            so paging is stable and a row cannot appear on two consecutive pages.
        """
        self._require_admin(actor)

        # `None` is the repository's spelling for "every lifecycle state", and it is passed rather
        # than an exhaustive tuple because the two are equivalent in rows and NOT equivalent in
        # plan - see the note above. A single-status tab still passes its one state, which is an
        # equality predicate ix_posts_status_published_at serves directly.
        statuses = None if status is None else (status,)

        rows, total = await self._posts.list_posts(
            q=q,
            author_id=author_id,
            statuses=statuses,
            # The administrative projection: the eight columns `AdminPost` declares plus the public
            # author fields, and NO categories - that model does not carry them, so loading the
            # association would be one extra statement and one extra entity per row for a column
            # this table never renders. `content` and `search_vector` are not fetched either.
            projection="admin",
            limit=page_size,
            offset=_offset(page, page_size),
        )
        items = [AdminPost.model_validate(row) for row in rows]
        return build_page(items, total, page, page_size)

    async def set_post_status(
        self,
        post_id: uuid.UUID,
        payload: AdminPostStatusUpdate,
        *,
        actor: User,
    ) -> Post:
        """Force a post into a lifecycle state, on any author's post.

        Behind ``PATCH /api/v1/admin/posts/{post_id}/status``. The administrative counterpart to
        the author's own ``publish`` and ``unpublish`` transitions, and the only way to reach
        ``ARCHIVED``: withdrawing a post without destroying it is a moderation decision, and it is
        deliberately reversible.

        Args:
            post_id: The post's server-generated identifier, from the URL path.
            payload: The validated body carrying the destination ``status``. Required, because
                "change the status" with no destination is not a request.
            actor: The resolved principal. Must hold ``ADMIN``.

        Returns:
            The post in its new state, with ``author`` loaded so the administrative projection can
            be built.

        Raises:
            ForbiddenError: The principal does not hold ``ADMIN``.
            NotFoundError: No post carries that identifier. Resolved before anything is written.

        Note:
            **The publication instant and the state are written adjacently, with the instant
            first.** ``ck_posts_published_at_required`` -
            ``CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL)`` - therefore cannot be
            reached by this path even in principle. That constraint is a backstop against a defect
            elsewhere, not a validator this code leans on: a published post with no publication
            date would have to be a change to these two lines.

            **An existing instant is preserved rather than re-stamped.** The default feed ordering
            is ``(status, published_at DESC)``, so re-stamping would silently move a months-old
            article to the top of the home page; and republishing an archived post returns it to
            the feed carrying the date readers, the sitemap and the structured data have already
            been given. This matches ``post_service.publish`` exactly.

            **Moving away from ``PUBLISHED`` leaves ``published_at`` alone**, which matches
            ``post_service.unpublish`` exactly, and the agreement is the requirement rather than a
            coincidence: the same post must not behave differently according to which door the
            transition came through. The column records *when the post first became public* and
            ``status`` records *whether it is public now*; the two answer different questions, so
            clearing one to express the other would destroy information nothing can recover. It
            would satisfy the constraint just as well - the check only constrains the published
            state - so this is a choice about meaning, not about validity.

            **Setting the state a post is already in is a no-op, not an error.** ``save`` finds
            nothing dirty and emits no ``UPDATE``, which makes the endpoint idempotent and safe for
            an administrative client to retry. The commit is still issued, deliberately: it ends
            the transaction holding this row's ``FOR UPDATE`` lock, which would otherwise be held
            for the remainder of the request against a post nobody is changing.

            **No ownership check.** An administrator acts on any author's post; that is the
            privilege, and ``ensure_can_modify`` would be the wrong predicate here because
            ownership is not a route to this operation.

            **``author`` is loaded by the repository, before the commit.**
            :class:`~app.schemas.admin.AdminPost` needs the byline, so the locked read asks for it
            with ``with_relations=True`` and the flush re-reads it - both statements issued by
            ``PostRepository``, which is the layer entitled to issue them, and both inside this
            transaction. Nothing is read after the ``COMMIT``: a load that failed there would leave
            the status change durable while the client received an error, and there would be no
            transaction left to roll back.

            The lock still covers exactly one row of ``posts``. The relations arrive through
            ``selectinload``'s separate unlocked statements, so no author account is held under a
            write lock because a byline had to be rendered.
        """
        self._require_admin(actor)

        # `with_relations=True`: AdminPost renders the byline, so the author is requested as part
        # of the locked read rather than reached for afterwards.
        post = await self._posts.get_for_update(post_id, with_relations=True)
        if post is None:
            raise NotFoundError(_POST_NOT_FOUND)

        previous_status = post.status
        status = payload.status

        # Both members of the database invariant, adjacent and in this order. `published_at` is
        # assigned unconditionally so the pairing is one statement to read rather than a branch to
        # reason about, and the conditional lives inside the value: an instant already recorded is
        # kept, and one is minted only when the post is becoming public for the first time.
        if status is PostStatus.PUBLISHED and post.published_at is None:
            post.published_at = _publication_instant()
        post.status = status

        # Flushes the UPDATE and re-reads the row with its relations, so `updated_at` on the
        # returned entity is the value PostgreSQL just re-derived and the byline is present. With
        # nothing dirty it flushes nothing and simply re-reads.
        updated = await self._posts.save_with_relations(post)
        await self.session.commit()

        get_logger(__name__).info(
            "admin post status changed",
            post_id=str(updated.id),
            slug=log_safe_text(updated.slug),
            actor_id=str(actor.id),
            author_id=str(updated.author_id),
            previous_status=previous_status.value,
            status=updated.status.value,
            published_at=(
                None if updated.published_at is None else updated.published_at.isoformat()
            ),
        )

        return updated

    async def delete_post(self, post_id: uuid.UUID, *, actor: User) -> None:
        """Delete any author's post, and with it every comment and like it carried.

        Behind ``DELETE /api/v1/admin/posts/{post_id}``, which answers ``204`` with no body - hence
        the ``None`` return. Irreversible; :meth:`set_post_status` to ``ARCHIVED`` is the reversible
        withdrawal and is the tool to reach for first.

        Args:
            post_id: The post's server-generated identifier, from the URL path.
            actor: The resolved principal. Must hold ``ADMIN``.

        Returns:
            ``None``. There is no body to model.

        Raises:
            ForbiddenError: The principal does not hold ``ADMIN``.
            NotFoundError: No post carries that identifier.

        Note:
            **Nothing here deletes a comment, a like or an association row.**
            ``comments.post_id``, ``post_likes.post_id`` and ``post_categories.post_id`` all carry
            ``ON DELETE CASCADE``, and the matching collections on
            :class:`~app.models.post.Post` all carry ``passive_deletes=True``, so one statement
            removes the post and PostgreSQL removes everything that referenced it - including, by
            cascading again from each comment, that comment's whole reply subtree at any depth.

            **No ownership check**, for the same reason as in :meth:`set_post_status`: acting on
            another author's content is the privilege the role expresses.

            **The row is fetched before it is deleted rather than removed by key**, because the
            fetch is what makes the 404 possible and what takes the lock serialising this delete
            against a concurrent status change of the same post.
        """
        self._require_admin(actor)

        post = await self._posts.get_for_update(post_id)
        if post is None:
            raise NotFoundError(_POST_NOT_FOUND)

        # Captured before the row goes: the statement below deletes the instance, so reading these
        # attributes for the audit line afterwards would fail.
        deleted_id = str(post.id)
        deleted_slug = log_safe_text(post.slug)
        author_id = str(post.author_id)
        deleted_status = post.status.value

        await self._posts.delete(post)
        await self.session.commit()

        get_logger(__name__).info(
            "admin post deleted",
            post_id=deleted_id,
            slug=deleted_slug,
            actor_id=str(actor.id),
            author_id=author_id,
            status=deleted_status,
        )

    # -----------------------------------------------------------------------------------
    # Comments - moderation state and deletion are delegated
    # -----------------------------------------------------------------------------------

    async def list_comments(
        self,
        *,
        actor: User,
        status: CommentStatus | None = None,
        q: str | None = None,
        post_id: uuid.UUID | None = None,
        page: int,
        page_size: int,
    ) -> Page[AdminComment]:
        """Window the moderation queue for the administrative comments screen.

        Behind ``GET /api/v1/admin/comments``. Unlike a post's public thread this includes comments
        in every moderation state and at every depth, because a queue an administrator cannot see
        into is not a queue.

        Args:
            actor: The resolved principal. Must hold ``ADMIN``.
            status: Optional single-state filter. ``PENDING`` alone is the moderation queue proper -
                the reason ``ix_comments_status`` exists - and ``None`` means every state.
            q: Optional case-insensitive containment match on the comment body. Whitespace-only and
                ``None`` are equivalent.
            post_id: Optional restriction to one post's comments, for moderating a single thread.
            page: The 1-based page requested.
            page_size: Rows per page.

        Returns:
            The one page envelope, its items projected through
            :class:`~app.schemas.admin.AdminComment`.

        Raises:
            ForbiddenError: The principal does not hold ``ADMIN``.
            ValueError: Propagated from ``build_page`` if ``page_size`` is not positive.

        Note:
            **The repository eager-loads ``author`` and nothing else, so nothing here loops.** This
            is the busiest administrative screen in the product, and a query per row to fetch a
            commenter would be an N+1 on exactly the page that can least afford one. Under an async
            session it would not even be a slow page: a missing eager load raises
            ``MissingGreenlet``, so the mistake fails loudly rather than degrading quietly. The
            byline itself is narrowed to the six public ``UserPublic`` fields, so no moderator's
            page ever carries a commenter's email address, role or password hash.

            **``AdminComment`` carries ``post_id`` rather than a nested post, and the statement now
            matches that.** The projection is the schema layer's decision and this method does not
            widen it - but the repository used to load the related ``Post`` anyway, which meant a
            page of twenty comments fetched up to twenty whole articles, bodies and search vectors
            included, in order to serialise a UUID that was already a column of the comment row. It
            no longer does. An administrator who needs the article opens it by that identifier.

            **The body is returned as stored.** It was sanitised on write by ``comment_service``,
            which is the one place that policy is applied, and re-sanitising a stored value here
            would be a second copy of a security control - the copy that would be forgotten when
            the policy changed.
        """
        self._require_admin(actor)

        statuses = None if status is None else (status,)

        rows, total = await self._comments.list_moderation_queue(
            statuses=statuses,
            q=q,
            post_id=post_id,
            limit=page_size,
            offset=_offset(page, page_size),
        )
        items = [AdminComment.model_validate(row) for row in rows]
        return build_page(items, total, page, page_size)

    async def set_comment_status(
        self,
        comment_id: uuid.UUID,
        payload: AdminCommentStatusUpdate,
        *,
        actor: User,
    ) -> Comment:
        """Approve, reject or re-queue a comment, by delegating the transition.

        Behind ``PATCH /api/v1/admin/comments/{comment_id}/status``. Approval is the only way a
        comment becomes publicly visible, and rejection is what makes moderation reversible - a
        rejected comment stops being public without ceasing to exist, which deletion cannot offer.

        Args:
            comment_id: The comment's server-generated identifier, from the URL path.
            payload: The validated body carrying the destination ``status``. Required.
            actor: The resolved principal. Must hold ``ADMIN``.

        Returns:
            The comment in its new state, with ``author`` loaded - the delegate guarantees that, so
            the administrative projection can be built without a further round trip.

        Raises:
            ForbiddenError: The principal does not hold ``ADMIN``. Raised here by
                :meth:`_require_admin`, and again by the delegate for a caller that reaches it by
                another route.
            NotFoundError: No comment carries that identifier. Raised by the delegate, before its
                own authority check, as everywhere else in this codebase.

        Note:
            **The column is not written here, and must not be.**
            :meth:`~app.services.comment_service.CommentService.set_status` is the single
            definition of the moderation transition: it takes the row's lock, checks authority
            itself, treats a no-op transition as idempotent rather than as a conflict, emits the
            moderation audit line, and reloads the author. Writing ``comment.status`` here would put
            a second, drifting copy of all five of those decisions in the codebase - which is the
            exact failure mode this project retired when it replaced three duplicated
            ``HTTPException(404)`` raises with one registered handler.

            **The delegate is constructed with this service's session**, so its commit ends this
            request's transaction rather than a second one, and this method issues no commit of its
            own on top of it.

            **The authority check here is not redundant even though the delegate makes one too.**
            This method is reachable independently, and a guard is only worth having where it cannot
            be skipped. It also means the refusal is identical across every method on this service,
            so an administrative client sees one behaviour rather than a per-route lottery.
        """
        self._require_admin(actor)

        comment = await self._comment_service.set_status(comment_id, payload.status, actor=actor)

        get_logger(__name__).info(
            "admin comment status changed",
            comment_id=str(comment.id),
            post_id=str(comment.post_id),
            actor_id=str(actor.id),
            author_id=str(comment.author_id),
            status=comment.status.value,
        )
        return comment

    async def delete_comment(self, comment_id: uuid.UUID, *, actor: User) -> None:
        """Delete any reader's comment, and its whole reply subtree, by delegating.

        Behind ``DELETE /api/v1/admin/comments/{comment_id}``, which answers ``204`` with no body -
        hence the ``None`` return. Final; :meth:`set_comment_status` to ``REJECTED`` is the
        reversible way to remove a comment from public view and is the tool to reach for first.

        Args:
            comment_id: The comment's server-generated identifier, from the URL path.
            actor: The resolved principal. Must hold ``ADMIN``.

        Returns:
            ``None``. There is no body to model.

        Raises:
            ForbiddenError: The principal does not hold ``ADMIN``.
            NotFoundError: No comment carries that identifier. Raised by the delegate, before its
                ownership check, so a missing comment and one the caller may not touch are not
                distinguishable by status code.

        Note:
            **Delegated rather than performed here.**
            :meth:`~app.services.comment_service.CommentService.delete` already permits an
            administrator to act on any comment - ``ensure_can_modify`` returns true for ``ADMIN``
            by construction - and it already carries the cascade-not-Python rule for the reply
            subtree, the locked read that makes the 404 correct, and the deletion audit line.
            Performing the delete here instead would restate the ownership predicate and the
            cascade rule a second time, and only one of the two copies would be the one updated
            when a relation is added.

            The delegate commits, and this method does not commit again on top of it.
        """
        self._require_admin(actor)

        await self._comment_service.delete(comment_id, actor=actor)

        # The delegate records the deletion with the comment's own identifiers, which it still holds
        # at that point; this line records that the deletion arrived through the administrative
        # surface, which is the fact the delegate cannot know.
        get_logger(__name__).info(
            "admin comment deleted",
            comment_id=str(comment_id),
            actor_id=str(actor.id),
        )

    # -----------------------------------------------------------------------------------
    # Categories - the whole lifecycle is delegated
    # -----------------------------------------------------------------------------------

    async def list_categories(
        self,
        *,
        actor: User,
        q: str | None = None,
        page: int,
        page_size: int,
    ) -> Page[CategoryPublic]:
        """Window the taxonomy for the administrative categories screen.

        Behind ``GET /api/v1/admin/categories``, the fourth administrative listing, which completes
        the administrative namespace: it now exposes listing, state mutation and deletion for users,
        posts, comments *and* categories, which is what the plan requires of the dashboard. The
        route adds a ``q`` filter the public collection deliberately withholds - searching a
        taxonomy is a management affordance rather than a reading one - and is otherwise the same
        windowed read, so a management grid and the reader-facing filter control cannot disagree
        about what a category looks like or how many posts are filed under it.

        Delegated to :meth:`~app.services.category_service.CategoryService.list_paginated` so an
        administrative table and the public filter control would agree on what a category looks
        like, down to the meaning of ``post_count``.

        Args:
            actor: The resolved principal. Must hold ``ADMIN``.
            q: Optional search text matched case-insensitively against both the name and the slug,
                so a term is findable by either spelling.
            page: The 1-based page requested.
            page_size: Rows per page.

        Returns:
            The one page envelope, carrying :class:`~app.schemas.category.CategoryPublic` items.

        Raises:
            ForbiddenError: The principal does not hold ``ADMIN``.
            ValueError: Propagated from ``build_page`` if ``page_size`` is not positive.

        Note:
            **No administrative projection of a category exists, and none is needed.** A category
            has no private member: there is no owner, no address, no credential and no moderation
            state to withhold, so the public model already carries everything this screen shows.
            Declaring an ``AdminCategory`` that duplicated it field for field would be a second
            contract to keep in step with the first for no gain, which is why
            ``app.schemas.admin`` re-exports the two category *inputs* and declares no category
            *output*.

            **``post_count`` counts published posts here too**, exactly as it does on the public
            control, because it is the same documented model. A moderator reading this table is
            reading the figure a reader would see - and a differently-meaning count under a name
            clients have already been told the meaning of would be a contract that disagrees with
            itself.
        """
        self._require_admin(actor)

        return await self._category_service.list_paginated(q=q, page=page, page_size=page_size)

    async def create_category(self, payload: CategoryCreate, *, actor: User) -> CategoryPublic:
        """Create a category, letting the delegate derive its slug.

        Behind ``POST /api/v1/admin/categories``. Categories are administrative reference data:
        there is no self-service path to creating one, which is why this is the only entry point.

        Args:
            payload: The validated body - a name, and optionally a description. It accepts neither
                an identifier nor a slug, and rejects a request carrying either with a 422, because
                both are the server's to generate.
            actor: The resolved principal. Must hold ``ADMIN``.

        Returns:
            The persisted category as :class:`~app.schemas.category.CategoryPublic`, with its
            server-generated ``id``, its derived ``slug``, its creation instant and a
            ``post_count`` of zero - the same model the public taxonomy endpoints return, which is
            what ``POST /api/v1/admin/categories`` declares as its response.

        Raises:
            ForbiddenError: The principal does not hold ``ADMIN``.
            ConflictError: The name, or the slug derived from it, is already taken. Raised by the
                delegate, which reports the ordinary collision from a pre-check and the concurrent
                one from the unique constraint as the same 409.

        Note:
            **No slug is derived here.** ``CategoryService.create`` normalises the name, performs
            the one indexed query that reveals which members of that slug family already exist, and
            applies the collision policy - a plain ascending integer suffix, so the outcome is
            deterministic and a re-run against the same data yields the same slug. Re-deriving a
            slug in this module would be a second URL policy, and a canonical address is precisely
            the thing that must have exactly one.

            **The projection is the delegate's too, and it has to be.** ``CategoryPublic`` carries
            ``post_count``, which is an aggregate rather than a member of the entity - not a stored
            column, not a default and not a hybrid property - so a mapped ``Category`` carries five
            of that model's six fields and validating one against it raises. Returning the row and
            letting the route's ``response_model`` convert it would therefore fail at serialisation
            time. ``CategoryService`` is the layer that knows the tally counts *published* posts
            only, so asking it to project keeps that meaning declared exactly once and keeps this
            surface reporting the same figure the home page's filter control shows.

            **The projection comes back from the create call itself; nothing is read back
            afterwards.** This method used to re-resolve the new category by slug in order to obtain
            the tally, which meant two more statements - an indexed lookup and, at the time, an
            aggregate over the whole taxonomy - issued *after* the delegate had already committed.
            The category existed at that point, so a transient failure on either of them answered
            with an error for a resource that had in fact been created. The delegate now builds the
            projection inside its own transaction, where the count for a brand-new category is a
            known zero rather than a question, and commits last.

            The delegate commits, so this method issues no commit of its own, and no statement of
            its own follows that commit.
        """
        self._require_admin(actor)

        category = await self._category_service.create(payload)

        get_logger(__name__).info(
            "admin category created",
            category_id=str(category.id),
            slug=log_safe_text(category.slug),
            actor_id=str(actor.id),
        )
        return category

    async def update_category(
        self,
        category_id: uuid.UUID,
        payload: CategoryUpdate,
        *,
        actor: User,
    ) -> CategoryPublic:
        """Rename a category or edit its description, leaving its slug alone.

        Behind ``PATCH /api/v1/admin/categories/{category_id}``. A genuine partial update: only the
        members the caller actually sent are applied, and an empty body is a successful no-op.

        Args:
            category_id: The category's server-generated identifier, from the URL path.
            payload: The validated body. ``name`` and ``description`` are both optional; an explicit
                null description is honoured as an instruction to clear it.
            actor: The resolved principal. Must hold ``ADMIN``.

        Returns:
            The updated category as :class:`~app.schemas.category.CategoryPublic`, its ``slug``
            unchanged and its ``post_count`` the current published tally - the model
            ``PATCH /api/v1/admin/categories/{category_id}`` declares as its response.

        Raises:
            ForbiddenError: The principal does not hold ``ADMIN``.
            NotFoundError: No category carries that identifier. Raised by the delegate.
            ConflictError: The new name is already held by a different category. Raised by the
                delegate.

        Note:
            **A rename deliberately does not change the slug, and nothing here "helpfully" adds
            that.** The slug is the canonical URL a reader has bookmarked, a sitemap has published
            and a search engine has indexed; re-deriving it on rename would break every one of those
            in exchange for a tidier address. ``CategoryService.update`` is where that decision
            lives, and re-deriving here would both contradict it and put a second URL policy in the
            codebase.

            **The projection is the delegate's, for the reason recorded on**
            :meth:`create_category`: ``post_count`` is an aggregate the entity does not carry, so a
            mapped row cannot validate against the response model. It arrives with the update's
            return value rather than from a readback - this method used to re-resolve the row by
            slug afterwards, which was sound in that a rename cannot move a slug, but it put an
            indexed lookup and a taxonomy-wide aggregate after a commit that had already made the
            change durable. The delegate now reads its own tally with one targeted count inside the
            transaction it commits.

            The delegate commits when there is something to write, and writes and commits nothing
            when the patch is empty - in which case its single count is the only statement. Either
            way this method does not commit on top of it, and issues nothing after it.
        """
        self._require_admin(actor)

        category = await self._category_service.update(category_id, payload)

        get_logger(__name__).info(
            "admin category updated",
            category_id=str(category.id),
            slug=log_safe_text(category.slug),
            actor_id=str(actor.id),
            changed=sorted(payload.model_dump(exclude_unset=True)),
        )
        return category

    async def delete_category(self, category_id: uuid.UUID, *, actor: User) -> None:
        """Delete a category, subject to the delegate's in-use guard.

        Behind ``DELETE /api/v1/admin/categories/{category_id}``, which answers ``204`` with no body
        - hence the ``None`` return.

        Args:
            category_id: The category's server-generated identifier, from the URL path.
            actor: The resolved principal. Must hold ``ADMIN``.

        Returns:
            ``None``. There is no body to model.

        Raises:
            ForbiddenError: The principal does not hold ``ADMIN``.
            NotFoundError: No category carries that identifier. Raised by the delegate, and resolved
                before the in-use question, because "does not exist" and "may not be deleted yet"
                are different answers.
            ConflictError: At least one post is still filed under the category. Raised by the
                delegate's in-use guard; the remedy is to re-file or remove those posts first.

        Note:
            **The in-use guard is not re-implemented and is never bypassed.** It exists because
            ``post_categories.category_id`` carries ``ON DELETE CASCADE``: without the guard, the
            delete would succeed and would silently take every filing with it, so a post would lose
            a category with nothing failing and nobody told. ``CategoryService.delete`` takes the
            row's lock, asks the in-use question under it, and deletes only if the answer was no -
            which is what closes the window in which a concurrent filing could slip between the
            check and the delete. Calling ``CategoryRepository.is_in_use`` from here instead would
            reproduce the check without the lock, which is a guard in appearance only.

            **One transaction, committed here**, as on the other two administrative category
            operations. There is no projection to read on a ``204``, so the delegate could have
            committed safely - but the boundary is kept in the same place on all three so that
            "who commits an administrative operation" has one answer rather than three.
        """
        self._require_admin(actor)

        await self._category_service.delete(category_id, commit=False)
        await self.session.commit()

        get_logger(__name__).info(
            "admin category deleted",
            category_id=str(category_id),
            actor_id=str(actor.id),
        )
