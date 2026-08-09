"""Integration tests for the two public, read-only routes over the ``categories`` taxonomy.

The taxonomy is the entity the requirement never named. The brief asked for "category filters"
on the home page and for an administrative screen "managing ... categories", so a relation with
a name, a URL-safe slug and a description had to exist before either feature could work at all -
which makes ``categories`` an implicit prerequisite that two explicit requirements rest on
(AAP §0.1.3), and makes these two routes the reader-facing half of it:

``GET /api/v1/categories``
    Every category, each with how many PUBLISHED posts are filed under it. This is what the home
    feed's filter control is built from - a row of chips reading ``Python (12)``.
``GET /api/v1/categories/{slug}``
    One category, resolved by the slug in its URL.

This module is named by AAP §0.4.4.5 and §0.7.1.11 (Group 11 - Tests) and covers exactly those
two rows of the endpoint inventory in AAP §0.6.2. The taxonomy's *write* lifecycle - create,
rename, delete - is administrator-only and lives on ``/api/v1/admin/categories``; asserting it
belongs to ``test_admin_api.py``, and all this module proves about it is that none of it is
reachable here.

Governing rules
---------------
``review_rules`` reports that this project specifies **no user rules**, so no user rule governs
this file and no rule put it in scope - it traces solely to the two AAP sections above. Their
absence is not licence to assert less, so the bar applied here is AAP §0.10.1's self-imposed
enterprise standards, two of which decide the shape of this module:

*Explicit API contracts* (standard #4) requires one page envelope for every collection, and
names this listing as its single sanctioned exception. An untested exception is
indistinguishable from a defect, so :class:`TestCategoryListingShape` asserts the exception
**positively** - the body is a bare JSON array, and none of the five envelope members is
anywhere in it. *Blocking quality gates* (standard #8) makes this suite and its coverage floor
blocking, so there is no ``skip``, no ``xfail``, no placeholder and nothing order-dependent
below.

Two properties of this endpoint shape every assertion here
----------------------------------------------------------
**The listing is a bare JSON array, not a page envelope.** ``routers/categories.py`` declares
``response_model=list[CategoryPublic]`` - not ``Page[CategoryPublic]`` - and that is the only
collection in the API that answers that way. The exception is deliberate: the array *is* the
filter control, so a window would offer some terms and silently hide every post filed
exclusively under the rest, which is a wrong answer rather than a partial one, and no status
code reports it. Nothing here may assert ``items``, ``total``, ``page``, ``page_size`` or
``pages`` on this route. ``test_openapi_contract.py`` exempts this same operation from its
page-envelope walk; the two modules state one exception from two directions, and if they ever
disagree the disagreement is the bug.

**The relation is never empty.** Alembic revision ``0003_seed_reference_categories`` is a pure
data migration that inserts eight reference categories as rows, and ``conftest.py`` builds the
test schema by migrating to head. Those rows were committed by the migration rather than by a
test, so the per-test rollback does not remove them and they are baseline data before the first
assertion in this file runs. Every assertion below is therefore *inclusive* - "contains",
"at least one", "this entry" - and never an exact total, never "empty", and never a positional
index. A category this module creates is located **by slug** within the returned array, which is
also robust to the reference set itself changing. (``app.db.seed`` is invoked by neither the
application lifespan nor ``conftest.py``, so its demonstration rows are *not* present; revision
``0003`` is the only baseline.)

How these tests are isolated
----------------------------
``conftest.py``'s ``db_session`` opens a transaction on a dedicated connection and rolls it back
when the test ends, with ``join_transaction_mode="create_savepoint"`` so that even a service
that legitimately commits is undone. ``client`` drives the application in process over
``ASGITransport`` - no server, no port - with ``get_db`` overridden to yield that *same* session,
which is why a row a factory just flushed is visible to the request under test. Nothing below
truncates a table, deletes a reference row or depends on another test having run first.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any, Final

import pytest
from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import PROBLEM_JSON_MEDIA_TYPE
from app.models import PostStatus, User
from tests.factories import create_category, create_post, create_published_post

# Every test in this module drives the HTTP surface against PostgreSQL, which is precisely what
# `backend/pyproject.toml` registers the `integration` marker for. Applied at module level so
# `-m integration` selects the file as a whole, and `--strict-markers` guarantees the name is a
# registered one rather than a typo that silently selects nothing.
pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------------------
# The surface under test
# ---------------------------------------------------------------------------------------

_CATEGORIES_URL: Final[str] = "/api/v1/categories"
"""The collection path, written once.

