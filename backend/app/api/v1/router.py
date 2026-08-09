"""The aggregate router for ``/api/v1`` - the one object ``app.main`` mounts to serve the API.

This module composes, and composing is all it does. It declares no route of its own, holds no
business rule, performs no data access and never reads a request. Its entire output is a single
:class:`~fastapi.APIRouter` carrying every versioned operation in the service, already prefixed
and already tagged, so the application has exactly one thing to mount.

What it replaces
----------------
The retired surface registered five handlers directly on the application object -
``@app.post("/items")``, ``@app.get("/items")``, ``@app.get("/items/{item_id}")``,
``@app.put("/items/{item_id}")`` and ``@app.delete("/items/{item_id}")``. Every path was
unversioned, no route declared a ``response_model``, and there was no router layer of any kind.
Both defects close here and in the modules below: the version prefix is attached once, to every
operation at once, and each operation's contract is declared beside the handler that serves it.

Where a prefix and a tag are decided
------------------------------------
Here, and deliberately nowhere else. Each of the seven modules in ``app.api.v1.routers``
constructs a bare ``APIRouter()`` - no ``prefix``, no ``tags``, no router-level
``dependencies`` - and registers every operation on a path *relative* to it. That is why
``posts`` spells its collection ``@router.get("")`` and why the string ``/api/v1`` appears in
no route decorator anywhere in the package. This file supplies the missing half on each
``include_router`` call below, which buys three properties worth the indirection:

* The version namespace is written exactly once, so no route can escape it by omission.
* A tag cannot drift away from the ``openapi_tags`` section it is supposed to group.
* A collection path stays exactly ``/api/v1/posts``. The relative path is ``""`` and not
  ``"/"``, which is what keeps a trailing slash - and the 307 redirect it would provoke - off
  the collection routes.

Eight includes over seven modules
---------------------------------
``comments`` contributes two router objects rather than one, because its operations span two
path families that live under different parents: the thread reached through the post that owns
it (``/posts/{post_id}/comments``) and the comment addressed by its own identifier
(``/comments/{comment_id}``). Both are included below, under different prefixes, and merging
them is an application-wide start-up failure rather than a tidy-up. Seven modules, eight
includes, thirty-seven operations.

.. important::
   **Read this before mounting or importing.** Three ways to get this wrong, all of them quiet
   until something much later breaks:

   1. :data:`api_router` **already carries** ``prefix=API_V1_PREFIX``. ``app.main`` must mount
      it bare::

          app.include_router(api_router)

      Passing ``prefix=`` there as well doubles the segment, every path becomes
      ``/api/v1/api/v1/...``, and the whole API answers 404 while the process reports itself
      perfectly healthy. :data:`API_V1_PREFIX` is exported so that the application, the tests
      and ``docs/api/rest-endpoints.md`` can agree on one literal instead of repeating it.
   2. ``app.api.v1.routers.health`` is **intentionally absent** from this aggregate.
      ``app.main`` mounts it separately and unprefixed, because an orchestrator has to be able
      to probe liveness before anything has told it which API version to speak. ``/healthz``
      and ``/readyz`` are the only unversioned paths in the service and must not also appear
      beneath ``/api/v1``. That is precisely why ``health`` is the one module in the package
      that sets its own ``tags=["health"]`` and writes its paths absolute: this file never
      touches it, so there is nothing else to supply them.
   3. Import the router object, not the module that holds it::

          from app.api.v1.router import api_router

      ``from app.api.v1 import router`` binds this *module*. It has no ``routes``, so the
      mistake surfaces at mount time rather than at the import that caused it. :data:`router`
      exists below as an alias for exactly that reason - see its own note.

The administrator gate
----------------------
The one router-level application of :func:`~app.core.dependencies.require_admin` in the entire
service is on the ``admin`` include below. That placement is load-bearing, not stylistic.
``app.api.v1.routers.admin`` constructs a bare router specifically so the gate can live on the
mount: a gate on the mount covers every operation beneath it, including one added long after
this file was written by someone who never read this paragraph, so the guarantee becomes a
property of the composition instead of thirteen separate acts of remembering. Declaring it in
both places would document the same requirement twice in ``/openapi.json`` and protect nothing
further.

A coarse role gate is never a substitute for the row-scoped rules, and nothing here weakens
them. ``AdminService`` re-checks authority on each of its methods, because a service reachable
from a script is a service whose guard must not live in its caller, and ``PostService`` and
``CommentService`` still enforce ownership on the non-administrative paths. This include
answers "may this principal use this namespace", never "may this principal do this to this
row".

Layering
--------
This file sits at the very top of the one-way chain - routes delegate to services, services to
repositories, repositories own the queries, models own the schema - and it imports downwards no
further than it must. It reaches ``app.core.dependencies`` for the gate and ``app.schemas`` for
the error model, and it touches ``app.services``, ``app.repositories``, ``app.models`` and
``app.db`` not at all. There is no ``HTTPException`` here either: services raise the typed
``AppError`` family and the handlers registered by ``app.main`` render every failure as one
:class:`~app.schemas.common.ProblemDetail`, so the three duplicated ad-hoc 404 raises of the
retired module have no successor in this layer.
"""

