"""Envelope arithmetic and window bounds: ``app.core.pagination`` and ``PageParams``.

Two halves of one contract are under test here, and they live in different modules on
purpose. The **response** half is :class:`app.core.pagination.Page` and
:func:`app.core.pagination.build_page` - the five-field envelope every collection endpoint
returns, and the single site where ``pages`` is computed. The **request** half is
:class:`app.core.dependencies.PageParams` - the ``page``/``page_size`` window a client asks
for, and the ``offset``/``limit`` a repository derives from it. They are tested together
because neither is meaningful alone: the window decides which rows are fetched, the envelope
reports how many windows exist, and a disagreement between them is a feed that skips a row at
a page boundary or a page control that offers a page the service will not serve.

Pure and database-free
----------------------
Every test in this module is a plain synchronous function over constructed objects. Nothing
here opens a connection, awaits a coroutine, starts an event loop, issues an HTTP request or
asks for a fixture from ``backend/tests/conftest.py`` - not ``db_session``, not ``client``,
not ``engine``, not an identity fixture. There is no ``factories`` import, because every
helper there needs an ``AsyncSession``.

The module still depends on that conftest for one thing, and the reason is worth stating so a
future reader does not try to remove it. Importing :mod:`app.core.dependencies` reaches
``app.db.session`` and ``app.models.user`` transitively, so it constructs the async engine
object and attaches the SQLAlchemy model tree. ``create_async_engine`` does not connect when
it is constructed - which is exactly why this module stays database-free - but building it
does require a syntactically valid ``DATABASE_URL``, and ``app.core.config`` validates its
settings singleton at import time. The conftest's module-level bootstrap populates the
environment before any ``app`` import, so no environment setup belongs here.

That import weight is also why these tests are cheap where the equivalents are expensive.
Every arithmetic boundary below - an empty collection, an exact multiple, a partial final
page, a page past the end, a window at its ceiling - would otherwise need a seeded database
and an HTTP round trip per case to reach.

No user rules govern this file
-----------------------------
``review_rules`` returns ``No user rules provided.`` - a complete response, not a truncated
window - so **no user-specified rule governs this file, and no rule placed it in scope**. It
is in scope solely through the Agent Action Plan's file inventory (§0.4.4.5, "envelope
arithmetic and bounds") and its execution plan (§0.7.1.11, Group 11), discharging the
implicit prerequisite §0.1.3 names: "a uniform pagination contract". Nothing below is
invented to fill the gap left by the absent rules, and their absence is not treated as
licence to lower the bar. The substitute standard is the AAP's own §0.10.1 enterprise
standards, three of which this file discharges directly.

* **§0.10.1 #4, explicit API contracts** - "one page envelope for collections". This module
  is the guard on that clause. The field set is asserted by **equality** rather than
  containment, so a renamed field, an added sixth field or a serialisation alias fails here
  rather than reaching the frontend, which is written against these five names literally.
  It is the check that keeps the delivered API from drifting back towards the shape it
  replaced, where mutating routes wrapped results in a ``message``/``data`` envelope while
  reads returned a bare payload.
* **§0.10.1 #8, blocking quality gates** - the arithmetic is covered branch by branch,
  including the two error paths (a non-positive ``page_size``, an out-of-range window), so
  the gate does not depend on an integration test happening to exercise them.
* **§0.10.1 #2, pinned, reproducible dependencies** - the imports below are ``pytest``,
  ``pydantic`` and the two modules under test, plus ``math`` and ``typing`` from the standard
  library. No property-testing library is used; the swept ranges and oracles are hand-rolled,
  because ``backend/requirements-dev.txt`` pins seven development packages and
  ``hypothesis`` is not one of them.

Where the assertions come from
------------------------------
The five field names are not a matter of taste, which is why they are asserted so tightly.
``app.schemas.common`` re-exports ``Page`` rather than declaring a second model;
``frontend/src/lib/types.ts`` mirrors the names literally, along with a Zod schema that parses
them; ``frontend/src/hooks/use-pagination.ts`` and
``frontend/src/components/ui/pagination.tsx`` are written against them; and
``docs/api/rest-endpoints.md`` documents them. Three list surfaces - the home feed, an
author's profile listing and each administrative table - share one page control precisely
because they all return this one model.

Two behaviours look like defects until the reason is stated, so both are pinned deliberately
rather than left to be rediscovered:

* An empty collection reports ``pages == 0``, not ``1``. ``ceil(0 / n)`` is ``0``, and a
  client renders no page control at all in that case.
* A ``page`` past the last one is **not** an error. The requested page is echoed back beside
  the real page count with an empty ``items`` list, so a caller can tell it has run off the
  end instead of being silently handed a page it never asked for. AAP §0.9.4.4 requires that
  end to end; this module is where it is cheapest to pin down.
"""

from __future__ import annotations

import math
from typing import Any, Final, get_args, get_type_hints

import pytest
from pydantic import BaseModel, TypeAdapter, ValidationError

from app.core.dependencies import (
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
    MIN_PAGE,
    MIN_PAGE_SIZE,
    PageParams,
)
from app.core.pagination import Page, build_page

# Every test here is fast, isolated, and touches neither the database nor the network, which
# is the marker `backend/pyproject.toml` registers for exactly this. Registered rather than
# ad-hoc, so the suite's `--strict-markers` accepts it, and applied at module scope so
# `-m unit` selects the whole file.
pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------------------
# The envelope's declared shape
# ---------------------------------------------------------------------------------------

