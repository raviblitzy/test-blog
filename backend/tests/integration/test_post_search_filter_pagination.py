"""The composition test for the home feed: search, filters, ordering, windowing, and the plan.

``GET /api/v1/posts`` is the only endpoint in this API that composes five independent concerns
into one statement - free-text relevance search, category membership, author membership,
ordering and page windowing - and answers with the one page envelope every other listing
shares. This module is where that claim is proved. It exercises the endpoint through HTTP and
it exercises the *plan* of the statement underneath it, because AAP §0.9.4.2 asks for both and
because no other module in the suite is positioned to ask either question.

Two AAP criteria live here
--------------------------
* **§0.9.4.4 "Feed composition", in full.** Seeded data returns a correct ``total`` and
  ``pages``; a search term orders by relevance; a category filter restricts; page two returns a
  disjoint set from page one; an out-of-range page returns an empty item list rather than an
  error.
* **§0.9.4.2 "Search indexes are used at volume."** ``EXPLAIN`` on the feed's search query
  selects the full-text index once the table is seeded. AAP §0.9.5 carries this forward as an
  explicitly deferred risk - "a probe against a single-row table chose a sequential scan" - and
  names re-confirmation with seeded data as outstanding work. This module is its designated
  home, and :class:`TestSearchIndexUsageAtVolume` is where the risk is discharged.

No user rules govern this file
------------------------------
``review_rules`` returns exactly ``No user rules provided.`` - a complete response, not a
truncated window - so **no user-specified rule governs this module and no rule placed it in
scope**. It is in scope solely by the AAP's file inventory (§0.4.4.5) and execution plan
(§0.7.1.11, Group 11). Nothing here is invented to fill that gap, and the absence of rules is
not read as licence to lower the bar: the substitute standard is the AAP's own §0.10.1
enterprise standards, two of which bear directly on this file.

* **§0.10.1 #4, explicit API contracts.** The standard requires *one* page envelope for
  collections. So every response asserted here is checked for all five members - ``items``,
  ``total``, ``page``, ``page_size``, ``pages`` - and the ``pages`` arithmetic is asserted to be
  exactly ``ceil(total / page_size)`` rather than approximately right. This endpoint is the
  reference implementation of an envelope three other surfaces share, so drift here breaks the
  client's single pagination control everywhere at once.
* **§0.10.1 #8, blocking quality gates.** ``pytest backend/tests --cov=backend/app
  --cov-fail-under=80`` and the CI backend job are blocking, so there is no ``skip``, no
  ``xfail``, no placeholder and nothing order-dependent below - including in the ``EXPLAIN``
  tests, which are the ones most tempting to mark expected-to-fail.

Why every expectation is scoped to this module's own corpus
-----------------------------------------------------------
``posts`` is **not** empty when these tests run, and it is not empty in two different ways.
Revision ``0003_seed_reference_categories`` commits eight reference categories, and a shared
test database may additionally carry committed rows from ``app/db/seed.py`` having been run
against it - eight reference categories and ninety-six demonstration posts were observed in
exactly that state while this module was written. ``backend/tests/conftest.py`` rolls each test
back rather than truncating, so those rows are permanent baseline for the session.

Every exact assertion below is therefore **scoped by an identity this module created** - the
username of its own author, or the slug of its own category - and never by the unfiltered feed.
``total`` for a scoped query is a fact about this corpus; ``total`` for the bare path is a fact
about whatever else happens to be in the database, and the two must not be confused. The one
unscoped assertion is a "contains at least" form, which is true either way.

Determinism, and why nothing is left to Faker
---------------------------------------------
``tests.factories`` seeds Faker once per **process**, so the values it generates depend on how
many factory calls preceded them - which depends on which test modules ran first. Any assertion
resting on generated text would therefore pass or fail according to collection order. So every
post in the corpus below is given an explicit title, excerpt, content and publication instant,
and the publication instants are distinct and ordered. Nothing that a relevance, ordering or
counting assertion touches is generated.

Unique values are never pinned either. ``users.username``, ``categories.slug`` and
``posts.slug`` are ``CITEXT`` behind unique indexes and the database may already hold committed
rows, so this module lets the factories generate every unique value - each embeds a
process-monotonic counter - and reads it back off the returned object. A hard-coded username
would be a collision waiting for the first environment that had already committed one.

What the plan tests found, and why they assert what they assert
--------------------------------------------------------------
The ``EXPLAIN`` assertions were not written from an expectation, they were written from a
measurement. The feed's search predicate is a **disjunction**: the repository applies a term as
``search_vector @@ websearch_to_tsquery(...) OR title % term``, ranked full-text search as the
primary path with trigram similarity on the title as the typo-tolerant fallback. Each half was
planned separately and together, at volumes from one to eight thousand rows, in databases whose
GIN indexes ranged from twenty-two to a thousand pages, always after ``ANALYZE``, always with the
index's pending list drained, and never with ``enable_seqscan`` disabled. Three results held:

1. the **ranked full-text path** plans as a sequential scan at a single row - precisely the
   observation AAP §0.9.5 records - and switches to a bitmap scan over
   ``ix_posts_search_vector`` from about two hundred rows upward;
2. the **default recency path** plans as an index scan over ``ix_posts_status_published_at`` from
   the same point, which matters because it is the home page's primary query;
3. the **whole disjunction** - the statement a reader's search really issues - plans as a
   ``BitmapOr`` over *both* GIN indexes from about twelve hundred rows upward. Its threshold is
   higher than the ranked half's because a ``BitmapOr`` pays for both scans.

One condition turned out to be load-bearing for all three, and finding it is what made these
assertions safe to gate on. A GIN index created with ``fastupdate`` on - the default, and what
revision ``0002`` creates - buffers newly inserted entries in an unordered *pending list* that
every scan of the index must read in full. Bulk-loading thousands of rows inside one transaction
therefore leaves the index mid-load, a state no queried index is really in, and inflates its cost
sevenfold: the ranked search costed 337.59 with the list unflushed against 48.59 with it drained.
Worse, the list is physical, so it survives the rollback of the transaction that filled it and
accumulates across a run - which made the same assertion pass when this module ran alone and fail
when it ran after its siblings. :func:`_add_volume` therefore drains it, exactly as autovacuum
does continuously in production, and the answers above stop depending on execution order.

That is data maintenance, not coercion: no planner setting is touched, no cost constant is tuned,
``enable_seqscan`` stays on, and no assertion is marked expected-to-fail. Revision ``0002``
supplies the standard these tests are held to - "a planner that declines an index on a small
relation is costing the query correctly", while "what would be a defect is an index the predicate
can never reach" - and every index this schema creates for the feed is shown here to be reachable
by the predicate that needs it, at volume.

Boundaries
----------
Behaviour is asserted through ``client`` over status codes and response bodies only. The one
documented exception is :class:`TestSearchIndexUsageAtVolume`, which runs ``ANALYZE`` and
``EXPLAIN`` on ``db_session`` and builds its statements from
``app.repositories.post_repository``'s own expression builders - so the plan it inspects is the
plan production issues rather than a hand-written approximation of it. That is exactly the
database-plan verification AAP §0.9.4.2 asks for.

Envelope arithmetic and ``PageParams`` bounds are covered at the unit level by
``backend/tests/unit/test_pagination.py``; only the HTTP-visible half is asserted here. There is
no cleanup, no ``TRUNCATE`` and no ``__init__.py``: the per-test rollback in
``backend/tests/conftest.py`` is the isolation mechanism.
"""

from __future__ import annotations

import dataclasses
import math
import re
import typing
from datetime import UTC, datetime, timedelta
from typing import Any, Final

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import func, insert, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.sql.expression import ClauseElement, Executable

from app.core.dependencies import MAX_PAGE_SIZE, MIN_PAGE, MIN_PAGE_SIZE
from app.models import Category, Post, PostStatus, User
from app.repositories.post_repository import (
    DEFAULT_POST_SORT,
    PostSort,
    _build_ordering,
    _build_predicates,
    _normalise_term,
    _published_at_nullable,
    _restrict,
    _search_query,
    _with_projection,
)
from app.schemas import Page, PostSummary
from app.schemas.common import MAX_SEARCH_TERM_LENGTH
from app.schemas.post import PostDetail, PostSortOption
from tests import factories

# ---------------------------------------------------------------------------------------
# The endpoint under test
# ---------------------------------------------------------------------------------------

FEED_PATH: Final[str] = "/api/v1/posts"
"""The feed. ``app.api.v1.router`` mounts the posts router at ``/api/v1/posts`` and the handler
registers on ``""``, so this is the whole path and it carries no trailing slash."""

type QueryValue = str | int | float | bool | None
"""A value that may appear in a query string, as httpx's own ``params`` signature defines it.

Named because the four helpers below take ``**params`` and forward it verbatim to
``AsyncClient.get``. Annotating those as ``object`` typed nothing and hid a real narrowing: httpx
accepts a scalar or a sequence of scalars per key, so ``object`` admits a value the request layer
would reject at runtime. Every call in this module passes a scalar, so the alias stops at those.
"""

PAGE_MEMBERS: Final[frozenset[str]] = frozenset(Page.model_fields)
"""The envelope's five member names, taken from the model rather than restated.

AAP §0.10.1 #4 requires one envelope for every collection, so the assertion is that the wire
body carries exactly what :class:`~app.core.pagination.Page` declares - no more, no fewer.
Reading them off ``model_fields`` means renaming a member breaks this test at the moment the
rename happens rather than silently passing against a stale literal list."""

SUMMARY_MEMBERS: Final[frozenset[str]] = frozenset(PostSummary.model_fields)
"""The members a feed element carries, taken from :class:`~app.schemas.post.PostSummary`.

The projection deliberately omits ``content`` so a feed page stays small however long the
articles behind it are; :data:`SUMMARY_MEMBERS` is compared against the wire keys and
``content``'s absence is asserted separately and explicitly."""

# ---------------------------------------------------------------------------------------
# Search vocabulary
#
# Every token below is a coined word chosen so that it cannot occur in Faker prose, in revision
# 0003's reference categories, or in the demonstration content `app/db/seed.py` writes. That is
# what lets a search assertion be exact: the term matches the posts this module planted and
# nothing else, whatever else the database happens to hold.
#
# They are also chosen for their trigram behaviour, which `%` measures over WHOLE strings rather
# than word by word. `similarity('Zylphograph', 'zylphograhp')` is 0.6 against a threshold of
# 0.3, so the typo term matches through the fallback; the same misspelling against a long title
# would fall under the threshold, which is why the typo post's title is one word.
# ---------------------------------------------------------------------------------------

SEARCH_TERM: Final[str] = "quantumsluice"
"""The primary search term, planted at three different ``setweight`` weights.

One post carries it in its ``title`` (weight ``'A'``), one in its ``excerpt`` (``'B'``) and one
in its ``content`` (``'C'``), which is what makes the weighting in the generated ``tsvector``
observable as an ordering rather than merely present in the schema."""

PHRASE_TOKENS: Final[tuple[str, str]] = ("kolibrivalve", "thundersprocket")
"""Two tokens that occur together in exactly one post's body, and nowhere else.

``websearch_to_tsquery`` ANDs bare words, so searching both returns that post and searching one
of them beside :data:`ABSENT_TOKEN` returns nothing - which is how the conjunction is proved
rather than assumed."""

ABSENT_TOKEN: Final[str] = "vorpalquincunx"
"""A token planted nowhere at all, used to demonstrate the conjunction and the empty envelope."""

TYPO_TITLE: Final[str] = "Zylphograph"
"""A one-word title, short on purpose so trigram similarity against a misspelling stays high."""

TYPO_TERM: Final[str] = "zylphograhp"
"""A transposition of :data:`TYPO_TITLE`. It shares no lexeme with it, so a hit can only have
arrived through the ``pg_trgm`` ``%`` half of the repository's disjunction."""

# ---------------------------------------------------------------------------------------
# Index names, quoted from the migrations that create them
#
# Revision 0001 creates ix_posts_status_published_at as a composite b-tree over
# (status, published_at DESC); revision 0002 creates ix_posts_search_vector as GIN over the
# generated tsvector and ix_posts_title_trgm as GIN over title with gin_trgm_ops. All three are
# named EXPLICITLY in those revisions rather than derived from `app.db.base.NAMING_CONVENTION`,
# whose templates cover primary keys, foreign keys, unique and check constraints - so the names
# are quoted here from the revisions, which are their single source of truth.
# ---------------------------------------------------------------------------------------

SEARCH_VECTOR_INDEX: Final[str] = "ix_posts_search_vector"
"""GIN over ``posts.search_vector``: the feed's primary search access path."""

TITLE_TRIGRAM_INDEX: Final[str] = "ix_posts_title_trgm"
"""GIN over ``posts.title`` with ``gin_trgm_ops``: the typo-tolerant fallback's access path."""

