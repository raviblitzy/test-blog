"""The four request and response shapes of the categories taxonomy.

A category is the term a post is filed under: the label on a home-feed filter chip, the path
segment of a canonical category URL, and one of the four things the administrative dashboard
manages. This module fixes its wire format, and holds nothing else - no query, no slug
derivation, no authority check, no status code.

Nothing in the service this repository grew out of named the entity at all. The requirement was
for "category filters" on the home page and for an admin screen "managing ... categories", so
the taxonomy is an *implicit* requirement that two explicit features rest on, and these four
models are where its contract becomes explicit.

Four models, and the surface each one is
----------------------------------------
:class:`CategorySummary`
    The slim, embeddable projection. ``app.schemas.post`` carries a ``list[CategorySummary]``
    as the ``categories`` member of its ``PostSummary`` and ``PostDetail`` models.
:class:`CategoryPublic`
    The listing and detail projection: the declared ``response_model`` of
    ``GET /api/v1/categories`` and ``GET /api/v1/categories/{slug}``.
:class:`CategoryCreate`
    The request body of ``POST /api/v1/admin/categories``.
:class:`CategoryUpdate`
    The request body of ``PATCH /api/v1/admin/categories/{id}``.

This module is the SINGLE definition site of the two input models
-----------------------------------------------------------------
``app.schemas.admin`` must **import** :class:`CategoryCreate` and :class:`CategoryUpdate` from
here rather than declaring administrative variants of its own, even though both are reached
only through administrative routes. There is one category-creation contract in this service and
one category-update contract; a second pair - differing, inevitably, by a bound or a
description - would be two documents describing one wire format with nothing keeping them in
step. The same holds for ``app.schemas.post``, which imports :class:`CategorySummary` from here
and declares no category shape of its own.

No collection wrapper is declared here, and that is deliberate
--------------------------------------------------------------
``GET /api/v1/categories`` returns a collection, and returns it as ``Page[CategoryPublic]`` -
the generic envelope re-exported from ``app.schemas.common``, parameterised at the route::

    @router.get("/categories", response_model=Page[CategoryPublic])

So there is no ``CategoryList``, no ``CategoriesResponse``, and above all no
``{"message": ..., "data": ...}`` wrapper: ``app.schemas.common`` permits exactly three
response shapes - a page envelope for a collection, a bare representation for a single read, a
problem document for a failure - and forbids a fourth. Nor is there a delete-response model,
because deleting a category answers ``204 No Content``, which has no body for one to describe.

Neither input model accepts an identifier or a slug
--------------------------------------------------
This is the load-bearing property of the module, and ``extra="forbid"`` on both input models is
what makes it enforced rather than merely documented: a caller that sends either member is
rejected with ``422`` and a problem document naming the offending field.

``id``
    Identity originates in PostgreSQL. ``app.db.base.UUIDPrimaryKeyMixin`` declares the
    surrogate key with ``server_default=gen_random_uuid()``, so a caller has nothing to supply
    and no opportunity to collide with an existing row. The contract being replaced did the
    opposite - it accepted ``id: int`` from the client on both its create and its update route,
    generating nothing and checking nothing, so a duplicate identifier was storable and
    permanently shadowed every later record that shared it.
``slug``
    A slug is written once, when the category is created, and never afterwards. It is derived
    server-side by ``app.core.slug`` - ``slugify_title`` for the base, ``unique_slug`` for
    deterministic numeric suffixing against the slugs already taken - from a set that
    ``app.services.category_service`` supplies through one indexed prefix query. The slug is
    the canonical URL: ``GET /api/v1/categories/{slug}`` resolves against it, the generated
    sitemap enumerates it, and every canonical link tag is built from it. Letting a caller
    choose it, or change it, would invalidate published links and forfeit the search rankings
    attached to them. ``app.core.slug`` deliberately ships no "re-slug from the new name"
    helper, and :class:`CategoryUpdate` deliberately exposes no way to ask for one.

Uniqueness is not re-checked here either
----------------------------------------
``categories.name`` carries a ``UNIQUE`` constraint and ``categories.slug`` a unique index over
a ``CITEXT`` column, so ``Python`` and ``python`` are one slug and the second insert is
rejected by the database. Detecting that collision is ``app.services.category_service``'s job -
it raises the domain conflict error that renders as ``409`` - and duplicating the check in a
validator here would be a second, weaker copy of a guarantee the schema already enforces for
every writer rather than only for this one.

Import purity
-------------
Two sources, and no more: ``pydantic`` and the standard library. Not ``app.models`` - a request
model that imported a mapped class would drag SQLAlchemy, and with it the engine's import
graph, into the schema layer. Not ``app.core.config`` and not ``os.environ``: importing this
module performs no I/O, opens no connection and reads no setting, which is what lets a unit
test import it with nothing running. Not ``app.schemas.common`` either, since this module
declares no envelope of its own and so has nothing to take from it.
"""

