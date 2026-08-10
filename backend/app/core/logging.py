"""Structured logging for the service tier, configured once and owned in one place.

This module is the backend's single logging entry point. :func:`configure_logging` installs
the configuration and :func:`get_logger` hands out loggers; no other module calls
``logging.basicConfig``, attaches a handler, re-derives a *structlog* processor chain, or
reaches for ``logging.getLogger`` itself. The answer to "why does this line look like this?"
is therefore always this file, and there is exactly one place to change it.

Two functions, and the order between them matters
-------------------------------------------------
``app.main`` calls :func:`configure_logging` as the first statement of its lifespan startup -
before a router is reached, an engine is created or a request is served - so the very first
line the process writes already has its final shape. ``app.core.exceptions`` and
``app.middleware.request_context`` are the first consumers of :func:`get_logger`.

.. code-block:: python

    from app.core.logging import configure_logging, get_logger


    def handle() -> None:
        logger = get_logger(__name__)
        logger.info("post published", post_id="0f9c1f6e", categories=2)

Request correlation, which is the whole point
---------------------------------------------
``structlog.contextvars.merge_contextvars`` is the **first** processor in the chain, and that
position is load-bearing rather than stylistic. ``app.middleware.request_context`` binds the
request identifier once per request with ``bind_contextvars(request_id=...)``; every line any
layer logs while handling that request - a service, a repository, the last-resort 500 handler
in ``app.core.exceptions`` - carries the identifier without passing it down as an argument.
Drop that processor, or move something ahead of it that returns a fresh dictionary, and the
identifier silently disappears from every line while the log still looks perfectly healthy.
That failure mode is invisible in review, which is why it is asserted in the test suite.

One shape per environment
-------------------------
``ENVIRONMENT=development`` selects ``structlog.dev.ConsoleRenderer`` - aligned, optionally
coloured, multi-line tracebacks - because a human is reading it. Every other stage (``test``,
``staging``, ``production``) renders one JSON object per line, because a log collector is
reading it and ``docker-compose.yml`` and the container runtime both take stdout verbatim:

.. code-block:: json

    {"event": "post published", "post_id": "0f9c1f6e", "request_id": "b3d0f7a1",
     "logger": "app.services.post_service", "level": "info",
     "timestamp": "2026-01-01T12:00:00.000000Z"}

The selection reads :attr:`app.core.config.Settings.is_development` rather than comparing
``ENVIRONMENT`` to a string here, so the literal ``"development"`` lives in exactly one
module. ``test`` deliberately takes the JSON path: a test that asserts on a log line should
assert on the shape production emits.

The standard library goes through the same chain
------------------------------------------------
Everything a dependency logs - ``uvicorn``, ``uvicorn.error``, ``gunicorn.error``,
``sqlalchemy.engine.Engine``, ``alembic``, and Python warnings - is formatted by the same
processors through ``structlog.stdlib.ProcessorFormatter``, so a non-development deployment
emits JSON and only JSON. ``backend/migrations/env.py`` calls :func:`configure_logging` too,
so ``alembic upgrade``, ``alembic downgrade`` and ``alembic check`` are rendered by the same
processors instead of writing plain text from a ``fileConfig`` of their own - it passes
``stream=sys.stderr`` because the same CLI writes generated DDL to stdout under ``--sql``, and
:func:`configure_logging`'s ``stream`` argument documents that in full. Those loggers also
have their own handlers detached and their propagation restored, so each line is written
exactly once instead of twice: ``backend/Dockerfile`` runs Gunicorn with Uvicorn workers, and
both families configure handlers of their own when they start.

Three things a dependency would otherwise log are not bridged but removed, because in each
case this service already logs the same event better:

* ``uvicorn.access`` and ``gunicorn.access`` are **silenced**. One request must produce one
  access record, and ``app.middleware.request_context`` is its owner: it writes the
  correlated ``http_request`` event with a bounded, control-character-neutralised path, an
  anonymised client network and the duration, and deliberately without the query string.
  Uvicorn's own access line describes the same request on an uncorrelated schema *and*
  includes the full request target, query string and all - so keeping it would mean two
  records per request, one of which can carry a credential a client put in a query value.
* Uvicorn's ``Exception in ASGI application`` traceback is **filtered out**.
  ``ServerErrorMiddleware`` re-raises after the 500 document is sent so that a server can log
  the failure, which makes that the third serialisation of one exception. The request
  middleware is the single traceback owner - it has the frames and the request identifier -
  and ``app.core.exceptions`` records the correlated summary of the response it rendered, so
  the third copy adds nothing but volume and a record with no request identifier on it.
* Statement logging stays off unless ``LOG_LEVEL`` is ``DEBUG``, and ``app.db.session``
  builds its engine with ``hide_parameters=True`` and no ``echo``, so a statement that does
  appear carries a marker where its bound values would be and arrives through this chain
  rather than through a handler SQLAlchemy attached itself.

One boundary remains, it is visible in a real deployment, and closing it belongs to the entry
point rather than to this module. A server writes a few lines before it has imported the
application at all - Uvicorn installs its own logging dictionary while its ``Config`` is
constructed, and Gunicorn's boot messages arrive the same way. Nothing this module does can
reach back and reshape a line that was already written. Measured under Uvicorn 0.52 at
``ENVIRONMENT=production`` with :func:`configure_logging` invoked from the lifespan: two plain
lines, then JSON for everything from application startup onward.

That window is closable, and whoever writes ``app.main`` is required to close it rather than
invited to. Uvicorn calls ``Config.load()`` - which imports the application module - *before*
it logs ``Started server process``, so calling :func:`configure_logging` at ``app.main``
**import** time, in addition to the lifespan, makes every line of the run structured; the same
run measured that way produced ten JSON lines and no plain text. Both calls are wanted: the
import-time one shapes the server's own boot lines, the lifespan one re-applies the
configuration after any test fixture or embedding host has reconfigured logging underneath it,
and :func:`configure_logging` is idempotent precisely so that calling it twice is correct.
This module still performs no configuration on import, for the reasons under *Import purity*
below - a settings read must not reconfigure the root logger of whatever process happens to be
reading it.

Under Gunicorn the arbiter is a second process, and :class:`StructlogGunicornLogger` closes it
----------------------------------------------------------------------------------------------
The trick above works because uvicorn imports the application before it logs anything. Gunicorn
does not: its **arbiter** binds the socket, forks workers and handles signals in a process that
never imports ``app.main`` at all, so nothing on the application's own import path is reachable
from it. Only the forked workers import the application, and left alone only their lines can be
reshaped.

Measured under ``gunicorn app.main:app -k uvicorn.workers.UvicornWorker -w 2`` at
``ENVIRONMENT=production`` before this was addressed: 9 plain-text lines, every one of them from
the arbiter - five at boot (``Starting gunicorn``, ``Listening at:``, ``Using worker:``, two
``Booting worker with pid:``) and four at shutdown (``Handling signal: term``, two ``Worker … was
sent SIGTERM!``, ``Shutting down: Master``); a run without ``--no-control-socket`` adds
``Control socket listening at`` for ten. **Every** worker-side line, including all request
records, was already JSON. The content is harmless - no secret, no request data - but a JSON-only
collector treats each of them as unparsed, which is a real cost per container lifecycle rather
than a cosmetic one, and the canonical documented launch (``uvicorn app.main:app``) has no such
gap.

Gunicorn does offer one hook that runs inside the arbiter, and it is a class rather than a
callback: ``Arbiter.setup`` constructs ``cfg.logger_class(cfg)`` **before** the arbiter logs its
first line. :class:`StructlogGunicornLogger` is that class. It *lives* here because this module
owns the processor chain and the logger bridge, so the remedy is one subclass whose whole body is
``super().setup(cfg)`` then :func:`configure_logging`, and reversing those two lines is the one way
to get it wrong. It is *selected* in ``backend/gunicorn.conf.py``, which imports it and assigns it
to ``logger_class``, and ``backend/Dockerfile``'s ``CMD`` reaches it through
``--config gunicorn.conf.py`` with no ``--logger-class`` flag of its own - one implementation, one
selection point, because a flag and a config-file assignment are two selections of which only the
flag can ever win. Measured after the change, same command and same stage: **0** plain-text lines,
with the arbiter's boot and shutdown records rendered as JSON on the ``gunicorn.error`` logger.

No further work is needed in this module for it: ``gunicorn`` and ``gunicorn.error`` are already
in :data:`_DELEGATED_LOGGERS`, so :func:`configure_logging` detaches the arbiter's own plain-text
handler and lets its records reach the one handler installed here, and ``gunicorn.access`` is
already in :data:`_SILENCED_ACCESS_LOGGERS`, so the server's own access log stays off and
``app.middleware.request_context`` remains the single owner of the access record.

Deliberate exclusions
---------------------
A process stream is the only sink - stdout for the service, and stderr for the migration CLI
whose stdout carries generated DDL. There is no file handler, no rotation, no syslog, no OTLP
or APM exporter, no metrics registry and no tracing provider: structured logging with request
correlation plus the liveness and readiness probes is this project's observability floor, and
an exporter would be a dependency and an operational surface the scope does not call for. The
request-identifier middleware is not here either - it lives in
``app.middleware.request_context``; this module only makes the ``contextvars`` mechanism work.

Import purity, and why it is a requirement
------------------------------------------
Importing this module has **no** side effect: it attaches no handler, mutates no logger,
writes nothing, and - the part that is easy to lose - **constructs no settings**. The two
values it needs, ``LOG_LEVEL`` and the development predicate, are read inside
:func:`configure_logging` rather than at module scope, so ``app.core.config`` is imported only
when logging is actually being configured. Configuration happens only when
:func:`configure_logging` is called.

That is a requirement rather than a nicety, because this module sits underneath things that
must be importable before the application is assembled. ``app.core.exceptions`` imports
:func:`get_logger`, ``app.middleware.request_context`` imports ``app.core.exceptions``, and
``app.middleware`` re-exports both - so a module-scope settings construction here would make
``import app.middleware`` fail on a machine with no ``JWT_SECRET_KEY``, before
``app.main`` had a chance to assemble anything or report anything useful.
``backend/migrations/env.py`` and the unit suite import from ``app.core`` without asking for
logging to be reconfigured underneath them, and an ``alembic upgrade head`` that silently
re-pointed the root logger would be a surprise in the worst possible place.

Secrets never reach a log line
------------------------------
A log line leaves the process, so it is an exfiltration path in the same way a committed file
is. Nothing here logs a value: :func:`configure_logging` reads two settings and never renders
them, never logs ``settings`` as an object, and the JSON traceback renderer is constructed with
``show_locals=False`` precisely so that a frame holding a password, a signing key or a raw
refresh token cannot be serialised into a traceback. Callers keep that guarantee by logging
identifiers rather than credentials.

Untrusted values are normalised here, once
------------------------------------------
Three helpers exist for the values that come from outside the process, and they are here
rather than in a middleware because two different layers log the same request:
``app.middleware.request_context`` writes the access line, and ``app.core.exceptions`` writes
the correlated record for a 500 it rendered.

:func:`log_safe_text` bounds a value's length and replaces every character in Unicode's
``Cc``, ``Cf``, ``Zl`` and ``Zp`` categories - so a path arriving percent-decoded as
``/a\\r\\nlevel=critical`` cannot forge a second line, and a bidirectional override cannot
make a rendered line read as something other than what was logged.
:func:`anonymised_client_network` reduces a peer address to its ``/24`` or ``/64`` and drops
anything that is not an address at all. And the ``HTTP_LOG_FIELD_*`` constants fix the field
names both layers use, because two events describing one request under different keys cannot
be correlated by a query.

Redaction, applied to every record in every environment
-------------------------------------------------------
Bounding a value and neutralising its control characters does not make it safe to keep; it
only makes it safe to *render*. A connection URL with a password in it, a bearer token, a
signing key interpolated into a message and an address identifying a person are all perfectly
printable, and a log record is retained, indexed and searched by more people than the request
that produced it ever reached.

:func:`redact_sensitive_text` removes those classes of value from a string, and
:func:`redact_log_event` is the *structlog* processor that applies it to every string a record
carries - the event message, every field, and the rendered exception, whether that arrived as
the pretty traceback the development path produces or as the structured frames the JSON path
produces. It is installed in **both** terminal chains, because a secret exposed only on a
developer's terminal is still exposed: that terminal is scraped into a scrollback buffer, a CI
transcript and a pasted bug report.

It is a backstop and not a licence. The standing rule for callers is unchanged - log an
identifier and a classification, never the value that failed - and the two structural defences
remain: ``show_locals=False`` keeps a frame's variables out of a rendered traceback, and
:func:`configure_logging` renders no setting it reads.
"""

