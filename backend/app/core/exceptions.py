"""The service tier's single error contract: one exception hierarchy, one problem document.

Every failure this API can produce - a missing post, a conflicting registration, an ownership
violation, a malformed payload, a throttled login, an unmatched path, or a defect nobody
anticipated - leaves the process as the *same* JSON object, assembled in exactly one place in
this module. That is the whole purpose of the file, and it is a direct replacement for what
the repository did before: ``app.py`` raised ``HTTPException(status_code=404, detail="Item not
found")`` three times, byte for byte, at lines 31, 40 and 49, while its five routes disagreed
about the shape of a *successful* body as well - two wrapped results in
``{"message": ..., "data": ...}`` and two returned bare payloads. One behaviour written three
times, and no declared response shape anywhere. Here the pattern is declared once.

The document
------------
Five fields, always, plus a sixth that appears only when there is per-field information to
report. The shape is fixed; it is not extended per call site.

.. code-block:: json

    {
      "type": "/errors/not-found",
      "title": "Not Found",
      "status": 404,
      "detail": "Post not found",
      "instance": "/api/v1/posts/does-not-exist"
    }

``type``
    A stable, machine-readable URI reference. One convention throughout: ``/errors/`` followed
    by the kebab-case name of the error class. The closed set is ``/errors/bad-request``,
    ``/errors/unauthorized``, ``/errors/forbidden``, ``/errors/not-found``,
    ``/errors/method-not-allowed``, ``/errors/not-acceptable``, ``/errors/conflict``,
    ``/errors/content-too-large``, ``/errors/unsupported-media-type``,
    ``/errors/validation-error``, ``/errors/rate-limit-exceeded``,
    ``/errors/internal-server-error``, ``/errors/service-unavailable``, and the two
    coarse fallbacks ``/errors/client-error`` and ``/errors/server-error`` for a status the
    map does not name. Clients branch on this, never on ``title`` or ``detail``.
``title``
    A short human-readable summary of the error *class*. Stable: it never varies between two
    occurrences of the same error, so it is safe to use as a UI heading or a log dimension.
``status``
    The HTTP status code as a JSON number. Always equal to the response's actual status,
    because both are taken from the same argument in :func:`_problem_response`.
``detail``
    The instance-specific message, and the only field that varies per occurrence. Always safe
    to show a client: never a traceback, never a stack frame, never SQL, never a
    configuration value, and never an exception class name.
``instance``
    ``request.url.path``. The path only - the query string is deliberately excluded on every
    path, both because a filter expression is not part of the failure's identity and because
    a query string is a place credentials get pasted by mistake.
``errors``
    Present **only** for a validation failure, and then always non-empty. A list of
    ``{"field": ..., "message": ..., "type": ...}`` objects - see :class:`FieldError`.
    Omitted entirely, rather than sent as ``null``, for every other error.

There is deliberately no ``request_id`` field. Correlation belongs in a header, and travels
in :data:`REQUEST_ID_HEADER`; the document itself stays at five fields plus ``errors``.

Media type
----------
Every error response is served as :data:`PROBLEM_JSON_MEDIA_TYPE`
(``application/problem+json``), the media type RFC 9457 defines for exactly this document,
and it is uniform across all five handlers. Successful responses stay ``application/json``.
This is a cross-tier contract, not an internal detail: ``frontend/src/lib/api/client.ts`` is
the only module in the client tier that performs HTTP and it owns error normalisation, so it
parses these field names and this media type. ``docs/api/rest-endpoints.md`` documents them
and ``backend/app/schemas/common.py`` declares the same shape as a Pydantic model purely so
the fields appear in the OpenAPI document.

Who raises, who renders
-----------------------
Services raise; handlers render. A service never sees a ``Request``, never chooses a status
code and never formats a body - it raises :class:`NotFoundError`, :class:`ConflictError`,
:class:`ForbiddenError`, :class:`AppValidationError` or :class:`UnauthorizedError` and lets
this module translate. That is what keeps an ownership rule such as "an author may edit only
their own post, an administrator may edit any" unit-testable without an HTTP request, and it
is why no route in this API raises a framework exception directly.

.. code-block:: python

    # in a service - HTTP-agnostic, no Request, no status code
    post = await repository.get(post_id)
    if post is None:
        raise NotFoundError("Post not found")
    if post.author_id != principal.id and principal.role is not UserRole.ADMIN:
        raise ForbiddenError

Framework exceptions still happen, and they are handled here too rather than being allowed to
escape with a different shape: Starlette raises ``HTTPException`` for an unmatched path and
for a method mismatch, FastAPI raises ``RequestValidationError`` when a payload fails its
model, and slowapi raises ``RateLimitExceeded`` when a login is throttled.

The five handlers
-----------------
:func:`register_exception_handlers` installs all of them, and ``app.main`` calls it exactly
once. Dispatch is not registration-ordered: Starlette walks ``type(exc).__mro__`` and takes
the first registered class it finds, so the most-derived registration always wins. The order
below is therefore documentation of specificity, not a behavioural dependency - which is also
why ``RateLimitExceeded``, a subclass of ``HTTPException``, reliably reaches its own handler.

=========================== ======== =================================================
Exception                   Status   Notes
=========================== ======== =================================================
:class:`AppError`           its own  Status, type, title, detail and headers all
                                     come from the exception, so a 401 carries its
                                     ``WWW-Authenticate`` challenge to the wire.
``RequestValidationError``  422      Populated ``errors``, not FastAPI's default body.
``RateLimitExceeded``       429      Adds an integer ``Retry-After`` header.
``HTTPException``           its own  Starlette's and FastAPI's own failures, mapped
                                     to a stable type and title; ``exc.headers``
                                     survive, which is how ``Allow`` stays on a 405.
``Exception``               500      Generic detail, nothing internal, logged in full.
=========================== ======== =================================================

Registering the ``HTTPException`` handler is what retires the legacy surface at the error
contract: after this change ``/items`` matches no route, so Starlette raises a 404 that would
otherwise render as its own ``{"detail": "Not Found"}`` - the one response in the API that did
not match the documented shape. It now renders the problem document like everything else.

What a client never learns
--------------------------
The 500 body is generic in **every** environment. No exception class name, no message, no
traceback, no SQL, no settings value - a defect is diagnosed from the structured log, where
the full exception is recorded with its frames and where the request identifier bound by
``app.middleware.request_context`` is already attached to the line. The validation handler is
held to the same rule for a sharper reason: ``RequestValidationError`` carries the raw
submitted body on ``exc.body``, and each entry of ``exc.errors()`` carries the offending value
under ``input`` - for a password field that fails a length rule, that value *is* the plaintext
password. Neither is ever echoed. Only the field path, the message and the error type are.

Import purity
-------------
``app.core`` is the root of the backend import graph, and this module keeps it that way. It
imports the standard library, FastAPI, Starlette, slowapi and ``app.core.logging`` - nothing
else, and in particular **not** ``app.schemas``. That asymmetry is deliberate rather than
tidy: ``app.schemas.common`` declares the Pydantic model of this document for the OpenAPI
surface and therefore may import from ``app.core``, so an import back the other way would
close a cycle. The handlers here build the body as a plain dict instead, which is also why
there is exactly one function in the codebase that assembles a problem document.
"""

