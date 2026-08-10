"""Gunicorn configuration whose only job is to make the arbiter's own log lines structured.

``backend/Dockerfile`` runs this service under ``gunicorn app.main:app`` with Uvicorn workers, and
``app.core.logging`` explains at length why that produces a *mixed* log stream while nothing here
exists: Gunicorn's **arbiter** binds the socket, forks workers and handles signals in a process
that never imports ``app.main``, so the import-time and lifespan calls to
:func:`~app.core.logging.configure_logging` are unreachable from it. Measured under
``gunicorn app.main:app -k uvicorn.workers.UvicornWorker -w 2`` at ``ENVIRONMENT=production``, 10
of 34 lines were plain text and all 10 came from the arbiter - six at boot and four at shutdown.
Every worker-side line, request records included, was already JSON. This file closes that gap, and
it is the only place that can: a hook running inside the arbiter is the sole point of entry.

Why ``logger_class`` and not ``on_starting``
--------------------------------------------
``app.core.logging`` offers both, and only one of them actually works. Read in the installed
``gunicorn`` 26.0.0 rather than assumed:

* ``Arbiter.setup`` constructs the logger - ``self.log = self.cfg.logger_class(app.cfg)`` - and
  ``Arbiter.__init__`` calls ``setup`` immediately.
* ``Arbiter.start`` logs ``Starting gunicorn <version>`` as its **first** statement and only then
  calls ``self.cfg.on_starting(self)``.

So an ``on_starting`` hook is already too late for the first line, and for the ``Listening at:``
and ``Using worker:`` lines that a very early failure would be diagnosed from. Constructing the
logger, by contrast, happens before anything at all has been logged, which makes
:class:`StructlogArbiterLogger` the one hook that closes the window completely rather than
narrowing it.

``post_fork`` is deliberately absent for the same kind of reason: it runs in the child, *after* the
child has logged ``Booting worker with pid``, and by then the child has inherited an already
configured root handler across the fork and is about to call
:func:`~app.core.logging.configure_logging` twice more on its own (at ``app.main`` import and again
in the lifespan). A third call would be a no-op, and a hook that does nothing is worse than no hook
- it reads as though it were load-bearing.

``logconfig_dict`` is likewise not set. Its default is ``{}``, Gunicorn applies it through
``dictConfig`` at the *end* of ``Logger.setup``, and this file reconfigures logging after that call
returns - so declaring a neutral dictionary here would add a step that could only ever undo the
step that follows it.

What this file does not do
--------------------------
No ``workers``, no ``bind``, no ``worker_class``, no ``timeout``, no ``access-logfile``. Every one
of those stays in ``backend/Dockerfile``'s ``CMD``, where an operator can already override it with
``GUNICORN_CMD_ARGS`` or by replacing ``command:`` in Compose, and where the reasoning behind each
choice is written beside it. Splitting the deployment's process configuration across two files
would give the same setting two homes; this file adds the one thing the command line cannot express
and nothing else.

Where this file sits in the quality gates
-----------------------------------------
``ruff check`` and ``ruff format`` cover it, because they run over the whole of ``backend/``. The
type-check gate does not: ``[tool.mypy] files = ["app"]`` in ``backend/pyproject.toml`` scopes it to
the application package, and this file sits outside it for the same reason
``backend/migrations/`` does - it is deployment configuration executed by a tool, not application
source. That scoping is also what keeps ``strict = true`` honest: ``gunicorn`` publishes no type
information, so a subclass of its logger resolves to a subclass of ``Any``, and pulling this file
into the gate would mean either a stub dependency or relaxing ``disallow_subclassing_any`` for
everything. ``cfg`` is therefore annotated :class:`~typing.Any` deliberately, and nothing here
reads it.

Its behaviour is nevertheless tested rather than assumed:
``backend/tests/unit/test_gunicorn_logging.py`` asserts the observable outcome - that constructing
:data:`logger_class` leaves ``gunicorn.error`` propagating to this service's root handler with no
handler of its own - and separately asserts that ``backend/Dockerfile`` both ships this file and
names it.

One consequence worth stating plainly
-------------------------------------
:func:`~app.core.logging.configure_logging` reads ``LOG_LEVEL`` and ``ENVIRONMENT`` through
``app.core.config``, which constructs the full :class:`~app.core.config.Settings` model - and that
model validates ``DATABASE_URL``, ``JWT_SECRET_KEY`` and the rest. The arbiter therefore now
validates the environment *before* it forks anything, where previously the first failure appeared
in a worker after fork. That is strictly better: a missing or malformed variable stops the boot once
with a validation error naming the field, instead of putting the arbiter into a worker respawn loop.
It is the same set of variables either way, so nothing new is required of a deployment.
"""

from __future__ import annotations

from typing import Any

from gunicorn.glogging import Logger

from app.core.logging import configure_logging

__all__ = ["StructlogArbiterLogger", "logger_class"]


class StructlogArbiterLogger(Logger):
    """Gunicorn's own logger, with this service's structured configuration applied on top.

    Subclassed rather than replaced. Gunicorn's :class:`~gunicorn.glogging.Logger` owns a great
    deal more than formatting - the ``--log-level`` mapping, ``--capture-output``'s file descriptor
    redirection, syslog handling, the access-line atoms, ``reopen_files`` for log rotation - and
    every one of those must keep working. So ``super().setup()`` runs in full and unmodified, and
    only then is the log *shape* replaced.
    """

    def setup(self, cfg: Any) -> None:
        """Let Gunicorn configure itself, then hand the whole process to ``configure_logging``.

        Order is the entire point. ``super().setup`` attaches Gunicorn's own plain-text handler to
        ``gunicorn.error``, sets ``propagate = False`` on it and on ``gunicorn.access``, and - if
        one was supplied - applies ``logconfig_dict``. :func:`~app.core.logging.configure_logging`
        then installs this service's single root handler and calls its own delegation pass, which
        detaches those handlers, restores ``propagate`` so the record reaches the root handler
        exactly once, and silences ``gunicorn.access`` because
        ``app.middleware.request_context`` already writes one access record per request with the
        request identifier bound. Both logger names are already in that module's delegated set, so
        this file adds no logger configuration of its own and none should be added to it.

        Reversing the two calls would leave Gunicorn's handler attached and ``propagate`` off,
        which is exactly the state being fixed.

        Args:
            cfg: The Gunicorn configuration object, passed straight through to the base
                implementation. Nothing here reads it: the log shape is this service's decision and
                comes from ``LOG_LEVEL`` and ``ENVIRONMENT``, not from a Gunicorn setting.
        """
        super().setup(cfg)
        configure_logging()


logger_class = StructlogArbiterLogger
"""The ``--logger-class`` Gunicorn will instantiate, given as the class itself.

A class object rather than the usual dotted string, which ``gunicorn.config.validate_class``
accepts directly and ``gunicorn.util.load_class`` returns unchanged. That is deliberate: a dotted
path would have to name an importable module, which would mean either a second file existing only
to hold six lines or this file importing itself by the name Gunicorn happens to exec it under
(``__config__``). Naming the class keeps the definition and its registration in one place and
removes any chance of the two drifting.
"""
