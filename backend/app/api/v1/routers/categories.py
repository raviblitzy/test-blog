"""The two public reads over the ``categories`` taxonomy: the filter control, and one term.

Two routes, both anonymous, both reads, and between them the whole of what a reader may ask of
the taxonomy:

``GET /api/v1/categories``
    A page of categories, each carrying how many PUBLISHED posts are filed under it. This is
    what the home page's filter renders as a row of chips reading ``Python (12)``. It answers
    with the same five-field page envelope every other collection in this API answers with - see
    the section below, which records why the bare array it used to return was wrong.
``GET /api/v1/categories/{slug}``
    One category, resolved by the slug in its URL, as a bare representation.

Neither path is written out here. This module constructs a bare ``APIRouter()`` and registers
each operation on a path *relative* to it, while ``app.api.v1.router`` supplies the other half -
``prefix="/categories"`` and ``tags=["categories"]`` on one ``include_router`` call - before
``app.main`` mounts that aggregate at ``/api/v1``. So the version prefix is written once for the
whole surface instead of once per module, no route can leave the version namespace by forgetting
it, and the tag cannot drift away from the section of the document it groups.

The collection's path is the empty string and not ``"/"``, which is a correctness detail rather
than a stylistic one. A ``"/"`` here composes to ``/api/v1/categories/``, and the canonical
unslashed path would then answer ``307`` with a ``Location`` header instead of a body - an extra
round trip on the endpoint every home-feed render calls, and a redirect a cross-origin caller
may decline to replay at all.

Why the collection answers with the page envelope
-------------------------------------------------
``app.schemas.common`` permits exactly three response shapes: the page envelope for a
collection, a bare representation for a single read, and a problem document for a failure. This
route answers with the first of those, like every other collection in the service, and it does
so through the same ``PageParams`` window and the same ``CategoryService.list_paginated`` call
the administrative category table uses.

It did not always. This collection previously returned a bare JSON array on the reasoning that a
curated taxonomy is bounded, that a windowed filter control would silently hide the posts filed
under a term that fell off the end, and that the home page wants the whole set in one request.
Every one of those observations is true and none of them justifies the shape, because uniformity
here is not a stylistic preference: the specification requires *every* list endpoint to return
``items``, ``total``, ``page``, ``page_size`` and ``pages``, and asserts that uniformity as an
acceptance criterion. One exception is enough to make the guarantee untrue, and an untrue
guarantee costs more than the convenience it buys - a client that may not assume the envelope has
to special-case a route, which is exactly the per-route guesswork the retired ``/items`` surface
was replaced to remove.

What the envelope actually costs here is nothing, because the concern it raised is answered on
the client rather than by weakening the contract. ``total`` and ``pages`` tell a caller whether
it has the whole taxonomy, which a bare array never did:
``frontend/src/lib/api/categories.ts`` exposes ``listAllCategories``, which walks the pages at
the maximum page size and hands the filter control a complete list. The control is therefore
complete *and* the collection contract holds - and a caller that only wants the first few terms
can now ask for them, which the array shape made impossible.

Both surfaces over the taxonomy now agree on the wire shape and differ only in what they admit:
this one is public and takes the window alone, while ``GET /api/v1/admin/categories`` is
administrator-only and additionally takes a search term. Neither is a special case.

What deliberately does not live here
------------------------------------
**No create, update or delete route.** The taxonomy's whole write lifecycle is administrative and
lives on the administrator-only namespace - ``POST /api/v1/admin/categories``,
``PATCH /api/v1/admin/categories/{id}`` and ``DELETE /api/v1/admin/categories/{id}`` in
``app.api.v1.routers.admin``, behind the ``require_admin`` gate that namespace applies at router
level. A mutating route added to *this* module would inherit no such gate, because this router is
included with no ``dependencies=`` at all: the result would be an unauthenticated write path into
the taxonomy every reader's filter is built from. That is a security defect rather than an
inconsistency, which is why ``CategoryCreate`` and ``CategoryUpdate`` are not imported here -
there is no shape in scope for a body this module must never accept.

**No slug derivation.** ``app.core.slug`` is reached only by ``CategoryService.create``. A slug is
written once, at creation, and never changes afterwards, because it is the canonical URL that the
SEO requirement rests on; deriving one on a read path would imply it could be recomputed.

**No in-use guard.** The rule that a category holding posts cannot be deleted out from under them
belongs to ``CategoryService.delete``, and there is no delete here to guard.

**No data access.** Neither handler composes a statement, touches the session beyond handing it
to a service, or reads a mapped attribute. The tally both routes publish is one ``LEFT OUTER
JOIN`` with a ``GROUP BY`` inside ``CategoryRepository``, reached only through ``CategoryService``
- so a category with no published posts still appears with a tally of ``0``, and a draft never
inflates a public count. Counting per category in a loop here would issue one statement per term
on the busiest read in the service; the aggregate is in the right layer, and this module's job is
to serialise its result.

**No case folding.** ``categories.slug`` is ``CITEXT``, so PostgreSQL compares case-insensitively
through the unique index and ``/api/v1/categories/Python`` resolves to the row stored as
``python``. The path parameter is therefore passed to the service exactly as received. Lowering it
here would duplicate a guarantee the column type already gives, and would silently diverge from it
if that collation ever changed.

Governing standards
-------------------
``review_rules`` reports that this project specifies **no user rules**, so none governs this file;
the self-imposed standards this repository holds itself to stand in their place, and five of them
decide the shape of this module. *Explicit API contracts*: both routes declare a
``response_model``, and every documented failure references the one problem document. *API
versioning*: the router is bare, so both operations reach the caller under ``/api/v1`` and cannot
be mounted anywhere else. *Layered separation of concerns*: each handler is one call deep into the
service layer and owns no query. *Server-owned identity*: no input here accepts an identifier, a
slug or a body of any kind - both routes are reads. *Blocking quality gates*: ``ruff check``,
``ruff format --check``, ``mypy`` and ``backend/tests/integration/test_categories_api.py`` all
have to pass on it.
"""

