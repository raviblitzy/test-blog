"""The wire contract of the five authentication routes: credentials in, token pairs out.

Four models cover the whole of ``/api/v1/auth``, and not one of them is used as both a request
and a response:

* ``POST /auth/register`` - :class:`RegisterRequest` in, ``UserPublic`` out.
* ``POST /auth/login`` - :class:`LoginRequest` in, :class:`TokenPair` out.
* ``POST /auth/refresh`` - :class:`RefreshRequest` in, :class:`TokenPair` out.
* ``POST /auth/logout`` - :class:`RefreshRequest` in, ``204 No Content``, no body.
* ``GET /auth/me`` - no body at all; the bearer credential in the ``Authorization`` header
  identifies the principal and ``UserMe`` comes back.

``UserPublic`` and ``UserMe`` live in :mod:`app.schemas.user`, and neither is imported here -
the router imports both modules, so an account projection and a credential contract stay
independent of one another.

A request model and a response model are never the same class
-------------------------------------------------------------
The service this repository grew out of had exactly one model, ``Item``, and used it as the
body of ``POST /items`` and as the response of four routes at once. Two defects followed from
that single decision, and both are structurally impossible here.

The first is that a client owned identity: ``Item.id`` was an ``int`` supplied in the request,
never generated and never checked, so two records could share an identifier and the first
would permanently shadow the second. Nothing below accepts a primary key, and
``extra="forbid"`` on all three input models makes that a rejection rather than a convention -
a caller who posts ``id`` receives a ``422`` naming the offending key.

The second is that a field only one direction needs is exposed in both. A password is the
starkest case: :class:`RegisterRequest` and :class:`LoginRequest` accept one, and no response
model in this module has a password field to leak it back through. That is achieved by
declaring separate classes rather than by excluding a field at serialisation time, so there is
no ``exclude`` argument to forget at a new call site.

What is deliberately absent
---------------------------
``role``
    :class:`RegisterRequest` has no role field, and this is the privilege-escalation guard. A
    self-registering caller must not be able to nominate their own authority, so the role comes
    from ``app.services.auth_service`` and from the ``'READER'::user_role`` server default on
    ``users.role``. With ``extra="forbid"``, ``{"role": "ADMIN"}`` in a registration body is a
    ``422`` rather than a field that is quietly ignored - which matters, because "quietly
    ignored" is indistinguishable from "silently honoured" when reading a client's code.
``id``, ``is_active``, ``created_at``, ``updated_at``
    Server-owned every one of them, so no input model accepts any of them.
Any projection of ``refresh_tokens``
    A stored token row is never returned to a client in any shape, so there is no model for
    one. A refresh token appears in this API exactly twice: as an input field on
    :class:`RefreshRequest`, and as a freshly minted value inside :class:`TokenPair`. What
    reaches the database is the SHA-256 digest from
    :func:`app.core.security.hash_refresh_token` and never the value itself, so there is
    nothing enumerable for a projection to expose.
``password_hash`` and ``token_hash``
    Neither name appears anywhere in this module. Both are storage details of
    :mod:`app.models.user` and :mod:`app.models.refresh_token`; publishing either would put a
    credential derivative on the wire.
Password reset, email verification, and federated identity
    No ``PasswordResetRequest``, no ``EmailVerification``, no OAuth or OIDC model. Password
    reset, email verification, transactional email and third-party federation are all out of
    scope for this service, and a model for one of them would be scope this file invented.

Identity is not normalised here
-------------------------------
``users.email`` and ``users.username`` are ``CITEXT`` columns carrying ``UNIQUE`` indexes, so
the database compares them case-insensitively: once ``Alice``/``A@X.com`` exists, registering
``alice``/``a@x.com`` raises a unique violation. Case folding in this module would therefore be
duplicated work at best and a second, competing definition of identity at worst - so there is
none, and there is no uniqueness check either. Uniqueness belongs to the database, and
translating its violation into a ``409`` belongs to ``app.services.auth_service``, which raises
:class:`~app.core.exceptions.ConflictError`.

Two normalisations do happen, and both come from the library rather than from code here.
:class:`~pydantic.EmailStr` returns ``email-validator``'s normalised form, which lower-cases
the domain and leaves the local part alone - ``Alice@EXAMPLE.COM`` arrives as
``Alice@example.com`` - and it strips surrounding whitespace on the way. ``strip_whitespace``
is set on ``username``, ``display_name`` and ``refresh_token`` for the same reason: a leading
space pasted into a form must not become part of an identity or of a credential lookup. It is
pointedly **not** set on either password field, because stripping a password would silently
change the credential a caller typed, and the caller would then be unable to log in with it.

The password policy is declared here, and mirrored on the client
---------------------------------------------------------------
:data:`PASSWORD_MIN_LENGTH`, :data:`PASSWORD_MAX_LENGTH` and
:data:`PASSWORD_MIN_CHARACTER_CLASSES` are the whole of the policy, and they are exported so
that ``frontend/src/lib/validation/auth.ts`` and ``docs/features/authentication.md`` can mirror
them instead of restating them from prose. Client and server must reject the same passwords: a
client that accepts what the server refuses produces a ``422`` the user cannot act on, and a
client stricter than the server locks people out of a policy that would have admitted them.

The maximum is a security control rather than a formatting preference.
:func:`app.core.security.hash_password` says so explicitly - argon2 has no input-length limit
of its own, it deliberately performs no truncation, and it delegates the cap to "the
registration schema's job in ``app.schemas.auth``, where a rejection can be reported per
field". Without a bound, a single request body could hand a memory-hard hash function an
arbitrarily large input, which is a denial-of-service vector on the most exposed route in the
service.

Layer boundaries
----------------
Declarations only. Nothing in this module hashes, verifies, mints, decodes, revokes, queries or
chooses a status code. :mod:`app.core.security` owns every cryptographic operation,
``app.services.auth_service`` owns registration, credential verification, refresh rotation and
revocation, and :mod:`app.core.exceptions` owns the mapping from a domain failure to a status
code and a problem document.

Import purity
-------------
Two imports, ``typing`` and ``pydantic``, and no third. Not :mod:`app.core.config` - a schema
that read a setting would make the shape of the API depend on the environment, and
:attr:`TokenPair.expires_in` is passed in by its caller for exactly that reason rather than
computed from ``ACCESS_TOKEN_EXPIRE_MINUTES`` here. Not :mod:`app.core.security`, whose
functions this module describes but must not call. Not :mod:`app.models`, which would drag
SQLAlchemy and a database dialect into a module about JSON. Not a sibling schema module, which
would make this package's import order load-bearing. Importing this module performs no I/O,
opens no connection and reads no environment variable, which is what lets a unit test import it
with nothing running.

Published examples carry no credential
--------------------------------------
Every ``json_schema_extra`` example below is served verbatim at ``/openapi.json`` and rendered
on ``/docs``, which makes each one a permanent, public, unauthenticated string in this
repository. They are therefore written to be unmistakable placeholders - they say
``example-only`` in the value - rather than realistic-looking ones. No example is a plausible
password and none is a well-formed JWT.
"""

