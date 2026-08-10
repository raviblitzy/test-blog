"""Integration tests for the public author profile and the authenticated self-update.

The HTTP surface of AAP requirement **R5** - "Include user profiles showing published
articles" - plus ``PATCH /api/v1/users/me`` from AAP §0.6.2. Three routes are exercised, all
of them through ``httpx`` over the in-process ASGI transport::

    PATCH /api/v1/users/me                 ->  UserMe            (bearer credential)
    GET   /api/v1/users/{username}         ->  UserPublic        (public)
    GET   /api/v1/users/{username}/posts   ->  Page[PostSummary] (public)

Together they discharge the AAP §0.9.4.4 criterion **"Profiles"**: *a profile returns author
identity plus only that author's published posts, paginated.*

No user rules govern this file
-----------------------------
``review_rules`` returns ``No user rules provided.`` - a complete response, not a truncated
window - so **no user-specified rule governs this file and no rule placed it in scope**. It is
in scope solely by the Agent Action Plan's file inventory (§0.4.4.5) and its execution plan
(§0.7.1.11, Group 11). Nothing is invented to fill that gap, and the absence of rules is not
treated as licence to lower the bar: the substitute standard is the AAP's own §0.10.1
enterprise standards, five of which this module tests directly.

* **§0.10.1 #3, server-owned identity and database-enforced integrity.** ``users.username`` is
  ``CITEXT UNIQUE`` (revision ``0001``), so ``/u/Alice`` and ``/u/alice`` are one person. The
  case-insensitivity tests assert that at the HTTP boundary, and they matter *because* nothing
  in Python folds the case: ``UserRepository.get_by_username`` is a bare
  ``get_or_none(User.username == username)``, and the route passes the handle through
  unnormalised. The index is the only thing doing the work, so these are the tests that would
  fail if the column type were ever changed back to ``text``.
* **§0.10.1 #6, secure-by-default authentication.** ``UserPublic`` withholds ``email``,
  ``role``, ``is_active`` and ``password_hash``; ``UserMe`` adds the first three plus
  ``updated_at`` and is returned **only** to the principal describing its own record. Both
  sides of that boundary are asserted, including where ``UserPublic`` is embedded as a post's
  ``author`` - which protects five other surfaces that reuse the same projection.
* **§0.10.1 #4, explicit API contracts.** Every collection here returns the one page envelope
  (``items``, ``total``, ``page``, ``page_size``, ``pages``) and every failure returns the one
  problem document, so a client pages a profile with the same control it pages the feed with.
* **§0.10.1 #1, layered separation.** Every behavioural assertion drives HTTP. Neither
  ``ProfileService`` nor ``UserRepository`` is imported, so a failure here is never ambiguous
  about which layer produced it. ``db_session`` appears only to build fixture state through
  ``tests.factories``.
* **§0.10.1 #8, blocking quality gates.** No ``skip``, no ``xfail``, no placeholder, and no
  ordering assumption. Isolation is the per-test transaction ``backend/tests/conftest.py``
  rolls back; nothing here truncates, and revision ``0003``'s eight reference categories are a
  permanent baseline, so no assertion is phrased as "the database is empty".

The three properties worth reading the file for
-----------------------------------------------
1. **The published-only filter is hard-coded, and that is stricter than the feed.**
   ``ProfileService.list_published_posts`` passes the module constant
   ``PUBLIC_PROFILE_STATUSES``, which is ``(PostStatus.PUBLISHED,)``, and takes neither a
   viewer nor a status argument. So a draft is invisible on a profile to *everyone* - to an
   anonymous crawler, to an administrator, and to the author themselves. That last case looks
   like a bug and is not one, so
   :func:`test_author_sees_own_draft_only_through_the_workspace_never_on_their_profile` asserts
   the contrast directly: the same author, the same draft, absent from both public surfaces -
   ``GET /api/v1/posts?author=<handle>`` and ``GET /api/v1/users/<handle>/posts`` - and present
   only in the private workspace mode ``GET /api/v1/posts?mine=true``. That test is the negative
   control for every other draft assertion in the module: if either public filter were ever
   "fixed" into a viewer-aware predicate, it is the one that would fail loudest.
2. **The self-update cannot reach identity, authority or activation.** ``UserUpdate`` declares
   exactly ``display_name``, ``bio`` and ``avatar_url`` and sets ``extra="forbid"``, so a body
   proposing ``email``, ``username``, ``role``, ``is_active`` or ``id`` is a 422 rather than a
   silent discard. Each attempt is asserted twice - the rejection *and* the absence of any
   effect, re-read through ``GET /api/v1/auth/me`` - because the status code is the contract
   but the effect is the security property, and only the second assertion would survive a
   future decision to ignore unknown members instead of refusing them.
3. **The literal ``/me`` path is declared before any parameterised path, and the order is part
   of the contract.** Starlette serves the first pattern that accepts the URL, so
   ``/{username}`` registered above ``/me`` would capture ``me`` as a handle and make the
   self-update unreachable. The consequence is observable and is asserted: ``PATCH /me``
   updates the caller even when some other account's handle is literally ``me``, while
   ``GET /api/v1/users/me`` - a method the literal path does *not* declare - resolves as a
   username lookup, answering 404 when nobody holds that handle and 200 with that account's
   public profile when somebody does.

Boundaries
----------
This module tests three routes and no others. ``GET /api/v1/auth/me`` is read only to prove
the absence of an effect, ``GET /api/v1/admin/stats`` only to prove authority was not granted,
and ``GET /api/v1/posts`` only for the draft-visibility contrast above; the contracts of all
three belong to their own modules. Registration and the token lifecycle are not re-tested -
``auth_headers_for`` mints a credential directly, which is what keeps a regression in
``POST /api/v1/auth/login`` failing ``test_auth_api.py`` alone. No ``__init__.py`` is added to
the tests tree.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta
from typing import Any, Final

import pytest
from httpx import AsyncClient, Response
from pydantic import HttpUrl, TypeAdapter
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MIN_PAGE, MIN_PAGE_SIZE
from app.core.exceptions import PROBLEM_JSON_MEDIA_TYPE, WWW_AUTHENTICATE_HEADER
from app.models import Post, PostStatus, User, UserRole
from app.schemas.user import BIO_MAX_LENGTH, DISPLAY_NAME_MAX_LENGTH, DISPLAY_NAME_MIN_LENGTH
from tests import factories

# `integration` is one of the two markers `backend/pyproject.toml` registers, and `addopts`
# carries `--strict-markers`, so a misspelling here fails collection rather than being silently
# ignored. Applied at module scope because every test below reaches PostgreSQL through the API.
pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------------------
# Addresses
#
# Built from one prefix constant rather than written out per test, so the versioning
# requirement of AAP §0.9.4.3 - every route under `/api/v1` - is stated once and cannot drift
# between tests. The three sibling routes are named separately because each is read for a
# single, narrow purpose documented at its use site.
# ---------------------------------------------------------------------------------------

_USERS_URL: Final[str] = "/api/v1/users"
_SELF_UPDATE_URL: Final[str] = f"{_USERS_URL}/me"
_AUTH_ME_URL: Final[str] = "/api/v1/auth/me"
_ADMIN_STATS_URL: Final[str] = "/api/v1/admin/stats"
_FEED_URL: Final[str] = "/api/v1/posts"

#: The handle whose literal path segment collides with the self-update route. A test creates an
#: account holding it, which is the only way to observe the route-ordering consequence.
_ME_HANDLE: Final[str] = "me"

#: A handle no account holds. Deliberately unclaimable-looking rather than merely unused, so a
#: factory-generated `user<n>` can never collide with it however many accounts a test creates.
_UNCLAIMED_HANDLE: Final[str] = "nobody-holds-this-handle"

#: A path segment carrying `U+0000`, the one character neither `text` nor `citext` can
#: represent. It is not an unclaimable handle - it is a value the comparison cannot be
#: performed on at all - so both read routes answer 422 rather than 404. Percent-encoded
#: because a raw NUL cannot travel in a request line.
_NUL_HANDLE: Final[str] = "a%00b"


def _profile_url(username: str) -> str:
    """Return the address of one account's public profile.

    Args:
        username: The handle, in whatever case the caller wants to address it in.

    Returns:
        The path ``GET /api/v1/users/{username}`` is served at.
    """
    return f"{_USERS_URL}/{username}"


def _profile_posts_url(username: str) -> str:
    """Return the address of one account's published-post listing.

    Args:
        username: The handle, in whatever case the caller wants to address it in.

    Returns:
        The path ``GET /api/v1/users/{username}/posts`` is served at.
    """
    return f"{_USERS_URL}/{username}/posts"


# ---------------------------------------------------------------------------------------
# The projections, as key sets
#
# Written as frozensets and compared with `==` rather than with a series of `in` checks,
# because the whole point of `UserPublic` is the four members it does NOT carry. A membership
# test would pass just as happily if `email` were added tomorrow; set equality fails.
# ---------------------------------------------------------------------------------------

_USER_PUBLIC_FIELDS: Final[frozenset[str]] = frozenset(
    {"id", "username", "display_name", "bio", "avatar_url", "created_at"}
)
"""Every member ``app.schemas.user.UserPublic`` declares, and nothing else."""

_USER_ME_EXTRA_FIELDS: Final[frozenset[str]] = frozenset(
    {"email", "role", "is_active", "updated_at"}
)
"""The four members ``UserMe`` adds to the public projection for the principal itself."""

_USER_ME_FIELDS: Final[frozenset[str]] = _USER_PUBLIC_FIELDS | _USER_ME_EXTRA_FIELDS
"""Every member ``app.schemas.user.UserMe`` declares."""

_WITHHELD_FROM_PUBLIC: Final[frozenset[str]] = frozenset(
    {"email", "role", "is_active", "password_hash"}
)
"""What a public projection must never publish - the confidentiality boundary of §0.10.1 #6.