No trailing slash, matching the route's own empty relative path: the canonical unslashed form is
what answers with a body, and hard-coding it here means no test accidentally exercises the
redirect that a trailing slash would provoke.
"""


def _category_url(slug: str) -> str:
    """Build the single-read path for one slug.

    Args:
        slug: The slug to address, in whatever case the caller wants to send. Interpolated
            verbatim, because the case-insensitivity of the lookup is one of the things this
            module asserts and a helper that normalised the case would assert it away.

    Returns:
        The path for ``GET /api/v1/categories/{slug}``.
    """
    return f"{_CATEGORIES_URL}/{slug}"


# ---------------------------------------------------------------------------------------
# Contract constants
#
# Each of these mirrors a declaration in `backend/app/`, and is spelled out here rather than
# imported from the model it mirrors. A test that derived the expected field set from
# `CategoryPublic.model_fields` would agree with the implementation by construction and could
# never fail - including when a field was removed from the wire by mistake. Restating the
# contract is what makes these assertions able to detect a change to it.
# ---------------------------------------------------------------------------------------

_CATEGORY_PUBLIC_FIELDS: Final[frozenset[str]] = frozenset(
    {"id", "name", "slug", "description", "post_count", "created_at"}
)
"""Exactly the members ``CategoryPublic`` publishes, and the response model of both routes.

``id``, ``name`` and ``slug`` are inherited from ``CategorySummary``; ``description``,
``post_count`` and ``created_at`` are added. ``updated_at`` is deliberately *not* published -
no reader-facing surface asks when a category was renamed - so an equality assertion against
this set is what would catch it appearing.
"""

_PAGE_ENVELOPE_FIELDS: Final[frozenset[str]] = frozenset(
    {"items", "total", "page", "page_size", "pages"}
)
"""The five members of ``app.core.pagination.Page``, which this listing must **not** carry.

Named here so the one sanctioned exception to the envelope is asserted rather than assumed. If
this listing ever starts answering with these keys, the failure should name them.
"""

_PROBLEM_DOCUMENT_FIELDS: Final[frozenset[str]] = frozenset(
    {"type", "title", "status", "detail", "instance", "request_id"}
)
"""The members every failure in this API carries, from ``app.core.exceptions``.

``errors`` is an optional seventh that appears only on a validation failure, so it is checked
where it is expected rather than required of every document. Asserting the other six on each
failure below is what proves the contract is uniform across a service-raised 404, a
framework-raised 405 and a parameter-validation 422 - three different origins, one shape. The
surface being replaced repeated one ad-hoc ``{"detail": "Item not found"}`` raise at three call
sites, so its error shape was declared three times and could have drifted three ways.
"""

_ERROR_TYPE_NOT_FOUND: Final[str] = "/errors/not-found"
"""``type`` of a 404 problem document, whether the service or the router produced it."""

_ERROR_TYPE_METHOD_NOT_ALLOWED: Final[str] = "/errors/method-not-allowed"
"""``type`` of the 405 a mutating method gets on either of these read-only paths."""

_ERROR_TYPE_VALIDATION: Final[str] = "/errors/validation-error"
"""``type`` of the 422 a slug carrying an unstorable character gets."""

_REFERENCE_CATEGORY_SLUGS: Final[frozenset[str]] = frozenset(
    {
        "engineering",
        "architecture",
        "backend",
        "frontend",
        "databases",
        "devops",
        "security",
        "product",
    }
)
"""The slugs revision ``0003_seed_reference_categories`` inserts as data.

Asserted as a **subset** of what the listing returns, never as an equality: the point of the
revision is that a freshly migrated environment can exercise filtering immediately, so a later
revision adding a ninth term must not fail this suite. Matching on slug rather than on name or
on position is the same robustness the idempotent seeding helper in ``app.db.seed`` relies on.
"""

_SEEDED_CATEGORY_SLUG: Final[str] = "engineering"
"""One reference slug, used where a test needs an existing category but no setup of its own.

Drawn from :data:`_REFERENCE_CATEGORY_SLUGS` and named here so the dependence on revision
``0003``'s data is declared once rather than buried in a parameter list. The dependence is
self-consistent within this module:
:meth:`TestCategoryListingBaseline.test_listing_contains_every_reference_category_from_revision_0003`
asserts this very slug is present, so if the reference set changed, that test would say so first
and in the clearest terms.
"""

_NUL_CHARACTER_SLUG: Final[str] = "%00nul"
"""A percent-encoded NUL in the slug segment: the one value of ``slug`` that reaches a 422.

