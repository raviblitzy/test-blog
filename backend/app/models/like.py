"""The ``post_likes`` relation: a reader's approval of a post, keyed so it cannot be doubled.

One relation, three columns, and one idea the whole file exists to express - the primary key is
``(post_id, user_id)``, so a second identical like is not a second row. Idempotency is a property
of the *shape of the key* rather than a rule some code path has to remember to apply, and it
therefore holds for every writer: the ORM, a migration, a statement typed into ``psql``, and not
merely the paths that went through a check.

Measured rather than assumed. Two identical inserts through ``ON CONFLICT DO NOTHING`` against
PostgreSQL 18.4 left the row count at **one**. Two consequences follow, and both are load-bearing
elsewhere in the system:

* ``PUT /api/v1/posts/{id}/like`` is safe to retry. A client resending after a timeout, a proxy
  duplicating a request, a reader double-clicking - none of them can inflate a count. That is what
  lets the frontend apply the like optimistically before the response arrives, because there is no
  outcome in which the retry corrupts the total.
* **No application-level de-duplication exists anywhere in the backend, and none is wanted.**
  ``app.services.like_service`` does not look for an existing like before writing one, and
  ``app.repositories.like_repository`` does not either - the repository issues a conflict-ignoring
  insert and the key decides. A guard layered on top would be a second, weaker copy of a rule the
  database already enforces exactly, and it would race: a check followed by an insert is two
  statements with a window between them, and two concurrent requests can both find nothing.

Why neither mixin applies
-------------------------
This is the only mapped class in ``app.models`` that takes neither mixin ``app.db.base`` offers,
and both omissions are deliberate rather than economical.

:class:`~app.db.base.UUIDPrimaryKeyMixin` is excluded because it would contribute a surrogate
``id`` and make *that* the primary key. ``(post_id, user_id)`` would then be unique only by
convention, two identical likes would become two distinct rows carrying different identifiers, and
the count would inflate - precisely the failure this design exists to make impossible. The mixin
says so itself: do not mix it into an association relation, because adding a surrogate key
alongside permits the duplicate rows the composite key exists to forbid. There is no surrogate
identity here, and its absence is not an exception to server-owned identity but a consequence of
the natural key *being* the identity.

:class:`~app.db.base.TimestampMixin` is excluded because it contributes ``created_at`` **and**
``updated_at``, and a like has no second state to record: it is granted, or it is withdrawn, and
withdrawing it deletes the row. An ``updated_at`` would describe nothing - and concretely, it
would be a column present in ``Base.metadata`` and absent from revision ``0001``, so
``alembic check`` would report drift on a freshly migrated database before a single feature was
built. The ``created_at`` this relation does want is declared directly on the class instead,
exactly as ``app.models.refresh_token`` does and exactly as that mixin's own documentation invites.

Deletion
--------
Both foreign keys are ``ON DELETE CASCADE``, so removing a post takes its likes with it and
removing an account takes every like it granted. Pushing that into the database rather than into a
service is what makes it true for every writer, and it is the half of the pairing that
``passive_deletes=True`` on ``Post.likes`` and ``User.likes`` depends on: with it, SQLAlchemy lets
PostgreSQL remove the child rows as part of the parent ``DELETE`` instead of loading the whole
collection in order to delete it a row at a time.

Import direction
----------------
Nothing here imports a sibling model at run time, and nothing may. ``app.models.post`` and
``app.models.user`` both import :class:`PostLike` under ``TYPE_CHECKING`` for their reverse
annotations, so a runtime import in this direction would close a genuine cycle and make the import
order of ``app.models`` load-bearing. Neither is needed: both foreign keys name their target as a
string, which the metadata resolves when it is first used, and both relationships resolve their
target class by name through the declarative registry when mappers are configured.

Cross-file contract
-------------------
``migrations/versions/0001_initial_blog_schema.py`` creates this relation, and the two descriptions
must agree object for object or ``alembic check`` reports drift that no schema change caused. What
the revision has to render:

* ``post_likes`` with exactly three columns - ``post_id``, ``user_id``, ``created_at`` - and no
  fourth. A surrogate ``id`` or an ``updated_at`` here is drift, and it is the likeliest drift in
  this relation because both arrive by simply reaching for the usual mixins.
* ``PRIMARY KEY (post_id, user_id)``, in that column order, which the naming convention in
  ``app.db.base`` resolves to ``pk_post_likes``.
* Both foreign keys ``ON DELETE CASCADE``, resolving to ``fk_post_likes_post_id_posts`` and
  ``fk_post_likes_user_id_users``.
* ``created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()``. The ``server_default`` half is
  not optional: omit it and ``compare_server_default`` reports drift, because the model then
  expects a default the table does not have.
* ``ix_post_likes_user_id`` over ``user_id``.

Its ``downgrade`` drops the table, which takes the key, both foreign keys and the index with it.

What is deliberately not here
-----------------------------
Schema, and nothing else. This module holds no query, no session, no ``ON CONFLICT`` clause, no
aggregate and no "has this caller liked it" predicate - not as a classmethod, not as a hybrid
property.

That boundary is worth stating precisely, because ``GET /api/v1/posts/{id}/likes`` returns a count
plus the caller's own state, and it would be easy to read that as this class's job. It is not. The
conflict-ignoring insert and the aggregate belong to ``app.repositories.like_repository``, the
idempotent like and unlike operations and the caller-state assembly to
``app.services.like_service``, and the response shape to ``app.schemas.like``. A count kept here
would be one of two bad things: a stored counter, which is a second source of truth that every
like, unlike and cascading delete has to remember to update, or ``len()`` over a loaded
collection, which fetches every row to return one number.

There is no ``__repr__`` either, matching :mod:`app.db.base` and every sibling model. A useful one
has to read mapped attributes, and under an ``AsyncSession`` an attribute expired by the last
commit is a lazy load, which raises ``MissingGreenlet`` at the point of access; a debugging
convenience is a poor reason to put that hazard in a model.

Finally, this module reads no configuration. It imports SQLAlchemy and the standard library,
touches no environment variable, does not import ``app.core.config`` or ``app.db.session``, and has
no import-time side effect beyond registering one table on ``Base.metadata``. That is what lets
``alembic check`` and ``tests/conftest.py`` resolve it with no database reachable and no ``.env``
file present.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Final

from sqlalchemy import DateTime, ForeignKey, Index, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

if TYPE_CHECKING:
    # Annotation-only imports, and they must stay that way. See "Import direction" in the module
    # docstring: post.py and user.py each import this module under TYPE_CHECKING for the reverse
    # side of these relationships, so a runtime import either way closes a cycle.
    from app.models.post import Post
    from app.models.user import User

__all__ = ["PostLike"]

_ASSOCIATION_KEY_TYPE: Final[UUID[uuid.UUID]] = UUID(as_uuid=True)
"""Column type shared by both foreign keys of :class:`PostLike`.

