"""The two public reads over the ``categories`` taxonomy: the filter control, and one term.

Two routes, both anonymous, both reads, and between them the whole of what a reader may ask of
the taxonomy:

``GET /api/v1/categories``
    Every category, each carrying how many PUBLISHED posts are filed under it. This is what the
    home page's filter renders as a row of chips reading ``Python (12)``. It answers with a bare
    JSON array and takes no window - the one collection in this API that does, for the reason the
    section below records.
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

Why the collection answers with a bare array - READ THIS TWICE
-------------------------------------------------------------
``GET /api/v1/categories`` declares ``response_model=list[CategoryPublic]``. It is the **only**
endpoint in this API that does not answer with the five-field page envelope, that exception is
specified rather than improvised, and it is exactly one route wide. Do not normalise it.

The list *is* the home page's filter control. A window would offer some terms and silently omit
the rest, and every post filed exclusively under an omitted term would become unreachable through
the filter - a wrong answer rather than a partial one, and one no status code reports. The
taxonomy is also bounded by editorial effort rather than by reader input, so there is nothing here
for a window to protect against: the whole set is a row of chips, and one request is what renders
it. ``Page`` is therefore not imported by this module at all, no ``page`` or ``page_size``
parameter is accepted, and ``PageParamsDep`` is deliberately absent from both handlers.

A client is still entitled to assume the envelope everywhere else, because everywhere else has a
collection whose size a reader can influence. This one does not: the taxonomy is curated, bounded by
editorial effort, and read whole by the control it exists for. It is also this relation's *only*
read - the AAP's administrative surface (§0.6.2) declares create, rename and delete for a category
and no privileged listing - so the administrative screen consumes this same array and there is no
second shape over the taxonomy for the two screens to disagree about. No client ever needs to walk
pages to obtain a complete taxonomy: ``listCategories`` in
``frontend/src/lib/api/categories.ts`` returns ``CategoryPublic[]`` in one round trip.

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
``response_model`` - the collection a bare ``list[CategoryPublic]``, which is the one envelope
exception that standard itself grants and specifies - and every documented failure references the
one problem document. *API
versioning*: the router is bare, so both operations reach the caller under ``/api/v1`` and cannot
be mounted anywhere else. *Layered separation of concerns*: each handler is one call deep into the
service layer and owns no query. *Server-owned identity*: no input here accepts an identifier, a
slug or a body of any kind - both routes are reads. *Blocking quality gates*: ``ruff check``,
``ruff format --check``, ``mypy`` and ``backend/tests/integration/test_categories_api.py`` all
have to pass on it.
"""

from typing import Annotated, Final

from fastapi import APIRouter, status

from app.core.dependencies import DbSession
from app.schemas import CategoryPublic, ProblemResponses, problem_response
from app.schemas.common import StorableText
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
# Every entry is built by `app.schemas.common.problem_response`, which names the model -
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

_COLLECTION_RESPONSES: Final[ProblemResponses] = _SERVER_ERROR_RESPONSE
"""The collection route's only declared failure: the shared server-side backstop.

Minimal by construction, because the route has no other reachable failure to declare. It parses
**no** parameter - there is no window here, so no ``422`` for one to fail - it requires no
credential, so neither ``401`` nor ``403`` is reachable, and it looks nothing up, so ``404`` is
not a state it has. Enumerating any of those would advertise a branch no client can take."""


_NOT_FOUND_RESPONSE: Final[ProblemResponses] = {
    status.HTTP_404_NOT_FOUND: problem_response(
        "No category carries that slug. Comparison is case-insensitive, so this is a "
        "genuine absence rather than a casing mismatch - `/categories/Python` and "
        "`/categories/python` resolve to the same row, and both answer 404 only if no such "
        "category exists. The document's `type` is `/errors/not-found`."
    ),
    # Declared for the one value of `slug` that reaches it - a NUL character, refused by
    # `StorableText` - and for accuracy on every other. FastAPI documents a 422 on
    # every operation that parses a parameter whether or not one is named here, and the entry it
    # generates unprompted points at its own validation-error shape - a body this service never
    # returns, because `register_exception_handlers` renders a request-validation failure as the
    # same problem document as every other failure. Naming the status replaces that generated
    # entry, which is what keeps the framework's shape out of the published components entirely.
    status.HTTP_422_UNPROCESSABLE_CONTENT: problem_response(
        "The request line did not satisfy the contract. `type` is "
        "`/errors/validation-error` and `errors` names the offending parameter. **One value of "
        "`slug` reaches this**: a segment containing a NUL character, which `CITEXT` cannot "
        "represent and so cannot be compared against a stored slug. Every other segment is "
        "opaque text to this tier, so an unrecognisable slug answers 404, which is the honest "
        "report that no category carries it."
    ),
    **_SERVER_ERROR_RESPONSE,
}
"""The single-read route's failures: the two it can reach, the one it declares for accuracy, and
the server-side backstop every route shares.

Spread from :data:`_SERVER_ERROR_RESPONSE` rather than restated, so the 500 entry has one
wording for both routes and cannot drift into two descriptions of one behaviour. The ``422`` is
declared rather than assumed away: the slug is opaque text apart from one rule - it may not carry
a character the column cannot store."""


