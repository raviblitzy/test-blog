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
The pool values below are module constants rather than settings fields, and that is a
decision rather than an omission. ``.env.example`` is this repository's configuration
contract, it enumerates fifteen variables across the two tiers, and none of them is a
pool setting; introducing a ``DB_POOL_SIZE`` key here would immediately desynchronise that
file from ``README.md``'s environment table, ``docker-compose.yml`` and
``.github/workflows/ci.yml``. Constants keep the whole policy in one reviewable place, and
a deployment that genuinely needs different numbers changes a line of code that ships
through the same review as any other.

The connection budget is a deployment-wide sum, not a per-process choice
------------------------------------------------------------------------
An engine is a pool, every worker process builds its own, and every replica runs its own
workers - so the number PostgreSQL actually sees is the product, never the per-worker
figure this module configures::

    connections demanded = replicas x workers-per-replica x (POOL_SIZE + MAX_OVERFLOW)

Sizing on the per-worker figure alone is how a service exhausts ``max_connections``, and
exhausting it does not merely slow requests down: PostgreSQL refuses new connections
outright, which locks out the migration runner, the readiness probe and the operator's
``psql`` session at exactly the moment somebody needs them. The three values below are
therefore chosen against the *product*, and the arithmetic is asserted at import time by
:func:`_assert_within_connection_budget` rather than left as a comment somebody has to
re-derive:

======================================  =====  ==========================================
Quantity                                Value  Where it comes from
======================================  =====  ==========================================
:data:`POOL_SIZE`                       3      this module
:data:`MAX_OVERFLOW`                    2      this module
per-worker ceiling                      5      ``POOL_SIZE + MAX_OVERFLOW``
:data:`MAX_WORKERS_PER_REPLICA`         4      the supported MAXIMUM Gunicorn worker
                                               count; ``backend/Dockerfile`` ships 2
:data:`MAX_REPLICAS`                    2      the planned replica count this budget is
                                               sized for
peak application connections            40     ``2 x 4 x 5``
:data:`RESERVED_CONNECTIONS`            20     migrations, ``/readyz``, ``psql``, and
                                               PostgreSQL's own
                                               ``superuser_reserved_connections``
total reserved against the server       60     ``40 + 20``
:data:`ASSUMED_MAX_CONNECTIONS`         100    **PostgreSQL's default**
                                               ``max_connections``, which this deployment
                                               requires as a floor
======================================  =====  ==========================================

**The operational requirement that follows: the database must permit at least 60
connections, and PostgreSQL's default of 100 satisfies it with room to spare.**
:data:`REQUIRED_MAX_CONNECTIONS` exports that figure, so a deployment document or an
operator can state the requirement by importing the value rather than by re-deriving it.
Raising
either scaling constant without raising ``max_connections`` on the server breaks the
inequality, and the import-time assertion turns that into a startup failure with the
arithmetic in the message - the same fail-closed treatment ``app.core.config`` gives a
short signing key - rather than into intermittent ``too many clients already`` errors under
load. The correct order for a genuine scale-out is: raise ``max_connections`` on the server
first, then raise :data:`ASSUMED_MAX_CONNECTIONS` to the new floor, then raise
:data:`MAX_REPLICAS` or :data:`MAX_WORKERS_PER_REPLICA` to match.

Why the per-worker figure is small rather than generous: a request holds exactly one
connection, for the length of one request-scoped session, and the handlers here are
short - the feed is two statements plus two batched loaders, and every mutation is one
transaction that commits and ends. Three retained connections per worker therefore serve
three concurrent requests per worker, twelve per container, with two more per worker
available on demand for a burst. A pool larger than the concurrency the process can
actually drive holds idle connections that cost the server memory and cost this deployment
its headroom.

Every connection speaks UTC
---------------------------
:func:`safe_connect_args` pins the PostgreSQL session time zone to UTC on every connection
this engine opens, and that is part of the API's wire contract rather than a local preference.
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
event listener - one entry of :func:`safe_connect_args`, applied before the first statement,
and the values are already UTC by the time anything reads them.

Reaching the database is bounded in time
----------------------------------------
Getting a connection can fail in two shapes, and only one of them is self-announcing. A *refused*
connection - the server process gone, nothing listening - comes back immediately, so
``/readyz`` answers 503 in about two milliseconds and the pool slot is free again at once.
A *hung* server is the other shape: something accepts the TCP connection and then never
completes the startup handshake, which is what a blocked network path, a saturated
connection backlog or a wedged host looks like from here. Nothing about that state arrives
as an error, so the only thing that ends the attempt is a timeout - and if no timeout is
configured, the one that applies is libpq's own default of **130 seconds**, which psycopg
carries as ``psycopg.conninfo._DEFAULT_CONNECT_TIMEOUT``.

