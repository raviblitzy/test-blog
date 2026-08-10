"""The administrative namespace: thirteen gated operations over four entity families.

What the user asked for was "an admin dashboard for managing users, posts, comments, and
categories". Because the framework question was resolved to FastAPI there is no
framework-provided administration console to inherit, so the dashboard is an explicit route
group over an explicit API namespace - which is what the prompt asked for in any case: an
admin dashboard as a deliverable rather than as a by-product. This module is the API half
of it: a listing, a state mutation and a deletion for each of the four families the prompt
names - plus a creation for the one family that has no self-service path to a new row - and the
aggregate counts the overview screen renders.

The whole namespace, in declaration order::

    GET    /api/v1/admin/stats                     ->  AdminStats
    GET    /api/v1/admin/users                     ->  Page[AdminUser]
    PATCH  /api/v1/admin/users/{user_id}           ->  AdminUser
    DELETE /api/v1/admin/users/{user_id}           ->  204, no body
    GET    /api/v1/admin/posts                     ->  Page[AdminPost]
    PATCH  /api/v1/admin/posts/{post_id}/status    ->  AdminPost
    DELETE /api/v1/admin/posts/{post_id}           ->  204, no body
    GET    /api/v1/admin/comments                  ->  Page[AdminComment]
    PATCH  /api/v1/admin/comments/{id}/status      ->  AdminComment
    DELETE /api/v1/admin/comments/{comment_id}     ->  204, no body
    POST   /api/v1/admin/categories                ->  201, CategoryPublic
    PATCH  /api/v1/admin/categories/{category_id}  ->  CategoryPublic
    DELETE /api/v1/admin/categories/{category_id}  ->  204, no body

Thirteen, and exactly thirteen - the namespace the AAP's REST surface declares (§0.6.2),
neither more nor fewer. There is no administrative listing of categories, because the public
`GET /api/v1/categories` already returns the whole taxonomy, ascending by name, with the same
`post_count` this screen would show; there is no bulk endpoint, no password reset for another
account, no impersonation and no query console. Each of those is a privileged operation
whose blast radius is far wider than anything the dashboard needs, and an administrative
namespace is the one place where "it might be handy" is the most expensive argument in the
codebase.

Where the administrator gate is, and why it is not in this file
--------------------------------------------------------------
**This module declares no authorisation and no routing context of its own.** ``router`` below
is a bare ``APIRouter()`` constructed with no arguments at all: no path prefix, no OpenAPI
tag, and - the part most likely to be "fixed" by a well-meaning reader - no router-level
dependency list. All three are supplied once, by ``app.api.v1.router``, on the single call
that includes this module into the versioned aggregate: that call attaches the ``/admin``
path segment, the ``admin`` documentation tag, and the administrator gate.

.. important::
   The one place the identifier ``require_admin`` appears in this file is this paragraph.
   The gate it names is applied by ``backend/app/api/v1/router.py`` on the call that includes
   this router, and its absence from this module is the design rather than an omission -
   adding it here would be a duplicate security declaration, not a fix.

That single placement is what makes the gate impossible to omit. It covers every operation
beneath it, including one added long after this file was written by someone who never read
this paragraph, so the guarantee is a property of the mount rather than of thirteen separate
acts of remembering. Restating it here would document the same security requirement twice in
``/openapi.json`` for no additional protection, and would put the version prefix and the tag
in two files that then have to agree forever.

What each handler *does* declare is :data:`~app.core.dependencies.AdminUser` - imported
below as ``AdminPrincipal`` - because every method on
:class:`~app.services.admin_service.AdminService` takes a keyword-only ``actor``. It has to:
the self-demotion and self-deactivation guard cannot fire without knowing *who* is acting,
and the audit line for a moderation decision is worthless without it. That is principal
**resolution**, not a second gate: FastAPI resolves a dependency once per request and reuses
the result, so the administrator dependency the mount applies is the very one that produces
this parameter. It also means the namespace fails closed under either half of the wiring
alone.

Defence in depth, three layers deep, and none of the three is decorative. The mount rejects
a caller who does not hold ``ADMIN``. ``AdminService`` re-checks on every one of its methods,
because a service reachable from a test or a script is a service whose guard must not live in
its caller. And the row-scoped rules stay where they always were: ``AdminService`` refuses a
self-demotion, and ``PostService`` and ``CommentService`` still enforce ownership on the
non-administrative paths. A coarse role gate is never a substitute for any of those - it
answers "may this person use this screen", not "may this person do this to this row".

Two names spelled ``AdminUser``
-------------------------------
The identifier exists twice in this codebase, and this is the one module that needs both:

* ``app.core.dependencies.AdminUser`` - the annotated dependency alias that resolves to a
  loaded ``User`` holding ``ADMIN``: the *injected administrator principal*.
* ``app.schemas.admin.AdminUser`` - the *serialised administrative user row*, and the item
  type of ``Page[AdminUser]``.

Python raises nothing when one module imports both; the second import silently wins, and the
symptom is a response model that is secretly a dependency. The collision is therefore
resolved at the import, in the direction ``app.schemas.admin`` prescribes: the **dependency**
is aliased to ``AdminPrincipal`` and the **schema** keeps its documented name. Neither is
negotiable in isolation - the alias is the vocabulary the handler signatures read in, and the
class is the name the response model is documented and tested under.

Thirteen handlers, thirteen one-line service calls
--------------------------------------------------
Every handler here constructs ``AdminService(db)`` and calls exactly one method on it. That
is the whole body. The file's job is shape and routing - path, method, status code, response
model, documented failure modes - and every decision lives one layer down:

* **No data access.** Not one statement is constructed here, nothing is executed or fetched
  against the injected session, no relationship is traversed, and the repository package is
  not imported. The administrative post listing spans all three lifecycle states, the
  moderation queue windows comments across posts, and the overview composes four aggregates -
  all of it inside ``AdminService``, none of it here. This is the direct remedy for the shape
  this repository grew out of, where five handlers mutated a module-level list in place and
  wrote the same identity predicate out three times.
* **No framework exceptions.** No handler here raises one. ``AdminService`` raises the typed
  domain family - ``NotFoundError`` (404), ``ConflictError`` (409), ``ForbiddenError`` (403) -
  and ``app.core.exceptions`` renders every one of them as the same problem document, declared
  once instead of at each call site. The retired surface did the opposite, spelling the same
  404 out three times.
* **No inline models.** Every request and response shape comes from the ``app.schemas``
  barrel; the three lifecycle enumerations come from the ``app.models`` barrel, so a status
  filter documents the same values the database column persists.
* **No authority logic.** No role comparison, no ownership check, no self-demotion check.
* **No aggregate counting.** ``AdminStats`` is four dedicated ``COUNT`` queries, not four
  listings measured in Python.

``password_hash`` reaches no response
-------------------------------------
Not because it is filtered here, but because it is a member of no model in this service:
``AdminUser`` declares eight fields and forbids extras. This module never assembles a
response from a dictionary or from a mapped row, so there is no path by which the column
could arrive in one - and "the caller is an administrator" is not a reason to relax that. A
password hash has no consumer over HTTP; only ``app.core.security`` reads that column.

Nothing is logged here, and no environment variable is read. ``AdminService`` emits one
structured record per administrative action with the actor's identifier, and
``app.middleware.request_context`` emits one per request with the correlation identifier and
the status code, so a rejected call is already observable with its ``request_id``. A line in
this module would be a third record describing the same event.
"""

