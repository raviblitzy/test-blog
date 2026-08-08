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
Everything a dependency logs - ``uvicorn``, ``uvicorn.access``, ``uvicorn.error``,
``gunicorn.error``, ``gunicorn.access``, ``sqlalchemy.engine``, ``alembic``, and Python
warnings - is formatted by the same processors through
``structlog.stdlib.ProcessorFormatter``, so a non-development deployment emits JSON and only
JSON. Those loggers also have their own handlers detached and their propagation restored, so
each line is written exactly once instead of twice: ``backend/Dockerfile`` runs Gunicorn with
Uvicorn workers, and both families configure handlers of their own when they start.

One boundary is worth naming, because it is visible in a real deployment and is not a defect
in this module. A server writes a few lines before it has imported the application at all -
Uvicorn installs its own logging dictionary while its ``Config`` is constructed and then logs
``Started server process`` and ``Waiting for application startup.``, and Gunicorn's boot
messages arrive the same way. Nothing this module does can reach back and reshape a line that
was already written, so with :func:`configure_logging` invoked from the lifespan those first
lines carry the server's own plain-text format; everything from application startup onward is
structured. Measured under Uvicorn 0.52 at ``ENVIRONMENT=production``: two plain lines then
twelve JSON ones, with the access line appearing exactly once. Whoever owns the entry point
can close even that gap, because Uvicorn configures its logging *before* it imports the
application: calling :func:`configure_logging` while ``app.main`` is imported, rather than
only in the lifespan, made all ten lines of the same run JSON with none in plain text. That
is a decision for the entry point, not for this module, which stays free of import-time
effects for the reasons below.

Deliberate exclusions
---------------------
stdout is the only sink. There is no file handler, no rotation, no syslog, no OTLP or APM
exporter, no metrics registry and no tracing provider: structured logging with request
correlation plus the liveness and readiness probes is this project's observability floor, and
an exporter would be a dependency and an operational surface the scope does not call for. The
request-identifier middleware is not here either - it lives in
``app.middleware.request_context``; this module only makes the ``contextvars`` mechanism work.

Import purity, and why it is a requirement
------------------------------------------
Importing this module has **no** side effect: it attaches no handler, mutates no logger and
writes nothing. Configuration happens only when :func:`configure_logging` is called.
``backend/migrations/env.py`` and the unit suite import from ``app.core`` without asking for
logging to be reconfigured underneath them, and an ``alembic upgrade head`` that silently
re-pointed the root logger would be a surprise in the worst possible place.