#: The five field names, in the order `Page` declares them. Declaration order is the order
#: they serialise in, and it is the order `docs/api/rest-endpoints.md` documents, so it is
#: asserted as well as the set - a reordering is harmless to a JSON parser but makes the
#: reference and the response disagree for anyone reading both.
_ENVELOPE_FIELD_ORDER: Final[tuple[str, ...]] = (
    "items",
    "total",
    "page",
    "page_size",
    "pages",
)

#: The four fields that carry counts. Asserted to be `int` on a built instance, because a
#: float here would serialise as `1.0` and break a client that indexes pages by value.
_COUNT_FIELDS: Final[tuple[str, ...]] = ("total", "page", "page_size", "pages")


# ---------------------------------------------------------------------------------------
# Arithmetic cases
#
# One table, read as (total, page_size, expected_pages), so each boundary reports as its own
# named test rather than as one assertion among many inside a loop. The commented rows are
# the ones that would be wrong under a plausible mis-implementation.
# ---------------------------------------------------------------------------------------

_PAGE_COUNT_CASES: Final[tuple[tuple[int, int, int], ...]] = (
    # An empty collection occupies no pages. `ceil(0 / n) == 0`, not 1: there is no empty
    # first page to render a control for.
    (0, 10, 0),
    (0, 1, 0),
    (0, MAX_PAGE_SIZE, 0),
    # A single partial page. Anything from one row up to a full window is one page.
    (1, 10, 1),
    (9, 10, 1),
    # The exact-multiple boundary, and the classic off-by-one: 10 rows at 10 per page is ONE
    # page, not two, and 20 rows is TWO, not three. A `total // page_size + 1` implementation
    # passes every other row in this table and fails these.
    (10, 10, 1),
    (20, 10, 2),
    (100, 10, 10),
    # One row past an exact multiple needs a further page for that row alone.
    (11, 10, 2),
    (21, 10, 3),
    (101, 100, 2),
    # A window of one: every row is its own page, so `pages` tracks `total` exactly.
    (1, 1, 1),
    (7, 1, 7),
    # Realistic windows at the declared bounds and the declared default.
    (41, 20, 3),
    (99, MAX_PAGE_SIZE, 1),
    (100, MAX_PAGE_SIZE, 1),
    (1000, DEFAULT_PAGE_SIZE, 50),
    (1001, DEFAULT_PAGE_SIZE, 51),
)

#: Totals large enough that IEEE 754 double division cannot represent the quotient exactly.
#: Read as (total, page_size, expected_pages). `pages` comes straight from a `COUNT(*)` and
#: Python integers are unbounded, so float division is the only step capable of returning a
#: wrong answer here - it loses precision above 2**53.
_LARGE_MAGNITUDE_CASES: Final[tuple[tuple[int, int, int], ...]] = (
    (2**53 + 1, 1, 2**53 + 1),
    (10**15 + 1, 10, 10**14 + 1),
    (10**18 + 1, 10, 10**17 + 1),
    (2**60 + 1, 1, 2**60 + 1),
    (3 * 10**16 + 1, 3, 10**16 + 1),
)

#: The subset of the above on which `math.ceil(total / page_size)` is measurably WRONG. Each
#: row was confirmed to diverge rather than assumed to: the float form under-counts by one,
#: dropping a page and with it the last row of the result set. Asserting the divergence - not
#: merely that the implementation is right - is what proves the implementation is not using
#: the float form, so a future edit to `build_page` that reaches for `math.ceil` fails here.
_FLOAT_DIVERGENCE_CASES: Final[tuple[tuple[int, int, int], ...]] = (
    (2**53 + 1, 1, 2**53 + 1),
    (10**18 + 1, 10, 10**17 + 1),
    (2**60 + 1, 1, 2**60 + 1),
    (3 * 10**16 + 1, 3, 10**16 + 1),
)


# ---------------------------------------------------------------------------------------
# Window cases
#
# Read as (page, page_size, expected_offset). Every row sits inside the bounds `PageParams`
# declares, because a value outside them is rejected at the request edge and can never reach
# the offset arithmetic - which is asserted directly in TestPageWindowBounds.
# ---------------------------------------------------------------------------------------

_WINDOW_CASES: Final[tuple[tuple[int, int, int], ...]] = (
    # The first page skips nothing, whatever the window size.
    (MIN_PAGE, 10, 0),
    (MIN_PAGE, MIN_PAGE_SIZE, 0),
    (MIN_PAGE, DEFAULT_PAGE_SIZE, 0),
    (MIN_PAGE, MAX_PAGE_SIZE, 0),
    # Each subsequent page skips exactly one further window.
    (2, 10, 10),
    (3, 10, 20),
    (2, DEFAULT_PAGE_SIZE, 20),
    (5, 25, 100),
    (7, MIN_PAGE_SIZE, 6),
    (4, MAX_PAGE_SIZE, 300),
    # `page` carries no upper bound, so a deep page is a legitimate request. Its offset is
    # simply large, and the query it produces matches nothing.
    (1000, MAX_PAGE_SIZE, 99900),
)


