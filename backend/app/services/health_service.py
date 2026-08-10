"""The readiness verdict: is this instance fit to be sent traffic, and what may be said about why.

``app.api.v1.routers.health`` asks the question and shapes the answer for the wire.
``app.repositories.health_repository`` issues the one statement. Everything between the two is
here, and it is all judgement rather than mechanics:

* **The verdict.** A completed round trip means ready; anything at all going wrong means not ready.
  :meth:`HealthService.check_readiness` returns in the first case and raises
  :class:`DatabaseUnavailableError` in the second.
* **The classification.** :func:`readiness_failure_fields` reduces the caught exception to a fixed
  vocabulary plus three type-derived fields, because *which kind* of failure it was is the only
  part an operator acts on differently.
* **The disclosure boundary.** A driver's connection-failure message names the host, the port, the
  database and the user it tried. None of that reaches the response and none of it reaches the log,
  and enforcing that is a policy decision - exactly the kind that belongs in a service and not in a
  route or a repository.

Why this module exists at all
-----------------------------
AAP §0.2.3 makes layering unconditional: "Layered separation is mandatory. Route handlers contain
no data-access logic. Handlers delegate to services, services delegate to repositories,
repositories own queries, and models own schema." Readiness is not carved out of that, so the probe
gets the same three layers as every other operation in the service. The alternative this repository
tried first - one narrowly documented in-handler statement, argued as a bounded exception - is what
a code review correctly rejected: an exception that has to be argued in prose is a precedent, and
the next person to need "just one query" in a route has this file to point at.

The two collaborators are genuinely small, and that is the point rather than an objection to it.
The repository is one statement because readiness *is* one statement. This service is a verdict, a
classification and a disclosure rule, which is three decisions that were previously being made
inside a route handler.

Why the readiness 503 is *raised* here and not in ``app.core.exceptions``
------------------------------------------------------------------------
That module declares the error contract and five domain members of it - 404, 409, 403, 422, 401 -
and no 503 among them, because service unavailability is not a rule any *domain* service enforces:
no ownership check produces it and no lifecycle transition produces it.
:class:`DatabaseUnavailableError` therefore lives beside the only thing that raises it, and the
domain hierarchy stays exactly the five failures the domain reports.

That is a statement about which *exception* is declared where, and not a claim that this file owns
the status. ``app.core.exceptions`` also answers 503 - for a data route whose statement could not
reach the database, through ``_database_unavailable_handler`` - and it must, because that failure
arrives as a raw SQLAlchemy exception at a route this service knows nothing about. The two are one
contract seen from two surfaces: identical ``type``, ``title`` and status, identical classified log
fields from :func:`~app.core.exceptions.database_failure_fields`, and a ``detail`` that differs
only in the sentence a person reads - "not ready to accept traffic" for an orchestrator deciding
whether to route here at all, "could not reach its data store" for a caller whose request failed.

The readiness failure is nevertheless a full member of the error contract on the wire. Starlette
dispatches a handler by walking ``type(exc).__mro__``, so subclassing ``AppError`` is what routes
this failure to the one registered ``AppError`` handler: the document, its ``instance`` path, its
``request_id``, its ``X-Request-ID`` header and its ``application/problem+json`` media type all
come from there. A readiness 503 is byte-for-byte the same kind of object as a 404 from a post
lookup.

Exactly one record is logged, and only on failure
-------------------------------------------------
``app.middleware.request_context`` already emits one structured access record per request, and it
treats the two probe paths specifically: ``QUIET_ACCESS_LOG_PATHS`` downgrades them to ``debug``
**only** while they neither fail nor answer badly, so a readiness probe answering 503 is logged at
``error`` with its status, its path, its duration and the bound ``request_id``.

That record says the probe failed. It cannot say **why**, and the difference matters operationally:
a refused connection, an unresolvable host, a rejected password, an exhausted pool and a statement
failure all produce ``/readyz returned 503`` and nothing else, so an operator watching an instance
drop out of rotation cannot tell a database that is down from a credential that was rotated without
telling this deployment. The reason is not recoverable later either - the caught exception is
chained into a domain error, and the registered ``AppError`` handler renders that as a problem
document without frames, so the middleware never sees an exception at all.

:meth:`HealthService.check_readiness` therefore emits **one** record of its own, at ``error``,
immediately before raising: the classification, the exception class name, the originating driver
class name, and the SQLSTATE where the driver supplied one. Every one of those is a closed
vocabulary or a type name.

What is deliberately **not** on that line is the exception's own text, for the reason
``app.core.exceptions`` documents: psycopg's connection-failure message names the host, the port,
the database and the user it tried. The record is built from attributes rather than from a message,
and it is emitted with ``logger.error`` rather than ``logger.exception`` so no traceback and no
driver text is attached. The correlation identifier is not passed either -
``structlog.contextvars.merge_contextvars`` is the first processor in the configured chain, so the
``request_id`` the middleware bound is already on the line, and this record and the access record
can be read together.
"""

