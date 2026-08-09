"""The comment half of requirement R4: four routes, split across two router objects.

Reader-authored discussion is the one write path in this product that an unprivileged account can
reach, and this module is its entire HTTP surface::

    GET    /api/v1/posts/{post_id}/comments   one post's thread, paginated
    POST   /api/v1/posts/{post_id}/comments   add a comment, or a reply to one
    PATCH  /api/v1/comments/{comment_id}      correct a comment's text
    DELETE /api/v1/comments/{comment_id}      remove a comment and everything beneath it

Nothing else. There is no ``/comments/{id}/replies`` route, because threading is a property of the
*response shape* rather than of the route table - a thread arrives nested inside
``CommentPublic.replies`` - and there is no route here that changes a moderation state, for the
reason recorded under "Moderation is read-only from this module" below.

Two router objects, and why merging them breaks the aggregate
------------------------------------------------------------
This is the one module in the package that exports two ``APIRouter`` objects, and the split is
structural rather than stylistic. A comment's routes belong to two different path families:
reading and writing a thread are addressed *through the post that owns it*, while correcting or
removing one addresses the comment directly by its own identifier. Both objects are constructed
bare - neither names a path segment of its own and neither names an OpenAPI section - because
``app.api.v1.router`` owns both of those decisions for every module in this package:

* :data:`post_comments_router` is mounted beneath the post collection, so its two routes spell
  their paths relative to it, as ``/{post_id}/comments``.
* :data:`router` is mounted beneath the comment collection, so its two routes spell their paths
  relative to it, as ``/{comment_id}``.

The aggregate therefore makes **eight** ``include_router`` calls over **seven** modules, and this
file is the whole reason for that mismatch. Two consequences follow, and both are load-bearing:

1. **The two exported names are a contract.** The aggregate binds
   ``comments.post_comments_router`` and ``comments.router`` by those exact spellings. Renaming
   either, or collapsing the two into one object, makes the aggregate fail to import - which takes
   the entire application down at start-up rather than degrading a single route. Anyone tempted to
   tidy the pair into one object should start here.
2. **Both families are filed under one section.** They are two path families of a single feature,
   so the aggregate files all four operations under the same ``comments`` section of the generated
   document - the section ``app.main`` declares in its OpenAPI section metadata. A reader of
   ``/docs`` finds one description of the discussion feature rather than two halves of it filed
   apart.

What this module does, in full
-----------------------------
Resolve the principal through a dependency, hand the request to :class:`CommentService`, and
declare the shapes. That is all of it. Each of the four things it deliberately does *not* do
belongs to a layer that already declares it exactly once:

Threaded retrieval, and which moderation states are in scope
    ``CommentRepository`` issues one recursive statement and applies the caller's status filter at
    every level of the descent, so an unapproved reply cannot surface inside an approved parent.
    Nothing is filtered in Python here - not the page, not ``replies`` - because a second filter is
    a second thing to keep in step, and the copy written in Python is the one that gets forgotten.
Sanitisation
    :class:`CommentService` cleans a submitted body with ``bleach`` before anything is stored, and
    the client sanitises again where it renders. This module neither cleans the text nor assumes
    the caller did: it passes the validated payload straight through.
Authority
    "The author, or an administrator" is compared inside the service against the row it has
    already loaded, which is the only place that comparison can be made - it depends on the row.
    There is no inline ownership test below. A hidden control in the client is not a substitute for
    one either: hiding a button does not stop the request being sent.
Removing a subtree
    ``comments.parent_id`` is a self-referencing foreign key with ``ON DELETE CASCADE``, so a
    single statement removes a comment and every reply beneath it, at any depth. Nothing here walks
    a thread. That is the direct replacement for the hand-rolled ``items.pop(index)`` sweep the
    retired single-module service performed at ``app.py:L47``.

Moderation is read-only from this module
--------------------------------------
``CommentPublic`` publishes ``status`` so that an author can see their own comment is queued and a
moderation screen can render a state, and **no route here can change it.** The single mutation site
is ``PATCH /api/v1/admin/comments/{id}/status``, in ``app.api.v1.routers.admin``, behind an
administrator dependency the aggregate applies at router level so that no operation in that
namespace can omit it.

The omission is a security boundary rather than a missing convenience. A status route on an
unprivileged router would let a commenter approve their own comment, and let them approve a
replacement body afterwards - the same bypass reached twice. That is why neither the
administrative status body nor the status enumeration is imported below, and why neither input
model accepts a ``status`` member for one to travel in.

Why the two write routes build their response by hand
----------------------------------------------------
:meth:`CommentService.create` and :meth:`CommentService.update` both return a persistent comment
with its ``author`` loaded and its ``replies`` collection **deliberately left unloaded**, and the
service records that as a security property: the relationship is the raw ownership edge - one
generation, unfiltered by moderation state - so populating it would hand a caller exactly the
unfiltered collection that the repository's filtered recursive descent exists to prevent.

So neither handler returns the row for FastAPI to validate against its declared response model.
Validating the whole model would read ``replies``, which under an async session raises rather than
yielding an empty list, and the symptom arrives disguised - as a response-validation failure
several layers away from the access that caused it. Each handler instead builds ``CommentPublic``
member by member and omits ``replies``, so the field falls back to its empty default. That is also
the truthful answer: a comment that has just been written has no replies, and one whose text has
just been corrected did not change shape.

The construction is written out at both sites rather than factored into a shared helper, and the
reason is worth stating because the repetition looks accidental. A helper would have to name the
mapped ``Comment`` class in its signature, and **no ORM class is named anywhere in this file** -
which is the property that makes "this route performs no data access" checkable by reading the
import block alone. The two sites cannot drift apart in any case: the Pydantic type-checking
plugin is configured to type every constructor argument and to reject unknown ones, so a member
added to ``CommentPublic`` without a default fails the type gate at both call sites, and a
misspelled or surplus keyword fails at whichever site carries it.

A page of threads, not a page of comments
----------------------------------------
The listing route pages over **top-level** comments only - the rows whose ``parent_id`` is null -
each carrying the replies that answer it nested inside. ``total`` and ``pages`` therefore count
threads, and a reply is never a page member in its own right.

That is what makes consecutive pages disjoint. Were replies counted as members, a page boundary
could put a comment on one page and one of its own replies on the next, where it would be re-nested
under a parent the client had already rendered: the same reply would appear twice, and ``total``
would describe a set no client could reconstruct. The window is bounded by ``PageParams`` before
the handler is entered, and the page arithmetic is performed once, by ``build_page`` inside the
service, so nothing here re-derives it. A page past the last one is not an error - it answers 200
with an empty ``items`` list beside the real ``total`` and ``pages``, which is how a client detects
that it has run off the end.

One collection envelope, one error document
-----------------------------------------
Three shapes leave this module and no others: the page envelope for the collection, a bare
``CommentPublic`` for a single comment, and ``ProblemDetail`` for every failure. The retired
service did the opposite - it paired a sentence of prose with a nested payload on three of its five
routes (``app.py:L18``, ``L39``, ``L48``) while two returned bare payloads (``L23``, ``L30``), so a
client could not tell from a route which of the two it would receive - and that inconsistency is
deleted rather than relocated into this file.

No handler below raises a framework exception. The service raises the typed domain errors of
``app.core.exceptions`` and one registered handler renders each of them as the same problem
document, so the 404 that the retired service wrote out three separate times (``app.py:L31``,
``L40``, ``L49``) now has exactly one definition. The ordering of the two failure modes is fixed by
the service and is a confidentiality property rather than a matter of taste: a missing resource is
reported before authority is considered, and a resource the caller has no authority to know about
is reported the same way as one that does not exist. Commenting on a draft the caller cannot see is
therefore a 404 and never a 403, because a 403 would confirm that the draft exists.

The standards this file is held to
---------------------------------
``review_rules`` reports that this project supplies no user-specified rules, so none is invented
here and the self-imposed standards of the technical specification stand in their place. Six of
them decide the shape of this module: *explicit API contracts*, which is why three routes declare a
response model, the fourth documents an empty 204, and every failure status a caller can act on is
named; *API versioning*, which is why both router objects are bare and no decorator below writes
``/api/v1``; *layered separation of concerns*, which is why there is no statement, no session
query and no data-access import anywhere in this file; *secure-by-default authentication*, which is
why the three mutating routes require a resolved principal and why authority is re-checked in the
service; *server-owned identity*, which is why no input model carries an identifier and why the
post being commented on is taken from the path; and *blocking quality gates*, which is why
``ruff``, ``mypy`` and ``backend/tests/integration/test_comments_api.py`` all have to pass on it.
"""

