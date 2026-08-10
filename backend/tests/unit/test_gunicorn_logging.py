"""The production entry point produces one log format, arbiter lines included.

``app.core.logging`` closes the plain-text window under uvicorn by calling
``configure_logging`` at ``app.main`` import time, before the server logs its first line. Under
Gunicorn that trick cannot work: the **arbiter** binds the socket, forks workers and handles
signals in a process that never imports ``app.main``, so its own lines - ``Starting gunicorn``,
``Listening at:``, ``Booting worker with pid:``, ``Handling signal: term``, ``Shutting down:
Master`` - render through Gunicorn's plain-text formatter while everything the workers emit is
JSON. Measured in this repository at ``ENVIRONMENT=production``: 9 of 30 lines plain, all 9 from
the arbiter. A JSON-only collector treats each as unparsed, once per container lifecycle.

``backend/gunicorn.conf.py`` closes it, and this module is what keeps it closed. Three separable
things have to hold, and each fails independently:

1. **The hook exists and does the right thing.** ``logger_class`` must be a Gunicorn logger, and
   constructing it must leave ``gunicorn.error`` routed through this service's single root handler.
2. **The hook is early enough.** A ``on_starting`` hook would run *after* ``Arbiter.start`` has
   already logged ``Starting gunicorn``; only constructing the logger happens before anything is
   logged at all. That ordering is a property of the installed Gunicorn, so it is asserted against
   the installed Gunicorn rather than trusted to stay true across a version bump.
3. **The image actually uses it.** A configuration file that is not copied into the image, or is
   copied but never named, is indistinguishable from no configuration file at all - and the only
   symptom is a log stream that quietly goes back to being half plain text.

Why the observable state and not the call
-----------------------------------------
The behavioural assertion here is on ``gunicorn.error``'s handler and ``propagate`` after the
logger is constructed, not on ``configure_logging`` having been called. Asserting the call would
pass on a hook that called it at the wrong moment or whose effect was immediately undone by
Gunicorn's own ``logconfig_dict`` pass; asserting the resulting state is the thing that actually
determines whether an arbiter line is JSON.

``configure_logging`` mutates process-wide logging state, so every test that triggers it runs
inside :func:`restored_logging`, which snapshots the root logger and the two Gunicorn loggers and
puts them back afterwards. Without that, one test here would silently change the log shape for
every test that ran after it.
"""

from __future__ import annotations

import ast
import importlib.util
import inspect
import logging
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from typing import Any, Final

import pytest
from gunicorn.arbiter import Arbiter
from gunicorn.glogging import Logger as GunicornLogger

from app.core.logging import configure_logging

# ---------------------------------------------------------------------------------------
# Locating the two deployment artifacts
#
# Resolved from this file rather than from the process working directory, so the suite passes
# whether it is invoked from `backend/` or from the repository root.
# ---------------------------------------------------------------------------------------

BACKEND_ROOT: Final[Path] = Path(__file__).resolve().parents[2]
"""``backend/`` - the directory holding both the Gunicorn configuration and the Dockerfile."""

GUNICORN_CONFIG_PATH: Final[Path] = BACKEND_ROOT / "gunicorn.conf.py"
"""The configuration file under test. Also the exact path Gunicorn discovers by default."""

DOCKERFILE_PATH: Final[Path] = BACKEND_ROOT / "Dockerfile"
"""The production entry point that must ship the file above and name it."""

ARBITER_LOGGER_NAME: Final[str] = "gunicorn.error"
"""Where every arbiter line goes. Gunicorn sets ``propagate = False`` on it during its own setup,
which is precisely what severs it from this service's root handler."""

ACCESS_LOGGER_NAME: Final[str] = "gunicorn.access"
"""Gunicorn's request log. Silenced by ``configure_logging`` rather than reformatted, because
``app.middleware.request_context`` already writes one access record per request with the request
identifier bound."""


