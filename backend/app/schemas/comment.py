"""The three shapes a comment takes on the wire: what a reader may write, and what a reader sees.

Three models and four routes, plus one property that makes this module structurally unlike every
sibling in the folder: a comment carries the comments that answer it, so :class:`CommentPublic`
refers to itself. That recursion is the technical content of this file, and the section below
records how it is resolved and how to prove it has stayed resolved.

The four routes and the three models
------------------------------------
::

    @router.get("/posts/{post_id}/comments", response_model=Page[CommentPublic])
    @router.post("/posts/{post_id}/comments", response_model=CommentPublic, status_code=201)
    @router.patch("/comments/{comment_id}", response_model=CommentPublic)
    @router.delete("/comments/{comment_id}", status_code=204)

:class:`CommentCreate` is the body of the second route, :class:`CommentUpdate` the body of the
third, and :class:`CommentPublic` the declared ``response_model`` of the first three - the
collection route through :class:`~app.core.pagination.Page`, which the router parameterises and
this module therefore does not import.

The fourth route has no response model, and none is declared here. A delete answers ``204 No
Content``, so there is no body for an acknowledgement to occupy: no ``CommentDeleted``, no
``{"deleted": true}``, and above all no ``{"message": ..., "data": ...}`` wrapper. The service
this repository grew out of paired a sentence of prose with a nested payload on three of its five
routes (``app.py:L18``, ``L39``, ``L48``) while its two reads returned bare payloads
(``app.py:L23``, ``L30``), so a client could not tell from a route which of the two shapes it
would receive. ``app.schemas.common`` permits exactly three shapes - a page envelope for a
collection, a bare representation for a single resource, a problem document for a failure - and
that inconsistency is being deleted rather than relocated into this module.

Replies are the one genuinely recursive shape in this package
------------------------------------------------------------
:attr:`CommentPublic.replies` is annotated ``list[CommentPublic]`` - a reference to the class
inside its own body - and :func:`CommentPublic.model_rebuild` is called at module scope
immediately after the class statement.

The **unquoted** spelling is deliberate, and it is the one place in this module where the pinned
toolchain decides the syntax rather than the design. Under Python 3.14 an annotation is not
evaluated where it is written: PEP 649 stores it on a lazily-invoked ``__annotate__`` function, so
naming a class inside its own body no longer raises, and the name is bound in the module namespace
by the time anything asks for the annotation. Quoting it would therefore be a forward reference to
something that is no longer forward, which is exactly what ``ruff``'s ``UP037`` reports under
``target-version = "py314"`` - and ``ruff check backend`` is a blocking gate, so the modern
spelling is required rather than merely available. Both spellings were measured on this stack
(CPython 3.14.7, pydantic 2.13.4) and are indistinguishable in behaviour: each validates a nested
tree and each emits the same self-referential ``$ref``.

The rebuild call stays, and the reason is determinism rather than necessity. Pydantic leaves a
model carrying an unresolved annotation *incomplete* rather than raising, and an incomplete model
fails at whatever later moment first needs its schema - which, for a ``response_model``, is
FastAPI assembling ``/openapi.json`` during application start, several layers from the annotation
that caused it. Calling it here moves any such failure to import time and makes the resolution a
property of this file instead of a property of the order in which something else happened to touch
the class. On the pinned stack it is a no-op that returns ``None``, meaning the model was already
complete; that is a stronger position than depending on it, not a reason to drop it.

A resolved reference is what produces a self-referential ``$ref`` in the generated document rather
than an inlined copy - the only encoding that can describe an unbounded tree at all. Because the
root is itself the recursive component, the schema puts the model in ``$defs`` and makes the root a
``$ref`` to it, so the assertion worth making is about the definition and the item reference
together::

    schema = CommentPublic.model_json_schema()
    assert schema["$ref"] == "#/$defs/CommentPublic"
    replies = schema["$defs"]["CommentPublic"]["properties"]["replies"]
    assert replies["items"] == {"$ref": "#/$defs/CommentPublic"}

The classic failure mode here is a silently unresolved reference, so that is asserted rather than
assumed. ``backend/tests/integration/test_openapi_contract.py`` walks the served document and would
report the same defect from the other end.

A page is a page of threads, not a page of comments
---------------------------------------------------
``GET /api/v1/posts/{id}/comments`` returns ``Page[CommentPublic]`` whose members are the
**top-level** comments of the post - the rows whose ``parent_id`` is ``NULL`` - each carrying its
replies nested inside it. So ``total`` and ``pages`` count *threads*, and a reply is never a page
member in its own right. ``app.repositories.comment_repository.CommentRepository.list_for_post``
adds ``comments.parent_id IS NULL`` to both its window and its count to make that so.

The decision is stated here because a schema alone cannot express it and both tiers depend on
knowing it. Were replies counted as page members, a thread of three top-level comments in which
the first has two replies would report ``total = 5``, and a page size of two would put the first
comment and one of its own replies on page one - the reply appearing twice on that page, once as
a row and once nested inside its parent - while page two would re-nest the second reply under a
parent page one had already shown. ``total`` would then describe a set no client could
reconstruct, and ``pages`` would be arithmetic over the wrong denominator.
``frontend/src/components/blog/comment-list.tsx`` renders one page control for this route and
mirrors these field names in ``frontend/src/lib/types.ts`` in snake_case, with no mapping layer,
so both the paging unit and the spelling of every member below are cross-tier contract.

Depth is the statement's to decide, not this schema's
-----------------------------------------------------
The type is recursive without limit: nothing below caps how deeply replies may nest, because a
depth cap is a rule about what may be *created*, and rules about creation live in
``app.services.comment_service``.

What a *response* actually nests is a different question, and it is settled one layer down by the
eager loader rather than here. ``list_for_post`` loads one level of replies - with the caller's
own status filter applied to the collection, so an unapproved reply cannot reach a public caller
through an approved parent - which means a loaded reply's own ``replies`` collection is not
populated.

That matters to the service projecting these rows. Reading an unloaded attribute under an
``AsyncSession`` raises ``MissingGreenlet`` at the point of access rather than returning empty -
the same property recorded on ``app.models.comment.Comment`` - and ``default_factory`` is no
defence, because attribute access is attempted before a default is considered. Worse, the symptom
is disguised: measured on this stack, an attribute that raises during ``model_validate`` surfaces
*wrapped*, as a ``ValidationError`` of type ``get_attribute_error`` located at ``replies``, which
FastAPI then reports as a response-validation failure rather than as the loading defect it is.

So the obligation this module places on its caller is: **project only the levels the statement
loaded.** Validating a parent whose ``replies`` were loaded is safe, and the leaf level is
constructed with ``replies`` left out, where :attr:`CommentPublic.replies` falls back to its empty
default instead of touching an unloaded collection::

    def project(comment: Comment, replies: list[Comment]) -> CommentPublic:
        return CommentPublic(
            id=comment.id,
            post_id=comment.post_id,
            parent_id=comment.parent_id,
            author=UserPublic.model_validate(comment.author),
            body=comment.body,
            status=comment.status,
            created_at=comment.created_at,
            updated_at=comment.updated_at,
            replies=[project(reply, []) for reply in replies],
        )

Deepening the response is then a change to a loader and to nothing here.

What a client may not send, and why each refusal is load-bearing
----------------------------------------------------------------
Both input models set ``extra="forbid"``, which is what turns each omission below from a
convention into a ``422`` problem document naming the offending key. Pydantic's permissive default
would accept the request and discard the field, and a discarded field is indistinguishable from an
honoured one from the outside - so the guard is the whole enforcement mechanism, not a tidiness
setting.

``post_id``
    Absent from :class:`CommentCreate`, and this is the sharpest of the refusals because it is an
    authorisation hole rather than an untidiness. The post arrives in the path -
    ``POST /api/v1/posts/{post_id}/comments`` - and the router's authority checks are made against
    *that* identifier. A ``post_id`` in the body would give a caller a second, unchecked way to
    name a post, so a request authorised against one post could write its row onto another. There
    is exactly one source for that value and it is the URL.
``author_id``
    Never accepted anywhere. Authorship is the principal ``app.core.dependencies`` resolved from
    the bearer token; a member for it here would let a caller attribute text to another account.
``status``
    Never accepted anywhere, and its absence is the moderation guard. A comment is created
    ``PENDING`` by the column's own server default, and only ``PATCH
    /api/v1/admin/comments/{id}/status`` - behind ``require_admin`` at router level - moves it on.
    Accepting it on either input model would let a commenter approve their own comment, which is
    a moderation bypass; accepting it on the *update* model would let them approve it afterwards,
    which is the same bypass reached a second way. The administrative input model that does carry
    it is ``app.schemas.admin.AdminCommentStatusUpdate``, and it is deliberately not declared in
    this file: a body that changes a moderation state should not be importable from the module a
    public router imports.
``id``, ``created_at``, ``updated_at``
    Server-owned throughout. ``id`` comes from PostgreSQL's ``gen_random_uuid()`` and both instants
    come from the database clock, so no input model has a member through which a caller could
    propose one.
``parent_id``, on update only
    :class:`CommentCreate` accepts it - that is how a reply says what it answers - and
    :class:`CommentUpdate` does not. Re-parenting an existing comment would silently restructure a
    thread that other readers have already read and replied within, and the endpoint is specified
    as "edit comment body". A thread's shape is fixed when its rows are written.

What replaced ``Item``
----------------------
The service this repository grew out of had exactly one data contract, and it faced both ways at
once: ``class Item(BaseModel)`` with ``id: int``, ``name: str`` and ``price: float``
(``app.py:L9-L12``) was simultaneously the accepted request body and the returned representation.
Three properties of that arrangement are defects this module closes rather than inherits.

*The client supplied identity.* ``id`` arrived in the request body, and the server neither
generated it nor checked it for uniqueness. Here ``id`` appears on the output projection and on
neither input.

*A write accepted whatever a read returned.* One model serving both directions means every field a
response publishes is a field a request may set - so a projection and a privilege boundary become
the same declaration. Splitting them is precisely what lets :attr:`CommentPublic.status` be
publishable while remaining unsettable, which is the property the whole moderation feature rests
on.

*An update replaced the entire record.* ``PUT /items/{item_id}`` (``app.py:L34-L40``) required the
client to resend every field it was not changing and overwrote the stored row with whatever
arrived, so a client holding a stale copy silently reverted what it had not refreshed.
:class:`CommentUpdate` is a genuine partial update: editing a comment touches ``body`` and nothing
else.

What this module does not do
----------------------------
It declares shapes. There is no session, no statement, no ownership rule, no moderation
transition, no tree assembly, no status code and no error construction anywhere below.

* **No sanitisation.** Reader-authored text is a stored-injection surface, and it is cleaned on
  write by ``app.services.comment_service`` with ``bleach``, then again at render by the client's
  own sanitising pipeline. ``bleach`` is deliberately not imported here: a cleaner attached to a
  validator would run on every *read* as well, so the stored value and the served value would
  become two different strings, and a schema is the wrong layer to decide which markup a product
  permits.
* **No parent validation.** That ``parent_id`` names a comment that exists *and* hangs off the same
  post is checked by ``app.services.comment_service`` through
  ``CommentRepository.get_parent(parent_id, post_id=...)``. This module cannot know either fact -
  it has no session, and the second is not a property of the submitted value at all.
* **No ownership check.** "A non-owner cannot edit another's comment" lives in that same service,
  so one rule holds whichever entry point invokes it and is unit-testable without an HTTP request.
* **No non-emptiness beyond the field.** A whitespace-only body is rejected by the bound on
  :data:`CommentBody`, which is a ``422`` naming the field rather than a database error - the
  column is ``NOT NULL`` but carries no ``CHECK`` for it, deliberately.
* **No visibility rule.** :attr:`CommentPublic.status` is published, and it is not a leak: a public
  caller only ever receives approved rows because ``comment_repository`` scopes the query by
  status. Visibility is a property of the statement, never of the shape.

Import purity
-------------
Four sources: the standard library's :mod:`uuid` and :class:`~datetime.datetime`, the typing
constructs the annotated alias needs, ``pydantic``, and two first-party names.

:class:`~app.models.comment.CommentStatus` is taken from ``app.models`` - the barrel that
re-exports it - rather than redeclared. The enumeration is persisted as the native PostgreSQL type
``comment_status`` by the very column that declares it, so taking it from there keeps the Python
type, the database labels and the ``/openapi.json`` enumeration one declaration instead of three
that can disagree the first time a state is added on one side only. A ``Literal`` union of status
strings spelled out here would be exactly that second declaration, and is forbidden for the same
reason. The edge points the safe way: ``app.models`` imports no schema module.

:class:`~app.schemas.user.UserPublic` is the one sibling import in this file, and it is the
deliberate exception to the rule ``app.schemas.user`` states for itself. That rule forbids
importing a sibling's *bound* - a length limit restated in two modules is a number, and it has to
agree with the registration contract in any case. A *projection* is different in kind: it is a
privilege boundary, and duplicating it would put a second declaration of "what may be said about
an account" in front of every comment byline in the product. So the byline reuses the class that
already withholds ``password_hash``, ``email``, ``role`` and ``is_active``. The edge is one-way -
``app.schemas.user`` imports no sibling, so no cycle exists and this package's import order stays
irrelevant - and it is the same edge a post summary, a post detail and an administrative user row
each declare. :class:`~app.schemas.user.UserMe` must never appear here: it adds the four withheld
members, and a comment thread is the most public surface in the product.

Not ``app.schemas.common``: the page envelope is parameterised by the router
(``response_model=Page[CommentPublic]``) and the problem document is named by its ``responses=``
mapping, so importing either would add an unused edge and, in the first case, invite a competing
collection wrapper into this module. Not ``app.repositories`` or ``app.services``, which consume
these shapes rather than the reverse. Not ``app.core.config`` and not :mod:`os`: importing this
module performs no I/O, opens no connection and reads no setting, which is what lets a unit test
import it with nothing running and no ``.env`` present.
"""

