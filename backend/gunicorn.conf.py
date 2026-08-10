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
:data:`logger_class` the one hook that closes the window completely rather than narrowing it.

One implementation, selected in one place
-----------------------------------------
This file **imports** the logger class rather than defining one.
:class:`~app.core.logging.StructlogGunicornLogger` is the implementation, it lives beside
:func:`~app.core.logging.configure_logging` whose ordering contract it depends on, and this file's
whole contribution is to name it as ``logger_class``.

That is a correction, not a preference. There used to be a second, identical implementation here
*and* a ``--logger-class`` flag on the Dockerfile's ``CMD`` naming the one in ``app.core.logging``.
A command-line setting outranks a configuration file in Gunicorn, so the class defined here was
never constructed in the shipped image: it read as live, it had tests of its own, and every one of
them exercised code the container could not reach. Two implementations of one hook is one too many
whichever wins - the loser drifts, and a reader cannot tell from either file which is in force. So
the definition has one home and the selection has one home, and they are not the same file.

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
type-check gate does not: ``[tool.mypy] files = ["app", "tests"]`` in ``backend/pyproject.toml``
scopes it to the application package and the suite, and this file sits outside both for the same
reason ``backend/migrations/`` does - it is deployment configuration executed by a tool, not
application source. The class it selects **is** inside that gate, which is another reason for the
implementation to live in ``app.core.logging``: the subclass-of-``Any`` problem that ``gunicorn``'s
missing type information creates is handled there, once, rather than by keeping a second copy
outside the gate.

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

from app.core.logging import StructlogGunicornLogger

__all__ = ["logger_class"]


logger_class = StructlogGunicornLogger
"""The logger class Gunicorn will instantiate, given as the class itself.

A class object rather than the usual dotted string, which ``gunicorn.config.validate_class``
accepts directly and ``gunicorn.util.load_class`` returns unchanged. That matters here: a dotted
path would be a second spelling of the same selection, and a second spelling is exactly what this
file was corrected to remove.

:class:`~app.core.logging.StructlogGunicornLogger` is where the behaviour is documented and tested,
and the reason it belongs there rather than here is the ordering contract it depends on:
``super().setup(cfg)`` must run first - it is what honours ``--log-level`` and ``--capture-output``
and leaves Gunicorn's own bookkeeping intact - and :func:`~app.core.logging.configure_logging` must
run second, taking the handlers back and restoring propagation on ``gunicorn.error``. Reversing
those two lines silently reinstates the plain-text handler and looks like working configuration in
review, which is why the class and the function it calls in a fixed order live in one module.

This assignment is the *whole* of this file's contribution, and it is the only place the selection
is made: ``backend/Dockerfile``'s ``CMD`` names ``--config gunicorn.conf.py`` and deliberately
passes no ``--logger-class``, because a command-line setting outranks a configuration file and two
places to look is how the two came to disagree.
"""
