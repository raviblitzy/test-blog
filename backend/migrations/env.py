"""Alembic environment: the bridge between the migration CLI and this service's own metadata.

Alembic *executes* this module as a script - it never imports it - at the start of every
command it runs, so this is the one place where the migration tooling meets the application::

    alembic upgrade head                        apply every revision to the database
    alembic downgrade base                      unwind every revision, proving reversibility
    alembic check                               compare the models against the live schema
    alembic revision --autogenerate -m "..."    diff the models and write a revision
    alembic upgrade head --sql                  emit the DDL to stdout, connecting to nothing

Three of those are blocking quality gates - ``upgrade head`` against an empty database, the
``downgrade base`` / ``upgrade head`` cycle, and ``check`` reporting nothing pending - and all
three run through this file. A mistake here therefore does not fail one command; it takes the
whole reversible-schema-evolution guarantee down with it.

The canonical working directory is ``backend/``, because ``alembic.ini`` resolves both
``script_location = migrations`` and ``prepend_sys_path = .`` against the process working
directory. That second setting is what puts the directory holding ``app/`` on ``sys.path`` and
so makes the bare ``import app...`` statements below resolve; run from anywhere else, Alembic
stops immediately with ``Path doesn't exist: migrations``. The ``Makefile`` (``cd backend &&
.venv/bin/alembic ...``) and the container start-up command both honour that.

Two facts a maintainer needs before changing anything here
----------------------------------------------------------
**The connection URL comes from the application's settings, not from this tree.**
``backend/alembic.ini`` deliberately declares no ``sqlalchemy.url``; :func:`_get_url` reads
``settings.DATABASE_URL`` instead, so one settings object serves the application and the
migration runner and the two can never disagree about which database they are pointed at.
Nothing here reads the environment directly, carries a default or a fallback URL, or logs a
URL that still carries a credential in it - :func:`_redacted` exists for that last part, and it
drops the whole libpq query string as well as masking the authority password, because several
libpq parameters are themselves credentials and ``hide_password`` does not touch them.

**The engine built here is synchronous; the application's is asynchronous.**
``app.db.session`` owns the async engine and declares no synchronous one, so this module
constructs its own with :func:`~sqlalchemy.create_engine` and never imports that module.
No event loop is involved: a migration is a short-lived, single-connection, strictly
sequential operation, and wrapping it in ``asyncio.run`` would buy nothing.

The two are built from *the same URL string*, unchanged. SQLAlchemy's ``postgresql+psycopg``
dialect - psycopg 3 - serves both drivers, which is exactly why this project pins one database
driver rather than two. If you ever find yourself wanting to rewrite the scheme, strip
``+psycopg``, or derive a separate "sync URL", stop: that is the wrong turn this paragraph
exists to prevent.

What autogeneration is told, and why
------------------------------------
Both :func:`context.configure <alembic.runtime.environment.EnvironmentContext.configure>`
call sites pass ``compare_type=True`` and ``compare_server_default=True``, and they are
mandatory rather than thorough. Without the first, a column whose type diverged from its model
compares equal and ``alembic check`` passes; without the second, so does a column that lost
its ``server_default`` - and this schema leans on server-side defaults for every value it
declares the database responsible for, from ``gen_random_uuid()`` on each primary key through
``now()`` on the audit columns to the ``'DRAFT'::post_status`` lifecycle default. Those two
flags are what make the drift gate able to see any of it. Silencing a stubborn drift report by
turning either one off is not a fix; it disables the gate for the entire schema. Narrow the
exclusion instead - :func:`include_object` is the place - and say in a comment why.

``compare_server_default=True`` has one audible side effect, and it is Alembic's rather than
this project's. Every comparison run - ``alembic check`` included - emits
``UserWarning: Computed default on posts.search_vector cannot be modified`` from
``alembic/autogenerate/compare/server_defaults.py``, because ``posts.search_vector`` is a
``GENERATED ALWAYS AS ... STORED`` column whose expression Alembic can see but cannot diff.
``check`` still reports no operations and still exits ``0``; the warning is the honest statement
that this one column is outside what the gate can compare. **It is deliberately not filtered
here.** A ``warnings.filterwarnings`` in this module would silence precisely the case where
``app.models.post`` and revision ``0002`` had drifted apart on that expression, turning a visible
caveat into a blind spot - and a generated column is the one thing autogeneration cannot report
any other way. The consequence to know about is narrow: a pipeline that runs the check with
``-W error`` turns the warning into a failure - measured, ``python -W error -m alembic check``
exits ``1`` while the plain command exits ``0``. A continuous-integration job should therefore run
``alembic check`` as it stands, or scope any ``-W error`` promotion so that this one Alembic
warning stays a warning.

The other half of that gate is the ``import app.models`` line below. Autogeneration compares
the *model* side against the *database* side, and a relation joins the model side only once
the module declaring it has been imported. Drop that import and ``upgrade`` still works,
because the revisions are hand-authored; ``check`` still exits 0, because it compares against
empty metadata and finds nothing to report. That is the one failure mode in this file that is
completely silent, which is why the import is commented where it stands.

What is deliberately absent
---------------------------
* No ``os.environ``, ``os.getenv``, ``dotenv`` or ``.env`` read: ``app.core.config`` is the
  single reader of the environment, and it fails loudly at import when a required variable is
  missing. Softening that here would move the failure to a worse place.
* No second logging configuration. ``app.core.logging.configure_logging()`` is called below -
  with ``stream=sys.stderr``, so that ``--sql`` output on stdout stays executable SQL - and is
  the only thing that configures logging here, so a migration's output has the same shape, and
  the same one-line-per-event guarantee, as the service's. ``alembic.ini`` deliberately carries
  no ``[loggers]``/``[handlers]``/``[formatters]`` stanzas and this file never calls
  :func:`~logging.config.fileConfig`: doing both would attach two handlers to the root logger
  and render every line twice, once as plain text and once as JSON.
* No ``Base.metadata.create_all()``. Creating the schema is the revisions' job, and
  ``create_all`` would bypass the version table entirely, leaving a populated database that
  Alembic believes is empty.
* No ``import app.main``: constructing the FastAPI application, its middleware and its routers
  on the way to a ``downgrade`` would be pure cost and a new class of failure.
* No ``render_as_batch``, no SQLite branch and no custom ``version_table``. Batch mode is a
  SQLite accommodation, PostgreSQL 18 is the only supported backend, and the container
  start-up step, the ``Makefile`` and the CI workflow all invoke the CLI expecting Alembic's
  default ``alembic_version`` table.
* No ``process_revision_directives`` hook. Suppressing an empty autogenerated revision would
  interfere with the very comparison ``alembic check`` reads.
"""

