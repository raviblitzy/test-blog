"""The administrative contract: what an administrator may see, and what an administrator may change.

Thirteen operations live beneath ``/api/v1/admin`` - the four management surfaces the user named
("an admin dashboard for managing users, posts, comments, and categories"), three operations each,
plus the overview screen. This module declares every payload they carry, and nothing else.

Because the framework choice was resolved to FastAPI there is no framework-provided administration
console to inherit, so the dashboard is an explicit route group over an explicit API namespace.
That is what the prompt asked for in any case: an admin dashboard as a deliverable, not a
by-product of a framework.

The seven models, and the two that are imported
-----------------------------------------------
Responses:

:class:`AdminUser`, :class:`AdminPost`, :class:`AdminComment`
    The three privileged projections. Each is the item type of a listing, declared at the route as
    ``Page[AdminUser]``, ``Page[AdminPost]`` and ``Page[AdminComment]``.
:class:`AdminStats`
    The four aggregate counts the overview screen renders.

Requests:

:class:`AdminUserUpdate`
    ``PATCH /api/v1/admin/users/{id}`` - role and active state.
:class:`AdminPostStatusUpdate`
    ``PATCH /api/v1/admin/posts/{id}/status`` - a forced lifecycle transition.
:class:`AdminCommentStatusUpdate`
    ``PATCH /api/v1/admin/comments/{id}/status`` - a moderation decision.
:class:`CategoryCreate`, :class:`CategoryUpdate`
    ``POST /api/v1/admin/categories`` and ``PATCH /api/v1/admin/categories/{id}``. **Imported**
    from ``app.schemas.category`` and re-exported below rather than redeclared here - that module
    names itself the single definition site of both, and one wire format deserves one description.

The whole namespace, and the payload each operation carries::

    GET    /api/v1/admin/stats                  ->  AdminStats
    GET    /api/v1/admin/users                  ->  Page[AdminUser]
    PATCH  /api/v1/admin/users/{id}             AdminUserUpdate          ->  AdminUser
    DELETE /api/v1/admin/users/{id}                                      ->  204, no body
    GET    /api/v1/admin/posts                  ->  Page[AdminPost]
    PATCH  /api/v1/admin/posts/{id}/status      AdminPostStatusUpdate    ->  AdminPost
    DELETE /api/v1/admin/posts/{id}                                      ->  204, no body
    GET    /api/v1/admin/comments               ->  Page[AdminComment]
    PATCH  /api/v1/admin/comments/{id}/status   AdminCommentStatusUpdate ->  AdminComment
    DELETE /api/v1/admin/comments/{id}                                   ->  204, no body
    POST   /api/v1/admin/categories             CategoryCreate           ->  CategoryPublic
    PATCH  /api/v1/admin/categories/{id}        CategoryUpdate           ->  CategoryPublic
    DELETE /api/v1/admin/categories/{id}                                 ->  204, no body

"Privileged" describes the audience, not the latitude
----------------------------------------------------
``app.api.v1.routers.admin`` mounts this namespace as ``APIRouter(prefix="/admin",
dependencies=[Depends(require_admin)])``, so the gate covers every operation beneath it and no
individual route can omit it - including one added long after this file was written. Every model
here is therefore reachable only by an authenticated, active principal holding ``ADMIN``.

That settles who is reading, and it settles nothing else. Two consequences are load-bearing:

* **``password_hash`` appears in no model in this file, and in no model in this service.** A
  password hash has no legitimate consumer over HTTP, and "the caller is an administrator" is not
  a reason to change that - only ``app.core.security`` ever reads that column. The same holds for
  a refresh token: ``app.models.refresh_token`` stores a hash rather than a token precisely so
  that there is nothing to echo, and nothing here echoes it.
* **These models are not the security boundary.** They describe payloads. Authority is decided
  server-side, by ``require_admin`` for the namespace and by an ownership assertion in the service
  layer for anything scoped to a row. A field a client cannot see is not a field a client cannot
  reach, and hiding a control is user experience rather than protection.

Every embedded author is ``UserPublic``
---------------------------------------
:class:`AdminPost` and :class:`AdminComment` each carry ``author: UserPublic``, never
``app.schemas.user.UserMe`` and never :class:`AdminUser`. An administrative table needs to know
*who* wrote a row; it has no use for that person's login address or suspension state, and an
embedded privileged projection is exactly how a leak spreads - one nested member, and every table
that renders a byline starts publishing an email. ``UserPublic``'s own docstring records the
inverse of the same rule, which is why widening this module can never widen a public one.

A name that already exists: ``app.core.dependencies.AdminUser``
--------------------------------------------------------------
``app.core.dependencies`` exports ``AdminUser = Annotated[User, Depends(require_admin)]`` - the
*injected administrator principal*. This module exports :class:`AdminUser` - the *serialised
administrative user row*. Two different things, two different modules, one name, and Python raises
nothing when a module imports both: the second import silently wins.

``app.api.v1.routers.admin`` is the one module that needs both, so it must alias at the import::

    from app.core.dependencies import AdminUser as AdminPrincipal
    from app.schemas.admin import AdminStats, AdminUser, AdminUserUpdate

Neither name is negotiable in isolation - the dependency alias is the vocabulary every other
administrative handler already reads in, and this class is the name the response model is
documented and tested under - so the collision is resolved where the two meet rather than by
renaming one of them here.

What this module deliberately does not declare
----------------------------------------------
Each omission is a decision, recorded so that it is not undone by someone reading a gap as an
oversight:

No collection wrapper
    All four listings return ``Page``, the generic envelope re-exported from
    ``app.schemas.common`` and parameterised at the route. A bespoke ``AdminUserList`` would be a
    fifth pagination shape for a client that already has one, and the whole point of the shared
    envelope is that the administrative tables and the home feed can use the same control.
No delete-response model
    Every administrative ``DELETE`` answers ``204 No Content``. There is no body, so there is
    nothing to model.
No ``message``-and-``data`` envelope, in any form
    The service this repository grew out of wrapped some of its five routes in a two-member object
    - a human-readable ``message`` beside a ``data`` payload on create and on update, a ``message``
    alone on delete - and returned bare payloads from both reads, so a client could not tell from a
    route which of the two shapes it would receive. That inconsistency is deleted, not relocated
    into the administrative namespace.
No listing filter or query model
    ``page`` and ``page_size`` are ``app.core.dependencies.PageParams``, and any further filter is
    a ``Query`` parameter declared on the route. A model here would be a second, competing
    description of a window whose bounds are already enforced once.
No enumeration of its own
    :class:`~app.models.user.UserRole`, :class:`~app.models.post.PostStatus` and
    :class:`~app.models.comment.CommentStatus` are imported from ``app.models``, where each is
    persisted as a native PostgreSQL enumerated type by the column that declares it. One
    declaration serves the Python type, the database type and the OpenAPI enumeration; a
    hand-written union of state strings spelled here would be a second source of truth, and the two
    would disagree the first time a state was added on one side only.
No administrative variant of a category input
    See :class:`CategoryCreate` above.

Import purity
-------------
Six imports, and nothing beyond them: the two standard-library names the field types need,
``pydantic``, the three enumerations, ``UserPublic``, and the two category inputs. Not
``app.core.config``, so no setting is read - in particular the two variables that name the seeded
administrator's address and credential are ``app.db.seed``'s alone, and neither their names nor
their values appear here, not even as an example. Not ``sqlalchemy``, so there is no session and no
statement; the cross-entity
aggregation behind :class:`AdminStats` is composed by ``app.services.admin_service``. Not
``fastapi``, so there is no status code and no dependency. Importing this module performs no I/O,
reaches no database and touches no environment, which is what lets a test import it with nothing
running and no ``.env`` present.

Every example below is published verbatim at ``/openapi.json`` and rendered on ``/docs``. They use
the same fabricated accounts, post and comment as the sibling modules, so the generated document
reads as one worked example; every address is at ``example.com``, and no value resembles a
credential or a real account.
"""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, ValidationInfo, field_validator
from pydantic.json_schema import SkipJsonSchema

