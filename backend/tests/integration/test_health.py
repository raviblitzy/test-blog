"""Integration suite for the two unversioned operational probes, driven over HTTP in process.

This module proves AAP §0.9.4.4's **health separation** criterion, in both of its directions:

``GET /healthz`` returns 200 *without touching the database*
    Verified positively - the route answers 200 in the ordinary case - and then verified the
    only way the claim can actually be tested: with a session provider installed that fails
    the instant anything resolves it. A liveness probe that reached the database would answer
    500 through that override; this one answers 200, because
    ``app.api.v1.routers.health.liveness`` declares no parameters and therefore resolves no
    dependency at all.

``GET /readyz`` returns 200 *only while the database is reachable*
    Verified positively against the live test database, and then verified negatively by
    substituting a session whose every statement fails. That negative is the load-bearing
    test of this module: without it, "readiness depends on the database" is an unexercised
    claim that a refactor could quietly break, leaving an instance in rotation that cannot
    answer a single query.

Both halves are also asserted *simultaneously*, in one failure window, because the separation
is a statement about the two routes **together**: a 200 from ``/healthz`` beside a 503 from
``/readyz`` is the correct and expected combination, and it is the combination that lets
``app.main`` wire a restart policy to one probe and a load-balancer decision to the other.
Collapsing them would fail in both directions - a liveness probe that queried would restart a
healthy process on every database failover, and a readiness probe that did not would keep a
useless instance receiving traffic.

Why the 503 is reachable only through a dependency override
-----------------------------------------------------------
There is no way to make the real database unreachable from inside a transactional test: the
suite's own connection is what the test runs on, and stopping PostgreSQL would take the
harness down with the subject. So the unreachability is *substituted*, through the installer
``backend/tests/conftest.py`` documents for exactly this purpose - :func:`override_get_db`,
whose teardown restores the entry that was present beforehand whether the test passes, fails
or is interrupted. ``app.dependency_overrides`` lives on a module-level application object
shared by every test in the session, so a leaked entry would not fail near the test that
caused it; it would silently redirect a later one. Nothing here calls
``app.dependency_overrides.clear()``, which would additionally discard the working override
:func:`client` installs and break isolation for the remainder of the run.

The substituted session fails at ``execute``, never on the way in, and that detail is
load-bearing. :meth:`~app.services.health_service.HealthService.check_readiness` wraps only
the repository's one statement in its ``try``, so a provider that raised during dependency
resolution would surface as a 500 through the handler of last resort instead of the deliberate
503 this suite is here to assert. The one place a
raise-on-resolution provider *is* used is the liveness isolation test above, where reaching it
at all is the failure being detected.

``GET /readyz`` answers *inside a bounded window* when a statement does not return
    A database that refuses a connection fails in milliseconds. A database that accepts one and
    then takes far too long over a statement raises nothing until something bounds it, and a probe
    with no deadline of its own answers long after the orchestrator that asked has given up - and
    long after the classified failure record would still have been worth writing. The route's own
    deadline is therefore asserted as the promise it is, against a substituted session whose
    statement never completes. ``app.api.v1.routers.health.READINESS_TIMEOUT_SECONDS`` documents
    the one transport failure no client-side deadline can shorten; that case is a property of the
    driver's cancellation path rather than of this route, so it is documented there and not
    simulated here.

``GET /readyz`` answers 503 for a **database** failure and 500 for a defect in *this service*
    The two are not the same event and must not produce the same answer. A 503 tells an
    orchestrator to withhold traffic from a healthy process; a 500 with frames tells an engineer
    a line of code is wrong. A handler that caught both alike reported its own bugs as
    infrastructure outages, logged no traceback for them, and kept them out of 5xx alerting -
    so both directions are asserted here.

What is asserted, and what deliberately is not
----------------------------------------------
Status codes, response headers and response bodies - the wire - for every claim the wire can
carry. Nothing here inspects a handler, a service or a repository: every request goes through
the in-process client, which is what makes these integration tests rather than unit tests of
:mod:`app.api.v1.routers.health`.

Two claims cannot be read off the wire, and both are read off the log instead, through the
service's own configured handler pointed at a buffer:

* **the classification** a readiness failure is filed under. The document is deliberately
  identical for every cause, so the classification is the only place the reason survives - and
  two of its members arrive as the *same* exception class, separated by nothing but a condition
  code, which is precisely the kind of wiring that breaks silently.
* **the traceback** a defect escaping to the handler of last resort carries. Answering 500 is
  half of treating a bug as a bug; the frames are the half that makes it findable.

One module constant is substituted, in the timeout cases only:
``READINESS_TIMEOUT_SECONDS`` is patched down from five seconds to fifty milliseconds so a
blocking gate does not pay five seconds per case to prove a deadline binds. The production value
is asserted directly, and against the lower-layer bounds it has to sit beneath, by a test that
patches nothing.

:class:`TestApiTierLayering` is a deliberate departure from that rule, and it exists because the
wire cannot express the property it asserts. Readiness answered 200 and 503 identically before and
after the statement was moved out of the route and behind
:class:`~app.services.health_service.HealthService`, so every behavioural test in this file passed
against the layering violation a review found here. A behavioural suite cannot tell a delegating
handler from a querying one; only the source can, so that class reads it.

Two further contracts are asserted here because nothing else enforces them:

* **The version-prefix exemption is bounded.** ``/healthz`` and ``/readyz`` are the only two
  unversioned paths in the service (AAP §0.10.1 #5), and an exemption that is not bounded is a
  loophole. Both paths are asserted reachable unprefixed *and* absent under ``/api/v1``, where
  they must answer 404. ``backend/tests/integration/test_openapi_contract.py`` asserts the same
  exemption from the published document; this module asserts it live.
* **The problem document's own ``status`` agrees with the HTTP status.**
  ``app.core.exceptions`` builds the body as a plain dictionary, so the two are the same value
  by construction and nothing downstream re-checks it - which makes it exactly the kind of
  agreement that drifts unnoticed.

Governing standards
-------------------
``review_rules`` reports that this project specifies **no user rules**, so none governs this
file; it is in scope solely because AAP §0.4.4.5 and §0.7.1.11 name it. The repository's
self-imposed standards stand in their place, and four decide the shape of this module:
*day-one observability* (§0.10.1 #11), whose entire backend deliverable is the two separate
probes and which this module is the only verification of; *API versioning* (#5), the exemption
above; *explicit API contracts* (#4), which is why the success bodies are asserted as exact
documents and the failure body as the uniform problem document; and *blocking quality gates*
(#8), which is why nothing here is skipped, expected to fail, dependent on execution order or
dependent on anything outside the fixtures it declares.
"""

from __future__ import annotations

import ast
import asyncio
import io
import json
from collections.abc import AsyncIterator, Callable, Iterator
from http import HTTPStatus
from pathlib import Path
from time import perf_counter
from typing import Any, Final, NoReturn, get_args

import pytest
from httpx import AsyncClient, Response
from sqlalchemy.exc import (
    DBAPIError,
    InterfaceError,
    OperationalError,
    TimeoutError as PoolTimeoutError,
)
from sqlalchemy.ext.asyncio import AsyncSession

import app.api
from app.api.v1.router import API_V1_PREFIX
from app.api.v1.routers import health
from app.core.logging import configure_logging
from app.db.session import STATEMENT_TIMEOUT_SECONDS, TCP_KEEPALIVE_ARGS
from app.services import health_service

# ---------------------------------------------------------------------------------------
# The two paths under test
#
# Spelled out here because `app.api.v1.routers.health` writes them as literals in its route
# decorators and exports no constant for either - it is the one router in the package that
# owns its paths, precisely because `app.main` mounts it outside the versioned aggregate. The
# prefix, by contrast, IS exported, so it is imported rather than restated: `API_V1_PREFIX` is
# published by `app.api.v1.router` for the application, the tests and the documentation to
# share one spelling, and building the negative paths from it means a future change to the
# prefix moves these assertions with it instead of leaving them passing against a segment the
# service no longer serves.
# ---------------------------------------------------------------------------------------

LIVENESS_PATH: Final[str] = "/healthz"
"""Liveness probe path. Unversioned, and the target of ``backend/Dockerfile``'s health check."""

READINESS_PATH: Final[str] = "/readyz"
"""Readiness probe path. Unversioned, and what an orchestrator polls to route or withhold."""

PREFIXED_LIVENESS_PATH: Final[str] = f"{API_V1_PREFIX}{LIVENESS_PATH}"
"""Where liveness must **not** be served. Asserted to answer 404, bounding the exemption."""

PREFIXED_READINESS_PATH: Final[str] = f"{API_V1_PREFIX}{READINESS_PATH}"
"""Where readiness must **not** be served. Asserted to answer 404, for the same reason."""


