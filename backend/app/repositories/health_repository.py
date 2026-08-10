"""The readiness statement: one trivial round trip, owned by the layer that owns every statement.

``GET /readyz`` answers one question - *can this instance reach the database?* - and it answers it
by issuing a statement. Under the mandatory route -> service -> repository layering (AAP §0.2.3,
"Route handlers contain no data-access logic ... repositories own queries") that statement belongs
here, in the data-access layer, and nowhere else. This module is the whole of it:
:meth:`HealthRepository.ping` issues ``SELECT 1`` and returns nothing.

Why a repository with no relation behind it
-------------------------------------------
Every sibling in this package is parameterised by a mapped class - ``PostRepository`` reads
``posts``, ``UserRepository`` reads ``users`` - and inherits
:class:`~app.repositories.base.BaseRepository`, whose helpers all presuppose one: ``get_or_none``
filters ``self.model``, ``paginate`` counts a statement over it, ``save`` refreshes an instance of
it. The readiness statement reads no table at all, so there is no ``model`` to declare and not one
inherited helper that would apply. This class therefore holds a session directly instead of
extending that base, and it is the only repository in the service that does.

That is a deliberate narrow shape rather than an inconsistency to be tidied away. Giving
``BaseRepository`` a ``ping`` method would hand the same operation to all six relation-bound
repositories, where it means nothing and where a future caller would reach for it from whichever
repository happened to be in scope. Parameterising this class with an arbitrary mapped class to
satisfy the generic would be worse: it would claim a relation this statement does not read, and the
first person to trust that claim would add a query against it here.

What this module must never do
------------------------------
The two invariants :class:`~app.repositories.base.BaseRepository` states hold here in full, even
though this class does not inherit them:

* **No commit.** Nothing is written, so there is no unit of work to close. The session is used and
  handed back exactly as it arrived.
* **No HTTP artefact, no domain exception, no logging.** A failed round trip raises whatever
  SQLAlchemy raised, unaltered and unlogged. Deciding what that failure *means* - that this
  instance must be pulled out of rotation, that a 503 problem document is the answer, which of
  five classifications it falls under and what may safely be written about it - is
  ``app.services.health_service``'s work, and it is the reason the exception must arrive there
  intact. Catching it here to translate or annotate it would put the verdict in the layer that is
  meant only to ask the question.

Where this sits in the readiness path
-------------------------------------
``app.api.v1.routers.health.readiness`` calls
:meth:`~app.services.health_service.HealthService.check_readiness`, which calls :meth:`ping`. Three
files, one statement, and each layer doing only its own job - which is what makes "the route
contains no data-access logic" true of this service without exception, rather than true everywhere
except its probes.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

__all__ = ["HealthRepository"]


class HealthRepository:
    """Issues the readiness statement against one unit of work, and nothing else.

    Constructed per request from the injected session, used once, discarded::

        await HealthRepository(session).ping()

    Nothing is cached on the instance and no state accumulates, so it is exactly as
    concurrency-safe as the :class:`~sqlalchemy.ext.asyncio.AsyncSession` it holds - which is to
    say it must not be shared between concurrent tasks, because a session is one unit of work over
    one connection.

    Attributes:
        session: The unit of work the statement is issued through. Assigned once and never
            rebound, never created here, never closed here, never committed.
    """

    session: AsyncSession
    """The unit of work :meth:`ping` issues its statement through.

    Injected rather than constructed: this module imports no engine and no session factory, which
    is what lets readiness be exercised against a substituted session in the suite - see
    ``UnreachableDatabaseSession`` in ``backend/tests/integration/test_health.py``.
    """

    def __init__(self, session: AsyncSession) -> None:
        """Bind this repository to one unit of work.

        Args:
            session: The request-scoped session the statement is issued through. Supplied by
                ``get_db`` in ``app/core/dependencies.py`` in the API tier, and by the
                transactional fixture in ``backend/tests/conftest.py`` in the suite. It is stored
                and nothing more.
        """
        self.session = session

    async def ping(self) -> None:
        """Issue the readiness statement, and let any failure propagate untouched.

        ``SELECT 1`` and nothing more: no table, no mapped model, no row count and no
        migration-version check. Each of those would make readiness fail for a reason that is not
        unreachability - a table a still-running migration has not created yet, a revision the
        deployment is mid-way through applying - and an instance pulled out of rotation by its own
        schema check is an outage the probe invented.

        The result is deliberately discarded. A completed round trip is the entire assertion:
        the pool produced a connection, the server accepted the statement and answered, and
        reading a row from that answer would prove nothing further. Nothing is committed, because
        nothing was written.

        Returns:
            ``None``. Returning normally *is* the successful outcome, so there is no value for a
            caller to inspect and none for this method to invent.

        Raises:
            Exception: Whatever SQLAlchemy or its driver raised, unaltered - a refused connection,
                an unresolvable host, a rejected password, an exhausted pool, a statement failure.
                Nothing is caught here on purpose: classification, logging and the 503 verdict all
                belong to :class:`~app.services.health_service.HealthService`, and it can only
                classify an exception it actually receives.
        """
        await self.session.execute(select(1))

    async def invalidate(self) -> None:
        """Discard the connection this session holds instead of returning it to the pool.

        Called by :class:`~app.services.health_service.HealthService` on one path only - its own
        deadline expiring - because that is the one failure that leaves a connection *mid
        statement*. Every other failure either never obtained one or has already invalidated its
        own. A connection abandoned part-way through a statement must not be handed to the next
        caller, which would inherit an unread result and fail for a reason that has nothing to do
        with it.

        The statement here is the data-access concern, so the discarding of the connection that
        issued it is too: the service decides *whether* to discard, this decides *how*. Nothing is
        caught, for the same reason ``ping`` catches nothing - the caller guards this call, because
        a connection that is already gone must not turn a 503 into a 500 on the way out.

        Returns:
            ``None``. There is nothing to report: after this the session holds no connection.
        """
        await self.session.invalidate()
