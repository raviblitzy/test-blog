"""The ``posts`` relation - the blog's central entity, its lifecycle, and its search index.

Two names are declared here and nowhere else: :class:`PostStatus`, the three-valued publication
lifecycle, and :class:`Post`, the mapped class behind the ``posts`` table. Between them they
carry the entity every other relation in the schema points at - ``post_categories`` files it
under a taxonomy term, ``comments`` hangs a thread off it, ``post_likes`` records a reader's
approval of it - and the two database-enforced guarantees the product's correctness rests on:
a published post always has a publication instant, and every post carries a weighted full-text
index that PostgreSQL re-derives on write.

``app.schemas.post`` and ``app.schemas.admin`` import :class:`PostStatus` from this module
rather than re-declaring it, because an enumerated type declared twice is two contracts that
can disagree. ``app.repositories.post_repository`` builds every feed, profile, dashboard and
administrative listing over :class:`Post`. ``app.services.post_service`` owns the transitions
that move a row between the three states. ``app.db.seed`` creates the demonstration rows.

What it replaces
----------------
The service this repository grew out of had exactly one data contract, and it was a request
schema rather than a relation: a client-supplied integer identifier and two unowned scalar
fields, quoted verbatim in the "What it replaces" section of :mod:`app.db.base` so the retired
shape is recorded once rather than in all seven models. Nothing in the blog domain corresponds
to it, so it is deleted outright with no compatibility shim - the collection it was stored in
never survived a process restart, so no consumer of it can exist.

Four of its properties are defects this relation closes:

* **Identity was the client's to supply.** The server neither generated the key nor checked it
  for uniqueness, so a duplicate identifier permanently shadowed every later row that carried
  it. Here identity comes from :class:`~app.db.base.UUIDPrimaryKeyMixin` over PostgreSQL's
  ``gen_random_uuid()`` and no caller can supply it.
* **There was no lifecycle.** A record existed or it did not. :class:`PostStatus` makes draft,
  published and archived three distinct states, and :attr:`Post.published_at` records when the
  middle one was entered.
* **There was no ownership.** :attr:`Post.author_id` is ``NOT NULL`` and references ``users``,
  so every row has exactly one owner - which is what lets the service layer scope authoring
  authority to the rows a principal owns.
* **Every addressed read was a linear scan over an unindexed collection.** The access paths in
  :attr:`Post.__table_args__` replace that with an index per query the product actually issues.

The publication invariant
-------------------------
``status <> 'PUBLISHED' OR published_at IS NOT NULL`` is a ``CHECK`` constraint, so a bug in
application code cannot produce a published post with no publication date. Verified against
PostgreSQL 18.4: inserting a ``PUBLISHED`` row whose ``published_at`` was ``NULL`` was
rejected.

The predicate is deliberately an implication and not an equality. ``ARCHIVED`` with a non-null
instant is legal, because an archived post was once published and the date it went out remains
a fact about it; ``DRAFT`` with a null instant is legal, because a draft has never been
published. Only the one impossible combination is forbidden. Tightening this into
``status = 'PUBLISHED'`` ``=`` ``published_at IS NOT NULL`` would make archiving a published
post impossible without also erasing its history.

The generated search vector
---------------------------
:attr:`Post.search_vector` is a **stored generated column**, not a trigger-maintained one and
not an application-maintained one. PostgreSQL re-derives it from ``title``, ``excerpt`` and
``content`` on every write, so there is no index-maintenance step anywhere in the service - not
in this module, not in ``app.services.post_service``, and not in a background task. Adding one
would be a second mechanism for keeping the same derived state current.

Three properties of the generating expression are correctness requirements rather than style,
and each of the three has a specific failure mode if it is spelled differently:

1. **``to_tsvector`` is called with two arguments.** The single-argument form is only
   ``STABLE``, because it reads the ``default_text_search_config`` of the calling connection,
   and PostgreSQL refuses a non-``IMMUTABLE`` expression in a generated column. The failure is
   a hard error when the DDL runs, not a subtly wrong result. Passing the ``'english'``
   configuration explicitly is what makes the call ``IMMUTABLE``, and it is the only acceptable
   spelling here.
2. **Every operand is wrapped in ``coalesce(col, '')``.** ``excerpt`` is nullable, and in SQL
   ``anything || NULL`` is ``NULL``, so one null operand would null the whole vector and
   silently drop that row out of every search result. ``coalesce`` makes the expression total;
   ``to_tsvector('english', '')`` is a well-defined empty vector, so a post with no excerpt
   contributes nothing to its own index instead of destroying it.
3. **The column is ``persisted``.** That renders ``GENERATED ALWAYS AS (...) STORED``, and only
   a stored column can be indexed - a ``VIRTUAL`` generated column could not carry the GIN
   index the feed's search path depends on.

``setweight`` assigns descending relevance - ``'A'`` to the title, ``'B'`` to the excerpt,
``'C'`` to the body - so a term in a headline outranks the same term buried in prose. Verified
against PostgreSQL 18.4: a ``websearch_to_tsquery`` search over this expression ordered by
``ts_rank`` returned the seeded row with rank ``0.389``.

Import direction
----------------
This module holds **the one runtime model-to-model import in the package**:
``from app.models.category import post_categories``. It is unavoidable rather than convenient,
because :paramref:`~sqlalchemy.orm.relationship.secondary` needs the actual
:class:`~sqlalchemy.Table` object and not a name. ``category.py`` correspondingly holds no
runtime import back to this module - it imports :class:`Post` under
:data:`typing.TYPE_CHECKING` and names its target with the string ``"Post"`` - so the edge runs
one way only and closes no cycle. Do not invert it.

Every other class this module's relationships point at - :class:`~app.models.user.User`,
:class:`~app.models.category.Category`, ``Comment`` and ``PostLike`` - is imported under
:data:`typing.TYPE_CHECKING` for the annotation alone. SQLAlchemy de-stringifies each
annotation and resolves the target by class name through the declarative registry when mappers
are configured, which is what ``app.models.__init__`` triggers for both the migration runner
and the test harness.

Access paths
------------
Six indexes serve this relation, and each exists for a query the product actually issues:

* ``ix_posts_status_published_at`` over ``(status, published_at DESC)`` - the home feed's
  default ordering, "recent published posts", which is the single most-issued query in the
  product. The descending direction is part of the index rather than something the planner has
  to sort afterwards.
* ``ix_posts_search_vector`` - a GIN index over the generated column, the primary search path.
* ``ix_posts_title_trgm`` - a GIN trigram index over ``title``, the typo-tolerant *fallback*.
  Verified on PostgreSQL 18.4 that ``WHERE title % 'Scaling FastAPI'`` matches through it.
  Ranked full-text search remains the primary path; this one exists for the near-miss.
* ``ix_posts_slug`` - the unique index ``unique=True`` and ``index=True`` together produce,
  which resolves a canonical URL to a row in one probe.
* ``ix_posts_slug_trgm`` - a GIN trigram index over ``(slug::text)``, for the anchored
  ``slug LIKE 'base%'`` family scan that slug de-duplication runs before every insert and
  retitle. The unique index above cannot serve that predicate: it carries the default operator
  class over a ``citext`` column, which offers nothing for a pattern match at any size. The
  index is over the text *cast* for the same reason every citext trigram index in this schema
  is - see the comment on the index itself.
* ``ix_posts_author_id`` - profile and author-dashboard listings.

The ``pg_trgm`` extension the trigram operator class belongs to is enabled by revision
``0001``; this module only references the class. One honest caveat, recorded rather than
papered over: a probe against a single-row table chose a sequential scan over the full-text
index. That is expected planner behaviour at trivial size and not a defect in the index -
index usage has to be re-confirmed against seeded volume, which is why ``app.db.seed`` creates
demonstration posts rather than one.

What is deliberately not here
-----------------------------
Schema only, and the boundary is worth stating precisely because this is the relation most
likely to attract behaviour:

* **No slug derivation.** :mod:`app.core.slug` derives a URL-safe form from a title within an
  80-character bound and suffixes a collision; ``app.services.post_service`` calls it. This
  module holds the resulting column and the unique constraint on it.
* **No publish or unpublish logic.** Those are service-layer transitions that set
  :attr:`Post.status` and stamp :attr:`Post.published_at` together. Nothing here toggles a
  state, and there is no ``publish()`` method - a state machine that lives on the mapped class
  is a state machine that runs wherever the class is loaded.
* **No sanitisation.** Author-supplied rich content is cleaned on write by the service layer.
  :attr:`Post.content` is a column.
* **No ownership check.** ``author_id`` records who owns a row; deciding what that permits is
  ``app.services.post_service`` and ``app.core.dependencies``, and every protected operation
  re-checks it server-side.
* **No view-count increment.** :attr:`Post.view_count` is a column and nothing else - there is no
  ``record_view()`` method here. Nor is there one anywhere else yet: no route in the REST surface
  advances the counter, and ``app.repositories.post_repository`` records at its own head that it
  deliberately ships no increment operation and no ``"popular"`` sort. The column exists so that
  advancing it later is a service-layer change behind an unchanged contract.
* **No statement of any kind.** No query, no classmethod finder, no hybrid property, no
  property that filters a collection. Every statement in the backend is built in
  ``app.repositories.*``, and the feed's composition of relevance ranking, category joins,
  author filtering, status scoping, ordering and windowing belongs to
  ``app.repositories.post_repository`` in one place. The retired implementation wrote its
  identity predicate three separate times; concentrating query construction in one layer is
  what that separation buys.

Nor does this module re-declare what it inherits. ``id``, ``created_at`` and ``updated_at``
come from the two mixins and appear nowhere below; re-declaring one would shadow the mixin's
column, and declaring a second :class:`~sqlalchemy.MetaData` or declarative base would hide
this relation from both the migration runner and the test harness.

It reads no configuration - no environment variable, no dotenv file, no import of
``app.core.config`` - and has no import-time side effect. ``alembic check`` has to resolve this
module with no database reachable and no ``.env`` present, and it does. And there is no
``__repr__``, matching :mod:`app.db.base`: a generic one has to read mapped attributes, and
reading an unloaded or expired attribute under an ``AsyncSession`` raises ``MissingGreenlet``
rather than returning a string.

Cross-file contract
-------------------
This module is the *reference side* of ``alembic check``: autogeneration compares
``Base.metadata`` built from here against the migrated database, so every object below must
have a counterpart in a revision even though the revisions split the work in two.

* ``migrations/versions/0001_initial_blog_schema.py`` enables ``citext`` and ``pg_trgm`` -
  this module only references those types and operator classes - creates the ``post_status``
  enumerated type with the three labels below **in this order**, and renders the table, its
  keys, its ``ON DELETE CASCADE`` foreign key, the ``CHECK`` constraint and the B-tree
  indexes. The check resolves under the naming convention in :mod:`app.db.base` to
  ``ck_posts_published_at_required``; that is the exact string a hand-written revision must
  use, and the ``name=`` passed below is the stem the convention interpolates rather than the
  full name.
* ``migrations/versions/0002_post_search_vector_and_indexes.py`` adds the generated column and
  the three GIN indexes - ``ix_posts_search_vector``, ``ix_posts_title_trgm`` and
  ``ix_posts_slug_trgm`` - kept separate so the index build is a distinct, re-runnable step. The
  split does **not** license omitting those four objects from this model: metadata is the
  reference side, so an object present in the database and absent here would be proposed for
  removal on the next autogenerate. They are declared below for exactly that reason. Be aware
  that Alembic does not reliably detect purely expression-based indexes, so the correspondence
  between those three indexes and revision ``0002`` has to be maintained deliberately rather
  than relied upon to be caught by the gate.
* ``app.models.__init__`` re-exports both :class:`Post` and :class:`PostStatus`; a relation the
  migration runner never imports is a relation autogeneration cannot see.
* ``app.models.comment`` and ``app.models.like`` declare ``posts.id`` foreign keys and pair
  ``back_populates="post"`` against the collections declared at the end of this module.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    CheckConstraint,
    Computed,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    literal_column,
    text,
)
from sqlalchemy.dialects import postgresql
from sqlalchemy.dialects.postgresql import CITEXT, TSVECTOR
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin

# The one runtime model-to-model import in this package. `secondary=` below needs the Table
# object itself, not a name, so this cannot be deferred to TYPE_CHECKING the way the four
# imports beneath it are. See "Import direction" in the module docstring: category.py holds no
# runtime import back to here, which is what keeps the edge one-way and acyclic.
from app.models.category import post_categories

if TYPE_CHECKING:
    # Annotation-only imports. `Category` is listed here rather than added to the runtime
    # import above because the relationship names its target by string; only the Table is
    # needed at import time. `Comment` and `PostLike` must stay here - both modules declare a
    # posts.id foreign key, so importing either at runtime would close a cycle.
    from app.models.category import Category
    from app.models.comment import Comment
    from app.models.like import PostLike
    from app.models.user import User

__all__ = ["Post", "PostStatus"]


class PostStatus(enum.StrEnum):
    """The three states of a post's publication lifecycle.

    Persisted as the native PostgreSQL enumerated type ``post_status``. The lifecycle is an
    explicit state and deliberately not a boolean flag: publish and unpublish are first-class
    transitions that ``app.services.post_service`` performs, each of which sets this column and
    :attr:`Post.published_at` together, rather than a flag some general partial-update path
    could flip on its own.

    Each member's value is **identical to its own name**, which is load-bearing rather than
    redundant. SQLAlchemy derives an enumerated type's PostgreSQL labels from the Python member
    *names* by default, while a ``values_callable`` derives them from the *values*; making the
    two identical means both resolutions coincide, so the labels stored in the database are
    unambiguously uppercase however the type is configured. That matters here more than
    anywhere else in the schema, because :attr:`Post.__table_args__` compares this column
    against the bare SQL literal ``'PUBLISHED'`` - PostgreSQL coerces the unknown-typed literal
    to ``post_status``, and a lower-case label would make that predicate silently never match.

    :class:`enum.StrEnum` is the spelling used rather than a ``(str, enum.Enum)`` mixin, for the
    same three reasons recorded on :class:`app.models.user.UserRole`, all re-verified here
    against the pinned toolchain: ``ruff``'s ``UP042`` rejects the mixin form outright under
    ``target-version = "py314"`` and ``ruff check backend`` is a blocking gate;
    :class:`enum.StrEnum` *is* a :class:`str` subclass, so ``issubclass(PostStatus, str)`` and
    ``PostStatus.DRAFT == "DRAFT"`` both hold and SQLAlchemy derives the same uppercase labels
    under either spelling; and ``f"{PostStatus.DRAFT}"`` renders as ``DRAFT`` rather than as a
    Python repr, so an interpolated state in a log line reads as the label.

    Only membership is declared here. Which transitions are legal, who may perform them, and
    what each state makes visible are decided in the service and repository layers - the public
    feed and the public profile both filter on :attr:`PUBLISHED` explicitly, which is what
    stops a draft leaking through either.
    """

    DRAFT = "DRAFT"
    """Authored but not public: the state every post is created in, and the state unpublishing
    returns it to.

    Invisible to the feed, to a category filter and to a public profile, and readable only by
    its author or an administrator.

    ``published_at`` may or may not be set, and which it is carries meaning. A post created and
    never published has none. A post that was published and then unpublished **keeps** the instant
    it first went public: the column records *when this became public*, and ``status`` alone records
    *whether it is public now*, so clearing it would destroy the only record of the original
    publication and would let an unpublish-then-republish cycle present old writing as new. The
    table's ``CHECK`` constrains only :attr:`PUBLISHED` - it requires an instant there and says
    nothing about this state - which is exactly what permits both shapes. A null
    ``published_at`` therefore means "never published" rather than "not published now".
    """

    PUBLISHED = "PUBLISHED"
    """Public and discoverable: listed in the feed, filterable, crawlable, and enumerated in
    the sitemap.

    Reaching this state requires a ``published_at`` instant - not by convention but by the
    ``CHECK`` constraint on the table, so no code path can produce a published post without a
    publication date.
    """

    ARCHIVED = "ARCHIVED"
    """Withdrawn from the public surface without being deleted.

    Distinct from :attr:`DRAFT`, and the distinction is why the lifecycle has three states
    rather than two: an archived post *was* published, so it keeps the ``published_at`` instant
    that records when. The ``CHECK`` constraint is written as an implication precisely so this
    combination stays legal.
    """


_SEARCH_VECTOR_EXPRESSION: str = (
    # Weighted, IMMUTABLE, total. Every clause of that description is a requirement:
    #
    #   two-argument to_tsvector  the one-argument form reads the connection's
    #                             default_text_search_config and is therefore only STABLE.
    #                             PostgreSQL refuses a non-IMMUTABLE expression in a generated
    #                             column, so the short form fails when the DDL runs.
    #   coalesce on every operand `anything || NULL` is NULL in SQL, and `excerpt` is nullable,
    #                             so one unguarded null operand would null the entire vector and
    #                             silently drop the row out of every search result.
    #   setweight A > B > C       a term in a headline must outrank the same term buried in
    #                             prose; ts_rank reads these labels to decide that.
    #
    # Declared as a module-level constant rather than inline so the expression the model
    # compiles and the expression revision 0002 renders are one string a reader can compare
    # character for character. Kept as SQL text rather than built from SQLAlchemy functions
    # because Computed() emits it verbatim into the DDL, and a hand-written revision has to
    # reproduce it exactly for `alembic check` to agree.
    "setweight(to_tsvector('english', coalesce(title, '')), 'A') || "
    "setweight(to_tsvector('english', coalesce(excerpt, '')), 'B') || "
    "setweight(to_tsvector('english', coalesce(content, '')), 'C')"
)
"""The generating expression behind :attr:`Post.search_vector`.

