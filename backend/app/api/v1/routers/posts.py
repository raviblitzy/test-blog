"""The seven post routes: the feed, the canonical read, and the five lifecycle mutations.

This module is the HTTP surface of R2 - create, edit, delete, publish - and the API half of
R3 - the feed with free-text search, category filtering, author filtering, ordering and
page-based windowing. It is the direct replacement for the five ``/items`` handlers the
single-module application shipped, and every difference between the two is deliberate.

The seven operations
--------------------
Paths are shown as composed. ``app.api.v1.router`` attaches ``/api/v1/posts`` and the
``posts`` tag; no decorator in this file spells either.

``GET /api/v1/posts``
    Public. Answers ``Page[PostSummary]`` - see :func:`list_posts`.
``GET /api/v1/posts/{slug}``
    Public. Answers ``PostDetail`` - see :func:`get_post`.
``POST /api/v1/posts``
    Author or administrator. Answers ``PostDetail`` at 201 - see :func:`create_post`.
``PATCH /api/v1/posts/{post_id}``
    Owning author, or administrator. Answers ``PostDetail`` - see :func:`update_post`.
``DELETE /api/v1/posts/{post_id}``
    Owning author, or administrator. Answers 204 with no body - see :func:`delete_post`.
``POST /api/v1/posts/{post_id}/publish``
    Owning author, or administrator. Answers ``PostDetail`` - see :func:`publish_post`.
``POST /api/v1/posts/{post_id}/unpublish``
    Owning author, or administrator. Answers ``PostDetail`` - see :func:`unpublish_post`.

Authority on a mutation is two rules, not one: the principal must hold ``AUTHOR`` or
``ADMIN`` at all, and - unless it holds ``ADMIN`` - must be the post's own author. Both are
single comparisons made in ``app.services.post_service``, never here; see "What this module
does not do" below. A principal an administrator has demoted to ``READER`` is refused every
one of these five operations, which is what makes the demotion mean something.

Reads address a post by slug, mutations by identifier
-----------------------------------------------------
The asymmetry is intentional and is fixed by the endpoint table this service is written
against. A read is addressed by ``slug`` because the slug *is* the post's canonical URL: it
is derived once at creation, never re-derived on retitle, constrained unique by a ``citext``
index, and already present in every published link, sitemap entry and canonical tag. A
mutation is addressed by the server-generated ``UUID`` because a mutation is an operation on
a row rather than on an address, and the identifier is the one handle that is guaranteed
stable, opaque and unguessable.

Unifying the two would cost something real in each direction: routing mutations by slug
would put a human-editable string in the write path, and routing reads by identifier would
give every article a URL that carries nothing for a reader or a crawler.

The feed's parameters
---------------------
``q``, ``category``, ``author`` and ``sort`` are declared on :func:`list_posts` because they
are feed-specific; ``page`` and ``page_size`` arrive through
:data:`~app.core.dependencies.PageParamsDep`, whose ``PageParams`` docstring names this
module as the owner of the other four for exactly that reason. Folding the filters into the
shared window would document four parameters on the comment listing and on every
administrative table that have no use for them.

There is deliberately **no** ``status`` parameter. Which lifecycle states are in scope is
decided from the resolved viewer by ``app.services.post_service.visible_statuses_for``, so
draft confidentiality is one rule in one place rather than a filter a client supplies and
could therefore omit. An author's workspace reaches their own drafts by calling this same
route authenticated with ``?author=<their username>``.

What this module does not do, and why
-------------------------------------
Each of the following is the retired module's shape stated as a prohibition, because this is
the file where those habits would be most tempting to repeat.

**No data access.** No statement of any kind, no session query, no ORM traversal, and no
import of the repository layer. Each handler below is one call into
:class:`~app.services.post_service.PostService`. The retired code did the opposite: it
mutated a module-level list in place - ``items.append(item)``, ``items[index] =
updated_item``, ``items.pop(index)`` - and wrote the identity predicate ``item.id ==
item_id`` out independently in three handlers. That predicate now exists once, in the
repository layer's shared lookup, reached only through the service.

**No authority comparison.** No role check, no ``author_id == principal.id``, and no call to
any authority predicate. ``PostService`` decides - it calls ``ensure_can_author`` for the role
and ``ensure_can_modify`` for the ownership - so the same two rules hold no matter which entry
point invokes them and both are unit-testable without an HTTP request in the picture. The five
mutation signatures declare ``AuthorUser`` so the capability appears in the published contract
and an anonymous or demoted caller is refused before any handler body runs - but that annotation
is a GATE, not the enforcement point: what the signature says is "somebody entitled is asking",
and what the service decides is "may they act on THIS post".

**No framework exception.** The framework's own HTTP exception type appears nowhere in this
file, where the retired module raised it with a 404 and the detail ``"Item not found"`` at
three separate call sites - one decision written three times, and three places for it to
drift. Services raise the typed ``AppError`` family - ``NotFoundError``, ``ConflictError``,
``ForbiddenError`` - and the single handler registered by ``app.core.exceptions`` renders one
problem document for all of them. Nothing is imported from that module here: this file
neither raises nor catches, it only documents what the service can raise.

**No inline schema.** Every shape comes from ``app.schemas``. The retired module declared its
one model beside its handlers, which is how a wire contract ends up with no home.

**No envelope.** A single post is returned bare; a collection is returned in the one page
envelope. The retired API was inconsistent by construction - its mutating routes wrapped
results in ``{"message", "data"}``, its delete answered ``{"message"}`` alone, and its
collection read returned a naked list - so a client could not write one response reader.

**No ``/items``.** Not as a route, not as a redirect, not as a deprecation stub. The resource
is superseded, and no consumer of it can exist because its data never survived a restart.

Invariants this module leaves to the database
---------------------------------------------
Three guarantees are asserted nowhere in this file, on purpose. ``CHECK (status <>
'PUBLISHED' OR published_at IS NOT NULL)`` makes a published post without a publication
instant unstorable. The ``citext`` unique index on ``posts.slug`` makes a duplicate address
unstorable. ``ON DELETE CASCADE`` on the comment, like and category-filing foreign keys
removes a deleted post's children in the statement that removes the post. All three were
verified by execution against PostgreSQL 18.4. Restating any of them in Python would give one
guarantee two definitions, and the Python copy is the one that would drift.

Nor is there an index-maintenance step anywhere below: ``posts.search_vector`` is a generated
column, so the commit a service performs re-derives it.

Governing standards
-------------------
``review_rules`` reports that this project specifies no user rules, so no user rule governs
this file. The self-imposed standards this repository holds itself to stand in their place,
and seven decide the shape of this module: *layered separation of concerns*, which the four
prohibitions above discharge; *explicit API contracts*, which is why six routes declare a
``response_model``, the seventh documents an empty 204, and every documented failure names
:class:`~app.schemas.common.ProblemDetail`; *API versioning*, which is why :data:`router` is
constructed bare and the collection path is the empty string; *secure-by-default
authentication*, which is why all five mutations take an authenticated principal and why
ownership is re-checked in the service regardless of what a client chooses to hide;
*server-owned identity*, which is why no request body can carry ``id``, ``slug``, ``status``,
``published_at``, ``view_count`` or ``author_id``; *configuration from the environment only*,
which this file honours by reading no environment variable at all; and *blocking quality
gates*, which is why ``ruff``, ``mypy`` and the post integration suites all have to pass on
it.
"""

