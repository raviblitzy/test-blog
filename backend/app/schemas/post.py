"""The four request and response shapes of a blog post - the contract the product turns on.

A post is the entity every other feature in this service exists to serve: the home feed lists
them, search ranks them, a category filters them, a profile groups them by author, a comment
hangs off one, a like counts against one, and the administrative dashboard moderates them. This
module fixes the wire format of all of that, and holds nothing else - no query, no slug
derivation, no ownership rule, no publish transition, no sanitisation, no status decision.

Four models, and the surface each one is
----------------------------------------
:class:`PostCreate`
    The request body of ``POST /api/v1/posts``, which creates a **draft**.
:class:`PostUpdate`
    The request body of ``PATCH /api/v1/posts/{id}``, a genuine partial update.
:class:`PostSummary`
    The item type of every listing - the home feed, an author's public profile, the author's own
    workspace and the administrative posts table - carried as ``Page[PostSummary]``.
:class:`PostDetail`
    The declared ``response_model`` of the five routes that answer with one post.

One model became four, and the split is the whole point
-------------------------------------------------------
The service this repository grew out of expressed its entire domain as a single three-field
class - an integer identifier, a name and a price - and then used that one class for four
different jobs: the body of its create route, the body of its full-replacement update route, the
payload of its collection read, and the payload of its single read. Four conflations travelled in
that one declaration, and each of the four models here exists to break one of them:

Identity was the client's to choose
    The identifier was an ordinary member of the request body, so the server generated nothing
    and checked nothing. Two records could be stored under one identifier, and the first of them
    permanently shadowed the second on every read, update and delete, because every one of those
    handlers stopped at the first match. Neither input model here accepts an identifier at all.
Create and update were the same shape
    A create had to send every field and so did an update, because they were one model. Here they
    are two, and the difference between them is the contract: what a create requires, an update
    makes optional.
An update replaced the whole record
    The update route assigned the submitted object over the stored one, so a client that held a
    stale copy silently reverted every field it had not refreshed. :class:`PostUpdate` changes
    only what was sent.
A list item was the same as a detail
    The collection read returned whole records, body and all. :class:`PostSummary` deliberately
    does not, for the reason immediately below.

:class:`PostSummary` carries no body, and that is the most consequential line here
---------------------------------------------------------------------------------
``posts.content`` is unbounded ``TEXT`` holding a whole article, and the home feed renders twenty
posts per page. Publishing the body in the list projection would multiply the payload of the most
requested endpoint in the product by whatever the average article weighs - transferred, parsed and
then thrown away by a card that renders a title, an excerpt and a byline. The body belongs to
:class:`PostDetail`, which is fetched once, for the one post a reader actually opened.

What no input model accepts
---------------------------
This is the load-bearing property of the module, and ``extra="forbid"`` on both input models is
what makes it enforced rather than merely documented: a request carrying any of these members is
rejected with ``422`` and a problem document naming the offending field, instead of being quietly
accepted with the member ignored. A client that believes it set a field and was silently overruled
keeps sending it.

``id``
    Identity originates in PostgreSQL. ``app.db.base.UUIDPrimaryKeyMixin`` declares the surrogate
    key with a ``gen_random_uuid()`` server default, so a caller has nothing to supply and no
    opportunity to collide with a row that already exists.
``slug``
    Derived once, server-side, by ``app.core.slug`` - ``slugify_title`` for the base and
    ``unique_slug`` for deterministic numeric suffixing - and never changed afterwards. The slug
    *is* the canonical URL: ``GET /api/v1/posts/{slug}`` resolves against it, every canonical link
    tag is built from it and the generated sitemap enumerates it. Letting a caller choose it, or
    change it, would invalidate links that are already indexed and forfeit the rankings attached to
    them. ``app.core.slug`` ships no "re-slug this" helper and neither input model exposes a member
    that could ask for one.
``status`` and ``published_at``
    They move together, only through the two first-class transitions - ``POST
    /api/v1/posts/{id}/publish`` and ``POST /api/v1/posts/{id}/unpublish`` - because a published
    post without a publication instant is forbidden by a database ``CHECK`` constraint. Exposing
    either as a patchable member would let a general update path reach half of a paired change.
``view_count``
    Server-owned: a counter a client could set is not a counter, so it appears on the projections
    and on neither input model. Nothing advances it at present - no route in this surface
    increments it - so it reads ``0`` on every post, which is why ``PostSortOption`` deliberately
    offers no ``"popular"`` value. The column is published anyway so that counting reads later is a
    service change behind an unchanged contract.
``author_id``
    Taken from the principal that ``app.core.dependencies`` resolved from the bearer token, never
    from a body. Reading ownership out of the request would let any authenticated caller publish
    under any other account's byline.
``search_vector``
    A column PostgreSQL generates from the title, excerpt and body on every write. Nothing in the
    backend writes it, and no wire format mentions it in either direction.
``created_at`` and ``updated_at``
    Stamped from the database clock by ``app.db.base.TimestampMixin``. An audit column a caller
    could set is not an audit column.

Publish is a transition, not a flag
-----------------------------------
The lifecycle is :class:`~app.models.post.PostStatus`, a three-state enumeration persisted as a
native PostgreSQL type, and it is imported from ``app.models`` rather than restated here as a
union of string literals. A second declaration of the same three states is a second source of
truth, and the two would disagree the first time a state was added on one side only.

No collection wrapper, and no envelope
--------------------------------------
Every listing of posts is returned as the generic page envelope re-exported by
``app.schemas.common``, parameterised at the route::

    @router.get("/posts", response_model=Page[PostSummary])

So there is no ``PostList``, no ``PostsResponse`` and above all no wrapper carrying a human
message beside a payload member. The retired service wrapped its create and update results that
way while returning bare payloads from both of its reads, so a client could not tell from a route
which of the two shapes it would receive; ``app.schemas.common`` permits exactly three response
shapes - a page envelope for a collection, a bare representation for a single read, a problem
document for a failure - and forbids a fourth. Nor is there a delete-response model, because
deleting a post answers ``204 No Content``, which has no body for one to describe.

The two directions disagree about two members, deliberately
-----------------------------------------------------------
``cover_image_url`` is :class:`~pydantic.HttpUrl` on the way in and :class:`str` on the way out.
Inbound, a caller-supplied value has to be proved an absolute ``http`` or ``https`` URL before it
reaches a column that will be interpolated into an image source; the scheme allow-list is what
keeps that field from becoming a script vector. Outbound, the value was already validated when it
was stored, so re-parsing it per feed card would cost a parse per row and would turn an old row
that no longer parses into a failed read.

The consequence for the service layer is the one cross-layer obligation this module imposes, and
it is repeated on the field itself: :class:`~pydantic.HttpUrl` validates to a ``Url`` object, not
to a :class:`str`, so the value must be coerced with ``str(value)`` before it is assigned to the
``Text`` column.

The categories members differ too. Inbound it is ``category_ids``, a bounded list of identifiers,
because that is what a form control produces and all a caller can know. Outbound it is
``categories``, a list of :class:`~app.schemas.category.CategorySummary`, because a badge has to
render a name and link to a slug and would otherwise need one request per identifier.

The wire's ordering vocabulary lives here
-----------------------------------------
:data:`PostSortOption` mirrors ``app.repositories.post_repository.PostSort`` value for value, and
the duplication is intentional. A repository must not import the schema layer, so the storage
vocabulary is declared where the statement is composed and the wire vocabulary is declared where
the wire is described - here, which is what puts it in ``/openapi.json`` as a documented enumerated
query parameter rather than as an unvalidated free-text one.

What this module does NOT do
---------------------------
It declares. It does not decide.

* It does not derive a slug. That is ``app.core.slug``, called by ``app.services.post_service``.
* It does not check ownership. An author may act on their own post and an administrator on any,
  and that comparison lives in ``app.services.post_service`` - so the same rule holds however the
  operation is reached, and is unit-testable without a request.
* It does not clean authored Markdown. Write-side sanitisation belongs to the service, and the
  rendered output is sanitised again at the client boundary: two boundaries, neither of them a
  schema validator, which cannot know which of the two it is standing at.
* It does not re-check what the database already guarantees - the publication ``CHECK``, the
  case-insensitively unique slug - because a validator here would be a second, weaker copy of a
  rule the schema enforces for every writer rather than only for this one.
* It does not choose a status code. ``app.core.exceptions`` maps a domain failure to a response.

Import purity
-------------
Four sources: the standard library's :mod:`uuid` and :class:`~datetime.datetime`, the typing
constructs the annotated aliases need, ``pydantic``, and three names from inside this application -
:class:`~app.models.post.PostStatus` from ``app.models``,
:class:`~app.schemas.category.CategorySummary` and :class:`~app.schemas.user.UserPublic` from two
sibling schema modules.

Those last two are the only sibling imports anywhere in this package, and they point the right way.
Both siblings are leaves: neither imports a schema module of its own, so the package's internal
graph is a two-level tree rather than a cycle, and the import order of this package stays
irrelevant. Taking them is also the whole point of them existing. One author projection serves
every byline in the product, so the single easiest place to leak an email address is also the
single most effective place to prevent it - which a local copy of "the author bits I need" would
throw away. ``app.schemas.common`` is deliberately *not* imported: this module declares no envelope
and so has nothing to take from it.

Nothing here reads the environment, opens a connection, holds a session or reads a setting.
Importing this module performs no I/O, which is what lets a unit test import it with nothing
running and no database reachable.
"""

