"""The application factory and the service's canonical ASGI entry point.

``uvicorn app.main:app --reload``, run from inside ``backend/``, is the launch command for this
service. That sentence is the point of this module. The repository it replaces documented
``uvicorn main:app --reload`` while shipping no ``main`` module at all, so the only published way
to start the application could not succeed as written; the technical specification tracks that as
the single feature in a non-functional state. There is now a real ``main``, the command resolves,
and the repository-root ``app.py`` is a deprecated shim that rebinds ``sys.modules["app"]`` to the
backend package in order to re-export the object built here - which is why the module-level name
below is exactly ``app`` and must stay that way.

An assembler, and nothing else
------------------------------
This file constructs, configures and wires. It holds no query, no ``select()``, no session, no
ownership or role check, no slug derivation, no business rule - and **no route**. There is no
``@app.get`` here, not even a ``/`` landing route or a redirect to the documentation: routers own
every path in the service, and a surface nobody asked for is a surface that has to be maintained,
documented and secured forever.

That restraint is the direct remedy for what it replaces. The retired module registered five
handlers on the application object itself, mutated a module-level ``items`` list from inside three
of them, and raised the identical ``HTTPException(status_code=404, detail="Item not found")`` at
three separate call sites. Here the equivalent responsibilities are delegated: paths come from
``app.api.v1.router``, data access from ``app.repositories`` by way of ``app.services``, and the
one error document from the handlers ``app.core.exceptions`` registers.

What assembly consists of
-------------------------
Seven acts, all inside :func:`create_app`, in the order they appear there. The middleware
chain is four registrations rather than one, which is why the numbered steps in the function
run to eight:

1. **OpenAPI metadata** - a title naming the blog service, the version, a description of the
   contract and one tag object per tag any router attaches. The retired ``FastAPI()`` supplied
   none of the four, so the generated document described the API without ever naming it.
2. **The documentation surface** - :data:`OPENAPI_URL` is always served; ``/docs`` and ``/redoc``
   are withdrawn in production. See *The documentation surface* below.
3. **The middleware chain** - five wrappers in the one order that is correct. See *Middleware
   order* below.
4. **The rate limiter** - bound to ``app.state.limiter``, which is how *slowapi* reaches it from
   a decorated route.
5. **The error contract** - ``register_exception_handlers`` called exactly once, so every failure
   at every status renders one machine-readable problem document.
6. **The routers** - the versioned aggregate under ``/api/v1``, and the two operational probes
   unprefixed.
7. **The lifespan** - structured logging configured before the first request, the connection pool
   disposed on the way out.
8. **The published document** - :func:`_customise_openapi`, which publishes
   the error media type the handlers actually send and the optional-credential reads' true
   security alternatives. Both are properties of the finished document rather than of any route,
   so they are applied to the artifact once every route above is mounted - which is why this is
   the last statement of assembly.

Middleware order
----------------
``Starlette.add_middleware`` inserts at the front of the chain, so **first registered ends up
innermost**. The registration order below produces::

    ServerErrorMiddleware            <- outermost; renders the handler keyed on bare Exception
      RequestContextMiddleware       <- registered LAST: correlates, logs, sets X-Request-ID
        SecurityHeadersMiddleware    <- hardens every response, preflights included
          CORSMiddleware             <- built from settings.CORS_ALLOW_ORIGINS
            ExceptionMiddleware      <- catches what escapes the ones below, so an unhandled
                                        500 is rendered INSIDE the CORS layer
              BodyLimitMiddleware    <- registered FIRST: refuses an oversized body before
                                        anything reads it
                ExceptionMiddleware  <- the framework's own; runs the registered handlers
                  Router -> endpoint

which is exactly the order ``app.middleware`` and its three sibling modules require, and each
position is load-bearing:

* ``RequestContextMiddleware`` is registered **last**, so it is outermost and every request gets
  an identifier and a bound log context - including one that fails inside another middleware.
* ``SecurityHeadersMiddleware`` sits **outside** ``CORSMiddleware`` because that middleware
  answers an ``OPTIONS`` preflight itself and never calls the application beneath it: anything
  registered inside it would never run for a preflight, leaving every preflight response
  unhardened. It also sits outside ``ExceptionMiddleware``, so a problem document is hardened
  exactly like a 200.
* ``CORSMiddleware`` sits above the added ``ExceptionMiddleware`` and below the other two, which
  is what lets the two wrappers above it act on the responses it generates itself *and* lets it
  act on the 500 the wrapper below it renders.
* ``BodyLimitMiddleware`` is registered **first**, therefore innermost, which puts every layer it
  needs above it: inside ``CORSMiddleware`` so a browser can read its 413, inside
  ``SecurityHeadersMiddleware`` so a refused request is hardened like a served one, inside
  ``RequestContextMiddleware`` so the refusal carries the correlation identifier a burst of them
  would be found by, and inside the added ``ExceptionMiddleware`` so the error it raises is
  rendered as the problem document. It bounds a body before Starlette buffers it and long before a
  schema or the rate limiter could object to its size - see ``app.middleware.body_limit``.
* The added ``ExceptionMiddleware`` sits immediately outside it, and that position is the entire
  reason it exists. Starlette hoists a handler registered for bare
  ``Exception`` onto ``ServerErrorMiddleware``, outside everything ``add_middleware`` adds, and
  offers no way to move it: a 500 rendered only there never passes through ``CORSMiddleware``, so
  a browser is handed a cross-origin failure with no readable body instead of the problem
  document. Installing the same handler on an inner wrapper means every failure at or below it is
  rendered while CORS is still on the stack. ``app.core.exceptions.inner_exception_handlers``
  supplies the map, so both dispatch sites render one document from one implementation.

One response still escapes the chain, and now only one: a failure raised by
``RequestContextMiddleware`` or ``SecurityHeadersMiddleware`` themselves, which are above the
inner wrapper. ``ServerErrorMiddleware`` answers that one, and ``app.core.exceptions`` closes it
from the other side by applying the same security headers and the same ``X-Request-ID`` to the
500 document it renders there. It carries no CORS header, and cannot - but reaching it requires a
defect in one of two wrappers that only set headers and bind a log context.

The documentation surface
-------------------------
:data:`OPENAPI_URL` is served in **every** environment. It is the machine-readable contract - the
integration suite walks it to assert that every operation declares a response schema and that no
``/items`` path survives - and withdrawing it would remove the artifact those checks are made
against. ``/docs`` and ``/redoc`` are the human-facing renderings of that same document and are
withdrawn in production only, where an interactive console that can drive real credentials against
real data is a surface with no audience. Every other stage keeps them, because the developer
workflow and the test suite both exercise ``/docs``.

Configuration
-------------
Every value that varies between deployments is read through ``settings`` and nowhere else. This
module performs no ``os.environ`` lookup, calls no ``dotenv`` loader, and hard-codes no origin,
port, secret or connection string - ``app.core.config`` is the single environment reader in this
subtree, and that invariant is greppable. Nothing here supplies a fallback that could act as a
credential.

The version is not restated either. ``[project] version`` in ``backend/pyproject.toml`` is its
single source, and :func:`resolve_version` reads it - from the installed distribution's metadata
where the distribution is installed, and from that same table in the source tree where it is not,
which is the shape the test suite and a source checkout run in. See that function for why both
paths exist and why neither is a second declaration of the number.

Import-time effects, and the one that is deliberate
---------------------------------------------------
Importing this module builds the application: it resolves the version, constructs the FastAPI
object, registers the middleware, binds the limiter, installs the handlers and mounts the routers.
None of that touches the network. ``app.db.session`` constructs its engine lazily and opens no
connection, so the import - and the lifespan - both succeed with PostgreSQL stopped, which is what
lets ``backend/tests/conftest.py`` drive this application in-process over an httpx ASGI transport
with no live server.

:func:`~app.core.logging.configure_logging` is called at import time **as well as** in the
lifespan, and the duplication is required rather than accidental. A server writes lines before the
lifespan runs: Uvicorn calls ``Config.load()`` - which imports this module - before it logs
``Started server process``, so configuring at import is what brings those lines into the
structured stream. The lifespan call then re-applies the configuration after any test fixture or
embedding host has reconfigured logging underneath it. ``configure_logging`` is idempotent
precisely so that calling it twice is correct.

No module-level mutable state
-----------------------------
Every name bound at module scope below is a string, a tuple, a function or the application object.
Nothing is a list or dict that a request could append to. The retired module's ``items = []``
global is the reason the rule is stated: measured under two workers it produced divergent
collections and answered ``404 200 404 200`` for four identical reads of one identifier, because
each worker held its own copy. The system of record is PostgreSQL now, and this file must not
reintroduce anything a worker could hold privately.
"""