import logging
import sys
from typing import TYPE_CHECKING

from alembic import context
from sqlalchemy import create_engine, pool, text
from sqlalchemy.engine import make_url

# LOAD-BEARING, AND NOT DEAD CODE - DO NOT DELETE THIS IMPORT.
#
# It is here for its side effect and for nothing else: importing the package imports all six
# model modules, and that is what attaches all seven relations - users, refresh_tokens,
# categories, posts, post_categories, comments, post_likes - to the single MetaData that
# `metadata` below refers to. Without it that collection is empty, `--autogenerate` proposes
# creating tables that already exist, and `alembic check` compares nothing against nothing and
# reports no drift for a schema it cannot see. The `noqa` is deliberate and is the only
# suppression in this file: F401 is exactly right about the name being unused, and wrong about
# the import being unnecessary.
import app.models  # noqa: F401
from app.core.config import settings
from app.core.logging import configure_logging
from app.db.base import metadata

if TYPE_CHECKING:
    # Imported for annotations only, and therefore never at run time. Both of these are
    # Alembic's own aliases for the arguments it passes to the two filters below, and taking
    # them from the source keeps the signatures honest; deferring them means a future release
    # that moves either name breaks type checking rather than every migration command.
    from alembic.runtime.environment import NameFilterParentNames, NameFilterType
    from sqlalchemy.engine import Connection
    from sqlalchemy.sql.schema import SchemaItem


# The Config object Alembic built from backend/alembic.ini plus the command line.
config = context.config

