"""The like half of R4: three routes, one response shape, and no de-duplication anywhere.

This module owns the like operations of requirement **R4** - "Each blog page should support
comments, likes, and social sharing" - and it is the only place in the backend that decides what
liking a post means::

    PUT    /api/v1/posts/{id}/like   -> LikeSummary
    DELETE /api/v1/posts/{id}/like   -> LikeSummary
    GET    /api/v1/posts/{id}/likes  -> LikeSummary

The two writes require a bearer token, because granting a like is an act attributed to an account.
The read requires none - a like count is public information - so its route resolves the principal
through ``get_current_user_optional`` in ``app.core.dependencies`` and hands this layer ``None``
for an anonymous visitor. One shape serves both audiences, so a client never has to distinguish
"no session" from "has not liked".

Idempotency belongs to the key, and nothing here de-duplicates
-------------------------------------------------------------
``post_likes`` is keyed on ``(post_id, user_id)``: the pair *is* the primary key and there is no
surrogate identifier beside it, so a second identical like is not a second row. Measured rather
than assumed - two identical conflict-ignoring inserts against PostgreSQL 18.4 left the row count
at **one** - which is why :meth:`LikeService.like` issues one write and asks nothing first.

**That is the single most important fact about this module, and its consequence is a prohibition.**
There is no ``if already_liked`` branch below, no call to
:meth:`~app.repositories.like_repository.LikeRepository.exists_for` before a like, no
``IntegrityError`` handler and no retry loop, and none may be added. The apparent omission *is* the
design, for three separate reasons:

* A pre-flight read followed by an insert is two statements with a window between them, so two
  concurrent requests can both find nothing and both proceed. The composite key closes that
  window; a Python check re-opens it while looking like it closes it.
* A second copy of a rule the database already enforces exactly is the copy that drifts, and the
  rule has to hold for every writer - this service, a migration, a statement typed into ``psql``.
  Only the key holds for all three.
* Both mutations are therefore safely retryable. A client resending after a timeout, a proxy
  duplicating a request, a reader double-clicking: each settles on the same row and the same
  summary as the first attempt, and none of them can inflate a count.

Every method answers with the settled summary
--------------------------------------------
:class:`~app.schemas.like.LikeSummary` is the return type of all three methods, not just the read.
``frontend/src/components/blog/like-button.tsx`` applies a like optimistically - it fills the icon
and increments its own tally before the response arrives - and reconciling that guess needs the
authoritative pair of values. Returning them *from the mutation* is one round trip where a write
followed by a read would be two, so the number the reader is left looking at is the one the
database holds rather than the client's arithmetic. Returning ``None`` from :meth:`LikeService.like`
or :meth:`LikeService.unlike` would break that contract, which is why unliking answers with a body
rather than ``204 No Content``.

Both values come from one statement.
:meth:`~app.repositories.like_repository.LikeRepository.count_and_state` answers the count and the
caller's own state in a single round trip, and :meth:`LikeService._summary` is the only place in
this module that calls it - so every one of the three methods pays the same single read and none of
them can drift into a count plus a separate probe. That matters because
``GET /api/v1/posts/{id}/likes`` is the hottest read on the post page.

Visibility is delegated, never re-derived
----------------------------------------
A post the caller may not see can be neither liked nor counted: a like control on an invisible
draft has to be invisible too. The rule itself - published, or the viewer wrote it, or the viewer
is an administrator - lives in :func:`app.services.post_service.can_view_post` and is *called* from
here rather than restated. That is deliberate, and the branch this replaces shows why: it wrote
``HTTPException(status_code=404, detail="Item not found")`` three separate times, at ``app.py:L31``,
``app.py:L40`` and ``app.py:L49``, so one policy decision existed in three places and could be
changed in one of them.

The dependency edge is strictly one-way. This module imports ``post_service``; ``post_service``
imports nothing from ``app.services`` and must never import this module. Reversing or completing
that edge would be an import cycle at start-up, not a stylistic matter.

Being *entitled* to see the post is not enough on its own, because entitlement can lapse while the
request is still running. The post is therefore read under ``SELECT ... FOR SHARE``, so the decision
holds until the transaction ends rather than only until the next statement takes a fresh
``READ COMMITTED`` snapshot. That shared lock conflicts with the ``FOR UPDATE`` every post
transition and delete takes first, so an unpublish, an archive or a delete cannot slip between the
gate and the ``post_likes`` write or aggregate it authorises - and it stays compatible with other
shared holders, so two readers liking the same popular post still never wait for each other.
:meth:`~app.repositories.post_repository.PostRepository.get_for_share` documents the lock and the
global ``posts`` -> ``comments`` -> ``post_likes`` order it belongs to; this module needs only its
first step, because a like addresses no comment.

Absence and inaccessibility are reported identically
---------------------------------------------------
Every method resolves **not-found before forbidden**, and a post the caller may not see raises
:class:`~app.core.exceptions.NotFoundError` rather than
:class:`~app.core.exceptions.ForbiddenError`. The two cases are deliberately indistinguishable: a
403 would confirm that the identifier names a real post, which is precisely the fact an unpublished
draft is entitled to keep, and it would let anyone map the drafts on the site by reading status
codes. ``post_service.get_by_slug`` answers the same way for the same reason, so the two surfaces
agree on both the status and the detail string.

The transaction boundary
-----------------------
``app.repositories`` flushes and never commits, and ``get_db`` commits nothing on the way out, so
the boundary belongs to this layer. It is drawn once and simply: :meth:`LikeService.like` and
:meth:`LikeService.unlike` commit exactly once, on success, after their write; and
:meth:`LikeService.get_summary` commits nothing, because it is a read.

That boundary is also what bounds the shared lock the gate takes. The commit releases it, and it is
deliberately the *last* database action of each write - the gate, the write and the count the caller
is told about are all inside it, so either the whole decision holds or none of it does.

Nothing here *opens* a transaction either. The injected session already has one, and starting
another explicitly would fight the outer transaction ``backend/tests/conftest.py`` wraps every test
in and rolls back afterwards. Nothing here rolls one back either: ``get_db`` already does that
before returning the connection to the pool whenever an exception leaves the request, so an
exception raised below leaves no partial like behind.

What this module does not do
---------------------------
It settles business rules, and that is all.

* **No SQL.** Every statement belongs to ``app.repositories.like_repository`` - in particular the
  ``INSERT ... ON CONFLICT DO NOTHING``, which is why ``sqlalchemy.dialects.postgresql.insert``
  does not appear below. Nor does ``select``, ``func``, ``delete`` or any other statement
  constructor.
* **No HTTP.** The web framework is not imported at all: no application object, no router, no
  request type, no framework exception class, no response class and no status-code literal. A
  failure is a typed domain exception, which is what lets these rules be unit-tested with no
  client, no request and no running server.
* **No session construction.** The session is injected. ``app.db.session`` is not imported, so
  this service cannot open a connection of its own and a multi-step use case stays one
  transaction.
* **No hand-built response.** The three methods return :class:`~app.schemas.like.LikeSummary`
  itself, and the router serialises it. The retired surface wrapped its mutations in a
  ``{"message": ..., "data": ...}`` envelope at ``app.py:L18`` and ``app.py:L39`` while its reads
  returned bare payloads, so a client could not tell from the route which shape it would get. That
  inconsistency is deleted rather than relocated.
* **No request model, and no schema declared here.** There is nothing a client could put in a body
  that would change the outcome - the post arrives in the path and the principal from the
  dependency - so ``app.schemas.like`` declares only the response shape and this module declares
  no Pydantic model of its own.
* **No sanitisation, and no sanitiser imported.** A like carries no user-authored text. ``bleach``
  belongs to the two write paths that accept authored markup, ``post_service`` and
  ``comment_service``, and importing it here would suggest this module has content to clean.
* **No configuration.** Nothing below reads the process environment, a dotenv file or the typed
  settings object.
* **No cleanup on deletion.** Both foreign keys are ``ON DELETE CASCADE``, so deleting a post
  removes its likes and deleting an account removes every like it granted, in the statement
  PostgreSQL itself issues. There is no like-deletion code in this module beyond
  :meth:`LikeService.unlike`'s single narrowed withdrawal, and there must never be one.
* **No view-count or notification side effect.** Liking a post advances no counter on ``posts`` and
  notifies nobody; neither is in scope, and both would turn the smallest write in the service into
  a multi-statement transaction.
"""