class _Row(BaseModel):
    """A minimal item model, here only to prove the generic parameter is honoured.

    Two fields, one of each scalar kind that appears in the real projections, and no
    behaviour. It exists so a test can assert that ``Page`` nests an item model's own
    serialisation rather than flattening it or leaving model instances in the output - which
    is the property every ``response_model=Page[...]`` in the API relies on.
    """

    slug: str
    views: int


def _window_annotation(field: str) -> Any:
    """Return the annotation ``PageParams`` declares for *field*, metadata intact.

    ``PageParams`` is a frozen dataclass whose bounds are declared as ``fastapi.Query``
    metadata inside ``Annotated``, and FastAPI reads them off the annotation to validate the
    query string before a route is entered. Resolving the hint with ``include_extras=True``
    is what keeps that metadata attached, so a test can assert both the bound values and
    that they are actually enforced.

    Args:
        field: Either ``"page"`` or ``"page_size"``.

    Returns:
        The ``Annotated[int, Query(...)]`` alias as declared, ready to hand to a
        :class:`pydantic.TypeAdapter`.
    """
    return get_type_hints(PageParams, include_extras=True)[field]


def _declared_bound(field: str, bound: str) -> int | None:
    """Return the ``ge`` or ``le`` value ``PageParams`` declares for *field*.

    The constraints arrive as a list of small marker objects on the ``Query`` object's
    ``metadata``, one per bound. They are read by attribute rather than by type, so this
    helper does not depend on which package supplies the marker class.

    Args:
        field: Either ``"page"`` or ``"page_size"``.
        bound: The attribute naming the bound - ``"ge"`` or ``"le"``.

    Returns:
        The declared bound, or ``None`` when the field declares no bound of that kind. A
        ``None`` is meaningful rather than a lookup failure: ``page`` deliberately carries no
        upper bound.
    """
    query = get_args(_window_annotation(field))[1]
    for constraint in query.metadata:
        value = getattr(constraint, bound, None)
        if value is not None:
            return int(value)
    return None


class TestEnvelopeShape:
    """The five-field contract, asserted by equality so a drift cannot pass silently."""

    def test_declares_exactly_the_five_contract_fields(self) -> None:
        # CROSS-TIER CONTRACT. These five names are the wire names, and they are written out
        # literally here rather than derived from anything, so that renaming a field on
        # `Page` cannot be made to pass by editing a constant next to it.
        #
        # Anything that agrees with this set: `app.schemas.common`, which re-exports this very
        # class rather than declaring a second one; `frontend/src/lib/types.ts`, whose `Page<T>`
        # interface and Zod parser both name them; `frontend/src/hooks/use-pagination.ts` and
        # `frontend/src/components/ui/pagination.tsx`, written against them; and
        # `docs/api/rest-endpoints.md`. Equality, not a subset check, is the point - a sixth
        # field is as much a breach as a renamed one, because it is a sixth thing all of those
        # have to agree about.
        assert set(Page.model_fields) == {"items", "total", "page", "page_size", "pages"}

    def test_declares_them_in_the_documented_order(self) -> None:
        assert tuple(Page.model_fields) == _ENVELOPE_FIELD_ORDER

    def test_serialises_exactly_the_contract_keys(self) -> None:
        # The field names being right is necessary but not sufficient: an `alias`, a
        # `serialization_alias` or an `alias_generator` would change the wire shape while
        # leaving every Python-side assertion above green. Asserting on `model_dump` is what
        # closes that gap, because it goes through the serialiser a response actually uses.
        page = build_page(["only"], total=1, page=MIN_PAGE, page_size=DEFAULT_PAGE_SIZE)

        assert set(page.model_dump()) == {"items", "total", "page", "page_size", "pages"}

    def test_serialises_the_keys_in_declaration_order(self) -> None:
        # Annotated because an empty list leaves `ItemT` unsolved; `str` is arbitrary and
        # unused - this test is about the envelope, not about what it carries.
        page: Page[str] = build_page([], total=0, page=MIN_PAGE, page_size=DEFAULT_PAGE_SIZE)

        assert tuple(page.model_dump()) == _ENVELOPE_FIELD_ORDER

    def test_serialises_an_empty_collection_to_the_documented_example(self) -> None:
        # The exact document both tiers publish as the empty-collection example, asserted as a
        # whole rather than field by field. `pages` is 0 here, not 1, and this is the assertion
        # that says so in the shape a client would actually receive.
        assert build_page([], total=0, page=1, page_size=20).model_dump() == {
            "items": [],
            "total": 0,
            "page": 1,
            "page_size": 20,
            "pages": 0,
        }

    @pytest.mark.parametrize("field", _COUNT_FIELDS)
    def test_the_count_fields_are_integers(self, field: str) -> None:
        page = build_page(["a", "b"], total=41, page=2, page_size=20)

        value = getattr(page, field)

        # `bool` is a subclass of `int`, so an `isinstance` check alone would accept `True`
        # where a count belongs. The exact type is what a JSON serialiser reads.
        assert type(value) is int, f"{field} is {type(value).__name__}, not int"

    def test_items_is_a_list_the_envelope_owns(self) -> None:
        # `build_page` declares `items: list[ItemT]`, and every caller conforms: the services
        # build a list of response models, and the repositories are documented as materialising
        # their rows with `list(rows)` first. So this asserts what the envelope guarantees about
        # a list it was handed, and claims nothing about a sequence the signature does not
        # accept - the previous "any sequence in, a list out" wording described a tolerance
        # pydantic happens to have at runtime rather than the contract callers are held to.
        #
        # The property that matters is ownership: validation copies, so the envelope does not
        # alias the caller's list, and a caller mutating its own list afterwards cannot change
        # what an already-built response serialises.
        rows = ["a", "b"]
        page = build_page(rows, total=2, page=MIN_PAGE, page_size=DEFAULT_PAGE_SIZE)

        rows.append("c")

        assert type(page.items) is list
        assert page.items == ["a", "b"]
        assert page.items is not rows

    def test_carries_no_derived_or_hypermedia_fields(self) -> None:
        # Each of these is computable from the five above, and each would be a sixth thing the
        # frontend types, the endpoint reference and the model all have to agree about. This
        # asserts the omissions are deliberate and stay that way.
        for absent in ("has_next", "has_prev", "offset", "limit", "links", "cursor", "next"):
            assert absent not in Page.model_fields


