"""The contract layer's front door: every wire shape this service accepts or returns, in one place.

Eight sibling modules declare those shapes, and this file is what makes them addressable as a set.
``from app.schemas import PostDetail`` resolves here, and so does every response model a router
binds and every request body it annotates. That is the entire job: this file re-exports, and it
declares nothing of its own.

Where these declarations came from
---------------------------------
The branch this supersedes carried its whole contract in a handful of lines. ``app.py`` imported
the Pydantic model base at line 2 and declared ``Item`` - ``id: int``, ``name: str``,
``price: float`` - at lines 9-12, immediately beside the five handlers that used it. That single
type served create, read-one, read-all and update at once, which is why no route there could state
what it returned, and none did. The eight modules beneath this one are where that declaration
went: one module per aggregate, a distinct type per direction and per projection, and a declared
response model on every route as the consequence.

Why re-exporting is correct here and forbidden two directories up
----------------------------------------------------------------
``app/core/__init__.py`` and ``app/db/__init__.py`` hold a docstring and nothing else. This file
deliberately holds more, and the difference is load-bearing rather than a drift to be tidied away
- so before emptying this one to match those two, read this section.

``migrations/env.py`` reaches ``app.core.config`` for the connection URL and ``app.db.base`` for
the shared metadata on every ``alembic upgrade head``, ``alembic downgrade base`` and
``alembic check``. Both of those paths run through those two package markers. A re-export placed
in either would construct the async engine, or pull in the whole declarative tree, as a side
effect of every migration command - before any migration had been asked for. Their emptiness is a
correctness requirement, and it is specific to where they sit.

Nothing on this path has that property. Resolving this package loads :mod:`pydantic`, the eight
siblings, :class:`~app.core.pagination.Page`, and the three enumerations the siblings take from the
mapped-relation package rather than redeclaring - ``UserRole``, ``PostStatus`` and
``CommentStatus``. It reaches no engine, no session, no connection, no typed configuration object,
no service, no router and no application factory, and it performs no work at import time beyond
binding the names below. ``import app.schemas`` therefore succeeds with nothing configured and no
database reachable, which is what lets the suite drive the API in-process. SQLAlchemy does appear
in that closure, because each of those three enumerations is persisted by the column that declares
it and so lives beside its relation; a connection to PostgreSQL does not.

That last property is load-bearing and was not free. Because a package initialises before any of
its submodules, **anything one sibling imports, this path imports** - and ``app.schemas.auth``
used to take its password bounds from ``app.core.config``, which constructs the settings
singleton at module scope. ``import app.schemas`` consequently failed with six ``Field required``
validation errors - ``DATABASE_URL``, ``JWT_SECRET_KEY``, ``CORS_ALLOW_ORIGINS``, ``ENVIRONMENT``,
``SEED_ADMIN_EMAIL``, ``SEED_ADMIN_PASSWORD`` - on any machine without a full environment, which
is exactly the opposite of what the paragraph above claims. The rule now lives in
``app.schemas.auth`` itself, beside the request body that publishes it, and ``app.core.config``
imports it from there instead - so the claim is true rather than aspirational, and the one
declaration is still one declaration. Anything added to a sibling from here on inherits the same
obligation: a settings read placed in any one of the eight makes all thirty-two names
unreachable without a configured deployment.

Two names have one source, not two
----------------------------------
``CategoryCreate`` and ``CategoryUpdate`` are published by two siblings: ``app.schemas.category``
declares them, and ``app.schemas.admin`` re-exports them, because the administrative category
routes accept exactly the shapes the public taxonomy contract already defines. Each is one object
rather than two - ``app.schemas.admin.CategoryCreate is app.schemas.category.CategoryCreate``
holds at run time.

Each is therefore imported below from ``app.schemas.category`` alone, the module that declares it.
Taking them from both would bind one name twice in this namespace: a redefinition, reported by the
linter and by the strict type checker, and a real ambiguity for anyone later asking which address
is canonical. From ``app.schemas.admin`` this file takes only the seven types that module declares
itself.

What is deliberately absent
---------------------------
This surface is thirty-two names and nothing else: twenty-nine models;
:data:`~app.schemas.post.PostSortOption`, the enumerated alias that types the ``sort`` query
parameter of ``GET /api/v1/posts``; and the two members of the documented-failure contract,
:func:`~app.schemas.common.problem_response` and
:data:`~app.schemas.common.ProblemResponses`. The alias is here for the same reason every model
is - a router binds it to describe a request - and so are the last two: every router in the
service attaches the response objects that helper builds, and what it names is
:class:`~app.schemas.common.ProblemDetail`, which is already on this list. The test of membership
is exactly that: a shape or vocabulary that crosses the wire belongs here, and nothing else does.
Three categories of name are kept off it on purpose, and each exclusion is a decision rather than
an omission.

*Validation bounds.* ``app.schemas.auth`` publishes ten of them - the password and username
length limits, the character-group table, the refresh-token ceiling. None is re-exported here, and
the asymmetry that would otherwise follow is the reason: the other seven siblings all keep their
own bounds off their own public lists, so lifting one module's would advertise this package as the
place to find ``PASSWORD_MIN_LENGTH`` while ``BODY_MAX_LENGTH`` next door raised an attribute
error. Every one of them stays reachable at its single address,
``from app.schemas.auth import PASSWORD_MIN_LENGTH``, which is where a bound belongs: beside the
annotated type that enforces it. ``app.schemas.common.SearchTerm`` and its
``MAX_SEARCH_TERM_LENGTH`` are reached the same way, from the module that declares them, by the
two routers that accept a ``?q=``.

*Mapped relations.* Nothing from the mapped-relation package is re-exported, and this is a
boundary rather than a preference. An entity reachable as ``app.schemas.User`` would read as an
invitation to hand a database row to a route directly, which is precisely what ``app.schemas.user``
exists to prevent - it publishes the projections that withhold the password digest, the address
and the active flag from a public reader. A front door offering a way around that distinction
would quietly undo it.

*Errors and behaviour.* The domain-exception hierarchy stays in ``app.core``, where the handlers
registered on the application render it as one problem document. The page envelope stays where
:class:`~app.core.pagination.Page` is declared and reaches callers through ``app.schemas.common``,
the one indirection this package allows itself. No version marker is declared here either:
``app/__init__.py`` is the single source of the version the OpenAPI document publishes.

Consumers of this surface
-------------------------
* ``app.api.v1.routers.*`` - every route's declared response model, and every request body it
  accepts, is one of the types below. This is the consumer the file exists for, and the reason
  the list is a published contract rather than a convenience.
* ``app.services.*`` - accepts and returns these types at the boundary it presents to the routers.
* ``app.main`` - the generated OpenAPI document names every one of them among its component
  schemas, which is what makes the contract machine-readable.
* The integration suite, which walks that document and asserts every operation declares a
  response schema.

Dropping a name from :data:`__all__` is a breaking change to all four. Adding a type to a sibling
without adding it here leaves that type reachable only by its module path - legal, but it means
the front door and the rooms behind it disagree, so the list is maintained in the same change that
adds the type.

Verifying completeness
----------------------
The property this file answers for reduces to two assertions, and both are cheap to make with
nothing configured and no database running::

    import app.schemas as schemas

    assert [name for name in schemas.__all__ if not hasattr(schemas, name)] == []
    assert len(schemas.__all__) == 32

A name in the list that does not resolve is not a lint finding; it is an ``ImportError`` the first
time anything imports this package, which means it is a start-up failure of the whole service.

"Cheap, with nothing configured" is the third assertion, and it is the one that regressed once
already: the import above must succeed in a process with **no** environment file and **no**
backend variable exported. Measured that way after the move described above - previously six
``Field required`` errors, now a clean import.
"""