import uuid
from datetime import datetime
from typing import Annotated, Final

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from app.models import CommentStatus
from app.schemas.user import UserPublic

# The module's public contract is these three models, in the order RUF022 enforces. The two bounds
# and the annotated alias below are shared machinery - importable by a test, or by a validator
# mirroring the same limit - but not part of the surface `app.schemas.__init__` re-exports, exactly
# as the length constants in `app.schemas.user` and `app.schemas.category` are not. Keep this list
# in step with what the module defines: mypy's strict `no_implicit_reexport` consults it, and it is
# what tells a reader that `CommentStatus` and `UserPublic` above are dependencies of this module
# rather than names it re-exports.
__all__ = ["CommentCreate", "CommentPublic", "CommentUpdate"]


# ---------------------------------------------------------------------------------------
# Body bounds
#
# `comments.body` is unbounded `TEXT` and carries no `CHECK` constraint, by explicit decision
# recorded on the column itself: a length limit that is part of the contract belongs here,
# where a violation is a 422 naming the field, and where changing the limit is not a schema
# migration. These two numbers are therefore the only limits that exist anywhere.
# ---------------------------------------------------------------------------------------

BODY_MIN_LENGTH: Final[int] = 1
"""Shortest accepted comment body, applied *after* ``strip_whitespace``.

One character combined with stripping, which is what makes ``"   "`` a rejection rather than a
three-character comment that renders as an empty bubble in a thread. A single glyph is a
legitimate comment in any script, so the floor is not raised above one: the rule being enforced
is "a comment must say something", not "a comment must be long".
"""

