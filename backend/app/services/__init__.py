"""The service layer's public surface: every business rule the API tier is allowed to reach.

Seven modules sit beside this one, one per bounded piece of the blog domain, and together they
are the only place in the backend where a business rule is settled or an authority check made.
This file is what makes them a single named surface rather than seven addresses every router has
to learn separately: ``app.api.v1.routers.*`` imports the services it needs from here, so the
nine names listed at the foot of this module *are* the contract between the layer that speaks
HTTP and the layer that decides what an operation means. A router reaching past this surface into
a deep module path has not broken anything, but it has started splitting one contract into
several, which is the drift this barrel exists to prevent.

There is a second, blunter reason the file has to exist at all. Without it ``app/services/`` is
merely an implicit namespace package - it still imports, so the omission never announces itself,
but the package has no ``__init__`` to declare a public surface, nothing stops a directory of the
same name elsewhere on ``sys.path`` from contributing to it, and ``from app.services import
PostService`` - the spelling every router uses - resolves to nothing at all. A regular package
with a declared surface is the fix.

The nine names this package publishes
-------------------------------------
* :class:`~app.services.auth_service.AuthService` - registration, credential verification,
  token-pair issuance, refresh rotation with reuse detection, revocation on logout (R1).
* :class:`~app.services.category_service.CategoryService` - the taxonomy's lifecycle: the slug
  derived at creation, the two uniqueness rules, the in-use guard that stops a delete from
  silently unfiling posts, and the read projections the filter control and admin table render.
* :class:`~app.services.post_service.PostService` - the post lifecycle and the feed: create,
  edit, delete, publish and unpublish (R2), and search, category filtering and windowing (R3).
* :func:`~app.services.post_service.visible_statuses_for` and
  :func:`~app.services.post_service.can_view_post` - the draft-confidentiality rule in its list
  form and its single-resource form. The next section explains why they are published here.
* :class:`~app.services.comment_service.CommentService` - the discussion and its moderation:
  threaded replies, ownership-scoped edit and delete, and three moderation states (R4).
* :class:`~app.services.like_service.LikeService` - like, unlike and the like summary, made
  idempotent by a composite primary key rather than by de-duplicating in Python (R4).
* :class:`~app.services.profile_service.ProfileService` - public author profiles and the
  self-service write behind them, hard-filtered to published posts (R5).
* :class:`~app.services.admin_service.AdminService` - the single administrator-only surface over
  users, posts, comments and categories, plus the aggregate overview counts (R11).

Why two functions sit beside seven classes
------------------------------------------
:func:`~app.services.post_service.visible_statuses_for` and
:func:`~app.services.post_service.can_view_post` are pure predicates over a viewer and a post,
and between them they are the *single declaration* of the rule that a draft belongs to its author
and to an administrator and to nobody else. ``comment_service`` and ``like_service`` import
``can_view_post`` rather than restate it, so a comment thread and a like count on an invisible
draft are invisible for exactly the reason the draft is.

Publishing them is deliberate rather than incidental. Authority lives in this layer precisely so
that the rule can be exercised without an HTTP request, and ``tests/unit/test_permissions.py``
does exactly that: it constructs a viewer and a post and asserts the predicate, with no client,
no route and no database. Exporting the two functions gives that suite one obvious import path
and keeps the rule visible in the layer's front door rather than buried behind a class it is not
a method of.

What every module in this package is, and is not
------------------------------------------------
The uniformity is the whole value of naming the layer, so it is stated once here rather than
rediscovered seven times below.

* **Business rules and authority, and nothing else.** A service decides what an operation means
  and who may perform it - an author may act only on their own post, an administrator on any -
  and that comparison is made here and nowhere else, so the rule holds whichever entry point
  invokes it. A service composes no SQL, because ``app.repositories`` owns every statement, and
  it speaks no HTTP, because ``app.api`` owns the wire.
* **Session-injected, never session-owning.** Every class takes the request-scoped
  :class:`~sqlalchemy.ext.asyncio.AsyncSession` in its constructor and holds it for exactly one
  unit of work. None of them imports ``app.db.session``, so a service cannot open a connection of
  its own and cannot read configuration. The caller supplies the session - ``get_db`` in the API
  tier, the transactional fixture in the suite - and that single uniform constructor is what lets
  a router build any service from the one session it was handed.
* **This layer draws the transaction boundary, and each mutating method commits its own unit of
  work.** ``app.repositories`` flushes and never commits, and ``get_db`` commits nothing on the
  way out - deliberately, because an automatic commit there would persist a half-finished use
  case, exactly what a transaction exists to prevent. So the boundary has to be drawn somewhere
  that knows when an operation is *complete*, and that is here: a read commits nothing, and a
  write commits once, on success, after the last of its steps. There are twenty-five such commits
  across the seven service modules - seven in ``post_service``; four each in ``admin_service``,
  ``auth_service`` and ``comment_service``; three in ``category_service``; two in
  ``like_service``; and one in ``profile_service.update_self`` - and every one of them is the last
  statement of a completed unit of work rather than a flush in disguise.

  What a service never does is *undo*. It issues no ``rollback`` and closes no session:
  ``get_db`` owns both, so a domain exception raised anywhere in this layer unwinds through it and
  the whole unit of work is discarded together. That is why a service can raise from the middle of
  a multi-step write - a slug derived, categories associated, and then a conflict - and leave
  nothing behind.
* **Domain objects out, typed exceptions up.** A service returns a mapped instance, a page of
  them, or a schema, and it signals failure with the typed domain errors declared in
  ``app.core.exceptions`` rather than a framework exception. Turning ``NotFoundError`` into a 404
  problem document belongs to the handlers ``app.main`` registers once, which is what keeps one
  error contract for the whole surface instead of one per call site.

The import direction runs one way
---------------------------------
This file imports its seven siblings. **No sibling imports this package.** Four real edges run
inside this folder, and every one of them names the module it needs rather than this package::

    from app.services.post_service import can_view_post  # comment_service, like_service
    from app.services.category_service import CategoryService  # admin_service
    from app.services.comment_service import CommentService  # admin_service

Spelling any of those ``from app.services import ...`` instead would be a genuine circular import
rather than a matter of taste. Resolving this package means running the import block below, and
that block is still part-way through when the sibling turns round and asks the half-built package
for a name it has not bound yet - an ``ImportError`` at start-up, not a warning. This folder
carries more intra-folder edges than any other in the backend, so the hazard is correspondingly
likelier here than where the same rule is written for ``app.repositories``. The rule is therefore
short: inside this package always name the module, and from outside it always name the package.

No import-time side effects
---------------------------
Beyond the seven imports there is nothing in this file. Nothing *here* builds an engine, a session
factory or a connection pool, nothing here reads the environment, nothing here configures a log
handler, and there is no constant, no convenience factory and no ``__version__`` - ``[project]
version`` in ``backend/pyproject.toml`` is the single source of the version ``app.main``
publishes.

What the seven imports transitively pull in is worth stating precisely rather than waving at,
because the honest answer is larger than "the service modules" and the difference has misled a
reader before. Resolving this package loads ``app.core``, ``app.db``, ``app.models``,
``app.repositories`` and ``app.schemas`` - and ``app.db.session`` specifically, because
``app.core.dependencies`` imports ``AsyncSessionLocal`` from it to build ``get_db``, and that
module constructs the :class:`~sqlalchemy.ext.asyncio.AsyncEngine` at module level. So an engine
object *does* come into being behind this import, and saying otherwise would be wrong.

It remains cheap and safe all the same, for a reason that is a property of the engine rather than
of this file: ``create_async_engine`` opens no connection. The pool connects on first checkout, so
importing this package emits no SQL, performs no DNS lookup and opens no socket - measured, with
an unreachable ``DATABASE_URL`` and no environment file present, and by counting the pool's
connections afterwards, which is zero. That is what lets the suite drive the API in-process with
nothing configured and no database running. ``app.main`` is deliberately *not* in the closure: a
service is reachable without the application that mounts it.

The restraint here is therefore a matter of degree rather than of kind, and the difference is
worth naming. The deliberately empty markers at ``app``, ``app.core``, ``app.db`` and ``app.api``
are empty for a *sharper* reason: each sits on the path ``migrations/env.py`` walks, where an
eager re-export would construct the application on every ``alembic check`` before any migration
had been asked for. ``app.services`` is not on that path - ``env.py`` reaches ``app.models``,
``app.db.base`` and two ``app.core`` modules, and never this one - so re-exporting here is safe
where re-exporting there would not be. The asymmetry between the two kinds of barrel is
intentional and not an inconsistency.

Verifying completeness
----------------------
The property this file answers for reduces to two assertions, and both are cheap to make with
nothing configured and no database running::

    from app import services

    assert [name for name in services.__all__ if not hasattr(services, name)] == []
    assert len(services.__all__) == 9

A name in the list that does not resolve is not a lint finding; it is an ``ImportError`` the first
time anything imports this package, which means it is a start-up failure of the whole service.
"""