import uuid
from datetime import datetime
from typing import Annotated, Final

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
)
from pydantic.json_schema import SkipJsonSchema

from app.schemas.common import omit_null_default

# The module's public contract is these four models and nothing else. The two length constants
# and the three annotated aliases below are shared machinery, importable by a test or by a
# validator mirroring these bounds on the client, but they are not part of the API surface that
# `app.schemas.__init__` re-exports. Sorted, because RUF022 requires it.
__all__ = [
    "CategoryCreate",
    "CategoryPublic",
    "CategorySummary",
    "CategoryUpdate",
]

NAME_MAX_LENGTH: Final[int] = 80
"""Upper bound on a category name, in characters.

Equal to ``app.core.slug.DEFAULT_MAX_LENGTH`` by intent rather than by coincidence: the slug is
derived from the name, so a name accepted at this bound yields a slug that fits the slug bound
without being truncated mid-title, and the URL a reader sees still reads as the name they were
shown. Eighty characters is also far more than a filter chip can display, so the bound rejects
abuse without constraining legitimate use.

Declared here rather than imported from ``app.core.slug`` because the two bounds answer
different questions - how long a display label may be, versus how long a derived path segment
may be - and coupling them would mean that widening a URL limit silently widened an input
contract. Both are documented, and either may move without dragging the other.
"""

DESCRIPTION_MAX_LENGTH: Final[int] = 500
"""Upper bound on a category description, in characters.

A description is a paragraph of orientation prose shown on a category listing and in the admin
editor, not an article - articles are posts. Five hundred characters comfortably holds two or
three sentences, which is what the surface renders, while keeping the payload of the category
list small: that list is fetched on every home-feed render to populate the filter control, so
each row is paid for repeatedly.
"""


def _blank_to_none(value: object) -> object:
    """Fold a whitespace-only submission to ``None`` before it is validated.

    ``categories.description`` is nullable, so "this category has no description" already has a
    representation: ``NULL``. An empty string is a second one, and two representations of one
    state is a defect waiting to happen - ``description or "..."`` in a template would treat
    them alike while ``description is None`` would not.

    A form is where the ambiguity comes from. An administrator who clears the description
    textarea submits ``""``, meaning "remove it", and the browser has no way to send an absent
    field from a populated form. Folding that here means the intent survives, and the value that
    reaches the database is the same ``NULL`` an omitted field would have produced.

    Anything that is not a blank string passes through untouched, including a non-string, so
    Pydantic still reports a genuine type error against the field rather than having it masked
    by a coercion performed here.

    Args:
        value: The raw submitted value, before any validation.

    Returns:
        ``None`` if ``value`` is a string with no non-whitespace character; ``value`` unchanged
        otherwise.
    """
    if isinstance(value, str) and not value.strip():
        return None
    return value


CategoryName = Annotated[
    str,
    StringConstraints(
        # Applied before the length rules, so a padded submission is measured after trimming:
        # "  Tech  " is accepted and stored as "Tech", and "   " is rejected as empty rather
        # than accepted as a three-character name that renders as a blank filter chip.
        strip_whitespace=True,
        min_length=1,
        max_length=NAME_MAX_LENGTH,
    ),
]
"""A validated category name, as both input models accept it.

Declared once and referenced by :class:`CategoryCreate` and :class:`CategoryUpdate` so the two
cannot drift: a bound tightened for a create and forgotten for a patch would let a value in
through the second route that the first refuses.
"""

CategoryDescription = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        # A supplied description must carry something. Absence is expressed by omitting the
        # field or by sending null - see `_blank_to_none`, which is what turns a cleared form
        # control into that absence rather than into a zero-length string.
        min_length=1,
        max_length=DESCRIPTION_MAX_LENGTH,
    ),
]
"""A validated, non-empty category description."""