import tomllib
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from http import HTTPStatus
from importlib.metadata import PackageNotFoundError, version as distribution_version
from pathlib import Path
from typing import Any, Final

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# The class FastAPI itself installs as the innermost exception boundary, imported here so the
# inner handler table can be attached to that same class. FastAPI re-exports it nowhere, so it is
# reached through the Starlette FastAPI pins and installs - which is not a reason to declare
# starlette directly; see `backend/pyproject.toml`.
from starlette.middleware.exceptions import ExceptionMiddleware

from app.api.v1.router import API_V1_PREFIX, api_router
from app.api.v1.routers.health import router as health_router
from app.core.config import settings, suspicious_environment_keys
from app.core.dependencies import OPTIONAL_AUTHENTICATION_EXTENSION
from app.core.exceptions import (
    CORS_EXPOSE_HEADERS,
    PROBLEM_JSON_MEDIA_TYPE,
    REQUEST_ID_HEADER,
    inner_exception_handlers,
    register_exception_handlers,
)
from app.core.logging import configure_logging, get_logger
from app.core.rate_limit import limiter
from app.core.responses import ORJSONResponse
from app.core.security import warm_password_hashing
from app.db.session import engine
from app.middleware.body_limit import BodyLimitMiddleware
from app.middleware.request_context import RequestContextMiddleware
from app.middleware.security_headers import SecurityHeadersMiddleware
from app.schemas import ProblemDetail

__all__ = [
    "API_TITLE",
    "CORS_ALLOWED_HEADERS",
    "CORS_ALLOWED_METHODS",
    "DOCS_URL",
    "OPENAPI_URL",
    "REDOC_URL",
    "app",
    "create_app",
    "lifespan",
    "resolve_version",
]


# ---------------------------------------------------------------------------------------
# Identity of the served document
#
# `README.md` declared this project's intent in two words - "blog api" - while the code
# delivered a generic `Item` with an id, a name and a price. That divergence between stated
# intent and delivered functionality is the one gap the specification records as outstanding,
# and this whole change closes it. The title therefore names the blog service explicitly: a
# document titled after a generic item resource would restate the very mismatch being fixed.
# ---------------------------------------------------------------------------------------

API_TITLE: Final[str] = "Blog Platform API"
"""Title of the generated OpenAPI document, and the heading ``/docs`` renders.

Exported so the integration suite can assert the served ``info.title`` against one literal
rather than a copy of it. The retired application passed no title at all, which left the
document identified only by the framework's placeholder.
"""

_API_DESCRIPTION: Final[str] = """
REST API for the blog platform: accounts, authored posts, a searchable published feed,
threaded comments, likes, a category taxonomy and an administrative namespace.

### Versioning

Every operation lives under `/api/v1`. The two exceptions are the operational probes
`GET /healthz` and `GET /readyz`, which are deliberately unversioned so an orchestrator can
check liveness without first being told which version of the API to speak.

### Authentication

Bearer tokens. `POST /api/v1/auth/login` accepts the standard password grant and returns a
short-lived access token together with a rotating refresh token; send the access token as
`Authorization: Bearer <token>` and exchange the refresh token at `POST /api/v1/auth/refresh`
before it expires. `POST /api/v1/auth/logout` revokes a refresh token. Authority is enforced
on the server for every protected operation - an author may act only on their own posts and
comments, and the `/api/v1/admin` namespace requires the `ADMIN` role.

Four read operations accept a credential without requiring one - the feed, a post by slug, a
post's comment thread and its like summary - and each declares two security alternatives, the
first of which is none. They answer an anonymous caller with the public projection and enrich
the answer when a credential is present. A credential that is *presented and unusable* is
still refused with `401` on those routes rather than being degraded to anonymous, so an
expired session is reported to the client that needs to refresh it.

### Collections

Every list operation returns the same page envelope - `items`, `total`, `page`, `page_size`
and `pages` - and accepts `page` and `page_size` query parameters. There is exactly one
deliberate exception: `GET /api/v1/categories` answers with a bare JSON array and takes no
page window at all, because the taxonomy is administrator-curated and bounded and a filter
control offered only some of its terms would silently hide the posts filed under the rest.
Single-resource reads return the resource representation directly, with no wrapper.

### Errors

Every failure at every status code returns one problem document, served as
`application/problem+json`: `type`, `title`, `status`, `detail`, `instance` and `request_id`,
with an `errors` array of field-level failures on a validation rejection. `type` is a stable
URI reference, so a client can branch on it instead of parsing prose. `request_id` matches the
`X-Request-ID` response header on the same response, which is the value to quote when
reporting a problem.
"""
"""Markdown description of the contract, rendered by ``/docs`` and ``/redoc``.

Four things a consumer cannot discover from the path list alone, and therefore the four things
it covers: that the surface is versioned, that credentials are bearer tokens, that collections
share one page envelope, and that failures share one problem document. Private because it is
prose rather than an assertable contract; :data:`API_TITLE` is exported and this is not.
"""


# ---------------------------------------------------------------------------------------
# Tag metadata
#
# One entry per tag any router attaches, and the names must match those attachments
# CHARACTER FOR CHARACTER. `app.api.v1.router` tags its eight includes `auth`, `users`,
# `posts`, `comments` (twice, deliberately, so both comment path families document as one
# section), `likes`, `categories` and `admin`; `app.api.v1.routers.health` tags itself
# `health`. A single differing character does not raise - it produces an orphaned,
# undescribed group in the served document, which is why the pairing is asserted in the
# suite rather than left to review.
#
# A tuple of pairs rather than a list of dicts: the tuple cannot be mutated by a caller
# holding a reference, and `_openapi_tags()` maps it into the fresh list FastAPI stores on
# each application the factory builds.
# ---------------------------------------------------------------------------------------

