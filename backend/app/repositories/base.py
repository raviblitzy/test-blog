"""The generic, session-bound repositories that every concrete repository in this service extends.

``app.repositories`` is the only layer in the backend that builds a SQL statement, and this
module is the only place in that layer that builds a *generic* one. Everything here is
mechanics with nothing to say about a particular relation - fetch one row by its surrogate
key, ask whether any row matches, count the matches, persist an instance, remove one, window
a caller's statement - so that the concrete repositories which subclass it hold only the
queries that are genuinely about their own relation. ``post_repository`` in particular stays
the single home of feed composition: relevance ranking, category joins, author filtering,
status scoping, ordering.

Two base classes, split on key shape
------------------------------------
:class:`BaseRepository` holds what is true of any mapped class: the session binding, a
criteria lookup, existence, counting, saving and deleting a loaded instance, and windowing.
:class:`UUIDPrimaryKeyRepository` adds the three operations that presuppose a *single*
surrogate primary key - :meth:`~UUIDPrimaryKeyRepository.get_by_id`,
:meth:`~UUIDPrimaryKeyRepository.add` and
:meth:`~UUIDPrimaryKeyRepository.delete_by_id`.

The split follows the schema exactly. Five relations carry
``app.db.base.UUIDPrimaryKeyMixin`` - ``users``, ``refresh_tokens``, ``categories``,
``posts``, ``comments`` - and their repositories extend the subclass. ``post_likes`` is keyed
``(post_id, user_id)``, so ``LikeRepository`` extends :class:`BaseRepository` directly and
none of those three appears on it at all. That is the point of separating them rather than
documenting them as inapplicable: a single-UUID lookup against a composite key is a runtime
failure that a type checker cannot see, and an ORM ``add`` against ``post_likes`` bypasses
the conflict-ignoring insert that makes liking idempotent. Removing them from the surface
turns both mistakes into type errors at the call site.

A subclass names its base according to the relation it maps, and nothing else changes::

    class PostRepository(UUIDPrimaryKeyRepository[Post]):  # id-keyed
        model = Post


    class LikeRepository(BaseRepository[PostLike]):  # (post_id, user_id)-keyed
        model = PostLike

The defect this module retires
------------------------------
The service this repository grew out of kept every record in a module-level Python list and
wrote the same identity predicate three separate times, once per handler that needed it::

    for item in items:                     # app.py:L28-29, read one
        if item.id == item_id:
    for index, item in enumerate(items):   # app.py:L36-37, update
        if item.id == item_id:
    for index, item in enumerate(items):   # app.py:L45-46, delete
        if item.id == item_id:

Each of those handlers also mutated the module global directly - ``items.append(item)`` at
``app.py:L17``, ``items[index] = updated_item`` at ``L38``, ``items.pop(index)`` at ``L47`` -
so there was no repository, no data-access object, no accessor and no injected provider
anywhere in the service. :meth:`UUIDPrimaryKeyRepository.get_by_id` is that predicate,
written once for the whole codebase, and no sibling repository may re-implement a
by-primary-key fetch. That
is a structural objective of the restructure rather than a stylistic preference: a predicate
with exactly one definition is tested once and is then correct everywhere.

What this module returns, and what it deliberately does not
-----------------------------------------------------------
:meth:`BaseRepository.paginate` returns a plain ``(rows, total)`` tuple. It does **not** return
the ``Page`` model, and this module does not import ``app/core/pagination.py`` at all.

That resolves a documented coordination conflict, and the resolution is recorded here so it is
not re-opened later. ``app/core/pagination.py`` describes itself as the module through which
this one "assembles its windowed results"; it is not. ``Page`` is a Pydantic response model - a
wire shape - and keeping wire shapes out of the data layer is exactly what layered separation
requires. The service layer owns the conversion: it projects
the rows into their response models and calls ``build_page(items, total, page, page_size)``
to produce the five-field envelope (``items``, ``total``, ``page``, ``page_size``, ``pages``)
that every list endpoint serialises. ``build_page`` takes a ``list``, so a service passes
``list(rows)``.

Nothing here raises. Absence is reported as ``None``
(:meth:`~UUIDPrimaryKeyRepository.get_by_id`, :meth:`~BaseRepository.get_or_none`), as
``False`` (:meth:`~BaseRepository.exists`, :meth:`~UUIDPrimaryKeyRepository.delete_by_id`),
as ``0`` (:meth:`~BaseRepository.count`) or as an
empty sequence (:meth:`~BaseRepository.paginate`). No HTTP status code is chosen, no framework
HTTP exception is constructed and no domain exception is emitted, because a repository cannot
know whether a missing row is a ``404``, a ``403`` in disguise, or an entirely legitimate empty
result. Services translate. Nothing here logs either: request correlation is bound once by
``app/middleware/request_context.py`` and the services are what log against it, so a logging
repository would only duplicate the context it was handed.

Nothing here commits
--------------------
Nothing in this module commits, and nothing anywhere in this package may. Three collaborators
depend on that. ``get_db`` in ``app/core/dependencies.py`` yields one request-scoped session,
rolls it back on an exception and always closes it. The service that orchestrates a use case
owns the commit, so a multi-step operation stays a single transaction. And
``backend/tests/conftest.py`` wraps each test in a transaction it rolls back afterwards. A
repository that committed would break all three at once: partial writes would survive a failed
request, and test data would leak between tests - which is how a blocking coverage gate becomes
flaky.

``flush()`` is what is used instead, and it is the right tool. It emits the INSERT, UPDATE or
DELETE so the database assigns identity and applies its defaults and constraints, while
leaving the enclosing transaction open for the caller to commit or abandon. A constraint
violation therefore surfaces at the write that caused it rather than at some later commit,
pointing at the right line.

Why the writes refresh - measured, not assumed
----------------------------------------------
``app/db/session.py`` builds its factory with ``expire_on_commit=False`` and ``autoflush=True``,
and ``app/db/base.py`` makes identity and audit values *server*-generated:
``gen_random_uuid()`` for ``id``, ``now()`` for ``created_at`` and ``updated_at``. Two things
follow, and only one of them is what the folklore says:

* After an **INSERT** nothing is left expired. Measured against PostgreSQL 18.4 through
  psycopg 3.3.4, SQLAlchemy 2.0.51 emits ``INSERT ... RETURNING id, created_at, updated_at``
  and the instance arrives with every server-generated value already loaded -
  ``inspect(entity).unloaded`` was empty. :meth:`~UUIDPrimaryKeyRepository.add`'s ``refresh`` is
  therefore defensive: it costs one SELECT and buys independence from the dialect's RETURNING
  support and from SQLAlchemy's eager-defaults heuristics, so the postcondition "the returned
  entity is fully loaded" holds by construction rather than by luck.
* After an **UPDATE**, values the database re-derives *are* left expired, and touching one
  under an async session raises ``MissingGreenlet: greenlet_spawn has not been called``.
  Measured on the same stack for a row carrying a generated column: immediately after the
  flush ``inspect(entity).unloaded`` was ``['search_vector', 'updated_at']`` and reading
  either raised. ``posts.search_vector`` is precisely such a column - PostgreSQL regenerates
  it on every write - so :meth:`~BaseRepository.save`'s ``refresh`` is not optional. Without
  it the failure does not happen here; it happens later, when the response serialiser touches
  ``updated_at``, and the request dies at the boundary with a traceback pointing at the wrong
  layer.

No lazy loading, anywhere in this package
-----------------------------------------
This module loads no relationship - it has no relation to load one from - but the rule it
states governs every subclass, because a subclass is where relationship loading is decided.
Under an async session, reading an unloaded relationship attribute raises ``MissingGreenlet``,
so every projected relationship must be requested in the statement itself:

* :func:`~sqlalchemy.orm.selectinload` for collections. Preferred, and the default choice: it
  issues one additional SELECT keyed on the parent primary keys, so it multiplies no rows and
  :meth:`~BaseRepository.paginate` needs no de-duplication.
* :func:`~sqlalchemy.orm.joinedload` for many-to-one references, where at most one row can
  match and the LEFT OUTER JOIN cannot fan out.

``joinedload`` against a *collection* is the one case needing care: it multiplies result rows,
so such a caller must ``.unique()`` its result before ``.all()`` and must supply an explicit
``count_stmt`` to :meth:`~BaseRepository.paginate`, because the row count that join produces
is not the count of entities. Preferring ``selectinload`` discharges both obligations at once,
which is why it is the convention. ``Base`` also exposes ``awaitable_attrs`` as a safety
valve, but it costs a round trip per access and reproduces the N+1 pattern this layer exists
to avoid.

Why the class declares its own type parameter
---------------------------------------------
:class:`BaseRepository` is written with PEP 695 type-parameter syntax -
``class BaseRepository[ModelT: Base]`` - rather than by subclassing ``Generic``. That is a
hard toolchain requirement rather than a preference: ``backend/pyproject.toml`` sets ruff's
``target-version`` to ``py314``, which activates ``UP046``, and the ``Generic[ModelT]``
spelling fails ``ruff check`` with *"Generic class uses ``Generic`` subclass instead of type
parameters"*. Verified against the pinned ruff 0.16.1, and ``ruff check`` is a blocking gate, so
the ``Generic`` spelling is simply not available. ``app/core/pagination.py`` declares ``Page``
and ``build_page`` the same way, so this is the established form for generic code in this
backend.

:data:`ModelT` is nevertheless declared and exported at module scope, so a downstream module
needing a type variable with the same ``Base`` bound has one to import rather than one to
invent. The class does not use it - it cannot, since its own parameter is scoped to the class
- and the two never interact.

What is deliberately not here
-----------------------------
No engine and no session factory. Repositories are *session-bound*: one is constructed with
an :class:`~sqlalchemy.ext.asyncio.AsyncSession` and never creates, configures or disposes
one, so this module does not import ``app/db/session.py``. Importing it would tie the data
layer to connection lifecycle and, because that module builds the engine at import time, would
hand every ``alembic check`` an engine nobody asked for.

No dependency injection and no request. ``app/core/dependencies.py`` imports FastAPI and sits
*above* this layer; importing it here would invert the dependency arrow and drag HTTP into the
data layer. Nothing in this package knows that a request exists.

No entity-specific behaviour: no relation, no column, no ownership rule, no publish
transition, no moderation state, no slug derivation. Authority is a service concern, and a
repository that checked it would let the next caller reach the same rows without the check.

No cache, and no ``get_or_404``. No manual cascade either - the schema's ``ON DELETE CASCADE``
on ``comments``, ``post_likes``, ``post_categories`` and ``refresh_tokens`` owns that, and
re-implementing it in Python would give one rule two definitions to keep in step. And no
pre-validation of a unique index or of the ``posts`` publication check constraint: the database
enforces both, and a Python pre-check is a race condition wearing a guard's uniform.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import TypeVar

from sqlalchemy import ColumnExpressionArgument, Select, func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import Base

__all__ = ["BaseRepository", "ModelT", "UUIDPrimaryKeyRepository"]

ModelT = TypeVar("ModelT", bound=Base)
"""A type variable carrying the declarative base as its bound.

