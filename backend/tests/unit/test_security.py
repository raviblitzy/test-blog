"""Unit tests for ``app.core.security``: argon2id hashing, access tokens, refresh tokens.

Pure and **database-free**. The module under test is the bottom of the authentication stack -
its only ``app`` imports are ``app.core.config``, ``app.core.exceptions`` and
``app.core.concurrency`` - so nothing here opens a session, builds an engine, constructs a
mapped row or issues a request. Every test is a plain synchronous function, no test requests a
fixture from ``backend/tests/conftest.py``, and ``backend/tests/factories.py`` is not imported,
because every helper in it needs an ``AsyncSession``. The one thing this module does rely on
from its parent conftest is the *environment*: ``app.core.config`` builds and validates its
``settings`` singleton at import time and ``JWT_SECRET_KEY`` has no default, so the
pre-import bootstrap in ``conftest.py`` is what makes ``import app.core.security`` succeed at
all. That singleton is read here and never reloaded, re-imported or mutated.

No user rules govern this file
-----------------------------
``review_rules`` returns ``No user rules provided.`` - a complete response, not a truncated
window - so **no user-specified rule governs this file and no rule placed it in scope**. It is
in scope solely by the Agent Action Plan's file inventory (§0.4.4.5, "hashing and token
behaviour including expiry") and its execution plan (§0.7.1.11, "including expiry rejection").
Nothing below is invented to fill that gap, and the absence of rules is not read as licence to
test less rigorously: the substitute standard is the AAP's own §0.10.1 enterprise standards,
four of which this module discharges.

* **§0.10.1 #6, secure-by-default authentication.** This module is the primary proof of the
  first three clauses of that standard. It asserts the hash is *argon2id* rather than merely
  "some hash", asserts the per-hash salt, asserts the access token carries a bounded ``exp``
  and that an expired one is refused, and asserts the refresh token is opaque high-entropy
  material that is hashed before storage. It additionally proves the signing-key floor that
  ``app.core.security`` deliberately does **not** re-check - see
  :class:`TestSigningKeyFloor`.
* **§0.10.1 #4, explicit API contracts - one problem document for every error.** The practical
  consequence for this module is that :func:`~app.core.security.decode_access_token` must
  **translate** every failure into the :class:`~app.core.exceptions.UnauthorizedError` family.
  A raw ``jwt.ExpiredSignatureError`` or ``jwt.InvalidTokenError`` escaping to the caller would
  bypass the registered handler and produce a non-conforming 500 where a conforming 401 with a
  ``WWW-Authenticate: Bearer`` challenge is owed. That translation is the contract, and
  asserting it is the single most important thing this file does, so **every** rejection is
  asserted as ``pytest.raises(UnauthorizedError)`` and never as a PyJWT exception. ``jwt`` is
  imported here for exactly two mechanical purposes: to *forge* tokens the production code
  would never mint, and to read back the payload of one it did.
* **§0.10.1 #8, blocking quality gates.** Four rejection paths - expiry, malformed input, a
  foreign signing key, and a wrong or absent ``type`` claim - are cheap to reach here and
  expensive to reach over HTTP, so this module carries a large share of the
  ``--cov-fail-under=80`` gate. Every branch of ``app.core.security`` reachable without an
  event loop is exercised, including each claim-coercion refusal.
* **§0.10.1 #2, pinned, reproducible dependencies.** Nothing outside
  ``backend/requirements.txt`` and ``backend/requirements-dev.txt`` is imported. In
  particular ``freezegun`` and ``time-machine`` are **not** installed and must not be added:
  expiry is produced instead by the ``expires_delta`` parameter
  :func:`~app.core.security.create_access_token` already declares for the purpose, which
  exercises the production code path rather than the clock.

Two facts about the module under test that shape the assertions below
--------------------------------------------------------------------
1. :class:`~app.core.security.AccessTokenClaims` is a frozen, slotted dataclass carrying
   ``subject``, ``role``, ``issued_at`` and ``expires_at`` - **not** the raw claim names, and
   with no ``type`` attribute at all, because the type check is performed and then discarded.
   So assertions about the ``type`` claim are made against the *minted token's payload*, which
   is a public output of :func:`~app.core.security.create_access_token`, while assertions about
   issued-at and expiry are made against the decoded object.
2. Two hashes, two algorithms, on purpose: salted argon2id for passwords, a plain
   deterministic SHA-256 digest for refresh tokens.
   :class:`TestTheTwoHashingStrategies` states that asymmetry in one place so that nobody
   "fixes" the token digest into a salted one and silently breaks the ``UNIQUE`` index lookup
   the refresh flow depends on.

Cost
----
argon2id is deliberately expensive - roughly 38 ms per hash or per verification at the
configured ``time_cost=3``/``memory_cost=65536`` KiB - so the work is budgeted rather than
incidental. The module performs exactly **four** argon2id hashes for the whole run: two in the
module-scoped :func:`salted_hashes` fixture, so that the salt assertion and every verification
assertion share one pair; one inside :func:`~app.core.security.dummy_password_hash`, which
caches its own result; and one for the long password that proves no truncation happens. No hash
is computed inside a loop or a ``parametrize`` table, the near-miss password table is kept to
the four cases that guard distinct mistakes, and the one deliberately-invalid argon2 hash in
:data:`_UNREADABLE_HASHES` carries tiny cost parameters so that reaching its refusal does not
spend a full memory-hard verification.

Division of labour
------------------
``backend/tests/integration/test_auth_api.py`` proves the same lifecycle over HTTP - register,
log in, call a protected route, rotate a refresh token, revoke it on logout, and answer 401 for
a revoked or expired credential. Nothing here duplicates an HTTP-level assertion; this module's
job is the primitive in isolation, which is precisely what makes the expiry and
type-confusion branches cheap to reach.
"""

from __future__ import annotations

import dataclasses
import math
import re
from datetime import UTC, datetime, timedelta
from typing import Any, Final
from uuid import UUID, uuid4

import jwt
import pydantic
import pytest

