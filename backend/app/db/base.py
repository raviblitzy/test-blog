"""The declarative foundation every mapped class in this service is built on.

Three things are declared here and nowhere else: the shared :class:`~sqlalchemy.MetaData`
with its index and constraint naming convention, the :class:`Base` class the seven mapped
classes subclass, and the two mixins that make identity and audit columns *server*-generated
rather than client-supplied. ``app.models.user``, ``refresh_token``, ``category``, ``post``,
``comment`` and ``like`` all import from this module; ``migrations/env.py`` imports
:data:`metadata` as its ``target_metadata``; and ``tests/conftest.py`` imports it to create
and drop the schema around a test run. Nothing else in the backend may declare a second
declarative base or a second ``MetaData``, because a mapped class registered against a
second registry is invisible to both the migration runner and the test harness.

What it replaces
----------------
The service this repository grew out of had exactly one model, and the client was the sole
source of its identity::

    class Item(BaseModel):
        id: int
        name: str
        price: float

The server neither generated ``id`` nor checked it for uniqueness, so two records could
carry the same identifier and the first one stored permanently shadowed every later one -
the read, update and delete paths all scanned for the first match and stopped there. There
were no temporal or audit columns of any kind, so nothing recorded when a record was written
or last changed. :class:`UUIDPrimaryKeyMixin` and :class:`TimestampMixin` are the direct
remedies: after this change identity originates in PostgreSQL and is unique by construction,
and every relation that the design gives audit columns gets them from one definition.

The naming convention
---------------------
:data:`NAMING_CONVENTION` is a **frozen cross-file contract**, not a preference. Alembic's
autogenerate compares the constraint names it reflects from the live database against the
names this convention derives from the models; if the two ever disagree, ``alembic check``
reports drift that no schema change caused, and the up/down/up cycle stops being
reproducible. Two obligations follow for anyone writing a model or a revision:

* **Every** :class:`~sqlalchemy.CheckConstraint` **must be given an explicit** ``name=``.
  The ``ck`` template interpolates ``%(constraint_name)s`` - the constraint's *own* name - so
  an unnamed check has nothing to interpolate, and SQLAlchemy refuses it outright rather than
  inventing something. The failure arrives the moment the constraint is attached to its
  table, well before any DDL is compiled, and it says so plainly: ``InvalidRequestError:
  Naming convention including %(constraint_name)s token requires that constraint is
  explicitly named``. This is not hypothetical - the publication invariant on ``posts``,
  ``status <> 'PUBLISHED' OR published_at IS NOT NULL``, is the one check constraint in the
  schema, and it must be declared as
  ``CheckConstraint(..., name="published_at_required_when_published")`` so it resolves to a
  stable ``ck_posts_published_at_required_when_published``.
* **Long generated names need an explicit** ``name=`` **too.** PostgreSQL truncates any
  identifier past 63 bytes, and SQLAlchemy pre-empts that by substituting a hash-suffixed
  form when a derived name would overflow - so the name in the model and the name in the
  database are then two different strings, which is the same spurious-drift failure in a
  different disguise. Measured against this convention on PostgreSQL 18.4: an index derived
  over two long column names produced an 81-character model-side name that reached the
  server as a 60-character ``..._91fd`` variant. Composite indexes over long columns -
  ``posts (status, published_at DESC)`` and ``comments (post_id, created_at)`` among them -
  should therefore be declared with the name spelled out.

Column types
------------
:attr:`Base.type_annotation_map` carries exactly two entries, and both replace a SQLAlchemy
default that would be wrong for this schema:

* ``str`` maps to ``TEXT`` rather than ``VARCHAR``. Every free-form string column in the
  design - titles, bodies, bios, hashes, URLs - is ``text``, because PostgreSQL stores
  ``text`` and ``varchar`` identically and an arbitrary length cap buys nothing but a future
  migration. Length limits that are genuinely part of the contract are enforced in the
  Pydantic schemas, where a violation becomes a ``422`` instead of a database error.
* ``datetime`` maps to ``TIMESTAMP WITH TIME ZONE``. SQLAlchemy's default is a *naive*
  ``DateTime()``, so without this entry a model that simply annotated ``Mapped[datetime]``
  would silently create a ``timestamp without time zone`` column. Every instant in this
  schema is ``timestamptz``, and this entry makes the correct choice the automatic one.

The map is deliberately overridden by an explicit column type in three places, and each is
the model author's responsibility rather than something this module can supply:

* ``CITEXT`` on ``users.email``, ``users.username``, ``posts.slug`` and ``categories.slug``.
  Case-insensitive comparison is what makes ``Alice`` and ``alice`` one account and
  ``/u/Alice`` and ``/u/alice`` one profile, and it is a column type, not a collation
  choice, so ``Mapped[str]`` alone would give the wrong column.
* The three enumerated types - ``user_role``, ``post_status`` and ``comment_status``. Each is
  a native PostgreSQL ``ENUM`` whose lifecycle belongs to revision ``0001``, so each model
  declares it with ``create_type=False``. Omitting that flag is not a style slip: SQLAlchemy
  then emits its own ``CREATE TYPE`` alongside the ``CREATE TABLE``, the second definition
  collides with the first, and the upgrade stops with
  ``psycopg.errors.DuplicateObject: type "post_status" already exists``. The revision
  correspondingly creates each type at the top of ``upgrade()`` and drops it at the bottom of
  ``downgrade()``, which is what makes the up/down/up cycle repeatable.
* ``TSVECTOR`` on ``posts.search_vector``, which is a generated column: PostgreSQL re-derives
  it on every write, so it is never assigned from Python.

Getting any of those three wrong is the single most likely cause of an ``alembic check``
drift report, because the model and the migration then describe different column types.

Working with the ORM asynchronously
-----------------------------------
:class:`Base` mixes in :class:`~sqlalchemy.ext.asyncio.AsyncAttrs`, which gives every mapped
instance an ``awaitable_attrs`` accessor: ``await post.awaitable_attrs.comments`` loads a
relationship that was not loaded eagerly, instead of raising
``MissingGreenlet: greenlet_spawn has not been called`` the way a plain attribute access
would under an async session.

Treat it as a safety valve, not as a strategy. It emits one round trip per access, so using
it inside a loop reproduces the N+1 pattern the repository layer exists to avoid. The
supported way to load a relationship is to say so in the query -
``selectinload()`` for collections, ``joinedload()`` for many-to-one - inside
``app.repositories.*``, which is the only layer that builds statements.

What is deliberately not here
-----------------------------
This module is the foundation for schema; it is not schema. It declares no mapped class, no
:class:`~sqlalchemy.Table`, no enumerated type, no query, no engine and no session, and it
holds no repository helper. The engine and the session factory are ``app.db.session``; every
statement is ``app.repositories.*``; the relations themselves are ``app.models.*``.

It also declares no ``__tablename__`` derivation. Each mapped class spells its own table
name out so the seven names in the database - ``users``, ``refresh_tokens``, ``categories``,
``posts``, ``post_categories``, ``comments``, ``post_likes`` - are greppable in the source
and cannot drift as a side effect of a class rename. And it declares no ``__repr__``:
a generic one has to read mapped attributes, which is precisely the unloaded-attribute
access that raises under an async session, and a debugging convenience is a poor reason to
put that hazard in every model in the tree.

The invariants the database enforces belong to the models and to the revisions, not here.
The publication check constraint, the ``citext`` unique indexes, the composite primary keys
on ``post_categories`` and ``post_likes`` and the ``ON DELETE CASCADE`` foreign keys are all
declared once, next to the relation they constrain. This module supplies the convention that
names them and nothing more; duplicating any of them here would create a second definition
to keep in sync.

Finally, this module reads **no configuration**. It imports SQLAlchemy and the standard
library, touches no environment variable, does not import ``app.core.config``, and has no
import-time side effect beyond building an empty ``MetaData``. That is load-bearing:
``backend/alembic.ini`` declares no ``sqlalchemy.url`` and sets ``prepend_sys_path = .`` so
``migrations/env.py`` can ``import app`` and reach :data:`metadata`, and ``alembic check``
must be able to resolve this module with no database reachable and no ``.env`` file present.
"""

