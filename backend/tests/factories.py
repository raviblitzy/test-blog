"""Async construction helpers that build blog-domain rows for the backend test suite.

Every relation in the schema can be created here in one call with sensible defaults, so a
test states only the part of the world it actually cares about::

    author = await create_author(session)
    post = await create_published_post(session, author=author, title="Scaling FastAPI")
    await create_like(session, post=post, user=await create_reader(session))

Plain functions, deliberately, and not a factory library
-------------------------------------------------------
``factory-boy`` is listed under "Packages Deliberately Excluded" in the Agent Action Plan
(AAP section 0.5.6) on the grounds that its async-ORM ergonomics are poor and that plain
async construction helpers in this module are simpler and clearer. So this file imports no
factory framework, declares no metaclass and no declarative ``Meta`` class, and adds nothing
to ``backend/requirements-dev.txt``. The only test-data dependency it uses is ``Faker``,
which that file already pins.

The consequence is worth stating positively rather than as a limitation: a helper here is an
ordinary coroutine with an ordinary signature, so its defaults are readable at the definition,
its keyword arguments are discoverable by any editor, and a failure inside it has a stack
trace that names this file rather than a framework's resolution machinery.

No helper supplies a primary key
--------------------------------
This is the single most important constraint on the file, and it is the AAP's self-imposed
standard "Server-owned identity and database-enforced integrity" (section 0.10.1, standard 3)
applied to fixture construction. Identity originates in PostgreSQL: every UUID primary key
carries a ``gen_random_uuid()`` server default installed by revision
``0001_initial_blog_schema``, and :class:`app.db.base.UUIDPrimaryKeyMixin` deliberately
declares no Python-side default. A factory that passed ``id=...`` would put the client back in
charge of identity, which is precisely the defect this schema replaced - the retired service's
only data contract let the caller choose an integer key that the server neither generated nor
checked for uniqueness, so a duplicate permanently shadowed every later record.

The same reasoning covers the audit columns. ``created_at`` and ``updated_at`` come from
:class:`app.db.base.TimestampMixin` and are stamped from the database clock, so no helper
here assigns either. Nor does any helper touch ``posts.search_vector``: revision
``0002_post_search_vector_and_indexes`` declares it ``GENERATED ALWAYS AS (...) STORED``, and
PostgreSQL rejects any write to a generated column. It re-derives from ``title``, ``excerpt``
and ``content`` on every write, which is what lets a search test query rows created here with
no index-maintenance step in between.

Passwords go through the real hasher
------------------------------------
:func:`create_user` hashes through :func:`app.core.security.hash_password`, which is argon2id -
the AAP's "Secure-by-default authentication" standard (section 0.10.1, standard 6) applied
here. Nothing in this file stores a plaintext password in ``users.password_hash`` and nothing
re-implements hashing. Because argon2id is deliberately slow, each created user is hashed
exactly once and the shared :data:`DEFAULT_PASSWORD` is reused rather than a fresh random
credential being minted and hashed per user.

The session is injected, never created
--------------------------------------
Every helper takes the :class:`~sqlalchemy.ext.asyncio.AsyncSession` as its first positional
argument and every domain input as a keyword-only argument. ``backend/tests/conftest.py`` owns
the engine and wraps each test in a transaction it rolls back afterwards, so this module
opens no engine, no connection and no transaction of its own - one opened here would sit
outside that transaction and leak rows into the next test.

For the same reason no helper calls ``commit()``. Each one flushes, which is enough to reach
the database, obtain the server-generated values and trip any constraint the row violates,
while leaving control of the transaction where it belongs.

The dependency edge runs one way: ``conftest.py`` imports this module and this module never
imports ``conftest``. Nor does it import ``httpx``, ``app.services`` or ``app.repositories`` -
factories build persistence-layer state directly, because routing fixture setup through the
business rules under test would make a failure ambiguous about which layer produced it.

Uniqueness is generated, not hoped for
--------------------------------------
``users.email``, ``users.username``, ``categories.name``, ``categories.slug`` and
``posts.slug`` all carry UNIQUE constraints, and every one of those except
``categories.name`` is ``CITEXT``, so the comparison is case-insensitive: a stored ``Alice``
already occupies ``alice``. Faker alone collides across a suite of this size, and a collision
surfaces as an opaque ``IntegrityError`` deep inside an unrelated test. Every generated unique
value therefore embeds :func:`_next_n`, a process-monotonic counter, and no generated value
differs from another only by case.

One thing the helpers explicitly do not assume is an empty database. Revision
``0003_seed_reference_categories`` inserts eight reference categories - Engineering,
Architecture, Backend, Frontend, Databases, DevOps, Security and Product - so ``categories``
is non-empty before the first test runs. :func:`create_category` generates names and slugs
that cannot collide with any of them.

Returned instances are safe to read
-----------------------------------
Each helper follows the pattern ``app.repositories.base`` establishes for the application
itself: add, flush, then refresh. The refresh is mandatory rather than defensive, because
PostgreSQL supplies ``id``, ``created_at``, ``updated_at``, the enum and integer server
defaults and the generated ``posts.search_vector``, SQLAlchemy expires all of them after the
write, and reading an expired attribute under an async session raises ``MissingGreenlet``.
After the refresh every column on the returned object is populated from the row.
"""

