"""The category taxonomy's lifecycle, declared in one place.

This module owns everything that happens to a category between being named by an administrator
and being removed by one: the slug derived from its name at creation, the deliberate refusal to
re-derive that slug when the name later changes, the two conflict rules that keep names and
slugs unique, the in-use guard that stops a delete from silently unfiling posts, and the two
read projections the home page's filter control and the administrative table render.

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

        # GET /api/v1/categories - the filter control, counts included, one statement.
        chips = await service.list_with_post_counts()

        # POST /api/v1/admin/categories - the slug is derived here, never sent by a client.
        category = await service.create(CategoryCreate(name="Machine Learning"))
        assert category.slug == "machine-learning"

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

    async def _published_post_counts(self) -> dict[uuid.UUID, int]:
        """Return every category's published-post tally, keyed by identifier.

        One statement for the whole taxonomy, so a caller holding an arbitrary set of categories
        can attach a real tally to each of them without asking a question per category.

        Keyed by ``id`` rather than by ``slug`` or ``name``: the identifier is a UUID, so
        lookups need no case handling at all, while a slug key would tempt a caller into folding
        case in Python and duplicating - or contradicting - what the ``citext`` column already
        does.

        Returns:
            ``{category_id: published_post_count}`` covering every category in the taxonomy. A
            category with no published post is present with a value of ``0``; the aggregate's
            outer join is what keeps it in the result.
        """
        counted = await self.categories.list_with_post_counts(status=PostStatus.PUBLISHED)
        return {category.id: post_count for category, post_count in counted}

    # -----------------------------------------------------------------------------------
    # Reads
    # -----------------------------------------------------------------------------------

    async def list_with_post_counts(self) -> list[CategoryPublic]:
        """Return the whole taxonomy with each term's published-post tally.

        What ``GET /api/v1/categories`` serialises into the home page's filter control: a chip
        per category reading ``Python (12)``. Deliberately **un-paginated** - a filter that
        offers only some of the terms is a filter that silently hides posts, and a curated
        taxonomy is bounded by editorial effort rather than by user input, so there is no growth
        curve to defend against here. :meth:`list_paginated` is the surface that windows.

        Two properties of the result are decisions rather than mechanics:

        **The tally counts published posts only.** ``status`` is passed explicitly rather than
        left to the repository's default, so the choice is visible and testable at this call
        site instead of being inherited invisibly from another module. A draft must not inflate
        a public count: the number beside a chip has to agree with the number of results an
        anonymous caller gets from ``GET /api/v1/posts?category={slug}``, and a chip promising
        three posts that turn out to be invisible drafts both misleads a reader and discloses
        that unpublished work exists.

        **A category with no posts still appears, with a count of ``0``.** The repository's join
        is an outer one for exactly this reason, and the filter control is expected to show an
        empty term rather than hide it.

        Returns:
            Every category ascending by name, each carrying its published-post tally; an empty
            list when the taxonomy is empty.

        Note:
            One statement, always. The tally is a single ``LEFT OUTER JOIN`` with a ``GROUP BY``
            inside the repository, and this method must never be re-implemented as "list the
            categories, then count each one's posts": that shape issues a statement per category
            and grows with the taxonomy, on the endpoint every single home-feed render calls.
            The pairs are projected in the order they arrive, so no second pass over the
            taxonomy is taken either.
        """
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
            Two statements: the indexed slug lookup, then the counted aggregate. The tally is
            read from the whole-taxonomy aggregate rather than from a count scoped to this one
            category because the repository publishes no single-category count, and adding a
            second way to compute the same number is how two callers start disagreeing about
            what it means. On a curated taxonomy the difference is one bounded aggregate.
        """
        category = await self.get_by_slug(slug)
        counts = await self._published_post_counts()
        # `.get(..., 0)` cannot silently invent a tally here. The aggregate covers every
        # category and runs strictly after the lookup, so the only way this category is missing
        # from it is a concurrent transaction having deleted the row in between - in which case
        # the response is about to describe a category that no longer exists, and 0 is as
        # truthful a tally as any. Every other path takes the real counted value.
        return self._to_public(category, counts.get(category.id, 0))

    async def list_paginated(
        self,
        *,
        q: str | None,
        page: int,
        page_size: int,
    ) -> Page[CategoryPublic]:
        """Window the taxonomy for the administrative management table.

        Unlike :meth:`list_with_post_counts`, this surface is a management table rather than a
        filter control: it is searched and paged. ``app.services.admin_service`` delegates to it
        so the administrative screen and the public listing agree on what a category looks like.

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
            **``post_count`` is a real number on this surface too.** The repository's windowed
            query returns entities without tallies, and ``CategoryPublic.post_count`` is a
            required member, so a tally has to come from somewhere; emitting ``0`` because none
            was to hand would put a fabricated figure in a documented field. It comes from one
            further aggregate over the taxonomy instead - three statements in total, constant in
            the page size, and never one per row.

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

        # Ordered after the window on purpose. Both statements take their own snapshot under
        # READ COMMITTED, so a later aggregate is guaranteed to see every category the window
        # already returned unless one was deleted in between - whereas an earlier aggregate
        # could miss a category the window then included. See the comment in
        # `get_public_by_slug` on why the fallback below is a true tally rather than a
        # placeholder.
        counts = await self._published_post_counts()

        items = [self._to_public(category, counts.get(category.id, 0)) for category in rows]
        return build_page(items, total, page, page_size)

    # -----------------------------------------------------------------------------------
    # Writes
    # -----------------------------------------------------------------------------------

    async def create(self, payload: CategoryCreate) -> Category:
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
            The persisted category, with its server-generated ``id``, its derived ``slug`` and
            both timestamps populated from the database.

        Raises:
            ConflictError: If the name is already taken, or if the insert violates either unique
                constraint. Both spellings of the same outcome, deliberately - see the note.

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
            await self.categories.add(category)
            await self.session.commit()
        except IntegrityError as error:
            # Rolled back before the domain error is raised. After an IntegrityError the session
            # is unusable until it is rolled back, so a caller that catches this conflict - the
            # idempotent seed, a test asserting on it - would otherwise find every subsequent
            # statement failing with a pending-rollback error instead. `get_db` also rolls back
            # on the way out, which is the safety net rather than the mechanism.
            await self.session.rollback()
            raise ConflictError(_DETAIL_NAME_OR_SLUG_TAKEN) from error

        return category

    async def update(self, category_id: uuid.UUID, payload: CategoryUpdate) -> Category:
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
            The category, reloaded from the database when something changed and returned
            unchanged when nothing did.

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
        """
        category = await self.categories.get_by_id(category_id)
        if category is None:
            raise NotFoundError(_DETAIL_NOT_FOUND)

        # `exclude_unset` is what distinguishes "leave this alone" from "set this to null":
        # an omitted member is absent from the dump, while an explicit `"description": null` is
        # present with a value of None and is honoured as an instruction to clear it.
        changes = payload.model_dump(exclude_unset=True)
        if not changes:
            # Nothing was sent, so nothing is written and nothing is committed. Returning the
            # row as it stands keeps an empty patch a successful no-op rather than an error.
            return category

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
            await self.categories.save(category)
            await self.session.commit()
        except IntegrityError as error:
            await self.session.rollback()
            raise ConflictError(_DETAIL_NAME_TAKEN) from error

        return category

    async def delete(self, category_id: uuid.UUID) -> None:
        """Delete a category, refusing while any post is still filed under it.

        Behind ``DELETE /api/v1/admin/categories/{id}``, which answers ``204`` with no body -
        hence the ``None`` return. ``app.services.admin_service`` delegates here rather than
        calling the repository itself precisely so that the guard below cannot be bypassed.

        Args:
            category_id: The category's server-generated identifier, taken from the path.

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
        await self.session.commit()
