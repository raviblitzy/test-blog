"""admin listing indexes

Revision ID: 0004
Revises: 0003
Create Date: 2026-08-09 08:40:00.000000+00:00

The three access paths the administrative tables order by, and the only revision in this history
whose subject is a *default ordering* rather than a relation, a generated column or a row.

It adds one B-tree index to each of ``users``, ``posts`` and ``comments``::

    ix_users_created_at_id        (created_at DESC, id DESC)
    ix_posts_published_at_id      (published_at DESC NULLS LAST, id DESC)
    ix_comments_created_at_id     (created_at DESC, id DESC)

Between them they turn the first page of every administrative management screen from "sort the
whole relation, then take twenty rows" into an index scan that stops after twenty. No index in
``0001`` or ``0002`` could serve any of the three, and the reason is the same in each case: an
index only supplies an ordering when its own leading columns are the ones the query orders by.

What was missing, per surface
-----------------------------
**Users.** ``app.repositories.user_repository.list_users`` windows the relation with
``ORDER BY created_at DESC, id DESC`` and neither column was indexed at all - ``0001`` gives
``users`` only its two unique ``citext`` indexes on ``email`` and ``username``, and ``0002`` adds
two GIN trigram indexes for the search box. A unique index on an unrelated column supplies no
ordering, so every page of the user table sorted every account ever registered before applying
``LIMIT``.

**Posts.** ``ix_posts_status_published_at`` is declared ``(status, published_at DESC)``, which
orders rows *within* one status. That is exactly right for the public feed, where
``status = 'PUBLISHED'`` is an equality predicate and the index then yields the recency ordering
for free. The administrative table is the one listing in the product with **no** status predicate:
it reads every lifecycle state in one window ordered ``published_at DESC NULLS LAST, id DESC``
globally. A leading equality column cannot provide a global order, and enumerating all three enum
values into an ``IN`` list cannot either - the plan would have to merge three ordered groups, so
PostgreSQL sorts the relation instead. ``app.services.admin_service.list_posts`` was passing that
exhaustive tuple and now passes ``statuses=None``, which emits no status predicate at all; this
index is what that unfiltered ordering resolves through.

**Comments.** ``ix_comments_status`` serves the *filtered* moderation queue - "show me
``PENDING``" - and ``ix_comments_post_id_created_at`` serves one post's thread, ascending. Neither
serves the queue's default view, which has no status filter and no post filter and orders
``created_at DESC, id DESC`` across the whole relation. ``comments`` is the largest relation in
this schema by row count, so this is the sort worth removing most.

Two spellings that are correctness requirements, not style
----------------------------------------------------------
**``DESC`` belongs in the index.** A B-tree can be walked backwards, so an ascending index can
satisfy a descending ``ORDER BY`` when it is the *only* ordering column. It stops working as soon
as there are two columns and they are not both reversed - ``(created_at DESC, id DESC)`` is a
backwards walk of ``(created_at ASC, id ASC)``, but ``(created_at DESC, id ASC)`` is neither, and
would force a sort. Declaring both directions explicitly means the index order and the query order
are the same order, and the planner needs no sort node.

**``NULLS LAST`` belongs in the index on ``posts``.** A ``DESC`` index column places ``NULL``
*first* by PostgreSQL's default, so an index declared plain ``published_at DESC`` cannot satisfy
``ORDER BY published_at DESC NULLS LAST`` - the two orderings genuinely differ, and the planner
resolves the mismatch with a full sort. A draft has no publication instant, so every surface that
admits drafts must place ``NULL`` explicitly;
``app.repositories.post_repository._recency_ordering`` emits ``NULLS LAST`` for exactly those
surfaces and the plain form for the public feed, which is why ``posts`` needs both this index and
``ix_posts_status_published_at`` rather than one of them.

Why a separate revision, and why B-tree indexes belong in one
-------------------------------------------------------------
``0001`` owns the seven relations and their key indexes, ``0002`` owns ``posts.search_vector`` and
every GIN index in the schema, and ``0003`` owns eight rows. A new index cannot be added to a
revision that has already run, so a new revision is the only place it can go - and this file
follows ``0002``'s own rule for where a new index belongs: a B-tree over key columns goes with the
relation it serves, and anything GIN goes with the text access paths. These three are B-trees, so
they are stated here as their own step, and the file stays DDL-only: no row is written, no column
is added, no constraint is changed.

The model modules are the other half of this revision, and the two halves must agree exactly.
``app.models.user``, ``app.models.post`` and ``app.models.comment`` each declare the matching
``Index`` in ``__table_args__`` with the identical name, columns and directional expressions;
``alembic check`` at ``head`` is what proves they agree, and it is clean. An index created here but
not declared there would be reported as a pending *drop* on the next autogenerate, and one declared
there but not created here as a pending *create* - either way the drift gate speaks, which is what
makes it worth keeping meaningful.

Reversibility
-------------
``downgrade()`` drops exactly the three indexes ``upgrade()`` creates, by name, in the reverse
order, and does nothing else. Nothing depends on them - an index is never referenced by a
constraint, a view or another index here - so removal is unconditional and total, and the schema
afterwards is exactly what ``0003`` left behind. Verified by the up/down/up cycle, including a
single-step ``downgrade -1`` followed by a re-``upgrade``, and by ``alembic check`` reporting no
pending operations at ``head`` both times.

No index is built ``CONCURRENTLY``, and that is not an oversight: Alembic wraps a migration in a
transaction and ``CREATE INDEX CONCURRENTLY`` cannot run inside one, so the flag would abort the
upgrade rather than speed it up. The three builds are ordinary and take a brief ``ROW EXCLUSIVE``
lock on their table, which is the same trade ``0001`` and ``0002`` already make for every index in
the schema.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # --- users ---------------------------------------------------------------------------------
    # The administrative user table's default and only ordering. Both columns descending, so the
    # index order IS the query order - see "Two spellings that are correctness requirements" in
    # the module docstring for why a mixed-direction index would still force a sort.
    #
    # `sa.text()` because a direction is part of an index definition rather than a column name,
    # matching how 0001 spells `published_at DESC` in ix_posts_status_published_at.
    op.create_index(
        "ix_users_created_at_id",
        "users",
        [sa.text("created_at DESC"), sa.text("id DESC")],
    )

    # --- posts ---------------------------------------------------------------------------------
    # The all-status recency ordering ix_posts_status_published_at cannot supply, because that
    # index leads with the equality column `status`. NULLS LAST is written into the index because
    # a DESC index column orders NULL first by default, and a draft carries no publication
    # instant - so the administrative table's `published_at DESC NULLS LAST` is a genuinely
    # different ordering from the public feed's `published_at DESC`, not a spelling of it.
    op.create_index(
        "ix_posts_published_at_id",
        "posts",
        [sa.text("published_at DESC NULLS LAST"), sa.text("id DESC")],
    )

    # --- comments ------------------------------------------------------------------------------
    # The moderation queue's default view: every post, every state, newest first. ix_comments_status
    # serves the FILTERED queue and ix_comments_post_id_created_at serves one post's thread
    # ascending; neither orders the whole relation descending, which is what the first screen an
    # administrator opens actually asks for.
    op.create_index(
        "ix_comments_created_at_id",
        "comments",
        [sa.text("created_at DESC"), sa.text("id DESC")],
    )


def downgrade() -> None:
    # Strict reverse of upgrade(): the three indexes by name, in the opposite order, and nothing
    # else. Dropping in reverse means a partially-applied downgrade fails on the object it
    # genuinely cannot remove rather than on a later one.
    #
    # No extension, column, constraint or row is touched here, because this revision creates
    # none. What remains afterwards is exactly the schema 0003 left behind.
    op.drop_index("ix_comments_created_at_id", table_name="comments")
    op.drop_index("ix_posts_published_at_id", table_name="posts")
    op.drop_index("ix_users_created_at_id", table_name="users")