from typing import Any, Final

from fastapi import APIRouter, Depends, status

from app.api.v1.routers import admin, auth, categories, comments, likes, posts, users
from app.core.dependencies import require_admin
from app.schemas import ProblemDetail

__all__ = ["API_V1_PREFIX", "api_router", "router"]


# ---------------------------------------------------------------------------------------
# The version namespace
# ---------------------------------------------------------------------------------------

API_V1_PREFIX: Final[str] = "/api/v1"
"""The one and only version prefix, applied to :data:`api_router` at construction.

Exported rather than inlined because four things have to agree on it and only one of them is
this file: ``app.main`` when it asserts the mount, the integration tests when they build a
request path, ``docs/api/rest-endpoints.md`` when it documents one, and the aggregate below.
A literal repeated in four places is a literal that eventually disagrees with itself.

``Final`` is not decoration here. The value is the single source of truth for the whole
versioned surface, so rebinding it is a defect that should fail type-checking rather than
silently re-route every route in the service.
"""


# ---------------------------------------------------------------------------------------
# The administrator gate's own failure modes
#
# The gate is attached on the `admin` include below, so the two statuses it introduces are
# documented on the same call rather than left as undeclared bodies a client generator has
# to guess at. `ProblemDetail` is the model on both, because this API has exactly one error
# shape for every failure at every status code.
#
# `app.api.v1.routers.admin` declares the same pair on each of its thirteen routes; the
# wording below is deliberately consistent with it rather than a second, competing
# description of the same condition.
# ---------------------------------------------------------------------------------------

_ADMIN_GATE_RESPONSES: Final[dict[int | str, dict[str, Any]]] = {
    status.HTTP_401_UNAUTHORIZED: {
        "model": ProblemDetail,
        "description": (
            "No usable credential was presented: the `Authorization` header was absent or "
            "malformed, or the bearer token was expired, of the wrong type, or names an "
            "account that no longer exists. Obtain a fresh access token from "
            "`POST /api/v1/auth/login` or `POST /api/v1/auth/refresh` and retry."
        ),
    },
    status.HTTP_403_FORBIDDEN: {
        "model": ProblemDetail,
        "description": (
            "The credential is valid but the account may not use this namespace - it holds "
            "`READER` or `AUTHOR` rather than `ADMIN`, or it has been deactivated. The body "
            "does not disclose which role would have sufficed."
        ),
    },
}
"""401 and 403, declared on the include that gates the administrative namespace.

Both apply uniformly to all thirteen operations beneath the mount, because the gate does. The
pair is declared once, on the include, for the same reason the gate itself is: a per-route
declaration holds only for as long as every future author remembers it.
"""


