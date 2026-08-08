"""The per-request wrapper layer: everything that runs around a request rather than inside it.

Two members, one job each. :class:`RequestContextMiddleware` gives every request a correlation
identifier, binds it so that any line any layer logs carries it, returns it to the caller on
:data:`REQUEST_ID_HEADER` and emits the one access-log line saying how the request ended.
:class:`SecurityHeadersMiddleware` applies the baseline security headers to the response. Neither
runs a query, resolves a principal or decides authority; those belong to ``app.repositories``,
``app.core.dependencies`` and ``app.services`` respectively.

Registration order is load-bearing, and this is the first file in the package a reader opens, so
it is stated here rather than left to be inferred. ``app.main`` registers
:class:`SecurityHeadersMiddleware` **first** and :class:`RequestContextMiddleware` **last**;
``Starlette.add_middleware`` inserts at the front of the chain, so first-registered ends up
innermost and last-registered outermost::

    RequestContextMiddleware       <- registered last, so outermost: correlates and logs
      CORSMiddleware
        SecurityHeadersMiddleware  <- registered first, so innermost: hardens the response
          ExceptionMiddleware -> Router -> endpoint

Innermost is what puts :class:`SecurityHeadersMiddleware` just outside ``ExceptionMiddleware``, so
every problem document ``app.core.exceptions`` renders is hardened exactly like a 200; registering
it further out would silently strip those headers from every error response.

Both import forms are correct and resolve to the same objects - this barrel for the usual case,
the module path when a single member is wanted::

    from app.middleware import RequestContextMiddleware, SecurityHeadersMiddleware
    from app.middleware.security_headers import SecurityHeadersMiddleware
"""

from __future__ import annotations

# ---------------------------------------------------------------------------------------
# Why this marker re-exports while `app/__init__.py` and `app/core/__init__.py` stay empty
#
# The asymmetry is deliberate, not an oversight. `backend/alembic.ini` sets
# `prepend_sys_path = .` so `migrations/env.py` can `import app` to reach `app.db.base` and
# `app.models`; a convenience re-export in either of those two markers would therefore
# construct the async engine and pull in the whole declarative model tree as a side effect
# of every `alembic upgrade`, `alembic downgrade` and `alembic check`, before any migration
# was asked for. Resolving this package costs nothing comparable: its two members reach only
# `app.core` (config, logging, exceptions), the standard library and Starlette's types - no
# `app.db`, no `app.models`, no engine, no connection, and no logging configuration, which
# `app.main` still owns as the single `configure_logging()` call in its lifespan. So importing
# `app.middleware` stays free, and the names below are re-exports and nothing else: this
# module declares no class, function or constant of its own and has no import-time effect.
# ---------------------------------------------------------------------------------------
from app.middleware.request_context import (
    REQUEST_ID_HEADER,
    RequestContextMiddleware,
    get_request_id,
)
from app.middleware.security_headers import SecurityHeadersMiddleware

# Explicit, and functional rather than decorative: it is what makes the four re-exports above
# legitimate both to pyflakes, which would otherwise report each as unused, and to mypy's
# strict `no_implicit_reexport` - which is why a blanket lint-suppression comment is not used
# instead. Sorted so a future member has one obvious insertion point, in the same order the
# two sibling modules use: constants, then classes, then functions.
__all__ = [
    "REQUEST_ID_HEADER",
    "RequestContextMiddleware",
    "SecurityHeadersMiddleware",
    "get_request_id",
]