from typing import Annotated, Any, Final
from uuid import UUID

from fastapi import APIRouter, Query, status

from app.api.v1.responses import OPTIONAL_AUTHENTICATION, ProblemResponses, problem_response
from app.core.dependencies import AuthorUser, DbSession, OptionalUser, PageParamsDep
from app.schemas import Page, PostCreate, PostDetail, PostSortOption, PostSummary, PostUpdate
from app.schemas.common import (
    MAX_SEARCH_TERM_LENGTH,
    OptionalStorableText,
    SearchTerm,
    StorableText,
)
from app.services import PostService

__all__ = ["router"]


# ---------------------------------------------------------------------------------------
# The ordering vocabulary
#
# `sort` is annotated with `app.schemas.post.PostSortOption`, which mirrors the storage-side
# alias `PostSort` in the repository module `post_repository` value for value. Both are
# exactly `Literal["recent", "relevance"]`; the parity was confirmed by comparing
# `typing.get_args` on the two aliases, and the schema module's own docstring records the
# mirroring as intentional. `PostSort` is the authority these two values mirror.
#
# Why the alias is imported rather than restated here. The storage vocabulary lives in the
# repository because that is where the statement is composed, and a repository must not
# import the schema layer - so the wire vocabulary is declared on the schema side, in
# `app.schemas.post`, and published on that module's `__all__` and on the `app.schemas`
# barrel expressly so that this router can annotate this parameter with it. Writing
# `Literal["recent", "relevance"]` out again here would make this file a THIRD source of
# truth for a two-value vocabulary that already has two by design, and a restated vocabulary
# is one that drifts: a member added on either side would silently not exist on this one.
# Importing it makes the character-for-character match a property of the code rather than of
# a comment, while FastAPI still sees a concrete `Literal` at this signature and still emits
# the two accepted values into `/openapi.json` as an enumerated query parameter.
#
# The repository layer is deliberately NOT imported in order to reach `PostSort` itself: the
# API tier does not reach past the service layer, and `PostSort` is not published on the
# service barrel's surface either - which is precisely why the schema layer publishes its own.
#
# THERE IS NO DEFAULT CONSTANT HERE, AND ADDING ONE BACK WOULD BE A DEFECT. The `sort`
# parameter below is `PostSortOption | None` with a default of `None`, because the ordering a
# caller who expressed no preference should get is not a constant - it is a function of
# whether they searched. `PostService.list_feed` answers it through `_default_sort_for`: a
# term means `relevance`, no term means `recent`. Spelling `recent` as this signature's
# default is what made the relevance default unreachable - the service's rule keys off
# `sort is None`, so a route that always sent a value meant a search was never ranked - and
# the AAP requires relevance ranking when a term is present (R3). `None` here is therefore
# "the caller expressed no preference", which is information the service needs and which a
# defaulted signature destroys before it can be used.
#
# The two other listings over the same repository - the profile listing and the
# administrative table - pass no `sort` at all, so they take
# `post_repository.DEFAULT_POST_SORT`. That constant remains the storage-side default; it is
# the *wire* default that could not survive being a constant.
# ---------------------------------------------------------------------------------------