from typing import Annotated, Final, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, StringConstraints, field_validator

# Exported in the order ruff's isort profile sorts identifiers - screaming-case constants,
# then classes - so the list stays stable under `ruff check --select I`. The constants are
# public deliberately: they are the numbers `frontend/src/lib/validation/auth.ts` has to agree
# with, and a mirror written against a named constant can be audited, where one written against
# a number copied out of a docstring cannot. Keep this list exactly in step with what the
# module defines; mypy's strict `no_implicit_reexport` consults it.
__all__ = [
    "DISPLAY_NAME_MAX_LENGTH",
    "DISPLAY_NAME_MIN_LENGTH",
    "PASSWORD_CHARACTER_GROUPS",
    "PASSWORD_MAX_LENGTH",
    "PASSWORD_MIN_CHARACTER_CLASSES",
    "PASSWORD_MIN_LENGTH",
    "REFRESH_TOKEN_MAX_LENGTH",
    "USERNAME_MAX_LENGTH",
    "USERNAME_MIN_LENGTH",
    "USERNAME_PATTERN",
    "LoginRequest",
    "RefreshRequest",
    "RegisterRequest",
    "TokenPair",
]


# ---------------------------------------------------------------------------------------
# Username policy
#
# A username is not merely a label: it is a URL path segment. It addresses
# `GET /api/v1/users/{username}`, the client's `/u/[username]` profile route, and the
# canonical link and sitemap entry that route publishes. Every constraint below exists to
# keep those URLs well-formed and stable.
# ---------------------------------------------------------------------------------------

USERNAME_MIN_LENGTH: Final[int] = 3
"""Shortest accepted username.

Three characters rather than one, so the profile namespace is not exhausted by single letters
and so a handle is recognisable in a byline. Applied after ``strip_whitespace``, which is why
``"  ab  "`` is rejected as too short rather than accepted as a padded two-character name.
"""

USERNAME_MAX_LENGTH: Final[int] = 30
"""Longest accepted username.

Thirty characters keeps a profile URL comfortably short enough to render untruncated in a
byline, in a share card and in the address bar, and bounds the ``CITEXT`` value the unique
index has to compare. ``users.username`` is unbounded ``TEXT``, so this schema is the only
place the length is limited - the database will store whatever it is handed.
"""

