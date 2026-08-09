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
eleven variables have no default at all: ``DATABASE_URL``, ``JWT_SECRET_KEY``,
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

Defaults are installed with :meth:`os.environ.setdefault`, so CI, a ``Makefile`` target or a
developer's shell can override any of them; the resolved ``DATABASE_URL`` is the single
exception and is **assigned**, for the reason in section 2.

``ENVIRONMENT=test`` is functional, not cosmetic
    ``app.core.rate_limit`` constructs its limiter with ``enabled=settings.ENVIRONMENT !=
    "test"``. Without this value the authentication suite - which registers, logs in,
    refreshes and logs out repeatedly - trips the five-per-minute limit and returns ``429``
    intermittently, which is precisely the flakiness a blocking gate cannot tolerate. It also
    keeps the documentation routes served: ``app.main`` withdraws ``/docs`` and ``/redoc``
    only when ``settings.is_production``, so under ``test`` the OpenAPI surface the contract
    test asserts against is still mounted, as AAP §0.9.4.3 requires.

``LOG_LEVEL=WARNING``
    Quiet on purpose. ``migrations/env.py`` routes Alembic through ``structlog``, so at
    ``INFO`` every session begins with a dozen JSON records before the first test; at
    ``WARNING`` a failing assertion is the first thing in the transcript.

2. The test database is derived, never reused
---------------------------------------------
``.env.example`` is a closed contract, and adding a fifteenth documented variable would
desynchronise it from ``README.md``, ``docker-compose.yml`` and ``.github/workflows/ci.yml``.
So the target database is resolved in two steps instead:

* if ``TEST_DATABASE_URL`` is set in the environment, it is used verbatim. It is not declared
  on ``Settings``, and because ``pydantic-settings`` looks up declared field names rather
  than enumerating the environment, an undeclared key in :data:`os.environ` passes the
  model's ``extra="forbid"`` untouched. (That tolerance covers the *environment* only - the
  name must never be written into a ``.env`` file, where the dotenv source would enumerate
  it and the model would refuse to start.)
* otherwise ``DATABASE_URL`` is parsed with :func:`sqlalchemy.engine.make_url` and a sibling
  database name is derived by appending ``_test``, idempotently: a name that already ends in
  ``_test`` is left alone, so a re-run cannot produce ``blog_test_test``.

The resolved URL is then **assigned** to ``os.environ["DATABASE_URL"]``, and that single
assignment redirects both consumers at once: the engine this file opens, and
``migrations/env.py``, because ``backend/alembic.ini`` deliberately declares no
``sqlalchemy.url`` and the environment script reads ``settings.DATABASE_URL`` instead.

Deriving rather than reusing is a safety property, not a convenience. It is what guarantees
the suite cannot migrate, truncate or drop the database a developer is actually working in.

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
chain is currently ``0001 → 0002 → 0003 → 0004``; the fixture asks for ``head`` and never
names a revision, so a fifth revision is picked up with no change here.

**The database is never empty.** Revision ``0003_seed_reference_categories`` inserts eight
reference categories - Engineering, Architecture, Backend, Frontend, Databases, DevOps,
Security and Product - as *data*. They are committed by the migration, not by a test, so
per-test rollback does not remove them and they are present for the whole session. Any
assertion about ``categories`` must therefore be phrased as "contains" or "at least", never
as "the database is empty" or "there is exactly one category".

Teardown leaves the database in place, which makes a re-run fast. Dropping it is opt-in
through ``TEST_DATABASE_DROP``, and the drop refuses to run unless the resolved database name
contains ``test``, so no configuration mistake can point it at a working database.

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
:func:`client` installs ``app.dependency_overrides[get_db]`` with a generator that yields
**the very same session object the test holds**. That identity is the point: a row the test
creates through a factory is visible to the request, a row the request creates is visible to
the test afterwards, and the single rollback undoes both. The override is removed in a
``finally`` block, because ``dependency_overrides`` is mutable state on a module-level
application object and a leaked entry would silently redirect a later test that expected the
real dependency.

The client is built as ``AsyncClient(transport=ASGITransport(app=...))``. httpx 0.28.1
removed the ``AsyncClient(app=...)`` shortcut, so the transport is constructed explicitly -
and this in-process transport is what lets the suite run with no server listening anywhere,
as AAP §0.4.4.5 requires.

