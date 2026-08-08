"""The single home of feed composition: every listing of posts in the product starts here.

Four surfaces list posts - the public home feed, an author's public profile, the author
workspace and the administrative posts table - and all four call :meth:`PostRepository.list_posts`
with different arguments rather than writing a query of their own. That is a structural
requirement, not a tidiness preference. Free-text relevance ranking, typo-tolerant fallback
matching, category membership, author filtering, lifecycle scoping, ordering and windowing are
composed once, in one place, so the composition is tested once, its index usage is predictable,
and the four surfaces window results identically - which is what lets the client share a single
pagination component across the feed, the profile and every admin table.

One statement, plus one matching count
--------------------------------------
:meth:`~PostRepository.list_posts` issues exactly two Core statements: the count, then the
window. Every filter is applied by :func:`_restrict`, which is called once for the rows select
and once for the count select, so the two predicate sets are identical *by construction* - no
filter is restated anywhere, therefore none can be forgotten and the two cannot drift apart.

The count is ``count(DISTINCT posts.id)`` rather than ``count(*)``, and that is not decoration.
The category filter joins through ``post_categories``, and a join is exactly where a row count
stops being an entity count. An inflated ``total`` corrupts the ``pages`` figure the client
paginates on, makes page two overlap page one, and desynchronises the pagination control from
the data - a defect that reads as "the last page is empty" long before anyone suspects the
count. ``DISTINCT`` on the surrogate key removes the possibility rather than making it unlikely.

Relationship loading is attached to the rows statement only. ``selectinload`` is used - never
``joinedload`` against a collection - so no row is multiplied, ``.unique()`` is unnecessary and
:meth:`~app.repositories.base.BaseRepository.paginate` needs no de-duplication. Loader options
are deliberately absent from the count statement: an ORM loader option carried by a statement
nobody reads rows from is work with no output.

Index usage must be confirmed at volume, not on a probe
------------------------------------------------------
``posts`` carries four access paths, and every predicate composed here is written to be served
by one of them: ``ix_posts_search_vector`` (GIN over the generated ``tsvector``) for ranked
search, ``ix_posts_title_trgm`` (GIN with ``gin_trgm_ops``) for the near-miss fallback,
``ix_posts_status_published_at`` for the default "recent published posts" ordering, and
``ix_posts_author_id`` for the author-scoped listings.

A known trap is recorded here so it is recognised rather than rediscovered: an ``EXPLAIN`` probe
run against a single-row ``posts`` table chooses ``Seq Scan``. That is correct planner behaviour
at that size and must **not** be "fixed" - a sequential scan over one row is cheaper than any
index. Index selection is therefore verified at seeded volume instead. Measured directly against
PostgreSQL 18.4 over five thousand seeded posts, the statements this module builds plan as:

* ranked search - ``Bitmap Heap Scan on posts`` fed by ``BitmapOr`` over
  ``ix_posts_search_vector`` and ``ix_posts_title_trgm``, which is precisely the shape the
  single OR-ed predicate exists to permit;
* default recency - ``Index Scan using ix_posts_status_published_at``, feeding an
  ``Incremental Sort`` that resolves only the final ``posts.id`` tiebreaker.

What follows from that measurement is a set of constraints on how the statements are written,
all of which this module observes: ``search_vector`` is never wrapped in a function on the left
of ``@@``; no ``lower()`` is applied to a ``citext`` column, because that would discard the
case-insensitive index and re-implement in Python what the column type already guarantees; the
search predicate is a single ``OR`` of two indexable operators rather than an arbitrary
disjunction; and the slug prefix scan is anchored at the start of the pattern, never with a
leading wildcard.

``search_vector`` is read here and written nowhere
-------------------------------------------------
``posts.search_vector`` is ``GENERATED ALWAYS AS (...) STORED``. PostgreSQL re-derives it from
the title, excerpt and body on every INSERT and UPDATE, so there is no trigger to install, no
background job to schedule and no application-side index maintenance step to call. This module
queries the column and never assigns to it. The one obligation that follows is the search
configuration: :data:`_SEARCH_CONFIG` must be the same dictionary the generating expression in
``app/models/post.py`` uses, because a ``tsquery`` built with a different configuration silently
matches nothing rather than failing loudly.

What this module deliberately does not do
-----------------------------------------
**No HTTP artefact.** Nothing here raises. A missing row is ``None``; a page past the end is
``([], total)``; nothing that matches nothing is an error. The retired service raised the same
``HTTPException(status_code=404, detail="Item not found")`` from inside three separate
data-access loops - ``app.py:L31``, ``L40`` and ``L49`` - which is how one policy came to have
three definitions. Choosing a status code belongs to ``app/core/exceptions.py`` and to the
services that raise the domain errors it renders.

**No authority.** Whether a caller may see a draft is not decided here. ``statuses`` is an
argument: the public feed passes ``(PostStatus.PUBLISHED,)``, the author workspace passes its own
``author_id`` with every status, and the administrative table passes ``statuses=None``. Ownership
comparison, role checks and the publish transition live in ``app.services.post_service``, so one
rule holds whichever entry point invokes it and is unit-testable without an HTTP request. A
repository that decided visibility would let the next caller reach the same rows without the
decision.

**No commit, and no invariant duplicated in Python.** Writes go through the inherited helpers,
which flush; the service owns the transaction boundary. The publication invariant belongs to the
``ck_posts_published_at_required`` CHECK constraint, so no statement here adds ``published_at IS
NOT NULL`` beside a ``PUBLISHED`` filter - the database already guarantees it, and a second copy
of a rule is a copy that can disagree. Dependent rows belong to ``ON DELETE CASCADE`` on
``comments``, ``post_likes`` and ``post_categories``, so nothing here hand-deletes them.
Identity belongs to ``gen_random_uuid()``, so no caller supplies one.

**No wire shape.** Every listing returns ``(rows, total)``. ``app.core.pagination.Page`` is a
Pydantic response model and is not imported here; the service projects the rows into their
response schemas and calls ``build_page(list(rows), total, page, page_size)``. Keeping the
envelope out of the data layer is the same rule that keeps ``select()`` out of the routers.

**No slug derivation.** :meth:`~PostRepository.slugs_starting_with` reports which slugs are
already taken; deriving a new one from a title, and suffixing a collision, is
``app.core.slug``'s, called from the service. This module does not import it.

**No view accounting, no aggregates and no external search engine.** There is no
``increment_view_count`` here and no ``"popular"`` sort - see :data:`PostSort`. Like and comment
counts are aggregates issued by their own repositories and exposed by their own endpoints, so
the feed does not carry them. And search is PostgreSQL's own weighted full-text search, verified
sufficient for this product; no search-engine client is introduced.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Any, Final, Literal

from sqlalchemy import ColumnElement, Select, distinct, func, or_, select
from sqlalchemy.orm import selectinload
from sqlalchemy.sql.functions import Function

from app.models.category import Category, post_categories
from app.models.post import Post, PostStatus
from app.repositories.base import BaseRepository

__all__ = ["PostRepository", "PostSort"]


PostSort = Literal["recent", "relevance"]
"""How a listing of posts is ordered.

