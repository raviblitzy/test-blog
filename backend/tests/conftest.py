"""Root fixtures for the backend test suite: environment, schema, transaction, client, identity.

Every module under ``backend/tests/unit/`` and ``backend/tests/integration/`` sees these
fixtures without importing anything, because pytest loads the ``conftest.py`` nearest each
test file and this one sits at the root of the tree. That reach is why the wiring below is
written out at length rather than left to be inferred: a mistake here does not fail one
test, it either fails every integration test at once or - far worse - lets rows leak between
tests so that the suite's result depends on collection order.

Five things happen in this file, in this order, and the order is load-bearing:

1. the process environment is populated **before** anything from ``app`` is imported;
2. the test database is created if absent and migrated to head by **Alembic**;
3. one session-scoped async engine is opened with :class:`~sqlalchemy.pool.NullPool`;
4. every test gets a session inside a transaction that is **rolled back** afterwards;
5. an in-process HTTP client is bound to that same session through
   ``app.dependency_overrides``.

No user rules govern this file
------------------------------
``review_rules`` returns ``No user rules provided.`` - a complete response, not a truncated
window - so **no user-specified rule governs this file and no rule placed it in scope**. It
is in scope solely by the Agent Action Plan's file inventory (§0.4.4.5) and execution plan
(§0.7.1.11). Nothing here is invented to fill that gap, and the absence of rules is not
treated as licence to lower the bar: the substitute standard is the AAP's own §0.10.1
enterprise standards, four of which this file discharges directly.

* **§0.10.1 #8, blocking quality gates.** The gate is
  ``pytest backend/tests --cov=backend/app --cov-fail-under=80``, and this file is what makes
  it runnable: no live server (the client speaks ASGI in-process), no cross-test
  contamination (one transaction per test, rolled back), and no order dependence - running
  the suite twice, or one test alone, or with ``-p no:randomly``, gives the same result.
* **§0.10.1 #7, reversible schema evolution.** The schema is built by running the revision
  chain, never by ``Base.metadata.create_all()``. Every test session therefore exercises the
  migrations, so a broken revision fails the whole suite rather than only the dedicated
  migration gate.
* **§0.10.1 #12, configuration from the environment only.** Configuration is supplied by
  populating :data:`os.environ` before ``app.core.config`` is imported. Nothing here
  monkeypatches ``settings``, mutates it in place, or hard-codes a URL inside an application
  module.
* **§0.10.1 #13, no secrets in the repository.** Every credential below is an obviously fake
  placeholder - no real password, no deployment host, no working connection string.

1. Why the environment bootstrap has to come first
--------------------------------------------------
``app.core.config`` builds its ``settings`` singleton **at import time**, and six of its
twelve variables have no default at all: ``DATABASE_URL``, ``JWT_SECRET_KEY``,
``CORS_ALLOW_ORIGINS``, ``ENVIRONMENT``, ``SEED_ADMIN_EMAIL`` and ``SEED_ADMIN_PASSWORD``.
``JWT_SECRET_KEY`` is additionally held to a per-algorithm byte floor - 32 for ``HS256``,
48 for ``HS384``, 64 for ``HS512`` - because that is the length PyJWT itself measures
(RFC 7518 §3.2). Importing ``app.main``, ``app.core.security``, ``app.core.dependencies``,
``app.db.session`` or even ``tests.factories`` reaches that module transitively, so any one
of those imports **fails outright** on a machine whose environment is not already populated,
and the failure arrives during collection as a wall of ``Field required`` errors that names
none of the fixtures below.

Hence the shape of this file: a bootstrap block of plain module-level statements, then the
``app.*`` imports, each carrying a narrow ``# noqa: E402``. The suppression is per-import and
deliberate - ``E402`` is exactly right in general and exactly wrong here, and the sibling
``backend/pyproject.toml`` is not modified to accommodate one file.

The bootstrap has **two halves**, and which half a variable belongs to is a decision about
what a test run is allowed to inherit rather than a convenience.

:data:`_ENVIRONMENT_OVERRIDES` is **assigned**, unconditionally, so an ambient value cannot
survive into the suite. Four names are in it - the deployment stage and the three
credentials - because an inherited value for any of them stops the run being a test run:

``ENVIRONMENT=test`` is functional, and it is not negotiable
    ``app.core.rate_limit`` constructs its limiter with ``enabled=settings.ENVIRONMENT !=
    "test"``. Without this value the authentication suite - which registers, logs in,
    refreshes and logs out repeatedly - trips the five-per-minute limit and returns ``429``
    intermittently, which is precisely the flakiness a blocking gate cannot tolerate. It also
    keeps the documentation routes served: ``app.main`` withdraws ``/docs`` and ``/redoc``
    only when ``settings.is_production``, so under ``test`` the OpenAPI surface the contract
    test asserts against is still mounted, as AAP §0.9.4.3 requires. And it selects the
    logging profile, the HSTS decision and the credential-placeholder gate. A shell or a CI
    job that happened to export ``ENVIRONMENT=production`` or ``staging`` - from a deployment
    step earlier in the same pipeline, say - would silently turn every one of those into a
    deployment behaviour, so this value is **written over** whatever arrived rather than
    defaulted. The same reasoning covers ``JWT_SECRET_KEY``, ``SEED_ADMIN_EMAIL`` and
    ``SEED_ADMIN_PASSWORD``: a suite that signed its tokens with, or seeded, a deployment
    credential would both be non-deterministic and be handling a real secret, and neither is
    acceptable in a test process. The three values used instead are the obviously fake
    placeholders declared below.

The remaining seven are installed with :meth:`os.environ.setdefault`, so CI, a ``Makefile``
target or a developer's shell can still tune them. None of them selects a profile or carries
a credential - they are the algorithm, the two token lifetimes, the origin list, the log
threshold, the rate-limit expression and the request-body ceiling - so an inherited value
changes what a test measures without changing what it is:

The resolved ``DATABASE_URL`` is neither: it is **assigned**, from a value that has been
authorised first, for the reason in section 2.

2. The test database is derived, authorised, and only then used
--------------------------------------------------------------
``.env.example`` is a closed contract, and adding a further documented variable would
desynchronise it from ``README.md``, ``docker-compose.yml`` and ``.github/workflows/ci.yml``.
So the target database is resolved in two steps instead:

* if ``TEST_DATABASE_URL`` is set in the environment, it names the candidate - but it is
  **never taken verbatim**; it is held to every rule the derivation is held to. It is not declared
  on ``Settings``, and because ``pydantic-settings`` looks up declared field names rather
  than enumerating the environment, an undeclared key in :data:`os.environ` passes the
  model's ``extra="forbid"`` untouched. (That tolerance covers the *environment* only - the
  name must never be written into a ``.env`` file, where the dotenv source would enumerate
  it and the model would refuse to start.)
* otherwise ``DATABASE_URL`` is parsed with :func:`sqlalchemy.engine.make_url` and a sibling
  database name is derived by appending ``_test`` and this process's isolation tags,
  idempotently: a name that already carries them is left alone, so a re-run cannot produce
  ``blog_test_test``. See section 2.2 for the tags.

**Neither candidate is trusted.** A candidate is a string from the environment, and this
suite is about to create a database from it, run every migration against it, write to it, and
- on request - drop it. So :func:`_authorise_test_target` runs *before* the value is assigned
anywhere and before any connection is opened, and it fails the run rather than proceeding on
anything it cannot prove is a disposable test database:

* the URL must parse, and its driver must be exactly ``postgresql+psycopg`` - the project's
  single driver;
* it must name a database at all, and that name must contain :data:`_TEST_DATABASE_MARKER`,
  which is the coarse half of the rule and gives the friendlier diagnosis;
* the name must **end in** :data:`TEST_DATABASE_SUFFIX`, optionally followed by the isolation
  tags - :func:`_is_dedicated_test_database`. A *suffix* rather than a substring: ``latest``,
  ``contest`` and ``latest_events`` all contain ``test`` and are perfectly ordinary database
  names, so a containment check is no guard on its own;
* the name must match :data:`_IDENTIFIER_PATTERN`, a conservative unquoted-identifier grammar,
  and must be at most 63 bytes - PostgreSQL's own limit, past which it truncates silently,
  which would make an authorised name and the created database two different things. That
  grammar is also what makes the two ``DATABASE`` maintenance statements safe to build
  (section 2a);
* the host must be one this file recognises as local - the loopback spellings, the empty
  Unix-socket host, and the ``db``/``database``/``postgres``/``postgresql`` service names this
  project's own Compose file and CI workflow use. Anything else is refused unless
  ``TEST_DATABASE_ALLOW_REMOTE_HOST`` is set, which is the explicit opt-in for the one
  legitimate case: a managed test database that really is elsewhere.

An override is held to two further rules, because it is the only value that can point this
suite somewhere the derivation never would:

* it may not name the database ``DATABASE_URL`` itself names, when that database is not
  already a dedicated one. Exporting ``TEST_DATABASE_URL`` equal to the working URL "to just
  run it against my data" is the mistake that actually happens, and it is refused by name
  rather than by a naming rule;
* and it may only redirect the **database**, never the server. Its host and port must equal
  the ones ``DATABASE_URL`` already names, so the only server this suite can reach is the one
  the surrounding configuration already points at. Pointing the suite at a different server is
  done the way ``.env.example`` documents - by setting ``DATABASE_URL`` to that server - which
  keeps one value in charge of *where* and leaves ``TEST_DATABASE_URL`` in charge only of
  *which database there*, unless the remote opt-in above says otherwise.

Every one of those checks is reported without quoting the URL, because a connection URL
carries a password, and every one of them names the action it refused.

The authorised URL is then **assigned** to ``os.environ["DATABASE_URL"]``, and that single
assignment redirects both consumers at once: the engine this file opens, and
``migrations/env.py``, because ``backend/alembic.ini`` deliberately declares no
``sqlalchemy.url`` and the environment script reads ``settings.DATABASE_URL`` instead.

Deriving rather than reusing is a safety property, not a convenience, and authorising rather
than deriving-and-hoping is what makes the property hold when the derivation is overridden.
Together they are what guarantees the suite cannot create, migrate, write to or drop
anything but a dedicated ``*_test`` database on a server it was authorised to reach.

2a. The same gate governs create, migrate, use and drop
-------------------------------------------------------
One authorised answer is not enough, because four separate paths act on the database and each
reads ``settings.DATABASE_URL`` when it runs: :func:`_ensure_test_database_exists` issues
``CREATE DATABASE``, :func:`_upgrade_to_head` runs every revision, :func:`engine` opens the
connections the tests write through, and :func:`_drop_test_database` issues ``DROP DATABASE
... WITH (FORCE)``. So each of them calls :func:`_authorise_test_target` first, which
re-applies the identical checks to the value in force at that moment. ``settings`` is
deliberately not frozen, so a test that mutated the setting, a fixture ordering that changed,
or a future edit that assigned it again cannot route any of the four at an unvetted target.

The two ``DATABASE`` statements need a further step, because a database name cannot be a bind
parameter - it is an identifier, so it has to be written into the statement text. It is
therefore quoted by the PostgreSQL dialect's own identifier preparer rather than by wrapping
it in double quotes here. The grammar above already makes a quote character unrepresentable,
so this is the second of two independent guards rather than the only one: with both in place,
an environment-derived value cannot terminate the identifier and append SQL of its own to an
``AUTOCOMMIT`` maintenance connection.

2.2 One database per clone, per worker
--------------------------------------
``<base>_test`` alone is not an isolated name, it is a *shared* one. This platform runs
independent clones of the repository in parallel against one PostgreSQL server and documents
``CLONE_INDEX`` as the discriminator for every host-global resource; a database is exactly
such a resource. Two clones landing on one name do not fail cleanly - they race
``alembic upgrade head`` against each other, collide on the deterministic case-insensitive
values ``tests.factories`` generates, share one transaction's worth of visibility, and either
one can ``DROP DATABASE … WITH (FORCE)`` the other's live session out from under it.

So the derived name carries two tags, both sanitised to ``[a-z0-9]`` and both omitted when
absent:

* ``CLONE_INDEX`` - this checkout's identity on the shared host;
* ``PYTEST_XDIST_WORKER`` - the per-process identity ``pytest-xdist`` exports (``gw0``,
  ``gw1``, …). ``xdist`` is not currently a dependency, so this is normally absent; it is
  read anyway because the day it is added, the name has to change on its own rather than
  after a day of debugging duplicate-key failures.

With no tags set the name is ``blog_test``, exactly as before, so a single developer's
workflow is unchanged. ``TEST_DATABASE_URL`` still wins outright, because a caller naming a
database explicitly has already decided the question - it is only *authorised*, never
rewritten. The naming rule accepts the tags: a name must end in ``_test`` optionally followed
by those lowercase-alphanumeric groups, which is why ``blog_test_w037`` is a dedicated test
database and ``latest_events`` is not.

Tagging the name is what makes two clones independent; it is not what makes the lifecycle
safe when they start at the same instant. Creating a database, and running a migration chain
against one that may have just been created, both need a single owner. So
:func:`_database_lifecycle_lock` wraps create-and-migrate and the optional drop in an
:mod:`fcntl` advisory lock on a file named for the resolved database, in the system temporary
directory. Processes targeting *different* databases never contend; processes targeting the
*same* one serialise, and the second finds the schema already at head and applies nothing.

3. Alembic builds the schema; ``create_all()`` cannot
----------------------------------------------------
``Base.metadata.create_all()`` is not merely discouraged here, it is incapable of producing
this schema:

* ``users.email``, ``users.username``, ``categories.slug`` and ``posts.slug`` are ``CITEXT``,
  and the extension that supplies the type is installed by revision ``0001``;
* ``posts.search_vector`` is ``GENERATED ALWAYS AS (...) STORED``, and it - together with its
  GIN and ``gin_trgm_ops`` indexes - is added by revision ``0002``.

So the session-scoped :func:`database_schema` fixture creates the database if it is absent
and then runs ``alembic upgrade head`` programmatically, with ``script_location`` set
explicitly from :data:`__file__` so the run does not depend on the working directory. The
chain is currently ``0001 → 0002 → 0003``; the fixture asks for ``head`` and never names a
revision, so a fourth revision is picked up with no change here.

**The database is never empty.** Revision ``0003_seed_reference_categories`` inserts eight
reference categories - Engineering, Architecture, Backend, Frontend, Databases, DevOps,
Security and Product - as *data*. They are committed by the migration, not by a test, so
per-test rollback does not remove them and they are present for the whole session. Any
assertion about ``categories`` must therefore be phrased as "contains" or "at least", never
as "the database is empty" or "there is exactly one category".

Teardown leaves the database in place, which makes a re-run fast. Dropping it is opt-in
through ``TEST_DATABASE_DROP``, and the drop refuses to run unless the resolved database name
**ends with** ``_test`` - the same rule, through the same predicate, that admitted the URL in
the first place - so no configuration mistake can point a ``DROP DATABASE ... WITH (FORCE)`` at
a working database.

The schema fixture is **not** autouse, and that too is a correctness property rather than a
preference: every module under ``tests/unit/`` declares that it touches neither the database nor
the network, and autouse would have every one of them create a database and run the revision
chain before its first assertion. ``pytest -m unit`` therefore needs no PostgreSQL at all, and
every fixture that does reach the database declares :func:`database_schema` through
:func:`engine`.

4. The rollback contract, and the one setting it turns on
---------------------------------------------------------
:func:`db_session` opens a connection, begins a transaction on it, and binds a session to
that live connection::

    connection = await engine.connect()
    transaction = await connection.begin()
    session = AsyncSession(
        bind=connection,
        expire_on_commit=False,
        join_transaction_mode="create_savepoint",
    )

``join_transaction_mode="create_savepoint"`` is the crux of the entire file. The service
layer genuinely commits - registration, the publish transitions, comment moderation all call
``session.commit()`` because that is where the unit of work ends. Under the default join
mode the first such commit would end the *outer* transaction, and the rollback at teardown
would have nothing left to undo: rows would survive into the next test and the suite would
pass or fail according to the order it happened to run in. With ``create_savepoint``, the
session's work happens inside a ``SAVEPOINT``; a service ``commit()`` releases that savepoint
while the outer transaction stays open, and the outer transaction is discarded at teardown.
Nothing a test or a route writes ever reaches a committed state.

``expire_on_commit=False`` is the companion setting: it keeps ORM instances readable after a
commit, so a test can still inspect attributes on a row a service just persisted - and under
an async session reading an expired attribute raises ``MissingGreenlet`` rather than
returning a value, so this is a correctness requirement rather than an ergonomic one.

:class:`~sqlalchemy.pool.NullPool` on the engine is mandatory for the same family of
reasons. A session-scoped engine and function-scoped async tests must agree about their event
loop, or a pooled connection created under one loop is handed to another and awaits on a
closed one. ``NullPool`` removes the hazard structurally: each ``connect()`` opens a fresh
DBAPI connection and closes it on release, so the long-lived engine object never carries a
connection across loops. Every async fixture here additionally declares
``loop_scope="session"``, and :func:`pytest_collection_modifyitems` applies the same loop
scope to any async test that has not been marked yet.

The engine is this file's own. ``app.db.session.engine`` is deliberately left alone: it is
the pooled engine ``app.main``'s lifespan disposes, that lifespan does not run under
:class:`~httpx.ASGITransport`, and because ``get_db`` is overridden nothing ever checks a
connection out of it. Two engines, one database, and no shared pool to reason about.

5. The client, and the override that ties it to the test's session
------------------------------------------------------------------
:func:`client` installs ``app.dependency_overrides[get_db]`` with the generator
:func:`_request_scoped_get_db` builds, which yields **the very same session object the test
holds**. That identity is the point: a row the test creates through a factory is visible to
the request, a row the request creates is visible to the test afterwards, and the single
rollback undoes both. The override is removed in a ``finally`` block, because
``dependency_overrides`` is mutable state on a module-level application object and a leaked
entry would silently redirect a later test that expected the real dependency.

Sharing the object is not the same as sharing its *work*, and the difference is what the
override adds on top. Production ``get_db`` opens a session per request and rolls it back when
the request raises; a bare ``yield`` of one shared session does neither, so a request that
autoflushed and then failed - a service writing before raising ``Conflict``, a route reaching
an ownership check after a write - left that work, and any lock it held, in the session for
whatever the same test did next. So each request runs inside its own ``SAVEPOINT``, released
when the request succeeds and rolled back when it raises, which reproduces production's
per-request boundary without giving up the shared identity a separate session would have
cost.

The client is built as ``AsyncClient(transport=ASGITransport(app=...))``. httpx 0.28.1
removed the ``AsyncClient(app=...)`` shortcut, so the transport is constructed explicitly -
and this in-process transport is what lets the suite run with no server listening anywhere,
as AAP §0.4.4.5 requires.

``ASGITransport`` does not run lifespan events, and that is desirable rather than a gap:
skipping the lifespan skips ``configure_logging()`` (already applied at import), the disposal
of an engine this suite never opens, and ``warm_password_hashing()`` - whose effect is a
*timing* property rather than a behavioural one, so a lazily computed dummy hash produces the
same value and the same answers, only more slowly on the first unknown-email login. No fixture
here depends on a lifespan side effect, and none should be added; the one test that asserts on
the warm-up drives the lifespan itself rather than asking a fixture to run it.

Driving ``/readyz`` to its 503
    ``GET /readyz`` answers 503 when its ``SELECT 1`` fails, and the failure has to happen
    **after dependency resolution**, inside the readiness service - an override that raises
    would fail while the session is being resolved and surface as a 500 instead. So
    :func:`unavailable_database` installs an override that
    yields a session-shaped stand-in whose ``execute`` raises, and :func:`override_get_db` is
    the general form for any other substitution, restoring the previous entry even when the
    test fails.

6. Identity
-----------
:func:`reader_user`, :func:`author_user`, :func:`other_author_user` and :func:`admin_user`
delegate to ``tests.factories``; the second author exists because the ownership negatives in
AAP §0.9.4.4 need a principal who is neither the owner nor an administrator.

:func:`auth_headers_for` mints a token directly through
``app.core.security.create_access_token`` rather than calling the login route. That is
deliberate: it keeps every non-authentication test independent of ``POST
/api/v1/auth/login``, so a regression there fails ``test_auth_api.py`` alone instead of the
whole suite. :func:`author_client` and :func:`admin_client` are separate clients with those
headers preset - never the shared :func:`client` with its headers mutated, which would leak
credentials into every later request in the same test and quietly authenticate a case that
meant to be anonymous.

Two contract details a login helper has to respect: ``POST /api/v1/auth/login`` consumes an
OAuth2 password-grant **form**, so it must be sent as ``data=`` and never ``json=`` (this is
why ``python-multipart`` is pinned), while ``POST /api/v1/auth/refresh`` does take a JSON
body and ``POST /api/v1/auth/logout`` answers ``204``. :func:`login_form` builds the form
payload so no test has to remember which is which.

Boundaries
----------
This file defines no test. It imports neither ``app.services`` nor ``app.repositories`` -
fixtures build state through the factories and exercise behaviour through HTTP, so a failure
is never ambiguous about which layer produced it. It adds no ``__init__.py`` anywhere in the
tests tree. And one collection contract is worth restating because it is the single
documented exception to the pagination envelope: ``GET /api/v1/categories`` returns a bare
JSON array, not ``{items, total, page, page_size, pages}``, so no helper here presumes
universal pagination.
"""

