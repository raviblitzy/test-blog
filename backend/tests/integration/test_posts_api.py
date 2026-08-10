"""Integration tests for ``/api/v1/posts``: the whole post lifecycle, and its negatives.

This module is the proof of Agent Action Plan requirement **R2** - "create, edit, delete, and
publish blog posts" - driven end to end over HTTP. It is the structural replacement for the five
retired ``/items`` handlers at ``app.py:L15-L49``, and it is foundational to the rest of the
integration suite: ``test_post_search_filter_pagination.py``, ``test_comments_api.py``,
``test_likes_api.py``, ``test_profiles_api.py`` and ``test_admin_api.py`` all presuppose the
lifecycle established here.

Four AAP acceptance criteria are discharged, and each has its own section below:

* **§0.9.4.4 "Publish lifecycle"** - a created post is a draft, publishing stamps the publication
  instant and makes the post visible, unpublishing withdraws it, and neither transition is
  reachable through the general update.
* **§0.9.4.4 "Draft confidentiality"** - a draft is absent from the feed, from a category-filtered
  result and from a public profile, and is readable only by its author or an administrator.
* **§0.9.4.4 "Authorisation negatives"** - every unauthenticated mutation is 401, every mutation by
  a principal who is neither the owner nor an administrator is 403, and an administrator may act
  on any post.
* **§0.9.4.2 "Cascades behave"** - deleting a post removes its comments, its likes and its category
  filings, and the rows are verified gone through the session rather than inferred from a 204.

No user rules govern this file
-----------------------------
``review_rules`` returns ``No user rules provided.`` - a complete response, not a truncated
window - so **no user-specified rule governs this file and no rule placed it in scope**. It is in
scope solely by the AAP's file inventory (§0.4.4.5) and execution plan (§0.7.1.11). Nothing here
is invented to fill that gap, and the absence of rules is not treated as licence to lower the
bar: the substitute standard is the AAP's own §0.10.1 enterprise standards, three of which this
file discharges directly.

* **#3, server-owned identity and database-enforced integrity.** Identity, the publication
  invariant and the delete cascades are asserted as *database* guarantees. No client-supplied
  ``id`` or ``slug`` is honoured - the schema refuses the member outright - and the cascade test
  reads ``comments``, ``post_likes`` and ``post_categories`` back through ``db_session`` to prove
  the rows are gone rather than trusting the status code.
* **#6, secure-by-default authentication.** Every 401 and every 403 below is a requirement, not an
  extra. Hiding a control in a client is not a boundary, so each negative additionally re-reads
  the post to prove the server refused the *effect* and not merely the response.
* **#8, blocking quality gates.** ``pytest backend/tests --cov=backend/app --cov-fail-under=80``
  blocks. There is no ``skip``, no ``xfail``, no placeholder and nothing order-dependent here.

Three contract details that are easy to get wrong
-------------------------------------------------
**The single read is addressed by ``{slug}``; every mutation is addressed by ``{post_id}``.** That
asymmetry is deliberate - the slug is the canonical URL and the UUID is the identity - and mixing
them produces a 404 that looks like a missing row. :func:`_slug_path` and :func:`_post_path` exist
so no test builds a path by hand.

**Every post mutation requires the ``AUTHOR`` or ``ADMIN`` role, not merely a token.** The routes
depend on ``AuthorUser`` (``require_author``), so an authenticated ``READER`` is refused with 403
rather than admitted. Authority is then narrowed a second time, by ownership, inside
``app.services.post_service`` - which is why a non-owner ``AUTHOR`` is also 403.

**Feed assertions are membership assertions, and they page.** The ``posts`` relation is not empty
in every environment: a test database shared with another checkout can hold rows this module did
not create, and the default window is only 20 rows. So no assertion here says "the feed is empty"
or compares ``total`` against a literal. :func:`_collect_feed_ids` walks every page of a result
and returns the identifiers, and each test asserts that one specific identifier is present or
absent. That makes the outcome independent of collection order, of residue, and of how many posts
happen to exist.

Boundaries
----------
Search relevance, filter composition and pagination arithmetic belong to
``test_post_search_filter_pagination.py``; the feed is used here only as a *visibility* surface.
Ownership and role predicates belong to ``tests/unit/test_permissions.py`` and slug derivation to
``tests/unit/test_slug.py``; this module asserts only their HTTP consequences. Like idempotency
belongs to ``test_likes_api.py`` - likes appear here only as cascade fodder. Nothing below calls
``PostService``, ``PostRepository`` or ``post_service.can_view_post``: behaviour is driven through
``client``, and ``db_session`` is read only to confirm a database-level effect. And no
``__init__.py`` is added to this tree.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from types import MappingProxyType
from typing import Any, Final, NamedTuple

import pytest
from httpx import AsyncClient, Response
from pydantic import HttpUrl, TypeAdapter
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import MAX_PAGE_SIZE
from app.core.slug import DEFAULT_MAX_LENGTH as SLUG_MAX_LENGTH
from app.models import (
    Category,
    Comment,
    CommentStatus,
    Post,
    PostLike,
    PostStatus,
    User,
    post_categories,
)
from app.repositories import PostRepository
from app.schemas.post import (
    CONTENT_MAX_LENGTH,
    EXCERPT_MAX_LENGTH,
    MAX_CATEGORIES_PER_POST,
    TITLE_MAX_LENGTH,
)
from tests import factories

# =======================================================================================
# Paths
#
# Spelled once each. `app.api.v1.router` mounts `posts.router` under `/api/v1/posts`, and the
# feed route is registered as `""` rather than `"/"` precisely so the collection path carries no
# trailing slash - a `/` here would compose to `/api/v1/posts/` and answer 307.
# =======================================================================================

POSTS_URL: Final[str] = "/api/v1/posts"
"""The collection: ``GET`` lists the feed and ``POST`` creates a draft."""

PROFILE_POSTS_URL_TEMPLATE: Final[str] = "/api/v1/users/{username}/posts"
"""An author's public profile listing, used once, to prove a draft cannot leak through it."""


def _slug_path(slug: str) -> str:
    """Build the path of the single **read**, which is addressed by slug and never by identifier.

    Args:
        slug: The post's canonical slug, exactly as the API returned it - or a case variant of
            it, which ``citext`` resolves to the same row.

    Returns:
        The absolute request path for ``GET /api/v1/posts/{slug}``.
    """
    return f"{POSTS_URL}/{slug}"


def _post_path(post_id: str | uuid.UUID, *, action: str | None = None) -> str:
    """Build the path of a **mutation**, which is addressed by identifier and never by slug.

    Args:
        post_id: The post's server-generated UUID, as a string or a :class:`uuid.UUID`.
        action: Optional lifecycle sub-resource - ``"publish"`` or ``"unpublish"``. Omit it for
            ``PATCH`` and ``DELETE``, which address the post itself.

    Returns:
        The absolute request path for the mutation.
    """
    base = f"{POSTS_URL}/{post_id}"
    return base if action is None else f"{base}/{action}"


# =======================================================================================
# Response contracts
#
# Exact field sets rather than "contains", because the omissions are as much a part of the
# contract as the members. `PostSummary` deliberately carries no `content`, so a feed page stays
# small however long the articles are, and `UserPublic` deliberately carries no `email`, `role`
# or `is_active`, so a byline cannot disclose them. Asserting equality is what makes an
# accidental widening of either projection fail a test instead of passing review.
# =======================================================================================