import uuid
from datetime import datetime
from typing import Annotated, Final, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    HttpUrl,
    StringConstraints,
    ValidationInfo,
    field_validator,
)
from pydantic.json_schema import SkipJsonSchema

from app.models import PostStatus
from app.schemas.category import CategorySummary
from app.schemas.common import omit_null_default
from app.schemas.user import UserPublic

# The module's public contract is these four models, in the order RUF022 enforces. The bounds,
# the ordering vocabulary and the annotated aliases below are shared machinery - importable by a
# router validating a query parameter, by a test, or by a client-side validator mirroring a
# bound - but they are not part of the surface `app.schemas.__init__` re-exports, exactly as the
# two length constants in `app.schemas.category` are not. Keep this list in step with what the
# module defines: mypy's strict `no_implicit_reexport` consults it, and it is what tells a reader
# that the three names imported above are dependencies rather than re-exports.
__all__ = ["PostCreate", "PostDetail", "PostSummary", "PostUpdate"]


# ---------------------------------------------------------------------------------------
# Input bounds
#
# `posts.title`, `posts.excerpt` and `posts.content` are all unbounded `TEXT`, and
# `posts.cover_image_url` is too, so these constants are the ONLY limits that exist anywhere
# in the system. The columns will store whatever they are handed; this module is the boundary
# that decides what they are handed, and a violation here is a 422 naming the field rather
# than a row nobody can render.
# ---------------------------------------------------------------------------------------

TITLE_MIN_LENGTH: Final[int] = 1
"""Shortest accepted title, applied after surrounding whitespace is trimmed.

One character, so a single-glyph headline in any script is allowed, combined with stripping so
that a whitespace-only submission is rejected as too short rather than stored as a value that
renders as a blank card, a blank page heading and a blank browser tab. ``posts.title`` is
``NOT NULL`` and is rendered unconditionally on every surface a post appears on.
"""

TITLE_MAX_LENGTH: Final[int] = 120
"""Longest accepted title, in characters.

Chosen against the slug bound rather than independently of it. ``app.core.slug`` derives the slug
within :data:`~app.core.slug.DEFAULT_MAX_LENGTH` - eighty characters - and truncates **on a word
boundary**, so a title longer than that still yields a slug made of whole words, and that slug is
then frozen for the life of the post. One hundred and twenty is therefore deliberately wider than
eighty: a headline legitimately carries a subtitle after a colon, and the consequence of accepting
one is a shorter slug, not a broken or mid-word one.

The number is also generous against every surface that renders it. A search result shows roughly
sixty characters of a title and a social card roughly seventy, so the bound is twice what any
consumer displays in full and rejects abuse rather than constraining authorship.

Deliberately *not* equal to ``app.schemas.category.NAME_MAX_LENGTH``, which is eighty precisely so
that a category name is never truncated in its own slug. A category label is a filter chip; a post
title is a headline. The two answer different questions and either may move without the other.
"""

EXCERPT_MAX_LENGTH: Final[int] = 500
"""Longest accepted excerpt, in characters.

An excerpt is the short summary that stands in for the body: the paragraph on a feed card, the
meta description of the post's page and the description on its social card. Five hundred characters
comfortably holds two or three sentences, which is what those surfaces render - a search snippet
shows only the first hundred and sixty or so - and it matches the bound
``app.schemas.category`` places on a description and ``app.schemas.user`` on a biography, for the
same reason in all three places: the value is carried on a listing that is fetched repeatedly, so
its size is paid for again on every render.
"""

