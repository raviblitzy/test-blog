"""The application factory and the service's canonical ASGI entry point.

``uvicorn app.main:app --reload``, run from inside ``backend/``, is the launch command for this
service. That sentence is the point of this module. The repository it replaces documented
``uvicorn main:app --reload`` while shipping no ``main`` module at all, so the only published way
to start the application could not succeed as written; the technical specification tracks that as
the single feature in a non-functional state. There is now a real ``main``, the command resolves,
and the repository-root ``app.py`` is a deprecated shim that re-exports the object built here -
which is why the module-level name below is exactly ``app`` and must stay that way.

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
Seven acts, all inside :func:`create_app`, in the order they appear there:

1. **OpenAPI metadata** - a title naming the blog service, the version, a description of the
   contract and one tag object per tag any router attaches. The retired ``FastAPI()`` supplied
   none of the four, so the generated document described the API without ever naming it.
2. **The documentation surface** - :data:`OPENAPI_URL` is always served; ``/docs`` and ``/redoc``
   are withdrawn in production. See *The documentation surface* below.
3. **The middleware chain** - three wrappers in the one order that is correct. See *Middleware
   order* below.
4. **The rate limiter** - bound to ``app.state.limiter``, which is how *slowapi* reaches it from
   a decorated route.
5. **The error contract** - ``register_exception_handlers`` called exactly once, so every failure
   at every status renders one machine-readable problem document.
6. **The routers** - the versioned aggregate under ``/api/v1``, and the two operational probes
   unprefixed.
7. **The lifespan** - structured logging configured before the first request, the connection pool
   disposed on the way out.

Middleware order
----------------
``Starlette.add_middleware`` inserts at the front of the chain, so **first registered ends up
innermost**. The registration order below produces::

    ServerErrorMiddleware          <- outermost; renders the handler keyed on bare Exception
      RequestContextMiddleware     <- registered LAST: correlates, logs, sets X-Request-ID
        SecurityHeadersMiddleware  <- hardens every response, preflights included
          CORSMiddleware           <- built from settings.CORS_ALLOW_ORIGINS
            ExceptionMiddleware    <- runs the handlers app.core.exceptions registers
              Router -> endpoint

which is exactly the order ``app.middleware`` and ``app.middleware.security_headers`` require, and
each position is load-bearing:

* ``RequestContextMiddleware`` is registered **last**, so it is outermost and every request gets
  an identifier and a bound log context - including one that fails inside another middleware.
* ``SecurityHeadersMiddleware`` sits **outside** ``CORSMiddleware`` because that middleware
  answers an ``OPTIONS`` preflight itself and never calls the application beneath it: anything
  registered inside it would never run for a preflight, leaving every preflight response
  unhardened. It also sits outside ``ExceptionMiddleware``, so a problem document is hardened
  exactly like a 200.
* ``CORSMiddleware`` is innermost of the three, which is what lets the two wrappers above it act
  on the responses it generates itself.

One response escapes the chain and cannot be made not to: Starlette hoists a handler registered
for bare ``Exception`` onto ``ServerErrorMiddleware``, outside everything ``add_middleware`` adds.
``app.core.exceptions`` closes that from the other side by applying the same security headers and
the same ``X-Request-ID`` to the 500 document it renders.

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
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from importlib.metadata import PackageNotFoundError, version as distribution_version
from pathlib import Path
from typing import Any, Final

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse

from app.api.v1.router import API_V1_PREFIX, api_router
from app.api.v1.routers.health import router as health_router
from app.core.config import settings
from app.core.exceptions import REQUEST_ID_HEADER, register_exception_handlers
from app.core.logging import configure_logging, get_logger
from app.core.rate_limit import limiter
from app.db.session import engine
from app.middleware.request_context import RequestContextMiddleware
from app.middleware.security_headers import SecurityHeadersMiddleware

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

### Collections

Every list operation returns the same page envelope - `items`, `total`, `page`, `page_size`
and `pages` - and accepts `page` and `page_size` query parameters. Single-resource reads
return the resource representation directly, with no wrapper.

### Errors

Every failure at every status code returns one problem document: `type`, `title`, `status`,
`detail`, `instance` and `request_id`, with an `errors` array of field-level failures on a
validation rejection. `type` is a stable URI reference, so a client can branch on it instead
of parsing prose. `request_id` matches the `X-Request-ID` response header on the same
response, which is the value to quote when reporting a problem.
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

_CORS_WILDCARD_ORIGIN: Final[str] = "*"
"""The one entry in an origin list that is not an origin.

