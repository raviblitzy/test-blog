"""Public author profiles: who an author is, and only the posts they have actually published.

This module owns requirement **R5** in full - "Include user profiles showing published
articles" - and it is the only place in the backend that answers the profile surface::

    GET   /api/v1/users/{username}        -> UserPublic
    GET   /api/v1/users/{username}/posts  -> Page[PostSummary]
    PATCH /api/v1/users/me                -> UserMe

The first two are anonymous. They are linked from every byline in the product, they carry the
canonical ``/u/{username}`` URL a sitemap entry points at, and they are crawled. The third is
the self-service write that maintains what those two publish.

The published-only filter is a constant, not a predicate
-------------------------------------------------------
:data:`PUBLIC_PROFILE_STATUSES` names :attr:`~app.models.post.PostStatus.PUBLISHED` and
nothing else, and it **admits no override**. There is no viewer parameter on
:meth:`ProfileService.list_published_posts`, no ``statuses`` argument, no ``include_drafts``
flag and no role inspection anywhere in this module, so no caller - an anonymous reader, the
author themselves, or an administrator - can widen the set a profile URL returns. The absence
of a viewer is deliberate rather than forgotten, and it is the strictest available reading of
"hard-filtered": a draft must never reach a public profile, and a predicate is a place a
mistake can hide whereas a constant is not. Draft confidentiality is a blocking acceptance
criterion for this change, not a default that a future caller may reasonably relax.

This is the one respect in which this module differs from its siblings. ``comment_service``
and ``like_service`` consult ``post_service`` because they must sometimes *widen* visibility -
an author may comment on their own unpublished draft. This module never widens anything, so it
imports no sibling service at all and calls no visibility predicate. If a private,
author-facing listing that includes drafts is ever needed, it belongs to
``post_service.list_feed`` with an ``author_id`` argument and an authenticated principal, and
it must not be added here.

One resolver, so the two read endpoints cannot disagree
-----------------------------------------------------
Both reads resolve the author through :meth:`ProfileService._require_visible_author`, which
reports an unknown handle and a deactivated account identically, as
:class:`~app.core.exceptions.NotFoundError`. Two consequences are contractual:

* A deactivated account has no public profile. Its identity page stops resolving rather than
  rendering a hollow shell, and its post listing stops resolving with it - the alternative,
  where ``/u/ada`` answers 404 while ``/u/ada/posts`` answers 200 with rows, is the kind of
  inconsistency that only appears once the two predicates have drifted apart. There is one
  predicate, in one method, so they cannot.
* The listing resolves the author **before** it queries a single post, so an unknown or
  deactivated handle costs one indexed ``citext`` probe and issues no post statement at all.

Identity is resolved by the database, never folded in Python
-----------------------------------------------------------
``users.username`` is ``CITEXT UNIQUE``, so ``GET /api/v1/users/Alice`` and
``GET /api/v1/users/alice`` resolve to one account through one index probe. Nothing here
lower-cases, casefolds or normalises the handle: an application-side fold would have to be
applied identically on every lookup and every write path, and the first path that forgot would
admit the duplicate the unique index forbids.

What this module does not do
---------------------------
It settles business rules and nothing else. There is no statement, no session construction, no
HTTP artefact and no configuration read anywhere below.

* **No SQL.** Every query belongs to ``app.repositories``, and the profile listing reuses the
  one composed statement in ``app.repositories.post_repository`` rather than assembling a
  second query of its own. That is what keeps the feed, this profile, the author workspace and
  every administrative table on identical access paths and identical window arithmetic.
* **No HTTP.** The web framework is not imported here at all - no application object, no
  router, no request type, no framework exception class, no response class and no status-code
  literal. A failure is a typed domain exception from ``app.core.exceptions``, which is what
  lets the rules below be unit-tested with no client, no request and no running server.
* **No hand-built response.** The reads return the mapped :class:`~app.models.user.User` and
  a :class:`~app.core.pagination.Page` of ``PostSummary``; the router applies the projection.
  Assembling a dict here would put the field list of a public projection in a second place,
  and ``UserPublic`` withholds ``password_hash``, ``email``, ``role`` and ``is_active``
  precisely because that list is enforced in exactly one.
* **No configuration.** Nothing here reads the process environment, a dotenv file or the typed
  settings object. Two reads and one three-column write need none of it.
* **No markup sanitisation, and no sanitiser imported.** ``display_name`` and ``bio`` are
  plain text rendered as text - never as markup - and ``avatar_url`` is proved to be an
  absolute ``http(s)`` URL by ``UserUpdate`` before it arrives, which is the control that keeps
  a profile field from becoming a script vector. The two write paths that *do* accept authored
  markup, ``post_service`` and ``comment_service``, own that allow-list between them; a third
  sanitisation policy in a third module would be a third thing to keep in step.

The transaction boundary
-----------------------
``app.repositories`` flushes and never commits, and ``get_db`` commits nothing on the way out,
so the boundary is this layer's to draw. It is drawn once: the two reads commit nothing, and
:meth:`ProfileService.update_self` commits exactly once, on success. Nothing here *opens* a
transaction either - the injected session already has one, and starting another explicitly
would fight the outer transaction the suite wraps every test in and rolls back afterwards - and
nothing here rolls one back, because ``get_db`` already does that before returning the
connection to the pool whenever an exception leaves the request.

What this replaces
-----------------
The branch this supersedes had no user, no author and no profile - its single entity was an
``Item`` with a client-supplied integer id, a name and a price. Four of its habits are absent
here by construction: the module-level list that was the whole datastore; the framework's
404-with-a-literal-detail raised inline three times over because there was nowhere else to put
it; the linear scan comparing ``item.id == item_id`` in three separate handlers; and the
two-key envelope its mutating routes wrapped results in, which made a write's response a
different shape from a read's. Here the identity predicate lives once, in
``UserRepository.get_by_username``; the 404 is one typed exception rendered by one registered
handler; and a collection is the one page envelope every list surface in the product returns.
"""