RECENCY_INDEX: Final[str] = "ix_posts_status_published_at"
"""Composite b-tree over ``(status, published_at DESC)``: the home page's primary query."""


# ---------------------------------------------------------------------------------------
# EXPLAIN, as a first-class SQLAlchemy construct
# ---------------------------------------------------------------------------------------


class ExplainJson(Executable, ClauseElement):
    """Wrap a statement so that executing it returns its query plan as JSON.

    SQLAlchemy ships no ``EXPLAIN`` construct, and the obvious alternative - compiling the
    statement to a string and handing it to :func:`~sqlalchemy.text` - does not survive contact
    with this repository's statements. Two things break it. Expanding ``IN`` parameters compile
    to the placeholder ``__[POSTCOMPILE_status_1]`` rather than to SQL, because they are only
    expanded at execution time; and psycopg's parameter style doubles every ``%``, which turns
    the trigram operator ``%`` into ``%%%%`` and the statement into a syntax error. Both were
    observed directly while writing this module.

    Compiling through the ``@compiles`` hook instead means the inner statement is processed by
    the *real* compiler in the *real* execution context, so bind parameters, expanding ``IN``
    and operator escaping are all handled exactly as they are in production. The plan inspected
    is therefore the plan the application's own query would produce.

    ``FORMAT JSON`` rather than the default text output: a plan tree is easier to assert on
    structurally - node types and index names as data - than by matching substrings against
    formatting that changes between PostgreSQL releases.

    Note:
        ``inherit_cache = False`` is required. A custom construct that does not declare its
        caching behaviour makes SQLAlchemy emit a warning on every execution, and this suite
        runs with warnings visible.
    """

    inherit_cache = False

    def __init__(self, statement: ClauseElement) -> None:
        """Store the statement to be explained.

        Args:
            statement: Any executable statement. In this module it is always one composed from
                ``app.repositories.post_repository``'s own expression builders.
        """
        self.statement = statement


@compiles(ExplainJson, "postgresql")
def _compile_explain_json(element: ExplainJson, compiler: Any, **kw: Any) -> str:
    """Render :class:`ExplainJson` as ``EXPLAIN (FORMAT JSON) <statement>``.

    Args:
        element: The wrapper carrying the statement to explain.
        compiler: The active statement compiler. Delegating to it is the whole point - it is
            what makes bind parameters and expanding ``IN`` render correctly.
        **kw: Compiler keyword arguments, forwarded unchanged.

    Returns:
        The complete ``EXPLAIN`` statement, ready to execute.
    """
    # `SQLCompiler.process` is annotated as returning `Any`, so the concatenation would be `Any`
    # too and this function's declared `str` would be a claim nothing checked. `str(...)` makes the
    # assumption explicit at the one point it is made.
    return "EXPLAIN (FORMAT JSON) " + str(compiler.process(element.statement, **kw))


def _flatten_plan(node: dict[str, Any]) -> list[dict[str, Any]]:
    """Return every node of a ``FORMAT JSON`` plan tree, depth first.

    A plan is a nested structure whose children hang off ``"Plans"``. Flattening it once means
    an assertion can ask "does any node use this index" or "does any node scan this relation
    sequentially" without walking the tree itself, which keeps the assertions readable.

    Args:
        node: The root node - ``plan[0]["Plan"]`` from an ``EXPLAIN (FORMAT JSON)`` result.

    Returns:
        Every node in the tree, root first.
    """
    nodes = [node]
    for child in node.get("Plans") or ():
        nodes.extend(_flatten_plan(child))
    return nodes


async def _explain(session: AsyncSession, statement: ClauseElement) -> list[dict[str, Any]]:
    """Plan ``statement`` and return its nodes, flattened.

    Args:
        session: The transactional session. ``EXPLAIN`` without ``ANALYZE`` plans the statement
            and does not run it, so nothing is written and nothing is measured.
        statement: The statement to plan.

    Returns:
        The flattened plan nodes.
    """
    result = await session.execute(ExplainJson(statement))
    plan: list[dict[str, Any]] = result.scalar_one()
    return _flatten_plan(plan[0]["Plan"])


def _indexes_used(nodes: list[dict[str, Any]]) -> set[str]:
    """Collect the names of every index the plan reads.

    Args:
        nodes: Flattened plan nodes.

    Returns:
        The index names appearing on ``Index Scan``, ``Index Only Scan`` and ``Bitmap Index
        Scan`` nodes. Empty when the plan reads no index at all.
    """
    return {name for node in nodes if (name := node.get("Index Name"))}


def _scans_sequentially(nodes: list[dict[str, Any]], relation: str) -> bool:
    """Report whether the plan reads ``relation`` with a sequential scan.

    Args:
        nodes: Flattened plan nodes.
        relation: The relation name to look for, for example ``"posts"``.

    Returns:
        ``True`` when any node is a ``Seq Scan`` over that relation.
    """
    return any(
        node.get("Node Type") == "Seq Scan" and node.get("Relation Name") == relation
        for node in nodes
    )


def _bitmap_or_branches(nodes: list[dict[str, Any]]) -> dict[str, str]:
    """Return the index each ``BitmapOr`` branch reads, mapped to the condition it serves.

    Asserting on the *set* of indexes a plan touches says the two indexes were read somewhere;
    it does not say the disjunction was served by them. This says the second thing. PostgreSQL
    combines an ``OR`` of two indexable predicates under a ``BitmapOr`` whose children are the
    per-branch ``Bitmap Index Scan`` nodes, so reading those children names exactly which index
    answered which half - and would notice one index answering both halves, or one half falling
    out of the bitmap and into a recheck filter.

    ``_flatten_plan`` keeps the original node dictionaries rather than copies, so a ``BitmapOr``
    found in the flattened list still exposes its own ``"Plans"`` and the parent-child edge is
    recoverable without walking the tree a second time.

    Args:
        nodes: Flattened plan nodes.

    Returns:
        Index name to the ``Index Cond`` that index was given, across every ``BitmapOr`` in the
        plan. Empty when the plan contains no ``BitmapOr`` at all, which is itself a meaningful
        answer for a caller asserting that a disjunction was combined from two index scans.
    """
    branches: dict[str, str] = {}
    for node in nodes:
        if node.get("Node Type") != "BitmapOr":
            continue
        for child in node.get("Plans") or ():
            name = child.get("Index Name")
            if child.get("Node Type") == "Bitmap Index Scan" and name:
                branches[name] = str(child.get("Index Cond") or "")
    return branches


def _relation_estimate(nodes: list[dict[str, Any]], relation: str) -> int:
    """Return the row count the planner expects from the node that actually reads ``relation``.

    The node to ask, and the reason it is not the root, is the whole point of this helper. The
    statements planned here are the feed's **first page**, so their root is a ``Limit`` and its
    ``Plan Rows`` is capped at the page size - eight. Reading the estimate there makes a
    selectivity assertion unfalsifiable: ``8 < rows / 10`` holds for any corpus above eighty
    rows whether the planner expects the predicate to match seven rows or every one of them, so
    the gate would pass on precisely the statistics it exists to reject.

    The scan over ``posts`` carries the estimate that was actually derived from the predicate -
    ``Bitmap Heap Scan`` for the search paths, ``Index Scan`` or ``Seq Scan`` for the others -
    and that is the number a claim about ``ANALYZE`` and selectivity is a claim about.

    Args:
        nodes: Flattened plan nodes.
        relation: The relation whose scan estimate is wanted, for example ``"posts"``.

    Returns:
        The largest ``Plan Rows`` across every node that reads ``relation``. The maximum rather
        than the first, so a plan that reads the relation twice cannot hide an unselective
        branch behind a selective one.

    Raises:
        AssertionError: If no node in the plan reads that relation. A selectivity assertion
            about a relation the plan never touches would otherwise pass silently.
    """
    estimates = [
        int(node["Plan Rows"])
        for node in nodes
        if node.get("Relation Name") == relation and node.get("Plan Rows") is not None
    ]
    assert estimates, (
        f"no node in the plan reads {relation!r}, so there is no scan estimate to assert on; "
        f"plan was:\n{_describe_plan(nodes)}"
    )
    return max(estimates)


def _describe_plan(nodes: list[dict[str, Any]]) -> str:
    """Render a plan compactly, for use as an assertion message.

    A failing plan assertion is useless without the plan, and the plan is what a reader needs to
    decide whether the schema, the statement or the corpus is at fault. AAP §0.9.5 asks for this
    question to be confrontable rather than hidden, so the evidence travels with the failure.

    Args:
        nodes: Flattened plan nodes.

    Returns:
        One line per node: its type, the relation it reads and the index it uses.
    """
    return "\n".join(
        "  {}: relation={} index={} rows={} cost={}".format(
            node.get("Node Type"),
            node.get("Relation Name"),
            node.get("Index Name"),
            node.get("Plan Rows"),
            node.get("Total Cost"),
        )
        for node in nodes
    )


async def _relation_sizes(session: AsyncSession) -> dict[str, int]:
    """Return the page count the planner currently attributes to ``posts`` and its two GIN indexes.

    A plan choice is arithmetic over these numbers, so a failing plan assertion that does not
    report them leaves the reader guessing. They are also the reason this module escalates its
    volume rather than naming a single row count: ``relpages`` is *physical*, so it counts the dead
    rows every rolled-back test in the run left behind, and it shrinks again whenever autovacuum
    truncates the relation's tail. The live row count is stable from run to run; the page ratio the
    planner actually costs against is not.

    Args:
        session: The transactional session.

    Returns:
        Page counts keyed by relation name, for ``posts`` and the two indexes over it that the
        feed's search predicate can reach.
    """
    result = await session.execute(
        text(
            "SELECT relname, relpages FROM pg_class"
            " WHERE relname IN ('posts', 'ix_posts_search_vector', 'ix_posts_title_trgm')"
        )
    )
    # `Result.all()` types its rows as `Row[Any]`, which `dict()` cannot accept as a pair
    # source. `.tuples()` is SQLAlchemy 2.0's own narrowing for exactly this: it re-types the
    # result as tuples so the two selected columns are visible to the checker, and it emits no
    # additional SQL.
    return dict(result.tuples().all())


# ---------------------------------------------------------------------------------------
# The corpus
# ---------------------------------------------------------------------------------------

CORPUS_EPOCH: Final[datetime] = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
"""The instant every publication date is offset from.

Fixed rather than relative to "now", and timezone-aware because ``posts.published_at`` is
``TIMESTAMPTZ`` and ``ck_posts_published_at_required`` makes it mandatory for a published row. A
naive value would be interpreted against the connection's time zone, which would make the
corpus depend on where the suite happens to run."""

FILLER_POSTS: Final[int] = 18
"""How many anonymous published posts pad the primary author's page count.

Chosen so the primary author ends with twenty-five published posts once the seven
semantically significant ones are added, which is what makes :data:`PAGINATION_PAGE_SIZE` yield
three full pages and a partial fourth. No assertion names an individual filler post; they exist
to give the window something to slice, so they are written with **one** ``INSERT`` rather than
eighteen factory calls - the bulk path the AAP's own guidance prefers for volume, and worth
roughly a third of a second per test that uses this corpus."""

PAGINATION_PAGE_SIZE: Final[int] = 8
"""A page size that does **not** divide the corpus evenly: 25 rows become 4 pages of 8, 8, 8, 1.

The remainder is the point. A page size that divided evenly would let an off-by-one in the
``pages`` arithmetic pass unnoticed, and it would never exercise a short final page."""

EXACT_PAGE_SIZE: Final[int] = 5
"""A page size that divides the corpus exactly: 25 rows become 5 full pages and no trailing
empty one. Asserted alongside :data:`PAGINATION_PAGE_SIZE` because ``ceil`` has to be right in
both directions."""

VOLUME_POSTS: Final[int] = 2_000
"""How many extra published rows :class:`TestSearchIndexUsageAtVolume` adds before planning.

This number is a measurement, not a guess. With the relation in the state :func:`_add_volume`
leaves it in - fresh statistics and a flushed GIN pending list - the three feed access paths were
planned at one, two hundred, six hundred, twelve hundred, two thousand, four thousand and eight
thousand rows:

===========  ====================  =========================  ====================
rows         ranked full text      whole search disjunction   default recency
===========  ====================  =========================  ====================
1            sequential scan       sequential scan            sequential scan
200-600      ``search_vector``     sequential scan            ``status``/date
1 200+       ``search_vector``     both GIN indexes           ``status``/date
===========  ====================  =========================  ====================

The single-row row of that table is AAP §0.9.5's own observation, reproduced: a planner that
declines an index on a relation of one page is costing the query correctly. The threshold that
matters is the last one, because the disjunction is what the feed really issues, and two thousand
sits comfortably above it - measured in a database whose GIN indexes had bloated to a thousand
pages, which is the least favourable state a run produces. It costs roughly a third of a second to
insert, a fiftieth to ``ANALYZE`` and a twelfth to flush, so the module does not dominate the
suite's runtime."""