from typing import Any, Final
from uuid import UUID

from fastapi import APIRouter, status

from app.api.v1.responses import OPTIONAL_AUTHENTICATION, ProblemResponses, problem_response
from app.core.dependencies import CurrentUser, DbSession, OptionalUser, PageParamsDep
from app.schemas import CommentCreate, CommentPublic, CommentUpdate, Page, UserPublic
from app.services import CommentService

__all__ = ["post_comments_router", "router"]


# ---------------------------------------------------------------------------------------
# The two routers
#
# Both bare. No path segment and no OpenAPI section is named on either object: `app.api.v1.router`
# attaches both when it includes them, which is what keeps `/api/v1` written in exactly one place
# and makes it impossible for a route added here later to escape the version namespace by
# forgetting it. `health` is the only module in this package that does otherwise, because
# `app.main` mounts it directly and unprefixed so that an orchestrator can probe the process
# before it knows which API version to speak.
#
# DO NOT MERGE THESE TWO OBJECTS. The aggregate binds both names; collapsing them is an
# application-wide start-up failure, not a local tidy-up. See the module docstring.
# ---------------------------------------------------------------------------------------

post_comments_router = APIRouter()
"""Routes addressed through the post that owns the thread, mounted beneath the post collection.

Carries ``GET`` and ``POST`` on ``/{post_id}/comments``, which compose to
``/api/v1/posts/{post_id}/comments``. Reached as
``from app.api.v1.routers.comments import post_comments_router``, and included by
``app.api.v1.router`` alongside - not instead of - :data:`router`."""