from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError
from app.core.pagination import Page, build_page
from app.models import PostStatus, User
from app.repositories import PostRepository, PostSort, UserRepository
from app.schemas import PostSummary, UserUpdate

__all__ = ["PUBLIC_PROFILE_STATUSES", "ProfileService"]


# ---------------------------------------------------------------------------------------
# The hard filter
#
# A named constant rather than an inline literal, so that a reviewer can see at a glance that
# exactly one lifecycle state reaches a public profile and that nothing in this module widens
# it. Immutable - a tuple, not a list - so it cannot be appended to at run time either.
# ---------------------------------------------------------------------------------------

PUBLIC_PROFILE_STATUSES: Final[tuple[PostStatus, ...]] = (PostStatus.PUBLISHED,)
"""The only lifecycle state a public profile may ever disclose.

Passed verbatim to ``PostRepository.list_posts`` on every profile listing. It is not a
default, not a fallback and not a starting point that some caller refines: this module exposes
no parameter through which the set could be replaced or extended, so ``DRAFT`` and
``ARCHIVED`` posts are unreachable through a profile URL for **every** caller, including the
author and an administrator.

That is stricter than the repository's own default, which is an argument precisely so that the
author workspace and the administrative table can ask for other states. Those surfaces belong
to ``post_service`` and ``admin_service``, each of which resolves a principal and checks
authority first. A profile URL resolves no principal at all, which is exactly why the set it
may return is fixed here rather than computed.
"""

_PROFILE_POST_SORT: Final[PostSort] = "recent"
"""Profile listings are ordered by recency, newest first.

``"relevance"`` is the other member of ``PostSort`` and it is meaningless here: relevance
ranks against a search term, and a profile listing has none - it takes no ``q``. Naming the
value as a constant states that the ordering is a property of the surface rather than
something a caller chooses, which is what keeps two profile pages from ordering differently.
"""