import uuid
from typing import Annotated, Final

from fastapi import APIRouter, Path, Query, status

# The dependency is aliased and the schema keeps its name - see "Two names spelled AdminUser"
# in the module docstring. `AdminPrincipal` is the injected administrator; `AdminUser`, from
# the schema barrel below, is the serialised administrative user row.
from app.core.dependencies import AdminUser as AdminPrincipal, DbSession, PageParamsDep
from app.models import CommentStatus, PostStatus, UserRole
from app.schemas import (
    AdminComment,
    AdminCommentStatusUpdate,
    AdminPost,
    AdminPostStatusUpdate,
    AdminStats,
    AdminUser,
    AdminUserUpdate,
    CategoryCreate,
    CategoryPublic,
    CategoryUpdate,
    Page,
    ProblemResponses,
    problem_response,
)
from app.schemas.common import MAX_SEARCH_TERM_LENGTH, SearchTerm
from app.services import AdminService

__all__ = ["router"]


# ---------------------------------------------------------------------------------------
# The documented failure modes
#
# Every route declares `responses=` so that each way it can fail carries a schema in
# `/openapi.json` rather than an undocumented body a client generator has to guess at. The
# entries are composed per route with `|` from the four constants below, which keeps each
# decorator's declaration an explicit statement of what that operation can actually return
# and keeps the descriptions from drifting apart between thirteen copies.
#
# Every entry is built by `app.schemas.common.problem_response`, which names the one error
# shape this API has - `type`, `title`, `status`, `detail`, `instance`, `request_id`, in place
# of the three ad-hoc 404 raises and the two different success envelopes the retired surface
# used - and which is the single place its published media type is decided.
# ---------------------------------------------------------------------------------------

_GATE_RESPONSES: Final[ProblemResponses] = {
    status.HTTP_401_UNAUTHORIZED: problem_response(
        "No usable credential was presented: the `Authorization` header was absent or "
        "malformed, or the bearer token was expired, of the wrong type, or names an "
        "account that no longer exists. Obtain a fresh access token from "
        "`POST /api/v1/auth/login` or `POST /api/v1/auth/refresh` and retry."
    ),
    status.HTTP_403_FORBIDDEN: problem_response(
        "The credential is valid but the account may not use this namespace - it holds "
        "`READER` or `AUTHOR` rather than `ADMIN`, or it has been deactivated. The body "
        "does not disclose which role would have sufficed."
    ),
}
"""401 and 403, declared on all thirteen routes because the gate covers all thirteen.

Every operation in this namespace is reachable only by an authenticated, active principal
holding ``ADMIN``, so both failure modes apply uniformly. ``app.api.v1.router`` documents the
same two statuses on the ``include_router`` call that attaches the gate; the wording here is
deliberately consistent with it rather than a second, competing description.
"""

_NOT_FOUND_RESPONSE: Final[ProblemResponses] = {
    status.HTTP_404_NOT_FOUND: problem_response(
        "No record carries the identifier in the path. Raised by the service before "
        "anything is written, so a failed mutation leaves no partial change behind."
    )
}
"""404, declared on every route that addresses a single record by identifier."""

