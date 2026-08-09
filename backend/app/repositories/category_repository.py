"""Every SQL statement the ``categories`` taxonomy needs, and nothing else.

This module is the sole home of the queries behind the category taxonomy: the slug lookup a
canonical URL resolves through, the windowed listing **both** category collections page through,
the counted listing that supplies the tally rendered beside every term, the un-paginated listing a
bulk membership check indexes in memory, the prefix scan that feeds slug de-duplication, and the
in-use probe that a delete is refused on. ``app.services.category_service`` and
``app.services.admin_service`` are the only callers; nothing above them ever composes a
statement of its own.

Why the entity exists at all
----------------------------
Nothing in the original service named it. The stated requirements were "category filters" on
the home feed and an administrative screen "managing ... categories", but the thing being
filtered and managed was never spelled out - so the taxonomy is an *implicit* requirement that
two explicit features rest on, and this module is the data-access half of it.

Aggregate, not N+1
------------------
:meth:`CategoryRepository.list_with_post_counts` is the reason this module exists in the shape
it does. ``GET /api/v1/categories`` renders a post count beside every filter chip, and the
obvious implementation - list the categories, then count each one's posts - issues one statement
per category and grows linearly with the taxonomy. That is forbidden here. The count is a single
``LEFT OUTER JOIN`` with a ``GROUP BY``, so the whole counted taxonomy costs exactly one round
trip however many terms it holds, and the method is covered by a test that asserts precisely
one statement was emitted.

Two details of that statement are load-bearing rather than stylistic:

* **The joins are OUTER.** A category nobody has filed a post under must still appear, with a
  count of ``0``. An inner join would silently drop it from the filter control, which is a
  missing chip rather than an error and would therefore never be noticed.
* **The status predicate sits in the ON clause, never in WHERE.** Restricting to
  ``status = PUBLISHED`` in a ``WHERE`` clause discards the rows an outer join manufactured for
  the unmatched categories, collapsing the outer join back into an inner one and losing every
  zero-count term. Putting the predicate in the join condition keeps the row and nulls the
  post, which is what makes ``count(posts.id)`` return ``0`` for it.

No ``DISTINCT`` is needed and none is applied. ``post_categories`` is keyed on
``(post_id, category_id)``, so a post can be filed under a category at most once and the join
cannot multiply a pair - the composite primary key is what makes the plain count exact.

Deleting a term is a locked sequence, not a probe
------------------------------------------------
"A category in use may not be deleted" is a rule about two relations at once, so it cannot be
enforced by a single statement and it cannot be enforced by a check alone.
:meth:`~CategoryRepository.is_in_use` answers a question about ``post_categories``; the delete
acts on ``categories``; and PostgreSQL's ``ON DELETE CASCADE`` on
``post_categories.category_id`` means the delete *succeeds* even when the answer has changed
since it was given, silently removing a filing that arrived in between. A post loses a category
and nothing reports it.

``app.services.category_service`` therefore performs three steps in one transaction, in this
order, and this module exists to make each of them possible rather than to sequence them:

1. :meth:`~CategoryRepository.get_for_update` - ``SELECT ... FOR UPDATE``, which takes the row
   lock. A concurrent ``INSERT`` into ``post_categories`` needs ``FOR KEY SHARE`` on the same
   row to validate its foreign key, and that conflicts with ``FOR UPDATE``, so the filing blocks
   here rather than slipping between the next two steps.
2. :meth:`~CategoryRepository.is_in_use` - asked under that lock, where its answer stays true
   for as long as the transaction holds it.
3. :meth:`~app.repositories.base.BaseRepository.delete` - reached only when the answer was
   ``False``.

Verified against PostgreSQL 18.4. Nothing here orders those steps or chooses the error when step
two says ``True``; both belong to the service, for the reason the next section gives.

Nothing here raises, and nothing here decides
---------------------------------------------
Absence is reported as ``None`` (:meth:`~CategoryRepository.get_by_slug`,
:meth:`~CategoryRepository.get_by_name`), as ``False``
(:meth:`~CategoryRepository.is_in_use`), as ``0``
(:meth:`~CategoryRepository.count_categories`) or as an empty collection
(:meth:`~CategoryRepository.list_all`, :meth:`~CategoryRepository.list_paginated`,
:meth:`~CategoryRepository.slugs_starting_with`). No HTTP status code is chosen, no framework
HTTP exception is constructed and no domain exception is emitted. The service this schema
replaces did the opposite: it constructed a framework not-found exception, complete with its
status code and its detail string, from inside the data-access loop itself, three separate
times - ``app.py:L31``, ``app.py:L40`` and ``app.py:L49`` - so the same policy decision was
written once per call site and the read path could not be reused by anything that wanted a
different answer.

Three decisions in particular belong a layer up and are deliberately absent here:

* **Whether a missing category is a ``404``.** ``category_service`` decides that.
* **Whether an in-use category may be deleted.** :meth:`~CategoryRepository.is_in_use` answers
  the question; ``category_service`` raises ``ConflictError`` on the answer.
* **Which slug a new or renamed category gets.** Derivation lives in ``app/core/slug.py``,
  which this module does not import. :meth:`~CategoryRepository.slugs_starting_with` supplies
  the ``taken`` set its ``unique_slug`` consumes, and the two are composed by the service.

``status`` is likewise a filter *argument* and never an authority decision. This module does
not know who is asking, so it cannot and does not judge whether the caller may see drafts.

Nothing here commits
--------------------
Every write in this package ends at ``flush()``. ``get_db`` in ``app/core/dependencies.py`` yields
one request-scoped session and rolls it back on an exception, the service orchestrating a use
case owns the commit so a multi-step operation stays one transaction, and
``backend/tests/conftest.py`` wraps each test in a transaction it rolls back afterwards. This
module adds no write of its own: creating, renaming and deleting a category all go through
:meth:`~app.repositories.base.BaseRepository.add`, ``save`` and ``delete``, inherited unchanged.

Deleting is inherited for a second reason too. ``post_categories.category_id`` carries
``ON DELETE CASCADE``, so removing a category removes its filings in the statement PostgreSQL
itself issues. There is no hand-written child delete anywhere in this module, and there must
never be one: a rule with two definitions is a rule whose copies drift.

The pagination contract
-----------------------
:meth:`~CategoryRepository.list_paginated` returns a plain ``(rows, total)`` tuple, exactly as
:meth:`~app.repositories.base.BaseRepository.paginate` does. It does **not** build the ``Page``
envelope and this module does not import ``app/core/pagination.py`` at all. ``Page`` is a wire
shape, and keeping wire shapes out of the data layer is what layered separation means in
practice; the service projects the rows into response models and calls its ``build_page`` helper to
produce the five-field envelope (``items``, ``total``, ``page``, ``page_size``, ``pages``) that
every list endpoint serialises.

Index alignment
---------------
Every statement below is served by a named index, which is the whole point of moving the system
of record into PostgreSQL - the store this replaces had no index of any kind, and every
addressed operation was a linear scan in which a miss always traversed the whole collection.

* :meth:`~CategoryRepository.get_by_slug` - the unique ``citext`` index ``ix_categories_slug``.
* :meth:`~CategoryRepository.get_by_name` - the unique constraint ``uq_categories_name``.
* :meth:`~CategoryRepository.slugs_starting_with` - ``ix_categories_slug_trgm``, through an
  anchored prefix pattern rather than a containment one, so the scan is bounded to one slug family.
  Not ``ix_categories_slug``: that index carries the default operator class over a ``citext``
  column, which serves equality and cannot serve a pattern however the pattern is anchored.
* :meth:`~CategoryRepository.get_for_update` - ``pk_categories``, addressed for equality and
  locked with ``FOR UPDATE``.
* :meth:`~CategoryRepository.is_in_use` - ``ix_post_categories_category_id``, which exists for
  exactly this direction of the relation.
* :meth:`~CategoryRepository.list_with_post_counts` - ``pk_post_categories`` and
  ``ix_post_categories_category_id`` for the two join steps, and
  ``ix_posts_status_published_at`` for the status predicate on the joined side, which is the
  same composite index the home feed's "recent published posts" ordering is built on.
* :meth:`~CategoryRepository.list_all` and :meth:`~CategoryRepository.list_paginated` sort by
  ``name``, which has its own unique index; the administrative text filter is a containment match,
  served by the two GIN trigram indexes ``ix_categories_name_trgm`` and
  ``ix_categories_slug_trgm``, which revision ``0002`` builds. Those two also serve the anchored
  family scan in :meth:`~CategoryRepository.slugs_starting_with`, which no b-tree over a ``citext``
  column can answer - see "Case sensitivity is the column's business" below for why the slug side
  of both predicates is written against the text cast.

Case sensitivity is the column's business
-----------------------------------------
``categories.slug`` is ``CITEXT`` with a unique index, so PostgreSQL compares it
case-insensitively and ``/blog/category/Python`` and ``/blog/category/python`` resolve to one
category. Nothing here lower-cases a value or wraps a column in SQL ``LOWER``, and that is a
correctness requirement rather than a preference: wrapping the column would make the predicate
non-sargable and the unique index unusable, turning an index lookup into a sequential scan
while duplicating a guarantee the column type already provides.

The two **pattern** predicates are the exception, and they prove the rule rather than break it.
:meth:`~CategoryRepository.list_paginated`'s containment search and
:meth:`~CategoryRepository.slugs_starting_with`'s family scan compare ``slug::text``, not ``slug``,
because ``ix_categories_slug_trgm`` is a GIN trigram index over that expression - and it has to be,
since ``gin_trgm_ops`` is defined over ``text`` while citext's own ``~~``/``~~*`` operators are not
in that operator family, so an index on the bare column would be accepted by PostgreSQL and never
chosen. Neither predicate is an equality lookup, so neither had a usable index to give up; the cast
is what gives them one. And because casting to ``text`` discards precisely the case-folding the
column type was providing, both are written with ``ILIKE``, which restores it - so the result sets
are identical to the pre-cast ones, verified on PostgreSQL 18.4 against mixed-case stored slugs.
The equality lookups in :meth:`~CategoryRepository.get_by_slug` and
:meth:`~CategoryRepository.get_by_name` compare the columns themselves and are untouched.

Async only
----------
Every method awaits ``self.session.execute(...)``, SQLAlchemy 2.0 style. No method projects
:attr:`app.models.category.Category.posts`, so no loader option is attached; a future method
that did project it would have to request ``selectinload`` in the statement, because reading an
unloaded collection under an ``AsyncSession`` raises ``MissingGreenlet`` at the point of access
rather than quietly issuing another query.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Final

from sqlalchemy import ColumnElement, Text, and_, cast, func, literal, or_, select

from app.models.category import Category, post_categories
from app.models.post import Post, PostStatus
from app.repositories.base import UUIDPrimaryKeyRepository

__all__ = ["CategoryRepository"]

_LIKE_ESCAPE_CHARACTER: Final[str] = "\\"
"""Escape character declared on every ``LIKE``/``ILIKE`` this module emits.

