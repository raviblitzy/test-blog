"""Package marker for ``app.core``, the cross-cutting foundation of the service tier.

``app.core`` is the root of the backend import graph. Every layer above it -
``app.db``, ``app.models``, ``app.repositories``, ``app.services``, ``app.schemas``,
``app.middleware`` and ``app.api`` - depends on the modules gathered here, and this
package depends on none of them in return. That one-way relationship is what keeps the
layer boundaries reviewable, so it must never be inverted.

The eight sibling modules this marker makes importable, in dependency order, own the
concerns that have no other single owner:

* ``config`` - the typed settings contract over the environment, and the only module in
  the repository permitted to read it. Root of the graph.
* ``pagination`` - the page envelope (``items``, ``total``, ``page``, ``page_size``,
  ``pages``) every list endpoint returns, so one client control can page them all.
* ``slug`` - collision-safe derivation of the URL-safe slugs behind canonical post and
  category URLs, written once at creation time and stable thereafter.
* ``logging`` - structured logging configuration, emitting JSON outside development.
* ``exceptions`` - the domain exception hierarchy plus the handlers that render every
  failure as one machine-readable problem document.
* ``security`` - argon2id password hashing and verification, access-token issuance, and
  refresh-token generation, hashing and decoding.
* ``rate_limit`` - the limiter and the decorators guarding the authentication routes.
* ``dependencies`` - request-scoped injection: the database session, the resolved
  principal, the administrator guard and the normalised pagination parameters.

Consumers import from the individual module rather than from this package, and always
by absolute path, because ``ban-relative-imports`` is set to ``all`` for the whole
backend: the settings object is reached as ``app.core.config.settings``, never as
``app.core.settings``. The distribution package is rooted at ``backend/``, so it is
``app`` and never ``backend.app``.

Apart from this docstring the module is empty, and that is a correctness requirement
rather than a matter of taste. ``backend/alembic.ini`` deliberately declares no
``sqlalchemy.url``: ``backend/migrations/env.py`` takes the connection URL from
``app.core.config`` so that the application and the migration runner share a single
source of truth. Resolving ``app.core`` therefore has to stay cheap and free of side
effects. A convenience re-export of ``dependencies`` here would pull ``app.db.session``,
and with it a live async engine, plus the entire declarative model tree into every
``alembic upgrade head``, ``alembic downgrade base`` and ``alembic check`` run - purely
as a side effect of importing the parent package, before any migration was asked for.

``__version__`` is deliberately absent as well, here and in every other package marker
including ``app/__init__.py``. ``[project] version`` in ``backend/pyproject.toml`` is the
single source of the version ``app.main`` publishes in its OpenAPI document, read from that
project metadata; a declaration in any module would be a second source of truth.
"""
