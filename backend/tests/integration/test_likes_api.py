"""Integration tests for the like surface: idempotency, accumulation, and a public count.

The like half of requirement **R4** - "Each blog page should support comments, likes, and social
sharing" - driven end to end over HTTP. Three routes are under test, and they are deliberately
asymmetric in both path and authentication::

    PUT    /api/v1/posts/{post_id}/like    bearer required   -> 200 LikeSummary
    DELETE /api/v1/posts/{post_id}/like    bearer required   -> 200 LikeSummary
    GET    /api/v1/posts/{post_id}/likes   bearer OPTIONAL   -> 200 LikeSummary

Singular ``/like`` for the two mutations, plural ``/likes`` for the read. The paths are built by
:func:`_like_path` and :func:`_likes_path` rather than written out at each call site, so a
transposition is a single-line defect rather than one scattered through thirty requests.

The one criterion this module exists for
----------------------------------------
AAP §0.9.4.2 states it as a data-layer guarantee: **"Likes are idempotent - two consecutive
``PUT /api/v1/posts/{id}/like`` calls leave the count at 1."** That was established by execution
during planning - two identical conflict-ignoring inserts against PostgreSQL 18.4 left the row
count at one - and :func:`test_liking_twice_leaves_one_like` re-establishes it at the HTTP
boundary, which is the only boundary a client can observe it from.

Why the guarantee needs a test at all is the interesting part. It is **structural**: the primary
key of ``post_likes`` *is* the pair ``(post_id, user_id)``, and ``LikeRepository`` writes through
``INSERT ... ON CONFLICT DO NOTHING``. There is no application-level de-duplication anywhere in
this backend - no pre-existence read, no ``if already_liked`` branch, no integrity-error handler,
no retry loop - and its absence is the design rather than an oversight, because a read followed by
an insert is two statements with a race between them. So nothing in Python protects the property,
and every assertion here is checked **twice**: once against the response body, and once against
the row count read straight out of ``post_likes`` through ``db_session``. A defect in the aggregate
and a defect in the insert are then separately visible, where trusting the response alone would let
a broken ``COUNT`` report the right number over the wrong rows.

The authentication asymmetry, stated once
-----------------------------------------
The two mutations depend on ``CurrentUser`` and answer ``401`` to a caller with no usable
credential, because granting a like is an act attributed to an account. The read depends on
``OptionalUser`` and **must not**: a like count is public information on a public blog, so an
anonymous caller receives the count with ``liked_by_caller`` set to ``false`` rather than a refusal.
Three distinctions follow, all of them measured rather than assumed, and each has a test:

* **No** ``Authorization`` header on the read succeeds as anonymous
  (:func:`test_anonymous_read_reports_count_without_caller_state`).
* An ``Authorization`` header that cannot be used is **refused** on the read, not degraded to
  anonymous - ``get_current_user_optional`` tolerates an absent credential and not an unusable one,
  because degrading it would report ``liked_by_caller: false`` to somebody who has in fact liked the
  post (:func:`test_read_with_invalid_bearer_token_is_unauthorized`).
* A **deactivated** account is served as anonymous on the read and refused with ``403`` on the
  mutations, which is where ``OptionalUser`` and ``CurrentUser`` differ
  (:func:`test_read_by_deactivated_account_is_served_as_anonymous`,
  :func:`test_like_by_deactivated_account_is_forbidden`).

What is asserted, and what is left to its owner
-----------------------------------------------
Every test drives HTTP through the ``client`` fixture and asserts on status codes and response
bodies. ``db_session`` is read only to verify a **database-level** effect - a row count, a row's
disappearance, a cascade - which is exactly what the guarantee under test lives in. No test calls
``LikeService``, ``LikeRepository`` or ``can_view_post`` directly; a rule proved by calling the
function that declares it proves only that the function was called.

Arrangement is a separate question from assertion, and it is answered the most direct way available.
State is built through ``tests.factories``, which write on the same session, and the two tests that
need an account to be active and *then* suspended - a transition no factory can express - set
``is_active`` on the loaded row and flush. Reaching for ``PATCH /api/v1/admin/users/{id}`` instead
would work, and is deliberately not done: it is the coupling ``conftest`` avoids when it mints
tokens through ``create_access_token`` rather than calling the login route, so that a regression in
one surface fails that surface's own module instead of this one. Nothing below *asserts* through
``db_session`` except the row-level effects named above.

Two neighbours own coverage this module deliberately does not repeat.
``backend/tests/unit/test_permissions.py`` targets the ``can_view_post`` predicate directly, so the
draft cases here assert only that the like surface *consults* it - that predicate is imported from
``app.services.post_service`` by ``like_service`` rather than re-derived, so it is declared exactly
once across posts, comments and likes and a leak would be a single-predicate bug.
``backend/tests/integration/test_posts_api.py`` owns the cascade proof in depth, so
:func:`test_deleting_a_post_removes_its_likes` and
:func:`test_deleting_an_account_removes_its_likes` are one corroborating assertion each.

Isolation
---------
Nothing is cleaned up and nothing may be. ``db_session`` wraps every test in a transaction that is
rolled back in its teardown, so no test truncates a table, no test depends on another having run,
and no ``like_count`` assertion is sensitive to collection order. Revision ``0003``'s reference
categories are permanent baseline and are irrelevant here - a like addresses no category.

Governing rules
---------------
``review_rules`` reports **"No user rules provided."** - a complete response - so no user rule
governs this file and none put it in scope; it traces to AAP §0.4.4.5 and §0.7.1.11 alone. The
self-imposed standards of AAP §0.10.1 stand in their place, and four decide the shape of this
module: *layered separation of concerns*, which is why every behavioural assertion goes through
HTTP; *server-owned identity and database-enforced integrity*, which is why every count assertion
is corroborated against ``post_likes`` itself; *secure-by-default authentication*, which is why the
``401``/optional-principal asymmetry above is tested in both directions; and *blocking quality
gates*, which is why there is no ``skip``, no ``xfail`` and no conditional assertion below.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any, Final

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.router import API_V1_PREFIX
from app.core.exceptions import PROBLEM_JSON_MEDIA_TYPE, WWW_AUTHENTICATE_HEADER
from app.models import Post, PostLike, PostStatus, User, UserRole
from tests import factories

pytestmark = pytest.mark.integration
"""Every test drives the API in process against PostgreSQL, which is what ``integration`` means.

