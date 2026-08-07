"""Blog service application package.

The layered FastAPI application behind the blog platform: ``api`` holds the
routers, ``services`` the business rules and authority checks, ``repositories``
every database query, ``models`` the SQLAlchemy mappings, ``schemas`` the
request and response contracts, ``middleware`` the per-request wrappers, ``db``
the engine and session factory, and ``core`` the cross-cutting concerns -
configuration, security, dependencies, pagination and logging.

The distribution package is named ``app`` and is rooted at ``backend/``, not
``backend.app``, so every intra-package import is absolute and spelled from that
root: ``from app.core.config import settings``. The canonical ASGI entry point
is ``app.main:app``, served by ``uvicorn app.main:app --reload`` from inside
``backend/``.

This module deliberately imports nothing and has no import-time side effects,
and the restraint is load-bearing rather than stylistic. ``alembic.ini`` sets
``prepend_sys_path = .`` so that ``migrations/env.py`` can ``import app`` to
reach ``app.db.base`` for ``Base.metadata`` and ``app.models`` so autogeneration
sees every mapped class. Re-exporting anything from ``app.main`` here would
construct the FastAPI application, open the async engine, register the
middleware chain and attach the rate limiter as a side effect of every
``alembic upgrade head``, ``alembic downgrade base`` and ``alembic check``.
Nothing beyond the version constant below belongs in this file.
"""

# Kept identical to `[project] version` in backend/pyproject.toml. app.main
# passes this constant to FastAPI(version=...), so the packaging metadata and the
# served OpenAPI document have a single source of truth and cannot disagree.
__version__: str = "1.0.0"

__all__ = ["__version__"]
