"""Idempotent reference and demonstration data for a freshly migrated database.

Run it once, run it ten times: the row counts after the second run are identical to the row
counts after the first. That property is the whole point of this module, and everything below
is arranged around it.

Why this exists
---------------
A migrated-but-empty database cannot demonstrate - or test - the three surfaces the product is
judged on. The home feed has nothing to list, so pagination has no second page to be correct
about; the category filter has no taxonomy to filter by; and the relevance search has no corpus
to rank. Seeding is therefore functional rather than decorative.

It also settles a question discovery could only raise. An ``EXPLAIN`` of the feed's
``websearch_to_tsquery`` search against a single-row table chose a **sequential scan**, which is
the planner being right rather than the index being wrong: at that size a scan genuinely is
cheaper. "The full-text index is used at volume" is consequently a claim that can only be
re-confirmed once this script has run, which makes the size of the corpus below a measured
decision. See :data:`SUBJECTS` for the measurement and the number it produced.

What it seeds, and what it deliberately does not
------------------------------------------------
Exactly three groups, in dependency order:

1. :data:`REFERENCE_CATEGORIES` - the taxonomy the category filter and the administrative
   category screen operate on.
2. The administrator account, from ``settings.SEED_ADMIN_EMAIL`` and
   ``settings.SEED_ADMIN_PASSWORD``.
3. Demonstration content - :data:`AUTHOR_ROSTER` authors and the post corpus composed from
   :data:`SUBJECTS` and :data:`ANGLES`, spanning all three lifecycle states.

Comments, likes and refresh tokens are **not** seeded. The first two are reader-generated and
belong to a reader's session; a refresh token is issued at login and stored only as a hash, so a
seeded one would be a credential nobody holds. That is why ``Comment``, ``CommentStatus``,
``PostLike`` and ``RefreshToken`` are not imported here.

How idempotency is achieved
---------------------------
Every insert is preceded by a natural-key lookup, and the natural keys are the ones the schema
already constrains: ``categories.slug`` (and ``categories.name``, which is unique too),
``users.email`` and ``users.username``, and ``posts.slug``. All four are ``citext``, so those
lookups are case-insensitive in the database as well as in this module - which is exactly why a
perceived duplicate is never "resolved" by varying case. ``Alice`` and ``alice`` are one person
to this schema, and one row.

Three consequences are worth stating because they are easy to get wrong:

* **An existing row is never overwritten.** In particular an operator who rotated the
  administrator's password does not have it silently reset by the next ``make seed``.
* **Nothing is deleted or truncated.** This module is additive. It is not a reset tool, and a
  request to "re-seed from scratch" is answered by dropping the database, not by editing this
  file.
* **An existing *account* row is verified before it is adopted, and the run stops if it fails.**
  Idempotency means "do not insert twice", not "trust whatever is there". Both account addresses
  this module looks up are predictable - ``SEED_ADMIN_EMAIL`` is configuration and the three
  :data:`AUTHOR_ROSTER` addresses are published constants here - and both are valid registration
  inputs, so a row at either may belong to someone else entirely. Since :func:`seed_posts` grants
  the row it is handed *ownership* of demonstration posts, a pre-claimed address would otherwise
  be a way to acquire authored content. :func:`seed_administrator` and
  :func:`_reject_unless_seeded_author` therefore fail closed instead, and neither elevates a
  role, reactivates an account or rewrites an identity to make a run succeed.

The whole run is one transaction with a single ``commit()`` at the end, so a failure anywhere
leaves no half-seeded database. Each helper flushes when it finishes, so a constraint violation
surfaces in the helper that caused it rather than three helpers later.

Coordinating with the migration that seeds the same categories
--------------------------------------------------------------
``backend/migrations/versions/0003_seed_reference_categories.py`` inserts the reference category
set as migration *data*, and the backend container runs ``alembic upgrade head`` on start. By the
time this script runs those rows therefore usually exist already, including on the very first run
against a freshly upgraded database. That is the ordinary direction, and :func:`seed_categories`
handles it by looking each specification up by slug and by folded name and reporting eight skips.

The reverse direction - a database left at ``0002`` and seeded before it reached ``head`` - is
**not** a supported state, and neither side absorbs it. Revision ``0003`` inserts its eight rows
unconditionally, so the next ``alembic upgrade head`` against rows this script wrote aborts on
``uq_categories_name`` with the database atomically still at ``0002``. That is deliberate: an
unconditional insert is what entitles ``0003``'s downgrade to delete those eight slugs, because
every row it leaves behind is a row it wrote itself. A guarded insert that adopted a pre-existing
category instead would leave the downgrade deleting rows the upgrade never created - along with
their ``post_categories`` associations, through ``ON DELETE CASCADE`` - and ``categories`` carries
no provenance column that could tell the two apart. The revision's own docstring works through
that trade in full.

So the ordering is a requirement rather than a convention: **migrate to ``head``, then seed.** The
backend container's start command, ``make migrate`` before ``make seed``, and the
continuous-integration job all establish it. Idempotency is this module's obligation alone - it is
the writer expected to run repeatedly, and Alembic's ``alembic_version`` row already guarantees
``0003`` runs at most once per database.

**The rows this module writes keep server-generated identifiers, and that is load-bearing rather
than incidental.** ``0003`` gives the rows *it* inserts a deterministic identifier derived from the
slug, and its ``downgrade`` deletes by exactly those identifiers - which is how a downgrade removes
only what the revision itself wrote. A category this script created is therefore adopted on the way
up and left untouched on the way down. Deriving the same identifiers here would hand this module's
rows the revision's provenance mark and put them back in the blast radius of a downgrade, so
``seed_categories`` constructs each :class:`~app.models.category.Category` without an ``id`` and
lets the ``gen_random_uuid()`` default supply one, exactly as an administrative create does.

:data:`REFERENCE_CATEGORIES` is public for exactly that reason - it is the single canonical
statement of the taxonomy, and revision ``0003`` must insert the same names, the same derived
slugs and the same descriptions. A divergence between the two is a bug to reconcile, not to
paper over. The slugs are not written by hand anywhere: they are derived with
``app.core.slug.slugify_title``, which is the same helper
``backend/app/services/category_service.py`` uses, so a seeded slug and a service-created slug for
one name are identical by construction.

What this module must not do
----------------------------
* **No DDL.** No ``Base.metadata.create_all()``, no ``CREATE``, no ``ALTER``, no extension
  enabling. Alembic owns the schema outright, and a shortcut around it would make both the
  ``alembic check`` drift gate and the upgrade/downgrade reversibility gate meaningless.
* **No invocation from application startup.** ``app.main``'s lifespan does not call this, and
  must not: seeding on boot would make every container start mutate data, and would race between
  gunicorn workers. The callers are the ``Makefile``'s ``seed`` target and a developer running
  the module directly.
* **No environment access.** ``app.core.config`` is the only reader of the environment in this
  backend; every configurable value here arrives through ``settings``.
* **No upward imports.** Nothing from ``app.services``, ``app.repositories``, ``app.schemas`` or
  ``app.api``. The data layer has no upward dependency, and no domain rule is re-implemented
  here - ownership checks, publish transitions and sanitisation live in ``app.services``.
* **No plaintext credential**, in source, in a default value, in a log line or in a comment.

Running it
----------
Both invocations resolve the plain ``app`` package correctly::

    make seed                     # from the repository root
    python -m app.db.seed         # from inside backend/

Failure propagates: the exception leaves ``asyncio.run`` and the process exits non-zero, so the
``Makefile`` target blocks rather than advises. ``engine.dispose()`` runs on the success path and
the failure path alike, so the process exits with no pooled connection left open.
"""

import asyncio
import secrets
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final

from sqlalchemy import Text, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.logging import configure_logging, get_logger
from app.core.security import hash_password
from app.core.slug import DEFAULT_MAX_LENGTH, slugify_title, unique_slug
from app.db.session import AsyncSessionLocal, engine
from app.models import Category, Post, PostStatus, User, UserRole

__all__ = [
    "ADMINISTRATOR_SLOT",
    "ANGLES",
    "AUTHOR_ROSTER",
    "REFERENCE_CATEGORIES",
    "SUBJECTS",
    "Angle",
    "AuthorSpec",
    "CategorySpec",
    "PostDraft",
    "Subject",
    "Tally",
    "main",
    "seed_administrator",
    "seed_all",
    "seed_authors",
    "seed_categories",
    "seed_posts",
]


# =======================================================================================
# Outcome reporting
# =======================================================================================


@dataclass(frozen=True, slots=True)
class Tally:
    """How many rows a helper inserted, and how many it found already present.

    Returned by every seed helper and summed by :func:`seed_all`, so a run's log output answers
    "what did that actually do" without an operator having to count rows afterwards. Frozen
    because a tally is a result rather than an accumulator: a helper builds one from its own
    two counters and hands it back.
    """

    created: int = 0
    skipped: int = 0

    @property
    def total(self) -> int:
        """Rows the helper is responsible for, whether it inserted them or not."""
        return self.created + self.skipped


# =======================================================================================
# Specifications
#
# Every spec below is a frozen dataclass with `slots=True`, and both flags are deliberate.
# Frozen makes the corpus a constant that cannot be edited at a call site, which is what lets
# revision 0003 and the tests treat `REFERENCE_CATEGORIES` as authoritative. Slots keeps
# ninety-six drafts cheap to build. Every collection field is a tuple rather than a list for
# the same reason: an immutable module-level default cannot be mutated by one caller and
# observed by the next.
# =======================================================================================


@dataclass(frozen=True, slots=True)
class CategorySpec:
    """One reference category, before its slug has been derived.

    The slug is intentionally absent. It is computed from :attr:`name` with
    ``app.core.slug.slugify_title`` at seed time so that this file cannot drift from what
    ``app.services.category_service`` would produce for the same name.
    """

    name: str
    description: str

    @property
    def slug(self) -> str:
        """The URL-safe slug this category is stored and addressed under."""
        return slugify_title(self.name)


@dataclass(frozen=True, slots=True)
class AuthorSpec:
    """One demonstration author, identified by the email its row is looked up on.

    :attr:`username` is derived from :attr:`display_name` rather than stated, for the same
    reason a category slug is: it guarantees the value is lowercase, ASCII and hyphen-separated,
    which it has to be because it becomes the public profile path ``/u/{username}``.
    """

    email: str
    display_name: str
    bio: str
    avatar_url: str | None

    @property
    def username(self) -> str:
        """The preferred handle, before it is resolved against handles already taken."""
        return slugify_title(self.display_name)


@dataclass(frozen=True, slots=True)
class Subject:
    """One subject area: the vocabulary a post about it uses, and the prose it contributes.

    A subject supplies the *substance* of an article and an angle supplies its *framing*; the
    corpus is their product. Splitting them that way is what lets ninety-six posts carry
    ninety-six genuinely different search vocabularies without ninety-six hand-written bodies,
    and it is the vocabulary that matters here - relevance ranking is only demonstrable when
    a search term matches a small fraction of the corpus rather than all of it or none of it.
    """

    noun: str
    category_slugs: tuple[str, ...]
    thesis: str
    detail: str
    pitfall: str
    takeaways: tuple[str, str, str]

    @property
    def title_noun(self) -> str:
        """:attr:`noun` with its first character upper-cased, for sentence-initial use.

        Only the first character is touched. Title-casing the whole value would turn
        ``API versioning`` into ``Api Versioning``, and lower-casing it would turn it into
        ``api versioning``; both are wrong in a headline.
        """
        return self.noun[:1].upper() + self.noun[1:]


