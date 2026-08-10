"""Integration suite for ``app.db.seed`` - the writer that makes the product demonstrable.

Why this module exists
----------------------
``app/db/seed.py`` is 292 statements with a documented command-line entry point, and until this
module existed **not one of them was executed by any test**. It accounted for 62.5% of every
uncovered line in the backend, which meant the coverage gate's headline number understated how
well the rest of the code was covered *and* that a regression here would have been caught by
nothing at all. That matters more than a percentage: AAP §0.1.3 makes seed and reference data a
hard prerequisite - "An empty database renders the home feed, category filter, and pagination
controls untestable and undemonstrable" - and AAP §0.9.4.2 requires search-index behaviour to be
confirmed "with seeded data". The module every one of those claims rests on had no gate.

The reference categories in the test database come from migration ``0003``, not from this
module, so nothing incidental was exercising it either.

What is asserted, and why each property is the one worth pinning
---------------------------------------------------------------
* **Idempotency, demonstrated rather than described.** AAP §0.7.1.2 calls this "idempotent
  seeding" and the module's own contract is that it is "the writer expected to run repeatedly".
  So ``seed_all`` is run twice against one database and the second run must write **nothing** -
  no duplicate category, no second administrator, no ``…-2`` slug. A defect here is silent and
  cumulative: it produces a plausible-looking database with two of everything.
* **Reconciliation with revision 0003, at the data level.** ``REFERENCE_CATEGORIES`` is the
  canonical taxonomy and ``0003`` mirrors it value for value. On a migrated database the correct
  behaviour is therefore eight *skips* - the revision's rows are adopted, keeping their
  deterministic ``uuid5`` identifiers, rather than duplicated or replaced. Asserting the
  identifiers are unchanged is what distinguishes "adopted" from "re-created", which no row
  count could distinguish.
* **The publication invariant, from the writer's side.** The schema's
  ``CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL)`` is verified elsewhere to reject
  the alternative; here the point is that the seed satisfies it rather than works around it, and
  that a draft is genuinely unpublished (``published_at IS NULL``) so the feed's status scoping
  has something to scope.
* **The refusals, which are security properties and not error handling.** Three roster
  addresses are published constants in this repository and are valid registration inputs, so
  anyone may claim one before a deployment is first seeded. ``seed_authors`` must refuse to
  adopt such an account, because adopting it would hand a stranger the whole demonstration
  corpus - and a post's author may edit, delete, publish and unpublish it. The same shape
  applies to a demoted or deactivated administrator: seeding must report the mismatch rather
  than silently re-granting authority somebody removed on purpose. Each refusal is asserted to
  raise **and** to leave the row untouched.
* **``main()``, including its failure path.** The entry point is what the ``Makefile``'s
  ``seed`` target invokes, and its contract is that a failure writes *nothing* and exits
  non-zero. Both branches are driven here.

How ``main()`` is exercised without escaping the test transaction
-----------------------------------------------------------------
``main()`` owns its own unit of work: it takes a session from ``AsyncSessionLocal``, commits
once, and disposes the engine. Both names are module-level imports in ``app.db.seed``, so both
are replaced with ``monkeypatch.setattr`` - the session factory with one bound to *this test's*
connection, the engine with a recorder whose ``dispose`` is awaited and counted. The commit then
lands on the savepoint ``conftest``'s ``db_session`` opened rather than on the outer
transaction, so the real ``commit()`` path runs and is still rolled back at teardown. Nothing in
this module writes a row that survives it, and nothing here patches a function under test.

Isolation
---------
``db_session`` opens a transaction on a dedicated connection and rolls it back when the test
ends, with ``join_transaction_mode="create_savepoint"`` so a commit inside the code under test
is undone too. ``seed_all`` deliberately does not commit, for exactly this reason - its
docstring says "a caller inside a test wants the work inside its own transaction so it can roll
back". Nothing below truncates a table, deletes a reference row, or depends on another test
having run first, and the ninety-six-post corpus each seeding run writes leaves no trace.

Governing standards
-------------------
``review_rules`` reports that this project specifies **no user rules**; this module is in scope
because AAP §0.9.1 places ``backend/tests/**/*.py`` there. Three self-imposed standards from
AAP §0.10.1 shape it: *blocking quality gates* (#8), which is the whole reason it exists;
*secure-by-default authentication* (#6), which is why the adoption refusals are asserted as
first-class behaviour rather than as incidental errors; and *no secrets in the repository*
(#13), which is why no test here prints or asserts a plaintext credential - the administrator's
password is only ever observed through the fact that its stored form is an argon2id hash.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any, Final

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.slug import DEFAULT_MAX_LENGTH
from app.db import seed as seed_module
from app.db.seed import (
    ADMINISTRATOR_SLOT,
    ANGLES,
    AUTHOR_ROSTER,
    REFERENCE_CATEGORIES,
    SUBJECTS,
    Tally,
    seed_administrator,
    seed_all,
    seed_authors,
    seed_categories,
    seed_posts,
)
from app.models import Category, Post, PostStatus, User, UserRole, post_categories
from tests.factories import create_user

# Every test here writes to PostgreSQL through the ORM, which is what the `integration` marker
# registers. Applied at module level so `-m integration` selects the file whole, and
# `--strict-markers` guarantees the name is registered rather than a typo selecting nothing.
pytestmark = pytest.mark.integration


CORPUS_SIZE: Final[int] = len(SUBJECTS) * len(ANGLES)
"""How many posts the corpus holds: every subject crossed with every angle.