from app.models import CommentStatus, PostStatus, UserRole
from app.schemas.category import CategoryCreate, CategoryUpdate
from app.schemas.common import omit_null_default
from app.schemas.user import UserPublic

# The module's public contract: the seven models declared here, plus the two category inputs
# imported above and re-exported unchanged. Listing the latter two is what makes the re-export
# legitimate on both gates at once - ruff stops reporting the import as unused, and mypy's strict
# `no_implicit_reexport` lets `app.schemas.__init__` and the administrative router write
# `from app.schemas.admin import CategoryCreate`. This mirrors how `app.schemas.common` re-exports
# `Page`, and it is functional rather than decorative: keep it exactly in step with what the
# module defines and imports. Sorted, because RUF022 requires it.
__all__ = [
    "AdminComment",
    "AdminCommentStatusUpdate",
    "AdminPost",
    "AdminPostStatusUpdate",
    "AdminStats",
    "AdminUser",
    "AdminUserUpdate",
    "CategoryCreate",
    "CategoryUpdate",
]


class AdminUser(BaseModel):
    """An account as an administrator sees it: identity, authority, state, and both audit instants.

    The item type of the user-management table, and the body returned once a change to one is
    applied::

        @router.get("/users", response_model=Page[AdminUser])
        @router.patch("/users/{user_id}", response_model=AdminUser)

    Three members appear here that ``app.schemas.user.UserPublic`` withholds - ``email``, ``role``
    and ``is_active`` - and each is exactly what the screen exists to show. ``email`` is how an
    administrator identifies the human behind a handle when two display names collide. ``role`` is
    the value ``AdminUserUpdate`` changes. ``is_active`` is the reversible half of moderation, and
    a suspension is invisible without it.

    ``password_hash`` is absent, and always will be
    ----------------------------------------------
    There is no model anywhere in this service that carries it, and this is the module where that
    rule is most likely to be argued with, because the audience is trusted. It should not be: a
    password hash has no consumer over HTTP. Nothing an administrator does with an account needs
    it - a role change does not, a suspension does not, a deletion does not - and the one component
    that verifies a credential, ``app.core.security``, reads the column directly from a mapped row.
    Publishing it would put an offline-crackable artifact into a JSON response, an access log and a
    browser's memory in exchange for nothing.

    Declared standalone rather than inheriting ``UserPublic``
    -------------------------------------------------------
    ``app.schemas.user.UserMe`` inherits :class:`~app.schemas.user.UserPublic` because it *is* the
    public projection plus what the owner may additionally see, and drift between the two would be
    a defect. This class is not that. It answers a different question for a different audience, and
    inheriting would tie the administrative table's columns to the anonymous byline's: the first
    time this screen wanted a member the public projection lacked, the tempting edit would be to
    add it upstream - which is the single change that publishes it on every post card, every
    comment and every public profile at once. The four repeated field names are a small, deliberate
    price for making that edit impossible to reach from here.

    ``bio`` and ``avatar_url`` are absent for the opposite reason
    -----------------------------------------------------------
    Both are on ``UserPublic``, so this projection is not a superset of it. Neither is omitted for
    safety - they are public - but a management table lists and acts, and self-description prose
    and an image URL are presentation the profile page already renders. Sending them would add
    bytes per row to a paginated table that displays neither. An administrator who wants to see a
    profile as a reader sees it opens ``/u/{username}``.

    Validated from a mapped row rather than constructed by hand
    ----------------------------------------------------------
    ``from_attributes`` is enabled, so a service projects a loaded ``app.models.User`` directly::

        AdminUser.model_validate(user)

    Safe after a commit because ``app.db.session`` builds the session factory with
    ``expire_on_commit=False``, so an attribute loaded before the flush is still loaded here.
    """

    model_config = ConfigDict(
        # Projected from a mapped `app.models.User`, so attribute access has to be a valid input.
        # A plain mapping validates too, which is what lets a repository that selected individual
        # columns - deliberately never including `password_hash` - feed this model without
        # materialising an entity.
        from_attributes=True,
        json_schema_extra={
            # The same fabricated account the sibling modules use, so /docs reads as one worked
            # example across the package. The role is spelled from the imported enumeration rather
            # than typed out, so this example cannot name a label the type does not have; `.value`
            # keeps a plain string in the generated document. Both instants are populated and
            # differ, which is what shows `updated_at > created_at` is the "has been edited" test.
            "example": {
                "id": "3f1a9c74-6b0e-4d52-9a3f-71c2e8b45d10",
                "email": "reader@example.com",
                "username": "example-reader",
                "display_name": "Example Reader",
                "role": UserRole.READER.value,
                "is_active": True,
                "created_at": "2026-01-15T09:30:00Z",
                "updated_at": "2026-02-02T18:05:00Z",
            }
        },
    )

    id: uuid.UUID = Field(
        ...,
        description=(
            "Server-generated identifier, stable for the lifetime of the account, produced by "
            "PostgreSQL through `gen_random_uuid()` and never supplied by a client. This is the "
            "value that addresses `PATCH /api/v1/admin/users/{id}` and "
            "`DELETE /api/v1/admin/users/{id}`; `username` addresses the public profile."
        ),
    )
    email: EmailStr = Field(
        ...,
        description=(
            "The address this account logs in with. Published only to the account itself and to "
            "an administrator - it appears in no public profile, no post byline and no comment. "
            "Stored in a case-insensitive `CITEXT UNIQUE` column, so two accounts cannot differ "
            "by letter case alone, and returned in the form it was registered in. Not changeable "
            "through any route in this API; see `AdminUserUpdate`."
        ),
    )
    username: str = Field(
        ...,
        description=(
            "Public handle, and a URL path segment: it addresses `GET /api/v1/users/{username}` "
            "and the site's `/u/{username}` profile page. Compared case-insensitively by the "
            "database, so `/u/Alice` and `/u/alice` resolve to one account. Immutable, which is "
            "what keeps a canonical profile link and its sitemap entry valid indefinitely."
        ),
    )
    display_name: str = Field(
        ...,
        description=(
            "Human-readable name to render in the table's name column. Never null and never "
            "absent: `users.display_name` is `TEXT NOT NULL`, and registration derives it from "
            "the username when none was supplied, so no persisted account lacks one. Declared "
            "exactly as `UserPublic.display_name` is, because both project the same column and a "
            "wire schema wider than the state the database can hold would let an incorrect "
            "projection pass as contract-valid."
        ),
    )
    role: UserRole = Field(
        ...,
        description=(
            "The account's authority - READER, AUTHOR or ADMIN - read from the persisted column "
            "rather than from a token claim, so a promotion or demotion is reflected on the very "
            "next request instead of when an already-issued token expires. Changed through "
            "`PATCH /api/v1/admin/users/{id}`, which is the only route in the API that can."
        ),
    )
    is_active: bool = Field(
        ...,
        description=(
            "Whether the account may authenticate. False means an administrator has suspended it "
            "- the reversible half of moderation, which leaves the account's posts and comments "
            "in place rather than removing them - and a suspended principal is rejected before "
            "reaching any protected route. Unlike a deletion, it is undone by sending true."
        ),
    )
    created_at: datetime = Field(
        ...,
        description=(
            "Instant the account was created, from the database clock, as a timezone-aware ISO "
            "8601 value in UTC - for example `2026-01-15T09:30:00Z`. The default sort key of the "
            "user table, newest first, so a freshly registered account is immediately visible."
        ),
    )
    updated_at: datetime = Field(
        ...,
        description=(
            "Instant the account was last modified, in the same form. Equal to `created_at` until "
            "the first change, so `updated_at > created_at` is a reliable 'has been edited' test. "
            "Published here and not on the public projection because a reader has no interest in "
            "when a byline was last renamed, whereas an administrator reviewing a role change "
            "does."
        ),
    )