from typing import Final

from fastapi import APIRouter, status

from app.api.v1.responses import ProblemResponses, problem_response
from app.core.dependencies import DbSession, PageParamsDep
from app.core.pagination import Page
from app.schemas import CategoryPublic
from app.services import CategoryService

__all__ = ["router"]


# ---------------------------------------------------------------------------------------
# The router
#
# Bare, exactly as every domain module in this package is. No `prefix=`, because
# `app.api.v1.router` attaches `/categories` and `app.main` attaches `/api/v1`; no `tags=`,
# because the same `include_router` call attaches `categories`; and no `dependencies=`, because
# both routes are public. That last omission is the reason no mutating route may ever be added
# here - see "What deliberately does not live here" in the module docstring.
# ---------------------------------------------------------------------------------------

router = APIRouter()
"""The category router, included by ``app.api.v1.router`` under ``/categories``.

Reached as ``from app.api.v1.routers.categories import router``, never through the
``app.api.v1.routers`` package, which deliberately re-exports nothing."""


# ---------------------------------------------------------------------------------------
# Declared failure modes
#
# Every entry is built by `app.api.v1.responses.problem_response`, which names the model -
# without it the failure body is absent from the generated document and a generated client
# emits no type for it, which is the gap the "every route declares its shapes" standard closes
# - and which is the single place the published error media type is decided. So a caller parses
# one error shape, under one media type, across the whole API rather than one per route.
# ---------------------------------------------------------------------------------------

_SERVER_ERROR_RESPONSE: Final[ProblemResponses] = {
    status.HTTP_500_INTERNAL_SERVER_ERROR: problem_response(
        "An unexpected server-side failure. The body is the same problem document every "
        "other failure in this API returns, with a generic `detail` that reveals nothing "
        "about the cause - the cause is logged in full against the `request_id` the "
        "document and the `X-Request-ID` header both carry."
    )
}
"""The server-side backstop both routes share.

Spread into each route's own ``responses`` map rather than used alone, so the 500 entry has one
wording for the whole module and cannot drift into two descriptions of one behaviour."""

_VALIDATION_FAILED_RESPONSE: Final[ProblemResponses] = {
    status.HTTP_422_UNPROCESSABLE_CONTENT: problem_response(
        "The window was not usable: `page` below 1, or `page_size` outside 1-100. The "
        "problem document carries an `errors` list naming the offending parameter, and the "
        "bound is not silently clamped - a client asking for 500 rows is told so rather "
        "than being handed 100 and left to believe it received everything."
    ),
    **_SERVER_ERROR_RESPONSE,
}
"""The collection route's failures: the window it can reject, plus the shared backstop.

Declared because the route now takes ``page`` and ``page_size`` through
:data:`~app.core.dependencies.PageParamsDep`, and FastAPI would otherwise document its own
``HTTPValidationError`` shape for the 422 - a body this service never returns. It still requires
no credential, so neither ``401`` nor ``403`` is reachable, and it looks nothing up, so ``404``
is not a state it has: enumerating either would advertise a branch no client can take."""


