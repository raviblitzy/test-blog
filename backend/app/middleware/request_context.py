"""Per-request correlation: one identifier, bound for the whole request, logged and returned.

This is the outermost wrapper the service puts around a request, and it does exactly three
things. It gives every request an identifier. It binds that identifier into *structlog*'s
context so that every line any layer writes while handling the request carries it without
anyone having to pass it down. And it emits exactly one access-log line saying how the request
ended. The identifier also goes back to the caller on :data:`REQUEST_ID_HEADER`, so a bug
report can quote a value that matches the server's own record of the same request.

Nothing else belongs here. No query, no session, no service call, no authority decision -
those live in ``app.repositories``, ``app.services`` and ``app.core.dependencies``
respectively, and a copy of any of them at this layer would be a second, divergent one. This
module reads no environment variable, opens no connection and performs no I/O at all: the only
thing it awaits is the application beneath it.

Where it sits, and why the position is the whole design
------------------------------------------------------
``app.main`` registers this class **last**. ``Starlette.add_middleware`` inserts at the front
of ``user_middleware``, so last-registered is outermost, and the stack it builds is::

    ServerErrorMiddleware          <- outermost; owns the Exception / 500 handler
      RequestContextMiddleware     <- this module
        CORSMiddleware
          SecurityHeadersMiddleware
            ExceptionMiddleware    <- runs the AppError / HTTPException / validation
              Router -> endpoint      / rate-limit handlers

Two consequences follow, and they were both confirmed by running the pinned stack rather than
inferred from it:

1. Every problem document produced by a **non-500** handler registered in
   ``app.core.exceptions`` is rendered by ``ExceptionMiddleware``, which is *inside* this
   middleware. Those responses travel back out through :meth:`send`'s wrapper below and do
   receive the header. A 404 for an unmatched route, a 404 raised by a handler, a 422
   validation document and a 429 rate-limit document are all correlated for that reason.
2. Starlette lifts handlers keyed on ``Exception`` and ``500`` **out** of
   ``ExceptionMiddleware`` and installs them on ``ServerErrorMiddleware``, which is *outside*
   this middleware. The 500 rendered for a genuinely unhandled exception is therefore
   constructed after this module's wrapper has been left behind, and this module cannot attach
   the header to it.

Point 2 is a real limitation and it is deliberately *not* worked around by catching the
exception and answering the request here. Doing that would replace the uniform problem
document with an improvised response and break the single error contract at the outermost
layer, which is the one place it would be least visible. Two compensating controls cover the
gap instead, and between them nothing is lost:

* the ``error``-level line this module emits on the way out carries the identifier and the
  exception's frames, so the failure is fully diagnosable and correlated; and
* :data:`REQUEST_ID_CONTEXT_KEY` is written into ``scope["state"]`` before the request is
  forwarded, which is where ``app.core.exceptions`` reads it - as ``request.state.request_id``
  - to attach the header to that 500 itself. The scope entry is therefore a load-bearing
  contract with that module, not a convenience for handlers.

Untrusted input, treated as such
--------------------------------
An inbound ``X-Request-ID`` is honoured so that a correlation identifier survives a proxy hop,
but it arrives from outside and is about to be echoed into a response header and written into a
log line. It is accepted only when it matches a conservative allow-list, and replaced outright
- never stripped or trimmed - when it does not. Together with the control-character
neutralisation applied to the logged method and path, that closes response-header injection and
log injection on the first request the service ever serves. ``scope["path"]`` is
percent-*decoded* by the server, so a request for ``/a%0D%0Afake-line`` really does arrive as a
path containing a carriage return and a newline; it is not a hypothetical.

What is never logged
--------------------
The line carries five fields and no others: the method, the path, the status, the duration and
the client address. Request headers are never enumerated, so an ``Authorization`` header, a
``Cookie``, an access or refresh token and a password form field cannot reach the log by
accident. The query string is not logged at all - not even its key names, which this module
would be permitted to include - because a badly behaved client can put a credential in a query
value, and a field that is never emitted cannot leak one. Nothing is truncated as a mitigation:
the prefix of a bearer token is still credential material, so the answer to sensitive input is
omission, not shortening.

Import purity
-------------
Importing this module attaches no handler, configures no logging and constructs nothing.
``app.main`` owns the single :func:`app.core.logging.configure_logging` call, in its lifespan,
and the logger here is obtained inside the function that logs for the reason that function's
comment gives.

.. code-block:: python

    from app.middleware.request_context import RequestContextMiddleware, get_request_id

    # Registered last in `app.main`, which makes it outermost.
    app.add_middleware(RequestContextMiddleware)


    def audit_note() -> str:
        # Every log line already carries this; `get_request_id` is for the rarer case of
        # needing the value itself, with no `Request` in hand.
        return f"see request {get_request_id()}"
"""