from app.core.config import Settings, settings
from app.core.exceptions import InvalidTokenError, TokenExpiredError, UnauthorizedError
from app.core.security import (
    REFRESH_TOKEN_ENTROPY_BYTES,
    TOKEN_TYPE_ACCESS,
    AccessTokenClaims,
    access_token_expires_at,
    create_access_token,
    decode_access_token,
    dummy_password_hash,
    generate_refresh_token,
    hash_password,
    hash_refresh_token,
    refresh_token_expires_at,
    verify_and_update_password,
    verify_password,
    verify_refresh_token,
)
from app.models import UserRole

# ---------------------------------------------------------------------------------------
# Fixed material
#
# Every credential-shaped literal below is obviously fake and exists only inside this
# process: no value here is a real password, a deployment secret or a working key.
# ---------------------------------------------------------------------------------------

#: The one plaintext password this module hashes. Long and mixed-class so it could not be
#: mistaken for a real credential, and stable so the module-scoped hash can be shared.
_PASSWORD: Final[str] = "Correct-Horse-Battery-Staple-9"

#: The encoded-hash prefix argon2id produces. Asserting it is how a silent downgrade to
#: argon2i, argon2d, bcrypt or PBKDF2 fails rather than passing as "still a hash".
_ARGON2ID_PREFIX: Final[str] = "$argon2id$"

#: A signing key that is configured nowhere, used to forge a validly structured token with an
#: invalid signature. Deliberately far longer than 32 bytes: PyJWT 2.13.0 emits
#: ``InsecureKeyLengthWarning`` for a shorter HMAC key, citing RFC 7518 §3.2, and a test must
#: not manufacture the very warning the configuration gate exists to make unreachable.
_FOREIGN_SIGNING_KEY: Final[str] = "a-signing-key-this-project-never-configures-anywhere-at-all"

#: The HMAC algorithms this service will accept, in the order ``app.core.config`` declares
#: them. Used to pick one that is *not* configured, so the forged-algorithm test keeps working
#: if ``JWT_ALGORITHM`` is ever changed.
_HMAC_ALGORITHMS: Final[tuple[str, ...]] = ("HS256", "HS384", "HS512")

#: An algorithm the decoder's allowlist does not contain. Resolved from configuration rather
#: than hard-coded, because the allowlist is ``[settings.JWT_ALGORITHM]``.
_UNCONFIGURED_ALGORITHM: Final[str] = next(
    algorithm for algorithm in _HMAC_ALGORITHMS if algorithm != settings.JWT_ALGORITHM
)

#: Value of the ``alg`` header on an unsigned token. The classic algorithm-confusion attack:
#: rejected because the decoder always passes an explicit allowlist and never ``None``.
_UNSIGNED_ALGORITHM: Final[str] = "none"

#: Every role a token can be minted for, taken from the enum rather than restated, so a fourth
#: member could not be added without this module covering it.
_USER_ROLES: Final[tuple[UserRole, ...]] = tuple(UserRole)

#: Characters ``secrets.token_urlsafe`` can emit: base64url, unpadded.
_URL_SAFE_ALPHABET: Final[re.Pattern[str]] = re.compile(r"[A-Za-z0-9_-]+")

#: Characters a lowercase hexadecimal digest can contain.
_LOWERCASE_HEX: Final[re.Pattern[str]] = re.compile(r"[0-9a-f]+")

#: Width of the digest ``hash_refresh_token`` documents: a SHA-256 hash rendered as lowercase
#: hex. Fixed width is what lets it sit under a ``UNIQUE`` index on a ``TEXT`` column.
_DIGEST_WIDTH: Final[int] = 64

#: Length ``secrets.token_urlsafe(n)`` returns: base64url encodes three bytes as four
#: characters and the padding is stripped, so 32 bytes becomes 43 characters. Derived from the
#: exported constant rather than written as 43, so the two cannot disagree.
_EXPECTED_TOKEN_LENGTH: Final[int] = math.ceil(REFRESH_TOKEN_ENTROPY_BYTES * 4 / 3)

#: Entropy floor a refresh token must clear whatever the configured byte count.
_MINIMUM_TOKEN_LENGTH: Final[int] = 32

#: How many tokens the distinctness and digest-shape assertions draw. Large enough that a
#: constant or a truncated generator could not pass, small enough to stay instant.
_SAMPLE_SIZE: Final[int] = 20

#: Sentinel meaning "leave this claim out of the forged payload entirely", so an *absent*
#: claim and a *malformed* one can be expressed in the same table.
_ABSENT: Final[object] = object()

#: A timestamp comfortably in the future - 2100-01-01T00:00:00Z - carried as a numeric
#: *string*. PyJWT coerces ``exp`` with ``int()`` while leaving the claim as JSON decoded it,
#: so this survives its expiry check and then has to be refused by the claim coercion in
#: ``app.core.security``. A literal rather than a computed instant, so the value cannot drift
#: into the past between collection and execution.
_FUTURE_TIMESTAMP_STRING: Final[str] = "4102444800"

#: A finite float far outside the range :meth:`datetime.datetime.fromtimestamp` can represent.
#: Passes PyJWT's ``int()`` coercion and its "not yet expired" comparison, then has to be
#: refused when the claim is converted to an instant.
_UNREPRESENTABLE_TIMESTAMP: Final[float] = 1e30


# ---------------------------------------------------------------------------------------
# Tables
#
# Held as module constants rather than inline literals so each case is named once and read
# in one place, matching the shape of the sibling unit module.
# ---------------------------------------------------------------------------------------

#: Candidates that must all fail verification against a hash of :data:`_PASSWORD`. The
#: near-miss cases matter more than the obviously-wrong one: a comparison that folded case or
#: trimmed whitespace would accept one of them. Kept deliberately short - every entry costs a
#: full argon2id verification, and each additional near miss guards a variation of the same
#: mistake.
_WRONG_PASSWORDS: Final[tuple[str, ...]] = (
    "",
    f"wrong-{_PASSWORD}",
    _PASSWORD.swapcase(),
    f"{_PASSWORD} ",
)

