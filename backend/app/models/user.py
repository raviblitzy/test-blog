"""The ``users`` relation - the identity and authority root of the blog domain.

Two names are declared here and nowhere else: :class:`UserRole`, the three-valued authority
scale, and :class:`User`, the mapped class behind the ``users`` table. Everything in the
product that answers "who is asking?" or "may they?" resolves to one of them.
``app.core.dependencies`` imports both to build ``get_current_user``, ``get_current_active_user``
and ``require_admin``; ``app.db.seed`` imports both to create the administrator account;
``app.schemas.user`` and ``app.schemas.admin`` import :class:`UserRole` rather than
re-declaring it, because an enum declared twice is two contracts that can disagree; and
``app.models.refresh_token``, ``post``, ``comment`` and ``like`` all carry a ``users.id``
foreign key back to this relation.

This module is imported before its four siblings on every path that touches the schema, so it
is deliberately **edge-free**: at runtime it imports the declarative foundation and nothing
else from the application. The four classes its relationships point at are imported under
:data:`typing.TYPE_CHECKING` only, and SQLAlchemy resolves them by class name through the
declarative registry when mappers are configured. Verified against SQLAlchemy 2.0.51: this
module imports on its own with no sibling present, and ``configure_mappers()`` then binds
every relationship once the siblings are imported - which is what ``app.models.__init__``
does for both the migration runner and the test harness.

What it replaces
----------------
The service this repository grew out of had exactly one data contract, and it was a request
schema rather than a relation - a client-supplied integer identifier and two unowned scalar
fields, quoted verbatim in the "What it replaces" section of :mod:`app.db.base` so the retired
shape is recorded once rather than in all seven models. No blog entity corresponds to it, so it
is deleted outright rather than migrated. Three of its properties are defects this relation
closes directly:

* **Identity was the client's to supply.** The server never generated ``id`` and never checked
  it for uniqueness, so two records could carry the same identifier and the first one stored
  permanently shadowed every later one. Here identity comes from
  :class:`~app.db.base.UUIDPrimaryKeyMixin` over PostgreSQL's ``gen_random_uuid()``, and no
  caller can supply it.
* **There were no temporal columns.** Nothing recorded when a record was written or last
  changed. :class:`~app.db.base.TimestampMixin` supplies ``created_at`` and ``updated_at``
  from the database clock.
* **There was no ownership and no authority.** A single anonymous collection had no concept of
  an author, a reader or an administrator. This relation is where all three become real.

Case-insensitive identity
-------------------------
``email`` and ``username`` are ``CITEXT``, and the type is passed to
:func:`~sqlalchemy.orm.mapped_column` **explicitly** rather than inferred. That is not
belt-and-braces: :attr:`app.db.base.Base.type_annotation_map` resolves a bare ``Mapped[str]``
to ``TEXT``, so an annotation-only declaration would compile to a case-*sensitive* column and
silently destroy the guarantee. Measured on PostgreSQL 18.4 with ``citext`` installed:
inserting ``Alice`` / ``A@X.com`` and then ``alice`` / ``a@x.com`` raises a unique violation on
the second insert. Two consequences follow, and both are product behaviour rather than
implementation detail - a case-variant duplicate account cannot be registered, and ``/u/Alice``
and ``/u/alice`` resolve to one person.

The uniqueness is enforced by the database, not by lowercasing values on the way in. An
application-side ``.lower()`` would have to be applied on every write path and every lookup
path, and the first path that forgot would silently admit the duplicate this design forbids.

Authority
---------
:class:`UserRole` is persisted as the native PostgreSQL enumerated type ``user_role``, which
makes authority a column the server reads rather than a claim a client asserts. The type is
declared ``create_type=False`` because revision ``0001`` owns its lifecycle - it creates the
type at the top of ``upgrade()`` and drops it at the bottom of ``downgrade()``, which is what
makes the up/down/up cycle repeatable. Omitting the flag is not a style slip: SQLAlchemy would
then emit its own ``CREATE TYPE`` alongside the ``CREATE TABLE`` and the upgrade would stop
with ``psycopg.errors.DuplicateObject: type "user_role" already exists``.

Enforcement is not here. This module states that a user *has* a role; deciding what a role
*permits* belongs to ``app.core.dependencies`` and to the service layer, and every protected
operation re-checks it server-side. In particular, nothing in this file assumes that only an
``AUTHOR`` may write a post - ``POST /api/v1/posts`` is gated on a bearer token alone - so
encoding that rule here would contradict the API contract.

Deletion
--------
All four relationships pair a database-level ``ON DELETE CASCADE`` (declared on the child's
foreign key, next to the column it constrains) with ``passive_deletes=True`` here. The pairing
is what makes "deleting a user removes their posts, comments, likes and refresh tokens" both
correct and cheap: PostgreSQL performs the cascade in one statement, and the flag stops
SQLAlchemy loading every child into the session first to delete it row by row. Setting the
cascade without the flag would be correct but quadratic; setting the flag without the cascade
would orphan rows. Neither half is optional.

What is deliberately not here
-----------------------------
This module is schema. It declares no query, no :class:`~sqlalchemy.orm.Session`, no
repository helper, no validation rule and no HTTP concern. It hashes nothing: ``password_hash``
is a column, and the argon2id hashing and verification that fill it live in
``app.core.security``. There is deliberately no ``check_password`` method, no
``find_by_email`` classmethod and no property that runs a statement - every statement in the
backend is built in ``app.repositories.*``, which is the only layer permitted to do so.

It reads no configuration: no environment variable, no dotenv file, no import of
``app.core.config``, and no import-time side effect of any kind. ``alembic check`` has to
resolve this module with no database reachable and no ``.env`` present, and it does.

Nor does it re-declare what it inherits. ``id``, ``created_at`` and ``updated_at`` come from
the two mixins and appear nowhere below; re-declaring any of them would shadow the mixin's
column, and declaring a second :class:`~sqlalchemy.MetaData` or declarative base would hide
this relation from both the migration runner and the test harness. That is also why ``uuid``
and ``datetime`` are absent from the import list: this relation declares no identity column,
no audit column and no foreign key of its own, so it needs neither type - and an import used
only by a docstring is an unused import that ``ruff``'s ``F401`` rejects.

Finally there is no ``__repr__``, matching :mod:`app.db.base`: a generic one has to read mapped
attributes, and an unloaded attribute access under an async session raises
``MissingGreenlet`` - a debugging convenience is a poor reason to put that hazard in a model.

Cross-file contract
-------------------
Revision ``0001_initial_blog_schema`` renders this relation, and four details must agree with
it exactly or ``alembic check`` reports drift that no schema change caused:

* the ``citext`` extension is enabled by the revision, not here - this module only references
  the type;
* the enumerated type is named ``user_role``, spelled identically on both sides;
* ``email`` and ``username`` become **unique indexes** rather than unique constraints, because
  ``unique=True`` and ``index=True`` together emit a single ``CREATE UNIQUE INDEX``; the
  naming convention in :mod:`app.db.base` derives ``ix_users_email`` and ``ix_users_username``,
  so no name is written by hand here and none should be written by hand there;
* the two GIN trigram indexes in :attr:`User.__table_args__` - ``ix_users_username_trgm`` and
  ``ix_users_email_trgm``, both over the text cast of their citext column - are built by revision
  ``0002``, not ``0001``, which is where every GIN index in this schema lives; their names,
  expressions and operator classes are spelled identically on both sides;
* the two server defaults are ``'READER'::user_role`` and ``true``, which is the spelling
  PostgreSQL reflects back, so ``compare_server_default`` finds them equal.
"""