``password_hash`` is listed beside the other three although no schema in the project declares
it, and that is the point: it is a column on ``users``, so a hand-built payload or a projection
widened to the mapped entity would expose it. Asserting its absence is what makes the test fail
if the route ever stops going through ``UserPublic``.
"""

_POST_SUMMARY_FIELDS: Final[frozenset[str]] = frozenset(
    {
        "id",
        "title",
        "slug",
        "excerpt",
        "cover_image_url",
        "status",
        "published_at",
        "view_count",
        "created_at",
        "author",
        "categories",
    }
)
"""Every member ``app.schemas.post.PostSummary`` declares.

``content`` is absent by design - a profile page renders cards, not documents, and
``posts.content`` is unbounded ``TEXT`` - and so is ``updated_at``. The repository's ``summary``
projection defers both columns, so a listing that published them would also have fetched them.
"""

_CATEGORY_SUMMARY_FIELDS: Final[frozenset[str]] = frozenset({"id", "name", "slug"})
"""Every member ``app.schemas.category.CategorySummary`` declares."""

_PAGE_FIELDS: Final[frozenset[str]] = frozenset({"items", "total", "page", "page_size", "pages"})
"""The one page envelope, shared by the feed, the profile listing and the admin tables."""

_PROBLEM_MEMBERS: Final[frozenset[str]] = frozenset(
    {"type", "title", "status", "detail", "instance"}
)
"""The members every error body in this API carries.

``errors`` is optional and present on a validation failure; ``request_id`` is added by the
middleware. Both are extras, so this set is asserted as a subset rather than as an equality.
"""


# ---------------------------------------------------------------------------------------
# Assertion helpers
#
# Each one states a contract that is asserted many times, so the contract is written once. They
# live in this module rather than in `conftest.py` because each is specific to these three
# routes; a helper shared by every integration module would belong there instead.
# ---------------------------------------------------------------------------------------


def _problem_document(response: Response, status_code: int) -> dict[str, Any]:
    """Assert ``response`` is the API's one problem document and return its body.

    AAP §0.9.4.3 requires every error response to be the same shape, replacing the three
    duplicated ad-hoc raises the retired ``/items`` surface used. Checking the media type as
    well as the members is deliberate: a body that happened to carry the right keys but was
    served as ``application/json`` would not be the documented contract.

    Args:
        response: The response to inspect.
        status_code: The status the caller expects, asserted both on the wire and inside the
            document, because a document whose ``status`` disagreed with its own response line
            would break every client that reads one of the two.

    Returns:
        The decoded body, so a caller can go on to assert on ``detail`` or ``errors``.
    """
    assert response.status_code == status_code
    assert response.headers["content-type"].startswith(PROBLEM_JSON_MEDIA_TYPE)
    body: dict[str, Any] = response.json()
    assert set(body) >= _PROBLEM_MEMBERS
    assert body["status"] == status_code
    return body


def _rejected_fields(response: Response) -> set[str]:
    """Assert ``response`` is a 422 with a populated ``errors`` list and return the fields named.

    The 422 contract is two-part: the uniform document, plus per-member detail under ``errors``
    that tells a caller which member to fix. A 422 with an empty ``errors`` list would satisfy
    the first half and be useless for the second, so emptiness is asserted here rather than
    left to each call site.

    Args:
        response: The response to inspect.

    Returns:
        The set of member names the document rejected.
    """
    body = _problem_document(response, 422)
    errors: list[dict[str, Any]] = body["errors"]
    assert errors
    return {entry["field"] for entry in errors}


def _item_ids(body: dict[str, Any]) -> list[str]:
    """Return the identifiers on one page, in the order the API returned them.

    A list rather than a set, because two properties are asserted about these values: which
    rows came back, and in what order. Callers that only care about membership wrap the result
    in ``set()`` at the point of use, which keeps the ordering assertions honest.

    Args:
        body: A decoded page envelope.

    Returns:
        The ``id`` of every item, in wire order.
    """
    return [item["id"] for item in body["items"]]


def _assert_public_projection(payload: dict[str, Any]) -> None:
    """Assert ``payload`` is exactly ``UserPublic`` and withholds every private member.

    Called for a top-level profile response and for the ``author`` embedded in a
    ``PostSummary``, because ``UserPublic`` is the only user projection permitted inside another
    resource and it is the same declaration in both places. One helper therefore protects both
    surfaces - and, through the same declaration, ``PostDetail``, ``CommentPublic``,
    ``AdminPost`` and ``AdminComment`` as well.

    Args:
        payload: A decoded user projection.
    """
    assert set(payload) == _USER_PUBLIC_FIELDS
    assert _WITHHELD_FROM_PUBLIC.isdisjoint(payload)


def _assert_self_projection(payload: dict[str, Any]) -> None:
    """Assert ``payload`` is exactly ``UserMe``: the public members plus the caller's own four.

    The other side of the same boundary. ``UserMe`` is returned only to the authenticated
    principal for its own record, so this helper asserts that the four wider members ARE present
    - a projection that quietly narrowed to ``UserPublic`` would be a broken settings screen -
    while ``password_hash`` remains absent, because no projection anywhere may publish it.

    Args:
        payload: A decoded self projection, from ``PATCH /api/v1/users/me`` or
            ``GET /api/v1/auth/me``.
    """
    assert set(payload) == _USER_ME_FIELDS
    assert set(payload) >= _USER_ME_EXTRA_FIELDS
    assert "password_hash" not in payload


# =======================================================================================
# Phase A - the public profile read
#
# `GET /api/v1/users/{username}` backs the client's server-rendered, crawled `/u/{username}`
# route, so its projection is a published confidentiality boundary rather than an internal
# detail. Every test in this block is about what the response does or does not carry.
# =======================================================================================


async def test_public_profile_returns_the_public_projection(
    client: AsyncClient,
    author_user: User,
) -> None:
    """AAP §0.9.4.4 "Profiles": a profile returns the author's identity, as ``UserPublic``."""
    response = await client.get(_profile_url(author_user.username))

    assert response.status_code == 200
    body = response.json()
    _assert_public_projection(body)
    assert body["id"] == str(author_user.id)
    assert body["username"] == author_user.username
    assert body["display_name"] == author_user.display_name


