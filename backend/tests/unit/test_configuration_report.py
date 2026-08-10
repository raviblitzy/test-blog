"""Unit suite for the two things a running deployment can be asked about its own configuration.

``app.core.config`` validates values, and that part of it is exercised by every process that
starts. These two surfaces are different: they exist for the operator rather than for the
application, and they close a gap validation structurally cannot reach.

The gap, stated exactly
-----------------------
An *invalid* value stops the process with a message naming the field. A *misspelt key in an env
file* is refused outright, because ``Settings`` is declared ``extra="forbid"``. A misspelt key
supplied as a **real environment variable** is neither, and that is the only configuration channel
a container has: ``pydantic-settings`` reads only the names the model declares out of the
environment, so ``AUTH_RATE_LIMITT=1/minute`` is not an extra input to reject - it is a name nothing
reads. The field keeps its default, the service starts healthy, and before these two surfaces
existed nothing in the log said otherwise. The variables it can happen to are the optional ones,
which is where the authentication rate limit, the access-token lifetime and the request body ceiling
live.

So there are two answers, and this module asserts both:

* :meth:`~app.core.config.Settings.effective_configuration` reports every non-secret value actually
  in force, so a default nobody chose is one line away from being visible.
* :func:`~app.core.config.suspicious_environment_keys` names environment keys that look like a
  failed attempt at one of ours.

What is asserted, and why in a unit module
------------------------------------------
Both are pure functions of a settings object and a mapping, so nothing here needs a database, a
client or a live environment - and the second one is *given* its environment rather than reading
the process's, which is the only way to assert what it does with a realistic deployment's variable
set rather than with whatever the machine running the suite exports.

Two of the assertions are structural rather than behavioural, and they are the ones that keep
working as the model grows: the reported set and the withheld set must **partition** the model
exactly, so a field added later cannot be quietly omitted from the report or quietly added to it,
and no withheld field's *value* may appear anywhere in the report. A secret that leaks into a
startup record is not a formatting mistake - the log is retained, indexed and searched.

Governing standards
-------------------
``review_rules`` reports no user rules for this project; this module is in scope because AAP §0.9.1
places ``backend/tests/**/*.py`` there. Two self-imposed standards from AAP §0.10.1 shape it:
*configuration from the environment only* (#12), which is what makes "which values are in force?" a
question worth being able to answer, and *no secrets in the repository* (#13), whose logging
counterpart is asserted here.
"""

from __future__ import annotations

import io
import json
import sys
from collections.abc import Iterator
from typing import Final

import pytest

from app.core.config import (
    _FRONTEND_ENV_KEYS,
    _SUSPICIOUS_ENV_KEY_LIMIT,
    _WITHHELD_FROM_STARTUP_RECORD,
    Settings,
    settings,
    suspicious_environment_keys,
)
from app.core.logging import configure_logging
from app.main import create_app, lifespan

pytestmark = pytest.mark.unit


HOST_ENVIRONMENT: Final[dict[str, str]] = {
    # A container's and a developer machine's ordinary furniture.
    "PATH": "/usr/local/bin:/usr/bin",
    "HOME": "/home/blog",
    "HOSTNAME": "e6f1a2b3c4d5",
    "LANG": "C.UTF-8",
    "PWD": "/srv/backend",
    "TERM": "xterm",
    "VIRTUAL_ENV": "/opt/venv",
    "PYTHONUNBUFFERED": "1",
    "PYTHONDONTWRITEBYTECODE": "1",
    "PYTHONWARNINGS": "always",
    "GUNICORN_CMD_ARGS": "--workers 4",
    "CI": "true",
    "CLONE_INDEX": "024",
    # Names that legitimately sit NEAR ours, and are the reason the similarity threshold is 0.85
    # rather than 0.80. Every one of these is a real convention: a suite's own database, a read
    # replica, the postgres image's own variables, a second seeded field, a fourth client key.
    "TEST_DATABASE_URL": "postgresql+psycopg://blog:blog@localhost:5432/blog_test",
    "DATABASE_URL_REPLICA": "postgresql+psycopg://blog:blog@replica:5432/blog",
    "POSTGRES_USER": "blog",
    "POSTGRES_PASSWORD": "blog",
    "POSTGRES_DB": "blog",
    "SEED_ADMIN_NAME": "Blog Administrator",
    "NEXT_PUBLIC_SITE_DESCRIPTION": "A modern blog",
}
"""An environment shaped like a real deployment's, and none of it is a misspelling of a setting.

Deliberately adversarial in the direction that matters. A detector that reported any of these would
be worse than none: an operator who is warned about ``TEST_DATABASE_URL`` on every boot stops
reading the warning, and the one boot where it names a genuine typo is the one they skip.
"""