# ---------------------------------------------------------------------------------------
# The wire contracts
#
# Every value below was read out of the module that serves it rather than guessed, and each is
# asserted as an EXACT document instead of a subset. Exactness is the assertion: dictionary
# equality fails on an added field as well as on a changed one, which is what holds
# `LivenessResponse` and `ReadinessResponse` to the minimalism their docstrings promise - no
# version string, no hostname, no environment name, no commit hash, none of the things that
# make an unauthenticated probe a fingerprinting surface.
# ---------------------------------------------------------------------------------------

LIVENESS_BODY: Final[dict[str, object]] = {"status": "alive"}
"""The only body ``GET /healthz`` can produce - ``LivenessResponse``, whose single field is
annotated ``Literal["alive"]``."""

READINESS_BODY: Final[dict[str, object]] = {"status": "ready", "database": True}
"""The only body a successful ``GET /readyz`` can produce. ``database`` is always ``true`` in
a 200: unreadiness is reported as a 503 problem document, never as a 200 carrying ``false``,
because an orchestrator that reads only the status code must not route to an instance that
cannot query."""

JSON_MEDIA_TYPE: Final[str] = "application/json"
"""Media type of a successful response, from the application's default response class."""

PROBLEM_MEDIA_TYPE: Final[str] = "application/problem+json"
"""Media type of **every** error response - ``app.core.exceptions.PROBLEM_JSON_MEDIA_TYPE``.
A readiness failure has to be indistinguishable on the wire, media type included, from every
other failure the API reports."""

REQUEST_ID_HEADER: Final[str] = "X-Request-ID"
"""Correlation header - ``app.core.exceptions.REQUEST_ID_HEADER``. Present on every response,
and equal to a problem document's ``request_id`` member by construction."""

PROBLEM_KEYS: Final[frozenset[str]] = frozenset(
    {"type", "title", "status", "detail", "instance", "request_id"}
)
"""The complete key set of a non-validation problem document.

Exactly six. ``app.schemas.common.ProblemDetail`` declares a seventh, ``errors``, and
``app.core.exceptions`` omits the key entirely when it would be null or empty - so a document
carrying it here would mean a field-level validation failure had been reported for a probe that
accepts no input. Asserting the set rather than the presence of six names is what catches an
addition as well as a removal.
"""

NOT_FOUND_TYPE: Final[str] = "/errors/not-found"
"""``type`` of the 404 the prefixed paths must answer with. Stable per status, so a client can
branch on it."""

NOT_FOUND_TITLE: Final[str] = "Not Found"
"""``title`` of that 404."""

SERVICE_UNAVAILABLE_TYPE: Final[str] = "/errors/service-unavailable"
"""``type`` of the readiness failure document. The same value whatever the underlying cause
was, which is the entire purpose of a stable type field."""

SERVICE_UNAVAILABLE_TITLE: Final[str] = "Service Unavailable"
"""``title`` of the readiness failure document."""

SERVICE_UNAVAILABLE_DETAIL: Final[str] = "The service is not ready to accept traffic."

INTERNAL_TYPE: Final[str] = "/errors/internal-server-error"
"""``type`` of the 500 document, which a defect inside the readiness handler must produce instead of
the 503 - the whole distinction :class:`TestReadinessDefects` exists to hold. Restated rather than
imported for the same reason as the two above: ``app.core.exceptions`` holds these privately, and a
published contract asserted against its own source proves nothing about what a client sees."""

INTERNAL_TITLE: Final[str] = "Internal Server Error"
"""``title`` of the 500 document."""

INTERNAL_DETAIL: Final[str] = "An unexpected error occurred."
"""``detail`` of the 500 document. Fixed, like every other detail this API publishes."""
"""``detail`` of the readiness failure document: a fixed sentence stating the verdict, never
the caught exception's message. Asserted as an equality rather than a pattern, because the
whole point is that two readiness failures with two different causes read identically."""


# ---------------------------------------------------------------------------------------
# Disclosure markers
#
# A real driver's connection failure names the host, the port, the database and the user it
# tried - `psycopg` renders exactly that - and `app.services.health_service` and
# `app.core.exceptions` both call out passing it through as a topology and credential
# disclosure on an UNAUTHENTICATED endpoint. That guarantee is asserted here by planting
# distinctive markers in the substituted failure's message and then searching the whole
# response for them: a marker cannot appear for any other reason, so its absence is an exact
# test rather than an approximate one.
#
# None of these is a real credential or a resolvable address. `.invalid` is reserved by
# RFC 2606 and can never resolve, the port is outside the registered range in common use, and
# the password is a self-describing placeholder.
# ---------------------------------------------------------------------------------------

MARKER_HOST: Final[str] = "db-marker.invalid"
MARKER_PORT: Final[str] = "65432"
MARKER_USER: Final[str] = "marker_db_user"
MARKER_PASSWORD: Final[str] = "MARKER-NOT-A-REAL-SECRET"
MARKER_DATABASE: Final[str] = "marker_blog_db"

MARKER_PORT_PHRASE: Final[str] = f"port {MARKER_PORT}"
"""The port marker as it is actually searched for, with the word that precedes it.

The bare number is deliberately **not** searched for alone. A five-digit decimal string is also
a valid hexadecimal one, and every response legitimately carries a 32-character hexadecimal
correlation identifier in its body and its header - so ``"65432"`` could occur there by chance,
roughly once in tens of thousands of requests, and fail this test for a reason that has nothing
to do with disclosure. An assertion that can fail for an unrelated reason is a flaky assertion,
and blocking gates (AAP §0.10.1 #8) may not be flaky. The space makes the phrase impossible in a
hexadecimal identifier while still proving the port text did not survive.
"""

DISCLOSURE_MARKERS: Final[tuple[str, ...]] = (
    MARKER_HOST,
    MARKER_PORT_PHRASE,
    MARKER_USER,
    MARKER_PASSWORD,
    MARKER_DATABASE,
)
"""Every marker that must not survive from a driver failure into the response.

Each is distinctive enough that it cannot appear in a response for any other reason - the host
carries a hyphen and an RFC 2606 reserved suffix, the user and database carry underscores, the
password is upper-case and hyphenated, and the port is searched for as a phrase.
"""

_FAILURE_MESSAGE: Final[str] = (
    f'connection to server at "{MARKER_HOST}" (10.255.255.1), '
    f"{MARKER_PORT_PHRASE} failed: "
    f'FATAL: password authentication failed for user "{MARKER_USER}" '
    f"(password={MARKER_PASSWORD} dbname={MARKER_DATABASE})"
)
"""A message shaped like the one a driver actually raises, carrying every marker at once."""


READINESS_STATEMENT: Final[str] = "SELECT 1"
"""The statement readiness issues, restated so the substituted failures name it too.

Not imported from anywhere: :meth:`~app.repositories.health_repository.HealthRepository.ping`
builds it as ``select(1)``, which has no textual form to share. It appears here only inside a
fabricated exception, so the two never need to agree - what matters is that a failure carries a
statement at all, because a real one does and it is one more
thing that must not reach the response.
"""

SQLSTATE_INVALID_PASSWORD: Final[str] = "28P01"
"""A SQLSTATE a rejected credential produces. Carried on a substituted driver exception so the
service's SQLSTATE extraction is exercised. A condition code names a *condition*, never a host, a
credential or a row, which is why ``app.services.health_service`` treats it as safe to log
while treating the message it arrived with as unsafe to publish."""

SQLSTATE_TOO_MANY_CONNECTIONS: Final[str] = "53300"
"""A SQLSTATE an exhausted server produces. Present for the same reason as the one above."""

SQLSTATE_QUERY_CANCELED: Final[str] = "57014"
"""PostgreSQL's ``query_canceled``, which is how a server-side ``statement_timeout`` reports itself.

Restated rather than imported: ``app.api.v1.routers.health`` holds it as a private constant, and
sharing one with the code under test would make the assertion circular. This is the code the
*server* publishes, so a test that spells it out is testing that the route recognises the database's
vocabulary rather than its own.

It arrives wrapped in an :class:`~sqlalchemy.exc.OperationalError`, which is the class the route
otherwise files as ``connection_failure`` - so this code is the only thing separating "the
connection failed" from "the connection was fine and the statement was killed", and those have
different remedies.
"""

_SILENCE_SECONDS: Final[float] = 30.0
"""How long :class:`SilentDatabaseSession` sleeps for: long enough that only a deadline can end it.

Three orders of magnitude above the deadline these tests install, so the pass is unambiguous - a
test that finishes quickly finished because the timeout fired, not because the sleep elapsed. It is
never actually waited out: ``asyncio.timeout`` cancels the sleep, so no test in this module costs
anything near this.
"""

