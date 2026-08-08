"""Baseline security headers on every HTTP response the service emits.

This middleware adds four response headers - ``X-Content-Type-Options``,
``X-Frame-Options``, ``Referrer-Policy`` and ``Permissions-Policy`` - plus
``Strict-Transport-Security`` where the deployment terminates TLS. It adds nothing else.
It never reads a request body, never touches a response body, opens no connection, takes
no lock and writes no log line, so what it costs a request is one dictionary lookup and at
most five list appends. That restraint is deliberate: ``backend/Dockerfile`` declares a
``HEALTHCHECK`` against ``/healthz``, a probe whose whole value is that it performs no
database work, and this module sits on the hot path of every one of those polls.

Position in the stack
---------------------
``app.main`` registers this class **first** of its three middlewares.
``Starlette.add_middleware`` inserts at index 0, so first-registered is *innermost*::

    ServerErrorMiddleware            <- outermost; renders handlers keyed on Exception/500
      RequestContextMiddleware       <- app.middleware.request_context
        CORSMiddleware               <- built from settings.CORS_ALLOW_ORIGINS
          SecurityHeadersMiddleware  <- THIS MODULE, innermost of the three
            ExceptionMiddleware      <- runs the handlers app.core.exceptions registers
              Router -> endpoints

Innermost is the entire point rather than an accident of ordering. It places this wrapper
immediately *outside* ``ExceptionMiddleware``, so every problem document
``app.core.exceptions`` renders - 400, 401, 403, 404, 405, 409, 415, 422, 429 - travels
back out through the send wrapper below and is hardened exactly like a 200. So are the
``/healthz`` and ``/readyz`` probes. Registering this class later, and so further out,
would silently strip these headers from every error response, which is why the resulting
behaviour is asserted by the test suite rather than left to convention.

Being innermost has one accepted consequence, recorded here so it is not mistaken for a
bug: ``CORSMiddleware`` answers a CORS preflight itself, without calling anything further
in, so an ``OPTIONS`` preflight response carries none of these headers. Nothing is lost by
that - a preflight is a bodiless negotiation whose own headers are the entire payload - and
the alternative ordering would trade it for unhardened error responses, which is a far
worse bargain.

The one response this cannot reach
----------------------------------
Starlette hoists a handler registered for bare ``Exception`` - or for status 500 - onto
``ServerErrorMiddleware``, which wraps the *outside* of the whole user stack, outside
everything added with ``add_middleware``. A genuinely unhandled exception is therefore
rendered beyond this wrapper and receives none of these headers. That is a property of the
ASGI middleware model, not a defect to work around here: ``app.core.exceptions`` already
compensates where it matters, setting ``X-Request-ID`` itself in its 500 handler for
exactly this reason, and catching exceptions in this module to "fix" the gap would break
the single error contract instead. See :meth:`SecurityHeadersMiddleware.__call__`.

No Content-Security-Policy
--------------------------
Deliberately absent, and it must stay absent. The browser-facing document is served by a
separately-originated Next.js application, and the versioned REST contract is the only
coupling between the two tiers. Next.js emits its own inline bootstrap and hydration
scripts, so a policy authored in the API would either break them or be widened until it
asserted nothing at all. A content policy belongs to whichever origin serves the document,
and that is not this service. The ``frame-ancestors`` directive is part of the same
mechanism, which is why framing is refused with ``X-Frame-Options`` below rather than
"upgraded" to a policy this tier has no standing to declare.

Nor does this module write any ``Access-Control-*`` header. ``app.main`` configures
Starlette's ``CORSMiddleware`` from ``settings.CORS_ALLOW_ORIGINS``, and a second writer of
those headers produces duplicates that browsers reject outright.

Configuration
-------------
``Strict-Transport-Security`` is the one conditional header, and it is gated *without*
introducing an environment variable. ``app.core.config`` is the only module permitted to
read the environment and its eleven fields mirror the repository-root ``.env.example``
field for field; a twelfth key invented here would put this module in contradiction with
both of them and would break the environment-only configuration contract in the name of
honouring it. The gate is instead the ``settings.is_production`` predicate that already
exists, with an ``enable_hsts`` constructor argument for a caller - ``app.main``, or a
test - that needs to decide explicitly.

Import purity
-------------
The standard library, Starlette (which arrives with the pinned ``fastapi``, so this module
adds no dependency of its own) and ``app.core.config``. Nothing else: no ``structlog``, no
FastAPI, no session, no model, and above all no ``os`` environment lookup. Constructing the
constants below is the only import-time effect.
"""

from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType
from typing import Final

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.config import settings

__all__ = [
    "BASE_SECURITY_HEADERS",
    "HSTS_HEADER",
    "HSTS_VALUE",
    "SecurityHeadersMiddleware",
]


# ---------------------------------------------------------------------------------------
# ASGI message vocabulary
#
# Spelled once as named constants rather than repeated as literals in the hot path, so a
# typo is an import error at startup instead of a middleware that silently never fires.
# ---------------------------------------------------------------------------------------

_HTTP_SCOPE_TYPE: Final[str] = "http"
_RESPONSE_START_MESSAGE_TYPE: Final[str] = "http.response.start"

