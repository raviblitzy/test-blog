"""Marker test for the log-redaction guarantee: a secret must not survive into a record.

Every assertion here is written the same way, and the shape is deliberate. A distinctive
**marker** is planted in a value - ``s3cr3t-marker-value``, ``marker@example.test``,
``MARKER_DSN_PASSWORD`` - the value is put through the real logging chain, and the rendered
output is then searched for that marker. A pattern that silently stopped matching, a chain a
future edit reordered, or a renderer that bypassed the processor would all leave the marker in
the output and fail the test. Asserting on the presence of
:data:`~app.core.logging.LOG_REDACTION_PLACEHOLDER` as well is what distinguishes "the value was
withheld" from "the field was never populated", so a rule that dropped a field instead of
rewriting it would fail too.

Two properties are exercised that no single-environment test can establish:

1. **Both chains.** ``ENVIRONMENT=development`` renders through ``ConsoleRenderer`` after
   ``format_exc_info``, and every other stage renders through ``JSONRenderer`` after
   ``ExceptionRenderer``. The two produce entirely different representations of one exception -
   a formatted string and a list of frame dictionaries - and the redaction processor has to
   cover both. It is parametrised over the stages rather than asserted once, because a
   developer's terminal is scraped into a scrollback buffer, a CI transcript and a pasted bug
   report, so a secret that leaks only there has still leaked.
2. **Through an exception, not just a field.** A message composed by whatever raised it is the
   value most likely to quote a connection URL or an address, and it is the one a caller cannot
   audit. Both an exception message and an exception *note* are exercised.

The suite writes to a capture buffer rather than to the process stdout, so it asserts on exactly
the bytes a log collector would have received. ``configure_logging`` is called with the real
settings object, with both the stage and the threshold pinned for the duration of a test and
restored afterwards, so nothing here depends on how the environment happens to be configured
while the suite runs - including the quiet ``LOG_LEVEL`` that ``backend/tests/conftest.py``
sets to keep a failing assertion legible.
"""

from __future__ import annotations

import io
import json
from collections.abc import Iterator
from typing import Any, Final

import pytest

from app.core.config import settings
from app.core.logging import (
    LOG_REDACTION_PLACEHOLDER,
    configure_logging,
    get_logger,
    redact_sensitive_text,
)

# Every stage the service can be configured as. `development` selects the console chain and the
# other three select the JSON chain, so parametrising over all four covers both terminal
# renderers without naming either.
_STAGES: Final[tuple[str, ...]] = ("development", "test", "staging", "production")

# Markers. Each is a string that could not plausibly appear in a log for any other reason, so a
# substring search for it is an exact test of whether the value survived.
_MARKER_PASSWORD: Final[str] = "s3cr3t-marker-value"
_MARKER_EMAIL: Final[str] = "marker@example.test"
_MARKER_DSN: Final[str] = (
    "postgresql+psycopg://marker_user:MARKER_DSN_PASSWORD@db.marker.test:5432/blog"
)
_MARKER_JWT: Final[str] = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJzdWIiOiJtYXJrZXIiLCJyb2xlIjoiQURNSU4ifQ."
    "MARKERsignatureMARKERsignature"
)
_MARKER_BEARER_TOKEN: Final[str] = "MARKERopaqueRefreshTokenValue123"
_MARKER_DETAIL_VALUE: Final[str] = "marker-conflicting-slug"


