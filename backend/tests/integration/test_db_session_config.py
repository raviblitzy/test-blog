"""Integration suite for the engine's connection contract, asserted against a live PostgreSQL.

``app.db.session`` configures the engine every request in the service runs through, and three of
its settings are *promises about the worst case* rather than tuning preferences:

``statement_timeout``
    A ceiling on how long any single statement may run, applied by the **server**. Without it a
    statement that stalls - a lock it never gets, a plan that never finishes, a peer that stops
    reading - holds a pooled connection for as long as the socket survives. With a pool of five
    connections per worker, a handful of those is the whole worker unable to serve anything.

``timezone``
    Every instant this API stores and returns is UTC, and the session time zone is what makes a
    server-side ``now()`` agree with that. It predates the timeout and shares one ``options``
    string with it, which is exactly why it is asserted here: appending a second ``-c`` to that
    string is the kind of change that silently drops the first.

the TCP keepalive group
    What ends a connection whose peer has vanished without closing it. libpq rejects an
    unrecognised connection keyword outright, so a connection that opens at all is the proof that
    all four keywords were accepted - and this suite opens one.

Why these are asserted against a real server rather than against the constants
------------------------------------------------------------------------------
Reading ``safe_connect_args()`` back and comparing it to the constants it was built from proves
nothing: it is the same expression twice, and it would keep passing if libpq ignored the whole
``options`` string. So every assertion here goes through ``SHOW``, which reports what the
*server* believes about the session it is serving. That is the only formulation that can fail if
the option string is malformed, if a future edit breaks the escaping, or if a driver stops
forwarding it.

The engine under test is the application's own
----------------------------------------------
:data:`app.db.session.engine` itself, not a copy configured to look like it. During the suite
``backend/tests/conftest.py`` has already pointed ``DATABASE_URL`` at the dedicated ``*_test``
database, so the application engine connects there like everything else - which means these tests
exercise the exact object ``app.core.dependencies.get_db`` hands to every route.

It is deliberately *not* the ``engine`` fixture from ``conftest``. That one is built with
``poolclass=NullPool``, precisely so a session-scoped engine cannot carry a connection across
event loops; it opens with the same ``safe_connect_args()`` this module asserts on - which is the
point of that function existing - but it carries none of the pool configuration, so asserting
against it would assert the harness's configuration rather than the service's. The connection this
module opens is discarded and the engine disposed in the fixture teardown, so nothing is left
pooled for the rest of the session.

What is deliberately not asserted here
--------------------------------------
The *numbers* are not re-derived. ``app.db.session`` documents why the ceiling is ten seconds and
why the keepalive budget is what it is, and a test restating that arithmetic would break on every
deliberate change while catching nothing. What is asserted is that whatever the module declares is
what the server ends up applying - a relationship, not a value - plus the one relationship that is
not internal to the module: ``backend/tests/integration/test_health.py`` asserts the readiness
deadline sits below this ceiling, because a caller-side deadline above it would never be the bound
that fires.

Governing standards
-------------------
``review_rules`` reports that this project specifies **no user rules**, so none governs this file;
it is in scope because AAP §0.9.1 places ``backend/tests/**/*.py`` there. Two of the repository's
self-imposed standards decide its shape: *day-one observability* (§0.10.1 #11), whose premise is
that a stalled dependency must surface as a bounded failure rather than as an accumulating queue;
and *blocking quality gates* (#8), which is why nothing here is skipped, expected to fail, or
dependent on execution order.
"""

from __future__ import annotations

import ast
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Final

import pytest
from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.config import settings
from app.db.session import (
    SESSION_TIME_ZONE,
    STATEMENT_TIMEOUT_MILLISECONDS,
    STATEMENT_TIMEOUT_SECONDS,
    TCP_KEEPALIVE_ARGS,
    engine,
    migration_connect_args,
    safe_connect_args,
)