BODY_MAX_LENGTH: Final[int] = 5000
"""Longest accepted comment body, in characters.

Five thousand characters is several paragraphs - far more than a reader writes in a discussion,
and comfortably short of an article, which is what posts are for.

An explicit ceiling is required rather than merely tidy, and the reason is the read path rather
than the write. The column would store whatever it is handed, and a thread page fetches a page of
top-level comments *with their replies nested inside them*, so one response can carry dozens of
bodies. Without a bound, a single accepted request would add unbounded weight to every subsequent
read of that thread - a storage cost paid once against a transfer and render cost paid on every
view - and would do so through the one write path in the product that an unprivileged account can
reach.
"""

CommentBody = Annotated[
    str,
    StringConstraints(
        # Stripping runs before the length rules, so a padded submission is measured after
        # trimming: "  Nice write-up.  " is accepted and stored trimmed, and a whitespace-only
        # body is rejected as too short instead of being stored as a value that renders blank.
        # This is also the only trimming performed anywhere on the way to the column, so it is
        # what keeps a leading-newline paste from becoming part of the stored text.
        strip_whitespace=True,
        min_length=BODY_MIN_LENGTH,
        max_length=BODY_MAX_LENGTH,
    ),
]
"""A validated comment body, as both input models accept it.

Declared as an alias rather than inline so the create and the update contracts cannot drift: an
edit is held to exactly the rule creation was held to, which is the property that stops a body
being lengthened past the ceiling by patching it. No sanitisation is attached - see "What this
module does not do" in the module docstring - so the validated value is the caller's text with
its surrounding whitespace removed and nothing else changed.
"""