from __future__ import annotations

import fcntl
import os
import re
import sys
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Final, Literal

from sqlalchemy.dialects.postgresql.base import PGDialect
from sqlalchemy.engine import URL, make_url
from sqlalchemy.sql.compiler import IdentifierPreparer

# ---------------------------------------------------------------------------------------
# Filesystem anchors
#
# This module is backend/tests/conftest.py, so parents[1] is backend/. Every path below is
# derived from __file__ and never from the process working directory, because the gate is
# invoked both ways: `pytest backend/tests` from the repository root and `pytest tests` from
# inside backend/. Both must behave identically, and a relative path would silently resolve
# against a different directory in each case.
# ---------------------------------------------------------------------------------------
_BACKEND_ROOT: Final[Path] = Path(__file__).resolve().parents[1]
_ALEMBIC_INI: Final[Path] = _BACKEND_ROOT / "alembic.ini"
_MIGRATIONS_DIR: Final[Path] = _BACKEND_ROOT / "migrations"


def _ensure_app_package_is_importable() -> None:
    """Put ``backend/`` at the front of :data:`sys.path` and evict a shadowing ``app`` module.

    Two distinct hazards, one fix each, and both are real rather than theoretical.

    The first is ordinary: ``migrations/env.py`` performs a bare ``import app.models``, and
    ``backend/alembic.ini`` prepends the *working directory* to the path, so an Alembic run
    started from the repository root has no entry that resolves the package. The sibling
    ``backend/pyproject.toml`` already supplies ``pythonpath = ["."]``, which pytest resolves
    against its rootdir - ``backend/``, since that is where the ini file lives - and inserts
    at the front. Repeating it here costs nothing and makes the schema fixture independent of
    how pytest was invoked.

    The second is specific to this repository. The repository root holds an ``app.py``
    entry-point module, so with the root ahead of ``backend/`` on the path, ``import app``
    binds a *single-file module* and ``import app.main`` then fails with ``'app' is not a
    package``. A module with no ``__path__`` cannot possibly provide ``app.main``, so if one
    is already bound under that name it is evicted here - narrowly, on exactly that test, so
    a correctly resolved package or a shim that has already rebound ``sys.modules["app"]`` to
    the package is left untouched.
    """
    backend_root = str(_BACKEND_ROOT)
    if backend_root not in sys.path:
        sys.path.insert(0, backend_root)

    shadowing = sys.modules.get("app")
    if shadowing is not None and getattr(shadowing, "__path__", None) is None:
        # Not a package, so `app.main`, `app.core.*` and `app.db.*` are unreachable through
        # it. Dropping the binding lets the next import walk sys.path again and find the
        # package under backend/.
        del sys.modules["app"]


_ensure_app_package_is_importable()


# ---------------------------------------------------------------------------------------
# The environment the suite runs under
#
# The eleven names below are the backend variables .env.example documents, minus DATABASE_URL,
# which is resolved separately. Every value is an obviously fake placeholder: nothing here is
# a real credential, a deployment host or a working connection string (AAP §0.10.1 #13).
#
# They are installed in TWO groups, and the split is a decision about what a test run may
# inherit - see "The bootstrap has two halves" in the module docstring:
#
#   _ENVIRONMENT_OVERRIDES  assigned unconditionally. The deployment stage and the three
#                           credentials. An inherited ENVIRONMENT=production or =staging
#                           would re-enable the rate limiter, withdraw the documentation
#                           routes the contract test reads, switch the logging profile and
#                           turn on HSTS, and an inherited signing key or seed credential
#                           would make the suite both non-deterministic and a handler of a
#                           real secret. None of the four may survive into a test process.
#   _ENVIRONMENT_DEFAULTS   setdefault, so CI or a shell export still wins. The algorithm,
#                           the two token lifetimes, the origin list, the log threshold, the
#                           rate-limit expression and the body ceiling: tuning, none of which
#                           decides whether this is a test run.
# ---------------------------------------------------------------------------------------

#: Obviously fake HMAC signing key, 70 bytes - comfortably above the 64-byte floor `HS512`
#: would impose, so overriding JWT_ALGORITHM in a test cannot make the key too short.
TEST_JWT_SECRET_KEY: Final[str] = (
    "test-suite-jwt-signing-key-not-a-real-secret-never-used-outside-pytest"
)

#: Obviously fake seeded-administrator password. Twelve characters minimum, at most 128, and
#: at least three of the five character classes `app.schemas.auth` counts - the same
#: policy `POST /api/v1/auth/register` applies - and deliberately not one of the placeholders
#: `.env.example` publishes, nor a variation on one, because those are refused in every stage.
TEST_SEED_ADMIN_PASSWORD: Final[str] = "Fixture-Adm1n-Never-Deployed"

#: Obviously fake seeded-administrator address. example.com is reserved by RFC 2606 §3, so it
#: can never reach a real mailbox, and it is still a valid `EmailStr`, which the field requires.
TEST_SEED_ADMIN_EMAIL: Final[str] = "seed-admin@example.com"

#: The deployment stage this suite runs as, and the only one it may run as.
TEST_ENVIRONMENT: Final[str] = "test"

_ENVIRONMENT_OVERRIDES: Final[tuple[tuple[str, str], ...]] = (
    # Functional, and assigned rather than defaulted. `app.core.rate_limit` builds its limiter
    # with `enabled=settings.ENVIRONMENT != "test"`, so this value is what stops repeated
    # authentication flows returning 429. It also keeps /openapi.json, /docs and /redoc
    # mounted (app.main withdraws them under `production`), selects the human-readable or JSON
    # logging profile, decides whether HSTS is applied, and opens the gate that otherwise
    # rejects the .env.example credential placeholders. An ambient `production` or `staging` -
    # exported by a shell, or left behind by an earlier step of the same CI job - would turn
    # every one of those into deployment behaviour inside a test process.
    ("ENVIRONMENT", TEST_ENVIRONMENT),
    # The three credentials, likewise assigned. A suite that signed its tokens with a
    # deployment signing key, or seeded a deployment administrator, would be handling a real
    # secret and would stop being reproducible; and `test_security` mints and verifies tokens
    # against whatever `settings.JWT_SECRET_KEY` holds, so an inherited key of a different
    # length or algorithm class changes what those tests exercise.
    ("JWT_SECRET_KEY", TEST_JWT_SECRET_KEY),
    ("SEED_ADMIN_EMAIL", TEST_SEED_ADMIN_EMAIL),
    ("SEED_ADMIN_PASSWORD", TEST_SEED_ADMIN_PASSWORD),
)