MIGRATIONS_ENV_PATH: Final[Path] = Path(__file__).resolve().parents[2] / "migrations" / "env.py"
"""The Alembic environment module, read as text so its engine wiring can be asserted.

Resolved from this file rather than from the working directory, because the suite is run from
``backend/`` and from the repository root alike and a relative path would pass in one and fail in
the other.
"""

STATEMENT_TIMEOUT_KEYWORD: Final[str] = "statement_timeout"
"""The libpq setting a migration connection must not carry."""

NO_STATEMENT_CEILING: Final[str] = "0"
"""How PostgreSQL reports ``statement_timeout`` when the session imposes none.

``SHOW statement_timeout`` renders the unset value as ``0`` rather than as an empty string or a
unit-suffixed zero, so this is the value a migration connection must report.
"""

SHOW_STATEMENT_TIMEOUT: Final[str] = "SHOW statement_timeout"
"""How the server is asked what ceiling it is applying to this session."""

SHOW_TIME_ZONE: Final[str] = "SHOW timezone"
"""How the server is asked which time zone it is interpreting this session in."""

SQLSTATE_QUERY_CANCELED: Final[str] = "57014"
"""PostgreSQL's ``query_canceled``: what a statement killed by a timeout reports.

The code ``app.api.v1.routers.health`` classifies as ``query_timeout``, which is why it is worth
proving here that a real overrun really does produce it - the two files together are what turn "a
stalled statement is bounded" into "a stalled statement is bounded *and* correctly reported".
"""

_PROBE_TIMEOUT_MILLISECONDS: Final[int] = 150
"""A deliberately tiny ceiling, set on one throwaway connection to prove the mechanism.

The configured ceiling is ten seconds, and a test that waited it out would add ten seconds to a
blocking gate to learn what a shorter value demonstrates identically: that PostgreSQL cancels an
overrunning statement and reports :data:`SQLSTATE_QUERY_CANCELED`. The configured value is asserted
separately, by :meth:`TestConnectionSettings.test_the_statement_timeout_reaches_the_server`, so
between them both halves are covered - the value that is configured, and what happens when it is
exceeded.
"""

_PROBE_SLEEP_SECONDS: Final[float] = 5.0
"""How long the probe statement asks to sleep: far past the probe ceiling, never actually waited.

The server cancels it after :data:`_PROBE_TIMEOUT_MILLISECONDS`, so the cost of this test is that
ceiling and not this sleep. It is large only so that a cancellation that failed to happen would be
unmistakable rather than a close call.
"""


def accepted_timeout_spellings(milliseconds: int) -> frozenset[str]:
    """Return every way PostgreSQL may render *milliseconds* in ``SHOW statement_timeout``.

    ``SHOW`` reports a ``GUC`` in whichever unit renders it most compactly, so ten thousand
    milliseconds comes back as ``10s`` rather than as the number that was set. Enumerating the
    equivalent spellings keeps the assertion an assertion about the *value* rather than about the
    server's formatting preference, which is not this project's contract to fix.

    Args:
        milliseconds: The configured ceiling.

    Returns:
        The accepted renderings: bare milliseconds, explicit milliseconds, and whole seconds when
        the value divides evenly.
    """
    spellings = {str(milliseconds), f"{milliseconds}ms"}
    seconds, remainder = divmod(milliseconds, 1000)
    if remainder == 0:
        spellings.add(f"{seconds}s")
    return frozenset(spellings)


@pytest.fixture
async def application_connection(database_schema: str) -> AsyncIterator[AsyncConnection]:
    """Open one connection from the *application's* engine, and leave nothing behind.

    ``database_schema`` is requested so the migrated test database is guaranteed to exist before
    this connects, exactly as ``conftest``'s own engine fixture does - autouse settles whether that
    fixture runs, not when, so the edge is declared rather than assumed.

    The engine is disposed in the teardown rather than merely released. Releasing returns the
    connection to a pool that would then hold it open for the remainder of the session, on an engine
    no other test uses; disposing closes it. The engine stays usable afterwards - disposal replaces
    the pool rather than breaking the object - so nothing left behind can affect another test.

    Args:
        database_schema: The migrated database's name, from ``conftest``. Not read; declared for
            the ordering edge.

    Yields:
        A live connection carrying exactly the settings ``app.db.session`` configures.
    """
    del database_schema
    try:
        async with engine.connect() as connection:
            yield connection
    finally:
        await engine.dispose()


