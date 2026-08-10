"""Integration suite for the one error the contract classifies by *provenance* rather than class.

Every other failure in this service maps to a status by its type: a ``NotFoundError`` is a 404, a
``RequestValidationError`` is a 422, an unanticipated exception is a 500.
``sqlalchemy.exc.DataError`` is the exception to that rule, and this module is here because the
exception is subtle enough to regress silently.

Why provenance and not class
----------------------------
``DataError`` wraps the whole of SQLSTATE class 22 - "data exception" - and the class says nothing
about **whose** value failed. The same exception type is raised by:

* a value a caller submitted that the storage layer refuses (``22P02`` on a malformed cast, a NUL
  character psycopg rejects before the statement is even sent) - the caller's to fix, so a 400;
* a value this service derived, a column whose type has drifted from the model, a conversion of a
  result the database returned, or stored data that is no longer representable (``22012`` division
  by zero being the sharpest example, since this API composes every statement itself) - a defect
  here, so a 500.

Answering 400 for the second group is the failure mode this suite exists to prevent, and it is a
quiet one in exactly the way that matters: the service is broken, the 5xx rate stays flat, no
traceback is written, and the alert that should have fired does not. So the assertions below are
paired - one status per provenance - and the 500 case asserts the *contract of a server error*
rather than merely a number: the same problem document every unanticipated failure produces, with a
generic detail that names no column, no statement and no driver.

How a data failure is provoked
------------------------------
By substitution, not by contriving a request. A NUL in a path or a query string no longer reaches
the driver at all - ``app.schemas.common``'s storable-text validators refuse it at the boundary with
a 422 naming the field, which is the better answer and the one a client normally sees - so there is
no request that reliably produces a ``DataError`` against a healthy database. Provoking one through
a real statement would also mean asserting on a driver's behaviour rather than on this service's
classification.

So :func:`~tests.conftest.override_get_db` installs a session-shaped double whose ``execute`` raises
a fabricated ``DataError``, and the route under test is a plain public read that resolves a session
and issues one statement. Every failure this module builds carries the *same* marker-bearing
message, so the only variable between cases is the SQLSTATE - which is the variable under test.

What is asserted, and what deliberately is not
----------------------------------------------
The wire, almost exclusively: status codes, media types, response bodies and the correlation header.
Nothing here inspects a handler or a private helper, and the search of each response for the
driver's marker text is an assertion about the *body* rather than about logging - a driver message
names the host, the port, the database and the user, and ``app.core.exceptions`` treats passing it
to a caller as a topology and credential disclosure.

**One** class reads the log stream, and it is the other half of the same requirement rather than a
convenience. Answering 500 is only half of treating a server defect as a server defect; the half
that makes it actionable is the traceback, and a 500 rendered with no frames is as undiagnosable as
the 400 this classification replaced. That property cannot be observed from a response, because the
body is generic by design - so :class:`TestTheServerErrorIsDiagnosable` configures logging into a
buffer, drives one request, and asserts the record carries frames with the driver's markers redacted
out of them.
"""

from __future__ import annotations

import io
import json
from collections.abc import AsyncIterator, Callable, Iterator
from http import HTTPStatus
from typing import Any, Final, NoReturn

import pytest
from fastapi import HTTPException
from httpx import AsyncClient, Response
from sqlalchemy.exc import DataError

from app.api.v1.router import API_V1_PREFIX
from app.core.logging import configure_logging

# ---------------------------------------------------------------------------------------
# The route under test
#
# The category collection: public, so no credential is involved in the outcome; it resolves the
# request-scoped session and issues one statement through `CategoryRepository`, so a substituted
# session fails inside the handler rather than during dependency resolution; and it takes no
# parameters, so nothing can be rejected at the boundary before the statement is reached.
# ---------------------------------------------------------------------------------------

CATEGORIES_PATH: Final[str] = f"{API_V1_PREFIX}/categories"

JSON_MEDIA_TYPE: Final[str] = "application/json"
PROBLEM_MEDIA_TYPE: Final[str] = "application/problem+json"
REQUEST_ID_HEADER: Final[str] = "X-Request-ID"