_ENVIRONMENT_DEFAULTS: Final[tuple[tuple[str, str], ...]] = (
    ("JWT_ALGORITHM", "HS256"),
    ("ACCESS_TOKEN_EXPIRE_MINUTES", "15"),
    ("REFRESH_TOKEN_EXPIRE_DAYS", "7"),
    # Both loopback spellings a browser treats as distinct origins, matching .env.example.
    ("CORS_ALLOW_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"),
    # Functional, and INFO rather than a quieter level on purpose. A test that asserts on what a
    # log record CONTAINS - `tests/unit/test_security.py`'s redaction suite asserts that a secret
    # does not survive into one - needs the record it emits to reach the buffer, and the level it
    # emits at is `info`. At WARNING that buffer is empty and the test fails with an `IndexError`
    # that says nothing about redaction, which is a harness artefact masquerading as a defect in
    # the module under test. It is also the level .env.example publishes, so the suite runs at the
    # threshold the service documents rather than at one invented here. The rule this file holds
    # itself to: a harness may set a shared global, but it may not NARROW one in a way only some
    # suites survive.
    #
    # The reason a quieter level was chosen originally still stands and is still honoured, just
    # not by muting the whole session: migrations/env.py routes Alembic through structlog, so INFO
    # would otherwise prefix every run with a dozen JSON records before the first test. That noise
    # is suppressed at its source instead - `_upgrade_to_head` pins `settings.LOG_LEVEL` to
    # `_MIGRATION_LOG_LEVEL` for the duration of the upgrade and restores it afterwards - so the
    # transcript stays as readable as it was while the records a test needs are no longer thrown
    # away. Those records are emitted inside a session-scoped fixture in any case, and pytest
    # prints fixture output only when something in that scope fails.
    ("LOG_LEVEL", "INFO"),
    # Mirrors .env.example. The limiter is disabled under `test`, so this value is never
    # enforced - it is set because Settings validates the expression's syntax at startup.
    ("AUTH_RATE_LIMIT", "5/minute"),
    # Pinned to the documented default rather than left to the field's, so the ceiling the
    # body-limit tests generate a body against is a known number here and not whatever a shell
    # export happened to set. Deliberately NOT lowered to make those tests cheaper: a ceiling
    # under 100 000 characters would refuse the largest post content the schema accepts, and the
    # tests that assert on that bound would start failing with 413 for a reason unrelated to them.
    ("MAX_REQUEST_BODY_BYTES", "1048576"),
)


def _apply_environment() -> None:
    """Pin the test profile and its credentials, then fill in the seven tunable variables.

    Two loops, and the difference between them is the whole of this function's purpose.
    :data:`_ENVIRONMENT_OVERRIDES` is **assigned**, so an ambient ``ENVIRONMENT=production``,
    signing key or seed credential cannot survive into the suite - what runs is a test profile
    with fake credentials, whatever the surrounding shell or pipeline exported.
    :data:`_ENVIRONMENT_DEFAULTS` uses :meth:`os.environ.setdefault`, so a deliberate export
    or a CI ``env:`` block still wins for the seven values that only tune what a test measures.

    This runs before any ``app`` import, which is the whole reason it is a module-level
    statement rather than a fixture: ``app.core.config`` constructs and validates its
    ``settings`` singleton while it is being imported, and six of its twelve fields have no
    default to fall back on.
    """
    for name, value in _ENVIRONMENT_OVERRIDES:
        os.environ[name] = value
    for name, value in _ENVIRONMENT_DEFAULTS:
        os.environ.setdefault(name, value)


_apply_environment()
# ---------------------------------------------------------------------------------------
# The database this suite is allowed to touch
# ---------------------------------------------------------------------------------------

#: Environment variable that overrides the derivation outright. Undeclared on `Settings`, and
#: harmless there: pydantic-settings looks up declared field names rather than enumerating the
#: environment, so `extra="forbid"` never sees it. Set it in the *environment* only - written
#: into a .env file, the dotenv source would enumerate it and the model would refuse to start.
TEST_DATABASE_URL_ENV_VAR: Final[str] = "TEST_DATABASE_URL"

#: Environment variable that opts teardown into dropping the database. Absent by default,
#: because keeping the schema makes a re-run fast.
TEST_DATABASE_DROP_ENV_VAR: Final[str] = "TEST_DATABASE_DROP"

#: Environment variable that authorises a target on a server this file does not recognise as
#: the configured local one. Absent by default, which is what makes the host policy fail
#: closed: the one legitimate remote case - a managed test database that really is elsewhere -
#: has to be declared, and a mistyped or copy-pasted staging host cannot be reached by
#: accident. Environment-only and undeclared on `Settings`, exactly like the two names above.
TEST_DATABASE_ALLOW_REMOTE_HOST_ENV_VAR: Final[str] = "TEST_DATABASE_ALLOW_REMOTE_HOST"

#: Appended to the configured database name to derive a sibling for the suite, and - far more
#: importantly - the suffix a database name must carry before this suite will create, migrate,
#: seed or drop it. See `_is_dedicated_test_database`.
TEST_DATABASE_SUFFIX: Final[str] = "_test"

#: Environment variable naming this checkout among the clones sharing one PostgreSQL server.
#: The platform documents it as the discriminator for every host-global resource; a database
#: is one. See section 2.2 of the module docstring.
CLONE_INDEX_ENV_VAR: Final[str] = "CLONE_INDEX"

#: Environment variable `pytest-xdist` exports per worker process (`gw0`, `gw1`, ...). Read
#: even though xdist is not a current dependency, so that adding it changes the database name
#: on its own instead of producing duplicate-key failures nobody can place.
XDIST_WORKER_ENV_VAR: Final[str] = "PYTEST_XDIST_WORKER"

#: Substring the resolved database name MUST contain before this suite will touch it at all.
#: A working database called `blog` cannot match, so a misconfiguration cannot have a schema
#: created over it, cannot be migrated, cannot be written to and cannot be dropped.
#:
#: One marker, checked on every path, and that is the point. It used to guard the drop only, so
#: `TEST_DATABASE_URL` was accepted verbatim and `CREATE DATABASE` plus `alembic upgrade head`
#: ran against whatever it named - a typo aimed the whole suite at a real database, migrated it,
#: and only the teardown it never reached would have objected. `_require_test_database` now
#: applies the same rule at resolution time, before any statement exists to be issued.
#:
#: The marker is the coarse half of the naming rule and gives the friendlier diagnosis; the
#: exact half is `_is_dedicated_test_database`, which is what refuses `contest` and `latest`.
_TEST_DATABASE_MARKER: Final[str] = "test"

#: The one driver this project has. `app.core.config` requires exactly this scheme of
#: DATABASE_URL, and the check is repeated here because this module authorises its candidate
#: BEFORE that model is constructed - see `_authorise_test_target`.
_REQUIRED_DRIVERNAME: Final[str] = "postgresql+psycopg"

#: PostgreSQL's identifier limit. A longer name is silently truncated by the server, which
#: would quietly merge two clones onto one database - the exact failure the tags prevent - so
#: it is enforced here instead.
_MAX_IDENTIFIER_LENGTH: Final[int] = 63

#: The only shape a database name may take on any path in this file. Deliberately narrower
#: than PostgreSQL's quoted-identifier grammar: it admits nothing that could terminate a
#: string, open a comment or end a statement, so the DDL below is safe at the grammar level
#: and not only at the quoting level.
_IDENTIFIER_PATTERN: Final[re.Pattern[str]] = re.compile(r"\A[A-Za-z_][A-Za-z0-9_$]*\Z")

#: The exact naming rule: `TEST_DATABASE_SUFFIX`, optionally followed by the isolation tags
#: `_isolation_suffix` appends. Matched against a casefolded name.
#:
#: A *suffix* rather than a substring, and that difference is the whole point - `contest`,
#: `latest`, `testing`, `latest_events` and `contest_prod` all contain `test` and not one of
#: them is a database this suite may migrate or force-drop. The optional trailing groups are
#: what admits a per-clone name such as `blog_test_w037` or `blog_test_w037_gw0`, which a bare
#: `endswith('_test')` would refuse and which parallel isolation requires.
_DEDICATED_NAME_PATTERN: Final[re.Pattern[str]] = re.compile(r"_test(?:_[a-z0-9]+)*\Z")

#: Characters kept when a tag is sanitised; everything else is dropped. Lowercase alphanumeric
#: only, so a tag can never introduce a character `_IDENTIFIER_PATTERN` would then reject.
_TAG_ALLOWED: Final[re.Pattern[str]] = re.compile(r"[^a-z0-9]+")

#: The longest a single sanitised tag may contribute, so two tags plus the base name and the
#: suffix cannot approach `_MAX_IDENTIFIER_LENGTH`.
_MAX_TAG_LENGTH: Final[int] = 12

#: Hosts this file treats as local. Loopback in the spellings libpq accepts, plus the service
#: names this project's own Compose file and CI workflow use, plus the empty host that means a
#: Unix domain socket. Anything else needs `TEST_DATABASE_ALLOW_REMOTE_HOST`.
_LOCAL_HOSTS: Final[frozenset[str]] = frozenset(
    {
        "",
        "localhost",
        "localhost.localdomain",
        "127.0.0.1",
        "::1",
        "db",
        "database",
        "postgres",
        "postgresql",
    }
)

#: Values `TEST_DATABASE_DROP` and `TEST_DATABASE_ALLOW_REMOTE_HOST` accept as "yes". Anything
#: else, including an empty string, is "no".
_TRUTHY: Final[frozenset[str]] = frozenset({"1", "true", "t", "yes", "y", "on"})

#: The local placeholder .env.example publishes, used only when nothing else supplies a URL -
#: fake credentials against a loopback host, so it is a default rather than a committed secret.
_FALLBACK_DATABASE_URL: Final[str] = "postgresql+psycopg://blog:blog@localhost:5432/blog"

#: Maintenance database the CREATE DATABASE and DROP DATABASE statements connect to, because
#: neither can be issued from inside the database it names.
_MAINTENANCE_DATABASE: Final[str] = "postgres"

#: Threshold in force only while `_upgrade_to_head` runs, so the fourteen `info` records the
#: migration chain emits against a fresh database do not open every session. High enough to hide
#: them, low enough that a migration warning is still heard.
#:
#: Typed as the literal rather than as `str`, because `Settings.LOG_LEVEL` is a closed `Literal`
#: and assigning a plain `str` to it would need a suppression at the assignment - which would then
#: hide a genuine typo here.
_MIGRATION_LOG_LEVEL: Final[Literal["WARNING"]] = "WARNING"

#: PostgreSQL's own identifier-quoting rules, taken from the dialect rather than reimplemented.
#:
#: `IdentifierPreparer.quote_identifier` always quotes and escapes an embedded quote by doubling
#: it, which is exactly PostgreSQL's rule and exactly what an f-string wrapped in literal double
#: quotes fails to do. Built once at module scope: constructing a dialect is not free and the two
#: DDL statements below are issued once per session each.
#:
#: `quote_identifier` rather than `quote`, which quotes only when the name requires it. Always
#: quoting keeps the emitted DDL identical in shape whatever the name looks like, and it preserves
#: the previous behaviour for a mixed-case name, which the hand-written quotes also protected.
#:
#: `PGDialect`, the base PostgreSQL dialect, rather than a driver-specific one: identifier quoting
#: is a rule of the server, not of psycopg, and `_REQUIRED_DRIVERNAME` already guarantees that
#: every engine this file opens speaks that dialect - so the preparer used here is the one on the
#: wire. The suppression is narrow and named because SQLAlchemy annotates no dialect `__init__` -
#: every one takes `**kwargs` - and the alternative, reimplementing
#: `'"' + name.replace('"', '""') + '"'` here, is precisely the hand-rolled escaping this
#: constant exists to avoid.
_PG_DIALECT: Final[PGDialect] = PGDialect()  # type: ignore[no-untyped-call]

_IDENTIFIER_PREPARER: Final[IdentifierPreparer] = _PG_DIALECT.identifier_preparer


def _quote_identifier(name: str) -> str:
    """Return *name* as a safely quoted PostgreSQL identifier.

    A DDL identifier cannot be a bind parameter, so the only two defences available are a
    grammar that admits nothing dangerous and an escaper that is the server's own. Both are
    used: every caller has already passed the name through :func:`_authorise_test_target`,
    which rejects anything outside :data:`_IDENTIFIER_PATTERN`, and this function then renders
    it with the dialect's preparer, which quotes the name and doubles any embedded quote.
    Surrounding an unescaped string with quote characters - which is what an
    ``f'CREATE DATABASE "{name}"'`` does - is not identifier binding and is not used here.

    Args:
        name: A database name, taken from the resolved URL.

    Returns:
        The name wrapped in double quotes with any embedded quote doubled, ready to interpolate
        into DDL where a bind parameter is not permitted.
    """
    return _IDENTIFIER_PREPARER.quote_identifier(name)