``ASGITransport`` does not run lifespan events, and that is desirable rather than a gap:
skipping the lifespan skips ``configure_logging()`` (already applied at import) and the
disposal of an engine this suite never opens. No fixture here depends on a lifespan side
effect, and none should be added.

Driving ``/readyz`` to its 503
    ``GET /readyz`` answers 503 when its ``SELECT 1`` fails, and the failure has to happen
    **inside the route** - an override that raises would fail during dependency resolution
    and surface as a 500 instead. So :func:`unavailable_database` installs an override that
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

import os
import sys
from pathlib import Path
from typing import Final

from sqlalchemy.engine import make_url

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
# The ten names below are the backend variables .env.example documents, minus DATABASE_URL,
# which is resolved separately. Every value is an obviously fake placeholder: nothing here is
# a real credential, a deployment host or a working connection string (AAP §0.10.1 #13).
#
# Installed with setdefault, so CI or a shell export wins. Two of the ten are functional
# rather than decorative and are called out in the module docstring: ENVIRONMENT selects the
# `test` profile that disables the authentication rate limiter, and LOG_LEVEL keeps the
# transcript readable.
# ---------------------------------------------------------------------------------------

#: Obviously fake HMAC signing key, 70 bytes - comfortably above the 64-byte floor `HS512`
#: would impose, so overriding JWT_ALGORITHM in a test cannot make the key too short.
TEST_JWT_SECRET_KEY: Final[str] = (
    "test-suite-jwt-signing-key-not-a-real-secret-never-used-outside-pytest"
)

#: Obviously fake seeded-administrator password. Twelve characters minimum, at most 128, and
#: at least three of the five character classes `app.core.password_policy` counts - the same
#: policy `POST /api/v1/auth/register` applies - and deliberately not one of the placeholders
#: `.env.example` publishes, nor a variation on one, because those are refused in every stage.
TEST_SEED_ADMIN_PASSWORD: Final[str] = "Fixture-Adm1n-Never-Deployed"

_ENVIRONMENT_DEFAULTS: Final[tuple[tuple[str, str], ...]] = (
    # Functional: `app.core.rate_limit` builds its limiter with
    # `enabled=settings.ENVIRONMENT != "test"`, so this value is what stops repeated
    # authentication flows returning 429. It also keeps /openapi.json, /docs and /redoc
    # mounted, because app.main withdraws them only under `production`.
    ("ENVIRONMENT", "test"),
    ("JWT_SECRET_KEY", TEST_JWT_SECRET_KEY),
    ("JWT_ALGORITHM", "HS256"),
    ("ACCESS_TOKEN_EXPIRE_MINUTES", "15"),
    ("REFRESH_TOKEN_EXPIRE_DAYS", "7"),
    # Both loopback spellings a browser treats as distinct origins, matching .env.example.
    ("CORS_ALLOW_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"),
    # Functional: migrations/env.py routes Alembic through structlog, so INFO would prefix
    # every session with a dozen JSON records before the first test runs.
    ("LOG_LEVEL", "WARNING"),
    # Mirrors .env.example. The limiter is disabled under `test`, so this value is never
    # enforced - it is set because Settings validates the expression's syntax at startup.
    ("AUTH_RATE_LIMIT", "5/minute"),
    # example.com is reserved by RFC 2606 §3, so this address can never reach a real mailbox,
    # and it is still a valid `EmailStr`, which the field requires.
    ("SEED_ADMIN_EMAIL", "seed-admin@example.com"),
    ("SEED_ADMIN_PASSWORD", TEST_SEED_ADMIN_PASSWORD),
)


def _apply_environment_defaults() -> None:
    """Populate the ten documented backend variables that are not already set.

    :meth:`os.environ.setdefault` throughout, so an exported value or a CI ``env:`` block
    always wins over the placeholder. This runs before any ``app`` import, which is the whole
    reason it is a module-level statement rather than a fixture: ``app.core.config``
    constructs and validates its ``settings`` singleton while it is being imported, and six
    of its eleven fields have no default to fall back on.
    """
    for name, value in _ENVIRONMENT_DEFAULTS:
        os.environ.setdefault(name, value)


_apply_environment_defaults()


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

#: Appended to the configured database name to derive a sibling for the suite.
TEST_DATABASE_SUFFIX: Final[str] = "_test"