PostgreSQL happens to use a backslash by default, but the default is a server setting rather
than a guarantee, so each pattern names its escape character explicitly through SQLAlchemy's
``escape=`` argument. Stating it is what makes :func:`_escape_like_wildcards` and the rendered
``ESCAPE`` clause provably agree instead of coincidentally agreeing.
"""


def _escape_like_wildcards(term: str) -> str:
    """Neutralise the pattern metacharacters in a caller-supplied ``LIKE`` operand.

    ``%`` and ``_`` are wildcards inside a ``LIKE`` pattern, so a category named ``100% Rust``
    or a slug base derived from a title containing an underscore would otherwise widen the
    match well beyond what the caller asked for - ``100%`` matching every name that starts with
    ``100``, and ``a_b`` matching ``axb``. Both are escaped here, and the escape character
    itself is escaped **first** so that a literal backslash in the term cannot consume the
    escape of whatever follows it.

    Args:
        term: The raw text to be embedded in a pattern. Any string is acceptable, including an
            empty one.

    Returns:
        The same text with ``\\``, ``%`` and ``_`` each prefixed by
        :data:`_LIKE_ESCAPE_CHARACTER`, ready to be surrounded by whichever wildcards the
        caller genuinely intends.

    Note:
        Order matters and is not interchangeable. Escaping ``%`` before ``\\`` would turn
        ``50%`` into ``50\\%`` and then into ``50\\\\%``, which matches a literal backslash
        followed by any sequence - the opposite of the intent.
    """
    escaped = term.replace(_LIKE_ESCAPE_CHARACTER, _LIKE_ESCAPE_CHARACTER * 2)
    escaped = escaped.replace("%", f"{_LIKE_ESCAPE_CHARACTER}%")
    return escaped.replace("_", f"{_LIKE_ESCAPE_CHARACTER}_")


class CategoryRepository(UUIDPrimaryKeyRepository[Category]):
    """Data access for the ``categories`` taxonomy and its ``post_categories`` filings.

    Constructed per request from the session ``get_db`` yielded, and consumed only by
    ``app.services.category_service`` and ``app.services.admin_service``::

        repository = CategoryRepository(session)

        # GET /api/v1/categories and GET /api/v1/admin/categories - one windowed statement,
        # and one aggregate for the tallies. Never one count per row.
        rows, total = await repository.list_paginated(q=None, limit=20, offset=0)
        counted = await repository.list_with_post_counts()

        # Creating a category: the service derives the slug, this class stores it.
        base = slugify_title(payload.name)
        slug = unique_slug(base, await repository.slugs_starting_with(base))
        category = await repository.add(Category(name=payload.name, slug=slug))

    Seven inherited members carry the generic mechanics and none of them is re-implemented
    here: :meth:`~app.repositories.base.BaseRepository.get_by_id` is the one identity predicate
    in the codebase, :meth:`~app.repositories.base.BaseRepository.get_or_none` is the
    natural-key lookup :meth:`get_by_slug` and :meth:`get_by_name` delegate to,
    :meth:`~app.repositories.base.BaseRepository.count` is the total
    :meth:`count_categories` delegates to,
    :meth:`~app.repositories.base.BaseRepository.add` creates,
    :meth:`~app.repositories.base.BaseRepository.save` renames,
    :meth:`~app.repositories.base.BaseRepository.delete` removes - relying on
    ``ON DELETE CASCADE`` for the filings, which is exactly why it must be reached through
    :meth:`get_for_update` and :meth:`is_in_use` rather than on its own - and
    :meth:`~app.repositories.base.BaseRepository.paginate` windows for
    :meth:`list_paginated`.

    One inherited member is deliberately *not* used.
    :meth:`~app.repositories.base.BaseRepository.exists` builds its probe with
    ``select_from(self.model)``, which is ``categories``; :meth:`is_in_use` has to probe
    ``post_categories`` instead, so it composes its own ``EXISTS`` in the same shape rather than
    bending the inherited one to a table it was never scoped to.

    Instances are cheap, hold no cached state and are exactly as concurrency-safe as the
    ``AsyncSession`` they wrap - which is to say they must not be shared between concurrent
    tasks, because an ``AsyncSession`` is one unit of work over one connection.
    """

    model = Category
    """The mapped class this repository reads and writes.

    Satisfies the ``model: type[ModelT]`` contract :class:`~app.repositories.base.BaseRepository`
    declares, and is what its inherited statements resolve their ``FROM`` clause against.
    """

    async def get_by_slug(self, slug: str) -> Category | None:
        """Resolve one category by the slug that appears in its URL.

        The read behind ``GET /api/v1/categories/{slug}`` and behind the home feed's category
        filter, which addresses a category by slug rather than by identifier so the filtered
        feed has a linkable, crawlable URL.

        Args:
            slug: The URL segment to resolve, in whatever case the caller received it.
                Compared as written: ``categories.slug`` is ``CITEXT``, so PostgreSQL does the
                case-insensitive comparison and ``Web-Dev`` finds the row stored as
                ``web-dev``.

        Returns:
            The category, or ``None`` when no row carries that slug. Absence is not an error
            here; ``category_service`` decides whether it means ``404``.

        Note:
            No case-folding function on either side, and none may be added. Wrapping the
            column in a
            function makes the predicate non-sargable, so the unique ``citext`` index
            ``ix_categories_slug`` could no longer serve the lookup - and the lower-casing would
            duplicate a guarantee the column type already enforces for every writer rather than
            only for this one.
        """
        return await self.get_or_none(Category.slug == slug)

    async def get_by_name(self, name: str) -> Category | None:
        """Resolve one category by its display name.

        The pre-check ``category_service`` performs before creating or renaming a category, so
        the ordinary collision path produces a clear ``409`` instead of surfacing a raw
        constraint violation.

        Args:
            name: The exact display name to look for. ``categories.name`` is ``TEXT``, so this
                comparison *is* case-sensitive - ``Python`` and ``python`` are two different
                names here, unlike two spellings of one slug.

        Returns:
            The category, or ``None`` when no row carries that name.

        Note:
            A pre-check is a convenience, never the guarantee. ``uq_categories_name`` remains
            the real one: between this read and the following insert another transaction may
            claim the name, so ``category_service`` still translates the resulting
            ``IntegrityError`` into a conflict. Treating this method as the guard would be a
            race condition wearing a guard's uniform.
        """
        return await self.get_or_none(Category.name == name)

    async def list_all(self) -> Sequence[Category]:
        """Return the entire taxonomy, ordered by display name.

        Unpaginated on purpose, and **not** the listing either category collection serves - both
        of those window through :meth:`list_paginated`. This one exists for the caller that needs
        the taxonomy as a lookup rather than as a page: ``post_service`` indexes it by identifier
        to validate every category a post is being filed under in one statement instead of probing
        once per identifier. A reference taxonomy is bounded by editorial effort rather than by
        user input, so reading all of it for that purpose has no growth curve to defend against.

        Returns:
            Every category, ascending by ``name``; an empty sequence when the taxonomy is
            empty, which is a legitimate state before the reference categories are seeded.

        Note:
            Ordering is applied in SQL rather than in Python so the sequence is already stable
            when it arrives. Use :meth:`list_with_post_counts` instead whenever the caller also
            needs the per-category totals; it returns the same rows in the same order and costs
            the same single round trip.
        """
        result = await self.session.execute(select(Category).order_by(Category.name.asc()))
        return result.scalars().all()

    async def published_post_count(
        self, category_id: uuid.UUID, *, status: PostStatus | None = PostStatus.PUBLISHED
    ) -> int:
        """Count the posts filed under **one** category.

        The targeted counterpart of :meth:`list_with_post_counts`, and the right call whenever a
        caller needs the tally for a category it already holds. Reading a single-category count out
        of the whole-taxonomy aggregate works, but it groups every category and joins every filing
        to answer a question about one row - which is the shape ``GET /api/v1/categories/{slug}``
        and every administrative create-or-update readback were paying for.

        Args:
            category_id: The category whose filings to count.
            status: Which lifecycle state to count, with the same meaning and the same public
                default as :meth:`list_with_post_counts`, so the two can never report a different
                number for the same category.

        Returns:
            The number of matching posts; ``0`` for a category with none, and ``0`` for an
            identifier that names no category at all - a count is not the place to discover that a
            row is missing, and every caller has already resolved the category before asking.

        Note:
            One statement, no entity. It counts over ``post_categories`` joined to ``posts`` and
            selects no column of either relation, so nothing is hydrated and nothing enters the
            session's identity map.

            The access path is ``ix_post_categories_category_id`` for the equality on
            ``category_id`` - the index that exists for exactly this direction of the association -
            and ``pk_posts`` for the join to the post. The status predicate sits in the ``WHERE``
            clause here rather than in an ``ON`` clause, and that difference from
            :meth:`list_with_post_counts` is deliberate: there is no outer join to preserve, so
            there are no null-extended rows a ``WHERE`` could discard.
        """
        criteria: list[ColumnElement[bool]] = [post_categories.c.category_id == category_id]
        if status is not None:
            criteria.append(Post.status == status)

        result = await self.session.execute(
            select(func.count())
            .select_from(post_categories)
            .join(Post, Post.id == post_categories.c.post_id)
            .where(*criteria)
        )
        counted = result.scalar()
        return 0 if counted is None else counted

    async def list_with_post_counts(
        self,
        *,
        status: PostStatus | None = PostStatus.PUBLISHED,
        category_ids: Sequence[uuid.UUID] | None = None,
    ) -> Sequence[tuple[Category, int]]:
        """Return categories paired with how many posts are filed under each.

        One statement, always - see "Aggregate, not N+1" in the module docstring. This is where
        every ``post_count`` in the API comes from: ``category_service`` turns these pairs into a
        tally map and attaches it to whichever categories it is projecting, which is how the single
        read, the public page and the administrative page all report the same figure at the cost of
        one aggregate rather than one count per row.

        Args:
            status: Which lifecycle state to count. Defaults to
                :attr:`~app.models.post.PostStatus.PUBLISHED`, so a public caller sees only
                what a public caller could actually reach - a chip promising three posts that
                turn out to be drafts is worse than no chip. Pass ``None`` to count posts in
                every state, which is the administrative view. Purely a filter: this module
                never decides who is entitled to which value.
            category_ids: Restrict the aggregate to these categories, or ``None`` for the whole
                taxonomy. The public filter control passes ``None`` deliberately - it renders a chip
                per category, so its enrichment set *is* the taxonomy, which is finite by editorial
                effort rather than by user input. A **paginated** caller must pass the identifiers
                on its page: aggregating the whole relation to enrich twenty rows defeats the page
                boundary the window just established, and the cost then grows with the taxonomy
                instead of with the page. An empty sequence is honoured as "no categories" and
                returns nothing, rather than being treated as "all".

        Returns:
            ``(category, count)`` pairs ascending by ``name``. Every category **in scope** appears,
            including those with no matching post, whose count is ``0``.

        Note:
            The predicate on ``status`` is applied in the ON clause of the join to ``posts``,
            not in a ``WHERE`` clause. That difference is the whole method: a ``WHERE`` would
            discard the null-extended rows the outer join produced for unmatched categories and
            silently drop every zero-count term from the filter control.

            ``count(posts.id)`` counts non-null values, so an unmatched outer join contributes
            ``0`` rather than ``1`` - which is exactly why the count is taken over the joined
            column and never over ``*``.

            ``GROUP BY categories.id`` is sufficient even though whole ``Category`` entities are
            selected: grouping by a relation's primary key makes every other column of that
            relation functionally dependent on the group, which PostgreSQL accepts. No
            ``DISTINCT`` is needed either, because the composite primary key on
            ``post_categories`` already forbids a duplicate pairing.

            The pairs come back through ``.tuples()`` so the element type is
            ``tuple[Category, int]`` rather than an untyped row, which is what keeps this - the
            one method here that selects more than a single entity - free of implicit ``Any``
            under strict type checking.
        """
        # The join to `posts` is conditional on the requested lifecycle state. Composing the ON
        # clause here, rather than appending a filter to the finished statement, is what keeps
        # zero-count categories in the result set.
        post_join: ColumnElement[bool] = post_categories.c.post_id == Post.id
        if status is not None:
            post_join = and_(post_join, Post.status == status)

        stmt = (
            select(Category, func.count(Post.id))
            .outerjoin(post_categories, post_categories.c.category_id == Category.id)
            .outerjoin(Post, post_join)
            .group_by(Category.id)
            .order_by(Category.name.asc())
        )
        # Narrowing goes in the WHERE clause on the CATEGORIES side, which is the one place it can
        # go without changing what the aggregate means: it removes whole groups rather than rows
        # within a group, so every category still in scope keeps its outer join and its zero.
        # Tested against `None` rather than for truth, because an empty sequence is a legitimate
        # request for nothing - a page with no rows to enrich - and `if category_ids:` would
        # silently promote it to the whole taxonomy.
        if category_ids is not None:
            stmt = stmt.where(Category.id.in_(category_ids))

        result = await self.session.execute(stmt)
        return result.tuples().all()

    async def list_paginated(
        self, *, q: str | None = None, limit: int, offset: int
    ) -> tuple[Sequence[Category], int]:
        """Window the taxonomy, optionally filtered by text.

        Backs **both** category collections - the public ``GET /api/v1/categories`` and the
        administrator-only ``GET /api/v1/admin/categories`` - which reach it through the one
        service method ``CategoryService.list_paginated``. The two differ only in whether a ``q``
        arrives: every collection in this API answers with the page envelope, so the reader-facing
        control windows exactly as the management table does. Unlike :meth:`list_all`, which
        returns the taxonomy as a lookup for a bulk membership check, this is the surface a client
        pages through.

        Args:
            q: Optional search text, matched as a case-insensitive containment against both
                ``name`` and ``slug`` - an administrator looking for a term should find it by
                either spelling. ``None``, an empty string and whitespace alone all mean "no
                filter"; a blank search box must not be treated as a search for nothing.
                Wildcards in the text are escaped, so ``100%`` searches for that literal name.
            limit: Rows per page. Request-supplied values are already bounded to ``1..100`` by
                ``PageParams`` before they reach here.
            offset: Rows to skip.

        Returns:
            ``(rows, total)``: the categories on this page ascending by ``name``, and how many
            match the filter in total. Deliberately not a ``Page`` - the module docstring
            records why that wire shape belongs to the service layer.

        Note:
            An out-of-range page is not an error. An ``offset`` beyond ``total`` returns an
            empty sequence beside the real ``total``, which is how a client detects it has run
            off the end of the table.

            No explicit ``count_stmt`` is supplied, and none is needed: this statement joins
            nothing, so it cannot multiply rows and the count derived from it by
            :meth:`~app.repositories.base.BaseRepository.paginate` is exact by construction.

            ``ILIKE`` is a native PostgreSQL operator, so nothing here renders as a SQL
            ``LOWER`` call - which matters, because wrapping either column in a function is what
            would put the trigram indexes behind these two predicates out of reach.

            It is applied to both columns, but for different reasons on each. On ``name`` it states
            the case-insensitive intent over a plain ``TEXT`` column. On ``slug`` it is a
            requirement: that column is ``CITEXT`` and folded case for free, but the predicate is
            written against ``slug::text`` in order to match the expression
            ``ix_categories_slug_trgm`` is built on, and the cast discards the folding, so ``ILIKE``
            is what puts it back. The comment at each term records which case applies.
        """
        stmt = select(Category)

        term = q.strip() if q is not None else ""
        if term:
            pattern = f"%{_escape_like_wildcards(term)}%"
            stmt = stmt.where(
                or_(
                    # `name` is TEXT, so `ix_categories_name_trgm` is declared straight on the
                    # column and this predicate needs nothing added to reach it.
                    Category.name.ilike(pattern, escape=_LIKE_ESCAPE_CHARACTER),
                    # `slug` is CITEXT, and `ix_categories_slug_trgm` therefore indexes the text
                    # CAST: `gin_trgm_ops` is defined over `text`, and citext's own `~~`/`~~*`
                    # operators are not in that operator family, so an index on the bare column
                    # would be accepted by PostgreSQL and never chosen. The predicate is spelled
                    # the way the index is. `ilike` stays `ilike` and is now load-bearing rather
                    # than merely expressive - the cast discards citext's case-folding, so `like`
                    # here would silently become a case-sensitive search.
                    cast(Category.slug, Text).ilike(pattern, escape=_LIKE_ESCAPE_CHARACTER),
                )
            )

        return await self.paginate(stmt.order_by(Category.name.asc()), limit=limit, offset=offset)

    async def count_categories(self) -> int:
        """Count every category in the taxonomy.

        One of the aggregate figures ``GET /api/v1/admin/stats`` renders on the administrative
        overview screen, alongside the user, post and comment totals that
        ``app.services.admin_service`` gathers from the sibling repositories.

        Returns:
            The number of categories; ``0`` when the taxonomy is empty.

        Note:
            A thin delegation to :meth:`~app.repositories.base.BaseRepository.count`, and named
            rather than left to the caller for two reasons. ``admin_service`` composes four
            totals from four repositories, and ``await categories.count_categories()`` reads
            unambiguously at that call site where four bare ``count()`` calls would not. It
            also means the unfiltered count is stated once here, so a future definition of
            "counts for the overview" - excluding an archived term, say - has exactly one place
            to be applied.
        """
        return await self.count()

    async def slugs_starting_with(self, prefix: str) -> set[str]:
        """Return the existing slugs that begin with ``prefix``.

        The ``taken`` set ``unique_slug`` in ``app/core/slug.py`` consumes. ``category_service``
        derives a base slug from the name, calls this once, and hands both to ``unique_slug``,
        which appends an ascending numeric suffix until it finds a slug the set does not
        contain. Splitting it that way keeps the collision *policy* in ``app/core/slug.py`` -
        which this module does not import - and the *query* here, so the policy is unit-testable
        against a plain set with no database involved.

        Args:
            prefix: The base slug to scan for, typically the output of
                ``slugify_title(name)``. Wildcards are escaped, so a base containing ``%`` or
                ``_`` matches those characters literally and cannot widen the scan. An empty
                prefix legitimately matches every slug; the callers derive theirs from
                ``app/core/slug.py``, which never yields an empty base.

        Returns:
            The matching slugs exactly as stored, as a ``set``; empty when nothing matches. A
            set rather than a sequence because membership is the only question asked of it, and
            because ``unique_slug`` accepts any set-like collection.

        Note:
            Only the ``slug`` column is selected. No entity is constructed, no identity-map
            entry is created and no other column crosses the wire, which matters for a call
            made on the create-and-rename path.

            The pattern is anchored - ``'prefix%'`` - rather than written as a containment or a
            regular expression, so the scan is bounded to one slug family however large the
            taxonomy grows.

            **The column is cast to ``text`` and the operator is ``ILIKE``, and both are required
            rather than preferences.** Anchoring alone does not buy an index here: it means the
            query is not *prevented* from using one, but the default operator class over a
            ``citext`` column provides none for a pattern match, so this was a sequential scan over
            every category whatever ``ix_categories_slug`` did. ``ix_categories_slug_trgm`` is a
            GIN trigram index over ``(slug::text)`` - it has to be over the cast, because
            ``gin_trgm_ops`` is defined for ``text`` and citext's own ``~~``/``~~*`` operators are
            not in that operator family - and this predicate is spelled to match it.

            Two different questions, measured separately on PostgreSQL 18.4, because conflating
            them overstates what the index does. *Reachable*: over the cast this predicate plans as
            an ``Index Cond`` on ``ix_categories_slug_trgm``, while on the bare column no spelling
            reaches any index at all - and that holds at every size. *Preferred*: whether the
            planner picks the index over reading the table is a cost decision that arrives with
            volume. At five thousand terms it reads the table, which is the right call - scanning a
            small relation beats building a bitmap - and by a hundred and twenty thousand it takes
            the index.

            ``ILIKE`` rather than ``LIKE`` because the cast discards exactly the property that made
            the bare ``LIKE`` correct. On a ``citext`` column the match folded case for free, which
            is what ``unique_slug`` needs - it compares case-insensitively too, so a stored
            ``News-2`` must rule out a proposed ``news-2`` that PostgreSQL would reject at the
            unique index anyway. Over ``text`` that folding is gone, and ``ILIKE`` is what restores
            it: the returned set is identical to the pre-cast one, verified on 18.4 against
            mixed-case stored slugs.
        """
        pattern = f"{_escape_like_wildcards(prefix)}%"
        result = await self.session.execute(
            select(Category.slug).where(
                cast(Category.slug, Text).ilike(pattern, escape=_LIKE_ESCAPE_CHARACTER)
            )
        )
        return set(result.scalars().all())

    async def get_for_update(self, category_id: uuid.UUID) -> Category | None:
        """Fetch one category by primary key, holding a row lock until the transaction ends.

        **The first step of the delete path, and it is required rather than defensive.** Deleting
        a category is a check followed by a write - :meth:`is_in_use`, then
        :meth:`~app.repositories.base.BaseRepository.delete` - and without this lock another
        transaction can file a post under the category in the window between them. The check saw
        an unused term, the delete proceeds, and PostgreSQL's ``ON DELETE CASCADE`` on
        ``post_categories.category_id`` removes the filing that arrived in the meantime. Nothing
        fails, nobody is told, and a post silently loses a category - which is precisely the data
        loss the in-use check exists to prevent.

        ``SELECT ... FOR UPDATE`` closes that window, and it does so through the foreign key
        rather than through anything this repository writes. PostgreSQL takes ``FOR KEY SHARE``
        on the referenced ``categories`` row while it validates an ``INSERT`` into
        ``post_categories``, and ``FOR KEY SHARE`` conflicts with ``FOR UPDATE``. So a concurrent
        filing blocks on this lock until the deleting transaction ends, and then either finds the
        row gone - a foreign-key violation it can be told about - or proceeds against a category
        the delete declined to remove. Verified against PostgreSQL 18.4.

        Args:
            category_id: The category's server-generated UUID.

        Returns:
            The locked category, or ``None`` when no row carries that key. Absence is not an
            error here - the service turns it into a ``404``, which is also why the lookup and
            the lock are one statement: a category that does not exist cannot be locked, and
            distinguishing "absent" from "locked and unused" is the service's decision to make.

        Note:
            **Call this before :meth:`is_in_use`, and delete through the returned entity.** The
            lock only covers what happens after it is taken; probing first and locking afterwards
            reintroduces the same window one statement later.

            **No loader options.** The point of the statement is a lock over one row of
            ``categories``. Nothing on the delete path reads
            :attr:`~app.models.category.Category.posts` - :meth:`is_in_use` asks
            ``post_categories`` directly with an ``EXISTS`` and loads no collection - and widening
            the locked footprint to the filings would serialise readers of the taxonomy against
            each other for no gain.

            **The row is re-read rather than served from the identity map.** ``populate_existing``
            makes the returned entity reflect the row as it stands under the lock; without it a
            caller could take the lock and then decide from a stale in-session copy, which is the
            hazard the lock was acquired to remove.

            :meth:`~app.repositories.base.BaseRepository.get_by_id` remains the right call for an
            unlocked read - a rename, a single-category response - and this is not a second
            identity predicate but that same lookup with a lock. It is spelled as a ``select()``
            because :meth:`~sqlalchemy.ext.asyncio.AsyncSession.get` consults the identity map
            first and can return without touching the database, which would take no lock at all.
            ``app.repositories.post_repository`` carries the same method over ``posts`` for the
            same reason, and the two are deliberately identical in shape.
        """
        statement = (
            select(Category)
            .where(Category.id == category_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        result = await self.session.execute(statement)
        return result.scalars().first()

    async def is_in_use(self, category_id: uuid.UUID) -> bool:
        """Report whether any post is filed under this category.

        The question ``category_service`` asks before deleting a category. The *decision* is
        the service's: it raises ``ConflictError`` when the answer is ``True``, because
        silently unfiling a term from every post that used it is data loss dressed up as a
        successful delete. This method only answers.

        **It must be asked under the lock :meth:`get_for_update` takes.** On its own this is a
        non-locking probe, and a probe is a statement about the past: an association inserted
        after it returns ``False`` is still there when the delete runs, and the cascade on
        ``post_categories.category_id`` removes it without a word. The answer is only as current
        as the lock held while it is acted on, so the delete path is
        ``get_for_update`` -> ``is_in_use`` -> ``delete``, in that order, in one transaction.

        Args:
            category_id: The category to probe. A server-generated UUID, so it arrived either
                from an earlier read or from a path segment a route already validated. On the
                delete path it is the identifier of the row already locked.

        Returns:
            ``True`` when at least one row in ``post_categories`` references the category,
            ``False`` otherwise - including when no category carries that identifier at all.
            Never ``None``: the ``EXISTS`` form always yields exactly one row.

        Note:
            No row is loaded. The statement is
            ``SELECT EXISTS (SELECT true FROM post_categories WHERE category_id = :id)``, so
            PostgreSQL stops at the first match and reads only the index
            ``ix_post_categories_category_id`` - which exists for exactly this direction of the
            relation, since the composite primary key leads with ``post_id`` and a composite
            index cannot be read from its second column.

            ``category_id`` is *not* checked for existence first, and the two questions are
            genuinely separate: a category that does not exist is not in use, and conflating
            "absent" with "unused" here would hand the service a single boolean from which it
            could not tell a ``404`` from a legal delete.

            :meth:`~app.repositories.base.BaseRepository.exists` cannot be used, because it
            scopes its probe to ``self.model`` - ``categories`` - and the row being looked for
            lives in the association relation. This is the same ``EXISTS`` shape, pointed at
            the right table.
        """
        probe = (
            select(literal(True))
            .select_from(post_categories)
            .where(post_categories.c.category_id == category_id)
        )
        result = await self.session.execute(select(probe.exists()))
        return bool(result.scalar())