def _is_truthy(name: str) -> bool:
    """Report whether the environment variable ``name`` is set to one of :data:`_TRUTHY`.

    Args:
        name: The variable to read. An absent variable is false, as is an empty one.

    Returns:
        ``True`` only for an explicit affirmative spelling.
    """
    return os.environ.get(name, "").strip().casefold() in _TRUTHY


def _sanitised_tag(name: str) -> str:
    """Return the value of environment variable ``name`` reduced to a safe identifier fragment.

    Lowercased, stripped of everything outside ``[a-z0-9]`` and truncated to
    :data:`_MAX_TAG_LENGTH`. The reduction is deliberately lossy and total: whatever a
    platform, a CI matrix or a shell puts in these variables, what reaches a database name is
    a fragment that cannot change the name's grammar. ``w-037`` becomes ``w037`` and ``gw3``
    stays ``gw3``.

    Args:
        name: The environment variable to read.

    Returns:
        The sanitised fragment, or ``""`` when the variable is absent, empty, or consists
        entirely of characters that are dropped.
    """
    return _TAG_ALLOWED.sub("", os.environ.get(name, "").strip().casefold())[:_MAX_TAG_LENGTH]


def _isolation_suffix() -> str:
    """Return the tags that make this process's database name its own, or ``""`` for none.

    Two sources, in a fixed order so the name is reproducible across runs of the same
    process: :data:`CLONE_INDEX_ENV_VAR` then :data:`XDIST_WORKER_ENV_VAR`. See section 2.2 of
    the module docstring for why a shared ``<base>_test`` is a collision rather than a name.

    Returns:
        Either the empty string, or ``_`` followed by each present tag joined by ``_``.
    """
    candidates = (
        _sanitised_tag(CLONE_INDEX_ENV_VAR),
        _sanitised_tag(XDIST_WORKER_ENV_VAR),
    )
    tags = [tag for tag in candidates if tag]
    return f"_{'_'.join(tags)}" if tags else ""


def _is_dedicated_test_database(url: URL) -> bool:
    """Report whether ``url`` names a database this suite is allowed to act destructively on.

    One rule, applied identically wherever the question is asked: the database name must carry
    :data:`TEST_DATABASE_SUFFIX`, optionally followed by the isolation tags this file appends -
    that is, it must match :data:`_DEDICATED_NAME_PATTERN`. An exact suffix rather than a
    substring, and that difference is the whole point: ``contest``, ``latest``, ``testing`` and
    ``latest_events`` all *contain* ``test`` and none of them is a database this suite may
    migrate or force-drop.

    Case-insensitive, because PostgreSQL folds an unquoted identifier to lower case, so
    ``BLOG_TEST`` and ``blog_test`` are one database and a case-sensitive comparison would
    accept one spelling and refuse the other.

    Args:
        url: The parsed candidate URL.

    Returns:
        ``True`` only when the URL names a database whose name carries the suffix.
    """
    database = (url.database or "").casefold()
    return _DEDICATED_NAME_PATTERN.search(database) is not None


def _same_server(left: URL, right: URL) -> bool:
    """Report whether two URLs address the same PostgreSQL server.

    Host and port only. The driver, the user and the password may all differ between two
    spellings of one server, and a guard that compared rendered strings would be defeated by
    any of those differences.

    Args:
        left: One parsed URL.
        right: The other.

    Returns:
        ``True`` when both name the same host and port.
    """
    return ((left.host or "").casefold(), left.port) == ((right.host or "").casefold(), right.port)


def _same_database_target(left: URL, right: URL) -> bool:
    """Report whether two URLs address the same database on the same server.

    Compares host, port and database name and nothing else, for the reason given in
    :func:`_same_server`.

    Args:
        left: One parsed URL.
        right: The other.

    Returns:
        ``True`` when both name the same database on the same host and port.
    """
    return _same_server(left, right) and (left.database or "").casefold() == (
        (right.database or "").casefold()
    )


def _parse_or_refuse(url: str, *, action: str) -> URL:
    """Parse ``url``, or refuse the action naming what could not be read.

    Args:
        url: The candidate connection URL, as the environment supplied it.
        action: What the caller was about to do, quoted back in the failure.

    Returns:
        The parsed URL.

    Raises:
        RuntimeError: If SQLAlchemy cannot parse it. Raised rather than allowed to surface as
            an ``ArgumentError`` deep inside the engine, because the actionable fact is which
            variable is wrong. The URL itself is never echoed - it carries a password.
    """
    try:
        return make_url(url)
    # Broad on purpose: `make_url` raises whatever the value provoked - `ArgumentError` for a
    # malformed URL, `ValueError` for an unparseable port - and every one of them is the same
    # refusal here. Nothing is swallowed: each is re-raised as a RuntimeError naming the action.
    except Exception as error:
        message = (
            f"Refusing to {action}: the connection URL could not be parsed "
            f"({type(error).__name__}). Expected the form {_FALLBACK_DATABASE_URL!r}. The value "
            "is not echoed here because a connection URL carries a password."
        )
        raise RuntimeError(message) from error


def _authorise_test_target(url: str, *, action: str) -> URL:
    """Return ``url`` parsed, having proved it names a database this suite may act on.

    The single gate every path in this file passes through - the bootstrap below, and then each
    of create, migrate, open and drop - and it is called again on each of those rather than
    once, because it reads the value **actually in force** (``settings.DATABASE_URL``) instead
    of trusting an earlier verdict on a mutable singleton. Every one of those paths is
    destructive or long-lived, so each states its own reason and gets its own answer.

    Six requirements, all checked before any connection exists, and all fail-closed. See
    sections 2 and 2a of the module docstring for the reasoning; in short: the URL must parse,
    it must name this project's driver, it must name a database at all, that name must be
    marked as a test database *and* carry the dedicated suffix, it must be a conservative
    identifier PostgreSQL will not truncate, and the host must be one this file recognises
    unless the run has explicitly said otherwise.

    Args:
        url: The candidate connection URL.
        action: What the caller is about to do, quoted back in any failure so the message
            names the operation that was refused rather than only the value.

    Returns:
        The parsed :class:`~sqlalchemy.engine.URL`, so a caller needs no second parse.

    Raises:
        RuntimeError: If the URL cannot be parsed, names another driver, names no database,
            names a database that is not marked as or not shaped like a dedicated test
            database, names one that is not a conservative identifier or is longer than
            PostgreSQL will keep, or names a host that is neither recognised as local nor
            authorised by :data:`TEST_DATABASE_ALLOW_REMOTE_HOST_ENV_VAR`. Refusing loudly is
            the point: a suite that cannot prove where it is pointed must not go on to
            migrate it.
    """
    parsed = _parse_or_refuse(url, action=action)

    if parsed.drivername != _REQUIRED_DRIVERNAME:
        raise RuntimeError(
            f"Refusing to {action}: the URL names the driver {parsed.drivername!r}, and this "
            f"project installs exactly one - {_REQUIRED_DRIVERNAME!r}. A URL written for "
            "another driver was written for another project."
        )

    database = parsed.database or ""
    if not database:
        raise RuntimeError(
            f"Refusing to {action}: the connection URL names no database. Expected the form "
            f"{_FALLBACK_DATABASE_URL!r}, or set {TEST_DATABASE_URL_ENV_VAR} to an explicit "
            f"URL naming a database whose name ends in {TEST_DATABASE_SUFFIX!r}."
        )

    if _TEST_DATABASE_MARKER not in database.casefold():
        raise RuntimeError(
            f"Refusing to {action} {database!r}: this suite creates, migrates and writes to "
            f"the database it is pointed at, so the name must contain "
            f"{_TEST_DATABASE_MARKER!r} to mark it as dedicated to testing. Point "
            f"{TEST_DATABASE_URL_ENV_VAR} at such a database, or unset it and let the name be "
            f"derived by appending {TEST_DATABASE_SUFFIX!r}."
        )

    if not _is_dedicated_test_database(parsed):
        raise RuntimeError(
            f"Refusing to {action} {database!r}: the name must END WITH "
            f"{TEST_DATABASE_SUFFIX!r}, optionally followed by this run's isolation tags. A "
            "name that merely contains 'test' - 'contest', 'latest', 'latest_events' - is an "
            f"ordinary database name. Point {TEST_DATABASE_URL_ENV_VAR} at a dedicated "
            f"database, or unset it and let one be derived from DATABASE_URL by appending "
            f"{TEST_DATABASE_SUFFIX!r}."
        )

    if not _IDENTIFIER_PATTERN.match(database):
        raise RuntimeError(
            f"Refusing to {action} {database!r}: a database name reaches DDL as an identifier "
            "and cannot be a bind parameter, so only a conservative shape is accepted - a "
            "letter or underscore followed by letters, digits, underscores or dollar signs."
        )

    if len(database.encode()) > _MAX_IDENTIFIER_LENGTH:
        raise RuntimeError(
            f"Refusing to {action} {database!r}: it is {len(database.encode())} bytes, and "
            f"PostgreSQL truncates an identifier at {_MAX_IDENTIFIER_LENGTH}. A truncated "
            "name would silently merge two targets into one."
        )

    host = (parsed.host or "").strip().casefold().strip("[]")
    if host not in _LOCAL_HOSTS and not _is_truthy(TEST_DATABASE_ALLOW_REMOTE_HOST_ENV_VAR):
        raise RuntimeError(
            f"Refusing to {action} {database!r} on host {host!r}: this suite runs the whole "
            "migration chain against its target, so a host it does not recognise as local is "
            f"refused by default. Set {TEST_DATABASE_ALLOW_REMOTE_HOST_ENV_VAR}=1 to "
            "authorise a test database that is genuinely remote."
        )

    return parsed


def _authorise_override(candidate: URL, configured: URL) -> None:
    """Apply the two further rules that govern an explicit override and nothing else.

    Both exist because ``TEST_DATABASE_URL`` is the one value that can point this suite
    somewhere the derivation never would, and both are stated before the generic gate so the
    mistake that actually happens gets diagnosed by name rather than by a naming rule.

    1. **Not the application's own working database.** Exporting ``TEST_DATABASE_URL`` equal to
       ``DATABASE_URL`` "to just run it against my data" is the mistake, and the answer is a
       sentence that says so. Carved out when the configured database is *itself* dedicated,
       because that is how CI is configured - ``DATABASE_URL`` already ends in ``_test``, the
       derivation is idempotent, and refusing there would be a false positive.
    2. **The configured server, never another.** An override may redirect this suite to another
       *database* and never to another *server*: reaching a different server is done by pointing
       ``DATABASE_URL`` at it, which is what ``.env.example`` documents, and which keeps one
       variable in charge of where this project connects. Released by the same explicit opt-in
       that authorises a remote host, since a genuinely managed test database is exactly the
       case where the two must differ.

    Args:
        candidate: The parsed override URL.
        configured: ``DATABASE_URL`` as it stood before this module reassigned it, parsed.

    Raises:
        RuntimeError: If the override names the application's own working database, or moves
            the run to a server ``DATABASE_URL`` does not name.
    """
    if _same_database_target(candidate, configured) and not _is_dedicated_test_database(configured):
        raise RuntimeError(
            f"Refusing to use {TEST_DATABASE_URL_ENV_VAR}: it points this suite at the database "
            f"DATABASE_URL already names ({candidate.database!r}), which is the application's "
            "own working database. The suite migrates, seeds and may force-drop its target, so "
            "it refuses to share one with the application. Point "
            f"{TEST_DATABASE_URL_ENV_VAR} at a dedicated database whose name ends in "
            f"{TEST_DATABASE_SUFFIX!r}, or unset it and let the sibling be derived."
        )

    if not _same_server(candidate, configured) and not _is_truthy(
        TEST_DATABASE_ALLOW_REMOTE_HOST_ENV_VAR
    ):
        raise RuntimeError(
            f"Refusing to use {TEST_DATABASE_URL_ENV_VAR}: it names a different server from "
            "DATABASE_URL. It may redirect this suite to another database on the configured "
            "server, never to another server - run the suite against a different host by "
            "pointing DATABASE_URL at that host, so one variable stays in charge of where this "
            f"project connects, or set {TEST_DATABASE_ALLOW_REMOTE_HOST_ENV_VAR}=1 if the test "
            "database really is elsewhere."
        )


def _resolve_test_database_url() -> str:
    """Return the authorised URL of the database this suite may create, migrate and write to.

    ``TEST_DATABASE_URL`` names the target when it is set; it is authorised, never rewritten,
    because a caller naming a database explicitly has already made that decision - and it is
    additionally held to :func:`_authorise_override`. Otherwise ``DATABASE_URL`` is parsed and
    a sibling name is derived by appending :data:`TEST_DATABASE_SUFFIX` and this process's
    isolation tags, which is why the suite can never act on the database a developer is working
    in and why two clones sharing one server do not share one database.

    The derivation is idempotent in both parts: a name already ending in the suffix keeps it
    rather than gaining a second, and a name already ending in the tags keeps those, so
    re-running with a ``DATABASE_URL`` this function previously produced yields the same name
    rather than ``..._test_w037_test_w037``.

    Returns:
        A ``postgresql+psycopg://`` URL naming an authorised test database.

    Raises:
        RuntimeError: If the resolved target fails :func:`_authorise_test_target`, or an
            override fails :func:`_authorise_override`. Raising during import is the intended
            outcome - the failure arrives before a connection exists, before ``CREATE
            DATABASE`` and before the first revision.
    """
    configured = _parse_or_refuse(
        os.environ.get("DATABASE_URL") or _FALLBACK_DATABASE_URL,
        action="read DATABASE_URL",
    )

    override = os.environ.get(TEST_DATABASE_URL_ENV_VAR)
    if override:
        # Authorised, not rewritten: no suffix and no tag is appended to a name a caller chose.
        candidate = _parse_or_refuse(override, action=f"use {TEST_DATABASE_URL_ENV_VAR}")
        _authorise_override(candidate, configured)
        _authorise_test_target(override, action=f"use {TEST_DATABASE_URL_ENV_VAR}")
        return override

    if not configured.database:
        raise RuntimeError(
            "Refusing to derive a test database: DATABASE_URL names no database. Expected the "
            f"form {_FALLBACK_DATABASE_URL!r}, or set {TEST_DATABASE_URL_ENV_VAR} to an "
            "explicit URL."
        )

    suffix = f"{TEST_DATABASE_SUFFIX}{_isolation_suffix()}"
    name = configured.database
    database = name if name.casefold().endswith(suffix.casefold()) else f"{name}{suffix}"
    derived = configured.set(database=database).render_as_string(hide_password=False)
    _authorise_test_target(derived, action="derive a test database")
    return derived