@dataclass(frozen=True, slots=True)
class Angle:
    """One editorial framing, applied across every subject.

    The four templates each take ``{noun}``, ``{Noun}`` and ``{thesis}``. Keeping the headings
    on the angle rather than the subject is what makes an article's shape recognisable while its
    content stays specific.
    """

    title_template: str
    excerpt_template: str
    lede_template: str
    practice_heading: str
    practice_template: str
    detail_heading: str
    pitfall_heading: str


@dataclass(frozen=True, slots=True)
class PostDraft:
    """A fully resolved post, ready to become a row.

    Everything a ``posts`` row needs except its identity, its audit columns and its search
    vector. Those three are the database's to supply: ``id`` from ``gen_random_uuid()``,
    ``created_at``/``updated_at`` from the timestamp mixin's server defaults, and
    ``search_vector`` from the generated column. ``published_at`` is not in that group - it is a
    domain fact about when an author published, so it is carried here and set explicitly.
    """

    slug: str
    title: str
    excerpt: str
    content: str
    status: PostStatus
    published_at: datetime | None
    view_count: int
    cover_image_url: str | None
    author_slot: int
    category_slugs: tuple[str, ...]


# =======================================================================================
# Reference data
# =======================================================================================


REFERENCE_CATEGORIES: Final[tuple[CategorySpec, ...]] = (
    CategorySpec(
        name="Engineering",
        description=(
            "Practices that hold across the whole stack: reviewing, testing, typing and the "
            "unglamorous discipline that keeps a codebase readable as it grows."
        ),
    ),
    CategorySpec(
        name="Architecture",
        description=(
            "Boundaries, contracts and the decisions that are expensive to reverse - layering, "
            "versioning, and where a responsibility is allowed to live."
        ),
    ),
    CategorySpec(
        name="Backend",
        description=(
            "Service-tier work: request handling, dependency wiring, business rules and the "
            "REST surface the client tier is written against."
        ),
    ),
    CategorySpec(
        name="Frontend",
        description=(
            "The client tier: server and client components, tokens, layout, theming and the "
            "accessibility floor every interactive control has to clear."
        ),
    ),
    CategorySpec(
        name="Databases",
        description=(
            "Schema design, migrations, indexing and query plans - the invariants worth pushing "
            "into PostgreSQL rather than defending in application code."
        ),
    ),
    CategorySpec(
        name="DevOps",
        description=(
            "Getting the thing to run and stay running: images, pipelines, health probes and "
            "the logs and traces you need before an incident, not during one."
        ),
    ),
    CategorySpec(
        name="Security",
        description=(
            "Credentials, tokens, authority checks, rate limits and content sanitisation - "
            "enforced on the server, because a hidden control is not a boundary."
        ),
    ),
    CategorySpec(
        name="Product",
        description=(
            "Turning a requirement into something usable: scope, defaults, empty states and "
            "the small decisions readers actually notice."
        ),
    ),
)
"""The canonical taxonomy. **Revision 0003 must insert exactly this set.**

Eight categories, each with a name, a derived slug and a description. The derived slugs, stated
here so that ``backend/migrations/versions/0003_seed_reference_categories.py`` can be checked
against them by eye rather than by guesswork:

``engineering``, ``architecture``, ``backend``, ``frontend``, ``databases``, ``devops``,
``security``, ``product``.

Note ``DevOps`` collapsing to ``devops`` rather than ``dev-ops``: that is
``app.core.slug.slugify_title``'s output for the name, which is precisely why the slug is derived
instead of typed. :data:`SUBJECTS` references these slugs, so adding a category here is safe
while renaming one requires updating both this tuple and every subject that cites it -
:func:`seed_posts` raises rather than silently dropping an association if the two disagree.
"""


AUTHOR_ROSTER: Final[tuple[AuthorSpec, ...]] = (
    AuthorSpec(
        email="maya.rodriguez@example.com",
        display_name="Maya Rodriguez",
        bio=(
            "Backend engineer. Writes about the seam between a request and a query, and about "
            "the constraints she would rather PostgreSQL enforced than she did."
        ),
        avatar_url="https://picsum.photos/seed/maya-rodriguez/256/256",
    ),
    AuthorSpec(
        email="devon.park@example.com",
        display_name="Devon Park",
        bio=(
            "Platform engineer. Spends most of his time on the boring parts - images, "
            "pipelines, probes - on the theory that boring is what on-call wants."
        ),
        avatar_url="https://picsum.photos/seed/devon-park/256/256",
    ),
    AuthorSpec(
        email="priya.nair@example.com",
        display_name="Priya Nair",
        bio=(
            "Front-end engineer with an accessibility habit. Believes a design system earns "
            "its keep the first time a palette changes and nothing else has to."
        ),
        avatar_url=None,
    ),
)
"""The demonstration authors, in the order :func:`seed_posts` addresses them by slot.

Three is enough to make an author filter and three distinct ``/u/{username}`` profiles
meaningful, and few enough that the corpus still gives each of them a substantial body of work.
Their usernames - ``maya-rodriguez``, ``devon-park``, ``priya-nair`` - are derived from the
display names, so they are URL-safe by construction.

The last entry carries no ``avatar_url`` on purpose. Two of the three exercise the remote-image
path, one exercises the initials fallback, and so does the administrator; a corpus where every
avatar loads never shows whether the fallback works.

These accounts are **not sign-in fixtures**. :func:`seed_authors` gives each one a fresh
high-entropy password, hashes it with argon2id and discards the plaintext, because their purpose
is to own content and back a public profile. Sharing the administrator's password across them
would hand four accounts to anyone holding one credential, and inventing a settings key for them
would desynchronise ``.env.example`` from every file that documents it. A test needing an
author-role principal builds one through ``backend/tests/factories.py``.

The addresses are public, so a row found at one is not trusted
-------------------------------------------------------------
These three addresses are constants in a repository anyone can read, and they are valid inputs
to ``POST /api/v1/auth/register``. Someone can therefore hold an ordinary ``READER`` account at
one of them before a deployment is ever seeded. Because :func:`seed_posts` attributes every
draft to the row :func:`seed_authors` returns, and a post's author may edit, delete, publish and
unpublish it, adopting whatever row carries the address would turn a predictable email into a
way to acquire authored content. :func:`_reject_unless_seeded_author` is what closes that: a row
is adopted only when it is active, holds ``AUTHOR`` and carries the ``display_name`` below, and
the seed stops rather than elevating, reassigning or skipping. ``example.com`` is reserved by
RFC 2606 and receives no mail, so these are demonstration identities and not addresses anyone
can prove they own.
"""


ADMINISTRATOR_SLOT: Final[int] = -1
"""The :attr:`PostDraft.author_slot` value meaning "the administrator wrote this".

Any other value indexes :data:`AUTHOR_ROSTER`. A sentinel rather than a fourth roster entry,
because the administrator's identity comes from ``settings`` and cannot be stated here.
"""


# =======================================================================================
# The demonstration corpus
# =======================================================================================


