"""The five credential routes: register, sign in, rotate, sign out, and read the principal.

This module is the whole of the API's authentication surface and discharges the identity half
of the product requirement - *users can sign up, log in* over *JWT authentication*. It is also
the first authentication code this project has ever had: the single-module application it
replaces had no principal, no credential, no token and no authority check anywhere, and the
words ``Depends``, ``OAuth2`` and ``Bearer`` did not appear in the repository at all.

The five operations, and where each one's logic actually lives
-------------------------------------------------------------
Every handler below has the same shape - resolve dependencies, construct
:class:`~app.services.auth_service.AuthService`, call it, return - and none of them contains a
rule. Hashing, token minting, conflict detection, timing equalisation, rotation and reuse
detection are all in the service, reached through the session this module's ``DbSession``
dependency injects:

===========================  ==========================================================
``POST   /register``         :meth:`~app.services.auth_service.AuthService.register`
``POST   /login``            :meth:`~app.services.auth_service.AuthService.authenticate`
                             then
                             :meth:`~app.services.auth_service.AuthService.issue_token_pair`
``POST   /refresh``          :meth:`~app.services.auth_service.AuthService.rotate_refresh_token`
``POST   /logout``           :meth:`~app.services.auth_service.AuthService.logout`
``GET    /me``               no service call - the principal is already resolved by
                             ``app.core.dependencies``
===========================  ==========================================================

Sign-in is the one handler that makes two service calls, and it is deliberate rather than
leaked policy: ``authenticate`` answers "are these credentials correct" without writing
anything, and ``issue_token_pair`` writes a refresh-token row for an account whose authority is
already established. Keeping them apart is what lets the credential rule be exercised without
minting a token. ``AuthService.login`` is exactly this composition and behaves identically; the
two steps are spelled out here so the sign-in path reads as the two distinct decisions it is.
Any *other* handler needing a second call would mean a rule had escaped the service.

Paths and tags are not decided here
-----------------------------------
:data:`router` is a bare ``APIRouter()`` - no ``prefix``, no ``tags``, no router-level
``dependencies`` - and every path below is relative: ``"/register"``, not
``"/api/v1/auth/register"``. ``app.api.v1.router`` attaches the ``/auth`` prefix and the
``auth`` tag on its ``include_router`` call, and ``app.main`` mounts that aggregate at
``/api/v1``. Declaring either here would double the segment in the composed path or duplicate
the tag in the generated document, and hard-coding the version would let a route escape the
version namespace. One consequence is worth stating because it is easy to get wrong when
editing: the fully prefixed sign-in path ``/api/v1/auth/login`` *does* appear in the codebase,
as ``app.core.dependencies.TOKEN_URL``, because a documentation client is told to call an
absolute URL. That constant and this module's mount point must agree or the **Authorize**
control on ``/docs`` posts credentials into a 404.

Sign-in takes a form; every other route takes JSON
--------------------------------------------------
:func:`login` consumes :class:`~fastapi.security.OAuth2PasswordRequestForm` -
``application/x-www-form-urlencoded`` - while :func:`register`, :func:`refresh` and
:func:`logout` take JSON bodies. That asymmetry is load-bearing and must not be normalised
away. ``app.core.dependencies.oauth2_scheme`` is an ``OAuth2PasswordBearer``, so the security
scheme it publishes makes ``/docs`` render a username-and-password form and post it as the
OAuth 2 password grant; a JSON-only sign-in route would make that control fail and leave a
reader of the documentation unable to obtain a token for any protected route. It is also why
``python-multipart`` is a pinned runtime dependency rather than a test-only one.

The grant names its identifier field ``username``, and this API's identifier is an email
address, so **the value that belongs in that form's "username" box is the account's email**.
:class:`~app.schemas.auth.LoginRequest` remains the documented shape of a credential and is
what the service is handed; see :func:`login` for how the two are joined, and for the 500 that
joining them naively would produce.

Rate limiting: three requirements, and only one of them fails loudly
--------------------------------------------------------------------
All five routes carry :data:`~app.core.rate_limit.auth_rate_limit`. Credential endpoints are
the one part of a blog API where repetition is rewarded - a feed returns the same posts however
often it is asked, whereas sign-in answers a different question each time - so this is the only
namespace in the service that is throttled at all.

Three things have to hold, and the second is the one that survives review by accident:

1. **Every decorated handler declares a parameter named ``request``**, annotated
   ``fastapi.Request``. slowapi finds both the limiter and the caller's identity through that
   object and checks for the parameter *by name* when the decorator is applied, so an omission
   stops the process from starting. All five signatures therefore carry it, and four of the
   five never read it - hence the ``# noqa: ARG001`` at each site, for the same reason
   ``app/core/exceptions.py`` carries a project-level exemption: the framework supplies the
   argument whether or not the function has any use for it. The suppression is written at each
   parameter rather than once for the file so that a genuinely unused argument added later is
   still reported.
2. **The route decorator is the outer one.** ``@router.post(...)`` sits above
   ``@auth_rate_limit`` in every case. A router registers whatever function it is handed, so
   the reverse order registers the *undecorated* handler: the limiter is never consulted, the
   route serves unlimited requests, and nothing anywhere reports it.
3. **The limiter is bound to application state**, as ``app.state.limiter``, by ``app.main``.
   That is why the :data:`~app.core.rate_limit.limiter` object itself is not imported here.
   slowapi resolves it through ``request.app.state`` at request time, so this module needs only
   the decorator; importing the limiter to leave it unused would add nothing and constructing a
   second one would split the counters that are supposed to be shared.

The 429 is rendered by the same code that renders every other failure.
``app.core.exceptions.register_exception_handlers`` installs a handler for slowapi's
``RateLimitExceeded`` that emits the standard problem document plus a ``Retry-After`` header.
slowapi's own ready-made handler must never be registered: it would make the throttled response
the single error in this API with a body of its own shape.

One consequence of ``app.core.rate_limit`` disabling the limiter when ``ENVIRONMENT`` is
``test`` is worth knowing here. The integration suite drives register, sign in, rotate, sign out
and revoked-token refusal repeatedly from one client address, which under a live limit would
start returning 429 part-way through a scenario and fail on request volume rather than on
behaviour. That exemption belongs to the limiter's own configuration; no route here adds a
bypass of its own.

Failures are indistinguishable on purpose
-----------------------------------------
Nothing in this module tells a caller whether an account exists. A registration conflict, an
unknown email and a wrong password are all answered by the service with a fixed status and a
fixed message, and no handler here inspects, re-words or branches on which of them occurred.
There is deliberately no "is this name available" route: it is not in the API contract, and it
is precisely the disclosure this rule forbids. The service closes the timing channel as well as
the wording one - an unknown address is verified against a dummy argon2 hash so it costs the
same as a known one - and a handler that returned early on any credential path would reopen it.

No handler raises a framework exception, and none constructs an error body. Services raise the
typed domain errors - conflict, unauthorised, forbidden - and the single registered handler
renders each as one problem document carrying ``type``, ``title``, ``status``, ``detail``,
``instance`` and ``request_id``. This replaces three separately written framework-exception
raises in the module this rewrite retires - three hand-spelled copies of one 404 decision, once
per call site, each with its own literal status code and its own literal message.

Responses are bare representations
----------------------------------
Each route declares a ``response_model``, sign-out declares ``204 No Content`` and returns an
empty body, and every realistic failure status is declared in ``responses`` against
:class:`~app.schemas.common.ProblemDetail` so a generated client has a type for it. No route
wraps its result in a ``message``/``data`` envelope or answers a mutation with a bare
``message``, which is what the retired application did on three of its five routes.

Nothing is logged, and no ORM entity is named
---------------------------------------------
There is no logger in this module. Every value in scope on these paths is a credential or
names one - a submitted password, an access token, a refresh token, an email address - and the
outcome is already observable without it: ``app.middleware.request_context`` emits one
structured record per request with the status code and the bound request identifier, so a 401
here appears in the log stream with its correlation identifier while the credential that
produced it never does.

The handlers deal only in schemas. ``AuthService.register`` returns a mapped ORM ``User`` and
``CurrentUser`` resolves to one, and both are projected immediately through
:meth:`~pydantic.BaseModel.model_validate` rather than returned raw, so no mapped class appears
in a signature and no attribute of one is traversed here. That keeps the router's vocabulary
Pydantic and the mapped classes behind the service boundary, and it is the reason this module
imports no mapped class and no data-access module at all. Projecting is safe after a commit
because ``app.db.session`` sets ``expire_on_commit=False``, and cheap because every field of
:class:`~app.schemas.user.UserPublic` and :class:`~app.schemas.user.UserMe` is a column rather
than a relationship, so serialising one emits no query.
"""