from __future__ import annotations

import logging
import re
import time
import uuid
from http import HTTPStatus
from typing import Any, Final

import structlog
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.exceptions import REQUEST_ID_HEADER
from app.core.logging import get_logger

__all__ = [
    "QUIET_ACCESS_LOG_PATHS",
    "REQUEST_ID_CONTEXT_KEY",
    "REQUEST_ID_HEADER",
    "RequestContextMiddleware",
    "get_request_id",
]


# ---------------------------------------------------------------------------------------
# Public contract constants
#
# `REQUEST_ID_HEADER` is imported from `app.core.exceptions` rather than declared again, and
# re-exported above so that importing it from either module is legitimate. That module owns
# the literal because its 500 handler needs the same name for the case described in this
# module's docstring, and one literal in two files is how two files stop agreeing without
# anyone noticing. `app.main` puts the same constant in the CORS `expose_headers` list, so a
# browser client can read the header off a cross-origin response.
# ---------------------------------------------------------------------------------------

REQUEST_ID_CONTEXT_KEY: Final[str] = "request_id"
"""Key the identifier is bound under, in both *structlog*'s context and ``scope["state"]``.

Fixed rather than incidental. ``structlog.contextvars.merge_contextvars`` is the first
processor in the chain ``app.core.logging`` configures, and it is what lifts this key onto
every line every layer emits during the request; ``app.core.exceptions`` reads the same key off
``request.state``. Renaming it here silently drops correlation from the whole service while the
log continues to look perfectly healthy.
"""

QUIET_ACCESS_LOG_PATHS: Final[frozenset[str]] = frozenset({"/healthz", "/readyz"})
"""Paths whose *successful* requests are logged at ``debug`` instead of ``info``.

The two operational probes ``app.main`` mounts unprefixed. ``backend/Dockerfile`` declares a
``HEALTHCHECK`` against ``/healthz``, and a container orchestrator polls readiness on a timer,
so logging those at ``info`` would add one line per poll for the life of the container and
bury the traffic that carries information. Only the successful ones are quietened: see
:func:`_access_log_level`.
"""


# ---------------------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------------------

_ACCESS_LOG_EVENT: Final[str] = "http_request"
"""Event name of the one access line per request. Stable, because queries match on it."""

_HTTP_SCOPE_TYPE: Final[str] = "http"
_RESPONSE_START: Final[str] = "http.response.start"

_REQUEST_ID_MAX_LENGTH: Final[int] = 128
"""Longest inbound identifier accepted. Generous for any real tracing scheme, and bounded."""

_REQUEST_ID_ALLOWED: Final[re.Pattern[str]] = re.compile(r"[A-Za-z0-9._-]+")
"""Characters an inbound identifier may consist of, and implicitly that it must be non-empty.

Safe in both places the value ends up: a response header value, where a carriage return or
newline would let a caller inject a header of their choosing, and a log line, where the same
characters would let them forge a record. Deliberately narrower than either grammar strictly
requires - a UUID, a hex string and a W3C trace identifier all pass.
"""

_HEADER_NAME_ALLOWED: Final[re.Pattern[str]] = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")
"""RFC 9110 ``token``: the grammar a header field name must follow.

Kept separate from :data:`_REQUEST_ID_ALLOWED` even though the default header name satisfies
both. They constrain different things - a field name on the wire against a field value this
module mints and echoes - and folding them together would make one of the two error messages
a lie the next person has to debug.
"""

_UNSAFE_LOG_CHARACTERS: Final[re.Pattern[str]] = re.compile(r"[\x00-\x1f\x7f-\x9f]")
"""C0 controls, DEL and the C1 range: everything that could forge or corrupt a log line.

The JSON renderer escapes these, so in every non-development environment they are already
inert; the console renderer used in development does not, which is exactly where an injected
line or a stray ANSI escape sequence would mislead the person reading it.
"""