class TestConnectionSettings:
    """What the server believes about a connection the application engine opened."""

    async def test_the_statement_timeout_reaches_the_server(
        self, application_connection: AsyncConnection
    ) -> None:
        """A stalled statement is bounded by the database, not left to the socket."""
        applied = await application_connection.scalar(text(SHOW_STATEMENT_TIMEOUT))

        # Asked of the server rather than read back from `safe_connect_args()`, which is the only
        # version of this assertion that can fail: a malformed `options` string, an escaping
        # mistake or a driver that stopped forwarding it all leave the constants untouched and the
        # session unbounded.
        assert applied in accepted_timeout_spellings(STATEMENT_TIMEOUT_MILLISECONDS), (
            f"{SHOW_STATEMENT_TIMEOUT} reported {applied!r}, which is not "
            f"{STATEMENT_TIMEOUT_MILLISECONDS}ms in any spelling"
        )

    async def test_the_timeout_is_declared_in_the_unit_postgresql_reads(self) -> None:
        """The one unit mistake this setting invites, pinned so it cannot be reintroduced."""
        # A bare integer in `statement_timeout` means MILLISECONDS. Declaring the human-facing
        # number in seconds and passing it through unconverted would set a ten-millisecond ceiling
        # and fail every request under load - a thousandfold error that looks like a typo-free line
        # of code. The derivation is what prevents it, and this is the assertion that keeps the
        # derivation.
        assert STATEMENT_TIMEOUT_MILLISECONDS == STATEMENT_TIMEOUT_SECONDS * 1000
        options = safe_connect_args()["options"]
        assert f"statement_timeout={STATEMENT_TIMEOUT_MILLISECONDS}" in options

    async def test_the_session_time_zone_still_reaches_the_server(
        self, application_connection: AsyncConnection
    ) -> None:
        """The setting that shares the option string with the timeout, and predates it."""
        # The regression this file exists to prevent. `timezone` and `statement_timeout` are two
        # `-c` options in ONE string; a change that appended the second by overwriting rather than
        # extending would leave every stored and returned instant interpreted in the server's local
        # zone, which no test of the timeout would notice.
        applied = await application_connection.scalar(text(SHOW_TIME_ZONE))
        assert applied == SESSION_TIME_ZONE

    async def test_every_new_connection_carries_the_same_settings(
        self, application_connection: AsyncConnection
    ) -> None:
        """A connect-time option, so it holds for the pool rather than for one connection."""
        # The first connection proves the option string is accepted; a second, opened independently,
        # proves it is applied per connection rather than having been set once by something the
        # first request happened to do. Every request in the service gets a connection from this
        # pool, so "the pool's connections are bounded" is the claim that matters.
        del application_connection
        async with engine.connect() as second:
            assert await second.scalar(text(SHOW_STATEMENT_TIMEOUT)) in (
                accepted_timeout_spellings(STATEMENT_TIMEOUT_MILLISECONDS)
            )
            assert await second.scalar(text(SHOW_TIME_ZONE)) == SESSION_TIME_ZONE

    async def test_the_keepalive_group_is_accepted_by_the_driver(
        self, application_connection: AsyncConnection
    ) -> None:
        """Four keywords libpq would have rejected outright if any were wrong."""
        # libpq fails the connection on an unrecognised keyword, so the connection this fixture
        # already opened is the assertion; the statement below only confirms it is usable. The key
        # check that follows is what makes the failure legible - a missing keyword would otherwise
        # surface as an opaque connection error somewhere unrelated.
        assert await application_connection.scalar(text("SELECT 1")) == 1

        connect_args = safe_connect_args()
        for keyword, value in TCP_KEEPALIVE_ARGS.items():
            assert connect_args.get(keyword) == value, (
                f"{keyword!r} is declared in TCP_KEEPALIVE_ARGS but is not what the engine "
                f"connects with, so a silently dead connection is not bounded"
            )