The marker is registered in ``backend/pyproject.toml`` and the suite runs under
``--strict-markers``, so a typo is a collection error rather than a silently unmarked module. No
``asyncio`` marker is applied: ``asyncio_mode = "auto"`` covers it, and ``conftest``'s
``pytest_collection_modifyitems`` pins the session loop scope for any invocation that overrides the
ini.
"""


# ---------------------------------------------------------------------------------------
# Request targets
#
# Built from `API_V1_PREFIX`, which `app.api.v1.router` exports for exactly this purpose, so
# the version namespace is one literal shared by the application, the tests and the endpoint
# reference rather than three copies of "/api/v1".
#
# Two builders instead of one with a flag, because the singular/plural distinction is the
# likeliest thing to get wrong in this file and a boolean argument at the call site would hide
# which of the two a request meant.
# ---------------------------------------------------------------------------------------

_POSTS_PATH: Final[str] = f"{API_V1_PREFIX}/posts"
"""Collection segment the like routes hang off. ``likes.router`` is mounted here with ``/posts``."""


def _like_path(post_id: object) -> str:
    """Return the path of the caller's own like of a post - **singular** ``/like``.

    Args:
        post_id: The post identifier. Typed ``object`` on purpose so a test can pass a
            :class:`~uuid.UUID`, a :class:`~app.models.Post`'s ``id``, or a deliberately
            malformed string for the validation cases without a cast.

    Returns:
        ``/api/v1/posts/{post_id}/like`` - the target of ``PUT`` and ``DELETE``.
    """
    return f"{_POSTS_PATH}/{post_id}/like"


def _likes_path(post_id: object) -> str:
    """Return the path of a post's aggregate like summary - **plural** ``/likes``.

    Args:
        post_id: The post identifier, typed as in :func:`_like_path`.

    Returns:
        ``/api/v1/posts/{post_id}/likes`` - the target of the public ``GET``.
    """
    return f"{_POSTS_PATH}/{post_id}/likes"


# ---------------------------------------------------------------------------------------
# The response contract, named once
#
# The three members of `LikeSummary` and the members of the problem document are written here
# rather than at each assertion, so "the shape changed" is one failing constant instead of
# thirty failing assertions that each look like a different defect.
# ---------------------------------------------------------------------------------------

_SUMMARY_FIELDS: Final[frozenset[str]] = frozenset({"post_id", "like_count", "liked_by_caller"})
"""Exactly the members ``LikeSummary`` declares, asserted as a set equality rather than as presence.

Equality is what makes the assertion two-sided, and the second side is the point: it fails if a
surrogate ``id`` appears - ``post_likes`` takes no ``UUIDPrimaryKeyMixin``, so there is none to
publish - if an ``updated_at`` appears, since the relation has ``created_at`` alone, or if the
identifiers of the accounts that liked the post leak into a response that is meant to report the
caller's own state and nobody else's.
"""

_PROBLEM_FIELDS: Final[frozenset[str]] = frozenset(
    {"type", "title", "status", "detail", "instance", "request_id"}
)
"""Members every failure body carries, in addition to the optional ``errors`` array.

``request_id`` is part of the document and not only of the ``X-Request-ID`` header: the two are
written from one value so a support request quoting the body and a log query filtering the header
land on the same request.
"""

_PROBLEM_TITLES: Final[dict[int, str]] = {
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    422: "Validation Error",
}
"""``title`` each status renders with, so a test names the status and gets the wording for free."""

_TYPE_UNAUTHORIZED: Final[str] = "/errors/unauthorized"
_TYPE_FORBIDDEN: Final[str] = "/errors/forbidden"
_TYPE_NOT_FOUND: Final[str] = "/errors/not-found"
_TYPE_VALIDATION: Final[str] = "/errors/validation-error"

_DETAIL_NO_CREDENTIAL: Final[str] = "Authentication credentials are missing or invalid."
"""``detail`` for an absent credential, and for a header whose scheme is not ``Bearer``."""

_DETAIL_INVALID_TOKEN: Final[str] = "The authentication token is invalid."
"""``detail`` for a credential that was presented and could not be decoded - malformed, or of the
wrong token type, which is what an opaque refresh token is when offered as a bearer credential."""

_DETAIL_DEACTIVATED: Final[str] = "This account has been deactivated."
"""``detail`` of the ``403`` the mutations answer a suspended account with."""

_DETAIL_POST_NOT_FOUND: Final[str] = "Post not found"
"""``detail`` shared by "no such post" and "a post this caller may not see".

One string for both cases is the confidentiality decision, not an economy: a distinguishable
response would confirm to somebody not entitled to read a draft that the draft exists.
"""

_DETAIL_VALIDATION_FAILED: Final[str] = "The request payload failed validation."
"""``detail`` of the ``422`` a malformed ``post_id`` produces, from this API's own handler rather
than the framework's ``{"detail": [...]}`` default."""

_MALFORMED_POST_ID: Final[str] = "not-a-uuid"
"""Path segment used for the validation cases. ``post_id`` is the only input any of the three
routes takes - none accepts a body or a query parameter - so it is the only way one can fail
validation."""

AuthHeaderFactory = Callable[[User], dict[str, str]]
"""Type of the ``auth_headers_for`` fixture: a callable, because a test frequently needs two."""


# ---------------------------------------------------------------------------------------
# Assertion helpers
#
# Three, and each exists because the assertion it makes has to be identical everywhere it is
# made. A `like_count` checked one way in one test and another way in the next is how a suite
# ends up proving two different things and reporting one.
# ---------------------------------------------------------------------------------------


async def _stored_like_count(
    session: AsyncSession,
    *,
    post: Post | None = None,
    user: User | None = None,
) -> int:
    """Count ``post_likes`` rows in the database, optionally narrowed by post and by account.

    The corroborating half of every count assertion in this module, and the reason it exists is
    standard #3: idempotency is a property of the relation's composite primary key, so the
    relation is where it has to be observed. A response body alone cannot distinguish a correct
    aggregate over duplicated rows from a correct aggregate over one row.

    Args:
        session: The test's session - the same object the request under test was served on, which
            is what makes a row written by a committed request visible here.
        post: Restrict to one post's likes. Omit to count across posts.
        user: Restrict to one account's likes. Omit to count across accounts. Supplying both
            narrows to the composite primary key, so the result is ``0`` or ``1`` and can never
            be more.

    Returns:
        The number of matching rows.
    """
    statement = select(func.count()).select_from(PostLike)
    if post is not None:
        statement = statement.where(PostLike.post_id == post.id)
    if user is not None:
        statement = statement.where(PostLike.user_id == user.id)
    return int((await session.execute(statement)).scalar_one())


