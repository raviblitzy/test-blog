"""The two operational probes: ``GET /healthz`` for liveness, ``GET /readyz`` for readiness.

Two routes asking two deliberately different questions:

``GET /healthz``
    *Should this process be restarted?* It touches nothing - no database, no session, no
    dependency of any kind - and answers from a constant, so it stays truthful while every
    downstream dependency is unreachable. ``backend/Dockerfile`` aims its ``HEALTHCHECK``
    here precisely because of that.
``GET /readyz``
    *Should this process be sent traffic?* It proves the database is reachable by issuing one
    trivial statement per request, and answers 503 when it cannot, so an orchestrator drops
    the instance out of rotation rather than routing requests it has no way to serve. It holds
    that interaction to :data:`READINESS_TIMEOUT_SECONDS` - a probe that outlives its caller's
    timeout answers nobody - and it answers 503 only for a failure of the database, never for a
    defect in this service, which reaches the 500 owner with its traceback instead.

Collapsing the two into one route is the classic mistake, and it fails in both directions. A
liveness probe that touches the database restarts a perfectly healthy process every time
PostgreSQL is restarted or fails over. A readiness probe that touches nothing keeps an
instance in rotation that cannot answer a single query. Keeping them separate is why
``app.main`` can wire a restart policy to one and a load-balancer decision to the other.

Three ways this module is the deliberate outlier of its package
---------------------------------------------------------------
Every sibling in ``app.api.v1.routers`` does the opposite of this file on three counts, and
each asymmetry is intentional rather than an inconsistency to be tidied away:

1. **It owns its tag.** The seven domain modules construct a bare ``APIRouter()`` and let
   ``app.api.v1.router`` attach the prefix and the OpenAPI tag on each ``include_router``
   call. This router carries ``tags=["health"]`` itself, because the aggregate never includes
   it - ``app.main`` mounts it directly. The string matches ``app.main``'s ``openapi_tags``
   entry character-for-character; a drift there and these two operations would be filed under
   a section the document does not describe.
2. **It owns its paths, and they are absolute and unversioned.** A sibling spells its
   collection ``@router.get("")`` and never writes ``/api/v1`` in a decorator. Here the paths
   are written out in full and no ``prefix=`` is set, so ``/healthz`` and ``/readyz`` are the
   only unversioned paths in the entire service. They are exempt because they are
   infrastructure rather than product: an orchestrator has to probe both before anything has
   told it which API version to speak, and a probe that moved with the version would have to
   be reconfigured by every deployment that bumped it.
3. **It is the one router with an asymmetric pair of handlers.** :func:`readiness` delegates,
   exactly as every other route in the service does: it calls
   :meth:`~app.services.health_service.HealthService.check_readiness` and constructs its response
   model, and the statement, the failure classification, the log record and the 503 all live behind
   that one call. :func:`liveness` delegates to nothing at all and resolves no dependency, because
   a dependency is something that can fail and a liveness probe that can fail for a reason outside
   the process is indistinguishable from a process that needs restarting. One router, one handler
   that must reach the database and one that must never touch it.

   There is **no** layering exemption here, and an earlier revision of this file claimed one: it
   issued ``SELECT 1`` inline and argued in prose that one round trip was too small to be worth a
   service and a repository. A code review rejected that, correctly. AAP §0.2.3 makes the rule
   unconditional - "Route handlers contain no data-access logic" - and an exemption that has to be
   argued is a precedent, whatever its prose says: the next handler that needs "just one query" had
   this file to point at. ``app.repositories`` is still not imported here, but now for the ordinary
   reason rather than a special one - a router never imports it.

Why the response models are declared here
-----------------------------------------
:class:`LivenessResponse` and :class:`ReadinessResponse` are the only response models in the
service that do not come from ``app.schemas``. That package is a closed set of eight sibling
modules - ``auth``, ``user``, ``post``, ``category``, ``comment``, ``like``, ``admin`` and
``common`` - each owning the wire shapes of one aggregate, and there is no ``health`` among
them because a probe is not an aggregate: neither shape has a database column behind it, a
repository that returns it or a service that assembles it. Declaring them where they are
served keeps the contract layer describing the domain and keeps this module readable on its
own. The single failure shape this file declares comes from
:func:`~app.schemas.common.problem_response` rather than being described here, because a
readiness failure must be indistinguishable on the wire - body *and* media type - from every
other error the API reports.

Both models are minimal on purpose. Neither carries a version string, a hostname, a
connection URL, an environment name, a commit hash, a dependency inventory or a latency
figure. Every one of those is a gift to somebody fingerprinting an unauthenticated endpoint,
and none of them helps the only two callers that exist - a container health check and an
orchestrator - both of which decide on the status code alone.

Nothing is logged in this file
------------------------------
``app.middleware.request_context`` already emits one structured access record per request, and
it treats these two paths specifically: ``QUIET_ACCESS_LOG_PATHS`` downgrades them to ``debug``
**only** while they neither fail nor answer badly, so a readiness probe answering 503 is logged
at ``error`` with its status, its path, its duration and the bound ``request_id``.

That record says the probe failed; it cannot say **why**, and the difference matters
operationally. The classified failure record that closes the gap - a classification drawn from
``ReadinessFailureClass``, the
exception class name, the originating driver class name and the SQLSTATE where the driver supplied
one, and deliberately never the driver's own message - is emitted by
``app.services.health_service``, immediately before it raises, because that is the layer that
catches the exception and therefore the only layer that can still see the cause. "Exactly one
record is logged" in that module's docstring is the full account of what it carries and what it
omits.

This module logs nothing, obtains no logger, and imports ``app.core.logging`` not at all. Both
handlers below either return a constructed response model or let a raised domain error be rendered
by the registered ``AppError`` handler.

That record is emitted for a **failure of the database**, and for nothing else. The handler
catches ``SQLAlchemyError`` and ``OSError`` rather than ``Exception``, so an
``AttributeError``, a ``TypeError`` or any other defect in this service's own code is never
classified, never renamed as a dependency outage and never answered 503. It propagates instead,
and ``app.core.exceptions`` answers it with the standard 500 problem document *and* logs it with
``logger.exception``, so the frames that identify the defect survive - redacted, because
``app.core.logging`` reduces addresses and strips credentials from the rendered traceback. The
two outcomes are therefore distinguishable at a glance: a 503 on ``/readyz`` means the database
could not serve a trivial statement, a 500 on ``/readyz`` means this file has a bug.

One member of that classification vocabulary is not a fault at all. ``query_timeout`` is
reported when the interaction outlived :data:`READINESS_TIMEOUT_SECONDS` - this route's own
deadline, not a diagnosis - or when PostgreSQL cancelled the statement at the server-side
ceiling ``app.db.session`` sets. It is logged like the others because it has the same
operational consequence, and it is named separately because the remedy is different: a
connection that was refused needs the database brought back, a connection that answered
nothing needs the network path or a saturated server looked at.

Governing standards
-------------------
``review_rules`` reports that this project specifies no user rules, so none governs this
file. The self-imposed standards this repository holds itself to stand in their place, and
five of them decide the shape of this module: *day-one observability*, which this file is the
one that discharges and which requires two separate probes with genuinely different
semantics; *explicit API contracts*, which is why both routes declare a ``response_model``
and why the failure path emits the same problem document as every other route; *API
versioning*, which these two paths are the single documented exception to; *layered
separation of concerns*, which is why :func:`readiness` delegates to a service rather than
querying and which this file no longer claims any exemption from; and *blocking quality gates*,
which is why ``ruff``, ``mypy`` and ``backend/tests/integration/test_health.py`` all have to pass
on it.
"""