_TEST_DEADLINE_SECONDS: Final[float] = 0.05
"""The deadline the timeout tests substitute for the route's real five seconds.

Fifty milliseconds because these tests must prove *that* the deadline binds, not *what* it is set
to - and a suite that waited the production value on every timeout case would add five seconds per
test to a blocking gate. The production value is asserted directly, and against the lower-layer
bounds it has to sit under, by
:meth:`TestReadinessDeadline.test_the_deadline_sits_below_every_lower_layer_bound`; nothing else in
this module reads or depends on it.
"""

_ELAPSED_CEILING_SECONDS: Final[float] = 2.0
"""The wall-clock ceiling a timed readiness request must come in under.

Forty times the substituted deadline and far below :data:`_SILENCE_SECONDS`, so it separates the
two outcomes without being sensitive to scheduling on a loaded machine. Strictly below the
*production* deadline as well - not equal to it - so this assertion fails rather than passing by a
scheduling margin if a future edit ever drops the substitution and lets the real value apply.
"""

_DEFECT_MESSAGE: Final[str] = "MARKER-READINESS-DEFECT: attribute does not exist"
"""Message of the fabricated programming defect, distinctive so the logged frames can be searched.

Not a disclosure marker: it is planted precisely so a test can prove it *did* reach the log, which
is the opposite of every other marker in this module.
"""

READINESS_FAILURE_EVENT: Final[str] = "readiness_probe_failed"
"""Event name ``app.api.v1.routers.health`` writes its classified failure record under.

Restated rather than imported, for the same reason as the SQLSTATE above: the route holds it
privately, and it is documented as stable so that alerts can be built on it - which makes it fair
game for one test to assert on, and worth asserting precisely because an alert would break silently
if it changed.
"""

UNHANDLED_EVENT: Final[str] = "unhandled_exception_response"
"""Event name ``app.core.exceptions`` writes when it renders a 500.

Asserted here because the readiness route deliberately routes a defect *to* that handler rather than
absorbing it, so the event is the evidence that the escape happened."""

LOG_FIELD_FAILURE_CLASS: Final[str] = "failure_class"
"""Field carrying the classification on the readiness failure record."""

LOG_FIELD_SQLSTATE: Final[str] = "sqlstate"
"""Field carrying the driver's condition code on the readiness failure record."""


class DriverFailureError(Exception):
    """Stand-in for the driver exception SQLAlchemy exposes as ``DBAPIError.orig``.

    Real drivers wrap a lower-level failure and publish a SQLSTATE alongside it - psycopg 3
    exposes the code as ``sqlstate`` - and
    :func:`~app.services.health_service.readiness_failure_fields` reads both the wrapped
    exception's class name and that attribute when it classifies a readiness failure. A purpose
    built double is used rather than a bare :class:`Exception` so those two reads are exercised
    rather than skipped, and so the attribute can be omitted on the shapes where a real driver
    would not have supplied one.
    """

    def __init__(self, message: str, sqlstate: str | None = None) -> None:
        """Build the double.

        Args:
            message: The driver's message. Always the marker-bearing text, because this is the
                string a real driver fills with the host, the port, the database and the user.
            sqlstate: The five-character condition code, when the shape being simulated is one a
                driver would have published one for. ``None`` leaves the attribute unset in
                effect, exactly as a driver that publishes no code does.
        """
        super().__init__(message)
        self.sqlstate = sqlstate


def build_pool_timeout() -> PoolTimeoutError:
    """Build the failure an exhausted connection pool produces.

    Classified ``pool_timeout``, and the one shape that never reaches the database at all: no
    connection attempt is made, so it carries no wrapped driver exception and no SQLSTATE. Its
    remedy - capacity, or a session that is not being released - has nothing to do with
    reachability, which is why the route checks it before anything else.

    Returns:
        The exception, carrying every disclosure marker in its message.
    """
    return PoolTimeoutError(_FAILURE_MESSAGE)


def build_query_timeout() -> TimeoutError:
    """Build the failure this route's own deadline produces.

    Classified ``query_timeout``, and the shape a database that accepted the connection and then
    answered nothing arrives as: ``asyncio.timeout`` raises the builtin :class:`TimeoutError` at
    :data:`~app.api.v1.routers.health.READINESS_TIMEOUT_SECONDS`, cancelling the statement in
    flight.

    A builtin rather than a SQLAlchemy exception on purpose - that is genuinely what the deadline
    raises - and it matters twice over. It is an :class:`OSError` subclass, so the route's narrowed
    ``except`` catches it without ``Exception`` being caught; and it is the one shape that makes the
    route invalidate the connection instead of returning it to the pool, which
    :class:`TestReadinessDeadline` asserts separately.

    Returns:
        The exception, carrying every disclosure marker in its message so the parametrised
        document test holds for this branch too.
    """
    return TimeoutError(_FAILURE_MESSAGE)


def build_connection_failure() -> OperationalError:
    """Build the failure SQLAlchemy raises when the connection itself cannot be made.

    Classified ``connection_failure``, and the shape a refused connection, an unresolvable host
    and a rejected password all arrive as in production - which makes it the single most likely
    real cause of a 503 from this route.

    The statement and parameters are supplied positionally because that is
    :class:`~sqlalchemy.exc.DBAPIError`'s constructor - ``(statement, params, orig)`` - and both
    end up in ``str(exc)`` along with the wrapped message, which is precisely the text this suite
    then proves never reaches the response.

    Returns:
        The exception, wrapping a driver double that carries a marker-bearing message and a
        SQLSTATE.
    """
    return OperationalError(
        READINESS_STATEMENT,
        {},
        DriverFailureError(_FAILURE_MESSAGE, SQLSTATE_INVALID_PASSWORD),
    )


def build_driver_interface_failure() -> InterfaceError:
    """Build the failure raised when the driver connection is unusable rather than unreachable.

    Classified ``driver_interface_failure``. A socket closed underneath a live connection, or a
    client library in a state it cannot recover from, produces this rather than an operational
    error - a distinction an operator acts on differently, and one the wire must not expose.

    Returns:
        The exception, wrapping a driver double with no SQLSTATE, as this class of failure
        usually arrives without one.
    """
    return InterfaceError(READINESS_STATEMENT, {}, DriverFailureError(_FAILURE_MESSAGE))


def build_database_error() -> DBAPIError:
    """Build a driver-level failure that is none of the more specific classes.

    Classified ``database_error`` - the route's catch-all for a
    :class:`~sqlalchemy.exc.DBAPIError` it can say nothing more precise about. Constructed as the
    base class deliberately: a subclass would be caught by an earlier branch, and this is the
    branch under test.

    Returns:
        The exception, wrapping a driver double that carries a SQLSTATE.
    """
    return DBAPIError(
        READINESS_STATEMENT,
        {},
        DriverFailureError(_FAILURE_MESSAGE, SQLSTATE_TOO_MANY_CONNECTIONS),
    )


def build_unexpected_failure() -> OSError:
    """Build a failure the route has no classification for.

    Classified ``unexpected_failure``. An :class:`OSError` is not a SQLAlchemy exception at all,
    and that is exactly why it is included: the 503 contract has to hold for a failure the route
    has never heard of, not only for the four it enumerates. It is also the shape
    ``backend/tests/conftest.py``'s own session double raises, so this parametrised case and
    :func:`unavailable_database` exercise the same path from two directions.

    Returns:
        The exception, carrying every disclosure marker in its message.
    """
    return OSError(_FAILURE_MESSAGE)


FAILURE_BUILDERS: Final[tuple[Callable[[], Exception], ...]] = (
    build_pool_timeout,
    build_query_timeout,
    build_connection_failure,
    build_driver_interface_failure,
    build_database_error,
    build_unexpected_failure,
)
"""One builder per classification ``app.services.health_service`` publishes, in the order it
tests them.

Six, and the set is exhaustive rather than illustrative: it is exactly the
``ReadinessFailureClass`` vocabulary the route declares, so a classification added there without a
case added here leaves a branch of the failure path unexercised. Every builder plants the *same*
message, so the only thing varying between parametrised cases is the exception class - which is
the variable under test. Parametrising over all six is what turns "the document is fixed" from a
claim about one code path into a claim about the contract.

One classification is reachable two ways and appears once here: ``query_timeout`` is produced by
this route's own deadline *and* by the server cancelling under ``app.db.session``'s
``statement_timeout``. The builder covers the first;
:meth:`TestReadinessFailureClassification.test_a_server_side_cancellation_is_a_query_timeout`
covers the second, because the two arrive as different exception classes and only one of them is
a deadline.
"""