class AdminUserUpdate(BaseModel):
    """The body of ``PATCH /api/v1/admin/users/{id}``: authority, active state, or both.

    Two members, both optional, and the model is a closed set - which is the entire point of it.
    The requirement it serves is "change role or active state", and those are precisely the two
    things an administrator decides about an account that the account cannot decide about itself.
    Three bodies are therefore meaningful - a role alone, an active flag alone, or both together -
    where every role is named by a :class:`~app.models.user.UserRole` label::

        {"role": <role label>}
        {"is_active": false}
        {"role": <role label>, "is_active": true}

    A genuine partial update. An omitted member means "leave this as it is" rather than "set this
    to null", and the service reads the difference by dumping only what the caller actually sent::

        changes = payload.model_dump(exclude_unset=True)  # {} for an empty body

    That is the contract the whole-object-replacement ``PUT`` this API replaced could not offer: it
    required a client to resend every field it was not changing, so two administrators editing one
    account from stale reads would silently overwrite each other's work.

    Four members are absent, and each absence is a decision
    ------------------------------------------------------
    ``extra="forbid"`` is what turns each of them from a convention into a contract: a request
    carrying one is rejected with ``422`` and a problem document naming the key, rather than
    accepted with the member quietly discarded. The silent-discard failure mode is the one that
    matters, because a client that believes it changed an email address and was overruled without
    being told will keep believing it.

    ``email`` and ``username``
        Both are ``citext UNIQUE`` identity columns. ``username`` is a URL path segment - it
        addresses ``/u/{username}``, and that URL appears in the page's canonical link, in the
        sitemap and in whatever has already linked to it - so changing it silently invalidates
        every one of those at once, which is the opposite of what the stable-canonical-URL
        requirement asks for. ``email`` is the login identifier, and moving it is an account-
        recovery operation rather than a field edit: it needs proof of control over the new
        address, and email delivery is explicitly out of scope for this service.
    ``password``
        Setting another account's credential is a credential-handling surface this service does
        not have. Password reset and transactional email are out of scope, so there is no
        verification step, no notification to the account holder and no audit trail to hang it on
        - and an administrator who could silently set a password could authenticate as any user
        while leaving a log that says only that a profile was edited. Suspension via
        ``is_active`` is the supported way to stop an account from being used.
    ``id``
        Identity is server-owned. The account being changed is named by the path, and the
        alternative - the client-supplied ``id`` the retired ``Item`` contract used - is exactly
        how one record comes to permanently shadow another.

    ``role`` and ``is_active`` may not be sent as ``null``
    ----------------------------------------------------
    Both columns are ``NOT NULL``. Omission is the way to say "unchanged", so an explicit null is a
    third spelling of nothing, and honouring it would send ``NULL`` at a constraint and surface as
    a ``500`` describing a database error several layers from the member that caused it. The
    validator below refuses it as a ``422`` instead, and neither member advertises ``null`` in
    the published schema - so a generated client cannot offer a state this model refuses. See
    :func:`~app.schemas.common.omit_null_default` for the declaration that keeps the document
    and the behaviour identical.
    """

    model_config = ConfigDict(
        # No unknown member is accepted, and that is the whole enforcement mechanism behind the
        # four absences documented above. Note the contrast with `ProblemDetail` in
        # app.schemas.common, which deliberately does NOT forbid extras: that is an outbound
        # document RFC 9457 permits callers to extend, whereas this is an inbound body where an
        # unrecognised member is always either a client bug or an attempt to write a field the
        # client does not own.
        extra="forbid",
        json_schema_extra={
            # A promotion: the single most common administrative edit, and the one the role
            # enumeration exists for. Spelled from the imported enumeration so the example cannot
            # drift from the type. `is_active` is omitted rather than sent as true, which is what
            # documents that omission means "leave unchanged" - sending true would read as a
            # requirement to restate it.
            "example": {"role": UserRole.AUTHOR.value}
        },
    )

    role: UserRole | SkipJsonSchema[None] = Field(
        default=None,
        json_schema_extra=omit_null_default,
        description=(
            "New authority for the account - READER, AUTHOR or ADMIN. Omit to leave it unchanged. "
            "Takes effect on the account's next request, because every authorisation decision "
            "re-reads this column rather than trusting a token claim, so a demotion does not wait "
            "for an already-issued access token to expire. An administrator may change their own "
            "role, including demoting themselves; the service, not this model, decides whether "
            "the last remaining administrator may do so."
        ),
    )
    """New authority, or omitted to leave it unchanged. Optional but not nullable.

    ``users.role`` is ``NOT NULL``, so omission is the only way to say "unchanged" and an explicit
    null is a third spelling of nothing. :meth:`_reject_explicit_null` refuses it, and the
    published member now says so too: ``SkipJsonSchema[None]`` keeps ``null`` out of the type and
    :func:`~app.schemas.common.omit_null_default` removes the ``default: null`` that would
    otherwise sit beside an enumeration of three values.
    """

    is_active: bool | SkipJsonSchema[None] = Field(
        default=None,
        json_schema_extra=omit_null_default,
        description=(
            "Whether the account may authenticate. Send false to suspend it, true to restore it, "
            "and omit the member to leave it as it is. Suspension is reversible and leaves the "
            "account's posts, comments and likes in place - it is the moderation tool to reach "
            "for first, since `DELETE /api/v1/admin/users/{id}` cascades to all of them and "
            "cannot be undone."
        ),
    )
    """Whether the account may authenticate, or omitted to leave it unchanged.

    The member where the mismatch was most misleading, because ``null`` on a boolean reads as a
    third state. There is none: ``users.is_active`` is ``NOT NULL``, ``false`` suspends, ``true``
    restores, and omission changes nothing. The published type is now a plain boolean, so a
    generated client cannot offer a null it would receive a 422 for.
    """

    @field_validator("role", "is_active")
    @classmethod
    def _reject_explicit_null(cls, value: object, info: ValidationInfo) -> object:
        """Reject an explicitly submitted null for a column that cannot hold one.

        The guard depends on a property of Pydantic that is easy to miss and is load-bearing here:
        a field validator runs only for a value the caller actually supplied, never for a field
        that fell back to its default. So this method never sees the ``None`` that an omitted
        member leaves behind, and ``AdminUserUpdate()`` still validates and still dumps to ``{}``
        under ``exclude_unset=True``. It fires only when ``null`` was written in the request body
        on purpose.

        Without it, that null would survive ``model_dump(exclude_unset=True)`` as a real change,
        reach a ``NOT NULL`` column, and surface as an integrity error - a ``500`` describing a
        database constraint, several layers from the request member that caused it, instead of a
        ``422`` naming the field.

        Declared once for both members rather than twice: they are refused for the identical
        reason, and the field the message names is read from the validation context so the two
        reports stay distinguishable. Typed against ``object`` rather than against the two field
        types because one validator serves both, and narrowing is unnecessary - the only value
        this method inspects is ``None``, and every other value is returned untouched for the
        field's own type to validate.

        Args:
            value: The submitted value. ``None`` only if the caller sent an explicit null.
            info: Validation context, read for the name of the field being validated.

        Returns:
            ``value`` unchanged, once it is known not to be ``None``.

        Raises:
            ValueError: If ``value`` is ``None``. Pydantic renders it as a field-level entry in
                the ``422`` problem document, keyed to the field it came from.
        """
        if value is None:
            msg = (
                f"{info.field_name} may not be null; omit the field to leave the current value "
                "unchanged"
            )
            raise ValueError(msg)
        return value