USERNAME_PATTERN: Final[str] = r"^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$"
r"""Accepted username shape: URL-path-safe characters, with no separator at either end.

Reading the expression: an alphanumeric character, then optionally more alphanumerics,
underscores and hyphens, then a final alphanumeric. So ``alice``, ``Alice``, ``a-b_c`` and
``user123`` are accepted, while ``-alice``, ``alice-`` and ``_alice`` are not.

The excluded characters are the point. A username containing a space, a ``/``, a ``?``, a
``#`` or a ``%`` would either break ``GET /api/v1/users/{username}`` outright or require
percent-encoding at every call site that builds a profile link - and a canonical URL that
needs encoding is a canonical URL that two clients will encode differently. Restricting the
alphabet at the contract boundary is what lets every consumer interpolate the value directly.

Two details of the expression are load-bearing:

* It is anchored at both ends. Pydantic applies a pattern by searching rather than by matching
  the whole string, so an unanchored expression would accept ``bad name/alice`` on the strength
  of the substring ``alice``.
* It uses no look-around. Pydantic 2's default ``rust-regex`` engine is non-backtracking, which
  is what makes it immune to catastrophic-backtracking denial of service, and it rejects a
  look-around expression outright at schema-build time - that is, at import time - rather than
  at first use. Verified against the pinned pydantic: this expression compiles and behaves as
  described.

Whether a *particular* well-formed username is available or permissible is not decided here.
Uniqueness is the ``CITEXT UNIQUE`` index's, and any reserved-handle policy would be
``app.services.auth_service``'s; this constant governs shape alone.
"""


# ---------------------------------------------------------------------------------------
# Password policy
#
# Two independent controls, and it is worth being clear about which does what. The minimum
# length and the character-group rule bound how weak a NEW password may be. The maximum
# length bounds how much work an argon2 call can be made to do, on registration and on
# login alike, and is therefore a resource control rather than a strength rule.
# ---------------------------------------------------------------------------------------

PASSWORD_MIN_LENGTH: Final[int] = 12
"""Shortest accepted new password, in characters.

Twelve is the floor OWASP's Application Security Verification Standard states for a
user-chosen password, and length is the property that actually resists offline attack on a
stolen ``users.password_hash``: each additional character multiplies the search space, where a
substitution inside a fixed length merely rearranges it.

Enforced by ``StringConstraints``, which runs before
:meth:`RegisterRequest.validate_password_variety`. A caller therefore sees ``String should have
at least 12 characters`` for a short password rather than that message *and* the group message
at once, which is what lets a client render one actionable sentence per field.
"""

PASSWORD_MAX_LENGTH: Final[int] = 128
"""Longest accepted password, in characters, on registration and on login alike.

A deliberate denial-of-service bound, not a storage limit. ``users.password_hash`` is unbounded
``TEXT`` precisely so an argon2id hash may grow when its cost parameters are tuned, and
:func:`app.core.security.hash_password` passes the plaintext through unmodified - it performs
no truncation, imposes no maximum of its own, and states that bounding the input is this
schema's responsibility. Argon2 is memory-hard and intentionally slow by design, so an
unbounded input on an unauthenticated route is an amplification primitive: one large body
would buy an attacker a large, slow, memory-heavy computation.

One hundred and twenty-eight characters is far above any password a human composes and well
above the sixty-four an entirely passphrase-based policy needs, so the bound costs no
legitimate caller anything. It is applied to :attr:`LoginRequest.password` as well, because
login is where an unauthenticated caller reaches argon2 verification and is therefore the more
exposed of the two call sites - the rate limiter on that route thins the flood, and this bound
caps the cost of each request that gets through it.
"""

PASSWORD_MIN_CHARACTER_CLASSES: Final[int] = 3
"""How many of the five character groups a new password must draw on.

Three of five. The rule exists so that a twelve-character password cannot also be a
single-alphabet one: ``alllowercaseonly`` clears the length floor and is still trivially
enumerable, and requiring variety is what makes the stated minimum length mean something.

Three rather than all five, because a rule nobody can satisfy without a password manager is a
rule that produces written-down passwords. The groups themselves are listed in
:data:`PASSWORD_CHARACTER_GROUPS`.
"""