router = APIRouter()
"""Routes addressed by a comment's own identifier, mounted beneath the comment collection.

Carries ``PATCH`` and ``DELETE`` on ``/{comment_id}``, which compose to
``/api/v1/comments/{comment_id}``. Named ``router`` because that is the spelling every module in
this package uses for its principal object, and the aggregate relies on it."""


# ---------------------------------------------------------------------------------------
# Documented failure responses
#
# Declared as module constants rather than inline in a decorator, so each annotation is explicit
# rather than inferred from a literal nested in an argument, and so the two descriptions that are
# genuinely identical between routes have one definition instead of four.
#
# Every entry is built by `app.api.v1.responses.problem_response`, which is the single place in
# this package that names the one problem document this API returns for every failure at every
# status - and the single place its published media type is decided. Without a model the failure
# mode is undocumented and a generated client emits no type for it, which is precisely the gap
# the "every route declares its shapes" standard closes.
#
# The set declared per route is exactly what that route can PRODUCE. That cuts both ways: a
# status the route cannot emit advertises a branch no client can take, and a status it CAN emit
# but does not declare leaves a client with an undocumented body. Neither is acceptable, so a
# reachable status is never left to the route's prose - `POST /{post_id}/comments` declares 403
# and 409 for that reason, and `GET /{post_id}/comments` declares 401.
# ---------------------------------------------------------------------------------------

_UNAUTHORIZED: Final[dict[str, Any]] = problem_response(
    "No usable credential was presented. The `Authorization` header was absent or malformed, "
    "or the bearer token was expired, of the wrong type, or names an account that no longer "
    "exists. Writing to a discussion always requires a principal; reading one never does - "
    "though a credential *presented* on a read must still be usable."
)
"""The 401 entry, shared by the three routes that require authentication.

One description for one meaning. The condition is resolved by ``app.core.dependencies`` before a
handler below is entered, so it is identical on all three and is stated once."""

_UNAUTHORIZED_ON_READ: Final[dict[str, Any]] = problem_response(
    "A credential was presented and could not be used - absent is fine here, unusable is not. "
    "Reading a thread needs no credential at all, and an anonymous caller is served the "
    "approved comments; but a malformed, expired or wrong-type token is refused rather than "
    "silently degraded to anonymous, because degrading it would hide an expired session from "
    "the client that needs to renew it. Retry after refreshing, or omit the header entirely."
)
"""The 401 entry for the public listing route, whose principal is optional but not ignorable."""