def _require_test_database(url: str) -> str:
    """Refuse the URL unless it names a database this suite is allowed to destroy.

    The preflight, and it runs before anything else can: at import, on the single value every
    later operation is derived from. That placement is the guarantee - the engine, the maintenance
    URL, ``CREATE DATABASE``, ``alembic upgrade head``, every write a test makes and the optional
    ``DROP DATABASE`` all follow ``settings.DATABASE_URL``, so a target refused here cannot be
    reached by any of them. Checking inside :func:`database_schema` instead would already be too
    late in principle and useless in practice, because a module-level import in a unit test can
    open a connection first.

    The derived path satisfies this by construction, since it appends
    :data:`TEST_DATABASE_SUFFIX`. The path that needs guarding is the ``TEST_DATABASE_URL``
    override, which was previously honoured verbatim: a single mistyped character was enough to
    aim ``CREATE DATABASE``, the whole migration chain and every test write at a real database.

    The rules themselves live in :func:`_authorise_test_target`, which the create, migrate,
    open and drop paths each call again on the value in force at the moment they run. This
    wrapper exists so the resolution can be *enclosed* by the gate at its single assignment
    site rather than checked beside it, and so the returned value is the URL itself.

    Deliberately **not** also refusing a URL equal to ``DATABASE_URL`` on the derived path.
    That looks like a tightening and is in fact a false positive: :func:`_resolve_test_database_url`
    is idempotent, so a ``DATABASE_URL`` already ending in ``_test`` - which is exactly how CI is
    configured - resolves to itself. The override path *is* held to that rule, by
    :func:`_authorise_override`, because there the equality is a decision somebody made.

    Args:
        url: The resolved test-database URL, from either the override or the derivation.

    Returns:
        *url* unchanged, so this reads as a gate at its one call site rather than as a separate
        statement somebody could reorder or drop.

    Raises:
        RuntimeError: If the URL names no database, or names one this suite is not authorised to
            create, migrate, write to and drop. Raised during collection, before a single
            connection is opened, and the message names the variable to change.
    """
    _authorise_test_target(url, action="run the suite against")
    return url


# Assignment, not setdefault, and this is the one line that redirects everything. The engine
# below reads settings.DATABASE_URL, and so does migrations/env.py - because
# backend/alembic.ini deliberately declares no sqlalchemy.url - so both the application side
# and the migration side follow this single value to the same test database.
#
# The resolution is wrapped in the preflight rather than checked afterwards, so there is no
# window in which an unauthorised URL is the configured one: nothing downstream can act on a
# target `_require_test_database` refused, because it never becomes `DATABASE_URL` at all.
os.environ["DATABASE_URL"] = _require_test_database(_resolve_test_database_url())
# ---------------------------------------------------------------------------------------
# Imports that must not run any earlier
#
# Everything below reaches app.core.config, whose module-level `settings` validates while it
# is imported. Moving any of these above the bootstrap turns a configured test session into a
# collection error listing six `Field required` failures and naming none of the fixtures.
#
# `ruff check backend` covers this tree, so each import below carries its own per-line
# suppression for E402 (module level import not at top of file). Per line on purpose: E402 is
# the correct rule everywhere else in the project, and neither the rule nor the sibling
# pyproject.toml is weakened to accommodate one file.
# ---------------------------------------------------------------------------------------
import inspect  # noqa: E402
from collections.abc import AsyncIterator, Callable  # noqa: E402
from contextlib import asynccontextmanager  # noqa: E402

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import Engine, create_engine, text  # noqa: E402
from sqlalchemy.exc import DBAPIError, ProgrammingError  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.dependencies import get_db  # noqa: E402
from app.core.logging import configure_logging  # noqa: E402
from app.core.security import create_access_token  # noqa: E402
from app.db.session import HIDE_PARAMETERS, safe_connect_args  # noqa: E402
from app.main import app as fastapi_app  # noqa: E402
from app.models import User  # noqa: E402
from tests import factories  # noqa: E402

# One module object, reachable under both spellings. pytest imports this conftest before any
# test module, and `backend/tests` is on sys.path in prepend import mode, so a test module is
# free to write `import factories` while this file writes `from tests import factories`. Left
# alone, those are two *separate* module objects with two separate `_counter` generators, and
# the second one hands out discriminators the first has already used - surfacing as an opaque
# UNIQUE violation on users.email inside an unrelated test. Aliasing costs one line and makes
# the duplicate impossible; setdefault so an already-bound name is never rebound.
sys.modules.setdefault("factories", factories)

#: The plaintext every factory-created account is given, re-exported so a test that needs to
#: authenticate through `POST /api/v1/auth/login` can reach it from the fixture module it is
#: already using. `create_user` stores only the argon2id hash, so there is no other way to
#: learn it. Obviously fake, and it satisfies the registration policy, so it can also be
#: submitted to `POST /api/v1/auth/register` without provoking an unrelated 422.
DEFAULT_PASSWORD: Final[str] = factories.DEFAULT_PASSWORD

__all__ = [
    "CLONE_INDEX_ENV_VAR",
    "DEFAULT_PASSWORD",
    "TEST_DATABASE_ALLOW_REMOTE_HOST_ENV_VAR",
    "TEST_DATABASE_DROP_ENV_VAR",
    "TEST_DATABASE_SUFFIX",
    "TEST_DATABASE_URL_ENV_VAR",
    "TEST_ENVIRONMENT",
    "TEST_JWT_SECRET_KEY",
    "TEST_SEED_ADMIN_EMAIL",
    "TEST_SEED_ADMIN_PASSWORD",
    "XDIST_WORKER_ENV_VAR",
    "admin_client",
    "admin_user",
    "app",
    "auth_headers_for",
    "author_client",
    "author_user",
    "client",
    "database_schema",
    "db_session",
    "engine",
    "login_form",
    "other_author_user",
    "override_get_db",
    "pytest_collection_modifyitems",
    "reader_user",
    "unavailable_database",
]


# ---------------------------------------------------------------------------------------
# Collection hook: every async test runs on the session loop
# ---------------------------------------------------------------------------------------


def pytest_collection_modifyitems(
    config: pytest.Config,
    items: list[pytest.Item],
) -> None:
    """Mark unmarked coroutine tests ``asyncio(loop_scope="session")``.

    Defence in depth rather than the primary mechanism. The sibling
    ``backend/pyproject.toml`` already sets ``asyncio_mode = "auto"`` together with
    ``asyncio_default_fixture_loop_scope`` and ``asyncio_default_test_loop_scope`` of
    ``"session"``, so in a correctly configured run every async test already shares the loop
    the session-scoped :func:`engine` was created on. This hook makes the same guarantee hold
    when the suite is driven with an overriding ``-o`` flag, from a differently rooted
    invocation, or by an editor's runner that supplies its own ini.

    It is a strict no-op whenever an ``asyncio`` marker is already present, whoever applied it
    - the ini's auto mode, an explicit decorator on the test, or a module-level
    ``pytestmark``. That guard is what stops it from competing with ``asyncio_mode = "auto"``
    or from overriding a test that deliberately asked for a narrower loop scope.

    Args:
        config: The active configuration. Unused - the decision needs only the item - but
            part of the hook signature pytest calls, so it is accepted and named.
        items: The collected items, modified in place. Only :class:`~pytest.Function` items
            expose ``function``; anything else is skipped rather than guessed at.
    """
    del config  # Part of the hook contract; the marking decision is per item.

    for item in items:
        test_function = getattr(item, "function", None)
        if test_function is None or not inspect.iscoroutinefunction(test_function):
            continue
        if item.get_closest_marker("asyncio") is not None:
            continue
        item.add_marker(pytest.mark.asyncio(loop_scope="session"))


# ---------------------------------------------------------------------------------------
# Schema construction
#
# Synchronous throughout, and deliberately so: `alembic.command.upgrade` is blocking, and
# CREATE DATABASE cannot run inside a transaction, which rules out the async engine's
# implicit transaction handling. Running this on the plain thread also keeps it entirely
# outside the event-loop question that governs everything below it.
# ---------------------------------------------------------------------------------------

#: SQLSTATE PostgreSQL returns for `CREATE DATABASE` against a name that already exists -
#: `duplicate_database`, surfaced by psycopg as `psycopg.errors.DuplicateDatabase` and reachable
#: as `error.orig.sqlstate`. A code rather than a message: the message is localised by the
#: server's `lc_messages` and reworded between releases, so matching its text both rejects the
#: race it is meant to tolerate on a non-English server and swallows any unrelated failure whose
#: wording happens to contain the same phrase.
_SQLSTATE_DUPLICATE_DATABASE: Final[str] = "42P04"


def _sqlstate_of(error: DBAPIError) -> str | None:
    """Return the SQLSTATE the driver published on *error*, or ``None`` if it published none.

    ``DBAPIError.orig`` is the driver's own exception, and psycopg 3 exposes the five-character
    condition code on it as ``sqlstate``. Read through :func:`getattr` because ``orig`` is
    whatever the configured driver raised and a client-side failure - one the driver refused
    before the statement reached the server - carries no code at all.

    Args:
        error: The wrapped driver failure.

    Returns:
        The SQLSTATE, or ``None`` when there is not one to read.
    """
    sqlstate = getattr(error.orig, "sqlstate", None)
    return sqlstate if isinstance(sqlstate, str) else None


def _maintenance_url() -> str:
    """Return the resolved URL with its database swapped for the maintenance database.

    ``CREATE DATABASE`` and ``DROP DATABASE`` cannot be issued from a connection to the
    database they name, so both statements are sent to ``postgres`` on the same host, port and
    credentials.

    The target is authorised again here rather than taken on trust from the bootstrap, because
    ``settings`` is deliberately not frozen: the value in force when a maintenance connection
    opens need not be the value that was in force at import.

    Returns:
        A synchronous-usable ``postgresql+psycopg://`` URL pointing at ``postgres``. The
        driver is unchanged because psycopg 3 is the project's only driver - AAP §0.5.6
        excludes ``asyncpg`` - and it serves the synchronous side here exactly as it serves the
        asynchronous application.

    Raises:
        RuntimeError: If the configured target is not an authorised test database.
    """
    authorised = _authorise_test_target(
        settings.DATABASE_URL, action="reach the maintenance database"
    )
    maintenance = authorised.set(database=_MAINTENANCE_DATABASE)
    return maintenance.render_as_string(hide_password=False)


def _maintenance_engine() -> Engine:
    """Open an AUTOCOMMIT engine on the maintenance database, for the two ``DATABASE`` statements.

    ``isolation_level="AUTOCOMMIT"`` is required rather than convenient: PostgreSQL refuses both
    statements inside a transaction block, and SQLAlchemy opens one implicitly otherwise.

    ``hide_parameters=True`` matches ``app.db.session``'s engine: nothing here binds a parameter
    today, and the setting is what keeps that true of anything added later, since a failed
    statement otherwise renders its bound values into the pytest transcript. No connect
    arguments are passed - this engine exists to issue one DDL statement against ``postgres``
    and is disposed immediately, so the session-level options the application engine sets have
    nothing to govern here.

    Returns:
        The engine. The caller owns it and must dispose of it.

    Raises:
        RuntimeError: If the configured target is not an authorised test database.
    """
    return create_engine(
        _maintenance_url(),
        isolation_level="AUTOCOMMIT",
        hide_parameters=True,
        future=True,
    )