from collections.abc import Mapping, Sequence
from http import HTTPStatus
from types import MappingProxyType
from typing import ClassVar, Final, TypedDict, cast

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError

# `ORJSONResponse` carries a FastAPIDeprecationWarning as of FastAPI 0.141.1, because the
# framework now serialises through Pydantic when a route declares a response model. It is
# nonetheless the correct class here: `app.main` installs it as the application's
# `default_response_class`, so every successful body is already rendered by it, and rendering
# failures through anything else would reintroduce - between success and failure this time -
# precisely the serialisation inconsistency this module exists to eliminate. The warning is a
# property of the pinned release and of that application-wide choice, so it is recorded here
# rather than silenced: mutating the global warning filters from a library module would hide
# unrelated deprecations for the whole process.
from fastapi.responses import ORJSONResponse
from slowapi.errors import RateLimitExceeded
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.logging import get_logger

__all__ = [
    "PROBLEM_JSON_MEDIA_TYPE",
    "REQUEST_ID_HEADER",
    "AppError",
    "AppValidationError",
    "ConflictError",
    "FieldError",
    "ForbiddenError",
    "InvalidTokenError",
    "NotFoundError",
    "TokenExpiredError",
    "UnauthorizedError",
    "register_exception_handlers",
]


# ---------------------------------------------------------------------------------------
# Public contract constants
#
# Both are exported because more than one module has to agree on them, and a duplicated
# string literal is how two modules stop agreeing without anyone noticing.
# ---------------------------------------------------------------------------------------

PROBLEM_JSON_MEDIA_TYPE: Final[str] = "application/problem+json"
"""Media type of every error response. RFC 9457's type for this document.

Uniform across all five handlers. ``docs/api/rest-endpoints.md`` documents it and
``frontend/src/lib/api/client.ts`` matches on it while normalising errors, so it is part of
the cross-tier contract rather than a local preference.
"""

REQUEST_ID_HEADER: Final[str] = "X-Request-ID"
"""Response header carrying the per-request correlation identifier.

``app.middleware.request_context`` owns this header for every ordinary response and should
import the name from here rather than repeat the literal, so the two cannot drift apart. This
module needs it for one case the middleware cannot reach: Starlette dispatches a handler
registered for bare ``Exception`` through ``ServerErrorMiddleware``, which wraps the *outside*
of the stack - outside everything added with ``add_middleware`` - so the 500 handler below sets
the header itself. See :func:`_unhandled_exception_handler`.
"""


# ---------------------------------------------------------------------------------------
# Problem `type` URI references
#
# Kebab-case names under a single `/errors/` prefix. These strings are the stable part of
# the contract - a client branches on `type`, so renaming one is a breaking change in the
# same way renaming a field would be.
# ---------------------------------------------------------------------------------------

_ERROR_TYPE_BAD_REQUEST: Final[str] = "/errors/bad-request"
_ERROR_TYPE_UNAUTHORIZED: Final[str] = "/errors/unauthorized"
_ERROR_TYPE_FORBIDDEN: Final[str] = "/errors/forbidden"
_ERROR_TYPE_NOT_FOUND: Final[str] = "/errors/not-found"
_ERROR_TYPE_METHOD_NOT_ALLOWED: Final[str] = "/errors/method-not-allowed"
_ERROR_TYPE_NOT_ACCEPTABLE: Final[str] = "/errors/not-acceptable"
_ERROR_TYPE_CONFLICT: Final[str] = "/errors/conflict"
_ERROR_TYPE_CONTENT_TOO_LARGE: Final[str] = "/errors/content-too-large"
_ERROR_TYPE_UNSUPPORTED_MEDIA_TYPE: Final[str] = "/errors/unsupported-media-type"
_ERROR_TYPE_VALIDATION: Final[str] = "/errors/validation-error"
_ERROR_TYPE_RATE_LIMITED: Final[str] = "/errors/rate-limit-exceeded"
_ERROR_TYPE_INTERNAL: Final[str] = "/errors/internal-server-error"
_ERROR_TYPE_SERVICE_UNAVAILABLE: Final[str] = "/errors/service-unavailable"

# Coarse fallbacks for a status code the map below does not name. Still deterministic: the
# same status always yields the same pair, so `type` stays stable even off the mapped path.
_ERROR_TYPE_CLIENT_ERROR: Final[str] = "/errors/client-error"
_ERROR_TYPE_SERVER_ERROR: Final[str] = "/errors/server-error"
_ERROR_TYPE_HTTP_ERROR: Final[str] = "/errors/http-error"


# ---------------------------------------------------------------------------------------
# Problem titles
#
# One per error class, and stable per class: a title describes the kind of failure, never
# the occurrence. `detail` is the only field that varies between two occurrences.
# ---------------------------------------------------------------------------------------

_TITLE_BAD_REQUEST: Final[str] = "Bad Request"
_TITLE_UNAUTHORIZED: Final[str] = "Unauthorized"
_TITLE_FORBIDDEN: Final[str] = "Forbidden"
_TITLE_NOT_FOUND: Final[str] = "Not Found"
_TITLE_METHOD_NOT_ALLOWED: Final[str] = "Method Not Allowed"
_TITLE_NOT_ACCEPTABLE: Final[str] = "Not Acceptable"
_TITLE_CONFLICT: Final[str] = "Conflict"
_TITLE_CONTENT_TOO_LARGE: Final[str] = "Content Too Large"
_TITLE_UNSUPPORTED_MEDIA_TYPE: Final[str] = "Unsupported Media Type"
_TITLE_VALIDATION: Final[str] = "Validation Error"
_TITLE_RATE_LIMITED: Final[str] = "Too Many Requests"
_TITLE_INTERNAL: Final[str] = "Internal Server Error"
_TITLE_SERVICE_UNAVAILABLE: Final[str] = "Service Unavailable"
_TITLE_CLIENT_ERROR: Final[str] = "Client Error"
_TITLE_SERVER_ERROR: Final[str] = "Server Error"
_TITLE_HTTP_ERROR: Final[str] = "HTTP Error"