from typing import Final, Literal

from fastapi import APIRouter, status
from pydantic import BaseModel, ConfigDict, Field

from app.core.dependencies import DbSession
from app.schemas.common import ProblemResponses, problem_response
from app.services import HealthService

# Re-exported rather than restated: the deadline is the service's, because the service is what
# applies it, and this module publishes the name so the probe documentation and
# `backend/tests/integration/test_health.py` can both refer to one number.
from app.services.health_service import READINESS_TIMEOUT_SECONDS

__all__ = ["READINESS_TIMEOUT_SECONDS", "LivenessResponse", "ReadinessResponse", "router"]


# ---------------------------------------------------------------------------------------
# Response models
#
# Declared here rather than in `app.schemas` - see "Why the response models are declared
# here" in the module docstring. Both fields are required rather than defaulted, so the
# generated document lists them under `required` and a generated client types them as always
# present, which is what a response model is for. The literal annotations are load-bearing:
# they publish the exact accepted value in the schema, and mypy rejects a handler that
# returns any other string, so the model and the two constructions below cannot drift apart.
# ---------------------------------------------------------------------------------------


class LivenessResponse(BaseModel):
    """Body of a successful ``GET /healthz``: the process is running.

    One field, and nothing else by design. A liveness answer that carried a version, a build
    identifier or an uptime figure would be a fingerprinting surface on an unauthenticated
    route, and neither caller of this endpoint - a container health check and an orchestrator
    - reads the body at all. The status code is the answer; this shape exists so the route
    can declare one.
    """

    model_config = ConfigDict(
        json_schema_extra={
            # The only body this route can produce, so the example is the response itself
            # rather than an illustration of it.
            "example": {"status": "alive"}
        }
    )

    status: Literal["alive"] = Field(
        ...,
        description=(
            "Always `alive`. The process is running and its event loop is scheduling work, "
            "which is the whole of what liveness asserts. It says nothing about whether the "
            "database is reachable - that is `/readyz` - so a healthy `/healthz` beside a "
            "failing `/readyz` is a correct and expected combination, not a contradiction."
        ),
    )