from __future__ import annotations

import itertools
import uuid
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any, Final

from faker import Faker
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import (
    generate_refresh_token,
    hash_password,
    hash_refresh_token,
    refresh_token_expires_at,
)
from app.core.slug import DEFAULT_MAX_LENGTH, slugify_title
from app.db.base import Base
from app.models import (
    Category,
    Comment,
    CommentStatus,
    Post,
    PostLike,
    PostStatus,
    RefreshToken,
    User,
    UserRole,
)

__all__ = [
    "DEFAULT_PASSWORD",
    "FAKER_SEED",
    "create_admin",
    "create_author",
    "create_category",
    "create_comment",
    "create_like",
    "create_like_if_absent",
    "create_post",
    "create_published_post",
    "create_reader",
    "create_refresh_token",
    "create_user",
    "fake",
]


# ---------------------------------------------------------------------------------------
# Module state
#
# Three module-level objects, and each one is shared on purpose. A per-call Faker instance
# would re-seed itself from the system entropy pool on every construction, and a per-call
# counter would not be a counter at all.
# ---------------------------------------------------------------------------------------

DEFAULT_PASSWORD: Final[str] = "Factory-Passw0rd-1"
"""The plaintext every factory-created account is given, unless a test asks for another.

Exported because it is half of a credential: :func:`create_user` hashes it and stores only
the hash, so a test that then wants to authenticate through ``POST /api/v1/auth/login`` has
no other way to learn what to send. Written as one shared constant rather than generated per
user for two reasons - argon2id hashing is deliberately expensive, so hashing one known value
once per user is the cheap path, and a test asserting on a login failure needs a value it can
be sure is the *correct* one before it perturbs it.

Obviously fake, and deliberately never a real credential. It nonetheless satisfies the
project's own password policy from :mod:`app.core.password_policy` - at least twelve
characters and at least three of the five character classes - so a test may also submit it to
the registration endpoint, where a policy violation would otherwise come back as a ``422``
that had nothing to do with what the test was checking.
"""

FAKER_SEED: Final[int] = 20240101
"""Seed applied to :data:`fake`, so generated content is identical on every run.

The AAP describes Faker's role in this project as deterministic test data generation
(section 0.5.3), and determinism is not a nicety here: an unseeded instance makes a failure
irreproducible, and an irreproducible failure in a blocking gate is a flake that costs more
to chase than the test was worth. Exported so a test that needs to reason about the generated
corpus - or to re-seed after deliberately consuming values - can name the same number rather
than restate it.
"""

fake: Final[Faker] = Faker()
"""The single seeded :class:`~faker.Faker` instance every helper draws content from.

One instance for the module, because the seed is what makes the sequence reproducible and a
second instance would advance a second, independent sequence. Exported so a test needing
extra content of the same flavour - another paragraph, another name - draws it from the same
stream instead of constructing its own generator.
"""

# Seeded through the CLASS rather than the instance, which is why this can follow the
# construction above rather than precede it: `Faker.seed` sets the shared random generator
# every Faker instance draws from, so the sequence `fake` produces is fixed from its first
# call regardless of the order of these two statements. It has to sit after the assignment in
# any case, because an attribute docstring must directly follow the name it documents.
Faker.seed(FAKER_SEED)

# Process-monotonic source of the discriminator embedded in every generated unique value.
# `itertools.count` is chosen over a module-level integer because it advances atomically with
# respect to the interpreter: `next()` on it is a single bytecode-level operation rather than
# a read-modify-write a task switch could interleave. The suite runs on one event loop per
# `asyncio_default_test_loop_scope = "session"`, so contention is not the concern - a stray
# duplicate under any future concurrency is, and this costs nothing to rule out.
_counter: Final[itertools.count[int]] = itertools.count(1)


def _next_n() -> int:
    """Return the next value of the module's monotonic uniqueness counter.

    Load-bearing rather than cosmetic. Five columns this module writes are UNIQUE, four of
    them ``CITEXT`` and therefore case-insensitively unique, and Faker's own generators
    collide long before a suite of this size finishes: the name pool is finite, and two
    accounts differing only in case are a duplicate as far as the database is concerned.
    Embedding this value in every generated email, username and slug makes a collision
    impossible by construction instead of improbable.

    The counter is never reset. It counts constructions for the lifetime of the interpreter,
    so a value it has issued is never issued again even across tests - which matters because
    ``conftest.py`` rolls each test back rather than truncating, and a rollback does not
    rewind a Python counter.

    Returns:
        A positive integer, strictly greater than every value previously returned.
    """
    return next(_counter)