# ---------------------------------------------------------------------------------------
# The router
#
# Bare: no `prefix=`, no `tags=`, no router-level `dependencies=`. `app.api.v1.router`
# attaches `/api/v1/posts` and the `posts` tag on its `include_router` call, so the prefix is
# written once for the whole service and no route here can leave the version namespace by
# forgetting it. A `dependencies=` list would be wrong for a different reason: two of these
# seven routes are public, so an authentication requirement belongs on the five signatures
# that need it and not on the object that carries all seven.
#
# PATH ORDERING HAZARD. Starlette matches routes in registration order, so within one HTTP
# method a literal segment must be registered BEFORE a parameterised one that could also
# match it. Today `GET /{slug}` is the only parameterised GET item route and nothing can
# shadow it, and `POST ""` is registered ahead of `POST /{post_id}/publish` and
# `POST /{post_id}/unpublish` - which cannot collide with it in any case, since the empty
# collection path matches no two-segment request. The rule still has to be honoured by
# whoever extends this file: a literal GET sub-path such as `/featured` added below
# `GET /{slug}` would never be reached, because `{slug}` would match the word "featured"
# first and the request would 404 as a missing post. Register any such route ABOVE the slug
# route.
#
# The collection path is the empty string and never "/". `""` composes with the aggregate's
# prefix to exactly `/api/v1/posts`; `"/"` would compose to `/api/v1/posts/`, which is a
# second URL for one resource and a 307 redirect for every client that omits the slash.
# ---------------------------------------------------------------------------------------

router = APIRouter()
"""The post router, mounted by ``app.api.v1.router`` at ``/api/v1/posts`` under the
``posts`` tag.

Bound as ``posts.router`` by the aggregate. Constructed without a prefix, a tag or a
router-level dependency, because all three are the aggregate's to attach.
"""


# ---------------------------------------------------------------------------------------
# Documented failure modes
#
# Every entry is built by `app.api.v1.responses.problem_response`, which is the one place in
# this package that names `ProblemDetail` and the one place the published media type is
# decided. So `/openapi.json` describes the one document `app.core.exceptions` actually emits
# - `type`, `title`, `status`, `detail`, `instance`, and `errors` on a 422 - under the one
# media type it emits it as, and a generated client gets one error type for the whole API
# instead of a different shape per route.
#
# Declaring 422 is not optional, even where nothing but a malformed path parameter can cause
# one. FastAPI documents a 422 automatically on any operation that validates a parameter or a
# body, and the model it reaches for is its own `HTTPValidationError`, whose `{"detail":
# [{"loc": ...}]}` shape this service never returns: `register_exception_handlers` converts
# every `RequestValidationError` into a problem document with a populated `errors` list.
# Declaring the status explicitly is what replaces that inaccurate default, so all seven
# operations below carry an entry - each of the seven validates at least a query parameter, a
# path parameter or a body.
#
# The set is exactly what each route can PRODUCE, and no more, in both directions: a status the
# code cannot emit makes the document advertise a branch a client can never take, and a status
# the code CAN emit but does not declare leaves a client with an undocumented body to parse.
# Both are the same class of defect as declaring no response model at all. Three consequences
# are worth recording, because all three were checked against the service rather than assumed:
#
#   * 409 appears on `POST ""` AND on `PATCH /{post_id}`, and on those two alone.
#     `app.services.post_service` translates exactly two integrity failures into
#     `ConflictError` - a slug unique-index collision, which only `create` can cause because
#     the slug is deliberately not re-derived on a retitle, and a concurrent change to a post's
#     category filings, which both methods can cause because both rewrite `post_categories`.
#     `publish` and `unpublish` write neither, and both are documented idempotent, so a 409 on
#     those two would be unreachable. Every other integrity failure is re-raised rather than
#     reported as contention, so a 409 from this router always means "somebody else got there
#     first" and a retry is always the right response to it.
#   * 404 appears on both public reads AND on `POST ""`. Creating a post with an unknown
#     category identifier is a `NotFoundError`, and so is filtering the feed by a username
#     that names no account - the latter reported rather than answered with an empty page, so
#     a mistyped filter stays distinguishable from an author who has published nothing.
#   * 422 is declared on all seven operations and never left to the framework. See the note
#     above for why the default is inaccurate rather than merely terse.
#
# 401 appears on the two public reads as well as on the five mutations, and that is not a
# contradiction: `OptionalUser` tolerates an ABSENT credential, but a credential that is
# present and unusable - malformed, expired, or naming an account that no longer exists - is
# still rejected, because silently degrading a broken session to anonymous would hide the
# expiry from the client that needs to refresh it. A DEACTIVATED account is the one case that
# is neither: `OptionalUser` resolves it as anonymous, so a public read succeeds with the
# public projection and no 403 is reachable on either of the two reads.
#
# 403 appears on ALL FIVE mutations, including the collection route. Two rules produce it, and
# the collection route is subject to the first: `ensure_can_author` refuses a `READER`
# outright, and `ensure_can_modify` refuses an `AUTHOR` acting on somebody else's post. A
# deactivated account is refused by `AuthorUser` with the same status before either runs.
#
# THE TWO PUBLIC READS ALSO CARRY `openapi_extra=OPTIONAL_AUTHENTICATION`, which is a
# declaration about the credential rather than about a failure. Both resolve `OptionalUser`, so
# the framework finds the bearer scheme in the dependency tree and would publish it as
# REQUIRED - making a generated client refuse a call any anonymous visitor may make, and making
# the interactive documentation hide it behind an authorisation prompt. The marker publishes
# both alternatives, anonymous first. See `app.api.v1.responses` for why it cannot be written
# as a `security` override.
# ---------------------------------------------------------------------------------------