# ---------------------------------------------------------------------------------------
# Default `detail` messages
#
# Every one of these is written to be safe in front of an unauthenticated caller. They name
# no resource, disclose no existence, quote no configuration and reveal no internals - a
# 403 that said "post 0f9c1f6e belongs to alice" would answer a question the caller has no
# authority to ask.
# ---------------------------------------------------------------------------------------

_DETAIL_NOT_FOUND: Final[str] = "The requested resource was not found."
_DETAIL_CONFLICT: Final[str] = "The request conflicts with the current state of the resource."
_DETAIL_FORBIDDEN: Final[str] = "You do not have permission to perform this action."
_DETAIL_VALIDATION: Final[str] = "The request could not be processed as submitted."
_DETAIL_UNAUTHORIZED: Final[str] = "Authentication credentials are missing or invalid."
_DETAIL_TOKEN_EXPIRED: Final[str] = "The authentication token has expired."
_DETAIL_INVALID_TOKEN: Final[str] = "The authentication token is invalid."
_DETAIL_REQUEST_VALIDATION: Final[str] = "The request payload failed validation."

# Deliberately fixed, and deliberately silent about the configured limit. slowapi puts the
# rendered rate-limit expression - "10 per 1 minute", which is the AUTH_RATE_LIMIT setting -
# on `exc.detail`, and a settings value does not belong in a response body. The number a
# client can actually act on travels in the `Retry-After` header instead.
_DETAIL_RATE_LIMITED: Final[str] = (
    "Too many requests. Retry after the interval given in the Retry-After header."
)

# The 500 body, in every environment including development. A caller learns that the request
# failed and nothing more; the exception itself goes to the structured log.
_DETAIL_INTERNAL: Final[str] = "An unexpected error occurred."

# Substituted when a validation entry carries no usable message, so `errors` is never empty
# and never carries `None`. It quotes nothing the caller submitted.
_DETAIL_INVALID_FIELD: Final[str] = "This value is invalid."


# ---------------------------------------------------------------------------------------
# Header and validation-mapping constants
# ---------------------------------------------------------------------------------------

_WWW_AUTHENTICATE_HEADER: Final[str] = "WWW-Authenticate"
_BEARER_CHALLENGE: Final[str] = "Bearer"
_RETRY_AFTER_HEADER: Final[str] = "Retry-After"

# Fallback window for `Retry-After` when slowapi hands over an exception with no limit
# attached - `RateLimitExceeded.limit` defaults to None at class level, so the attribute is
# genuinely optional. One minute matches the granularity AUTH_RATE_LIMIT is expressed in.
_DEFAULT_RETRY_AFTER_SECONDS: Final[int] = 60

# The first element of a Pydantic `loc` tuple names the part of the request the value came
# from. It is dropped from the reported field path so that `("body", "email")` becomes
# `"email"` - the name the client's own form control is bound to.
_REQUEST_PART_MARKERS: Final[frozenset[str]] = frozenset(
    {"body", "query", "path", "header", "cookie"}
)

# Error type reported for a validation entry whose own type is missing or unusable.
_FALLBACK_VALIDATION_TYPE: Final[str] = "invalid_request"


# ---------------------------------------------------------------------------------------
# Status -> (type, title) for framework-raised HTTPExceptions
#
# Starlette and FastAPI raise on their own behalf - 404 for an unmatched path, 405 for a
# method mismatch, 415 for an unsupported media type - and those failures must render with
# the same `type` a domain error of the same kind would use, so a client's 404 branch does
# not have to know whether the routing layer or a service produced it.
#
# A mapping proxy rather than a dict: it is module-global shared state, and nothing should
# be able to mutate the error contract at runtime.
# ---------------------------------------------------------------------------------------

_STATUS_PROBLEM: Final[Mapping[int, tuple[str, str]]] = MappingProxyType(
    {
        HTTPStatus.BAD_REQUEST: (_ERROR_TYPE_BAD_REQUEST, _TITLE_BAD_REQUEST),
        HTTPStatus.UNAUTHORIZED: (_ERROR_TYPE_UNAUTHORIZED, _TITLE_UNAUTHORIZED),
        HTTPStatus.FORBIDDEN: (_ERROR_TYPE_FORBIDDEN, _TITLE_FORBIDDEN),
        HTTPStatus.NOT_FOUND: (_ERROR_TYPE_NOT_FOUND, _TITLE_NOT_FOUND),
        HTTPStatus.METHOD_NOT_ALLOWED: (
            _ERROR_TYPE_METHOD_NOT_ALLOWED,
            _TITLE_METHOD_NOT_ALLOWED,
        ),
        HTTPStatus.NOT_ACCEPTABLE: (_ERROR_TYPE_NOT_ACCEPTABLE, _TITLE_NOT_ACCEPTABLE),
        HTTPStatus.CONFLICT: (_ERROR_TYPE_CONFLICT, _TITLE_CONFLICT),
        HTTPStatus.CONTENT_TOO_LARGE: (
            _ERROR_TYPE_CONTENT_TOO_LARGE,
            _TITLE_CONTENT_TOO_LARGE,
        ),
        HTTPStatus.UNSUPPORTED_MEDIA_TYPE: (
            _ERROR_TYPE_UNSUPPORTED_MEDIA_TYPE,
            _TITLE_UNSUPPORTED_MEDIA_TYPE,
        ),
        HTTPStatus.UNPROCESSABLE_CONTENT: (_ERROR_TYPE_VALIDATION, _TITLE_VALIDATION),
        HTTPStatus.TOO_MANY_REQUESTS: (_ERROR_TYPE_RATE_LIMITED, _TITLE_RATE_LIMITED),
        HTTPStatus.INTERNAL_SERVER_ERROR: (_ERROR_TYPE_INTERNAL, _TITLE_INTERNAL),
        HTTPStatus.SERVICE_UNAVAILABLE: (
            _ERROR_TYPE_SERVICE_UNAVAILABLE,
            _TITLE_SERVICE_UNAVAILABLE,
        ),
    }
)

