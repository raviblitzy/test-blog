"""Integration tests for the administrative namespace: ``/api/v1/admin``.

The HTTP surface of AAP requirement **R11** - "an admin dashboard for managing users, posts,
comments, and categories" - and the broadest module in the integration suite, because
``app.api.v1.routers.admin`` is the largest router in its folder and ``AdminService`` is the
only service that composes across every entity. Between them these tests discharge the AAP
§0.9.4.4 criterion **"Admin management"** and the administrator legs of **"Authorisation
negatives"**.

No user rules govern this file
------------------------------
``review_rules`` returns ``No user rules provided.`` - a complete response, not a truncated
window - so **no user-specified rule governs this file and no rule placed it in scope**. It is
in scope solely through the Agent Action Plan's file inventory (§0.4.4.5) and its execution
plan (§0.7.1.11). No rule is invented to fill the gap, and the absence of rules is not treated
as licence to lower the bar: the substitute standard is the AAP's own §0.10.1 enterprise
standards, three of which this module discharges directly.

* **§0.10.1 #6, secure-by-default authentication.** The standard requires least-privilege role
  checks *enforced server-side*, and the AAP is explicit that hiding a control in a client is
  not a security boundary. The 401 and 403 sweep in :class:`TestAdminAuthorisationGate` is
  therefore the **primary** content of this module rather than an appendix, and two of its
  cases go further than the status code by proving the refused write left the row untouched.
* **§0.10.1 #3, server-owned identity and database-enforced integrity.** Forcing a post to
  ``PUBLISHED`` must stamp ``published_at``, because ``ck_posts_published_at_required`` -
  ``CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL)`` - would otherwise reject the
  UPDATE; and every administrative delete must cascade in the database rather than in Python.
  Both are asserted, the cascades through ``db_session`` because a status code cannot see them.
* **§0.10.1 #8, blocking quality gates.** No ``skip``, no ``xfail``, no placeholder and nothing
  order-dependent. Every test states its own preconditions and the per-test rollback in
  ``conftest.py`` is the only cleanup mechanism.

Why the authorisation sweep is parametrised
-------------------------------------------
``app.api.v1.router`` attaches the administrator gate **exactly once**, as
``dependencies=[Depends(require_admin)]`` on the ``admin`` ``include_router`` call.
``app.api.v1.routers.admin`` declares no authorisation at all - it constructs a bare
``APIRouter()`` specifically so the gate can live on the include. That placement is what
guarantees **no individual route can omit the gate**, including one added months from now by
someone who never reads this file.

A test that checked only ``GET /admin/stats`` would verify almost nothing about that design. So
:data:`ADMIN_ROUTES` enumerates every one of the **fourteen** operations in the namespace, and
three parametrised tests drive the whole list: refused for a ``READER``, refused for an
``AUTHOR``, refused unauthenticated. Adding a future administrative route is then a one-line
change to that tuple, which is what makes the sweep an enforcement mechanism rather than a
sample of one.

Note that the namespace carries fourteen operations, not thirteen: ``GET /admin/categories``
returns a ``Page[CategoryPublic]`` alongside the three category mutations, so the
administrative taxonomy screen can page and search where the public bare-array listing cannot.

Where the gate sits in the dependency order, and why it changes the negatives
----------------------------------------------------------------------------
``require_admin`` resolves **before** path and query parsing, because FastAPI resolves the
router-level dependency list ahead of the endpoint's own parameters. Two consequences shape the
tests below and are easy to get backwards:

* a malformed UUID sent by a ``READER`` answers **403**, not 422 - the gate refuses the caller
  before anything tries to parse the path;
* ``?page=0`` sent anonymously answers **401**, not 422, for the same reason.

Every test that means to assert a 422 on a path or query value therefore sends it as an
administrator. That is not a workaround; it is the only way to reach the validator at all.

Isolating rows from the baseline the database already holds
----------------------------------------------------------
Two facts about the fixture database make naive listing assertions unreliable, and both are
load-bearing here.

**The database is never empty.** Revision ``0003_seed_reference_categories`` commits eight
reference categories as *data*, and ``conftest.py`` builds the schema by running Alembic to
head, so those rows are present before the first test and survive every rollback. A fixture
database may additionally carry rows committed by earlier work. Every count assertion in this
module is therefore a **relative delta** ("increased by exactly one") or a lower bound ("at
least"), never an absolute total - which is also what AAP §0.9.4.4 asks for.

**A new draft does not land on page one.** ``AdminService.list_posts`` orders by
``published_at DESC NULLS LAST`` and then ``posts.id DESC``, so a freshly created ``DRAFT`` -
which has no ``published_at`` - sorts *after* every published post in the table. With a
populated fixture database it is nowhere near the first page. So each listing test narrows the
query to its own rows using the filter the router already declares: ``author_id`` for posts,
``post_id`` for comments, ``q`` for users and categories. That is both the robust way to
assert and a second, incidental proof that the filters work.

Boundaries
----------
Behaviour is driven exclusively over HTTP through the fixture clients; no test constructs
``AdminService``, ``CategoryService``, ``CommentService`` or a repository to make a behavioural
assertion. ``db_session`` is read only to observe **database-level** effects a response body
cannot show - a cascaded row, a column left untouched by a refused write - which §0.10.1 #3
requires be proven rather than assumed.

This module does not re-prove what its siblings own: ``test_posts_api.py`` owns the post
cascade in depth, ``test_comments_api.py`` the threading, ``test_categories_api.py`` the public
taxonomy reads, and ``tests/unit/test_permissions.py`` the role predicates. Where a behaviour
is only reachable over HTTP *through this namespace* - a category rename keeping its slug, an
in-use category refusing deletion - it is proven here, because there is nowhere else to prove
it.

One ORM hazard is worth stating because it is silent when you get it wrong: an identifier read
off a mapped instance **after** a request has committed can trigger a lazy load, and under an
async session that raises ``MissingGreenlet`` rather than returning a value. Every test below
copies the identifiers it needs into locals before issuing the request that mutates them.
"""

from __future__ import annotations

import math
import re
import uuid
from collections.abc import Callable
from datetime import datetime
from http import HTTPStatus
from typing import Any, Final

import pytest
from httpx import AsyncClient
from sqlalchemy import ColumnElement, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Category,
    Comment,
    CommentStatus,
    Post,
    PostLike,
    PostStatus,
    RefreshToken,
    User,
    UserRole,
)
from tests import factories

#: Every test here drives the API in-process against PostgreSQL, which is exactly what the
#: ``integration`` marker registered in ``backend/pyproject.toml`` describes. Declared once for
#: the module rather than per test. It does not interfere with the ``asyncio`` marker
#: ``conftest.pytest_collection_modifyitems`` applies, because that hook keys on the absence of
#: an ``asyncio`` marker specifically and adds its own regardless of what else is present.
pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------------------
# The route matrix the authorisation sweep is driven from
# ---------------------------------------------------------------------------------------

ADMIN_PREFIX: Final[str] = "/api/v1/admin"
"""The one prefix every operation below shares, applied by ``app.api.v1.router``."""

_SWEEP_ID: Final[str] = "00000000-0000-0000-0000-0000000000ff"
"""A syntactically valid UUID that addresses nothing.

The sweep never reaches a handler - the gate refuses first - so the identifier only has to
parse, and it deliberately matches no row so that a hypothetical regression which let a request
through would fail on a 404 rather than mutate real data.
"""

ADMIN_ROUTES: Final[tuple[tuple[str, str, dict[str, Any] | None], ...]] = (
    ("GET", f"{ADMIN_PREFIX}/stats", None),
    ("GET", f"{ADMIN_PREFIX}/users", None),
    ("PATCH", f"{ADMIN_PREFIX}/users/{_SWEEP_ID}", {"role": UserRole.ADMIN.value}),
    ("DELETE", f"{ADMIN_PREFIX}/users/{_SWEEP_ID}", None),
    ("GET", f"{ADMIN_PREFIX}/posts", None),
    (
        "PATCH",
        f"{ADMIN_PREFIX}/posts/{_SWEEP_ID}/status",
        {"status": PostStatus.PUBLISHED.value},
    ),
    ("DELETE", f"{ADMIN_PREFIX}/posts/{_SWEEP_ID}", None),
    ("GET", f"{ADMIN_PREFIX}/comments", None),
    (
        "PATCH",
        f"{ADMIN_PREFIX}/comments/{_SWEEP_ID}/status",
        {"status": CommentStatus.APPROVED.value},
    ),
    ("DELETE", f"{ADMIN_PREFIX}/comments/{_SWEEP_ID}", None),
    ("GET", f"{ADMIN_PREFIX}/categories", None),
    ("POST", f"{ADMIN_PREFIX}/categories", {"name": "Authorisation Sweep Category"}),
    ("PATCH", f"{ADMIN_PREFIX}/categories/{_SWEEP_ID}", {"name": "Authorisation Sweep Renamed"}),
    ("DELETE", f"{ADMIN_PREFIX}/categories/{_SWEEP_ID}", None),
)
"""Every operation in the administrative namespace, as ``(method, path, body)``.

All fourteen, spanning the four entity families the prompt names - users, posts, comments and
categories - plus the overview, and covering reads and writes in every family. The gate is
attached to the *include*, so a route missing from this tuple is a gate nobody tests; keeping
the list exhaustive is the whole point, and adding to it is one line.
"""

#: Human-readable parametrisation identifiers, so a failure names the operation that failed
#: rather than a positional index. The placeholder identifier is collapsed to ``{id}`` because
#: forty characters of zeroes in a test name obscures the method and path that matter.
ADMIN_ROUTE_IDS: Final[tuple[str, ...]] = tuple(
    f"{method} {path.replace(_SWEEP_ID, '{id}').removeprefix(ADMIN_PREFIX)}"
    for method, path, _ in ADMIN_ROUTES
)

#: The media type every error in this service is served as. Declared by
#: ``app.core.exceptions``, and asserted alongside the body so a regression that returned a
#: correctly shaped document under ``application/json`` is still caught.
PROBLEM_MEDIA_TYPE: Final[str] = "application/problem+json"

#: The members of the problem document ``app.core.exceptions`` always populates.
#: ``errors`` is deliberately absent - it appears only on a validation failure.
PROBLEM_REQUIRED_FIELDS: Final[tuple[str, ...]] = (
    "type",
    "title",
    "status",
    "detail",
    "instance",
    "request_id",
)

#: The fields ``Page`` declares, asserted as a set on every collection response so a missing
#: envelope member fails loudly instead of being skipped by a test that only reads ``items``.
PAGE_FIELDS: Final[frozenset[str]] = frozenset({"items", "total", "page", "page_size", "pages"})

#: Revision ``0003_seed_reference_categories`` commits this many rows as data. Used as a lower
#: bound rather than an equality, because the fixture database may hold more.
REFERENCE_CATEGORY_COUNT: Final[int] = 8

#: Matches any OpenAPI path parameter, so a served path template can be reduced to the same
#: shape as a sweep entry. Used only by the completeness check at the end of the gate class.
_PATH_PARAMETER: Final[re.Pattern[str]] = re.compile(r"\{[^}]+\}")

#: The single token both sides of that comparison collapse their identifiers to.
_PATH_TOKEN: Final[str] = "{id}"


# ---------------------------------------------------------------------------------------
# Assertion helpers
#
# Plain functions rather than fixtures: none of them needs setup, teardown or the request
# object, and a helper that is merely called reads better at the call site than one that has to
# be declared in every signature that wants it.
# ---------------------------------------------------------------------------------------


def assert_problem_document(payload: Any, expected_status: HTTPStatus | int) -> None:
    """Assert ``payload`` is the single problem document shape, carrying ``expected_status``.

    AAP §0.9.4.3 requires every error in the service to be the same machine-readable document,
    which is what replaced the three duplicated ad-hoc ``404`` raises the previous contract
    repeated per call site. Checking the ``status`` member against the HTTP status as well as
    the status line is the part that matters: a body that disagrees with its own response code
    is unusable to a client that reads either one.

    Args:
        payload: The decoded response body.
        expected_status: The status the document must report.
    """
    assert isinstance(payload, dict), f"expected a problem document, got {type(payload)!r}"
    missing = [field for field in PROBLEM_REQUIRED_FIELDS if field not in payload]
    assert not missing, f"problem document is missing {missing}: {payload}"
    assert payload["status"] == int(expected_status)
    # Each member is checked in two statements rather than one `and`, so a failure report names
    # which half was wrong - the type or the emptiness - instead of only that the pair failed.
    for member in ("type", "title", "detail", "instance"):
        assert isinstance(payload[member], str), f"{member} should be a string: {payload}"
        assert payload[member], f"{member} should not be empty: {payload}"


def assert_validation_problem(payload: Any, *, field: str) -> None:
    """Assert ``payload`` is a 422 problem document whose ``errors`` names ``field``.

    A validation failure is the one case that carries an ``errors`` list, and asserting the
    list is populated - and names the member actually at fault - is what distinguishes a
    genuinely rejected request from one that happened to answer 422 for another reason.

    Args:
        payload: The decoded response body.
        field: The member the document must report as invalid.
    """
    assert_problem_document(payload, HTTPStatus.UNPROCESSABLE_CONTENT)
    errors = payload.get("errors")
    assert errors, f"a validation problem must carry a populated `errors` list: {payload}"
    fields = [entry["field"] for entry in errors]
    assert field in fields, f"expected `{field}` among the reported fields, got {fields}"


