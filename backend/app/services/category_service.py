"""The category taxonomy's lifecycle, declared in one place.

This module owns everything that happens to a category between being named by an administrator
and being removed by one: the slug derived from its name at creation, the deliberate refusal to
re-derive that slug when the name later changes, the two conflict rules that keep names and
slugs unique, the in-use guard that stops a delete from silently unfiling posts, and the two read
projections the home page's filter control and the administrative table render - the whole
taxonomy for the first, one window of it for the second, both projected through the same
``_to_public`` mapping and both tallying the same thing, so the two screens cannot disagree about
what a category looks like or about what ``post_count`` counts.

The public read is the API's one un-paginated collection
-------------------------------------------------------
:meth:`CategoryService.list_with_post_counts` returns a plain ``list[CategoryPublic]`` and takes
no window, and that is the specified contract rather than an oversight. The taxonomy is small and
bounded by editorial effort, and the list *is* the home page's filter control: a windowed control
would offer some terms and silently hide every post filed exclusively under the rest, which is a
wrong answer rather than a partial one. It is the single documented exception to the page envelope
across the whole API, one route wide, and ``GET /api/v1/admin/categories`` - the searchable
management table, served by :meth:`CategoryService.list_paginated` - is what carries the envelope
over the same relation.

Why the entity exists at all
----------------------------
Nothing in the original request named it. What was asked for was "category filters" on the home
feed and an administrative screen "managing ... categories" - two features that both rest on a
taxonomy neither of them describes. The relation, its slug and its description are therefore an
*implicit* requirement, and this module is the behavioural half of it: the queries live in
``app.repositories.category_repository`` and the wire shapes in ``app.schemas.category``.

Every category write in the service reaches this class
-----------------------------------------------------
``app.api.v1.routers.categories`` reads through it, and ``app.services.admin_service``
delegates its three administrative category routes to it rather than composing repository calls
of its own. That delegation is not tidiness. :meth:`CategoryService.delete` is where the in-use
guard lives, so a second write path around this class would be a path on which the guard does
not run - one door, one guard. It is also why no method here takes an ``is_admin`` flag: the
administrator gate is applied once, at router level, by ``require_admin``, and a service that
re-decided authority from a boolean argument would be a second place for that decision to be
got wrong.

Business rules only
-------------------
No statement is composed here and no HTTP artefact is constructed here. This module imports no
web framework, no part of SQLAlchemy's expression language and no session factory; it names no
status code; and it reaches ``python-slugify`` only through ``app.core.slug`` - so the collision
*policy* stays in that module, the collision *query* stays in the repository, and what is left
here is the decisions.
Absence arrives from the repository as ``None`` and leaves as
:class:`~app.core.exceptions.NotFoundError`; a collision arrives either as an existing row or
as an :class:`~sqlalchemy.exc.IntegrityError` and leaves as
:class:`~app.core.exceptions.ConflictError`.

The slug is written once, and that is the point of it
----------------------------------------------------
A category may be renamed. Its slug may not change. The slug *is* the canonical URL - it
appears in every published link, every sitemap entry and every canonical link tag - so
re-deriving it from a new name would break links that are already indexed and forfeit whatever
ranking is attached to them. :meth:`CategoryService.update` therefore never touches
``Category.slug``, and that omission is load-bearing rather than accidental. Three other layers
already agree: ``app.schemas.category.CategoryUpdate`` exposes no ``slug`` member and rejects a
submitted one with ``422``, ``app.core.slug`` ships no "re-slug from the new name" helper, and
no repository method assigns to the column after the insert. A term whose address genuinely
must change is a new category and a redirect - a product decision, not a side effect of an
edit.

Transaction ownership
---------------------
``app.repositories.base`` flushes and never commits, and ``get_db`` in
``app.core.dependencies`` commits nothing and rolls back on an exception. The commit therefore
belongs here: each mutating method below commits its own unit of work on success and lets an
exception propagate untouched, so a failure leaves nothing half-applied. Nothing here opens a
transaction of its own - the session yielded by ``get_db`` is already in one, and
``backend/tests/conftest.py`` wraps each test in an outer transaction it rolls back afterwards,
which an explicitly begun inner one would collide with. The session is received in the
constructor and is never created, replaced or closed here.

One property of that session is relied on by the methods that return an entity after
committing: ``app.db.session`` builds it with ``expire_on_commit=False``, so a mapped instance
stays readable after the commit that saved it and a route can commit and then serialise its
response. Without that setting the commit would expire every attribute, and the first one a
serialiser touched would attempt a lazy refresh - which under an async session raises
``MissingGreenlet`` rather than quietly issuing another query. Nothing is re-read here to work
around it, because the setting is part of the session contract rather than a coincidence.

What this module retires
------------------------
The service this schema replaced settled all of the above inside its route handlers. It
constructed a framework HTTP exception, status code and detail string in the middle of its data
access, three separate times (``app.py:L31``, ``app.py:L40``, ``app.py:L49``); it wrote the
identity predicate three times as well (``app.py:L28-29``, ``app.py:L36-37``,
``app.py:L45-46``), where :meth:`~app.repositories.base.UUIDPrimaryKeyRepository.get_by_id` is
now the codebase's only copy; it mutated a module-level list in place (``app.py:L17``,
``app.py:L38``, ``app.py:L47``); it replaced a whole record on every update rather than
applying the fields a caller actually sent (``app.py:L34-L40``); and it answered mutations with
a ``message``/``data`` wrapper that its own reads did not use (``app.py:L18``, ``app.py:L39``).
None of those shapes appears below: the return values here are the mapped entity, the response
model, and the one page envelope every collection in the API shares.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Final

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError
from app.core.pagination import Page, build_page
from app.core.slug import slugify_title, unique_slug
from app.models import Category, PostStatus
from app.repositories import CategoryRepository
from app.schemas.category import CategoryCreate, CategoryPublic, CategoryUpdate

__all__ = ["CategoryService"]


# ---------------------------------------------------------------------------------------
# Client-facing failure messages
#
# Declared as constants rather than written at each `raise`, for the reason the retired
# service demonstrates: the same 404 detail string was typed out three times there, so the
# wording could drift between call sites of one rule. Each is safe to show an
# unauthenticated caller - none names an internal identifier, quotes SQL or reveals a
# configuration value - and each is a complete sentence, because it is rendered verbatim as
# the `detail` member of the problem document.
# ---------------------------------------------------------------------------------------

_DETAIL_NOT_FOUND: Final[str] = "Category not found."
"""Detail for a category addressed by an identifier or slug that resolves to no row."""

_DETAIL_NAME_TAKEN: Final[str] = "A category with that name already exists."
"""Detail for the ordinary, pre-checked collision on the unique ``categories.name``."""

_DETAIL_NAME_OR_SLUG_TAKEN: Final[str] = (
    "That category name, or the URL slug derived from it, is already in use."
)
"""Detail for a collision the database reported rather than the pre-check.

