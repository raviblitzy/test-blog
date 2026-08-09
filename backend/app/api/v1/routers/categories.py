"""The two public reads over the ``categories`` taxonomy: the filter control, and one term.

Two routes, both anonymous, both reads, and between them the whole of what a reader may ask of
the taxonomy:

``GET /api/v1/categories``
    Every category, each carrying how many PUBLISHED posts are filed under it. This is what the
    home page's filter renders as a row of chips reading ``Python (12)``, and it is the one
    collection in this API that is deliberately **not** windowed. The section below exists so
    that the shape survives the reader who notices the asymmetry and reaches for consistency.
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

Why the collection answers with a bare array
--------------------------------------------
Every other collection in this service answers with the page envelope, and ``app.schemas.common``
permits exactly three response shapes: that envelope for a collection, a bare representation for
a single read, and a problem document for a failure. This one route is the single sanctioned
exception to the first of those, and it is an exception by specification rather than by
oversight. Four reasons, and they compound:

**The taxonomy is bounded by editorial effort, not by user input.** Categories are curated by an
administrator through ``POST /api/v1/admin/categories``; nothing a reader does grows the table.
There is no growth curve here for windowing to defend against, which is the usual justification
for an envelope in the first place.

**A windowed filter is a broken filter.** This route feeds the control a reader narrows the feed
with. Offering only the first page of terms would silently hide every post filed exclusively
under a term that fell off the end - the control would look complete and be wrong, which is a
worse failure than being visibly incomplete.

**One request, not two.** The home page needs the whole set before it can render the control, so
an envelope would either be walked page by page on every render or fetched once with a page size
chosen to exceed the taxonomy: a pagination contract observed in the letter and abandoned in the
spirit.

**The service is un-paginated by contract.** ``CategoryService.list_with_post_counts`` declares
``list[CategoryPublic]``, and its own documentation records the decision and names
``CategoryService.list_paginated`` as the surface that windows. That windowed surface is not
unused - the administrative category table reaches it through ``AdminService`` - so the envelope
*is* served for categories, at ``GET /api/v1/admin/categories``, where a search box and a
management grid make windowing meaningful. Two surfaces over one taxonomy, each carrying the
shape its consumer needs, rather than one shape imposed on both.

The consequence for anyone editing this file: the collection returns a JSON array at the top
level, and ``frontend/src/components/blog/category-filter.tsx`` consumes it as one. Wrapping it
in an envelope would break that component at runtime while type-checking cleanly on both sides,
because the change would be to the wire shape rather than to either signature.

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

from typing import Any, Final

from fastapi import APIRouter, status

from app.core.dependencies import DbSession
from app.schemas import CategoryPublic, ProblemDetail
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
# `model` is the load-bearing key in each entry below: without it the failure body is absent
# from the generated document and a generated client emits no type for it, which is the gap the
# "every route declares its shapes" standard closes. Every entry names `ProblemDetail`, so a
# caller parses one error shape across the whole API rather than one per route.
# ---------------------------------------------------------------------------------------

_SERVER_ERROR_RESPONSE: Final[dict[int | str, dict[str, Any]]] = {
    status.HTTP_500_INTERNAL_SERVER_ERROR: {
        "model": ProblemDetail,
        "description": (
            "An unexpected server-side failure. The body is the same problem document every "
            "other failure in this API returns, with a generic `detail` that reveals nothing "
            "about the cause - the cause is logged in full against the `request_id` the "
            "document and the `X-Request-ID` header both carry."
        ),
    }
}
"""The only failure the collection route can produce, and the reason its ``responses`` is this
short.

