"""The five authority predicates, exercised in memory: no request, no session, no database.

What is under test
------------------
The whole of post-and-comment authority, as ``app.core.dependencies`` expresses it:

``is_admin(user)``
    Whether a principal holds the administrator role.
``can_author(user)`` / ``ensure_can_author(user)``
    The *capability* half - whether a principal may have content at all.
``can_modify(user, owner_id)`` / ``ensure_can_modify(user, owner_id)``
    The *ownership* half - whether a principal may act on this particular row.

The two halves are independent and neither implies the other, which is why
:class:`TestTheTwoHalvesOfPostAuthority` asserts the four corners of that relationship
rather than trusting the pair to stay orthogonal by accident.

Why this module can exist at all
--------------------------------
Because the rules live in ``app.core.dependencies`` and are called from the service layer
rather than being written out inside each route handler, every one of them is a plain
function over a constructed object. There is no HTTP client here, no ``AsyncSession``, no
fixture from ``backend/tests/conftest.py``, no helper from ``backend/tests/factories.py``,
no ``await`` and no event loop - so the full role x ownership matrix costs six parameters
instead of six requests. That is the layering standard paying for itself: the identical rule
is proven over the wire in ``backend/tests/integration/test_posts_api.py`` and
``test_comments_api.py``, which assert the 403 a non-owner receives; the *response* belongs
there and the *rule* belongs here, and neither duplicates the other.

The counterpart in the repository this service replaced is instructive: ``app.py`` had no
authority check of any kind, and wrote its one identity predicate - ``item.id == item_id`` -
out by hand in three separate handlers. One definition in one place is what makes a matrix
like the one below possible.

Two facts the assertions depend on
----------------------------------
1. **Identity is server-generated.** ``users.id`` is a UUID with
   ``server_default=gen_random_uuid()`` and deliberately no Python-side default, so a
   ``User()`` that has never been INSERTed has ``id is None``. An ownership test that passed
   ``owner_id=user.id`` on such an instance would be comparing ``None`` to ``None`` and would
   pass for entirely the wrong reason. :func:`make_user` therefore assigns
   ``id=uuid.uuid4()`` itself, :func:`_owner_id_for` refuses to proceed without it, and
   :class:`TestTheHarnessItself` asserts both halves of that guarantee so the trap cannot
   reopen silently.
2. **Importing the module under test is not the same as reaching a database.**
   ``app.core.dependencies`` imports ``app.db.session``, which constructs an async engine;
   ``create_async_engine`` resolves configuration but opens no connection, so nothing here
   performs I/O. The import does need a syntactically valid ``DATABASE_URL``, a
   ``JWT_SECRET_KEY`` of at least 32 characters and an ``ENVIRONMENT``, and the pre-import
   bootstrap at the top of ``backend/tests/conftest.py`` puts all three in
   :data:`os.environ` before ``app.core.config`` is first imported. That is the only reason
   this module has anything to do with conftest at all - it requests no fixture from it.

What is deliberately *not* asserted
-----------------------------------
Role strings never appear anywhere in this module, and every role is named as a
``UserRole`` member. ``UserRole`` is a :class:`~enum.StrEnum`, so comparing ``user.role``
against the equivalent string literal would also be true - and a mis-cased or misspelled
literal would compile, read correctly and be silently false forever. The member is the
contract, and getting *its* name wrong is an ``AttributeError`` at import time rather than an
authorisation bypass at runtime.
Neither is any error *message* asserted: :class:`~app.core.exceptions.ForbiddenError` is
identified by its type and its status, both of which are contracts, while its ``detail`` is
prose that may be reworded without breaking a caller.

``require_admin``, ``require_author``, ``get_current_user`` and ``get_db`` are also absent.
They are FastAPI dependencies, they need a request or a session, and their behaviour is
proven in ``backend/tests/integration/test_admin_api.py``. This module covers only the pure
predicates they delegate to.
"""

from __future__ import annotations

import uuid
from http import HTTPStatus
from typing import Final

import pytest

from app.core.dependencies import (
    can_author,
    can_modify,
    ensure_can_author,
    ensure_can_modify,
    is_admin,
)
from app.core.exceptions import ForbiddenError
from app.models import User, UserRole

