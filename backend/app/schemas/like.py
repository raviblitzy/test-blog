"""The one shape every like route answers with: an aggregate count, and the caller's own state.

A like is the smallest write in this service - one row of two foreign keys - and its contract is
the smallest to match: one response model, no request model at all, and three fields. Most of
what this module does is decline to declare something, so every refusal is recorded below with
the reason it is a decision rather than an omission.

One model, three routes
-----------------------
:class:`LikeSummary` is the declared ``response_model`` of all three like routes::

    @router.put("/posts/{post_id}/like", response_model=LikeSummary)
    @router.delete("/posts/{post_id}/like", response_model=LikeSummary)
    @router.get("/posts/{post_id}/likes", response_model=LikeSummary)

Answering the two mutations with the settled summary rather than with a bare acknowledgement is
a deliberate decision. ``frontend/src/components/blog/like-button.tsx`` applies a like
optimistically - it fills the icon and increments its own tally before the request completes -
and reconciling that guess needs the authoritative pair of values. Returning them from the
mutation is one round trip where a write followed by a read would be two, and the number the
reader is left looking at is then the one the database holds rather than the client's arithmetic.

That is also why unliking does **not** answer ``204 No Content``, unlike deleting a category or
logging out. ``app.schemas.common`` permits exactly three response shapes - a page envelope for
a collection, a bare representation for a single resource, a problem document for a failure - and
this is the second of them rather than a fourth. A body is returned here because there is a
settled value to report; after a category is deleted there is none.

Idempotency belongs to the key, so it is not a field
---------------------------------------------------
``app.models.PostLike`` has no surrogate key: its primary key *is* ``(post_id, user_id)``.
Measured rather than assumed - two identical conflict-ignoring inserts against PostgreSQL 18.4
left the row count at **one**. ``PUT /api/v1/posts/{id}/like`` is therefore safe to retry, and no
application-level de-duplication exists anywhere in this backend or is wanted.

That is the whole reason this module declares no request model. There is nothing a client could
put in a body that would change the outcome: the post arrives in the path, the principal arrives
from ``app.core.dependencies``, and a repeated request settles on the same row and the same
summary as the first. So there is no ``LikeCreate``, no ``LikeRequest``, no "already liked" flag
for a caller to assert and no version token for it to echo. An input model here would invent a
surface the API does not have, and each of those members would be a second, weaker copy of a
rule the composite primary key already enforces for every writer - the ORM, a migration, and a
statement typed into ``psql`` alike.

What this response deliberately does not carry
----------------------------------------------
``id``
    There is no surrogate identifier to publish. The pair ``(post_id, user_id)`` *is* the
    identity of the row, so an invented ``id`` would misrepresent the relation - and would read
    as licence to add a surrogate key to the mapped class, which is exactly what would let two
    identical likes become two distinct rows and inflate the count. The contract this service
    replaced did the opposite: it accepted ``id: int`` from the client on write, generating
    nothing and checking nothing, so a duplicate identifier was storable.
``user_id``
    ``liked_by_caller`` answers the caller's question about *themselves*. Publishing the
    identifiers of the accounts that liked a post would disclose one reader's activity to
    another, and there is no "who liked this" route anywhere in this service's REST surface to
    return them from. The narrow field is not a reduced version of a fuller one; it is the whole
    of what the product asks for and the whole of what may safely be told.
``created_at``
    A like has exactly one instant - ``PostLike.created_at``, from the database clock - and no
    specified surface renders it. Neither the post page nor a profile shows *when* a like was
    granted, so the column stays server-side, where it orders rows and supports an audit.
a collection of likers
    No ``Page[...]`` of accounts, and no embedded ``likers`` or ``users`` member. That would be
    the page envelope answering a route that does not exist, and it would carry precisely the
    identities the paragraph above withholds.
a message envelope
    No wrapper pairing a human-readable ``message`` key with a nested ``data`` key. The service
    this repository grew out of put one around three of its five routes - its create and update
    responses nested the item beside a sentence of prose, and its delete response carried the
    sentence alone - while its two reads returned bare payloads, so a client could not tell from
    the route which of the two shapes it would receive. That inconsistency is being deleted, not
    relocated into this module.

The read route is public, and still caller-aware
------------------------------------------------
``GET /api/v1/posts/{id}/likes`` requires no credential, because a like count is public
information; the two mutations require one, because writing a like is an act attributed to an
account. The read therefore resolves its principal through ``get_current_user_optional`` in
``app.core.dependencies``, which yields ``User | None``, and ``liked_by_caller`` is ``False``
for the anonymous case rather than ``null`` or absent. One shape serves both audiences, and a
client never has to distinguish "no session" from "has not liked".

Cross-tier contract: both names are final
-----------------------------------------
``frontend/src/lib/types.ts`` mirrors this model field for field and
``frontend/src/components/blog/like-button.tsx`` reads it, in snake_case, with no camelCase
mapping layer anywhere in that tier. ``like_count`` is therefore spelled out rather than shortened
to ``count``, which would be ambiguous the moment it sat beside ``view_count`` on the same post,
and ``liked_by_caller`` names the subject of the question rather than leaving it to be inferred
from a bare ``liked``. Renaming either member after this point is a breaking change to the
generated OpenAPI document, to the client contract types and to the endpoint reference at once.

What lives elsewhere
--------------------
Declarations, and nothing else. The conflict-ignoring insert and the ``COUNT`` belong to
``app.repositories.like_repository``; the idempotent like and unlike operations and the
assembly of the caller's state to ``app.services.like_service``; the mapping of a missing post
onto ``404`` to ``app.core.exceptions``; the status codes and the dependency wiring to
``app.api.v1.routers.likes``. No statement, no session and no status-code decision appears in
this file.

Import purity
-------------
Two sources, and no more: ``pydantic`` and the standard library.

Not ``app.models``. Importing the mapped class would drag SQLAlchemy, and with it the engine's
import graph, into the schema layer, and would buy nothing: ``from_attributes`` validates by
attribute name and needs no reference to the type it reads from. A bare ``PostLike`` is not a
source for this model in any case, since two of these three values are not columns of that row.

Not ``app.schemas.common``, since no like route returns a collection and the problem document is
named by the router's ``responses=`` mapping rather than by this module. Not
``app.core.dependencies``, which resolves the principal for the route, not for the shape. Not
``app.core.config`` and not ``os.environ``: importing this module performs no I/O, opens no
connection and reads no setting, which is what lets a unit test import it with nothing running.
"""