_UNSAFE_REPLACEMENT: Final[str] = "\ufffd"
"""U+FFFD REPLACEMENT CHARACTER: marks that something was removed, unlike silent deletion."""

_DURATION_PRECISION: Final[int] = 2
"""Decimal places kept on ``duration_ms``. Sub-10-microsecond resolution is noise here."""


def get_request_id() -> str | None:
    """Return the identifier bound to the request being handled, if there is one.

    For code that needs the value itself and has no ``Request`` to hand - the common case
    being an error path assembling a message a user can quote back. Reading it is almost never
    necessary for *logging*, because every line already carries it.

    Backed by :func:`structlog.contextvars.get_contextvars` rather than a second
    ``ContextVar`` of this module's own, so there is one place the identifier lives and no way
    for two sources to disagree about it.

    Returns:
        The bound identifier, or ``None`` outside a request - before this middleware has run,
        after it has cleaned up, or on a non-HTTP scope, which it never binds for.
    """
    bound = structlog.contextvars.get_contextvars().get(REQUEST_ID_CONTEXT_KEY)
    # An `isinstance` check rather than a cast: the context is typed `dict[str, Any]`, and
    # narrowing here is what lets the return type be honest for every caller.
    return bound if isinstance(bound, str) else None


def _log_safe(value: str) -> str:
    """Neutralise control characters so *value* cannot forge or corrupt a log line."""
    return _UNSAFE_LOG_CHARACTERS.sub(_UNSAFE_REPLACEMENT, value)


def _scope_str(scope: Scope, key: str) -> str:
    """Read a string entry from *scope*, defaulting to empty when absent or another type.

    ``method`` and ``path`` are mandatory in an HTTP scope, so the default is unreachable for
    a real server; it exists because a hand-built scope in a test need not be complete, and
    raising a ``KeyError`` from the logging path would turn a missing field into a failed
    request.
    """
    value = scope.get(key)
    return value if isinstance(value, str) else ""


def _client_host(scope: Scope) -> str | None:
    """Return the peer address, or ``None`` when the transport does not have one.

    ``scope["client"]`` is a ``(host, port)`` pair for a real socket, but it is optional in
    the ASGI specification and absent or ``None`` for an in-process transport, which is how
    the integration suite drives the application. Reaching straight for ``scope["client"][0]``
    is therefore a crash on every test in that suite, and this guard is the reason there
    isn't one.
    """
    client: Any = scope.get("client")
    if not client:
        return None
    host: Any = client[0]
    return _log_safe(host) if isinstance(host, str) else None


def _usable_request_id(candidate: str) -> bool:
    """Report whether an inbound identifier may be trusted, echoed and logged as-is.

    Length is checked first: it is the cheaper test and it bounds the work the pattern does.
    """
    return (
        len(candidate) <= _REQUEST_ID_MAX_LENGTH
        and _REQUEST_ID_ALLOWED.fullmatch(candidate) is not None
    )


def _resolve_request_id(scope: Scope, header_name: str) -> str:
    """Take the inbound identifier when it is well formed, otherwise mint a fresh one.

    ``Headers`` is used for the lookup because HTTP header names are case-insensitive and it
    already implements that; comparing raw byte tuples would miss ``x-request-id``.

    A rejected value is *replaced*, never repaired. Trimming or filtering an attacker's string
    and then trusting the remainder is how a sanitiser becomes the vulnerability, and a
    correlation identifier has no meaning worth salvaging once it is malformed.

    Args:
        scope: The HTTP connection scope to read the request headers from.
        header_name: Header to look for, normally :data:`REQUEST_ID_HEADER`.

    Returns:
        A value guaranteed to satisfy :func:`_usable_request_id`.
    """
    inbound = Headers(scope=scope).get(header_name)
    if inbound is not None and _usable_request_id(inbound):
        return inbound
    # 32 unambiguous hex characters, needing no quoting in a log line, from a source that
    # cannot be guessed or derived from anything about the request.
    return uuid.uuid4().hex