class TestMigrationConnectionContract:
    """The migration engine carries every shared invariant and **no** statement ceiling.

    The request path's ten-second ceiling is generous for a route and fatal for a migration:
    ``0002`` builds seven GIN and trigram indexes and ``0004`` builds three B-trees, and over a
    populated relation an ordinary build can exceed ten seconds - at which point PostgreSQL
    cancels it with :data:`SQLSTATE_QUERY_CANCELED`, the revision fails, and the upgrade rolls
    back on the container's start-up path before the service answers anything.

    That failure is invisible to every other gate in this repository, which is why these
    assertions exist. A fresh database builds every index in milliseconds, so no migration test
    against an empty schema can see the ceiling; and "no ceiling" leaves no trace in a migration
    that succeeds. The guarantee therefore has to be asserted directly, in three independent
    ways: the factory declares no ceiling, the server confirms the resulting session has none,
    and ``migrations/env.py`` is actually wired to that factory rather than to the request-path
    one.
    """

    def test_the_migration_factory_declares_no_statement_ceiling(self) -> None:
        """The defect in one assertion: no value in the mapping may mention the setting."""
        # Every entry is searched, not just `options`, because the setting can be spelled either
        # as a `-c` entry inside the option string or as a libpq keyword of its own - and a future
        # edit could reintroduce it by either route.
        args = migration_connect_args()
        offenders = {
            keyword: value
            for keyword, value in args.items()
            if STATEMENT_TIMEOUT_KEYWORD in keyword or STATEMENT_TIMEOUT_KEYWORD in value
        }
        assert offenders == {}, (
            f"migration_connect_args() carries {STATEMENT_TIMEOUT_KEYWORD!r} in {offenders!r}; a "
            f"populated-table index build in revision 0002 or 0004 would be cancelled with "
            f"{SQLSTATE_QUERY_CANCELED} and abort the upgrade"
        )

    def test_the_migration_factory_keeps_every_other_invariant(self) -> None:
        """Omitting the ceiling must not have omitted the invariants no workload may decline."""
        args = migration_connect_args()

        # UTC, because `0003` INSERTs rows and every timestamp column in this schema is
        # `timestamptz`: a migration writing under the server's local zone would store instants the
        # application then reads as UTC.
        assert args["options"] == f"-c timezone={SESSION_TIME_ZONE}"

        # The connect bound matters more on this engine than on any other - the run sits on the
        # container's start-up path, where libpq's 130-second default is the difference between a
        # legible failure and a stalled deployment.
        assert args["connect_timeout"] == safe_connect_args()["connect_timeout"]

        # And the keepalive group, which is what bounds a vanished peer during a long index
        # build - precisely the failure the omitted server-side ceiling would otherwise have caught.
        for keyword, value in TCP_KEEPALIVE_ARGS.items():
            assert args.get(keyword) == value

    def test_the_two_factories_differ_only_by_the_ceiling(self) -> None:
        """One contract, two workloads: the split must not have become a second contract."""
        # Asserted as a relationship rather than by restating either mapping, so adding a shared
        # invariant to `_connection_invariants` needs no change here, while adding one to only the
        # request path - where it would silently stop applying to migrations - fails this.
        request_path = safe_connect_args()
        migration = migration_connect_args()

        assert set(request_path) == set(migration)
        assert {
            keyword: value for keyword, value in request_path.items() if keyword != "options"
        } == {keyword: value for keyword, value in migration.items() if keyword != "options"}
        assert request_path["options"] == (
            f"{migration['options']} -c {STATEMENT_TIMEOUT_KEYWORD}"
            f"={STATEMENT_TIMEOUT_MILLISECONDS}"
        )

    def test_the_alembic_environment_is_wired_to_the_migration_factory(self) -> None:
        """A correct factory that nothing calls is not a guarantee.

        Asserted over the parsed module rather than over its text, because the text mentions
        ``safe_connect_args`` in the comment explaining why it is *not* used - so a substring
        search would answer the opposite of the question. What matters is which name is
        **called**.
        """
        tree = ast.parse(MIGRATIONS_ENV_PATH.read_text(encoding="utf-8"))
        called = {
            node.func.id
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        }

        assert "migration_connect_args" in called, (
            "backend/migrations/env.py no longer calls migration_connect_args(), so its engine's "
            "connection contract is whatever it now passes instead"
        )
        assert "safe_connect_args" not in called, (
            "backend/migrations/env.py calls safe_connect_args(), which imposes the request "
            "path's statement ceiling on every migration connection"
        )

    async def test_a_migration_session_reports_no_ceiling_to_the_server(self) -> None:
        """The server's own view, which is the only formulation that can fail if libpq ignored us.

        Reading the mapping back proves the expression, not the effect - the same reasoning the
        module docstring gives for asserting through ``SHOW`` everywhere else. This opens a real
        connection with the migration arguments and asks PostgreSQL what it is applying.
        """
        # A throwaway NullPool engine so nothing is left pooled for the rest of the session, and
        # `create_async_engine` rather than Alembic's synchronous `create_engine` only because this
        # module is async: the connect arguments are driver-agnostic and both spellings reach the
        # same psycopg 3 driver, which is the property `migration_connect_args` documents.
        probe = create_async_engine(
            settings.DATABASE_URL,
            poolclass=NullPool,
            connect_args=migration_connect_args(),
        )
        try:
            async with probe.connect() as connection:
                applied = await connection.scalar(text(SHOW_STATEMENT_TIMEOUT))
                # No ceiling at all, so an index build is bounded by nothing but its own work.
                assert applied == NO_STATEMENT_CEILING
                assert applied not in accepted_timeout_spellings(STATEMENT_TIMEOUT_MILLISECONDS)

                # The shared invariant survived the split, asked of the same session.
                assert await connection.scalar(text(SHOW_TIME_ZONE)) == SESSION_TIME_ZONE
        finally:
            await probe.dispose()