import uuid
from datetime import datetime
from typing import Any, ClassVar, Final

from sqlalchemy import DateTime, MetaData, Text, func, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncAttrs
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import TypeEngine

__all__ = [
    "NAMING_CONVENTION",
    "Base",
    "TimestampMixin",
    "UUIDPrimaryKeyMixin",
    "metadata",
]

NAMING_CONVENTION: Final[dict[str, str]] = {
    # Indexes. `column_0_label` already carries the table name, so the derived name reads
    # ix_posts_author_id rather than ix_author_id - unique across the whole schema, which
    # matters because PostgreSQL index names share one namespace per schema.
    "ix": "ix_%(column_0_label)s",
    # Unique constraints, e.g. uq_refresh_tokens_token_hash.
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    # Check constraints. `constraint_name` is the constraint's OWN name, so an unnamed
    # CheckConstraint has nothing to interpolate and is rejected the moment it is attached
    # to a table. See the module docstring: every check here is declared with a name=.
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    # Foreign keys, e.g. fk_posts_author_id_users - referencing side, column, referenced
    # side, which is the order that reads as a sentence in a constraint-violation message.
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    # Primary keys, e.g. pk_posts. Composite keys resolve to the same shape, so
    # post_categories and post_likes need no special handling.
    "pk": "pk_%(table_name)s",
}
"""Templates SQLAlchemy uses to derive a name for every unnamed key and index.

These are the canonical templates from the SQLAlchemy and Alembic documentation, and they
are frozen: this dictionary is the object :data:`metadata` holds, so it must be treated as
immutable at runtime. Editing a template changes the name of every existing constraint,
which is a schema migration in its own right and would make ``alembic check`` report drift
across the entire schema at once.

All five keys Alembic reflects are present. Omitting any one of them leaves that constraint
kind on PostgreSQL's server-side default naming - ``posts_pkey`` rather than ``pk_posts`` -
which is exactly the mismatch that makes a downgrade unable to find the object it needs to
drop by name.
"""