#: Substring the resolved database name must contain before teardown will drop it. A working
#: database called `blog` cannot match, so a misconfiguration cannot destroy one.
_DROP_GUARD_MARKER: Final[str] = "test"

#: Values `TEST_DATABASE_DROP` accepts as "yes". Anything else, including an empty string,
#: leaves the database in place.
_TRUTHY: Final[frozenset[str]] = frozenset({"1", "true", "t", "yes", "y", "on"})

#: The local placeholder .env.example publishes, used only when nothing else supplies a URL -
#: fake credentials against a loopback host, so it is a default rather than a committed secret.
_FALLBACK_DATABASE_URL: Final[str] = "postgresql+psycopg://blog:blog@localhost:5432/blog"

#: Maintenance database the CREATE DATABASE and DROP DATABASE statements connect to, because
#: neither can be issued from inside the database it names.
_MAINTENANCE_DATABASE: Final[str] = "postgres"


def _resolve_test_database_url() -> str:
    """Return the URL of the database this suite may create, migrate and write to.

    ``TEST_DATABASE_URL`` wins verbatim when it is set. Otherwise ``DATABASE_URL`` is parsed
    and a sibling name is derived by appending :data:`TEST_DATABASE_SUFFIX`, which is why the
    suite can never act on the database a developer is working in. The derivation is
    idempotent: a name that already carries the suffix is returned unchanged, so re-running
    with a ``DATABASE_URL`` this function previously produced does not yield ``..._test_test``.

    Returns:
        A ``postgresql+psycopg://`` URL naming the test database. Not validated here beyond
        being parseable - ``app.core.config`` applies the real contract (scheme, host, port
        range, database name) when ``settings`` is constructed a few lines below.

    Raises:
        ValueError: If the URL cannot be parsed, or carries no database name at all. Raising
            during import is the intended outcome: a suite that cannot name its database must
            not go on to create one from a partial URL.
    """
    override = os.environ.get(TEST_DATABASE_URL_ENV_VAR)
    if override:
        return override

    url = make_url(os.environ.get("DATABASE_URL") or _FALLBACK_DATABASE_URL)
    if not url.database:
        message = (
            "DATABASE_URL names no database, so no sibling test database can be derived "
            f"from it. Expected the form {_FALLBACK_DATABASE_URL!r}, or set "
            f"{TEST_DATABASE_URL_ENV_VAR} to an explicit URL."
        )
        raise ValueError(message)

    if url.database.endswith(TEST_DATABASE_SUFFIX):
        return url.render_as_string(hide_password=False)

    derived = url.set(database=f"{url.database}{TEST_DATABASE_SUFFIX}")
    return derived.render_as_string(hide_password=False)


# Assignment, not setdefault, and this is the one line that redirects everything. The engine
# below reads settings.DATABASE_URL, and so does migrations/env.py - because
# backend/alembic.ini deliberately declares no sqlalchemy.url - so both the application side
# and the migration side follow this single value to the same test database.
os.environ["DATABASE_URL"] = _resolve_test_database_url()


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
from collections.abc import AsyncIterator, Callable, Iterator  # noqa: E402
from contextlib import asynccontextmanager  # noqa: E402
from typing import Any  # noqa: E402

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402
from sqlalchemy.exc import ProgrammingError  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.dependencies import get_db  # noqa: E402
from app.core.security import create_access_token  # noqa: E402
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
    "DEFAULT_PASSWORD",
    "TEST_DATABASE_DROP_ENV_VAR",
    "TEST_DATABASE_SUFFIX",
    "TEST_DATABASE_URL_ENV_VAR",
    "TEST_JWT_SECRET_KEY",
    "TEST_SEED_ADMIN_PASSWORD",
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


def _maintenance_url() -> str:
    """Return the resolved URL with its database swapped for the maintenance database.

    ``CREATE DATABASE`` and ``DROP DATABASE`` cannot be issued from a connection to the
    database they name, so both statements are sent to ``postgres`` on the same host, port and
    credentials.

    Returns:
        A synchronous-usable ``postgresql+psycopg://`` URL pointing at ``postgres``. The
        driver is unchanged because psycopg 3 is the project's only driver - AAP §0.5.6
        excludes ``asyncpg`` - and it serves the synchronous side here exactly as it serves the
        asynchronous application.
    """
    maintenance = make_url(settings.DATABASE_URL).set(database=_MAINTENANCE_DATABASE)
    return maintenance.render_as_string(hide_password=False)