# No fixed headers. Declared once, shared by every class that adds none, and a mapping proxy
# so an instance can never mutate the default other instances read.
_NO_HEADERS: Final[Mapping[str, str]] = MappingProxyType({})

# RFC 6750's challenge for bearer-token authentication, sent with every 401. Deliberately the
# bare scheme: RFC 6750 also permits `error` and `error_description` parameters, but those
# would tell an unauthenticated caller whether a token was expired, malformed or simply
# absent, and one stable challenge string is easier for a client to match on.
_BEARER_HEADERS: Final[Mapping[str, str]] = MappingProxyType(
    {_WWW_AUTHENTICATE_HEADER: _BEARER_CHALLENGE}
)


class FieldError(TypedDict):
    """One entry of the ``errors`` list on a validation problem document.

    A ``TypedDict`` rather than a model or a dataclass for two reasons: it *is* a ``dict`` at
    runtime, so it serialises straight through :class:`ORJSONResponse` with no conversion
    step, and it is fully checked at the construction sites in this module.

    Three fields, and no more - the omissions are the security-relevant part:

    ``field``
        Dotted path of the offending value, with Pydantic's leading request-part marker
        removed: ``("body", "email")`` becomes ``"email"``, and
        ``("body", "categories", 0, "slug")`` becomes ``"categories.0.slug"``. Integer indices
        are rendered decimally, which is exactly the path syntax the client's form library
        consumes, so a server-side rejection can be attached to the control that caused it.
        Empty only when the location carries no field at all.
    ``message``
        Pydantic's human-readable message for the failure.
    ``type``
        Pydantic's machine-readable error type, such as ``string_too_short`` or
        ``int_parsing``, for a client that wants to localise the message itself.

    Absent by design: ``input`` and ``ctx``, both of which Pydantic includes in its own error
    entries. ``input`` is the value the caller submitted - for a password that fails a length
    rule it is the plaintext password - and ``ctx`` can hold a live exception object, which is
    not JSON-serialisable and would make the handler itself raise while rendering an error.
    """

    field: str
    message: str
    type: str


class AppError(Exception):
    """Base class for every failure this API reports deliberately.

    Raise a concrete subclass from a service; never construct a framework exception in a
    service, a repository or a route. The exception carries everything the response needs -
    status, ``type``, ``title``, ``detail``, any headers and any field errors - and nothing
    the response cannot use: no ``Request``, no session, no rendering. That separation is what
    lets an ownership rule be unit-tested by asserting on the exception a service raises,
    with no HTTP request and no client in the picture.

    The class-level defaults describe the error *class*, and a caller overrides only what
    varies:

    .. code-block:: python

        raise NotFoundError  # "The requested resource was not found."
        raise NotFoundError("Post not found")  # sharper, still safe to show a client
        raise ConflictError("That username is already taken.")
        raise AppValidationError(
            "The slug is already in use.",
            errors=[FieldError(field="slug", message="Already in use.", type="value_error")],
        )

    ``status_code``, ``error_type``, ``title`` and ``detail`` are annotated as ordinary
    attributes rather than as ``ClassVar`` on purpose: they are declared once per subclass but
    an instance is allowed to shadow them, which is what makes the ``detail`` override above
    work. Only ``default_headers``, which is shared mutable-by-type state, is a ``ClassVar``.

    Attributes:
        status_code: HTTP status the handler responds with, and the value of the document's
            ``status`` field. The base's 500 is a backstop - every concrete subclass sets its
            own, and a service should raise a subclass rather than this class.
        error_type: The document's ``type`` field: a stable ``/errors/...`` URI reference.
        title: The document's ``title`` field. Stable per class.
        detail: The document's ``detail`` field. The only field that varies per occurrence.
        default_headers: Response headers this error class always contributes, merged beneath
            any passed to :meth:`__init__`. Used by :class:`UnauthorizedError` to guarantee
            its ``WWW-Authenticate`` challenge.
    """

    status_code: int = HTTPStatus.INTERNAL_SERVER_ERROR
    error_type: str = _ERROR_TYPE_INTERNAL
    title: str = _TITLE_INTERNAL
    detail: str = _DETAIL_INTERNAL
    default_headers: ClassVar[Mapping[str, str]] = _NO_HEADERS

    def __init__(
        self,
        detail: str | None = None,
        *,
        headers: Mapping[str, str] | None = None,
        errors: Sequence[FieldError] | None = None,
    ) -> None:
        """Build the error, overriding only what differs from the class defaults.

        Args:
            detail:
                Replacement for the class's ``detail``. Omit it to accept the default, which
                every subclass defines to be safe in front of an unauthenticated caller. A
                supplied message is sent verbatim, so it must not name an internal identifier,
                quote SQL or a configuration value, or disclose the existence of a resource
                the caller has no authority to know about.
            headers:
                Extra response headers, merged over :attr:`default_headers`. A key present in
                both wins here, so a caller can refine a challenge but cannot accidentally
                drop one by passing an unrelated header.
            errors:
                Per-field detail, for a domain rule Pydantic cannot express. Copied into a new
                list so the caller's sequence cannot be mutated through this exception, and
                left as ``None`` when absent so the handler omits the ``errors`` key rather
                than emitting an empty list.
        """
        if detail is not None:
            self.detail = detail

        # Merged into a fresh dict: `default_headers` is a shared mapping proxy, so building a
        # new dict is what keeps one instance's headers from being visible to the next.
        merged: dict[str, str] = {**self.default_headers, **(headers or {})}
        self.headers: dict[str, str] | None = merged or None

        self.errors: list[FieldError] | None = None if errors is None else list(errors)

        # Hand the detail to Exception so `str(exc)` and any incidental log or traceback show
        # the message rather than an empty `AppError()`.
        super().__init__(self.detail)


class NotFoundError(AppError):
    """404 - the addressed resource does not exist, or the caller may not know that it does.

    Also the correct error when a resource exists but the caller has no authority to learn of
    its existence: answering 404 rather than 403 in that case is what stops an unauthorised
    caller from enumerating identifiers, which is why ``post_service`` reports a missing
    *and* an invisible draft the same way.
    """

    status_code: int = HTTPStatus.NOT_FOUND
    error_type: str = _ERROR_TYPE_NOT_FOUND
    title: str = _TITLE_NOT_FOUND
    detail: str = _DETAIL_NOT_FOUND