_FORBIDDEN: Final[dict[str, Any]] = problem_response(
    "The credential is valid but does not permit this action: the caller neither wrote the "
    "comment nor holds the administrator role, or the account has been deactivated. The "
    "response never states which of those it was, and never states which role would have "
    "sufficed."
)
"""The 403 entry for the two routes whose authority is scoped to a row's owner."""

_FORBIDDEN_ON_CREATE: Final[dict[str, Any]] = problem_response(
    "The account has been deactivated. Commenting requires no *role* - a reader who "
    "registered a moment ago may join a discussion, which is why this is the only state that "
    "produces a 403 here - but a deactivated account holds no authority at all, and the "
    "shared principal dependency refuses it before the handler is entered."
)
"""The 403 entry on the create route, whose only forbidden state is deactivation.

Declared rather than left to prose. A client that sees this status needs to know the body it
carries and that re-authenticating will not clear it, and neither fact is available to it from a
sentence in the route description."""

_POST_NOT_FOUND: Final[dict[str, Any]] = problem_response(
    "No post carries that identifier, or the post is not visible to this caller. A draft "
    "someone else owns is reported exactly as a missing post: answering 403 would confirm "
    "that the identifier addresses something real, which is how an unauthorised caller "
    "enumerates identifiers by reading status codes."
)
"""The 404 entry for the two routes addressed through a post.

The thread of an invisible post is unreachable rather than merely empty - the post is resolved
before any comment statement is issued, so an empty page never stands in for a refusal."""

_COMMENT_NOT_FOUND: Final[dict[str, Any]] = problem_response(
    "No comment carries that identifier. Reported before authority is considered, so a comment "
    "the caller may not act on is indistinguishable from one that does not exist."
)
"""The 404 entry for the two routes addressed by a comment identifier."""


_LIST_RESPONSES: Final[ProblemResponses] = {
    status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED_ON_READ,
    status.HTTP_404_NOT_FOUND: _POST_NOT_FOUND,
    status.HTTP_422_UNPROCESSABLE_CONTENT: problem_response(
        "`post_id` is not a UUID, or `page` or `page_size` is outside its bounds - `page` at "
        "least 1, `page_size` between 1 and 100. A `page` beyond the last one is *not* one of "
        "these: it is a legitimate request answered with 200 and an empty `items` list."
    ),
}
"""Failures the listing route can answer with.

No 403: reading a thread requires no authority, and a deactivated account resolves as anonymous
on this route rather than being refused. The 401 is *not* a contradiction of that - see
:data:`_UNAUTHORIZED_ON_READ` for the difference between an absent credential and an unusable
one."""

_CREATE_RESPONSES: Final[ProblemResponses] = {
    status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED,
    status.HTTP_403_FORBIDDEN: _FORBIDDEN_ON_CREATE,
    status.HTTP_404_NOT_FOUND: _POST_NOT_FOUND,
    status.HTTP_409_CONFLICT: problem_response(
        "The thread changed underneath the insert: the post, the parent comment or the "
        "author's account was removed between the moment each was verified and the moment the "
        "row was written. Nothing is locked to prevent it, because taking a write lock on a "
        "whole post to add one comment would serialise a public, high-frequency operation "
        "against every other comment on the same article. A retry resolves it - and reports "
        "the now-settled state as a clean 404 if the post really is gone."
    ),
    status.HTTP_422_UNPROCESSABLE_CONTENT: problem_response(
        "The body did not satisfy its contract. Either `body` is missing, empty once trimmed, "
        "longer than 5000 characters, or sanitises to nothing; or the request carried a "
        "member the model forbids - `post_id`, `author_id`, `status` and `id` are all "
        "server-owned and none may be sent; or `parent_id` names a comment that does not "
        "exist, hangs off a different post, is not visible to this author, or already sits at "
        "the maximum reply depth. The `errors` array names the offending field."
    ),
}
"""Failures the create route can answer with, all five declared.

403 and 409 are both here because both are reachable, and a reachable status belongs in the
document rather than in prose: the first when the account has been deactivated, the second when
the thread changes underneath the insert. Neither is a *frequent* outcome, which is precisely why
a client is unlikely to have been written for it unless the contract says so."""