# The import edge runs ONE WAY: this file imports all seven siblings, and no sibling may ever
# import `app.services`. A sibling that needs a peer names that peer's module directly -
# `comment_service` and `like_service` do so for `can_view_post`, and `admin_service` for
# `CategoryService` and `CommentService`. Rewriting any of them as
# `from app.services import ...` would close a real circular import through this barrel: the
# block below would still be part-way through when the sibling asked the half-built package for a
# name it had not bound yet, and the result is an ImportError at start-up rather than a warning.
# This is the one rule a future contributor can break here without noticing, so it is written
# where the imports are and not only in the docstring above.
#
# The order below is the linter's isort ordering - a single first-party block, alphabetical by
# module path - so it is deliberately NOT dependency order (`auth`, `category`, `post`,
# `comment`, `like`, `profile`, `admin`). Nothing here depends on the order: because each sibling
# reaches its peer directly, every module is fully built before this block asks it for a name. A
# mechanically checked order gives a future service exactly one insertion point.
from app.services.admin_service import AdminService
from app.services.auth_service import AuthService
from app.services.category_service import CategoryService
from app.services.comment_service import CommentService
from app.services.like_service import LikeService
from app.services.post_service import PostService, can_view_post, visible_statuses_for
from app.services.profile_service import ProfileService