class CommentCreate(BaseModel):
    """The body of ``POST /api/v1/posts/{post_id}/comments``: some text, and what it answers.

    Two members, and both of them are things only the writer can decide. A top-level comment
    sends the text alone::

        {"body": "Clear write-up - the section on cascades especially."}

    and a reply names the comment it answers, which is the *only* difference between the two::

        {
            "body": "Agreed, though the second half surprised me.",
            "parent_id": "9c2f1b84-0a5e-4d31-8b77-6e4c2a91d503",
        }

    Everything else about the row is the server's to produce: ``id`` from ``gen_random_uuid()``,
    ``post_id`` from the path, ``author_id`` from the resolved principal, ``status`` from the
    column's ``PENDING`` default, and both instants from the database clock. So there is nothing
    else for a caller to send, and ``extra="forbid"`` makes each of those a rejection rather than
    a silent discard. The module docstring records why each refusal is load-bearing, and why
    ``post_id`` is the sharpest of them.

    What this model does not check
    -----------------------------
    It does not check that ``parent_id`` names a real comment, and it could not: that requires a
    session, which a schema module must not have. It does not check that the named comment hangs
    off the *same post* either, which is not a property of the submitted value at all - the value
    is a well-formed identifier whichever post its row belongs to. Both are creation rules, and
    ``app.services.comment_service`` enforces them through
    ``CommentRepository.get_parent(parent_id, post_id=...)``, translating a miss into the domain
    error that renders as ``404`` rather than letting a foreign key raise it as a ``500``.

    Nor does it sanitise the body. Reader-authored text is cleaned on write by that same service
    and again at render by the client; a cleaner here would also run on every read.
    """

    model_config = ConfigDict(
        # No unknown member is accepted. On an inbound body an unrecognised key is always either
        # a client defect or an attempt to write a field the client does not own - `post_id`,
        # `author_id`, `status` and `id` are all the second kind - so silently dropping it would
        # make an attempt indistinguishable from a success. Note the deliberate contrast with
        # `ProblemDetail` in `app.schemas.common`, which does NOT forbid extras: that is an
        # outbound document RFC 9457 permits a server to extend.
        extra="forbid",
        json_schema_extra={
            # Published verbatim in /openapi.json and rendered on /docs, so it is written for a
            # reader of the documentation: a top-level comment, which is the common case, with
            # `parent_id` left out rather than sent as null so the example also demonstrates that
            # omitting it is how a comment is made top-level.
            "example": {"body": "Clear write-up - the section on cascades especially."}
        },
    )

    body: CommentBody = Field(
        ...,
        description=(
            f"The comment text, {BODY_MIN_LENGTH} to {BODY_MAX_LENGTH} characters after "
            "surrounding whitespace is trimmed. A whitespace-only body is rejected as too short. "
            "Sanitised server-side on write and again at render, so markup it contains is not "
            "honoured; write plain prose."
        ),
    )
    parent_id: uuid.UUID | None = Field(
        default=None,
        description=(
            "Identifier of the comment this one replies to. Omit it - or send null - to post a "
            "top-level comment; that is the only difference between a comment and a reply. The "
            "named comment must exist and must belong to the post in the path, both of which are "
            "checked server-side: a parent that is missing, or that hangs off another post, is "
            "reported as 404 rather than accepted. The post itself is NOT sent in the body; it "
            "comes from the path."
        ),
    )


