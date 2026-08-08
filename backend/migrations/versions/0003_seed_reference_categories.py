"""seed reference categories

Revision ID: 0003
Revises: 0002
Create Date: 2026-08-08 10:43:38.868094+00:00

The data revision, and the only one in this history that writes a row rather than an object.
It inserts the eight reference categories the taxonomy is made of, so that a database which has
just been migrated can already answer ``GET /api/v1/categories``, already populate the home
feed's category filter, and already be paginated over. A migrated-but-empty database cannot
demonstrate - or test - any of those three: the filter has no taxonomy to filter by, and
pagination has no second page to be correct about.

Data only, and no DDL
---------------------
There is no ``CREATE``, no ``ALTER``, no table, no column, no index, no constraint and no enum
in either direction, and there must never be. ``0001`` owns the structure of ``categories`` -
its six columns, its primary key, its unique ``name`` constraint and its unique ``citext`` slug
index - and ``0002`` owns ``posts.search_vector`` and the two GIN indexes over it. This
revision owns eight rows.

That separation is what keeps the drift gate meaningful. A data-only revision introduces no
schema drift, so ``alembic check`` at ``head`` stays clean, and anything it does report is a
genuine disagreement between the models and ``0001``/``0002`` rather than noise from here. If
this file ever makes ``alembic check`` speak, the cause is DDL that does not belong in it.

Three columns, and only three
-----------------------------
Each row supplies ``name``, ``slug`` and ``description`` - nothing else. ``id``, ``created_at``
and ``updated_at`` are deliberately absent so that the server defaults ``0001`` attached to
them fire: ``gen_random_uuid()`` for the primary key and ``now()`` for both audit columns.

Writing literal UUIDs here instead would make this file the source of identity for eight rows,
which is precisely the defect this schema was designed to remove. The service this repository
grew out of let the client supply ``Item.id`` with no uniqueness check of any kind, and a
duplicate identifier there permanently shadowed every later record carrying the same value.
Identity is the database's to assign in a migration exactly as much as in a request, and the
same reasoning covers the two timestamps: an audit column stating when a row was written is
worth nothing if the writer gets to choose it.

``app.models.category`` records the same three-column expectation from the other side, so a
fourth *required* column added to ``categories`` without a matching change here would break
this revision. ``description`` is nullable, which is why prose is optional in the schema even
though all eight rows below carry some.

The taxonomy is stated in one place, and this is not it
------------------------------------------------------
``app.db.seed.REFERENCE_CATEGORIES`` is the canonical statement of the eight categories, and
:data:`REFERENCE_CATEGORIES` below mirrors it: the same names, the same slugs, the same
descriptions. That duplication is unavoidable and deliberately bounded. A revision may not
import application code - see below - so the values have to be written out here, but there is
exactly one other place they appear, both files name each other, and a divergence between the
two is a bug to reconcile rather than a difference to tolerate.

Every slug is what ``app.core.slug.slugify_title`` derives from the name on its own row, not an
independent transliteration of it, and that was verified by executing the function against all
eight names rather than by inspection. The non-obvious one is ``DevOps``, which collapses to
``devops`` rather than ``dev-ops``; that is the function's output, and it is exactly why
``seed.py`` derives its slugs instead of typing them. A hand-written slug the function would
not produce would leave the application and this data disagreeing about one category's URL.

Slugs are permanent. They are what ``GET /api/v1/categories/{slug}`` resolves, what the feed
carries in its ``category`` query parameter, what the client writes into the URL when a reader
picks a filter, and what the generated sitemap enumerates. Editing one below is a broken link
and a lost ranking, not a rename.

Two writers, one taxonomy: both directions reconcile
----------------------------------------------------
``app.db.seed.seed_categories`` writes the same eight categories, and either writer can arrive
first. Both orderings therefore have to end at eight rows, and each side reaches that outcome by
the same rule: **look the specification up by slug or by folded name, and insert only what is
absent.**

The seed side does it in Python - it selects the sixteen candidate values, skips whatever it
finds, and inserts the rest. This side does it in SQL. Each of the eight statements in
:func:`upgrade` is an ``INSERT ... SELECT ... WHERE NOT EXISTS`` naming that row's own slug and
folded name, with ``ON CONFLICT DO NOTHING`` behind it, so a category the seed script already
created is skipped by the guard rather than colliding with ``uq_categories_name``.

That guard is **not** about this revision running twice. Alembic already guarantees a revision
runs at most once per database through the ``alembic_version`` table, so the insert can never
meet a row it inserted itself. It is about the *other* writer, and the case it fixes is real
rather than hypothetical: a database left at ``0002`` and then seeded - a provisioning step that
stopped short of ``head``, a developer who ran the seed early, an older deployment whose
categories were populated by hand - would abort the next ``alembic upgrade head`` on a duplicate
name, leaving an operator to reach for ``alembic stamp`` to get moving again. Measured before the
guard existed: ``psycopg.errors.UniqueViolation ... "uq_categories_name"``, with the database
correctly and atomically still at ``0002``.

The guard is written *inside* the statement on purpose. A read-then-branch in Python - select the
existing slugs, then decide what to insert - would need a live connection and would render
nothing usable under ``alembic upgrade head --sql``, where there is no database to ask. A
``WHERE NOT EXISTS`` is part of the SQL, so the offline script stays self-contained and stays
conditional: hand it to somebody who applies it under change control and it is still safe against
a database that already carries the taxonomy.

So: migrate first and the seed script reports eight skips; seed first and these eight statements
insert nothing. Whichever writer arrives first, the other writes nothing, and the row count after
the second run equals the row count after the first.

No application imports, and nothing resolved from live metadata
--------------------------------------------------------------
:data:`categories_table` is a lightweight ``sa.table()`` construct naming only the three
columns this revision touches, at the shape they had at this point in the history. It is
deliberately not ``app.models.Category``, and importing that class here would be a real defect
rather than a style preference: schema history is frozen, current model code is not, so a
revision resolved from live metadata would start emitting different SQL the moment a column was
renamed, and would fail outright once the model no longer matched the table as it stood here.

Like ``0001`` and ``0002``, this module therefore imports no application code - not
``app.models``, not ``app.db.base``, not ``app.db.seed``, not ``app.core.slug``, not
``app.core.config`` - reads no environment variable, embeds no connection URL, and never calls
``Base.metadata.create_all()``. ``migrations/env.py`` remains the sole resolver of the
connection URL.

Nothing here is sensitive
-------------------------
This is the only revision in the history that writes data, so it is the only one where the
question even arises: every value below is a category name, a URL slug, or a sentence of
descriptive prose. There is no password, token, API key or credential of any kind, and no
user, post or comment row either.

The administrator account is created by ``app.db.seed.seed_administrator`` from configuration,
and its password is persisted only as an argon2id hash. That split is on purpose. A credential
written into schema history would be committed to the repository, replayed into every
environment that ever upgrades, and impossible to rotate without editing a revision that has
already run.

Reversibility
-------------
``downgrade()`` deletes exactly the eight slugs :data:`REFERENCE_SLUGS` names, and that tuple
is derived from :data:`REFERENCE_CATEGORIES` rather than typed a second time, so the way down
cannot fall out of step with the way up. A bare ``DELETE FROM categories`` would be wrong: by
the time a downgrade runs an administrator may have created categories through
``POST /api/v1/admin/categories``, and those rows are not this revision's to remove.

One consequence is expected rather than worked around. ``post_categories.category_id`` carries
``ON DELETE CASCADE``, so removing a reference category also removes the rows filing posts
under it. That is the designed behaviour of the association rather than a side effect to guard
against, and it means a downgrade is not information-preserving once ``seed.py`` has associated
demonstration posts with these categories. Re-upgrading restores the categories; it does not
restore associations that depended on them.

Verified by the up/down/up cycle, including a single-step ``downgrade -1`` followed by a
re-``upgrade`` - the case that would fail on a duplicate-slug unique violation if
``downgrade()`` had not removed its own rows - and by confirming that a category inserted by
hand beforehand survives that downgrade untouched.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# The three columns this revision writes, and nothing else.
#
# sa.table()/sa.column() rather than a MetaData-bound Table or app.models.Category: this is a
# frozen description of `categories` as it stands at revision 0003, which is precisely the
# coupling a migration wants. `id`, `created_at` and `updated_at` are omitted so that they never
# reach the INSERT column list and PostgreSQL applies the server defaults 0001 gave them.
#
# The types are stated rather than left to default because alembic renders every value through
# `table.c[<key>].type` when `alembic upgrade head --sql` compiles this revision offline. CITEXT
# is also what makes the case-insensitive comparison in downgrade() faithful to the real column
# instead of an accident of how the literals below happen to be capitalised.
categories_table = sa.table(
    "categories",
    sa.column("name", sa.Text()),
    sa.column("slug", postgresql.CITEXT()),
    sa.column("description", sa.Text()),
)


# The taxonomy, mirroring app.db.seed.REFERENCE_CATEGORIES value for value: same names, same
# slugs, same descriptions. Read this module's docstring before editing any of the three.
#
# Declaration order is preserved for readability only. `name` and `slug` are both unique, so
# insertion order carries no meaning to the schema, and the API orders this set when it lists it.
#
# Each slug is `app.core.slug.slugify_title`'s output for the name on the same row - including
# `DevOps` -> `devops`, which is the one a hand transliteration would get wrong.
REFERENCE_CATEGORIES: tuple[dict[str, str], ...] = (
    {
        "name": "Engineering",
        "slug": "engineering",
        "description": (
            "Practices that hold across the whole stack: reviewing, testing, typing and the "
            "unglamorous discipline that keeps a codebase readable as it grows."
        ),
    },
    {
        "name": "Architecture",
        "slug": "architecture",
        "description": (
            "Boundaries, contracts and the decisions that are expensive to reverse - layering, "
            "versioning, and where a responsibility is allowed to live."
        ),
    },
    {
        "name": "Backend",
        "slug": "backend",
        "description": (
            "Service-tier work: request handling, dependency wiring, business rules and the "
            "REST surface the client tier is written against."
        ),
    },
    {
        "name": "Frontend",
        "slug": "frontend",
        "description": (
            "The client tier: server and client components, tokens, layout, theming and the "
            "accessibility floor every interactive control has to clear."
        ),
    },
    {
        "name": "Databases",
        "slug": "databases",
        "description": (
            "Schema design, migrations, indexing and query plans - the invariants worth pushing "
            "into PostgreSQL rather than defending in application code."
        ),
    },
    {
        "name": "DevOps",
        "slug": "devops",
        "description": (
            "Getting the thing to run and stay running: images, pipelines, health probes and "
            "the logs and traces you need before an incident, not during one."
        ),
    },
    {
        "name": "Security",
        "slug": "security",
        "description": (
            "Credentials, tokens, authority checks, rate limits and content sanitisation - "
            "enforced on the server, because a hidden control is not a boundary."
        ),
    },
    {
        "name": "Product",
        "slug": "product",
        "description": (
            "Turning a requirement into something usable: scope, defaults, empty states and "
            "the small decisions readers actually notice."
        ),
    },
)


# The slugs downgrade() removes, projected from the rows upgrade() inserts rather than written
# out a second time. Two hand-maintained lists can disagree; one list and a projection of it
# cannot, and that is what makes the up/down/up cycle safe to rely on rather than merely likely
# to work.
REFERENCE_SLUGS: tuple[str, ...] = tuple(row["slug"] for row in REFERENCE_CATEGORIES)


def _guarded_insert(row: dict[str, str]) -> postgresql.Insert:
    """Build the reconciling insert for one reference category.

    The statement is ``INSERT INTO categories (name, slug, description) SELECT <literals>
    WHERE NOT EXISTS (SELECT 1 FROM categories WHERE slug = <slug> OR lower(name) = <folded
    name>) ON CONFLICT DO NOTHING`` - one round trip, no read-then-branch, and therefore
    renderable offline. See the module docstring for why both writers need it.

    The predicate mirrors ``app.db.seed.seed_categories`` value for value, which is the whole
    point: two writers that disagree about what "already present" means would each skip a
    different set.

    * **slug.** ``categories.slug`` is ``citext``, so ``=`` folds case in the database and the
      comparison resolves through ``ix_categories_slug``.
    * **name.** ``categories.name`` is plain ``TEXT`` under the case-SENSITIVE
      ``uq_categories_name``, so the fold is written out with ``lower()``. That is deliberately
      *stricter* than the constraint: a stored ``ENGINEERING`` counts as satisfying the reference
      ``Engineering`` even though inserting alongside it would not actually collide. Stricter is
      the safe direction here - the cost is a skip, and what it buys is one taxonomy rather than
      two spellings of the same category. ``seed.py`` documents the same trade at its query.

    ``ON CONFLICT DO NOTHING`` sits behind the guard rather than replacing it, and it covers the
    one case the guard cannot see: a writer that commits the same category *after* this
    statement's snapshot was taken. The realistic instance is an overlapping ``make seed`` -
    seeding is a separate process and nothing stops it running while an upgrade is in flight -
    and applying the rendered ``--sql`` script alongside one has the same shape. Under
    ``READ COMMITTED`` the guard evaluates against a snapshot that predates the other writer's
    commit, finds nothing, and proceeds. Measured with the guard alone: the statement blocks on
    the other writer's uncommitted index tuple and then raises ``UniqueViolation`` on
    ``uq_categories_name`` the moment that writer commits. With this clause it is released,
    inserts nothing, and the row count stays at one. Targetless, so it covers
    ``uq_categories_name`` and ``ix_categories_slug`` alike.

    Two *concurrent upgrades* are a different story and do not depend on this clause: Alembic's
    own version-row check stops the loser first, with ``Online migration expected to match one
    row when updating '0002' to '0003' in 'alembic_version'; 0 found``, and rolls its whole
    transaction back. Measured as well - two simultaneous ``alembic upgrade head`` runs from
    ``0002`` exit ``[255, 0]`` and leave exactly eight categories, no duplicates, at ``head``.

    Args:
        row: One entry of :data:`REFERENCE_CATEGORIES` - ``name``, ``slug`` and ``description``.

    Returns:
        The insert to execute, with every value bound as a literal of its column's own type so
        that ``literal_binds`` renders it inline under ``--sql``.
    """
    already_present = (
        sa.select(sa.literal(1))
        .select_from(categories_table)
        .where(
            sa.or_(
                categories_table.c.slug == sa.literal(row["slug"], postgresql.CITEXT()),
                sa.func.lower(categories_table.c.name)
                == sa.literal(row["name"].casefold(), sa.Text()),
            )
        )
    )
    # `id`, `created_at` and `updated_at` are absent from the column list, so 0001's server
    # defaults - gen_random_uuid() and now() - supply all three. That omission is the reason this
    # revision is not the source of identity for eight rows.
    values = sa.select(
        sa.literal(row["name"], sa.Text()).label("name"),
        sa.literal(row["slug"], postgresql.CITEXT()).label("slug"),
        sa.literal(row["description"], sa.Text()).label("description"),
    ).where(~already_present.exists())

    return (
        postgresql.insert(categories_table)
        .from_select(["name", "slug", "description"], values)
        .on_conflict_do_nothing()
    )


def upgrade() -> None:
    # --- The rows ----------------------------------------------------------------------------
    # Eight statements, one per category, and no DDL whatsoever.
    #
    # `op.bulk_insert` is deliberately not used. It emits an unguarded INSERT, which is correct
    # only while this revision is the sole writer of the taxonomy - and it is not: app.db.seed
    # writes the same eight rows, either order is reachable, and the unguarded form aborted the
    # upgrade on `uq_categories_name` whenever the seed script got there first. `_guarded_insert`
    # carries that reconciliation in SQL instead, so both orderings end at eight rows.
    #
    # Per row rather than one statement over a VALUES list, for two reasons. Each guard then
    # names only its own slug and folded name, which is what makes the skip decision independent
    # per category - seven can insert while the eighth is adopted. And because the statements run
    # in sequence inside one transaction, each guard also sees what its predecessors just wrote,
    # so a duplicate accidentally introduced *within* REFERENCE_CATEGORIES self-skips rather than
    # raising. seed.py achieves that same property by registering each new row in its lookup.
    #
    # Offline (`alembic upgrade head --sql`) each renders as a self-contained INSERT with its
    # values inlined, because migrations/env.py configures `literal_binds=True`; online each is
    # one execute. Both write the same eight rows, and both leave `id`, `created_at` and
    # `updated_at` to the server defaults from 0001.
    for row in REFERENCE_CATEGORIES:
        op.execute(_guarded_insert(row))


def downgrade() -> None:
    # --- Removal, restricted to this revision's own rows -------------------------------------
    # Scoped to REFERENCE_SLUGS, and never a bare `DELETE FROM categories`. A category an
    # administrator created through POST /api/v1/admin/categories is not this revision's to
    # remove, and a blanket delete would take it along with the eight that are.
    #
    # A Core delete() construct rather than sa.text(): alembic applies `literal_binds` only when
    # compiling something that is not a TextClause, so a text statement carrying bound
    # parameters would render placeholders instead of values under `--sql` and produce a
    # rollback script that could not be replayed. This construct renders
    # `DELETE FROM categories WHERE categories.slug IN ('engineering', ...)` in both modes.
    #
    # `slug` is citext, so the comparison folds case in the database: a reference slug somebody
    # stored with different capitalisation is still matched, and still removed.
    #
    # No DDL here either - there is nothing structural to reverse. post_categories.category_id
    # cascades, so the rows filing posts under these categories go with them; that is the
    # association's designed behaviour, and the module docstring records what it costs.
    op.execute(categories_table.delete().where(categories_table.c.slug.in_(REFERENCE_SLUGS)))