import uuid

from pydantic import BaseModel, ConfigDict, Field

__all__ = ["LikeSummary"]


class LikeSummary(BaseModel):
    """How many accounts have liked one post, and whether the account asking is one of them.

    Two values that a client needs together and never separately: the like button renders its
    tally and the fill state of its own icon from one payload, so splitting them across two
    models would only give a caller a way to hold a half-updated view. ``post_id`` travels with
    them so the payload identifies itself - a client caching or merging by post reads the key
    out of the body instead of tracking which request a response belongs to.

    Validated from whatever the layer below produced
    -----------------------------------------------
    This summary is not the projection of one row: ``post_id`` is echoed from the path, the tally
    is an aggregate issued by ``app.repositories.like_repository``, and the caller's state is a
    predicate ``app.services.like_service`` resolves beside it. ``from_attributes`` is enabled so
    that however that layer hands the three values over - an object carrying them as attributes,
    or the row of an aggregate select - is a valid input. All three forms therefore validate::

        LikeSummary.model_validate(row)  # an object, by attribute
        LikeSummary.model_validate(row._mapping)  # an aggregate select, by key
        LikeSummary(post_id=post_id, like_count=count, liked_by_caller=liked)

    Every field is required and none carries a default, so a service that forgets to resolve the
    caller's state fails validation loudly instead of quietly reporting ``False`` to someone who
    has in fact liked the post. Nothing on this class is a method: counting, liking, unliking and
    answering "has this caller liked it" all live in the repository and service modules named in
    the module docstring.
    """

    model_config = ConfigDict(
        # The summary is assembled a layer down and may arrive as an object with these three
        # attributes attached or as the row of an aggregate select, so attribute access has to
        # be a valid input. A plain mapping still validates as well, which is what lets a
        # repository feed this model straight from `row._mapping` without materialising an
        # entity - and what makes the model testable with a two-line stand-in object.
        from_attributes=True,
        json_schema_extra={
            # Published verbatim in /openapi.json and rendered on /docs, so it is written for a
            # reader of the documentation: a post with a plausible tally, seen by a caller who
            # has already liked it, which is the state the filled icon corresponds to.
            "example": {
                "post_id": "3f6b1c8a-4d2e-4f7b-9c1a-8e5d2b7a6c04",
                "like_count": 42,
                "liked_by_caller": True,
            }
        },
    )

    post_id: uuid.UUID = Field(
        ...,
        description=(
            "Identifier of the post this summary describes, echoed from the path parameter. "
            "Present so the payload is self-describing: a client keying a cache by post, or "
            "merging this response into a list it already holds, reads the key out of the body "
            "rather than tracking which request produced it."
        ),
    )
    like_count: int = Field(
        ...,
        # A COUNT cannot be negative, so the bound costs nothing and documents the guarantee in
        # /openapi.json. It is safe here in a way the same bound on `Page.page` would not be:
        # FastAPI validates what a handler returns against its declared response model - a
        # projected row or mapping is checked on the way out, verified against the pinned
        # 0.141.1 - so a constraint a legitimate value can violate turns a correct response into
        # a 500. This value is produced by an aggregate over a relation whose primary key forbids
        # duplicate rows, and so has no such case.
        ge=0,
        description=(
            "How many distinct accounts have liked this post. Distinct by construction rather "
            "than by de-duplication: `post_likes` is keyed on `(post_id, user_id)`, so a "
            "repeated like is not a second row and cannot inflate this number. Zero is a real "
            "value - a post nobody has liked yet - and is returned as `0`, never omitted and "
            "never null."
        ),
    )
    liked_by_caller: bool = Field(
        ...,
        description=(
            "Whether the account making this request has liked this post. Always `false` - "
            "never null, and never absent - for an anonymous caller, which is why the public "
            "read resolves its principal through the optional-user dependency instead of "
            "requiring a bearer token: the count is public, so a reader with no session still "
            "receives a complete summary. `true` after a successful like and `false` after a "
            "successful unlike, so a client may treat it as the settled state rather than as a "
            "guess awaiting confirmation."
        ),
    )
