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
module reads no environment variable and opens no connection, and the only thing it awaits is
the application beneath it. It performs no I/O of its own beyond the one access line it writes,
and one last-resort trace on stderr if writing that line ever fails - see the ``finally`` block
in :meth:`RequestContextMiddleware.__call__` for why a logging failure is reported there and
then swallowed rather than allowed to propagate.

Where it sits, and why the position is the whole design
------------------------------------------------------
``app.main`` registers this class **last**. ``Starlette.add_middleware`` inserts at the front
of ``user_middleware``, so last-registered is outermost, and the stack it builds is::

    ServerErrorMiddleware          <- outermost; owns the Exception / 500 handler
      RequestContextMiddleware     <- this module
        SecurityHeadersMiddleware  <- outside CORS, so preflights are hardened too
          CORSMiddleware
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
The line carries six fields and no others: the method, the path, the status that was sent, how
the request ended, the duration, and the anonymised network the request came from. Request
headers are never enumerated, so an ``Authorization`` header, a ``Cookie``, an access or
refresh token and a password form field cannot reach the log by accident. The query string is
not logged at all - not even its key names, which this module would be permitted to include -
because a badly behaved client can put a credential in a query value, and a field that is never
emitted cannot leak one. Truncation is never used as a mitigation for sensitive input: the
prefix of a bearer token is still credential material, so the answer there is omission.

The client's address is not among the six. ``app.core.logging.anonymised_client_network``
reduces it to the ``/24`` or ``/64`` it sits in before it is written, and drops anything that
does not parse as an address rather than logging it as text. An IP address identifies a person
for practical and for regulatory purposes, while what an operator needs from this field is the
ability to see that a burst of failures shares an origin - which a network prefix answers
exactly as well. Nor is a network the *caller* nominated: a request carrying
``X-Forwarded-For`` or one of its siblings has its peer rewritten by the server before this
middleware sees it, so :func:`_client_network` writes nothing at all in that case rather than
recording an origin the caller chose. ``app.core.rate_limit`` applies the same rule to the
identity it enforces on, from the same predicate.

The remaining two untrusted values, the method and the path, go through
``app.core.logging.log_safe_text``, which bounds their length and replaces every character in
Unicode's ``Cc``, ``Cf``, ``Zl`` and ``Zp`` categories. Both properties matter: an unbounded
path is a log-volume amplifier under an attacker's control, and the characters removed are the
ones that forge a line break (including U+2028 and U+2029, which the C0 range does not cover)
or reverse a rendered line's reading order.

The servers' own access logs are not merely redundant against this line - they are switched
off. ``app.core.logging`` silences ``uvicorn.access`` and ``gunicorn.access``, because
uvicorn's format includes the full request target with its query string, and because two
records describing one request under two schemas cannot be correlated by anything. This module
is the single access-log owner.

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
import sys
import time
import traceback
import uuid
from http import HTTPStatus
from typing import Any, Final

import structlog
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.exceptions import REQUEST_ID_CONTEXT_KEY, REQUEST_ID_HEADER, is_usable_request_id
from app.core.logging import (
    HTTP_LOG_FIELD_CLIENT_NETWORK,
    HTTP_LOG_FIELD_METHOD,
    HTTP_LOG_FIELD_PATH,
    HTTP_LOG_FIELD_STATUS,
    anonymised_client_network,
    client_claim_is_forwarded,
    get_logger,
    log_safe_text,
)

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
# The whole correlation contract - the header name, the key the identifier is bound under, the
# length bound and the grammar predicate - is declared in `app.core.exceptions` and imported
# here, then re-exported above so that importing either name from either module is legitimate.
#
# That module owns them because it is the one that has to answer the same questions from
# OUTSIDE this middleware: Starlette dispatches the bare-`Exception` handler through
# `ServerErrorMiddleware`, beyond everything registered with `add_middleware`, so that handler
# reads the identifier back off `request.state`, validates it with the same predicate this
# module accepts an inbound one under, and sets the same header itself. One declaration is how
# two modules stop agreeing without anyone noticing; two would look identical right up until
# one of them was edited.
#
# `app.main` puts REQUEST_ID_HEADER in the CORS `expose_headers` list as well, so a browser
# client can read the header off a cross-origin response.
# ---------------------------------------------------------------------------------------

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
_HEADERS_MESSAGE_KEY: Final[str] = "headers"
"""Key on a response-start message. ASGI makes it optional, which is why it is normalised."""