from __future__ import annotations

import enum
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, Index, Text, literal_column, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.dialects.postgresql import CITEXT
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    # Annotation-only imports. They must never become runtime imports: every one of these
    # four modules declares a foreign key back to `users`, so importing them here would
    # close a cycle and make the import order of app.models load-bearing. SQLAlchemy
    # resolves each target by class name through the declarative registry instead.
    from app.models.comment import Comment
    from app.models.like import PostLike
    from app.models.post import Post
    from app.models.refresh_token import RefreshToken

__all__ = ["User", "UserRole"]


class UserRole(enum.StrEnum):
    """The three levels of authority a principal can hold, least privilege first.

    Persisted as the native PostgreSQL enumerated type ``user_role``. The scale is
    deliberately short and totally ordered by privilege, so a check is a comparison rather
    than a set membership test::

        if user.role is UserRole.ADMIN:
            ...

    Each member's value is **identical to its own name**, and that is load-bearing rather
    than redundant. SQLAlchemy derives an enumerated type's PostgreSQL labels from the Python
    member *names* by default, while a ``values_callable`` derives them from the *values*;
    making the two identical means both resolutions coincide, so the labels stored in the
    database are unambiguously uppercase however the type is configured. Sibling models and
    revisions compare against uppercase SQL literals, and revision ``0001`` creates the type
    with these labels in this order.

    Subclassing :class:`str` is equally deliberate: it lets a member serialise to its label
    without an explicit conversion and compare equal to the plain string a client sent, which
    is what allows ``app.schemas.user`` and ``app.schemas.admin`` to expose this enum directly
    on the wire instead of mapping it to a second representation. :class:`enum.StrEnum` is the
    spelling used rather than a ``(str, enum.Enum)`` mixin, and the choice is not cosmetic:

    * ``ruff``'s ``UP042`` rejects the mixin form outright under ``target-version = "py314"``,
      and ``ruff check backend`` is a blocking gate.
    * :class:`enum.StrEnum` *is* a :class:`str` subclass, so every property the schema layer
      relies on is preserved. Verified against the pinned versions: ``issubclass(UserRole, str)``
      is true, ``UserRole.ADMIN == "ADMIN"`` is true, and SQLAlchemy derives the same uppercase
      labels and performs the same bind and result processing under either spelling.
    * It renders more cleanly. ``str(UserRole.ADMIN)`` and ``f"{UserRole.ADMIN}"`` both give
      ``"ADMIN"``, where the mixin form gives ``"UserRole.ADMIN"`` - so an interpolated role in
      a log line or an error message reads as the label rather than as a Python repr.

    Only membership is declared here. What each role *permits* is enforced server-side by
    ``app.core.dependencies`` and the service layer, never by this class and never by the
    client hiding a control.
    """

    READER = "READER"
    """Can read published posts, comment, and like. The default for a new account."""

    AUTHOR = "AUTHOR"
    """A reader who is also the owner of their own posts - authoring authority is scoped to
    the rows they own, which the service layer checks by comparing ``author_id``."""

    ADMIN = "ADMIN"
    """Unrestricted authority across every relation: may act on any post or comment
    regardless of ownership, change another user's role or active state, and manage the
    category taxonomy. Gated by ``require_admin``, applied at router level so no
    administrative route can omit it."""