Derived rather than written as ``96`` so that appending a subject or an angle does not turn this
module red for the wrong reason. What is asserted is the *product*, which is the corpus's own
definition, not a number somebody has to remember to update.
"""

ROSTER_SIZE: Final[int] = len(AUTHOR_ROSTER)
"""Demonstration authors, excluding the administrator, derived for the same reason."""

SEEDED_USER_COUNT: Final[int] = ROSTER_SIZE + 1
"""Every account a seed run is responsible for: the roster plus the one administrator."""


# ---------------------------------------------------------------------------------------
# Counting helpers
#
# One reduction per relation, each returning a plain int, so an assertion reads as the
# sentence it is checking rather than as a query. `func.count()` over the primary key rather
# than a materialised `.all()`: the corpus is ninety-six rows and the point is the count.
# ---------------------------------------------------------------------------------------


async def _count(session: AsyncSession, column: Any) -> int:
    """Count non-null values of *column*.

    Args:
        session: The session under test.
        column: The column to count, which is always a primary key here.

    Returns:
        The row count as an ``int``. ``scalar`` cannot return ``None`` for ``count()``, but the
        signature says it can, so the result is coerced rather than cast.
    """
    return int((await session.scalar(select(func.count(column)))) or 0)


async def _category_ids_by_slug(session: AsyncSession) -> dict[str, uuid.UUID]:
    """Map every stored category slug to its identifier.

    Identifiers rather than rows, because the property being asserted is *provenance*: a
    category adopted from revision ``0003`` keeps the deterministic ``uuid5`` the revision gave
    it, and one re-created by the seed would carry a fresh ``gen_random_uuid()`` value instead.

    Args:
        session: The session under test.

    Returns:
        Slug to identifier, folded to lower case on the key so the mapping is comparable
        regardless of how ``citext`` returned it.
    """
    rows = (await session.execute(select(Category.slug, Category.id))).all()
    return {slug.casefold(): identifier for slug, identifier in rows}


async def _posts(session: AsyncSession) -> list[Post]:
    """Load every post, ordered by slug so a failure reports a stable first offender."""
    return list((await session.scalars(select(Post).order_by(Post.slug))).all())


async def _administrator(session: AsyncSession) -> User | None:
    """Load the account at the configured seed address, if there is one."""
    return await session.scalar(select(User).where(User.email == settings.SEED_ADMIN_EMAIL))


class TestSeedCategories:
    """``seed_categories`` against the taxonomy revision ``0003`` already inserted."""

    async def test_reconciles_with_revision_0003_instead_of_duplicating(
        self, db_session: AsyncSession
    ) -> None:
        """Eight skips, eight rows, and the revision's own identifiers still in place.

        This is the assertion the finding asked for. A migrated database already holds the
        taxonomy, so the correct outcome is adoption: nothing created, nothing replaced, and the
        deterministic ``uuid5`` identifiers revision ``0003`` wrote still on the rows - which is
        what keeps a category outside the blast radius of a schema rollback that never created
        it.
        """
        before = await _category_ids_by_slug(db_session)
        assert len(before) == len(REFERENCE_CATEGORIES)

        _, tally = await seed_categories(db_session)

        assert tally == Tally(created=0, skipped=len(REFERENCE_CATEGORIES))
        assert tally.total == len(REFERENCE_CATEGORIES)
        assert await _count(db_session, Category.id) == len(REFERENCE_CATEGORIES)
        assert await _category_ids_by_slug(db_session) == before

    async def test_returns_the_reference_taxonomy_keyed_by_derived_slug(
        self, db_session: AsyncSession
    ) -> None:
        """The mapping is keyed by what :attr:`CategorySpec.slug` derives, for every spec.

        ``seed_posts`` resolves a subject's category slugs through this mapping, so a missing
        key is the difference between a post carrying its associations and a post silently
        losing them.
        """
        resolved, _ = await seed_categories(db_session)

        assert set(resolved) == {spec.slug for spec in REFERENCE_CATEGORIES}
        for spec in REFERENCE_CATEGORIES:
            adopted = resolved[spec.slug]
            assert adopted.slug.casefold() == spec.slug.casefold()
            assert adopted.name == spec.name
            assert adopted.description == spec.description

    async def test_is_idempotent_within_one_unit_of_work(self, db_session: AsyncSession) -> None:
        """Called twice in one transaction, the second call still writes nothing."""
        first, first_tally = await seed_categories(db_session)
        second, second_tally = await seed_categories(db_session)

        assert first_tally == second_tally == Tally(created=0, skipped=len(REFERENCE_CATEGORIES))
        assert {slug: row.id for slug, row in first.items()} == {
            slug: row.id for slug, row in second.items()
        }
        assert await _count(db_session, Category.id) == len(REFERENCE_CATEGORIES)

    async def test_adopts_a_row_whose_slug_was_renamed_by_matching_on_the_name(
        self, db_session: AsyncSession
    ) -> None:
        """The name lookup exists for this case, and it is the one that breaks a second run.

        An operator who edited a category's slug leaves the slug lookup missing while the name
        remains unique, so an implementation checking only the slug would attempt an insert and
        collide on ``categories.name``. Folding the name comparison means the row is adopted
        instead - stricter than the case-sensitive constraint it protects, which is the safe
        direction for a script whose job is to be re-runnable.
        """
        spec = REFERENCE_CATEGORIES[0]
        renamed = await db_session.scalar(select(Category).where(Category.slug == spec.slug))
        assert renamed is not None
        original_id = renamed.id
        renamed.slug = f"{spec.slug}-renamed-by-operator"
        await db_session.flush()

        resolved, tally = await seed_categories(db_session)

        assert tally == Tally(created=0, skipped=len(REFERENCE_CATEGORIES))
        assert resolved[spec.slug].id == original_id
        assert await _count(db_session, Category.id) == len(REFERENCE_CATEGORIES)

    async def test_creates_a_missing_category_rather_than_skipping_it(
        self, db_session: AsyncSession
    ) -> None:
        """The create path, reached by removing one reference row first.

        A new row must arrive with a server-generated identifier rather than the revision's
        ``uuid5``: seeding deliberately does not adopt the revision's provenance mark, so a
        category an operator's seed run created is not deleted by a schema rollback that never
        created it.
        """
        spec = REFERENCE_CATEGORIES[-1]
        doomed = await db_session.scalar(select(Category).where(Category.slug == spec.slug))
        assert doomed is not None
        revision_identifier = doomed.id
        await db_session.delete(doomed)
        await db_session.flush()

        resolved, tally = await seed_categories(db_session)

        assert tally == Tally(created=1, skipped=len(REFERENCE_CATEGORIES) - 1)
        assert await _count(db_session, Category.id) == len(REFERENCE_CATEGORIES)
        assert resolved[spec.slug].id != revision_identifier
        assert resolved[spec.slug].name == spec.name


class TestSeedAdministrator:
    """``seed_administrator`` - created once, adopted untouched, and refused when unusable."""

    async def test_creates_one_active_admin_at_the_configured_address(
        self, db_session: AsyncSession
    ) -> None:
        """The account the admin dashboard exists for, with no plaintext anywhere near it."""
        assert await _administrator(db_session) is None

        administrator, tally = await seed_administrator(db_session)

        assert tally == Tally(created=1, skipped=0)
        assert administrator.email == settings.SEED_ADMIN_EMAIL
        assert administrator.role is UserRole.ADMIN
        assert administrator.is_active is True
        assert administrator.id is not None
        assert administrator.avatar_url is None
        # Observed only as a hash: argon2id output is self-describing, and the plaintext must
        # not be reachable from a stored row even in a test.
        assert administrator.password_hash.startswith("$argon2id$")
        assert settings.SEED_ADMIN_PASSWORD not in administrator.password_hash

    async def test_is_idempotent_and_leaves_an_existing_account_untouched(
        self, db_session: AsyncSession
    ) -> None:
        """A second run must not reset a rotated password or a deliberately edited profile.

        Untouched is a security property: an operator who rotated this credential must not have
        it silently replaced by the next ``make seed``.
        """
        first, first_tally = await seed_administrator(db_session)
        original_hash = first.password_hash
        first.display_name = "Rotated By An Operator"
        await db_session.flush()

        second, second_tally = await seed_administrator(db_session)

        assert first_tally == Tally(created=1, skipped=0)
        assert second_tally == Tally(created=0, skipped=1)
        assert second.id == first.id
        assert second.password_hash == original_hash
        assert second.display_name == "Rotated By An Operator"
        assert await _count(db_session, User.id) == 1

    async def test_resolves_a_handle_collision_rather_than_failing_on_it(
        self, db_session: AsyncSession
    ) -> None:
        """``users.username`` is unique ``citext``, so a pre-existing ``admin`` must not collide.

        The case is deliberately mixed: a stored ``Admin`` is the same handle as ``admin`` to
        PostgreSQL, so a resolver comparing case-sensitively would hand back a value the insert
        then rejects.
        """
        await create_user(db_session, username="Admin", email="someone-else@example.com")

        administrator, tally = await seed_administrator(db_session)

        assert tally == Tally(created=1, skipped=0)
        assert administrator.username.casefold() != "admin"
        assert administrator.username.casefold().startswith("admin")

    @pytest.mark.parametrize(
        ("role", "is_active", "expected_fragment"),
        [
            (UserRole.READER, True, "its role is READER rather than ADMIN"),
            (UserRole.ADMIN, False, "it is deactivated"),
        ],
        ids=["demoted", "deactivated"],
    )
    async def test_refuses_an_account_that_cannot_act_as_an_administrator(
        self,
        db_session: AsyncSession,
        role: UserRole,
        is_active: bool,
        expected_fragment: str,
    ) -> None:
        """Reported, never silently elevated - and the row is left exactly as it was.

        Returning any row carrying the configured address would let a run report success while
        leaving every ``/api/v1/admin`` route closed, and would attribute demonstration posts to
        an account that cannot administer anything. Promoting it instead would overrule a human
        decision about authority, which is the one change a seed script must never make.
        """
        existing = await create_user(
            db_session,
            email=settings.SEED_ADMIN_EMAIL,
            role=role,
            is_active=is_active,
        )

        with pytest.raises(ValueError, match=expected_fragment):
            await seed_administrator(db_session)

        await db_session.refresh(existing)
        assert existing.role is role
        assert existing.is_active is is_active
        # The message identifies the row by its public handle, never by the address
        # SEED_ADMIN_EMAIL carries.
        assert await _count(db_session, User.id) == 1

    async def test_the_refusal_names_both_problems_when_both_hold(
        self, db_session: AsyncSession
    ) -> None:
        """One round of configuration to fix rather than two."""
        await create_user(
            db_session,
            email=settings.SEED_ADMIN_EMAIL,
            role=UserRole.READER,
            is_active=False,
        )

        with pytest.raises(ValueError, match="cannot act as an administrator") as raised:
            await seed_administrator(db_session)

        message = str(raised.value)
        assert "its role is READER rather than ADMIN" in message
        assert "it is deactivated" in message


class TestSeedAuthors:
    """``seed_authors`` - the roster, and the adoption gate that stops content capture."""

    async def test_creates_the_whole_roster_in_roster_order(self, db_session: AsyncSession) -> None:
        """Order is load-bearing: ``PostDraft.author_slot`` indexes this list positionally."""
        authors, tally = await seed_authors(db_session)

        assert tally == Tally(created=ROSTER_SIZE, skipped=0)
        assert [author.email for author in authors] == [spec.email for spec in AUTHOR_ROSTER]
        for author, spec in zip(authors, AUTHOR_ROSTER, strict=True):
            assert author.role is UserRole.AUTHOR
            assert author.is_active is True
            assert author.display_name == spec.display_name
            assert author.bio == spec.bio
            assert author.avatar_url == spec.avatar_url
            assert author.username.casefold() == spec.username.casefold()
            assert author.password_hash.startswith("$argon2id$")

    async def test_is_idempotent(self, db_session: AsyncSession) -> None:
        """A second run adopts its own rows: same identifiers, no duplicates, no new handles."""
        first, first_tally = await seed_authors(db_session)
        second, second_tally = await seed_authors(db_session)

        assert first_tally == Tally(created=ROSTER_SIZE, skipped=0)
        assert second_tally == Tally(created=0, skipped=ROSTER_SIZE)
        assert [author.id for author in second] == [author.id for author in first]
        assert await _count(db_session, User.id) == ROSTER_SIZE

    async def test_each_created_author_receives_a_distinct_credential(
        self, db_session: AsyncSession
    ) -> None:
        """Fresh high-entropy passwords, so the roster is not three accounts with one key.

        These addresses are published in this repository, so a shared or derivable credential
        would be a sign-in path for anybody reading it.
        """
        authors, _ = await seed_authors(db_session)

        hashes = {author.password_hash for author in authors}
        assert len(hashes) == ROSTER_SIZE

    @pytest.mark.parametrize(
        ("role", "is_active", "display_name_override"),
        [
            (UserRole.READER, True, None),
            (UserRole.AUTHOR, False, None),
            (UserRole.AUTHOR, True, "Not The Seeded Author"),
        ],
        ids=["pre-claimed-reader", "deactivated", "different-display-name"],
    )
    async def test_refuses_to_adopt_an_account_that_is_not_the_seeded_author(
        self,
        db_session: AsyncSession,
        role: UserRole,
        is_active: bool,
        display_name_override: str | None,
    ) -> None:
        """The escalation this gate exists to stop, asserted from all three directions.

        A roster address is a published constant and a valid registration input, so anyone may
        hold one before a deployment is first seeded. Adopting such a row would attribute the
        demonstration corpus to it - and a post's author may edit, delete, publish and unpublish
        it. So the run stops, nothing is elevated, nothing is reassigned, and the roster slot is
        not skipped either: skipping would shift every later author's content onto the wrong
        byline.
        """
        spec = AUTHOR_ROSTER[0]
        claimed = await create_user(
            db_session,
            email=spec.email,
            role=role,
            is_active=is_active,
            display_name=display_name_override
            if display_name_override is not None
            else spec.display_name,
        )

        with pytest.raises(ValueError, match="is not the seeded author") as raised:
            await seed_authors(db_session)

        # The address is named because it is the value that selected the row and the thing an
        # operator has to act on; the message must not offer a way to adopt the account.
        assert spec.email in str(raised.value)

        await db_session.refresh(claimed)
        assert claimed.role is role
        assert claimed.is_active is is_active
        assert await _count(db_session, Post.id) == 0


class TestSeedPosts:
    """``seed_posts`` - the corpus, its lifecycle states and its associations."""

    @pytest.fixture
    async def prerequisites(
        self, db_session: AsyncSession
    ) -> tuple[User, list[User], dict[str, Category]]:
        """Seed the rows the corpus structurally requires, in the order the data forces.

        ``posts.author_id`` is a non-null foreign key and a subject names its categories, so
        neither argument can be fabricated: both come from the helpers that verify them.

        Returns rather than yields: there is nothing to tear down, because ``db_session``'s
        rollback undoes every row this wrote.
        """
        categories_by_slug, _ = await seed_categories(db_session)
        administrator, _ = await seed_administrator(db_session)
        authors, _ = await seed_authors(db_session)
        return administrator, authors, categories_by_slug

    async def test_writes_the_whole_corpus_with_valid_status_and_publication_pairs(
        self,
        db_session: AsyncSession,
        prerequisites: tuple[User, list[User], dict[str, Category]],
    ) -> None:
        """Every post satisfies the publication invariant the schema enforces.

        ``PUBLISHED`` and ``ARCHIVED`` carry an instant, ``DRAFT`` carries none - which is what
        gives the feed's status scoping something real to scope and what makes the ``CHECK``
        constraint a guarantee rather than an obstacle the seed had to route around.
        """
        administrator, authors, categories_by_slug = prerequisites

        tally = await seed_posts(
            db_session,
            administrator=administrator,
            authors=authors,
            categories_by_slug=categories_by_slug,
        )

        assert tally == Tally(created=CORPUS_SIZE, skipped=0)
        posts = await _posts(db_session)
        assert len(posts) == CORPUS_SIZE

        by_status: dict[PostStatus, int] = dict.fromkeys(PostStatus, 0)
        for post in posts:
            by_status[post.status] += 1
            if post.status is PostStatus.DRAFT:
                assert post.published_at is None, post.slug
            else:
                assert post.published_at is not None, post.slug
                assert post.published_at < datetime.now(UTC)
            assert post.title
            assert post.excerpt
            assert post.content
            assert post.view_count >= 0
            if post.status is not PostStatus.PUBLISHED:
                assert post.cover_image_url is None, post.slug

        # A corpus of one status would satisfy every assertion above while making the feed's
        # draft-confidentiality and archive behaviour undemonstrable.
        assert by_status[PostStatus.PUBLISHED] > 0
        assert by_status[PostStatus.DRAFT] > 0
        assert by_status[PostStatus.ARCHIVED] > 0

    async def test_slugs_are_unique_and_stable_across_runs(
        self,
        db_session: AsyncSession,
        prerequisites: tuple[User, list[User], dict[str, Category]],
    ) -> None:
        """A slug is a canonical URL, so it must be unique now and identical next run.

        Collisions are resolved *within the corpus* rather than against the database, which is
        precisely what keeps the second run from creating ninety-six ``…-2`` duplicates.
        """
        administrator, authors, categories_by_slug = prerequisites

        await seed_posts(
            db_session,
            administrator=administrator,
            authors=authors,
            categories_by_slug=categories_by_slug,
        )
        first_slugs = [post.slug for post in await _posts(db_session)]

        second_tally = await seed_posts(
            db_session,
            administrator=administrator,
            authors=authors,
            categories_by_slug=categories_by_slug,
        )

        assert len(set(first_slugs)) == CORPUS_SIZE
        assert second_tally == Tally(created=0, skipped=CORPUS_SIZE)
        assert [post.slug for post in await _posts(db_session)] == first_slugs

    async def test_every_post_is_owned_and_classified(
        self,
        db_session: AsyncSession,
        prerequisites: tuple[User, list[User], dict[str, Category]],
    ) -> None:
        """Ownership goes only to a verified row, and every post carries its associations.

        Association counts are read from the ``post_categories`` link rather than from a lazy
        relationship: touching ``post.categories`` from this context would emit a lazy load and
        raise ``MissingGreenlet``, which is the same reason the module itself never reconciles
        the associations of a skipped post.
        """
        administrator, authors, categories_by_slug = prerequisites

        await seed_posts(
            db_session,
            administrator=administrator,
            authors=authors,
            categories_by_slug=categories_by_slug,
        )

        permitted = {administrator.id, *(author.id for author in authors)}
        posts = await _posts(db_session)
        assert {post.author_id for post in posts} <= permitted
        # The administrator authors some of the corpus and the roster authors the rest, so a
        # bug that collapsed every byline onto one account would still pass a subset check.
        assert len({post.author_id for post in posts}) == SEEDED_USER_COUNT
        assert administrator.id in {post.author_id for post in posts}

        associations = await _count(db_session, post_categories.c.post_id)
        assert associations >= CORPUS_SIZE
        classified = set(
            (await db_session.scalars(select(post_categories.c.post_id))).all(),
        )
        assert classified == {post.id for post in posts}

    async def test_refuses_an_author_list_that_does_not_match_the_roster(
        self,
        db_session: AsyncSession,
        prerequisites: tuple[User, list[User], dict[str, Category]],
    ) -> None:
        """A short list would surface as an ``IndexError`` deep inside the loop instead."""
        administrator, authors, categories_by_slug = prerequisites

        with pytest.raises(ValueError, match=r"expects \d+ authors in AUTHOR_ROSTER order"):
            await seed_posts(
                db_session,
                administrator=administrator,
                authors=authors[:-1],
                categories_by_slug=categories_by_slug,
            )

        assert await _count(db_session, Post.id) == 0

    async def test_refuses_a_subject_naming_a_category_outside_the_taxonomy(
        self,
        db_session: AsyncSession,
        prerequisites: tuple[User, list[User], dict[str, Category]],
    ) -> None:
        """Raising beats seeding a post whose absence from a filter nobody would notice.

        The withheld slug is one a subject actually cites, so the refusal is reached
        deterministically rather than depending on which slug sorts first.

        Atomicity is asserted through the caller's transaction rather than against this
        function, because that is where the module puts it: ``seed_posts`` promises only that it
        raises, and the rows it had already added are discarded by the rollback ``main()``
        performs. Asserting "nothing was written" of the function itself would assert a
        guarantee the module deliberately does not make - it does not own the unit of work.
        """
        administrator, authors, categories_by_slug = prerequisites
        withheld = SUBJECTS[0].category_slugs[0]
        incomplete = {
            slug: category for slug, category in categories_by_slug.items() if slug != withheld
        }

        with pytest.raises(ValueError, match="reconcile SUBJECTS with REFERENCE_CATEGORIES") as (
            raised
        ):
            await seed_posts(
                db_session,
                administrator=administrator,
                authors=authors,
                categories_by_slug=incomplete,
            )

        assert withheld in str(raised.value)
        # The corpus is incomplete, which is the whole point: the run stopped rather than
        # quietly seeding posts that a category filter would never return.
        assert await _count(db_session, Post.id) < CORPUS_SIZE

        await db_session.rollback()

        assert await _count(db_session, Post.id) == 0


class TestSeedAll:
    """The orchestration, and the idempotency property the whole module is judged on."""

    async def test_seeds_a_migrated_database_in_dependency_order(
        self, db_session: AsyncSession
    ) -> None:
        """One call leaves a database the home feed, filter and pagination can be shown from."""
        await seed_all(db_session)

        assert await _count(db_session, Category.id) == len(REFERENCE_CATEGORIES)
        assert await _count(db_session, User.id) == SEEDED_USER_COUNT
        assert await _count(db_session, Post.id) == CORPUS_SIZE

        administrator = await _administrator(db_session)
        assert administrator is not None
        assert administrator.role is UserRole.ADMIN

        published = await db_session.scalar(
            select(func.count(Post.id)).where(Post.status == PostStatus.PUBLISHED)
        )
        assert published is not None
        assert published > 0

    async def test_a_second_run_writes_nothing(self, db_session: AsyncSession) -> None:
        """The finding's headline request: ``seed_all`` twice, and the second run is a no-op.

        Counted per relation rather than in total, so a defect that duplicated one relation
        while another absorbed the difference cannot hide. Identifiers are compared too: a run
        that deleted and re-created a row would leave the counts identical.
        """
        await seed_all(db_session)
        categories_before = await _category_ids_by_slug(db_session)
        user_ids_before = set(
            (await db_session.scalars(select(User.id))).all(),
        )
        post_slugs_before = [post.slug for post in await _posts(db_session)]

        await seed_all(db_session)

        assert await _category_ids_by_slug(db_session) == categories_before
        assert set((await db_session.scalars(select(User.id))).all()) == user_ids_before
        assert [post.slug for post in await _posts(db_session)] == post_slugs_before
        assert await _count(db_session, Category.id) == len(REFERENCE_CATEGORIES)
        assert await _count(db_session, User.id) == SEEDED_USER_COUNT
        assert await _count(db_session, Post.id) == CORPUS_SIZE

    async def test_does_not_commit_so_a_caller_owns_the_transaction(
        self, db_session: AsyncSession
    ) -> None:
        """Stated in the function's contract, and relied on by every test in this module.

        A commit inside ``seed_all`` would take the choice away from both callers that have
        one: a test that wants to roll back, and ``main()`` that wants exactly one commit at the
        end. Asserted by rolling back and observing the rows disappear.
        """
        await seed_all(db_session)
        assert await _count(db_session, Post.id) == CORPUS_SIZE

        await db_session.rollback()

        assert await _count(db_session, Post.id) == 0
        assert await _count(db_session, User.id) == 0
        # The reference taxonomy survives because revision 0003 committed it, not this module.
        assert await _count(db_session, Category.id) == len(REFERENCE_CATEGORIES)


class _EngineRecorder:
    """A stand-in for the application engine that records its disposal.

    ``main()``'s contract is that ``engine.dispose()`` runs on the success path and the failure
    path alike, so the process exits with no pooled connection open. The real engine cannot be
    disposed here - the suite's session-scoped engine is shared by every remaining test - so the
    name is replaced for the duration of one call and the guarantee is observed rather than
    inferred.
    """

    def __init__(self) -> None:
        self.dispose_count = 0

    async def dispose(self) -> None:
        """Record one disposal. Awaited by ``main()`` inside its ``finally``."""
        self.dispose_count += 1


class TestMain:
    """The ``Makefile``'s ``seed`` target, both of its paths."""

    @pytest.fixture
    async def bound_session_factory(
        self, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
    ) -> _EngineRecorder:
        """Point ``main()`` at this test's connection and at a disposable engine.

        The factory yields a session bound to the same ``AsyncConnection`` ``db_session`` runs
        on, with the same ``join_transaction_mode``, so ``main()``'s single ``commit()`` releases
        a savepoint instead of ending the fixture's outer transaction. That is what lets the
        real commit path execute and still leave nothing behind.

        ``await db_session.connection()`` rather than ``get_bind()``: the latter returns the
        *synchronous* proxied connection, which ``AsyncSession`` rejects with
        ``ArgumentError: AsyncEngine expected``.

        Returns:
            The engine stand-in, so a test can assert the disposal happened.
        """
        connection = await db_session.connection()
        recorder = _EngineRecorder()

        class _Factory:
            """Minimal async-context session factory: what ``main()`` actually calls."""

            def __call__(self) -> Any:
                return AsyncSession(
                    bind=connection,
                    expire_on_commit=False,
                    join_transaction_mode="create_savepoint",
                )

        monkeypatch.setattr(seed_module, "AsyncSessionLocal", _Factory())
        monkeypatch.setattr(seed_module, "engine", recorder)
        return recorder

    async def test_seeds_commits_once_and_disposes_the_engine(
        self,
        db_session: AsyncSession,
        bound_session_factory: _EngineRecorder,
    ) -> None:
        """The success path end to end, through the real commit."""
        await seed_module.main()

        assert bound_session_factory.dispose_count == 1
        assert await _count(db_session, User.id) == SEEDED_USER_COUNT
        assert await _count(db_session, Post.id) == CORPUS_SIZE
        assert await _count(db_session, Category.id) == len(REFERENCE_CATEGORIES)

    async def test_is_idempotent_across_two_invocations(
        self,
        db_session: AsyncSession,
        bound_session_factory: _EngineRecorder,
    ) -> None:
        """Running the documented command twice is the case an operator actually hits."""
        await seed_module.main()
        await seed_module.main()

        assert bound_session_factory.dispose_count == 2
        assert await _count(db_session, User.id) == SEEDED_USER_COUNT
        assert await _count(db_session, Post.id) == CORPUS_SIZE

    async def test_rolls_back_and_re_raises_when_seeding_fails(
        self,
        db_session: AsyncSession,
        bound_session_factory: _EngineRecorder,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Nothing written, exception propagated, engine still disposed.

        The propagation is the part that makes ``make seed`` a gate rather than a suggestion:
        the exception leaves ``asyncio.run`` and the process exits non-zero. The failure is
        injected at the orchestration boundary - the whole point is what ``main()`` does with
        one, not which helper raised it - and it is injected *after* rows have been written so
        the rollback has something to undo.
        """
        real_seed_posts = seed_module.seed_posts
        marker = "seed failure injected by the test suite"

        async def _fail_after_writing(*args: Any, **kwargs: Any) -> Tally:
            await real_seed_posts(*args, **kwargs)
            raise RuntimeError(marker)

        monkeypatch.setattr(seed_module, "seed_posts", _fail_after_writing)

        with pytest.raises(RuntimeError, match=marker):
            await seed_module.main()

        assert bound_session_factory.dispose_count == 1
        assert await _count(db_session, User.id) == 0
        assert await _count(db_session, Post.id) == 0
        assert await _count(db_session, Category.id) == len(REFERENCE_CATEGORIES)


class TestHandleFamilyLookup:
    """``_taken_usernames`` - the two guards that keep handle resolution correct.

    Private, and reached directly because neither branch is reachable through the public
    helpers: every caller passes a non-empty list of short bases. They are nonetheless part of
    the module's stated contract - the docstring documents the ``ValueError`` - and each guards a
    property that would otherwise fail silently, which is exactly the shape of thing a test
    should hold rather than a comment. ``test_declared_surfaces.py`` reaches into
    ``app.core.config`` on the same terms.
    """

    async def test_an_empty_base_list_answers_without_querying(
        self, db_session: AsyncSession
    ) -> None:
        """A caller with nothing to place has nothing to avoid, so no statement is issued."""
        assert await seed_module._taken_usernames(db_session, bases=[]) == set()

    async def test_refuses_a_base_too_long_to_leave_room_for_a_suffix(
        self, db_session: AsyncSession
    ) -> None:
        """The guard behind the prefix-completeness argument the lookup rests on.

        ``unique_slug`` shortens a stem to fit a collision suffix inside the slug bound. If the
        stem were long enough for that to happen, the prefix this function searches on would no
        longer cover every handle in the family, and a collision could slip past into an
        ``IntegrityError`` at flush. Refusing up front is what keeps the search complete.
        """
        overlong = "a" * DEFAULT_MAX_LENGTH

        with pytest.raises(ValueError, match=r"characters of the \d+-character slug"):
            await seed_module._taken_usernames(db_session, bases=[overlong])

    async def test_finds_every_handle_in_a_family_whatever_its_case(
        self, db_session: AsyncSession
    ) -> None:
        """``users.username`` is ``citext``, so ``Admin`` is in the ``admin`` family.

        This is the lookup that turns a pre-existing handle into a suffixed one instead of a
        failed insert, and folding is the part that a plain ``LIKE`` over the text cast would
        lose.
        """
        await create_user(db_session, username="Admin", email="handle-family@example.com")
        await create_user(db_session, username="admin-2", email="handle-family-2@example.com")
        await create_user(db_session, username="unrelated", email="handle-family-3@example.com")

        taken = await seed_module._taken_usernames(db_session, bases=["admin"])

        assert {handle.casefold() for handle in taken} == {"admin", "admin-2"}


class TestSeedDataDefinitions:
    """The module-level constants everything above indexes, asserted as a set of invariants.

    These are import-time properties, but they belong beside the behaviour they govern: each one
    is a precondition of a helper above, and a violation would surface there as a confusing
    failure rather than as the data defect it is.
    """

    def test_reference_categories_are_unique_by_name_and_derived_slug(self) -> None:
        """Both columns are unique in the schema, so a duplicate spec is an insert failure."""
        assert len({spec.name for spec in REFERENCE_CATEGORIES}) == len(REFERENCE_CATEGORIES)
        assert len({spec.slug.casefold() for spec in REFERENCE_CATEGORIES}) == len(
            REFERENCE_CATEGORIES
        )
        for spec in REFERENCE_CATEGORIES:
            assert spec.slug
            assert spec.slug == spec.slug.casefold()
            assert " " not in spec.slug
            assert spec.description

    def test_the_roster_is_unique_and_addressable(self) -> None:
        """Emails and derived handles are both unique ``citext`` columns."""
        assert len({spec.email.casefold() for spec in AUTHOR_ROSTER}) == ROSTER_SIZE
        assert len({spec.username.casefold() for spec in AUTHOR_ROSTER}) == ROSTER_SIZE
        for spec in AUTHOR_ROSTER:
            assert spec.username
            assert spec.display_name
            assert spec.bio

    def test_every_subject_cites_only_reference_category_slugs(self) -> None:
        """The precondition ``_resolve_categories`` raises on, asserted where it can be read.

        A subject citing a slug the taxonomy does not contain stops a seed run outright, so
        catching it here names the defect instead of surfacing it as a failed run.
        """
        known = {spec.slug for spec in REFERENCE_CATEGORIES}
        for subject in SUBJECTS:
            assert subject.category_slugs
            assert set(subject.category_slugs) <= known, subject.category_slugs

    def test_the_administrator_slot_cannot_collide_with_a_roster_index(self) -> None:
        """``ADMINISTRATOR_SLOT`` is negative precisely so it is not a valid roster index."""
        assert ADMINISTRATOR_SLOT < 0
        assert ADMINISTRATOR_SLOT not in range(ROSTER_SIZE)

    def test_the_corpus_is_the_product_of_subjects_and_angles(self) -> None:
        """The shape every position-based rule in the module assumes."""
        assert len(SUBJECTS) > 0
        assert len(ANGLES) > 0
        assert len(SUBJECTS) * len(ANGLES) == CORPUS_SIZE

    def test_a_tally_reports_what_it_is_responsible_for(self) -> None:
        """``total`` is the sum, and the dataclass is frozen because a tally is a result."""
        tally = Tally(created=3, skipped=5)

        assert tally.total == 8
        assert Tally(created=0, skipped=0) == Tally()
        with pytest.raises(AttributeError):
            tally.created = 9  # type: ignore[misc]