# Logging comes from app.core.logging, exactly as it does for the service - ON STDERR.
#
# This is the one place a migration could have diverged, and it is why it does not. Alembic's
# generated template configures logging from `[loggers]`/`[handlers]`/`[formatters]` stanzas in
# alembic.ini via `fileConfig`, which installs a plain-text StreamHandler. In a container at
# ENVIRONMENT=production that means the record of which revisions were applied - the very lines
# the start-up step and the CI job read - is the one part of the stream a JSON log collector
# cannot parse, while everything the same image logs a second later is JSON. Calling
# configure_logging() instead puts `alembic` and `alembic.runtime.migration` through the same
# processor chain as the application: human-readable under ENVIRONMENT=development, one JSON
# object per line everywhere else, with `LOG_LEVEL` deciding the threshold.
#
# THE STREAM ARGUMENT IS LOAD-BEARING, NOT A STYLISTIC CHOICE. `alembic upgrade head --sql`
# writes generated DDL to STDOUT, and the documented way to keep it is to redirect that stream
# to a file. Every record emitted before the first statement therefore has to go somewhere
# else, and an offline upgrade emits four of them: one from this module, plus
# `Context impl PostgresqlImpl.`, `Generating static SQL` and `Will assume transactional DDL.`
# from Alembic's own `alembic.runtime.migration` logger, which reaches the single root handler
# this call installs. Left on stdout they land inside the redirected file ahead of `BEGIN;` and
# the result is not executable SQL. Binding this process's handler to stderr makes
# stdout a pure SQL channel STRUCTURALLY - for every logger, in both offline and online mode,
# whatever LOG_LEVEL is set to - rather than relying on nobody adding a log line later. The
# records are not lost: a container runtime and a CI job both collect stderr, and it is the
# stream Alembic's own template binds its console handler to (`args=(sys.stderr,)`).
#
# alembic.ini therefore declares NO logging stanzas at all, and `fileConfig` is deliberately
# not called - not even as a fallback. Calling both would attach two handlers to the root
# logger and render every line twice, one of the two on stdout again.
#
# It also means `alembic upgrade head` fails fast on a misconfigured environment, because
# app.core.config is imported before any connection is attempted.
configure_logging(stream=sys.stderr)

logger = logging.getLogger("alembic.env")
"""Diagnostics from this module, routed through alembic.ini's `alembic` logger at INFO."""

target_metadata = metadata
"""The collection autogeneration compares against the live database.

The same object as ``app.db.base.Base.metadata``, imported through the alias that module
publishes for this exact purpose. It carries ``NAMING_CONVENTION``, which is what makes the
``ix_``/``uq_``/``ck_``/``fk_``/``pk_`` identifiers in the revisions reproducible; nothing here
may override or re-declare it, because a constraint is named when its Table is defined and a
convention swapped in afterwards would rename every key in the schema at once.
"""


_EXTENSION_OWNED_RELATION_QUERY = text(
    # Every relation - table, index, sequence or view - that a PostgreSQL extension installed
    # and therefore owns. `pg_depend` rows whose referenced class is `pg_extension` are exactly
    # the extension-membership edges, so this is the catalogue's own answer rather than a
    # hand-maintained list that would drift the moment an extension was added.
    """
    SELECT c.relname
    FROM pg_depend AS d
    JOIN pg_class AS c ON c.oid = d.objid AND d.classid = 'pg_class'::regclass
    WHERE d.refclassid = 'pg_extension'::regclass
    """
)
"""Introspection behind :data:`_extension_owned_relations`. See :func:`include_object`."""

_extension_owned_relations: frozenset[str] = frozenset()
"""Relations owned by an installed extension, resolved once per online run.

Rebound exactly once, by :func:`run_migrations_online`, over a **separate** short-lived
connection opened before the migration connection exists - see the warning on that function for
the silent rollback that resolving it on the migration connection would cause. Both filters
below therefore read a settled value for the whole run. Left empty in offline mode, which is
correct rather than a shortcut: ``--sql`` reflects nothing, so there is no database-side object
for a filter to have an opinion about.

Measured on PostgreSQL 18.4 with this schema's three extensions installed - ``citext``,
``pg_trgm`` and ``unaccent`` - this set is **empty**: those three contribute types, functions,
operators and operator classes, and not one relation. The guard is still the correct shape,
because it is what stops an extension that *does* install a relation (a future ``pg_stat_*``,
say) from being reported as a table nothing declares and proposed for deletion.
"""