import ipaddress
import logging
import os
import re
import sys
import unicodedata
from collections.abc import Callable, Iterable, Mapping, MutableMapping
from functools import cache
from typing import Any, Final, TextIO

import structlog
from gunicorn.glogging import Logger as _GunicornLogger
from structlog.tracebacks import ExceptionDictTransformer
from structlog.typing import FilteringBoundLogger, Processor

__all__ = [
    "FORWARDED_CLIENT_HEADERS",
    "HTTP_LOG_FIELD_CLIENT_NETWORK",
    "HTTP_LOG_FIELD_METHOD",
    "HTTP_LOG_FIELD_PATH",
    "HTTP_LOG_FIELD_STATUS",
    "LOG_EXCEPTION_VALUE_MAX_LENGTH",
    "LOG_FIELD_PROCESS_ID",
    "LOG_REDACTION_PLACEHOLDER",
    "LOG_TEXT_MAX_LENGTH",
    "StructlogGunicornLogger",
    "anonymised_client_network",
    "client_claim_is_forwarded",
    "configure_logging",
    "get_logger",
    "log_safe_text",
    "redact_log_event",
    "redact_sensitive_text",
]


# ---------------------------------------------------------------------------------------
# Field names shared by every HTTP log event
#
# `app.middleware.request_context` writes the access line for a finished request and
# `app.core.exceptions` writes the correlated record for the 500 it rendered. They describe
# the same request from two layers, so they must use the SAME keys: two events keyed
# `path` and `http_path` cannot be correlated by a query, and the reader who tries has no
# way to know the difference is accidental. Declaring the names here, in the module both
# already depend on, is what makes agreement structural instead of coincidental.
# ---------------------------------------------------------------------------------------
HTTP_LOG_FIELD_METHOD: Final[str] = "http_method"
"""Request method. Uppercase token, bounded and neutralised like any other field."""

HTTP_LOG_FIELD_PATH: Final[str] = "path"
"""Request path, percent-decoded by the server, therefore untrusted, therefore normalised."""

HTTP_LOG_FIELD_STATUS: Final[str] = "status_code"
"""Response status actually sent, or absent when no response started."""

HTTP_LOG_FIELD_CLIENT_NETWORK: Final[str] = "client_network"
"""Anonymised peer network - see :func:`anonymised_client_network`. Never a full address."""

LOG_FIELD_PROCESS_ID: Final[str] = "pid"
"""Which process in this container wrote the record. On **every** record, not just the HTTP ones.

The shipped image runs a Gunicorn arbiter with two Uvicorn workers, and until this field existed
nothing in the log said which of the three a line came from. Per-request correlation was never
affected - ``request_id`` covers that - but a question one process below that is unanswerable
without it: whether a worker is taking its share of traffic, whether an error is confined to one
worker or spread across both, and which worker the arbiter's ``WORKER TIMEOUT`` line is about. It
also disambiguates the per-worker multiplication ``app.core.rate_limit`` documents, where two
workers each hold their own limiter bucket.

It is a process identifier and nothing more: no host, no user, no path, and it is meaningless
outside the container that emitted it, so it discloses nothing.
"""


# ---------------------------------------------------------------------------------------
# Bounded, control-character-free log text
#
# Two hazards, one function. The first is forgery: `scope["path"]` arrives percent-DECODED
# from the server, so a request for `/a%0D%0Alevel=critical` really does reach this process
# carrying a carriage return and a newline, and a console renderer will happily write them
# out as a second line that looks like a record this service emitted. The C0/C1 ranges are
# the obvious carriers, but they are not the only ones: U+2028 LINE SEPARATOR and U+2029
# PARAGRAPH SEPARATOR are line breaks to many readers and log viewers, and the Cf category
# holds the bidirectional overrides (U+202E and friends) that can make a rendered line read
# right-to-left and so display text that is not what was logged. Every character in
# Unicode's Cc, Cf, Zl and Zp categories is therefore replaced.
#
# The second hazard is size. A path is attacker-controlled and effectively unbounded, so an
# unbounded field is both a log-volume amplifier and a way to push the rest of a record out
# of a viewer's line. Every value is truncated to LOG_TEXT_MAX_LENGTH with a marker, so the
# reader can see that truncation happened rather than silently reading a prefix as the whole.
# ---------------------------------------------------------------------------------------
LOG_TEXT_MAX_LENGTH: Final[int] = 256
"""Longest text any single log field carries. Generous for a real path, and bounded."""

_LOG_TRUNCATION_MARKER: Final[str] = "…"
"""Appended when a value was shortened, so a prefix is never mistaken for the whole value."""

_UNSAFE_REPLACEMENT: Final[str] = "\ufffd"
"""U+FFFD REPLACEMENT CHARACTER: marks that something was removed, unlike silent deletion."""

_UNSAFE_ASCII_CHARACTERS: Final[re.Pattern[str]] = re.compile(r"[\x00-\x1f\x7f]")
"""C0 controls and DEL: the fast path, since almost every value is pure ASCII."""