@contextmanager
def _database_lifecycle_lock(database: str) -> Iterator[None]:
    """Hold an advisory lock naming ``database`` for the duration of the block.

    Creating a database, and migrating one that may have just been created, need a single
    owner. With one clone that is automatic; with several starting together it is not, and the
    failures are the confusing kind - two ``CREATE DATABASE`` statements racing, or two
    ``alembic upgrade head`` runs interleaving on one ``alembic_version`` row.

    The lock is an :func:`fcntl.flock` on a file in the system temporary directory named for
    the resolved database, so it is *per target*: processes pointed at different databases
    never contend, and processes pointed at the same one serialise, with the second finding the
    schema already at head and applying nothing. An advisory file lock is chosen over a
    PostgreSQL advisory lock because it also covers the window in which the database does not
    exist yet - there is nothing to connect to in order to take a lock inside it.

    The lock is released when the file descriptor closes, which the ``with`` statement
    guarantees on every path including an exception, so a crashed run cannot leave a stale lock
    behind. A file lock cannot be taken on some non-POSIX platforms; this project targets Linux
    containers and :mod:`fcntl` is imported unconditionally, so an absent implementation would
    be a broken environment rather than a case to degrade into silently.

    Args:
        database: The resolved, already-authorised database name. Used only to name the lock
            file, and safe to embed in a path because the authorisation gate has restricted it
            to :data:`_IDENTIFIER_PATTERN`.

    Yields:
        ``None``. The caller runs with the lock held.
    """
    lock_path = Path(tempfile.gettempdir()) / f"blog-test-db-{database}.lock"
    # `a` rather than `w`: the file is a lock holder and never carries content, and truncating
    # it would be a write another process could be blocked on for no reason.
    with lock_path.open("a", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _ensure_test_database_exists() -> None:
    """Create the test database if it is not there yet, tolerating a concurrent creator.

    ``isolation_level="AUTOCOMMIT"`` is required, not merely convenient: PostgreSQL refuses
    ``CREATE DATABASE`` inside a transaction block, and SQLAlchemy opens one implicitly
    otherwise. :func:`_maintenance_engine` supplies both that and parameter hiding.

    The target is authorised again here rather than taken on trust from the bootstrap, because
    this is the first of the three destructive paths and it reads ``settings.DATABASE_URL`` -
    the value in force - rather than the value that was in force at import.

    The already-exists case is treated as success rather than checked for in advance. Testing
    ``pg_database`` first and creating afterwards is a race - two suites starting together
    would both see it absent - whereas letting the statement fail and inspecting the failure is
    correct under any interleaving. The failure is identified by **SQLSTATE**
    :data:`_SQLSTATE_DUPLICATE_DATABASE`, read off the wrapped driver error, because that code
    is part of the wire protocol whereas the message it arrives with is prose a server locale or
    a driver release can reword - matching the text was one PostgreSQL translation away from
    turning the ordinary idempotent path into a suite-wide failure. Anything else - refused
    connection, bad credentials, insufficient privilege - propagates, because those are the
    failures a developer needs to see rather than a mysterious absence of tables later on.

    Raises:
        RuntimeError: If the resolved target is not an authorised test database.
        sqlalchemy.exc.SQLAlchemyError: If the maintenance database is unreachable or the
            statement fails for any reason other than the database already existing.
    """
    database = _authorise_test_target(settings.DATABASE_URL, action="create").database or ""
    engine = _maintenance_engine()
    try:
        with engine.connect() as connection:
            # Quoted through the dialect's own preparer rather than by wrapping the name in
            # literal double quotes. A DDL identifier cannot be a bind parameter, so quoting is
            # the only protection available, and hand-written quotes provide none against a name
            # that contains one - `blog"; DROP ...` closes the pair and the rest is statement
            # text. `quote_identifier` escapes an embedded quote by doubling it, which is what
            # PostgreSQL's own rule requires, and it sits on top of the grammar the authorisation
            # gate already enforced, so this is the second of two independent guards.
            connection.execute(text(f"CREATE DATABASE {_quote_identifier(database)}"))
    except ProgrammingError as error:
        if _sqlstate_of(error) != _SQLSTATE_DUPLICATE_DATABASE:
            raise
    finally:
        engine.dispose()


def _upgrade_to_head() -> None:
    """Run ``alembic upgrade head`` in process against the resolved database.

    Programmatic rather than a subprocess, so the run inherits the environment this module
    bootstrapped and a failing revision raises here with its own traceback instead of an exit
    code and a captured stream.

    ``script_location`` is overridden explicitly even though ``alembic.ini`` already declares
    ``migrations``: that value is relative, so it resolves against the working directory, and
    the gate is invoked both from the repository root and from inside ``backend/``. Setting it
    from :data:`__file__` makes the two invocations identical.

    ``head`` is requested rather than a named revision, so the chain - ``0001`` initial schema,
    ``0002`` generated search vector and its GIN and trigram indexes, ``0003`` the eight
    reference categories - is applied in full, and a revision added later needs no change here.
    The URL is not passed either: the environment script reads ``settings.DATABASE_URL``, which
    the bootstrap has already pointed at the test database.

    That last point is exactly why the target is authorised once more before the chain runs.
    This function does not choose where the migrations land - ``migrations/env.py`` reads the
    same mutable settings object - so the check has to be made against the value in force at
    the moment of the run, and applying a migration chain is the single most consequential
    thing this module does to a database it did not create.

    The threshold is pinned to ``WARNING`` for the duration and restored afterwards, and that is
    what lets :data:`_ENVIRONMENT_DEFAULTS` run the rest of the suite at ``INFO``. Against a fresh
    database this one call emits fourteen ``alembic.runtime.migration`` records at ``info`` -
    ``Context impl``, ``Will assume transactional DDL``, and one ``Running upgrade`` per revision -
    which is exactly the noise a session-wide ``WARNING`` used to suppress, at the cost of throwing
    away every other record a test might assert on. Pinning it here confines the quiet to the one
    operation that is noisy. ``WARNING`` rather than silence, so a migration that actually
    complains is still heard.

    It is pinned on ``settings`` and **not** by raising the ``alembic`` logger's level, which does
    not work and is worth recording so nobody tries it again. ``migrations/env.py`` calls
    ``configure_logging(stream=sys.stderr)`` at its own module scope - deliberately, so a migration
    run has the same log shape as the service and writes to stderr while its stdout carries
    generated DDL - and Alembic imports that module *inside* ``command.upgrade``. Any level set on
    a logger beforehand is therefore reset by that call before the first revision runs. What the
    call reads is ``settings.LOG_LEVEL``, so that is the lever that survives it.

    :func:`~app.core.logging.configure_logging` is called again in the ``finally`` for the same
    reason: env.py's call left the single root handler pointed at stderr and pinned to
    ``WARNING``, and the session expects stdout at the configured level. Restoring it here means a
    failing revision cannot leave logging reconfigured for every test that follows.

    Raises:
        RuntimeError: If the resolved target is not an authorised test database.
    """
    _authorise_test_target(settings.DATABASE_URL, action="migrate")

    config = Config(str(_ALEMBIC_INI))
    config.set_main_option("script_location", str(_MIGRATIONS_DIR))

    previous_level = settings.LOG_LEVEL
    settings.LOG_LEVEL = _MIGRATION_LOG_LEVEL
    try:
        command.upgrade(config, "head")
    finally:
        settings.LOG_LEVEL = previous_level
        configure_logging()


def _drop_test_database() -> None:
    """Drop the test database, refusing outright unless its name is an authorised test target.

    Guarded twice. The caller only reaches this when ``TEST_DATABASE_DROP`` is truthy, and this
    function passes the target through the same :func:`_authorise_test_target` gate the create
    and migrate paths use, so a working database named ``blog`` can never be destroyed by a
    misconfigured override - and neither can ``contest`` or ``latest``, which the substring
    check this replaced would have accepted as disposable, nor one on a host this run was not
    authorised to reach.

    ``WITH (FORCE)`` terminates any other session still attached, which is what makes the drop
    reliable rather than intermittently blocked - PostgreSQL 13 introduced it and this project
    targets 18. It is also why the drop is serialised by the same lock the create-and-migrate
    step takes: forcing another clone's live session off a database it is mid-run against is
    precisely the collision the lock and the per-clone name exist to prevent. The statement runs
    on an autocommit connection to the maintenance database for the same reason
    ``CREATE DATABASE`` does, and the identifier is rendered by the dialect's preparer rather
    than wrapped in quote characters.

    Raises:
        RuntimeError: If the resolved target is not an authorised test database. Raised rather
            than silently skipped, because a run that asked to drop and did not needs to say
            why.
    """
    database = _authorise_test_target(settings.DATABASE_URL, action="drop").database or ""

    engine = _maintenance_engine()
    try:
        with engine.connect() as connection:
            connection.execute(
                text(f"DROP DATABASE IF EXISTS {_quote_identifier(database)} WITH (FORCE)")
            )
    finally:
        engine.dispose()


@pytest.fixture(scope="session")
def database_schema() -> Iterator[str]:
    """Create the test database if absent and migrate it to head, once per session.

    A plain synchronous fixture because everything it calls is blocking, and **deliberately not
    autouse**. Autouse would make every test in the tree - including the unit modules that
    advertise themselves as touching neither the database nor the network - create a database
    and run the whole revision chain before their first assertion, so ``pytest -m unit`` would
    fail on a machine with no PostgreSQL and the marker would be describing something untrue.
    Nothing in a unit module needs it: they import ``app.core.*`` and ``app.db.session``, and
    ``create_async_engine`` resolves configuration without opening a connection.

    Every path that does reach the database therefore declares this fixture explicitly, and
    :func:`engine` is the single such edge - ``db_session`` takes ``engine``, ``client`` takes
    ``db_session``, and the identity fixtures and authenticated clients take ``db_session`` in
    turn - so no connection can be opened before the migrations have been applied.

    ``alembic upgrade head`` rather than ``Base.metadata.create_all()``, and the difference is
    capability rather than preference - the AAP's reversible-schema-evolution standard
    (§0.10.1 #7) applied to the harness. ``create_all()`` cannot produce this schema at all:
    ``users.email``, ``users.username``, ``categories.slug`` and ``posts.slug`` are ``CITEXT``,
    a type revision ``0001`` installs the extension for, and ``posts.search_vector`` is
    ``GENERATED ALWAYS AS (...) STORED`` with GIN and ``gin_trgm_ops`` indexes that revision
    ``0002`` creates. Running the chain also means every session exercises it, so a broken
    revision fails the whole suite instead of only the migration gate.

    What the migrations leave behind matters to every assertion about taxonomy. Revision
    ``0003_seed_reference_categories`` inserts eight reference categories as **data**, and the
    migration commits them, so ``categories`` is non-empty before the first test and per-test
    rollback does not remove them. Assertions must be phrased as "contains" or "at least" -
    never "the database is empty", and never "there is exactly one category".

    Creation and migration are one unit of work with one owner, so both run inside
    :func:`_database_lifecycle_lock` - an advisory lock named for the resolved database. That
    matters because this platform runs clones in parallel against one PostgreSQL server: two
    processes reaching this fixture at the same instant would otherwise race ``CREATE DATABASE``
    and interleave two ``alembic upgrade head`` runs on one ``alembic_version`` row. Under the
    lock the second process finds the schema already at head and applies nothing, and processes
    pointed at different databases - which per-clone naming makes the normal case - never
    contend at all.

    Teardown leaves the database in place so a re-run skips creation and applies no revision.
    Set ``TEST_DATABASE_DROP=1`` to drop it instead; that path takes the same lock, for the same
    reason in reverse - ``WITH (FORCE)`` would otherwise be able to terminate another process's
    live session - and refuses any target :func:`_authorise_test_target` does not authorise.

    Yields:
        The resolved database name, so a test or another fixture can report which database it
        ran against without re-parsing the URL.
    """
    authorised = _authorise_test_target(settings.DATABASE_URL, action="build the schema in")
    database = authorised.database or ""

    with _database_lifecycle_lock(database):
        _ensure_test_database_exists()
        _upgrade_to_head()

    try:
        yield database
    finally:
        if _is_truthy(TEST_DATABASE_DROP_ENV_VAR):
            with _database_lifecycle_lock(database):
                _drop_test_database()


# ---------------------------------------------------------------------------------------
# Engine and the per-test transaction
# ---------------------------------------------------------------------------------------


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def engine(database_schema: str) -> AsyncIterator[AsyncEngine]:
    """Open one async engine for the whole session, pooling nothing.

    ``poolclass=NullPool`` is mandatory rather than a tuning choice. A session-scoped engine
    and function-scoped async tests have to agree about their event loop, or a connection
    created under one loop is handed back out under another and awaits on a loop that is
    already closed - the ``Future attached to a different loop`` family of failures.
    ``NullPool`` removes the possibility structurally: every ``connect()`` opens a fresh DBAPI
    connection and closes it on release, so this long-lived object holds no connection between
    tests and there is nothing to carry across loops. The declared ``loop_scope="session"``
    and :func:`pytest_collection_modifyitems` align the loops as well; the two mechanisms are
    complementary, and neither is load-bearing alone.

    This engine is the suite's own. ``app.db.session.engine`` is deliberately untouched: it is
    the pooled engine ``app.main``'s lifespan disposes, that lifespan never runs under
    :class:`~httpx.ASGITransport`, and because :func:`client` overrides ``get_db`` nothing ever
    checks a connection out of it. Reusing it would mean two owners for one pool and a disposal
    this suite does not control.

    What *is* borrowed from that module is the pair of values it declares for every connection
    this project opens - ``safe_connect_args()`` and ``HIDE_PARAMETERS`` - and nothing else. Both
    are pure and pool-free, so taking them costs no coupling; restating them here instead would
    mean the suite ran under a different connection contract from the service it is testing, and
    would let the two drift silently. Every pool setting stays behind, because ``NullPool``
    retains no connection for one to describe.

    ``hide_parameters=True`` mirrors ``app.db.session``'s engine, and it matters more here than
    there rather than less. This is the engine every test writes through, so its statements bind
    email addresses, argon2id hashes, refresh-token digests and post bodies - and SQLAlchemy
    renders bound values into the message of a failed statement unless told otherwise, which
    puts them in the pytest transcript, the CI log and the failure a developer pastes into an
    issue. The statement is still reported in full; only the values become a marker.

    Args:
        database_schema: The migrated-schema fixture, requested so that it runs at all and runs
            first. The value is not used; the dependency edge is the point. It is the *only*
            edge to that fixture in this file - ``db_session`` takes this engine, ``client``
            takes ``db_session``, and the identity fixtures take ``db_session`` in turn - so
            declaring it here is what keeps a connection from being opened before the revisions
            have run, and what keeps a test that asks for none of these from needing a database.

    Yields:
        The engine, bound to the resolved test database.

    Raises:
        ValueError: If the configured target is no longer a validated test database. Checked
            here as well as at creation and migration time, because this is the engine the
            tests write through.
    """
    del database_schema  # Requested for ordering; the name of the database is not needed here.

    # Re-authorised rather than taken on trust from the import-time bootstrap: `settings` is not
    # frozen, so the value in force when the engine opens need not be the value that was in force
    # when this module finished importing.
    target = _authorise_test_target(
        settings.DATABASE_URL, action="open the test engine"
    ).render_as_string(hide_password=False)
    async_engine = create_async_engine(
        target,
        poolclass=NullPool,
        # The two invariants `app.db.session` declares for every connection this project
        # opens, taken from there rather than restated - see "Three processes open connections
        # to this database" in that module. Both matter to a test run specifically.
        # `connect_timeout` bounds collection: without it, a database that accepts a socket and
        # then goes silent holds the whole session on libpq's 130-second default before the
        # first test reports anything. The UTC session option means the suite exercises the
        # production wire contract rather than whatever zone the server happens to default to,
        # so a timestamp assertion here is an assertion about what a response really carries.
        connect_args=safe_connect_args(),
        # And the suite is exactly where output is redirected to a file: without this, a failed
        # statement in a fixture renders the bound values - a password hash, an email, a draft
        # body - into the traceback pytest prints and CI keeps.
        hide_parameters=HIDE_PARAMETERS,
    )
    try:
        yield async_engine
    finally:
        # Disposed even when a test raised, so the session cannot end holding an open
        # connection and leaving PostgreSQL to time it out.
        await async_engine.dispose()


@pytest_asyncio.fixture(loop_scope="session")
async def db_session(engine: AsyncEngine) -> AsyncIterator[AsyncSession]:
    """Yield a session inside a transaction that is rolled back when the test ends.

    This is the isolation guarantee the whole suite rests on, and AAP §0.7.2's "each test
    wrapped in a transaction that is rolled back" is implemented exactly here. The shape is
    four steps and a teardown:

    1. take a connection from the engine;
    2. begin a transaction *on that connection*, which this fixture owns;
    3. bind a session to the live connection rather than to the engine;
    4. yield it, then discard the transaction whatever happened.

    ``join_transaction_mode="create_savepoint"`` is what makes step 4 mean anything. The
    service layer genuinely commits - ``auth_service`` on registration, ``post_service`` on the
    publish transitions, ``comment_service`` on moderation - because that is where a unit of
    work legitimately ends. Under the default join mode the first such commit would end the
    transaction begun in step 2, and the rollback below would have nothing left to undo: rows
    would survive into the next test, and the suite would pass or fail according to the order
    it happened to run in. With ``create_savepoint`` the session works inside a ``SAVEPOINT``,
    a service ``commit()`` releases that savepoint while the outer transaction stays open, and
    the outer transaction is thrown away here. Nothing a test or a request writes is ever
    committed.

    ``expire_on_commit=False`` matches ``app.db.session``'s own session factory and is a
    correctness requirement rather than an ergonomic one: after a commit SQLAlchemy expires
    every attribute it wrote, and reading an expired attribute under an async session raises
    ``MissingGreenlet`` instead of returning a value. Leaving instances unexpired is what lets
    a test read a field off a row a service just persisted.

    Every acquisition is inside something that releases it
        The connection is taken with ``async with``, so it is returned however this fixture
        exits - including a failure in ``connection.begin()`` or in the ``AsyncSession``
        constructor, which happen *after* the connection exists and before any hand-written
        ``finally`` used to be entered. A leaked connection is not a visible failure either: it
        is a socket PostgreSQL holds until it times out, and one per affected test.

        The teardown steps are then protected **independently** rather than sharing one
        ``finally``. Closing a session, rolling a transaction back and releasing a connection
        are three separate operations that can each fail, and a single sequential block means
        the first failure skips the rest - so a session that raises on close would leave the
        outer transaction open and its rows visible to whatever ran next. Nesting them means
        every step is attempted, the outer rollback still happens, and the first exception is
        the one that propagates.

    Args:
        engine: The session-scoped engine.

    Yields:
        A session whose every write is provisional. Hand this to ``tests.factories`` helpers,
        and note that they flush rather than commit for the same reason.
    """
    async with engine.connect() as connection:
        transaction = await connection.begin()
        try:
            session = AsyncSession(
                bind=connection,
                expire_on_commit=False,
                join_transaction_mode="create_savepoint",
            )
            try:
                yield session
            finally:
                # Closing the session first releases its savepoint and stops it using the
                # connection. Wrapped so that a failure here cannot skip the rollback below:
                # rows that are still visible are far worse than a close that complained.
                await session.close()
        finally:
            # `is_active` is false when a test rolled the outer transaction back itself, and
            # rolling back twice raises. The connection is released by the `async with`.
            if transaction.is_active:
                await transaction.rollback()


# ---------------------------------------------------------------------------------------
# The application and the in-process HTTP client
# ---------------------------------------------------------------------------------------

#: Host the ASGI transport answers on. No name is resolved and no socket is opened - httpx
#: needs an absolute base URL to build request targets from, and this is that placeholder.
_BASE_URL: Final[str] = "http://testserver"


def _request_scoped_get_db(session: AsyncSession) -> Callable[[], AsyncIterator[AsyncSession]]:
    """Build the ``get_db`` replacement every client in this file installs.

    One function rather than two identical closures, because the property it implements is the
    one both clients have to get right and neither should be able to get right differently.

    What it does, and why each half is load-bearing
    -----------------------------------------------
    It yields **the same session object** the test holds - the identity the whole suite rests
    on: a row a factory created is visible to the request, a row the request created is visible
    to the test afterwards, and one rollback at teardown undoes both. A fresh session per
    request would break every assertion written against an instance the test already loaded, so
    the identity is preserved deliberately rather than by omission.

    Around that, it gives each request its own ``SAVEPOINT`` and mirrors what production's
    ``app.core.dependencies.get_db`` does with it. Production opens a session per request and
    closes it at the end, rolling back on the way out if the request raised; the request that
    follows therefore starts from committed state and nothing else. Yielding a long-lived shared
    session with no boundary at all does not reproduce that, it removes it: a request that
    autoflushed a row and then failed - a service that wrote and then raised ``Conflict``, a
    route that hit an ownership check after a write - used to leave that flushed work, and any
    lock it held, sitting in the session for the *next* request in the same test. The next
    request could then commit work it never performed, or fail on an aborted transaction for a
    reason belonging to its predecessor. Either way the suite certifies behaviour a clean
    request transaction would not exhibit, and it does so in an order-dependent way.

    So: a savepoint per request, rolled back if the request raises, and discarded if the request
    left it open. What survives a request is exactly what production would have kept - the work
    a service explicitly committed.

    Three mechanics worth stating, all measured on this stack
    --------------------------------------------------------
    * A service's ``session.commit()`` **succeeds** while this savepoint is open and releases
      both it and the session's own root savepoint, promoting the work into the outer
      transaction this file owns. So after a successful mutating request the handle is already
      inactive, which is why every use of it below is guarded by ``is_active``: rolling back a
      released handle raises ``ResourceClosedError``.
    * Rolling this savepoint back discards only what happened inside it. Instances loaded
      *before* the request stay loaded and readable - not expired - so a test can still read
      attributes off a factory-created row after a request failed, with no ``MissingGreenlet``.
    * The exception is re-raised untouched with a bare ``raise``, so ``app.core.exceptions``
      still renders the domain error the service raised. Swallowing it here would turn a 404
      into a 200 with an empty body, and preserving the traceback is why it is not ``raise
      error``.

    Nothing is committed here, exactly as production commits nothing in ``get_db``: transaction
    boundaries belong to the service layer, which knows when a unit of work is complete.

    Args:
        session: The test's transaction-scoped session, which every request must share.

    Returns:
        An async-generator dependency suitable for
        ``app.dependency_overrides[get_db]``. FastAPI resolves a dependency once per request, so
        one call means one savepoint per request; requests are sequential, so the savepoints
        never nest.
    """

    async def _override_get_db() -> AsyncIterator[AsyncSession]:
        # The request's own unit of work, nested inside the test's outer transaction.
        savepoint = await session.begin_nested()
        try:
            yield session
        except Exception:
            # Production rolls back before the connection returns to the pool; the equivalent
            # here is discarding this request's savepoint, which leaves everything the test set
            # up beforehand intact. Then `raise` with no argument, preserving the traceback.
            if savepoint.is_active:
                await savepoint.rollback()
            raise
        else:
            # The request returned. Anything still inside this savepoint is work no service
            # committed, and production would have discarded it when it closed the session - so
            # it is discarded here too, before the next request begins. After a service commit
            # the handle is already released and this is a no-op.
            if savepoint.is_active:
                await savepoint.rollback()

    return _override_get_db


@pytest.fixture(scope="session")
def app() -> Any:
    """Return the application object the suite drives.

    The same module-level object ``uvicorn app.main:app`` serves, imported once, so a test
    asserts against the application that actually ships rather than a second one built by a
    factory call with different arguments.

    Exposed as a fixture as well as being available by import because
    ``tests/integration/test_openapi_contract.py`` needs a documented way to reach
    ``app.openapi()`` directly: the documentation surface is environment-gated in ``app.main``
    - ``docs_url`` and ``redoc_url`` are withdrawn when ``settings.is_production`` - so a
    contract assertion that only ever went through ``GET /openapi.json`` would be coupled to
    that gate. Under ``ENVIRONMENT=test`` the gate is open and ``GET /openapi.json`` returns
    200, which is what AAP §0.9.4.3 requires; the fixture is the fallback that keeps the
    contract test meaningful either way.

    Returns:
        The :class:`~fastapi.FastAPI` instance. Annotated loosely so this module needs no
        import of the framework's application class purely for a type.
    """
    return fastapi_app


@pytest_asyncio.fixture(loop_scope="session")
async def client(db_session: AsyncSession) -> AsyncIterator[AsyncClient]:
    """Yield an HTTP client that drives the application in process, on the test's session.

    Three properties make this the centre of every integration test.

    **One session, shared.** The installed override yields the *same object* ``db_session``
    handed the test - not a new session on the same connection, and not a session from the
    application's own factory. That identity is what makes a row a factory created visible to
    the request, a row the request created visible to the test afterwards, and a single
    rollback sufficient to undo both.

    **One transaction boundary per request.** The override comes from
    :func:`_request_scoped_get_db`, so each request runs inside its own ``SAVEPOINT`` and that
    savepoint is rolled back if the request raises - the same rollback-on-exception production's
    ``get_db`` performs. Without it a request that autoflushed and then failed would leave its
    work in the shared session for the next request to commit or trip over. See that function
    for the whole contract.

    **No server.** ``AsyncClient(transport=ASGITransport(app=...))`` calls the ASGI
    application directly, so the suite needs nothing listening on any port - the in-process
    transport AAP §0.4.4.5 asks for. The transport is spelled out because httpx 0.28.1 removed
    the ``AsyncClient(app=...)`` shortcut; passing ``app=`` now raises :class:`TypeError`.

    ``ASGITransport`` runs no lifespan events, which is correct here rather than a shortfall.
    ``app.main``'s lifespan configures logging - already done at import - disposes
    ``app.db.session``'s engine, which this suite never draws a connection from because
    ``get_db`` is overridden, and warms the argon2 stand-in hash, which changes how long the
    first unknown-email login takes and nothing about what it answers. Nothing below depends on a
    lifespan side effect, and nothing should be made to.

    The override is removed in a ``finally``, so a failing test cannot leave the application
    pointed at a session that has since been rolled back and closed.

    Args:
        db_session: The transaction-scoped session this client must share.

    Yields:
        An anonymous client. It sends no ``Authorization`` header, so a request through it is
        unauthenticated unless the call supplies one; :func:`author_client` and
        :func:`admin_client` are the pre-authenticated counterparts, and
        :func:`auth_headers_for` mints a header for a one-off call.
    """

    fastapi_app.dependency_overrides[get_db] = _request_scoped_get_db(db_session)
    try:
        async with AsyncClient(
            transport=ASGITransport(app=fastapi_app),
            base_url=_BASE_URL,
        ) as http_client:
            yield http_client
    finally:
        fastapi_app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def override_get_db() -> Iterator[Callable[[Callable[..., Any]], None]]:
    """Yield an installer that swaps ``get_db`` and restores it afterwards, come what may.

    The general mechanism behind :func:`unavailable_database`, and the supported way for a test
    to substitute its own session provider - a session bound elsewhere, one that counts calls,
    or one that fails on a particular statement.

    Restoration happens in this fixture's teardown, so it runs when the test fails, when it
    errors and when it is interrupted. ``app.dependency_overrides`` is mutable state on a
    module-level object shared by every test in the session, so a leaked entry would not raise
    anywhere near the test that caused it; it would quietly redirect a later test that expected
    the real dependency.

    Yields:
        A callable taking the replacement dependency - normally an async generator function
        yielding a session - and installing it under ``get_db``. Call it as often as needed;
        the entry present before the first call is what gets restored.

    Examples:
        Driving ``GET /readyz`` to its 503 branch by hand, which
        :func:`unavailable_database` does for you::

            async def test_readyz_reports_unavailable(client, override_get_db):
                async def _broken():
                    yield _UnavailableSession()

                override_get_db(_broken)
                response = await client.get("/readyz")
                assert response.status_code == 503
    """
    sentinel = object()
    previous: Any = fastapi_app.dependency_overrides.get(get_db, sentinel)

    def install(dependency: Callable[..., Any]) -> None:
        fastapi_app.dependency_overrides[get_db] = dependency

    try:
        yield install
    finally:
        if previous is sentinel:
            fastapi_app.dependency_overrides.pop(get_db, None)
        else:
            fastapi_app.dependency_overrides[get_db] = previous


class _UnavailableSession:
    """Session-shaped stand-in whose every statement fails, for the readiness 503 path.

    Deliberately not an :class:`~sqlalchemy.ext.asyncio.AsyncSession` pointed at a dead host.
    That would work, but it would wait out a connect timeout on every call and make the failure
    mode depend on network behaviour; this fails instantly and identically on every machine.

    The failure has to happen **after** the route's dependencies have been resolved rather than
    while they are being resolved. :meth:`app.services.health_service.HealthService.check_readiness`
    wraps the one repository call in a ``try`` and converts any :class:`Exception` into the 503
    problem document, whereas an override that raised on the way in would fail during dependency
    resolution and surface as a 500 through the handler of last resort. So this object is yielded
    successfully and only :meth:`execute` raises.

    ``close`` and ``rollback`` are no-ops rather than absent, because a caller unwinding from
    the failure may reasonably invoke either.
    """

    #: Message the raised error carries. Names the cause without inventing a driver detail.
    failure_message: Final[str] = "test double: the database is deliberately unreachable"

    async def execute(self, *args: Any, **kwargs: Any) -> Any:
        """Raise instead of executing, whatever statement was passed.

        Args:
            *args: Ignored - the statement never runs.
            **kwargs: Ignored, for the same reason.

        Raises:
            OSError: Always. An operating-system level error is the closest honest analogue of
                a database that cannot be reached, and ``/readyz`` catches
                :class:`Exception` broadly, so the class matters only for readability.
        """
        del args, kwargs
        raise OSError(self.failure_message)

    async def close(self) -> None:
        """Accept a close, having nothing to close."""

    async def rollback(self) -> None:
        """Accept a rollback, having nothing to roll back."""


@pytest_asyncio.fixture(loop_scope="session")
async def unavailable_database(
    client: AsyncClient,
    override_get_db: Callable[[Callable[..., Any]], None],
) -> AsyncClient:
    """Return a client whose every request sees a database it cannot reach.

    Ready-made for ``tests/integration/test_health.py``, which has to prove that ``GET
    /readyz`` answers 503 while ``GET /healthz`` keeps answering 200 - AAP §0.9.4.4's health
    separation criterion, and the one behaviour that cannot be reached with a working database.

    :func:`client` is requested here rather than left to the test's signature, and that is not
    cosmetic: :func:`client` installs its own ``get_db`` override while it is being set up, so
    a test written ``(unavailable_database, client)`` would have the working override installed
    *after* this one and the failure would never happen. Depending on it makes this fixture
    resolve second whichever order the test names them in, and the same client object is
    returned, so a test may use either name.

    Restoration is :func:`override_get_db`'s job and therefore happens even when the test
    fails.

    Args:
        client: The in-process client, requested to force this fixture to resolve after it.
        override_get_db: The restoring installer.

    Returns:
        The same client :func:`client` yields, so the test can drive it directly.
    """

    async def _unavailable_db() -> AsyncIterator[_UnavailableSession]:
        yield _UnavailableSession()

    override_get_db(_unavailable_db)
    return client


# ---------------------------------------------------------------------------------------
# Identity and authentication
#
# Four accounts and one token minter, and nothing per-module. A fixture used by exactly one
# test module belongs in that module - keeping this set small is what stops it becoming the
# place every suite quietly adds its own setup to.
#
# Every account is built by tests.factories, which flushes rather than commits, so an account
# created here disappears with the rest of the test's transaction.
# ---------------------------------------------------------------------------------------


@pytest_asyncio.fixture(loop_scope="session")
async def reader_user(db_session: AsyncSession) -> User:
    """Create a ``READER`` account: authenticated, but privileged to do nothing special.

    The principal for the negatives that matter most - a signed-in visitor who may read,
    comment and like, and who must be refused by ``require_admin`` and by every ownership
    check. AAP §0.9.4.4 requires a non-admin ``GET /api/v1/admin/stats`` to answer 403, and
    this is the caller that proves it.

    Args:
        db_session: The transaction-scoped session.

    Returns:
        The persisted account, with ``id`` and both audit timestamps loaded from the row.
    """
    return await factories.create_reader(db_session)


@pytest_asyncio.fixture(loop_scope="session")
async def author_user(db_session: AsyncSession) -> User:
    """Create an ``AUTHOR`` account: the owner in every ownership test.

    The role is a real privilege boundary, not a label. Authoring **is** gated on it: all five
    post mutations declare ``AuthorUser``, so ``app.core.dependencies.require_author`` admits only
    ``AUTHOR`` and ``ADMIN`` and refuses a ``READER`` with 403 before a handler body runs, and
    ``app.services.post_service`` re-applies the same rule through ``ensure_can_author``. That is
    what makes an administrator's demotion to ``READER`` mean something.

    Authority on a mutation is then two rules rather than one - hold ``AUTHOR`` or ``ADMIN`` at
    all, and, unless holding ``ADMIN``, be the post's own author, which ``ensure_can_modify``
    decides by comparing ``posts.author_id``. So this fixture supplies the principal that
    satisfies the first and, paired with :func:`other_author_user`, lets a test isolate the
    second; a test that means to exercise the role boundary itself uses :func:`reader_user`.

    Args:
        db_session: The transaction-scoped session.

    Returns:
        The persisted account.
    """
    return await factories.create_author(db_session)


@pytest_asyncio.fixture(loop_scope="session")
async def other_author_user(db_session: AsyncSession) -> User:
    """Create a second, distinct ``AUTHOR`` account: the non-owner.

    The ownership negatives in AAP §0.9.4.4 need a principal who is authenticated, is not an
    administrator, and does not own the resource - "a non-owner, non-admin ``PATCH`` on someone
    else's post yields 403". A test cannot express that with one author, and reusing
    :func:`author_user` would assert the opposite of what it meant to.

    Distinctness is guaranteed by the factories' own process-monotonic counter, which is also
    what keeps the ``CITEXT`` unique constraints on ``users.email`` and ``users.username``
    satisfied - two accounts here never differ only by case.

    Args:
        db_session: The transaction-scoped session.

    Returns:
        The persisted account, with a different ``id``, email and username from
        :func:`author_user`.
    """
    return await factories.create_author(db_session)


@pytest_asyncio.fixture(loop_scope="session")
async def admin_user(db_session: AsyncSession) -> User:
    """Create an ``ADMIN`` account: the only principal that may cross ownership boundaries.

    The caller ``require_admin`` admits, and therefore the one every test under
    ``/api/v1/admin`` needs, as well as the positive half of each ownership negative - an
    administrator may patch or delete a post they do not own.

    Args:
        db_session: The transaction-scoped session.

    Returns:
        The persisted account.
    """
    return await factories.create_admin(db_session)


@pytest.fixture
def auth_headers_for() -> Callable[[User], dict[str, str]]:
    """Return a callable that mints an ``Authorization`` header for a given account.

    A callable rather than a header, because a test frequently needs two - the owner's and the
    non-owner's - and parameterising one fixture per account would multiply the fixture set for
    no gain.

    The token is minted directly through ``app.core.security.create_access_token`` and not by
    calling ``POST /api/v1/auth/login``. That is deliberate coupling avoidance: a regression in
    the login route then fails ``test_auth_api.py`` and nothing else, instead of failing every
    authenticated test in the suite and hiding which change actually broke. The claims are the
    same ones the login route issues - ``subject`` and ``role`` - so a token from here is
    indistinguishable to ``get_current_user`` from one a real login produced.

    Returns:
        A callable taking a persisted :class:`~app.models.User` and returning a one-entry
        mapping suitable for ``headers=`` on any httpx call.

    Examples:
        Asserting the ownership negative::

            async def test_patch_by_non_owner_is_forbidden(
                client, author_user, other_author_user, auth_headers_for, db_session
            ):
                post = await factories.create_post(db_session, author=author_user)
                response = await client.patch(
                    f"/api/v1/posts/{post.id}",
                    json={"title": "Hijacked"},
                    headers=auth_headers_for(other_author_user),
                )
                assert response.status_code == 403
    """

    def build(user: User) -> dict[str, str]:
        # `subject` is stringified because the JWT specification requires a string subject and
        # PyJWT refuses to serialise a UUID; `role` is a `UserRole`, which is a `str` subclass,
        # so it needs no conversion.
        token = create_access_token(subject=str(user.id), role=user.role)
        return {"Authorization": f"Bearer {token}"}

    return build


@pytest_asyncio.fixture(loop_scope="session")
async def author_client(
    db_session: AsyncSession,
    author_user: User,
    auth_headers_for: Callable[[User], dict[str, str]],
) -> AsyncIterator[AsyncClient]:
    """Yield a client that authenticates as :func:`author_user` on every request.

    Its **own** :class:`~httpx.AsyncClient`, sharing the test's session and the same
    ``get_db`` override. Mutating :func:`client`'s ``headers`` to achieve this instead would
    be a trap: the default header would persist for the remainder of the test, so a later
    request that meant to be anonymous - proving that ``POST /api/v1/posts`` answers 401
    without a token, say - would quietly succeed and the assertion would be meaningless.

    Both clients may be requested by the same test, and they see the same rows because they
    share one session.

    Args:
        db_session: The transaction-scoped session this client must share.
        author_user: The principal to authenticate as.
        auth_headers_for: The token minter.

    Yields:
        A client carrying ``Authorization: Bearer <token>`` for the author.
    """
    async with _authenticated_client(db_session, auth_headers_for(author_user)) as authenticated:
        yield authenticated


@pytest_asyncio.fixture(loop_scope="session")
async def admin_client(
    db_session: AsyncSession,
    admin_user: User,
    auth_headers_for: Callable[[User], dict[str, str]],
) -> AsyncIterator[AsyncClient]:
    """Yield a client that authenticates as :func:`admin_user` on every request.

    The counterpart to :func:`author_client` for the administrative namespace, where
    ``require_admin`` is applied at router level so no route can be reached without it. Built
    the same way, for the same reason: a separate client rather than mutated headers on the
    shared one.

    Args:
        db_session: The transaction-scoped session this client must share.
        admin_user: The principal to authenticate as.
        auth_headers_for: The token minter.

    Yields:
        A client carrying ``Authorization: Bearer <token>`` for the administrator.
    """
    async with _authenticated_client(db_session, auth_headers_for(admin_user)) as authenticated:
        yield authenticated


@asynccontextmanager
async def _authenticated_client(
    session: AsyncSession,
    headers: dict[str, str],
) -> AsyncIterator[AsyncClient]:
    """Yield a client with ``headers`` preset, bound to ``session`` through ``get_db``.

    The shared body of :func:`author_client` and :func:`admin_client`, extracted so the
    override-install-and-remove pair is written once. An async context manager rather than a
    bare async generator, and the difference is deterministic cleanup: consumed with ``async
    with``, the ``finally`` below runs the moment the calling fixture is torn down, whereas an
    ``async for`` left the inner generator to the event loop's asynchronous-generator
    finalisation hooks and the override's removal to whenever those happened to fire.

    The override is installed here as well as in :func:`client`, and installing it twice is
    harmless: both come from :func:`_request_scoped_get_db` over the same session object, and
    each caller's ``finally`` removes the entry. What would not be harmless is omitting it,
    because then a request through an authenticated client would resolve the *real* ``get_db``,
    open a connection from the application's own pool, and read a database in which none of the
    test's provisional rows exists.

    Built from that shared factory rather than from a local closure for the same reason it is
    shared at all: the per-request savepoint and its rollback-on-exception are the property both
    clients must have, and a second hand-written override is a second chance to omit it. That is
    precisely how the two overrides came to differ from production in the first place.

    Args:
        session: The session every request through the client must use.
        headers: Default headers for the client, normally one ``Authorization`` entry.

    Yields:
        The configured client.
    """
    fastapi_app.dependency_overrides[get_db] = _request_scoped_get_db(session)
    try:
        async with AsyncClient(
            transport=ASGITransport(app=fastapi_app),
            base_url=_BASE_URL,
            headers=headers,
        ) as http_client:
            yield http_client
    finally:
        fastapi_app.dependency_overrides.pop(get_db, None)


def login_form(email: str, password: str = DEFAULT_PASSWORD) -> dict[str, str]:
    """Build the body ``POST /api/v1/auth/login`` expects.

    A plain function rather than a fixture, so it can be called from anywhere including a
    parameterised case, and it exists to make two contract details impossible to get wrong.

    **It is a form, not JSON.** The route consumes
    :class:`~fastapi.security.OAuth2PasswordRequestForm`, so the payload must be passed as
    ``data=``. Sending it as ``json=`` answers 422 with ``Field required`` on ``username`` and
    ``password``, which looks like a bug in the route and is not one. This is also why
    ``python-multipart`` is a pinned runtime dependency. The sibling routes differ, and knowing
    which is which saves an afternoon: ``POST /api/v1/auth/refresh`` takes a JSON body, and
    ``POST /api/v1/auth/logout`` answers 204 with no body at all.

    **The field is called ``username`` and holds an email address.** The name is fixed by the
    OAuth2 password grant, but the route reads it as one - ``LoginRequest(email=
    form_data.username, ...)`` - and the service resolves the account by email alone. Passing
    an account's ``username`` therefore answers 401, indistinguishable from a wrong password,
    because the deliberately uniform wording on that route reveals nothing about which half of
    the credential was wrong. Hence the parameter here is named for what it must contain rather
    than for the wire field it lands in.

    Args:
        email: The account's email address, sent as the form's ``username`` field.
        password: The plaintext. Defaults to :data:`DEFAULT_PASSWORD`, which is what every
            account ``tests.factories`` creates is given, so a test that did not choose a
            password does not have to name one.

    Returns:
        A two-key mapping to pass as ``data=``.

    Examples:
        Logging in as a factory-created account::

            response = await client.post(
                "/api/v1/auth/login",
                data=login_form(author_user.email),
            )
            assert response.status_code == 200
    """
    return {"username": email, "password": password}