def _get_url() -> str:
    """Return the PostgreSQL connection URL, from the one place allowed to know it.

    ``settings.DATABASE_URL`` is already validated by ``app.core.config``: it must carry the
    ``postgresql+psycopg://`` scheme and name a host and a database, and an absent or malformed
    value stops the process at import with a message that says which variable was wrong. That
    is the intended behaviour, so there is deliberately no fallback, no default and no
    localhost convenience value anywhere in this module.

    The value is used **verbatim**. psycopg 3 backs both the application's async engine and the
    synchronous engine below, so one string serves both and no transformation is needed.

    ``str()`` is a no-op today - the field is declared ``str`` - and is kept as one line of
    insurance: were it ever retyped as a Pydantic DSN, SQLAlchemy would need the string form
    and this would keep working rather than failing at ``create_engine``.

    Note what this function does *not* do. It never calls
    ``config.set_main_option("sqlalchemy.url", ...)``, and avoiding that round trip is
    deliberate: the main option is written into a :mod:`configparser` section that performs
    ``%`` interpolation, so a URL-encoded password containing a percent sign raises
    ``InterpolationSyntaxError`` unless every ``%`` is doubled first. Passing the URL straight
    to :func:`context.configure` and :func:`~sqlalchemy.create_engine` removes that whole class
    of bug, and nothing in this project reads ``sqlalchemy.url`` back.
    """
    return str(settings.DATABASE_URL)


def _redacted(url: str) -> str:
    """Render *url* as scheme, user, host, port and database only - nothing else.

    A connection URL carries credentials, and these log lines are collected by CI and by
    whatever ships the container's output, so no part of the value that can hold a secret may
    reach them. Two things are removed, and the second is the one that is easy to miss.

    **The authority password**, by SQLAlchemy's own renderer via ``hide_password=True``. Using
    the renderer rather than a regular expression maintained here means the masking stays
    correct for every URL shape it accepts.

    **The entire query string**, unconditionally, before it is rendered. ``hide_password``
    masks *only* the password between ``://`` and ``@``; every libpq parameter after ``?`` is
    rendered verbatim, and ``app.core.config`` deliberately accepts those parameters because
    ``?sslmode=require`` and ``?connect_timeout=5`` are legitimate values a deployment needs.
    Several of them are credentials - ``password``, ``sslpassword``, ``sslkey``,
    ``sslcert``, ``sslcrl``, ``passfile``, ``krbsrvname``, ``gssdelegation`` - so a URL such as
    ``…/blog?sslmode=verify-full&sslpassword=…`` rendered by ``hide_password`` alone writes a
    key-file passphrase straight into a migration log and into ``--sql`` output. Measured on
    SQLAlchemy 2.0.51: ``sslpassword=topsecret`` and even a second ``password=…`` in the query
    survive ``hide_password=True`` untouched.

    Dropping the whole mapping is deliberately chosen over redacting a list of sensitive keys.
    A list is a thing to keep in step with libpq, and the first parameter it does not name is
    logged in full; dropping everything cannot fall behind. Nothing is lost that a log line
    needs, either - which database on which host this run is pointed at is the diagnostic
    question, and connection *options* are configuration an operator already has in front of
    them. The query mapping is therefore never read, never partially masked and never logged in
    any form, here or anywhere else in this module.
    """
    parsed = make_url(url)
    # `difference_update_query` returns a copy without the named keys; passing every key it
    # carries leaves an empty query, and passing the keys of a URL that has none is a no-op.
    without_query = parsed.difference_update_query(parsed.query.keys())
    return without_query.render_as_string(hide_password=True)


def _reflect_extension_owned_relations(connection: Connection) -> frozenset[str]:
    """Ask the catalogue which relations belong to an installed extension.

    One cheap catalogue query per online run, issued on a connection of its own - never on the
    connection handed to :func:`context.configure`, for the reason set out in the warning on
    :func:`run_migrations_online`. See :data:`_extension_owned_relations` for what the answer is
    used for and why it is normally empty.
    """
    return frozenset(connection.scalars(_EXTENSION_OWNED_RELATION_QUERY))