class TestEnvelopeGenericity:
    """``Page`` is generic over its item type, which is what lets every route declare one."""

    @pytest.mark.parametrize(
        ("model", "items"),
        [
            (Page[int], [1, 2, 3]),
            (Page[str], ["a", "b"]),
            (Page[bool], [True, False]),
            (Page[int], []),
        ],
    )
    def test_round_trips_scalar_items_of_the_parameterised_type(
        self,
        model: Any,
        items: list[Any],
    ) -> None:
        page = model(
            items=items,
            total=len(items),
            page=MIN_PAGE,
            page_size=DEFAULT_PAGE_SIZE,
            pages=1,
        )

        assert page.items == items
        assert page.model_dump()["items"] == items

    def test_nests_an_item_models_own_serialisation(self) -> None:
        # The property every `response_model=Page[...]` in the API depends on: the envelope
        # serialises its items through their own model, so the result is a list of dicts rather
        # than a list of model instances or a flattened structure.
        page = Page[_Row](
            items=[_Row(slug="scaling-fastapi", views=7)],
            total=1,
            page=MIN_PAGE,
            page_size=DEFAULT_PAGE_SIZE,
            pages=1,
        )

        assert page.model_dump() == {
            "items": [{"slug": "scaling-fastapi", "views": 7}],
            "total": 1,
            "page": MIN_PAGE,
            "page_size": DEFAULT_PAGE_SIZE,
            "pages": 1,
        }

    def test_build_page_nests_item_models_too(self) -> None:
        # The same property reached through the factory rather than the constructor, since that
        # is how every repository actually produces an envelope.
        page = build_page(
            [_Row(slug="first", views=1), _Row(slug="second", views=2)],
            total=2,
            page=MIN_PAGE,
            page_size=DEFAULT_PAGE_SIZE,
        )

        assert page.model_dump()["items"] == [
            {"slug": "first", "views": 1},
            {"slug": "second", "views": 2},
        ]

    def test_a_parameterisation_rejects_an_unconvertible_item(self) -> None:
        # `Page[int]` is a distinct concrete model with a validated `list[int]`, so a value that
        # cannot become an int is refused rather than stored. This is what makes the generic
        # parameter load-bearing instead of decorative.
        with pytest.raises(ValidationError) as raised:
            Page[int](
                # Deliberately the wrong static type: the assertion IS that the concrete
                # parameterisation refuses it. Suppressed by code so the line hides exactly the
                # one error it exists to provoke.
                items=["not-a-number"],  # type: ignore[list-item]
                total=1,
                page=MIN_PAGE,
                page_size=DEFAULT_PAGE_SIZE,
                pages=1,
            )

        assert raised.value.error_count() == 1
        assert raised.value.errors()[0]["loc"] == ("items", 0)

    def test_a_parameterisation_coerces_a_convertible_item(self) -> None:
        # No `strict=True` is configured on the model, so pydantic's default lax mode applies
        # and a numeric string becomes an int. Asserted rather than left uncovered, so that
        # enabling strict mode later is a deliberate change with a failing test to notice it.
        page = Page[int](
            # Wrong static type on purpose again, and this time the assertion is that lax mode
            # converts it rather than refusing it.
            items=["5"],  # type: ignore[list-item]
            total=1,
            page=MIN_PAGE,
            page_size=DEFAULT_PAGE_SIZE,
            pages=1,
        )

        assert page.items == [5]
        assert type(page.items[0]) is int

    def test_the_unparameterised_factory_passes_items_through_untyped(self) -> None:
        # `build_page` deliberately constructs a bare `Page`, so at runtime `items` validates
        # as `list[Any]` and heterogeneous content survives. That is why the type discipline
        # for a response body comes from the route's `response_model=Page[...]` declaration,
        # which re-validates, and not from this factory.
        page = build_page(["text", 1, None], total=3, page=MIN_PAGE, page_size=DEFAULT_PAGE_SIZE)

        assert page.items == ["text", 1, None]


