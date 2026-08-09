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
load-bearing. ``readiness`` wraps only ``await db.execute(select(1))`` in its ``try``, so a
provider that raised during dependency resolution would surface as a 500 through the handler
of last resort instead of the deliberate 503 this suite is here to assert. The one place a
raise-on-resolution provider *is* used is the liveness isolation test above, where reaching it
at all is the failure being detected.

What is asserted, and what deliberately is not
----------------------------------------------
Only status codes, response headers and response bodies - the wire. Nothing here inspects a
handler, a service, a repository, a private attribute or a log record: every request goes
through the in-process client, which is what makes these integration tests rather than unit
tests of :mod:`app.api.v1.routers.health`. The one apparent exception is not one: the failure
document is checked for the absence of a driver's topology and credential text, and that is an
assertion about the response body, not about logging.

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

from collections.abc import AsyncIterator, Callable
from http import HTTPStatus
from typing import Any, Final, NoReturn

import pytest
from httpx import AsyncClient, Response
from sqlalchemy.exc import (
    DBAPIError,
    InterfaceError,
    OperationalError,
    TimeoutError as PoolTimeoutError,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.router import API_V1_PREFIX

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
"""``detail`` of the readiness failure document: a fixed sentence stating the verdict, never
the caught exception's message. Asserted as an equality rather than a pattern, because the
whole point is that two readiness failures with two different causes read identically."""


# ---------------------------------------------------------------------------------------
# Disclosure markers
#
# A real driver's connection failure names the host, the port, the database and the user it
# tried - `psycopg` renders exactly that - and `app.api.v1.routers.health` and
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
"""The statement ``readiness`` issues, restated so the substituted failures name it too.

Not imported from anywhere: the route builds it as ``select(1)``, which has no textual form to
share. It appears here only inside a fabricated exception, so the two never need to agree - what
matters is that a failure carries a statement at all, because a real one does and it is one more
thing that must not reach the response.
"""

SQLSTATE_INVALID_PASSWORD: Final[str] = "28P01"
"""A SQLSTATE a rejected credential produces. Carried on a substituted driver exception so the
route's SQLSTATE extraction is exercised. A condition code names a *condition*, never a host, a
credential or a row, which is why ``app.api.v1.routers.health`` treats it as safe to log while
treating the message it arrived with as unsafe to publish."""

SQLSTATE_TOO_MANY_CONNECTIONS: Final[str] = "53300"
"""A SQLSTATE an exhausted server produces. Present for the same reason as the one above."""


class DriverFailureError(Exception):
    """Stand-in for the driver exception SQLAlchemy exposes as ``DBAPIError.orig``.

    Real drivers wrap a lower-level failure and publish a SQLSTATE alongside it - psycopg 3
    exposes the code as ``sqlstate`` - and ``app.api.v1.routers.health`` reads both the wrapped
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
    build_connection_failure,
    build_driver_interface_failure,
    build_database_error,
    build_unexpected_failure,
)
"""One builder per classification ``app.api.v1.routers.health`` publishes, in the order it tests
them.

Five, and the set is exhaustive rather than illustrative: it is exactly the
``ReadinessFailureClass`` vocabulary the route declares, so a classification added there without a
case added here leaves a branch of the failure path unexercised. Every builder plants the *same*
message, so the only thing varying between parametrised cases is the exception class - which is
the variable under test. Parametrising over all five is what turns "the document is fixed" from a
claim about one code path into a claim about the contract.
"""

FAILURE_BUILDER_IDS: Final[tuple[str, ...]] = (
    "pool_timeout",
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
    reachable: ``readiness`` wraps only its ``execute`` call in a ``try``, so an object that
    failed while being yielded would fail during dependency resolution and be reported as a 500.

    ``close`` and ``rollback`` are present and inert because a caller unwinding from the failure
    may reasonably invoke either.
    """

    def __init__(self, failure: Exception) -> None:
        """Store the exception every statement will raise.

        Args:
            failure: The exception to raise. Built fresh per test by one of
                :data:`FAILURE_BUILDERS`, so no exception instance is ever raised twice.
        """
        self._failure = failure

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
    return response.headers.get("content-type", "").split(";")[0].strip()


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

        # Asserted per parametrised case, so passing for all five shapes is the proof that the
        # document is a property of the contract rather than of one code path: the route files
        # these failures under five different classifications in its log record and must not
        # distinguish them at all on the wire.
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
