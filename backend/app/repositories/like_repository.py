"""Every SQL statement ``post_likes`` needs, and the one guarantee this module does not make.

Four operations, one relation: grant a like, withdraw it, count the likes on a post, and answer
whether one particular account is among them. ``app.services.like_service`` is the only caller,
and it reaches ``PUT /api/v1/posts/{id}/like``, ``DELETE /api/v1/posts/{id}/like`` and
``GET /api/v1/posts/{id}/likes`` through these four methods and nothing else.

Idempotency belongs to the key, not to this module
-------------------------------------------------
``post_likes`` is keyed on ``(post_id, user_id)`` - the pair *is* the primary key, and there is no
surrogate identifier beside it - so a second identical like is not a second row. That makes a like
idempotent by construction rather than by remembering to check, and it therefore holds for every
writer: this repository, a migration, a statement typed into ``psql``.

Measured rather than assumed, against PostgreSQL 18.4 through psycopg 3.3.4 and SQLAlchemy 2.0.51:
two identical inserts through ``ON CONFLICT DO NOTHING`` left the row count at **one**. So
``PUT /api/v1/posts/{id}/like`` is safe to retry - a client resending after a timeout, a proxy
duplicating a request, a reader double-clicking - and none of them can inflate a count. That is
what lets the client apply a like optimistically before the response arrives.

The consequence is a prohibition, and it is absolute: **no application-level de-duplication is
written here or anywhere else in this backend.** :meth:`LikeRepository.like` issues one
conflict-ignoring insert and the key decides. There is no pre-flight ``SELECT``, no uniqueness
check, no ``IntegrityError`` branch and no retry loop, and none may be added. Each would be a
second, weaker copy of a rule the database already enforces exactly, and the pre-flight form would
additionally race: a read followed by an insert is two statements with a window between them, and
two concurrent requests can both find nothing.

``preserve_rowcount`` is what makes the boolean honest - measured, not assumed
-----------------------------------------------------------------------------
:meth:`LikeRepository.like` reports whether it *created* a row, which is what lets
``like_service`` answer the request without a second read. The obvious spelling - execute the
insert, compare ``result.rowcount`` to ``1`` - is not sufficient on its own, and it fails
silently. Measured on the stack above:

* Executed with no execution option, the plain ``INSERT ... ON CONFLICT DO NOTHING`` reported
  ``rowcount == -1`` **both** when it inserted a row and when it conflicted. SQLAlchemy memoizes
  ``cursor.rowcount`` for UPDATE and DELETE, where the value is load-bearing; for an INSERT
  carrying no ``RETURNING`` the cursor is soft-closed before the attribute is read, and ``-1`` is
  what a closed cursor yields. Identical behaviour was observed for the Core spelling
  ``pg_insert(PostLike.__table__)``, so this is not an artefact of addressing the mapped class.
* :meth:`LikeRepository.like` would then have returned ``False`` on every call including the
  first - a defect no assertion about the row *count* would catch, because the row is written
  correctly either way. Only the caller's reported state would be wrong.
* Passing ``preserve_rowcount=True`` fixes it at the source, and that was verified in the same
  run: the identical statement then reported ``1`` on the insert and ``0`` on the conflict, with
  exactly one statement emitted and no ``RETURNING`` clause added.

Appending ``.returning(...)`` and counting the returned rows was measured too and also works -
one row, then none. It is deliberately not used: it changes the statement the database executes
in order to serve the caller's bookkeeping, and the point of the conflict-ignoring insert is that
it is the cheapest single write able to express this operation. An execution option changes how
the result is read, which is where the problem actually is.

Both writes pass their option to :meth:`~sqlalchemy.ext.asyncio.AsyncSession.execute` rather than
chaining ``.execution_options()`` onto the statement, matching
``app.repositories.user_repository``. Under mypy 2.3.0 the async ``execute`` is annotated
``-> Result[Any]`` for a DML statement either way - there is no ``UpdateBase -> CursorResult[Any]``
overload on it, unlike its synchronous counterpart - so exactly one narrowing cast is needed, and
:meth:`LikeRepository._affected_row_count` is the single line that carries it. Keeping the cast in
one place is what stops ``Any`` leaking into two public return types.

No pre-flight read, and nothing here decides
--------------------------------------------
Absence is reported as ``False`` (:meth:`~LikeRepository.like` on a repeat,
:meth:`~LikeRepository.unlike` on a like that was never granted,
:meth:`~LikeRepository.exists_for`) or as ``0`` (:meth:`~LikeRepository.count_for_post`). No HTTP
status code is chosen, no framework HTTP exception is constructed and no domain exception is
emitted. A repeated like is ``False``, **not** a ``409``; whether the endpoint answers ``200`` or
something else is ``like_service``'s decision and the router's to serialise.

The service this schema replaces did the opposite. It constructed a framework not-found
exception, status code and detail string included, from inside the data-access loop itself, three
separate times - ``app.py:L31``, ``app.py:L40`` and ``app.py:L49`` - so one policy decision was
written once per call site and no read path could be reused by a caller that wanted a different
answer.

Authority is likewise absent. This module never asks whether the caller may like a post, whether
the post is published, or whether the account is active: ``get_current_user`` resolves the
principal and ``like_service`` judges it. A repository that checked would let the next caller
reach the same rows without the check.

Nothing here commits
--------------------
Every statement below participates in the caller's transaction and none of them ends it. ``get_db``
in ``app/core/dependencies.py`` yields one request-scoped session and rolls it back on an
exception, the service orchestrating a use case owns the commit so liking and its side effects stay
one transaction, and ``backend/tests/conftest.py`` wraps each test in a transaction it rolls back
afterwards. A commit here would break all three at once.

Neither write needs a ``flush()`` either, and that is a property of the spelling rather than an
omission: both are set-based statements issued directly, not ORM instances added to the session, so
the SQL has already reached the database by the time ``execute`` returns. Nothing is returned to
refresh, and no server-generated value is read back - ``created_at`` comes from the database clock
through the column's own ``server_default``, so it is never supplied here and never inspected here.

No cleanup, because the schema already does it
----------------------------------------------
Both foreign keys are ``ON DELETE CASCADE``, so deleting a post removes its likes and deleting an
account removes every like it granted, in the statement PostgreSQL itself issues. There is no
hand-written cleanup in this module and there must never be one: the only ``delete`` below is
:meth:`~LikeRepository.unlike`'s, narrowed to one ``(post_id, user_id)`` pair. A Python copy of the
cascade would be a second definition of one rule, and it is the copy that would drift.

One round trip for the caller's own state
-----------------------------------------
``GET /api/v1/posts/{id}/likes`` returns a count *and* whether the caller has already liked the
post, and :meth:`~LikeRepository.count_and_state` answers both in a single statement:
``count(*)`` beside ``coalesce(bool_or(user_id = :caller), false)``. Two round trips would be the
obvious implementation and are not used - the two answers come from the same rows, so reading them
twice costs a second scan and admits a window in which they disagree.

An anonymous caller takes the plain count instead, and that split is not an optimisation. A
comparison against SQL ``NULL`` is neither true nor false, so a nullable caller folded into the
same predicate would make the aggregate unfalsifiable rather than merely wrong. There is nothing to
compare when nobody is asking, so nothing is compared.

The aggregate form is also what makes the read safe on a post nobody has liked. ``count(*)`` over
no rows is ``0`` and ``bool_or`` over no rows is ``NULL``, which the ``coalesce`` turns into
``false`` - so the statement yields exactly one row whatever the data, which is why
:meth:`~sqlalchemy.engine.Result.one` is correct here rather than
:meth:`~sqlalchemy.engine.Result.one_or_none`. Verified directly: ``(1, True)`` for the account
that liked, ``(1, False)`` for a different account, ``(0, False)`` for a post with no likes at all.

Index alignment
---------------
The store this replaces had no index of any kind, and every addressed operation was a linear scan
in which a miss always traversed the whole collection. Every statement here is served by a named
access path:

* :meth:`~LikeRepository.like`, :meth:`~LikeRepository.unlike` and
  :meth:`~LikeRepository.exists_for` address the whole composite key, so each is a lookup on
  ``pk_post_likes`` - and for the insert that same unique index is what the ``ON CONFLICT`` clause
  arbitrates against.
* :meth:`~LikeRepository.count_for_post` and :meth:`~LikeRepository.count_and_state` filter on
  ``post_id`` alone, which is the key's **leading** column, so ``pk_post_likes`` serves them too
  and no additional index is required for either.
* ``ix_post_likes_user_id`` exists for the opposite direction - the second column of a composite
  key cannot be read from the key's own index - and for the cascade behind a deleted account.

No column is wrapped in a function anywhere below, which is what keeps every one of those
predicates sargable. Both key columns are ``UUID`` compared to ``uuid.UUID`` values, so there is
no cast at the call site either.

Async only, and no relationship is projected
--------------------------------------------
Every statement awaits ``self.session.execute(...)``, SQLAlchemy 2.0 style; there is no legacy
``Query`` and no synchronous path. :attr:`~app.models.like.PostLike.post` and
:attr:`~app.models.like.PostLike.user` are never projected, because nothing here needs an entity -
three of the four methods return a scalar and the fourth returns a pair. Were that ever to change,
the relationship would have to be requested in the statement with
:func:`~sqlalchemy.orm.selectinload` or :func:`~sqlalchemy.orm.joinedload`: under an
``AsyncSession`` a lazy load raises ``MissingGreenlet`` at the point of access.

What is deliberately not here
-----------------------------
* **A bulk ``counts_for_posts(post_ids)`` aggregate.** The feed's post summary exposes no like
  count, and the count is its own endpoint, so there is no caller for a batched form. Adding one
  speculatively would invite a feed that fans out per card.
* **A "posts this account liked" listing.** ``ix_post_likes_user_id`` makes it cheap and no
  endpoint in the API surface asks for it, so it is not written.
* **A global like total.** The administrative overview counts users, posts, comments and
  categories; likes are not among them.
* **A stored counter.** Two writes to keep in step - and a third for every cascading delete - in
  exchange for an aggregate that a leading-column index already answers in one statement.
* **Any de-duplication, retry, or ``IntegrityError`` handling.** See the first section: the key is
  the guarantee.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from typing import Any, Final, cast

from sqlalchemy import CursorResult, UpdateBase, delete, false, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.models.like import PostLike
from app.repositories.base import BaseRepository

__all__ = ["LikeRepository"]

_CONFLICT_TARGET: Final[list[str]] = ["post_id", "user_id"]
"""The columns ``ON CONFLICT`` arbitrates on, named in primary-key order.