SUBJECTS: Final[tuple[Subject, ...]] = (
    Subject(
        noun="connection pooling",
        category_slugs=("backend", "databases"),
        thesis=(
            "A pool is a queue with a bill attached: every idle connection costs the server a "
            "backend process, and every missing one costs a request its latency."
        ),
        detail=(
            "Size the pool against the deployment rather than against the process. Each worker "
            "builds its own pool, so the ceiling the database actually sees is workers "
            "multiplied by pool size plus overflow, and it is that product - not the number in "
            "the config file - that has to stay inside `max_connections`. Pre-ping buys "
            "immunity to a connection the server closed while nobody was looking, for the price "
            "of one cheap round trip on checkout. Recycling handles the ages the process can "
            "predict; pre-ping handles the closures it cannot."
        ),
        pitfall=(
            "The failure mode is not a slow query, it is a queue. When every pooled connection "
            "is held by a request waiting on something else, new requests block before they "
            "reach the database at all, and the symptom surfaces as a timeout inside a handler "
            "that never issued a statement. Checkout wait time is the metric that sees this "
            "coming; query time is the metric that sees it far too late."
        ),
        takeaways=(
            "Size the pool for the whole deployment, not for one process.",
            "Recycling and pre-ping solve different failures, so keep both.",
            "Alert on checkout wait time before you alert on query time.",
        ),
    ),
    Subject(
        noun="database migrations",
        category_slugs=("databases", "engineering"),
        thesis=(
            "A migration is only finished when its downgrade has been run, because a change you "
            "cannot reverse is a change you cannot deploy on a Friday."
        ),
        detail=(
            "Treat the revision graph as source: one head, linear history, and a working "
            "`downgrade` beside every `upgrade`. The cycle worth automating is "
            "upgrade-downgrade-upgrade against a throwaway database, which catches the "
            "asymmetries a forward-only test never sees - an enum dropped in the wrong order, "
            "an index the downgrade forgot, a column recreated without its default. A drift "
            "check on top of that closes the remaining gap between the models and the schema."
        ),
        pitfall=(
            "Data migrations are where reversibility quietly dies. Inserting reference rows is "
            "easy to undo; back-filling a derived column from a computation is not, because the "
            "downgrade has no way to know which rows were already correct. Keep the two kinds "
            "in separate revisions so the schema change stays reversible even when the "
            "back-fill is a one-way door."
        ),
        takeaways=(
            "Ship a working downgrade with every revision, no exceptions.",
            "Run upgrade, downgrade and upgrade again in the pipeline.",
            "Separate schema revisions from data revisions.",
        ),
    ),
    Subject(
        noun="full-text search",
        category_slugs=("databases", "backend"),
        thesis=(
            "PostgreSQL's own text search is good enough that most applications never need a "
            "separate search cluster, and the ones that do usually find out for other reasons."
        ),
        detail=(
            "A generated `tsvector` column re-derives itself on every write, so there is no "
            "trigger to maintain and no application-side refresh step to forget. Weighting the "
            "sources with `setweight` - title heaviest, then excerpt, then body - is what turns "
            "a match into a ranking, and `websearch_to_tsquery` accepts what a reader actually "
            "types, including quoted phrases and a leading minus, without raising on syntax the "
            "way `to_tsquery` does."
        ),
        pitfall=(
            "The index will look unused, and for a while it should be. On a small table a "
            "sequential scan really is cheaper, so the planner picks it and an `EXPLAIN` taken "
            "too early reads like a misconfiguration. Confirm index selection against a "
            "realistic corpus with statistics collected, and never force the planner's hand to "
            "make a demonstration look better than the data supports."
        ),
        takeaways=(
            "Generate the search vector in the schema, not in the application.",
            "Weight the sources so a title match outranks a body match.",
            "Check the plan at volume, with statistics collected.",
        ),
    ),
    Subject(
        noun="token rotation",
        category_slugs=("security", "backend"),
        thesis=(
            "A refresh token that survives its own use is a long-lived credential wearing a "
            "short-lived costume."
        ),
        detail=(
            "Rotate on every redemption: issue a new refresh token, revoke the one presented, "
            "and store only a hash of each so a database read never yields a usable credential. "
            "Keep the access token short enough that revoking the refresh token actually ends "
            "the session in practice, and record the revocation instant rather than deleting "
            "the row - reuse of an already-redeemed token is a signal, and a deleted row cannot "
            "raise it."
        ),
        pitfall=(
            "Rotation and retries interact badly if nobody plans for it. A client whose network "
            "dropped mid-refresh will retry with a token the server has already revoked, and "
            "treating every such reuse as an attack logs users out for the crime of having poor "
            "connectivity. Decide deliberately what a reuse means, and make the client's retry "
            "path idempotent enough that the question comes up rarely."
        ),
        takeaways=(
            "Rotate the refresh token on every single use.",
            "Persist hashes, never the tokens themselves.",
            "Revoke by stamping a time, so reuse remains detectable.",
        ),
    ),
    Subject(
        noun="password hashing",
        category_slugs=("security",),
        thesis=(
            "The hash is not there to protect the password from you, it is there to protect it "
            "from whoever ends up with a copy of the table."
        ),
        detail=(
            "Use a memory-hard function - argon2id is the current default answer - and let the "
            "library own the parameters and the encoding. A modern hash string carries its own "
            "algorithm, version, cost parameters and salt, which is what makes rehashing on "
            "verification possible: the cost can be raised years later and each user's stored "
            "hash upgrades the next time they log in, with no reset email and no migration."
        ),
        pitfall=(
            "Comparison timing leaks more than people expect. If a missing account returns "
            "faster than a wrong password, the login endpoint becomes an account enumeration "
            "oracle, and no amount of rate limiting hides a difference that large. Verify "
            "against a dummy hash when the account does not exist, so both paths do the same "
            "amount of work and return the same message."
        ),
        takeaways=(
            "Pick a memory-hard algorithm and let the library encode it.",
            "Rehash on verification so cost parameters can rise later.",
            "Make the missing-account path cost the same as the wrong-password path.",
        ),
    ),
    Subject(
        noun="request tracing",
        category_slugs=("devops", "engineering"),
        thesis=(
            "Correlation is the whole feature: a hundred perfectly formatted log lines nobody "
            "can join back to one request are a hundred lines of noise."
        ),
        detail=(
            "Mint an identifier at the edge, bind it into the logging context for the life of "
            "the request, and return it on the response so a reader's bug report carries the "
            "key to its own investigation. Accepting an inbound identifier when one is present "
            "is what extends the trace across a tier boundary, and it costs a header."
        ),
        pitfall=(
            "Context bound to a variable that does not follow the task is context that goes "
            "missing exactly when concurrency makes it valuable. Bind it where the async "
            "runtime propagates it, and clear it when the request ends, or the next request on "
            "that worker inherits an identifier that belongs to somebody else."
        ),
        takeaways=(
            "Assign the identifier once, at the edge.",
            "Return it on the response so a report carries its own key.",
            "Bind it somewhere the async runtime actually propagates.",
        ),
    ),
    Subject(
        noun="structured logging",
        category_slugs=("devops", "engineering"),
        thesis=(
            "A log line is a record, not a sentence, and the difference shows up the first time "
            "somebody needs to filter three million of them."
        ),
        detail=(
            "Emit one object per event with stable field names, and let the renderer differ by "
            "environment rather than the fields: human-readable in development, one JSON object "
            "per line everywhere else. Bridge the dependency loggers into the same chain so a "
            "line from the server, the migration runner and a service all carry the same keys "
            "and can be queried the same way."
        ),
        pitfall=(
            "Interpolating values into the message is how a queryable field becomes an "
            "unqueryable string. Pass them as keyword fields instead - and be deliberate about "
            "which values are allowed to appear at all, because statement echo with bound "
            "parameters puts email addresses and hashes into the log stream."
        ),
        takeaways=(
            "One object per event, with stable field names.",
            "Vary the renderer by environment, never the fields.",
            "Never interpolate a value the query layer should be able to filter on.",
        ),
    ),
    Subject(
        noun="pagination contracts",
        category_slugs=("backend", "architecture"),
        thesis=(
            "Three list endpoints that window results three different ways force the client to "
            "write three pagination components."
        ),
        detail=(
            "Settle one envelope - items, total, page, page size and page count - and return it "
            "from every collection, so the feed, the profile listing and the administrative "
            "tables share a single control. Cap the page size in the contract rather than "
            "hoping nobody asks for a million rows, and compute the page count centrally so the "
            "arithmetic exists once."
        ),
        pitfall=(
            "An out-of-range page is not an error. Asking for page nine of a four-page result is "
            "an ordinary consequence of a row being deleted between two clicks, and answering "
            "it with a failure turns a stale link into a broken screen. Return an empty item "
            "list with an honest total instead."
        ),
        takeaways=(
            "One envelope for every collection, without exception.",
            "Cap page size in the contract, not in a comment.",
            "An out-of-range page is empty, not an error.",
        ),
    ),
    Subject(
        noun="API versioning",
        category_slugs=("architecture", "backend"),
        thesis=(
            "Versioning is cheap on the day you launch and expensive on every day after, which "
            "is the entire argument for doing it on day one."
        ),
        detail=(
            "A prefix in the path is the least clever option available and that is its "
            "strength: it is visible in a log line, in a browser address bar and in a support "
            "ticket, and it needs no content negotiation to explain. Mount every route under it "
            "from the first commit, and keep the operational probes outside it, because "
            "liveness is not part of the domain contract."
        ),
        pitfall=(
            "Versioning the path does not by itself make a change safe. Adding a required field "
            "to a request or removing one from a response breaks a client whether or not the "
            "prefix changed, so the discipline that matters is knowing which changes are "
            "additive - and declaring a response model on every route, so the shape is enforced "
            "rather than described."
        ),
        takeaways=(
            "Put the version in the path and do it before the first release.",
            "Keep health and readiness probes outside the versioned namespace.",
            "Declare a response model on every route so the shape is enforced.",
        ),
    ),
    Subject(
        noun="schema constraints",
        category_slugs=("databases", "architecture"),
        thesis=(
            "Every invariant the database can hold is an invariant application code no longer "
            "has to defend on every path."
        ),
        detail=(
            "A check constraint saying a published row must carry a publication instant is "
            "worth more than the same rule in a service method, because it also applies to the "
            "migration, the seed script and the operator with a psql session. Case-insensitive "
            "unique identity, composite keys that make an operation idempotent by construction, "
            "and foreign keys with an explicit delete rule all belong in the same category: "
            "correctness that survives the next refactor."
        ),
        pitfall=(
            "Constraints are only as good as the error handling above them. A unique violation "
            "surfacing as a five-hundred is a worse user experience than no constraint at all, "
            "so pair each one with the conflict response it should produce, and check for the "
            "conflict first so the constraint is a backstop rather than the primary path."
        ),
        takeaways=(
            "Push an invariant into the schema whenever the schema can express it.",
            "Let a composite key make idempotency structural.",
            "Map each constraint to the response its violation should produce.",
        ),
    ),
    Subject(
        noun="server components",
        category_slugs=("frontend", "architecture"),
        thesis=(
            "Fetch where you render. A crawler that has to execute your JavaScript to find an "
            "article has already decided what your article is worth."
        ),
        detail=(
            "Render content on the server so the article is in the first response, and isolate "
            "the interactive pieces - a search box, a like button, a theme toggle - into client "
            "components so a page does not become a client bundle merely because it has one "
            "button. That split is what lets discoverability and interactivity be true at the "
            "same time rather than traded against each other."
        ),
        pitfall=(
            "The boundary leaks through props. Passing a function, a class instance or a "
            "database handle across it fails at exactly the moment the tree is serialised, and "
            "the error message rarely points at the prop that caused it. Keep the values "
            "crossing the seam plain, and keep the seam itself shallow enough to see."
        ),
        takeaways=(
            "Render content on the server so the first response contains it.",
            "Push interactivity down into small client islands.",
            "Only plain, serialisable values cross the boundary.",
        ),
    ),
    Subject(
        noun="design tokens",
        category_slugs=("frontend", "product"),
        thesis=(
            "A token layer earns its keep the first time a palette changes and nothing but one "
            "file has to change with it."
        ),
        detail=(
            "Name tokens for their role rather than their value - surface, foreground, border, "
            "danger - and let exactly one file map those roles onto concrete scale values. "
            "Component code then references meaning, which is what makes a theme swap a "
            "single-file edit and what makes a review able to spot an inconsistency by reading "
            "class names."
        ),
        pitfall=(
            "One hardcoded value is not a problem; the fortieth is a redesign. The rule has to "
            "be absolute to be enforceable, which means no literal colour, size, radius or "
            "shadow at a call site at all - and when a need genuinely has no token, the answer "
            "is to add the token, not to make an exception."
        ),
        takeaways=(
            "Name tokens for role, never for value.",
            "Map roles onto values in exactly one file.",
            "When a value has no token, add the token.",
        ),
    ),
    Subject(
        noun="dark mode",
        category_slugs=("frontend", "product"),
        thesis=(
            "Dark mode is a token-layer concern. If it reaches your components, you have "
            "implemented it twice and will maintain it forever."
        ),
        detail=(
            "Declare every semantic token twice - once at the document root, once under a dark "
            "selector - and a component written against the role themes itself with no "
            "conditional logic. Select the theme with a class on the document element, default "
            "to the system preference, and persist the choice so the second visit does not "
            "argue with the first."
        ),
        pitfall=(
            "The flash is a rendering-order bug, not a styling one. The server cannot know what "
            "the visitor chose last time, so the honest fix is to suppress the hydration warning "
            "on the root element and let the stored preference apply before paint - not to "
            "guess on the server and correct it afterwards, which is the flash."
        ),
        takeaways=(
            "Theme through tokens, never through component branches.",
            "Default to the system preference, then persist the override.",
            "Apply the stored choice before first paint.",
        ),
    ),
    Subject(
        noun="responsive layout",
        category_slugs=("frontend", "product"),
        thesis=(
            "Mobile-first is not a courtesy to small screens, it is the only order in which the "
            "layout rules stay additive."
        ),
        detail=(
            "Write the narrow layout as the base and let each breakpoint add rather than "
            "override, and take the breakpoints from the system's own scale so the vocabulary "
            "stays finite. A table becomes stacked cards, navigation collapses into a drawer, an "
            "editor moves from stacked to side by side - three decisions, all expressible in the "
            "same five steps."
        ),
        pitfall=(
            "Horizontal overflow is the bug that testing at one width never finds. It usually "
            "comes from a fixed minimum width, an unbreakable string or a table that was never "
            "given a narrow presentation, and it is worth asserting against at the smallest "
            "supported viewport rather than discovering on a phone."
        ),
        takeaways=(
            "Base styles are the narrow case; breakpoints only add.",
            "Use the system's breakpoint scale and no custom queries.",
            "Assert no horizontal overflow at the smallest viewport.",
        ),
    ),
    Subject(
        noun="accessibility audits",
        category_slugs=("frontend", "product"),
        thesis=(
            "Accessibility is cheapest when it is a floor under the component library rather "
            "than a pass over the finished screens."
        ),
        detail=(
            "Build interactive widgets on primitives that already supply focus trapping, roving "
            "focus, escape handling and the correct roles, and let the project layer add only "
            "visuals. Then assert on accessible names in component tests, so a regression "
            "arrives as a red test rather than as a review comment three weeks later."
        ),
        pitfall=(
            "An automated checker cannot see the failures that matter most. It will not tell "
            "you that the focus order jumps, that a label describes the wrong control, or that "
            "an icon-only button announces nothing useful. Keyboard-only traversal of the real "
            "flow finds all three in about a minute."
        ),
        takeaways=(
            "Inherit behaviour from primitives; add only visuals.",
            "Assert on accessible names, not on markup structure.",
            "Traverse the real flow with the keyboard before shipping.",
        ),
    ),
    Subject(
        noun="cache invalidation",
        category_slugs=("architecture", "engineering"),
        thesis=(
            "A cache you cannot invalidate confidently is a correctness bug you have agreed to "
            "ship on a schedule."
        ),
        detail=(
            "Decide what may be stale and for how long before deciding where to store anything, "
            "because that decision is the design. Prefer invalidating on the write that caused "
            "the change over expiring on a timer, and keep the set of keys a write touches small "
            "enough to enumerate in a sentence."
        ),
        pitfall=(
            "The tempting cache is the one added before there is a performance problem, and it "
            "arrives with invalidation complexity that has to be paid immediately for a benefit "
            "that is speculative. Measure first; a query with the right index is often faster "
            "than the round trip to the cache you were about to add."
        ),
        takeaways=(
            "Define the staleness budget before choosing a store.",
            "Invalidate on write in preference to expiring on a timer.",
            "Do not add a cache before there is a measurement.",
        ),
    ),
    Subject(
        noun="rate limiting",
        category_slugs=("security", "backend"),
        thesis=(
            "Rate limiting is not about traffic, it is about making a guess expensive - which is "
            "why it belongs on the authentication routes first."
        ),
        detail=(
            "Apply the limit where a repeated attempt has value to an attacker: login, "
            "registration and refresh. Keep the expression configurable so an environment can "
            "tighten it without a deployment, and answer a rejection with the status and the "
            "retry hint a well-behaved client can actually act on."
        ),
        pitfall=(
            "In-process counters are per-process, so four workers quietly grant four times the "
            "configured allowance. That is an acceptable trade at small scale and a real hole at "
            "large scale, and the only wrong move is not knowing which situation you are in. "
            "Write down the assumption next to the limit."
        ),
        takeaways=(
            "Limit the routes where guessing pays, before the rest.",
            "Make the limit configuration, not a literal.",
            "Know whether your counter is per-process, and say so.",
        ),
    ),
    Subject(
        noun="content sanitisation",
        category_slugs=("security", "backend"),
        thesis=(
            "Accepting authored rich text creates a stored-injection surface, and the write path "
            "is the cheapest place to close it."
        ),
        detail=(
            "Sanitise on write with an allow-list of elements and attributes, and sanitise again "
            "on render, because the two defend against different mistakes: the first stops the "
            "payload reaching the table, the second stops a payload that arrived by some other "
            "route from reaching a reader. Reader-authored comments deserve the stricter "
            "allow-list of the two."
        ),
        pitfall=(
            "A deny-list ages badly. Every new attribute, protocol and embedding trick is a hole "
            "until somebody adds it to the list, which means the list is always behind. Allow "
            "what the product needs and reject everything else, and accept that a rejected "
            "element is a support question rather than an incident."
        ),
        takeaways=(
            "Allow-list on write; never deny-list.",
            "Sanitise on render as well, for a different reason.",
            "Comments get the stricter policy.",
        ),
    ),
    Subject(
        noun="index selection",
        category_slugs=("databases", "engineering"),
        thesis=(
            "The planner is not ignoring your index; it is telling you the table is too small "
            "for the index to be worth reading."
        ),
        detail=(
            "Read a plan before adding anything. A sequential scan on a handful of pages is the "
            "cheapest correct answer, and the crossover to an index scan depends on heap pages "
            "and selectivity rather than on row count alone. Collect statistics, then compare - "
            "and match the index to the query's ordering as well as its filter, because a "
            "composite index in the wrong direction is a sort the plan still has to perform."
        ),
        pitfall=(
            "Disabling sequential scans to force an index proves nothing except that the index "
            "exists. It hides the cost estimate that was the useful information and it does not "
            "reflect what production will choose. If the plan is wrong, the statistics or the "
            "index definition is wrong."
        ),
        takeaways=(
            "Read the plan before and after, with statistics collected.",
            "Match the index to the ordering, not only to the filter.",
            "Never force the planner to win an argument.",
        ),
    ),
    Subject(
        noun="background jobs",
        category_slugs=("backend", "devops"),
        thesis=(
            "Anything a request does not need to finish before it answers should not be holding "
            "the connection while it happens."
        ),
        detail=(
            "Move slow, retryable work off the request path and make each unit idempotent, "
            "because at-least-once delivery is what every queue actually offers however it is "
            "described. Give a job an identity so a duplicate is detectable, and bound its "
            "retries so a permanent failure stops rather than recirculating forever."
        ),
        pitfall=(
            "Fire-and-forget work started inside a request usually dies with the worker that "
            "started it, and it dies silently. If a job matters, it needs somewhere durable to "
            "live before it starts; if it does not matter, it probably should not exist."
        ),
        takeaways=(
            "Only defer work the response does not depend on.",
            "Make every job idempotent and give it an identity.",
            "Bound the retries and record the permanent failures.",
        ),
    ),
    Subject(
        noun="container images",
        category_slugs=("devops",),
        thesis=(
            "The build stage and the run stage want opposite things, which is the whole reason "
            "multi-stage builds exist."
        ),
        detail=(
            "Compile and install in a stage that carries the toolchain, copy only the artefacts "
            "into a slim runtime stage, and run as a non-root user. Order the layers so the "
            "dependency install sits above the source copy, because that ordering is what makes "
            "an ordinary code change a fast rebuild instead of a full one."
        ),
        pitfall=(
            "Secrets leak through layers, not through the final filesystem. A credential passed "
            "as a build argument or removed in a later instruction is still in the history of "
            "the image, and anyone who can pull it can read it. Mount secrets for the build "
            "instead of baking them."
        ),
        takeaways=(
            "Separate the build stage from the runtime stage.",
            "Install dependencies before copying source, for cache reuse.",
            "Never let a credential reach a layer.",
        ),
    ),
    Subject(
        noun="continuous integration",
        category_slugs=("devops", "engineering"),
        thesis=(
            "A gate that warns is not a gate. Either the pipeline can fail on it or it is "
            "documentation with a spinner."
        ),
        detail=(
            "Run the same commands the developer runs, in the same versions, and let every one "
            "of them fail the job: lint, format check, type check, migrations applied against a "
            "real database service, then the test suites with a coverage floor. Pin the "
            "runtimes, because a pipeline that resolves a different version than the developer "
            "did is a pipeline that reports on something else."
        ),
        pitfall=(
            "The slowest gate gets skipped first, and the skip becomes permanent. Keep the loop "
            "short enough that nobody wants to bypass it - cache dependencies, run the tiers in "
            "parallel - and treat a flaky test as a broken gate rather than as an inconvenience "
            "to be retried."
        ),
        takeaways=(
            "Every gate blocks, or it is not a gate.",
            "Pin the runtimes so the pipeline and the developer agree.",
            "Fix flakes; do not retry them.",
        ),
    ),
    Subject(
        noun="type checking",
        category_slugs=("engineering",),
        thesis=(
            "Strict typing is not about catching typos, it is about making a layering violation "
            "impossible to commit quietly."
        ),
        detail=(
            "Turn strictness on at the start, when the cost is one afternoon rather than one "
            "quarter, and keep the checker's configuration in one file so there is a single "
            "answer to what the rules are. Untyped function bodies and implicit returns of any "
            "type are precisely where a router reaching for a session, or a repository importing "
            "a service, slips past review."
        ),
        pitfall=(
            "A bare suppression comment is a permanent hole with no name on it. Require the "
            "error code in every suppression, so the next reader can tell whether the reason "
            "still applies - and prefer fixing the annotation to silencing the message."
        ),
        takeaways=(
            "Enable strict mode on the first day, not the last.",
            "Keep tool configuration in one file.",
            "Every suppression names its error code.",
        ),
    ),
    Subject(
        noun="code review",
        category_slugs=("engineering", "product"),
        thesis=(
            "Review is where a codebase decides what it is going to look like in a year, which "
            "makes it the highest-leverage hour on the calendar."
        ),
        detail=(
            "Automate everything mechanical - formatting, import order, naming, unused imports - "
            "so the conversation is about boundaries, naming and whether the change belongs in "
            "the layer it landed in. Small changes get read properly; large ones get approved. "
            "That is not a comment on anybody's diligence, it is a fact about attention."
        ),
        pitfall=(
            "A review that only finds defects is a review that misses the expensive problems. "
            "The question worth asking is not whether the code works but whether the next "
            "person will put the next change in the right place, and that question is answered "
            "by structure rather than by behaviour."
        ),
        takeaways=(
            "Automate the mechanical so review can be about structure.",
            "Keep changes small enough to be read properly.",
            "Ask where the next change will go, not only whether this one works.",
        ),
    ),
)
"""Twenty-four subject areas, each contributing the substance of four articles.

**The count is measured, not chosen.** Discovery observed the planner take a sequential scan for
the feed's ranked search rather than the GIN index, and the number of rows at which that flips
was established here by stepping a realistic corpus - diverse vocabulary, committed rows,
statistics collected - through the actual feed query on PostgreSQL 18.4:

===========  ==============================
Rows         Plan chosen for the feed search
===========  ==============================
10 - 60      sequential scan (correct at that size)
70 - 80      bitmap index scan on the full-text index
100+         bitmap index scan on the full-text index
===========  ==============================

The crossover tracks heap pages rather than content length, so the corpus is sized above it with
margin: twenty-four subjects times four angles is ninety-six posts, of which eighty-eight are
published - comfortably past the crossover, and five pages at the default page size of twenty, so
"page two is disjoint from page one" has three further pages behind it.

Each subject names one to two of :data:`REFERENCE_CATEGORIES`' slugs. :func:`seed_posts` raises
if a slug here is not in that tuple, so the two cannot drift apart unnoticed.
"""