PASSWORD_CHARACTER_GROUPS: Final[tuple[str, ...]] = (
    # Indexed by the _GROUP_* constants below, in this exact order. Adding a group means
    # adding its constant, its branch in _password_character_groups, and a line here.
    "a lowercase letter",
    "an uppercase letter",
    "a digit",
    "a letter from a script that has no letter case, such as CJK, Hebrew or Arabic",
    "any other character, such as a symbol, a punctuation mark or a space",
)
"""The five character groups :data:`PASSWORD_MIN_CHARACTER_CLASSES` counts, as prose.

The list is the single source of the wording, so the field description, the validation message
a rejected caller receives and any client mirroring the policy all quote the same five phrases
rather than three drifting paraphrases of them.

The **fifth group is a catch-all**, and that is what makes the classification total: every
character of every string lands in exactly one group, so no writing system is excluded by
omission. The fourth group is the reason the catch-all is not enough on its own. A rule built
only from "lowercase, uppercase, digit, symbol" is unsatisfiable at three groups for anyone
writing in a script that has no letter case - a Japanese or Hebrew passphrase can reach two
groups and no further, however long or strong it is - so counting caseless letters as a group
of their own is what keeps this policy from quietly excluding most of the world's readers.
"""

_GROUP_LOWERCASE: Final[int] = 0
_GROUP_UPPERCASE: Final[int] = 1
_GROUP_DIGIT: Final[int] = 2
_GROUP_CASELESS_LETTER: Final[int] = 3
_GROUP_OTHER: Final[int] = 4

_PASSWORD_VARIETY_MESSAGE: Final[str] = (
    f"Password must contain characters from at least {PASSWORD_MIN_CHARACTER_CLASSES} of these "
    f"{len(PASSWORD_CHARACTER_GROUPS)} groups: {'; '.join(PASSWORD_CHARACTER_GROUPS)}."
)
"""The rejection message for a password that clears the length floor but not the group floor.

Built from :data:`PASSWORD_CHARACTER_GROUPS` rather than written out, so the message and the
documented policy cannot disagree. It is a complete, self-contained sentence on purpose:
:mod:`app.core.exceptions` copies a validator's message verbatim into the ``message`` member of
each entry in the problem document's ``errors`` list, so this string is what a client renders
beside the password field. It names what is required and never quotes what was submitted -
:class:`~app.schemas.common.ValidationErrorItem` drops pydantic's ``input`` key specifically so
that a rejected password cannot reach a response body or an access log.
"""


# ---------------------------------------------------------------------------------------
# Display-name policy
# ---------------------------------------------------------------------------------------

DISPLAY_NAME_MIN_LENGTH: Final[int] = 1
"""Shortest accepted display name, applied after ``strip_whitespace``.

One character, so a single-glyph name is allowed, combined with stripping so that a
whitespace-only submission is rejected as too short rather than stored as an empty string.
``users.display_name`` is ``NOT NULL`` and is rendered unconditionally - in every post byline,
on every post card, at the head of every profile and in the administrative user table - so an
effectively blank value would show as a gap in all four places.
"""

DISPLAY_NAME_MAX_LENGTH: Final[int] = 80
"""Longest accepted display name.

Eighty characters is generous for a person's name in any script while still fitting the
single-line byline, card heading and table cell that render it without wrapping or truncation.
As with every other bound here, the column itself is unbounded ``TEXT``, so this is the only
limit that exists.
"""


# ---------------------------------------------------------------------------------------
# Refresh-token policy
# ---------------------------------------------------------------------------------------

REFRESH_TOKEN_MAX_LENGTH: Final[int] = 512
"""Longest refresh token this API will accept in a request body.

A denial-of-service bound on the same reasoning as :data:`PASSWORD_MAX_LENGTH`, sized so that
it never becomes a functional constraint. :func:`app.core.security.generate_refresh_token`
emits ``secrets.token_urlsafe`` over ``REFRESH_TOKEN_ENTROPY_BYTES`` bytes, which is a
forty-three-character string today, so this ceiling is roughly twelve times the value actually
issued.

That headroom is deliberate. Pinning the bound to the current length - or validating the token
against a base64url pattern - would couple this wire contract to the generator's entropy
setting, and raising ``REFRESH_TOKEN_ENTROPY_BYTES`` would then reject every token the service
had just minted. The shape of a refresh token is opaque to this contract by design; only its
size is bounded.
"""