_UNSAFE_UNICODE_CATEGORIES: Final[frozenset[str]] = frozenset({"Cc", "Cf", "Zl", "Zp"})
"""Control, format, line-separator and paragraph-separator characters.

``Cc`` covers C0 and C1, ``Cf`` covers the bidirectional overrides, the zero-width joiners
and U+FEFF, ``Zl`` is U+2028 and ``Zp`` is U+2029. Together they are every character that can
forge a line break or make a rendered line read as something other than what was logged.
Surrogates (``Cs``) and unassigned code points (``Cn``) are deliberately not here: they
cannot be constructed from a decoded HTTP scope, and rejecting them would replace legitimate
text in some scripts.
"""


@cache
def _is_unsafe_character(character: str) -> bool:
    """Whether *character* belongs to a category that must never reach a log line.

    Cached because the set of characters flowing through paths and methods in a running
    service is tiny and repeats endlessly, while ``unicodedata.category`` is a table lookup
    per call. The cache is bounded in practice by the number of DISTINCT characters seen,
    which is orders of magnitude smaller than the number of requests.
    """
    return unicodedata.category(character) in _UNSAFE_UNICODE_CATEGORIES


def log_safe_text(value: str, *, limit: int = LOG_TEXT_MAX_LENGTH) -> str:
    """Return *value* bounded to *limit* and with every unsafe character neutralised.

    The single normalisation used by every HTTP log field in this service, so a method, a
    path and any other untrusted string are treated identically no matter which layer emits
    them.

    Truncation happens **after** neutralisation, so the limit counts characters that will
    actually be written and a replacement cannot push the value back over the bound.

    Args:
        value: The untrusted text.
        limit: Maximum length of the returned string, marker included.

    Returns:
        Text safe to write into a structured record or a console line: no character that can
        forge a line, reverse the reading order, or hide what follows it, and no more than
        *limit* characters.
    """
    if value.isascii():
        # Fast path. `str.isascii` is a flag check, and this covers effectively every real
        # request; the general path below is reserved for values that genuinely need it.
        cleaned = _UNSAFE_ASCII_CHARACTERS.sub(_UNSAFE_REPLACEMENT, value)
    else:
        cleaned = "".join(
            _UNSAFE_REPLACEMENT if _is_unsafe_character(character) else character
            for character in value
        )

    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: max(limit - len(_LOG_TRUNCATION_MARKER), 0)] + _LOG_TRUNCATION_MARKER


_IPV4_ANONYMISED_PREFIX: Final[int] = 24
"""Bits kept from an IPv4 peer address: the /24 it sits in, not the address itself."""

_IPV6_ANONYMISED_PREFIX: Final[int] = 64
"""Bits kept from an IPv6 peer address: the /64, the smallest block usually assigned to one
subscriber."""


FORWARDED_CLIENT_HEADERS: Final[frozenset[bytes]] = frozenset(
    {
        # The de-facto standard a reverse proxy prepends, and the one uvicorn itself reads.
        b"x-forwarded-for",
        # nginx's single-value spelling of the same claim.
        b"x-real-ip",
        # RFC 7239's standardised form, which carries `for=` among its parameters.
        b"forwarded",
    }
)
"""Request headers whose presence makes the reported peer address caller-supplied.

Lowercase byte names, because an ASGI scope carries headers as lowercased byte pairs and
comparing them there needs no decoding and no case folding.

Why this list exists at all, and why it is here rather than in either module that uses it:
Uvicorn installs its own ``ProxyHeadersMiddleware`` **outside** the application whenever
``proxy_headers`` is on - which is its default - and for a peer inside ``forwarded_allow_ips``
(default ``127.0.0.1``) that middleware **overwrites** ``scope["client"]`` with the address
taken from ``X-Forwarded-For``. The original socket peer is not preserved anywhere the
application can reach, so by the time any code here runs, ``scope["client"]`` is either the
real peer or a value the caller chose, and nothing distinguishes them except the presence of
the header that would have caused the substitution. Its port is no help: uvicorn honours an
``address:port`` form, so a caller can supply a plausible non-zero port too.

Two consumers need exactly that question answered, and they must answer it the same way or
the service would enforce one rule and log another: ``app.core.rate_limit`` keys the
authentication limit on the caller, and ``app.middleware.request_context`` writes the
caller's network into the access record. Declaring the rule once, in the module both already
depend on and beside :func:`anonymised_client_network` - the only other place this codebase
decides what may be said about a peer - is what keeps them in agreement.
"""


def client_claim_is_forwarded(raw_headers: Iterable[tuple[bytes, bytes]]) -> bool:
    """Report whether the request carries a caller-supplied claim about its own address.

    ``True`` means the peer reported by the transport must be treated as untrusted: either
    uvicorn already replaced it with the value of one of :data:`FORWARDED_CLIENT_HEADERS`, or
    it did not and the caller was attempting to make it. Both cases are answered identically
    on purpose - the distinction depends on the deployment's proxy configuration, and a
    security control that changes shape with a server flag is one nobody can reason about.

    There is no trusted-proxy allow-list here, and no configuration key for one, because this
    deployment has no reverse proxy: the browser tier calls the API directly and the
    container topology puts a non-loopback peer in front of it, so no legitimate caller of
    this service sends any of these headers. Should a proxy ever be placed in front, the
    correct change is to pin the server's own trust explicitly - ``--forwarded-allow-ips``
    with the proxy's address, or ``--no-proxy-headers`` - and to revisit both consumers
    together; it is not to widen this predicate.

    The parameter is the raw ASGI header sequence rather than a framework ``Headers`` object,
    so this module keeps its property of importing no web framework at all - it is imported
    by ``backend/migrations/env.py`` as well as by the application.

    Args:
        raw_headers: ``scope["headers"]`` - lowercased name/value byte pairs, possibly empty.

    Returns:
        ``True`` when at least one forwarded-client header is present, ``False`` otherwise.
    """
    return any(name in FORWARDED_CLIENT_HEADERS for name, _ in raw_headers)


def anonymised_client_network(host: str | None) -> str | None:
    """Reduce a peer address to the network it came from, or drop it entirely.

    An IP address identifies a person for practical and for regulatory purposes, and an
    access log is retained, shipped and searched. What an operator actually needs from it is
    the ability to see that a burst of failures shares an origin - which the network prefix
    answers - not the ability to identify the individual behind it. So the host bits are
    discarded here rather than by whoever reads the log later: IPv4 keeps its first three
    octets (a ``/24``) and IPv6 its routing prefix (a ``/64``), which is the smallest block
    a single subscriber is normally assigned.

    Anything that does not parse as an address is dropped rather than logged as text. That
    closes the last route by which a value from the transport could reach a log line
    unvalidated, and it costs nothing: a non-address peer name is an in-process or
    unix-socket transport, where there is no network to record.

    Args:
        host: ``scope["client"][0]``, or ``None`` when the transport has no peer.

    Returns:
        A network in CIDR form - ``"203.0.113.0/24"``, ``"2001:db8::/64"`` - or ``None``.
    """
    if not host:
        return None
    # An IPv6 scope identifier (`fe80::1%eth0`) is a local interface name, not part of the
    # address, and `ip_address` rejects the whole value if it is present.
    candidate = host.partition("%")[0]
    try:
        address = ipaddress.ip_address(candidate)
    except ValueError:
        return None
    prefix = _IPV4_ANONYMISED_PREFIX if address.version == 4 else _IPV6_ANONYMISED_PREFIX
    return str(ipaddress.ip_network(f"{address}/{prefix}", strict=False))


# ---------------------------------------------------------------------------------------
# Library loggers that must delegate to the root handler
#
# Each of these configures handlers of its own when it starts - uvicorn and gunicorn from
# their logging dictionaries, SQLAlchemy from `echo`, alembic from the `[loggers]` sections
# of a config file - and each would then write its own plain-text line alongside our
# structured one. Detaching those handlers and restoring propagation is what turns two
# renderings of one event into one, and it is why this list exists at all.
# ---------------------------------------------------------------------------------------
_DELEGATED_LOGGERS: Final[tuple[str, ...]] = (
    # Uvicorn: `uvicorn.error` carries lifecycle and application errors. Both it and the
    # parent `uvicorn` are named because uvicorn's own dictionary configures the parent too.
    # `uvicorn.access` is deliberately NOT here - see _SILENCED_ACCESS_LOGGERS below.
    "uvicorn",
    "uvicorn.error",
    # Gunicorn: the production process manager (see backend/Dockerfile). Present only when
    # the service runs under it; naming a logger that never emits costs nothing.
    # `gunicorn.access` is likewise absent, for the same reason.
    "gunicorn",
    "gunicorn.error",
    # Alembic: `Running upgrade …` at INFO is the record of what a migration actually did,
    # so it is worth having in the same structured stream as everything else.
    "alembic",
    "alembic.runtime.migration",
    # Python warnings, routed here by `logging.captureWarnings` in `configure_logging`.
    # Without it a DeprecationWarning from a dependency reaches stderr as plain text.
    "py.warnings",
)