_CONFLICT_RESPONSE: Final[ProblemResponses] = {
    status.HTTP_409_CONFLICT: problem_response(
        "The request cannot be applied to the current state of the data. Either a "
        "category **name** is already taken - byte for byte, which is exactly what the "
        "unique constraint on that column compares, and a name whose derived slug merely "
        "collides is suffixed rather than refused; or a category is still "
        "referenced by at least one post and so may not be deleted yet; or the "
        "administrator is acting on their **own** account in a way that would remove "
        "their access - demoting it out of `ADMIN`, deactivating it, or deleting it. "
        "That last case is a lockout guard rather than an authority rule, which is why "
        "it is a conflict with the current state and not a 403."
    )
}
"""409, declared wherever the outcome depends on existing rows.

The two category routes whose result turns on what already exists, plus the two
account-mutation routes, where the self-lockout guard refuses a change that would strip the
acting administrator of their own access.
"""

_UNPROCESSABLE_RESPONSE: Final[ProblemResponses] = {
    status.HTTP_422_UNPROCESSABLE_CONTENT: problem_response(
        "A parameter or body member failed validation - a path identifier that is not a "
        "UUID, a page window outside `1..100`, a status or role outside its enumeration, "
        "an explicit `null` where omission is how 'unchanged' is expressed, or an "
        "unrecognised member on a body that forbids extras. The problem document carries "
        "an `errors` list naming each offending location."
    )
}
"""422, declared on every route carrying a body, a typed query parameter or a UUID path.

Every route in this namespace qualifies except ``GET /stats``, which takes no input at all.
"""


# ---------------------------------------------------------------------------------------
# The search-term contract, stated once for the three listings that accept one
#
# The bound itself is `app.schemas.common.MAX_SEARCH_TERM_LENGTH` and is enforced by
# `SearchTerm`, the annotation all three `q` parameters carry. This sentence is only the
# published half of it: the number is interpolated rather than written out, so the documentation
# cannot claim a limit the annotation does not enforce, and the same wording reaches all three
# listings rather than drifting into three descriptions of one rule.
#
# Bounding these three matters as much as bounding the public feed. An administrative caller is
# authenticated but is not thereby trusted with unbounded work: `q` here is parsed by the
# full-text parser, matched against a trigram index and written into a structured log line, and
# the length of all three is the caller's to choose unless something says otherwise.
# ---------------------------------------------------------------------------------------

_SEARCH_TERM_BOUND: Final[str] = (
    f"At most {MAX_SEARCH_TERM_LENGTH} characters - a longer term is refused with `422` rather "
    "than truncated, because a silently shortened search answers a question the caller did not "
    "ask. Whitespace runs are collapsed, so an empty or whitespace-only value is treated as no "
    "filter and clearing the search box does not add a predicate that matches everything."
)
"""The bound and normalisation sentence appended to each ``q`` description below."""


# ---------------------------------------------------------------------------------------
# Path parameters
#
# One alias per family rather than a repeated inline `Annotated[...]`, so the description a
# client reads in `/openapi.json` is written once per identifier and cannot drift between the
# PATCH and the DELETE that address the same row. Private, because `router` is this module's
# entire public surface.
#
# Each is `uuid.UUID`, never `str`: the parsing happens in the framework, so a malformed
# identifier is the standard 422 problem document before any handler is entered and before
# any query is issued. No identifier in this API is client-supplied - every one of them is
# generated by `gen_random_uuid()` - which is what retires the defect class the previous
# contract carried, where a client chose its own key and a duplicate permanently shadowed
# every later record.
# ---------------------------------------------------------------------------------------

_UserIdPath = Annotated[
    uuid.UUID,
    Path(description="Server-generated identifier of the account being acted on."),
]

_PostIdPath = Annotated[
    uuid.UUID,
    Path(description="Server-generated identifier of the post being acted on."),
]

_CommentIdPath = Annotated[
    uuid.UUID,
    Path(description="Server-generated identifier of the comment being acted on."),
]

_CategoryIdPath = Annotated[
    uuid.UUID,
    Path(description="Server-generated identifier of the category being acted on."),
]


router = APIRouter()
"""The administrative router, bare by design and constructed with no arguments.

No path prefix, no OpenAPI tag and no router-level dependency list. ``app.api.v1.router``
supplies all three on the one call that includes this object - the ``/admin`` segment, the
``admin`` tag and the administrator gate - so the version namespace, the documentation
grouping and the authority requirement are each written exactly once, in one file, for every
operation below.

Bound as ``admin.router``. Read "Where the administrator gate is, and why it is not in this
file" in the module docstring before adding anything to this object.
"""


# ---------------------------------------------------------------------------------------
# Overview
# ---------------------------------------------------------------------------------------