class ConflictError(AppError):
    """409 - the request cannot be applied to the resource's current state.

    Raised by ``auth_service`` when a registration collides with an existing email or
    username, and by ``category_service`` when a name or slug is already taken or when a
    category still in use is asked to be deleted.
    """

    status_code: int = HTTPStatus.CONFLICT
    error_type: str = _ERROR_TYPE_CONFLICT
    title: str = _TITLE_CONFLICT
    detail: str = _DETAIL_CONFLICT


class ForbiddenError(AppError):
    """403 - the caller is authenticated, but lacks the authority for this operation.

    The distinction from :class:`UnauthorizedError` is not cosmetic: 401 means "I do not know
    who you are", 403 means "I know who you are and the answer is still no". A client that
    conflates them will try to refresh a perfectly good token in response to a permissions
    failure and loop.

    Raised by the ownership checks in ``post_service`` and ``comment_service``, by
    ``require_admin`` in ``app.core.dependencies``, and by ``get_current_active_user`` when a
    deactivated account presents a valid token - its credentials are genuine, so 401 would be
    wrong and would invite a pointless refresh.
    """

    status_code: int = HTTPStatus.FORBIDDEN
    error_type: str = _ERROR_TYPE_FORBIDDEN
    title: str = _TITLE_FORBIDDEN
    detail: str = _DETAIL_FORBIDDEN


class AppValidationError(AppError):
    """422 - a domain rule rejected the request, beyond what a schema can express.

    For validation a Pydantic model *can* express, nothing needs raising: FastAPI raises
    ``RequestValidationError`` and :func:`_request_validation_error_handler` renders it into
    the identical document. Use this class for the rules a schema cannot see - a slug that
    collides after derivation, a comment whose parent belongs to a different post, a status
    transition that is not legal from the current state.

    The name is ``AppValidationError`` and not ``ValidationError`` deliberately. This module
    already handles ``fastapi.exceptions.RequestValidationError`` and sits one import away
    from ``pydantic.ValidationError``; a bare ``ValidationError`` in the domain namespace
    would shadow or be mistaken for either of them at every call site, and an ``except
    ValidationError`` that caught the wrong one of the three would fail silently.
    """

    status_code: int = HTTPStatus.UNPROCESSABLE_CONTENT
    error_type: str = _ERROR_TYPE_VALIDATION
    title: str = _TITLE_VALIDATION
    detail: str = _DETAIL_VALIDATION


class UnauthorizedError(AppError):
    """401 - no usable credential was presented.

    Always emits ``WWW-Authenticate: Bearer`` through :attr:`AppError.default_headers`, which
    is what makes the response a well-formed challenge rather than a bare refusal, and is why
    the handler for :class:`AppError` forwards ``exc.headers`` to the response.

    Raised by ``app.core.dependencies`` for an absent or malformed ``Authorization`` header
    and for a principal the token names but the database does not have, and by
    ``app.core.security`` through the two subclasses below.
    """

    status_code: int = HTTPStatus.UNAUTHORIZED
    error_type: str = _ERROR_TYPE_UNAUTHORIZED
    title: str = _TITLE_UNAUTHORIZED
    detail: str = _DETAIL_UNAUTHORIZED
    default_headers: ClassVar[Mapping[str, str]] = _BEARER_HEADERS


class TokenExpiredError(UnauthorizedError):
    """401 - the presented token was valid but its lifetime has elapsed.

    Distinguished from :class:`InvalidTokenError` so that ``app.core.security`` can be precise
    about which decode failure occurred and the client can tell "refresh me" apart from "sign
    in again". The ``type`` and ``title`` stay those of :class:`UnauthorizedError`: a client
    branches on ``type``, and every 401 means the same thing to that branch.
    """

    detail: str = _DETAIL_TOKEN_EXPIRED


class InvalidTokenError(UnauthorizedError):
    """401 - the presented token failed signature, structure or claim validation.

    Covers a forged signature, a truncated token, a wrong algorithm and a missing or
    unexpected claim alike. Deliberately undifferentiated in the response: telling a caller
    *which* check failed is telling an attacker which one to fix next.
    """

    detail: str = _DETAIL_INVALID_TOKEN


# ---------------------------------------------------------------------------------------
# The single assembly site
#
# Every error response in this service is built here and nowhere else. That is not a style
# preference - it is the mechanism by which "one problem document" is true rather than
# aspirational. All five handlers below call this function; none constructs a response of
# its own, so there is exactly one place where a field could be added, renamed or dropped,
# and exactly one place to read to know what an error looks like on the wire.
# ---------------------------------------------------------------------------------------


def _problem_response(
    *,
    request: Request,
    status: int,
    error_type: str,
    title: str,
    detail: str,
    errors: Sequence[FieldError] | None = None,
    headers: Mapping[str, str] | None = None,
) -> ORJSONResponse:
    """Assemble the problem document and wrap it in the application's response class.

    Keyword-only throughout: six of the parameters are strings or optional collections, and
    positional calls across five handlers would be one transposition away from a response
    whose ``title`` held its ``detail``.

    Args:
        request: The request being answered. Only ``request.url.path`` is read, which becomes
            the ``instance`` field.
        status: HTTP status for both the response and the document's ``status`` field, so the
            two cannot disagree - they are the same argument.
        error_type: Stable ``/errors/...`` URI reference for the ``type`` field.
        title: Stable human-readable summary of the error class.
        detail: Instance-specific message. Must already be safe to show a client.
        errors: Per-field detail. When ``None`` the ``errors`` key is omitted entirely rather
            than serialised as ``null``, which keeps the key set of a non-validation document
            at exactly five.
        headers: Response headers to attach - a ``WWW-Authenticate`` challenge, an ``Allow``
            list preserved from a 405, a ``Retry-After`` window, or a correlation identifier.

    Returns:
        An :class:`ORJSONResponse` carrying the document at :data:`PROBLEM_JSON_MEDIA_TYPE`.
    """
    # Coerced once, then used for both the document's `status` field and the response's own
    # status. Callers pass `HTTPStatus` members because they read better at the call site, and
    # narrowing to a plain int here means neither the serialised field nor the status line
    # depends on how an IntEnum is rendered - and, more importantly, that the two are the same
    # value by construction rather than by two callers agreeing.
    status_code = int(status)

    # Insertion order is the wire order, and it is the order the document is documented in:
    # type, title, status, detail, instance, then errors.
    body: dict[str, object] = {
        "type": error_type,
        "title": title,
        "status": status_code,
        "detail": detail,
        # The path only. A query string is excluded on every path - deliberately and
        # uniformly - because it is not part of the failure's identity and is a place stray
        # credentials end up.
        "instance": request.url.path,
    }
    if errors is not None:
        body["errors"] = list(errors)

    return ORJSONResponse(
        content=body,
        status_code=status_code,
        # `or None` so an empty mapping is normalised away rather than reaching Starlette as
        # an empty header block.
        headers=headers or None,
        media_type=PROBLEM_JSON_MEDIA_TYPE,
    )