def _password_character_groups(password: str) -> frozenset[int]:
    """Return the indices of :data:`PASSWORD_CHARACTER_GROUPS` the password draws on.

    Total by construction: the four tests are tried in order and the final ``else`` catches
    everything they do not, so every character contributes to exactly one group and no string
    is left unclassified. That totality is the property the fifth group exists to provide -
    see :data:`PASSWORD_CHARACTER_GROUPS` for why a four-group rule silently excluded caseless
    scripts.

    The tests are Unicode-aware because :meth:`str.islower`, :meth:`str.isupper` and
    :meth:`str.isdigit` are: ``é`` counts as lowercase and ``Ä`` as uppercase, exactly as ``e``
    and ``A`` do. ``isalpha`` is tried only after both case tests have failed, so it matches a
    letter from a script that draws no case distinction - Japanese, Chinese, Hebrew, Arabic,
    Devanagari, Thai, Hangul - rather than shadowing the two groups above it.

    Every character is examined rather than stopping at the first three groups found. The input
    is capped at :data:`PASSWORD_MAX_LENGTH`, so the loop is bounded and short, and returning
    the complete set keeps the function's result meaningful to a caller that wants to report
    what was found rather than only whether it was enough.

    Args:
        password: The candidate password, already length-checked by ``StringConstraints``.

    Returns:
        The set of group indices present. Empty only for an empty string.
    """
    groups: set[int] = set()
    for character in password:
        if character.islower():
            groups.add(_GROUP_LOWERCASE)
        elif character.isupper():
            groups.add(_GROUP_UPPERCASE)
        elif character.isdigit():
            groups.add(_GROUP_DIGIT)
        elif character.isalpha():
            groups.add(_GROUP_CASELESS_LETTER)
        else:
            groups.add(_GROUP_OTHER)
    return frozenset(groups)