from typing import Annotated, Any, Final

from fastapi import APIRouter, Depends, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import ValidationError

from app.core.dependencies import CurrentUser, DbSession
from app.core.exceptions import UnauthorizedError
from app.core.rate_limit import auth_rate_limit
from app.schemas import (
    LoginRequest,
    ProblemDetail,
    RefreshRequest,
    RegisterRequest,
    TokenPair,
    UserMe,
    UserPublic,
)
from app.services import AuthService

__all__ = ["router"]


# ---------------------------------------------------------------------------------------
# The documented failure contract
#
# Every entry below names `ProblemDetail` as its model, which is what puts the failure body
# into the generated document: without it a client generator emits no type for the error
# case, and "every route declares its shapes" would hold only for success. Each status is
# declared once as a single-entry mapping and the routes compose the ones they can actually
# produce, so a description is written in one place and no route can document a status it
# does not raise.
#
# `int | str` keys because that is the type FastAPI accepts - it allows range keys such as
# "4XX" - and the annotation is explicit rather than inferred from a literal nested in a
# decorator argument.
# ---------------------------------------------------------------------------------------

_UNAUTHORIZED: Final[dict[int | str, dict[str, Any]]] = {
    status.HTTP_401_UNAUTHORIZED: {
        "model": ProblemDetail,
        "description": (
            "The presented credential was absent, malformed, expired, revoked or simply "
            "wrong. Deliberately undifferentiated: an unknown email address, a wrong "
            "password, a refresh token that was never issued and one that has already been "
            "spent all produce this same status with the same `type` of "
            "`/errors/unauthorized`, so the route cannot be used to discover which accounts "
            "or which tokens exist. The response carries `WWW-Authenticate: Bearer`. A "
            "client should attempt a single refresh and fall back to sign-in if that is "
            "refused too."
        ),
    }
}

