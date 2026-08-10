"""The suite cannot be pointed at a database it is not allowed to destroy.

``backend/tests/conftest.py`` creates a database if it is absent, migrates it to head, lets every
test write to it, and drops it when ``TEST_DATABASE_DROP`` is set. All four of those are correct
against a dedicated test database and catastrophic against a working one, and the only thing
standing between the two is the name in a URL.

That name used to be trusted. ``TEST_DATABASE_URL`` was honoured verbatim and the ``test`` marker
was checked in one place only - the teardown that drops - so a single mistyped character was enough
to have ``CREATE DATABASE`` skipped as already-existing, the whole migration chain applied over a
real schema, and every test in the suite write to it. The one guard that would have objected sat
after all of that and, by default, never runs at all.

This module pins the corrected behaviour. Two properties, and they fail independently:

* **The target is refused before anything can act on it.** :func:`_require_test_database` gates the
  single resolution the engine, the maintenance URL, the migration run and the drop are all derived
  from, and it runs at import - so a refused URL never becomes ``DATABASE_URL`` and there is no
  window in which a non-test target is the configured one.
* **A database name reaches DDL as a quoted identifier.** ``CREATE DATABASE`` and ``DROP
  DATABASE`` cannot take a bind parameter, so quoting is the only protection there is, and
  wrapping an interpolated name in literal double quotes is not quoting - a name containing one
  closes the pair and everything after it is statement text.

Reaching the helpers under test
-------------------------------
The private helpers are read off the *already imported* conftest module rather than imported by
path. ``from tests.conftest import ...`` would execute a second copy of a module whose top level
rewrites ``os.environ``, reorders ``sys.path`` and assigns ``DATABASE_URL`` - so the import itself
would be the most dangerous thing in this file. :func:`_conftest_module` finds the instance pytest
already loaded instead, located by ``__file__`` rather than by the name pytest happened to give it.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import ModuleType
from typing import Any, Final

import pytest

CONFTEST_PATH: Final[Path] = Path(__file__).resolve().parents[1] / "conftest.py"
"""``backend/tests/conftest.py`` - the module whose behaviour this file pins."""

_SAFE_URL: Final[str] = "postgresql+psycopg://blog:blog@127.0.0.1:5432/blog_test"
"""A URL naming a database the suite may act on. Never connected to: every test here is pure."""


def _conftest_module() -> ModuleType:
    """Return the already-imported root conftest module.

    Located by comparing ``__file__`` rather than by name, because the name depends on pytest's
    import mode and rootdir while the path does not.

    Returns:
        The single loaded instance of ``backend/tests/conftest.py``.
    """
    for module in list(sys.modules.values()):
        path = getattr(module, "__file__", None)
        if path and Path(path).resolve() == CONFTEST_PATH:
            return module
    message = f"the root conftest at {CONFTEST_PATH} is not in sys.modules"
    raise AssertionError(message)


class TestTestDatabasePreflight:
    """A target that is not marked as a test database is refused, and refused early."""

    def test_a_marked_database_is_accepted_and_returned_unchanged(self) -> None:
        """The gate is transparent on the happy path.

        Returning the URL rather than ``None`` is what lets it wrap the resolution at its one call
        site - ``os.environ["DATABASE_URL"] = _require_test_database(_resolve_test_database_url())``
        - instead of sitting beside it as a separate statement a future edit could reorder or drop.
        """
        require = _conftest_module()._require_test_database

        assert require(_SAFE_URL) == _SAFE_URL

    @pytest.mark.parametrize(
        "database",
        ["blog", "postgres", "production", "blog_prod", "template1"],
        ids=["working-db", "maintenance-db", "named-production", "prod-suffix", "pg-template"],
    )
    def test_an_unmarked_database_is_refused(self, database: str) -> None:
        """Every one of these would have been migrated and written to before the fix.

        ``postgres`` and ``template1`` are in the list deliberately: they are the two the
        maintenance connection itself uses, so a copy-paste of the maintenance URL into
        ``TEST_DATABASE_URL`` is exactly the mistake that is easiest to make and worst to make.
        """
        require = _conftest_module()._require_test_database
        url = f"postgresql+psycopg://blog:blog@127.0.0.1:5432/{database}"

        with pytest.raises(RuntimeError) as raised:
            require(url)

        assert database in str(raised.value)

    def test_the_refusal_says_which_variable_to_change(self) -> None:
        """A guard that refuses without saying what to do gets worked around rather than obeyed.

        The message has to name the variable, because the person reading it has just had a suite
        refuse to start and the fix is one environment variable away.
        """
        conftest = _conftest_module()

        with pytest.raises(RuntimeError) as raised:
            conftest._require_test_database("postgresql+psycopg://blog:blog@127.0.0.1:5432/blog")

        message = str(raised.value)
        assert conftest.TEST_DATABASE_URL_ENV_VAR in message
        assert conftest.TEST_DATABASE_SUFFIX in message

    def test_a_url_naming_no_database_is_refused(self) -> None:
        """An empty name cannot contain the marker, so the same guard covers it.

        Worth asserting rather than assuming: a URL with no database would otherwise reach
        ``CREATE DATABASE ""``, and the failure would arrive as a syntax error from PostgreSQL
        rather than as a sentence explaining what is misconfigured.
        """
        require = _conftest_module()._require_test_database

        with pytest.raises(RuntimeError):
            require("postgresql+psycopg://blog:blog@127.0.0.1:5432/")

    def test_the_marker_check_ignores_case(self) -> None:
        """``..._TEST`` is as much a test database as ``..._test``.

        The comparison is on ``casefold()``, so a name a developer typed in upper case is accepted
        rather than producing a refusal that looks like a bug in the guard.
        """
        require = _conftest_module()._require_test_database
        url = "postgresql+psycopg://blog:blog@127.0.0.1:5432/BLOG_TEST"

        assert require(url) == url

    def test_the_live_session_is_running_against_a_marked_database(self) -> None:
        """The gate is wired, not merely present.

        The end-to-end form of the property: whatever this session resolved, the database it is
        actually connected to satisfies the same rule the helper enforces. A guard defined and never
        applied would pass every test above and fail this one.
        """
        conftest = _conftest_module()
        database = conftest.make_url(conftest.settings.DATABASE_URL).database or ""

        assert conftest._TEST_DATABASE_MARKER in database.casefold()

    def test_the_resolution_is_wrapped_in_the_gate_at_its_only_assignment(self) -> None:
        """Ordering asserted structurally, because no runtime observation can express it.

        The property is that *nothing* can act on an unchecked target - and the way that is
        achieved is placement: the check wraps the resolution at module scope, so it has already
        run before any fixture exists to call. A check moved into ``database_schema`` would satisfy
        every behavioural test in this class and still be too late, because a module-level import
        in a unit test can open a connection first.
        """
        source = CONFTEST_PATH.read_text(encoding="utf-8")

        assert 'os.environ["DATABASE_URL"] = _require_test_database(' in source


class TestDdlIdentifierQuoting:
    """A database name is quoted by the dialect before it is interpolated into DDL."""

    def test_a_plain_name_is_always_quoted(self) -> None:
        """Always, rather than only when the name requires it.

        Uniform output is worth more here than minimal output: the emitted DDL has the same shape
        whatever the name looks like, and a mixed-case name - which the previous hand-written
        quotes also protected - keeps working.
        """
        quote = _conftest_module()._quote_identifier

        assert quote("blog_test") == '"blog_test"'

    def test_an_embedded_quote_is_doubled_rather_than_closing_the_identifier(self) -> None:
        """The case literal double quotes cannot survive.

        ``blog"; DROP DATABASE blog; --`` interpolated between hand-written quotes closes the
        identifier and leaves the rest as statement text. Doubling the embedded quote is
        PostgreSQL's own escaping rule and keeps the whole value one identifier - so the statement
        fails as a missing database rather than executing.
        """
        quote = _conftest_module()._quote_identifier

        quoted = quote('blog"; DROP DATABASE blog; --')

        assert quoted == '"blog""; DROP DATABASE blog; --"'
        assert quoted.count('"') % 2 == 0

    def test_the_ddl_statements_use_the_quoting_helper(self) -> None:
        """Both statements, asserted from the source.

        The helper existing is not the property; the two ``CREATE``/``DROP`` sites using it is. A
        third statement added later without it would reintroduce exactly the interpolation this
        replaced, so the check is written against the text that would contain it.
        """
        source = CONFTEST_PATH.read_text(encoding="utf-8")

        assert 'text(f"CREATE DATABASE {_quote_identifier(database)}")' in source
        assert 'text(f"DROP DATABASE IF EXISTS {_quote_identifier(database)} WITH (FORCE)")' in (
            source
        )
        assert 'CREATE DATABASE "{database}"' not in source
        assert 'DROP DATABASE IF EXISTS "{database}"' not in source


class TestMigrationLogLevelPin:
    """The migration run is quiet without the whole session being muted."""

    def test_the_upgrade_pins_and_restores_the_threshold(self) -> None:
        """Pinned on ``settings``, and restored, and the logging shape restored with it.

        ``migrations/env.py`` calls ``configure_logging(stream=sys.stderr)`` at its own module
        scope, and Alembic imports that module *inside* ``command.upgrade`` - so a level set on the
        ``alembic`` logger beforehand is reset before the first revision runs, while
        ``settings.LOG_LEVEL`` is read by that very call and therefore survives it. The restore
        matters as much as the pin: env.py leaves the root handler on stderr at the pinned level,
        and every test that follows expects the session's own configuration back.
        """
        source = CONFTEST_PATH.read_text(encoding="utf-8")
        upgrade = source[source.index("def _upgrade_to_head()") :]
        upgrade = upgrade[: upgrade.index("\ndef ")]

        assert "settings.LOG_LEVEL = _MIGRATION_LOG_LEVEL" in upgrade
        assert "settings.LOG_LEVEL = previous_level" in upgrade
        assert "configure_logging()" in upgrade
        assert "finally:" in upgrade

    def test_the_session_threshold_admits_a_record_a_test_asserts_on(self) -> None:
        """``INFO`` session-wide, so a module asserting on record content is not starved.

        ``tests/unit/test_security.py``'s redaction suite asserts that a secret does not survive
        into a record it emits at ``info``. At a session threshold of ``WARNING`` that record never
        reaches the buffer and the module fails with an ``IndexError`` about an empty list - a
        harness artefact that reads as a defect in redaction, and one that was previously worked
        around by editing that module instead of the harness.
        """
        conftest = _conftest_module()
        defaults: tuple[tuple[str, str], ...] = conftest._ENVIRONMENT_DEFAULTS
        configured: dict[str, Any] = dict(defaults)

        assert configured["LOG_LEVEL"] == "INFO"