_TAG_DESCRIPTIONS: Final[tuple[tuple[str, str], ...]] = (
    (
        "auth",
        "Registration, log-in, refresh-token rotation, log-out and the identity of the "
        "calling principal. These five routes are the only rate-limited operations in the "
        "service, because they are the only ones where repeating a request usefully "
        "changes the answer.",
    ),
    (
        "users",
        "Public author profiles addressed by username, the published posts belonging to an "
        "author, and the authenticated principal's own profile update. A profile lists "
        "published posts only - a draft can never surface through one.",
    ),
    (
        "posts",
        "The published feed with free-text search, category and author filters, ordering "
        "and pagination; reading a post by its slug; and the authoring lifecycle - create, "
        "partial update, delete, publish and unpublish. Publication is an explicit "
        "transition that stamps a publication instant, not a flag toggled through a "
        "general update.",
    ),
    (
        "categories",
        "The category taxonomy with post counts, which is what backs the feed's category "
        "filter, and a single category read by slug. Creating, renaming and deleting a "
        "category belongs to the administrative namespace.",
    ),
    (
        "comments",
        "Threaded discussion on a post: listing and adding a comment or a reply, and "
        "editing or deleting one by its own identifier. Only approved comments are visible "
        "to a public caller; moderation belongs to the administrative namespace.",
    ),
    (
        "likes",
        "Liking and unliking a post, and reading a post's like count together with whether "
        "the calling principal has liked it. A like is idempotent by construction - the "
        "relation's composite primary key is the guarantee - so the request is safely "
        "retryable and repeating it cannot inflate a count.",
    ),
    (
        "admin",
        "Administrator-only management of users, posts, comments and categories, plus the "
        "aggregate counts an overview screen reads. Every operation in this namespace "
        "requires the `ADMIN` role, enforced on the mount rather than per route.",
    ),
    (
        "health",
        "Operational probes, deliberately unversioned. `GET /healthz` reports that the "
        "process is running and performs no database work, so it is safe to wire to a "
        "restart policy. `GET /readyz` issues one trivial query per request and answers 503 "
        "when the database is unreachable, so it decides whether to send traffic.",
    ),
)
"""``(name, description)`` for every tag the service attaches, in document display order.

Ordered as the API reads rather than alphabetically: credentials first, then the identities
that hold them, then the content, then the taxonomy that classifies it, then the two
engagement families, then administration, then the probes.
"""


# ---------------------------------------------------------------------------------------
# The documentation surface
#
# FastAPI's own defaults, restated as named constants for two reasons. The gating below
# reads as `None if production else DOCS_URL`, which states the decision rather than
# repeating a path literal inside a conditional; and the integration suite asserts against
# these names instead of its own copies of the same three strings.
# ---------------------------------------------------------------------------------------

OPENAPI_URL: Final[str] = "/openapi.json"
"""Path of the machine-readable document. Served in **every** environment, unconditionally.

This is the artifact the contract checks are made against - that every operation declares a
response schema, and that no ``/items`` path survives the retirement of the legacy surface -
so it is not something a deployment stage may withdraw. It is also read-only, anonymous and
describes only what the routes already advertise.
"""

DOCS_URL: Final[str] = "/docs"
"""Path of the Swagger UI rendering, or ``None`` in production - see :func:`create_app`.

The interactive console can drive real credentials against real data through its *Authorize*
control, which is exactly what makes it valuable in development and unwanted in production.
``python-multipart`` is pinned so the login route accepts the standard password grant, which
is what makes that control work; nothing has to be configured here for it, because FastAPI
derives the security scheme from the route's own dependency.
"""

REDOC_URL: Final[str] = "/redoc"
"""Path of the ReDoc rendering, gated identically to :data:`DOCS_URL`.

A second reading of one document, kept because it renders long descriptions and nested schemas
better than Swagger UI does, and withdrawn in production for the same reason.
"""


# ---------------------------------------------------------------------------------------
# Cross-origin access
#
# The browser-facing tier is a separately-originated Next.js application, so without this
# configuration every call from it fails in the browser before it reaches a route. The
# retired application had no CORS configuration of any kind - `add_middleware` appears
# nowhere in it - so this is the first cross-origin policy the project has ever had.
#
# The origin list itself is NEVER written here. It comes from
# `settings.CORS_ALLOW_ORIGINS`, which `app.core.config` parses from a comma-separated
# environment value and validates entry by entry.
# ---------------------------------------------------------------------------------------

CORS_ALLOWED_METHODS: Final[tuple[str, ...]] = ("GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS")
"""The methods this REST surface uses, and deliberately no more.

Enumerated rather than wildcarded. ``*`` would expand to every method Starlette knows,
advertising verbs no route implements and turning the preflight response into a claim this
service cannot honour. ``PATCH`` is present and ``PUT`` is scoped: the post update is a genuine
partial update - unlike the whole-object replacement the retired ``PUT /items/{item_id}``
performed - and ``PUT`` survives only for the idempotent like.
"""

CORS_ALLOWED_HEADERS: Final[tuple[str, ...]] = (
    "Accept",
    "Authorization",
    "Content-Type",
    REQUEST_ID_HEADER,
)
"""The request headers a browser client sends, and deliberately no more.

``Authorization`` carries the bearer token and is the one entry without which authenticated
requests could not be made cross-origin at all. ``Accept`` and ``Content-Type`` are on the CORS
safelist and Starlette adds them regardless; naming them documents the contract rather than
relying on that. :data:`~app.core.exceptions.REQUEST_ID_HEADER` is here because
``app.middleware.request_context`` honours a well-formed inbound identifier, which lets a client
correlate its own trace with the server's - and a header the server reads must be a header the
preflight permits.

``*`` is deliberately not used. Starlette treats it as "allow every header", which would let a
credentialed cross-origin request carry anything the browser would otherwise have refused to
send.
"""

# The origin list's one non-origin entry, the wildcard, is recognised in `app.core.config`
# rather than here: `settings.cors_wildcard_origin` answers whether the deployment admits every
# origin and `settings.cors_allow_credentials` refuses to pair that with credentials. Both are
# read below. The decision was previously made in this module, and moving it removed the second
# implementation that appeared as soon as `app.core.exceptions` needed the same answer for the
# 500 rendered outside `CORSMiddleware`.


# ---------------------------------------------------------------------------------------
# Version resolution
#
# `[project] version` in backend/pyproject.toml is the SINGLE source of this number.
# `app/__init__.py` deliberately declares no `__version__`, and no module in this package
# restates the value, because a constant in a second place is a constant that drifts the
# first time only one of the two is bumped.
#
# Two ways to read that one source, tried in order, and neither is a second declaration of
# it. An installed distribution carries the value in its own metadata, which is the
# canonical way to ask. A source checkout has no such metadata - `[tool.pytest.ini_options]
# pythonpath = ["."]` is what puts `app` on the path for the suite, rather than an install -
# so the same table is read out of the file instead.
# ---------------------------------------------------------------------------------------
# The two corrections the finished document needs
#
# Everything from here to `_customise_openapi` operates on the GENERATED artifact rather than
# on a route, because neither fact can be expressed on a route at all:
#
#   * `app.schemas.common.problem_response` cannot declare `application/problem+json`. The
#     framework attaches a declared model under `route.response_class.media_type` and offers no
#     per-response override, so a route can publish the right SCHEMA or the right MEDIA TYPE and
#     not both. That helper's docstring records both failed alternatives, executed against
#     FastAPI 0.141.1.
#   * `app.core.dependencies.OPTIONAL_AUTHENTICATION` cannot be a `security` override, because
#     FastAPI merges `openapi_extra` with `deep_dict_update`, which concatenates lists. That
#     constant's docstring records the incoherent list the direct approach produces.
#
# So both are stated where they can be stated - at the route, as a schema and as a marker - and
# reconciled here, once, on the document every consumer actually reads. Nothing below is a
# route, a query, a session or a business rule, and nothing below reads the environment.
# ---------------------------------------------------------------------------------------


# ---------------------------------------------------------------------------------------
# Document constants
#
# All four describe the SERVED artifact rather than any framework object, which is what
# keeps the transform below independent of FastAPI's internals.
# ---------------------------------------------------------------------------------------

