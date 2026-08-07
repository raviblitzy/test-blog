"""Package marker for ``app.api``, the versioned HTTP boundary of the service tier.

``app.api`` is the outermost layer of the backend. It is the only place a route is
declared, and it is where every request enters and every response leaves. It sits at
the top of the one-way dependency chain the service is built on - routes delegate to
services, services delegate to repositories, repositories own the queries, models own
the schema - and nothing beneath it ever imports upwards into here.

Exactly one version namespace lives below this marker, and there is deliberately no
``v2``:

* ``v1/router.py`` - the aggregate ``api_router``, which collects the eight domain
  routers behind one prefix with consistent OpenAPI tags. ``app.main`` mounts that
  single object at ``/api/v1``, so no domain router is registered on the application
  directly and no path can escape the version prefix by omission.
* ``v1/routers/`` - nine modules: the eight domain routers ``auth``, ``users``,
  ``posts``, ``categories``, ``comments``, ``likes``, ``admin`` and ``health``, each
  exposing a module-level ``router``, beside the package marker that makes them
  importable.

The import forms this marker makes resolvable, every one of them absolute because
``ban-relative-imports`` is set to ``all`` for the whole backend:

* ``from app.api.v1.router import api_router`` - the aggregate, mounted by
  ``app.main`` at ``/api/v1``.
* ``from app.api.v1.routers import health``, or equivalently
  ``from app.api.v1.routers.health import router`` - the liveness and readiness
  probes, which ``app.main`` mounts unprefixed.
* ``from app.api.v1.routers.<name> import router`` - a single domain router, imported
  by ``v1/router.py`` and by nothing else.

``GET /healthz`` and ``GET /readyz``, registered by ``app.api.v1.routers.health``, are
the only unversioned paths in the entire service. Every other route is reached through
the aggregate and so carries the ``/api/v1`` prefix by construction. Those two are
exempt because they are infrastructure rather than product: ``/healthz`` has to answer
without touching the database, which is why ``backend/Dockerfile`` aims its
``HEALTHCHECK`` at it, and an orchestrator has to be able to probe both before anything
has told it which API version to speak.

Apart from this docstring the module is empty, and that is a correctness requirement
rather than a matter of taste. ``app.main`` reaches into this subtree along two
independent paths - ``app.api.v1.router`` for the versioned mount and
``app.api.v1.routers.health`` for the unprefixed one - and Python executes this file
before either target. A convenience re-export of the aggregate here would therefore
make importing the health probe alone pull in all eight domain routers, and behind them
the services, the repositories, the entire declarative model tree and the live async
engine in ``app.db.session``. It would also close a cycle: ``v1/router.py`` imports
``v1/routers/*``, and every one of those sits inside the package whose ``__init__``
would still be mid-execution. The cheapest thing in the service has to stay as cheap
at import time as it is at request time, so consumers reach for the module they
actually need and never for this package.

Nothing else belongs here either. No router and no route, so this file can never become
an unversioned mount point. No dependency and nothing security-bearing:
``get_current_user`` and ``require_admin`` are reachable only from
``app.core.dependencies``, which gives the administrator gate exactly one spelling and
no alternate path around it. No response shape, because the page envelope is
``app.core.pagination.Page`` and the single problem document is
``app.schemas.common``. No setting and no environment read, because ``app.core.config``
is the only module in the repository permitted to read it.

A version constant is deliberately absent as well. The one the service has belongs to
``app/__init__.py``: it is the single source of the version ``app.main`` publishes in
its OpenAPI document, and it is kept identical to ``[project] version`` in
``backend/pyproject.toml``. A second declaration here would be a second source of
truth for a value the served API document states out loud.
"""
