"""The page envelope every collection endpoint in this service returns.

This module is the SINGLE definition site of that envelope. ``Page`` is declared here and
nowhere else: ``app.schemas.common`` re-exports this class rather than declaring a second
model, and ``app.repositories.base`` assembles its windowed results through ``build_page``.
A second page model anywhere in the tree is a contract violation, because the entire value
of the shape is that one client control can page every list surface in the product.

The contract
------------
Five fields, in this order, on every collection response::

    {"items": [], "total": 0, "page": 1, "page_size": 20, "pages": 0}

Those names are the wire names, and they are load-bearing across the tier boundary:
``frontend/src/lib/types.ts`` mirrors them literally, ``frontend/src/hooks/use-pagination.ts``
and ``frontend/src/components/ui/pagination.tsx`` are written against them, and
``docs/api/rest-endpoints.md`` documents them. No alias, no alias generator and no
camel-case variant is configured here, and none may be added.

What the envelope replaces is worth stating, because the difference is the point. The
service this repository grew out of exposed a single collection route that handed back its
backing list unaltered::

    @app.get("/items")
    def get_items():
        return items

No total, no window, no declared response model - and a different response shape from the
mutating routes beside it, which wrapped their results in a ``message``/``data`` envelope.
Three surfaces page in the delivered product: the home feed, an author's profile posts and
the administrative tables. They page identically because they all return this one model.

The arithmetic
--------------
``pages`` is ``ceil(total / page_size)``, computed as ``(total + page_size - 1) //
page_size``. Integer division rather than ``math.ceil(total / page_size)`` is deliberate:
``total`` arrives straight from a ``COUNT(*)``, Python integers are unbounded, and float
division silently loses precision above 2**53. The integer form is exact at every
magnitude, and it needs no import.

Two consequences of that formula are contractual rather than incidental:

* An empty result set reports ``pages == 0``, not ``1``, because ``ceil(0 / n)`` is ``0``.
  A client rendering page controls should therefore render none for an empty collection.
* A ``page`` beyond the last one is not an error. ``build_page`` echoes back whatever
  ``page`` it was given, returns an empty ``items`` list and raises nothing, so a caller
  can tell it has run off the end rather than being silently redirected to a page it never
  asked for.

Layering
--------
``app.core`` is the bottom of the backend import graph, and this module is the bottom of
``app.core``: it imports ``pydantic`` and nothing else. Not ``app.core.config``, not a
sibling core module, not ``app.schemas``, not SQLAlchemy, not FastAPI. Importing it has no
side effect - no I/O, no logging, no environment read - which is what lets
``app.schemas.common`` re-export ``Page`` without dragging request-scoped machinery into
the schema layer.

``PageParams`` is deliberately NOT defined here. Normalising and bounding the ``page`` and
``page_size`` a client sends (``page >= 1``, ``1 <= page_size <= 100``) is request-scoped
work that needs FastAPI's ``Query``, so it belongs to ``app.core.dependencies``. Keeping
that dependency out of this module is what keeps this module importable from anywhere.
"""

from pydantic import BaseModel, ConfigDict, Field

__all__ = ["Page", "build_page"]


class Page[ItemT](BaseModel):
    """One window onto a larger collection, plus the counts needed to navigate it.

    The model is generic over its item type, so a route declares the concrete shape it
    returns - ``response_model=Page[PostSummary]`` - and FastAPI emits a distinct schema
    per parameterisation into the OpenAPI document. That is what lets every path declare a
    response schema instead of returning an undeclared shape.

    It deliberately carries no behaviour and no derived fields. ``has_next``, ``has_prev``,
    ``offset``, hypermedia links and cursors are all absent: every one of them is
    computable from the five values below, and a sixth field would be a sixth thing the
    frontend types, the endpoint reference and this class all have to agree about.
    """

    # Three configuration choices are deliberate omissions rather than oversights.
    #
    # `from_attributes` is NOT set. A Page wraps items that the per-item models in
    # `app.schemas` have already converted from their ORM rows; those models own the
    # conversion, and enabling it here would invite a caller to hand this envelope a
    # SQLAlchemy result and skip that step.
    #
    # No numeric constraints (`ge`, `le`) are attached to the integer fields. FastAPI
    # re-validates a handler's return value against its `response_model`, so a `ge=1` on
    # `page` would turn an out-of-range page - which the contract above requires to be
    # echoed back with an empty item list - into a 500 ResponseValidationError. The values
    # are produced by `build_page` from a bounded `PageParams` and a `COUNT(*)`, never
    # parsed from a request body, so there is no untrusted input here to constrain.
    #
    # No alias generator and no `populate_by_name`. The field names below ARE the wire
    # names, and the frontend contract types are written against them verbatim.
    model_config = ConfigDict(
        json_schema_extra={
            # An empty collection: internally consistent, independent of the item type,
            # and it documents the one result that surprises readers - `pages` is 0 here,
            # not 1, so an empty feed renders no page controls at all.
            "example": {
                "items": [],
                "total": 0,
                "page": 1,
                "page_size": 20,
                "pages": 0,
            }
        }
    )

    items: list[ItemT] = Field(
        ...,
        description=(
            "The rows on this page only, already projected into their response model. "
            "Empty when the collection is empty or when `page` is beyond `pages`."
        ),
    )
    total: int = Field(
        ...,
        description=(
            "How many rows match the request in total, ignoring the window. This is the "
            "unwindowed COUNT(*), not the length of `items`."
        ),
    )
    page: int = Field(
        ...,
        description=(
            "The 1-based page that was requested, echoed back verbatim and never clamped, "
            "so a caller can recognise a page beyond the end of the collection."
        ),
    )
    page_size: int = Field(
        ...,
        description=(
            "The window size that was applied. Requests are bound to 1..100 by "
            "PageParams; `items` may be shorter than this on the last page."
        ),
    )
    pages: int = Field(
        ...,
        description=(
            "How many pages `total` rows occupy at this `page_size`, as "
            "ceil(total / page_size). Zero when `total` is zero."
        ),
    )