OptionalCategoryDescription = Annotated[
    CategoryDescription | None,
    BeforeValidator(_blank_to_none),
]
"""A category description that may legitimately be absent.

``None`` is meaningful on both input models and means the same thing on each: the category has
no description. On a create it is the default, on a patch it is an instruction to clear one that
was set. The blank-folding validator runs first, so ``""`` and ``"   "`` reach the field as
``None`` instead of failing the ``min_length`` rule of the wrapped type.
"""


class CategorySummary(BaseModel):
    """A category as it appears attached to something else: identity, label, link target.

    Three fields, because three is what a badge needs. ``app.schemas.post`` embeds a
    ``list[CategorySummary]`` as the ``categories`` member of both ``PostSummary`` and
    ``PostDetail``, so every card in the home feed and every post detail page carries one of
    these per category: the ``name`` to render, the ``slug`` to link to, and the ``id`` for a
    client keying a list by something stable rather than by an array index.

    Why ``post_count`` is absent, which is a decision rather than an omission
    -----------------------------------------------------------------------
    A tally beside a badge on a post card would have to be computed per badge, and the query
    that renders the home feed is the single most performance-sensitive statement in the
    service: ``app.repositories.post_repository`` already composes relevance ranking, a category
    join, author filtering, status scoping, ordering and windowing into one statement plus one
    count. Adding a correlated aggregate per category per row would multiply that cost to
    produce a number the surface does not render. The tally belongs to
    :class:`CategoryPublic`, which is fetched once for the filter control.

    Validated from a mapped row rather than constructed by hand
    ----------------------------------------------------------
    ``from_attributes`` is enabled, so a service projects a loaded ``app.models.Category``
    directly::

        summaries = [CategorySummary.model_validate(category) for category in post.categories]

    That requires the collection to have been eagerly loaded by the statement that fetched the
    post - ``selectinload(Post.categories)``. Under an ``AsyncSession`` a lazy load raises
    ``MissingGreenlet`` at the point of access instead of quietly emitting an extra query, so a
    missing eager-load option surfaces as a failure here rather than as an N+1 in production.
    """

    model_config = ConfigDict(
        # Projected from a mapped `app.models.Category`, so attribute access has to be a valid
        # input - and for THIS model, which declares only columns the entity has,
        # `model_validate(category)` is genuinely all a service needs. A mapping whose keys are
        # these three field names validates as well, which is what lets a repository selecting
        # individual LABELLED columns feed it without materialising an entity. `CategoryPublic`
        # below adds `post_count`, which no entity carries, and its docstring records the
        # explicit projection that consequently becomes necessary there.
        from_attributes=True,
        json_schema_extra={
            # One category, carried through all four models in this module with the same values,
            # so /docs reads as a single coherent worked example rather than four unrelated
            # fragments.
            "example": {
                "id": "0a1b7c5e-9c3a-4a1e-8b2d-6f5c4d3e2a19",
                "name": "Python",
                "slug": "python",
            }
        },
    )

    id: uuid.UUID = Field(
        ...,
        description=(
            "Server-generated identifier, stable for the lifetime of the category. Generated by "
            "PostgreSQL through `gen_random_uuid()`, never supplied by a client. Use it as a "
            "collection key; use `slug` to build a URL."
        ),
    )
    name: str = Field(
        ...,
        description=(
            "Human-readable display label, unique across the taxonomy, shown verbatim on a "
            "filter chip and on a post's category badges. Never derived from the slug."
        ),
    )
    slug: str = Field(
        ...,
        description=(
            "URL-safe identifier used in canonical links, matching "
            "`^[a-z0-9]+(?:-[a-z0-9]+)*$`. Assigned once at creation and stable thereafter, so "
            "a link built from it stays valid. Compared case-insensitively by the database, so "
            "`/categories/Python` and `/categories/python` resolve to this same category."
        ),
    )