Exported for downstream generic code that needs a module-scoped type variable over mapped
classes. :class:`BaseRepository` does **not** use it: the class declares its own parameter
with PEP 695 syntax because ruff's ``UP046`` rejects the ``Generic[ModelT]`` spelling under
this project's configuration - see the module docstring. Anything written in that PEP 695
style declares its parameters inline and needs nothing from here; this binding exists so the
choice is available rather than reinvented, and so the bound is stated in exactly one place.
"""


class BaseRepository[ModelT: Base]:
    """Key-shape-agnostic data-access helpers over one mapped class, bound to one unit of work.

    Everything here works whatever a relation's primary key looks like: a criteria lookup,
    existence, counting, saving and deleting an instance the caller already holds, and
    windowing a statement. A concrete repository parameterises it with its relation, names
    that relation once, and adds only the queries that relation actually needs::

        from collections.abc import Sequence

        from sqlalchemy import select

        from app.models.post import Post
        from app.repositories.base import UUIDPrimaryKeyRepository


        class PostRepository(UUIDPrimaryKeyRepository[Post]):
            model = Post

            async def list_recent(self, limit: int, offset: int) -> tuple[Sequence[Post], int]:
                stmt = select(Post).order_by(Post.published_at.desc())
                return await self.paginate(stmt, limit=limit, offset=offset)

    Note which base that example names. Five of this service's six relation-bound repositories
    extend :class:`UUIDPrimaryKeyRepository`, which adds the three operations that presuppose a
    single surrogate key, because their relations carry ``app.db.base.UUIDPrimaryKeyMixin``. Extend
    **this** class directly only when the relation has no single-column identity, which in this
    schema means ``post_likes`` alone - see the module docstring for why that distinction is
    enforced by the class hierarchy rather than described in prose.

    One repository extends neither, and it is the exception that proves the rule rather than a
    counter-example to it: ``app.repositories.health_repository`` issues the readiness statement,
    which reads no table, so it has no ``model`` to declare and not one helper here would apply to
    it. Everything in this class is written for a mapped class; a repository without one has no
    business inheriting it.

    Two invariants must not be violated, here or in any subclass:

    * **No commit.** Every write ends at ``flush()``. The service orchestrating the use case
      decides when the transaction ends; the module docstring names the three collaborators
      that depend on that.
    * **No HTTP artefact.** No status code, no framework HTTP exception, no domain exception,
      no logging. Absence is ``None``, ``False``, ``0`` or an empty sequence, and the layer
      above decides what that means to a client.

    Instances are cheap and meant to be short-lived: construct one per request from the session
    ``get_db`` yielded and let it fall out of scope with the request. Nothing is cached on the
    instance, so a repository is exactly as concurrency-safe as the ``AsyncSession`` it holds -
    which is to say it must not be shared between concurrent tasks, because an ``AsyncSession``
    is one unit of work over one connection.
    """

    session: AsyncSession
    """The unit of work every statement in this repository is issued through.

    Assigned once in :meth:`__init__` and never rebound. Subclasses read it to execute the
    statements they compose; nothing in this package closes, commits or replaces it.
    """

    model: type[ModelT]
    """The mapped class this repository reads and writes.

    Declared here as a contract and assigned by each subclass at class level
    (``model = Post``). Deliberately not a constructor parameter: the pairing of a repository
    with its relation is fixed when the repository is written, and accepting it at runtime
    would let a caller point ``PostRepository`` at ``users``.

    A subclass that omits it fails on first use with ``AttributeError``, which is immediate and
    unambiguous. It is not validated in ``__init_subclass__`` on purpose: an intermediate
    abstract repository is a legitimate thing to write, and an import-time check would forbid
    that for no benefit the first test run does not already deliver.
    """

    def __init__(self, session: AsyncSession) -> None:
        """Bind this repository to one unit of work.

        Args:
            session: The request-scoped :class:`~sqlalchemy.ext.asyncio.AsyncSession` every
                statement is issued through. Supplied by the caller - in the API tier that is
                ``get_db`` in ``app/core/dependencies.py``, and in the suite the transactional
                fixture in ``backend/tests/conftest.py``. It is stored and nothing more: never
                replaced,
                never created here, never closed here, and never committed.
        """
        self.session = session

    async def get_or_none(self, *criteria: ColumnExpressionArgument[bool]) -> ModelT | None:
        """Fetch the first row matching arbitrary criteria, or ``None``.

        The lookup a natural key needs - a user by email, a post by slug, a category by slug, a
        like by its composite key - where the column is unique but is not the primary key.

        Args:
            *criteria: SQL boolean expressions, combined with ``AND``. Written as comparisons on
                the mapped class, for example ``User.email == email``. Passing none is legal and
                returns an arbitrary row, which is only ever useful in a test.

        Returns:
            The first matching entity, or ``None`` when nothing matches.

        Note:
            ``LIMIT 1`` is applied, so two matching rows are not an error and the query never
            fetches more than it returns. Uniqueness is the database's job - the ``citext``
            unique indexes on ``users.email``, ``users.username``, ``posts.slug`` and
            ``categories.slug`` enforce it case-insensitively - so this method reports what it
            found rather than asserting an invariant that is guaranteed a layer below.
        """
        result = await self.session.execute(select(self.model).where(*criteria).limit(1))
        return result.scalars().first()

    async def exists(self, *criteria: ColumnExpressionArgument[bool]) -> bool:
        """Report whether any row matches, without loading one.

        Emits ``SELECT EXISTS (SELECT 1 FROM <table> WHERE ...)``, so PostgreSQL stops at the
        first match, no entity is constructed, no identity-map entry is created and no column
        payload crosses the wire. Prefer it to ``await self.get_or_none(...) is not None``
        whenever the row itself is not wanted - the difference is material for wide relations
        such as ``posts``, whose row carries the whole body and the search vector.

        Args:
            *criteria: SQL boolean expressions, combined with ``AND``.

        Returns:
            ``True`` if at least one row matches, ``False`` otherwise. Never ``None``: the
            ``EXISTS`` form always yields exactly one row.
        """
        probe = select(literal(True)).select_from(self.model).where(*criteria)
        result = await self.session.execute(select(probe.exists()))
        return bool(result.scalar())

    async def count(self, *criteria: ColumnExpressionArgument[bool]) -> int:
        """Count the rows matching arbitrary criteria.

        Backs the aggregate figures the administrative overview screen shows, and any standalone
        total a service needs. It is *not* how :meth:`paginate` derives its total - that count
        is built from the caller's own statement so the two filter sets cannot drift apart.

        Args:
            *criteria: SQL boolean expressions, combined with ``AND``. Passing none counts the
                whole relation.

        Returns:
            The number of matching rows; ``0`` when nothing matches. ``COUNT`` cannot produce
            SQL ``NULL`` in this shape, but the result is coalesced anyway so the signature is
            honest: callers get ``int``, never ``int | None``.
        """
        result = await self.session.execute(
            select(func.count()).select_from(self.model).where(*criteria)
        )
        matched = result.scalar()
        return 0 if matched is None else matched

    async def save(self, entity: ModelT) -> ModelT:
        """Flush pending changes to an already-persistent instance and reload it.

        What a service calls after assigning new attribute values - the ``PATCH
        /api/v1/users/me`` and ``PATCH /api/v1/posts/{id}`` paths, and the publish, unpublish and
        moderation transitions. There is deliberately no field list and no dictionary of
        changes: the session already knows which attributes are dirty, and re-describing them
        here would be a second source of truth for the same information.

        The ``refresh()`` is mandatory rather than defensive. After an UPDATE, PostgreSQL
        re-derives ``updated_at`` and the generated ``posts.search_vector``, SQLAlchemy expires
        both, and reading either under an async session raises ``MissingGreenlet``. The module
        docstring records that measurement.

        Args:
            entity: A persistent instance of :attr:`model`, already mutated in place.

        Returns:
            The same instance with every attribute reloaded from the database.

        Note:
            Calling this on an unmodified instance is harmless: the flush finds nothing to emit
            and the refresh simply re-reads the row. ``updated_at`` is stamped from ``now()``,
            which PostgreSQL evaluates once per transaction, so two writes inside one
            transaction legitimately share an instant.
        """
        await self.session.flush()
        await self.session.refresh(entity)
        return entity

    async def delete(self, entity: ModelT) -> None:
        """Remove a persistent instance.

        Dependent rows are **not** removed here, and that is the design. Every foreign key in
        the schema that should follow its parent declares ``ON DELETE CASCADE`` - ``comments``,
        ``post_likes`` and ``post_categories`` behind a post, and a user's posts, comments,
        likes and refresh tokens behind a user - so deleting a post takes its comments and likes
        with it in the statement the database itself issues. Re-implementing that here would
        give one rule two definitions to keep in step, and the Python copy is the one that would
        drift.

        Args:
            entity: A persistent instance of :attr:`model`.

        Note:
            The delete is flushed, so a foreign key that forbids the removal fails at this call
            rather than at commit. The transaction stays open either way, so the service can
            still abandon the whole operation.
        """
        await self.session.delete(entity)
        await self.session.flush()

    async def paginate(
        self,
        stmt: Select[tuple[ModelT]],
        *,
        limit: int,
        offset: int,
        count_stmt: Select[tuple[int]] | None = None,
    ) -> tuple[Sequence[ModelT], int]:
        """Window a caller's statement and count everything that statement matches.

        The one primitive behind every list surface in the API - the home feed, an author's
        published posts, the author workspace and each administrative table - so all of them
        window identically and the client can share a single pagination component. Two
        statements are executed: the count first, then the window. They are two *snapshots* as
        well as two statements, which the note below states precisely rather than glosses.

        Args:
            stmt: The fully composed ``SELECT`` over :attr:`model`, with filters, joins, loader
                options and ordering already applied by the caller, which is the only party that
                knows what the surface means. It must carry no ``LIMIT`` or ``OFFSET`` - the
                window is applied here. It is never mutated: SQLAlchemy statements are
                generative, so the windowed form is a new object and the caller's stays
                reusable.
            limit: Rows per page. Zero or negative yields no rows rather than an invalid
                ``LIMIT``; see the note below.
            offset: Rows to skip. A negative value is clamped to ``0``.
            count_stmt: An explicit count, used verbatim when supplied. Supply one when ``stmt``
                joins in a way that multiplies rows - a ``joinedload`` against a collection, or a
                join to ``post_categories`` written without a ``DISTINCT`` - because then the
                number of rows the statement yields is not the number of entities. When omitted,
                the count is derived from ``stmt`` itself.

        Returns:
            ``(rows, total)``: the entities on this page, and how many rows matched the same
            predicates ignoring the window, each as of its own statement's snapshot - see the
            note on the two snapshots below. Deliberately not a ``Page``; the module docstring
            explains why that wire shape belongs to the service layer, which passes
            ``list(rows)`` and ``total`` on to ``build_page``.

        Note:
            **The derived count applies exactly the same predicates as the window.** With no
            ``count_stmt`` the count is ``SELECT count(*)`` over
            ``stmt.order_by(None).subquery()``. Subquerying the caller's own statement is what
            guarantees an identical predicate set: no filter can be forgotten, because none is
            restated. Stripping ``ORDER BY`` removes a sort PostgreSQL would otherwise perform
            for a result nobody reads. That is a statement about *which rows* each statement
            asks for, and it is unconditional; it is not a statement about *when* each one looks,
            which is the paragraph below.

            **The count and the window are two snapshots, and the envelope is honest about it.**
            ``app.db.session`` configures no isolation level, so both statements run at
            PostgreSQL's READ COMMITTED default and each takes its own snapshot as it begins. A
            transaction that commits between them is therefore visible to the window and not to
            the count: a post published in that instant can make ``total`` one lower than the
            set the rows were drawn from, and a deleted one can make it one higher. A
            ``selectinload`` on the window adds a further statement and a further snapshot, so a
            relationship loaded for a row can reflect a slightly later state than the row.

            This is accepted rather than worked around, and the reason is that the alternatives
            cost more than the property is worth on a list surface. A single-statement form -
            ``count(*) OVER ()`` beside the rows - reports nothing at all when the window is
            empty, and an empty window beside a real ``total`` is precisely the out-of-range page
            this method is required to support. A repeatable-read transaction would give one
            snapshot, at the price of ``40001`` serialisation failures on every mutating route
            that shares the session factory. So no caller may read ``total`` as a count of the
            rows it was handed, or as a value another request will agree with; it is the size of
            the matching set as of its own statement, which is what a page indicator needs.
            Where a count has to decide a *write*, that decision belongs behind a row lock -
            :meth:`UUIDPrimaryKeyRepository.get_by_id` with ``for_update=True`` - and not behind
            this method.

            Loader options need no stripping, and that was verified rather than assumed against
            SQLAlchemy 2.0.51: the outer ``select(func.count())`` is a Core statement, so ORM
            loader options carried by the inner select are never applied and the rendered SQL is
            byte-identical with and without a ``joinedload``. There is in any case no
            ``.options(None)`` spelling - SQLAlchemy rejects it with ``ArgumentError``. What a
            row-multiplying join does still need is an explicit ``count_stmt``, because that
            multiplication happens inside the caller's own ``FROM``.

            **An out-of-range page is not an error.** A page past the last one returns an empty
            sequence beside the real ``total``, which is how a client detects it has run off the
            end. ``limit <= 0`` likewise returns no rows: emitting ``LIMIT -1`` is a syntax error
            on PostgreSQL, and a non-positive window is a caller defect that must not become a
            ``500`` - request-supplied values are bounded to ``1..100`` by ``PageParams`` long
            before they arrive here.

            **A zero total skips the second round trip.** With nothing matching there is no
            window to fetch, so the second statement is not issued at all - which is also the one
            case where the two-snapshot behaviour above is *not* observable, because a single
            snapshot produced the whole answer. A row inserted after that count is simply not in
            the set this call describes, exactly as a row inserted after any read is not in it.

            **De-duplication is the caller's business.** Rows come back through
            ``.scalars().all()`` with no ``.unique()``. Applying it unconditionally would mask
            the row multiplication a collection ``joinedload`` causes, leaving ``total`` wrong
            and the cause invisible. Use ``selectinload`` for collections - the layer convention
            stated in the module docstring - and the question does not arise.
        """
        counting = (
            count_stmt
            if count_stmt is not None
            else select(func.count()).select_from(stmt.order_by(None).subquery())
        )
        count_result = await self.session.execute(counting)
        matched = count_result.scalar()
        total = 0 if matched is None else matched

        if limit <= 0 or total == 0:
            return [], total

        window_result = await self.session.execute(stmt.limit(limit).offset(max(offset, 0)))
        return window_result.scalars().all(), total


class UUIDPrimaryKeyRepository[ModelT: Base](BaseRepository[ModelT]):
    """The three operations that only make sense for a relation keyed on one surrogate UUID.

    Every relation carrying ``app.db.base.UUIDPrimaryKeyMixin`` - ``users``,
    ``refresh_tokens``, ``categories``, ``posts`` and ``comments`` - has a single-column
    identity that a caller can name in a URL path segment and hand straight to a repository.
    These three methods are written against exactly that shape::

        class PostRepository(UUIDPrimaryKeyRepository[Post]):
            model = Post

    Why this is a separate class rather than three more methods on
    :class:`BaseRepository`
    ---------------------------------------------------------------
    ``post_likes`` is keyed ``(post_id, user_id)`` and ``post_categories`` is keyed
    ``(post_id, category_id)``. Neither has a single-column identity, so all three operations
    below are meaningless on them - and, on the base class, all three were nonetheless
    *callable*:

    * :meth:`get_by_id` would pass one UUID where the mapper expects two, raising at runtime
      on a method the type checker had accepted.
    * :meth:`delete_by_id` inherits that, and its ``get_by_id``-then-``delete`` construction
      is safe only because it never derives a key column from the mapper - the alternative
      bulk form would take ``post_id`` on ``post_likes`` and delete *every* like on a post.
    * :meth:`add` persists and refreshes an ORM instance, which is the wrong write entirely
      for a relation whose whole point is a conflict-ignoring insert:
      ``app.repositories.like_repository.LikeRepository.like`` is idempotent because the key
      absorbs a repeat, and routing a like through ``add`` would raise on the second call
      instead.

    A docstring saying "do not call these three" is not the same thing as their not being
    there. Splitting the class removes them from ``LikeRepository``'s surface, so the mistake
    is a type error at the call site rather than an ``IntegrityError`` or a mass deletion in
    production. ``LikeRepository`` extends :class:`BaseRepository` directly and keeps
    everything that is genuinely key-shape agnostic - :meth:`~BaseRepository.get_or_none`,
    :meth:`~BaseRepository.exists`, :meth:`~BaseRepository.count`,
    :meth:`~BaseRepository.save`, :meth:`~BaseRepository.delete` and
    :meth:`~BaseRepository.paginate` - and addresses its rows by the whole composite key.

    Both invariants the base class states hold here unchanged: nothing commits, and nothing
    constructs an HTTP artefact. Absence is ``None`` or ``False``, and the service above
    decides what that means to a client.
    """

    async def get_by_id(self, entity_id: uuid.UUID, *, for_update: bool = False) -> ModelT | None:
        """Fetch one row by its surrogate primary key, optionally locking it.

        This is *the* identity predicate for the whole codebase. It replaces the three
        hand-written copies the previous service carried - ``app.py:L28-29`` (read one),
        ``app.py:L36-37`` (update) and ``app.py:L45-46`` (delete) - and no sibling repository
        may re-implement a by-primary-key fetch.

        :meth:`~sqlalchemy.ext.asyncio.AsyncSession.get` is used rather than a ``select()``
        because it consults the session's identity map first: an entity already loaded in this
        unit of work comes back with no round trip, and a row the service wrote a moment ago is
        seen by the next lookup inside the same transaction.

        Args:
            entity_id: The server-generated UUID to look up. Identity always originates in
                PostgreSQL through ``gen_random_uuid()``, so this value came either from an
                earlier read or from a URL path segment a route already validated as a UUID.
            for_update:
                When ``True``, emit ``SELECT ... FOR UPDATE`` so the row is locked for the rest
                of this transaction, and read it from the database even if this unit of work
                already holds a copy - a lock over a cached instance would be no lock at all.

                ``populate_existing=True`` travels with the lock, and it is **not** decoration.
                Measured against SQLAlchemy 2.0.51 in ``Session._get_impl``: passing
                ``with_for_update`` does skip the identity-map short circuit, so the ``FOR
                UPDATE`` statement is genuinely issued - but without this option the loader
                leaves an already-loaded instance's attributes exactly as they were and
                *discards* the committed values the statement just returned. The lock would then
                be real while the row read through it was stale, which is the worst of the three
                possible outcomes: a caller that had loaded the row earlier in the same unit of
                work would take a lock and then decide on pre-lock data, with nothing in the
                emitted SQL to show it. With the option set, the same identity-map instance is
                overwritten in place, so the caller's object reference stays valid **and** every
                attribute on it is the committed one.

                Ask for it whenever the value read is about to decide a write - the
                read-check-write sequences behind delete, publish and moderation - because
                without it two transactions can both read the same pre-state and both act on it.
                Leave it ``False``, the default, for every read that only renders: a lock costs
                a round trip, blocks other writers, and on a plain read buys nothing.

        Returns:
            The entity, or ``None`` when no row carries that key. Absence is never an error
            here; the service decides whether it means ``404``, ``403`` or a no-op.

            Under ``for_update=True`` that ``None`` carries more weight than it does otherwise:
            PostgreSQL follows the row's update chain before returning, so a row a concurrent
            transaction deleted and committed is reported absent rather than handed back from a
            snapshot - which is what makes a subsequent write conditional on a fact rather than
            on a guess.

        Note:
            For relations keyed on a single surrogate column, which is every relation carrying
            ``UUIDPrimaryKeyMixin``. The two association relations - ``post_categories`` keyed
            ``(post_id, category_id)`` and ``post_likes`` keyed ``(post_id, user_id)`` - have no
            single-column identity to look up, so their repositories address rows by the whole
            composite key through :meth:`get_or_none` instead.
        """
        # `with_for_update` takes None rather than False for "no lock": passing False would
        # still be a request for a lock clause SQLAlchemy has to render.
        #
        # `populate_existing` is tied to `for_update` rather than always on, because the two
        # modes want opposite things. A locked read is about to decide a write, so it must see
        # committed state and overwrite whatever this unit of work already holds. An unlocked
        # read is a render, and forcing it to overwrite would discard a pending in-session
        # modification the caller has not flushed yet - so the identity map stays authoritative
        # there, which is also what makes the no-round-trip path above possible.
        return await self.session.get(
            self.model,
            entity_id,
            with_for_update=True if for_update else None,
            populate_existing=for_update,
        )

    async def add(self, entity: ModelT) -> ModelT:
        """Persist a new instance and return it fully loaded.

        The instance is built by the caller - a service - from validated input, and it must not
        carry a primary key: ``id`` is generated by PostgreSQL, which is what makes a duplicate
        identifier unstorable rather than merely unlikely. The previous service made the client
        the sole source of ``Item.id``, so two records could share one identifier and the first
        one stored permanently shadowed every later one.

        ``flush()`` emits the INSERT, so identity, defaults and every constraint apply now and a
        unique violation surfaces at this call instead of at some later commit. ``refresh()``
        then reloads the row so the returned entity holds no expired attribute for a response
        serialiser to trip over; the module docstring records the measurement behind that.

        Args:
            entity: A transient instance of :attr:`model`.

        Returns:
            The same instance, now persistent, with ``id`` and the audit timestamps populated
            from the database.
        """
        self.session.add(entity)
        await self.session.flush()
        await self.session.refresh(entity)
        return entity

    async def delete_by_id(self, entity_id: uuid.UUID) -> bool:
        """Remove the row carrying this primary key, reporting whether one existed.

        Built from a **locking** :meth:`get_by_id` and :meth:`delete` rather than from a single
        bulk ``DELETE ... WHERE id = :id``. That trades one extra SELECT for three properties the
        bulk form cannot offer:

        * **Safety on composite keys.** Deriving the key column from the mapper would take the
          *first* column of the primary key. On ``post_likes``, keyed ``(post_id, user_id)``,
          that is ``post_id`` - so the statement would silently delete every like on a post
          instead of one row. Routing through
          :meth:`~sqlalchemy.ext.asyncio.AsyncSession.get` makes the misuse fail loudly rather
          than destroy data.
        * **An exact answer** - which is what the lock is for, and it does not hold without one.
          See below.
        * **A coherent session.** The instance leaves the identity map as part of the delete, so
          a later :meth:`get_by_id` in the same transaction cannot hand back a deleted entity
          from cache.

        It also keeps the identity predicate singular: the lookup is :meth:`get_by_id`'s, not a
        second copy of it.

        Why the read takes ``FOR UPDATE``
        --------------------------------
        The returned boolean claims a fact about the database, so the read that establishes it
        has to still be true when the write lands. Unlocked, it is not. Measured on PostgreSQL
        18.4 with two concurrent sessions: both loaded the same row, both issued
        ``DELETE FROM users WHERE users.id = …``, and **both commits succeeded** - the second
        statement matched nothing, SQLAlchemy at most warns about it, and this method reported
        ``True`` for a row it did not delete. A service reading that as "deleted" returns ``204``
        to one of two callers who both believe they removed the record.

        Locking the row closes the window rather than narrowing it. The second caller blocks on
        the first's row lock, and when the first commits PostgreSQL follows the update chain,
        finds the row deleted, and returns nothing - so :meth:`get_by_id` yields ``None`` and
        this method reports ``False``. Re-measured that way on the same stack: exactly one caller
        deleted the row and returned ``True``, and the other returned ``False``.

        Args:
            entity_id: The surrogate primary key to remove.

        Returns:
            ``True`` when a row existed and this call deleted it, ``False`` when none carried
            that key by the time the lock was granted. Absence never raises - the service turns
            ``False`` into a ``404`` if that is what the endpoint means.

        Note:
            The lock is held until the enclosing transaction ends, which is the service's commit
            or rollback rather than this method's return - so two requests deleting the same row
            serialise rather than interleave. That is a property of the transaction this
            repository was handed, not something it arranges: nothing here commits.
        """
        entity = await self.get_by_id(entity_id, for_update=True)
        if entity is None:
            return False
        await self.delete(entity)
        return True
