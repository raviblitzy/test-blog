"""Integration tests for the five credential routes under ``/api/v1/auth``.

This module is the HTTP-boundary proof of Agent Action Plan requirement **R1** - "Users can
sign up, log in" and "JWT authentication" - and it is the foundation the rest of the
integration suite stands on: every other module's authenticated call rests on the token
machinery asserted here, so a regression in this file is a regression everywhere.

Three named validation criteria from AAP section 0.9.4.4 are discharged below, in full:

* **"Registration and login"** - register, then log in, then call a protected route with the
  returned bearer token successfully. Written as one explicit test,
  :meth:`TestSignIn.test_register_then_sign_in_then_read_the_protected_principal_route`, so the
  criterion has a single unambiguous owner rather than being implied by a scattering of
  smaller assertions.
* **"Token lifecycle"** - refresh rotates the refresh token, logout revokes it, and a revoked
  or expired token yields ``401``. :class:`TestRefreshRotation` and :class:`TestSignOut` own
  this between them.
* The ``401`` leg of **"Authorisation negatives"** - an absent, malformed, expired, revoked or
  simply wrong credential is refused. :class:`TestBearerCredentialRejection` owns it.

No user rules govern this file
------------------------------
``review_rules`` returns ``No user rules provided.`` - a complete response, not a truncated
window - so **no user-specified rule governs this file and no rule placed it in scope**. It is
in scope solely by the AAP's file inventory (section 0.4.4.5) and execution plan
(section 0.7.1.11). Nothing is invented to fill that gap, and the absence of rules is not read
as licence to lower the bar: the substitute standard is the AAP's own section 0.10.1
enterprise standards, three of which this file discharges directly.

* **Standard 6, secure-by-default authentication.** The standard demands argon2id hashing,
  short-lived access tokens, *rotating* refresh tokens stored only as hashes, a validated
  signing secret, server-side role checks and rate-limited credential routes. This file is
  where those properties become observable from outside the process. It proves *rotation*
  (the presented token stops working and a different one comes back), *revocation* (signing
  out kills the token, and a replay kills the whole family), *rejection* (absent, malformed,
  expired, revoked and type-confused credentials all answer ``401``) and the *confidentiality
  boundary* (no response body anywhere in the module carries a password or a password hash).
* **Standard 3, server-owned identity and database-enforced integrity.** Registering an email
  address or a username that differs from an existing one only in case is refused, and the
  refusal comes from the ``CITEXT UNIQUE`` index rather than from a Python ``.lower()``. The
  status is asserted *and* the effect is: the row count is read back through ``db_session``
  using the case-variant spelling, so a passing test proves both that the request was refused
  and that no second row survived it.
* **Standard 8, blocking quality gates.** ``pytest backend/tests --cov=backend/app
  --cov-fail-under=80`` and the CI backend job are blocking, so there is no ``skip``, no
  ``xfail``, no placeholder and nothing order-dependent anywhere below. Every test builds the
  state it needs and ``backend/tests/conftest.py`` rolls it back afterwards.

The one trap this module exists to keep documented
--------------------------------------------------
``POST /api/v1/auth/login`` consumes an OAuth 2 password-grant **form**, which is what makes
the **Authorize** control in the generated documentation work and why ``python-multipart`` is
a pinned dependency. It must be sent as ``data=`` and never ``json=``; a JSON body answers
``422``, which reads like a broken route rather than a broken caller.
:meth:`TestSignIn.test_sign_in_requires_form_encoding_and_refuses_a_json_body` asserts that
``422`` deliberately, so the encoding requirement is pinned by a test instead of by a comment.

The asymmetry is intentional and is also asserted: ``POST /auth/refresh`` and ``POST
/auth/logout`` *do* take JSON bodies (:class:`~app.schemas.auth.RefreshRequest`), and the
grant's form field is named ``username`` while it carries this API's **email address** -
``app.api.v1.routers.auth.login`` lifts the two fields out and builds
:class:`~app.schemas.auth.LoginRequest` from them, answering ``401`` rather than ``422`` when
the value could not be an address at all.

What is asserted, and what is deliberately not
----------------------------------------------
Every assertion is made on a status code, a response header or a response body. Nothing here
calls :class:`~app.services.auth_service.AuthService`, a repository or a private attribute to
establish a behaviour: the API is driven through the ``client`` fixture, which is what keeps a
failure unambiguous about which layer produced it. ``db_session`` is read in exactly one
place - to count rows after a refused registration - and that is verification of an *effect*,
not a substitute for driving the route.

Three further exclusions are deliberate:

* The refresh token is **not** decoded. It is opaque ``secrets.token_urlsafe`` entropy, not a
  JWT, and it is persisted only as a deterministic SHA-256 digest, so there is nothing inside
  it to read and nothing reversible in the ``refresh_tokens.token_hash`` column.
* The rate limiter's *enforcement* is not tested. ``app.core.rate_limit`` builds its limiter
  with ``enabled=settings.ENVIRONMENT != "test"``, precisely so that a suite which registers,
  signs in, rotates and signs out repeatedly cannot trip a five-per-minute limit and turn a
  blocking gate flaky. :class:`TestRateLimitingIsDisabledUnderTest` asserts the *exemption* -
  that a burst produces no ``429`` - which is the tripwire that fails loudly if anyone later
  removes it.
* Error *prose* is never asserted where the wording is a security property.
  ``AuthService.register`` refuses a duplicate without saying which identifier clashed, and
  ``authenticate`` answers a wrong password and an unknown address identically. The tests
  assert the machine-readable ``type``, ``title`` and ``status``, assert that the submitted
  identifier is absent from the body, and compare the two credential failures for equality -
  never that ``detail`` reads a particular way.

Password hashing and token round-tripping are covered at unit level by
``backend/tests/unit/test_security.py``; nothing here repeats those assertions. What this file
adds is the HTTP consequence of the same primitives.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import uuid
from collections.abc import AsyncIterator, Callable, Iterator
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from typing import Any, Final

import pytest
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy import delete, event, func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.core.config import settings
from app.core.exceptions import ForbiddenError, UnauthorizedError
from app.core.rate_limit import limiter
from app.core.security import (
    create_access_token,
    decode_access_token,
    hash_refresh_token,
    refresh_token_expires_at,
)
from app.models import RefreshToken, User, UserRole
from app.repositories import RefreshTokenRepository, UserRepository
from app.schemas.admin import AdminUserUpdate
from app.schemas.auth import (
    DISPLAY_NAME_MAX_LENGTH,
    DISPLAY_NAME_MIN_LENGTH,
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH,
    REFRESH_TOKEN_MAX_LENGTH,
    USERNAME_MAX_LENGTH,
    USERNAME_MIN_LENGTH,
    LoginRequest,
)
from app.services.admin_service import AdminService
from app.services.auth_service import AuthService
from tests import factories
from tests.factories import DEFAULT_PASSWORD, create_refresh_token, create_user

# Every test in this module drives the application in process against PostgreSQL, which is
# exactly what `backend/pyproject.toml` registers the `integration` marker for. Applied at
# module scope rather than per test so `-m integration` selects the file as a unit, and it does
# not compete with the asyncio marker: `asyncio_mode = "auto"` supplies that one, and
# `conftest.pytest_collection_modifyitems` is a no-op whenever it is already present.
pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------------------
# Addresses
#
# Written out in full rather than assembled per call, because a mistyped path answers 404 and
# a 404 is indistinguishable from a route that was never mounted. `app.api.v1.router` exports
# API_V1_PREFIX for the application's own use; it is restated here as a literal on purpose, so
# that a change to the prefix fails these tests loudly instead of being followed silently -
# the version segment is part of the published contract this module is asserting, not an
# implementation detail it should track automatically.
# ---------------------------------------------------------------------------------------

_API_PREFIX: Final[str] = "/api/v1"
_REGISTER_URL: Final[str] = f"{_API_PREFIX}/auth/register"
_LOGIN_URL: Final[str] = f"{_API_PREFIX}/auth/login"
_REFRESH_URL: Final[str] = f"{_API_PREFIX}/auth/refresh"
_LOGOUT_URL: Final[str] = f"{_API_PREFIX}/auth/logout"
_ME_URL: Final[str] = f"{_API_PREFIX}/auth/me"

# An administrator-only route, used once - to prove that an account created through
# registration holds no administrative authority. `app.api.v1.router` applies `require_admin`
# at the mount, so any route beneath /admin would serve; /admin/stats is chosen because it
# takes no path parameter and no body, so a 403 cannot be confused with a validation failure.
_ADMIN_STATS_URL: Final[str] = f"{_API_PREFIX}/admin/stats"


# ---------------------------------------------------------------------------------------
# Contract shapes
#
# Declared as frozen sets so a projection can be asserted by set equality rather than by a
# sequence of `in` checks. Equality is the stronger assertion in both directions: a field that
# disappears fails, and so does a field that is added without this contract being updated -
# which is the case that matters for `UserPublic`, where an accidental addition is a
# disclosure.
# ---------------------------------------------------------------------------------------

_USER_PUBLIC_KEYS: Final[frozenset[str]] = frozenset(
    {"id", "username", "display_name", "bio", "avatar_url", "created_at"}
)
"""Exactly what ``UserPublic`` publishes - the projection ``POST /auth/register`` returns."""

_USER_ME_ONLY_KEYS: Final[frozenset[str]] = frozenset({"email", "role", "is_active", "updated_at"})
"""What ``UserMe`` adds on top of the public projection, and what only the holder may see."""

_USER_ME_KEYS: Final[frozenset[str]] = _USER_PUBLIC_KEYS | _USER_ME_ONLY_KEYS
"""Exactly what ``UserMe`` publishes - the projection ``GET /auth/me`` returns."""

_CONFIDENTIAL_KEYS: Final[frozenset[str]] = frozenset(
    {"password", "password_hash", "email", "role", "is_active"}
)
"""Keys that must never appear in a ``UserPublic`` body.

The first two are credentials and may appear in no response in this API at all. The last three
are private to the account and to an administrator: ``UserMe`` carries them, the public
projection must not, and registration answers with the public projection.
"""

_TOKEN_PAIR_KEYS: Final[frozenset[str]] = frozenset(
    {"access_token", "refresh_token", "token_type", "expires_in"}
)
"""Exactly what ``TokenPair`` publishes, from both ``/auth/login`` and ``/auth/refresh``."""

_PROBLEM_KEYS: Final[frozenset[str]] = frozenset({"type", "title", "status", "detail", "instance"})
"""The members every error body carries.

A subset assertion rather than an equality one, deliberately: ``app.core.exceptions`` also
emits ``request_id`` on every document and ``errors`` on a validation failure, and neither is
part of what this module is pinning.
"""

_PROBLEM_MEDIA_TYPE: Final[str] = "application/problem+json"
_BEARER_CHALLENGE: Final[str] = "Bearer"
_WWW_AUTHENTICATE: Final[str] = "WWW-Authenticate"
_CORRELATION_KEY: Final[str] = "request_id"

# The `type` a throttled response carries. `app.core.exceptions` keeps its own copy private, so
# the value is restated here as a literal: it is part of the published error contract a client
# switches on, and a test that imported it could not notice it changing.
_ERROR_TYPE_RATE_LIMITED: Final[str] = "/errors/rate-limit-exceeded"

# The header the 429 carries its retry interval in, and the header a rotating caller uses to
# claim an address it does not have.
_RETRY_AFTER: Final[str] = "Retry-After"
_FORWARDED_FOR: Final[str] = "X-Forwarded-For"

# Upper bound on the advertised retry interval, since `AUTH_RATE_LIMIT` declares a per-minute
# window. Named rather than inlined so the assertion reads as a bound on the window rather than
# as an arbitrary sixty.
_SECONDS_PER_MINUTE: Final[int] = 60

#: Base URL for the extra clients :func:`peer_client` builds. The same placeholder authority the
#: shared ``client`` fixture uses - httpx needs an absolute base to build a request target from,
#: and nothing listens on it because the transport calls the application directly.
_PEER_BASE_URL: Final[str] = "http://testserver"

#: Source port reported for a synthesised peer. slowapi's identity reads only the host half, so
#: the value is arbitrary; it is named rather than inlined so the tuple below reads as an address.
_PEER_PORT: Final[int] = 51234

#: Two peer addresses in the documentation range reserved by RFC 5737, so neither can collide with
#: anything routable if a future change ever puts a real socket behind these clients.
_PEER_ADDRESSES: Final[tuple[str, str]] = ("192.0.2.11", "192.0.2.12")

# Obviously fake, and deliberately unable to satisfy `verify_password` against any hash this
# suite creates: `tests.factories.DEFAULT_PASSWORD` is the only plaintext any factory-made
# account was hashed from. Long enough and varied enough to clear `LoginRequest`'s own bounds,
# so the 401 it earns comes from the credential check and not from field validation.
_WRONG_PASSWORD: Final[str] = "Definitely-Not-The-Passw0rd"

# A value that is syntactically a token but was never issued, for the paths that must refuse an
# unknown credential. Bounded well inside `RefreshRequest`'s 512-character ceiling so it
# reaches the service rather than being rejected by the schema.
_UNISSUED_REFRESH_TOKEN: Final[str] = "never-issued-refresh-token-value"

# Comfortably more than the five-per-minute limit `conftest.py` configures, so a burst of this
# size could not pass unless the limiter were disabled. Kept modest because each attempt costs
# one deliberate argon2id verification, and the point of the test is the absence of a 429
# rather than the size of the flood.
_BURST_SIZE: Final[int] = 12

# The shape of `conftest.auth_headers_for`, which is a fixture returning a callable rather than
# a value. Named so the two signatures that take it read as contracts instead of as `Any`.
AuthHeaderFactory = Callable[[User], dict[str, str]]

# Process-monotonic discriminator for generated credentials. `users.email` and
# `users.username` are CITEXT UNIQUE, so two accounts differing only in case are already a
# duplicate; embedding a counter makes a collision impossible by construction rather than
# improbable. Kept independent of `tests.factories`' own counter - the prefix below shares no
# stem with the factories' `user{n}` pattern, so the two sequences cannot converge.
_counter: Final[itertools.count[int]] = itertools.count(1)


def _credentials(**overrides: Any) -> dict[str, Any]:
    """Build a valid ``RegisterRequest`` body, unique to this call.

    Every generated value embeds a monotonic discriminator, so a body from one test can never
    collide with a body from another - which matters because the duplicate-identity tests
    below assert on ``409``, and a leaked collision would make one of them pass for the wrong
    reason. The password is ``tests.factories.DEFAULT_PASSWORD``, which satisfies
    ``app.schemas.auth`` in full, so a caller perturbing another field never has to
    reason about whether the password is also being rejected.

    Args:
        **overrides: Members to replace or add. Adding one that ``RegisterRequest`` does not
            declare is a legitimate use: the model sets ``extra="forbid"``, and the refusal is
            exactly what the anti-escalation tests assert.

    Returns:
        A fresh mutable body, safe to mutate further at the call site.
    """
    discriminator = next(_counter)
    body: dict[str, Any] = {
        "email": f"auth-api-{discriminator}@example.com",
        "username": f"auth-api-{discriminator}",
        "password": DEFAULT_PASSWORD,
        "display_name": f"Auth Api {discriminator}",
    }
    body.update(overrides)
    return body


def _varied_password(length: int, *, filler: str = "a") -> str:
    """Return a password of exactly *length* code points drawing on three character groups.

    The builder every length-boundary case below uses, so that a candidate sitting one code point
    from a limit differs from its neighbour in **length only**. Composing such a value by hand is
    where boundary tests quietly stop testing the boundary: a hand-written 129-character string
    that also happens to use two character groups is refused for the wrong reason, and the test
    passes while the length ceiling goes unexercised.

    ``length`` is counted in **code points**, which is the unit
    ``pydantic.StringConstraints(max_length=...)`` counts in. That makes *filler* the interesting
    parameter: pass an astral character and the returned value has *length* code points, more than
    *length* UTF-16 units and four times *length* UTF-8 bytes, so a limit implemented against
    either of those miscounts it.

    Args:
        length: How many code points the result must contain. Values below three return a prefix
            of the seed and therefore draw on fewer groups - only used for the sub-floor cases,
            where length is what is being refused.
        filler: The character repeated to reach *length*. One code point, ASCII or astral.

    Returns:
        A password of exactly *length* code points.
    """
    # Lowercase, uppercase and a digit: three of the five published groups, which is exactly
    # `PASSWORD_MIN_CHARACTER_CLASSES`, so the variety rule is satisfied and nothing else is.
    seed = "aQ7"
    if length <= len(seed):
        return seed[:length]
    return seed + filler * (length - len(seed))


def _login_form(email: str, password: str = DEFAULT_PASSWORD) -> dict[str, str]:
    """Build the body ``POST /api/v1/auth/login`` expects, for use with ``data=``.

    The grant's field is named ``username`` while the value it carries is this API's **email
    address**; that mapping is performed by the route, and stating it in one helper keeps every
    call site from restating it. Always passed as ``data=``: a JSON body of the same shape
    answers ``422``.
    """
    return {"username": email, "password": password}


def _bearer(token: str) -> dict[str, str]:
    """Build the ``Authorization`` header for an access token."""
    return {"Authorization": f"{_BEARER_CHALLENGE} {token}"}


def _without_correlation(payload: dict[str, Any]) -> dict[str, Any]:
    """Return an error body without its per-request correlation identifier.

    ``app.core.exceptions`` stamps a distinct ``request_id`` on every problem document, so two
    responses that must be indistinguishable are never byte-identical. Dropping that one member
    is what makes the comparison meaningful rather than vacuous.
    """
    return {key: value for key, value in payload.items() if key != _CORRELATION_KEY}


def _field_names(payload: dict[str, Any]) -> set[str]:
    """Return the field paths named by a validation problem document's ``errors`` list."""
    errors = payload.get("errors")
    assert isinstance(errors, list), payload
    assert errors, "a validation problem document must name at least one field"
    return {str(entry["field"]) for entry in errors}


