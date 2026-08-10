"""Integration tests for the discussion surface: create, reply, read, edit, delete, cascade.

This module is the comment half of AAP requirement **R4** - "Each blog page should support
comments, likes, and social sharing" - together with the *implicit* comment-moderation
prerequisite the platform surfaced in AAP section 0.1.3, because an administrative screen for
"managing comments" presupposes a state there is something to manage. The like half belongs to
``test_likes_api.py`` and the moderation transition itself belongs to ``test_admin_api.py``;
neither is duplicated here.

Concretely it proves the four clauses AAP section 0.9.4.4 lists under **Comments**: an
authenticated user can comment and reply; a non-owner cannot edit another's comment; deleting a
parent removes its replies; and only approved comments are visible publicly.

No user rules govern this file
-----------------------------
``review_rules`` returns ``No user rules provided.`` - a complete response, not a truncated
window - so **no user-specified rule governs this file and no rule placed it in scope**. It is in
scope solely by the AAP's file inventory (section 0.4.4.5) and its execution plan (section
0.7.1.11, Group 11). Nothing below is invented to fill that gap, and the absence of rules is not
read as licence to lower the bar: the substitute standard is the AAP's own section 0.10.1
enterprise standards, three of which this module discharges directly.

* **Standard 3, server-owned identity and database-enforced integrity.** The cascade test does
  not stop at a ``204``. It reads the reply rows through ``db_session`` *before* the parent is
  deleted and again afterwards, so the assertion is that PostgreSQL removed them - via
  ``fk_comments_parent_id_comments ... ON DELETE CASCADE`` from revision ``0001`` - and not that
  the service happened to return a success code. ``app.services.comment_service`` deletes no
  reply in Python, and ``Comment.replies`` carries ``passive_deletes=True`` precisely so that it
  cannot: were the constraint dropped, orphans would accumulate in silence and every other test
  here would still pass. Identity is asserted the same way round - a client-supplied ``id`` is
  refused rather than honoured.
* **Standard 6, secure-by-default authentication.** The ``401`` and ``403`` cases are
  requirements rather than extras, and a refusal is only asserted once the resource is shown to
  be *unchanged* afterwards: a route that answered ``403`` and wrote anyway would pass a
  status-code-only test.
* **Standard 8, blocking quality gates.** No ``skip``, no ``xfail``, no placeholder, and nothing
  order-dependent. Every test builds the world it needs and ``conftest.py`` rolls it back, so the
  module gives the same result run alone, run twice, or run in any position relative to its
  siblings.

1. Two path families, and why they are not interchangeable
----------------------------------------------------------
``app.api.v1.routers.comments`` is the only module in that package to export **two** router
objects, which is why ``app.api.v1.router`` makes eight ``include_router`` calls over seven
modules. The split is not stylistic: creation and listing are *post*-scoped, mutation is
*comment*-scoped.

* ``POST   /api/v1/posts/{post_id}/comments`` - 201, ``CommentPublic``, authentication required
* ``GET    /api/v1/posts/{post_id}/comments`` - 200, ``Page[CommentPublic]``, public
* ``PATCH  /api/v1/comments/{comment_id}``    - 200, ``CommentPublic``, owner or administrator
* ``DELETE /api/v1/comments/{comment_id}``    - 204, no body, owner or administrator

2. The listing windows top-level comments only
----------------------------------------------
``CommentRepository.list_for_post`` pages over comments where ``parent_id IS NULL``, ordered by
``created_at`` then ``id`` over the composite ``(post_id, created_at)`` index, and then attaches
the thread beneath each page member.

That windowing choice is what makes ``total`` and ``pages`` **stable**. If replies were counted,
answering one comment would renumber every page boundary after it, and the pagination control the
client shares between the feed, the profile listing and the administrative tables would jump
under the reader's hands. So ``total`` counts *threads*: a post with three top-level comments and
ten replies reports ``total == 3``, and the ten replies arrive nested inside their parents rather
than as page members.

Reply depth, corrected against the implementation
    The nesting is **recursive to full visible depth**, not one level. ``_descendants_of`` is a
    recursive common table expression bounded by ``MAX_THREAD_DEPTH`` (8 levels of descendants
    below a root) and by ``MAX_THREAD_DESCENDANTS`` (200 rows per page of roots). This module
    asserts that recursion rather than assuming a single level, and asserts the creation-side
    ceiling separately: ``MAX_REPLY_DEPTH`` in ``app.services.comment_service`` refuses a reply
    whose parent already sits at the maximum depth, with a ``422`` naming ``parent_id``.

3. Moderation is read-only on these routes, and visibility is the caller's own
------------------------------------------------------------------------------
``CommentPublic`` publishes ``status`` so an author can see that their comment is queued, but no
input model accepts it: ``CommentCreate`` has ``body`` and ``parent_id``, ``CommentUpdate`` has
``body`` alone, and both forbid unknown members. A new comment is therefore created
``PENDING`` - the value ``comment_service.create`` assigns explicitly - and the only way to
``APPROVED`` is ``PATCH /api/v1/admin/comments/{id}/status``, which this module never calls.
Editing a body is the one transition an author's own request causes: an ``APPROVED`` comment
returns to ``PENDING``, because approval attaches to the text a moderator read.

Which states a caller sees is decided once, by ``_visible_comment_statuses``, and the policy is
narrower than "the author sees their own":

* an anonymous caller sees ``APPROVED`` only;
* an administrator sees every state;
* the **post's** author sees every state on their own post;
* everybody else - including the writer of a queued comment, when they do not own the post - sees
  ``APPROVED`` only.

The same predicate is applied at every level of the recursive descent, which closes a subtle
confidentiality hole: an approved parent cannot act as a carrier for an unapproved child. That is
the highest-value assertion in this file, and it is corroborated from the other side too - an
unapproved parent hides its approved reply, because the descent can never reach a child whose
ancestor chain was filtered out.

4. A post the caller cannot see reports 404, never 403
-------------------------------------------------------
``comment_service`` imports ``can_view_post`` from ``app.services.post_service`` rather than
re-deriving the draft rule, so the rule is declared exactly once across posts, comments and
likes. ``_load_visible_post`` raises ``NotFoundError`` both when a post is absent and when it is
invisible, so a draft somebody else owns is indistinguishable from a missing one and identifiers
cannot be enumerated by reading status codes. ``backend/tests/unit/test_permissions.py`` targets
that predicate directly; this module only asserts its consequence at the HTTP boundary.

5. Two harness facts that shape the assertions
-----------------------------------------------
``TimestampMixin`` stamps ``created_at`` and ``updated_at`` from ``func.now()``, and PostgreSQL's
``now()`` is the **transaction** clock. ``conftest.py`` wraps each test in one transaction, so
every row a test creates shares one instant and an edit inside a test cannot move ``updated_at``
past ``created_at``. Asserting ``updated_at > created_at`` would therefore fail for a reason that
has nothing to do with the route, so the invariant asserted here is ``updated_at >= created_at``
plus the edited body itself, which is what actually demonstrates the write.

The same tie makes creation order unobservable: with ``created_at`` equal across a test's rows,
the listing's ``id`` tiebreak decides the sequence. So ordering is asserted as a *property* -
non-decreasing in ``(created_at, id)``, disjoint pages, a complete union and byte-identical
repeat responses - rather than as "the order I inserted them in", which the database never
promised.

Boundaries
----------
Behaviour is driven exclusively through the in-process ``client`` fixture; ``CommentService``,
``CommentRepository`` and ``can_view_post`` are never called to make a behavioural assertion.
``db_session`` is used to build fixtures and, in exactly one place, to observe the database-level
effect standard 3 is about. Three published contract constants are imported so that a limit is
named rather than hard-coded, and a change to one fails compilation instead of quietly passing a
stale number. Every moderation state and post state is written as an enumeration member from the
``app.models`` barrel. No ``__init__.py`` is added anywhere in the tests tree.
"""

from __future__ import annotations

import math
import uuid
from collections.abc import Callable, Sequence
from datetime import datetime
from typing import Any, Final

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MIN_PAGE, MIN_PAGE_SIZE
from app.models import Comment, CommentStatus, Post, PostStatus, User
from app.repositories.comment_repository import (
    MAX_THREAD_DEPTH,
    MAX_THREAD_DESCENDANTS,
    replies_per_root,
)
from app.schemas.comment import BODY_MAX_LENGTH
from app.services.comment_service import MAX_REPLY_DEPTH
from tests import factories

# Every test in this module drives the ASGI application against PostgreSQL, so the whole file
# carries the `integration` marker that `backend/pyproject.toml` declares. `--strict-markers` is
# in `addopts`, so a typo here fails collection rather than silently registering a new marker.
pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------------------
# Routes
#
# Built from one prefix constant rather than written out per call, so the versioned mount point
# appears once. The two builders below are also the guard against mixing the path families: a
# create or a list goes through `_thread_path`, an edit or a delete through `_comment_path`, and
# no test composes a URL by hand.
# ---------------------------------------------------------------------------------------

API_V1: Final[str] = "/api/v1"


def _thread_path(post_id: object) -> str:
    """Return the post-scoped collection route: create a comment, or list the thread."""
    return f"{API_V1}/posts/{post_id}/comments"


def _comment_path(comment_id: object) -> str:
    """Return the comment-scoped resource route: edit or delete one comment."""
    return f"{API_V1}/comments/{comment_id}"


# ---------------------------------------------------------------------------------------
# Contract vocabulary
#
# Member names are spelled once here and asserted as complete sets rather than as "contains",
# because an over-exposure is as much a defect as an omission: the whole point of the author
# projection is what it leaves out.
# ---------------------------------------------------------------------------------------

#: Every member `CommentPublic` publishes, and nothing else.
COMMENT_MEMBERS: Final[frozenset[str]] = frozenset(
    {
        "id",
        "post_id",
        "parent_id",
        "author",
        "body",
        "status",
        "created_at",
        "updated_at",
        "reply_count",
        "has_more_replies",
        "replies",
    }
)

#: Every member `UserPublic` publishes. The embedded author is this projection and never
#: `UserMe`, because a comment is the most public surface in the product.
AUTHOR_MEMBERS: Final[frozenset[str]] = frozenset(
    {"id", "username", "display_name", "bio", "avatar_url", "created_at"}
)

#: Members that must never reach a byline. Asserted by name as well as by the set equality
#: above, so a failure names the leak instead of only reporting a set mismatch.
PRIVATE_USER_MEMBERS: Final[tuple[str, ...]] = ("email", "role", "is_active", "password_hash")

#: The five members of the pagination envelope from `app.core.pagination.Page`.
PAGE_MEMBERS: Final[tuple[str, ...]] = ("items", "total", "page", "page_size", "pages")

#: The members every problem document carries. `request_id` is additionally always present and
#: `errors` only when a field-level cause exists, so neither is asserted unconditionally.
PROBLEM_MEMBERS: Final[tuple[str, ...]] = ("type", "title", "status", "detail", "instance")

#: The members of one entry in a problem document's `errors` array (`FieldError`).
FIELD_ERROR_MEMBERS: Final[frozenset[str]] = frozenset({"field", "message", "type"})

#: Wire values of every moderation state, derived from the enumeration rather than restated, so
#: a renamed member breaks this module instead of silently widening what it accepts.
STATUS_VALUES: Final[frozenset[str]] = frozenset(member.value for member in CommentStatus)

#: The `type` member of each problem document this module expects to see.
PROBLEM_TYPE_UNAUTHORIZED: Final[str] = "/errors/unauthorized"
PROBLEM_TYPE_FORBIDDEN: Final[str] = "/errors/forbidden"
PROBLEM_TYPE_NOT_FOUND: Final[str] = "/errors/not-found"
PROBLEM_TYPE_VALIDATION: Final[str] = "/errors/validation-error"

#: A syntactically valid UUID that addresses nothing. Distinct from the malformed value below,
#: because the two exercise different layers: this one reaches the service and earns a 404,
#: while the other fails path coercion and earns a 422.
ABSENT_UUID: Final[str] = "00000000-0000-0000-0000-000000000000"

#: A path segment that is not a UUID at all.
MALFORMED_UUID: Final[str] = "not-a-uuid"


# ---------------------------------------------------------------------------------------
# The shape of the oversized thread
#
# `app.repositories.comment_repository` bounds a thread read TWICE: `MAX_THREAD_DEPTH` prunes the
# recursive term, and the descendant budget bounds how many rows the page may carry. That budget is
# `MAX_THREAD_DESCENDANTS` for the page as a whole, but it is not spent first-come: it is divided
# by `replies_per_root(page_size)`, so each root on the page receives an equal share and a busy
# thread cannot consume a quiet neighbour's rows. Depth was already exercised by
# `TestReplyThreading`; the row budget was not, and it cannot be exercised by a thread that fits
# inside it. So `wide_thread` builds one that does not.
#
# Every number below is DERIVED from the published allowance rather than written as a literal,
# which is what stops this becoming a test that used to be meaningful. Raise
# `MAX_THREAD_DESCENDANTS` and the fixture grows with it and still overshoots; write `20` here
# instead and the same change would leave a thread comfortably inside the allowance, asserting
# nothing while staying green.
# ---------------------------------------------------------------------------------------

#: The per-root share of the page budget at the default page size - what one thread may carry.
CAP_ALLOWANCE: Final[int] = replies_per_root(DEFAULT_PAGE_SIZE)

#: How far past :data:`CAP_ALLOWANCE` the fixture reaches. Chosen so the overshoot is at least as
#: large as the allowance itself, because the cut has to be observed and the rows discarded are as
#: much of the assertion as the rows kept.
CAP_OVERSHOOT: Final[int] = CAP_ALLOWANCE