async def test_public_profile_withholds_email_role_activation_and_password_hash(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """AAP §0.10.1 #6: a profile view never discloses an address, a privilege or a hash."""
    # An ADMIN with a populated bio and avatar, so the assertion cannot pass by accident: the
    # account genuinely has a role worth hiding and genuinely has every public member set.
    account = await factories.create_user(
        db_session,
        role=UserRole.ADMIN,
        bio="Runs the place.",
        avatar_url="https://example.com/avatars/admin.png",
    )

    response = await client.get(_profile_url(account.username))

    assert response.status_code == 200
    body = response.json()
    assert set(body) == _USER_PUBLIC_FIELDS
    for withheld in sorted(_WITHHELD_FROM_PUBLIC):
        assert withheld not in body
    # The public members are present and correct, which is what distinguishes "withheld" from
    # "the projection is broken and returns almost nothing".
    assert body["bio"] == account.bio
    assert body["avatar_url"] == account.avatar_url


async def test_public_profile_requires_no_credential(
    client: AsyncClient,
    author_user: User,
) -> None:
    """AAP §0.6.2 declares this route public: an anonymous crawler must reach it."""
    response = await client.get(_profile_url(author_user.username))

    # Asserted on the request that was actually sent rather than trusting the fixture: the
    # shared `client` carries no default headers, and this is what proves it for this call.
    assert "authorization" not in response.request.headers
    assert response.status_code == 200
    _assert_public_projection(response.json())


async def test_public_profile_of_another_account_is_not_widened_by_authentication(
    client: AsyncClient,
    author_user: User,
    reader_user: User,
    auth_headers_for: Any,
) -> None:
    """AAP §0.10.1 #6: holding a credential does not widen someone else's projection."""
    anonymous = await client.get(_profile_url(author_user.username))
    authenticated = await client.get(
        _profile_url(author_user.username),
        headers=auth_headers_for(reader_user),
    )

    assert authenticated.status_code == 200
    _assert_public_projection(authenticated.json())
    # Byte-for-byte identical to the anonymous read. `UserMe` is reachable only through
    # `GET /api/v1/auth/me` and `PATCH /api/v1/users/me`, both of which describe the caller's
    # own record; no route returns another account's email or role to a non-administrator.
    assert authenticated.json() == anonymous.json()


async def test_unknown_username_answers_the_not_found_problem_document(
    client: AsyncClient,
) -> None:
    """AAP §0.9.4.3: a handle nobody holds is a 404 in the one uniform error shape."""
    response = await client.get(_profile_url(_UNCLAIMED_HANDLE))

    body = _problem_document(response, 404)
    assert body["instance"] == _profile_url(_UNCLAIMED_HANDLE)
    assert body["detail"]


async def test_deactivated_account_profile_answers_404_rather_than_a_flag(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """``ProfileService.get_profile`` raises ``NotFoundError`` for an unknown *or* deactivated
    account, so a suspended account stops being published rather than publishing a flag."""
    suspended = await factories.create_user(db_session, is_active=False)

    response = await client.get(_profile_url(suspended.username))

    _problem_document(response, 404)


async def test_deactivated_account_post_listing_answers_404_too(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Both halves of one profile share ``_require_visible_author``, so they agree on 404.

    The two endpoints resolving visibility differently would be the defect this asserts against:
    a profile that 404s while its post listing renders an empty page would still confirm that
    the suspended account exists.
    """
    suspended = await factories.create_user(db_session, is_active=False)
    await factories.create_post(db_session, author=suspended, status=PostStatus.PUBLISHED)

    response = await client.get(_profile_posts_url(suspended.username))

    _problem_document(response, 404)


async def test_deactivated_and_unclaimed_handles_are_indistinguishable(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The 404 for a suspended account is worded identically to the one for a free handle.

    Deliberate, and asserted: a distinguishable answer would turn the endpoint into an oracle
    telling an anonymous caller which handles exist as suspended accounts.
    """
    suspended = await factories.create_user(db_session, is_active=False)

    suspended_response = await client.get(_profile_url(suspended.username))
    unclaimed_response = await client.get(_profile_url(_UNCLAIMED_HANDLE))

    suspended_body = _problem_document(suspended_response, 404)
    unclaimed_body = _problem_document(unclaimed_response, 404)
    assert suspended_body["detail"] == unclaimed_body["detail"]
    assert suspended_body["title"] == unclaimed_body["title"]
    assert suspended_body["type"] == unclaimed_body["type"]


@pytest.mark.parametrize("url", [_profile_url(_NUL_HANDLE), _profile_posts_url(_NUL_HANDLE)])
async def test_both_reads_refuse_a_handle_no_citext_column_can_hold(
    client: AsyncClient,
    url: str,
) -> None:
    """A handle carrying ``U+0000`` is a 422 naming ``username``, not a 404 and not a 500.

    ``_UsernamePath`` carries ``StorableText`` and no length rule, which is why every other
    unclaimable handle answers 404: length is a property of what may be *registered*. A NUL is
    the one exception, because ``citext`` cannot represent it, so the comparison could not be
    performed at all - and without the guard the read became a 500 an anonymous caller could
    provoke at will.
    """
    response = await client.get(url)

    assert "username" in _rejected_fields(response)


# =======================================================================================
# Phase B - CITEXT case-insensitivity (AAP §0.10.1 #3)
#
# `users.username` is `CITEXT UNIQUE`, established by revision `0001`, and neither the route
# nor `UserRepository.get_by_username` folds the case in Python. So these tests assert a
# guarantee the database holds on its own, and they are what would fail if the column type were
# changed or if a well-meaning `.lower()` were added in one of the two places but not the other.
# The same property is what makes `/u/Alice` and `/u/alice` one person on the frontend.
# =======================================================================================


async def test_profile_resolves_by_any_casing_of_the_handle(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """AAP §0.10.1 #3: three casings of one handle resolve to one account through ``citext``."""
    account = await factories.create_user(
        db_session,
        username="MixedCaseAuthor",
        role=UserRole.AUTHOR,
    )

    responses = [
        await client.get(_profile_url(spelling))
        for spelling in (
            account.username,
            account.username.upper(),
            account.username.lower(),
        )
    ]

    assert [response.status_code for response in responses] == [200, 200, 200]
    # One account, addressed three ways. Identity is compared rather than the whole body,
    # because `username` is echoed back as the column stores it and not as the URL spelled it.
    assert {response.json()["id"] for response in responses} == {str(account.id)}


async def test_profile_post_listing_resolves_by_any_casing_of_the_handle(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A case variant lists the same author's posts, because the same index resolves both."""
    account = await factories.create_user(
        db_session,
        username="MixedCasePoster",
        role=UserRole.AUTHOR,
    )
    published = await factories.create_post(
        db_session,
        author=account,
        status=PostStatus.PUBLISHED,
    )

    exact = await client.get(_profile_posts_url(account.username))
    shouted = await client.get(_profile_posts_url(account.username.upper()))

    assert exact.status_code == 200
    assert shouted.status_code == 200
    assert exact.json()["total"] == shouted.json()["total"] == 1
    assert _item_ids(shouted.json()) == [str(published.id)]


# =======================================================================================
# Phase C - the published-only hard filter
#
# `ProfileService.list_published_posts` passes `PUBLIC_PROFILE_STATUSES`, a module-level
# `Final` tuple holding `PostStatus.PUBLISHED` and nothing else, and its signature accepts
# neither a viewer nor a status argument. So "a draft never appears on a public profile" holds
# by CONSTRUCTION rather than by a predicate that has to be evaluated correctly on every path.
#
# The tests below assert that for all three callers the AAP names - anonymous, the author
# themselves, and an administrator - and against every query-parameter shape a caller might try.
# The author case is the surprising one and it is intentional: see
# `test_author_sees_own_draft_only_through_the_workspace_never_on_their_profile`, which asserts the
# contrast with the private workspace mode and is the negative control for this whole block.
# =======================================================================================

#: Query parameters a caller might reach for to widen a profile listing. None of them is
#: declared on the route, so each is ignored rather than honoured - but the assertion that
#: matters is not the status code, it is that no draft and no archived post appears in any case.
_ATTEMPTED_STATUS_OVERRIDES: Final[tuple[tuple[str, str], ...]] = (
    ("status", PostStatus.DRAFT.value),
    ("status", PostStatus.DRAFT.value.lower()),
    ("status", PostStatus.ARCHIVED.value),
    ("statuses", f"{PostStatus.DRAFT.value},{PostStatus.PUBLISHED.value}"),
    ("include_drafts", "true"),
    ("include_unpublished", "1"),
)


async def _seed_one_of_each_lifecycle_state(
    session: AsyncSession,
    author: User,
) -> tuple[Post, Post, Post]:
    """Create one ``PUBLISHED``, one ``DRAFT`` and one ``ARCHIVED`` post for ``author``.

    The corpus every filter assertion in this block needs, built once so that each test states
    only the caller it is about. Titles are explicit so a failure transcript names which row
    leaked rather than showing a generated sentence.

    ``published_at`` is left to the factory for the published row, which stamps an aware UTC
    instant because ``ck_posts_published_at_required`` would otherwise reject it. It is
    explicitly ``None`` for the archived row: nothing requires an archived post to have ever
    been public, and a stamped instant there would make the column useless as a "has this ever
    been published?" test.

    Args:
        session: The transaction-scoped session.
        author: The account every created post belongs to.

    Returns:
        The published, draft and archived posts, in that order.
    """
    published = await factories.create_post(
        session,
        author=author,
        title="Published And Therefore Visible",
        status=PostStatus.PUBLISHED,
    )
    draft = await factories.create_post(
        session,
        author=author,
        title="Draft And Therefore Invisible",
        status=PostStatus.DRAFT,
    )
    archived = await factories.create_post(
        session,
        author=author,
        title="Archived And Therefore Invisible",
        status=PostStatus.ARCHIVED,
        published_at=None,
    )
    return published, draft, archived


async def test_profile_posts_lists_only_published_posts_for_an_anonymous_caller(
    client: AsyncClient,
    author_user: User,
    db_session: AsyncSession,
) -> None:
    """AAP §0.9.4.4 "Draft confidentiality": a crawler sees published posts and nothing else."""
    published, draft, archived = await _seed_one_of_each_lifecycle_state(db_session, author_user)

    response = await client.get(_profile_posts_url(author_user.username))

    assert response.status_code == 200
    body = response.json()
    assert _item_ids(body) == [str(published.id)]
    # `total` is the unwindowed count, so it is the value a leak would inflate even if the
    # leaked row happened to fall outside the first page.
    assert body["total"] == 1
    returned = set(_item_ids(body))
    assert str(draft.id) not in returned
    assert str(archived.id) not in returned
    for item in body["items"]:
        assert item["status"] == PostStatus.PUBLISHED


async def test_profile_posts_hide_unpublished_work_from_its_own_author(
    author_client: AsyncClient,
    author_user: User,
    db_session: AsyncSession,
) -> None:
    """The filter is hard-coded, not viewer-aware: an author's own drafts are absent here too.

    Stricter than the feed on purpose. ``list_published_posts`` takes no viewer, so there is no
    parameter through which the author could be recognised - and therefore no branch a later
    edit could add that would leak a draft onto a crawled page.
    """
    published, draft, archived = await _seed_one_of_each_lifecycle_state(db_session, author_user)

    response = await author_client.get(_profile_posts_url(author_user.username))

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert _item_ids(body) == [str(published.id)]
    returned = set(_item_ids(body))
    assert str(draft.id) not in returned
    assert str(archived.id) not in returned


async def test_profile_posts_hide_unpublished_work_from_an_administrator(
    admin_client: AsyncClient,
    author_user: User,
    db_session: AsyncSession,
) -> None:
    """An administrator sees exactly what an anonymous crawler sees on a profile.

    Administrators reach every lifecycle state through ``GET /api/v1/admin/posts``, which sits
    behind the router-level ``require_admin``. A profile URL resolves no principal at all, which
    is precisely why the set it may return is a constant rather than something computed from one.
    """
    published, draft, archived = await _seed_one_of_each_lifecycle_state(db_session, author_user)

    response = await admin_client.get(_profile_posts_url(author_user.username))

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert _item_ids(body) == [str(published.id)]
    returned = set(_item_ids(body))
    assert str(draft.id) not in returned
    assert str(archived.id) not in returned


@pytest.mark.parametrize(("parameter", "value"), _ATTEMPTED_STATUS_OVERRIDES)
async def test_profile_posts_cannot_be_widened_by_a_query_parameter(
    author_client: AsyncClient,
    author_user: User,
    db_session: AsyncSession,
    parameter: str,
    value: str,
) -> None:
    """AAP R5: there is no caller-supplied status override on a profile listing.

    Run as the author, which is the strongest form of the test: the one caller who might
    plausibly be widened is the one who cannot widen themselves. The route declares no such
    parameter, so each attempt is ignored and answers 200 - but the assertion that matters is
    that the unpublished rows stay absent whatever the status code turns out to be.
    """
    published, draft, archived = await _seed_one_of_each_lifecycle_state(db_session, author_user)

    response = await author_client.get(
        _profile_posts_url(author_user.username),
        params={parameter: value},
    )

    assert response.status_code == 200
    body = response.json()
    returned = set(_item_ids(body))
    assert str(draft.id) not in returned
    assert str(archived.id) not in returned
    assert returned == {str(published.id)}
    assert body["total"] == 1


async def test_profile_posts_exclude_posts_by_other_authors(
    client: AsyncClient,
    author_user: User,
    other_author_user: User,
    db_session: AsyncSession,
) -> None:
    """A profile listing is scoped to one author, so a sibling author's work never appears."""
    mine = await factories.create_post(
        db_session,
        author=author_user,
        status=PostStatus.PUBLISHED,
    )
    theirs = await factories.create_post(
        db_session,
        author=other_author_user,
        status=PostStatus.PUBLISHED,
    )

    response = await client.get(_profile_posts_url(author_user.username))

    assert response.status_code == 200
    body = response.json()
    assert _item_ids(body) == [str(mine.id)]
    assert str(theirs.id) not in set(_item_ids(body))
    # And symmetrically, so the test cannot pass merely because one author's page is empty.
    sibling = await client.get(_profile_posts_url(other_author_user.username))
    assert _item_ids(sibling.json()) == [str(theirs.id)]


async def test_profile_post_summary_omits_the_post_body(
    client: AsyncClient,
    author_user: User,
    db_session: AsyncSession,
) -> None:
    """``PostSummary`` carries no ``content``: a profile renders cards, not documents."""
    await factories.create_post(
        db_session,
        author=author_user,
        content="A body long enough to be worth not transferring on a listing page.",
        status=PostStatus.PUBLISHED,
    )

    response = await client.get(_profile_posts_url(author_user.username))

    assert response.status_code == 200
    item = response.json()["items"][0]
    # Set equality rather than `"content" not in item`, because the second would keep passing if
    # some other unbudgeted column were added to the projection later.
    assert set(item) == _POST_SUMMARY_FIELDS
    assert "content" not in item


async def test_profile_post_summary_embeds_only_the_public_author_projection(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """AAP §0.10.1 #6: the embedded ``author`` is ``UserPublic``, so no email or role leaks.

    ``UserPublic`` is the only user projection permitted inside another resource, which is why
    asserting its boundary on this one surface protects ``PostSummary``, ``PostDetail``,
    ``CommentPublic``, ``AdminPost`` and ``AdminComment`` at the same time.
    """
    account = await factories.create_user(db_session, role=UserRole.ADMIN)
    await factories.create_post(db_session, author=account, status=PostStatus.PUBLISHED)

    response = await client.get(_profile_posts_url(account.username))

    assert response.status_code == 200
    author_payload = response.json()["items"][0]["author"]
    _assert_public_projection(author_payload)
    assert author_payload["id"] == str(account.id)


async def test_profile_post_summary_carries_category_summaries(
    client: AsyncClient,
    author_user: User,
    db_session: AsyncSession,
) -> None:
    """A filed post publishes its categories as ``CategorySummary`` - the badge contract."""
    category = await factories.create_category(db_session, name="Profile Filing Example")
    await factories.create_post(
        db_session,
        author=author_user,
        status=PostStatus.PUBLISHED,
        categories=[category],
    )

    response = await client.get(_profile_posts_url(author_user.username))

    assert response.status_code == 200
    categories = response.json()["items"][0]["categories"]
    assert len(categories) == 1
    assert set(categories[0]) == _CATEGORY_SUMMARY_FIELDS
    assert categories[0]["id"] == str(category.id)
    assert categories[0]["name"] == category.name
    assert categories[0]["slug"] == category.slug


async def test_profile_posts_are_ordered_newest_first(
    client: AsyncClient,
    author_user: User,
    db_session: AsyncSession,
) -> None:
    """A profile listing sorts by ``published_at`` descending, then by ``posts.id`` descending.

    Publication instants are supplied explicitly and a day apart, because rows created inside
    one transaction share PostgreSQL's transaction clock: left to the factory's default they
    would all carry the same instant and the assertion would be testing the tie-breaker instead.
    """
    base = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    oldest, middle, newest = [
        await factories.create_post(
            db_session,
            author=author_user,
            title=f"Ordered Post {offset}",
            status=PostStatus.PUBLISHED,
            published_at=base + timedelta(days=offset),
        )
        for offset in range(3)
    ]

    response = await client.get(_profile_posts_url(author_user.username))

    assert response.status_code == 200
    assert _item_ids(response.json()) == [str(newest.id), str(middle.id), str(oldest.id)]


async def test_author_sees_own_draft_only_through_the_workspace_never_on_their_profile(
    author_client: AsyncClient,
    author_user: User,
    db_session: AsyncSession,
) -> None:
    """The negative control for every draft assertion above: both public surfaces are strict.

    One author, one draft, three surfaces, one credential. Neither public surface is
    viewer-aware: the profile listing passes the constant ``PUBLIC_PROFILE_STATUSES``, and the
    public feed passes ``PUBLIC_POST_STATUSES`` for every caller including the author. The draft
    is reachable only where the author asks for it, in the private ``?mine=true`` workspace mode.
    If either public filter were ever "corrected" into a viewer-aware predicate, this is the test
    that fails, and the three surfaces side by side are what make the design legible rather than
    looking like an oversight.
    """
    draft = await factories.create_post(
        db_session,
        author=author_user,
        title="Visible In The Workspace Only",
        status=PostStatus.DRAFT,
    )
    published = await factories.create_post(
        db_session,
        author=author_user,
        status=PostStatus.PUBLISHED,
    )

    feed = await author_client.get(_FEED_URL, params={"author": author_user.username})
    profile = await author_client.get(_profile_posts_url(author_user.username))
    workspace = await author_client.get(_FEED_URL, params={"mine": "true"})

    assert feed.status_code == 200
    assert profile.status_code == 200
    assert workspace.status_code == 200
    # Unreachable on the public feed, even to its own author with a credential presented...
    assert str(draft.id) not in set(_item_ids(feed.json()))
    # ...unreachable on the profile with that same credential...
    assert str(draft.id) not in set(_item_ids(profile.json()))
    assert _item_ids(profile.json()) == [str(published.id)]
    # ...and reachable only where the author asked for it.
    assert str(draft.id) in set(_item_ids(workspace.json()))


# =======================================================================================
# Phase D - pagination
#
# The profile listing returns the SAME envelope as `GET /api/v1/posts` and as every admin
# listing - `items`, `total`, `page`, `page_size`, `pages` - which is the whole reason one
# client pagination component serves all three (AAP §0.9.4.3). The arithmetic lives once, in
# `app.core.pagination.build_page`, so these tests assert the contract rather than a formula
# reimplemented here: `pages` is compared against `math.ceil` computed from the values the
# response itself reports.
#
# Window bounds are enforced by `PageParams` as FastAPI query validation, which means an
# out-of-range window is a 422 and is NOT clamped. A page past the last one is a different
# thing entirely and is a 200 with an empty `items` list, so a client can tell it has run off
# the end rather than being silently served the last page again.
# =======================================================================================

#: Enough published posts to span three pages at `_SMALL_PAGE_SIZE`, with a short final page -
#: 7 at 3 gives 3 + 3 + 1, so the arithmetic exercises the rounding rather than dividing evenly.
_PAGINATION_CORPUS_SIZE: Final[int] = 7

#: A window small enough that three pages fit inside a test without seeding a hundred rows.
_SMALL_PAGE_SIZE: Final[int] = 3


async def _seed_published_posts(
    session: AsyncSession,
    author: User,
    count: int,
) -> list[Post]:
    """Create ``count`` published posts for ``author`` and return them in creation order.

    Publication instants are supplied explicitly and spaced a minute apart, so the listing has a
    genuine recency order to page through. Left to the factory they would share one transaction
    clock, and the window would then be ordered entirely by the ``posts.id`` tie-breaker - which
    is still a total order and still disjoint, but it would stop this corpus from exercising the
    primary sort key at all.

    Args:
        session: The transaction-scoped session.
        author: The account every created post belongs to.
        count: How many posts to create.

    Returns:
        The created posts, oldest publication instant first.
    """
    base = datetime(2026, 3, 1, 9, 0, tzinfo=UTC)
    return [
        await factories.create_post(
            session,
            author=author,
            title=f"Paged Post {index:02d}",
            status=PostStatus.PUBLISHED,
            published_at=base + timedelta(minutes=index),
        )
        for index in range(count)
    ]


async def test_profile_posts_return_the_uniform_page_envelope(
    client: AsyncClient,
    author_user: User,
    db_session: AsyncSession,
) -> None:
    """AAP §0.9.4.3: every collection carries ``items``, ``total``, ``page``, ``page_size``,
    ``pages`` - and nothing else."""
    await _seed_published_posts(db_session, author_user, _PAGINATION_CORPUS_SIZE)

    response = await client.get(
        _profile_posts_url(author_user.username),
        params={"page": MIN_PAGE, "page_size": _SMALL_PAGE_SIZE},
    )

    assert response.status_code == 200
    body = response.json()
    assert set(body) == _PAGE_FIELDS
    assert body["total"] == _PAGINATION_CORPUS_SIZE
    # Echoed back verbatim, which is what lets a client recognise the window it asked for.
    assert body["page"] == MIN_PAGE
    assert body["page_size"] == _SMALL_PAGE_SIZE
    # Derived from the response's own numbers rather than from a hard-coded 3, so the assertion
    # states `pages == ceil(total / page_size)` and not merely "pages happens to be three".
    assert body["pages"] == math.ceil(body["total"] / body["page_size"])
    assert len(body["items"]) == _SMALL_PAGE_SIZE


async def test_profile_posts_pages_are_disjoint_and_together_cover_the_collection(
    client: AsyncClient,
    author_user: User,
    db_session: AsyncSession,
) -> None:
    """Paging is stable: page two shares nothing with page one and no row is skipped.

    The ordering ends in ``posts.id`` descending, which makes it a total order even when several
    rows share a publication instant. Without that final key two rows with equal sort keys could
    be returned by both page one and page two while a third was returned by neither - the classic
    overlapping-pagination defect this test exists to catch.
    """
    seeded = await _seed_published_posts(db_session, author_user, _PAGINATION_CORPUS_SIZE)
    expected = {str(post.id) for post in seeded}

    collected: list[str] = []
    pages_walked = 0
    for page in range(MIN_PAGE, MIN_PAGE + math.ceil(_PAGINATION_CORPUS_SIZE / _SMALL_PAGE_SIZE)):
        response = await client.get(
            _profile_posts_url(author_user.username),
            params={"page": page, "page_size": _SMALL_PAGE_SIZE},
        )
        assert response.status_code == 200
        body = response.json()
        page_ids = _item_ids(body)
        # Disjointness, asserted page by page as the walk proceeds: an overlap is caught against
        # everything already seen rather than only against the immediately preceding page.
        assert set(page_ids).isdisjoint(collected)
        collected.extend(page_ids)
        pages_walked += 1

    assert pages_walked == math.ceil(_PAGINATION_CORPUS_SIZE / _SMALL_PAGE_SIZE)
    # No duplicate anywhere in the walk, and the union is exactly the corpus - so nothing was
    # served twice and nothing was skipped.
    assert len(collected) == len(set(collected))
    assert set(collected) == expected


async def test_profile_posts_page_beyond_the_last_is_an_empty_page_not_an_error(
    client: AsyncClient,
    author_user: User,
    db_session: AsyncSession,
) -> None:
    """A page past the end answers 200 with empty ``items`` beside the real ``total``/``pages``.

    Part of the uniform contract: the requested ``page`` is echoed rather than clamped, so a
    client can tell it has run off the end instead of being handed the last page again and
    looping forever.
    """
    await _seed_published_posts(db_session, author_user, _PAGINATION_CORPUS_SIZE)
    beyond = _PAGINATION_CORPUS_SIZE + MIN_PAGE

    response = await client.get(
        _profile_posts_url(author_user.username),
        params={"page": beyond, "page_size": _SMALL_PAGE_SIZE},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["items"] == []
    assert body["page"] == beyond
    assert body["total"] == _PAGINATION_CORPUS_SIZE
    assert body["pages"] == math.ceil(_PAGINATION_CORPUS_SIZE / _SMALL_PAGE_SIZE)


async def test_profile_posts_apply_the_declared_default_window(
    client: AsyncClient,
    author_user: User,
    db_session: AsyncSession,
) -> None:
    """An unspecified window is ``PageParams``' own default, not an unbounded read."""
    await _seed_published_posts(db_session, author_user, _PAGINATION_CORPUS_SIZE)

    response = await client.get(_profile_posts_url(author_user.username))

    assert response.status_code == 200
    body = response.json()
    # Compared against the constants `app.core.dependencies` declares rather than against 1 and
    # 20, so this test tracks the contract if either default is ever retuned.
    assert body["page"] == MIN_PAGE
    assert body["page_size"] == DEFAULT_PAGE_SIZE
    assert body["total"] == _PAGINATION_CORPUS_SIZE


@pytest.mark.parametrize(
    ("parameter", "value"),
    [
        ("page", MIN_PAGE - 1),
        ("page_size", MIN_PAGE_SIZE - 1),
        ("page_size", MAX_PAGE_SIZE + 1),
    ],
)
async def test_profile_posts_refuse_a_window_outside_the_declared_bounds(
    client: AsyncClient,
    author_user: User,
    parameter: str,
    value: int,
) -> None:
    """``PageParams`` bounds ``page >= 1`` and ``1 <= page_size <= 100`` as query validation.

    So an out-of-range window is refused as a 422 naming the offending parameter, and is never
    clamped and never a 500. The values are derived from the constants themselves, which is what
    makes the test assert "just outside the declared bound" rather than three magic numbers.
    """
    response = await client.get(
        _profile_posts_url(author_user.username),
        params={parameter: value},
    )

    assert parameter in _rejected_fields(response)


@pytest.mark.parametrize("page_size", [MIN_PAGE_SIZE, MAX_PAGE_SIZE])
async def test_profile_posts_accept_the_declared_window_extremes(
    client: AsyncClient,
    author_user: User,
    db_session: AsyncSession,
    page_size: int,
) -> None:
    """Both bounds are inclusive: the smallest and largest legal windows are accepted.

    The companion to the rejection test above. Together they pin the boundary exactly, so a
    future change from ``le`` to ``lt`` fails one of the two rather than passing both.
    """
    await _seed_published_posts(db_session, author_user, _PAGINATION_CORPUS_SIZE)

    response = await client.get(
        _profile_posts_url(author_user.username),
        params={"page": MIN_PAGE, "page_size": page_size},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["page_size"] == page_size
    assert body["total"] == _PAGINATION_CORPUS_SIZE
    assert len(body["items"]) == min(page_size, _PAGINATION_CORPUS_SIZE)


async def test_profile_posts_for_an_unknown_username_answer_404(
    client: AsyncClient,
) -> None:
    """An unknown handle is a 404 rather than an empty page: the author is resolved first.

    Deliberate, because a profile that does not exist must not render as an author who has
    simply written nothing - and resolving first costs one index probe instead of a listing.
    """
    response = await client.get(_profile_posts_url(_UNCLAIMED_HANDLE))

    body = _problem_document(response, 404)
    assert body["instance"] == _profile_posts_url(_UNCLAIMED_HANDLE)


# =======================================================================================
# Phase E - the authenticated self-update
#
# `PATCH /api/v1/users/me` has no path parameter and no identifier in its body, which is what
# makes it incapable of editing another account: the row written is the one
# `get_current_active_user` resolved from the presented credential. So there is no ownership
# comparison to get the wrong way round, and the tests below are about the three members it may
# change, the projection it returns, and the values it refuses.
# =======================================================================================

_NEW_DISPLAY_NAME: Final[str] = "Ada Lovelace"
_NEW_BIO: Final[str] = "Writes about analytical engines and the parts of them that surprise me."
_NEW_AVATAR_URL: Final[str] = "https://example.com/avatars/ada.png"

#: A whole-profile patch, used by the tests that then narrow one member or read the public view.
_FULL_SELF_UPDATE: Final[dict[str, str]] = {
    "display_name": _NEW_DISPLAY_NAME,
    "bio": _NEW_BIO,
    "avatar_url": _NEW_AVATAR_URL,
}


# ---------------------------------------------------------------------------------------
# Boundary vocabulary
#
# `users.display_name`, `users.bio` and `users.avatar_url` are unbounded `TEXT`, so the schema
# constants below are the ONLY limits that exist anywhere - nothing in the database would refuse an
# over-long value. That makes the pair of cases per bound the whole of the enforcement, and it makes
# deriving each value from its constant rather than transcribing it the difference between a test
# that guards the bound and one that merely used to.
# ---------------------------------------------------------------------------------------

_ASTRAL: Final[str] = "\N{GRINNING FACE}"
"""One astral code point, U+1F600, used to fill a field to its exact ceiling.

The three units a length limit might be counted in disagree about this character: it is one code
point - which is what ``pydantic.StringConstraints`` counts and therefore what these limits mean -
two UTF-16 code units, and four UTF-8 bytes. A field filled to its exact maximum with it is
accepted by a correct implementation and refused by one counting either of the other two, which is
a distinction no ASCII case can draw."""

_AVATAR_URL_MAX_LENGTH: Final[int] = int(TypeAdapter(HttpUrl).json_schema()["maxLength"])
"""The ceiling on ``avatar_url``, read from the type that enforces it.

``app.schemas.user.OptionalAvatarUrl`` declares no explicit bound because
:class:`~pydantic.HttpUrl` carries one and publishes it as ``maxLength`` in the generated schema.
Read from the same place a generated client reads it, rather than transcribed out of a
dependency."""

#: Avatar destinations that must never be stored, with the validator that must refuse each. The
#: stored value is rendered into an `<img src>` on every byline and profile heading, so the scheme
#: allow-list is the control standing between a profile field and a script vector. The
#: scheme-relative case is here because `//host/path` names no scheme and a browser supplies the
#: page's own, so it loads - it is not a harmless relative path.
_HOSTILE_AVATAR_URLS: Final[tuple[tuple[str, str, str], ...]] = (
    ("javascript:alert(1)", "url_scheme", "javascript-scheme"),
    ("JavaScript:alert(1)", "url_scheme", "javascript-scheme-mixed-case"),
    ("data:text/html;base64,PHNjcmlwdD4=", "url_scheme", "data-scheme-carrying-a-document"),
    ("vbscript:msgbox(1)", "url_scheme", "vbscript-scheme"),
    ("file:///etc/passwd", "url_scheme", "file-scheme"),
    ("ftp://example.com/a.png", "url_scheme", "ftp-scheme"),
    ("//example.com/a.png", "url_parsing", "scheme-relative-reference"),
    ("/avatars/local.png", "url_parsing", "site-relative-path"),
    ("not a url", "url_parsing", "prose"),
)


def _avatar_url_of_length(length: int) -> str:
    """Return an absolute ``https`` avatar URL of exactly *length* characters."""
    prefix = "https://example.com/avatars/"
    if length < len(prefix) + 1:
        message = f"length must be at least {len(prefix) + 1}, got {length}"
        raise ValueError(message)
    return prefix + "a" * (length - len(prefix))


async def test_self_update_applies_every_editable_member(
    author_client: AsyncClient,
) -> None:
    """AAP §0.6.2: ``PATCH /me`` updates ``display_name``, ``bio`` and ``avatar_url``."""
    response = await author_client.patch(_SELF_UPDATE_URL, json=_FULL_SELF_UPDATE)

    assert response.status_code == 200
    body = response.json()
    _assert_self_projection(body)
    assert body["display_name"] == _NEW_DISPLAY_NAME
    assert body["bio"] == _NEW_BIO
    assert body["avatar_url"] == _NEW_AVATAR_URL


async def test_self_update_returns_the_self_projection_and_never_the_password_hash(
    author_client: AsyncClient,
    author_user: User,
) -> None:
    """AAP §0.10.1 #6: ``UserMe`` carries ``email``, ``role``, ``is_active`` and ``updated_at``.

    The wider view exists, and it is returned here because the caller is describing its own
    record. ``password_hash`` is a column on ``users`` and is published by nothing.
    """
    response = await author_client.patch(_SELF_UPDATE_URL, json={"bio": _NEW_BIO})

    assert response.status_code == 200
    body = response.json()
    _assert_self_projection(body)
    assert body["email"] == author_user.email
    # Compared against the enum member from the `app.models` barrel, never a string literal.
    assert body["role"] == UserRole.AUTHOR
    assert body["is_active"] is True
    # `updated_at` is present and populated. Its VALUE is deliberately not compared against
    # `created_at`: PostgreSQL's now() is transaction-scoped and the whole test runs inside one
    # transaction, so the two instants are legitimately equal here.
    assert body["updated_at"]


async def test_self_update_is_partial_and_preserves_omitted_members(
    author_client: AsyncClient,
) -> None:
    """A genuine partial update: an omitted member keeps its stored value.

    This is what the retired whole-object ``PUT /items/{id}`` could not express - it overwrote
    the record with whatever arrived, so a form submitting one field silently reverted the rest.
    """
    seeded = await author_client.patch(_SELF_UPDATE_URL, json=_FULL_SELF_UPDATE)
    assert seeded.status_code == 200

    narrowed = await author_client.patch(_SELF_UPDATE_URL, json={"bio": "A shorter bio."})

    assert narrowed.status_code == 200
    body = narrowed.json()
    assert body["bio"] == "A shorter bio."
    assert body["display_name"] == _NEW_DISPLAY_NAME
    assert body["avatar_url"] == _NEW_AVATAR_URL


@pytest.mark.parametrize("cleared_with", [None, "", "   "])
@pytest.mark.parametrize("member", ["bio", "avatar_url"])
async def test_self_update_clears_a_nullable_member(
    author_client: AsyncClient,
    member: str,
    cleared_with: str | None,
) -> None:
    """``bio`` and ``avatar_url`` are nullable, so "remove this" is a real instruction.

    Three spellings of it, all equivalent, and the equivalence is the point. ``null`` is the
    canonical form; ``""`` and ``"   "`` are what a browser actually submits when someone clears
    a populated control, since a form cannot send an absent field. The schema folds a blank
    string to ``None`` before validation, so the intent survives and reaches the column by the
    same path - and the response reports ``null`` rather than an empty string, which keeps
    "this account has no bio" a single representable state instead of two.

    The distinction between "leave this alone" (member absent) and "remove this" (member present
    and empty) is what ``model_dump(exclude_unset=True)`` preserves in the service, and it is the
    difference between a cleared control working and silently doing nothing.
    """
    seeded = await author_client.patch(_SELF_UPDATE_URL, json=_FULL_SELF_UPDATE)
    assert seeded.status_code == 200

    response = await author_client.patch(_SELF_UPDATE_URL, json={member: cleared_with})

    assert response.status_code == 200
    body = response.json()
    assert body[member] is None
    # The NOT NULL member is untouched, so clearing one thing cannot blank the byline.
    assert body["display_name"] == _NEW_DISPLAY_NAME


async def test_self_update_with_an_empty_body_is_a_no_op(
    author_client: AsyncClient,
) -> None:
    """A settings form submitted without edits is a legitimate request, answered as a no-op.

    Nothing is set, so nothing is written and no ``UPDATE`` is emitted; the record comes back
    unchanged. Rejecting it would turn harmless client behaviour into an error to interpret.
    """
    before = await author_client.get(_AUTH_ME_URL)
    assert before.status_code == 200

    response = await author_client.patch(_SELF_UPDATE_URL, json={})

    assert response.status_code == 200
    _assert_self_projection(response.json())
    assert response.json() == before.json()


async def test_self_update_is_visible_on_the_public_profile_without_widening_it(
    author_client: AsyncClient,
    client: AsyncClient,
    author_user: User,
) -> None:
    """The three editable members are exactly the three a public profile renders.

    So a self-update is observable anonymously - the byline, the profile heading and the avatar
    all change - while the projection an anonymous caller receives stays ``UserPublic``. Editing
    one's own record never widens what anyone else may read.
    """
    updated = await author_client.patch(_SELF_UPDATE_URL, json=_FULL_SELF_UPDATE)
    assert updated.status_code == 200

    public = await client.get(_profile_url(author_user.username))

    assert public.status_code == 200
    body = public.json()
    _assert_public_projection(body)
    assert body["display_name"] == _NEW_DISPLAY_NAME
    assert body["bio"] == _NEW_BIO
    assert body["avatar_url"] == _NEW_AVATAR_URL


async def test_self_update_without_a_credential_answers_401_with_a_bearer_challenge(
    client: AsyncClient,
) -> None:
    """The record being edited is identified by the credential, so there is no anonymous path.

    A 401 rather than a 403, and it carries the ``WWW-Authenticate: Bearer`` challenge, which is
    what lets browser code distinguish "you are not signed in" from "you may not do this".
    """
    response = await client.patch(_SELF_UPDATE_URL, json={"bio": _NEW_BIO})

    _problem_document(response, 401)
    assert response.headers[WWW_AUTHENTICATE_HEADER] == "Bearer"


@pytest.mark.parametrize(
    ("member", "value"),
    [
        ("display_name", None),
        ("display_name", "   "),
        ("display_name", "n" * (DISPLAY_NAME_MAX_LENGTH + 1)),
        # The same ceiling in astral code points: one code point over, two UTF-16 units and four
        # UTF-8 bytes per character. See `_ASTRAL`.
        ("display_name", _ASTRAL * (DISPLAY_NAME_MAX_LENGTH + 1)),
        # `StorableText` refuses U+0000 outright: the column is `text`, PostgreSQL cannot hold a
        # NUL in one, and letting it through would surface as a 500 from the driver.
        ("display_name", f"Nul{chr(0)}byte"),
        ("bio", "b" * (BIO_MAX_LENGTH + 1)),
        ("bio", _ASTRAL * (BIO_MAX_LENGTH + 1)),
        ("bio", f"Nul{chr(0)}byte"),
        ("avatar_url", "not a url"),
        ("avatar_url", "javascript:alert(1)"),
        ("avatar_url", _avatar_url_of_length(_AVATAR_URL_MAX_LENGTH + 1)),
    ],
)
async def test_self_update_refuses_a_value_outside_its_declared_bounds(
    author_client: AsyncClient,
    member: str,
    value: object,
) -> None:
    """A rejected value is a 422 naming the member, with ``errors`` populated (AAP §0.9.4.3).

    Six cases, and each is a distinct rule rather than a variation on one. ``display_name``
    refuses an explicit ``null`` because its column is ``NOT NULL``, refuses a whitespace-only
    value because it is stripped before it is measured, and is bounded above. ``bio`` is bounded
    above. ``avatar_url`` must be an absolute http(s) URL - which is not input hygiene but the
    control that keeps a profile field out of an ``<img src>`` as a script vector - so a
    malformed value and a ``javascript:`` scheme are both refused. The lengths are derived from
    the schema's own constants, so widening a bound cannot leave a stale test passing.
    """
    response = await author_client.patch(_SELF_UPDATE_URL, json={member: value})

    assert member in _rejected_fields(response)


@pytest.mark.parametrize(
    ("member", "value"),
    [
        pytest.param(
            "display_name",
            "n" * DISPLAY_NAME_MIN_LENGTH,
            id="display-name-at-the-floor",
        ),
        pytest.param(
            "display_name",
            "n" * DISPLAY_NAME_MAX_LENGTH,
            id="display-name-at-the-ceiling",
        ),
        pytest.param(
            "display_name",
            _ASTRAL * DISPLAY_NAME_MAX_LENGTH,
            id="display-name-at-the-ceiling-in-astral-code-points",
        ),
        pytest.param("bio", "b" * BIO_MAX_LENGTH, id="bio-at-the-ceiling"),
        pytest.param(
            "bio",
            _ASTRAL * BIO_MAX_LENGTH,
            id="bio-at-the-ceiling-in-astral-code-points",
        ),
        pytest.param(
            "avatar_url",
            _avatar_url_of_length(_AVATAR_URL_MAX_LENGTH),
            id="avatar-url-at-the-ceiling",
        ),
    ],
)
async def test_self_update_accepts_a_value_exactly_at_its_bound_and_stores_it_verbatim(
    author_client: AsyncClient,
    client: AsyncClient,
    author_user: User,
    member: str,
    value: str,
) -> None:
    """The largest value each member accepts is accepted, and comes back unaltered.

    The half of a bound that is usually left untested, and the half a client needs: the accepted
    maximum is what goes in a form's ``maxlength`` and its character counter, so a client built
    against a guess either refuses text this API would take or submits text it will not.

    Three assertions rather than one, because a status code proves the least of it. The response
    echoes the value, so a ceiling enforced by silent truncation - which would also answer 200 -
    fails here; the length is compared separately so such a failure reports the length it produced
    rather than dumping five hundred code points into the message; and the value is then re-read
    **anonymously** through the public profile, which is what proves it reached the column rather
    than only the response model. All three of these members are rendered on that public page.
    """
    response = await author_client.patch(_SELF_UPDATE_URL, json={member: value})

    assert response.status_code == 200, response.text[:400]
    body = response.json()
    _assert_self_projection(body)
    assert body[member] == value, f"{member} was altered on the way in"
    assert len(body[member]) == len(value), (member, len(body[member]), len(value))

    public = await client.get(_profile_url(author_user.username))
    assert public.status_code == 200
    assert public.json()[member] == value, f"{member} did not reach the column"


@pytest.mark.parametrize(
    ("url", "error_type"),
    [pytest.param(url, kind, id=name) for url, kind, name in _HOSTILE_AVATAR_URLS],
)
async def test_self_update_refuses_an_avatar_url_outside_the_scheme_allow_list(
    author_client: AsyncClient,
    url: str,
    error_type: str,
) -> None:
    """Only an absolute ``http`` or ``https`` URL may become an avatar.

    Not input hygiene. ``avatar_url`` is rendered into an ``<img src>`` on every byline this
    account appears on and on its profile heading, so a stored ``javascript:`` or ``data:``
    destination executes in the browser of every reader who loads any of those pages - and the
    account can set it on itself, so no privilege is needed to plant it.

    The machine-readable ``type`` is asserted alongside the status, because a client has to be able
    to tell a refused *scheme* from an unparseable value in order to say which to the person typing.
    """
    response = await author_client.patch(_SELF_UPDATE_URL, json={"avatar_url": url})

    assert "avatar_url" in _rejected_fields(response)
    reported = {
        entry["type"] for entry in response.json()["errors"] if entry["field"] == "avatar_url"
    }
    assert error_type in reported, reported


async def test_self_update_leaves_the_record_untouched_when_a_bound_is_exceeded(
    author_client: AsyncClient,
) -> None:
    """A refused edit writes nothing, including the members that were within their bounds.

    The property that makes a settings form safe to submit. ``PATCH /me`` carries three members, so
    a body can be simultaneously valid in one and invalid in another - and a service that assigned
    as it validated would leave the account half-edited, with no status code saying so. Validation
    happens before the service is reached at all, so the whole body is refused together.
    """
    seeded = await author_client.patch(_SELF_UPDATE_URL, json=_FULL_SELF_UPDATE)
    assert seeded.status_code == 200
    before = await author_client.get(_AUTH_ME_URL)
    assert before.status_code == 200

    response = await author_client.patch(
        _SELF_UPDATE_URL,
        json={
            "display_name": "A Perfectly Good Name",
            "bio": "b" * (BIO_MAX_LENGTH + 1),
        },
    )

    assert "bio" in _rejected_fields(response)
    after = await author_client.get(_AUTH_ME_URL)
    assert after.status_code == 200
    # Whole-body equality: the valid `display_name` in the refused request must not have landed.
    assert after.json() == before.json()


# =======================================================================================
# Phase F - privilege escalation is impossible through the self-update (AAP §0.10.1 #6)
#
# `UserUpdate` declares three members and sets `extra="forbid"`, so `email`, `username`, `role`,
# `is_active` and `id` are UNSETTABLE rather than merely undocumented. Independently, the
# service's assignments are keyed on three named fields with no generic attribute copy, so a
# member added to the schema later is not written to a column by accident.
#
# Every attempt below is asserted TWICE: the 422 the schema produces, and the absence of any
# effect re-read over HTTP. The status code is the contract; the effect is the security property,
# and only the second assertion would still hold if the schema were ever changed to ignore
# unknown members rather than refuse them.
#
# Between `RegisterRequest`, which carries no `role`, and `UserUpdate`, which accepts none,
# there is no self-service path to privilege anywhere in this API. Only
# `PATCH /api/v1/admin/users/{id}` changes a role, and `test_admin_api.py` owns that.
# =======================================================================================

#: The handle an escalation attempt tries to move the account to. Never registered by any test,
#: so a 404 at this address is meaningful rather than incidental.
_HIJACKED_HANDLE: Final[str] = "hijacked-handle"

#: One attempt per member the self-update must not reach. Values are plausible on purpose - a
#: well-formed address, a usable handle, a real role label, a real boolean, a syntactically valid
#: UUID - so nothing is refused merely for being malformed.
_ESCALATION_ATTEMPTS: Final[tuple[tuple[str, object], ...]] = (
    ("email", "hijacked@example.com"),
    ("username", _HIJACKED_HANDLE),
    ("role", UserRole.ADMIN.value),
    ("is_active", False),
    ("id", "3f1a9c74-6b0e-4d52-9a3f-71c2e8b45d10"),
)


@pytest.mark.parametrize(("member", "value"), _ESCALATION_ATTEMPTS)
async def test_self_update_refuses_identity_authority_and_activation(
    author_client: AsyncClient,
    member: str,
    value: object,
) -> None:
    """``UserUpdate`` accepts only ``display_name``, ``bio`` and ``avatar_url``.

    Never identity, never authority, never the active flag. The rejection names the member, and
    the record is then re-read through ``GET /api/v1/auth/me`` and compared whole - which is the
    assertion that actually matters, because it fails if the member is ever silently honoured.
    """
    before = await author_client.get(_AUTH_ME_URL)
    assert before.status_code == 200

    response = await author_client.patch(_SELF_UPDATE_URL, json={member: value})

    assert member in _rejected_fields(response)
    after = await author_client.get(_AUTH_ME_URL)
    assert after.status_code == 200
    _assert_self_projection(after.json())
    # Whole-body equality, so this covers the four members an escalation could target and every
    # other one at the same time - no field-by-field list here to fall out of date.
    assert after.json() == before.json()


async def test_self_update_cannot_grant_the_caller_administrator_authority(
    author_client: AsyncClient,
) -> None:
    """The end-to-end proof that no escalation occurred: the admin namespace still refuses.

    Asserting the unchanged ``role`` member proves the write did not happen; asserting that
    ``GET /api/v1/admin/stats`` still answers 403 proves the *authority* did not change either.
    The second is the one a reviewer should care about, because authority is re-checked
    server-side from the persisted column on every request rather than read from a token claim.
    """
    refused = await author_client.patch(_SELF_UPDATE_URL, json={"role": UserRole.ADMIN.value})
    assert "role" in _rejected_fields(refused)

    principal = await author_client.get(_AUTH_ME_URL)
    assert principal.status_code == 200
    assert principal.json()["role"] == UserRole.AUTHOR

    forbidden = await author_client.get(_ADMIN_STATS_URL)

    _problem_document(forbidden, 403)


async def test_self_update_cannot_re_key_the_public_profile_url(
    author_client: AsyncClient,
    client: AsyncClient,
    author_user: User,
) -> None:
    """A handle is the account's canonical address, so it is not re-keyable at all.

    It appears in every profile link, every canonical tag and every sitemap entry, which is why
    ``UserUpdate`` declares no member for it: a renameable handle would silently invalidate every
    published URL. The profile therefore stays reachable where it was and is never reachable at
    the attempted address.
    """
    refused = await author_client.patch(_SELF_UPDATE_URL, json={"username": _HIJACKED_HANDLE})
    assert "username" in _rejected_fields(refused)

    original = await client.get(_profile_url(author_user.username))
    attempted = await client.get(_profile_url(_HIJACKED_HANDLE))

    assert original.status_code == 200
    assert original.json()["id"] == str(author_user.id)
    _problem_document(attempted, 404)


# =======================================================================================
# Phase G - the route-ordering consequence of the literal `/me` path
#
# Starlette matches in registration order and serves the first pattern that accepts the URL, so
# `/{username}` registered above the literal `/me` would capture `me` as a handle and make the
# self-update unreachable - answering 404 from a profile lookup for a handle nobody registered,
# with nothing in the logs to say a route had been shadowed. `users.py` therefore declares
# `PATCH /me` FIRST, and states in a comment block that the position is part of the contract.
#
# The collision only bites within one HTTP method, and today every parameterised route in that
# module is a GET, so the order is not what makes the file work right now. It is what keeps the
# file working the day a `GET /me` or a parameterised `PATCH` is added - which is exactly the day
# the failure would be hardest to attribute. Two small tests are the cheap insurance, and this is
# the class of defect that otherwise ships silently and is discovered by a user named `me`.
# =======================================================================================


async def test_self_update_targets_the_caller_not_an_account_whose_handle_is_me(
    author_client: AsyncClient,
    client: AsyncClient,
    author_user: User,
    db_session: AsyncSession,
) -> None:
    """``PATCH /api/v1/users/me`` writes the caller's row even when an account holds that handle.

    ``me`` is a legitimate username, so an account can genuinely hold it. The self-update reads
    no path parameter at all - the row it writes is the one the credential resolved - so the two
    cannot be confused, and this test asserts both halves: the caller changed and the namesake
    did not.
    """
    namesake = await factories.create_user(
        db_session,
        username=_ME_HANDLE,
        display_name="Account Named Me",
        role=UserRole.AUTHOR,
    )

    response = await author_client.patch(_SELF_UPDATE_URL, json=_FULL_SELF_UPDATE)

    assert response.status_code == 200
    body = response.json()
    # The credential's own account, not the one whose handle collides with the path segment.
    assert body["id"] == str(author_user.id)
    assert body["username"] == author_user.username
    assert body["display_name"] == _NEW_DISPLAY_NAME

    namesake_profile = await client.get(_profile_url(_ME_HANDLE))
    assert namesake_profile.status_code == 200
    assert namesake_profile.json()["id"] == str(namesake.id)
    assert namesake_profile.json()["display_name"] == "Account Named Me"


async def test_get_on_the_me_path_is_a_username_lookup_when_the_handle_is_unclaimed(
    client: AsyncClient,
) -> None:
    """``/me`` is declared for ``PATCH`` only, so a ``GET`` falls through to ``/{username}``.

    A direct consequence of the ordering: the literal path exists for one method, and the
    parameterised path below it accepts the URL for every other. With no account holding ``me``
    the lookup finds nothing and answers the ordinary profile 404 - and the ``instance`` member
    naming ``/api/v1/users/me`` is what shows it was resolved as a handle rather than as a self
    read. The self view is served by ``GET /api/v1/auth/me``, which is a different address.
    """
    response = await client.get(_SELF_UPDATE_URL)

    body = _problem_document(response, 404)
    assert body["instance"] == _SELF_UPDATE_URL


async def test_get_on_the_me_path_resolves_the_account_that_holds_that_handle(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """When an account does hold ``me``, that ``GET`` returns its public profile.

    The other half of the previous test, and the one that proves the 404 there was a lookup miss
    rather than a route that does not exist. What comes back is ``UserPublic`` for the namesake -
    not the caller's self view - so no anonymous caller can read a private member by guessing
    that ``/me`` means "whoever I am".
    """
    namesake = await factories.create_user(db_session, username=_ME_HANDLE)

    response = await client.get(_SELF_UPDATE_URL)

    assert response.status_code == 200
    body = response.json()
    _assert_public_projection(body)
    assert body["id"] == str(namesake.id)
    assert body["username"] == _ME_HANDLE
