"""Three routes over one row of two columns: like, unlike, and the settled summary of both.

The like half of **R4**, and deliberately the smallest domain module in this package. What makes
it small is where its correctness lives: ``post_likes`` is keyed on ``(post_id, user_id)``, so a
repeated like is absorbed by the primary key rather than detected by a branch, and nearly every
line this module does *not* contain is a line that would have restated that guarantee in Python.

The composed surface
--------------------
This file writes relative paths and nothing else. ``app.api.v1.router`` attaches the ``/posts``
path segment and the ``likes`` OpenAPI tag on the single ``include_router`` call that mounts
:data:`router`, and ``app.main`` mounts that aggregate under ``/api/v1``. The three operations a
client sees are therefore:

``PUT /api/v1/posts/{post_id}/like``
    :func:`like_post` - bearer credential required. Records that the calling account likes the
    post, and answers with the settled summary.
``DELETE /api/v1/posts/{post_id}/like``
    :func:`unlike_post` - bearer credential required. Withdraws that like, and answers with the
    settled summary. It returns a body rather than ``204``; see below.
``GET /api/v1/posts/{post_id}/likes``
    :func:`read_like_summary` - **public**. Reports the count, and for a caller who presented a
    credential, whether they are one of the accounts counted in it.

Singular ``/like``, plural ``/likes``: not a typo
-------------------------------------------------
The two mutations address ``/like`` and the read addresses ``/likes``, exactly as the endpoint
reference specifies, and the difference is the resource each one names. ``/like`` is a singular
sub-resource - *the caller's own like* - which is why neither mutation carries a body: the post
arrives in the path and the account arrives from the resolved principal, so there is no third
value for a client to supply and no parameter through which it could name an account other than
its own. ``/likes`` is the aggregate over every account's like, which is what makes it public
information and what makes a plural noun the honest name for it.

One response model, on all three routes
---------------------------------------
Every operation here declares ``response_model=LikeSummary``: the same three members -
``post_id``, ``like_count``, ``liked_by_caller`` - from the read and from both writes. That is
what lets the post page's like control settle an optimistic update in a single round trip instead
of writing and then reading back, and it is why unliking answers ``200`` with a body rather than
``204 No Content``: there is a settled value to report, so the response reports it.

The alternatives were considered and each is wrong for this surface. A bare acknowledgement - the
``message``-and-``data`` envelope the single-module service this repository grew out of wrapped
around three of its five routes, while its two reads returned bare payloads - would leave the
reader looking at the client's arithmetic rather than the database's count, and would reintroduce
the very inconsistency that shape is being deleted for. A bare integer cannot carry
``liked_by_caller`` at all. And ``204`` would oblige a client to issue a second request to learn
the number the first request had just changed.

The read is public, and still caller-aware
------------------------------------------
:func:`read_like_summary` depends on ``OptionalUser``, **not** ``CurrentUser``, and that is a
product decision rather than a convenience. A like count is public information on a site whose
whole purpose is public reading, so requiring a bearer token to read it would blank the tally on
every post page for every visitor who is not signed in - a silent defect, because the endpoint
would still be perfectly correct for the one audience that happened to be testing it.
``liked_by_caller`` is simply ``False`` for an anonymous caller - never ``null``, never absent -
so one shape serves both audiences and a client never has to tell "no session" apart from "has
not liked this". The layer below is built for it too: the caller-state aggregate is skipped
entirely when there is no principal, so the anonymous path costs less rather than failing.

The two mutations depend on ``CurrentUser`` for the mirror-image reason. A like is an act
attributed to an account, so there has to be an account; an anonymous caller is rejected with
``401`` by the dependency, before any handler body in this file runs.

Idempotency is structural, so there is no de-duplication to read
----------------------------------------------------------------
``PUT``, not ``POST``, and the verb is load-bearing. ``PostLike`` carries no surrogate key: its
primary key *is* the pair ``(post_id, user_id)``, and ``LikeRepository`` writes through a
conflict-ignoring insert. Measured rather than assumed - two identical inserts against PostgreSQL
18.4 left the row count at **one**. So liking a post a second time is not an error, not a conflict
and not a second row; the request settles on the end state the caller asked for, which is
precisely what ``PUT`` promises and ``POST`` does not. A retry after a timeout, a duplicate
delivered by a proxy and an impatient double-click are all safe by construction.

Consequently there is no look-before-you-write read anywhere in this file, no branch on whether
the account had liked the post beforehand, no integrity-error handler and no de-duplication of any
kind. Their absence is the design rather than an oversight, and a pre-flight read would in fact be
strictly worse than the single statement: two statements have a window between them, and two
concurrent requests can both find nothing in it.

``DELETE`` mirrors that. Withdrawing a like that was never granted removes nothing, raises
nothing, and answers with the same summary a successful withdrawal would. Failing instead would
leak, through a status code, whether an account had liked a post - a fact this API reports to that
account about itself and to nobody else.

What this module does not do
----------------------------
It declares routes, wires dependencies, and returns what a service handed back. Nothing else:

* **No data access.** No statement, no session call, no ORM traversal, no mapped class, and the
  repository layer is not imported. ``LikeRepository`` owns the conflict-ignoring insert, the
  matching delete and the aggregate; ``LikeService`` owns the visibility gate, the transaction
  boundary and the assembly of the summary.
* **No counting in Python.** ``like_count`` arrives from a SQL aggregate over a relation whose
  primary key forbids duplicate rows. Totalling anything here would be a second, weaker copy of a
  number the database is authoritative for.
* **No framework exception.** The service this repository grew out of raised the same inline
  ``404`` in three of its five handlers. Here :class:`~app.services.like_service.LikeService`
  raises the typed :class:`~app.core.exceptions.NotFoundError`, the principal dependency raises
  :class:`~app.core.exceptions.UnauthorizedError`, and the handlers ``app.main`` registers once
  render either as the single problem document this API returns for every failure.
* **No visibility check.** A post the caller may not see - somebody else's draft - must be
  neither likeable nor countable. ``LikeService`` resolves that through ``can_view_post``,
  declared once in ``app.services.post_service``, and reports it as ``404`` rather than ``403`` so
  that a draft's presence is never disclosed.
* **No request model, and no model declared here at all.** ``LikeSummary`` comes from the
  ``app.schemas`` barrel, and the failure shape comes from
  :func:`~app.schemas.common.problem_response` rather than being named here; this file declares
  no wire shape of its own.
* **No sharing endpoint.** Social sharing is the third element of R4 and needs no route: the
  client builds every share target from the post's canonical URL. There is nothing to add for it
  here, and nothing to add for it anywhere.

Nothing is logged here
----------------------
There is no logger in this module, and that is a decision rather than an omission. ``LikeService``
records each like and unlike at ``debug`` with the post, the account and whether a row actually
changed - the one place that last fact is knowable, since after the statement the two outcomes are
indistinguishable in the data - and ``app.middleware.request_context`` emits one structured access
record per request carrying the status, the path, the duration and the bound ``request_id``. A line
here would duplicate one of those two, and it would sit on the hot path of the highest-frequency
reader interaction in the product.

Governing standards
-------------------
``review_rules`` reports that this project specifies no user rules, so none governs this file. The
self-imposed standards the repository holds itself to stand in their place, and six of them decide
the shape of this module: *layered separation of concerns*, which is why no statement and no
session call appears below; *explicit API contracts*, which is why all three routes declare a
``response_model`` and declare every failure they can produce - each one against the single
problem document, through the shared helper; *API versioning*, which is why :data:`router` is
bare and the version namespace is attached by the aggregate that includes it;
*secure-by-default authentication*, which is why the two writes require a principal and the read
deliberately does not; *server-owned identity*, which is why no route here accepts a body; and
*blocking quality gates*, which is why ``ruff``, ``mypy`` and
``tests/integration/test_likes_api.py`` all have to pass on it.
"""