# ASGI declares `headers` OPTIONAL on an `http.response.start` message, defaulting to an
# empty list, and `MutableHeaders(scope=...)` indexes the key directly - it raises
# KeyError when the key is absent. Every response Starlette builds carries it, but this
# middleware also wraps hand-written ASGI applications (the test suite mounts one), so the
# key is normalised before the headers are wrapped. Naming the default here keeps that
# normalisation a single, obvious statement.
_HEADERS_MESSAGE_KEY: Final[str] = "headers"


# ---------------------------------------------------------------------------------------
# Permissions-Policy
#
# A conservative deny-list with EMPTY allow-lists: `feature=()` denies the feature to
# every origin, including this one. A JSON API has no use for any of them, so denying the
# lot costs nothing and removes the browser features most often reached for by injected
# script. Assembled once, at import time, because building it per response would be pure
# waste on the health-check hot path.
# ---------------------------------------------------------------------------------------

_PERMISSIONS_POLICY_VALUE: Final[str] = (
    "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), "
    "geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), "
    "usb=()"
)


# ---------------------------------------------------------------------------------------
# The unconditional baseline
#
# Exported, and immutable, because more than one place has to agree on these exact pairs:
# the middleware applies them and the test suite asserts them. A duplicated literal is how
# two of those places stop agreeing without anyone noticing. MappingProxyType makes the
# mapping read-only at runtime, so an accidental `BASE_SECURITY_HEADERS[...] = ...` fails
# loudly at the point of the mistake rather than quietly reconfiguring every application
# in the process.
# ---------------------------------------------------------------------------------------

BASE_SECURITY_HEADERS: Final[Mapping[str, str]] = MappingProxyType(
    {
        # Refuse content-type sniffing. `app.main` installs ORJSONResponse as the default
        # response class, so bodies are JSON that legitimately contains author-supplied
        # post and reader-supplied comment text; a browser must never be free to decide
        # that such a body looks close enough to HTML to execute.
        "X-Content-Type-Options": "nosniff",
        # Refuse framing outright. DENY rather than SAMEORIGIN because no response from a
        # JSON API is ever legitimately framed, by this origin or any other. The modern
        # equivalent is the CSP `frame-ancestors` directive, and this module deliberately
        # emits no CSP (see the module docstring), so X-Frame-Options is the chosen
        # mechanism here and not a legacy fallback - please do not "upgrade" it.
        "X-Frame-Options": "DENY",
        # Send no Referer at all. Nothing this service returns is a navigable document, so
        # there is no referrer worth propagating, while post and profile paths are resource
        # identifiers that should not travel to a third-party origin in a request header.
        "Referrer-Policy": "no-referrer",
        "Permissions-Policy": _PERMISSIONS_POLICY_VALUE,
    }
)
"""The four headers applied to every HTTP response, whatever its status.

Read-only. Applied with ``setdefault`` semantics, so a response that sets one of these
itself keeps its own value - see :class:`SecurityHeadersMiddleware`. Exported so that a
test can assert the exact pairs without restating the literals, which is the only way the
assertion and the implementation can be guaranteed to describe the same contract.

Deliberately excluded: ``X-XSS-Protection``. It is deprecated, no longer implemented by
current browsers, and its filter was itself a source of cross-site leaks - adding it would
be a regression dressed up as hardening.
"""


# ---------------------------------------------------------------------------------------
# Strict-Transport-Security
#
# Conditional, because RFC 6797 section 7.2 requires a user agent to ignore this header
# when it arrives over a non-secure transport, and gating it is a correctness measure
# rather than tidiness: development and test traffic commonly reaches this service over
# plain HTTP, and an HSTS pin acquired for `localhost` is host-wide and long-lived, so it
# would force every OTHER local HTTP service a developer runs onto https and keep doing so
# long after the pin was acquired by accident.
# ---------------------------------------------------------------------------------------

HSTS_HEADER: Final[str] = "Strict-Transport-Security"
"""Name of the transport-security header, applied only where TLS is terminated."""

HSTS_VALUE: Final[str] = "max-age=63072000; includeSubDomains"
"""Two years, covering subdomains, and **without** ``preload``.

Two years is the duration at which the pin is worth having; ``includeSubDomains`` closes
the sibling-host bypass, which is the point of pinning at all.

``preload`` is omitted on purpose. Submitting a domain to the browser preload list is a
registry-level commitment that applies to the apex and every subdomain, ships inside
browser binaries, and is slow and awkward to reverse. That is an operator's decision about
a domain, and a middleware default must not make it on their behalf.
"""