@router.get(
    "/stats",
    response_model=AdminStats,
    status_code=status.HTTP_200_OK,
    responses=_GATE_RESPONSES,
    summary="Aggregate counts for the overview screen",
    description=(
        "Returns one tally per managed entity - accounts, posts, comments and categories - "
        "for the four tiles the administrative overview renders. Each is a dedicated `COUNT` "
        "issued against its own relation; none is obtained by measuring the length of a "
        "listing. Every tally spans the whole relation and is not narrowed by lifecycle "
        "state, so `post_count` includes drafts and archived posts and `comment_count` "
        "includes comments still awaiting moderation - which is what an operator wants from "
        "an overview, since a queue you cannot see the size of is a queue you will not work."
    ),
)
async def get_stats(db: DbSession, actor: AdminPrincipal) -> AdminStats:
    """Return the four counts the administrative overview screen renders.

    Args:
        db: The request-scoped session, from :data:`~app.core.dependencies.DbSession`.
        actor: The administrator principal. Required because every method on
            :class:`~app.services.admin_service.AdminService` re-checks authority against the
            loaded row rather than trusting the mount alone.

    Returns:
        The four aggregates, as :class:`~app.schemas.admin.AdminStats`.

    Note:
        The counting is the service's, and deliberately so. Deriving these four numbers here
        would mean calling the four list methods and taking their lengths, which fetches every
        row in the database in order to discard all of them - and would report the size of one
        page rather than of the relation, since every listing in this API is windowed.
    """
    return await AdminService(db).get_stats(actor=actor)


# ---------------------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------------------


@router.get(
    "/users",
    response_model=Page[AdminUser],
    status_code=status.HTTP_200_OK,
    responses=_GATE_RESPONSES | _UNPROCESSABLE_RESPONSE,
    summary="List accounts",
    description=(
        "Windows the account table for the users management screen. The three filters "
        "compose, and `total` counts the filtered set rather than the whole relation, so the "
        "page controls describe the result actually on screen. The item type carries `email`, "
        "`role` and `is_active`, which the public user projection withholds; it carries no "
        "password hash, which no projection in this service does. A page past the last one is "
        "not an error - it returns an empty `items` list beside the real `pages`."
    ),
)
async def list_users(
    db: DbSession,
    actor: AdminPrincipal,
    page: PageParamsDep,
    q: Annotated[
        SearchTerm,
        Query(
            description=(
                "Free-text term matched against the username and the email address.\n\n"
                + _SEARCH_TERM_BOUND
            ),
        ),
    ] = None,
    role: Annotated[
        UserRole | None,
        Query(description="Exact authority filter - for example, show only administrators."),
    ] = None,
    is_active: Annotated[
        bool | None,
        Query(
            description=(
                "Exact activity filter. `false` is meaningful rather than merely falsy here: "
                "showing the suspended accounts is the reason the filter exists."
            ),
        ),
    ] = None,
) -> Page[AdminUser]:
    """Return one page of accounts, narrowed by the filters the caller supplied.

    Args:
        db: The request-scoped session.
        actor: The administrator principal.
        page: The validated window, from :data:`~app.core.dependencies.PageParamsDep`. Its
            bounds - a 1-based page and a page size of 1 to 100 - are enforced before this
            function is entered, so nothing is validated here.
        q: Optional free-text term over username and email, or ``None`` for no term.
        role: Optional exact role filter, or ``None`` for every role.
        is_active: Optional exact activity filter, or ``None`` for both states.

    Returns:
        The one page envelope every collection in this API returns - ``items``, ``total``,
        ``page``, ``page_size``, ``pages`` - with :class:`~app.schemas.admin.AdminUser` items.

    Note:
        ``role`` is typed with :class:`~app.models.user.UserRole` from the ``app.models``
        barrel rather than with a string, so the enumeration published in ``/openapi.json`` is
        the same declaration the database column persists. A hand-written set of role strings
        here would be a second source of truth, and the two would disagree the first time a
        role was added on one side only.
    """
    return await AdminService(db).list_users(
        actor=actor,
        q=q,
        role=role,
        is_active=is_active,
        page=page.page,
        page_size=page.page_size,
    )


@router.patch(
    "/users/{user_id}",
    response_model=AdminUser,
    status_code=status.HTTP_200_OK,
    responses=(
        _GATE_RESPONSES | _NOT_FOUND_RESPONSE | _CONFLICT_RESPONSE | _UNPROCESSABLE_RESPONSE
    ),
    summary="Change an account's role or active state",
    description=(
        "A genuine partial update: only the members actually sent are applied, so promoting "
        "an account and suspending one are independent operations that happen to share a "
        "route, and an empty body is an accepted no-op. Omission is how 'unchanged' is "
        "expressed - an explicit `null` is rejected with 422 rather than written to a "
        "non-nullable column. Nothing else about an account is settable here: not the email "
        "address, not the username, not the password. This is also the only path to `ADMIN` "
        "in the product, since registration always grants `AUTHOR`. An administrator may not "
        "demote or deactivate their **own** account; that attempt is a 409, because it is a "
        "lockout guard rather than a statement about their authority."
    ),
)
async def update_user(
    user_id: _UserIdPath,
    payload: AdminUserUpdate,
    db: DbSession,
    actor: AdminPrincipal,
) -> AdminUser:
    """Apply a role change, an activity change, or both, to one account.

    Args:
        user_id: The account's server-generated identifier, from the path.
        payload: The validated body. ``role`` and ``is_active`` are both optional.
        db: The request-scoped session.
        actor: The administrator principal, passed through to the service as ``actor`` so its
            self-demotion and self-deactivation guard can fire. That guard is the reason this
            parameter is declared rather than the gate being restated: the rule is "may not
            act on *themselves*", which is unanswerable without knowing who is acting.

    Returns:
        The updated account, projected through :class:`~app.schemas.admin.AdminUser`.

    Note:
        The guard lives in the service, and there is no role comparison in this function. An
        administrator locking themselves out of the namespace is the one irreversible mistake
        this screen can make - there is no second administrator by construction, and no
        self-service route back - so the rule is enforced where it cannot be bypassed by
        another caller rather than in the handler that happens to be in front of it today.
    """
    return AdminUser.model_validate(
        await AdminService(db).update_user(user_id, payload, actor=actor)
    )