POST_SUMMARY_FIELDS: Final[frozenset[str]] = frozenset(
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
"""Every member of ``PostSummary`` - the feed projection. Note the absence of ``content``."""

POST_DETAIL_FIELDS: Final[frozenset[str]] = POST_SUMMARY_FIELDS | {"content", "updated_at"}
"""Every member of ``PostDetail``: the summary field set plus the body and the edit instant."""

USER_PUBLIC_FIELDS: Final[frozenset[str]] = frozenset(
    {"id", "username", "display_name", "bio", "avatar_url", "created_at"}
)
"""Every member of ``UserPublic`` - the embedded ``author`` projection."""

WITHHELD_USER_FIELDS: Final[tuple[str, ...]] = ("email", "role", "is_active", "password_hash")
"""Members a public byline must never carry, asserted explicitly rather than left to the set."""

CATEGORY_SUMMARY_FIELDS: Final[frozenset[str]] = frozenset({"id", "name", "slug"})
"""Every member of ``CategorySummary`` - the embedded badge projection."""

PAGE_ENVELOPE_FIELDS: Final[frozenset[str]] = frozenset(
    {"items", "total", "page", "page_size", "pages"}
)
"""The uniform collection envelope every listing in this API returns."""

PROBLEM_DOCUMENT_FIELDS: Final[frozenset[str]] = frozenset(
    {"type", "title", "status", "detail", "instance", "request_id"}
)
"""Members present on every error, whatever its kind. ``errors`` is additional, and 422 only."""

SERVER_OWNED_MEMBERS: Final[tuple[str, ...]] = (
    "id",
    "slug",
    "status",
    "published_at",
    "view_count",
    "author_id",
)
"""The six members a client may never supply. ``PostCreate`` forbids each of them by name."""

_SERVER_OWNED_ATTEMPTS: Final[Mapping[str, Any]] = MappingProxyType(
    {
        "id": "3f2a9c11-8b74-4d5e-9a1c-6e0f2b7d4c88",
        "slug": "client-chosen-canonical-url",
        "status": PostStatus.PUBLISHED.value,
        "published_at": "2020-01-01T00:00:00Z",
        "view_count": 9_999,
        "author_id": "b41e07d6-2c9a-4f18-8d33-71a5c6e0f2b9",
    }
)
"""A plausible value a client might try for each server-owned member.

Read-only, because one test copies the whole mapping into a request body and another indexes a
single entry per parametrised case; a shared mutable dictionary would let the first quietly change
what the second submits.
"""


# =======================================================================================
# Error contract
#
# `app.core.exceptions` publishes these as its stable surface: the `type` is a URI reference
# under a single `/errors/` prefix and the `title` is fixed per kind, so both are safe to assert
# on. Only `detail` varies between two occurrences of the same failure.
# =======================================================================================

ERROR_TYPE_UNAUTHORIZED: Final[str] = "/errors/unauthorized"
ERROR_TYPE_FORBIDDEN: Final[str] = "/errors/forbidden"
ERROR_TYPE_NOT_FOUND: Final[str] = "/errors/not-found"
ERROR_TYPE_VALIDATION: Final[str] = "/errors/validation-error"
ERROR_TYPE_CONFLICT: Final[str] = "/errors/conflict"

ERROR_TITLE_UNAUTHORIZED: Final[str] = "Unauthorized"
ERROR_TITLE_FORBIDDEN: Final[str] = "Forbidden"
ERROR_TITLE_NOT_FOUND: Final[str] = "Not Found"
ERROR_TITLE_VALIDATION: Final[str] = "Validation Error"
ERROR_TITLE_CONFLICT: Final[str] = "Conflict"

WWW_AUTHENTICATE_HEADER: Final[str] = "WWW-Authenticate"
BEARER_CHALLENGE: Final[str] = "Bearer"


# =======================================================================================
# Fixture content
#
# One canonical draft payload, so a test states only the member it is actually varying. The
# marker strings are distinctive enough that a substring search for one is an exact test of
# whether a value survived a write.
# =======================================================================================

DRAFT_TITLE: Final[str] = "Retiring the In-Memory Item Store"
DRAFT_EXCERPT: Final[str] = "Why a module-level list was never storage."
DRAFT_CONTENT: Final[str] = (
    "## The list was not a database\n\nA module-level list does not survive a restart, and two "
    "workers holding one each disagree about what exists."
)
DRAFT_COVER_IMAGE_URL: Final[str] = "https://cdn.example.com/covers/retiring-the-item-store.png"

# ---------------------------------------------------------------------------------------
# Boundary vocabulary
#
# Every value below is DERIVED from the constant that enforces it, never transcribed. A literal
# `"x" * 121` stops being the title ceiling the moment `TITLE_MAX_LENGTH` moves, and it stops
# without failing: 121 characters remains a perfectly sendable value, so the assertion quietly
# becomes a test that long titles are accepted.
# ---------------------------------------------------------------------------------------

COVER_URL_MAX_LENGTH: Final[int] = int(TypeAdapter(HttpUrl).json_schema()["maxLength"])
"""The ceiling on ``cover_image_url``, read from the type that enforces it.

``app.schemas.post.OptionalCoverImageUrl`` declares no explicit bound because
:class:`~pydantic.HttpUrl` carries one of its own and publishes it as ``maxLength`` in the
generated schema - which is the value a client generating a form reads. Taking it from the same
place the client does is what keeps this suite and that client agreeing; hard-coding 2083 here
would be transcribing a number out of a dependency's implementation."""

ASTRAL: Final[str] = "😀"
"""One astral code point: U+1F600, outside the Basic Multilingual Plane.

The reason it appears in these boundaries at all is that the three units a length limit might be
counted in disagree about it. It is **one** code point - which is what
``pydantic.StringConstraints`` counts, and therefore what this API's limits mean - but **two**
UTF-16 code units, which is what a browser's ``String.length`` and a naive mirrored client-side
check count, and **four** UTF-8 bytes, which is what a byte-bounded column would count. So a field
filled to its exact ceiling with this character is accepted by a correct implementation and refused
by either wrong one, and that is a distinction no ASCII test case can make."""

#: Cover-image destinations that must never be stored, with the validator that must refuse each.
#: The stored value is interpolated into an image source on every card and every post page, so the
#: scheme allow-list is the control standing between an author-supplied field and a script vector -
#: and `//host/path`, being scheme-relative, would inherit the page's own scheme and load anyway.
HOSTILE_COVER_URLS: Final[tuple[tuple[str, str, str], ...]] = (
    ("javascript:alert(1)", "url_scheme", "javascript-scheme"),
    ("JavaScript:alert(1)", "url_scheme", "javascript-scheme-mixed-case"),
    ("  javascript:alert(1)  ", "url_scheme", "javascript-scheme-padded-with-whitespace"),
    (
        "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
        "url_scheme",
        "data-scheme-carrying-a-document",
    ),
    ("data:image/png;base64,iVBORw0KGgo=", "url_scheme", "data-scheme-carrying-an-image"),
    ("vbscript:msgbox(1)", "url_scheme", "vbscript-scheme"),
    ("file:///etc/passwd", "url_scheme", "file-scheme"),
    ("ftp://example.com/cover.png", "url_scheme", "ftp-scheme"),
    ("//example.com/cover.png", "url_parsing", "scheme-relative-reference"),
    ("/covers/local.png", "url_parsing", "site-relative-path"),
    ("covers/local.png", "url_parsing", "bare-relative-path"),
    ("http://", "url_parsing", "scheme-with-no-host"),
    ("definitely not a url", "url_parsing", "prose"),
)


def _cover_url_of_length(length: int) -> str:
    """Return an absolute ``https`` URL of exactly *length* characters.

    Args:
        length: The total length the URL must have. Must leave room for the fixed prefix.

    Returns:
        A URL whose scheme and host are valid and whose path is padded to reach *length*.

    Raises:
        ValueError: If *length* is too small to hold the prefix, which would silently produce a URL
            refused for being malformed rather than for being too long.
    """
    prefix = "https://cdn.example.com/covers/"
    if length < len(prefix) + 1:
        message = f"length must be at least {len(prefix) + 1}, got {length}"
        raise ValueError(message)
    return prefix + "a" * (length - len(prefix))


def _filled(length: int, *, character: str = "x") -> str:
    """Return *character* repeated to exactly *length* code points."""
    return character * length


SLUG_PATTERN: Final[re.Pattern[str]] = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
"""The shape ``app.core.slug.slugify_title`` guarantees, and the canonical URL depends on.

Lowercase ASCII alphanumerics separated by single hyphens, with no leading, trailing or repeated
hyphen. Asserted rather than assumed because the value appears verbatim in every canonical URL,
sitemap entry and social card built from the post.
"""


class _SanitisationCase(NamedTuple):
    """One write-side content-sanitisation expectation.

    Attributes:
        label: Human-readable name, used as the parametrised case identifier.
        submitted: The body as an author submits it.
        expected: The body as it must be stored and returned, spelled out in full rather than
            asserted through a substring, so a policy change is visible as a diff.
    """

    label: str
    submitted: str
    expected: str


SANITISATION_CASES: Final[tuple[_SanitisationCase, ...]] = (
    _SanitisationCase(
        "inline-link-disallowed-scheme",
        "See [trap](javascript:alert(1)) here.",
        "See trap here.",
    ),
    _SanitisationCase(
        "inline-link-angle-bracketed-destination",
        "See [trap](<javascript:alert(1)>) here.",
        "See trap here.",
    ),
    _SanitisationCase(
        "autolink-loses-its-link",
        "See <javascript:alert(1)> here.",
        "See javascript:alert(1) here.",
    ),
    _SanitisationCase(
        "reference-definition-points-at-a-fragment",
        "See [trap][ref] here.\n\n[ref]: javascript:alert(1)",
        "See [trap][ref] here.\n\n[ref]: #",
    ),
    _SanitisationCase(
        "image-with-a-data-uri",
        "![shot](data:text/html;base64,PHNjcmlwdD4=)",
        "shot",
    ),
    _SanitisationCase(
        "numeric-character-reference-for-the-colon",
        "See [trap](javascript&#58;alert(1)) here.",
        "See trap here.",
    ),
    _SanitisationCase(
        "hexadecimal-character-reference-for-the-colon",
        "See [trap](javascript&#x3A;alert(1)) here.",
        "See trap here.",
    ),
    _SanitisationCase(
        "named-character-reference-for-the-colon",
        "See [trap](javascript&colon;alert(1)) here.",
        "See trap here.",
    ),
    _SanitisationCase(
        "backslash-escaped-colon",
        "See [trap](javascript\\:alert(1)) here.",
        "See trap here.",
    ),
    _SanitisationCase(
        "character-reference-inside-the-scheme-name",
        "See [trap](&#106;avascript:alert(1)) here.",
        "See trap here.",
    ),
    _SanitisationCase(
        "encoded-scheme-on-an-image",
        "![shot](JaVaScRiPt&#58;alert(1))",
        "shot",
    ),
    _SanitisationCase(
        "encoded-scheme-in-a-reference-definition",
        "See [trap][ref] here.\n\n[ref]: javascript&#58;alert(1)",
        "See [trap][ref] here.\n\n[ref]: #",
    ),
    _SanitisationCase(
        "encoded-scheme-in-an-autolink",
        "See <javascript&#58;alert(1)> here.",
        "See javascript&#58;alert(1) here.",
    ),
    _SanitisationCase(
        "encoded-ampersand-in-a-relative-query-is-kept",
        "[docs](/docs/index.md?a=1&amp;b=2)",
        "[docs](/docs/index.md?a=1&amp;b=2)",
    ),
    _SanitisationCase(
        "vbscript-scheme",
        "[trap](vbscript:msgbox(1))",
        "trap",
    ),
    _SanitisationCase(
        "unparseable-link-opening-is-defused",
        "prefix](javascript:alert(1))",
        "prefix] (javascript:alert(1))",
    ),
    _SanitisationCase(
        "permitted-destinations-are-kept",
        "[docs](/docs/architecture.md) and [mail](mailto:someone@example.com)",
        "[docs](/docs/architecture.md) and [mail](mailto:someone@example.com)",
    ),
    _SanitisationCase(
        "fenced-code-is-not-rewritten",
        "```\n[trap](javascript:alert(1))\n```\ntail",
        "```\n[trap](javascript:alert(1))\n```\ntail",
    ),
    _SanitisationCase(
        "code-span-is-not-rewritten",
        "Inline `[trap](javascript:alert(1))` span.",
        "Inline `[trap](javascript:alert(1))` span.",
    ),
)
"""Every Markdown destination form and spelling the write-side policy has to decide about.

Both halves of the policy are represented deliberately. Most cases are destinations that must lose
their link, one per syntactic form *and* one per obfuscation, because an allow-list applied to only
one form or only the literal spelling is no allow-list at all. The rest must be left **exactly**
alone - a relative path, a permitted ``mailto:``, an encoded ampersand in a query string, and a
dangerous destination written inside code, which is documentation rather than a link. A sanitiser
that failed those would be safe and useless.

The obfuscated spellings are the ones worth naming, because they are the ones that used to slip
through. CommonMark resolves both HTML character references and backslash escapes inside a link
destination, so ``javascript&#58;``, ``javascript&#x3A;``, ``javascript&colon;``,
``javascript\\:`` and ``&#106;avascript:`` all become ``javascript:`` in the rendered document
while carrying **no colon at all** in the source. A scheme check applied to the source text found
no scheme in any of them, concluded "relative destination, therefore safe" and stored the payload
untouched. The decode now happens before the check, on every one of the four forms.

Percent-encoding is deliberately absent from this list, and its absence is a decision: a browser
does not resolve ``javascript%3A`` as a scheme, so refusing it would break inert links.
"""

PUBLISH_INSTANT_TOLERANCE: Final[timedelta] = timedelta(minutes=5)
"""How far ``published_at`` may sit from the assertion's own clock and still be "now".

Generous on purpose. The stamp comes from the application clock and the assertion from the test
process, so a tight bound would turn ordinary scheduling latency into a flake - and the property
under test is that an instant was stamped at all, not that it was stamped to the millisecond.
"""


def _draft_payload(**overrides: Any) -> dict[str, Any]:
    """Build a valid ``PostCreate`` body, with any member replaced or removed.

    Args:
        **overrides: Members to replace. A value of ``...`` (:data:`Ellipsis`) removes the member
            instead of replacing it, which is how a test states "omit ``title``" without
            rebuilding the whole body.

    Returns:
        A fresh dictionary, so a caller mutating the result cannot affect the next call.
    """
    payload: dict[str, Any] = {
        "title": DRAFT_TITLE,
        "excerpt": DRAFT_EXCERPT,
        "content": DRAFT_CONTENT,
        "cover_image_url": DRAFT_COVER_IMAGE_URL,
        "category_ids": [],
    }
    payload.update(overrides)
    return {name: value for name, value in payload.items() if value is not ...}


# =======================================================================================
# Shape assertions
#
# Written as helpers rather than repeated inline so that every test asserting on a post asserts
# the *same* contract, and so that widening a projection fails everywhere at once instead of in
# whichever test happened to enumerate the new member.
# =======================================================================================


def _assert_public_author(author: dict[str, Any], expected: User) -> None:
    """Assert an embedded byline is the public projection of ``expected`` and nothing more.

    Discharges AAP §0.10.1 standard #6 at the response boundary: a byline names an account, and
    naming it must not disclose the account's email address, its role or whether it is still
    active.

    Args:
        author: The ``author`` member of a ``PostSummary`` or ``PostDetail`` response.
        expected: The account the post is expected to belong to.
    """
    assert author.keys() == USER_PUBLIC_FIELDS, sorted(author)
    for withheld in WITHHELD_USER_FIELDS:
        assert withheld not in author, f"the public byline disclosed {withheld!r}"
    assert author["id"] == str(expected.id)
    assert author["username"] == expected.username


def _assert_category_summary(badge: dict[str, Any]) -> None:
    """Assert an embedded category badge carries exactly an identifier, a name and a slug.

    Args:
        badge: One element of the ``categories`` member of a post response.
    """
    assert badge.keys() == CATEGORY_SUMMARY_FIELDS, sorted(badge)
    assert badge["slug"]


def _assert_summary_shape(item: dict[str, Any]) -> dict[str, Any]:
    """Assert a feed element is exactly a ``PostSummary`` - which means it carries no body.

    The absence of ``content`` is a real contract and not an oversight: the feed serialises the
    compact projection so a page stays small however long the articles are, and a client that
    needs the body fetches ``GET /api/v1/posts/{slug}``.

    Args:
        item: One element of the ``items`` list of a feed response.

    Returns:
        The same element, so a caller can chain further assertions onto it.
    """
    assert item.keys() == POST_SUMMARY_FIELDS, sorted(item)
    assert "content" not in item, "the feed projection must not carry the post body"
    assert "updated_at" not in item, "the feed projection must not carry the edit instant"
    assert item["status"] in {member.value for member in PostStatus}
    assert isinstance(item["categories"], list)
    return item


def _assert_detail_shape(body: dict[str, Any]) -> dict[str, Any]:
    """Assert a single-post response is exactly a ``PostDetail``.

    Args:
        body: The decoded body of a create, read, update, publish or unpublish response.

    Returns:
        The same body, so a caller can chain further assertions onto it.
    """
    assert body.keys() == POST_DETAIL_FIELDS, sorted(body)
    assert isinstance(body["content"], str)
    assert body["content"]
    assert body["view_count"] >= 0
    assert isinstance(body["categories"], list)
    for badge in body["categories"]:
        _assert_category_summary(badge)
    return body


def _assert_problem_document(
    response: Response,
    *,
    status: int,
    error_type: str,
    title: str,
) -> dict[str, Any]:
    """Assert a failure answered the one machine-readable problem document, with this status.

    Replaces the three duplicated ad-hoc ``HTTPException(404, "Item not found")`` raises the
    retired surface carried at ``app.py:L31,L40,L49``: the shape is declared once, by a
    registered handler, so every error in the API looks the same to a client.

    Args:
        response: The response under assertion.
        status: The expected HTTP status, which must also appear in the body.
        error_type: The expected stable ``/errors/...`` URI reference.
        title: The expected fixed human-readable summary for this kind of failure.

    Returns:
        The decoded problem document, so a caller can assert on ``detail`` or ``errors``.
    """
    assert response.status_code == status, response.text
    problem: dict[str, Any] = response.json()
    assert problem.keys() >= PROBLEM_DOCUMENT_FIELDS, sorted(problem)
    assert problem["type"] == error_type
    assert problem["title"] == title
    assert problem["status"] == status
    assert problem["detail"], "a problem document must explain this occurrence"
    # The path only, never the query string, and never a bare empty value.
    assert problem["instance"].startswith("/api/v1/"), problem["instance"]
    return problem


def _assert_validation_problem(
    response: Response,
    *,
    field: str,
    error_type: str | None = None,
) -> dict[str, Any]:
    """Assert a 422 carries a populated per-field error list naming ``field``.

    Args:
        response: The response under assertion.
        field: The dotted path the rejection must be attributable to, so a client can attach the
            message to the control that produced it.
        error_type: Optional machine-readable validator identifier - ``extra_forbidden``,
            ``string_too_short`` and so on - asserted against the entries for ``field``.

    Returns:
        The decoded problem document.
    """
    problem = _assert_problem_document(
        response,
        status=422,
        error_type=ERROR_TYPE_VALIDATION,
        title=ERROR_TITLE_VALIDATION,
    )
    errors = problem["errors"]
    assert errors, "a validation problem document must carry a populated error list"
    reported = [entry["field"] for entry in errors]
    assert field in reported, reported
    if error_type is not None:
        kinds = [entry["type"] for entry in errors if entry["field"] == field]
        assert error_type in kinds, kinds
    return problem


def _parse_instant(value: str) -> datetime:
    """Parse a timezone-aware ISO 8601 instant as the API renders it.

    The API renders UTC with a trailing ``Z``, which :meth:`datetime.datetime.fromisoformat`
    accepts from Python 3.11 onwards. The result is asserted to be aware, because a naive instant
    cannot be compared against ``datetime.now(UTC)`` and the comparison would raise rather than
    fail - a confusing way for an assertion to report a real defect.

    Args:
        value: The rendered instant, for example ``2026-02-03T08:15:00Z``.

    Returns:
        The parsed, timezone-aware instant.
    """
    parsed = datetime.fromisoformat(value)
    assert parsed.tzinfo is not None, f"{value!r} is not timezone-aware"
    return parsed


# =======================================================================================
# HTTP helpers
#
# Every one of these drives the application through `client`. Nothing here reaches for a service
# or a repository: a behavioural assertion made against a service would pass even if the route,
# its dependencies or its authority checks were wrong, which is the whole reason this file exists
# alongside the unit suite rather than instead of it.
# =======================================================================================


async def _create_draft(
    client: AsyncClient,
    headers: dict[str, str],
    **overrides: Any,
) -> dict[str, Any]:
    """Create a draft through the API and return its ``PostDetail`` body.

    Args:
        client: The in-process client.
        headers: An ``Authorization`` header for a principal holding ``AUTHOR`` or ``ADMIN``.
        **overrides: Members to vary in the ``PostCreate`` body - see :func:`_draft_payload`.

    Returns:
        The decoded created post, already asserted to be a well-formed ``PostDetail``.
    """
    response = await client.post(POSTS_URL, json=_draft_payload(**overrides), headers=headers)
    assert response.status_code == 201, response.text
    return _assert_detail_shape(response.json())


async def _read_detail(
    client: AsyncClient,
    slug: str,
    *,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Read one post by slug and return its body, asserting a 200 and the detail shape.

    Args:
        client: The in-process client.
        slug: The post's canonical slug.
        headers: An ``Authorization`` header, or ``None`` to read anonymously.

    Returns:
        The decoded post.
    """
    response = await client.get(_slug_path(slug), headers=headers)
    assert response.status_code == 200, response.text
    return _assert_detail_shape(response.json())


async def _collect_page_ids(
    client: AsyncClient,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    **filters: Any,
) -> set[str]:
    """Return every identifier a paginated listing yields for ``filters``, across all pages.

    Membership in this set is how every visibility assertion in this module is phrased, and the
    paging is what makes those assertions trustworthy. The default window is 20 rows and the
    ``posts`` relation is not empty in every environment - a test database shared with another
    checkout can hold posts this module never created - so a single-page read could report
    "absent" for a post that was merely on page two. Walking to ``pages`` removes that failure
    mode, and asking for the maximum window keeps the walk to one request in the ordinary case.

    Args:
        client: The in-process client.
        url: The listing to walk. Both the feed and an author's profile listing return the same
            envelope, which is the point of having one envelope.
        headers: An ``Authorization`` header, or ``None`` for an anonymous caller. The header is
            what decides which lifecycle states are in scope, so it is the single most important
            argument here.
        **filters: Query parameters to apply - ``author``, ``category``, ``q``, ``sort``.

    Returns:
        The identifiers of every post the listing returned, as strings.
    """
    collected: set[str] = set()
    page = 1
    while True:
        response = await client.get(
            url,
            params={**filters, "page": page, "page_size": MAX_PAGE_SIZE},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        body: dict[str, Any] = response.json()
        assert body.keys() == PAGE_ENVELOPE_FIELDS, sorted(body)
        collected.update(str(item["id"]) for item in body["items"])
        # `pages` is zero when nothing matched, so the first iteration is also the last.
        if page >= body["pages"]:
            return collected
        page += 1


async def _collect_feed_ids(
    client: AsyncClient,
    *,
    headers: dict[str, str] | None = None,
    **filters: Any,
) -> set[str]:
    """Return every identifier ``GET /api/v1/posts`` yields for ``filters``, across all pages.

    Args:
        client: The in-process client.
        headers: An ``Authorization`` header, or ``None`` for an anonymous caller.
        **filters: Query parameters to apply.

    Returns:
        The identifiers of every post the feed returned, as strings.
    """
    return await _collect_page_ids(client, POSTS_URL, headers=headers, **filters)


async def _collect_profile_post_ids(
    client: AsyncClient,
    username: str,
    *,
    headers: dict[str, str] | None = None,
) -> set[str]:
    """Return every identifier ``GET /api/v1/users/{username}/posts`` yields, across all pages.

    Used once, to prove from the post side that an unpublished post cannot leak through a public
    profile. The route's own behaviour is ``test_profiles_api.py``'s subject.

    Args:
        client: The in-process client.
        username: The author whose profile listing to walk.
        headers: An ``Authorization`` header, or ``None`` for an anonymous caller. The listing
            hard-filters to published posts and accepts no caller-supplied override, so this
            argument must make no difference - which is itself worth asserting.

    Returns:
        The identifiers of every post the profile listing returned, as strings.
    """
    return await _collect_page_ids(
        client,
        PROFILE_POSTS_URL_TEMPLATE.format(username=username),
        headers=headers,
    )


async def _count_rows(session: AsyncSession, source: Any, predicate: Any) -> int:
    """Count rows in ``source`` matching ``predicate``, going to the database every time.

    A SQL aggregate rather than an ORM identity lookup, and that is the point. After a cascade the
    session's identity map still holds the Python objects for rows PostgreSQL has already removed,
    so ``session.get`` would happily hand one back and a cascade test written that way would pass
    whatever the foreign keys declared. ``count()`` cannot be answered from the identity map.

    Args:
        session: The test's session, inside the transaction ``conftest.py`` rolls back.
        source: The table or mapped class to count from.
        predicate: The ``WHERE`` clause to apply.

    Returns:
        The number of matching rows.
    """
    total = await session.scalar(select(func.count()).select_from(source).where(predicate))
    return 0 if total is None else total


# =======================================================================================
# POST /api/v1/posts - creation
# =======================================================================================


class TestCreatePost:
    """``POST /api/v1/posts``: what a client may state, and what only the server decides."""

    async def test_create_answers_201_with_the_detail_projection(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """Creation answers 201 with a complete ``PostDetail`` echoing the submitted members."""
        response = await client.post(
            POSTS_URL,
            json=_draft_payload(),
            headers=auth_headers_for(author_user),
        )

        assert response.status_code == 201, response.text
        created = _assert_detail_shape(response.json())
        assert created["title"] == DRAFT_TITLE
        assert created["excerpt"] == DRAFT_EXCERPT
        assert created["content"] == DRAFT_CONTENT
        assert created["cover_image_url"] == DRAFT_COVER_IMAGE_URL
        assert created["categories"] == []
        assert created["view_count"] == 0
        # Both audit instants come from the database clock, and a post nobody has edited yet
        # carries the same value in each.
        assert _parse_instant(created["updated_at"]) == _parse_instant(created["created_at"])

    async def test_create_forces_the_draft_lifecycle_state(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """A created post is always a ``DRAFT`` with no publication instant (AAP §0.9.4.4)."""
        created = await _create_draft(client, auth_headers_for(author_user))

        assert created["status"] == PostStatus.DRAFT.value
        assert created["published_at"] is None

    async def test_create_derives_a_url_safe_slug_from_the_title(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """The slug is derived server-side from the title, not supplied by the client."""
        payload = _draft_payload(title="Scaling FastAPI Beyond One Worker")
        assert "slug" not in payload, "the client must not be able to name the canonical URL"

        response = await client.post(POSTS_URL, json=payload, headers=auth_headers_for(author_user))

        assert response.status_code == 201, response.text
        slug = response.json()["slug"]
        assert SLUG_PATTERN.match(slug), slug
        assert len(slug) <= SLUG_MAX_LENGTH
        assert slug.startswith("scaling-fastapi-beyond-one-worker")

    @pytest.mark.parametrize("member", SERVER_OWNED_MEMBERS)
    async def test_create_refuses_every_server_owned_member(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
        member: str,
    ) -> None:
        """Identity and lifecycle are server-owned: ``PostCreate`` forbids each of the six.

        AAP §0.10.1 standard #3. The retired contract made the client the sole source of identity,
        so a duplicate key permanently shadowed every later record; ``extra="forbid"`` on the
        input schema is what makes that class of defect unreachable rather than merely unlikely.
        """
        payload = _draft_payload()
        payload[member] = _SERVER_OWNED_ATTEMPTS[member]

        response = await client.post(POSTS_URL, json=payload, headers=auth_headers_for(author_user))

        _assert_validation_problem(response, field=member, error_type="extra_forbidden")

    async def test_create_refusing_a_server_owned_member_persists_nothing(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """The refusal is an effect, not just a status: no row, and no slug the client chose.

        A 422 alone would be satisfied by a route that rejected the response after writing the
        row, so the assertion is made against the world afterwards - the slug the client tried to
        impose resolves to nothing, and the author owns no post.
        """
        headers = auth_headers_for(author_user)
        imposed_slug = "client-chosen-canonical-url"
        payload = _draft_payload(title="Identity Is Not The Client's")
        payload.update({name: _SERVER_OWNED_ATTEMPTS[name] for name in SERVER_OWNED_MEMBERS})
        payload["slug"] = imposed_slug

        response = await client.post(POSTS_URL, json=payload, headers=headers)
        assert response.status_code == 422, response.text

        refused = await client.get(_slug_path(imposed_slug), headers=headers)
        _assert_problem_document(
            refused,
            status=404,
            error_type=ERROR_TYPE_NOT_FOUND,
            title=ERROR_TITLE_NOT_FOUND,
        )
        assert await _count_rows(db_session, Post, Post.author_id == author_user.id) == 0

    async def test_create_projects_the_calling_principal_as_the_public_author(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """The byline is taken from the credential and rendered as ``UserPublic``, never wider."""
        created = await _create_draft(client, auth_headers_for(author_user))

        _assert_public_author(created["author"], author_user)

    async def test_create_files_the_post_under_the_requested_categories(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """``category_ids`` come back as ``CategorySummary`` badges with the requested ids."""
        first = await factories.create_category(db_session)
        second = await factories.create_category(db_session)

        created = await _create_draft(
            client,
            auth_headers_for(author_user),
            category_ids=[str(first.id), str(second.id)],
        )

        returned = {badge["id"] for badge in created["categories"]}
        assert returned == {str(first.id), str(second.id)}
        names = {badge["name"] for badge in created["categories"]}
        assert names == {first.name, second.name}

    async def test_create_with_an_unknown_category_is_a_not_found_problem_document(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """A category identifier that names nothing is a 404, resolved before any INSERT."""
        unknown = uuid.uuid4()

        response = await client.post(
            POSTS_URL,
            json=_draft_payload(category_ids=[str(unknown)]),
            headers=auth_headers_for(author_user),
        )

        problem = _assert_problem_document(
            response,
            status=404,
            error_type=ERROR_TYPE_NOT_FOUND,
            title=ERROR_TITLE_NOT_FOUND,
        )
        assert str(unknown) in problem["detail"]

    @pytest.mark.parametrize(
        ("overrides", "field", "error_type"),
        [
            pytest.param({"title": ...}, "title", "missing", id="title-omitted"),
            pytest.param({"title": "   "}, "title", "string_too_short", id="title-blank"),
            pytest.param(
                {"title": _filled(TITLE_MAX_LENGTH + 1)},
                "title",
                "string_too_long",
                id="title-one-over-the-ceiling",
            ),
            pytest.param(
                {"excerpt": _filled(EXCERPT_MAX_LENGTH + 1)},
                "excerpt",
                "string_too_long",
                id="excerpt-one-over-the-ceiling",
            ),
            pytest.param({"content": ...}, "content", "missing", id="content-omitted"),
            pytest.param({"content": "   "}, "content", None, id="content-whitespace-only"),
            pytest.param(
                {"content": _filled(CONTENT_MAX_LENGTH + 1)},
                "content",
                "string_too_long",
                id="content-one-over-the-ceiling",
            ),
            pytest.param(
                {"category_ids": [str(uuid.uuid4())] * (MAX_CATEGORIES_PER_POST + 1)},
                "category_ids",
                "too_long",
                id="category-ids-beyond-bound",
            ),
            pytest.param(
                {"cover_image_url": "definitely not a url"},
                "cover_image_url",
                None,
                id="cover-image-url-unparseable",
            ),
        ],
    )
    async def test_create_rejects_invalid_input_with_a_populated_error_list(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
        overrides: dict[str, Any],
        field: str,
        error_type: str | None,
    ) -> None:
        """Invalid input is 422 with per-field detail a form can attach to its own control."""
        response = await client.post(
            POSTS_URL,
            json=_draft_payload(**overrides),
            headers=auth_headers_for(author_user),
        )

        _assert_validation_problem(response, field=field, error_type=error_type)

    async def test_create_sanitises_the_submitted_content(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """Author-authored markup is sanitised on write, so a stored payload cannot execute.

        Asserted on the returned body rather than on the sanitiser, because the response is what a
        reader is eventually served. The safe marker is asserted too: a sanitiser that discarded
        the whole submission would otherwise satisfy every negative assertion here.
        """
        hostile = (
            "## Heading\n\n<script>alert('xss')</script>\n\n"
            '<img src="cover.png" onerror="alert(1)">\n\n'
            "[trap](javascript:alert(1))\n\n"
            '<iframe src="https://evil.example"></iframe>\n\nSURVIVING-MARKER paragraph.'
        )

        created = await _create_draft(client, auth_headers_for(author_user), content=hostile)

        stored = created["content"]
        assert "SURVIVING-MARKER" in stored, stored
        for dangerous in ("<script", "</script", "onerror", "javascript:", "<iframe"):
            assert dangerous not in stored, f"{dangerous!r} survived sanitisation: {stored!r}"

    @pytest.mark.parametrize(
        ("submitted", "expected"),
        [pytest.param(case.submitted, case.expected, id=case.label) for case in SANITISATION_CASES],
    )
    async def test_create_applies_the_markdown_destination_policy(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
        submitted: str,
        expected: str,
    ) -> None:
        """Markdown link destinations are policed on write, form by form, and prose is preserved.

        An HTML sanitiser alone cannot do this: ``[label](javascript:...)`` carries no tag for it to
        strip, and the danger only materialises when a renderer turns it into an anchor. So the
        write-side policy walks the Markdown forms itself - inline links, angle-bracketed
        destinations, autolinks and reference definitions - and each is a distinct path worth
        asserting rather than one blanket "no ``javascript:`` anywhere" check.

        Two properties recur across the cases and are the reason the expected values are spelled out
        in full. Prose survives: a defused link keeps its label, and a defused reference
        definition keeps the paragraphs that pointed at it, so an author never finds a sentence
        gutted. And code is inviolate: a destination inside a fence or a code span is documentation
        rather than a link, and rewriting it would corrupt the example the author meant to show.
        """
        created = await _create_draft(client, auth_headers_for(author_user), content=submitted)

        assert created["content"] == expected

    async def test_create_sanitises_the_title_before_deriving_the_slug(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """The slug is built from the cleaned title, so markup cannot reach a canonical URL."""
        created = await _create_draft(
            client,
            auth_headers_for(author_user),
            title="<b>Sanitised</b> Heading",
        )

        assert created["title"] == "Sanitised Heading"
        assert created["slug"].startswith("sanitised-heading")
        assert SLUG_PATTERN.match(created["slug"]), created["slug"]

    @pytest.mark.parametrize(
        ("label", "submitted", "expected"),
        [
            ("plain-markup", "XSS <script>alert(1)</script> probe", "XSS alert(1) probe"),
            ("entity-encoded", "&lt;script&gt;alert(1)&lt;/script&gt; probe", "alert(1) probe"),
            (
                "doubly-encoded",
                "&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt; probe",
                "alert(1) probe",
            ),
            (
                "triply-encoded",
                "&amp;amp;lt;b&amp;amp;gt;bold&amp;amp;lt;/b&amp;amp;gt;",
                "bold",
            ),
            (
                "quadruply-encoded",
                "&amp;amp;amp;lt;i&amp;amp;amp;gt;italic",
                "italic",
            ),
        ],
        ids=lambda value: value if isinstance(value, str) and " " not in value else "",
    )
    async def test_a_nested_entity_encoded_title_is_reduced_to_plain_text(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
        label: str,
        submitted: str,
        expected: str,
    ) -> None:
        """A title is stored only once it is a proven fixed point, at every nesting depth.

        The stored value is what a card heading, an ``h1``, a ``meta`` title, a social card and a
        slug are all built from, so a title is the one authored member that must contain no markup
        and no character reference that decodes into any. Each pass of the sanitiser strips
        elements and then decodes what the strip escaped, which means a *fixed number* of passes
        can hand back raw markup at one nesting level deeper than the bound: the final operation
        in a pass is a decode, so it reintroduces the ``<`` the next pass would have removed.

        Nesting each case one level deeper is what pins that. The assertion is not merely that the
        marker is gone - it is that no angle bracket and no ampersand-escape survives at all, and
        that the value is a fixed point in the strict sense that submitting it again would change
        nothing.
        """
        created = await _create_draft(client, auth_headers_for(author_user), title=submitted)

        stored = created["title"]
        assert stored == expected, f"{label}: {stored!r}"
        for residue in ("<", ">", "&lt;", "&gt;", "&amp;"):
            assert residue not in stored, f"{label}: {residue!r} survived in {stored!r}"

        # The fixed-point property, asserted end to end: re-submitting the stored title has to
        # produce the identical value, or the sanitiser is not converging and the first storage
        # was a snapshot of a moving value rather than a settled one.
        again = await _create_draft(client, auth_headers_for(author_user), title=stored)
        assert again["title"] == stored

    async def test_a_title_of_nothing_but_markup_is_refused(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """Nothing survives, so there is nothing to store and the answer is a 422 naming the field.

        Refusing beats substituting. ``posts.title`` is ``NOT NULL`` and the schema requires a
        character, so the alternatives are a title the author did not write or a 500 from the
        column - and a client can act on neither.
        """
        response = await client.post(
            POSTS_URL,
            json={
                "title": "<img src=x onerror=alert(1)>",
                "content": "Body enough to satisfy the schema.",
            },
            headers=auth_headers_for(author_user),
        )

        problem = _assert_validation_problem(response, field="title")
        assert problem["errors"][0]["field"] == "title"


# =======================================================================================
# The slug, as an addressing contract
#
# Derivation and collision suffixing are `tests/unit/test_slug.py`'s subject and are not
# re-tested here. What is tested here is what only an HTTP round trip can show: that two posts
# sharing a title still get distinct addresses, that the address resolves case-insensitively
# because the column is `citext`, and that it does not move when the title changes.
# =======================================================================================


# =======================================================================================
# Field boundaries - the exact ceiling, one code point past it, and the URL allow-list
# =======================================================================================


class TestTextAndUrlBoundaries:
    """Every numeric limit on a post's text, and every scheme its cover image may not name.

    A bound is established by a **pair** of cases: the largest value that must be accepted and the
    smallest that must be refused. Only one of the two is usually written, and it is the wrong one -
    an obviously-oversized value proves the field is bounded *somewhere*, while the number a client
    actually needs is the accepted maximum, because that is what goes in its own ``maxlength`` and
    its own character counter. A client built against a guess refuses text this API would take, or
    submits text it will not.

    Acceptance is asserted against the **echoed** value, not merely against the status. All three
    text members pass through ``app.services.post_service``'s sanitisation before storage, and a
    ceiling enforced by truncation somewhere in that path would answer 201 exactly as a correctly
    accepted value does. Comparing what came back, code point for code point, is what separates the
    two.

    The astral cases are not decoration - see :data:`ASTRAL` for why one emoji distinguishes three
    different ways of counting a length, only one of which is this contract's.
    """

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            pytest.param("title", _filled(TITLE_MAX_LENGTH), id="title-at-the-ceiling"),
            pytest.param(
                "title",
                _filled(TITLE_MAX_LENGTH, character=ASTRAL),
                id="title-at-the-ceiling-in-astral-code-points",
            ),
            pytest.param("excerpt", _filled(EXCERPT_MAX_LENGTH), id="excerpt-at-the-ceiling"),
            pytest.param(
                "excerpt",
                _filled(EXCERPT_MAX_LENGTH, character=ASTRAL),
                id="excerpt-at-the-ceiling-in-astral-code-points",
            ),
            pytest.param("content", _filled(CONTENT_MAX_LENGTH), id="content-at-the-ceiling"),
        ],
    )
    async def test_a_text_member_exactly_at_its_ceiling_is_stored_verbatim(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
        field: str,
        value: str,
    ) -> None:
        """A member filled to its exact published maximum is accepted and echoed unchanged."""
        response = await client.post(
            POSTS_URL,
            json=_draft_payload(**{field: value}),
            headers=auth_headers_for(author_user),
        )

        assert response.status_code == 201, response.text[:400]
        body = _assert_detail_shape(response.json())
        assert body[field] == value, f"{field} was altered on the way in"
        # Stated separately from the equality above so a truncation reports the length it produced
        # rather than dumping a hundred thousand characters into the failure message.
        assert len(body[field]) == len(value), (field, len(body[field]), len(value))

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            pytest.param("title", _filled(TITLE_MAX_LENGTH + 1), id="title-one-over"),
            pytest.param(
                "title",
                _filled(TITLE_MAX_LENGTH + 1, character=ASTRAL),
                id="title-one-over-in-astral-code-points",
            ),
            pytest.param("excerpt", _filled(EXCERPT_MAX_LENGTH + 1), id="excerpt-one-over"),
            pytest.param(
                "excerpt",
                _filled(EXCERPT_MAX_LENGTH + 1, character=ASTRAL),
                id="excerpt-one-over-in-astral-code-points",
            ),
            pytest.param("content", _filled(CONTENT_MAX_LENGTH + 1), id="content-one-over"),
        ],
    )
    async def test_a_text_member_one_code_point_over_its_ceiling_writes_nothing(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        auth_headers_for: Any,
        field: str,
        value: str,
    ) -> None:
        """One code point past a ceiling is a 422 naming the member, and creates no row.

        The row count is the second half. A refusal that had already inserted would leave the author
        a post they never successfully created, and - because the slug is derived at creation - it
        would also consume the slug their next attempt wants.
        """
        before = await _count_rows(db_session, Post, Post.author_id == author_user.id)

        response = await client.post(
            POSTS_URL,
            json=_draft_payload(**{field: value}),
            headers=auth_headers_for(author_user),
        )

        _assert_validation_problem(response, field=field, error_type="string_too_long")
        after = await _count_rows(db_session, Post, Post.author_id == author_user.id)
        assert after == before, "a rejected creation still wrote a row"

    @pytest.mark.parametrize(
        ("url", "error_type"),
        [pytest.param(url, kind, id=name) for url, kind, name in HOSTILE_COVER_URLS],
    )
    async def test_a_cover_image_url_outside_the_allow_list_is_refused(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        auth_headers_for: Any,
        url: str,
        error_type: str,
    ) -> None:
        """Only absolute ``http`` and ``https`` URLs may be stored as a cover image.

        The single highest-value validation on this model. ``cover_image_url`` is written by an
        author and read back into an image source on every card, every post page and every social
        card, so a stored ``javascript:`` or ``data:`` destination is a script that runs in every
        reader's browser. ``pydantic.HttpUrl``'s scheme allow-list is what stops it, and the
        machine-readable ``type`` is asserted alongside the status so a client can tell a refused
        *scheme* from an unparseable value and say which to a user.

        The scheme-relative case belongs here for a different reason: ``//host/path`` names no
        scheme at all, so a browser supplies the page's own and loads it regardless - it is not a
        harmless relative path, and refusing it is not pedantry.
        """
        before = await _count_rows(db_session, Post, Post.author_id == author_user.id)

        response = await client.post(
            POSTS_URL,
            json=_draft_payload(cover_image_url=url),
            headers=auth_headers_for(author_user),
        )

        _assert_validation_problem(response, field="cover_image_url", error_type=error_type)
        after = await _count_rows(db_session, Post, Post.author_id == author_user.id)
        assert after == before, "a rejected cover image still wrote a row"

    async def test_the_cover_image_url_ceiling_holds_at_the_exact_character(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """A URL at :data:`COVER_URL_MAX_LENGTH` is accepted; one character more is refused.

        The bound is the URL type's own rather than one this schema declares, which is precisely
        why it is worth pinning here: nothing in this project's source states it, so a change to it
        would arrive with a dependency upgrade rather than with a code change. The accepted value is
        compared as sent, because the type also *normalises* what it validates - a value that came
        back re-encoded would break the canonical image source the pages build from it.
        """
        at_ceiling = _cover_url_of_length(COVER_URL_MAX_LENGTH)
        over_ceiling = _cover_url_of_length(COVER_URL_MAX_LENGTH + 1)

        accepted = await client.post(
            POSTS_URL,
            json=_draft_payload(cover_image_url=at_ceiling),
            headers=auth_headers_for(author_user),
        )
        refused = await client.post(
            POSTS_URL,
            json=_draft_payload(cover_image_url=over_ceiling),
            headers=auth_headers_for(author_user),
        )

        assert accepted.status_code == 201, accepted.text[:400]
        assert accepted.json()["cover_image_url"] == at_ceiling
        _assert_validation_problem(refused, field="cover_image_url", error_type="url_too_long")

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            pytest.param("title", _filled(TITLE_MAX_LENGTH), id="title-at-the-ceiling"),
            pytest.param("excerpt", _filled(EXCERPT_MAX_LENGTH), id="excerpt-at-the-ceiling"),
        ],
    )
    async def test_the_same_ceilings_apply_to_a_partial_update(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
        field: str,
        value: str,
    ) -> None:
        """``PostUpdate`` bounds each member exactly as ``PostCreate`` does, in both directions.

        Asserted separately because the two models are separate declarations: ``PostUpdate`` makes
        every member optional so a client may send one field, and an optional member is exactly
        where a restated bound goes missing. A ceiling present on creation and absent on edit would
        let an author write a value they could not have created.
        """
        headers = auth_headers_for(author_user)
        created = await _create_draft(client, headers)

        accepted = await client.patch(
            _post_path(created["id"]), json={field: value}, headers=headers
        )
        refused = await client.patch(
            _post_path(created["id"]),
            json={field: value + _filled(1)},
            headers=headers,
        )

        assert accepted.status_code == 200, accepted.text[:400]
        assert accepted.json()[field] == value
        _assert_validation_problem(refused, field=field, error_type="string_too_long")


class TestPostSlug:
    """``posts.slug``: unique, case-insensitive, and permanent once written."""

    async def test_two_posts_with_the_same_title_receive_distinct_slugs(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """A repeated title still yields a unique address, so neither post shadows the other."""
        headers = auth_headers_for(author_user)
        shared_title = "One Title Two Posts"

        first = await _create_draft(client, headers, title=shared_title)
        second = await _create_draft(client, headers, title=shared_title)

        assert first["title"] == second["title"]
        assert first["slug"] != second["slug"]
        assert SLUG_PATTERN.match(second["slug"]), second["slug"]
        # Both addresses resolve, and each to its own post - which is the property a shared stem
        # would have destroyed.
        assert (await _read_detail(client, first["slug"], headers=headers))["id"] == first["id"]
        assert (await _read_detail(client, second["slug"], headers=headers))["id"] == second["id"]

    @pytest.mark.parametrize("transform", [str.upper, str.lower, str.title])
    async def test_the_slug_resolves_case_insensitively(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        transform: Any,
    ) -> None:
        """``posts.slug`` is ``CITEXT UNIQUE``, so ``/Scaling-FastAPI`` and ``/scaling-fastapi``
        resolve to one post.

        Asserted against a published post so the read is the anonymous one a crawler or an inbound
        link performs, which is the case the property exists to serve.
        """
        post = await factories.create_published_post(
            db_session,
            author=author_user,
            title="Case Insensitive Addressing",
        )

        body = await _read_detail(client, transform(post.slug))

        assert body["id"] == str(post.id)
        # The stored casing is what comes back, whatever casing was requested, so a canonical URL
        # built from the response is stable regardless of how the reader arrived.
        assert body["slug"] == post.slug

    async def test_retitling_a_published_post_does_not_move_its_slug(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """The canonical URL is written once and never re-derived - every published link depends
        on it.

        This is the SEO half of AAP §0.1.3's "unique, stable slugs" prerequisite: a slug that
        followed the title would break indexed URLs, sitemap entries and inbound links on every
        edit.
        """
        headers = auth_headers_for(author_user)
        post = await factories.create_published_post(
            db_session,
            author=author_user,
            title="Original Headline",
        )
        original_slug = post.slug

        response = await client.patch(
            _post_path(post.id),
            json={"title": "Completely Different Headline"},
            headers=headers,
        )

        assert response.status_code == 200, response.text
        updated = _assert_detail_shape(response.json())
        assert updated["title"] == "Completely Different Headline"
        assert updated["slug"] == original_slug
        # And the original address still resolves, which is the consequence that actually matters.
        assert (await _read_detail(client, original_slug))["id"] == str(post.id)

    async def test_a_lost_slug_race_is_retried_rather_than_reported(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        auth_headers_for: Any,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A concurrent create of the same title receives the next suffix, not a 409.

        The route publishes collision suffixing as a **promise** - ``python``, ``python-2``,
        ``python-3`` - so the loser of the narrow window between reading the taken slug family and
        inserting is a perfectly valid request and must not be refused. It used to be: the service
        read the family, picked a suffix, lost the row to a concurrent writer and reported the
        unique violation as a conflict.

        The race is reproduced deterministically rather than by running two requests at once, and
        the substitution is the minimum that makes it happen: ``slugs_starting_with`` is made to
        answer *once* as though the family were empty, which is exactly what a reader sees when the
        competing row is committed after its snapshot. The real unique index then refuses the
        insert, and the retry - which calls the unpatched method - sees the row that won. So the
        assertion exercises the genuine constraint and the genuine retry, with only the visibility
        of one read altered.
        """
        headers = auth_headers_for(author_user)
        first = await _create_draft(client, headers, title="Slug Race Title")
        assert first["slug"] == "slug-race-title"

        original = PostRepository.slugs_starting_with
        calls = {"count": 0}

        async def stale_family(self: PostRepository, prefix: str) -> set[str]:
            calls["count"] += 1
            if calls["count"] == 1:
                # The snapshot a losing writer had: nothing in the family yet.
                return set()
            return await original(self, prefix)

        monkeypatch.setattr(PostRepository, "slugs_starting_with", stale_family)

        second = await _create_draft(client, headers, title="Slug Race Title")

        assert calls["count"] >= 2, (
            "the first attempt did not lose the race, so nothing was retried"
        )
        assert second["slug"] == "slug-race-title-2"
        assert second["id"] != first["id"]

    async def test_sustained_slug_contention_is_reported_as_a_conflict(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        auth_headers_for: Any,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """When every attempt loses, the answer is the documented 409 rather than a loop.

        The other half of the bound. Retrying is what keeps the suffixing promise, and a bound is
        what keeps the method total: a request that loses on every attempt is contending with a
        volume of identical titles that is no longer an allocation race, and it is told so. Held to
        the same standard as the success path - the family read is made to answer as though empty
        *every* time, which is contention that never resolves.
        """
        headers = auth_headers_for(author_user)
        await _create_draft(client, headers, title="Permanently Contended Title")

        async def always_stale(self: PostRepository, prefix: str) -> set[str]:
            return set()

        monkeypatch.setattr(PostRepository, "slugs_starting_with", always_stale)

        response = await client.post(
            POSTS_URL,
            json={
                "title": "Permanently Contended Title",
                "content": "Body enough to satisfy the schema.",
            },
            headers=headers,
        )

        _assert_problem_document(
            response,
            status=409,
            error_type=ERROR_TYPE_CONFLICT,
            title=ERROR_TITLE_CONFLICT,
        )


# =======================================================================================
# The publish lifecycle - AAP §0.9.4.4 "Publish lifecycle"
#
# Publishing is a first-class transition on a dedicated sub-resource, not a boolean field toggled
# through the general update. That is why `PostCreate` and `PostUpdate` expose no `status` and no
# `published_at`: the lifecycle state and the publication instant are written together, and a
# patchable flag would let one be written without the other - which the database would then
# refuse through `ck_posts_published_at_required`, as a 500 rather than as a refusal.
# =======================================================================================


class TestPublishLifecycle:
    """``/publish`` and ``/unpublish``: the only two ways a post's visibility changes."""

    async def test_a_created_post_is_a_draft_and_absent_from_the_public_feed(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """A new post is invisible until it is published (AAP §0.9.4.4 "Publish lifecycle")."""
        created = await _create_draft(client, auth_headers_for(author_user))

        assert created["status"] == PostStatus.DRAFT.value
        assert created["id"] not in await _collect_feed_ids(client)

    async def test_publish_stamps_the_publication_instant(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """Publishing sets ``PUBLISHED`` and stamps ``published_at`` in the same write.

        The stamp is asserted rather than trusted: ``ck_posts_published_at_required`` is what makes
        a published post with no publication date impossible, and this is the assertion that proves
        the application is writing the pair the constraint requires rather than relying on it to
        catch a miss.
        """
        headers = auth_headers_for(author_user)
        created = await _create_draft(client, headers)

        before = datetime.now(tz=UTC)
        response = await client.post(_post_path(created["id"], action="publish"), headers=headers)
        after = datetime.now(tz=UTC)

        assert response.status_code == 200, response.text
        published = _assert_detail_shape(response.json())
        assert published["id"] == created["id"]
        assert published["status"] == PostStatus.PUBLISHED.value
        assert published["published_at"] is not None
        stamped = _parse_instant(published["published_at"])
        assert before - PUBLISH_INSTANT_TOLERANCE <= stamped
        assert stamped <= after + PUBLISH_INSTANT_TOLERANCE

    async def test_publishing_admits_the_post_to_the_public_feed(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """After publishing, an anonymous caller sees the post - as a summary, without the body."""
        headers = auth_headers_for(author_user)
        created = await _create_draft(client, headers)
        assert created["id"] not in await _collect_feed_ids(client)

        response = await client.post(_post_path(created["id"], action="publish"), headers=headers)
        assert response.status_code == 200, response.text

        page = await client.get(
            POSTS_URL,
            params={"author": author_user.username, "page_size": MAX_PAGE_SIZE},
        )
        assert page.status_code == 200, page.text
        listed = [item for item in page.json()["items"] if item["id"] == created["id"]]
        assert listed, "the published post is missing from the feed"
        _assert_summary_shape(listed[0])
        assert listed[0]["status"] == PostStatus.PUBLISHED.value
        assert created["id"] in await _collect_feed_ids(client)

    async def test_unpublish_returns_the_post_to_draft_and_withdraws_it(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """Unpublishing restores ``DRAFT`` and removes the post from the feed immediately."""
        headers = auth_headers_for(author_user)
        post = await factories.create_published_post(db_session, author=author_user)
        assert str(post.id) in await _collect_feed_ids(client)

        response = await client.post(_post_path(post.id, action="unpublish"), headers=headers)

        assert response.status_code == 200, response.text
        drafted = _assert_detail_shape(response.json())
        assert drafted["status"] == PostStatus.DRAFT.value
        assert str(post.id) not in await _collect_feed_ids(client)

    async def test_unpublish_preserves_the_publication_instant(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """``published_at`` records when the post first went public, so withdrawal keeps it.

        The two members answer different questions - ``status`` says whether the post is public
        now, ``published_at`` says whether it ever was - so clearing the instant on withdrawal
        would erase the answer to the second and make a withdrawn post indistinguishable from one
        that was never published.
        """
        headers = auth_headers_for(author_user)
        created = await _create_draft(client, headers)
        publish = await client.post(_post_path(created["id"], action="publish"), headers=headers)
        assert publish.status_code == 200, publish.text
        first_stamp = publish.json()["published_at"]

        unpublish = await client.post(
            _post_path(created["id"], action="unpublish"),
            headers=headers,
        )

        assert unpublish.status_code == 200, unpublish.text
        assert unpublish.json()["status"] == PostStatus.DRAFT.value
        assert unpublish.json()["published_at"] == first_stamp

    async def test_publishing_an_already_published_post_is_idempotent(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """A second publish answers 200 with the post unchanged; it does **not** re-stamp.

        This is the behaviour ``post_service.publish`` contracts, and re-stamping would be a
        defect rather than a nicety: the default feed ordering is by ``published_at``, so a
        re-stamp would lift a months-old article back to the top of the home page.
        """
        headers = auth_headers_for(author_user)
        created = await _create_draft(client, headers)
        first = await client.post(_post_path(created["id"], action="publish"), headers=headers)
        assert first.status_code == 200, first.text
        first_stamp = first.json()["published_at"]

        second = await client.post(_post_path(created["id"], action="publish"), headers=headers)

        assert second.status_code == 200, second.text
        repeated = _assert_detail_shape(second.json())
        assert repeated["status"] == PostStatus.PUBLISHED.value
        assert repeated["published_at"] == first_stamp

    async def test_unpublishing_a_draft_is_idempotent(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """A post already in ``DRAFT`` is returned unchanged with 200 rather than rejected."""
        headers = auth_headers_for(author_user)
        created = await _create_draft(client, headers)

        response = await client.post(
            _post_path(created["id"], action="unpublish"),
            headers=headers,
        )

        assert response.status_code == 200, response.text
        drafted = _assert_detail_shape(response.json())
        assert drafted["status"] == PostStatus.DRAFT.value
        assert drafted["published_at"] is None

    @pytest.mark.parametrize(
        ("member", "value"),
        [
            pytest.param("status", PostStatus.PUBLISHED.value, id="status"),
            pytest.param("published_at", "2020-01-01T00:00:00Z", id="published-at"),
        ],
    )
    async def test_the_lifecycle_is_not_reachable_through_the_general_update(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
        member: str,
        value: str,
    ) -> None:
        """``PATCH`` cannot publish: neither member exists on ``PostUpdate``, and nothing changes.

        The proof that publishing is a transition rather than a field. Both halves matter - the
        refusal, and the post being genuinely untouched afterwards, since a route that rejected the
        response after writing the row would satisfy the status assertion alone.
        """
        headers = auth_headers_for(author_user)
        created = await _create_draft(client, headers)

        response = await client.patch(
            _post_path(created["id"]),
            json={member: value},
            headers=headers,
        )

        _assert_validation_problem(response, field=member, error_type="extra_forbidden")
        unchanged = await _read_detail(client, created["slug"], headers=headers)
        assert unchanged["status"] == PostStatus.DRAFT.value
        assert unchanged["published_at"] is None
        assert created["id"] not in await _collect_feed_ids(client)


# =======================================================================================
# PATCH /api/v1/posts/{post_id} - the correction of the legacy replacement semantics
#
# The retired route was `PUT /items/{item_id}`, and it assigned the submitted object over the
# stored one - `items[index] = updated_item` at `app.py:L38`. Every member the caller omitted was
# therefore silently discarded, so a client holding a stale copy reverted every field it had not
# refreshed. `PATCH` must not behave that way, and the first test below is the most direct proof
# that the new surface is not a re-implementation of the old one.
# =======================================================================================


class TestPartialUpdate:
    """``PATCH``: only the members present in the body change, and nothing else does."""

    async def test_patching_one_member_leaves_every_other_member_untouched(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """A genuine partial update, unlike the whole-object replacement at ``app.py:L38``.

        The post is created carrying every member a caller can set - title, excerpt, body, cover
        image and a category filing - and then only the title is submitted. A replacement would
        have cleared the other four; a partial update leaves them exactly as they were.
        """
        headers = auth_headers_for(author_user)
        category = await factories.create_category(db_session)
        created = await _create_draft(client, headers, category_ids=[str(category.id)])

        response = await client.patch(
            _post_path(created["id"]),
            json={"title": "Retitled, And Only Retitled"},
            headers=headers,
        )

        assert response.status_code == 200, response.text
        updated = _assert_detail_shape(response.json())
        assert updated["title"] == "Retitled, And Only Retitled"
        assert updated["excerpt"] == created["excerpt"]
        assert updated["content"] == created["content"]
        assert updated["cover_image_url"] == created["cover_image_url"]
        assert updated["categories"] == created["categories"]
        # Neither identity nor lifecycle moves either, and the address stays put.
        assert updated["id"] == created["id"]
        assert updated["slug"] == created["slug"]
        assert updated["status"] == created["status"]
        assert updated["view_count"] == created["view_count"]

    async def test_patching_the_body_replaces_it_in_full_and_sanitises_it(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """``content`` has no partial form: it is replaced whole, and cleaned on the way in.

        The same write-side policy creation applies, applied again on edit - which is the point of
        holding an update to the rule creation is held to. A cleaner that ran only on the create
        path would leave editing as the way around it.
        """
        headers = auth_headers_for(author_user)
        created = await _create_draft(client, headers)

        response = await client.patch(
            _post_path(created["id"]),
            json={"content": "Rewritten body. <script>alert('xss')</script> KEPT-MARKER."},
            headers=headers,
        )

        assert response.status_code == 200, response.text
        updated = _assert_detail_shape(response.json())
        assert "KEPT-MARKER" in updated["content"]
        assert "<script" not in updated["content"], updated["content"]
        assert updated["content"] != created["content"]
        # Replaced, not appended to: nothing of the previous body survives.
        assert DRAFT_CONTENT not in updated["content"]
        assert updated["title"] == created["title"]
        assert updated["excerpt"] == created["excerpt"]

    async def test_patching_every_member_replaces_every_member(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """A body naming every member is still a partial update - it simply omits nothing."""
        headers = auth_headers_for(author_user)
        original_category = await factories.create_category(db_session)
        replacement_category = await factories.create_category(db_session)
        created = await _create_draft(client, headers, category_ids=[str(original_category.id)])
        submitted = {
            "title": "Everything Replaced",
            "excerpt": "A new summary.",
            "content": "A new body, entirely.",
            "cover_image_url": "https://cdn.example.com/covers/replacement.png",
            "category_ids": [str(replacement_category.id)],
        }

        response = await client.patch(_post_path(created["id"]), json=submitted, headers=headers)

        assert response.status_code == 200, response.text
        updated = _assert_detail_shape(response.json())
        assert updated["title"] == submitted["title"]
        assert updated["excerpt"] == submitted["excerpt"]
        assert updated["content"] == submitted["content"]
        assert updated["cover_image_url"] == submitted["cover_image_url"]
        assert {badge["id"] for badge in updated["categories"]} == {str(replacement_category.id)}
        # The three server-owned members a caller cannot name are still the ones the server chose.
        assert updated["id"] == created["id"]
        assert updated["slug"] == created["slug"]
        assert updated["status"] == created["status"]

    async def test_patching_with_an_empty_body_changes_nothing(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """``{}`` sets no member, so it succeeds and leaves the post exactly as it was.

        This is what ``PostUpdate`` contracts: every member is optional, so an empty object is
        valid input describing no change. It answers 200 rather than 422 because "change nothing"
        is a coherent request, and it is worth pinning because the alternative - a whole-object
        model - would have blanked the post.
        """
        headers = auth_headers_for(author_user)
        created = await _create_draft(client, headers)

        response = await client.patch(_post_path(created["id"]), json={}, headers=headers)

        assert response.status_code == 200, response.text
        unchanged = _assert_detail_shape(response.json())
        assert unchanged == created

    async def test_patching_category_ids_replaces_the_filing_rather_than_adding_to_it(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """``category_ids`` is the complete category set after the update, not an addition to it."""
        headers = auth_headers_for(author_user)
        original = await factories.create_category(db_session)
        replacement = await factories.create_category(db_session)
        created = await _create_draft(client, headers, category_ids=[str(original.id)])
        assert {badge["id"] for badge in created["categories"]} == {str(original.id)}

        response = await client.patch(
            _post_path(created["id"]),
            json={"category_ids": [str(replacement.id)]},
            headers=headers,
        )

        assert response.status_code == 200, response.text
        updated = _assert_detail_shape(response.json())
        assert {badge["id"] for badge in updated["categories"]} == {str(replacement.id)}
        assert str(original.id) not in {badge["id"] for badge in updated["categories"]}

    async def test_patching_an_empty_category_list_unfiles_the_post(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """An empty list is a replacement with nothing, so the post ends up uncategorised."""
        headers = auth_headers_for(author_user)
        category = await factories.create_category(db_session)
        created = await _create_draft(client, headers, category_ids=[str(category.id)])

        response = await client.patch(
            _post_path(created["id"]),
            json={"category_ids": []},
            headers=headers,
        )

        assert response.status_code == 200, response.text
        assert response.json()["categories"] == []
        # Only the filing was removed. The taxonomy row itself is not a post's to delete.
        assert await _count_rows(db_session, Category, Category.id == category.id) == 1

    @pytest.mark.parametrize("member", ["excerpt", "cover_image_url"])
    async def test_an_explicit_null_clears_a_nullable_member(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
        member: str,
    ) -> None:
        """For the two nullable members, *omitted* and *null* are different instructions.

        Omitting leaves the value alone - that is the previous test. Sending an explicit ``null``
        clears it, which is the only way a client can remove an excerpt or a cover image at all.
        """
        headers = auth_headers_for(author_user)
        created = await _create_draft(client, headers)
        assert created[member] is not None

        response = await client.patch(
            _post_path(created["id"]),
            json={member: None},
            headers=headers,
        )

        assert response.status_code == 200, response.text
        cleared = _assert_detail_shape(response.json())
        assert cleared[member] is None
        # The sibling nullable member was not named, so it is untouched.
        sibling = "cover_image_url" if member == "excerpt" else "excerpt"
        assert cleared[sibling] == created[sibling]

    async def test_patching_an_unknown_post_is_a_not_found_problem_document(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """An identifier that names no post is 404, with the uniform problem document."""
        response = await client.patch(
            _post_path(uuid.uuid4()),
            json={"title": "Nothing To Retitle"},
            headers=auth_headers_for(author_user),
        )

        _assert_problem_document(
            response,
            status=404,
            error_type=ERROR_TYPE_NOT_FOUND,
            title=ERROR_TITLE_NOT_FOUND,
        )

    async def test_patching_a_malformed_identifier_is_a_validation_problem_not_a_server_error(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """A path segment that is not a UUID is refused at the boundary as 422, never as a 500."""
        response = await client.patch(
            _post_path("not-a-uuid"),
            json={"title": "Unreachable"},
            headers=auth_headers_for(author_user),
        )

        _assert_validation_problem(response, field="post_id", error_type="uuid_parsing")


# =======================================================================================
# The mutation set
#
# Every request that changes a post, enumerated once. Authorisation is not a property of any one
# route - it is a property of the whole mutating surface - so the negatives below are parametrised
# over this tuple rather than written out four times. A fifth mutation added to the router and
# added here is then covered by every negative at once, which is the only way a coverage gap in an
# authorisation suite stays impossible rather than merely unlikely.
# =======================================================================================


class _Mutation(NamedTuple):
    """One post-mutating request, described declaratively so it can be parametrised.

    Attributes:
        label: Human-readable name, used as the parametrised case identifier.
        method: The HTTP method to send.
        success_status: What the route answers when the caller is entitled to make the request.
        action: The lifecycle sub-resource, or ``None`` to address the post itself.
        body: The JSON body, or ``None`` to send none. ``PATCH`` is the only mutation with one.
    """

    label: str
    method: str
    success_status: int
    action: str | None = None
    body: dict[str, Any] | None = None


MUTATIONS: Final[tuple[_Mutation, ...]] = (
    _Mutation("patch", "PATCH", 200, body={"title": "Rewritten By Somebody Else"}),
    _Mutation("delete", "DELETE", 204),
    _Mutation("publish", "POST", 200, action="publish"),
    _Mutation("unpublish", "POST", 200, action="unpublish"),
)
"""Every mutation ``/api/v1/posts/{post_id}`` exposes, with the status each answers on success."""

MUTATION_IDS: Final[list[str]] = [mutation.label for mutation in MUTATIONS]
"""Case identifiers for the parametrised authorisation tests, so a failure names the route."""


async def _send_mutation(
    client: AsyncClient,
    post_id: str | uuid.UUID,
    mutation: _Mutation,
    *,
    headers: dict[str, str] | None = None,
) -> Response:
    """Send one described mutation against ``post_id``.

    Args:
        client: The in-process client.
        post_id: The post to address. Mutations are addressed by identifier, never by slug.
        mutation: The mutation to send.
        headers: An ``Authorization`` header, or ``None`` to send the request anonymously.

    Returns:
        The raw response, so the caller can assert on the status, the headers and the body.
    """
    return await client.request(
        mutation.method,
        _post_path(post_id, action=mutation.action),
        json=mutation.body,
        headers=headers,
    )


# =======================================================================================
# Authorisation negatives - AAP §0.9.4.4
#
# Authority over a post has two independent halves, and both are enforced server-side.
#
# The ROLE half is the route's dependency: every mutation depends on `AuthorUser`
# (`require_author`), so an anonymous caller is 401 and an authenticated READER is 403. The
# OWNERSHIP half is `ensure_can_modify` inside `app.services.post_service`, so an AUTHOR who does
# not own the post is 403 while an ADMIN is admitted. Neither half implies the other, which is why
# both appear below.
#
# Every refusal is asserted twice over: once on the response, and once on the world. A status code
# alone does not prove that nothing happened - a route that wrote the row and then rejected the
# response would satisfy it - so each negative snapshots the post before the attempt and asserts
# the post is byte-identical afterwards. That is AAP §0.10.1 standard #6 read strictly: hiding a
# control is not a boundary, and neither is a status code without an effect behind it.
# =======================================================================================


class TestAuthorisationNegatives:
    """Who may mutate a post, and the proof that everyone else genuinely cannot."""

    async def test_anonymous_create_is_unauthorised_and_challenges_for_a_bearer_token(
        self,
        client: AsyncClient,
    ) -> None:
        """``POST /api/v1/posts`` without a credential is 401 with a ``WWW-Authenticate`` header.

        The challenge header is part of the contract, not decoration: without it browser code
        cannot distinguish "sign in" from "you may not do this", and would show the wrong remedy.
        """
        response = await client.post(POSTS_URL, json=_draft_payload())

        _assert_problem_document(
            response,
            status=401,
            error_type=ERROR_TYPE_UNAUTHORIZED,
            title=ERROR_TITLE_UNAUTHORIZED,
        )
        assert response.headers.get(WWW_AUTHENTICATE_HEADER) == BEARER_CHALLENGE

    @pytest.mark.parametrize("mutation", MUTATIONS, ids=MUTATION_IDS)
    async def test_anonymous_mutation_is_unauthorised_and_changes_nothing(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        auth_headers_for: Any,
        mutation: _Mutation,
    ) -> None:
        """Every post mutation refuses an anonymous caller with 401, and the post survives whole."""
        owner = auth_headers_for(author_user)
        post = await factories.create_post(db_session, author=author_user)
        before = await _read_detail(client, post.slug, headers=owner)

        response = await _send_mutation(client, post.id, mutation)

        _assert_problem_document(
            response,
            status=401,
            error_type=ERROR_TYPE_UNAUTHORIZED,
            title=ERROR_TITLE_UNAUTHORIZED,
        )
        assert response.headers.get(WWW_AUTHENTICATE_HEADER) == BEARER_CHALLENGE
        assert await _read_detail(client, post.slug, headers=owner) == before

    @pytest.mark.parametrize("mutation", MUTATIONS, ids=MUTATION_IDS)
    async def test_a_reader_may_not_mutate_any_post(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: Any,
        mutation: _Mutation,
    ) -> None:
        """A token is not enough: authoring needs the ``AUTHOR`` or ``ADMIN`` role, so a ``READER``
        is 403.

        The role half of post authority, and the half authentication alone cannot express. An
        account an administrator has demoted to ``READER`` is refused here, and writing does not
        promote it back.
        """
        owner = auth_headers_for(author_user)
        post = await factories.create_post(db_session, author=author_user)
        before = await _read_detail(client, post.slug, headers=owner)

        response = await _send_mutation(
            client,
            post.id,
            mutation,
            headers=auth_headers_for(reader_user),
        )

        _assert_problem_document(
            response,
            status=403,
            error_type=ERROR_TYPE_FORBIDDEN,
            title=ERROR_TITLE_FORBIDDEN,
        )
        assert await _read_detail(client, post.slug, headers=owner) == before

    @pytest.mark.parametrize("mutation", MUTATIONS, ids=MUTATION_IDS)
    async def test_a_non_owning_author_may_not_mutate_someone_elses_post(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        other_author_user: User,
        auth_headers_for: Any,
        mutation: _Mutation,
    ) -> None:
        """The ownership half: an author may act only on their own post, so a second author is 403.

        AAP §0.9.4.4's "a non-owner, non-admin ``PATCH`` on someone else's post yields 403",
        extended over the whole mutation set because the rule lives in the service rather than in
        any one route and therefore has to hold for all four.
        """
        owner = auth_headers_for(author_user)
        post = await factories.create_post(db_session, author=author_user)
        before = await _read_detail(client, post.slug, headers=owner)

        response = await _send_mutation(
            client,
            post.id,
            mutation,
            headers=auth_headers_for(other_author_user),
        )

        _assert_problem_document(
            response,
            status=403,
            error_type=ERROR_TYPE_FORBIDDEN,
            title=ERROR_TITLE_FORBIDDEN,
        )
        assert await _read_detail(client, post.slug, headers=owner) == before

    @pytest.mark.parametrize("mutation", MUTATIONS, ids=MUTATION_IDS)
    async def test_an_administrator_may_mutate_a_post_they_do_not_own(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        admin_user: User,
        auth_headers_for: Any,
        mutation: _Mutation,
    ) -> None:
        """The positive half of every ownership negative: an administrator crosses the boundary.

        Asserted on the same mutation set as the refusals, so "an administrator may act on any
        post" is established for each route rather than inferred from one of them.
        """
        post = await factories.create_post(db_session, author=author_user)

        response = await _send_mutation(
            client,
            post.id,
            mutation,
            headers=auth_headers_for(admin_user),
        )

        assert response.status_code == mutation.success_status, response.text
        if mutation.success_status == 204:
            assert response.text == ""
        else:
            body = _assert_detail_shape(response.json())
            assert body["id"] == str(post.id)
            # The byline still names the author, never the administrator who acted.
            _assert_public_author(body["author"], author_user)


# =======================================================================================
# Draft confidentiality - AAP §0.9.4.4
#
# `DRAFT` and `ARCHIVED` are both non-public: a draft has never been public and an archived post
# has been withdrawn without being deleted, so neither is any more visible than the other. The rule
# is declared exactly once, in `post_service.visible_statuses_for` and `post_service.can_view_post`
# - which `comment_service` and `like_service` both import - so a leak here would be one bug in one
# predicate rather than three. That single declaration is why the tests below sweep every public
# surface: the feed, a category-filtered feed, an author's public profile and the single read.
#
# Each negative is paired with a positive control. A category filter that answered nothing at all
# would satisfy "the draft is absent" while being completely broken, so every absence assertion
# below is accompanied by a published post that must be PRESENT on the same surface.
# =======================================================================================

NON_PUBLIC_STATUSES: Final[tuple[PostStatus, ...]] = (PostStatus.DRAFT, PostStatus.ARCHIVED)
"""The two lifecycle states no public surface may disclose."""

NON_PUBLIC_STATUS_IDS: Final[list[str]] = [status.value.lower() for status in NON_PUBLIC_STATUSES]
"""Case identifiers for the confidentiality sweep, so a failure names the state that leaked."""

SCOPE_WIDENING_ATTEMPTS: Final[tuple[dict[str, str], ...]] = (
    {"statuses": PostStatus.DRAFT.value},
    {"include_drafts": "true"},
    {"visibility": "all"},
    {"mine": "false", "statuses": PostStatus.ARCHIVED.value},
)
"""Query strings a client might try in order to widen the public feed's lifecycle scope.

Every one is either undeclared - and therefore ignored by the framework - or declared and
answered with the public scope anyway. ``status`` is deliberately **not** in this tuple: it is a
declared parameter of the workspace mode and the public feed refuses it outright with ``422``, so
its behaviour is pinned by
:meth:`TestAuthorWorkspace.test_status_is_refused_on_the_public_feed` rather than swept here.
"""


class TestDraftConfidentiality:
    """An unpublished post is invisible on every public surface, and to every unentitled caller."""

    @pytest.mark.parametrize("status", NON_PUBLIC_STATUSES, ids=NON_PUBLIC_STATUS_IDS)
    async def test_a_non_public_post_is_absent_from_the_anonymous_feed(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        status: PostStatus,
    ) -> None:
        """Neither a draft nor an archived post reaches the home feed (AAP §0.9.4.4)."""
        hidden = await factories.create_post(db_session, author=author_user, status=status)
        visible = await factories.create_published_post(db_session, author=author_user)

        listed = await _collect_feed_ids(client)

        assert str(hidden.id) not in listed
        # The positive control: the feed is answering, so the absence above means something.
        assert str(visible.id) in listed

    @pytest.mark.parametrize("status", NON_PUBLIC_STATUSES, ids=NON_PUBLIC_STATUS_IDS)
    async def test_a_non_public_post_is_absent_from_a_category_filtered_feed(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        status: PostStatus,
    ) -> None:
        """A category filter narrows the feed; it does not widen its lifecycle scope."""
        category = await factories.create_category(db_session)
        hidden = await factories.create_post(
            db_session,
            author=author_user,
            status=status,
            categories=[category],
        )
        visible = await factories.create_published_post(
            db_session,
            author=author_user,
            categories=[category],
        )

        listed = await _collect_feed_ids(client, category=category.slug)

        assert str(hidden.id) not in listed
        assert str(visible.id) in listed

    @pytest.mark.parametrize("status", NON_PUBLIC_STATUSES, ids=NON_PUBLIC_STATUS_IDS)
    async def test_a_non_public_post_is_absent_from_the_public_profile_listing(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        auth_headers_for: Any,
        status: PostStatus,
    ) -> None:
        """A profile lists published posts only, and the author's own credential cannot widen it.

        The profile listing hard-filters to ``PUBLISHED`` with no caller-supplied override, so it
        answers identically to an anonymous visitor and to the author themselves. Asserting both is
        what distinguishes a hard filter from a viewer-dependent one.
        """
        hidden = await factories.create_post(db_session, author=author_user, status=status)
        visible = await factories.create_published_post(db_session, author=author_user)

        anonymous = await _collect_profile_post_ids(client, author_user.username)
        as_author = await _collect_profile_post_ids(
            client,
            author_user.username,
            headers=auth_headers_for(author_user),
        )

        assert str(hidden.id) not in anonymous
        assert str(hidden.id) not in as_author
        assert str(visible.id) in anonymous
        assert anonymous == as_author

    @pytest.mark.parametrize("status", NON_PUBLIC_STATUSES, ids=NON_PUBLIC_STATUS_IDS)
    async def test_a_non_public_post_is_absent_from_another_authors_feed_view(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        other_author_user: User,
        auth_headers_for: Any,
        status: PostStatus,
    ) -> None:
        """Holding a token widens nothing: a second author sees the same feed a visitor sees."""
        hidden = await factories.create_post(db_session, author=author_user, status=status)
        visible = await factories.create_published_post(db_session, author=author_user)
        headers = auth_headers_for(other_author_user)

        listed = await _collect_feed_ids(client, headers=headers)
        filtered = await _collect_feed_ids(client, headers=headers, author=author_user.username)

        assert str(hidden.id) not in listed
        assert str(hidden.id) not in filtered
        assert str(visible.id) in filtered

    @pytest.mark.parametrize(
        "attempt",
        SCOPE_WIDENING_ATTEMPTS,
        ids=[
            "-".join(f"{name}={value}" for name, value in case.items())
            for case in SCOPE_WIDENING_ATTEMPTS
        ],
    )
    async def test_a_query_parameter_cannot_widen_the_feeds_lifecycle_scope(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        attempt: dict[str, str],
    ) -> None:
        """The scope is decided in the service from the credential, never from the query string.

        The public feed's scope is a constant, so no query string can widen it. An unrecognised
        parameter is ignored rather than honoured, and the assertion is that it is ignored *and*
        that the request still succeeds - a 500 on an unexpected parameter would be its own
        defect.
        """
        draft = await factories.create_post(db_session, author=author_user)
        archived = await factories.create_post(
            db_session,
            author=author_user,
            status=PostStatus.ARCHIVED,
        )

        # Widened to `Any` at the point of unpacking, and only here. `_collect_feed_ids` also
        # declares a keyword-only `headers: dict[str, str] | None`, so unpacking a
        # `dict[str, str]` into it is a type error even though no attempt below names `headers`:
        # mypy has to assume the mapping could. The local restates the intent - these are opaque
        # query parameters - without loosening the parametrised cases, which stay `str`-valued.
        filters: dict[str, Any] = dict(attempt)
        listed = await _collect_feed_ids(client, **filters)

        assert str(draft.id) not in listed
        assert str(archived.id) not in listed

    @pytest.mark.parametrize("status", NON_PUBLIC_STATUSES, ids=NON_PUBLIC_STATUS_IDS)
    @pytest.mark.parametrize("viewer", ["anonymous", "other-author"])
    async def test_reading_an_unpublished_post_by_slug_is_indistinguishable_from_absence(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        other_author_user: User,
        auth_headers_for: Any,
        viewer: str,
        status: PostStatus,
    ) -> None:
        """An unentitled caller gets the same 404 a nonexistent post produces, detail included.

        Identical on purpose. A distinguishable response - 403, or a 404 with a different
        explanation - would let a caller probe for the existence of unpublished content, which is
        the disclosure the status filter exists to prevent.
        """
        hidden = await factories.create_post(db_session, author=author_user, status=status)
        headers = None if viewer == "anonymous" else auth_headers_for(other_author_user)

        refused = await client.get(_slug_path(hidden.slug), headers=headers)
        nonexistent = await client.get(_slug_path("no-post-carries-this-slug"), headers=headers)

        hidden_problem = _assert_problem_document(
            refused,
            status=404,
            error_type=ERROR_TYPE_NOT_FOUND,
            title=ERROR_TITLE_NOT_FOUND,
        )
        absent_problem = _assert_problem_document(
            nonexistent,
            status=404,
            error_type=ERROR_TYPE_NOT_FOUND,
            title=ERROR_TITLE_NOT_FOUND,
        )
        assert hidden_problem["detail"] == absent_problem["detail"]

    @pytest.mark.parametrize("status", NON_PUBLIC_STATUSES, ids=NON_PUBLIC_STATUS_IDS)
    @pytest.mark.parametrize("viewer", ["author", "administrator"])
    async def test_the_author_and_an_administrator_may_read_an_unpublished_post(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        admin_user: User,
        auth_headers_for: Any,
        viewer: str,
        status: PostStatus,
    ) -> None:
        """The two entitled principals read the post in full, which is how an author previews it."""
        hidden = await factories.create_post(db_session, author=author_user, status=status)
        principal = author_user if viewer == "author" else admin_user

        body = await _read_detail(client, hidden.slug, headers=auth_headers_for(principal))

        assert body["id"] == str(hidden.id)
        assert body["status"] == status.value
        assert body["content"] == hidden.content

    @pytest.mark.parametrize("status", NON_PUBLIC_STATUSES, ids=NON_PUBLIC_STATUS_IDS)
    @pytest.mark.parametrize("viewer", ["administrator", "author", "reader"])
    async def test_the_public_feed_hides_unpublished_posts_from_every_caller(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        admin_user: User,
        reader_user: User,
        auth_headers_for: Any,
        viewer: str,
        status: PostStatus,
    ) -> None:
        """AAP §0.9.4.4 applied to the caller with the most authority, and to the owner.

        The scope of the public feed is a **constant**, not a function of the credential, and this
        is the test that says so for the two principals a role-aware filter would have widened for:
        an administrator, who may read any unpublished post through
        ``GET /api/v1/posts/{slug}``, and the post's own author, who may read it there too. Both
        still see the public feed here, because a listing whose membership depended on who asked
        would give one URL two different ``total`` values and two different page boundaries, and
        would put a draft in a category-filtered result. The workspace mode below is where an
        author's own unpublished work is read.
        """
        hidden = await factories.create_post(db_session, author=author_user, status=status)
        principal = {
            "administrator": admin_user,
            "author": author_user,
            "reader": reader_user,
        }[viewer]

        listed = await _collect_feed_ids(client, headers=auth_headers_for(principal))

        assert str(hidden.id) not in listed

    @pytest.mark.parametrize("status", NON_PUBLIC_STATUSES, ids=NON_PUBLIC_STATUS_IDS)
    async def test_the_author_filter_never_widens_the_public_feed(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        auth_headers_for: Any,
        status: PostStatus,
    ) -> None:
        """``?author=<my own username>`` is still the public feed, so it is still published-only.

        This was the widening the review found: an author naming themselves in a *public* filter
        used to be handed their own drafts, which made ``total`` caller-dependent and let a
        category-filtered public result carry unpublished rows. Reading one's own unpublished work
        is now an explicit request - ``mine=true`` - rather than an inference from the credential.
        """
        own = await factories.create_post(db_session, author=author_user, status=status)

        listed = await _collect_feed_ids(
            client,
            headers=auth_headers_for(author_user),
            author=author_user.username,
        )

        assert str(own.id) not in listed


# =======================================================================================
# The private author workspace - GET /api/v1/posts?mine=true
#
# The other half of the confidentiality rule above. Because the public feed is published-only for
# EVERY caller, an author needs an explicit way to read their own unpublished work, and this is it:
# the same operation, switched into a private mode by a parameter the caller sends, scoped to the
# principal rather than to whatever `?author=` says, and admitting every lifecycle state.
#
# The three refusals below are the load-bearing part. `mine=true` with no credential is a 401 and
# not a silent fallback to the public feed, because a dashboard answered with somebody else's
# published posts looks to its owner like their drafts were deleted. `mine=true&author=someone` is a
# 422 and not "ignore the author", because a request that names another account is asking a question
# this mode must never answer. And `status=` without `mine=true` is a 422 rather than an ignored
# parameter, because a client that believed it had filtered would read a published-only page as the
# whole truth.
# =======================================================================================


class TestAuthorWorkspace:
    """``?mine=true``: whose posts, which states, and what the three refusals are."""

    @pytest.mark.parametrize("status", NON_PUBLIC_STATUSES, ids=NON_PUBLIC_STATUS_IDS)
    async def test_an_author_reads_their_own_unpublished_posts(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        auth_headers_for: Any,
        status: PostStatus,
    ) -> None:
        """Every state of the caller's own work is in scope, which is what the dashboard lists."""
        own = await factories.create_post(db_session, author=author_user, status=status)

        listed = await _collect_feed_ids(client, headers=auth_headers_for(author_user), mine="true")

        assert str(own.id) in listed

    @pytest.mark.parametrize("status", NON_PUBLIC_STATUSES, ids=NON_PUBLIC_STATUS_IDS)
    async def test_the_workspace_never_carries_another_authors_post(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        other_author_user: User,
        auth_headers_for: Any,
        status: PostStatus,
    ) -> None:
        """The scope is the principal, so nobody else's work can appear - published or not.

        The other side of the boundary the previous test opens. A mode that widened for *any*
        authenticated caller, rather than to that caller's own rows, would fail here.
        """
        mine = await factories.create_post(db_session, author=author_user, status=status)
        theirs = await factories.create_post(db_session, author=other_author_user, status=status)
        published_by_other = await factories.create_published_post(
            db_session, author=other_author_user
        )

        listed = await _collect_feed_ids(client, headers=auth_headers_for(author_user), mine="true")

        assert str(mine.id) in listed
        assert str(theirs.id) not in listed
        assert str(published_by_other.id) not in listed

    async def test_status_narrows_the_workspace_to_one_lifecycle_state(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """``status=DRAFT`` returns the drafts and nothing else - how the workspace groups."""
        draft = await factories.create_post(db_session, author=author_user)
        archived = await factories.create_post(
            db_session, author=author_user, status=PostStatus.ARCHIVED
        )
        published = await factories.create_published_post(db_session, author=author_user)
        headers = auth_headers_for(author_user)

        drafts = await _collect_feed_ids(
            client, headers=headers, mine="true", status=PostStatus.DRAFT.value
        )

        assert str(draft.id) in drafts
        assert str(archived.id) not in drafts
        assert str(published.id) not in drafts

    async def test_the_workspace_has_no_anonymous_form(self, client: AsyncClient) -> None:
        """``mine=true`` with no credential is 401, never a quiet fall back to the public feed."""
        response = await client.get(POSTS_URL, params={"mine": "true"})

        _assert_problem_document(
            response,
            status=401,
            error_type=ERROR_TYPE_UNAUTHORIZED,
            title=ERROR_TITLE_UNAUTHORIZED,
        )

    async def test_author_cannot_be_combined_with_the_workspace_mode(
        self,
        client: AsyncClient,
        author_user: User,
        other_author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """Naming another account alongside ``mine=true`` is refused, not silently ignored."""
        response = await client.get(
            POSTS_URL,
            params={"mine": "true", "author": other_author_user.username},
            headers=auth_headers_for(author_user),
        )

        problem = _assert_problem_document(
            response,
            status=422,
            error_type=ERROR_TYPE_VALIDATION,
            title=ERROR_TITLE_VALIDATION,
        )
        assert [item["field"] for item in problem["errors"]] == ["author"]

    async def test_status_is_refused_on_the_public_feed(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """``status=`` outside the workspace mode is a 422, so a client cannot believe it filtered.

        The one query parameter a client might plausibly expect to widen the public feed, refused
        by name. :data:`SCOPE_WIDENING_ATTEMPTS` covers the undeclared spellings, which the
        framework ignores; this covers the declared one, which is answered rather than dropped.
        """
        for headers in (None, auth_headers_for(author_user)):
            response = await client.get(
                POSTS_URL, params={"status": PostStatus.DRAFT.value}, headers=headers
            )

            problem = _assert_problem_document(
                response,
                status=422,
                error_type=ERROR_TYPE_VALIDATION,
                title=ERROR_TITLE_VALIDATION,
            )
            assert [item["field"] for item in problem["errors"]] == ["status"]


# =======================================================================================
# DELETE /api/v1/posts/{post_id} - AAP §0.9.4.2 "Cascades behave"
#
# Deleting a post removes its comments, its likes and its category filings, and it does so in
# PostgreSQL rather than in Python. Every one of those foreign keys declares `ON DELETE CASCADE`
# and every one of the corresponding relationships declares `passive_deletes=True`, so the ORM
# deliberately does not load the children in order to delete them one by one - it issues the single
# DELETE and lets the database do the rest. `comment_service` and `like_service` contain no manual
# deletion at all.
#
# That is why the cascade test below reads the rows back through `db_session` with SQL aggregates
# instead of trusting the 204, and why it asserts the rows EXIST first. A cascade test that passed
# because the rows were never created in the first place would be worse than no test: it would
# report a guarantee the schema might not be making.
# =======================================================================================


class TestDeletePost:
    """``DELETE``: who may issue it, what it answers, and what the database takes with it."""

    async def test_the_owner_can_delete_their_post_and_it_stops_resolving(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """Deletion answers 204 with an empty body, and the post's address then answers 404."""
        headers = auth_headers_for(author_user)
        post = await factories.create_published_post(db_session, author=author_user)

        response = await client.delete(_post_path(post.id), headers=headers)

        assert response.status_code == 204, response.text
        assert response.content == b"", "204 is the whole of the answer; there is no envelope"
        # Gone for its author too, not merely withdrawn from the public surfaces.
        _assert_problem_document(
            await client.get(_slug_path(post.slug), headers=headers),
            status=404,
            error_type=ERROR_TYPE_NOT_FOUND,
            title=ERROR_TITLE_NOT_FOUND,
        )
        assert await _count_rows(db_session, Post, Post.id == post.id) == 0

    async def test_an_administrator_can_delete_a_post_they_do_not_own(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        admin_user: User,
        auth_headers_for: Any,
    ) -> None:
        """An administrator may remove anyone's post - the moderation half of the ownership rule."""
        post = await factories.create_published_post(db_session, author=author_user)

        response = await client.delete(
            _post_path(post.id),
            headers=auth_headers_for(admin_user),
        )

        assert response.status_code == 204, response.text
        assert await _count_rows(db_session, Post, Post.id == post.id) == 0
        # Removing content does not remove the person who wrote it.
        assert await _count_rows(db_session, User, User.id == author_user.id) == 1

    async def test_deleting_a_post_cascades_to_its_comments_likes_and_filings(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: Any,
    ) -> None:
        """The dependent rows go with the post, by ``ON DELETE CASCADE`` and not by Python.

        AAP §0.9.4.2 "Cascades behave", and AAP §0.10.1 standard #3 read as strictly as it is
        written: the guarantee is the schema's, so the assertion is made against the schema.

        The three counts are taken **before** the delete as well as after. Without that, a cascade
        test would pass on an empty thread and report a guarantee nobody had exercised - so the
        pre-conditions here are as load-bearing as the post-conditions. A reply is included because
        ``comments.parent_id`` carries its own cascade, and a reply is therefore removed twice over:
        once because its post is gone and once because its parent is.
        """
        headers = auth_headers_for(author_user)
        category = await factories.create_category(db_session)
        post = await factories.create_published_post(
            db_session,
            author=author_user,
            categories=[category],
        )
        parent = await factories.create_comment(
            db_session,
            post=post,
            author=reader_user,
            status=CommentStatus.APPROVED,
        )
        await factories.create_comment(
            db_session,
            post=post,
            author=reader_user,
            parent=parent,
            status=CommentStatus.APPROVED,
        )
        await factories.create_like(db_session, post=post, user=reader_user)

        # Pre-conditions. Nothing below means anything without them.
        assert await _count_rows(db_session, Comment, Comment.post_id == post.id) == 2
        assert await _count_rows(db_session, Comment, Comment.parent_id == parent.id) == 1
        assert await _count_rows(db_session, PostLike, PostLike.post_id == post.id) == 1
        assert (
            await _count_rows(db_session, post_categories, post_categories.c.post_id == post.id)
            == 1
        )

        response = await client.delete(_post_path(post.id), headers=headers)

        assert response.status_code == 204, response.text
        assert await _count_rows(db_session, Post, Post.id == post.id) == 0
        assert await _count_rows(db_session, Comment, Comment.post_id == post.id) == 0
        assert await _count_rows(db_session, Comment, Comment.parent_id == parent.id) == 0
        assert await _count_rows(db_session, PostLike, PostLike.post_id == post.id) == 0
        assert (
            await _count_rows(db_session, post_categories, post_categories.c.post_id == post.id)
            == 0
        )

    async def test_deleting_a_post_removes_its_filings_but_not_the_category(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """A taxonomy row outlives the posts filed under it - the cascade is one-directional.

        ``post_categories`` declares ``ON DELETE CASCADE`` on **both** of its foreign keys, so it is
        worth pinning which direction a post delete travels: it removes the association and stops.
        A category that vanished with the last post filed under it would silently shrink the filter
        control on the home page.
        """
        headers = auth_headers_for(author_user)
        category = await factories.create_category(db_session)
        post = await factories.create_published_post(
            db_session,
            author=author_user,
            categories=[category],
        )

        response = await client.delete(_post_path(post.id), headers=headers)

        assert response.status_code == 204, response.text
        assert (
            await _count_rows(db_session, post_categories, post_categories.c.post_id == post.id)
            == 0
        )
        assert await _count_rows(db_session, Category, Category.id == category.id) == 1

    async def test_deleting_a_post_leaves_its_author_and_its_commenters_in_place(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: Any,
    ) -> None:
        """Removing content removes no account: ``users`` is upstream of every cascade here."""
        headers = auth_headers_for(author_user)
        post = await factories.create_published_post(db_session, author=author_user)
        await factories.create_comment(db_session, post=post, author=reader_user)
        await factories.create_like(db_session, post=post, user=reader_user)

        response = await client.delete(_post_path(post.id), headers=headers)

        assert response.status_code == 204, response.text
        assert await _count_rows(db_session, User, User.id == author_user.id) == 1
        assert await _count_rows(db_session, User, User.id == reader_user.id) == 1

    async def test_deleting_an_unknown_post_is_a_not_found_problem_document(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """An identifier that names no post is 404, indistinguishably from one already deleted."""
        response = await client.delete(
            _post_path(uuid.uuid4()),
            headers=auth_headers_for(author_user),
        )

        _assert_problem_document(
            response,
            status=404,
            error_type=ERROR_TYPE_NOT_FOUND,
            title=ERROR_TITLE_NOT_FOUND,
        )

    async def test_deleting_a_malformed_identifier_is_a_validation_problem(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: Any,
    ) -> None:
        """A path segment that is not a UUID is refused at the boundary, never as a 500."""
        response = await client.delete(
            _post_path("not-a-uuid"),
            headers=auth_headers_for(author_user),
        )

        _assert_validation_problem(response, field="post_id", error_type="uuid_parsing")
