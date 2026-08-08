"""The typed configuration contract for the blog service tier.

``app.core.config`` is the **only** module in this repository that reads the process
environment, and the validated singleton it exposes is how every other module reaches a
configured value::

    from app.core.config import settings

``app.main``, ``app.db.session``, ``app.db.seed``, ``app.core.security``,
``app.core.logging``, ``app.core.rate_limit`` and ``migrations/env.py`` all import that
one name. No module under ``backend/app/`` reaches for the environment itself - there is
no ``os`` environment lookup and no dotenv loader anywhere in the package, including this
file, which delegates the reading to ``pydantic-settings``. Keeping every read in one
place is what makes the answer to "where does this value come from?" a single lookup, and
what makes ``.env.example`` an enforced contract rather than documentation that drifts
away from the code.

Eleven variables, and exactly three tolerated strangers
------------------------------------------------------
The eleven fields of :class:`Settings` mirror the eleven backend keys in the
repository-root ``.env.example`` field for field and name for name. The three keys in
that file's FRONTEND block belong to the Next.js tier - they are inlined into the client
bundle at build time, and are public by design - so they are deliberately absent here.

One ``.env`` nonetheless has to serve both tiers, and the mechanism that allows it is
deliberately narrow. ``extra`` is ``"forbid"``, and a single ``mode="before"`` model
validator drops exactly the four names listed in :data:`_FRONTEND_ENV_KEYS` before
validation sees them. Every *other* unrecognised key in an env file is therefore a startup
failure. That asymmetry is the point: a blanket ``extra="ignore"`` would swallow
``DATABSE_URL``, ``JWT_SECRET`` or ``ENVIRONMNET`` in silence and boot the service against
whatever the field default happened to be - which, for a security-relevant key, is the
worst possible outcome dressed up as a clean start. Naming the four exceptions instead
means the file can be shared *and* a typo is loud.

Where a value comes from
------------------------
Highest precedence first:

1. a real environment variable - how a container runtime and CI supply values;
2. ``backend/.env`` - a local, per-checkout override;
3. ``.env`` at the repository root - the file ``cp .env.example .env`` creates;
4. the field default declared below, where the field has one.

Both env files are resolved to absolute paths from this module's own location rather than
from the process working directory. The canonical launch is ``uvicorn app.main:app`` run
from inside ``backend/`` (Alembic and ``python -m app.db.seed`` run from there too), so a
bare relative ``".env"`` would look in ``backend/`` and miss the documented,
git-ignored file that sits at the repository root next to ``.env.example``. A missing env
file is not an error: in a container every value arrives as a real environment variable.

Failing fast
------------
Misconfiguration is a startup failure, never a runtime 500.

Six variables have **no default at all**, so their absence stops the process instead of
selecting a value nobody chose: ``DATABASE_URL``, ``JWT_SECRET_KEY``,
``CORS_ALLOW_ORIGINS``, ``ENVIRONMENT``, ``SEED_ADMIN_EMAIL`` and
``SEED_ADMIN_PASSWORD``. None of the six can be given a safe default in source. A
connection URL and an origin list are deployment facts, and writing either one here would
hard-code a credential and a trusted origin into the repository - the exact thing
``.env.example`` exists to prevent. ``ENVIRONMENT`` decides whether the documentation
routes are exposed and whether transport security is pinned, so defaulting it to
``development`` means a deployment that forgets to set it silently runs with the least
hardened profile. The two seed values are half and all of an administrator credential.

What the remaining validation asserts:

* the connection URL is a complete async psycopg 3 DSN - correct scheme, a host, a port
  inside 1-65535 if one is given, and a database name - so a URL pointed at nothing fails
  here rather than on the first query;
* every CORS entry is a bare ``http``/``https`` origin with no userinfo, path, query or
  fragment, because ``CORSMiddleware`` compares the ``Origin`` header verbatim and a
  malformed entry silently never matches;
* the signing key is at least as long as the configured algorithm's digest - 32, 48 or 64
  bytes for ``HS256``, ``HS384`` and ``HS512`` - which is what PyJWT itself measures
  (RFC 7518 section 3.2), so no combination of key and algorithm can reach ``jwt.encode``
  already warning about its own strength;
* the seeded administrator password satisfies the whole registration policy - length,
  character variety - and is not a placeholder published in ``.env.example`` or a trivial
  variation of one, refused in *every* stage because it is hashed into the only ``ADMIN``
  account the product creates itself;
* no other credential still holds the placeholder value published in ``.env.example``
  outside ``development`` and ``test``; and
* ``JWT_ALGORITHM``, ``ENVIRONMENT`` and ``LOG_LEVEL`` are closed sets rather than free
  strings.

No message ever quotes the value it rejected. ``hide_input_in_errors`` covers what pydantic
itself renders, and every validator below is written to report the variable and the reason
only - a length, a scheme, a missing component - so a rejected secret, a credential-bearing
URL or an origin with userinfo in it cannot reach a log, a traceback or a CI transcript.
Measured on the pinned pydantic 2.13.4: with a password-bearing URL rejected, the offending
value appears in neither ``str(exc)`` nor ``repr(exc)``, which are the two forms an uncaught
startup failure prints.

One boundary belongs with that guarantee rather than after it. ``hide_input_in_errors``
governs the *rendered* forms only; ``ValidationError.errors()`` and ``.json()`` still carry
the raw input under an ``input`` key, because that is how pydantic reports structured errors.
Nothing in this backend catches the failure below - it is meant to end the process - and
nothing may start to: catching it in order to serialise ``errors()`` into a log or a response
would republish the value this module works to keep out of both. If a caller ever needs the
detail programmatically, take ``str(exc)``, which is already sanitised.

The credential policy lives here
--------------------------------
Two credential rules are declared in this module and nowhere else: the per-algorithm
minimum size of the HMAC signing key, and the password policy every new password is held
to. Both are here for the same structural reason. This module is the only one in the
package that imports no ``app`` sibling, so it is the only place a rule can sit and still
be reachable from *both* directions - from :class:`Settings`, which has to validate an
environment-supplied credential while the process is starting, and from
``app.schemas.auth``, which has to publish the same numbers in ``/openapi.json`` and
reject the same passwords on ``POST /api/v1/auth/register``. Declaring the policy in the
schema layer instead would put it above the module that needs it and force either a
duplicate or an inverted import; declaring it in ``app.core.security`` is impossible,
because that module imports this one. So ``SEED_ADMIN_PASSWORD`` and a reader's chosen
password are measured by exactly one function, :func:`password_policy_violation`, and a
policy change is a one-line edit that both paths inherit.

Import purity
-------------
This module imports ``pydantic``, ``pydantic-settings`` and the standard library, and
nothing else - no ``app`` sibling, no SQLAlchemy, no engine, no logging configuration.
``backend/alembic.ini`` deliberately declares no ``sqlalchemy.url`` so that
``migrations/env.py`` can take the URL from here and the application and its migrations
share one source of truth; every ``alembic upgrade head``, ``alembic downgrade base`` and
``alembic check`` therefore imports this file, and it has to stay cheap. Constructing
:data:`settings` is its only import-time effect - which is also why ``app.schemas.auth``,
the one schema module that imports this one, imports it for the credential policy alone
and still reads no setting of its own.
"""

