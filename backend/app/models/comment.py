"""The ``comments`` relation - a post's discussion thread, its threading and its moderation.

Two names are declared here and nowhere else: :class:`CommentStatus`, the three-valued
moderation state an administrator moves a comment between, and :class:`Comment`, the mapped
class behind the ``comments`` table. Between them they carry the reader-authored half of the
product - the only rows in the schema written by an account that does not own the post they
hang off - and the two guarantees that half rests on: a reply is attached to the comment it
answers, and nothing a reader writes reaches a public surface until it carries
:attr:`CommentStatus.APPROVED`.

``app.schemas.comment`` and ``app.schemas.admin`` import :class:`CommentStatus` from this
module rather than re-declaring it, because an enumerated type declared twice is two contracts
that can disagree. ``app.repositories.comment_repository`` builds both the threaded public
listing and the administrative moderation queue over :class:`Comment`.
``app.services.comment_service`` owns creation with parent validation, ownership-scoped edit
and delete, the moderation transitions and the sanitisation of every body written through the
API. ``app.db.seed`` creates the demonstration thread.

What it replaces
----------------
Nothing. The service this repository grew out of had exactly one data contract - a
client-supplied integer identifier and two unowned scalar fields, quoted verbatim in the
"What it replaces" section of :mod:`app.db.base` so the retired shape is recorded once rather
than in all seven models - and no comment, author, thread or moderation concept existed
anywhere in it. This relation is new in its entirety.

Two properties of that retired contract are nonetheless defects this relation is written to
avoid rather than inherit:

* **Identity was the client's to supply.** The server neither generated the key nor checked it
  for uniqueness, so a duplicate identifier permanently shadowed every later row that carried
  it. Here identity comes from :class:`~app.db.base.UUIDPrimaryKeyMixin` over PostgreSQL's
  ``gen_random_uuid()`` and no caller can supply it - which matters more on this relation than
  on most, because its rows are created by unprivileged principals.
* **There was no ownership and no referential integrity.** :attr:`Comment.post_id` and
  :attr:`Comment.author_id` are both ``NOT NULL`` and both reference a real relation, so every
  comment has exactly one post and exactly one author. That is what lets
  ``app.services.comment_service`` scope editing authority to the rows a principal owns
  instead of trusting a field in the request.

Threading
---------
:attr:`Comment.parent_id` is a **self-referencing** foreign key to ``comments.id``, and it is
nullable. Those two facts together are the whole of the threading design: ``NULL`` means a
top-level comment, a value means a reply to the comment it names, and an arbitrarily deep
thread is one relation rather than a second "replies" table whose rows would be
indistinguishable from these.

The alternatives were both rejected, and for the same reason. A separate replies relation
duplicates every column and every constraint, then needs a union to read one thread. A
materialised path or nested-set encoding buys ordered subtree reads at the cost of rewriting
sibling rows on every insert, which is a poor trade for a discussion thread that is read as a
whole and written one leaf at a time. The adjacency list keeps a reply's cost proportional to
the reply.

Depth is deliberately unbounded *here*. A cap - if the product ever wants one - is a rule
about what may be created, and rules about what may be created live in
``app.services.comment_service``. A ``CHECK`` constraint cannot express it in any case,
because the depth of a row is a property of its ancestors and not of the row.

Deletion
--------
Three foreign keys, all three ``ON DELETE CASCADE``, and each one discharges a stated
guarantee:

* ``post_id`` - deleting a post removes its comments. The post is the thread's whole context;
  a comment on a post that no longer exists is unreachable by construction.
* ``author_id`` - deleting an account removes the comments it wrote.
* ``parent_id`` - deleting a comment removes its replies, *recursively*. PostgreSQL applies the
  cascade to the rows that referenced the deleted row, which then cascades again from each of
  those, so an entire subtree is removed by the one statement that removes its root. Verified
  behaviour of the constraint rather than an application loop.

The ORM half of each guarantee is ``passive_deletes=True`` on the owning collection -
``Post.comments``, ``User.comments`` and :attr:`Comment.replies` - which tells SQLAlchemy to
let the database do the work instead of loading every child in order to delete it row by row.
Neither half is optional: the cascade without the flag is correct but loads the whole subtree,
and the flag without the cascade orphans rows. The self-referencing pair is where the
difference is largest, because a reply chain has no bounded depth and the loading strategy
would issue one round trip per level.

Import direction
----------------
This module holds **no runtime import of another model**. All three foreign keys are expressed
as strings - ``"posts.id"``, ``"users.id"``, ``"comments.id"`` - and every relationship names
its target by class name, so :class:`~app.models.post.Post` and :class:`~app.models.user.User`
are imported under :data:`typing.TYPE_CHECKING` for the annotations alone. That direction is
forced rather than chosen: ``post.py`` and ``user.py`` both import ``Comment`` under
:data:`typing.TYPE_CHECKING` for their own reverse annotations, so a runtime import here would
close a genuine cycle and make the import order of ``app.models`` load-bearing. SQLAlchemy
de-stringifies each annotation and resolves the target through the declarative registry when
mappers are configured, which ``app.models.__init__`` triggers for both the migration runner
and the test harness.

The self-reference needs no import at all, because the class is in its own module namespace by
the time mappers are configured.

Access paths
------------
Five indexes serve this relation, and each exists for a query the product actually issues:

* ``ix_comments_post_id_created_at`` over ``(post_id, created_at)`` - the public thread read,
  "this post's comments in the order they were written", which is the most-issued query
  against this relation. Leading with the equality column and following with the sort column is
  what lets one index satisfy both the filter and the ordering, so the planner needs no
  separate sort step.
* ``ix_comments_status`` - the administrative moderation queue, which selects by state across
  every post rather than within one.
* ``ix_comments_parent_id_status`` over ``(parent_id, status)`` - the recursive descent that
  builds a thread of any depth. ``app.repositories.comment_repository`` walks the tree with a
  recursive common table expression whose every step asks "the replies to these comments, in the
  states this caller may see", so the join column leads and the filter column follows and one
  index satisfies both halves at every level. Measured on PostgreSQL 18.4 at twenty thousand
  comments: the recursive term plans as an index scan on this index with
  ``Index Cond: ((parent_id = ...) AND (status = ...))``.
* ``ix_comments_author_id`` - the referencing side of the ``users`` foreign key, so removing an
  account locates the comments it wrote by index rather than by scanning the relation, and an
  administrator moderating one account rather than one post has an access path.
* ``ix_comments_body_trgm`` - a GIN trigram index over ``body``, for the moderation queue's
  optional text search. That predicate is ``ILIKE '%term%'``, which no B-tree can serve at any
  size, so this is the only index that can answer it. ``body`` is plain ``TEXT``, so the operator
  class sits directly on the column and the repository needs no cast.

Two of those five cover a **referencing** foreign-key column, and that is the reason they exist
rather than an afterthought: PostgreSQL indexes a *referenced* key automatically and a
referencing column not at all. Left undeclared, ``parent_id`` would make every level of a
thread a sequential scan over the whole relation - one per level of depth, on the busiest public
surface in the product - and ``author_id`` would make deleting a single account scan every
comment in the system.

This module is the reference side of ``alembic check``, so every index above has a counterpart in a
revision and the two sides must be edited together; a sixth declared here alone would be reported
as drift that no schema change caused. Adding an access path later is a revision, which is the
correct way for one to appear. The counterpart is not always the same revision: the four B-tree
indexes are built by ``0001``, while ``ix_comments_body_trgm`` is built by ``0002``, where every GIN
index in this schema lives so that the expensive half of the build stays replayable on its own.

What is deliberately not here
-----------------------------
Schema only. The boundary is worth stating column by column, because this relation attracts
behaviour from three directions at once - authorship, moderation and threading:

* **No parent validation.** That a reply's parent exists, is not itself deleted and belongs to
  the *same post* is a creation rule, and it lives in ``app.services.comment_service``. The
  database can enforce that ``parent_id`` names a real comment; it cannot enforce that the
  named comment hangs off the same post without a redundant column, and a redundant column is
  a second source of truth. This module holds the reference and the cascade.
* **No moderation transition.** Nothing here approves, rejects or re-opens a comment. There is
  no ``approve()`` method and no ``is_visible`` property: a state machine that lives on the
  mapped class is a state machine that runs wherever the class happens to be loaded, and a
  visibility predicate on the class is a predicate every query is then free to forget.
  ``app.services.comment_service`` performs all three transitions - an administrator's approval,
  an administrator's rejection, and the return to :attr:`CommentStatus.PENDING` that an author's
  edit of an approved comment requires - and
  ``app.repositories.comment_repository`` filters on :attr:`CommentStatus.APPROVED`
  explicitly, which is what makes public visibility a property of the query.
* **No sanitisation.** :attr:`Comment.body` is a column. Reader-authored text is cleaned on
  write by the service layer, and ``bleach`` is deliberately not imported here even though it
  is a declared dependency of the service - sanitising in a mapped class would run the cleaner
  again on every row read back out of the database.
* **No ownership check.** ``author_id`` records who wrote a row; deciding what that permits is
  ``app.services.comment_service`` and ``app.core.dependencies``, and every protected
  operation re-checks it server-side.
* **No statement of any kind.** No query, no classmethod finder, no hybrid property, no
  property that filters a collection. Every statement in the backend is built in
  ``app.repositories.*``; the threaded read and the moderation queue belong to
  ``app.repositories.comment_repository`` in one place.

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
have a counterpart in a revision.

* ``migrations/versions/0001_initial_blog_schema.py`` creates the ``comment_status``
  enumerated type with the three labels below **in this order**, and renders the table, its
  primary key, all three ``ON DELETE CASCADE`` foreign keys and all four B-tree indexes. The
  ``name="comment_status"`` passed below must be spelled exactly as the revision spells it,
  because a mismatch is an ``alembic check`` drift report that no schema change caused.
* ``app.models.__init__`` re-exports both :class:`Comment` and :class:`CommentStatus`; a
  relation the migration runner never imports is a relation autogeneration cannot see.
* ``app.models.post`` pairs ``back_populates="post"`` against :attr:`Comment.post`, and
  ``app.models.user`` pairs ``back_populates="author"`` against :attr:`Comment.author`. Those
  two attribute names are fixed by the collections already declared in those modules.
* ``app.schemas.comment`` projects nested replies over :attr:`Comment.replies`, so that
  attribute name is part of the contract as well.
"""