FAILURE_BUILDER_IDS: Final[tuple[str, ...]] = (
    "pool_timeout",
    "query_timeout",
    "connection_failure",
    "driver_interface_failure",
    "database_error",
    "unexpected_failure",
)
"""The classification each builder is expected to be filed under.

Used as parametrisation identifiers so a failing case names the branch it exercised rather than a
positional index, and so the test report reads as a checklist against the route's own vocabulary.
"""


# ---------------------------------------------------------------------------------------
# Substituted session providers
#
# `backend/tests/conftest.py`'s `override_get_db` installer is the only mechanism used to put
# these in place, and it restores the previous entry in its teardown. Nothing here mutates
# `app.dependency_overrides` directly and nothing clears it.
# ---------------------------------------------------------------------------------------

SessionProviderInstaller = Callable[[Callable[..., Any]], None]
"""Type of the installer :func:`override_get_db` yields.

It takes the replacement provider - normally an async generator function yielding a session -
and installs it under ``get_db``. Spelled as an alias so the three tests that request the
fixture annotate it identically and read as consuming one documented seam.
"""


class UnreachableDatabaseSession:
    """Session-shaped double whose every statement raises the failure it was built with.

    Deliberately not a real session pointed at a dead host. That would work but would wait out
    a connect timeout on every call, making the outcome depend on network behaviour; this fails
    instantly and identically everywhere.

    The failure happens at :meth:`execute` and nowhere earlier, which is what makes the 503
    reachable: the readiness service wraps only the one repository call in a ``try``, so an
    object that failed while being yielded would fail during dependency resolution and be
    reported as a 500 instead.

    ``close`` and ``rollback`` are present and inert because a caller unwinding from the failure
    may reasonably invoke either. ``invalidate`` is present for a sharper reason: the route
    invalidates the connection on its deadline path, so a double without the method would turn that
    503 into a 500 through an ``AttributeError`` - and it records the call, which is how
    :class:`TestReadinessDeadline` asserts the discard happened at all.
    """

    def __init__(self, failure: Exception) -> None:
        """Store the exception every statement will raise.

        Args:
            failure: The exception to raise. Built fresh per test by one of
                :data:`FAILURE_BUILDERS`, so no exception instance is ever raised twice.
        """
        self._failure = failure
        self.invalidated = False

    async def execute(self, *args: Any, **kwargs: Any) -> NoReturn:
        """Raise instead of executing, whatever statement was passed.

        Args:
            *args: Ignored - the statement never runs.
            **kwargs: Ignored, for the same reason.

        Raises:
            Exception: Always, and always the instance this double was built with.
        """
        del args, kwargs
        raise self._failure

    async def close(self) -> None:
        """Accept a close, having nothing to close."""

    async def rollback(self) -> None:
        """Accept a rollback, having nothing to roll back."""

    async def invalidate(self) -> None:
        """Record that the connection was discarded rather than returned to the pool."""
        self.invalidated = True


class SilentDatabaseSession:
    """Session-shaped double whose statement never completes, standing in for a silent peer.

    The failure mode ``READINESS_TIMEOUT_SECONDS`` exists for, and the one no exception can
    simulate: the database accepted the connection and then stopped answering, so nothing is raised
    and nothing returns. Before the deadline, a request to ``/readyz`` waited on this for as long as
    the kernel's keepalive budget allowed - roughly twenty-five seconds under
    ``app.db.session``'s settings - which is long past the point an orchestrator has given up and
    long past the point the classified failure record would still have been useful.

    The sleep is deliberately far longer than any deadline a test sets, so a test that passes can
    only have passed because the deadline fired. Cancellation is what ends it: ``asyncio.timeout``
    cancels the awaited operation, and :meth:`execute` therefore never runs to completion in any
    test in this module.
    """

    def __init__(self, seconds: float = _SILENCE_SECONDS) -> None:
        """Store how long a statement will appear to hang for.

        Args:
            seconds: Duration of the sleep. Defaults to :data:`_SILENCE_SECONDS`, which is orders
                of magnitude above the deadlines these tests set.
        """
        self._seconds = seconds
        self.invalidated = False

    async def execute(self, *args: Any, **kwargs: Any) -> NoReturn:
        """Sleep past any deadline instead of executing.

        Args:
            *args: Ignored - the statement never runs.
            **kwargs: Ignored, for the same reason.

        Raises:
            AssertionError: If the sleep ever completes, which means no deadline cancelled it.
        """
        del args, kwargs
        await asyncio.sleep(self._seconds)
        raise AssertionError(
            f"the substituted statement slept {self._seconds}s to completion, so no deadline "
            f"cancelled it"
        )

    async def close(self) -> None:
        """Accept a close, having nothing to close."""

    async def rollback(self) -> None:
        """Accept a rollback, having nothing to roll back."""

    async def invalidate(self) -> None:
        """Record that the connection was discarded rather than returned to the pool."""
        self.invalidated = True


class UninvalidatableDatabaseSession(SilentDatabaseSession):
    """A silent session whose connection cannot even be discarded.

    The pathological corner of the deadline path: the statement is cancelled, the route tries to
    invalidate the connection so a broken one is not pooled, and *that* fails too - which is
    entirely possible, because a connection whose socket has already gone will refuse to close
    cleanly. The route guards the invalidation for exactly this reason, and this double is how the
    guard is exercised: without it, a failure to discard would turn a correct 503 into a 500 and an
    orchestrator would restart a process whose only problem was an unreachable database.
    """

    async def invalidate(self) -> NoReturn:
        """Fail the discard the way a connection with a dead socket does.

        Raises:
            OperationalError: Always. A SQLAlchemy error rather than an arbitrary one, because that
                is what the route's ``suppress`` names and what a real failed discard raises.
        """
        raise OperationalError(READINESS_STATEMENT, {}, DriverFailureError(_FAILURE_MESSAGE))


class DefectiveDatabaseSession:
    """Session-shaped double that raises a programming defect rather than a database failure.

    The subject of the narrowed ``except``. An :class:`AttributeError` is what a refactor produces -
    a renamed method, a mistyped attribute - and it is emphatically not a database outage. Answering
    503 for it reported a defect in this service as an infrastructure problem, wrote no traceback,
    kept it out of 5xx alerting and had an orchestrator withdraw traffic from an instance that was
    working. It must reach the handler of last resort instead.
    """

    def __init__(self, message: str = _DEFECT_MESSAGE) -> None:
        """Store the defect's message.

        Args:
            message: Text of the raised :class:`AttributeError`. Distinctive by default, so the
                logged frames can be searched for it.
        """
        self._message = message

    async def execute(self, *args: Any, **kwargs: Any) -> NoReturn:
        """Raise a defect instead of executing.

        Args:
            *args: Ignored - the statement never runs.
            **kwargs: Ignored, for the same reason.

        Raises:
            AttributeError: Always.
        """
        del args, kwargs
        raise AttributeError(self._message)

    async def close(self) -> None:
        """Accept a close, having nothing to close."""

    async def rollback(self) -> None:
        """Accept a rollback, having nothing to roll back."""


class SessionProviderResolvedError(AssertionError):
    """Raised when a route that must resolve no session provider resolves one anyway.

    An :class:`AssertionError` rather than a plain exception so that, if it is ever raised
    outside a request, it reads as the test failure it is. Inside a request it never surfaces as
    itself - the handler of last resort would render it as a 500 - which is exactly the signal
    :meth:`TestLiveness.test_healthz_answers_without_resolving_a_session_provider` detects.
    """


async def refuse_to_provide_a_session() -> NoReturn:
    """Stand in for ``get_db`` and fail the instant anything resolves it.

    A plain coroutine function rather than an async generator, so there is no unreachable
    ``yield`` after the raise. FastAPI awaits a non-generator dependency during resolution, so
    installing this makes *resolution itself* the failure - which is the sharpest available test
    of liveness independence. ``GET /healthz`` declares no parameters, so this is never awaited
    and the route answers 200; a liveness handler that acquired a session would answer 500.

    Raises:
        SessionProviderResolvedError: Always, if it is ever called at all.
    """
    raise SessionProviderResolvedError(
        f"{LIVENESS_PATH} resolved the request-scoped session provider; liveness must not."
    )


# ---------------------------------------------------------------------------------------
# The log sink
#
# Two of this module's claims are invisible on the wire, so they are read off the one place they
# exist: the classification a readiness failure is filed under, and the traceback a defect escaping
# to the handler of last resort carries. Both are asserted through the service's own configured
# handler rather than by patching a logger, so what a test reads is exactly the bytes a collector
# would have received.
# ---------------------------------------------------------------------------------------


