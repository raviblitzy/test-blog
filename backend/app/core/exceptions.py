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
Six fields, always - ``type``, ``title``, ``status``, ``detail``, ``instance`` and
``request_id``, inserted in that order - plus ``errors`` as an optional seventh that appears
only when there is per-field information to report. The shape is fixed; it is not extended per
call site.

.. code-block:: json

    {
      "type": "/errors/not-found",
      "title": "Not Found",
      "status": 404,
      "detail": "Post not found",
      "instance": "/api/v1/posts/does-not-exist",
      "request_id": "b3d0f7a19c4e4f0d8a1c2e5b7d9f0a13"
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
``request_id``
    The correlation identifier for the request that failed, read from
    ``request.state.request_id`` where ``app.middleware.request_context`` put it. Present on
    every error, and always equal to the :data:`REQUEST_ID_HEADER` value on the same response,
    because :func:`_problem_response` writes the body field and the header from one value.
    Correlation is therefore reportable by someone who can quote only what is on screen, while
    remaining machine-readable for anyone joining a response to the structured log lines that
    share the identifier.
``errors``
    Present **only** for a validation failure, and then always non-empty. A list of
    ``{"field": ..., "message": ..., "type": ...}`` objects - see :class:`FieldError`.
    Omitted entirely, rather than sent as ``null``, for every other error.

Those six keys therefore appear on every error response and the seventh on a validation failure
alone, because :func:`_problem_response` is the only place any of them is written.

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

The six handlers
----------------
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
                                     survive, which is how ``WWW-Authenticate``
                                     reaches a 401 - and on a 405 ``Allow`` is
                                     recomputed across every route matching the
                                     path, because the framework's own value names
                                     only the one route that raised.
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
imports the standard library, FastAPI, Starlette, slowapi, ``sqlalchemy.exc`` and
``app.core.logging`` - nothing else, and in particular **not** ``app.schemas``. The SQLAlchemy
import is one exception class, ``IntegrityError``, for :func:`integrity_constraint_name`, and it
adds no edge to the graph that ``app.core.dependencies`` does not already have: no model, no
session and no query is imported, and nothing here touches the database. That asymmetry is
deliberate rather than tidy: ``app.schemas.common`` declares the Pydantic model of this document
for the OpenAPI surface and therefore may import from ``app.core``, so an import back the other
way would close a cycle. The handlers here build the body as a plain dict instead, which is also why
there is exactly one function in the codebase that assembles a problem document.
"""

import re
from collections.abc import Collection, Iterable, Iterator, Mapping, Sequence, Set as AbstractSet
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

# Reached through the Starlette that FastAPI pins and installs, and each of the three has no
# FastAPI-surface equivalent to prefer. `StarletteHTTPException` is the BASE class - FastAPI's own
# `HTTPException` is a subclass, and it is the base that the router itself raises for an unmatched
# path or method, so a handler registered on the subclass would not see a 404 or a 405 at all.
# `Match` and `ExceptionHandler` are re-exported nowhere under `fastapi`. None of the three is a
# reason to declare starlette directly in `backend/pyproject.toml`: see that file for why.
from sqlalchemy.exc import DataError, IntegrityError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.routing import Match
from starlette.types import ExceptionHandler

from app.core.logging import (
    HTTP_LOG_FIELD_METHOD,
    HTTP_LOG_FIELD_PATH,
    HTTP_LOG_FIELD_STATUS,
    LOG_EXCEPTION_VALUE_MAX_LENGTH,
    get_logger,
    log_safe_text,
    redact_sensitive_text,
)

__all__ = [
    "CORS_EXPOSE_HEADERS",
    "PROBLEM_JSON_MEDIA_TYPE",
    "REQUEST_ID_CONTEXT_KEY",
    "REQUEST_ID_HEADER",
    "REQUEST_ID_MAX_LENGTH",
    "RETRY_AFTER_HEADER",
    "WWW_AUTHENTICATE_HEADER",
    "AppError",
    "AppValidationError",
    "ConflictError",
    "FieldError",
    "ForbiddenError",
    "InvalidTokenError",
    "NotFoundError",
    "RequestBodyTooLargeError",
    "TokenExpiredError",
    "UnauthorizedError",
    "inner_exception_handlers",
    "integrity_constraint_name",
    "is_usable_request_id",
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
import the name from here rather than repeat the literal, so the two cannot drift apart.

Every error response sets it here as well, in :func:`_problem_response`, from the same value it
writes into the document's ``request_id`` member - which is what makes the header and the body
provably equal rather than coincidentally equal. It also covers the one case the middleware
cannot reach: Starlette dispatches a handler registered for bare ``Exception`` through
``ServerErrorMiddleware``, which wraps the *outside* of the stack - outside everything added
with ``add_middleware`` - so on that path nothing else would attach the header.
"""

# ---------------------------------------------------------------------------------------
# The CORS headers the outer 500 has to write for itself
#
# These are header NAMES and one header VALUE, not policy. The policy - which origins are
# admitted, and whether credentials may be paired with them - lives entirely in
# `app.core.config`, and `_cors_headers_for` reads it from `settings` rather than deciding
# anything here. That function's docstring explains why this one response cannot simply be left
# to `CORSMiddleware`.
# ---------------------------------------------------------------------------------------

_CORS_ALLOW_ORIGIN_HEADER: Final[str] = "Access-Control-Allow-Origin"
_CORS_ALLOW_CREDENTIALS_HEADER: Final[str] = "Access-Control-Allow-Credentials"
_CORS_EXPOSE_HEADERS_HEADER: Final[str] = "Access-Control-Expose-Headers"
_CORS_ALLOW_CREDENTIALS_VALUE: Final[str] = "true"

_ORIGIN_REQUEST_HEADER: Final[str] = "Origin"
"""The request header whose presence makes a response cross-origin."""

_VARY_HEADER: Final[str] = "Vary"
"""Set to ``Origin`` whenever the response body or headers depend on the requesting origin.

Required for correctness rather than politeness: a shared cache that stored one origin's 500 and
replayed it to another would replay the ``Access-Control-Allow-Origin`` header with it.
"""

_CORS_WILDCARD_ORIGIN: Final[str] = "*"
"""The literal written when the deployment admits every origin.

The *decision* is ``settings.cors_wildcard_origin``; this is only the value that decision emits,
kept as a named constant so the string appears once.
"""

_REQUEST_ID_STATE_KEY: Final[str] = "request_id"
"""Name of the request-scope state attribute holding the correlation identifier.

Private, and the only spelling of the attribute on this side of the boundary.
``app.middleware.request_context`` writes it under its own public ``REQUEST_ID_CONTEXT_KEY``,
which is the same string; the two are not shared through an import because that module already
imports :data:`REQUEST_ID_HEADER` from here and the dependency has to stay one-way. See
:func:`_request_id`.
"""

REQUEST_ID_CONTEXT_KEY: Final[str] = "request_id"
"""Key the identifier is bound under, in *structlog*'s context and in ``scope["state"]`` alike.

Declared here for the same reason as the header name, and it is the same contract seen from a
different side. ``app.middleware.request_context`` binds it with ``bind_contextvars`` - which is
what puts it on every line every layer writes during a request - and writes it into
``scope["state"]``; this module reads it back off ``request.state`` for the one response
rendered outside that middleware, and uses it as the field name when it logs, so the middleware's
access record and this module's 500 record carry the identifier under one key.
"""

REQUEST_ID_MAX_LENGTH: Final[int] = 128
"""Longest identifier accepted, inbound or read back out of request state.

Generous for any real tracing scheme - a UUID, a hex string, a W3C trace identifier all fit -
and bounded, because the value is echoed into a response header and written into a log field.
"""

_REQUEST_ID_ALLOWED: Final[re.Pattern[str]] = re.compile(r"[A-Za-z0-9._-]+")
"""Characters an identifier may consist of, and implicitly that it must be non-empty.

Deliberately narrower than either grammar strictly requires, because the value ends up in two
places where a control character does damage: a response header value, where a carriage return
or newline lets a caller inject a header of their choosing, and a log line, where the same
characters let them forge a record.
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
_DETAIL_REQUEST_BODY_TOO_LARGE: Final[str] = "The request body is larger than this API accepts."
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

# Substituted for the `detail` of ANY raised HTTPException whose status is 5xx, in every
# environment, so that the "a server error reveals nothing" guarantee holds for the whole
# 5xx range rather than only for an exception that reached the handler of last resort.
#
# It has to be a substitution rather than a pass-through because `HTTPException.detail` is
# caller-supplied text, and on a 5xx the caller is not a route in this API - no route here
# raises a framework exception - but the framework, a dependency, or an operational probe.
# `/readyz` raising `HTTPException(503, str(error))` after a failed connection attempt is the
# concrete case: psycopg's message names the host, the port, the database and the user it
# tried, which is a topology and credential disclosure served to an unauthenticated caller.
# Distinct from _DETAIL_INTERNAL so that the two paths remain legible in a log and to a
# client: this one is a deliberate refusal at a known status, that one is an unanticipated
# failure. Neither carries anything the caller can learn from.
_DETAIL_SERVER_ERROR: Final[str] = "The server could not complete the request."

# Substituted when a validation entry carries no usable message, so `errors` is never empty
# and never carries `None`. It quotes nothing the caller submitted.
_DETAIL_INVALID_FIELD: Final[str] = "This value is invalid."

# The 400 body for a value the storage layer refuses outright - see `_data_error_handler`. It
# names no column, no type, no driver and no statement: the caller learns that a value they
# sent could not be handled, and the classification goes to the structured log. Worded to be
# actionable without being specific, because the boundary validators name the field for every
# case that is expected to occur and this is the residue.
_DETAIL_DATA_ERROR: Final[str] = "The request contained a value that could not be processed."

# ---------------------------------------------------------------------------------------
# Which data exceptions are the caller's fault
#
# `DataError` covers the whole of SQLSTATE class 22, and the class alone says nothing about
# WHOSE value failed. The four codes below are the ones that, in THIS schema, only a submitted
# value can produce - so they are the ones `_data_error_handler` answers 400 for, and every
# other class-22 condition is left to the 500 owner with its traceback intact.
#
# The reasoning is per code, and it is a property of the schema rather than of the codes:
#
#   22001 string_data_right_truncation   A value longer than the column can hold. Every text
#                                       column here is unbounded `text` or `citext`, so this
#                                       cannot be provoked by anything this service derives -
#                                       it takes a submitted value against a length the
#                                       storage layer imposes.
#   22021 character_not_in_repertoire    A byte sequence the server encoding cannot represent.
#   22P05 untranslatable_character       The same condition on the way out of a conversion.
#                                       Both require text this service did not compose: it
#                                       writes ASCII identifiers and slugs, and everything
#                                       else it stores came from a request body.
#   22P02 invalid_text_representation    A value that could not be parsed as its target type.
#                                       Every cast in this API is applied to a bound parameter
#                                       - a UUID, an enum member, a timestamp - and every one
#                                       of those parameters arrives from the request.
#
# Deliberately ABSENT, and the two that make the case: `22012 division_by_zero` and `2201B
# invalid_regular_expression` are properties of the STATEMENT, and this API composes every
# statement itself and accepts no caller-supplied expression or pattern. A 400 for either would
# report a defect in this code as the caller's mistake. `22003 numeric_value_out_of_range`,
# `22007 invalid_datetime_format` and `22008 datetime_field_overflow` are absent for the
# adjacent reason: the numbers and instants this schema writes - `view_count`, `published_at`,
# both audit timestamps - are derived by the service or by the database clock, so a range or
# format failure in one of them is far more likely to be a bug here than a submitted value.
# ---------------------------------------------------------------------------------------
_REQUEST_CAUSED_DATA_SQLSTATES: Final[frozenset[str]] = frozenset(
    {
        "22001",
        "22021",
        "22P02",
        "22P05",
    }
)

# psycopg's client-side refusal of a NUL byte in a bound text parameter. It is raised before the
# statement reaches the server, so it carries NO SQLSTATE - which is why it needs recognising by
# phrase rather than by code, and why `_data_error_is_request_caused` explains at length that a
# NUL is nonetheless of certain request provenance: PostgreSQL cannot STORE one, so it can never
# have come back out of a column. Matched loosely on the invariant part of psycopg 3.3.4's
# wording ("PostgreSQL text fields cannot contain NUL (0x00) bytes") so a punctuation change does
# not break it; a wholesale rewording makes this stop matching, and the failure is then a logged
# 500 rather than a misfiled 400.
_NUL_PARAMETER_PATTERN: Final[re.Pattern[str]] = re.compile(r"(?i)cannot contain nul")


# ---------------------------------------------------------------------------------------
# Header and validation-mapping constants
# ---------------------------------------------------------------------------------------

WWW_AUTHENTICATE_HEADER: Final[str] = "WWW-Authenticate"
"""The RFC 6750 challenge header this module sends with every 401.

Public, and imported by ``app.main`` rather than repeated there, because a browser cannot read
a response header the service does not name in its CORS ``expose_headers`` list. A client that
cannot see this header cannot distinguish "sign in" from "you are signed in and still refused",
which is the distinction the challenge exists to carry - so the header name and the list that
exposes it have to be the same string, and it is declared here beside the handler that writes it.
"""

_BEARER_CHALLENGE: Final[str] = "Bearer"

ALLOW_HEADER: Final[str] = "Allow"
"""The RFC 9110 §10.2.1 header listing the methods a resource supports, sent with every 405.

Public because the value this module writes has to be the whole truth about a path, and the
truth is not knowable from the one route that raised. Starlette evaluates each ``Route``
independently and builds ``Allow`` from that route's own methods, so ``/api/v1/posts`` -
served by one route for ``GET`` and another for ``POST`` - answered ``Allow: GET`` to a
``DELETE`` and told the caller that ``POST`` did not exist, contradicting the service's own
published document. :func:`_allowed_methods` recomputes it across every route that matches the
path; see that function for how.
"""

_METHOD_ORDER: Final[tuple[str, ...]] = (
    "GET",
    "HEAD",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
    "TRACE",
    "CONNECT",
)
"""Canonical order for rendering an ``Allow`` list.

RFC 9110 places no ordering requirement on the header - a client parses it as a set - so the
order is chosen for the reader: safe methods first, then the mutations in the order this API's
routers declare them. It is fixed rather than incidental because a set's iteration order is
not stable between processes, and a header whose value varied between two identical requests
would make the response impossible to assert on and pointless to cache.
"""

_ALLOW_HEADER_SEPARATOR: Final[str] = ", "
"""Separator for the ``Allow`` list, per the RFC's comma-delimited list production."""

_ALLOW_HEADER_KEY: Final[str] = ALLOW_HEADER.lower()
"""Case-folded header name, for replacing an inbound ``Allow`` whatever case it arrived in."""

RETRY_AFTER_HEADER: Final[str] = "Retry-After"
"""The delay header sent with a 429 from the rate-limited authentication routes.

Public for the same reason as :data:`WWW_AUTHENTICATE_HEADER`: ``app.main`` names it in CORS
``expose_headers`` so that browser code can honour the interval instead of retrying immediately
and being refused again. Every authentication route is rate limited, so this is reachable on the
ordinary sign-in path rather than only under attack.
"""

CORS_EXPOSE_HEADERS: Final[tuple[str, ...]] = (
    REQUEST_ID_HEADER,
    RETRY_AFTER_HEADER,
    WWW_AUTHENTICATE_HEADER,
)
"""Response headers a browser is permitted to read from a cross-origin response.

A browser exposes only the CORS-safelisted response headers to script unless the server names
the rest, so anything the client is expected to ACT on has to appear here:

* ``X-Request-ID`` - the correlation identifier, otherwise set on every response and hidden from
  the very client that would quote it in a bug report.
* ``Retry-After`` - sent with every 429 from the rate-limited authentication routes. A sign-in
  form that cannot read it retries immediately and is refused again, which reads to the person at
  the keyboard as a broken form.
* ``WWW-Authenticate`` - sent with every 401. Without it browser code cannot distinguish "present
  a credential" from "your credential was refused", which is the distinction that decides whether
  the client rotates its token or abandons the session.

Declared here rather than in ``app.main`` because there are **two** writers of it and they must
agree. ``app.main`` passes it to ``CORSMiddleware`` as ``expose_headers`` for every ordinary
response; :func:`_outer_response_headers` writes it by hand on the one response that never
reaches that middleware - the 500 rendered by ``ServerErrorMiddleware``, which wraps the outside
of the stack. Two hand-maintained lists would drift, and the drift would be invisible until
someone tried to read the header off a 500. It is declared after the two header names it
includes, because a module-level tuple can only reference what is already bound.
"""

_CORS_EXPOSE_HEADERS_VALUE: Final[str] = ", ".join(CORS_EXPOSE_HEADERS)
"""The rendered ``Access-Control-Expose-Headers`` value, joined once from the tuple above."""

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
# Pydantic union case labels, which are NOT part of a field path
#
# When a value fails every member of a union, pydantic-core reports one entry per member and
# inserts that member's CASE LABEL into `loc` immediately after the field name. The label is
# the internal core-schema name of the member, so a caller submitting a bad `display_name`
# against `DisplayName | SkipJsonSchema[None]` gets locations
# `("body", "display_name", "constrained-str")` and `("body", "display_name", "none")` - and a
# path rendered from those verbatim names nothing the client submitted. Worse, some labels
# quote implementation identifiers outright: `function-after[_require_content(),
# constrained-str]` is a private validator's name and `str-enum[UserRole]` is an enum class's,
# neither of which belongs in a response body.
#
# `ValidationErrorItem.field` promises "the syntax the client's form library already consumes,
# so a server-side rejection can be attached to the control that produced it", so these labels
# are dropped by :func:`_field_path`. Recognition is by NAME rather than by shape, and that is
# the whole reason this set is enumerated: `bool` and `none` are label-shaped *and*
# identifier-shaped, while a legitimate nested member name like `slug` is identifier-shaped
# too - so no pattern over the characters of a segment can separate them. Matching against the
# core-schema vocabulary can, because that vocabulary is closed.
#
# The parameterised labels - `list[uuid]`, `str-enum[UserRole]`, `function-after[...]` - are
# matched on the name before their bracket, so the set holds the stem only.
# ---------------------------------------------------------------------------------------

_CORE_SCHEMA_TAG_NAMES: Final[frozenset[str]] = frozenset(
    {
        # Scalars and the null case, which is the one every optional-but-not-nullable member
        # contributes.
        "none",
        "null",
        "any",
        "str",
        "bytes",
        "int",
        "float",
        "bool",
        "complex",
        "decimal",
        "date",
        "time",
        "datetime",
        "timedelta",
        "uuid",
        "url",
        "multi-host-url",
        "path",
        "enum",
        "literal",
        # Containers.
        "list",
        "set",
        "frozenset",
        "tuple",
        "dict",
        "generator",
        # Structures.
        "model",
        "model-fields",
        "dataclass",
        "dataclass-args",
        "typed-dict",
        "arguments",
        "call",
        "callable",
        # Wrappers and combinators.
        "nullable",
        "union",
        "tagged-union",
        "chain",
        "default",
        "definitions",
        "definition-ref",
        "json",
        "json-or-python",
        "lax-or-strict",
        "is-instance",
        "is-subclass",
        # Constrained scalars, which `StringConstraints` and its siblings produce.
        "constrained-str",
        "constrained-bytes",
        "constrained-int",
        "constrained-float",
        "constrained-decimal",
        "constrained-date",
        "constrained-datetime",
        "constrained-time",
        "constrained-timedelta",
        # Validator wrappers, whose parameters quote private function names.
        "function-after",
        "function-before",
        "function-wrap",
        "function-plain",
        # Enum wrappers, whose parameters quote enum class names.
        "str-enum",
        "int-enum",
        "float-enum",
    }
)

_TAG_PARAMETER_OPEN: Final[str] = "["
"""Character introducing a case label's parameter list, as in ``list[uuid]``."""

_FIELD_PATH_SEPARATOR: Final[str] = "."
"""Separator between the segments of a published field path.

The dotted syntax form libraries already consume, so ``categories.0.slug`` addresses the
``slug`` control of the first element. Named once because two places depend on it: the join in
:func:`_field_path`, and the "is this path nested under that member" test in
:func:`_field_errors`.
"""

_NONE_REQUIRED_VALIDATION_TYPE: Final[str] = "none_required"
"""Pydantic's error type for "this member must be null", reported per union member.

Every optional-but-not-nullable member in ``app.schemas`` is declared as ``T |
SkipJsonSchema[None]``, so a value that fails ``T`` also fails the ``None`` member and pydantic
reports both. The second entry reads ``Input should be None`` - which contradicts this API's
own rule, since those members reject an explicit null with a validator of their own. Publishing
it would tell a client to send a value the service refuses, so :func:`_field_errors` suppresses
it whenever the same field already carries an actionable entry.
"""


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
    {WWW_AUTHENTICATE_HEADER: _BEARER_CHALLENGE}
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


def integrity_constraint_name(
    error: IntegrityError,
    *,
    sqlstates: Collection[str],
) -> str | None:
    """Name the database constraint an integrity failure violated, or ``None`` to re-raise it.

    **The one place a service is allowed to ask "which invariant failed?", and the reason no
    service may answer it from the exception's message.** Every service that inserts a row can lose
    a race, and each needs to translate *its own* recognised races into a domain conflict while
    letting everything else propagate as the defect it is. Written once here because the answer
    depends on two driver details that are easy to get wrong independently: which SQLSTATE the
    server assigned, and the constraint name it reported alongside it.

    Both are required, and the pairing is the safety. Matching only the name would let a
    differently-classed failure that happens to mention the same object satisfy the test; matching
    only the SQLSTATE would collapse every unique violation in the schema into one, so a service
    would report "that title is taken" for a duplicate email. Matching neither - a substring search
    of ``str(error)`` - depends on the server's locale and on wording that is free to change
    between releases, and would also mean reading a message that embeds the failing statement.

    Failing closed is deliberate: a driver that exposes no ``diag``, a SQLSTATE outside
    *sqlstates*, or a missing constraint name all yield ``None``, which callers treat as "re-raise
    untouched". An unrecognised integrity failure is a defect, and a defect must surface as a
    ``500`` with frames rather than as a plausible-looking conflict a client would retry forever.

    Args:
        error: The failure SQLAlchemy raised. Its ``orig`` is the driver's own exception, which is
            where the diagnostics live; ``psycopg`` populates ``diag.constraint_name`` from the
            server's error fields.
        sqlstates: The SQLSTATE classes the caller is willing to translate. ``23505``
            (``unique_violation``) and ``23503`` (``foreign_key_violation``) are the two a
            concurrent request can cause. ``23514`` (``check_violation``) and ``23502``
            (``not_null_violation``) belong in no caller's set: both mean the service assembled a
            row it should not have.

    Returns:
        The constraint name PostgreSQL reported, when the SQLSTATE is one the caller accepts;
        ``None`` otherwise.

    Examples:
        >>> # In a service, with its own allow-list of recognised constraints:
        >>> # constraint = integrity_constraint_name(error, sqlstates=frozenset({"23505"}))
        >>> # if constraint not in _MY_RACES: raise
        pass
    """
    driver_error = error.orig
    diagnostic = getattr(driver_error, "diag", None)
    if diagnostic is None:
        return None
    if getattr(driver_error, "sqlstate", None) not in sqlstates:
        return None
    constraint = getattr(diagnostic, "constraint_name", None)
    return constraint if isinstance(constraint, str) else None


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


class RequestBodyTooLargeError(AppError):
    """413 - the request body exceeds the configured ceiling, so it was not read.

    Raised by ``app.middleware.body_limit``, and by nothing else: no service and no route decides
    this, because the decision has to be made *before* a body is parsed and therefore before any
    route is reached. The middleware raises it in two places - once from the declared
    ``Content-Length``, before the application is called at all, and once from the running total of
    a body that declared no length - and both spellings produce this one status and this one
    document.

    The detail names no number. A ceiling stated in an error response tells a caller exactly how
    large a body to send to sit just underneath it, which is the one thing the ceiling exists to
    prevent being probed for; the published limit belongs in the API documentation, where it is a
    contract rather than a hint returned to whoever was testing it.
    """

    status_code: int = HTTPStatus.CONTENT_TOO_LARGE
    error_type: str = _ERROR_TYPE_CONTENT_TOO_LARGE
    title: str = _TITLE_CONTENT_TOO_LARGE
    detail: str = _DETAIL_REQUEST_BODY_TOO_LARGE


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

    A distinct class so that ``app.core.security`` can raise precisely, and so that a reader of
    a traceback or a server-side log line knows which decode check failed. It is **not** a
    distinct branch for a client, and that is worth stating plainly because it would be easy to
    assume otherwise: ``type`` stays ``/errors/unauthorized`` and ``title`` stays
    ``Unauthorized``, exactly as for :class:`InvalidTokenError`, so the two are
    indistinguishable to the one field a client is documented to switch on. Only the human
    prose in ``detail`` differs.

    Every 401 is therefore a single machine branch, and the client behaviour it drives is
    uniform: ``frontend/src/lib/api/client.ts`` attempts a refresh once on any 401 and falls
    back to sign-in if that attempt is itself refused. Nothing has to guess from prose whether
    refreshing is worth trying, which is the only reason a caller would have wanted the
    distinction - and publishing it would tell an attacker which check their token failed.
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


def _request_id(request: Request) -> str:
    """Read the correlation identifier ``app.middleware.request_context`` bound to the request.

    That middleware resolves one identifier per request - echoing a usable inbound
    :data:`REQUEST_ID_HEADER` or generating a fresh value - binds it for structured logging and
    writes it into the request scope's state before forwarding. Reading it back here is what
    lets the document's ``request_id`` member and the response header carry the identifier that
    every log line for the same request already carries.

    The state attribute is read by name rather than imported: ``app.middleware.request_context``
    imports :data:`REQUEST_ID_HEADER` from this module, so the dependency runs in that direction
    only and importing its ``REQUEST_ID_CONTEXT_KEY`` back would make the pair circular.
    :data:`_REQUEST_ID_STATE_KEY` is the single spelling of the attribute on this side.

    Args:
        request: The request being answered.

    Returns:
        The identifier, or ``""`` when no middleware bound one. Empty is unreachable in the
        assembled application - ``app.main`` installs the middleware for every route - so it
        covers only a ``Request`` constructed directly, as a unit test does.
    """
    # `object` rather than an inferred `Any`: `starlette.datastructures.State.__getattr__`
    # returns `Any`, and pinning the type here keeps the narrowing below honest.
    bound: object = getattr(request.state, _REQUEST_ID_STATE_KEY, None)
    return bound if isinstance(bound, str) else ""


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
        request: The request being answered. Two things are read from it: ``request.url.path``,
            which becomes the ``instance`` field, and the bound correlation identifier, which
            becomes the ``request_id`` field and the :data:`REQUEST_ID_HEADER` value.
        status: HTTP status for both the response and the document's ``status`` field, so the
            two cannot disagree - they are the same argument.
        error_type: Stable ``/errors/...`` URI reference for the ``type`` field.
        title: Stable human-readable summary of the error class.
        detail: Instance-specific message. Must already be safe to show a client.
        errors: Per-field detail. When ``None`` **or empty** the ``errors`` key is omitted
            entirely rather than serialised as ``null`` or as ``[]``, which keeps the key set
            of a non-validation document at exactly six. Both absences are normalised here, at
            the single assembly site, so ``app.schemas.common.ProblemDetail`` can declare the
            member as optional-but-never-null-and-never-empty and have that be the exact
            emitted contract rather than a superset of it: an empty list would otherwise be a
            self-contradictory validation document that a client could iterate and find nothing
            in.
        headers: Response headers to attach - a ``WWW-Authenticate`` challenge, an ``Allow``
            list preserved from a 405, or a ``Retry-After`` window. A caller never has to pass
            the correlation header: this function attaches it.

    Returns:
        An :class:`ORJSONResponse` carrying the document at :data:`PROBLEM_JSON_MEDIA_TYPE`.
    """
    # Coerced once, then used for both the document's `status` field and the response's own
    # status. Callers pass `HTTPStatus` members because they read better at the call site, and
    # narrowing to a plain int here means neither the serialised field nor the status line
    # depends on how an IntEnum is rendered - and, more importantly, that the two are the same
    # value by construction rather than by two callers agreeing.
    status_code = int(status)

    # Read once, then written to two places. The body member and the header are therefore the
    # same value by construction: a support request that quotes what is on screen and a log
    # query that filters on the header cannot land on different requests.
    request_id = _request_id(request)

    # Insertion order is the wire order, and it is the order the document is documented in:
    # type, title, status, detail, instance, request_id, then errors.
    body: dict[str, object] = {
        "type": error_type,
        "title": title,
        "status": status_code,
        "detail": detail,
        # The path only. A query string is excluded on every path - deliberately and
        # uniformly - because it is not part of the failure's identity and is a place stray
        # credentials end up.
        "instance": request.url.path,
        "request_id": request_id,
    }
    # Truthiness rather than `is not None`, so an empty sequence is normalised away exactly as
    # `None` is. See the `errors` argument above for why an empty list must never be emitted.
    if errors:
        body["errors"] = list(errors)

    # Copied rather than mutated: `headers` belongs to the caller, and several call sites pass
    # a mapping built from an exception's own attributes.
    response_headers = dict(headers) if headers else {}
    if request_id:
        # Assigned here for every error response, which covers the 500 path that
        # `RequestContextMiddleware` cannot reach - see :data:`REQUEST_ID_HEADER` - and makes
        # the header equal to the body member everywhere else by construction rather than by
        # two components agreeing.
        response_headers[REQUEST_ID_HEADER] = request_id

    return ORJSONResponse(
        content=body,
        status_code=status_code,
        # `or None` so an empty mapping is normalised away rather than reaching Starlette as
        # an empty header block.
        headers=response_headers or None,
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


def _is_core_schema_tag(part: str) -> bool:
    """Report whether one ``loc`` segment is a pydantic union case label rather than a name.

    The test is a membership check against :data:`_CORE_SCHEMA_TAG_NAMES`, performed on the
    text before any parameter list, so ``list[uuid]`` is recognised by ``list`` and
    ``function-after[_require_content(), constrained-str]`` by ``function-after``. See that
    constant for why recognition cannot be done by shape.

    Args:
        part: One already-stringified segment of a ``loc`` tuple.

    Returns:
        Whether the segment names a core-schema case rather than a submitted member.
    """
    stem = part.split(_TAG_PARAMETER_OPEN, 1)[0]
    return stem in _CORE_SCHEMA_TAG_NAMES


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

    Union case labels are dropped, and that is what keeps the promise above true
    -----------------------------------------------------------------------------
    Every optional member in ``app.schemas`` is a union - ``T | SkipJsonSchema[None]`` - so a
    rejected value produces one entry per member with pydantic's internal case label inserted
    after the field name. Rendered verbatim, ``("body", "display_name", "constrained-str")``
    reports as ``display_name.constrained-str``, which is not a path any form control answers
    to, and ``("body", "content", "function-after[_require_content(), constrained-str]")``
    additionally publishes a private validator's name. Both are removed here, so those two
    locations report as ``display_name`` and ``content``.

    Two rules bound the removal, and each exists to protect a location that is already correct:

    * **The first segment after the marker is never dropped.** It is the submitted member's own
      name, and for an ``extra="forbid"`` rejection it is a name the *caller* chose - so a body
      carrying ``{"my-field": 1}`` still reports ``my-field`` rather than an empty path.
    * **Integer indices are never dropped**, because they address an element the caller sent.
      ``("body", "category_ids", "list[uuid]", 0)`` therefore reports as ``category_ids.0``,
      with the label removed from between them.

    A location made up entirely of labels after its first segment is left as it arrived, which
    cannot happen for any schema in this service and is handled rather than assumed: reporting
    an empty path would be strictly worse than reporting an internal one.

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
    if len(parts) > 1:
        # `parts[:1]` rather than `[parts[0]]` so the member name survives untested, and
        # `isdigit()` so an index reads as an index even though it arrived as a string.
        named = parts[:1] + [
            part for part in parts[1:] if part.isdigit() or not _is_core_schema_tag(part)
        ]
        parts = named
    return _FIELD_PATH_SEPARATOR.join(parts)


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


def _has_actionable_entry(field: str, actionable: AbstractSet[str]) -> bool:
    """Report whether a field, or anything nested under it, already has a usable error.

    The test :func:`_field_errors` needs in order to decide that a null companion is redundant,
    and it is a prefix test rather than an equality test because the two entries a union
    produces do not always name the same path. A bad element inside ``category_ids`` is reported
    at ``category_ids.0`` - the index belongs to the caller and is kept - while the companion is
    reported at ``category_ids``. Comparing only for equality would leave "Input should be None"
    attached to the list whose element the caller has just been told to correct.

    Args:
        field: The path the null companion named.
        actionable: The paths of every entry the caller can act on.

    Returns:
        Whether ``field`` itself, or a path nested beneath it, is among them.
    """
    prefix = field + _FIELD_PATH_SEPARATOR
    return any(other == field or other.startswith(prefix) for other in actionable)


def _field_errors(raw_errors: Sequence[object]) -> list[FieldError]:
    """Reduce a whole validation failure to one actionable entry per problem.

    :func:`_field_error` normalises entries one at a time; this function is where the *set* of
    them is made coherent, which takes two passes that a per-entry function cannot perform.

    **The null companion is suppressed.** Because every optional member in ``app.schemas`` is
    declared ``T | SkipJsonSchema[None]``, pydantic reports the real failure *and* a
    :data:`_NONE_REQUIRED_VALIDATION_TYPE` entry reading ``Input should be None``. That second
    entry is not merely noise - it is wrong: those members reject an explicit null with a
    validator of their own, so a client that followed the advice would be refused again. It is
    dropped for any field that already carries an actionable entry, leaving one member to one
    error. It is *kept* when it is the only thing reported for that field, which would mean the
    API genuinely required null there, because publishing nothing would be worse than
    publishing something surprising.

    **Duplicates collapse.** Once case labels are stripped from the paths, two entries that
    differed only by which union member produced them can render identically. The response
    should not repeat itself, so an exact repeat of ``(field, message, type)`` is emitted once.
    Order is otherwise preserved, so the first failure pydantic found is still the first one a
    form shows.

    Args:
        raw_errors: ``exc.errors()`` from a ``RequestValidationError``. Typed as a sequence of
            ``object`` because that method is declared as a sequence of ``Any``; each element is
            validated by :func:`_field_error`.

    Returns:
        A non-empty list. Every guarantee the published schema makes about ``errors`` holds
        unconditionally: at least one entry, and all three of its fields populated.
    """
    entries = [_field_error(raw) for raw in raw_errors]

    # Which fields have something the caller can act on. Computed over the whole list first,
    # because the actionable entry for a field can follow its null companion.
    actionable = {
        entry["field"] for entry in entries if entry["type"] != _NONE_REQUIRED_VALIDATION_TYPE
    }

    deduplicated: list[FieldError] = []
    seen: set[tuple[str, str, str]] = set()
    for entry in entries:
        if entry["type"] == _NONE_REQUIRED_VALIDATION_TYPE and _has_actionable_entry(
            entry["field"], actionable
        ):
            continue
        signature = (entry["field"], entry["message"], entry["type"])
        if signature in seen:
            continue
        seen.add(signature)
        deduplicated.append(entry)

    # `or [...]` guarantees the criterion "a non-empty errors list" holds unconditionally.
    # FastAPI always supplies at least one entry and the filtering above cannot remove every
    # one of them, but a validation document whose `errors` was an empty list would be
    # self-contradictory: a client would iterate it, find nothing, and have nothing to show.
    return deduplicated or [_fallback_field_error()]


def _route_leaves(routes: Iterable[object]) -> Iterator[object]:
    """Flatten an application's route table down to the entries that can match a request.

    ``app.routes`` is not flat. FastAPI 0.141.1 represents every ``include_router`` call as one
    opaque entry that resolves its children - and their prefixes, tags and dependencies - only
    when asked, so a handful of top-level entries stand for the whole matchable surface. Two of
    them are inclusions - the versioned aggregate and the health router - and between them they
    expand to every service operation this API serves: those beneath ``/api/v1`` plus the two
    unversioned probes. The documentation routes beside them are ordinary Starlette routes, and
    how many there are is environment-dependent rather than fixed: ``/openapi.json`` is always
    served, while ``/docs``, its OAuth2 redirect and ``/redoc`` are withdrawn in production. No
    total is stated here for either reason - the count varies by environment, and a numeral in a
    docstring is a second declaration of something the route table already states.
    ``backend/tests/integration/test_openapi_contract.py`` holds the single authoritative
    enumeration, asserted against ``app.openapi()``. A walk that read ``methods`` off the top
    level would see the documentation routes and nothing else.

    An inclusion is recognised by behaviour rather than by class - the presence of a callable
    that yields its members with their effective paths already applied - so this survives the
    layout changing back: were routes flattened into ``app.routes`` again, every entry would fail
    that test, be yielded as a leaf, and match on its own.

    A ``Mount`` is deliberately **not** descended into. It declares no methods, so it contributes
    nothing here, and its children's paths are relative to the mount point: matching them against
    a full request path would be meaningless, and a coincidental match would attribute a mounted
    application's method to this one. A mounted application answers its own 405 with its own
    ``Allow``, which is the correct owner of that answer.

    Args:
        routes: The route table to flatten, at any level.

    Yields:
        One entry per candidate, in declaration order. Each is expected to expose ``methods`` and
        ``matches``; anything that does not is skipped by the caller rather than filtered here,
        so this function stays a pure flattening.
    """
    for route in routes:
        expand = getattr(route, "effective_route_contexts", None)
        if callable(expand):
            expanded = expand()
            if isinstance(expanded, Iterable):
                yield from expanded
                continue
        yield route


def _allowed_methods(request: Request) -> str | None:
    """Build the ``Allow`` value for a 405 from every route that matches the requested path.

    Starlette cannot answer this question, and that is the reason this function exists.
    ``Route.handle`` raises the 405 with ``Allow`` set from the methods of *that one route*, but
    a path in this API is routinely served by two of them - ``GET`` and ``POST`` on
    ``/api/v1/posts``, ``PUT`` and ``DELETE`` on ``/api/v1/posts/{post_id}/like``, ``PATCH`` and
    ``DELETE`` on ``/api/v1/comments/{comment_id}`` - because a router registers one decorated
    handler per method. Whichever route the matcher reached first supplied the header, so a
    ``DELETE /api/v1/posts`` was answered ``Allow: GET`` and a client reading it concluded that
    ``POST /api/v1/posts`` did not exist, contradicting the same service's ``/openapi.json``.
    RFC 9110 §15.5.6 requires the header to carry the target resource's supported methods, so
    the union across matching routes is the only correct value.

    The route's own ``matches`` is the discriminator rather than a path comparison of this
    module's own: it is the same predicate the router used, so a parameterised path, a converter
    and a trailing-slash redirect route are all judged exactly as the routing layer judged them,
    and ``Match.PARTIAL`` is precisely "this path, some other method". Both ``PARTIAL`` and
    ``FULL`` are counted - a ``FULL`` match cannot occur alongside a 405 for the same method, and
    excluding it would leave the value dependent on a coincidence.

    Args:
        request: The request being answered. Its ``scope`` supplies both the application, whose
            routes are read, and the path and method the routes are matched against.

    Returns:
        The rendered header value in :data:`_METHOD_ORDER`, or ``None`` when no matching route
        declares a method - in which case the caller keeps whatever the framework supplied,
        because a recomputation that found nothing is not evidence that nothing is allowed.

    Note:
        ``HEAD`` appears only where a route declares it. FastAPI's ``APIRoute`` does not add it
        alongside ``GET`` the way Starlette's plain ``Route`` does, so the value published here
        matches ``/openapi.json`` rather than exceeding it - which is the property that makes
        the two documents comparable.

        The header describes the requested **URI**, not one path template, and the two differ
        wherever templates overlap. ``PUT /api/v1/users/me`` answers ``Allow: GET, PATCH``
        because ``/api/v1/users/{username}`` matches that concrete path as well - a ``GET`` there
        is routed and answers ``404``, not ``405``, so a header omitting it would be the same
        kind of untruth this function exists to remove. The same holds for
        ``/api/v1/posts/{post_id}``, which ``/api/v1/posts/{slug}`` also matches. RFC 9110 asks
        for the target resource's supported methods, and that is what the union of matching
        routes reports.
    """
    # Read through `scope` rather than `request.app`, which raises `KeyError` when the key is
    # absent. It cannot be absent in the assembled application, but this module runs on the
    # failure path and must not fail while answering a failure.
    routes = getattr(request.scope.get("app"), "routes", None)
    if not isinstance(routes, Iterable):
        return None

    methods: set[str] = set()
    for leaf in _route_leaves(routes):
        # A `Mount`, a websocket route and an inclusion itself carry no methods; only an HTTP
        # route or one of its effective contexts does, and only those can contribute.
        declared = getattr(leaf, "methods", None)
        matches = getattr(leaf, "matches", None)
        if not isinstance(declared, set | frozenset | list | tuple) or not callable(matches):
            continue
        outcome = matches(request.scope)
        if not isinstance(outcome, tuple) or not outcome or outcome[0] is Match.NONE:
            continue
        methods.update(str(method).upper() for method in declared)

    if not methods:
        return None

    # Known methods in canonical order, then anything else alphabetically so a custom method
    # registered by a future router is still reported deterministically rather than dropped.
    ordered = [method for method in _METHOD_ORDER if method in methods]
    ordered.extend(sorted(methods.difference(_METHOD_ORDER)))
    return _ALLOW_HEADER_SEPARATOR.join(ordered)


def _retry_after_seconds(exc: RateLimitExceeded) -> int:
    """Derive the ``Retry-After`` window, in whole seconds, from slowapi's exception.

    ``exc.limit`` is the ``slowapi.wrappers.Limit`` wrapper, whose own ``limit`` is the parsed
    ``limits.RateLimitItem``, whose ``get_expiry()`` returns the window length in seconds - so
    a configured ``5/minute`` yields ``60``. The attribute is genuinely optional rather than
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
    one response in the API that a client had to parse differently. The entries are reduced by
    :func:`_field_errors` to the three publishable fields, with union case labels stripped from
    each path and the spurious null companion suppressed, so every entry names a control a form
    can attach it to; ``exc.body`` - the raw submitted payload, which on a registration request
    contains the caller's plaintext password - is never read, and neither is any entry's
    ``input`` or ``ctx``.

    Args:
        request: The request being answered.
        exc: The raised exception. Always a ``RequestValidationError``, by MRO dispatch.

    Returns:
        A 422 problem document whose ``errors`` list is always non-empty.
    """
    error = cast(RequestValidationError, exc)

    return _problem_response(
        request=request,
        status=HTTPStatus.UNPROCESSABLE_CONTENT,
        error_type=_ERROR_TYPE_VALIDATION,
        title=_TITLE_VALIDATION,
        detail=_DETAIL_REQUEST_VALIDATION,
        errors=_field_errors(error.errors()),
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

    A 5xx detail is discarded, not rendered
    --------------------------------------
    For any status of 500 or above, ``exc.detail`` is replaced by :data:`_DETAIL_SERVER_ERROR`
    and the original is written to the structured log instead. This closes the one seam through
    which the "a server error tells a caller nothing" guarantee could be bypassed:
    :func:`_unhandled_exception_handler` protects an exception that *escaped*, but an
    ``HTTPException(503, ...)`` never escapes - it is handled here, and its ``detail`` is
    whatever string the raiser passed. On a 5xx that raiser is the framework, a dependency, or
    an operational probe rather than a route in this API, so the text is not known to be
    client-safe: a readiness probe that raises with a driver's connection message publishes the
    database host, port, user and database name to an unauthenticated caller.

    4xx details are preserved unchanged, and deliberately so. They come from the framework's
    own status phrases - ``Not Found``, ``Method Not Allowed`` - or from a dependency reporting
    something the caller can act on, and suppressing them would replace actionable text with
    nothing at the one class of status where the caller is the party able to fix the problem.
    ``type``, ``title`` and ``status`` are unaffected in both directions, so a client's branch
    on ``type`` still distinguishes ``/errors/service-unavailable`` from
    ``/errors/internal-server-error``.

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

    if error.status_code >= HTTPStatus.INTERNAL_SERVER_ERROR:
        # Logged before it is discarded, so the incident stays diagnosable at exactly the cost
        # of the caller learning nothing. `get_logger` is called here rather than at module
        # scope for the reason `_unhandled_exception_handler` records: a logger bound during
        # import would memoise structlog's unconfigured defaults, because `configure_logging`
        # runs in the application lifespan after every import has completed. The request
        # identifier bound by `app.middleware.request_context` is already on the line, so an
        # operator can move from a caller's correlation header to this entry.
        # The field NAMES come from `app.core.logging`, exactly as the unhandled-500 record and
        # the middleware's access record take theirs, and that agreement is the whole reason they
        # are constants rather than literals: three records describing one request have to be
        # joinable on more than the correlation identifier, and a record keyed `http_path` cannot
        # be queried beside two keyed `path`. The method and the path go through `log_safe_text`
        # for the same reason they do on every other HTTP record - `request.url.path` arrives
        # percent-DECODED, so it can carry a newline that forges a second log line, and it is
        # unbounded.
        #
        # `suppressed_detail` is the one field in this module that carries a message composed
        # somewhere else, so it is redacted and bounded AT THE CALL SITE rather than left to the
        # processor chain. Both are deliberate. `redact_sensitive_text` is what stops a framework
        # detail that quoted a connection URL, an address or a token from being retained -
        # `app.core.logging.redact_log_event` would catch it too, and the belt is cheap on a path
        # already answering a 5xx. `log_safe_text` bounds it, because that processor is a
        # *redaction* pass and not a length limit, and this field is the only unbounded one here:
        # a detail built by interpolating a request body into a string would otherwise be an
        # unbounded indexed field. `LOG_EXCEPTION_VALUE_MAX_LENGTH` rather than the shorter
        # default, since this is an exception message and is bounded by the same rule as one.
        get_logger(__name__).error(
            "http_exception_detail_suppressed",
            **{
                HTTP_LOG_FIELD_METHOD: log_safe_text(request.method),
                HTTP_LOG_FIELD_PATH: log_safe_text(request.url.path),
                HTTP_LOG_FIELD_STATUS: int(error.status_code),
            },
            suppressed_detail=log_safe_text(
                redact_sensitive_text(detail), limit=LOG_EXCEPTION_VALUE_MAX_LENGTH
            ),
        )
        detail = _DETAIL_SERVER_ERROR

    return _problem_response(
        request=request,
        status=error.status_code,
        error_type=error_type,
        title=title,
        detail=detail,
        headers=_headers_for_http_exception(request, error),
    )


def _data_error_is_request_caused(error: DataError) -> bool:
    """Whether *error* is provably a failure of a value the CALLER supplied.

    The question this handler exists to answer, and the reason it is asked narrowly.
    ``sqlalchemy.exc.DataError`` wraps the driver's SQLSTATE class 22 conditions - "data
    exception" - and the class is *not* proof that a request is at fault. It is raised just as
    readily by a value this service derived itself, by a column whose type has drifted from the
    model, by converting a result the database returned, and by stored data that is no longer
    representable. Answering 400 for those files a server defect as a client error: it leaves the
    5xx rate flat while the service is broken, and it discards the traceback that would have said
    where. So provenance has to be established rather than assumed, and anything this function
    cannot vouch for is left to the generic 500 owner.

    Two things establish it, and nothing else does:

    1. **A SQLSTATE in** :data:`_REQUEST_CAUSED_DATA_SQLSTATES`. The server refused a *value* for
       a reason that, in this schema, only a submitted value can produce - see that set for the
       per-code argument. Codes outside it, ``22012 division_by_zero`` and ``2201B
       invalid_regular_expression`` being the sharp examples, describe the statement rather than
       its parameters: this API composes every statement itself and takes no caller-supplied
       expression or pattern, so either one means a defect in this code.
    2. **A client-side refusal of a bound NUL character.** psycopg rejects ``U+0000`` in a text
       parameter *before* the statement is sent, so the failure carries no SQLSTATE at all - and
       its provenance is nonetheless certain, which no other client-side data error can claim:
       PostgreSQL's ``text`` and ``citext`` cannot STORE a NUL, so a NUL can never have arrived
       from a column, a result conversion or corrupted stored data. It can only be on its way in.

    The concrete case (2) closes is worth naming, because it is why this handler was written. A
    username, slug, search term or body carrying a NUL reached psycopg and raised here, so an
    unauthenticated caller could turn a public read into a 500 - inflating the error rate,
    writing a traceback per attempt and making genuine 500 alerting untrustworthy.
    ``app.schemas.common``'s storable-text validators now reject that character at the boundary
    with a ``422`` naming the field, and they are the *fix*; this remains the guarantee for any
    path they do not cover. Both halves are needed and neither is redundant: a boundary validator
    gives the better answer but only where it is attached, and this handler cannot name a field -
    by the time the driver refuses a value the request is a statement and its parameters - but it
    covers everything.

    Matching (2) on the driver's message is deliberate and its failure mode is safe. A
    client-side psycopg error has no code to key on, so the condition is recognised by the phrase
    psycopg uses for it; if a future release rewords that phrase, this returns ``False`` and the
    failure becomes a logged, alerted 500 rather than a silent misclassification. Wrong in the
    loud direction, which is the only acceptable direction here.

    Args:
        error: The wrapped driver failure.

    Returns:
        ``True`` when the value is the caller's to fix, ``False`` for everything else.
    """
    driver_error = getattr(error, "orig", None)
    sqlstate = getattr(driver_error, "sqlstate", None)
    if isinstance(sqlstate, str):
        return sqlstate.upper() in _REQUEST_CAUSED_DATA_SQLSTATES
    if driver_error is None:
        return False
    return _NUL_PARAMETER_PATTERN.search(str(driver_error)) is not None


async def _data_error_handler(request: Request, exc: Exception) -> ORJSONResponse:
    """Render a *request-caused* data exception as a 400, and re-raise everything else.

    :func:`_data_error_is_request_caused` is the whole of the decision, and the two outcomes are
    deliberately asymmetric:

    * **Request-caused**: a 400 problem document with a fixed, safe ``detail``, and one record at
      ``warning`` - because a rejected request is not an incident. ``exception_type`` is recorded
      so the class is visible, alongside the message redacted by
      ``app.core.logging.redact_sensitive_text`` and bounded by ``log_safe_text``: SQLAlchemy's
      message embeds the statement, and although ``hide_parameters=True`` keeps the bound values
      out of it, the same treatment the 5xx path gives a framework detail is applied here rather
      than trusting that. No frames - a value refused at the boundary of storage has no stack
      worth keeping, and the request identifier already on the line correlates it with the access
      record.
    * **Anything else**: re-raised, untouched. It is a server failure, so it belongs to the owner
      of server failures: the exception leaves this handler, reaches the ``ExceptionMiddleware``
      ``app.main`` registers as the innermost user middleware, and
      :func:`_inner_unhandled_exception_handler` renders the same 500 problem document every
      other unanticipated failure produces - with the traceback logged once, with locals
      suppressed and every frame redacted, and inside the CORS layer so a browser can read it.
      Nothing about the 500 path is reimplemented here, which is what keeps one shape and one
      log owner for a server error no matter which class raised it.

    ``raise`` with no argument rather than ``raise error``: the traceback that led here is the
    diagnostic, and re-raising by name would truncate it to this line.

    Args:
        request: The request being answered.
        exc: The raised exception. Always a ``DataError``, by MRO dispatch.

    Returns:
        A 400 problem document with a fixed, safe ``detail``, for a request-caused failure only.

    Raises:
        DataError: The same exception, when its provenance is not the caller's - so that it is
            answered as, logged as and alerted on as the server error it is.
    """
    error = cast(DataError, exc)
    if not _data_error_is_request_caused(error):
        raise error
    get_logger(__name__).warning(
        "data_error_response",
        **{
            # Neutralised before it is written, exactly as the 500 path does it, and for a
            # sharper reason here: the offending value is frequently IN the path - a `NUL`
            # arrives as `/api/v1/users/alice\x00` - and a control character written raw into a
            # log line is how a record gets forged.
            HTTP_LOG_FIELD_METHOD: log_safe_text(request.method),
            HTTP_LOG_FIELD_PATH: log_safe_text(request.url.path),
            HTTP_LOG_FIELD_STATUS: int(HTTPStatus.BAD_REQUEST),
        },
        exception_type=type(error).__name__,
        exception_message=log_safe_text(
            redact_sensitive_text(str(error)), limit=LOG_EXCEPTION_VALUE_MAX_LENGTH
        ),
    )
    return _problem_response(
        request=request,
        status=HTTPStatus.BAD_REQUEST,
        error_type=_ERROR_TYPE_BAD_REQUEST,
        title=_TITLE_BAD_REQUEST,
        detail=_DETAIL_DATA_ERROR,
    )


def _headers_for_http_exception(
    request: Request, error: StarletteHTTPException
) -> Mapping[str, str] | None:
    """Forward a framework exception's headers, correcting ``Allow`` on a 405.

    Everything the exception carries is forwarded unchanged - that is what puts a dependency's
    ``WWW-Authenticate`` challenge on the wire - with exactly one substitution: on a
    method-not-allowed the ``Allow`` value Starlette derived from a single route is replaced by
    the union :func:`_allowed_methods` computes across every route matching the path. See that
    function for why the framework's value is incomplete.

    Args:
        request: The request being answered, matched against the application's routes.
        error: The framework exception, read for its status code and its headers.

    Returns:
        The headers to attach, or ``None`` when there are none - which is the common case, since
        only a 401 and a 405 arrive carrying any.
    """
    if error.status_code != HTTPStatus.METHOD_NOT_ALLOWED:
        return error.headers

    allowed = _allowed_methods(request)
    if allowed is None:
        return error.headers

    # Rebuilt rather than mutated: `exc.headers` belongs to the exception, and an exception
    # object edited by a handler is one a caller may still be holding. The comparison is
    # case-insensitive because a header name is, so the framework's own entry is replaced rather
    # than duplicated alongside this one whatever case it used.
    headers = {
        name: value
        for name, value in (error.headers or {}).items()
        if name.lower() != _ALLOW_HEADER_KEY
    }
    headers[ALLOW_HEADER] = allowed
    return headers


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
        headers={RETRY_AFTER_HEADER: str(_retry_after_seconds(error))},
    )


def is_usable_request_id(candidate: str) -> bool:
    """Report whether an identifier may be trusted, echoed in a header and logged as-is.

    The single definition of that question, used by ``app.middleware.request_context`` when it
    decides whether to honour an inbound ``X-Request-ID`` and by this module when it reads the
    identifier back out of request state. One predicate rather than two means the value a
    caller sees on an ordinary response and the value they see on a 500 are validated
    identically.

    Length is checked first: it is the cheaper test, and it bounds the work the pattern does.

    Args:
        candidate: The identifier to check.

    Returns:
        Whether the value is non-empty, within :data:`REQUEST_ID_MAX_LENGTH`, and composed only
        of the characters :data:`_REQUEST_ID_ALLOWED` permits.
    """
    return (
        len(candidate) <= REQUEST_ID_MAX_LENGTH
        and _REQUEST_ID_ALLOWED.fullmatch(candidate) is not None
    )


def _validated_request_id(request: Request) -> str | None:
    """Read the correlation identifier off request state, or ``None`` if there is none to trust.

    ``request.state`` is a view onto ``scope["state"]``, which
    ``app.middleware.request_context`` writes a validated identifier into before forwarding the
    request. Re-validating it here is not distrust of that middleware; it is the recognition
    that this handler runs on the failure path, reads mutable state, and is about to put the
    result into a response header and a log field. A value that reached the scope any other way
    - a nested application, an ASGI server that pre-populated ``state``, a future caller - must
    not be able to inject a header or forge a log line through either.

    Rejected outright rather than repaired: trimming an unexpected value and trusting the
    remainder is how a sanitiser becomes the vulnerability, and a correlation identifier has no
    meaning worth salvaging once it is malformed. ``None`` is also the correct answer for a
    failure raised before the middleware ran.

    Args:
        request: The request being answered.

    Returns:
        An identifier satisfying :func:`is_usable_request_id`, or ``None``.
    """
    # `object` rather than an inferred `Any`: `starlette.datastructures.State.__getattr__`
    # returns `Any`, and pinning the type here keeps the narrowing below honest.
    bound: object = getattr(request.state, REQUEST_ID_CONTEXT_KEY, None)
    if isinstance(bound, str) and is_usable_request_id(bound):
        return bound
    return None


def _cors_headers_for(request: Request, *, traverses_cors_middleware: bool) -> dict[str, str]:
    """Build the CORS headers ``CORSMiddleware`` would have written, for a response it never sees.

    ``CORSMiddleware`` is registered with ``add_middleware`` and therefore runs **inside**
    ``ServerErrorMiddleware``. When a bare ``Exception`` escapes, the inner stack has already
    unwound, so the 500 rendered by :func:`_unhandled_exception_handler` carries no CORS headers
    at all. To a browser that is not a 500 - it is a cross-origin violation, so the response is
    opaque to script: the caller sees a network or CORS error, cannot read the problem document,
    and cannot read the correlation identifier that would have let anyone find the incident in the
    log. The one failure most in need of a diagnosable answer is the one that arrives without one.

    This function closes that gap by writing the same headers for the same reasons, from the same
    policy. It decides nothing: ``settings.CORS_ALLOW_ORIGINS`` is the validated, canonicalised
    allow-list, ``settings.cors_wildcard_origin`` says whether the deployment admits every origin,
    and ``settings.cors_allow_credentials`` says whether credentials may be paired with it. The
    behaviour deliberately mirrors Starlette's for a simple (non-preflight) request:

    * **Origin present and admitted** - echo that origin, add ``Vary: Origin`` because the answer
      depends on the request, add ``Access-Control-Allow-Credentials: true`` when the deployment
      permits credentials, and expose :data:`CORS_EXPOSE_HEADERS` so the client may actually read
      the correlation header.
    * **Wildcard deployment** - answer ``*`` and expose the same headers. No ``Vary``, because the
      answer does not depend on the request, and never a credentials header: that pairing is
      forbidden, which is precisely what ``settings.cors_allow_credentials`` refuses.
    * **Origin present but not admitted** - write ``Vary: Origin`` and nothing else. The browser
      blocks the response, which is the correct outcome for an origin this deployment does not
      trust; the ``Vary`` keeps a shared cache from serving this refusal to an origin that *is*
      trusted.
    * **No Origin header** - not a cross-origin request. Nothing is written, so a container health
      check or a ``curl`` sees exactly the headers it saw before.

    Matching against the canonicalised list is what makes the comparison meaningful: the browser
    sends a lower-cased origin with default ports omitted, and ``app.core.config`` rewrites every
    configured entry into exactly that form, so ``https://Example.com:443`` in an env file matches
    a real request here as well as it does in the middleware.

    The one header that must NOT simply be mirrored
    -----------------------------------------------
    ``Vary`` is the exception to "write the same headers for the same reasons", and it is the
    reason this function has to be told which of the two render sites it is serving. Starlette
    applies its own headers with two different mechanisms, and only one of them is idempotent:
    ``simple_headers`` are assigned (``MutableHeaders.update``), so a value written here is
    replaced rather than repeated, but ``Vary`` goes through ``add_vary_header``, which *appends*
    to whatever is already present. For a response that passes back out through
    ``CORSMiddleware`` with an **admitted** origin, writing ``Vary: Origin`` here therefore
    produced ``vary: Origin, Origin`` - harmless under RFC 9110, which treats a repeated field
    name as equivalent to one, but a header no other response in this API carries and one a
    reader would reasonably read as a bug.

    Suppressing it unconditionally would be the wrong fix. Starlette calls
    ``add_vary_header`` only from ``allow_explicit_origin``, which it reaches only for an origin
    it admits, so on the refusal path *nothing* would write ``Vary`` at all - and that is the
    path where the header does the most work, keeping a shared cache from serving a refusal to an
    origin the deployment does trust. So the rule is precisely: skip it only when the middleware
    below will add it, which is the admitted-origin case on a response that still has
    ``CORSMiddleware`` above it.

    Args:
        request: The request being answered. Only its ``Origin`` header is read.
        traverses_cors_middleware: Whether the response being built will pass back out through
            ``CORSMiddleware``. ``True`` for the inner render site, which is dispatched by the
            ``ExceptionMiddleware`` ``app.main`` registers innermost; ``False`` for the outer
            site on ``ServerErrorMiddleware``, which is outside every added wrapper and so is
            the only writer of these headers.

    Returns:
        The CORS headers to attach, empty when the request is not cross-origin.
    """
    origin = request.headers.get(_ORIGIN_REQUEST_HEADER)
    if not origin:
        # Not cross-origin. Returning before the settings import below is what keeps a
        # non-browser caller's 500 - a health check, a `curl`, the test client - on a path that
        # constructs no configuration it does not need.
        return {}

    # Imported inside the function, and for the same reason `app.middleware.security_headers`
    # does it: importing `app.core.config` CONSTRUCTS the settings singleton, and
    # `app.core.logging` documents the resulting invariant as a requirement - `import
    # app.core.logging`, and therefore `import app.core.exceptions` and `import app.middleware`,
    # must stay free of any settings construction, so that they remain importable on a machine
    # with no environment file. `app/middleware/__init__.py` records the same rule from the other
    # side. A module-scope import here would make `import app.middleware` fail with six
    # `Field required` errors before `app.main` had a chance to report anything useful, and would
    # do it to `backend/migrations/env.py` and the unit suite as well. By the time a 500 is being
    # rendered the application is assembled and the singleton exists, so the cost is one
    # `sys.modules` lookup on a path that is already answering a failure.
    from app.core.config import settings

    if settings.cors_wildcard_origin:
        return {
            _CORS_ALLOW_ORIGIN_HEADER: _CORS_WILDCARD_ORIGIN,
            _CORS_EXPOSE_HEADERS_HEADER: _CORS_EXPOSE_HEADERS_VALUE,
        }

    # `Vary` belongs on every named-allow-list answer, admitted or not, because both answers are
    # origin-dependent and a cache must not reuse either across origins - but it is written HERE
    # only when nothing below will write it. `CORSMiddleware.allow_explicit_origin` appends it
    # through `add_vary_header` for an admitted origin, and appending to a value already present
    # is what produced `vary: Origin, Origin`; on the refusal path that middleware writes no
    # `Vary` at all, so this is the only writer and it must not be skipped. See "The one header
    # that must NOT simply be mirrored" above.
    admitted = origin in settings.CORS_ALLOW_ORIGINS
    headers: dict[str, str] = {}
    if not (admitted and traverses_cors_middleware):
        headers[_VARY_HEADER] = _ORIGIN_REQUEST_HEADER
    if not admitted:
        return headers

    headers[_CORS_ALLOW_ORIGIN_HEADER] = origin
    headers[_CORS_EXPOSE_HEADERS_HEADER] = _CORS_EXPOSE_HEADERS_VALUE
    if settings.cors_allow_credentials:
        headers[_CORS_ALLOW_CREDENTIALS_HEADER] = _CORS_ALLOW_CREDENTIALS_VALUE
    return headers


def _outer_response_headers(
    request: Request, request_id: str | None, *, traverses_cors_middleware: bool
) -> dict[str, str] | None:
    """Build the headers for a response rendered outside the middleware stack.

    ``ServerErrorMiddleware`` sits outside everything registered with ``add_middleware``, so the
    500 problem document reaches the client without passing through
    ``app.middleware.request_context``, ``app.middleware.security_headers`` or
    ``CORSMiddleware``. Left alone it would be the one response class in the whole service with no
    correlation identifier, no baseline hardening and no cross-origin permission on it - and it is
    the response class a caller is most likely to be holding when they report a bug.

    All three are supplied here, from the definitions those modules own rather than from literals:
    ``resolved_security_headers`` is the same function the header middleware's constructor calls,
    so a header added to the baseline appears here too with no second list to remember, and
    :func:`_cors_headers_for` reads the one origin policy in ``app.core.config``.

    Args:
        request: The request being answered. Read only for its ``Origin`` header.
        request_id: The validated identifier, or ``None`` when the request has none.
        traverses_cors_middleware: Passed straight through to :func:`_cors_headers_for`, which
            needs it to avoid duplicating the one header Starlette appends rather than assigns.
            The security headers and the correlation header are unaffected: the two middlewares
            that also write them do so with ``setdefault`` semantics, so a value written here
            survives as a single header either way.

    Returns:
        The header mapping to attach, or ``None`` when there is nothing to attach - which cannot
        happen while the baseline is non-empty, and is handled anyway so this function stays
        honest about its own contract.
    """
    # Imported inside the function. One of exactly two deferred imports in this module, and the
    # only one here for a CYCLE - the other, in `_cors_headers_for`, is deferred to keep this
    # module free of settings construction.
    #
    # `app/middleware/__init__.py` imports `request_context`, which imports THIS module, so a
    # module-scope `from app.middleware.security_headers import ...` here would ask Python to
    # initialise the `app.middleware` package while `app.core.exceptions` is still executing -
    # and `request_context` would then fail to find the names it needs on a half-initialised
    # module. Deferring the import to call time removes the cycle entirely: by the time a 500 is
    # rendered every module involved is fully imported, and the cost is one dictionary lookup in
    # `sys.modules` on a path that is already answering a failure.
    from app.middleware.security_headers import resolved_security_headers

    headers = dict(resolved_security_headers())
    headers.update(_cors_headers_for(request, traverses_cors_middleware=traverses_cors_middleware))
    if request_id is not None:
        headers[REQUEST_ID_HEADER] = request_id
    return headers or None


async def _render_unhandled(
    request: Request, exc: Exception, *, log_frames: bool, traverses_cors_middleware: bool
) -> ORJSONResponse:
    """Render any unanticipated exception as a 500 that reveals nothing. One document, two sites.

    The body is generic in **every** environment, development included. No exception class
    name, no message, no traceback, no SQL fragment, no configuration value - a caller learns
    that the request failed and nothing else. The incident stays fully diagnosable because the
    exception is logged, and because ``structlog.contextvars.merge_contextvars`` is the first
    processor in the configured chain, so the request identifier bound by
    ``app.middleware.request_context`` is already on the line. The response header set below is
    what lets a caller quote that identifier.

    Two dispatch sites share this renderer, and the two keyword arguments are the only things
    that differ between them - see :func:`inner_exception_handlers` and
    :func:`register_exception_handlers` for how each is installed:

    1. :func:`_inner_unhandled_exception_handler`, dispatched by the ``ExceptionMiddleware``
       ``app.main`` registers **innermost**, so its response passes back out through
       ``CORSMiddleware`` and is readable by browser code. Nothing above it ever sees the
       exception, so this is the site that logs the frames.
    2. :func:`_unhandled_exception_handler`, dispatched by ``ServerErrorMiddleware``, which
       ``build_middleware_stack`` places **outside** everything added with ``add_middleware``.
       Only a failure raised by a middleware *above* the inner site can reach it, and
       ``app.middleware.request_context`` has already recorded that one with its frames, so
       this site logs no traceback of its own.

    Both sites attach :data:`REQUEST_ID_HEADER` and the baseline security headers themselves,
    because site 2 is outside the middleware that would otherwise supply them and site 1 writes
    values the outer middleware applies with ``setdefault`` semantics - so the two orderings
    produce one header each rather than a duplicate. The middleware and this renderer must use
    the same header name, which is why the name is a shared constant rather than a literal in
    each.

    ``CORSMiddleware`` is the exception to that symmetry, and ``traverses_cors_middleware`` is
    how the difference is carried rather than guessed: it assigns its own headers but *appends*
    ``Vary``, so site 1 must leave that one header to it while site 2 - which no CORS wrapper
    will ever see - must write it. :func:`_cors_headers_for` documents the exact rule.

    ``ServerErrorMiddleware`` re-raises after site 2's response has been sent, so the ASGI
    server reports the failure as well. It also bypasses site 2 entirely when the application is
    constructed with ``debug=True``, in which case Starlette returns a traceback to the client -
    which is exactly why ``debug`` must stay off outside local development.

    Args:
        request: The request being answered.
        exc: The unhandled exception. Logged, never rendered.
        log_frames: Whether to attach the traceback to this module's record. ``True`` at the
            inner site, where no other owner will serialise it; ``False`` at the outer one,
            where ``app.middleware.request_context`` already has.
        traverses_cors_middleware: Whether this response will pass back out through
            ``CORSMiddleware``. ``True`` at the inner site, ``False`` at the outer one.

    Returns:
        A 500 problem document with a generic detail, carrying the correlation header when the
        request has an identifier.
    """
    # Obtained here rather than at module scope on purpose: a logger created while this module
    # is being imported would cache structlog's unconfigured defaults, because `app.main`
    # calls `configure_logging` in its lifespan - after every import has already run.
    logger = get_logger(__name__)

    # The identifier `app.middleware.request_context` left on the scope, validated against the
    # same grammar that middleware accepts an inbound one under. Validated rather than trusted
    # because it is read back out of mutable request state and is about to be written into a
    # response header and a log field, which are the two places a control character does
    # damage; `None` when the failure happened before the middleware ran.
    request_id = _validated_request_id(request)

    # Exactly one owner serialises the traceback, and `log_frames` is which.
    #
    # At the inner site nothing above this handler ever sees the exception - it is caught by the
    # `ExceptionMiddleware` registered innermost - so `app.middleware.request_context` records
    # only an access line for a 500 response and this record is the sole place the frames can
    # appear. At the outer site the reverse holds: that middleware sits INSIDE
    # `ServerErrorMiddleware`, so it has already seen the exception, logged it with its frames
    # and had the request identifier bound while it did; repeating the traceback there would be
    # the second serialisation of one exception, and uvicorn's re-raise would make a third -
    # which is why `app.core.logging` filters that one out.
    #
    # Either way this record says that a 500 problem document was RENDERED for the request,
    # which is a fact no middleware can know.
    #
    # `exception_type` carries the class name and nothing else. The exception's own message is
    # never placed in a field: a message is composed by whatever raised it and can quote a
    # connection string, a row, or a value a user typed, and a field is indexed, retained and
    # searched. The frames on the middleware's record are where a person reads the detail, and
    # they are serialised with `show_locals=False`.
    #
    # The field NAMES come from `app.core.logging`, shared with that middleware, so the two
    # records describing one request can be correlated on more than the identifier - and both
    # values go through the same bounding and control-character normalisation.
    logger.error(
        "unhandled_exception_response",
        **{
            HTTP_LOG_FIELD_METHOD: log_safe_text(request.method),
            HTTP_LOG_FIELD_PATH: log_safe_text(request.url.path),
            HTTP_LOG_FIELD_STATUS: int(HTTPStatus.INTERNAL_SERVER_ERROR),
            REQUEST_ID_CONTEXT_KEY: request_id,
        },
        exception_type=type(exc).__name__,
        exc_info=exc if log_frames else None,
    )

    # This response is rendered OUTSIDE `app.middleware.request_context`,
    # `app.middleware.security_headers` and `CORSMiddleware`, so none of the three can reach
    # it: the baseline security headers and the cross-origin permission are attached here
    # instead, each from the same definition its owner uses. Without this, the one response
    # class most likely to be seen by a caller chasing a bug would be the only one leaving the
    # service unhardened - and, for the separately-originated browser tier, the only one the
    # caller could not read at all, because a cross-origin response with no
    # `Access-Control-Allow-Origin` is opaque to script no matter what its body says.
    #
    # The INNER site - the same renderer dispatched by the `ExceptionMiddleware` registered as
    # the innermost user middleware - does pass through both middlewares and through CORS. The
    # two `app.middleware` wrappers apply their headers with `setdefault` semantics, so attaching
    # them here as well produces the same single header rather than a duplicate. `CORSMiddleware`
    # is NOT uniformly like that: it assigns its `simple_headers` but APPENDS `Vary` through
    # `add_vary_header`, which is why `traverses_cors_middleware` is passed down instead of
    # assuming symmetry. It is the one asymmetry in the whole "write it twice, get one header"
    # argument, and it produced a real `vary: Origin, Origin` before it was accounted for.
    #
    # The correlation header is NOT a special case any more - `_problem_response` writes
    # `X-Request-ID` on every error path from the same value it puts in the document, so this
    # path inherits it under the general rule. `_outer_response_headers` still carries it for
    # the same reason, and both write the identical value, so the two cannot drift. What that
    # rule alone cannot do is make the header READABLE cross-origin, which is why
    # `Access-Control-Expose-Headers` is written beside it.
    headers = _outer_response_headers(
        request, request_id, traverses_cors_middleware=traverses_cors_middleware
    )

    return _problem_response(
        request=request,
        status=HTTPStatus.INTERNAL_SERVER_ERROR,
        error_type=_ERROR_TYPE_INTERNAL,
        title=_TITLE_INTERNAL,
        detail=_DETAIL_INTERNAL,
        headers=headers,
    )


async def _inner_unhandled_exception_handler(request: Request, exc: Exception) -> ORJSONResponse:
    """Render a 500 from **inside** the CORS layer. The site a browser can actually read.

    Dispatched by the ``ExceptionMiddleware`` ``app.main`` registers innermost, which is the
    whole reason this site exists. Starlette hoists a handler keyed on bare ``Exception`` onto
    ``ServerErrorMiddleware``, outside every wrapper ``add_middleware`` installs - so a 500
    rendered only there leaves the service without the ``Access-Control-Allow-Origin`` header
    the validated CORS policy would have added, and browser code receives an opaque network
    failure instead of the documented problem document. Catching the exception here means the
    response travels back out through ``CORSMiddleware`` like every other answer.

    Args:
        request: The request being answered.
        exc: The unhandled exception. Logged with its frames here, because nothing above this
            handler will see it.

    Returns:
        The same 500 problem document the outer site renders - one shape, two dispatch sites.
    """
    return await _render_unhandled(request, exc, log_frames=True, traverses_cors_middleware=True)


async def _unhandled_exception_handler(request: Request, exc: Exception) -> ORJSONResponse:
    """Render a 500 from ``ServerErrorMiddleware``. The last resort behind the last resort.

    Reachable only for a failure raised by a middleware *above* the inner site - the request
    context or the security headers - since anything at or below it is caught there first. It is
    kept registered precisely for that case: without it, such a failure would render as
    Starlette's own bare ``Internal Server Error`` text rather than this API's one problem
    document.

    Args:
        request: The request being answered.
        exc: The unhandled exception. Not re-serialised here - ``app.middleware.request_context``
            has already logged this one with its frames on its way out.

    Returns:
        The 500 problem document, with the baseline security headers, the cross-origin permission
        - ``Vary`` included, since no CORS wrapper will add it here - and the correlation header
        attached, because no middleware will reach this response.
    """
    return await _render_unhandled(request, exc, log_frames=False, traverses_cors_middleware=False)


def inner_exception_handlers() -> dict[type[Exception], ExceptionHandler]:
    """The handler map for the ``ExceptionMiddleware`` ``app.main`` registers innermost.

    ``app.main`` passes the returned mapping to
    ``application.add_middleware(ExceptionMiddleware, handlers=...)`` as the FIRST registration,
    which is what makes that middleware the innermost user wrapper - inside ``CORSMiddleware``
    and immediately outside the framework's own exception middleware. Every failure at or below
    it is therefore rendered *within* the CORS layer, so a browser can read the problem document
    instead of seeing a cross-origin failure with no readable body.

    Three keys, and each is needed:

    * ``Exception`` is the one this exists for. Starlette routes a bare-``Exception``
      registration to ``ServerErrorMiddleware`` at the very outside of the stack and offers no
      way to place it anywhere else, so an inner middleware carrying the same handler is the
      only way to catch an unhandled failure while the CORS wrapper is still on the stack.
    * ``HTTPException`` overrides ``ExceptionMiddleware``'s own default for it, which is a
      ``PlainTextResponse``. That default is unreachable in practice - the framework's inner
      middleware handles the class first - but leaving it in place would mean one path through
      this service could answer with something other than the problem document, and the point of
      a single error contract is that no such path exists.
    * :class:`AppError` is what lets a *middleware* refuse a request and still answer the one
      document. The framework's own exception middleware sits inside every wrapper added by
      ``add_middleware``, so it cannot see a failure raised by one of them:
      ``app.middleware.body_limit`` rejecting an oversized body would otherwise escape as an
      unhandled 500. Registered here, that refusal renders as the 413 problem document - and does
      so while ``CORSMiddleware`` is still on the stack, so a browser can read it.

    Returns:
        A fresh mapping per call, so no caller can mutate a shared one. The values are the same
        handlers :func:`register_exception_handlers` installs, so both dispatch sites render one
        document shape from one implementation.
    """
    return {
        AppError: _app_error_handler,
        Exception: _inner_unhandled_exception_handler,
        StarletteHTTPException: _http_exception_handler,
    }


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
    despite subclassing ``HTTPException`` rather than the ``HTTPException`` handler it would
    otherwise match.

    ``DataError``'s handler is the one that does not always answer. It renders a 400 only for a
    failure it can prove the caller caused and **re-raises** everything else, which is what sends
    a server-side data failure to the unhandled-500 owner with its traceback rather than filing it
    as a client error. Starlette's exception middleware does not catch an exception raised by a
    handler, so the re-raise leaves this dispatch site and is caught by the ``ExceptionMiddleware``
    ``app.main`` registers as the innermost user middleware - the same site that renders every
    other unanticipated failure, inside the CORS layer. Were that wrapper ever absent,
    ``ServerErrorMiddleware`` and this module's outer registration would answer instead, and
    ``app.middleware.request_context`` would log the frames on its way out: one 500 and one
    traceback either way.

    Registration is by exception class throughout, never by status code. Starlette consults its
    integer status handlers *before* walking the MRO for an ``HTTPException``, so a status-keyed
    registration would quietly take precedence over a class-keyed one and split the contract.

    ``Exception`` is the one key Starlette treats specially: ``build_middleware_stack`` routes
    it to ``ServerErrorMiddleware`` at the very outside of the stack instead of to the inner
    exception middleware, and offers no way to place it anywhere else. That is why this
    registration is only half of the unhandled-failure contract: it renders a 500 for a failure
    raised *above* the CORS layer, while :func:`inner_exception_handlers` - installed by
    ``app.main`` as the innermost middleware - renders one *inside* it, which is the only way a
    browser can read the document. See :func:`_render_unhandled` for what each site logs and
    which headers it attaches.

    Args:
        app: The application to install the handlers on. Mutated in place; nothing is returned,
            so a caller cannot accidentally treat this as a factory.
    """
    app.add_exception_handler(AppError, _app_error_handler)
    app.add_exception_handler(RequestValidationError, _request_validation_error_handler)
    app.add_exception_handler(RateLimitExceeded, _rate_limit_handler)
    app.add_exception_handler(StarletteHTTPException, _http_exception_handler)
    app.add_exception_handler(DataError, _data_error_handler)
    app.add_exception_handler(Exception, _unhandled_exception_handler)