@router.delete(
    "/users/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    responses=(
        _GATE_RESPONSES | _NOT_FOUND_RESPONSE | _CONFLICT_RESPONSE | _UNPROCESSABLE_RESPONSE
    ),
    summary="Delete an account",
    description=(
        "Removes the account and, by `ON DELETE CASCADE`, everything referencing it: its "
        "posts, its comments, its likes and its refresh tokens. Irreversible, and far blunter "
        "than it looks - deleting a prolific author erases their articles from the site. "
        "Setting `is_active` to `false` through `PATCH /api/v1/admin/users/{user_id}` is the "
        "reversible alternative and is the tool to reach for first. An administrator may not "
        "delete their **own** account; that attempt is a 409. Answers 204 with no body."
    ),
    response_description="The account and everything cascading from it were removed.",
)
async def delete_user(user_id: _UserIdPath, db: DbSession, actor: AdminPrincipal) -> None:
    """Delete one account, letting the database cascade remove what referenced it.

    Args:
        user_id: The account's server-generated identifier, from the path.
        db: The request-scoped session.
        actor: The administrator principal, passed through so the service can refuse a
            self-deletion and attribute the action in its audit record.

    Returns:
        ``None``. The route answers 204, so there is no body to model and none is produced.

    Note:
        Nothing is deleted in Python. The posts, comments, likes and refresh tokens go with
        the row because ``ON DELETE CASCADE`` is declared on each foreign key that points at
        it, which is one statement in the database rather than four loops in the application -
        and cannot leave an orphan behind if an intermediate step fails.
    """
    await AdminService(db).delete_user(user_id, actor=actor)


# ---------------------------------------------------------------------------------------
# Posts
# ---------------------------------------------------------------------------------------


@router.get(
    "/posts",
    response_model=Page[AdminPost],
    status_code=status.HTTP_200_OK,
    responses=_GATE_RESPONSES | _UNPROCESSABLE_RESPONSE,
    summary="List posts across every lifecycle state",
    description=(
        "The one listing in this API that spans `DRAFT`, `PUBLISHED` and `ARCHIVED`, and that "
        "reach is the reason the screen exists: a moderator who can see only what a reader can "
        "see cannot moderate. Every public surface - the home feed, a category filter, an "
        "author profile - narrows itself to published posts, so a draft visible here is "
        "correctly absent from all of them. Ordered by recency rather than by relevance, "
        "because a management table is scanned for what changed rather than read as a feed; "
        "the ordering is total, so paging is stable and no row appears on two pages. Items "
        "carry no body content or excerpt - this table lists and acts on posts, it does not "
        "render them."
    ),
)
async def list_posts(
    db: DbSession,
    actor: AdminPrincipal,
    page: PageParamsDep,
    q: Annotated[
        SearchTerm,
        Query(
            description="Search term - ranked full-text matching over title, excerpt and body, "
            "combined with typo-tolerant matching on the title.\n\n" + _SEARCH_TERM_BOUND
        ),
    ] = None,
    post_status: Annotated[
        PostStatus | None,
        Query(
            alias="status",
            description=(
                "Single lifecycle state, for a per-status tab. Omit it to span every state, "
                "which is this listing's default and its purpose."
            ),
        ),
    ] = None,
    author_id: Annotated[
        uuid.UUID | None,
        Query(
            description=(
                "Restrict the listing to one author's posts. Taken as an identifier rather "
                "than a username because this surface addresses accounts by key."
            ),
        ),
    ] = None,
) -> Page[AdminPost]:
    """Return one page of posts in any lifecycle state, narrowed by the supplied filters.

    Args:
        db: The request-scoped session.
        actor: The administrator principal.
        page: The validated window.
        q: Optional search term, or ``None`` for no term.
        post_status: Optional single-state filter, or ``None`` for every state. Named
            ``post_status`` in Python and exposed to clients as ``status`` through the
            ``alias``, so the wire contract reads naturally while the local name does not
            shadow the imported ``fastapi.status`` module that every decorator above uses.
        author_id: Optional restriction to one author, or ``None`` for every author.

    Returns:
        The one page envelope, with :class:`~app.schemas.admin.AdminPost` items.

    Note:
        The breadth is the service's decision, not this function's, and it is expressed as the
        *absence* of a predicate rather than as an enumeration: when no state was named
        ``AdminService.list_posts`` passes ``statuses=None``, which is the repository's spelling
        for "do not filter on status at all". So a fourth state added to the enumeration appears
        here without an edit to this file or to the service - and cannot fail to, because there
        is no list for it to be missing from. Bypassing the public status scope is safe only
        because the surface is gated, which is why the reach lives behind an authority check
        rather than behind a query parameter.
    """
    return await AdminService(db).list_posts(
        actor=actor,
        q=q,
        status=post_status,
        author_id=author_id,
        page=page.page,
        page_size=page.page_size,
    )