ANGLES: Final[tuple[Angle, ...]] = (
    Angle(
        title_template="A field guide to {noun}",
        excerpt_template=(
            "What {noun} actually asks of a team, what it gives back, and the handful of "
            "decisions worth making deliberately rather than by default."
        ),
        lede_template=(
            "{Noun} is one of those topics that reads as settled until it is the thing standing "
            "between a request and a response. {thesis} What follows is the short version of "
            "what that means once real traffic is involved."
        ),
        practice_heading="Where to start",
        practice_template=(
            "Start by writing down what {noun} is supposed to guarantee, in one sentence, "
            "before touching any configuration. Almost every argument about it turns out to be "
            "two people optimising for different guarantees, and the sentence is cheaper than "
            "the argument."
        ),
        detail_heading="How it works in practice",
        pitfall_heading="Where it goes wrong",
    ),
    Angle(
        title_template="{Noun} in production: what the metrics actually showed",
        excerpt_template=(
            "A pass over {noun} with the dashboards open - which assumptions survived contact "
            "with production traffic, and which ones quietly did not."
        ),
        lede_template=(
            "Everything written about {noun} sounds reasonable until the graphs disagree with "
            "it. {thesis} These are the parts that changed once there was something to measure "
            "rather than something to reason about."
        ),
        practice_heading="What we measured",
        practice_template=(
            "The useful instrumentation for {noun} is almost never the metric that first comes "
            "to mind: the obvious one moves late and the leading one moves early. Find the "
            "leading indicator, alert on that, and keep the obvious one for the post-mortem."
        ),
        detail_heading="What held up",
        pitfall_heading="What did not",
    ),
    Angle(
        title_template="Debugging {noun} under load",
        excerpt_template=(
            "A walk through diagnosing {noun} when the symptom only appears under "
            "concurrency - and why the first thing you suspect usually is not it."
        ),
        lede_template=(
            "{Noun} tends to behave impeccably in development and then produce a symptom nobody "
            "can reproduce. {thesis} The path below is the one that has worked more often than "
            "guessing has."
        ),
        practice_heading="Reproducing it on purpose",
        practice_template=(
            "A bug in {noun} that only shows up under load is a bug about queueing or about "
            "ordering, and both are reproducible once you stop trying to reproduce them with a "
            "single request. Two concurrent clients and a deliberate delay find more than an "
            "afternoon of reading does."
        ),
        detail_heading="The mechanism underneath",
        pitfall_heading="The wrong turn to avoid",
    ),
    Angle(
        title_template="Choosing your {noun} strategy without regrets",
        excerpt_template=(
            "The decisions around {noun} that are cheap to make now and expensive to revisit "
            "later, and a defensible default for each of them."
        ),
        lede_template=(
            "Most regret about {noun} comes from a decision that was never actually made - it "
            "was inherited from a default. {thesis} So here are the choices worth making on "
            "purpose, with the reasoning attached."
        ),
        practice_heading="The decision that matters most",
        practice_template=(
            "If only one thing about {noun} gets decided deliberately, make it the one that is "
            "hardest to reverse. Reversible choices can be revisited with a deployment; the "
            "irreversible ones become the shape of the system whether they were considered or "
            "not."
        ),
        detail_heading="A defensible default",
        pitfall_heading="The regret to design out",
    ),
)
"""Four editorial framings, applied across every subject to produce the corpus.

Each template takes ``{noun}`` and ``{Noun}``, and the ledes additionally take ``{thesis}``. The
fourth title says "your" rather than "a" on purpose: ``a API versioning strategy`` is wrong and
carrying an article-agreement rule for one headline is not worth it.

Verified against ``app.core.slug``: the twenty-four subjects and these four angles yield
ninety-six distinct titles and ninety-six distinct slugs with **no collision suffix at all**, the
longest of them sixty-nine characters against a bound of eighty. :func:`_compose_corpus` still
routes every slug through ``unique_slug``, because a future subject whose title truncates into an
existing one must produce a deterministic ``-2`` rather than an ``IntegrityError``.
"""


