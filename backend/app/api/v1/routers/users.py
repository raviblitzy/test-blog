"""The author-profile surface: one public identity read, one public listing, one self-update.

Three operations, mounted by ``app.api.v1.router`` under ``/users``:

===================================  ======  ==============================================
``PATCH  /api/v1/users/me``          bearer  Update the principal's own display name, bio
                                             and avatar. Returns ``UserMe``.
``GET    /api/v1/users/{username}``  public  The author's public profile. Returns
                                             ``UserPublic``.
``GET    /api/v1/users/{username}/posts``
                                     public  That author's **published** posts, windowed.
                                             Returns ``Page[PostSummary]``.
===================================  ======  ==============================================

Together they discharge "include user profiles showing published articles" and the
self-service half of the identity requirement. The client consumes the first from its
account settings form and the other two from ``/u/[username]``, which is a crawled,
linkable, server-rendered route - which is why the listing below is the strictest surface
in this API.

Two confidentiality boundaries, both enforced by choosing a symbol
-----------------------------------------------------------------
Neither is enforced by a conditional here, and that is the point: a boundary expressed as a
branch is a boundary that can be got wrong on one path, and a reviewer has to read the
branch to see where it lies. Both are visible in a decorator or a method name instead.

1. **The public read returns** :class:`~app.schemas.user.UserPublic`, **never**
   :class:`~app.schemas.user.UserMe` **or** ``AdminUser``. ``UserPublic`` publishes ``id``,
   ``username``, ``display_name``, ``bio``, ``avatar_url`` and ``created_at``, and withholds
   ``password_hash``, ``email``, ``is_active`` and ``role``. Substituting either wider
   projection would hand the email address and the role of every author in the product to
   every anonymous visitor, from a route that needs no credential. ``UserMe`` is returned
   from exactly one operation - ``PATCH /me`` - where the caller has already proved the
   record is their own.

2. **The listing calls** :meth:`~app.services.profile_service.ProfileService.list_published_posts`,
   **never the feed's own composition.** ``PUBLIC_PROFILE_STATUSES`` is a module constant in
   that service - ``(PostStatus.PUBLISHED,)`` - and the method exposes no parameter through
   which any caller could widen it. See "The filter is unconditional" below.

The ``/me`` ordering hazard
---------------------------
``PATCH "/me"`` is declared **first in this module, above both parameterised routes**, and
the ordering is load-bearing rather than cosmetic. Starlette matches routes in registration
order and returns the first path whose pattern accepts the URL, so a route registered as
``/{username}`` ahead of a literal ``/me`` would swallow ``me`` as a username value and the
literal route would become unreachable - silently, with a 404 from the profile lookup and no
error anywhere to explain it.

Strictly, that collision bites only within one HTTP method, and today the only parameterised
routes here are ``GET``. So the current file would behave identically in any order. It is
still written this way, because the ordering is what keeps the file correct the day someone
adds ``GET /me`` or a parameterised ``PATCH`` - and on that day the defect would present as
a route that "does not work" rather than as an obvious mistake in a diff. Declaring literal
segments before parameterised ones costs nothing now and removes the trap in advance.

The filter is unconditional
---------------------------
``GET /{username}/posts`` declares **no** ``status`` query parameter, **no**
``include_drafts`` flag and **no** principal - not even an optional one. There is deliberately
no way to widen what it returns, for any caller, ever: an administrator sees the same page an
anonymous crawler sees, and so does the author.

That is stricter than the feed at ``GET /api/v1/posts``, which does widen for a known caller,
and the asymmetry is intentional. A profile is a public, crawled, cacheable, shareable
surface, and "a draft never appears on a public profile" is a blocking acceptance criterion
for this product rather than a preference. A hard-coded status set cannot leak a draft through
a mistake in a visibility predicate, because there is no predicate to get wrong. An author who
wants to see their own drafts asks the feed for them, authenticated, at
``GET /api/v1/posts?author=<username>``.

The same reasoning explains the absence of :data:`~app.core.dependencies.OptionalUser` from
this module. A dependency that resolved the caller would put a principal in scope on a route
whose answer must not depend on one, and the next edit would be the one that used it.

Layering
--------
No data access, of any kind. No statement is constructed here, nothing is executed or fetched
on the injected session, no mapped model is referenced, and the repository package is never
imported - username resolution reaches the ``CITEXT UNIQUE`` index on ``users.username``
through ``UserRepository``, which only ``ProfileService`` holds. Each of the three handlers is
a single expression delegating to one service method; anything that would need a branch here
is a rule, and a rule belongs in ``ProfileService`` where it can be unit-tested without an
HTTP request.

This is checkable mechanically, and is meant to be: a search of this file for the vocabulary
of data access, of the framework's own error type, of an inline schema declaration or of a
router-level prefix or tag argument returns nothing at all - not even inside these
paragraphs, which is why the prose above describes those constructs rather than spelling any
of them out.

The username is passed through exactly as the URL supplied it. Nothing here lower-cases or
otherwise normalises it, because ``users.username`` is ``CITEXT``: the index itself resolves
``/u/Alice`` and ``/u/alice`` to one account. Folding the case in Python would duplicate a
guarantee the database already makes, and would then have to be kept in step with it.

A bare router
-------------
``router = APIRouter()`` takes no ``prefix``, no ``tags`` and no router-level
``dependencies``. ``app.api.v1.router`` supplies the prefix and the OpenAPI tag on its
``include_router`` call and ``app.main`` mounts the aggregate at ``/api/v1``, so the string
``/api/v1/users`` appears in no decorator in this file and no route here can escape the
version namespace by forgetting it.

There is deliberately **no route that lists users.** Enumerating accounts is an
administrative operation, available at ``GET /api/v1/admin/users`` behind
``require_admin``; an unprivileged directory of every account would be a harvesting surface
offered to anyone who found the path.

Errors
------
No handler in this module raises. ``ProfileService`` raises
:class:`~app.core.exceptions.NotFoundError` for an unclaimed **or deactivated** handle, the
credential dependencies raise :class:`~app.core.exceptions.UnauthorizedError`, and the
handlers registered by ``app.core.exceptions`` render every one of them as the single
problem document this API returns for every failure. The service this repository grew out of
did the opposite: three of its five handlers each raised the framework's own error type
directly, with the status ``404`` and the detail ``Item not found`` written out
independently in all three, so one failure had three definitions that could drift apart. That
pattern is declared once now, in one place, and none of it recurs here.

Nothing is logged. ``app.middleware.request_context`` already emits one structured record
per request carrying the path, the status code and the bound ``request_id``, so a 404 from a
profile lookup is observable with its correlation identifier without this module holding a
logger of its own - and a line on the happy path would be a line on every profile view in
the product.
"""