Measured against a listener that accepted connections and never answered, with no bound
configured: ``/readyz`` returned the correct 503 problem document after **130.0 seconds**,
and for the whole of that time all five connections this worker may hold
(:data:`WORKER_CONNECTION_CEILING`) were consumed by stuck connect attempts, so every
database-backed route queued behind them and then failed on SQLAlchemy's default 30-second
checkout wait. A readiness probe that takes over two minutes to say "not ready" is not a
probe: an orchestrator has long since given up, and a *hung* database has been converted
into hung user requests instead of fast failures.

:data:`CONNECT_TIMEOUT_SECONDS` and :data:`POOL_TIMEOUT_SECONDS` are therefore both set
explicitly, and both are availability requirements rather than tuning knobs. Together they
bound **connection acquisition** - one wait for a slot plus one connection attempt - at
roughly ten seconds, so ``/readyz`` fails fast enough to be actionable and a slot is
returned to the pool about twenty-six times sooner than before. That bound is about getting
a connection and nothing else; what happens to a statement once one is established is the
next section's subject. ``/healthz`` is unaffected either way, because it touches no
database at all; that separation is the whole reason the two probes exist.

Measured after the change, against the same listener: a single ``/readyz`` on a fresh pool
answered 503 in **5.01 seconds**, and a burst of six ``/readyz`` plus four feed requests -
ten callers against five slots - cleared in **5.03 seconds** in total, every one of them
answered, while ``/healthz`` kept replying in under a millisecond throughout. The *refused*
path is unchanged at **1.3 to 2.3 milliseconds**, which is the property worth checking after
any change here: a connect timeout must not turn a fast refusal into a full wait, and it
does not, because a refused socket reports itself immediately and the deadline is only ever
reached by a peer that stays silent.

A statement that stalls is bounded too, and by a different mechanism
--------------------------------------------------------------------
The two values above bound *reaching* the database. They say nothing about a server that
accepts a connection, answers normally, and only then goes silent **mid-session** - a
statement stalling rather than a connection failing, which neither a connect timeout nor a
checkout timeout applies to. :data:`POOL_PRE_PING` covers the common form of it, since a
connection the server has actually closed is detected on checkout and replaced, but a wedged
backend or a partition that holds the socket open is not that.

Three things bound it now, each covering what the others cannot, and the distinction between
them matters because they fail in different places:

:data:`STATEMENT_TIMEOUT_SECONDS`
    A server-side ceiling, set through libpq's ``options`` so it is established before the
    first statement. PostgreSQL itself cancels a statement that exceeds it and the caller
    receives ``57014 query_canceled`` - measured through this engine at its configured value:
    ``SHOW statement_timeout`` reports ``10s`` and ``pg_sleep(30)`` is cancelled at 10.011 s as
    ``QueryCanceled``, after which the next checkout from the pool answers normally. This is
    what bounds a *wedged backend*: a query the server is still nominally running. It is
    deliberately generous rather than tight, for the reason recorded at that constant's own
    definition below.
:data:`TCP_KEEPALIVE_ARGS`
    A transport-level probe, because a server-side ceiling is useless when the *path* to the
    server is gone: PostgreSQL cancels the statement and the cancellation never arrives. TCP
    keepalives make the kernel probe the peer and fail the socket when those probes go
    unacknowledged, which turns an indefinite wait into a bounded one for every caller. They
    bound an unreachable *host*, not a reachable host that answers nothing - the peer's kernel
    acknowledges a keepalive whatever its server process is doing.
A caller-side deadline, where a caller needs a promise
    Neither mechanism above is instant, and an orchestrator's probe timeout is a hard number.
    So ``app.api.v1.routers.health.readiness`` wraps its own statement in an explicit
    ``asyncio.timeout`` and invalidates the connection if it elapses. That is the only place
    in this service that does, and it is deliberate: readiness is the one operation whose
    *whole point* is to answer inside a fixed window, while a feed request would rather take
    a slow answer than none. The bound a caller can rely on therefore lives at the call site
    that needs it, and the two engine-wide values below are the floor under everything else.

The honest summary, which supersedes any claim that "ten seconds" is a total: **acquiring** a
connection is bounded at roughly ten seconds (one wait for a slot plus one connect attempt),
a **statement** is bounded by the server-side ceiling and, when the host itself becomes
unreachable, by the keepalive budget, and the one caller that must not exceed its own probe
window enforces that window itself.