# ---------------------------------------------------------------------------------------
# GET /api/v1/categories - the whole taxonomy
#
# `response_model` is a BARE `list[CategoryPublic]`, never the page envelope, and that is the
# one sanctioned exception to that envelope in this entire API. Do not normalise it: the list
# is the home page's filter control, so a window would omit terms and make every post filed
# exclusively under an omitted term unreachable through the filter - a wrong answer that no status
# code reports. The module docstring records the reasoning in full, and `Page` is deliberately not
# imported here at all so the shape cannot creep back in.
#
# No `PageParamsDep`, and no `page`/`page_size` query parameter. There is no windowed view over
# this relation anywhere in the API, administrative or otherwise - a bounded taxonomy needs none.
# ---------------------------------------------------------------------------------------


@router.get(
    "",
    response_model=list[CategoryPublic],
    status_code=status.HTTP_200_OK,
    responses=_COLLECTION_RESPONSES,
    summary="List categories with post counts",
    description=(
        "Returns **every** category, ascending by name, each carrying how many PUBLISHED posts "
        "are filed under it. This is the endpoint the home page's category filter is built "
        "from.\n\n"
        "**The response is a bare JSON array, not the page envelope**, and this is the only "
        "collection in this API that answers that way. The exception is deliberate: the array "
        "*is* the filter control, and a windowed control would hide the posts filed under any "
        "term that fell outside the window. The taxonomy is curated and bounded, so the whole "
        "set is one small response and takes no `page` or `page_size` parameter.\n\n"
        "A category with no published posts is included with a `post_count` of `0` - the filter "
        "control is expected to show an empty term rather than omit it. Drafts and archived "
        "posts are never counted, so each tally agrees exactly with the number of results "
        "`GET /api/v1/posts?category={slug}` returns to an anonymous caller.\n\n"
        "An empty taxonomy answers 200 with an empty array. This is the only read over the "
        "taxonomy: the administrative categories screen renders this same array, and the "
        "administrator-only namespace carries the three category mutations and no listing."
    ),
)
async def list_categories(db: DbSession) -> list[CategoryPublic]:
    """Return the whole taxonomy, each term with its published-post tally.

    One call deep. The tally arrives from a single aggregate inside ``CategoryRepository`` - a
    ``LEFT OUTER JOIN`` with a ``GROUP BY``, scoped to published posts - which is why this
    handler neither counts nor iterates: the outer join is what keeps a zero-post category in
    the result, and the status scope is what stops a draft inflating a public number. Counting
    here instead would issue one statement per category on the endpoint every home-feed render
    calls.

    Args:
        db: The request-scoped session, handed straight to the service. This handler issues
            nothing through it itself.

    Returns:
        Every category ascending by name, each carrying ``post_count``, as a bare JSON array -
        **not** the page envelope. An empty array when no category has been created.

    Note:
        Neither a window nor a ``q`` is accepted here, and the two omissions have the same cause:
        this route serves a control that needs the complete set. Admitting either would put a
        parameter on the busiest read in the service for no reader-facing benefit, and admitting
        the window would make the control able to hide posts. A management screen that wants to
        narrow the list filters this one small array client-side rather than asking the service
        for a second, windowed read of a bounded relation.
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
async def get_category(slug: Annotated[str, StorableText], db: DbSession) -> CategoryPublic:
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
        slug: The URL segment to resolve, in whatever case it arrived. Opaque text to this
            tier apart from :data:`~app.schemas.common.StorableText`, which refuses a NUL
            character before the service is reached because ``CITEXT`` cannot represent one;
            everything else about its shape was settled when it was derived at creation.
        db: The request-scoped session, handed straight to the service.

    Returns:
        The category with its published-post tally attached, as a bare representation.

    Raises:
        NotFoundError: If no category carries that slug. Rendered as a 404 problem document by
            the registered handler, never by this function.
    """
    return await CategoryService(db).get_public_by_slug(slug)