# =======================================================================================
# Corpus composition
#
# Every rule below is arithmetic or set membership over a post's position in the corpus, and
# never a random draw. That is not stylistic: `random` would make two runs disagree about which
# posts are drafts, which would make the "run it twice, get the same rows" guarantee depend on a
# seed nobody set. Deterministic assignment also means a test can assert on an exact expected
# feed without reading this module's output first.
# =======================================================================================


_DRAFT_POSITIONS: Final[frozenset[int]] = frozenset({5, 18, 31, 47, 63, 79})
"""Corpus positions seeded as ``DRAFT``.

Six of them, and the specific values are chosen so the drafts land across the whole roster
rather than piling onto one author: ``5``, ``47`` and ``63`` fall to roster slots 2, 2 and 0,
``31`` and ``79`` to slot 1, and ``18`` is one of :data:`_ADMINISTRATOR_POSITIONS`. Every author
therefore has at least one draft *and* a body of published work, which is what makes two things
demonstrable at once - the author workspace grouping posts by status, and the requirement that a
draft appear in neither the public feed, nor a category filter result, nor a public profile.
"""


_ARCHIVED_POSITIONS: Final[frozenset[int]] = frozenset({11, 69})
"""Corpus positions seeded as ``ARCHIVED``, falling to roster slots 2 and 0.

Two is enough for the administrative post table and the author workspace to have the third
lifecycle state present. They keep a non-null ``published_at``, unlike drafts: the check
constraint only requires the instant for ``PUBLISHED``, but an archived post *was* published
once, and discarding the date would misrepresent that. Disjoint from
:data:`_DRAFT_POSITIONS` by construction - :func:`_status_for` resolves archived first.
"""


_ADMINISTRATOR_POSITIONS: Final[frozenset[int]] = frozenset({2, 18, 25, 40, 57, 88})
"""Corpus positions authored by the administrator rather than by a roster author.

Five published posts and one draft - position ``18`` is in :data:`_DRAFT_POSITIONS` too. The
draft is the point: an operator who logs in with ``SEED_ADMIN_EMAIL`` lands on a workspace that
already has content in more than one lifecycle state, so the status grouping and the
publish/unpublish transitions are exercisable immediately rather than after writing a post
first. An administrator authoring content is ordinary for a blog, and the ``ADMIN`` role is a
superset of ``AUTHOR``'s authority, so nothing about the ownership rules is bypassed.
"""


_PUBLICATION_FLOOR_HOURS: Final[int] = 2
"""How far in the past the newest published post sits.

Non-zero so that no seeded row claims to have been published at the exact instant the seed ran,
which would read as a clock artefact in a feed sorted by recency.
"""


_PUBLICATION_STRIDE_HOURS: Final[int] = 9
"""Hours between one position's publication instant and the next.

Nine hours over ninety-six positions spreads the corpus across roughly thirty-six days, which
gives ``posts (status, published_at DESC)`` a strict, gap-free ordering to work with. Strictness
is the property that matters: with distinct instants, page two of the feed is genuinely disjoint
from page one, whereas ties would let a row appear on both pages or neither.
"""


_VIEW_COUNT_FLOOR: Final[int] = 37
"""Lowest view count any seeded post carries, so none of them reads as brand new."""


_VIEW_COUNT_STRIDE: Final[int] = 137
"""Step used to spread view counts across :data:`_VIEW_COUNT_SPREAD`.

Prime, and therefore coprime with the spread, so ``position * stride % spread`` visits a
different value for every one of the ninety-six positions instead of cycling early. View counts
are decoration rather than an ordering input - the feed offers ``recent`` and ``relevance`` and
deliberately offers no ``popular`` sort - but a table of zeroes makes the administrative screens
look broken.
"""


_VIEW_COUNT_SPREAD: Final[int] = 900
"""Width of the view-count range above :data:`_VIEW_COUNT_FLOOR`."""


_COVER_IMAGE_BASE: Final[str] = "https://picsum.photos/seed"
"""Origin of the seeded cover images.

``picsum.photos`` is one of the four hosts ``frontend/next.config.ts`` allow-lists for remote
images, and it is deterministic: the same seed segment always yields the same picture, so the
feed looks identical on every machine. Cover images are URL references by design - there is no
upload pipeline in this product - so seeding a URL is the whole of the work. Nothing is fetched
at seed time; an environment with no outbound network stores the same rows and simply renders
the frame without a picture.
"""


_COVER_IMAGE_WIDTH: Final[int] = 1200
"""Cover width, matching the OpenGraph card dimension the SEO metadata advertises."""


_COVER_IMAGE_HEIGHT: Final[int] = 630
"""Cover height, matching the OpenGraph card dimension the SEO metadata advertises."""


_COVERLESS_STRIDE: Final[int] = 7
"""Every seventh published position is seeded with no cover image.

Deliberate coverage of the other branch: the post card has a text-only presentation and the
route falls back to the generated default social card when a post has no cover, and neither is
reachable in a corpus where every row has one. The offset in :func:`_cover_image_url_for` keeps
position zero - the top of the feed - covered.
"""


_DEMONSTRATION_PASSWORD_BYTES: Final[int] = 32
"""Entropy, in bytes, of the throwaway password generated for each roster author.

Thirty-two bytes from ``secrets`` is far beyond guessable, which is the intent: the value is
hashed with argon2id and then discarded, so these accounts own content and back a public profile
without any credential existing that could sign in as them. Deriving them from the
administrator's password instead would extend one compromise across four accounts.
"""


_ADMINISTRATOR_DISPLAY_NAME: Final[str] = "Site Administrator"
"""Display name for the seeded administrator; also the source of its preferred username."""


_ADMINISTRATOR_USERNAME: Final[str] = "admin"
"""Preferred handle for the administrator, before collision resolution.

Short, memorable and already URL-safe. It is still routed through
``app.core.slug.slugify_title`` and ``unique_slug`` in :func:`seed_administrator`, because a
pre-existing account may hold it - ``users.username`` is unique and ``citext``, so an unresolved
collision would be an ``IntegrityError`` rather than a merge.
"""


_ADMINISTRATOR_BIO: Final[str] = (
    "Keeps the lights on: users, posts, comments and categories. Occasionally writes something."
)
"""Profile text for the seeded administrator, so its public profile is not blank."""


def _status_for(position: int) -> PostStatus:
    """Resolve the lifecycle state of the post at *position*.

    Archived is tested first so that the two position sets cannot produce an ambiguous answer
    even if a future edit accidentally overlaps them.

    Args:
        position: Zero-based index into the composed corpus.

    Returns:
        ``ARCHIVED``, ``DRAFT`` or - for the great majority - ``PUBLISHED``.
    """
    if position in _ARCHIVED_POSITIONS:
        return PostStatus.ARCHIVED
    if position in _DRAFT_POSITIONS:
        return PostStatus.DRAFT
    return PostStatus.PUBLISHED


def _author_slot_for(position: int) -> int:
    """Resolve who wrote the post at *position*.

    Args:
        position: Zero-based index into the composed corpus.

    Returns:
        :data:`ADMINISTRATOR_SLOT` for an administrator-authored post, otherwise an index into
        :data:`AUTHOR_ROSTER`. Round-robin over the roster, which distributes the corpus evenly
        without needing a distribution table.
    """
    if position in _ADMINISTRATOR_POSITIONS:
        return ADMINISTRATOR_SLOT
    return position % len(AUTHOR_ROSTER)


def _published_at_for(position: int, status: PostStatus, now: datetime) -> datetime | None:
    """Resolve the publication instant of the post at *position*.

    This is the function that satisfies the schema's publication check constraint, and it
    satisfies it rather than working around it: ``PUBLISHED`` and ``ARCHIVED`` always receive an
    instant, ``DRAFT`` always receives ``None``. The constraint - ``status <> 'PUBLISHED' OR
    published_at IS NOT NULL`` - is verified to reject the alternative, and it is never
    disabled, dropped or deferred to let a seed through.

    Args:
        position: Zero-based index into the composed corpus. Lower is more recent.
        status: The lifecycle state :func:`_status_for` assigned.
        now: The instant the run started, so the whole corpus shares one reference point
            instead of drifting while it is being built.

    Returns:
        A timezone-aware instant for a published or archived post, or ``None`` for a draft.
    """
    if status is PostStatus.DRAFT:
        return None
    offset = _PUBLICATION_FLOOR_HOURS + position * _PUBLICATION_STRIDE_HOURS
    return now - timedelta(hours=offset)


def _view_count_for(position: int) -> int:
    """Resolve a plausible, deterministic view count for the post at *position*."""
    return _VIEW_COUNT_FLOOR + (position * _VIEW_COUNT_STRIDE) % _VIEW_COUNT_SPREAD


def _cover_image_url_for(slug: str, status: PostStatus, position: int) -> str | None:
    """Resolve the cover image of the post at *position*, if it has one.

    Args:
        slug: The post's slug, used as the image seed so the picture is stable per post.
        status: Only published posts are given a cover; a draft has not been dressed for
            publication yet and an archived one has been undressed.
        position: Zero-based index into the composed corpus.

    Returns:
        An allow-listed absolute URL, or ``None`` for every draft, every archived post and every
        :data:`_COVERLESS_STRIDE`-th published one.
    """
    if status is not PostStatus.PUBLISHED:
        return None
    if position % _COVERLESS_STRIDE == _COVERLESS_STRIDE - 1:
        return None
    return f"{_COVER_IMAGE_BASE}/{slug}/{_COVER_IMAGE_WIDTH}/{_COVER_IMAGE_HEIGHT}"