#: Two passwords sharing their first 72 bytes and differing after it. bcrypt truncates its
#: input at 72 bytes, which would make these two interchangeable; argon2 has no such limit and
#: :func:`~app.core.security.hash_password` deliberately performs no truncation and no
#: pre-hashing, because silently truncating would make two different long passwords equivalent.
_LONG_PASSWORD: Final[str] = f"{'L' * 72}-and-then-one"
_LONG_PASSWORD_TWIN: Final[str] = f"{'L' * 72}-and-then-two"

#: Stored values no configured hasher can interpret. Every one must be reported as a failed
#: verification rather than raised: a corrupt row has to present as a failed login, not as a
#: 500 that tells an attacker they found a broken account.
_UNREADABLE_HASHES: Final[tuple[str, ...]] = (
    "",
    "   ",
    "not-a-hash",
    # Recognisably argon2 but structurally incomplete.
    _ARGON2ID_PREFIX,
    "$argon2id$v=19$m=65536,t=3,p=4$AAAA$BBBB",
    # A different argon2 variant, and a bcrypt hash left behind by another system. The argon2i
    # entry carries deliberately tiny cost parameters: it is refused on its structure, and
    # spelling the production parameters here would spend a full memory-hard verification to
    # reach the same answer.
    "$argon2i$v=19$m=8,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo",
    f"$2b$12${'a' * 53}",
)

#: Values that are not a compact JWS at all. The last two are the shapes a caller actually
#: sends by accident: a bare word from a mis-parsed header, and whitespace from an empty one.
_MALFORMED_TOKENS: Final[tuple[str, ...]] = (
    "",
    "not-a-jwt",
    "a.b.c",
    "....",
    # Plausible-looking opaque base64url material with no JWT structure whatsoever.
    "bm90LWEtdG9rZW4tanVzdC1zb21lLWJhc2U2NHVybC1ibG9i",
    "   ",
)

#: ``type`` claim values that are not :data:`~app.core.security.TOKEN_TYPE_ACCESS`. Each is
#: forged with the real key, the real algorithm and a valid unexpired ``exp``, so the claim is
#: provably the only reason for the refusal - ``"refresh"`` is the case that matters, because
#: without the check a long-lived refresh token would open every protected route.
_NON_ACCESS_TOKEN_TYPES: Final[tuple[object, ...]] = (
    "refresh",
    "",
    # Case-sensitive: the claim is compared exactly, not folded.
    "ACCESS",
    "id",
    # Not a string at all, and absent entirely.
    123,
    _ABSENT,
)

#: ``(claim, value)`` pairs that survive PyJWT's own validation and must then be refused by
#: the claim coercion in ``app.core.security``. Every entry is a real hazard verified against
#: the pinned PyJWT: a valid signature does not make a payload usable.
_NON_CONFORMING_CLAIMS: Final[tuple[tuple[str, object], ...]] = (
    # `sub` must be a string that parses as a UUID; anything else is a malformed token rather
    # than a server fault, so it must not escape as the ValueError UUID() would raise.
    ("sub", "not-a-uuid"),
    ("sub", 12345),
    ("sub", _ABSENT),
    # `role` must be a string. PyJWT passes private claims through exactly as JSON decoded
    # them, so a number or a list reaches the claim coercion intact.
    ("role", 123),
    ("role", ["ADMIN"]),
    ("role", _ABSENT),
    # `iat` must be a finite number. `True` is the trap: bool subclasses int, so an unguarded
    # conversion would read it as one second past the epoch instead of as malformed.
    ("iat", True),
    ("iat", _ABSENT),
    # `exp` must be present - PyJWT's expiry check only checks an expiry that is there, so a
    # token with no `exp` would otherwise be eternal - and must be a representable number.
    ("exp", _ABSENT),
    ("exp", _FUTURE_TIMESTAMP_STRING),
    ("exp", _UNREPRESENTABLE_TIMESTAMP),
)

#: Stored digests a presented refresh token must lose against, including a right-length
#: all-zero digest, a wrong-length one, and values a byte comparison must not raise on.
_UNUSABLE_DIGESTS: Final[tuple[str, ...]] = (
    "",
    "0" * _DIGEST_WIDTH,
    "0" * (_DIGEST_WIDTH - 1),
    "not-a-digest",
    # Non-ASCII: `secrets.compare_digest` refuses a str containing one, which is why the
    # implementation compares bytes. A corrupt row must lose rather than raise.
    "café-is-not-a-digest",
)


# ---------------------------------------------------------------------------------------
# Helpers
#
# Two forging helpers and one read-back helper. They exist so that a test states which claim
# it is attacking and nothing else, and so that "correctly signed, unexpired, and wrong in
# exactly one respect" is expressed once rather than rebuilt per case.
# ---------------------------------------------------------------------------------------


def _valid_claims(**overrides: Any) -> dict[str, Any]:
    """Build a payload that would decode successfully, then apply *overrides*.

    The baseline is deliberately valid in every respect - a UUID subject, a real role label, an
    issued-at of now, an expiry five minutes out and the access token type - so a test that
    overrides one entry has changed exactly one thing. An override whose value is
    :data:`_ABSENT` removes the claim instead of setting it, which is how "the claim is
    missing" and "the claim is malformed" share one table.

    Args:
        **overrides: Claim values to replace, or :data:`_ABSENT` to omit the claim.

    Returns:
        The claim mapping, ready to hand to :func:`_forge`.
    """
    issued_at = datetime.now(tz=UTC)
    claims: dict[str, Any] = {
        "sub": str(uuid4()),
        "role": UserRole.AUTHOR.value,
        "iat": issued_at,
        "exp": issued_at + timedelta(minutes=5),
        "type": TOKEN_TYPE_ACCESS,
    }
    claims.update(overrides)
    return {name: value for name, value in claims.items() if value is not _ABSENT}