class User(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A registered account: the author of posts and comments, and the holder of a role.

    Eleven columns, three of them inherited. ``id`` comes from
    :class:`~app.db.base.UUIDPrimaryKeyMixin` and is generated by PostgreSQL;
    ``created_at`` and ``updated_at`` come from :class:`~app.db.base.TimestampMixin` and are
    stamped from the database clock. The remaining eight are declared below in the order the
    entity-relationship design lists them, and the mixins' ``sort_order`` values keep the
    surrogate key at the head of the table and the two audit columns at its tail regardless.

    The relation is referenced by four others - ``refresh_tokens``, ``posts``, ``comments`` and
    ``post_likes`` - each through a ``users.id`` foreign key declared ``ON DELETE CASCADE``, so
    deleting an account removes everything it owns in one statement.

    Nothing on this class is a method. It is a mapped shape and a set of relationship
    declarations, which are schema; the behaviour that reads them lives in
    ``app.core.dependencies``, ``app.services.*`` and ``app.repositories.*``.
    """

    __tablename__ = "users"

    email: Mapped[str] = mapped_column(CITEXT, unique=True, nullable=False, index=True)
    """Login identifier and the account's contact address, unique case-insensitively.

    ``CITEXT`` is passed explicitly because :attr:`app.db.base.Base.type_annotation_map`
    resolves a bare ``Mapped[str]`` to ``TEXT``; relying on the annotation would produce a
    case-sensitive column and let ``a@x.com`` register alongside ``A@X.com``. Format validation
    belongs to the registration schema, where ``email-validator`` turns a malformed address
    into a ``422`` rather than a database error.
    """

    username: Mapped[str] = mapped_column(CITEXT, unique=True, nullable=False, index=True)
    """Public handle, unique case-insensitively, and the key every profile route is addressed
    by - ``GET /api/v1/users/{username}`` and the client's ``/u/[username]``.

    ``CITEXT`` for the same reason as ``email``, with a second consequence: because the
    comparison is case-insensitive, ``/u/Alice`` and ``/u/alice`` are one profile rather than
    one profile and one ``404``. The unique index is what makes the lookup a single index
    probe instead of the linear scan every addressed read in the retired implementation
    performed.
    """

    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    """The account's argon2id hash - never a plaintext password, and never a default.

    ``app.core.security`` owns every operation on the value - it produces the hash on
    registration and verifies a candidate password against it on login - and no other module
    interprets the string; a service that needs a credential check hands the stored hash to
    that module rather than parsing it. Nothing hashes anything here: this is a column.
    The column is unbounded ``TEXT`` on purpose: an argon2id encoded hash carries its own
    algorithm, version and parameters inline, so its length changes whenever those parameters
    are tuned, and a length cap would turn a routine cost increase into a migration.

    There is no ``server_default`` and no Python default. An account without a credential must
    fail to insert rather than quietly become unauthenticatable, and a default here would be a
    hard-coded credential in the repository.
    """

    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    """Human-readable name shown wherever the account appears.

    ``NOT NULL`` because it is always-rendered content: the author byline on every post card
    and post detail page, the profile heading, and the administrative user table all display
    it unconditionally, so a null would force a fallback into every one of those call sites.
    Registration supplies it, and ``PATCH /api/v1/users/me`` updates it.
    """

    bio: Mapped[str | None] = mapped_column(Text, nullable=True)
    """Optional self-description rendered on the public profile. Null until the account sets
    one, which is the common case immediately after registration - the profile page omits the
    block entirely rather than rendering an empty one."""

    avatar_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    """Optional absolute URL of the account's avatar image.

    A URL reference rather than uploaded bytes: there is no upload pipeline and no object
    store in this design. Null is expected rather than exceptional - the avatar primitive
    renders the account's initials as a fallback when no URL exists - so nothing downstream
    treats the absence as an error.
    """

    role: Mapped[UserRole] = mapped_column(
        # Native PostgreSQL enumerated type. `create_type=False` is mandatory: revision 0001
        # creates `user_role` in upgrade() and drops it in downgrade(), so SQLAlchemy must not
        # emit a competing CREATE TYPE alongside the CREATE TABLE. The name is spelled here
        # exactly as the revision spells it, because a mismatch is an alembic-check drift
        # report that no schema change caused.
        postgresql.ENUM(UserRole, name="user_role", create_type=False),
        nullable=False,
        # `'READER'::user_role` is the spelling PostgreSQL reflects back for this default, so
        # the model side and the reflected side compare equal under compare_server_default.
        # The default is least privilege: a newly registered account can read, comment and
        # like, and nothing more, until an administrator promotes it.
        server_default=text("'READER'::user_role"),
    )
    """The account's authority, defaulting to :attr:`UserRole.READER` at the database level.

    A real persisted column rather than a token claim, which is the point: ``require_admin``
    resolves the principal from the bearer token and then reads *this* value, so revoking
    authority takes effect on the next request instead of when an already-issued token
    happens to expire.
    """

    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    """Whether the account may authenticate, defaulting to true.

    Deactivation is the reversible half of administrative moderation: ``get_current_active_user``
    rejects a principal whose flag is false, so an administrator can suspend an account without
    deleting it and without cascading away the posts and comments it owns. Deletion remains
    available and remains irreversible.
    """

    # ---------------------------------------------------------------------------------
    # Access paths
    #
    # Two unique indexes come from `unique=True, index=True` on `email` and `username` above,
    # and they serve the equality lookups - sign-in, registration conflict detection, and
    # resolving /u/{username} to a row in one probe.
    #
    # The two declared here serve a different question, and they exist because the first two
    # cannot answer it. GET /api/v1/admin/users takes a `?q=` term and matches it against handle
    # and address as a CONTAINMENT search, and a leading-wildcard pattern cannot use a b-tree at
    # all. Left unindexed, every keystroke in that search box is a sequential scan over every
    # account in the system.
    #
    # Both index the TEXT CAST of a citext column rather than the column, and that is forced
    # rather than stylistic: gin_trgm_ops is defined over `text`, and citext's own `~~`/`~~*`
    # operators are not in that operator family, so an index declared directly on the column is
    # accepted by PostgreSQL and then never chosen by the planner - at any size, because the
    # operator family never matches.
    #
    # Over the cast, two separate things are true and only one of them is about this index being
    # correct. REACHABLE: the predicate plans as an `Index Cond` on these two under a BitmapOr,
    # measured on 18.4, and that holds at every row count. PREFERRED: whether the planner picks
    # them over reading the table is a cost decision that arrives with volume - at thirty
    # thousand accounts it still scans, at three hundred thousand it takes both indexes. The
    # second is not a defect in the first: an index that is never reachable is a wasted write,
    # while an index the planner declines on a small relation is simply not needed yet.
    #
    # app.repositories.user_repository therefore writes
    # the predicate as `cast(User.username, Text).ilike(...)` to match this expression - and as
    # ILIKE rather than LIKE, because casting away citext also casts away its case-folding.
    #
    # The expression is a LABELLED literal_column with the operator class in `postgresql_ops`,
    # not one `text("(username::text) gin_trgm_ops")` string. Both render the same DDL, but
    # Alembic warns `Expression ... detected to include an operator clause. Expression compare
    # cannot proceed` on the inline form and then stops comparing the index at all - an object
    # silently unguarded by the drift gate. Revision 0002 builds both, alongside every other GIN
    # index in this schema.
    # ---------------------------------------------------------------------------------
    __table_args__ = (
        Index(
            "ix_users_username_trgm",
            literal_column("(username::text)").label("username_text"),
            postgresql_using="gin",
            postgresql_ops={"username_text": "gin_trgm_ops"},
        ),
        Index(
            "ix_users_email_trgm",
            literal_column("(email::text)").label("email_text"),
            postgresql_using="gin",
            postgresql_ops={"email_text": "gin_trgm_ops"},
        ),
    )

    # ---------------------------------------------------------------------------------
    # Relationships
    #
    # Four collections, one per relation that carries a `users.id` foreign key. Each is
    # annotated with a class imported under TYPE_CHECKING only, so nothing below forces a
    # runtime import; SQLAlchemy de-stringifies the annotation and resolves the target by
    # class name through the declarative registry when mappers are configured.
    #
    # All four share the same two arguments, and the pairing is the whole design:
    #
    #   cascade="all, delete-orphan"  detaching a child from the collection deletes it,
    #                                 which is correct because none of these four rows has
    #                                 any meaning apart from the account that owns it.
    #   passive_deletes=True          the child's foreign key is already declared
    #                                 ON DELETE CASCADE, so PostgreSQL removes the rows in
    #                                 one statement; without the flag SQLAlchemy would first
    #                                 SELECT every child into the session and issue a DELETE
    #                                 per row, duplicating work the database does correctly
    #                                 and far faster.
    #
    # No loading strategy is set here. Under an async session a lazy collection access raises
    # MissingGreenlet by design, and the supported way to load one is to say so in the
    # statement - selectinload() for these collections - inside app.repositories.*, which is
    # the only layer that builds statements. Choosing an eager default here would impose it on
    # every query that touched a user, including the ones that only need the byline.
    # ---------------------------------------------------------------------------------

    posts: Mapped[list[Post]] = relationship(
        back_populates="author",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    """Every post the account authored, in any lifecycle state.

    Deliberately unfiltered: drafts, published and archived posts are all here, because this
    is the ownership edge rather than a public projection. Restricting a view to
    ``status = PUBLISHED`` is the job of the query behind that view - the public profile and
    the home feed both filter explicitly, which is what stops a draft leaking through either.
    """

    comments: Mapped[list[Comment]] = relationship(
        back_populates="author",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    """Every comment the account wrote, across all posts and in any moderation state."""

    likes: Mapped[list[PostLike]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    """Every like the account granted.

    ``post_likes`` is keyed on ``(post_id, user_id)``, so the collection cannot contain the
    same post twice - idempotency is a property of the composite primary key rather than
    something this side has to police, which is what makes a repeated
    ``PUT /api/v1/posts/{id}/like`` safe to retry.
    """

    refresh_tokens: Mapped[list[RefreshToken]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    """Every refresh token issued to the account, including expired and revoked ones.

    Each row stores only a hash of the token it represents, so this collection is a record of
    issuance rather than a set of usable credentials. Retaining the spent rows is what lets
    rotation detect the reuse of a token that has already been exchanged.
    """