CONTENT_MAX_LENGTH: Final[int] = 100_000
"""Longest accepted post body, in characters.

Generous but finite. A hundred thousand characters is roughly sixteen thousand words, several times
the longest article anyone writes for a blog, so the bound never constrains authorship - and it is
not arbitrary at the upper end either. Three costs scale with this number, and the last of the
three is a hard limit rather than a matter of degree:

* The write-side sanitisation pass the service performs walks the whole body once per write.
* Every one of these characters is transferred to the client of ``GET /api/v1/posts/{slug}``.
* ``posts.search_vector`` is a **generated** column PostgreSQL re-derives from the title, excerpt
  and body on every write, and a ``tsvector`` may not reach one mebibyte. Beyond that ceiling the
  ``INSERT`` itself fails, inside the database, as a driver error on a write the caller believed
  was valid. This bound keeps the combined vector an order of magnitude clear of it, so an
  oversized body is refused at the boundary as a ``422`` naming the field instead.
"""

MAX_CATEGORIES_PER_POST: Final[int] = 10
"""Most categories one request may file a post under.

A cap rather than a limit anyone will reach: a post genuinely belongs to one to three categories,
and ten leaves room for a taxonomy far broader than this product's. What it prevents is an
unbounded association set - without it a single request could name every category in the database,
and the service would issue that many existence checks and write that many association rows on the
strength of one payload. ``app.services.post_service`` performs the association itself and
validates that each identifier names a category that exists.
"""


# ---------------------------------------------------------------------------------------
# The wire's ordering vocabulary.
#
# Declared here rather than imported from `app.repositories.post_repository`, whose `PostSort`
# carries these same two values. The direction of that dependency is the reason: a repository
# must not import the schema layer, so the vocabulary is stated once on each side of the
# boundary - the storage side where the statement is composed, the wire side here where the
# request is described. The two are value-identical by intent, and a value added to either is
# a change to both.
# ---------------------------------------------------------------------------------------

PostSortOption = Literal["recent", "relevance"]
"""How a caller may ask for a listing of posts to be ordered.

``"recent"``
    Publication instant, newest first - the home page's primary query, and the ordering the
    composite index on the lifecycle state and publication instant exists to serve.
``"relevance"``
    Ranked against the generated search vector, best match first, with typo-tolerant title
    similarity as the secondary key. Meaningful only alongside a search term; with none, the
    repository degrades it to recency rather than raising, because a listing is not the place to
    reject a parameter combination that has an obvious reading.

Declared as an enumerated alias rather than left as free text so that an unrecognised value is a
``422`` naming the parameter, and so that ``/openapi.json`` publishes the two accepted values and
``/docs`` renders them as a picker. There is deliberately no ``"popular"``: no endpoint in this
surface advances ``posts.view_count``, so ordering by it would be uniformly zero, and shipping a
sort value that silently does nothing is worse than not shipping it.
"""

DEFAULT_POST_SORT_OPTION: Final[PostSortOption] = "recent"
"""The ordering applied when a caller expresses no preference.

Named rather than repeated as a literal at each route, so the feed, the profile listing and the
administrative table cannot drift onto different defaults. Equal to
``app.repositories.post_repository.DEFAULT_POST_SORT``, for the reason recorded above it.
"""


def _blank_to_none(value: object) -> object:
    """Fold a whitespace-only submission to ``None`` before the field is validated.

    ``posts.excerpt`` and ``posts.cover_image_url`` are both nullable, so "this post has no
    excerpt" and "this post has no cover image" already have a representation: ``NULL``. An empty
    string is a second representation of the same state, and two representations of one state is a
    defect waiting to happen - ``excerpt or fallback`` in a template would treat them alike while
    ``excerpt is None`` would not, and an empty image source renders as a broken image rather than
    as no image.

    A form is where the ambiguity comes from. An author who clears the excerpt textarea or the
    cover-image input submits ``""``, meaning "remove this", and a browser cannot send an absent
    field from a populated form. Folding the blank here means the intent survives: the value
    reaching the column is the same ``NULL`` an omitted field would have produced, and it reaches
    it through the same code path.

    Anything that is not a blank string passes through untouched, including a non-string, so
    Pydantic still reports a genuine type error against the field rather than having it masked by
    a coercion performed here - and ``"not a url"`` still fails the URL rules it should fail.

    Restated rather than imported from the two sibling modules that carry the same helper for the
    same reason. Importing it would make this package's import order load-bearing for four lines
    of code, and the pattern is deliberately per-module: each module folds blanks for its own
    nullable columns and answers for that decision itself.

    Args:
        value: The raw submitted value, before any validation.

    Returns:
        ``None`` if ``value`` is a string with no non-whitespace character; ``value`` unchanged
        otherwise.
    """
    if isinstance(value, str) and not value.strip():
        return None
    return value


def _require_content(value: str) -> str:
    """Reject a body that is technically non-empty but carries nothing.

    ``min_length`` alone cannot express this, because a single space satisfies it. The check runs
    *after* the length rules and returns the value unchanged, which is the important part: unlike
    :data:`PostTitle` and :data:`PostExcerpt`, the body is deliberately not stripped, so the guard
    has to detect the blank without trimming it. See :data:`PostContent` for why.

    Args:
        value: The submitted body, already known to be a string within its length bounds.

    Returns:
        ``value`` byte for byte, once it is known to carry a non-whitespace character.

    Raises:
        ValueError: If the body is whitespace only. Pydantic renders it as a field-level entry in
            the ``422`` problem document, keyed to ``content``.
    """
    if not value.strip():
        raise ValueError("content must contain at least one non-whitespace character")
    return value


PostTitle = Annotated[
    str,
    StringConstraints(
        # Applied before the length rules, so a padded submission is measured after trimming:
        # "  Scaling FastAPI  " is accepted and stored as "Scaling FastAPI", and "   " is rejected
        # as empty rather than accepted as a three-character title. Trimming also matters to the
        # slug, which is derived from this value: leading whitespace would otherwise be one more
        # thing the derivation had to defend against.
        strip_whitespace=True,
        min_length=TITLE_MIN_LENGTH,
        max_length=TITLE_MAX_LENGTH,
    ),
]
"""A validated post title, as both input models accept it.

Declared once and referenced by :class:`PostCreate` and :class:`PostUpdate` so the two cannot
drift: a bound tightened for a create and forgotten for a patch would let a value in through the
second route that the first refuses.
"""

PostExcerpt = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        # A supplied excerpt must carry something. Absence is expressed by omitting the field or
        # by sending null - see `_blank_to_none`, which is what turns a cleared form control into
        # that absence rather than into a zero-length string stored in a nullable column.
        min_length=1,
        max_length=EXCERPT_MAX_LENGTH,
    ),
]
"""A validated, non-empty excerpt."""

OptionalPostExcerpt = Annotated[PostExcerpt | None, BeforeValidator(_blank_to_none)]
"""An excerpt that may legitimately be absent.

``None`` is meaningful and means "this post has no excerpt": on a create it is the default, on a
patch it is the instruction to clear one that was set. The blank-folding validator runs first, so
``""`` and ``"   "`` arrive at the field as ``None`` instead of failing the ``min_length`` rule of
the wrapped type.
"""