``app.core.config`` accepts it only as the entire list, and only deliberately. Recognising it
here is what lets :func:`_credentials_allowed` refuse to pair it with credentials.
"""


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


def _credentials_allowed(origins: Sequence[str]) -> bool:
    """Decide whether credentialed cross-origin requests may be permitted for *origins*.

    Credentials are permitted for a named allow-list and refused for the wildcard, and the
    refusal is the point. ``Access-Control-Allow-Origin: *`` combined with
    ``Access-Control-Allow-Credentials: true`` is a configuration the fetch specification
    forbids, and Starlette works around the browser's refusal by echoing the requesting origin
    back instead - which turns a deliberate "this read-only surface is public" into "every site
    on the web may make authenticated requests with the visitor's cookies and tokens". Deciding
    it here, from the configured list, means a deployment cannot arrive at that combination by
    setting one variable.

    Args:
        origins: The configured origin allow-list, exactly as ``app.core.config`` validated it.
            A wildcard can only appear as the entire list, which that validation guarantees.

    Returns:
        Whether ``allow_credentials`` may be enabled: ``True`` for a named allow-list,
        ``False`` when the list is the wildcard.
    """
    return _CORS_WILDCARD_ORIGIN not in origins


@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncIterator[None]:
    """Configure logging on the way in, dispose the connection pool on the way out.

    The context-manager form rather than the deprecated ``@app.on_event`` decorators, so startup
    and its matching shutdown are written next to each other and the ``finally`` guarantees the
    pool is released even when the served lifetime ends in an exception.

    **Startup performs no I/O.** No connection is opened, no query is issued, no migration is
    applied and nothing is seeded. That is a requirement rather than an economy: schema evolution
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
    # which build is this, which stage is it configured as, where does the versioned surface
    # begin, and is the interactive documentation exposed here.
    logger.info(
        "application startup",
        version=application.version,
        environment=settings.ENVIRONMENT,
        api_prefix=API_V1_PREFIX,
        docs_enabled=application.docs_url is not None,
    )

    try:
        yield
    finally:
        # `finally`, so a crash during the served lifetime still returns the pooled connections
        # instead of leaving the server to reap them - which is what produces the "connection was
        # garbage collected" warnings that make a clean shutdown indistinguishable from a leak.
        # `app.db.session` documents this call as the only disposal in the process.
        await engine.dispose()
        logger.info(
            "application shutdown",
            version=application.version,
            environment=settings.ENVIRONMENT,
        )