_UPDATE_RESPONSES: Final[ProblemResponses] = {
    status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED,
    status.HTTP_403_FORBIDDEN: _FORBIDDEN,
    status.HTTP_404_NOT_FOUND: _COMMENT_NOT_FOUND,
    status.HTTP_422_UNPROCESSABLE_CONTENT: problem_response(
        "`comment_id` is not a UUID, or the body did not satisfy its contract: `body` was sent "
        "as null, was empty once trimmed, exceeded 5000 characters or sanitised to nothing; or "
        "the request carried a member the model forbids. `status` and `parent_id` are among "
        "those - the first would be a moderation bypass on a route the comment's own author "
        "can reach, the second would silently re-parent a comment others have already replied "
        "within. Omitting `body` entirely is accepted and changes nothing."
    ),
}
"""Failures the edit route can answer with."""

_DELETE_RESPONSES: Final[ProblemResponses] = {
    status.HTTP_204_NO_CONTENT: {
        "description": (
            "The comment and every reply beneath it were removed. The response carries no body at "
            "all - no acknowledgement object, no prose envelope - so there is nothing for a client "
            "to parse and nothing for it to merge."
        ),
    },
    status.HTTP_401_UNAUTHORIZED: _UNAUTHORIZED,
    status.HTTP_403_FORBIDDEN: _FORBIDDEN,
    status.HTTP_404_NOT_FOUND: _COMMENT_NOT_FOUND,
    # Declared even though this route accepts no request body, and the reason is measured rather
    # than theoretical. `comment_id` is a validated path parameter, so FastAPI documents a 422 on
    # this operation whether or not one is named here - and the entry it generates unprompted
    # points at its own `HTTPValidationError` shape. That would put a SECOND error component into
    # the document for a failure this service actually renders as the one problem document, since
    # `app.core.exceptions` handles the request-validation error like every other failure. Naming
    # the status here replaces that generated entry, which is what keeps "every error response is
    # the same problem document" true of this route as well as of the other three, and keeps
    # `HTTPValidationError` out of the published components altogether.
    status.HTTP_422_UNPROCESSABLE_CONTENT: problem_response("`comment_id` is not a UUID."),
}
"""Responses the delete route can answer with, success included.

The 204 entry carries a description and deliberately **no** ``model``: 204 forbids a body, so
naming a shape would publish a schema for content that is never sent. Declaring it here rather
than leaving FastAPI to generate a bare "Successful Response" is what makes "the delete documents
an empty body" a statement in this file instead of an accident of the generator."""


# ---------------------------------------------------------------------------------------
# Reading and writing a thread, addressed through the post that owns it
# ---------------------------------------------------------------------------------------