@router.patch(
    "/posts/{post_id}/status",
    response_model=AdminPost,
    status_code=status.HTTP_200_OK,
    responses=_GATE_RESPONSES | _NOT_FOUND_RESPONSE | _UNPROCESSABLE_RESPONSE,
    summary="Force a post into a lifecycle state",
    description=(
        "The administrative counterpart to an author's own publish and unpublish transitions, "
        "and the only way to reach `ARCHIVED` - withdrawing a post without destroying it is a "
        "moderation decision, and a deliberately reversible one. Applies to any author's post; "
        "ownership is not a route to this operation. Publishing stamps the publication instant "
        "when the post has never been public and preserves an existing one otherwise, so "
        "republishing an archived article does not move a months-old piece to the top of the "
        "home page. Setting the state a post is already in is an accepted no-op, which makes "
        "the route safe to retry."
    ),
)
async def set_post_status(
    post_id: _PostIdPath,
    payload: AdminPostStatusUpdate,
    db: DbSession,
    actor: AdminPrincipal,
) -> AdminPost:
    """Move one post to the lifecycle state the body names.

    Args:
        post_id: The post's server-generated identifier, from the path.
        payload: The validated body carrying the destination ``status``, which is required -
            "change the status" with no destination is not a request.
        db: The request-scoped session.
        actor: The administrator principal, passed through so the service can attribute the
            transition in its audit record.

    Returns:
        The post in its new state, projected through :class:`~app.schemas.admin.AdminPost`
        with its byline already loaded by the service.

    Note:
        The publication instant is not written here and the database invariant is not asserted
        here. ``ck_posts_published_at_required`` - ``CHECK (status <> 'PUBLISHED' OR
        published_at IS NOT NULL)`` - is upheld by the service, which writes the instant and
        the state adjacently and in that order, so the constraint cannot be reached by this
        path even in principle. Re-checking it in Python would be a second, weaker copy of a
        guarantee the schema already makes unconditionally.
    """
    return AdminPost.model_validate(
        await AdminService(db).set_post_status(post_id, payload, actor=actor)
    )


@router.delete(
    "/posts/{post_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    responses=_GATE_RESPONSES | _NOT_FOUND_RESPONSE | _UNPROCESSABLE_RESPONSE,
    summary="Delete a post",
    description=(
        "Removes any author's post and, by `ON DELETE CASCADE`, every comment and like it "
        "carried. Irreversible: moving the post to `ARCHIVED` through "
        "`PATCH /api/v1/admin/posts/{post_id}/status` withdraws it from every public surface "
        "while keeping the content and the discussion, and is the tool to reach for first. "
        "Answers 204 with no body."
    ),
    response_description="The post, its comments and its likes were removed.",
)
async def delete_post(post_id: _PostIdPath, db: DbSession, actor: AdminPrincipal) -> None:
    """Delete one post, letting the database cascade remove its discussion.

    Args:
        post_id: The post's server-generated identifier, from the path.
        db: The request-scoped session.
        actor: The administrator principal, passed through for the audit record.

    Returns:
        ``None``. The route answers 204, so there is no body.

    Note:
        No comment and no like is deleted in Python. Both relations declare
        ``ON DELETE CASCADE`` on their reference to the post, so the removal is atomic with
        the post's own - which is the property a loop in the application cannot offer.
    """
    await AdminService(db).delete_post(post_id, actor=actor)


# ---------------------------------------------------------------------------------------
# Comments
# ---------------------------------------------------------------------------------------


@router.get(
    "/comments",
    response_model=Page[AdminComment],
    status_code=status.HTTP_200_OK,
    responses=_GATE_RESPONSES | _UNPROCESSABLE_RESPONSE,
    summary="List comments across every moderation state",
    description=(
        "The moderation queue. Spans `PENDING`, `APPROVED` and `REJECTED` across every post, "
        "where the public thread on a post shows approved comments only - so a comment "
        "awaiting a decision is visible here and nowhere else. Filter by state to work the "
        "queue, or by post to review one discussion. Each item carries the comment body, its "
        "author's public byline, the post it belongs to and the parent it replies to, which is "
        "enough to judge it without opening the article."
    ),
)
async def list_comments(
    db: DbSession,
    actor: AdminPrincipal,
    page: PageParamsDep,
    comment_status: Annotated[
        CommentStatus | None,
        Query(
            alias="status",
            description=(
                "Single moderation state - `PENDING` is the queue an operator works. Omit it "
                "to span every state."
            ),
        ),
    ] = None,
    q: Annotated[
        SearchTerm,
        Query(
            description="Free-text term matched against the comment body.\n\n" + _SEARCH_TERM_BOUND
        ),
    ] = None,
    post_id: Annotated[
        uuid.UUID | None,
        Query(description="Restrict the queue to the comments on one post."),
    ] = None,
) -> Page[AdminComment]:
    """Return one page of the moderation queue, narrowed by the supplied filters.

    Args:
        db: The request-scoped session.
        actor: The administrator principal.
        page: The validated window.
        comment_status: Optional single moderation state, or ``None`` for every state. Named
            ``comment_status`` locally and exposed as ``status`` through the ``alias``, for the
            same reason as on the post listing: the module-level ``fastapi.status`` import must
            not be shadowed inside a handler.
        q: Optional free-text term over the comment body, or ``None`` for no term.
        post_id: Optional restriction to one post's thread, or ``None`` for every post.

    Returns:
        The one page envelope, with :class:`~app.schemas.admin.AdminComment` items.
    """
    return await AdminService(db).list_comments(
        actor=actor,
        status=comment_status,
        q=q,
        post_id=post_id,
        page=page.page,
        page_size=page.page_size,
    )