# Every test in this module touches neither the database nor the network, which is the exact
# definition `backend/pyproject.toml` registers for this marker. Declared once at module level
# so `pytest -m unit` selects the whole file; `--strict-markers` is satisfied because the name
# is registered there.
pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------------------
# Construction
#
# `users.password_hash` is NOT NULL, so an in-memory instance still needs a value in it. This
# one is transparently fake and is never verified against anything: no test here calls
# `app.core.security`, and nothing is persisted, so no UNIQUE constraint and no password
# policy can fire on any of these objects.
# ---------------------------------------------------------------------------------------

_NOT_A_REAL_HASH: Final[str] = "placeholder-never-verified"


def make_user(role: UserRole, *, is_active: bool = True) -> User:
    """Construct an unpersisted :class:`~app.models.user.User` holding *role*.

    In memory only: the instance is never added to a session, flushed or committed, and no
    factory from ``backend/tests/factories.py`` is involved - every helper there takes an
    ``AsyncSession`` and returns a flushed row, which would drag a database and an event loop
    into a module that needs neither.

    ``id``, ``role`` and ``is_active`` are all assigned explicitly because each of them is a
    *server* default on the mapped column and therefore materialises on INSERT rather than on
    construction. ``id`` matters most: see fact 1 in the module docstring.

    Args:
        role: The authority the principal holds. Always a :class:`~app.models.user.UserRole`
            member rather than its string value.
        is_active: Whether the account is usable. Defaults to ``True``; pass ``False`` to
            assert that these predicates are indifferent to it, which they are by design -
            deactivation is enforced by ``get_current_active_user``, one layer up.

    Returns:
        A distinct principal with a freshly minted UUID identity.
    """
    # A per-instance discriminator, so two principals in one test are visibly different
    # objects rather than two copies of the same fixture data.
    discriminator = uuid.uuid4().hex[:12]

    return User(
        id=uuid.uuid4(),
        email=f"{discriminator}@example.test",
        username=f"principal-{discriminator}",
        password_hash=_NOT_A_REAL_HASH,
        display_name=f"Principal {discriminator}",
        role=role,
        is_active=is_active,
    )


def _unrelated_owner_id(user: User) -> uuid.UUID:
    """Mint an owner identifier that provably belongs to somebody else.

    The distinctness assertion is the point of the helper. Without it, a defect that made the
    two identifiers equal - or left them both ``None`` - would turn every "non-owner is
    refused" test into a "the owner is permitted" test that still reported green.
    """
    owner_id = uuid.uuid4()
    assert owner_id != user.id, "the unrelated owner id collided with the principal's own"
    return owner_id


def _owner_id_for(user: User, *, owns: bool) -> uuid.UUID:
    """Resolve the ``owner_id`` argument for one row of the ownership matrix.

    Args:
        user: The principal under test.
        owns: ``True`` to address a resource the principal owns, ``False`` to address one
            belonging to an unrelated account.

    Returns:
        The principal's own identifier, or a freshly minted unrelated one.
    """
    if owns:
        assert user.id is not None, (
            "the principal has no identifier, so an ownership comparison would be None == None"
        )
        return user.id

    return _unrelated_owner_id(user)


def _ownership_id(role: UserRole, owns: bool) -> str:
    """Name one row of the ownership matrix, so a failure reports which combination broke."""
    return f"{role.value}-{'owner' if owns else 'stranger'}"


# ---------------------------------------------------------------------------------------
# The matrices
#
# One table per rule, and every derived list below is computed FROM it rather than written
# out again, so a row cannot be permitted here and denied three tests further down.
# ---------------------------------------------------------------------------------------

#: ``(role, owns_the_resource, may_modify_it)`` - the complete ownership rule. An account acts
#: on its own content; an administrator acts on anyone's.
_OWNERSHIP_MATRIX: Final[tuple[tuple[UserRole, bool, bool], ...]] = (
    (UserRole.READER, True, True),
    (UserRole.READER, False, False),
    (UserRole.AUTHOR, True, True),
    (UserRole.AUTHOR, False, False),
    (UserRole.ADMIN, True, True),
    (UserRole.ADMIN, False, True),
)