# ---------------------------------------------------------------------------------------
# Server access logs, which this service does not want at all
#
# `app.middleware.request_context` is the SOLE owner of the access log. It writes exactly
# one `http_request` event per request, carrying the correlated request identifier, a bounded
# and control-character-neutralised path, an anonymised client network and the duration -
# and deliberately not the query string, because a badly behaved client can put a credential
# in a query value.
#
# The servers' own access loggers describe the same request again, on a different schema,
# with none of that correlation, and uvicorn's format includes the full request target -
# query string included. Two records per request is not twice the information: it is the same
# event, differently shaped, one of which leaks. So these are not bridged into the chain;
# they are silenced outright, which leaves one owner instead of a formatting compromise
# between two.
#
# Silenced rather than filtered by level: a NullHandler plus `propagate = False` means the
# record reaches nothing, cannot be re-enabled by an ambient LOG_LEVEL, and cannot fall
# through to `logging.lastResort` either.
# ---------------------------------------------------------------------------------------
_SILENCED_ACCESS_LOGGERS: Final[tuple[str, ...]] = ("uvicorn.access", "gunicorn.access")

# ---------------------------------------------------------------------------------------
# The one duplicate traceback the server produces
#
# `ServerErrorMiddleware` re-raises after the 500 problem document has been sent - by design,
# so that a server can log the failure - and uvicorn then writes `Exception in ASGI
# application` with the full traceback on `uvicorn.error`. That is the THIRD serialisation of
# one exception: `app.middleware.request_context` already logged it with its frames and the
# request identifier attached, and `app.core.exceptions` logged the correlated summary of the
# response it rendered. The middleware is the single traceback owner, so this last copy is
# dropped.
#
# Matched on the message prefix and the presence of exception information, which is as narrow
# as this can be made: uvicorn logs that exact string with `exc_info` set, from one call site
# (`uvicorn.protocols.http.*.RequestResponseCycle.run_asgi`), in the pinned 0.52.1. Anything
# else on `uvicorn.error` - a lifespan failure, a protocol error, a startup message - is
# untouched. If a future uvicorn renames the message the filter simply stops matching, and
# the failure mode is a duplicate log line rather than a lost one.
# ---------------------------------------------------------------------------------------
_ASGI_EXCEPTION_MESSAGE_PREFIX: Final[str] = "Exception in ASGI application"


class _DuplicateAsgiTracebackFilter(logging.Filter):
    """Drop uvicorn's re-raised copy of an exception this service has already logged."""

    def filter(self, record: logging.LogRecord) -> bool:
        """Return ``False`` for the duplicate, ``True`` for everything else.

        Args:
            record: The record ``uvicorn.error`` is about to emit.

        Returns:
            Whether the record should be handled.
        """
        message = record.msg if isinstance(record.msg, str) else ""
        return not (
            record.exc_info is not None and message.startswith(_ASGI_EXCEPTION_MESSAGE_PREFIX)
        )


# ---------------------------------------------------------------------------------------
# SQLAlchemy's namespace, which needs a threshold rather than only a handler
#
# SQLAlchemy emits every rendered statement at INFO on `sqlalchemy.engine.Engine`. Letting
# that namespace simply inherit an INFO root would turn one request into a dozen lines of SQL
# in production, so statement logging is opt-in: it is enabled only when the operator asks
# for DEBUG. `app.db.session` builds the engine with `hide_parameters=True`, so what appears
# at DEBUG is the statement and a marker in place of the bound values, never the values
# themselves.
#
# `sqlalchemy.engine.Engine` is named explicitly, and it is the important one. It is the
# logger SQLAlchemy actually emits statements on, and the one it attaches a plain-text
# StreamHandler of its own to when an engine is constructed with `echo=True`
# (`sqlalchemy.log._add_default_handler`). `app.db.session` sets no `echo`, so no such
# handler is created - but naming the logger here means that if one ever is, this bridge
# detaches it and the second, unstructured rendering of every statement disappears with it.
# ---------------------------------------------------------------------------------------
_SQL_LOGGERS: Final[tuple[str, ...]] = (
    "sqlalchemy",
    "sqlalchemy.engine",
    "sqlalchemy.engine.Engine",
    "sqlalchemy.pool",
)

_SQL_QUIET_LEVEL: Final[int] = logging.WARNING
"""Level pinned on the SQLAlchemy namespace unless ``LOG_LEVEL`` is ``DEBUG``."""


# The single handler this module installs, remembered so that a second call to
# `configure_logging` can close the one it replaces. Only ever assigned there.
_installed_handler: logging.Handler | None = None


def _resolve_level(level_name: str) -> int:
    """Translate a ``LOG_LEVEL`` name into its numeric level.

    ``logging.getLevelNamesMapping`` is the standard library's own name-to-number table, so
    there is no second copy of ``{"INFO": 20, ...}`` to keep in step here.

    The subscript is deliberate, and there is deliberately no fallback:
    ``Settings.LOG_LEVEL`` is a ``Literal`` of the five level names, validated while the
    process is still starting, so a lookup miss is impossible by construction. Were one to
    happen anyway it must raise, because ``.get(name, logging.INFO)`` would answer a
    misconfiguration by quietly logging at a level nobody asked for.

    Args:
        level_name: One of the five names ``Settings.LOG_LEVEL`` permits. Passed in by
            :func:`configure_logging` rather than read here, so that importing this module
            constructs no settings - see "Import purity" in the module docstring.

    Returns:
        The numeric threshold to apply to the wrapper class, the root logger and the handler.
    """
    return logging.getLevelNamesMapping()[level_name]


# ---------------------------------------------------------------------------------------
# Redaction of sensitive values
#
# Nine patterns, each for a class of value this service is known to handle and none of
# which may be retained in a log. They are applied in the order declared, and the order is
# deliberate: userinfo is stripped from a URL before the two address patterns run, so a
# DSN's `user:password@host` is removed as a credential rather than partially matched as an
# address, and IPv6 runs before IPv4 so that `::ffff:192.0.2.1` is recognised as the single
# address it is rather than as a dotted quad inside something else.
#
# Every pattern rewrites rather than drops, and the replacement is visible. A field that
# silently loses its value looks like a field that never had one, which is how a reader
# concludes a diagnostic is missing when it was in fact withheld.
# ---------------------------------------------------------------------------------------

LOG_REDACTION_PLACEHOLDER: Final[str] = "[redacted]"
"""What replaces a redacted value. Deliberately conspicuous, and never an empty string.

A reader who finds it knows a value was removed on purpose, which is a different fact from a
field that was never populated. It is also what a test asserts on: ``_assert_withheld`` in
``backend/tests/unit/test_security.py`` checks that the secret is gone *and* that this took its
place, so a pattern that silently stopped matching would fail rather than pass quietly.
"""

#: Candidate IPv6 literal: hex groups joined by colons, optionally ending in a dotted quad
#: (`::ffff:192.0.2.1`) and optionally carrying a zone identifier (`fe80::1%eth0`).
#:
#: A colon at minimum, so a bare `28P01` or a `1234` cannot match, and the boundaries stop it
#: starting or ending mid-token. It is deliberately permissive about arrangement and is NOT the
#: arbiter of validity: `_anonymise_address` hands every candidate to `ipaddress`, and anything
#: that is not really an address is returned untouched. That division is what keeps a timestamp
#: (`22:34:43`), a MAC address and a hex identifier out of harm's way while still recognising
#: every spelling of an IPv6 literal - `::1` and `2001:db8:85a3::8a2e:370:7334` alike - which no
#: single readable regex does.
#:
#: A bare `::` is deliberately NOT matched even though it is the valid unspecified address:
#: nothing in this service can log a peer as `::`, and a rule that claimed it would rewrite the
#: scope operator in any quoted C++ or Rust identifier that happened to follow punctuation.
#:
#: What remains, stated rather than hidden: a `word::word` token whose halves are both spelled
#: entirely from hexadecimal letters - `a::b`, `cafe::beef` - IS a valid IPv6 literal and is
#: anonymised as one. No PostgreSQL type name, module path or identifier in this project's logs
#: has that shape (`::text`, `::uuid`, `std::fs` all contain a non-hex letter and are untouched),
#: and where the ambiguity is genuinely undecidable this rule prefers over-redaction to a
#: retained address.
#:
#: The trailing `(?!/\d)` is what makes redaction idempotent, and it is load-bearing rather
#: than tidy: `HTTP_LOG_FIELD_CLIENT_NETWORK` already carries an anonymised `2001:db8::/64` on
#: every access record, and a rule that rewrote it would produce `2001:db8::/64/64` and corrupt
#: a field that was already safe.
_IPV6_CANDIDATE: Final[re.Pattern[str]] = re.compile(
    r"(?<![0-9A-Za-z:.%])"
    r"(?:[0-9A-Fa-f]{1,4})?(?::{1,2}[0-9A-Fa-f]{1,4}){1,7}(?::{1,2})?"
    r"(?:\.[0-9]{1,3}){0,3}"
    r"(?:%[0-9A-Za-z._-]+)?"
    r"(?![0-9A-Za-z:.%])(?!/\d)"
)