PROBLEM_KEYS: Final[frozenset[str]] = frozenset(
    {"type", "title", "status", "detail", "instance", "request_id"}
)
"""Every member of the problem document, and nothing else.

Asserted as an exact set rather than a subset: a field added to an error body is a field a client
starts depending on, and a field missing from one is a client branch that stops working.
"""

BAD_REQUEST_TYPE: Final[str] = "/errors/bad-request"
BAD_REQUEST_TITLE: Final[str] = "Bad Request"
BAD_REQUEST_DETAIL: Final[str] = "The request contained a value that could not be processed."

INTERNAL_TYPE: Final[str] = "/errors/internal-server-error"
INTERNAL_TITLE: Final[str] = "Internal Server Error"
INTERNAL_DETAIL: Final[str] = "An unexpected error occurred."

# ---------------------------------------------------------------------------------------
# Markers
#
# Shaped like the text a real driver produces, and distinctive enough that a substring search for
# any of them is an exact test of whether it survived into the response. None is a real credential
# and none can resolve: `.invalid` is reserved by RFC 2606.
# ---------------------------------------------------------------------------------------

MARKER_HOST: Final[str] = "db-marker.invalid"
MARKER_USER: Final[str] = "marker_db_user"
MARKER_ADDRESS: Final[str] = "203.0.113.201"
MARKER_ADDRESS_NETWORK: Final[str] = "203.0.113.0/24"
MARKER_VALUE: Final[str] = "MARKER-OFFENDING-VALUE"
MARKER_STATEMENT: Final[str] = "SELECT categories.id FROM categories"

DISCLOSURE_MARKERS: Final[tuple[str, ...]] = (MARKER_HOST, MARKER_USER, MARKER_VALUE)
"""What must never appear in a response body, whichever status the failure is filed under."""

_FAILURE_MESSAGE: Final[str] = (
    f'invalid input syntax for type uuid: "{MARKER_VALUE}" at server "{MARKER_HOST}" '
    f'for user "{MARKER_USER}"'
)

SQLSTATE_INVALID_TEXT_REPRESENTATION: Final[str] = "22P02"
"""A value that could not be parsed as its target type. Every cast in this API is applied to a
bound parameter, so this one is the caller's."""

SQLSTATE_STRING_DATA_RIGHT_TRUNCATION: Final[str] = "22001"
"""A value longer than the column can hold. Every text column here is unbounded, so this takes a
submitted value."""

SQLSTATE_DIVISION_BY_ZERO: Final[str] = "22012"
"""Class 22, and emphatically NOT the caller's: it describes the statement, and this API composes
every statement itself. The case that proves the classification is by provenance."""

SQLSTATE_INVALID_REGULAR_EXPRESSION: Final[str] = "2201B"
"""Also class 22, also the statement's: no endpoint accepts a caller-supplied pattern."""

UNHANDLED_EVENT: Final[str] = "unhandled_exception_response"
"""Event name ``app.core.exceptions`` writes when it renders a 500. Stable, so it is safe to alert
on - and therefore safe for one test to assert on."""

SERVER_ERROR_DETAIL: Final[str] = "The server could not complete the request."
"""``detail`` published when a 5xx ``HTTPException`` arrived carrying one of its own.

Distinct from :data:`INTERNAL_DETAIL` on purpose, and that distinction is worth a test: the two 500
paths - an exception nobody handled, and an ``HTTPException`` whose detail was withheld - stay
legible apart in a log and to an operator, while presenting the same document shape at the same
status to the caller."""

SUPPRESSION_EVENT: Final[str] = "http_exception_detail_suppressed"
"""Event name ``app.core.exceptions`` writes when it withholds a 5xx detail from the response.

Restated rather than imported: it is the name an alert or a dashboard query would be written
against, so a test that shares a constant with the code would not notice it changing."""

