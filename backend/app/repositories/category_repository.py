"""Every SQL statement the ``categories`` taxonomy needs, and nothing else.

This module is the sole home of the queries behind the category taxonomy: the slug lookup a
canonical URL resolves through, the whole-taxonomy listing that fills the home page's filter
control, the counted listing rendered beside each filter chip, the windowed listing the
administrative table pages through, the prefix scan that feeds slug de-duplication, and the
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
* :meth:`~CategoryRepository.slugs_starting_with` - ``ix_categories_slug`` again, through an
  anchored prefix pattern rather than a containment one, so the comparison stays a prefix
  comparison.
* :meth:`~CategoryRepository.is_in_use` - ``ix_post_categories_category_id``, which exists for
  exactly this direction of the relation.
* :meth:`~CategoryRepository.list_with_post_counts` - ``pk_post_categories`` and
  ``ix_post_categories_category_id`` for the two join steps, and
  ``ix_posts_status_published_at`` for the status predicate on the joined side, which is the
  same composite index the home feed's "recent published posts" ordering is built on.
* :meth:`~CategoryRepository.list_all` and :meth:`~CategoryRepository.list_paginated` sort by
  ``name``, which has its own unique index; the administrative text filter is a containment
  match and is knowingly a scan, on a relation bounded by editorial effort.

Case sensitivity is the column's business
-----------------------------------------
``categories.slug`` is ``CITEXT`` with a unique index, so PostgreSQL compares it
case-insensitively and ``/blog/category/Python`` and ``/blog/category/python`` resolve to one
category. Nothing here lower-cases a value or wraps a column in SQL ``LOWER``, and that is a
correctness requirement rather than a preference: wrapping the column would make the predicate
non-sargable and the unique index unusable, turning an index lookup into a sequential scan
while duplicating a guarantee the column type already provides.

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

from sqlalchemy import ColumnElement, and_, func, literal, or_, select

from app.models.category import Category, post_categories
from app.models.post import Post, PostStatus
from app.repositories.base import BaseRepository

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


class CategoryRepository(BaseRepository[Category]):
    """Data access for the ``categories`` taxonomy and its ``post_categories`` filings.

    Constructed per request from the session ``get_db`` yielded, and consumed only by
    ``app.services.category_service`` and ``app.services.admin_service``::

        repository = CategoryRepository(session)

        # GET /api/v1/categories - one statement, counts included.
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
    ``ON DELETE CASCADE`` for the filings - and
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

        Unpaginated on purpose. ``GET /api/v1/categories`` fills a filter control that has to
        offer every term at once - a half-populated filter is a filter that silently hides
        posts - and a reference taxonomy is bounded by editorial effort rather than by user
        input, so there is no growth curve to defend against. The administrative table, which
        *is* unbounded in principle and needs searching, uses :meth:`list_paginated` instead.

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

    async def list_with_post_counts(
        self, *, status: PostStatus | None = PostStatus.PUBLISHED
    ) -> Sequence[tuple[Category, int]]:
        """Return every category paired with how many posts are filed under it.

        One statement, always - see "Aggregate, not N+1" in the module docstring. This is what
        ``GET /api/v1/categories`` serialises into the filter control's chips, and what the
        administrative category screen shows in its count column.

        Args:
            status: Which lifecycle state to count. Defaults to
                :attr:`~app.models.post.PostStatus.PUBLISHED`, so a public caller sees only
                what a public caller could actually reach - a chip promising three posts that
                turn out to be drafts is worse than no chip. Pass ``None`` to count posts in
                every state, which is the administrative view. Purely a filter: this module
                never decides who is entitled to which value.

        Returns:
            ``(category, count)`` pairs ascending by ``name``. **Every** category appears,
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
        result = await self.session.execute(stmt)
        return result.tuples().all()

    async def list_paginated(
        self, *, q: str | None = None, limit: int, offset: int
    ) -> tuple[Sequence[Category], int]:
        """Window the taxonomy for the administrative table, optionally filtered by text.

        Backs ``GET /api/v1/admin/categories``. Unlike :meth:`list_all`, this surface is a
        management table rather than a filter control: it is searched and paged, so it windows.

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
            ``LOWER`` call.
            It is applied to ``slug`` as well as to ``name`` even though ``slug`` is already
            ``CITEXT`` and therefore case-insensitive: one operator across both columns states
            the intent - case-insensitive containment - in one place, and stays correct if
            either column's type is ever revisited.
        """
        stmt = select(Category)

        term = q.strip() if q is not None else ""
        if term:
            pattern = f"%{_escape_like_wildcards(term)}%"
            stmt = stmt.where(
                or_(
                    Category.name.ilike(pattern, escape=_LIKE_ESCAPE_CHARACTER),
                    Category.slug.ilike(pattern, escape=_LIKE_ESCAPE_CHARACTER),
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

            The pattern is anchored - ``LIKE 'prefix%'`` - rather than written as a containment
            or a regular expression, so the comparison stays a prefix comparison the index on
            ``categories.slug`` can serve. Because that column is ``CITEXT``, the match is
            case-insensitive, which is precisely what ``unique_slug`` needs: it compares
            case-insensitively too, so a stored ``News-2`` correctly rules out a proposed
            ``news-2`` that PostgreSQL would have rejected at the unique index anyway.
        """
        pattern = f"{_escape_like_wildcards(prefix)}%"
        result = await self.session.execute(
            select(Category.slug).where(Category.slug.like(pattern, escape=_LIKE_ESCAPE_CHARACTER))
        )
        return set(result.scalars().all())

    async def is_in_use(self, category_id: uuid.UUID) -> bool:
        """Report whether any post is filed under this category.

        The question ``category_service`` asks before deleting a category. The *decision* is
        the service's: it raises ``ConflictError`` when the answer is ``True``, because
        silently unfiling a term from every post that used it is data loss dressed up as a
        successful delete. This method only answers.

        Args:
            category_id: The category to probe. A server-generated UUID, so it arrived either
                from an earlier read or from a path segment a route already validated.

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