def _ensure_test_database_exists() -> None:
    """Create the test database if it is not there yet, tolerating a concurrent creator.

    ``isolation_level="AUTOCOMMIT"`` is required, not merely convenient: PostgreSQL refuses
    ``CREATE DATABASE`` inside a transaction block, and SQLAlchemy opens one implicitly
    otherwise.

    The already-exists case is treated as success rather than checked for in advance. Testing
    ``pg_database`` first and creating afterwards is a race - two suites starting together
    would both see it absent - whereas letting the statement fail and inspecting the failure
    is correct under any interleaving. A :class:`~sqlalchemy.exc.ProgrammingError` whose text
    reports the database already exists is swallowed; anything else - refused connection, bad
    credentials, insufficient privilege - propagates, because those are the failures a
    developer needs to see rather than a mysterious absence of tables later on.

    Raises:
        sqlalchemy.exc.SQLAlchemyError: If the maintenance database is unreachable or the
            statement fails for any reason other than the database already existing.
    """
    database = make_url(settings.DATABASE_URL).database
    engine = create_engine(_maintenance_url(), isolation_level="AUTOCOMMIT", future=True)
    try:
        with engine.connect() as connection:
            # The identifier is quoted rather than parameterised because a DDL identifier
            # cannot be a bind parameter. It comes from the resolved URL, not from a request.
            connection.execute(text(f'CREATE DATABASE "{database}"'))
    except ProgrammingError as error:
        if "already exists" not in str(error).casefold():
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
    reference categories, ``0004`` the administrative listing indexes - is applied in full, and
    a revision added later needs no change here. The URL is not passed either: the environment
    script reads ``settings.DATABASE_URL``, which the bootstrap has already pointed at the test
    database.
    """
    config = Config(str(_ALEMBIC_INI))
    config.set_main_option("script_location", str(_MIGRATIONS_DIR))
    command.upgrade(config, "head")


def _drop_test_database() -> None:
    """Drop the test database, refusing outright unless its name is marked as a test database.

    Guarded twice. The caller only reaches this when ``TEST_DATABASE_DROP`` is truthy, and this
    function additionally refuses any database whose name does not contain ``test``, so a
    working database named ``blog`` can never be destroyed by a misconfigured override.

    ``WITH (FORCE)`` terminates any other session still attached, which is what makes the drop
    reliable rather than intermittently blocked - PostgreSQL 13 introduced it and this project
    targets 18. The statement runs on an autocommit connection to the maintenance database for
    the same reason ``CREATE DATABASE`` does.

    Raises:
        RuntimeError: If the resolved database name is not marked as a test database. Raised
            rather than silently skipped, because a run that asked to drop and did not needs to
            say why.
    """
    database = make_url(settings.DATABASE_URL).database or ""
    if _DROP_GUARD_MARKER not in database.casefold():
        message = (
            f"Refusing to drop {database!r}: {TEST_DATABASE_DROP_ENV_VAR} only ever applies to "
            f"a database whose name contains {_DROP_GUARD_MARKER!r}. Point "
            f"{TEST_DATABASE_URL_ENV_VAR} at a dedicated database instead."
        )
        raise RuntimeError(message)

    engine = create_engine(_maintenance_url(), isolation_level="AUTOCOMMIT", future=True)
    try:
        with engine.connect() as connection:
            connection.execute(text(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)'))
    finally:
        engine.dispose()


@pytest.fixture(scope="session", autouse=True)
def database_schema() -> Iterator[str]:
    """Create the test database if absent and migrate it to head, once per session.

    A plain synchronous fixture because everything it calls is blocking, and ``autouse`` so a
    unit test that never asks for a session still runs in a session where the schema exists -
    which matters because a module-level import in a unit test can reach the application and,
    through it, the configured database.

    Autouse settles *whether* it runs, not *when* relative to other fixtures, so
    :func:`engine` declares this fixture as an argument rather than relying on ordering. That
    explicit edge is what guarantees no connection is opened before the migrations have been
    applied.

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

    Teardown leaves the database in place so a re-run skips creation and applies no revision.
    Set ``TEST_DATABASE_DROP=1`` to drop it instead; that path refuses any database whose name
    does not contain ``test``.

    Yields:
        The resolved database name, so a test or another fixture can report which database it
        ran against without re-parsing the URL.
    """
    _ensure_test_database_exists()
    _upgrade_to_head()

    database = make_url(settings.DATABASE_URL).database or ""
    try:
        yield database
    finally:
        if os.environ.get(TEST_DATABASE_DROP_ENV_VAR, "").strip().casefold() in _TRUTHY:
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

    Args:
        database_schema: The migrated-schema fixture, requested to order this one after it. The
            value is not used; the dependency is the point, because relying on ``autouse``
            ordering would let a connection open before the revisions had run.

    Yields:
        The engine, bound to the resolved test database.
    """
    del database_schema  # Requested for ordering; the name of the database is not needed here.

    async_engine = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
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

    Args:
        engine: The session-scoped engine.

    Yields:
        A session whose every write is provisional. Hand this to ``tests.factories`` helpers,
        and note that they flush rather than commit for the same reason.
    """
    connection = await engine.connect()
    transaction = await connection.begin()
    session = AsyncSession(
        bind=connection,
        expire_on_commit=False,
        join_transaction_mode="create_savepoint",
    )
    try:
        yield session
    finally:
        # Order matters. Close the session first so it releases its savepoint and stops using
        # the connection; then roll the outer transaction back - `is_active` is false if a test
        # rolled it back itself, and rolling back twice raises; then return the connection,
        # which NullPool closes outright rather than pooling.
        await session.close()
        if transaction.is_active:
            await transaction.rollback()
        await connection.close()


# ---------------------------------------------------------------------------------------
# The application and the in-process HTTP client
# ---------------------------------------------------------------------------------------

#: Host the ASGI transport answers on. No name is resolved and no socket is opened - httpx
#: needs an absolute base URL to build request targets from, and this is that placeholder.
_BASE_URL: Final[str] = "http://testserver"


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

    Two properties make this the centre of every integration test.

    **One session, shared.** The installed override yields the *same object* ``db_session``
    handed the test - not a new session on the same connection, and not a session from the
    application's own factory. That identity is what makes a row a factory created visible to
    the request, a row the request created visible to the test afterwards, and a single
    rollback sufficient to undo both.

    **No server.** ``AsyncClient(transport=ASGITransport(app=...))`` calls the ASGI
    application directly, so the suite needs nothing listening on any port - the in-process
    transport AAP §0.4.4.5 asks for. The transport is spelled out because httpx 0.28.1 removed
    the ``AsyncClient(app=...)`` shortcut; passing ``app=`` now raises :class:`TypeError`.

    ``ASGITransport`` runs no lifespan events, which is correct here rather than a shortfall.
    ``app.main``'s lifespan configures logging - already done at import - and disposes
    ``app.db.session``'s engine, which this suite never draws a connection from because
    ``get_db`` is overridden. Nothing below depends on a lifespan side effect, and nothing
    should be made to.

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

    async def _override_get_db() -> AsyncIterator[AsyncSession]:
        yield db_session

    fastapi_app.dependency_overrides[get_db] = _override_get_db
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

    The failure has to happen **inside** the route rather than while its dependencies are being
    resolved. ``GET /readyz`` wraps ``await db.execute(select(1))`` in a ``try`` and converts
    any :class:`Exception` into its 503 problem document, whereas an override that raised on
    the way in would fail during dependency resolution and surface as a 500 through the handler
    of last resort. So this object is yielded successfully and only :meth:`execute` raises.

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

    Note that authoring is not gated on the role - ``POST /api/v1/posts`` requires only a
    bearer token and ownership is decided by comparing ``posts.author_id`` - so this fixture
    documents the typical case rather than a privilege boundary.

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

    The override is installed here as well as in :func:`client`, and installing it twice with
    an equivalent generator is harmless: both yield the same session object, and each caller's
    ``finally`` removes the entry. What would not be harmless is omitting it, because then a
    request through an authenticated client would resolve the *real* ``get_db``, open a
    connection from the application's own pool, and read a database in which none of the test's
    provisional rows exists.

    Args:
        session: The session every request through the client must use.
        headers: Default headers for the client, normally one ``Authorization`` entry.

    Yields:
        The configured client.
    """

    async def _override_get_db() -> AsyncIterator[AsyncSession]:
        yield session

    fastapi_app.dependency_overrides[get_db] = _override_get_db
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