SUPPRESSED_DETAIL: Final[str] = (
    f'MARKER-SUPPRESSED: could not reach "{MARKER_HOST}" as user "{MARKER_USER}"'
)
"""A 5xx detail shaped like the ones that are genuinely dangerous to publish.

It names a host and a user, because that is what a server-failure detail composed by a framework or
a dependency actually tends to contain - and it is distinctive, so one test can prove it never
reaches the response while another proves it does reach the log."""

NUL_REFUSAL_MESSAGE: Final[str] = "PostgreSQL text fields cannot contain NUL (0x00) bytes"
"""psycopg's own wording for the one client-side refusal whose provenance is certain.

Raised before the statement is sent, so it carries no SQLSTATE - and a NUL can never have come
*out* of a column, because PostgreSQL's ``text`` and ``citext`` cannot store one. Restated here
rather than imported: the point of the test is that the service recognises the driver's phrase, so
sharing a constant with the code under test would assert nothing.
"""


class DriverDataError(Exception):
    """Stand-in for the driver exception SQLAlchemy exposes as ``DataError.orig``.

    psycopg publishes the five-character condition code on its exceptions as ``sqlstate``, and
    ``app.core.exceptions`` reads exactly that attribute to decide provenance. A purpose-built
    double is used so the attribute can also be *absent* in effect - ``None`` - which is the shape
    a client-side refusal really has.
    """

    def __init__(self, message: str, sqlstate: str | None = None) -> None:
        """Build the double.

        Args:
            message: The driver's message, always marker-bearing.
            sqlstate: The condition code, or ``None`` for a failure raised before the statement
                reached the server.
        """
        super().__init__(message)
        self.sqlstate = sqlstate


def build_data_error(sqlstate: str | None, message: str = _FAILURE_MESSAGE) -> DataError:
    """Build the ``DataError`` SQLAlchemy would raise around *sqlstate*.

    The statement and parameters are supplied positionally because that is
    :class:`~sqlalchemy.exc.DBAPIError`'s constructor - ``(statement, params, orig)`` - and both
    end up in ``str(exc)``, which is precisely the text this suite then proves never reaches a
    response.

    Args:
        sqlstate: The condition code the driver published, or ``None`` for a client-side refusal.
        message: The driver's message.

    Returns:
        The exception, wrapping a driver double.
    """
    return DataError(MARKER_STATEMENT, {}, DriverDataError(message, sqlstate))


class DataFailingSession:
    """Session-shaped double whose every statement raises the data failure it was built with.

    The failure happens at :meth:`execute` and nowhere earlier, which is what makes the handler
    reachable: an object that failed while being yielded would fail during dependency resolution,
    and the outcome would be a 500 for a reason that has nothing to do with the classification
    under test.

    ``close`` and ``rollback`` are present and inert because ``get_db`` rolls back and closes on
    the way out of a failed request.
    """

    def __init__(self, failure: DataError) -> None:
        """Store the exception every statement will raise.

        Args:
            failure: Built fresh per test, so no exception instance is ever raised twice.
        """
        self._failure = failure

    async def execute(self, *args: Any, **kwargs: Any) -> NoReturn:
        """Raise instead of executing, whatever statement was passed.

        Args:
            *args: Ignored - the statement never runs.
            **kwargs: Ignored, for the same reason.

        Raises:
            DataError: Always, and always the instance this double was built with.
        """
        del args, kwargs
        raise self._failure

    async def close(self) -> None:
        """Accept a close, having nothing to close."""

    async def rollback(self) -> None:
        """Accept a rollback, having nothing to roll back."""


@pytest.fixture
def failing_client(
    client: AsyncClient,
    override_get_db: Callable[[Callable[..., Any]], None],
) -> Callable[[DataError], AsyncClient]:
    """Return an installer that points the client's session at a data failure.

    :func:`~tests.conftest.client` is requested rather than left to the test's signature, and that
    is not cosmetic: it installs its own ``get_db`` override while it is being set up, so a test
    that named them the other way round would have the working override installed *after* this one
    and the failure would never happen.

    Restoration belongs to :func:`~tests.conftest.override_get_db` and therefore happens when the
    test fails as well as when it passes.

    Args:
        client: The in-process client, requested to force this fixture to resolve after it.
        override_get_db: The restoring installer.

    Returns:
        A callable taking the failure to raise and returning the client to drive.
    """

    def install(failure: DataError) -> AsyncClient:
        async def _failing_db() -> AsyncIterator[DataFailingSession]:
            yield DataFailingSession(failure)

        override_get_db(_failing_db)
        return client

    return install