One case remains outside all three, and it is named rather than papered over: a transport that
keeps acknowledging packets while carrying no application data - a black-holing middlebox, or a
server frozen instead of merely slow - defeats each of them, because the server cannot run its own
timer, the kernel sees a healthy socket, and a cancellation has to travel the same dead path as
the query it is cancelling. ``app.api.v1.routers.health.READINESS_TIMEOUT_SECONDS`` documents what
that means for the one caller with a hard window, and what the backstop is.
What these two values do **not** bound, stated so that the section title is not read wider
than it is: a server that accepts a connection, answers normally, and only then goes silent
*mid-session*. That is a statement stalling rather than a connection failing, and neither a
connect timeout nor a checkout timeout applies to it. :data:`POOL_PRE_PING` covers the
common form of it - a connection the server has actually closed is detected on checkout and
replaced - but a silent network partition holding the socket open is bounded only by TCP
keepalive or by a server-side statement timeout. No statement timeout is configured here on
purpose: it would apply to every query this service runs, including the seeder's bulk
inserts, and choosing one number for all of them is a decision this module has no basis to
make. If that mode ever needs bounding, it belongs in :func:`safe_connect_args` as a
documented libpq ``keepalives`` group or in the specific call that needs it, not as a
blanket ceiling.

Three processes open connections to this database, and all three get these guarantees
---------------------------------------------------------------------------------------
The engine below is one of **three** engine owners in this project, and the two others are
not application code:

* ``backend/migrations/env.py`` opens a synchronous :class:`~sqlalchemy.pool.NullPool`
  engine for every ``alembic upgrade``, ``downgrade``, ``check`` and ``revision`` run - and
  in the container that run happens on the startup path, before the service answers
  anything;
* ``backend/tests/conftest.py`` opens an asynchronous ``NullPool`` engine for the test
  session.

Two of the guarantees above are properties of a *connection*, not of a pool, so leaving
them to the application engine alone would have meant the two guarantees that matter most
when a database is misbehaving applied to the one caller least likely to meet it first. A
hung server would have held a migration - and with it a container start - for libpq's full
130 seconds while the application next door failed in five, and a statement logged by
Alembic or by the suite would have carried its bound values in full while the same
statement logged by a route carried a marker. That asymmetry is what
:func:`_connection_invariants` and :data:`HIDE_PARAMETERS` exist to remove: they are pure,
environment-independent values, they name no pool, and each of the three owners applies
them to whatever engine it builds.

One of them travels with the *request path* only
------------------------------------------------
:data:`STATEMENT_TIMEOUT_SECONDS` is the exception, and it is why there are two factories
rather than one. A request and a migration want opposite things from a statement ceiling: a
route that has not answered in ten seconds has already failed its caller, while a
``CREATE INDEX`` over a populated relation legitimately takes longer than any request may and
is cancelled by the same ceiling with ``57014 query_canceled`` - aborting an upgrade that was
doing exactly what it was asked to do, on the container's start-up path, where the abort also
takes the service start with it.

So the invariants that belong to every connection live in :func:`_connection_invariants`, and
each workload adds what belongs to it: :func:`safe_connect_args` for the request path, which is
the application engine and the suite's session engine, and :func:`migration_connect_args` for
Alembic, which is identical except that it declares no statement ceiling. Splitting the
factories rather than passing a flag is what makes the choice visible at the call site and
impossible to inherit by accident.

What deliberately does **not** travel with them is every pool setting -
:data:`POOL_SIZE`, :data:`MAX_OVERFLOW`, :data:`POOL_RECYCLE_SECONDS`,
:data:`POOL_PRE_PING` and :data:`POOL_TIMEOUT_SECONDS`. Those describe how a long-lived
worker *retains* connections between requests, and both other owners use ``NullPool``,
which retains none: passing a pool size to a pool that holds nothing would be
configuration that reads as meaningful and is not, and :func:`_assert_within_connection_budget`
counts one pooled engine per process precisely because the other two hold no pool to count.

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
does. Connectivity is proved where it belongs: ``app.services.health_service`` backs
``/readyz`` with a trivial query on request - issued by
``app.repositories.health_repository``, like every other statement in the service - while
``/healthz`` touches no database at all.

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
    "ASSUMED_MAX_CONNECTIONS",
    "CONNECT_TIMEOUT_SECONDS",
    "HIDE_PARAMETERS",
    "MAX_OVERFLOW",
    "MAX_REPLICAS",
    "MAX_WORKERS_PER_REPLICA",
    "PEAK_APPLICATION_CONNECTIONS",
    "POOL_PRE_PING",
    "POOL_RECYCLE_SECONDS",
    "POOL_SIZE",
    "POOL_TIMEOUT_SECONDS",
    "REQUIRED_MAX_CONNECTIONS",
    "RESERVED_CONNECTIONS",
    "SESSION_TIME_ZONE",
    "STATEMENT_TIMEOUT_MILLISECONDS",
    "STATEMENT_TIMEOUT_SECONDS",
    "TCP_KEEPALIVE_ARGS",
    "WORKER_CONNECTION_CEILING",
    "AsyncSessionLocal",
    "engine",
    "migration_connect_args",
    "safe_connect_args",
]