from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Final

from fastapi import status
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppError, DatabaseFailureClass, database_failure_fields
from app.core.logging import get_logger
from app.repositories import HealthRepository

__all__ = [
    "READINESS_TIMEOUT_SECONDS",
    "DatabaseUnavailableError",
    "HealthService",
    "ReadinessFailureClass",
    "readiness_failure_fields",
]


# ---------------------------------------------------------------------------------------
# The 503 problem document
#
# `app.core.exceptions` keeps its `(type, title)` pair for this status as private constants
# behind the `_STATUS_PROBLEM` table that renders a framework-raised 503. Private means they
# cannot be imported, so the two strings are restated below and MUST stay identical to that
# table's 503 entry character-for-character: a client branching on `type` has to see one value
# for the status whether the 503 came from this probe or from anywhere else, and that is the
# entire purpose of a stable type field.
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
connection failure whose message names the host, the port, the database and the user that was
tried - a topology and credential disclosure, which ``app.core.exceptions`` calls out as the
concrete hazard of a probe passing its error text through. A fixed sentence also keeps the document
stable: two readiness failures for two different underlying reasons produce the same ``detail``, so
nothing downstream starts parsing it.

It states the verdict rather than the cause on purpose. The verdict is what the caller acts on; the
cause is an operator's concern and reaches them through the two log records this response produces
- the access record ``app.middleware.request_context`` emits at ``error``, and the classified
failure record :meth:`HealthService.check_readiness` emits beside it."""


# ---------------------------------------------------------------------------------------
# The readiness failure record
#
# A closed vocabulary and three type-derived fields, and NOT declared here: the classification
# lives in `app.core.exceptions` as `database_failure_fields`, and this module re-exports it
# under the readiness-facing name its callers already use.
#
# It moved there because a second surface needed the identical reduction. A data route that
# cannot reach the database answers 503 through
# `app.core.exceptions._database_unavailable_handler`, which writes the same fields from the same
# function - so an operator watching one outage can group the readiness record and every data
# record it produced on `failure_class` and `sqlstate` rather than on two vocabularies that agree
# only by coincidence. Two classifications of one condition is one too many whichever is read.
#
# The direction is forced as well as correct: this module imports `AppError` from
# `app.core.exceptions`, so a classifier owned here and imported back would close a cycle. The
# classification is also part of the error contract, which is what that module is.
# ---------------------------------------------------------------------------------------

ReadinessFailureClass = DatabaseFailureClass
"""The fixed vocabulary of readiness failure classifications.

An alias of :data:`~app.core.exceptions.DatabaseFailureClass` rather than a second Literal with
the same members: two copies of a closed vocabulary drift, and the drift is invisible until an
alert rule stops matching one of the two surfaces that publish it. Kept under this name because
``app.api.v1.routers.health`` and the readiness suite refer to it, and because "readiness failure
class" is what it means at this boundary.
"""

_READINESS_FAILURE_EVENT: Final[str] = "readiness_probe_failed"
"""Event name of the failure record. Stable, so it is safe to alert on.

Distinct from the ``database_unavailable_response`` event a data route writes, deliberately: the
two describe the same condition seen from different surfaces - "do not route to this instance" and
"this request could not be served" - and an operator needs to be able to ask for either alone. The
FIELDS are identical, which is what makes asking for both together equally easy.
"""

READINESS_TIMEOUT_SECONDS: Final[float] = 5.0
"""How long :meth:`HealthService.check_readiness` may spend on the database before it gives up.

The **whole** database interaction is inside this deadline, not just the statement: the session
``app.core.dependencies.get_db`` yields is lazy, so waiting for a pool slot, establishing the
connection and running the repository's statement all happen within the awaited call this bounds.
One number covers the sum rather than each term of it.

Five seconds because it has to sit above the slowest healthy answer and below the slowest useful
one. A healthy answer here is sub-millisecond warm and around ten milliseconds on the first
connect, so the margin is enormous; and an orchestrator's readiness probe times out in
single-digit seconds, so a probe that took longer would be reported as a timeout by the caller and
the classified log record this service writes would never be written. It matches
``app.db.session``'s ``CONNECT_TIMEOUT_SECONDS`` and ``POOL_TIMEOUT_SECONDS`` deliberately: a
*refused* database still fails in milliseconds - measured at two to four - and a slow one now costs
one deadline instead of one wait for a slot plus one connect attempt.