_CONFLICT: Final[dict[int | str, dict[str, Any]]] = {
    status.HTTP_409_CONFLICT: {
        "model": ProblemDetail,
        "description": (
            "The email address or the username is already registered. Which of the two is "
            "not reported, and neither is the address itself, because doing so would turn "
            "registration into a way of testing whether an account exists. Matching is "
            "case-insensitive at the database level, so an address or handle differing only "
            "in capitalisation from an existing one conflicts."
        ),
    }
}

_UNPROCESSABLE: Final[dict[int | str, dict[str, Any]]] = {
    status.HTTP_422_UNPROCESSABLE_CONTENT: {
        "model": ProblemDetail,
        "description": (
            "The submitted body failed validation before any rule was applied - a missing "
            "field, a malformed email address, a username outside the permitted pattern, a "
            "password below the length floor or short of the character-variety rule, or an "
            "unexpected extra property. The problem document's `errors` array names each "
            "offending field and is populated for this status only. Note that sign-in never "
            "answers 422 for a *credential* that could not be correct: that is a 401, "
            "because distinguishing malformed from wrong on the sign-in route would be a "
            "disclosure."
        ),
    }
}

_THROTTLED: Final[dict[int | str, dict[str, Any]]] = {
    status.HTTP_429_TOO_MANY_REQUESTS: {
        "model": ProblemDetail,
        "description": (
            "Too many requests from this client address. Applies to all five credential "
            "routes, which are the only throttled routes in the service, and it counts "
            "failed attempts as well as successful ones - a limit that only counted "
            "successes would not bound guessing. The response carries `Retry-After` with "
            "the remaining window in seconds."
        ),
    }
}