@pytest.fixture
def captured_logs() -> Iterator[Any]:
    """Configure logging into a buffer and restore the process configuration afterwards.

    Yields a callable taking the stage name and returning the buffer, so a test can reconfigure
    per stage without repeating the save/restore dance. The stage is set on the shared settings
    singleton - which the model is deliberately not ``frozen`` to allow - and put back in a
    ``finally``, so a failing assertion cannot leave the suite logging as ``production``.

    The **threshold** is pinned as well as the stage, and for the same reason: this module
    asserts on what redaction does to a record, not on which records clear a level, so a record
    it emits has to reach the buffer whatever the ambient ``LOG_LEVEL`` happens to be.
    ``backend/tests/conftest.py`` deliberately runs the suite at ``WARNING`` to keep a failing
    assertion legible, and without this pin the one test that logs at ``info`` would find an
    empty buffer and fail with an ``IndexError`` that says nothing about redaction. ``DEBUG`` is
    the most permissive setting, so every level a test might use is admitted, and it is restored
    in the same ``finally`` as the stage.
    """
    original_stage = settings.ENVIRONMENT
    original_level = settings.LOG_LEVEL
    buffers: list[io.StringIO] = []

    def configure(stage: str) -> io.StringIO:
        settings.ENVIRONMENT = stage  # type: ignore[assignment]
        # No `type: ignore` here, unlike the line above: `ENVIRONMENT` is assigned a plain `str`
        # against a `Literal` annotation, whereas `"DEBUG"` is one of the members
        # `Settings.LOG_LEVEL` declares, so the assignment type-checks as written and an ignore
        # would be flagged as unused under the strict settings in backend/pyproject.toml.
        settings.LOG_LEVEL = "DEBUG"
        buffer = io.StringIO()
        buffers.append(buffer)
        configure_logging(stream=buffer)
        return buffer

    try:
        yield configure
    finally:
        settings.ENVIRONMENT = original_stage
        settings.LOG_LEVEL = original_level
        configure_logging()


def _assert_withheld(rendered: str, marker: str) -> None:
    """Assert *marker* is absent from *rendered* and that a redaction marker took its place."""
    assert marker not in rendered, f"{marker!r} reached the log output:\n{rendered}"
    assert LOG_REDACTION_PLACEHOLDER in rendered, (
        f"nothing was marked as withheld, so the value may simply have been dropped:\n{rendered}"
    )


class TestRedactSensitiveText:
    """The function on its own, independent of any chain."""

    def test_strips_userinfo_from_a_connection_url(self) -> None:
        redacted = redact_sensitive_text(f"could not connect to {_MARKER_DSN}")
        assert "MARKER_DSN_PASSWORD" not in redacted
        assert "marker_user" not in redacted
        # The scheme and host survive, because a reader still needs to know WHICH database.
        assert "postgresql+psycopg://" in redacted
        assert "db.marker.test:5432/blog" in redacted

    def test_strips_a_json_web_token(self) -> None:
        redacted = redact_sensitive_text(f"token rejected: {_MARKER_JWT}")
        assert "MARKERsignature" not in redacted
        assert LOG_REDACTION_PLACEHOLDER in redacted

    def test_strips_a_bearer_credential_but_keeps_the_scheme(self) -> None:
        redacted = redact_sensitive_text(f"Authorization: Bearer {_MARKER_BEARER_TOKEN}")
        assert _MARKER_BEARER_TOKEN not in redacted
        assert "Bearer" in redacted

    def test_strips_a_named_secret_but_keeps_the_name(self) -> None:
        for phrase in (
            f"password={_MARKER_PASSWORD}",
            f"JWT_SECRET_KEY: {_MARKER_PASSWORD}",
            f'api_key="{_MARKER_PASSWORD}"',
            f"refresh_token={_MARKER_PASSWORD}",
        ):
            redacted = redact_sensitive_text(phrase)
            assert _MARKER_PASSWORD not in redacted, phrase
            assert LOG_REDACTION_PLACEHOLDER in redacted, phrase

    def test_strips_an_email_address(self) -> None:
        redacted = redact_sensitive_text(f"account {_MARKER_EMAIL} already exists")
        assert _MARKER_EMAIL not in redacted
        assert "already exists" in redacted

    def test_strips_a_postgresql_diagnostic_tail(self) -> None:
        message = (
            'duplicate key value violates unique constraint "uq_posts_slug"\n'
            f"DETAIL:  Key (slug)=({_MARKER_DETAIL_VALUE}) already exists.\n"
        )
        redacted = redact_sensitive_text(message)
        assert _MARKER_DETAIL_VALUE not in redacted
        # The label survives, so the reader knows a diagnostic was withheld rather than missing.
        assert "DETAIL:" in redacted
        assert "uq_posts_slug" in redacted

    def test_is_idempotent(self) -> None:
        once = redact_sensitive_text(f"password={_MARKER_PASSWORD} for {_MARKER_EMAIL}")
        assert redact_sensitive_text(once) == once

    def test_leaves_an_ordinary_record_alone(self) -> None:
        ordinary = "post published slug=scaling-fastapi status_code=200 duration_ms=12.5"
        assert redact_sensitive_text(ordinary) == ordinary