_OWNERSHIP_IDS: Final[tuple[str, ...]] = tuple(
    _ownership_id(role, owns) for role, owns, _ in _OWNERSHIP_MATRIX
)

_PERMITTED_OWNERSHIP_ROWS: Final[tuple[tuple[UserRole, bool], ...]] = tuple(
    (role, owns) for role, owns, permitted in _OWNERSHIP_MATRIX if permitted
)

_PERMITTED_OWNERSHIP_IDS: Final[tuple[str, ...]] = tuple(
    _ownership_id(role, owns) for role, owns in _PERMITTED_OWNERSHIP_ROWS
)

_DENIED_OWNERSHIP_ROWS: Final[tuple[tuple[UserRole, bool], ...]] = tuple(
    (role, owns) for role, owns, permitted in _OWNERSHIP_MATRIX if not permitted
)

_DENIED_OWNERSHIP_IDS: Final[tuple[str, ...]] = tuple(
    _ownership_id(role, owns) for role, owns in _DENIED_OWNERSHIP_ROWS
)

#: ``(role, holds_the_administrator_role)`` - every member of the enumeration, so the role
#: predicate is asserted for all of them rather than for the interesting one.
_ADMIN_ROLE_MATRIX: Final[tuple[tuple[UserRole, bool], ...]] = (
    (UserRole.READER, False),
    (UserRole.AUTHOR, False),
    (UserRole.ADMIN, True),
)

#: ``(role, may_author)`` - the capability rule. ``ADMIN`` passes because an administrator's
#: authority is a superset of an author's everywhere else; ``READER`` is the one denial.
_CAPABILITY_MATRIX: Final[tuple[tuple[UserRole, bool], ...]] = (
    (UserRole.READER, False),
    (UserRole.AUTHOR, True),
    (UserRole.ADMIN, True),
)

_ADMIN_ROLE_IDS: Final[tuple[str, ...]] = tuple(role.value for role, _ in _ADMIN_ROLE_MATRIX)

_CAPABILITY_IDS: Final[tuple[str, ...]] = tuple(role.value for role, _ in _CAPABILITY_MATRIX)


# ---------------------------------------------------------------------------------------
# The harness
#
# Assertions about the constructed objects themselves, because every ownership test below is
# only meaningful if they hold. They are cheap, and they close the one failure mode that
# would leave the whole module green while proving nothing.
# ---------------------------------------------------------------------------------------


class TestTheHarnessItself:
    """Guards on the constructed principals, so a false pass cannot go unnoticed."""

    def test_an_unpersisted_user_has_no_identifier_of_its_own(self) -> None:
        """``users.id`` is a server default, so construction alone does not populate it.

        This is asserted rather than assumed: if a Python-side default were ever added to the
        mixin, the ownership tests would keep passing while quietly no longer proving that
        :func:`make_user` is what supplies identity - and the ``None == None`` trap the helper
        exists to prevent would be one edit away from returning.
        """
        assert User().id is None

    def test_make_user_assigns_a_uuid_identity(self) -> None:
        user = make_user(UserRole.AUTHOR)

        assert user.id is not None
        assert isinstance(user.id, uuid.UUID)

    def test_each_constructed_principal_is_a_distinct_account(self) -> None:
        first = make_user(UserRole.AUTHOR)
        second = make_user(UserRole.AUTHOR)

        assert first.id != second.id
        assert first.email != second.email
        assert first.username != second.username

    def test_the_declared_role_survives_construction(self) -> None:
        for role in UserRole:
            assert make_user(role).role is role

    def test_activeness_is_settable_in_both_directions(self) -> None:
        assert make_user(UserRole.READER).is_active is True
        assert make_user(UserRole.READER, is_active=False).is_active is False

    def test_every_role_appears_in_every_matrix(self) -> None:
        """A member added to the enumeration must be added to the tables, not silently skipped.

        The tables below enumerate roles by hand, which is what makes them readable as a
        specification. This is the price of that: without this assertion a fourth role could be
        introduced and left out of every table, and the suite would still report green while
        covering two thirds of the rule.
        """
        members = set(UserRole)

        assert {role for role, _ in _ADMIN_ROLE_MATRIX} == members
        assert {role for role, _ in _CAPABILITY_MATRIX} == members
        assert {role for role, _, _ in _OWNERSHIP_MATRIX} == members

    def test_the_ownership_matrix_covers_both_polarities_for_every_role(self) -> None:
        """Six rows, and no role represented only as an owner or only as a stranger.

        The AAP names all six role-by-ownership combinations, so the completeness of the table
        is asserted here rather than left to be counted by eye when it changes.
        """
        assert len(_OWNERSHIP_MATRIX) == len(UserRole) * 2

        for role in UserRole:
            polarities = {owns for candidate, owns, _ in _OWNERSHIP_MATRIX if candidate is role}
            assert polarities == {True, False}, role

    def test_the_permitted_and_denied_splits_partition_the_ownership_matrix(self) -> None:
        """The derived lists must together be the whole table and separately be disjoint.

        ``ensure_can_modify`` is asserted through those two lists, so a row that fell out of
        both would silently stop being exercised as a guard at all.
        """
        permitted = set(_PERMITTED_OWNERSHIP_ROWS)
        denied = set(_DENIED_OWNERSHIP_ROWS)

        assert permitted | denied == {(role, owns) for role, owns, _ in _OWNERSHIP_MATRIX}
        assert permitted & denied == set()