def _assert_summary(
    payload: Any,
    *,
    post: Post,
    like_count: int,
    liked_by_caller: bool,
) -> None:
    """Assert a body is a complete ``LikeSummary`` with the expected values.

    Applied to the two mutations as well as the read, and that is protecting a client contract
    rather than being pedantic: all three routes declare ``response_model=LikeSummary`` precisely
    so ``frontend/src/components/blog/like-button.tsx`` can settle an optimistic update from the
    mutation's own response instead of issuing a follow-up read.

    Args:
        payload: The decoded response body.
        post: The post the summary must identify, compared against the stringified ``id`` the
            JSON representation carries.
        like_count: The expected aggregate.
        liked_by_caller: The expected caller state, compared with ``is`` so a truthy non-boolean
            would fail rather than pass.
    """
    assert isinstance(payload, dict), f"expected a JSON object, got {type(payload).__name__}"
    assert set(payload) == _SUMMARY_FIELDS, f"unexpected summary shape: {sorted(payload)}"
    assert payload["post_id"] == str(post.id)
    assert payload["like_count"] == like_count
    assert payload["liked_by_caller"] is liked_by_caller


def _assert_problem_document(
    response: Response,
    *,
    status: int,
    error_type: str,
    detail: str,
    instance: str,
) -> dict[str, Any]:
    """Assert a response is the one problem document this API returns for every failure.

    Takes the whole response rather than its decoded body so the status and the media type are
    checked here too. That matters for this surface in particular: ``oauth2_scheme`` is constructed
    with ``auto_error=False`` precisely so a rejected credential renders as this document instead of
    the framework's ``{"detail": "Not authenticated"}``, and a regression would show up as a
    ``application/json`` content type long before the body members went missing.

    Args:
        response: The response under test.
        status: The expected HTTP status, which also selects the expected ``title``.
        error_type: The expected ``type``, a stable machine-readable identifier.
        detail: The expected human-readable ``detail``.
        instance: The expected request path. The document carries the path alone - a query string
            is excluded on every path, deliberately and uniformly.

    Returns:
        The decoded body, so a caller with a further assertion to make - the ``errors`` array on a
        validation failure - does not decode it a second time.
    """
    assert response.status_code == status
    assert response.headers["content-type"] == PROBLEM_JSON_MEDIA_TYPE
    payload = response.json()
    assert isinstance(payload, dict), f"expected a JSON object, got {type(payload).__name__}"
    assert set(payload) >= _PROBLEM_FIELDS, f"problem document members missing: {sorted(payload)}"
    assert payload["type"] == error_type
    assert payload["title"] == _PROBLEM_TITLES[status]
    assert payload["status"] == status
    assert payload["detail"] == detail
    assert payload["instance"] == instance
    assert isinstance(payload["request_id"], str)
    assert payload["request_id"] != ""
    return payload


# ---------------------------------------------------------------------------------------
# Idempotency - the criterion this module exists for
#
# AAP §0.9.4.2: "Likes are idempotent - two consecutive PUT /api/v1/posts/{id}/like calls
# leave the count at 1." Nothing in Python enforces it, so these four tests are the whole of
# its protection at the HTTP boundary.
# ---------------------------------------------------------------------------------------