@post_comments_router.get(
    "/{post_id}/comments",
    response_model=Page[CommentPublic],
    status_code=status.HTTP_200_OK,
    responses=_LIST_RESPONSES,
    # Anonymous OR bearer, in that order. This handler resolves `OptionalUser`, so the framework
    # would otherwise publish the bearer scheme as REQUIRED and a generated client would refuse
    # to read a public discussion without one. See `app.api.v1.responses`.
    openapi_extra=OPTIONAL_AUTHENTICATION,
    summary="List a post's comments",
    description=(
        "Returns one page of a post's discussion. The page members are the post's **top-level** "
        "comments, each carrying the replies that answer it nested inside `replies`, so `total` "
        "and `pages` count threads rather than individual comments and consecutive pages never "
        "overlap. Public: an anonymous caller receives approved comments only, replies included. "
        "An author or an administrator additionally sees the comments they are entitled to see, "
        "at every level of the thread. A page beyond the last one answers 200 with an empty "
        "`items` list."
    ),
)
async def list_post_comments(
    post_id: UUID,
    db: DbSession,
    viewer: OptionalUser,
    page: PageParamsDep,
) -> Page[CommentPublic]:
    """Read one post's thread, and return the service's page envelope untouched.

    The body of this function is one call and one ``return``, and everything that makes the answer
    correct happens below it. The thread is assembled by a single recursive statement in
    ``CommentRepository`` that nests replies at every depth and applies the viewer's moderation
    filter to each level, so there is no loop here that fetches replies per comment - that loop
    would be the N+1 the recursive statement exists to avoid, and under an async session each of
    its lazy loads would raise rather than merely being slow.

    Args:
        post_id: The post whose thread to read, from the URL path and from nowhere else.
        db: The request-scoped session, the only source of one in this tier.
        viewer: The resolved principal, or ``None`` when the caller is anonymous. Passed through
            rather than ignored, and it decides exactly two things: whether the post is visible at
            all - a draft's thread is unreachable to anyone but its author and an administrator -
            and which moderation states are in scope. Declared as the optional principal rather
            than the required one because reading a discussion is public; a *present but unusable*
            credential is still a 401.
        page: The validated window. ``page`` is at least 1 and ``page_size`` is bounded to 1..100
            before this function is entered, so nothing here validates or clamps either value.

    Returns:
        The service's page envelope, returned exactly as received. It already carries ``items``,
        ``total``, ``page``, ``page_size`` and ``pages``, and it is not rebuilt, re-sliced,
        re-ordered or re-counted here: ``build_page`` performs the page arithmetic once, inside the
        service, so that every collection in this API windows identically and one client control
        pages them all.

    Raises:
        NotFoundError: No post carries that identifier, or it is not visible to this caller.
            Raised by the service before any comment statement is issued, so an invisible draft's
            thread is a 404 rather than a successful empty page - which would disclose nothing but
            would also state nothing true.
    """
    return await CommentService(db).list_for_post(
        post_id,
        viewer=viewer,
        # The two window members are handed over individually rather than as the object, because
        # the service's signature is the contract and it takes plain integers - it reconstructs its
        # own bounded window from them, so the arithmetic still has exactly one definition.
        page=page.page,
        page_size=page.page_size,
    )


@post_comments_router.post(
    "/{post_id}/comments",
    response_model=CommentPublic,
    status_code=status.HTTP_201_CREATED,
    responses=_CREATE_RESPONSES,
    summary="Add a comment or a reply",
    description=(
        "Adds a comment to a post. Send `parent_id` to make it a reply - that member is the only "
        "difference between the two, and the parent must belong to the post named in the path. "
        "Requires authentication and nothing more: no role is needed, so a reader who has just "
        "registered may join a discussion. The post is taken from the path and never from the "
        "body, and `author_id`, `status` and `id` are all server-owned and rejected if sent. The "
        "text is sanitised before it is stored. The new comment is created awaiting moderation, "
        "which is why the response reports a `status` the author did not ask for: render "
        "'awaiting review' from it rather than showing the comment as though it were already "
        "public. A post, parent or account removed between validation and the insert answers 409; "
        "that conflict reports a row that is gone rather than a transient fault, so re-sending the "
        "same request will report it again until the client stops naming a post or a parent that "
        "no longer exists.\n\n"
        "**This operation is not idempotent and carries no idempotency key.** A retry after a "
        "request that committed but whose response was lost writes a second comment. A client that "
        "cannot tell the two apart should surface the failure rather than re-send silently, and "
        "may reconcile by re-reading the thread - a duplicate is visible there, and its author can "
        "delete it."
    ),
)
async def create_post_comment(
    post_id: UUID,
    payload: CommentCreate,
    db: DbSession,
    principal: CurrentUser,
) -> CommentPublic:
    """Add a comment or a reply, and project the written row into a public representation.

    Four rules govern this operation and not one of them is applied here: the post's visibility,
    the parent's membership of that same post and its depth, the sanitisation of the text, and the
    moderation state the new row is given. All four belong to :class:`CommentService`, which is
    what lets each of them hold whichever entry point invokes it and be tested without an HTTP
    request in the picture. This function resolves the principal, forwards the payload, and shapes
    the answer.

    Args:
        post_id: The post being commented on, from the URL path. ``CommentCreate`` forbids a
            ``post_id`` in the body, and that refusal is an authorisation property rather than a
            tidiness one: a body-supplied identifier would give a caller a second, unchecked way to
            name a post, so a request authorised against one post could write its row onto another.
            There is exactly one source for this value and it is the URL.
        payload: The validated body - the text, and optionally the comment being replied to.
        db: The request-scoped session.
        principal: The authenticated, active principal. The comment's authorship is taken from
            here and could not have come from the request, so text cannot be attributed to another
            account.

    Returns:
        The new comment as a bare public representation - never wrapped in a prose-and-payload
        envelope - with ``replies`` empty, which is both its default and the truth about a comment
        that has just been written.

    Raises:
        NotFoundError: No post carries that identifier, or it is not visible to this caller. A
            draft belonging to someone else is reported as missing rather than as forbidden, so the
            status code discloses nothing about whether the identifier addresses anything.
        AppValidationError: The body sanitises to nothing, or ``parent_id`` names a comment that
            does not exist on this post, that this author may not see, or that already sits at the
            maximum reply depth. Rendered as a 422 naming the offending field.
        ConflictError: The post, the parent or the account was removed between those checks and the
            insert.

    Note:
        The projection below is deliberate and must not be simplified into returning the row. The
        service leaves ``replies`` unloaded as a security property - the relationship is the
        unfiltered ownership edge - so validating the whole model against the declared response
        model would read an unloaded collection, which under an async session raises rather than
        yielding an empty list. Constructing the model member by member and omitting ``replies``
        keeps the unfiltered edge untouched and lets the field's empty default stand.
    """
    comment = await CommentService(db).create(post_id, payload, author=principal)

    # Built member by member, with `replies` omitted so its empty default applies. See the note
    # above, and `CommentService._projected` for the security property this preserves. The
    # byline is the public account projection - identity, display name, bio, avatar, join date -
    # and never the private one: an email address, a role and an active flag are not published
    # beside a comment, which is the most public surface in this product.
    return CommentPublic(
        id=comment.id,
        post_id=comment.post_id,
        parent_id=comment.parent_id,
        author=UserPublic.model_validate(comment.author),
        body=comment.body,
        status=comment.status,
        created_at=comment.created_at,
        updated_at=comment.updated_at,
    )