# ---------------------------------------------------------------------------------------
# is_admin - the role predicate
# ---------------------------------------------------------------------------------------


class TestIsAdmin:
    """``is_admin`` reports the administrator role, and nothing else about the account."""

    @pytest.mark.parametrize(("role", "expected"), _ADMIN_ROLE_MATRIX, ids=_ADMIN_ROLE_IDS)
    def test_reports_the_administrator_role_for_every_member(
        self, role: UserRole, expected: bool
    ) -> None:
        """``is True`` / ``is False`` rather than ``assert``, so a truthy non-boolean fails.

        A predicate that returned the role member itself, or a non-empty string, would satisfy
        a bare ``assert`` and would be a different function from the one the service layer is
        written against.
        """
        assert is_admin(make_user(role)) is expected

    def test_exactly_one_role_confers_administrator_authority(self) -> None:
        """Iterates the enumeration, so a role added later is covered without an edit here.

        If a fourth member were introduced and wrongly granted administrator authority - or if
        ``ADMIN`` were ever demoted - the count changes and this fails, whether or not anybody
        remembered to extend the table above.
        """
        conferred = [role for role in UserRole if is_admin(make_user(role))]

        assert conferred == [UserRole.ADMIN]

    @pytest.mark.parametrize(("role", "expected"), _ADMIN_ROLE_MATRIX, ids=_ADMIN_ROLE_IDS)
    def test_is_indifferent_to_whether_the_account_is_active(
        self, role: UserRole, expected: bool
    ) -> None:
        """Deactivation is not this predicate's concern, and the separation is deliberate.

        ``users.is_active`` withdraws an account, and it is enforced one layer up:
        ``get_current_active_user`` raises
        :class:`~app.core.exceptions.ForbiddenError` for a deactivated principal and
        ``get_current_user_optional`` resolves it as anonymous, so a suspended administrator
        never reaches a service call in the first place. Folding the check in here as well
        would put the same rule in two places and make the role predicate answer a question it
        was not asked.
        """
        assert is_admin(make_user(role, is_active=False)) is expected


# ---------------------------------------------------------------------------------------
# can_modify - the ownership predicate
# ---------------------------------------------------------------------------------------


