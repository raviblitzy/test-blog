"""The single database connection surface of the service tier.

Two module-level objects, and deliberately nothing else:

* :data:`engine` - one :class:`~sqlalchemy.ext.asyncio.AsyncEngine` per process, owning the
  connection pool every request borrows from. ``app.main``'s lifespan disposes it on
  shutdown.
* :data:`AsyncSessionLocal` - the factory that turns a pooled connection into a unit of
  work. ``app.core.dependencies.get_db`` yields one request-scoped session from it and
  guarantees the close, and ``app.db.seed`` opens one directly with
  ``async with AsyncSessionLocal() as session:``.

Both names are contract rather than convention. ``app.main``, ``app.core.dependencies``
and ``app.db.seed`` are written against them, so renaming either breaks three modules at
once.

What this replaces
------------------
The service this repository grew out of kept every record in a module-level list::

    # In-memory storage
    items = []

Those two lines were the entire system of record, and the measured recovery point of that
list was zero records after any process restart - which is why it is deleted outright
rather than migrated or dual-written: no client could ever have depended on its contents.
It failed under concurrency as well as across restarts. Under two worker processes, eight
identical collection reads returned element counts of ``16 16 16 16 16 16 8 16``, and four
identical reads of one identifier returned ``404 200 404 200``, because each worker was
mutating its own private copy. Moving the system of record into PostgreSQL through this
module is precisely the change that makes multi-worker operation correct: every worker
still builds its own pool here, but they all borrow connections to one database.

Where the URL comes from
------------------------
``settings.DATABASE_URL``, and nowhere else. This module reads no environment variable,
loads no dotenv file, opens no file and carries no fallback URL - a silent fallback is
worse than a startup failure, because it succeeds against somewhere unintended.
``app.core.config`` has already validated the value into the async ``postgresql+psycopg``
form and rejected every other driver, so it is passed through verbatim: no rewriting, no
scheme swapping, no second opinion. The synchronous URL Alembic needs is derived once, in
``backend/migrations/env.py``; deriving it here as well would give the project two answers
to one question and no way to notice when they disagreed.

Pool policy without new configuration
-------------------------------------
The four pool values below are module constants rather than settings fields, and that is a
decision rather than an omission. ``.env.example`` is this repository's configuration
contract, it enumerates fourteen variables across the two tiers, and none of them is a
pool setting; introducing a ``DB_POOL_SIZE`` key here would immediately desynchronise that
file from ``README.md``'s environment table, ``docker-compose.yml`` and
``.github/workflows/ci.yml``. Constants keep the whole policy in one reviewable place, and
a deployment that genuinely needs different numbers changes a line of code that ships
through the same review as any other.

Every connection speaks UTC
---------------------------
:data:`CONNECT_ARGS` pins the PostgreSQL session time zone to UTC on every connection this
engine opens, and that is part of the API's wire contract rather than a local preference.
Every timestamp column in this schema is ``TIMESTAMP WITH TIME ZONE``, and psycopg loads
such a value as an *aware* :class:`~datetime.datetime` carrying the offset of the
**session** time zone - not necessarily UTC. Pydantic then serialises whatever offset it
was handed, and every response schema in ``app.schemas`` documents its instants as UTC,
for example ``2026-01-15T09:30:00Z``. Those two facts only agree if the connection is UTC.

Measured on PostgreSQL 18.4 through psycopg 3.3.4, with the database's own default changed
to a non-UTC zone (``ALTER DATABASE … SET timezone='America/New_York'``, which is exactly
what an operator or a managed provider might do): an unpinned connection loaded
``categories.created_at`` as ``2026-08-08T12:07:55.588258-04:00``, and Pydantic 2.13.4
serialises that verbatim as ``…-04:00`` rather than as ``…Z``; the pinned connection loaded
the same row as ``2026-08-08T16:07:55.588258+00:00``, which Pydantic renders ``…Z``. The
instant is identical either way - so nothing here is *wrong* without the pin - but the
published contract, the ``frontend/src/lib/format.ts`` formatters that resolve their
calendar fields in UTC, and the end-to-end suite's pinned ``timezoneId: 'UTC'`` are all
written against ``Z``, and a client comparing date strings or slicing the first ten
characters of one would silently read the wrong calendar day either side of midnight.

Pinning it here also means no other layer has to normalise: no response serialiser
converting on the way out, no ``astimezone`` in a schema validator, and no per-connection
event listener - one connect argument, applied before the first statement, and the values
are already UTC by the time anything reads them.

Isolation level: PostgreSQL's default, and what that means for a reader
----------------------------------------------------------------------
No isolation level is configured, so every transaction runs at **READ COMMITTED**, and
that is a deliberate choice rather than an omission. Each *statement* therefore sees its
own snapshot, taken when it begins.

The consequence a caller has to know is that a multi-statement read is not one snapshot.
``app.repositories.base.BaseRepository.paginate`` issues a count and then a window, and a
``selectinload`` adds a statement of its own, so a write committed in between is visible to
the later statement and not the earlier one: a ``total`` can describe a set marginally
different from the ``items`` beside it. That method's own documentation states this rather
than claiming an exactness it cannot supply.

The alternative was considered and rejected. REPEATABLE READ would give one snapshot per
transaction, but sessions here serve writes as well as reads, and under that level a
concurrent update makes a write fail with ``40001 could not serialize access due to
concurrent update`` - which would need a retry policy on every mutating route to buy
consistency for a feed count. Where exactness genuinely decides a write, the fix is a row
lock at that point (``get_by_id(..., for_update=True)``, ``UPDATE ... WHERE ... RETURNING``)
rather than a level change across the whole application.

Lazy by contract
----------------
Constructing an engine opens no connection, and nothing in this module forces one: there
is no ``connect()``, no ``begin()``, no ping, no reflection and no ``create_all()``. Four
callers depend on that. ``app.main`` imports :data:`engine` at import time,
``app.core.dependencies`` imports :data:`AsyncSessionLocal`, ``backend/tests/conftest.py``
drives the application in-process over an httpx ASGI transport with no live server at all,
and ``alembic check`` imports the ``app`` package before it has been asked to touch a
database. Importing this module with PostgreSQL stopped therefore has to succeed, and it
does. Connectivity is proved where it belongs: ``app.api.v1.routers.health`` backs
``/readyz`` with a trivial query on request, while ``/healthz`` touches no database at all.

No schema, no queries, no helpers
---------------------------------
Alembic is the sole schema authority. ``backend/migrations/versions/`` creates every
relation, enum, index and constraint, and the backend container applies them with
``alembic upgrade head`` on start, once the ``db`` service reports healthy, so the
application never creates its own schema. There is no ``Base.metadata.create_all()`` here
and no DDL of any kind: a shortcut around Alembic would make both the ``alembic check``
drift gate and the ``upgrade`` / ``downgrade`` / ``upgrade`` reversibility gate
meaningless, and it would put the ``citext`` uniqueness, publication ``CHECK``,
composite-key idempotency and ``ON DELETE CASCADE`` guarantees owned by ``app.models`` and
the revisions at risk of silently diverging. No model is imported either - reaching for
``app.models`` from here would close an import cycle through ``app.db.base`` and drag the
whole mapped tree into every consumer of this module.

For the same reason there is no session context manager, no ``session_scope``, no
``dispose_engine`` wrapper and no ``init_db``. Session lifecycle already belongs to
``get_db``, disposal to the ``app.main`` lifespan, and every ``SELECT``, ``INSERT`` and
``UPDATE`` to ``app.repositories``. This module hands out sessions; it holds no query, no
ownership check and no domain rule.

Observability
-------------
Two settings on the engine below decide what a statement can reveal, and both are fixed
rather than staged.

``hide_parameters=True``, always. SQLAlchemy otherwise renders the bound values into the
line it logs, and in this schema those values are the data itself: an email address, a
password hash, a refresh-token digest, the body of an unpublished draft. With it on the
statement is still logged whole - which query, which table, how many parameters - and the
values are replaced by a fixed marker, so the line keeps every property that makes it worth
having and loses the one that makes it a liability.

``echo`` is not set at all. Passing ``echo=True`` attaches a plain-text ``StreamHandler`` of
SQLAlchemy's own to the ``sqlalchemy.engine.Engine`` logger, and because this engine is
built at import time that handler predates ``configure_logging()`` and survives its bridge -
producing two renderings of every statement, one structured and one not. Statement logging
belongs to the log level instead: ``app.core.logging`` pins the SQLAlchemy namespace to
``WARNING`` unless ``LOG_LEVEL`` is ``DEBUG``, and at ``DEBUG`` the statements travel the same
processor chain as every other event. Logging is configured there and called once from the
``app.main`` lifespan, never here. ``echo_pool`` is left off for the same reason: pool churn
is not something a developer reads statement by statement.
"""