_IDENTITY_SORT_ORDER: Final[int] = -100
"""Sort order that places the mixed-in primary key ahead of a relation's own columns.

SQLAlchemy appends columns contributed by a mixin *after* the columns the mapped class
declares itself, so without this the surrogate key would surface in the middle of every
``CREATE TABLE``. Negative values sort first, matching the entity-relationship design, in
which ``id`` heads every relation.

This is presentation only and cannot affect correctness: Alembic's autogenerate compares
columns by name and never by position, so column order is invisible to ``alembic check``.
Stating it explicitly does buy determinism, though - the emitted order stops depending on
whether a model is written ``class Post(Base, UUIDPrimaryKeyMixin, TimestampMixin)`` or with
the bases in some other order.
"""

_CREATED_AT_SORT_ORDER: Final[int] = 100
"""Sort order placing ``created_at`` after every business column. See
:data:`_IDENTITY_SORT_ORDER` for why this is presentation only."""

_UPDATED_AT_SORT_ORDER: Final[int] = 101
"""Sort order placing ``updated_at`` immediately after ``created_at``, so the two audit
columns always appear together and in that order."""


class Base(AsyncAttrs, DeclarativeBase):
    """Declarative base shared by every mapped class in the service.

    Subclass it directly, add the mixins the relation needs, and spell the table name out::

        class Category(Base, UUIDPrimaryKeyMixin, TimestampMixin):
            __tablename__ = "categories"

            name: Mapped[str] = mapped_column(unique=True)

    The class is written in the SQLAlchemy 2.0 typed declarative style - ``Mapped[...]``
    annotations with :func:`~sqlalchemy.orm.mapped_column` - and the legacy
    ``declarative_base()`` factory and bare ``Column(...)`` style are not used anywhere in
    the backend. That is a typing requirement rather than a stylistic one: the deprecated
    ``sqlalchemy.ext.mypy.plugin`` is deliberately not enabled in ``pyproject.toml``, so
    ``mypy --strict`` infers a column's Python type from its ``Mapped[...]`` annotation and
    from nothing else. An untyped ``Column`` would come through as ``Any`` and quietly
    disable type checking for every expression that touched it.

    :class:`~sqlalchemy.ext.asyncio.AsyncAttrs` comes first in the bases so that
    ``awaitable_attrs`` is available on every instance; the module docstring explains when
    reaching for it is appropriate and why it is not a substitute for eager loading.
    """

    # One MetaData for the whole application, carrying the naming convention. Constructed
    # here and handed to the registry SQLAlchemy builds for this base - the convention has
    # to be present when the MetaData is created, because a key is named at the moment its
    # Table is defined, so a convention attached afterwards would miss everything already
    # declared.
    metadata = MetaData(naming_convention=NAMING_CONVENTION)

    # Default column type per Python annotation. Both entries override a SQLAlchemy default
    # that would be wrong here; see the module docstring for the reasoning and for the three
    # column types a model must still declare explicitly.
    #
    # Instances rather than classes: SQLAlchemy accepts either, and DateTime has to be an
    # instance to carry timezone=True, so Text() is written the same way for symmetry.
    # The ClassVar annotation is required by the linter, which reads an unannotated dict
    # literal in a class body as a shared mutable default.
    type_annotation_map: ClassVar[dict[Any, TypeEngine[Any]]] = {
        str: Text(),
        datetime: DateTime(timezone=True),
    }