def create_app() -> FastAPI:
    """Build a fully wired application. The one place this service is assembled.

    A factory rather than a bare module-level construction, so the assembly can be repeated:
    ``backend/tests/conftest.py`` varies the settings object and calls this again to exercise the
    branches that depend on the deployment stage - the withdrawn documentation routes, transport
    security, the credentialed-CORS decision - without a subprocess and without patching an
    application that has already been built. Nothing is cached, and no state is shared between two
    applications this returns.

    The seven acts of assembly, in the order performed:

    1. Construct the application with its OpenAPI metadata, response class and lifespan.
    2. Register ``CORSMiddleware`` from settings.
    3. Register :class:`~app.middleware.security_headers.SecurityHeadersMiddleware`.
    4. Register :class:`~app.middleware.request_context.RequestContextMiddleware` **last**, so it
       is outermost.
    5. Bind the rate limiter to application state.
    6. Register every exception handler, exactly once.
    7. Mount the versioned aggregate and the unprefixed probes.

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
        # domain is full of natively, in C, so every route gains it without opting in.
        #
        # FastAPI 0.141.1 emits a deprecation notice for this class, on the grounds that it
        # now serialises directly to JSON bytes through Pydantic when a response model is
        # declared. Naming it is nonetheless the right choice here and is kept deliberately:
        # every handler in `app.core.exceptions` already returns an `ORJSONResponse` for the
        # problem document, so declaring it here is what puts the success path and the error
        # path on ONE serialiser rather than two. Deprecated is not removed, and the notice
        # is reported rather than fatal - `[tool.pytest.ini_options] filterwarnings` is
        # `default`. Dropping it would be a change to make when that class is withdrawn and
        # the error contract moves with it, in one edit, not two.
        default_response_class=ORJSONResponse,
        lifespan=lifespan,
    )

    # ---------------------------------------------------------------------------------------
    # 2-4. The middleware chain
    #
    # ORDER IS LOAD-BEARING. `add_middleware` inserts at the front, so first registered ends up
    # INNERMOST. Read the three calls below as the stack upside down, and see "Middleware order"
    # in the module docstring for why each position is the only correct one. Reordering them
    # does not fail - it silently stops hardening preflight responses, or silently drops the
    # correlation identifier from requests that fail inside another wrapper.
    # ---------------------------------------------------------------------------------------

    # 2. Innermost of the three. Configured entirely from settings: no origin literal appears
    #    here, and `app.core.config` has already split the comma-separated value and rejected
    #    anything that is not a bare http/https origin.
    application.add_middleware(
        CORSMiddleware,
        # A copy, so the middleware cannot be handed a reference to the live settings list.
        allow_origins=tuple(settings.CORS_ALLOW_ORIGINS),
        # Never unconditionally true - see `_credentials_allowed` for the combination it
        # refuses and why the browser refuses it too.
        allow_credentials=_credentials_allowed(settings.CORS_ALLOW_ORIGINS),
        allow_methods=CORS_ALLOWED_METHODS,
        allow_headers=CORS_ALLOWED_HEADERS,
        # Without this the correlation identifier is set on the response and then hidden from
        # the very client that would quote it in a bug report: a browser exposes only the CORS
        # safelist to script unless the server names the header here. It is the exact name
        # `app.middleware.request_context` writes, imported rather than repeated.
        expose_headers=(REQUEST_ID_HEADER,),
    )

    # 3. Outside CORS, so an OPTIONS preflight - which CORSMiddleware answers itself, without
    #    calling anything beneath it - is hardened like every other response. `enable_hsts` is
    #    required by that class rather than defaulted, so the question cannot be skipped at the
    #    one point that can answer it; `settings.is_production` is the answer wherever the
    #    deployment stage and TLS termination coincide.
    application.add_middleware(SecurityHeadersMiddleware, enable_hsts=settings.is_production)

    # 4. LAST, therefore OUTERMOST. Every request gets an identifier and a bound log context
    #    before any other wrapper can fail, and every response carries it back out. Both
    #    keyword arguments are left at their defaults deliberately: the header name is the
    #    constant `expose_headers` above and the 500 handler both agree on, and the quiet-path
    #    set is the two probes, whose successful polls would otherwise dominate the log.
    application.add_middleware(RequestContextMiddleware)

    # ---------------------------------------------------------------------------------------
    # 5. The rate limiter
    #
    # `slowapi` reaches the limiter back through `request.app.state.limiter` when a decorated
    # route is called, so this binding is not bookkeeping: without it every rate-limited
    # authentication route raises instead of serving. The limit expression itself is
    # `settings.AUTH_RATE_LIMIT` and is applied by `app.core.rate_limit.auth_rate_limit` in the
    # authentication router - it appears neither here nor there as a literal.
    #
    # slowapi's own `_rate_limit_exceeded_handler` is deliberately NOT registered. It would
    # emit slowapi's response body, making 429 the single status in this API that does not
    # return the documented problem document. Step 6 registers the one that does, with the
    # `Retry-After` header derived from the tripped limit's own window.
    # ---------------------------------------------------------------------------------------
    application.state.limiter = limiter

    # ---------------------------------------------------------------------------------------
    # 6. The error contract - one call, one rendering site
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
    # 7. Routes - mounted here, declared nowhere in this file
    #
    # Two includes, and the asymmetry between them is deliberate.
    # ---------------------------------------------------------------------------------------

    # BARE. `api_router` was constructed with `prefix=API_V1_PREFIX` already applied, so passing
    # a prefix here as well would double the segment: every path would become
    # `/api/v1/api/v1/...` and the entire API would answer 404 while the process reported itself
    # perfectly healthy. This one call carries all thirty-seven versioned operations.
    application.include_router(api_router)

    # UNPREFIXED, and the only unversioned paths in the service. `/healthz` and `/readyz` must
    # be reachable before anything has told an orchestrator which API version to speak, and the
    # container health check aims at `/healthz` at the root. This router sets its own
    # `tags=["health"]` and writes its paths absolute precisely because nothing supplies them
    # for it here.
    application.include_router(health_router)

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
repository-root ``app.py``, retained as a deprecated shim whose entire body is
``from app.main import app`` so that the historical ``uvicorn app:app`` invocation still resolves.

A plain module-level instance, not a factory reference and not lazily built, because that is what
those four resolutions require. Constructing it opens no connection - see *Import-time effects* in
the module docstring - so importing this module is safe with PostgreSQL stopped.
"""