@pytest.fixture
def captured_log_stream() -> Iterator[io.StringIO]:
    """Point the service's single log handler at a buffer, and put it back afterwards.

    ``configure_logging`` replaces the root handler rather than adding one, so this leaves exactly
    one handler writing to the buffer and exactly one line per record - and calling it again with no
    argument in the teardown restores the process configuration whether the test passed, failed or
    was interrupted.

    Nothing about the settings object is touched. The suite runs as ``ENVIRONMENT=test``, which
    selects the JSON chain, so the buffer receives one parsable object per line; and at
    ``LOG_LEVEL=WARNING``, which is below the ``error`` both records under test are written at.

    Yields:
        The buffer, holding exactly the bytes a log collector would have received.
    """
    buffer = io.StringIO()
    configure_logging(stream=buffer)
    try:
        yield buffer
    finally:
        configure_logging()


def records_named(stream: io.StringIO, event: str) -> list[dict[str, Any]]:
    """Return every captured record whose ``event`` is *event*, in the order written.

    Args:
        stream: The buffer :func:`captured_log_stream` filled.
        event: Event name to select on.

    Returns:
        The matching records, parsed. Empty when none was written, which every caller asserts
        against rather than indexing blindly.
    """
    parsed = [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]
    return [record for record in parsed if record.get("event") == event]


# ---------------------------------------------------------------------------------------
# Assertion helpers
#
# They exist so that every response in this module is held to the SAME checks. A test that
# asserted only a status code would pass against a route that returned the right number and the
# wrong document, and the checks that catch that - the exact key set, the media type, the
# agreement between the document's own status and the HTTP status, the agreement between the
# document's `request_id` and the header - are each easy to forget once per test and hard to
# forget when there is one place they are written.
# ---------------------------------------------------------------------------------------


def media_type_of(response: Response) -> str:
    """Return *response*'s media type with any parameters stripped.

    ``Content-Type`` may legitimately carry a charset or another parameter, so the header is not
    compared whole: a future response class that appended ``; charset=utf-8`` would otherwise
    fail an assertion about the media type without the media type having changed.

    Args:
        response: The response to read. A missing header yields ``""``, which no expected value
            matches, so an absent ``Content-Type`` fails rather than passing vacuously.

    Returns:
        The media type, lower-cased by the server and stripped of surrounding whitespace.
    """
    # `str(...)` because httpx annotates `Headers.get` as returning `Any`, so without it the
    # declared `str` here would be a claim nothing checks - and this helper's whole job is to hand
    # every caller a value they can compare as a string.
    return str(response.headers.get("content-type", "")).split(";")[0].strip()


def assert_success_document(response: Response, expected_body: dict[str, object]) -> None:
    """Assert *response* is a 200 carrying exactly *expected_body* as JSON.

    Equality rather than containment, deliberately: a probe body that grew a version string, a
    hostname or an environment name would still satisfy a subset check, and both response models
    document that minimalism as a security property rather than a stylistic one.

    The correlation header is asserted present because it is the value an operator moves from a
    caller's report to the log line for the same request, and ``app.middleware.request_context``
    sets it on **every** response - including the two the access log deliberately keeps quiet.

    Args:
        response: The response to check.
        expected_body: The complete document the route may return.
    """
    assert response.status_code == HTTPStatus.OK
    assert media_type_of(response) == JSON_MEDIA_TYPE
    assert response.json() == expected_body
    assert response.headers.get(REQUEST_ID_HEADER)


def assert_problem_document(
    response: Response,
    *,
    status: HTTPStatus,
    error_type: str,
    title: str,
    instance: str,
    detail: str,
) -> dict[str, Any]:
    """Assert *response* is the uniform problem document at *status*, and return its body.

    Six checks, each of which is a contract rather than a formality:

    1. the HTTP status is the expected one;
    2. the media type is ``application/problem+json``, so a failure is distinguishable from a
       success by content negotiation alone;
    3. the key set is **exactly** :data:`PROBLEM_KEYS` - no field missing, and none added;
    4. ``type``, ``title`` and ``detail`` are the stable strings published for this failure,
       which is what lets a client branch on ``type`` instead of parsing prose;
    5. the document's own ``status`` equals the HTTP status. ``app.core.exceptions`` builds the
       body as a plain dictionary from the same argument it sets the response status from, so
       the two agree by construction and nothing downstream re-checks them - which is exactly
       the kind of agreement that drifts unnoticed;
    6. ``request_id`` is non-empty and equals the :data:`REQUEST_ID_HEADER` value, so a support
       request quoting the body and a log query filtering on the header cannot land on
       different requests.

    Args:
        response: The response to check.
        status: Expected HTTP status, and expected value of the document's ``status`` member.
        error_type: Expected ``type``.
        title: Expected ``title``.
        instance: Expected ``instance`` - the request path, without any query string.
        detail: Expected ``detail``. Every failure asserted here publishes a fixed sentence, so
            this is an equality; there is no variant of these paths that composes one.

    Returns:
        The parsed document, so a caller can make further assertions without re-reading it.
    """
    assert response.status_code == status
    assert media_type_of(response) == PROBLEM_MEDIA_TYPE

    body: dict[str, Any] = response.json()
    assert set(body) == PROBLEM_KEYS
    assert body["type"] == error_type
    assert body["title"] == title
    assert body["detail"] == detail
    assert body["instance"] == instance
    assert body["status"] == status
    assert body["request_id"]
    assert body["request_id"] == response.headers.get(REQUEST_ID_HEADER)
    return body


def assert_readiness_failure(response: Response) -> dict[str, Any]:
    """Assert *response* is the 503 readiness failure document, and return its body.

    The one failure this module asserts more than once, so its five expected values are named in
    a single place: a change to any of them should require one edit and break every test that
    depends on it, rather than being papered over in one call site and missed in another.

    Args:
        response: The response to a ``GET /readyz`` made while the database was unreachable.

    Returns:
        The parsed document.
    """
    return assert_problem_document(
        response,
        status=HTTPStatus.SERVICE_UNAVAILABLE,
        error_type=SERVICE_UNAVAILABLE_TYPE,
        title=SERVICE_UNAVAILABLE_TITLE,
        instance=READINESS_PATH,
        detail=SERVICE_UNAVAILABLE_DETAIL,
    )


def assert_path_is_not_served(response: Response, path: str) -> None:
    """Assert *path* answered 404 as the uniform problem document rather than as itself.

    Both halves matter. The 404 is what bounds the unversioned exemption - a probe that also
    answered under ``/api/v1`` would make the exemption a loophole - and the document shape is
    what proves the single error contract reaches a route that does not exist: Starlette's own
    default handler would have returned ``{"detail": "Not Found"}`` at ``application/json``, and
    ``app.core.exceptions`` registers a handler for ``HTTPException`` precisely so it does not.

    ``detail`` is the framework's status phrase here rather than a sentence this API composes,
    because nothing in the service raised the error: the router did, on finding no match.

    Args:
        response: The response to check.
        path: The requested path, which must be echoed back as ``instance``.
    """
    assert_problem_document(
        response,
        status=HTTPStatus.NOT_FOUND,
        error_type=NOT_FOUND_TYPE,
        title=NOT_FOUND_TITLE,
        instance=path,
        detail=NOT_FOUND_TITLE,
    )


class TestLiveness:
    """``GET /healthz`` - is this process running, and is that answer free of dependencies."""

    async def test_healthz_reports_the_process_is_alive(self, client: AsyncClient) -> None:
        """AAP §0.9.4.4 health separation: ``GET /healthz`` returns 200 with the liveness body."""
        assert_success_document(await client.get(LIVENESS_PATH), LIVENESS_BODY)

    async def test_healthz_answers_without_resolving_a_session_provider(
        self,
        client: AsyncClient,
        override_get_db: SessionProviderInstaller,
    ) -> None:
        """AAP §0.9.4.4: liveness returns 200 *without touching the database*."""
        # The sharpest form of the claim. This provider fails on RESOLUTION, not on a statement,
        # so a liveness handler that declared a session at all would fail before its body ran and
        # answer 500 through the handler of last resort. Answering 200 is therefore positive
        # evidence that `liveness` resolves no dependency - not merely that it issues no query.
        override_get_db(refuse_to_provide_a_session)

        # Restoration is `override_get_db`'s teardown, which runs even if this assertion fails.
        # Nothing is restored by hand here and `dependency_overrides` is never cleared, because
        # clearing would also discard the working override `client` installed for this test.
        assert_success_document(await client.get(LIVENESS_PATH), LIVENESS_BODY)

    async def test_healthz_is_not_served_under_the_version_prefix(
        self, client: AsyncClient
    ) -> None:
        """AAP §0.10.1 #5: liveness is exempt from ``/api/v1``, and the exemption is bounded."""
        assert_path_is_not_served(await client.get(PREFIXED_LIVENESS_PATH), PREFIXED_LIVENESS_PATH)