@pytest.fixture
def captured_log_stream() -> Iterator[io.StringIO]:
    """Point the service's single log handler at a buffer, and put it back afterwards.

    ``configure_logging`` replaces the root handler rather than adding one, so this leaves exactly
    one handler writing to the buffer and exactly one line per record - and calling it again with
    no argument in the teardown restores the process configuration whether the test passed, failed
    or was interrupted.

    Nothing about the settings object is touched. The suite runs as ``ENVIRONMENT=test``, which
    selects the JSON chain, so the buffer receives one parsable object per line; and at
    ``LOG_LEVEL=WARNING``, which is below the ``error`` the 500 path writes at, so the record under
    test reaches the buffer without the threshold being altered.

    Yields:
        The buffer, holding exactly the bytes a log collector would have received.
    """
    buffer = io.StringIO()
    configure_logging(stream=buffer)
    try:
        yield buffer
    finally:
        configure_logging()


def assert_problem_document(
    response: Response,
    *,
    status: HTTPStatus,
    error_type: str,
    title: str,
    detail: str,
) -> dict[str, Any]:
    """Assert *response* is the uniform problem document at *status*, and return its body.

    The same checks whichever provenance produced it, because "one error contract" means a 400 and
    a 500 differ in their values and not in their shape: exact key set, ``application/problem+json``
    media type, the published ``type``/``title``/``detail`` triple, the document's own ``status``
    agreeing with the HTTP status, the ``instance`` naming the request path, and ``request_id``
    non-empty and equal to the correlation header so a caller's report and a log query cannot land
    on different requests.

    It also asserts the driver's markers are gone. That is the security half of the contract and it
    applies to both statuses: a driver message names the host, the port, the database and the user
    it tried, and the offending value itself.

    Args:
        response: The response to check.
        status: Expected HTTP status, and expected value of the document's ``status``.
        error_type: Expected ``type``.
        title: Expected ``title``.
        detail: Expected ``detail`` - a fixed sentence on both paths, so this is an equality.

    Returns:
        The parsed document.
    """
    assert response.status_code == status
    assert response.headers.get("content-type", "").split(";")[0].strip() == PROBLEM_MEDIA_TYPE

    body: dict[str, Any] = response.json()
    assert set(body) == PROBLEM_KEYS
    assert body["type"] == error_type
    assert body["title"] == title
    assert body["detail"] == detail
    assert body["status"] == status
    assert body["instance"] == CATEGORIES_PATH
    assert body["request_id"]
    assert body["request_id"] == response.headers.get(REQUEST_ID_HEADER)

    rendered = response.text
    for marker in DISCLOSURE_MARKERS:
        assert marker not in rendered, f"{marker!r} reached the response:\n{rendered}"
    assert MARKER_STATEMENT not in rendered
    return body


class TestRequestCausedDataFailure:
    """A value the caller supplied: 400, with a fixed detail and no driver text."""

    @pytest.mark.parametrize(
        "sqlstate",
        [SQLSTATE_INVALID_TEXT_REPRESENTATION, SQLSTATE_STRING_DATA_RIGHT_TRUNCATION],
        ids=["invalid_text_representation", "string_data_right_truncation"],
    )
    async def test_a_request_caused_sqlstate_is_a_400(
        self, failing_client: Callable[[DataError], AsyncClient], sqlstate: str
    ) -> None:
        """Both describe a *value*, and in this schema only a submitted value produces them."""
        response = await failing_client(build_data_error(sqlstate)).get(CATEGORIES_PATH)
        assert_problem_document(
            response,
            status=HTTPStatus.BAD_REQUEST,
            error_type=BAD_REQUEST_TYPE,
            title=BAD_REQUEST_TITLE,
            detail=BAD_REQUEST_DETAIL,
        )

    async def test_a_client_side_nul_refusal_is_a_400(
        self, failing_client: Callable[[DataError], AsyncClient]
    ) -> None:
        """The one no-SQLSTATE case with certain provenance.

        psycopg refuses a NUL in a bound parameter before the statement is sent, so there is no
        condition code to read - and PostgreSQL cannot store a NUL, so the value can only have
        been on its way in. This is the case the handler was originally written for.
        """
        failure = build_data_error(None, message=NUL_REFUSAL_MESSAGE)
        response = await failing_client(failure).get(CATEGORIES_PATH)
        assert_problem_document(
            response,
            status=HTTPStatus.BAD_REQUEST,
            error_type=BAD_REQUEST_TYPE,
            title=BAD_REQUEST_TITLE,
            detail=BAD_REQUEST_DETAIL,
        )