Two values, and the shortness of that list is deliberate.

``"recent"``
    ``published_at`` descending - the home page's primary query, and the ordering
    ``ix_posts_status_published_at`` exists to serve. The default, because a blog feed that did
    not lead with the newest article would be surprising.
``"relevance"``
    ``ts_rank`` over the generated search vector, descending, with trigram similarity on the
    title as the secondary key. Meaningful only alongside a search term, so with no ``q`` it
    degrades to ``"recent"`` rather than raising: there is nothing to rank against, and a
    listing is not the place to reject a combination of parameters that has an obvious reading.

There is deliberately no ``"popular"``. Ordering by ``posts.view_count`` would be dead
behaviour today: no endpoint in the REST surface advances that column, so it is uniformly zero
and the ordering would degenerate to whatever the tiebreaker decided. View tracking and the
analytics it would belong to are out of scope, and shipping a sort value that silently does
nothing is worse than not shipping it. Should view accounting ever be requested, this alias and
:func:`_build_ordering` are the two places that change - add the member here, add a branch that
orders by ``Post.view_count.desc()`` there, and nothing else in the module moves.

``app.schemas.post`` mirrors these two values for query-parameter validation and for the
generated OpenAPI document. That duplication is intentional and correct: a repository must not
import the schema layer, so the wire vocabulary is declared where the wire is described and the
storage vocabulary is declared here.
"""

DEFAULT_POST_SORT: Final[PostSort] = "recent"
"""The ordering applied when a caller expresses no preference.

Named rather than repeated as a literal so the default appears once, and so the feed, the
profile and the admin table cannot drift onto different defaults.
"""


_SEARCH_CONFIG: Final[str] = "english"
"""The text-search configuration every ``tsquery`` in this module is built with.

**Must** match the configuration the ``posts.search_vector`` generating expression uses -
``to_tsvector('english', ...)`` in ``app/models/post.py``. A mismatch does not raise: it stems
the query with one dictionary and the document with another, so ``@@`` simply stops matching and
search returns nothing for reasons no error message points at. Declared as a constant precisely
so the two sides can be compared at a glance.
"""

_LIKE_ESCAPE: Final[str] = "\\"
"""The escape character used by :meth:`PostRepository.slugs_starting_with`.