# ---------------------------------------------------------------------------------------
# Editing and removing a comment, addressed by its own identifier
# ---------------------------------------------------------------------------------------


@router.patch(
    "/{comment_id}",
    response_model=CommentPublic,
    status_code=status.HTTP_200_OK,
    responses=_UPDATE_RESPONSES,
    summary="Edit a comment's body",
    description=(
        "Replaces a comment's text. The author may edit their own comment and an administrator may "
        "edit any; anyone else receives 403. A genuine partial update of a single member: omitting "
        "`body` is accepted and changes nothing, and no other member may be sent - `status` would "
        "be a moderation bypass on a route the comment's own author can reach, and `parent_id` "
        "would silently re-parent a comment others have already replied within, so a thread's "
        "shape is fixed when its rows are written. The replacement is sanitised by the same policy "
        "creation uses, so an edit is not a way past a rule creation enforces, and an accepted "
        "edit returns an approved comment to awaiting-moderation - with no exemption for an "
        "administrator - because approval attaches to the text a moderator read and not to the row "
        "that held it.\n\n"
        "The response carries the edited comment **with its reply tree**, nested to full depth "
        "and narrowed to the moderation states this caller may see - the same states the thread "
        "listing would show them. So replacing a cached thread node with this response preserves "
        "the discussion beneath it: `replies` is a statement about the thread, never an empty "
        "placeholder."
    ),
)
async def update_comment(
    comment_id: UUID,
    payload: CommentUpdate,
    db: DbSession,
    principal: CurrentUser,
) -> CommentPublic:
    """Correct a comment's text, and project the updated row into a public representation.

    There is no ownership test in this function, and adding one would be a defect rather than
    defence in depth. ``ensure_can_modify`` is the single declaration of "the author, or an
    administrator", the service calls it against the row it has already loaded, and a second copy
    written here is the copy that would eventually disagree with it - which is exactly the failure
    the retired service demonstrated by writing its identity predicate out three separate times.

    Args:
        comment_id: The comment's identifier, from the URL path.
        payload: The replacement text, or an empty patch. Carries no ``status`` and no
            ``parent_id``.
        db: The request-scoped session.
        principal: The authenticated, active principal. Must own the comment or hold the
            administrator role, which the service confirms.

    Returns:
        The updated comment as a bare public representation, carrying the reply tree beneath it
        nested to full depth. An edit changes text and never a thread's shape, so the tree returned
        is the one that was already there - reported rather than omitted, because a client renders
        the discussion from it.

    Raises:
        NotFoundError: No comment carries that identifier. Reported before authority is considered,
            so a comment the caller may not touch is indistinguishable from one that is absent.
        ForbiddenError: The principal neither wrote the comment nor holds the administrator role.
        AppValidationError: The replacement body sanitises to nothing.

    Note:
        ``status`` in the response may differ from the value the caller last saw, without the
        caller having asked for a change: an accepted edit to an approved comment returns it to
        awaiting-moderation. That is the second half of withholding ``status`` from the input
        model, and without it the first half would be worthless - submit something innocuous, wait
        for approval, then swap the body, and the replacement would be public unreviewed and absent
        from the queue an administrator works.

        **Unlike creation, this response is validated whole**, and the difference is not stylistic.
        The service attaches the caller-visible subtree through
        ``CommentRepository.load_visible_replies`` before returning, so every node - the edited
        comment and every descendant - carries a populated ``author`` and a populated ``replies``,
        which is exactly the shape ``CommentPublic.model_validate`` may walk. Projecting member by
        member here would discard that tree and report an empty one, which is the defect this route
        used to have: a client replacing a cached thread node with the answer lost every reply
        beneath it, with nothing raised and nothing logged.
    """
    comment = await CommentService(db).update(comment_id, payload, actor=principal)

    # Validated whole, deliberately - see the note above. The tree the service attached is complete
    # and status-filtered, so nothing here reads an unloaded attribute, and the nested bylines are
    # the public account projection because `CommentPublic.author` is typed as `UserPublic`: an
    # email address, a role and an active flag are not published beside a comment.
    return CommentPublic.model_validate(comment)