class TestCanModify:
    """The complete ownership rule: own your content, or hold ``ADMIN``."""

    @pytest.mark.parametrize(("role", "owns", "expected"), _OWNERSHIP_MATRIX, ids=_OWNERSHIP_IDS)
    def test_the_full_role_and_ownership_matrix(
        self, role: UserRole, owns: bool, expected: bool
    ) -> None:
        user = make_user(role)
        owner_id = _owner_id_for(user, owns=owns)

        assert can_modify(user, owner_id) is expected

    def test_an_author_may_act_on_their_own_resource(self) -> None:
        author = make_user(UserRole.AUTHOR)

        assert can_modify(author, author.id) is True

    def test_an_author_may_not_act_on_someone_elses_resource(self) -> None:
        """The negative half of "an author may act only on their own posts".

        The owner identifier is asserted distinct from the principal's inside
        :func:`_unrelated_owner_id` before the predicate is called, so this cannot pass by
        accidentally comparing an identifier with itself.
        """
        author = make_user(UserRole.AUTHOR)

        assert can_modify(author, _unrelated_owner_id(author)) is False

    def test_a_reader_may_not_act_on_someone_elses_resource(self) -> None:
        reader = make_user(UserRole.READER)

        assert can_modify(reader, _unrelated_owner_id(reader)) is False

    def test_an_administrator_may_act_on_anyones_resource(self) -> None:
        """An administrator may act on any - asserted repeatedly, against unrelated owners.

        Three distinct owners rather than one, because the rule is "regardless of ownership"
        and a single stranger cannot distinguish that from a coincidence.
        """
        administrator = make_user(UserRole.ADMIN)

        for _ in range(3):
            assert can_modify(administrator, _unrelated_owner_id(administrator)) is True

    def test_owner_ids_are_uuids_rather_than_integers(self) -> None:
        """Identity is a server-generated UUID, which is what retired the legacy design.

        The superseded ``Item`` contract declared ``id: int`` and let the client supply it, so
        a duplicate identifier was storable and permanently shadowed every later record. The
        argument this predicate compares is a :class:`uuid.UUID` on both sides.
        """
        user = make_user(UserRole.AUTHOR)
        owner_id = _unrelated_owner_id(user)

        assert isinstance(user.id, uuid.UUID)
        assert isinstance(owner_id, uuid.UUID)

    @pytest.mark.parametrize(("role", "expected"), _ADMIN_ROLE_MATRIX, ids=_ADMIN_ROLE_IDS)
    def test_an_absent_owner_reduces_the_rule_to_the_administrator_role(
        self, role: UserRole, expected: bool
    ) -> None:
        """An unowned resource is not modifiable *by ownership* - but ``ADMIN`` still is.

        ``owner_id`` is declared as a :class:`uuid.UUID`, so ``None`` is off the contract; the
        predicate is nonetheless total, and the branch it takes matters. ``user.id == None`` is
        false for every principal, which denies a reader and an author outright. An
        administrator is then permitted by the second clause, because administrative authority
        is a property of the role and was never derived from ownership - the same answer it
        gives for a resource belonging to a stranger. What remains is therefore exactly
        :func:`is_admin`, which is why this reuses that table rather than declaring a third one:
        an orphaned or not-yet-persisted row cannot become modifiable by accident, and the one
        caller still permitted is permitted for a reason that is written down.
        """
        assert can_modify(make_user(role), None) is expected  # type: ignore[arg-type]

    @pytest.mark.parametrize(("role", "owns", "expected"), _OWNERSHIP_MATRIX, ids=_OWNERSHIP_IDS)
    def test_is_indifferent_to_whether_the_account_is_active(
        self, role: UserRole, owns: bool, expected: bool
    ) -> None:
        """Same reasoning as the indifference test on :class:`TestIsAdmin`.

        A deactivated account never reaches a service call, because the principal resolver
        refuses it first. The ownership rule therefore answers ownership only, and the whole
        matrix is asserted again with the flag cleared to prove no row quietly depends on it.
        """
        user = make_user(role, is_active=False)
        owner_id = _owner_id_for(user, owns=owns)

        assert can_modify(user, owner_id) is expected


# ---------------------------------------------------------------------------------------
# ensure_can_modify - the guard form
#
# The distinction from the predicate is the whole reason both exist. A caller who forgets to
# branch on a boolean has silently authorised the operation; a caller who forgets to catch an
# exception has not.
# ---------------------------------------------------------------------------------------