class CommentUpdate(BaseModel):
    """The body of ``PATCH /api/v1/comments/{comment_id}``: the corrected text, and nothing else.

    One member, and that is the whole model::

        {"body": "Corrected: the cascade is recursive, not one level."}

    A genuine partial update. The single member is optional, so an omitted ``body`` means "leave
    this as it is" rather than "clear it" - the distinction the service reads by dumping only what
    the caller actually sent::

        changes = payload.model_dump(exclude_unset=True)  # {} for an empty body

    That is what replaces the whole-object replacement the retired ``PUT /items/{item_id}``
    performed (``app.py:L34-L40``), which required the client to resend every field it was not
    changing and overwrote the stored record with whatever arrived. An empty body ``{}`` is
    therefore a valid no-op: it validates, dumps to ``{}`` and changes nothing. There is no "at
    least one field required" rule, because an editor submitted without edits is a legitimate
    request with a legitimate outcome.

    Why a one-member model is nonetheless the right shape
    ---------------------------------------------------
    A single required field would be indistinguishable from this on the happy path and wrong on
    every other: it would make ``{}`` an error, and it would leave no room for a second editable
    member if the product ever gains one. More importantly, declaring the model at all is what
    creates a place to state - and enforce - the two members that are *absent*.

    ``status`` is absent, and that is the moderation guard
    ----------------------------------------------------
    A comment's author must not be able to approve their own comment. Moderation is an
    administrator's decision, made through ``PATCH /api/v1/admin/comments/{id}/status`` behind
    ``require_admin`` at router level, and the input model for it is
    ``app.schemas.admin.AdminCommentStatusUpdate``. This route is reachable by the comment's owner,
    so a ``status`` member here would be a moderation bypass - and one that ``extra="forbid"``
    turns into a ``422`` naming the key rather than a request that appears to succeed while the
    field is quietly discarded.

    ``parent_id`` is absent, and that keeps a thread's shape stable
    -------------------------------------------------------------
    :class:`CommentCreate` accepts it and this model does not. Re-parenting an existing comment
    would silently restructure a discussion other readers have already read and replied within: a
    reply would move under a different parent, taking its own subtree with it, and every deep link
    into the thread would resolve to a different context than it did before. The endpoint is
    specified as "edit comment body", so a thread's shape is fixed when its rows are written.
    Moving a comment is not an operation this API has.

    Null is refused
    --------------
    ``comments.body`` is ``NOT NULL``, so there is no state ``{"body": null}`` could describe.
    :meth:`_reject_null_body` reports it as a ``422`` naming the field, rather than letting it
    reach the column and surface as a ``500`` describing an integrity violation several layers from
    the request member that caused it.
    """

    model_config = ConfigDict(
        # See the class docstring: this is the privilege guard rather than a tidiness setting. It
        # is what makes `status` unsettable and `parent_id` unchangeable through this route rather
        # than merely undocumented, and it rejects `id` and `post_id` too - a path parameter
        # already carries the first and the second is not this route's to change.
        extra="forbid",
        json_schema_extra={
            "example": {"body": "Corrected: the cascade is recursive, not one level."}
        },
    )

    body: CommentBody | None = Field(
        default=None,
        description=(
            f"Replacement comment text, {BODY_MIN_LENGTH} to {BODY_MAX_LENGTH} characters after "
            "trimming. Omit the field to leave the comment unchanged; an empty patch is accepted "
            "and changes nothing. Null is NOT accepted, and neither is a whitespace-only value: "
            "there is no state an empty comment would describe. Editing does NOT re-open "
            "moderation and does NOT change the comment's status - only an administrator can do "
            "that - and it does not move the comment within its thread."
        ),
    )

    @field_validator("body")
    @classmethod
    def _reject_null_body(cls, value: str | None) -> str | None:
        """Reject an explicitly submitted ``{"body": null}`` while leaving omission alone.

        The guard rests on a property of Pydantic that is easy to miss and is load-bearing here: a
        field validator runs only for a value the caller actually supplied, never for a field that
        fell back to its default. So this method never sees the ``None`` an omitted ``body`` leaves
        behind - ``CommentUpdate()`` still validates and still dumps to ``{}`` under
        ``exclude_unset=True`` - and it fires only when ``null`` was written into the request body
        on purpose.

        Without it, that ``null`` would survive ``model_dump(exclude_unset=True)`` as a real
        change, reach a ``NOT NULL`` column, and surface as an integrity error: a ``500``
        describing a database constraint, raised several layers away from the request member that
        caused it, instead of a ``422`` the caller can act on.

        Args:
            value: The submitted body, already trimmed and length-checked. ``None`` only if the
                caller sent an explicit null.

        Returns:
            ``value`` unchanged, once it is known not to be ``None``.

        Raises:
            ValueError: If ``value`` is ``None``. Pydantic renders it as a field-level entry in the
                ``422`` problem document, keyed to ``body``.
        """
        if value is None:
            raise ValueError("body may not be null; omit the field to leave the comment unchanged")
        return value