import re
from collections.abc import Mapping
from pathlib import Path
from types import MappingProxyType
from typing import Annotated, Any, Final, Literal, Self
from urllib.parse import urlsplit

from pydantic import EmailStr, Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

__all__ = [
    "PASSWORD_CHARACTER_GROUPS",
    "PASSWORD_MAX_LENGTH",
    "PASSWORD_MIN_CHARACTER_CLASSES",
    "PASSWORD_MIN_LENGTH",
    "PASSWORD_VARIETY_MESSAGE",
    "JwtAlgorithm",
    "Settings",
    "password_character_groups",
    "password_policy_violation",
    "settings",
]


# ---------------------------------------------------------------------------------------
# Filesystem anchors
#
# This module is backend/app/core/config.py, so ``parents[2]`` is backend/ and its parent
# is the repository root. Deriving both from ``__file__`` keeps env-file discovery
# independent of the working directory the process happens to be started from.
# ---------------------------------------------------------------------------------------
_BACKEND_DIR: Final[Path] = Path(__file__).resolve().parents[2]
_REPO_ROOT: Final[Path] = _BACKEND_DIR.parent

# Loaded in order, so a value in backend/.env overrides the same key in the repository
# root .env, and a real environment variable overrides both. Absent files are skipped.
_ENV_FILES: Final[tuple[Path, Path]] = (_REPO_ROOT / ".env", _BACKEND_DIR / ".env")


# ---------------------------------------------------------------------------------------
# The four keys this model tolerates but does not declare
#
# The FRONTEND block of .env.example. They are inlined into the Next.js bundle at build
# time and are public by design, so they carry no secret and mean nothing to this tier -
# but one .env serves both tiers, so they arrive here anyway. Listing them by exact name is
# what lets `extra` stay "forbid": these four are dropped, and every other unrecognised
# key in an env file stops the process. A name added to .env.example's FRONTEND block must
# be added here too, or the service will refuse to start with it present.
# ---------------------------------------------------------------------------------------
_FRONTEND_ENV_KEYS: Final[frozenset[str]] = frozenset(
    {
        "NEXT_PUBLIC_API_BASE_URL",
        "NEXT_PUBLIC_SITE_URL",
        "NEXT_PUBLIC_SITE_NAME",
        "NEXT_PUBLIC_IMAGE_HOST_ALLOWLIST",
    }
)


# ---------------------------------------------------------------------------------------
# Authentication invariants
# ---------------------------------------------------------------------------------------
JwtAlgorithm = Literal["HS256", "HS384", "HS512"]
"""The HMAC algorithms this service will sign with.

A named alias rather than an inline annotation because :data:`_JWT_SECRET_KEY_MIN_BYTES` is
keyed by it: the two declarations sit next to each other so that adding a member to one and
not the other is visible in a single screen, and so the lookup in
:meth:`Settings._validate_signing_key_size` needs no fallback branch.
"""

# RFC 7518 section 3.2 requires an HMAC key at least as long as the hash the algorithm
# produces, and PyJWT enforces exactly that: `HMACAlgorithm.check_key_length` compares the
# key against `hash_alg().digest_size` and emits InsecureKeyLengthWarning below it. The
# three numbers below are those digest sizes, verified against the pinned PyJWT 2.13.0 - a
# 32-byte key is adequate for HS256 and warned about under both HS384 and HS512. Enforced as
# a hard startup gate rather than a warning: a warning is something a deployment can ignore,
# and a token signed with an under-strength key is worse than no service at all.
#
# The floor is PER ALGORITHM, not fixed, so a single fixed minimum cannot accept exactly the
# configuration PyJWT treats as insecure. Measured in BYTES rather than characters, because
# bytes are what the HMAC construction consumes and what PyJWT measures after `force_bytes`:
# a passphrase of accented or CJK characters encodes to more bytes than it has characters.
_JWT_SECRET_KEY_MIN_BYTES: Final[Mapping[JwtAlgorithm, int]] = MappingProxyType(
    {
        "HS256": 32,
        "HS384": 48,
        "HS512": 64,
    }
)

# The floor that holds whatever the algorithm - the smallest entry in the table above - so a
# key that is short for every algorithm is reported against its own variable. A field
# validator sees one field, and they run in declaration order with JWT_SECRET_KEY declared
# first, so the algorithm-specific comparison has to be a model validator that runs once both
# values are known.
_JWT_SECRET_KEY_MIN_LENGTH: Final[int] = min(_JWT_SECRET_KEY_MIN_BYTES.values())


# ---------------------------------------------------------------------------------------
# Password policy
#
# The single declaration of what makes a password acceptable. Two paths are held to it, and
# there is exactly one definition between them: `app.schemas.auth` publishes these numbers in
# /openapi.json and enforces them on POST /api/v1/auth/register, and `Settings` below applies
# them to SEED_ADMIN_PASSWORD so the seeded administrator - frequently the only ADMIN
# principal a deployment has - cannot be created with a credential the registration route
# would have refused, or with one so long that every later login is rejected. See "The
# credential policy lives here" in the module docstring for why the rules sit in this module
# rather than in the schema layer that publishes them.
# ---------------------------------------------------------------------------------------

PASSWORD_MIN_LENGTH: Final[int] = 12
"""Shortest accepted new password, in characters.

Length is the property that actually resists an offline attack on a stolen
``users.password_hash``: each additional character multiplies the search space, where a
composition rule only rearranges it. Twelve is the floor, and
:data:`PASSWORD_MIN_CHARACTER_CLASSES` is what keeps a twelve-character password from also
being a single-alphabet one.
"""

PASSWORD_MAX_LENGTH: Final[int] = 128
"""Longest accepted password, in characters, on registration and on login alike.

A denial-of-service bound rather than a storage limit. ``users.password_hash`` is unbounded
``TEXT`` precisely so an argon2id hash may grow when its cost parameters are tuned, and
``app.core.security.hash_password`` passes the plaintext through unmodified: argon2 is
memory-hard and intentionally slow, so an unbounded input on an unauthenticated route is an
amplification primitive. One hundred and twenty-eight characters is far above any password a
human composes, so the bound costs no legitimate caller anything.

It bounds ``SEED_ADMIN_PASSWORD`` for a second, sharper reason. ``LoginRequest`` applies this
same ceiling, so a longer seeded password would hash and store perfectly well and then be
refused at every login attempt - an administrator account that exists and cannot be used.
"""

PASSWORD_MIN_CHARACTER_CLASSES: Final[int] = 3
"""How many of the five character groups a new password must draw on.

Three of five. ``alllowercaseonly`` clears the length floor and is still trivially
enumerable, so requiring variety is what makes the stated minimum length mean something.
Three rather than all five, because a rule nobody can satisfy without a password manager is a
rule that produces written-down passwords. The groups are listed in
:data:`PASSWORD_CHARACTER_GROUPS`.
"""