def _render_markdown(subject: Subject, angle: Angle) -> str:
    """Compose the Markdown body of one article from its subject and its angle.

    The shape is deliberately plain - a lede, three second-level sections and a bullet list -
    because it has to render correctly through the client's Markdown pipeline, and that pipeline
    is configured for GitHub-flavoured Markdown that is then sanitised. Nothing here needs an
    element an allow-list would strip, so seeded content cannot be the reason a rendering bug
    goes unnoticed.

    Args:
        subject: Supplies the substance: the thesis, the mechanism, the failure mode, and the
            vocabulary that makes this article findable by search.
        angle: Supplies the framing: the lede, the section headings and the practice paragraph.

    Returns:
        A Markdown document of roughly two thousand characters - long enough that the reading
        time estimate, the prose typography and the relevance ranking all have something real to
        work with.
    """
    substitutions = {"noun": subject.noun, "Noun": subject.title_noun, "thesis": subject.thesis}
    takeaways = "\n".join(f"- {takeaway}" for takeaway in subject.takeaways)
    return (
        f"{angle.lede_template.format(**substitutions)}\n"
        f"\n"
        f"## {angle.practice_heading}\n"
        f"\n"
        f"{angle.practice_template.format(**substitutions)}\n"
        f"\n"
        f"## {angle.detail_heading}\n"
        f"\n"
        f"{subject.detail}\n"
        f"\n"
        f"## {angle.pitfall_heading}\n"
        f"\n"
        f"{subject.pitfall}\n"
        f"\n"
        f"## Key takeaways\n"
        f"\n"
        f"{takeaways}\n"
    )


def _compose_corpus(now: datetime) -> tuple[PostDraft, ...]:
    """Build the full demonstration corpus: every subject crossed with every angle.

    Subject-major and angle-minor, so a post's position is
    ``subject_index * len(ANGLES) + angle_index`` and the position-based rules above are stable
    against appending a subject - the existing positions do not shift.

    Slugs are derived with ``app.core.slug.slugify_title`` and then resolved through
    ``unique_slug`` against the slugs already assigned *within this corpus*. That distinction is
    load-bearing. Resolving against the database instead would break idempotency outright: a
    second run would find its own rows occupying the slugs and dutifully create
    ``…-2`` duplicates of all ninety-six posts. Resolving within the corpus is a pure function of
    this module's constants, so it returns the same ninety-six slugs on every run, on every
    machine, forever - which is what lets a slug be a stable canonical URL.

    Args:
        now: The instant the run started; every publication instant is derived from it.

    Returns:
        Ninety-six fully resolved drafts in feed order, newest first.
    """
    drafts: list[PostDraft] = []
    assigned: set[str] = set()

    for subject_index, subject in enumerate(SUBJECTS):
        for angle_index, angle in enumerate(ANGLES):
            position = subject_index * len(ANGLES) + angle_index
            substitutions = {"noun": subject.noun, "Noun": subject.title_noun}
            title = angle.title_template.format(**substitutions)
            slug = unique_slug(slugify_title(title), assigned)
            assigned.add(slug)
            status = _status_for(position)
            drafts.append(
                PostDraft(
                    slug=slug,
                    title=title,
                    excerpt=angle.excerpt_template.format(**substitutions),
                    content=_render_markdown(subject, angle),
                    status=status,
                    published_at=_published_at_for(position, status, now),
                    view_count=_view_count_for(position),
                    cover_image_url=_cover_image_url_for(slug, status, position),
                    author_slot=_author_slot_for(position),
                    category_slugs=subject.category_slugs,
                )
            )

    return tuple(drafts)


def _resolve_username(preferred: str, taken: set[str]) -> str:
    """Turn a preferred handle into one that is free, and reserve it.

    ``users.username`` is unique and ``citext``, so ``Admin`` and ``admin`` are the same handle
    to the database. ``unique_slug`` compares case-insensitively on both sides for exactly that
    reason, which means *taken* may hold values in whatever case the database returned them.

    Args:
        preferred: A human-readable name or handle. Slugified first, so a display name works as
            well as a handle does and the result is always URL-safe - it becomes ``/u/{username}``.
        taken: Handles already in use, mutated in place to include the returned value so a
            second call in the same run cannot hand back the same handle twice.

    Returns:
        A URL-safe handle absent from *taken*, suffixed deterministically (``-2``, ``-3``, …)
        only if it had to be.
    """
    username = unique_slug(slugify_title(preferred), taken)
    taken.add(username)
    return username


def _demonstration_password() -> str:
    """Generate a throwaway password for a demonstration author.

    Called once per created author and never returned to a caller that could store it: the value
    goes straight into ``app.core.security.hash_password`` and the plaintext is dropped when this
    frame does. ``secrets`` rather than ``random``, because the account is real even though
    nobody is meant to sign in as it.
    """
    return secrets.token_urlsafe(_DEMONSTRATION_PASSWORD_BYTES)


def _resolve_categories(
    draft: PostDraft, categories_by_slug: Mapping[str, Category]
) -> list[Category]:
    """Map a draft's category slugs onto the persistent rows they name.

    Raises rather than skipping, and that is the point: a subject citing a slug
    :data:`REFERENCE_CATEGORIES` does not contain is a data bug, and silently seeding the post
    without its associations would hide it behind a category filter that merely returns fewer
    results than expected.

    Args:
        draft: The post whose associations are being resolved.
        categories_by_slug: The reference taxonomy, keyed by derived slug, as
            :func:`seed_categories` returns it.

    Returns:
        The categories to associate, in the order the subject listed them.

    Raises:
        ValueError: If a slug is not part of the reference taxonomy.
    """
    resolved: list[Category] = []
    for slug in draft.category_slugs:
        category = categories_by_slug.get(slug)
        if category is None:
            msg = (
                f"post {draft.slug!r} names category slug {slug!r}, which is not in "
                f"REFERENCE_CATEGORIES; reconcile SUBJECTS with REFERENCE_CATEGORIES"
            )
            raise ValueError(msg)
        resolved.append(category)
    return resolved


_HANDLE_SUFFIX_HEADROOM: Final[int] = 8
"""Characters of the slug bound reserved for a collision suffix, in :func:`_taken_usernames`.

``unique_slug`` spends a suffix *from* the length budget rather than adding it on top, so a stem
close to the bound gets shortened on a hyphen boundary to make room - and a shortened stem is no
longer a prefix of what the caller asked for, which is precisely what the prefix lookup in
:func:`_taken_usernames` relies on.

Eight is a hyphen plus seven digits, so truncation stays unreachable until a base has collided
millions of times. Deriving the exact threshold instead is not possible here: it depends on how wide
the suffix has to grow, which depends on how many handles in the family are already taken, which is
what the query is being built to find out. Reserving generously and failing loudly is the honest
resolution of that circularity. The four bases this module actually uses are five to fourteen
characters, so the guard has never been close to firing; it exists so that a future roster entry
with a pathological display name fails at the guard rather than silently narrowing the query past
correctness and colliding on the unique index at flush.
"""


def _handle_family_pattern(base: str) -> str:
    """Build the anchored ``LIKE`` pattern matching one handle family.

    ``slugify_title`` emits only lowercase alphanumerics and hyphens, so its output can carry no
    ``LIKE`` metacharacter and this escaping is a no-op today. It is written anyway rather than
    asserted, because the alternative is a silent dependency on another module's output alphabet:
    were a ``_`` ever to become a legal slug character, an unescaped pattern would match any single
    character in that position and over-report the taken set, which pushes a needlessly high suffix
    onto a handle that then lives in a URL permanently.

    Args:
        base: An already-slugified handle stem.

    Returns:
        The stem with metacharacters neutralised, followed by ``%``.
    """
    escaped = base.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"{escaped}%"


async def _taken_usernames(session: AsyncSession, *, bases: Sequence[str]) -> set[str]:
    """Read the handles that could collide with *bases*, so a free one can be resolved.

    Bounded to the handle *families* the caller is about to draw from rather than to the whole
    relation, and the two are very different queries once the site has users: reading every handle
    to place four of them is a sequential scan whose cost is the size of the user table, and the
    seed is the one script guaranteed to run against a populated database on every re-run.

    An anchored prefix per base is exactly the right bound, and it is complete rather than merely
    cheap. ``app.core.slug.unique_slug`` resolves a collision by appending ``-2``, ``-3`` and so on
    to the stem it was given, so every handle it can return for a base begins with that base - and
    a handle that does not begin with any of *bases* cannot collide with anything this call is
    about to hand out. That completeness argument is what the guard below protects: the one way
    ``unique_slug`` can return a value not prefixed by its input is by shortening an over-long stem
    on a hyphen boundary to make room for the suffix, so a base long enough for that to happen is
    rejected here rather than allowed to silently narrow the query past correctness.

    This is also the shape ``unique_slug`` documents for its callers - "the caller asks its
    repository for the slugs already matching the base" - so the bound aligns the seed with the
    contract the collision policy was written against.

    Args:
        session: The unit of work. Not committed here.
        bases: The handle stems about to be resolved, pre-slugification. Empty yields an empty set
            without a query, because a caller with nothing to place has nothing to avoid.

    Returns:
        Every handle in those families, in the case the database stored it.
        ``unique_slug`` folds both sides, so no normalisation is needed here.

    Raises:
        ValueError: If a base is long enough that ``unique_slug`` could truncate it, which would
            break the prefix-completeness argument above.
    """
    if not bases:
        return set()

    patterns = []
    for base in bases:
        stem = slugify_title(base)
        if len(stem) + _HANDLE_SUFFIX_HEADROOM > DEFAULT_MAX_LENGTH:
            msg = (
                f"handle base {base!r} slugifies to {len(stem)} characters, leaving less than "
                f"{_HANDLE_SUFFIX_HEADROOM} characters of the {DEFAULT_MAX_LENGTH}-character slug "
                f"bound for a collision suffix; unique_slug would shorten the stem to make room "
                f"and the prefix lookup in _taken_usernames would no longer be complete"
            )
            raise ValueError(msg)
        patterns.append(cast(User.username, Text).ilike(_handle_family_pattern(stem), escape="\\"))

    # `username` is citext, so the predicate is written against the text CAST to reach
    # ix_users_username_trgm - gin_trgm_ops is defined over `text` and citext's own operators are
    # not in that operator family. ILIKE rather than LIKE because casting away citext also casts
    # away its case-folding, and folding is what makes `Admin` collide with `admin`.
    statement = select(User.username).where(or_(*patterns))
    return set((await session.scalars(statement)).all())


# =======================================================================================
# Seed helpers
#
# Each one is independently re-runnable and independently idempotent: it reads what is already
# there, inserts only what is missing, and reports both counts. None of them commits - that is
# `main`'s single responsibility - and none of them deletes anything.
# =======================================================================================