from typing import Final
from uuid import UUID

from fastapi import APIRouter, status

from app.core.dependencies import OPTIONAL_AUTHENTICATION, CurrentUser, DbSession, OptionalUser
from app.schemas import LikeSummary, ProblemResponses, problem_response
from app.services import LikeService

__all__ = ["router"]


# ---------------------------------------------------------------------------------------
# The failure documents these routes can produce
#
# The wording lives in a named constant rather than inline in a decorator argument, because
# the 404 description is used by all three operations and three copies of a sentence is how
# two of them stop matching. Every entry is built by
# `app.schemas.common.problem_response`, which is the one place in this package that names
# the problem document and the one place its published media type is decided: without a model
# the failure mode is undocumented and a generated client emits no type for it, which is
# precisely the gap the "every route declares its shapes" standard closes.
#
# The declared set per route is exactly what that route can PRODUCE - which means a reachable
# status is never omitted on the grounds that it is unusual. All three operations declare 422,
# because `post_id` is a validated path parameter and an unnamed 422 is generated against
# FastAPI's own `HTTPValidationError` shape rather than this API's. The two mutations declare
# 403, because a deactivated account is refused by the shared principal dependency. And the
# read declares 401, because an optional principal tolerates an ABSENT credential and not an
# unusable one.
# ---------------------------------------------------------------------------------------