_HEADER_NAME_ALLOWED: Final[re.Pattern[str]] = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")
"""RFC 9110 ``token``: the grammar a header field name must follow.

Kept separate from the identifier grammar in ``app.core.exceptions`` even though the default
header name satisfies
both. They constrain different things - a field name on the wire against a field value this
module mints and echoes - and folding them together would make one of the two error messages
a lie the next person has to debug.
"""

_DURATION_PRECISION: Final[int] = 2
"""Decimal places kept on ``duration_ms``. Sub-10-microsecond resolution is noise here."""

_OUTCOME_FIELD: Final[str] = "outcome"
"""Key carrying how the request ended, independently of the status that was sent."""

_OUTCOME_COMPLETED: Final[str] = "completed"
"""A response started and the application returned without raising."""

_OUTCOME_FAILED: Final[str] = "failed"
"""The application raised. The status field still reports whatever had already been sent."""

_OUTCOME_ABORTED: Final[str] = "aborted"
"""No response ever started and nothing raised: the client disconnected mid-request."""


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


def _scope_str(scope: Scope, key: str) -> str:
    """Read a string entry from *scope*, defaulting to empty when absent or another type.

    ``method`` and ``path`` are mandatory in an HTTP scope, so the default is unreachable for
    a real server; it exists because a hand-built scope in a test need not be complete, and
    raising a ``KeyError`` from the logging path would turn a missing field into a failed
    request.
    """
    value = scope.get(key)
    return value if isinstance(value, str) else ""