class TestRedactionThroughTheConfiguredChain:
    """The processor in place, in every environment the service can run as."""

    @pytest.mark.parametrize("stage", _STAGES)
    def test_a_secret_in_a_field_never_reaches_the_output(
        self, captured_logs: Any, stage: str
    ) -> None:
        buffer = captured_logs(stage)
        get_logger(__name__).error(
            "marker_event",
            detail=f"password={_MARKER_PASSWORD}",
            account=_MARKER_EMAIL,
            dsn=_MARKER_DSN,
        )
        rendered = buffer.getvalue()
        assert "marker_event" in rendered, rendered
        for marker in (_MARKER_PASSWORD, _MARKER_EMAIL, "MARKER_DSN_PASSWORD"):
            _assert_withheld(rendered, marker)

    @pytest.mark.parametrize("stage", _STAGES)
    def test_a_secret_in_the_event_message_never_reaches_the_output(
        self, captured_logs: Any, stage: str
    ) -> None:
        buffer = captured_logs(stage)
        get_logger(__name__).warning(f"connection to {_MARKER_DSN} refused")
        _assert_withheld(buffer.getvalue(), "MARKER_DSN_PASSWORD")

    @pytest.mark.parametrize("stage", _STAGES)
    def test_a_secret_in_an_exception_message_never_reaches_the_output(
        self, captured_logs: Any, stage: str
    ) -> None:
        buffer = captured_logs(stage)
        try:
            raise RuntimeError(f"could not connect to {_MARKER_DSN} as {_MARKER_EMAIL}")
        except RuntimeError:
            get_logger(__name__).exception("marker_failure")
        rendered = buffer.getvalue()
        assert "marker_failure" in rendered, rendered
        for marker in ("MARKER_DSN_PASSWORD", _MARKER_EMAIL):
            _assert_withheld(rendered, marker)

    @pytest.mark.parametrize("stage", _STAGES)
    def test_a_secret_in_an_exception_note_never_reaches_the_output(
        self, captured_logs: Any, stage: str
    ) -> None:
        buffer = captured_logs(stage)
        try:
            error = ValueError("rejected")
            error.add_note(f"supplied password={_MARKER_PASSWORD}")
            raise error
        except ValueError:
            get_logger(__name__).exception("marker_noted_failure")
        _assert_withheld(buffer.getvalue(), _MARKER_PASSWORD)

    def test_the_json_chain_still_emits_parsable_records(self, captured_logs: Any) -> None:
        """Redaction must not corrupt the structure a collector parses."""
        buffer = captured_logs("production")
        get_logger(__name__).error("marker_event", account=_MARKER_EMAIL)
        lines = [line for line in buffer.getvalue().splitlines() if line.strip()]
        assert lines, "nothing was written"
        record = json.loads(lines[-1])
        assert record["event"] == "marker_event"
        assert record["account"] == LOG_REDACTION_PLACEHOLDER
        assert record["level"] == "error"

    def test_an_ordinary_record_is_unchanged_in_every_field(self, captured_logs: Any) -> None:
        """The backstop must not rewrite a value that carries nothing sensitive."""
        buffer = captured_logs("production")
        get_logger(__name__).info(
            "post published", slug="scaling-fastapi", status_code=200, duration_ms=12.5
        )
        record = json.loads([ln for ln in buffer.getvalue().splitlines() if ln.strip()][-1])
        assert record["slug"] == "scaling-fastapi"
        assert record["status_code"] == 200
        assert record["duration_ms"] == 12.5
        assert LOG_REDACTION_PLACEHOLDER not in json.dumps(record)