_UNAUTHORIZED_DESCRIPTION: Final[str] = (
    "No usable bearer credential was presented, so there is no account to attribute the like to. "
    "Absent, malformed, expired and wrong-type credentials are all reported this way. The body is "
    "the same problem document every other failure in this API returns, with `type` set to "
    "`/errors/unauthorized`, and the response carries a `WWW-Authenticate: Bearer` challenge."
)
"""``description`` of the 401 on the two mutations, published verbatim in the generated document.

It names the condition rather than which of its causes applied, matching the credential resolver's
own contract: a client that cannot authenticate has one remedy - obtain a fresh credential - and
telling it *why* the presented one was unusable narrows an attacker's search without helping a
legitimate caller.
"""

_UNAUTHORIZED_ON_READ_DESCRIPTION: Final[str] = (
    "A credential was presented and could not be used - malformed, expired, of the wrong token "
    "type, or naming an account that no longer exists. Omitting the `Authorization` header "
    "entirely is **not** an error here: an anonymous caller receives the count with "
    "`liked_by_caller` set to `false`. An unusable credential is refused rather than degraded to "
    "anonymous, because degrading it would report `liked_by_caller: false` to a caller who has "
    "in fact liked the post and would hide the expired session from the client that must renew "
    "it. Refresh the access token and retry, or omit the header."
)
"""``description`` of the 401 on the read.

Declared rather than dismissed as a client defect. The status is reachable, its body is the
problem document, and a client that cannot tell "your token has expired" from "this post has no
likes" cannot recover from the first.
"""

_FORBIDDEN_DESCRIPTION: Final[str] = (
    "The account has been deactivated. Liking requires no role - any authenticated principal may "
    "like any post it can see - so deactivation is the only state that produces this status here, "
    "and it is raised by the shared principal dependency before the handler is entered. "
    "Re-authenticating will not clear it."
)
"""``description`` of the 403 on the two mutations.

Reachable and therefore declared. It was previously left to prose on the grounds that the *shape*
was documented elsewhere, which is not the same thing: a client branches on status codes, and an
undeclared status is one it was never written to handle.
"""

_VALIDATION_FAILED_DESCRIPTION: Final[str] = (
    "`post_id` is not a UUID. That is the only input any of these three operations takes - none "
    "of them accepts a body or a query parameter - so it is the only way a request here fails "
    "validation. The problem document's `errors` array names the offending path parameter."
)
"""``description`` of the 422 shared by all three operations.

Named here rather than left to the framework, whose generated entry points at its own
``HTTPValidationError`` shape - a body this service never returns, because
``register_exception_handlers`` renders a request-validation failure as the same problem document
as every other failure.
"""