class AdminPost(BaseModel):
    """A post as an administrator sees it: every lifecycle state, and not the body.

    The item type of the post-management table, and the body returned once a status is forced::

        @router.get("/posts", response_model=Page[AdminPost])
        @router.patch("/posts/{post_id}/status", response_model=AdminPost)

    This listing spans **all three** lifecycle states - ``DRAFT``, ``PUBLISHED`` and ``ARCHIVED``
    - and that is the one property distinguishing it from every public listing in the product.
    ``GET /api/v1/posts`` and ``GET /api/v1/users/{username}/posts`` are scoped to ``PUBLISHED`` in
    the repository's own statement, so a draft can never reach a feed, a category filter result or
    a profile page. The moderation view is the deliberate exception, because an administrator
    cannot moderate what they cannot see: an unpublished post that has been reported has to be
    reachable, and an archived one has to be distinguishable from a deleted one.

    The consequence for the route, not for this model: the status scoping lives in
    ``app.repositories.post_repository``, and it is the presence of ``require_admin`` on the router
    that makes the unscoped query safe to reach. Declaring this class does not widen anything -
    ``app.schemas.post.PostSummary`` also carries a ``status`` member, because an author sees their
    own drafts in their workspace. What is administrative here is the *set of rows*, not the shape.

    ``author`` is ``UserPublic``, never a privileged projection
    ---------------------------------------------------------
    The table needs to know who wrote a post. It does not need that person's login address, role or
    suspension state, and embedding :class:`AdminUser` here - or, worse,
    ``app.schemas.user.UserMe`` - is how a leak spreads: one nested member, and a field that was
    reviewed once in the context of a user table starts appearing beside every post in the system.
    An administrator who needs the author's account details opens the user table, where they are
    the subject of the row rather than an attribute of someone else's.

    ``content`` is absent
    --------------------
    The administrative table lists and moderates; it does not render bodies. Every row of a page
    would otherwise carry a full article, which is the same reason
    ``app.schemas.post.PostSummary`` omits it and ``app.schemas.post.PostDetail`` adds it back for
    the single-resource read. An administrator who needs to read a post before archiving it follows
    ``slug`` to ``/blog/{slug}``, where the post already renders. ``excerpt``,
    ``cover_image_url`` and the category list are omitted for the same reason - they are
    presentation for a reader's card, not evidence for a moderation decision.
    """

    model_config = ConfigDict(
        # Projected from a mapped `app.models.Post`, so attribute access has to be a valid input.
        # `author` requires the relationship to have been loaded - the repository selects it with
        # `selectinload`, and under an async session a missing eager load raises `MissingGreenlet`
        # here rather than silently issuing a query per row, so an N+1 surfaces as a failure.
        from_attributes=True,
        json_schema_extra={
            # The same post and author the sibling modules use. PUBLISHED with a populated
            # `published_at`, because that pairing is the database CHECK constraint made visible:
            # the two members are never independently valid. Both spelled from the imported
            # enumeration so the example cannot name a state the type does not have. `view_count`
            # is 0 because that is what every row of this table actually reports - no endpoint
            # advances the counter - and an example an administrator's table can never match would
            # be a claim about audience that the data does not support.
            "example": {
                "id": "7c9e6a2b-4d81-4f3a-9c5e-2b8d1f0a6e34",
                "title": "Scaling FastAPI",
                "slug": "scaling-fastapi",
                "status": PostStatus.PUBLISHED.value,
                "published_at": "2026-02-03T08:15:00Z",
                "view_count": 0,
                "author": {
                    "id": "7d4c2e91-3b58-4f6a-8c02-1e9b5a7d3f64",
                    "username": "example-author",
                    "display_name": "Example Author",
                    "bio": None,
                    "avatar_url": None,
                    "created_at": "2026-01-04T08:15:00Z",
                },
                "created_at": "2026-02-01T17:42:00Z",
                "updated_at": "2026-02-03T08:15:00Z",
            }
        },
    )

    id: uuid.UUID = Field(
        ...,
        description=(
            "Server-generated identifier, produced by PostgreSQL through `gen_random_uuid()`. This "
            "is the value that addresses `PATCH /api/v1/admin/posts/{id}/status` and "
            "`DELETE /api/v1/admin/posts/{id}`. Note the asymmetry with the public read, which "
            "addresses a post by `slug`: mutation is by identifier because an identifier cannot "
            "change, while a URL is by slug because a slug is what a reader can be shown."
        ),
    )
    title: str = Field(
        ...,
        description=(
            "The post's title as its author wrote it, and the table's primary text column. Free "
            "to change through `PATCH /api/v1/posts/{id}`; the slug derived from it at creation "
            "does not follow, so a canonical URL stays valid after a retitling."
        ),
    )
    slug: str = Field(
        ...,
        description=(
            "URL-safe path segment, derived from the title at creation and de-duplicated on "
            "collision, held unique by a case-insensitive `CITEXT` index. Immutable, which is "
            "what makes `/blog/{slug}` a stable canonical URL. Present here so an administrator "
            "can open the post exactly as a reader sees it before deciding what to do with it."
        ),
    )
    status: PostStatus = Field(
        ...,
        description=(
            "Lifecycle state: DRAFT while unpublished and invisible to the public, PUBLISHED once "
            "visible, ARCHIVED once withdrawn. All three appear in this listing, unlike every "
            "public listing, which is scoped to PUBLISHED. Changed here through "
            "`PATCH /api/v1/admin/posts/{id}/status`, and by the post's own author through the "
            "publish and unpublish transitions on the posts router."
        ),
    )
    published_at: datetime | None = Field(
        ...,
        description=(
            "Instant the post first became public, as a timezone-aware ISO 8601 value in UTC, or "
            "null while it has never been published. Not independent of `status`: a database CHECK "
            "constraint enforces that a PUBLISHED row always carries one, so a non-null value here "
            "beside a DRAFT status means the post was published once and withdrawn since."
        ),
    )
    view_count: int = Field(
        ...,
        # The same bound the public projections in `app.schemas.post` declare, restated here
        # rather than left off, because one column described by two response models under two
        # different constraints is a contract that disagrees with itself - and the looser of the
        # two is the one an administrative client would be written against. It is guaranteed by
        # `ck_posts_view_count_non_negative`, so no legitimate value can violate it and the
        # framework's validation of a handler's return value cannot turn a correct response into
        # a 500.
        ge=0,
        description=(
            "The post's readership counter, never negative - `ck_posts_view_count_non_negative` "
            "enforces that in the schema. Accepted from no input model, so it cannot be set, "
            "reset or back-dated through the API - and **nothing measures it**, because no "
            "endpoint in this API advances it: the value is whatever was written when the post "
            "was created, `0` for one authored through this API and a fabricated figure for one "
            "from the demonstration seed. The column is provided so that counting reads later "
            "needs no change to this contract. Until then, do not present it as an audience "
            "signal and do not sort the table by it: a moderator ranking posts by this column is "
            "ranking them by nothing that was counted."
        ),
    )
    author: UserPublic = Field(
        ...,
        description=(
            "The account that wrote the post, as the public projection - identity and "
            "presentation only. Deliberately not the administrative user projection: this row is "
            "about a post, and an author's login address or suspension state belongs to the user "
            "table, where the account is the subject rather than an attribute of something else."
        ),
    )
    created_at: datetime = Field(
        ...,
        description=(
            "Instant the post was created, from the database clock, as a timezone-aware ISO 8601 "
            "value in UTC. Distinct from `published_at` and, unlike it, always populated - a draft "
            "has a creation instant and no publication instant - so this is the member to render "
            "as a draft's age. It is not the table's sort key: the listing orders by "
            "`published_at` descending with nulls last and `id` descending as the tiebreaker, "
            "which groups the never-published rows together at the end rather than interleaving "
            "them by an instant a reader never sees."
        ),
    )
    updated_at: datetime = Field(
        ...,
        description=(
            "Instant the post was last modified, in the same form. Equal to `created_at` until the "
            "first edit. A forced status change is a modification, so this member moves when an "
            "administrator archives a post - which is what makes it the column to sort by when "
            "reviewing recent moderation activity."
        ),
    )