from typing import Annotated, Final

from fastapi import APIRouter, Path, status

from app.core.dependencies import CurrentUser, DbSession, PageParamsDep
from app.schemas import (
    Page,
    PostSummary,
    ProblemResponses,
    UserMe,
    UserPublic,
    UserUpdate,
    problem_response,
)
from app.schemas.common import StorableText
from app.services import ProfileService

__all__ = ["router"]


# ---------------------------------------------------------------------------------------
# The router
#
# Bare, and checked as such: no `prefix`, no `tags`, no router-level `dependencies`. See
# "A bare router" in the module docstring - `app.api.v1.router` owns all three.
# ---------------------------------------------------------------------------------------

router = APIRouter()


# ---------------------------------------------------------------------------------------
# The shared path parameter
#
# Declared once and referenced by both public reads, so the two halves of one profile
# cannot end up documenting their own address differently.
#
# It carries a description and ONE rule. A `min_length` or `max_length` here would look
# harmless and would change the contract: an over-long handle would be answered 422 by the
# framework before the route is entered, where both routes below document 404 - and 404 is
# the honest answer, because an unclaimable handle is precisely a handle nobody holds.
# Length is a property of what may be REGISTERED, enforced where registration happens; a
# lookup only ever needs to report presence or absence.
#
# `StorableText` is the exception, and it is not a length rule in disguise. A NUL character is
# not an unclaimable handle - it is a value the comparison itself cannot be performed on, since
# `CITEXT` cannot represent it, so psycopg refused to bind it and the read became a 500 that any
# anonymous caller could provoke at will. Refusing it here answers 422 naming `username`, which
# is the framework's own report for a parameter it cannot accept, and it is the reason the 422
# both routes declare is now reachable rather than theoretical.
# ---------------------------------------------------------------------------------------

_UsernamePath = Annotated[
    str,
    Path(
        description=(
            "The author's handle, exactly as it appears in the profile URL. Matched "
            "case-insensitively - `Alice` and `alice` address the same account - because "
            "`users.username` is a `CITEXT UNIQUE` column, so the index performs the fold "
            "and no case is canonical. A handle nobody holds answers 404; the one value "
            "refused as 422 instead is one carrying a NUL character, which no `CITEXT` "
            "column can hold and which therefore cannot be compared against a stored one."
        ),
        examples=["example-reader"],
    ),
    StorableText,
]


