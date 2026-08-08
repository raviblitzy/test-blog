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

Idempotency belongs to seed.py, not to this revision
----------------------------------------------------
There is no ``ON CONFLICT DO NOTHING`` guard on the insert, and adding one would be a
misreading of the contract rather than a safety improvement. Alembic already guarantees a
revision runs at most once per database, through the ``alembic_version`` table, so this insert
can never encounter a row it inserted itself.

``app.db.seed`` is the file that has to be re-runnable, and it is: ``seed_categories`` looks
each specification up by slug and then by name - both folded for case, because both columns are
``citext`` - and skips whatever it finds. So when the backend container runs
``alembic upgrade head`` on start and ``make seed`` afterwards, this revision inserts the eight
rows and the seed script reports eight skips. Reverse the order and the seed script inserts
them while this revision is simply never re-run. Whichever writer arrives first, the other
writes nothing, and the row count after the second run equals the row count after the first.

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


def upgrade() -> None:
    # --- The rows ----------------------------------------------------------------------------
    # One statement, and no DDL whatsoever.
    #
    # `bulk_insert` requires a list of dicts and rejects a tuple outright, so the module-level
    # tuple is materialised here. Each row is copied rather than passed by reference, so the
    # constant cannot be mutated through the list handed to alembic - REFERENCE_SLUGS is
    # projected from the same objects, and a caller editing one in place would silently change
    # what downgrade() removes.
    #
    # Offline (`alembic upgrade head --sql`) this renders as eight self-contained INSERT
    # statements with the values inlined, because migrations/env.py configures
    # `literal_binds=True`. Online it is one executemany. Both write the same eight rows, and
    # both leave `id`, `created_at` and `updated_at` to the server defaults from 0001.
    op.bulk_insert(categories_table, [dict(row) for row in REFERENCE_CATEGORIES])


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