class RegisterRequest(BaseModel):
    """Body of ``POST /api/v1/auth/register``: everything an account needs, and nothing more.

    Four fields, three of them required. The response is ``UserPublic``, not this model - a
    registration reply carries the created account's server-generated identifier, role and
    timestamps, and carries no password.

    ``extra="forbid"`` is the security control on this class, not a tidiness setting. It is what
    turns "we do not accept a role here" from a comment into a rejection: ``{"role": "ADMIN"}``,
    ``{"id": ...}`` or ``{"is_active": true}`` in a registration body produces a ``422`` naming
    the key, where the permissive default would accept the request and discard the field. The
    difference matters because a discarded field looks exactly like an honoured one from the
    outside, so a privilege-escalation attempt would succeed silently at the only level that
    could report it.

    What this class does not do is decide whether the account may exist. It performs no
    uniqueness check, because ``users.email`` and ``users.username`` are ``CITEXT UNIQUE`` and
    the database answers that question authoritatively for both simultaneous and case-variant
    registrations; ``app.services.auth_service`` translates the violation into a ``409``
    through :class:`~app.core.exceptions.ConflictError`.

    Example body:

    .. code-block:: json

        {
          "email": "reader@example.com",
          "username": "example-reader",
          "password": "example-only-Placeholder-1",
          "display_name": "Example Reader"
        }
    """

    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            # Published verbatim at /openapi.json and rendered on /docs. The password reads
            # `example-only` so that nobody can mistake it for a credential, while still
            # satisfying the policy - a reader who pastes it into the /docs "Try it out" form
            # gets a successful registration rather than a 422 that looks like a broken
            # example.
            "example": {
                "email": "reader@example.com",
                "username": "example-reader",
                "password": "example-only-Placeholder-1",
                "display_name": "Example Reader",
            }
        },
    )

    email: EmailStr = Field(
        ...,
        description=(
            "The account's email address, and the credential it logs in with. Validated for "
            "deliverable syntax and normalised by `email-validator`: the domain is "
            "lower-cased and surrounding whitespace is removed, while the local part is left "
            "exactly as submitted. Stored in a case-insensitive `CITEXT UNIQUE` column, so an "
            "address differing from an existing one only in case is rejected with 409 rather "
            "than creating a second account. Never published: it appears in no public "
            "profile response, only in the authenticated `GET /api/v1/auth/me` view of the "
            "account's own record and in the administrative user listing."
        ),
    )
    username: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True,
            min_length=USERNAME_MIN_LENGTH,
            max_length=USERNAME_MAX_LENGTH,
            pattern=USERNAME_PATTERN,
        ),
    ] = Field(
        ...,
        description=(
            "Public handle, and a URL path segment: it addresses "
            "`GET /api/v1/users/{username}` and the site's `/u/{username}` profile page, and "
            f"it appears in that page's canonical link and sitemap entry. Between "
            f"{USERNAME_MIN_LENGTH} and {USERNAME_MAX_LENGTH} "
            "characters after surrounding whitespace is removed, made up of letters, digits, "
            "underscores and hyphens, and beginning and ending with a letter or a digit. A "
            "space, a slash, a question mark or any other character that would need "
            "percent-encoding in a path is rejected, so every consumer can interpolate the "
            "value into a URL unchanged. Compared case-insensitively by the database, so "
            "`/u/Alice` and `/u/alice` are one profile and a case-variant handle cannot be "
            "registered twice."
        ),
    )
    password: Annotated[
        str,
        StringConstraints(min_length=PASSWORD_MIN_LENGTH, max_length=PASSWORD_MAX_LENGTH),
    ] = Field(
        ...,
        # The two rules are interpolated from the constants that enforce them rather than
        # restated, so the text published at /openapi.json - which is what a mirroring client
        # reads - cannot drift from what this schema actually rejects.
        description=(
            "The account's new password, in plaintext, over TLS, exactly once. Hashed with "
            "argon2id before storage and never stored, logged or returned - no response model "
            "in this API has a password field, and a validation failure quotes the rule "
            "rather than the value. Two rules apply, and a client should enforce both so a "
            f"user is told before submitting: at least {PASSWORD_MIN_LENGTH} characters and at "
            f"most {PASSWORD_MAX_LENGTH}, and characters drawn from at least "
            f"{PASSWORD_MIN_CHARACTER_CLASSES} of these {len(PASSWORD_CHARACTER_GROUPS)} "
            f"groups - {', '.join(PASSWORD_CHARACTER_GROUPS)}. Whitespace is significant and "
            "is never trimmed, including at the ends, because trimming would change the "
            "credential; a leading or trailing space typed here must be typed at every "
            "subsequent login."
        ),
    )
    display_name: (
        Annotated[
            str,
            StringConstraints(
                strip_whitespace=True,
                min_length=DISPLAY_NAME_MIN_LENGTH,
                max_length=DISPLAY_NAME_MAX_LENGTH,
            ),
        ]
        | None
    ) = Field(
        default=None,
        description=(
            "Human-readable name shown wherever the account appears - the byline on each of "
            "its posts, the heading of its profile, the administrative user table. Optional "
            f"here and at most {DISPLAY_NAME_MAX_LENGTH} characters, with surrounding "
            "whitespace removed, so a "
            "whitespace-only value is rejected rather than stored blank. Omit it, or send "
            "null, to have the username used instead: `users.display_name` is `NOT NULL` and "
            "is rendered unconditionally, so the account is given a usable name at "
            "registration rather than every view having to substitute one."
        ),
    )

    @field_validator("password")
    @classmethod
    def validate_password_variety(cls, password: str) -> str:
        """Reject a password that clears the length floor but draws on too few character groups.

        Runs after ``StringConstraints``, so a password shorter than
        :data:`PASSWORD_MIN_LENGTH` or longer than :data:`PASSWORD_MAX_LENGTH` never reaches
        here - the length message is reported on its own, and this message is reported on its
        own, so a client always has exactly one actionable sentence to render per submission.

        This is the only behaviour in the module, and it is validation rather than policy
        enforcement: it decides whether a *submitted* string is an acceptable new password. It
        does not hash, compare, look anything up, or consult a breached-password list, and it
        is applied to :class:`RegisterRequest` alone - see :attr:`LoginRequest.password` for
        why a submitted credential is never held to this rule.

        Args:
            password: The candidate password, already within the configured length bounds.

        Returns:
            The password unchanged. Nothing is trimmed, folded or re-encoded: the value that
            arrives is the value ``app.core.security.hash_password`` receives, so what a caller
            typed here is what they can log in with.

        Raises:
            ValueError: If fewer than :data:`PASSWORD_MIN_CHARACTER_CLASSES` of the five groups
                are present. Pydantic converts this into a field error whose ``message`` is
                :data:`_PASSWORD_VARIETY_MESSAGE`, which the exception handler copies into the
                problem document's ``errors`` list.
        """
        if len(_password_character_groups(password)) < PASSWORD_MIN_CHARACTER_CLASSES:
            raise ValueError(_PASSWORD_VARIETY_MESSAGE)
        return password