class AdminPostStatusUpdate(BaseModel):
    """The body of ``PATCH /api/v1/admin/posts/{id}/status``: the state to move the post to.

    One required member, and nothing else - a :class:`~app.models.post.PostStatus` label::

        {"status": <lifecycle label>}

    The route exists because an administrator's authority over a post is not the author's. An
    author publishes and unpublishes their own work through ``POST /api/v1/posts/{id}/publish`` and
    ``.../unpublish``, which are transitions with their own semantics; an administrator forces a
    state on any post, including one they did not write, and archiving someone else's published
    post is the moderation action that motivates the route. ``status`` is required rather than
    optional because a request that names no state is not a partial update of anything - it is a
    request with no instruction in it, and answering ``422`` is more useful than answering ``200``
    to a no-op.

    ``published_at`` is absent, and this is the sharpest example in the package
    -------------------------------------------------------------------------
    The database enforces ``CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL)``. That
    constraint was verified by execution against PostgreSQL 18.4: an insert of a PUBLISHED row
    whose ``published_at`` was null was rejected. The invariant therefore holds even if application
    code is wrong, which is precisely why the instant must not be an input:

    * ``app.services.post_service`` stamps ``published_at`` from the database clock on the
      transition into ``PUBLISHED``, so there is nothing for a caller to supply.
    * A caller who could supply it could back-date a publication - moving a post's position in the
      feed's ``(status, published_at DESC)`` ordering and its ``lastmod`` in the sitemap, without
      any of that being a publication decision.
    * A caller who could supply it could also contradict the state in the same request - naming the
      published state while sending a null instant beside it - turning a clear ``422`` into a
      constraint violation raised from inside the database and rendered as a ``500``.

    ``extra="forbid"`` is what makes the omission enforceable rather than merely documented: the
    field is rejected by name, so a client that believed it set a publication date is told it did
    not. The general rule this is an instance of - let the database hold every invariant it can
    hold, and give application code no way to propose an alternative - is the reason the constraint
    is in the schema at all.

    No other member either
    ---------------------
    Not ``id``: identity is server-owned and the post is named by the path. Not ``title``,
    ``content`` or any other content field: a status route changes a status, and content edits go
    through ``PATCH /api/v1/posts/{id}`` with ``app.schemas.post.PostUpdate``, where the ownership
    rule that governs them is applied. Not a reason or a moderation note: no relation stores one,
    and a member the service would have to discard is worse than no member at all.
    """

    model_config = ConfigDict(
        # See AdminUserUpdate: an unknown member on an inbound body is always a defect, and
        # forbidding it is what makes `published_at` un-settable rather than merely undocumented.
        extra="forbid",
        json_schema_extra={
            # Archiving, because that is the transition this route exists for - publishing and
            # unpublishing one's own post is the author's route. Spelled from the imported
            # enumeration so the example cannot drift from the type.
            "example": {"status": PostStatus.ARCHIVED.value}
        },
    )

    status: PostStatus = Field(
        ...,
        description=(
            "The lifecycle state to move the post to: DRAFT to withdraw it from public listings "
            "while leaving it editable, PUBLISHED to make it public, ARCHIVED to retire it "
            "permanently without deleting it or its comments and likes. Required. The publication "
            "instant is not accepted alongside it - the server stamps it on the transition into "
            "PUBLISHED, and a database CHECK constraint guarantees the two can never disagree."
        ),
    )