_NOT_FOUND_DESCRIPTION: Final[str] = (
    "No post carries that identifier, or it is an unpublished post this caller may not see. The "
    "two cases are reported identically and deliberately: distinguishing them would disclose to "
    "somebody not entitled to read a draft that the draft is there, so an invisible post is "
    "absent as far as this surface is concerned. A caller who cannot see a post can neither like "
    "it nor read its like count."
)
"""``description`` of the 404 shared by all three operations.

Shared because the condition is genuinely one condition, resolved in one place: every method on
:class:`~app.services.like_service.LikeService` opens by loading a post the caller is entitled to
know about, and reports both absence and invisibility through the same
:class:`~app.core.exceptions.NotFoundError` with the same detail. Three separately worded
descriptions would imply three separately reachable states.
"""


# ---------------------------------------------------------------------------------------
# The response mappings
#
# Two, not three: the two mutations fail identically to each other, and the read differs from
# them in exactly two places - its 401 tolerates an absent credential, and it has no 403
# because it requires no principal at all. Typed explicitly rather than inferred, so a wrong
# shape is a type error here instead of a startup assertion inside the framework.
# ---------------------------------------------------------------------------------------

_MUTATION_RESPONSES: Final[ProblemResponses] = {
    status.HTTP_401_UNAUTHORIZED: problem_response(_UNAUTHORIZED_DESCRIPTION),
    status.HTTP_403_FORBIDDEN: problem_response(_FORBIDDEN_DESCRIPTION),
    status.HTTP_404_NOT_FOUND: problem_response(_NOT_FOUND_DESCRIPTION),
    status.HTTP_422_UNPROCESSABLE_CONTENT: problem_response(_VALIDATION_FAILED_DESCRIPTION),
}
"""Documented failures of ``PUT`` and ``DELETE`` on ``/{post_id}/like``.

One mapping shared by both, because the two operations fail in exactly the same four ways and for
exactly the same four reasons. Note what is *not* in it: no ``409``, because a repeated like is
absorbed by the composite primary key rather than reported as a conflict, and no ``204``, because
both operations answer with the settled :class:`~app.schemas.like.LikeSummary`.
"""

_READ_RESPONSES: Final[ProblemResponses] = {
    status.HTTP_401_UNAUTHORIZED: problem_response(_UNAUTHORIZED_ON_READ_DESCRIPTION),
    status.HTTP_404_NOT_FOUND: problem_response(_NOT_FOUND_DESCRIPTION),
    status.HTTP_422_UNPROCESSABLE_CONTENT: problem_response(_VALIDATION_FAILED_DESCRIPTION),
}
"""Documented failures of ``GET /{post_id}/likes``.

No ``403``, and that absence *is* the contract: the read resolves an **optional** principal, so a
deactivated account is served as an anonymous caller rather than refused, and no role is
consulted. The ``401`` present beside it is not a contradiction - see
:data:`_UNAUTHORIZED_ON_READ_DESCRIPTION` for why an absent credential succeeds where an unusable
one is refused.
"""


# ---------------------------------------------------------------------------------------
# The router
#
# Bare, and that is the whole of its configuration. `app.api.v1.router` attaches the `/posts`
# path segment and the `likes` OpenAPI tag on the one call that includes this object, and
# `app.main` mounts that aggregate under `/api/v1`. Setting either here would put a second
# authority on the composed path, and the version namespace would become something a new
# route could leave by forgetting to opt in.
# ---------------------------------------------------------------------------------------