def _forge(claims: dict[str, Any], *, key: str | None = None, algorithm: str | None = None) -> str:
    """Encode *claims* with PyJWT directly, bypassing :func:`create_access_token`.

    The only way to produce a payload the production code would never mint. Both the key and
    the algorithm default to the configured ones, so a forged token is signature-valid unless a
    test deliberately says otherwise and the rejection under test is unambiguous.

    Args:
        claims: The payload, normally from :func:`_valid_claims`.
        key: Signing key. Defaults to the configured secret.
        algorithm: Signing algorithm. Defaults to the configured one.

    Returns:
        The encoded compact JWS.
    """
    return jwt.encode(
        claims,
        settings.JWT_SECRET_KEY if key is None else key,
        algorithm=settings.JWT_ALGORITHM if algorithm is None else algorithm,
    )


def _payload_of(token: str) -> dict[str, Any]:
    """Return the verified payload of a token this project minted.

    Used only where the assertion is about the *wire payload* rather than about the decoded
    claims object - the exact claim set :func:`create_access_token` documents, and the ``type``
    claim :class:`AccessTokenClaims` deliberately does not carry. Verification is left on, with
    the configured key and algorithm, so reading the payload back also proves the token
    verifies; expiry is not checked here because one caller reads back a token minted with a
    negative lifetime.

    Args:
        token: A token produced by :func:`create_access_token`.

    Returns:
        The decoded claim mapping.
    """
    return jwt.decode(
        token,
        settings.JWT_SECRET_KEY,
        algorithms=[settings.JWT_ALGORITHM],
        options={"verify_exp": False},
    )


def _settings_kwargs(**overrides: Any) -> dict[str, Any]:
    """Field values for a **fresh** :class:`~app.core.config.Settings`, taken from the live one.

    Derived from ``settings.model_dump()`` rather than written out. Two reasons, both
    load-bearing: this module then invents no credential-shaped literal for a configuration it
    only wants to vary in one field, and a field added to ``Settings`` later cannot make these
    tests fail for the wrong reason. The dump carries exactly the declared field names - the
    derived predicates on ``Settings`` are plain properties, not computed fields - so it is
    accepted by a model configured ``extra="forbid"``.

    Args:
        **overrides: Field values to replace.

    Returns:
        Keyword arguments for a fresh instance. Because init keyword arguments outrank the
        environment in pydantic-settings' source order, and the caller additionally passes
        ``_env_file=None``, the resulting instance depends on nothing outside this call.
    """
    return {**settings.model_dump(), **overrides}


# ---------------------------------------------------------------------------------------
# Shared argon2id material
#
# The whole module's hashing budget, computed once. Module scope rather than function scope
# is the difference between three argon2id hashes per run and one per test.
# ---------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def salted_hashes() -> tuple[str, str]:
    """Two independent argon2id hashes of the same password.

    The pair is what proves the per-hash salt: the two values must differ, and both must still
    verify. Computed once for the module and shared, because at roughly 38 ms per hash a
    per-test pair would dominate the runtime of the entire unit suite for no additional
    coverage.

    Returns:
        Two encoded hashes of :data:`_PASSWORD`, produced by separate calls.
    """
    return hash_password(_PASSWORD), hash_password(_PASSWORD)


@pytest.fixture(scope="module")
def password_hash(salted_hashes: tuple[str, str]) -> str:
    """The single stored hash every verification assertion reuses.

    The first of :func:`salted_hashes`, so requesting it costs nothing beyond that fixture.

    Returns:
        One encoded argon2id hash of :data:`_PASSWORD`.
    """
    return salted_hashes[0]


# ---------------------------------------------------------------------------------------
# Passwords
# ---------------------------------------------------------------------------------------


class TestPasswordHashing:
    """argon2id, salted, one-way, and never raising on a corrupt stored value."""

    def test_the_hash_is_a_non_empty_string_that_is_not_the_password(
        self, password_hash: str
    ) -> None:
        assert isinstance(password_hash, str)
        assert password_hash != ""
        assert password_hash != _PASSWORD
        # Not merely different: the plaintext must not appear anywhere inside the encoded hash,
        # which a naive "salt + plaintext" scheme would leave in plain view.
        assert _PASSWORD not in password_hash

    def test_the_algorithm_is_argon2id(self, password_hash: str) -> None:
        """A silent downgrade to argon2i, bcrypt or PBKDF2 has to fail here.

        AAP §0.10.1 #6 names argon2id specifically, so this asserts the algorithm rather than
        the mere presence of a hash. The variant is recorded in the encoded prefix, which makes
        it a behavioural assertion on a stored value rather than a peek at the hasher.
        """
        assert password_hash.startswith(_ARGON2ID_PREFIX), password_hash[:24]

    def test_the_correct_password_verifies(self, password_hash: str) -> None:
        assert verify_password(_PASSWORD, password_hash) is True

    @pytest.mark.parametrize("candidate", _WRONG_PASSWORDS)
    def test_a_wrong_password_is_rejected(self, candidate: str, password_hash: str) -> None:
        assert verify_password(candidate, password_hash) is False

    @pytest.mark.parametrize("stored", _UNREADABLE_HASHES)
    def test_an_unreadable_stored_hash_fails_verification_without_raising(
        self, stored: str
    ) -> None:
        """A corrupt row must present as a failed login rather than as a 500."""
        assert verify_password(_PASSWORD, stored) is False

    def test_two_hashes_of_one_password_differ_and_both_verify(
        self, salted_hashes: tuple[str, str]
    ) -> None:
        """The proof that a per-hash salt is in play, stated in exactly one test.

        Without it a global salt or a plain digest would satisfy every other assertion in this
        class. The consequence is operational as well as cryptographic: two accounts that
        happen to share a password do not share a stored hash, so cracking one does not
        identify the other.
        """
        first, second = salted_hashes
        assert first != second
        assert verify_password(_PASSWORD, first) is True
        assert verify_password(_PASSWORD, second) is True

    def test_a_long_password_is_not_truncated(self) -> None:
        """The whole string is consumed, so two long passwords are never interchangeable.

        bcrypt truncates at 72 bytes; argon2 does not, and this module performs no pre-hashing.
        The two candidates share their first 72 bytes, so a truncating implementation would
        accept the wrong one - which would silently reduce the strength of every long password
        to its first 72 characters.
        """
        stored = hash_password(_LONG_PASSWORD)
        assert verify_password(_LONG_PASSWORD, stored) is True
        assert verify_password(_LONG_PASSWORD_TWIN, stored) is False

    def test_verify_and_update_reports_no_replacement_for_a_current_hash(
        self, password_hash: str
    ) -> None:
        """A hash produced with the configured cost parameters needs no rewrite."""
        matched, replacement = verify_and_update_password(_PASSWORD, password_hash)
        assert matched is True
        assert replacement is None

    def test_verify_and_update_reports_no_match_for_an_unreadable_hash(self) -> None:
        assert verify_and_update_password(_PASSWORD, "not-a-hash") == (False, None)

    def test_the_dummy_hash_is_argon2id_stable_and_unmatchable(self) -> None:
        """The material that closes the user-enumeration timing oracle.

        Three properties, all of them load-bearing for the unknown-account login path in
        ``app.services.auth_service``: it is a real argon2id hash, so verifying against it costs
        the same as verifying against a real one; it is stable for the life of the process, so
        two consecutive unknown-email attempts have identical timing profiles; and no
        caller-supplied password can match it.
        """
        first = dummy_password_hash()
        assert first.startswith(_ARGON2ID_PREFIX)
        assert dummy_password_hash() == first
        assert verify_password(_PASSWORD, first) is False