from typing import Final

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import settings

__all__ = [
    "CONNECT_ARGS",
    "MAX_OVERFLOW",
    "POOL_PRE_PING",
    "POOL_RECYCLE_SECONDS",
    "POOL_SIZE",
    "SESSION_TIME_ZONE",
    "AsyncSessionLocal",
    "engine",
]


# ---------------------------------------------------------------------------------------
# Pool policy
#
# Four named constants, each documented with the reasoning behind its value, so that the
# pool is configured explicitly instead of inheriting whatever the library defaults to.
# They are deliberately NOT settings fields - see "Pool policy without new configuration"
# in the module docstring for why adding an environment key here would break the
# .env.example contract that four other files are written against.
# ---------------------------------------------------------------------------------------

POOL_SIZE: Final[int] = 5
"""Connections each process keeps open once they have been established.

Sized against the whole deployment rather than against one process. Every gunicorn worker
builds its own engine and therefore its own pool, so the ceiling the database actually
sees is ``workers x (POOL_SIZE + MAX_OVERFLOW)``. Five keeps a four-worker container
comfortably inside PostgreSQL's default ``max_connections`` of 100, which matters because
exhausting that limit locks out the administrator as well as the application.
"""

MAX_OVERFLOW: Final[int] = 10
"""Extra connections permitted above :data:`POOL_SIZE` while a burst is in flight.

Overflow connections are opened on demand and closed again when they are returned, so they
absorb a spike - a feed page fanning out to posts, categories and like counts - without
paying to hold fifteen idle connections for the rest of the process's life.
"""