class AdminComment(BaseModel):
    """A comment as the moderation queue sees it: every moderation state, as a flat row.

    The item type of the moderation table, and the body returned once a decision is applied::

        @router.get("/comments", response_model=Page[AdminComment])
        @router.patch("/comments/{comment_id}/status", response_model=AdminComment)

    This listing spans **all three** moderation states - ``PENDING``, ``APPROVED`` and ``REJECTED``
    - and that is what makes it a queue rather than a view. ``GET /api/v1/posts/{id}/comments``
    returns approved rows only, scoped in the repository's own statement rather than filtered by a
    client, so an unmoderated comment is never visible publicly. The point of this projection is to
    show an administrator exactly the rows nobody else can see: ``PENDING`` is the work, and
    ``REJECTED`` is the audit trail that makes a decision reversible.

    Flat, not threaded
    -----------------
    ``app.schemas.comment.CommentPublic`` owns the threaded shape and carries a recursive
    ``replies`` list, because a reader consumes a discussion. A queue is a work list: it is ordered
    by submission instant, newest first, across every post in the system, and nesting would hide a
    pending reply underneath an approved parent - which is the one row the moderator was looking
    for.
    :attr:`parent_id` is retained, so a client that wants to show "this is a reply" still can, and a
    moderator can follow it to the comment being answered. A ``replies`` member here would also make
    the query recursive for no benefit, and it would raise a question this shape must not raise:
    whether a nested reply is subject to the same moderation state as the row containing it.

    ``post_title`` and a nested post projection are both absent
    ---------------------------------------------------------
    :attr:`post_id` is the whole of the relationship this row needs. Adding a title, or a nested
    post, would put a join into the one statement that most needs to stay narrow: the queue is
    served by an index on ``comments.status`` and ordered by ``(created_at DESC, id DESC)``, and a
    join per row buys text that the moderator can reach by following the identifier. It is also not
    specified - the requirement is a moderation queue with approve, reject and delete - so adding
    it would be inventing scope, and the cost would be paid on every page load forever.

    Neither is a like tally, a score, nor any count. Likes are a property of a post, not of a
    comment; ``app.schemas.like.LikeSummary`` carries them, and no route in this API attributes them
    to a comment.
    """

    model_config = ConfigDict(
        # Projected from a mapped `app.models.Comment`, so attribute access has to be a valid
        # input. A plain mapping validates too, which is what lets a test feed this model a dict
        # with no session - and what makes the example below a literal description of an accepted
        # input as well as of the wire format.
        from_attributes=True,
        json_schema_extra={
            # The same comment, post and commenter the public projection uses, so a reader
            # comparing the two documents sees exactly what the queue adds and what it drops: no
            # `replies`, and a state that is not APPROVED. PENDING is the state the queue exists
            # for, and it is spelled from the imported enumeration so the example cannot name a
            # label the type does not have. `parent_id` is null here - a top-level comment - which
            # documents that the member is present and nullable rather than omitted on a root.
            "example": {
                "id": "9c2f1b84-0a5e-4d31-8b77-6e4c2a91d503",
                "post_id": "7c9e6a2b-4d81-4f3a-9c5e-2b8d1f0a6e34",
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
                "status": CommentStatus.PENDING.value,
                "created_at": "2026-02-03T11:05:00Z",
                "updated_at": "2026-02-03T11:05:00Z",
            }
        },
    )

    id: uuid.UUID = Field(
        ...,
        description=(
            "Server-generated identifier, produced by PostgreSQL through `gen_random_uuid()`. This "
            "is the value that addresses `PATCH /api/v1/admin/comments/{id}/status` and "
            "`DELETE /api/v1/admin/comments/{id}`."
        ),
    )
    post_id: uuid.UUID = Field(
        ...,
        description=(
            "The post this comment was written on - the whole of the relationship the queue needs. "
            "Follow it to reach the post, whose own projection carries the title and slug; the "
            "title is deliberately not duplicated here, because a join per row would widen the one "
            "statement that most needs to stay narrow across every post in the system."
        ),
    )
    parent_id: uuid.UUID | None = Field(
        ...,
        description=(
            "The comment this one replies to, or null when it is a top-level comment. The member "
            "is always present and only its value can be null, so a client never has to "
            "distinguish an absent key from a null one. Retained even though the queue is flat, so "
            "a moderator can see that a row is a reply and follow it to what it answers."
        ),
    )
    author: UserPublic = Field(
        ...,
        description=(
            "The account that wrote the comment, as the public projection - identity and "
            "presentation only. Deliberately not the administrative user projection: a moderator "
            "who wants to suspend a repeat offender does it from the user table, where the account "
            "is the subject of the row, and embedding privileged fields in a comment listing would "
            "publish them beside every row in the queue for no moderation benefit."
        ),
    )
    body: str = Field(
        ...,
        description=(
            "The comment's text, sanitised on write by `app.services.comment_service` before it "
            "was ever stored, so a moderator reading the queue is never rendering unsanitised "
            "reader-authored content. This is the evidence the moderation decision is made on, so "
            "it is present in full rather than truncated - a queue that elided the text would "
            "require opening every row to act on it."
        ),
    )
    status: CommentStatus = Field(
        ...,
        description=(
            "Moderation state: PENDING while awaiting a decision, APPROVED once public, REJECTED "
            "once refused. All three appear in this listing, unlike the public comment list, which "
            "returns APPROVED rows only. APPROVED and REJECTED are reachable exclusively through "
            "`PATCH /api/v1/admin/comments/{id}/status` - no input model reachable by a comment's "
            "own author carries this member, which is what stops a commenter approving their own "
            "comment. PENDING is reachable a second way: editing an APPROVED comment returns it "
            "here, so replaced text re-enters this queue instead of staying public unreviewed."
        ),
    )
    created_at: datetime = Field(
        ...,
        description=(
            "Instant the comment was written, from the database clock, as a timezone-aware ISO "
            "8601 value in UTC - for example `2026-02-03T11:05:00Z`. The queue's sort key, "
            "**descending**: the most recent submission surfaces first, because the queue is "
            "worked from the top. `id` descending is the tiebreaker, and it is required rather "
            "than decorative - this instant comes from a per-transaction clock, so comments "
            "written by one request share it."
        ),
    )
    updated_at: datetime = Field(
        ...,
        description=(
            "Instant the comment was last modified, in the same form. Equal to `created_at` until "
            "the body is edited, so `updated_at > created_at` is a reliable 'edited' test. An edit "
            "re-opens moderation, so a comment whose body changed after approval is already back "
            "in this queue as PENDING rather than needing to be hunted for; read this member "
            "beside `created_at` to see that the text in front of you is a replacement, and judge "
            "it on its own terms rather than on the earlier decision."
        ),
    )


