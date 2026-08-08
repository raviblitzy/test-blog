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
    the instance out of rotation rather than routing requests it has no way to serve.

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
3. **It runs the one sanctioned in-handler query.** Layering elsewhere is absolute - a route
   delegates to a service, the service delegates to a repository, and the repository owns
   every statement. :func:`readiness` issues ``SELECT 1`` inline instead, and that is a narrow,
   documented exception rather than a precedent: the statement reads no table, touches no
   mapped model and returns no domain data, so there is nothing for a service to decide and
   nothing for a repository to own. Wrapping one round trip in two layers of indirection would
   add a ``ReadinessService`` and a ``HealthRepository`` whose combined behaviour is the
   statement itself. ``app.repositories`` is deliberately not imported here, which is what
   keeps the exception confined to this file.

Why the response models are declared here
-----------------------------------------
:class:`LivenessResponse` and :class:`ReadinessResponse` are the only response models in the
service that do not come from ``app.schemas``. That package is a closed set of eight sibling
modules - ``auth``, ``user``, ``post``, ``category``, ``comment``, ``like``, ``admin`` and
``common`` - each owning the wire shapes of one aggregate, and there is no ``health`` among
them because a probe is not an aggregate: neither shape has a database column behind it, a
repository that returns it or a service that assembles it. Declaring them where they are
served keeps the contract layer describing the domain and keeps this module readable on its
own. The single shape this file does import is ``ProblemDetail``, because a readiness failure
must be indistinguishable on the wire from every other error the API reports.

Both models are minimal on purpose. Neither carries a version string, a hostname, a
connection URL, an environment name, a commit hash, a dependency inventory or a latency
figure. Every one of those is a gift to somebody fingerprinting an unauthenticated endpoint,
and none of them helps the only two callers that exist - a container health check and an
orchestrator - both of which decide on the status code alone.

Nothing is logged here
----------------------
There is no logger in this module, and that is a decision rather than an omission.
``app.middleware.request_context`` already emits one structured access record per request,
and it treats these two paths specifically: ``QUIET_ACCESS_LOG_PATHS`` downgrades them to
``debug`` **only** while they neither fail nor answer badly, so a readiness probe answering
503 is logged at ``error`` with its status, its path, its duration and the bound
``request_id``. The outcome is therefore already in the log stream without a line from here.

The one thing a line here could add is the text of the exception :func:`readiness` catches,
and ``app.core.exceptions`` documents exactly why that text is unwelcome: psycopg's
connection-failure message names the host, the port, the database and the user it tried. It
never reaches a response body, and there is no reason to start moving it around internally
either.

Governing standards
-------------------
``review_rules`` reports that this project specifies no user rules, so none governs this
file. The self-imposed standards this repository holds itself to stand in their place, and
five of them decide the shape of this module: *day-one observability*, which this file is the
one that discharges and which requires two separate probes with genuinely different
semantics; *explicit API contracts*, which is why both routes declare a ``response_model``
and why the failure path emits the same problem document as every other route; *API
versioning*, which these two paths are the single documented exception to; *layered
separation of concerns*, which is why the inline statement above is scoped as narrowly as it
is; and *blocking quality gates*, which is why ``ruff``, ``mypy`` and
``backend/tests/integration/test_health.py`` all have to pass on it.
"""

from typing import Any, Final, Literal

from fastapi import APIRouter, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from app.core.dependencies import DbSession
from app.core.exceptions import AppError
from app.schemas import ProblemDetail

__all__ = ["LivenessResponse", "ReadinessResponse", "router"]


# ---------------------------------------------------------------------------------------
# The 503 problem document
#
# `app.core.exceptions` defines the error contract and five domain members of it - 404, 409,
# 403, 422 and 401 - and deliberately no 503, because a service unavailability is not a
# domain failure any service raises. Its `(type, title)` pair for the status nevertheless
# already exists, as private constants behind the `_STATUS_PROBLEM` table that renders a
# framework-raised 503. Private means they cannot be imported, so the two strings are
# restated below and MUST stay identical to that table's 503 entry character-for-character:
# a client branching on `type` has to see one value for the status whether the 503 came from
# this probe or from anywhere else, and that is the entire purpose of a stable type field.
# ---------------------------------------------------------------------------------------

_ERROR_TYPE_SERVICE_UNAVAILABLE: Final[str] = "/errors/service-unavailable"
"""``type`` of the readiness failure document: a URI reference, kebab-case, as the contract
requires. Mirrors ``app.core.exceptions``'s 503 entry."""

_TITLE_SERVICE_UNAVAILABLE: Final[str] = "Service Unavailable"
"""``title`` of the readiness failure document. Stable per status, so it is safe to use as a
log dimension or a dashboard label. Mirrors ``app.core.exceptions``'s 503 entry."""

_DETAIL_NOT_READY: Final[str] = "The service is not ready to accept traffic."
"""``detail`` of the readiness failure document, and a fixed sentence rather than the caught
exception's message.

This is the field an unauthenticated caller reads, and the exception behind it is a database
connection failure whose message names the host, the port, the database and the user that
was tried - a topology and credential disclosure, which ``app.core.exceptions`` calls out as
the concrete hazard of a probe passing its error text through. A fixed sentence also keeps
the document stable: two readiness failures for two different underlying reasons produce the
same ``detail``, so nothing downstream starts parsing it.

It states the verdict rather than the cause on purpose. The verdict is what the caller acts
on; the cause is an operator's concern and reaches them through the access log record that
``app.middleware.request_context`` emits at ``error`` for this response."""


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