def assert_page_envelope(payload: Any) -> list[dict[str, Any]]:
    """Assert ``payload`` is the uniform page envelope and return its items.

    AAP §0.9.4.3 requires every collection in the service to answer with ``items``, ``total``,
    ``page``, ``page_size`` and ``pages``, so one client-side pagination control can serve the
    feed, a profile listing and each administrative table. ``pages`` is recomputed here rather
    than trusted: it is the member a client uses to decide whether a next page exists, so an
    off-by-one in it is a defect a caller sees directly.

    Args:
        payload: The decoded response body.

    Returns:
        The envelope's ``items`` list.
    """
    assert isinstance(payload, dict), f"expected a page envelope, got {type(payload)!r}"
    missing = PAGE_FIELDS - payload.keys()
    assert not missing, f"envelope is missing {sorted(missing)}: {sorted(payload)}"
    total, page_size = payload["total"], payload["page_size"]
    assert isinstance(total, int)
    assert total >= 0
    assert isinstance(page_size, int)
    assert page_size >= 1
    assert isinstance(payload["page"], int)
    assert payload["page"] >= 1
    # `ceil` covers the empty case without a branch: an empty result set reports no pages at
    # all rather than one empty page, and `ceil(0 / page_size)` is already 0.
    assert payload["pages"] == math.ceil(total / page_size)
    items = payload["items"]
    assert isinstance(items, list)
    assert len(items) <= page_size
    return items


def assert_admin_user_shape(item: dict[str, Any]) -> None:
    """Assert ``item`` is an ``AdminUser`` projection: privileged fields in, secret out.

    The administrative projection is the only one that exposes ``email``, ``role`` and
    ``is_active`` - ``UserPublic`` withholds all three - and it still withholds
    ``password_hash``. That single omission is the assertion worth making: the field list is
    enforced in exactly one place, and this is the test that notices if a hand-built payload
    ever reintroduces the hash.

    Args:
        item: One element of ``Page[AdminUser]``, or the body of a user PATCH.
    """
    assert item.keys() == {
        "id",
        "email",
        "username",
        "display_name",
        "role",
        "is_active",
        "created_at",
        "updated_at",
    }, f"unexpected AdminUser field set: {sorted(item)}"
    assert "password_hash" not in item
    assert item["role"] in {member.value for member in UserRole}
    assert isinstance(item["is_active"], bool)


def assert_user_public_shape(author: Any) -> None:
    """Assert an embedded ``author`` is a ``UserPublic`` projection even inside an admin body.

    ``AdminPost`` and ``AdminComment`` both embed the byline, and both embed the *public*
    projection: an administrative response widens what is shown about the entity being managed,
    never about a third party incidentally attached to it. So ``email``, ``role``,
    ``is_active`` and ``password_hash`` are all absent here even though the caller holds
    ``ADMIN``.

    Args:
        author: The ``author`` member of an ``AdminPost`` or ``AdminComment``.
    """
    assert isinstance(author, dict), f"expected an embedded author object, got {author!r}"
    assert author.keys() == {
        "id",
        "username",
        "display_name",
        "bio",
        "avatar_url",
        "created_at",
    }, f"unexpected UserPublic field set: {sorted(author)}"
    for withheld in ("email", "role", "is_active", "password_hash"):
        assert withheld not in author


def assert_admin_post_shape(item: dict[str, Any]) -> None:
    """Assert ``item`` is an ``AdminPost`` projection with a public byline.

    Args:
        item: One element of ``Page[AdminPost]``, or the body of a status change.
    """
    assert item.keys() == {
        "id",
        "title",
        "slug",
        "status",
        "published_at",
        "view_count",
        "author",
        "created_at",
        "updated_at",
    }, f"unexpected AdminPost field set: {sorted(item)}"
    assert item["status"] in {member.value for member in PostStatus}
    assert isinstance(item["view_count"], int)
    assert_user_public_shape(item["author"])


def assert_admin_comment_shape(item: dict[str, Any]) -> None:
    """Assert ``item`` is an ``AdminComment`` projection with a public byline.

    ``parent_id`` is part of the shape rather than an optional extra: the moderation queue has
    to show an operator whether they are reading a top-level comment or a reply, and the
    administrative projection deliberately carries no nested ``replies`` array - the queue is a
    flat list, unlike the public thread.

    Args:
        item: One element of ``Page[AdminComment]``, or the body of a moderation change.
    """
    assert item.keys() == {
        "id",
        "post_id",
        "parent_id",
        "author",
        "body",
        "status",
        "created_at",
        "updated_at",
    }, f"unexpected AdminComment field set: {sorted(item)}"
    assert item["status"] in {member.value for member in CommentStatus}
    assert_user_public_shape(item["author"])


def assert_category_public_shape(item: dict[str, Any]) -> None:
    """Assert ``item`` is a ``CategoryPublic`` projection.

    The administrative category routes reuse the *public* model rather than declaring an
    administrative twin, so the management screen and the home-page filter agree on what a
    category is down to the meaning of ``post_count``.

    Args:
        item: A category from any administrative or public category response.
    """
    assert item.keys() == {
        "id",
        "name",
        "slug",
        "description",
        "post_count",
        "created_at",
    }, f"unexpected CategoryPublic field set: {sorted(item)}"
    assert isinstance(item["post_count"], int)
    assert item["post_count"] >= 0


async def count_rows(session: AsyncSession, predicate: ColumnElement[bool], entity: Any) -> int:
    """Count rows of ``entity`` matching ``predicate``, through a fresh aggregate.

    Used only to observe database-level effects a response body cannot show: whether a cascade
    removed a dependent row, or whether a refused write left one alone. A ``SELECT count(*)``
    is deliberately chosen over reading a mapped instance - it consults no identity map, so it
    reports what the database holds rather than what the session remembers, and it cannot
    trigger the lazy load that would raise ``MissingGreenlet`` on an expired attribute.

    Args:
        session: The test's session, which the request handlers share.
        predicate: The ``WHERE`` clause selecting the rows of interest.
        entity: The mapped class to count.

    Returns:
        The number of matching rows.
    """
    statement = select(func.count()).select_from(entity).where(predicate)
    return int((await session.execute(statement)).scalar_one())


def parse_instant(raw: Any) -> datetime:
    """Parse a serialised instant and assert it is timezone-aware.

    Every ``timestamptz`` in this API is serialised with an explicit offset, and awareness is
    the property worth asserting rather than the exact text: a naive instant is ambiguous the
    moment it crosses a process boundary, and ``published_at`` in particular is the value the
    database's publication ``CHECK`` and the sitemap's ``lastmod`` both depend on.

    Args:
        raw: The serialised value from a response body.

    Returns:
        The parsed, timezone-aware instant.
    """
    assert isinstance(raw, str), f"expected a serialised instant, got {raw!r}"
    parsed = datetime.fromisoformat(raw)
    assert parsed.tzinfo is not None, f"instant {raw!r} is not timezone-aware"
    assert parsed.utcoffset() is not None
    return parsed


# ---------------------------------------------------------------------------------------
# Phase A - the router-level administrator gate
# ---------------------------------------------------------------------------------------