# ---------------------------------------------------------------------------------------
# Documented failure modes
#
# Module constants rather than dict literals inside the decorators, and every one of them
# built by `app.schemas.common.problem_response`: that helper names the model - which is
# what puts each failure body into the generated document, so a client generator emits a type
# for it instead of leaving the error path untyped - and it is the single place the published
# error media type is decided.
#
# One error shape throughout, because there is exactly one in this API. The 422 entries
# deliberately override the framework's own `HTTPValidationError`: this service registers a
# `RequestValidationError` handler that renders a validation failure as the same problem
# document, with per-field detail under `errors`, so the default schema would document a body
# it never emits. `GET /{username}` declares one for a single reachable case - a handle carrying
# a NUL character, which no `CITEXT` column can hold - see the entry's own note.
#
# 403 belongs to `PATCH /me` alone. It resolves `CurrentUser`, which refuses a DEACTIVATED
# principal before the handler is entered; the two profile reads resolve no principal at all,
# so neither an authority check nor a credential rejection is reachable on them.
# ---------------------------------------------------------------------------------------

_SELF_UPDATE_RESPONSES: Final[ProblemResponses] = {
    status.HTTP_401_UNAUTHORIZED: problem_response(
        "No usable credential was presented, or the one presented was malformed, "
        "expired or of the wrong type. `type` is `/errors/unauthorized` and the "
        "response carries a `WWW-Authenticate: Bearer` challenge. This route has no "
        "anonymous behaviour to fall back on: the record being edited is identified by "
        "the credential itself."
    ),
    status.HTTP_403_FORBIDDEN: problem_response(
        "The credential is genuine but the account has been deactivated, so it holds no "
        "authority - not even over itself. `type` is `/errors/forbidden`. This is the only "
        "state that produces it here: there is no path parameter and no identifier in the "
        "body, so the record being written is always the caller's own and no ownership "
        "comparison exists to fail. Re-authenticating will not clear it; an administrator "
        "must reactivate the account."
    ),
    status.HTTP_422_UNPROCESSABLE_CONTENT: problem_response(
        "The body did not validate. `type` is `/errors/validation-error` and `errors` "
        "names each rejected member. Reached by a value out of range - a blank "
        "`display_name`, an `avatar_url` that is not an absolute http(s) URL, an "
        "explicit `display_name: null` - and equally by any member the schema does not "
        "declare: `UserUpdate` forbids unknown members, so a body proposing `role`, "
        "`is_active`, `email`, `username` or `id` is rejected here rather than being "
        "quietly discarded."
    ),
}

_PROFILE_RESPONSES: Final[ProblemResponses] = {
    status.HTTP_404_NOT_FOUND: problem_response(
        "No visible account holds this handle. `type` is `/errors/not-found`. An "
        "unclaimed handle and a deactivated account are reported identically, on "
        "purpose: whether a deactivated account exists is not something an anonymous "
        "caller is entitled to learn, and a distinguishable answer would confirm it."
    ),
    status.HTTP_422_UNPROCESSABLE_CONTENT: problem_response(
        "The request line did not satisfy the contract. `type` is "
        "`/errors/validation-error` and `errors` names the offending parameter. Declared "
        "because the framework documents a validation rejection on every operation that "
        "parses a parameter, and this service renders every such rejection as the problem "
        "document above rather than as the framework's own shape. **One value of `username` "
        "reaches it**: a handle containing a NUL character, which `CITEXT` cannot represent and "
        "so cannot be compared against a stored handle at all. Every other handle is an "
        "unconstrained string here on purpose, so that an unclaimable one answers 404, which is "
        "the honest report that nobody holds it."
    ),
}

_PROFILE_POSTS_RESPONSES: Final[ProblemResponses] = {
    status.HTTP_404_NOT_FOUND: problem_response(
        "No visible account holds this handle - the same rule, and the same body, as "
        "`GET /users/{username}`. Raised before any post is selected, so an unknown "
        "author costs one index probe rather than a listing, and an unknown profile "
        "can never present as an author who has simply written nothing."
    ),
    status.HTTP_422_UNPROCESSABLE_CONTENT: problem_response(
        "The page window was out of range: `page` below 1, or `page_size` outside "
        "1-100. `type` is `/errors/validation-error`. Note that a page *past the last "
        "one* is not an error - it is a 200 whose `items` list is empty beside the real "
        "`total` and `pages`, so a client can tell it has run off the end."
    ),
}