Written as column *names* rather than as mapped attributes because that is what
``on_conflict_do_nothing(index_elements=...)`` renders into the clause, and stating both of them -
rather than relying on the table's sole unique index being found - is what makes the arbitration
explicit: this insert yields to ``pk_post_likes`` and to nothing else. The order matches the
primary key declared in :class:`~app.models.like.PostLike`, so the emitted
``ON CONFLICT (post_id, user_id)`` reads the same way the schema does.
"""

_INSERT_EXECUTION_OPTIONS: Final[Mapping[str, Any]] = {"preserve_rowcount": True}
"""Execution options for the conflict-ignoring insert.

``preserve_rowcount`` is mandatory rather than defensive: without it the INSERT's cursor is
soft-closed before ``rowcount`` is read and the attribute reports ``-1`` whether a row was inserted
or a conflict was ignored, so :meth:`LikeRepository.like` would report ``False`` on every call.
The module docstring records the measurement. ``synchronize_session`` is deliberately absent - it
governs how a bulk UPDATE or DELETE reconciles the identity map, and an INSERT has nothing to
reconcile.
"""

_DELETE_EXECUTION_OPTIONS: Final[Mapping[str, Any]] = {"synchronize_session": False}
"""Execution options for the targeted delete.

``synchronize_session=False`` keeps the statement from walking the identity map to expire objects
the session is not holding; this repository loads no ``PostLike`` instance, so there is never
anything to synchronise. The corollary is that an instance loaded before the call keeps its stale
state until it is refreshed, which is exactly why removal is a narrowed statement here rather than
an ORM delete of a loaded row.