class TestEnsureCanModify:
    """The ownership rule as a guard: returns nothing, or raises the domain error."""

    @pytest.mark.parametrize(
        ("role", "owns"), _PERMITTED_OWNERSHIP_ROWS, ids=_PERMITTED_OWNERSHIP_IDS
    )
    def test_returns_none_when_the_principal_is_permitted(self, role: UserRole, owns: bool) -> None:
        """No ``pytest.raises`` wrapper: not raising is the assertion.

        The return value is checked as well, because ``None`` is deliberate. There is no truthy
        result to discard by accident, so ``ensure_can_modify(user, post.author_id)`` on a line
        of its own is a complete check rather than a computation somebody forgot to read.
        """
        user = make_user(role)
        owner_id = _owner_id_for(user, owns=owns)

        # Called for effect, not for a value. The guard signals refusal by raising and has
        # nothing to return, so reaching the end of this test IS the assertion that it permitted.
        ensure_can_modify(user, owner_id)

    @pytest.mark.parametrize(("role", "owns"), _DENIED_OWNERSHIP_ROWS, ids=_DENIED_OWNERSHIP_IDS)
    def test_raises_forbidden_when_the_principal_is_denied(
        self, role: UserRole, owns: bool
    ) -> None:
        """Denial is an exception rather than a falsy return, and it is the *domain* exception.

        The type is asserted exactly rather than with ``isinstance``, because the framework
        exception a route would once have raised is not acceptable here: services raise domain
        errors and one registered handler renders them as the single problem document, so
        asserting a framework type would let that translation be deleted without failing
        anything.
        """
        user = make_user(role)
        owner_id = _owner_id_for(user, owns=owns)

        with pytest.raises(ForbiddenError) as raised:
            ensure_can_modify(user, owner_id)

        assert raised.type is ForbiddenError

    def test_the_raised_error_carries_the_forbidden_status(self) -> None:
        """403, not 401: the credential is genuine and refreshing it would change nothing.

        Only the status is asserted. The ``detail`` is prose that may be reworded, and it is
        deliberately not part of the contract - the exception is raised bare precisely so the
        response never discloses who does own the resource.
        """
        author = make_user(UserRole.AUTHOR)

        with pytest.raises(ForbiddenError) as raised:
            ensure_can_modify(author, _unrelated_owner_id(author))

        assert raised.value.status_code == HTTPStatus.FORBIDDEN

    @pytest.mark.parametrize(("role", "owns", "expected"), _OWNERSHIP_MATRIX, ids=_OWNERSHIP_IDS)
    def test_agrees_with_the_predicate_on_every_combination(
        self, role: UserRole, owns: bool, expected: bool
    ) -> None:
        """The pair must not drift: the guard permits exactly what the predicate permits.

        This matters more than it looks. The services call the guard while other code may call
        the predicate, so a divergence between them would authorise on one path what it refused
        on the other - and would do so silently, since each function would still look correct
        read on its own.
        """
        user = make_user(role)
        owner_id = _owner_id_for(user, owns=owns)

        predicate_permits = can_modify(user, owner_id)
        try:
            ensure_can_modify(user, owner_id)
        except ForbiddenError:
            guard_permits = False
        else:
            guard_permits = True

        assert predicate_permits is guard_permits
        assert guard_permits is expected


# ---------------------------------------------------------------------------------------
# can_author and ensure_can_author - the capability half
#
# Covered here because they are the other pure predicates in the same section of
# `app.core.dependencies`, they take a principal and nothing else, and the ownership tests
# above would otherwise prove only half of what a post mutation actually checks.
# ---------------------------------------------------------------------------------------