metadata: MetaData = Base.metadata
"""The application's single :class:`~sqlalchemy.MetaData`, aliased for the migration runner.

``Base.metadata`` is the canonical spelling and this name is the same object - the alias
exists so ``backend/migrations/env.py`` can write ``target_metadata = metadata`` without
first importing the base class it does not otherwise need. Autogeneration compares this
collection against the live database, so a relation is only visible to it once the module
declaring that relation has been imported; ``app.models.__init__`` re-exports all seven
mapped classes for exactly that reason, and ``env.py`` imports that package.

``tests/conftest.py`` uses the same object to create the schema once per session and drop it
afterwards. There is deliberately no second ``MetaData`` anywhere in the backend: a table
registered against a different collection would be invisible to both callers, and would show
up as an unexplained autogenerate diff rather than as an import error.
"""


class UUIDPrimaryKeyMixin:
    """Contributes a single database-generated UUID primary key named ``id``.

    Mix into any relation whose identity is a surrogate key::

        class Post(Base, UUIDPrimaryKeyMixin, TimestampMixin):
            __tablename__ = "posts"

    The column is a plain :func:`~sqlalchemy.orm.mapped_column` rather than a
    :func:`~sqlalchemy.orm.declared_attr`, which is all a mixin needs for a column that
    carries no :class:`~sqlalchemy.ForeignKey`: SQLAlchemy copies the construct for each
    subclass, so every relation gets its own distinct column and its own ``pk_<table>``
    constraint.

    **Do not mix this into an association relation.** ``post_categories`` is keyed on
    ``(post_id, category_id)`` and ``post_likes`` on ``(post_id, user_id)``, and in both
    cases the composite key is the point rather than an implementation detail - it is what
    makes a like idempotent, so two identical conflict-ignoring inserts leave the count at
    one and ``PUT /api/v1/posts/{id}/like`` is safe to retry. Adding a surrogate key
    alongside would permit the duplicate rows the composite key exists to forbid.

    Cross-file contract
    -------------------
    ``migrations/versions/0001_initial_blog_schema.py`` must render this column as
    ``postgresql.UUID(as_uuid=True)`` with ``server_default=sa.text("gen_random_uuid()")``.

    The ``server_default`` half is a hard requirement: omit it and ``alembic check`` reports
    drift under ``compare_server_default``, because the model then expects a default the
    table does not have. The type spelling is a readability requirement rather than a hard
    one, and the distinction is worth stating so nobody chases a phantom failure -
    ``postgresql.UUID(as_uuid=True)``, ``sa.UUID()`` and ``sa.Uuid()`` all compile to the
    same ``uuid`` column and all compare equal even under ``compare_type``, and Alembic's own
    autogenerate in fact renders the dialect type back out as ``sa.UUID()``. Measured against
    PostgreSQL 18.4: an ``upgrade head`` / ``check`` / ``downgrade base`` / ``upgrade head``
    cycle over this metadata reported no pending operations with both comparisons enabled.

    The dialect-specific spelling is still the one to use, because PostgreSQL 18 is the only
    supported backend, there is no cross-dialect abstraction to preserve, and one unambiguous
    spelling shared by the model and the revision is worth more than portability this project
    will never use.

    A model declaring a foreign key to one of these columns should spell the same type out -
    ``mapped_column(postgresql.UUID(as_uuid=True), ForeignKey("posts.id",
    ondelete="CASCADE"))`` - so the two sides of the reference are visibly identical.
    """

    id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True),
        primary_key=True,
        nullable=False,
        # PostgreSQL 18 ships gen_random_uuid() as a built-in: verified available on
        # 18.4 with only citext, pg_trgm and unaccent installed. Neither this module nor
        # revision 0001 may enable uuid-ossp, and none of the three extensions the
        # revision does enable has anything to do with UUID generation.
        server_default=text("gen_random_uuid()"),
        # No Python-side `default=uuid.uuid4`, and its absence is the whole point of this
        # mixin. A Python default would make the application the source of identity again,
        # which is the defect being closed - and it would mean a row inserted by a
        # migration, by psql or by any other client followed a different code path to its
        # identifier than a row inserted by the ORM. PostgreSQL generates every id, and
        # SQLAlchemy reads it back through RETURNING on the same round trip, so the
        # attribute is populated as soon as the INSERT flushes.
        sort_order=_IDENTITY_SORT_ORDER,
    )
    """Surrogate primary key, generated by PostgreSQL and never supplied by a caller."""