class TestStatementCancellation:
    """What actually happens when a statement overruns its ceiling."""

    async def test_an_overrunning_statement_is_cancelled_and_reports_query_canceled(
        self, application_connection: AsyncConnection
    ) -> None:
        """The mechanism, and the condition code the readiness probe classifies on."""
        # The ceiling is shortened on this one connection rather than the configured ten seconds
        # being waited out: the behaviour under test is "PostgreSQL cancels and says 57014", which
        # is identical at either value, and a ten-second test in a blocking gate buys nothing.
        await application_connection.execute(
            text(f"SET statement_timeout = {_PROBE_TIMEOUT_MILLISECONDS}")
        )

        try:
            with pytest.raises(OperationalError) as raised:
                await application_connection.execute(
                    text(f"SELECT pg_sleep({_PROBE_SLEEP_SECONDS})")
                )

            # The code, not the message. `app.api.v1.routers.health` files exactly this SQLSTATE as
            # `query_timeout` instead of as a connection failure, and it can only do that if the
            # server really publishes it - the two files are one contract with the halves asserted
            # in each.
            assert getattr(raised.value.orig, "sqlstate", None) == SQLSTATE_QUERY_CANCELED
        finally:
            # Discarded rather than reset. The shortened ceiling belongs to this connection, and a
            # connection returned to the pool carrying it would give some later caller a
            # 150-millisecond budget - a failure that would surface far from here and look like
            # anything but this test. Invalidation is also what the readiness route does with a
            # connection its deadline cancelled, for the same reason.
            await application_connection.invalidate()