def _owning_relation_name(
    object_: SchemaItem,
    name: str | None,
    type_: NameFilterType,
) -> str | None:
    """Return the name of the relation *object_* belongs to, or ``None`` if it belongs to none.

    A table owns itself; a column, index or constraint carries a ``table`` attribute pointing
    at the relation it hangs off. Anything else - a schema, most obviously - has no owning
    relation, and ``None`` says so rather than guessing.
    """
    if type_ == "table":
        return name
    table = getattr(object_, "table", None)
    return None if table is None else str(table.name)


def include_object(
    object_: SchemaItem,
    name: str | None,
    type_: NameFilterType,
    reflected: bool,
    compare_to: SchemaItem | None,
) -> bool:
    """Decide whether *object_* takes part in the autogenerate comparison.

    **Allow-by-default, on purpose.** Every branch that is not a deliberate, documented
    exclusion returns ``True``. A filter that returned ``False`` broadly would make
    ``alembic check`` quiet rather than clean, which is worse than no filter at all: the gate
    would keep passing while the schema and the models drifted apart.

    Exactly one thing is excluded, and only in one situation: a **reflected** object that no
    model declares (``compare_to is None``) and that belongs to a relation an installed
    extension owns. Those relations are created by ``CREATE EXTENSION`` inside revision
    ``0001``, never by SQLAlchemy metadata, so autogeneration has nothing to match them against
    and would propose dropping them. See :data:`_extension_owned_relations`, which also records
    why the set is empty on this schema's three extensions and why the guard still belongs here.

    This is the narrow place to exclude a genuine false positive, should one ever appear, and
    the five candidates worth naming are the PostgreSQL-specific constructs this schema uses
    that autogeneration is known to compare imperfectly: ``posts.search_vector``, a
    ``GENERATED ALWAYS AS ... STORED`` ``tsvector``; the three native enumerated types
    ``user_role``, ``post_status`` and ``comment_status``; the four ``citext`` columns
    ``users.email``, ``users.username``, ``posts.slug`` and ``categories.slug``; the three GIN
    indexes carrying a ``gin_trgm_ops`` operator class **on a column** - over ``posts.title``,
    ``categories.name`` and ``comments.body``; and the four carrying it on an **expression**, the
    text cast of each ``citext`` column - ``ix_users_username_trgm``, ``ix_users_email_trgm``,
    ``ix_posts_slug_trgm`` and ``ix_categories_slug_trgm``.

    **All five were verified clean** against PostgreSQL 18.4 with both comparison flags on -
    ``alembic check`` reported no pending operations across a full ``upgrade`` / ``check`` /
    ``downgrade base`` / ``upgrade`` / ``check`` cycle - so not one of them is excluded here,
    and none should be excluded speculatively. Two reasons they hold, worth recording so a
    future reader does not go looking: the models declare each construct explicitly rather than
    leaving it to a default (``Computed(..., persisted=True)``, ``postgresql.ENUM(...,
    create_type=False)`` with a matching ``server_default``, an explicit ``CITEXT``, and
    ``postgresql_using``/``postgresql_ops`` on every index), and ``citext`` is registered in
    SQLAlchemy's PostgreSQL ``ischema_names``, so it reflects back as the same type the model
    declares rather than as a generic one.

    The **expression** indexes hold for a third reason, and it is a spelling requirement rather
    than a property of the schema. Each is declared as a labelled
    :func:`~sqlalchemy.literal_column` with its operator class in ``postgresql_ops``, never as one
    ``text("(col::text) gin_trgm_ops")`` string. The two render identical DDL, but Alembic's
    PostgreSQL comparator warns ``Expression ... detected to include an operator clause. Expression
    compare cannot proceed`` on the inline form and then skips that index entirely - which would
    leave four objects silently unguarded by the gate this function exists to keep honest, and would
    add a warning to every ``check``. Measured both ways against 18.4: the labelled form compares
    clean and warning-free, the inline form warns and stops comparing.

    The one artefact the comparison does produce is a ``UserWarning`` on every ``check``:
    ``Computed default on posts.search_vector cannot be modified``. It is informational -
    Alembic is saying it cannot rewrite a generated column, not that anything differs - and it
    yields no operation and does not fail the gate. It is deliberately left in place: excluding
    the column to silence it would also stop its *type* being compared, trading a real check for
    a quieter log.

    If a genuine false positive ever does appear, exclude that single object here by name and
    say why in a comment - never by turning a comparison flag off, which would blind the gate to
    the whole schema.
    """
    # The model side is declared in this repository by definition, so it is always in scope:
    # a table, column or index that exists in the metadata is the thing being compared.
    if not reflected:
        return True

    # Reflected AND matched to a model-side counterpart. This pairing is precisely the
    # comparison the drift gate exists to make, so it is never filtered out.
    if compare_to is not None:
        return True

    owner = _owning_relation_name(object_, name, type_)
    if owner is not None and owner in _extension_owned_relations:
        logger.info(
            "Excluding %s %r from the comparison: relation %r is owned by an extension",
            type_,
            name,
            owner,
        )
        return False

    # A reflected object with no model counterpart that no extension owns is real drift -
    # a leftover table, a stray index - and reporting it is the whole point of the gate.
    return True