class CategoryPublic(CategorySummary):
    """A category as its own resource: the summary, plus the description, tally and age.

    The declared ``response_model`` of ``GET /api/v1/categories/{slug}``, and the item type of
    the page ``GET /api/v1/categories`` returns::

        @router.get("/categories", response_model=Page[CategoryPublic])
        @router.get("/categories/{slug}", response_model=CategoryPublic)

    It inherits :class:`CategorySummary` rather than restating ``id``, ``name`` and ``slug``, so
    a description edited on one model cannot leave the other describing the same wire field
    differently. Inherited fields keep their declaration order, so the serialised member order
    is ``id``, ``name``, ``slug``, ``description``, ``post_count``, ``created_at``.

    ``post_count`` is the reason this model exists
    ---------------------------------------------
    ``GET /api/v1/categories`` is specified as returning every category *with its post count*,
    because that is what the home-feed filter control renders: a chip reading ``Python (12)``.
    The tally is a ``COUNT`` issued by ``app.repositories.category_repository``, not a stored
    column and not a hybrid property on the mapped class - a stored counter would be a second
    source of truth that every publish, unpublish, delete and re-categorisation had to remember
    to update, and one missed path is a number that is wrong forever.

    That makes the count an attribute the *query* supplies rather than one the entity has, so a
    caller has to **project the two values explicitly**. This model is not validatable from the
    repository's return value as it stands, and that is worth being precise about because the
    shape is not obvious:
    :meth:`~app.repositories.category_repository.CategoryRepository.list_with_post_counts`
    returns ``Sequence[tuple[Category, int]]`` - a two-element tuple per category, the entity and
    its tally - so neither member of the pair carries all six of this model's fields and the pair
    itself carries none of them by name. The projection belongs to the service layer, which is
    the layer that knows the count is a ``post_count``::

        for category, post_count in await repository.list_with_post_counts():
            items.append(
                CategoryPublic(
                    id=category.id,
                    name=category.name,
                    slug=category.slug,
                    description=category.description,
                    post_count=post_count,
                    created_at=category.created_at,
                )
            )

    ``from_attributes`` remains enabled, and it is still doing work: it makes any object that
    carries all six as attributes a valid input, which is what a future repository returning a
    flat, correctly *labelled* select - ``select(Category.id, …, func.count(Post.id).label(
    "post_count"))`` - would produce, and ``model_validate(row._mapping)`` would then be the
    right spelling. What it cannot do is invent a member name. Measured against the pinned
    pydantic and the current query: both ``CategoryPublic.model_validate(row)`` and
    ``CategoryPublic.model_validate(row._mapping)`` raise ``ValidationError`` on a
    ``(Category, count)`` row, because the mapping's keys are the entity and the unlabelled
    aggregate rather than this model's fields.

    ``updated_at`` is deliberately not published
    --------------------------------------------
    The mapped class carries it - a category is editable, so "when was this renamed" is a
    question the audit columns answer - but no reader-facing surface asks it, and the admin
    editor works from ``name`` and ``description``. Publishing it would add a member to a
    payload that is fetched on every home-feed render, and a member that the endpoint reference
    and the client contract types would both have to keep describing. ``created_at`` is
    published because a taxonomy's growth over time is legitimately interesting; the modification
    instant is not.
    """

    model_config = ConfigDict(
        # Restated rather than inherited. Pydantic would merge the parent's configuration, so
        # this is not strictly required - but a response model whose validation source is not
        # obvious from its own class body is a model someone will eventually break by editing
        # the parent, and it also keeps `json_schema_extra` below from replacing a setting that
        # was only ever visible one class away.
        from_attributes=True,
        json_schema_extra={
            "example": {
                "id": "0a1b7c5e-9c3a-4a1e-8b2d-6f5c4d3e2a19",
                "name": "Python",
                "slug": "python",
                "description": "Language-level posts about CPython and its ecosystem.",
                "post_count": 12,
                "created_at": "2026-01-15T09:30:00Z",
            }
        },
    )

    description: str | None = Field(
        ...,
        description=(
            "Orientation prose for the category, or null when it has none. The key is always "
            "present, so a client never has to distinguish an absent member from a null one - "
            "only the value can be null."
        ),
    )
    post_count: int = Field(
        ...,
        # A COUNT cannot be negative, so bounding it here costs nothing and documents the
        # guarantee in /openapi.json. This is safe where the same bound on `Page.page` would not
        # be: FastAPI re-validates a handler's return value against its response model, so a
        # constraint that a legitimate value can violate turns a correct response into a 500.
        # `page` echoes back whatever a caller asked for, including a page past the end;
        # `post_count` is produced by an aggregate and has no such case.
        ge=0,
        description=(
            "How many PUBLISHED posts are filed under this category. Drafts and archived posts "
            "are excluded, so the tally always agrees with the number of results an anonymous "
            "caller gets from `GET /api/v1/posts?category={slug}`, and the existence of a draft "
            "is never disclosed by a public count. Zero is a real value - a category with no "
            "published posts yet - and is returned as `0`, not omitted."
        ),
    )
    created_at: datetime = Field(
        ...,
        description=(
            "Instant the category was created, from the database clock, as a timezone-aware "
            "ISO 8601 value in UTC - for example `2026-01-15T09:30:00Z`."
        ),
    )