_UNAUTHORIZED_ON_READ: Final[dict[str, Any]] = problem_response(
    "A credential was presented and could not be used - malformed, expired, of the wrong "
    "token type, or naming an account that no longer exists. Omitting the "
    "`Authorization` header entirely is **not** an error on this route: an anonymous "
    "caller is served the public projection. A client seeing this should refresh its "
    "access token and retry."
)
"""401 on the two public reads, whose principal is optional but not ignorable."""

_UNAUTHORIZED_ON_WRITE: Final[dict[str, Any]] = problem_response(
    "No usable `Authorization: Bearer` credential was presented. Every mutation on this "
    "resource requires an authenticated principal, because the post's author is taken "
    "from the principal and could never be taken from the request body."
)
"""401 on the five mutations."""

_FORBIDDEN_ON_WRITE: Final[dict[str, Any]] = problem_response(
    "The caller is authenticated but may not act on this post. Three states produce it: "
    "the account holds `READER`, so it may not author at all; it holds `AUTHOR` but "
    "neither wrote this post nor holds `ADMIN`; or it has been deactivated. The response "
    "does not say which - naming the missing authority would tell a caller which account "
    "state to go and change. Every check is made server-side in the service layer, so "
    "hiding the control in a client changes nothing about it."
)
"""403 on all five mutations - see :func:`create_post` for why the collection route needs it."""

_POST_NOT_FOUND: Final[dict[str, Any]] = problem_response(
    "No post is addressable that way. A draft the caller may not read answers this "
    "identically to a post that does not exist - deliberately, because a distinguishable "
    "403 would let an unauthorised caller confirm that unpublished content exists and "
    "enumerate it."
)
"""404 wherever a single post is addressed, by slug or by identifier."""

_VALIDATION_FAILED: Final[dict[str, Any]] = problem_response(
    "The request did not satisfy the contract. The problem document carries an `errors` "
    "list naming each offending field and why it was rejected. Reached by an out-of-range "
    "`page_size`, a `sort` value outside the two accepted ones, a path identifier that is "
    "not a UUID, or a body that omits a required member, violates a length bound or "
    "carries a member the schema forbids."
)
"""422 on all seven operations - see the note above on why it is always declared."""

_CATEGORY_FILING_CONFLICT: Final[dict[str, Any]] = problem_response(
    "This post's category filings were changed concurrently: another writer filed it under "
    "a category this request was also filing, or deleted a category this request had already "
    "confirmed. The association's composite primary key and its foreign key are the "
    "backstops, and this is their translation. Reload the post and retry - the retry sees "
    "the filings as they now stand."
)
"""409 on create and update, the two routes that rewrite ``post_categories``."""

_FEED_RESPONSES: Final[ProblemResponses] = {
    status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED_ON_READ,
    status.HTTP_404_NOT_FOUND: problem_response(
        "The `author` filter names no account. Reported rather than answered with an "
        "empty page, so a mistyped username is distinguishable from an author who has "
        "published nothing. A `category` that matches nothing is **not** an error - a "
        "filter over a taxonomy legitimately selects zero posts."
    ),
    status.HTTP_422_UNPROCESSABLE_CONTENT: _VALIDATION_FAILED,
}

_DETAIL_RESPONSES: Final[ProblemResponses] = {
    status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED_ON_READ,
    status.HTTP_404_NOT_FOUND: _POST_NOT_FOUND,
    status.HTTP_422_UNPROCESSABLE_CONTENT: _VALIDATION_FAILED,
}

_CREATE_RESPONSES: Final[ProblemResponses] = {
    status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED_ON_WRITE,
    status.HTTP_403_FORBIDDEN: _FORBIDDEN_ON_WRITE,
    status.HTTP_404_NOT_FOUND: problem_response(
        "One of the submitted `category_ids` names no category. Reported before the post "
        "is inserted, so a bad identifier never reserves a slug or leaves a half-filed "
        "draft behind."
    ),
    status.HTTP_409_CONFLICT: problem_response(
        "A concurrent write got there first, in one of two ways. Either the slug derived "
        "from the title was taken between the moment the taken set was read and the moment "
        "the row was inserted - two concurrent creates of the same title, with the `citext` "
        "unique index on `posts.slug` as the backstop - or a category this post was being "
        "filed under changed underneath the insert. A retry resolves both: it sees the row "
        "that won and derives the next free suffix, and it re-reads the taxonomy."
    ),
    status.HTTP_422_UNPROCESSABLE_CONTENT: _VALIDATION_FAILED,
}

_UPDATE_RESPONSES: Final[ProblemResponses] = {
    status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED_ON_WRITE,
    status.HTTP_403_FORBIDDEN: _FORBIDDEN_ON_WRITE,
    status.HTTP_404_NOT_FOUND: problem_response(
        "No post carries that identifier, or one of the submitted `category_ids` names no category."
    ),
    status.HTTP_409_CONFLICT: _CATEGORY_FILING_CONFLICT,
    status.HTTP_422_UNPROCESSABLE_CONTENT: _VALIDATION_FAILED,
}