def _access_log_level(status: int | None, *, quiet: bool) -> int:
    """Choose the level of the access line from how the request ended.

    Severity tracks the status class so that a deployment going wrong is visible in a stream
    rather than only to someone who thought to query for it: ``error`` for a 5xx, ``warning``
    for a 4xx, ``info`` otherwise.

    A *quiet* path is downgraded to ``debug`` only when it did **not** fail. Quietening the
    probes is about the volume of successful polls; a readiness probe answering 503 because
    the database is unreachable is precisely the line that must not be hidden, and downgrading
    it would defeat the point of choosing the level by status class in the first place.

    A *status* of ``None`` means no response ever started, which happens when the client
    disconnected mid-request. That is not a server fault, so it is a ``warning`` rather than an
    ``error``, but it is not ordinary either, so it is not ``info``.
    """
    if status is None:
        return logging.WARNING
    if status >= HTTPStatus.INTERNAL_SERVER_ERROR:
        return logging.ERROR
    if status >= HTTPStatus.BAD_REQUEST:
        return logging.WARNING
    return logging.DEBUG if quiet else logging.INFO


class RequestContextMiddleware:
    """Assign, bind, return and log a correlation identifier for every HTTP request.

    Written as a plain ASGI callable rather than on ``BaseHTTPMiddleware``, for four reasons
    that all still hold:

    * ``BaseHTTPMiddleware`` pumps the response body through a memory object stream. Wrapping
      ``send`` and touching only the ``http.response.start`` message leaves the body strictly
      alone, so a streaming response, a ``FileResponse`` and the ``ORJSONResponse`` bodies
      this service returns are all passed through byte for byte.
    * Binding and clearing context variables has to happen in the same context as the call
      they wrap. ``BaseHTTPMiddleware`` runs the application in a separate task with a *copy*
      of the context, which makes cleanup something to reason about instead of something
      guaranteed. Here there is one context, so bind-and-clear is exact.
    * It is on the hot path of every container health poll, and this form has materially less
      overhead per request.
    * Registration is unchanged: ``add_middleware`` calls ``cls(app=<inner>)`` either way.

    One instance is constructed per application, so the attributes below are effectively
    immutable and the class is safe to share across every worker task.
    """

    # Two fixed attributes, read once per request. Declaring them rules out an accidental
    # third being attached at runtime and drops the per-instance dictionary.
    __slots__ = ("app", "header_name", "quiet_paths")

    def __init__(
        self,
        app: ASGIApp,
        *,
        header_name: str = REQUEST_ID_HEADER,
        quiet_paths: frozenset[str] = QUIET_ACCESS_LOG_PATHS,
    ) -> None:
        """Wrap *app*.

        Args:
            app: The next application in the stack. Supplied by ``add_middleware``.
            header_name: Header carrying the identifier inbound and outbound. Keyword-only,
                and overridden only by a test; the default is the constant every other module
                agrees on, and changing it in a deployment would desynchronise this middleware
                from the CORS ``expose_headers`` list and from the 500 handler.
            quiet_paths: Paths whose successful requests are logged at ``debug``. Keyword-only.
                Overriding it is how the suite exercises both sides of that decision.

        Raises:
            ValueError: If *header_name* is empty or is not a legal HTTP header name. Raised
                while the application is being built, not while it is serving, so a wiring
                mistake fails at startup rather than emitting a malformed response header on
                every request.
        """
        if not _HEADER_NAME_ALLOWED.fullmatch(header_name):
            message = f"header_name must be a non-empty RFC 9110 token, got {header_name!r}"
            raise ValueError(message)

        self.app = app
        self.header_name = header_name
        self.quiet_paths = quiet_paths

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Correlate one HTTP request, then log how it ended. Never alters a response body.

        Args:
            scope: The connection scope. Anything other than ``http`` is forwarded untouched.
            receive: Passed through unchanged; request bodies are of no interest here.
            send: Wrapped, so that the response header can be attached to the start message.

        Raises:
            Exception: Whatever the application raised, re-raised unchanged so that
                ``ServerErrorMiddleware`` renders the uniform 500 problem document. Absorbing
                it here would substitute an improvised response for that contract.
        """
        # Lifespan and websocket scopes have no request identifier, no response header to set
        # and no access line to write. `app.main` uses the lifespan scope to configure logging
        # and to dispose the engine; binding a context variable on it would leak that binding
        # across the entire life of the process rather than the life of a request.
        if scope["type"] != _HTTP_SCOPE_TYPE:
            await self.app(scope, receive, send)
            return

        request_id = _resolve_request_id(scope, self.header_name)

        # Cleared on the way in as well as out. An ASGI server reuses worker tasks, and this is
        # what guarantees a previous request's identifier cannot still be bound when this one
        # starts - belt and braces alongside the `finally` below, which is the real guarantee.
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(**{REQUEST_ID_CONTEXT_KEY: request_id})

        # `Request.state` is a view onto `scope["state"]`, so this is what makes
        # `request.state.request_id` readable in a handler - and, more importantly, what lets
        # the 500 handler in `app.core.exceptions` attach the correlation header to a response
        # this middleware never sees. `setdefault` because the ASGI server may have put a
        # state dictionary there already.
        state: dict[str, Any] = scope.setdefault("state", {})
        state[REQUEST_ID_CONTEXT_KEY] = request_id

        # Monotonic. `time.time()` can step backwards across a clock adjustment and report a
        # negative duration, which is worse than no measurement because it looks like data.
        started = time.perf_counter()
        response_status: int | None = None
        failure: Exception | None = None

        async def send_wrapper(message: Message) -> None:
            """Attach the header to the response start message; forward everything else."""
            nonlocal response_status
            if message["type"] == _RESPONSE_START:
                response_status = message["status"]
                # Assignment, not `append`: it replaces any value already present, so a nested
                # application or a downstream component that set the same header cannot
                # produce a duplicate. `http.response.body` is never inspected or rewritten -
                # the problem document and the page envelope reach the client unmodified.
                MutableHeaders(scope=message)[self.header_name] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception as exc:
            # Recorded, then re-raised unchanged on the line below. `Exception` and not
            # `BaseException`: `asyncio.CancelledError` is a client hanging up, not a server
            # fault, and cleanup for it is the `finally` block's job.
            failure = exc
            raise
        finally:
            # In `finally`, so exactly one line is written whichever way the request ended -
            # cleanly, by raising, or by being cancelled. Never none, never two.
            self._log_access(
                scope=scope,
                status=response_status,
                elapsed=time.perf_counter() - started,
                failure=failure,
            )
            # The real no-leak guarantee: it runs on the success path, on an exception and on
            # cancellation alike, so no identifier survives into whatever this task handles
            # next.
            structlog.contextvars.clear_contextvars()

    def _log_access(
        self,
        *,
        scope: Scope,
        status: int | None,
        elapsed: float,
        failure: Exception | None,
    ) -> None:
        """Write the single access line for a finished request.

        Args:
            scope: The HTTP scope, read for the method, path and peer address.
            status: Status of the response that started, or ``None`` if none did.
            elapsed: Seconds measured on the monotonic clock, converted to milliseconds here.
            failure: The exception the application raised, if it raised one. Its frames are
                attached to this line, which is what keeps an unhandled failure correlated
                even though ``ServerErrorMiddleware`` renders its response out of reach.
        """
        # Obtained here rather than at module scope on purpose, matching
        # `app.core.exceptions`: `app.core.logging.get_logger` documents that a logger created
        # while a module is being imported can memoise the configuration in force at that
        # moment, and `configure_logging` runs in `app.main`'s lifespan - after every import.
        logger = get_logger(__name__)

        path = _scope_str(scope, "path")
        effective_status = (
            status
            if status is not None
            else (int(HTTPStatus.INTERNAL_SERVER_ERROR) if failure is not None else None)
        )

        # An allow-list of five fields, passed as keyword arguments so the renderer emits one
        # queryable record rather than a sentence to be taken apart again. Request headers are
        # never enumerated and the query string is never read, so no credential can arrive
        # here. `request_id` is deliberately absent: `merge_contextvars` adds it, and relying
        # on that is what keeps the mechanism the rest of the service depends on exercised.
        fields: dict[str, Any] = {
            "http_method": _log_safe(_scope_str(scope, "method")),
            "path": _log_safe(path),
            "status_code": effective_status,
            "duration_ms": round(elapsed * 1000, _DURATION_PRECISION),
            "client_ip": _client_host(scope),
        }
        if failure is not None:
            # The exception object rather than `True`, so the frames are captured from it
            # directly instead of from ambient interpreter state. The configured renderer
            # serialises frames with `show_locals=False`, so a local holding a password or a
            # signing key cannot be written out with them.
            fields["exc_info"] = failure

        logger.log(
            _access_log_level(effective_status, quiet=path in self.quiet_paths),
            _ACCESS_LOG_EVENT,
            **fields,
        )