# ---------------------------------------------------------------------------------------
# Access tokens: issuance and round trip
# ---------------------------------------------------------------------------------------


class TestAccessTokenIssuance:
    """What :func:`create_access_token` puts on the wire, and what comes back out."""

    def test_the_token_is_a_compact_jws(self) -> None:
        token = create_access_token(subject=uuid4(), role=UserRole.AUTHOR)
        assert isinstance(token, str)
        # Header, payload, signature: three base64url segments, two separators, exactly.
        assert token.count(".") == 2

    def test_the_payload_carries_exactly_the_five_documented_claims(self) -> None:
        """Nothing more is minted, because every extra claim is bytes on every request.

        ``jti``, ``nbf``, ``aud`` and ``iss`` are deliberately absent - no consumer in this
        single-audience service reads them - so an accidentally added claim fails here.
        """
        token = create_access_token(subject=uuid4(), role=UserRole.AUTHOR)
        assert set(_payload_of(token)) == {"sub", "role", "iat", "exp", "type"}

    def test_the_type_claim_marks_the_token_as_an_access_token(self) -> None:
        payload = _payload_of(create_access_token(subject=uuid4(), role=UserRole.AUTHOR))
        assert payload["type"] == TOKEN_TYPE_ACCESS
        # Pinned to the literal wire value as well as to the constant: the claim is part of the
        # token's published shape, so renaming the constant must not quietly change it.
        assert payload["type"] == "access"

    @pytest.mark.parametrize("role", _USER_ROLES)
    def test_the_round_trip_preserves_the_subject_and_the_role(self, role: UserRole) -> None:
        """Every role a principal can hold survives issuance and decoding intact."""
        subject = uuid4()
        claims = decode_access_token(create_access_token(subject=subject, role=role))
        assert claims.subject == subject
        assert claims.role == role
        assert claims.role == role.value

    def test_a_string_subject_is_accepted_and_parsed_back_to_a_uuid(self) -> None:
        """The declared ``UUID | str`` subject, exercised on the string arm.

        The claim is carried as text because the JWT specification requires a string subject, so
        the identifier has to survive a round trip through that representation.
        """
        subject = uuid4()
        token = create_access_token(subject=str(subject), role=UserRole.READER)
        claims = decode_access_token(token)
        assert isinstance(claims.subject, UUID)
        assert claims.subject == subject

    def test_the_decoded_claims_are_a_frozen_dataclass_of_python_values(self) -> None:
        """A principal derived from a signed credential must not be mutable downstream."""
        claims = decode_access_token(create_access_token(subject=uuid4(), role=UserRole.ADMIN))
        assert isinstance(claims, AccessTokenClaims)
        assert isinstance(claims.subject, UUID)
        assert isinstance(claims.role, str)
        assert isinstance(claims.issued_at, datetime)
        assert isinstance(claims.expires_at, datetime)
        with pytest.raises(dataclasses.FrozenInstanceError):
            claims.role = UserRole.READER.value  # type: ignore[misc]

    def test_both_instants_are_aware_utc_and_bound_the_token(self) -> None:
        """Naive instants would compare wrongly and shift every expiry by the host's offset."""
        claims = decode_access_token(create_access_token(subject=uuid4(), role=UserRole.AUTHOR))
        assert claims.issued_at.tzinfo is not None
        assert claims.expires_at.tzinfo is not None
        assert claims.issued_at.utcoffset() == timedelta(0)
        assert claims.expires_at.utcoffset() == timedelta(0)
        assert claims.expires_at > claims.issued_at

    def test_the_lifetime_is_the_configured_one(self) -> None:
        """A short lifetime is a measurable property, so it is measured.

        Exact rather than approximate: PyJWT normalises both instants to whole POSIX seconds
        by truncation, and both are derived from the same issued-at, so the difference is the
        configured window precisely.
        """
        claims = decode_access_token(create_access_token(subject=uuid4(), role=UserRole.AUTHOR))
        configured = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
        assert claims.expires_at - claims.issued_at == configured

    def test_an_explicit_lifetime_overrides_the_configured_one(self) -> None:
        token = create_access_token(
            subject=uuid4(), role=UserRole.AUTHOR, expires_delta=timedelta(minutes=1)
        )
        claims = decode_access_token(token)
        assert claims.expires_at - claims.issued_at == timedelta(minutes=1)