@router.delete(
    "/{comment_id}",
    response_model=None,
    status_code=status.HTTP_204_NO_CONTENT,
    responses=_DELETE_RESPONSES,
    summary="Delete a comment",
    description=(
        "Removes a comment and, by database cascade, every reply beneath it at any depth. The "
        "author may delete their own comment and an administrator may delete any; anyone else "
        "receives 403. The response carries no body. Deletion is final and is not the moderation "
        "tool: a comment that should stop being public without ceasing to exist is rejected "
        "through the administrative status route instead, which keeps the decision reversible and "
        "the author's history intact."
    ),
)
async def delete_comment(
    comment_id: UUID,
    db: DbSession,
    principal: CurrentUser,
) -> None:
    """Remove a comment, and let the database remove everything beneath it.

    The subtree is **not** walked here, and must never be. ``comments.parent_id`` is a
    self-referencing foreign key with ``ON DELETE CASCADE``, so PostgreSQL removes the rows that
    referenced this comment and then cascades again from each of those: one statement clears the
    whole subtree, at any depth. ``Comment.replies`` additionally carries ``passive_deletes``, which
    stops the ORM loading every descendant in order to delete rows the database was going to remove
    anyway - so no query is issued per level and no collection is read.

    A Python-side sweep would be a second definition of a rule the schema already guarantees, and
    the Python copy is the one that would drift - it is the copy that forgets a relation added
    later. It is also precisely the shape being retired: the single-module service this replaces
    found its row by scanning a list and removed it with ``items.pop(index)`` at ``app.py:L47``.

    Args:
        comment_id: The comment's identifier, from the URL path.
        db: The request-scoped session.
        principal: The authenticated, active principal. Must own the comment or hold the
            administrator role, which the service confirms.

    Returns:
        Nothing at all. 204 forbids a body, so there is no acknowledgement object to build and no
        ``{"message": ...}`` envelope to fill - the shape the retired service returned from its own
        delete route at ``app.py:L48``. The status code is the entire answer.

    Raises:
        NotFoundError: No comment carries that identifier.
        ForbiddenError: The principal neither wrote the comment nor holds the administrator role.
    """
    await CommentService(db).delete(comment_id, actor=principal)