_NOT_FOUND_RESPONSE: Final[ProblemResponses] = {
    status.HTTP_404_NOT_FOUND: problem_response(
        "No category carries that slug. Comparison is case-insensitive, so this is a "
        "genuine absence rather than a casing mismatch - `/categories/Python` and "
        "`/categories/python` resolve to the same row, and both answer 404 only if no such "
        "category exists. The document's `type` is `/errors/not-found`."
    ),
    # Declared even though no value of `slug` can currently reach it. FastAPI documents a 422 on
    # every operation that parses a parameter whether or not one is named here, and the entry it
    # generates unprompted points at its own validation-error shape - a body this service never
    # returns, because `register_exception_handlers` renders a request-validation failure as the
    # same problem document as every other failure. Naming the status replaces that generated
    # entry, which is what keeps the framework's shape out of the published components entirely.
    status.HTTP_422_UNPROCESSABLE_CONTENT: problem_response(
        "The request line did not satisfy the contract. `type` is "
        "`/errors/validation-error` and `errors` names the offending parameter. **No value of "
        "`slug` reaches this today**: the segment is opaque text to this tier, so an "
        "unrecognisable slug answers 404, which is the honest report that no category carries "
        "it. The entry documents the shape a parameter rejection would take, which is the same "
        "problem document every other failure in this API returns."
    ),
    **_SERVER_ERROR_RESPONSE,
}
"""The single-read route's failures: the two it can reach, the one it declares for accuracy, and
the server-side backstop every route shares.

Spread from :data:`_SERVER_ERROR_RESPONSE` rather than restated, so the 500 entry has one
wording for both routes and cannot drift into two descriptions of one behaviour. No ``422``: the
slug is opaque text, so there is no shape for the framework to reject."""


# ---------------------------------------------------------------------------------------
# GET /api/v1/categories - a page of the taxonomy
#
# `response_model` is `Page[CategoryPublic]`, which is the shape EVERY collection in this API
# returns. It used to be a bare `list[CategoryPublic]` on the argument that a curated taxonomy is
# bounded and that a filter control needs all of it at once; the module docstring records why that
# reasoning does not survive the specification's requirement that every list endpoint answer with
# `items`, `total`, `page`, `page_size` and `pages`, and how the filter control gets a complete
# list anyway - `listAllCategories` in `frontend/src/lib/api/categories.ts` walks the pages.
#
# The window arrives through `PageParamsDep`, so this route inherits the same parameter names,
# defaults, bounds and documentation as the feed and the administrative tables, and validates
# none of them itself.
# ---------------------------------------------------------------------------------------