# ---------------------------------------------------------------------------------------
# Deployment shape the connection budget is sized against
#
# Two constants describing how many processes will exist, and two describing what the
# database can serve. They are not tuning knobs: they are the inputs to the inequality
# asserted below, and the reason POOL_SIZE and MAX_OVERFLOW hold the values they do. See
# "The connection budget is a deployment-wide sum" in the module docstring.
# ---------------------------------------------------------------------------------------

MAX_WORKERS_PER_REPLICA: Final[int] = 4
"""The MAXIMUM Gunicorn worker processes one container may run, not the number it ships with.

Each worker imports this module, so each builds its own engine and its own pool -
:data:`engine` is per process, never per container. This value is the *supported ceiling*: the
budget asserted below is sized so that four workers per replica still fit, which is what makes
scaling up to four a configuration change rather than a code change.

``backend/Dockerfile``'s ``CMD`` ships **two**, deliberately, and an operator raises it through
``GUNICORN_CMD_ARGS`` or by replacing the container's command. So the deployment as shipped runs
comfortably inside this budget rather than at it, and that headroom is the point: an operator who
doubles the workers to meet load must not also have to re-derive a connection budget. Raising the
count *past* this ceiling without re-deriving the budget is precisely the mistake the import-time
assertion exists to catch.
"""

MAX_REPLICAS: Final[int] = 2
"""Container replicas this budget is sized for.

Two rather than one, because a single replica cannot be restarted without downtime and any
rolling deployment briefly runs both the outgoing and the incoming container - so two is
the floor for ordinary operation rather than a scale-out ambition. It is stated here so
that the connection demand of the *deployment* is computable from this file instead of
being an assumption held somewhere else.
"""

RESERVED_CONNECTIONS: Final[int] = 20
"""Connections deliberately left unclaimed by the application pools.

Not slack. Four distinct consumers need a connection at exactly the moments the application
is busiest: ``alembic upgrade head`` on container start, the ``/readyz`` probe's trivial
query, an operator's ``psql`` session during an incident, and PostgreSQL's own
``superuser_reserved_connections`` (three by default) which is subtracted from
``max_connections`` before an ordinary client ever connects. A budget that consumed the
whole limit would lock all four out at the one moment each of them matters.
"""

ASSUMED_MAX_CONNECTIONS: Final[int] = 100
"""The server-side ``max_connections`` this deployment requires as a floor.

One hundred is PostgreSQL's own default and is what ``docker-compose.yml``'s ``db`` service
therefore provides unconfigured, so the budget below is satisfied by an out-of-the-box
server. It is stated as an assumption rather than read from the database because it has to
be checkable at import time, before any connection exists - and because a service must not
size its pool from a value it discovers only after connecting.

Raising this constant is a claim about the server, not a change to it. Raise
``max_connections`` on PostgreSQL first; only then is a larger value here true.
"""


# ---------------------------------------------------------------------------------------
# Pool policy
#
# Named constants, each documented with the reasoning behind its value, so that the pool is
# configured explicitly instead of inheriting whatever the library defaults to. They are
# deliberately NOT settings fields - see "Pool policy without new configuration" in the
# module docstring for why adding an environment key here would break the .env.example
# contract that four other files are written against.
# ---------------------------------------------------------------------------------------

POOL_SIZE: Final[int] = 3
"""Connections each process keeps open once they have been established.

Sized against the whole deployment rather than against one process, because every worker in
every replica builds its own pool - so the figure the database sees is
``MAX_REPLICAS x MAX_WORKERS_PER_REPLICA x (POOL_SIZE + MAX_OVERFLOW)``, which
:data:`PEAK_APPLICATION_CONNECTIONS` computes and the assertion below enforces.

Three, not five: a request holds one connection for one short request-scoped session, so
three retained connections serve three concurrent requests per worker and twelve per
container, and a pool larger than the concurrency a process can drive only holds idle
connections that consume the deployment's headroom.
"""

MAX_OVERFLOW: Final[int] = 2
"""Extra connections permitted above :data:`POOL_SIZE` while a burst is in flight.

Overflow connections are opened on demand and closed again when they are returned, so they
absorb a spike without paying to hold five idle connections for the rest of the process's
life.

Two rather than ten, and the reason is arithmetic rather than taste: overflow counts against
``max_connections`` exactly as pooled connections do, and it is permitted *simultaneously in
every worker of every replica*. At ten the ceiling was ``2 x 4 x 15 = 120`` connections for
an ordinary two-replica deployment - above PostgreSQL's default limit of 100 before a single
migration, probe or operator session, which is the defect this value corrects. Five per
worker keeps the peak at 40 and leaves :data:`RESERVED_CONNECTIONS` intact.
"""