PostContent = Annotated[
    str,
    StringConstraints(min_length=1, max_length=CONTENT_MAX_LENGTH),
    AfterValidator(_require_content),
]
"""A validated post body, as authored Markdown.

``strip_whitespace`` is deliberately **absent**, and it is the one place in this module where a
submitted value is stored exactly as it arrived. Leading whitespace is significant in Markdown - a
four-space indent opens a code block - so trimming the body would silently change the document a
reader is shown, which is a mutation no boundary is entitled to make. The whitespace-only case that
stripping would otherwise have caught is handled by :func:`_require_content`, which detects it
without touching the value.

Nothing here sanitises. Rich text authored by one account and rendered to every reader is this
schema's only stored-injection surface, and it is cleaned at two boundaries - on write by
``app.services.post_service`` and again where it is rendered - neither of which is a schema
validator, because a validator cannot know which of the two it is standing at.
"""

OptionalCoverImageUrl = Annotated[HttpUrl | None, BeforeValidator(_blank_to_none)]
"""A cover-image URL that may legitimately be absent, validated as an absolute HTTP(S) URL.

:class:`~pydantic.HttpUrl` accepts only the ``http`` and ``https`` schemes and requires a host, so
a script URL, an inline data URL, a site-relative path and plain prose are all rejected with a
``422`` naming the field. That matters more than input hygiene usually does: the stored value is
interpolated into an image source on every card and every post page, so the scheme allow-list is
the control that keeps an author-supplied field from becoming a script vector.

It also carries an inherent ceiling of 2083 characters, which Pydantic publishes as ``maxLength``
in the generated schema, so no explicit bound is declared for it here.

A URL reference and nothing more: this design has no upload pipeline and no object store, and null
is the expected common case rather than an exceptional one, because the client generates a default
social card for a post without a cover image.

The validated value is a ``Url`` object rather than a :class:`str`. See
:attr:`PostCreate.cover_image_url` for the coercion the service layer owes this type.
"""

CategoryIdList = Annotated[list[uuid.UUID], Field(max_length=MAX_CATEGORIES_PER_POST)]
"""A bounded list of category identifiers, as both input models accept it.

The bound is declared here rather than at each field so that the create and the patch cannot be
capped differently. Order carries no meaning - the association is a set - and repeating an
identifier has the same effect as naming it once, because ``app.services.post_service`` collapses
duplicates before it writes, which the association table's composite primary key would otherwise
turn into an integrity error.
"""


class PostCreate(BaseModel):
    """The body of ``POST /api/v1/posts``: everything about a new post a human decides.

    Five members, and the request creates a **draft** - always, with no way to ask otherwise. A
    post reaches the public feed through ``POST /api/v1/posts/{id}/publish`` and never through the
    route this model serves, so an author cannot publish by accident and a client cannot skip the
    transition that stamps the publication instant::

        {"title": "Scaling FastAPI", "content": "## Why one process was never enough"}

    That is a complete, valid request: a title and a body are the only required members. The
    excerpt, the cover image and the categories are all optional, because a post is publishable
    without any of them.

    Everything else about the row is the server's to produce - the identifier from
    ``gen_random_uuid()``, the slug from ``app.core.slug``, the lifecycle state from the column's
    own default, the view counter from its default, the search vector from PostgreSQL, the audit
    instants from the database clock, and the author from the resolved principal - so there is
    nothing else for a caller to send. ``extra="forbid"`` turns that from a convention into a
    contract; the module docstring records why each rejected member is the server's and not the
    caller's.

    What this model does NOT do
    --------------------------
    It does not check that the derived slug is free. ``posts.slug`` is a unique index over a
    case-insensitive column, so the collision is detected where the constraint lives, and
    ``app.core.slug`` resolves it deterministically *before* the insert by suffixing against the
    slugs already taken. A validator here could only ask a stale question - anything it learned
    would already be a race with the insert - and it would need a database session, which a schema
    module must not have.

    It does not verify that the supplied category identifiers exist. That is a lookup, and lookups
    belong to ``app.services.post_service``, which resolves each one and raises the domain
    not-found error for any that names nothing.
    """

    model_config = ConfigDict(
        # No unknown member is accepted, and this is the whole enforcement mechanism behind
        # "identity, slugs and lifecycle are server-owned". Note the contrast with `ProblemDetail`
        # in app.schemas.common, which deliberately does NOT forbid extras: that is an outbound
        # document RFC 9457 permits callers to extend, whereas this is an inbound body where an
        # unrecognised member is always either a client bug or an attempt to write a field the
        # client does not own.
        extra="forbid",
        json_schema_extra={
            # One post, carried through all four models in this module with the same values, and
            # filed under the category `app.schemas.category` uses in its own example - so /docs
            # reads as a single coherent worked example across both modules rather than as
            # unrelated fragments. The cover host is `example.com` deliberately: nothing here
            # points at a real image, an account or a credential.
            "example": {
                "title": "Scaling FastAPI",
                "excerpt": "What changes when a single process is no longer enough.",
                "content": (
                    "## Why one process was never enough\n\n"
                    "A module-level list is not storage: it does not survive a restart."
                ),
                "cover_image_url": "https://example.com/covers/scaling-fastapi.png",
                "category_ids": ["0a1b7c5e-9c3a-4a1e-8b2d-6f5c4d3e2a19"],
            }
        },
    )

    title: PostTitle = Field(
        ...,
        description=(
            f"The post's headline, {TITLE_MIN_LENGTH} to {TITLE_MAX_LENGTH} characters after "
            "surrounding whitespace is trimmed. The URL slug is derived from this value by the "
            "server and cannot be supplied; a title longer than 80 characters yields a slug "
            "truncated at a word boundary, and that slug is then permanent, so retitling a "
            "published post does not move it."
        ),
    )
    excerpt: OptionalPostExcerpt = Field(
        default=None,
        description=(
            f"Optional short summary, up to {EXCERPT_MAX_LENGTH} characters after trimming. Omit "
            "it, send null, or send an empty string to create the post without one - all three "
            "are equivalent and store null. Rendered on the feed card in place of the body, and "
            "used as the page's meta description and social-card description when present."
        ),
    )
    content: PostContent = Field(
        ...,
        description=(
            f"The post body as Markdown, 1 to {CONTENT_MAX_LENGTH} characters. Stored exactly as "
            "submitted - leading whitespace is significant in Markdown, so nothing is trimmed - "
            "but it must carry at least one non-whitespace character. Sanitised by the service "
            "on write and again where it is rendered, so a submission is never rejected for "
            "containing markup; the markup is simply cleaned."
        ),
    )
    cover_image_url: OptionalCoverImageUrl = Field(
        default=None,
        description=(
            "Optional absolute http(s) URL of the post's hero image. A URL reference only: this "
            "API accepts no uploaded bytes. Omit it, send null, or send an empty string to create "
            "the post without one. Validated to a URL object rather than a string, so the service "
            "layer coerces it with `str(value)` before assigning it to the text column."
        ),
    )
    category_ids: CategoryIdList = Field(
        default_factory=list,
        description=(
            "Identifiers of the categories to file the post under, at most "
            f"{MAX_CATEGORIES_PER_POST}. Omit it or send an empty list to create the post "
            "uncategorised. Order is not significant and a repeated identifier has the same "
            "effect as naming it once. Each identifier must name an existing category; one that "
            "does not is rejected with 404."
        ),
    )

    # ---------------------------------------------------------------------------------
    # Members this model deliberately does not declare. `extra="forbid"` makes each one a
    # 422 naming the field, and each is refused for its own reason:
    #
    #   id                         identity is generated by PostgreSQL
    #   slug                       derived once from the title and then immutable, because the
    #                              canonical URL a reader bookmarked has to keep resolving
    #   status, published_at       they change only through the publish and unpublish
    #                              transitions, which set both together
    #   view_count                 server-owned; a counter a client could set is not one
    #   author_id                  taken from the resolved principal, never from a body
    #   search_vector              a column PostgreSQL generates on every write
    #   created_at, updated_at     stamped from the database clock
    #
    # The module docstring carries the full reasoning for each. Adding any of them here would
    # not merely widen this contract - it would move a decision out of the layer that owns it.
    # ---------------------------------------------------------------------------------