@router.patch(
    "/comments/{comment_id}/status",
    response_model=AdminComment,
    status_code=status.HTTP_200_OK,
    responses=_GATE_RESPONSES | _NOT_FOUND_RESPONSE | _UNPROCESSABLE_RESPONSE,
    summary="Approve or reject a comment",
    description=(
        "The **only** route in this API that changes a comment's moderation state, and "
        "therefore the only way a comment becomes publicly visible: the public comment routes "
        "expose the state read-only, and an author editing their own comment cannot alter it. "
        "Approving publishes the comment into its thread; rejecting withdraws it while keeping "
        "the record, so a decision can be revisited. Setting the state a comment is already in "
        "is an accepted no-op."
    ),
)
async def set_comment_status(
    comment_id: _CommentIdPath,
    payload: AdminCommentStatusUpdate,
    db: DbSession,
    actor: AdminPrincipal,
) -> AdminComment:
    """Move one comment to the moderation state the body names.

    Args:
        comment_id: The comment's server-generated identifier, from the path.
        payload: The validated body carrying the destination ``status``, which is required.
        db: The request-scoped session.
        actor: The administrator principal, passed through so the moderation trail records who
            decided.

    Returns:
        The comment in its new state, projected through
        :class:`~app.schemas.admin.AdminComment` with its byline already loaded.

    Note:
        The transition itself is not written here and is not reimplemented here.
        ``AdminService`` delegates to ``CommentService.set_status``, which takes the row's
        lock, captures the previous state for the audit line and writes the column - so
        moderation policy is declared exactly once even though two services can reach it.
        Writing the column from this handler would be a second policy that agreed with the
        first only until one of them was edited.
    """
    return AdminComment.model_validate(
        await AdminService(db).set_comment_status(comment_id, payload, actor=actor)
    )


@router.delete(
    "/comments/{comment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    responses=_GATE_RESPONSES | _NOT_FOUND_RESPONSE | _UNPROCESSABLE_RESPONSE,
    summary="Delete a comment",
    description=(
        "Removes the comment and, by `ON DELETE CASCADE` on the self-referencing parent, every "
        "reply beneath it - so deleting the root of a thread deletes the thread. Irreversible: "
        "rejecting the comment through `PATCH /api/v1/admin/comments/{comment_id}/status` "
        "withdraws it from the public thread while keeping the record, and is the tool to reach "
        "for first. Answers 204 with no body."
    ),
    response_description="The comment and every reply beneath it were removed.",
)
async def delete_comment(comment_id: _CommentIdPath, db: DbSession, actor: AdminPrincipal) -> None:
    """Delete one comment, letting the database cascade remove its replies.

    Args:
        comment_id: The comment's server-generated identifier, from the path.
        db: The request-scoped session.
        actor: The administrator principal, passed through for the audit record.

    Returns:
        ``None``. The route answers 204, so there is no body.

    Note:
        The replies go with it because ``comments.parent_id`` declares
        ``ON DELETE CASCADE`` against ``comments.id``. Nothing here walks the thread, which
        also means an arbitrarily deep thread costs one statement rather than one per level.
    """
    await AdminService(db).delete_comment(comment_id, actor=actor)


# ---------------------------------------------------------------------------------------
# Categories
#
# Three routes, and exactly the three the AAP's REST surface declares (§0.6.2): create, rename
# and delete. There is deliberately no administrative LISTING of categories, and that omission is
# the design rather than a gap. The taxonomy is small, bounded reference data, and the public
# `GET /api/v1/categories` already returns it whole - every term, ascending by name, each with the
# `post_count` a reader sees - so the management screen reads the same array the home page filter
# reads and no privileged listing has to exist. Adding one would put a thirty-eighth operation on
# a thirty-seven-operation surface, and a second definition of "a page of categories" behind it.
#
# There is deliberately no administrative PROJECTION of a category either, and none is needed: a
# category has no private member - no owner, no address, no credential, no moderation state - so
# `CategoryPublic` already carries everything this screen shows. That is why `app.schemas.admin`
# declares no category output type and these routes name the public model.
#
# The two inputs are `CategoryCreate` and `CategoryUpdate` from `app.schemas.category`, reached
# through the barrel and deliberately not re-declared as administrative variants: one wire
# format deserves one description, and `app.schemas.admin` re-exports these two rather than
# restating them for exactly that reason. Neither accepts an identifier or a slug, because both
# are the server's to generate.
# ---------------------------------------------------------------------------------------