VOLUME_INSERT_CHUNK: Final[int] = 4_000
"""How many rows :func:`_add_volume` sends per ``INSERT``.

A bound, not a preference: a parameterised statement carries at most 65 535 bound parameters, and
these rows bind eight columns each, so a single statement tops out just above eight thousand rows.
Four thousand leaves generous headroom and keeps :data:`VOLUME_POSTS` a single round trip."""

NEUTRAL_EXCERPT: Final[str] = "A neutral summary carrying none of this module's rare tokens."
"""Excerpt text for every post that must **not** match a search. Written out rather than
generated so that no assertion depends on Faker's position in its sequence."""

NEUTRAL_CONTENT: Final[str] = (
    "Neutral body prose about ordinary engineering practice, deliberately free of any rare "
    "token so that a search for one cannot match this post by accident."
)
"""Body text for every post that must **not** match a search."""


@dataclasses.dataclass(frozen=True, slots=True)
class FeedCorpus:
    """The deterministic corpus every behavioural test in this module reads its answers from.

    Nothing below is a hard-coded count. A test asks the corpus how many published posts its
    primary author has, or which identifiers carry a category, and asserts the endpoint agrees -
    so changing the corpus changes the expectations with it and there is exactly one source of
    truth. That is also what keeps the assertions honest in a database that already holds
    committed rows: every expectation is a fact about *this* corpus, reached through a filter
    only this corpus can satisfy.

    Identifiers are held as strings because that is how they arrive on the wire, which keeps the
    comparisons free of conversions at the point where a mistake would be hardest to see.
    """

    primary_author: User
    """The author almost every assertion scopes itself to, via ``?author=``."""

    second_author: User
    """A second author, so an author filter has something to exclude and the three-way
    composition in AAP §0.9.4.4 has a narrowing to perform."""

    alpha: Category
    """A category carrying three published posts, one of which also matches
    :data:`SEARCH_TERM` - which is what lets a category filter and a search intersect."""

    beta: Category
    """A category carrying exactly one published post, which is also filed under
    :attr:`alpha`. That single row is the join-inflation guard's subject."""

    published_primary: tuple[str, ...]
    """Every published post of :attr:`primary_author`, newest first.

    Ordered exactly as the repository orders a recency listing - ``published_at DESC``, then
    ``posts.id DESC`` - and because every instant in the corpus is distinct the tiebreaker never
    has to fire, so this tuple is the one true expected order."""

    published_second: tuple[str, ...]
    """Every published post of :attr:`second_author`, newest first."""

    hidden: frozenset[str]
    """The draft and archived posts, which no anonymous request may ever surface."""

    title_hit: str
    """Carries :data:`SEARCH_TERM` in its ``title`` - ``setweight`` weight ``'A'``."""

    excerpt_hit: str
    """Carries :data:`SEARCH_TERM` in its ``excerpt`` - weight ``'B'``."""

    content_hit: str
    """Carries :data:`SEARCH_TERM` in its ``content`` - weight ``'C'``."""

    multiword: str
    """The only post carrying both members of :data:`PHRASE_TOKENS`, in its body."""

    typo: str
    """Titled :data:`TYPO_TITLE`; reachable only through the trigram half of the disjunction."""

    two_category: str
    """Filed under both :attr:`alpha` and :attr:`beta`."""

    term_alpha_primary: str
    """:attr:`primary_author`'s post that both matches :data:`SEARCH_TERM` and is filed under
    :attr:`alpha`, so a two-way filter still leaves the three-way filter something to narrow."""

    term_alpha_second: str
    """:attr:`second_author`'s equivalent, and the sole answer to the three-way composition."""

    @property
    def primary_username(self) -> str:
        """The ``?author=`` value that scopes a request to :attr:`primary_author`."""
        return self.primary_author.username

    @property
    def second_username(self) -> str:
        """The ``?author=`` value that scopes a request to :attr:`second_author`."""
        return self.second_author.username

    @property
    def alpha_slug(self) -> str:
        """The ``?category=`` value for :attr:`alpha`."""
        return self.alpha.slug

    @property
    def beta_slug(self) -> str:
        """The ``?category=`` value for :attr:`beta`."""
        return self.beta.slug

    @property
    def term_matches_primary(self) -> frozenset[str]:
        """Every published post of :attr:`primary_author` that :data:`SEARCH_TERM` matches."""
        return frozenset(
            {self.title_hit, self.excerpt_hit, self.content_hit, self.term_alpha_primary}
        )

    @property
    def alpha_published(self) -> frozenset[str]:
        """Every published post filed under :attr:`alpha`, across both authors."""
        return frozenset({self.term_alpha_primary, self.two_category, self.term_alpha_second})

    @property
    def beta_published(self) -> frozenset[str]:
        """Every published post filed under :attr:`beta`."""
        return frozenset({self.two_category})


def _at(minutes: int) -> datetime:
    """Return a publication instant offset from :data:`CORPUS_EPOCH`.

    Args:
        minutes: Whole minutes after the epoch. Every caller passes a distinct value, which is
            what makes the recency ordering total and therefore assertable without a tiebreak.

    Returns:
        An aware UTC instant.
    """
    return CORPUS_EPOCH + timedelta(minutes=minutes)


async def _insert_filler_posts(
    session: AsyncSession,
    *,
    author: User,
    count: int,
) -> list[str]:
    """Insert ``count`` neutral published posts in one statement and return their identifiers.

    These rows exist only to give the page window something to slice, so no assertion names one
    individually and none needs a relationship loaded. Writing them with a single ``INSERT``
    rather than ``count`` factory calls is what keeps this corpus affordable enough to rebuild
    for every test - the AAP's own guidance for volume is to create rows through the session in
    bulk - and it costs about a hundredth of the time eighteen round trips would.

    Every invariant a factory would have honoured is honoured here, and visibly:

    * **no primary key is supplied** - ``posts.id`` defaults to ``gen_random_uuid()``;
    * **``search_vector`` is never written** - revision ``0002`` declares it ``GENERATED ALWAYS
      AS (...) STORED`` and PostgreSQL rejects a write to it, so it is re-derived per row on
      this very ``INSERT``;
    * **every row carries a timezone-aware ``published_at``**, without which
      ``ck_posts_published_at_required`` would reject a ``PUBLISHED`` row.

    Args:
        session: The transactional session.
        author: The owning account; its identifier is written to ``author_id``.
        count: How many rows to write.

    Returns:
        The server-generated identifiers as strings, in insertion order.

    Note:
        Slugs are derived from the author's own generated username, which already embeds the
        factories' process-monotonic counter, so they are unique without this function inventing
        a discriminator of its own and without colliding with anything already committed.
    """
    rows = [
        {
            "author_id": author.id,
            "title": f"Feed Ordinary Article {index:02d}",
            "slug": f"{author.username}-feed-filler-{index:02d}",
            "excerpt": NEUTRAL_EXCERPT,
            "content": NEUTRAL_CONTENT,
            "status": PostStatus.PUBLISHED,
            # Offset well past the significant posts, so the significant ones are the OLDEST
            # rows in the corpus. That separation is what lets a relevance assertion prove it is
            # ranking rather than accidentally reproducing recency order.
            "published_at": _at(100 + index),
            "view_count": 0,
        }
        for index in range(count)
    ]
    result = await session.execute(insert(Post).values(rows).returning(Post.id))
    return [str(identifier) for identifier in result.scalars().all()]


async def _build_feed_corpus(session: AsyncSession) -> FeedCorpus:
    """Build the corpus described by :class:`FeedCorpus` and return it.

    Called once per test, because ``backend/tests/conftest.py`` rolls every test back and a
    session-scoped corpus would therefore vanish after the first one. That is the trade this
    module accepts deliberately: rebuilding costs argon2 hashes for two accounts plus a dozen
    flushes, and buys tests that cannot influence one another in any order.

    Two authors rather than three. The second exists so an author filter has something to
    exclude and the three-way composition has a narrowing to perform; a third would add half a
    second of password hashing per test and answer no question the second does not.

    Args:
        session: The transactional session, shared with the HTTP client.

    Returns:
        The populated corpus.
    """
    primary = await factories.create_author(session)
    second = await factories.create_author(session)

    # Named for what they do rather than for a topic, and left unpinned: `create_category`
    # derives a CITEXT-safe slug from the name plus its counter, so these cannot collide with
    # revision 0003's eight reference categories or with a sibling test's categories.
    alpha = await factories.create_category(session, name="Feed Filter Alpha")
    beta = await factories.create_category(session, name="Feed Filter Beta")

    # --- The seven posts every search, ordering and filter assertion names -----------------
    #
    # Published OLDEST first, in the order the relevance ranking is expected to return them, so
    # that recency and relevance disagree. If the ranking silently degraded to recency the
    # weighted-ordering test below would fail rather than pass by coincidence.
    title_hit = await factories.create_post(
        session,
        author=primary,
        title=f"Deep Dive Into {SEARCH_TERM.title()} Internals",
        excerpt=NEUTRAL_EXCERPT,
        content=NEUTRAL_CONTENT,
        status=PostStatus.PUBLISHED,
        published_at=_at(0),
    )
    excerpt_hit = await factories.create_post(
        session,
        author=primary,
        title="Ordinary Headline For The Weighted Excerpt Case",
        excerpt=f"A summary that mentions {SEARCH_TERM} exactly once.",
        content=NEUTRAL_CONTENT,
        status=PostStatus.PUBLISHED,
        published_at=_at(1),
    )
    content_hit = await factories.create_post(
        session,
        author=primary,
        title="Ordinary Headline For The Weighted Body Case",
        excerpt=NEUTRAL_EXCERPT,
        content=f"Body prose that mentions {SEARCH_TERM} deep inside it.",
        status=PostStatus.PUBLISHED,
        published_at=_at(2),
    )
    multiword = await factories.create_post(
        session,
        author=primary,
        title="Ordinary Headline For The Multiword Case",
        excerpt=NEUTRAL_EXCERPT,
        content=f"Body prose naming {PHRASE_TOKENS[0]} and {PHRASE_TOKENS[1]} together.",
        status=PostStatus.PUBLISHED,
        published_at=_at(3),
    )
    typo = await factories.create_post(
        session,
        author=primary,
        title=TYPO_TITLE,
        excerpt=NEUTRAL_EXCERPT,
        content=NEUTRAL_CONTENT,
        status=PostStatus.PUBLISHED,
        published_at=_at(4),
    )
    two_category = await factories.create_post(
        session,
        author=primary,
        title="Ordinary Headline Filed Under Two Categories",
        excerpt=NEUTRAL_EXCERPT,
        content=NEUTRAL_CONTENT,
        status=PostStatus.PUBLISHED,
        published_at=_at(5),
        categories=[alpha, beta],
    )
    term_alpha_primary = await factories.create_post(
        session,
        author=primary,
        title=f"{SEARCH_TERM.title()} Filed Under Alpha By The Primary Author",
        excerpt=NEUTRAL_EXCERPT,
        content=NEUTRAL_CONTENT,
        status=PostStatus.PUBLISHED,
        published_at=_at(6),
        categories=[alpha],
    )

    filler = await _insert_filler_posts(session, author=primary, count=FILLER_POSTS)

    # --- Posts that must never reach an anonymous caller ----------------------------------
    #
    # One draft and one archived post carry BOTH the search term and the alpha category, so that
    # draft confidentiality is tested on the paths most likely to defeat it: a search, a category
    # filter, an author filter, and all three together. A second, plain draft covers the ordinary
    # case. A draft has no publication instant - `published_at IS NOT NULL` is what distinguishes
    # "has been public" from "never has been" - while an archived post legitimately keeps the
    # instant it was published at, which is why only the check constraint's implication holds.
    draft_term_alpha = await factories.create_post(
        session,
        author=primary,
        title=f"Unfinished Notes On {SEARCH_TERM.title()}",
        excerpt=f"A draft summary mentioning {SEARCH_TERM}.",
        content=f"Draft body mentioning {SEARCH_TERM}.",
        status=PostStatus.DRAFT,
        categories=[alpha],
    )
    draft_plain = await factories.create_post(
        session,
        author=primary,
        title="Unfinished Notes With No Rare Token",
        excerpt=NEUTRAL_EXCERPT,
        content=NEUTRAL_CONTENT,
        status=PostStatus.DRAFT,
    )
    archived_term_alpha = await factories.create_post(
        session,
        author=primary,
        title=f"Retired Notes On {SEARCH_TERM.title()}",
        excerpt=f"An archived summary mentioning {SEARCH_TERM}.",
        content=f"Archived body mentioning {SEARCH_TERM}.",
        status=PostStatus.ARCHIVED,
        published_at=_at(50),
        categories=[alpha],
    )

    # --- The second author -----------------------------------------------------------------
    term_alpha_second = await factories.create_post(
        session,
        author=second,
        title=f"{SEARCH_TERM.title()} Filed Under Alpha By The Second Author",
        excerpt=NEUTRAL_EXCERPT,
        content=NEUTRAL_CONTENT,
        status=PostStatus.PUBLISHED,
        published_at=_at(40),
        categories=[alpha],
    )
    second_ordinary = await factories.create_post(
        session,
        author=second,
        title="Ordinary Headline By The Second Author",
        excerpt=NEUTRAL_EXCERPT,
        content=NEUTRAL_CONTENT,
        status=PostStatus.PUBLISHED,
        published_at=_at(41),
    )

    # Recency order, newest first: the filler rows sit at minutes 100+ and therefore lead, and
    # the seven significant rows trail in reverse creation order. Reversing the two ranges rather
    # than sorting datetimes keeps the expected order derived from the schedule above, so a
    # mistake in the schedule shows up as a failing assertion instead of being sorted away.
    published_primary = tuple(reversed(filler)) + tuple(
        str(post.id)
        for post in (
            term_alpha_primary,
            two_category,
            typo,
            multiword,
            content_hit,
            excerpt_hit,
            title_hit,
        )
    )

    return FeedCorpus(
        primary_author=primary,
        second_author=second,
        alpha=alpha,
        beta=beta,
        published_primary=published_primary,
        published_second=(str(second_ordinary.id), str(term_alpha_second.id)),
        hidden=frozenset(
            {str(draft_term_alpha.id), str(draft_plain.id), str(archived_term_alpha.id)}
        ),
        title_hit=str(title_hit.id),
        excerpt_hit=str(excerpt_hit.id),
        content_hit=str(content_hit.id),
        multiword=str(multiword.id),
        typo=str(typo.id),
        two_category=str(two_category.id),
        term_alpha_primary=str(term_alpha_primary.id),
        term_alpha_second=str(term_alpha_second.id),
    )