@router.get(
    "",
    response_model=Page[CategoryPublic],
    status_code=status.HTTP_200_OK,
    responses=_VALIDATION_FAILED_RESPONSE,
    summary="List categories with post counts",
    description=(
        "Returns one page of categories, ascending by name, each carrying how many PUBLISHED "
        "posts are filed under it. This is the endpoint the home page's category filter is "
        "built from.\n\n"
        "**The response is the same page envelope every collection in this API returns** - "
        "`items`, `total`, `page`, `page_size`, `pages` - and accepts `page` and `page_size` "
        "like every other listing. A taxonomy is small, so the first page usually is the whole "
        "of it: `pages` is what says so, and a client that needs the complete set for a filter "
        "control asks for `page_size=100` and walks any further pages rather than assuming.\n\n"
        "A category with no published posts is included with a `post_count` of `0` - the filter "
        "control is expected to show an empty term rather than omit it. Drafts and archived "
        "posts are never counted, so each tally agrees exactly with the number of results "
        "`GET /api/v1/posts?category={slug}` returns to an anonymous caller.\n\n"
        "A page past the last one is not an error: it answers 200 with an empty `items` list "
        "beside the real `total` and `pages`. The searchable view over the same taxonomy is "
        "`GET /api/v1/admin/categories`, which is administrator-only and adds a `q` filter."
    ),
)
async def list_categories(db: DbSession, window: PageParamsDep) -> Page[CategoryPublic]:
    """Return one page of the taxonomy, each term with its published-post tally.

    One call deep. The tally arrives from a single aggregate inside ``CategoryRepository`` - a
    ``LEFT OUTER JOIN`` with a ``GROUP BY``, scoped to published posts - which is why this
    handler neither counts nor iterates: the outer join is what keeps a zero-post category in
    the result, and the status scope is what stops a draft inflating a public number. Counting
    here instead would issue one statement per category on the endpoint every home-feed render
    calls.

    Args:
        db: The request-scoped session, handed straight to the service. This handler issues
            nothing through it itself.
        window: The validated page window. ``page`` and ``page_size`` are already normalised and
            bounded by ``PageParams``, so no arithmetic and no clamping happens here; ``pages``,
            the response half of the same contract, is computed by ``build_page`` inside the
            service.

    Returns:
        The page envelope every collection in this API returns, carrying ``items``, ``total``,
        ``page``, ``page_size`` and ``pages``, with the categories on this page ascending by
        name. An empty ``items`` list when the taxonomy is empty, and likewise for a page past
        the last one - which is how a client detects it has run off the end.

    Note:
        ``q`` is deliberately **not** accepted here even though the service method behind this
        route takes one. Searching a taxonomy is a management affordance rather than a reading
        one, and it already has a home on the administrator-only
        ``GET /api/v1/admin/categories``; admitting it on a public route would put a text
        predicate on the busiest read in the service for no reader-facing benefit.
    """
    return await CategoryService(db).list_paginated(
        q=None, page=window.page, page_size=window.page_size
    )


# ---------------------------------------------------------------------------------------
# GET /api/v1/categories/{slug} - one term
#
# A bare representation, with no `{"message": ..., "data": ...}` wrapper. The contract being
# replaced wrapped its mutating results that way at `app.py:L18` and `app.py:L39` while its reads
# returned payloads unwrapped at `app.py:L23`, so a client had to know per route which of the two
# it was about to receive. One shape per kind of response - a representation for a single read, a
# problem document for a failure - is what removes that guesswork.
# ---------------------------------------------------------------------------------------


@router.get(
    "/{slug}",
    response_model=CategoryPublic,
    status_code=status.HTTP_200_OK,
    responses=_NOT_FOUND_RESPONSE,
    summary="Get one category by slug",
    description=(
        "Returns a single category resolved by the slug in its URL, with its published-post "
        "count attached, as a bare representation.\n\n"
        "The slug is matched case-insensitively by the database, so `python` and `Python` "
        "resolve to the same category and a link that varies only in case never breaks. An "
        "unknown slug answers `404` with a problem document."
    ),
)
async def get_category(slug: str, db: DbSession) -> CategoryPublic:
    """Resolve one category by its slug, or answer 404.

    ``slug`` is passed through **unchanged**. ``categories.slug`` is ``CITEXT``, so PostgreSQL
    performs the case-insensitive comparison through the column's unique index; lowering the
    value here would duplicate that guarantee, and would diverge from it the moment the
    collation changed. It would also cost the index nothing here but invites the same fold in
    SQL elsewhere, where it makes the predicate non-sargable.

    Absence is not inspected in this handler. The service raises
    :class:`~app.core.exceptions.NotFoundError` when no category carries the slug, and the
    handler ``app.main`` registers once renders that as the 404 problem document - carrying its
    ``type``, its ``instance`` path, its ``request_id`` and the ``X-Request-ID`` header. Testing
    for ``None`` and raising a framework error here instead is precisely the pattern being
    retired: the contract being replaced repeated one identical 404 raise at ``app.py:L31``,
    ``app.py:L40`` and ``app.py:L49``, so the error shape was declared three times and could
    have drifted three ways.

    The service is also what attaches the ``post_count`` this route's response model requires. A
    mapped category carries no such attribute - the tally is an aggregate rather than a column -
    so composing the two is a projection, and doing it in a handler would be data access in the
    wrong layer.

    Args:
        slug: The URL segment to resolve, in whatever case it arrived. Typed ``str`` because a
            slug is opaque text to this tier; its shape was settled when it was derived at
            creation.
        db: The request-scoped session, handed straight to the service.

    Returns:
        The category with its published-post tally attached, as a bare representation.

    Raises:
        NotFoundError: If no category carries that slug. Rendered as a 404 problem document by
            the registered handler, never by this function.
    """
    return await CategoryService(db).get_public_by_slug(slug)
