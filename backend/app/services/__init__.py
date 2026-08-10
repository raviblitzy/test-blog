"""The service layer's public surface: every business rule the API tier is allowed to reach.

Eight modules sit beside this one - seven for the bounded pieces of the blog domain and one for
the readiness verdict - and together they are the only place in the backend where a business
rule is settled or an authority check made.
This file is what makes them a single named surface rather than eight addresses every router has
to learn separately: ``app.api.v1.routers.*`` imports the services it needs from here, so the
ten names listed at the foot of this module *are* the contract between the layer that speaks
HTTP and the layer that decides what an operation means. A router reaching past this surface into
a deep module path has not broken anything, but it has started splitting one contract into
several, which is the drift this barrel exists to prevent.

There is a second, blunter reason the file has to exist at all. Without it ``app/services/`` is
merely an implicit namespace package - it still imports, so the omission never announces itself,
but the package has no ``__init__`` to declare a public surface, nothing stops a directory of the
same name elsewhere on ``sys.path`` from contributing to it, and ``from app.services import
PostService`` - the spelling every router uses - resolves to nothing at all. A regular package
with a declared surface is the fix.

The ten names this package publishes
------------------------------------
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
* :class:`~app.services.health_service.HealthService` - the readiness verdict behind
  ``GET /readyz``: one round trip, a classification of whatever went wrong drawn from
  :data:`~app.services.health_service.ReadinessFailureClass`, and the
  disclosure rule that keeps a driver's host, port, database and user out of both the response
  and the log. The one member that settles no *domain* rule, and it is here because the
  layering rule has no exemption for a probe - see its module docstring.

Why two functions sit beside eight classes
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
rediscovered eight times below.

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
  that knows when an operation is *complete*, and that is here.

  The rule is one sentence: **a read commits nothing, and a successful write commits exactly once,
  after the last of its steps.** "Exactly once" is the part worth stating, because the failure it
  rules out looks harmless. A method that commits inside a guarded block and again after it has two
  logical boundaries where the contract allows one, and the second is either a no-op - which invites
  a reader to conclude the first was optional - or worse, a boundary drawn after a step the guard
  no longer covers. "After the last of its steps" is the other half: every read the response needs -
  a re-read with relations, an aggregate, a projected count - happens *before* the commit, so a
  transient failure can never return an error for work the database has already accepted. Where a
  method takes a row lock to make a decision hold, the same commit is what releases it. Counting the
  commits per module is not a useful check and no count is quoted here; what is checkable is that
  every one of them is the last statement of a completed unit of work rather than a flush in
  disguise, and that no successful path reaches two.

  A service does not *choose* to undo, and it never closes a session - ``get_db`` owns the session
  and rolls back whenever an exception leaves the request, so a domain exception raised from the
  middle of a multi-step write leaves nothing behind. But four of these modules do issue an explicit
  ``rollback``, and it is a requirement rather than an exception to the rule above.
  ``auth_service``, ``post_service``, ``comment_service`` and ``category_service`` each translate an
  ``IntegrityError`` - a slug already claimed, a category filed concurrently, an account registered
  a moment ago - into a ``ConflictError``. Once a flush or commit has aborted, SQLAlchemy refuses
  every further statement on that session until it is rolled back, so without the rollback the
  domain error would be followed by a second, unrelated failure: any caller that catches the
  conflict and continues - the idempotent seeder, a test asserting on it, a composing
  administrative operation - would find the session unusable, and ``get_db`` would have nothing left
  to close cleanly. The rollback is therefore what makes the conflict *reportable*; it is issued
  first, before the domain error is raised, and ``get_db``'s own rollback remains the safety net
  behind it rather than the mechanism.
* **Domain objects out, typed exceptions up.** A service returns a mapped instance, a page of
  them, or a schema, and it signals failure with the typed domain errors declared in
  ``app.core.exceptions`` rather than a framework exception. Turning ``NotFoundError`` into a 404
  problem document belongs to the handlers ``app.main`` registers once, which is what keeps one
  error contract for the whole surface instead of one per call site.

The import direction runs one way
---------------------------------
This file imports its eight siblings. **No sibling imports this package.** Four real edges run
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
Beyond the eight imports there is nothing in this file. Nothing *here* builds an engine, a session
factory or a connection pool, nothing here reads the environment, nothing here configures a log
handler, and there is no constant, no convenience factory and no ``__version__`` - ``[project]
version`` in ``backend/pyproject.toml`` is the single source of the version ``app.main``
publishes.

What the eight imports transitively pull in is worth stating precisely rather than waving at,
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
    assert set(services.__all__) == set(dir(services)) & set(services.__all__)

A name in the list that does not resolve is not a lint finding; it is an ``ImportError`` the first
time anything imports this package, which means it is a start-up failure of the whole service.

The second half is deliberately expressed as a relationship rather than as a count. A literal
``len(...) == n`` here would be a second declaration of the export set, drifting the first time a
service was added or withdrawn - which is exactly what happened to the number that used to be
written here. ``backend/tests/integration/test_openapi_contract.py`` carries the one enumeration
that is asserted rather than asserted-about.
"""

# The import edge runs ONE WAY: this file imports all eight siblings, and no sibling may ever
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
from app.services.health_service import HealthService
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
# natural order, then everything else - which is why the two predicates trail the eight services.
__all__ = [
    "AdminService",
    "AuthService",
    "CategoryService",
    "CommentService",
    "HealthService",
    "LikeService",
    "PostService",
    "ProfileService",
    "can_view_post",
    "visible_statuses_for",
]