async def _persist[EntityT: Base](session: AsyncSession, instance: EntityT) -> EntityT:
    """Add ``instance`` to the session, flush it, and reload it from the row.

    The one place the write pattern is expressed, mirroring what
    ``app.repositories.base`` does for the application itself. The refresh is the part that
    matters: PostgreSQL supplies the primary key, both audit timestamps, every enum and
    integer server default and the generated ``posts.search_vector``, SQLAlchemy marks all of
    them expired once the INSERT has gone out, and reading an expired attribute under an
    :class:`~sqlalchemy.ext.asyncio.AsyncSession` raises ``MissingGreenlet`` rather than
    returning a value. After the refresh every column on the returned object holds what the
    database actually stored.

    Flush and not commit, deliberately. The flush reaches the database - so a UNIQUE
    violation, a failed ``CHECK`` or a broken foreign key surfaces at the factory call rather
    than at the end of the test - while leaving the enclosing transaction open for
    ``conftest.py`` to roll back.

    Args:
        session: The session under test, owned and torn down by ``conftest.py``.
        instance: A newly constructed, not-yet-persisted mapped instance.

    Returns:
        The same instance, now persistent, with every column loaded from the row.
    """
    session.add(instance)
    await session.flush()
    await session.refresh(instance)
    return instance


async def _identity_of(session: AsyncSession, entity: Base, label: str) -> uuid.UUID:
    """Return ``entity.id``, flushing first if the instance has not reached the database yet.

    Foreign keys are populated from the parent's ``id`` rather than by assigning the parent to
    a relationship, which keeps the returned child free of a loaded relationship that the
    refresh in :func:`_persist` would immediately expire. That trade needs the parent's
    identity to exist in Python at construction time, and it does for anything a sibling
    helper here returned, because each of those flushed and refreshed before returning.

    A caller can still hand in an instance it constructed itself and never flushed. Rather
    than let that become ``IntegrityError: null value in column "author_id"`` several frames
    away, the flush is performed here and a still-absent identity is reported as a
    :exc:`ValueError` naming the argument at fault.

    Args:
        session: The session under test.
        entity: A mapped instance whose primary key is needed as a foreign-key value.
        label: The keyword-argument name to quote if the identity cannot be resolved.

    Returns:
        The entity's server-generated primary key.

    Raises:
        ValueError: If the instance still has no identity after a flush, which means it was
            never added to this session.
    """
    identity: uuid.UUID | None = getattr(entity, "id", None)
    if identity is None:
        # A pending instance has no server-generated key yet; flushing the session assigns
        # one through the `gen_random_uuid()` default and RETURNING, in one round trip.
        await session.flush()
        identity = getattr(entity, "id", None)
    if identity is None:
        raise ValueError(
            f"{label}={entity!r} has no identity: pass an instance created by one of this "
            "module's helpers, or add it to the session before referencing it."
        )
    return identity


def _unique_slug(source: str, discriminator: int) -> str:
    """Derive a slug from ``source`` and make it unique with ``discriminator``.

    ``posts.slug`` and ``categories.slug`` are ``CITEXT`` behind unique indexes, so the
    suffix is what stops two Faker titles that reduce to the same stem - or two spellings of
    one title that differ only in case - from colliding.

    The suffix is accounted for inside :data:`app.core.slug.DEFAULT_MAX_LENGTH` rather than
    appended past it, so the result honours the same bound the application's own slugs do.
    :func:`app.core.slug.slugify_title` rejects a non-positive budget, so the stem is never
    asked for fewer than one character.

    Args:
        source: Human-readable text to derive the stem from; may be any string, including one
            with no sluggable character at all.
        discriminator: A value from :func:`_next_n`.

    Returns:
        A lowercase, hyphen-separated slug ending in ``-<discriminator>``, no longer than
        :data:`app.core.slug.DEFAULT_MAX_LENGTH`.
    """
    suffix = f"-{discriminator}"
    stem_budget = max(DEFAULT_MAX_LENGTH - len(suffix), 1)
    return f"{slugify_title(source, max_length=stem_budget)}{suffix}"


# ---------------------------------------------------------------------------------------
# Accounts
# ---------------------------------------------------------------------------------------