_MUTATION_RESPONSES: Final[ProblemResponses] = {
    status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED_ON_WRITE,
    status.HTTP_403_FORBIDDEN: _FORBIDDEN_ON_WRITE,
    status.HTTP_404_NOT_FOUND: _POST_NOT_FOUND,
    status.HTTP_422_UNPROCESSABLE_CONTENT: _VALIDATION_FAILED,
}
"""Shared by delete, publish and unpublish: three routes whose only inputs are the path
identifier and the principal, and whose failure modes are therefore identical."""


# ---------------------------------------------------------------------------------------
# Reads
#
# `GET ""` is registered first, and `GET "/{slug}"` immediately after it. See the path
# ordering hazard recorded above the router: any literal GET sub-path added later must go
# ABOVE the slug route or `{slug}` will swallow it.
# ---------------------------------------------------------------------------------------


@router.get(
    "",
    response_model=Page[PostSummary],
    status_code=status.HTTP_200_OK,
    responses=_FEED_RESPONSES,
    # Anonymous OR bearer, in that order - not bearer as a requirement. See the marker's note
    # above the response constants.
    openapi_extra=OPTIONAL_AUTHENTICATION,
    summary="List posts",
    description=(
        "The home feed. Composes free-text search, category filtering, author filtering, "
        "ordering and page-based windowing into a single query and answers with the uniform "
        "page envelope every listing in this API uses.\n\n"
        "Anonymous callers see published posts only. An authenticated caller additionally "
        "sees their own drafts and archived posts, and an administrator sees every post - "
        "which is how an author's workspace lists its drafts, by calling this route "
        "authenticated with `author=<their own username>`.\n\n"
        "Every parameter narrows the result independently, and all of them are optional, so "
        "the bare path is the default feed: published posts, newest first. Adding `q` without "
        "`sort` ranks the page by relevance instead - the ordering follows what was asked, so "
        "a search returns its best matches and a browse returns the newest posts. A page past "
        "the last one is not an error - it answers 200 with an empty `items` list beside the "
        "real `total` and `pages`, which is how a client detects it has run off the end."
    ),
)
async def list_posts(
    db: DbSession,
    window: PageParamsDep,
    viewer: OptionalUser,
    q: Annotated[
        SearchTerm,
        Query(
            description=(
                "Free-text search term, matched against the post's title, excerpt and body "
                "through the generated search vector. Omit it to browse rather than search.\n\n"
                f"At most {MAX_SEARCH_TERM_LENGTH} characters; a longer term is refused with "
                "`422` rather than truncated, because a silently shortened search returns "
                "results for a query the caller did not make. Whitespace runs are collapsed "
                "and a whitespace-only value is treated as absent. Nothing else is altered - "
                "the term reaches the full-text parser as typed, so its operator syntax "
                "survives.\n\n"
                "Supplying a term with no `sort` ranks the page by relevance; see `sort`."
            ),
        ),
    ] = None,
    category: Annotated[
        str | None,
        Query(
            description=(
                "Category **slug** to filter by - the URL-safe identifier from "
                "`GET /api/v1/categories`, not the display name and not the UUID. Matched "
                "case-insensitively. A slug that matches no posts answers an empty page "
                "rather than an error; one carrying a NUL character is refused as `422`, "
                "because `citext` cannot represent that character and so cannot compare it "
                "against a stored slug at all."
            ),
        ),
        OptionalStorableText,
    ] = None,
    author: Annotated[
        str | None,
        Query(
            description=(
                "Author **username** to filter by, matched case-insensitively. A username "
                "that names no account answers 404, so a mistyped filter is distinguishable "
                "from an author who has published nothing; one carrying a NUL character is "
                "refused as `422` instead, since `citext` cannot represent that character "
                "and the comparison could not be performed."
            ),
        ),
        OptionalStorableText,
    ] = None,
    sort: Annotated[
        PostSortOption | None,
        Query(
            description=(
                "`recent` orders by publication instant, newest first. `relevance` ranks "
                "against the search vector, best match first, and is meaningful only alongside "
                "`q` - with no term it degrades to recency rather than failing.\n\n"
                "**Omitting it is not the same as sending `recent`.** With no `sort`, the "
                "ordering follows the request: a search (`q` present) is ranked by "
                "`relevance`, because asking a question means asking for the best answer, and "
                "a browse (no `q`) is ordered by `recent`. Send `sort=recent` alongside `q` to "
                "search and still read newest-first."
            ),
        ),
    ] = None,
) -> Page[PostSummary]:
    """Answer the feed for ``GET /api/v1/posts``.

    Args:
        db: The request-scoped session, injected by ``get_db``.
        window: The validated page window. ``page`` and ``page_size`` are already normalised
            and bounded by ``PageParams``, so no arithmetic and no clamping happens here; the
            response half of the same contract, ``pages``, is computed by ``build_page``
            inside the service.
        viewer: The resolved principal, or ``None`` for an anonymous caller. Passed straight
            through, because *which lifecycle states are in scope* is the service's decision
            and making it here would give draft confidentiality a second definition.
        q: Free-text search term, or ``None``. Bounded to
            :data:`~app.schemas.common.MAX_SEARCH_TERM_LENGTH` characters and whitespace-
            collapsed by :data:`~app.schemas.common.SearchTerm` before this function is
            entered, so nothing here trims, folds or measures it.
        category: Category slug to filter by, or ``None``.
        author: Author username to filter by, or ``None``.
        sort: The caller's requested ordering, or ``None`` when they expressed none - which is
            **passed through as ``None``** rather than defaulted here. The default is
            conditional on ``q`` and the service owns it; see the note above the router on why
            substituting a value at this boundary is what made relevance ranking unreachable.

    Returns:
        The page of :class:`~app.schemas.post.PostSummary` the service assembled, returned
        unchanged. The summary projection carries no ``content``, which is what keeps a feed
        page small however long the articles behind it are - substituting
        :class:`~app.schemas.post.PostDetail` here would multiply the payload of the most
        requested endpoint in the product by the weight of an average article, for a card
        that renders a title and an excerpt.

    Note:
        The three wire names differ from the service's parameter names on purpose, and this
        line is the whole of the translation: ``category`` is a slug and ``author`` is a
        username, so they are handed over as ``category_slug`` and ``author_username`` -
        names that say what the value *is* rather than what the query string calls it. The
        service resolves the username to an identifier, because the wire speaks usernames and
        the query speaks identifiers.
    """
    return await PostService(db).list_feed(
        page=window.page,
        page_size=window.page_size,
        q=q,
        category_slug=category,
        author_username=author,
        sort=sort,
        viewer=viewer,
    )


