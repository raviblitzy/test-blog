"""The ``categories`` taxonomy and the ``post_categories`` association that files posts under it.

Two schema objects live in this one module, and the pairing is deliberate rather than
incidental: a many-to-many relation is not fully described by either side on its own, so the
association table sits next to the entity it exists to join. :data:`post_categories` is the
join relation; :class:`Category` is the taxonomy itself.

Why this entity exists at all
-----------------------------
Nothing in the original service named it. The requirement was for "category filters" on the
home feed and for an administrative screen "managing ... categories", but the thing being
filtered and managed was never spelled out - so the taxonomy is an *implicit* requirement that
both of those explicit features rest on. It needs three attributes and no more: a display
``name`` a reader sees on a filter chip, a URL-safe ``slug`` a canonical link is built from,
and an optional ``description``.

Everything else a category appears to have is derived somewhere else. The post count rendered
beside each filter, which ``GET /api/v1/categories`` returns and ``app.schemas.category``
projects, is a ``COUNT`` issued by ``app.repositories.category_repository`` - not a column and
not a hybrid property here. A stored counter would be a second source of truth that every
publish, unpublish, delete and re-categorisation had to remember to update.

Import direction
----------------
The edge between this module and ``app.models.post`` runs **one way only**, and that is a
correctness constraint rather than a preference. ``post.py`` does
``from app.models.category import post_categories`` and hands it to its own ``secondary=``,
which makes this module a hard prerequisite of that one. A runtime import back the other way
would close a genuine cycle that fails at interpreter load, so :class:`Post` is imported here
under :data:`typing.TYPE_CHECKING` for the annotation alone and :attr:`Category.posts` names
its target with the **string** ``"Post"``. SQLAlchemy resolves that string against the
declarative registry when mappers are first configured, by which time ``post.py`` has been
imported through ``app.models.__init__``.

Verified rather than assumed: importing this module on its own succeeds with ``Post`` absent
from its runtime globals, and a subsequent ``configure_mappers()`` with ``post.py`` present
resolves :attr:`Category.posts` to the ``Post`` mapper with ``collection_class=list``.

What the database enforces, and what it therefore does not have to
------------------------------------------------------------------
Three invariants are pushed down into PostgreSQL, so no code path can violate them and no code
path has to check:

* **A post cannot be filed under the same category twice.** ``post_categories`` is keyed on
  ``(post_id, category_id)``, so the duplicate is rejected by the primary key rather than
  by an application-level de-duplication step that some future call site would forget.
* **No orphaned join row can survive either side being deleted.** Both foreign keys carry
  ``ON DELETE CASCADE``, so deleting a post drops its category links and deleting a category
  drops its post links, in one statement, inside the same transaction.
* **``/blog/category/Python`` and ``/blog/category/python`` are one category.** ``slug`` is
  ``CITEXT`` with a unique index, so case-insensitive identity is a property of the column
  type and not of remembering to lower-case at every call site.

What is deliberately not here
-----------------------------
Schema only. Slug *derivation* belongs to :mod:`app.core.slug`, whose title helper lower-cases
and transliterates to ASCII within an 80-character bound and whose
:func:`~app.core.slug.unique_slug` suffixes collisions; it is invoked by
``app.services.category_service``, which also owns the in-use check that decides whether a
category with posts attached may be deleted at all. This module holds the resulting column and
the constraint on it, nothing more: no statement, no unit of work, no HTTP concern, no
aggregate.

There is no ``__repr__`` either, matching ``app.db.base``. A useful one has to read mapped
attributes, and reading an unloaded or expired attribute under an ``AsyncSession`` raises
``MissingGreenlet`` rather than returning a string - a poor trade for a debugging convenience.

Cross-file contract
-------------------
* ``migrations/versions/0001_initial_blog_schema.py`` creates both relations. It enables the
  ``citext`` extension - this module only *references* the type - and must render ``id`` as
  ``postgresql.UUID(as_uuid=True)`` with ``server_default=sa.text("gen_random_uuid()")``,
  because ``alembic check`` compares server defaults and would otherwise report drift.
* ``migrations/versions/0003_seed_reference_categories.py`` inserts the reference set as data,
  using ``name``, ``slug`` and ``description`` only. Adding a fourth required column here
  would break that revision.
* ``app.models.__init__`` must re-export **both** names. An association table Alembic never
  imports is an association table it cannot see, and ``alembic check`` would then be blind to
  the relation instead of reporting it as missing.
* ``app.repositories.post_repository`` joins through :data:`post_categories` to implement the
  home-feed category filter; ``app.db.seed`` creates the reference categories and associates
  the demonstration posts.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Final

from sqlalchemy import Column, ForeignKey, Index, Table, Text, literal_column
from sqlalchemy.dialects.postgresql import CITEXT, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    # Annotation-only. See "Import direction" in the module docstring: a runtime import of
    # app.models.post from here would close a cycle, because post.py imports
    # post_categories from this module.
    from app.models.post import Post

__all__ = [
    "Category",
    "post_categories",
]

_ASSOCIATION_KEY_TYPE: Final[UUID[uuid.UUID]] = UUID(as_uuid=True)
"""Column type shared by both foreign keys in :data:`post_categories`.