class PostUpdate(BaseModel):
    """The body of ``PATCH /api/v1/posts/{id}``: whichever members are changing.

    A genuine partial update. Every member is optional, and an omitted member means "leave this as
    it is" rather than "set this to null" - the distinction the service reads by dumping only what
    the caller actually sent::

        changes = payload.model_dump(exclude_unset=True)  # {} for an empty body

    That is what replaces the whole-object replacement the retired ``PUT /items/{item_id}``
    performed: it assigned the submitted object over the stored one, so a client holding a stale
    copy silently reverted every field it had not refreshed. Here, fixing a typo in a title touches
    the title and nothing else - not the body, not the excerpt, and not the categories.

    An empty body is a valid no-op, deliberately
    -------------------------------------------
    ``{}`` validates, dumps to ``{}`` and changes nothing. There is no "at least one field
    required" rule, because a form that submits an unmodified record is a legitimate request with a
    legitimate outcome, and rejecting it would make a harmless client behaviour an error.

    ``category_ids`` replaces the set; it does not add to it
    ------------------------------------------------------
    This is the one member where absence and emptiness are genuinely different instructions, and
    the difference is worth stating precisely because a client cannot guess it:

    * **Omitted** - the post's categories are left exactly as they are.
    * **An empty list** - every association is removed and the post becomes uncategorised.
    * **A populated list** - the association set becomes exactly that list. Any category not named
      is unfiled, so a client adding one category must send the ones it is keeping as well.
    * **Null** - rejected with ``422``. There is no state for it to mean: "no categories" is the
      empty list and "do not touch them" is omission, so a third encoding could only be a client
      bug, and accepting it would make one of the other two ambiguous.

    ``status`` is absent, and that absence is the publish contract
    ------------------------------------------------------------
    Publishing is a transition, not a member of a general update, so this model exposes no way to
    ask for it and a request carrying ``status`` is rejected with ``422``. The two transitions -
    ``POST /api/v1/posts/{id}/publish`` and ``POST /api/v1/posts/{id}/unpublish`` - set the
    lifecycle state and the publication instant together, which is what keeps the database's
    publication ``CHECK`` satisfiable by construction. A patchable flag would let one half of that
    pair be written without the other, and the failure would surface as an integrity violation
    several layers from the request that caused it.

    ``slug`` is absent for the same kind of reason
    --------------------------------------------
    A post may be retitled. Its slug may not change. The slug is in every published link, every
    sitemap entry and every canonical link tag, so re-deriving it from a new title would break
    links that are already indexed and forfeit the rankings attached to them. ``app.core.slug``
    ships no helper that recomputes one, and this model exposes no member that could ask for it -
    so a retitle changes the headline a reader sees while the address they bookmarked keeps
    resolving. The same applies to ``id``, which the path already carries.

    Null is accepted for two members and refused for two
    --------------------------------------------------
    The asymmetry follows the columns, exactly. ``posts.excerpt`` and ``posts.cover_image_url`` are
    nullable, so ``null`` is a meaningful instruction - "clear this" - and it is honoured.
    ``posts.title`` and ``posts.content`` are ``NOT NULL``, so there is no state for a null to
    mean: a caller who sends one gets a ``422`` naming the field, rather than a ``500`` from an
    integrity violation raised several layers away from the mistake that caused it.
    ``category_ids`` is refused a null too, and for a third reason again: it has three states
    that matter - omitted, an empty list, and a list of identifiers - and a null would be a
    fourth spelling of one of the first two.

    The published schema draws exactly that line rather than describing it: the two nullable
    members advertise ``null`` among their types because they accept it, and the three that
    refuse it do not advertise it - so ``/openapi.json`` and ``/docs`` cannot publish a request
    this model rejects. See :func:`~app.schemas.common.omit_null_default`.

    Who may send this at all is not decided here
    -------------------------------------------
    An author may patch their own post and an administrator may patch any; that comparison is
    ``app.services.post_service``'s, made against the principal ``app.core.dependencies``
    resolved. A model that validated authority would be a model whose authority rules ran wherever
    it happened to be constructed.
    """

    model_config = ConfigDict(
        # See PostCreate: an unknown member on an inbound body is always a defect, and forbidding
        # it is what makes `status` and `slug` unchangeable rather than merely undocumented.
        extra="forbid",
        json_schema_extra={
            # A title-and-excerpt patch, chosen over a fuller one because the property readers most
            # often get wrong is that the omitted members - the body, the cover image and above all
            # the categories - are preserved rather than cleared.
            "example": {
                "title": "Scaling FastAPI in production",
                "excerpt": "What changes when a single process is no longer enough.",
            }
        },
    )

    title: PostTitle | SkipJsonSchema[None] = Field(
        default=None,
        json_schema_extra=omit_null_default,
        description=(
            f"New headline, {TITLE_MIN_LENGTH} to {TITLE_MAX_LENGTH} characters after trimming. "
            "Omit it to leave the title unchanged. Retitling does NOT change the post's slug, so "
            "existing links keep resolving. Null is not accepted."
        ),
    )
    """New headline, or omitted to leave it unchanged. Optional but not nullable.

    ``posts.title`` is ``NOT NULL``, so ``null`` describes no state and
    :meth:`_reject_null_text` refuses it. The annotation now says the same thing:
    ``SkipJsonSchema[None]`` keeps ``null`` out of the published type and
    :func:`~app.schemas.common.omit_null_default` drops the contradictory ``default: null``.
    """
    excerpt: OptionalPostExcerpt = Field(
        default=None,
        description=(
            f"New short summary, up to {EXCERPT_MAX_LENGTH} characters after trimming. Omit it to "
            "leave the existing excerpt untouched; send null or an empty string to remove it."
        ),
    )
    content: PostContent | SkipJsonSchema[None] = Field(
        default=None,
        json_schema_extra=omit_null_default,
        description=(
            f"New Markdown body, 1 to {CONTENT_MAX_LENGTH} characters, carrying at least one "
            "non-whitespace character. Replaces the body in full - this member has no partial "
            "form - and is stored exactly as submitted. Omit it to leave the body unchanged. Null "
            "is not accepted."
        ),
    )
    """New body, or omitted to leave it unchanged. Optional but not nullable.

    ``posts.content`` is ``NOT NULL`` and :meth:`_reject_null_text` refuses an explicit null, so
    the published type carries no ``null`` branch and no ``default: null`` either.
    """
    cover_image_url: OptionalCoverImageUrl = Field(
        default=None,
        description=(
            "New absolute http(s) URL of the hero image. Omit it to leave the existing image "
            "untouched; send null or an empty string to remove it. Validated to a URL object "
            "rather than a string, so the service layer coerces it with `str(value)` before "
            "assigning it to the text column."
        ),
    )
    category_ids: CategoryIdList | SkipJsonSchema[None] = Field(
        default=None,
        json_schema_extra=omit_null_default,
        description=(
            "The post's complete category set after the update, at most "
            f"{MAX_CATEGORIES_PER_POST} identifiers. REPLACES the current associations rather than "
            "adding to them, so a category not named here is unfiled. Omit it to leave the "
            "categories exactly as they are; send an empty list to remove all of them. Null is "
            "not accepted."
        ),
    )
    """The complete category set after the update, or omitted to leave it alone.

    The one member here where the three states a caller might reach for are genuinely distinct,
    and the schema now states them exactly: **omitted** leaves the associations untouched, an
    **empty list** unfiles the post, and **null** is not a spelling of either - so it is absent
    from the published type rather than advertised and then refused.
    :meth:`_reject_null_category_ids` enforces the same at runtime, and ``[]`` remains valid,
    which is why the bound on :data:`CategoryIdList` is a maximum and not a minimum.
    """

    @field_validator("title", "content")
    @classmethod
    def _reject_null_text(cls, value: str | None, info: ValidationInfo) -> str | None:
        """Reject an explicitly submitted null for a column that cannot hold one.

        The guard depends on a property of Pydantic that is easy to miss and is load-bearing here:
        a field validator runs only for a value the caller actually supplied, never for a field
        that fell back to its default. So this method never sees the ``None`` that an omitted
        ``title`` or ``content`` leaves behind, and ``PostUpdate()`` still validates and still
        dumps to ``{}`` under ``exclude_unset=True``. It fires only when ``null`` was written in
        the request body on purpose.

        Without it, that ``null`` would survive ``model_dump(exclude_unset=True)`` as a real
        change, reach a ``NOT NULL`` column, and surface as an integrity error - a ``500``
        describing a database constraint, several layers from the request member that caused it,
        instead of a ``422`` naming the field.

        Declared once for both members rather than twice: they are refused for the identical
        reason, and the field the message names is read from the validation context so the two
        reports stay distinguishable.

        Args:
            value: The submitted value. ``None`` only if the caller sent an explicit null.
            info: Validation context, read for the name of the field being validated.

        Returns:
            ``value`` unchanged, once it is known not to be ``None``.

        Raises:
            ValueError: If ``value`` is ``None``. Pydantic renders it as a field-level entry in
                the ``422`` problem document, keyed to the field it came from.
        """
        if value is None:
            msg = (
                f"{info.field_name} may not be null; omit the field to leave the current value "
                "unchanged"
            )
            raise ValueError(msg)
        return value

    @field_validator("category_ids")
    @classmethod
    def _reject_null_category_ids(cls, value: list[uuid.UUID] | None) -> list[uuid.UUID] | None:
        """Reject an explicitly submitted ``null`` for the association set.

        Unlike the two text members above, this one is not refused because a column forbids null -
        there is no ``category_ids`` column at all, only rows in an association table. It is
        refused because null would be a third encoding of an instruction that already has two
        unambiguous ones: omission leaves the associations alone, and an empty list removes them.
        A third spelling could only be a client bug, and honouring it would force a reader of this
        contract to guess which of the other two it resembled.

        As above, an omitted field never reaches here, so ``PostUpdate()`` remains a valid no-op.

        Args:
            value: The submitted list. ``None`` only if the caller sent an explicit null.

        Returns:
            ``value`` unchanged, once it is known not to be ``None``.

        Raises:
            ValueError: If ``value`` is ``None``. Pydantic renders it as a field-level entry in
                the ``422`` problem document, keyed to ``category_ids``.
        """
        if value is None:
            msg = (
                "category_ids may not be null; omit the field to leave the categories unchanged, "
                "or send an empty list to remove all of them"
            )
            raise ValueError(msg)
        return value