class TestServerCausedDataFailure:
    """A data failure that is not the caller's: 500, as the server error it is."""

    @pytest.mark.parametrize(
        "sqlstate",
        [SQLSTATE_DIVISION_BY_ZERO, SQLSTATE_INVALID_REGULAR_EXPRESSION],
        ids=["division_by_zero", "invalid_regular_expression"],
    )
    async def test_a_statement_level_sqlstate_is_a_500(
        self, failing_client: Callable[[DataError], AsyncClient], sqlstate: str
    ) -> None:
        """Both codes describe the *statement*, which this API composes itself.

        The assertion that matters is the status: filing either of these as a 400 would report a
        defect in this service as the caller's mistake, leave the 5xx rate flat while the service
        was broken, and discard the traceback that says where.
        """
        response = await failing_client(build_data_error(sqlstate)).get(CATEGORIES_PATH)
        assert_problem_document(
            response,
            status=HTTPStatus.INTERNAL_SERVER_ERROR,
            error_type=INTERNAL_TYPE,
            title=INTERNAL_TITLE,
            detail=INTERNAL_DETAIL,
        )

    async def test_a_client_side_refusal_that_is_not_a_nul_is_a_500(
        self, failing_client: Callable[[DataError], AsyncClient]
    ) -> None:
        """No SQLSTATE is not enough on its own.

        A client-side data error can equally be a *result* the driver could not convert, which is
        stored data rather than submitted data. Only the NUL condition is recognised, and anything
        else without a code is a server error.
        """
        failure = build_data_error(None, message=f"cannot convert value {MARKER_VALUE!r} to date")
        response = await failing_client(failure).get(CATEGORIES_PATH)
        assert_problem_document(
            response,
            status=HTTPStatus.INTERNAL_SERVER_ERROR,
            error_type=INTERNAL_TYPE,
            title=INTERNAL_TITLE,
            detail=INTERNAL_DETAIL,
        )

    async def test_an_unclassified_sqlstate_is_a_500(
        self, failing_client: Callable[[DataError], AsyncClient]
    ) -> None:
        """A class-22 code the allow-list does not name fails closed - toward the server.

        ``22003 numeric_value_out_of_range`` is the example: every number this schema writes is
        derived by the service or by the database clock, so a range failure is far more likely to
        be a bug here than a submitted value.
        """
        response = await failing_client(build_data_error("22003")).get(CATEGORIES_PATH)
        assert_problem_document(
            response,
            status=HTTPStatus.INTERNAL_SERVER_ERROR,
            error_type=INTERNAL_TYPE,
            title=INTERNAL_TITLE,
            detail=INTERNAL_DETAIL,
        )