#: Candidate IPv4 literal: four dotted decimal groups, bounded so it cannot be part of a
#: longer dotted-numeric string. `1.2.3.4.5` is therefore untouched entirely rather than
#: half-matched, and `10.0.0.0/8` is left as the network it already is - see the note on
#: idempotency above.
#:
#: One honest consequence, stated rather than hidden: a four-component version string is the
#: same token as an address and is anonymised as one. Nothing in this project logs one - the
#: versions that appear are three-component (`1.0.0`, `3.14.7`) or two (`18.4`) - and the
#: trade is deliberate, because the failure it prefers is a mangled version number rather than
#: a retained address.
_IPV4_CANDIDATE: Final[re.Pattern[str]] = re.compile(
    r"(?<![0-9A-Za-z._-])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![0-9A-Za-z._-])(?!/\d)"
)


def _anonymise_address(match: re.Match[str]) -> str:
    """Replace a matched address with the network it sits in, or leave the text alone.

    The policy is :func:`anonymised_client_network`'s, called rather than restated: an IPv4
    address keeps its ``/24`` and an IPv6 address its ``/64``, so a reader can still see that a
    burst of failures shares an origin and cannot identify the individual behind it. One
    definition of "anonymised" governs both the access record's ``client_network`` field and any
    address that turns up inside a message, which is what stops the two drifting apart.

    A candidate that is not really an address is returned **unchanged**. That is the whole
    reason the two patterns above can be permissive: validity is decided by ``ipaddress``, not
    by a regex, so a timestamp or a hex identifier that happens to fit the shape passes through
    untouched instead of being corrupted.

    Args:
        match: The candidate match. Only group 0 is read.

    Returns:
        The anonymised network in CIDR form, or the original text when it does not parse.
    """
    token = match.group(0)
    network = anonymised_client_network(token)
    return token if network is None else network


#: What a rule substitutes: a template string, or a callback for the two address rules, which
#: have to parse a candidate before they can decide what to write.
_RedactionReplacement = str | Callable[[re.Match[str]], str]

_REDACTION_RULES: Final[tuple[tuple[re.Pattern[str], _RedactionReplacement], ...]] = (
    # 1. Userinfo in any URL. This is the DSN case - `postgresql+psycopg://user:pw@host/db`,
    #    which `Settings.DATABASE_URL` holds and which psycopg quotes back in a connection
    #    failure - and also `https://token@host`. The scheme class admits `+`, `.` and `-`
    #    because `postgresql+psycopg` needs all three.
    (
        re.compile(r"(?i)\b([a-z][a-z0-9+.\-]*://)[^\s/@]+@"),
        rf"\g<1>{LOG_REDACTION_PLACEHOLDER}@",
    ),
    # 2. A JSON Web Token. Three base64url segments after the `eyJ` that every JOSE header
    #    begins with - specific enough that it cannot match an ordinary word, and it is the
    #    exact shape of the access token this service signs.
    (
        re.compile(r"\beyJ[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]*"),
        LOG_REDACTION_PLACEHOLDER,
    ),
    # 3. A credential following an HTTP authentication scheme, which covers the opaque refresh
    #    token as well as the JWT above and a `Basic` pair. The scheme word is kept: it says
    #    which credential was presented, which is a useful diagnostic and not a secret.
    (
        re.compile(r"(?i)\b(bearer|basic|digest)\s+[A-Za-z0-9._~+/=\-]{8,}"),
        rf"\g<1> {LOG_REDACTION_PLACEHOLDER}",
    ),
    # 4. A named secret assigned in text: `password=...`, `JWT_SECRET_KEY: ...`,
    #    `api_key="..."`. This is the shape a validation message, a repr and an f-string all
    #    produce, and the name is preserved so the reader still learns WHICH value was
    #    withheld. A quoted value is consumed whole so a space inside it cannot leave a tail
    #    behind.
    #
    #    The lookahead is what makes the whole set idempotent and order-independent. Without it,
    #    `password=[redacted]` would be re-matched - the value class stops at `]`, so a second
    #    pass would produce `password=[redacted]]` - and `Authorization: Bearer [redacted]`
    #    would have its scheme word eaten as though the word itself were the secret, discarding
    #    the one part of that header worth keeping.
    (
        re.compile(
            r"(?i)\b((?:jwt[_-]?)?(?:secret|password|passwd|pwd|token|credential|api[_-]?key"
            r"|access[_-]?token|refresh[_-]?token|private[_-]?key|authorization|dsn)"
            r"(?:[_-]?key)?)\s*[=:]\s*"
            rf"(?!{re.escape(LOG_REDACTION_PLACEHOLDER)}|bearer\b|basic\b|digest\b)"
            r"(?:\"[^\"]*\"|'[^']*'|[^\s,;&)\]}]+)"
        ),
        rf"\g<1>={LOG_REDACTION_PLACEHOLDER}",
    ),
    # 5. An email address. Personal data, and the identity this service authenticates by, so
    #    it is both PII and half of a credential pair. It is also what PostgreSQL quotes in
    #    the DETAIL line of a unique-violation on `users.email`.
    (
        re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"),
        LOG_REDACTION_PLACEHOLDER,
    ),
    # 6. An IPv6 address, reduced to its /64. IPv6 FIRST, so that `::ffff:192.0.2.1` is read
    #    as the one address it is instead of having its embedded quad rewritten in place.
    (_IPV6_CANDIDATE, _anonymise_address),
    # 7. An IPv4 address, reduced to its /24.
    #
    #    Both address rules exist because an address identifies a person for practical and for
    #    regulatory purposes, and because this service handles them constantly in text it did
    #    not compose: psycopg's connection-failure message names the host it tried and, in
    #    parentheses, the address it resolved to - `connection to server at "db" (10.1.2.3),
    #    port 5432 failed` - and a proxy header, an origin, a `Host` value or an operator's
    #    own note can carry one just as easily. The `client_network` field was already
    #    anonymised at its own call site; these two rules are what extend the same policy to
    #    every address that arrives inside a message rather than as a field.
    #
    #    Anonymised rather than blanked, unlike every other rule here, because the network is
    #    the diagnostic: "the failures all came from one /24" and "the database we could not
    #    reach was on the loopback" are the questions an operator actually has, and neither
    #    needs the host bits. `[redacted]` would answer neither.
    #
    #    One visible consequence, because it is better documented than discovered: an address
    #    this process is describing about ITSELF is anonymised too. Gunicorn's boot line reads
    #    `Listening at: http://127.0.0.0/24:8123` rather than `http://127.0.0.1:8123`. Text is
    #    text - a rule reading a rendered message cannot know whose address it is - and the
    #    parts that identify the socket to an operator, the scheme and the port, both survive.
    #    The bind address is also in the deployment's own configuration, so nothing that only
    #    this line could have told them is lost.
    (_IPV4_CANDIDATE, _anonymise_address),
    # 8. The diagnostic tails a PostgreSQL error carries. `DETAIL` quotes the conflicting
    #    key and its value verbatim, `CONTEXT` and `QUERY` quote statement text, and any of
    #    them can therefore carry a row a reader authored. Consumed to the end of the line,
    #    so this must run while the text still has its newlines - see `redact_log_event`.
    (
        re.compile(r"(?im)^[ \t]*(DETAIL|HINT|CONTEXT|QUERY)[ \t]*:.*$"),
        rf"\g<1>: {LOG_REDACTION_PLACEHOLDER}",
    ),
    # 9. A PEM block. Nothing in this service logs one, and if anything ever does it must not
    #    survive: the body is dropped and only the label is kept.
    (
        re.compile(r"(?s)-----BEGIN [A-Z ]+-----.*?-----END [A-Z ]+-----"),
        LOG_REDACTION_PLACEHOLDER,
    ),
)

_REDACTION_MAX_DEPTH: Final[int] = 4
"""How far into a nested value :func:`redact_log_event` will walk.

Four levels reach everything a record actually holds: the event dictionary, the ``exception``
list, one frame dictionary inside it, and that frame's ``exc_notes`` list. The bound exists so a
caller who logs a deeply nested or self-referential structure cannot turn one log line into
unbounded work on the failure path.
"""