def include_name(
    name: str | None,
    type_: NameFilterType,
    parent_names: NameFilterParentNames,
) -> bool:
    """Decide whether the database-side *name* is reflected at all.

    The companion to :func:`include_object`, one step earlier: this one prunes what Alembic
    looks at, that one prunes what enters the diff. Both are allow-by-default for the same
    reason, and both consult :data:`_extension_owned_relations` so the two layers cannot
    disagree about what an extension owns.

    Two names are filtered:

    * **Schemas other than the default one.** ``include_schemas=False`` at both
      ``configure()`` call sites already restricts reflection to a single schema, and Alembic
      passes it here as ``None`` rather than by name, so this guard normally sees ``None`` and
      accepts it. ``"public"`` is accepted too, because that is the same schema spelled out,
      and anything else is somebody else's schema: this service owns exactly one.
    * **Relations an installed extension owns**, skipped here so they are never reflected in
      the first place - cheaper than reflecting one and discarding it downstream.

    Alembic excludes its own ``alembic_version`` table on both sides before either filter runs,
    so it needs no handling here and must not be given any.
    """
    if type_ == "schema":
        return name is None or name == "public"

    if type_ == "table" and name in _extension_owned_relations:
        logger.info(
            "Not reflecting relation %r in schema %r: owned by an extension",
            name,
            parent_names.get("schema_name"),
        )
        return False

    return True