class PostSummary(BaseModel):
    """A post as it appears in a list: everything a card renders, and **not** the body.

    The item type of every listing in the product, all four of which are windowed by the same
    envelope and served by the one composed statement in
    ``app.repositories.post_repository``::

        @router.get("/posts", response_model=Page[PostSummary])
        @router.get("/users/{username}/posts", response_model=Page[PostSummary])

    Eleven members: the card's own content, its byline, its badges, and the timestamps a feed
    orders and labels by.

    It carries no ``content``, and that is the point of the model
    -----------------------------------------------------------
    ``posts.content`` is unbounded ``TEXT`` holding an entire article, and this model is
    instantiated once per row of the most requested endpoint in the product. Publishing the body
    here would multiply the feed's payload by whatever the average article weighs - transferred,
    parsed, and then discarded by a card that renders a title, an excerpt and a byline. That single
    omission is the difference between a fast feed and a slow one, and it is why
    :class:`PostDetail` exists as a separate projection rather than this model serving both
    surfaces the way the retired ``Item`` served all four of its own.

    ``excerpt`` is what a card shows instead, which is why the excerpt is worth authoring: a post
    without one renders a heading and a byline with nothing between them.

    ``status`` **is** published here, and that is not a leak
    ------------------------------------------------------
    The author workspace groups an author's own posts by lifecycle state - drafts in one tab,
    published in another, archived in a third - and it reads them through the same listing
    endpoint the public feed uses, so the state has to travel on the item. Confidentiality comes
    from the query, not from the projection: the repository defaults to
    :attr:`~app.models.post.PostStatus.PUBLISHED` alone and only ``app.services.post_service``
    widens that, and only for a caller entitled to the wider set. An anonymous caller therefore
    never receives a row in any other state, so the member is uniformly ``PUBLISHED`` for them
    rather than absent - which is the more useful contract for a client that renders the same card
    component on both surfaces.

    Four members that are deliberately absent, so they are not helpfully added later
    ------------------------------------------------------------------------------
    ``like_count`` and ``comment_count``
        ``GET /api/v1/posts/{id}/likes`` and ``GET /api/v1/posts/{id}/comments`` own those numbers.
        Either one here would add a correlated aggregate per row to the single statement the feed
        already composes from relevance ranking, a category join, author filtering, status scoping,
        ordering and windowing - and it would do so on every listing, including the administrative
        table that renders neither number.
    ``reading_time``
        Derived on the client from the body it already has on the page that shows it. Computing it
        server-side would require the body in the projection that most carefully excludes it.
    ``search_vector``
        An internal generated column. It is a search index, not a member of any wire format.
    ``author_id``
        Redundant beside ``author``, whose ``id`` is the same value, and a second spelling of one
        fact is a second thing to keep in step.

    Validated from a mapped row rather than constructed by hand
    ----------------------------------------------------------
    ``from_attributes`` is enabled, so a service projects a loaded ``app.models.Post`` directly::

        items = [PostSummary.model_validate(post) for post in rows]

    That requires ``author`` and ``categories`` to have been eagerly loaded by the statement that
    fetched the rows, which ``app.repositories.post_repository`` does with ``selectinload`` on
    both. Under the asynchronous session this service uses, a lazy load raises ``MissingGreenlet``
    at the point of access instead of quietly emitting an extra query per row, so a missing
    eager-load option surfaces here as a failure rather than as an N+1 in production.
    """

    model_config = ConfigDict(
        # Projected from a mapped `app.models.Post`, so attribute access has to be a valid input.
        # A plain mapping still validates too, which is what lets a repository that selected
        # individual columns feed this model without materialising an entity.
        from_attributes=True,
        json_schema_extra={
            # The same post, author and category the other three models in this module use, so
            # /docs reads as one worked example - and the difference between this example and
            # PostDetail's is exactly the two members that separate the projections.
            #
            # `view_count` is 0 rather than a plausible-looking figure because 0 is what this API
            # actually returns for every post: nothing advances the counter. An example is a
            # promise about the response, so an invented 128 would be the one line of this
            # document that no response can match.
            "example": {
                "id": "7c9e6a2b-4d81-4f3a-9c5e-2b8d1f0a6e34",
                "title": "Scaling FastAPI",
                "slug": "scaling-fastapi",
                "excerpt": "What changes when a single process is no longer enough.",
                "cover_image_url": "https://example.com/covers/scaling-fastapi.png",
                "status": "PUBLISHED",
                "published_at": "2026-02-03T08:15:00Z",
                "view_count": 0,
                "created_at": "2026-02-01T17:42:00Z",
                "author": {
                    "id": "3f1a9c74-6b0e-4d52-9a3f-71c2e8b45d10",
                    "username": "example-reader",
                    "display_name": "Example Reader",
                    "bio": "Writes about Python, PostgreSQL and the parts that surprise me.",
                    "avatar_url": "https://example.com/avatars/example-reader.png",
                    "created_at": "2026-01-15T09:30:00Z",
                },
                "categories": [
                    {
                        "id": "0a1b7c5e-9c3a-4a1e-8b2d-6f5c4d3e2a19",
                        "name": "Python",
                        "slug": "python",
                    }
                ],
            }
        },
    )

    id: uuid.UUID = Field(
        ...,
        description=(
            "Server-generated identifier, stable for the lifetime of the post. Produced by "
            "PostgreSQL through `gen_random_uuid()` and never supplied by a client. It addresses "
            "every mutating route - update, delete, publish, unpublish, like, comment - while "
            "`slug` addresses the public read; use it as a collection key."
        ),
    )
    title: str = Field(
        ...,
        description=(
            "The post's headline, rendered as the card's heading, the page's `h1`, the browser "
            "tab's title and the social card's title."
        ),
    )
    slug: str = Field(
        ...,
        description=(
            "URL-safe identifier the canonical URL is built from: `GET /api/v1/posts/{slug}` "
            "resolves against it and the site's `/blog/{slug}` page is addressed by it. Assigned "
            "once at creation and never changed, so a published link stays valid even after a "
            "retitle. Compared case-insensitively by the database, so `/blog/Scaling-FastAPI` and "
            "`/blog/scaling-fastapi` resolve to this same post."
        ),
    )
    excerpt: str | None = Field(
        ...,
        description=(
            "Short summary, or null when the author wrote none. The key is always present, so a "
            "client never has to distinguish an absent member from a null one; only the value can "
            "be null, and a card renders the heading alone rather than an empty paragraph. This is "
            "the only prose in this projection - the body is deliberately absent, so a client that "
            "needs it fetches the post."
        ),
    )
    cover_image_url: str | None = Field(
        ...,
        description=(
            "Absolute URL of the post's hero image, or null when it has none. A string here rather "
            "than a validated URL type: the value was proved to be an absolute http(s) URL when it "
            "was submitted, so re-parsing it would cost a parse per card and would turn an old row "
            "that no longer parses into a failed read. Null is expected rather than exceptional - "
            "the client generates a default social card instead."
        ),
    )
    status: PostStatus = Field(
        ...,
        description=(
            "Lifecycle state: `DRAFT` while it has never been public, `PUBLISHED` while it is, "
            "`ARCHIVED` once it has been withdrawn without being deleted. An anonymous caller only "
            "ever receives `PUBLISHED` rows, because the listing query scopes the state before the "
            "projection is built; an author sees their own drafts and an administrator sees every "
            "state. Changed only by the publish and unpublish transitions, never by an update."
        ),
    )
    published_at: datetime | None = Field(
        ...,
        description=(
            "Instant the post became public, as a timezone-aware ISO 8601 value in UTC - for "
            "example `2026-02-03T08:15:00Z` - or null while it never has been. Non-null whenever "
            "`status` is `PUBLISHED`, guaranteed by a database constraint rather than by "
            "convention, and retained through `ARCHIVED` because an archived post was once "
            "published. The feed's default sort key, descending, and the value the sitemap reports "
            "as a last-modified instant."
        ),
    )
    view_count: int = Field(
        ...,
        # A counter that only ever advances from a zero server default cannot be negative, so the
        # bound costs nothing and documents the guarantee in /openapi.json. Safe here in a way the
        # same bound on `Page.page` would not be: the framework re-validates a handler's return
        # value against its response model, so a constraint a legitimate value can violate turns a
        # correct response into a 500 - and no legitimate value here can.
        ge=0,
        description=(
            "The post's readership counter, and at present `0` on every post: no endpoint in this "
            "API advances it, which is also why `sort` offers no `popular` value. Always present "
            "rather than omitted, and never null. The member is published so that counting reads "
            "later changes behaviour without changing this contract - so render it only where a "
            "zero is honest, not as a popularity signal."
        ),
    )
    created_at: datetime = Field(
        ...,
        description=(
            "Instant the post was created, from the database clock, as a timezone-aware ISO 8601 "
            "value in UTC. Distinct from `published_at`: a draft has a creation instant and no "
            "publication instant, which is what lets the author workspace order drafts sensibly. "
            "The modification instant is not published on this projection; see "
            "`PostDetail.updated_at`."
        ),
    )
    author: UserPublic = Field(
        ...,
        description=(
            "The account that wrote the post, as the public projection - identity, display name, "
            "biography, avatar and join instant. Never the private projection and never a raw "
            "user record, so a byline cannot disclose an email address, a role or whether the "
            "account is active. Its `username` is what a profile link is built from."
        ),
    )
    categories: list[CategorySummary] = Field(
        ...,
        description=(
            "The categories the post is filed under, as the slim badge projection - an identifier, "
            "a name to render and a slug to link to. Empty when the post is uncategorised, "
            "returned as an empty list rather than omitted. Deliberately without per-category post "
            "counts, which would be one aggregate per badge per row; the count belongs to the "
            "category listing that populates the filter control."
        ),
    )