def _serialised(payload: object) -> str:
    """Render a decoded body back to text, so a marker can be searched for across every member.

    ``dict.keys()`` only sees the top level. A credential that leaked into a nested object, or
    under a member this module does not know to name, would pass a key-set assertion and fail
    this one - which is why the confidentiality checks use both.

    :data:`_CORRELATION_KEY` is **excluded**, and that is a correctness requirement rather than a
    tidy-up. Every caller of this function asserts an *absence* - "the rejected value is never
    echoed" - and ``request_id`` is thirty-two characters of server-generated random hex that
    echoes nothing a caller sent. Searching it turns a confidentiality assertion into a coin
    flip whenever the marker is short: a two-character marker such as the ``username`` one code
    point under its floor appears somewhere in a random 32-character hex string roughly one run
    in nine, which is exactly how this module came to fail intermittently on a value it had
    correctly withheld. Dropping the one member that cannot leak keeps every assertion's meaning
    and removes the false positive; a marker that reaches ``detail``, ``instance``, ``errors`` or
    any nested member is still found.
    """
    if isinstance(payload, dict):
        payload = {key: value for key, value in payload.items() if key != _CORRELATION_KEY}
    return json.dumps(payload, default=str)


async def _count_users_matching(
    session: AsyncSession,
    *,
    email: str | None = None,
    username: str | None = None,
) -> int:
    """Count ``users`` rows whose email address or username matches the given spelling.

    Read straight through the test's own session, which is the same session the request used,
    so a row a route committed is visible here and the count reflects what the request actually
    did. This is verification of an *effect* and never a substitute for driving the route:
    every behaviour in this module is established over HTTP.

    Both columns are ``CITEXT``, so ``==`` is a case-insensitive comparison performed by
    PostgreSQL. Passing a case-variant spelling therefore counts the row that was stored under
    the original spelling, which is precisely what makes this the right instrument for the
    duplicate-identity tests: it proves the index treats the two as one identity.

    Args:
        session: The transactional session the test holds.
        email: Email address to match, in any casing. Ignored when ``None``.
        username: Username to match, in any casing. Ignored when ``None``.

    Returns:
        The number of matching rows, counting a row once even if both predicates match it.

    Raises:
        ValueError: If neither predicate was supplied, which would count the whole relation and
            silently pass any assertion made about it.
    """
    if email is None and username is None:
        message = "supply an email address, a username, or both"
        raise ValueError(message)

    statement = select(func.count()).select_from(User)
    if email is not None:
        statement = statement.where(User.email == email)
    if username is not None:
        statement = statement.where(User.username == username)

    total = await session.scalar(statement)
    return int(total or 0)


async def _user_matching(session: AsyncSession, *, email: str) -> User | None:
    """Return the ``users`` row registered under *email*, or ``None``.

    The counting sibling above answers "did a row appear"; this one answers "what does it hold",
    which is what a boundary test needs. A ceiling enforced by truncation answers 201 exactly as a
    ceiling enforced by validation does, and the only place the two differ is the stored value.

    Read through the test's own session, so the row a request just wrote is visible. ``email`` is
    ``CITEXT``, so the comparison is case-insensitive and performed by PostgreSQL.

    Args:
        session: The transactional session the test holds.
        email: The address to look the account up by, in any casing.

    Returns:
        The matching :class:`~app.models.User`, or ``None`` when nothing was written.
    """
    return await session.scalar(select(User).where(User.email == email))


def _assert_problem_document(response: Response, expected_status: int) -> dict[str, Any]:
    """Assert the response is the API's uniform problem document, and return its body.

    Checks the status, the ``application/problem+json`` media type and the five documented
    members, and confirms ``status`` agrees with the transport and ``instance`` names the path
    that was called. Nothing here asserts on ``detail``'s wording beyond it being present and
    non-empty; several of these routes answer with deliberately undifferentiated prose, and
    pinning it would pin a security property to a string.

    Args:
        response: The response to inspect.
        expected_status: The status the caller expects, as an ``int`` or an
            :class:`~http.HTTPStatus`.

    Returns:
        The decoded body, so a caller can make further assertions on it.
    """
    assert response.status_code == expected_status, response.text
    media_type = response.headers.get("content-type", "")
    assert media_type.startswith(_PROBLEM_MEDIA_TYPE), media_type
    payload: dict[str, Any] = response.json()
    assert payload.keys() >= _PROBLEM_KEYS, payload
    assert payload["status"] == int(expected_status), payload
    assert payload["instance"] == response.request.url.path, payload
    assert isinstance(payload["detail"], str), payload
    assert payload["detail"], payload
    return payload


def _assert_unauthorized(response: Response) -> dict[str, Any]:
    """Assert a ``401`` problem document carrying the ``WWW-Authenticate: Bearer`` challenge.

    The challenge header is part of the contract rather than a nicety:
    ``app.core.exceptions.UnauthorizedError`` declares it as a class default, so every 401 this
    API produces must carry it, and a client following the specification uses it to decide
    which scheme to retry with.
    """
    payload = _assert_problem_document(response, HTTPStatus.UNAUTHORIZED)
    assert response.headers.get(_WWW_AUTHENTICATE) == _BEARER_CHALLENGE, dict(response.headers)
    return payload


def _assert_token_pair(payload: dict[str, Any]) -> None:
    """Assert a body is a complete, well-formed ``TokenPair``.

    All four members, and each one checked rather than merely present: ``token_type`` is
    declared ``Literal["bearer"]`` so a client may hard-code the scheme, and ``expires_in`` is
    declared ``gt=0`` so a client can schedule a refresh without decoding the access token.
    """
    assert payload.keys() == _TOKEN_PAIR_KEYS, payload
    assert isinstance(payload["access_token"], str)
    assert payload["access_token"]
    assert isinstance(payload["refresh_token"], str)
    assert payload["refresh_token"]
    assert payload["token_type"] == "bearer", payload
    assert isinstance(payload["expires_in"], int), payload
    assert payload["expires_in"] > 0, payload