``CITEXT`` cannot represent U+0000, so ``StorableText`` refuses it in the request rather than
letting the driver refuse it at the comparison. Everything else about a slug is opaque text to
this tier, which is why every *other* unrecognisable segment answers 404 instead.
"""


# ---------------------------------------------------------------------------------------
# Assertion helpers
#
# Written as module-level functions rather than as fixtures because none of them needs setup or
# teardown - they are assertions about a response - and a helper that took a fixture would make
# every test that used it look as though it depended on state. Each one raises on failure and
# returns the value the caller goes on to assert further things about.
# ---------------------------------------------------------------------------------------


def _decode_listing(response: Response) -> list[dict[str, Any]]:
    """Assert that a listing response is a successful bare JSON array, and return it.

    This is the single documented exception to the page envelope, asserted three ways: the
    decoded body is a ``list``, it is not a mapping, and the bytes on the wire open with ``[``.
    The third check is the one a client would notice, because a client parses the wire rather
    than the object a test happens to have decoded.

    Args:
        response: The response to ``GET /api/v1/categories``.

    Returns:
        The decoded array, each element a category object.
    """
    assert response.status_code == 200, (
        f"the listing must answer 200, got {response.status_code}: {response.text}"
    )
    assert response.headers["content-type"].startswith("application/json"), (
        "the listing is a successful JSON response, not a problem document: "
        f"{response.headers.get('content-type')!r}"
    )

    body: Any = response.json()

    # The negative is asserted FIRST, on the still-unnarrowed value. A page envelope is a JSON
    # object, so "this is not a mapping" is the direct statement that the envelope is absent -
    # and stating it before the positive check keeps it a real assertion rather than a line a
    # type checker can prove unreachable once `body` has been narrowed to a list.
    assert not isinstance(body, dict), (
        "a page envelope is a JSON object and this listing must not be one; got the members "
        f"{sorted(body)}"
    )
    assert isinstance(body, list), (
        "GET /api/v1/categories answers with a BARE ARRAY - the one sanctioned exception to the "
        f"page envelope in this API - but the decoded body was {type(body).__name__}"
    )
    assert response.text.lstrip().startswith("["), (
        f"the bytes on the wire must open a JSON array, got {response.text[:80]!r}"
    )
    return body


def _slugs_of(listing: list[dict[str, Any]]) -> list[str]:
    """Return the slug of every entry in a listing, in the order the listing gave them.

    Args:
        listing: A decoded listing.

    Returns:
        The slugs, order preserved so an ordering assertion can use them.
    """
    return [entry["slug"] for entry in listing]


def _entry_for_slug(listing: list[dict[str, Any]], slug: str) -> dict[str, Any]:
    """Locate one entry in a listing by its slug, failing with a useful message if it is absent.

    Locating **by slug** rather than by position is the whole point of this helper. The relation
    carries revision ``0003``'s eight reference rows before any test runs, and the listing is
    ordered by name, so ``listing[0]`` is neither the row a test created nor a stable target.

    Args:
        listing: A decoded listing.
        slug: The slug to find. Compared exactly, because a slug is stored lower-case and the
            listing echoes what is stored - the case-insensitivity under test is a property of
            the *lookup* route, not of the array.

    Returns:
        The matching entry.
    """
    for entry in listing:
        if entry["slug"] == slug:
            return entry

    message = f"no entry with slug {slug!r} in the listing; slugs were {_slugs_of(listing)}"
    raise AssertionError(message)


def _assert_category_public_shape(payload: dict[str, Any]) -> None:
    """Assert that one object is a complete, well-typed ``CategoryPublic`` representation.

    Applied to every element of the listing and to the single read, because both declare the
    same response model and a difference between them would be a contract defect rather than a
    convenience.

    Args:
        payload: One decoded category object.
    """
    assert set(payload) == _CATEGORY_PUBLIC_FIELDS, (
        "a category must carry exactly the CategoryPublic members; "
        f"missing {sorted(_CATEGORY_PUBLIC_FIELDS - set(payload))}, "
        f"unexpected {sorted(set(payload) - _CATEGORY_PUBLIC_FIELDS)}"
    )
    assert not _PAGE_ENVELOPE_FIELDS & set(payload), (
        "no page-envelope member may appear on a category object either: "
        f"{sorted(_PAGE_ENVELOPE_FIELDS & set(payload))}"
    )

    # Identity is server-generated - `gen_random_uuid()` from revision 0001 - so it must parse
    # as a UUID rather than merely be present. A client keys a rendered list on this value.
    assert uuid.UUID(str(payload["id"]))

    assert isinstance(payload["name"], str), "name is a string label"
    assert payload["name"], "name is never blank - it is rendered verbatim on a filter chip"
    assert isinstance(payload["slug"], str), "slug is a string path segment"
    assert payload["slug"], "slug is never blank - a canonical URL is built from it"

    # `description` is nullable in the column and `str | None` on the model. The KEY is always
    # present, so a client never has to tell an absent member from a null one - only the value
    # may be null, which is what this pair of assertions pins down.
    assert payload["description"] is None or isinstance(payload["description"], str)

    # A COUNT cannot be negative, and the model declares `ge=0`. Zero is a real value - a
    # category with no published posts yet - and is returned as 0 rather than omitted.
    assert isinstance(payload["post_count"], int), "post_count is an integer tally"
    assert payload["post_count"] >= 0, f"post_count cannot be negative: {payload['post_count']}"

    # Timestamps are timezone-aware UTC instants from the database clock, serialised as ISO 8601
    # with an offset. Parsing is the assertion: a naive value would leave a client guessing.
    created_at = datetime.fromisoformat(payload["created_at"])
    assert created_at.tzinfo is not None, f"created_at must be aware: {payload['created_at']!r}"


def _assert_problem_document(
    response: Response,
    *,
    status: int,
    error_type: str,
) -> dict[str, Any]:
    """Assert that a failure is the one uniform problem document, and return it.

    Args:
        response: The failing response.
        status: The status code expected, both on the response and inside the document - the
            two agreeing is part of the contract.
        error_type: The expected stable ``type`` member, which is what a client branches on.

    Returns:
        The decoded problem document, for a caller asserting further members.
    """
    assert response.status_code == status, (
        f"expected {status}, got {response.status_code}: {response.text}"
    )
    assert response.headers["content-type"].startswith(PROBLEM_JSON_MEDIA_TYPE), (
        "every failure in this API is published under the problem media type, got "
        f"{response.headers.get('content-type')!r}"
    )

    body = response.json()
    assert isinstance(body, dict), f"a problem document is an object, got {type(body).__name__}"
    assert set(body) >= _PROBLEM_DOCUMENT_FIELDS, (
        f"the problem document is missing {sorted(_PROBLEM_DOCUMENT_FIELDS - set(body))}"
    )
    assert body["type"] == error_type, f"expected type {error_type!r}, got {body['type']!r}"
    assert body["status"] == status, "the document's status must agree with the response status"
    assert isinstance(body["title"], str), "title is a string"
    assert body["title"], "title names the class of failure and is never blank"
    assert isinstance(body["detail"], str), "detail is a string"
    assert body["detail"], "detail is never blank, even when the status phrase is the only text"
    assert isinstance(body["instance"], str), "instance is a string"
    assert body["instance"].startswith("/api/v1/"), (
        f"instance is the requested path, got {body['instance']!r}"
    )

    # The identifier in the body and the one on the header are the same value, which is what
    # lets an operator move from a caller's report to the log line for that exact request.
    assert isinstance(body["request_id"], str), "request_id is a string"
    assert body["request_id"], "request_id correlates the failure with its log entry"
    assert response.headers.get("X-Request-ID") == body["request_id"], (
        "the X-Request-ID header must carry the same identifier the document does"
    )
    return body


# ---------------------------------------------------------------------------------------
# Phase A - the shape of the listing, which is the API's one envelope exception
# ---------------------------------------------------------------------------------------


class TestCategoryListingShape:
    """``GET /api/v1/categories`` answers with a bare array of complete ``CategoryPublic``."""

    async def test_listing_answers_a_bare_json_array_and_never_a_page_envelope(
        self,
        client: AsyncClient,
    ) -> None:
        """The single documented exception to the page envelope, asserted positively (§0.10.1 #4).

        Every other collection in this API answers ``{items, total, page, page_size, pages}``.
        This one answers a bare array, because the array *is* the home feed's filter control and
        a window would hide every post filed exclusively under an omitted term. An exception
        that is merely untested is indistinguishable from a defect, so the array-ness is
        asserted here rather than relied upon, and the five envelope members are asserted absent
        by name so a regression that "normalised" this route would fail with a message that says
        which key appeared. ``test_openapi_contract.py`` exempts this same operation from its
        page-envelope walk; the two tests are one contract seen from two sides.
        """
        listing = _decode_listing(await client.get(_CATEGORIES_URL))

        # Asserted before the loop so the loop cannot be vacuous. The relation is seeded by
        # revision 0003, so an empty array here would itself be a defect - and a `for` over
        # nothing would have reported success while checking not one entry.
        assert listing, "the relation is seeded by revision 0003, so the array is never empty"

        # A list has no members to smuggle an envelope in, so the remaining risk is an entry
        # that carries one - a per-item window, which would be the same defect one level down.
        for entry in listing:
            assert not _PAGE_ENVELOPE_FIELDS & set(entry), (
                "no page-envelope member may appear on an entry either: "
                f"{sorted(_PAGE_ENVELOPE_FIELDS & set(entry))}"
            )

    async def test_listing_entries_carry_exactly_the_category_public_members(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
    ) -> None:
        """Every entry is a complete ``CategoryPublic`` - six members, correctly typed (R8).

        Asserted over the whole array rather than over one entry, so a row seeded by revision
        ``0003`` and a row created through the factory are both held to the declared response
        model. Set *equality* is deliberate: a missing member breaks a client, and an extra one -
        ``updated_at``, say, which the model deliberately withholds - is an unversioned addition
        to a payload fetched on every home-feed render.
        """
        # One created row, so the assertion covers a category with a description this test knows
        # the provenance of as well as the eight the migration inserted.
        await create_category(db_session, name="Shape Probe Category", slug="shape-probe-category")

        listing = _decode_listing(await client.get(_CATEGORIES_URL))

        assert listing, "the relation is never empty - revision 0003 seeds it"
        for entry in listing:
            _assert_category_public_shape(entry)

    async def test_listing_is_ordered_ascending_by_name(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
    ) -> None:
        """The declared ordering holds, so the filter control renders in a stable sequence (R3).

        The repository orders by ``Category.name`` ascending, and the route publishes that in its
        description, which makes it part of the contract rather than an accident of insertion
        order. The assertion is made over three categories created for this test whose names
        share a prefix and differ only in a trailing ASCII letter, so the expected order is the
        same under every plausible database collation - asserting a sort over the whole mixed
        set would be testing PostgreSQL's collation rather than this route's ``ORDER BY``.
        """
        for suffix in ("C", "A", "B"):
            # Inserted deliberately out of order, so passing cannot be an artifact of insertion
            # sequence.
            await create_category(
                db_session,
                name=f"ZzzOrderingProbe{suffix}",
                slug=f"zzz-ordering-probe-{suffix.lower()}",
            )

        listing = _decode_listing(await client.get(_CATEGORIES_URL))
        probes = [slug for slug in _slugs_of(listing) if slug.startswith("zzz-ordering-probe-")]

        assert probes == [
            "zzz-ordering-probe-a",
            "zzz-ordering-probe-b",
            "zzz-ordering-probe-c",
        ], f"the listing must be ascending by name, got {probes}"


# ---------------------------------------------------------------------------------------
# Phase B - baseline data, and locating a row without assuming it is the only one
# ---------------------------------------------------------------------------------------


class TestCategoryListingBaseline:
    """The relation is seeded by migration, so every assertion about it is inclusive."""

    async def test_listing_is_not_empty_on_a_freshly_migrated_database(
        self,
        client: AsyncClient,
    ) -> None:
        """A migrated environment can exercise filtering immediately, with no seeding step.

        Revision ``0003_seed_reference_categories`` inserts its reference terms as **data**, and
        ``conftest.py`` migrates to head, so the filter control has something to render before
        any row is created. This test requests nothing and creates nothing on purpose: it passes
        on the reference data alone, which is what makes it able to catch an accidental
        dependence on rows another test left behind. Note that ``app.db.seed`` is invoked by
        neither the lifespan nor the fixtures, so revision ``0003`` is the only baseline.
        """
        listing = _decode_listing(await client.get(_CATEGORIES_URL))

        assert len(listing) >= 1, (
            "the categories relation is seeded by revision 0003 and must never read as empty"
        )

    async def test_listing_contains_every_reference_category_from_revision_0003(
        self,
        client: AsyncClient,
    ) -> None:
        """The eight seeded terms are all present and all reachable through the public listing.

        Asserted as a **subset**, never as an equality or an exact total: the taxonomy grows by
        editorial effort and by later revisions, and a ninth reference term must not fail this
        suite. Matching on slug rather than on name or position is the same robustness
        ``app.db.seed`` relies on to stay idempotent against exactly these rows.
        """
        listing = _decode_listing(await client.get(_CATEGORIES_URL))
        slugs = set(_slugs_of(listing))

        assert slugs >= _REFERENCE_CATEGORY_SLUGS, (
            "revision 0003's reference categories must all be listed; missing "
            f"{sorted(_REFERENCE_CATEGORY_SLUGS - slugs)}"
        )

    async def test_listing_contains_a_newly_created_category_located_by_slug(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
    ) -> None:
        """A category created in this transaction is visible to the request under test.

        Located **by slug** within the array rather than at a position: the listing is ordered by
        name and already holds the seeded terms, so ``listing[0]`` is neither this row nor a
        stable target. The created values are asserted to survive the round trip unchanged, which
        is what distinguishes "the row is listed" from "something is listed".
        """
        created = await create_category(
            db_session,
            name="Contains Probe Category",
            slug="contains-probe-category",
            description="Prose that must survive the round trip verbatim.",
        )

        listing = _decode_listing(await client.get(_CATEGORIES_URL))
        entry = _entry_for_slug(listing, "contains-probe-category")

        _assert_category_public_shape(entry)
        assert entry["id"] == str(created.id), "identity is the server-generated UUID"
        assert entry["name"] == "Contains Probe Category"
        assert entry["description"] == "Prose that must survive the round trip verbatim."


# ---------------------------------------------------------------------------------------
# Phase C - what `post_count` counts, and what it must not
#
# The tally comes from one LEFT OUTER JOIN with a GROUP BY in `CategoryRepository`, with the
# lifecycle predicate in the join's ON clause rather than in a WHERE clause. Both halves of that
# sentence are load-bearing and each has a test below: the OUTER join is what keeps a zero-count
# term in the result, and the ON-clause predicate is what stops a WHERE from discarding the
# null-extended rows the outer join produced. Neither is visible from the outside except through
# these assertions, and both are easy to lose in a refactor.
# ---------------------------------------------------------------------------------------


class TestCategoryPostCounts:
    """``post_count`` tallies PUBLISHED posts per category, and keeps empty terms present."""

    async def test_category_with_no_published_posts_is_listed_with_a_zero_count(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
    ) -> None:
        """The aggregate's OUTER join keeps an empty term in the filter control (R3).

        This is the assertion that proves the join is LEFT rather than INNER. An inner join, or
        the same predicate moved into a ``WHERE`` clause, would silently drop every category with
        no published post - and the filter control would then omit terms rather than show them
        empty, which is a change no status code reports. Zero is a real value here and is
        returned as ``0``, not omitted.
        """
        await create_category(db_session, name="Empty Probe Category", slug="empty-probe-category")

        listing = _decode_listing(await client.get(_CATEGORIES_URL))
        entry = _entry_for_slug(listing, "empty-probe-category")

        assert entry["post_count"] == 0, (
            "a category with no published posts must still be listed, with a tally of 0"
        )

    async def test_post_count_excludes_drafts_and_archived_posts(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
    ) -> None:
        """Only PUBLISHED posts are counted, so draft confidentiality reaches the aggregate (R2).

        Three posts are filed under one category - one published, one draft, one archived - and
        the tally must read ``1``. A count that included the draft would disclose the existence
        of unpublished work through a public endpoint, and a chip promising three posts that turn
        out to be two drafts is worse than no chip: the tally has to agree exactly with what
        ``GET /api/v1/posts?category={slug}`` returns to an anonymous caller.
        """
        category = await create_category(
            db_session,
            name="Counting Probe Category",
            slug="counting-probe-category",
        )

        # The publication instant is supplied explicitly rather than left to the factory's fill,
        # so the database CHECK this row has to satisfy - `status <> 'PUBLISHED' OR published_at
        # IS NOT NULL`, named ck_posts_published_at_required - is visible at the call site. It
        # must be timezone-aware; a naive value is not a valid instant for a `timestamptz`.
        await create_published_post(
            db_session,
            author=author_user,
            categories=[category],
            published_at=datetime.now(tz=UTC),
        )
        await create_post(
            db_session,
            author=author_user,
            status=PostStatus.DRAFT,
            categories=[category],
        )
        await create_post(
            db_session,
            author=author_user,
            status=PostStatus.ARCHIVED,
            published_at=datetime.now(tz=UTC),
            categories=[category],
        )

        listing = _decode_listing(await client.get(_CATEGORIES_URL))
        entry = _entry_for_slug(listing, "counting-probe-category")

        assert entry["post_count"] == 1, (
            "exactly the published post counts; the draft and the archived post must not, "
            f"got {entry['post_count']}"
        )

    async def test_post_count_increments_for_every_category_a_post_is_filed_under(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
    ) -> None:
        """The tally reads the ``post_categories`` many-to-many in the aggregate direction (R3).

        One post filed under two categories has to count once under each - the association is
        many-to-many, so a post is not the property of a single term. A second post filed under
        only one of the two then separates the counts, which is what proves the ``GROUP BY``
        attributes each filing to its own term rather than collapsing the pair.
        """
        primary = await create_category(
            db_session,
            name="Shared Probe Primary",
            slug="shared-probe-primary",
        )
        secondary = await create_category(
            db_session,
            name="Shared Probe Secondary",
            slug="shared-probe-secondary",
        )

        await create_published_post(
            db_session,
            author=author_user,
            categories=[primary, secondary],
            published_at=datetime.now(tz=UTC),
        )
        await create_published_post(
            db_session,
            author=author_user,
            categories=[primary],
            published_at=datetime.now(tz=UTC),
        )

        listing = _decode_listing(await client.get(_CATEGORIES_URL))

        assert _entry_for_slug(listing, "shared-probe-primary")["post_count"] == 2
        assert _entry_for_slug(listing, "shared-probe-secondary")["post_count"] == 1


# ---------------------------------------------------------------------------------------
# Phase D - one term, resolved by the slug in its URL
# ---------------------------------------------------------------------------------------


class TestCategoryDetail:
    """``GET /api/v1/categories/{slug}`` answers one bare representation, or a 404 document."""

    async def test_detail_returns_the_full_representation_for_a_known_slug(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
    ) -> None:
        """A single read is a bare representation of the declared response model (R8).

        No ``{"message": ..., "data": ...}`` wrapper - the surface being replaced wrapped its
        mutating results that way while returning reads unwrapped, so a client had to know per
        route which of the two it was about to receive. One shape per kind of response is what
        removes the guesswork, and the response model is the same ``CategoryPublic`` the listing
        publishes.
        """
        created = await create_category(
            db_session,
            name="Detail Probe Category",
            slug="detail-probe-category",
            description="Read back on the single-resource route.",
        )

        response = await client.get(_category_url("detail-probe-category"))

        assert response.status_code == 200, response.text
        body = response.json()
        assert isinstance(body, dict), "a single read returns one object, not a collection"
        _assert_category_public_shape(body)
        assert body["id"] == str(created.id)
        assert body["name"] == "Detail Probe Category"
        assert body["slug"] == "detail-probe-category"
        assert body["description"] == "Read back on the single-resource route."

    async def test_detail_post_count_agrees_with_the_listing_entry(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
    ) -> None:
        """One tally, two routes: the single read and the listing report the same number.

        The two are computed by different statements - the listing by a grouped aggregate over
        the whole taxonomy, the single read by a count targeted at one category - so agreement is
        a property worth asserting rather than assuming. A client that renders ``Python (12)`` on
        the home page and then opens the category must not see a different number, and a draft
        must be excluded from both paths identically.
        """
        category = await create_category(
            db_session,
            name="Agreement Probe Category",
            slug="agreement-probe-category",
        )
        await create_published_post(
            db_session,
            author=author_user,
            categories=[category],
            published_at=datetime.now(tz=UTC),
        )
        await create_post(
            db_session,
            author=author_user,
            status=PostStatus.DRAFT,
            categories=[category],
        )

        listing = _decode_listing(await client.get(_CATEGORIES_URL))
        listed = _entry_for_slug(listing, "agreement-probe-category")

        detail = await client.get(_category_url("agreement-probe-category"))
        assert detail.status_code == 200, detail.text

        assert detail.json()["post_count"] == listed["post_count"] == 1, (
            "the targeted count and the grouped aggregate must report the same tally"
        )

    @pytest.mark.parametrize("transform", ["upper", "lower", "capitalize", "swapcase"])
    async def test_detail_resolves_the_slug_case_insensitively(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        transform: str,
    ) -> None:
        """``categories.slug`` is ``CITEXT UNIQUE``, so case-insensitivity is the database's job.

        The route passes the path segment to the service unchanged and the service passes it to
        the repository unchanged - there is no Python case folding anywhere on the path - so
        ``/categories/Python`` and ``/categories/python`` resolving to one row is a property of
        the column type and its unique index. That matters because a published link that varies
        only in case must never break, which is the canonical-URL guarantee the SEO requirement
        rests on. Each casing must resolve to the *same identity*, not merely to something.
        """
        created = await create_category(
            db_session,
            name="Case Probe Category",
            slug="case-probe-category",
        )
        requested: str = getattr("case-probe-category", transform)()

        response = await client.get(_category_url(requested))

        assert response.status_code == 200, (
            f"the slug {requested!r} must resolve through the CITEXT index: {response.text}"
        )
        body = response.json()
        assert body["id"] == str(created.id), "every casing resolves to the same category"
        # The stored value is echoed back, not the casing that was requested: the canonical slug
        # is what a client should build its next link from.
        assert body["slug"] == "case-probe-category"

    async def test_detail_answers_404_problem_document_for_an_unknown_slug(
        self,
        client: AsyncClient,
    ) -> None:
        """Absence is reported as the one uniform problem document (§0.10.1 #4).

        The route inspects nothing itself: the service raises the domain not-found error and the
        handler registered once in ``app.main`` renders it. That single registration is what
        replaced three duplicated ad-hoc 404 raises in the surface being retired, so the shape is
        declared once and cannot drift per call site. The ``instance`` member names the path that
        failed, and ``type`` is the stable value a client branches on.
        """
        response = await client.get(_category_url("no-such-category-anywhere"))

        body = _assert_problem_document(response, status=404, error_type=_ERROR_TYPE_NOT_FOUND)

        assert body["instance"] == _category_url("no-such-category-anywhere")
        assert body["title"] == "Not Found"

    @pytest.mark.parametrize(
        "slug",
        [
            pytest.param("unknown%20slug", id="contains-a-space"),
            pytest.param("%2Fnope", id="contains-an-encoded-separator"),
            pytest.param("%E2%9C%93", id="contains-a-non-ascii-character"),
            pytest.param("x" * 300, id="far-longer-than-any-slug-can-be"),
        ],
    )
    async def test_detail_answers_404_rather_than_500_for_an_unrecognisable_slug(
        self,
        client: AsyncClient,
        slug: str,
    ) -> None:
        """A segment that could never be a slug is an honest absence, not a server failure.

        A slug is opaque text to this tier - a space, a non-ASCII character, an encoded separator
        or three hundred characters are all simply values that no row carries - so each answers
        ``404`` with the same document. What this rules out is a 500: an unhandled error here
        would leak an internal failure through a public, unauthenticated read, and would make the
        error contract non-uniform exactly where a caller is least able to interpret it.
        """
        response = await client.get(_category_url(slug))

        _assert_problem_document(response, status=404, error_type=_ERROR_TYPE_NOT_FOUND)

    async def test_detail_rejects_a_nul_character_in_the_slug_as_a_validation_failure(
        self,
        client: AsyncClient,
    ) -> None:
        """The one slug that is refused rather than looked up, still as the same document.

        ``CITEXT`` cannot represent U+0000, so ``StorableText`` refuses it in the request instead
        of letting the driver refuse it at the comparison - which would surface as a 500 on a
        public route. The refusal is a ``422`` whose ``errors`` list names the offending
        parameter, and the framework's own ``{"detail": [...]}`` validation body never reaches a
        caller: it is rendered as the same problem document as every other failure, which is the
        property this test protects.
        """
        response = await client.get(_category_url(_NUL_CHARACTER_SLUG))

        body = _assert_problem_document(
            response,
            status=422,
            error_type=_ERROR_TYPE_VALIDATION,
        )

        assert body["errors"], "a validation failure always names at least one offending member"
        assert any(item["field"] == "slug" for item in body["errors"]), (
            f"the offending parameter must be named: {body['errors']}"
        )


# ---------------------------------------------------------------------------------------
# Both routes are public, and neither is a write surface
# ---------------------------------------------------------------------------------------


class TestPublicReadAccess:
    """Neither route requires a credential, because the taxonomy is public information."""

    @pytest.mark.parametrize(
        "path",
        [_CATEGORIES_URL, _category_url(_SEEDED_CATEGORY_SLUG)],
    )
    async def test_route_answers_without_any_credential(
        self,
        client: AsyncClient,
        path: str,
    ) -> None:
        """An anonymous reader can render the filter control and open a category (R3).

        The ``client`` fixture sends no ``Authorization`` header at all, and the category router
        is included with no router-level ``dependencies``, so a 401 here would mean an
        authentication requirement had been introduced onto a surface the home page needs before
        a visitor has an account. The slug used is one revision ``0003`` guarantees exists, so
        this test needs no setup of its own.
        """
        response = await client.get(path)

        assert response.status_code == 200, (
            f"{path} is a public read and must not require a credential: {response.text}"
        )
        assert "WWW-Authenticate" not in response.headers, (
            "a public route must not challenge for credentials"
        )

    @pytest.mark.parametrize(
        "path",
        [_CATEGORIES_URL, _category_url(_SEEDED_CATEGORY_SLUG)],
    )
    async def test_route_ignores_an_unusable_bearer_token(
        self,
        client: AsyncClient,
        path: str,
    ) -> None:
        """An unparseable token neither grants nor denies anything on a public route.

        There is no security dependency on either handler, so the header is simply not consulted.
        Asserting it is what distinguishes "public" from "tolerant of anonymity but still parsing
        credentials": a route that rejected a malformed token would fail for a reader whose stored
        session had expired, turning a stale token into a broken home page.
        """
        response = await client.get(
            path,
            headers={"Authorization": "Bearer not-a-token.at-all.whatsoever"},
        )

        assert response.status_code == 200, (
            f"{path} must ignore an unusable token rather than reject it: {response.text}"
        )


class TestCategoryMutationSurfaceAbsent:
    """No write reaches the taxonomy through the public router - by construction, not by check."""

    @pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
    async def test_collection_refuses_every_mutating_method(
        self,
        client: AsyncClient,
        method: str,
    ) -> None:
        """``POST /api/v1/categories`` and friends are not routable here (R11).

        The taxonomy's whole write lifecycle is administrative and lives on
        ``POST``/``PATCH``/``DELETE /api/v1/admin/categories``, behind the ``require_admin`` gate
        that namespace applies at router level; ``test_admin_api.py`` covers it. A mutating route
        added to the *public* module would inherit no such gate - that router is included with no
        ``dependencies`` at all - so it would be an unauthenticated write path into the data every
        reader's filter is built from. This test is the regression guard for that, and it asserts
        the observed ``405`` with its ``Allow`` header rather than a hoped-for status: the path
        exists, only the method does not, and ``Allow`` is what tells a caller so.
        """
        response = await client.request(method, _CATEGORIES_URL, json={"name": "Not Allowed"})

        _assert_problem_document(
            response,
            status=405,
            error_type=_ERROR_TYPE_METHOD_NOT_ALLOWED,
        )
        assert response.headers.get("Allow") == "GET", (
            "a 405 must say which methods are allowed, and only GET is: "
            f"{response.headers.get('Allow')!r}"
        )

    @pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
    async def test_detail_refuses_every_mutating_method(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        method: str,
    ) -> None:
        """Renaming or deleting a term through the public path is not possible (R11).

        Same reasoning as the collection, asserted against a category that genuinely exists so
        the refusal cannot be mistaken for "no such row". A rename would be especially damaging
        here: the slug is written once at creation and never re-derived, because it is the
        canonical URL the SEO requirement rests on, and an unauthenticated writer able to reach
        it could invalidate every published link. The administrative equivalents are
        ``PATCH``/``DELETE /api/v1/admin/categories/{id}``, keyed by identifier rather than slug.
        """
        await create_category(
            db_session,
            name="Immutable Probe Category",
            slug="immutable-probe-category",
        )

        response = await client.request(
            method,
            _category_url("immutable-probe-category"),
            json={"name": "Renamed By Nobody"},
        )

        _assert_problem_document(
            response,
            status=405,
            error_type=_ERROR_TYPE_METHOD_NOT_ALLOWED,
        )
        assert response.headers.get("Allow") == "GET", (
            f"only GET is allowed on a category: {response.headers.get('Allow')!r}"
        )