_CONTENT_TOO_LARGE_STATUS: Final[str] = str(int(HTTPStatus.CONTENT_TOO_LARGE))
"""The status key ``413`` under which the body-limit response is published.

A string, because a generated document keys ``responses`` by string, and derived from
:class:`~http.HTTPStatus` rather than written as a literal so the number and the name cannot part
company.
"""

_REQUEST_BODY_LIMIT_DESCRIPTION: Final[str] = (
    "The request body is larger than this API accepts. Refused before the body is parsed and "
    "before any route is reached, so nothing was created or changed. The ceiling is a deployment "
    "setting rather than a property of this operation - see `MAX_REQUEST_BODY_BYTES` in "
    "`.env.example`, which defaults to 1 MiB - and it is comfortably above the largest body any "
    "route accepts, so a request that reaches this is not a valid one made slightly too large."
)
"""What the published ``413`` says, and deliberately what it does not.

The number is named as a *configuration* key rather than quoted as a value, because a ceiling
returned in a response is a ceiling a caller can sit exactly underneath - and because it differs
between deployments, so a figure baked into the document would be wrong wherever it was changed.
"""

_JSON_MEDIA_TYPE: Final[str] = "application/json"
"""The media type the framework attaches a declared response model under.

Taken from the JSON response classes' own ``media_type``, which is a hard-coded class attribute
rather than anything a route can influence - the reason the remap exists.
"""

_PROBLEM_SCHEMA_REF: Final[str] = f"#/components/schemas/{ProblemDetail.__name__}"
"""JSON-pointer reference the framework emits for a response whose model is the problem document.

Derived from the class rather than written out, so renaming the model cannot leave the transform
matching a component name that no longer exists.
"""

_OPERATION_KEYS: Final[frozenset[str]] = frozenset(
    {"get", "put", "post", "delete", "options", "head", "patch", "trace"}
)
"""The keys of a path-item object that are operations.

Enumerated rather than assumed: a path item may also carry ``summary``, ``description``,
``servers``, ``parameters`` or ``$ref``, none of which is an operation and one of which is a
list. Iterating every value would either crash on those or, worse, silently treat one as an
operation.
"""

_ANONYMOUS_SECURITY: Final[dict[str, list[str]]] = {}
"""The security requirement object that permits an anonymous call.

An empty requirement object is the specification's way of saying "no scheme has to be
satisfied". Listed *first* among the alternatives so a reader and a code generator both meet
"this may be called without a credential" before the bearer alternative.
"""