Measured, rather than assumed: against a reachable database asked for a twenty-second statement,
the await unwinds as :class:`TimeoutError` at 1.003s under a one-second deadline, the connection is
invalidated in under a millisecond, the session closes immediately and the next checkout from the
pool answers in six milliseconds. The deadline therefore costs nothing beyond itself and leaves
nothing behind.

The one failure this deadline cannot shorten, stated plainly
    Cancelling a statement is a *conversation*: the driver opens a second connection and asks the
    server to cancel the first. That works whenever the server is reachable, which is why the
    measurement above unwinds on time. It cannot work when the transport itself has stopped
    carrying application data while still acknowledging packets - a black-holing middlebox, or a
    server frozen rather than merely slow. There the cancel request goes unanswered too, the
    driver's unwind cannot complete, and this request outlives its deadline; no client-side
    setting changes that, because every remedy has to travel the same dead path. The backstop is
    the caller's own timeout, and it reaches the same verdict: an orchestrator counts a probe that
    timed out as a probe that failed and withdraws traffic exactly as a 503 would. What is lost is
    the classified record, not the decision.
"""


def readiness_failure_fields(exc: BaseException) -> dict[str, str]:
    """Reduce a caught database failure to the safe fields the failure record carries.

    One line, and the line is the point: this is
    :func:`~app.core.exceptions.database_failure_fields` under the name the readiness surface
    calls it by. That function derives every field from types and one validated driver attribute
    - no message, no argument, no statement, no parameters, no connection URL - and it is what a
    data route's 503 record is built from too, so the two records describing one outage carry
    identical ``failure_class``, ``exception_type``, ``driver_exception_type`` and ``sqlstate``
    values and can be grouped on any of them.

    Kept as a named function here rather than deleted in favour of the import, for two reasons
    that are both about the boundary rather than about the code. It is the name
    ``app.api.v1.routers.health`` and the readiness suite already refer to, and this docstring is
    where a reader of *this* module learns what the probe's record contains without having to
    follow an alias into another package.

    Args:
        exc: The exception :meth:`HealthService.check_readiness` caught. Any type, including one
            neither module has heard of, which is what ``unexpected_failure`` exists for.

    Returns:
        A mapping of log fields. ``failure_class`` and ``exception_type`` are always present;
        ``driver_exception_type`` and ``sqlstate`` appear only when the driver supplied them.
    """
    return database_failure_fields(exc)


class DatabaseUnavailableError(AppError):
    """503 - the readiness statement did not complete, so this instance cannot serve traffic.

    A subclass rather than a bare :class:`~app.core.exceptions.AppError`, because that base's
    ``__init__`` accepts a ``detail``, ``headers`` and field ``errors`` but no status: the class
    documents ``status_code``, ``error_type``, ``title`` and ``detail`` as ordinary per-subclass
    attributes for exactly this reason, and the five domain members of the hierarchy configure
    their statuses the same way.

    See "Why the 503 lives here" in the module docstring for why it is declared beside the one
    thing that raises it rather than in ``app.core.exceptions``, and why that placement costs it
    nothing on the wire.
    """

    status_code: int = status.HTTP_503_SERVICE_UNAVAILABLE
    error_type: str = _ERROR_TYPE_SERVICE_UNAVAILABLE
    title: str = _TITLE_SERVICE_UNAVAILABLE
    detail: str = _DETAIL_NOT_READY


class HealthService:
    """The readiness verdict, reached from one statement and reported as one classified record.

    Construct it per request with the injected session and call the one method the route needs::

        await HealthService(db).check_readiness()  # returns if ready, raises 503 if not

    Stateless beyond the session and the one repository it binds to it. Nothing is cached between
    calls, which is the whole contract of a readiness probe: a cached readiness answer is a stale
    one, and an instance kept in rotation by a stale answer is an outage.

    There is no ``check_liveness`` counterpart, and there must not be. Liveness asserts that this
    process is running and answers from a constant; giving it a service would give it a session,
    and a liveness probe that can fail for a reason outside the process is indistinguishable from a
    process that needs restarting. ``app.api.v1.routers.health.liveness`` resolves no dependency at
    all for that reason.

    Attributes:
        _health: Owns the one statement readiness issues. The only collaborator, because
            reachability is the only question being asked.
    """

    def __init__(self, session: AsyncSession) -> None:
        """Bind the service to one unit of work.

        Args:
            session: The request-scoped session, supplied by ``get_db`` in the API tier or by the
                transactional fixture in the suite. Injected rather than constructed: this module
                imports no session factory and no engine, which is what lets readiness be
                exercised against a substituted session that fails on demand.
        """
        self._health = HealthRepository(session)

    async def check_readiness(self) -> None:
        """Prove the database is reachable, or raise the 503 that pulls this instance out of
        rotation.

        Backs ``GET /readyz``. The route calls this and nothing else, then constructs its response
        model from a constant - so the statement, the classification, the log record and the
        verdict all live behind this one call.

        Why the ``try`` is where the failure surfaces:
            ``app.db.session`` constructs its engine and its session factory lazily and opens no
            connection at import time, and ``app.core.dependencies.get_db`` only enters the
            session's context manager - so an unreachable database does not fail while FastAPI is
            resolving the session dependency. The first thing that needs a live connection is the
            repository call below, which is inside the ``try``. Were it otherwise, dependency
            resolution would raise before the route was ever called and the response would be a
            500 through the handler of last resort instead of a deliberate 503.

        Why the caught set is ``(SQLAlchemyError, OSError, TimeoutError)`` and not ``Exception``:
            a refused connection, a DNS failure, an exhausted pool, an authentication rejection, a
            statement error and this method's own deadline are all the same answer to the only
            question being asked, and every one of them is in that set - ``SQLAlchemyError`` is the
            root of the driver and pool hierarchy, ``OSError`` covers a socket that failed outside
            it, and ``TimeoutError`` is what ``asyncio.timeout`` raises. Catching ``Exception``
            instead swept up something else entirely: a programming defect in this file or the one
            below it - an ``AttributeError`` after a refactor, a ``TypeError`` on a changed
            signature - was filed as a database outage. That cost the 500 that alerting keys on,
            the traceback that makes the fault diagnosable, and the truth about whose bug it is,
            while an orchestrator withdrew traffic from an instance that was working. The two
            outcomes are now distinguishable at a glance: 503 means the database could not serve a
            trivial statement, 500 means this code has a bug. ``BaseException`` is not caught
            either way, so ``asyncio.CancelledError`` from a client that disconnected mid-request
            still propagates and is not misreported as an outage.

        ``READINESS_TIMEOUT_SECONDS`` bounds the whole interaction, and the difference is the
        point: ``connect_timeout`` and ``pool_timeout`` bound *reaching* the database, and neither
        bounds a connection that is established and unresponsive. On expiry the connection is
        invalidated rather than returned to the pool, and the failure is classified
        ``query_timeout`` so an operator is not sent after a connection that was never at fault.

        Returns:
            ``None``. Returning normally *is* the ready verdict: the round trip completed, so this
            instance can be sent traffic. There is no value for the caller to branch on, which is
            what keeps the route from having to re-derive a decision this method has already made.

        Raises:
            DatabaseUnavailableError: When the statement did not complete, for any reason. The
                registered ``AppError`` handler renders it as a 503 problem document carrying a
                fixed detail - the caught exception's own message names the host, the port, the
                database and the user, and never reaches the response. One classified failure
                record is written first; see "Exactly one record is logged" in the module docstring
                for what it carries and what it deliberately omits.
        """
        try:
            # `asyncio.timeout` rather than `wait_for`: it is the supported spelling from 3.11 and
            # it cancels the awaited operation at the deadline, which is what stops a silent peer
            # from holding this request open past the caller's own probe timeout.
            async with asyncio.timeout(READINESS_TIMEOUT_SECONDS):
                await self._health.ping()
        except (SQLAlchemyError, OSError, TimeoutError) as exc:
            # ONE record, immediately before the raise, and this is the only place the cause can be
            # described at all: the domain error below is rendered by the registered `AppError`
            # handler, which reports a status and a fixed detail and never sees this exception, so
            # after this line the reason is gone from the process. `logger.error` rather than
            # `logger.exception` on purpose - no frames and no driver text, only the classified
            # fields `readiness_failure_fields` derives - and the logger is obtained here rather
            # than at module scope because one built during import would memoise structlog's
            # unconfigured defaults, `configure_logging` running in the application lifespan after
            # every import has completed.
            get_logger(__name__).error(_READINESS_FAILURE_EVENT, **readiness_failure_fields(exc))
            # A deadline leaves the connection mid-statement, so it must not go back to the pool.
            # Invalidation closes and discards it; `get_db` then rolls back and closes a session
            # with nothing left to release, which is safe and verified. Only the timeout path needs
            # this - every other failure here either never got a connection or already invalidated
            # its own - and the invalidation itself is guarded, because a connection that is
            # already gone must not turn a 503 into a 500 on the way out.
            if isinstance(exc, TimeoutError):
                with suppress(SQLAlchemyError, OSError):
                    await self._health.invalidate()
            # Chained rather than swallowed, so the cause is preserved on the traceback for
            # anything that inspects it, while the rendered document carries only the fixed
            # detail. `from exc` is also what keeps this raise honest about its origin.
            raise DatabaseUnavailableError from exc
