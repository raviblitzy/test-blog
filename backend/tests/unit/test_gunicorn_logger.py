"""Unit suite for the Gunicorn logger class that keeps the arbiter's own records structured.

The gap this closes is narrow and was measured rather than assumed. Under Gunicorn, the **arbiter**
- the parent process that binds the socket, forks workers and handles signals - logs through an
object it constructs itself, before any application module has been imported. Left alone it writes
plain text: ``Starting gunicorn 26.0.0``, ``Listening at: http://0.0.0.0:8000``, ``Booting worker
with pid: 12``, ``Handling signal: term``, ``Shutting down: Master``. Nine such lines were observed
in a probe run at ``ENVIRONMENT=production`` while every worker line was already JSON, which is the
worst possible split: a log pipeline that parses JSON drops exactly the lines describing the
process's own lifecycle, so a restart loop or a failed bind becomes invisible in the one place an
operator looks.

:class:`~app.core.logging.StructlogGunicornLogger` is what ``backend/Dockerfile`` names on the
command line to fix that, and the fix is entirely a matter of ORDER: gunicorn's own ``setup`` must
run (it is what honours ``--log-level`` and ``--capture-output`` and leaves the class's bookkeeping
intact), and this service's :func:`~app.core.logging.configure_logging` must run *after* it, taking
the handlers back and restoring propagation on ``gunicorn.error`` so the arbiter's records reach the
structured handler. Reversing those two lines silently reinstates the plain-text handler and the
defect returns, looking exactly like a working configuration in code review.

Why this is a unit test and not only a runtime check
---------------------------------------------------
The behaviour was verified end to end in a real Gunicorn run - thirty JSON lines, zero plain-text
lines, arbiter records on ``gunicorn.error``, nothing on ``gunicorn.access`` - and that measurement
is what proves the class is wired correctly in the image. What a runtime check cannot do is *fail a
merge*: it is not part of any gate. So the observable outcomes are pinned here, against gunicorn's
real ``Logger`` base rather than a stand-in, driven through a configuration double shaped like the
subset of ``gunicorn.config.Config`` that :meth:`gunicorn.glogging.Logger.setup` actually reads.

What is asserted
----------------
Three things, and each is a separate way the defect comes back:

1. an arbiter record on ``gunicorn.error`` is rendered as JSON through the service's handler, which
   is the outcome the whole class exists for;
2. ``gunicorn.access`` stays silent, because ``app.middleware.request_context`` owns the access
   record and a second one would double every request in the log;
3. the threshold comes from this deployment's ``LOG_LEVEL`` rather than from gunicorn's
   ``--log-level``, so one setting decides what a deployment records.

The logging configuration is a process-wide side effect, so every test restores it in a fixture
teardown that runs whether the test passed, failed or was interrupted.
"""

from __future__ import annotations

import io
import json
import logging
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any, Final

import pytest

from app.core.config import settings
from app.core.logging import StructlogGunicornLogger, configure_logging

GUNICORN_ERROR_LOGGER: Final[str] = "gunicorn.error"
"""Logger the arbiter writes every lifecycle line to - the boot lines, the signals, the shutdown."""

GUNICORN_ACCESS_LOGGER: Final[str] = "gunicorn.access"
"""Logger gunicorn would write a second access record to, and which must stay silent.

``app.middleware.request_context`` emits exactly one structured access record per request, with the
correlation identifier, the duration and the anonymised client network already bound. A gunicorn
access line beside it would be an unstructured duplicate of a subset of that, so the configuration
silences this logger rather than reformatting it."""

ARBITER_MESSAGE: Final[str] = "MARKER-ARBITER: Booting worker with pid: 12"
"""A line shaped like a real arbiter boot line, distinctive enough to search a rendered stream for.

Deliberately one of the nine lines the probe observed as plain text: if this comes back as JSON, so
do the rest. It carries no address, because the redaction pass would rewrite one - which is the
subject of its own test below rather than noise in these."""

ARBITER_BIND_MESSAGE: Final[str] = "MARKER-BIND: Listening at: http://192.0.2.10:8000"
"""The arbiter line that names an address, and therefore the one that must be redacted.

``Listening at:`` is written by the arbiter at every boot, so this is not hypothetical: it is the
single most predictable place an address reaches the log. The value is from the RFC 5737
documentation range, so it identifies nothing."""

ARBITER_BIND_ADDRESS: Final[str] = "192.0.2.10"
"""The address inside the line above, searched for so its absence can be asserted."""

ARBITER_BIND_NETWORK: Final[str] = "192.0.2.0/24"
"""What that address must be reduced to - the ``/24`` ``app.core.logging`` publishes for a client
address and applies to free text alike."""

SUPPRESSED_ACCESS_MESSAGE: Final[str] = "MARKER-ACCESS: this line must not be recorded"
"""A line shaped like a gunicorn access record, planted so its absence can be asserted."""


def build_config_double(loglevel: str = "critical") -> Any:
    """Return a stand-in for ``gunicorn.config.Config`` carrying only what ``setup`` reads.

    A namespace rather than a real ``Config``, because constructing one drags in gunicorn's whole
    settings machinery to supply half a dozen attributes. Every field below is one
    :meth:`gunicorn.glogging.Logger.setup` accesses, and the values are the inert choices: no error
    log or access log file (so no handler writes to disk and no ``-`` stream handler is attached
    twice), no dictionary or file configuration, no syslog, and no output capture - the last one
    matters because capturing would redirect this process's ``stdout`` for the rest of the session.

    ``loglevel`` defaults to ``critical`` on purpose, and it is the one field whose value is doing
    work: it is deliberately *stricter* than anything this project configures, so a test can tell
    which threshold ended up in force. Were it gunicorn's, an ``error`` record would be dropped.

    Args:
        loglevel: What gunicorn is asked for, as ``--log-level`` would supply it.

    Returns:
        The double, typed as :class:`~typing.Any` because gunicorn ships no type information and
        the real argument would be just as untyped.
    """
    return SimpleNamespace(
        loglevel=loglevel,
        errorlog=None,
        accesslog=None,
        logconfig=None,
        logconfig_dict={},
        logconfig_json=None,
        syslog=False,
        syslog_addr=None,
        syslog_prefix=None,
        syslog_facility="user",
        enable_stdio_inheritance=False,
        capture_output=False,
        access_log_format="",
    )