# ---------------------------------------------------------------------------------------
# The aggregate
#
# Constructed WITH the prefix, so a route cannot reach the application without it. `app.main`
# mounts this object and nothing else from the versioned tree - see point 1 of the important
# note in the module docstring before adding a `prefix=` anywhere near it.
# ---------------------------------------------------------------------------------------

api_router = APIRouter(prefix=API_V1_PREFIX)
"""Every versioned operation in the service, behind one prefix, ready to mount.

Thirty-seven operations, composed from eight includes over the seven domain modules in
``app.api.v1.routers``. ``app.api.v1.routers.health`` is not among them by design: its two
probes are mounted unprefixed by ``app.main``, which brings the served total to thirty-nine.

Mounted as ``app.include_router(api_router)`` - bare, with no further ``prefix=``.
"""


# ---------------------------------------------------------------------------------------
# The eight includes
#
# Order is deterministic and reads as resource nesting rather than as an alphabet: the post
# collection is established first, then the two families addressed through a post - the
# comment thread and the like - then the resources addressed by their own identifiers. A
# reader looking for "what lives under /posts" finds all three in one place.
#
# Every call names its prefix and its tag explicitly. The tag strings match `app.main`'s
# `openapi_tags` entries character for character; a single differing character produces an
# orphaned, undescribed group in the served document rather than an error.
# ---------------------------------------------------------------------------------------

# 5 operations: register, login, refresh, logout, me. Rate limiting is declared per route
# inside the module against the limiter `app.main` binds to `app.state.limiter`, never here.
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])

# 3 operations: PATCH own profile, GET a public profile by username, GET that author's posts.
api_router.include_router(users.router, prefix="/users", tags=["users"])

# 7 operations: the feed and the create on the collection, read by slug, partial update and
# delete by identifier, and publish and unpublish as explicit lifecycle transitions.
api_router.include_router(posts.router, prefix="/posts", tags=["posts"])

# 2 operations: list and create a comment on the thread the post owns. This is the first of
# `comments`' two routers - the nested family - and it is tagged with the resource it serves
# rather than with the collection it hangs beneath.
api_router.include_router(comments.post_comments_router, prefix="/posts", tags=["comments"])

# 3 operations: like and unlike a post, and read the count with the caller's own state. The
# like is idempotent by construction - a composite primary key - so PUT is safely retryable.
api_router.include_router(likes.router, prefix="/posts", tags=["likes"])

# 2 operations: edit and delete a comment by its own identifier. The second of `comments`'
# two routers, sharing the tag of the first so both families document as one section.
api_router.include_router(comments.router, prefix="/comments", tags=["comments"])

# 2 operations: list the taxonomy with post counts, and read one category by slug.
api_router.include_router(categories.router, prefix="/categories", tags=["categories"])

# 13 operations across four entities: aggregate counts, and listing, state mutation and
# deletion for users, posts, comments and categories.
#
# THE ADMINISTRATOR GATE. This is the single router-level application of `require_admin` in
# the service, and the only include on this router that carries `dependencies=`. It covers
# every operation beneath the mount, including any added later, which is exactly why
# `app.api.v1.routers.admin` constructs a bare router and declares no authorisation itself.
# Do not add a second application here, on another include, or on that module's router.
api_router.include_router(
    admin.router,
    prefix="/admin",
    tags=["admin"],
    dependencies=[Depends(require_admin)],
    responses=_ADMIN_GATE_RESPONSES,
)


# ---------------------------------------------------------------------------------------
# Compatibility alias
# ---------------------------------------------------------------------------------------

router = api_router
"""Alias for :data:`api_router`, so both spellings of the import resolve to the router object.

``api_router`` is the canonical name and the one ``app.main`` uses. This alias exists because
every module in ``app.api.v1.routers`` names its own router ``router``, which makes
``from app.api.v1.router import router`` an easy reflex; binding it here means that reflex
yields the :class:`~fastapi.APIRouter` rather than an :class:`AttributeError` at mount time.
It is the same object, not a copy - ``router is api_router`` - so an include registered
through either name is visible through both.
"""