POOL_RECYCLE_SECONDS: Final[int] = 1800
"""Maximum age of a pooled connection, in seconds; thirty minutes.

Anything between this process and PostgreSQL may drop an idle TCP connection without
telling either end: a container network, a proxy, a server-side idle-session timeout.
Retiring connections on a schedule shorter than the shortest of those limits means the
pool discards a stale connection on its own terms rather than a request discovering it.
"""

POOL_PRE_PING: Final[bool] = True
"""Whether a pooled connection is tested before it is handed to a caller.

This is what keeps a long-lived container healthy across a database restart: the pool
issues a cheap liveness check on checkout and transparently replaces any connection the
server has already closed, so the first request after the database comes back succeeds
instead of surfacing a stale-connection error. The cost is one round trip per checkout,
which is the right trade for a service whose database is a separate process, and it
complements :data:`POOL_RECYCLE_SECONDS` rather than duplicating it - recycling handles
the ages this process can predict, pre-ping handles the closures it cannot.
"""

SESSION_TIME_ZONE: Final[str] = "UTC"
"""The PostgreSQL session time zone every connection this engine opens is pinned to.

Part of the wire contract, not a preference - see "Every connection speaks UTC" in the
module docstring for the measurement and for what breaks without it.
"""

CONNECT_ARGS: Final[dict[str, str]] = {
    # A libpq `options` string, passed through by psycopg to the server at connection time,
    # so the setting is established before the first statement and costs no extra round
    # trip. `-c timezone=UTC` is the same thing as `SET TIME ZONE 'UTC'` without needing a
    # statement, an event listener or a checkout hook to issue it.
    "options": f"-c timezone={SESSION_TIME_ZONE}",
}
"""The connect arguments passed to psycopg for every connection. See :data:`engine`."""


# ---------------------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------------------