class CommentPublic(BaseModel):
    """A comment as a reader sees it, with the comments that answer it nested inside.

    Nine members, the last of which is a list of this same model - so one payload carries a whole
    thread rather than a flat list a client would have to re-assemble by matching identifiers. It
    is the declared ``response_model`` of three routes::

        @router.get("/posts/{post_id}/comments", response_model=Page[CommentPublic])
        @router.post("/posts/{post_id}/comments", response_model=CommentPublic, status_code=201)
        @router.patch("/comments/{comment_id}", response_model=CommentPublic)

    On the collection route the page's members are the post's **top-level** comments, so ``total``
    and ``pages`` count threads; see "A page is a page of threads" in the module docstring, which
    is the one part of this contract a schema cannot express on its own. On the two single-resource
    routes the representation is returned bare, with nothing wrapped around it.

    Validated from a mapped row
    --------------------------
    ``from_attributes`` is enabled, so a service projects a loaded ``app.models.Comment``
    directly::

        CommentPublic.model_validate(comment)

    Every member below is named exactly as the column or relationship it reads, which is what makes
    that one call sufficient. It is safe after a commit because ``app.db.session`` builds the
    session factory with ``expire_on_commit=False``, and it is safe **to the depth the statement
    loaded** - one level of replies, as ``comment_repository`` loads them. Beyond that depth the
    caller constructs the leaf explicitly and leaves ``replies`` out, where the empty default
    applies; the module docstring gives the projection in full and the reason reading further would
    raise rather than return empty.

    ``status`` is published and unsettable
    ------------------------------------
    It appears here so an author can see that their comment is awaiting moderation and so an
    administrator's queue can render a state, and it appears on **neither** input model, which is
    what makes it read-only in effect rather than merely by convention. Publishing it is not a
    leak: a public caller only ever receives approved rows, because the repository scopes the query
    by status rather than trusting a consumer to filter this field.

    What this projection deliberately omits
    --------------------------------------
    ``author_id``
        The column is not published because :attr:`author` already carries the account, as the
        public projection that withholds its email, role and active flag. A bare identifier beside
        it would be a second, redundant way to name the same account and would invite a client to
        fetch what it has already been given.
    ``reply_count``
        A tally would have to be a correlated aggregate, and this model is embedded once per thread
        *and* once per reply, so the cost would be paid per row of a page that already carries the
        replies themselves - a client counts ``len(replies)``.
    ``post_title``, or any other member of the post
        A join per row to render text a thread's page already displays in its heading.
        :attr:`post_id` is the whole of the relationship a client needs, and the administrative
        moderation queue - which genuinely does need a post's context across many posts - is served
        by its own projection in ``app.schemas.admin``.
    a ``liked``, ``like_count`` or ``score`` member
        Likes are a property of a post, not of a comment. ``app.schemas.like.LikeSummary`` carries
        them, and no route in this API attributes them to a comment.
    """

    model_config = ConfigDict(
        # Projected from a mapped `app.models.Comment`, so attribute access has to be a valid
        # input. A plain mapping still validates too, which is what lets a test feed this model a
        # dict - or a nested dict tree - without a session, and what makes the example below a
        # literal description of an accepted input as well as of the wire format.
        from_attributes=True,
        json_schema_extra={
            # Published verbatim in /openapi.json and rendered on /docs. It shows one approved
            # top-level comment carrying one approved reply, because the nesting is the single
            # property of this shape a reader is most likely to get wrong - and the reply's own
            # `replies` is `[]` rather than absent, which documents that a leaf reports an empty
            # list instead of omitting the member. `status` is spelled from the imported
            # enumeration rather than typed out, so the example cannot name a label the type does
            # not have; `.value` keeps a plain string in the generated document.
            "example": {
                "id": "9c2f1b84-0a5e-4d31-8b77-6e4c2a91d503",
                "post_id": "3f6b1c8a-4d2e-4f7b-9c1a-8e5d2b7a6c04",
                "parent_id": None,
                "author": {
                    "id": "3f1a9c74-6b0e-4d52-9a3f-71c2e8b45d10",
                    "username": "example-reader",
                    "display_name": "Example Reader",
                    "bio": "Reads more of this than is strictly good for me.",
                    "avatar_url": "https://example.com/avatars/example-reader.png",
                    "created_at": "2026-01-15T09:30:00Z",
                },
                "body": "Clear write-up - the section on cascades especially.",
                "status": CommentStatus.APPROVED.value,
                "created_at": "2026-02-03T11:05:00Z",
                "updated_at": "2026-02-03T11:05:00Z",
                "replies": [
                    {
                        "id": "5b8e0d17-92c4-4a6f-bd31-0c7a4e2f8916",
                        "post_id": "3f6b1c8a-4d2e-4f7b-9c1a-8e5d2b7a6c04",
                        "parent_id": "9c2f1b84-0a5e-4d31-8b77-6e4c2a91d503",
                        "author": {
                            "id": "7d4c2e91-3b58-4f6a-8c02-1e9b5a7d3f64",
                            "username": "example-author",
                            "display_name": "Example Author",
                            "bio": None,
                            "avatar_url": None,
                            "created_at": "2026-01-04T08:15:00Z",
                        },
                        "body": "Thanks - the recursive half of that surprised me too.",
                        "status": CommentStatus.APPROVED.value,
                        "created_at": "2026-02-03T12:40:00Z",
                        "updated_at": "2026-02-03T12:40:00Z",
                        "replies": [],
                    }
                ],
            }
        },
    )

    id: uuid.UUID = Field(
        ...,
        description=(
            "Server-generated identifier, stable for the lifetime of the comment. Produced by "
            "PostgreSQL through `gen_random_uuid()` and never supplied by a client. It addresses "
            "`PATCH /api/v1/comments/{id}` and `DELETE /api/v1/comments/{id}`, and it is the value "
            "a reply sends as `parent_id`."
        ),
    )
    post_id: uuid.UUID = Field(
        ...,
        description=(
            "The post this comment belongs to. Always present - a comment cannot exist without a "
            "post - and identical on every comment in a thread, replies included, so a client "
            "merging a response into state it already holds keys on it rather than tracking which "
            "request produced the payload."
        ),
    )
    parent_id: uuid.UUID | None = Field(
        ...,
        description=(
            "The comment this one replies to, or null when it is top-level. Threading is this "
            "member and nothing else. The key is always present, so only the value can be null "
            "and a client never has to distinguish an absent member from a null one. On the "
            "listing route every page member is top-level, so this is null for each of them and "
            "non-null for everything nested inside them."
        ),
    )
    author: UserPublic = Field(
        ...,
        description=(
            "The account that wrote the comment, as the public profile projection: identity, "
            "display name, bio, avatar and join date. Deliberately never the private projection - "
            "an email address, a role and an active flag are not published beside a comment, which "
            "is the most public surface in the product. Render the byline from `display_name` and "
            "link it to `/u/{username}`."
        ),
    )
    body: str = Field(
        ...,
        description=(
            "The comment text, already trimmed and already sanitised server-side. A plain string "
            "rather than a validated or re-cleaned type: it was proved to satisfy its bounds when "
            "it was submitted, so re-checking it on every read would cost a validation per comment "
            "in a thread and would turn an older row that no longer satisfies a tightened bound "
            "into a failed read. Render it as text; the client sanitises again at that point."
        ),
    )
    status: CommentStatus = Field(
        ...,
        description=(
            "Moderation state: PENDING while awaiting a decision, APPROVED once public, REJECTED "
            "once refused. Read-only in effect - it is published here so an author can see that "
            "their own comment is queued and so a moderation screen can render a state, and it is "
            "accepted by no input model in this API. Only an administrator changes it, through "
            "`PATCH /api/v1/admin/comments/{id}/status`. A public caller receives APPROVED rows "
            "only, because the query scopes by status rather than relying on this field being "
            "read."
        ),
    )
    created_at: datetime = Field(
        ...,
        description=(
            "Instant the comment was written, from the database clock, as a timezone-aware ISO "
            "8601 value in UTC - for example `2026-02-03T11:05:00Z`. Comments within a thread are "
            "returned in ascending order of this value, because a discussion reads forwards."
        ),
    )
    updated_at: datetime = Field(
        ...,
        description=(
            "Instant the comment was last modified, in the same form. Equal to `created_at` until "
            "the body is edited, so `updated_at > created_at` is a reliable 'edited' test a client "
            "can render an indicator from. Editing does not change `status`, so an edit does not "
            "re-open moderation."
        ),
    )
    replies: list[CommentPublic] = Field(
        default_factory=list,
        description=(
            "The comments answering this one, in ascending order of `created_at`. The same shape "
            "recursively, so a reply may carry its own replies and a client renders a thread by "
            "walking this member rather than by matching `parent_id` across a flat list. Always "
            "present and never null: a comment nobody has answered reports `[]`. On the listing "
            "route these are filtered by the same moderation rule as their parent, so a public "
            "caller never receives an unapproved reply through an approved comment. How deeply a "
            "given response nests is decided by the query that produced it, not by this type, "
            "which imposes no limit."
        ),
    )


# Settle the self-reference in `CommentPublic.replies` here, at module scope, where the name
# `CommentPublic` is bound.
#
# Determinism, not repair. Pydantic leaves a model carrying an unresolved annotation *incomplete*
# rather than raising, so without this line a resolution failure would surface at whatever later
# moment first needed the model's schema: for a `response_model`, that is FastAPI assembling
# /openapi.json during application start, several layers from the annotation that caused it.
# `raise_errors` defaults to True, so an unresolvable reference raises PydanticUndefinedAnnotation
# from this line instead, at import time, naming this module.
#
# Measured on the pinned stack (CPython 3.14.7, pydantic 2.13.4) this call returns None, meaning
# the model was already complete when the class statement finished: PEP 649 defers annotation
# evaluation, so `list[CommentPublic]` resolves the first time it is asked for rather than where it
# is written. Keeping the call is what makes that a verified fact about this file rather than an
# assumption about the interpreter, and it keeps the guarantee if a later change reorders the
# module. The return value is discarded because "was a rebuild needed" is not a fact this module
# acts on.
CommentPublic.model_rebuild()
