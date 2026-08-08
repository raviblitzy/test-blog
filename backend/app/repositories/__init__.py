"""The data-access layer's public surface: every repository the service layer may reach for.

Six modules sit beside this one - the generic base and the five that own a relation apiece - and
together they are the only place in the backend that builds a SQL statement. This file is what
makes them a single named surface rather than six addresses each caller has to learn separately:
``app.services`` imports the repositories it needs from here, so the classes listed at the foot of
this module *are* the contract between the layer that decides business rules and the layer that
runs queries. A service reaching past this surface into a deep module path has not broken
anything, but it has started splitting one contract into several, which is the drift this barrel
exists to prevent.

What every module in this package is, and is not
-----------------------------------------------
The uniformity is the whole value of naming the layer, so it is stated once here rather than
rediscovered six times below.

* **Queries and only queries.** A module in this package composes statements - predicates, joins,
  ordering, relevance ranking, windowing - and does nothing else. It settles no business rule,
  resolves no principal and decides no authority; ``app.services`` owns all three, which is why
  an ownership check appears in a service and never in a repository. ``post_repository`` is the
  single home of feed composition in particular, so search ranking, category joins, author
  filtering and status scoping are written once and every list surface reaches them by one door.
* **Session-bound.** Every repository takes the request-scoped
  :class:`~sqlalchemy.ext.asyncio.AsyncSession` in its constructor and holds it for exactly one
  unit of work. None of them constructs a session, opens a connection, reads configuration or
  owns the transaction: the caller supplies the session - ``get_db`` in ``app.core.dependencies``
  in the API tier, the transactional fixture in the suite - and the caller decides when to commit.
* **Domain objects out, never HTTP artefacts.** A single read returns a mapped instance or
  ``None``. A list surface returns a ``(rows, total)`` tuple, and that shape is what lets one page
  envelope serve the home feed, an author's profile, the author workspace and every
  administrative table identically. Nothing here raises an HTTP exception, sets a status code or
  builds a response model: a missing row is ``None``, and turning ``None`` into a 404 is the
  service's decision to make.

The import direction runs one way
---------------------------------
This file imports its six siblings. **No sibling imports this package.** Every concrete
repository reaches its base class at the module that declares it, naming whichever of the two
matches its relation's key shape::

    from app.repositories.base import UUIDPrimaryKeyRepository  # five id-keyed relations
    from app.repositories.base import BaseRepository  # post_likes, keyed on a pair

Spelling that ``from app.repositories import BaseRepository`` instead would be a genuine circular
import rather than a matter of taste. Resolving this package means running the import block below,
and that block is still part-way through when the sibling turns round and asks the half-built
package for a name it has not bound yet - an ``ImportError`` at start-up, not a warning. The rule
is therefore short: inside this package always name the module, and from outside it always name
the package.

No import-time side effects
---------------------------
Beyond the six imports there is nothing here. Nothing builds a connection pool or a session
factory, nothing issues a schema-creation or DDL call, nothing configures a log handler, nothing
reads the environment, and there is no constant and no convenience factory - nor any import of
``app.core.config``, of ``app.db.session`` or of the application module. Importing this package
pulls in ``app.db.base`` and the declarative model tree the siblings map against, and stops
there. That is what keeps it cheap enough for the suite to drive the API in-process with nothing
configured and no database reachable, and it is the same contract the deliberately empty markers
at ``app``, ``app.core``, ``app.db`` and ``app.api`` keep for a sharper reason - each of those
sits on the path ``migrations/env.py`` walks, where an eager side effect would open a connection
on every ``alembic check`` before any migration had been asked for.

One boundary the restraint protects
-----------------------------------
``app.models`` is the single metadata view autogeneration and drift detection read, and this
package must not become a second one. It re-exports the classes that *query* the schema - never
the schema itself, and never :class:`~app.db.base.Base`, which stays at its one address so that
no question can arise about which metadata collection is authoritative.
"""

from __future__ import annotations

from app.repositories.base import BaseRepository, ModelT, UUIDPrimaryKeyRepository
from app.repositories.category_repository import CategoryRepository
from app.repositories.comment_repository import CommentRepository
from app.repositories.like_repository import LikeRepository
from app.repositories.post_repository import PostRepository, PostSort
from app.repositories.user_repository import RefreshTokenRepository, UserRepository

# Every name above is imported purely to be re-exported and none is referenced inside this module,
# which is precisely the shape the unused-import rule exists to catch. `__all__` is what separates
# a deliberate public surface from an oversight, and it earns its place twice over: it satisfies
# pyflakes without a per-line suppression, and it tells the strict type checker that these names
# are re-exported rather than incidentally visible, which `no_implicit_reexport` would otherwise
# refuse to accept. It is also the contract the service layer is held to - dropping a name here
# does not break this module, it pushes some future caller back onto a deep module path and splits
# the surface in two.
#
# The ordering is the linter's isort-style ordering for `__all__`. Every name is class-cased, so
# that reduces to plain alphabetical order and a new repository has exactly one obvious insertion
# point.
__all__ = [
    "BaseRepository",
    "CategoryRepository",
    "CommentRepository",
    "LikeRepository",
    "ModelT",
    "PostRepository",
    "PostSort",
    "RefreshTokenRepository",
    "UUIDPrimaryKeyRepository",
    "UserRepository",
]