class TestPageCountArithmetic:
    """``pages`` is ``ceil(total / page_size)``, boundary by boundary."""

    @pytest.mark.parametrize(("total", "page_size", "expected_pages"), _PAGE_COUNT_CASES)
    def test_counts_the_pages_a_total_occupies(
        self,
        total: int,
        page_size: int,
        expected_pages: int,
    ) -> None:
        page: Page[str] = build_page([], total=total, page=MIN_PAGE, page_size=page_size)

        assert page.pages == expected_pages, (
            f"{total} rows at {page_size} per page should occupy {expected_pages} pages, "
            f"got {page.pages}"
        )

    def test_an_exact_multiple_gains_no_trailing_empty_page(self) -> None:
        # Spelled out separately from the table because it is the failure this whole module
        # exists to prevent, and a reader scanning test names should find it by name. Twenty
        # rows at ten per page is two pages. Three would mean the client renders a third page
        # link that returns nothing.
        assert build_page([], total=20, page=1, page_size=10).pages == 2

    def test_one_row_past_an_exact_multiple_needs_a_further_page(self) -> None:
        # The mirror of the case above: the twenty-first row cannot share a full window, so it
        # gets a page of its own.
        assert build_page([], total=21, page=1, page_size=10).pages == 3

    def test_an_empty_collection_occupies_no_pages_and_raises_nothing(self) -> None:
        # `total == 0` is the input that would divide by zero under a naive formula, and the one
        # whose answer surprises readers. It is 0 rather than 1 because `ceil(0 / n) == 0`, and
        # the frontend is written to render no page control at all on that value. Asserted here
        # with the two things that hold regardless of the count: no exception, and no items.
        page: Page[str] = build_page([], total=0, page=MIN_PAGE, page_size=DEFAULT_PAGE_SIZE)

        assert page.pages == 0
        assert page.items == []
        assert page.total == 0

    @pytest.mark.parametrize("page_size", [MIN_PAGE_SIZE, 10, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE])
    def test_an_empty_collection_occupies_no_pages_at_any_window_size(self, page_size: int) -> None:
        assert build_page([], total=0, page=MIN_PAGE, page_size=page_size).pages == 0

    @pytest.mark.parametrize(("total", "page_size", "expected_pages"), _LARGE_MAGNITUDE_CASES)
    def test_is_exact_at_magnitudes_a_float_cannot_represent(
        self,
        total: int,
        page_size: int,
        expected_pages: int,
    ) -> None:
        # `total` arrives from a `COUNT(*)` and Python integers are unbounded, so nothing in the
        # formula can overflow - but a float intermediate would silently lose the low bits.
        page: Page[str] = build_page([], total=total, page=MIN_PAGE, page_size=page_size)

        assert page.pages == expected_pages

    @pytest.mark.parametrize(("total", "page_size", "expected_pages"), _FLOAT_DIVERGENCE_CASES)
    def test_does_not_use_float_division_where_that_would_be_wrong(
        self,
        total: int,
        page_size: int,
        expected_pages: int,
    ) -> None:
        # Two assertions, and the second is the interesting one. The first says the
        # implementation is right; the second says the obvious alternative would have been
        # wrong, which is what makes this a regression test rather than a restatement. If a
        # future edit swaps the integer form for `math.ceil(total / page_size)`, the first
        # assertion starts failing on exactly these rows.
        assert build_page([], total=total, page=MIN_PAGE, page_size=page_size).pages == (
            expected_pages
        )
        assert math.ceil(total / page_size) != expected_pages, (
            f"float division happens to be exact for total={total}, page_size={page_size}, "
            "so this row proves nothing and belongs in _LARGE_MAGNITUDE_CASES instead"
        )

    @pytest.mark.parametrize("page_size", [MIN_PAGE_SIZE, 3, 10, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE])
    def test_agrees_with_float_ceiling_while_floats_are_still_exact(self, page_size: int) -> None:
        # Below 2**53 a double represents these quotients exactly, so `math.ceil` is a genuinely
        # independent second opinion rather than a reimplementation of the same expression.
        for total in range(0, 251):
            expected = math.ceil(total / page_size)
            actual = build_page([], total=total, page=MIN_PAGE, page_size=page_size).pages
            assert actual == expected, (
                f"total={total}, page_size={page_size}: got {actual}, math.ceil says {expected}"
            )

    def test_matches_an_integer_oracle_across_a_swept_range(self) -> None:
        # The ceiling-division oracle from a different direction: `-(-a // b)` rather than
        # `(a + b - 1) // b`. The two expressions are equal for all non-negative `a` and
        # positive `b`, so agreement across a swept range covers every carry boundary rather
        # than the handful the table above names.
        for page_size in range(MIN_PAGE_SIZE, 26):
            for total in range(0, 121):
                expected = -(-total // page_size)
                actual = build_page([], total=total, page=MIN_PAGE, page_size=page_size).pages
                assert actual == expected, (
                    f"total={total}, page_size={page_size}: got {actual}, expected {expected}"
                )

    def test_pages_is_the_smallest_window_count_that_covers_the_total(self) -> None:
        # A characterisation rather than a formula, so this test would survive a legitimate
        # rewrite of the arithmetic and still catch a wrong one. For a non-empty collection the
        # last page must be necessary - the pages before it do not hold every row - and it must
        # be sufficient - `pages` windows do. Exactly one integer satisfies both.
        for page_size in range(MIN_PAGE_SIZE, 26):
            for total in range(0, 121):
                pages = build_page([], total=total, page=MIN_PAGE, page_size=page_size).pages
                if total == 0:
                    assert pages == 0
                    continue
                assert (pages - 1) * page_size < total, (
                    f"total={total}, page_size={page_size}: {pages} pages is more than needed"
                )
                assert total <= pages * page_size, (
                    f"total={total}, page_size={page_size}: {pages} pages cannot hold them all"
                )

    def test_page_count_is_independent_of_how_many_items_were_supplied(self) -> None:
        # `total` is the unwindowed `COUNT(*)`, never `len(items)`. Deriving it from the items
        # would collapse it to the window size and make `pages` read 1 on every page of every
        # collection, so a short last page must not change the count.
        full = build_page(["a"] * 10, total=95, page=1, page_size=10)
        short = build_page(["a"] * 5, total=95, page=10, page_size=10)
        empty: Page[str] = build_page([], total=95, page=99, page_size=10)

        assert full.pages == short.pages == empty.pages == 10


class TestBuildPageEcho:
    """What goes in comes back out: the envelope reports, it does not correct."""

    @pytest.mark.parametrize(("total", "page_size", "expected_pages"), _PAGE_COUNT_CASES)
    def test_echoes_total_and_page_size_verbatim(
        self,
        total: int,
        page_size: int,
        expected_pages: int,
    ) -> None:
        del expected_pages  # Covered by TestPageCountArithmetic; this row is reused for echo.
        page: Page[str] = build_page([], total=total, page=MIN_PAGE, page_size=page_size)

        assert page.total == total
        assert page.page_size == page_size

    @pytest.mark.parametrize("requested_page", [MIN_PAGE, 2, 7, 99, 1_000_000])
    def test_echoes_the_requested_page_verbatim(self, requested_page: int) -> None:
        page: Page[str] = build_page([], total=95, page=requested_page, page_size=10)

        assert page.page == requested_page

    def test_passes_the_supplied_items_through_untouched(self) -> None:
        # No re-slicing, no re-ordering, no truncation: the window was already applied by the
        # SQL that produced these rows, and re-applying it here would be a second, divergent
        # implementation of the same windowing.
        supplied = ["third", "first", "second"]

        page = build_page(supplied, total=41, page=2, page_size=3)

        assert page.items == ["third", "first", "second"]
        assert len(page.items) == 3

    def test_does_not_truncate_items_that_overrun_the_window(self) -> None:
        # A caller that over-fetched has a bug in its query, not in its envelope, and silently
        # trimming the list here would hide it.
        page = build_page(["a", "b", "c"], total=3, page=MIN_PAGE, page_size=2)

        assert page.items == ["a", "b", "c"]

    def test_does_not_mutate_the_list_it_was_given(self) -> None:
        supplied = ["a", "b"]

        build_page(supplied, total=2, page=MIN_PAGE, page_size=DEFAULT_PAGE_SIZE)

        assert supplied == ["a", "b"]

    def test_a_page_beyond_the_last_one_is_answered_not_refused(self) -> None:
        # AAP §0.9.4.4 requires this end to end - "an out-of-range page returns an empty item
        # list rather than an error" - and this is the cheapest place to pin it down. Nothing is
        # wrapped in `pytest.raises`, deliberately: the call must succeed. The requested page is
        # echoed back beside the real count, which is precisely how a client detects it has run
        # off the end rather than being redirected to a page it never asked for.
        page: Page[str] = build_page([], total=5, page=99, page_size=10)

        assert page.items == []
        assert page.total == 5
        assert page.page == 99
        assert page.pages == 1

    def test_a_page_beyond_the_last_one_is_never_clamped(self) -> None:
        # The failure this guards against is a plausible "helpful" edit: clamping `page` down to
        # `pages` would answer a different question from the one asked, and silently.
        page: Page[str] = build_page([], total=0, page=42, page_size=DEFAULT_PAGE_SIZE)

        assert page.page == 42
        assert page.pages == 0

    @pytest.mark.parametrize("page_size", [0, -1, -10, -DEFAULT_PAGE_SIZE])
    def test_rejects_a_non_positive_window(self, page_size: int) -> None:
        # The one genuinely invalid input, and the only path in the module that raises. A window
        # of no rows has no meaningful page count, and `ceil(total / 0)` cannot be computed at
        # all, so raising beats dividing by zero and beats substituting a default that would
        # make the resulting `pages` a fiction. It can only arrive from a defect in the service
        # tier, because a request-supplied value is bounded before it reaches here - which
        # TestPageWindowBounds asserts directly.
        with pytest.raises(ValueError, match="page_size must be a positive integer"):
            build_page([], total=10, page=MIN_PAGE, page_size=page_size)

    def test_the_rejection_names_the_bounding_dependency(self) -> None:
        # The message has to tell a developer where to fix the caller, not just that the caller
        # was wrong, because the raise is unreachable from a request and so only ever seen by
        # someone debugging the service tier.
        with pytest.raises(ValueError, match="PageParams") as raised:
            build_page([], total=1, page=MIN_PAGE, page_size=0)

        assert "0" in str(raised.value)


class TestPageWindowDefaults:
    """What a client that asks for nothing in particular receives."""

    def test_defaults_to_the_first_page_at_the_default_size(self) -> None:
        params = PageParams()

        assert params.page == MIN_PAGE
        assert params.page_size == DEFAULT_PAGE_SIZE

    def test_the_default_window_derives_a_zero_offset_and_a_full_limit(self) -> None:
        params = PageParams()

        assert params.offset == 0
        assert params.limit == DEFAULT_PAGE_SIZE

    def test_the_default_size_sits_inside_the_declared_bounds(self) -> None:
        # A default outside its own bounds would make an unparameterised request a 422, which is
        # the kind of defect that only shows up on the one call that omits the query string.
        assert MIN_PAGE_SIZE <= DEFAULT_PAGE_SIZE <= MAX_PAGE_SIZE

    def test_the_window_cannot_be_renumbered_after_construction(self) -> None:
        # Frozen, so a service cannot quietly answer a different question from the one it was
        # asked. `dataclasses.FrozenInstanceError` subclasses `AttributeError`, which is what is
        # asserted so the test does not depend on that detail.
        params = PageParams()

        with pytest.raises(AttributeError):
            params.page = 2  # type: ignore[misc]


class TestPageWindowBounds:
    """The bounds are declared on the annotation, and enforced there before a route runs."""

    def test_page_declares_its_floor_at_the_module_minimum(self) -> None:
        # Read from the module's own constant rather than a hardcoded 1, so the test tracks the
        # source. `app.core.dependencies` says as much in the comment above these constants:
        # the `Query` validators, the docstrings and the tests all have to agree on them.
        assert _declared_bound("page", "ge") == MIN_PAGE

    def test_page_declares_no_ceiling(self) -> None:
        # The asymmetry with `page_size` is deliberate and contractual. A page past the end is a
        # legitimate request that matches no rows, and clamping it to the last page would return
        # that page's rows under the number the caller asked for. `build_page` echoes the request
        # back instead, which only works if nothing capped it on the way in.
        assert _declared_bound("page", "le") is None

    def test_page_size_declares_both_module_bounds(self) -> None:
        assert _declared_bound("page_size", "ge") == MIN_PAGE_SIZE
        assert _declared_bound("page_size", "le") == MAX_PAGE_SIZE

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            # A page below the floor. Pages are 1-based, so 0 is a client defect rather than an
            # alternative spelling of page one - under a 0-based reading `page=0` and `page=1`
            # would return the same rows and every page number in a shared link would be
            # ambiguous.
            ("page", 0),
            ("page", -1),
            ("page", -5),
            # A window of no rows has no meaningful answer, and it is the single input
            # `build_page` raises on. Rejecting it here is what makes that raise unreachable
            # from a request.
            ("page_size", 0),
            ("page_size", -1),
            ("page_size", -5),
            # Above the ceiling. Without the cap, `?page_size=1000000` is a legal request that
            # becomes a full table scan and a response no client can render.
            ("page_size", MAX_PAGE_SIZE + 1),
            ("page_size", 1_000),
            ("page_size", 10_000),
        ],
    )
    def test_the_declared_window_rejects_a_value_outside_its_bounds(
        self,
        field: str,
        value: int,
    ) -> None:
        # This is where "page floors at 1" and "page_size is capped" actually happen. The bounds
        # are `Query` constraints on the annotation, so FastAPI applies them to the query string
        # before the route is entered and an out-of-range window answers 422 with the uniform
        # problem document naming the parameter. Validating the annotation directly through a
        # `TypeAdapter` exercises that same constraint machinery with no application, no HTTP
        # request and no database - which is what keeps this module a unit test while still
        # asserting the rejection rather than merely the presence of a bound.
        #
        # Note what is deliberately NOT asserted: that the value is corrected. The window is
        # validated, never adjusted. `frontend/src/lib/types.ts` documents the same thing from
        # the other side - an out-of-range value is "rejected, not corrected" - so a client
        # offering a page-size control must keep its options inside the bounds rather than
        # relying on the service to trim them.
        with pytest.raises(ValidationError):
            TypeAdapter(_window_annotation(field)).validate_python(value)

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            ("page", MIN_PAGE),
            ("page", 2),
            ("page", 1_000),
            # Uncapped on purpose: a deep page is valid and simply matches nothing.
            ("page", 10_000_000),
            ("page_size", MIN_PAGE_SIZE),
            ("page_size", DEFAULT_PAGE_SIZE),
            ("page_size", MAX_PAGE_SIZE),
        ],
    )
    def test_the_declared_window_accepts_a_value_inside_its_bounds(
        self,
        field: str,
        value: int,
    ) -> None:
        assert TypeAdapter(_window_annotation(field)).validate_python(value) == value

    def test_construction_itself_applies_no_bounds(self) -> None:
        # The honest statement of where enforcement lives, asserted so that nobody reads the
        # bounds above as a constructor guarantee. `PageParams` is a plain frozen dataclass:
        # dataclasses do not act on `Annotated` metadata, so instantiating one directly in Python
        # stores exactly what it was handed. That is not a defect - the class is only ever built
        # by FastAPI from a validated query string, and the two tests above cover that path - but
        # it does mean `offset` is guaranteed non-negative only for a window inside the declared
        # bounds, which is what the next class asserts.
        unbounded = PageParams(page=0, page_size=MAX_PAGE_SIZE + 1)

        assert unbounded.page == 0
        assert unbounded.page_size == MAX_PAGE_SIZE + 1

    def test_a_page_below_the_floor_would_derive_a_negative_offset(self) -> None:
        # The consequence of the line above, stated explicitly because it is the reason the floor
        # exists at all rather than being a matter of taste. A `page` of 0 produces a negative
        # `OFFSET`, which PostgreSQL rejects outright. The bound is what makes this unreachable.
        assert PageParams(page=0, page_size=10).offset == -10