def redact_sensitive_text(value: str) -> str:
    """Remove every class of sensitive value :data:`_REDACTION_RULES` recognises from *value*.

    Applied to text that was composed elsewhere - an exception message, a validation message, a
    driver diagnostic, a field a caller passed - and therefore to text nobody audited before it
    became a log record. The rules are conservative about what they consume and explicit about
    what they leave: a named secret keeps its name, a URL keeps its scheme and host, a
    PostgreSQL diagnostic keeps the label that says which diagnostic it was. What a reader loses
    is exactly the part that must not be retained.

    Idempotent: running it twice changes nothing. :data:`LOG_REDACTION_PLACEHOLDER` matches
    none of the patterns, and the two address rules decline a candidate that is already a
    network, so an anonymised ``10.1.2.0/24`` is not anonymised again. That matters because two
    processors and one call site all use this function, and a value can legitimately pass
    through more than one of them.

    Args:
        value: Text about to be written into a log record.

    Returns:
        The same text with every recognised secret, credential and database diagnostic replaced
        by :data:`LOG_REDACTION_PLACEHOLDER`, and every IPv4 or IPv6 address replaced by the
        network it sits in - a ``/24`` or a ``/64``, the same reduction
        :func:`anonymised_client_network` applies to a peer address. Never raises, and never
        returns ``None``.
    """
    redacted = value
    for pattern, replacement in _REDACTION_RULES:
        redacted = pattern.sub(replacement, redacted)
    return redacted


def _redact_value(value: Any, depth: int) -> Any:
    """Apply :func:`redact_sensitive_text` to every string reachable within *depth* levels.

    Strings are rewritten, containers are rebuilt, and anything else - an ``int``, a ``bool``,
    ``None``, a UUID, a datetime - is returned untouched. Mappings and sequences are rebuilt
    rather than mutated in place so a caller's own object is never modified by having been
    logged, which would be a side effect no caller could anticipate.

    Args:
        value: The field value to walk.
        depth: Remaining levels of nesting to descend. At zero, a container is returned as it
            is; see :data:`_REDACTION_MAX_DEPTH`.

    Returns:
        The value with every reachable string redacted.
    """
    if isinstance(value, str):
        return redact_sensitive_text(value)
    if depth <= 0:
        return value
    if isinstance(value, Mapping):
        return {key: _redact_value(item, depth - 1) for key, item in value.items()}
    if isinstance(value, list):
        return [_redact_value(item, depth - 1) for item in value]
    if isinstance(value, tuple):
        return tuple(_redact_value(item, depth - 1) for item in value)
    return value


def redact_log_event(
    _logger: object, _name: str, event_dict: MutableMapping[str, Any]
) -> MutableMapping[str, Any]:
    """Redact every string in a record, wherever in it that string lives.

    The one processor that runs in **both** terminal chains, and the only defence in this module
    that does not depend on which environment the process is configured for. Its position in each
    chain is what makes it total:

    * **After the exception renderer.** The development path turns ``exc_info`` into a formatted
      traceback *string* and the JSON path turns it into a list of frame dictionaries; running
      after either means this processor sees text in both cases rather than an exception object
      it would have to render itself. That closes the gap this module previously had, where the
      development path reached ``ConsoleRenderer`` without passing through any processing at all.
    * **Before the bounding pass.** ``_sanitise_exception_values`` replaces newlines with U+FFFD,
      and one of the rules here consumes a PostgreSQL ``DETAIL`` line to its end. Redacting first
      is what leaves those newlines intact for it to anchor on.

    Every field is walked, not a chosen subset, because a redaction list that has to be kept in
    step with every call site in the service is a list that will fall behind one. The walk is
    depth-bounded (:data:`_REDACTION_MAX_DEPTH`) and rebuilds containers rather than mutating
    them, so logging a structure never changes it.

    Args:
        _logger: The wrapped logger. Unused, part of the *structlog* processor signature.
        _name: The method name. Unused, part of the same signature.
        event_dict: The event being rendered.

    Returns:
        The same mapping, its values replaced in place and returned as the chain requires.
    """
    for key, value in list(event_dict.items()):
        event_dict[key] = _redact_value(value, _REDACTION_MAX_DEPTH)
    return event_dict


def _add_process_id(
    _logger: object, _name: str, event_dict: MutableMapping[str, Any]
) -> MutableMapping[str, Any]:
    """Stamp the emitting process's identifier onto the record.

    Read at emit time, and that is the whole subtlety of this three-line function. A module-level
    constant would be captured at IMPORT time - and this module is imported in the Gunicorn
    **arbiter**, by ``gunicorn.conf.py``, before any worker exists. Every forked worker would
    inherit the arbiter's value and the field would confidently name the wrong process on every
    request record in the image. ``os.getpid()`` per record costs a syscall in the noise of writing
    a line and cannot be wrong across a fork.

    ``setdefault`` rather than assignment, so a caller that has a more specific answer - a record
    describing a *different* process, such as a supervisor reporting on a child - keeps it. Nothing
    in this service does that today; the alternative is a processor that silently overwrites a
    field somebody deliberately set.

    Args:
        _logger: The wrapped logger. Unused, part of the *structlog* processor signature.
        _name: The method name. Unused, part of the same signature.
        event_dict: The event being built.

    Returns:
        The same event dictionary, mutated in place and returned as the chain requires.
    """
    event_dict.setdefault(LOG_FIELD_PROCESS_ID, os.getpid())
    return event_dict


def _shared_processors() -> list[Processor]:
    """Build the processors every record passes through, whatever emitted it.

    The same list is used twice: as the head of *structlog*'s own chain, and as
    ``ProcessorFormatter``'s ``foreign_pre_chain`` for records that came from the standard
    library. That is what makes a line from ``uvicorn.error``, ``alembic.runtime.migration``
    or ``sqlalchemy.engine.Engine`` carry the same keys, in the same order, as a line from a
    service.

    Order is a contract, not a preference:

    1. ``merge_contextvars`` **first**, so the request identifier bound by
       ``app.middleware.request_context`` is present before anything else can matter.
    2. ``add_logger_name`` before the terminal renderer, because it reads the ``_record``
       key that ``ProcessorFormatter.remove_processors_meta`` later deletes - for a foreign
       record that key is the only place the originating logger's name survives.
    3. ``add_log_level`` next, so ``level`` is a field rather than something a reader has to
       infer from a stream.
    4. :func:`_add_process_id`, which is in this list rather than in *structlog*'s chain alone
       for the reason the list exists: a Gunicorn arbiter line and a Uvicorn line are foreign
       records, and "which process wrote this?" is a question worth asking of exactly those.
    5. ``TimeStamper`` in ISO-8601 UTC. UTC because comparing two containers' logs must not
       depend on where they were scheduled, and ISO-8601 because it sorts lexicographically.
    6. ``StackInfoRenderer``, which renders ``stack_info=True`` into a ``stack`` field for a
       caller that wants a stack without an exception.

    Exception rendering and the terminal renderer are intentionally *not* here: they belong
    to :func:`_terminal_processors`, which the formatter runs once over both paths.
    """
    return [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        _add_process_id,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
    ]


LOG_EXCEPTION_VALUE_MAX_LENGTH: Final[int] = 1024
"""Longest exception message kept in a rendered traceback.

Larger than :data:`LOG_TEXT_MAX_LENGTH`, because an exception message is written by the code
that raised it rather than by a caller, and a driver or validation error can legitimately need
several hundred characters to be useful. Bounded all the same: a message built by
interpolating a request body into a string is an unbounded field with a different name.
"""

_EXCEPTION_KEY: Final[str] = "exception"
_EXCEPTION_VALUE_KEY: Final[str] = "exc_value"
_EXCEPTION_NOTES_KEY: Final[str] = "exc_notes"


def _sanitise_exception_values(
    _logger: object, _name: str, event_dict: MutableMapping[str, Any]
) -> MutableMapping[str, Any]:
    """Bound and neutralise the message of every exception in a rendered traceback.

    Runs between ``ExceptionRenderer`` and ``JSONRenderer``, on the structured frames the
    former produces, and rewrites only ``exc_value`` and ``exc_notes`` - the two members that
    hold text somebody else composed. Frames, filenames and line numbers come from the
    interpreter and are left exactly as they are.

    The message of an exception is not a trusted string. ``raise ValueError(f"bad slug:
    {value}")`` puts a request-supplied value into it verbatim, so a carriage return in that
    value becomes a line break in a rendered log, a bidirectional override reverses how the
    rest of the record reads, and an unbounded value makes an unbounded field. Applying
    :func:`log_safe_text` here means an exception message is subject to the same rules as a
    path, wherever it was raised and whoever wrote it - which is the only way to get that
    guarantee without auditing every ``raise`` in the codebase forever.

    What this does **not** do is remove a secret somebody interpolated into a message. That is
    :func:`redact_log_event`'s job, which runs immediately before this processor and covers the
    development path as well - so the two are complementary rather than alternatives: redaction
    decides what may be retained, and this decides how what remains may be rendered. The
    structural guarantee is unchanged either way, because the traceback renderer is constructed
    with ``show_locals=False`` so a frame's variables are never serialised at all.

    Args:
        _logger: The wrapped logger. Unused, part of the *structlog* processor signature.
        _name: The method name. Unused, part of the same signature.
        event_dict: The event being rendered, possibly carrying an ``exception`` list.

    Returns:
        The same event dictionary, mutated in place and returned as the chain requires.
    """
    rendered = event_dict.get(_EXCEPTION_KEY)
    if not isinstance(rendered, list):
        return event_dict

    for entry in rendered:
        if not isinstance(entry, dict):
            continue
        value = entry.get(_EXCEPTION_VALUE_KEY)
        if isinstance(value, str):
            entry[_EXCEPTION_VALUE_KEY] = log_safe_text(value, limit=LOG_EXCEPTION_VALUE_MAX_LENGTH)
        notes = entry.get(_EXCEPTION_NOTES_KEY)
        if isinstance(notes, list):
            entry[_EXCEPTION_NOTES_KEY] = [
                log_safe_text(note, limit=LOG_EXCEPTION_VALUE_MAX_LENGTH)
                if isinstance(note, str)
                else note
                for note in notes
            ]
    return event_dict