router = APIRouter()
"""The like router, reached as ``from app.api.v1.routers.likes import router``.

Bare by design: no path segment of its own, no OpenAPI tag and no router-level dependency. The
last of those three is worth stating, because a router-level principal requirement would be the
natural way to protect the two mutations and it would be wrong: it would apply to
:func:`read_like_summary` as well, and turn the public like count into a signed-in-only figure.
Authentication is therefore declared per operation, by the parameter each handler takes.

Never reached through the ``app.api.v1.routers`` package, which is an empty marker on purpose -
see its module docstring.
"""


@router.put(
    "/{post_id}/like",
    response_model=LikeSummary,
    status_code=status.HTTP_200_OK,
    responses=_MUTATION_RESPONSES,
    summary="Like a post",
    description=(
        "Records that the calling account likes this post, and answers with the settled like "
        "count and caller state. Idempotent: liking a post this account has liked before "
        "succeeds, writes no second row and leaves the count exactly where it was, because "
        "`post_likes` is keyed on `(post_id, user_id)`. The request is therefore safe to retry, "
        "to duplicate through a proxy and to double-click. There is no request body: the post "
        "comes from the path and the account from the bearer credential, so there is nothing "
        "left for a client to supply."
    ),
)
async def like_post(post_id: UUID, db: DbSession, user: CurrentUser) -> LikeSummary:
    """Attribute a like to the calling account and report the settled summary.

    Args:
        post_id: The post being liked, parsed from the path. A malformed identifier is rejected
            as a validation failure by the framework before this body runs, so every value that
            reaches here is a well-formed UUID - it just may not name a post the caller can see.
        db: The request-scoped session, from the one dependency in the service that yields one.
            Passed straight into the service, which is the only thing this handler does with it.
        user: The authenticated, active principal, and the sole source of the account identity
            written. An anonymous caller never reaches this line: the dependency answers ``401``
            first, and a deactivated account ``403``.

    Returns:
        The post's like count and ``liked_by_caller=True``, read after the write has been
        committed so the pair is what the database holds rather than what the client guessed.

    Raises:
        NotFoundError: Raised by the service when no post carries that identifier, or when it is
            an unpublished post this principal may not see. Rendered as ``404`` by the registered
            handler. This module raises nothing itself.

    Note:
        **Nothing is checked before the write, and nothing may be.** There is no read of the
        existing state, no branch on whether this account had liked the post beforehand and no
        integrity-error handler, because the composite primary key on ``(post_id, user_id)``
        makes the underlying conflict-ignoring insert idempotent - two identical inserts against
        PostgreSQL 18.4 left the count at one. A pre-flight read would add a race the key has
        eliminated: a read and an insert are two statements, and two concurrent requests can both
        find nothing between them.

        ``PUT`` rather than ``POST`` for exactly that reason. The method is what tells a client,
        a proxy and a retrying HTTP library that repeating the request cannot inflate the count.
    """
    return await LikeService(db).like(post_id, user=user)


@router.delete(
    "/{post_id}/like",
    response_model=LikeSummary,
    status_code=status.HTTP_200_OK,
    responses=_MUTATION_RESPONSES,
    summary="Remove a like from a post",
    description=(
        "Withdraws the calling account's like of this post, and answers with the settled like "
        "count and caller state. Idempotent in the same way as liking: withdrawing a like that "
        "was never granted removes nothing and succeeds anyway, so a client may retry freely. "
        "Answers `200` with a body rather than `204 No Content`, because there is a settled "
        "value to report and reporting it saves the caller a follow-up read. An account can "
        "withdraw only its own like; there is no parameter through which another could be named."
    ),
)
async def unlike_post(post_id: UUID, db: DbSession, user: CurrentUser) -> LikeSummary:
    """Withdraw the calling account's like and report the settled summary.

    Args:
        post_id: The post whose like is being withdrawn, parsed from the path.
        db: The request-scoped session, handed to the service unchanged.
        user: The authenticated, active principal, withdrawing its *own* like. Ownership is
            structural here rather than a rule to enforce: this identity is the only one the
            service is given, and no body or query parameter offers a way to name another.

    Returns:
        The post's like count and ``liked_by_caller=False``, read after the commit.

    Raises:
        NotFoundError: Raised by the service when no post carries that identifier, or when it is
            an unpublished post this principal may not see. Rendered as ``404``.

    Note:
        A like that was never granted is **not** an error, and this route must not be made to
        report one. Two reasons. It would leak, through a status code, whether an account had
        liked a post - a fact the API reports to that account about itself and to nobody else. And
        a client that applied the withdrawal optimistically would then have to tell "your guess
        was correct" apart from a genuine failure in order to decide whether to roll its own state
        back, a distinction it has no use for. Returning the settled summary makes the end state
        unambiguous either way.

        The ``200``-with-a-body shape is likewise deliberate, and is the one place in this API
        where a ``DELETE`` returns a representation. Logging out and deleting a category answer
        ``204`` because after them there is no settled value left to describe; after this one
        there is, and it is the number the reader is looking at.
    """
    return await LikeService(db).unlike(post_id, user=user)