_PROFILE_NOT_FOUND_DETAIL: Final[str] = "No profile exists for that username."
"""The single message both read endpoints report when a profile does not resolve.

Deliberately identical for an unclaimed handle and for a deactivated account. The detail of an
:class:`~app.core.exceptions.AppError` is sent to the client verbatim, so distinguishing the
two would turn this endpoint into an oracle telling an anonymous caller which usernames exist
as suspended accounts. It names no identifier, no column and no internal state.
"""

# The three members of `UserUpdate`, named once. Every assignment in `update_self` is keyed on
# one of these and there is no generic attribute copy anywhere, so these three names are the
# complete, reviewable answer to "what can a self-service update reach?" - and `email`,
# `username`, `role`, `is_active` and `id` are not among them. `UserUpdate` declares no member
# for any of the five and forbids unknown members outright, so a body proposing one is already a
# 422 before this module runs; this list is the second, independent guard rather than the only
# one, and it is what stops a member added to the schema later from reaching a column untouched
# by review.
_FIELD_DISPLAY_NAME: Final[str] = "display_name"
_FIELD_BIO: Final[str] = "bio"
_FIELD_AVATAR_URL: Final[str] = "avatar_url"


class ProfileService:
    """The public profile surface: author identity, published posts, and self-service updates.

    Three operations, one session, one hard filter. Construct it per request with the injected
    session and call whichever method the route needs::

        service = ProfileService(db)
        author = await service.get_profile(username)  # a User, projected as UserPublic
        posts = await service.list_published_posts(username, page=1, page_size=20)

    Stateless beyond the session and the two repositories it binds to it. Nothing is cached
    between calls, so two calls in one request see the same transaction and no stale row.

    Attributes:
        _session: The request-scoped session, held for exactly one purpose - the single commit
            in :meth:`update_self`. It is never created here, never closed here, never
            replaced, and no statement is executed against it directly.
        _users: Owns every ``users`` statement this service needs, which is one indexed
            ``citext`` probe by username and the flush behind a profile update.
        _posts: Owns the profile listing. It is the *same* composed statement the home feed
            uses, reached with different arguments.
    """

    def __init__(self, session: AsyncSession) -> None:
        """Bind the service to one unit of work.

        Args:
            session: The request-scoped session, supplied by ``get_db`` in the API tier or by
                the transactional fixture in the suite. Injected rather than constructed: this
                module imports no session factory and no engine, which is what lets it be
                exercised inside a transaction the caller rolls back.
        """
        self._session = session
        self._users = UserRepository(session)
        self._posts = PostRepository(session)

    async def get_profile(self, username: str) -> User:
        """Resolve the public profile addressed by a username.

        Backs ``GET /api/v1/users/{username}`` and the client's ``/u/{username}`` route.

        Args:
            username: The handle as the URL supplied it, in whatever case. Not normalised
                here - ``users.username`` is ``CITEXT UNIQUE``, so the index resolves
                ``Alice`` and ``alice`` to the same single account.

        Returns:
            The mapped :class:`~app.models.user.User`. The route declares
            ``response_model=UserPublic`` and the projection is applied there, so this method
            returns the entity rather than a dict: ``UserPublic`` withholds ``password_hash``,
            ``email``, ``role`` and ``is_active``, and enforcing that field list in one place
            is what keeps a withheld column from being reintroduced by a second, hand-built
            payload here.

        Raises:
            NotFoundError: If the handle is unclaimed, or if the account it names is
                deactivated. The two are reported identically - see
                :data:`_PROFILE_NOT_FOUND_DETAIL` - and the same rule governs
                :meth:`list_published_posts`, so the two endpoints of one profile agree.
        """
        return await self._require_visible_author(username)

    async def list_published_posts(
        self,
        username: str,
        *,
        page: int,
        page_size: int,
    ) -> Page[PostSummary]:
        """List one author's published posts, newest first, windowed.

        Backs ``GET /api/v1/users/{username}/posts``.

        **This method takes no viewer and accepts no status argument.** Its signature is the
        contract: there is no parameter through which any caller could widen
        :data:`PUBLIC_PROFILE_STATUSES`, so a draft or an archived post cannot be surfaced by a
        profile URL even for the author or an administrator. See the module docstring for why
        that is a constant rather than a computed predicate.

        Args:
            username: The author's handle, resolved exactly as :meth:`get_profile` resolves it.
            page: The 1-based page requested. Already bounded to ``>= 1`` by ``PageParams`` in
                the API tier; echoed into the envelope verbatim and never clamped, so a caller
                can tell it has run off the end of the collection.
            page_size: Rows per page. Already bounded to ``1..100`` by ``PageParams``.

        Returns:
            A :class:`~app.core.pagination.Page` of ``PostSummary`` carrying ``items``,
            ``total``, ``page``, ``page_size`` and ``pages`` - the one envelope every
            collection in this API returns, so the client pages a profile with the same
            control it pages the home feed with. ``total`` counts every *published* post by
            this author, ignoring the window. A page beyond the last one is not an error: it
            returns an empty ``items`` list beside the real ``total`` and ``pages``.

        Raises:
            NotFoundError: If the handle is unclaimed or the account is deactivated. Raised
                before any post statement is issued, so an unknown author costs one index
                probe rather than a listing.
            ValueError: Propagated from ``build_page`` if ``page_size`` is not positive. That
                can only arrive from a defect in a caller: request-supplied values are bounded
                long before they reach here, and failing loudly beats reporting a ``pages``
                count that would be a fiction.
        """
        # Resolved FIRST, and not merely for tidiness: `list_posts` takes an author id, so an
        # unknown or deactivated handle has to become a 404 here rather than degenerating into
        # a successful, empty page that a client would render as "this author has written
        # nothing" for a profile that does not exist.
        author = await self._require_visible_author(username)

        # ONE call into the single composed statement that serves every listing surface in the
        # product. `statuses` is the module constant and nothing else; `q` and `category_slug`
        # are None because a profile neither searches nor filters by taxonomy. Window
        # arithmetic is `PageParams`' vocabulary translated into the statement's: `limit` is
        # the page size, and `offset` is how many rows precede this page.
        rows, total = await self._posts.list_posts(
            q=None,
            category_slug=None,
            author_id=author.id,
            statuses=PUBLIC_PROFILE_STATUSES,
            sort=_PROFILE_POST_SORT,
            limit=page_size,
            offset=(page - 1) * page_size,
        )

        # `author` and `categories` were eagerly loaded by the statement above, so this
        # projection issues no further query - a lazy load would raise MissingGreenlet under
        # the async session rather than quietly becoming an N+1.
        items = [PostSummary.model_validate(row) for row in rows]

        return build_page(items, total, page, page_size)

    async def update_self(self, user: User, payload: UserUpdate) -> User:
        """Apply a principal's own profile changes, and only the three that are theirs to make.

        Backs ``PATCH /api/v1/users/me``. A genuine partial update: an omitted member is left
        exactly as it was, which is what the retired whole-object ``PUT`` could not express -
        it overwrote the stored record with whatever arrived, so a client holding a stale copy
        silently reverted every field it had not refreshed.

        The update surface cannot reach authority or identity, and that is enforced twice.
        ``UserUpdate`` declares no member for ``email``, ``username``, ``role``, ``is_active``
        or ``id`` and forbids unknown members, so a body proposing one is rejected as a 422
        before this method is entered. Independently, the assignments below are keyed on three
        named fields with no generic attribute copy anywhere, so no member added to the schema
        in future is written to a column by accident. Role and activation are changed only by
        an administrator, through the namespace ``require_admin`` gates; a username is the
        account's canonical address, published in every profile link and sitemap entry, so it
        is not re-keyable at all.

        Args:
            user: The authenticated principal's own persistent row, resolved by
                ``get_current_user``. Ownership is therefore established by *which* row was
                injected rather than by a comparison here - there is no user id parameter to
                mismatch, so this endpoint has no path by which one account could edit
                another.
            payload: The submitted changes, already validated. ``null`` is honoured for
                ``bio`` and ``avatar_url`` - both columns are nullable and clearing them is a
                real instruction - and refused for ``display_name``, which is ``NOT NULL``.

        Returns:
            The same instance, with every column reloaded after the write so that
            ``updated_at`` is the value PostgreSQL stamped rather than the one the process last
            saw. The route declares ``response_model=UserMe``, which publishes ``email``,
            ``role`` and ``is_active`` and is returned only to the principal describing itself.

        Note:
            An empty body is a valid no-op, and it is answered as one: with nothing set there
            is nothing to write, so no ``UPDATE`` is emitted, no commit is issued and the row
            is returned unchanged. A settings form submitted without edits is a legitimate
            request, and rejecting it would turn harmless client behaviour into an error a
            person would have to interpret.

            No rollback appears here. ``get_db`` rolls the session back before returning its
            connection to the pool whenever an exception leaves the request, so a failure
            between the assignments and the commit leaves nothing persisted; duplicating that
            here would only risk swallowing the exception the error contract needs to see.
        """
        # The dump's KEYS are the instruction set: `exclude_unset` distinguishes "leave this
        # alone" (member absent) from "clear this" (member explicitly null), which no read of
        # the attributes alone can recover. The VALUES are taken from the model's attributes
        # instead, for two reasons - they keep their static types, and `avatar_url` dumps as a
        # Pydantic `Url` object rather than the `str` its Text column accepts.
        changes = payload.model_dump(exclude_unset=True)

        if not changes:
            return user

        if _FIELD_DISPLAY_NAME in changes:
            display_name = payload.display_name
            # `UserUpdate.reject_null_display_name` already answers an explicit null with a
            # 422, so this guard is defence in depth for a NOT NULL column: skipping beats
            # letting a null reach the column and surface as a 500 describing an integrity
            # violation several layers from the request member that caused it.
            if display_name is not None:
                user.display_name = display_name

        if _FIELD_BIO in changes:
            # Nullable column, nullable member: None means "remove the bio", and a cleared
            # form control arrives as None because the schema folds a blank string to it.
            user.bio = payload.bio

        if _FIELD_AVATAR_URL in changes:
            avatar_url = payload.avatar_url
            # The one cross-layer coercion this module owes its schema: `HttpUrl` validates to
            # a `Url` object, and `users.avatar_url` is `Text`. Storing the object would put a
            # non-string into a string column through the driver's adaptation rather than
            # through this contract.
            user.avatar_url = None if avatar_url is None else str(avatar_url)

        # Flush and refresh, then commit exactly once. The repository deliberately stops at the
        # flush so that the transaction boundary stays here, where the unit of work is known to
        # be complete.
        await self._users.save(user)
        await self._session.commit()

        return user

    async def _require_visible_author(self, username: str) -> User:
        """Resolve a publicly visible account by username, or raise.

        The single predicate behind both public reads. It exists so that "what makes a profile
        visible?" has one answer in one place: if this method were inlined twice, the day one
        copy learned about a new visibility rule would be the day ``/u/ada`` and
        ``/u/ada/posts`` began disagreeing about whether Ada has a profile.

        Args:
            username: The handle as supplied, uncased and unnormalised.

        Returns:
            The account, guaranteed to exist and to be active.

        Raises:
            NotFoundError: If no account holds the handle, or if the account holding it has
                been deactivated. Both are 404 rather than 403: a deactivated account's
                existence is not something an anonymous caller is entitled to learn, and
                answering 403 would confirm it. The message is identical in both cases.
        """
        author = await self._users.get_by_username(username)

        # A deactivated account is treated as absent on every public surface. An administrator
        # deactivating an account expects it to stop being published, not to keep a profile
        # page that renders a name and an empty list of posts - and because this is the only
        # place the rule is written, the identity endpoint and the post listing enforce exactly
        # the same one.
        if author is None or not author.is_active:
            raise NotFoundError(_PROFILE_NOT_FOUND_DETAIL)

        return author
