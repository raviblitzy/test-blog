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

Eleven variables
----------------
The eleven fields of :class:`Settings` mirror the eleven backend keys in the
repository-root ``.env.example`` field for field and name for name. The three keys in
that file's FRONTEND block belong to the Next.js tier - they are inlined into the client
bundle at build time, and are public by design - so they are deliberately absent here.
``extra`` is set to ``"ignore"`` so that one ``.env`` can still serve both tiers:
``pydantic-settings`` rejects undeclared keys read from an env file by default, so
without it a file copied straight from ``.env.example`` would stop the service booting.

Where a value comes from
------------------------
Highest precedence first:

1. a real environment variable - how ``docker-compose.yml`` and CI supply values;
2. ``backend/.env`` - a local, per-checkout override;
3. ``.env`` at the repository root - the file ``cp .env.example .env`` creates;
4. the field default declared below.

Both env files are resolved to absolute paths from this module's own location rather than
from the process working directory. The canonical launch is ``uvicorn app.main:app`` run
from inside ``backend/`` (Alembic and ``python -m app.db.seed`` run from there too), so a
bare relative ``".env"`` would look in ``backend/`` and miss the documented,
git-ignored file that sits at the repository root next to ``.env.example``. A missing env
file is not an error: in a container every value arrives as a real environment variable.

Failing fast
------------
Misconfiguration is a startup failure, never a runtime 500. ``JWT_SECRET_KEY`` and
``SEED_ADMIN_PASSWORD`` have no defaults, so their absence raises rather than degrading
into an insecure fallback; a signing key shorter than 32 characters is rejected because
PyJWT treats shorter HMAC keys as insecure, citing RFC 7518 section 3.2; a
``DATABASE_URL`` naming any driver other than psycopg 3 is rejected; and
``JWT_ALGORITHM``, ``ENVIRONMENT`` and ``LOG_LEVEL`` are closed sets rather than free
strings. ``hide_input_in_errors`` keeps the offending value out of the resulting message,
so a rejected secret or a credential-bearing URL never reaches a log or a traceback.