@router.get(
    "/{slug}",
    response_model=PostDetail,
    status_code=status.HTTP_200_OK,
    responses=_DETAIL_RESPONSES,
    # Anonymous OR bearer, in that order - a draft's own author is served their draft here, and
    # an anonymous visitor is served the published post, so neither alternative may be dropped.
    openapi_extra=OPTIONAL_AUTHENTICATION,
    summary="Read one post by its canonical slug",
    description=(
        "Returns one post in full, including its body, addressed by the slug that is its "
        "canonical URL. This is the endpoint the client's `/blog/[slug]` page renders from, "
        "which is why it is addressed by slug and not by identifier: the slug is derived once "
        "at creation and never re-derived on a retitle, so a canonical URL, a sitemap entry "
        "and an inbound link stay valid for the life of the post.\n\n"
        "A published post is readable by anyone. A draft or archived post is readable only by "
        "its author or an administrator; to every other caller it answers 404, identically to "
        "a post that does not exist, so the response cannot be used to discover that "
        "unpublished content exists."
    ),
)
async def get_post(
    db: DbSession,
    viewer: OptionalUser,
    slug: Annotated[str, StorableText],
) -> PostDetail:
    """Resolve one post by slug for ``GET /api/v1/posts/{slug}``.

    Args:
        db: The request-scoped session.
        viewer: The resolved principal, or ``None`` when the caller is anonymous. The draft
            rule is applied by the service against this value.
        slug: The post's canonical slug, taken verbatim from the path. It is deliberately
            **not** lower-cased or otherwise normalised here: ``posts.slug`` is a ``citext``
            column under a unique index, so the case-insensitive comparison happens in the
            database on an indexed predicate. Folding the case in Python would duplicate a
            rule the schema already owns and would silently diverge from it the moment the
            column's collation changed. The one value refused before the service is reached is
            a slug carrying a NUL character: ``citext`` cannot represent it, so it names no
            post and cannot be compared against one - see
            :data:`~app.schemas.common.StorableText`.

    Returns:
        The post projected into :class:`~app.schemas.post.PostDetail` - the bare
        representation, with no ``message``/``data`` wrapper around it. The service returns
        the entity with its author and categories already loaded, so this projection issues
        no further query.

    Note:
        A draft the caller may not read raises ``NotFoundError`` inside the service, not
        ``ForbiddenError``, and this handler adds no check of its own. Distinguishing "you may
        not see this draft" from "this does not exist" would leak the existence of unpublished
        content, so the two are one answer by design.
    """
    return PostDetail.model_validate(await PostService(db).get_by_slug(slug, viewer=viewer))


# ---------------------------------------------------------------------------------------
# Mutations
#
# All five take `AuthorUser`, so an anonymous request is rejected before any of these bodies
# runs and so is one from an account holding `READER` - authoring is a capability of the
# `AUTHOR` and `ADMIN` roles, and without that gate an administrative demotion would revoke
# nothing, since every other check on this path is ownership-scoped and a demoted author still
# owns the posts they wrote. All five address the post by its server-generated UUID rather than
# by slug.
#
# `AuthorUser` is a gate, not the enforcement point. None of these bodies contains an authority
# comparison: `PostService` re-checks the same capability through `ensure_can_author` and then
# applies the ownership rule through `ensure_can_modify`, so the rules hold for any entry point
# rather than only for a request that happens to declare this dependency. On the four routes
# that address an existing post the service resolves the row FIRST, so a caller with no
# authority over a post that does not exist gets 404 rather than a 403 that would confirm it
# exists.
# ---------------------------------------------------------------------------------------