def _terminal_processors(*, development: bool) -> list[Processor]:
    """Return the exception renderer and the terminal renderer, chosen as one pair.

    They are returned together because they only make sense together, and pairing them in a
    single function makes the mismatch unrepresentable - a JSON renderer fed a
    pretty-printed traceback string, or a console renderer fed a list of frame dictionaries,
    are both silently wrong rather than loud.

    Development gets ``format_exc_info`` and ``ConsoleRenderer``: a rendered traceback below
    an aligned, readable line. Colours are enabled only when stdout is a terminal, so a
    captured or redirected stream carries no ANSI escapes.

    :func:`redact_log_event` is in **both** returned chains, immediately after the exception
    renderer and before the terminal renderer, and that symmetry is the point. A developer's
    terminal is not a private sink - it is scraped into a scrollback buffer, a CI transcript and
    a pasted bug report - so a chain that redacted only the shipping path would be deciding that
    a leaked credential is acceptable as long as it leaked locally. Placing it after the
    exception renderer is what lets one processor cover both representations: a formatted
    traceback string here, a list of frame dictionaries there.

    Every other environment gets structured frames and one JSON object per line.
    ``ExceptionDictTransformer`` is constructed explicitly instead of using the
    ``structlog.processors.dict_tracebacks`` shortcut for one reason: the shortcut defaults
    to ``show_locals=True``, which serialises every frame's local variables into the record.
    In this service those locals include a plaintext password inside ``auth_service``, the
    signing key inside ``core.security`` and a raw refresh token inside token rotation, so
    the shortcut would turn any exception on those paths into a credential leak. Structured
    frames without locals keep the diagnostic value and drop the hazard.

    Args:
        development: Whether to render for a human reading a terminal. Supplied by
            :func:`configure_logging` from ``settings.is_development`` rather than read here,
            so that importing this module constructs no settings - see "Import purity" in the
            module docstring. Keyword-only, because a bare boolean at a call site says
            nothing about which of the two renderers it selects.

    Returns:
        The exception renderer and terminal renderer, in the order they must run.
    """
    if development:
        return [
            structlog.processors.format_exc_info,
            redact_log_event,
            structlog.dev.ConsoleRenderer(colors=sys.stdout.isatty()),
        ]
    return [
        structlog.processors.ExceptionRenderer(ExceptionDictTransformer(show_locals=False)),
        redact_log_event,
        _sanitise_exception_values,
        structlog.processors.JSONRenderer(),
    ]


def _delegate_to_root(name: str, level: int) -> None:
    """Point one library logger at the root handler and set its threshold.

    Detaching the logger's own handlers is what prevents a second, differently formatted
    copy of the same event; restoring ``propagate`` is what makes the remaining copy reach
    the handler this module installed. A detached handler is not closed, because it belongs
    to the library that created it and may be reused if that library reconfigures itself.

    A *level* of ``logging.NOTSET`` means "inherit the root threshold", which is what almost
    every logger here wants.
    """
    logger = logging.getLogger(name)
    for attached in list(logger.handlers):
        logger.removeHandler(attached)
    logger.propagate = True
    logger.setLevel(level)


def _silence(name: str) -> None:
    """Make one library logger emit nothing at all, whatever its level.

    Used for the servers' own access loggers, whose event
    ``app.middleware.request_context`` already owns. Three steps, each closing one way the
    records could still get out: the logger's own handlers are detached, ``propagate`` is
    switched off so the root handler this module installed is never reached, and a
    ``NullHandler`` is attached so the record does not fall through to
    ``logging.lastResort`` (which writes WARNING and above to stderr, unformatted).

    Deliberately not done by raising the level: a level is something an ambient
    ``LOG_LEVEL`` or a later ``dictConfig`` can lower again, whereas a logger with no route
    to a handler stays silent.
    """
    logger = logging.getLogger(name)
    for attached in list(logger.handlers):
        logger.removeHandler(attached)
    logger.propagate = False
    logger.addHandler(logging.NullHandler())


def _bridge_library_loggers(level: int) -> None:
    """Route every dependency's logger through the root handler exactly once - or nowhere.

    Called after the root handler is in place. The uvicorn, gunicorn, alembic and warnings
    loggers inherit the configured threshold; the SQLAlchemy namespace is pinned to
    ``WARNING`` unless the operator asked for ``DEBUG``, so statement logging is something a
    deployment opts into rather than something it discovers in a bill for log storage; the
    servers' access loggers are silenced, because this service already writes exactly one
    access line per request from the middleware that has the request identifier bound; and
    ``uvicorn.error`` additionally carries a filter that drops the one duplicate traceback
    ``ServerErrorMiddleware`` causes it to write.
    """
    for name in _DELEGATED_LOGGERS:
        _delegate_to_root(name, logging.NOTSET)

    # After the delegation above, which detached uvicorn's own handlers - the filter belongs
    # on the logger rather than on a handler so it applies wherever the record would go, and
    # it is re-added idempotently because `configure_logging` may be called more than once.
    uvicorn_error = logging.getLogger("uvicorn.error")
    for existing in list(uvicorn_error.filters):
        if isinstance(existing, _DuplicateAsgiTracebackFilter):
            uvicorn_error.removeFilter(existing)
    uvicorn_error.addFilter(_DuplicateAsgiTracebackFilter())

    for name in _SILENCED_ACCESS_LOGGERS:
        _silence(name)

    sql_level = logging.NOTSET if level <= logging.DEBUG else _SQL_QUIET_LEVEL
    for name in _SQL_LOGGERS:
        _delegate_to_root(name, sql_level)


def _replace_root_handler(handler: logging.Handler, level: int) -> None:
    """Make *handler* the one and only handler on the root logger.

    Replacement, not addition, is what makes :func:`configure_logging` idempotent: calling it
    twice - once from the application lifespan and once from a test fixture - leaves exactly
    one handler and therefore exactly one rendered line per call, instead of doubling the
    output every time.

    Handlers already attached are detached but not closed, with one exception: the handler
    this module installed on a previous call is closed, because nothing else can. Closing a
    handler this module did not create would break whatever owns it - a test runner's capture
    handler being the common case - and closing this one releases nothing shared, since a
    ``StreamHandler`` never owns the stream it writes to.
    """
    global _installed_handler

    root = logging.getLogger()
    for attached in list(root.handlers):
        root.removeHandler(attached)

    if _installed_handler is not None:
        _installed_handler.close()

    root.addHandler(handler)
    root.setLevel(level)
    _installed_handler = handler