from app.schemas.admin import (
    AdminComment,
    AdminCommentStatusUpdate,
    AdminPost,
    AdminPostStatusUpdate,
    AdminStats,
    AdminUser,
    AdminUserUpdate,
)
from app.schemas.auth import LoginRequest, RefreshRequest, RegisterRequest, TokenPair
from app.schemas.category import CategoryCreate, CategoryPublic, CategorySummary, CategoryUpdate
from app.schemas.comment import CommentCreate, CommentPublic, CommentUpdate
from app.schemas.common import (
    Page,
    ProblemDetail,
    ProblemResponses,
    ValidationErrorItem,
    problem_response,
)
from app.schemas.like import LikeSummary
from app.schemas.post import PostCreate, PostDetail, PostSortOption, PostSummary, PostUpdate
from app.schemas.user import UserMe, UserPublic, UserUpdate

# Every name above is imported solely in order to be re-exported, and none is referenced inside
# this module - the textbook shape the unused-import rule exists to catch. `__all__` is what
# separates a deliberate public surface from an oversight, and it earns its place three times
# over: it satisfies pyflakes without a per-line suppression, it tells the strict type checker
# that these names are re-exported rather than incidentally visible under its
# `no_implicit_reexport` setting, and it is the contract the consumers named in the docstring hold
# this file to. A blanket suppression comment would satisfy the first of those three and silently
# forfeit the other two.
#
# The ordering is the linter's isort-style ordering for `__all__`, which for a list of entirely
# class-cased names is plain alphabetical order. It is deliberately not the order the eight
# modules were built in: a mechanically checked order gives a future member exactly one insertion
# point, and that check is what keeps this list and the import block above from drifting apart.
__all__ = [
    "AdminComment",
    "AdminCommentStatusUpdate",
    "AdminPost",
    "AdminPostStatusUpdate",
    "AdminStats",
    "AdminUser",
    "AdminUserUpdate",
    "CategoryCreate",
    "CategoryPublic",
    "CategorySummary",
    "CategoryUpdate",
    "CommentCreate",
    "CommentPublic",
    "CommentUpdate",
    "LikeSummary",
    "LoginRequest",
    "Page",
    "PostCreate",
    "PostDetail",
    "PostSortOption",
    "PostSummary",
    "PostUpdate",
    "ProblemDetail",
    "ProblemResponses",
    "RefreshRequest",
    "RegisterRequest",
    "TokenPair",
    "UserMe",
    "UserPublic",
    "UserUpdate",
    "ValidationErrorItem",
    "problem_response",
]