_REGISTER_RESPONSES: Final[dict[int | str, dict[str, Any]]] = (
    _CONFLICT | _UNPROCESSABLE | _THROTTLED
)
_CREDENTIAL_RESPONSES: Final[dict[int | str, dict[str, Any]]] = (
    _UNAUTHORIZED | _UNPROCESSABLE | _THROTTLED
)
_PRINCIPAL_RESPONSES: Final[dict[int | str, dict[str, Any]]] = _UNAUTHORIZED | _THROTTLED


# ---------------------------------------------------------------------------------------
# The router
#
# Bare, by design: no prefix, no tags, no router-level dependencies. `app.api.v1.router`
# supplies the `/auth` prefix and the `auth` tag; see the module docstring.
# ---------------------------------------------------------------------------------------

router = APIRouter()
"""The authentication router, mounted by ``app.api.v1.router`` at ``/auth``.

Reached as ``from app.api.v1.routers.auth import router`` and never through the
``app.api.v1.routers`` package, which deliberately re-exports nothing."""


# ---------------------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------------------


@router.post(
    "/register",
    response_model=UserPublic,
    status_code=status.HTTP_201_CREATED,
    responses=_REGISTER_RESPONSES,
    summary="Create an account",
    description=(
        "Registers a new account from an email address, a username, a password and a display "
        "name, and answers `201` with the account's public representation. No credential is "
        "echoed back and no token is issued: registration and sign-in are separate steps, so "
        "call `POST /api/v1/auth/login` next.\n\n"
        "The account is created with the author role. A role cannot be requested here - the "
        "body has no field for one - so this route cannot be used to obtain elevated "
        "authority. Administrators are made by seeding or by an existing administrator "
        "through the admin API.\n\n"
        "The email address and the username must both be unused, compared "
        "case-insensitively; a clash answers `409` without saying which identifier clashed."
    ),
)
@auth_rate_limit
async def register(
    # Declared for slowapi, which locates the limiter and the client key through it. Unread
    # here, hence the suppression - see requirement 1 in the module docstring.
    request: Request,  # noqa: ARG001
    payload: RegisterRequest,
    db: DbSession,
) -> UserPublic:
    """Create an account and return its public projection.

    One service call. Everything a caller may decide has already been decided by
    :class:`~app.schemas.auth.RegisterRequest` - a well-formed address, a URL-safe handle, a
    password clearing the length floor and the character-variety rule - and everything else
    belongs to :meth:`~app.services.auth_service.AuthService.register`: what the credential
    becomes, what authority the account gets, and whether the identifiers are free.

    **Uniqueness is not pre-checked here, and must not be.** Reading the table first would be
    a second implementation of a rule the service already owns, and it would be a rule with a
    race in it: another transaction can claim the same address between such a read and the
    insert. The ``CITEXT`` UNIQUE indexes on ``users.email`` and ``users.username`` are the
    authority, the service translates the violation they raise into the same conflict it
    reports from its own pre-check, and both arrive here as one
    :class:`~app.core.exceptions.ConflictError`.

    Args:
        request: The incoming request, required by the rate limiter and otherwise unused.
        payload: The validated registration body. Carries no role field, by design.
        db: The request-scoped session, handed straight to the service.

    Returns:
        The new account as :class:`~app.schemas.user.UserPublic`, which withholds the password
        hash along with the email address, the role and the active flag - none of which is
        anyone else's business, and all of which the account's owner can read from
        ``GET /api/v1/auth/me``.

    Raises:
        ConflictError: The email address or the username is already registered. Raised by the
            service; rendered as a 409 problem document by the registered handler. This
            handler does not catch it, re-word it or narrow it to one identifier.
    """
    user = await AuthService(db).register(payload)
    # Projected rather than returned raw, so no mapped class enters this module's signatures.
    return UserPublic.model_validate(user)


# ---------------------------------------------------------------------------------------
# Sign-in
# ---------------------------------------------------------------------------------------