QA_MISSPELLINGS: Final[dict[str, str]] = {
    "LOG_LEVLE": "LOG_LEVEL",
    "ACCESS_TOKEN_EXPIRE_MINUTS": "ACCESS_TOKEN_EXPIRE_MINUTES",
    "MAX_REQUEST_BODY_BYTE": "MAX_REQUEST_BODY_BYTES",
    "AUTH_RATE_LIMITT": "AUTH_RATE_LIMIT",
}
"""The four misspellings observed silently ignored in the packaged runtime, and what each meant.

Every one is an *optional* variable, which is exactly why they were invisible: a misspelt REQUIRED
variable makes the real name absent and stops the process, so the failure mode only exists where a
default is waiting to take over. Three of these four - the rate limit, the token lifetime and the
body ceiling - are security-relevant defaults.
"""


class TestEffectiveConfigurationIsComplete:
    """The report and the withheld set must account for every field, with nothing left undecided."""

    def test_every_declared_field_is_either_reported_or_deliberately_withheld(self) -> None:
        """The two sets partition the model, asserted in both directions.

        This is the assertion that keeps working as the model grows, and it is the reason the
        report is derived from ``model_fields`` rather than hand-listed. A field added later is
        either reported - and an operator sees it - or named in the withheld set by somebody who
        decided it must not be. What cannot happen is the third outcome: a new setting that is
        neither reported nor deliberately excluded, which is how a value silently stops being
        visible again.
        """
        declared = set(Settings.model_fields)
        reported = {key.upper() for key in settings.effective_configuration()}

        assert reported | _WITHHELD_FROM_STARTUP_RECORD == declared, (
            "these settings are neither reported on the startup record nor deliberately withheld: "
            f"{sorted(declared - (reported | _WITHHELD_FROM_STARTUP_RECORD))}"
        )
        assert reported & _WITHHELD_FROM_STARTUP_RECORD == set(), (
            f"{sorted(reported & _WITHHELD_FROM_STARTUP_RECORD)} are both reported and withheld"
        )
        assert declared >= _WITHHELD_FROM_STARTUP_RECORD, (
            f"{sorted(_WITHHELD_FROM_STARTUP_RECORD - declared)} are withheld but not declared, so "
            "the exclusion is stale and hides nothing"
        )

    def test_the_report_names_the_settings_a_silent_default_would_have_hidden(self) -> None:
        """The specific keys the finding was about, asserted by name.

        The partition test above would still pass if the report were empty and every field were
        withheld, so the four values whose silent default was the actual defect are pinned here.
        """
        report = settings.effective_configuration()

        for key in ("log_level", "auth_rate_limit", "access_token_expire_minutes"):
            assert key in report, f"{key} is not on the startup record"
        assert report["max_request_body_bytes"] == settings.MAX_REQUEST_BODY_BYTES
        assert report["log_level"] == settings.LOG_LEVEL
        assert report["auth_rate_limit"] == settings.AUTH_RATE_LIMIT

    def test_every_reported_value_is_a_flat_scalar(self) -> None:
        """A nested value is a field an operator cannot grep for.

        ``CORS_ALLOW_ORIGINS`` is the only list among the settings, and it is joined rather than
        nested: a collector that flattens arrays renders ``cors_allow_origins.0``, so a search for
        an origin finds nothing. Asserted for every value rather than that one, so a future
        collection-typed setting is caught.
        """
        report = settings.effective_configuration()

        for key, value in report.items():
            assert isinstance(value, str | int | bool), f"{key} is {type(value).__name__}, not flat"
        assert report["cors_allow_origins"] == ",".join(settings.CORS_ALLOW_ORIGINS)


class TestEffectiveConfigurationWithholdsSecrets:
    """No secret, no credential and no identity may reach a retained, indexed, searchable log."""

    def test_no_withheld_value_appears_anywhere_in_the_report(self) -> None:
        """Asserted on the VALUES, not on the keys, which is the assertion that actually protects.

        Checking that ``jwt_secret_key`` is not a key would pass for a report that put the same
        string under ``signing_key``. Serialising the whole report and searching it for each
        withheld value is what catches that - and it is how a log collector would see the record
        anyway.
        """
        rendered = json.dumps(settings.effective_configuration(), default=str)

        for name in _WITHHELD_FROM_STARTUP_RECORD:
            value = str(getattr(settings, name))
            assert value not in rendered, (
                f"the value of {name} reached the startup record: {rendered}"
            )
            assert name.lower() not in rendered, f"{name} is named on the startup record"

    def test_the_database_password_is_not_recoverable_from_the_report(self) -> None:
        """The DSN is withheld whole, and this states why in the form the hazard takes.

        ``DATABASE_URL`` carries the password in its userinfo, so there is no partial redaction of
        it worth attempting on a startup record: the host is the only interesting half, and it is
        already visible to anybody who can read ``/readyz``.
        """
        rendered = json.dumps(settings.effective_configuration(), default=str)

        assert "postgresql" not in rendered
        assert "@" not in rendered