def configure_logging(*, stream: TextIO | None = None) -> None:
    """Install this service's logging configuration. Safe to call more than once.

    ``app.main`` calls this first in its lifespan startup, and the test suite calls it from a
    session fixture. Both paths land on the same state:

    * *structlog* renders through the standard library, so one handler on the root logger -
      writing to *stream*, formatted by ``ProcessorFormatter`` - is the single exit for
      application events, dependency events and Python warnings alike.
    * The threshold is ``settings.LOG_LEVEL``, applied in three places for one reason each.
      ``make_filtering_bound_logger`` makes a below-threshold call return immediately, before
      an event dictionary is built or a processor runs, which is where the cost would be. The
      root logger's level applies the same threshold to every dependency that has no opinion
      of its own. The handler's level makes it a floor rather than a default, so a third-party
      logger that raises its own level cannot write below what the operator configured.
    * The renderer comes from :func:`_terminal_processors`: readable in development, one JSON
      object per line everywhere else.
    * ``cache_logger_on_first_use=True`` lets a bound logger memoise its underlying logger,
      which is why :func:`get_logger` must not be called at import time - see its docstring.

    Reconfiguring is a genuine operation rather than a no-op: a test that changes
    ``ENVIRONMENT`` or ``LOG_LEVEL`` on the settings object and calls this again gets the new
    renderer and the new threshold, and still exactly one handler.

    The settings import is local to this function, and that placement is load-bearing rather
    than stylistic: it is what keeps ``import app.core.logging`` - and therefore
    ``import app.core.exceptions`` and ``import app.middleware`` - free of any settings
    construction. See "Import purity" in the module docstring. It also preserves the
    reconfiguration property above, because the singleton is re-read on every call.

    Args:
        stream:
            Where the single root handler writes. Defaults to ``sys.stdout``, which is the
            service's sink and what ``app.main`` and ``app.db.seed`` therefore use by taking
            the default. It is resolved when this function runs rather than when the module is
            imported, so the default is whatever ``sys.stdout`` is at configuration time - the
            process stdout the container runtime collects in a deployment, and a capture buffer
            under a test.

            One caller passes ``sys.stderr``, and the reason is a correctness requirement
            rather than a preference. ``backend/migrations/env.py`` runs under a CLI whose
            ``--sql`` mode writes *generated DDL* to stdout::

                alembic upgrade head --sql > schema.sql

            A log record on that stream lands inside the redirected file and makes it
            non-executable SQL - and it is not only this project's own diagnostic line but
            every record Alembic's own ``alembic.runtime.migration`` logger emits before the
            first statement (``Context impl PostgresqlImpl.``, ``Generating static SQL``,
            ``Will assume transactional DDL.``), all of which arrive through the root handler
            installed here. Pointing that one process's handler at stderr keeps stdout a pure
            SQL channel while the records still reach the container's collected output, which
            takes both streams. It is also what Alembic's own generated template does: the
            ``[handler_console]`` stanza it ships binds ``args=(sys.stderr,)``.
    """
    # Imported here, not at module scope. See the docstring above.
    from app.core.config import settings

    level = _resolve_level(settings.LOG_LEVEL)
    shared = _shared_processors()

    # `remove_processors_meta` first, because it deletes the bookkeeping keys
    # (`_record`, `_from_structlog`) that the shared chain above has already read, and every
    # renderer downstream would otherwise emit them. Exception rendering and the terminal
    # renderer sit here, not in the shared chain, so that ProcessorFormatter applies them
    # exactly once to both structlog-originated and standard-library records.
    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=shared,
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            *_terminal_processors(development=settings.is_development),
        ],
    )

    # `sys.stdout` is read here rather than bound as the parameter's default, so the default is
    # resolved per call: a test that replaces sys.stdout between two calls gets the replacement,
    # where a default evaluated at definition time would have captured the original object.
    handler = logging.StreamHandler(stream=sys.stdout if stream is None else stream)
    handler.setFormatter(formatter)
    handler.setLevel(level)
    _replace_root_handler(handler, level)

    structlog.configure(
        # `wrap_for_formatter` must be last: it packs the event dictionary into the arguments
        # of a standard-library call so that the handler's formatter can render it.
        processors=[*shared, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    _bridge_library_loggers(level)

    # Send `warnings.warn` output through the logging chain instead of letting it reach
    # stderr as unstructured text. Without this, a dependency's DeprecationWarning is the one
    # line in a production stream that a JSON parser cannot read.
    logging.captureWarnings(capture=True)


def get_logger(name: str | None = None) -> FilteringBoundLogger:
    """Return a bound logger. The only way to obtain a logger in this backend.

    Routing every caller through here is what keeps the configuration in one place: no other
    module re-derives a processor chain, and none calls ``logging.getLogger`` directly, so a
    change to the log shape is a change to this file and nowhere else.
    ``app.core.exceptions`` and ``app.middleware.request_context`` are its first consumers.

    Args:
        name:
            Logger name, conventionally the calling module's ``__name__``, which is what
            makes the ``logger`` field in the output point at the code that emitted the line.
            When omitted, *structlog* infers the calling module instead - convenient in a
            small module, but explicit is better in a package this size.

    Returns:
        A logger carrying the level-filtering interface *structlog* was configured with:
        ``debug``/``info``/``warning``/``error``/``critical``/``exception``, their ``a``-
        prefixed async variants, and ``bind``/``unbind``/``new`` for adding context that
        stays attached. Keyword arguments become fields, so
        ``logger.info("post published", post_id=…)`` is one queryable record rather than a
        sentence a parser has to take apart.

    Calling this at module scope is a mistake, and a quiet one. The returned logger resolves
    the active configuration on first use and - with ``cache_logger_on_first_use`` enabled -
    keeps it, so a logger created while a module is being imported can capture *structlog*'s
    unconfigured defaults and then never notice :func:`configure_logging` running afterwards.
    Call this inside the function that logs. ``app.main`` configures logging in its lifespan
    startup, before any request can reach a handler that asks for a logger.
    """
    # `structlog.get_logger` is annotated as returning `Any` because the concrete class
    # depends on the configured `wrapper_class`; binding it to the protocol that
    # `make_filtering_bound_logger` produces is what gives callers a checked interface.
    # An explicit branch rather than `get_logger(name)` with a None argument: the standard
    # library resolves `getLogger(None)` to the root logger, which would label every such
    # line `root` instead of letting structlog infer the calling module.
    logger: FilteringBoundLogger = (
        structlog.get_logger() if name is None else structlog.get_logger(name)
    )
    return logger


# ---------------------------------------------------------------------------------------
# The Gunicorn arbiter, which is the one process this module cannot reach on its own
#
# See "Under Gunicorn the arbiter is a second process" in the module docstring for the
# measurement. In short: the arbiter binds the socket, forks and handles signals without ever
# importing `app.main`, so its own boot and shutdown lines are the only ones that escape the
# structured stream - and `logger_class` is the only hook gunicorn offers inside it. The class
# below is the implementation; `backend/gunicorn.conf.py` is the one place it is selected.
#
# The base class has to be imported at module scope, because a base class cannot be resolved
# lazily, and that is safe here on both counts this module cares about. `gunicorn==26.0.0` is a
# pinned RUNTIME dependency in backend/requirements.txt - not a development one - so it is
# present wherever the application is, and `gunicorn.glogging` imports the standard library and
# `gunicorn.util` and does nothing on import: no handler, no logger mutation, no configuration
# read. Import purity as this module defines it is therefore untouched; what would break it is
# calling `configure_logging` from here, which only the method below does, and only when gunicorn
# constructs it.
# ---------------------------------------------------------------------------------------


class StructlogGunicornLogger(_GunicornLogger):  # type: ignore[misc]
    """Gunicorn's logger, reconfigured so the arbiter's own records are structured too.

    The **only** implementation of this hook, and it is selected in exactly one place:
    ``backend/gunicorn.conf.py`` imports it and publishes it as ``logger_class``, and
    ``backend/Dockerfile``'s ``CMD`` names that file with ``--config gunicorn.conf.py`` and passes
    no ``--logger-class`` of its own. That arrangement is deliberate. A command-line setting
    outranks a configuration file, so a flag on the ``CMD`` and an assignment in the config file
    are two selections of which only one can win - and while both existed, the config file's copy
    was unreachable in the shipped image while looking, in code review and in its own tests,
    exactly like live code.

    ``Arbiter.setup`` constructs ``cfg.logger_class(app.cfg)`` before the arbiter logs anything and
    ``Arbiter.__init__`` calls ``setup`` immediately, so this class is in place for the arbiter's
    first line - which is what no later hook can achieve. ``gunicorn.conf.py`` records why
    ``on_starting``, ``post_fork`` and ``logconfig_dict`` cannot substitute for it.

    One method, and the order inside it is the whole design.
    """

    def setup(self, cfg: Any) -> None:
        """Let gunicorn configure itself, then take the handlers back.

        ``super().setup(cfg)`` runs first and is not skipped: it is what sets ``self.loglevel``
        from ``--log-level``, honours ``--capture-output``, and leaves gunicorn's own bookkeeping
        (``error_handlers``, ``access_handlers``, ``logfile``) in the state the rest of the class
        expects. Skipping it to avoid the plain-text handler it attaches would mean maintaining a
        copy of that bookkeeping here.

        :func:`configure_logging` then runs and undoes exactly the part that matters. It installs
        this service's single root handler and calls :func:`_bridge_library_loggers`, which
        detaches the handler ``super().setup`` just attached to ``gunicorn.error``, restores its
        propagation so its records reach the structured handler instead, and re-silences
        ``gunicorn.access`` so the server's access log stays off and
        ``app.middleware.request_context`` remains the sole owner of the access record. The
        arbiter's threshold therefore comes from ``LOG_LEVEL`` like every other logger's, not
        from ``--log-level``: one setting decides what this deployment records.

        It is called for the arbiter and again in each forked worker, and both are wanted -
        :func:`configure_logging` is idempotent by construction, and the worker additionally
        re-applies it when it imports ``app.main``.

        Args:
            cfg: Gunicorn's own configuration object. Typed as :class:`~typing.Any` because
                ``gunicorn`` ships no type information, and this signature must match the
                superclass's exactly for gunicorn to call it.
        """
        super().setup(cfg)
        configure_logging()