class AdminCommentStatusUpdate(BaseModel):
    """The body of ``PATCH /api/v1/admin/comments/{id}/status``: the moderation decision.

    One required member, and nothing else - a :class:`~app.models.comment.CommentStatus` label::

        {"status": <moderation label>}

    This is the only input model in the entire service that carries a moderation state, and its
    being here rather than in ``app.schemas.comment`` is deliberate: a body that changes a
    moderation state should not be importable from the module a public router imports. Neither
    ``CommentCreate`` nor ``CommentUpdate`` has a ``status`` member, and both forbid extras, so a
    commenter can neither approve their own comment on the way in nor approve it afterwards. A
    comment is created ``PENDING`` by its column's own server default, and only this payload - on a
    route behind ``require_admin`` at router level - moves it on.

    ``status`` is required rather than optional because a moderation request that names no decision
    is not a partial update of anything. Answering ``422`` tells the client its request was empty;
    answering ``200`` would tell it a decision was recorded when none was.

    ``body`` is absent, and so is everything else
    --------------------------------------------
    An administrator moderates state. Editing the text of someone else's comment is a different
    operation with a different route - ``PATCH /api/v1/comments/{id}`` with
    ``app.schemas.comment.CommentUpdate``, which an administrator may also call, and where the
    ownership-or-admin rule that governs an edit is applied. Keeping the two apart is what makes
    the moderation log unambiguous: a request against this route changed a state and could not have
    changed a word of what the commenter wrote.

    Not ``id`` either - identity is server-owned and the comment is named by the path - and no
    rejection reason, because no relation stores one and a member the service would silently
    discard is worse than no member at all. ``extra="forbid"`` turns each of those into a ``422``
    naming the key.
    """

    model_config = ConfigDict(
        # See AdminUserUpdate: an unknown member on an inbound body is always a defect. Here it is
        # also what keeps `body` un-settable, so this route cannot become a second, unaudited way
        # to edit a comment's text.
        extra="forbid",
        json_schema_extra={
            # Approval, because that is the decision the queue exists to record. Read from the
            # imported enumeration rather than typed as a string, so this example cannot drift
            # from the type it documents - and so nothing here hard-codes a state name.
            "example": {"status": CommentStatus.APPROVED.value}
        },
    )

    status: CommentStatus = Field(
        ...,
        description=(
            "The moderation state to move the comment to: APPROVED to publish it beneath its post, "
            "REJECTED to refuse it while keeping the row for audit, PENDING to return it to the "
            "queue. Required. Reversible in every direction - a rejected comment can be approved "
            "later, which is why rejection is preferred over `DELETE /api/v1/admin/comments/{id}`, "
            "whose cascade removes the comment and every reply to it irrecoverably."
        ),
    )


