"""post search vector and indexes

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-08 10:00:23.239766+00:00

The search revision: every access path in this schema that *indexes text* rather than comparing
it. It adds one column and eight indexes.

To ``posts``, the three objects behind the home feed's search:

* ``search_vector`` - a ``tsvector`` column PostgreSQL derives from ``title``, ``excerpt`` and
  ``content`` and stores, declared ``GENERATED ALWAYS AS (...) STORED``.
* ``ix_posts_search_vector`` - a GIN index over that column, the feed's primary search path.
* ``ix_posts_title_trgm`` - a GIN trigram index over ``title``, the typo-tolerant fallback.

Then six more trigram indexes, one per pattern predicate the repositories issue:
``ix_users_username_trgm`` and ``ix_users_email_trgm`` for the administrative user search;
``ix_categories_name_trgm`` and ``ix_categories_slug_trgm`` for the category search and for the
slug-family scan behind category slug de-duplication; ``ix_comments_body_trgm`` for the
moderation queue's body search; and ``ix_posts_slug_trgm`` for the post slug-family scan.

Between them they turn ``GET /api/v1/posts?q=...`` from a scan into an index lookup, which is
what makes free-text relevance search one of the composed capabilities of the home feed
alongside category filtering, author filtering, ordering and windowing - and they do the same for
every administrative table's search box and for every slug collision check on the write path. The
service this repository grew out of had no index of any kind: every addressed read was a
first-match linear scan over a Python list, so a miss always traversed the whole collection.

Every text access path lives here
---------------------------------
A ``LIKE`` or ``ILIKE`` predicate is not served by an ordinary b-tree. A leading wildcard cannot
use one at all, and an anchored prefix can only use one whose operator class supports it - which
the default class over a ``citext`` column does not. So each of the six predicates below was a
guaranteed sequential scan over its whole relation, on surfaces that are reached by an
authenticated administrator on every keystroke of a search box, and on the *write* path every time
a slug is derived. The trigram operator class is what PostgreSQL provides for exactly this shape,
and the six indexes here are one per predicate rather than one per column.

Why this is a separate revision from ``0001``
---------------------------------------------
``0001`` creates ``posts`` without ``search_vector`` and creates none of the eight indexes, on
purpose. The split keeps the index build a distinct, re-runnable step: adding a stored generated
column rewrites the table, and building GIN indexes over the result is the expensive half of this
schema, so it is worth being able to replay that half on its own rather than only as part of
creating seven relations from nothing. That rationale is what decides where a new index belongs -
a B-tree over a key column goes in ``0001`` beside the relation it serves, and anything GIN comes
here. Folding these objects back into ``0001`` would undo it, and it would also make the two
revisions disagree with the comments in ``0001`` and in the model modules that all name this file
as their owner.

One consequence follows and is expected rather than a problem: ``alembic check`` run against
``0001`` alone legitimately reports every object in this revision as pending, because the model
modules declare all of the schema objects that span the two revisions. Only a check at ``head`` is
meaningful, and at ``head`` it is clean.

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
No index here is built with ``CREATE INDEX CONCURRENTLY``, and none may be. Alembic wraps a
migration in a transaction, ``CONCURRENTLY`` cannot run inside one, and attempting it aborts
the upgrade rather than degrading to a plain build. ``0001`` records the same constraint over
``ix_posts_status_published_at``.

Two spellings of a trigram index, chosen by the column type
-----------------------------------------------------------
``gin_trgm_ops`` is defined over ``text``. For a ``TEXT`` column - ``posts.title``,
``categories.name``, ``comments.body`` - the operator class goes straight on the column and the
query needs no change. For a ``CITEXT`` column - ``users.email``, ``users.username``,
``posts.slug``, ``categories.slug`` - it cannot: citext's own ``~~`` and ``~~*`` operators are not
in that operator family, so an index declared directly on the column is accepted by PostgreSQL and
then never chosen. Measured on 18.4 at thirty thousand rows: a sequential scan for containment,
for ``LIKE`` and for an anchored prefix alike, even with the unique b-tree present. Those four
therefore index the **text cast**, ``gin((col::text) gin_trgm_ops)``, and the repositories write
the matching predicate as ``cast(col, Text).ilike(...)`` - as ILIKE rather than LIKE, because
casting away citext also casts away its case-folding and ILIKE is what restores it.

Reachable is not the same as preferred
--------------------------------------
Two questions get asked of an index and only the first is about whether the index is right. Is the
predicate *reachable* - can the planner express it as an ``Index Cond`` on this index at all? And
does the planner *prefer* it to reading the relation? Reachability is a property of the index and
the query spelling, and it holds at every row count; preference is a cost estimate that arrives
with volume, because a full scan of a small relation genuinely beats building a bitmap.

Every index in this revision is reachable by the predicate it was built for, verified on 18.4 by
planning each one with ``enable_seqscan = off`` and reading the ``Index Cond``. Preference was then
measured separately, by calling the repository method and reading the index's scan counter out of
``pg_stat_user_indexes``, and the crossovers differ per relation because the relations differ in
width and in text cardinality:

===================================  ==========================  =========================
Predicate                            Scans at                    Takes the index at
===================================  ==========================  =========================
feed default recency                 -                           5,000 posts
feed ranked search                   20,000 posts                5,000 and 200,000 posts
posts slug family prefix             -                           20,000 posts
comments body containment            20,000 comments             200,000 comments
categories slug family prefix        5,000 terms                 120,000 terms
users username/email containment     30,000 accounts             300,000 accounts
categories name/slug containment     120,000 terms               400,000 terms
===================================  ==========================  =========================

The ranked-search row is not a typo, and it is the reason this table records volumes rather than a
verdict. That predicate is a disjunction - ``app.repositories.post_repository`` applies a search
term as ``search_vector @@ websearch_to_tsquery(...) OR title % term``, never as the ``@@`` half
alone - so its plan is costed against two GIN indexes at once, and the estimate does not move
monotonically with row count. Measured: a ``BitmapOr`` over ``ix_posts_search_vector`` and
``ix_posts_title_trgm`` at five thousand posts, a sequential scan at twenty thousand, and the
``BitmapOr`` again at two hundred thousand. Nothing is wrong at the middle figure - the scan is
genuinely the cheaper plan there - but anyone who measures once and generalises will report whatever
their single corpus happened to prefer.

Which is also why every figure above comes from the predicate the repository really issues rather
than a hand-written approximation of it. The ``@@`` half in isolation scans until roughly two
hundred thousand posts, so measuring that instead would have credited the wrong plan to the wrong
index and understated a path that is in fact taken at five thousand.

None of the "scans at" figures is a defect to be tuned away. A planner that declines an index on a
small relation is costing the query correctly, and the same plan flips to the index as the data
grows - which is the whole reason the index is written now rather than after the incident. What
would be a defect is an index the predicate can never reach, and that is the failure mode the
citext spelling below exists to avoid. This table is also the evidence for AAP 0.9.5, which flagged
index selection as unproven because it had only ever been observed on a single-row table.

Each expression index is declared as a **labelled** ``literal_column`` with its operator class in
``postgresql_ops``, never as a single ``text("(col::text) gin_trgm_ops")`` string. Both render
identical DDL, but Alembic warns ``Expression ... detected to include an operator clause.
Expression compare cannot proceed`` on the inline form and then stops comparing that index -
leaving an object unguarded by the one gate that exists to catch drift. With the label and the ops
dict, ``alembic check`` compares all eight and reports nothing, warning-free.

Extensions
----------
Every trigram index here uses the ``gin_trgm_ops`` operator class, which belongs to the
``pg_trgm`` extension. ``0001`` installs it and ``0001``'s own ``downgrade()`` removes it, so
this revision only *references* it: it neither re-enables it on the way up nor drops it on the
way down. Dropping it here would take the operator class away from a database that ``0001``
still considers itself responsible for, and the next ``upgrade`` in an up/down/up cycle would
fail to build these very indexes.

Reversibility
-------------
``downgrade()`` is an exact mirror: the eight indexes by name in the reverse of their creation
order, then the column, which leaves the schema precisely as ``0001`` created it - twelve columns
and three indexes on ``posts``, four on ``comments``, two on ``users``, two on ``categories``
(counting neither primary key), and ``pg_trgm`` still installed. Verified by downgrading to ``0001``
and reading ``pg_indexes`` back, and by the up/down/up cycle, including a
single-step ``downgrade -1`` and re-``upgrade``, which is the case this split-revision design
makes worth exercising on its own.

Like ``0001``, this module imports no application code - not ``app.models``, not
``app.db.base``, not ``app.core.config`` - reads no environment variable, embeds no connection
URL or credential, and never calls ``Base.metadata.create_all()``. Schema history has to stay
readable and re-runnable after a model is renamed, so the column name, the type, the
expression and every index name are spelled out literally rather than resolved from live
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
    # stored column can be indexed - ix_posts_search_vector below is the reason this is not
    # VIRTUAL.
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

    # --- Pattern indexes for the containment and slug-family searches ------------------------
    # Six more trigram indexes, one per pattern predicate the repositories actually issue. Each
    # is created here rather than in 0001 for the reason this revision exists at all: a GIN build
    # is the expensive half of this schema and is worth being replayable on its own. See "Every
    # text access path lives here" in the module docstring for why a `LIKE`/`ILIKE` predicate is
    # otherwise a sequential scan whatever b-tree exists over the column.
    #
    # TWO SPELLINGS, and which one applies is decided by the column TYPE, not by preference:
    #
    #   TEXT column     `gin(col gin_trgm_ops)`, exactly like ix_posts_title_trgm above. The
    #                   query needs no change - `col ILIKE '%term%'` uses the index directly.
    #   CITEXT column   `gin((col::text) gin_trgm_ops)`, an EXPRESSION index. gin_trgm_ops is
    #                   defined over `text`, and citext's own `~~`/`~~*` operators are not in
    #                   that operator family, so an index declared directly on a citext column is
    #                   accepted by PostgreSQL and then never chosen by the planner, at any size,
    #                   because the operator family never matches. Measured on 18.4 at 30,000
    #                   rows: seq scan for containment, for `LIKE` and for an anchored prefix
    #                   alike, even with the unique b-tree present. Over the text cast the same
    #                   predicate becomes an `Index Cond` on the expression index - see
    #                   "Reachable is not the same as preferred" in the module docstring for the
    #                   volumes at which the planner then actually takes it. The repositories
    #                   write these predicates as `cast(col, Text).ilike(...)`, matching the index
    #                   expression - and as ILIKE rather than LIKE, because casting away citext
    #                   also casts away its case-folding and ILIKE is what restores it.
    #
    # The expression form is spelled as a LABELLED literal_column with the operator class in
    # `postgresql_ops`, never as one `text("(col::text) gin_trgm_ops")` string. Both render the
    # same DDL, but Alembic warns `Expression ... detected to include an operator clause.
    # Expression compare cannot proceed` on the inline form and then stops comparing that index at
    # all - a silently unguarded object in the one gate that exists to catch drift. With the label
    # and the ops dict, `alembic check` compares it and reports nothing, warning-free.
    #
    # None of the six is built CONCURRENTLY, for the reason recorded above: Alembic wraps this
    # revision in a transaction and CREATE INDEX CONCURRENTLY cannot run inside one.
    op.create_index(
        # The administrative user search: `?q=` matched against handle and address together.
        "ix_users_username_trgm",
        "users",
        [sa.literal_column("(username::text)").label("username_text")],
        postgresql_using="gin",
        postgresql_ops={"username_text": "gin_trgm_ops"},
    )
    op.create_index(
        "ix_users_email_trgm",
        "users",
        [sa.literal_column("(email::text)").label("email_text")],
        postgresql_using="gin",
        postgresql_ops={"email_text": "gin_trgm_ops"},
    )
    op.create_index(
        # `categories.name` is TEXT, so the operator class goes straight on the column.
        "ix_categories_name_trgm",
        "categories",
        ["name"],
        postgresql_using="gin",
        postgresql_ops={"name": "gin_trgm_ops"},
    )
    op.create_index(
        # Two predicates share this one: the administrative category search's containment match,
        # and the anchored `slug LIKE 'base%'` family scan that slug de-duplication runs before
        # every category insert and rename.
        "ix_categories_slug_trgm",
        "categories",
        [sa.literal_column("(slug::text)").label("slug_text")],
        postgresql_using="gin",
        postgresql_ops={"slug_text": "gin_trgm_ops"},
    )
    op.create_index(
        # The moderation queue's optional body search. `comments.body` is unbounded TEXT and the
        # match is a leading-wildcard containment, so this is the difference between an index scan
        # and a sequential scan over every comment in the system.
        "ix_comments_body_trgm",
        "comments",
        ["body"],
        postgresql_using="gin",
        postgresql_ops={"body": "gin_trgm_ops"},
    )
    op.create_index(
        # The post slug family scan behind collision-safe slug derivation - the query that runs on
        # every create and every retitle, and the one that keeps a canonical URL unique.
        "ix_posts_slug_trgm",
        "posts",
        [sa.literal_column("(slug::text)").label("slug_text")],
        postgresql_using="gin",
        postgresql_ops={"slug_text": "gin_trgm_ops"},
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
    # indexes, the four indexes on `comments`, and all three extensions still installed.

    # --- Pattern indexes ---------------------------------------------------------------------
    # Dropped in the exact reverse of the order upgrade() created them, so a partially-applied
    # downgrade fails on the object it genuinely cannot remove rather than on a later one.
    op.drop_index("ix_posts_slug_trgm", table_name="posts")
    op.drop_index("ix_comments_body_trgm", table_name="comments")
    op.drop_index("ix_categories_slug_trgm", table_name="categories")
    op.drop_index("ix_categories_name_trgm", table_name="categories")
    op.drop_index("ix_users_email_trgm", table_name="users")
    op.drop_index("ix_users_username_trgm", table_name="users")

    # --- Trigram index -----------------------------------------------------------------------
    op.drop_index("ix_posts_title_trgm", table_name="posts")

    # --- Full-text index ---------------------------------------------------------------------
    op.drop_index("ix_posts_search_vector", table_name="posts")

    # --- posts.search_vector -----------------------------------------------------------------
    # Dropped last: an index cannot outlive the column it reads, so this order is required
    # rather than merely tidy.
    op.drop_column("posts", "search_vector")