async def seed_categories(session: AsyncSession) -> tuple[dict[str, Category], Tally]:
    """Ensure every category in :data:`REFERENCE_CATEGORIES` exists.

    Existence is tested on the slug *and* on the name, because both are unique in the schema.
    Checking only the slug would leave the case where an operator renamed a category's slug: the
    slug lookup would miss, the insert would collide on the name, and an idempotent script would
    fail on its second run. Both lookups fold case, by different means: ``categories.slug`` is
    ``citext`` and folds itself, while the name is folded explicitly because ``categories.name`` is
    plain ``TEXT``. Both are bounded to the eight reference values rather than reading the taxonomy
    - see the comment on the query for why the name side is folded even though the constraint it
    protects is case-sensitive.

    The returned mapping is keyed by the *reference* slug - the value :attr:`CategorySpec.slug`
    derives - whichever row ended up satisfying it, so :func:`seed_posts` can resolve a subject's
    slugs without caring who created the row or what it is currently called.

    Args:
        session: The unit of work. Not committed here.

    Returns:
        The reference taxonomy keyed by derived slug, and a tally over the eight specs.
    """
    logger = get_logger(__name__)

    # Bounded to the sixteen values this function could possibly match - eight reference slugs and
    # eight reference names - rather than reading the taxonomy. The difference is not academic once
    # an administrator has been creating categories: the unbounded form materialised every row in
    # the relation as a full ORM entity to decide the fate of eight of them.
    #
    # The slug side is index-served: `categories.slug` is citext, so `IN` folds case for free and
    # resolves through ix_categories_slug. The name side folds case in SQL instead, which is
    # deliberately non-sargable and deliberately kept. `categories.name` is plain TEXT under a
    # case-SENSITIVE unique constraint, so folding here is stricter than the constraint - a stored
    # `python` is treated as satisfying a reference `Python` even though an insert would not
    # actually collide. Stricter is the safe direction for an idempotent script: the failure it
    # avoids is a second run raising IntegrityError, and the cost of being over-broad is a skip
    # rather than a duplicate.
    lowered_names = [spec.name.casefold() for spec in REFERENCE_CATEGORIES]
    present = (
        await session.scalars(
            select(Category).where(
                or_(
                    Category.slug.in_([spec.slug for spec in REFERENCE_CATEGORIES]),
                    func.lower(Category.name).in_(lowered_names),
                )
            )
        )
    ).all()
    by_slug = {category.slug.casefold(): category for category in present}
    by_name = {category.name.casefold(): category for category in present}

    resolved: dict[str, Category] = {}
    created = 0
    skipped = 0

    for spec in REFERENCE_CATEGORIES:
        slug = spec.slug
        existing = by_slug.get(slug.casefold())
        if existing is None:
            existing = by_name.get(spec.name.casefold())
        if existing is not None:
            resolved[slug] = existing
            skipped += 1
            continue

        category = Category(name=spec.name, slug=slug, description=spec.description)
        session.add(category)
        # Registered in both indexes so a duplicate inside REFERENCE_CATEGORIES itself would be
        # caught by the same lookup rather than by a unique violation at flush.
        by_slug[slug.casefold()] = category
        by_name[spec.name.casefold()] = category
        resolved[slug] = category
        created += 1

    if created:
        await session.flush()

    logger.info(
        "reference categories seeded",
        created=created,
        skipped=skipped,
        total=len(REFERENCE_CATEGORIES),
    )
    return resolved, Tally(created=created, skipped=skipped)


async def seed_administrator(session: AsyncSession) -> tuple[User, Tally]:
    """Ensure a *usable* administrator exists at the configured email, or fail saying why.

    Both halves of the credential come from configuration - ``SEED_ADMIN_EMAIL`` and
    ``SEED_ADMIN_PASSWORD`` - with no in-code default for either, and the password is persisted
    only as an argon2id hash. The plaintext is never logged, never returned and never stored.
    ``app.core.config`` holds it to the same policy the registration route applies, so this
    function cannot hash a credential the API would have refused.

    This function performs no strength check of its own, and must not: the password reaching it
    has already satisfied the registration policy - length, character variety and not being a
    published placeholder - because ``app.core.config`` validates it while constructing
    ``settings``, which happens at import time and therefore before this module can be called.
    A weak or placeholder value stops the process rather than becoming the credential of the
    most privileged account in the product, and checking it a second time here would put the
    same policy in two places.

    An existing account is returned **untouched**, and that is a security property rather than an
    optimisation: an operator who rotated this password must not have it reset by the next
    ``make seed``, and neither must a role or an active flag somebody changed on purpose.

    Untouched is not the same as unchecked
    --------------------------------------
    Returning any row that happens to carry the configured email would let seeding report success
    while leaving no administrator at all - the account might hold ``READER`` after a demotion, or
    be deactivated after a suspension, and either way every ``/api/v1/admin`` route stays closed
    and the dashboard the seed exists to make reachable is not reachable. Worse, the caller
    receives that row as "the administrator" and attributes demonstration posts to it.

    So an existing row is verified rather than trusted, and a row that is not an active ``ADMIN``
    raises. The one thing this function will not do is silently elevate it: promoting an account
    an operator deliberately demoted, or reactivating one they suspended, would be this process
    quietly overruling a human decision about authority - which is exactly the class of change a
    seed script must never make. Reporting the mismatch, naming the row's actual state and the
    variable that selected it, leaves the decision where it belongs.

    The handle is resolved against the handles already in use in its own family rather than assumed
    free, because
    ``users.username`` is unique and ``citext`` - a pre-existing ``admin`` would otherwise turn a
    re-run into an ``IntegrityError``.

    Args:
        session: The unit of work. Not committed here.

    Returns:
        The administrator - existing or newly added, and in either case active and holding
        ``ADMIN`` - and a tally over that single row.

    Raises:
        ValueError: An account already exists at ``SEED_ADMIN_EMAIL`` but is deactivated, or does
            not hold ``ADMIN``. :func:`main` rolls the transaction back, logs the failure and
            re-raises, so the process exits non-zero and nothing is written.
    """
    logger = get_logger(__name__)

    email = settings.SEED_ADMIN_EMAIL
    existing = await session.scalar(select(User).where(User.email == email))
    if existing is not None:
        # Verified, not assumed. Both conditions are reported at once when both hold, so an
        # operator fixes one round of configuration rather than two.
        problems = []
        if existing.role is not UserRole.ADMIN:
            problems.append(f"its role is {existing.role.value} rather than {UserRole.ADMIN.value}")
        if not existing.is_active:
            problems.append("it is deactivated")
        if problems:
            # The email is the value SEED_ADMIN_EMAIL carries and is personal data; the username
            # is a public handle that appears in URLs, so it is what identifies the row here.
            msg = (
                f"the account SEED_ADMIN_EMAIL selects (username {existing.username!r}) cannot "
                f"act as an administrator: {' and '.join(problems)}. Seeding will not change a "
                "role or an active flag that somebody set deliberately. Either grant that "
                "account ADMIN and reactivate it, or point SEED_ADMIN_EMAIL at a different "
                "address and seed again."
            )
            raise ValueError(msg)

        # The address and the handle are deliberately absent from this line, and from the
        # one below. A log line leaves the process - into a collector, a CI transcript, an
        # aggregator someone else administers - and an administrator's email address and
        # username are directly identifying and are half of a credential. What an operator
        # needs from a seed run is whether the account was created or found, which is
        # exactly what the event name and the role field say. Whoever needs to know WHICH
        # account it is already has SEED_ADMIN_EMAIL in front of them.
        logger.info(
            "administrator already present, left untouched",
            role=UserRole.ADMIN.value,
        )
        return existing, Tally(skipped=1)

    taken = await _taken_usernames(session, bases=[_ADMINISTRATOR_USERNAME])
    administrator = User(
        email=email,
        username=_resolve_username(_ADMINISTRATOR_USERNAME, taken),
        # The only place this process holds the plaintext is the argument to this call.
        password_hash=hash_password(settings.SEED_ADMIN_PASSWORD),
        display_name=_ADMINISTRATOR_DISPLAY_NAME,
        bio=_ADMINISTRATOR_BIO,
        # No avatar, so the administrator exercises the initials fallback.
        avatar_url=None,
        role=UserRole.ADMIN,
        is_active=True,
    )
    session.add(administrator)
    await session.flush()

    # The username rather than the email. `username` is a public handle - it is the path segment
    # in /api/v1/users/{username} and in the client's /u/{username} route - whereas the email is
    # the personal data SEED_ADMIN_EMAIL carries, and a log line leaves the process. It also
    # identifies the row just as precisely, both columns being CITEXT UNIQUE.
    logger.info(
        "administrator created",
        role=UserRole.ADMIN.value,
    )
    return administrator, Tally(created=1)


def _reject_unless_seeded_author(existing: User, spec: AuthorSpec) -> None:
    """Raise unless *existing* is the demonstration author *spec* describes.

    The gate that stops a pre-claimed account from acquiring seeded content. See "An existing
    row is verified, never trusted" on :func:`seed_authors` for why a roster address can be
    claimed at all and what the consequence would be.

    Three invariants, checked together so one run reports every problem it can see:

    * **Role.** ``AUTHOR`` exactly. A ``READER`` has no authoring privilege to receive the
      corpus with, and an ``ADMIN`` at an author's address is a conflation of the two accounts
      this module creates rather than a seeded author.
    * **Active.** A deactivated account cannot sign in, so attributing published posts to it
      would produce a public byline and profile nobody can administer from the inside.
    * **Identity.** The roster's ``display_name``, which is also what the handle is derived
      from. It is the one field that distinguishes "the row this seed created earlier" from
      "somebody else's row that happens to sit at this address", and it is compared exactly:
      ``display_name`` is ``TEXT`` rather than ``CITEXT``, so a case difference is a genuine
      difference in what a byline renders.

    ``email`` is deliberately not compared - it is the key this row was selected by - and
    ``username`` is deliberately not compared either, because :func:`_resolve_username` may
    legitimately have suffixed it (``priya-nair-2``) to avoid a collision when the row was
    created.

    Args:
        existing: The row found at *spec*'s address.
        spec: The roster entry that selected it.

    Raises:
        ValueError: When any invariant fails. The message names the address that selected the
            row, every condition that disqualified it, and the two remedies available - and it
            quotes no credential, no hash and no email other than the roster constant already
            published in this file.
    """
    problems: list[str] = []
    if existing.role is not UserRole.AUTHOR:
        problems.append(f"its role is {existing.role.value} rather than {UserRole.AUTHOR.value}")
    if not existing.is_active:
        problems.append("it is deactivated")
    if existing.display_name != spec.display_name:
        problems.append(
            f"its display name is {existing.display_name!r} rather than {spec.display_name!r}"
        )
    if not problems:
        return

    msg = (
        f"an account already exists at the demonstration address {spec.email!r} but is not the "
        f"seeded author: {' and '.join(problems)}. That address is published in this "
        "repository and can be registered by anyone, so seeding will not attribute "
        "demonstration posts to it, and it will not change a role, an active flag or a display "
        "name that somebody else set. Rename or remove that account, or edit AUTHOR_ROSTER for "
        "this deployment, and seed again."
    )
    raise ValueError(msg)