async def create_user(
    session: AsyncSession,
    *,
    email: str | None = None,
    username: str | None = None,
    password: str = DEFAULT_PASSWORD,
    display_name: str | None = None,
    bio: str | None = None,
    avatar_url: str | None = None,
    role: UserRole = UserRole.READER,
    is_active: bool = True,
) -> User:
    """Create a ``users`` row and return it, persisted and reloaded.

    Args:
        session: The session under test.
        email: Login address. Generated as ``user<n>@example.test`` when omitted; ``.test`` is
            reserved by RFC 2606, so a generated address can never reach a real mailbox.
            ``users.email`` is ``CITEXT``, so an explicit value that differs from an existing
            one only in case is a duplicate and will fail the flush.
        username: Public handle, the key ``GET /api/v1/users/{username}`` is addressed by.
            Generated as ``user<n>`` when omitted, and ``CITEXT`` on the same terms as
            ``email``.
        password: Plaintext to hash into ``password_hash``. Defaults to
            :data:`DEFAULT_PASSWORD` so the caller already knows it; pass an explicit value
            only when the test is about the credential itself.
        display_name: Rendered name. Generated from Faker when omitted. ``NOT NULL`` in the
            schema, because the byline, the profile heading and the administrative table all
            render it unconditionally, so this argument has no null path.
        bio: Optional self-description. Left ``None``, which is the state a real account is in
            immediately after registration.
        avatar_url: Optional absolute image URL. Left ``None`` so the created account
            exercises the avatar primitive's initials fallback.
        role: Authority. Defaults to :attr:`~app.models.UserRole.READER`, the least-privileged
            member, so a test must opt in to authority explicitly rather than inherit it -
            which is what keeps an authorisation test honest about what it granted. Use
            :func:`create_author` or :func:`create_admin` to say so at the call site.
        is_active: Whether the account may authenticate. ``False`` builds the deactivated
            account that ``get_current_active_user`` must reject.

    Returns:
        The persisted :class:`~app.models.User`, with ``id``, ``created_at`` and ``updated_at``
        loaded from the row.

    Examples:
        A reader with everything defaulted, and an author with a known handle::

            reader = await create_user(session)
            author = await create_user(session, username="ada", role=UserRole.AUTHOR)
    """
    discriminator = _next_n()
    user = User(
        email=email if email is not None else f"user{discriminator}@example.test",
        username=username if username is not None else f"user{discriminator}",
        # The only place this module holds a plaintext is the argument to this call. argon2id
        # is deliberately expensive, so it runs exactly once per created account.
        password_hash=hash_password(password),
        display_name=display_name if display_name is not None else fake.name(),
        bio=bio,
        avatar_url=avatar_url,
        role=role,
        is_active=is_active,
    )
    return await _persist(session, user)


async def create_reader(session: AsyncSession, **kwargs: Any) -> User:
    """Create a :attr:`~app.models.UserRole.READER` account.

    Identical to :func:`create_user` with its default role stated out loud. It exists because
    an authorisation test reads better when the privilege under test is visible at the call
    site than when it is implied by an omitted argument.

    Args:
        session: The session under test.
        **kwargs: Any keyword argument :func:`create_user` accepts, except ``role``.

    Returns:
        The persisted account.

    Raises:
        TypeError: If ``role`` is passed, since this helper supplies it.
    """
    return await create_user(session, role=UserRole.READER, **kwargs)


async def create_author(session: AsyncSession, **kwargs: Any) -> User:
    """Create an :attr:`~app.models.UserRole.AUTHOR` account.

    The role a post's owner holds. Note that authoring is not gated on it - ``POST
    /api/v1/posts`` requires only a bearer token, and ownership is decided by comparing
    ``posts.author_id`` - so a test about ownership can legitimately use any role. This helper
    exists to make the intent of the *typical* case obvious.

    Args:
        session: The session under test.
        **kwargs: Any keyword argument :func:`create_user` accepts, except ``role``.

    Returns:
        The persisted account.

    Raises:
        TypeError: If ``role`` is passed, since this helper supplies it.
    """
    return await create_user(session, role=UserRole.AUTHOR, **kwargs)


async def create_admin(session: AsyncSession, **kwargs: Any) -> User:
    """Create an :attr:`~app.models.UserRole.ADMIN` account.

    The principal ``require_admin`` admits, and the only one that may act across ownership
    boundaries. Every administrative test needs exactly one of these, and naming it here keeps
    the grant explicit instead of buried in a role argument.

    Args:
        session: The session under test.
        **kwargs: Any keyword argument :func:`create_user` accepts, except ``role``.

    Returns:
        The persisted account.

    Raises:
        TypeError: If ``role`` is passed, since this helper supplies it.
    """
    return await create_user(session, role=UserRole.ADMIN, **kwargs)


# ---------------------------------------------------------------------------------------
# Taxonomy
# ---------------------------------------------------------------------------------------