PASSWORD_CHARACTER_GROUPS: Final[tuple[str, ...]] = (
    # Indexed by the _GROUP_* constants below, in this exact order. Adding a group means
    # adding its constant, its branch in password_character_groups, and a line here.
    "a lowercase letter",
    "an uppercase letter",
    "a digit",
    "a letter from a script that has no letter case, such as CJK, Hebrew or Arabic",
    "any other character, such as a symbol, a punctuation mark or a space",
)
"""The five character groups :data:`PASSWORD_MIN_CHARACTER_CLASSES` counts, as prose.

The list is the single source of the wording, so the field description a caller reads, the
validation message a rejected caller receives and any client mirroring the policy all quote
the same five phrases rather than three drifting paraphrases of them.

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

PASSWORD_VARIETY_MESSAGE: Final[str] = (
    f"Password must contain characters from at least {PASSWORD_MIN_CHARACTER_CLASSES} of these "
    f"{len(PASSWORD_CHARACTER_GROUPS)} groups: {'; '.join(PASSWORD_CHARACTER_GROUPS)}."
)
"""The rejection message for a password that clears the length floor but not the group floor.

Built from :data:`PASSWORD_CHARACTER_GROUPS` rather than written out, so the message and the
documented policy cannot disagree. It is a complete, self-contained sentence on purpose:
``app.core.exceptions`` copies a validator's message verbatim into the ``message`` member of
each entry in the problem document's ``errors`` list, so this string is what a client renders
beside the password field. It names what is required and never quotes what was submitted -
``app.schemas.common.ValidationErrorItem`` drops pydantic's ``input`` key specifically so that
a rejected password cannot reach a response body or an access log.
"""


def password_character_groups(password: str) -> frozenset[int]:
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

    Every character is examined rather than stopping once three groups have been found. Callers
    bound the input at :data:`PASSWORD_MAX_LENGTH`, so the loop is short, and returning the
    complete set keeps the result meaningful to a caller that wants to report what was present
    rather than only whether it was enough.

    Args:
        password: The candidate password, exactly as it was supplied.

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


def password_policy_violation(password: str) -> str | None:
    """Report why ``password`` is unacceptable as a new password, or ``None`` when it is fine.

    The whole policy in one call: too short, too long, or drawing on too few character groups.
    It returns a message rather than raising so that each caller can frame the failure for its
    own audience - ``app.schemas.auth`` reports it against the ``password`` member of a request
    body and :meth:`Settings._validate_seed_admin_password` reports it against an environment
    variable name - while the *rule* stays singular.

    Order matters. Length is reported before variety, so a caller who typed four characters is
    told the length rule rather than the length rule *and* the group rule at once, and has one
    actionable sentence to act on. ``app.schemas.auth`` reaches the same outcome from the other
    direction: its ``StringConstraints`` reject a length violation before any validator runs,
    so the only verdict this function ever returns there is the variety one.

    Nothing here trims, folds or re-encodes, and no message quotes the candidate. Whitespace is
    significant in a password - trimming it would change the credential - and a rejected
    password must not reach a validation message, a log line or a traceback.

    Args:
        password: The candidate password, exactly as it was supplied.

    Returns:
        A complete, self-contained sentence naming the first rule that was not met, or ``None``
        when the password satisfies every rule.
    """
    if len(password) < PASSWORD_MIN_LENGTH:
        return f"Password must be at least {PASSWORD_MIN_LENGTH} characters."
    if len(password) > PASSWORD_MAX_LENGTH:
        return f"Password must be at most {PASSWORD_MAX_LENGTH} characters."
    if len(password_character_groups(password)) < PASSWORD_MIN_CHARACTER_CLASSES:
        return PASSWORD_VARIETY_MESSAGE
    return None


# ---------------------------------------------------------------------------------------
# Placeholder credentials published in .env.example
#
# Every credential value that file commits. They are public knowledge by definition - the
# repository is where they are published - so they are usable for local work and worthless
# anywhere else. `cp .env.example .env` has to keep working, which is why they are accepted
# under ENVIRONMENT=development and ENVIRONMENT=test and rejected under everything else.
# Values only; the variable names are attached at the point of the check, so this set has
# no bearing on which variable a value happens to be found in.
# ---------------------------------------------------------------------------------------
_COMMITTED_PLACEHOLDER_CREDENTIALS: Final[frozenset[str]] = frozenset(
    {
        # JWT_SECRET_KEY. Clears the 32-byte floor, which is exactly why length alone is
        # not a sufficient check.
        "change-me-change-me-change-me-change-me",
        # SEED_ADMIN_PASSWORD.
        "ChangeMe-Admin-Password-1",
        # SEED_ADMIN_EMAIL. example.com is reserved by RFC 2606 and can never be a real
        # deployment address, so this one is a misconfiguration rather than a leak - but it
        # is half of the administrator credential, so it fails the same gate.
        "admin@example.com",
    }
)

_LOCAL_ENVIRONMENTS: Final[frozenset[str]] = frozenset({"development", "test"})
"""Stages in which the committed placeholder credentials above are acceptable.