class TestPageWindowArithmetic:
    """``offset`` and ``limit``: the window arithmetic, performed in exactly one place."""

    @pytest.mark.parametrize(("page", "page_size", "expected_offset"), _WINDOW_CASES)
    def test_offset_skips_one_window_per_preceding_page(
        self,
        page: int,
        page_size: int,
        expected_offset: int,
    ) -> None:
        params = PageParams(page=page, page_size=page_size)

        assert params.offset == expected_offset, (
            f"page={page}, page_size={page_size}: expected OFFSET {expected_offset}, "
            f"got {params.offset}"
        )

    @pytest.mark.parametrize(("page", "page_size", "expected_offset"), _WINDOW_CASES)
    def test_limit_is_the_requested_window_size(
        self,
        page: int,
        page_size: int,
        expected_offset: int,
    ) -> None:
        del expected_offset  # Asserted by the sibling test; the row is reused for `limit`.
        params = PageParams(page=page, page_size=page_size)

        assert params.limit == page_size

    def test_the_first_page_skips_nothing(self) -> None:
        assert PageParams(page=MIN_PAGE, page_size=MAX_PAGE_SIZE).offset == 0

    def test_limit_is_the_ceiling_when_the_largest_window_is_requested(self) -> None:
        params = PageParams(page=MIN_PAGE, page_size=MAX_PAGE_SIZE)

        assert params.limit == MAX_PAGE_SIZE

    def test_consecutive_pages_neither_skip_nor_repeat_a_row(self) -> None:
        # The off-by-one this arithmetic exists to prevent, asserted as the property that matters
        # rather than as a formula: each page must begin exactly where the previous one ended. An
        # offset one too small repeats a row at every boundary; one too large loses a row.
        for page_size in (MIN_PAGE_SIZE, 3, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE):
            for page in range(MIN_PAGE, 12):
                current = PageParams(page=page, page_size=page_size)
                following = PageParams(page=page + 1, page_size=page_size)

                assert following.offset == current.offset + current.limit, (
                    f"page={page}, page_size={page_size}: page {page + 1} starts at "
                    f"{following.offset} but page {page} ends at "
                    f"{current.offset + current.limit}"
                )

    def test_a_bounded_window_always_derives_a_usable_offset_and_limit(self) -> None:
        # The non-negativity invariant, swept across every window a request can actually produce.
        # `OFFSET` must never be negative and `LIMIT` must never be below one, and both hold for
        # free because `MIN_PAGE` and `MIN_PAGE_SIZE` are positive - which is exactly why they
        # are bounds rather than conventions.
        for page in (MIN_PAGE, 2, 3, 17, 1_000):
            for page_size in range(MIN_PAGE_SIZE, MAX_PAGE_SIZE + 1):
                params = PageParams(page=page, page_size=page_size)

                assert params.offset >= 0
                assert params.limit >= MIN_PAGE_SIZE
                assert params.limit <= MAX_PAGE_SIZE