async def _register(client: AsyncClient, **overrides: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    """Register a fresh account and return the submitted body alongside the created projection.

    Asserts the ``201`` itself, so a caller setting up state does not silently proceed on a
    failed precondition - the assertion carries the response text, which is what makes a
    surprising failure diagnosable at the line that caused it.
    """
    body = _credentials(**overrides)
    response = await client.post(_REGISTER_URL, json=body)
    assert response.status_code == HTTPStatus.CREATED, response.text
    return body, response.json()


async def _sign_in(
    client: AsyncClient,
    email: str,
    password: str = DEFAULT_PASSWORD,
) -> dict[str, Any]:
    """Sign in through the real route and return the token pair, asserting the ``200``."""
    response = await client.post(_LOGIN_URL, data=_login_form(email, password))
    assert response.status_code == HTTPStatus.OK, response.text
    # Bound to an annotated local rather than returned straight out. `Response.json()` is `Any`, so
    # returning it directly would make this function's declared shape a claim nothing checks.
    token_pair: dict[str, Any] = response.json()
    return token_pair


async def _registered_session(client: AsyncClient) -> tuple[dict[str, Any], dict[str, Any]]:
    """Register an account and sign in as it, returning the credentials and the token pair.

    The setup every lifecycle test starts from. It goes through both real routes rather than
    minting a token with ``auth_headers_for``, because a token this module examines must be one
    the service actually issued - ``expires_in``, the claims and the paired refresh token are
    all part of what is under test here.
    """
    body, _ = await _register(client)
    tokens = await _sign_in(client, str(body["email"]))
    return body, tokens


# ---------------------------------------------------------------------------------------
# Phase A - registration
# ---------------------------------------------------------------------------------------


class TestRegistration:
    """``POST /api/v1/auth/register``: account creation, its projection, and its refusals."""

    async def test_registration_creates_an_account_and_returns_its_public_projection(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP R1 sign-up: a valid body answers 201 with exactly the ``UserPublic`` members."""
        body = _credentials()

        response = await client.post(_REGISTER_URL, json=body)

        assert response.status_code == HTTPStatus.CREATED, response.text
        payload = response.json()
        assert payload.keys() == _USER_PUBLIC_KEYS, payload
        assert payload["username"] == body["username"]
        assert payload["display_name"] == body["display_name"]
        # Neither is collected at registration, and both are published as explicit nulls rather
        # than omitted, so a client never has to distinguish an absent member from a null one.
        assert payload["bio"] is None
        assert payload["avatar_url"] is None
        assert isinstance(payload["created_at"], str)
        assert payload["created_at"]

    async def test_registration_withholds_every_confidential_field(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP standard 6: the register response carries no credential and no private member."""
        _, payload = await _register(client)

        assert _CONFIDENTIAL_KEYS.isdisjoint(payload.keys()), payload
        # Belt and braces against a nested or renamed leak: the plaintext this account was
        # created with must not appear anywhere in the serialised body, under any key.
        assert DEFAULT_PASSWORD not in _serialised(payload)

    async def test_registration_generates_the_identifier_itself(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP standard 3: identity is a server-generated random UUID, one per account."""
        _, first = await _register(client)
        _, second = await _register(client)

        first_id = uuid.UUID(str(first["id"]))
        second_id = uuid.UUID(str(second["id"]))
        # Version 4 is what `gen_random_uuid()` produces, and it is the assertion that
        # distinguishes a random server-side key from a guessable sequential one.
        assert first_id.version == 4
        assert second_id.version == 4
        assert first_id != second_id

    async def test_registration_refuses_a_client_supplied_identifier(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
    ) -> None:
        """AAP standard 3: a client cannot choose a primary key; the attempt is refused."""
        body = _credentials(id=str(uuid.uuid4()))

        response = await client.post(_REGISTER_URL, json=body)

        payload = _assert_problem_document(response, HTTPStatus.UNPROCESSABLE_CONTENT)
        assert "id" in _field_names(payload)
        # Refused outright rather than silently dropped, so nothing was created either. This is
        # the stronger property: the retired service let a caller supply an integer key the
        # server never generated and never checked, and a duplicate shadowed every later record.
        assert await _count_users_matching(db_session, email=str(body["email"])) == 0

    async def test_registration_cannot_request_a_role(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
    ) -> None:
        """AAP R11 and standard 6: ``RegisterRequest`` has no role member, so escalation fails."""
        body = _credentials(role=UserRole.ADMIN.value)

        response = await client.post(_REGISTER_URL, json=body)

        payload = _assert_problem_document(response, HTTPStatus.UNPROCESSABLE_CONTENT)
        assert "role" in _field_names(payload)
        assert await _count_users_matching(db_session, email=str(body["email"])) == 0

    async def test_registration_confers_no_administrative_authority(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP standard 6: a self-registered account is an author and is refused the admin gate."""
        body, tokens = await _registered_session(client)
        headers = _bearer(str(tokens["access_token"]))

        principal = await client.get(_ME_URL, headers=headers)
        gated = await client.get(_ADMIN_STATS_URL, headers=headers)

        assert principal.status_code == HTTPStatus.OK, principal.text
        # Read from the account record rather than from the token claim, which is what makes it
        # an authority statement rather than an assertion the caller supplied.
        assert principal.json()["role"] == UserRole.AUTHOR.value
        assert principal.json()["role"] != UserRole.ADMIN.value
        # And the gate is enforced server-side, not by hiding a control: `require_admin` is
        # applied at the /admin mount, so every route beneath it refuses this principal.
        _assert_problem_document(gated, HTTPStatus.FORBIDDEN)
        assert body["email"] not in gated.text

    @pytest.mark.parametrize(
        ("overrides", "expected_field"),
        [
            pytest.param({"email": "not-an-email-address"}, "email", id="email-without-an-at-sign"),
            pytest.param({"email": "missing-the-domain@"}, "email", id="email-without-a-domain"),
            pytest.param(
                {"password": _varied_password(PASSWORD_MAX_LENGTH + 1)},
                "password",
                id="password-one-over-the-length-ceiling",
            ),
            pytest.param(
                {"password": _varied_password(PASSWORD_MIN_LENGTH - 1)},
                "password",
                id="password-one-short-of-the-length-floor",
            ),
            pytest.param(
                # Long enough to clear the floor and drawing on a single group, so the refusal is
                # the variety rule rather than the length one.
                {"password": "a" * PASSWORD_MIN_LENGTH},
                "password",
                id="password-with-too-little-character-variety",
            ),
            pytest.param(
                {"username": "a" * (USERNAME_MIN_LENGTH - 1)},
                "username",
                id="username-one-short-of-the-length-floor",
            ),
            pytest.param({"username": "has spaces"}, "username", id="username-with-a-space"),
            pytest.param(
                {"username": "-leading-hyphen"}, "username", id="username-starting-with-a-hyphen"
            ),
            pytest.param(
                {"username": "a" * (USERNAME_MAX_LENGTH + 1)},
                "username",
                id="username-one-over-the-length-ceiling",
            ),
            pytest.param(
                {"display_name": "   "}, "display_name", id="whitespace-only-display-name"
            ),
        ],
    )
    async def test_registration_rejects_an_invalid_member(
        self,
        client: AsyncClient,
        overrides: dict[str, Any],
        expected_field: str,
    ) -> None:
        """AAP section 0.9.4.3: a schema violation answers 422 naming the member at fault."""
        response = await client.post(_REGISTER_URL, json=_credentials(**overrides))

        payload = _assert_problem_document(response, HTTPStatus.UNPROCESSABLE_CONTENT)
        assert expected_field in _field_names(payload)
        # The rule is quoted, never the value: a body echoing a rejected password back would
        # put the plaintext into a log the caller cannot audit.
        assert str(next(iter(overrides.values()))) not in payload["detail"]

    @pytest.mark.parametrize("omitted", ["email", "username", "password"])
    async def test_registration_rejects_a_missing_required_member(
        self,
        client: AsyncClient,
        omitted: str,
    ) -> None:
        """AAP section 0.9.4.3: an absent required member answers 422 naming it as missing."""
        body = _credentials()
        del body[omitted]

        response = await client.post(_REGISTER_URL, json=body)

        payload = _assert_problem_document(response, HTTPStatus.UNPROCESSABLE_CONTENT)
        assert omitted in _field_names(payload)
        assert any(entry["type"] == "missing" for entry in payload["errors"])

    async def test_registration_derives_a_display_name_from_the_username(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP R5: ``display_name`` is never null, so it falls back to the username."""
        body = _credentials()
        del body["display_name"]

        response = await client.post(_REGISTER_URL, json=body)

        assert response.status_code == HTTPStatus.CREATED, response.text
        assert response.json()["display_name"] == body["username"]

    async def test_registration_answers_the_declared_status_and_not_a_redirect(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP R8: the route is mounted at exactly ``/api/v1/auth/register`` under the prefix."""
        response = await client.post(_REGISTER_URL, json=_credentials())

        assert response.status_code == HTTPStatus.CREATED, response.text
        # No redirect was followed to get here, so the asserted path is the mounted path rather
        # than a trailing-slash variant the client silently corrected.
        assert response.history == []
        assert response.request.url.path == _REGISTER_URL


# ---------------------------------------------------------------------------------------
# Phase B - duplicate identity, including the case-variant case
#
# AAP standard 3, and the one guarantee in this module that belongs to PostgreSQL rather than
# to Python. `users.email` and `users.username` are CITEXT UNIQUE, installed by revision
# 0001_initial_blog_schema, so a stored `Alice` already occupies `alice`. The planning phase
# verified this by execution - inserting `Alice`/`A@X.com` then attempting `alice`/`a@x.com`
# was rejected with a unique violation - so if one of these tests fails, the route or the
# schema changed, not the database.
# ---------------------------------------------------------------------------------------


class TestCredentialFieldBoundaries:
    """Every length limit on a credential field, from both sides, at the exact code point.

    The three registration fields and the two token fields all carry a numeric bound, and a bound
    is only established by a pair of cases: the largest value that must be **accepted** and the
    smallest that must be **refused**. A test that only sends an obviously-too-long value proves
    the field is bounded somewhere, not that it is bounded where the published contract says - and
    "somewhere" is what a client cannot build a form against, because it is the accepted maximum
    the client has to put in its own ``maxlength``.

    Every value is built from the production constant by :func:`_varied_password` or by repetition,
    never written as a literal. That is the whole point of the finding this class answers: a
    hard-coded ``"a" * 31`` stops being the username ceiling the moment ``USERNAME_MAX_LENGTH``
    moves, and it stops silently, because 31 characters remains a perfectly sendable value.

    **Astral code points appear on purpose.** ``pydantic.StringConstraints`` counts code points, so
    eighty ``"😀"`` is exactly at the display-name ceiling while being 160 UTF-16 units and 320
    UTF-8 bytes. A limit implemented against either of those - a ``VARCHAR(80)`` in bytes, a
    JavaScript ``.length`` check mirrored server-side - refuses a value this contract accepts, and
    the pair of cases below is what would catch it.
    """

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            pytest.param(
                "username",
                "a" * USERNAME_MIN_LENGTH,
                id="username-at-the-floor",
            ),
            pytest.param(
                "username",
                "a" * USERNAME_MAX_LENGTH,
                id="username-at-the-ceiling",
            ),
            pytest.param(
                "password",
                _varied_password(PASSWORD_MIN_LENGTH),
                id="password-at-the-floor",
            ),
            pytest.param(
                "password",
                _varied_password(PASSWORD_MAX_LENGTH),
                id="password-at-the-ceiling",
            ),
            pytest.param(
                "password",
                _varied_password(PASSWORD_MAX_LENGTH, filler="😀"),
                id="password-at-the-ceiling-in-astral-code-points",
            ),
            pytest.param(
                "display_name",
                "n" * DISPLAY_NAME_MIN_LENGTH,
                id="display-name-at-the-floor",
            ),
            pytest.param(
                "display_name",
                "n" * DISPLAY_NAME_MAX_LENGTH,
                id="display-name-at-the-ceiling",
            ),
            pytest.param(
                "display_name",
                "😀" * DISPLAY_NAME_MAX_LENGTH,
                id="display-name-at-the-ceiling-in-astral-code-points",
            ),
        ],
    )
    async def test_a_value_exactly_at_a_limit_is_accepted(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        field: str,
        value: str,
    ) -> None:
        """A field holding exactly its published maximum, or minimum, registers successfully.

        And is stored as sent, which is the second half of the assertion. A ceiling enforced by
        silent truncation would answer 201 too, and the account would then hold a credential or a
        byline the caller never chose - a password truncated at storage cannot be logged in with,
        so the failure would surface as an unreproducible sign-in problem rather than as a
        validation defect. The stored value is therefore compared code point for code point.
        """
        body = _credentials(**{field: value})

        response = await client.post(_REGISTER_URL, json=body)

        assert response.status_code == HTTPStatus.CREATED, response.text
        stored = await _user_matching(db_session, email=str(body["email"]))
        assert stored is not None, body["email"]
        if field == "password":
            # Not readable back - it was hashed - so the round trip is what proves nothing was
            # dropped: the same value must still authenticate.
            signed_in = await client.post(_LOGIN_URL, data=_login_form(str(body["email"]), value))
            assert signed_in.status_code == HTTPStatus.OK, signed_in.text
        else:
            assert getattr(stored, field) == value
            assert len(getattr(stored, field)) == len(value)

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            pytest.param(
                "username",
                "a" * (USERNAME_MIN_LENGTH - 1),
                id="username-one-under-the-floor",
            ),
            pytest.param(
                "username",
                "a" * (USERNAME_MAX_LENGTH + 1),
                id="username-one-over-the-ceiling",
            ),
            pytest.param(
                "password",
                _varied_password(PASSWORD_MIN_LENGTH - 1),
                id="password-one-under-the-floor",
            ),
            pytest.param(
                "password",
                _varied_password(PASSWORD_MAX_LENGTH + 1),
                id="password-one-over-the-ceiling",
            ),
            pytest.param(
                "password",
                _varied_password(PASSWORD_MAX_LENGTH + 1, filler="😀"),
                id="password-one-over-the-ceiling-in-astral-code-points",
            ),
            pytest.param(
                "display_name",
                "n" * (DISPLAY_NAME_MAX_LENGTH + 1),
                id="display-name-one-over-the-ceiling",
            ),
            pytest.param(
                "display_name",
                "😀" * (DISPLAY_NAME_MAX_LENGTH + 1),
                id="display-name-one-over-the-ceiling-in-astral-code-points",
            ),
            pytest.param(
                "display_name",
                # `StorableText` refuses U+0000 outright: `users.display_name` is `text`, and
                # PostgreSQL cannot store a NUL in one, so the driver would raise a `ValueError`
                # deep in the write and answer 500. Refused at the schema instead, as a 422.
                f"Nul{chr(0)}byte",
                id="display-name-carrying-a-null-code-point",
            ),
        ],
    )
    async def test_a_value_one_step_past_a_limit_is_refused(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        field: str,
        value: str,
    ) -> None:
        """One code point past a bound is a 422 naming the field, and writes nothing.

        The refusal has to leave no row behind. A partially-applied registration - the account
        created and then rejected - would make the email address unavailable to the caller who
        never successfully registered it, and the second attempt would answer 409 for a reason
        nobody could see.
        """
        body = _credentials(**{field: value})

        response = await client.post(_REGISTER_URL, json=body)

        payload = _assert_problem_document(response, HTTPStatus.UNPROCESSABLE_CONTENT)
        assert field in _field_names(payload), payload
        assert await _count_users_matching(db_session, email=str(body["email"])) == 0
        # The rejected value is never echoed, whatever it was: an over-long password is still a
        # password, and a problem document is the one part of a failure that gets logged.
        #
        # Searched WITHOUT the correlation identifier. `request_id` is 32 random hex characters, so
        # a short submitted value made of hex digits - `aa`, one code point under the username floor
        # - occurs inside it by chance roughly one run in nine, and this assertion then failed on a
        # coincidence in a value the handler generated rather than on anything it echoed.
        assert value not in _serialised(_without_correlation(payload))

    async def test_the_sign_in_ceiling_never_turns_a_long_password_into_a_different_answer(
        self,
        client: AsyncClient,
        author_user: User,
    ) -> None:
        """A password past the sign-in ceiling is refused as a credential, not as a bad request.

        ``LoginRequest`` bounds ``password`` at the same ceiling registration applies, for a
        different reason: argon2id is memory-hard by design, so an unbounded password field lets an
        unauthenticated caller choose how much work each attempt costs. The bound is a cap on that
        work, not a judgement about the credential - which is why the route deliberately answers
        **401 for both sides of it**. A value at the ceiling is a well-formed guess; one code point
        more is refused before reaching the hash, and reporting that as 422 would tell an attacker
        which of their inputs the schema rejected on the one route whose security rests on its
        failures being alike.

        Two things this pins that are easy to regress. The over-length submission must not be a
        **500**: the handler builds ``LoginRequest`` from the password grant's unconstrained form
        and a :class:`pydantic.ValidationError` there is a ``ValueError``, so an unguarded
        construction would report a server fault for a wrong credential. And the plaintext must not
        appear in the response: that same ``ValidationError`` records the value it rejected, which
        is why the handler re-raises with ``from None``.

        The two 401s do differ in the *wording* of ``detail`` - the guard raises bare, so it
        carries the generic "credentials are missing or invalid" text rather than the credential
        check's "Incorrect email or password." That is not asserted as equal here, deliberately:
        pinning prose would pin a security property to a string, and the machine-readable half a
        client switches on - the status and the ``type`` - is what is asserted instead.
        """
        at_ceiling = await client.post(
            _LOGIN_URL,
            data=_login_form(author_user.email, _varied_password(PASSWORD_MAX_LENGTH)),
        )
        over_ceiling = await client.post(
            _LOGIN_URL,
            data=_login_form(author_user.email, _varied_password(PASSWORD_MAX_LENGTH + 1)),
        )

        at_payload = _assert_problem_document(at_ceiling, HTTPStatus.UNAUTHORIZED)
        over_payload = _assert_problem_document(over_ceiling, HTTPStatus.UNAUTHORIZED)
        assert over_payload["type"] == at_payload["type"], (at_payload, over_payload)
        assert _varied_password(PASSWORD_MAX_LENGTH + 1) not in _serialised(over_payload)
        assert author_user.email not in _serialised(over_payload)

    async def test_the_refresh_token_ceiling_refuses_a_longer_value_before_looking_it_up(
        self,
        client: AsyncClient,
    ) -> None:
        """``RefreshRequest`` bounds the token, and the bound is a request-boundary refusal.

        ``REFRESH_TOKEN_MAX_LENGTH`` sits far above any token this service issues, so its purpose
        is not to validate a credential's shape - the contract deliberately does not pin that to
        the generator's encoding - but to stop an arbitrarily large body being hashed and looked
        up. Hence the pairing: a value at the ceiling is treated as an unknown credential and
        earns 401, while one code point more is refused as malformed.
        """
        at_ceiling = await client.post(
            _REFRESH_URL, json={"refresh_token": "t" * REFRESH_TOKEN_MAX_LENGTH}
        )
        over_ceiling = await client.post(
            _REFRESH_URL, json={"refresh_token": "t" * (REFRESH_TOKEN_MAX_LENGTH + 1)}
        )

        assert at_ceiling.status_code == HTTPStatus.UNAUTHORIZED, at_ceiling.text
        payload = _assert_problem_document(over_ceiling, HTTPStatus.UNPROCESSABLE_CONTENT)
        assert "refresh_token" in _field_names(payload), payload