@router.post(
    "/categories",
    response_model=CategoryPublic,
    status_code=status.HTTP_201_CREATED,
    responses=_GATE_RESPONSES | _CONFLICT_RESPONSE | _UNPROCESSABLE_RESPONSE,
    summary="Create a category",
    description=(
        "Categories are administrative reference data, so this is the only path to creating "
        "one - there is no self-service route, and an author files a post under existing terms "
        "rather than inventing them. The body carries a name and, optionally, a description. "
        "The identifier and the URL-safe slug are both generated server-side; supplying either "
        "is a 422. A name already in use is a 409. A **name whose derived slug collides** with "
        "an existing one is not: the slug is de-duplicated with a deterministic ascending "
        "suffix - `python`, `python-2`, `python-3` - so the request succeeds and the response "
        "carries the slug that was actually assigned. That holds under concurrency too: a slug "
        "claimed by another writer between derivation and insert is re-derived and retried, so "
        "the only slug-shaped 409 is sustained contention on one family - and its detail says to "
        "retry, not to rename. Read `slug` from the response rather than deriving it "
        "client-side. The new category's `post_count` is `0`, since nothing has been filed under "
        "it yet."
    ),
    response_description="The category was created, with its generated identifier and slug.",
)
async def create_category(
    payload: CategoryCreate,
    db: DbSession,
    actor: AdminPrincipal,
) -> CategoryPublic:
    """Create one category from a name and an optional description.

    Args:
        payload: The validated body - ``name``, and optionally ``description``.
        db: The request-scoped session.
        actor: The administrator principal, passed through for the audit record.

    Returns:
        The persisted category as :class:`~app.schemas.category.CategoryPublic` - the same
        model the public taxonomy endpoints return, so the administrative screen and the home
        page filter agree on what a category looks like down to the meaning of ``post_count``.

    Note:
        No slug is derived here. ``AdminService`` delegates to ``CategoryService.create``, which
        normalises the name, issues the one indexed query that reveals which members of that
        slug family already exist, and applies a deterministic collision suffix. A canonical
        address is precisely the thing that must have exactly one policy, so deriving a slug in
        this handler would be the second - and the two would disagree on the first collision.

        That suffix is why a colliding slug is **not** a conflict here, and the distinction is
        deliberate rather than incidental: the unique constraint on ``categories.name`` is what
        this route reports as a 409, while two different names that happen to normalise to one
        slug - ``Machine Learning`` and ``machine learning`` - are both legitimate labels and are
        given distinct addresses instead of one being refused. A client must therefore read
        ``slug`` from the response rather than deriving it from the name it sent.
    """
    return await AdminService(db).create_category(payload, actor=actor)


@router.patch(
    "/categories/{category_id}",
    response_model=CategoryPublic,
    status_code=status.HTTP_200_OK,
    responses=(
        _GATE_RESPONSES | _NOT_FOUND_RESPONSE | _CONFLICT_RESPONSE | _UNPROCESSABLE_RESPONSE
    ),
    summary="Rename a category or edit its description",
    description=(
        "A genuine partial update: only the members actually sent are applied, and an empty "
        "body is an accepted no-op. An explicit `null` description is honoured as an "
        "instruction to clear it. **The slug deliberately does not change on a rename** - it is "
        "the canonical URL a reader has bookmarked, the sitemap has published and a search "
        "engine has indexed, so re-deriving it would break all three in exchange for a tidier "
        "address. A name already held by a different category is a 409."
    ),
)
async def update_category(
    category_id: _CategoryIdPath,
    payload: CategoryUpdate,
    db: DbSession,
    actor: AdminPrincipal,
) -> CategoryPublic:
    """Apply a name change, a description change, or both, to one category.

    Args:
        category_id: The category's server-generated identifier, from the path.
        payload: The validated body. ``name`` and ``description`` are both optional.
        db: The request-scoped session.
        actor: The administrator principal, passed through for the audit record.

    Returns:
        The updated category as :class:`~app.schemas.category.CategoryPublic`, its ``slug``
        unchanged and its ``post_count`` the current published tally.

    Note:
        Nothing here "helpfully" re-derives the slug from the new name. That decision belongs
        to ``CategoryService.update`` and is recorded there; restating it - in either
        direction - would put a second URL policy in the codebase.
    """
    return await AdminService(db).update_category(category_id, payload, actor=actor)


@router.delete(
    "/categories/{category_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    responses=(
        _GATE_RESPONSES | _NOT_FOUND_RESPONSE | _CONFLICT_RESPONSE | _UNPROCESSABLE_RESPONSE
    ),
    summary="Delete a category",
    description=(
        "Refused with 409 while at least one post is still filed under the category; re-file "
        "or remove those posts first. The guard exists because the association carries "
        "`ON DELETE CASCADE`, so without it the delete would succeed and silently take every "
        "filing with it - a post would lose a category with nothing failing and nobody told. A "
        "category that no post references is removed. Answers 204 with no body."
    ),
    response_description="The category was removed. No post referenced it.",
)
async def delete_category(
    category_id: _CategoryIdPath,
    db: DbSession,
    actor: AdminPrincipal,
) -> None:
    """Delete one category, subject to the service's in-use guard.

    Args:
        category_id: The category's server-generated identifier, from the path.
        db: The request-scoped session.
        actor: The administrator principal, passed through for the audit record.

    Returns:
        ``None``. The route answers 204, so there is no body.

    Note:
        The in-use question is asked once, under the row's lock, by
        ``CategoryService.delete`` - which is what closes the window in which a concurrent
        filing could slip between the check and the delete. Asking it from this handler instead
        would reproduce the check without the lock, which is a guard in appearance only.
        "Does not exist" is resolved before "may not be deleted yet", so a 404 and a 409 are
        never confused for one another.
    """
    await AdminService(db).delete_category(category_id, actor=actor)