``preserve_rowcount`` is deliberately absent: SQLAlchemy memoizes ``cursor.rowcount`` for UPDATE
and DELETE unconditionally, which was confirmed by observing ``1`` then ``0`` from two consecutive
executions without the option.
"""


class LikeRepository(BaseRepository[PostLike]):
    """Data access for the ``post_likes`` relation, keyed on ``(post_id, user_id)``.

    Constructed per request from the session ``get_db`` yielded, and consumed only by
    ``app.services.like_service``::

        repository = LikeRepository(session)

        # PUT /api/v1/posts/{id}/like - idempotent, and the boolean says which happened.
        created = await repository.like(post_id=post.id, user_id=principal.id)

        # GET /api/v1/posts/{id}/likes - one statement, count and caller state together.
        total, liked_by_caller = await repository.count_and_state(post.id, user_id=principal.id)

    Two inherited members do the work of two of the five methods below, and neither is
    re-implemented here. :meth:`~app.repositories.base.BaseRepository.count` already emits
    ``SELECT count(*) FROM post_likes WHERE ...`` and coalesces its result, which is exactly what
    :meth:`count_for_post` needs; :meth:`~app.repositories.base.BaseRepository.exists` already
    emits ``SELECT EXISTS (SELECT 1 FROM post_likes WHERE ...)`` without constructing an entity,
    which is exactly what :meth:`exists_for` needs. Both are scoped by ``select_from(self.model)``,
    and :attr:`model` is this relation, so neither has to be bent to a table it was not written
    for. :meth:`~app.repositories.base.BaseRepository.delete` remains available for the case where
    a service already holds a loaded instance.

    Three operations the other five repositories have are **absent from this class entirely**,
    and their absence is the reason it extends
    :class:`~app.repositories.base.BaseRepository` rather than
    :class:`~app.repositories.base.UUIDPrimaryKeyRepository`. All three presuppose a single
    surrogate key, ``post_likes`` has none, and each would fail in a different and worse way:

    * ``get_by_id`` takes one UUID where this mapper expects two, so a call would type-check and
      then raise at runtime. Lookups here are keyed by the pair instead - :meth:`exists_for`
      when only presence matters, and
      :meth:`~app.repositories.base.BaseRepository.get_or_none` with both predicates when a
      service genuinely needs the row.
    * ``delete_by_id`` inherits that same misuse, and the bulk form it deliberately avoids
      would derive the *first* key column - ``post_id`` - and delete **every** like on a post.
      :meth:`unlike` states both predicates instead.
    * ``add`` persists an ORM instance and refreshes it, which would defeat the whole design of
      :meth:`like`: liking goes through a conflict-ignoring insert precisely so that a repeat is
      absorbed by the key rather than raising, and a second ``add`` would raise instead.

    Documenting them as inapplicable is not the same as their not being there, which is why the
    generic base was split: on this class the three names simply do not resolve, so each mistake
    is a type error at the call site rather than an ``IntegrityError``, a runtime failure, or a
    mass deletion in production.

    Instances are cheap, hold no cached state and are exactly as concurrency-safe as the
    ``AsyncSession`` they wrap - which is to say they must not be shared between concurrent tasks,
    because an ``AsyncSession`` is one unit of work over one connection.
    """

    model = PostLike
    """The mapped class this repository reads and writes.

    Satisfies the ``model: type[ModelT]`` contract :class:`~app.repositories.base.BaseRepository`
    declares, and is what the inherited :meth:`~app.repositories.base.BaseRepository.count` and
    :meth:`~app.repositories.base.BaseRepository.exists` resolve their ``FROM`` clause against -
    which is what lets :meth:`count_for_post` and :meth:`exists_for` delegate to them unchanged.
    """

    async def like(self, *, post_id: uuid.UUID, user_id: uuid.UUID) -> bool:
        """Record that an account likes a post, absorbing a repeat rather than failing on it.

        The write behind ``PUT /api/v1/posts/{id}/like``. Exactly one statement is emitted -
        ``INSERT INTO post_likes (post_id, user_id) VALUES (..., ...)
        ON CONFLICT (post_id, user_id) DO NOTHING`` - and there is deliberately no ``SELECT``
        before it. The composite primary key is what makes the operation idempotent, so a repeat
        is absorbed by the database and the returned boolean simply reports which of the two
        outcomes occurred.

        Args:
            post_id: The post being liked. Keyword-only, because ``(post_id, user_id)`` are two
                arguments of the same type and a positional call site could transpose them
                silently - the transposed pair is a perfectly valid row, so nothing would fail
                loudly.
            user_id: The account granting the like, resolved from the bearer token by
                ``get_current_user`` before it reaches this layer. This module does not judge
                whether that account is entitled to like anything.

        Returns:
            ``True`` when this call created the like, ``False`` when it already existed. That
            distinction is why the method returns anything at all: it lets ``like_service`` answer
            the request without a second read, and it is the *only* place the information is
            available - after the statement, the two cases are indistinguishable in the data.

        Note:
            ``created_at`` is not supplied. The column carries ``server_default=now()``, so the
            instant comes from the database clock and two likes written by different workers are
            ordered by one clock rather than by however many application clocks were involved.

            A repeat is not an error and must not be turned into one here. No ``IntegrityError``
            can be raised for it to catch - the ``ON CONFLICT`` clause is what prevents the
            violation rather than recovering from it - and whether a repeat means ``200``,
            ``204`` or something else is a decision for the layer that knows what a client is.

            Foreign keys are still enforced: liking a post or as an account that does not exist
            raises a foreign-key violation at this statement. That is correct, and it is not
            pre-checked here - ``like_service`` resolves the post before calling, so the violation
            is unreachable through the API and remains a genuine invariant failure if it ever
            fires.
        """
        return (
            await self._affected_row_count(
                pg_insert(PostLike)
                .values(post_id=post_id, user_id=user_id)
                .on_conflict_do_nothing(index_elements=_CONFLICT_TARGET),
                execution_options=_INSERT_EXECUTION_OPTIONS,
            )
            == 1
        )

    async def unlike(self, *, post_id: uuid.UUID, user_id: uuid.UUID) -> bool:
        """Withdraw an account's like of a post, treating a missing like as a no-op.

        The write behind ``DELETE /api/v1/posts/{id}/like``. One statement, narrowed to the whole
        composite key so that at most one row can match: removing a like that was never granted
        deletes nothing and returns ``False``. It is not an error, and it is not raised as one -
        the end state a client asked for is the end state it gets either way, which makes this
        request as safely retryable as :meth:`like`.

        Args:
            post_id: The post whose like is being withdrawn. Keyword-only for the same reason as
                in :meth:`like`: a transposed pair would be a valid row rather than a loud
                failure.
            user_id: The account withdrawing its own like. Which account that is has already been
                decided by ``get_current_user``; this module does not check that a caller may only
                unlike on its own behalf, because a repository cannot know who is calling.

        Returns:
            ``True`` when a like existed and was removed, ``False`` when there was nothing to
            remove.

        Note:
            Both predicates are stated. A statement keyed on ``post_id`` alone would delete every
            like on the post, which is the specific hazard
            :meth:`~app.repositories.base.BaseRepository.delete_by_id` documents for composite
            keys - and it would report a plausible-looking row count while doing it.

            Nothing cascades from a like, so this statement has no dependents to consider. The
            cascade runs in the other direction: deleting the post or the account removes the row
            through ``ON DELETE CASCADE``, which is why this is the only ``delete`` in the module.
        """
        return (
            await self._affected_row_count(
                delete(PostLike).where(PostLike.post_id == post_id, PostLike.user_id == user_id),
                execution_options=_DELETE_EXECUTION_OPTIONS,
            )
            == 1
        )

    async def count_for_post(self, post_id: uuid.UUID) -> int:
        """Count how many accounts have liked one post.

        The figure the post page renders beside its like control, and what
        :meth:`count_and_state` falls back to for an anonymous caller. Delegates to
        :meth:`~app.repositories.base.BaseRepository.count`, which emits
        ``SELECT count(*) FROM post_likes WHERE post_id = :post_id`` and coalesces its result, so
        the aggregate is written once for the whole codebase rather than once per relation.

        Args:
            post_id: The post whose likes are being counted. Positional, unlike the pair-taking
                methods: there is only one argument, so nothing can be transposed.

        Returns:
            The number of likes; ``0`` for a post nobody has liked, which is the ordinary state of
            a newly published post rather than a special case.

        Note:
            ``post_id`` is the **leading** column of ``pk_post_likes``, so this count is served by
            the primary key's own index and needs no additional one.

            The count is derived, never stored. A counter column would have to be kept in step by
            every like, every unlike and every cascading delete of a post or an account - three
            writers, one of which is PostgreSQL itself and cannot be intercepted - in exchange for
            an aggregate an index already answers in one statement.
        """
        return await self.count(PostLike.post_id == post_id)

    async def exists_for(self, *, post_id: uuid.UUID, user_id: uuid.UUID) -> bool:
        """Report whether one account has liked one post, without loading the row.

        A primary-key probe: both key columns are constrained, so at most one row can match.
        Delegates to :meth:`~app.repositories.base.BaseRepository.exists`, which emits
        ``SELECT EXISTS (SELECT 1 FROM post_likes WHERE ...)`` - PostgreSQL stops at the first
        match, no entity is constructed, no identity-map entry is created and no column payload
        crosses the wire.

        Args:
            post_id: The post to probe. Keyword-only, as in :meth:`like` and :meth:`unlike`.
            user_id: The account to probe for.

        Returns:
            ``True`` when that account has liked that post, ``False`` otherwise. Never ``None``:
            the ``EXISTS`` form always yields exactly one row.

        Note:
            Prefer :meth:`count_and_state` whenever the count is wanted too - it answers both
            questions in one statement, and calling this method beside a separate count is two
            round trips for information that comes from the same rows.

            :meth:`like` does **not** call this method, and must not. A probe followed by an
            insert is two statements with a window between them, which is the race the composite
            key exists to make irrelevant; the conflict-ignoring insert already reports whether it
            created the row.
        """
        return await self.exists(PostLike.post_id == post_id, PostLike.user_id == user_id)

    async def count_and_state(
        self, post_id: uuid.UUID, *, user_id: uuid.UUID | None = None
    ) -> tuple[int, bool]:
        """Return a post's like count together with whether one caller is among the likers.

        Everything ``GET /api/v1/posts/{id}/likes`` needs, in one round trip. For an authenticated
        caller the statement is ``SELECT count(*), coalesce(bool_or(user_id = :user_id), false)
        FROM post_likes WHERE post_id = :post_id`` - both answers from one pass over the same
        rows, so they cannot disagree with each other the way two separate reads could.

        Args:
            post_id: The post being asked about. Positional, matching :meth:`count_for_post`,
                because it is the subject of the question rather than one of a pair.
            user_id: The calling account, or ``None`` for an anonymous caller. Keyword-only so a
                call site cannot pass an account where the post belongs. Supplying it asks a
                question *about* that account; it grants nothing and checks nothing.

        Returns:
            ``(count, liked_by_caller)``. ``count`` is ``0`` for a post nobody has liked, and
            ``liked_by_caller`` is ``False`` both when the caller has not liked the post and
            whenever ``user_id`` is ``None`` - an anonymous visitor has no like to report.

        Note:
            The anonymous branch issues the plain count and pairs it with ``False``; it does not
            fold a nullable value into the predicate. Comparing anything to SQL ``NULL`` yields
            ``NULL`` rather than false, so ``bool_or`` over a post's rows would return ``NULL``
            for an anonymous caller and the ``coalesce`` would flatten that to ``false`` - the
            right answer arrived at by accident, through an aggregate that can no longer
            distinguish "nobody is asking" from "the caller has not liked this". There is nothing
            to compare when nobody is asking, so nothing is compared, and the emitted SQL carries
            no bound ``NULL``.

            Both branches emit exactly one statement, and the aggregate branch always yields
            exactly one row: ``count(*)`` over no rows is ``0``, and ``bool_or`` over no rows is
            ``NULL``, which the ``coalesce`` turns into ``false``. That is why
            :meth:`~sqlalchemy.engine.Result.one` is correct here and
            :meth:`~sqlalchemy.engine.Result.one_or_none` would only obscure a result that cannot
            be absent.

            ``false()`` is used rather than a Python ``False`` so the default renders as the SQL
            literal instead of a bound parameter, keeping the statement's text independent of its
            arguments. Both members of the row are converted explicitly: SQLAlchemy types an
            aggregate's row members as ``Any``, and this method's signature promises
            ``tuple[int, bool]``.
        """
        if user_id is None:
            return await self.count_for_post(post_id), False

        result = await self.session.execute(
            select(
                func.count(),
                func.coalesce(func.bool_or(PostLike.user_id == user_id), false()),
            ).where(PostLike.post_id == post_id)
        )
        row = result.one()
        return int(row[0]), bool(row[1])

    async def _affected_row_count(
        self, statement: UpdateBase, *, execution_options: Mapping[str, Any]
    ) -> int:
        """Execute one set-based write and report how many rows it actually touched.

        The single place this module reads ``rowcount``, shared by :meth:`like` and
        :meth:`unlike` so that the narrowing cast below is written once instead of twice.

        Args:
            statement: A fully composed ``INSERT`` or ``DELETE`` over
                :class:`~app.models.like.PostLike`, ready to execute.
            execution_options: :data:`_INSERT_EXECUTION_OPTIONS` or
                :data:`_DELETE_EXECUTION_OPTIONS`. Passed to
                :meth:`~sqlalchemy.ext.asyncio.AsyncSession.execute` rather than chained onto the
                statement, matching ``app.repositories.user_repository``; each mapping documents
                at its own definition why its option is required and why the other one is not.

        Returns:
            The number of rows the statement affected: ``1`` or ``0`` for both callers, since each
            addresses the whole composite key and so can match at most one row.

        Note:
            The cast is honest rather than convenient. At runtime the result of a DML statement is
            a :class:`~sqlalchemy.CursorResult`; it is
            :meth:`~sqlalchemy.ext.asyncio.AsyncSession.execute` that is annotated less precisely
            than its synchronous counterpart - inspected against SQLAlchemy 2.0.51 under mypy
            2.3.0, it resolves a DML statement to ``Result[Any]``, which declares no ``rowcount``,
            with no ``UpdateBase -> CursorResult[Any]`` overload to match instead. Narrowing here
            confines that one gap to a single line.

            No ``flush()`` follows. These are statements rather than pending ORM instances, so the
            SQL has already been sent; and no ``commit()`` follows either, because the transaction
            belongs to the caller.
        """
        result = await self.session.execute(statement, execution_options=execution_options)
        return cast("CursorResult[Any]", result).rowcount