class AdminStats(BaseModel):
    """The four counts the administrative overview screen renders.

    The response of ``GET /api/v1/admin/stats``::

        {"user_count": 412, "post_count": 87, "comment_count": 1043, "category_count": 6}

    One count per entity the user named - "managing users, posts, comments, and categories" - and
    the four member names are the contract that ``frontend/src/components/admin/stat-card.tsx``
    renders and that the overview page reads. Renaming one here renames it in that component.

    Every count is a total over the whole relation, with no scoping of any kind: ``post_count``
    includes drafts and archived posts, ``comment_count`` includes pending and rejected comments,
    and ``user_count`` includes suspended accounts. That is what makes each number a plain
    ``SELECT count(*)`` and what makes it match the total the corresponding management table
    reports in its own page envelope. A count that agreed with no other number on the screen would
    be worse than no count at all.

    Deliberately four numbers, and nothing more
    ------------------------------------------
    No per-status breakdown, no growth series, no "recent activity" list, no averages, no top
    authors. The specified requirement is aggregate counts for an overview screen, and each
    addition would be a query on the one request an administrator makes before doing anything else
    - a per-status breakdown alone turns four counts into ten, and a growth series turns them into
    a time-bucketed scan. An administrator who wants to know how many posts are drafts filters the
    post table, which is one click away and already paginated. Scope invented here is scope paid
    for on every page load.

    Composed by a service, not by this model
    ---------------------------------------
    ``app.services.admin_service`` is the one place that aggregates across four entities, and it is
    the only cross-entity composition in the service layer. This class contributes no query, no
    session and no arithmetic; it declares the four names, their bounds and their descriptions, so
    that the shape is documented in ``/openapi.json`` and validated on the way out.

    ``from_attributes`` is not enabled, and the absence is meaningful: there is no row to project.
    The service constructs this model from four scalars it counted, so keyword construction is the
    only input, and the Pydantic mypy plugin checks that construction site against these names.
    """

    model_config = ConfigDict(
        json_schema_extra={
            # Plausible rather than round, so the four numbers read as a real installation and not
            # as placeholders: more readers than authors, far more comments than posts, and a
            # deliberately small taxonomy, which is what a curated category set looks like.
            "example": {
                "user_count": 412,
                "post_count": 87,
                "comment_count": 1043,
                "category_count": 6,
            }
        }
    )

    user_count: int = Field(
        ...,
        ge=0,
        description=(
            "Total number of registered accounts, in every role and including suspended ones. "
            "Matches the `total` that `GET /api/v1/admin/users` reports in its page envelope, "
            "because neither is scoped. Never negative, and zero only in a database that has not "
            "been seeded - seeding creates the administrator account, so a running installation "
            "always has at least one."
        ),
    )
    post_count: int = Field(
        ...,
        ge=0,
        description=(
            "Total number of posts in every lifecycle state - DRAFT, PUBLISHED and ARCHIVED. "
            "Deliberately not the published count: it matches the `total` from "
            "`GET /api/v1/admin/posts`, which is also unscoped, so the overview and the table "
            "agree. The public feed's total will be smaller, and the difference is the drafts."
        ),
    )
    comment_count: int = Field(
        ...,
        ge=0,
        description=(
            "Total number of comments in every moderation state - PENDING, APPROVED and REJECTED - "
            "counted across all posts and including replies, which are comments with a parent "
            "rather than a separate relation. Matches the `total` from "
            "`GET /api/v1/admin/comments`; the number visible beneath posts will be smaller, and "
            "the difference is the queue."
        ),
    )
    category_count: int = Field(
        ...,
        ge=0,
        description=(
            "Total number of categories in the taxonomy. Expected to be small and stable - a "
            "curated set an administrator maintains through the category routes, not a free-form "
            "tag cloud - and it matches the number of options the home page's filter control "
            "offers. Zero is possible but not the seeded state, since the initial migration "
            "inserts the reference categories so filtering can be exercised immediately."
        ),
    )