That route takes no path parameter, no query parameter and no body, so there is nothing to
reject with a ``422``; it requires no credential, so neither ``401`` nor ``403`` is reachable;
and it looks nothing up, so a ``404`` is not a state it has. Declaring statuses it cannot return
would describe a contract the route does not have, which is a worse documentation defect than
declaring too few."""

_NOT_FOUND_RESPONSE: Final[dict[int | str, dict[str, Any]]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ProblemDetail,
        "description": (
            "No category carries that slug. Comparison is case-insensitive, so this is a "
            "genuine absence rather than a casing mismatch - `/categories/Python` and "
            "`/categories/python` resolve to the same row, and both answer 404 only if no such "
            "category exists. The document's `type` is `/errors/not-found`."
        ),
    },
    **_SERVER_ERROR_RESPONSE,
}
"""The single-read route's failures: the domain one it can genuinely reach, plus the server-side
backstop every route shares.

Spread from :data:`_SERVER_ERROR_RESPONSE` rather than restated, so the 500 entry has one
wording for both routes and cannot drift into two descriptions of one behaviour."""


# ---------------------------------------------------------------------------------------
# GET /api/v1/categories - the whole taxonomy
#
# READ THIS BEFORE "FIXING" THE RETURN TYPE. `response_model` is a bare `list[CategoryPublic]`,
# not the page envelope every other collection in this API returns. That asymmetry is the
# specified contract for this one route, not an oversight: the taxonomy is curated and bounded,
# the home page's filter control needs all of it in one request, and a filter that offers only
# some of the terms silently hides posts. The four-part rationale is in the module docstring
# under "Why the collection answers with a bare array"; the windowed surface over the same
# taxonomy already exists at GET /api/v1/admin/categories. Normalising this route to an envelope
# would break `frontend/src/components/blog/category-filter.tsx` at runtime while type-checking
# cleanly on both sides, because the break is to the wire shape rather than to any signature.
# ---------------------------------------------------------------------------------------


@router.get(
    "",
    response_model=list[CategoryPublic],
    status_code=status.HTTP_200_OK,
    responses=_SERVER_ERROR_RESPONSE,
    summary="List all categories with post counts",
    description=(
        "Returns every category, ascending by name, each carrying how many PUBLISHED posts are "
        "filed under it. This is the endpoint the home page's category filter is built from.\n\n"
        "**This collection is not paginated, and returns a JSON array at the top level rather "
        "than a page envelope.** It is the only collection in this API that does. The taxonomy "
        "is administrator-curated and bounded, and a filter control that offered only some of "
        "the terms would silently hide the posts filed under the rest, so the whole set is "
        "returned in one request. The paginated, searchable view over the same taxonomy is "
        "`GET /api/v1/admin/categories`.\n\n"
        "A category with no published posts is included with a `post_count` of `0` - the filter "
        "control is expected to show an empty term rather than omit it. Drafts and archived "
        "posts are never counted, so each tally agrees exactly with the number of results "
        "`GET /api/v1/posts?category={slug}` returns to an anonymous caller."
    ),
)
async def list_categories(db: DbSession) -> list[CategoryPublic]:
    """Return the whole taxonomy, each term with its published-post tally.

    One call deep, and one statement wide. The tally arrives from a single aggregate inside
    ``CategoryRepository`` - a ``LEFT OUTER JOIN`` with a ``GROUP BY``, scoped to published posts
    - which is why this handler neither counts nor iterates: the outer join is what keeps a
    zero-post category in the result, and the status scope is what stops a draft inflating a
    public number. Counting here instead would issue one statement per category on the endpoint
    every home-feed render calls.

    Takes no query parameter, and in particular not
    :data:`~app.core.dependencies.PageParamsDep`. Accepting ``page`` and ``page_size`` would
    advertise a window this contract does not have, and answering a request for page two with an
    empty array would be a plausible-looking lie about the taxonomy's extent.

    Args:
        db: The request-scoped session, handed straight to the service. This handler issues
            nothing through it itself.

    Returns:
        Every category ascending by name, each carrying its published-post tally; an empty list
        when no category has been created yet. Serialised as a JSON array at the top level - not
        an object with an ``items`` key.
    """
    return await CategoryService(db).list_with_post_counts()


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