class TestTheServerErrorIsDiagnosable:
    """The 500 must carry a traceback into the log, or it is undiagnosable.

    This is the half of the classification that the response cannot show. A generic body is
    deliberate; the frames are what make the incident findable, and they are the reason filing a
    server defect as a 400 was worth changing - that path logged one bounded warning and no stack.
    """

    async def test_the_500_logs_the_traceback(
        self,
        failing_client: Callable[[DataError], AsyncClient],
        captured_log_stream: io.StringIO,
    ) -> None:
        """One record, correlated, and carrying the frames.

        Four things are asserted together because each is worthless without the others: the record
        exists and names the unhandled-response event; it is filed under the class that failed and
        the status that was sent; it names the path, using the shared HTTP field names so it joins
        the access record beside it; and it carries the traceback - ``exception`` is the key
        ``structlog``'s frame transformer writes, and its absence is the exact defect that made
        the old 400 unactionable.
        """
        response = await failing_client(build_data_error(SQLSTATE_DIVISION_BY_ZERO)).get(
            CATEGORIES_PATH
        )
        assert response.status_code == HTTPStatus.INTERNAL_SERVER_ERROR

        rendered = captured_log_stream.getvalue()
        records = [json.loads(line) for line in rendered.splitlines() if line.strip()]
        unhandled = [record for record in records if record.get("event") == UNHANDLED_EVENT]
        assert unhandled, f"no {UNHANDLED_EVENT!r} record was written:\n{rendered}"

        record = unhandled[-1]
        assert record["exception_type"] == "DataError"
        assert record["status_code"] == int(HTTPStatus.INTERNAL_SERVER_ERROR)
        assert record["path"] == CATEGORIES_PATH
        assert record["request_id"] == response.headers.get(REQUEST_ID_HEADER)
        assert record.get("exception"), f"the 500 was logged without frames:\n{rendered}"

    async def test_the_logged_frames_carry_no_address_from_the_driver(
        self,
        failing_client: Callable[[DataError], AsyncClient],
        captured_log_stream: io.StringIO,
    ) -> None:
        """The retained cause is redacted where retention is not allowed.

        The two sinks have deliberately different rules, and this test pins the difference rather
        than assuming it. The **response** carries nothing from the driver at all - every other
        test in this module asserts that. The **log** is where the cause legitimately lives, so a
        host name and a statement are kept: they are what an operator needs, and a record that
        withheld them would send a 500 to nobody's benefit. What may not be kept even there is the
        classes ``app.core.logging`` redacts, and an address is one of them: psycopg's
        connection-failure text names the address it resolved to, and an address identifies a
        person.

        So the address is reduced to its ``/24`` inside the rendered frames, while the host name it
        sits beside survives.
        """
        failure = build_data_error(
            SQLSTATE_DIVISION_BY_ZERO,
            message=f'server "{MARKER_HOST}" ({MARKER_ADDRESS}) rejected the statement',
        )
        response = await failing_client(failure).get(CATEGORIES_PATH)
        assert response.status_code == HTTPStatus.INTERNAL_SERVER_ERROR

        rendered = captured_log_stream.getvalue()
        assert MARKER_ADDRESS not in rendered, f"an address was retained:\n{rendered}"
        assert MARKER_ADDRESS_NETWORK in rendered, f"the network was not kept:\n{rendered}"
        assert MARKER_HOST in rendered, "the host is a diagnostic and must survive in the log"


class TestTheReRaiseIsRepeatable:
    """The 500 path travels further than a handled failure, and must leave nothing behind."""

    async def test_two_consecutive_server_side_data_failures_answer_identically(
        self, failing_client: Callable[[DataError], AsyncClient]
    ) -> None:
        """Asserted because a re-raise is the one path that escapes its own dispatch site.

        A handled exception is answered where it is caught; this one leaves the framework's
        exception middleware and is caught by the wrapper ``app.main`` registers innermost. If that
        journey left state behind - a half-sent response, a middleware that had already started
        one, an exception handler that had consumed its turn - the *second* failure would surface
        differently from the first. Two requests, two identical documents, and two distinct
        correlation identifiers is what proves it does not.
        """
        client = failing_client(build_data_error(SQLSTATE_DIVISION_BY_ZERO))

        first = await client.get(CATEGORIES_PATH)
        second = await client.get(CATEGORIES_PATH)

        for response in (first, second):
            assert_problem_document(
                response,
                status=HTTPStatus.INTERNAL_SERVER_ERROR,
                error_type=INTERNAL_TYPE,
                title=INTERNAL_TITLE,
                detail=INTERNAL_DETAIL,
            )
        assert first.json()["request_id"] != second.json()["request_id"]