@router.post(
    "",
    response_model=PostDetail,
    status_code=status.HTTP_201_CREATED,
    responses=_CREATE_RESPONSES,
    summary="Create a draft post",
    description=(
        "Creates a post and answers 201 with the created resource. The new post is always a "
        "**draft**: it is absent from the public feed, from category-filtered results and from "
        "its author's public profile until `POST /api/v1/posts/{post_id}/publish` runs. There "
        "is no parameter that changes that, which is what stops an author publishing by "
        "accident and what keeps the lifecycle state and the publication instant written "
        "together.\n\n"
        "The body carries only what a human decides - title, excerpt, body, cover image and "
        "category filings. `id`, `slug`, `status`, `published_at`, `view_count` and "
        "`author_id` are all server-owned: the schema rejects any request that names one, the "
        "slug is derived from the title and de-duplicated, and the author is taken from the "
        "presented credential.\n\n"
        "Requires the `AUTHOR` or `ADMIN` role, which a self-registered account holds from "
        "the moment it is created - so signing up is the whole of the path to authoring. An "
        "account an administrator has demoted to `READER` is refused with `403`, and writing "
        "does not promote it back."
    ),
)
async def create_post(
    db: DbSession,
    author: AuthorUser,
    payload: PostCreate,
) -> PostDetail:
    """Create a draft for ``POST /api/v1/posts``.

    Args:
        db: The request-scoped session.
        author: The authenticated, active principal. The post's ``author_id`` is taken from
            here and could not have come from the body - the schema forbids the member. The
            service refuses it with 403 unless it holds ``AUTHOR`` or ``ADMIN``.
        payload: The validated request body.

    Returns:
        The created post projected into :class:`~app.schemas.post.PostDetail`, in state
        ``DRAFT`` with ``published_at`` unset. Returned bare at 201, not wrapped in a
        ``message``/``data`` envelope.

    Note:
        Slug derivation, content sanitisation and category association all happen in the
        service, in one transaction, and none of them is re-attempted here. There is nothing
        for this handler to add to them: a second sanitisation pass would only make it unclear
        which one the stored value came from.
    """
    return PostDetail.model_validate(await PostService(db).create(payload, author=author))


@router.patch(
    "/{post_id}",
    response_model=PostDetail,
    status_code=status.HTTP_200_OK,
    responses=_UPDATE_RESPONSES,
    summary="Partially update a post",
    description=(
        "Applies a **genuine partial update**: only the members present in the request body "
        "are changed, and every member the body omits keeps the value it already had. That is "
        "the substantive difference from a whole-object `PUT`, which assigns the submitted "
        "object over the stored one and so lets a client holding a stale copy silently revert "
        "every field it had not refreshed.\n\n"
        "For the two nullable members the distinction between *omitted* and *null* is "
        "meaningful: omitting `excerpt` or `cover_image_url` leaves it as it is, while sending "
        "an explicit `null` clears it. `title`, `content` and `category_ids` reject an "
        "explicit null, because there is no state they could be cleared to. `category_ids` "
        "**replaces** the filings rather than adding to them, so an empty list unfiles the "
        "post.\n\n"
        "The slug is never re-derived, even when the title changes: the post's address is in "
        "every link and sitemap entry already published, so moving it would break indexed URLs "
        "for no gain. `status` and `published_at` are not reachable from here either - "
        "publishing is a transition, not a field, and the two dedicated sub-resources write "
        "the lifecycle state and the publication instant together."
    ),
)
async def update_post(
    db: DbSession,
    actor: AuthorUser,
    post_id: UUID,
    payload: PostUpdate,
) -> PostDetail:
    """Apply a partial update for ``PATCH /api/v1/posts/{post_id}``.

    Args:
        db: The request-scoped session.
        actor: The authenticated, active principal. Must hold ``AUTHOR`` or ``ADMIN`` and must
            own the post unless it holds ``ADMIN``, which
            the service enforces.
        post_id: The post's server-generated identifier. Typed :class:`~uuid.UUID`, so a
            malformed value is a 422 naming the parameter before this body runs.
        payload: The members that are changing. Every field is optional, and an unset field is
            distinguishable from one explicitly set to ``null``.

    Returns:
        The updated post projected into :class:`~app.schemas.post.PostDetail`.

    Note:
        This handler constructs no replacement object and reads no field off the payload. The
        service is what distinguishes "omitted" from "explicitly null", using the model's own
        record of which members were actually sent; rebuilding a full object here would
        reintroduce exactly the whole-object overwrite this route exists to replace.

        No ownership comparison appears here either. The service resolves the row first and
        applies the one ownership rule second, so a caller with no authority over a post that
        does not exist is told 404 rather than a 403 that would confirm it exists.
    """
    return PostDetail.model_validate(await PostService(db).update(post_id, payload, actor=actor))