async def create_category(
    session: AsyncSession,
    *,
    name: str | None = None,
    slug: str | None = None,
    description: str | None = None,
) -> Category:
    """Create a ``categories`` row and return it, persisted and reloaded.

    The table is **not empty when a test starts**: revision
    ``0003_seed_reference_categories`` inserts Engineering, Architecture, Backend, Frontend,
    Databases, DevOps, Security and Product as data, and ``conftest.py`` rolls tests back
    rather than truncating, so those eight are present throughout the run. Generated names and
    slugs are therefore prefixed distinctively and carry a counter, which puts them outside
    that set by construction. A test that asserts on a total count must account for the eight,
    and a test that passes ``name="Backend"`` explicitly is asking for the conflict it will
    get.

    Args:
        session: The session under test.
        name: Display name, UNIQUE and compared case-sensitively. Generated as
            ``Factory Category <n>`` when omitted.
        slug: URL-safe identifier, ``CITEXT`` behind a unique index. Derived from ``name`` and
            the counter when omitted, so it is unique even if two callers pass the same name.
        description: Optional prose. Generated from Faker when omitted, because the admin
            editor and the category listing both render it and an always-null column would
            leave those surfaces untested.

    Returns:
        The persisted :class:`~app.models.Category`.

    Examples:
        Anonymous, and named for a filter assertion::

            other = await create_category(session)
            python = await create_category(session, name="Python", slug="python")
    """
    discriminator = _next_n()
    resolved_name = name if name is not None else f"Factory Category {discriminator}"
    category = Category(
        name=resolved_name,
        # Derived from the resolved name so an explicit name still yields a matching slug,
        # and suffixed so two calls passing the same name do not collide on the CITEXT index.
        slug=slug if slug is not None else _unique_slug(resolved_name, discriminator),
        description=description if description is not None else fake.sentence(nb_words=12),
    )
    return await _persist(session, category)


# ---------------------------------------------------------------------------------------
# Posts
# ---------------------------------------------------------------------------------------