class TestReadiness:
    """``GET /readyz`` - can this process serve traffic, asked of the database every time."""

    async def test_readyz_reports_ready_while_the_database_is_reachable(
        self, client: AsyncClient
    ) -> None:
        """AAP §0.9.4.4 health separation: ``GET /readyz`` returns 200 while the database is up."""
        # Reachability is real here rather than simulated: `conftest.database_schema` has migrated
        # the test database to head and `conftest.client` injects a live session, so the route's
        # `SELECT 1` genuinely round-trips to PostgreSQL.
        assert_success_document(await client.get(READINESS_PATH), READINESS_BODY)

    async def test_readyz_is_not_served_under_the_version_prefix(self, client: AsyncClient) -> None:
        """AAP §0.10.1 #5: readiness is exempt from ``/api/v1``, and the exemption is bounded."""
        assert_path_is_not_served(
            await client.get(PREFIXED_READINESS_PATH), PREFIXED_READINESS_PATH
        )


class TestHealthSeparation:
    """The two probes diverging under one failure - the criterion neither route proves alone."""

    async def test_readyz_reports_unavailable_while_healthz_still_reports_alive(
        self, unavailable_database: AsyncClient
    ) -> None:
        """AAP §0.9.4.4: readiness fails when the database is unreachable, liveness does not."""
        # `conftest.unavailable_database` is the ready-made failure window: the same in-process
        # client, with a session provider whose every statement raises installed for the duration
        # of this test and restored by `override_get_db`'s teardown afterwards.
        assert_readiness_failure(await unavailable_database.get(READINESS_PATH))

        # The separation claim in full. Both requests run inside ONE failure window, so this is
        # not two independent observations of two routes - it is the single fact that an
        # orchestrator needs: withhold traffic from this instance, but do not restart it.
        assert_success_document(await unavailable_database.get(LIVENESS_PATH), LIVENESS_BODY)

    @pytest.mark.parametrize("build_failure", FAILURE_BUILDERS, ids=FAILURE_BUILDER_IDS)
    async def test_readyz_failure_is_fixed_and_discloses_no_topology(
        self,
        client: AsyncClient,
        override_get_db: SessionProviderInstaller,
        build_failure: Callable[[], Exception],
    ) -> None:
        """AAP §0.10.1 #4: one 503 document for every cause, disclosing no host or credential."""
        # Built once and closed over, rather than inside the provider, so its rendered text is
        # available below. That is what lets the marker search assert a precondition as well as a
        # conclusion, and a search that cannot fail proves nothing.
        failure = build_failure()

        async def unreachable_database() -> AsyncIterator[UnreachableDatabaseSession]:
            yield UnreachableDatabaseSession(failure)

        override_get_db(unreachable_database)
        response = await client.get(READINESS_PATH)

        # Asserted per parametrised case, so passing for every shape in `FAILURE_BUILDERS` is the
        # proof that the document is a property of the contract rather than of one code path: the
        # route files these failures under distinct `ReadinessFailureClass` classifications in its
        # log record and must not distinguish them at all on the wire. The builders are asserted to
        # cover that vocabulary exhaustively by
        # `TestFailureVocabularyIsCoveredExhaustively`, so "every shape" means every shape the
        # service can publish rather than every shape somebody remembered to list.
        assert_readiness_failure(response)

        # The security half. The substituted failure's message names a host, a port, a database
        # and a user - exactly what a real driver reports - and none of it may reach an
        # unauthenticated caller. Headers are searched as well as the body, because a value that
        # leaked into a header would have leaked just as far.
        rendered = response.text + "".join(
            f"{name}: {value}" for name, value in response.headers.items()
        )
        failure_text = str(failure)
        for marker in DISCLOSURE_MARKERS:
            # Precondition, asserted per marker so this test cannot silently become a tautology:
            # if a future edit stopped planting a marker in the failure, its absence from the
            # response would be guaranteed for the wrong reason and the guarantee under test
            # would go unexercised.
            assert marker in failure_text, (
                f"{marker!r} is no longer planted in the substituted failure, so its absence "
                f"from the response proves nothing:\n{failure_text}"
            )
            assert marker not in rendered, (
                f"{marker!r} reached the readiness failure response:\n{rendered}"
            )

    async def test_readyz_recovers_once_the_session_provider_is_restored(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        override_get_db: SessionProviderInstaller,
    ) -> None:
        """AAP §0.9.4.4: readiness is decided per request, so recovery needs no restart."""

        async def unreachable_database() -> AsyncIterator[UnreachableDatabaseSession]:
            yield UnreachableDatabaseSession(build_unexpected_failure())

        async def reachable_database() -> AsyncIterator[AsyncSession]:
            yield db_session

        override_get_db(unreachable_database)
        try:
            assert_readiness_failure(await client.get(READINESS_PATH))
        finally:
            # Restored HERE, in a `finally`, rather than left to fixture teardown, because the
            # assertions below are the point of this test: they prove the restoration took
            # effect. `override_get_db` is called again rather than `dependency_overrides` being
            # mutated or cleared, so the entry that was present before this test still gets put
            # back exactly by the fixture's own teardown.
            override_get_db(reachable_database)

        # Nothing is latched and nothing is cached: the next request re-asks the question and
        # gets the new answer. This is also what protects every test that runs after this one -
        # a restoration that had silently failed would show up right here rather than as an
        # unrelated failure later in the session.
        assert_success_document(await client.get(READINESS_PATH), READINESS_BODY)

        # And liveness, which was never affected in either direction, still answers.
        assert_success_document(await client.get(LIVENESS_PATH), LIVENESS_BODY)