Secrets never reach a log line
------------------------------
A log line leaves the process, so it is an exfiltration path in the same way a committed file
is. Nothing here logs a value: the module reads two settings and never renders them, never
logs ``settings`` as an object, and the JSON traceback renderer is constructed with
``show_locals=False`` precisely so that a frame holding a password, a signing key or a raw
refresh token cannot be serialised into a traceback. Callers keep that guarantee by logging
identifiers rather than credentials.
"""

import logging
import sys
from typing import Final

import structlog
from structlog.tracebacks import ExceptionDictTransformer
from structlog.typing import FilteringBoundLogger, Processor

from app.core.config import settings

__all__ = ["configure_logging", "get_logger"]


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
    # Uvicorn: `uvicorn.error` carries lifecycle and application errors, `uvicorn.access`
    # carries the request line. Both are children of `uvicorn`, which is named as well
    # because uvicorn's own dictionary configures the parent too.
    "uvicorn",
    "uvicorn.access",
    "uvicorn.error",
    # Gunicorn: the production process manager (see backend/Dockerfile). Present only when
    # the service runs under it; naming a logger that never emits costs nothing.
    "gunicorn",
    "gunicorn.access",
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
# SQLAlchemy's namespace, which needs a threshold rather than only a handler
#
# SQLAlchemy emits every rendered statement, and its bound parameters, at INFO on
# `sqlalchemy.engine`. Letting that namespace simply inherit an INFO root would turn one
# request into a dozen lines of SQL in production, so statement echo is opt-in: it is
# enabled only when the operator asks for DEBUG, and an explicit `create_engine(echo=True)`
# still works because that sets the logger's own level, which wins over the value set here.
# ---------------------------------------------------------------------------------------
_SQL_LOGGERS: Final[tuple[str, ...]] = ("sqlalchemy", "sqlalchemy.engine", "sqlalchemy.pool")

_SQL_QUIET_LEVEL: Final[int] = logging.WARNING
"""Level pinned on the SQLAlchemy namespace unless ``LOG_LEVEL`` is ``DEBUG``."""


# The single handler this module installs, remembered so that a second call to
# `configure_logging` can close the one it replaces. Only ever assigned there.
_installed_handler: logging.Handler | None = None


def _resolve_level() -> int:
    """Translate the configured ``LOG_LEVEL`` name into its numeric level.

    ``logging.getLevelNamesMapping`` is the standard library's own name-to-number table, so
    there is no second copy of ``{"INFO": 20, ...}`` to keep in step here.

    The subscript is deliberate, and there is deliberately no fallback:
    ``Settings.LOG_LEVEL`` is a ``Literal`` of the five level names, validated while the
    process is still starting, so a lookup miss is impossible by construction. Were one to
    happen anyway it must raise, because ``.get(name, logging.INFO)`` would answer a
    misconfiguration by quietly logging at a level nobody asked for.
    """
    return logging.getLevelNamesMapping()[settings.LOG_LEVEL]


def _shared_processors() -> list[Processor]:
    """Build the processors every record passes through, whatever emitted it.

    The same list is used twice: as the head of *structlog*'s own chain, and as
    ``ProcessorFormatter``'s ``foreign_pre_chain`` for records that came from the standard
    library. That is what makes a line from ``uvicorn.access`` carry the same keys, in the
    same order, as a line from a service.

    Order is a contract, not a preference:

    1. ``merge_contextvars`` **first**, so the request identifier bound by
       ``app.middleware.request_context`` is present before anything else can matter.
    2. ``add_logger_name`` before the terminal renderer, because it reads the ``_record``
       key that ``ProcessorFormatter.remove_processors_meta`` later deletes - for a foreign
       record that key is the only place the originating logger's name survives.
    3. ``add_log_level`` next, so ``level`` is a field rather than something a reader has to
       infer from a stream.
    4. ``TimeStamper`` in ISO-8601 UTC. UTC because comparing two containers' logs must not
       depend on where they were scheduled, and ISO-8601 because it sorts lexicographically.
    5. ``StackInfoRenderer``, which renders ``stack_info=True`` into a ``stack`` field for a
       caller that wants a stack without an exception.

    Exception rendering and the terminal renderer are intentionally *not* here: they belong
    to :func:`_terminal_processors`, which the formatter runs once over both paths.
    """
    return [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
    ]


def _terminal_processors() -> list[Processor]:
    """Return the exception renderer and the terminal renderer, chosen as one pair.

    They are returned together because they only make sense together, and pairing them in a
    single function makes the mismatch unrepresentable - a JSON renderer fed a
    pretty-printed traceback string, or a console renderer fed a list of frame dictionaries,
    are both silently wrong rather than loud.

    Development gets ``format_exc_info`` and ``ConsoleRenderer``: a rendered traceback below
    an aligned, readable line. Colours are enabled only when stdout is a terminal, so a
    captured or redirected stream carries no ANSI escapes.

    Every other environment gets structured frames and one JSON object per line.
    ``ExceptionDictTransformer`` is constructed explicitly instead of using the
    ``structlog.processors.dict_tracebacks`` shortcut for one reason: the shortcut defaults
    to ``show_locals=True``, which serialises every frame's local variables into the record.
    In this service those locals include a plaintext password inside ``auth_service``, the
    signing key inside ``core.security`` and a raw refresh token inside token rotation, so
    the shortcut would turn any exception on those paths into a credential leak. Structured
    frames without locals keep the diagnostic value and drop the hazard.
    """
    if settings.is_development:
        return [
            structlog.processors.format_exc_info,
            structlog.dev.ConsoleRenderer(colors=sys.stdout.isatty()),
        ]
    return [
        structlog.processors.ExceptionRenderer(ExceptionDictTransformer(show_locals=False)),
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


def _bridge_library_loggers(level: int) -> None:
    """Route every dependency's logger through the root handler exactly once.

    Called after the root handler is in place. The uvicorn, gunicorn, alembic and warnings
    loggers inherit the configured threshold; the SQLAlchemy namespace is pinned to
    ``WARNING`` unless the operator asked for ``DEBUG``, so statement echo is something a
    deployment opts into rather than something it discovers in a bill for log storage.
    """
    for name in _DELEGATED_LOGGERS:
        _delegate_to_root(name, logging.NOTSET)

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


def configure_logging() -> None:
    """Install this service's logging configuration. Safe to call more than once.

    ``app.main`` calls this first in its lifespan startup, and the test suite calls it from a
    session fixture. Both paths land on the same state:

    * *structlog* renders through the standard library, so one handler on the root logger -
      writing to stdout, formatted by ``ProcessorFormatter`` - is the single exit for
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

    The stream is resolved when this runs rather than when the module is imported, so it is
    whatever ``sys.stdout`` is at configuration time - the process stdout the container
    runtime collects in a deployment, and a capture buffer under a test.
    """
    level = _resolve_level()
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
            *_terminal_processors(),
        ],
    )

    handler = logging.StreamHandler(stream=sys.stdout)
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