async def create_post(
    session: AsyncSession,
    *,
    author: User,
    title: str | None = None,
    slug: str | None = None,
    excerpt: str | None = None,
    content: str | None = None,
    cover_image_url: str | None = None,
    status: PostStatus = PostStatus.DRAFT,
    published_at: datetime | None = None,
    view_count: int = 0,
    categories: Iterable[Category] = (),
) -> Post:
    """Create a ``posts`` row and return it, persisted and reloaded.

    Two invariants are honoured here rather than left to the caller.

    **Publication.** The database enforces ``CHECK (status <> 'PUBLISHED' OR published_at IS
    NOT NULL)`` as ``ck_posts_published_at_required``, so asking for
    :attr:`~app.models.PostStatus.PUBLISHED` without an instant would fail the flush. When
    ``status`` is ``PUBLISHED`` and ``published_at`` is omitted it is filled with an aware UTC
    "now". The reverse never happens: a caller-supplied ``status`` is never silently changed,
    because a test that asked for a draft and got a published post would be testing something
    other than what it said.

    **Generated search text.** ``posts.search_vector`` is never touched. Revision ``0002``
    declares it ``GENERATED ALWAYS AS (...) STORED`` over ``setweight`` of ``title`` at ``'A'``,
    ``excerpt`` at ``'B'`` and ``content`` at ``'C'``, and PostgreSQL rejects a write to a
    generated column. It is re-derived on this INSERT and loaded by the refresh, so a row this
    helper created is immediately searchable with no index-maintenance step.

    Args:
        session: The session under test.
        author: The owning account, normally from :func:`create_author`. Its identity is read
            and written to ``author_id``; the relationship itself is left untouched.
        title: Headline, and the highest-weighted search input. Used **verbatim** when
            supplied, so a relevance-ordering test can construct a known ranking. Generated
            from Faker when omitted.
        slug: Canonical URL segment, ``CITEXT`` behind a unique index. Derived from the title
            and the counter when omitted; an explicit value is used as given, which is what
            lets a test address ``GET /api/v1/posts/{slug}`` by a name it chose.
        excerpt: Optional summary, weighted ``'B'``. Used verbatim when supplied; generated as
            a short Faker passage otherwise. Pass ``""`` for the empty-summary case - the
            generating expression wraps this column in ``coalesce``, so a null or empty excerpt
            still yields a usable vector.
        content: Body Markdown, weighted ``'C'``. Used verbatim when supplied. Generated as
            several Faker paragraphs otherwise, rather than a single word, so that a search
            test ranking against the generated vector has real text to rank.
        cover_image_url: Optional absolute hero-image URL. Left ``None``, the common case that
            makes the client fall back to its generated social card.
        status: Lifecycle state. Defaults to :attr:`~app.models.PostStatus.DRAFT`, mirroring
            ``POST /api/v1/posts``, which creates drafts and nothing else.
        published_at: Publication instant. Filled with an aware UTC "now" when ``status`` is
            ``PUBLISHED`` and this is omitted; otherwise used exactly as given, including
            ``None``. Pass a value explicitly to control feed ordering, which sorts on this
            column descending.
        view_count: Readership counter. Defaults to ``0``; ``ck_posts_view_count_non_negative``
            rejects a negative value.
        categories: Categories to file the post under, associated through the
            ``Post.categories`` relationship whose ``secondary`` is the ``post_categories``
            table. Never inserted into that table by hand, so the composite primary key that
            forbids duplicate filing stays the only rule in play.

    Returns:
        The persisted :class:`~app.models.Post`. Every column is loaded, ``search_vector``
        included, and ``categories`` is loaded so it can be read without awaiting again.

    Raises:
        ValueError: If ``author`` has no identity and none can be assigned.

    Examples:
        A draft, a published post with known searchable text, and a filed post::

            draft = await create_post(session, author=author)
            hit = await create_post(
                session,
                author=author,
                title="Scaling FastAPI",
                content="Connection pooling under load.",
                status=PostStatus.PUBLISHED,
            )
            filed = await create_post(session, author=author, categories=[category])
    """
    discriminator = _next_n()
    author_id = await _identity_of(session, author, "author")
    resolved_title = title if title is not None else fake.sentence(nb_words=6).rstrip(".")
    # Materialised before construction: an exhausted iterator would silently file the post
    # under nothing, and the argument is documented as an iterable rather than a sequence.
    resolved_categories = list(categories)

    post = Post(
        author_id=author_id,
        title=resolved_title,
        slug=slug if slug is not None else _unique_slug(resolved_title, discriminator),
        excerpt=excerpt if excerpt is not None else fake.paragraph(nb_sentences=2),
        # Four paragraphs rather than a word, so the generated tsvector has enough lexemes for
        # `ts_rank` to order by and for a trigram fallback to match against.
        content=content if content is not None else "\n\n".join(fake.paragraphs(nb=4)),
        cover_image_url=cover_image_url,
        status=status,
        # The missing instant is filled in, and only the missing one. The check constraint
        # named ck_posts_published_at_required would otherwise reject the row, and inventing a
        # date for a draft would make `published_at IS NOT NULL` useless as a "has this ever
        # been public" test.
        #
        # Compared with `==` rather than `is`. PostStatus is a StrEnum, so a caller that wrote
        # the label as a plain string still gets its publication instant - SQLAlchemy would
        # persist that string happily, and an identity comparison would silently skip the fill
        # and turn a readable call into an opaque constraint violation.
        published_at=(
            datetime.now(tz=UTC)
            if published_at is None and status == PostStatus.PUBLISHED
            else published_at
        ),
        view_count=view_count,
        # Assignment through the relationship writes the association rows in this same flush.
        categories=resolved_categories,
    )
    post = await _persist(session, post)
    # The refresh inside `_persist` expires every attribute on the instance, this collection
    # included, and reading an expired relationship under an async session raises
    # MissingGreenlet. Priming it through the `awaitable_attrs` accessor that `app.db.base`
    # documents as the supported safety valve means the caller can read `post.categories`
    # directly. Done unconditionally so the returned object is uniformly safe to read: an
    # empty collection is as much a thing a test asserts on as a populated one.
    await post.awaitable_attrs.categories
    return post


async def create_published_post(session: AsyncSession, *, author: User, **kwargs: Any) -> Post:
    """Create a published ``posts`` row, stamping ``published_at`` if it is not supplied.

    The shape most tests want, because the public feed, the category filter and the public
    profile all filter on :attr:`~app.models.PostStatus.PUBLISHED` explicitly - so a default
    :func:`create_post` is invisible to every one of them, which is correct and is exactly why
    saying "published" needs to be one word rather than two arguments.

    Args:
        session: The session under test.
        author: The owning account.
        **kwargs: Any keyword argument :func:`create_post` accepts, except ``status``.

    Returns:
        The persisted post, with ``status`` set and ``published_at`` non-null.

    Raises:
        TypeError: If ``status`` is passed, since this helper supplies it. Use
            :func:`create_post` directly to build an archived or draft post.
    """
    return await create_post(session, author=author, status=PostStatus.PUBLISHED, **kwargs)


# ---------------------------------------------------------------------------------------
# Comments
# ---------------------------------------------------------------------------------------