class CategoryCreate(BaseModel):
    """The body of ``POST /api/v1/admin/categories``: a name, and optionally a description.

    Two members, both of them things only a human can decide. Everything else about the row is
    the server's to produce - the ``id`` from ``gen_random_uuid()``, the ``slug`` from
    ``app.core.slug``, ``created_at`` and ``updated_at`` from the database clock - so there is
    nothing else for a caller to send::

        {"name": "Python", "description": "Language-level posts about CPython."}

    ``extra="forbid"`` turns that from a convention into a contract. A request carrying ``id``
    or ``slug`` is rejected with ``422`` and a problem document naming the field, rather than
    being silently accepted with the extra member ignored - which is the failure mode that
    matters, because a client that believes it chose an identifier and was quietly overruled
    will keep using the identifier it chose. The module docstring records why each of those two
    members is the server's and not the caller's.

    What this model does NOT do
    --------------------------
    It does not check that ``name`` is free. ``categories.name`` is ``UNIQUE`` and
    ``categories.slug`` is a unique ``CITEXT`` index, so the collision is detected where the
    constraint lives; ``app.services.category_service`` translates it into the domain conflict
    error that renders as ``409``. A validator here could only ask a stale question - anything it
    learned would already be a race with the insert - and it would need a database session,
    which a schema module must not have.

    Reused, not redeclared
    ----------------------
    ``app.schemas.admin`` imports this class for the administrative route it belongs to and
    declares no variant of its own. See the module docstring.
    """

    model_config = ConfigDict(
        # No unknown member is accepted, and that is the whole enforcement mechanism behind
        # "identity and slugs are server-owned". Note the contrast with `ProblemDetail` in
        # app.schemas.common, which deliberately does NOT forbid extras: that is an outbound
        # document RFC 9457 permits callers to extend, whereas this is an inbound body where an
        # unrecognised member is always either a client bug or an attempt to write a field the
        # client does not own.
        extra="forbid",
        json_schema_extra={
            "example": {
                "name": "Python",
                "description": "Language-level posts about CPython and its ecosystem.",
            }
        },
    )

    name: CategoryName = Field(
        ...,
        description=(
            "Display label for the category, 1 to "
            f"{NAME_MAX_LENGTH} characters after surrounding whitespace is trimmed. Must be "
            "unique across the taxonomy; a duplicate is rejected with 409. The URL slug is "
            "derived from this value by the server and cannot be supplied."
        ),
    )
    description: OptionalCategoryDescription = Field(
        default=None,
        description=(
            "Optional orientation prose, up to "
            f"{DESCRIPTION_MAX_LENGTH} characters after trimming. Omit it, send null, or send an "
            "empty string to create the category without one - all three are equivalent and "
            "store null."
        ),
    )