WORKER_CONNECTION_CEILING: Final[int] = POOL_SIZE + MAX_OVERFLOW
"""The most connections one worker process can hold at once.

``POOL_SIZE`` retained plus ``MAX_OVERFLOW`` opened on demand. Derived rather than written
out, so it cannot drift from the two values it is the sum of.
"""

PEAK_APPLICATION_CONNECTIONS: Final[int] = (
    MAX_REPLICAS * MAX_WORKERS_PER_REPLICA * WORKER_CONNECTION_CEILING
)
"""The most connections the whole deployment can demand of PostgreSQL at once.

The product every capacity question is actually about: replicas times workers times the
per-worker ceiling. This is the number to compare against the server's ``max_connections``,
and the per-worker figure is never the number to compare.
"""

REQUIRED_MAX_CONNECTIONS: Final[int] = PEAK_APPLICATION_CONNECTIONS + RESERVED_CONNECTIONS
"""The minimum server-side ``max_connections`` this deployment needs.

The operational requirement in one value: PostgreSQL must permit at least this many
connections for the configuration in this module to be safe. Exported so that an operator,
a deployment document or a readiness check can state the requirement by importing it rather
than by reconstructing it from four constants - and so that the module docstring's table and
this value can never disagree.
"""


def _assert_within_connection_budget() -> None:
    """Fail the import unless the deployment's peak demand fits the server's limit.

    Called once, immediately below, before :data:`engine` is constructed - so a
    configuration that cannot fit its database is a startup failure carrying the arithmetic,
    not an intermittent ``FATAL: sorry, too many clients already`` under load. It is the
    same fail-closed treatment ``app.core.config`` gives a signing key shorter than 32
    characters: a value that cannot be correct stops the process rather than degrading it.

    The check is pure arithmetic over module constants, so it costs nothing at import, needs
    no database, and cannot be skipped by an environment - which is exactly what makes it
    enforcement rather than documentation. ``alembic``, ``mypy`` and the test suite all
    import this module without a reachable server and all exercise it.

    Raises:
        RuntimeError: The peak demand plus the reserved allowance exceeds
            :data:`ASSUMED_MAX_CONNECTIONS`. The message names every term, so the reader is
            told which constant to change and in which order - raise the server's
            ``max_connections`` first, then :data:`ASSUMED_MAX_CONNECTIONS`, then the
            scaling constant that prompted it.
    """
    if REQUIRED_MAX_CONNECTIONS > ASSUMED_MAX_CONNECTIONS:
        raise RuntimeError(
            "Database connection budget exceeded: "
            f"{MAX_REPLICAS} replicas x {MAX_WORKERS_PER_REPLICA} workers x "
            f"(POOL_SIZE {POOL_SIZE} + MAX_OVERFLOW {MAX_OVERFLOW}) = "
            f"{PEAK_APPLICATION_CONNECTIONS} application connections, plus "
            f"{RESERVED_CONNECTIONS} reserved for migrations, health probes and operator "
            f"sessions, requires max_connections >= {REQUIRED_MAX_CONNECTIONS}, but "
            f"ASSUMED_MAX_CONNECTIONS is {ASSUMED_MAX_CONNECTIONS}. Raise PostgreSQL's "
            "max_connections first, then ASSUMED_MAX_CONNECTIONS to match it, then the "
            "scaling constant that prompted this."
        )


_assert_within_connection_budget()

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

CONNECT_TIMEOUT_SECONDS: Final[int] = 5
"""How long one attempt to establish a connection may take before it is abandoned.

An availability bound rather than tuning - see "Every failure mode is bounded in time" in
the module docstring for the measurement this value comes from. Left unset, psycopg falls
back to libpq's own default of 130 seconds
(``psycopg.conninfo._DEFAULT_CONNECT_TIMEOUT``), which is what a *hung* server - one that
completes the TCP handshake and then never answers - costs every attempt. Five seconds is
comfortably above psycopg's two-second floor (values below it are raised to two), far above
the sub-millisecond connect a healthy local database needs and the low milliseconds a
same-network one needs, and low enough that ``/readyz`` answers inside any orchestrator's
probe timeout.
"""

POOL_TIMEOUT_SECONDS: Final[float] = 5.0
"""How long a caller may wait for a pooled connection before the checkout fails.

The second half of the same bound. :data:`CONNECT_TIMEOUT_SECONDS` limits one connection
attempt; this limits the wait for a *slot* in which to make one, which is the delay a
caller sees once all :data:`WORKER_CONNECTION_CEILING` connections are already committed.
SQLAlchemy's default is 30 seconds, so an outage that occupies every slot would queue
callers for half a minute on top of whatever the attempt itself costs.

Five seconds keeps the worst case a caller can observe at roughly ten - one full wait for a
slot plus one full connection attempt - and that arithmetic is the reason both values are
equal. It is also the right shape for this service rather than a compromise: a request here
holds its connection for one short unit of work (the feed is two statements plus two
batched loaders, every mutation is one transaction that commits and ends), so a caller that
has been waiting five seconds for a slot is not queued behind normal traffic. Failing it
fast applies back-pressure and frees the caller; queueing it for thirty seconds converts a
database problem into a pile of stalled requests.
"""