from __future__ import annotations

import enum
import uuid
from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, Index, Text, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    # Annotation-only imports, and they must never become runtime imports: both modules
    # import `Comment` under TYPE_CHECKING for their own reverse annotations, so importing
    # either here would close a cycle and make the import order of app.models load-bearing.
    # The foreign keys below name their targets as strings and each relationship resolves its
    # target by class name through the declarative registry, so neither needs a class object
    # at import time. `Comment` itself is not listed - a module is its own namespace.
    from app.models.post import Post
    from app.models.user import User

__all__ = ["Comment", "CommentStatus"]


class CommentStatus(enum.StrEnum):
    """The three moderation states a comment can be in.

    Persisted as the native PostgreSQL enumerated type ``comment_status``. Moderation is an
    explicit state and deliberately not a boolean ``is_approved`` flag, because ``PENDING`` and
    ``REJECTED`` are not two spellings of "not visible": the first is work an administrator has
    still to do, the second is a decision already taken. Collapsing them would leave the
    moderation queue indistinguishable from the pile of rejections behind it, and would leave
    ``PATCH /api/v1/admin/comments/{id}/status`` with nothing to move a comment *back* to.

    Each member's value is **identical to its own name**, which is load-bearing rather than
    redundant. SQLAlchemy derives an enumerated type's PostgreSQL labels from the Python member
    *names* by default, while a ``values_callable`` derives them from the *values*; making the
    two identical means both resolutions coincide, so the labels stored in the database are
    unambiguously uppercase however the type is configured, and a hand-written revision or a
    literal in a data migration can spell them one way.

    :class:`enum.StrEnum` is the spelling used rather than a ``(str, enum.Enum)`` mixin, for the
    same three reasons recorded on :class:`app.models.user.UserRole` and
    :class:`app.models.post.PostStatus`, all re-verified here against the pinned toolchain:
    ``ruff``'s ``UP042`` rejects the mixin form outright under ``target-version = "py314"`` and
    ``ruff check backend`` is a blocking gate; :class:`enum.StrEnum` *is* a :class:`str`
    subclass, so ``issubclass(CommentStatus, str)`` and ``CommentStatus.APPROVED == "APPROVED"``
    both hold and SQLAlchemy derives the same uppercase labels under either spelling; and
    ``f"{CommentStatus.APPROVED}"`` renders as ``APPROVED`` rather than as a Python repr, so an
    interpolated state in a log line reads as the label.

    Only membership is declared here. Which transitions are legal and who may perform them are
    decided in ``app.services.comment_service``, and which state a reader may see is decided by
    the query in ``app.repositories.comment_repository`` - the public thread filters on
    :attr:`APPROVED` explicitly, which is what stops an unapproved comment leaking through it.
    """

    PENDING = "PENDING"
    """Awaiting a decision: the state every comment is created in, and returns to when edited.

    Invisible to the public thread, and visible to an administrator as the moderation queue -
    which is the whole reason this state is distinct from :attr:`REJECTED`. A comment sits here
    until an administrator moves it on, and its author can still see and edit it, because
    authorship and visibility are separate questions.

    Reachable a second way, and that is deliberate: editing an :attr:`APPROVED` comment returns it
    here. So this state means "unreviewed text", whether the text is new or replaced, rather than
    only "newly submitted".
    """

    APPROVED = "APPROVED"
    """Moderated and public: listed in the post's thread and counted in its reply totals.

    The only state a public caller ever sees. ``app.repositories.comment_repository`` filters on
    this member explicitly rather than excluding the other two, so a fourth state added later
    would default to invisible instead of silently appearing in every thread.

    Approval attaches to the text that was reviewed, not to the row: an author who edits an
    approved comment returns it to :attr:`PENDING`, because approval of what a moderator read is
    not approval of whatever replaces it.
    """

    REJECTED = "REJECTED"
    """Refused by an administrator, retained rather than deleted.

    Distinct from :attr:`PENDING`, and the distinction is why the lifecycle has three states
    rather than two: a rejection is a decision that has been taken, so the row stays out of the
    queue an administrator still has to work through. Retaining the row rather than deleting it
    keeps the decision reversible - moderation with an undo - and keeps a repeat offender's
    history visible; deletion remains separately available through
    ``DELETE /api/v1/admin/comments/{id}``.
    """


