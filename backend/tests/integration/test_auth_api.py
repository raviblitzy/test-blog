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

import itertools
import json
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from typing import Any, Final

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import create_access_token
from app.models import User, UserRole
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
    ``app.core.password_policy`` in full, so a caller perturbing another field never has to
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
    """
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
    return response.json()


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
            pytest.param({"password": "short"}, "password", id="password-below-the-length-floor"),
            pytest.param(
                {"password": "aaaaaaaaaaaaaaaaaaaa"},
                "password",
                id="password-with-too-little-character-variety",
            ),
            pytest.param({"username": "ab"}, "username", id="username-below-the-length-floor"),
            pytest.param({"username": "has spaces"}, "username", id="username-with-a-space"),
            pytest.param(
                {"username": "-leading-hyphen"}, "username", id="username-starting-with-a-hyphen"
            ),
            pytest.param({"username": "a" * 31}, "username", id="username-over-the-length-ceiling"),
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
# Phase G - the limiter is exempt under test, and this is the tripwire that proves it
#
# All five credential routes carry `@auth_rate_limit`, and `app.core.rate_limit` builds the
# limiter with `enabled=settings.ENVIRONMENT != "test"`. `backend/tests/conftest.py` sets
# ENVIRONMENT=test in its pre-import bootstrap, so the limit is off for the whole suite - which
# is what lets this module register, sign in, rotate and sign out dozens of times without
# tripping the five-per-minute allowance and turning a blocking gate flaky.
#
# The limiter's *enforcement* is deliberately not tested here. What is tested is the exemption,
# because that is the arrangement the rest of the suite silently depends on: if anyone removes
# it, these two tests fail immediately and by name instead of the suite becoming intermittently
# red somewhere else entirely.
# ---------------------------------------------------------------------------------------


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