class TestDuplicateIdentity:
    """``POST /api/v1/auth/register``: identity is unique, and uniqueness ignores case."""

    async def test_a_repeated_email_address_is_refused(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP standard 3: an email address already registered answers 409."""
        first, _ = await _register(client)

        repeated = await client.post(
            _REGISTER_URL,
            json=_credentials(email=first["email"]),
        )

        _assert_problem_document(repeated, HTTPStatus.CONFLICT)

    async def test_a_repeated_username_is_refused(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP standard 3: a username already registered answers 409."""
        first, _ = await _register(client)

        repeated = await client.post(
            _REGISTER_URL,
            json=_credentials(username=first["username"]),
        )

        _assert_problem_document(repeated, HTTPStatus.CONFLICT)

    async def test_an_email_address_differing_only_in_case_is_refused(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
    ) -> None:
        """AAP standard 3: the CITEXT index treats two casings of one address as one identity."""
        first, _ = await _register(client)
        variant = str(first["email"]).upper()
        assert variant != first["email"], "the generated address must contain a letter to vary"

        repeated = await client.post(_REGISTER_URL, json=_credentials(email=variant))

        _assert_problem_document(repeated, HTTPStatus.CONFLICT)
        # The effect, not merely the status: counting through the *variant* spelling proves both
        # that no second row exists and that the database resolves the two spellings to one.
        assert await _count_users_matching(db_session, email=variant) == 1

    async def test_a_username_differing_only_in_case_is_refused(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
    ) -> None:
        """AAP standard 3: the CITEXT index treats two casings of one handle as one identity."""
        first, _ = await _register(client)
        variant = str(first["username"]).upper()
        assert variant != first["username"], "the generated username must contain a letter to vary"

        repeated = await client.post(_REGISTER_URL, json=_credentials(username=variant))

        _assert_problem_document(repeated, HTTPStatus.CONFLICT)
        assert await _count_users_matching(db_session, username=variant) == 1

    async def test_a_refused_registration_leaves_exactly_one_account(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
    ) -> None:
        """AAP standard 3: four refused attempts against one identity create no further rows."""
        first, _ = await _register(client)
        email = str(first["email"])
        username = str(first["username"])

        attempts = [
            _credentials(email=email),
            _credentials(username=username),
            _credentials(email=email.upper()),
            _credentials(username=username.upper()),
        ]
        for attempt in attempts:
            refused = await client.post(_REGISTER_URL, json=attempt)
            _assert_problem_document(refused, HTTPStatus.CONFLICT)

        assert await _count_users_matching(db_session, email=email) == 1
        assert await _count_users_matching(db_session, username=username) == 1
        # And no attempt smuggled its *own* identifiers in either: each carried a fresh email
        # and username in the member it was not colliding on, and none of those was created.
        for attempt in attempts:
            if str(attempt["email"]).casefold() != email.casefold():
                assert await _count_users_matching(db_session, email=str(attempt["email"])) == 0

    async def test_the_conflict_does_not_disclose_which_identifier_clashed(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP standard 6: registration must not become a test of whether an account exists."""
        first, _ = await _register(client)
        email = str(first["email"])
        username = str(first["username"])

        by_email = await client.post(_REGISTER_URL, json=_credentials(email=email))
        by_username = await client.post(_REGISTER_URL, json=_credentials(username=username))

        email_problem = _assert_problem_document(by_email, HTTPStatus.CONFLICT)
        username_problem = _assert_problem_document(by_username, HTTPStatus.CONFLICT)
        # Neither the address nor the handle is echoed back, so a caller learns that *something*
        # clashed and nothing more. Asserted on the serialised body rather than on `detail`
        # alone, so a future member carrying the value would fail this too.
        assert email not in _serialised(email_problem)
        assert username not in _serialised(username_problem)
        # And the two are indistinguishable, which is what stops the pair of them from being
        # used as an oracle: ask twice and you cannot tell which identifier was known.
        assert _without_correlation(email_problem) == _without_correlation(username_problem)


# ---------------------------------------------------------------------------------------
# Phase C - signing in, and the protected route it unlocks
# ---------------------------------------------------------------------------------------


class TestSignIn:
    """``POST /auth/login`` and ``GET /auth/me``: the R1 happy path and its refusals."""

    async def test_register_then_sign_in_then_read_the_protected_principal_route(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP section 0.9.4.4 "Registration and login", end to end, as one chain."""
        body = _credentials()

        created = await client.post(_REGISTER_URL, json=body)
        assert created.status_code == HTTPStatus.CREATED, created.text

        # Form-encoded, with the address in the grant's `username` field. This is the whole
        # criterion: a caller that just registered must be able to sign in with what it sent.
        signed_in = await client.post(
            _LOGIN_URL,
            data=_login_form(str(body["email"]), str(body["password"])),
        )
        assert signed_in.status_code == HTTPStatus.OK, signed_in.text
        tokens = signed_in.json()
        _assert_token_pair(tokens)

        principal = await client.get(_ME_URL, headers=_bearer(str(tokens["access_token"])))

        assert principal.status_code == HTTPStatus.OK, principal.text
        payload = principal.json()
        assert payload.keys() == _USER_ME_KEYS, payload
        assert payload["email"] == body["email"]
        assert payload["username"] == body["username"]
        # The same account throughout, identified by the server-generated key rather than by
        # the credential the caller happens to know.
        assert payload["id"] == created.json()["id"]

    async def test_sign_in_returns_a_complete_token_pair(
        self,
        client: AsyncClient,
        author_user: User,
    ) -> None:
        """AAP standard 6: sign-in mints a short-lived access token and a refresh token."""
        response = await client.post(_LOGIN_URL, data=_login_form(author_user.email))

        assert response.status_code == HTTPStatus.OK, response.text
        tokens = response.json()
        _assert_token_pair(tokens)
        # The access token is a JWT and therefore has three dot-separated parts; the refresh
        # token is opaque entropy and is deliberately not inspected beyond being different.
        assert tokens["access_token"].count(".") == 2
        assert tokens["refresh_token"] != tokens["access_token"]

    async def test_the_principal_projection_adds_the_private_members(
        self,
        client: AsyncClient,
        reader_user: User,
        auth_headers_for: AuthHeaderFactory,
    ) -> None:
        """AAP R1: ``UserMe`` publishes email, role, active state and the modification instant."""
        response = await client.get(_ME_URL, headers=auth_headers_for(reader_user))

        assert response.status_code == HTTPStatus.OK, response.text
        payload = response.json()
        assert payload.keys() == _USER_ME_KEYS, payload
        assert payload.keys() >= _USER_ME_ONLY_KEYS, payload
        assert payload["email"] == reader_user.email
        assert payload["role"] == UserRole.READER.value
        assert payload["is_active"] is True
        assert isinstance(payload["updated_at"], str)
        # The private projection is still not a credential projection: no hash, and no password.
        assert "password_hash" not in payload
        assert "password" not in payload
        assert DEFAULT_PASSWORD not in _serialised(payload)

    async def test_sign_in_requires_form_encoding_and_refuses_a_json_body(
        self,
        client: AsyncClient,
        author_user: User,
    ) -> None:
        """AAP section 0.5.2: the route consumes an OAuth 2 password-grant form, not JSON."""
        as_json = await client.post(_LOGIN_URL, json=_login_form(author_user.email))

        # 422 and not 401: the grant's fields never arrived at all, so this is a malformed
        # request rather than a rejected credential. Pinned by a test because the failure looks
        # like a broken route and is in fact a broken caller.
        _assert_problem_document(as_json, HTTPStatus.UNPROCESSABLE_CONTENT)

        as_form = await client.post(_LOGIN_URL, data=_login_form(author_user.email))
        assert as_form.status_code == HTTPStatus.OK, as_form.text

    @pytest.mark.parametrize("omitted", ["username", "password"])
    async def test_sign_in_rejects_a_form_missing_a_grant_field(
        self,
        client: AsyncClient,
        author_user: User,
        omitted: str,
    ) -> None:
        """AAP section 0.9.4.3: an incomplete password grant answers 422 naming the field."""
        form = _login_form(author_user.email)
        del form[omitted]

        response = await client.post(_LOGIN_URL, data=form)

        payload = _assert_problem_document(response, HTTPStatus.UNPROCESSABLE_CONTENT)
        assert omitted in _field_names(payload)

    async def test_a_wrong_password_is_refused(
        self,
        client: AsyncClient,
        author_user: User,
    ) -> None:
        """AAP section 0.9.4.4 "Authorisation negatives": a wrong password answers 401."""
        response = await client.post(
            _LOGIN_URL,
            data=_login_form(author_user.email, _WRONG_PASSWORD),
        )

        payload = _assert_unauthorized(response)
        # The submitted password is not echoed anywhere, under any member.
        assert _WRONG_PASSWORD not in _serialised(payload)

    async def test_an_unknown_email_address_is_refused(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP section 0.9.4.4 "Authorisation negatives": an unregistered address answers 401."""
        response = await client.post(
            _LOGIN_URL,
            data=_login_form("no-such-account-here@example.com"),
        )

        _assert_unauthorized(response)

    async def test_a_wrong_password_and_an_unknown_address_are_indistinguishable(
        self,
        client: AsyncClient,
        author_user: User,
    ) -> None:
        """AAP standard 6: sign-in must not disclose which email addresses are registered."""
        wrong_password = await client.post(
            _LOGIN_URL,
            data=_login_form(author_user.email, _WRONG_PASSWORD),
        )
        unknown_address = await client.post(
            _LOGIN_URL,
            data=_login_form("still-no-such-account@example.com"),
        )

        first = _assert_unauthorized(wrong_password)
        second = _assert_unauthorized(unknown_address)
        # Byte-identical once the per-request correlation identifier is set aside. That is what
        # closes the enumeration oracle: the two failures are one answer.
        assert _without_correlation(first) == _without_correlation(second)

    async def test_an_address_that_could_never_be_registered_is_refused_as_a_credential(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP standard 6: a malformed address answers 401, not 422, so failures stay uniform."""
        response = await client.post(_LOGIN_URL, data=_login_form("not-an-email-address"))

        # 401 is deliberate. `OAuth2PasswordRequestForm.username` is an unconstrained string
        # while `LoginRequest.email` is an address, so the route guards the construction and
        # answers as it would for any other wrong credential - distinguishing "malformed" from
        # "wrong" on this one route would itself be a disclosure.
        _assert_unauthorized(response)

    async def test_a_deactivated_account_cannot_sign_in(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
    ) -> None:
        """AAP R11: a suspended account is refused with 403, because the answer will not change."""
        suspended = await create_user(db_session, is_active=False)

        response = await client.post(_LOGIN_URL, data=_login_form(suspended.email))

        # 403 and not 401: the credential is correct, so refreshing it would produce another
        # perfectly valid credential for the same suspended account and a 401 would send a
        # well-behaved client into a retry loop it could never leave.
        _assert_problem_document(response, HTTPStatus.FORBIDDEN)

    async def test_a_deactivated_account_with_a_wrong_password_is_refused_as_a_credential(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
    ) -> None:
        """AAP standard 6: the credential is checked before the account state, so 401 wins."""
        suspended = await create_user(db_session, is_active=False)

        response = await client.post(
            _LOGIN_URL,
            data=_login_form(suspended.email, _WRONG_PASSWORD),
        )

        # The ordering is the point: without a correct password a caller cannot even learn that
        # an address belongs to a suspended account, so suspension is not an oracle either.
        _assert_unauthorized(response)


# ---------------------------------------------------------------------------------------
# Phase C negatives and Phase F - what may be presented as a bearer credential
#
# Every case below is a 401 except the deactivated principal, which is a 403 for the reason
# `app.core.dependencies.get_current_active_user` documents. `GET /auth/me` is the vehicle
# throughout: it is the smallest protected route in the service, so a refusal cannot be
# confused with a validation failure on a body or a path parameter.
# ---------------------------------------------------------------------------------------


class TestBearerCredentialRejection:
    """``GET /api/v1/auth/me``: which credentials the ``Authorization`` header will accept."""

    async def test_an_absent_authorization_header_is_refused(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP section 0.9.4.4 "Authorisation negatives": no credential answers 401."""
        response = await client.get(_ME_URL)

        _assert_unauthorized(response)

    @pytest.mark.parametrize(
        "header",
        [
            pytest.param("no-scheme-at-all", id="bare-credential-with-no-scheme"),
            # Deliberately not a base64 credential. `_bearer_token` refuses on the scheme alone,
            # so nothing here needs to decode - and a placeholder that cannot be mistaken for a
            # real Basic credential keeps the file free of credential-shaped literals.
            pytest.param("Basic not-a-real-credential", id="a-different-scheme"),
            pytest.param("Bearer", id="scheme-with-nothing-after-it"),
            pytest.param("Bearer    ", id="scheme-with-only-whitespace-after-it"),
        ],
    )
    async def test_a_header_that_is_not_a_bearer_credential_is_refused(
        self,
        client: AsyncClient,
        header: str,
    ) -> None:
        """AAP standard 6: an unusable ``Authorization`` header answers 401, never 500."""
        response = await client.get(_ME_URL, headers={"Authorization": header})

        _assert_unauthorized(response)

    async def test_a_garbage_bearer_token_is_refused(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP standard 6: a value that is not a signed token at all answers 401."""
        response = await client.get(_ME_URL, headers=_bearer("not.a.real.token"))

        _assert_unauthorized(response)

    async def test_a_token_signed_with_another_key_is_refused(
        self,
        client: AsyncClient,
        author_user: User,
    ) -> None:
        """AAP standard 6: the signature is verified, so a forged token answers 401."""
        genuine = create_access_token(subject=str(author_user.id), role=author_user.role)
        # Corrupt the signature segment only, leaving the header and claims intact, so the
        # rejection can only have come from signature verification.
        header, claims, signature = genuine.split(".")
        forged = f"{header}.{claims}.{signature[::-1]}xyz"

        response = await client.get(_ME_URL, headers=_bearer(forged))

        _assert_unauthorized(response)

    async def test_a_refresh_token_is_not_accepted_as_an_access_token(
        self,
        client: AsyncClient,
        author_user: User,
    ) -> None:
        """AAP standard 6: ``decode_access_token`` refuses token-type confusion with 401."""
        tokens = await _sign_in(client, author_user.email)

        response = await client.get(_ME_URL, headers=_bearer(str(tokens["refresh_token"])))

        # The refresh token is a live credential for `POST /auth/refresh` and must buy nothing
        # anywhere else. It is opaque entropy rather than a JWT, and even a genuine token
        # carrying `type != "access"` would be refused by the same check.
        _assert_unauthorized(response)

    async def test_an_expired_access_token_is_refused(
        self,
        client: AsyncClient,
        author_user: User,
    ) -> None:
        """AAP section 0.9.4.4 "Token lifecycle": an expired access token answers 401 over HTTP."""
        expired = create_access_token(
            subject=str(author_user.id),
            role=author_user.role,
            # A negative lifetime puts `exp` behind `iat`, so the token is already past its
            # expiry the moment it is minted - no waiting, and no clock manipulation.
            expires_delta=timedelta(minutes=-5),
        )

        response = await client.get(_ME_URL, headers=_bearer(expired))

        # The primitive's expiry behaviour is asserted by `tests/unit/test_security.py`; what is
        # asserted here is the HTTP consequence, which is the part a client observes.
        _assert_unauthorized(response)

    async def test_a_token_naming_an_account_that_does_not_exist_is_refused(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP standard 6: a correctly signed token for a deleted account answers 401."""
        orphaned = create_access_token(subject=str(uuid.uuid4()), role=UserRole.READER)

        response = await client.get(_ME_URL, headers=_bearer(orphaned))

        _assert_unauthorized(response)

    async def test_a_token_for_a_deactivated_account_is_refused(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        auth_headers_for: AuthHeaderFactory,
    ) -> None:
        """AAP R11: deactivation is enforced per request, so a live token stops working at 403."""
        suspended = await create_user(db_session, is_active=False)

        response = await client.get(_ME_URL, headers=auth_headers_for(suspended))

        # 403 rather than 401, and enforced on every authenticated operation rather than only at
        # sign-in: an access token already in circulation would otherwise keep working until it
        # expired, which is exactly the window suspension exists to close.
        _assert_problem_document(response, HTTPStatus.FORBIDDEN)


# ---------------------------------------------------------------------------------------
# Phase D - rotation, and reuse detection
#
# `POST /auth/refresh` takes a JSON body - note the asymmetry with `/auth/login`, which does
# not - and needs no access token, because the refresh token is itself the credential. The
# token is opaque `secrets.token_urlsafe` entropy persisted only as a SHA-256 digest, so
# nothing below decodes it or reads it back out of the database: every assertion is made by
# presenting it and observing what the route answers.
# ---------------------------------------------------------------------------------------


class TestRefreshRotation:
    """``POST /api/v1/auth/refresh``: single-use rotation, and what happens when one is replayed."""

    async def test_rotation_returns_a_new_complete_pair(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP section 0.9.4.4 "Token lifecycle": spending a refresh token yields a new pair."""
        _, tokens = await _registered_session(client)

        response = await client.post(
            _REFRESH_URL,
            json={"refresh_token": tokens["refresh_token"]},
        )

        assert response.status_code == HTTPStatus.OK, response.text
        _assert_token_pair(response.json())

    async def test_rotation_replaces_the_presented_refresh_token(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP standard 6: the refresh token *rotates* - the value that comes back is different."""
        _, tokens = await _registered_session(client)
        presented = str(tokens["refresh_token"])

        response = await client.post(_REFRESH_URL, json={"refresh_token": presented})

        assert response.status_code == HTTPStatus.OK, response.text
        rotated = response.json()
        _assert_token_pair(rotated)
        # Rotation, stated positively. A route that returned the same value would satisfy every
        # other assertion in this class except this one.
        assert rotated["refresh_token"] != presented
        # The refresh token is 32 bytes of CSPRNG output, so a fresh one shares no prefix with
        # the value it replaced - which distinguishes a genuinely new credential from a derived
        # or incremented one.
        assert not str(rotated["refresh_token"]).startswith(presented[: len(presented) // 2])

        # The ACCESS token is deliberately not asserted to differ. It is an HS256 signature over
        # `sub`, `role`, `iat`, `exp` and `type`, and `iat`/`exp` are whole seconds, so a
        # rotation performed in the same second as the sign-in produces byte-identical claims
        # and therefore a byte-identical token. That is correct - the token is a signed assertion
        # about a principal, not a nonce - and asserting inequality here would be a clock race
        # that fails only sometimes. What matters is that it is a usable credential, which
        # `test_the_rotated_access_token_authenticates` establishes by presenting it.
        assert str(rotated["access_token"]).count(".") == 2

    async def test_the_rotated_access_token_authenticates(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP section 0.9.4.4 "Token lifecycle": the pair rotation issues is immediately usable."""
        body, tokens = await _registered_session(client)

        rotated = await client.post(
            _REFRESH_URL,
            json={"refresh_token": tokens["refresh_token"]},
        )
        assert rotated.status_code == HTTPStatus.OK, rotated.text

        principal = await client.get(
            _ME_URL,
            headers=_bearer(str(rotated.json()["access_token"])),
        )

        assert principal.status_code == HTTPStatus.OK, principal.text
        assert principal.json()["email"] == body["email"]

    async def test_rotation_needs_no_access_token(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP R1: the refresh token is itself the credential, so no bearer header is required."""
        _, tokens = await _registered_session(client)

        # Sent with no `Authorization` header at all. This is what lets a client whose access
        # token has already expired recover without signing in again - if this route required a
        # live access token, the refresh mechanism would be useless exactly when it is needed.
        response = await client.post(
            _REFRESH_URL,
            json={"refresh_token": tokens["refresh_token"]},
        )

        assert response.status_code == HTTPStatus.OK, response.text

    async def test_the_spent_refresh_token_is_refused(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP section 0.9.4.4 "Token lifecycle": a refresh token is single-use; a replay is 401."""
        _, tokens = await _registered_session(client)
        spent = str(tokens["refresh_token"])

        first = await client.post(_REFRESH_URL, json={"refresh_token": spent})
        assert first.status_code == HTTPStatus.OK, first.text

        replay = await client.post(_REFRESH_URL, json={"refresh_token": spent})

        _assert_unauthorized(replay)

    async def test_replaying_a_spent_token_revokes_the_whole_token_family(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP standard 6: reuse is read as theft, so every token the account holds dies."""
        _, tokens = await _registered_session(client)
        token_a = str(tokens["refresh_token"])

        rotated = await client.post(_REFRESH_URL, json={"refresh_token": token_a})
        assert rotated.status_code == HTTPStatus.OK, rotated.text
        token_b = str(rotated.json()["refresh_token"])

        # A is now spent. Presenting it again is either a leak or a client replaying, and the
        # service cannot tell those apart - so it takes the hostile reading.
        replay = await client.post(_REFRESH_URL, json={"refresh_token": token_a})
        _assert_unauthorized(replay)

        # The stronger guarantee, and the whole point of this test: B was perfectly valid a
        # moment ago and is now dead too. An attacker holding a stolen token loses it, and the
        # legitimate holder simply signs in again.
        successor = await client.post(_REFRESH_URL, json={"refresh_token": token_b})
        _assert_unauthorized(successor)

    async def test_a_refresh_token_that_was_never_issued_is_refused(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP section 0.9.4.4 "Authorisation negatives": an unknown refresh token answers 401."""
        response = await client.post(
            _REFRESH_URL,
            json={"refresh_token": _UNISSUED_REFRESH_TOKEN},
        )

        _assert_unauthorized(response)

    async def test_an_expired_refresh_token_is_refused(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
    ) -> None:
        """AAP section 0.9.4.4 "Token lifecycle": a lapsed refresh token answers 401."""
        lapsed, _row = await create_refresh_token(
            db_session,
            user=author_user,
            # Timezone-aware, because `refresh_tokens.expires_at` is `timestamptz`: a naive
            # value would be read against the server's session time zone and could land in the
            # future on a machine configured differently from this one.
            expires_at=datetime.now(tz=UTC) - timedelta(days=1),
        )

        response = await client.post(_REFRESH_URL, json={"refresh_token": lapsed})

        _assert_unauthorized(response)

    async def test_a_revoked_refresh_token_is_refused(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        author_user: User,
    ) -> None:
        """AAP section 0.9.4.4 "Token lifecycle": a withdrawn refresh token answers 401."""
        revoked, _row = await create_refresh_token(
            db_session,
            user=author_user,
            revoked_at=datetime.now(tz=UTC) - timedelta(minutes=1),
        )

        response = await client.post(_REFRESH_URL, json={"refresh_token": revoked})

        _assert_unauthorized(response)

    async def test_a_refresh_token_belonging_to_a_deactivated_account_is_refused(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
    ) -> None:
        """AAP R11: suspending an account stops its outstanding refresh tokens from rotating."""
        suspended = await create_user(db_session, is_active=False)
        live, _row = await create_refresh_token(db_session, user=suspended)

        response = await client.post(_REFRESH_URL, json={"refresh_token": live})

        # 401 here rather than the 403 sign-in answers, and deliberately: whether the account
        # was suspended or deleted outright is not the caller's business on a route whose only
        # credential is an opaque token.
        _assert_unauthorized(response)

    async def test_a_missing_refresh_token_member_is_rejected_as_invalid(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP section 0.9.4.3: an absent body member answers 422 with the member named."""
        response = await client.post(_REFRESH_URL, json={})

        payload = _assert_problem_document(response, HTTPStatus.UNPROCESSABLE_CONTENT)
        assert "refresh_token" in _field_names(payload)
        assert any(entry["type"] == "missing" for entry in payload["errors"])

    async def test_a_blank_refresh_token_is_rejected_as_invalid(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP section 0.9.4.3: an empty token cannot be a credential, so it answers 422."""
        response = await client.post(_REFRESH_URL, json={"refresh_token": ""})

        payload = _assert_problem_document(response, HTTPStatus.UNPROCESSABLE_CONTENT)
        assert "refresh_token" in _field_names(payload)

    async def test_surrounding_whitespace_on_a_refresh_token_is_tolerated(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP R8: the schema strips whitespace, so a token pasted with a stray space works."""
        _, tokens = await _registered_session(client)

        response = await client.post(
            _REFRESH_URL,
            json={"refresh_token": f"  {tokens['refresh_token']}  "},
        )

        # Stripping cannot alter a valid token - the issued alphabet contains no whitespace -
        # and it turns a copy-paste artefact into a working request rather than a 401.
        assert response.status_code == HTTPStatus.OK, response.text
        _assert_token_pair(response.json())


# ---------------------------------------------------------------------------------------
# Phase E - signing out
#
# `POST /auth/logout` needs both credentials: a valid access token in the header, naming the
# principal, and the refresh token in the JSON body, naming the session to end. It answers 204
# with an empty body in every accepted case, including the ones where it does nothing.
# ---------------------------------------------------------------------------------------


class TestSignOut:
    """``POST /api/v1/auth/logout``: revocation, idempotence, and what a replay escalates to."""

    async def test_signing_out_answers_no_content_with_an_empty_body(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP section 0.9.4.4 "Token lifecycle": sign-out answers 204 and returns nothing."""
        _, tokens = await _registered_session(client)

        response = await client.post(
            _LOGOUT_URL,
            json={"refresh_token": tokens["refresh_token"]},
            headers=_bearer(str(tokens["access_token"])),
        )

        assert response.status_code == HTTPStatus.NO_CONTENT, response.text
        assert response.content == b""

    async def test_the_revoked_refresh_token_can_no_longer_be_rotated(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP section 0.9.4.4 "Token lifecycle": logout revokes it, so refresh answers 401."""
        _, tokens = await _registered_session(client)
        refresh_token = str(tokens["refresh_token"])

        signed_out = await client.post(
            _LOGOUT_URL,
            json={"refresh_token": refresh_token},
            headers=_bearer(str(tokens["access_token"])),
        )
        assert signed_out.status_code == HTTPStatus.NO_CONTENT, signed_out.text

        rotation = await client.post(_REFRESH_URL, json={"refresh_token": refresh_token})

        _assert_unauthorized(rotation)

    async def test_signing_out_requires_an_access_token(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP standard 6: sign-out is a protected operation, so an anonymous caller gets 401."""
        _, tokens = await _registered_session(client)

        response = await client.post(
            _LOGOUT_URL,
            json={"refresh_token": tokens["refresh_token"]},
        )

        _assert_unauthorized(response)

        # And the omission was not merely unreported: the token is still exchangeable, so the
        # refused request changed nothing.
        rotation = await client.post(
            _REFRESH_URL,
            json={"refresh_token": tokens["refresh_token"]},
        )
        assert rotation.status_code == HTTPStatus.OK, rotation.text

    async def test_signing_out_with_an_unknown_token_is_accepted_and_does_nothing(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP R8: sign-out is idempotent; reporting otherwise would disclose token state."""
        _, tokens = await _registered_session(client)

        response = await client.post(
            _LOGOUT_URL,
            json={"refresh_token": _UNISSUED_REFRESH_TOKEN},
            headers=_bearer(str(tokens["access_token"])),
        )

        # Accepted, so a retried request, a second browser tab or a client signing out twice all
        # succeed - and nothing about whether that token exists is disclosed either way.
        assert response.status_code == HTTPStatus.NO_CONTENT, response.text
        # Inert, too: the caller's own session is untouched by signing out a token it does not own.
        rotation = await client.post(
            _REFRESH_URL,
            json={"refresh_token": tokens["refresh_token"]},
        )
        assert rotation.status_code == HTTPStatus.OK, rotation.text

    async def test_a_missing_refresh_token_member_is_rejected_as_invalid(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP section 0.9.4.3: sign-out needs the token in the body, so an empty body is 422."""
        _, tokens = await _registered_session(client)

        response = await client.post(
            _LOGOUT_URL,
            json={},
            headers=_bearer(str(tokens["access_token"])),
        )

        payload = _assert_problem_document(response, HTTPStatus.UNPROCESSABLE_CONTENT)
        assert "refresh_token" in _field_names(payload)

    async def test_signing_out_ends_only_its_own_session(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP R1: an ordinary sign-out leaves the account's other sessions exchangeable."""
        body, first_session = await _registered_session(client)
        second_session = await _sign_in(client, str(body["email"]))

        signed_out = await client.post(
            _LOGOUT_URL,
            json={"refresh_token": first_session["refresh_token"]},
            headers=_bearer(str(first_session["access_token"])),
        )
        assert signed_out.status_code == HTTPStatus.NO_CONTENT, signed_out.text

        # Signing out on a phone must not sign the same account out on a laptop. The token
        # presented had not been revoked yet, so the replay rule below is not reached.
        survivor = await client.post(
            _REFRESH_URL,
            json={"refresh_token": second_session["refresh_token"]},
        )

        assert survivor.status_code == HTTPStatus.OK, survivor.text

    async def test_presenting_an_already_revoked_token_ends_every_session(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP standard 6: a replayed sign-out is read as theft and revokes the whole family."""
        body, first_session = await _registered_session(client)
        headers = _bearer(str(first_session["access_token"]))
        refresh_token = str(first_session["refresh_token"])

        first = await client.post(
            _LOGOUT_URL, json={"refresh_token": refresh_token}, headers=headers
        )
        assert first.status_code == HTTPStatus.NO_CONTENT, first.text

        # A session opened after the first sign-out, so it is genuinely outstanding when the
        # replay arrives.
        later_session = await _sign_in(client, str(body["email"]))

        replay = await client.post(
            _LOGOUT_URL, json={"refresh_token": refresh_token}, headers=headers
        )

        # Still 204 - nothing about the token's state is disclosed - but not inert: whatever
        # token succeeded the presented one is what is keeping the session alive, so ending the
        # family is what makes the request mean what it says.
        assert replay.status_code == HTTPStatus.NO_CONTENT, replay.text
        successor = await client.post(
            _REFRESH_URL,
            json={"refresh_token": later_session["refresh_token"]},
        )
        _assert_unauthorized(successor)

    async def test_the_access_token_remains_usable_until_it_expires(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP standard 6: documents by assertion that sign-out cannot withdraw an access token.

        This is the design and not an oversight. An access token is a signed assertion with no
        server-side record, so there is nothing to revoke: ``AuthService.logout`` withdraws the
        *refresh* token, which is what stops the session from being extended. The access token
        therefore keeps working for the remainder of its short lifetime, and a client must
        discard its copy locally. Asserted here so the behaviour is pinned and explained rather
        than looking like a gap in the revocation story - and paired with the refresh assertion,
        which is where revocation is actually observable.
        """
        _, tokens = await _registered_session(client)
        headers = _bearer(str(tokens["access_token"]))

        signed_out = await client.post(
            _LOGOUT_URL,
            json={"refresh_token": tokens["refresh_token"]},
            headers=headers,
        )
        assert signed_out.status_code == HTTPStatus.NO_CONTENT, signed_out.text

        still_valid = await client.get(_ME_URL, headers=headers)
        rotation = await client.post(
            _REFRESH_URL,
            json={"refresh_token": tokens["refresh_token"]},
        )

        assert still_valid.status_code == HTTPStatus.OK, still_valid.text
        # The session cannot be extended, which is the part revocation is responsible for.
        _assert_unauthorized(rotation)


# ---------------------------------------------------------------------------------------
# Phase G - the limiter, from both sides
#
# All five credential routes carry `@auth_rate_limit`, and `app.core.rate_limit` builds the
# limiter with `enabled=settings.ENVIRONMENT != "test"`. `backend/tests/conftest.py` sets
# ENVIRONMENT=test in its pre-import bootstrap, so the limit is off for the whole suite - which
# is what lets this module register, sign in, rotate and sign out dozens of times without
# tripping the five-per-minute allowance and turning a blocking gate flaky.
#
# TWO things therefore have to be asserted, and asserting only the first is what left the
# control untested. `TestRateLimitingIsDisabledUnderTest` pins the *exemption*, because that is
# the arrangement the rest of the suite silently depends on: remove it and those tests fail by
# name instead of the suite becoming intermittently red somewhere else entirely.
# `TestRateLimitingEnforcement` pins the *control*, by switching the real limiter on for the
# duration of one test. Without it, removing `@auth_rate_limit` from every route, breaking the
# bucket arithmetic, answering the 429 with slowapi's own body instead of the problem document,
# or dropping `Retry-After` all left this module green - the exemption test would have passed
# more easily, not less.
# ---------------------------------------------------------------------------------------


class TestTokenOwnershipAndCaching:
    """Two properties of the credential routes that are invisible in a happy-path body.

    Both are about what a token response *permits* rather than what it contains: who may act on a
    refresh token, and who may store one.
    """

    async def test_a_caller_cannot_revoke_another_accounts_refresh_token(
        self, client: AsyncClient
    ) -> None:
        """Sign-out ignores a refresh token belonging to someone else, and says nothing about it.

        The token names its own row, so before the principal was consulted this route revoked
        whatever row the presented digest matched. Holding an account of one's own was the only
        requirement, and the account whose session ended was chosen by the caller - the digest was
        in effect a parameter naming the victim.

        Both halves are asserted, because either alone would pass for the wrong reason. The
        attacker must receive ``204``, so nothing is disclosed about whose token it was or whether
        it existed; and the victim's token must **still rotate afterwards**, which is the only
        proof the revocation did not happen. A test that checked the status alone would pass
        against the defective behaviour, since that answered ``204`` too - while destroying the
        victim's session.
        """
        _, victim_tokens = await _registered_session(client)
        _, attacker_tokens = await _registered_session(client)

        response = await client.post(
            _LOGOUT_URL,
            json={"refresh_token": victim_tokens["refresh_token"]},
            headers=_bearer(str(attacker_tokens["access_token"])),
        )

        assert response.status_code == HTTPStatus.NO_CONTENT, response.text
        assert response.content == b""

        rotation = await client.post(
            _REFRESH_URL, json={"refresh_token": victim_tokens["refresh_token"]}
        )
        assert rotation.status_code == HTTPStatus.OK, (
            "the victim's refresh token was revoked by a caller who did not own it"
        )
        _assert_token_pair(rotation.json())

    async def test_a_caller_cannot_trigger_a_family_sweep_with_another_accounts_stale_token(
        self, client: AsyncClient
    ) -> None:
        """The escalation path: a *revoked* foreign token must not end the victim's other sessions.

        This is the sharp edge of the finding rather than the blunt one. Presenting an
        already-revoked refresh token is read as a replay and revokes **every** token the owning
        account holds - a protection when the owner presents it, and a weapon when anyone else
        does. So an attacker did not even need a live token of the victim's: one stale digest,
        captured or left behind by an earlier sign-out, could end every session that victim had
        open, on every device, as often as the attacker cared to repeat it.

        The victim therefore holds two sessions here. The first is signed out, which revokes its
        token and makes it the stale specimen; the second must survive the attacker presenting
        that specimen.
        """
        victim, first_session = await _registered_session(client)
        second_session = await _sign_in(client, str(victim["email"]))

        signed_out = await client.post(
            _LOGOUT_URL,
            json={"refresh_token": first_session["refresh_token"]},
            headers=_bearer(str(first_session["access_token"])),
        )
        assert signed_out.status_code == HTTPStatus.NO_CONTENT, signed_out.text

        _, attacker_tokens = await _registered_session(client)

        replayed = await client.post(
            _LOGOUT_URL,
            json={"refresh_token": first_session["refresh_token"]},
            headers=_bearer(str(attacker_tokens["access_token"])),
        )
        assert replayed.status_code == HTTPStatus.NO_CONTENT, replayed.text

        rotation = await client.post(
            _REFRESH_URL, json={"refresh_token": second_session["refresh_token"]}
        )
        assert rotation.status_code == HTTPStatus.OK, (
            "an attacker replaying the victim's stale token swept the victim's live sessions"
        )

    async def test_the_owner_can_still_sweep_their_own_family_with_a_stale_token(
        self, client: AsyncClient
    ) -> None:
        """The protection the ownership check must not remove.

        The counterpart to the test above, and the reason this is an ownership check rather than a
        removal of the sweep. When the account's **own** holder presents a token that has already
        been revoked, that is still evidence of a leak or a replay, and it must still end every
        session the account holds - otherwise the successor token stays live and the sign-out the
        caller asked for did not happen.
        """
        victim, first_session = await _registered_session(client)
        second_session = await _sign_in(client, str(victim["email"]))

        for _ in range(2):
            # Twice: the first revokes the token, the second presents it while revoked, which is
            # the replay that escalates to the family sweep.
            signed_out = await client.post(
                _LOGOUT_URL,
                json={"refresh_token": first_session["refresh_token"]},
                headers=_bearer(str(first_session["access_token"])),
            )
            assert signed_out.status_code == HTTPStatus.NO_CONTENT, signed_out.text

        rotation = await client.post(
            _REFRESH_URL, json={"refresh_token": second_session["refresh_token"]}
        )
        _assert_unauthorized(rotation)

    async def test_the_lifespan_warms_the_dummy_hash_before_the_first_request(self) -> None:
        """Startup performs the warm-up, which is what makes the parity below true in production.

        The parity test that follows establishes what the login path costs *once the hash exists*.
        This one establishes that it exists before any client can ask - because the warm-up is
        worth nothing if it is only ever performed lazily by the first unknown-email login, which
        is precisely the request that would then pay for it.

        The lifespan is driven directly rather than through the suite's client, because
        ``ASGITransport`` deliberately runs no lifespan events: this is the one property in this
        module that belongs to startup rather than to a route, so it is asserted against startup.
        """
        from app.core.security import dummy_password_hash
        from app.main import app, lifespan

        dummy_password_hash.cache_clear()
        assert dummy_password_hash.cache_info().currsize == 0

        async with lifespan(app):
            assert dummy_password_hash.cache_info().currsize == 1, (
                "startup completed without warming the dummy hash, so the first unknown-email "
                "login this process serves pays a full argon2 hash that a known-email login does "
                "not - a difference one request is enough to measure"
            )

    async def test_a_cold_unknown_email_login_costs_the_same_argon2_work_as_a_known_one(
        self, client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """First-attempt parity: neither branch computes a hash, and both perform one verify.

        The timing oracle this closes is a user-enumeration one - "is this address registered?" -
        and the previous tests could not see it, because they ran after something had already
        warmed the stand-in hash. Reconstructing the cold state is therefore the whole setup:
        the cache is cleared, then warmed exactly as ``app.main.lifespan`` warms it, and only then
        are the two branches compared.

        Argon2 **operations are counted rather than time measured**, deliberately. A timing
        assertion on a shared runner is flaky, and it would also be indirect: what made the two
        paths distinguishable was one branch performing an extra ``hash`` - a whole work factor -
        so counting calls proves the absence of that work exactly, with no tolerance to tune. Both
        branches must show zero hashes and one verify: zero, because the stand-in is already
        computed, and one, because a branch that skipped the verify would be the fast answer that
        reveals an address is unregistered.
        """
        from app.core import security

        body, _ = await _registered_session(client)

        counts = {"hash": 0, "verify": 0}
        real_hash = security._PASSWORD_HASHER.hash
        real_verify = security._PASSWORD_HASHER.verify

        def counting_hash(password: Any, **kwargs: Any) -> str:
            counts["hash"] += 1
            return real_hash(password, **kwargs)

        def counting_verify(password: Any, hash: Any) -> bool:
            counts["verify"] += 1
            return real_verify(password, hash)

        # Cleared and re-warmed BEFORE the counters are attached, so the warm-up's own hash is not
        # counted - what is under test is what a *request* costs, not what startup costs.
        security.dummy_password_hash.cache_clear()
        security.warm_password_hashing()

        monkeypatch.setattr(security._PASSWORD_HASHER, "hash", counting_hash)
        monkeypatch.setattr(security._PASSWORD_HASHER, "verify", counting_verify)

        unknown = await client.post(
            _LOGIN_URL, data=_login_form("no-such-account@example.com", "Wrong-Password-12345")
        )
        _assert_unauthorized(unknown)
        unknown_counts = dict(counts)

        counts["hash"] = 0
        counts["verify"] = 0

        wrong_password = await client.post(
            _LOGIN_URL, data=_login_form(str(body["email"]), "Wrong-Password-12345")
        )
        _assert_unauthorized(wrong_password)
        known_counts = dict(counts)

        assert unknown_counts == {"hash": 0, "verify": 1}, (
            f"the unknown-email branch performed {unknown_counts}, so its cost differs from a "
            "known-email refusal and the route reports whether an address is registered"
        )
        assert known_counts == {"hash": 0, "verify": 1}, (
            f"the known-email branch performed {known_counts}"
        )
        assert unknown_counts == known_counts

    @pytest.mark.parametrize("route", ["login", "refresh"], ids=["login", "refresh"])
    async def test_a_token_response_forbids_being_stored(
        self, client: AsyncClient, route: str
    ) -> None:
        """Both token-minting responses carry ``no-store`` and the HTTP/1.0 ``Pragma`` spelling.

        These two responses are the most sensitive bodies this service produces - an access token
        and a refresh token in plaintext - and they are the only ones whose *request* carries no
        ``Authorization`` header. That combination is the finding: HTTP's own rule that a shared
        cache must not store a response to an authenticated request does not apply to them, so a
        corporate proxy, a CDN or a browser disk cache was free to keep a copy of a credential.

        ``no-store`` is the directive that matters, and it is asserted by name rather than by
        checking the header is merely present, because ``no-cache`` alone would permit storage
        with revalidation - which for a bearer token is not a weaker guarantee but no guarantee.
        """
        body, tokens = await _registered_session(client)

        if route == "login":
            response = await client.post(_LOGIN_URL, data=_login_form(str(body["email"])))
        else:
            response = await client.post(
                _REFRESH_URL, json={"refresh_token": tokens["refresh_token"]}
            )

        assert response.status_code == HTTPStatus.OK, response.text
        _assert_token_pair(response.json())

        cache_control = response.headers.get("cache-control", "")
        assert "no-store" in cache_control, (
            f"{route} answered with Cache-Control {cache_control!r}, which does not forbid "
            "storing a response that carries a refresh token"
        )
        assert "private" in cache_control, (
            f"{route} answered with Cache-Control {cache_control!r}, so a shared cache is not "
            "told the body belongs to one user"
        )
        assert response.headers.get("pragma") == "no-cache", (
            f"{route} omitted the HTTP/1.0 Pragma spelling, which intermediaries too old to "
            "honour Cache-Control still consult"
        )


class TestTokenRevocationSerialisation:
    """Revocation and issuance are serialised per account, proved across real transactions.

    **Why these tests cannot use the suite's usual fixtures.** Every other test in this module
    drives the API through one session inside one transaction that is rolled back at the end, which
    is exactly the right shape for asserting behaviour and exactly the wrong shape for asserting
    *concurrency*: two requests sharing a transaction cannot race, and nothing they do is ever
    visible to a second connection. The defect these tests cover was invisible for that reason -
    the paths were only ever exercised sequentially, so the interleaving that loses a revocation
    could not occur.

    So each test below opens **two independent sessions** on the suite's ``NullPool`` engine, which
    hands out a fresh connection per checkout, and commits for real. Each creates the account it
    needs and removes it in a ``finally``; the cascade on ``users`` takes the tokens with it, so
    nothing survives into another test.

    **The interleaving is enforced by PostgreSQL rather than by timing.** One session takes the
    account lock and holds it, which is precisely the state an in-flight rotation is in between
    spending a token and inserting its successor. The other session then runs the operation under
    test and *must block*. Nothing depends on which task the event loop happens to schedule first,
    and the outcome assertions fail closed: if the lock is not taken, the second operation runs to
    completion against a stale view and the final assertion about what is live catches it.
    """

    @staticmethod
    def _sessions(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
        """A maker for independent sessions that COMMIT, unlike the transactional fixture."""
        return async_sessionmaker(engine, expire_on_commit=False, autoflush=False)

    async def test_a_sweep_waits_for_an_in_flight_rotation_and_then_revokes_its_successor(
        self, engine: AsyncEngine
    ) -> None:
        """A sign-out cannot finish while a rotation is mid-flight, and it revokes what it inserts.

        The interleaving that used to leave an account holding a live credential after a request
        whose entire purpose was to leave it holding none:

        1. a rotation spends ``T1`` - marking it revoked - and is about to insert its successor
           ``T2``;
        2. a sign-out presenting ``T1`` reads it as *not yet* revoked, because its snapshot predates
           the rotation, and so revokes that one row and leaves every other session alone;
        3. the rotation commits ``T2``.

        Both transactions succeed and ``T2`` is live. The sign-out reported ``204`` and the session
        it was asked to end is still usable. No lock over the token rows could have prevented it:
        the row that defeats the sweep is the one added afterwards, so the thing that has to be
        locked is the account, which is stable.

        Two separate properties are therefore under test, and the scenario needs both to pass.
        The sign-out must **block** on the account lock rather than proceeding on its stale view;
        and once through, it must **re-read** the presented token, see that it has been spent in the
        meantime, and treat that as the replay it is - which is what escalates to the family sweep
        and takes ``T2`` with it. Deciding from the pre-lock snapshot would revoke only ``T1``,
        which is already revoked, and achieve nothing at all.

        The rotation's exact position is reproduced: the account row locked, ``T1`` claimed, ``T2``
        inserted, nothing committed.
        """
        maker = self._sessions(engine)
        owner_id: uuid.UUID | None = None

        try:
            async with maker() as setup:
                owner = await factories.create_user(setup, role=UserRole.AUTHOR)
                await setup.commit()
                owner_id = owner.id
                first_hash = hash_refresh_token("race-original-refresh-token")
                await RefreshTokenRepository(setup).create(
                    user_id=owner_id,
                    token_hash=first_hash,
                    expires_at=refresh_token_expires_at(),
                )
                await setup.commit()

            async with maker() as rotating, maker() as sweeping:
                # The in-flight rotation, in the order the service performs it: lock the account,
                # spend the presented token, insert the successor - and commit none of it yet.
                rotating_tokens = RefreshTokenRepository(rotating)
                locked = await UserRepository(rotating).get_by_id(owner_id, for_update=True)
                assert locked is not None
                spent = await rotating_tokens.claim(first_hash)
                assert spent is not None, "the rotation could not spend the token it was given"
                await rotating_tokens.create(
                    user_id=owner_id,
                    token_hash=hash_refresh_token("race-successor-refresh-token"),
                    expires_at=refresh_token_expires_at(),
                )

                sweeper = await sweeping.scalar(select(User).where(User.id == owner_id))
                assert sweeper is not None
                sweep = asyncio.create_task(
                    AuthService(sweeping).logout("race-original-refresh-token", actor=sweeper)
                )

                # It must not be able to finish. A blocked lock never completes however long this
                # waits, so the timeout is a floor on the evidence rather than a guess at a
                # duration - and if the lock is absent the task completes at once and this fails.
                with pytest.raises(asyncio.TimeoutError):
                    await asyncio.wait_for(asyncio.shield(sweep), timeout=1.0)

                await rotating.commit()
                await sweep

            async with maker() as verify:
                live = await verify.scalars(
                    select(RefreshToken).where(
                        RefreshToken.user_id == owner_id, RefreshToken.revoked_at.is_(None)
                    )
                )
                remaining = list(live)

            assert remaining == [], (
                "the sign-out completed while a rotation's successor was still pending, so the "
                "account is left holding a live refresh token after being signed out"
            )
        finally:
            if owner_id is not None:
                async with maker() as cleanup:
                    await cleanup.execute(delete(User).where(User.id == owner_id))
                    await cleanup.commit()

    async def test_a_rotation_takes_the_account_lock_before_it_spends_anything(
        self, engine: AsyncEngine
    ) -> None:
        """Rotation asks for the account lock, and asks for it *before* claiming a token.

        This is the half of the protocol that the two outcome tests cannot reach, and leaving it
        unasserted would leave the whole thing resting on nothing. The reason is subtle: a sweep
        already blocks on the *row* lock of whichever token a rotation has spent, so an interleaving
        test can pass while the rotation itself holds no account lock at all. It would still be
        broken, and in the direction that matters most.

        Consider a rotation that claims ``T1`` and inserts ``T2`` while holding no account lock. A
        sweep starts, takes the account lock unopposed, and issues its bulk ``UPDATE``. That
        statement blocks on ``T1``'s row lock, waits for the rotation to commit, then re-evaluates
        ``T1`` - now revoked, so skipped - and never considers ``T2`` at all, because ``T2`` was
        inserted after the statement's snapshot was taken. The sweep reports success and the
        successor is live. Blocking on a token row is not the same as being serialised with the
        writer that adds one.

        So the assertion is made structurally instead of through an outcome: a second transaction
        holds the account lock and touches nothing else, and the rotation must be unable to proceed.
        Nothing but the account lock can be what stops it - the token row it would claim is
        untouched by the other transaction - so if it completes, it never asked for the lock.
        """
        maker = self._sessions(engine)
        owner_id: uuid.UUID | None = None

        try:
            async with maker() as setup:
                owner = await factories.create_user(setup, role=UserRole.AUTHOR)
                await setup.commit()
                owner_id = owner.id
                await RefreshTokenRepository(setup).create(
                    user_id=owner_id,
                    token_hash=hash_refresh_token("lock-order-probe-token"),
                    expires_at=refresh_token_expires_at(),
                )
                await setup.commit()

            async with maker() as holder, maker() as rotating:
                # The account lock and NOTHING else. No token row is read, updated or inserted, so
                # this transaction conflicts with the rotation on exactly one object.
                held = await UserRepository(holder).get_by_id(owner_id, for_update=True)
                assert held is not None

                rotation = asyncio.create_task(
                    AuthService(rotating).rotate_refresh_token("lock-order-probe-token")
                )

                with pytest.raises(asyncio.TimeoutError):
                    await asyncio.wait_for(asyncio.shield(rotation), timeout=1.0)

                # Released without writing anything, so the rotation is free to succeed on its own
                # terms - which it must, or this test would be asserting that the lock breaks
                # rotation rather than that it orders it.
                await holder.rollback()

                pair = await rotation
                assert pair.access_token
                assert pair.refresh_token != "lock-order-probe-token"
        finally:
            if owner_id is not None:
                async with maker() as cleanup:
                    await cleanup.execute(delete(User).where(User.id == owner_id))
                    await cleanup.commit()

    async def test_a_rotation_waits_for_a_deactivation_and_then_refuses(
        self, engine: AsyncEngine
    ) -> None:
        """A suspension cannot be outrun by a rotation, so no successor survives it.

        The administrative half of the same race. Deactivation withdraws the account's tokens
        precisely so that they cannot lie dormant as live credentials and spring back when the
        account is restored - and a rotation committing beside it defeated that, because it spent a
        token the sweep had revoked in a snapshot taken before the sweep and inserted a successor
        the sweep had already passed. The account ended up suspended with a working credential, and
        reactivating it reinstated a session nobody had signed into.

        The suspension is held mid-flight here: the account row is locked, ``is_active`` is false
        and the sweep has run, none of it committed. The rotation must block, and once the
        suspension commits it must refuse - the token it holds was revoked by that sweep - and
        leave no new row behind.
        """
        maker = self._sessions(engine)
        owner_id: uuid.UUID | None = None

        try:
            async with maker() as setup:
                owner = await factories.create_user(setup, role=UserRole.AUTHOR)
                await setup.commit()
                owner_id = owner.id
                await RefreshTokenRepository(setup).create(
                    user_id=owner_id,
                    token_hash=hash_refresh_token("deactivation-race-token"),
                    expires_at=refresh_token_expires_at(),
                )
                await setup.commit()

            async with maker() as suspending, maker() as rotating:
                locked = await UserRepository(suspending).get_by_id(owner_id, for_update=True)
                assert locked is not None
                locked.is_active = False
                await suspending.flush()
                await RefreshTokenRepository(suspending).revoke_all_for_user(owner_id)

                rotation = asyncio.create_task(
                    AuthService(rotating).rotate_refresh_token("deactivation-race-token")
                )

                with pytest.raises(asyncio.TimeoutError):
                    await asyncio.wait_for(asyncio.shield(rotation), timeout=1.0)

                await suspending.commit()

                with pytest.raises(UnauthorizedError):
                    await rotation

            async with maker() as verify:
                live = await verify.scalars(
                    select(RefreshToken).where(
                        RefreshToken.user_id == owner_id, RefreshToken.revoked_at.is_(None)
                    )
                )
                remaining = list(live)

            assert remaining == [], (
                "a rotation outran a suspension and left the deactivated account holding a live "
                "refresh token, which would be usable again the moment it is reactivated"
            )
        finally:
            if owner_id is not None:
                async with maker() as cleanup:
                    await cleanup.execute(delete(User).where(User.id == owner_id))
                    await cleanup.commit()

    async def test_a_rotation_locks_the_account_before_it_touches_a_token_row(
        self, engine: AsyncEngine
    ) -> None:
        """The account row is locked **first**, which is what makes the protocol deadlock-free.

        The test above proves the rotation takes the lock; this one proves *when*. The distinction
        is not pedantry, and it is the one property in this class that no race can establish
        reliably, because getting it wrong produces a deadlock rather than a wrong answer - and a
        deadlock needs a window of a few microseconds to be hit, so a test that waited for one would
        pass while broken far more often than it failed.

        Reasoning is what shows it matters. Suppose a rotation claimed its token first and asked for
        the account only afterwards, on its way to inserting the successor. A sweep starting in
        between takes the account lock unopposed, then blocks on the claimed token's row lock; the
        rotation then asks for the account lock the sweep is holding. Neither can proceed, and
        PostgreSQL resolves it by killing one - so a perfectly ordinary sign-out concurrent with a
        perfectly ordinary session renewal answers ``500``. Every writer taking the account row
        first removes the cycle rather than making it rarer.

        So the order is asserted where it is decided: in the statements the rotation emits. The
        ``users`` lock must appear before the first write to ``refresh_tokens``, and the assertion
        reads the SQL rather than the source so that a refactor which reorders the calls is caught
        by a failing test rather than by an incident.
        """
        maker = self._sessions(engine)
        statements: list[str] = []

        def record(
            conn: Any, cursor: Any, statement: str, parameters: Any, context: Any, many: bool
        ) -> None:
            statements.append(" ".join(statement.split()))

        owner_id: uuid.UUID | None = None
        try:
            async with maker() as setup:
                owner = await factories.create_user(setup, role=UserRole.AUTHOR)
                await setup.commit()
                owner_id = owner.id
                await RefreshTokenRepository(setup).create(
                    user_id=owner_id,
                    token_hash=hash_refresh_token("statement-order-token"),
                    expires_at=refresh_token_expires_at(),
                )
                await setup.commit()

            event.listen(engine.sync_engine, "before_cursor_execute", record)
            try:
                async with maker() as rotating:
                    await AuthService(rotating).rotate_refresh_token("statement-order-token")
            finally:
                event.remove(engine.sync_engine, "before_cursor_execute", record)

            lock_positions = [
                index
                for index, statement in enumerate(statements)
                if "FROM users" in statement and "FOR UPDATE" in statement
            ]
            token_write_positions = [
                index
                for index, statement in enumerate(statements)
                if statement.startswith("UPDATE refresh_tokens")
                or statement.startswith("INSERT INTO refresh_tokens")
            ]

            assert lock_positions, (
                "the rotation never emitted SELECT ... FOR UPDATE against users, so nothing "
                f"serialises it against a concurrent sweep. Statements: {statements}"
            )
            assert token_write_positions, (
                f"the rotation wrote no token row, so it did not rotate. Statements: {statements}"
            )
            assert lock_positions[0] < token_write_positions[0], (
                "the rotation wrote to refresh_tokens before locking the users row. That is the "
                "reverse of the order every sweep uses, so the two deadlock against each other. "
                f"Statements: {statements}"
            )
        finally:
            if owner_id is not None:
                async with maker() as cleanup:
                    await cleanup.execute(delete(User).where(User.id == owner_id))
                    await cleanup.commit()

    async def test_a_real_deactivation_and_a_real_rotation_racing_leave_no_live_token(
        self, engine: AsyncEngine
    ) -> None:
        """Both services, both real, genuinely concurrent - and one invariant that must hold.

        The tests above hold a lock by hand to pin a single interleaving, which is what makes them
        precise. This one gives that up deliberately and runs the two production code paths against
        each other on independent connections, because the finding is that these paths were *never*
        raced: ``AdminService.update_user`` suspending the account, and
        ``AuthService.rotate_refresh_token`` renewing its session, started together and allowed to
        interleave however the database orders them.

        Which one wins is not asserted, because either order is legitimate. What is asserted is the
        invariant that must survive both:

        * if the rotation committed first, the suspension's sweep must have seen its successor and
          revoked it;
        * if the suspension committed first, the rotation must have been refused;
        * and in neither case may a live refresh token remain on a suspended account, because such a
          token is a credential that outlives the suspension and returns the moment the account is
          reactivated.

        A second thing is asserted by omission: no failure other than the documented
        ``UnauthorizedError`` may escape. A deadlock would surface here as a database error and a
        ``500``, and it is what happens if the two services ever disagree about lock *order* - which
        is why both take the account row first and why that order is documented rather than left to
        be discovered by whichever request pays for it.
        """
        maker = self._sessions(engine)
        owner_id: uuid.UUID | None = None
        admin_id: uuid.UUID | None = None

        try:
            async with maker() as setup:
                owner = await factories.create_user(setup, role=UserRole.AUTHOR)
                operator = await factories.create_user(setup, role=UserRole.ADMIN)
                await setup.commit()
                owner_id, admin_id = owner.id, operator.id
                await RefreshTokenRepository(setup).create(
                    user_id=owner_id,
                    token_hash=hash_refresh_token("contended-rotation-token"),
                    expires_at=refresh_token_expires_at(),
                )
                await setup.commit()

            async with maker() as suspending, maker() as rotating:
                # A distinct name from the `operator` created in the setup session above: this is
                # the same row re-read through the session that will perform the suspension, and
                # the two must not be conflated - an instance is bound to the session that loaded
                # it, and passing the setup session's copy here would attach it to a transaction
                # that has already been committed and closed.
                acting_operator = await suspending.scalar(select(User).where(User.id == admin_id))
                assert acting_operator is not None

                outcomes = await asyncio.gather(
                    AdminService(suspending).update_user(
                        owner_id, AdminUserUpdate(is_active=False), actor=acting_operator
                    ),
                    AuthService(rotating).rotate_refresh_token("contended-rotation-token"),
                    return_exceptions=True,
                )

            unexpected = [
                outcome
                for outcome in outcomes
                if isinstance(outcome, BaseException) and not isinstance(outcome, UnauthorizedError)
            ]
            assert unexpected == [], (
                f"racing the two paths raised something other than the documented refusal: "
                f"{unexpected!r}. A database error here means the two services disagreed about "
                "which row to lock first."
            )

            async with maker() as verify:
                suspended = await verify.scalar(select(User).where(User.id == owner_id))
                assert suspended is not None
                assert suspended.is_active is False
                live = list(
                    await verify.scalars(
                        select(RefreshToken).where(
                            RefreshToken.user_id == owner_id, RefreshToken.revoked_at.is_(None)
                        )
                    )
                )

            assert live == [], (
                "a suspended account is holding a live refresh token, so the suspension can be "
                "outlived by a session and undone by a reactivation"
            )
        finally:
            async with maker() as cleanup:
                for identifier in (owner_id, admin_id):
                    if identifier is not None:
                        await cleanup.execute(delete(User).where(User.id == identifier))
                await cleanup.commit()

    async def test_a_sign_in_blocked_on_the_lock_refuses_once_the_deactivation_commits(
        self, engine: AsyncEngine
    ) -> None:
        """A session is never issued for an account deactivated while the password was verified.

        The class above covers a deactivation racing a *rotation*. This is the other side of the
        same protocol and it was the one left uncovered: a deactivation racing an **issuance**.

        The interleaving. ``authenticate`` reads the account and verifies the password, which
        costs tens of milliseconds of deliberate argon2id work; an administrator commits
        ``is_active = false`` inside that window; ``issue_token_pair`` then takes the account lock
        and mints. The refusal has to come from the locked row, and *both* halves of that were
        missing: the method checked only that the locked row still existed, and the locked read
        did not carry ``populate_existing``, so even a check against it would have read the
        attributes ``authenticate`` had loaded before the suspension. The account received a
        signed access token that nothing can withdraw before it expires, plus a committed refresh
        row to renew it with.

        Why this test is deterministic. Nothing waits for a scheduler. The administrator's
        session takes ``FOR UPDATE`` on the account row and holds it, which is the exact state an
        in-flight administrative write is in; the sign-in's own lock request then *must* block, and
        that blocking is asserted before the suspension is committed. When it is released the
        sign-in reads the committed row, and the outcome assertions fail closed - if the lock were
        not taken, or the check not re-made, the task would have completed with a token pair.

        The answer must also be the ordinary one. ``403`` with the same detail a steadily
        suspended account receives, not a distinguishable variant: a race a caller can tell apart
        from a steady state is a race a caller can detect and time. So the steady-state refusal is
        obtained from the same session afterwards and the two details are compared, rather than a
        message being restated here.
        """
        maker = self._sessions(engine)
        owner_id: uuid.UUID | None = None

        try:
            async with maker() as setup:
                owner = await factories.create_user(setup, role=UserRole.AUTHOR)
                await setup.commit()
                owner_id = owner.id
                owner_email = str(owner.email)

            async with maker() as suspending, maker() as signing_in:
                # The administrator's write, held mid-flight: the account row locked and
                # `is_active` false, committed to nothing yet. Invisible to every other
                # transaction, which is what makes the window below real rather than contrived.
                locked = await UserRepository(suspending).get_by_id(owner_id, for_update=True)
                assert locked is not None
                locked.is_active = False
                await suspending.flush()

                credentials = LoginRequest.model_validate(
                    {"email": owner_email, "password": DEFAULT_PASSWORD}
                )
                service = AuthService(signing_in)

                # `login`, not `issue_token_pair` - so the caller-specific error mapping is under
                # test too, and so this exercises the composition the route actually calls.
                # `authenticate` inside it reads an ACTIVE account, correctly: the suspension is
                # uncommitted. Then the lock request blocks.
                signing = asyncio.create_task(service.login(credentials))

                with pytest.raises(asyncio.TimeoutError):
                    await asyncio.wait_for(asyncio.shield(signing), timeout=1.0)

                await suspending.commit()

                with pytest.raises(ForbiddenError) as raised:
                    await signing
                raced_detail = raised.value.detail

                # The steady state, from the same session: an account that was already suspended
                # when the credential was presented. `authenticate` refuses it before any lock is
                # taken, and the two answers must be the same answer.
                with pytest.raises(ForbiddenError) as steady:
                    await service.authenticate(credentials)
                assert raced_detail == steady.value.detail, (
                    "the racing refusal is distinguishable from the steady-state one, so a caller "
                    "can detect that it won the window"
                )

            async with maker() as verify:
                issued = list(
                    await verify.scalars(
                        select(RefreshToken).where(RefreshToken.user_id == owner_id)
                    )
                )

            assert issued == [], (
                "a refresh row was committed for an account an administrator had already "
                "deactivated, so the session can be renewed indefinitely from a suspended account"
            )
        finally:
            if owner_id is not None:
                async with maker() as cleanup:
                    await cleanup.execute(delete(User).where(User.id == owner_id))
                    await cleanup.commit()

    async def test_the_access_token_carries_the_role_the_locked_row_holds(
        self, engine: AsyncEngine
    ) -> None:
        """A role changed while the password was verified reaches the token, not the stale one.

        The same window as the test above, with the administrator changing ``role`` instead of
        ``is_active`` - and the consequence is the mirror image. ``role`` travels inside the
        signed access token, and an access token is recorded nowhere, so a value minted from the
        pre-lock instance cannot be corrected until it expires: a demotion committed in this
        window would leave a ``READER`` holding an ``AUTHOR`` claim, and the claim is what a
        client shapes its interface from.

        This is why :meth:`~app.services.auth_service.AuthService.issue_token_pair` mints from the
        locked row rather than from its argument, and it is asserted separately from the
        deactivation case because a fix that re-checked ``is_active`` while still reading
        ``user.role`` would pass that test and fail this one.
        """
        maker = self._sessions(engine)
        owner_id: uuid.UUID | None = None

        try:
            async with maker() as setup:
                owner = await factories.create_user(setup, role=UserRole.AUTHOR)
                await setup.commit()
                owner_id = owner.id
                owner_email = str(owner.email)

            async with maker() as promoting, maker() as signing_in:
                locked = await UserRepository(promoting).get_by_id(owner_id, for_update=True)
                assert locked is not None
                locked.role = UserRole.READER
                await promoting.flush()

                credentials = LoginRequest.model_validate(
                    {"email": owner_email, "password": DEFAULT_PASSWORD}
                )
                signing = asyncio.create_task(AuthService(signing_in).login(credentials))

                with pytest.raises(asyncio.TimeoutError):
                    await asyncio.wait_for(asyncio.shield(signing), timeout=1.0)

                await promoting.commit()
                tokens = await signing

            claims = decode_access_token(tokens.access_token)
            assert claims.subject == owner_id
            assert claims.role == UserRole.READER.value, (
                "the access token carries the role the account held before the administrator's "
                "change committed, and nothing can withdraw it before it expires"
            )
        finally:
            if owner_id is not None:
                async with maker() as cleanup:
                    await cleanup.execute(delete(User).where(User.id == owner_id))
                    await cleanup.commit()

    async def test_a_locked_read_reports_committed_state_rather_than_the_loaded_instance(
        self, engine: AsyncEngine
    ) -> None:
        """The repository guarantee both tests above rest on, asserted on its own.

        ``SELECT ... FOR UPDATE`` genuinely re-issues the statement, so it is easy to believe the
        row it returns is fresh. It is not, by itself: measured on SQLAlchemy 2.0.51, a loader
        leaves an already-loaded instance's attributes untouched and *discards* the values the
        statement returned unless the read carries ``populate_existing``. The lock is then real
        while the decision behind it is stale, and nothing in the emitted SQL shows it - which is
        precisely how a service that checked the right attribute at the right moment could still
        have been wrong.

        Asserted here rather than only through the two flows above, because it belongs to
        :meth:`~app.repositories.base.UUIDPrimaryKeyRepository.get_by_id` and governs every
        read-check-write in this codebase - the publish transition, comment moderation, the
        administrative role and status changes - not just token issuance.
        """
        maker = self._sessions(engine)
        owner_id: uuid.UUID | None = None

        try:
            async with maker() as setup:
                owner = await factories.create_user(setup, role=UserRole.AUTHOR)
                await setup.commit()
                owner_id = owner.id

            async with maker() as reader:
                users = UserRepository(reader)

                # The unlocked read a service performs before it decides anything - here it is
                # `get_by_id`, in the sign-in path it is `get_by_email`. Either way the instance is
                # now in this unit of work's identity map with `is_active` loaded as true.
                stale = await users.get_by_id(owner_id)
                assert stale is not None
                assert stale.is_active is True

                async with maker() as suspending:
                    await suspending.execute(
                        update(User).where(User.id == owner_id).values(is_active=False)
                    )
                    await suspending.commit()

                # The locked read. It must report the committed value, and it must do so ON THE
                # SAME INSTANCE - a caller holding the earlier reference has to see the update too,
                # or the guarantee would depend on which variable a service happened to use.
                relocked = await users.get_by_id(owner_id, for_update=True)
                assert relocked is not None
                assert relocked is stale
                assert relocked.is_active is False, (
                    "a FOR UPDATE read returned the attributes this session had already loaded, so "
                    "every read-check-write in the codebase can decide on pre-lock state"
                )
        finally:
            if owner_id is not None:
                async with maker() as cleanup:
                    await cleanup.execute(delete(User).where(User.id == owner_id))
                    await cleanup.commit()


class TestRateLimitingIsDisabledUnderTest:
    """The credential routes answer a burst without throttling while ``ENVIRONMENT`` is ``test``."""

    async def test_a_burst_of_sign_in_attempts_is_never_throttled(
        self,
        client: AsyncClient,
        author_user: User,
    ) -> None:
        """AAP standard 8: repeated sign-ins must not produce 429, or every auth test is flaky."""
        statuses = []
        for _attempt in range(_BURST_SIZE):
            response = await client.post(_LOGIN_URL, data=_login_form(author_user.email))
            statuses.append(response.status_code)

        assert HTTPStatus.TOO_MANY_REQUESTS not in statuses, statuses
        # Not merely un-throttled but genuinely served: every attempt in the burst succeeded, so
        # the absence of a 429 is not being masked by some other failure.
        assert statuses == [HTTPStatus.OK] * _BURST_SIZE, statuses

    async def test_a_burst_of_registrations_is_never_throttled(
        self,
        client: AsyncClient,
    ) -> None:
        """AAP standard 8: repeated registrations must not produce 429 under the test exemption."""
        statuses = []
        for _attempt in range(_BURST_SIZE):
            response = await client.post(_REGISTER_URL, json=_credentials())
            statuses.append(response.status_code)

        assert HTTPStatus.TOO_MANY_REQUESTS not in statuses, statuses
        assert statuses == [HTTPStatus.CREATED] * _BURST_SIZE, statuses

    async def test_a_burst_of_refused_credentials_is_never_throttled(
        self,
        client: AsyncClient,
        author_user: User,
    ) -> None:
        """AAP standard 8: the limiter counts failures too, so a burst of 401s must stay 401s."""
        statuses = []
        for _attempt in range(_BURST_SIZE):
            response = await client.post(
                _LOGIN_URL,
                data=_login_form(author_user.email, _WRONG_PASSWORD),
            )
            statuses.append(response.status_code)

        # A limit that only counted successes would not bound guessing, so failed attempts are
        # counted as well - which makes this the burst most likely to trip a live limiter and
        # therefore the sharpest form of the same tripwire.
        assert statuses == [HTTPStatus.UNAUTHORIZED] * _BURST_SIZE, statuses


# ---------------------------------------------------------------------------------------
# Phase H - the limiter enforcing, with the real object and the real routes
#
# `limiter.enabled` is a plain public attribute and `limiter.reset()` clears the accumulated
# counters, both of which `app.core.rate_limit` documents as the supported way to exercise the
# control. The fixture below is the only place in the suite that touches either: it enables the
# limiter, resets the buckets so a preceding test's attempts cannot count against this one, and
# restores both in a `finally` so a failure here cannot leak a live limiter into the next test
# and make an unrelated module intermittently red.
#
# The allowance is read from `settings.AUTH_RATE_LIMIT` rather than written as a literal. The
# decorator was built from that expression at import time, so a test that assumed five would be
# asserting against a different number the moment the configuration changed - and the failure
# would look like a broken limiter rather than a stale test.
# ---------------------------------------------------------------------------------------


def _configured_allowance() -> int:
    """Return how many requests ``settings.AUTH_RATE_LIMIT`` permits per window.

    The expression is validated at startup to a ``<count>/<period>`` form - optionally several
    separated by ``;`` - so the count of the **narrowest** item is the number of requests that
    may be served before a 429. Parsed here rather than imported because slowapi keeps the
    parsed limit inside the decorator it built, and reaching into that would couple this module
    to the library's internals instead of to the project's own configuration.

    Returns:
        The smallest per-window count the configured expression allows.
    """
    counts = [
        int(item.strip().split("/", maxsplit=1)[0])
        for item in settings.AUTH_RATE_LIMIT.split(";")
        if item.strip()
    ]
    assert counts, f"AUTH_RATE_LIMIT is not a parseable expression: {settings.AUTH_RATE_LIMIT!r}"
    return min(counts)


@pytest.fixture
def live_limiter() -> Iterator[int]:
    """Enable the real limiter for one test, and put it back afterwards.

    Yields:
        The configured allowance, so a test can drive exactly one request past it rather than
        hard-coding a number the configuration is free to change.
    """
    previously_enabled = limiter.enabled
    limiter.reset()
    limiter.enabled = True
    try:
        yield _configured_allowance()
    finally:
        # Order matters on the way out as much as on the way in: disable first so nothing else
        # can consume a bucket while it is being cleared, then clear.
        limiter.enabled = previously_enabled
        limiter.reset()


@pytest.fixture
async def peer_client(
    client: AsyncClient,
    app: Any,
) -> AsyncIterator[Callable[[str], AsyncClient]]:
    """Yield a factory for extra clients that each report a **different** peer address.

    Needed because the limiter's identity is an address, and the shared ``client`` fixture
    reports one fixed address for every request it makes. Under that single peer, a test that
    only rotated ``X-Forwarded-For`` would pass whether or not
    ``app.core.rate_limit._client_key`` buckets a forwarded caller - measured directly, by
    deleting the bucketing branch and watching the test stay green. Varying the address is what
    makes the assertion load-bearing.

    ``ASGITransport(client=...)`` writes the tuple into ``scope["client"]``, which is precisely
    what uvicorn's ``ProxyHeadersMiddleware`` does to a loopback peer that sent
    ``X-Forwarded-For``. So a client from this factory is not an approximation of the deployed
    situation - it reproduces the exact scope the production code sees, and it does so without a
    server, a proxy or a socket.

    The clients share the application object, and therefore the ``get_db`` override the ``client``
    fixture installed - which is why ``client`` is requested here even though it is not used
    directly: it is what puts the test's transaction-scoped session behind these requests too.
    Every client the factory hands out is closed on the way out, so a test cannot leak one.

    Args:
        client: The shared client, requested for the override it installs, not for itself.
        app: The application object every peer client drives.

    Yields:
        A callable taking a peer address and returning a client that reports it.
    """
    opened: list[AsyncClient] = []

    def _for(address: str) -> AsyncClient:
        peer = AsyncClient(
            transport=ASGITransport(app=app, client=(address, _PEER_PORT)),
            base_url=_PEER_BASE_URL,
        )
        opened.append(peer)
        return peer

    try:
        yield _for
    finally:
        for peer in opened:
            await peer.aclose()


class TestRateLimitingEnforcement:
    """With the limiter live, a credential route stops serving and says so in the one error shape.

    Every test here uses :func:`live_limiter`, so each one starts from empty buckets and leaves
    the limiter as it found it. They deliberately drive **login** rather than registration: the
    route is the one an attacker actually hammers, its failures are the ones worth bounding, and
    a wrong password costs one argon2id verification whether or not the limit is reached, so the
    cost of the test is bounded by the allowance rather than by the number of accounts it creates.
    """

    async def test_the_allowance_is_served_and_the_next_request_is_throttled(
        self,
        client: AsyncClient,
        author_user: User,
        live_limiter: int,
    ) -> None:
        """Exactly the configured number of sign-ins succeed; the one after that answers 429.

        The boundary, from both sides, which is what makes this an assertion about the bucket
        rather than about the presence of a decorator. A limiter that refused one request early
        would fail on the first list; one that never refused at all - a decorator removed, an
        `enabled` flag ignored, a bucket that resets per request because the key is derived from
        something the caller controls - would fail on the second.
        """
        allowed = [
            (await client.post(_LOGIN_URL, data=_login_form(author_user.email))).status_code
            for _ in range(live_limiter)
        ]
        throttled = await client.post(_LOGIN_URL, data=_login_form(author_user.email))

        assert allowed == [HTTPStatus.OK] * live_limiter, allowed
        assert throttled.status_code == HTTPStatus.TOO_MANY_REQUESTS, throttled.text

    async def test_the_throttled_response_is_the_one_problem_document(
        self,
        client: AsyncClient,
        author_user: User,
        live_limiter: int,
    ) -> None:
        """The 429 is the same document every other failure in this API is, plus ``Retry-After``.

        slowapi ships its own handler, and using it would have made the 429 the single error in
        this API that does not match the documented shape - a client with one error decoder would
        then have to special-case throttling. ``app.core.exceptions`` therefore registers its own
        handler for ``RateLimitExceeded``, and this is the assertion that it is the one being
        used: the media type, the six members, the ``status`` agreeing with the transport, and the
        ``instance`` naming the path.

        ``Retry-After`` is asserted as a **positive whole number of seconds**, because that is
        the only form a specification-following client can act on, and because ``Retry-After: 0``
        would invite an immediate retry into a window that is still closed. The header is where
        the interval lives rather than in ``detail`` - the wording stays constant so a client
        renders one message and reads one header.
        """
        for _ in range(live_limiter):
            await client.post(_LOGIN_URL, data=_login_form(author_user.email))
        response = await client.post(_LOGIN_URL, data=_login_form(author_user.email))

        payload = _assert_problem_document(response, HTTPStatus.TOO_MANY_REQUESTS)
        assert payload["type"] == _ERROR_TYPE_RATE_LIMITED, payload
        retry_after = response.headers.get(_RETRY_AFTER)
        assert retry_after is not None, dict(response.headers)
        assert retry_after.isdigit(), retry_after
        assert int(retry_after) > 0, retry_after
        # The window the configured expression declares is a minute, so the advertised interval
        # cannot be longer than that. Asserted as a bound rather than an equality because the
        # expression is configuration and a deployment may narrow it.
        assert int(retry_after) <= _SECONDS_PER_MINUTE, retry_after
        # The rejected credential never reaches the body - the limiter's response is built from
        # the rule, not from the request.
        assert DEFAULT_PASSWORD not in _serialised(payload)
        assert author_user.email not in _serialised(payload)

    async def test_refused_credentials_consume_the_allowance_too(
        self,
        client: AsyncClient,
        author_user: User,
        live_limiter: int,
    ) -> None:
        """A burst of wrong passwords is throttled, so the limit actually bounds guessing.

        The property that makes the control worth having. A limiter that counted only successful
        sign-ins would leave an attacker unlimited attempts at the one thing they are trying to
        do, and every attempt would still cost the server a deliberate argon2id verification. So
        the failures are counted, and the transition is asserted in place: the allowance answers
        401, and the next attempt answers 429 rather than a further 401.
        """
        refused = [
            (
                await client.post(_LOGIN_URL, data=_login_form(author_user.email, _WRONG_PASSWORD))
            ).status_code
            for _ in range(live_limiter)
        ]
        throttled = await client.post(
            _LOGIN_URL, data=_login_form(author_user.email, _WRONG_PASSWORD)
        )

        assert refused == [HTTPStatus.UNAUTHORIZED] * live_limiter, refused
        assert throttled.status_code == HTTPStatus.TOO_MANY_REQUESTS, throttled.text

    async def test_a_distinct_peer_address_has_its_own_allowance(
        self,
        peer_client: Callable[[str], AsyncClient],
        author_user: User,
        live_limiter: int,
    ) -> None:
        """Two callers at different addresses each get the whole allowance. The control.

        Stated first because the test after it is only meaningful if this one holds. The limit is
        counted per caller, and the caller is an address, so exhausting one address must leave
        another untouched - a limiter keyed on something coarser would refuse the second caller
        and lock every visitor out the moment one of them misbehaved.

        It is also what gives the next test its teeth. It establishes that a *different*
        ``scope["client"]`` really does buy a fresh allowance here, so when the next test varies
        the address and the allowance is *not* refreshed, the only thing that can explain the
        difference is the forwarded header being bucketed.
        """
        first, second = (peer_client(address) for address in _PEER_ADDRESSES)

        exhausting = [
            (await first.post(_LOGIN_URL, data=_login_form(author_user.email))).status_code
            for _ in range(live_limiter)
        ]
        first_refused = await first.post(_LOGIN_URL, data=_login_form(author_user.email))
        untouched = [
            (await second.post(_LOGIN_URL, data=_login_form(author_user.email))).status_code
            for _ in range(live_limiter)
        ]

        assert exhausting == [HTTPStatus.OK] * live_limiter, exhausting
        assert first_refused.status_code == HTTPStatus.TOO_MANY_REQUESTS, first_refused.text
        assert untouched == [HTTPStatus.OK] * live_limiter, untouched

    async def test_a_rotating_forwarded_header_does_not_buy_attempts(
        self,
        peer_client: Callable[[str], AsyncClient],
        author_user: User,
        live_limiter: int,
    ) -> None:
        """A caller that volunteers ``X-Forwarded-For`` shares one bucket, whatever it claims.

        This is the measured defect ``app.core.rate_limit._client_key`` exists to close, asserted
        rather than described. slowapi's default identity reads ``request.client.host``, and
        uvicorn's proxy-header middleware rewrites that value from ``X-Forwarded-For`` for a
        loopback peer - so six attempts each carrying a *different* forwarded address answered
        401 six times where the same six from one address answered ``401 401 429 429 429 429``.
        The limit had not been raised; it had been reset per request, by a header the caller
        chose.

        The rewrite is what :func:`peer_client` reproduces: each request below arrives with a
        different ``scope["client"]`` **and** the forwarded header that would have produced it,
        which is the shape the deployed service sees. The previous test proves a different address
        alone is enough to earn a fresh allowance, so if the header were ignored these requests
        would never be refused.

        They are refused, because every request that volunteers such a header is counted against
        one fixed key. Rotating it now costs attempts from a shared budget instead of buying them,
        and the total spent across all the rotations is still one allowance.
        """
        addresses = [f"203.0.113.{index + 1}" for index in range(live_limiter + 1)]
        claimed = [
            (
                await peer_client(address).post(
                    _LOGIN_URL,
                    data=_login_form(author_user.email, _WRONG_PASSWORD),
                    headers={_FORWARDED_FOR: address},
                )
            ).status_code
            for address in addresses[:-1]
        ]
        throttled = await peer_client(addresses[-1]).post(
            _LOGIN_URL,
            data=_login_form(author_user.email, _WRONG_PASSWORD),
            headers={_FORWARDED_FOR: addresses[-1]},
        )

        assert claimed == [HTTPStatus.UNAUTHORIZED] * live_limiter, claimed
        assert throttled.status_code == HTTPStatus.TOO_MANY_REQUESTS, throttled.text

    async def test_every_credential_route_carries_the_limit(
        self,
        client: AsyncClient,
        author_user: User,
        auth_headers_for: AuthHeaderFactory,
        live_limiter: int,
    ) -> None:
        """Each of the five credential routes is throttled once its own allowance is spent.

        A per-route assertion because slowapi registers a limit under
        ``f"{func.__module__}.{func.__name__}"``, so each handler has its own bucket and a
        decorator missing from one route is invisible to a test that only drove another. The
        buckets are cleared between routes for the same reason: this asserts five independent
        limits, not one shared budget.

        **The two protected routes are driven with a credential, and that is not incidental.**
        slowapi's limit is applied to the endpoint, and FastAPI resolves a route's dependencies
        *before* the endpoint runs, so an anonymous request to ``/auth/logout`` or ``/auth/me`` is
        refused by ``get_current_user`` and never reaches the limiter at all - measured directly:
        it answers 401 indefinitely rather than 429. Sending a valid bearer is therefore what
        makes those two buckets observable, and it also states the ordering: on a protected route
        authentication is checked first and the limit second.

        The bodies are otherwise whatever each route accepts - a form for login, JSON for the
        other three - because the status *before* the limit is reached is irrelevant here and is
        asserted elsewhere in this module. What this asserts is only the transition: while the
        allowance holds, the answer is not 429; once it is spent, it is.
        """
        headers = auth_headers_for(author_user)
        routes: tuple[tuple[str, dict[str, Any]], ...] = (
            (_LOGIN_URL, {"data": _login_form("nobody@example.com")}),
            (_REGISTER_URL, {"json": _credentials()}),
            (_REFRESH_URL, {"json": {"refresh_token": _UNISSUED_REFRESH_TOKEN}}),
            (
                _LOGOUT_URL,
                {"json": {"refresh_token": _UNISSUED_REFRESH_TOKEN}, "headers": headers},
            ),
            (_ME_URL, {"headers": headers}),
        )

        for url, payload in routes:
            limiter.reset()
            request = client.get if url == _ME_URL else client.post
            within = [(await request(url, **payload)).status_code for _ in range(live_limiter)]
            beyond = await request(url, **payload)

            assert HTTPStatus.TOO_MANY_REQUESTS not in within, (url, within)
            assert beyond.status_code == HTTPStatus.TOO_MANY_REQUESTS, (url, beyond.text)