def _problem_for_status(status: int) -> tuple[str, str]:
    """Resolve the stable ``(type, title)`` pair for a framework-raised status code.

    Mapped codes get the same pair a domain error of that kind would use, so a client's 404
    branch does not need to know whether the routing layer or a service produced the failure.
    Unmapped codes fall back to a class-of-status pair, which is still deterministic: the same
    status always yields the same answer, so ``type`` remains a stable contract off the mapped
    path as well as on it.

    Args:
        status: The HTTP status code carried by the exception.

    Returns:
        The ``(error_type, title)`` pair to render.
    """
    mapped = _STATUS_PROBLEM.get(status)
    if mapped is not None:
        return mapped
    if status >= HTTPStatus.INTERNAL_SERVER_ERROR:
        return (_ERROR_TYPE_SERVER_ERROR, _TITLE_SERVER_ERROR)
    if status >= HTTPStatus.BAD_REQUEST:
        return (_ERROR_TYPE_CLIENT_ERROR, _TITLE_CLIENT_ERROR)
    # A non-error status reaching an exception handler means something upstream raised with a
    # 2xx or 3xx code. It is not this module's job to reject that, but it must not be labelled
    # a client or server error either.
    return (_ERROR_TYPE_HTTP_ERROR, _TITLE_HTTP_ERROR)


def _field_path(loc: object) -> str:
    """Render a Pydantic ``loc`` tuple as the dotted field path the client can use.

    The leading request-part marker - ``body``, ``query``, ``path``, ``header`` or ``cookie`` -
    is dropped whenever something follows it, because the client cares about the field, not
    about which part of the envelope carried it: ``("body", "email")`` reports as ``"email"``.
    It is *kept* when it is the only element, which happens when the whole body is missing or
    unparseable and there is no field to name.

    Integer indices are rendered decimally and joined with the same separator, so
    ``("body", "categories", 0, "slug")`` reports as ``"categories.0.slug"`` - the path syntax
    the client's form library already understands, which is what allows a server-side
    rejection to be attached to the control that produced it.

    Args:
        loc: The ``loc`` value from a validation entry. Typed as ``object`` because
            ``RequestValidationError.errors()`` is declared as a sequence of ``Any``, so the
            shape is checked here rather than assumed.

    Returns:
        The dotted path, or an empty string when the location is absent or not a sequence.
    """
    if not isinstance(loc, tuple | list):
        return ""
    parts = [str(part) for part in loc]
    if len(parts) > 1 and parts[0] in _REQUEST_PART_MARKERS:
        del parts[0]
    return ".".join(parts)


def _fallback_field_error() -> FieldError:
    """Return the placeholder entry used when a validation entry yields nothing usable.

    A function rather than a module constant so each caller receives a fresh dictionary: a
    shared one would be aliased into a response body, where a later mutation - however
    unlikely - would silently rewrite the contract for every subsequent request.

    Returns:
        A :class:`FieldError` naming no field and quoting nothing the caller submitted.
    """
    return FieldError(field="", message=_DETAIL_INVALID_FIELD, type=_FALLBACK_VALIDATION_TYPE)


def _field_error(raw: object) -> FieldError:
    """Reduce one Pydantic validation entry to the three fields the contract publishes.

    This function is where the two hazards in ``RequestValidationError.errors()`` are closed.
    Each entry carries ``input``, the value the caller actually submitted - for a password
    field that fails a length rule, that value is the plaintext password - and may carry
    ``ctx`` holding a live exception object, which is not JSON-serialisable and would make the
    handler raise while it was in the middle of rendering an error. Neither is read here: only
    ``loc``, ``msg`` and ``type`` are, and each is validated before use.

    Args:
        raw: One element of ``exc.errors()``, typed as ``object`` because that method is
            declared as a sequence of ``Any``.

    Returns:
        A :class:`FieldError` with all three fields populated - never ``None``, never empty
        strings for ``message`` and ``type`` - so the rendered ``errors`` list is always
        usable even for a malformed entry.
    """
    if not isinstance(raw, Mapping):
        # Defensive rather than expected: Pydantic always yields mappings. Reporting a
        # placeholder keeps `errors` non-empty and keeps this function total, and it quotes
        # nothing about the entry, whose contents are not known to be safe to echo.
        return _fallback_field_error()

    # Both values are checked rather than trusted. `errors()` is declared as a sequence of
    # `Any`, and a missing or blank value would otherwise put `null` or an empty string into a
    # field the published contract promises is always populated.
    text = raw.get("msg")
    kind = raw.get("type")
    return FieldError(
        field=_field_path(raw.get("loc")),
        message=text if isinstance(text, str) and text else _DETAIL_INVALID_FIELD,
        type=kind if isinstance(kind, str) and kind else _FALLBACK_VALIDATION_TYPE,
    )


def _retry_after_seconds(exc: RateLimitExceeded) -> int:
    """Derive the ``Retry-After`` window, in whole seconds, from slowapi's exception.

    ``exc.limit`` is the ``slowapi.wrappers.Limit`` wrapper, whose own ``limit`` is the parsed
    ``limits.RateLimitItem``, whose ``get_expiry()`` returns the window length in seconds - so
    a configured ``10/minute`` yields ``60``. The attribute is genuinely optional rather than
    defensively typed: ``RateLimitExceeded`` declares ``limit = None`` at class level, so an
    instance constructed without one is representable and must not crash the handler that is
    already responding to a failure.

    Args:
        exc: The exception slowapi raised when the limit was exceeded.

    Returns:
        A positive whole number of seconds, falling back to
        :data:`_DEFAULT_RETRY_AFTER_SECONDS` when no window can be derived. Always positive,
        because ``Retry-After: 0`` invites an immediate retry into the same closed window.
    """
    limit = exc.limit
    if limit is None:
        return _DEFAULT_RETRY_AFTER_SECONDS
    expiry = int(limit.limit.get_expiry())
    return expiry if expiry > 0 else _DEFAULT_RETRY_AFTER_SECONDS