# =======================================================================================
# `PATCH /me` IS DECLARED FIRST, AND THE POSITION IS PART OF THE CONTRACT.
#
# Starlette matches in registration order and serves the first pattern that accepts the
# URL, so `/{username}` registered above a literal `/me` would capture `me` as a username
# and make this route unreachable - answering 404 from a profile lookup for a handle nobody
# registered, with nothing in the logs to say a route was shadowed.
#
# The collision only bites within a single HTTP method, and every parameterised route in
# this module is currently a GET, so today the order is not what makes the file work. It is
# what keeps the file working the day a `GET /me` or a parameterised `PATCH` is added, which
# is exactly the day the failure would be hardest to attribute. Keep literal segments above
# parameterised ones here.
# =======================================================================================


@router.patch(
    "/me",
    response_model=UserMe,
    status_code=status.HTTP_200_OK,
    responses=_SELF_UPDATE_RESPONSES,
    summary="Update your own profile",
    description=(
        "Updates the authenticated account's `display_name`, `bio` and `avatar_url`, and "
        "nothing else. A genuine partial update: an omitted member is left exactly as it "
        "was, so a form that submits one field cannot revert the other two. Send `null` for "
        "`bio` or `avatar_url` to clear it; `display_name` is `NOT NULL` and rejects it. An "
        "empty body is a valid no-op.\n\n"
        "`email`, `username`, `role`, `is_active` and `id` are **not** editable through this "
        "route and are not merely undocumented - the request schema forbids unknown members, "
        "so proposing one is a 422. Role and activation are changed only by an administrator "
        "at `PATCH /api/v1/admin/users/{id}`.\n\n"
        "The response is the self view, which additionally carries `email`, `role`, "
        "`is_active` and `updated_at`. It is returned only here, to the principal describing "
        "its own record."
    ),
)
async def update_own_profile(
    payload: UserUpdate,
    db: DbSession,
    user: CurrentUser,
) -> UserMe:
    """Apply the principal's own profile changes and return the self view.

    There is no path parameter and no user identifier in the body, which is what makes this
    endpoint incapable of editing another account: the row being written is the one
    ``get_current_active_user`` resolved from the presented credential, so ownership is
    established by *which* row was injected rather than by a comparison that could be
    written the wrong way round. Authority needs no check here for the same reason - every
    principal may edit itself, and no principal can address anything else.

    Args:
        payload: The submitted changes, already validated against ``UserUpdate``. That model
            declares exactly three members and sets ``extra="forbid"``, so this signature is
            the whole of the update surface: a body naming ``role``, ``is_active``,
            ``email``, ``username`` or ``id`` is rejected as a 422 before this function is
            entered. No second body model is accepted here and no raw request is read, so
            there is no path by which a member could arrive unvalidated.
        db: The request-scoped session, handed to the service unchanged.
        user: The authenticated, active principal - and the subject of the update. Resolving
            it through :data:`~app.core.dependencies.CurrentUser` rather than
            ``get_current_user`` means a deactivated account is refused with 403 before any
            write is attempted, so a disabled account cannot keep editing its own profile.

    Returns:
        :class:`~app.schemas.user.UserMe`: the updated account, projected to include
        ``email``, ``role``, ``is_active`` and ``updated_at``. ``updated_at`` is the instant
        PostgreSQL stamped, because the service reloads the row after the write.

    Note:
        The projection is applied here, by name, rather than by returning the mapped entity
        and trusting the declared ``response_model`` to narrow it. Both would serialise
        identically today; naming it keeps the route's contract legible at the return
        statement and keeps this module free of any import from ``app.models``.
    """
    return UserMe.model_validate(await ProfileService(db).update_self(user, payload))