Verified against PostgreSQL 18.4: a ``websearch_to_tsquery`` search over a column generated
from this expression, ordered by ``ts_rank``, returned the seeded row with rank ``0.389``.
"""


class Post(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A blog post: the entity the entire product is organised around.

    Thirteen columns, three of them inherited and one of them generated. ``id`` comes from
    :class:`~app.db.base.UUIDPrimaryKeyMixin` and is produced by PostgreSQL;
    ``created_at`` and ``updated_at`` come from :class:`~app.db.base.TimestampMixin` and are
    stamped from the database clock; ``search_vector`` is derived by PostgreSQL from three of
    the nine columns declared below and is never written from Python.

    Constructing one - the slug arrives already derived, because deriving it belongs to
    :mod:`app.core.slug` and calling it belongs to ``app.services.post_service``::

        post = Post(
            author_id=author.id,
            title="Scaling FastAPI",
            slug="scaling-fastapi",
            excerpt="What changes when a single process is no longer enough.",
            content="...",
        )

    That leaves :attr:`status` at its database-level default of :attr:`PostStatus.DRAFT` and
    :attr:`published_at` null, which is exactly the state a newly created post must be in: a
    draft, absent from the public feed. Publishing is a separate transition that sets both
    columns together, and the table's ``CHECK`` constraint is what guarantees it cannot set
    only one.

    Reading a relationship requires the collection to have been loaded by the statement that
    fetched the row - ``selectinload(Post.categories)`` and friends, in
    ``app.repositories.post_repository``. All four relationships keep SQLAlchemy's default lazy
    strategy on purpose: under an ``AsyncSession`` a lazy load raises ``MissingGreenlet`` at the
    point of access, which surfaces a missing eager-load option immediately instead of hiding
    an N+1 behind a page that still renders.

    Nothing on this class is a method. It is a mapped shape, a set of database-enforced
    invariants and four relationship declarations - all of which are schema. Every behaviour
    that reads them lives in ``app.repositories.*`` and ``app.services.*``.
    """

    __tablename__ = "posts"

    author_id: Mapped[uuid.UUID] = mapped_column(
        # The type is spelled out rather than left to the annotation, because
        # app.db.base.UUIDPrimaryKeyMixin asks that a model referencing one of its `id`
        # columns state the identical type - so the two sides of the reference are visibly the
        # same, and revision 0001 has one unambiguous spelling to render.
        postgresql.UUID(as_uuid=True),
        # ON DELETE CASCADE is mandatory, not defensive. It is the database half of the
        # guarantee "deleting a user removes their posts", whose ORM half is the
        # passive_deletes=True already declared on User.posts. Neither half is optional:
        # the cascade without the flag is correct but quadratic, and the flag without the
        # cascade orphans rows.
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        # Indexed to serve the author-scoped listings - the public profile's published posts
        # and the author dashboard's own posts grouped by status. Both are addressed by author,
        # and neither has any other usable access path.
        index=True,
    )
    """The owning account. ``NOT NULL``, so every post has exactly one author.

    This column is the entire basis of ownership-scoped authority: ``app.services.post_service``
    compares it against the resolved principal to decide whether an update, delete, publish or
    unpublish may proceed, and an administrator bypasses the comparison. The comparison itself
    is not here - a mapped class that decides who may act on it is a mapped class whose
    authority rules run wherever it happens to be loaded.
    """

    title: Mapped[str] = mapped_column(Text, nullable=False)
    """The post's headline, and the highest-weighted input to :attr:`search_vector`.

    Unbounded ``TEXT`` at the database level, as every free-form string in this schema is; the
    length limit that is genuinely part of the contract is declared in ``app.schemas.post``,
    where a violation becomes a ``422`` instead of a database error. Also the column the
    trigram index is built over, which is what makes a near-miss title search match.
    """

    slug: Mapped[str] = mapped_column(
        # CITEXT is passed EXPLICITLY and must stay that way. app.db.base.Base installs a
        # type_annotation_map that resolves a bare `str` annotation to TEXT, so relying on the
        # annotation would silently produce a case-SENSITIVE column - and the failure would not
        # be a type error, it would be /blog/Scaling-FastAPI and /blog/scaling-fastapi becoming
        # two canonical URLs for one article. The citext extension is enabled by revision 0001.
        CITEXT,
        nullable=False,
        # unique + index together emit ONE object, a unique index named ix_posts_slug under the
        # naming convention, rather than a separate constraint and a separate index. That is
        # the intended shape: the same object enforces uniqueness and serves the single-probe
        # lookup that resolves GET /api/v1/posts/{slug}.
        unique=True,
        index=True,
    )
    """URL-safe, case-insensitively unique identifier the canonical URL is built from.

    Written from :mod:`app.core.slug`, which derives it from the title within an 80-character
    bound and suffixes a collision so uniqueness is reached before the insert rather than by
    catching the violation.

    **Derived once, at creation, and never again.** A canonical URL that changes after publication
    is a broken link and a lost ranking, and this column is what the whole SEO requirement rests
    on: ``/blog/{slug}`` is the address in every published link, every ``<link rel="canonical">``
    tag and every sitemap entry. So a retitle changes :attr:`title` alone - the headline a reader
    sees moves and the address they bookmarked keeps resolving. Nothing in the backend recomputes
    this value: :mod:`app.core.slug` ships no "re-slug from the new title" helper,
    ``app.schemas.post.PostUpdate`` exposes no member that could ask for one and rejects a
    submitted ``slug`` with ``422`` under ``extra="forbid"``, and no repository method assigns to
    this column after the insert.
    """

    excerpt: Mapped[str | None] = mapped_column(Text, nullable=True)
    """Optional short summary, weighted ``'B'`` in :attr:`search_vector`.

    Rendered on the feed card and used as the meta description and social-card description when
    present. Nullable because a post is publishable without one - which is precisely why the
    generating expression wraps this column in ``coalesce``: an unguarded null here would null
    the whole vector and remove the post from every search result.
    """

    content: Mapped[str] = mapped_column(Text, nullable=False)
    """The post body as authored Markdown, weighted ``'C'`` in :attr:`search_vector`.

    ``NOT NULL``: a post with no body has nothing to publish. Stored as authored and sanitised
    on write by ``app.services.post_service``, then sanitised again where it is rendered - two
    boundaries rather than one, because this is the schema's only stored-injection surface for
    author-supplied rich text. No cleaning happens here; this is a column.
    """

    cover_image_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    """Optional absolute URL of the post's hero image.

    A URL reference rather than uploaded bytes: this design has no upload pipeline and no object
    store. Null is the expected common case rather than an exceptional one - the client
    generates a default social card for routes without a cover image - so nothing downstream
    treats its absence as an error.
    """

    status: Mapped[PostStatus] = mapped_column(
        # Native PostgreSQL enumerated type. `create_type=False` is mandatory: revision 0001
        # creates `post_status` in upgrade() and drops it in downgrade(), so SQLAlchemy must not
        # emit a competing CREATE TYPE alongside the CREATE TABLE. Omitting the flag stops the
        # upgrade with `psycopg.errors.DuplicateObject: type "post_status" already exists`. The
        # name is spelled exactly as the revision spells it, because a mismatch is an
        # alembic-check drift report that no schema change caused.
        postgresql.ENUM(PostStatus, name="post_status", create_type=False),
        nullable=False,
        # `'DRAFT'::post_status` is the spelling PostgreSQL reflects back for this default, so
        # the model side and the reflected side compare equal under compare_server_default.
        # Defaulting at the DATABASE level rather than in Python means a row inserted by a
        # revision, by a data migration or by any other client starts as a draft too.
        server_default=text("'DRAFT'::post_status"),
    )
    """The post's lifecycle state, defaulting to :attr:`PostStatus.DRAFT` at the database level.

    The public feed, the category filter and the public profile all filter on
    :attr:`PostStatus.PUBLISHED` explicitly, which is what makes draft confidentiality a
    property of every query rather than of remembering to add a predicate.
    """

    published_at: Mapped[datetime | None] = mapped_column(
        # timestamptz. The type is stated rather than left to Base.type_annotation_map, which
        # would resolve it identically, so the column reads the same here as in the revision.
        DateTime(timezone=True),
        # Nullable, because a draft has never been published and must not have to invent an
        # instant. What stops that nullability from admitting a *published* row with no date is
        # the CHECK constraint in __table_args__, not this column's definition.
        nullable=True,
    )
    """The instant the post became public, or ``None`` while it never has been.

    Stamped by the publish transition in ``app.services.post_service``, in the same statement
    that sets :attr:`status`. Retained through :attr:`PostStatus.ARCHIVED`, because an archived
    post was once published and the date it went out remains a fact about it. This is also the
    feed's default sort key, descending, and the ``lastModified`` value the sitemap reports.
    """

    view_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        # Server-side default so a row inserted outside the ORM starts at zero rather than at
        # NULL, which is what lets the column be NOT NULL without a Python-side default.
        server_default=text("0"),
    )
    """A readership counter, never null and never negative, and never *measured*.

    Both halves of the first claim are enforced by the database rather than asserted here:
    ``NOT NULL`` on the column above, and ``ck_posts_view_count_non_negative`` in
    :attr:`__table_args__`. The second one matters because ``app.schemas.post`` publishes the
    bound as ``ge=0`` on both the summary and the detail projection, and the framework validates
    a handler's return value against its response model - so a negative value would not merely be
    wrong in the table, it would make every read of that post a ``500``.

    The column the schema provides for "how many times this post has been read", and **nothing
    advances it**: no endpoint in the REST surface increments it, no repository method updates it
    and no input model accepts it. A row therefore reports whatever was written when it was
    inserted, and never anything else - the ``0`` of this server default for a post created
    through the API, and a plausible fabricated figure for one created by ``app.db.seed``, which
    supplies a deterministic value per post so a card, a profile and an administrative table are
    not each rendering the same zero.

    That distinction is stated rather than glossed because it decides how the value may be used.
    It is *not* an audience signal and must not be presented as one, and
    ``app.repositories.post_repository`` ships no ``"popular"`` sort for exactly that reason:
    ordering a feed by this column would rank real articles by numbers nobody measured.

    Deliberately a stored counter on the post rather than a derived count: there is no view
    relation to aggregate, and inventing one would trade a column for a table that grows without
    bound. Keeping the column means the day a service advances it, the API contract that already
    publishes it does not change.
    """

    search_vector: Mapped[str] = mapped_column(
        TSVECTOR,
        # GENERATED ALWAYS AS (...) STORED. PostgreSQL re-derives this on every INSERT and
        # UPDATE, so SQLAlchemy excludes it from both statements and no code anywhere maintains
        # it - there is no trigger, no background task and no application-side index step to
        # write. `persisted=True` is what makes it STORED, and only a stored column can carry
        # the GIN index the search path needs; a virtual one could not be indexed at all.
        Computed(_SEARCH_VECTOR_EXPRESSION, persisted=True),
        # Nullable in the DDL although the expression is total: `coalesce` on every operand
        # means PostgreSQL always has a value to store, so the permissiveness costs nothing and
        # keeps the column strictly the database's to populate. There is deliberately no
        # Python-side default and nothing in the backend ever assigns to this attribute.
        nullable=True,
    )
    """Weighted full-text index over title, excerpt and body, maintained by PostgreSQL.

    Read-only from the application's point of view. ``app.repositories.post_repository`` queries
    it with ``websearch_to_tsquery`` and orders by ``ts_rank``; nothing writes it.

    One consequence worth knowing before it surprises someone: because PostgreSQL re-derives
    this column on write, SQLAlchemy expires it after a flush, and reading an expired attribute
    under an ``AsyncSession`` raises ``MissingGreenlet``. That is why the refresh in
    ``app.repositories.base`` is mandatory rather than defensive - its own docstring records the
    measurement that showed this column and ``updated_at`` expired immediately after an UPDATE.
    """

    # ---------------------------------------------------------------------------------
    # Table-level invariants and access paths
    #
    # One CHECK constraint and three explicitly named indexes. Two further indexes are
    # contributed by the column definitions above and are deliberately NOT repeated here:
    # ix_posts_author_id from `index=True` on author_id, and the unique ix_posts_slug from
    # `unique=True, index=True` on slug. Declaring either a second time would create a
    # duplicate object that revision 0001 could not reproduce.
    # ---------------------------------------------------------------------------------
    __table_args__ = (
        CheckConstraint(
            # The publication invariant, and the single most important line in this module.
            # Verified by execution against PostgreSQL 18.4: an INSERT of a PUBLISHED row whose
            # published_at was NULL was rejected. A bug in application code therefore cannot
            # produce a published post with no publication date.
            #
            # The bare literal needs no cast - PostgreSQL coerces the unknown-typed 'PUBLISHED'
            # to post_status - which is exactly why PostStatus insists on uppercase labels.
            #
            # An IMPLICATION rather than an equality, on purpose: ARCHIVED with a non-null
            # instant is legal because an archived post was once published, and DRAFT with a
            # null one is legal because a draft never was. Only the impossible pairing is
            # forbidden.
            "status <> 'PUBLISHED' OR published_at IS NOT NULL",
            # The STEM, not the finished name. app.db.base's convention for check constraints is
            # `ck_%(table_name)s_%(constraint_name)s`, so this interpolates to
            # `ck_posts_published_at_required` - 30 characters, comfortably inside PostgreSQL's
            # 63-byte identifier limit, and the exact string a hand-written revision or a
            # downgrade must name. Passing the finished name here instead would double the
            # prefix into `ck_posts_ck_posts_published_at_required`; omitting the name entirely
            # is rejected outright, because %(constraint_name)s would have nothing to
            # interpolate (`InvalidRequestError: Naming convention including
            # %(constraint_name)s token requires that constraint is explicitly named`).
            name="published_at_required",
        ),
        CheckConstraint(
            # The non-negativity of `view_count`, which this module's attribute docstring and
            # `app.schemas.post`'s `ge=0` bound both state as a guarantee. Without this line
            # they state it about a column whose DDL is only `NOT NULL DEFAULT 0`, so the
            # guarantee holds by nothing more than nobody having written a decrement yet - and
            # the first one to get its sign wrong would store a negative counter that the
            # response model then rejects, turning a correct read into a 500 on every request
            # for that post. A CHECK moves the promise into the schema that has to keep it,
            # which is the same reason `published_at_required` is here rather than in a service.
            #
            # `>= 0` rather than `> 0`: zero is the server default and the honest value for a
            # post nobody has read, so it is the whole population today.
            #
            # Interpolates to `ck_posts_view_count_non_negative` - 32 characters, inside the
            # 63-byte limit. The stem-not-finished-name rule above applies identically.
            "view_count >= 0",
            name="view_count_non_negative",
        ),
        Index(
            # The home page's primary query: "recent published posts". Leading with the
            # equality column and following with the sort column is what lets one index satisfy
            # both the status filter and the ordering, so the planner needs no separate sort.
            #
            # The name is spelled out rather than left to the `ix_%(column_0_label)s`
            # convention, which would derive `ix_posts_status` - a name that describes only the
            # first of two columns and collides with any future single-column index on status.
            # app.db.base asks for exactly this, naming this index as its example.
            "ix_posts_status_published_at",
            "status",
            # DESC is part of the index rather than something applied afterwards. `text()` is
            # the string-safe spelling for a directional expression inside __table_args__;
            # `published_at.desc()` is unavailable here because the column object is not in
            # scope at class-body evaluation time.
            text("published_at DESC"),
        ),
        Index(
            # The ALL-STATUS recency ordering, which ix_posts_status_published_at above cannot
            # serve. That index leads with `status`, so it orders rows *within* a status - which
            # is exactly right for the public feed, where `status = PUBLISHED` is an equality
            # predicate. The administrative posts table has no status predicate at all: it reads
            # every state in one window, ordered `published_at DESC NULLS LAST, id DESC`
            # globally. A leading equality column provides no global order for that, and neither
            # does enumerating every enum value into an `IN` list - the scan would still have to
            # merge three ordered groups, so the planner sorts the whole relation before applying
            # LIMIT. This index is the access path that ordering actually has.
            #
            # NULLS LAST is written into the index rather than left to the default, and the two
            # spellings are not interchangeable to the planner. A DESC index column orders NULL
            # *first* in PostgreSQL, so an index declared plain `published_at DESC` cannot satisfy
            # `ORDER BY published_at DESC NULLS LAST` and forces a sort. Drafts carry no
            # publication instant, so every surface that admits them needs the NULLS LAST form -
            # see `_recency_ordering` in app.repositories.post_repository, which emits exactly
            # this spelling whenever the status scope can yield a NULL.
            #
            # `id DESC` is the deterministic tiebreaker, in the index for the same reason it is in
            # the query: `published_at` is stamped from a per-transaction clock, so a bulk publish
            # gives many rows one instant, and an unspecified order under LIMIT/OFFSET is how a
            # row lands on two consecutive pages while another lands on none.
            "ix_posts_published_at_id",
            text("published_at DESC NULLS LAST"),
            text("id DESC"),
        ),
        Index(
            # The feed's primary search path: a GIN index over the generated column, which is
            # what makes ranked full-text search an index scan rather than a table scan.
            "ix_posts_search_vector",
            "search_vector",
            postgresql_using="gin",
        ),
        Index(
            # Typo-tolerant title matching - the FALLBACK path, not the primary one. Verified
            # on PostgreSQL 18.4 that `WHERE title % 'Scaling FastAPI'` matches through this
            # index. The gin_trgm_ops operator class belongs to the pg_trgm extension, which
            # revision 0001 enables; this declaration only references it, and the index build
            # itself belongs to revision 0002 alongside the search-vector index.
            "ix_posts_title_trgm",
            "title",
            postgresql_using="gin",
            postgresql_ops={"title": "gin_trgm_ops"},
        ),
        Index(
            # The slug FAMILY scan, which is a different question from the slug lookup above.
            # ix_posts_slug resolves one slug to one row; this one answers "which slugs begin with
            # this stem", the query app.repositories.post_repository.slugs_starting_with issues
            # before every create and every retitle so that uniqueness is reached before the
            # INSERT rather than by catching a unique violation.
            #
            # Anchoring that pattern means the query is not PREVENTED from using an index, but the
            # default operator class over a citext column does not provide one - so it was a
            # sequential scan over every post whatever ix_posts_slug did. Measured on PostgreSQL
            # 18.4 at twenty thousand posts: a sequential scan on the column, a bitmap index scan
            # over the text cast.
            #
            # gin_trgm_ops is defined over `text` and citext's own `~~`/`~~*` operators are not in
            # that operator family, so this indexes the CAST, and post_repository writes the
            # matching predicate as `cast(Post.slug, Text).ilike(...)` - ILIKE rather than LIKE,
            # because casting away citext also casts away the case-folding that makes a stored
            # `My-Post` correctly rule out a proposed `my-post`.
            #
            # A LABELLED literal_column with the operator class in `postgresql_ops`, not one
            # text("(slug::text) gin_trgm_ops") string: both render the same DDL, but Alembic warns
            # on the inline form and then stops comparing the index, leaving it unguarded by the
            # drift gate. Built by revision 0002 alongside the two above.
            "ix_posts_slug_trgm",
            literal_column("(slug::text)").label("slug_text"),
            postgresql_using="gin",
            postgresql_ops={"slug_text": "gin_trgm_ops"},
        ),
    )

    # ---------------------------------------------------------------------------------
    # Relationships
    #
    # Four edges: one many-to-one up to the owning account, one many-to-many across the
    # taxonomy, and two one-to-many collections down to the rows that hang off a post.
    #
    # The cascade settings are not uniform, and the difference is the whole design:
    #
    #   author       no cascade at all. Deleting a post must never touch the account that
    #                wrote it; the arrow points the other way, and User.posts owns that half.
    #   categories   NO delete-orphan. On a many-to-many that would delete the CATEGORY rows
    #                when a post is removed, which is plainly wrong - removing an article must
    #                remove only its filing. The ON DELETE CASCADE on post_categories.post_id
    #                already removes exactly the association rows and nothing else.
    #   comments     cascade="all, delete-orphan" + passive_deletes=True. A comment and a like
    #   likes        have no meaning apart from the post they belong to, so detaching one from
    #                the collection deletes it, and the ON DELETE CASCADE on each child's
    #                foreign key lets PostgreSQL remove them all in one statement instead of
    #                SQLAlchemy loading every child in order to delete it row by row.
    #
    # No loading strategy is set on any of them. Under an AsyncSession a lazy collection access
    # raises MissingGreenlet by design, and the supported way to load one is to say so in the
    # statement - selectinload() for the collections, joinedload() for the many-to-one - inside
    # app.repositories.*, which is the only layer that builds statements. An eager default here
    # would impose itself on every query that touched a post, including the feed, which needs
    # neither the comment thread nor the like set.
    # ---------------------------------------------------------------------------------

    author: Mapped[User] = relationship(back_populates="posts")
    """The account that wrote this post - the other half of ``User.posts``.

    Many-to-one and never optional, because :attr:`author_id` is ``NOT NULL``. Loaded eagerly by
    the queries that render a byline, through ``joinedload(Post.author)`` in
    ``app.repositories.post_repository``; the feed needs it for every card, so this is the one
    relationship a listing query almost always asks for.
    """

    categories: Mapped[list[Category]] = relationship(
        # String target, resolved against the declarative registry when mappers are configured.
        # The class is imported under TYPE_CHECKING only; the Table below is the sole runtime
        # dependency, and it is why the runtime import at the top of this module exists.
        "Category",
        secondary=post_categories,
        back_populates="posts",
        # See the block comment above: no delete-orphan on a many-to-many. The default
        # save-update/merge cascade is what is wanted and what stays in force, and
        # passive_deletes=True hands removal of the association rows to the ON DELETE CASCADE
        # already declared on post_categories.post_id.
        passive_deletes=True,
    )
    """The taxonomy terms this post is filed under, in no guaranteed order.

    Assigning through this collection is how association rows are written. It is not how the
    home feed's category filter is evaluated: that query joins through ``post_categories``
    directly in ``app.repositories.post_repository``, so the filter composes with relevance
    search, author filtering, status scoping, ordering and windowing in one statement without
    loading any category entity at all.

    The composite primary key on the association relation means the same category cannot appear
    twice here - duplicate filing is rejected by the database rather than by an
    application-level de-duplication step some future call site could forget.
    """

    comments: Mapped[list[Comment]] = relationship(
        back_populates="post",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    """Every comment on this post, in any moderation state and at any depth.

    Deliberately unfiltered and unordered: this is the ownership edge, not a public projection.
    A reader sees only approved comments, and sees them threaded and paginated in creation
    order - all three of which are properties of the query behind that view, which lives in
    ``app.repositories.comment_repository``.

    Threading is a self-reference on the comment itself rather than a second collection here, so
    this collection is flat: it contains replies as well as top-level comments.
    """

    likes: Mapped[list[PostLike]] = relationship(
        back_populates="post",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    """Every like granted to this post.

    ``post_likes`` is keyed on ``(post_id, user_id)``, so the collection cannot contain the same
    account twice - idempotency is a property of the composite primary key rather than something
    this side has to police, which is what makes a repeated ``PUT /api/v1/posts/{id}/like`` safe
    to retry and what stops a repeated request inflating the count.

    The count itself is an aggregate issued by ``app.repositories.like_repository``, not a stored
    column on this relation and not ``len()`` over this collection. A stored counter would be a
    second source of truth that every like, unlike and cascading delete had to remember to
    update; loading the whole collection to count it would fetch every row to return one number.
    """