class TestSuspiciousEnvironmentKeys:
    """The heuristic half: a name that looks like a failed attempt at a setting."""

    def test_the_misspellings_that_were_silently_ignored_are_named(self) -> None:
        """Each of the four, and the setting each was reaching for.

        The mapping's *value* is asserted as well as its key, because the report is only actionable
        if it says what the operator meant: ``MAX_REQUEST_BODY_BYTE`` is a typo for exactly one
        thing, and a warning that named it without naming ``MAX_REQUEST_BODY_BYTES`` leaves them to
        guess.
        """
        reported = suspicious_environment_keys(
            {**HOST_ENVIRONMENT, **dict.fromkeys(QA_MISSPELLINGS, "value")}
        )

        for key, intended in QA_MISSPELLINGS.items():
            assert reported.get(key) == intended, (
                f"{key} was not reported as a misspelling of {intended}: {reported}"
            )

    def test_a_realistic_environment_produces_no_report(self) -> None:
        """The false-positive assertion, and the one that decides whether anyone reads the warning.

        Every name in :data:`HOST_ENVIRONMENT` is a real convention - a suite's own database URL, a
        read replica, the postgres image's variables, an extra seeded field, a fourth client key -
        and none of them is a failed attempt at a setting this service reads.
        """
        assert suspicious_environment_keys(HOST_ENVIRONMENT) == {}

    def test_nothing_the_service_recognises_is_ever_reported(self) -> None:
        """A declared name and a tolerated client-tier name are correct, not suspicious."""
        recognised = dict.fromkeys(set(Settings.model_fields) | set(_FRONTEND_ENV_KEYS), "value")

        assert suspicious_environment_keys(recognised) == {}

    def test_a_name_missing_a_whole_trailing_segment_is_reported(self) -> None:
        """``JWT_SECRET`` for ``JWT_SECRET_KEY``: the abbreviation, not the typo.

        Similarity alone scores that pair at 0.83 and would miss it, which is why the detector
        carries a second, structural rule. The reverse direction must NOT be reported, and
        ``DATABASE_URL_REPLICA`` in the clean environment above is what asserts that: extending a
        setting's name is a deployment convention, while truncating one is a mistake.
        """
        reported = suspicious_environment_keys({"JWT_SECRET": "x", "SEED_ADMIN": "y"})

        assert reported["JWT_SECRET"] == "JWT_SECRET_KEY"
        assert reported["SEED_ADMIN"] in {"SEED_ADMIN_EMAIL", "SEED_ADMIN_PASSWORD"}

    def test_a_correctly_spelled_name_in_the_wrong_case_is_reported(self) -> None:
        """``case_sensitive=True`` means a lower-cased key is read by nothing.

        The most invisible member of the family: the name is *right*, so an operator comparing their
        env file against ``.env.example`` by eye finds nothing wrong.
        """
        reported = suspicious_environment_keys({"database_url": "x", "Log_Level": "y"})

        assert reported["database_url"] == "DATABASE_URL"
        assert reported["Log_Level"] == "LOG_LEVEL"

    def test_the_report_is_bounded(self) -> None:
        """An unbounded field built from environment keys is an unbounded log line.

        The bound is not a completeness compromise: an environment with more than ten near-misses is
        not a deployment with a typo, and the record carries the count beside the list so a
        truncated report still says how many there were.
        """
        flood = {f"LOG_LEVE{index}": "x" for index in range(_SUSPICIOUS_ENV_KEY_LIMIT * 3)}

        assert len(suspicious_environment_keys(flood)) == _SUSPICIOUS_ENV_KEY_LIMIT

    def test_the_process_environment_is_the_default(self) -> None:
        """Called with no argument it reads the real environment, which is how ``app.main`` uses it.

        Asserted because the default argument is the whole integration: a function that only ever
        inspected a mapping handed to it would be correct and never reach the environment the
        finding was about. The suite's own environment is clean, which is also the state a
        deployment is expected to be in.
        """
        assert suspicious_environment_keys() == {}