class TestConfiguredExpiryHelpers:
    """The two instants a caller reports without decoding its own token."""

    def test_access_token_expires_at_reports_the_configured_window(self) -> None:
        configured = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
        before = datetime.now(tz=UTC)
        reported = access_token_expires_at()
        after = datetime.now(tz=UTC)
        assert reported.tzinfo is not None
        # Sandwiched between two real clock reads, so the bound is exact rather than a
        # tolerance that could drift on a slow machine.
        assert before + configured <= reported <= after + configured

    def test_refresh_token_expires_at_reports_the_configured_window(self) -> None:
        configured = timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
        before = datetime.now(tz=UTC)
        reported = refresh_token_expires_at()
        after = datetime.now(tz=UTC)
        # Aware, because the value is written to a `timestamptz` column and a naive one would
        # let the database apply its own session time zone to every session's lifetime.
        assert reported.tzinfo is not None
        assert before + configured <= reported <= after + configured


# ---------------------------------------------------------------------------------------
# Access tokens: the four rejection paths
#
# Every assertion below is `pytest.raises(UnauthorizedError)`, never a PyJWT exception, and
# that is the contract rather than a stylistic choice: a `jwt.ExpiredSignatureError` reaching
# the caller would bypass the single registered handler and answer 500 where a 401 with a
# `WWW-Authenticate: Bearer` challenge is owed (AAP §0.10.1 #4).
# ---------------------------------------------------------------------------------------


class TestExpiredAccessTokens:
    """Expiry rejection - the assertion AAP §0.4.4.5 and §0.7.1.11 name specifically."""

    def test_an_expired_token_is_refused_as_a_domain_unauthorized_error(self) -> None:
        """An already-elapsed token must not decode, and must not leak a PyJWT exception.

        The expired token is produced by handing :func:`create_access_token` a **negative**
        ``expires_delta``. That parameter exists for exactly this purpose - its own
        documentation says a negative value is accepted deliberately because issuing an
        already-expired token is how the suite proves expiry is rejected - so this exercises
        the production issuance path rather than a forged payload, and needs no clock at all.

        No clock-freezing dependency is used, and none may be introduced: ``freezegun`` and
        ``time-machine`` are absent from ``backend/requirements-dev.txt`` on purpose (AAP
        §0.10.1 #2), and neither is needed while the lifetime is a parameter.
        """
        token = create_access_token(
            subject=uuid4(), role=UserRole.AUTHOR, expires_delta=timedelta(minutes=-5)
        )
        with pytest.raises(UnauthorizedError) as rejection:
            decode_access_token(token)

        # Narrower than the family, and worth asserting: `ExpiredSignatureError` is a subclass
        # of PyJWT's own invalid-token error, so a decoder that caught them in the wrong order
        # would report every expiry as a generic invalid token and lose the one distinction a
        # server-side log needs - a lapsed session versus a forged credential.
        assert isinstance(rejection.value, TokenExpiredError)
        # The wire contract: a conforming 401 carrying the challenge, not a 500.
        assert rejection.value.status_code == 401
        assert rejection.value.headers == {"WWW-Authenticate": "Bearer"}

    def test_the_expired_token_was_otherwise_well_formed(self) -> None:
        """Control: expiry must be the *only* thing wrong with the token above.

        Read back with expiry checking switched off, the payload is a complete, correctly
        signed access token whose ``exp`` simply lies in the past. Without this, the test above
        could be passing because the token was malformed.
        """
        token = create_access_token(
            subject=uuid4(), role=UserRole.AUTHOR, expires_delta=timedelta(minutes=-5)
        )
        payload = _payload_of(token)
        assert payload["type"] == TOKEN_TYPE_ACCESS
        assert payload["role"] == UserRole.AUTHOR.value
        assert payload["exp"] < payload["iat"]


class TestMalformedAccessTokens:
    """Input that is not a usable compact JWS at all."""

    @pytest.mark.parametrize("token", _MALFORMED_TOKENS)
    def test_a_malformed_token_is_refused(self, token: str) -> None:
        with pytest.raises(UnauthorizedError):
            decode_access_token(token)

    def test_a_token_with_a_corrupted_payload_segment_is_refused(self) -> None:
        """Tampering with the claims invalidates the signature over them."""
        header, payload, signature = create_access_token(
            subject=uuid4(), role=UserRole.AUTHOR
        ).split(".")
        with pytest.raises(UnauthorizedError):
            decode_access_token(f"{header}.{payload[:-4]}QUJD.{signature}")

    def test_a_token_stripped_of_its_signature_segment_is_refused(self) -> None:
        header, payload, _ = create_access_token(subject=uuid4(), role=UserRole.AUTHOR).split(".")
        with pytest.raises(UnauthorizedError):
            decode_access_token(f"{header}.{payload}")

    def test_a_token_with_an_empty_signature_segment_is_refused(self) -> None:
        header, payload, _ = create_access_token(subject=uuid4(), role=UserRole.AUTHOR).split(".")
        with pytest.raises(UnauthorizedError):
            decode_access_token(f"{header}.{payload}.")


class TestForgedAccessTokens:
    """A structurally perfect token that this service did not sign."""

    def test_a_token_signed_with_another_key_is_refused(self) -> None:
        """Bearer authentication is worth nothing if an attacker can bring their own key."""
        forged = _forge(_valid_claims(), key=_FOREIGN_SIGNING_KEY)
        with pytest.raises(UnauthorizedError):
            decode_access_token(forged)

    def test_a_token_signed_with_an_unconfigured_algorithm_is_refused(self) -> None:
        """The decoder's allowlist is the configured algorithm alone, not the token's header.

        Signed with the *real* secret, so only the algorithm differs: without an explicit
        allowlist, a token could nominate the algorithm its own signature is verified under.
        """
        forged = _forge(_valid_claims(), algorithm=_UNCONFIGURED_ALGORITHM)
        with pytest.raises(UnauthorizedError):
            decode_access_token(forged)

    def test_an_unsigned_token_is_refused(self) -> None:
        """``alg: none`` is the classic algorithm-confusion attack, and it must not work."""
        unsigned = jwt.encode(_valid_claims(), None, algorithm=_UNSIGNED_ALGORITHM)
        with pytest.raises(UnauthorizedError):
            decode_access_token(unsigned)