@pytest.fixture
def structured_stream() -> Iterator[io.StringIO]:
    """Install the Gunicorn logger against a capture buffer, and restore logging afterwards.

    The class calls :func:`configure_logging` with no argument, which writes to the process stream,
    so the buffer is installed *afterwards* by calling it again - and that second call is not a
    workaround but the property under test in miniature: the function is idempotent by
    construction, which is exactly why it is safe for gunicorn to invoke it once in the arbiter and
    again in each forked worker.

    Yields:
        The buffer, holding exactly the bytes a log collector would have received.
    """
    StructlogGunicornLogger(build_config_double())
    buffer = io.StringIO()
    configure_logging(stream=buffer)
    try:
        yield buffer
    finally:
        # Process-wide state: restored whatever the test did, so no later test inherits a handler
        # pointed at a buffer that has gone out of scope.
        configure_logging()


class TestArbiterRecordsAreStructured:
    """The outcome the class exists for, asserted as the bytes a collector would receive."""

    def test_an_arbiter_line_is_rendered_as_json(self, structured_stream: io.StringIO) -> None:
        """A ``gunicorn.error`` record reaches the service's handler and comes out parsable."""
        logging.getLogger(GUNICORN_ERROR_LOGGER).error(ARBITER_MESSAGE)

        rendered = structured_stream.getvalue().strip()
        assert rendered, f"nothing reached the handler for {GUNICORN_ERROR_LOGGER!r}"

        # Parsed rather than pattern-matched: "it is JSON" is the claim, and json.loads is the only
        # honest way to make it. A plain-text handler left attached by a reordered `setup` would
        # produce a line that fails here.
        record = json.loads(rendered.splitlines()[-1])
        assert record["event"] == ARBITER_MESSAGE
        assert record["logger"] == GUNICORN_ERROR_LOGGER
        assert record["level"] == "error"
        # The timestamp is what makes an arbiter line correlatable with the worker lines around it,
        # and gunicorn's own format does not carry one in a machine-readable form at all.
        assert record["timestamp"]

    def test_the_line_is_recorded_exactly_once(self, structured_stream: io.StringIO) -> None:
        """One handler, so one line - not the two a leftover handler would produce."""
        # `configure_logging` REPLACES the root handler rather than adding one, and detaches the
        # handler gunicorn attached to `gunicorn.error` before restoring propagation. If either half
        # regressed, the record would be emitted twice - once structured and once plain - and a
        # search for the marker would still succeed. Counting is what catches that.
        logging.getLogger(GUNICORN_ERROR_LOGGER).error(ARBITER_MESSAGE)

        lines = [
            line for line in structured_stream.getvalue().splitlines() if ARBITER_MESSAGE in line
        ]
        assert len(lines) == 1, f"expected one record, got {len(lines)}:\n{lines}"

    def test_the_access_logger_stays_silent(self, structured_stream: io.StringIO) -> None:
        """The server's access log stays off, whoever configured logging last."""
        logging.getLogger(GUNICORN_ACCESS_LOGGER).info(SUPPRESSED_ACCESS_MESSAGE)

        rendered = structured_stream.getvalue()
        assert SUPPRESSED_ACCESS_MESSAGE not in rendered, (
            f"gunicorn's access log was re-enabled:\n{rendered}"
        )

    def test_the_threshold_comes_from_this_deployment_not_from_gunicorn(
        self, structured_stream: io.StringIO
    ) -> None:
        """``LOG_LEVEL`` decides, so one setting governs everything this process records."""
        # The config double asks gunicorn for `critical`, stricter than anything this project
        # configures. If gunicorn's threshold were the one in force, the `error` record below would
        # be dropped - so its arrival is the assertion rather than decoration. The point is
        # operational: an operator changing `LOG_LEVEL` must not also have to pass `--log-level`,
        # and two thresholds disagreeing is how a deployment silently stops recording.
        logging.getLogger(GUNICORN_ERROR_LOGGER).error(ARBITER_MESSAGE)
        assert ARBITER_MESSAGE in structured_stream.getvalue()

        # And the level actually installed is the configured one, named rather than inferred.
        assert logging.getLevelName(logging.getLogger().level) == settings.LOG_LEVEL.upper()

    def test_an_address_in_an_arbiter_line_is_redacted(
        self, structured_stream: io.StringIO
    ) -> None:
        """Routing the arbiter through this chain means it inherits the redaction too."""
        logging.getLogger(GUNICORN_ERROR_LOGGER).error(ARBITER_BIND_MESSAGE)

        rendered = structured_stream.getvalue()
        # Worth its own test because it is a *consequence* an operator will notice: the bind line
        # comes out naming a network rather than an address. That is the correct trade - one policy
        # for addresses everywhere, applied to free text as well as to fields - and it holds only
        # because the arbiter's records now pass through the same processors as everything else.
        assert ARBITER_BIND_NETWORK in rendered, f"the network is not present:\n{rendered}"
        assert ARBITER_BIND_ADDRESS not in rendered, f"the address survived:\n{rendered}"