class TestTheStartupRecordCarriesBothSignals:
    """The two surfaces as ``app.main`` actually emits them: through the real lifespan.

    The classes above assert what each function returns. This one asserts that a *started
    application* writes them, which is the only form an operator ever sees - and it is the half a
    unit test of the functions cannot reach, because the decision to log, the record's event name
    and its field names all live in the lifespan rather than in ``app.core.config``.

    Running the real lifespan is safe here and is not a liberty: it performs no I/O by design
    (``app.main`` documents that, and it is what lets the suite drive the application over an ASGI
    transport with no live server), and the pool it disposes on the way out is
    ``app.db.session.engine`` - which ``backend/tests/conftest.py`` deliberately never checks a
    connection out of.
    """

    @pytest.fixture
    def restored_logging(self) -> Iterator[None]:
        """Put the process's logging configuration back after a test redirected it.

        :meth:`_records` points the service's log at a buffer, which replaces the root handler
        for the remainder of the session if nothing undoes it. Calling ``configure_logging()``
        with no argument in the teardown rebinds the handler to the real stream whether the test
        passed, failed or was interrupted.

        Yields:
            ``None``. The fixture exists for its teardown.
        """
        try:
            yield
        finally:
            configure_logging()

    async def _records(self) -> list[dict[str, object]]:
        """Run one full application lifecycle and return the structured records it wrote.

        The stream is redirected **here**, inside the test's call phase, rather than in a fixture,
        and that is a real constraint rather than a preference: pytest's global capture re-assigns
        ``sys.stdout`` at the start of every phase, so a redirect installed during setup is
        discarded before the test body runs and the records go to the terminal instead of the
        buffer. ``configure_logging`` resolves ``sys.stdout`` per call - deliberately, as its own
        comment records - so redirecting it around the lifespan captures the records while leaving
        the logging chain exactly as a deployment configures it.

        Returns:
            Every parsable record, in order. Non-JSON lines are excluded rather than tolerated:
            the suite runs as ``ENVIRONMENT=test``, which selects the JSON renderer, so anything
            unparsable would itself be a defect and is asserted against elsewhere.
        """
        buffer = io.StringIO()
        original = sys.stdout
        sys.stdout = buffer
        try:
            async with lifespan(create_app()):
                pass
        finally:
            sys.stdout = original
        return [
            json.loads(line)
            for line in buffer.getvalue().splitlines()
            if line.strip().startswith("{")
        ]

    async def test_the_startup_record_reports_the_configuration_in_force(
        self, restored_logging: None
    ) -> None:
        """One line an operator can read the whole non-secret configuration off.

        The four fields asserted by name are the ones whose *silent default* was the defect: a
        misspelt ``LOG_LEVLE``, ``AUTH_RATE_LIMITT``, ``ACCESS_TOKEN_EXPIRE_MINUTS`` or
        ``MAX_REQUEST_BODY_BYTE`` leaves each of these showing a value nobody chose, and now it
        shows it *visibly*.
        """
        records = await self._records()

        startup = [record for record in records if record.get("event") == "application startup"]
        assert len(startup) == 1, f"expected one startup record, got {len(startup)}"

        record = startup[0]
        assert record["level"] == "info"
        for field in (
            "log_level",
            "auth_rate_limit",
            "access_token_expire_minutes",
            "max_request_body_bytes",
            "environment",
        ):
            assert record[field] == getattr(settings, field.upper())
        # The fields that were already there stay there: this record gained information, it did not
        # replace it.
        assert record["api_prefix"]
        assert record["version"]

    async def test_the_startup_record_carries_no_secret(self, restored_logging: None) -> None:
        """The record is retained, indexed and searched: asserted on the bytes it emits."""
        records = await self._records()

        rendered = json.dumps(
            [r for r in records if r.get("event") == "application startup"], default=str
        )
        for name in _WITHHELD_FROM_STARTUP_RECORD:
            assert str(getattr(settings, name)) not in rendered, f"{name} reached the log"

    async def test_a_clean_environment_writes_no_warning(self, restored_logging: None) -> None:
        """A healthy deployment's WARNING level stays empty, which is what makes it worth reading.

        The counterpart to the test below, and the more important of the two: a signal that fires
        on every boot is not a signal.
        """
        records = await self._records()

        assert [r for r in records if r.get("level") == "warning"] == []

    async def test_a_misspelt_variable_is_named_at_warning(
        self, restored_logging: None, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The signal itself: one bounded record, naming the key and the setting it resembles.

        Set through the real environment rather than by substituting the detector, because the
        thing that was broken is precisely that a real environment variable reaches nothing: the
        assertion is worth having only if it travels the same path a ``docker run --env-file``
        value does.
        """
        monkeypatch.setenv("AUTH_RATE_LIMITT", "1/minute")

        records = await self._records()

        warnings_written = [r for r in records if r.get("level") == "warning"]
        assert len(warnings_written) == 1, f"expected one warning, got {warnings_written}"

        record = warnings_written[0]
        assert record["event"] == "unrecognised environment variables"
        assert record["count"] == 1
        assert record["unrecognised"] == "AUTH_RATE_LIMITT~AUTH_RATE_LIMIT"