``app.db.base.UUIDPrimaryKeyMixin`` asks that a model referencing one of its ``id`` columns
spell the same type out, so the two sides of the reference are visibly identical. Declaring it
once here guarantees that for both columns at the same time - the alternative is the same
expression written twice, which is one edit away from disagreeing.

Reusing a single type instance across columns is the ordinary SQLAlchemy pattern rather than a
shortcut: ``TypeEngine`` objects carry no per-column state, which is exactly why
``app.db.base.Base.type_annotation_map`` shares one ``Text()`` across every string column in
the schema.

``as_uuid=True`` is what makes the driver hand back :class:`uuid.UUID` objects instead of
strings, so a value read out of this table compares equal to ``Post.id`` and ``Category.id``
without a cast at the call site.
"""


post_categories = Table(
    "post_categories",
    # Registered on the application's single MetaData. Alembic's autogenerate compares that
    # collection against the live database, so a Table attached anywhere else - or to a second
    # MetaData - is invisible to `alembic check` rather than merely inconvenient.
    Base.metadata,
    Column(
        "post_id",
        _ASSOCIATION_KEY_TYPE,
        # String target, not an imported Column. Resolving "posts.id" is deferred until the
        # metadata is used, which is what keeps this module importable without post.py.
        ForeignKey("posts.id", ondelete="CASCADE"),
        primary_key=True,
        nullable=False,
    ),
    Column(
        "category_id",
        _ASSOCIATION_KEY_TYPE,
        ForeignKey("categories.id", ondelete="CASCADE"),
        primary_key=True,
        nullable=False,
    ),
    # The composite primary key leads with post_id, which serves "given a post, list its
    # categories" - the post-detail page. The home-feed filter asks the opposite question,
    # "given a category, list its posts", and a composite index cannot be read from its
    # second column, so that direction would have no usable access path without this index.
    #
    # The name is spelled out rather than left to the `ix_%(column_0_label)s` convention. Both
    # spellings produce the identical string here, so this is documentation rather than an
    # override - but an index whose name is greppable in the source is an index a downgrade
    # can drop by name with confidence.
    Index("ix_post_categories_category_id", "category_id"),
)
"""Association relation between ``posts`` and ``categories``, keyed on ``(post_id,
category_id)``.

A Core :class:`~sqlalchemy.Table` and deliberately not a mapped class. It is a pure join
relation: it carries no identity of its own and no attribute a caller could set, so there is
nothing for a mapped class to add and a surrogate key would actively permit the duplicate
pairings the composite key exists to forbid - ``app.db.base.UUIDPrimaryKeyMixin`` says as much
in its own documentation. Exactly two columns, no ``id`` and no ``created_at``; a third column
here would show up as ``alembic check`` drift against revision ``0001``.