class Comment(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A single comment on a post: reader-authored text, threaded and moderated.

    Eight columns, three of them inherited. ``id`` comes from
    :class:`~app.db.base.UUIDPrimaryKeyMixin` and is produced by PostgreSQL; ``created_at`` and
    ``updated_at`` come from :class:`~app.db.base.TimestampMixin` and are stamped from the
    database clock. Both mixins apply, and ``updated_at`` earns its place here rather than
    arriving by habit: a comment body is editable, so ``updated_at > created_at`` is a reliable
    "has been edited" test on this relation, which is exactly the reason ``refresh_tokens``
    declines the same pair.

    Constructing one - the body arrives already sanitised, because sanitising it belongs to
    ``app.services.comment_service``::

        comment = Comment(
            post_id=post.id,
            author_id=principal.id,
            body="Clear write-up, thanks.",
        )

    A reply names the comment it answers, and nothing else about it differs::

        reply = Comment(
            post_id=post.id,
            author_id=principal.id,
            parent_id=comment.id,
            body="Agreed, the second half especially.",
        )

    Both leave :attr:`status` at its database-level default of :attr:`CommentStatus.PENDING`,
    which is the state a newly submitted comment must be in: recorded, readable by its author
    and by an administrator, and absent from the public thread until it is approved.

    Reading a relationship requires it to have been populated by the statement that fetched the
    row - ``selectinload(Comment.author)``, and for :attr:`replies` the recursive descent and
    in-memory assembly in ``app.repositories.comment_repository``, which fills the collection at
    every level of a thread. All four relationships keep SQLAlchemy's default lazy strategy on
    purpose: under an ``AsyncSession`` a lazy load raises ``MissingGreenlet`` at the point of
    access, which surfaces a missing eager-load option immediately instead of hiding an N+1 behind
    a thread that still renders.

    Nothing on this class is a method. It is a mapped shape, three database-enforced cascades
    and four relationship declarations - all of which are schema. Every behaviour that reads
    them lives in ``app.repositories.*`` and ``app.services.*``.
    """

    __tablename__ = "comments"

    post_id: Mapped[uuid.UUID] = mapped_column(
        # The type is spelled out rather than left to the annotation, because
        # app.db.base.UUIDPrimaryKeyMixin asks that a model referencing one of its `id` columns
        # state the identical type - both sides of the reference are then visibly the same, and
        # revision 0001 has one unambiguous spelling to render.
        postgresql.UUID(as_uuid=True),
        # A string target rather than an imported Column: resolving "posts.id" is deferred until
        # the metadata is used, which is what keeps this module free of a runtime edge to
        # app.models.post.
        #
        # ON DELETE CASCADE is mandatory, not defensive. It is the database half of "deleting a
        # post removes its comments and likes", whose ORM half is the passive_deletes=True
        # already declared on Post.comments. Neither half is optional: the cascade without the
        # flag is correct but loads every child first, and the flag without the cascade orphans
        # rows that no query would ever reach again.
        ForeignKey("posts.id", ondelete="CASCADE"),
        nullable=False,
        # Deliberately NOT index=True. This column leads the composite
        # ix_comments_post_id_created_at declared in __table_args__ below, which serves the
        # thread read's filter and its ordering together; a single-column index over the same
        # leading column would be redundant with it and would put this model out of step with
        # revision 0001.
    )
    """The post whose thread this comment belongs to.

    ``NOT NULL``: a comment with no post has no context and no route that could render it, so
    there is no state in which a free-floating row would be meaningful. Every read of a thread
    is addressed by this column, through ``ix_comments_post_id_created_at``.

    A reply carries the same value as its parent. That is a rule about creation rather than a
    property of the schema - the database cannot compare a reply's post to its parent's without
    a redundant column - so ``app.services.comment_service`` validates it, and this column
    records the answer.
    """

    author_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True),
        # ON DELETE CASCADE, so deleting an account removes the comments it wrote. Its
        # counterpart is passive_deletes=True on User.comments. Removing an account must not
        # leave text behind attributed to a principal that no longer resolves.
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        # Deliberately NOT index=True, but it IS indexed: ix_comments_author_id is declared in
        # __table_args__ below alongside the other three, so the whole access-path inventory for
        # this relation reads in one place and matches revision 0001 object for object. Declaring
        # it here as well would create a duplicate index the revision could not reproduce.
    )
    """The account that wrote this comment. ``NOT NULL``, so every comment is attributable.

    This column is the entire basis of ownership-scoped authority over a comment:
    ``app.services.comment_service`` compares it against the resolved principal to decide
    whether an edit or a delete may proceed, and an administrator bypasses the comparison. The
    comparison itself is not here - a mapped class that decides who may act on it is a mapped
    class whose authority rules run wherever it happens to be loaded.
    """

    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        postgresql.UUID(as_uuid=True),
        # The self-referencing foreign key that makes threading work, and the one cascade that
        # is recursive: PostgreSQL applies ON DELETE CASCADE to the rows referencing the deleted
        # row, then again from each of those, so removing a comment removes its entire subtree in
        # the one statement. That is what makes "deleting a parent removes its replies" a
        # database guarantee rather than application bookkeeping - and why passive_deletes=True
        # on Comment.replies matters more here than anywhere else in the schema: a reply chain
        # has no bounded depth, so the loading alternative issues one round trip per level.
        ForeignKey("comments.id", ondelete="CASCADE"),
        # NULLABLE, and this is the representation of depth rather than an accommodation of
        # missing data: NULL is a top-level comment, a value is a reply to the comment it names.
        # A NOT NULL column here would leave no way to express the root of a thread.
        nullable=True,
        # Deliberately NOT index=True. This column LEADS the composite
        # ix_comments_parent_id_status declared in __table_args__ below, which serves both the
        # recursive descent that builds a thread and the moderation filter applied at every level
        # of it; a single-column index over the same leading column would be redundant with it
        # and would put this model out of step with revision 0001.
    )
    """The comment this one replies to, or ``None`` when it is top-level.

    Threading is this column and nothing else. A thread of any depth is built by
    ``app.repositories.comment_repository`` from one post's rows, and projected as nested
    replies by ``app.schemas.comment`` over :attr:`replies`; no second relation and no path or
    nested-set encoding is involved, so a reply costs exactly one row.

    Deliberately unconstrained beyond the reference. Depth is uncapped, and that a parent must
    belong to the same post as its reply is enforced by ``app.services.comment_service`` on
    creation - the database can guarantee the parent exists, which is what this foreign key
    does.
    """

    body: Mapped[str] = mapped_column(
        # TEXT, and unbounded on purpose. Base.type_annotation_map resolves `str` to TEXT
        # already; stating it keeps the choice legible next to the column rather than inherited
        # silently from a module two directories away. A length limit that is genuinely part of
        # the contract belongs in app.schemas.comment, where a violation becomes a 422 instead
        # of a database error - and changing that limit is then not a schema migration.
        Text,
        nullable=False,
    )
    """The comment text, already sanitised.

    ``app.services.comment_service`` cleans reader-authored input with ``bleach`` on write, so
    what is stored here is what is safe to render. Sanitising is deliberately a write-path
    concern and is not repeated in this module: a cleaner invoked from a mapped class would run
    again on every row read back out of the database, and would make the stored value and the
    served value two different strings.

    ``NOT NULL``, and non-emptiness is a schema-layer rule rather than a ``CHECK`` constraint -
    a whitespace-only body is a validation failure the client must be told about field by field,
    which is a ``422`` from ``app.schemas.comment`` and not a database error.
    """

    status: Mapped[CommentStatus] = mapped_column(
        # Native PostgreSQL enumerated type. `create_type=False` is mandatory: revision 0001
        # creates `comment_status` in upgrade() and drops it in downgrade(), so SQLAlchemy must
        # not emit a competing CREATE TYPE alongside the CREATE TABLE. Omitting the flag stops
        # the upgrade with `psycopg.errors.DuplicateObject: type "comment_status" already
        # exists`. The name is spelled exactly as the revision spells it, because a mismatch is
        # an alembic-check drift report that no schema change caused.
        postgresql.ENUM(CommentStatus, name="comment_status", create_type=False),
        nullable=False,
        # PENDING rather than APPROVED, deliberately. The default is the least-privilege one:
        # nothing a reader writes becomes public until an administrator moves it on, which is
        # what "only approved comments are visible publicly" means when the default is the
        # floor rather than an afterthought, and it is what gives the moderation queue rows to
        # hold. Post-hoc moderation - defaulting to APPROVED and withdrawing later - would make
        # the queue permanently empty and the admin screen decorative.
        #
        # This does NOT make the public thread untestable, because a server default is only a
        # floor: `app.db.seed` and the integration factories pass
        # status=CommentStatus.APPROVED explicitly for the rows that must be publicly visible,
        # and the moderation endpoint is the other way to reach that state.
        #
        # `'PENDING'::comment_status` is the spelling PostgreSQL reflects back for this default,
        # so the model side and the reflected side compare equal under compare_server_default.
        # Defaulting at the DATABASE level rather than in Python means a row inserted by a
        # revision, by a data migration or by any other client starts pending too.
        server_default=text("'PENDING'::comment_status"),
    )
    """The comment's moderation state, defaulting to :attr:`CommentStatus.PENDING`.

    The public thread filters on :attr:`CommentStatus.APPROVED` explicitly in
    ``app.repositories.comment_repository``, which is what makes moderation a property of every
    query rather than of remembering to add a predicate.

    ``app.services.comment_service`` owns every transition between the three states, and the
    authority is asymmetric by design: an administrator is the only principal who can move a
    comment *into* :attr:`CommentStatus.APPROVED` or :attr:`CommentStatus.REJECTED`, and no input
    model reachable by a comment's author carries this column. An author's edit nonetheless moves
    it, in the one safe direction - editing an approved comment returns it to
    :attr:`CommentStatus.PENDING`, so the replaced text is reviewed before it is public again. That
    transition is applied by the service, never chosen by the caller, which is what stops approval
    of benign text from becoming standing approval of whatever replaces it.
    """

    # ---------------------------------------------------------------------------------
    # Access paths
    #
    # Four explicitly named indexes, matching the schema's authoritative index inventory for
    # this relation, and each one exists for a query this product actually issues. None is also
    # expressed as `index=True` on its column: declaring an index twice creates a duplicate
    # object that revision 0001 could not reproduce.
    #
    # The names are spelled out rather than left to the `ix_%(column_0_label)s` convention in
    # app.db.base, which app.db.base itself asks for on composite indexes - naming one of these
    # among its examples - because the derived name would describe only the first of two
    # columns and would collide with any future single-column index on that column.
    #
    # Two of the four cover columns that carry a foreign key, and that is not incidental.
    # PostgreSQL creates an index on a REFERENCED key automatically and none at all on a
    # REFERENCING column, so `parent_id` and `author_id` are unindexed unless said so here -
    # which would leave the recursive descent below and every ON DELETE CASCADE from `users`
    # scanning the whole relation once per level and once per deleted account respectively.
    # ---------------------------------------------------------------------------------
    __table_args__ = (
        Index(
            # The public thread read: "this post's comments, oldest first". Leading with the
            # equality column and following with the sort column is what lets one index satisfy
            # both the filter and the ordering, so the planner needs no separate sort. Ascending
            # rather than descending, because a discussion reads forwards - unlike the feed,
            # whose ix_posts_status_published_at is descending for the same reason inverted.
            "ix_comments_post_id_created_at",
            "post_id",
            "created_at",
        ),
        Index(
            # The administrative moderation queue: select by state across every post. This is
            # the access path that makes CommentStatus useful operationally rather than merely
            # descriptive, and it is why the column is indexed on its own as well as being
            # filtered inside a post's thread.
            "ix_comments_status",
            "status",
        ),
        Index(
            # The moderation queue's DEFAULT ordering, which the status index above cannot serve.
            # `app.repositories.comment_repository.list_moderation_queue` windows comments with
            # `ORDER BY created_at DESC, id DESC` across every post, and the status filter is
            # OPTIONAL - the unfiltered queue is the ordinary first view, so the common case has
            # no equality predicate for ix_comments_status to lead with. Without this index each
            # page sorts the whole `comments` relation before applying LIMIT, on what is the
            # largest relation in this schema by row count.
            #
            # Descending both columns, matching the query exactly: a queue is worked from the top,
            # which is the inverse of ix_comments_post_id_created_at's ascending thread order and
            # inverted for the same reason. `id DESC` is the deterministic tiebreaker - a batch of
            # comments written by one request shares a per-transaction `created_at` instant, and
            # an unspecified order under LIMIT/OFFSET is how a row appears on two consecutive
            # pages while another appears on none.
            #
            # `text()` is the string-safe spelling for a directional expression inside
            # __table_args__, exactly as ix_posts_status_published_at uses it: `created_at.desc()`
            # is unavailable here because the mixin's column object is not in scope at class-body
            # evaluation time. Built by revision 0004.
            "ix_comments_created_at_id",
            text("created_at DESC"),
            text("id DESC"),
        ),
        Index(
            # The thread's recursive descent, and the one index a threaded discussion cannot be
            # read without. app.repositories.comment_repository walks the tree with a recursive
            # CTE whose every step is "the replies to these comments, in the states this caller
            # may see" - `parent_id = ? AND status IN (...)` - so leading with the join column
            # and following with the filter column lets one index satisfy both halves at every
            # level. Measured on PostgreSQL 18.4 at 20k comments: the recursive term plans as
            # `Index Scan using ix_comments_parent_id_status` with
            # `Index Cond: ((parent_id = ...) AND (status = ...))`. Without it each level is a
            # sequential scan over the whole relation, and a thread costs one such scan per
            # level of depth.
            #
            # It also serves the self-referencing ON DELETE CASCADE: removing a comment makes
            # PostgreSQL find the rows referencing it, at every level of the subtree.
            "ix_comments_parent_id_status",
            "parent_id",
            "status",
        ),
        Index(
            # The referencing side of the users foreign key. Its first job is the cascade:
            # deleting an account removes the comments it wrote, and PostgreSQL locates them by
            # this column, so without the index removing one account scans every comment in the
            # system. Its second is any author-scoped listing - "everything this principal has
            # written" is the shape an administrator reaches for when moderating a single
            # account rather than a single post.
            "ix_comments_author_id",
            "author_id",
        ),
        Index(
            # The moderation queue's optional body search. `body` is unbounded TEXT and the match
            # is `ILIKE '%term%'`, which no b-tree can serve at all, so without this index every
            # keystroke in that search box is a sequential scan over every comment in the system -
            # the largest relation in this schema by row count.
            #
            # `body` is TEXT, so the operator class goes straight on the column and
            # app.repositories.comment_repository needs no cast: `Comment.body.ilike(...)` uses
            # this index directly. Verified on PostgreSQL 18.4: the predicate plans as an
            # `Index Cond` on it at any size, and the planner prefers it to reading the relation
            # once the relation is big enough for that to pay - a scan still wins at twenty
            # thousand comments, the index wins at two hundred thousand.
            #
            # GIN rather than b-tree because gin_trgm_ops indexes the
            # three-character substrings of the value, which is what makes a leading wildcard
            # answerable at all. The index build belongs to revision 0002, where every GIN index
            # in this schema lives.
            "ix_comments_body_trgm",
            "body",
            postgresql_using="gin",
            postgresql_ops={"body": "gin_trgm_ops"},
        ),
    )

    # ---------------------------------------------------------------------------------
    # Relationships
    #
    # Four edges: two many-to-one up to the rows that own this one, and a self-referential
    # pair that is the same edge seen from both ends.
    #
    # The cascade settings are not uniform, and the difference is the design:
    #
    #   post, author, parent   no cascade at all. Deleting a comment must never touch the post
    #                          it is on, the account that wrote it, or the comment it answers;
    #                          the arrows point the other way, and the owning collection on
    #                          each of those classes owns that half.
    #   replies                cascade="all, delete-orphan" + passive_deletes=True. A reply has
    #                          no meaning apart from the comment it answers, so detaching one
    #                          from the collection deletes it, and the ON DELETE CASCADE on
    #                          parent_id lets PostgreSQL remove a whole subtree in one
    #                          statement instead of SQLAlchemy loading each level to delete it.
    #
    # No loading strategy is set on any of them, for the reason given in the class docstring.
    # ---------------------------------------------------------------------------------

    post: Mapped[Post] = relationship(back_populates="comments")
    """The post this comment is on - the other half of ``Post.comments``.

    Many-to-one and never optional, because :attr:`post_id` is ``NOT NULL``. Loaded through
    ``joinedload(Comment.post)`` by the administrative moderation queue, which lists comments
    across every post and needs each row's context to be renderable.
    """

    author: Mapped[User] = relationship(back_populates="comments")
    """The account that wrote this comment - the other half of ``User.comments``.

    Many-to-one and never optional, because :attr:`author_id` is ``NOT NULL``. Loaded eagerly by
    every query that renders a thread, through ``joinedload(Comment.author)`` in
    ``app.repositories.comment_repository``: a comment without its author's display name and
    avatar cannot be presented, so this is the one relationship a listing query always asks for.
    """

    parent: Mapped[Comment | None] = relationship(
        # String target, resolved against the declarative registry when mappers are configured -
        # the same treatment the other two edges get, so nothing here forces a runtime import.
        "Comment",
        # remote_side is REQUIRED on this side and is not a hint. Both ends of a self-reference
        # sit on one table, so without it SQLAlchemy cannot tell which end of comments.parent_id
        # -> comments.id is the "one" and which is the "many", and mapper configuration fails
        # with an ambiguity error rather than merely guessing wrong. Naming `Comment.id` marks
        # the primary-key end as remote, which makes this the many-to-one half.
        #
        # A string rather than the column object because `id` is contributed by
        # UUIDPrimaryKeyMixin and is therefore not in scope in this class body; SQLAlchemy
        # evaluates the string in the registry's namespace at configuration time.
        remote_side="Comment.id",
        back_populates="replies",
    )
    """The comment this one replies to, or ``None`` when it is top-level.

    The entity side of :attr:`parent_id`. No cascade: deleting a reply must not touch the
    comment it answered. Reaching a whole ancestor chain through this attribute would be one
    round trip per level, which is why ``app.repositories.comment_repository`` assembles a
    thread from one post's rows instead.
    """

    replies: Mapped[list[Comment]] = relationship(
        "Comment",
        back_populates="parent",
        # A reply has no meaning apart from its parent, so detaching one from this collection
        # deletes it rather than leaving a row with a dangling intent.
        cascade="all, delete-orphan",
        # Hands removal to the ON DELETE CASCADE on parent_id. This is the flag that turns
        # "deleting a parent removes its replies" into one statement: without it SQLAlchemy
        # loads every descendant, one query per level, in order to delete rows the database was
        # going to remove anyway.
        passive_deletes=True,
    )
    """The direct replies to this comment, in any moderation state and in no guaranteed order.

    One generation only, and deliberately unfiltered: this is the ownership edge, not a public
    projection. Depth is unbounded - a reply's own replies hang off *its* collection, and nothing
    in the schema caps how far that goes - which is precisely why
    ``app.repositories.comment_repository`` reads a thread with a recursive query over
    :attr:`parent_id` rather than through this relationship. A loader can follow one generation;
    a thread can be deeper than one.

    That module then populates this collection at every level with
    :func:`~sqlalchemy.orm.attributes.set_committed_value`, which is the only safe way to write a
    collection carrying ``delete-orphan``: a plain assignment would emit removal events and delete
    the very replies being nested. A reader sees only approved replies, ordered, and both are
    properties of that query rather than of this declaration. ``app.schemas.comment`` projects this
    attribute as the recursive reply list on the public representation.
    """