class TimestampMixin:
    """Contributes the ``created_at`` and ``updated_at`` audit columns.

    Both are ``TIMESTAMP WITH TIME ZONE NOT NULL`` and both default to the database clock,
    so an insert that mentions neither still records when it happened, and two rows written
    by different processes are ordered by one clock rather than by however many application
    clocks happened to be involved. The type is spelled out on each column rather than left
    to :attr:`Base.type_annotation_map`; the map would resolve it identically, and stating it
    keeps each column readable next to the revision that renders it.

    ``updated_at`` additionally carries ``onupdate``, so an UPDATE emitted through the ORM
    re-stamps it from ``now()``.

    Known limitation, stated rather than papered over: ``onupdate`` is applied by SQLAlchemy
    when it builds the statement, not by PostgreSQL. A bulk ``UPDATE`` issued outside the ORM
    - by hand in ``psql``, or by a data migration - will not refresh ``updated_at``. No
    trigger is introduced to close that gap, deliberately. The schema has exactly one
    derived column, ``posts.search_vector``, and it is a generated column that PostgreSQL
    re-derives on write with no trigger and no application-side index maintenance; adding a
    trigger here would give the schema a second, inconsistent mechanism for keeping derived
    state current, and every future reader would have to learn both.

    Not every relation wants both columns. ``refresh_tokens`` carries ``created_at`` only -
    a token is issued, then either expires or is revoked, and both of those are recorded in
    their own columns, so there is no third state an ``updated_at`` could describe. That
    model declares ``created_at`` directly instead of mixing this in, which is the intended
    use: the mixin is opt-in, and nothing here forces it onto a relation whose design does
    not call for it.
    """

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        sort_order=_CREATED_AT_SORT_ORDER,
    )
    """Instant the row was inserted, from the database clock. Never updated."""

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        # Re-stamped on every ORM-emitted UPDATE. Equal to created_at until the first
        # modification, so `updated_at > created_at` is a reliable "has been edited" test.
        onupdate=func.now(),
        sort_order=_UPDATED_AT_SORT_ORDER,
    )
    """Instant the row was last modified through the ORM, from the database clock."""
