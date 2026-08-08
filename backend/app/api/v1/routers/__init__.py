"""Package marker for ``app.api.v1.routers``, the route modules behind ``/api/v1``.

Nine modules make up this package: the eight that declare routes - ``auth``, ``users``,
``posts``, ``categories``, ``comments``, ``likes``, ``admin`` and ``health`` - beside this
marker, whose whole job is to make them reachable as ``app.api.v1.routers.<name>``.

Where a path and a tag are decided is fixed, and it is not here. Each of the seven domain
modules constructs a bare ``APIRouter()`` and registers every operation on a path relative
to it, so ``posts`` spells its collection ``@router.get("")`` and its detail route
``@router.get("/{slug}")``, and the string ``/api/v1/posts`` appears in no decorator.
``app.api.v1.router`` supplies the other half: it attaches the prefix and the OpenAPI tag
on each of its eight ``include_router`` calls - eight over seven modules, because
``comments`` exposes two router objects, one for the thread nested under a post and one for
the top-level edit and delete routes - and ``app.main`` mounts that single aggregate at
``/api/v1``. So the prefix is written once, no route can leave the version namespace by
forgetting it, and no tag can drift away from the section it groups.

``health`` is the one deliberate exception. It sets ``tags=["health"]`` on its own router
and registers ``/healthz`` and ``/readyz`` as absolute paths, because ``app.main`` mounts it
directly rather than through the aggregate, and unprefixed: an orchestrator has to be able
to probe liveness and readiness before anything has told it which API version to speak.

Apart from this docstring the module is empty, and that is a correctness requirement rather
than a matter of taste, because this file sits on the load path of the cheapest route in the
service. ``app.main`` reaches into the subtree two independent ways - ``app.api.v1.router``
for the versioned mount, ``app.api.v1.routers.health`` for the unprefixed one - and Python
executes this file on both. A convenience re-export here, an ``auth_router`` alias for
``app.api.v1.routers.auth.router`` or any of its seven siblings, would therefore make
resolving the health probe alone pull in all eight route modules, and behind them the
services, the repositories, the whole declarative model tree and the live async engine in
``app.db.session``. ``GET /healthz`` has to answer without touching the database, which is
what ``backend/Dockerfile`` aims its ``HEALTHCHECK`` at, so opening an engine in order to
serve it would defeat the point of the probe.

Such a barrel would not merely be expensive, either; it would not load at all.
``app.api.v1.router`` reaches the seven domain modules through this very package, so this
``__init__`` is still mid-execution when the first of them is requested, and the re-export
would close the cycle on itself. The rule that follows is short: name the module you
actually need, ``app.api.v1.routers.health``, and never this package.

Nothing else belongs here. No ``APIRouter`` and no route, so this file can never become a
mount point that sidesteps the aggregate and the version prefix with it. No dependency and
nothing security-bearing: ``get_current_user`` and ``require_admin`` are reachable only
through ``app.core.dependencies``, which gives the administrator gate one spelling and no
way around it. And no ``__version__``: that belongs to ``app/__init__.py`` alone, the single
source of the version ``app.main`` publishes in its OpenAPI document and the one kept
identical to the ``[project]`` version in ``backend/pyproject.toml``.
"""