class SecurityHeadersMiddleware:
    """Pure-ASGI middleware that applies :data:`BASE_SECURITY_HEADERS` to every response.

    Written against the raw ASGI interface rather than ``BaseHTTPMiddleware`` for three
    reasons that all matter here. It mutates only the ``http.response.start`` message, so a
    streaming or file response is forwarded chunk for chunk and every body - a problem
    document from ``app.core.exceptions``, a page envelope from ``app.core.pagination`` -
    reaches the client byte for byte. It costs a fraction of what wrapping each request in
    a ``Request``/``Response`` pair costs, which is what keeps the container health check
    cheap. And ``app.add_middleware(SecurityHeadersMiddleware)`` constructs it identically
    either way, so the registration in ``app.main`` is unaffected by the choice.

    Headers are applied with ``setdefault`` semantics - set only when absent, compared
    case-insensitively. Two consequences are worth stating because both are relied upon. A
    route that sets, say, ``X-Frame-Options`` itself keeps its own value, because a
    decision made next to the response is better informed than a blanket default. And the
    middleware is idempotent: registering it twice cannot emit a header twice, which for
    ``Strict-Transport-Security`` in particular would be a real interoperability problem.

    Example, with the transport-security decision left to configuration::

        app.add_middleware(SecurityHeadersMiddleware)

    Example, forcing it on behind a TLS-terminating proxy in a non-production stage::

        app.add_middleware(SecurityHeadersMiddleware, enable_hsts=True)
    """

    def __init__(self, app: ASGIApp, *, enable_hsts: bool | None = None) -> None:
        """Resolve the response header set once, at application construction time.

        :param app: The next ASGI application in the chain. Supplied by Starlette when the
            class is registered with ``add_middleware``.
        :param enable_hsts: Whether to emit :data:`HSTS_HEADER`. ``None``, the default,
            defers to ``settings.is_production``, which is the right answer whenever the
            deployment stage and TLS termination coincide. Pass an explicit ``bool`` to
            override - a staging deployment that terminates TLS, or a test pinning one
            branch - which is how the requirement that HSTS be settings-driven is met
            without adding a twelfth environment variable to ``app.core.config``.
        """
        self._app = app

        # `settings.is_production` rather than a comparison against ENVIRONMENT: the
        # predicate is declared once in app.core.config, and it correctly answers False
        # for "staging" as well as for "development" and "test", so a stage that has not
        # been confirmed to terminate TLS never pins a client by default. A stage that
        # does terminate TLS opts in through `enable_hsts` above.
        hsts_enabled = settings.is_production if enable_hsts is None else enable_hsts

        headers = dict(BASE_SECURITY_HEADERS)
        if hsts_enabled:
            headers[HSTS_HEADER] = HSTS_VALUE

        # Frozen into a tuple of pairs HERE, deliberately, and never recomputed. Resolving
        # the HSTS question per request would repeat a decision that cannot change for the
        # lifetime of the application, on the hot path of a health check polled on a fixed
        # interval; a tuple also cannot be mutated later by a caller holding a reference.
        self._headers: tuple[tuple[str, str], ...] = tuple(headers.items())

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Forward the call, applying the resolved headers to the response start message.

        There is no ``try``/``except`` anywhere in this method, and its absence is a design
        decision rather than an omission. This middleware holds no resource and so has
        nothing to release; a broad ``except`` would instead intercept the exceptions that
        ``ExceptionMiddleware`` must see in order to render the uniform problem document,
        collapsing the single machine-readable error contract into an opaque 500. Anything
        raised downstream propagates untouched - ``app.middleware.request_context`` owns
        the log-and-re-raise concern one layer further out.

        :param scope: The ASGI connection scope. Only ``"http"`` is acted upon.
        :param receive: The ASGI receive callable, forwarded unchanged.
        :param send: The ASGI send callable, wrapped so that the response start message
            gains the headers resolved in :meth:`__init__`.
        """
        # `lifespan` and `websocket` scopes are forwarded verbatim. This is not merely a
        # tidy guard: `app.main` drives startup and shutdown through the lifespan protocol
        # - configuring structured logging, then disposing the database engine - and a
        # lifespan message carries no headers to set, so treating it as a response would
        # break the boot rather than harden it. A websocket handshake response is likewise
        # not an HTTP response and is left to the protocol.
        if scope["type"] != _HTTP_SCOPE_TYPE:
            await self._app(scope, receive, send)
            return

        # Bound to a local so the closure below reads a cell rather than resolving an
        # attribute on `self` for every response it forwards.
        security_headers = self._headers

        async def send_wrapper(message: Message) -> None:
            if message["type"] == _RESPONSE_START_MESSAGE_TYPE:
                # ASGI permits `headers` to be absent, defaulting to empty; MutableHeaders
                # would raise KeyError on it. Normalising is a one-line correctness fix,
                # not error handling, and it keeps this middleware valid in front of any
                # conformant application rather than only in front of Starlette's own.
                message.setdefault(_HEADERS_MESSAGE_KEY, [])

                # MutableHeaders(scope=...) aliases the message's own header list, so
                # every setdefault below mutates the outgoing message in place. Its
                # setdefault folds case for us, so a response that already set
                # `x-frame-options` in lower case is still recognised and left alone.
                response_headers = MutableHeaders(scope=message)
                for name, value in security_headers:
                    response_headers.setdefault(name, value)

            # Every other message type - `http.response.body`, trailers, `pathsend` - is
            # forwarded without being inspected, let alone buffered or rewritten. That is
            # what guarantees a response body reaches the client unchanged.
            await send(message)

        await self._app(scope, receive, send_wrapper)