class TestTheTwoHalvesAgree:
    """The request window and the response envelope have to meet without a seam."""

    def test_a_bounded_window_can_never_trigger_the_build_page_guard(self) -> None:
        # `MIN_PAGE_SIZE`'s own documentation claims that bounding `page_size` at the edge is
        # what makes `build_page`'s raise unreachable from a request. This asserts the claim
        # across every window size a validated request can carry, rather than trusting it.
        for page_size in range(MIN_PAGE_SIZE, MAX_PAGE_SIZE + 1):
            params = PageParams(page_size=page_size)

            page: Page[str] = build_page([], total=0, page=params.page, page_size=params.limit)

            assert page.page_size == page_size
            assert page.pages == 0

    def test_the_envelope_reports_the_window_that_was_asked_for(self) -> None:
        # The seam a repository actually writes: `limit`/`offset` go to the query, `page`/
        # `page_size` go to the envelope. If those disagreed, a client would page a window it
        # never requested.
        params = PageParams(page=3, page_size=25)

        page = build_page(["row"], total=97, page=params.page, page_size=params.page_size)

        assert page.page == 3
        assert page.page_size == 25
        assert page.pages == 4
        assert params.offset == 50
        assert params.limit == 25

    def test_the_last_page_of_a_bounded_window_is_reachable(self) -> None:
        # Every page the envelope advertises must be addressable by a window the bounds allow:
        # the offset of the final page must fall inside the collection, so following the page
        # count never lands a client on a page that cannot hold a row.
        for page_size in (MIN_PAGE_SIZE, 7, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE):
            for total in (1, 2, 41, 99, 100, 101, 1_000):
                pages = build_page([], total=total, page=MIN_PAGE, page_size=page_size).pages
                last = PageParams(page=pages, page_size=page_size)

                assert last.offset < total, (
                    f"total={total}, page_size={page_size}: page {pages} starts at "
                    f"{last.offset}, past the end of the collection"
                )
                assert last.offset + last.limit >= total, (
                    f"total={total}, page_size={page_size}: page {pages} ends at "
                    f"{last.offset + last.limit}, short of {total} rows"
                )