def build_page[ItemT](
    items: list[ItemT],
    total: int,
    page: int,
    page_size: int,
) -> Page[ItemT]:
    """Assemble a :class:`Page` from one window of rows and the count of all of them.

    This is the only place the page arithmetic is performed. Services and repositories
    call it instead of computing ``pages`` inline, so every list surface in the API windows
    identically and a single unit test covers the arithmetic for all of them.

    Args:
        items: The rows belonging to this page, already projected into their response
            model. Passed through untouched: this function never re-slices, re-orders or
            truncates them, because the window was applied by the SQL that produced them.
        total: How many rows match the request in total, ignoring the window - the
            unwindowed ``COUNT(*)``. Deliberately NOT derived from ``len(items)``, which
            would collapse to the window size and silently corrupt ``pages``.
        page: The 1-based page that was requested. Echoed into the result verbatim.
        page_size: The window size that was applied. Must be positive.

    Returns:
        A :class:`Page` carrying ``items``, ``total`` and ``page`` as given, ``page_size``
        as given, and ``pages`` computed as ``ceil(total / page_size)``.

    Raises:
        ValueError: If ``page_size`` is zero or negative. That is the one genuinely
            invalid input, and it can only arrive from a defect in the service tier:
            request-supplied values are bounded to ``1..100`` by ``PageParams`` in
            ``app.core.dependencies`` long before they reach here. Raising beats dividing
            by zero, and beats quietly substituting a default that would make the
            resulting ``pages`` a fiction.

    Note:
        A ``page`` past the last one is NOT an error and never raises. The caller supplies
        an empty ``items`` list - the windowed query legitimately matched nothing - and the
        requested ``page`` is echoed back unchanged next to the real ``pages``, which is
        how a client detects that it has run off the end.

        The relationship between ``len(items)`` and ``page_size`` is likewise not checked.
        The last page is short by definition, and a caller that over-fetched has a bug in
        its query rather than in its envelope.

    Examples:
        The second window of a 41-row result set. ``pages`` rounds up, so the caller knows
        a third page exists even though this one is not the last::

            >>> page = build_page(["c", "d"], total=41, page=2, page_size=20)
            >>> page.pages
            3
            >>> page.model_dump()
            {'items': ['c', 'd'], 'total': 41, 'page': 2, 'page_size': 20, 'pages': 3}

        An exact multiple does not gain a trailing empty page, and an empty collection
        reports no pages at all::

            >>> build_page(["a"], total=40, page=1, page_size=20).pages
            2
            >>> build_page([], total=0, page=1, page_size=20).pages
            0

        A page beyond the end echoes what it was asked for and raises nothing::

            >>> beyond = build_page([], total=40, page=5, page_size=20)
            >>> (beyond.page, beyond.pages, beyond.items)
            (5, 2, [])
    """
    if page_size <= 0:
        msg = (
            f"page_size must be a positive integer to window a result set, got {page_size!r}. "
            "Bound client-supplied values with app.core.dependencies.PageParams before "
            "calling build_page."
        )
        raise ValueError(msg)

    # ceil(total / page_size) in exact integer arithmetic. `total` comes from a COUNT(*)
    # and Python integers are unbounded, so float division would be the only thing here
    # capable of returning a wrong answer - it loses precision above 2**53.
    pages = (total + page_size - 1) // page_size

    # Constructed unparameterised on purpose. `ItemT` is a live TypeVar object at runtime,
    # so `Page[ItemT](...)` would build and cache a distinct concrete model class named
    # `Page[TypeVar]` on every generic instantiation - with an identical schema and a
    # misleading repr. The bare `Page(...)` call yields a plain `Page`, while mypy's
    # pydantic plugin still infers the precise `Page[ItemT]` this signature promises.
    return Page(items=items, total=total, page=page, page_size=page_size, pages=pages)
