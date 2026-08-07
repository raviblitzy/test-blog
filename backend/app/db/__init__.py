"""Package marker for ``app.db``, the data-layer package of the service tier.

``app.db`` owns the connection to PostgreSQL and the declarative foundation every
mapped class is built on. It sits directly above ``app.core``, from which it takes the
connection URL and nothing else, and directly below ``app.models``, which subclasses
its declarative base, and ``app.repositories``, which issues every query through the
session it hands out. Nothing here imports from the layers above, so the dependency
arrow through this package points one way only and stays reviewable.

The three sibling modules this marker makes importable, in dependency order:

* ``base`` - the declarative foundation. It carries the ``Base`` class and the shared
  ``MetaData``, the index and constraint naming convention that gives every key a
  predictable and migration-stable name, and the UUID primary-key and timestamp mixins
  that make identity and audit columns server-generated rather than client-supplied.
* ``session`` - the async engine built from ``app.core.config`` and the session factory
  layered over it. ``app.core.dependencies.get_db`` yields one request-scoped session
  from that factory and guarantees its close; the ``app.main`` lifespan disposes the
  engine on shutdown.
* ``seed`` - idempotent reference data: the category set, the administrator account and
  the demonstration posts that make the feed, the category filter and the pagination
  controls exercisable against a freshly migrated database.

Consumers address those modules directly, and always by absolute path, because
``ban-relative-imports`` is set to ``all`` for the whole backend: the declarative base
is reached as ``app.db.base`` and the session factory as ``app.db.session``, never
through this package. Every concern therefore stays addressable at exactly one module
path, so a reader looking for the engine finds it in ``session`` and nowhere else.

Apart from this docstring the module is empty, and the emptiness is load-bearing
rather than stylistic. ``backend/alembic.ini`` sets ``prepend_sys_path = .`` and
declares no ``sqlalchemy.url``, so ``backend/migrations/env.py`` imports ``app.db.base``
for ``Base.metadata`` and takes the connection URL from ``app.core.config`` - one
source of truth shared by the application and the migration runner. Python executes a
parent package before its submodule, so this file runs first on every
``alembic upgrade head``, ``alembic downgrade base`` and ``alembic check`` invocation.

That is why nothing is hoisted here. Re-exporting ``engine`` or ``AsyncSessionLocal``
from ``session`` would construct the async engine as a side effect of every migration
command, before any migration had been asked for. Re-exporting a seed helper would drag
``app.core.security``, ``app.core.slug`` and the whole ``app.models`` tree in behind
it. Re-exporting ``Base``, ``metadata``, ``UUIDPrimaryKeyMixin`` or ``TimestampMixin``
is no better: every mapped class imports them from ``app.db.base``, so lifting them
into the parent closes an import cycle through this very file.

The same restraint is what lets ``backend/tests/conftest.py`` drive the application
in-process over an httpx ASGI transport with no live server: resolving ``app.db`` has
to succeed with no database reachable and no environment configured, and it does,
because it reads neither.

``__version__`` is deliberately absent as well. It belongs to ``app/__init__.py``, the
single source of the version ``app.main`` publishes in its OpenAPI document; a second
declaration here would be a second source of truth.
"""
