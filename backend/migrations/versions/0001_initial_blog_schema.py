"""initial blog schema

Revision ID: 0001
Revises: None
Create Date: 2026-08-08 09:24:23.134226+00:00

The root of the schema history and the single DDL origin of the blog domain: three
extensions, three native enumerated types, and the seven relations the service is built on -
``users``, ``refresh_tokens``, ``categories``, ``posts``, ``post_categories``, ``comments``
and ``post_likes``.

This is the revision that makes PostgreSQL the system of record. The service this repository
grew out of kept every record in one module-level Python list, so a process restart left zero
records recoverable and two workers each served a divergent private collection. Nothing is
migrated out of that list, because nothing in it ever survived a restart: it is removed rather
than drained, and the relations below replace it outright.

Invariants the database enforces, so that no application bug can violate them
-----------------------------------------------------------------------------
* **Identity is server-owned.** Every surrogate key is a ``uuid`` defaulted to
  ``gen_random_uuid()``, which PostgreSQL 18 ships as a built-in - so neither ``pgcrypto`` nor
  ``uuid-ossp`` is installed here, and no Python-side default exists anywhere. The predecessor
  let the client supply its own key, so duplicates were storable and the first row written
  permanently shadowed every later one.
* **Identity is case-insensitive.** ``users.email``, ``users.username``, ``posts.slug`` and
  ``categories.slug`` are ``citext`` behind unique indexes, so ``Alice`` and ``alice`` collide
  at registration and ``/u/Alice`` and ``/u/alice`` resolve to one person. This is a property
  of the column type, not of a collation or a functional ``lower()`` index.
* **A published post always carries a publication instant**, enforced by
  ``ck_posts_published_at_required``. A bug in the publish path cannot produce a ``PUBLISHED``
  row with a null ``published_at``.
* **A readership counter is never negative**, enforced by
  ``ck_posts_view_count_non_negative``. ``app.schemas.post`` publishes that bound as ``ge=0`` on
  the projections a reader receives, and the framework validates a handler's return value against
  its response model - so a negative counter would turn every read of that post into a ``500``
  rather than merely looking odd. The constraint keeps the promise where it can be kept.
* **A like is unique per (post, user)**, enforced by the composite primary key on
  ``post_likes``. That key *is* the idempotency guarantee rather than a convenience: two
  conflict-ignoring inserts leave the count at one, which is why
  ``PUT /api/v1/posts/{id}/like`` is safe to retry and why no de-duplication exists anywhere in
  application code.
* **Every foreign key carries an explicit ``ON DELETE CASCADE``**, so deleting a post removes
  its comments and its likes, and deleting a user removes their posts, comments, likes and
  refresh tokens.

Three relations deviate from the mixin defaults, deliberately
-------------------------------------------------------------
``refresh_tokens`` has ``created_at`` and no ``updated_at``: a token is issued, then either
expires or is revoked, and both of those have their own columns, so there is no third state an
``updated_at`` could describe. ``post_categories`` and ``post_likes`` take no surrogate key at
all, because their composite primary keys are the point - adding an ``id`` alongside would
permit exactly the duplicate rows those keys exist to forbid. Adding a column here "for
consistency" is schema drift.

Deliberately not in this revision
---------------------------------
``posts.search_vector`` and the two GIN indexes over it belong to revision ``0002``, which
keeps the index build a separate, re-runnable step. The models declare them, so an
``alembic check`` run against *this* revision alone legitimately reports them as pending; only
a check at ``head`` is meaningful. Reference category rows belong to revision ``0003``.

This module imports no application code - not ``app.models``, not ``app.db.base``, not
``app.core.config`` - reads no environment variable, embeds no connection URL or credential,
and never calls ``Base.metadata.create_all()``. Schema history has to stay readable and
re-runnable after a model is renamed, so every name, type and default below is spelled out
literally rather than resolved from live metadata. The revision reaches the database only
through the connection Alembic binds to it, and ``migrations/env.py`` remains the sole
resolver of the connection URL.

Naming: full names everywhere except the check constraints
---------------------------------------------------------
Every primary key, foreign key, unique constraint and index below is named in full, so the
identifier in this file is the identifier in the database and neither depends on a convention
that lives elsewhere. An unnamed key would instead reach the database with PostgreSQL's own
server-side name - ``posts_pkey`` rather than ``pk_posts`` - which is both an ``alembic check``
drift report and a downgrade that cannot find the object it needs to drop.

The exceptions are the two check constraints on ``posts``, and the reason is worth stating
because it is easy to get backwards. :meth:`alembic.op.create_table` builds its table against a
throwaway ``MetaData``, but it copies ``target_metadata.naming_convention`` onto it, so the
convention in ``app/db/base.py`` *is* in force here. For the ``pk``, ``fk``, ``uq`` and ``ix``
templates that changes nothing, because SQLAlchemy applies a convention only to a construct
whose name is ``None``. The ``ck`` template is different: it interpolates
``%(constraint_name)s``, which makes SQLAlchemy re-render an already-named check constraint
through the template. Passing the finished ``ck_posts_published_at_required`` therefore yields
``ck_posts_ck_posts_published_at_required`` - measured, not hypothesised. The short stems are
what belong there - ``published_at_required`` and ``view_count_non_negative``, exactly as
``app/models/post.py`` declares them - and the convention supplies the ``ck_posts_`` prefix.

Reversibility
-------------
``downgrade()`` genuinely restores an empty database, in strict reverse dependency order:
indexes and tables first, then all three enumerated types, then the extensions last. Leaving
an enumerated type behind is the classic reason a second ``upgrade head`` fails after a
``downgrade base``, and that is precisely what the up/down/up gate exists to catch.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# The three native enumerated types, declared once at module scope and reused for both the
# CREATE TYPE at the top of upgrade() and the columns that reference them.
#
# `create_type=False` is mandatory rather than stylistic. Left at its default, SQLAlchemy emits
# its own CREATE TYPE alongside every CREATE TABLE that mentions the type, and the second such
# table fails with `psycopg.errors.DuplicateObject: type "post_status" already exists`. With
# the flag off, each type's lifecycle belongs entirely to the explicit create() and drop()
# calls below - which is also what makes the up/down/up cycle repeatable, because the type is
# then dropped by name on the way down instead of being orphaned.
#
# The labels are the member *names* of the StrEnum classes in app.models.{user,post,comment},
# which is what SQLAlchemy persists when a model supplies no `values_callable`. All three of
# those classes set name == value, so the two spellings coincide and the label list cannot
# drift either way.
user_role = postgresql.ENUM(
    "READER",
    "AUTHOR",
    "ADMIN",
    name="user_role",
    create_type=False,
)
post_status = postgresql.ENUM(
    "DRAFT",
    "PUBLISHED",
    "ARCHIVED",
    name="post_status",
    create_type=False,
)
comment_status = postgresql.ENUM(
    "PENDING",
    "APPROVED",
    "REJECTED",
    name="comment_status",
    create_type=False,
)


def upgrade() -> None:
    bind = op.get_bind()

    # --- Extensions ----------------------------------------------------------------------
    # `citext` has to be installed before any relation that uses it, so this block precedes
    # every CREATE TABLE. `pg_trgm` supplies the `gin_trgm_ops` operator class that the
    # trigram index in revision 0002 needs, and `unaccent` is installed here so the
    # text-search configuration can reach it. IF NOT EXISTS keeps the block idempotent
    # against an environment that was provisioned with them already present.
    #
    # DEPLOYMENT PREREQUISITE, and the one thing in this revision that is not self-contained -
    # but NOT a superuser requirement. All three of these are TRUSTED extensions, which means
    # PostgreSQL (13 and later) lets a role install them with nothing more than the CREATE
    # privilege on the current database. Verified on PostgreSQL 18.4: `pg_available_extension_
    # versions` reports `trusted = t` for every available version of citext, pg_trgm and
    # unaccent, and a role created NOSUPERUSER NOCREATEDB NOCREATEROLE installed all three in a
    # database it owned and then exercised them - `'A'::citext = 'a'::citext`, `similarity()`,
    # `unaccent('cafe')` - without ever holding superuser.
    #
    # So the least-privilege path is the ordinary one, and it is the recommended one: grant the
    # migration role CREATE on the database and run `alembic upgrade head` as that role. Owning
    # the database carries it implicitly; otherwise it is one statement, executed once, by the
    # database owner or a superuser:
    #
    #     GRANT CREATE ON DATABASE <database> TO <migration_role>;
    #
    # Without it the block fails here rather than on anything below, with
    # `permission denied to create extension "citext"` and the hint `Must have CREATE privilege
    # on current database to create this extension` - measured, not paraphrased. The failure is
    # atomic: the transaction rolls back and the database stays at its previous revision.
    #
    # Superuser is required only for an UNTRUSTED extension, and this revision installs none.
    # The contrast is worth knowing when a later revision wants one: the same role, holding the
    # same database CREATE privilege, is refused `CREATE EXTENSION file_fdw` (which reports
    # `trusted = f`) with the different hint `Must be superuser to create this extension`. If
    # such a dependency is ever added, install it once out of band as a privileged role and keep
    # the `IF NOT EXISTS` form below so the migration stays a no-op against it.
    #
    # `IF NOT EXISTS` also covers the environment provisioned with these three already present -
    # a managed instance that ships them, or an image whose entrypoint created them - in which
    # case this block needs no privilege at all beyond connecting.
    #
    # No extension is installed for UUID generation: gen_random_uuid() is a PostgreSQL 18
    # built-in, verified available with only these three installed.
    op.execute("CREATE EXTENSION IF NOT EXISTS citext")
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.execute("CREATE EXTENSION IF NOT EXISTS unaccent")

    # --- Enumerated types ----------------------------------------------------------------
    # checkfirst=True makes each CREATE TYPE a no-op when the type is already present, which
    # keeps a partially-applied environment recoverable. It is also safe under `--sql`:
    # Alembic's offline mock connection short-circuits the existence probe rather than
    # attempting a round trip.
    user_role.create(bind, checkfirst=True)
    post_status.create(bind, checkfirst=True)
    comment_status.create(bind, checkfirst=True)

    # --- users ---------------------------------------------------------------------------
    # The identity relation. `email` and `username` are citext behind UNIQUE indexes rather
    # than UNIQUE constraints, matching app.models.user, where both columns declare
    # `unique=True, index=True`; SQLAlchemy renders that pair as a single unique index.
    op.create_table(
        "users",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("email", postgresql.CITEXT(), nullable=False),
        sa.Column("username", postgresql.CITEXT(), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("bio", sa.Text(), nullable=True),
        sa.Column("avatar_url", sa.Text(), nullable=True),
        sa.Column(
            "role",
            user_role,
            server_default=sa.text("'READER'::user_role"),
            nullable=False,
        ),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_users"),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)
    op.create_index("ix_users_username", "users", ["username"], unique=True)

    # --- refresh_tokens ------------------------------------------------------------------
    # Only a hash of each issued refresh token is stored, so a database disclosure yields no
    # usable credential. `created_at` without `updated_at` is deliberate; see the module
    # docstring. The UNIQUE here is a constraint rather than an index because the model
    # declares `unique=True` alone on `token_hash`, with no `index=True`.
    op.create_table(
        "refresh_tokens",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_refresh_tokens"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_refresh_tokens_user_id_users",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("token_hash", name="uq_refresh_tokens_token_hash"),
    )
    op.create_index("ix_refresh_tokens_user_id", "refresh_tokens", ["user_id"])
    op.create_index("ix_refresh_tokens_expires_at", "refresh_tokens", ["expires_at"])

    # --- categories ----------------------------------------------------------------------
    # The taxonomy the home feed filters on and the admin dashboard manages. `name` carries a
    # UNIQUE constraint and `slug` a unique citext index, mirroring app.models.category.
    op.create_table(
        "categories",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("slug", postgresql.CITEXT(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_categories"),
        sa.UniqueConstraint("name", name="uq_categories_name"),
    )
    op.create_index("ix_categories_slug", "categories", ["slug"], unique=True)

    # --- posts ---------------------------------------------------------------------------
    # The central relation. `status` plus `published_at` are the lifecycle, and the check
    # constraint below is what makes "published" and "has a publication instant" inseparable.
    #
    # `search_vector` is absent on purpose: it is a generated column, and revision 0002 adds
    # it together with the two GIN indexes that read it, so the index build stays a separate
    # and re-runnable step.
    op.create_table(
        "posts",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("author_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("slug", postgresql.CITEXT(), nullable=False),
        sa.Column("excerpt", sa.Text(), nullable=True),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("cover_image_url", sa.Text(), nullable=True),
        sa.Column(
            "status",
            post_status,
            server_default=sa.text("'DRAFT'::post_status"),
            nullable=False,
        ),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("view_count", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_posts"),
        # SHORT name, unlike every other constraint in this revision: the `ck` naming
        # template interpolates %(constraint_name)s, so SQLAlchemy renders this as
        # `ck_posts_published_at_required`. Passing the finished name instead would produce
        # `ck_posts_ck_posts_published_at_required`. See the module docstring.
        sa.CheckConstraint(
            "status <> 'PUBLISHED' OR published_at IS NOT NULL",
            name="published_at_required",
        ),
        # Also a SHORT name, for the same reason: renders as
        # `ck_posts_view_count_non_negative`. `view_count` is NOT NULL DEFAULT 0 above, which
        # says the counter is always present but not that it is always sensible; this is what
        # makes the non-negativity `app.models.post` documents and `app.schemas.post` publishes
        # as `ge=0` a property of the schema rather than of the code that happens to write it.
        sa.CheckConstraint("view_count >= 0", name="view_count_non_negative"),
        sa.ForeignKeyConstraint(
            ["author_id"],
            ["users.id"],
            name="fk_posts_author_id_users",
            ondelete="CASCADE",
        ),
    )
    op.create_index("ix_posts_author_id", "posts", ["author_id"])
    op.create_index("ix_posts_slug", "posts", ["slug"], unique=True)
    # The home page's primary access path: most recent published posts first. The descending
    # ordering is passed as a text expression because it is part of the index definition
    # rather than a column name. Never CONCURRENTLY - Alembic wraps a migration in a
    # transaction, and CREATE INDEX CONCURRENTLY cannot run inside one.
    op.create_index(
        "ix_posts_status_published_at",
        "posts",
        ["status", sa.text("published_at DESC")],
    )

    # --- post_categories -----------------------------------------------------------------
    # The many-to-many association between posts and categories, owned by
    # app.models.category. The composite primary key covers (post_id, category_id) and so
    # already serves lookups that lead with `post_id`; the extra index on `category_id` is
    # what lets the feed's category filter resolve in the other direction.
    op.create_table(
        "post_categories",
        sa.Column("post_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("category_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.PrimaryKeyConstraint("post_id", "category_id", name="pk_post_categories"),
        sa.ForeignKeyConstraint(
            ["post_id"],
            ["posts.id"],
            name="fk_post_categories_post_id_posts",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["categories.id"],
            name="fk_post_categories_category_id_categories",
            ondelete="CASCADE",
        ),
    )
    op.create_index("ix_post_categories_category_id", "post_categories", ["category_id"])

    # --- comments ------------------------------------------------------------------------
    # `parent_id` is a nullable self-reference, and it is what realises threaded replies: a
    # top-level comment leaves it null, a reply points at the comment it answers. Its cascade
    # is what makes deleting a parent remove the whole subtree in one statement.
    op.create_table(
        "comments",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("post_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("author_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("parent_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column(
            "status",
            comment_status,
            server_default=sa.text("'PENDING'::comment_status"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_comments"),
        sa.ForeignKeyConstraint(
            ["post_id"],
            ["posts.id"],
            name="fk_comments_post_id_posts",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["author_id"],
            ["users.id"],
            name="fk_comments_author_id_users",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["parent_id"],
            ["comments.id"],
            name="fk_comments_parent_id_comments",
            ondelete="CASCADE",
        ),
    )
    # Four access paths, in the order app/models/comment.py declares them.
    #
    # The first two are the two reading surfaces: threaded retrieval for one post, in posting
    # order; and the moderation queue, which filters on status alone across every post.
    #
    # The last two cover the columns that REFERENCE another relation, and they are required
    # rather than optional. PostgreSQL creates an index on a referenced key automatically and
    # none at all on a referencing column, so these two would not exist unless created here:
    #
    #   (parent_id, status)  the recursive descent that assembles a thread of any depth. Every
    #                        step of the recursive CTE in app/repositories/comment_repository.py
    #                        asks `parent_id = ? AND status IN (...)`, so the join column leads
    #                        and the filter column follows and one index serves both halves at
    #                        every level. It carries the self-referencing ON DELETE CASCADE too,
    #                        which walks the same edge once per level of the subtree. Without it
    #                        each level is a sequential scan over the whole relation.
    #   author_id            the users cascade: deleting an account removes the comments it
    #                        wrote, and PostgreSQL locates them by this column. Also the access
    #                        path for moderating one account rather than one post.
    op.create_index("ix_comments_post_id_created_at", "comments", ["post_id", "created_at"])
    op.create_index("ix_comments_status", "comments", ["status"])
    op.create_index("ix_comments_parent_id_status", "comments", ["parent_id", "status"])
    op.create_index("ix_comments_author_id", "comments", ["author_id"])

    # --- post_likes ----------------------------------------------------------------------
    # No surrogate key: (post_id, user_id) is the primary key, and that is the whole
    # idempotency guarantee. A second identical insert under ON CONFLICT DO NOTHING leaves
    # the count at one, so the like endpoint is safely retryable and no application-level
    # de-duplication is needed. The index on `user_id` serves "posts I liked".
    op.create_table(
        "post_likes",
        sa.Column("post_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("post_id", "user_id", name="pk_post_likes"),
        sa.ForeignKeyConstraint(
            ["post_id"],
            ["posts.id"],
            name="fk_post_likes_post_id_posts",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_post_likes_user_id_users",
            ondelete="CASCADE",
        ),
    )
    op.create_index("ix_post_likes_user_id", "post_likes", ["user_id"])


def downgrade() -> None:
    bind = op.get_bind()

    # Strict reverse of upgrade(): indexes and tables, then the enumerated types, then the
    # extensions. DROP TABLE removes a relation's own indexes with it, but each index is
    # dropped by name first so the statement stream reads as an exact mirror of the way up
    # and so a partially-applied downgrade fails on the object it actually cannot remove.
    #
    # The table order is reverse dependency order, which is what lets every DROP TABLE be a
    # plain drop: no CASCADE is used anywhere, so an unexpected dependant surfaces as an
    # error rather than being silently destroyed.

    # --- post_likes ----------------------------------------------------------------------
    op.drop_index("ix_post_likes_user_id", table_name="post_likes")
    op.drop_table("post_likes")

    # --- comments ------------------------------------------------------------------------
    op.drop_index("ix_comments_author_id", table_name="comments")
    op.drop_index("ix_comments_parent_id_status", table_name="comments")
    op.drop_index("ix_comments_status", table_name="comments")
    op.drop_index("ix_comments_post_id_created_at", table_name="comments")
    op.drop_table("comments")

    # --- post_categories -----------------------------------------------------------------
    op.drop_index("ix_post_categories_category_id", table_name="post_categories")
    op.drop_table("post_categories")

    # --- posts ---------------------------------------------------------------------------
    op.drop_index("ix_posts_status_published_at", table_name="posts")
    op.drop_index("ix_posts_slug", table_name="posts")
    op.drop_index("ix_posts_author_id", table_name="posts")
    op.drop_table("posts")

    # --- categories ----------------------------------------------------------------------
    op.drop_index("ix_categories_slug", table_name="categories")
    op.drop_table("categories")

    # --- refresh_tokens ------------------------------------------------------------------
    op.drop_index("ix_refresh_tokens_expires_at", table_name="refresh_tokens")
    op.drop_index("ix_refresh_tokens_user_id", table_name="refresh_tokens")
    op.drop_table("refresh_tokens")

    # --- users ---------------------------------------------------------------------------
    op.drop_index("ix_users_username", table_name="users")
    op.drop_index("ix_users_email", table_name="users")
    op.drop_table("users")

    # --- Enumerated types ----------------------------------------------------------------
    # Only reachable once every column that referenced them is gone. Skipping this block is
    # the classic reason a second `upgrade head` fails after a `downgrade base`: the tables
    # are gone but the types survive, and the next CREATE TYPE collides with the leftover.
    comment_status.drop(bind, checkfirst=True)
    post_status.drop(bind, checkfirst=True)
    user_role.drop(bind, checkfirst=True)

    # --- Extensions ----------------------------------------------------------------------
    # Last, in reverse install order. Anything that depended on citext has been dropped by
    # this point, so no CASCADE is needed and none is used: a surviving dependant should stop
    # the downgrade rather than be removed silently along with the extension.
    op.execute("DROP EXTENSION IF EXISTS unaccent")
    op.execute("DROP EXTENSION IF EXISTS pg_trgm")
    op.execute("DROP EXTENSION IF EXISTS citext")