def run_migrations_offline() -> None:
    """Emit the migrations as SQL on stdout, connecting to nothing.

    This is the ``--sql`` path::

        alembic upgrade head --sql > schema.sql
        alembic downgrade head:base --sql > rollback.sql

    It exists so the DDL can be reviewed, diffed or handed to someone who applies it under
    change control, before a single statement touches a managed database.
    ``literal_binds=True`` is what makes that output self-contained - parameters are rendered
    inline rather than left as placeholders a driver would have to bind - and the ``named``
    paramstyle keeps anything that cannot be rendered inline readable.

    Note the explicit ``head:base`` in the second command: offline mode cannot ask the database
    where it currently stands, so Alembic requires a downgrade range rather than a bare target
    and refuses ``downgrade base --sql`` with ``requires <fromrev>:<torev>``. That is Alembic's
    own precondition, not a limitation of this module.

    The URL is still required even though no connection is opened: Alembic needs the dialect it
    names in order to compile PostgreSQL DDL rather than something generic. Verified by
    execution: pointed at an unreachable host, both commands above still exit ``0`` and render
    output byte-identical to a run against a live server.

    **Stdout carries SQL and nothing but SQL**, which is what makes that redirection safe, and
    it is arranged at the top of this module rather than here: ``configure_logging`` is called
    with ``stream=sys.stderr``, so the single root handler - the exit for the diagnostic line
    below, for Alembic's own ``Context impl``/``Generating static SQL``/``Will assume
    transactional DDL`` records, for SQLAlchemy and for Python warnings alike - writes to
    stderr. The guarantee is structural rather than a convention each log call has to remember,
    and it does not depend on ``alembic.ini``, which deliberately configures no logging at all.
    Verified by execution: with the handler on stdout the first four lines of
    ``alembic upgrade head --sql`` were log records and the redirected file would not run; with
    it on stderr the first line is ``BEGIN;`` and every record is still on stderr.
    """
    url = _get_url()
    logger.info("Rendering migrations offline for %s", _redacted(url))

    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        # Mandatory here as well as online, and for the same reason: this mode also serves
        # `alembic revision --autogenerate --sql`-style inspection, and a comparison
        # configured differently between the two modes would be a comparison nobody can trust.
        compare_type=True,
        compare_server_default=True,
        include_object=include_object,
        include_name=include_name,
        include_schemas=False,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Apply the migrations against a live database over a synchronous connection.

    The path every real invocation takes - ``upgrade``, ``downgrade``, ``check``,
    ``revision --autogenerate``, ``stamp``, ``history`` - and it is deliberately direction-
    agnostic: nothing here inspects which revision was asked for, so ``downgrade base`` runs
    through exactly the same code as ``upgrade head``. That symmetry is what makes the
    up/down/up cycle a property of the tooling rather than of the operator's luck.

    :class:`~sqlalchemy.pool.NullPool` because a migration run opens one connection, uses it
    once and exits: a pool would add nothing but a set of sockets to tear down. The engine is
    disposed in a ``finally`` so the CLI returns without leaving a connection behind even when
    a revision raises, which matters most in CI, where a lingering backend can hold a lock that
    the next step then waits on.

    Transaction handling is left at Alembic's default - one transaction spanning the whole run,
    so a failed revision rolls the entire attempt back rather than stranding the schema
    half-migrated. ``transaction_per_migration`` is not set. The one thing that would force it
    is ``CREATE INDEX CONCURRENTLY``, which cannot run inside a transaction block; the GIN and
    trigram indexes in revision ``0002`` are therefore built non-concurrently, which is correct
    for a schema whose indexes are created before it holds any data.

    .. warning::

       **Nothing may execute a statement on the migration connection before**
       :func:`context.configure`. This is the one trap in this file whose symptom is a
       *success*, so it is worth knowing exactly why the extension probe below is given its own
       connection rather than sharing this one.

       ``MigrationContext.configure()`` records ``connection.in_transaction()`` once, as
       ``_in_external_transaction``, and when that is true it treats the run as being inside a
       transaction somebody else will commit, so
       :meth:`~alembic.runtime.migration.MigrationContext.begin_transaction` degrades to a
       :func:`~contextlib.nullcontext`. SQLAlchemy 2.0 autobegins on the *first* statement, so
       a single ``SELECT`` issued on this connection beforehand is enough to flip that flag.
       Alembic then commits nothing, ``with connectable.connect()`` rolls the whole run back on
       exit, and the command still exits ``0`` after logging every revision as applied.
       Measured on this stack: a fresh connection reports ``_in_external_transaction`` False, a
       connection that has run one ``SELECT`` reports True, and every table an ``upgrade head``
       created under the second one was silently discarded.
    """
    global _extension_owned_relations

    url = _get_url()
    logger.info("Running migrations against %s", _redacted(url))

    connectable = create_engine(url, poolclass=pool.NullPool, future=True)
    try:
        # A SEPARATE, short-lived connection, opened and closed before the migration connection
        # exists - see the warning above for the silent rollback that sharing one would cause.
        # Both filters therefore read a settled value for the whole run, and doing it here
        # rather than lazily inside a filter keeps the ordering visible in one place. Safe as
        # module state: the Alembic CLI is a single-threaded process that executes this file
        # once. NullPool means this connection is genuinely closed, not returned to a pool.
        with connectable.connect() as probe_connection:
            _extension_owned_relations = _reflect_extension_owned_relations(probe_connection)

        # Untouched, and it must stay that way: configure() has to see it before any statement.
        with connectable.connect() as connection:
            context.configure(
                connection=connection,
                target_metadata=target_metadata,
                # See the module docstring: these two are what let `alembic check` see a
                # changed column type or a lost server-side default at all.
                compare_type=True,
                compare_server_default=True,
                include_object=include_object,
                include_name=include_name,
                # One schema, and `include_name` above rejects any other. Reflecting every
                # schema would drag PostgreSQL's own catalogues into the comparison.
                include_schemas=False,
            )

            with context.begin_transaction():
                context.run_migrations()
    finally:
        connectable.dispose()


# Module-level and unconditional, with no `if __name__ == "__main__"` guard - Alembic runs this
# file as a script through exec(), so `__name__` is not `"__main__"` and a guard would make
# every command silently do nothing at all.
if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