@router.get(
    "/{username}",
    response_model=UserPublic,
    status_code=status.HTTP_200_OK,
    responses=_PROFILE_RESPONSES,
    summary="Get an author's public profile",
    description=(
        "Returns the public identity behind a handle: `id`, `username`, `display_name`, "
        "`bio`, `avatar_url` and `created_at`. Deliberately withholds `email`, `role`, "
        "`is_active` and `password_hash`, so an author's address and privilege level are "
        "never disclosed by a profile view.\n\n"
        "Public, and identical for every caller - a credential changes nothing about the "
        "response, so none is read. The handle matches case-insensitively. An unclaimed "
        "handle and a deactivated account both answer 404, and the two are indistinguishable."
    ),
)
async def get_public_profile(username: _UsernamePath, db: DbSession) -> UserPublic:
    """Resolve one author's public profile by handle.

    Backs the client's ``/u/{username}`` route, which is server-rendered and crawled, so the
    projection is the confidentiality boundary: :class:`~app.schemas.user.UserPublic` is
    returned and neither ``UserMe`` nor ``AdminUser`` is reachable from this module's public
    routes. Either of those would publish the email address and role of every author in the
    product from an endpoint that requires no credential at all.

    Args:
        username: The handle as the URL supplied it, in whatever case, and passed to the
            service unchanged. It is deliberately not folded here: ``users.username`` is
            ``CITEXT UNIQUE``, so the index resolves ``Alice`` and ``alice`` to the same
            single account, and normalising in Python would restate a guarantee the schema
            already enforces in one more place that could drift from it.
        db: The request-scoped session, handed to the service unchanged.

    Returns:
        :class:`~app.schemas.user.UserPublic`: the author's public identity.

    Raises:
        NotFoundError: Propagated from
            :meth:`~app.services.profile_service.ProfileService.get_profile` when no account
            holds the handle, or when the account holding it has been deactivated. Rendered
            as the uniform problem document by the handler ``app.core.exceptions``
            registers - this module raises nothing itself and imports no framework error type.
    """
    return UserPublic.model_validate(await ProfileService(db).get_profile(username))


@router.get(
    "/{username}/posts",
    response_model=Page[PostSummary],
    status_code=status.HTTP_200_OK,
    responses=_PROFILE_POSTS_RESPONSES,
    summary="List an author's published posts",
    description=(
        "Returns one page of this author's **published** posts, newest first, in the same "
        "envelope every collection in this API returns - `items`, `total`, `page`, "
        "`page_size`, `pages` - so one client control pages a profile and the home feed "
        "alike. `total` counts every published post by the author, ignoring the window; a "
        "page past the last one is a 200 with an empty `items` list, not an error.\n\n"
        "**Drafts and archived posts are never included, for any caller.** There is no "
        "`status` parameter and no way to widen the result: an administrator and the author "
        "themselves see exactly what an anonymous crawler sees. An author reviewing their "
        "own drafts uses `GET /api/v1/posts?author={username}` while authenticated.\n\n"
        "Posts by any other author are excluded, and an unknown or deactivated handle "
        "answers 404 rather than an empty page."
    ),
)
async def list_author_published_posts(
    username: _UsernamePath,
    db: DbSession,
    page: PageParamsDep,
) -> Page[PostSummary]:
    """List one author's published posts, windowed.

    The whole of this route's security property is in the method it calls.
    :meth:`~app.services.profile_service.ProfileService.list_published_posts` filters on
    ``PUBLIC_PROFILE_STATUSES`` - the constant ``(PostStatus.PUBLISHED,)`` - and accepts no
    status argument and no viewer through which the set could be replaced or extended. So
    "a draft never appears on a public profile" holds by construction rather than by a
    predicate that must be evaluated correctly on every path, and it holds identically for
    an anonymous reader, the author and an administrator.

    That is why no principal is resolved here, not even
    :data:`~app.core.dependencies.OptionalUser`. A caller in scope would be a caller some
    later edit could branch on, and the first such branch would be the one that leaked a
    draft onto a crawled page.

    Args:
        username: The author's handle, resolved exactly as
            :func:`get_public_profile` resolves it - by the same service method, so the two
            endpoints of one profile can never disagree about whether that profile exists.
        db: The request-scoped session, handed to the service unchanged.
        page: The validated window from :data:`~app.core.dependencies.PageParamsDep`. Its
            bounds - ``page >= 1``, ``1 <= page_size <= 100`` - are already enforced by the
            time this function runs, so no arithmetic and no clamping happens here; ``page``
            is passed through verbatim, which is what lets a caller see that it asked for a
            page beyond the end rather than being silently served the last one.

    Returns:
        :class:`~app.core.pagination.Page` of :class:`~app.schemas.post.PostSummary`,
        returned exactly as the service built it. The items are already projected -
        ``PostSummary`` omits the post body, so a listing payload stays small - and the
        envelope's ``pages`` count is derived once, in ``build_page``, rather than here.

    Raises:
        NotFoundError: Propagated when no visible account holds the handle. The service
            resolves the author before issuing any post statement, so this is raised instead
            of an empty page - a profile that does not exist must not render as an author who
            has written nothing.
    """
    return await ProfileService(db).list_published_posts(
        username,
        page=page.page,
        page_size=page.page_size,
    )