async def test_liking_a_post_returns_the_settled_summary(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    reader_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """A single like answers 200 with the full three-field LikeSummary (AAP §0.6.2)."""
    post = await factories.create_published_post(db_session, author=author_user)

    response = await client.put(_like_path(post.id), headers=auth_headers_for(reader_user))

    assert response.status_code == 200
    _assert_summary(response.json(), post=post, like_count=1, liked_by_caller=True)
    assert await _stored_like_count(db_session, post=post) == 1


async def test_liking_twice_leaves_one_like(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    reader_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """Two consecutive PUTs both succeed and leave the count at 1 - AAP §0.9.4.2 verbatim.

    Idempotency here is **structural**, not procedural: the primary key of ``post_likes`` *is*
    the pair ``(post_id, user_id)`` and ``LikeRepository`` writes through
    ``INSERT ... ON CONFLICT DO NOTHING``. There is no application-level de-duplication anywhere
    in this backend - no pre-existence read, no ``if already_liked`` branch, no integrity-error
    handler - and none may be added, because a read followed by an insert is two statements with
    a race between them. So this test is the only thing protecting the property.

    It is therefore checked on both sides of the boundary. The response body must report ``1``
    twice, **and** ``post_likes`` must hold exactly one row for the pair - a broken aggregate over
    two rows and a correct aggregate over one row are otherwise indistinguishable from the wire.

    The second call must not answer ``409`` or any other failure. ``PUT`` rather than ``POST`` is
    what tells a client, a proxy and a retrying HTTP library that repeating the request settles on
    the same end state, so a retry after a timeout, a duplicate delivered by a proxy and an
    impatient double-click are all safe by construction.
    """
    post = await factories.create_published_post(db_session, author=author_user)
    headers = auth_headers_for(reader_user)

    first = await client.put(_like_path(post.id), headers=headers)
    second = await client.put(_like_path(post.id), headers=headers)

    assert first.status_code == 200
    assert second.status_code == 200, "a repeated like must succeed, never conflict"
    _assert_summary(first.json(), post=post, like_count=1, liked_by_caller=True)
    _assert_summary(second.json(), post=post, like_count=1, liked_by_caller=True)

    # The guarantee lives in the relation, so the relation is where it is confirmed. Narrowed to
    # the composite primary key, this count can only be 0 or 1 if the key is intact - a 2 would
    # mean the key itself had been lost.
    assert await _stored_like_count(db_session, post=post, user=reader_user) == 1
    assert await _stored_like_count(db_session, post=post) == 1

    summary = await client.get(_likes_path(post.id), headers=headers)
    assert summary.status_code == 200
    _assert_summary(summary.json(), post=post, like_count=1, liked_by_caller=True)


async def test_liking_four_times_leaves_one_like(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    reader_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """Repeating a like arbitrarily often still leaves one row and a count of 1 (AAP §0.9.4.2).

    Two calls prove the conflict is absorbed once; four prove nothing accumulates across
    attempts - no counter incremented beside the row, no second row under a different surrogate
    key. Every attempt reports the same settled summary, which is what makes an unbounded client
    retry loop harmless.
    """
    post = await factories.create_published_post(db_session, author=author_user)
    headers = auth_headers_for(reader_user)

    for attempt in range(4):
        response = await client.put(_like_path(post.id), headers=headers)
        assert response.status_code == 200, f"attempt {attempt + 1} must succeed"
        _assert_summary(response.json(), post=post, like_count=1, liked_by_caller=True)
        assert await _stored_like_count(db_session, post=post) == 1


async def test_a_factory_written_like_is_not_duplicated_by_the_api(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    reader_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """Liking a post the account already likes adds no row, whoever wrote the first one.

    The like is planted directly through ``factories.create_like`` rather than through the API, so
    the conflict the request meets was not created by the same code path that has to absorb it.
    That is the honest form of the guarantee required by standard #3: the composite primary key
    holds for every writer - this service, a factory, a migration, a statement typed into ``psql``
    - which is precisely what an application-level check could not do.
    """
    post = await factories.create_published_post(db_session, author=author_user)
    await factories.create_like(db_session, post=post, user=reader_user)

    response = await client.put(_like_path(post.id), headers=auth_headers_for(reader_user))

    assert response.status_code == 200
    _assert_summary(response.json(), post=post, like_count=1, liked_by_caller=True)
    assert await _stored_like_count(db_session, post=post) == 1


# ---------------------------------------------------------------------------------------
# Accumulation across accounts
#
# The composite key permits one row PER ACCOUNT per post, not one row per post. These tests
# are the other half of the idempotency claim: without them, a service that stored a single
# row per post would pass every test above.
# ---------------------------------------------------------------------------------------


async def test_distinct_accounts_each_add_a_like(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """Three accounts liking one post produce a count of 3 and three rows (AAP §0.6.2).

    The complement of :func:`test_liking_twice_leaves_one_like`, and it is what stops that test
    from being satisfied by an implementation that collapsed every like of a post into one row.
    ``(post_id, user_id)`` is unique per pair, so the count rises once per distinct account and
    never twice for the same one.
    """
    post = await factories.create_published_post(db_session, author=author_user)
    likers = [await factories.create_reader(db_session) for _ in range(3)]

    for expected_count, liker in enumerate(likers, start=1):
        response = await client.put(_like_path(post.id), headers=auth_headers_for(liker))
        assert response.status_code == 200
        _assert_summary(
            response.json(),
            post=post,
            like_count=expected_count,
            liked_by_caller=True,
        )

    assert await _stored_like_count(db_session, post=post) == 3
    for liker in likers:
        assert await _stored_like_count(db_session, post=post, user=liker) == 1


async def test_each_liker_sees_their_own_state_and_the_shared_count(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """The count is identical for every caller; only ``liked_by_caller`` differs (AAP §0.6.2).

    ``liked_by_caller`` answers the caller's question about *themselves*, so presenting a
    credential widens the response by exactly that one member and never by the count. An account
    that has not liked the post reads the same total as the three that have.
    """
    post = await factories.create_published_post(db_session, author=author_user)
    likers = [await factories.create_reader(db_session) for _ in range(3)]
    for liker in likers:
        await client.put(_like_path(post.id), headers=auth_headers_for(liker))

    for liker in likers:
        own = await client.get(_likes_path(post.id), headers=auth_headers_for(liker))
        assert own.status_code == 200
        _assert_summary(own.json(), post=post, like_count=3, liked_by_caller=True)

    observer = await factories.create_reader(db_session)
    theirs = await client.get(_likes_path(post.id), headers=auth_headers_for(observer))
    assert theirs.status_code == 200
    _assert_summary(theirs.json(), post=post, like_count=3, liked_by_caller=False)
    assert await _stored_like_count(db_session, post=post, user=observer) == 0


async def test_one_account_liking_two_posts_counts_each_separately(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    reader_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """A like is scoped to its post: liking two posts leaves each at 1 (AAP §0.6.3.1).

    The key is a pair, so its uniqueness constrains the pair and not either column alone. An
    implementation that keyed on ``user_id`` would let the second like displace the first, and an
    implementation that keyed on ``post_id`` would let it be rejected.
    """
    first_post = await factories.create_published_post(db_session, author=author_user)
    second_post = await factories.create_published_post(db_session, author=author_user)
    headers = auth_headers_for(reader_user)

    first = await client.put(_like_path(first_post.id), headers=headers)
    second = await client.put(_like_path(second_post.id), headers=headers)

    assert first.status_code == 200
    assert second.status_code == 200
    _assert_summary(first.json(), post=first_post, like_count=1, liked_by_caller=True)
    _assert_summary(second.json(), post=second_post, like_count=1, liked_by_caller=True)
    assert await _stored_like_count(db_session, user=reader_user) == 2
    assert await _stored_like_count(db_session, post=first_post) == 1
    assert await _stored_like_count(db_session, post=second_post) == 1


# ---------------------------------------------------------------------------------------
# Withdrawing a like
#
# The mirror of the section above, and idempotent in the same way. Note that DELETE answers
# 200 with a body rather than 204: there is a settled value to report, and reporting it saves
# the caller a follow-up read.
# ---------------------------------------------------------------------------------------


async def test_unliking_removes_the_like_and_the_row(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    reader_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """DELETE after a like answers 200 with count 0, and the row is gone (AAP §0.6.2)."""
    post = await factories.create_published_post(db_session, author=author_user)
    headers = auth_headers_for(reader_user)
    await client.put(_like_path(post.id), headers=headers)
    assert await _stored_like_count(db_session, post=post) == 1

    response = await client.delete(_like_path(post.id), headers=headers)

    assert response.status_code == 200, "unliking answers 200 with a body, never 204"
    _assert_summary(response.json(), post=post, like_count=0, liked_by_caller=False)
    assert await _stored_like_count(db_session, post=post, user=reader_user) == 0


async def test_unliking_a_post_never_liked_succeeds(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    reader_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """Withdrawing a like that was never granted succeeds with count 0, and is not a 404.

    A safely retryable unlike is the symmetric counterpart of the idempotent like, and this is the
    contract the service declares: ``LikeRepository.unlike`` reports whether a row was removed and
    ``LikeService.unlike`` treats "none was" as a no-op rather than as a failure.

    Failing instead would be wrong twice over. It would leak, through a status code, whether an
    account had liked a post - a fact this API reports to that account about itself and to nobody
    else. And a client that had applied the withdrawal optimistically would then have to tell "your
    guess was already correct" apart from a genuine error in order to decide whether to roll back,
    a distinction it has no use for.
    """
    post = await factories.create_published_post(db_session, author=author_user)

    response = await client.delete(_like_path(post.id), headers=auth_headers_for(reader_user))

    assert response.status_code == 200
    _assert_summary(response.json(), post=post, like_count=0, liked_by_caller=False)
    assert await _stored_like_count(db_session, post=post) == 0


async def test_unliking_twice_behaves_identically_both_times(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    reader_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """Two consecutive DELETEs return the same status and the same body (AAP §0.6.2).

    The withdrawal counterpart of :func:`test_liking_twice_leaves_one_like`. The first call removes
    the row, the second finds nothing to remove, and neither the status nor the payload
    distinguishes them - so a retry after a timeout cannot be mistaken for a failure.
    """
    post = await factories.create_published_post(db_session, author=author_user)
    headers = auth_headers_for(reader_user)
    await client.put(_like_path(post.id), headers=headers)

    first = await client.delete(_like_path(post.id), headers=headers)
    second = await client.delete(_like_path(post.id), headers=headers)

    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    _assert_summary(second.json(), post=post, like_count=0, liked_by_caller=False)
    assert await _stored_like_count(db_session, post=post) == 0


async def test_liking_again_after_unliking_restores_the_count(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    reader_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """Like, unlike, like again returns the count to 1 - no residue blocks re-liking.

    Withdrawing a like deletes the row outright; it writes no tombstone and leaves no revoked
    marker behind. If it did, the second like would meet a conflict it could not absorb and the
    conflict-ignoring insert would silently do nothing, leaving the reader looking at a count of
    zero on a post they had just liked.
    """
    post = await factories.create_published_post(db_session, author=author_user)
    headers = auth_headers_for(reader_user)

    await client.put(_like_path(post.id), headers=headers)
    await client.delete(_like_path(post.id), headers=headers)
    response = await client.put(_like_path(post.id), headers=headers)

    assert response.status_code == 200
    _assert_summary(response.json(), post=post, like_count=1, liked_by_caller=True)
    assert await _stored_like_count(db_session, post=post, user=reader_user) == 1


async def test_unliking_leaves_other_accounts_likes_intact(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    reader_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """An account withdraws only its own like; another account's survives (AAP §0.6.2).

    Ownership is structural rather than enforced: the identity written into the delete predicate is
    the resolved principal's, and no body or query parameter offers a way to name another account.
    """
    post = await factories.create_published_post(db_session, author=author_user)
    other_liker = await factories.create_reader(db_session)
    await client.put(_like_path(post.id), headers=auth_headers_for(reader_user))
    await client.put(_like_path(post.id), headers=auth_headers_for(other_liker))

    response = await client.delete(_like_path(post.id), headers=auth_headers_for(reader_user))

    assert response.status_code == 200
    _assert_summary(response.json(), post=post, like_count=1, liked_by_caller=False)
    assert await _stored_like_count(db_session, post=post, user=reader_user) == 0
    assert await _stored_like_count(db_session, post=post, user=other_liker) == 1


# ---------------------------------------------------------------------------------------
# The read route's optional principal
#
# The asymmetry that is easiest to get wrong in this file: GET /{post_id}/likes depends on
# `OptionalUser`, so an ABSENT credential succeeds while an UNUSABLE one is refused. Both
# directions are tested, because a test of only the first would pass against a route that had
# been made public by removing the resolver altogether.
# ---------------------------------------------------------------------------------------


async def test_anonymous_read_reports_count_without_caller_state(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    reader_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """An anonymous GET answers 200 with the count and ``liked_by_caller`` false - never 401.

    The route resolves an **optional** principal, and that is a product decision rather than a
    convenience. A like count is public information on a site whose whole purpose is public reading,
    so requiring a bearer token here would blank the tally on every post page for every visitor who
    is not signed in - a silent defect, because the endpoint would still answer perfectly for the
    one audience that happened to be testing it. Only the caller's *own* state is personal, and it
    is reported as ``false`` for an anonymous caller: never ``null``, never absent, so a client need
    not tell "no session" apart from "has not liked this".
    """
    post = await factories.create_published_post(db_session, author=author_user)
    await client.put(_like_path(post.id), headers=auth_headers_for(reader_user))

    response = await client.get(_likes_path(post.id))

    assert response.status_code == 200, "the public like count must not require a credential"
    _assert_summary(response.json(), post=post, like_count=1, liked_by_caller=False)


async def test_read_by_an_account_that_liked_reports_caller_state(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    reader_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """A liker's authenticated read reports ``liked_by_caller`` true (AAP §0.6.2)."""
    post = await factories.create_published_post(db_session, author=author_user)
    headers = auth_headers_for(reader_user)
    await client.put(_like_path(post.id), headers=headers)

    response = await client.get(_likes_path(post.id), headers=headers)

    assert response.status_code == 200
    _assert_summary(response.json(), post=post, like_count=1, liked_by_caller=True)


async def test_read_by_an_account_that_has_not_liked_reports_false(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    reader_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """A non-liker's authenticated read reports the count with ``liked_by_caller`` false.

    Presenting a credential is not the same as having liked the post, and the two must not be
    conflated: the count is shared and the caller state is personal.
    """
    post = await factories.create_published_post(db_session, author=author_user)
    other_liker = await factories.create_reader(db_session)
    await client.put(_like_path(post.id), headers=auth_headers_for(other_liker))

    response = await client.get(_likes_path(post.id), headers=auth_headers_for(reader_user))

    assert response.status_code == 200
    _assert_summary(response.json(), post=post, like_count=1, liked_by_caller=False)


async def test_read_of_an_unliked_post_reports_zero(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
) -> None:
    """A post nobody has liked reports 0 and false, which is an ordinary state not an error.

    Zero is a real value and is returned as ``0``: never omitted, never null, and never a 404. It is
    the state of every newly published post.
    """
    post = await factories.create_published_post(db_session, author=author_user)

    response = await client.get(_likes_path(post.id))

    assert response.status_code == 200
    _assert_summary(response.json(), post=post, like_count=0, liked_by_caller=False)
    assert await _stored_like_count(db_session, post=post) == 0


async def test_read_with_invalid_bearer_token_is_unauthorized(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
) -> None:
    """An unusable credential on the public read is refused with 401, not degraded to anonymous.

    This is the second half of the optional-principal contract, and it is the half a careless test
    would get backwards. ``get_current_user_optional`` tolerates an **absent** ``Authorization``
    header and not an **unusable** one, for two reasons the route documents: degrading would report
    ``liked_by_caller: false`` to a caller who has in fact liked the post, and it would hide an
    expired session from the client that has to renew it.

    Because ``oauth2_scheme`` is constructed with ``auto_error=False``, the rejection is this API's
    own - the uniform problem document - rather than the framework's ``{"detail": "Not
    authenticated"}``, which would be the one error body in the whole service a client had to parse
    differently.
    """
    post = await factories.create_published_post(db_session, author=author_user)
    path = _likes_path(post.id)

    response = await client.get(path, headers={"Authorization": "Bearer not.a.real.token"})

    _assert_problem_document(
        response,
        status=401,
        error_type=_TYPE_UNAUTHORIZED,
        detail=_DETAIL_INVALID_TOKEN,
        instance=path,
    )


async def test_read_with_a_non_bearer_scheme_is_unauthorized(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
) -> None:
    """A credential in a scheme other than Bearer is refused with 401 on the read.

    Rejected one step earlier than an unusable token - by the header parse, before any principal is
    resolved - which is why the ``detail`` is the generic credential message rather than the
    token-specific one. Distinguishing the two in the body would narrow an attacker's search without
    helping a legitimate caller, so both remain 401 with the same ``type``.
    """
    post = await factories.create_published_post(db_session, author=author_user)
    path = _likes_path(post.id)

    response = await client.get(path, headers={"Authorization": "Basic dXNlcjpwYXNzd29yZA=="})

    _assert_problem_document(
        response,
        status=401,
        error_type=_TYPE_UNAUTHORIZED,
        detail=_DETAIL_NO_CREDENTIAL,
        instance=path,
    )


async def test_read_by_deactivated_account_is_served_as_anonymous(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    reader_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """A suspended account reads the public count as an anonymous caller, not as a refusal.

    This is where ``OptionalUser`` and ``CurrentUser`` genuinely differ, and both halves are
    deliberate. The read is answered rather than refused because the *operation* is public - a
    suspended reader may still read a published post, and a 403 here would withdraw access to
    content somebody with no account at all can reach. But the principal is narrowed to ``None``
    before it leaves the resolver, so ``liked_by_caller`` is ``false`` even for a suspended account
    that had liked the post: no visibility predicate downstream can ever be handed an inactive
    principal. The mutations refuse the same account with 403 - see
    :func:`test_like_by_deactivated_account_is_forbidden`.
    """
    post = await factories.create_published_post(db_session, author=author_user)
    suspended = await factories.create_reader(db_session)
    await client.put(_like_path(post.id), headers=auth_headers_for(suspended))
    await client.put(_like_path(post.id), headers=auth_headers_for(reader_user))
    # Arrangement, not assertion. The account has to be active to grant the like and suspended to
    # exercise the refusal, and no factory expresses that transition. Suspending it here rather than
    # through `PATCH /api/v1/admin/users/{id}` keeps this module independent of the admin surface -
    # the same coupling `conftest` avoids by minting tokens instead of calling the login route.
    suspended.is_active = False
    await db_session.flush()

    response = await client.get(_likes_path(post.id), headers=auth_headers_for(suspended))

    assert response.status_code == 200
    _assert_summary(response.json(), post=post, like_count=2, liked_by_caller=False)
    # The row itself is untouched. Deactivation withdraws authority, not history.
    assert await _stored_like_count(db_session, post=post, user=suspended) == 1


# ---------------------------------------------------------------------------------------
# Authentication negatives on the two mutations
#
# Standard #6: the writes require a principal, so every unusable credential is a 401 with the
# `WWW-Authenticate: Bearer` challenge. Each test also asserts that NO row was written, because
# a rejection that had already touched the relation would be a far worse defect than a wrong
# status code.
# ---------------------------------------------------------------------------------------


async def test_liking_without_a_credential_is_unauthorized(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
) -> None:
    """An unauthenticated PUT is 401 with a Bearer challenge and writes nothing (AAP §0.9.4.4).

    A like is an act attributed to an account, so there has to be an account. The rejection happens
    in the shared principal dependency before the handler body runs, which is why no row can exist
    afterwards.
    """
    post = await factories.create_published_post(db_session, author=author_user)
    path = _like_path(post.id)

    response = await client.put(path)

    _assert_problem_document(
        response,
        status=401,
        error_type=_TYPE_UNAUTHORIZED,
        detail=_DETAIL_NO_CREDENTIAL,
        instance=path,
    )
    assert response.headers[WWW_AUTHENTICATE_HEADER] == "Bearer"
    assert await _stored_like_count(db_session, post=post) == 0


async def test_unliking_without_a_credential_is_unauthorized(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    reader_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """An unauthenticated DELETE is 401 and removes nothing (AAP §0.9.4.4).

    The like planted first is what makes the assertion meaningful: the refusal must leave it in
    place, so an anonymous caller cannot withdraw somebody else's like.
    """
    post = await factories.create_published_post(db_session, author=author_user)
    await client.put(_like_path(post.id), headers=auth_headers_for(reader_user))
    path = _like_path(post.id)

    response = await client.delete(path)

    _assert_problem_document(
        response,
        status=401,
        error_type=_TYPE_UNAUTHORIZED,
        detail=_DETAIL_NO_CREDENTIAL,
        instance=path,
    )
    assert response.headers[WWW_AUTHENTICATE_HEADER] == "Bearer"
    assert await _stored_like_count(db_session, post=post, user=reader_user) == 1


@pytest.mark.parametrize(
    ("authorization", "expected_detail"),
    [
        pytest.param("Basic dXNlcjpwYXNzd29yZA==", _DETAIL_NO_CREDENTIAL, id="non-bearer-scheme"),
        pytest.param("Bearer", _DETAIL_NO_CREDENTIAL, id="bearer-with-no-credential"),
        pytest.param("Bearer    ", _DETAIL_NO_CREDENTIAL, id="bearer-with-blank-credential"),
        pytest.param("Bearer not.a.real.token", _DETAIL_INVALID_TOKEN, id="malformed-token"),
        pytest.param("Bearer " + "a" * 64, _DETAIL_INVALID_TOKEN, id="opaque-token"),
    ],
)
async def test_liking_with_a_malformed_credential_is_unauthorized(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    authorization: str,
    expected_detail: str,
) -> None:
    """Every unusable Authorization header on a mutation is 401 and writes nothing.

    Five shapes, two ``detail`` strings and one status. The split is where the rejection happens
    rather than a distinction a client should act on: a header the bearer parse cannot use is
    refused before any principal is resolved, while a well-formed header carrying an undecodable
    token is refused by the token decoder. Neither reveals *which* check failed beyond that,
    because a caller that cannot authenticate has one remedy - obtain a fresh credential.
    """
    post = await factories.create_published_post(db_session, author=author_user)
    path = _like_path(post.id)

    response = await client.put(path, headers={"Authorization": authorization})

    _assert_problem_document(
        response,
        status=401,
        error_type=_TYPE_UNAUTHORIZED,
        detail=expected_detail,
        instance=path,
    )
    assert response.headers[WWW_AUTHENTICATE_HEADER] == "Bearer"
    assert await _stored_like_count(db_session, post=post) == 0


async def test_presenting_a_refresh_token_as_a_bearer_credential_is_unauthorized(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    reader_user: User,
) -> None:
    """A refresh token offered as an access token is refused - the token-type-confusion rejection.

    A refresh token is a genuine, live credential belonging to this very account, so this is the one
    negative here that a naive implementation could plausibly accept. It is opaque - 32 bytes of
    CSPRNG output, stored only as a digest - and is the credential ``POST /api/v1/auth/refresh``
    consumes, never one ``get_current_user`` may resolve. ``decode_access_token`` verifies the token
    type as one of its checks, so the two credential kinds cannot be substituted for one another.
    """
    post = await factories.create_published_post(db_session, author=author_user)
    refresh_token, _row = await factories.create_refresh_token(db_session, user=reader_user)
    path = _like_path(post.id)

    response = await client.put(path, headers={"Authorization": f"Bearer {refresh_token}"})

    _assert_problem_document(
        response,
        status=401,
        error_type=_TYPE_UNAUTHORIZED,
        detail=_DETAIL_INVALID_TOKEN,
        instance=path,
    )
    assert await _stored_like_count(db_session, post=post) == 0


async def test_like_by_deactivated_account_is_forbidden(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """A suspended account is refused a like with 403, where the public read serves it as anonymous.

    ``CurrentUser`` is where deactivation becomes a refusal, and the status is 403 rather than 401
    because the credential is perfectly valid - it is the account that may no longer act, so
    re-authenticating will not clear it. Liking requires no role, so deactivation is the only state
    that produces this status on this route. Contrast
    :func:`test_read_by_deactivated_account_is_served_as_anonymous`.
    """
    post = await factories.create_published_post(db_session, author=author_user)
    suspended = await factories.create_user(db_session, is_active=False)
    path = _like_path(post.id)

    response = await client.put(path, headers=auth_headers_for(suspended))

    _assert_problem_document(
        response,
        status=403,
        error_type=_TYPE_FORBIDDEN,
        detail=_DETAIL_DEACTIVATED,
        instance=path,
    )
    assert await _stored_like_count(db_session, post=post) == 0


async def test_unlike_by_deactivated_account_is_forbidden(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """A suspended account cannot withdraw a like either, and the existing row survives."""
    post = await factories.create_published_post(db_session, author=author_user)
    suspended = await factories.create_reader(db_session)
    await client.put(_like_path(post.id), headers=auth_headers_for(suspended))
    # Arrangement, as in the read counterpart above: active to grant the like, then suspended.
    suspended.is_active = False
    await db_session.flush()
    path = _like_path(post.id)

    response = await client.delete(path, headers=auth_headers_for(suspended))

    _assert_problem_document(
        response,
        status=403,
        error_type=_TYPE_FORBIDDEN,
        detail=_DETAIL_DEACTIVATED,
        instance=path,
    )
    assert await _stored_like_count(db_session, post=post, user=suspended) == 1


# ---------------------------------------------------------------------------------------
# Posts that are missing, malformed, or invisible
#
# All three routes open by loading a post the caller is entitled to know about, so all three
# answer identically: 404 for absence AND for inaccessibility, 422 for a malformed identifier.
# ---------------------------------------------------------------------------------------


async def test_liking_an_unknown_post_is_not_found(
    client: AsyncClient,
    db_session: AsyncSession,
    reader_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """PUT against an identifier no post carries is a 404 problem document (AAP §0.9.4.3)."""
    path = _like_path(uuid.uuid4())

    response = await client.put(path, headers=auth_headers_for(reader_user))

    _assert_problem_document(
        response,
        status=404,
        error_type=_TYPE_NOT_FOUND,
        detail=_DETAIL_POST_NOT_FOUND,
        instance=path,
    )
    assert await _stored_like_count(db_session) == 0


async def test_unliking_an_unknown_post_is_not_found(
    client: AsyncClient,
    reader_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """DELETE against an unknown identifier is 404, not the no-op a missing *like* would be.

    The distinction matters: a missing like on a real post is a no-op answering 200, while a missing
    *post* is a 404. Both are resolved before the like is considered, because the visibility gate
    opens every method.
    """
    path = _like_path(uuid.uuid4())

    response = await client.delete(path, headers=auth_headers_for(reader_user))

    _assert_problem_document(
        response,
        status=404,
        error_type=_TYPE_NOT_FOUND,
        detail=_DETAIL_POST_NOT_FOUND,
        instance=path,
    )


async def test_reading_likes_of_an_unknown_post_is_not_found(client: AsyncClient) -> None:
    """The public read answers 404 for an unknown post rather than a count of zero.

    A zero count is a statement about a post that exists. Reporting one for an identifier that names
    nothing would make every random UUID look like an unliked post.
    """
    path = _likes_path(uuid.uuid4())

    response = await client.get(path)

    _assert_problem_document(
        response,
        status=404,
        error_type=_TYPE_NOT_FOUND,
        detail=_DETAIL_POST_NOT_FOUND,
        instance=path,
    )


@pytest.mark.parametrize(
    "method",
    ["PUT", "DELETE", "GET"],
)
async def test_a_malformed_post_id_is_a_validation_failure(
    client: AsyncClient,
    reader_user: User,
    auth_headers_for: AuthHeaderFactory,
    method: str,
) -> None:
    """A ``post_id`` that is not a UUID is 422 with a populated errors array - never a 500.

    ``post_id`` is the only input any of these three operations takes: none accepts a body and none
    accepts a query parameter, so it is the only way a request here can fail validation. The body is
    this API's own problem document rather than the framework's ``{"detail": [...]}`` default, and
    its ``errors`` array names the offending path parameter so a client can point at it.
    """
    path = _likes_path(_MALFORMED_POST_ID) if method == "GET" else _like_path(_MALFORMED_POST_ID)

    response = await client.request(method, path, headers=auth_headers_for(reader_user))

    payload = _assert_problem_document(
        response,
        status=422,
        error_type=_TYPE_VALIDATION,
        detail=_DETAIL_VALIDATION_FAILED,
        instance=path,
    )
    assert payload["errors"], "a validation failure must name the field that failed"
    assert [entry["field"] for entry in payload["errors"]] == ["post_id"]
    assert all(entry["type"] == "uuid_parsing" for entry in payload["errors"])


async def test_a_third_party_cannot_like_another_authors_draft(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    reader_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """An authenticated third party liking somebody else's draft is refused as 404, not 403.

    A post the caller may not see can be neither liked nor counted - a like control on an invisible
    draft has to be invisible too. The rule is ``can_view_post``, declared once in
    ``app.services.post_service`` and *called* by ``like_service`` rather than restated, so posts,
    comments and likes cannot drift apart; ``backend/tests/unit/test_permissions.py`` targets the
    predicate itself and this test asserts only that the like surface consults it.

    404 rather than 403 is the confidentiality decision. A 403 would confirm that the identifier
    names a real post, which is exactly the fact an unpublished draft is entitled to keep, and it
    would let anyone map the drafts on the site by reading status codes.
    """
    draft = await factories.create_post(db_session, author=author_user, status=PostStatus.DRAFT)
    path = _like_path(draft.id)

    response = await client.put(path, headers=auth_headers_for(reader_user))

    _assert_problem_document(
        response,
        status=404,
        error_type=_TYPE_NOT_FOUND,
        detail=_DETAIL_POST_NOT_FOUND,
        instance=path,
    )
    assert await _stored_like_count(db_session, post=draft) == 0


async def test_an_anonymous_caller_cannot_read_a_drafts_like_count(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
) -> None:
    """A draft's like count is unreachable without a session, so the public read answers 404.

    The count is public only for a post that is itself public. An anonymous caller can see no draft
    at all, and reporting a count - even zero - for one would disclose that the draft exists.
    """
    draft = await factories.create_post(db_session, author=author_user, status=PostStatus.DRAFT)
    path = _likes_path(draft.id)

    response = await client.get(path)

    _assert_problem_document(
        response,
        status=404,
        error_type=_TYPE_NOT_FOUND,
        detail=_DETAIL_POST_NOT_FOUND,
        instance=path,
    )


async def test_an_archived_post_is_invisible_to_a_third_party(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    reader_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """Archiving withdraws a post from the like surface exactly as a draft is withheld.

    ``can_view_post`` admits ``PUBLISHED`` alone, so ``ARCHIVED`` is refused to a third party for
    the same reason ``DRAFT`` is - the predicate names the one visible state rather than enumerating
    the hidden ones, which is what stops a new lifecycle state from defaulting to public.
    """
    archived = await factories.create_post(
        db_session,
        author=author_user,
        status=PostStatus.ARCHIVED,
    )
    path = _like_path(archived.id)

    response = await client.put(path, headers=auth_headers_for(reader_user))

    _assert_problem_document(
        response,
        status=404,
        error_type=_TYPE_NOT_FOUND,
        detail=_DETAIL_POST_NOT_FOUND,
        instance=path,
    )
    assert await _stored_like_count(db_session, post=archived) == 0


async def test_an_author_may_like_and_read_their_own_draft(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """The draft's own author is admitted, which is the positive half of ``can_view_post``.

    Without this the 404 above could be produced by a surface that refused every draft to everybody,
    and the predicate would be untested in the direction that matters for authoring.
    """
    draft = await factories.create_post(db_session, author=author_user, status=PostStatus.DRAFT)
    headers = auth_headers_for(author_user)

    liked = await client.put(_like_path(draft.id), headers=headers)
    summary = await client.get(_likes_path(draft.id), headers=headers)

    assert liked.status_code == 200
    assert summary.status_code == 200
    _assert_summary(liked.json(), post=draft, like_count=1, liked_by_caller=True)
    _assert_summary(summary.json(), post=draft, like_count=1, liked_by_caller=True)
    assert await _stored_like_count(db_session, post=draft, user=author_user) == 1


async def test_an_administrator_may_like_and_read_any_draft(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    admin_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """An administrator is admitted to a draft they did not write (AAP §0.1.3 role model).

    The third branch of ``can_view_post``, and the reason the role has to be an attribute of the
    user record rather than something the client hides: authority is re-checked server-side on every
    request, so an administrator reaches the draft while the reader in
    :func:`test_a_third_party_cannot_like_another_authors_draft` does not.
    """
    draft = await factories.create_post(db_session, author=author_user, status=PostStatus.DRAFT)
    assert admin_user.role is UserRole.ADMIN
    headers = auth_headers_for(admin_user)

    liked = await client.put(_like_path(draft.id), headers=headers)
    summary = await client.get(_likes_path(draft.id), headers=headers)

    assert liked.status_code == 200
    assert summary.status_code == 200
    _assert_summary(liked.json(), post=draft, like_count=1, liked_by_caller=True)
    _assert_summary(summary.json(), post=draft, like_count=1, liked_by_caller=True)
    assert await _stored_like_count(db_session, post=draft, user=admin_user) == 1


# ---------------------------------------------------------------------------------------
# Referential integrity, corroborated briefly
#
# Both foreign keys of `post_likes` are declared ON DELETE CASCADE, so a like cannot outlive
# either of the rows it points at. `test_posts_api.py` owns the cascade proof in depth; these
# two tests are one corroborating assertion each, from the side that can observe it.
# ---------------------------------------------------------------------------------------


async def test_deleting_a_post_removes_its_likes(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """Deleting a post cascades away its likes (AAP §0.9.4.2, "Cascades behave").

    ``post_likes.post_id`` is declared ``ON DELETE CASCADE``, so the removal is the database's and
    needs no application-side sweep - which is what makes it impossible to leave an orphaned like
    behind by forgetting one.
    """
    post = await factories.create_published_post(db_session, author=author_user)
    for _ in range(2):
        liker = await factories.create_reader(db_session)
        await client.put(_like_path(post.id), headers=auth_headers_for(liker))
    assert await _stored_like_count(db_session, post=post) == 2

    deleted = await client.delete(f"{_POSTS_PATH}/{post.id}", headers=auth_headers_for(author_user))

    assert deleted.status_code == 204
    assert await _stored_like_count(db_session, post=post) == 0


async def test_deleting_an_account_removes_its_likes(
    client: AsyncClient,
    db_session: AsyncSession,
    author_user: User,
    admin_user: User,
    auth_headers_for: AuthHeaderFactory,
) -> None:
    """Deleting an account cascades away the likes it granted, and the count falls accordingly.

    The mirror of the post cascade, through ``post_likes.user_id``. Asserting that the surviving
    account's like is still counted is what distinguishes a cascade from a table-wide delete.
    """
    post = await factories.create_published_post(db_session, author=author_user)
    departing = await factories.create_reader(db_session)
    staying = await factories.create_reader(db_session)
    await client.put(_like_path(post.id), headers=auth_headers_for(departing))
    await client.put(_like_path(post.id), headers=auth_headers_for(staying))

    removed = await client.delete(
        f"{API_V1_PREFIX}/admin/users/{departing.id}",
        headers=auth_headers_for(admin_user),
    )

    assert removed.status_code == 204
    assert await _stored_like_count(db_session, user=departing) == 0
    assert await _stored_like_count(db_session, post=post) == 1

    remaining = await client.get(_likes_path(post.id), headers=auth_headers_for(staying))
    assert remaining.status_code == 200
    _assert_summary(remaining.json(), post=post, like_count=1, liked_by_caller=True)