@router.post(
    "/login",
    response_model=TokenPair,
    status_code=status.HTTP_200_OK,
    responses=_CREDENTIAL_RESPONSES,
    summary="Sign in and obtain an access and refresh token pair",
    description=(
        "Verifies a credential and answers `200` with a freshly minted token pair. Send the "
        "**account's email address in the form's `username` field** - the field is named by "
        "the OAuth 2 password grant, and this API's identifier is an email address.\n\n"
        "This route takes `application/x-www-form-urlencoded`, not JSON, which is what makes "
        "the **Authorize** control in this documentation work: enter an email and a password "
        "there and every protected route below becomes callable.\n\n"
        "The response's `access_token` is the bearer credential for protected routes and is "
        "short-lived. The `refresh_token` is returned in plaintext here for the only time it "
        "will ever be readable - the server stores nothing but its hash - and is spent at "
        "`POST /api/v1/auth/refresh`, which rotates it.\n\n"
        "An unknown address, a wrong password and a syntactically impossible address all "
        "answer `401` identically, so this route cannot be used to discover which addresses "
        "are registered."
    ),
)
@auth_rate_limit
async def login(
    # Declared for slowapi, which locates the limiter and the client key through it. Unread
    # here, hence the suppression - see requirement 1 in the module docstring.
    request: Request,  # noqa: ARG001
    form_data: Annotated[OAuth2PasswordRequestForm, Depends()],
    db: DbSession,
) -> TokenPair:
    """Verify a submitted credential and mint the pair it earns.

    The one handler that makes two service calls, and the module docstring explains why that
    is a composition rather than leaked policy. ``AuthService.login`` is the same two steps
    behind one name and behaves identically.

    Why the form is converted rather than forwarded
    ----------------------------------------------
    :class:`~fastapi.security.OAuth2PasswordRequestForm` is FastAPI's class for the password
    grant and exists here to make the **Authorize** control usable. It is not this API's
    credential contract: the service's contract is
    :meth:`~app.services.auth_service.AuthService.authenticate`, which takes a
    :class:`~app.schemas.auth.LoginRequest`. Passing the form object through instead would put
    a documentation-driven shape into the service layer and give the credential two competing
    definitions. So the two fields are lifted out and the real model is built from them, with
    the grant's ``username`` supplying the email address.

    Why that construction is guarded
    --------------------------------
    ``OAuth2PasswordRequestForm.username`` is an unconstrained string, while
    ``LoginRequest.email`` is an email address, so building the model can fail - and it fails
    by raising :class:`pydantic.ValidationError`, which is a ``ValueError`` rather than
    anything the error handlers dispatch on specifically. Left unguarded, typing ``admin``
    into the **Authorize** box would therefore answer **500**, reporting a server fault for
    what is simply a wrong credential.

    The guard answers 401 instead, and 401 rather than 422 is the deliberate choice: an
    address that could never have been registered is *wrong*, exactly as an unknown address
    and a wrong password are wrong, and distinguishing "malformed" from "wrong" on the one
    route whose security value is that its failures are indistinguishable would be a
    disclosure. The error is raised bare, so its wording is the class default and this module
    adds no per-failure-mode prose of its own.

    ``from None`` is a security requirement and not a stylistic preference.
    ``ValidationError`` records the value it rejected, and because ``LoginRequest`` also
    bounds ``password``, a single submission can produce a validation error carrying the
    **plaintext password** in its payload. Suppressing the chain keeps that object out of
    every traceback, exception group and log record it would otherwise reach.

    Args:
        request: The incoming request, required by the rate limiter and otherwise unused.
        form_data: The submitted password grant. Its ``username`` field carries the email
            address; ``scope`` and ``client_id`` are part of the grant and are unused by this
            API.
        db: The request-scoped session, handed straight to the service.

    Returns:
        A freshly minted :class:`~app.schemas.auth.TokenPair`.

    Raises:
        UnauthorizedError: The credential is wrong, unknown, or could not be a credential at
            all. One status, one body, one wording for all three.
        ForbiddenError: The credential was correct but the account is deactivated. Raised by
            the service, which is the only layer that can know it.
    """
    try:
        credentials = LoginRequest(email=form_data.username, password=form_data.password)
    except ValidationError:
        raise UnauthorizedError from None

    service = AuthService(db)
    user = await service.authenticate(credentials)
    return await service.issue_token_pair(user)


