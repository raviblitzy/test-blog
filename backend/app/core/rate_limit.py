"""In-process rate limiting for the authentication routes.

Credential endpoints are the one part of a blog API that an anonymous caller can hammer
usefully: every other public surface returns the same posts however often it is asked, but
``POST /api/v1/auth/login`` answers a different question each time and so rewards guessing.
This module bounds that. It owns two names and nothing else - the :data:`limiter` the
application binds to its state, and the :data:`auth_rate_limit` decorator the authentication
router applies to each of its five routes:

* ``POST /api/v1/auth/register``
* ``POST /api/v1/auth/login``
* ``POST /api/v1/auth/refresh``
* ``POST /api/v1/auth/logout``
* ``GET  /api/v1/auth/me``

Nothing else in the service is rate limited, and that is a decision rather than an
oversight. No ``default_limits`` is configured, so the public feed, a post page, the sitemap
generator that walks every published post, and the ``/healthz`` and ``/readyz`` probes the
container health check polls on a fixed interval are all untouched. A global default is the
easy way to throttle a crawler by accident and to make a liveness probe fail under load,
which would restart a perfectly healthy container.

What the application must wire up
---------------------------------
The per-route decorator is only half of the mechanism. Three steps complete it, and all
three are mandatory - ``app.main`` owns the first two, the authentication router the third:

1. **Bind the limiter to application state** - ``app.state.limiter = limiter``. slowapi
   reaches the limiter back through ``request.app.state.limiter`` at request time, so an
   unbound state attribute breaks every decorated route.
2. **Register the handler for slowapi's ``RateLimitExceeded``** - done by
   ``register_exception_handlers``, which lives in the sibling ``exceptions`` module of this
   same package.
3. **Give every decorated route a ``request: Request`` parameter**, and keep the route
   decorator on the outside. slowapi finds both the limiter and the caller's identity
   through that object, and it checks for a parameter of that name when the decorator is
   applied - so an omission stops the process from starting rather than surfacing later as
   a failed request. Decorator order is the one requirement here that fails quietly:
   ``@router.post(...)`` must sit above ``@auth_rate_limit``, because a router registers
   whatever function it is handed, and the reverse order registers the undecorated handler
   and serves unlimited requests. :data:`auth_rate_limit` documents both in full.

Deliberately not here: the 429 handler
--------------------------------------
This module neither defines, imports nor registers that handler, and it imports nothing from
the sibling ``exceptions`` module at all. Every failure in this API renders as one
machine-readable problem document, so the 429 has to be produced by the same code that
produces the 404 and the 403 - which puts it beside its siblings in that module, not here
beside the thing that raises it. That module takes ``RateLimitExceeded`` straight from
``slowapi.errors``, so neither module imports the other: the error contract and the limiter
stay independent instead of becoming mutually dependent.

``RateLimitExceeded`` already carries everything such a handler needs, so nothing has to be
passed across that boundary. It is a ``starlette.exceptions.HTTPException`` with
``status_code`` 429 and a ``detail`` of ``"10 per 1 minute"``, plus a ``.limit`` whose
``.limit`` is the parsed ``RateLimitItem``, whose ``get_expiry()`` returns the window length
in seconds - which is what the ``Retry-After`` header on the response is built from.

One thing that must never be registered: slowapi ships a ready-made handler for this
exception, and using it would emit slowapi's own response body, making the 429 the single
error in the API that does not match the documented shape.

Storage, and an honest limitation
---------------------------------
Counters live in process memory. There is no Redis or Memcached backing store, because
nothing in this product needs one: rate limiting is the only shared-counter requirement, and
a cache tier would add an invalidation surface for no stated benefit.

The consequence is worth stating plainly. The production image serves under Gunicorn with
several Uvicorn workers, and each worker holds its own counters, so a limit of ten per minute
admits up to ten per minute *per worker*. The bound is therefore softer than the configured
number suggests, and it resets when a worker is recycled. That is an accepted trade-off at
this scope, not a defect: the guarantee being bought is "an attacker cannot make unbounded
guesses", which survives the multiplication, and moving the system of record for a
throwaway counter is a very different proposition from moving stored data. It is also
categorically unlike the module-level ``items = []`` list this rewrite deletes - a divergent
counter costs a slightly looser limit, whereas a divergent datastore costs the correctness of
the records themselves.

Configuration
-------------
Both values come from ``app.core.config``; this module reads no environment variable itself
and hard-codes no policy. ``settings.AUTH_RATE_LIMIT`` supplies the limit expression and
``settings.ENVIRONMENT`` decides whether the limiter runs at all. Changing the policy is an
edit to ``.env``, never to this file.

``app.core.config`` validates ``AUTH_RATE_LIMIT`` against a deliberately strict subset of
what the ``limits`` parser behind slowapi accepts, so a malformed expression is rejected
while the process is still starting rather than at the first login attempt.
"""

from collections.abc import Callable
from typing import Any, Final, Protocol

from slowapi import Limiter
from slowapi.util import get_remote_address

from app.core.config import settings

__all__ = ["auth_rate_limit", "limiter"]


_STORAGE_URI: Final = "memory://"
"""In-process storage backend for the rate-limit counters.

Also slowapi's own default when ``storage_uri`` is omitted - both spellings resolve to
``limits.storage.memory.MemoryStorage`` - but it is passed explicitly so the choice is
visible at the call site and survives a change of upstream default.

Never a networked backing store. No client for one is installed, so the URI could not be
honoured anyway; and a remote storage URI is precisely the kind of string that acquires an
embedded username and password the moment it points at something real, which is not a thing
this file should ever be holding.
"""