Names both columns because the constraint that fired is not distinguished here: reading the
violated constraint's name out of the driver's error would couple this module to a message
format the driver is free to change, and the caller's remedy - choose another name - is the
same for either. ``app.core.exceptions`` renders it at ``409``.
"""

_DETAIL_IN_USE: Final[str] = (
    "Posts are still filed under this category. Re-file them before deleting it."
)
"""Detail for a delete refused because ``post_categories`` still references the category.

Phrased as an instruction because the conflict is entirely resolvable by the caller, and the
alternative to refusing is data loss: ``post_categories.category_id`` carries
``ON DELETE CASCADE``, so an unguarded delete would succeed while quietly stripping the
category from every post that used it.
"""


class CategoryService:
    """Business rules for the ``categories`` taxonomy.

    Constructed per request from the session ``get_db`` yielded, and consumed by
    ``app.api.v1.routers.categories`` and ``app.services.admin_service``::

        service = CategoryService(session)

        # GET /api/v1/categories - the filter control: the whole taxonomy, counts included,
        # deliberately un-windowed. See `list_with_post_counts`.
        categories = await service.list_with_post_counts()

        # GET /api/v1/admin/categories - the management table, searchable and windowed.
        page = await service.list_paginated(q="mach", page=1, page_size=20)

        # POST /api/v1/admin/categories - the slug is derived here, never sent by a client.
        # Both mutations return the projected `CategoryPublic` rather than the mapped row: the
        # tally belongs to the transaction that wrote the row, so it is read before the commit
        # rather than by a caller afterwards.
        category = await service.create(CategoryCreate(name="Machine Learning"))
        assert category.slug == "machine-learning" and category.post_count == 0

        # PATCH /api/v1/admin/categories/{id} - a rename leaves the slug alone.
        renamed = await service.update(category.id, CategoryUpdate(name="ML"))
        assert renamed.slug == "machine-learning"

    Instances are cheap, cache nothing between calls, and are exactly as concurrency-safe as
    the :class:`~sqlalchemy.ext.asyncio.AsyncSession` they wrap - which is to say they must not
    be shared between concurrent tasks, because a session is one unit of work over one
    connection.

    Attributes:
        session: The unit of work every statement is issued through, and the object whose
            transaction this class commits. Stored, never replaced.
        categories: The repository that owns every category query. The only collaborator.
    """

    def __init__(self, session: AsyncSession) -> None:
        """Bind the service to one unit of work.

        Args:
            session: The request-scoped session. Supplied by the caller - ``get_db`` in the API
                tier, the transactional fixture in the suite - because a service that built its
                own session could not participate in a caller's transaction, and every test in
                the suite depends on being able to roll one back.
        """
        self.session = session
        self.categories = CategoryRepository(session)

    # -----------------------------------------------------------------------------------
    # Projection
    # -----------------------------------------------------------------------------------

    @staticmethod
    def _to_public(category: Category, post_count: int) -> CategoryPublic:
        """Project a mapped category and a tally into the response model.

        Written out field by field rather than through ``model_validate``, and that is a
        requirement rather than a style choice. ``post_count`` is produced by a ``COUNT`` in the
        repository and is not a column, a default or a hybrid property, so no single object
        carries all six of this model's fields: neither member of the repository's
        ``(Category, int)`` pair validates on its own, and the pair itself carries none of them
        by name. The layer that knows the aggregate *is* a ``post_count`` is this one, so the
        naming happens here.

        Args:
            category: The mapped row. Every attribute read below is a column on
                ``categories``, so no relationship is touched and no lazy load can fire - which
                matters under an async session, where one would raise ``MissingGreenlet``
                rather than quietly issue another query.
            post_count: How many posts the aggregate counted for this category. Passed in
                rather than derived, because deriving it here would mean one statement per
                category.

        Returns:
            The category as ``GET /api/v1/categories`` and ``GET /api/v1/categories/{slug}``
            serialise it.
        """
        return CategoryPublic(
            id=category.id,
            name=category.name,
            slug=category.slug,
            description=category.description,
            post_count=post_count,
            created_at=category.created_at,
        )

    async def _published_post_counts(
        self, category_ids: Sequence[uuid.UUID] | None = None
    ) -> dict[uuid.UUID, int]:
        """Return published-post tallies keyed by category identifier.

        One statement for the requested scope, so a caller holding a set of categories can attach a
        real tally to each of them without asking a question per category.

        Keyed by ``id`` rather than by ``slug`` or ``name``: the identifier is a UUID, so
        lookups need no case handling at all, while a slug key would tempt a caller into folding
        case in Python and duplicating - or contradicting - what the ``citext`` column already
        does.

        Args:
            category_ids: The categories to tally, or ``None`` for the whole taxonomy. **A paginated
                caller must pass its page's identifiers.** The unbounded form is correct for
                :meth:`list_with_post_counts`, whose result set *is* the taxonomy, and wrong
                everywhere else: aggregating every category and every filing in order to enrich
                twenty rows defeats the page boundary the window just established, and the cost then
                grows with the taxonomy rather than with the page. A caller that needs exactly one
                tally should not come here at all - :meth:`_targeted_count` answers that with a
                single targeted count, and every one-category projection in this module uses it.

        Returns:
            ``{category_id: published_post_count}`` covering every category in scope. A category
            with no published post is present with a value of ``0``; the aggregate's outer join is
            what keeps it in the result.
        """
        counted = await self.categories.list_with_post_counts(
            status=PostStatus.PUBLISHED, category_ids=category_ids
        )
        return {category.id: post_count for category, post_count in counted}

    async def _targeted_count(self, category_id: uuid.UUID) -> int:
        """Return one category's published-post tally with a single targeted count.

        The one-row counterpart to :meth:`_published_post_counts`. Every method here that projects
        exactly one category routes through this, so ``published`` means the same thing on the
        single-category read as it does in the aggregate - one call site, one default, no second
        definition of the number to drift.

        Args:
            category_id: The category to tally. An identifier that matches nothing counts ``0``
                rather than raising: the callers below have already resolved the row, so a zero here
                would mean the filings vanished between the two statements, and reporting an empty
                category is a truer answer than failing the request.

        Returns:
            How many published posts are filed under that category.
        """
        return await self.categories.published_post_count(category_id, status=PostStatus.PUBLISHED)

    # -----------------------------------------------------------------------------------
    # Reads
    # -----------------------------------------------------------------------------------

    async def list_with_post_counts(self) -> list[CategoryPublic]:
        """Return the whole taxonomy, each term with its published-post tally.

        The read behind ``GET /api/v1/categories``, whose declared ``response_model`` is a **bare**
        ``list[CategoryPublic]`` rather than the page envelope. That is the API's one documented
        collection exception and it is one route wide: the list *is* the home page's filter control,
        and a windowed control would offer some terms while silently hiding every post filed
        exclusively under the rest - a wrong answer rather than a partial one. A taxonomy is bounded
        by editorial effort rather than by reader input, so there is nothing here for a window to
        protect against. The searchable, windowed view over the same relation is
        :meth:`list_paginated`, reached only through ``GET /api/v1/admin/categories``.

        **One statement, never one per category.** The tally arrives from a single aggregate in
        ``CategoryRepository.list_with_post_counts`` - a ``LEFT OUTER JOIN`` onto
        ``post_categories`` and ``posts`` with a ``GROUP BY`` - and this method only names its two
        columns. Counting per term instead would issue one statement per chip on the endpoint every
        home-feed render calls, which is precisely the N+1 the outer join exists to avoid.

        Returns:
            Every category ascending by ``name``, each carrying ``post_count``. A category with no
            published post is **present** with a tally of ``0``: the aggregate's outer join is what
            keeps it in the result, and the filter control is expected to show an empty term rather
            than omit it. An empty list when no category has been created.

        Note:
            The tally counts **published** posts only, which is draft confidentiality reaching the
            category surface: a chip promising three posts that turn out to be drafts is worse than
            no chip, and each tally therefore agrees exactly with the number of results
            ``GET /api/v1/posts?category={slug}`` returns to an anonymous caller. The default lives
            in the repository, so this method and :meth:`_targeted_count` cannot disagree about what
            the number means.
        """
        # The repository hands back `(Category, count)` pairs, because a mapped category has no
        # `post_count` attribute - the tally is an aggregate rather than a column. Naming the two
        # halves is this layer's job; `_to_public` is the one place that naming happens, so the
        # single read, this collection and the administrative table all project identically.
        counted = await self.categories.list_with_post_counts(status=PostStatus.PUBLISHED)
        return [self._to_public(category, post_count) for category, post_count in counted]

    async def get_by_slug(self, slug: str) -> Category:
        """Resolve one category by the slug in its URL, or report that there is none.

        The entity-returning read, for a caller that needs the mapped row itself: the feed's
        ``?category={slug}`` filter resolving a slug to a category, and any sibling service that
        has to associate or compare one. :meth:`get_public_by_slug` is the variant that returns
        the response model.

        Args:
            slug: The URL segment to resolve, in whatever case it was received. Passed through
                **unchanged**: ``categories.slug`` is ``CITEXT``, so PostgreSQL performs the
                case-insensitive comparison through the unique index ``ix_categories_slug`` and
                ``/blog/category/Python`` resolves to the row stored as ``python``. Folding the
                case here would duplicate a guarantee the column type already provides, and
                folding it in SQL would make the predicate non-sargable and put that index out
                of reach.

        Returns:
            The mapped category.

        Raises:
            NotFoundError: If no category carries that slug. This is the decision the repository
                deliberately does not make - it reports absence as ``None`` - and it is made here
                so that one read path can serve both a route that treats a miss as ``404`` and a
                caller that treats it as something else.
        """
        category = await self.categories.get_by_slug(slug)
        if category is None:
            raise NotFoundError(_DETAIL_NOT_FOUND)
        return category

    async def get_public_by_slug(self, slug: str) -> CategoryPublic:
        """Resolve one category by slug and project it into its response model.

        The read behind ``GET /api/v1/categories/{slug}``, whose declared ``response_model`` is
        :class:`~app.schemas.category.CategoryPublic`. It exists alongside :meth:`get_by_slug`
        because that model requires a ``post_count`` and a mapped ``Category`` has no such
        attribute - the tally is an aggregate, so *something* has to compose the two, and a
        route composing them itself would be data access in a handler. The projection therefore
        happens here, and a route stays one call deep.

        Args:
            slug: The URL segment to resolve. Compared by the database, as
                :meth:`get_by_slug` documents.

        Returns:
            The category with its published-post tally attached.

        Raises:
            NotFoundError: If no category carries that slug.

        Note:
            Two statements, and the second is scoped to this category: the indexed slug lookup, then
            a targeted ``COUNT`` over its filings. It used to read the tally out of the
            whole-taxonomy aggregate, which grouped every category and joined every filing to answer
            a question about one row - on the endpoint a reader hits for every category page. The
            repository now publishes both shapes, and the two share one definition of what is
            counted (published posts, with the same default), so there is still exactly one meaning
            for the number rather than two implementations of it.
        """
        category = await self.get_by_slug(slug)
        # Targeted: one count over this category's filings, served by
        # ix_post_categories_category_id. A category with no published post counts 0, which is the
        # honest tally rather than a placeholder.
        return self._to_public(category, await self._targeted_count(category.id))

    async def list_paginated(
        self,
        *,
        q: str | None,
        page: int,
        page_size: int,
    ) -> Page[CategoryPublic]:
        """Window the taxonomy. **The administrative listing surface.**

        Reached only through ``app.services.admin_service`` for ``GET /api/v1/admin/categories``,
        which is the searchable management table. The reader-facing filter control does **not**
        come here: it calls :meth:`list_with_post_counts` and receives the whole taxonomy as a bare
        list, for the reason recorded there. Both methods project through :meth:`_to_public` and
        both tally published posts, so the two screens agree about what a category looks like and
        about what ``post_count`` counts while differing - deliberately - in whether the result is
        windowed.

        Args:
            q: Optional search text, matched case-insensitively against both the name and the
                slug so a term is findable by either spelling. ``None``, an empty string and
                whitespace alone all mean "no filter" - the repository normalises that - because
                a blank search box is not a search for nothing.
            page: The 1-based page requested. A page past the last one is **not** an error: it
                comes back with an empty ``items`` list beside the real ``pages``, which is how
                a client recognises that it has run off the end rather than being silently
                redirected to a page it never asked for.
            page_size: Rows per page.

        Returns:
            The one page envelope every collection endpoint in this API returns, carrying
            ``items``, ``total``, ``page``, ``page_size`` and ``pages``.

        Raises:
            ValueError: If ``page_size`` is zero or negative, raised by ``build_page``. That can
                only arrive from a defect in a caller: request-supplied values are bounded to
                ``page >= 1`` and ``1 <= page_size <= 100`` by ``PageParams`` in
                ``app.core.dependencies`` long before they reach here, so failing loudly beats
                dividing by zero or substituting a default that would make ``pages`` a fiction.

        Note:
            **``post_count`` is a real number on this surface too, and the aggregate behind it is
            bounded to the page.** The repository's windowed query returns entities without tallies,
            and ``CategoryPublic.post_count`` is a required member, so a tally has to come from
            somewhere; emitting ``0`` because none was to hand would put a fabricated figure in a
            documented field. It comes from one further aggregate - three statements in total,
            constant in the page size, and never one per row - narrowed to the identifiers this page
            actually returned. Aggregating the whole taxonomy here would have undone the window: the
            page bounds what is rendered, and the enrichment behind it has to respect the same
            bound, or the endpoint's cost grows with the taxonomy however small the page is.

            **The tally counts published posts here as well, not posts in every state.**
            ``CategoryPublic.post_count`` is published in ``/openapi.json`` as the number of
            *published* posts, and this method returns that same model, so counting archived
            posts and drafts into it would make the document describe something the API does not
            return. An all-states tally is a different number and would need a model of its own
            rather than a differently-meaning field under a name a client has already been told
            the meaning of.
        """
        # The window arithmetic `PageParams.offset` performs, restated for a caller that passes
        # the page and its size rather than the dependency object - which is what keeps this
        # method callable from `admin_service` and from a test with no request in sight.
        offset = (page - 1) * page_size
        rows, total = await self.categories.list_paginated(q=q, limit=page_size, offset=offset)

        # Ordered after the window on purpose, and scoped BY it. The identifiers come from the rows
        # the window returned, so the aggregate covers exactly this page rather than the relation.
        # Sequencing it second is also what makes it complete: both statements take their own
        # snapshot under READ COMMITTED, so an aggregate that runs after the window sees every row
        # the window returned unless one was deleted in between, whereas an earlier one could miss a
        # category the window then included.
        #
        # `.get(..., 0)` therefore cannot invent a tally. The only way a row on this page is absent
        # from the aggregate is a concurrent transaction having deleted it in between, in which case
        # the response is about to describe a category that no longer exists and 0 is as truthful a
        # figure as any. Every other row takes its real counted value.
        counts = await self._published_post_counts([category.id for category in rows])

        items = [self._to_public(category, counts.get(category.id, 0)) for category in rows]
        return build_page(items, total, page, page_size)

    # -----------------------------------------------------------------------------------
    # Writes
    # -----------------------------------------------------------------------------------

    async def create(self, payload: CategoryCreate) -> CategoryPublic:
        """Create a category, deriving its slug from its name.

        Behind ``POST /api/v1/admin/categories``. The caller supplies a name and optionally a
        description; the identifier, the slug and both audit instants are the server's, which is
        why :class:`~app.schemas.category.CategoryCreate` accepts neither ``id`` nor ``slug`` and
        rejects a request that carries one with ``422``.

        Args:
            payload: The validated body. ``name`` has already been trimmed and length-bounded,
                and a blank ``description`` has already been folded to ``None``, by the schema -
                so nothing here re-validates input, and nothing here has to decide what an empty
                string means.

        Returns:
            The persisted category **already projected into**
            :class:`~app.schemas.category.CategoryPublic`, with its server-generated ``id``, its
            derived ``slug``, both timestamps from the database and ``post_count`` of ``0``.

            The projection is built here rather than left to the caller, and that is a transaction
            decision rather than a convenience. ``CategoryPublic`` carries ``post_count``, which is
            an aggregate no ``Category`` entity holds, so a caller that received the row had to read
            the tally itself - and it could only do so *after* this method's commit, which meant a
            transient failure on that read returned an error for a category that already existed.
            Owning the projection lets the commit be the last database action of the request. See
            the note on why the count is a constant here.

        Raises:
            ConflictError: If the name is already taken, or if the insert violates either unique
                constraint. Both spellings of the same outcome, deliberately - see the note. A
                merely colliding *slug* is **not** among them: it is suffixed, per the note below,
                and the request succeeds.

        Note:
            **Slug derivation is three steps, and splitting them is what keeps each testable.**
            ``slugify_title`` normalises the name into a URL-safe form,
            ``slugs_starting_with`` performs the one indexed query that reveals which members of
            that slug family already exist, and ``unique_slug`` applies the collision policy to
            the set. The suffix it appends is a plain ascending integer - ``python``,
            ``python-2``, ``python-3`` - so the outcome is deterministic and a re-run against the
            same data yields the same slug. Nothing here consults the clock or a random source,
            and no digest or identifier fragment is spliced into a slug: an address a reader
            sees should read like the name it came from.

            **A colliding slug is suffixed, not refused, and the route's published contract says
            so.** The two are easy to conflate because both concern uniqueness, but only the name
            is a conflict: ``uq_categories_name`` compares names, and two distinct names that
            normalise to one slug - ``Machine Learning`` and ``machine learning`` - are both
            legitimate labels that deserve distinct addresses rather than one being rejected on
            the other's behalf. Do not "tighten" this into a 409: the derived slug is an address
            this service assigns, and refusing a name because an address was taken would make the
            taxonomy's vocabulary a function of its URL history. The consequence for a client is
            stated in ``app.api.v1.routers.admin``: read ``slug`` from the response rather than
            deriving it from the name that was sent.

            **The pre-check and the constraint are both needed, and neither replaces the
            other.** The ``get_by_name`` lookup exists so that the ordinary collision - an
            administrator retyping a name that already exists, or a re-run of the reference
            seed - produces a clear ``409`` naming exactly what is wrong. It is not the
            guarantee: between that read and the insert another transaction can claim the name or
            the slug, and treating a pre-check as a guard is a race condition wearing a guard's
            uniform. ``uq_categories_name`` and the unique ``citext`` index ``ix_categories_slug``
            remain the real guarantee, and the handler below translates the violation they raise
            into the same domain error - so a caller sees ``409`` on either path and never a
            ``500`` describing a database constraint.

            **The ``citext`` slug index is relied on rather than reimplemented.** A proposed
            ``Python`` collides with a stored ``python`` in the database, and ``unique_slug``
            compares its own candidates case-insensitively too, so no case folding is performed
            in this module at all.

            **One request, one commit, and the projection is what the commit comes after.** This
            method owns its transaction boundary outright and takes no argument that would move it:
            ``app.services.admin_service`` delegates here and adds only its audit line afterwards,
            so there is nothing left for a caller to complete. Owning the projection is what makes
            that boundary correct - ``post_count`` is read (as the constant ``0``) *before* the
            commit, so the commit is the last database action of the request and a failure can never
            answer an error over a category the database has already accepted. Both unique
            constraints are applied inside the guard below rather than at the boundary: ``add``
            flushes, and the commit is inside the same ``try``, so a violation raised by either is
            translated the same way.

            :meth:`delete` is the one method here that *does* expose a ``commit`` flag, and its
            docstring states why on its own terms. Do not add one to this method or to
            :meth:`update` speculatively: an unused flag reads as a supported composition pattern
            that nothing exercises, which is how a docstring comes to describe an argument the
            signature does not have.
        """
        # The clear-message path for the collision that actually happens. `categories.name` is
        # plain TEXT under a case-SENSITIVE unique constraint, so this lookup asks exactly the
        # question the constraint will ask - no more strictly, and no less.
        if await self.categories.get_by_name(payload.name) is not None:
            raise ConflictError(_DETAIL_NAME_TAKEN)

        base = slugify_title(payload.name)
        taken = await self.categories.slugs_starting_with(base)
        slug = unique_slug(base, taken)

        category = Category(name=payload.name, slug=slug, description=payload.description)

        try:
            # `add` flushes, so the INSERT - and therefore both unique constraints - is applied
            # inside this block rather than at some later commit. The commit is inside it too:
            # a commit issues a flush of its own, and a translation that covered only one of the
            # two would leave the other able to surface as a 500.
            persisted = await self.categories.add(category)
            # Projected BEFORE the commit, and with a constant rather than a query: a category
            # created a moment ago has no post filed under it, because `post_categories` rows are
            # written by the post lifecycle and nothing in this method writes one. Counting would
            # ask the database a question whose answer is already known - which is what the
            # administrative readback used to do, and it did it with a whole-taxonomy aggregate.
            projected = self._to_public(persisted, 0)
            await self.session.commit()
        except IntegrityError as error:
            # Rolled back before the domain error is raised. After an IntegrityError the session
            # is unusable until it is rolled back, so a caller that catches this conflict - the
            # idempotent seed, a test asserting on it - would otherwise find every subsequent
            # statement failing with a pending-rollback error instead. `get_db` also rolls back
            # on the way out, which is the safety net rather than the mechanism.
            await self.session.rollback()
            raise ConflictError(_DETAIL_NAME_OR_SLUG_TAKEN) from error

        return projected

    async def update(self, category_id: uuid.UUID, payload: CategoryUpdate) -> CategoryPublic:
        """Apply a partial update to a category, leaving its slug alone.

        Behind ``PATCH /api/v1/admin/categories/{id}``. A genuine partial update: only the
        members the caller actually sent are applied, so renaming a category touches its name
        and nothing else. That replaces the whole-object replacement the retired
        ``PUT /items/{item_id}`` performed at ``app.py:L34-L40``, which required a client to
        resend every field it was not changing and therefore let a client holding a stale copy
        silently revert whatever it had not refreshed.

        Args:
            category_id: The category's server-generated identifier, taken from the path.
            payload: The validated body. Every member is optional; an omitted member means
                "leave this as it is". An empty body is a valid no-op rather than an error,
                because a form that submits an unmodified record is a legitimate request.

        Returns:
            The category projected into :class:`~app.schemas.category.CategoryPublic`, reloaded from
            the database when something changed and read as it stands when nothing did, with
            ``post_count`` from one targeted count over its filings.

            As in :meth:`create`, the projection is owned here so that the tally is read inside
            this method's transaction and the commit is the last database action - the caller used
            to read it afterwards, through a whole-taxonomy aggregate, on a durable row.

        Raises:
            NotFoundError: If no category carries that identifier. Resolved **before** any
                conflict, so a caller addressing a category that does not exist is told that
                rather than being told something about a name.
            ConflictError: If the new name is already held by a different category, or if the
                update violates the unique constraint on the name.

        Note:
            **The slug is not re-derived, and that is the single most important line of this
            method - the one that is not here.** A canonical URL that changes is a broken link
            and a forfeited ranking, so a rename moves the label a reader sees while the address
            they bookmarked keeps resolving. This is why slug generation sits *ahead* of the SEO
            work in the project's dependency graph: the address is written at creation time and
            must not move afterwards. It will look like an omission to a future reader, which is
            why it is stated here, in the schema that exposes no ``slug`` member, on the column
            itself, and in this module's docstring.

            **The name collision check exempts this category's own row.** ``get_by_name`` returns
            *this* category when the submitted name is the one it already has, and treating that
            as a conflict would make a description-only patch that happens to resend the name
            fail for no reason.

            **The unlocked read is the right one here.** A rename is not a read-check-write over
            the row being written: the check is about *other* rows' names, and no lock on this
            row could stop a concurrent rename of a different one from claiming the same name.
            ``uq_categories_name`` is the guarantee, so the pre-check buys a clear message and
            the handler below covers the race.

            **This method owns its transaction boundary and takes no argument that would move it**,
            exactly as :meth:`create` does and for the same reason - the projection it returns has
            to be read before the commit. Only :meth:`delete`, which returns nothing, exposes a
            ``commit`` flag.
        """
        category = await self.categories.get_by_id(category_id)
        if category is None:
            raise NotFoundError(_DETAIL_NOT_FOUND)

        # `exclude_unset` is what distinguishes "leave this alone" from "set this to null":
        # an omitted member is absent from the dump, while an explicit `"description": null` is
        # present with a value of None and is honoured as an instruction to clear it.
        changes = payload.model_dump(exclude_unset=True)
        if not changes:
            # Nothing was sent, so nothing is written and nothing is committed - the read for the
            # tally is the only statement this branch issues, and there is no transaction to order
            # it against. Returning the row as it stands keeps an empty patch a successful no-op
            # rather than an error.
            return self._to_public(category, await self._targeted_count(category.id))

        if "name" in changes:
            # Read from the model attribute rather than from the dump: `model_dump` widens every
            # value to `Any`, while the attribute carries the validated string the schema
            # declares. The schema's own validator rejects an explicit null, so a name that was
            # set is a real name; the guard below is what lets the type checker see that too.
            new_name = payload.name
            if new_name is not None and new_name != category.name:
                clash = await self.categories.get_by_name(new_name)
                if clash is not None and clash.id != category.id:
                    raise ConflictError(_DETAIL_NAME_TAKEN)
                category.name = new_name

        if "description" in changes:
            # Assigned unconditionally, including when the value is None. `None` here is the
            # caller asking for the description to be cleared, which is a change like any other.
            category.description = payload.description

        try:
            # `save` flushes the UPDATE and reloads the row, so the returned entity carries the
            # `updated_at` PostgreSQL just re-derived rather than an expired attribute a
            # response serialiser would trip over.
            saved = await self.categories.save(category)
            # One targeted count, inside the transaction, then commit. A rename does not change how
            # many posts are filed under a category, so this figure is the same before and after the
            # write - but reading it here rather than afterwards is what makes the commit the last
            # database action of the request.
            projected = self._to_public(saved, await self._targeted_count(saved.id))
            await self.session.commit()
        except IntegrityError as error:
            await self.session.rollback()
            raise ConflictError(_DETAIL_NAME_TAKEN) from error

        return projected

    async def delete(self, category_id: uuid.UUID, *, commit: bool = True) -> None:
        """Delete a category, refusing while any post is still filed under it.

        Behind ``DELETE /api/v1/admin/categories/{id}``, which answers ``204`` with no body -
        hence the ``None`` return. ``app.services.admin_service`` delegates here rather than
        calling the repository itself precisely so that the guard below cannot be bypassed.

        Args:
            category_id: The category's server-generated identifier, taken from the path.
            commit: Whether this call owns the transaction boundary. ``True``, the default, for a
                caller for whom deleting the category *is* the request. ``False`` when this call is
                one step of a larger unit of work the caller will finish and commit itself, which is
                what ``app.services.admin_service`` passes so that the removal and the audit record
                it writes around it are one transaction rather than two.

                This is the only method on this class that takes the flag, and the asymmetry is
                deliberate rather than an omission: :meth:`create` and :meth:`update` return a
                projected :class:`~app.schemas.category.CategoryPublic`, so they must read their
                tally before committing and there is nothing left for a caller to add afterwards.
                A delete returns ``None``, so a composing caller genuinely does still have work to
                do. Do not add the flag to the other two to make them look alike - an argument
                nothing passes reads as a supported pattern that is not exercised.

        Raises:
            NotFoundError: If no category carries that identifier. Resolved **first**, before the
                in-use question is asked, because "this category does not exist" and "this
                category may not be deleted yet" are different answers and the caller needs the
                one that is true. The repository's probe deliberately cannot make that
                distinction - a category that does not exist is also not in use - so the order
                here is what separates them.
            ConflictError: If at least one post is filed under the category. The caller's remedy
                is to re-file or delete those posts first.

        Note:
            **The three steps are a locked sequence, not a probe followed by a hope.** The row is
            fetched with ``SELECT ... FOR UPDATE``, the in-use question is asked under that lock,
            and the delete happens only if the answer was ``False`` - all inside this one
            transaction. Without the lock, another transaction can file a post under the category
            in the window between the check and the delete, and
            ``post_categories.category_id`` carries ``ON DELETE CASCADE``, so the delete would
            still succeed and would take that new filing with it. Nothing would fail, nobody
            would be told, and a post would silently lose a category - which is exactly the data
            loss the in-use rule exists to prevent. The lock closes the window through the
            foreign key itself: PostgreSQL needs ``FOR KEY SHARE`` on the referenced row to
            validate an insert into ``post_categories``, and that conflicts with ``FOR UPDATE``,
            so the concurrent filing blocks until this transaction ends.

            **Nothing here deletes a child row.** The cascade on the association relation is the
            single definition of what follows a category, and a hand-written child delete would
            be a second copy of that rule for the two to drift apart on. It is also unreachable:
            the guard above has already established that there is no filing to remove.

            **No conflict is translated on this path.** A delete reaching the flush cannot
            violate a constraint - the only relation referencing ``categories`` cascades, and the
            guard proved it holds no matching row - so an ``IntegrityError`` here would be a
            genuine defect rather than a collision, and dressing it up as a ``409`` would hide
            it. When either error above is raised the lock is released by the rollback ``get_db``
            performs on its way out.
        """
        category = await self.categories.get_for_update(category_id)
        if category is None:
            raise NotFoundError(_DETAIL_NOT_FOUND)

        if await self.categories.is_in_use(category_id):
            raise ConflictError(_DETAIL_IN_USE)

        await self.categories.delete(category)
        if commit:
            await self.session.commit()