class TestCanAuthor:
    """Whether a principal may have content at all, independent of who owns what."""

    @pytest.mark.parametrize(("role", "expected"), _CAPABILITY_MATRIX, ids=_CAPABILITY_IDS)
    def test_the_full_role_matrix(self, role: UserRole, expected: bool) -> None:
        assert can_author(make_user(role)) is expected

    def test_a_reader_may_not_author(self) -> None:
        """The denial that makes the ``role`` column constrain the account rather than describe it.

        An administrator can demote an account to ``READER``, and seeding creates reader
        accounts directly. Without this refusal the demotion would revoke nothing and the
        administrative control performing it would be decorative.
        """
        assert can_author(make_user(UserRole.READER)) is False

    def test_an_author_may_author(self) -> None:
        assert can_author(make_user(UserRole.AUTHOR)) is True

    def test_an_administrator_may_author(self) -> None:
        """Administrative authority is a superset of an author's on every other operation.

        A rule that let an administrator publish anyone's post but not write their own would be
        an inconsistency with no purpose.
        """
        assert can_author(make_user(UserRole.ADMIN)) is True

    def test_exactly_one_role_is_refused_the_capability(self) -> None:
        """Iterates the enumeration, so a role added later is covered without an edit here."""
        refused = [role for role in UserRole if not can_author(make_user(role))]

        assert refused == [UserRole.READER]

    @pytest.mark.parametrize(("role", "expected"), _CAPABILITY_MATRIX, ids=_CAPABILITY_IDS)
    def test_is_indifferent_to_whether_the_account_is_active(
        self, role: UserRole, expected: bool
    ) -> None:
        assert can_author(make_user(role, is_active=False)) is expected


class TestEnsureCanAuthor:
    """The capability rule as a guard, matching :class:`TestEnsureCanModify` exactly."""

    @pytest.mark.parametrize(("role", "expected"), _CAPABILITY_MATRIX, ids=_CAPABILITY_IDS)
    def test_returns_none_only_when_the_principal_is_permitted(
        self, role: UserRole, expected: bool
    ) -> None:
        user = make_user(role)

        if expected:
            # Returning rather than raising is the whole of "permitted" - see the ownership
            # guard's counterpart above for why the call is a statement and not a comparison.
            ensure_can_author(user)
            return

        with pytest.raises(ForbiddenError):
            ensure_can_author(user)

    def test_raises_forbidden_for_a_reader(self) -> None:
        with pytest.raises(ForbiddenError) as raised:
            ensure_can_author(make_user(UserRole.READER))

        assert raised.type is ForbiddenError

    def test_the_raised_error_carries_the_forbidden_status(self) -> None:
        """403 rather than 401: a refreshed credential would name the same account.

        Returning 401 here would send a well-behaved client into a refresh-and-retry loop it
        could never exit, which is exactly the confusion the two statuses exist to avoid.
        """
        with pytest.raises(ForbiddenError) as raised:
            ensure_can_author(make_user(UserRole.READER))

        assert raised.value.status_code == HTTPStatus.FORBIDDEN

    @pytest.mark.parametrize(("role", "expected"), _CAPABILITY_MATRIX, ids=_CAPABILITY_IDS)
    def test_agrees_with_the_predicate_on_every_role(self, role: UserRole, expected: bool) -> None:
        user = make_user(role)

        predicate_permits = can_author(user)
        try:
            ensure_can_author(user)
        except ForbiddenError:
            guard_permits = False
        else:
            guard_permits = True

        assert predicate_permits is guard_permits
        assert guard_permits is expected


# ---------------------------------------------------------------------------------------
# The two halves together
# ---------------------------------------------------------------------------------------


class TestTheTwoHalvesOfPostAuthority:
    """Capability and ownership are independent, and a post mutation needs both."""

    def test_a_reader_owning_the_resource_still_may_not_author(self) -> None:
        """Ownership without capability. The demoted account keeps its rows and loses the verb."""
        reader = make_user(UserRole.READER)

        assert can_modify(reader, reader.id) is True
        assert can_author(reader) is False

    def test_an_author_without_ownership_still_holds_the_capability(self) -> None:
        """Capability without ownership. Being allowed posts is not being allowed *this* post."""
        author = make_user(UserRole.AUTHOR)

        assert can_author(author) is True
        assert can_modify(author, _unrelated_owner_id(author)) is False

    def test_an_administrator_holds_both_halves_against_any_resource(self) -> None:
        administrator = make_user(UserRole.ADMIN)

        assert can_author(administrator) is True
        assert can_modify(administrator, _unrelated_owner_id(administrator)) is True

    def test_an_author_holds_both_halves_over_their_own_resource(self) -> None:
        """The ordinary case both guards are written for, asserted end to end."""
        author = make_user(UserRole.AUTHOR)

        # Both halves called for effect: either one refusing would raise out of this test.
        ensure_can_author(author)
        ensure_can_modify(author, author.id)