limiter: Final[Limiter] = Limiter(
    # The client identity a limit is counted against. get_remote_address reads
    # request.client.host and falls back to "127.0.0.1" when the transport reports no peer.
    key_func=get_remote_address,
    storage_uri=_STORAGE_URI,
    # Disabled for the test suite, and only for it.
    #
    # The integration suite drives register -> login -> refresh -> logout -> revoked-token
    # in a single session, many times over, from one client address. Under a live limit
    # those runs would start returning 429 part-way through a scenario, so the suite would
    # fail on request volume rather than on behaviour. A blocking gate has to be
    # deterministic to be worth blocking on, and an intermittently red suite is one that
    # gets ignored. "test" is a declared member of the ENVIRONMENT literal in
    # app.core.config, added for exactly this purpose, so the comparison below is checked
    # against that closed set: mypy's strict equality rejects a typo here as a
    # non-overlapping comparison instead of silently leaving the limiter enabled.
    #
    # Every other environment - development, staging, production - runs it enabled, so the
    # limit is exercised locally and is never something that only switches on in production.
    enabled=settings.ENVIRONMENT != "test",
    # headers_enabled is deliberately left at its default of False.
    #
    # Turning it on does not merely add X-RateLimit-* headers to a success response: slowapi
    # then requires every decorated route to declare a `response: Response` parameter as
    # well, because it injects the headers into an object it expects to be handed. A route
    # that returns a Pydantic model instead - which all five authentication routes do, since
    # each declares a response model - raises "parameter `response` must be an instance of
    # starlette.responses.Response" on every SUCCESSFUL call. That would trade a diagnostic
    # header for a second mandatory parameter on each route and a 500 wherever one was
    # forgotten. The Retry-After header on the 429, which is the header that actually tells
    # a client something it can act on, is set by the handler in the sibling exceptions
    # module instead.
    #
    # No default_limits and no application_limits: see the module docstring. This limiter
    # throttles only what is explicitly decorated.
)
"""The application's single rate limiter.

``app.main`` imports this object and binds it as ``app.state.limiter``, which is how slowapi
finds it again from inside a request. One instance for the whole process, so the counters a
decorator increments are the counters the next request is checked against.

``Final`` prevents the name being rebound, not the object being reconfigured: ``enabled`` is
a plain public attribute, so a test fixture that needs the limit live for one case can set
``limiter.enabled = True`` and restore it afterwards. Two things are worth knowing before
doing that. ``limiter.reset()`` clears the accumulated counters, which is what makes one
case's requests invisible to the next. And slowapi registers each limit under
``f"{func.__module__}.{func.__name__}"``, so a fixture that builds several applications from
one endpoint factory must give each endpoint a distinct ``__name__``: reusing a single name
appends another copy of the same limit to that key, and because the copies share a storage
key one request then consumes several hits and the budget appears to vanish. Routes defined
once at import - which is every real route in this service - are unaffected.
"""


class _RouteDecorator(Protocol):
    """A decorator that returns the endpoint it was given, with its signature intact.

    ``Limiter.limit`` is annotated as returning a bare ``typing.Callable``, which means
    ``Callable[..., Any]``. Applying that to a route handler passes type checking but erases
    the handler: mypy reduces the decorated function to ``Any``, and from then on any call to
    it - wrong argument types, wrong argument count, misspelled keyword - is accepted in
    silence. On a router where every function takes an injected session and a resolved
    principal, that is the checking that matters most.

    Annotating :data:`auth_rate_limit` with this protocol restores it. The type parameter on
    ``__call__`` binds to the decorated function's own type and is returned unchanged, so a
    handler keeps its exact signature and return type after decoration and misuse is
    reported normally.

    The claim is true at runtime as well as in the type checker: slowapi wraps the endpoint
    with ``functools.wraps``, which sets ``__wrapped__``, and ``inspect.signature`` follows
    that - so FastAPI reads the original signature and dependency injection, request-body
    parsing and the generated OpenAPI document all behave as though the decorator were not
    there.
    """

    def __call__[EndpointT: Callable[..., Any]](self, endpoint: EndpointT, /) -> EndpointT:
        """Register ``endpoint`` with the limiter and return it unchanged."""
        ...


auth_rate_limit: Final[_RouteDecorator] = limiter.limit(settings.AUTH_RATE_LIMIT)
"""Apply the configured authentication limit to a route.

``app.api.v1.routers.auth`` applies this one name to all five of its routes, so the policy is
stated once and the limit expression never appears in the router. A second, looser policy
would be added here as another named decorator built from its own setting - callers must not
pass raw limit strings, or the configuration surface leaks out of ``app.core.config`` and
into the route definitions.

Two requirements on every route this is applied to. The first fails loudly; the second is the
one that does not, so it is the one to check in review:

**The endpoint must have a parameter named ``request``**, annotated ``fastapi.Request``.
slowapi locates the limiter and the client key through that object. The parameter name is
what is checked, and it is checked when the decorator is applied - that is, at import time -
so a route that omits it prevents the application from starting rather than failing on a
later request. The check runs whether or not the limiter is enabled, so a suite running with
it disabled cannot hide a missing parameter.

**The route decorator must be the outer one.** ``@router.post(...)`` goes above
``@auth_rate_limit``:

.. code-block:: python

    @router.post("/login", response_model=TokenPair)
    @auth_rate_limit
    async def login(request: Request, credentials: LoginRequest) -> TokenPair:
        return await auth_service.login(credentials)

Reversing the two is the one failure mode here that is silent. The router registers whatever
function it is handed, so if ``@auth_rate_limit`` sits on the outside the router registers
the undecorated handler, the limiter is never consulted, and the route serves unlimited
requests while still looking rate limited. Verified directly: in the correct order a
``2/minute`` limit answers 200, 200, 429, 429; reversed it answers 200 four times.
"""