#: Replies in the first generation, i.e. direct children of the root. Deliberately well inside the
#: allowance: the depth-major ordering must retain this whole generation before any of the next,
#: and that property is only observable if the generation could have fit.
CAP_FIRST_GENERATION: Final[int] = max(1, CAP_ALLOWANCE // 2)

#: Replies in the second generation, chosen so that the two generations together exceed one root's
#: allowance by exactly :data:`CAP_OVERSHOOT`.
CAP_SECOND_GENERATION: Final[int] = CAP_ALLOWANCE + CAP_OVERSHOOT - CAP_FIRST_GENERATION

#: How many of the first-generation replies carry the second generation, so the thread is a genuine
#: forest with several branches rather than one chain or one flat fan.
CAP_BRANCHING: Final[int] = CAP_FIRST_GENERATION

#: Replies beneath the second, smaller root, used to show one thread's share is its own and a
#: shallow neighbour is not starved by a busy sibling.
CAP_NEIGHBOUR_REPLIES: Final[int] = 3


# ---------------------------------------------------------------------------------------
# Hostile input
#
# `app.services.comment_service` sanitises with bleach under an allow-list of ten inline
# elements, and `strip=True` means a disallowed ELEMENT is removed while the text it wrapped
# survives. So the assertion is about markup and attributes, never about the visible characters:
# `<script>alert(1)</script>` stores `alert(1)`, which is inert text, and demanding that the
# word "alert" disappear would assert a policy the service does not implement.
# ---------------------------------------------------------------------------------------

HOSTILE_BODY: Final[str] = (
    '<script>window.steal("session")</script>'
    '<img src="x" onerror="fetch(\'//attacker.test\')">'
    '<p onclick="drain()">Nice write-up</p>'
    '<a href="javascript:void(0)">tap here</a>'
    "<h1>outranking the article</h1>"
)

#: Fragments that must not survive sanitisation, in any body this module submits.
FORBIDDEN_FRAGMENTS: Final[tuple[str, ...]] = (
    "<script",
    "</script",
    "<img",
    "<h1",
    "onerror",
    "onclick",
    "javascript:",
)


# ---------------------------------------------------------------------------------------
# Type aliases
# ---------------------------------------------------------------------------------------

#: The shape of the `auth_headers_for` fixture: a callable, because a single test routinely needs
#: the owner's credential and a non-owner's in the same body.
type HeaderFactory = Callable[[User], dict[str, str]]

#: One decoded JSON object. The suite asserts on the wire representation rather than on a
#: re-validated model, so that a change to the response model surfaces as a failing assertion
#: about the contract rather than being absorbed by the same code that produced it.
type Json = dict[str, Any]


# ---------------------------------------------------------------------------------------
# Assertion helpers
#
# Each one exists because the same property is checked from several tests and a single
# definition keeps the expectation identical across them. They assert; they never fetch, so a
# test's HTTP traffic is visible in the test itself.
# ---------------------------------------------------------------------------------------


def assert_problem(
    payload: Json,
    *,
    status: int,
    problem_type: str | None = None,
    instance: str | None = None,
) -> None:
    """Assert *payload* is the project's single problem document, carrying *status*.

    AAP section 0.9.4.3 requires every error response to be the same shape, replacing the three
    ad-hoc ``HTTPException(404, "Item not found")`` raises the retired module repeated at
    ``app.py`` lines 31, 40 and 49. Checked here rather than per test so that a route which
    answered the right code with the wrong body could not pass.
    """
    for member in PROBLEM_MEMBERS:
        assert member in payload, f"problem document is missing {member!r}: {payload}"
    assert payload["status"] == status, payload
    # Always present, and equal to the response header of the same name; asserted as a member so
    # an unattributable failure cannot ship.
    assert "request_id" in payload, payload
    if problem_type is not None:
        assert payload["type"] == problem_type, payload
    if instance is not None:
        # The path only - `_problem_response` excludes the query string uniformly, because it is
        # not part of a failure's identity and is where stray credentials end up.
        assert payload["instance"] == instance, payload


def assert_field_error(payload: Json, field: str) -> None:
    """Assert the problem document blames *field*, with a populated, well-formed error list.

    A ``422`` whose ``errors`` array is empty tells a client nothing about which member to fix,
    so the population of that array is part of the contract rather than a nicety.
    """
    errors = payload.get("errors")
    assert isinstance(errors, list), f"expected an errors array, got {errors!r}"
    assert errors, f"errors array is empty: {payload}"
    for entry in errors:
        assert set(entry) == FIELD_ERROR_MEMBERS, f"malformed error entry: {entry}"
    blamed = [entry["field"] for entry in errors]
    assert field in blamed, f"expected {field!r} to be blamed, got {blamed}"


def assert_comment_public(node: Json) -> None:
    """Assert *node* is a ``CommentPublic``, recursively through its ``replies``.

    The author projection is the load-bearing half. ``UserPublic`` is deliberately not
    ``UserMe``: an email address, a role and an active flag are not published beside a comment,
    and the set equality below is what makes an accidental widening of that projection a failing
    test rather than a silent disclosure.
    """
    assert set(node) == COMMENT_MEMBERS, f"unexpected comment members: {sorted(node)}"

    author = node["author"]
    assert set(author) == AUTHOR_MEMBERS, f"unexpected author members: {sorted(author)}"
    for private in PRIVATE_USER_MEMBERS:
        assert private not in author, f"{private!r} reached a public byline: {author}"

    # Identifiers are parsed rather than pattern-matched, so a truncated or re-formatted value
    # fails here instead of surviving into a comparison that happens to be string-equal.
    uuid.UUID(node["id"])
    uuid.UUID(node["post_id"])
    if node["parent_id"] is not None:
        uuid.UUID(node["parent_id"])
    uuid.UUID(author["id"])

    assert node["status"] in STATUS_VALUES, node["status"]
    assert isinstance(node["body"], str), node["body"]
    assert node["body"], "a stored comment body is never empty"
    assert isinstance(node["replies"], list), node["replies"]

    # The continuation contract, asserted at every level. `reply_count` is the number of replies
    # VISIBLE to this caller, which a bounded response may carry only a prefix of, so it can never
    # be smaller than what was returned - and `has_more_replies` must be exactly the statement that
    # the two differ. Deriving the flag in the assertion rather than trusting it is what would catch
    # a projection that set one member and forgot the other.
    assert isinstance(node["reply_count"], int), node["reply_count"]
    assert node["reply_count"] >= len(node["replies"]), (
        f"reply_count {node['reply_count']} is below the {len(node['replies'])} replies returned"
    )
    assert node["has_more_replies"] is (node["reply_count"] > len(node["replies"])), (
        f"has_more_replies {node['has_more_replies']} disagrees with reply_count "
        f"{node['reply_count']} against {len(node['replies'])} returned replies"
    )

    # `replies` is never null and never a placeholder, so the same contract holds at every level
    # of a thread and a client can walk it without a null check.
    for reply in node["replies"]:
        assert reply["parent_id"] == node["id"], "a nested reply must name its parent"
        assert reply["post_id"] == node["post_id"], "a thread never spans two posts"
        assert_comment_public(reply)


def assert_page(payload: Json, *, total: int, page: int, page_size: int) -> None:
    """Assert the five-member pagination envelope, including the ``pages`` arithmetic.

    ``pages == ceil(total / page_size)`` is computed here with :func:`math.ceil` rather than
    restated as a literal, so the assertion is the contract from AAP section 0.9.4.3 and not a
    transcription of whatever the implementation returned.
    """
    for member in PAGE_MEMBERS:
        assert member in payload, f"page envelope is missing {member!r}: {sorted(payload)}"
    assert payload["total"] == total, payload
    # Echoed verbatim and never clamped, which is how a client detects it has run off the end.
    assert payload["page"] == page, payload
    assert payload["page_size"] == page_size, payload
    assert payload["pages"] == math.ceil(total / page_size), payload
    assert len(payload["items"]) <= page_size, payload
    for item in payload["items"]:
        assert item["parent_id"] is None, "a page member is always a top-level comment"
        assert_comment_public(item)


def flatten(nodes: Sequence[Json]) -> list[Json]:
    """Return every comment in *nodes* and, recursively, in their ``replies``."""
    flat: list[Json] = []
    for node in nodes:
        flat.append(node)
        flat.extend(flatten(node["replies"]))
    return flat


def depth_of(node: Json, level: int = 1) -> int:
    """Return how many levels of thread *node* carries, counting itself as one."""
    return max((depth_of(child, level + 1) for child in node["replies"]), default=level)


def bodies_of(nodes: Sequence[Json]) -> list[str]:
    """Return the ``body`` of each node, for legible set comparisons in assertions."""
    return [node["body"] for node in nodes]


def ids_of(nodes: Sequence[Json]) -> list[str]:
    """Return the ``id`` of each node, as the wire string."""
    return [node["id"] for node in nodes]


def ordering_key(node: Json) -> tuple[datetime, uuid.UUID]:
    """Return the key the listing orders by: ``(created_at, id)``, both parsed.

    Parsed rather than compared as strings. ``created_at`` renders without a fixed number of
    fractional digits, so a lexicographic comparison is not order-preserving, and PostgreSQL
    compares ``uuid`` by its sixteen bytes - which is exactly how :class:`uuid.UUID` compares -
    so parsing makes the Python-side key agree with the SQL one by construction.
    """
    return datetime.fromisoformat(node["created_at"]), uuid.UUID(node["id"])


# ---------------------------------------------------------------------------------------
# Construction helpers
#
# Thin wrappers over `tests.factories`, present only to name the two shapes almost every test
# needs. No helper supplies a primary key, assigns `posts.search_vector`, or creates a PUBLISHED
# post without the timezone-aware `published_at` the `ck_posts_published_at_required` CHECK
# demands - `factories.create_published_post` fills that instant itself.
# ---------------------------------------------------------------------------------------


async def visible_post(session: AsyncSession, author: User) -> Post:
    """Create a ``PUBLISHED`` post every caller, anonymous included, is entitled to read."""
    return await factories.create_published_post(session, author=author)


async def approved_thread(
    session: AsyncSession,
    *,
    post: Post,
    author: User,
    bodies: Sequence[str],
) -> list[Comment]:
    """Create one ``APPROVED`` top-level comment per entry in *bodies*, in order.

    ``APPROVED`` because these are fixtures for tests about *reading* a thread, and
    ``factories.create_comment`` defaults to that state for exactly this reason - the column's own
    server default is ``PENDING``, which is the right product default but would make every
    fixture invisible to the public listing.
    """
    return [
        await factories.create_comment(
            session, post=post, author=author, status=CommentStatus.APPROVED, body=body
        )
        for body in bodies
    ]


async def descendant_chain(
    session: AsyncSession,
    *,
    post: Post,
    author: User,
    levels: int,
) -> list[Comment]:
    """Create an ``APPROVED`` chain of *levels* comments, each a reply to the one before.

    Returned root-first, so ``chain[n - 1]`` sits at level ``n``. Used both for the listing's
    nesting behaviour and for the creation-side depth ceiling, and built through the factories
    rather than through the API so that every node is ``APPROVED`` and therefore visible to the
    caller whose reply is under test - a chain built through ``POST`` would be ``PENDING`` and the
    refusal would come from the visibility rule instead of the depth rule.
    """
    chain: list[Comment] = []
    parent: Comment | None = None
    for level in range(1, levels + 1):
        parent = await factories.create_comment(
            session,
            post=post,
            author=author,
            parent=parent,
            status=CommentStatus.APPROVED,
            body=f"level-{level:02d}",
        )
        chain.append(parent)
    return chain


async def wide_thread(
    session: AsyncSession,
    *,
    post: Post,
    author: User,
    first_generation: int = CAP_FIRST_GENERATION,
    second_generation: int = CAP_SECOND_GENERATION,
    branching: int = CAP_BRANCHING,
) -> tuple[Comment, list[Comment], list[Comment]]:
    """Create one ``APPROVED`` root carrying two generations of replies, and return all three parts.

    The fixture the row budget needs. ``descendant_chain`` builds depth and no breadth, which is
    the wrong shape here: a chain can never exceed :data:`CAP_ALLOWANCE` because
    :data:`MAX_THREAD_DEPTH` stops it at eight, so the LIMIT would never be reached. Breadth is
    unbounded by design - a popular comment may have any number of replies - so breadth is what
    the row budget actually defends against and breadth is what this builds.

    The second generation is distributed round-robin over the first *branching* replies, so the
    result is a forest of several branches at two depths rather than one fan. That matters for the
    ordering assertion: a flat fan has a single depth and could not distinguish depth-major
    ordering from plain ``created_at`` ordering.

    Built through ``factories.create_comment`` rather than by constructing rows here, so every node
    goes through the same parent/post validation the request path applies, and every node is
    ``APPROVED`` and therefore visible to an anonymous reader.

    Args:
        session: The session under test.
        post: The post whose thread this is.
        author: The account writing every comment. One author throughout - authorship is not what
            is under test here, and a byline per node would add rows without adding coverage.
        first_generation: How many direct children the root gets.
        second_generation: How many grandchildren, spread over the first *branching* children.
        branching: How many of the first generation carry children.

    Returns:
        ``(root, firsts, seconds)`` - the top-level comment, its direct children in creation
        order, and its grandchildren in creation order. ``firsts + seconds`` is the complete
        descendant set the allowance has to truncate.

    Note:
        Every comment created in one test shares a single ``created_at``. ``created_at`` defaults
        to ``func.now()``, which is the *transaction* clock, and the whole build happens inside the
        test's one transaction - measured directly on this fixture: every row, one distinct
        ``created_at``. So the ordering the cut follows reduces to ``(depth, id)`` here, and ``id``
        is a server-generated UUID. That is why no test below hard-codes which replies survive: the
        expectation is computed from the same key the statement orders by.
    """
    if first_generation >= CAP_ALLOWANCE:
        raise ValueError(
            "the first generation must fit inside one root's allowance, or the depth-major "
            f"assertion below cannot distinguish anything (first_generation={first_generation}, "
            f"CAP_ALLOWANCE={CAP_ALLOWANCE})."
        )
    if first_generation + second_generation <= CAP_ALLOWANCE:
        raise ValueError(
            "the thread must exceed one root's allowance, or nothing is truncated and every "
            f"assertion below passes vacuously (total={first_generation + second_generation}, "
            f"CAP_ALLOWANCE={CAP_ALLOWANCE})."
        )
    if not 0 < branching <= first_generation:
        raise ValueError(
            "branching must name a non-empty prefix of the first generation "
            f"(branching={branching}, first_generation={first_generation})."
        )

    root = await factories.create_comment(
        session, post=post, author=author, status=CommentStatus.APPROVED, body="the root"
    )
    firsts = [
        await factories.create_comment(
            session,
            post=post,
            author=author,
            parent=root,
            status=CommentStatus.APPROVED,
            body=f"first-{index:03d}",
        )
        for index in range(first_generation)
    ]
    seconds = [
        await factories.create_comment(
            session,
            post=post,
            author=author,
            parent=firsts[index % branching],
            status=CommentStatus.APPROVED,
            body=f"second-{index:03d}",
        )
        for index in range(second_generation)
    ]
    return root, firsts, seconds


def retained_by_the_documented_order(
    generations: Sequence[Sequence[Comment]],
    *,
    limit: int,
) -> set[str]:
    """Return the identifiers the repository's own ordering keeps, as wire strings.

    An independent re-derivation of the cut, from the persisted rows and from the key the
    statement declares - ``ORDER BY depth, created_at, id`` with ``LIMIT`` - rather than from what
    the response happened to contain. *generations* is shallowest-first, which is where ``depth``
    comes from: it is not a stored column, so the only honest source for it is the shape the
    fixture built.

    Args:
        generations: The descendant generations, shallowest first.
        limit: How many rows the statement may return.

    Returns:
        The ``str(uuid)`` of each retained comment.
    """
    # Visiting the generations shallowest-first IS the leading `depth` key, so only the two
    # tiebreakers need sorting - within a generation, and never across one.
    ordered: list[Comment] = []
    for generation in generations:
        ordered.extend(sorted(generation, key=lambda row: (row.created_at, row.id)))
    return {str(comment.id) for comment in ordered[:limit]}


async def comment_ids_present(session: AsyncSession, ids: Sequence[uuid.UUID]) -> set[uuid.UUID]:
    """Return which of *ids* still exist in ``comments``, read straight from the row.

    The one place this module looks past the HTTP boundary, and it is what AAP section 0.10.1's
    third standard requires: the cascade is a *database* guarantee, so proving it means observing
    the rows. ``select(Comment.id)`` returns scalars rather than entities, so the answer comes
    from the table and cannot be served out of the session's identity map.
    """
    result = await session.execute(select(Comment.id).where(Comment.id.in_(ids)))
    return set(result.scalars().all())


class TestCreateComment:
    """``POST /api/v1/posts/{post_id}/comments`` - the write half of AAP R4."""

    async def test_an_authenticated_caller_may_add_a_comment(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """A comment is created with 201 and the full public projection (AAP 0.9.4.4)."""
        post = await visible_post(db_session, author_user)

        response = await client.post(
            _thread_path(post.id),
            json={"body": "Clear write-up - the section on cascades especially."},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == 201, response.text
        payload = response.json()
        assert_comment_public(payload)
        # The post comes from the path and the author from the credential, so neither is a
        # client-supplied value that could disagree with the request that carried it.
        assert payload["post_id"] == str(post.id)
        assert payload["author"]["id"] == str(reader_user.id)
        assert payload["author"]["username"] == reader_user.username
        assert payload["body"] == "Clear write-up - the section on cascades especially."
        # Top-level by omission: `parent_id` is the only member that distinguishes a comment from
        # a reply, and a comment nobody has answered reports `[]` rather than null.
        assert payload["parent_id"] is None
        assert payload["replies"] == []

    async def test_a_new_comment_is_created_awaiting_moderation(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """The default state is PENDING, not APPROVED - read from ``comment_service.create``.

        Documented rather than inferred, because every visibility assertion in this module depends
        on it: nothing a reader writes is public until an administrator moves it on, so a client
        must render "awaiting review" from this value instead of showing the comment as though it
        were already part of the thread.
        """
        post = await visible_post(db_session, author_user)

        response = await client.post(
            _thread_path(post.id),
            json={"body": "Queued until a moderator looks at it."},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == 201, response.text
        assert response.json()["status"] == CommentStatus.PENDING.value

    async def test_the_byline_carries_no_private_member(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """The embedded author is ``UserPublic``: no email, role, active flag or password hash."""
        post = await visible_post(db_session, author_user)

        response = await client.post(
            _thread_path(post.id),
            json={"body": "Checking what a byline discloses."},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == 201, response.text
        author = response.json()["author"]
        assert set(author) == AUTHOR_MEMBERS, sorted(author)
        assert reader_user.email not in response.text
        for private in PRIVATE_USER_MEMBERS:
            assert private not in author, f"{private!r} reached the byline"

    async def test_identity_is_server_generated_and_a_supplied_one_is_refused(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """AAP 0.10.1 standard 3: PostgreSQL owns identity, so a client-sent ``id`` is rejected.

        This is the defect class the retired module institutionalised - its only contract let the
        caller choose the key, which the server neither generated nor checked, so a duplicate
        permanently shadowed every later record.
        """
        post = await visible_post(db_session, author_user)
        headers = auth_headers_for(reader_user)

        refused = await client.post(
            _thread_path(post.id),
            json={"body": "Trying to pick my own key.", "id": ABSENT_UUID},
            headers=headers,
        )
        assert refused.status_code == 422, refused.text
        assert_problem(refused.json(), status=422, problem_type=PROBLEM_TYPE_VALIDATION)
        assert_field_error(refused.json(), "id")

        accepted = await client.post(
            _thread_path(post.id), json={"body": "Letting the server decide."}, headers=headers
        )
        assert accepted.status_code == 201, accepted.text
        assert accepted.json()["id"] != ABSENT_UUID
        # Version 4 rather than a client-chosen value: `gen_random_uuid()` is the column default.
        assert uuid.UUID(accepted.json()["id"]).version == 4

    async def test_the_moderation_state_cannot_be_set_on_create(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """``status`` is refused outright, so self-approval is impossible at the input boundary.

        Accepting and ignoring it would be weaker: a client would have no way to learn that its
        request did not do what it asked. ``CommentCreate`` forbids unknown members, so the
        attempt is a 422 naming the field, and the only route to APPROVED remains
        ``PATCH /api/v1/admin/comments/{id}/status`` - covered by ``test_admin_api.py``.
        """
        post = await visible_post(db_session, author_user)
        headers = auth_headers_for(reader_user)

        refused = await client.post(
            _thread_path(post.id),
            json={"body": "Approving myself.", "status": CommentStatus.APPROVED.value},
            headers=headers,
        )
        assert refused.status_code == 422, refused.text
        assert_field_error(refused.json(), "status")

        settled = await client.post(
            _thread_path(post.id), json={"body": "Approving myself."}, headers=headers
        )
        assert settled.status_code == 201, settled.text
        assert settled.json()["status"] == CommentStatus.PENDING.value

    @pytest.mark.parametrize("member", ["post_id", "author_id"])
    async def test_neither_the_post_nor_the_author_may_be_overridden(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        other_author_user: User,
        auth_headers_for: HeaderFactory,
        member: str,
    ) -> None:
        """The thread and the principal are server-owned: sending either member is a 422."""
        post = await visible_post(db_session, author_user)
        other_post = await visible_post(db_session, other_author_user)
        substitute = {"post_id": str(other_post.id), "author_id": str(other_author_user.id)}

        response = await client.post(
            _thread_path(post.id),
            json={"body": "Redirecting this elsewhere.", member: substitute[member]},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == 422, response.text
        assert_field_error(response.json(), member)

    async def test_an_unauthenticated_create_is_refused_with_a_bearer_challenge(
        self, client: AsyncClient, db_session: AsyncSession, author_user: User
    ) -> None:
        """AAP 0.10.1 standard 6: writing to a discussion always requires a principal."""
        post = await visible_post(db_session, author_user)

        response = await client.post(_thread_path(post.id), json={"body": "Anonymous remark."})

        assert response.status_code == 401, response.text
        assert response.headers["www-authenticate"] == "Bearer"
        assert_problem(
            response.json(),
            status=401,
            problem_type=PROBLEM_TYPE_UNAUTHORIZED,
            instance=_thread_path(post.id),
        )

    @pytest.mark.parametrize(
        ("label", "payload"),
        [
            ("absent", {}),
            ("empty", {"body": ""}),
            ("whitespace only", {"body": "    \t  "}),
            ("null", {"body": None}),
            ("over the maximum length", {"body": "x" * (BODY_MAX_LENGTH + 1)}),
        ],
        ids=["absent", "empty", "whitespace", "null", "too-long"],
    )
    async def test_an_unusable_body_is_refused_with_a_populated_error_list(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
        label: str,
        payload: Json,
    ) -> None:
        """Each unusable body is a 422 blaming ``body``, never a 500 and never a silent accept.

        The whitespace-only case is the interesting one: ``CommentBody`` trims before it measures,
        so a body of spaces is *short* rather than present, and there is no state an empty comment
        would describe.
        """
        post = await visible_post(db_session, author_user)

        response = await client.post(
            _thread_path(post.id), json=payload, headers=auth_headers_for(reader_user)
        )

        assert response.status_code == 422, f"{label}: {response.text}"
        assert_problem(response.json(), status=422, problem_type=PROBLEM_TYPE_VALIDATION)
        assert_field_error(response.json(), "body")

    async def test_a_body_at_the_maximum_length_is_accepted(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """The bound is inclusive: exactly ``BODY_MAX_LENGTH`` characters is a valid comment."""
        post = await visible_post(db_session, author_user)

        response = await client.post(
            _thread_path(post.id),
            json={"body": "y" * BODY_MAX_LENGTH},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == 201, response.text
        assert len(response.json()["body"]) == BODY_MAX_LENGTH

    async def test_an_unknown_post_is_reported_as_not_found(
        self, client: AsyncClient, reader_user: User, auth_headers_for: HeaderFactory
    ) -> None:
        """A well-formed identifier that addresses nothing is a 404 problem document."""
        response = await client.post(
            _thread_path(ABSENT_UUID),
            json={"body": "Commenting into the void."},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == 404, response.text
        assert_problem(
            response.json(),
            status=404,
            problem_type=PROBLEM_TYPE_NOT_FOUND,
            instance=_thread_path(ABSENT_UUID),
        )

    async def test_a_malformed_post_identifier_is_a_validation_error(
        self, client: AsyncClient, reader_user: User, auth_headers_for: HeaderFactory
    ) -> None:
        """Path coercion fails as a 422 naming ``post_id`` - never as a 500."""
        response = await client.post(
            _thread_path(MALFORMED_UUID),
            json={"body": "Addressing nonsense."},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == 422, response.text
        assert response.status_code < 500
        assert_field_error(response.json(), "post_id")

    async def test_hostile_markup_is_neutralised_before_it_is_stored(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """Bodies are sanitised on write, closing the stored-injection surface R4 opens.

        bleach runs with ``strip=True`` under an allow-list of ten inline elements, so a
        disallowed element is removed while the text it wrapped survives as inert characters.
        The assertion is therefore about markup and attributes - the script element, the image,
        the heading, every ``on*`` handler and the ``javascript:`` scheme - and not about the
        visible words, which the service never promised to delete.
        """
        post = await visible_post(db_session, author_user)

        response = await client.post(
            _thread_path(post.id),
            json={"body": HOSTILE_BODY},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == 201, response.text
        stored = response.json()["body"]
        for fragment in FORBIDDEN_FRAGMENTS:
            assert fragment not in stored.lower(), f"{fragment!r} survived: {stored!r}"
        # The permitted structure survives, so sanitisation is an allow-list rather than a purge.
        assert "<p>" in stored
        assert "Nice write-up" in stored

    async def test_a_link_keeps_only_the_attributes_the_policy_allows(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """``a`` keeps ``href``, ``title`` and ``rel``; ``target`` and every handler are dropped.

        ``target`` is excluded on purpose: a link opening a new browsing context needs
        ``rel="noopener"`` to be safe, a commenter cannot be relied on to pair them, and the client
        decides link behaviour at render time from a policy it controls.
        """
        post = await visible_post(db_session, author_user)
        link = '<a href="https://example.test/x" rel="nofollow" target="_blank">source</a>'

        response = await client.post(
            _thread_path(post.id), json={"body": link}, headers=auth_headers_for(reader_user)
        )

        assert response.status_code == 201, response.text
        stored = response.json()["body"]
        assert 'href="https://example.test/x"' in stored
        assert 'rel="nofollow"' in stored
        assert "target=" not in stored

    async def test_an_unrecognised_integrity_failure_is_a_server_error_not_a_conflict(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """An integrity failure naming no thread foreign key answers 500, not a thread conflict.

        ``CommentService.create`` translates exactly two constraints - the foreign key to the post
        and the one to the parent comment - because those are the only integrity failures a
        concurrent request can cause: the post or the parent was deleted between the visibility
        check and the insert. That is a real race, and "the thread changed, retry" is the right
        answer to it.

        Every other integrity failure on this relation is a defect in the service rather than
        contention: a column it failed to populate, a check it violated, a generated key it
        somehow collided. Reporting one of those as a 409 was actively harmful, because 409 is the
        status a client is meant to retry - so a reader would resubmit forever against a fault
        that cannot clear, while no 500 was ever raised to say what was actually broken.

        The injected failure carries no driver diagnostics, so no constraint can be named. That is
        the fail-closed path through ``integrity_constraint_name``, and re-raising is the only
        correct response to "I cannot tell what went wrong".
        """
        from sqlalchemy.exc import IntegrityError

        from app.repositories import CommentRepository

        post = await visible_post(db_session, author_user)

        async def raise_unknown_integrity_error(self: CommentRepository, comment: Any) -> Any:
            raise IntegrityError("INSERT INTO comments", {}, Exception("some other invariant"))

        monkeypatch.setattr(CommentRepository, "add_with_author", raise_unknown_integrity_error)

        response = await client.post(
            _thread_path(post.id),
            json={"body": "A comment whose insert fails for a reason nobody allow-listed."},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == 500, response.text
        payload = response.json()
        assert payload["status"] == 500
        assert "removed while this comment was being written" not in payload["detail"], (
            "a defect must not be reported as a thread race the reader should retry"
        )


class TestReplyThreading:
    """``parent_id`` and the shape of the thread it produces - the threading half of AAP R4."""

    async def test_a_reply_carries_the_parent_it_answers(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """Sending ``parent_id`` is the only difference between a comment and a reply."""
        post = await visible_post(db_session, author_user)
        (parent,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["the question"]
        )

        response = await client.post(
            _thread_path(post.id),
            json={"body": "the answer", "parent_id": str(parent.id)},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == 201, response.text
        payload = response.json()
        assert_comment_public(payload)
        assert payload["parent_id"] == str(parent.id)
        # A reply belongs to the same thread as the comment it answers, which is why `post_id` is
        # taken from the path and a cross-post parent is refused outright below.
        assert payload["post_id"] == str(post.id)

    async def test_an_explicit_null_parent_creates_a_top_level_comment(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """Sending ``parent_id: null`` is equivalent to omitting it, so a client need not branch."""
        post = await visible_post(db_session, author_user)

        response = await client.post(
            _thread_path(post.id),
            json={"body": "top level, explicitly", "parent_id": None},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == 201, response.text
        assert response.json()["parent_id"] is None

    async def test_a_reply_is_nested_under_its_parent_and_is_not_a_page_member(
        self, client: AsyncClient, db_session: AsyncSession, author_user: User, reader_user: User
    ) -> None:
        """Replies arrive inside ``replies``; the page members are top-level comments only.

        A client renders a discussion by walking ``replies`` rather than by matching ``parent_id``
        across a flat list, so a reply appearing as its own page member would be a contract break
        even though the same rows would be present.
        """
        post = await visible_post(db_session, author_user)
        (parent,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["parent"]
        )
        reply = await factories.create_comment(
            db_session,
            post=post,
            author=reader_user,
            parent=parent,
            status=CommentStatus.APPROVED,
            body="nested reply",
        )

        response = await client.get(_thread_path(post.id))

        assert response.status_code == 200, response.text
        payload = response.json()
        assert_page(payload, total=1, page=MIN_PAGE, page_size=DEFAULT_PAGE_SIZE)
        assert ids_of(payload["items"]) == [str(parent.id)]
        assert str(reply.id) not in ids_of(payload["items"])
        assert bodies_of(payload["items"][0]["replies"]) == ["nested reply"]

    async def test_the_page_total_counts_top_level_comments_only(
        self, client: AsyncClient, db_session: AsyncSession, author_user: User, reader_user: User
    ) -> None:
        """``total`` counts threads, so answering a comment cannot renumber the pages.

        ``CommentRepository.list_for_post`` windows on ``parent_id IS NULL``. That is what keeps
        ``total`` and ``pages`` stable and consecutive pages disjoint: were replies counted, adding
        one would shift every page boundary after it and the pagination control the client shares
        between the feed, the profile listing and the administrative tables would jump.
        """
        post = await visible_post(db_session, author_user)
        tops = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["one", "two", "three"]
        )
        for top in tops:
            for index in range(3):
                await factories.create_comment(
                    db_session,
                    post=post,
                    author=reader_user,
                    parent=top,
                    status=CommentStatus.APPROVED,
                    body=f"reply {index} to {top.body}",
                )

        response = await client.get(_thread_path(post.id))

        assert response.status_code == 200, response.text
        payload = response.json()
        # Three threads and nine replies: twelve rows, three page members.
        assert payload["total"] == 3
        assert len(payload["items"]) == 3
        assert len(flatten(payload["items"])) == 12

    async def test_the_listing_nests_replies_recursively_not_one_level_deep(
        self, client: AsyncClient, db_session: AsyncSession, author_user: User, reader_user: User
    ) -> None:
        """The declared depth behaviour, read from ``CommentRepository.list_for_post``.

        ``_descendants_of`` is a recursive common table expression, not a single eager load, so a
        reply's own replies are nested too. The bound is ``MAX_THREAD_DEPTH`` levels of descendants
        below a page member - so a root plus that many levels - and ``MAX_THREAD_DESCENDANTS`` rows
        per page of roots. This test builds a chain one level *past* the bound and asserts the
        response nests to the ceiling and stops, which is the behaviour the type itself imposes no
        limit on and only the query decides.
        """
        post = await visible_post(db_session, author_user)
        levels = MAX_THREAD_DEPTH + 2
        chain = await descendant_chain(db_session, post=post, author=reader_user, levels=levels)
        assert len(chain) == levels

        response = await client.get(_thread_path(post.id))

        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["total"] == 1, "a chain is one thread however deep it runs"
        root = payload["items"][0]
        visible_levels = MAX_THREAD_DEPTH + 1
        assert depth_of(root) == visible_levels
        assert len(flatten([root])) == visible_levels
        expected = [f"level-{level:02d}" for level in range(1, visible_levels + 1)]
        assert bodies_of(flatten([root])) == expected

    async def test_a_parent_belonging_to_another_post_is_refused(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """A cross-post parent is a 422 blaming ``parent_id``, never a thread spanning two posts.

        The database can guarantee the parent exists but cannot compare its post to the reply's
        without a redundant column, so ``comment_service.create`` makes the comparison. Letting it
        pass would build a thread no query could read back coherently.
        """
        post_a = await visible_post(db_session, author_user)
        post_b = await visible_post(db_session, author_user)
        (foreign_parent,) = await approved_thread(
            db_session, post=post_a, author=reader_user, bodies=["lives on post A"]
        )

        response = await client.post(
            _thread_path(post_b.id),
            json={"body": "replying across posts", "parent_id": str(foreign_parent.id)},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == 422, response.text
        assert_problem(
            response.json(),
            status=422,
            problem_type=PROBLEM_TYPE_VALIDATION,
            instance=_thread_path(post_b.id),
        )
        assert_field_error(response.json(), "parent_id")

    async def test_a_parent_that_does_not_exist_is_refused_identically(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """An absent parent earns the same 422 as a foreign one - deliberately indistinguishable.

        Reporting the two differently would turn ``parent_id`` into an oracle for discovering that
        an identifier addresses something real, which is how an unauthorised caller enumerates.
        """
        post = await visible_post(db_session, author_user)

        response = await client.post(
            _thread_path(post.id),
            json={"body": "answering a ghost", "parent_id": ABSENT_UUID},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == 422, response.text
        assert_field_error(response.json(), "parent_id")

    async def test_a_parent_the_caller_cannot_see_is_refused(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """Reply visibility is the caller's own, so a queued parent is invisible to a reader.

        Refused with the same answer a missing identifier earns - reporting it any differently
        would make this member a way of discovering that a comment is awaiting moderation. The
        post's own author sees the whole thread, so the same request succeeds for them, which is
        what proves the refusal is a visibility decision rather than a blanket rule about PENDING.
        """
        post = await visible_post(db_session, author_user)
        queued = await factories.create_comment(
            db_session,
            post=post,
            author=reader_user,
            status=CommentStatus.PENDING,
            body="still in the queue",
        )
        reply = {"body": "answering the queued comment", "parent_id": str(queued.id)}

        refused = await client.post(
            _thread_path(post.id), json=reply, headers=auth_headers_for(reader_user)
        )
        assert refused.status_code == 422, refused.text
        assert_field_error(refused.json(), "parent_id")

        allowed = await client.post(
            _thread_path(post.id), json=reply, headers=auth_headers_for(author_user)
        )
        assert allowed.status_code == 201, allowed.text
        assert allowed.json()["parent_id"] == str(queued.id)

    async def test_a_malformed_parent_identifier_is_a_validation_error(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """A ``parent_id`` that is not a UUID is a 422 blaming that member, never a 500."""
        post = await visible_post(db_session, author_user)

        response = await client.post(
            _thread_path(post.id),
            json={"body": "malformed parent", "parent_id": MALFORMED_UUID},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == 422, response.text
        assert response.status_code < 500
        assert_field_error(response.json(), "parent_id")

    async def test_a_reply_at_the_maximum_depth_is_accepted_and_one_deeper_is_refused(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """``MAX_REPLY_DEPTH`` is the creation-side ceiling, enforced on the parent's own depth.

        The two halves are asserted together on one chain, because a ceiling test that only shows
        the refusal cannot distinguish "too deep" from "broken". Named from the service constant
        rather than written as a number, so raising the limit changes one declaration and this test
        follows it.
        """
        post = await visible_post(db_session, author_user)
        chain = await descendant_chain(
            db_session, post=post, author=reader_user, levels=MAX_REPLY_DEPTH + 1
        )
        headers = auth_headers_for(reader_user)

        at_ceiling = await client.post(
            _thread_path(post.id),
            json={"body": "still within the thread", "parent_id": str(chain[-2].id)},
            headers=headers,
        )
        assert at_ceiling.status_code == 201, at_ceiling.text

        past_ceiling = await client.post(
            _thread_path(post.id),
            json={"body": "one level too far", "parent_id": str(chain[-1].id)},
            headers=headers,
        )
        assert past_ceiling.status_code == 422, past_ceiling.text
        assert_problem(past_ceiling.json(), status=422, problem_type=PROBLEM_TYPE_VALIDATION)
        assert_field_error(past_ceiling.json(), "parent_id")


class TestReplyBreadth:
    """A thread can be wide as well as deep, and width must not silently lose replies.

    Depth is bounded by ``MAX_THREAD_DEPTH`` and breadth by a row budget, and the two failed
    differently. The depth bound was always visible in its effect - a chain simply stopped - while
    the breadth bound was a single ``LIMIT`` spent across every root on the page, first-come. One
    discussion with a few hundred replies consumed the whole budget, and every other thread on that
    page came back looking as though nobody had answered it, with nothing in the response saying
    otherwise.

    Three properties are asserted here: the budget is shared fairly, a truncated collection says it
    is truncated, and everything beyond the bound is still reachable.
    """

    @staticmethod
    async def _wide_thread(
        session: AsyncSession,
        *,
        post: Post,
        author: User,
        replies: int,
        body_prefix: str,
    ) -> tuple[Comment, list[Comment]]:
        """Create one approved root with *replies* approved direct replies beneath it."""
        root = await factories.create_comment(
            session,
            post=post,
            author=author,
            status=CommentStatus.APPROVED,
            body=f"{body_prefix} root",
        )
        children = [
            await factories.create_comment(
                session,
                post=post,
                author=author,
                parent=root,
                status=CommentStatus.APPROVED,
                body=f"{body_prefix} reply {index}",
            )
            for index in range(replies)
        ]
        return root, children

    async def test_a_busy_thread_cannot_starve_the_others_on_its_page(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """A quiet thread keeps its replies even when a louder one shares the page.

        The regression this closes, in the shape that produced it. The busy root's replies are
        created *first*, and the descent is ordered depth-major by ``created_at`` - so under a
        single global ``LIMIT`` of ``MAX_THREAD_DESCENDANTS`` every one of the budget's rows went to
        that root, and the quiet root that follows received **none**. Its two replies existed, were
        approved, were visible, and simply did not appear.

        The allowance is now per root, so the busy thread takes its share and no more. Both halves
        are asserted, because either alone would pass for the wrong reason: the quiet thread must
        carry *all* of its replies, and the busy one must both be capped and admit that it is.
        """
        post = await visible_post(db_session, author_user)
        busy_root, busy_replies = await self._wide_thread(
            db_session,
            post=post,
            author=reader_user,
            replies=MAX_THREAD_DESCENDANTS + 5,
            body_prefix="busy",
        )
        quiet_root, quiet_replies = await self._wide_thread(
            db_session, post=post, author=reader_user, replies=2, body_prefix="quiet"
        )

        response = await client.get(_thread_path(post.id))

        assert response.status_code == 200, response.text
        payload = response.json()
        threads = {item["id"]: item for item in payload["items"]}
        assert str(busy_root.id) in threads
        assert str(quiet_root.id) in threads

        quiet = threads[str(quiet_root.id)]
        assert len(quiet["replies"]) == len(quiet_replies), (
            "the quiet thread lost replies to the busy one sharing its page"
        )
        assert quiet["reply_count"] == len(quiet_replies)
        assert quiet["has_more_replies"] is False

        busy = threads[str(busy_root.id)]
        allowance = replies_per_root(DEFAULT_PAGE_SIZE)
        assert len(busy["replies"]) == allowance, (
            f"the busy thread carried {len(busy['replies'])} replies rather than its allowance "
            f"of {allowance}"
        )
        assert busy["reply_count"] == len(busy_replies)
        assert busy["has_more_replies"] is True, (
            "a truncated thread reported itself as complete, which is indistinguishable from a "
            "thread nobody answered"
        )

    async def test_every_reply_beyond_the_bound_stays_addressable(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """The replies a bounded thread omits are all reachable through the ``parent`` window.

        Bounding a response is only acceptable if nothing becomes unreachable, so this pages the
        continuation window to exhaustion and requires the union to be exactly the set that was
        created - not a subset, and with no row served twice. That is the difference between a
        response that is *bounded* and one that is *lossy*.
        """
        post = await visible_post(db_session, author_user)
        allowance = replies_per_root(DEFAULT_PAGE_SIZE)
        root, replies = await self._wide_thread(
            db_session,
            post=post,
            author=reader_user,
            replies=allowance * 2 + 3,
            body_prefix="wide",
        )

        thread = await client.get(_thread_path(post.id))
        assert thread.status_code == 200, thread.text
        node = next(item for item in thread.json()["items"] if item["id"] == str(root.id))
        assert node["has_more_replies"] is True
        assert node["reply_count"] == len(replies)

        collected: list[str] = []
        page = 1
        while True:
            window = await client.get(
                _thread_path(post.id), params={"parent": str(root.id), "page": page, "page_size": 5}
            )
            assert window.status_code == 200, window.text
            body = window.json()
            assert body["total"] == len(replies), (
                "the continuation window counts the replies of that comment, so its total is the "
                "number of replies rather than the number of threads"
            )
            if not body["items"]:
                break
            for item in body["items"]:
                assert_comment_public(item)
                assert item["parent_id"] == str(root.id), (
                    "the parent window returned a comment that does not answer the given parent"
                )
            collected.extend(item["id"] for item in body["items"])
            page += 1

        assert len(collected) == len(set(collected)), "a reply was served on two pages"
        assert set(collected) == {str(reply.id) for reply in replies}, (
            "paging the continuation window did not recover exactly the replies that exist"
        )

    async def test_the_parent_window_applies_the_same_moderation_filter(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """The continuation window is not a way around moderation.

        A new addressing mode is a new chance to leak, and this is the one that would matter: the
        replies reached through ``parent`` are filtered exactly as the nested ones are, so a
        ``PENDING`` reply is absent from both. Asserted for an anonymous caller, who is entitled to
        approved comments and nothing else.
        """
        post = await visible_post(db_session, author_user)
        root = await factories.create_comment(
            db_session, post=post, author=reader_user, status=CommentStatus.APPROVED
        )
        approved = await factories.create_comment(
            db_session,
            post=post,
            author=reader_user,
            parent=root,
            status=CommentStatus.APPROVED,
            body="Visible to everyone.",
        )
        pending = await factories.create_comment(
            db_session,
            post=post,
            author=reader_user,
            parent=root,
            status=CommentStatus.PENDING,
            body="Still awaiting review.",
        )

        response = await client.get(_thread_path(post.id), params={"parent": str(root.id)})

        assert response.status_code == 200, response.text
        body = response.json()
        returned = {item["id"] for item in body["items"]}
        assert str(approved.id) in returned
        assert str(pending.id) not in returned, "an unapproved reply reached a public caller"
        assert body["total"] == 1, (
            "the continuation window's total counts only the replies the caller may see, or it "
            "reports the existence of comments they cannot read"
        )

    async def test_an_unknown_parent_answers_an_empty_page_rather_than_an_error(
        self, client: AsyncClient, db_session: AsyncSession, author_user: User
    ) -> None:
        """A parent that names no comment on this post is an empty page, disclosing nothing.

        Refusing would answer "does this identifier exist, and is it on this post?" for any
        identifier a caller cared to try. An empty page is indistinguishable from a comment nobody
        answered, which is the same reasoning the sign-out route follows.
        """
        post = await visible_post(db_session, author_user)

        response = await client.get(_thread_path(post.id), params={"parent": str(uuid.uuid4())})

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["items"] == []
        assert body["total"] == 0

    async def test_a_malformed_parent_is_refused_as_validation(
        self, client: AsyncClient, db_session: AsyncSession, author_user: User
    ) -> None:
        """``parent`` is a UUID, so a value that is not one is a 422 naming the parameter."""
        post = await visible_post(db_session, author_user)

        response = await client.get(_thread_path(post.id), params={"parent": "not-a-uuid"})

        assert response.status_code == 422, response.text
        assert_field_error(response.json(), "parent")

    @pytest.mark.parametrize("hidden_state", [CommentStatus.PENDING, CommentStatus.REJECTED])
    async def test_a_hidden_parent_discloses_none_of_its_approved_replies(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        hidden_state: CommentStatus,
    ) -> None:
        """The window is authorised on the parent, not only filtered on the children.

        The sibling test above proves the *children* are filtered by their own moderation state.
        This is the other half, and it was the gap: the parent a caller names was never authorised
        at all. So a caller who learned the identifier of a ``PENDING`` or ``REJECTED`` comment
        could ask for its window and be handed the ``APPROVED`` replies underneath it - content the
        nested thread deliberately withholds, because the recursive descent stops at a hidden
        ancestor and never reaches them.

        Both halves of the envelope are asserted. ``items`` empty is not enough: a ``total`` of one
        beside an empty list would report that a reply exists without returning it, which answers
        the same question the leak did. And the answer must stay a ``200`` empty page rather than
        becoming a ``404`` or a ``403``, because either status would confirm that the identifier
        addresses a real comment and turn this endpoint into an oracle for enumerating hidden ones.

        Parametrised over both non-public states rather than one, because the rule is "not in the
        visible set" and a fix that tested for ``REJECTED`` specifically would leave the other open.
        """
        post = await visible_post(db_session, author_user)
        hidden_parent = await factories.create_comment(
            db_session,
            post=post,
            author=reader_user,
            status=hidden_state,
            body="Held back by moderation.",
        )
        await factories.create_comment(
            db_session,
            post=post,
            author=reader_user,
            parent=hidden_parent,
            status=CommentStatus.APPROVED,
            body="Approved answer under a hidden comment.",
        )

        response = await client.get(_thread_path(post.id), params={"parent": str(hidden_parent.id)})

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["items"] == [], (
            "the approved replies of a comment this caller may not see were returned through the "
            "continuation window"
        )
        assert body["total"] == 0, (
            "`total` reports that replies exist beneath a comment the caller may not see, which "
            "discloses the same fact the items would have"
        )

    async def test_a_hidden_grandparent_closes_the_window_on_its_visible_child(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """Pruning is by ancestry, so the window has to be too.

        ``APPROVED`` root -> ``PENDING`` reply -> ``APPROVED`` reply is the shape that defeats a
        parent-only check. The middle comment is hidden, so the nested thread returns the root and
        nothing below it: the grandchild is unreachable there even though it is approved. If the
        window only asked about the comment named in the request, naming the *grandchild's parent*
        would be refused while naming the grandchild itself would still serve whatever hangs off
        it - the same disclosure one generation down.

        So visibility is decided over the whole chain to the root, and this asserts the case a
        parent-only fix would pass.
        """
        post = await visible_post(db_session, author_user)
        root = await factories.create_comment(
            db_session, post=post, author=reader_user, status=CommentStatus.APPROVED
        )
        hidden_middle = await factories.create_comment(
            db_session,
            post=post,
            author=reader_user,
            parent=root,
            status=CommentStatus.PENDING,
            body="Awaiting review.",
        )
        visible_grandchild = await factories.create_comment(
            db_session,
            post=post,
            author=reader_user,
            parent=hidden_middle,
            status=CommentStatus.APPROVED,
            body="Approved, but beneath a hidden ancestor.",
        )
        await factories.create_comment(
            db_session,
            post=post,
            author=reader_user,
            parent=visible_grandchild,
            status=CommentStatus.APPROVED,
            body="Approved, two hidden generations up.",
        )

        # The control: the nested thread already prunes at the hidden generation, so nothing under
        # `hidden_middle` is reachable the ordinary way - the behaviour the window must match.
        thread = await client.get(_thread_path(post.id))
        assert thread.status_code == 200, thread.text
        assert [item["id"] for item in thread.json()["items"]] == [str(root.id)]
        assert thread.json()["items"][0]["replies"] == []

        # The window on the approved grandchild, whose own status is visible and whose ancestry is
        # not.
        response = await client.get(
            _thread_path(post.id), params={"parent": str(visible_grandchild.id)}
        )

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["items"] == [], (
            "the window served the replies of an approved comment that sits beneath a hidden "
            "ancestor, which the nested thread correctly refuses to reach"
        )
        assert body["total"] == 0

    async def test_the_post_author_still_reaches_every_window_on_their_own_thread(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: Callable[[User], dict[str, str]],
    ) -> None:
        """The gate is a visibility rule, not a new restriction, so a wider caller is unaffected.

        A post's own author sees every moderation state in their own thread - that is what
        ``_visible_comment_statuses`` grants them, and it is the useful behaviour: they are the
        person who notices a reader waiting on approval. The window must therefore stay open to
        them on exactly the comments the nested thread shows them, including a ``PENDING`` parent.

        Without this the fix would be indistinguishable from having narrowed the window for
        everybody, which is the failure mode a security check most easily hides.
        """
        post = await visible_post(db_session, author_user)
        pending_parent = await factories.create_comment(
            db_session,
            post=post,
            author=reader_user,
            status=CommentStatus.PENDING,
            body="Awaiting the author's attention.",
        )
        reply = await factories.create_comment(
            db_session,
            post=post,
            author=reader_user,
            parent=pending_parent,
            status=CommentStatus.APPROVED,
            body="An answer the author may read.",
        )

        response = await client.get(
            _thread_path(post.id),
            params={"parent": str(pending_parent.id)},
            headers=auth_headers_for(author_user),
        )

        assert response.status_code == 200, response.text
        body = response.json()
        assert [item["id"] for item in body["items"]] == [str(reply.id)], (
            "the continuation window was closed to the post's own author, who is entitled to every "
            "moderation state in their own thread"
        )
        assert body["total"] == 1

    async def test_a_parent_on_another_post_discloses_nothing(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """Membership of the addressed post is part of the gate, not a separate concern.

        A visible comment on article A, named in a window request against article B, must be
        answered exactly like an identifier that matches nothing - otherwise the endpoint reports
        which article a comment belongs to, one guess at a time.
        """
        elsewhere = await visible_post(db_session, author_user)
        here = await visible_post(db_session, author_user)
        foreign_parent = await factories.create_comment(
            db_session, post=elsewhere, author=reader_user, status=CommentStatus.APPROVED
        )
        await factories.create_comment(
            db_session,
            post=elsewhere,
            author=reader_user,
            parent=foreign_parent,
            status=CommentStatus.APPROVED,
            body="A reply on the other article.",
        )

        response = await client.get(
            _thread_path(here.id), params={"parent": str(foreign_parent.id)}
        )

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["items"] == []
        assert body["total"] == 0


class TestModerationVisibility:
    """Which moderation states each caller sees - the implicit prerequisite of AAP 0.1.3.

    Comment moderation is not gold-plating. The prompt asks for an administrative screen
    "managing comments", and managing a comment presupposes a state to manage, so the three-valued
    ``CommentStatus`` is the minimum the stated feature needs. What each caller may see is decided
    once, by ``_visible_comment_statuses``, and asserted here per caller rather than assumed.
    """

    @staticmethod
    async def _one_of_each_state(
        session: AsyncSession, *, post: Post, author: User
    ) -> dict[CommentStatus, Comment]:
        """Create one top-level comment in every ``CommentStatus`` member and return them by state.

        Iterating the enumeration rather than listing three literals means a fourth state added
        later is exercised here automatically - and would default to invisible publicly, because
        ``app.repositories.comment_repository`` filters *on* APPROVED rather than excluding the
        others.
        """
        return {
            state: await factories.create_comment(
                session, post=post, author=author, status=state, body=f"top-{state.value}"
            )
            for state in CommentStatus
        }

    async def test_an_anonymous_caller_sees_approved_comments_only(
        self, client: AsyncClient, db_session: AsyncSession, author_user: User, reader_user: User
    ) -> None:
        """AAP 0.9.4.4: only approved comments are visible publicly, and ``total`` agrees."""
        post = await visible_post(db_session, author_user)
        by_state = await self._one_of_each_state(db_session, post=post, author=reader_user)

        response = await client.get(_thread_path(post.id))

        assert response.status_code == 200, response.text
        payload = response.json()
        assert_page(payload, total=1, page=MIN_PAGE, page_size=DEFAULT_PAGE_SIZE)
        assert ids_of(payload["items"]) == [str(by_state[CommentStatus.APPROVED].id)]
        assert bodies_of(payload["items"]) == [f"top-{CommentStatus.APPROVED.value}"]
        for withheld in (CommentStatus.PENDING, CommentStatus.REJECTED):
            assert str(by_state[withheld].id) not in response.text

    async def test_an_unapproved_reply_never_travels_under_an_approved_parent(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        other_author_user: User,
    ) -> None:
        """The highest-value assertion here: an approved parent is not a carrier for its children.

        ``_descendants_of`` applies the **same** status predicate in its anchor *and* in its
        recursive term, so the moderation rule holds at every level of the descent rather than only
        at the page members. Without that predicate on the recursion an approved comment would
        publish every reply beneath it, which is a confidentiality hole that no assertion about the
        page members could ever detect - the parent's own row would look perfectly correct.
        """
        post = await visible_post(db_session, author_user)
        (parent,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["approved parent"]
        )
        for state in CommentStatus:
            await factories.create_comment(
                db_session,
                post=post,
                author=other_author_user,
                parent=parent,
                status=state,
                body=f"reply-{state.value}",
            )

        response = await client.get(_thread_path(post.id))

        assert response.status_code == 200, response.text
        payload = response.json()
        assert_page(payload, total=1, page=MIN_PAGE, page_size=DEFAULT_PAGE_SIZE)
        nested = payload["items"][0]["replies"]
        assert bodies_of(nested) == [f"reply-{CommentStatus.APPROVED.value}"]
        for withheld in (CommentStatus.PENDING, CommentStatus.REJECTED):
            assert f"reply-{withheld.value}" not in response.text
        # Every node the public caller received is approved, at any depth.
        assert {node["status"] for node in flatten(payload["items"])} == {
            CommentStatus.APPROVED.value
        }

    async def test_an_unapproved_parent_withholds_its_approved_reply(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        other_author_user: User,
    ) -> None:
        """The same closure seen from the other side, and the reason the recursion is anchored.

        A descendant can only be reached through its ancestors, so a reply whose parent was
        filtered out is unreachable however it is moderated. An approved reply under a queued
        parent is therefore invisible publicly - it does not get promoted to a page member, and it
        does not appear detached. The post's author, who sees every state, sees both.
        """
        post = await visible_post(db_session, author_user)
        queued_parent = await factories.create_comment(
            db_session,
            post=post,
            author=reader_user,
            status=CommentStatus.PENDING,
            body="queued parent",
        )
        await factories.create_comment(
            db_session,
            post=post,
            author=other_author_user,
            parent=queued_parent,
            status=CommentStatus.APPROVED,
            body="approved child of a queued parent",
        )

        anonymous = await client.get(_thread_path(post.id))
        assert anonymous.status_code == 200, anonymous.text
        assert_page(anonymous.json(), total=0, page=MIN_PAGE, page_size=DEFAULT_PAGE_SIZE)
        assert anonymous.json()["items"] == []
        assert "approved child of a queued parent" not in anonymous.text

    async def test_the_posts_author_sees_every_moderation_state(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """The post's own author sees the whole thread on their own post, replies included."""
        post = await visible_post(db_session, author_user)
        await self._one_of_each_state(db_session, post=post, author=reader_user)
        (approved,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["extra approved"]
        )
        await factories.create_comment(
            db_session,
            post=post,
            author=reader_user,
            parent=approved,
            status=CommentStatus.PENDING,
            body="queued reply",
        )

        response = await client.get(_thread_path(post.id), headers=auth_headers_for(author_user))

        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["total"] == 4
        assert {node["status"] for node in flatten(payload["items"])} == STATUS_VALUES
        assert "queued reply" in bodies_of(flatten(payload["items"]))

    async def test_an_administrator_sees_every_moderation_state(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        admin_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """An administrator is the moderation queue's reader, so no state is hidden from them."""
        post = await visible_post(db_session, author_user)
        by_state = await self._one_of_each_state(db_session, post=post, author=reader_user)

        response = await client.get(_thread_path(post.id), headers=auth_headers_for(admin_user))

        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["total"] == len(by_state)
        assert {node["status"] for node in payload["items"]} == STATUS_VALUES

    async def test_a_commenter_who_does_not_own_the_post_sees_approved_comments_only(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """The declared policy, asserted rather than guessed: authorship is not visibility.

        ``_visible_comment_statuses`` widens for an administrator and for the **post's** author. It
        does not widen for the writer of a queued comment, so a reader who has just commented sees
        their own row in the ``201`` response - which is how the client renders "awaiting review" -
        and does not see it in the public thread until it is approved.
        """
        post = await visible_post(db_session, author_user)
        created = await client.post(
            _thread_path(post.id),
            json={"body": "mine, and queued"},
            headers=auth_headers_for(reader_user),
        )
        assert created.status_code == 201, created.text
        assert created.json()["status"] == CommentStatus.PENDING.value

        listed = await client.get(_thread_path(post.id), headers=auth_headers_for(reader_user))

        assert listed.status_code == 200, listed.text
        assert_page(listed.json(), total=0, page=MIN_PAGE, page_size=DEFAULT_PAGE_SIZE)
        assert "mine, and queued" not in listed.text

    async def test_the_page_arithmetic_reflects_the_filtered_count(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """``total`` and ``pages`` are computed after the status filter, not before it.

        The count statement carries the *same* predicates as the row statement, so a public caller
        is never told there are more pages than they can read - which would leave a client paging
        into windows that answer with nothing.
        """
        post = await visible_post(db_session, author_user)
        await approved_thread(
            db_session,
            post=post,
            author=reader_user,
            bodies=[f"approved {index}" for index in range(5)],
        )
        for index in range(4):
            await factories.create_comment(
                db_session,
                post=post,
                author=reader_user,
                status=CommentStatus.PENDING,
                body=f"queued {index}",
            )

        anonymous = await client.get(f"{_thread_path(post.id)}?page_size=2")
        assert anonymous.status_code == 200, anonymous.text
        assert_page(anonymous.json(), total=5, page=MIN_PAGE, page_size=2)

        privileged = await client.get(
            f"{_thread_path(post.id)}?page_size=2", headers=auth_headers_for(author_user)
        )
        assert privileged.status_code == 200, privileged.text
        assert_page(privileged.json(), total=9, page=MIN_PAGE, page_size=2)


class TestCommentListingPagination:
    """``GET /api/v1/posts/{post_id}/comments`` windowing - the uniform contract of AAP 0.9.4.3.

    The same envelope the feed, the profile listing and every administrative table return, because
    three list surfaces that windowed differently could not share one pagination control. All five
    members are asserted, and the arithmetic is computed rather than transcribed.
    """

    #: Enough top-level comments to span three pages at a small window, plus a remainder on the
    #: last one - a total that divided evenly would hide an off-by-one in the `pages` arithmetic.
    THREAD_SIZE: int = 7
    WINDOW: int = 3

    async def test_the_envelope_carries_all_five_members(
        self, client: AsyncClient, db_session: AsyncSession, author_user: User, reader_user: User
    ) -> None:
        """``items``, ``total``, ``page``, ``page_size`` and ``pages``, on every list response."""
        post = await visible_post(db_session, author_user)
        await approved_thread(db_session, post=post, author=reader_user, bodies=["only one"])

        response = await client.get(_thread_path(post.id))

        assert response.status_code == 200, response.text
        payload = response.json()
        assert set(payload) == set(PAGE_MEMBERS), sorted(payload)
        assert_page(payload, total=1, page=MIN_PAGE, page_size=DEFAULT_PAGE_SIZE)

    async def test_a_thread_with_no_comments_answers_an_empty_page(
        self, client: AsyncClient, db_session: AsyncSession, author_user: User
    ) -> None:
        """An empty discussion is a 200 with ``total`` and ``pages`` at zero, never a 404."""
        post = await visible_post(db_session, author_user)

        response = await client.get(_thread_path(post.id))

        assert response.status_code == 200, response.text
        assert_page(response.json(), total=0, page=MIN_PAGE, page_size=DEFAULT_PAGE_SIZE)
        assert response.json()["items"] == []
        assert response.json()["pages"] == 0

    async def test_the_default_window_is_applied_when_none_is_requested(
        self, client: AsyncClient, db_session: AsyncSession, author_user: User, reader_user: User
    ) -> None:
        """``page_size`` defaults to ``DEFAULT_PAGE_SIZE`` and ``page`` to ``MIN_PAGE``."""
        post = await visible_post(db_session, author_user)
        await approved_thread(db_session, post=post, author=reader_user, bodies=["a", "b"])

        response = await client.get(_thread_path(post.id))

        assert response.status_code == 200, response.text
        assert response.json()["page"] == MIN_PAGE
        assert response.json()["page_size"] == DEFAULT_PAGE_SIZE

    @pytest.mark.parametrize("page_size", [1, 2, 3, 4, THREAD_SIZE, THREAD_SIZE + 5])
    async def test_the_page_count_is_the_ceiling_of_the_total_over_the_window(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        page_size: int,
    ) -> None:
        """``pages == ceil(total / page_size)`` exactly, at every window including the exact fit."""
        post = await visible_post(db_session, author_user)
        await approved_thread(
            db_session,
            post=post,
            author=reader_user,
            bodies=[f"comment {index:02d}" for index in range(self.THREAD_SIZE)],
        )

        response = await client.get(f"{_thread_path(post.id)}?page_size={page_size}")

        assert response.status_code == 200, response.text
        assert_page(response.json(), total=self.THREAD_SIZE, page=MIN_PAGE, page_size=page_size)

    async def test_consecutive_pages_are_disjoint_and_their_union_is_complete(
        self, client: AsyncClient, db_session: AsyncSession, author_user: User, reader_user: User
    ) -> None:
        """Every comment appears on exactly one page, which is what the top-level window buys.

        Asserted as a partition rather than page by page: the intersection of any two pages is
        empty and the union is the whole thread, so neither a skipped nor a repeated row can hide in
        the middle of the sequence.
        """
        post = await visible_post(db_session, author_user)
        created = await approved_thread(
            db_session,
            post=post,
            author=reader_user,
            bodies=[f"comment {index:02d}" for index in range(self.THREAD_SIZE)],
        )
        # A reply on the first thread, present only to prove it changes no page boundary.
        await factories.create_comment(
            db_session,
            post=post,
            author=reader_user,
            parent=created[0],
            status=CommentStatus.APPROVED,
            body="a reply that must not shift the pages",
        )
        expected = {str(comment.id) for comment in created}

        pages: list[list[str]] = []
        for page in range(MIN_PAGE, MIN_PAGE + math.ceil(self.THREAD_SIZE / self.WINDOW)):
            response = await client.get(
                f"{_thread_path(post.id)}?page={page}&page_size={self.WINDOW}"
            )
            assert response.status_code == 200, response.text
            assert_page(response.json(), total=self.THREAD_SIZE, page=page, page_size=self.WINDOW)
            pages.append(ids_of(response.json()["items"]))

        seen = [identifier for page_ids in pages for identifier in page_ids]
        assert len(seen) == len(set(seen)), f"a comment appeared twice: {seen}"
        assert set(seen) == expected
        for index, page_ids in enumerate(pages):
            for other in pages[index + 1 :]:
                assert not set(page_ids) & set(other), "pages overlap"

    async def test_the_listing_is_ordered_and_repeatable(
        self, client: AsyncClient, db_session: AsyncSession, author_user: User, reader_user: User
    ) -> None:
        """Ordered by ``(created_at, id)`` ascending, and identical across identical requests.

        Ordering is asserted as a property rather than as "the sequence I inserted", and that is a
        correctness point rather than a concession. ``created_at`` is stamped by ``now()``, which in
        PostgreSQL is the *transaction* clock, and ``conftest.py`` runs each test in one
        transaction - so every row here shares one instant and the query's ``id`` tiebreak decides
        the sequence. What the route promises is a **total** order, which is what makes the pages a
        stable partition; asserting insertion order would assert something the database never
        offered and would fail for a reason unrelated to the route.
        """
        post = await visible_post(db_session, author_user)
        await approved_thread(
            db_session,
            post=post,
            author=reader_user,
            bodies=[f"comment {index:02d}" for index in range(self.THREAD_SIZE)],
        )

        collected: list[Json] = []
        for page in range(MIN_PAGE, MIN_PAGE + math.ceil(self.THREAD_SIZE / self.WINDOW)):
            response = await client.get(
                f"{_thread_path(post.id)}?page={page}&page_size={self.WINDOW}"
            )
            assert response.status_code == 200, response.text
            collected.extend(response.json()["items"])

        keys = [ordering_key(node) for node in collected]
        assert keys == sorted(keys), "the concatenated pages are not in ascending thread order"

        first = await client.get(f"{_thread_path(post.id)}?page=1&page_size={self.WINDOW}")
        again = await client.get(f"{_thread_path(post.id)}?page=1&page_size={self.WINDOW}")
        assert ids_of(first.json()["items"]) == ids_of(again.json()["items"])

    async def test_a_page_beyond_the_last_answers_200_with_no_items(
        self, client: AsyncClient, db_session: AsyncSession, author_user: User, reader_user: User
    ) -> None:
        """An out-of-range page is a legitimate request that matches nothing - never an error.

        ``page`` is echoed verbatim and never clamped, so the caller can tell it has run off the end
        by comparing the page it asked for with the real page count. Clamping would return the last
        page's rows under the requested number, silently answering a different question.
        """
        post = await visible_post(db_session, author_user)
        await approved_thread(db_session, post=post, author=reader_user, bodies=["one", "two"])

        response = await client.get(f"{_thread_path(post.id)}?page=99&page_size={self.WINDOW}")

        assert response.status_code == 200, response.text
        assert_page(response.json(), total=2, page=99, page_size=self.WINDOW)
        assert response.json()["items"] == []
        assert response.json()["pages"] == 1

    @pytest.mark.parametrize(
        ("query", "field"),
        [
            (f"page={MIN_PAGE - 1}", "page"),
            ("page=-4", "page"),
            ("page=first", "page"),
            (f"page_size={MIN_PAGE_SIZE - 1}", "page_size"),
            (f"page_size={MAX_PAGE_SIZE + 1}", "page_size"),
            ("page_size=all", "page_size"),
        ],
        ids=["page-zero", "page-negative", "page-text", "size-zero", "size-over-max", "size-text"],
    )
    async def test_a_window_outside_its_bounds_is_refused(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        query: str,
        field: str,
    ) -> None:
        """``PageParams`` bounds the window before the handler runs, so a violation is a 422.

        The bounds are asymmetric on purpose and both halves are exercised: ``page_size`` is capped
        at ``MAX_PAGE_SIZE`` so one request cannot ask the database for an unbounded window, while
        ``page`` has a floor and no ceiling because a page past the end is legitimate. A refusal is
        never a 500 and never a silent normalisation to the nearest legal value, which would answer
        a question the caller did not ask.
        """
        post = await visible_post(db_session, author_user)

        response = await client.get(f"{_thread_path(post.id)}?{query}")

        assert response.status_code == 422, response.text
        assert response.status_code < 500
        assert_problem(response.json(), status=422, problem_type=PROBLEM_TYPE_VALIDATION)
        assert_field_error(response.json(), field)

    async def test_an_unusable_credential_on_a_read_is_refused_not_downgraded(
        self, client: AsyncClient, db_session: AsyncSession, author_user: User
    ) -> None:
        """Absent is fine on a read; unusable is not, so an expired session cannot go unnoticed.

        Degrading a malformed or expired token to anonymous would serve the approved thread and hide
        from the client that its session needs renewing.
        """
        post = await visible_post(db_session, author_user)

        anonymous = await client.get(_thread_path(post.id))
        assert anonymous.status_code == 200, anonymous.text

        response = await client.get(
            _thread_path(post.id), headers={"Authorization": "Bearer not-a-real-token"}
        )

        assert response.status_code == 401, response.text
        assert_problem(response.json(), status=401, problem_type=PROBLEM_TYPE_UNAUTHORIZED)

    async def test_a_malformed_post_identifier_is_a_validation_error(
        self, client: AsyncClient
    ) -> None:
        """A listing addressed by a non-UUID is a 422 naming ``post_id``, never a 500."""
        response = await client.get(_thread_path(MALFORMED_UUID))

        assert response.status_code == 422, response.text
        assert_field_error(response.json(), "post_id")

    async def test_an_unknown_post_is_reported_as_not_found(self, client: AsyncClient) -> None:
        """Listing a thread that does not exist is a 404 problem document."""
        response = await client.get(_thread_path(ABSENT_UUID))

        assert response.status_code == 404, response.text
        assert_problem(response.json(), status=404, problem_type=PROBLEM_TYPE_NOT_FOUND)


class TestThreadDescendantCap:
    """The descendant budget truncating an oversized thread, and truncating it *coherently*.

    The second bound on a thread read, and the one no other test in this module can reach.
    ``TestReplyThreading`` exercises ``MAX_THREAD_DEPTH`` by building a chain, but a chain cannot
    exercise the row budget: depth stops at eight, so eight rows is the most a chain can ever
    produce. Breadth is what the budget defends against - nothing bounds how many replies one
    comment may attract - so every test here reads a thread built by :func:`wide_thread`, whose
    descendants exceed one root's :data:`CAP_ALLOWANCE` by :data:`CAP_OVERSHOOT`.

    The budget is :data:`MAX_THREAD_DESCENDANTS` for the whole page, spent **per root** through
    ``replies_per_root`` rather than first-come. That distinction is what
    :class:`TestReplyBreadth` covers from the fairness direction; this class covers what the
    truncation does to the *shape* of one oversized thread, which is a different property and
    fails independently.

    Truncating is the easy half. The reason the allowance is a windowed ``LIMIT`` under
    ``ORDER BY depth, created_at, id`` rather than a plain ``LIMIT`` is that an arbitrary handful
    of a thread's rows is not a thread: drop a reply and keep its child, and
    ``comment_repository._attach_replies`` groups that child under a parent that is not in the
    result, so the child is silently discarded - present in the row set, attached to nothing, and
    invisible in the response. Depth-major ordering is what makes that impossible, and the tests
    below assert the consequence rather than the mechanism.

    Each test builds its own thread. They cannot share one: the session is per-test and rolled back
    afterwards, which is what keeps the suite order-independent.
    """

    async def test_the_thread_is_truncated_to_the_published_cap(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """A thread with more descendants than its allowance returns exactly the allowance.

        The fixture's own size is asserted first, and that assertion is not ceremony: without it
        this test would pass trivially the moment the budget were raised above the number of rows
        built, and it would look like the bound working rather than like the test no longer
        reaching it.

        ``reply_count`` and ``has_more_replies`` are asserted alongside the truncation, because a
        bounded response is only honest if it says so. Both are *per node* and count **direct**
        visible replies, so the root - whose whole first generation fits inside the allowance -
        reports its true child count and reports itself complete. The nodes the cut actually
        truncates are the first-generation replies that carry a second generation, and at least one
        of them must announce itself as a prefix; otherwise a client cannot tell a truncated thread
        from a thread nobody answered.
        """
        post = await visible_post(db_session, author_user)
        root, firsts, seconds = await wide_thread(db_session, post=post, author=reader_user)
        built = len(firsts) + len(seconds)
        assert built > CAP_ALLOWANCE, (
            f"the fixture must exceed one root's allowance to test it: built {built}, "
            f"allowance {CAP_ALLOWANCE}"
        )

        response = await client.get(_thread_path(post.id))

        assert response.status_code == 200, response.text
        payload = response.json()
        # One thread, so one page member: `total` counts roots, not replies.
        assert_page(payload, total=1, page=MIN_PAGE, page_size=DEFAULT_PAGE_SIZE)
        returned = flatten(payload["items"])
        assert ids_of(payload["items"]) == [str(root.id)]
        # The root itself is a page member rather than a descendant, hence the plus one.
        assert len(returned) == CAP_ALLOWANCE + 1, len(returned)
        (item,) = payload["items"]
        assert item["reply_count"] == len(firsts), item["reply_count"]
        assert item["has_more_replies"] is False, (
            "the root's own children all fit inside the allowance, so it is not a prefix"
        )
        truncated = [
            node
            for node in flatten(item["replies"])
            if node["has_more_replies"] and len(node["replies"]) < node["reply_count"]
        ]
        assert truncated, (
            "the allowance cut a generation and no node said so, which is indistinguishable "
            "from a thread nobody answered"
        )

    async def test_the_shallower_generation_survives_the_cut_whole(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """Every first-generation reply is kept, and only second-generation replies are dropped.

        The observable consequence of ``depth`` leading the sort. The alternative ordering -
        ``created_at`` first, which is what the ordinary listing uses - would cut somewhere inside
        a single instant shared by every row, taking replies from both generations arbitrarily.
        Here the count of survivors per generation is exact: the whole of the first, and the
        remainder of the allowance from the second.
        """
        post = await visible_post(db_session, author_user)
        _, firsts, seconds = await wide_thread(db_session, post=post, author=reader_user)

        response = await client.get(_thread_path(post.id))

        assert response.status_code == 200, response.text
        returned = {node["id"] for node in flatten(response.json()["items"])}
        kept_first = {str(comment.id) for comment in firsts} & returned
        kept_second = {str(comment.id) for comment in seconds} & returned

        assert len(kept_first) == len(firsts), (
            "a shallower reply was dropped while a deeper one was kept: "
            f"kept {len(kept_first)} of {len(firsts)} first-generation replies"
        )
        assert len(kept_second) == CAP_ALLOWANCE - len(firsts), len(kept_second)
        assert len(seconds) - len(kept_second) == CAP_OVERSHOOT, len(kept_second)

    async def test_the_cut_falls_exactly_where_the_ordering_puts_it(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """The retained set is the one ``ORDER BY depth, created_at, id`` selects - not merely N.

        The strongest form of the assertion, and the reason
        :func:`retained_by_the_documented_order` exists: the expectation is re-derived from the
        persisted rows and the declared key, in this module, so a statement that returned the right
        *number* of the wrong rows fails here. A ``LIMIT`` without the ``ORDER BY`` would satisfy
        every count assertion above and fail this one, because PostgreSQL is then free to return
        any subset of the size the allowance permits.
        """
        post = await visible_post(db_session, author_user)
        _, firsts, seconds = await wide_thread(db_session, post=post, author=reader_user)
        expected = retained_by_the_documented_order((firsts, seconds), limit=CAP_ALLOWANCE)

        response = await client.get(_thread_path(post.id))

        assert response.status_code == 200, response.text
        returned = {node["id"] for node in flatten(response.json()["items"])}
        # The root is a page member, not a descendant, so it is excluded from the comparison.
        descendants = returned - {ids_of(response.json()["items"])[0]}
        assert descendants == expected, (
            f"{len(descendants - expected)} unexpected and "
            f"{len(expected - descendants)} missing descendants"
        )

    async def test_every_retained_reply_is_still_attached_to_its_own_parent(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """The truncated set is a valid forest: no orphan, and nothing re-parented onto the root.

        The defect depth-major ordering exists to prevent, asserted from two directions. Every
        returned node's ``parent_id`` names something the response also carries, so nothing hangs
        off a comment that was cut; and the root's own child count is still exactly the first
        generation, so a grandchild whose parent was dropped was not quietly promoted to sit
        beside its former parent.
        """
        post = await visible_post(db_session, author_user)
        root, firsts, _ = await wide_thread(db_session, post=post, author=reader_user)

        response = await client.get(_thread_path(post.id))

        assert response.status_code == 200, response.text
        items = response.json()["items"]
        returned = flatten(items)
        present = {node["id"] for node in returned}
        orphans = [
            node["id"]
            for node in returned
            if node["parent_id"] is not None and node["parent_id"] not in present
        ]
        assert not orphans, f"{len(orphans)} replies name a parent the response does not carry"
        assert len(items[0]["replies"]) == len(firsts), (
            "the root's direct children changed under truncation: "
            f"{len(items[0]['replies'])} nested, {len(firsts)} created"
        )
        # And the nesting is genuinely two deep, so the fixture's shape reached the response
        # rather than being flattened by the cut.
        assert depth_of(items[0]) == 3, depth_of(items[0])
        assert str(root.id) == items[0]["id"]

    async def test_the_truncation_is_the_same_on_every_read(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """Two identical requests return the identical rows in the identical order.

        Why ``id`` is the final tiebreaker. Every row here shares one ``created_at`` - the
        transaction clock - so ``ORDER BY depth, created_at`` alone leaves 210 rows tied inside two
        groups and PostgreSQL free to break the tie differently per execution. The cut would then
        fall in a different place on each read, and a client paging or re-reading a busy thread
        would see replies appear and disappear without anything having changed.
        """
        post = await visible_post(db_session, author_user)
        await wide_thread(db_session, post=post, author=reader_user)

        first_read = await client.get(_thread_path(post.id))
        second_read = await client.get(_thread_path(post.id))

        assert first_read.status_code == 200, first_read.text
        assert second_read.status_code == 200, second_read.text
        first_ids = ids_of(flatten(first_read.json()["items"]))
        second_ids = ids_of(flatten(second_read.json()["items"]))
        assert first_ids == second_ids, "the truncation moved between two identical reads"

    async def test_the_budget_is_shared_per_root_and_a_shallow_thread_is_not_starved(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """Two threads on one page each get their own share, and the small one keeps every reply.

        Both halves are published behaviour and both matter. The page budget is
        :data:`MAX_THREAD_DESCENDANTS` across one statement covering every root on the page, which
        is what makes the cost of a listing predictable however the discussion is shaped - but it
        is divided by ``replies_per_root`` rather than spent first-come, so a huge sibling cannot
        starve a shallow neighbour of rows it would otherwise have had. The neighbour keeps every
        reply because it is well inside its own share; the busy thread is held to exactly its own.
        """
        post = await visible_post(db_session, author_user)
        _, firsts, _ = await wide_thread(db_session, post=post, author=reader_user)
        (neighbour,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["the quiet thread"]
        )
        neighbour_replies = [
            await factories.create_comment(
                db_session,
                post=post,
                author=reader_user,
                parent=neighbour,
                status=CommentStatus.APPROVED,
                body=f"neighbour-{index:02d}",
            )
            for index in range(CAP_NEIGHBOUR_REPLIES)
        ]

        response = await client.get(_thread_path(post.id))

        assert response.status_code == 200, response.text
        payload = response.json()
        assert_page(payload, total=2, page=MIN_PAGE, page_size=DEFAULT_PAGE_SIZE)
        returned = flatten(payload["items"])
        # Two roots are page members; everything else is a descendant. The busy thread spends its
        # whole share, the quiet one spends only what it has, and the two together are what the
        # page carries - which is the per-root division rather than a first-come budget.
        assert len(returned) - 2 == CAP_ALLOWANCE + CAP_NEIGHBOUR_REPLIES, len(returned)

        present = {node["id"] for node in returned}
        assert {str(reply.id) for reply in neighbour_replies} <= present, (
            "the shallow thread lost replies to its sibling's share"
        )
        # And the first generation of the large thread is untouched too, for the same reason.
        assert {str(comment.id) for comment in firsts} <= present

    async def test_a_page_of_one_root_carries_only_that_root_s_replies(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
    ) -> None:
        """Narrowing the page to one thread narrows the descendants to that thread's own.

        The anchor of the recursive term is ``parent_id IN (the roots on this page)``, so a page is
        self-contained: no reply from a thread the page does not carry may appear on it, in either
        direction. Asserted over both pages rather than over a chosen one, because every row here
        shares a ``created_at`` and the page order therefore falls out of the ``id`` tiebreaker -
        which thread lands on page one is not knowable in advance and must not need to be.
        """
        post = await visible_post(db_session, author_user)
        _, firsts, seconds = await wide_thread(db_session, post=post, author=reader_user)
        (neighbour,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["the quiet thread"]
        )
        neighbour_reply = await factories.create_comment(
            db_session,
            post=post,
            author=reader_user,
            parent=neighbour,
            status=CommentStatus.APPROVED,
            body="neighbour-00",
        )
        subtrees = {
            str(neighbour.id): {str(neighbour_reply.id)},
            # The large thread's own subtree, before truncation - membership is asserted as a
            # subset, so the rows the cap discarded simply do not appear.
            None: {str(comment.id) for comment in (*firsts, *seconds)},
        }

        for page in (MIN_PAGE, MIN_PAGE + 1):
            response = await client.get(
                _thread_path(post.id), params={"page": page, "page_size": MIN_PAGE_SIZE}
            )

            assert response.status_code == 200, response.text
            payload = response.json()
            assert_page(payload, total=2, page=page, page_size=MIN_PAGE_SIZE)
            (item,) = payload["items"]
            own = subtrees.get(item["id"], subtrees[None])
            descendants = {node["id"] for node in flatten(item["replies"])}
            assert descendants <= own, (
                f"page {page} carried {len(descendants - own)} replies from another thread"
            )
            assert descendants, "a root with replies returned none"


class TestEditComment:
    """``PATCH /api/v1/comments/{comment_id}`` - "edit" in AAP R4, ownership-scoped.

    A genuine partial update of a single member, unlike the whole-object replacement the retired
    ``PUT /items/{item_id}`` performed. Only the body may change: ``status`` would be a moderation
    bypass on a route the comment's own author can reach, and ``parent_id`` would silently
    re-parent a comment others have already replied within, so a thread's shape is fixed when its
    rows are written.
    """

    async def test_the_author_may_replace_the_body(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """The comment's own author edits it and receives the updated public projection."""
        post = await visible_post(db_session, author_user)
        (comment,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["first draft of a remark"]
        )

        response = await client.patch(
            _comment_path(comment.id),
            json={"body": "corrected: the cascade is recursive"},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == 200, response.text
        payload = response.json()
        assert_comment_public(payload)
        assert payload["id"] == str(comment.id)
        assert payload["body"] == "corrected: the cascade is recursive"
        # An edit does not move the comment within its thread.
        assert payload["post_id"] == str(post.id)
        assert payload["parent_id"] is None

    async def test_an_accepted_edit_returns_an_approved_comment_to_awaiting_moderation(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        admin_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """Approval attaches to the text a moderator read, not to the row that held it.

        The one moderation transition an author's own request causes, and it is applied by the
        server rather than asked for. There is no exemption for an administrator: an edit by one
        also re-opens moderation, because the question is whether the *replacement* has been
        reviewed.
        """
        post = await visible_post(db_session, author_user)
        first, second = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["reviewed one", "reviewed two"]
        )

        by_author = await client.patch(
            _comment_path(first.id),
            json={"body": "replaced by its author"},
            headers=auth_headers_for(reader_user),
        )
        assert by_author.status_code == 200, by_author.text
        assert by_author.json()["status"] == CommentStatus.PENDING.value

        by_admin = await client.patch(
            _comment_path(second.id),
            json={"body": "replaced by an administrator"},
            headers=auth_headers_for(admin_user),
        )
        assert by_admin.status_code == 200, by_admin.text
        assert by_admin.json()["status"] == CommentStatus.PENDING.value

    @pytest.mark.parametrize(
        "state", [CommentStatus.PENDING, CommentStatus.REJECTED], ids=["pending", "rejected"]
    )
    async def test_editing_an_unapproved_comment_leaves_its_state_where_it_was(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
        state: CommentStatus,
    ) -> None:
        """The transition is APPROVED to PENDING specifically, not a blanket reset on every edit.

        The distinction matters in both directions. A comment already awaiting review stays where it
        is, so editing it does not shuffle its position in the moderation queue; and a *rejected*
        comment is not laundered back into the queue by an edit, because rejection is a decision an
        administrator has already taken and only an administrator may revisit it through
        ``PATCH /api/v1/admin/comments/{id}/status``.
        """
        post = await visible_post(db_session, author_user)
        comment = await factories.create_comment(
            db_session, post=post, author=reader_user, status=state, body="not yet public"
        )

        response = await client.patch(
            _comment_path(comment.id),
            json={"body": "revised while unapproved"},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == 200, response.text
        assert response.json()["body"] == "revised while unapproved"
        assert response.json()["status"] == state.value

    async def test_an_empty_patch_is_accepted_and_changes_nothing(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """Omitting ``body`` leaves the comment alone, including its moderation state.

        A partial update whose patch is empty is a no-op rather than an error, and because it leaves
        the state untouched it doubles as this module's read-back of a single comment: there is no
        ``GET /api/v1/comments/{id}``, so this is how a test observes one comment over HTTP without
        reaching past the boundary.
        """
        post = await visible_post(db_session, author_user)
        (comment,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["untouched"]
        )

        response = await client.patch(
            _comment_path(comment.id), json={}, headers=auth_headers_for(reader_user)
        )

        assert response.status_code == 200, response.text
        assert response.json()["body"] == "untouched"
        assert response.json()["status"] == CommentStatus.APPROVED.value

    async def test_the_timestamps_remain_consistent_across_an_edit(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """``updated_at >= created_at`` holds, and the replaced body is what proves the write.

        Deliberately not ``updated_at > created_at``. Both columns are stamped from ``func.now()``,
        which is PostgreSQL's **transaction** clock, and ``conftest.py`` wraps each test in one
        transaction - so an edit performed inside a test cannot advance the value past the moment
        the row was inserted. Asserting a strict inequality would fail for a reason that has nothing
        to do with this route, so the invariant asserted is the ordering that always holds, and the
        evidence of the update is the body itself.
        """
        post = await visible_post(db_session, author_user)
        (comment,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["before"]
        )

        response = await client.patch(
            _comment_path(comment.id), json={"body": "after"}, headers=auth_headers_for(reader_user)
        )

        assert response.status_code == 200, response.text
        payload = response.json()
        created_at = datetime.fromisoformat(payload["created_at"])
        updated_at = datetime.fromisoformat(payload["updated_at"])
        assert updated_at >= created_at
        assert created_at.tzinfo is not None, "instants are published as timezone-aware UTC"
        assert updated_at.tzinfo is not None
        assert payload["body"] == "after"

    @pytest.mark.parametrize(
        ("member", "value"),
        [
            ("status", CommentStatus.APPROVED.value),
            ("parent_id", ABSENT_UUID),
            ("post_id", ABSENT_UUID),
            ("author_id", ABSENT_UUID),
            ("id", ABSENT_UUID),
        ],
        ids=["status", "parent_id", "post_id", "author_id", "id"],
    )
    async def test_no_member_other_than_the_body_may_be_sent(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
        member: str,
        value: str,
    ) -> None:
        """``CommentUpdate`` is body-only, so any other member is a 422 and nothing is written."""
        post = await visible_post(db_session, author_user)
        (comment,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["original text"]
        )
        headers = auth_headers_for(reader_user)

        response = await client.patch(
            _comment_path(comment.id), json={"body": "new text", member: value}, headers=headers
        )

        assert response.status_code == 422, response.text
        assert_field_error(response.json(), member)

        # Rejected before anything was written: neither the body nor the moderation state moved.
        settled = await client.patch(_comment_path(comment.id), json={}, headers=headers)
        assert settled.status_code == 200, settled.text
        assert settled.json()["body"] == "original text"
        assert settled.json()["status"] == CommentStatus.APPROVED.value

    async def test_a_null_body_is_refused(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """Null is not "leave it alone" - omit the member for that. There is no empty comment."""
        post = await visible_post(db_session, author_user)
        (comment,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["intact"]
        )

        response = await client.patch(
            _comment_path(comment.id), json={"body": None}, headers=auth_headers_for(reader_user)
        )

        assert response.status_code == 422, response.text
        assert_field_error(response.json(), "body")

    @pytest.mark.parametrize(
        "body", ["", "   ", "x" * (BODY_MAX_LENGTH + 1)], ids=["empty", "whitespace", "too-long"]
    )
    async def test_a_replacement_body_is_held_to_the_same_bounds_as_the_original(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
        body: str,
    ) -> None:
        """An edit is not a way past a rule creation enforces."""
        post = await visible_post(db_session, author_user)
        (comment,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["within bounds"]
        )

        response = await client.patch(
            _comment_path(comment.id), json={"body": body}, headers=auth_headers_for(reader_user)
        )

        assert response.status_code == 422, response.text
        assert_field_error(response.json(), "body")

    async def test_a_non_owner_is_refused_and_the_comment_is_untouched(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        other_author_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """AAP 0.9.4.4: a non-owner, non-administrator edit is a 403 - and writes nothing.

        The second half is what makes this a security test rather than a status-code test. A route
        that refused and wrote anyway would satisfy the first assertion, so the comment is read back
        afterwards and shown to hold its original body and its original moderation state.
        """
        post = await visible_post(db_session, author_user)
        (comment,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["belongs to the reader"]
        )

        response = await client.patch(
            _comment_path(comment.id),
            json={"body": "hijacked"},
            headers=auth_headers_for(other_author_user),
        )

        assert response.status_code == 403, response.text
        assert_problem(
            response.json(),
            status=403,
            problem_type=PROBLEM_TYPE_FORBIDDEN,
            instance=_comment_path(comment.id),
        )

        unchanged = await client.get(_thread_path(post.id))
        assert unchanged.status_code == 200, unchanged.text
        assert bodies_of(unchanged.json()["items"]) == ["belongs to the reader"]
        assert unchanged.json()["items"][0]["status"] == CommentStatus.APPROVED.value

    async def test_the_posts_author_is_not_thereby_the_comments_owner(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """Seeing every state on one's own post is not authority to rewrite someone else's words.

        Worth asserting because the two rules are deliberately different: visibility widens for the
        post's author, while mutation is scoped by ``ensure_can_modify`` to the comment's own author
        or an administrator. Conflating them would let an author silently edit criticism.
        """
        post = await visible_post(db_session, author_user)
        (comment,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["a reader's opinion"]
        )

        response = await client.patch(
            _comment_path(comment.id),
            json={"body": "rewritten by the article's author"},
            headers=auth_headers_for(author_user),
        )

        assert response.status_code == 403, response.text
        assert_problem(response.json(), status=403, problem_type=PROBLEM_TYPE_FORBIDDEN)

        unchanged = await client.get(_thread_path(post.id))
        assert bodies_of(unchanged.json()["items"]) == ["a reader's opinion"]
        assert unchanged.json()["items"][0]["status"] == CommentStatus.APPROVED.value

    async def test_an_administrator_may_edit_any_comment(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        admin_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """The only principal that crosses an ownership boundary, enforced server-side."""
        post = await visible_post(db_session, author_user)
        (comment,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["needs a correction"]
        )

        response = await client.patch(
            _comment_path(comment.id),
            json={"body": "corrected by an administrator"},
            headers=auth_headers_for(admin_user),
        )

        assert response.status_code == 200, response.text
        assert response.json()["body"] == "corrected by an administrator"
        # The author is unchanged: an administrative edit does not reassign authorship.
        assert response.json()["author"]["id"] == str(reader_user.id)

    async def test_an_unauthenticated_edit_is_refused_with_a_bearer_challenge(
        self, client: AsyncClient, db_session: AsyncSession, author_user: User, reader_user: User
    ) -> None:
        """No credential, no mutation - the challenge names the scheme the client must use."""
        post = await visible_post(db_session, author_user)
        (comment,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["public but not editable"]
        )

        response = await client.patch(_comment_path(comment.id), json={"body": "anonymous edit"})

        assert response.status_code == 401, response.text
        assert response.headers["www-authenticate"] == "Bearer"
        assert_problem(response.json(), status=401, problem_type=PROBLEM_TYPE_UNAUTHORIZED)

        unchanged = await client.get(_thread_path(post.id))
        assert bodies_of(unchanged.json()["items"]) == ["public but not editable"]

    async def test_an_unknown_comment_is_reported_as_not_found(
        self, client: AsyncClient, reader_user: User, auth_headers_for: HeaderFactory
    ) -> None:
        """Reported before authority is considered, so an unactionable comment looks absent."""
        response = await client.patch(
            _comment_path(ABSENT_UUID),
            json={"body": "editing a ghost"},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == 404, response.text
        assert_problem(
            response.json(),
            status=404,
            problem_type=PROBLEM_TYPE_NOT_FOUND,
            instance=_comment_path(ABSENT_UUID),
        )

    async def test_a_malformed_comment_identifier_is_a_validation_error(
        self, client: AsyncClient, reader_user: User, auth_headers_for: HeaderFactory
    ) -> None:
        """A non-UUID in the path is a 422 naming ``comment_id``, never a 500."""
        response = await client.patch(
            _comment_path(MALFORMED_UUID),
            json={"body": "editing nonsense"},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == 422, response.text
        assert response.status_code < 500
        assert_field_error(response.json(), "comment_id")

    async def test_hostile_markup_is_neutralised_on_edit_too(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """The replacement is sanitised by the same policy creation uses."""
        post = await visible_post(db_session, author_user)
        (comment,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["harmless"]
        )

        response = await client.patch(
            _comment_path(comment.id),
            json={"body": HOSTILE_BODY},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == 200, response.text
        stored = response.json()["body"]
        for fragment in FORBIDDEN_FRAGMENTS:
            assert fragment not in stored.lower(), f"{fragment!r} survived an edit: {stored!r}"

    async def test_a_body_that_sanitises_to_nothing_is_refused(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """Markup with no text behind it leaves no comment, so it is a 422 rather than an empty row.

        ``_sanitize_body`` measures the *visible* text after cleaning, which is why a body that
        satisfies the length bound before sanitisation can still be refused after it.
        """
        post = await visible_post(db_session, author_user)
        (comment,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["real words"]
        )

        response = await client.patch(
            _comment_path(comment.id),
            json={"body": '<img src="x"><br><hr>'},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == 422, response.text
        assert_problem(response.json(), status=422, problem_type=PROBLEM_TYPE_VALIDATION)
        assert_field_error(response.json(), "body")

    async def test_the_edited_comment_is_returned_with_its_reply_tree(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        other_author_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """``replies`` is a statement about the thread, never an empty placeholder.

        The response carries the edited comment *with* its visible reply tree, narrowed to the
        states this caller may see, so replacing a cached thread node with it preserves the
        discussion beneath rather than blanking it.
        """
        post = await visible_post(db_session, author_user)
        (parent,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["the parent"]
        )
        await factories.create_comment(
            db_session,
            post=post,
            author=other_author_user,
            parent=parent,
            status=CommentStatus.APPROVED,
            body="an approved answer",
        )
        await factories.create_comment(
            db_session,
            post=post,
            author=other_author_user,
            parent=parent,
            status=CommentStatus.PENDING,
            body="a queued answer",
        )

        response = await client.patch(
            _comment_path(parent.id),
            json={"body": "the parent, revised"},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == 200, response.text
        payload = response.json()
        assert_comment_public(payload)
        assert bodies_of(payload["replies"]) == ["an approved answer"]
        assert "a queued answer" not in response.text


class TestDeleteCommentAndCascade:
    """``DELETE /api/v1/comments/{comment_id}`` - "delete" in AAP R4, plus AAP 0.10.1 standard 3.

    Deletion is final and is deliberately not the moderation tool: a comment that should stop being
    public without ceasing to exist is moved through the administrative status route instead, which
    keeps the decision reversible and the author's history intact.
    """

    async def test_the_author_may_delete_their_own_comment(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """204 with no body at all, and the comment leaves the thread."""
        post = await visible_post(db_session, author_user)
        doomed, surviving = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["to be removed", "to be kept"]
        )

        response = await client.delete(
            _comment_path(doomed.id), headers=auth_headers_for(reader_user)
        )

        assert response.status_code == 204, response.text
        # No acknowledgement object and no prose envelope: nothing for a client to parse or merge.
        assert response.content == b""

        listing = await client.get(_thread_path(post.id))
        assert listing.status_code == 200, listing.text
        assert_page(listing.json(), total=1, page=MIN_PAGE, page_size=DEFAULT_PAGE_SIZE)
        assert ids_of(listing.json()["items"]) == [str(surviving.id)]

    async def test_an_administrator_may_delete_any_comment(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        admin_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """The administrator crosses the ownership boundary here exactly as they do on edit."""
        post = await visible_post(db_session, author_user)
        (comment,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["written by somebody else"]
        )

        response = await client.delete(
            _comment_path(comment.id), headers=auth_headers_for(admin_user)
        )

        assert response.status_code == 204, response.text
        assert await comment_ids_present(db_session, [comment.id]) == set()

    async def test_a_non_owner_is_refused_and_the_comment_survives(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        other_author_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """AAP 0.9.4.4 and standard 6: a 403, and the row is still there afterwards.

        The survival half is the point. A handler that answered 403 after issuing the DELETE would
        pass a status-code-only assertion, so the comment is read back through the public thread and
        shown to be intact.
        """
        post = await visible_post(db_session, author_user)
        (comment,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["not yours to remove"]
        )

        response = await client.delete(
            _comment_path(comment.id), headers=auth_headers_for(other_author_user)
        )

        assert response.status_code == 403, response.text
        assert_problem(
            response.json(),
            status=403,
            problem_type=PROBLEM_TYPE_FORBIDDEN,
            instance=_comment_path(comment.id),
        )

        listing = await client.get(_thread_path(post.id))
        assert ids_of(listing.json()["items"]) == [str(comment.id)]
        assert bodies_of(listing.json()["items"]) == ["not yours to remove"]

    async def test_an_unauthenticated_delete_is_refused_with_a_bearer_challenge(
        self, client: AsyncClient, db_session: AsyncSession, author_user: User, reader_user: User
    ) -> None:
        """A public read does not imply a public delete."""
        post = await visible_post(db_session, author_user)
        (comment,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["readable by anyone"]
        )

        response = await client.delete(_comment_path(comment.id))

        assert response.status_code == 401, response.text
        assert response.headers["www-authenticate"] == "Bearer"
        assert_problem(response.json(), status=401, problem_type=PROBLEM_TYPE_UNAUTHORIZED)
        assert await comment_ids_present(db_session, [comment.id]) == {comment.id}

    async def test_an_unknown_comment_is_reported_as_not_found(
        self, client: AsyncClient, reader_user: User, auth_headers_for: HeaderFactory
    ) -> None:
        """Deleting something that is not there is a 404 problem document, not a silent 204."""
        response = await client.delete(
            _comment_path(ABSENT_UUID), headers=auth_headers_for(reader_user)
        )

        assert response.status_code == 404, response.text
        assert_problem(
            response.json(),
            status=404,
            problem_type=PROBLEM_TYPE_NOT_FOUND,
            instance=_comment_path(ABSENT_UUID),
        )

    async def test_a_malformed_comment_identifier_is_a_validation_error(
        self, client: AsyncClient, reader_user: User, auth_headers_for: HeaderFactory
    ) -> None:
        """A non-UUID in the path is a 422 naming ``comment_id``, never a 500."""
        response = await client.delete(
            _comment_path(MALFORMED_UUID), headers=auth_headers_for(reader_user)
        )

        assert response.status_code == 422, response.text
        assert response.status_code < 500
        assert_field_error(response.json(), "comment_id")

    async def test_deleting_a_parent_removes_every_reply_beneath_it(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        other_author_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """AAP 0.9.4.4 and 0.10.1 standard 3: the self-referencing cascade, proved at the row level.

        Removal is performed by PostgreSQL, through ``fk_comments_parent_id_comments`` declared
        ``ON DELETE CASCADE`` in revision ``0001``, and it is *recursive* - a grandchild goes with
        the child. ``app.services.comment_service`` deletes no reply in Python, and
        ``Comment.replies`` carries ``passive_deletes=True`` so that SQLAlchemy will not either:
        were the constraint dropped, orphaned replies would accumulate in silence and a
        204-only assertion would still pass.

        The rows are counted through ``db_session`` **before** the delete as well as after, which
        is the negative control. Without it a pass could be produced by replies that were never
        created in the first place. The replies are never removed by hand for the same reason:
        doing so would destroy the thing under test.
        """
        post = await visible_post(db_session, author_user)
        parent, bystander = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["the parent", "an unrelated thread"]
        )
        children = [
            await factories.create_comment(
                db_session,
                post=post,
                author=other_author_user,
                parent=parent,
                status=CommentStatus.APPROVED,
                body=f"child {index}",
            )
            for index in range(2)
        ]
        grandchild = await factories.create_comment(
            db_session,
            post=post,
            author=reader_user,
            parent=children[0],
            status=CommentStatus.APPROVED,
            body="grandchild",
        )
        thread_ids = [parent.id, *(child.id for child in children), grandchild.id]

        # Negative control: every row under test genuinely exists before anything is deleted.
        assert await comment_ids_present(db_session, thread_ids) == set(thread_ids)

        response = await client.delete(
            _comment_path(parent.id), headers=auth_headers_for(reader_user)
        )

        assert response.status_code == 204, response.text
        # Only the parent was addressed; the database removed the two children and the grandchild.
        assert await comment_ids_present(db_session, thread_ids) == set()
        # And the cascade is scoped to the subtree, not to the post.
        assert await comment_ids_present(db_session, [bystander.id]) == {bystander.id}

        listing = await client.get(_thread_path(post.id))
        assert_page(listing.json(), total=1, page=MIN_PAGE, page_size=DEFAULT_PAGE_SIZE)
        assert ids_of(listing.json()["items"]) == [str(bystander.id)]

    async def test_deleting_a_reply_leaves_its_parent_standing(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """The cascade runs downwards only: removing an answer does not remove the question."""
        post = await visible_post(db_session, author_user)
        (parent,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["the question"]
        )
        reply = await factories.create_comment(
            db_session,
            post=post,
            author=reader_user,
            parent=parent,
            status=CommentStatus.APPROVED,
            body="the answer",
        )

        response = await client.delete(
            _comment_path(reply.id), headers=auth_headers_for(reader_user)
        )

        assert response.status_code == 204, response.text
        assert await comment_ids_present(db_session, [parent.id, reply.id]) == {parent.id}

        listing = await client.get(_thread_path(post.id))
        assert ids_of(listing.json()["items"]) == [str(parent.id)]
        assert listing.json()["items"][0]["replies"] == []

    async def test_deleting_a_comment_leaves_the_post_and_the_accounts_intact(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """The cascade points from ``comments`` towards its parents, never back up the references.

        ``comments.post_id`` and ``comments.author_id`` cascade *from* the post and the account, so
        deleting a comment must leave both untouched. Asserting it here rules out an over-broad
        constraint that would make one reader's deleted remark take an article with it.
        """
        post = await visible_post(db_session, author_user)
        (comment,) = await approved_thread(
            db_session, post=post, author=reader_user, bodies=["a passing remark"]
        )

        response = await client.delete(
            _comment_path(comment.id), headers=auth_headers_for(reader_user)
        )

        assert response.status_code == 204, response.text
        posts = await db_session.execute(select(Post.id).where(Post.id == post.id))
        assert posts.scalars().all() == [post.id]
        accounts = await db_session.execute(
            select(User.id).where(User.id.in_([author_user.id, reader_user.id]))
        )
        assert set(accounts.scalars().all()) == {author_user.id, reader_user.id}

        # The post is still readable and its thread is simply empty now.
        listing = await client.get(_thread_path(post.id))
        assert listing.status_code == 200, listing.text
        assert_page(listing.json(), total=0, page=MIN_PAGE, page_size=DEFAULT_PAGE_SIZE)


class TestDraftPostInteraction:
    """The consequence of ``can_view_post``: a thread is exactly as visible as its post.

    ``comment_service`` imports that predicate from ``app.services.post_service`` rather than
    re-deriving it, so the draft rule is declared **once** across posts, comments and likes - a leak
    here would be a single-predicate bug rather than three independent ones, which is why these
    tests are worth writing even though they overlap conceptually with ``test_posts_api.py``.
    ``backend/tests/unit/test_permissions.py`` targets the predicate directly and is not duplicated:
    what is asserted here is only its consequence at the HTTP boundary.

    Every refusal is a **404**, never a 403. Answering 403 would confirm that the identifier
    addresses something real, which is how an unauthorised caller enumerates identifiers by reading
    status codes - so a draft somebody else owns is reported exactly as a missing post.
    """

    async def test_a_third_party_cannot_comment_on_a_draft_they_cannot_see(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """An authenticated caller who is neither the author nor an administrator receives 404."""
        draft = await factories.create_post(db_session, author=author_user, status=PostStatus.DRAFT)

        response = await client.post(
            _thread_path(draft.id),
            json={"body": "commenting on an unpublished article"},
            headers=auth_headers_for(reader_user),
        )

        assert response.status_code == 404, response.text
        assert_problem(
            response.json(),
            status=404,
            problem_type=PROBLEM_TYPE_NOT_FOUND,
            instance=_thread_path(draft.id),
        )

    async def test_an_anonymous_caller_cannot_list_a_draft_thread(
        self, client: AsyncClient, db_session: AsyncSession, author_user: User, reader_user: User
    ) -> None:
        """Reading is refused with the same 404, and no comment body leaks into the response."""
        draft = await factories.create_post(db_session, author=author_user, status=PostStatus.DRAFT)
        await approved_thread(
            db_session, post=draft, author=reader_user, bodies=["a private conversation"]
        )

        response = await client.get(_thread_path(draft.id))

        assert response.status_code == 404, response.text
        assert_problem(response.json(), status=404, problem_type=PROBLEM_TYPE_NOT_FOUND)
        assert "a private conversation" not in response.text

    async def test_an_archived_post_is_equally_closed_to_a_third_party(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """``can_view_post`` admits ``PUBLISHED`` only, so an archived post closes its thread."""
        archived = await factories.create_post(
            db_session, author=author_user, status=PostStatus.ARCHIVED
        )

        created = await client.post(
            _thread_path(archived.id),
            json={"body": "commenting on an archived article"},
            headers=auth_headers_for(reader_user),
        )
        assert created.status_code == 404, created.text

        listed = await client.get(_thread_path(archived.id))
        assert listed.status_code == 404, listed.text

    async def test_the_drafts_author_may_comment_on_and_list_their_own_draft(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """The author can rehearse a discussion on an unpublished article."""
        draft = await factories.create_post(db_session, author=author_user, status=PostStatus.DRAFT)
        headers = auth_headers_for(author_user)

        created = await client.post(
            _thread_path(draft.id), json={"body": "a note to myself"}, headers=headers
        )
        assert created.status_code == 201, created.text
        assert_comment_public(created.json())
        assert created.json()["post_id"] == str(draft.id)

        listed = await client.get(_thread_path(draft.id), headers=headers)
        assert listed.status_code == 200, listed.text
        # The author of the post sees every state, so their own PENDING comment is listed here -
        # which is the same widening asserted in TestModerationVisibility, seen on a draft.
        assert_page(listed.json(), total=1, page=MIN_PAGE, page_size=DEFAULT_PAGE_SIZE)
        assert bodies_of(listed.json()["items"]) == ["a note to myself"]

    async def test_an_administrator_may_comment_on_and_list_a_draft(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
        reader_user: User,
        admin_user: User,
        auth_headers_for: HeaderFactory,
    ) -> None:
        """An administrator sees any post, so the administrative view of a thread is complete."""
        draft = await factories.create_post(db_session, author=author_user, status=PostStatus.DRAFT)
        await approved_thread(
            db_session, post=draft, author=reader_user, bodies=["already on the draft"]
        )
        headers = auth_headers_for(admin_user)

        created = await client.post(
            _thread_path(draft.id), json={"body": "an administrative note"}, headers=headers
        )
        assert created.status_code == 201, created.text

        listed = await client.get(_thread_path(draft.id), headers=headers)
        assert listed.status_code == 200, listed.text
        assert_page(listed.json(), total=2, page=MIN_PAGE, page_size=DEFAULT_PAGE_SIZE)
        assert set(bodies_of(listed.json()["items"])) == {
            "already on the draft",
            "an administrative note",
        }