class TestAccessTokenTypeConfusion:
    """The ``type`` claim, which is what stops a refresh token opening a protected route."""

    @pytest.mark.parametrize("claimed_type", _NON_ACCESS_TOKEN_TYPES)
    def test_a_token_whose_type_is_not_access_is_refused(self, claimed_type: object) -> None:
        """Correctly signed and unexpired, so the ``type`` claim is the only fault.

        That is the whole point of forging these rather than minting them: if the signature or
        the expiry were wrong too, the test would pass with the type check deleted. The short
        access-token lifetime would then be decorative, because the much longer-lived refresh
        token would be accepted everywhere a bearer credential is.
        """
        forged = _forge(_valid_claims(type=claimed_type))
        with pytest.raises(UnauthorizedError):
            decode_access_token(forged)

    def test_the_same_forged_token_decodes_when_its_type_is_access(self) -> None:
        """Control for the refusals above: the baseline payload is otherwise perfect."""
        claims = decode_access_token(_forge(_valid_claims()))
        assert claims.role == UserRole.AUTHOR
        assert isinstance(claims.subject, UUID)


class TestNonConformingClaims:
    """Claims that survive PyJWT's own validation and still cannot produce a principal."""

    @pytest.mark.parametrize(("claim", "value"), _NON_CONFORMING_CLAIMS)
    def test_a_non_conforming_claim_is_refused(self, claim: str, value: object) -> None:
        """A valid signature does not make a payload usable.

        PyJWT validates the registered claims it knows about and passes private ones through
        exactly as JSON decoded them, so every case in the table reaches
        :func:`~app.core.security.decode_access_token` with an intact signature. Each must leave
        as a 401 rather than as the ``ValueError``, ``TypeError`` or ``OverflowError`` an
        unguarded conversion would raise - which would surface as a 500.
        """
        forged = _forge(_valid_claims(**{claim: value}))
        with pytest.raises(UnauthorizedError):
            decode_access_token(forged)


class TestEveryRefusalIsOneProblemDocument:
    """One machine-readable branch for every rejection - AAP §0.10.1 #4, at the primitive.

    The four rejection paths are asserted individually above. What this class asserts is that
    they are the *same* answer on the wire: one status, one ``type``, one ``title`` and one
    challenge, so a client has a single branch to implement and an attacker learns nothing about
    which check refused their token.
    """

    @staticmethod
    def _refusal(token: str) -> UnauthorizedError:
        """Decode *token*, require that it is refused, and hand back the domain error raised."""
        with pytest.raises(UnauthorizedError) as rejection:
            decode_access_token(token)
        return rejection.value

    def test_every_rejection_renders_the_same_unauthorized_document(self) -> None:
        """Expiry, malformed input, a foreign key and a wrong type are one branch to a client."""
        refusals = (
            self._refusal(
                create_access_token(
                    subject=uuid4(), role=UserRole.AUTHOR, expires_delta=timedelta(minutes=-5)
                )
            ),
            self._refusal("not-a-jwt"),
            self._refusal(_forge(_valid_claims(), key=_FOREIGN_SIGNING_KEY)),
            self._refusal(_forge(_valid_claims(type="refresh"))),
        )

        assert {refusal.status_code for refusal in refusals} == {401}
        assert len({refusal.error_type for refusal in refusals}) == 1
        assert len({refusal.title for refusal in refusals}) == 1
        for refusal in refusals:
            # The challenge is what makes the response well formed rather than a bare refusal.
            assert refusal.headers == {"WWW-Authenticate": "Bearer"}

    def test_no_rejection_reason_leaks_through_the_detail(self) -> None:
        """A truncated token, a forged signature and a replayed refresh token read identically.

        Naming the failed check would tell an attacker which one to fix next, so every non-expiry
        refusal is raised bare and carries the class's own default message.
        """
        malformed = self._refusal("not-a-jwt")
        forged = self._refusal(_forge(_valid_claims(), key=_FOREIGN_SIGNING_KEY))
        mistyped = self._refusal(_forge(_valid_claims(type="refresh")))

        assert isinstance(malformed, InvalidTokenError)
        assert isinstance(forged, InvalidTokenError)
        assert isinstance(mistyped, InvalidTokenError)
        assert malformed.detail == forged.detail
        assert forged.detail == mistyped.detail
        assert InvalidTokenError.detail == malformed.detail


# ---------------------------------------------------------------------------------------
# Refresh tokens
# ---------------------------------------------------------------------------------------


class TestRefreshTokenGeneration:
    """Opaque, unguessable, URL-safe - and deliberately not a JWT."""

    def test_every_generated_token_is_distinct(self) -> None:
        tokens = [generate_refresh_token() for _ in range(_SAMPLE_SIZE)]
        assert len(set(tokens)) == _SAMPLE_SIZE

    def test_the_token_carries_the_configured_entropy(self) -> None:
        """256 bits of CSPRNG output is what makes hashing it with a fast digest safe."""
        token = generate_refresh_token()
        assert len(token) == _EXPECTED_TOKEN_LENGTH
        assert len(token) >= _MINIMUM_TOKEN_LENGTH

    def test_the_token_is_url_safe(self) -> None:
        """Safe in a JSON body and in an ``Authorization`` header without escaping."""
        token = generate_refresh_token()
        assert _URL_SAFE_ALPHABET.fullmatch(token) is not None, token

    def test_the_token_is_opaque_rather_than_a_jwt(self) -> None:
        """A JWT here would leak its claims to anyone holding it and still not be revocable.

        A refresh token has to be withdrawable - logout must invalidate it at once, and rotation
        must detect a replay - which needs server-side state, so it is looked up as a row rather
        than trusted as a signed assertion. Claims inside it would add nothing and cost
        something: a payload is only base64.
        """
        token = generate_refresh_token()
        # No compact-JWS structure at all: no header, no payload, no signature, no separators.
        assert token.count(".") == 0
        # And the property that actually matters: it can never open a protected route.
        with pytest.raises(UnauthorizedError):
            decode_access_token(token)