async def create_comment(
    session: AsyncSession,
    *,
    post: Post,
    author: User,
    body: str | None = None,
    parent: Comment | None = None,
    status: CommentStatus | None = None,
) -> Comment:
    """Create a ``comments`` row and return it, persisted and reloaded.

    Args:
        session: The session under test.
        post: The post whose thread this comment joins.
        author: The account writing it, which need hold no particular role - commenting is
            gated on a bearer token, not on authority.
        body: Comment text, already considered sanitised here because sanitisation is
            ``app.services.comment_service``'s write-path concern and this module writes rows
            directly. Generated from Faker when omitted.
        parent: The comment being replied to, or ``None`` for a top-level comment. Supplying
            it sets ``parent_id`` and makes the row a reply, at any depth.
        status: Moderation state. Defaults to :attr:`~app.models.CommentStatus.APPROVED`
            rather than to the column's own ``PENDING`` server default, and the difference is
            deliberate. ``PENDING`` is the right *product* default - nothing a reader writes
            becomes public until it is moderated - but it would make every factory-created
            comment invisible to the public thread, so each test about reading comments would
            have to approve its own fixtures first. Tests about moderation pass the state they
            need explicitly.

    Returns:
        The persisted :class:`~app.models.Comment`.

    Raises:
        ValueError: If ``post`` or ``author`` has no identity, or if ``parent`` belongs to a
            different post. The database can guarantee a parent exists but cannot compare its
            post to the reply's without a redundant column, so the check is made here - the
            same rule ``app.services.comment_service`` applies on the request path. Letting it
            pass would build a thread that no query could ever read back coherently.

    Examples:
        A visible comment, a reply to it, and one waiting in the moderation queue::

            top = await create_comment(session, post=post, author=reader)
            reply = await create_comment(session, post=post, author=reader, parent=top)
            queued = await create_comment(
                session, post=post, author=reader, status=CommentStatus.PENDING
            )
    """
    post_id = await _identity_of(session, post, "post")
    author_id = await _identity_of(session, author, "author")

    parent_id: uuid.UUID | None = None
    if parent is not None:
        parent_id = await _identity_of(session, parent, "parent")
        if parent.post_id != post_id:
            raise ValueError(
                "parent belongs to a different post: a reply must join the same thread as the "
                f"comment it answers (parent.post_id={parent.post_id!s}, post={post_id!s})."
            )

    comment = Comment(
        post_id=post_id,
        author_id=author_id,
        parent_id=parent_id,
        body=body if body is not None else fake.paragraph(nb_sentences=3),
        status=status if status is not None else CommentStatus.APPROVED,
    )
    return await _persist(session, comment)


# ---------------------------------------------------------------------------------------
# Likes
#
# `post_likes` is keyed on (post_id, user_id) and takes no surrogate key, so the pair IS the
# identity. That is what makes liking idempotent in the database rather than in the
# application, and it is why `PUT /api/v1/posts/{id}/like` needs no de-duplication step and is
# safe to retry: a second attempt at the same pair cannot become a second row, so a repeated
# request cannot inflate the count.
#
# The two helpers below sit on opposite sides of that guarantee deliberately.
# `create_like` performs a plain INSERT, so a duplicate pair RAISES - which is what a test
# asserting that the constraint exists needs to observe. `create_like_if_absent` absorbs the
# conflict, which is what a test that merely needs the like to be present wants.
# ---------------------------------------------------------------------------------------


async def create_like(session: AsyncSession, *, post: Post, user: User) -> PostLike:
    """Create a ``post_likes`` row for this ``(post, user)`` pair.

    Only the two key columns are set. There is no ``id`` to supply - the composite primary key
    is the whole of this relation's identity - and ``created_at`` comes from the database
    clock, which is why two likes written by different workers are ordered by one clock rather
    than by however many application clocks were involved.

    A plain INSERT, so **calling this twice for the same pair raises** an
    :exc:`~sqlalchemy.exc.IntegrityError` on the primary key. That is the correct behaviour for
    this helper and is directly useful: it is how a test demonstrates that idempotency is a
    database guarantee rather than application bookkeeping. Use
    :func:`create_like_if_absent` when the like merely needs to exist.

    A failed flush aborts the enclosing transaction, so a test that means to *observe* that
    failure and then keep using the session must contain it in a savepoint::

        await create_like(session, post=post, user=user)
        with pytest.raises(IntegrityError):
            async with session.begin_nested():
                await create_like(session, post=post, user=user)

    Args:
        session: The session under test.
        post: The post being liked.
        user: The account granting the like.

    Returns:
        The persisted :class:`~app.models.PostLike`, with ``created_at`` loaded.

    Raises:
        ValueError: If ``post`` or ``user`` has no identity.
        sqlalchemy.exc.IntegrityError: If this pair has already been liked.
    """
    post_id = await _identity_of(session, post, "post")
    user_id = await _identity_of(session, user, "user")
    return await _persist(session, PostLike(post_id=post_id, user_id=user_id))