# Every name above is imported purely in order to be re-exported and none is referenced inside
# this module, which is precisely the shape the unused-import rule exists to catch. `__all__` is
# what separates a deliberate public surface from an oversight, and it earns its place three times
# over: it satisfies pyflakes without a per-line suppression, it tells the strict type checker
# that these names are re-exported rather than incidentally visible under its
# `no_implicit_reexport` setting, and it is the contract the routers and the unit suite hold this
# file to. A blanket suppression comment would satisfy the first of the three and silently forfeit
# the other two.
#
# The list is deliberately NARROWER than the union of the siblings' own `__all__`s. The write-side
# bleach allow-lists, the lifecycle status tuples and the reply-depth ceiling stay at their own
# module addresses: each is the internal of one rule, and a router reaching for
# `CONTENT_ALLOWED_TAGS` would be settling a sanitisation policy its service already owns. No
# repository appears for the same reason - `app.repositories` is their front door - and no
# underscore-prefixed helper appears because a private name is private.
#
# The ordering is the linter's isort-style ordering for `__all__` - class-cased names first in
# natural order, then everything else - which is why the two predicates trail the seven services.
__all__ = [
    "AdminService",
    "AuthService",
    "CategoryService",
    "CommentService",
    "LikeService",
    "PostService",
    "ProfileService",
    "can_view_post",
    "visible_statuses_for",
]