class PostDetail(PostSummary):
    """One post in full: the card's members, plus the body and the modification instant.

    The declared ``response_model`` of the five routes that answer with a single post::

        @router.get("/posts/{slug}", response_model=PostDetail)
        @router.post("/posts", response_model=PostDetail)
        @router.patch("/posts/{id}", response_model=PostDetail)
        @router.post("/posts/{id}/publish", response_model=PostDetail)
        @router.post("/posts/{id}/unpublish", response_model=PostDetail)

    The create route answers ``201 Created``; the other four answer ``200 OK``. Which code each
    returns is declared on the route, not here - a schema describes a body, never a status.

    Returning the whole post from a mutation - and from both transitions - is deliberate: a client
    that has just published gets the new state, the freshly stamped publication instant and the
    updated modification instant in the same response, so it can render the result without a second
    request and without inferring what the server did.

    A **bare** representation, wrapped in nothing
    -------------------------------------------
    The body of a successful single-post response is this document and only this document. The
    retired service returned its created record inside a wrapper carrying a human sentence beside a
    payload member, returned its updated record inside another, and returned bare payloads from
    both of its reads - so a client could not tell from a route which of the two shapes it would
    get. That inconsistency is deleted rather than relocated: ``app.schemas.common`` permits a page
    envelope for a collection, a bare representation for a single read, and a problem document for
    a failure, and nothing else.

    Two members beyond :class:`PostSummary`, and one of them is the whole reason for the split
    ----------------------------------------------------------------------------------------
    ``content``
        The article. Present here because this is the projection fetched once, for the one post a
        reader opened, and absent from the listing projection because that one is fetched with
        twenty rows at a time.
    ``updated_at``
        Published here and not on the listing, because "when was this last edited" is a question a
        post's own page legitimately answers - it feeds the structured data a crawler reads - while
        a feed card has nowhere to render it and no reason to carry it.

    It inherits :class:`PostSummary` rather than restating eleven fields, so the two cannot drift:
    a description corrected on one is corrected on both, and a member the listing projection stops
    publishing disappears from here in the same edit instead of surviving unnoticed. Inherited
    fields keep their declaration order, so the serialised member order is the eleven above
    followed by ``content`` and ``updated_at``.
    """

    model_config = ConfigDict(
        # Restated rather than inherited. Pydantic would merge the parent's configuration, so this
        # is not strictly required - but a response model whose validation source is not obvious
        # from its own class body is a model someone will eventually break by editing the parent,
        # and it also keeps `json_schema_extra` below from replacing a setting that was only ever
        # visible one class away.
        from_attributes=True,
        json_schema_extra={
            # The parent's example, plus exactly the two members this projection adds - so the
            # difference between the two documents in /docs is the difference between the two
            # models, rather than two unrelated posts a reader has to diff. `view_count` is 0 for
            # the reason recorded on the parent's example: it is the value every response carries.
            "example": {
                "id": "7c9e6a2b-4d81-4f3a-9c5e-2b8d1f0a6e34",
                "title": "Scaling FastAPI",
                "slug": "scaling-fastapi",
                "excerpt": "What changes when a single process is no longer enough.",
                "cover_image_url": "https://example.com/covers/scaling-fastapi.png",
                "status": "PUBLISHED",
                "published_at": "2026-02-03T08:15:00Z",
                "view_count": 0,
                "created_at": "2026-02-01T17:42:00Z",
                "author": {
                    "id": "3f1a9c74-6b0e-4d52-9a3f-71c2e8b45d10",
                    "username": "example-reader",
                    "display_name": "Example Reader",
                    "bio": "Writes about Python, PostgreSQL and the parts that surprise me.",
                    "avatar_url": "https://example.com/avatars/example-reader.png",
                    "created_at": "2026-01-15T09:30:00Z",
                },
                "categories": [
                    {
                        "id": "0a1b7c5e-9c3a-4a1e-8b2d-6f5c4d3e2a19",
                        "name": "Python",
                        "slug": "python",
                    }
                ],
                "content": (
                    "## Why one process was never enough\n\n"
                    "A module-level list is not storage: it does not survive a restart."
                ),
                "updated_at": "2026-02-03T08:15:00Z",
            }
        },
    )

    content: str = Field(
        ...,
        description=(
            "The post body as Markdown, exactly as its author wrote it, after the write-side "
            "sanitiser removed anything unsafe. Rendered by the client, which sanitises again at "
            "the render boundary - two independent passes, because this is the one place in the "
            "product where prose written by one account is shown to every reader. Never empty: "
            "the column is `NOT NULL` and the input contract requires a non-whitespace character."
        ),
    )
    updated_at: datetime = Field(
        ...,
        description=(
            "Instant the post was last modified through the API, from the database clock, as a "
            "timezone-aware ISO 8601 value in UTC. Equal to `created_at` on a post that has never "
            "been edited, and refreshed by an update, a publish and an unpublish alike, because "
            "each of the three writes the row. Reported as the article's modification instant in "
            "the structured data on its page."
        ),
    )