``app.models.post`` imports this object and passes it as the ``secondary=`` of
``Post.categories``, and :attr:`Category.posts` is the other half of that pairing. Assigning
through either relationship is how a row is written; ``app.repositories.post_repository``
joins through it directly for the feed's category filter, where no entity needs loading.
"""


class Category(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A taxonomy term a post can be filed under.

    Both mixins apply. :class:`~app.db.base.UUIDPrimaryKeyMixin` supplies the surrogate ``id``
    that PostgreSQL generates through ``gen_random_uuid()`` - identity originates in the
    database and is never supplied by a caller, which is the defect being closed: the service
    this schema replaces let the client choose an integer key that the server neither
    generated nor checked for uniqueness. :class:`~app.db.base.TimestampMixin` supplies
    ``created_at`` and ``updated_at``, both from the database clock, because a category is
    editable through the admin screen and "when was this renamed" is a question the audit
    columns should answer.

    Constructing one - the ``slug`` arrives already derived, because deriving it belongs to
    :mod:`app.core.slug` and calling it belongs to ``app.services.category_service``::

        category = Category(
            name="Python",
            slug="python",
            description="Language-level posts about CPython and its ecosystem.",
        )

    Reading ``category.posts`` requires the collection to have been loaded by the statement
    that fetched the row - ``selectinload(Category.posts)`` in
    ``app.repositories.category_repository``. The relationship keeps SQLAlchemy's default lazy
    strategy on purpose: under an ``AsyncSession`` a lazy load raises ``MissingGreenlet`` at
    the point of access, which surfaces a missing eager-load option immediately instead of
    hiding an N+1 behind a page that still renders.
    """

    __tablename__ = "categories"

    name: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        # UNIQUE, so two categories cannot share a display name. Without it a filter chip
        # reading "Python" would be ambiguous to a reader even while the slugs differed.
        # Resolves to the uq_categories_name constraint under the naming convention.
        unique=True,
    )
    """Human-readable display name, unique across the taxonomy. Never derived from the slug."""

    slug: Mapped[str] = mapped_column(
        # CITEXT is passed EXPLICITLY and must stay that way. app.db.base.Base installs a
        # type_annotation_map that resolves a bare `str` annotation to TEXT, so relying on the
        # annotation alone would silently produce a case-SENSITIVE column - the failure would
        # not be a type error but two categories differing only in case, and canonical URLs
        # that stop being canonical. The citext extension itself is enabled by revision 0001.
        CITEXT,
        nullable=False,
        # unique + index together produce ONE object, a unique index named ix_categories_slug,
        # rather than a separate constraint and index. That is the intended shape: the same
        # object enforces uniqueness and serves the lookup that resolves a slug from a URL.
        unique=True,
        index=True,
    )
    """URL-safe, case-insensitively unique identifier used in canonical links.

    Written from :mod:`app.core.slug`, whose title helper lower-cases, transliterates to ASCII,
    collapses separators and bounds the result at 80 characters, and whose
    :func:`~app.core.slug.unique_slug` suffixes a collision.

    **Derived once, at creation, and never again.** A canonical URL that changes is a broken link
    and a lost search ranking, so a rename is a change to :attr:`name` alone: the label a reader
    sees moves and the address they bookmarked keeps resolving. Nothing in the backend recomputes
    this value - :mod:`app.core.slug` ships no "re-slug from the new name" helper,
    ``app.schemas.category.CategoryUpdate`` exposes no member that could ask for one and rejects a
    submitted ``slug`` with ``422`` under ``extra="forbid"``, and no repository method assigns to
    this column after the insert. A term whose address genuinely must change is a new category and
    a redirect, which is a product decision rather than a side effect of an edit.
    """

    description: Mapped[str | None] = mapped_column(
        Text,
        # Optional: a reference category seeded by revision 0003 may carry no prose, and a
        # taxonomy term is fully usable without one. Annotated `str | None` to match, which
        # is what keeps mypy --strict agreeing with the column definition.
        nullable=True,
    )
    """Optional prose shown on category listings and in the admin editor."""

    # ---------------------------------------------------------------------------------
    # Access paths
    #
    # `name` and `slug` already carry equality access paths from their declarations above -
    # uq_categories_name and the unique index ix_categories_slug - and those serve the lookups
    # that resolve a slug from a URL and detect a duplicate name on create.
    #
    # The two declared here serve the two PATTERN predicates in
    # app.repositories.category_repository, neither of which an equality-oriented b-tree can
    # answer:
    #
    #   containment   GET /api/v1/admin/categories takes a `?q=` term and matches it against
    #                 name and slug together with a leading wildcard, which no b-tree can use.
    #   slug family   slug de-duplication runs `slug LIKE 'base%'` before every category insert
    #                 and rename. Anchoring the pattern means the query is not PREVENTED from
    #                 using an index, but the default operator class over a citext column does
    #                 not provide one, so it was a sequential scan regardless.
    #
    # The two spellings differ because the two column types do. `name` is TEXT, so the operator
    # class goes straight on the column. `slug` is CITEXT, and gin_trgm_ops is defined over
    # `text` while citext's own `~~`/`~~*` operators are not in that operator family - so an
    # index declared directly on it is accepted and then never chosen by the planner. It
    # therefore indexes the text cast, and category_repository writes the matching predicate as
    # `cast(Category.slug, Text).ilike(...)`: ILIKE rather than LIKE, because casting away citext
    # also casts away the case-folding that made `News-2` rule out a proposed `news-2`.
    #
    # The expression is a LABELLED literal_column with its operator class in `postgresql_ops`
    # rather than one `text("(slug::text) gin_trgm_ops")` string: both render the same DDL, but
    # Alembic warns on the inline form and then stops comparing the index, leaving it unguarded
    # by the drift gate. Revision 0002 builds both, where every GIN index in this schema lives.
    # ---------------------------------------------------------------------------------
    __table_args__ = (
        Index(
            "ix_categories_name_trgm",
            "name",
            postgresql_using="gin",
            postgresql_ops={"name": "gin_trgm_ops"},
        ),
        Index(
            "ix_categories_slug_trgm",
            literal_column("(slug::text)").label("slug_text"),
            postgresql_using="gin",
            postgresql_ops={"slug_text": "gin_trgm_ops"},
        ),
    )

    posts: Mapped[list[Post]] = relationship(
        # String target, resolved against the declarative registry at mapper-configuration
        # time. See "Import direction" in the module docstring for why this cannot be the
        # class object.
        "Post",
        secondary=post_categories,
        back_populates="categories",
        # NO cascade="all, delete-orphan". On a many-to-many that would delete the POSTS
        # themselves when a category is removed, which is plainly wrong - removing a taxonomy
        # term must remove only the filing, never the article. The default
        # save-update/merge cascade is what is wanted, and it is what stays in force.
        #
        # passive_deletes=True then hands the removal of the association rows to the
        # ON DELETE CASCADE already declared on post_categories.category_id, instead of
        # having SQLAlchemy load the whole collection and delete each link row individually.
        # One statement in the database beats N statements from the application, and the
        # constraint applies to every writer rather than only to this one.
        passive_deletes=True,
    )
    """Published and unpublished posts filed under this category.

    A convenience for writes and for entity-oriented reads; it is not how the home feed is
    built. That query lives in ``app.repositories.post_repository``, which joins through
    :data:`post_categories` so it can compose the category filter with relevance search,
    author filtering, status scoping, ordering and windowing in a single statement.
    """