@router.get(
    "/{post_id}/likes",
    response_model=LikeSummary,
    status_code=status.HTTP_200_OK,
    responses=_READ_RESPONSES,
    # Anonymous OR bearer, in that order. `OptionalUser` puts the bearer scheme in this
    # operation's dependency tree, and without this marker the framework would publish it as
    # REQUIRED - turning a public like count into a signed-in-only figure as far as a generated
    # client or the interactive documentation is concerned. See
    # `app.core.dependencies.OPTIONAL_AUTHENTICATION`.
    openapi_extra=OPTIONAL_AUTHENTICATION,
    summary="Read a post's like count",
    description=(
        "Reports how many distinct accounts have liked this post, and whether the caller is one "
        "of them. Public: no bearer credential is required, because a like count is public "
        "information, and `liked_by_caller` is `false` for an anonymous caller rather than null "
        "or absent. Presenting a credential widens nothing except that one member - the count is "
        "identical for every audience. Distinct by construction rather than by de-duplication: "
        "`post_likes` is keyed on `(post_id, user_id)`, so no repeated like can inflate the "
        "number."
    ),
)
async def read_like_summary(post_id: UUID, db: DbSession, viewer: OptionalUser) -> LikeSummary:
    """Report a post's like count, and whether this caller is included in it.

    Args:
        post_id: The post being asked about, parsed from the path.
        db: The request-scoped session, handed to the service unchanged.
        viewer: The resolved principal, or ``None`` for an anonymous caller. **Deliberately the
            optional dependency and not the mandatory one** - see the note below. Named
            ``viewer`` rather than ``user`` to match the service's own parameter, where the
            distinction is that a read is answered for whoever is looking while a write is
            attributed to somebody.

    Returns:
        The like count and ``liked_by_caller`` - ``True`` when this viewer has liked the post,
        ``False`` when they have not, and ``False`` when there is no viewer. ``0`` and ``False``
        for a post nobody has liked, which is the ordinary state of a newly published post rather
        than a special case worth its own status code.

    Raises:
        NotFoundError: Raised by the service when no post carries that identifier, or when it is
            an unpublished post this viewer may not see. An anonymous caller can see no draft at
            all, so a draft's like count is unreachable without a session: the count is public
            only for a post that is itself public.

    Note:
        **The optional principal is the point of this route.** Requiring a bearer token here
        would be a silent product defect rather than a loud failure - the endpoint would keep
        answering perfectly for a signed-in tester while every anonymous reader, which is most of
        the audience of a public blog, saw no tally on any post page. ``None`` is passed straight
        through to the service; no placeholder identifier is synthesised for it, and the layer
        below skips the caller-state aggregate entirely in that case, so the anonymous path is
        cheaper rather than degraded.

        No transaction is committed for a read. The session's transaction is ended by the
        dependency that yielded it when the request finishes.
    """
    return await LikeService(db).get_summary(post_id, viewer=viewer)