# ---------------------------------------------------------------------------------------
# The five handlers
#
# Every handler takes `(request, exc: Exception)` and narrows with `cast`. That is not
# laziness about types - `starlette.types.HTTPExceptionHandler` is
# `Callable[[Request, Exception], Response | Awaitable[Response]]`, and because callable
# parameters are contravariant, a handler annotated with a narrower exception type is *not*
# assignable to that alias and `add_exception_handler` rejects it under mypy. The cast is
# sound for a reason specific to how dispatch works: Starlette resolves a handler by walking
# `type(exc).__mro__` and taking the first registered class it finds, so a handler registered
# for a class is only ever invoked with an instance of that class or a subclass. Narrowing
# with `isinstance` instead would add a branch that `warn_unreachable` would have to be told
# to tolerate, for a condition that cannot occur.
#
# Each is `async def` so Starlette awaits it directly instead of dispatching it to a thread
# pool, and each returns `ORJSONResponse` to match the application's default response class.
# ---------------------------------------------------------------------------------------


async def _app_error_handler(request: Request, exc: Exception) -> ORJSONResponse:
    """Render an :class:`AppError` - every failure this API reports deliberately.

    Status, ``type``, ``title``, ``detail``, headers and field errors all come from the
    exception, so a service decides the semantics and this handler only renders them.
    Forwarding ``exc.headers`` is what puts :class:`UnauthorizedError`'s
    ``WWW-Authenticate: Bearer`` challenge on the wire.

    Args:
        request: The request being answered.
        exc: The raised exception. Always an :class:`AppError`, by MRO dispatch.

    Returns:
        The problem document at the exception's own status.
    """
    error = cast(AppError, exc)
    return _problem_response(
        request=request,
        status=error.status_code,
        error_type=error.error_type,
        title=error.title,
        detail=error.detail,
        errors=error.errors,
        headers=error.headers,
    )


async def _request_validation_error_handler(request: Request, exc: Exception) -> ORJSONResponse:
    """Render FastAPI's request-validation failure as the same document, with ``errors``.

    Replaces FastAPI's default 422 body, which is shaped ``{"detail": [...]}`` and would be the
    one response in the API that a client had to parse differently. Each entry is reduced by
    :func:`_field_error` to the three publishable fields; ``exc.body`` - the raw submitted
    payload, which on a registration request contains the caller's plaintext password - is
    never read, and neither is any entry's ``input`` or ``ctx``.

    Args:
        request: The request being answered.
        exc: The raised exception. Always a ``RequestValidationError``, by MRO dispatch.

    Returns:
        A 422 problem document whose ``errors`` list is always non-empty.
    """
    error = cast(RequestValidationError, exc)

    # `or [...]` guarantees the criterion "a non-empty errors list" holds unconditionally.
    # FastAPI always supplies at least one entry, but a validation document whose `errors` was
    # an empty list would be self-contradictory, and a client iterating it would silently find
    # nothing to show the user.
    field_errors: list[FieldError] = [_field_error(raw) for raw in error.errors()] or [
        _fallback_field_error()
    ]

    return _problem_response(
        request=request,
        status=HTTPStatus.UNPROCESSABLE_CONTENT,
        error_type=_ERROR_TYPE_VALIDATION,
        title=_TITLE_VALIDATION,
        detail=_DETAIL_REQUEST_VALIDATION,
        errors=field_errors,
    )


async def _http_exception_handler(request: Request, exc: Exception) -> ORJSONResponse:
    """Render a Starlette or FastAPI ``HTTPException`` as the same document.

    This is the handler that retires the legacy surface at the error contract. ``/items`` no
    longer matches a route, so Starlette raises a 404 that would otherwise be served as its own
    ``{"detail": "Not Found"}``; here it renders exactly like a :class:`NotFoundError`, which is
    what ``backend/tests/integration/test_openapi_contract.py`` asserts. The same registration
    covers ``fastapi.HTTPException``, which subclasses this one.

    ``exc.headers`` are forwarded, and that matters for more than tidiness: a 405 arrives from
    the router carrying ``Allow``, and dropping it would leave a method-not-allowed response
    that fails to say which methods *are* allowed.

    One boundary, named because it was considered and deliberately not special-cased. Starlette's
    own default handler branches on 204 and 304 to return a bodiless response, since those
    statuses may not carry one. This handler does not, because neither status can arrive here:
    the framework raises only 4xx and 5xx on its own behalf - 404 and 405 from routing, 401 and
    403 from the security dependencies, 415 from content negotiation - and no route in this API
    raises a framework exception at all, let alone a bodiless status. Adding the branch would buy
    a second response-construction site, and an unreachable one, in exchange for nothing; if a
    bodiless status ever does need raising, it should be *returned* as a ``Response`` rather than
    routed through the error contract.

    Args:
        request: The request being answered.
        exc: The raised exception. Always a ``StarletteHTTPException``, by MRO dispatch. Note
            that ``RateLimitExceeded`` also subclasses it but never arrives here, because its
            own registration is more derived and wins the MRO walk.

    Returns:
        The problem document at the exception's own status.
    """
    error = cast(StarletteHTTPException, exc)
    error_type, title = _problem_for_status(error.status_code)

    # Starlette annotates `detail` as `str` and defaults it to the status phrase, but
    # `fastapi.HTTPException` widens it to `Any`, so a structure is representable at runtime.
    # `str()` honours the contract's `detail: str` for either case without an isinstance branch
    # that mypy would consider unreachable; falling back to the title covers a deliberately
    # empty phrase, so `detail` is never blank.
    detail = str(error.detail) if error.detail else title

    return _problem_response(
        request=request,
        status=error.status_code,
        error_type=error_type,
        title=title,
        detail=detail,
        headers=error.headers,
    )