from __future__ import annotations

import uuid
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError
from app.core.logging import get_logger
from app.models import Post, User
from app.repositories import LikeRepository, PostRepository
from app.schemas.like import LikeSummary
from app.services.post_service import can_view_post

__all__ = ["LikeService"]


# ---------------------------------------------------------------------------------------
# The one message this module can report
#
# A named constant rather than three literals, because the string is part of the error contract
# and the whole point of resolving not-found before forbidden is that a missing post and an
# invisible one are indistinguishable. Three copies of a literal is how two of them stop matching.
#
# The wording is deliberately identical to `post_service`'s, so `GET /api/v1/posts/{slug}` and
# `GET /api/v1/posts/{id}/likes` describe the same absent post the same way. It names no
# identifier, quotes nothing internal and discloses nothing about a draft, which is what makes it
# safe to render verbatim to an unauthenticated caller.
# ---------------------------------------------------------------------------------------

_POST_NOT_FOUND: Final[str] = "Post not found"


class LikeService:
    """Every business rule a like needs, which is fewer than any other service in this package.

    Constructed per request from the session ``app.core.dependencies.get_db`` yields, and in the
    suite from the transactional fixture::

        service = LikeService(session)

        summary = await service.like(post.id, user=principal)  # liked_by_caller is True
        summary = await service.unlike(post.id, user=principal)  # liked_by_caller is False
        summary = await service.get_summary(post.id, viewer=None)  # public, caller-aware

    The parameter names carry the distinction the rest of the package uses. A read takes a
    ``viewer``, which may be ``None``, because what a caller may *see* depends on who they are and
    an anonymous reader is a legitimate audience. The two writes take a ``user``, which is never
    optional, because an anonymous caller cannot reach them at all - the router's dependency has
    already answered ``401`` by then, and this layer answers the question that dependency cannot,
    which is whether the post being liked is one this principal may see.

    What is *not* on this class is as deliberate as what is. There is no ``is_liked_by`` predicate,
    because :attr:`~app.schemas.like.LikeSummary.liked_by_caller` already carries that answer and a
    second entry point would be a second round trip; no ``list_likers``, because publishing which
    accounts liked a post would disclose one reader's activity to another and no route asks for it;
    and no bulk ``summaries_for(post_ids)``, because the feed's post summary exposes no like count,
    so a batched form would only invite a feed that fans out per card.

    Instances are cheap, hold no cached state and are exactly as concurrency-safe as the
    ``AsyncSession`` they wrap - which is to say they must not be shared between concurrent tasks,
    because an ``AsyncSession`` is one unit of work over one connection.
    """

    __slots__ = ("_likes", "_posts", "_session")

    def __init__(self, session: AsyncSession) -> None:
        """Bind the service to one request's session and its two repositories.

        Args:
            session: The live session ``get_db`` yielded. It is **injected, never created** here:
                this module does not import ``app.db.session``, so a service cannot open a
                connection of its own, and both repositories below share the one session so a
                like and the read that settles it stay a single unit of work.

        Note:
            Two repositories, and each is needed for a distinct reason. ``LikeRepository`` owns the
            ``post_likes`` relation and every statement over it. ``PostRepository`` resolves the
            path's identifier to the row whose ``status`` and ``author_id``
            :func:`~app.services.post_service.can_view_post` reads - a lookup belongs to a
            repository, so this module does not call ``post_service`` to perform one and imports
            only its predicate.
        """
        self._session = session
        self._likes = LikeRepository(session)
        self._posts = PostRepository(session)

    # -----------------------------------------------------------------------------------
    # Private helpers
    #
    # Both exist so that a rule is applied in one place rather than three. Every public method
    # below opens with the first and closes with the second, and neither is re-implemented inline.
    # -----------------------------------------------------------------------------------

    async def _load_visible_post(self, post_id: uuid.UUID, viewer: User | None) -> Post:
        """Resolve a post the caller is entitled to know exists, or report it as absent.

        The gate every public method opens with. It answers the only question this service needs
        to ask about a post - may this caller see it at all - answers it before any like statement
        is issued, so an invisible draft's like count is never read and never written, and holds the
        answer for the rest of the transaction by taking the row under ``SELECT ... FOR SHARE``.

        Args:
            post_id: The identifier from the URL path, already validated as a UUID by the route.
            viewer: The resolved principal, or ``None`` for an anonymous caller. Positional, and
                second, so the call reads in the same order as the predicate it delegates to:
                ``can_view_post(post, viewer)``. The two parameters have different types, so
                nothing can be transposed silently.

        Returns:
            The post, with its own columns loaded, no relationship requested and a shared lock held
            on its row until this transaction ends. The columns are sufficient:
            :func:`~app.services.post_service.can_view_post` reads ``status`` and ``author_id``,
            both mapped, and never ``post.author`` - touching an unloaded relationship under an
            ``AsyncSession`` raises ``MissingGreenlet``. Callers currently discard the entity and
            use only the fact that it resolved, but it is returned rather than swallowed so this
            stays a loader a future caller can read a column from instead of a guard that would
            have to be paired with a second fetch.

        Raises:
            NotFoundError: No post carries that identifier, **or** the post is not published and
                the caller is neither its author nor an administrator.

        Note:
            Those two cases raise the same error with the same detail, and that identity is the
            whole point. Answering :class:`~app.core.exceptions.ForbiddenError` for the second
            would confirm that the identifier names a real post - exactly the fact an unpublished
            draft is entitled to keep - and would let an unauthorised caller enumerate posts by
            reading status codes. Not-found is therefore resolved *before* authority is considered,
            and inaccessibility is then reported as absence.

            The rule itself is not restated here. It lives once, in
            :func:`~app.services.post_service.can_view_post`, and is called; a rule repeated per
            call site drifts, which is what the three byte-identical 404 raises at ``app.py:L31``,
            ``app.py:L40`` and ``app.py:L49`` demonstrated.

            **The row is taken under a shared lock, and that is what makes this a gate rather than
            a guess.** An unlocked read would answer from its own ``READ COMMITTED`` snapshot, and
            every statement after it takes a new one - so the post could be unpublished, archived or
            deleted in the window between this decision and the ``post_likes`` write or aggregate it
            authorises. The three ways that ends are all wrong: a like persisted against a post the
            caller may no longer see, a count returned for a post that has just been withdrawn, and
            a foreign-key violation surfacing as a ``500`` when the post is gone outright.
            ``SELECT ... FOR SHARE`` closes all three, because it conflicts with the ``FOR UPDATE``
            every status transition and delete in ``app.services.post_service`` takes first: a
            concurrent transition now waits for this transaction to end, and a post already deleted
            and committed comes back absent rather than from a snapshot, so the ``404`` below is a
            fact.

            **Shared, not exclusive, and the distinction is the whole reason this is affordable.**
            Shared locks are compatible with each other, so two readers liking or counting the same
            popular post never wait for one another - only a genuine post mutation does. Nothing on
            ``posts`` is written by any other path either:
            ``app.repositories.post_repository`` deliberately exposes no view-count increment, so
            this lock contends with nothing but the transitions it is meant to exclude.

            **It is held to the transaction boundary, not merely for the statement.** Each caller's
            commit releases it - or the rollback ``get_db`` performs if one raises - which is why
            every public method below reads its summary *before* committing: the gate, the write and
            the figure reported are then one atomic decision.

            The lock is over ``posts`` and it is taken **first**, which is the global order this
            codebase follows: ``posts`` -> ``comments`` -> ``post_likes``, never the reverse.
            :meth:`~app.repositories.post_repository.PostRepository.get_for_share` documents it in
            full. This module only ever needs the first step, because a like addresses no comment.
        """
        post = await self._posts.get_for_share(post_id)
        if post is None:
            raise NotFoundError(_POST_NOT_FOUND)
        # Reported as absence, not as a refusal - see the note above. `can_view_post` is imported
        # rather than reproduced, and this is the only place in this module that consults it.
        if not can_view_post(post, viewer):
            raise NotFoundError(_POST_NOT_FOUND)
        return post

    async def _summary(self, post_id: uuid.UUID, *, user_id: uuid.UUID | None) -> LikeSummary:
        """Assemble the response every public method answers with, in one round trip.

        The single construction site for :class:`~app.schemas.like.LikeSummary` in this module.
        Concentrating it here is what guarantees the three routes return the same shape built the
        same way, and what keeps
        :meth:`~app.repositories.like_repository.LikeRepository.count_and_state` as the one read
        behind all of them.

        Args:
            post_id: The post being summarised. Echoed into the response so the payload is
                self-describing - a client keying a cache by post reads the identifier out of the
                body rather than tracking which request produced it.
            user_id: The calling account, or ``None`` for an anonymous caller. Keyword-only, and
                deliberately **without a default** even though the repository method it forwards
                to supplies one: a call site that forgot the caller would otherwise report
                ``liked_by_caller=False`` to someone who has in fact liked the post, which is a
                wrong answer that looks like a valid one. Requiring the argument turns that
                mistake into a type error.

        Returns:
            The count of distinct accounts that have liked the post, and whether ``user_id`` is
            among them. ``liked_by_caller`` is ``False`` for an anonymous caller - never ``None``
            and never absent - because the count is public and a reader with no session still
            receives a complete summary.

        Note:
            One statement, not two. ``count_and_state`` emits ``count(*)`` beside
            ``coalesce(bool_or(user_id = :caller), false)`` over the same rows, so the two values
            cannot disagree with each other the way a separate count and a separate
            :meth:`~app.repositories.like_repository.LikeRepository.exists_for` probe could, and
            the hottest read on the post page costs one round trip. Calling those two methods
            instead would be a measurable regression, which is why neither appears in this module.

            The model is constructed with explicit keywords rather than validated from the
            repository's return value. ``LikeSummary`` enables ``from_attributes``, but nothing can
            rename a tuple: ``model_validate((0, False))`` raises, because a two-element tuple has
            neither the names nor the arity the model requires. Naming the fields here is the
            supported form and the one the schema documents.
        """
        like_count, liked_by_caller = await self._likes.count_and_state(post_id, user_id=user_id)
        return LikeSummary(
            post_id=post_id,
            like_count=like_count,
            liked_by_caller=liked_by_caller,
        )

    # -----------------------------------------------------------------------------------
    # Writes
    #
    # Both are idempotent, and neither checks first. The composite primary key on
    # `(post_id, user_id)` is what makes them so, which is why each is a single write statement
    # after a visibility gate.
    #
    # Both follow the same four steps, in this order: gate the post, write, read the summary the
    # response carries, commit. The commit is last on purpose - the gate's shared lock, the write
    # and the figure the caller is told about are then one atomic decision, and no failure can
    # arrive after the row is durable. Each method's own Note records what reading after the commit
    # cost.
    #
    # The gate is what makes the write conditional on a fact rather than on a stale snapshot: it
    # holds `FOR SHARE` on the post until this transaction ends, so a concurrent unpublish, archive
    # or delete either waits for the like or was already committed before the gate ran, in which
    # case the gate reports the post absent.
    # -----------------------------------------------------------------------------------

    async def like(self, post_id: uuid.UUID, *, user: User) -> LikeSummary:
        """Record that an account likes a post, and answer with the settled summary.

        Serves ``PUT /api/v1/posts/{id}/like``. Idempotent by construction rather than by
        checking: liking a post the account has already liked succeeds, writes nothing new and
        leaves the count exactly where it was.

        Args:
            post_id: The post being liked, from the URL path.
            user: The resolved principal. Never optional - an anonymous caller is stopped by the
                route's dependency with ``401`` long before this method is entered - and the sole
                source of the account identity written, which is why no request body exists for a
                client to name an account in.

        Returns:
            The post's like count and ``liked_by_caller=True``, read inside the same transaction as
            the write and therefore consistent with it. Answering with the summary rather than an
            acknowledgement is what lets the client settle its optimistic update in one round trip.

        Raises:
            NotFoundError: No post carries that identifier, or it is an unpublished post this
                principal may not see. A like control on an invisible draft has to be invisible
                too, and the two cases are reported identically -
                :meth:`_load_visible_post` explains why.

        Note:
            **Nothing is checked before the insert, and nothing may be.** There is no
            :meth:`~app.repositories.like_repository.LikeRepository.exists_for` call above, no
            ``if`` on the returned boolean that raises, and no ``IntegrityError`` handler. The
            repository issues one ``INSERT ... ON CONFLICT DO NOTHING``, so a repeat is absorbed by
            the primary key rather than recovered from; a pre-flight read would add a race the key
            has already eliminated, because a read followed by an insert is two statements with a
            window between them and two concurrent requests can both find nothing.

            A repeat is consequently **not** a
            :class:`~app.core.exceptions.ConflictError`. The end state the client asked for is the
            end state it gets, so the request is safe to retry after a timeout, safe to duplicate
            through a proxy, and safe to double-click.

            **The gate's lock is not a de-duplication check and does not become one.** It settles a
            different question - whether this post is still one the caller may act on - and the two
            must not be conflated: the composite primary key remains the only thing that decides
            whether this statement creates a row. Because the lock is *shared*, two accounts liking
            the same post still proceed together; it excludes the post's own transitions and nothing
            else. What it does add is that the foreign key can no longer fail: a post being deleted
            concurrently is either blocked behind this transaction or was already committed before
            the gate ran, in which case the gate answered ``404`` and no insert was attempted. That
            is why there is still no ``IntegrityError`` handler here.

            The boolean the repository returns is recorded rather than acted upon. It is the only
            place the information exists - after the statement the two outcomes are
            indistinguishable in the data - and it is genuinely useful in a log, where it separates
            a new like from a resend without a second query. It decides nothing here.

            **The summary is read before the commit, and the commit is the last database action.**
            The write, the read that describes it and the transaction boundary are therefore one
            atomic decision: either the like and the count the caller is told about both hold, or
            neither does. Reading afterwards - which is what this method used to do - meant a
            transient failure on the count returned an error for a like that had already been made
            durable, with no transaction left to undo it and a client left holding an optimistic
            state the server had in fact accepted. The read sees this transaction's own uncommitted
            row, so the figure reported is the figure the commit makes durable.

            ``debug`` rather than ``info``, unlike the post lifecycle's transitions: a like is a
            high-frequency, low-consequence event, and one record per reader interaction at
            ``info`` would bury the lines an operator actually reads. Logging still follows the
            commit, so a transaction that failed on the way out is never reported as a durable
            like, and the logger is fetched inside the method because one created at import time
            can capture *structlog*'s unconfigured defaults and keep them.
        """
        await self._load_visible_post(post_id, user)

        # One statement, no pre-check. The key decides whether this creates a row; `created` says
        # which happened, and is reported rather than branched on.
        created = await self._likes.like(post_id=post_id, user_id=user.id)

        # The response is read and materialised BEFORE the commit, so the commit is the last
        # database action this request takes. Reading afterwards was the defect: a transient failure
        # on the count would have returned an error for a like that was already durable, leaving the
        # client's optimistic state and the database's disagreeing with nothing left to roll back.
        # The read sees this transaction's own uncommitted insert, so the count it reports is the
        # count the commit makes durable a moment later.
        summary = await self._summary(post_id, user_id=user.id)
        await self._session.commit()

        get_logger(__name__).debug(
            "post liked",
            post_id=str(post_id),
            user_id=str(user.id),
            created=created,
            like_count=summary.like_count,
        )
        return summary

    async def unlike(self, post_id: uuid.UUID, *, user: User) -> LikeSummary:
        """Withdraw an account's like of a post, treating a missing like as a no-op.

        Serves ``DELETE /api/v1/posts/{id}/like``. The mirror of :meth:`like`, and idempotent in
        the same way: withdrawing a like that was never granted removes nothing, raises nothing and
        answers with the same summary a successful withdrawal would.

        Args:
            post_id: The post whose like is being withdrawn, from the URL path.
            user: The resolved principal, withdrawing its own like. An account cannot withdraw
                another's: the identity written into the predicate is this principal's and there is
                no parameter through which a different one could be named, so ownership is
                structural here rather than a rule to enforce.

        Returns:
            The post's like count and ``liked_by_caller=False``, read inside the same transaction as
            the removal and therefore consistent with it.

        Raises:
            NotFoundError: No post carries that identifier, or it is an unpublished post this
                principal may not see.

        Note:
            **A like that was never granted is not an error**, and that is a decision rather than
            an oversight. Two reasons, and the first is a confidentiality property: raising when
            there was nothing to remove would let a caller learn, from a status code, whether an
            account had liked a post - probing a fact the API deliberately never publishes, since
            ``liked_by_caller`` answers only for the caller themselves. The second is practical: a
            client that applied an unlike optimistically would have to distinguish "your guess was
            already true" from a genuine failure in order to decide whether to roll its own state
            back, and it has no use for that distinction. Returning the settled summary makes the
            end state unambiguous either way.

            The boolean is therefore recorded and not acted upon, exactly as in :meth:`like`, and
            at ``debug`` for the same reason.

            Only this one like is removed. The statement behind it names both key columns, so at
            most one row can match; nothing in this module deletes likes in bulk, because deleting
            a post or an account already removes them through ``ON DELETE CASCADE`` and a Python
            copy of a cascade is the copy that drifts.
        """
        await self._load_visible_post(post_id, user)

        removed = await self._likes.unlike(post_id=post_id, user_id=user.id)

        # Materialised before the commit, exactly as in `like` and for the same reason: the commit
        # is the last database action, so no failure can arrive after the removal is durable.
        summary = await self._summary(post_id, user_id=user.id)
        await self._session.commit()

        get_logger(__name__).debug(
            "post unliked",
            post_id=str(post_id),
            user_id=str(user.id),
            removed=removed,
            like_count=summary.like_count,
        )
        return summary

    # -----------------------------------------------------------------------------------
    # Read
    # -----------------------------------------------------------------------------------

    async def get_summary(self, post_id: uuid.UUID, *, viewer: User | None) -> LikeSummary:
        """Report how many accounts have liked a post, and whether the caller is one of them.

        Serves ``GET /api/v1/posts/{id}/likes``, the public read behind the post page's like
        control. Requires no credential, because a like count is public information, and is still
        caller-aware: an authenticated reader learns the fill state of their own icon from the same
        payload an anonymous one receives.

        Args:
            post_id: The post being asked about, from the URL path.
            viewer: The resolved principal, or ``None`` for an anonymous caller. The route supplies
                it through the optional-user dependency rather than the mandatory one, which is
                what keeps this read reachable without a bearer token.

        Returns:
            The like count, and ``liked_by_caller`` - ``True`` when this viewer has liked the post,
            ``False`` when they have not and ``False`` for an anonymous caller. ``0`` and ``False``
            for a post nobody has liked, which is the ordinary state of a newly published post
            rather than a special case.

        Raises:
            NotFoundError: No post carries that identifier, or it is an unpublished post this
                viewer may not see. An anonymous caller can see no draft at all, so a draft's like
                count is unreachable without a session - the count is public only for a post that
                is itself public.

        Note:
            No commit. This is a read, and the transaction it participates in is ended by
            ``get_db`` when the request finishes - which is also what releases the shared lock the
            gate took.

            **The gate and the aggregate are one consistent answer, not two independent ones.**
            Holding that lock across both statements is what makes the count reported here a count
            of a post the caller was still entitled to see when the figure was read. Without it the
            two statements would sit in different ``READ COMMITTED`` snapshots, and a post
            unpublished, archived or deleted in between would be reported on anyway - a tally
            published for an article the caller may no longer read. The lock is shared, so this read
            still never waits for another reader; it waits only for a transition that would have
            invalidated its answer.

            ``None`` is passed through as ``None``. No placeholder identifier is synthesised for an
            anonymous caller, and none could safely be: the repository skips the caller-state
            aggregate entirely in that case rather than comparing a column to a bound ``NULL``,
            because a comparison against SQL ``NULL`` is neither true nor false. A fabricated UUID
            would make the aggregate answer a question nobody asked, and would collide with a real
            account the day one happened to match.
        """
        # The visibility gate takes the optional viewer directly, so a draft is invisible to an
        # anonymous caller by the same predicate that makes it visible to its author.
        await self._load_visible_post(post_id, viewer)
        return await self._summary(post_id, user_id=viewer.id if viewer is not None else None)