``app.db.base.UUIDPrimaryKeyMixin`` asks that a model referencing one of its ``id`` columns spell
the same type out, so the two sides of the reference are visibly identical. Declaring it once
satisfies that for both columns at the same time; the alternative is one expression written twice,
which is a single edit away from disagreeing. ``app.models.category`` shares one instance across
the two columns of ``post_categories`` for exactly this reason.

Reusing a single :class:`~sqlalchemy.types.TypeEngine` instance across columns is the ordinary
SQLAlchemy pattern rather than a shortcut - these objects carry no per-column state, which is why
``app.db.base.Base.type_annotation_map`` shares one ``Text()`` across every string column in the
schema.

``as_uuid=True`` is what makes the driver hand back :class:`uuid.UUID` objects instead of strings,
so a value read out of this relation compares equal to ``Post.id`` and ``User.id`` with no cast at
the call site.
"""


class PostLike(Base):
    """One account's like of one post, identified by the pair rather than by a surrogate key.

    Subclasses :class:`~app.db.base.Base` and takes neither mixin; the module docstring explains
    why each is excluded and what breaks if either is added back.

    Writing one is assignment through a relationship or a conflict-ignoring insert, both issued
    from ``app.repositories.like_repository``::

        like = PostLike(post_id=post.id, user_id=principal.id)

    ``created_at`` is left unset on purpose - PostgreSQL stamps it from its own clock, so two likes
    written by different workers are ordered by one clock rather than by however many application
    clocks happened to be involved.

    Reading ``like.post`` or ``like.user`` requires the statement that fetched the row to have
    loaded it, with ``joinedload()`` in the repository layer. Both relationships keep SQLAlchemy's
    default lazy strategy deliberately: under an ``AsyncSession`` a lazy load raises
    ``MissingGreenlet`` at the point of access, which surfaces a missing eager-load option
    immediately instead of hiding an extra round trip behind a request that still succeeds.

    Nothing on this class is a method. It is a mapped shape: liking, unliking, counting and
    resolving whether the caller has already liked a post all live in
    ``app.repositories.like_repository`` and ``app.services.like_service``.
    """

    __tablename__ = "post_likes"

    # The index is declared here rather than as `index=True` on the column, so it is stated exactly
    # once and its name is greppable in the source - which is what lets revision 0001's downgrade
    # drop it by name with confidence. Verified against SQLAlchemy 2.0.51 rather than assumed: this
    # name is byte-identical to what the `ix_%(column_0_label)s` convention in app.db.base derives
    # from `index=True`, and both spellings compile to the same CREATE INDEX. So it is
    # documentation, not an override, and it introduces no drift. Declaring it BOTH ways would ask
    # for two objects over one column.
    __table_args__ = (
        # The composite primary key leads with post_id, and a composite index cannot be read from
        # its second column. So the key already answers "who liked this post?" - the count on the
        # post page, and the cascade PostgreSQL performs when the post itself is deleted - while
        # "what has this account liked?" would have no usable access path without this index. That
        # is the direction a reader's own activity is queried from, and the direction the cascade
        # behind a deleted account takes.
        Index("ix_post_likes_user_id", "user_id"),
    )

    post_id: Mapped[uuid.UUID] = mapped_column(
        # Type spelled out to match `posts.id` exactly; see _ASSOCIATION_KEY_TYPE above.
        _ASSOCIATION_KEY_TYPE,
        # A string target rather than an imported Column: resolving "posts.id" is deferred until
        # the metadata is used, which is what keeps this module importable with no runtime edge to
        # app.models.post.
        #
        # ON DELETE CASCADE is mandatory rather than a convenience. A like that points at a post
        # nobody can fetch is unreachable data that still counts, so deleting a post must take its
        # likes with it - and in the database, so every writer obeys it. Its counterpart is
        # passive_deletes=True on Post.likes; see "Deletion" in the module docstring.
        ForeignKey("posts.id", ondelete="CASCADE"),
        # Half of the composite primary key. Together with user_id this is the whole of this
        # relation's identity, and it is what makes a repeated like a no-op rather than a second
        # row. NOT NULL follows from being part of the key, and is stated for symmetry with the
        # revision that renders the column.
        primary_key=True,
        nullable=False,
    )
    """The post that was liked, and the first column of the composite primary key.

    Leading the key is deliberate: the key's own index is therefore the access path for every
    per-post question - the like count, and the rows PostgreSQL removes when the post is deleted.
    """

    user_id: Mapped[uuid.UUID] = mapped_column(
        _ASSOCIATION_KEY_TYPE,
        # Deleting an account must leave behind no like still attributed to it, and no row whose
        # user_id resolves to nothing. Counterpart: passive_deletes=True on User.likes.
        ForeignKey("users.id", ondelete="CASCADE"),
        # The other half of the composite primary key. The pair (post_id, user_id) is UNIQUE by
        # construction because it IS the primary key - there is no separate unique constraint to
        # keep in step with it, and no application-level check that could drift from it.
        primary_key=True,
        nullable=False,
    )
    """The account that granted the like, and the second column of the composite primary key.

    Indexed separately through ``ix_post_likes_user_id`` above, because the key cannot be read from
    its second column and "what has this account liked?" is a question the product asks.
    """

    created_at: Mapped[datetime] = mapped_column(
        # timezone=True throughout the schema. Base.type_annotation_map would resolve the
        # `datetime` annotation to the same TIMESTAMP WITH TIME ZONE; stating it keeps the column
        # readable beside the revision that renders it, exactly as TimestampMixin does.
        DateTime(timezone=True),
        nullable=False,
        # From the database clock. This is the column TimestampMixin would have contributed; it is
        # declared here because that mixin brings `updated_at` with it and this relation has no
        # state an `updated_at` could describe.
        server_default=func.now(),
    )
    """Instant the like was granted, from the database clock. Never updated.

    There is no ``updated_at`` beside it, and its absence is deliberate rather than an oversight: a
    like is granted or withdrawn, and withdrawing it deletes the row, so there is no modification
    for a second audit column to record. Revision ``0001`` creates this column and no other
    timestamp; adding one would be immediate ``alembic check`` drift.
    """

    post: Mapped[Post] = relationship(
        # The reverse side is Post.likes, and the two strings must agree exactly or mapper
        # configuration fails at startup. The target class is resolved by name through the
        # declarative registry, so the TYPE_CHECKING import above stays annotation-only.
        back_populates="likes",
        # No cascade= and no passive_deletes= on this many-to-one side, deliberately. Both belong
        # on the collection side, which owns the parent-to-child relationship: Post.likes declares
        # cascade="all, delete-orphan" with passive_deletes=True, pairing with the ON DELETE
        # CASCADE on post_id above. Repeating either here would point the cascade the wrong way -
        # removing a like must never delete the post it was granted to.
    )
    """The post this like was granted to, the entity side of the ``post_id`` foreign key.

    Present so a row can reach its post without a second lookup, given the statement asked for it
    eagerly. The like *count* is not read through this relationship in either direction; it is an
    aggregate issued by ``app.repositories.like_repository``.
    """

    user: Mapped[User] = relationship(
        # Reverse side: User.likes. Same reasoning as `post` above - the collection side owns the
        # cascade, and deleting a like must never delete the account that granted it.
        back_populates="likes",
    )
    """The account that granted this like, the entity side of the ``user_id`` foreign key.

    Present so a row can reach its principal without a second lookup, given the statement asked for
    it eagerly. Whether the *calling* principal has liked a post is resolved by a predicate in
    ``app.repositories.like_repository``, not by walking this relationship.
    """