class TestReadinessDeadline:
    """``/readyz`` answers inside a bounded window even when the database answers not at all.

    The failure mode no exception simulates. A refused connection fails in milliseconds and was
    always reported correctly; a statement that does not come back raises nothing and returns
    nothing, and before this deadline existed the request had no bound of its own at all - the
    server-side ceiling ends the statement at ten seconds and the keepalive budget ends an
    unreachable host at about twenty-five, both of them well past the point an orchestrator times a
    readiness probe out in single digits. Every one of those requests was abandoned by its caller
    before it answered, and the classified failure record the route writes beside the 503 was never
    written at all: the reason for the outage was lost precisely when it was needed.

    The deadline these tests exercise is the route's own promise about its worst case, so it is
    asserted as one: the answer arrives, it is the ordinary 503 document, and the connection the
    cancelled statement left in an indeterminate state is discarded rather than pooled.
    """

    def _silence(
        self,
        override_get_db: SessionProviderInstaller,
        monkeypatch: pytest.MonkeyPatch,
        session: SilentDatabaseSession,
    ) -> None:
        """Install *session* under ``get_db`` and shorten the route's deadline for one test.

        The deadline is substituted rather than waited out. ``READINESS_TIMEOUT_SECONDS`` is a
        public module constant read at call time by
        :meth:`~app.services.health_service.HealthService.readiness`, so patching it *there*
        changes the bound this request is held to and nothing else, and ``monkeypatch`` restores it
        however the test ends. It is patched on the service rather than on
        ``app.api.v1.routers.health``, which only re-exports the name for callers that read it:
        the router owns the response, the service owns the deadline, and a patch has to reach the
        module that applies the value. Waiting the real five seconds would prove the same thing
        five seconds more slowly, per case, in a gate that has to stay fast enough to block a
        merge.

        Args:
            override_get_db: The installer from ``backend/tests/conftest.py``, which restores the
                previous provider in its own teardown.
            monkeypatch: pytest's patcher, so the constant is put back automatically.
            session: The silent double to serve this request with.
        """

        async def silent_database() -> AsyncIterator[SilentDatabaseSession]:
            yield session

        monkeypatch.setattr(health_service, "READINESS_TIMEOUT_SECONDS", _TEST_DEADLINE_SECONDS)
        override_get_db(silent_database)

    async def test_readyz_answers_503_when_the_database_never_answers(
        self,
        client: AsyncClient,
        override_get_db: SessionProviderInstaller,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """AAP §0.9.4.4: a silent database is an unready instance, and it is one *promptly*."""
        session = SilentDatabaseSession()
        self._silence(override_get_db, monkeypatch, session)

        started = perf_counter()
        response = await client.get(READINESS_PATH)
        elapsed = perf_counter() - started

        # The document first: a deadline must produce the SAME 503 as every other cause, or the
        # wire would start distinguishing failures the contract says are indistinguishable.
        assert_readiness_failure(response)

        # Then the bound, which is the whole point of the finding this closes. The substituted
        # statement sleeps for `_SILENCE_SECONDS`, so an answer inside this ceiling can only mean
        # the deadline cancelled it - and the ceiling is below the production deadline too, so this
        # assertion also fails if the substitution above ever stops taking effect.
        assert elapsed < _ELAPSED_CEILING_SECONDS, (
            f"{READINESS_PATH} took {elapsed:.3f}s against a database that never answers; the "
            f"deadline did not bind"
        )

    async def test_readyz_discards_the_connection_its_deadline_cancelled(
        self,
        client: AsyncClient,
        override_get_db: SessionProviderInstaller,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A cancelled statement leaves a connection nobody else may be given."""
        session = SilentDatabaseSession()
        self._silence(override_get_db, monkeypatch, session)

        assert_readiness_failure(await client.get(READINESS_PATH))

        # Cancelling mid-statement leaves the connection's protocol state indeterminate: the
        # server may still be writing a result nobody will read. Returning it to the pool would
        # hand the next caller a connection that fails on a statement of its own, turning one
        # readiness timeout into a cascade of unrelated 500s. Invalidation discards it instead and
        # the pool opens a fresh one on the next checkout.
        assert session.invalidated, "the cancelled connection was returned to the pool"

    async def test_readyz_still_answers_503_when_the_discard_itself_fails(
        self,
        client: AsyncClient,
        override_get_db: SessionProviderInstaller,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The clean-up may not change the verdict it is cleaning up after."""
        # A connection whose socket has already gone can refuse to close, so the invalidation is
        # guarded. Unguarded, this exact sequence - deadline, failed discard - would have answered
        # 500 and had an orchestrator restart a healthy process because a *database* was silent.
        self._silence(override_get_db, monkeypatch, UninvalidatableDatabaseSession())

        assert_readiness_failure(await client.get(READINESS_PATH))

    def test_the_deadline_sits_below_every_lower_layer_bound(self) -> None:
        """The route's promise is only a promise if it is the first bound to fire."""
        deadline = health.READINESS_TIMEOUT_SECONDS
        assert deadline > 0

        # Below the server-side ceiling, or PostgreSQL would cancel the statement first and this
        # route's own bound would be decoration.
        assert deadline <= STATEMENT_TIMEOUT_SECONDS

        # And below the kernel's worst case for a connection whose peer went silent, which is the
        # bound that used to govern this route: idle time plus every probe interval. A deadline at
        # or above that number would answer no sooner than doing nothing did.
        keepalive_worst_case = int(TCP_KEEPALIVE_ARGS["keepalives_idle"]) + int(
            TCP_KEEPALIVE_ARGS["keepalives_interval"]
        ) * int(TCP_KEEPALIVE_ARGS["keepalives_count"])
        assert deadline < keepalive_worst_case


class TestFailureVocabularyIsCoveredExhaustively:
    """The parametrised failure set is the route's whole vocabulary, asserted rather than counted.

    :data:`FAILURE_BUILDERS` claims to be "exactly the ``ReadinessFailureClass`` vocabulary the
    route declares", and every uniformity assertion in this module rests on that claim: a
    classification the service can publish but this file does not build is a branch of the failure
    path that no test reaches, and nothing else here would notice.

    The claim used to be defended by prose and by a number written into a comment - which is how
    the comment came to say *five* while the service published *six*. A stated count is a second
    declaration of a set that already exists in code, so it is replaced by the relationship: one
    assertion, over the two things that must agree.
    """

    def test_every_published_classification_has_a_builder(self) -> None:
        """A classification with no builder is an unexercised failure branch."""
        published = set(get_args(health_service.ReadinessFailureClass))
        covered = set(FAILURE_BUILDER_IDS)

        assert published == covered, (
            "FAILURE_BUILDERS and ReadinessFailureClass disagree; missing builders for "
            f"{sorted(published - covered)}, builders for classifications the service does not "
            f"publish: {sorted(covered - published)}"
        )

    def test_each_builder_is_paired_with_the_identifier_it_is_filed_under(self) -> None:
        """The two tuples are read positionally by ``parametrize``, so their lengths must match.

        ``ids=`` is applied by position, so a builder added without its identifier - or the reverse
        - would silently mislabel every case after it, and a failing test would then name the wrong
        branch. That is worse than an unlabelled failure: it sends a reader to the wrong code.
        """
        assert len(FAILURE_BUILDERS) == len(FAILURE_BUILDER_IDS)
        assert len(set(FAILURE_BUILDER_IDS)) == len(FAILURE_BUILDER_IDS)


class TestReadinessFailureClassification:
    """The one field that says *why*, read off the record the route writes beside its 503.

    The wire is deliberately uniform - every cause produces the same document, and every other
    test here asserts that - so the classification is the only place a readiness failure's reason
    survives at all. Two members of the vocabulary are worth asserting directly because they are
    reachable through the same exception class and are told apart by nothing but a condition code:
    a connection that failed and a statement the server killed have different remedies, and filing
    one as the other sends an operator to the wrong system.
    """

    def _classification_of(self, stream: io.StringIO) -> dict[str, Any]:
        """Return the single classified failure record the last request wrote.

        Args:
            stream: The buffer :func:`captured_log_stream` filled.

        Returns:
            The record. Asserted to exist, and asserted to be the only one, because "exactly one
            line is logged here" is itself part of this route's documented behaviour - a second
            record would mean a caught failure was logged twice.
        """
        records = records_named(stream, READINESS_FAILURE_EVENT)
        assert len(records) == 1, (
            f"expected exactly one {READINESS_FAILURE_EVENT!r} record, got "
            f"{len(records)}:\n{stream.getvalue()}"
        )
        return records[0]

    async def test_a_deadline_is_a_query_timeout(
        self,
        client: AsyncClient,
        override_get_db: SessionProviderInstaller,
        monkeypatch: pytest.MonkeyPatch,
        captured_log_stream: io.StringIO,
    ) -> None:
        """The route's own deadline is reported as a deadline, not as an unknown failure."""

        async def silent_database() -> AsyncIterator[SilentDatabaseSession]:
            yield SilentDatabaseSession()

        monkeypatch.setattr(health_service, "READINESS_TIMEOUT_SECONDS", _TEST_DEADLINE_SECONDS)
        override_get_db(silent_database)

        assert_readiness_failure(await client.get(READINESS_PATH))

        record = self._classification_of(captured_log_stream)
        assert record[LOG_FIELD_FAILURE_CLASS] == "query_timeout"
        # The builtin, which `asyncio.timeout` raises and which is an `OSError` subclass - the
        # reason the route's narrowed `except` catches it without catching `Exception`.
        assert record["exception_type"] == "TimeoutError"

    async def test_a_server_side_cancellation_is_a_query_timeout(
        self,
        client: AsyncClient,
        override_get_db: SessionProviderInstaller,
        captured_log_stream: io.StringIO,
    ) -> None:
        """``57014`` is a killed statement, and must not be filed as a failed connection."""
        # The second route to `query_timeout`, and the one a real deployment hits: the statement
        # exceeded `app.db.session`'s server-side `statement_timeout`, so PostgreSQL cancelled it
        # and psycopg reported `query_canceled`. SQLAlchemy wraps that in an `OperationalError` -
        # the same class a refused connection arrives as - so without the condition code the two
        # are indistinguishable, and an operator would go looking at a connection that was fine.
        failure = OperationalError(
            READINESS_STATEMENT,
            {},
            DriverFailureError(_FAILURE_MESSAGE, SQLSTATE_QUERY_CANCELED),
        )

        async def cancelled_database() -> AsyncIterator[UnreachableDatabaseSession]:
            yield UnreachableDatabaseSession(failure)

        override_get_db(cancelled_database)

        assert_readiness_failure(await client.get(READINESS_PATH))

        record = self._classification_of(captured_log_stream)
        assert record[LOG_FIELD_FAILURE_CLASS] == "query_timeout"
        assert record[LOG_FIELD_SQLSTATE] == SQLSTATE_QUERY_CANCELED

    async def test_a_refused_connection_is_still_a_connection_failure(
        self,
        client: AsyncClient,
        override_get_db: SessionProviderInstaller,
        captured_log_stream: io.StringIO,
    ) -> None:
        """The guard on the branch above: an ``OperationalError`` is not timed out by default."""
        # Same exception class as the previous test, different condition code, and the
        # classification must differ accordingly. Written as its own case because the two branches
        # are ordered - the code is checked before the class - and an ordering mistake would make
        # every operational failure look like a timeout, which is exactly as unhelpful as the
        # reverse.

        async def refused_database() -> AsyncIterator[UnreachableDatabaseSession]:
            yield UnreachableDatabaseSession(build_connection_failure())

        override_get_db(refused_database)

        assert_readiness_failure(await client.get(READINESS_PATH))

        record = self._classification_of(captured_log_stream)
        assert record[LOG_FIELD_FAILURE_CLASS] == "connection_failure"
        assert record[LOG_FIELD_SQLSTATE] == SQLSTATE_INVALID_PASSWORD

    async def test_the_failure_record_carries_no_driver_text(
        self,
        client: AsyncClient,
        override_get_db: SessionProviderInstaller,
        captured_log_stream: io.StringIO,
    ) -> None:
        """Not on the wire and not in the log either: this record is built from types alone."""
        # The response is proven clean for every failure shape elsewhere in this module. The log is
        # the other sink, and it is where a driver's message would most plausibly be tolerated -
        # an operator reading it is authorised. It is still withheld here, because the record is
        # assembled from the exception's class, the wrapped driver's class and the condition code,
        # and never from a message: a fixed field set cannot leak a credential the way a formatted
        # string can. Where the cause legitimately does survive, redacted, is the 500 path, which
        # `TestReadinessDefects` asserts.
        failure = build_connection_failure()

        async def refused_database() -> AsyncIterator[UnreachableDatabaseSession]:
            yield UnreachableDatabaseSession(failure)

        override_get_db(refused_database)
        assert_readiness_failure(await client.get(READINESS_PATH))

        record = self._classification_of(captured_log_stream)
        rendered = json.dumps(record)
        failure_text = str(failure)
        for marker in DISCLOSURE_MARKERS:
            assert marker in failure_text, (
                f"{marker!r} is no longer planted in the substituted failure, so its absence "
                f"from the record proves nothing:\n{failure_text}"
            )
            assert marker not in rendered, f"{marker!r} reached the failure record:\n{rendered}"

        # No frames either: the route logs with `error` rather than `exception` precisely so a
        # traceback - which would carry the driver's text in a frame - is not attached.
        assert "exception" not in record


class TestReadinessDefects:
    """A defect in this service is a 500 with frames, not a 503 with a classification.

    The distinction the narrowed ``except`` exists to make. ``SQLAlchemyError`` and ``OSError``
    describe the database and the transport to it; an :class:`AttributeError` from a refactor
    describes this file. Catching both alike answered 503 for a working instance, wrote a bounded
    record with no traceback, kept the failure out of 5xx alerting and had an orchestrator withdraw
    traffic it should have kept sending - four consequences of one over-broad clause.
    """

    async def test_a_defect_in_the_route_is_a_500_not_a_503(
        self,
        client: AsyncClient,
        override_get_db: SessionProviderInstaller,
    ) -> None:
        """AAP §0.10.1 #4: the status names the provenance, and this one is the server's."""

        async def defective_database() -> AsyncIterator[DefectiveDatabaseSession]:
            yield DefectiveDatabaseSession()

        override_get_db(defective_database)
        response = await client.get(READINESS_PATH)

        # The uniform problem document, at 500 rather than 503: same shape, same media type, same
        # correlation, different status and different published type. A caller branching on `type`
        # can therefore tell "this instance cannot reach its database" from "this instance is
        # broken", which is the difference between waiting and paging somebody.
        assert_problem_document(
            response,
            status=HTTPStatus.INTERNAL_SERVER_ERROR,
            error_type=INTERNAL_TYPE,
            title=INTERNAL_TITLE,
            instance=READINESS_PATH,
            detail=INTERNAL_DETAIL,
        )

    async def test_a_defect_is_logged_with_frames_and_not_as_a_readiness_failure(
        self,
        client: AsyncClient,
        override_get_db: SessionProviderInstaller,
        captured_log_stream: io.StringIO,
    ) -> None:
        """Answering 500 is half of it; the traceback is what makes the defect findable."""

        async def defective_database() -> AsyncIterator[DefectiveDatabaseSession]:
            yield DefectiveDatabaseSession()

        override_get_db(defective_database)
        response = await client.get(READINESS_PATH)
        assert response.status_code == HTTPStatus.INTERNAL_SERVER_ERROR

        rendered = captured_log_stream.getvalue()

        # Not classified as a readiness failure at all. A record here would mean the route had
        # caught the defect, and everything above about the status would be accidental.
        assert not records_named(captured_log_stream, READINESS_FAILURE_EVENT), (
            f"a defect was filed as a readiness failure:\n{rendered}"
        )

        unhandled = records_named(captured_log_stream, UNHANDLED_EVENT)
        assert unhandled, f"no {UNHANDLED_EVENT!r} record was written:\n{rendered}"

        record = unhandled[-1]
        assert record["exception_type"] == "AttributeError"
        assert record["status_code"] == int(HTTPStatus.INTERNAL_SERVER_ERROR)
        assert record["path"] == READINESS_PATH
        assert record["request_id"] == response.headers.get(REQUEST_ID_HEADER)

        # The frames themselves, and the defect's own text inside them. `exception` is the key
        # structlog's frame transformer writes, and it holds a list of structured frames rather
        # than a formatted string - so it is searched as rendered JSON, which is what a collector
        # receives. Its absence is precisely what made the old 503 unactionable.
        frames = record.get("exception")
        assert frames, f"the 500 was logged without frames:\n{rendered}"

        rendered_frames = json.dumps(frames)
        # The message points at what went wrong.
        assert _DEFECT_MESSAGE in rendered_frames, (
            f"the defect's message is not in the frames:\n{rendered_frames}"
        )
        # And the frames reach this route, which is what points at where. A traceback that stopped
        # at the framework would say a request failed and not which handler.
        assert "routers/health.py" in rendered_frames, (
            f"the frames do not reach the readiness handler:\n{rendered_frames}"
        )


class TestApiTierLayering:
    """The API tier composes no SQL, asserted from the source rather than from the wire.

    AAP §0.2.3 is unconditional: "Layered separation is mandatory. Route handlers contain no
    data-access logic. Handlers delegate to services, services delegate to repositories,
    repositories own queries." Readiness is where that rule was broken - the route issued
    ``SELECT 1`` itself and classified the driver's failure itself - and it is where the rule is
    least self-enforcing, because a probe's whole job is to touch the database and one statement
    always looks too small to be worth a layer.

    Nothing about the response can detect the difference, which is exactly why this class reads the
    modules instead. Two properties, checked over the whole package rather than only the file the
    finding named, because the argument for an exemption is not specific to readiness and neither
    is the guard against it.
    """

    @staticmethod
    def _api_tier_sources() -> dict[str, str]:
        """Read every module of the API tier.

        Returns:
            A mapping of dotted-ish module path to source text, covering the routers package, the
            versioned aggregate and the shared response declarations - which together are every
            file in the service that is allowed to speak HTTP.
        """
        api_root = Path(app.api.__file__).parent
        return {
            str(path.relative_to(api_root.parent)): path.read_text(encoding="utf-8")
            for path in sorted(api_root.rglob("*.py"))
        }

    def test_no_api_tier_module_imports_the_sql_toolkit(self) -> None:
        """A router cannot compose a statement if it cannot name one.

        The strongest available form of the layering rule, and the cheapest to keep true: an
        ``import`` is a structural fact rather than a style preference, so this fails the moment
        anybody reaches for ``select``, ``text`` or a session type in the API tier - before the
        statement it would have been used to build is ever written.

        ``sqlalchemy.ext.asyncio`` is caught by the same check, which is deliberate. A handler that
        annotated a parameter as an ``AsyncSession`` would be reaching past
        ``app.core.dependencies.DbSession``, the one alias the tier is meant to know the session
        by, and that alias is precisely what keeps the session opaque here.
        """
        offenders = {
            module: [
                line.strip()
                for line in source.splitlines()
                if line.startswith(("import sqlalchemy", "from sqlalchemy"))
            ]
            for module, source in self._api_tier_sources().items()
        }
        assert {module: lines for module, lines in offenders.items() if lines} == {}

    def test_no_api_tier_module_executes_a_statement(self) -> None:
        """No handler calls ``execute`` on anything, on any session, by any name.

        The complement of the import check, and it catches what an import check cannot: a module
        that reached ``session.execute(text("select 1"))`` through the injected session alone,
        naming ``sqlalchemy`` never. Parsed rather than grepped, so a mention inside a docstring or
        a comment - and this package's prose mentions ``execute`` in several places, describing
        what the layer below it does - is not mistaken for a call.

        ``scalar``, ``scalars`` and ``stream`` are checked beside it because each is another way to
        run a statement on a session, and an exemption argued for one would be argued for all four.
        """
        forbidden = {"execute", "scalar", "scalars", "stream"}
        offenders: dict[str, list[str]] = {}
        for module, source in self._api_tier_sources().items():
            called = sorted(
                {
                    node.func.attr
                    for node in ast.walk(ast.parse(source))
                    if isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute)
                    and node.func.attr in forbidden
                }
            )
            if called:
                offenders[module] = called
        assert offenders == {}