class TestRefreshTokenDigest:
    """The stored form: deterministic, fixed width, and not the token."""

    def test_the_digest_is_deterministic(self) -> None:
        """Required, not incidental - do not "fix" this into a salted hash.

        ``refresh_tokens.token_hash`` carries a ``UNIQUE`` index, and rotation, reuse detection
        and revocation on logout all locate the presented token by this digest in a single index
        probe. A salted argon2 hash is unqueryable by construction: the same token would hash
        differently every time, so matching one would mean scanning every stored row and running
        a memory-hard verification against each, on the hot path of every refresh.
        """
        token = generate_refresh_token()
        assert hash_refresh_token(token) == hash_refresh_token(token)

    def test_the_digest_is_not_the_token(self) -> None:
        """Only the digest reaches the database, so a disclosure must yield no usable session."""
        token = generate_refresh_token()
        digest = hash_refresh_token(token)
        assert digest != token
        assert token not in digest

    def test_distinct_tokens_produce_distinct_digests(self) -> None:
        first = generate_refresh_token()
        second = generate_refresh_token()
        assert first != second
        assert hash_refresh_token(first) != hash_refresh_token(second)

    def test_every_digest_has_the_same_fixed_lowercase_hex_shape(self) -> None:
        """Fixed width and a known alphabet are what let the value sit under a unique index."""
        digests = [hash_refresh_token(generate_refresh_token()) for _ in range(_SAMPLE_SIZE)]
        assert {len(digest) for digest in digests} == {_DIGEST_WIDTH}
        for digest in digests:
            assert isinstance(digest, str)
            assert _LOWERCASE_HEX.fullmatch(digest) is not None, digest


class TestRefreshTokenVerification:
    """Comparing a presented token against a digest already in hand."""

    def test_a_presented_token_verifies_against_its_own_digest(self) -> None:
        token = generate_refresh_token()
        assert verify_refresh_token(token, hash_refresh_token(token)) is True

    def test_a_different_token_loses_against_a_stored_digest(self) -> None:
        stored = hash_refresh_token(generate_refresh_token())
        assert verify_refresh_token(generate_refresh_token(), stored) is False

    @pytest.mark.parametrize("stored", _UNUSABLE_DIGESTS)
    def test_a_token_loses_against_an_unusable_stored_digest_without_raising(
        self, stored: str
    ) -> None:
        """A corrupt row must lose the comparison rather than raise it."""
        assert verify_refresh_token(generate_refresh_token(), stored) is False

    def test_the_comparison_is_case_sensitive(self) -> None:
        """The digest contract is *lowercase* hex, so an upper-cased copy is a different value."""
        token = generate_refresh_token()
        assert verify_refresh_token(token, hash_refresh_token(token).upper()) is False


class TestTheTwoHashingStrategies:
    """The deliberate asymmetry between the two stored secrets, stated in one place."""

    def test_a_password_hash_is_salted_while_a_token_digest_is_deterministic(
        self, salted_hashes: tuple[str, str]
    ) -> None:
        """Both choices are correct, and neither is the other's mistake.

        A **password** is low-entropy, human-chosen and dictionary-attackable, so it gets a
        fresh salt and a work factor: the same input must never yield the same stored value. A
        **refresh token** is 256 bits of CSPRNG output, so there is no dictionary to try and
        nothing a salt would protect against - but it must be *findable* by digest, so the same
        input must always yield the same stored value.

        Recorded as an assertion rather than only as a comment so that harmonising the two -
        in either direction - fails a test instead of passing review.
        """
        first, second = salted_hashes
        assert first != second

        token = generate_refresh_token()
        assert hash_refresh_token(token) == hash_refresh_token(token)


# ---------------------------------------------------------------------------------------
# The configuration guarantee this module depends on
#
# `app.core.security` deliberately does NOT re-validate the signing key: its own
# documentation records that by the time it runs there is no weak-key configuration left to
# compensate for, because `app.core.config` refused to start the process. A unit test of the
# primitives therefore has to prove the delegated guarantee actually exists - otherwise the
# one thing holding up the HMAC scheme is unasserted.
#
# Every instance below is a FRESH `Settings` object built with explicit keyword arguments and
# `_env_file=None`. The module-level `settings` singleton is never reloaded, re-imported or
# mutated, and the first test asserts as much.
# ---------------------------------------------------------------------------------------


class TestSigningKeyFloor:
    """``JWT_SECRET_KEY`` is held to the digest size of the configured algorithm, at startup."""

    def test_a_conforming_configuration_is_accepted_and_the_singleton_is_untouched(self) -> None:
        """Positive control, and the proof that these tests are hermetic.

        Constructing a second instance from the live one's own values must succeed, and must
        leave the shared singleton exactly as it was - which is what makes it safe to assert the
        refusals below in the same session as every other test in this module.
        """
        original_key = settings.JWT_SECRET_KEY
        original_algorithm = settings.JWT_ALGORITHM

        fresh = Settings(_env_file=None, **_settings_kwargs())

        # Operand order is the linter's, not a preference: an upper-cased attribute reads as a
        # constant to `SIM300`, so the captured value goes on the left.
        assert original_key == fresh.JWT_SECRET_KEY
        assert original_algorithm == fresh.JWT_ALGORITHM
        assert original_key == settings.JWT_SECRET_KEY
        assert original_algorithm == settings.JWT_ALGORITHM

    def test_a_key_below_the_absolute_floor_is_refused(self) -> None:
        """Under 32 bytes no HMAC algorithm this service offers is adequate (RFC 7518 §3.2)."""
        with pytest.raises(pydantic.ValidationError):
            Settings(_env_file=None, **_settings_kwargs(JWT_SECRET_KEY="too-short-to-sign-with"))

    def test_a_key_too_short_for_the_chosen_algorithm_is_refused(self) -> None:
        """The floor is per algorithm, so a 32-byte key is adequate for HS256 and not for HS512.

        A single fixed minimum would accept exactly the pairing PyJWT treats as insecure, and
        the service would then sign tokens while warning about every one of them.
        """
        with pytest.raises(pydantic.ValidationError):
            Settings(
                _env_file=None,
                **_settings_kwargs(JWT_SECRET_KEY="k" * 32, JWT_ALGORITHM="HS512"),
            )