def _operations(document: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """Yield every operation object in *document*, in document order.

    Args:
        document: A generated OpenAPI document, mutated in place by the callers of this
            function - so the mappings yielded are the document's own, not copies.

    Yields:
        Each operation object under each path item, skipping the path-item members that are not
        operations and skipping anything that is not a mapping, so a hand-written extension
        cannot make the transform raise.
    """
    paths = document.get("paths")
    if not isinstance(paths, dict):
        return
    for path_item in paths.values():
        if not isinstance(path_item, dict):
            continue
        for method, operation in path_item.items():
            if method in _OPERATION_KEYS and isinstance(operation, dict):
                yield operation


def _publish_request_body_limit(document: dict[str, Any]) -> None:
    """Declare ``413`` on every operation that accepts a request body.

    A property of the application rather than of any route, which is why it is applied to the
    finished document instead of repeated in fourteen ``responses`` mappings.
    ``app.middleware.body_limit`` refuses an oversized body before any route is reached, so every
    operation that takes one can answer this status - and a route author cannot opt out of it,
    cannot forget to declare it, and cannot declare it inconsistently.

    Derived from ``requestBody`` rather than from a hand-kept list, so an operation added later is
    covered the moment it accepts a body. Operations that take none are deliberately left alone: a
    ``GET`` carrying an oversized body would be refused too, but declaring a status for a body the
    contract does not accept describes a request no client should be making.

    An operation that already declares ``413`` is not overwritten, so a route with something more
    specific to say about its own limit keeps it.

    Args:
        document: The generated document, mutated in place.
    """
    for operation in _operations(document):
        if "requestBody" not in operation:
            continue
        responses = operation.setdefault("responses", {})
        if not isinstance(responses, dict) or _CONTENT_TOO_LARGE_STATUS in responses:
            continue
        # Written in the GENERATED shape, not the declared one. `problem_response` returns
        # `{"model": ..., "description": ...}`, which is what a *route* passes to FastAPI for the
        # generator to expand; injected straight into a finished document that `model` key means
        # nothing and the response would publish a description with no body at all. Verified: doing
        # it that way produced a 413 whose entry had no `content`. So the body is spelled out here,
        # keyed on `application/json` exactly as a route-declared one is, and
        # `_publish_problem_media_type` - which runs after this - re-keys every one of them to the
        # problem media type together, keeping that job in one rule.
        responses[_CONTENT_TOO_LARGE_STATUS] = {
            "description": _REQUEST_BODY_LIMIT_DESCRIPTION,
            "content": {_JSON_MEDIA_TYPE: {"schema": {"$ref": _PROBLEM_SCHEMA_REF}}},
        }


def _publish_problem_media_type(document: dict[str, Any]) -> None:
    """Re-key every declared problem-document body from JSON to ``application/problem+json``.

    Resolution of the drift between what the handlers send and what the document claimed: every
    handler in ``app.core.exceptions`` returns its body with
    :data:`~app.core.exceptions.PROBLEM_JSON_MEDIA_TYPE`, while the framework published the same
    body as ``application/json`` because that is the media type of the response class. A
    generated client therefore parsed - or refused - the wrong content type.

    Only a response whose ``application/json`` schema is exactly a reference to the problem
    document is touched. A success body is never a problem document, so no successful response
    is reachable by this test, and a response that already declares the problem media type is
    left alone.

    Args:
        document: The generated document, mutated in place.
    """
    for operation in _operations(document):
        responses = operation.get("responses")
        if not isinstance(responses, dict):
            continue
        for response in responses.values():
            if not isinstance(response, dict):
                continue
            content = response.get("content")
            if not isinstance(content, dict):
                continue
            body = content.get(_JSON_MEDIA_TYPE)
            if not _is_problem_document(body):
                continue
            # Removed and re-added rather than copied to both keys: the service emits one media
            # type, so the document must declare one. Declaring both would restate the very
            # inaccuracy this transform exists to remove.
            del content[_JSON_MEDIA_TYPE]
            content[PROBLEM_JSON_MEDIA_TYPE] = body


def _is_problem_document(body: object) -> bool:
    """Report whether *body* is a media-type object whose schema is the problem document.

    Args:
        body: The candidate media-type object, read straight out of the document and therefore
            of unverified shape.

    Returns:
        Whether it declares exactly ``{"$ref": "#/components/schemas/ProblemDetail"}`` as its
        schema. A composed schema - an array of them, a ``oneOf``, an inline object - is
        deliberately not matched: nothing in this service declares one, and a loose test here
        could re-key a success body that merely mentions the component.
    """
    if not isinstance(body, dict):
        return False
    schema = body.get("schema")
    return isinstance(schema, dict) and schema.get("$ref") == _PROBLEM_SCHEMA_REF


def _publish_optional_authentication(document: dict[str, Any]) -> None:
    """Turn each marked operation's mandatory security into anonymous-or-bearer alternatives.

    An operation carrying :data:`~app.core.dependencies.OPTIONAL_AUTHENTICATION` accepts a bearer
    credential and serves
    a caller who presents none. The framework cannot know that - it sees the security scheme in
    the dependency tree and publishes a single mandatory requirement - so the marker is what
    tells this function to prepend :data:`_ANONYMOUS_SECURITY`.

    The marker is removed from every operation it appears on, whether or not the rewrite
    applies, so the served document carries no vendor extension.

    Args:
        document: The generated document, mutated in place.
    """
    for operation in _operations(document):
        if not operation.pop(OPTIONAL_AUTHENTICATION_EXTENSION, False):
            continue
        declared = operation.get("security")
        if not isinstance(declared, list) or not declared:
            # Nothing to relax: the operation already requires no scheme. Reached only if the
            # marker is attached to a route with no security dependency, which is a
            # mis-annotation rather than a document defect - and writing `[{}]` here would
            # publish a security block that says nothing.
            continue
        if _ANONYMOUS_SECURITY in declared:
            continue
        # A COPY of the constant, not the constant itself. `_openapi_tags` above states the
        # same rule for the same reason: two applications built by the factory would otherwise
        # hold one shared mutable object, and a consumer editing the document it was handed
        # would edit it for every other application in the process.
        operation["security"] = [dict(_ANONYMOUS_SECURITY), *declared]


def _customise_openapi(application: FastAPI) -> None:
    """Install the three document corrections on *application*, replacing its ``openapi`` callable.

    The last statement of assembly, made by :func:`create_app` after the routers are mounted.
    Everything it corrects is a property of the finished document, so it runs on the generated
    artifact rather than on the routes:

    1. Every operation that accepts a request body declares ``413``, which
       ``app.middleware.body_limit`` can answer for any of them before a route is reached.
    2. Every declared problem-document body is published as ``application/problem+json``, which
       is what the handlers actually send.
    3. Every operation marked :data:`~app.core.dependencies.OPTIONAL_AUTHENTICATION` publishes
       anonymous *and* bearer
       as alternatives instead of bearer as a requirement.

    The framework's own generator is called first and its cache is honoured afterwards, so the
    document is still built once per application and every subsequent request to
    ``/openapi.json`` serves the same object. The cache is cleared on installation so that a
    document generated before this call - which nothing does today, but which a future
    assertion in the factory easily could - cannot be served uncorrected.

    Args:
        application: The application to correct. Its ``openapi`` attribute is replaced, and its
            cached document discarded.
    """
    # Bound before the replacement, so the closure calls the framework's generator rather than
    # itself. Rebinding `application.openapi` to a function that reached for `application.openapi`
    # would recurse until the stack ended.
    generate_document = application.openapi

    def openapi() -> dict[str, Any]:
        """Return the corrected document, generating and caching it on first call."""
        if application.openapi_schema is not None:
            return application.openapi_schema
        # `generate_document` stores its result on `application.openapi_schema` itself; the
        # corrections below therefore mutate the cached object in place, and the assignment
        # after them is what makes that explicit rather than incidental.
        document = generate_document()
        # Ordered deliberately: the body-limit publisher writes its entry keyed on
        # `application/json`, and `_publish_problem_media_type` then re-keys every declared
        # problem body - the injected 413s included - to `application/problem+json` in one pass.
        _publish_request_body_limit(document)
        _publish_problem_media_type(document)
        _publish_optional_authentication(document)
        application.openapi_schema = document
        return document

    application.openapi_schema = None
    # Assigning over a method is how the framework's own documentation prescribes customising
    # the generated document; the code is named because a bare ignore is banned by
    # `[tool.mypy] enable_error_code = ["ignore-without-code"]`.
    application.openapi = openapi  # type: ignore[method-assign]


# ---------------------------------------------------------------------------------------

_DISTRIBUTION_NAME: Final[str] = "blog-api-backend"
"""``[project] name`` in ``backend/pyproject.toml``, the key the installed metadata is under."""

_PROJECT_METADATA_FILE: Final[Path] = Path(__file__).resolve().parents[1] / "pyproject.toml"
"""Absolute path to ``backend/pyproject.toml``.

This module is ``backend/app/main.py``, so ``parents[1]`` is ``backend/``. Derived from
``__file__`` rather than from the process working directory, because the canonical launch runs
from inside ``backend/`` while the suite's rootdir and a container's workdir may differ.
"""

_PROJECT_TABLE: Final[str] = "project"
"""Name of the PEP 621 table the version lives in."""

_VERSION_KEY: Final[str] = "version"
"""Name of the key inside that table."""

_UNRESOLVED_VERSION: Final[str] = "0+unknown"
"""Reported when neither source can be read, which needs both to be absent at once.

A PEP 440 local-version marker, chosen because it is unmistakably not a release: an operator
reading it in ``/openapi.json`` learns that the artifact was assembled without its own
metadata, rather than being told a number that might be wrong. It is not a fallback default in
the sense the configuration standard forbids - it is not a credential, an origin or a
connection string, and it grants nothing - and it keeps ``info.version`` a non-empty string,
which the contract requires unconditionally.
"""


def resolve_version() -> str:
    """Return the service version, from the installed distribution metadata or the source tree.

    Exported so the integration suite can assert the served ``info.version`` against the same
    resolution the application performed, instead of against its own copy of the number - which
    would be the second source of truth this whole arrangement exists to avoid.

    Returns:
        ``[project] version`` from ``backend/pyproject.toml``, read from the installed
        distribution's metadata when the distribution is installed and from the file itself when
        it is not, or :data:`_UNRESOLVED_VERSION` when neither is readable.
    """
    try:
        return distribution_version(_DISTRIBUTION_NAME)
    except PackageNotFoundError:
        # Expected, not exceptional: running from a source checkout is the normal case for the
        # test suite and for `uvicorn app.main:app` in development. Fall through to the file.
        return _version_from_project_metadata()


def _version_from_project_metadata() -> str:
    """Read ``[project] version`` out of ``backend/pyproject.toml``.

    Every failure returns :data:`_UNRESOLVED_VERSION` rather than raising, because the version is
    descriptive metadata: refusing to start a healthy service over an unreadable version string
    would trade a cosmetic gap for an outage. The failures are enumerated rather than caught
    broadly - a missing or unreadable file, malformed TOML, an absent table, an absent or
    non-string key - so a genuinely unexpected error still propagates.

    Returns:
        The declared version, or :data:`_UNRESOLVED_VERSION` if it could not be read.
    """
    try:
        with _PROJECT_METADATA_FILE.open("rb") as metadata_file:
            metadata: dict[str, Any] = tomllib.load(metadata_file)
    except OSError, tomllib.TOMLDecodeError:
        return _UNRESOLVED_VERSION

    project = metadata.get(_PROJECT_TABLE)
    if not isinstance(project, dict):
        return _UNRESOLVED_VERSION

    declared = project.get(_VERSION_KEY)
    if isinstance(declared, str) and declared:
        return declared
    return _UNRESOLVED_VERSION


def _openapi_tags() -> list[dict[str, Any]]:
    """Build the ``openapi_tags`` argument as a fresh list, once per application.

    Fresh rather than shared: FastAPI stores the list it is given on the application object, so
    two applications built by :func:`create_app` - which is exactly what
    ``backend/tests/conftest.py`` does when it varies settings - would otherwise hold references
    to one mutable list. :data:`_TAG_DESCRIPTIONS` stays an immutable tuple for the same reason.

    Returns:
        One ``{"name": ..., "description": ...}`` object per entry in
        :data:`_TAG_DESCRIPTIONS`, in declaration order, which is the order the groups appear in
        the rendered documentation.
    """
    return [{"name": name, "description": description} for name, description in _TAG_DESCRIPTIONS]


@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncIterator[None]:
    """Configure logging on the way in, dispose the connection pool on the way out.

    The context-manager form rather than the deprecated ``@app.on_event`` decorators, so startup
    and its matching shutdown are written next to each other and the ``finally`` guarantees the
    pool is released even when the served lifetime ends in an exception.

    Shutdown is recorded unconditionally, and a failure to release the pool is recorded beside it
    rather than in place of it. See the comments in the ``finally`` for why nothing raised there
    may escape: it would replace the exception that caused the shutdown in the first place.

    **Startup performs no I/O.** No connection is opened, no query is issued, no migration is
    applied and nothing is seeded. It does perform one bounded piece of CPU work -
    :func:`~app.core.security.warm_password_hashing` - for the reason recorded at that function
    and below. That is a requirement rather than an economy: schema evolution
    belongs to ``alembic upgrade head`` - run by the container start command and by the
    ``migrate`` target - and reference data to ``app.db.seed``, invoked by the ``seed`` target. A
    process that migrated on boot would race every other replica starting beside it, and one that
    seeded would write to a production database because it was restarted. It also keeps this
    application startable with PostgreSQL stopped, which is what
    ``backend/tests/conftest.py`` relies on when it drives the app over an httpx ASGI transport
    with no live server.

    Args:
        application: The application being started. Read for the values the startup line reports,
            so the record describes the object actually serving rather than the settings it was
            built from.

    Yields:
        Once, while the application serves. Nothing is yielded into the state mapping - this
        service keeps no per-application resource beyond the engine, which is module-level in
        ``app.db.session`` and shared by every session the process hands out.
    """
    # First statement of startup, before a router is reached or a request is served, so the very
    # first line this process writes from here on already has its final shape. Idempotent, and
    # deliberately called again here after the import-time call at the foot of this module: a
    # test fixture or an embedding host may have reconfigured logging in between.
    configure_logging()

    # Inside the function, never at module scope. A logger built while a module is being imported
    # can memoise structlog's unconfigured defaults and then never notice `configure_logging`
    # running afterwards - a failure that leaves the log looking perfectly healthy while the
    # request identifier has silently vanished from every line.
    logger = get_logger(__name__)

    # One line, and every field on it is a question an operator asks of a running deployment:
    # which build is this, where does the versioned surface begin, is the interactive
    # documentation exposed here - and, from `effective_configuration`, what configuration is
    # ACTUALLY in force.
    #
    # That last part is the substance rather than a flourish. Every invalid value already stops
    # the process with a message naming the field, and every misspelt key in an env FILE is
    # refused outright - but a misspelt key supplied as a real environment variable, which is the
    # only channel a container has, is neither: pydantic reads only declared names out of the
    # environment, so `AUTH_RATE_LIMITT` is not an extra input to reject, it is a name nothing
    # reads. The field keeps its default and the service starts healthy. Reporting the effective
    # values means the difference between a default nobody chose and a value somebody set is one
    # line away instead of unknowable from outside the process.
    #
    # `environment` arrives THROUGH that mapping rather than being passed separately - it is a
    # declared setting like any other - which is why it is no longer named here.
    logger.info(
        "application startup",
        version=application.version,
        api_prefix=API_V1_PREFIX,
        docs_enabled=application.docs_url is not None,
        **settings.effective_configuration(),
    )

    # And the other half of the same signal: a key in the environment that looks like a failed
    # attempt at one of ours. Reported at `warning` because it is a similarity heuristic and must
    # never stop a healthy deployment - `app.core.config` explains why the exact rule can fail
    # closed and this one may not - and as ONE bounded record rather than one per key, so an
    # environment full of near-misses cannot flood the stream. Emitted only when there is
    # something to say, so a clean deployment's WARNING level stays empty on the happy path.
    suspicious = suspicious_environment_keys()
    if suspicious:
        logger.warning(
            "unrecognised environment variables",
            count=len(suspicious),
            # Rendered as `KEY~SETTING` pairs joined into one scalar, for the same reason the
            # origins list is joined: a flat field is greppable and a nested one is not.
            unrecognised=",".join(f"{key}~{resembles}" for key, resembles in suspicious.items()),
        )

    # Before the first request, never in response to one. `app.services.auth_service` verifies an
    # unknown email against a stand-in argon2id hash so that a login for an unregistered address
    # costs what a login for a registered one costs. That hash is cached, so only its FIRST
    # computation is expensive - and left to happen lazily, that first computation lands inside the
    # first unknown-email login the process serves, which then pays a full argon2 hash on top of
    # its verify while a known-email attempt pays only the verify. One request is enough to read
    # that difference. Paying it here puts it where nobody is waiting on it and nothing is being
    # timed. CPU only: no connection, no query, so the "startup performs no I/O" rule above holds.
    warm_password_hashing()

    try:
        yield
    finally:
        # `finally`, so a crash during the served lifetime still returns the pooled connections
        # instead of leaving the server to reap them - which is what produces the "connection was
        # garbage collected" warnings that make a clean shutdown indistinguishable from a leak.
        # `app.db.session` documents this call as the only disposal in the process.
        #
        # NESTED, and both halves of that matter.
        #
        # Nothing raised in this block may escape. A `finally` reached while an exception is
        # already propagating - the served lifetime ended in a failure, or the server is
        # cancelling startup - REPLACES that exception with anything raised here, so a disposal
        # that fails would erase the reason the process was shutting down and leave an operator
        # reading about a connection pool instead of the real fault. The disposal outcome is
        # therefore recorded, never re-raised.
        #
        # And the shutdown record is written whatever happens. Putting the log line after an
        # unguarded `await` made the process's last line conditional on the pool releasing
        # cleanly, so the one shutdown worth investigating - the one where disposal failed - was
        # the one that produced no shutdown record at all.
        disposed = True
        try:
            await engine.dispose()
        except Exception as exc:
            disposed = False
            # `exception_type` and nothing else: a driver's message can name the host, the port,
            # the database and the user it was talking to, and this is the same rule
            # `app.core.exceptions` applies to the 500 it renders. The class name is enough to
            # tell a pool timeout from a driver fault, and the frames are of no use here because
            # the call site is this one line.
            logger.error(
                "application shutdown incomplete",
                version=application.version,
                environment=settings.ENVIRONMENT,
                exception_type=type(exc).__name__,
            )

        logger.info(
            "application shutdown",
            version=application.version,
            environment=settings.ENVIRONMENT,
            # So one field answers "did this process release its connections?" without the
            # reader having to correlate two records.
            pool_disposed=disposed,
        )


def create_app() -> FastAPI:
    """Build a fully wired application. The one place this service is assembled.

    A factory rather than a bare module-level construction, so the assembly can be repeated:
    ``backend/tests/conftest.py`` varies the settings object and calls this again to exercise the
    branches that depend on the deployment stage - the withdrawn documentation routes, transport
    security, the credentialed-CORS decision - without a subprocess and without patching an
    application that has already been built. Nothing is cached, and no state is shared between two
    applications this returns.

    The eight acts of assembly, in the order performed:

    1. Construct the application with its OpenAPI metadata, response class and lifespan.
    2. Register ``CORSMiddleware`` from settings.
    3. Register :class:`~app.middleware.security_headers.SecurityHeadersMiddleware`.
    4. Register :class:`~app.middleware.request_context.RequestContextMiddleware` **last**, so it
       is outermost.
    5. Bind the rate limiter to application state.
    6. Register every exception handler, exactly once.
    7. Mount the versioned aggregate and the unprefixed probes.
    8. Install the OpenAPI document corrections, once every route above is mounted.

    Returns:
        An application ready to serve: metadata populated, middleware chained, limiter bound,
        error contract installed and every route mounted. Nothing further has to be done to it,
        which is why the module-level ``app`` below is a single call to this function.
    """
    # ---------------------------------------------------------------------------------------
    # 1. The application object and its published contract
    #
    # Every metadata field the retired `FastAPI()` omitted is supplied here: without them the
    # generated document described the API without naming it, versioning it or explaining it.
    # ---------------------------------------------------------------------------------------
    application = FastAPI(
        title=API_TITLE,
        description=_API_DESCRIPTION,
        # Read from `[project] version`, never restated - see `resolve_version`.
        version=resolve_version(),
        # A fresh list per application; the names match the router attachments exactly.
        openapi_tags=_openapi_tags(),
        # Always served. The machine-readable contract is not a deployment-stage decision.
        openapi_url=OPENAPI_URL,
        # The two human renderings are. An interactive console that can drive real credentials
        # against real data has no audience in production, so it is withdrawn there and kept
        # everywhere else - development, test and staging - because the developer workflow and
        # the integration suite both exercise `/docs`. Withdrawing `docs_url` also withdraws
        # the OAuth2 redirect route FastAPI mounts beneath it.
        docs_url=None if settings.is_production else DOCS_URL,
        redoc_url=None if settings.is_production else REDOC_URL,
        # `orjson` is pinned for exactly this: it serialises the datetimes and UUIDs this
        # domain is full of natively, in C, so every route gains it without opting in. Declaring
        # it here is also what puts the success path and the error path on ONE serialiser rather
        # than two, because every handler in `app.core.exceptions` returns this same class for
        # the problem document.
        #
        # The class is `app.core.responses.ORJSONResponse` - this project's own, not the
        # framework's deprecated one, which the pinned FastAPI 0.141.1 withdraws on the
        # grounds that it now serialises through Pydantic when a response model is declared.
        # That deprecation was not merely advisory: the warning is installed on construction
        # and derives from `UserWarning` rather than `DeprecationWarning`, so it escaped
        # Python's default filters and was reported at WARNING level in the shipped image's log
        # on a clean boot. Naming a project-owned class is what lets BOTH things hold at once:
        # `orjson` stays the default response class as AAP §0.5.2 requires, and every handler in
        # `app.core.exceptions` still returns the same class for the problem document - so the
        # success path and the error path remain on ONE serialiser, which Pydantic
        # serialisation could not give the error path because a problem document has no
        # response model to be serialised through. See that module for the full reasoning,
        # including why neither dropping the response class nor filtering the warning was the
        # right remedy. Nothing about the wire changed with the swap: same bytes, same media
        # type.
        default_response_class=ORJSONResponse,
        lifespan=lifespan,
    )

    # ---------------------------------------------------------------------------------------
    # 2-6. The middleware chain
    #
    # ORDER IS LOAD-BEARING. `add_middleware` inserts at the front, so first registered ends up
    # INNERMOST. Read the five calls below as the stack upside down, and see "Middleware order"
    # in the module docstring for why each position is the only correct one. Reordering them
    # does not fail - it silently stops hardening preflight responses, silently drops the
    # correlation identifier from requests that fail inside another wrapper, or silently turns
    # an unhandled 500 back into an unreadable cross-origin failure.
    # ---------------------------------------------------------------------------------------

    # 2. INNERMOST of the five, which is what puts every layer its refusal needs above it: CORS,
    #    so a browser can read the 413; the security headers, so a refused request is hardened like
    #    a served one; the request context, so the refusal carries a correlation identifier; and
    #    the exception wrapper registered next, which is what renders the error it raises. It
    #    bounds a request body before Starlette buffers it - and therefore before a Pydantic field
    #    bound or the route's rate limiter could object to its size, both of which run too late to
    #    be a limit on size at all. `app.middleware.body_limit` records the reasoning in full.
    application.add_middleware(
        BodyLimitMiddleware,
        # From settings, never a literal here: `Settings.MAX_REQUEST_BODY_BYTES` validates the
        # floor and carries the reasoning behind the default, so this is the only place the value
        # is read and the only place it can be configured.
        max_body_bytes=settings.MAX_REQUEST_BODY_BYTES,
    )

    # 3. Immediately outside the body limit, and it has to be inside CORS rather than outside it.
    #
    #    Starlette hoists a handler registered for bare `Exception` onto
    #    `ServerErrorMiddleware`, which `build_middleware_stack` places outside every wrapper
    #    added here - so a 500 rendered only there never passes through `CORSMiddleware`, reaches
    #    the browser without `Access-Control-Allow-Origin`, and is reported to client code as an
    #    opaque network failure instead of the problem document the contract promises. The
    #    framework offers no way to move that registration inwards, so the same handler is
    #    installed a second time here, on an `ExceptionMiddleware` sitting immediately outside
    #    the framework's own: every failure at or below this point is rendered while the CORS
    #    wrapper is still on the stack. `app.core.exceptions.inner_exception_handlers` owns the
    #    map, so both dispatch sites render one document from one implementation.
    #
    #    Step 7's `register_exception_handlers` stays exactly as it was - it is what answers a
    #    failure raised by one of the two wrappers ABOVE this one, which nothing here can catch.
    application.add_middleware(
        ExceptionMiddleware,
        handlers=inner_exception_handlers(),
        # Never Starlette's traceback response, in any environment: `_render_unhandled` reveals
        # nothing at all, and `debug=True` here would bypass it. The application object is
        # likewise never constructed with `debug`.
        debug=False,
    )

    # 4. Configured entirely from settings: no origin literal appears here, and
    #    `app.core.config` has already split the comma-separated value and rejected anything
    #    that is not a bare http/https origin.
    application.add_middleware(
        CORSMiddleware,
        # A copy, so the middleware cannot be handed a reference to the live settings list.
        # Every entry has been canonicalised by `app.core.config` - lower-cased scheme and host,
        # a redundant default port dropped - which is what makes this verbatim comparison match
        # the `Origin` header a browser actually sends.
        allow_origins=tuple(settings.CORS_ALLOW_ORIGINS),
        # Never unconditionally true - see `Settings.cors_allow_credentials` for the combination
        # it refuses and why the browser refuses it too.
        allow_credentials=settings.cors_allow_credentials,
        allow_methods=CORS_ALLOWED_METHODS,
        allow_headers=CORS_ALLOWED_HEADERS,
        # A browser exposes only the CORS safelist to script unless the server names a header
        # here, so anything the client is expected to ACT on has to appear in this tuple:
        #
        #   X-Request-ID      the correlation identifier, otherwise set on the response and then
        #                     hidden from the very client that would quote it in a bug report.
        #   Retry-After       sent with every 429 from the rate-limited authentication routes. A
        #                     sign-in form that cannot read it retries immediately and is refused
        #                     again, which reads to the person at the keyboard as a broken form.
        #   WWW-Authenticate  sent with every 401. Without it the browser cannot distinguish
        #                     "present a credential" from "your credential was refused", which is
        #                     the distinction that decides whether the client rotates its token
        #                     or abandons the session.
        #
        # Imported from `app.core.exceptions`, which writes the same list by hand onto the one 500
        # that never reaches this middleware, so the two cannot describe different headers.
        expose_headers=CORS_EXPOSE_HEADERS,
    )

    # 5. Outside CORS, so an OPTIONS preflight - which CORSMiddleware answers itself, without
    #    calling anything beneath it - is hardened like every other response. `enable_hsts` is
    #    required by that class rather than defaulted, so the question cannot be skipped at the
    #    one point that can answer it; `settings.is_production` is the answer wherever the
    #    deployment stage and TLS termination coincide.
    application.add_middleware(SecurityHeadersMiddleware, enable_hsts=settings.is_production)

    # 6. LAST, therefore OUTERMOST. Every request gets an identifier and a bound log context
    #    before any other wrapper can fail, and every response carries it back out. Both
    #    keyword arguments are left at their defaults deliberately: the header name is the
    #    constant `expose_headers` above and the 500 handler both agree on, and the quiet-path
    #    set is the two probes, whose successful polls would otherwise dominate the log.
    application.add_middleware(RequestContextMiddleware)

    # ---------------------------------------------------------------------------------------
    # 7. The rate limiter
    #
    # `slowapi` reaches the limiter back through `request.app.state.limiter` when a decorated
    # route is called, so this binding is not bookkeeping: without it every rate-limited
    # authentication route raises instead of serving. The limit expression itself is
    # `settings.AUTH_RATE_LIMIT` and is applied by `app.core.rate_limit.auth_rate_limit` in the
    # authentication router - it appears neither here nor there as a literal.
    #
    # slowapi's own `_rate_limit_exceeded_handler` is deliberately NOT registered. It would
    # emit slowapi's response body, making 429 the single status in this API that does not
    # return the documented problem document. Step 7 registers the one that does, with the
    # `Retry-After` header derived from the tripped limit's own window.
    # ---------------------------------------------------------------------------------------
    application.state.limiter = limiter

    # ---------------------------------------------------------------------------------------
    # 8. The error contract - one call, one rendering site
    #
    # This is the direct remedy for the three duplicated `HTTPException(status_code=404,
    # detail="Item not found")` raises the retired module carried at three separate call
    # sites. The pattern is now declared once: `app.core.exceptions` owns the domain exception
    # hierarchy and the handlers, and installs them for the typed `AppError` family,
    # `RequestValidationError`, slowapi's `RateLimitExceeded`, Starlette's `HTTPException`
    # (which is what renders an unknown path - notably the retired `/items` - as a problem
    # document rather than Starlette's bare `{"detail": ...}`) and bare `Exception`.
    #
    # No handler is defined or registered inline here. If the contract ever needs another
    # status or another shape, it is added in that module, beside its siblings, and every
    # application this factory builds inherits it.
    # ---------------------------------------------------------------------------------------
    register_exception_handlers(application)

    # ---------------------------------------------------------------------------------------
    # 9. Routes - mounted here, declared nowhere in this file
    #
    # Two includes, and the asymmetry between them is deliberate.
    # ---------------------------------------------------------------------------------------

    # BARE. `api_router` was constructed with `prefix=API_V1_PREFIX` already applied, so passing
    # a prefix here as well would double the segment: every path would become
    # `/api/v1/api/v1/...` and the entire API would answer 404 while the process reported itself
    # perfectly healthy. This one call carries every versioned operation in the service - the
    # exact number is asserted once, against `app.openapi()`, in
    # `backend/tests/integration/test_openapi_contract.py`, rather than restated here where it
    # would drift the first time an operation was added or withdrawn.
    application.include_router(api_router)

    # UNPREFIXED, and the only unversioned paths in the service. `/healthz` and `/readyz` must
    # be reachable before anything has told an orchestrator which API version to speak, and the
    # container health check aims at `/healthz` at the root. This router sets its own
    # `tags=["health"]` and writes its paths absolute precisely because nothing supplies them
    # for it here.
    application.include_router(health_router)

    # ---------------------------------------------------------------------------------------
    # 10. The published document - LAST, and after every route is mounted
    #
    # Two facts about this API cannot be expressed on a route and are therefore applied to the
    # finished document, both of them corrections to what the framework would otherwise
    # publish:
    #
    #   * Every error body is `application/problem+json`. `app.core.exceptions` sends every
    #     problem document with that media type, while a declared `response_model` is published
    #     under the response class's own `application/json` - a media type no failure in this
    #     service ever returns. There is no per-response override, and declaring a `content`
    #     block by hand publishes BOTH types or loses the schema reference.
    #   * The four reads that resolve an OPTIONAL principal declare anonymous AND bearer as
    #     alternatives. The framework sees the security scheme in the dependency tree and
    #     publishes bearer as a requirement, which would make a generated client refuse a call
    #     any anonymous visitor can make.
    #
    # Ordering is load-bearing in one direction only: this must run after the routes exist,
    # because it operates on the document those routes produce. It does not generate the
    # document here - generation stays lazy and cached, on the first request to
    # `OPENAPI_URL` - so this call costs nothing at startup.
    # ---------------------------------------------------------------------------------------
    _customise_openapi(application)

    return application


# ---------------------------------------------------------------------------------------
# Import-time logging configuration
#
# Required by `app.core.logging`, not merely permitted. A server writes lines before the
# lifespan runs: Uvicorn constructs its `Config`, calls `load()` - which imports THIS module -
# and only then logs `Started server process`. Configuring here is what pulls those lines into
# the structured stream; measured under Uvicorn 0.52 at ENVIRONMENT=production, the same run
# emits JSON throughout with this call and two unstructured lines without it.
#
# The lifespan calls it again on purpose. This call shapes the server's boot lines, that one
# re-applies the configuration after any test fixture or embedding host has reconfigured
# logging underneath it, and `configure_logging` is idempotent so that both are correct.
# ---------------------------------------------------------------------------------------
configure_logging()


app: Final[FastAPI] = create_app()
"""The ASGI application every entry point resolves. **The name must stay exactly ``app``.**

Four things import or address this object by that name: ``uvicorn app.main:app`` run from inside
``backend/``, which is the canonical launch and the correction of the ``uvicorn main:app`` command
the old README documented against a module that never existed; the container's Gunicorn command,
which supervises Uvicorn workers over ``app.main:app``; the Compose service built from it; and the
repository-root ``app.py``, retained as a deprecated shim so that the historical
``uvicorn app:app`` invocation still resolves.

That last one is not a one-line re-export, and the difference matters to anyone reading it.
``app.py`` is itself imported *as* ``app``, so ``sys.modules["app"]`` already holds a plain module
and ``from app.main import app`` fails there with "'app' is not a package" - while resolving ``app``
by name would find and re-execute the shim itself, recursing. It therefore locates
``backend/app/__init__.py`` from its own ``__file__``, loads it through
``importlib.util.spec_from_file_location`` with explicit ``submodule_search_locations``, rebinds
``sys.modules["app"]`` to that package, imports ``app.main`` and takes this object from it - then
re-attaches the name ``app`` to the package, because ``backend/app/__init__.py`` declares no such
attribute and Uvicorn's final ``getattr(import_module("app"), "app")`` step would otherwise fail
after every import had succeeded. It also emits a ``DeprecationWarning`` and converts an import
failure into a ``RuntimeError`` naming the canonical command. None of that machinery is reachable
from here and none of it is required by this module; it is described because "a shim that
re-exports it" understates what has to happen for that invocation to work, and because the one
thing it cannot do is put the repository root on ``sys.path`` in the first place.

A plain module-level instance, not a factory reference and not lazily built, because that is what
those four resolutions require. Constructing it opens no connection - see *Import-time effects* in
the module docstring - so importing this module is safe with PostgreSQL stopped.
"""