engine: AsyncEngine = create_async_engine(
    # Passed through exactly as app.core.config validated it - the async
    # postgresql+psycopg form. The synchronous URL Alembic drives is derived in
    # backend/migrations/env.py, so this project has one URL derivation, not two.
    settings.DATABASE_URL,
    # Parameters are NEVER rendered. SQLAlchemy interpolates the bound values into the line
    # it logs unless told otherwise, and those values are the request's contents: a
    # plaintext-adjacent password hash, an email address, a refresh-token digest, the body
    # of somebody's draft. With this on, the statement is still logged in full and the
    # values are replaced by a fixed marker, so a statement log keeps its diagnostic value -
    # which query, against which table, with how many parameters - and stops being a copy of
    # the data. It is set unconditionally, in every environment, because "development" is a
    # laptop with a real database attached at least as often as it is a throwaway one.
    hide_parameters=True,
    # `echo` is deliberately NOT set, in any environment.
    #
    # Two reasons, and the second is the one that matters. Passing `echo=True` makes
    # SQLAlchemy attach a StreamHandler of its own to the `sqlalchemy.engine.Engine` logger
    # with its own plain-text formatter (`sqlalchemy.log._add_default_handler`), and this
    # engine is constructed at import time - before `app.main`'s lifespan calls
    # `configure_logging()`. The result is a handler the structlog bridge never gets the
    # chance to detach, so every statement is written twice: once as unstructured text and
    # once as JSON, which is exactly the state a single-owner logging design exists to
    # prevent. And it makes statement logging a property of the deployment stage rather than
    # of the log level, which is the wrong axis.
    #
    # Statement logging is therefore controlled by LOG_LEVEL alone. `app.core.logging` pins
    # the SQLAlchemy namespace to WARNING unless LOG_LEVEL is DEBUG, and at DEBUG the
    # statements flow through the same processor chain as everything else - one shape, one
    # sink, parameters scrubbed by the line above.
    pool_pre_ping=POOL_PRE_PING,
    pool_size=POOL_SIZE,
    max_overflow=MAX_OVERFLOW,
    pool_recycle=POOL_RECYCLE_SECONDS,
    # Exactly one connect argument, and it is a correctness requirement rather than tuning -
    # see "Every connection speaks UTC" in the module docstring. Nothing else is passed:
    # there is no connection pooler in front of PostgreSQL in this deployment
    # (docker-compose.yml defines db, backend and frontend and nothing else), so
    # prepared-statement or statement-cache tuning would be speculative.
    connect_args=CONNECT_ARGS,
)
"""The one engine this process owns, and the pool behind every session it hands out.

Built at import time and never rebuilt. An engine *is* a pool, so a second one would double
the connections this process holds against the database while halving the reuse each of
them gets. Construction is pure bookkeeping - the first connection is established when a
session first needs one - which is what lets ``backend/tests/conftest.py`` and
``alembic check`` import this module with no database reachable.

``app.main``'s lifespan calls ``await engine.dispose()`` on shutdown, closing the pooled
connections deliberately rather than leaving the server to reap them. Nothing else disposes
it, and nothing else needs to.
"""


# ---------------------------------------------------------------------------------------
# Session factory
# ---------------------------------------------------------------------------------------

AsyncSessionLocal: async_sessionmaker[AsyncSession] = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    # MANDATORY, not a preference - see the docstring below.
    expire_on_commit=False,
    # autoflush is deliberately left at SQLAlchemy's default; the docstring says why.
)
"""Factory for the unit of work every database interaction in this service runs inside.

``app.core.dependencies.get_db`` yields one session per request from here and owns its
rollback and its close, which is the only lifecycle a router ever sees; ``app.db.seed``
opens one directly. ``backend/tests/conftest.py`` builds its own engine and its own
per-test transaction and overrides ``get_db`` with them, so this factory needs no
test-only branching - and has none, because a pool strategy that exists only for tests is
a difference between what is tested and what is shipped.

``expire_on_commit=False`` is mandatory. With SQLAlchemy's default of ``True``, committing
expires every attribute of every instance in the session, so the next attribute read
silently emits a ``SELECT`` to reload it. Under asyncio that read is implicit IO from
synchronous context, and instead of a query it raises ``MissingGreenlet`` - which would
mean every route that commits and then serialises its response model fails, because
serialising a model *is* an attribute read after a commit. Switching expiry off is what
makes the commit-then-return pattern the service and router layers are written around
safe.

``autoflush`` is left at SQLAlchemy's default of ``True``, stated here explicitly so that a
later reader does not take its absence for an oversight. The repositories rely on it:
adding an object and then querying within the same transaction has to see the pending row,
and it only does because the session flushes before it executes the query. Turning it off
would trade a well-understood behaviour for a subtler class of surprise.
"""