async def seed_authors(session: AsyncSession) -> tuple[list[User], Tally]:
    """Ensure every author in :data:`AUTHOR_ROSTER` exists, or fail saying which one does not.

    Structurally required rather than decorative: ``posts.author_id`` is a non-null foreign key,
    so demonstration posts cannot exist without demonstration authors.

    Each created author receives a fresh high-entropy password, hashed with argon2id, whose
    plaintext is discarded inside :func:`_demonstration_password`'s caller frame. See
    :data:`AUTHOR_ROSTER` for why these accounts are deliberately not sign-in fixtures.

    An existing row is verified, never trusted
    ------------------------------------------
    This is the same contract :func:`seed_administrator` holds, and it is here for a sharper
    reason. The three roster addresses are **published constants in this repository**, and they
    are valid inputs to ``POST /api/v1/auth/register``: anyone may create an ordinary ``READER``
    account at ``maya.rodriguez@example.com`` before a deployment is first seeded. Returning
    whatever row carries that address would hand that account the whole demonstration corpus,
    because :func:`seed_posts` attributes each draft to the row this function returns - and a
    post's author may edit it, delete it, publish it and unpublish it. A predictable address
    would therefore have been a way to acquire authored content, which is a privilege-escalation
    path rather than an untidiness.

    So a row found at a roster address is adopted only when it is *the seeded author*: active,
    holding :attr:`UserRole.AUTHOR`, and carrying the roster's own ``display_name``. Anything
    else raises, naming the mismatch. Three things this function will not do, each deliberate:

    * **It will not elevate.** Promoting a ``READER`` to ``AUTHOR`` would let the collision
      itself grant the authority, which is exactly the escalation the check exists to stop - and
      it would also overrule an operator who demoted the account on purpose.
    * **It will not reassign.** No post is moved off an account and no address is rewritten;
      the run stops instead, and :func:`main` rolls the whole transaction back.
    * **It will not silently skip the roster slot.** :attr:`PostDraft.author_slot` indexes this
      list positionally, so a missing entry is not an option: it would either shift every later
      author's content onto the wrong byline or raise an ``IndexError`` deep inside
      :func:`seed_posts`.

    The remedy an operator has is to rename or remove the colliding account, or to edit
    :data:`AUTHOR_ROSTER` for this deployment - both decisions a human takes, which is why the
    message names the address that selected the row and the state that disqualified it.

    Args:
        session: The unit of work. Not committed here. Call after
            :func:`seed_administrator` so the administrator's handle is already visible to
            handle resolution.

    Returns:
        The roster's users in roster order - which is what :attr:`PostDraft.author_slot`
        indexes - and a tally over them. Every returned row is active, holds ``AUTHOR`` and
        carries the roster's ``display_name``, whether it was inserted here or found.

    Raises:
        ValueError: An account already exists at a roster address but is not the seeded author -
            it is deactivated, holds a different role, or carries a different display name.
            :func:`main` rolls the transaction back, logs the failure and re-raises, so the
            process exits non-zero and nothing is written.
    """
    logger = get_logger(__name__)

    emails = [spec.email for spec in AUTHOR_ROSTER]
    present = (await session.scalars(select(User).where(User.email.in_(emails)))).all()
    by_email = {user.email.casefold(): user for user in present}

    # The administrator's family is included alongside the roster's, which keeps the ordering
    # guarantee this function's docstring makes: called after `seed_administrator`, the handle that
    # run placed is visible here. The three roster families happen to be disjoint from `admin`
    # today, so nothing would collide if it were omitted - but that is a property of the current
    # roster rather than of the code, and one renamed author should not quietly reintroduce a
    # unique violation on a re-run.
    taken = await _taken_usernames(
        session,
        bases=[_ADMINISTRATOR_USERNAME, *(spec.display_name for spec in AUTHOR_ROSTER)],
    )
    authors: list[User] = []
    created = 0
    skipped = 0

    for spec in AUTHOR_ROSTER:
        existing = by_email.get(spec.email.casefold())
        if existing is not None:
            # Verified, not assumed - see "An existing row is verified, never trusted" above.
            # All disqualifying conditions are reported together so an operator sees the whole
            # picture in one run rather than discovering the next one after fixing the first.
            _reject_unless_seeded_author(existing, spec)
            authors.append(existing)
            skipped += 1
            continue

        author = User(
            email=spec.email,
            username=_resolve_username(spec.username, taken),
            password_hash=hash_password(_demonstration_password()),
            display_name=spec.display_name,
            bio=spec.bio,
            avatar_url=spec.avatar_url,
            role=UserRole.AUTHOR,
            is_active=True,
        )
        session.add(author)
        authors.append(author)
        created += 1

    if created:
        await session.flush()

    # Counts and the role, never the handles. The roster's usernames are account identifiers
    # for real rows in a real database, and emitting the whole list turns one seed run into a
    # ready-made enumeration of every author account in whatever store collects these lines.
    # The three numbers below answer the only questions a seed run raises - how many were
    # added, how many were already there, and whether that accounts for the roster.
    logger.info(
        "demonstration authors seeded",
        created=created,
        skipped=skipped,
        total=len(AUTHOR_ROSTER),
        role=UserRole.AUTHOR.value,
    )
    return authors, Tally(created=created, skipped=skipped)


async def seed_posts(
    session: AsyncSession,
    *,
    administrator: User,
    authors: Sequence[User],
    categories_by_slug: Mapping[str, Category],
) -> Tally:
    """Ensure the whole demonstration corpus exists, with its category associations.

    Identity is the slug, and only the slug. A post whose slug is already present is skipped
    outright - its associations are deliberately not reconciled, both because a committed post
    from this module always carries them (they are inserted in the same unit of work) and
    because touching ``existing.categories`` would trigger a lazy load from synchronous context
    and raise ``MissingGreenlet``. Skipping also means a *reader's* post that happens to occupy
    one of these slugs is left completely alone, which is the additive-only contract.

    Nothing supplies a primary key, a ``created_at``, an ``updated_at`` or a ``search_vector``:
    identity comes from ``gen_random_uuid()``, the audit columns from the timestamp mixin's
    server defaults, and the search vector from the generated column, which re-derives itself on
    write with no index-maintenance step here. ``published_at`` *is* set explicitly, because it
    is a domain fact rather than bookkeeping - and it is set in a way that satisfies the
    publication check constraint rather than circumventing it.

    The author is attached through the ``Post.author`` relationship rather than by assigning
    ``author_id``, and the categories through ``Post.categories`` rather than by inserting into
    the ``post_categories`` association table. Both let SQLAlchemy resolve the foreign keys at
    flush, so this function never needs an identifier that does not exist yet.

    Ownership is granted here, and it is only ever granted to a verified row
    ----------------------------------------------------------------------
    Every draft becomes a row whose ``author_id`` points at one of *administrator* or *authors*,
    and a post's author may edit, delete, publish and unpublish it - so this function is where
    the corpus acquires an owner. It performs no verification of its own and must not: both
    arguments arrive already checked, ``administrator`` by :func:`seed_administrator` and each
    element of *authors* by :func:`_reject_unless_seeded_author`, and re-checking here would put
    one rule in two places. What that division means for a caller is that these two arguments
    may only ever be passed straight through from those two functions - which is what
    :func:`seed_all` does - and never assembled from an arbitrary query, because a row this
    function is handed is a row it hands the content to.

    Args:
        session: The unit of work. Not committed here.
        administrator: The account authoring the positions in
            :data:`_ADMINISTRATOR_POSITIONS`. Exactly as :func:`seed_administrator` returned it,
            and therefore active and holding ``ADMIN``.
        authors: The roster, in roster order, exactly as :func:`seed_authors` returned it, and
            therefore every element active, holding ``AUTHOR`` and carrying the roster's own
            display name.
        categories_by_slug: The reference taxonomy, exactly as :func:`seed_categories`
            returned it.

    Returns:
        A tally over the ninety-six drafts.

    Raises:
        ValueError: If *authors* does not match :data:`AUTHOR_ROSTER` in length, which would
            otherwise surface as an ``IndexError`` deep inside the loop, or if a subject names a
            category that is not in the reference taxonomy.
    """
    logger = get_logger(__name__)

    if len(authors) != len(AUTHOR_ROSTER):
        msg = (
            f"seed_posts expects {len(AUTHOR_ROSTER)} authors in AUTHOR_ROSTER order, "
            f"got {len(authors)}; call seed_authors first and pass its result through"
        )
        raise ValueError(msg)

    corpus = _compose_corpus(datetime.now(UTC))
    # Bounded to the ninety-six slugs this corpus could collide with, not every slug in the
    # relation. On a site with real posts the unbounded form read the entire slug column to decide
    # the fate of a fixed ninety-six, and it is the seed - the one script certain to be re-run
    # against a populated database - that pays that cost. `posts.slug` is citext, so `IN` folds
    # case exactly as the surrounding comparison does and resolves through ix_posts_slug.
    present = {
        slug.casefold()
        for slug in (
            await session.scalars(
                select(Post.slug).where(Post.slug.in_([draft.slug for draft in corpus]))
            )
        ).all()
    }

    created = 0
    skipped = 0
    associations = 0
    by_status: dict[str, int] = {status.value: 0 for status in PostStatus}

    for draft in corpus:
        if draft.slug.casefold() in present:
            skipped += 1
            continue

        author = (
            administrator if draft.author_slot == ADMINISTRATOR_SLOT else authors[draft.author_slot]
        )
        categories = _resolve_categories(draft, categories_by_slug)
        session.add(
            Post(
                author=author,
                title=draft.title,
                slug=draft.slug,
                excerpt=draft.excerpt,
                content=draft.content,
                cover_image_url=draft.cover_image_url,
                status=draft.status,
                published_at=draft.published_at,
                view_count=draft.view_count,
                categories=categories,
            )
        )
        # Reserved immediately, so a duplicate slug inside the corpus could not slip past the
        # check and reach the unique index.
        present.add(draft.slug.casefold())
        created += 1
        associations += len(categories)
        by_status[draft.status.value] += 1

    if created:
        await session.flush()

    logger.info(
        "demonstration posts seeded",
        created=created,
        skipped=skipped,
        total=len(corpus),
        associations_created=associations,
        created_published=by_status[PostStatus.PUBLISHED.value],
        created_draft=by_status[PostStatus.DRAFT.value],
        created_archived=by_status[PostStatus.ARCHIVED.value],
    )
    return Tally(created=created, skipped=skipped)


# =======================================================================================
# Orchestration and entry point
# =======================================================================================


async def seed_all(session: AsyncSession) -> None:
    """Run every seed helper in dependency order.

    The order is forced by the data rather than chosen: posts need authors because
    ``posts.author_id`` is non-null, posts need categories because a subject names them, and the
    administrator is created before the roster so its handle is already reserved when the
    roster's handles are resolved.

    Deliberately does not commit. A caller inside a test wants the work inside its own
    transaction so it can roll back, and :func:`main` wants exactly one commit at the end; a
    commit here would take that choice away from both.

    Args:
        session: The unit of work every helper shares.
    """
    logger = get_logger(__name__)
    logger.info("seed starting", environment=settings.ENVIRONMENT)

    categories_by_slug, categories = await seed_categories(session)
    administrator, administrator_tally = await seed_administrator(session)
    authors, authors_tally = await seed_authors(session)
    posts = await seed_posts(
        session,
        administrator=administrator,
        authors=authors,
        categories_by_slug=categories_by_slug,
    )

    users_created = administrator_tally.created + authors_tally.created
    users_skipped = administrator_tally.skipped + authors_tally.skipped
    logger.info(
        "seed complete",
        categories_created=categories.created,
        categories_skipped=categories.skipped,
        users_created=users_created,
        users_skipped=users_skipped,
        posts_created=posts.created,
        posts_skipped=posts.skipped,
        rows_created=categories.created + users_created + posts.created,
        rows_skipped=categories.skipped + users_skipped + posts.skipped,
    )


async def main() -> None:
    """Configure logging, seed inside one transaction, commit once, and dispose the engine.

    The failure path is as much of the contract as the success path. Any exception rolls the
    transaction back and is re-raised, so it leaves ``asyncio.run`` and the process exits
    non-zero - which is what makes the ``Makefile``'s ``seed`` target a gate rather than a
    suggestion. ``BaseException`` is caught for the rollback, not just ``Exception``, so a
    cancellation or an interrupt also leaves the database untouched rather than partly seeded.

    ``engine.dispose()`` runs in a ``finally``, so it happens on both paths and the process exits
    with no pooled connection still open.
    """
    configure_logging()
    logger = get_logger(__name__)

    try:
        async with AsyncSessionLocal() as session:
            try:
                await seed_all(session)
                await session.commit()
            except BaseException:
                await session.rollback()
                raise
        logger.info("seed committed")
    except Exception:
        # `logger.exception` attaches the frames, and this is the one place in the seeding path
        # that does. Safe for the same two structural reasons the request path relies on:
        # `app.core.logging` constructs its traceback renderer with `show_locals=False`, so the
        # locals of `seed_all` - which include `settings.SEED_ADMIN_PASSWORD` and the argon2id
        # hash derived from it - are never serialised; and `redact_log_event` runs in both
        # terminal chains immediately after the exception renderer, so a driver message quoting
        # the connection URL, the administrator's address or a PostgreSQL DETAIL line is stripped
        # of it whether this ran with development or JSON logging. The message itself names no
        # value: it says what failed and what was NOT written, which is the only thing an
        # operator needs before re-running this command.
        logger.exception("seed failed; the transaction was rolled back and nothing was written")
        raise
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