# ---------------------------------------------------------------------------------------
# Rotation
# ---------------------------------------------------------------------------------------


@router.post(
    "/refresh",
    response_model=TokenPair,
    status_code=status.HTTP_200_OK,
    responses=_CREDENTIAL_RESPONSES,
    summary="Rotate a refresh token for a new pair",
    description=(
        "Spends the presented refresh token and answers `200` with a new pair. A refresh "
        "token is single-use: the one sent here is revoked as part of the same statement that "
        "issues its replacement, so the value in the response is the only one that remains "
        "valid and a client must store it.\n\n"
        "Send the token in the JSON body, not in the `Authorization` header - the header on "
        "this route carries the access token when there is one, and the two credentials must "
        "not be confused. No access token is required to call this route; the refresh token "
        "is itself the credential.\n\n"
        "Presenting a token that has already been spent is treated as evidence of theft: "
        "every outstanding token for that account is revoked, ending all of its sessions. A "
        "token that was never issued, has expired or has been revoked answers `401` without "
        "saying which."
    ),
)
@auth_rate_limit
async def refresh(
    # Declared for slowapi, which locates the limiter and the client key through it. Unread
    # here, hence the suppression - see requirement 1 in the module docstring.
    request: Request,  # noqa: ARG001
    payload: RefreshRequest,
    db: DbSession,
) -> TokenPair:
    """Exchange a refresh token for a new pair.

    One service call, and the reason this handler is three lines rather than thirty is that
    every property that makes rotation safe belongs to
    :meth:`~app.services.auth_service.AuthService.rotate_refresh_token`: the exchange is a
    single conditional ``UPDATE`` so two requests presenting one token cannot both succeed;
    the presented value is matched by hash because the plaintext is never stored; and a token
    presented after it was already spent revokes that account's whole outstanding family
    rather than merely being refused.

    That last rule is deliberately absolute and must not be softened here. Reuse of a
    single-use token means either the token or the client is compromised, and the safe reading
    of an ambiguous signal is the pessimistic one. Nothing in this handler inspects the
    outcome, retries, or distinguishes reuse from expiry for the caller.

    Note that no access token is required. Rotation is normally reached *because* the access
    token has expired, so demanding a live one would make a lapsed session unrenewable and
    force a full sign-in - which is the failure mode rotation exists to avoid. The refresh
    token is the credential this route authenticates.

    Args:
        request: The incoming request, required by the rate limiter and otherwise unused.
        payload: The rotation body, carrying the refresh token to spend.
        db: The request-scoped session, handed straight to the service.

    Returns:
        A new :class:`~app.schemas.auth.TokenPair`. Its ``refresh_token`` replaces the one
        that was presented, which is no longer valid.

    Raises:
        UnauthorizedError: The token was never issued, has expired, has been revoked, or was
            presented a second time. Undifferentiated by design.
        ForbiddenError: The account the token belongs to has been deactivated.
    """
    return await AuthService(db).rotate_refresh_token(payload.refresh_token)


# ---------------------------------------------------------------------------------------
# Sign-out
# ---------------------------------------------------------------------------------------


