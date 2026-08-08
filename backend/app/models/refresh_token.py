"""The ``refresh_tokens`` relation - the revocable half of the token pair.

One name is declared here: :class:`RefreshToken`, the mapped class behind the
``refresh_tokens`` table. It exists for a single reason, and the reason is a property of JWTs
rather than a preference: a signed access token is *stateless*, so nothing short of waiting for
it to expire can withdraw it. Keeping access tokens short-lived is what bounds that exposure,
and it is only tolerable if the client can quietly obtain a new one - which is the long-lived
half of the pair, issued as an opaque random string and recorded here, where a row can be
marked spent. Statelessness buys the access token its speed; this relation buys the session its
revocability.

``app.services.auth_service`` is the only consumer. It inserts a row when a token pair is
issued, finds a presented token by its hash to rotate it, stamps :attr:`revoked_at` on logout
and on detected reuse, and reads :attr:`expires_at` to reject a token whose life has run out.
Those three columns are what make "refresh rotates the refresh token; logout revokes it; a
revoked or expired token yields ``401``" enforceable against stored state rather than a
convention every call site has to remember. ``app.models.__init__`` re-exports the class so
this relation is present in ``Base.metadata`` for the migration runner and the test harness,
and :attr:`app.models.user.User.refresh_tokens` is the collection on the other side of the
foreign key.

The token itself is never stored
--------------------------------
This is the single most important property of the relation, and every other decision below
follows from it. :attr:`token_hash` holds a **hash of** the issued token, never the token, so a
reader of this table - a leaked backup, an over-broad database grant, an operator running an ad
hoc query - obtains no usable credential. There is nothing here to steal and replay.

The hash is a **deterministic SHA-256 hex digest**, produced by
``app.core.security.hash_refresh_token``, and the determinism is load-bearing rather than a
weaker choice made for convenience. Rotation has to answer "which row is this token?", which is
an equality lookup on a value the client supplies; a salted hash such as argon2id differs on
every computation, so it can only be *verified* against a row already in hand and can never
*find* one. Salting is exactly right for ``users.password_hash``, where the row is located by
email first and the hash is only ever verified, and exactly wrong here, where the hash is the
lookup key. The tradeoff is deliberate and safe in this direction: the pre-image is 32 bytes of
cryptographically random data from
:func:`~app.core.security.generate_refresh_token`, not a human-chosen password, so the
brute-force and rainbow-table attacks a salt defends against have no purchase.

That makes the UNIQUE constraint on :attr:`token_hash` part of the mechanism rather than
hygiene. It is the index the lookup rides on, and it simultaneously guarantees that one
digest identifies at most one row - so rotation cannot match two candidates and be forced to
choose, and a repeated insert of the same digest fails loudly instead of creating a second,
silently divergent record of one token. Under the naming convention in :mod:`app.db.base` it
resolves to ``uq_refresh_tokens_token_hash``.

Why the column is ``Text`` and not ``CITEXT``
---------------------------------------------
Three columns in this schema are deliberately ``CITEXT`` - ``users.email``, ``users.username``
and the two slugs - because ``Alice`` and ``alice`` must be one account and ``/u/Alice`` and
``/u/alice`` one profile. A digest is the opposite case. It is a machine-generated token in a
fixed alphabet, compared for exact identity and never typed by a human, so a case-insensitive
comparison would widen the set of strings that match a stored credential for no benefit
whatsoever. ``Text`` - which is what :attr:`app.db.base.Base.type_annotation_map` resolves a
bare ``str`` annotation to, and which is passed explicitly here so the intent is legible next
to the column - keeps the comparison case-sensitive and exact.

Nothing constrains the length either, and that is the same judgement ``users.password_hash``
makes: SHA-256 renders as 64 hexadecimal characters today, and a length cap would turn any
future change of digest into a schema migration for a column PostgreSQL stores identically
regardless.

Three instants, one lifecycle, and no ``updated_at``
----------------------------------------------------
A token is issued once and then reaches exactly one of two terminal states, so three columns
describe its whole life: :attr:`created_at` records the issuance, :attr:`expires_at` the moment
it lapses on its own, and :attr:`revoked_at` the moment it was withdrawn early.

This relation therefore mixes in :class:`~app.db.base.UUIDPrimaryKeyMixin` but **not**
:class:`~app.db.base.TimestampMixin`, and declares :attr:`created_at` directly instead. That is
the mixin's own documented intent rather than an exception to it - it contributes ``created_at``
*and* ``updated_at``, and there is no third state here an ``updated_at`` could describe, because
both ways this row can change are recorded in columns of their own. The consequence if the mixin
were applied anyway is immediate and mechanical: revision ``0001_initial_blog_schema`` creates no
``updated_at`` on this table, so the model would describe a column the database does not have and
``alembic check`` would report drift that no schema change caused. It is the highest-risk
mistake available in this file, which is why the model states it, the revision agrees with it,
and a test asserts ``"updated_at" not in RefreshToken.__table__.c``.

:attr:`revoked_at` is nullable, and the nullability *is* the revocation flag. ``NULL`` means
"never withdrawn"; a timestamp means "withdrawn, and here is when". A separate boolean would be
a second source of truth for one fact, and would answer "is it revoked?" while losing "when?" -
which is the question rotation-reuse detection and any later audit both need. Every other column
is ``NOT NULL``, because an issuance with no owner, no digest, no expiry or no creation instant
is not a partially-recorded token but a meaningless row.

Deletion
--------
:attr:`user_id` carries ``ON DELETE CASCADE``, so deleting an account removes its outstanding
tokens in the same statement, inside the same transaction. Its counterpart on
:attr:`app.models.user.User.refresh_tokens` is ``passive_deletes=True``, and neither half is
optional: the cascade without the flag is correct but makes SQLAlchemy load every token row into
the session to delete it one at a time, and the flag without the cascade orphans them. The
database guarantees it, so no service has to remember to.

Rows are kept, not cleaned up, once they are spent. An expired or revoked token is the evidence
that lets rotation recognise the reuse of a digest that has already been exchanged, which is a
signal that a token leaked - deleting the row would delete the detection. Sweeping genuinely
dead rows is an operational task served by the index on :attr:`expires_at`, and it belongs to
whatever runs it, not to this module.

What is deliberately not here
-----------------------------
Schema only. Nothing in this file generates a token, hashes one, compares one or decides whether
one is still good. :func:`~app.core.security.generate_refresh_token` and
:func:`~app.core.security.hash_refresh_token` own the first two; ``app.services.auth_service``
owns the last two. In particular there is no ``is_valid`` method and no ``is_expired`` property:
both would compare a column against the current time, which is a business rule with a clock
dependency, and putting it on the mapped class would make it unreachable to a test that wants to
control that clock and invisible to the query that should be filtering in SQL. There is likewise
no statement, no :class:`~sqlalchemy.orm.Session` and no HTTP concern - every statement in the
backend is built in ``app.repositories.*``, which is the only layer permitted to build one.

It reads no configuration. The token lifetime is ``REFRESH_TOKEN_EXPIRE_DAYS``, and
``app.core.security`` applies it when it computes the instant that is stored in
:attr:`expires_at`; this module holds the resulting value and never learns where it came from.
No environment variable, no import of ``app.core.config``, and no import-time side effect of any
kind - ``alembic check`` has to resolve this module with no database reachable and no ``.env``
present, and it does.

Nor does it re-declare what it inherits: ``id`` comes from
:class:`~app.db.base.UUIDPrimaryKeyMixin` and appears nowhere below, because re-declaring it
would shadow the mixin's column and put identity back in the application's hands.

Finally there is no ``__repr__``, matching :mod:`app.db.base` and both sibling models. The
general reason applies here - a useful one has to read mapped attributes, and reading an
unloaded or expired attribute under an ``AsyncSession`` raises ``MissingGreenlet`` rather than
returning a string - and a sharper one applies as well: the most interesting attribute on this
class is a credential derivative, and a ``__repr__`` is precisely the thing that ends up
interpolated into a log line, a traceback frame or an error report. The class has no method at
all, so there is no path by which this row renders itself anywhere.

Cross-file contract
-------------------
* ``migrations/versions/0001_initial_blog_schema.py`` renders this relation. It must create
  exactly the objects declared below - the table, the ``users.id`` foreign key with
  ``ondelete="CASCADE"``, the UNIQUE constraint on ``token_hash``, and the two indexes - and
  must render ``id`` as ``postgresql.UUID(as_uuid=True)`` with
  ``server_default=sa.text("gen_random_uuid()")``, because ``alembic check`` compares server
  defaults and would otherwise report drift. It creates no ``updated_at``, matching this model.
* ``app.models.__init__`` must re-export :class:`RefreshToken`. A mapped class the migration
  runner never imports is a relation ``alembic check`` cannot see, so autogenerate would offer
  to drop the table rather than report it as current.
* ``app.models.user`` declares the other side of the foreign key. Both ends name each other
  through ``back_populates``, so the two strings - ``"refresh_tokens"`` here and ``"user"``
  there - must stay in agreement or mapper configuration fails at startup.
* ``app.core.security`` owns the digest, and its determinism is what the UNIQUE constraint
  above makes useful. Changing that function to a salted scheme would silently break every
  lookup against this table, not merely change the stored value.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, Index, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    # Annotation-only import, and it must never become a runtime one. app.models.user
    # imports THIS module under TYPE_CHECKING for the reverse annotation, so a runtime
    # import here would close a genuine cycle and make the import order of app.models
    # load-bearing. The foreign key below is expressed as the string "users.id" and the
    # relationship target is resolved by class name through the declarative registry when
    # mappers are configured, so neither needs the class object at import time.
    from app.models.user import User

__all__ = ["RefreshToken"]


class RefreshToken(UUIDPrimaryKeyMixin, Base):
    """A single issued refresh token, recorded as a hash so the row is not a credential.

    Six columns, one of them inherited: ``id`` comes from
    :class:`~app.db.base.UUIDPrimaryKeyMixin` and is generated by PostgreSQL through
    ``gen_random_uuid()``, never supplied by a caller. The other five are declared below in the
    order the entity-relationship design lists them, and no ``sort_order`` is needed to keep
    them there - the mixin already sorts ``id`` to the head of the table, these five follow in
    declaration order, and column position is invisible to ``alembic check``, which compares
    columns by name.

    :class:`~app.db.base.TimestampMixin` is deliberately absent; see "Three instants, one
    lifecycle, and no ``updated_at``" in the module docstring for why, and for the
    ``alembic check`` drift that applying it would cause.

    Issuance is a plain construction, with both the random token and its digest supplied by
    ``app.core.security`` and the expiry instant already computed from the configured
    lifetime::

        session.add(
            RefreshToken(
                user_id=user.id,
                token_hash=hash_refresh_token(token),
                expires_at=expires_at,
            )
        )

    Only ``token`` is returned to the client, and it is never persisted anywhere.

    Reading ``refresh_token.user`` requires the relationship to have been loaded by the
    statement that fetched the row - ``joinedload(RefreshToken.user)`` in
    ``app.repositories.*``, which is where rotation's lookup is built. The default lazy
    strategy is kept on purpose: under an ``AsyncSession`` a lazy load raises
    ``MissingGreenlet`` at the point of access, which surfaces a missing eager-load option
    immediately instead of hiding an extra round trip behind a request that still succeeds.

    Nothing on this class is a method. It is a mapped shape; issuing, rotating, revoking and
    validating a token all live in ``app.core.security`` and ``app.services.auth_service``.
    """

    __tablename__ = "refresh_tokens"

    # Both indexes are declared here rather than as `index=True` on their columns, so that
    # each is stated exactly once and its name is greppable in the source - which is what
    # lets revision 0001's downgrade drop it by name with confidence. Verified against
    # SQLAlchemy 2.0.51 rather than assumed: these names are byte-identical to what the
    # `ix_%(column_0_label)s` convention in app.db.base derives from `index=True`, and both
    # spellings compile to the same `CREATE INDEX ... ON refresh_tokens (...)`. So this is
    # documentation, not an override, and it introduces no drift.
    #
    # These two, together with the UNIQUE constraint on `token_hash` below, are the three
    # objects the design's index inventory names for this relation, and each answers a
    # different question: the digest constraint serves rotation's lookup, `user_id` serves
    # revocation across an account, and `expires_at` serves an expiry sweep.
    __table_args__ = (
        # "Which tokens belong to this account?" - revoking every session an account holds,
        # and the cascade PostgreSQL performs when the account itself is deleted.
        Index("ix_refresh_tokens_user_id", "user_id"),
        # "Which tokens are past their expiry?" - so a sweep of dead rows is an index range
        # scan instead of a full pass over every token the system has ever issued.
        Index("ix_refresh_tokens_expires_at", "expires_at"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        # The type is spelled out to match `users.id` exactly, as
        # app.db.base.UUIDPrimaryKeyMixin asks of anything referencing it: both sides of the
        # reference are then visibly identical, and `as_uuid=True` means the driver hands
        # back uuid.UUID objects, so a value read here compares equal to `User.id` with no
        # cast at the call site.
        UUID(as_uuid=True),
        # A string target rather than an imported Column: resolving "users.id" is deferred
        # until the metadata is used, which is what keeps this module importable with no
        # runtime edge to app.models.user.
        #
        # ON DELETE CASCADE is mandatory, not a convenience. Deleting an account must leave
        # no token behind that still resolves to it, and pushing that into the database means
        # every writer obeys it - the ORM, a migration, a hand-written statement in psql -
        # rather than only the code paths that remembered to. Its counterpart is
        # passive_deletes=True on User.refresh_tokens; see "Deletion" in the module docstring.
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    """The account this token was issued to.

    ``NOT NULL``: a refresh token that identifies no principal cannot be exchanged for an
    access token, so there is no state in which an unowned row would be meaningful. Indexed
    through ``ix_refresh_tokens_user_id`` above.
    """

    token_hash: Mapped[str] = mapped_column(
        # Text, never CITEXT: a hex digest is compared for exact identity and a
        # case-insensitive comparison would widen the set of strings matching a stored
        # credential. Passed explicitly even though Base.type_annotation_map resolves `str`
        # to TEXT already, so the choice is legible next to the column rather than inherited
        # silently from a table two modules away.
        Text,
        nullable=False,
        # UNIQUE is part of the lookup mechanism, not hygiene: it is the index rotation
        # probes by digest, and it guarantees one digest identifies at most one row. `unique`
        # WITHOUT `index` on purpose - that produces a single UNIQUE CONSTRAINT,
        # uq_refresh_tokens_token_hash under the naming convention, whose backing index
        # serves the lookup. Adding index=True as well would ask for a second, redundant
        # object over the same column and put the model out of step with revision 0001.
        unique=True,
    )
    """SHA-256 hex digest of the issued token - the token itself is never stored.

    Written from :func:`app.core.security.hash_refresh_token`, which is deliberately
    deterministic and unsalted so this value can be *found* rather than merely verified; the
    module docstring explains why that is the right tradeoff for a 32-byte random pre-image
    and the wrong one for a password. Unbounded ``TEXT`` so a change of digest algorithm is
    not a schema migration.
    """

    expires_at: Mapped[datetime] = mapped_column(
        # timezone=True throughout the schema. Base.type_annotation_map would resolve the
        # `datetime` annotation to the same TIMESTAMP WITH TIME ZONE; stating it keeps the
        # column readable beside the revision that renders it, exactly as TimestampMixin does.
        DateTime(timezone=True),
        nullable=False,
    )
    """Instant after which this token can no longer be exchanged.

    Computed by ``app.core.security`` from ``REFRESH_TOKEN_EXPIRE_DAYS`` at issuance and never
    extended - renewing a session mints a new row rather than pushing this value out, which is
    what bounds the lifetime of a token that has leaked. ``NOT NULL``, because a token with no
    expiry is a permanent credential. Indexed through ``ix_refresh_tokens_expires_at`` above so
    a sweep of lapsed rows does not scan the table. Comparing it against the current time is
    ``app.services.auth_service``'s job, not this class's.
    """

    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        # The only nullable column on the relation, and the nullability is the whole point:
        # NULL means "never withdrawn" and a timestamp means "withdrawn, and here is when".
        # Annotated `datetime | None` to match, which is what keeps mypy --strict agreeing
        # with the column definition.
        nullable=True,
    )
    """Instant this token was withdrawn early, or ``NULL`` while it is still exchangeable.

    Stamped by ``app.services.auth_service`` in two situations: logout, which revokes the token
    the client presented, and rotation, which revokes a token as it is exchanged so that a
    later attempt to reuse the same digest is recognisable as a leak rather than served. A
    boolean would answer "is it revoked?" while discarding "when?", which is the half both
    reuse detection and any subsequent audit actually need.
    """

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        # From the database clock, so two rows written by different workers are ordered by one
        # clock rather than by however many application clocks were involved. This is the
        # column TimestampMixin would have contributed; it is declared here because that mixin
        # brings `updated_at` with it and this relation has no use for one.
        server_default=func.now(),
    )
    """Instant the token was issued, from the database clock. Never updated.

    There is no ``updated_at`` beside it, and its absence is deliberate rather than an
    oversight - the two ways this row can change are recorded in :attr:`expires_at` and
    :attr:`revoked_at`, so a third audit column would describe no state. Revision ``0001``
    creates this column and no other timestamp.
    """

    user: Mapped[User] = relationship(
        # The reverse side is User.refresh_tokens, and the two strings must agree exactly or
        # mapper configuration fails at startup. The target class is resolved by name through
        # the declarative registry, so the TYPE_CHECKING import above stays annotation-only.
        back_populates="refresh_tokens",
        # No cascade= and no passive_deletes= here, deliberately. Both belong on the
        # collection side, which owns the parent-to-child relationship: User.refresh_tokens
        # declares cascade="all, delete-orphan" with passive_deletes=True, pairing with the
        # ON DELETE CASCADE on user_id above. Repeating either on this many-to-one side would
        # point the cascade the wrong way - deleting a token must never delete its account.
    )
    """The account that holds this token, the entity side of the ``user_id`` foreign key.

    Present so a row loaded during rotation can reach its principal without a second lookup,
    given the statement asked for it eagerly. ``app.services.auth_service`` uses it to resolve
    the user a presented refresh token belongs to before it issues the replacement pair.
    """