class _DatabaseUnavailableError(AppError):
    """503 - the readiness statement did not complete, so this instance cannot serve traffic.

    A subclass rather than a bare :class:`~app.core.exceptions.AppError`, because that base's
    ``__init__`` accepts a ``detail``, ``headers`` and field ``errors`` but no status: the
    class documents ``status_code``, ``error_type``, ``title`` and ``detail`` as ordinary
    per-subclass attributes for exactly this reason, and the five domain members of the
    hierarchy configure their statuses the same way. Declaring one here is what lets the
    single registered ``AppError`` handler render this failure, since Starlette dispatches by
    walking ``type(exc).__mro__``: the document, its ``instance`` path, its ``request_id``,
    its ``X-Request-ID`` header and its ``application/problem+json`` media type all come from
    that one handler, so a readiness failure is byte-for-byte the same kind of object as a 404
    from a post lookup.

    It lives in this module rather than in ``app.core.exceptions`` because it is not a domain
    error. No service raises it, no ownership or lifecycle rule produces it, and nothing but
    this one probe can detect the condition, so the hierarchy of failures the *domain* reports
    stays exactly the five it declares.

    Private because it is the vehicle for one raise site rather than part of this module's
    contract. The public surface is :data:`router` and the two response models; a caller that
    needs to recognise this failure branches on the ``type`` field of the document, which is
    the field the error contract publishes for that purpose.
    """

    status_code: int = status.HTTP_503_SERVICE_UNAVAILABLE
    error_type: str = _ERROR_TYPE_SERVICE_UNAVAILABLE
    title: str = _TITLE_SERVICE_UNAVAILABLE
    detail: str = _DETAIL_NOT_READY


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
# literal nested in a decorator argument. `model` is what puts the 503 body into the generated
# document: without it the failure mode is undocumented and a client generator emits no type
# for it, which is precisely the gap the "every route declares its shapes" standard closes.
_READINESS_FAILURE_RESPONSES: Final[dict[int | str, dict[str, Any]]] = {
    status.HTTP_503_SERVICE_UNAVAILABLE: {
        "model": ProblemDetail,
        "description": (
            "The database could not be reached, so this instance is not ready to serve "
            "traffic. The body is the same problem document every other failure in this API "
            "returns, with `type` set to `/errors/service-unavailable`. An orchestrator "
            "should stop routing to this instance and keep polling; it should not restart it "
            "on this signal alone, because the process itself is healthy - `/healthz` "
            "continues to answer 200 throughout."
        ),
    }
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
        "and 503 with a problem document when it is not. Nothing is cached, because a cached "
        "readiness answer is a stale one."
    ),
)
async def readiness(db: DbSession) -> ReadinessResponse:
    """Prove the database is reachable, or answer 503.

    ``SELECT 1`` and nothing more: no table, no mapped model, no row count and no
    migration-version check. Each of those would make readiness fail for a reason that is not
    unreachability - a table not yet created by a migration that is still running, a revision
    the deployment is mid-way through applying - and an instance pulled out of rotation by its
    own schema check is an outage the probe invented. Reachability is the one question this
    route is here to answer, so it asks exactly that.

    The statement is issued inline rather than through a service and a repository. See point 3
    of the module docstring for why that exception is correct here and why it does not
    generalise: ``app.repositories`` is not imported by this file.

    Why the ``try`` is where the failure surfaces:
        ``app.db.session`` constructs its engine and its session factory lazily and opens no
        connection at import time, and ``app.core.dependencies.get_db`` only enters the
        session's context manager - so an unreachable database does not fail while FastAPI is
        resolving :data:`~app.core.dependencies.DbSession`. The first thing that needs a live
        connection is the ``execute`` below, which is inside the ``try``. Were it otherwise,
        dependency resolution would raise before this function was ever called and the route
        would answer 500 through the handler of last resort instead of a deliberate 503.

    ``Exception`` is caught deliberately broadly: a refused connection, a DNS failure, a
    timeout, an exhausted pool, an authentication rejection and a statement error are all the
    same answer to the only question being asked, and enumerating driver exception classes
    here would turn a new failure mode into a 500. It is not, however, bare - ``BaseException``
    is not caught, so ``asyncio.CancelledError`` from a client that disconnected mid-request
    still propagates and is not misreported as a database outage.

    Args:
        db: A request-scoped session, from the one dependency in the service that yields one.
            Constructed lazily, so obtaining it proves nothing about connectivity; the
            statement below is what proves it.

    Returns:
        The readiness document, with ``database`` true, when the statement completed.

    Raises:
        _DatabaseUnavailableError: When the statement did not complete, for any reason. The
            registered ``AppError`` handler renders it as a 503 problem document carrying a
            fixed detail - the caught exception's own message names the host, the port, the
            database and the user, and never reaches the response.
    """
    try:
        # The result is deliberately unused: a completed round trip is the whole assertion,
        # and reading a row from it would prove nothing further. Nothing is committed either,
        # because nothing was written - transaction boundaries belong to the service layer,
        # and this route has no unit of work to close.
        await db.execute(select(1))
    except Exception as exc:
        # Chained rather than swallowed, so the cause is preserved on the traceback for
        # anything that inspects it, while the rendered document carries only the fixed
        # detail. `from exc` is also what keeps this raise honest about its origin.
        raise _DatabaseUnavailableError from exc

    return ReadinessResponse(status="ready", database=True)