STATEMENT_TIMEOUT_SECONDS: Final[int] = 10
"""Server-side ceiling on how long any one statement may run before PostgreSQL cancels it.

The bound on a *stalled statement*, which :data:`CONNECT_TIMEOUT_SECONDS` and
:data:`POOL_TIMEOUT_SECONDS` cannot reach - see "A statement that stalls is bounded too" in
the module docstring. Applied through libpq's ``options``, so the server enforces it and a
caller receives ``57014 query_canceled`` rather than waiting on a backend that will never
answer.

Ten seconds is deliberately **generous**, and the generosity is the point. One number governs
every statement this engine runs, including ``app.db.seed``'s inserts, so it has to sit far
above the slowest legitimate one rather than near it: every query in this service is a short
unit of work - the feed is two statements plus two batched loaders, and each mutation is one
transaction that commits and ends - and the whole 1370-test suite, seeding included, runs
under this ceiling with no statement coming close to it. A tight ceiling would convert an
ordinary slow moment into a failed request; this one converts an *indefinite* wait into a
bounded failure, which is the actual defect being closed. A caller that needs a promise
tighter than this imposes its own deadline, as ``app.api.v1.routers.health.readiness`` does.

It does **not** apply to migrations, and that exclusion is enforced by which factory a
migration uses rather than by a convention. ``backend/migrations/env.py`` builds its own
synchronous engine from :func:`migration_connect_args`, which carries every other invariant
below and deliberately omits this one, so a long ``CREATE INDEX`` on a populated table is
unaffected by a value chosen for request-time statements. Handing a migration the request-path
ceiling would cancel a legitimate index build with ``57014`` and abort the upgrade on the
container's start-up path - see that function for the full account. This is also exactly why the
ceiling belongs here, on a per-connection factory, rather than in a server-wide setting no
workload could opt out of.
"""

STATEMENT_TIMEOUT_MILLISECONDS: Final[int] = STATEMENT_TIMEOUT_SECONDS * 1000
"""The same ceiling in the unit PostgreSQL applies to a bare integer.

Derived rather than restated, so the two can never disagree: ``SET statement_timeout = 10``
means ten *milliseconds*, and writing the seconds value straight into the ``options`` string
would silently impose a bound a thousand times tighter than the one documented above. ``SHOW
statement_timeout`` reports the result as ``10s``.
"""

TCP_KEEPALIVE_ARGS: Final[dict[str, str]] = {
    # Enable kernel keepalive probes on the connection socket.
    "keepalives": "1",
    # Idle seconds before the first probe. Short, because this is a request path: ten seconds
    # of silence on a connection that is supposed to be answering a query is already wrong.
    "keepalives_idle": "10",
    # Seconds between probes once one has gone unanswered.
    "keepalives_interval": "5",
    # Unanswered probes before the socket is declared dead. 10 + 3x5 gives a worst case of
    # roughly 25 seconds to abandon a connection whose peer has stopped answering entirely.
    "keepalives_count": "3",
}
"""libpq keepalive parameters, spelled as strings because that is how libpq receives every
keyword.

The complement to :data:`STATEMENT_TIMEOUT_SECONDS`, and needed because that value is enforced
by the *server*: if the path to the server is gone, PostgreSQL cancels the statement and the
cancellation never arrives, so a client-side mechanism is the only thing that can end the wait.
These four make the kernel probe the peer and fail the socket when the probes go
**unacknowledged**, which is what bounds a partition rather than a slow query.

Precision matters about what that covers. A keepalive probe is answered by the peer's *kernel*,
so this ends a connection whose host has gone - crashed, partitioned away, or had its route
withdrawn - and it does not end one whose kernel still acknowledges while the server process
answers nothing. That case is bounded by the server-side ceiling above when the server is running
its own timer, and is discussed honestly in
``app.api.v1.routers.health.READINESS_TIMEOUT_SECONDS`` for the case where nothing on the client
can bound it.

Values are chosen for a request path rather than for a long-lived analytics connection: a
worst case of about twenty-five seconds to declare an unreachable peer dead, against libpq's own
default of no keepalives at all and the operating system's much longer defaults when they are
enabled without tuning.
"""