class CategoryUpdate(BaseModel):
    """The body of ``PATCH /api/v1/admin/categories/{id}``: whichever members are changing.

    A genuine partial update. Every member is optional, and an omitted member means "leave this
    as it is" rather than "set this to null" - the distinction the service reads by dumping only
    what the caller actually sent::

        changes = payload.model_dump(exclude_unset=True)  # {} for an empty body

    That is what replaces the whole-object replacement the retired ``PUT /items/{item_id}``
    performed: it required the client to resend every field it was not changing, so a client
    holding a stale copy of the record silently reverted whatever it had not refreshed. Here,
    renaming a category touches ``name`` and nothing else.

    An empty body is a valid no-op, deliberately
    -------------------------------------------
    ``{}`` validates, dumps to ``{}`` and changes nothing. There is no "at least one field
    required" rule, because a form that submits an unmodified record is a legitimate request
    with a legitimate outcome, and rejecting it would make a harmless client behaviour an error.

    ``slug`` is absent from this model, and that is the point of it
    -------------------------------------------------------------
    A category may be renamed. Its slug may not change. The slug is the canonical URL: it is in
    every published link, every sitemap entry and every canonical link tag, so re-deriving it
    from a new name would break links that are already indexed and forfeit the rankings attached
    to them. ``app.core.slug`` ships no helper that recomputes one, and this model exposes no
    member that could ask for it - so a rename changes the label a reader sees while the address
    they bookmarked keeps resolving. A request carrying ``slug`` is rejected with ``422`` by
    ``extra="forbid"``, and the same applies to ``id``, which a path parameter already carries.

    Null is accepted for ``description`` and refused for ``name``
    -----------------------------------------------------------
    The asymmetry follows the columns. ``categories.description`` is nullable, so ``null`` is a
    meaningful instruction - "clear the description" - and it is honoured. ``categories.name`` is
    ``NOT NULL``, so there is no state for a null to mean: a caller who sends
    ``{"name": null}`` gets ``422`` naming the field, rather than a ``500`` from an integrity
    violation raised several layers away from the mistake that caused it.

    The published schema draws the same line: ``description`` advertises ``null`` among its
    types because it accepts one, and ``name`` does not, because it does not. That equality
    between the document and the behaviour is what stops a generated client offering a request
    the API answers with a ``422`` - see :func:`~app.schemas.common.omit_null_default`.

    Reused, not redeclared
    ----------------------
    ``app.schemas.admin`` imports this class rather than declaring an administrative variant.
    See the module docstring.
    """

    model_config = ConfigDict(
        # See CategoryCreate: an unknown member on an inbound body is always a defect, and
        # forbidding it is what makes `slug` unchangeable rather than merely undocumented.
        extra="forbid",
        json_schema_extra={
            # A description-only patch, chosen over a fuller one because the property readers
            # most often get wrong is that the omitted `name` is preserved rather than cleared.
            "example": {"description": "CPython internals, typing, packaging and tooling."}
        },
    )

    name: CategoryName | SkipJsonSchema[None] = Field(
        default=None,
        json_schema_extra=omit_null_default,
        description=(
            "New display label, 1 to "
            f"{NAME_MAX_LENGTH} characters after trimming. Omit it to leave the name unchanged. "
            "Must still be unique; a duplicate is rejected with 409. Renaming does NOT change "
            "the category's slug, so existing links keep resolving. Null is not accepted."
        ),
    )
    """New label, or omitted to leave it unchanged. Optional but not nullable.

    ``SkipJsonSchema[None]`` keeps ``null`` out of the member's published type and
    :func:`~app.schemas.common.omit_null_default` removes the contradictory ``default: null``, so
    the document describes a plain optional string - which is what :meth:`_reject_null_name`
    enforces. The two agreed in prose before and disagreed in the schema, which is the form of
    the mismatch a generated client actually consumes.
    """
    description: OptionalCategoryDescription = Field(
        default=None,
        description=(
            "New orientation prose, up to "
            f"{DESCRIPTION_MAX_LENGTH} characters after trimming. Omit it to leave the existing "
            "description untouched; send null or an empty string to remove it."
        ),
    )

    @field_validator("name")
    @classmethod
    def _reject_null_name(cls, value: str | None) -> str | None:
        """Reject an explicitly submitted ``{"name": null}`` while leaving omission alone.

        The guard depends on a property of Pydantic that is easy to miss and is load-bearing
        here: a field validator runs only for a value the caller actually supplied, never for a
        field that fell back to its default. So this method never sees the ``None`` that an
        omitted ``name`` leaves behind, and ``CategoryUpdate()`` still validates and still dumps
        to ``{}`` under ``exclude_unset=True``. It fires only when ``null`` was written in the
        request body on purpose.

        Without it, that ``null`` would survive ``model_dump(exclude_unset=True)`` as a real
        change, reach a ``NOT NULL`` column, and surface as an integrity error - a ``500``
        describing a database constraint, several layers from the request member that caused it,
        instead of a ``422`` naming the field.

        Args:
            value: The submitted name. ``None`` only if the caller sent an explicit null.

        Returns:
            ``value`` unchanged, once it is known not to be ``None``.

        Raises:
            ValueError: If ``value`` is ``None``. Pydantic renders it as a field-level entry in
                the ``422`` problem document, keyed to ``name``.
        """
        if value is None:
            raise ValueError(
                "name may not be null; omit the field to leave the current name unchanged"
            )
        return value