Import purity
-------------
This module imports ``pydantic``, ``pydantic-settings`` and the standard library, and
nothing else - no ``app`` sibling, no SQLAlchemy, no engine, no logging configuration.
``backend/alembic.ini`` deliberately declares no ``sqlalchemy.url`` so that
``migrations/env.py`` can take the URL from here and the application and its migrations
share one source of truth; every ``alembic upgrade head``, ``alembic downgrade base`` and
``alembic check`` therefore imports this file, and it has to stay cheap. Constructing
:data:`settings` is its only import-time effect.
"""

import re
from pathlib import Path
from typing import Annotated, Any, Final, Literal
from urllib.parse import urlsplit

from pydantic import EmailStr, Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

__all__ = ["Settings", "settings"]


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
# Authentication invariants
# ---------------------------------------------------------------------------------------
# RFC 7518 section 3.2 requires an HMAC key at least as long as the hash output, and
# PyJWT raises InsecureKeyLengthWarning below 32 bytes. Enforced as a hard startup gate
# rather than a warning: a token signed with a guessable key is worse than no service.
_JWT_SECRET_KEY_MIN_LENGTH: Final[int] = 32


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
        # MANDATORY. One .env serves both tiers, so it carries the three client keys from
        # the FRONTEND block of .env.example that this model does not declare; the default
        # behaviour would reject them as unknown and refuse to boot.
        extra="ignore",
        # Hold the defaults declared below to the same validators as an env-supplied
        # value, so a committed default can never drift out of its own contract.
        validate_default=True,
        # Keep rejected values - a short signing key, a URL with a password in it - out of
        # validation messages, which are printed to stderr and captured by log collectors.
        hide_input_in_errors=True,
    )

    # -- Database -----------------------------------------------------------------------

    DATABASE_URL: str = Field(
        default="postgresql+psycopg://blog:blog@localhost:5432/blog",
        description=(
            "PostgreSQL 18 connection URL in async psycopg 3 form, "
            "postgresql+psycopg://user:password@host:port/database. The default matches "
            "the credentials and published port docker-compose.yml gives its `db` "
            "service, so a local `docker compose up -d db` needs no further "
            "configuration; it is a local placeholder, never a deployment credential."
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
            f"fallback, and at least {_JWT_SECRET_KEY_MIN_LENGTH} characters. Generate "
            "one per environment with `openssl rand -hex 32` and never reuse it."
        ),
    )

    JWT_ALGORITHM: Literal["HS256", "HS384", "HS512"] = Field(
        default="HS256",
        description=(
            "Token signing algorithm. Restricted to the HMAC family because "
            "JWT_SECRET_KEY is a single shared secret; an RS or ES algorithm needs a key "
            "pair and would be a configuration error here rather than a preference."
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
        default_factory=lambda: ["http://localhost:3000", "http://127.0.0.1:3000"],
        description=(
            "Comma-separated browser origins permitted to call the API. Each entry is a "
            "complete origin - scheme, host and port - with no path and no trailing "
            "slash, because CORSMiddleware compares the request Origin header verbatim. "
            "The default lists both loopback spellings the development server and the "
            "end-to-end runner use, which a browser treats as different origins."
        ),
    )

    # -- Observability ------------------------------------------------------------------

    ENVIRONMENT: Literal["development", "test", "staging", "production"] = Field(
        default="development",
        description=(
            "Deployment stage. It selects console-readable versus JSON structured "
            "logging and decides whether the interactive documentation routes are "
            "exposed, so it is a security boundary as well as a formatting choice. "
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
        default="10/minute",
        description=(
            "Limit applied to the authentication routes as a slowapi/limits expression: "
            '"<count>/<period>", where period is second, minute, hour, day, month or '
            'year - for example "10/minute" or "100/hour". Combine several limits with a '
            'semicolon, as in "10/minute;100/hour". Mirrors the .env.example placeholder.'
        ),
    )

    # -- Seed data ----------------------------------------------------------------------

    SEED_ADMIN_EMAIL: EmailStr = Field(
        default="admin@example.com",
        description=(
            "Email address of the administrator account `python -m app.db.seed` creates. "
            "Seeding is idempotent and will not overwrite an existing account, so set "
            "this before the first seed run rather than after it."
        ),
    )

    SEED_ADMIN_PASSWORD: str = Field(
        # No default, for the same reason JWT_SECRET_KEY has none: this is the credential
        # of the only ADMIN principal the seed creates, and a committed placeholder would
        # be public knowledge. repr=False keeps it out of `repr(settings)`.
        repr=False,
        description=(
            "Password for the seeded administrator account. Required, with no fallback, "
            "and consumed only by app.db.seed."
        ),
    )

    # -- Validators ---------------------------------------------------------------------

    @field_validator("DATABASE_URL")
    @classmethod
    def _validate_database_url(cls, value: str) -> str:
        """Require the async psycopg 3 scheme, and say why any other one cannot work.

        Only the scheme is ever quoted back. The rest of a connection URL carries a
        password, and a validation message is printed to stderr and collected by log
        shippers, so the value itself stays out of it.
        """
        url = value.strip()
        if not url:
            raise ValueError(
                "DATABASE_URL is empty. Expected "
                f"{_DATABASE_URL_PREFIX}user:password@host:port/database - see "
                ".env.example for the placeholder that matches docker-compose.yml."
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
                "DATABASE_URL names no host or database. Expected "
                f"{_DATABASE_URL_PREFIX}user:password@host:port/database."
            )
        return url

    @field_validator("JWT_SECRET_KEY")
    @classmethod
    def _validate_jwt_secret_key(cls, value: str) -> str:
        """Reject a signing key shorter than the RFC 7518 floor.

        A hard failure, not a warning: PyJWT emits InsecureKeyLengthWarning below 32
        bytes, and a warning is something a deployment can ignore. Only the measured
        length is reported, never the key. The value is not stripped either - whitespace
        inside a secret is significant, and silently trimming it would sign tokens with a
        different key than the one the operator configured.
        """
        if len(value) < _JWT_SECRET_KEY_MIN_LENGTH:
            raise ValueError(
                f"JWT_SECRET_KEY must be at least {_JWT_SECRET_KEY_MIN_LENGTH} "
                f"characters; the configured value is {len(value)}. PyJWT treats shorter "
                "HMAC keys as insecure (RFC 7518 section 3.2). Generate one with "
                "`openssl rand -hex 32`."
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
        """Require each entry to be a bare origin, because CORSMiddleware compares exactly.

        A trailing slash, a path, or a JSON array pasted in place of the comma-separated
        form all produce an origin that silently never matches a browser's Origin header,
        which surfaces as an unexplained CORS failure in the client rather than as a
        server error. Each of them is a startup failure instead. ``*`` is allowed through
        as the wildcard CORSMiddleware itself understands.
        """
        for origin in value:
            if origin == "*":
                continue
            parts = urlsplit(origin)
            if not parts.scheme or not parts.netloc or parts.path or parts.query or parts.fragment:
                raise ValueError(
                    f"CORS_ALLOW_ORIGINS contains {origin!r}, which is not a bare "
                    "origin. Each entry must be scheme://host[:port] with no path, no "
                    "query and no trailing slash, and entries are separated by commas - "
                    "not JSON. Example: "
                    "CORS_ALLOW_ORIGINS=http://localhost:3000,http://127.0.0.1:3000"
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
                'AUTH_RATE_LIMIT is empty. Expected an expression such as "10/minute". '
                "Rate limiting on the authentication routes is not optional."
            )

        for item in (part.strip() for part in _RATE_LIMIT_SEPARATORS.split(expression)):
            match = _RATE_LIMIT_ITEM.fullmatch(item)
            if match is None:
                raise ValueError(
                    f"AUTH_RATE_LIMIT contains {item!r}, which is not a <count>/<period> "
                    "expression. period is one of second, minute, hour, day, month or "
                    'year, optionally preceded by a multiple - "10/minute", "100/hour" '
                    'or "5/2minutes". Combine several limits with a semicolon, as in '
                    '"10/minute;100/hour".'
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