class ReadinessResponse(BaseModel):
    """Body of a successful ``GET /readyz``: the process can serve traffic.

    Emitted only when the readiness statement succeeded. The failure case is not a variant of
    this shape - it is a :class:`~app.schemas.common.ProblemDetail` at 503 - so a caller never
    has to inspect the body to learn the verdict.
    """

    model_config = ConfigDict(
        json_schema_extra={
            # As above: the only body this route can produce.
            "example": {"status": "ready", "database": True}
        }
    )

    status: Literal["ready"] = Field(
        ...,
        description=(
            "Always `ready`. Every dependency readiness is decided on answered, so this "
            "instance can be sent traffic."
        ),
    )
    database: bool = Field(
        ...,
        description=(
            "Always `true` in a 200 response, and that is the contract rather than a "
            "redundancy: readiness answers 503 with a problem document when the database is "
            "unreachable, instead of 200 with `false`, because an orchestrator that reads "
            "only the status code must not route traffic to an instance that cannot query. "
            "The field is still worth carrying because it names the dependency the verdict "
            "was reached on, so a second dependency added later extends this body with "
            "another named flag rather than changing the meaning of the existing one."
        ),
    )


# ---------------------------------------------------------------------------------------
# The router
#
# Tag set here and paths written absolute, because `app.main` mounts this object directly
# instead of through `app.api.v1.router`'s aggregate - see point 1 and point 2 of the module
# docstring. No `prefix=`: adding one would version the probes, and no rate limit either,
# because `app.core.rate_limit` configures no default limits and names these two paths as
# untouched - throttling a health check is how a container gets restarted under load.
# ---------------------------------------------------------------------------------------

router = APIRouter(tags=["health"])
"""The probe router, mounted unprefixed by ``app.main``.

Reached as ``from app.api.v1.routers.health import router``, never through the
``app.api.v1.routers`` package, and never added to ``app.api.v1.router``'s aggregate: the
aggregate attaches the ``/api/v1`` prefix to everything it includes, which is the one thing
these two paths must not have."""


# One entry, declared as a constant so the annotation is explicit rather than inferred from a
# literal nested in a decorator argument, and built by `app.schemas.common.problem_response`
# - the single place in the API tier that names the problem document as a response model and
# the single place its published media type is decided. Without a model the failure mode is
# undocumented and a client generator emits no type for it, which is precisely the gap the
# "every route declares its shapes" standard closes.
_READINESS_FAILURE_RESPONSES: Final[ProblemResponses] = {
    status.HTTP_503_SERVICE_UNAVAILABLE: problem_response(
        "The database could not be reached, or did not answer inside this route's five-second "
        "deadline, so this instance is not ready to serve "
        "traffic. The body is the same problem document every other failure in this API "
        "returns, served as `application/problem+json` with `type` set to "
        "`/errors/service-unavailable`. An orchestrator should stop routing to this instance "
        "and keep polling; it should not restart it on this signal alone, because the process "
        "itself is healthy - `/healthz` continues to answer 200 throughout."
    )
}