async def _rate_limit_handler(request: Request, exc: Exception) -> ORJSONResponse:
    """Render slowapi's throttling failure as the same document, plus ``Retry-After``.

    slowapi ships its own handler for this exception; registering it is what
    ``app.core.rate_limit`` explicitly warns against, because it emits slowapi's body and would
    make the 429 the single error in this API that does not match the documented shape. This
    handler exists so that it never has to be.

    The window is put in ``Retry-After``, not in ``detail``. slowapi's own ``exc.detail`` is the
    rendered rate-limit expression - ``"10 per 1 minute"``, which is the ``AUTH_RATE_LIMIT``
    setting read back - and a configuration value does not belong in a response body. The
    header is where a client can act on the number anyway.

    Args:
        request: The request being answered.
        exc: The raised exception. Always a ``RateLimitExceeded``, by MRO dispatch.

    Returns:
        A 429 problem document carrying an integer-valued ``Retry-After`` header.
    """
    error = cast(RateLimitExceeded, exc)
    return _problem_response(
        request=request,
        # slowapi hardcodes 429 on construction; naming the status here keeps this handler's
        # contract readable and independent of that implementation detail.
        status=HTTPStatus.TOO_MANY_REQUESTS,
        error_type=_ERROR_TYPE_RATE_LIMITED,
        title=_TITLE_RATE_LIMITED,
        detail=_DETAIL_RATE_LIMITED,
        headers={_RETRY_AFTER_HEADER: str(_retry_after_seconds(error))},
    )


async def _unhandled_exception_handler(request: Request, exc: Exception) -> ORJSONResponse:
    """Last resort: render any unanticipated exception as a 500 that reveals nothing.

    The body is generic in **every** environment, development included. No exception class
    name, no message, no traceback, no SQL fragment, no configuration value - a caller learns
    that the request failed and nothing else. The incident stays fully diagnosable because the
    exception is logged here with its frames, and because
    ``structlog.contextvars.merge_contextvars`` is the first processor in the configured chain,
    so the request identifier bound by ``app.middleware.request_context`` is already on the
    line. The response header set below is what lets a caller quote that identifier.

    Two Starlette behaviours shape this handler, and both are worth knowing before changing it:

    1. A handler registered for bare ``Exception`` is dispatched by ``ServerErrorMiddleware``,
       which ``build_middleware_stack`` places **outside** everything added with
       ``add_middleware``. ``app.middleware.request_context`` therefore never sees this
       response and cannot attach :data:`REQUEST_ID_HEADER` to it, so this handler attaches it
       - reading the identifier the middleware left on ``request.state`` and omitting the
       header when there is none, which is the case for a failure raised before the middleware
       ran. The middleware and this handler must use the same header name, which is why the
       name is a shared constant here rather than a literal in each.
    2. ``ServerErrorMiddleware`` re-raises after this response has been sent, so the ASGI
       server logs the failure as well. It also bypasses this handler entirely when the
       application is constructed with ``debug=True``, in which case Starlette returns a
       traceback to the client - which is exactly why ``debug`` must stay off outside local
       development.

    Args:
        request: The request being answered.
        exc: The unhandled exception. Logged in full, never rendered.

    Returns:
        A 500 problem document with a generic detail, carrying the correlation header when the
        request has an identifier.
    """
    # Obtained here rather than at module scope on purpose: a logger created while this module
    # is being imported would cache structlog's unconfigured defaults, because `app.main`
    # calls `configure_logging` in its lifespan - after every import has already run.
    logger = get_logger(__name__)

    # `exc_info=exc` is the explicit form of `exc_info=True`. Both work at this call site,
    # since `ServerErrorMiddleware` awaits the handler from inside its own `except Exception as
    # exc` block and `sys.exc_info()` is therefore populated - but passing the exception means
    # the traceback still lands in the log if this is ever called from anywhere else. The
    # configured JSON renderer serialises frames with `show_locals=False`, so a frame holding a
    # password or a signing key cannot be written out with them.
    logger.error(
        "unhandled_exception",
        http_method=request.method,
        http_path=request.url.path,
        exc_info=exc,
    )

    # `object` rather than an inferred `Any`: `starlette.datastructures.State.__getattr__`
    # returns `Any`, and pinning the type here keeps the two uses below honest.
    request_id: object = getattr(request.state, "request_id", None)
    headers = {REQUEST_ID_HEADER: str(request_id)} if request_id else None

    return _problem_response(
        request=request,
        status=HTTPStatus.INTERNAL_SERVER_ERROR,
        error_type=_ERROR_TYPE_INTERNAL,
        title=_TITLE_INTERNAL,
        detail=_DETAIL_INTERNAL,
        headers=headers,
    )


def register_exception_handlers(app: FastAPI) -> None:
    """Install every error handler on the application. Called exactly once, by ``app.main``.

    After this call there is no route in the service that can answer with a body of any other
    shape: the four framework and domain exception families are handled explicitly and bare
    ``Exception`` catches the rest, so the uniform problem document is a property of the
    application rather than a convention each route has to remember.

    Registration is explicit rather than decorator-based so that the whole set is visible in
    one place, in a function that can be applied to a throwaway application and asserted
    against. Dispatch does not depend on the order below - Starlette walks
    ``type(exc).__mro__`` and takes the first registered class, so the most-derived
    registration always wins - and the order is written most-specific-first purely to document
    that specificity. It is also why ``RateLimitExceeded`` reliably reaches its own handler
    despite subclassing ``HTTPException``.

    Registration is by exception class throughout, never by status code. Starlette consults its
    integer status handlers *before* walking the MRO for an ``HTTPException``, so a status-keyed
    registration would quietly take precedence over a class-keyed one and split the contract.

    ``Exception`` is the one key Starlette treats specially: ``build_middleware_stack`` routes
    it to ``ServerErrorMiddleware`` at the very outside of the stack instead of to the inner
    exception middleware. See :func:`_unhandled_exception_handler` for what that implies about
    response headers.

    Args:
        app: The application to install the handlers on. Mutated in place; nothing is returned,
            so a caller cannot accidentally treat this as a factory.
    """
    app.add_exception_handler(AppError, _app_error_handler)
    app.add_exception_handler(RequestValidationError, _request_validation_error_handler)
    app.add_exception_handler(RateLimitExceeded, _rate_limit_handler)
    app.add_exception_handler(StarletteHTTPException, _http_exception_handler)
    app.add_exception_handler(Exception, _unhandled_exception_handler)