`staging` is deliberately absent. It is a deployment, reachable by someone other than the
developer who started it, and a credential published in a public repository protects it no
better than no credential at all.
"""


# ---------------------------------------------------------------------------------------
# Seeded administrator credential placeholders
#
# SEED_ADMIN_PASSWORD becomes the password of the only ADMIN principal `python -m
# app.db.seed` creates, so it is the most privileged credential in the product and is held
# to exactly the policy declared above - a privileged account measured against a weaker
# standard than a reader's is the wrong way round, and `password_policy_violation` is the one
# place that standard is written. Length and variety are that function's business; what
# follows is the one rule it cannot express, because a published value can score perfectly on
# both and still be public knowledge.
# ---------------------------------------------------------------------------------------
# Values that are published in this repository, or are simply well known, and therefore
# confer no secrecy however well they score on length and variety. `.env.example` ships
# `ChangeMe-Admin-Password-1`, which is twenty-five characters drawing on three groups: it
# would pass every other rule here, which is precisely why this check exists.
#
# Compared in reduced form - case-folded with every non-alphanumeric character removed - so
# punctuation and capitalisation cannot disguise a placeholder. The reduction is applied to
# both sides at startup, hence the readable spellings below.
_SEED_ADMIN_PASSWORD_PLACEHOLDERS: Final[frozenset[str]] = frozenset(
    {
        "ChangeMe-Admin-Password-1",
        "change-me-change-me-change-me-change-me",
        "changeme",
        "change-me",
        "change-this",
        "password",
        "password1",
        "password123",
        "passw0rd",
        "admin",
        "admin123",
        "administrator",
        "adminpassword",
        "letmein",
        "welcome",
        "qwerty",
        "secret",
        "topsecret",
        "supersecret",
        "notsecure",
        "insecure",
        "test",
        "testing",
        "example",
        "placeholder",
        "seedadminpassword",
        "yourpasswordhere",
    }
)

# Reduced prefixes that mark a value as a variation on a placeholder rather than a secret,
# which is what catches the counter-bumping edit - `ChangeMe-Admin-Password-2` - that an
# exact list never will. Kept short and specific: each stem is a word that appears in a
# published placeholder or an instruction to replace one, so a real passphrase does not
# begin with it by accident.
_SEED_ADMIN_PASSWORD_PLACEHOLDER_STEMS: Final[tuple[str, ...]] = (
    "changeme",
    "changethis",
    "replaceme",
    "yourpassword",
    "placeholder",
    "seedadmin",
    "insecure",
)


# ---------------------------------------------------------------------------------------
# Database URL
#
# psycopg 3 is the single driver in this project: the same URL serves the async
# application engine and the synchronous engine Alembic drives, which is why one
# DATABASE_URL is sufficient and why the scheme is not negotiable.
# ---------------------------------------------------------------------------------------
_DATABASE_URL_SCHEME: Final[str] = "postgresql+psycopg"
_DATABASE_URL_PREFIX: Final[str] = f"{_DATABASE_URL_SCHEME}://"

# Every wrong scheme anyone actually reaches for, with the reason it cannot work. Keyed
# case-insensitively so `POSTGRES://` still gets the specific explanation.
_DATABASE_URL_SCHEME_HINTS: Final[dict[str, str]] = {
    "postgres": "`postgres://` is a libpq alias that SQLAlchemy does not register",
    "postgresql": "SQLAlchemy resolves a bare `postgresql://` to psycopg2, which is not "
    "a dependency of this project",
    "postgresql+psycopg2": "psycopg2 is not a dependency; psycopg 3 replaces it",
    "postgresql+asyncpg": "asyncpg is deliberately excluded - psycopg 3 already serves "
    "both the async application and synchronous Alembic, and a second driver would "
    "double the connection surface for no benefit",
    "sqlite": "PostgreSQL is the system of record; there is no SQLite fallback",
    "sqlite+aiosqlite": "PostgreSQL is the system of record; there is no SQLite fallback",
    "mysql": "PostgreSQL is the system of record; citext, pg_trgm and the generated "
    "tsvector column this schema depends on have no MySQL equivalent",
}
_DATABASE_URL_GENERIC_HINT: Final[str] = (
    "psycopg 3 is the only driver this project installs, and the scheme is matched "
    "exactly, in lower case"
)

# The shape every message about a malformed URL quotes instead of the URL itself.
_DATABASE_URL_EXPECTED: Final[str] = f"{_DATABASE_URL_PREFIX}user:password@host:port/database"

# TCP port range. Checked explicitly because `urlsplit` accepts any digits in the authority
# and only complains when `.port` is read, and because a port of 0 or 70000 is a typo that
# would otherwise surface as a connection refusal minutes into a deployment.
_MIN_TCP_PORT: Final[int] = 1
_MAX_TCP_PORT: Final[int] = 65535


# ---------------------------------------------------------------------------------------
# Cross-origin access
#
# CORSMiddleware compares the browser's `Origin` header against these entries verbatim, so
# an entry that is not a bare origin can never match and surfaces in the client as an
# unexplained CORS failure rather than as a server error. Only the two schemes a browser
# can actually send an Origin for are accepted: a `file:`, `chrome-extension:` or `ws:`
# entry is a configuration mistake, and userinfo in an origin is a credential written into
# a list that is logged and echoed.
# ---------------------------------------------------------------------------------------
_CORS_ALLOWED_SCHEMES: Final[frozenset[str]] = frozenset({"http", "https"})
_CORS_WILDCARD: Final[str] = "*"
_CORS_EXPECTED: Final[str] = (
    "each entry must be scheme://host[:port] using http or https, with no userinfo, no "
    "path, no query and no trailing slash, and entries are separated by commas - not JSON. "
    "Example: CORS_ALLOW_ORIGINS=http://localhost:3000,http://127.0.0.1:3000"
)


# ---------------------------------------------------------------------------------------
# Rate-limit expression
#
# Deliberately a subset of what the `limits` parser behind slowapi accepts, verified
# against the installed release: full granularity names only (it rejects abbreviations
# such as `10/m`), separated by a comma, semicolon or pipe. Anything this module accepts,
# app.core.rate_limit can therefore parse - so a typo fails at startup rather than at the
# first login attempt.
# ---------------------------------------------------------------------------------------
_RATE_LIMIT_SEPARATORS: Final[re.Pattern[str]] = re.compile(r"[,;|]")
_RATE_LIMIT_ITEM: Final[re.Pattern[str]] = re.compile(
    r"""
    \s*(?P<count>[0-9]+)                                    # requests allowed
    \s*(?:/|\s*per\s*)                                      # `/` or the word `per`
    \s*(?P<multiple>[0-9]+)?                                # window multiple: 2 in 5/2m
    \s*(?P<granularity>second|minute|hour|day|month|year)s?  # window unit
    \s*
    """,
    re.IGNORECASE | re.VERBOSE,
)


def _reduced_secret(value: str) -> str:
    """Reduce a candidate secret to the form placeholder comparison uses.

    Case-folded, with every non-alphanumeric character removed, so that ``ChangeMe`` and
    ``change-me`` and ``C.h.a.n.g.e.M.e`` all reduce to ``changeme``. Reducing both sides of
    the comparison is what stops punctuation or capitalisation from disguising a published
    value as a secret.

    The reduction deliberately does not fold digits or transliterate look-alike characters:
    ``P@ssw0rd!2024`` reduces to ``pssw0rd2024``, which matches nothing in
    :data:`_SEED_ADMIN_PASSWORD_PLACEHOLDERS`, so a genuinely different secret is never
    rejected for resembling one. The check errs towards accepting rather than towards
    guessing, because a false rejection blocks a legitimate deployment.

    Args:
        value: The candidate secret, unmodified.

    Returns:
        The reduced form, which may be empty for a value made entirely of punctuation.
    """
    return "".join(character for character in value.casefold() if character.isalnum())


class Settings(BaseSettings):
    """Validated, immutable-by-convention view of the eleven backend variables.

    Instantiated exactly once, at import time, as :data:`settings`. Every field is typed
    and constrained so that a misconfigured deployment fails while it is still starting
    up, with a message that names the variable and what it expected, instead of surfacing
    later as an authentication failure or a 500.

    The instance is treated as read-only by convention rather than declared ``frozen``:
    the test suite overrides individual values on the shared singleton with
    ``monkeypatch.setattr``, which a frozen model would forbid.
    """

    model_config = SettingsConfigDict(
        # Absolute paths, in ascending precedence - see the module docstring.
        env_file=_ENV_FILES,
        env_file_encoding="utf-8",
        # The field names below are the environment variable names, spelled exactly as
        # .env.example spells them. No case folding, so `database_url` is not DATABASE_URL.
        case_sensitive=True,
        # FAIL CLOSED on anything unrecognised. One .env serves both tiers, so it carries
        # the four client keys from the FRONTEND block of .env.example that this model does
        # not declare - and `_drop_frontend_keys` below removes exactly those three, by
        # name, before validation runs. Everything else unknown is a startup failure, which
        # is what turns `DATABSE_URL` or `ENVIRONMNET` from a silent fallback to a default
        # into an error naming the key. `extra="ignore"` would suppress both cases alike.
        extra="forbid",
        # Hold the defaults declared below to the same validators as an env-supplied
        # value, so a committed default can never drift out of its own contract.
        validate_default=True,
        # Keep rejected values - a short signing key, a URL with a password in it - out of
        # validation messages, which are printed to stderr and captured by log collectors.
        hide_input_in_errors=True,
    )

    # -- Database -----------------------------------------------------------------------

    DATABASE_URL: str = Field(
        # No default, by design. A connection URL carries a credential and names a specific
        # host, so any value written here would be a hard-coded credential in the
        # repository and, worse, a working fallback: a deployment that failed to supply the
        # variable would quietly try to reach a database on its own loopback interface
        # instead of stopping. `.env.example` carries the local placeholder, and
        # `cp .env.example .env` is how a checkout gets one. repr=False keeps the URL, and
        # the password inside it, out of `repr(settings)`.
        repr=False,
        description=(
            "PostgreSQL 18 connection URL in async psycopg 3 form, "
            f"{_DATABASE_URL_EXPECTED}. Required, with no fallback. The placeholder in "
            ".env.example matches the credentials and published port of the local "
            "PostgreSQL 18 service the AAP's container topology defines, so a local "
            "database needs no further configuration; it is a local placeholder, never a "
            "deployment credential. Point it at a separate database for a test run rather "
            "than adding another variable."
        ),
    )

    # -- Authentication -----------------------------------------------------------------

    JWT_SECRET_KEY: str = Field(
        # No default, by design: an absent signing key must stop the service rather than
        # fall back to a value published in this repository. repr=False keeps the key out
        # of `repr(settings)`, the most common way a secret reaches a log by accident.
        repr=False,
        description=(
            "HMAC key that signs every access and refresh token. Required, with no "
            "fallback, and at least as many bytes as the configured JWT_ALGORITHM hashes "
            f"to: {_JWT_SECRET_KEY_MIN_BYTES['HS256']} for HS256, "
            f"{_JWT_SECRET_KEY_MIN_BYTES['HS384']} for HS384, "
            f"{_JWT_SECRET_KEY_MIN_BYTES['HS512']} for HS512. Generate one per environment "
            "with `openssl rand -hex 32` and never reuse it."
        ),
    )

    JWT_ALGORITHM: JwtAlgorithm = Field(
        default="HS256",
        description=(
            "Token signing algorithm. Restricted to the HMAC family because "
            "JWT_SECRET_KEY is a single shared secret; an RS or ES algorithm needs a key "
            "pair and would be a configuration error here rather than a preference. The "
            "choice raises the minimum size of that key, because RFC 7518 section 3.2 "
            "requires an HMAC key at least as large as the hash output."
        ),
    )

    ACCESS_TOKEN_EXPIRE_MINUTES: int = Field(
        default=15,
        ge=1,
        le=1440,
        description=(
            "Access-token lifetime in minutes. Short by design: an access token is a "
            "bearer credential that cannot be withdrawn before it expires, so the window "
            "is bounded at one day even when configured deliberately."
        ),
    )

    REFRESH_TOKEN_EXPIRE_DAYS: int = Field(
        default=7,
        ge=1,
        le=365,
        description=(
            "Refresh-token lifetime in days. Refresh tokens rotate on every use and are "
            "stored only as hashes, so this bounds an idle session rather than an active "
            "one."
        ),
    )

    # -- Cross-origin access ------------------------------------------------------------

    # NoDecode suppresses the JSON pre-parse pydantic-settings applies to complex field
    # types, which raises SettingsError on the comma-separated form .env.example
    # documents. The `mode="before"` validator below does the splitting instead, so the
    # attribute app.main hands to CORSMiddleware is always a list[str].
    CORS_ALLOW_ORIGINS: Annotated[list[str], NoDecode] = Field(
        # No default, by design. This list is the set of origins allowed to read API
        # responses from a browser, which makes it a security boundary rather than a
        # convenience: a default would mean a deployment that never configured it still
        # trusted whatever origins were convenient during development. `.env.example`
        # carries the two loopback spellings a local checkout needs.
        description=(
            "Comma-separated browser origins permitted to call the API. Required, with no "
            "fallback. Each entry is a complete http or https origin - scheme, host and "
            "port - with no userinfo, no path and no trailing slash, because "
            "CORSMiddleware compares the request Origin header verbatim. .env.example "
            "lists both loopback spellings the development server and the end-to-end "
            "runner use, which a browser treats as different origins."
        ),
    )

    # -- Observability ------------------------------------------------------------------

    ENVIRONMENT: Literal["development", "test", "staging", "production"] = Field(
        # No default, by design, and this is the most consequential of the six. Defaulting
        # it to `development` means a deployment that forgets the variable runs with the
        # least hardened profile of all: interactive documentation exposed, no transport
        # security pinned, human-readable logs no collector can parse, and the committed
        # placeholder credentials accepted. Every one of those is a decision a deployment
        # must make explicitly, so an absent value stops the process instead.
        description=(
            "Deployment stage: development, test, staging or production. Required, with no "
            "fallback. It selects console-readable versus JSON structured logging, decides "
            "whether the interactive documentation routes are exposed, whether HSTS is "
            "pinned, and whether the placeholder credentials .env.example publishes are "
            "accepted - so it is a security boundary as well as a formatting choice. "
            "`test` exists for the test suite: app.core.rate_limit disables the limiter "
            "under it, so a suite that exercises register, login, refresh and logout "
            "repeatedly cannot go flaky by tripping the authentication limit."
        ),
    )

    LOG_LEVEL: Literal["CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"] = Field(
        default="INFO",
        description=(
            "Logging threshold applied by app.core.logging. A closed set, so a typo "
            "fails at startup instead of silently producing a service that logs nothing."
        ),
    )

    # -- Rate limiting ------------------------------------------------------------------

    AUTH_RATE_LIMIT: str = Field(
        # Five per minute, matching .env.example. A default is correct here - unlike the six
        # required variables above, an absent value must not leave the authentication routes
        # unlimited - and it is deliberately strict: registration, login and refresh are the
        # endpoints an attacker replays, and five attempts a minute is generous for a person
        # and useless for a script. A deployment that needs more says so.
        default="5/minute",
        description=(
            "Limit applied to the authentication routes as a slowapi/limits expression: "
            '"<count>/<period>", where period is second, minute, hour, day, month or '
            'year - for example "5/minute" or "100/hour". Combine several limits with a '
            'semicolon, as in "5/minute;100/hour". Mirrors the .env.example placeholder.'
        ),
    )

    # -- Seed data ----------------------------------------------------------------------

    SEED_ADMIN_EMAIL: EmailStr = Field(
        # No default, by design. This names the identity of the only ADMIN principal the
        # seed creates, so a default would mean every deployment that forgot to set it
        # created an administrator at an address published in this repository - and, because
        # seeding is idempotent and refuses to overwrite, an operator who noticed afterwards
        # could not simply re-run it to correct the account.
        description=(
            "Email address of the administrator account `python -m app.db.seed` creates. "
            "Required, with no fallback. Seeding is idempotent and will not overwrite an "
            "existing account, so set this before the first seed run rather than after it."
        ),
    )

    SEED_ADMIN_PASSWORD: str = Field(
        # No default, for the same reason JWT_SECRET_KEY has none: this is the credential
        # of the only ADMIN principal the seed creates, and a committed placeholder would
        # be public knowledge. repr=False keeps it out of `repr(settings)`.
        repr=False,
        # The bounds are the shared policy's, not a second copy of them: PASSWORD_MIN_LENGTH
        # and PASSWORD_MAX_LENGTH are the same numbers app.schemas.auth publishes and
        # enforces on POST /api/v1/auth/register. Declared on the field as well as checked by
        # `_validate_seed_admin_password` so the bound is visible where the field is read.
        min_length=PASSWORD_MIN_LENGTH,
        max_length=PASSWORD_MAX_LENGTH,
        description=(
            "Password for the seeded administrator account. Required, with no fallback, "
            "consumed only by app.db.seed, and held to exactly the policy "
            "POST /api/v1/auth/register applies: at least "
            f"{PASSWORD_MIN_LENGTH} characters, at most {PASSWORD_MAX_LENGTH}, drawn from "
            f"at least {PASSWORD_MIN_CHARACTER_CLASSES} of the "
            f"{len(PASSWORD_CHARACTER_GROUPS)} character groups. It may also not be one of "
            "the placeholders published in .env.example, or a trivial variation of one. A "
            "weaker value is a startup failure rather than a weak administrator, and a "
            "longer one would be refused at every login because the login route applies "
            "the same ceiling."
        ),
    )

    # -- Validators ---------------------------------------------------------------------

    @model_validator(mode="before")
    @classmethod
    def _drop_frontend_keys(cls, values: Any) -> Any:
        """Remove the four public client keys, by exact name, before validation runs.

        This is the whole of the tolerance that lets one ``.env`` serve both tiers, and it
        is deliberately an exact-name allow-list rather than ``extra="ignore"``. Running in
        ``mode="before"`` puts it ahead of the ``extra="forbid"`` check, so the four names
        in :data:`_FRONTEND_ENV_KEYS` are dropped and **every other** unrecognised key -
        a misspelt ``DATABSE_URL``, a hopeful ``JWT_SECRET``, a stale key left behind by an
        older revision - reaches that check and stops the process with a message naming it.

        A blanket ignore is what makes a configuration typo invisible: the field keeps its
        default, the service starts, and the operator has no signal at all until something
        security-relevant turns out to have been left at a value nobody chose.

        Args:
            values:
                Whatever the settings sources produced. A mapping in every real path -
                merged environment variables, env-file contents and constructor keyword
                arguments - but typed loosely because pydantic permits a model validator to
                receive any input, and a non-mapping is passed straight through for the
                normal machinery to reject.

        Returns:
            The same values with the four client keys removed, or the input unchanged when
            it is not a mapping.
        """
        if isinstance(values, dict):
            return {key: value for key, value in values.items() if key not in _FRONTEND_ENV_KEYS}
        return values

    @field_validator("DATABASE_URL")
    @classmethod
    def _validate_database_url(cls, value: str) -> str:
        """Require a complete async psycopg 3 DSN, not merely one that starts correctly.

        Five things are checked, because each of them is a value that would otherwise be
        accepted here and fail much later, at the first query, in a process that has already
        reported itself started: the scheme, the presence of a host, the validity of the port
        if one is given, the presence of a database name, and the absence of a fragment.

        Nothing but the scheme and the reason is ever quoted back. A connection URL carries a
        password, and a validation message is printed to stderr and collected by log
        shippers, so the value itself - including the host and the user - stays out of it.
        """
        url = value.strip()
        if not url:
            raise ValueError(
                f"DATABASE_URL is empty. Expected {_DATABASE_URL_EXPECTED} - see "
                ".env.example for the documented placeholder."
            )

        scheme, separator, remainder = url.partition("://")
        if not separator:
            raise ValueError(
                "DATABASE_URL declares no scheme. It must begin with "
                f"{_DATABASE_URL_PREFIX} and continue user:password@host:port/database."
            )
        if scheme != _DATABASE_URL_SCHEME:
            hint = _DATABASE_URL_SCHEME_HINTS.get(scheme.lower(), _DATABASE_URL_GENERIC_HINT)
            raise ValueError(
                f"DATABASE_URL uses the {scheme!r} scheme, but this service requires "
                f"{_DATABASE_URL_PREFIX}: {hint}."
            )
        if not remainder:
            raise ValueError(
                f"DATABASE_URL names no host or database. Expected {_DATABASE_URL_EXPECTED}."
            )

        parts = urlsplit(url)

        if not parts.hostname:
            raise ValueError(
                "DATABASE_URL names no host. The authority between `://` and the database "
                f"path must contain one. Expected {_DATABASE_URL_EXPECTED}."
            )

        # `.port` parses lazily and raises rather than returning None for a non-numeric or
        # out-of-range value, so the read itself is the check. Both branches report the
        # bound and not the value, because the authority around the port holds a credential.
        try:
            port = parts.port
        except ValueError as exc:
            raise ValueError(
                "DATABASE_URL declares a port that is not a number. Expected "
                f"{_DATABASE_URL_EXPECTED}, with the port between {_MIN_TCP_PORT} and "
                f"{_MAX_TCP_PORT}."
            ) from exc
        if port is not None and not _MIN_TCP_PORT <= port <= _MAX_TCP_PORT:
            raise ValueError(
                f"DATABASE_URL declares port {port}, which is outside the TCP range "
                f"{_MIN_TCP_PORT}-{_MAX_TCP_PORT}."
            )

        # One path segment, non-empty: the database name. PostgreSQL has no nested database
        # namespace, so a second segment is always a mistake - most often a URL copied with
        # a schema or a table appended to it.
        database = parts.path.removeprefix("/")
        if not database:
            raise ValueError(
                "DATABASE_URL names no database. The path after the host must be the "
                f"database name. Expected {_DATABASE_URL_EXPECTED}."
            )
        if "/" in database:
            raise ValueError(
                "DATABASE_URL path has more than one segment. It must be exactly the "
                f"database name. Expected {_DATABASE_URL_EXPECTED}."
            )

        # A query string is legitimate - libpq connection parameters such as
        # `?sslmode=require` and `?connect_timeout=5` are passed straight through by
        # psycopg - so it is deliberately allowed. A fragment is not: no part of a
        # connection URL is a document anchor, and one present means the value was pasted
        # from somewhere it did not belong.
        if parts.fragment:
            raise ValueError(
                "DATABASE_URL carries a `#` fragment, which is not part of a connection "
                f"URL. Expected {_DATABASE_URL_EXPECTED}, optionally followed by libpq "
                "parameters as `?sslmode=require`."
            )
        return url

    @field_validator("JWT_SECRET_KEY")
    @classmethod
    def _validate_jwt_secret_key(cls, value: str) -> str:
        """Reject a signing key too short for *any* supported algorithm.

        The unconditional half of the RFC 7518 section 3.2 rule, applied here so that an
        obviously undersized key is reported against its own variable rather than against
        the key-and-algorithm pair. The algorithm-specific floor - 48 bytes for HS384, 64
        for HS512 - is checked by :meth:`_validate_signing_key_size` once both values are
        known, because a field validator cannot see a field declared after it.

        A hard failure, not a warning: PyJWT emits InsecureKeyLengthWarning for an
        undersized HMAC key, and a warning is something a deployment can ignore. Only the
        measured size is reported, never the key. The value is not stripped either -
        whitespace inside a secret is significant, and silently trimming it would sign
        tokens with a different key than the one the operator configured.
        """
        if len(value.encode("utf-8")) < _JWT_SECRET_KEY_MIN_LENGTH:
            raise ValueError(
                f"JWT_SECRET_KEY must be at least {_JWT_SECRET_KEY_MIN_LENGTH} bytes; the "
                f"configured value is {len(value.encode('utf-8'))}. PyJWT treats a shorter "
                "HMAC key as insecure (RFC 7518 section 3.2). Generate one with "
                "`openssl rand -hex 32`."
            )
        return value

    @field_validator("SEED_ADMIN_PASSWORD")
    @classmethod
    def _validate_seed_admin_password(cls, value: str) -> str:
        """Hold the seeded administrator's password to the registration policy.

        The account this credential opens is the only ``ADMIN`` principal a fresh
        deployment has, and it is the one account that cannot be created through the
        registration route - so without this check it would be the single account in the
        system exempt from the password policy. An empty value, a one-character value, or a
        value longer than ``LoginRequest`` accepts would all have been persisted as a
        perfectly valid argon2id hash: the first two as a trivially guessable administrator,
        the third as an administrator whose every login attempt is rejected at the schema
        boundary before it reaches verification.

        Two checks run here, in this order:

        1. The shared policy, :func:`password_policy_violation` - length between
           :data:`PASSWORD_MIN_LENGTH` and :data:`PASSWORD_MAX_LENGTH`, and at least
           :data:`PASSWORD_MIN_CHARACTER_CLASSES` of the five
           :data:`PASSWORD_CHARACTER_GROUPS`. It is that function's rule, not a second copy
           of it - see "The credential policy lives here" in the module docstring - so the
           seeded administrator and a self-registering reader are measured by one definition.
        2. Not a published or well-known placeholder, compared in reduced form and also by
           documented stem so that punctuation, capitalisation and a bumped trailing counter
           cannot smuggle one through. This check is unconditional, in every stage, unlike
           :meth:`_reject_committed_placeholder_credentials`, which admits the other
           committed values locally: ``.env.example`` ships ``ChangeMe-Admin-Password-1``,
           twenty-five characters over three groups, so length and variety cannot close this
           on their own - and a privileged account whose password is printed in the
           repository is not worth having even on a laptop whose container port is published.

        The value is never stripped. Whitespace inside a password is significant, and
        trimming it here would seed an account with a different credential than the operator
        configured - after which the documented password would simply not work.

        Nothing that was supplied appears in any message below: only what was expected, and
        at most a measured length. ``hide_input_in_errors`` on the model config keeps
        pydantic from adding the input back, so a rejected credential cannot reach stderr or
        a log collector.

        Args:
            value: The configured password, exactly as the environment supplied it.

        Returns:
            The value unchanged, once both checks have passed.

        Raises:
            ValueError: If the value fails the shared password policy, or is a placeholder.
        """
        violation = password_policy_violation(value)
        if violation is not None:
            raise ValueError(
                f"SEED_ADMIN_PASSWORD does not satisfy the password policy this API "
                f"applies to every new account. {violation} It is the credential of the "
                "seeded administrator, so a weak or unusable value here is a weak or "
                "unusable administrator."
            )

        reduced = _reduced_secret(value)
        placeholders = {_reduced_secret(known) for known in _SEED_ADMIN_PASSWORD_PLACEHOLDERS}
        if reduced in placeholders or reduced.startswith(_SEED_ADMIN_PASSWORD_PLACEHOLDER_STEMS):
            raise ValueError(
                "SEED_ADMIN_PASSWORD is a documented placeholder or a variation of one, so "
                "it is public knowledge and confers no secrecy. Generate a real secret - "
                "`openssl rand -base64 24` produces one that satisfies every rule above - "
                "and set it per environment."
            )

        return value

    @field_validator("CORS_ALLOW_ORIGINS", mode="before")
    @classmethod
    def _split_cors_allow_origins(cls, value: Any) -> Any:
        """Accept the comma-separated string the environment supplies.

        ``NoDecode`` on the annotation disables the JSON pre-parse, so this runs against
        the raw environment value. Surrounding whitespace is trimmed and empty segments
        are dropped, which is what makes ``CORS_ALLOW_ORIGINS=`` an empty list rather than
        a list holding one empty origin. Any non-string - the field default, or a list
        passed explicitly in a test - is handed straight through to normal validation.
        """
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    @field_validator("CORS_ALLOW_ORIGINS")
    @classmethod
    def _validate_cors_allow_origins(cls, value: list[str]) -> list[str]:
        """Require each entry to be a bare http/https origin, with no credential in it.

        ``CORSMiddleware`` compares the browser's ``Origin`` header against these entries
        verbatim, so anything that is not exactly an origin can never match: a trailing
        slash, a path, a query, a JSON array pasted in place of the comma-separated form.
        None of those produces a server error - they produce an unexplained CORS failure in
        the client, days later, in someone else's browser. Each is a startup failure here
        instead.

        Two rejections are security rather than correctness. A scheme other than ``http`` or
        ``https`` is a value a browser can never send an ``Origin`` for, so accepting it
        cannot help and it hides a mistake; and userinfo in an entry is a credential written
        into a list this service logs, echoes into error messages, and hands to middleware.

        The one entry that is not an origin is ``*``, and it is accepted **only when it is
        the entire list**. That is the wildcard ``CORSMiddleware`` itself understands, and it
        widens the API to every origin on the web - a deliberate, occasionally correct choice
        for a public read-only surface, and never one to make by accident. Mixing it with
        named origins is always a mistake: the middleware treats the presence of the wildcard
        as "allow everything", so the named entries beside it read as a restriction that is
        not being applied.

        Positions are reported, never values. An index tells the operator which entry to fix
        without copying a possibly credential-bearing string into stderr.
        """
        if _CORS_WILDCARD in value:
            if len(value) == 1:
                return value
            raise ValueError(
                f"CORS_ALLOW_ORIGINS mixes the {_CORS_WILDCARD!r} wildcard with "
                f"{len(value) - 1} named origin(s). CORSMiddleware reads the wildcard as "
                "'allow every origin', so the named entries would look like a restriction "
                "that is not being applied. Use the wildcard alone, deliberately, or list "
                "only real origins."
            )

        for index, origin in enumerate(value):
            position = f"entry {index + 1} of {len(value)}"
            parts = urlsplit(origin)

            if not parts.scheme:
                raise ValueError(
                    f"CORS_ALLOW_ORIGINS {position} declares no scheme: {_CORS_EXPECTED}"
                )
            if parts.scheme.lower() not in _CORS_ALLOWED_SCHEMES:
                raise ValueError(
                    f"CORS_ALLOW_ORIGINS {position} uses a scheme a browser never sends an "
                    f"Origin header for. Only http and https are accepted: {_CORS_EXPECTED}"
                )
            if not parts.hostname:
                raise ValueError(f"CORS_ALLOW_ORIGINS {position} names no host: {_CORS_EXPECTED}")
            if parts.username or parts.password:
                raise ValueError(
                    f"CORS_ALLOW_ORIGINS {position} embeds userinfo. An origin is a scheme, "
                    "a host and a port; a credential in this list would be logged and "
                    f"echoed, and could never match an Origin header anyway: {_CORS_EXPECTED}"
                )
            try:
                port = parts.port
            except ValueError as exc:
                raise ValueError(
                    f"CORS_ALLOW_ORIGINS {position} declares a port that is not a number: "
                    f"{_CORS_EXPECTED}"
                ) from exc
            if port is not None and not _MIN_TCP_PORT <= port <= _MAX_TCP_PORT:
                raise ValueError(
                    f"CORS_ALLOW_ORIGINS {position} declares port {port}, which is outside "
                    f"the TCP range {_MIN_TCP_PORT}-{_MAX_TCP_PORT}."
                )
            if parts.path or parts.query or parts.fragment:
                raise ValueError(
                    f"CORS_ALLOW_ORIGINS {position} is not a bare origin - it carries a "
                    f"path, query or fragment, or a trailing slash: {_CORS_EXPECTED}"
                )
        return value

    @field_validator("AUTH_RATE_LIMIT")
    @classmethod
    def _validate_auth_rate_limit(cls, value: str) -> str:
        """Check the expression's shape so a typo fails here, not at the first login.

        The check is a strict subset of what the ``limits`` parser behind slowapi accepts,
        so anything allowed here is parseable there. A zero count is rejected as well:
        ``0/minute`` parses cleanly and then makes every authentication request fail with
        429, which is a misconfiguration rather than a policy.
        """
        expression = value.strip()
        if not expression:
            raise ValueError(
                'AUTH_RATE_LIMIT is empty. Expected an expression such as "5/minute". '
                "Rate limiting on the authentication routes is not optional."
            )

        for item in (part.strip() for part in _RATE_LIMIT_SEPARATORS.split(expression)):
            match = _RATE_LIMIT_ITEM.fullmatch(item)
            if match is None:
                raise ValueError(
                    f"AUTH_RATE_LIMIT contains {item!r}, which is not a <count>/<period> "
                    "expression. period is one of second, minute, hour, day, month or "
                    'year, optionally preceded by a multiple - "5/minute", "100/hour" '
                    'or "5/2minutes". Combine several limits with a semicolon, as in '
                    '"5/minute;100/hour".'
                )
            if int(match.group("count")) < 1:
                raise ValueError(
                    f"AUTH_RATE_LIMIT item {item!r} allows zero requests, which would "
                    "make every authentication request fail with 429. Use a positive "
                    "count."
                )
            multiple = match.group("multiple")
            if multiple is not None and int(multiple) < 1:
                raise ValueError(
                    f"AUTH_RATE_LIMIT item {item!r} declares a zero-length window. The "
                    'multiple before the period must be at least 1, as in "5/2minutes".'
                )
        return expression

    @model_validator(mode="after")
    def _validate_signing_key_size(self) -> Settings:
        """Require the signing key to be at least as large as the chosen algorithm's hash.

        RFC 7518 section 3.2 requires an HMAC key at least as long as the hash output, and
        PyJWT enforces the same 32, 48 and 64-byte floors for HS256, HS384 and HS512. A
        single fixed minimum therefore accepts an undersized configuration: a 32-byte key
        under HS512 halves the strength the algorithm was chosen for, and PyJWT warns about
        it at the first token issued rather than at startup.

        A model validator rather than a field validator, because the answer depends on two
        fields and field validators run in declaration order with ``JWT_SECRET_KEY`` first.
        The mapping lookup is a plain subscript with no fallback: :data:`JwtAlgorithm` and
        :data:`_JWT_SECRET_KEY_MIN_BYTES` are declared next to each other and the mapping is
        typed by that alias, so an unlisted algorithm cannot reach here - and answering a
        misconfiguration with a default floor would be worse than raising.

        Returns:
            ``self`` unchanged. Nothing is normalised; the check is a gate, not a transform.

        Raises:
            ValueError: If the key encodes to fewer bytes than the algorithm requires. The
                message reports the required and measured sizes and never the key itself.
        """
        required = _JWT_SECRET_KEY_MIN_BYTES[self.JWT_ALGORITHM]
        measured = len(self.JWT_SECRET_KEY.encode("utf-8"))
        if measured < required:
            raise ValueError(
                f"JWT_SECRET_KEY must be at least {required} bytes when JWT_ALGORITHM is "
                f"{self.JWT_ALGORITHM}, because RFC 7518 section 3.2 requires an HMAC key "
                f"at least as large as the hash output; the configured value is {measured} "
                f"bytes. Either lengthen the key - `openssl rand -hex {required // 2}` emits "
                f"exactly {required} - or choose an algorithm whose hash the current key "
                "already covers."
            )
        return self

    @model_validator(mode="after")
    def _reject_committed_placeholder_credentials(self) -> Self:
        """Refuse to run a deployment on a credential this repository publishes.

        ``.env.example`` commits a value for every variable so that
        ``cp .env.example .env`` produces a checkout that starts. Three of those values are
        credentials, and their presence in a public repository is precisely what makes them
        useless as credentials: anyone who can read the project can read them. Length and
        format checks do not catch this - the committed signing key clears the 32-byte floor
        - so the values themselves are compared.

        Accepted under ``ENVIRONMENT=development`` and ``ENVIRONMENT=test``, because that is
        the documented local flow and the whole point of shipping the example. Rejected under
        ``staging`` and ``production`` alike: staging is a deployment somebody other than its
        author can reach, and a published credential protects it no better than none.

        Returns:
            The validated settings instance, unchanged.

        Raises:
            ValueError: If any credential still holds its committed placeholder outside a
                local stage. The message names the variables and nothing else - printing the
                value would republish it into a log or a CI transcript, which is the very
                exposure being closed.
        """
        if self.ENVIRONMENT in _LOCAL_ENVIRONMENTS:
            return self

        offenders = [
            name
            for name, value in (
                ("JWT_SECRET_KEY", self.JWT_SECRET_KEY),
                ("SEED_ADMIN_PASSWORD", self.SEED_ADMIN_PASSWORD),
                ("SEED_ADMIN_EMAIL", str(self.SEED_ADMIN_EMAIL)),
            )
            if value in _COMMITTED_PLACEHOLDER_CREDENTIALS
        ]
        if offenders:
            raise ValueError(
                f"{', '.join(offenders)} still hold the placeholder value published in "
                f".env.example, and ENVIRONMENT={self.ENVIRONMENT} is not a local stage. "
                "Those values are readable by anyone who can read this repository. Generate "
                "a signing key with `openssl rand -hex 32`, choose an administrator address "
                "and password for this deployment, and set all three from the environment."
            )
        return self

    # -- Derived predicates -------------------------------------------------------------

    @property
    def is_development(self) -> bool:
        """Whether this process is running the local development configuration.

        app.core.logging selects its human-readable renderer on this, and app.main gates
        the /openapi.json, /docs and /redoc surface on it. Expressing the comparison once
        keeps the literal ``"development"`` out of every call site.
        """
        return self.ENVIRONMENT == "development"

    @property
    def is_production(self) -> bool:
        """Whether this process is running the production configuration."""
        return self.ENVIRONMENT == "production"


# The one instance every other module imports, built at import time on purpose. A missing
# or invalid variable therefore fails while the process is starting - before a request is
# served or a migration is applied against a half-configured service - and `from
# app.core.config import settings` is the spelling app.main, app.db.session, app.db.seed,
# the sibling core modules and migrations/env.py are all written against. Deliberately not
# an lru_cache'd factory: a second way to reach the same object is a second thing to keep
# in step.
settings: Final[Settings] = Settings()