@pytest_asyncio.fixture(loop_scope="session")
async def corpus(db_session: AsyncSession) -> FeedCorpus:
    """Build the deterministic feed corpus for one test.

    Function scoped on purpose. ``db_session`` opens a transaction and rolls it back when the
    test ends, so a wider scope would hand the second test a corpus whose rows no longer exist.
    Paying for it per test is what makes this module produce the same result run in isolation,
    run three times over, and run in any position relative to its siblings.

    Args:
        db_session: The transactional session the HTTP ``client`` fixture shares.

    Returns:
        The corpus, with every identifier and slug already resolved.
    """
    return await _build_feed_corpus(db_session)


# ---------------------------------------------------------------------------------------
# Request and envelope helpers
# ---------------------------------------------------------------------------------------


async def _feed(client: AsyncClient, **params: QueryValue) -> dict[str, Any]:
    """Request the feed, assert the envelope's shape, and return the parsed body.

    Every successful assertion in this module goes through here, which is how AAP §0.10.1 #4's
    "one page envelope for collections" is enforced on *every* response rather than on the one or
    two a shape test happens to look at: the five members are checked before the caller sees the
    body, so a route that dropped ``pages`` from one code path could not slip past a test that
    was only reading ``items``.

    Args:
        client: The in-process HTTP client. Anonymous unless the caller passes an authenticated
            one, which matters for the draft-confidentiality tests.
        **params: Query parameters, forwarded verbatim so a test reads like the URL it means.

    Returns:
        The decoded page envelope.
    """
    response = await client.get(FEED_PATH, params=params)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    assert set(body) == PAGE_MEMBERS, (
        f"the collection envelope must carry exactly {sorted(PAGE_MEMBERS)}, got {sorted(body)}"
    )
    assert body["pages"] == math.ceil(body["total"] / body["page_size"]), (
        "pages must be ceil(total / page_size): "
        f"total={body['total']} page_size={body['page_size']} pages={body['pages']}"
    )
    return body


def _ids(body: dict[str, Any]) -> list[str]:
    """Return the identifiers on a page, in the order the endpoint returned them.

    Args:
        body: A decoded page envelope.

    Returns:
        The ``id`` of each element, order preserved because ordering is half of what this module
        asserts.
    """
    return [element["id"] for element in body["items"]]


async def _all_pages(
    client: AsyncClient,
    *,
    page_size: int,
    **params: QueryValue,
) -> list[list[str]]:
    """Walk every page of a filtered feed and return the identifiers page by page.

    Args:
        client: The in-process HTTP client.
        page_size: Rows per page, applied to every request.
        **params: The filter to walk, forwarded verbatim.

    Returns:
        One list of identifiers per page, in page order. The page count comes from the first
        response's ``pages``, so the walk covers exactly what the endpoint claims exists.
    """
    first = await _feed(client, page_size=page_size, page=MIN_PAGE, **params)
    pages = [_ids(first)]
    for page in range(MIN_PAGE + 1, first["pages"] + 1):
        pages.append(_ids(await _feed(client, page_size=page_size, page=page, **params)))
    return pages


async def _validation_failure(client: AsyncClient, **params: QueryValue) -> dict[str, Any]:
    """Request the feed expecting ``422``, and return the problem document.

    ``PageParams`` states its bounds as FastAPI query metadata, so an out-of-range ``page`` or
    ``page_size`` is refused at the request boundary rather than clamped. This helper asserts the
    refusal is the project's uniform problem document with a populated ``errors`` list - the
    contract ``app.core.exceptions`` declares - rather than FastAPI's default body.

    Args:
        client: The in-process HTTP client.
        **params: The query parameters expected to fail validation.

    Returns:
        The decoded problem document.
    """
    response = await client.get(FEED_PATH, params=params)
    assert response.status_code == 422, response.text
    problem: dict[str, Any] = response.json()
    assert problem["status"] == 422
    assert problem["type"] == "/errors/validation-error"
    assert problem["errors"], "a validation failure must report which field failed"
    return problem


# ---------------------------------------------------------------------------------------
# The envelope and the window
# ---------------------------------------------------------------------------------------