async def create_like_if_absent(session: AsyncSession, *, post: Post, user: User) -> PostLike:
    """Ensure a ``post_likes`` row exists for this pair, tolerating one that already does.

    The idempotent counterpart to :func:`create_like`, named distinctly so a reader can see at
    the call site which behaviour was chosen. It issues ``INSERT ... ON CONFLICT DO NOTHING``
    against the composite primary key - the same statement
    ``app.repositories.like_repository`` uses on the request path - so calling it any number of
    times for one pair leaves exactly one row and the like count at one.

    Args:
        session: The session under test.
        post: The post being liked.
        user: The account granting the like.

    Returns:
        The persistent :class:`~app.models.PostLike` for the pair, whether this call inserted
        it or found it already there.

    Raises:
        ValueError: If ``post`` or ``user`` has no identity.
        RuntimeError: If the row is absent after the insert, which would mean the pair was
            neither inserted nor already present - impossible under ``ON CONFLICT DO
            NOTHING``, and reported rather than returned as ``None`` so it can never be
            mistaken for "not liked".
    """
    post_id = await _identity_of(session, post, "post")
    user_id = await _identity_of(session, user, "user")

    # The dialect-specific insert, because ON CONFLICT is PostgreSQL's own clause and this
    # project supports no other backend. `index_elements` names the key columns rather than
    # relying on a bare conflict target, so the statement says which uniqueness it is
    # absorbing - the composite primary key, and nothing else.
    statement = (
        pg_insert(PostLike)
        .values(post_id=post_id, user_id=user_id)
        .on_conflict_do_nothing(index_elements=["post_id", "user_id"])
    )
    await session.execute(statement)

    # A Core insert bypasses the unit of work, so the identity map does not learn about the
    # row; this SELECT is what turns it into the persistent instance the caller expects. The
    # key is passed as a mapping because the primary key is composite and a positional tuple
    # would silently depend on column order.
    like = await session.get(PostLike, {"post_id": post_id, "user_id": user_id})
    if like is None:
        raise RuntimeError(
            f"post_likes row for post={post_id!s} user={user_id!s} is absent after an "
            "ON CONFLICT DO NOTHING insert, which should be unreachable."
        )
    return like


# ---------------------------------------------------------------------------------------
# Refresh tokens
# ---------------------------------------------------------------------------------------


async def create_refresh_token(
    session: AsyncSession,
    *,
    user: User,
    expires_at: datetime | None = None,
    revoked_at: datetime | None = None,
) -> tuple[str, RefreshToken]:
    """Issue a refresh token for ``user`` and return the plaintext alongside its row.

    The plaintext is returned because **this call is the only moment it exists**. Only
    :func:`app.core.security.hash_refresh_token`'s digest is stored, so a caller that discards
    the first element of the tuple can never recover the token - and the token is exactly what
    ``POST /api/v1/auth/refresh`` and ``POST /api/v1/auth/logout`` take, which is what a
    rotation or reuse-detection test has to send.

    The digest is a deterministic, unsalted SHA-256 rather than argon2id, and that asymmetry is
    the schema's design rather than an oversight: the token is 32 bytes of CSPRNG output, so
    unguessability is already established, and a deterministic digest can be *found* through
    the unique index on ``refresh_tokens.token_hash``. A salted hash could only be verified,
    which would make rotation a table scan.

    Args:
        session: The session under test.
        user: The account the token is issued to.
        expires_at: Expiry instant. Defaults to :func:`app.core.security.refresh_token_expires_at`,
            the same value the service issues, so a factory-made row is shaped exactly like a
            real one. Pass a past instant to build the lapsed token that must be refused.
        revoked_at: Withdrawal instant, or ``None`` while the token is still exchangeable. Pass
            an instant to build the revoked token that must be refused.

    Returns:
        A ``(plaintext, row)`` pair: the opaque token as the client would hold it, and the
        persisted :class:`~app.models.RefreshToken` carrying only its digest.

    Raises:
        ValueError: If ``user`` has no identity.

    Examples:
        A live token, and the two negative cases the authentication contract requires - a
        revoked or expired token must yield ``401``::

            token, row = await create_refresh_token(session, user=user)
            _, lapsed = await create_refresh_token(
                session, user=user, expires_at=datetime.now(tz=UTC) - timedelta(days=1)
            )
            _, withdrawn = await create_refresh_token(
                session, user=user, revoked_at=datetime.now(tz=UTC)
            )
    """
    user_id = await _identity_of(session, user, "user")
    token = generate_refresh_token()
    refresh_token = RefreshToken(
        user_id=user_id,
        # Only the digest reaches the database. Storing the token itself would mean a database
        # disclosure handed over usable sessions.
        token_hash=hash_refresh_token(token),
        expires_at=expires_at if expires_at is not None else refresh_token_expires_at(),
        revoked_at=revoked_at,
    )
    return token, await _persist(session, refresh_token)