A single backslash, passed explicitly to ``LIKE ... ESCAPE`` so the wildcard neutralisation in
:func:`_escape_like_prefix` is interpreted the way it was written rather than relying on a
server default.
"""

_LIKE_WILDCARDS: Final[tuple[str, ...]] = ("%", "_")
"""The two SQL ``LIKE`` metacharacters :func:`_escape_like_prefix` neutralises."""


# =====================================================================================
# Composition primitives.
#
# The statement is assembled from four small, independently testable pieces rather than
# in one long method body. Two reasons, both practical:
#
#   * `backend/tests/integration/test_post_search_filter_pagination.py` can drive each
#     branch - status scoping, author filtering, category membership, the search
#     disjunction, each ordering variant - without going through the API, which is what
#     makes the blocking 80% coverage floor reachable on a file this dense.
#   * `_restrict` is called TWICE, once for the rows select and once for the count
#     select. Because the joins and predicates exist in exactly one place, the two
#     statements cannot carry different filter sets. That property is what makes `total`
#     trustworthy, and it is the whole reason the filters are not applied inline.
#
# Every function here is pure: it builds SQL expressions and touches no session.
# =====================================================================================


def _normalise_term(q: str | None) -> str:
    """Reduce a caller's raw search input to the term the statement should use.

    Args:
        q: The unvalidated query string, straight from a URL parameter, or ``None``.

    Returns:
        The stripped term, or ``""`` when there is nothing to search for. ``""`` is falsey,
        so every call site tests the term itself rather than repeating a ``strip()`` and a
        ``None`` check - which is what keeps "no search" a single condition across the
        predicate builder, the ordering builder and :meth:`PostRepository.list_posts`.

    Note:
        A string of whitespace is treated exactly like an absent parameter. That matters
        because ``websearch_to_tsquery`` on whitespace yields an empty ``tsquery`` which
        matches nothing, so an accidental space in a URL would otherwise empty the feed.
    """
    return "" if q is None else q.strip()


def _search_query(term: str) -> Function[Any]:
    """Compile a search term into a PostgreSQL ``tsquery``.

    ``websearch_to_tsquery`` is used rather than ``to_tsquery`` or ``plainto_tsquery``, and the
    choice is about what arrives from a search box. ``to_tsquery`` demands the operator syntax
    and raises a syntax error on ordinary punctuation, so a reader typing ``fastapi & "async"``
    would receive a ``500``. ``plainto_tsquery`` accepts free text but ANDs every token and
    understands no quoting, so a phrase cannot be searched. ``websearch_to_tsquery`` accepts
    web-search conventions - quoted phrases, ``or``, a leading ``-`` for negation - and never
    raises on punctuation, which makes it the only one of the three safe to hand unvalidated
    input.

    Args:
        term: A non-empty, already-stripped search term.

    Returns:
        The ``tsquery`` expression, built with :data:`_SEARCH_CONFIG`.

    Note:
        ``term`` becomes a **bound parameter**, not interpolated text. Nothing in this module
        concatenates caller input into SQL; ``func.*`` binds its arguments, which is what makes
        the search path injection-proof by construction rather than by escaping.
    """
    return func.websearch_to_tsquery(_SEARCH_CONFIG, term)


def _escape_like_prefix(prefix: str) -> str:
    """Neutralise ``LIKE`` metacharacters in a literal prefix.

    Slugs are matched with ``LIKE 'prefix%'`` to find the family a collision suffix has to
    avoid. Without escaping, a slug already containing ``_`` - which no derived slug does, but
    a hand-edited or seeded one might - would match any single character in that position and
    over-report the taken set, and a ``%`` would match everything. Over-reporting is not a
    security hole here, but it produces a needlessly high suffix on the next post, which is a
    permanent, visible artefact in a canonical URL.

    Args:
        prefix: The literal text to match at the start of a slug.

    Returns:
        The same text with the escape character and both wildcards backslash-escaped, ready to
        be concatenated with ``"%"`` and passed to ``LIKE ... ESCAPE``.

    Note:
        The escape character is doubled **first**. Reversing the order would escape the
        backslashes this function itself introduced, turning ``100%`` into ``100\\\\%`` -
        a literal backslash followed by a live wildcard, which is the exact bug the escaping
        exists to prevent.
    """
    escaped = prefix.replace(_LIKE_ESCAPE, _LIKE_ESCAPE * 2)
    for wildcard in _LIKE_WILDCARDS:
        escaped = escaped.replace(wildcard, _LIKE_ESCAPE + wildcard)
    return escaped


def _build_predicates(
    *,
    term: str,
    tsq: Function[Any] | None,
    author_id: uuid.UUID | None,
    statuses: Sequence[PostStatus] | None,
) -> list[ColumnElement[bool]]:
    """Build the ``WHERE`` conjunction shared by the rows statement and the count statement.

    Three optional predicates, each served by a named index, each governed purely by whether
    its argument was supplied. No predicate is added on this module's own initiative.

    Args:
        term: The normalised search term; ``""`` when the caller is not searching.
        tsq: The compiled ``tsquery`` for ``term``, or ``None`` when there is no term. Built
            once by the caller and shared with :func:`_build_ordering` so the statement holds
            one query expression rather than two equal ones.
        author_id: Restrict to one author's posts, or ``None`` for every author. A **UUID, not
            a username**: resolving a username belongs to ``UserRepository.get_by_username``,
            one indexed ``citext`` probe, and reporting an unknown author belongs to the
            service. Taking the id here keeps this statement joined to the taxonomy tables and
            nothing else, which is what keeps the plan predictable.
        statuses: The lifecycle states to include, or ``None`` for every state.

    Returns:
        The predicates, to be ANDed. Empty when no argument narrows the result, which is a
        legitimate request for the whole relation.

    Note:
        There is deliberately **no** ``published_at IS NOT NULL`` beside a ``PUBLISHED``
        filter. ``ck_posts_published_at_required`` already guarantees it - verified against
        PostgreSQL 18.4 by an INSERT that the constraint rejected - and restating a database
        invariant in Python creates a second definition that can fall out of step with the
        first.

        Nor is there a hard-coded status. ``statuses`` arrives from the caller: the public feed
        narrows to :attr:`~app.models.post.PostStatus.PUBLISHED`, the author workspace asks for
        every state of its own posts, and the administrative table asks for every state
        outright. Deciding here which of those a request is would put an authority rule in the
        data layer, where the next caller could reach the rows without it.
    """
    predicates: list[ColumnElement[bool]] = []

    if statuses is not None:
        # in_() on the native enum column; served by ix_posts_status_published_at, whose
        # leading column is `status`. A single-member sequence renders as IN (...) rather than
        # as `=`, which PostgreSQL plans identically.
        predicates.append(Post.status.in_(statuses))

    if author_id is not None:
        # Served by ix_posts_author_id - the access path behind the public profile and the
        # author workspace, neither of which has any other way to address its rows.
        predicates.append(Post.author_id == author_id)

    if term and tsq is not None:
        # ONE disjunction, deliberately, so the whole search stays a single statement. The
        # ranked full-text match is the primary path (GIN over the generated tsvector) and
        # trigram similarity on the title is the typo-tolerant fallback (GIN with
        # gin_trgm_ops). Measured at seeded volume: PostgreSQL resolves this with a BitmapOr
        # across both indexes, so the fallback costs a second bitmap rather than a scan.
        #
        # bool_op() rather than op(): it types the result as ColumnElement[bool], which is
        # what where() wants, so no cast is needed to satisfy the strict type-check gate.
        #
        # The left operand of @@ is the bare column. Wrapping it - to_tsvector(content) at
        # query time, say - would make the GIN index unusable AND would recompute per row what
        # the generated column already stores.
        predicates.append(or_(Post.search_vector.bool_op("@@")(tsq), Post.title.bool_op("%")(term)))

    return predicates


def _published_at_nullable(statuses: Sequence[PostStatus] | None) -> bool:
    """Report whether a status scope can admit a row whose ``published_at`` is ``NULL``.

    Args:
        statuses: The lifecycle states a listing includes, or ``None`` for every state.

    Returns:
        ``False`` only when the scope is exactly
        :attr:`~app.models.post.PostStatus.PUBLISHED`, because
        ``ck_posts_published_at_required`` makes a published row's publication instant
        mandatory. ``True`` otherwise - including for ``None``, and including for
        :attr:`~app.models.post.PostStatus.ARCHIVED`, which *may* carry an instant but is not
        guaranteed to by any constraint.

    Note:
        This reads a database invariant; it does not restate one. Nothing is added to the
        ``WHERE`` clause on the strength of this answer - the only thing that changes is
        whether the recency ordering has to name a position for ``NULL``, and where no ``NULL``
        can occur the two spellings return identical rows. :func:`_recency_ordering` explains
        why that distinction is worth making.
    """
    if statuses is None:
        return True
    return any(status is not PostStatus.PUBLISHED for status in statuses)


def _recency_ordering(*, nulls_possible: bool) -> ColumnElement[Any]:
    """Build the ``published_at`` descending clause, naming a ``NULL`` position only if needed.

    Args:
        nulls_possible: Whether the listing's status scope can yield a ``NULL``
            ``published_at``, as determined by :func:`_published_at_nullable`.

    Returns:
        ``posts.published_at DESC``, with ``NULLS LAST`` appended when a ``NULL`` can occur.

    Note:
        The two spellings are not interchangeable to the planner, which is the entire reason
        this is a function rather than one expression. ``ix_posts_status_published_at`` is
        declared ``(status, published_at DESC)``, and a ``DESC`` index column orders ``NULL``
        **first** by PostgreSQL's default. ``ORDER BY published_at DESC NULLS LAST`` therefore
        does not match that index and forces a sort over the whole matching set - on the home
        page's primary query, which is the one query that must be cheap.

        Where a ``NULL`` is impossible - the public feed, the public profile - the plain form is
        emitted, matches the index, and was measured to plan as ``Index Scan using
        ix_posts_status_published_at`` at seeded volume. Where drafts are in scope - the author
        workspace, the administrative table - ``NULLS LAST`` is emitted because an unpublished
        post genuinely needs a defined position and those surfaces are not the hot path.
    """
    ordering = Post.published_at.desc()
    return ordering.nulls_last() if nulls_possible else ordering


def _build_ordering(
    *,
    term: str,
    tsq: Function[Any] | None,
    sort: PostSort,
    nulls_possible: bool,
) -> list[ColumnElement[Any]]:
    """Build the ``ORDER BY`` list for a listing.

    Args:
        term: The normalised search term; ``""`` when the caller is not searching.
        tsq: The compiled ``tsquery`` for ``term``, or ``None``. The same object
            :func:`_build_predicates` received, so ``@@`` and ``ts_rank`` share one bound
            parameter instead of binding the term twice.
        sort: ``"relevance"`` to lead with rank, ``"recent"`` to lead with recency.
        nulls_possible: Whether ``published_at`` can be ``NULL`` in this listing; forwarded to
            :func:`_recency_ordering`.

    Returns:
        The ordering clauses, in application order, always ending with a deterministic
        tiebreaker.

    Note:
        **``"relevance"`` without a term degrades to recency.** With nothing to rank against,
        ``ts_rank`` is constant and the ordering would collapse onto the tiebreaker alone -
        so the branch is taken on the presence of the term, not on the requested sort, and
        ``sort`` only chooses between two orderings that both make sense. That degradation is
        silent on purpose: ``?sort=relevance`` with an empty search box has one obvious
        reading, and a listing is the wrong place to reject it.

        **``NULLS LAST`` is applied only when a NULL is possible.** ``published_at`` is
        nullable, and a draft has none, so a listing that admits drafts must place them
        explicitly or leave their position to the planner. It is stated as ``NULLS LAST`` -
        an unpublished post sorts after every published one - and the caller signals which
        case it is by whether it narrows ``statuses`` to
        :attr:`~app.models.post.PostStatus.PUBLISHED` alone - see
        :func:`_published_at_nullable` and :func:`_recency_ordering`, where the index consequence
        of that choice is spelled out.

        **The last clause is always ``posts.id`` descending.** ``published_at`` is not unique -
        a seed run or a bulk publish stamps many rows from one transaction clock - and neither
        is a rank. Without a total order, two rows with equal keys can be returned by both page
        one and page two while a third is returned by neither, which is the classic
        overlapping-pagination defect. The primary key breaks every remaining tie, so the
        window is stable across requests and page two is provably disjoint from page one.
    """
    clauses: list[ColumnElement[Any]] = []
    recency = _recency_ordering(nulls_possible=nulls_possible)

    if term and tsq is not None:
        rank = func.ts_rank(Post.search_vector, tsq).desc()
        # Trigram similarity, the secondary key: it separates rows the full-text rank scores
        # equally - and it is the only key that meaningfully orders a row matched solely by the
        # fallback, whose ts_rank against a query it does not satisfy is zero.
        similarity = func.similarity(Post.title, term).desc()
        if sort == "relevance":
            clauses.extend([rank, similarity, recency])
        else:
            # sort == "recent" with a term: newest first, with rank and similarity deciding
            # only between posts that share a publication instant.
            clauses.extend([recency, rank, similarity])
    else:
        clauses.append(recency)

    clauses.append(Post.id.desc())
    return clauses


def _with_relations[SelectT: Select[Any]](stmt: SelectT) -> SelectT:
    """Attach the eager loaders every rendered post needs, preserving the statement's type.

    A feed card and a post page both show a byline and category badges, so ``author`` and
    ``categories`` are projected together and requested together. Under an ``AsyncSession``,
    touching either without having asked for it raises ``MissingGreenlet`` at the point of
    access - which is why the models keep the default lazy strategy and why the request is made
    in the statement instead.

    Args:
        stmt: Any ``SELECT`` over :class:`~app.models.post.Post`.

    Returns:
        The same statement with both loaders attached. Statements are generative, so the
        argument is not mutated.

    Note:
        ``selectinload`` for both, including the many-to-one ``author``. It issues one extra
        ``SELECT ... WHERE id IN (...)`` keyed on the parent keys and therefore multiplies no
        rows, so a windowed listing needs neither ``.unique()`` nor a hand-written count to
        correct for a fan-out. ``joinedload`` against ``categories`` would multiply rows and
        make the naive count wrong; using one strategy for both keeps that trap out of reach.

        Called at statement-build time rather than assigned to a module constant, and that is
        load-bearing: :func:`~sqlalchemy.orm.selectinload` inspects the mapper, which triggers
        registry configuration. Evaluating it at import time would make merely importing this
        module require a fully configured registry - so a partially generated model package, or
        an ``alembic`` command that only needs metadata, would fail on the import rather than on
        a query.
    """
    return stmt.options(selectinload(Post.author), selectinload(Post.categories))


def _restrict[SelectT: Select[Any]](
    stmt: SelectT,
    *,
    category_slug: str | None,
    predicates: Sequence[ColumnElement[bool]],
) -> SelectT:
    """Apply a listing's joins and filters to any ``SELECT`` rooted on ``posts``.

    The single most important function in this module, because it is called **twice** - once for
    the rows statement and once for the count statement - and is the only place either gains a
    join or a predicate. One code path means the two statements match by construction: there is
    no second copy of the filter set to keep in step, so ``total`` can only ever describe
    exactly the rows the window draws from.

    Args:
        stmt: ``select(Post)`` for the rows, or ``select(func.count(distinct(Post.id)))`` for
            the count. Both resolve their ``FROM`` to ``posts``, which is what lets one
            function join and filter either.
        category_slug: Restrict to posts filed under this category, or ``None`` for every
            category.
        predicates: The conjunction from :func:`_build_predicates`. An empty sequence adds no
            ``WHERE`` clause at all rather than a vacuous one.

    Returns:
        The narrowed statement, with the caller's static type preserved by the type parameter -
        so the count statement stays a ``Select[tuple[int]]`` and can be handed to
        :meth:`~app.repositories.base.BaseRepository.paginate` as its ``count_stmt`` without a
        cast.

    Note:
        The category filter is an explicit two-step join through the association relation
        rather than a relationship-based ``any()``. That keeps it composable with everything
        else in the statement, loads no ``Category`` entity, and is served by the
        ``post_categories`` composite primary key together with
        ``ix_post_categories_category_id``.

        ``Category.slug`` is ``CITEXT``, so the comparison is case-insensitive at the database
        level and there is deliberately **no** ``lower()`` on either side. Applying one would
        do two kinds of damage at once: it would make the unique ``citext`` index on
        ``categories.slug`` unusable, and it would re-implement in Python a guarantee the column
        type already provides.
    """
    if category_slug is not None:
        stmt = stmt.join(post_categories, post_categories.c.post_id == Post.id).join(
            Category, Category.id == post_categories.c.category_id
        )
        stmt = stmt.where(Category.slug == category_slug)

    if predicates:
        stmt = stmt.where(*predicates)

    return stmt


class PostRepository(BaseRepository[Post]):
    """Every query the ``posts`` relation needs, and no query anything else needs.

    Constructed per request from the session ``get_db`` yields, or in the suite from the
    transactional fixture::

        repository = PostRepository(session)
        rows, total = await repository.list_posts(q="fastapi", limit=12, offset=0)

    Inherited from :class:`~app.repositories.base.BaseRepository` and **not** re-implemented
    here, because a second definition of any of them is a second definition of a rule:

    ``get_by_id``
        The one identity predicate in the codebase, replacing the three hand-written copies the
        retired service carried at ``app.py:L28-29``, ``L36-37`` and ``L45-46``.
    ``add``
        Creation. The service supplies a title, the derived slug and the sanitised body; the
        database supplies ``id``, ``created_at``, ``updated_at``, the ``DRAFT`` status and the
        search vector.
    ``save``
        Partial update, and both publish transitions. The service assigns ``status`` and
        ``published_at`` together - the CHECK constraint is what makes assigning only one
        impossible - and the mandatory ``refresh`` inside ``save`` is what stops the regenerated
        ``search_vector`` and ``updated_at`` coming back expired.
    ``delete`` / ``delete_by_id``
        Removal. ``ON DELETE CASCADE`` on ``comments``, ``post_likes`` and ``post_categories``
        takes the dependents, so nothing here deletes them by hand.
    ``exists`` / ``count`` / ``get_or_none`` / ``paginate``
        The generic primitives. :meth:`count_posts` and every listing below are thin,
        argument-shaped uses of the last two.
    """

    model = Post
    """Binds the inherited generic helpers to the ``posts`` relation."""

    async def list_posts(
        self,
        *,
        q: str | None = None,
        category_slug: str | None = None,
        author_id: uuid.UUID | None = None,
        statuses: Sequence[PostStatus] | None = (PostStatus.PUBLISHED,),
        sort: PostSort = DEFAULT_POST_SORT,
        limit: int,
        offset: int,
    ) -> tuple[Sequence[Post], int]:
        """List posts with search, category filtering, author filtering, ordering and windowing.

        The one composed query behind all four listing surfaces. Each argument narrows the
        result independently, so any combination is valid and the caller's surface is expressed
        entirely by which arguments it passes:

        ============================ ===========================================================
        Surface                      Arguments
        ============================ ===========================================================
        Public home feed             ``q``, ``category_slug``, ``sort``, ``page`` - and the
                                     default ``statuses``, which is what keeps drafts out
        Public author profile        ``author_id`` plus ``statuses=(PostStatus.PUBLISHED,)``
        Author workspace             ``author_id`` plus ``statuses=None``, or one state per tab
        Administrative posts table   ``statuses=None``, optionally with any other filter
        ============================ ===========================================================

        Args:
            q: Free-text search term. Ranked full-text matching over title, excerpt and body,
                OR-ed with typo-tolerant trigram matching on the title. Whitespace-only and
                ``None`` are equivalent, and punctuation is safe - see :func:`_search_query`.
            category_slug: Case-insensitive category slug to filter by, or ``None``.
            author_id: The author's server-generated UUID, or ``None``. A username is resolved
                to an id by ``UserRepository.get_by_username`` in the service, which also owns
                the not-found error for an author who does not exist.
            statuses: The lifecycle states to include. Defaults to
                :attr:`~app.models.post.PostStatus.PUBLISHED` alone, which is the safe default
                for the surface that has the most callers; ``None`` means every state and is
                what the administrative table passes. **This is an argument, never a decision
                taken here** - authority belongs to ``app.services.post_service``.
            sort: ``"recent"`` (the default) or ``"relevance"``. With no search term,
                ``"relevance"`` degrades to recency rather than raising.
            limit: Rows per page. Non-positive yields no rows rather than an invalid ``LIMIT``;
                request-supplied values are bounded well before they arrive here.
            offset: Rows to skip. An offset past the end returns an empty sequence beside the
                real ``total``, never an error, which is how a client detects it has run off
                the end.

        Returns:
            ``(rows, total)`` - the entities on this page with ``author`` and ``categories``
            already loaded, and how many rows match in total ignoring the window.
            Deliberately not a ``Page``: the service projects the rows into response schemas
            and calls ``build_page(list(rows), total, page, page_size)``.

        Note:
            **Two statements, one predicate set.** :func:`_restrict` applies the joins and
            filters to the rows select and to the count select, so nothing is restated and the
            two cannot disagree. The count is ``count(DISTINCT posts.id)`` because the category
            filter joins through ``post_categories``; the association's composite primary key
            makes duplicate filing impossible, so a single-category filter cannot in fact
            multiply rows today, but ``DISTINCT`` makes ``total`` correct by construction rather
            than by relying on that. It is passed to
            :meth:`~app.repositories.base.BaseRepository.paginate` as ``count_stmt`` so the
            primitive does not derive a naive count of its own.

            **One ``tsquery``, built once.** The compiled query is shared between the predicate
            and the ranking, so the term is bound once rather than twice and the two can never
            be built with different configurations.

            **Loaders on the rows statement only.** An ORM loader option on a statement whose
            rows are never fetched is work with no output.
        """
        term = _normalise_term(q)
        # Built once here and threaded into BOTH builders. Two separate constructions would
        # bind the same term twice and would leave open the possibility of one of them being
        # given a different text-search configuration.
        tsq = _search_query(term) if term else None

        predicates = _build_predicates(term=term, tsq=tsq, author_id=author_id, statuses=statuses)

        rows_stmt = _restrict(
            select(Post), category_slug=category_slug, predicates=predicates
        ).order_by(
            *_build_ordering(
                term=term,
                tsq=tsq,
                sort=sort,
                nulls_possible=_published_at_nullable(statuses),
            )
        )
        rows_stmt = _with_relations(rows_stmt)

        # No ORDER BY, no LIMIT/OFFSET and no loader options: none of them changes a count, and
        # the sort PostgreSQL would perform for a result nobody reads is pure cost.
        count_stmt = _restrict(
            select(func.count(distinct(Post.id))),
            category_slug=category_slug,
            predicates=predicates,
        )

        return await self.paginate(rows_stmt, limit=limit, offset=offset, count_stmt=count_stmt)

    async def list_by_author(
        self,
        author_id: uuid.UUID,
        *,
        statuses: Sequence[PostStatus] | None = None,
        limit: int,
        offset: int,
    ) -> tuple[Sequence[Post], int]:
        """List one author's posts, delegating entirely to :meth:`list_posts`.

        A named shorthand for the public profile and the author workspace, both of which are
        author-scoped and neither of which searches or filters by category. It contains no
        statement of its own - every listing surface in the product routes through the one
        composition, which is what keeps the index usage of all of them identical.

        Args:
            author_id: The author's server-generated UUID.
            statuses: The lifecycle states to include. **Defaults to ``None``, which means
                every state, including drafts.** That default is correct for the author
                workspace and wrong for anything public: the public profile must pass
                ``statuses=(PostStatus.PUBLISHED,)`` explicitly, and
                ``app.services.profile_service`` is where that hard filter belongs. This
                method will not choose it, because choosing who may see a draft is an
                authority decision and authority does not live in the data layer.
            limit: Rows per page.
            offset: Rows to skip.

        Returns:
            ``(rows, total)``, exactly as :meth:`list_posts` returns it.
        """
        return await self.list_posts(
            author_id=author_id, statuses=statuses, limit=limit, offset=offset
        )

    async def get_by_slug(self, slug: str, *, with_relations: bool = True) -> Post | None:
        """Fetch one post by its canonical slug.

        Resolves ``GET /api/v1/posts/{slug}`` and the ``/blog/[slug]`` route - a single probe of
        the unique index ``ix_posts_slug``.

        Args:
            slug: The slug from the URL. ``posts.slug`` is ``CITEXT``, so matching is
                case-insensitive at the database level and **no** ``lower()`` is applied to
                either side: doing so would make the unique index unusable and would duplicate
                in Python what the column type already guarantees.
            with_relations: Load ``author`` and ``categories`` eagerly, which is what a rendered
                post page needs. Pass ``False`` when only the row's own columns are wanted - an
                existence or ownership check, say - to save two round trips.

        Returns:
            The post, or ``None`` when no row carries that slug.

        Note:
            **This method does not filter by status, and must not.** A draft has to be fetchable
            here so that ``app.services.post_service`` can apply the actual rule - a draft is
            readable by its author or by an administrator, and is a ``404`` to everyone else.
            Hard-filtering to
            :attr:`~app.models.post.PostStatus.PUBLISHED` inside this method would make that
            rule impossible to express: the service would receive ``None`` for a draft the
            caller is entitled to read, and the author would be locked out of previewing their
            own unpublished work. Draft confidentiality on the *public* surfaces is delivered by
            the ``statuses`` argument to :meth:`list_posts`, which every public listing narrows.
        """
        stmt = select(Post).where(Post.slug == slug)
        if with_relations:
            stmt = _with_relations(stmt)

        result = await self.session.execute(stmt)
        return result.scalars().first()

    async def get_for_update(self, post_id: uuid.UUID) -> Post | None:
        """Fetch one post by primary key, holding a row lock until the transaction ends.

        The first step of every mutating use case in ``app.services.post_service`` - update,
        delete, publish and unpublish. ``SELECT ... FOR UPDATE`` serialises concurrent writers
        on one row, so two requests that both read a draft and both decide to publish it cannot
        interleave between the read and the write: the second blocks until the first commits or
        rolls back, then observes the outcome.

        Args:
            post_id: The post's server-generated UUID.

        Returns:
            The locked post, or ``None`` when no row carries that key. Absence is not an error
            here - the service turns it into a ``404``.

        Note:
            **No eager loaders are attached, deliberately.** The point of the statement is a
            lock over exactly one row of ``posts``. The publish and delete paths need the row's
            own columns and nothing else, and a caller that does need the relations should fetch
            them with :meth:`get_by_slug` or :meth:`get_by_id` once the transition is decided,
            rather than widening the locked footprint.

            **The row is re-read rather than served from the identity map.** An ORM ``SELECT``
            leaves an already-loaded instance's attributes untouched by default, so without
            ``populate_existing`` a caller could take the lock and then make its decision from a
            stale in-session copy - which is exactly the hazard the lock was acquired to remove.
            The execution option makes the returned entity reflect the row as it stands under
            the lock.

            :meth:`~app.repositories.base.BaseRepository.get_by_id` remains the right call for
            an unlocked read; this is not a second identity predicate but the same lookup with a
            lock, expressed as a ``select()`` because
            :meth:`~sqlalchemy.ext.asyncio.AsyncSession.get` would consult the identity map and
            could return without touching the database at all - taking no lock.
        """
        stmt = (
            select(Post)
            .where(Post.id == post_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        result = await self.session.execute(stmt)
        return result.scalars().first()

    async def slugs_starting_with(self, prefix: str) -> set[str]:
        """Return every existing slug that begins with ``prefix``.

        The ``taken`` set ``app.core.slug.unique_slug`` needs: it derives a candidate from the
        title, and if that candidate is already present it suffixes until it is not. Answering
        "which of this family exist" in one round trip is what lets uniqueness be reached before
        the INSERT rather than by catching the unique violation and retrying.

        Args:
            prefix: The literal slug stem, typically the un-suffixed derivation of a title.
                ``LIKE`` metacharacters in it are neutralised by :func:`_escape_like_prefix`,
                so the argument is matched as literal text.

        Returns:
            The matching slugs. Empty when the stem is free, which is the common case.

        Note:
            Only the ``slug`` column is projected - no entity is constructed, no identity-map
            entry is created, and the wide ``posts`` row with its body and search vector never
            crosses the wire.

            The pattern is anchored at the start, never with a leading wildcard, so a b-tree
            index can serve it. ``posts.slug`` is ``CITEXT`` and its unique index carries the
            default operator class, so whether PostgreSQL actually chooses that index for a
            prefix ``LIKE`` depends on the operator class rather than on this statement; what
            the anchoring guarantees is that the query is not *prevented* from using it. The
            result set is a slug family - a handful of rows - so the plan is not on any hot
            path either way.

            Slug **derivation** is ``app.core.slug``'s and is not imported here: this method
            reports what exists, and the service decides what to call the new post.
        """
        pattern = _escape_like_prefix(prefix) + "%"
        result = await self.session.execute(
            select(Post.slug).where(Post.slug.like(pattern, escape=_LIKE_ESCAPE))
        )
        return set(result.scalars().all())

    async def count_posts(self, *, statuses: Sequence[PostStatus] | None = None) -> int:
        """Count posts, optionally narrowed to a set of lifecycle states.

        Feeds the aggregate figures on ``GET /api/v1/admin/stats``, and any standalone total a
        service needs - the number of published articles the sitemap will enumerate, for
        instance.

        Args:
            statuses: The lifecycle states to count, or ``None`` to count every post regardless
                of state. ``None`` is the default because the administrative overview asks for
                the whole relation.

        Returns:
            The number of matching rows; ``0`` when nothing matches.

        Note:
            Delegates to :meth:`~app.repositories.base.BaseRepository.count`, which emits
            ``SELECT count(*)`` with no entity construction. It is deliberately not built on
            :meth:`list_posts`: a count needs neither a window, an ordering nor a loader
            option, and asking a listing for a total would pay for all three.
        """
        if statuses is None:
            return await self.count()
        return await self.count(Post.status.in_(statuses))