class TestAdminAuthorisationGate:
    """The administrator gate, swept across every operation in the namespace.

    ``app.api.v1.router`` applies ``require_admin`` **once**, as
    ``dependencies=[Depends(require_admin)]`` on the ``admin`` ``include_router`` call, and
    ``app.api.v1.routers.admin`` deliberately declares no authorisation of its own. That single
    attachment is precisely what guarantees no individual route can omit the gate - including a
    route added long after this file was written.

    These tests verify that design rather than assuming it. Driving the whole of
    :data:`ADMIN_ROUTES` is the point: a per-route decorator would hold only for as long as
    every future author remembered it, and the one route that forgot would be an
    unauthenticated administrative endpoint that no test asked about because no test knew it
    existed. Parametrising means the sweep grows with the namespace instead of rotting.

    Both non-administrator roles are exercised, not one. ``READER`` and ``AUTHOR`` are refused
    for the same reason but by different data, and a bug that compared against the wrong member
    could easily admit one while refusing the other.
    """

    @pytest.mark.parametrize(("method", "path", "body"), ADMIN_ROUTES, ids=ADMIN_ROUTE_IDS)
    async def test_reader_is_refused_on_every_operation(
        self,
        client: AsyncClient,
        reader_user: User,
        auth_headers_for: Callable[[User], dict[str, str]],
        method: str,
        path: str,
        body: dict[str, Any] | None,
    ) -> None:
        """A signed-in ``READER`` is refused with 403 on every administrative operation.

        AAP §0.9.4.4 "Authorisation negatives" names ``GET /api/v1/admin/stats`` explicitly;
        this covers that case and thirteen more. 403 rather than 404 is deliberate on the
        service's part - the namespace is documented, so hiding its existence buys nothing - and
        403 rather than 401 because the credential presented is perfectly good.
        """
        response = await client.request(
            method, path, json=body, headers=auth_headers_for(reader_user)
        )

        assert response.status_code == HTTPStatus.FORBIDDEN
        assert response.headers["content-type"].startswith(PROBLEM_MEDIA_TYPE)
        assert_problem_document(response.json(), HTTPStatus.FORBIDDEN)

    @pytest.mark.parametrize(("method", "path", "body"), ADMIN_ROUTES, ids=ADMIN_ROUTE_IDS)
    async def test_author_is_refused_on_every_operation(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Callable[[User], dict[str, str]],
        method: str,
        path: str,
        body: dict[str, Any] | None,
    ) -> None:
        """A signed-in ``AUTHOR`` is refused with 403 on every administrative operation.

        Authoring is not administration. An ``AUTHOR`` may create, edit, publish and delete
        their **own** posts, and none of that authority reaches this namespace - which is the
        distinction AAP §0.10.1 #6 calls least privilege, enforced server-side.
        """
        response = await client.request(
            method, path, json=body, headers=auth_headers_for(author_user)
        )

        assert response.status_code == HTTPStatus.FORBIDDEN
        assert_problem_document(response.json(), HTTPStatus.FORBIDDEN)

    @pytest.mark.parametrize(("method", "path", "body"), ADMIN_ROUTES, ids=ADMIN_ROUTE_IDS)
    async def test_anonymous_caller_is_challenged_on_every_operation(
        self,
        client: AsyncClient,
        method: str,
        path: str,
        body: dict[str, Any] | None,
    ) -> None:
        """An unauthenticated caller gets 401 and a ``WWW-Authenticate: Bearer`` challenge.

        The header is the half a client actually needs: without it, browser code cannot tell
        "no credential was sent" from "the credential was rejected", so it cannot decide whether
        to prompt for a login or to refresh a token. ``app.core.exceptions`` attaches it to
        every ``UnauthorizedError`` and names it in the CORS ``expose_headers`` list so
        cross-origin script can read it.
        """
        response = await client.request(method, path, json=body)

        assert response.status_code == HTTPStatus.UNAUTHORIZED
        assert response.headers["www-authenticate"] == "Bearer"
        assert_problem_document(response.json(), HTTPStatus.UNAUTHORIZED)

    async def test_refused_role_change_leaves_the_account_untouched(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        reader_user: User,
        auth_headers_for: Callable[[User], dict[str, str]],
    ) -> None:
        """A 403 on ``PATCH /admin/users/{id}`` writes nothing - the row is genuinely unchanged.

        A status code alone does not prove the write did not happen; it proves only what the
        service chose to report. AAP §0.10.1 #6 is a claim about *effect*, so the effect is what
        is asserted, read back from the database rather than from a response body the refused
        request never produced.
        """
        victim = await factories.create_author(db_session)
        victim_id, original_role, original_active = victim.id, victim.role, victim.is_active

        response = await client.patch(
            f"{ADMIN_PREFIX}/users/{victim_id}",
            json={"role": UserRole.ADMIN.value, "is_active": False},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == HTTPStatus.FORBIDDEN
        stored = (
            await db_session.execute(select(User.role, User.is_active).where(User.id == victim_id))
        ).one()
        assert stored.role is original_role
        assert stored.is_active is original_active

    async def test_refused_status_change_leaves_the_post_unpublished(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: Callable[[User], dict[str, str]],
    ) -> None:
        """A 403 on the post status route leaves the draft a draft, with no publication instant.

        The companion effect assertion to the one above, on the write whose consequences are
        most visible: a post that slipped through to ``PUBLISHED`` would appear in the public
        feed, in the sitemap and in every category filter.
        """
        draft = await factories.create_post(db_session, author=author_user, status=PostStatus.DRAFT)
        draft_id = draft.id

        response = await client.patch(
            f"{ADMIN_PREFIX}/posts/{draft_id}/status",
            json={"status": PostStatus.PUBLISHED.value},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == HTTPStatus.FORBIDDEN
        stored = (
            await db_session.execute(
                select(Post.status, Post.published_at).where(Post.id == draft_id)
            )
        ).one()
        assert stored.status is PostStatus.DRAFT
        assert stored.published_at is None

    async def test_refused_category_creation_writes_no_row(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        auth_headers_for: Callable[[User], dict[str, str]],
    ) -> None:
        """A 403 on ``POST /admin/categories`` creates nothing, so the taxonomy is unchanged.

        The refused *creation* case, which the two tests above cannot cover: a refused update
        can be checked by re-reading a known row, but a refused insert has to be checked by
        proving no row with that name exists at all.
        """
        name = "Refused Sweep Taxonomy"

        response = await client.post(
            f"{ADMIN_PREFIX}/categories",
            json={"name": name, "description": "Never created."},
            headers=auth_headers_for(author_user),
        )

        assert response.status_code == HTTPStatus.FORBIDDEN
        assert await count_rows(db_session, Category.name == name, Category) == 0

    async def test_a_deactivated_administrator_is_refused(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        auth_headers_for: Callable[[User], dict[str, str]],
    ) -> None:
        """An ``ADMIN`` whose account is deactivated is refused, holding the role notwithstanding.

        ``require_admin`` resolves through ``get_current_active_user``, so activity is checked
        before authority. The role on its own is not a key: suspending an administrator has to
        take effect immediately, and it does so without revoking the token they already hold.
        """
        suspended = await factories.create_admin(db_session, is_active=False)

        response = await client.get(f"{ADMIN_PREFIX}/stats", headers=auth_headers_for(suspended))

        assert response.status_code == HTTPStatus.FORBIDDEN
        assert_problem_document(response.json(), HTTPStatus.FORBIDDEN)

    async def test_a_malformed_token_is_challenged(self, client: AsyncClient) -> None:
        """A syntactically invalid bearer token yields 401, not 403 and not 500.

        The distinction matters to a client: 401 with the challenge header means "re-authenticate",
        while 403 would mean "your credential is fine but insufficient" and would send a caller
        holding a corrupt token down a path that can never succeed.
        """
        response = await client.get(
            f"{ADMIN_PREFIX}/stats", headers={"Authorization": "Bearer not-a-json-web-token"}
        )

        assert response.status_code == HTTPStatus.UNAUTHORIZED
        assert response.headers["www-authenticate"] == "Bearer"
        assert_problem_document(response.json(), HTTPStatus.UNAUTHORIZED)

    async def test_the_sweep_covers_every_mounted_administrative_operation(
        self, client: AsyncClient
    ) -> None:
        """:data:`ADMIN_ROUTES` is exhaustive - no mounted admin operation escapes the sweep.

        The sweep's value depends entirely on its completeness, and a hand-maintained list is
        exactly the kind of thing that falls behind the code it describes. So the list is checked
        against the served OpenAPI document: a route added under ``/api/v1/admin`` without a
        matching entry here fails *this* test, which is a clear instruction to extend the tuple,
        rather than silently going untested.
        """
        document = (await client.get("/openapi.json")).json()
        # Both sides are reduced to the same shape before comparison: the document spells its
        # path parameters `{user_id}`, `{post_id}`, `{comment_id}` and `{category_id}`, while the
        # sweep carries a concrete identifier. Collapsing every parameter - and the sweep's
        # placeholder - to one token compares route *structure*, which is what completeness means
        # here, without this test having to know each family's parameter name.
        mounted = {
            (method.upper(), _PATH_PARAMETER.sub(_PATH_TOKEN, path))
            for path, operations in document["paths"].items()
            if path.startswith(ADMIN_PREFIX)
            for method in operations
        }
        swept = {(method, path.replace(_SWEEP_ID, _PATH_TOKEN)) for method, path, _ in ADMIN_ROUTES}

        assert mounted == swept, (
            f"unswept operations: {sorted(mounted - swept)}; "
            f"stale sweep entries: {sorted(swept - mounted)}"
        )


# ---------------------------------------------------------------------------------------
# Phase B - the overview counts
# ---------------------------------------------------------------------------------------


class TestAdminStats:
    """``GET /api/v1/admin/stats``: the four aggregates behind the overview screen.

    ``AdminService.get_stats`` is built from the repositories' dedicated ``count_*`` methods -
    four aggregates, not four listings - so the overview is cheap regardless of how large the
    relations grow. That design also fixes what the numbers mean: every ``count_*`` here is
    called with no status narrowing, so each figure spans its whole relation.

    Every assertion below is a **relative delta** or a lower bound. Absolute totals are not
    available to assert against: revision ``0003`` commits eight reference categories as data,
    the identity fixtures create accounts of their own, and a fixture database may carry rows
    committed by earlier work. AAP §0.9.4.4 asks for relative comparisons for exactly this
    reason.
    """

    async def test_returns_four_non_negative_counts(self, admin_client: AsyncClient) -> None:
        """An administrator reads the overview: 200, and an ``AdminStats`` body of four counts."""
        response = await admin_client.get(f"{ADMIN_PREFIX}/stats")

        assert response.status_code == HTTPStatus.OK
        payload = response.json()
        assert payload.keys() == {
            "user_count",
            "post_count",
            "comment_count",
            "category_count",
        }, f"unexpected AdminStats field set: {sorted(payload)}"
        for field, value in payload.items():
            assert isinstance(value, int), f"{field} should be an integer, got {value!r}"
            assert not isinstance(value, bool), f"{field} should be an integer, not a bool"
            assert value >= 0, f"{field} should never be negative, got {value}"

    async def test_every_count_rises_by_exactly_one_for_one_new_row(
        self,
        admin_client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
    ) -> None:
        """Creating one row of each kind moves each corresponding count by exactly one.

        The strongest available statement about four figures whose absolute values are not
        knowable: each is read before and after, and each delta is asserted independently, so a
        count wired to the wrong relation - ``comment_count`` reading posts, say - fails here even
        though every figure would still look plausible on its own.
        """
        before = (await admin_client.get(f"{ADMIN_PREFIX}/stats")).json()

        new_author = await factories.create_author(db_session)
        category = await factories.create_category(db_session)
        post = await factories.create_published_post(db_session, author=new_author)
        await factories.create_comment(db_session, post=post, author=author_user)

        after = (await admin_client.get(f"{ADMIN_PREFIX}/stats")).json()

        assert after["user_count"] == before["user_count"] + 1
        assert after["post_count"] == before["post_count"] + 1
        assert after["comment_count"] == before["comment_count"] + 1
        assert after["category_count"] == before["category_count"] + 1
        assert category.id is not None

    async def test_post_count_includes_drafts_and_archived_posts(
        self,
        admin_client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
    ) -> None:
        """``post_count`` spans every lifecycle state, not just the published ones.

        ``PostRepository.count_posts`` defaults to ``statuses=None``, and the service calls it
        with no argument, so the figure is the whole relation. That is the right number for an
        administrative overview - an operator wants to know how much content exists, including
        the drafts and the archive - and it is deliberately *not* the number the public feed
        would report.
        """
        before = (await admin_client.get(f"{ADMIN_PREFIX}/stats")).json()["post_count"]

        await factories.create_post(db_session, author=author_user, status=PostStatus.DRAFT)
        await factories.create_post(db_session, author=author_user, status=PostStatus.ARCHIVED)

        after = (await admin_client.get(f"{ADMIN_PREFIX}/stats")).json()["post_count"]

        assert after == before + 2

    async def test_comment_count_spans_every_moderation_state(
        self,
        admin_client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """``comment_count`` counts pending and rejected comments as well as approved ones.

        The counterpart to the draft case, and the same reasoning: ``count_comments`` is called
        with no status narrowing, so the overview reports what exists rather than what a reader
        would see. A queue an operator cannot see the size of is a queue they cannot plan around.
        """
        post = await factories.create_published_post(db_session, author=author_user)
        before = (await admin_client.get(f"{ADMIN_PREFIX}/stats")).json()["comment_count"]

        for state in CommentStatus:
            await factories.create_comment(db_session, post=post, author=reader_user, status=state)

        after = (await admin_client.get(f"{ADMIN_PREFIX}/stats")).json()["comment_count"]

        assert after == before + len(CommentStatus)

    async def test_category_count_covers_the_seeded_reference_taxonomy(
        self, admin_client: AsyncClient
    ) -> None:
        """``category_count`` is at least the reference set revision ``0003`` commits as data.

        Stated as a lower bound rather than an equality on purpose. The eight reference
        categories are committed by the migration, so they survive every per-test rollback and
        are guaranteed present; anything beyond them is whatever the fixture database happens to
        hold, which no test may assume either way.
        """
        response = await admin_client.get(f"{ADMIN_PREFIX}/stats")

        assert response.json()["category_count"] >= REFERENCE_CATEGORY_COUNT

    async def test_deleting_a_user_lowers_the_user_count(
        self, admin_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The counts fall as well as rise, so they are read rather than accumulated.

        A figure that only ever increases would be indistinguishable from a running total kept
        somewhere on the write path. Asserting the decrease is what shows each call re-reads the
        relation.
        """
        victim = await factories.create_author(db_session)
        victim_id = victim.id
        before = (await admin_client.get(f"{ADMIN_PREFIX}/stats")).json()["user_count"]

        deletion = await admin_client.delete(f"{ADMIN_PREFIX}/users/{victim_id}")

        assert deletion.status_code == HTTPStatus.NO_CONTENT
        after = (await admin_client.get(f"{ADMIN_PREFIX}/stats")).json()["user_count"]
        assert after == before - 1


# ---------------------------------------------------------------------------------------
# Phase C - managing accounts
# ---------------------------------------------------------------------------------------


class TestAdminUsers:
    """Managing accounts: listing, role and activity changes, deletion, and the lockout guards.

    The one family where the *effect* of a change is itself an authorisation decision, so the
    tests here do not stop at the response body. A role change is proven by the target's access
    changing, and a deactivation by their profile disappearing and their login being refused -
    which is far stronger evidence than a field having a new value, and is what AAP §0.9.4.4
    means by "an administrator can change a user's role and active state".

    ``require_admin`` compares the role on the **loaded row**, never the ``role`` claim in the
    presented token. That is why a promotion takes effect for a token minted before it, and why a
    demotion takes effect immediately for a token minted before that - both asserted below.
    """

    @staticmethod
    def _handle(marker: str) -> tuple[str, str]:
        """Build a matching ``(username, email)`` pair around a distinctive marker.

        Listing assertions narrow with the ``q`` filter, which matches username and email, so a
        test's accounts need a handle no other row can share. The generated pair is derived from
        one marker so a single ``q`` value finds exactly the accounts the test created.

        Args:
            marker: A lowercase, unique-per-test discriminator.

        Returns:
            The username and the email address to create the account with.
        """
        return marker, f"{marker}@example.com"

    async def test_listing_returns_the_page_envelope(self, admin_client: AsyncClient) -> None:
        """``GET /admin/users`` answers 200 with the uniform envelope and ``AdminUser`` items."""
        response = await admin_client.get(f"{ADMIN_PREFIX}/users")

        assert response.status_code == HTTPStatus.OK
        items = assert_page_envelope(response.json())
        assert items, "the identity fixtures guarantee at least one account exists"
        for item in items:
            assert_admin_user_shape(item)

    async def test_listing_exposes_privileged_fields_but_never_the_password_hash(
        self, admin_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The projection widens to ``email``, ``role`` and ``is_active`` - and stops there.

        ``UserPublic`` withholds all three, so this listing is the only place they are readable;
        ``password_hash`` is the one column the privileged projection still withholds, and its
        absence is the assertion that matters. Standard §0.10.1 #6: a hash that reached a response
        would be offline-crackable however good the argon2id parameters are.
        """
        marker = "adminuserprojection"
        username, email = self._handle(marker)
        await factories.create_user(
            db_session, username=username, email=email, role=UserRole.AUTHOR
        )

        response = await admin_client.get(f"{ADMIN_PREFIX}/users", params={"q": marker})

        items = assert_page_envelope(response.json())
        assert len(items) == 1
        found = items[0]
        assert_admin_user_shape(found)
        assert found["email"] == email
        assert found["username"] == username
        assert found["role"] == UserRole.AUTHOR.value
        assert found["is_active"] is True
        assert "password_hash" not in found

    async def test_pagination_windows_are_disjoint_and_complete(
        self, admin_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """Page two is disjoint from page one, and the two together cover the result set.

        The classic overlapping-pagination defect is invisible to a test that reads only one
        page: with a non-unique sort key, a row can appear on both pages while another appears on
        neither. ``UserRepository`` breaks every remaining tie on ``users.id`` for exactly that
        reason, and this is the assertion that notices if the tiebreaker is ever dropped.
        """
        marker = "adminuserpaging"
        created = {
            str(
                (
                    await factories.create_user(
                        db_session,
                        username=f"{marker}{index}",
                        email=f"{marker}{index}@example.com",
                    )
                ).id
            )
            for index in range(4)
        }

        first = assert_page_envelope(
            (
                await admin_client.get(
                    f"{ADMIN_PREFIX}/users", params={"q": marker, "page": 1, "page_size": 2}
                )
            ).json()
        )
        second = assert_page_envelope(
            (
                await admin_client.get(
                    f"{ADMIN_PREFIX}/users", params={"q": marker, "page": 2, "page_size": 2}
                )
            ).json()
        )

        first_ids = {item["id"] for item in first}
        second_ids = {item["id"] for item in second}
        assert len(first_ids) == len(second_ids) == 2
        assert not first_ids & second_ids
        assert first_ids | second_ids == created

    async def test_page_count_is_derived_from_the_total_and_the_window(
        self, admin_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """``pages`` rounds up, so a partly filled last page is still counted.

        Three rows in windows of two is two pages, not one. ``pages`` is what a client uses to
        decide whether a next page exists, so rounding down would hide the final row entirely.
        """
        marker = "adminuserpagecount"
        for index in range(3):
            await factories.create_user(
                db_session,
                username=f"{marker}{index}",
                email=f"{marker}{index}@example.com",
            )

        payload = (
            await admin_client.get(f"{ADMIN_PREFIX}/users", params={"q": marker, "page_size": 2})
        ).json()

        assert_page_envelope(payload)
        assert payload["total"] == 3
        assert payload["page_size"] == 2
        assert payload["pages"] == 2

    async def test_a_page_past_the_end_is_an_empty_page_not_an_error(
        self, admin_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """An out-of-range page answers 200 with no items, echoing the page the caller asked for.

        Documented behaviour rather than an accident: ``PageParams`` deliberately leaves ``page``
        uncapped and must never clamp it, because clamping would return the last page's rows under
        the requested page number and silently answer a different question. The echoed ``page``
        next to the real ``pages`` is how a client detects it has run off the end.
        """
        marker = "adminuseroverrun"
        username, email = self._handle(marker)
        await factories.create_user(db_session, username=username, email=email)

        payload = (
            await admin_client.get(
                f"{ADMIN_PREFIX}/users", params={"q": marker, "page": 99, "page_size": 20}
            )
        ).json()

        assert_page_envelope(payload)
        assert payload["items"] == []
        assert payload["page"] == 99
        assert payload["total"] == 1
        assert payload["pages"] == 1

    async def test_the_role_filter_narrows_to_one_authority(
        self, admin_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """``?role=`` restricts the listing to one ``UserRole`` member.

        The filter behind the administrative table's authority tab, and the reason it is typed
        with the enumeration rather than with a string: the values published in
        ``/openapi.json`` are the same declaration the column persists, so the two cannot drift.
        """
        marker = "adminuserrolefilter"
        await factories.create_user(
            db_session,
            username=f"{marker}reader",
            email=f"{marker}reader@example.com",
            role=UserRole.READER,
        )
        await factories.create_user(
            db_session,
            username=f"{marker}author",
            email=f"{marker}author@example.com",
            role=UserRole.AUTHOR,
        )

        response = await admin_client.get(
            f"{ADMIN_PREFIX}/users", params={"q": marker, "role": UserRole.AUTHOR.value}
        )

        items = assert_page_envelope(response.json())
        assert [item["username"] for item in items] == [f"{marker}author"]
        assert items[0]["role"] == UserRole.AUTHOR.value

    async def test_the_activity_filter_surfaces_suspended_accounts(
        self, admin_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """``?is_active=false`` is meaningful rather than merely falsy - hence the filter.

        Showing the suspended accounts is the operator's task; a filter that treated ``false`` as
        "no filter supplied" would make the one interesting query unexpressible.
        """
        marker = "adminuseractivity"
        await factories.create_user(
            db_session, username=f"{marker}live", email=f"{marker}live@example.com"
        )
        await factories.create_user(
            db_session,
            username=f"{marker}held",
            email=f"{marker}held@example.com",
            is_active=False,
        )

        suspended = assert_page_envelope(
            (
                await admin_client.get(
                    f"{ADMIN_PREFIX}/users", params={"q": marker, "is_active": "false"}
                )
            ).json()
        )
        active = assert_page_envelope(
            (
                await admin_client.get(
                    f"{ADMIN_PREFIX}/users", params={"q": marker, "is_active": "true"}
                )
            ).json()
        )

        assert [item["username"] for item in suspended] == [f"{marker}held"]
        assert suspended[0]["is_active"] is False
        assert [item["username"] for item in active] == [f"{marker}live"]

    async def test_the_search_term_matches_the_email_as_well_as_the_username(
        self, admin_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """``?q=`` searches both identity columns, so an operator can look an account up either way.

        An operator arriving from a support ticket has an email address; one arriving from a
        comment thread has a handle. Matching only one of the two would leave half of them
        unable to find the row.
        """
        marker = "adminusersearch"
        await factories.create_user(
            db_session, username=f"handle{marker}", email=f"mailbox{marker}@example.com"
        )

        by_username = assert_page_envelope(
            (
                await admin_client.get(f"{ADMIN_PREFIX}/users", params={"q": f"handle{marker}"})
            ).json()
        )
        by_email = assert_page_envelope(
            (
                await admin_client.get(f"{ADMIN_PREFIX}/users", params={"q": f"mailbox{marker}"})
            ).json()
        )

        assert len(by_username) == 1
        assert by_username == by_email

    async def test_promotion_grants_administrative_access_to_the_promoted_account(
        self,
        admin_client: AsyncClient,
        client: AsyncClient,
        db_session: AsyncSession,
        reader_user: User,
        auth_headers_for: Callable[[User], dict[str, str]],
    ) -> None:
        """Promoting to ``ADMIN`` changes the target's *access*, not merely a field.

        The end-to-end form of AAP §0.9.4.4's "an administrator can change a user's role": the
        same reader is refused before the change and admitted after it, using a token minted
        before the promotion. That works because ``require_admin`` reads the role off the loaded
        row rather than off the token claim - so authority is current, and a stale claim can
        neither grant nor withhold it.
        """
        headers = auth_headers_for(reader_user)
        assert (
            await client.get(f"{ADMIN_PREFIX}/stats", headers=headers)
        ).status_code == HTTPStatus.FORBIDDEN

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/users/{reader_user.id}", json={"role": UserRole.ADMIN.value}
        )

        assert response.status_code == HTTPStatus.OK
        body = response.json()
        assert_admin_user_shape(body)
        assert body["role"] == UserRole.ADMIN.value
        assert (
            await client.get(f"{ADMIN_PREFIX}/stats", headers=headers)
        ).status_code == HTTPStatus.OK
        assert db_session is not None

    async def test_demotion_withdraws_administrative_access_immediately(
        self,
        admin_client: AsyncClient,
        client: AsyncClient,
        db_session: AsyncSession,
        auth_headers_for: Callable[[User], dict[str, str]],
    ) -> None:
        """Demoting from ``ADMIN`` refuses the account at once, token in hand notwithstanding.

        The mirror image, and the more security-relevant direction. An access token is valid until
        it expires and carries whatever ``role`` it was minted with, so trusting the claim would
        leave a demoted administrator fully privileged for the remainder of its lifetime. Checking
        the row closes that window without any token revocation machinery.
        """
        deputy = await factories.create_admin(db_session)
        headers = auth_headers_for(deputy)
        assert (
            await client.get(f"{ADMIN_PREFIX}/stats", headers=headers)
        ).status_code == HTTPStatus.OK

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/users/{deputy.id}", json={"role": UserRole.READER.value}
        )

        assert response.status_code == HTTPStatus.OK
        assert response.json()["role"] == UserRole.READER.value
        assert (
            await client.get(f"{ADMIN_PREFIX}/stats", headers=headers)
        ).status_code == HTTPStatus.FORBIDDEN

    async def test_deactivation_hides_the_profile_and_refuses_the_login(
        self,
        admin_client: AsyncClient,
        client: AsyncClient,
        db_session: AsyncSession,
    ) -> None:
        """Deactivating an account removes its public profile and stops it authenticating.

        Two independent consequences, both asserted because either one alone would leave the
        suspension half-effective. ``ProfileService.get_profile`` reports a deactivated account as
        404 - identically to an unclaimed handle, so the response leaks nothing about which it
        was - and the login route refuses the credential with 403 rather than 401, because the
        password was in fact correct.

        The credential is sent as ``data=`` rather than ``json=``: the login route consumes an
        OAuth2 password-grant **form**, whose field is named ``username`` but holds an email
        address. Sent as JSON it would answer 422 and this test would pass for the wrong reason.
        """
        victim = await factories.create_author(db_session)
        username = victim.username
        email = victim.email

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/users/{victim.id}", json={"is_active": False}
        )

        assert response.status_code == HTTPStatus.OK
        assert response.json()["is_active"] is False
        profile = await client.get(f"/api/v1/users/{username}")
        assert profile.status_code == HTTPStatus.NOT_FOUND
        assert_problem_document(profile.json(), HTTPStatus.NOT_FOUND)
        login = await client.post(
            "/api/v1/auth/login",
            data={"username": email, "password": factories.DEFAULT_PASSWORD},
        )
        assert login.status_code == HTTPStatus.FORBIDDEN
        assert_problem_document(login.json(), HTTPStatus.FORBIDDEN)

    async def test_both_members_may_be_changed_in_one_request(
        self, admin_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """``AdminUserUpdate`` accepts ``role`` and ``is_active`` together in a single patch."""
        target = await factories.create_reader(db_session)

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/users/{target.id}",
            json={"role": UserRole.AUTHOR.value, "is_active": False},
        )

        assert response.status_code == HTTPStatus.OK
        body = response.json()
        assert body["role"] == UserRole.AUTHOR.value
        assert body["is_active"] is False

    async def test_one_member_leaves_the_other_alone(
        self, admin_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """Both members are optional, so a partial patch is genuinely partial.

        ``exclude_unset`` is what makes an omitted member mean "leave this alone" rather than
        "set this to the default". Sending only ``role`` must not reactivate a suspended account
        as a side effect - which is the bug a whole-object PUT would have.
        """
        target = await factories.create_user(db_session, is_active=False)

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/users/{target.id}", json={"role": UserRole.AUTHOR.value}
        )

        assert response.status_code == HTTPStatus.OK
        body = response.json()
        assert body["role"] == UserRole.AUTHOR.value
        assert body["is_active"] is False

    async def test_an_empty_patch_is_a_successful_no_op(
        self, admin_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """An empty body answers 200 and changes nothing - a form submitted without edits.

        Legitimate client behaviour rather than an error: the management form posts whatever it
        holds, and refusing an unmodified submission would make the screen fail for doing nothing.
        """
        target = await factories.create_reader(db_session)
        original_role, original_active = target.role, target.is_active

        response = await admin_client.patch(f"{ADMIN_PREFIX}/users/{target.id}", json={})

        assert response.status_code == HTTPStatus.OK
        body = response.json()
        assert body["role"] == original_role.value
        assert body["is_active"] is original_active

    async def test_an_administrator_cannot_remove_their_own_administrator_role(
        self, admin_client: AsyncClient, db_session: AsyncSession, admin_user: User
    ) -> None:
        """Self-demotion is refused with 409, and the actor's own row is genuinely unchanged.

        The lockout guard. Left unguarded, the last administrator could strip their own authority
        and leave the namespace unreachable by anyone - an unrecoverable state, since restoring it
        needs the very privilege that was just discarded. 409 rather than 403 is the right reading:
        the caller is fully authorised, but the request conflicts with the state of the system.
        """
        actor_id = admin_user.id

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/users/{actor_id}", json={"role": UserRole.READER.value}
        )

        assert response.status_code == HTTPStatus.CONFLICT
        assert_problem_document(response.json(), HTTPStatus.CONFLICT)
        stored = (
            await db_session.execute(select(User.role).where(User.id == actor_id))
        ).scalar_one()
        assert stored is UserRole.ADMIN

    async def test_an_administrator_cannot_deactivate_their_own_account(
        self, admin_client: AsyncClient, db_session: AsyncSession, admin_user: User
    ) -> None:
        """Self-deactivation is refused with 409, and the actor stays active.

        The same lockout family as self-demotion, by the other route: an administrator who
        suspended themselves would be refused by ``get_current_active_user`` on their very next
        request, holding ``ADMIN`` throughout.
        """
        actor_id = admin_user.id

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/users/{actor_id}", json={"is_active": False}
        )

        assert response.status_code == HTTPStatus.CONFLICT
        assert_problem_document(response.json(), HTTPStatus.CONFLICT)
        stored = (
            await db_session.execute(select(User.is_active).where(User.id == actor_id))
        ).scalar_one()
        assert stored is True

    async def test_an_administrator_may_re_send_their_own_unchanged_role(
        self, admin_client: AsyncClient, admin_user: User
    ) -> None:
        """The guard refuses a move *away* from ``ADMIN``, not any patch naming the actor.

        The boundary of the previous two tests, and the reason the guard reads
        ``payload.role is not UserRole.ADMIN`` rather than "the actor was named". Re-sending the
        role the actor already holds is a harmless no-op, and a management form that submits every
        field would otherwise be unable to save an unrelated edit.
        """
        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/users/{admin_user.id}",
            json={"role": UserRole.ADMIN.value, "is_active": True},
        )

        assert response.status_code == HTTPStatus.OK
        body = response.json()
        assert body["role"] == UserRole.ADMIN.value
        assert body["is_active"] is True

    async def test_another_administrator_may_still_be_demoted(
        self, admin_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The guard is about the actor, not about the role: a *second* administrator is demotable.

        Without this, the guard would read as "administrators are immutable", which would make the
        namespace unable to correct a mistaken promotion. The service's rule is narrower and
        correct - ask another administrator to make the change - and this is the case that shows it.
        """
        deputy = await factories.create_admin(db_session)

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/users/{deputy.id}", json={"role": UserRole.AUTHOR.value}
        )

        assert response.status_code == HTTPStatus.OK
        assert response.json()["role"] == UserRole.AUTHOR.value

    async def test_patching_an_unknown_account_is_not_found(
        self, admin_client: AsyncClient
    ) -> None:
        """An identifier that addresses no row answers 404 with the uniform problem document."""
        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/users/{uuid.uuid4()}", json={"role": UserRole.AUTHOR.value}
        )

        assert response.status_code == HTTPStatus.NOT_FOUND
        assert_problem_document(response.json(), HTTPStatus.NOT_FOUND)

    async def test_a_malformed_identifier_is_rejected_before_any_query(
        self, admin_client: AsyncClient
    ) -> None:
        """A path value that is not a UUID answers 422, naming ``user_id`` in ``errors``.

        The path parameter is typed ``uuid.UUID``, so parsing happens in the framework and a
        malformed identifier never reaches a handler or a query. Sent **as an administrator**
        deliberately: the gate resolves before path parsing, so the same request from a reader
        would answer 403 and would prove nothing about the validator.
        """
        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/users/not-a-uuid", json={"role": UserRole.AUTHOR.value}
        )

        assert response.status_code == HTTPStatus.UNPROCESSABLE_CONTENT
        assert_validation_problem(response.json(), field="user_id")

    @pytest.mark.parametrize("member", ["role", "is_active"])
    async def test_an_explicit_null_is_refused_rather_than_treated_as_absent(
        self, admin_client: AsyncClient, db_session: AsyncSession, member: str
    ) -> None:
        """Sending ``null`` for either member answers 422 - omit the member to leave it alone.

        The distinction this closes is easy to get wrong, and the two schemas in this namespace
        resolve it in **opposite** directions on purpose. ``users.role`` and ``users.is_active``
        are both ``NOT NULL``, so a null has no meaning for either and ``AdminUserUpdate``
        rejects it outright with a message telling the caller to omit the field instead. A null
        ``CategoryUpdate.description`` is the opposite - the column is nullable, so a null is a
        legitimate instruction to clear it, which is asserted separately.

        Refusing at the schema is what stops a null reaching a ``NOT NULL`` column and surfacing
        as a 500 describing an integrity violation several layers from the member that caused it.
        """
        target = await factories.create_reader(db_session)
        target_id, original_role, original_active = (
            target.id,
            target.role,
            target.is_active,
        )

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/users/{target_id}", json={member: None}
        )

        assert response.status_code == HTTPStatus.UNPROCESSABLE_CONTENT
        assert_validation_problem(response.json(), field=member)
        stored = (
            await db_session.execute(select(User.role, User.is_active).where(User.id == target_id))
        ).one()
        assert stored.role is original_role
        assert stored.is_active is original_active

    async def test_an_unknown_member_in_the_body_is_rejected(
        self, admin_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """Unknown members are forbidden, so a stray field is 422 rather than quietly ignored.

        Refusing is the safer contract: a client that misspells ``is_active`` learns immediately,
        instead of believing a suspension took effect that never did.
        """
        target = await factories.create_reader(db_session)

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/users/{target.id}", json={"email": "rewritten@example.com"}
        )

        assert response.status_code == HTTPStatus.UNPROCESSABLE_CONTENT
        assert_validation_problem(response.json(), field="email")

    async def test_deleting_an_account_removes_it_and_its_profile(
        self, admin_client: AsyncClient, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """``DELETE /admin/users/{id}`` answers 204 with no body, and the profile then 404s."""
        victim = await factories.create_author(db_session)
        victim_id, username = victim.id, victim.username

        response = await admin_client.delete(f"{ADMIN_PREFIX}/users/{victim_id}")

        assert response.status_code == HTTPStatus.NO_CONTENT
        assert not response.content
        assert await count_rows(db_session, User.id == victim_id, User) == 0
        profile = await client.get(f"/api/v1/users/{username}")
        assert profile.status_code == HTTPStatus.NOT_FOUND

    async def test_deleting_an_account_cascades_to_everything_it_owned(
        self, admin_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """Deleting a user removes their posts, comments, likes and refresh tokens.

        Enforced by ``ON DELETE CASCADE`` in the database, not by application code walking the
        graph - which is what AAP §0.10.1 #3 asks for, and what makes the guarantee hold for any
        future writer of any future delete path. Each dependent row is asserted to **exist first**:
        a cascade test that passed because nothing was there in the first place would prove
        nothing at all.
        """
        victim = await factories.create_author(db_session)
        post = await factories.create_published_post(db_session, author=victim)
        comment = await factories.create_comment(db_session, post=post, author=victim)
        await factories.create_like(db_session, post=post, user=victim)
        _, refresh_token = await factories.create_refresh_token(db_session, user=victim)
        victim_id, post_id = victim.id, post.id
        comment_id, token_id = comment.id, refresh_token.id

        assert await count_rows(db_session, Post.id == post_id, Post) == 1
        assert await count_rows(db_session, Comment.id == comment_id, Comment) == 1
        assert await count_rows(db_session, PostLike.post_id == post_id, PostLike) == 1
        assert await count_rows(db_session, RefreshToken.id == token_id, RefreshToken) == 1

        response = await admin_client.delete(f"{ADMIN_PREFIX}/users/{victim_id}")

        assert response.status_code == HTTPStatus.NO_CONTENT
        assert await count_rows(db_session, User.id == victim_id, User) == 0
        assert await count_rows(db_session, Post.id == post_id, Post) == 0
        assert await count_rows(db_session, Comment.id == comment_id, Comment) == 0
        assert await count_rows(db_session, PostLike.post_id == post_id, PostLike) == 0
        assert await count_rows(db_session, RefreshToken.id == token_id, RefreshToken) == 0

    async def test_an_administrator_cannot_delete_their_own_account(
        self, admin_client: AsyncClient, db_session: AsyncSession, admin_user: User
    ) -> None:
        """Self-deletion is refused with 409, and the actor survives.

        The third member of the lockout family, and the most consequential: a deleted
        administrator cannot be restored by anyone, and the cascade would take their posts and
        comments with them.
        """
        actor_id = admin_user.id

        response = await admin_client.delete(f"{ADMIN_PREFIX}/users/{actor_id}")

        assert response.status_code == HTTPStatus.CONFLICT
        assert_problem_document(response.json(), HTTPStatus.CONFLICT)
        assert await count_rows(db_session, User.id == actor_id, User) == 1

    async def test_deleting_an_unknown_account_is_not_found(
        self, admin_client: AsyncClient
    ) -> None:
        """A delete addressed at no row answers 404, resolved before the lockout guard.

        The ordering is deliberate in the service: the row is fetched before it is deleted, which
        is what makes both the 404 and the self-deletion check possible at all.
        """
        response = await admin_client.delete(f"{ADMIN_PREFIX}/users/{uuid.uuid4()}")

        assert response.status_code == HTTPStatus.NOT_FOUND
        assert_problem_document(response.json(), HTTPStatus.NOT_FOUND)

    async def test_deleting_with_a_malformed_identifier_is_rejected(
        self, admin_client: AsyncClient
    ) -> None:
        """A malformed identifier on the delete path answers 422, as it does on the patch path."""
        response = await admin_client.delete(f"{ADMIN_PREFIX}/users/definitely-not-a-uuid")

        assert response.status_code == HTTPStatus.UNPROCESSABLE_CONTENT
        assert_validation_problem(response.json(), field="user_id")


# ---------------------------------------------------------------------------------------
# Phase D - managing posts
# ---------------------------------------------------------------------------------------


class TestAdminPosts:
    """Managing posts: the one listing that spans every lifecycle state, and forced transitions.

    ``GET /admin/posts`` is the **single** list surface in the API that bypasses public status
    scoping. Every other one either hard-filters to ``PUBLISHED`` or scopes to the viewer, so this
    contrast is the clearest statement of what the administrative namespace is *for*: an operator
    has to be able to see a draft and an archived post, and nobody else may.

    That breadth is safe only because the surface is gated, which is why the reach lives behind an
    authority check rather than behind a query parameter a public caller could also send.

    Every listing assertion narrows with ``?author_id=``. That is not incidental: the listing
    orders by ``published_at DESC NULLS LAST`` then ``posts.id DESC``, so a freshly created draft -
    having no publication instant - sorts after every published row in the table and is nowhere
    near the first page of a populated database.
    """

    async def test_listing_spans_draft_published_and_archived(
        self, admin_client: AsyncClient, db_session: AsyncSession, author_user: User
    ) -> None:
        """All three lifecycle states appear, which no other list surface in the API allows.

        The distinguishing assertion of the whole namespace. The service passes the full lifecycle
        tuple when no state was named, so a fourth state added to the enumeration would appear here
        without an edit to the router - and could not fail to.
        """
        expected = {}
        for state in PostStatus:
            post = await factories.create_post(db_session, author=author_user, status=state)
            expected[str(post.id)] = state.value

        response = await admin_client.get(
            f"{ADMIN_PREFIX}/posts", params={"author_id": str(author_user.id)}
        )

        assert response.status_code == HTTPStatus.OK
        items = assert_page_envelope(response.json())
        assert {item["id"]: item["status"] for item in items} == expected
        assert {item["status"] for item in items} == {state.value for state in PostStatus}

    async def test_listing_items_carry_a_public_byline(
        self, admin_client: AsyncClient, db_session: AsyncSession, author_user: User
    ) -> None:
        """Items are ``AdminPost``-shaped, and the embedded author stays a ``UserPublic``.

        An administrative response widens what is shown about the entity being managed, never
        about a third party attached to it - so the byline withholds ``email``, ``role`` and
        ``is_active`` even though the caller holds ``ADMIN``.
        """
        await factories.create_published_post(db_session, author=author_user)

        response = await admin_client.get(
            f"{ADMIN_PREFIX}/posts", params={"author_id": str(author_user.id)}
        )

        items = assert_page_envelope(response.json())
        assert items
        for item in items:
            assert_admin_post_shape(item)
            assert item["author"]["id"] == str(author_user.id)

    async def test_the_status_filter_narrows_to_one_lifecycle_state(
        self, admin_client: AsyncClient, db_session: AsyncSession, author_user: User
    ) -> None:
        """``?status=`` serves a per-state tab, while omitting it spans every state.

        The parameter is exposed as ``status`` on the wire but named ``post_status`` inside the
        handler, so the local name cannot shadow the ``fastapi.status`` module every decorator in
        that router uses. This asserts the wire name, which is the half a client depends on.
        """
        for state in PostStatus:
            await factories.create_post(db_session, author=author_user, status=state)

        for state in PostStatus:
            response = await admin_client.get(
                f"{ADMIN_PREFIX}/posts",
                params={"author_id": str(author_user.id), "status": state.value},
            )

            items = assert_page_envelope(response.json())
            assert [item["status"] for item in items] == [state.value]

    async def test_the_author_filter_excludes_other_authors_posts(
        self,
        admin_client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        other_author_user: User,
    ) -> None:
        """``?author_id=`` restricts the listing to one account's posts.

        Addressed by identifier rather than by username because this surface addresses accounts by
        key throughout - the same identifier the user routes take.
        """
        mine = await factories.create_published_post(db_session, author=author_user)
        theirs = await factories.create_published_post(db_session, author=other_author_user)
        mine_id, theirs_id = str(mine.id), str(theirs.id)

        response = await admin_client.get(
            f"{ADMIN_PREFIX}/posts", params={"author_id": str(author_user.id)}
        )

        items = assert_page_envelope(response.json())
        found = {item["id"] for item in items}
        assert mine_id in found
        assert theirs_id not in found

    async def test_pagination_windows_are_disjoint(
        self, admin_client: AsyncClient, db_session: AsyncSession, author_user: User
    ) -> None:
        """Page two is disjoint from page one, and the union is the whole result set."""
        created = set()
        for _ in range(4):
            post = await factories.create_published_post(db_session, author=author_user)
            created.add(str(post.id))

        window = {"author_id": str(author_user.id), "page_size": 2}
        first = assert_page_envelope(
            (await admin_client.get(f"{ADMIN_PREFIX}/posts", params={**window, "page": 1})).json()
        )
        second = assert_page_envelope(
            (await admin_client.get(f"{ADMIN_PREFIX}/posts", params={**window, "page": 2})).json()
        )

        first_ids = {item["id"] for item in first}
        second_ids = {item["id"] for item in second}
        assert not first_ids & second_ids
        assert first_ids | second_ids == created

    async def test_a_page_past_the_end_is_empty_rather_than_an_error(
        self, admin_client: AsyncClient, db_session: AsyncSession, author_user: User
    ) -> None:
        """An out-of-range page answers 200 with no items and the real total beside it."""
        await factories.create_published_post(db_session, author=author_user)

        payload = (
            await admin_client.get(
                f"{ADMIN_PREFIX}/posts", params={"author_id": str(author_user.id), "page": 250}
            )
        ).json()

        assert_page_envelope(payload)
        assert payload["items"] == []
        assert payload["page"] == 250
        assert payload["total"] >= 1

    async def test_a_page_below_one_is_rejected(self, admin_client: AsyncClient) -> None:
        """``?page=0`` answers 422 naming ``page``, because the window is 1-based.

        Sent as an administrator on purpose: the gate resolves before query parsing, so the same
        request without a token would answer 401 and would say nothing about ``PageParams``.
        """
        response = await admin_client.get(f"{ADMIN_PREFIX}/posts", params={"page": 0})

        assert response.status_code == HTTPStatus.UNPROCESSABLE_CONTENT
        assert_validation_problem(response.json(), field="page")

    async def test_a_window_larger_than_the_cap_is_rejected(
        self, admin_client: AsyncClient
    ) -> None:
        """``?page_size=`` above the cap answers 422, so one request cannot ask for the relation.

        The bounds are deliberately asymmetric - ``page`` is uncapped, ``page_size`` is not -
        because an unbounded window is a denial-of-service surface while an out-of-range page is
        merely an empty answer.
        """
        response = await admin_client.get(f"{ADMIN_PREFIX}/posts", params={"page_size": 1_000})

        assert response.status_code == HTTPStatus.UNPROCESSABLE_CONTENT
        assert_validation_problem(response.json(), field="page_size")

    async def test_forcing_publication_stamps_the_publication_instant(
        self, admin_client: AsyncClient, db_session: AsyncSession, author_user: User
    ) -> None:
        """Forcing ``PUBLISHED`` on a draft sets ``published_at`` to an aware instant.

        Standard §0.10.1 #3 in one assertion. ``ck_posts_published_at_required`` -
        ``CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL)`` - would reject the UPDATE
        outright if the service did not stamp the instant, so a published post with no publication
        date is unrepresentable rather than merely unusual. The database holds the invariant; the
        service is written so as never to test it.
        """
        draft = await factories.create_post(db_session, author=author_user, status=PostStatus.DRAFT)
        draft_id = draft.id
        assert draft.published_at is None

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/posts/{draft_id}/status",
            json={"status": PostStatus.PUBLISHED.value},
        )

        assert response.status_code == HTTPStatus.OK
        body = response.json()
        assert_admin_post_shape(body)
        assert body["status"] == PostStatus.PUBLISHED.value
        assert body["published_at"] is not None
        parse_instant(body["published_at"])
        stored = (
            await db_session.execute(
                select(Post.status, Post.published_at).where(Post.id == draft_id)
            )
        ).one()
        assert stored.status is PostStatus.PUBLISHED
        assert stored.published_at is not None

    async def test_forcing_publication_makes_the_post_publicly_visible(
        self,
        admin_client: AsyncClient,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
    ) -> None:
        """A forced publication reaches the public feed, which is what publication means.

        The status field changing is the mechanism; appearing in the feed is the outcome a reader
        experiences, and it is the outcome that is asserted.
        """
        draft = await factories.create_post(db_session, author=author_user, status=PostStatus.DRAFT)
        draft_id, username = draft.id, author_user.username
        before = (await client.get("/api/v1/posts", params={"author": username})).json()
        assert not any(item["id"] == str(draft_id) for item in before["items"])

        await admin_client.patch(
            f"{ADMIN_PREFIX}/posts/{draft_id}/status",
            json={"status": PostStatus.PUBLISHED.value},
        )

        after = (await client.get("/api/v1/posts", params={"author": username})).json()
        assert any(item["id"] == str(draft_id) for item in after["items"])

    async def test_archiving_withdraws_a_post_from_the_feed_but_not_from_the_namespace(
        self,
        admin_client: AsyncClient,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
    ) -> None:
        """Forcing ``ARCHIVED`` removes the post from the public feed while the operator keeps it.

        Exactly the asymmetry the administrative listing exists to provide: withdrawn from readers,
        still visible - and still recoverable - to an operator. ``published_at`` is deliberately
        **retained**, because the service mints an instant only when one is absent; archiving is a
        withdrawal, not an erasure of the fact that the post was once public.
        """
        post = await factories.create_published_post(db_session, author=author_user)
        post_id, username = post.id, author_user.username
        original_instant = (
            await admin_client.get(
                f"{ADMIN_PREFIX}/posts", params={"author_id": str(author_user.id)}
            )
        ).json()["items"][0]["published_at"]

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/posts/{post_id}/status", json={"status": PostStatus.ARCHIVED.value}
        )

        assert response.status_code == HTTPStatus.OK
        assert response.json()["status"] == PostStatus.ARCHIVED.value
        assert response.json()["published_at"] == original_instant
        feed = (await client.get("/api/v1/posts", params={"author": username})).json()
        assert not any(item["id"] == str(post_id) for item in feed["items"])
        listing = (
            await admin_client.get(
                f"{ADMIN_PREFIX}/posts", params={"author_id": str(author_user.id)}
            )
        ).json()
        assert [item["id"] for item in listing["items"]] == [str(post_id)]

    async def test_returning_a_published_post_to_draft_removes_it_from_the_feed(
        self,
        admin_client: AsyncClient,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
    ) -> None:
        """Forcing ``DRAFT`` on a published post unpublishes it, and the feed reflects that.

        Every transition is reachable from every other, so an operator can pull a post back for
        editing rather than only forward into the archive.
        """
        post = await factories.create_published_post(db_session, author=author_user)
        post_id, username = post.id, author_user.username

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/posts/{post_id}/status", json={"status": PostStatus.DRAFT.value}
        )

        assert response.status_code == HTTPStatus.OK
        assert response.json()["status"] == PostStatus.DRAFT.value
        feed = (await client.get("/api/v1/posts", params={"author": username})).json()
        assert not any(item["id"] == str(post_id) for item in feed["items"])

    async def test_an_administrator_may_force_another_authors_post(
        self, admin_client: AsyncClient, db_session: AsyncSession, other_author_user: User
    ) -> None:
        """Ownership is not required here - crossing that boundary is the point of the namespace.

        On ``PATCH /api/v1/posts/{id}`` an author may act only on their own post; the
        administrative route deliberately admits any post, which is the authority AAP §0.9.4.4
        asks an administrator to have.
        """
        stranger_post = await factories.create_post(
            db_session, author=other_author_user, status=PostStatus.DRAFT
        )

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/posts/{stranger_post.id}/status",
            json={"status": PostStatus.PUBLISHED.value},
        )

        assert response.status_code == HTTPStatus.OK
        assert response.json()["status"] == PostStatus.PUBLISHED.value
        assert response.json()["author"]["id"] == str(other_author_user.id)

    async def test_the_status_member_is_required(
        self, admin_client: AsyncClient, db_session: AsyncSession, author_user: User
    ) -> None:
        """An empty body answers 422 naming ``status``, because the member has no default.

        Deliberately unlike ``AdminUserUpdate``, whose members are optional. There is no sensible
        default lifecycle state to fall back on, so an omitted state is a malformed request rather
        than a no-op.
        """
        post = await factories.create_post(db_session, author=author_user)

        response = await admin_client.patch(f"{ADMIN_PREFIX}/posts/{post.id}/status", json={})

        assert response.status_code == HTTPStatus.UNPROCESSABLE_CONTENT
        assert_validation_problem(response.json(), field="status")

    async def test_an_unrecognised_lifecycle_state_is_rejected(
        self, admin_client: AsyncClient, db_session: AsyncSession, author_user: User
    ) -> None:
        """A value outside ``PostStatus`` answers 422 rather than reaching the column.

        ``posts.status`` is a native PostgreSQL enumerated type, so an unrecognised label could
        only ever fail at the driver. Refusing it at the boundary is what turns a 500 describing an
        integrity violation into a 422 naming the member at fault.
        """
        post = await factories.create_post(db_session, author=author_user)

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/posts/{post.id}/status", json={"status": "RETIRED"}
        )

        assert response.status_code == HTTPStatus.UNPROCESSABLE_CONTENT
        assert_validation_problem(response.json(), field="status")

    async def test_forcing_the_status_of_an_unknown_post_is_not_found(
        self, admin_client: AsyncClient
    ) -> None:
        """An identifier addressing no post answers 404 with the uniform document."""
        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/posts/{uuid.uuid4()}/status",
            json={"status": PostStatus.PUBLISHED.value},
        )

        assert response.status_code == HTTPStatus.NOT_FOUND
        assert_problem_document(response.json(), HTTPStatus.NOT_FOUND)

    async def test_a_malformed_post_identifier_is_rejected(self, admin_client: AsyncClient) -> None:
        """A path value that is not a UUID answers 422 naming ``post_id``."""
        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/posts/17/status", json={"status": PostStatus.PUBLISHED.value}
        )

        assert response.status_code == HTTPStatus.UNPROCESSABLE_CONTENT
        assert_validation_problem(response.json(), field="post_id")

    async def test_deleting_a_post_takes_its_comments_and_likes_with_it(
        self,
        admin_client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """``DELETE /admin/posts/{id}`` answers 204; its comments and likes cascade, its category
        and its author do not.

        Kept deliberately brief - ``test_posts_api.py`` owns the cascade in depth - but the
        *survivors* are asserted here as well as the casualties, because a cascade that reached
        the category or the author would be a far worse defect than one that failed to reach a
        comment, and only a test that looks can tell the two apart.
        """
        category = await factories.create_category(db_session)
        post = await factories.create_published_post(
            db_session, author=author_user, categories=[category]
        )
        comment = await factories.create_comment(db_session, post=post, author=reader_user)
        await factories.create_like(db_session, post=post, user=reader_user)
        post_id, comment_id = post.id, comment.id
        category_id, author_id = category.id, author_user.id

        assert await count_rows(db_session, Comment.id == comment_id, Comment) == 1
        assert await count_rows(db_session, PostLike.post_id == post_id, PostLike) == 1

        response = await admin_client.delete(f"{ADMIN_PREFIX}/posts/{post_id}")

        assert response.status_code == HTTPStatus.NO_CONTENT
        assert not response.content
        assert await count_rows(db_session, Post.id == post_id, Post) == 0
        assert await count_rows(db_session, Comment.id == comment_id, Comment) == 0
        assert await count_rows(db_session, PostLike.post_id == post_id, PostLike) == 0
        assert await count_rows(db_session, Category.id == category_id, Category) == 1
        assert await count_rows(db_session, User.id == author_id, User) == 1

    async def test_deleting_an_unknown_post_is_not_found(self, admin_client: AsyncClient) -> None:
        """A delete addressed at no post answers 404, not 204."""
        response = await admin_client.delete(f"{ADMIN_PREFIX}/posts/{uuid.uuid4()}")

        assert response.status_code == HTTPStatus.NOT_FOUND
        assert_problem_document(response.json(), HTTPStatus.NOT_FOUND)


# ---------------------------------------------------------------------------------------
# Phase E - moderating comments
# ---------------------------------------------------------------------------------------


class TestAdminComments:
    """Moderating comments: the queue, the approve and reject transitions, and their public effect.

    ``GET /admin/comments`` is the moderation queue - every state at once, served by the index on
    ``comments.status`` - and ``PATCH /admin/comments/{id}/status`` is the only way a comment
    becomes publicly visible. ``AdminService`` **delegates** the transition to
    ``CommentService.set_status`` rather than writing the column itself, so moderation policy is
    declared exactly once even though the administrative surface adds its own listing and
    projection around it.

    Every transition is reachable from every other. Retaining a rejected row rather than deleting
    it is what makes moderation reversible, and reversibility would be meaningless if the reverse
    transition were refused - so there is no transition table to test and no illegal pair to
    assert.

    The real proof of the feature is not the status field changing but the **public** listing
    changing with it, so each transition below is cross-checked against
    ``GET /api/v1/posts/{post_id}/comments``, which admits ``APPROVED`` alone.
    """

    async def test_the_queue_spans_every_moderation_state(
        self,
        admin_client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """Pending, approved and rejected comments all appear - it is a queue, not a listing.

        Collapsing the states into a boolean would leave the work an operator still has to do
        indistinguishable from the decisions already taken behind it, and would leave this route
        with nothing to move a comment *back* to.
        """
        post = await factories.create_published_post(db_session, author=author_user)
        expected = {}
        for state in CommentStatus:
            comment = await factories.create_comment(
                db_session, post=post, author=reader_user, status=state
            )
            expected[str(comment.id)] = state.value

        response = await admin_client.get(
            f"{ADMIN_PREFIX}/comments", params={"post_id": str(post.id)}
        )

        assert response.status_code == HTTPStatus.OK
        items = assert_page_envelope(response.json())
        assert {item["id"]: item["status"] for item in items} == expected
        assert {item["status"] for item in items} == {state.value for state in CommentStatus}

    async def test_queue_items_are_flat_and_carry_a_public_byline(
        self,
        admin_client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """Items are ``AdminComment``-shaped: ``parent_id`` present, no nested ``replies``.

        The queue is a flat list on purpose. An operator works one decision at a time, so a reply
        appears in its own right - identified as a reply by ``parent_id`` - rather than nested
        inside a parent that may itself be pending.
        """
        post = await factories.create_published_post(db_session, author=author_user)
        parent = await factories.create_comment(db_session, post=post, author=reader_user)
        reply = await factories.create_comment(
            db_session, post=post, author=reader_user, parent=parent
        )
        post_id, parent_id, reply_id = str(post.id), str(parent.id), str(reply.id)

        response = await admin_client.get(f"{ADMIN_PREFIX}/comments", params={"post_id": post_id})

        items = assert_page_envelope(response.json())
        by_id = {item["id"]: item for item in items}
        assert by_id.keys() == {parent_id, reply_id}
        for item in items:
            assert_admin_comment_shape(item)
            assert item["post_id"] == post_id
            assert "replies" not in item
        assert by_id[parent_id]["parent_id"] is None
        assert by_id[reply_id]["parent_id"] == parent_id

    async def test_the_status_filter_serves_the_pending_queue(
        self,
        admin_client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """``?status=`` narrows to one moderation state - ``PENDING`` being the queue to work."""
        post = await factories.create_published_post(db_session, author=author_user)
        for state in CommentStatus:
            await factories.create_comment(db_session, post=post, author=reader_user, status=state)

        for state in CommentStatus:
            response = await admin_client.get(
                f"{ADMIN_PREFIX}/comments",
                params={"post_id": str(post.id), "status": state.value},
            )

            items = assert_page_envelope(response.json())
            assert [item["status"] for item in items] == [state.value]

    async def test_an_unrecognised_moderation_state_filter_is_rejected(
        self, admin_client: AsyncClient
    ) -> None:
        """A ``?status=`` value outside ``CommentStatus`` answers 422 naming ``status``."""
        response = await admin_client.get(
            f"{ADMIN_PREFIX}/comments", params={"status": "SHADOWBANNED"}
        )

        assert response.status_code == HTTPStatus.UNPROCESSABLE_CONTENT
        assert_validation_problem(response.json(), field="status")

    async def test_the_post_filter_restricts_the_queue_to_one_thread(
        self,
        admin_client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """``?post_id=`` narrows the queue to the comments on one post."""
        first = await factories.create_published_post(db_session, author=author_user)
        second = await factories.create_published_post(db_session, author=author_user)
        mine = await factories.create_comment(db_session, post=first, author=reader_user)
        elsewhere = await factories.create_comment(db_session, post=second, author=reader_user)
        mine_id, elsewhere_id = str(mine.id), str(elsewhere.id)

        response = await admin_client.get(
            f"{ADMIN_PREFIX}/comments", params={"post_id": str(first.id)}
        )

        items = assert_page_envelope(response.json())
        found = {item["id"] for item in items}
        assert mine_id in found
        assert elsewhere_id not in found

    async def test_the_search_term_matches_the_comment_body(
        self,
        admin_client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """``?q=`` searches the body, so an operator can find a report by the words in it."""
        post = await factories.create_published_post(db_session, author=author_user)
        wanted = await factories.create_comment(
            db_session, post=post, author=reader_user, body="Distinctive moderation needle."
        )
        await factories.create_comment(
            db_session, post=post, author=reader_user, body="An unrelated remark."
        )

        response = await admin_client.get(
            f"{ADMIN_PREFIX}/comments", params={"post_id": str(post.id), "q": "needle"}
        )

        items = assert_page_envelope(response.json())
        assert [item["id"] for item in items] == [str(wanted.id)]

    async def test_queue_pagination_windows_are_disjoint(
        self,
        admin_client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """Page two of the queue is disjoint from page one, and the union is complete."""
        post = await factories.create_published_post(db_session, author=author_user)
        created = set()
        for _ in range(4):
            comment = await factories.create_comment(db_session, post=post, author=reader_user)
            created.add(str(comment.id))

        window = {"post_id": str(post.id), "page_size": 2}
        first = assert_page_envelope(
            (
                await admin_client.get(f"{ADMIN_PREFIX}/comments", params={**window, "page": 1})
            ).json()
        )
        second = assert_page_envelope(
            (
                await admin_client.get(f"{ADMIN_PREFIX}/comments", params={**window, "page": 2})
            ).json()
        )

        first_ids = {item["id"] for item in first}
        second_ids = {item["id"] for item in second}
        assert not first_ids & second_ids
        assert first_ids | second_ids == created

    async def test_approving_a_pending_comment_publishes_it(
        self,
        admin_client: AsyncClient,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """Approving a pending comment makes it appear in the public thread.

        The cross-check is the real assertion. ``PATCH`` reporting ``APPROVED`` only shows the
        column was written; the comment surfacing on ``GET /api/v1/posts/{id}/comments`` - which
        admits approved comments alone - is the behaviour a reader actually gets, and it is the
        AAP §0.9.4.4 criterion "approve or reject a comment".
        """
        post = await factories.create_published_post(db_session, author=author_user)
        pending = await factories.create_comment(
            db_session, post=post, author=reader_user, status=CommentStatus.PENDING
        )
        post_id, pending_id = str(post.id), str(pending.id)
        before = (await client.get(f"/api/v1/posts/{post_id}/comments")).json()
        assert not any(item["id"] == pending_id for item in before["items"])

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/comments/{pending_id}/status",
            json={"status": CommentStatus.APPROVED.value},
        )

        assert response.status_code == HTTPStatus.OK
        body = response.json()
        assert_admin_comment_shape(body)
        assert body["status"] == CommentStatus.APPROVED.value
        after = (await client.get(f"/api/v1/posts/{post_id}/comments")).json()
        assert any(item["id"] == pending_id for item in after["items"])

    async def test_rejecting_an_approved_comment_withdraws_it(
        self,
        admin_client: AsyncClient,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """Rejecting an approved comment removes it from the public thread without deleting it.

        Both halves matter. It disappears for readers, and the row survives - which is what makes
        the decision reversible, and is why ``REJECTED`` is a state rather than a delete.
        """
        post = await factories.create_published_post(db_session, author=author_user)
        approved = await factories.create_comment(
            db_session, post=post, author=reader_user, status=CommentStatus.APPROVED
        )
        post_id, approved_id = str(post.id), str(approved.id)
        before = (await client.get(f"/api/v1/posts/{post_id}/comments")).json()
        assert any(item["id"] == approved_id for item in before["items"])

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/comments/{approved_id}/status",
            json={"status": CommentStatus.REJECTED.value},
        )

        assert response.status_code == HTTPStatus.OK
        assert response.json()["status"] == CommentStatus.REJECTED.value
        after = (await client.get(f"/api/v1/posts/{post_id}/comments")).json()
        assert not any(item["id"] == approved_id for item in after["items"])
        assert await count_rows(db_session, Comment.id == approved.id, Comment) == 1

    async def test_rejecting_a_reply_removes_it_from_its_parents_thread(
        self,
        admin_client: AsyncClient,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """A rejected reply vanishes from its parent's ``replies`` while the parent stays visible.

        The moderation predicate is applied to the nested load as well as to the roots, so a
        decision about a reply takes effect at whatever depth the reply sits. Moderating a reply
        must not withdraw the conversation above it, which is the other half of this assertion.
        """
        post = await factories.create_published_post(db_session, author=author_user)
        parent = await factories.create_comment(
            db_session, post=post, author=reader_user, status=CommentStatus.APPROVED
        )
        reply = await factories.create_comment(
            db_session,
            post=post,
            author=reader_user,
            parent=parent,
            status=CommentStatus.APPROVED,
        )
        post_id, parent_id, reply_id = str(post.id), str(parent.id), str(reply.id)
        before = (await client.get(f"/api/v1/posts/{post_id}/comments")).json()
        parent_before = next(item for item in before["items"] if item["id"] == parent_id)
        assert [child["id"] for child in parent_before["replies"]] == [reply_id]

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/comments/{reply_id}/status",
            json={"status": CommentStatus.REJECTED.value},
        )

        assert response.status_code == HTTPStatus.OK
        after = (await client.get(f"/api/v1/posts/{post_id}/comments")).json()
        parent_after = next(item for item in after["items"] if item["id"] == parent_id)
        assert parent_after["replies"] == []

    async def test_a_rejected_comment_can_be_returned_to_the_queue(
        self,
        admin_client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """Moderation is reversible: a rejected comment moves back to ``PENDING``.

        Retaining the row is what makes this possible, and this is the transition that shows the
        retention was for a reason rather than merely an omission to clean up.
        """
        post = await factories.create_published_post(db_session, author=author_user)
        rejected = await factories.create_comment(
            db_session, post=post, author=reader_user, status=CommentStatus.REJECTED
        )

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/comments/{rejected.id}/status",
            json={"status": CommentStatus.PENDING.value},
        )

        assert response.status_code == HTTPStatus.OK
        assert response.json()["status"] == CommentStatus.PENDING.value

    async def test_the_moderation_state_is_required(
        self,
        admin_client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """An empty body answers 422 naming ``status``: there is no default decision."""
        post = await factories.create_published_post(db_session, author=author_user)
        comment = await factories.create_comment(db_session, post=post, author=reader_user)

        response = await admin_client.patch(f"{ADMIN_PREFIX}/comments/{comment.id}/status", json={})

        assert response.status_code == HTTPStatus.UNPROCESSABLE_CONTENT
        assert_validation_problem(response.json(), field="status")

    async def test_an_unrecognised_moderation_state_is_rejected(
        self,
        admin_client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """A value outside ``CommentStatus`` answers 422 rather than reaching the column."""
        post = await factories.create_published_post(db_session, author=author_user)
        comment = await factories.create_comment(db_session, post=post, author=reader_user)

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/comments/{comment.id}/status", json={"status": "HIDDEN"}
        )

        assert response.status_code == HTTPStatus.UNPROCESSABLE_CONTENT
        assert_validation_problem(response.json(), field="status")

    async def test_moderating_an_unknown_comment_is_not_found(
        self, admin_client: AsyncClient
    ) -> None:
        """An identifier addressing no comment answers 404, resolved before authority."""
        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/comments/{uuid.uuid4()}/status",
            json={"status": CommentStatus.APPROVED.value},
        )

        assert response.status_code == HTTPStatus.NOT_FOUND
        assert_problem_document(response.json(), HTTPStatus.NOT_FOUND)

    async def test_a_malformed_comment_identifier_is_rejected(
        self, admin_client: AsyncClient
    ) -> None:
        """A path value that is not a UUID answers 422 naming ``comment_id``."""
        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/comments/latest/status",
            json={"status": CommentStatus.APPROVED.value},
        )

        assert response.status_code == HTTPStatus.UNPROCESSABLE_CONTENT
        assert_validation_problem(response.json(), field="comment_id")

    async def test_deleting_a_comment_cascades_to_its_replies(
        self,
        admin_client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """``DELETE /admin/comments/{id}`` answers 204 and takes the whole subtree with it.

        The self-referencing foreign key carries ``ON DELETE CASCADE``, so removing a parent
        removes its replies at any depth - in the database rather than in Python, which is what
        makes it true for a subtree of arbitrary shape. Both rows are asserted to exist first, so
        the assertion cannot pass by accident.
        """
        post = await factories.create_published_post(db_session, author=author_user)
        parent = await factories.create_comment(db_session, post=post, author=reader_user)
        reply = await factories.create_comment(
            db_session, post=post, author=reader_user, parent=parent
        )
        grandchild = await factories.create_comment(
            db_session, post=post, author=reader_user, parent=reply
        )
        parent_id, reply_id, grandchild_id = parent.id, reply.id, grandchild.id
        subtree = [parent_id, reply_id, grandchild_id]

        assert await count_rows(db_session, Comment.id.in_(subtree), Comment) == 3

        response = await admin_client.delete(f"{ADMIN_PREFIX}/comments/{parent_id}")

        assert response.status_code == HTTPStatus.NO_CONTENT
        assert not response.content
        assert await count_rows(db_session, Comment.id.in_(subtree), Comment) == 0

    async def test_deleting_a_reply_leaves_its_parent_alone(
        self,
        admin_client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """The cascade runs downwards only - deleting a reply does not disturb the parent.

        The negative control for the test above. A cascade that ran in both directions would
        remove a whole conversation whenever one reply was moderated away, and a count that only
        ever fell would not distinguish the two.
        """
        post = await factories.create_published_post(db_session, author=author_user)
        parent = await factories.create_comment(db_session, post=post, author=reader_user)
        reply = await factories.create_comment(
            db_session, post=post, author=reader_user, parent=parent
        )
        parent_id, reply_id = parent.id, reply.id

        response = await admin_client.delete(f"{ADMIN_PREFIX}/comments/{reply_id}")

        assert response.status_code == HTTPStatus.NO_CONTENT
        assert await count_rows(db_session, Comment.id == reply_id, Comment) == 0
        assert await count_rows(db_session, Comment.id == parent_id, Comment) == 1

    async def test_deleting_an_unknown_comment_is_not_found(
        self, admin_client: AsyncClient
    ) -> None:
        """A delete addressed at no comment answers 404, not 204."""
        response = await admin_client.delete(f"{ADMIN_PREFIX}/comments/{uuid.uuid4()}")

        assert response.status_code == HTTPStatus.NOT_FOUND
        assert_problem_document(response.json(), HTTPStatus.NOT_FOUND)


# ---------------------------------------------------------------------------------------
# Phase F - the category lifecycle
# ---------------------------------------------------------------------------------------


class TestAdminCategories:
    """The taxonomy lifecycle: create, list, rename, and the two refusals that protect it.

    ``AdminService`` **delegates** the whole of this family to ``CategoryService.create`` /
    ``update`` / ``delete``, so slug derivation and in-use protection are each declared exactly
    once. The behaviours are nonetheless asserted here rather than in
    ``test_categories_api.py``, because this namespace is the only place they are reachable over
    HTTP: the public routes read the taxonomy and never write it.

    Two of those behaviours are easy to assume backwards, and both are asserted explicitly.

    **A rename does not re-derive the slug.** The slug is written once, at creation, because it is
    the canonical URL that SEO depends on. Re-deriving it on every rename would silently break
    every link ever shared to that category, which is precisely what a canonical URL exists to
    prevent.

    **An in-use category cannot be deleted.** ``post_categories`` still references it, so the
    delete is refused with 409 and the operator is told to re-file the posts first.

    The routes take ``{category_id}`` throughout - never a slug - even though the public read
    routes are addressed by slug. This surface addresses rows by key.
    """

    async def test_creating_a_category_derives_its_slug_on_the_server(
        self, admin_client: AsyncClient
    ) -> None:
        """``POST /admin/categories`` answers 201 with a server-derived slug and no posts filed.

        The client sends a display name and nothing else that identifies the row. Identity and the
        canonical URL are both the server's to decide, which is what retires the defect class the
        previous contract carried, where a client chose its own key.
        """
        response = await admin_client.post(
            f"{ADMIN_PREFIX}/categories",
            json={"name": "Distributed Systems", "description": "Consensus and clocks."},
        )

        assert response.status_code == HTTPStatus.CREATED
        body = response.json()
        assert_category_public_shape(body)
        assert body["name"] == "Distributed Systems"
        assert body["slug"] == "distributed-systems"
        assert body["description"] == "Consensus and clocks."
        assert body["post_count"] == 0
        uuid.UUID(body["id"])

    async def test_the_description_is_optional(self, admin_client: AsyncClient) -> None:
        """Only ``name`` is required, so a bare creation succeeds with a null note."""
        response = await admin_client.post(
            f"{ADMIN_PREFIX}/categories", json={"name": "Observability"}
        )

        assert response.status_code == HTTPStatus.CREATED
        body = response.json()
        assert body["name"] == "Observability"
        assert body["description"] is None

    async def test_a_client_may_not_choose_the_identifier_or_the_slug(
        self, admin_client: AsyncClient
    ) -> None:
        """Sending ``id`` or ``slug`` answers 422 - the members are forbidden, not ignored.

        ``CategoryCreate`` forbids unknown members, so both are named in ``errors``. Refusing is
        the better contract than silently dropping them: a client that believed it had chosen a
        canonical URL, and had not, would generate links that never resolve.
        """
        response = await admin_client.post(
            f"{ADMIN_PREFIX}/categories",
            json={
                "name": "Chosen Identity",
                "id": str(uuid.uuid4()),
                "slug": "a-slug-i-picked",
            },
        )

        assert response.status_code == HTTPStatus.UNPROCESSABLE_CONTENT
        payload = response.json()
        assert_validation_problem(payload, field="id")
        assert_validation_problem(payload, field="slug")

    async def test_a_duplicate_name_is_a_conflict(
        self, admin_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """Creating a category whose name already exists answers 409 and writes nothing.

        ``categories.name`` is UNIQUE, and ``CategoryService.create`` looks the name up first so
        the common collision gets a clear message rather than a translated integrity error. The row
        count is asserted afterwards because a conflict that left a partial row behind would be
        worse than the conflict itself.
        """
        name = "Duplicate Taxonomy Name"
        first = await admin_client.post(f"{ADMIN_PREFIX}/categories", json={"name": name})
        assert first.status_code == HTTPStatus.CREATED

        response = await admin_client.post(f"{ADMIN_PREFIX}/categories", json={"name": name})

        assert response.status_code == HTTPStatus.CONFLICT
        assert_problem_document(response.json(), HTTPStatus.CONFLICT)
        assert await count_rows(db_session, Category.name == name, Category) == 1

    async def test_a_case_variant_name_is_a_distinct_category_with_a_de_duplicated_slug(
        self, admin_client: AsyncClient
    ) -> None:
        """A case-variant name is accepted, and its slug is de-duplicated rather than clashing.

        The two constraints on this relation are deliberately not the same, and the combination is
        what produces this outcome. ``categories.name`` is plain ``TEXT`` under a
        **case-sensitive** unique constraint, so ``"Edge Cases"`` and ``"edge cases"`` are two
        different names and neither conflicts with the other. ``categories.slug`` is ``CITEXT``
        under a unique index, so both would derive the same slug - and ``unique_slug`` compares
        case-insensitively and suffixes the second one instead of letting the insert fail.

        Asserted as the real contract rather than as an assumed 409: the second creation succeeds,
        and the two rows are distinguishable by slug. That is what keeps both canonical URLs
        resolvable, which a rejected creation would not.
        """
        first = await admin_client.post(f"{ADMIN_PREFIX}/categories", json={"name": "Edge Cases"})
        assert first.status_code == HTTPStatus.CREATED
        assert first.json()["slug"] == "edge-cases"

        response = await admin_client.post(
            f"{ADMIN_PREFIX}/categories", json={"name": "edge cases"}
        )

        assert response.status_code == HTTPStatus.CREATED
        body = response.json()
        assert_category_public_shape(body)
        assert body["name"] == "edge cases"
        assert body["slug"] != first.json()["slug"]
        assert body["slug"].startswith("edge-cases")
        assert body["id"] != first.json()["id"]

    async def test_a_created_category_appears_in_the_public_taxonomy(
        self, admin_client: AsyncClient, client: AsyncClient
    ) -> None:
        """An administrative write is immediately readable through the public listing.

        Cross-checking the write against the read the home-page filter actually consumes. Note the
        public collection is a **bare JSON array**, not a page envelope - the one documented
        exception to the pagination contract, because the taxonomy is small and bounded and the
        filter control wants all of it at once.
        """
        created = await admin_client.post(
            f"{ADMIN_PREFIX}/categories", json={"name": "Public Crosscheck"}
        )
        category_id = created.json()["id"]

        response = await client.get("/api/v1/categories")

        assert response.status_code == HTTPStatus.OK
        payload = response.json()
        assert isinstance(payload, list), "the public taxonomy is a bare array, not an envelope"
        found = [item for item in payload if item["id"] == category_id]
        assert len(found) == 1
        assert_category_public_shape(found[0])

    async def test_the_administrative_listing_pages_and_searches_the_taxonomy(
        self, admin_client: AsyncClient
    ) -> None:
        """``GET /admin/categories`` is the paged, searchable counterpart to the public array.

        The fourteenth operation in the namespace, and the reason it exists: an administrative
        screen managing a growing taxonomy needs a window and a search term, which the bare public
        array deliberately does not offer.
        """
        created = await admin_client.post(
            f"{ADMIN_PREFIX}/categories", json={"name": "Searchable Taxonomy Entry"}
        )
        category_id = created.json()["id"]

        response = await admin_client.get(
            f"{ADMIN_PREFIX}/categories", params={"q": "Searchable Taxonomy"}
        )

        assert response.status_code == HTTPStatus.OK
        items = assert_page_envelope(response.json())
        assert [item["id"] for item in items] == [category_id]
        assert_category_public_shape(items[0])

    async def test_the_administrative_listing_search_matches_the_slug(
        self, admin_client: AsyncClient
    ) -> None:
        """``?q=`` matches the slug case-insensitively as well as the name."""
        created = await admin_client.post(
            f"{ADMIN_PREFIX}/categories", json={"name": "Slug Matched Taxonomy"}
        )
        slug = created.json()["slug"]

        response = await admin_client.get(f"{ADMIN_PREFIX}/categories", params={"q": slug.upper()})

        items = assert_page_envelope(response.json())
        assert [item["slug"] for item in items] == [slug]

    async def test_the_administrative_listing_includes_the_seeded_reference_set(
        self, admin_client: AsyncClient
    ) -> None:
        """The reference categories revision ``0003`` commits are present before any test runs.

        A lower bound, never an equality: those eight rows are committed by the migration rather
        than by a test, so no rollback removes them and a fresh environment can exercise the
        category filter immediately.
        """
        response = await admin_client.get(f"{ADMIN_PREFIX}/categories", params={"page_size": 100})

        payload = response.json()
        assert_page_envelope(payload)
        assert payload["total"] >= REFERENCE_CATEGORY_COUNT

    async def test_renaming_a_category_keeps_its_slug(self, admin_client: AsyncClient) -> None:
        """A rename changes ``name`` and leaves ``slug`` exactly as it was.

        ``CategoryService.update`` never touches the slug. The slug is the canonical URL SEO
        depends on and is written once at creation, so re-deriving it here would break every link
        already shared - the one outcome a canonical URL exists to prevent. This is the assertion
        that would fail if a well-meaning refactor ever "kept the slug in step with the name".
        """
        created = await admin_client.post(
            f"{ADMIN_PREFIX}/categories", json={"name": "Original Taxonomy Name"}
        )
        category_id, original_slug = created.json()["id"], created.json()["slug"]
        assert original_slug == "original-taxonomy-name"

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/categories/{category_id}",
            json={"name": "Completely Different Name"},
        )

        assert response.status_code == HTTPStatus.OK
        body = response.json()
        assert_category_public_shape(body)
        assert body["name"] == "Completely Different Name"
        assert body["slug"] == original_slug

    async def test_updating_only_the_description_leaves_the_name_and_slug_alone(
        self, admin_client: AsyncClient
    ) -> None:
        """Both members of ``CategoryUpdate`` are optional, so a partial patch is partial."""
        created = await admin_client.post(
            f"{ADMIN_PREFIX}/categories",
            json={"name": "Note Only Taxonomy", "description": "Before."},
        )
        category_id, name, slug = (
            created.json()["id"],
            created.json()["name"],
            created.json()["slug"],
        )

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/categories/{category_id}", json={"description": "After."}
        )

        assert response.status_code == HTTPStatus.OK
        body = response.json()
        assert body["description"] == "After."
        assert body["name"] == name
        assert body["slug"] == slug

    async def test_an_explicit_null_clears_the_description(self, admin_client: AsyncClient) -> None:
        """An explicit ``null`` clears the note, which an omitted member would not.

        ``exclude_unset`` is what separates the two: an absent member means "leave this alone",
        while a present ``null`` is an instruction to clear the column. Without the distinction a
        description could be set but never removed.
        """
        created = await admin_client.post(
            f"{ADMIN_PREFIX}/categories",
            json={"name": "Clearable Taxonomy", "description": "Remove me."},
        )
        category_id = created.json()["id"]

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/categories/{category_id}", json={"description": None}
        )

        assert response.status_code == HTTPStatus.OK
        assert response.json()["description"] is None

    async def test_renaming_onto_an_existing_name_is_a_conflict(
        self, admin_client: AsyncClient
    ) -> None:
        """A rename that collides with another category's name answers 409 and changes nothing."""
        first = await admin_client.post(
            f"{ADMIN_PREFIX}/categories", json={"name": "Taken Taxonomy Name"}
        )
        second = await admin_client.post(
            f"{ADMIN_PREFIX}/categories", json={"name": "Free Taxonomy Name"}
        )
        second_id, second_name = second.json()["id"], second.json()["name"]

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/categories/{second_id}", json={"name": first.json()["name"]}
        )

        assert response.status_code == HTTPStatus.CONFLICT
        assert_problem_document(response.json(), HTTPStatus.CONFLICT)
        readback = await admin_client.get(f"{ADMIN_PREFIX}/categories", params={"q": second_name})
        assert [item["id"] for item in readback.json()["items"]] == [second_id]

    async def test_renaming_a_category_to_its_own_name_is_accepted(
        self, admin_client: AsyncClient
    ) -> None:
        """Re-sending a category's own name is a no-op, not a self-conflict.

        The boundary of the conflict check, which compares the clashing row's identifier against
        the one being updated. Without that comparison a management form that submits every field
        would be unable to save a description edit.
        """
        created = await admin_client.post(
            f"{ADMIN_PREFIX}/categories", json={"name": "Idempotent Taxonomy"}
        )
        category_id, name = created.json()["id"], created.json()["name"]

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/categories/{category_id}",
            json={"name": name, "description": "Edited alongside an unchanged name."},
        )

        assert response.status_code == HTTPStatus.OK
        assert response.json()["name"] == name
        assert response.json()["description"] == "Edited alongside an unchanged name."

    async def test_deleting_an_unused_category_removes_it_everywhere(
        self, admin_client: AsyncClient, client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """``DELETE /admin/categories/{id}`` answers 204, and the public listing loses it too."""
        created = await admin_client.post(
            f"{ADMIN_PREFIX}/categories", json={"name": "Disposable Taxonomy"}
        )
        category_id = created.json()["id"]

        response = await admin_client.delete(f"{ADMIN_PREFIX}/categories/{category_id}")

        assert response.status_code == HTTPStatus.NO_CONTENT
        assert not response.content
        assert await count_rows(db_session, Category.id == uuid.UUID(category_id), Category) == 0
        public = (await client.get("/api/v1/categories")).json()
        assert not any(item["id"] == category_id for item in public)

    async def test_a_category_still_in_use_cannot_be_deleted(
        self,
        admin_client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
    ) -> None:
        """Deleting a category a post is filed under answers 409, and the row survives.

        ``CategoryService.delete`` refuses while ``post_categories`` still references the row,
        rather than cascading the association away and silently unfiling somebody's posts. The
        survival check is the negative control: a 409 raised by a service that had already deleted
        the row would look identical from the status code alone.
        """
        category = await factories.create_category(db_session, name="Occupied Taxonomy")
        await factories.create_published_post(db_session, author=author_user, categories=[category])
        category_id = category.id

        response = await admin_client.delete(f"{ADMIN_PREFIX}/categories/{category_id}")

        assert response.status_code == HTTPStatus.CONFLICT
        assert_problem_document(response.json(), HTTPStatus.CONFLICT)
        assert await count_rows(db_session, Category.id == category_id, Category) == 1

    async def test_a_category_becomes_deletable_once_its_posts_are_gone(
        self,
        admin_client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
    ) -> None:
        """The refusal tracks current use: once the posts are gone, the delete succeeds.

        The pair to the test above. Without this, a passing in-use test would be consistent with a
        category that could never be deleted at all, which would make the taxonomy unmanageable.
        """
        category = await factories.create_category(db_session, name="Temporarily Occupied")
        post = await factories.create_published_post(
            db_session, author=author_user, categories=[category]
        )
        category_id, post_id = category.id, post.id
        refused = await admin_client.delete(f"{ADMIN_PREFIX}/categories/{category_id}")
        assert refused.status_code == HTTPStatus.CONFLICT

        assert (
            await admin_client.delete(f"{ADMIN_PREFIX}/posts/{post_id}")
        ).status_code == HTTPStatus.NO_CONTENT
        response = await admin_client.delete(f"{ADMIN_PREFIX}/categories/{category_id}")

        assert response.status_code == HTTPStatus.NO_CONTENT
        assert await count_rows(db_session, Category.id == category_id, Category) == 0

    async def test_updating_an_unknown_category_is_not_found(
        self, admin_client: AsyncClient
    ) -> None:
        """An identifier addressing no category answers 404 on the update path."""
        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/categories/{uuid.uuid4()}", json={"name": "Nowhere"}
        )

        assert response.status_code == HTTPStatus.NOT_FOUND
        assert_problem_document(response.json(), HTTPStatus.NOT_FOUND)

    async def test_deleting_an_unknown_category_is_not_found(
        self, admin_client: AsyncClient
    ) -> None:
        """An identifier addressing no category answers 404 on the delete path."""
        response = await admin_client.delete(f"{ADMIN_PREFIX}/categories/{uuid.uuid4()}")

        assert response.status_code == HTTPStatus.NOT_FOUND
        assert_problem_document(response.json(), HTTPStatus.NOT_FOUND)

    async def test_a_slug_is_not_accepted_where_an_identifier_is_required(
        self, admin_client: AsyncClient
    ) -> None:
        """Addressing a category by slug answers 422, because these routes take ``{category_id}``.

        A genuinely easy mistake to make, since the public read routes *are* addressed by slug -
        ``GET /api/v1/categories/{slug}``. The administrative routes are not, and the typed path
        parameter refuses the slug at the boundary rather than looking it up in the wrong column.
        """
        created = await admin_client.post(
            f"{ADMIN_PREFIX}/categories", json={"name": "Addressed By Key"}
        )
        slug = created.json()["slug"]

        response = await admin_client.patch(
            f"{ADMIN_PREFIX}/categories/{slug}", json={"name": "Renamed By Slug"}
        )

        assert response.status_code == HTTPStatus.UNPROCESSABLE_CONTENT
        assert_validation_problem(response.json(), field="category_id")

    async def test_the_name_is_required_on_creation(self, admin_client: AsyncClient) -> None:
        """An empty creation body answers 422 naming ``name``, the one required member."""
        response = await admin_client.post(f"{ADMIN_PREFIX}/categories", json={})

        assert response.status_code == HTTPStatus.UNPROCESSABLE_CONTENT
        assert_validation_problem(response.json(), field="name")