def _client_network(scope: Scope) -> str | None:
    """Return the anonymised network the request came from, or ``None``.

    ``scope["client"]`` is a ``(host, port)`` pair for a real socket, but it is optional in
    the ASGI specification and absent or ``None`` for an in-process transport, which is how
    the integration suite drives the application. Reaching straight for ``scope["client"][0]``
    is therefore a crash on every test in that suite, and this guard is the reason there
    isn't one.

    The address itself is never logged. ``app.core.logging.anonymised_client_network``
    discards the host bits, so what reaches the record is the ``/24`` or ``/64`` - enough to
    see that a burst of failures shares an origin, not enough to identify the person behind
    it - and anything that does not parse as an address is dropped rather than written out as
    text.

    A caller-supplied address is not written at all, and that is the difference between a
    field an operator can act on and one that merely looks authoritative. Uvicorn runs its
    ``ProxyHeadersMiddleware`` outside this application by default, and for a peer inside
    ``forwarded_allow_ips`` (default ``127.0.0.1``) it *replaces* ``scope["client"]`` with the
    address from ``X-Forwarded-For`` - so a request carrying that header could put any network
    it liked into this record. Measured before the change: a request from loopback carrying
    ``X-Forwarded-For: 203.0.113.45`` was logged as ``client_network`` ``203.0.113.0/24``.
    Nothing leaked - the full address still never appears anywhere - but an origin field that
    an attacker chooses is worse than an absent one, because it will be believed.

    So when ``app.core.logging.client_claim_is_forwarded`` reports a claim, the field is
    written as ``None``: the same value already used for a transport with no peer, and already
    part of this field's published contract. The key is always present, so the record still
    carries exactly its six domain fields and nothing that reads it has to change. The
    predicate lives in ``app.core.logging`` because ``app.core.rate_limit`` applies the same
    rule to the identity it *enforces* on; one rule decides both.
    """
    if client_claim_is_forwarded(scope.get("headers", ())):
        return None
    client: Any = scope.get("client")
    if not client:
        return None
    host: Any = client[0]
    return anonymised_client_network(host) if isinstance(host, str) else None


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
        A value guaranteed to satisfy :func:`app.core.exceptions.is_usable_request_id`.
    """
    inbound = Headers(scope=scope).get(header_name)
    if inbound is not None and is_usable_request_id(inbound):
        return inbound
    # 32 unambiguous hex characters, needing no quoting in a log line, from a source that
    # cannot be guessed or derived from anything about the request.
    return uuid.uuid4().hex


def _access_log_level(status: int | None, *, quiet: bool, failed: bool) -> int:
    """Choose the level of the access line from how the request ended.

    *failed* is decided first, and that ordering is the point. The status alone is not enough
    to describe the outcome: a streaming response, a background-task failure, or anything that
    raises after ``http.response.start`` has already gone out leaves ``status`` at ``200``
    while the request has genuinely failed and the client has received a truncated body.
    Choosing the level from the status in that case files a server-side exception at ``info``
    - or, on a quiet path, at ``debug`` - which is precisely the record nobody will ever
    query for. Any non-null failure is therefore ``error``, whatever was sent, and the status
    that WAS sent is still reported in the record alongside an ``outcome`` field.

    Otherwise severity tracks the status class, so a deployment going wrong is visible in a
    stream rather than only to someone who thought to look: ``error`` for a 5xx, ``warning``
    for a 4xx, ``info`` otherwise.

    A *quiet* path is downgraded to ``debug`` only when it neither failed nor answered badly.
    Quietening the probes is about the volume of successful polls; a readiness probe answering
    503 because the database is unreachable is exactly the line that must not be hidden.

    A *status* of ``None`` with no failure means no response ever started, which happens when
    the client disconnected mid-request. That is not a server fault, so it is a ``warning``
    rather than an ``error``, but it is not ordinary either, so it is not ``info``.
    """
    if failed:
        return logging.ERROR
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
                # ASGI makes `headers` OPTIONAL on a response-start message, defaulting to
                # empty, and `MutableHeaders(scope=...)` raises KeyError when it is absent.
                # Starlette always supplies it, so this never fires in front of a Starlette
                # application - but this middleware wraps whatever it is given, and a
                # conformant raw-ASGI application beneath it would otherwise turn a
                # correlation header into a 500. Normalising is a one-line correctness fix,
                # not error handling.
                message.setdefault(_HEADERS_MESSAGE_KEY, [])
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
            # Observability is strictly subordinate to the request, and these nested blocks are
            # what make that true rather than intended.
            #
            # The access line is written in `finally`, so exactly one is written whichever way
            # the request ended - cleanly, by raising, or by being cancelled. Never none, never
            # two. But writing it means running a processor chain and a handler this module does
            # not own, and those can fail: a renderer given a value it cannot serialise, a
            # closed stream, a processor a test replaced. Unguarded, such a failure would do two
            # things that are both worse than a missing log line. The context would never be
            # cleared, so this request's identifier would stay bound to a worker task the ASGI
            # server reuses for the NEXT request, silently mislabelling it. And because an
            # exception raised in a `finally` REPLACES the one already in flight, a logging
            # failure would erase the application's own exception on the way out -
            # `ServerErrorMiddleware` would render its 500 for the logging error while the real
            # failure vanished, taking the reason for the request's outcome with it.
            #
            # So the log call is caught and the cleanup is unconditional. `Exception` and not
            # `BaseException`: a `CancelledError` or a `KeyboardInterrupt` arriving here is the
            # process being torn down and must keep propagating.
            try:
                self._log_access(
                    scope=scope,
                    status=response_status,
                    elapsed=time.perf_counter() - started,
                    failure=failure,
                )
            except Exception:
                # Swallowed, but never silently. The structured sink is the thing that just
                # failed, so reporting through it would be circular; stderr is what is left,
                # and it is the same last resort the standard library's own
                # `logging.Handler.handleError` falls back to. One diagnosable trace of the
                # logging failure, and the request's own outcome left exactly as it was.
                traceback.print_exc(file=sys.stderr)
            finally:
                # The real no-leak guarantee: it runs on the success path, on an application
                # exception, on cancellation, and on a failure of the call above alike, so no
                # identifier survives into whatever this task handles next.
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
            scope: The HTTP scope, read for the method, the path and the peer address - the
                first two normalised and bounded, the third reduced to its network, before
                either reaches the record.
            status: Status of the response that started, or ``None`` if none did. Reported as
                it is; no status is invented for a request that never sent one.
            elapsed: Seconds measured on the monotonic clock, converted to milliseconds here.
            failure: The exception the application raised, if it raised one. Its frames are
                attached to this line - and to no other line in the service - which is what
                keeps an unhandled failure correlated even though ``ServerErrorMiddleware``
                renders its response out of reach. It also forces the level to ``error``
                regardless of the status, because a failure after ``http.response.start`` would
                otherwise be filed at ``info``.
        """
        # Obtained here rather than at module scope on purpose, matching
        # `app.core.exceptions`: `app.core.logging.get_logger` documents that a logger created
        # while a module is being imported can memoise the configuration in force at that
        # moment, and `configure_logging` runs in `app.main`'s lifespan - after every import.
        logger = get_logger(__name__)

        # The raw path is used for the quiet-path comparison and the normalised one is what
        # gets logged. Comparing the normalised value would mean a bounded or replaced
        # character could never match `/healthz`, which is the opposite of what the bound is
        # for.
        raw_path = _scope_str(scope, "path")

        if failure is not None:
            outcome = _OUTCOME_FAILED
        elif status is None:
            outcome = _OUTCOME_ABORTED
        else:
            outcome = _OUTCOME_COMPLETED

        # A fixed allow-list of fields, passed as keyword arguments so the renderer emits one
        # queryable record rather than a sentence to be taken apart again. Request headers are
        # never enumerated and the query string is never read, so no credential can arrive
        # here. Every untrusted value goes through `log_safe_text`, which bounds its length and
        # replaces every Cc/Cf/Zl/Zp character, and the peer address is reduced to its network
        # before it is written. The names come from `app.core.logging` because
        # `app.core.exceptions` logs the same request from outside this middleware and the two
        # records have to be correlatable by more than the request identifier.
        #
        # `status_code` is the status that was ACTUALLY sent - `None` when nothing started -
        # rather than a synthesised 500, because inventing a status the client never received
        # makes the record disagree with both the access log of any proxy in front of it and
        # the response the caller actually got. `outcome` carries what a synthesised status
        # used to imply, and carries it unambiguously.
        #
        # `request_id` is deliberately absent: `merge_contextvars` adds it, and relying on that
        # is what keeps the mechanism the rest of the service depends on exercised.
        fields: dict[str, Any] = {
            HTTP_LOG_FIELD_METHOD: log_safe_text(_scope_str(scope, "method")),
            HTTP_LOG_FIELD_PATH: log_safe_text(raw_path),
            HTTP_LOG_FIELD_STATUS: status,
            _OUTCOME_FIELD: outcome,
            "duration_ms": round(elapsed * 1000, _DURATION_PRECISION),
            HTTP_LOG_FIELD_CLIENT_NETWORK: _client_network(scope),
        }
        if failure is not None:
            # THE traceback for this request, and the only one. The exception object rather
            # than `True`, so the frames are captured from it directly instead of from ambient
            # interpreter state. The configured renderer serialises frames with
            # `show_locals=False`, so a local holding a password or a signing key cannot be
            # written out with them, and the exception's own `str()` is never placed in a field
            # of its own - a message can quote a value, and a rendered traceback is read by a
            # person while a field is indexed by a machine.
            #
            # `app.core.exceptions` logs the 500 it renders WITHOUT frames, and
            # `app.core.logging` filters uvicorn's re-raised copy, so one unhandled exception
            # produces exactly one traceback in the stream - this one, with the request
            # identifier bound.
            #
            # The rendered traceback is REDACTED before it reaches either terminal renderer.
            # `app.core.logging.redact_log_event` sits immediately after the exception renderer
            # in both the development and the JSON chain, so a message that quoted a connection
            # URL, an address, a bearer token or a PostgreSQL DETAIL line is stripped of it here
            # too - not only on the shipping path. That is why handing the exception over whole
            # is safe: nothing in this middleware has to know what a driver chose to say.
            fields["exc_info"] = failure

        logger.log(
            _access_log_level(
                status,
                quiet=raw_path in self.quiet_paths,
                failed=failure is not None,
            ),
            _ACCESS_LOG_EVENT,
            **fields,
        )
