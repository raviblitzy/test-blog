"""drop category name trigram index

Revision ID: 0005
Revises: 0004
Create Date: 2026-08-10 05:20:00.000000+00:00

The first revision in this history whose subject is an object that is no longer wanted.

``0002`` created eight indexes, and one of them - ``ix_categories_name_trgm``, a GIN
``gin_trgm_ops`` index over ``categories.name`` - has since lost its only reader. This revision
drops it, and it exists as its own step for one reason: ``0002`` has already run. A revision that
has been applied and stamped is history, and history describes what a database was *told to do*
rather than what it should have been told. Editing ``0002`` to omit the index would have left every
database that already ran it holding an index no later revision removes, while a database created
afterwards would never have had it - two schemas, one revision number, and no statement anywhere
that could reconcile them. Removing an object is therefore a forward step, exactly as adding one is.

Why the index is no longer wanted
---------------------------------
A trigram index earns its cost by serving a *pattern* predicate - ``LIKE``, ``ILIKE`` or the
``%`` similarity operator. ``categories.name`` has no such predicate anywhere in the service. The
taxonomy has exactly one read, ``GET /api/v1/categories``, and
``app.repositories.category_repository.list_with_post_counts`` returns every term unfiltered: there
is no search box over category names, and the administrative category surface exposes creation,
update and deletion only. The one pattern predicate the taxonomy does issue is the anchored
``slug LIKE 'base%'`` family scan that slug de-duplication runs before every category insert and
rename, and that is served by ``ix_categories_slug_trgm``, which ``0002`` also created and which
stays.

So the index was never read, and an unread index is not free. It is maintained on every insert into
and update of ``categories``, it occupies pages in the buffer cache that a read path could be using,
and it has to be rebuilt by ``REINDEX`` and copied by every base backup. ``categories`` is the
smallest relation in this schema, so the saving is small in absolute terms - the point is that the
object is unjustified, and an index nothing explains is the kind of object that later gets copied
onto a relation where the cost is not small.

What this does NOT change
-------------------------
``categories.name`` keeps its UNIQUE constraint and the B-tree index that enforces it, so name
uniqueness and equality lookups are untouched: this revision removes a *pattern-matching* access
path and nothing else. ``pg_trgm`` stays enabled - six trigram indexes still depend on it, and the
extension is owned by ``0001`` in any case. No row is read or written, no column is added or
dropped, and no constraint is altered.

The model side already agrees. ``app.models.category.Category.__table_args__`` declares
``ix_categories_slug_trgm`` and no index over ``name``, so ``alembic check`` at ``head`` is what
proves this revision and that module describe the same schema: before this revision existed the
check reported a pending *drop*, which is the drift gate doing its job rather than a nuisance.

Reversibility
-------------
``downgrade()`` recreates the index with the identical name, table, column, method and operator
class ``0002`` used, so a database walked down to ``0004`` is byte-for-byte the schema ``0004``
left behind and can be walked back up again. The definition is duplicated here rather than imported
from ``0002``, because a revision must keep emitting the DDL it was written to emit even after the
revision beside it changes - the same rule that made an edit to ``0002`` the wrong instrument in the
first place.

The index is not rebuilt ``CONCURRENTLY`` and is not dropped ``CONCURRENTLY``: Alembic wraps a
revision in a transaction and neither concurrent form may run inside one, so the flag would abort
the migration rather than shorten its lock. ``DROP INDEX`` takes a brief ``ACCESS EXCLUSIVE`` lock
on ``categories``, and the recreation in ``downgrade()`` takes ``ROW EXCLUSIVE`` - the same trade
``0001``, ``0002`` and ``0004`` already make for every index in this schema.
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # By name, because that is the only handle a drop needs - the operator class and the access
    # method were the create's business and are recorded in `downgrade()` below. `table_name` is
    # passed because Alembic uses it for the reflection-free `DROP INDEX` it renders and because
    # it documents, at the call site, which relation loses the access path.
    op.drop_index("ix_categories_name_trgm", table_name="categories")


def downgrade() -> None:
    # The definition `0002` used, reproduced exactly: same name, same relation, same column, same
    # access method, same operator class. `categories.name` is TEXT rather than CITEXT, so
    # `gin_trgm_ops` - which is defined over `text` - goes straight on the column with no cast,
    # which is why this entry needs no `literal_column` where the slug index does.
    op.create_index(
        "ix_categories_name_trgm",
        "categories",
        ["name"],
        postgresql_using="gin",
        postgresql_ops={"name": "gin_trgm_ops"},
    )