@router.get(
    "/healthz",
    response_model=LivenessResponse,
    status_code=status.HTTP_200_OK,
    summary="Liveness probe",
    description=(
        "Reports that the process is running. Performs no database work and resolves no "
        "dependency, so it answers 200 even while the database is unreachable - which is what "
        "makes it safe to wire to a restart policy. Use `/readyz` to decide whether to send "
        "traffic."
    ),
)
async def liveness() -> LivenessResponse:
    """Answer the liveness question from a constant.

    The signature takes no parameters, and that is the contract of this route rather than an
    incidental simplicity. It resolves no dependency at all - in particular not
    ``app.core.dependencies.DbSession``, and this module does not import ``app.db.session`` -
    because a dependency is something that can fail, and a liveness probe that can fail for a
    reason outside the process is indistinguishable from a process that needs restarting.

    ``backend/Dockerfile`` aims its ``HEALTHCHECK`` at this route for that reason, and
    "returns 200 without touching the database" is a blocking acceptance criterion for this
    service rather than a description of the current implementation: it is verified by
    stopping PostgreSQL and re-requesting this path.

    Returns:
        The constant liveness document. Reaching this line is the entire assertion - the
        process accepted a connection, routed a request and ran a coroutine on its event loop.
    """
    return LivenessResponse(status="alive")


@router.get(
    "/readyz",
    response_model=ReadinessResponse,
    status_code=status.HTTP_200_OK,
    responses=_READINESS_FAILURE_RESPONSES,
    summary="Readiness probe",
    description=(
        "Reports whether this instance can serve traffic, by issuing one trivial statement "
        "against the database on every request. Answers 200 while the database is reachable "
        "and 503 with a problem document when it is not, and answers within five seconds "
        "either way - a database that accepts the connection and then goes silent is treated "
        "as unavailable rather than waited on. Nothing is cached, because a cached readiness "
        "answer is a stale one."
    ),
)
async def readiness(db: DbSession) -> ReadinessResponse:
    """Ask the readiness service for a verdict, and shape the answer for the wire.

    One call and one construction, which is the whole of a route's job here.
    :meth:`~app.services.health_service.HealthService.check_readiness` owns everything a verdict
    actually requires - the statement, the classification of whatever went wrong from
    :data:`~app.services.health_service.ReadinessFailureClass`, the one classified log record and
    the 503 domain error - and this handler owns only what belongs to the
    API tier: resolving the session dependency, and turning "returned normally" into the declared
    response model.

    Nothing is cached, because a cached readiness answer is a stale one and an instance kept in
    rotation by a stale answer is an outage. Nothing is caught either: the service's
    :class:`~app.services.health_service.DatabaseUnavailableError` propagates to the registered
    ``AppError`` handler, which renders the 503 problem document with its ``instance`` path, its
    ``request_id`` and its ``application/problem+json`` media type - the same treatment every other
    failure in this API receives.

    Args:
        db: A request-scoped session, from the one dependency in the service that yields one.
            Constructed lazily, so obtaining it proves nothing about connectivity; the statement
            the service issues through it is what proves it. Passed straight through - this handler
            executes nothing against it, which is the point of the delegation.

    Returns:
        The readiness document, with ``database`` true. Reaching this line means the service
        returned rather than raised, and the two fields are constants for the reason
        :class:`ReadinessResponse` documents: the failure case is a problem document at 503, never
        a 200 carrying ``false``.

    Raises:
        ~app.services.health_service.DatabaseUnavailableError: Raised by the service when the
            readiness statement did not complete, for any reason. Declared here because it is part
            of this route's published contract - see :data:`_READINESS_FAILURE_RESPONSES` - and not
            re-raised or translated in this file.
    """
    await HealthService(db).check_readiness()
    return ReadinessResponse(status="ready", database=True)