HIDE_PARAMETERS: Final[bool] = True
"""Whether bound parameter values are withheld from anything an engine logs or raises.

Shared by all three engine owners - see "Three processes open connections to this database"
in the module docstring - because it is a property of what a *statement* may reveal and not
of how a pool behaves. SQLAlchemy otherwise interpolates the bound values into the line it
logs and into the message it attaches to a wrapped ``DBAPIError``, and in this schema those
values are the data itself: an email address, a password hash, a refresh-token digest, the
body of an unpublished draft. With this on the statement is still reported whole and the
values are replaced by a fixed marker.

It is deliberately not staged on ``ENVIRONMENT``. "Development" is a laptop attached to a
real database at least as often as it is a throwaway one, and a migration run or a test
session is exactly where a developer pipes output to a file and forgets it.
"""


def _connection_invariants() -> dict[str, str]:
    """Return the libpq connect arguments every engine in this project must open with.

    The shared half of the connection contract, and the whole of what a *migration* needs:
    the session time zone, the bound on one connection attempt, and the keepalive group. What
    is deliberately absent is the request-path statement ceiling, which
    :func:`safe_connect_args` adds on top and :func:`migration_connect_args` does not - see
    "One of them travels with the request path only" in the module docstring.

    Private because a caller should always be naming a workload rather than assembling one:
    both public factories below are built from this, so there is one definition of the shared
    invariants and two documented choices about the ceiling, rather than three engines each
    deciding for themselves.

    Returns:
        A new mapping carrying ``options`` (the ``-c timezone`` setting alone),
        ``connect_timeout`` and the four keepalive keywords.
    """
    return {
        # A libpq options string, forwarded by psycopg at connection time, so the setting is
        # established before the first statement and costs no extra round trip. `-c timezone=UTC`
        # is `SET TIME ZONE 'UTC'` without needing a statement, an event listener or a checkout
        # hook to issue it. Each public factory extends THIS string rather than replacing it -
        # overwriting it is how the time zone would silently be lost while a timeout test still
        # passed, which is the regression
        # `tests/integration/test_db_session_config.py` pins.
        "options": f"-c timezone={SESSION_TIME_ZONE}",
        "connect_timeout": str(CONNECT_TIMEOUT_SECONDS),
        **TCP_KEEPALIVE_ARGS,
    }


def safe_connect_args() -> dict[str, str]:
    """Return the libpq connect arguments a REQUEST-PATH engine must open with.

    The shared invariants plus :data:`STATEMENT_TIMEOUT_MILLISECONDS`. Used by the application
    engine below and by ``backend/tests/conftest.py``'s session engine, because the suite drives
    the same routes the request path does and must therefore be bounded the same way. Alembic
    calls :func:`migration_connect_args` instead.

    A pure function of module constants: it reads no environment variable, opens nothing,
    and depends on no pool, which is what lets the two non-application engine owners -
    ``backend/migrations/env.py`` and ``backend/tests/conftest.py`` - call into this module as
    freely as the engine below does. A **fresh** dictionary is returned on every call rather than
    one shared module-level mapping, so an engine that mutates what it is handed (or a caller
    that adds a key of its own) cannot reach into another engine's configuration.

    Every entry is a requirement rather than tuning:

    ``options``
        A libpq options string, forwarded by psycopg at connection time, so both settings are
        established before the first statement and cost no extra round trip. It is composed by
        extending the shared string :func:`_connection_invariants` returns, not by replacing it.
        ``-c timezone=UTC`` is ``SET TIME ZONE 'UTC'`` without needing a statement, an event
        listener or a checkout hook to issue it, and ``-c statement_timeout`` is
        ``SET statement_timeout`` on the same terms. See "Every connection speaks UTC" and
        "A statement that stalls is bounded too" in the module docstring for the
        measurements, :data:`SESSION_TIME_ZONE` for the one value and
        :data:`STATEMENT_TIMEOUT_MILLISECONDS` for the other - which is why the ceiling is
        derived in milliseconds rather than written in seconds.

    ``connect_timeout``
        A libpq connection parameter, spelled as a string because that is how libpq
        receives every keyword; psycopg parses it back to an integer itself. The default it
        replaces is 130 seconds, and leaving that in place is what turns a *hung* database
        into an outage rather than a fast failure - for a migration on a container's startup
        path just as much as for a request. See :data:`CONNECT_TIMEOUT_SECONDS`.

    the keepalive group
        Bounds the one failure neither timeout above can reach: an already-established
        connection whose peer has stopped acknowledging at all. See
        :data:`TCP_KEEPALIVE_ARGS`, which is explicit about what that does and does not
        cover.

    Nothing else is passed. There is no connection pooler in front of PostgreSQL in this
    deployment, so prepared-statement or statement-cache tuning would be speculative.

    Returns:
        A new mapping suitable for ``connect_args=`` on either
        :func:`~sqlalchemy.ext.asyncio.create_async_engine` or
        :func:`~sqlalchemy.create_engine`. Both reach the same psycopg 3 driver, because
        AAP §0.5.6 excludes ``asyncpg`` and this project has exactly one driver, so one
        mapping serves the asynchronous application and the asynchronous test session alike.
    """
    args = _connection_invariants()
    # EXTENDED, never replaced. The two `-c` settings share one libpq option string, so assigning
    # a new value here instead of appending to the existing one would drop the session time zone
    # and leave every stored and returned instant interpreted in the server's local zone - a
    # failure no assertion about the timeout would notice.
    args["options"] = f"{args['options']} -c statement_timeout={STATEMENT_TIMEOUT_MILLISECONDS}"
    return args