@pytest.fixture
def restored_logging() -> Iterator[None]:
    """Snapshot process-wide logging state, and put it back however the test ends.

    ``configure_logging`` replaces the root handler and rewrites the Gunicorn loggers, so a test
    that triggers it changes the log shape for the remainder of the session. Everything that could
    have been touched is captured by value - handler lists are copied rather than aliased - and
    restored in a ``finally``.

    Yields:
        ``None``. The fixture exists for its teardown.
    """
    root = logging.getLogger()
    names = (ARBITER_LOGGER_NAME, ACCESS_LOGGER_NAME, "gunicorn")
    snapshot = {
        name: (
            list(logging.getLogger(name).handlers),
            logging.getLogger(name).propagate,
            logging.getLogger(name).level,
        )
        for name in names
    }
    root_handlers = list(root.handlers)
    root_level = root.level
    try:
        yield
    finally:
        for name, (handlers, propagate, level) in snapshot.items():
            logger = logging.getLogger(name)
            logger.handlers = list(handlers)
            logger.propagate = propagate
            logger.setLevel(level)
        root.handlers = list(root_handlers)
        root.setLevel(root_level)


def _load_gunicorn_config() -> ModuleType:
    """Execute ``backend/gunicorn.conf.py`` the way Gunicorn does, and return the module.

    Gunicorn loads a configuration file with ``spec_from_file_location`` under the module name
    ``__config__``; this mirrors that rather than importing a package path, because the file is not
    importable as ``backend.gunicorn.conf`` and is never meant to be.

    Returns:
        The executed module, from which ``logger_class`` is read.
    """
    spec = importlib.util.spec_from_file_location(
        "_gunicorn_config_under_test", GUNICORN_CONFIG_PATH
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _StubGunicornConfig:
    """The handful of settings ``gunicorn.glogging.Logger.setup`` reads, and nothing more.

    A stub rather than a real ``gunicorn.config.Config`` so the test states exactly which settings
    the behaviour depends on. ``errorlog``/``accesslog`` of ``"-"`` is what the Dockerfile passes,
    ``capture_output`` stays false so no file descriptor is redirected under the test process, and
    ``logconfig_dict`` is empty because Gunicorn's default is empty - a non-empty one would run
    ``dictConfig`` and is the case the ordering in ``setup`` is designed to survive.
    """

    loglevel: str = "info"
    errorlog: str = "-"
    accesslog: str = "-"
    capture_output: bool = False
    syslog: bool = False
    logconfig: None = None
    logconfig_json: None = None
    logconfig_dict: dict[str, Any] = {}  # noqa: RUF012 - a stub attribute, never mutated


class TestArbiterLoggerClass:
    """``gunicorn.conf.py`` publishes a logger class that hands the arbiter to this service."""

    def test_the_config_publishes_a_gunicorn_logger_class(self) -> None:
        """``logger_class`` must be something Gunicorn will accept and instantiate.

        A class object rather than a dotted string, which ``gunicorn.config.validate_class``
        accepts and ``gunicorn.util.load_class`` returns unchanged. Subclassing Gunicorn's own
        logger is what preserves everything else it owns - the ``--log-level`` mapping,
        ``--capture-output``, syslog, the access atoms, ``reopen_files`` - so a replacement that
        merely satisfied the interface would silently drop those.
        """
        logger_class = _load_gunicorn_config().logger_class
        assert inspect.isclass(logger_class)
        assert issubclass(logger_class, GunicornLogger)

    def test_constructing_it_routes_arbiter_lines_through_the_root_handler(
        self, restored_logging: None
    ) -> None:
        """After construction, an arbiter line reaches this service's handler exactly once.

        The state being asserted is the whole mechanism. Gunicorn's ``setup`` attaches a
        plain-text handler to ``gunicorn.error`` and sets ``propagate = False``; the hook then runs
        ``configure_logging``, whose delegation pass detaches that handler and restores
        ``propagate``. Both halves matter: an attached handler would emit a second, differently
        formatted copy, and ``propagate`` left false would mean no copy reached the root handler at
        all.
        """
        logger_class = _load_gunicorn_config().logger_class

        logger_class(_StubGunicornConfig())

        arbiter_logger = logging.getLogger(ARBITER_LOGGER_NAME)
        assert arbiter_logger.handlers == []
        assert arbiter_logger.propagate is True

    def test_constructing_it_leaves_gunicorns_access_log_silent(
        self, restored_logging: None
    ) -> None:
        """The request log stays Gunicorn's to produce and this service's to suppress.

        ``--access-logfile -`` is passed by the Dockerfile, so Gunicorn attaches a handler to
        ``gunicorn.access`` during its own setup. Two access records per request - Gunicorn's
        plain-text one and the structured one ``app.middleware.request_context`` writes with the
        request identifier bound - would be a duplication, so ``configure_logging`` silences it
        with ``propagate = False`` and a ``NullHandler`` rather than by raising its level, which an
        ambient ``LOG_LEVEL`` could undo.
        """
        logger_class = _load_gunicorn_config().logger_class

        logger_class(_StubGunicornConfig())

        access_logger = logging.getLogger(ACCESS_LOGGER_NAME)
        assert access_logger.propagate is False
        assert [type(handler) for handler in access_logger.handlers] == [logging.NullHandler]

    def test_a_logger_class_is_the_only_hook_early_enough(self) -> None:
        """Constructing the logger precedes Gunicorn's first log line; ``on_starting`` does not.

        This is the justification for the chosen hook, asserted against the installed Gunicorn
        rather than left as a claim in a comment. ``Arbiter.setup`` builds
        ``self.cfg.logger_class(...)`` and ``Arbiter.__init__`` calls ``setup`` immediately, while
        ``Arbiter.start`` logs ``Starting gunicorn`` as its first statement and only afterwards
        calls ``on_starting``. Read from the source of the installed package, so a future version
        that reordered those two would fail here instead of quietly reintroducing plain-text boot
        lines.
        """
        start_body = ast.parse(inspect.getsource(Arbiter.start).lstrip()).body[0]
        assert isinstance(start_body, ast.FunctionDef)
        source = ast.unparse(start_body)

        first_log = source.index("Starting gunicorn")
        on_starting = source.index("on_starting")
        assert first_log < on_starting

        assert "logger_class" in ast.unparse(ast.parse(inspect.getsource(Arbiter.setup).lstrip()))


class TestProductionEntryPointUsesTheConfig:
    """The image ships the configuration file and names it on the command line."""

    def test_the_dockerfile_copies_the_config_into_the_payload(self) -> None:
        """A file that is not in the image cannot configure anything in it.

        The runtime stage copies one payload directory, so an artifact absent from that payload is
        absent from the container - and the failure is silent, because Gunicorn's default discovery
        of a missing ``./gunicorn.conf.py`` is a no-op rather than an error.
        """
        assert "COPY gunicorn.conf.py /payload/gunicorn.conf.py" in DOCKERFILE_PATH.read_text()

    def test_the_dockerfile_command_names_the_config_explicitly(self) -> None:
        """``--config`` turns a missing configuration file from silent degradation into a crash.

        Gunicorn would discover ``./gunicorn.conf.py`` in the working directory unaided, so this
        flag is redundant by design: an explicit ``--config`` naming a file that is not there is a
        hard startup error, which is the behaviour wanted if a future edit drops the ``COPY``
        above.
        """
        command = DOCKERFILE_PATH.read_text()
        assert '"--config", "gunicorn.conf.py"' in command
        assert '"gunicorn", "app.main:app"' in command


class TestConfigureLoggingRemainsIdempotent:
    """The hook relies on ``configure_logging`` being safe to call again, so that is asserted."""

    def test_calling_it_twice_leaves_exactly_one_root_handler(self, restored_logging: None) -> None:
        """Three calls happen in a Gunicorn worker: the hook, the app import, and the lifespan.

        The arbiter's call is inherited across ``fork``, then the child calls it at ``app.main``
        import and once more in the lifespan. If each call appended a handler, every worker line
        would be emitted three times - so idempotence is not a nicety of that function, it is what
        makes this hook safe to add at all.
        """
        configure_logging()
        first = list(logging.getLogger().handlers)
        configure_logging()
        second = list(logging.getLogger().handlers)

        assert len(first) == 1
        assert len(second) == 1