class TestFeedEnvelopeAndWindow:
    """AAP §0.9.4.4 "Feed composition": the envelope, the arithmetic and the page boundaries.

    Every assertion here is scoped with ``?author=`` to this module's own primary author, because
    ``total`` for the bare path describes whatever the database happens to hold and ``total`` for
    a scoped path describes the corpus. The one deliberate exception is
    :meth:`test_the_bare_feed_reports_at_least_this_corpus`, which asserts a containment rather
    than an equality and is therefore true either way.
    """

    async def test_the_feed_answers_the_uniform_page_envelope(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.10.1 #4: the collection envelope carries exactly its five declared members.

        The page size is raised to the permitted maximum so that the whole corpus lands on one
        page, which lets the identifier set be asserted as an equality here. The window itself -
        the default size, the boundaries between pages, the short final page - is the subject of
        the tests that follow.

        The five member names are pinned literally as well as derived. :func:`_feed` checks every
        response against ``Page``'s own fields, which catches a route that drops or invents a key;
        this assertion catches the other direction, a change to the envelope *model* that every
        derived check would otherwise follow in silence. The envelope is the contract three list
        surfaces share - feed, profile posts, admin tables - so renaming a member breaks the
        client's single pagination component everywhere at once.
        """
        assert {"items", "total", "page", "page_size", "pages"} == PAGE_MEMBERS, (
            f"the shared page envelope must stay exactly five members, got {sorted(PAGE_MEMBERS)}"
        )

        body = await _feed(client, author=corpus.primary_username, page_size=MAX_PAGE_SIZE)

        assert body["total"] == len(corpus.published_primary)
        assert body["page"] == MIN_PAGE
        assert body["pages"] == 1
        assert set(_ids(body)) == set(corpus.published_primary)

    async def test_the_window_echoes_the_page_and_page_size_it_was_asked_for(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.4: the envelope reports the window requested, not one of its own."""
        body = await _feed(
            client,
            author=corpus.primary_username,
            page=2,
            page_size=PAGINATION_PAGE_SIZE,
        )

        assert body["page"] == 2
        assert body["page_size"] == PAGINATION_PAGE_SIZE
        assert len(body["items"]) == PAGINATION_PAGE_SIZE

    async def test_a_feed_element_is_a_post_summary_and_carries_no_body_content(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.6.2: the feed projects ``PostSummary``, which omits ``content`` by design."""
        body = await _feed(client, author=corpus.primary_username, page_size=EXACT_PAGE_SIZE)

        assert body["items"], "the corpus guarantees a non-empty first page"
        for element in body["items"]:
            assert set(element) == SUMMARY_MEMBERS
            # Stated separately from the set comparison, because this is the decision rather
            # than an accident of it: a feed card renders a title and an excerpt, so shipping
            # every article body would multiply the payload of the most requested endpoint in
            # the product for nothing. `PostDetail` is where `content` belongs.
            assert "content" not in element
            assert element["status"] == PostStatus.PUBLISHED
            assert element["author"]["username"] == corpus.primary_username
        assert "content" in PostDetail.model_fields, (
            "the omission above is only meaningful while the detail projection still carries it"
        )

    @pytest.mark.parametrize(
        "page_size",
        [EXACT_PAGE_SIZE, 7, PAGINATION_PAGE_SIZE, MAX_PAGE_SIZE],
    )
    async def test_pages_is_the_exact_ceiling_of_total_over_page_size(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
        page_size: int,
    ) -> None:
        """AAP §0.10.1 #4: ``pages`` is exact integer arithmetic, not an approximation.

        The four sizes are chosen to cover every rounding case the corpus can produce: one that
        divides its twenty-five rows evenly, two that leave a remainder, and one large enough
        that the whole result is a single page.
        """
        expected_total = len(corpus.published_primary)

        body = await _feed(client, author=corpus.primary_username, page_size=page_size)

        assert body["total"] == expected_total
        assert body["pages"] == math.ceil(expected_total / page_size)
        assert len(body["items"]) == min(page_size, expected_total)

    async def test_the_final_page_carries_exactly_the_remainder(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.4: a short last page is correct, and its length is the remainder.

        :data:`PAGINATION_PAGE_SIZE` deliberately does not divide the corpus, so the last page
        holds one row. A page size that divided evenly would never exercise this at all.
        """
        total = len(corpus.published_primary)
        expected_pages = math.ceil(total / PAGINATION_PAGE_SIZE)
        expected_remainder = total - (expected_pages - 1) * PAGINATION_PAGE_SIZE

        body = await _feed(
            client,
            author=corpus.primary_username,
            page=expected_pages,
            page_size=PAGINATION_PAGE_SIZE,
        )

        assert body["pages"] == expected_pages
        assert len(body["items"]) == expected_remainder
        assert expected_remainder < PAGINATION_PAGE_SIZE, (
            "this test is only meaningful while the page size leaves a remainder"
        )

    async def test_successive_pages_are_disjoint_and_together_cover_the_result_exactly(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.4: "page two returns a disjoint set from page one".

        Three properties are asserted together because they are three faces of one requirement.
        Pages two and three must not intersect page one; no identifier may appear twice anywhere
        in the walk; and the concatenation must equal the whole expected result *in order*. The
        third is what proves the ordering is **total** rather than merely sorted: the repository
        ends every ``ORDER BY`` with ``posts.id DESC`` precisely because two rows sharing a
        publication instant would otherwise be free to appear on both page one and page two while
        a third appeared on neither, which is the classic overlapping-pagination defect.
        """
        pages = await _all_pages(
            client,
            page_size=PAGINATION_PAGE_SIZE,
            author=corpus.primary_username,
        )

        assert len(pages) == math.ceil(len(corpus.published_primary) / PAGINATION_PAGE_SIZE)
        assert not set(pages[0]) & set(pages[1]), "page two must be disjoint from page one"
        assert not set(pages[1]) & set(pages[2]), "page three must be disjoint from page two"
        assert not set(pages[0]) & set(pages[2]), "page three must be disjoint from page one"

        walked = [identifier for page in pages for identifier in page]
        assert len(walked) == len(set(walked)), "no post may be returned by two pages"
        assert walked == list(corpus.published_primary)

    async def test_a_page_beyond_the_last_answers_an_empty_list_rather_than_an_error(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.4: "an out-of-range page returns an empty item list rather than an error".

        Deliberately a ``200`` and deliberately not a ``404`` or a ``422``. The requested page is
        echoed back beside the real ``total`` and ``pages``, which is how a client detects it has
        run off the end - and it is what keeps a linkable, crawlable page URL from breaking when
        the corpus behind it shrinks.
        """
        body = await _feed(client, author=corpus.primary_username, page=999)

        assert body["items"] == []
        assert body["page"] == 999
        assert body["total"] == len(corpus.published_primary)
        assert body["pages"] == math.ceil(body["total"] / body["page_size"])
        assert body["pages"] < 999

    @pytest.mark.parametrize(
        ("params", "field"),
        [
            ({"page": MIN_PAGE - 1}, "page"),
            ({"page": -1}, "page"),
            ({"page_size": MIN_PAGE_SIZE - 1}, "page_size"),
            ({"page_size": MAX_PAGE_SIZE + 1}, "page_size"),
        ],
    )
    async def test_a_window_outside_its_bounds_is_refused_with_a_problem_document(
        self,
        client: AsyncClient,
        params: dict[str, int],
        field: str,
    ) -> None:
        """AAP §0.10.1 #4: ``PageParams`` bounds are enforced at the boundary, never as a 500.

        ``page`` has a floor and no ceiling, and ``page_size`` has both; the bounds are declared
        as query metadata, so an out-of-range value is refused here rather than silently clamped.
        Clamping would answer a different question under the page number the caller asked for.
        The complementary case - a page *inside* its bounds but past the end of the data - is a
        ``200`` and is asserted immediately above; the arithmetic itself is covered at the unit
        level by ``backend/tests/unit/test_pagination.py``.
        """
        problem = await _validation_failure(client, **params)

        assert [entry["field"] for entry in problem["errors"]] == [field]

    async def test_the_largest_permitted_page_size_is_accepted(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.10.1 #4: the ceiling is inclusive - ``MAX_PAGE_SIZE`` itself is a ``200``."""
        body = await _feed(client, author=corpus.primary_username, page_size=MAX_PAGE_SIZE)

        assert body["page_size"] == MAX_PAGE_SIZE
        assert body["total"] == len(corpus.published_primary)

    async def test_the_bare_feed_reports_at_least_this_corpus(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.4: the unfiltered path works, asserted as containment rather than equality.

        ``posts`` is not empty when this suite runs - a shared test database may carry committed
        demonstration rows, and revision ``0003`` commits reference categories - so an exact
        ``total`` here would be an assertion about the environment rather than about the code.
        Nor can this corpus be assumed to occupy the first page: its publication instants are
        fixed in 2024 so that they are reproducible, and committed demonstration rows may well be
        newer. The honest claims are that the bare path answers the same envelope, that it counts
        at least this corpus's published posts, and that nothing hidden appears on the page it
        returns. The exhaustive form of the last claim is asserted against scoped queries in
        :class:`TestStatusScoping`, where the expected set can be stated exactly.
        """
        body = await _feed(client, page_size=MAX_PAGE_SIZE, sort="recent")
        expected = set(corpus.published_primary) | set(corpus.published_second)

        assert body["total"] >= len(expected)
        assert body["pages"] >= 1
        assert not corpus.hidden & set(_ids(body))
        assert all(element["status"] == PostStatus.PUBLISHED for element in body["items"])


# ---------------------------------------------------------------------------------------
# Free-text search and relevance
# ---------------------------------------------------------------------------------------


class TestFreeTextSearch:
    """AAP §0.9.4.4: "a search term orders by relevance", and everything that implies.

    The repository applies a term as one disjunction - ranked full-text matching over the
    generated ``search_vector``, OR trigram similarity on the title as a typo-tolerant fallback -
    so both halves are exercised here, as is the ``websearch_to_tsquery`` grammar the primary half
    is compiled with.
    """

    async def test_a_term_returns_exactly_the_posts_that_match_it(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.4: a search narrows the feed, and ``total`` is the narrowed count."""
        body = await _feed(client, author=corpus.primary_username, q=SEARCH_TERM)

        assert set(_ids(body)) == corpus.term_matches_primary
        assert body["total"] == len(corpus.term_matches_primary)
        assert body["total"] < len(corpus.published_primary), (
            "the term must narrow the result, or this test is asserting nothing"
        )

    async def test_relevance_ranks_a_title_match_above_an_excerpt_or_body_match(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.6.3: the generated vector is weighted, and the weighting is observable.

        Revision ``0002`` builds ``search_vector`` as ``setweight(title, 'A') ||
        setweight(excerpt, 'B') || setweight(content, 'C')``, and PostgreSQL's default weights
        make ``'A'`` worth more than ``'B'`` worth more than ``'C'``. So a post carrying the term
        in its headline must outrank one carrying it only in a summary, which must outrank one
        carrying it only in the body.

        The three posts are published in *ascending* order of expected rank, so recency ordering
        would return them backwards. A ranking that had quietly degraded to recency therefore
        fails this test rather than passing it by coincidence.
        """
        order = _ids(await _feed(client, author=corpus.primary_username, q=SEARCH_TERM))

        assert order.index(corpus.title_hit) < order.index(corpus.excerpt_hit)
        assert order.index(corpus.excerpt_hit) < order.index(corpus.content_hit)
        # The corpus holds a second title-weighted match. Both title matches must outrank the
        # excerpt match; which of the two leads is settled by the trigram tiebreaker and is not
        # a contract, so it is deliberately not asserted.
        assert order.index(corpus.term_alpha_primary) < order.index(corpus.excerpt_hit)

    async def test_relevance_may_be_requested_explicitly(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.4: ``sort=relevance`` ranks exactly as the default does for a search."""
        default_order = _ids(await _feed(client, author=corpus.primary_username, q=SEARCH_TERM))
        explicit_order = _ids(
            await _feed(
                client,
                author=corpus.primary_username,
                q=SEARCH_TERM,
                sort="relevance",
            )
        )

        assert explicit_order == default_order

    async def test_several_bare_words_are_conjoined(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.4: ``websearch_to_tsquery`` ANDs bare words, so every word must match.

        Asserted in both directions: both tokens together return the one post that carries both,
        and one of them beside a token planted nowhere returns nothing. The second half is what
        distinguishes a conjunction from a disjunction, which no single positive result can.
        """
        first, second = PHRASE_TOKENS

        both = await _feed(client, author=corpus.primary_username, q=f"{first} {second}")
        one_absent = await _feed(
            client,
            author=corpus.primary_username,
            q=f"{first} {ABSENT_TOKEN}",
        )

        assert _ids(both) == [corpus.multiword]
        assert both["total"] == 1
        assert one_absent["items"] == []
        assert one_absent["total"] == 0

    async def test_the_or_keyword_widens_a_search(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.4: ``websearch_to_tsquery`` honours the literal word ``or`` as a disjunction.

        This is the reason the repository compiles terms with ``websearch_to_tsquery`` rather than
        ``plainto_tsquery``, which would AND everything and understand no operators, or
        ``to_tsquery``, which raises a syntax error on ordinary punctuation and would turn a
        reader's search box into a ``500``.
        """
        body = await _feed(
            client,
            author=corpus.primary_username,
            q=f"{PHRASE_TOKENS[0]} or {SEARCH_TERM}",
        )

        assert set(_ids(body)) == corpus.term_matches_primary | {corpus.multiword}

    async def test_a_quoted_phrase_is_searched_as_a_phrase(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.4: a quoted term is a phrase search, the third grammar the parser accepts."""
        first, second = PHRASE_TOKENS

        body = await _feed(client, author=corpus.primary_username, q=f'"{first} and {second}"')

        assert _ids(body) == [corpus.multiword]

    async def test_a_misspelt_title_still_finds_its_post(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.6.3.1: the ``pg_trgm`` fallback makes the search typo-tolerant.

        :data:`TYPO_TERM` is a transposition of :data:`TYPO_TITLE` and shares no lexeme with it,
        so the full-text half of the disjunction cannot match it at all. A hit therefore proves
        the ``title % term`` half is live and OR-ed into the same predicate. The margin is not
        marginal: ``similarity`` scores this pair at ``0.6`` against ``pg_trgm``'s default
        threshold of ``0.3``, measured directly against PostgreSQL 18.4.

        The title is one word for that reason. ``%`` compares whole strings rather than words, so
        the same misspelling weighed against a long headline would fall under the threshold - and
        a test that then failed would be reporting the shape of its own fixture, not a defect.
        """
        body = await _feed(client, author=corpus.primary_username, q=TYPO_TERM)

        assert _ids(body) == [corpus.typo]
        assert body["total"] == 1

    async def test_a_term_that_matches_nothing_answers_an_empty_envelope(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP §0.9.4.4: no match is an empty page, not an error - and ``pages`` is ``0``.

        Needs no corpus: the token is planted nowhere, so the result is empty whatever else the
        database holds. ``build_page`` yields ``pages == 0`` for an empty result rather than a
        vacuous first page, which is the value asserted here.
        """
        body = await _feed(client, q=ABSENT_TOKEN)

        assert body["items"] == []
        assert body["total"] == 0
        assert body["pages"] == 0
        assert body["page"] == MIN_PAGE

    async def test_a_blank_term_browses_rather_than_searching(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.4: a whitespace-only ``q`` narrows nothing - an empty box is not a search.

        A query string spells an unset parameter as the empty string, and
        ``websearch_to_tsquery`` on whitespace yields a ``tsquery`` that matches nothing - so
        without this fold an accidental space in a URL would empty the feed.
        """
        body = await _feed(client, author=corpus.primary_username, q="   ")

        assert body["total"] == len(corpus.published_primary)

    async def test_punctuation_and_sql_shaped_input_are_searched_not_executed(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.10.1: the search path is parameterised, so hostile input is only ever text.

        Each candidate is answered with a well-formed ``200`` envelope - never a ``500``, never a
        parser error - because the term reaches ``websearch_to_tsquery`` as a **bound parameter**
        and nothing in the repository concatenates caller input into SQL. The same is true of the
        trigram half, whose right operand is bound rather than interpolated.

        The proof that nothing was *executed* is the assertion afterwards: the relation is still
        there and still holds exactly this corpus. A statement that had escaped its parameter
        would have dropped the table, emptied it, or widened the result, and all three show up
        here. Asserting an empty result per term would be weaker as well as more brittle - it
        would depend on which lexemes the surrounding data happens to contain.
        """
        hostile = (
            "robert'); DROP TABLE posts;--",
            "' OR 1=1 --",
            "%_\\",
            "-- comment",
            "*&^%$#@!",
            "'; SELECT pg_sleep(0); --",
            "\\'; UPDATE posts SET status = 'PUBLISHED'; --",
        )

        for term in hostile:
            # `_feed` asserts the 200 and the envelope's five members for every one of these.
            await _feed(client, q=term)

        survivors = await _feed(client, author=corpus.primary_username, page_size=MAX_PAGE_SIZE)
        assert survivors["total"] == len(corpus.published_primary)
        assert set(_ids(survivors)) == set(corpus.published_primary)
        assert not corpus.hidden & set(_ids(survivors))

    async def test_a_term_longer_than_the_declared_maximum_is_refused(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP §0.10.1 #4: a term over the declared maximum is a ``422``, never a truncation.

        Truncating would return results for a query the caller did not make, so the bound is
        declared on the schema and enforced at the boundary. The boundary itself is inclusive:
        a term of exactly the maximum length is accepted.
        """
        at_limit = "z" * MAX_SEARCH_TERM_LENGTH
        over_limit = "z" * (MAX_SEARCH_TERM_LENGTH + 1)

        accepted = await _feed(client, q=at_limit)
        problem = await _validation_failure(client, q=over_limit)

        assert accepted["total"] == 0
        assert [entry["field"] for entry in problem["errors"]] == ["q"]

    async def test_a_search_reports_the_filtered_page_count_not_the_global_one(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.4: search and windowing compose - ``total`` and ``pages`` are the filtered
        counts, and paging a search still yields disjoint pages covering exactly the matches."""
        matches = len(corpus.term_matches_primary)
        page_size = 2
        assert matches > page_size, "the term must span more than one page at this size"

        pages = await _all_pages(
            client,
            page_size=page_size,
            author=corpus.primary_username,
            q=SEARCH_TERM,
        )
        first = await _feed(
            client,
            author=corpus.primary_username,
            q=SEARCH_TERM,
            page_size=page_size,
        )

        assert first["total"] == matches
        assert first["pages"] == math.ceil(matches / page_size)
        assert first["total"] < len(corpus.published_primary)
        walked = [identifier for page in pages for identifier in page]
        assert len(walked) == len(set(walked))
        assert set(walked) == corpus.term_matches_primary


# ---------------------------------------------------------------------------------------
# The category filter
# ---------------------------------------------------------------------------------------


class TestCategoryFilter:
    """AAP §0.9.4.4: "a category filter restricts results", through the association relation.

    ``?category=`` takes a **slug**, joins ``post_categories`` and then ``categories``, and
    compares against a ``CITEXT`` column - so the match is case-insensitive at the database level
    and nothing is lower-cased in Python. Because the join can multiply rows in principle, the
    count statement is ``count(DISTINCT posts.id)``, and the post filed under two categories below
    is what holds that guarantee to account.
    """

    async def test_a_slug_restricts_the_feed_to_the_posts_filed_under_it(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.4: the filter narrows, and every element really carries the category."""
        body = await _feed(client, category=corpus.alpha_slug)

        assert set(_ids(body)) == corpus.alpha_published
        assert body["total"] == len(corpus.alpha_published)
        for element in body["items"]:
            slugs = {category["slug"] for category in element["categories"]}
            assert corpus.alpha_slug in slugs

    async def test_a_slug_matches_case_insensitively(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.6.3.1: ``categories.slug`` is ``CITEXT``, so an upper-cased slug filters alike.

        Worth asserting rather than assuming: a ``lower()`` applied to either side of that
        comparison would make the unique ``citext`` index on the column unusable *and* would
        reimplement in Python a guarantee the column type already provides, so this test is what
        would notice such a change.
        """
        lower = await _feed(client, category=corpus.alpha_slug)
        upper = await _feed(client, category=corpus.alpha_slug.upper())

        assert upper["total"] == lower["total"]
        assert _ids(upper) == _ids(lower)

    async def test_a_post_filed_under_two_categories_appears_under_both_and_is_counted_once(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.4: the join-inflation guard - a DISTINCT count keeps ``total`` honest.

        The post is genuinely filed twice, so it must be reachable under either slug - and it must
        still be one row. Three counts are checked: once under each slug, and once in the
        unfiltered-by-category listing of its author, where a naive count over the join would have
        reported the corpus one row too large. The composite primary key on ``post_categories``
        makes duplicate filing impossible, so a single-slug filter cannot in fact multiply rows
        today; the ``DISTINCT`` makes ``total`` correct by construction rather than by relying on
        that, and this test is what keeps both true together.
        """
        under_alpha = await _feed(client, category=corpus.alpha_slug)
        under_beta = await _feed(client, category=corpus.beta_slug)
        by_author = await _feed(client, author=corpus.primary_username, page_size=MAX_PAGE_SIZE)

        assert corpus.two_category in set(_ids(under_alpha))
        assert _ids(under_beta) == [corpus.two_category]
        assert under_beta["total"] == 1
        assert _ids(under_alpha).count(corpus.two_category) == 1
        assert _ids(by_author).count(corpus.two_category) == 1
        assert by_author["total"] == len(corpus.published_primary)

    async def test_an_unknown_slug_answers_an_empty_page_rather_than_an_error(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP §0.9.4.4: a category matching nothing is an empty page, deliberately not a ``404``.

        The asymmetry with ``?author=`` is intentional and is documented on the route: a category
        slug that matches no post is indistinguishable from a category with no posts, so there is
        nothing to report; a username that names no account is a mistyped filter, and answering it
        with an empty page would hide the mistake. Hence empty here, ``404`` there.
        """
        body = await _feed(client, category="no-such-category-in-this-corpus")

        assert body["items"] == []
        assert body["total"] == 0
        assert body["pages"] == 0

    async def test_a_category_and_a_term_intersect_rather_than_union(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.4: every parameter narrows independently, so two of them compose as ∧.

        The union would be strictly larger than either side, so asserting the intersection is
        smaller than both is what distinguishes composition from accumulation.
        """
        by_category = await _feed(client, category=corpus.alpha_slug)
        by_term = await _feed(client, author=corpus.primary_username, q=SEARCH_TERM)
        both = await _feed(client, category=corpus.alpha_slug, q=SEARCH_TERM)

        expected = {corpus.term_alpha_primary, corpus.term_alpha_second}
        assert set(_ids(both)) == expected
        assert both["total"] == len(expected)
        assert both["total"] < by_category["total"] + by_term["total"]
        assert set(_ids(both)) <= set(_ids(by_category))


# ---------------------------------------------------------------------------------------
# The author filter
# ---------------------------------------------------------------------------------------


class TestAuthorFilter:
    """AAP §0.9.4.4 and §0.5: ``?author=`` takes a **username**, not an identifier.

    The wire speaks usernames and the query speaks identifiers, so the service resolves one to the
    other with a single indexed ``citext`` probe - which is also where the ``404`` for an unknown
    author is raised, because the repository is given an identifier or nothing and has no way to
    tell "no such author" from "this author has published nothing".
    """

    async def test_a_username_restricts_the_feed_to_that_author(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.4: the author filter narrows, and every byline agrees."""
        body = await _feed(client, author=corpus.second_username, page_size=MAX_PAGE_SIZE)

        assert set(_ids(body)) == set(corpus.published_second)
        assert body["total"] == len(corpus.published_second)
        for element in body["items"]:
            assert element["author"]["username"] == corpus.second_username
            assert element["author"]["id"] == str(corpus.second_author.id)
        assert not set(_ids(body)) & set(corpus.published_primary)

    async def test_a_username_matches_case_insensitively(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.6.3.1: ``users.username`` is ``CITEXT``, so the filter ignores case."""
        exact = await _feed(client, author=corpus.primary_username)
        shouted = await _feed(client, author=corpus.primary_username.upper())

        assert shouted["total"] == exact["total"]

    async def test_an_unknown_username_is_reported_rather_than_answered_empty(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP §0.9.4.3: a mistyped author is a ``404`` problem document, not silence.

        The alternative - an empty page - would make "you spelled the handle wrong" and "this
        author has published nothing" the same response, and a client could never tell a broken
        link from an empty profile.
        """
        response = await client.get(FEED_PATH, params={"author": "no-such-author-in-this-corpus"})

        assert response.status_code == 404, response.text
        problem = response.json()
        assert problem["type"] == "/errors/not-found"
        assert problem["status"] == 404
        assert problem["instance"] == FEED_PATH
        assert "errors" not in problem, "only a validation failure carries per-field errors"

    async def test_a_term_a_category_and_an_author_compose_as_one_intersection(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.4: the three-way composition, which is this module's whole subject.

        Each parameter is shown to narrow what the previous two left: the term alone spans both
        authors, the term with the category still spans both, and adding the author reduces it to
        one row. A filter that was being ignored - or applied as a union - would fail to shrink at
        one of those steps, which is precisely what the chain of strict inequalities catches.
        """
        term_only = await _feed(client, q=SEARCH_TERM, page_size=MAX_PAGE_SIZE)
        term_and_category = await _feed(client, q=SEARCH_TERM, category=corpus.alpha_slug)
        all_three = await _feed(
            client,
            q=SEARCH_TERM,
            category=corpus.alpha_slug,
            author=corpus.second_username,
        )

        assert _ids(all_three) == [corpus.term_alpha_second]
        assert all_three["total"] == 1
        assert all_three["pages"] == 1
        assert all_three["total"] < term_and_category["total"] < term_only["total"]


# ---------------------------------------------------------------------------------------
# Ordering
# ---------------------------------------------------------------------------------------


class TestSortOrdering:
    """The two orderings, the default that is neither of them, and the closed set of values."""

    async def test_recent_orders_by_publication_instant_descending(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.6.3.2: ``sort=recent`` is the ordering ``ix_posts_status_published_at`` serves.

        Both faces of it are asserted: the sequence of publication instants is non-increasing, and
        the identifiers arrive in the exact order the corpus scheduled them. The second is the
        stronger claim - a stable sort has to agree on every position, not merely on the direction
        of travel.
        """
        body = await _feed(
            client,
            author=corpus.primary_username,
            sort="recent",
            page_size=MAX_PAGE_SIZE,
        )

        instants = [element["published_at"] for element in body["items"]]
        assert all(instant is not None for instant in instants)
        # ISO-8601 with a fixed offset sorts lexicographically in the same order it sorts
        # chronologically, and every value here is written by PostgreSQL from a TIMESTAMPTZ.
        assert instants == sorted(instants, reverse=True)
        assert _ids(body) == list(corpus.published_primary)

    async def test_omitting_sort_ranks_a_search_and_dates_a_browse(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.4: omitting ``sort`` is not sending ``recent`` - the default follows ``q``.

        Asking a question means asking for the best answer, so a request carrying ``q`` and no
        ``sort`` is ranked by relevance, while a request carrying neither is ordered by recency -
        :data:`DEFAULT_POST_SORT`. The route forwards an absent ``sort`` as ``None`` for exactly
        this reason: substituting a value at that boundary would default every unsorted search to
        recency and the ranked query would never run at all.
        """
        assert DEFAULT_POST_SORT == "recent", "this test encodes the repository's browse default"

        searched = _ids(await _feed(client, author=corpus.primary_username, q=SEARCH_TERM))
        searched_by_date = _ids(
            await _feed(client, author=corpus.primary_username, q=SEARCH_TERM, sort="recent")
        )
        browsed = _ids(await _feed(client, author=corpus.primary_username, page_size=MAX_PAGE_SIZE))
        browsed_by_date = _ids(
            await _feed(
                client,
                author=corpus.primary_username,
                sort=DEFAULT_POST_SORT,
                page_size=MAX_PAGE_SIZE,
            )
        )

        assert browsed == browsed_by_date
        assert searched != searched_by_date, (
            "a search with no sort must be ranked, not merely dated"
        )
        assert searched[0] in {corpus.title_hit, corpus.term_alpha_primary}
        assert searched_by_date == sorted(
            searched_by_date,
            key=list(corpus.published_primary).index,
        )

    async def test_relevance_without_a_term_degrades_to_recency(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.4: ``sort=relevance`` with an empty search box is answered, not refused.

        There is nothing to rank against, so ``ts_rank`` would be constant and the ordering would
        collapse onto the tiebreaker alone. The repository therefore branches on the presence of a
        term rather than on the requested sort, and the degradation is silent on purpose: a listing
        is the wrong place to reject a request with one obvious reading.
        """
        ranked = await _feed(
            client,
            author=corpus.primary_username,
            sort="relevance",
            page_size=MAX_PAGE_SIZE,
        )
        dated = await _feed(
            client,
            author=corpus.primary_username,
            sort="recent",
            page_size=MAX_PAGE_SIZE,
        )

        assert _ids(ranked) == _ids(dated)

    async def test_an_unrecognised_sort_is_refused_rather_than_ignored(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP §0.10.1 #4: ``sort`` is a closed set of two values; anything else is a ``422``.

        The failure mode this rules out is the quiet one. Were the parameter a free-form string,
        ``?sort=popular`` would be accepted and answered in publication order, and the caller
        would never learn that the ordering they asked for does not exist.
        """
        for value in ("popular", "RECENT", "relevancy", "published_at", ""):
            problem = await _validation_failure(client, sort=value)
            assert [entry["field"] for entry in problem["errors"]] == ["sort"]
            assert problem["errors"][0]["type"] == "literal_error"

    def test_the_wire_sort_values_match_the_repository_exactly(self) -> None:
        """AAP §0.10.1 #4: the route's ``sort`` alias mirrors ``PostSort`` value for value.

        Two aliases spell the same closed set - :data:`~app.schemas.post.PostSortOption` on the
        wire and :data:`~app.repositories.post_repository.PostSort` in the data layer - because the
        wire vocabulary belongs with the wire description and the query vocabulary with the query.
        They are separate declarations, so this is the assertion that keeps them from drifting: a
        member added to one and not the other would be accepted by the route and unhandled by the
        repository, or handled and unreachable.

        Synchronous, and needs neither a client nor a database: it is a statement about two type
        aliases.
        """
        assert typing.get_args(PostSortOption) == typing.get_args(PostSort)
        assert set(typing.get_args(PostSortOption)) == {"recent", "relevance"}
        assert DEFAULT_POST_SORT in typing.get_args(PostSortOption)


# ---------------------------------------------------------------------------------------
# Draft confidentiality under every filter path
# ---------------------------------------------------------------------------------------


class TestStatusScoping:
    """AAP §0.9.4.4 "Draft confidentiality": no filter path may surface an unpublished post.

    Which lifecycle states are in scope is decided once, in ``PostService.list_feed``, and passed
    into the repository as an argument - the repository "never decides who may see a draft". So a
    leak would be a service defect, and testing every filter path is what localises it there:
    search, category, author and all three together each reach the rows by a different access
    path, and each is checked separately.

    The public feed's scope is a **constant**: ``PUBLIC_POST_STATUSES``, for every caller. The
    author-scoped widening lives on the private ``?mine=true`` mode, which is a different mode of
    the same operation and is the subject of ``test_posts_api.py``'s ``TestAuthorWorkspace``.
    """

    @pytest.mark.parametrize(
        "narrowing",
        [
            "unfiltered",
            "search",
            "category",
            "author",
            "three-way",
        ],
    )
    async def test_no_filter_path_surfaces_a_draft_or_an_archived_post(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
        narrowing: str,
    ) -> None:
        """AAP §0.9.4.4: an anonymous caller sees published posts and nothing else, on every path.

        The corpus plants a draft **and** an archived post that both carry the search term and are
        both filed under the alpha category, so each narrowing below would surface one of them if
        the status scope were being lost at that point rather than applied once.
        """
        queries: dict[str, dict[str, QueryValue]] = {
            "unfiltered": {"page_size": MAX_PAGE_SIZE},
            "search": {"q": SEARCH_TERM, "page_size": MAX_PAGE_SIZE},
            "category": {"category": corpus.alpha_slug, "page_size": MAX_PAGE_SIZE},
            "author": {"author": corpus.primary_username, "page_size": MAX_PAGE_SIZE},
            "three-way": {
                "q": SEARCH_TERM,
                "category": corpus.alpha_slug,
                "author": corpus.primary_username,
            },
        }

        body = await _feed(client, **queries[narrowing])

        assert not corpus.hidden & set(_ids(body))
        assert all(element["status"] == PostStatus.PUBLISHED for element in body["items"])

    async def test_a_caller_supplied_scope_parameter_changes_nothing(
        self,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.4: the public feed's status scope is a constant, not a wire parameter.

        None of the spellings below is a parameter of this route, so a caller who invents one is
        simply ignored and cannot widen the scope. Asserted because "undeclared parameters are
        ignored" is the behaviour that keeps privilege escalation off the query string.

        ``?status=`` is deliberately absent from this list. It *is* declared - it narrows the
        private ``?mine=true`` workspace - and on the public feed it is **refused** with a 422
        rather than ignored, so its behaviour is pinned by
        ``test_posts_api.py::TestAuthorWorkspace::test_status_is_refused_on_the_public_feed``.
        """
        for attempt in (
            {"statuses": "DRAFT,PUBLISHED,ARCHIVED"},
            {"include_drafts": "true"},
            {"visibility": "all"},
        ):
            body = await _feed(
                client,
                author=corpus.primary_username,
                page_size=MAX_PAGE_SIZE,
                **attempt,
            )
            assert body["total"] == len(corpus.published_primary)
            assert not corpus.hidden & set(_ids(body))

    async def test_an_author_reads_their_drafts_only_through_the_workspace_mode(
        self,
        author_client: AsyncClient,
        client: AsyncClient,
        db_session: AsyncSession,
    ) -> None:
        """AAP §0.9.4.4: the complement - the widening is requested, and it is the only way in.

        Three questions, one corpus, and the contrast between them is the whole rule. Asking the
        *public* feed for one's own posts (``?author=<me>``, authenticated) returns published posts
        only, exactly as it does for an anonymous caller: a shared surface answers the same rows to
        everybody, so its ``total`` and its page boundaries do not depend on the credential.
        Asking the *workspace* (``?mine=true``) returns every state the caller owns. And the
        anonymous caller sees the published post either way.

        Stating all three here is what stops a later reader from "restoring" the identity-based
        widening this test used to assert. A fresh author is built rather than reusing
        :func:`corpus` because the mode is a property of the *viewer*, and ``author_client``
        authenticates as ``conftest``'s ``author_user``.
        """
        response = await author_client.get("/api/v1/auth/me")
        assert response.status_code == 200, response.text
        viewer = response.json()

        author = await db_session.get(User, viewer["id"])
        assert author is not None
        draft = await factories.create_post(
            db_session,
            author=author,
            title="A Draft Only Its Own Author May List",
            excerpt=NEUTRAL_EXCERPT,
            content=NEUTRAL_CONTENT,
            status=PostStatus.DRAFT,
        )
        published = await factories.create_post(
            db_session,
            author=author,
            title="A Published Post Anyone May List",
            excerpt=NEUTRAL_EXCERPT,
            content=NEUTRAL_CONTENT,
            status=PostStatus.PUBLISHED,
            published_at=_at(60),
        )

        public_self = await _feed(author_client, author=viewer["username"], page_size=MAX_PAGE_SIZE)
        workspace = await _feed(author_client, mine="true", page_size=MAX_PAGE_SIZE)
        anonymous = await _feed(client, author=viewer["username"], page_size=MAX_PAGE_SIZE)

        # The public feed: identical for the author and for a stranger.
        assert str(draft.id) not in set(_ids(public_self))
        assert str(published.id) in set(_ids(public_self))
        assert public_self["total"] == anonymous["total"]
        assert str(draft.id) not in set(_ids(anonymous))
        assert str(published.id) in set(_ids(anonymous))

        # The workspace: every state the caller owns, and strictly more than the public feed.
        assert str(draft.id) in set(_ids(workspace))
        assert str(published.id) in set(_ids(workspace))
        assert workspace["total"] > public_self["total"]

    async def test_an_authenticated_reader_sees_no_more_of_the_unscoped_feed_than_anyone_else(
        self,
        author_client: AsyncClient,
        client: AsyncClient,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.4: the unscoped home feed is shared - authenticating does not widen it.

        An author browsing the bare feed gets the public status set, not their own drafts mixed in.
        That is what keeps ``total`` and the page boundaries identical for every caller, so a
        crawler, a signed-out reader and a signed-in author all page through the same result.
        """
        anonymous = await _feed(client, page_size=MAX_PAGE_SIZE)
        authenticated = await _feed(author_client, page_size=MAX_PAGE_SIZE)

        assert authenticated["total"] == anonymous["total"]
        assert not corpus.hidden & set(_ids(authenticated))


# ---------------------------------------------------------------------------------------
# The plan, at volume
# ---------------------------------------------------------------------------------------

PUBLIC_SCOPE: Final[tuple[PostStatus, ...]] = (PostStatus.PUBLISHED,)
"""The status scope a public feed request resolves to.

Stated here as a literal tuple rather than imported from ``app.services.post_service`` on purpose:
these tests reconstruct the *repository's* statement, and the repository takes its scope as an
argument. Naming the argument locally keeps this module from asserting anything about how the
service chooses it - which is :class:`TestStatusScoping`'s subject, through HTTP."""


async def _add_volume(session: AsyncSession, *, author: User, count: int) -> int:
    """Add ``count`` published rows, then put the relation into the state production keeps it in.

    Three steps, and the two after the insert are the ones AAP §0.9.5 hinges on.

    **Fresh statistics.** Rows alone are not enough: without them the planner has nothing on which
    to prefer an index, and a plan assertion would be measuring the absence of ``ANALYZE`` rather
    than the presence of an index. That is exactly the trap the original single-row probe fell into.

    **A flushed GIN pending list.** With ``fastupdate`` on - the default, and what revision ``0002``
    creates - a GIN index buffers newly inserted entries in an unordered *pending list* instead of
    merging them into the tree, and any scan of that index must read the whole list on top of the
    tree. Bulk-loading thousands of rows inside a single transaction therefore leaves the index in
    a state no queried index is ever really in: mid-load. In production the list is drained
    continuously, by autovacuum and by any insert that pushes it past ``gin_pending_list_limit``.
    Draining it here restores that steady state, and the difference is not marginal - measured on
    this schema, the ranked search plan cost **337.59 with the list unflushed and 48.59 with it
    flushed**, a factor of seven, entirely inside the index's own cost.

    That distinction is what makes these tests order-independent. The pending list is physical, so
    it survives the rollback of the transaction that filled it and grows monotonically across a
    run; without this step the same assertion passed when the module ran alone and failed when it
    ran after its siblings, which is precisely the flakiness a blocking gate cannot carry.

    Both steps are *data* maintenance. No planner setting is touched, no cost constant is tuned and
    ``enable_seqscan`` stays on: the plan is still chosen by PostgreSQL costing the query it is
    given against the statistics it has. What is removed is a bulk-load artifact, not a plan.

    Notably absent is any attempt to rebuild the search index. The ``tsvector`` column is
    ``GENERATED ALWAYS AS ... STORED``, so every ``INSERT`` re-derives it with no trigger and no
    application-side maintenance - see
    :meth:`TestSearchIndexUsageAtVolume.test_the_search_column_is_generated_and_therefore_never_written`.
    Everything here runs inside the test's transaction and is discarded with it, like every other
    write in this module.

    Args:
        session: The transactional session.
        author: The account the rows are attributed to.
        count: How many rows to add. See :data:`VOLUME_POSTS` for why the number is what it is.

    Returns:
        The number of rows in ``posts`` afterwards, as the planner now sees it.

    Note:
        The rows are wide on purpose. A plan choice is costed against the table's size in
        **pages**, not its row count, so narrow rows would understate the cost of a sequential
        scan and make the comparison unrepresentative of a real article. The body text is built by
        repeating the row number in hexadecimal: deterministic, so the corpus is identical on every
        run, and carrying no rare token, so it cannot perturb a relevance assertion.
    """
    rows = [
        {
            "author_id": author.id,
            "title": f"Feed Volume Filler {index:05d}",
            "slug": f"{author.username}-feed-volume-{index:05d}",
            "excerpt": f"A summary of ordinary engineering practice, number {index}.",
            "content": f"Ordinary engineering prose, entry {index}. " + f"{index:x}" * 320,
            "status": PostStatus.PUBLISHED,
            "published_at": _at(1_000 + index),
            "view_count": 0,
        }
        for index in range(count)
    ]
    for start in range(0, len(rows), VOLUME_INSERT_CHUNK):
        await session.execute(insert(Post).values(rows[start : start + VOLUME_INSERT_CHUNK]))
    await session.execute(text("ANALYZE posts"))
    for index_name in (SEARCH_VECTOR_INDEX, TITLE_TRIGRAM_INDEX):
        # `CAST(:name AS regclass)` rather than `:name::regclass`: the `::` form collides with
        # SQLAlchemy's own bind-parameter syntax and never reaches the server.
        await session.execute(
            text("SELECT gin_clean_pending_list(CAST(:name AS regclass))"),
            {"name": index_name},
        )
    return (await session.execute(select(func.count()).select_from(Post))).scalar_one()


def _repository_statement(
    *,
    term: str | None,
    sort: PostSort,
    full_text_only: bool = False,
) -> Any:
    """Rebuild the statement ``PostRepository.list_posts`` issues for a public feed request.

    Assembled from the repository's **own** expression builders rather than from a hand-written
    approximation, so the plan these tests inspect is the plan production produces. That matters
    more than it might appear: the same measurement performed against the ``@@`` half in isolation
    would credit the wrong plan to the wrong index, and a rewritten predicate could easily be one
    an index cannot serve while looking identical on the page.

    The window is part of that fidelity and is kept deliberately: the feed's first page really is
    ``LIMIT PAGINATION_PAGE_SIZE OFFSET 0``, and a ``LIMIT`` changes what the planner costs, so
    explaining the statement without one would be explaining a statement the application never
    issues. The consequence is that the **root** node of every plan built here is a ``Limit``
    whose ``Plan Rows`` is capped at the page size and therefore says nothing about how selective
    the predicate is. Any assertion about selectivity must read the scan over ``posts`` instead -
    which is what :func:`_relation_estimate` is for, and why no caller reads ``nodes[0]``.

    Args:
        term: The search term, or ``None`` to build the browse statement.
        sort: ``"recent"`` or ``"relevance"``, passed through to the repository's ordering builder.
        full_text_only: When ``True``, keep only the ranked full-text half of the search
            predicate and drop the trigram fallback. This isolates the feed's **primary** search
            access path, which is the one AAP §0.9.4.2 names; see
            :meth:`TestSearchIndexUsageAtVolume.test_the_composed_search_predicate_is_estimated_selectively`
            for the whole disjunction and for what the planner does with it.

    Returns:
        The statement, projected and windowed exactly as the feed's first page is.
    """
    normalised = _normalise_term(term)
    tsquery = _search_query(normalised) if normalised else None
    predicates = _build_predicates(
        term=normalised,
        tsq=tsquery,
        author_id=None,
        statuses=PUBLIC_SCOPE,
    )
    if full_text_only and tsquery is not None:
        # `_build_predicates` returns the status predicate followed by the search disjunction, so
        # replacing the last element with its full-text half leaves the statement otherwise
        # untouched - same scope, same ordering, same projection, same window.
        predicates[-1] = Post.search_vector.bool_op("@@")(tsquery)

    statement = _restrict(select(Post), category_slug=None, predicates=predicates).order_by(
        *_build_ordering(
            term=normalised,
            tsq=tsquery,
            sort=sort,
            nulls_possible=_published_at_nullable(PUBLIC_SCOPE),
        )
    )
    return _with_projection(statement, "summary").limit(PAGINATION_PAGE_SIZE).offset(0)


class TestSearchIndexUsageAtVolume:
    """AAP §0.9.4.2 and §0.9.5: the deferred index-selection risk, discharged with seeded data.

    AAP §0.9.5 records the risk in plain terms - the full-text and trigram indexes are correct, but
    a probe against a single-row table chose a sequential scan, so index usage must be re-confirmed
    with seeded data before the feed query is considered done - and names this module as its home.
    This class is that confirmation.

    Every test here seeds :data:`VOLUME_POSTS` rows, runs ``ANALYZE``, and plans a statement
    rebuilt from the repository's own builders. Nothing is coerced: ``enable_seqscan`` is never
    disabled, no planner cost is tuned, and no assertion is marked expected-to-fail. Forcing a plan
    would prove nothing about production, and skipping the question would leave AAP §0.9.5 open.

    These are the only tests in the module that touch the database directly rather than through
    HTTP, which is the documented exception: AAP §0.9.4.2 asks for a statement about a *query
    plan*, and a query plan is not visible over HTTP.
    """

    async def test_the_ranked_full_text_search_uses_the_generated_vectors_gin_index(
        self,
        db_session: AsyncSession,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.2: "``EXPLAIN`` on the feed's search query selects the full-text index".

        The feed's search has a primary path and a fallback: ranked matching over the generated
        ``search_vector``, with trigram similarity on the title OR-ed in behind it. This is the
        primary path, and it is the one the criterion names - revision ``0002`` calls
        ``ix_posts_search_vector`` "the feed's primary search path" in as many words.

        The threshold was measured rather than assumed, in a database whose GIN indexes had bloated
        to a thousand pages - the least favourable state a run produces. This statement scans at a
        single row, which is the very observation AAP §0.9.5 records, and takes the index from about
        two hundred rows upward; :data:`VOLUME_POSTS` clears that by an order of magnitude. See
        :data:`VOLUME_POSTS` for the whole curve and :func:`_add_volume` for why the pending-list
        flush is what makes the answer stable rather than dependent on where in the run this test
        happens to execute.

        The corpus is seeded first, so the term still matches only a handful of rows out of
        thousands. That ordering is deliberate: an index is chosen because a predicate is
        *selective*, and a term matching most of the table would rightly be scanned instead.
        """
        rows = await _add_volume(
            db_session,
            author=corpus.primary_author,
            count=VOLUME_POSTS,
        )
        assert rows > VOLUME_POSTS, "the volume rows must be visible to the planner"

        nodes = await _explain(
            db_session,
            _repository_statement(term=SEARCH_TERM, sort="relevance", full_text_only=True),
        )

        sizes = await _relation_sizes(db_session)
        assert SEARCH_VECTOR_INDEX in _indexes_used(nodes), (
            f"the ranked full-text search must read {SEARCH_VECTOR_INDEX} at "
            f"{rows} rows; pages were {sizes}; plan was:\n{_describe_plan(nodes)}"
        )
        assert not _scans_sequentially(nodes, "posts"), (
            f"the ranked full-text search must not scan posts sequentially at {rows} rows; "
            f"pages were {sizes}; plan was:\n{_describe_plan(nodes)}"
        )

    async def test_the_default_recency_ordering_uses_the_status_and_date_index(
        self,
        db_session: AsyncSession,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.2, complementary: the home page's primary query is served by an index.

        The bare feed - published posts, newest first - is the most requested query in the product,
        and revision ``0001`` creates ``ix_posts_status_published_at`` as ``(status, published_at
        DESC)`` for it specifically. The spelling of the ordering is load-bearing here: because a
        ``DESC`` index column orders nulls first, ``published_at DESC NULLS LAST`` would **not**
        match this index and would force a sort over the whole matching set. The repository
        therefore emits the plain form wherever the status scope makes a null impossible, which is
        every public listing, and this test is what notices if that ever stops being true.
        """
        rows = await _add_volume(
            db_session,
            author=corpus.primary_author,
            count=VOLUME_POSTS,
        )

        nodes = await _explain(db_session, _repository_statement(term=None, sort="recent"))

        assert RECENCY_INDEX in _indexes_used(nodes), (
            f"the default feed ordering must read {RECENCY_INDEX} at {rows} rows; "
            f"plan was:\n{_describe_plan(nodes)}"
        )
        assert not _scans_sequentially(nodes, "posts"), (
            f"the default feed ordering must not scan posts sequentially at {rows} rows; "
            f"plan was:\n{_describe_plan(nodes)}"
        )

    async def test_the_whole_search_disjunction_reaches_both_gin_indexes(
        self,
        db_session: AsyncSession,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.9.4.2 and §0.9.5: the statement the feed *really* issues is served by indexes.

        The test above isolates the ranked half. This one asserts the whole predicate - relevance
        matching over ``search_vector`` with trigram similarity on the title OR-ed in behind it -
        which is what a reader's search actually runs. The planner combines the two halves with a
        ``BitmapOr`` over both GIN indexes, so neither half is an index the predicate can never
        reach. That last phrase is revision ``0002``'s own standard: "a planner that declines an
        index on a small relation is costing the query correctly", while "what would be a defect is
        an index the predicate can never reach".

        The threshold is higher than the ranked half's because a ``BitmapOr`` has to pay for both
        scans: measured on this schema the disjunction scans at six hundred rows and takes both
        indexes from about twelve hundred upward, which is what :data:`VOLUME_POSTS` clears.

        Four things are asserted, all at volume, and each states what it tolerates as carefully
        as what it requires - a plan gate that rejects valid plans is as useless as one that
        accepts invalid statistics:

        1. **The statistics are usable.** The scan over ``posts`` is estimated to match a handful
           of rows out of thousands. The estimate is read from that scan node and deliberately
           **not** from the root: the statement is the feed's first page, so its root ``Limit``
           reports at most :data:`PAGINATION_PAGE_SIZE` rows however unselective the predicate
           turns out to be, and an assertion there would hold for any corpus above eighty rows
           even if the planner expected the predicate to match the whole table. A selective
           estimate is the precondition for preferring an index at all, and its absence is
           precisely the failure AAP §0.9.5 warns about - "without fresh statistics the planner
           has no basis to prefer the index".
        2. **Both GIN indexes are read.** As a subset, not as the plan's complete index set: an
           additional index the planner also finds worth reading is a *better* plan, not a
           broken one, and costs shift with statistics and with releases. What would be a defect
           is one of the two being absent.
        3. **They serve the two OR branches.** Read from the ``BitmapOr``'s own children, so the
           claim is that ``search_vector`` answered the ranked half and ``title`` answered the
           trigram half - not merely that both names appeared somewhere in the plan. And
           ``posts`` is not scanned sequentially, asserted independently of all of the above.
        4. **Both access paths exist over the columns the predicate names**, read from the
           catalogue: ``@@`` reaches a GIN index on ``search_vector`` and ``%`` reaches a GIN index
           on ``title`` with ``gin_trgm_ops``. That is the defect the measurement above rules out
           and this assertion keeps ruled out.
        """
        rows = await _add_volume(
            db_session,
            author=corpus.primary_author,
            count=VOLUME_POSTS,
        )

        nodes = await _explain(
            db_session,
            _repository_statement(term=SEARCH_TERM, sort="relevance"),
        )
        # The estimate is read from the node that reads `posts`, NOT from the root. The root is a
        # `Limit` over the feed's first page, so its estimate is capped at PAGINATION_PAGE_SIZE
        # and would satisfy this assertion for any corpus above eighty rows even if the planner
        # expected the predicate to match every one of them. See :func:`_relation_estimate`.
        estimated = _relation_estimate(nodes, "posts")
        used = _indexes_used(nodes)
        branches = _bitmap_or_branches(nodes)
        sizes = await _relation_sizes(db_session)

        assert estimated < rows / 10, (
            "ANALYZE must leave the planner a selective estimate for the composed search "
            f"predicate: the scan over posts expects {estimated} of {rows} rows; plan was:\n"
            f"{_describe_plan(nodes)}"
        )
        # A SUBSET, not set equality. Both GIN indexes are required, and an additional index the
        # planner also finds worth reading is a valid plan - a `posts_pkey` lookup for the
        # bitmap recheck, or a join path added when statistics or a release changes the costing.
        # Demanding exact equality would fail a correct plan for being better than expected,
        # which is a gate that reports the wrong thing.
        assert {SEARCH_VECTOR_INDEX, TITLE_TRIGRAM_INDEX} <= used, (
            "both halves of the search disjunction must be served by their GIN index at "
            f"{rows} rows; indexes read were {sorted(used)}; pages were {sizes}; plan was:\n"
            f"{_describe_plan(nodes)}"
        )
        # And they must serve the two OR branches rather than merely appear somewhere in the
        # plan: the disjunction is combined under a `BitmapOr`, and its children name which index
        # answered which half. This is what would notice one index answering both halves, or one
        # half dropping out of the bitmap into a recheck filter.
        assert {SEARCH_VECTOR_INDEX, TITLE_TRIGRAM_INDEX} <= set(branches), (
            "the two GIN indexes must be the children of the BitmapOr that combines the search "
            f"disjunction; branches found were {branches}; plan was:\n{_describe_plan(nodes)}"
        )
        assert "search_vector" in branches[SEARCH_VECTOR_INDEX], (
            f"{SEARCH_VECTOR_INDEX} must serve the ranked full-text half, but its branch "
            f"condition was {branches[SEARCH_VECTOR_INDEX]!r}"
        )
        assert "title" in branches[TITLE_TRIGRAM_INDEX], (
            f"{TITLE_TRIGRAM_INDEX} must serve the trigram half over the title, but its branch "
            f"condition was {branches[TITLE_TRIGRAM_INDEX]!r}"
        )
        # Retained independently of everything above: whatever the planner combines and however
        # it costs it, reading the whole relation is the outcome AAP §0.9.5 asks this module to
        # rule out.
        assert not _scans_sequentially(nodes, "posts"), (
            f"the composed search must not scan posts sequentially at {rows} rows; "
            f"pages were {sizes}; plan was:\n{_describe_plan(nodes)}"
        )

        access_paths = await db_session.execute(
            text(
                "SELECT i.indexname, i.indexdef FROM pg_indexes i"
                " WHERE i.tablename = 'posts' AND i.indexname = ANY(:names)"
            ),
            {"names": [SEARCH_VECTOR_INDEX, TITLE_TRIGRAM_INDEX]},
        )
        # `.tuples()` for the same reason as in `_relation_sizes`: two selected columns, made
        # visible to the checker without a second query or a cast.
        definitions: dict[str, str] = dict(access_paths.tuples().all())

        assert set(definitions) == {SEARCH_VECTOR_INDEX, TITLE_TRIGRAM_INDEX}
        assert "USING gin" in definitions[SEARCH_VECTOR_INDEX]
        assert "search_vector" in definitions[SEARCH_VECTOR_INDEX]
        assert "USING gin" in definitions[TITLE_TRIGRAM_INDEX]
        assert "gin_trgm_ops" in definitions[TITLE_TRIGRAM_INDEX]

    async def test_the_search_column_is_generated_and_therefore_never_written(
        self,
        db_session: AsyncSession,
        corpus: FeedCorpus,
    ) -> None:
        """AAP §0.6.3.1: ``search_vector`` is derived by the database, on every write.

        The corollary is what makes the index assertions above trustworthy without any maintenance
        step: a row inserted by a factory or by the bulk statement in :func:`_add_volume` is
        searchable the moment it lands, because PostgreSQL recomputes the column as part of the
        ``INSERT``. There is no trigger to fire, no queue to drain and no index to *rebuild* - which
        is why :func:`_add_volume` never reindexes. What it does do is refresh statistics and drain
        the GIN pending list, and neither of those derives a value: one describes the data to the
        planner, the other merges already-written index entries into the tree.

        Read from ``information_schema`` rather than asserted about the model, because the claim is
        about the column PostgreSQL actually has: it is ``ALWAYS`` generated and ``STORED``, and
        only a stored column can carry the GIN index the feed's primary search path reads.
        """
        column = (
            await db_session.execute(
                text(
                    "SELECT is_generated, generation_expression FROM information_schema.columns"
                    " WHERE table_name = 'posts' AND column_name = 'search_vector'"
                )
            )
        ).one()

        assert column.is_generated == "ALWAYS"
        assert "setweight" in column.generation_expression
        assert "'A'" in column.generation_expression
        assert "'B'" in column.generation_expression
        assert "'C'" in column.generation_expression

        # And the derivation really did happen for a row this module wrote, rather than merely
        # being declared in the catalogue. The comparison is made against the STEM the text-search
        # configuration produces rather than against the term as typed: the `english`
        # configuration reduces `quantumsluice` to `quantumsluic`, so asserting the raw spelling
        # would be asserting that no stemmer ran.
        derived = (
            await db_session.execute(
                text(
                    "SELECT p.search_vector::text AS vector,"
                    " p.search_vector @@ websearch_to_tsquery('english', :term) AS matched,"
                    " strip(to_tsvector('english', :term))::text AS stem"
                    " FROM posts p WHERE p.id = :post_id"
                ),
                {"term": SEARCH_TERM, "post_id": corpus.title_hit},
            )
        ).one()

        assert derived.vector, "the generated column must be populated on insert"
        assert derived.matched, "the generated vector must answer a search for the title's term"
        stem = derived.stem.strip("'")
        # Weight `A` is the whole point: the lexeme came from the title, and the ordering asserted
        # in TestFreeTextSearch is a consequence of exactly this label.
        assert re.search(rf"'{re.escape(stem)}':\d+A", derived.vector), (
            f"the title's lexeme must be weighted 'A' in {derived.vector}"
        )