def migration_connect_args() -> dict[str, str]:
    """Return the libpq connect arguments the ALEMBIC engine must open with.

    Exactly :func:`_connection_invariants` - the session time zone, the five-second bound on one
    connection attempt, and the keepalive group - and deliberately **no**
    ``statement_timeout``. It is the counterpart of :func:`safe_connect_args`, and the single
    difference between them is the whole reason both exist.

    Why the request ceiling must not reach a migration
    -------------------------------------------------
    :data:`STATEMENT_TIMEOUT_SECONDS` is ten seconds because no *request* in this service has any
    business running longer. A migration is not a request. ``0002`` builds seven GIN and trigram
    indexes and ``0004`` builds three B-trees, and an ordinary ``CREATE INDEX`` over a populated
    relation can legitimately exceed ten seconds - at which point PostgreSQL cancels it with
    ``57014 query_canceled``, Alembic sees the revision fail, the whole upgrade rolls back, and in
    the container the failing step is the one that runs *before* the service starts. The ceiling
    would therefore convert successful maintenance into a failed deployment, and it would do so
    only on databases with data in them: an empty database builds every index in milliseconds, so
    a fresh-database test cannot see it.

    What the migration engine still keeps, and why each matters more here than anywhere
    ----------------------------------------------------------------------------------
    ``connect_timeout``
        This run sits on the container's start-up path, so libpq's 130-second default is what
        turns an unreachable database into a stalled deployment rather than a fast, legible
        failure.
    the session time zone
        ``0003`` inserts rows, and every timestamp column in this schema is ``timestamptz``. A
        migration writing under the server's local zone would store instants the application
        then reads as UTC.
        (:data:`HIDE_PARAMETERS`, passed separately by the engine owner, is what keeps those
        bound row values out of ``--sql`` output and CI logs.)
    the keepalive group
        A long index build is exactly the window in which a peer can disappear without closing
        the socket, and the server-side ceiling this factory omits is precisely the mechanism
        that would otherwise have bounded it.

    Returns:
        A new mapping suitable for ``connect_args=`` on :func:`~sqlalchemy.create_engine`,
        carrying no statement ceiling. ``backend/migrations/env.py`` is its only caller;
        ``backend/tests/integration/test_db_session_config.py`` asserts the absence, because
        "no ceiling" is a guarantee that leaves no trace in a passing migration.
    """
    return _connection_invariants()


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
    # the data. Taken from the shared invariant rather than spelled here, because the
    # migration and test engines must open with the same guarantee - see
    # :data:`HIDE_PARAMETERS`.
    hide_parameters=HIDE_PARAMETERS,
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
    # Explicit rather than inherited, because the default is 30 seconds and the value
    # decides how long a caller waits for a slot once the pool is fully committed - which is
    # exactly the state a database outage produces. See :data:`POOL_TIMEOUT_SECONDS`.
    pool_timeout=POOL_TIMEOUT_SECONDS,
    # Every connect argument is a requirement rather than tuning. The session time zone is
    # part of the wire contract ("Every connection speaks UTC"); the connect timeout bounds a
    # failure mode whose default is 130 seconds ("Reaching the database is bounded in time");
    # and the statement timeout plus the keepalive group bound the mode neither of those can
    # reach, a statement that stalls on an established connection ("A statement that stalls is
    # bounded too"). Nothing further is passed: this deployment puts no connection pooler in
    # front of PostgreSQL, so prepared-statement or statement-cache tuning would be
    # speculative. Called rather than referenced, so this engine holds its own mapping and the
    # migration and test engines - which call the same function - hold theirs.
    connect_args=safe_connect_args(),
)
"""The one engine this process owns, and the pool behind every session it hands out.

Built at import time and never rebuilt. An engine *is* a pool, so a second one would double
the connections this process holds against the database while halving the reuse each of
them gets - and it would do so outside the budget :func:`_assert_within_connection_budget`
enforces, which counts one engine per process and nothing more. Construction is pure
bookkeeping - the first connection is established when a session first needs one - which is
what lets ``backend/tests/conftest.py`` and ``alembic check`` import this module with no
database reachable.

It holds at most :data:`WORKER_CONNECTION_CEILING` connections, and the deployment holds at
most :data:`PEAK_APPLICATION_CONNECTIONS` across every worker of every replica.

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