class LoginRequest(BaseModel):
    """Body of ``POST /api/v1/auth/login``: an email address and a password. Returns a
    :class:`TokenPair`.

    Two fields, and the *absence* of a rule on the second one is the design decision worth
    reading. :attr:`password` is not held to the registration policy, and deliberately so:

    * A minimum length or a character-group requirement on a submitted credential publishes
      the policy to anyone who can send a request, and tells them which candidates they need
      not try.
    * It would lock out any account whose password predates a later tightening of the policy.
      An existing credential is not made weaker by the rule changing, and a login route that
      refused to *accept the submission* would leave that account unable to sign in without a
      password reset - which this service does not offer.
    * The route's job is to answer whether these credentials are correct, and the answer to a
      credential that could never have been registered is "no", reported as a ``401`` like
      every other wrong answer. Reporting ``422`` instead would distinguish "malformed" from
      "wrong" on a route whose whole security value is that its failures are indistinguishable.

    :data:`PASSWORD_MAX_LENGTH` *is* applied, and it is not an exception to any of that. It is
    a bound on the work one request can cause rather than a judgement about the credential:
    login is where an unauthenticated caller reaches argon2 verification, and argon2 is
    memory-hard by design.

    ``extra="forbid"`` keeps a caller from smuggling anything else - a role, an account
    identifier, an expiry override - into the one route that mints credentials.

    The form-encoded equivalent
    ---------------------------
    ``python-multipart`` is a pinned dependency so this route can also accept FastAPI's
    :class:`~fastapi.security.OAuth2PasswordRequestForm`, which is what makes the **Authorize**
    control on ``/docs`` usable for exploring protected routes. That form's field is named
    ``username`` by the OAuth 2 password grant, and this API's identifier is an email address,
    so **the value to type into that form's "username" box is the account's email address.**
    No second credential model is declared for it: the form class is supplied by FastAPI, and
    this model remains the documented JSON contract.
    """

    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            # The same unmistakable placeholder as RegisterRequest, so a reader following
            # /docs from registration to login sees one consistent pair rather than two
            # values they have to reconcile.
            "example": {
                "email": "reader@example.com",
                "password": "example-only-Placeholder-1",
            }
        },
    )

    email: EmailStr = Field(
        ...,
        description=(
            "The email address the account registered with. Matched case-insensitively "
            "against the `CITEXT` column, so the casing used at registration does not have "
            "to be reproduced. An address that belongs to no account fails exactly as a wrong "
            "password does - 401, with the same body - so this route cannot be used to "
            "discover which addresses are registered. If the route is called with the OAuth2 "
            "password-grant form instead of this JSON body, this is the value that goes in "
            "that form's `username` field."
        ),
    )
    password: Annotated[str, StringConstraints(max_length=PASSWORD_MAX_LENGTH)] = Field(
        ...,
        description=(
            "The account's password, verified against the stored argon2id hash. Bounded at "
            f"{PASSWORD_MAX_LENGTH} characters, the same ceiling registration applies, purely "
            "to cap the cost of "
            "one verification. Deliberately subject to no minimum length and no "
            "character-group rule: enforcing the registration policy on a submitted "
            "credential would advertise that policy and would refuse a password that "
            "predates it. Sent exactly as typed - never trimmed - and a wrong value yields "
            "401 with no indication of which half of the pair was wrong."
        ),
    )