@router.post(
    "/logout",
    response_model=None,
    status_code=status.HTTP_204_NO_CONTENT,
    responses=_CREDENTIAL_RESPONSES,
    summary="Sign out by revoking a refresh token",
    description=(
        "Revokes the presented refresh token and answers `204` with an empty body. Requires "
        "a valid access token in the `Authorization` header as well as the refresh token in "
        "the JSON body.\n\n"
        "Idempotent: a token that is unknown or already revoked is accepted, because "
        "answering otherwise would report whether a given token exists and would fail the "
        "honest cases - a retried request, a second browser tab, a client signing out twice - "
        "for no benefit.\n\n"
        "Only this session ends. The access token is a signed assertion with no server-side "
        "record, so nothing can withdraw it before it expires - which is why its lifetime is "
        "short and why a client must discard its copy locally. Other sessions for the same "
        "account are untouched."
    ),
)
@auth_rate_limit
async def logout(
    # Declared for slowapi, which locates the limiter and the client key through it. Unread
    # here, hence the suppression - see requirement 1 in the module docstring.
    request: Request,  # noqa: ARG001
    payload: RefreshRequest,
    db: DbSession,
    # Declared to enforce the credential requirement and deliberately unread: the token to
    # revoke is located by its own hash, so the resolved principal is not needed to do the
    # work. Naming it with a leading underscore is how this module says "required, not used",
    # matching `app.core.dependencies._bearer_token`'s treatment of the security scheme it
    # depends on purely so the scheme reaches the generated document.
    _principal: CurrentUser,
) -> None:
    """End the session the presented refresh token belongs to.

    One service call, and no return value: ``204 No Content`` means an empty body, so this
    returns ``None``. It emphatically does not answer ``{"message": "..."}`` - the retired
    application ended its delete route that way, and a message envelope is neither a resource
    representation nor something a client can act on.

    Requiring an access token *as well as* the refresh token is the documented contract for
    this route and is the source of its 401. It is a narrower rule than the service enforces
    on its own, which is the point: :meth:`~app.services.auth_service.AuthService.logout` is
    idempotent and refuses nothing, so without a credential requirement here this route would
    let an unauthenticated caller revoke any refresh token they could guess or had captured.
    The principal is not consulted when choosing what to revoke - the token names its own row
    - so holding a credential is a condition of calling, not a filter on the effect.

    Args:
        request: The incoming request, required by the rate limiter and otherwise unused.
        payload: The body carrying the refresh token to withdraw.
        db: The request-scoped session, handed straight to the service.
        _principal: The authenticated, active account. Resolved so that an absent, malformed
            or expired access token is refused before the body is acted on; unused thereafter.

    Returns:
        ``None``. Success and "already signed out" are the same state, and reporting which one
        occurred is the validity oracle the service deliberately does not build.
    """
    await AuthService(db).logout(payload.refresh_token)


# ---------------------------------------------------------------------------------------
# The principal
# ---------------------------------------------------------------------------------------


@router.get(
    "/me",
    response_model=UserMe,
    status_code=status.HTTP_200_OK,
    responses=_PRINCIPAL_RESPONSES,
    summary="Read the authenticated account",
    description=(
        "Returns the account the presented access token belongs to. This is the private "
        "projection: it carries the email address, the role and the active flag in addition "
        "to the public profile fields, and it is only ever returned to the account's own "
        "holder - the token names the subject, so there is no identifier to supply and no way "
        "to ask about anyone else. Use `GET /api/v1/users/{username}` for a public profile.\n\n"
        "The role reported here is read from the account record rather than from the token's "
        "claim, so a role changed by an administrator is reflected on the next call rather "
        "than whenever the current token happens to expire. A client may use it to decide "
        "which controls to render; it is not a capability, because every protected operation "
        "is re-checked server-side."
    ),
)
@auth_rate_limit
async def read_me(
    # Declared for slowapi, which locates the limiter and the client key through it. Unread
    # here, hence the suppression - see requirement 1 in the module docstring.
    request: Request,  # noqa: ARG001
    principal: CurrentUser,
) -> UserMe:
    """Return the resolved principal in its private projection.

    The only route in this module with no service call, and correctly so: the work is already
    done by the time the handler runs. ``CurrentUser`` resolves through
    ``app.core.dependencies``, which decodes the bearer credential, rejects an absent,
    malformed, expired or wrong-type one with 401, loads the account it names, and rejects a
    deactivated one with 403. Re-reading the account through a service would issue a second
    query for a row already in hand.

    No session parameter is declared, and that is not an oversight - ``CurrentUser`` resolves
    one internally for the lookup it performs. Declaring another here would advertise a
    datastore this handler never touches.

    Args:
        request: The incoming request, required by the rate limiter and otherwise unused.
        principal: The authenticated, active account, already loaded.

    Returns:
        The account as :class:`~app.schemas.user.UserMe` - the public field set plus
        ``email``, ``role``, ``is_active`` and ``updated_at``. The password hash is absent
        from that model and so cannot be disclosed here.
    """
    # Projected rather than returned raw, so no mapped class enters this module's signatures.
    return UserMe.model_validate(principal)
