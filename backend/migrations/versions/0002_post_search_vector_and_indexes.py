"""post search vector and indexes

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-08 10:00:23.239766+00:00

The search revision, and the first access path this project has ever had. It adds one column
and two indexes to ``posts``:

* ``search_vector`` - a ``tsvector`` column PostgreSQL derives from ``title``, ``excerpt`` and
  ``content`` and stores, declared ``GENERATED ALWAYS AS (...) STORED``.
* ``ix_posts_search_vector`` - a GIN index over that column, the feed's primary search path.
* ``ix_posts_title_trgm`` - a GIN trigram index over ``title``, the typo-tolerant fallback.

Between them they turn ``GET /api/v1/posts?q=...`` from a scan into an index lookup, which is
what makes free-text relevance search one of the composed capabilities of the home feed
alongside category filtering, author filtering, ordering and windowing. The service this
repository grew out of had no index of any kind: every addressed read was a first-match linear
scan over a Python list, so a miss always traversed the whole collection.

Why this is a separate revision from ``0001``
---------------------------------------------
``0001`` creates ``posts`` without ``search_vector`` and without either index, on purpose. The
split keeps the index build a distinct, re-runnable step: adding a stored generated column
rewrites the table and building a GIN index over the result is the expensive half of this
schema, so it is worth being able to replay that half on its own rather than only as part of
creating seven relations from nothing. Folding these three objects back into ``0001`` would
undo that, and it would also make the two revisions disagree with the comments in
``0001`` and ``app/models/post.py`` that both name this file as their owner.

One consequence follows and is expected rather than a problem: ``alembic check`` run against
``0001`` alone legitimately reports these three objects as pending, because
``app/models/post.py`` declares all five of the ``posts`` schema objects that span the two
revisions. Only a check at ``head`` is meaningful, and at ``head`` it is clean.

Three properties of the generating expression are correctness requirements
-------------------------------------------------------------------------
The expression is reproduced verbatim from :data:`app.models.post._SEARCH_VECTOR_EXPRESSION`
in :data:`SEARCH_VECTOR_EXPRESSION` below - character for character, so the model side and the
migration side are one comparable string rather than two paraphrases that can drift. Each of
the three properties has a distinct failure mode if it is spelled differently:

1. **``to_tsvector`` takes two arguments.** The single-argument form reads the calling
   connection's ``default_text_search_config`` and is therefore only ``STABLE``, and PostgreSQL
   refuses a non-``IMMUTABLE`` expression in a generated column. Passing ``'english'``
   explicitly selects the ``to_tsvector(regconfig, text)`` overload, which is ``IMMUTABLE``.
   The failure mode of the short form is a hard error when this revision runs, not a subtly
   wrong result. ``setweight``, ``coalesce`` and the ``tsvector`` ``||`` operator are all
   ``IMMUTABLE`` already and need no such care.
2. **Every operand is wrapped in ``coalesce(col, '')``.** ``excerpt`` is nullable, and in SQL
   ``anything || NULL`` is ``NULL``, so a single unguarded null operand would null the entire
   vector and silently drop that row out of every search result - a data-loss-shaped bug that
   no error message would announce. ``to_tsvector('english', '')`` is a well-defined empty
   vector, so a post with no excerpt contributes nothing to its own index instead of
   destroying it. ``title`` and ``content`` are ``NOT NULL`` today and are wrapped anyway, so
   the expression stays total if either is ever relaxed.
3. **The column is ``STORED``, via ``persisted=True``.** Only a stored generated column can be
   indexed; a ``VIRTUAL`` one could not carry ``ix_posts_search_vector`` at all, which would
   leave the search path without the index this revision exists to build.

``setweight`` assigns descending relevance - ``'A'`` to the title, ``'B'`` to the excerpt,
``'C'`` to the body - so a term in a headline outranks the same term buried in prose;
``ts_rank`` reads those labels to decide it. Verified against PostgreSQL 18.4: a
``websearch_to_tsquery`` search over this expression ordered by ``ts_rank`` returned the seeded
row with rank ``0.389``.

No trigger, and nothing to refresh
----------------------------------
A generated column is the whole mechanism. PostgreSQL re-derives ``search_vector`` on every
``INSERT`` and ``UPDATE`` that touches a source column, so there is no trigger here, no
trigger function, no background task, and no application-side index-maintenance step anywhere
in the service. That is why the publish path sets ``status`` and ``published_at`` and is
finished - the search index cannot be stale relative to the columns it is derived from,
because it is not a separate copy of them. Adding a trigger that recomputed the same value
would be a second mechanism for maintaining one piece of derived state, and two mechanisms
that can disagree are worse than one.

The corollary is that ``search_vector`` is read-only to the application, and PostgreSQL
enforces that: an ``INSERT`` or ``UPDATE`` naming the column is rejected outright.
``app/repositories/post_repository.py`` is its only consumer and only ever reads it.

Never CONCURRENTLY
------------------
Neither index is built with ``CREATE INDEX CONCURRENTLY``, and neither may be. Alembic wraps a
migration in a transaction, ``CONCURRENTLY`` cannot run inside one, and attempting it aborts
the upgrade rather than degrading to a plain build. ``0001`` records the same constraint over
``ix_posts_status_published_at``.

Extensions
----------
``ix_posts_title_trgm`` uses the ``gin_trgm_ops`` operator class, which belongs to the
``pg_trgm`` extension. ``0001`` installs it and ``0001``'s own ``downgrade()`` removes it, so
this revision only *references* it: it neither re-enables it on the way up nor drops it on the
way down. Dropping it here would take the operator class away from a database that ``0001``
still considers itself responsible for, and the next ``upgrade`` in an up/down/up cycle would
fail to build this very index.

Reversibility
-------------
``downgrade()`` is an exact mirror: both indexes by name, then the column, which leaves
``posts`` precisely as ``0001`` created it - twelve columns, four indexes, ``pg_trgm`` still
installed. Verified by the up/down/up cycle, including a single-step ``downgrade -1`` and
re-``upgrade``, which is the case this split-revision design makes worth exercising on its own.

Like ``0001``, this module imports no application code - not ``app.models``, not
``app.db.base``, not ``app.core.config`` - reads no environment variable, embeds no connection
URL or credential, and never calls ``Base.metadata.create_all()``. Schema history has to stay
readable and re-runnable after a model is renamed, so the column name, the type, the
expression and both index names are spelled out literally rather than resolved from live
metadata. ``migrations/env.py`` remains the sole resolver of the connection URL.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# The generating expression, reproduced VERBATIM from app.models.post._SEARCH_VECTOR_EXPRESSION.
#
# Held in a module-level constant for the same reason the model holds one: the string the model
# compiles and the string this revision renders have to be comparable character for character,
# because `alembic check` diffs the reflected generation expression against the model's and a
# paraphrase is drift. Kept as SQL text rather than built from sa.func.* calls because
# sa.Computed() emits its argument verbatim into the DDL, so text is what is actually compared.
#
# Read the module docstring before editing this: the two-argument to_tsvector, the coalesce on
# every operand, and the A/B/C weights are each load-bearing, and changing any of them here
# without changing app/models/post.py in the same edit produces an alembic-check failure that no
# schema change caused.
SEARCH_VECTOR_EXPRESSION: str = (
    "setweight(to_tsvector('english', coalesce(title, '')), 'A') || "
    "setweight(to_tsvector('english', coalesce(excerpt, '')), 'B') || "
    "setweight(to_tsvector('english', coalesce(content, '')), 'C')"
)


def upgrade() -> None:
    # --- posts.search_vector -----------------------------------------------------------------
    # GENERATED ALWAYS AS (...) STORED. `persisted=True` is what renders STORED, and only a
    # stored column can be indexed - the two indexes below are the reason this is not VIRTUAL.
    #
    # Nullable in the DDL although `coalesce` makes the expression total, matching
    # app/models/post.py exactly: PostgreSQL always has a value to store, so the permissiveness
    # costs nothing, and NOT NULL here would be a constraint the application could never help
    # satisfy because it is forbidden from writing the column at all.
    #
    # Adding a stored generated column rewrites the table. That is inherent to the operation
    # rather than a consequence of how it is spelled here, and it is why this revision is
    # separate from 0001 - see the module docstring.
    op.add_column(
        "posts",
        sa.Column(
            "search_vector",
            postgresql.TSVECTOR(),
            sa.Computed(SEARCH_VECTOR_EXPRESSION, persisted=True),
            nullable=True,
        ),
    )

    # --- Full-text index ---------------------------------------------------------------------
    # The feed's primary search path. GIN is the operator class family that indexes a tsvector,
    # which is what turns `search_vector @@ websearch_to_tsquery('english', :q)` ordered by
    # ts_rank(...) into an index scan instead of a sequential scan plus a per-row rank.
    #
    # Never CONCURRENTLY: Alembic wraps this in a transaction and CREATE INDEX CONCURRENTLY
    # cannot run inside one, so passing postgresql_concurrently=True would abort the upgrade.
    op.create_index(
        "ix_posts_search_vector",
        "posts",
        ["search_vector"],
        postgresql_using="gin",
    )

    # --- Trigram index -----------------------------------------------------------------------
    # The typo-tolerant FALLBACK, not the primary path: gin_trgm_ops indexes the three-character
    # substrings of `title`, which is what lets `WHERE title % 'Scaling FastAPI'` match a
    # near-miss that ranked full-text search would miss entirely because no lexeme agrees.
    # Verified against PostgreSQL 18.4.
    #
    # The operator class belongs to pg_trgm, which revision 0001 installs. This references it
    # and deliberately does NOT re-enable it - see the module docstring.
    op.create_index(
        "ix_posts_title_trgm",
        "posts",
        ["title"],
        postgresql_using="gin",
        postgresql_ops={"title": "gin_trgm_ops"},
    )


def downgrade() -> None:
    # Strict reverse of upgrade(): both indexes by name, then the column. Each index is dropped
    # explicitly rather than left to fall away with the column, so the statement stream mirrors
    # the way up exactly and a partially-applied downgrade fails on the object it genuinely
    # cannot remove instead of on a later one.
    #
    # pg_trgm is NOT dropped here. Revision 0001 installs it and 0001's downgrade() removes it;
    # taking it away at this level would leave a database that is still at 0001 without the
    # operator class, and the next upgrade in an up/down/up cycle could not rebuild
    # ix_posts_title_trgm.
    #
    # What remains afterwards is exactly what 0001 created: twelve columns on `posts`, its four
    # indexes, and all three extensions still installed.

    # --- Trigram index -----------------------------------------------------------------------
    op.drop_index("ix_posts_title_trgm", table_name="posts")

    # --- Full-text index ---------------------------------------------------------------------
    op.drop_index("ix_posts_search_vector", table_name="posts")

    # --- posts.search_vector -----------------------------------------------------------------
    # Dropped last: an index cannot outlive the column it reads, so this order is required
    # rather than merely tidy.
    op.drop_column("posts", "search_vector")