class TokenPair(BaseModel):
    """Response of ``POST /api/v1/auth/login`` and of ``POST /api/v1/auth/refresh``.

    The two tokens are different kinds of thing, and treating them alike is the mistake this
    class is documented to prevent:

    :attr:`access_token`
        A signed, stateless, short-lived assertion. It is not stored server-side and therefore
        cannot be withdrawn before it expires, which is why its lifetime is minutes.
    :attr:`refresh_token`
        An opaque, high-entropy, single-use value backed by a database row. Only its SHA-256
        digest is persisted, it is rotated on every use, and logout revokes it - so it *is*
        withdrawable, which is what lets its lifetime be days.

    Both fields are the only place either value ever appears in a response. A rotation returns
    a new pair and the presented refresh token stops working, so a client must replace both
    values together and must not keep the old refresh token as a fallback.

    ``extra="forbid"`` is deliberately **not** set here, matching
    :class:`~app.schemas.common.ProblemDetail`. Forbidding extras on a response model publishes
    ``additionalProperties: false`` into ``/openapi.json``, which would make adding a member to
    this body a breaking change for any strictly generated client. The guarantee that only
    these four members are emitted comes instead from there being one construction site, in
    ``app.services.auth_service``, and from the Pydantic mypy plugin's ``init_forbid_extra``
    rejecting an unknown keyword there at type-check time.

    Example body:

    .. code-block:: json

        {
          "access_token": "example-only.access-token.not-a-real-signature",
          "refresh_token": "example-only-refresh-token-not-a-real-value",
          "token_type": "bearer",
          "expires_in": 900
        }
    """

    model_config = ConfigDict(
        json_schema_extra={
            # Both token values are unmistakable placeholders. The access token keeps the
            # three-segment shape of a JWT so the field's structure is legible, while being
            # made of English words rather than base64 so it can never be mistaken for a real
            # credential harvested from a log. The refresh token likewise reads as prose
            # rather than as entropy. `expires_in` is 900 because ACCESS_TOKEN_EXPIRE_MINUTES
            # defaults to 15; it is an illustration of the arithmetic, not a guarantee of the
            # deployed value.
            "example": {
                "access_token": "example-only.access-token.not-a-real-signature",
                "refresh_token": "example-only-refresh-token-not-a-real-value",
                "token_type": "bearer",
                "expires_in": 900,
            }
        }
    )

    access_token: str = Field(
        ...,
        description=(
            "Signed JWT to send as `Authorization: Bearer <access_token>` on every "
            "authenticated request. Carries exactly five claims - subject, role, issued-at, "
            "expiry and token type - and is verified on each request rather than trusted, so "
            "a role it asserts is a hint for the client's UI and never the server's authority "
            "check. Short-lived and not revocable before expiry: hold it in memory, do not "
            "persist it, and replace it through the refresh route rather than reusing it past "
            "`expires_in`."
        ),
    )
    refresh_token: str = Field(
        ...,
        description=(
            "Opaque credential used only to obtain the next pair, at "
            "`POST /api/v1/auth/refresh`, and to end the session, at "
            "`POST /api/v1/auth/logout`. **Not a JWT** - there is nothing inside it to decode, "
            "no claims to read and no expiry to inspect, and its format is not part of this "
            "contract; store the string exactly as received and send it back unchanged. "
            "Single-use: a successful refresh returns a new pair and revokes this one, so "
            "replace both values together and never retry a refresh with a token that has "
            "already been exchanged. Longer-lived than the access token, revocable at any "
            "time, and held only as a hash on the server - so this response is the one and "
            "only time its value is available."
        ),
    )
    token_type: Literal["bearer"] = Field(
        default="bearer",
        description=(
            "The authentication scheme to use with `access_token`, always the literal "
            "`bearer`. Declared as a single-valued type rather than a free string so it is "
            "self-documenting in the OpenAPI schema and cannot vary between two responses - "
            "a client may hard-code the scheme and use this field as confirmation."
        ),
    )
    expires_in: int = Field(
        ...,
        gt=0,
        description=(
            "Seconds until `access_token` expires, counted from when this response was "
            "issued. Derived from the service's configured `ACCESS_TOKEN_EXPIRE_MINUTES` and "
            "supplied by the caller that minted the token, so a client can schedule a refresh "
            "without decoding the token and without assuming a lifetime. Treat it as a "
            "relative duration, not an absolute instant, and refresh a little early: the "
            "encoded expiry is truncated to whole seconds and network latency is not counted "
            "here. Always positive - a non-positive value would advertise a credential that "
            "is already unusable."
        ),
    )


class RefreshRequest(BaseModel):
    """Body of ``POST /api/v1/auth/refresh`` and of ``POST /api/v1/auth/logout``.

    One field, and one model for both routes, because both do the same thing to the same value:
    they present a refresh token so the server can find its row by digest. Refresh then rotates
    it and answers with a new :class:`TokenPair`; logout revokes it and answers ``204 No
    Content``. A separate class per route would be two names for one identical shape.

    The token travels in the body rather than in an ``Authorization`` header, which is the
    conventional split and also the practical one: the header on these routes carries the
    *access* token when there is one, and the two credentials must not be confused.
    :func:`app.core.security.decode_access_token` enforces the other half of that separation by
    requiring a ``type`` claim of ``access``, so a refresh token cannot be replayed as a bearer
    credential even though presenting one here is legitimate.

    ``extra="forbid"`` applies here too. Nothing else belongs in a rotation request - not a
    subject, not a role, not a requested lifetime - and forbidding extras means an attempt to
    add one is reported rather than ignored.
    """

    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            # Identical to the placeholder in TokenPair's example, so the round trip reads
            # correctly on /docs: this is the value the previous response handed back.
            "example": {"refresh_token": "example-only-refresh-token-not-a-real-value"}
        },
    )

    refresh_token: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True,
            min_length=1,
            max_length=REFRESH_TOKEN_MAX_LENGTH,
        ),
    ] = Field(
        ...,
        description=(
            "The refresh token from the most recent `TokenPair`, sent back exactly as it was "
            "received. Surrounding whitespace is removed, which cannot alter a valid token - "
            "the issued alphabet contains none - and turns a value pasted with a stray space "
            "into a working request. An empty or whitespace-only value is rejected as 422 "
            "rather than looked up; any other value that does not match a live, unexpired, "
            "unrevoked token yields 401 without saying which of those it failed. Bounded at "
            f"{REFRESH_TOKEN_MAX_LENGTH} characters, comfortably above the length actually "
            "issued, so the bound "
            "limits abuse without tying this contract to the generator's entropy setting."
        ),
    )