class TestSuppressedServerDetail:
    """A 5xx ``HTTPException`` carrying its own detail: withheld from the caller, kept in the log.

    The third provenance this module has to cover, and the one with no domain error behind it. A
    framework-level or dependency-level ``HTTPException`` at 5xx arrives with a ``detail`` somebody
    composed - and a detail composed for a server failure is exactly the string most likely to name
    a host, a connection URL or an internal identifier. The contract replaces it with the fixed
    server-error sentence and writes the original to the log instead, so the incident stays
    diagnosable at the cost of the caller learning nothing.

    That record is asserted here rather than taken on trust because its **field names** are the
    point. It has to be joinable with the access record ``app.middleware.request_context`` writes
    and with the unhandled-500 record above it: three records describing one request, queried
    together on method, path and status. A record keyed ``http_path`` cannot be read beside two
    keyed ``path``, and nothing but a test notices that.
    """

    @pytest.fixture
    def raising_client(
        self,
        client: AsyncClient,
        override_get_db: Callable[[Callable[..., Any]], None],
    ) -> AsyncClient:
        """Point the client at a dependency that raises a 5xx ``HTTPException`` with a detail.

        Raised during dependency resolution on purpose, which is the one seam that reaches this
        handler without a route being written for it: no endpoint in this service raises a 5xx
        ``HTTPException`` itself - they raise domain errors - so a substituted provider is how the
        published behaviour gets exercised at all.

        Args:
            client: The in-process client, requested first so its own override is installed before
                this one replaces it.
            override_get_db: The restoring installer from ``backend/tests/conftest.py``.

        Returns:
            The client, with the raising provider in place for the duration of the test.
        """

        async def _raising_db() -> NoReturn:
            raise HTTPException(
                status_code=int(HTTPStatus.INTERNAL_SERVER_ERROR),
                detail=SUPPRESSED_DETAIL,
            )

        override_get_db(_raising_db)
        return client

    async def test_the_composed_detail_is_replaced_on_the_wire(
        self, raising_client: AsyncClient
    ) -> None:
        """The caller gets the fixed server-error sentence, and none of the original."""
        response = await raising_client.get(CATEGORIES_PATH)

        # A different `detail` from the unhandled-500 case, deliberately: the two paths stay
        # legible apart in a log and to an operator reading a report, while being the same document
        # shape at the same status.
        body = assert_problem_document(
            response,
            status=HTTPStatus.INTERNAL_SERVER_ERROR,
            error_type=INTERNAL_TYPE,
            title=INTERNAL_TITLE,
            detail=SERVER_ERROR_DETAIL,
        )
        assert SUPPRESSED_DETAIL not in json.dumps(body)

    async def test_the_suppressed_detail_is_logged_on_the_shared_http_fields(
        self,
        raising_client: AsyncClient,
        captured_log_stream: io.StringIO,
    ) -> None:
        """Withheld is not discarded: the original survives, on field names that join."""
        response = await raising_client.get(CATEGORIES_PATH)
        assert response.status_code == HTTPStatus.INTERNAL_SERVER_ERROR

        rendered = captured_log_stream.getvalue()
        records = [json.loads(line) for line in rendered.splitlines() if line.strip()]
        suppressions = [r for r in records if r.get("event") == SUPPRESSION_EVENT]
        assert suppressions, f"no {SUPPRESSION_EVENT!r} record was written:\n{rendered}"

        record = suppressions[-1]
        # The shared names, asserted individually so a regression names the field it broke. The
        # legacy spellings are asserted ABSENT for the same reason: a handler that emitted both
        # would satisfy a positive-only check while still writing an unjoinable record.
        assert record["http_method"] == "GET"
        assert record["path"] == CATEGORIES_PATH
        assert record["status_code"] == int(HTTPStatus.INTERNAL_SERVER_ERROR)
        assert "http_path" not in record
        assert "http_status" not in record
        assert record["request_id"] == response.headers.get(REQUEST_ID_HEADER)

        # And the detail itself, which is the whole reason the record exists.
        assert SUPPRESSED_DETAIL in record["suppressed_detail"]