@router.delete(
    "/{post_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    responses=_MUTATION_RESPONSES,
    summary="Delete a post",
    description=(
        "Deletes the post and answers 204 with an **empty body**. There is no confirmation "
        "envelope: the status code is the whole of the answer, which is what lets a client "
        "treat every successful delete in this API identically.\n\n"
        "The post's comments, likes and category filings go with it, removed by the "
        "`ON DELETE CASCADE` the foreign keys declare rather than by any application code. "
        "Deletion is final - `POST /api/v1/posts/{post_id}/unpublish` returns a post to "
        "drafting, and the archived state exists for one that should stop being public without "
        "ceasing to exist."
    ),
)
async def delete_post(
    db: DbSession,
    actor: AuthorUser,
    post_id: UUID,
) -> None:
    """Delete a post for ``DELETE /api/v1/posts/{post_id}``.

    Args:
        db: The request-scoped session.
        actor: The authenticated, active principal. Must hold ``AUTHOR`` or ``ADMIN``, and
            must own the post unless it holds ``ADMIN``.
        post_id: The post's server-generated identifier.

    Returns:
        ``None``. A 204 carries no body, so there is nothing to return and nothing to
        serialise - which is the point of choosing the status: the retired API answered its
        delete with ``{"message": "Item deleted"}``, a payload that told a caller nothing the
        status code had not already told it, in a shape that matched none of its other routes.

    Note:
        No child rows are removed here, and no relationship is iterated. Every one of the
        comment, like and category-filing foreign keys declares ``ON DELETE CASCADE``, so
        PostgreSQL removes them in the statement that removes this row. A Python
        re-implementation would give one rule two definitions, and the Python copy is the one
        that would forget a relation added later.
    """
    await PostService(db).delete(post_id, actor=actor)


@router.post(
    "/{post_id}/publish",
    response_model=PostDetail,
    status_code=status.HTTP_200_OK,
    responses=_MUTATION_RESPONSES,
    summary="Publish a post",
    description=(
        "Transitions the post to `PUBLISHED` and stamps its publication instant, making it "
        "visible in the feed, in category-filtered results and on its author's public "
        "profile. Takes no request body - the identifier in the path and the presented "
        "credential are the whole of the input.\n\n"
        "This is a first-class transition and not a flag on the general update, which is why "
        "`PATCH` exposes no `status` member: the lifecycle state and the publication instant "
        "are written together here, and a patchable flag would let one be written without the "
        "other.\n\n"
        "**Idempotent.** Publishing an already-published post returns it unchanged with 200 "
        "rather than rejecting the request, and does not re-stamp the publication instant - "
        "re-stamping would move a months-old article to the top of the home page, because the "
        "default feed ordering is by that instant. Publishing an archived post likewise "
        "restores it carrying the date it first went public."
    ),
)
async def publish_post(
    db: DbSession,
    actor: AuthorUser,
    post_id: UUID,
) -> PostDetail:
    """Transition a post to published for ``POST /api/v1/posts/{post_id}/publish``.

    Args:
        db: The request-scoped session.
        actor: The authenticated, active principal. Must hold ``AUTHOR`` or ``ADMIN``, and
            must own the post unless it holds ``ADMIN``.
        post_id: The post's server-generated identifier.

    Returns:
        The published post projected into :class:`~app.schemas.post.PostDetail`, with its
        status set and its ``published_at`` guaranteed non-null.

    Note:
        The publication invariant - ``CHECK (status <> 'PUBLISHED' OR published_at IS NOT
        NULL)`` - is asserted nowhere in this handler, because the database enforces it
        independently of any application code; inserting a published row with no publication
        instant was verified rejected against PostgreSQL 18.4. Restating it here would give one
        guarantee two definitions.

        There is no search-index step either. ``posts.search_vector`` is a generated column, so
        the service's commit re-derives it and the post is findable immediately.
    """
    return PostDetail.model_validate(await PostService(db).publish(post_id, actor=actor))


@router.post(
    "/{post_id}/unpublish",
    response_model=PostDetail,
    status_code=status.HTTP_200_OK,
    responses=_MUTATION_RESPONSES,
    summary="Unpublish a post",
    description=(
        "The inverse transition: returns the post to `DRAFT`, removing it from the feed, from "
        "category-filtered results and from its author's public profile immediately, because "
        "all three surfaces scope themselves by lifecycle state. Takes no request body.\n\n"
        "The publication instant is deliberately **preserved**, not cleared. It records when "
        "the post first became public, while the status records whether it is public now, so "
        "the two answer different questions: re-publishing keeps the original date and the "
        "feed does not silently reorder, the author's workspace can still show when a "
        "withdrawn post was live, and a withdrawn draft stays distinguishable from one that "
        "was never published.\n\n"
        "**Idempotent.** A post already in `DRAFT` is returned unchanged with 200."
    ),
)
async def unpublish_post(
    db: DbSession,
    actor: AuthorUser,
    post_id: UUID,
) -> PostDetail:
    """Return a post to draft for ``POST /api/v1/posts/{post_id}/unpublish``.

    Args:
        db: The request-scoped session.
        actor: The authenticated, active principal. Must hold ``AUTHOR`` or ``ADMIN``, and
            must own the post unless it holds ``ADMIN``.
        post_id: The post's server-generated identifier.

    Returns:
        The post projected into :class:`~app.schemas.post.PostDetail`, back in ``DRAFT`` and
        still carrying the publication instant it was first published at.

    Note:
        Paired with :func:`publish_post` as a dedicated sub-resource rather than collapsed into
        a boolean on the patch route. Two named transitions make the intent of a request
        unambiguous in the access log and in the client that issues it, and they keep the
        lifecycle state the only thing either one changes.
    """
    return PostDetail.model_validate(await PostService(db).unpublish(post_id, actor=actor))
