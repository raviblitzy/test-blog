"""Password hashing and token handling: the cryptographic primitives the auth flow rests on.

Five responsibilities, and deliberately nothing beyond them:

* **argon2id password hashing and verification**, through ``pwdlib``'s argon2 backend.
* **Access-token issuance**, signed with the configured HMAC algorithm and carrying exactly
  five claims - subject, role, issued-at, expiry and type.
* **Refresh-token generation**, as an opaque high-entropy value, plus the SHA-256 digest
  under which it is stored. Only the digest is ever persisted.
* **Decoding, with explicit expiry handling**, so that every possible decode failure leaves
  this module as a domain error and never as a ``PyJWT`` exception.
* **The bounded worker-thread offload** every CPU-bound call in a request path goes
  through - :func:`run_cpu_bound` and the :class:`~anyio.CapacityLimiter` that bounds it.
  It lives here because the most expensive such call in the codebase, and the reason the
  offload exists at all, is the argon2 hashing declared in this file.

Primitives only
---------------
This module is the bottom of the authentication stack: it computes, it does not decide. It
imports no session, no repository, no model and no schema; its only ``app`` imports are
``app.core.config`` and ``app.core.exceptions``. The *policies* built on top of these
primitives live one layer up, in ``app.services.auth_service`` - refresh rotation, reuse
detection, revocation on logout, and the decision to verify a candidate password against
:func:`dummy_password_hash` when no account matches an email so that registration cannot be
probed through a timing difference. None of that belongs here, and none of it is here.

Consumers, all of them one layer up:

* ``app.services.auth_service`` - registration, credential verification, token-pair
  issuance, refresh rotation and revocation.
* ``app.core.dependencies`` - ``get_current_user`` decodes the bearer credential.
* ``app.db.seed`` - hashes ``settings.SEED_ADMIN_PASSWORD`` for the seeded administrator.
* ``app.services.post_service`` and ``app.services.comment_service`` - neither hashes nor
  decodes anything; both reach :func:`run_cpu_bound` for their bleach sanitisation, because
  one bound over the machine's CPU is the whole point of having one.

Two forms of every argon2 primitive, and services must use the awaitable one
----------------------------------------------------------------------------
argon2id is deliberately expensive: the hasher is configured for ``time_cost=3`` and
``memory_cost=65536`` KiB, so one hash or one verification spends tens of milliseconds of CPU.
Called directly from a coroutine that would stop the event loop of its worker for that whole
time, and with it every other request the worker is serving.

So each of the three primitives on the login path exists twice - :func:`hash_password` and
:func:`hash_password_async`, :func:`verify_password` and :func:`verify_password_async`,
:func:`dummy_password_hash` and :func:`dummy_password_hash_async`. The pairs are not
alternatives:

* The **synchronous** function is the primitive. It is what the work actually is, it is
  directly unit-testable and doctestable, and it is what a caller with no other work on its
  event loop calls - ``app.db.seed``, a one-shot script whose loop serves no requests and whose
  hashes are sequential by nature, and the test factories. Offloading there would add a thread
  hop and a token acquisition to buy responsiveness nothing is waiting for.
* The **awaitable** function is the only form a request path may use. It runs the primitive on
  a bounded worker thread through :func:`run_cpu_bound` below, so the loop keeps
  serving while the CPU work happens elsewhere, and the bound stops a flood of sign-ins from
  becoming a flood of threads.

``app.services.auth_service`` therefore awaits all three. :func:`verify_and_update_password`
has no awaitable form, because nothing calls it - ``authenticate`` documents why it declines
the re-hash-on-login upgrade - and adding a caller in a request path means adding that form
rather than calling this one from a coroutine.

Two hashes, two algorithms, on purpose
--------------------------------------
Passwords and refresh tokens are both "secrets we store a hash of", and they are hashed with
deliberately different primitives. It looks inconsistent and it is not, so the reasoning is
recorded here as well as on :func:`hash_refresh_token`:

* A **password** is low-entropy, human-chosen and dictionary-attackable, so it gets argon2id -
  salted, memory-hard and intentionally slow. A stolen ``users.password_hash`` is then
  expensive to attack offline, and two accounts sharing a password do not share a hash.
* A **refresh token** is 256 bits of CSPRNG output. It is not guessable, so a salt and a work
  factor buy nothing - but it must be **findable**, because ``refresh_tokens.token_hash``
  carries a ``UNIQUE`` index and rotation looks the presented token up by digest in a single
  index probe. A salted argon2 hash is unqueryable by construction: it would force a
  full-table scan with a per-row verify on every refresh. SHA-256 is the correct primitive
  here; argon2 would be the wrong one.

Every failure is a domain error
-------------------------------
Nothing raises ``HTTPException`` and no ``PyJWT`` exception escapes. A decode failure becomes
:class:`~app.core.exceptions.TokenExpiredError` or
:class:`~app.core.exceptions.InvalidTokenError` - both 401s in the
:class:`~app.core.exceptions.UnauthorizedError` family - so the single registered handler in
``app.core.exceptions`` renders the one problem document, with its ``WWW-Authenticate:
Bearer`` challenge, for every one of them. That is what makes "an expired or revoked token
yields 401" true uniformly rather than per call site.

The two errors are distinguished for the server's benefit, not the client's: they let this
module raise precisely and let a log line or a traceback name the check that failed. On the
wire they are one branch. Both carry ``type: /errors/unauthorized`` and the title
``Unauthorized``, so the field a client switches on cannot tell them apart, and
:class:`~app.core.exceptions.InvalidTokenError` is raised **bare**, always, with its class
default detail. Every rejection reason - a forged signature, a truncated token, an
unexpected algorithm, a missing claim, a refresh token presented as a bearer credential, a
subject that is not a UUID - produces the same message on the wire, because telling a caller
*which* check failed tells an attacker which one to fix next. A client needs no distinction
either way: it attempts one refresh on any 401 and falls back to sign-in if that is refused.

The bounded offload, and why the bound is the load-bearing part
--------------------------------------------------------------
Every route in this service is an ``async def`` coroutine, and a coroutine runs on the one
thread that also runs the event loop of its worker process. A synchronous call inside one does
not merely make *that* request slow: it stops the loop, so every other request the same worker
is serving - a feed read, a like, a health probe - waits for it to return. There is no
pre-emption to rescue them, because there is nothing to pre-empt.

Two kinds of genuinely expensive synchronous work exist in this codebase, and they are the only
two: the argon2id hashing and verification declared below, reached from
``app.services.auth_service`` on registration and on every sign-in; and HTML sanitisation with
bleach, in ``app.services.post_service`` for a post's content and excerpt and in
``app.services.comment_service`` for a comment's body. Both reach a worker thread through
:func:`run_cpu_bound`, and both draw on the one :class:`~anyio.CapacityLimiter`
:func:`cpu_bound_limiter` hands out.

Moving the work to a thread is the easy half. An *unbounded* offload converts a request flood
into a thread flood: a thousand concurrent sign-ins would start a thousand argon2 hashes, each
asking for 64 MiB, and the worker would exhaust memory or collapse into scheduler thrash while
the event loop - now free, and therefore accepting still more requests - kept feeding it. That
is resource exhaustion by amplification, and it is a worse failure than the blocked loop it
replaced, because a blocked loop at least applied back-pressure.
:data:`CPU_BOUND_CONCURRENCY` is that back-pressure, expressed as a fixed number of tokens per
worker process; requests beyond it wait for a token, which is exactly the queue a bounded
resource should have.

``2`` per worker process, derived from the deployment shape ``app.db.session`` already documents
- ``MAX_WORKERS_PER_REPLICA`` Uvicorn workers per container, ``MAX_REPLICAS`` containers - and
from what one unit of this work costs:

* **CPU.** Four worker processes at two tokens each is eight CPU-bound threads per container.
  A container sized to run four Uvicorn workers usefully has a few cores, so eight is a modest
  oversubscription that keeps them busy without turning the run queue into the bottleneck.
* **Memory.** The worst case is two concurrent argon2 hashes in one process: ``2 x 64`` MiB =
  128 MiB of transient hashing memory per worker, 512 MiB across a four-worker container. Both
  numbers are budgetable. Eight tokens per worker would be 2 GiB of the same, for throughput no
  container of that size can deliver.
* **Threads.** These tokens are additional to anyio's default thread limiter of 40, which
  Starlette uses for synchronous route handlers and dependencies. Passing our own limiter means
  this work cannot exhaust that shared allowance, and the two bounds add rather than compete:
  at most 42 offloaded threads per worker, and at most 2 of them doing CPU-bound work.

One consequence is deliberate and worth stating plainly: password hashing and sanitisation draw
on the *same* two tokens, so a burst of sign-ins can make a comment's sanitisation wait. That is
the correct trade, because both are contending for one physical resource - the CPU - and giving
each its own generous allowance would only let them oversubscribe it separately. What matters is
that the wait is a wait for a token rather than a stalled event loop: every request not doing CPU
work continues to be served at full speed throughout. It is also the reason the offload lives in
this module rather than in a module of its own: one bound over one resource is one declaration,
and the most expensive claimant on it is declared here.

What the offload buys, and what the GIL still costs
--------------------------------------------------
The two kinds of work do not benefit equally, and the difference is worth knowing before
reading a latency graph:

* **argon2 releases the GIL.** The hashing happens in argon2-cffi's C extension, so an offloaded
  hash runs genuinely in parallel with the event loop. Measured on this codebase: four
  sequential hashes on the loop stalled it for 161 ms; the same four offloaded left a worst-case
  stall of 0.8 ms and finished sooner in wall-clock terms as well, because two of them ran at
  once.
* **bleach does not.** It is pure Python, so an offloaded sanitisation holds the GIL for its own
  bytecode and the loop only runs in the gaps the interpreter's switch interval opens. Measured
  the same way: four 68 KB documents stalled the loop for 305 ms inline, and offloaded left a
  worst case of 40 ms with about 5 ms of typical lag - the switch interval, visible. Total wall
  time was very slightly *worse*, because there is no parallelism to win and there is a thread
  hop to pay.

The second case is still the right trade, and the numbers say why: during the inline run the
loop managed four scheduled ticks, and during the offloaded run it managed twenty-seven. Nothing
was starved. A request that is not sanitising degrades from "frozen for a third of a second" to
"a few milliseconds of jitter", which is the difference between a timeout and a slow response.

A process pool would remove the GIL from that picture entirely, and it is deliberately not used:
it would mean pickling documents up to 100 000 characters across a process boundary, another
pool of processes per worker to size and supervise, and a second failure mode - for a saving
this scope has no evidence of needing.

Only pure functions of their arguments may be offloaded, and in particular **nothing that
touches the database**: an :class:`~sqlalchemy.ext.asyncio.AsyncSession` is bound to the event
loop that created it, and SQLAlchemy's async layer bridges to its synchronous core through a
greenlet that only exists on that loop. Reading a lazily loaded attribute from a plain worker
thread does not quietly issue a query - it raises ``MissingGreenlet``. So the shape every caller
follows is: do the session work on the loop, hand the *values* to :func:`run_cpu_bound`, and use
what it returns back on the loop.

Configuration
-------------
Every tunable comes from :data:`~app.core.config.settings`: the signing key, the algorithm,
and both lifetimes. This module reads no environment variable, defines no fallback secret and
holds no literal key. ``app.core.config`` has already refused to start the process unless
``JWT_SECRET_KEY`` is at least as long as the digest the configured ``JWT_ALGORITHM``
produces - 32 bytes for ``HS256``, 48 for ``HS384``, 64 for ``HS512`` - which is the same
comparison PyJWT makes internally before raising ``InsecureKeyLengthWarning``, citing RFC
7518 section 3.2. Nothing here re-validates the key and nothing here compensates for a weak
one, because by the time this module runs there is no weak-key configuration left to
compensate for: the pairing is checked against the algorithm rather than against a single
floor, so a 32-byte key configured with ``HS512`` stops the process at startup instead of
signing tokens while PyJWT warns about them on every ``encode``. That warning is therefore
unreachable in a running service rather than tolerated, and it is still neither silenced nor
swallowed - if one is ever seen, the gate in ``app.core.config`` is what has regressed.

Nothing is logged
-----------------
There is no logger in this module, and that is a security decision rather than an omission.
Every value that passes through here is either a credential or a key: a plaintext password, a
password hash, a raw refresh token, a token digest, a bearer token, the signing key itself.
``app.core.logging`` names this module specifically when explaining why structured tracebacks
are configured with ``show_locals=False``. A log statement here would have to be audited
forever; having none is auditable in one line. Diagnostics belong to the caller, which logs
the *outcome* - "credential verification failed" - and never the input.
"""

import hashlib
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import cache
from typing import Any, Final
from uuid import UUID

import jwt
from anyio import CapacityLimiter, to_thread
from anyio.lowlevel import RunVar
from pwdlib import PasswordHash
from pwdlib.exceptions import UnknownHashError
from pwdlib.hashers.argon2 import Argon2Hasher

from app.core.config import settings
from app.core.exceptions import InvalidTokenError, TokenExpiredError

__all__ = [
    "CPU_BOUND_CONCURRENCY",
    "REFRESH_TOKEN_ENTROPY_BYTES",
    "TOKEN_TYPE_ACCESS",
    "AccessTokenClaims",
    "access_token_expires_at",
    "cpu_bound_limiter",
    "create_access_token",
    "decode_access_token",
    "dummy_password_hash",
    "dummy_password_hash_async",
    "generate_refresh_token",
    "hash_password",
    "hash_password_async",
    "hash_refresh_token",
    "refresh_token_expires_at",
    "run_cpu_bound",
    "verify_and_update_password",
    "verify_password",
    "verify_password_async",
    "verify_refresh_token",
    "warm_password_hashing",
]


# ---------------------------------------------------------------------------------------
# The budget
#
# Exported because it is a deployment fact rather than an implementation detail: an
# operator sizing a container needs it, and a test asserting that the offload is bounded
# needs it. The module docstring records the arithmetic that produced the value.
# ---------------------------------------------------------------------------------------

CPU_BOUND_CONCURRENCY: Final[int] = 2
"""How many CPU-bound offloads one worker process may run at the same time.

Per *process*, not per container: with the ``MAX_WORKERS_PER_REPLICA`` workers
``app.db.session`` documents, the container-wide ceiling is that many multiplied by this.

Not configurable from the environment, and deliberately so. ``.env.example`` is the
documented configuration contract, and this is not a knob an operator can set correctly in
isolation - raising it raises transient memory use by 64 MiB per token per worker, which is a
container-sizing decision rather than a per-deployment preference. A change here is a change
to the deployment shape, reviewed as code.
"""


# ---------------------------------------------------------------------------------------
# The limiter
#
# One per event loop, created on first use. `RunVar` is anyio's per-run storage - the same
# mechanism anyio uses for its own default thread limiter - so the binding follows the loop
# rather than the process.
# ---------------------------------------------------------------------------------------

_CPU_BOUND_LIMITER: Final[RunVar[CapacityLimiter]] = RunVar("app_cpu_bound_limiter")


def cpu_bound_limiter() -> CapacityLimiter:
    """Return this event loop's CPU-bound offload limiter, creating it on first use.

    Callers normally have no reason to touch this: :func:`run_cpu_bound` applies the limiter
    itself. It is public for the two cases that legitimately need the object rather than the
    behaviour - a test asserting that the bound is what this module says it is, and an
    operational probe reading :attr:`~anyio.CapacityLimiter.borrowed_tokens` to see how much of
    the budget is in use.

    Returns:
        The limiter for the running loop, holding :data:`CPU_BOUND_CONCURRENCY` tokens. The same
        object for every call within one loop, and a distinct object per loop.

    Note:
        Must be called from within a running event loop, because that is what identifies which
        limiter is wanted. ``LookupError`` from the underlying storage is handled here - it is
        how "this loop has not asked yet" is reported, not an error condition - so the first
        caller creates the limiter and every later one finds it.
    """
    try:
        return _CPU_BOUND_LIMITER.get()
    except LookupError:
        limiter = CapacityLimiter(CPU_BOUND_CONCURRENCY)
        _CPU_BOUND_LIMITER.set(limiter)
        return limiter


# ---------------------------------------------------------------------------------------
# The offload
# ---------------------------------------------------------------------------------------


async def run_cpu_bound[T, *PosArgsT](
    func: Callable[[*PosArgsT], T],
    *args: *PosArgsT,
) -> T:
    """Run a synchronous, CPU-bound function on a bounded worker thread and await its result.

    The one way this codebase leaves the event loop. Every argon2 call in
    ``app.core.security`` and every bleach call in ``app.services.post_service`` and
    ``app.services.comment_service`` reaches its work through here, so there is a single place
    where the bound is applied and a single place to look when asking what may run off the loop.

    Args:
        func: The function to run. Must be a pure function of its arguments: it may not touch
            the database session, an ORM instance's lazily loaded attributes, or anything else
            bound to the event loop - see the module docstring for why that raises rather than
            merely being slow. Passed positionally to the worker, so a bound method, a plain
            function and a :func:`~functools.partial` are all acceptable.
        args: Positional arguments for ``func``. Keyword arguments are not accepted, because the
            underlying primitive takes none; wrap the call in a
            :func:`~functools.partial` if a keyword is genuinely needed. The type parameters
            make the pairing exact, so passing an argument ``func`` does not accept is a static
            error rather than a runtime one.

    Returns:
        Whatever ``func`` returned, with its type preserved.

    Raises:
        BaseException: Anything ``func`` raises, propagated unchanged with its traceback.

    Examples:
        Values in, value out - and the session work stays on the loop::

            body = await run_cpu_bound(_sanitize_body, payload.body)
            comment = Comment(post_id=post.id, author_id=author.id, body=body)
            await self.comments.add(comment)
    """
    return await to_thread.run_sync(func, *args, limiter=cpu_bound_limiter())


# ---------------------------------------------------------------------------------------
# Public contract constants
#
# Exported because more than one module has to agree on them: `app.services.auth_service`
# issues the tokens these describe and the test suite asserts against them. A duplicated
# literal is how two modules stop agreeing without anyone noticing.
# ---------------------------------------------------------------------------------------

TOKEN_TYPE_ACCESS: Final[str] = "access"
"""Value of the ``type`` claim on an access token.

The claim exists for exactly one reason: to stop a refresh token being replayed as a bearer
credential. :func:`decode_access_token` requires the claim to be present and to equal this
value, so a token minted for any other purpose is rejected even though its signature is
perfectly valid. Without that check the short access-token lifetime would be decorative,
since the much longer-lived refresh token would open every protected route.

Refresh tokens carry no claims at all - see :func:`generate_refresh_token` - so there is no
matching ``TOKEN_TYPE_REFRESH`` constant to keep in step, and adding one would imply a
symmetry that does not exist.
"""

REFRESH_TOKEN_ENTROPY_BYTES: Final[int] = 32
"""Entropy, in bytes, behind every generated refresh token.

Thirty-two bytes is 256 bits from the operating system's CSPRNG, which is what makes a
refresh token unguessable and therefore what makes hashing it with a fast digest safe. The
value is a module constant rather than an environment variable on purpose: it is a property
of the security design, not of a deployment, and a deployment that could lower it is a
deployment that could weaken every session.

``secrets.token_urlsafe`` base64url-encodes those bytes, so the emitted string is 43
characters, not 32 - see :func:`generate_refresh_token`.
"""


# ---------------------------------------------------------------------------------------
# Access-token claim set
#
# Exactly five claims, listed once. `sub`, `iat` and `exp` are registered JWT claims;
# `role` and `type` are private ones this service defines. Nothing else is minted: an
# unused claim is payload every request pays for, and `jti`/`nbf`/`aud`/`iss` have no
# consumer in a single-audience service with no revocation list.
# ---------------------------------------------------------------------------------------

_REQUIRED_CLAIMS: Final[tuple[str, ...]] = ("sub", "role", "iat", "exp", "type")
"""Claims :func:`decode_access_token` requires to be present, handed to PyJWT's ``require``.

Load-bearing, and the ``exp`` entry most of all. PyJWT's ``verify_exp`` option only checks an
expiry that is *there*: verified against the pinned release, a token carrying no ``exp`` at
all decodes successfully under ``{"verify_exp": True}`` alone, which would make a stolen
token eternal. Listing every claim the payload is built from means a token missing any one of
them is rejected as malformed instead of decoded into a half-populated principal.
"""


# ---------------------------------------------------------------------------------------
# Password hashing backend
# ---------------------------------------------------------------------------------------

_PASSWORD_HASHER: Final[PasswordHash] = PasswordHash((Argon2Hasher(),))
"""The single argon2id hasher, constructed once at import.

Assembled explicitly from :class:`~pwdlib.hashers.argon2.Argon2Hasher` rather than through
``PasswordHash.recommended()``. The two are equivalent in pwdlib 0.3.0 - ``recommended()``
returns this exact construction - but the explicit form states the algorithm in the source
instead of deferring it to a library default that a future release is free to change.
``Argon2Hasher`` defaults to ``argon2.Type.ID``, so the produced hashes are argon2id, which
is the variant this project specifies.

``passlib`` and ``bcrypt`` are deliberately absent: pwdlib is passlib's maintained successor
and provides argon2id directly, and argon2-cffi arrives underneath it as the ``pwdlib[argon2]``
extra rather than as a direct dependency.

Built at module scope because argon2 parameter setup is not free and this object sits on the
login path. The hasher is stateless - the per-hash salt is generated inside each ``hash``
call - so one instance is safe to share across requests, threads and workers.

A single hasher also means the verification list has one entry, so a hash in any other format
is unidentifiable rather than silently attempted; :func:`verify_password` turns that into a
failed login. Adding a legacy hasher here, as a second tuple element, is how a migration from
another scheme would work: ``verify`` would accept the old format while
:func:`verify_and_update_password` re-hashed it with argon2id on next login.
"""


# ---------------------------------------------------------------------------------------
# Decoded access-token claims
# ---------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AccessTokenClaims:
    """The validated content of an access token, as Python values rather than raw JSON.

    Deliberately **not** a Pydantic model in ``app.schemas``. Schemas are the wire contract -
    ``app.schemas.auth`` owns the token-pair response a client receives - whereas this is the
    internal result of a decode that never leaves the process, and ``app.core`` may not import
    ``app.schemas`` without closing an import cycle.

    Frozen and slotted: a principal derived from a signed credential must not be mutated
    downstream by the dependency that resolved it, and there are no dynamic attributes to
    allow. Every value has already been validated by :func:`decode_access_token`, so a
    consumer can use each field without re-checking it.

    Attributes:
        subject: The authenticated user's identifier, parsed from the ``sub`` claim.
        role: The ``UserRole`` label the token was minted with - ``READER``, ``AUTHOR`` or
            ``ADMIN``. A **convenience, not an authority**: it reflects the role held when the
            token was issued, which a later promotion or demotion does not change.
            ``app.core.dependencies.require_admin`` compares the role on the loaded ``User``
            row, never this claim, so a revoked privilege takes effect immediately rather than
            at the end of the token's lifetime.
        issued_at: When the token was minted, as an aware UTC instant.
        expires_at: When the token stops being accepted, as an aware UTC instant. Already
            enforced - a token past this instant raises rather than returning claims - so the
            field is for diagnostics and for a client deciding when to refresh, not for a
            second expiry check.
    """

    subject: UUID
    role: str
    issued_at: datetime
    expires_at: datetime


# ---------------------------------------------------------------------------------------
# Internal helpers
#
# Small, private and total: each either returns a validated value or raises the domain
# error. Keeping the coercions here is what lets `decode_access_token` read as the policy it
# is rather than as a sequence of defensive type checks.
# ---------------------------------------------------------------------------------------


def _utc_now() -> datetime:
    """Return the current instant as a timezone-aware UTC :class:`~datetime.datetime`.

    Every instant this module produces or compares goes through here, so "aware UTC, always"
    is one line rather than a convention. ``datetime.utcnow()`` is deliberately not used
    anywhere: it returns a *naive* value, which is deprecated, compares wrongly against an
    aware one, and would shift every ``exp`` by the host's UTC offset - a bug that is
    invisible on a machine set to UTC and silently issues expired or over-long tokens
    everywhere else.

    Returns:
        The current UTC instant, with ``tzinfo`` set.
    """
    return datetime.now(tz=UTC)


def _access_token_lifetime(expires_delta: timedelta | None = None) -> timedelta:
    """Resolve how long an access token should live.

    The single place the configured lifetime is read, so :func:`create_access_token` and
    :func:`access_token_expires_at` cannot disagree about it.

    Args:
        expires_delta: An explicit lifetime, overriding configuration. A negative value is
            accepted and is not a mistake: issuing an already-expired token is how the test
            suite proves that expiry is rejected, and clamping it here would make that
            behaviour unreachable.

    Returns:
        ``expires_delta`` when given, otherwise ``settings.ACCESS_TOKEN_EXPIRE_MINUTES``
        expressed as a :class:`~datetime.timedelta`.
    """
    if expires_delta is not None:
        return expires_delta
    return timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)


def _string_claim(value: object) -> str:
    """Return ``value`` when it is a string, and reject the token otherwise.

    PyJWT validates the *registered* claims it knows about and passes everything else through
    exactly as JSON decoded it, so a hand-crafted token can carry ``role: 123`` or
    ``role: ["ADMIN"]`` through a perfectly valid signature check. Verified against the pinned
    release: both decode without complaint. Handing such a value to :class:`AccessTokenClaims`
    would put a non-string where every consumer expects a role label, so it is rejected here.

    Args:
        value: A decoded claim value of unknown type.

    Returns:
        The value, narrowed to :class:`str`.

    Raises:
        InvalidTokenError: If the claim is absent or is not a string.
    """
    if not isinstance(value, str):
        raise InvalidTokenError
    return value


def _subject_claim(value: object) -> UUID:
    """Parse the ``sub`` claim into a :class:`~uuid.UUID`.

    Identifiers in this system are database-generated UUIDs, and ``sub`` must be a string per
    the JWT specification, so the claim is carried as text and parsed back here. A value that
    is not a UUID is a malformed token, not a server fault: without this translation the
    ``ValueError`` from :class:`~uuid.UUID` would escape as a 500 instead of the 401 it is.

    Any spelling :class:`~uuid.UUID` accepts round-trips to the same identifier, so a token
    minted from an uppercase or brace-wrapped string still resolves to the canonical value.

    Args:
        value: The decoded ``sub`` claim.

    Returns:
        The subject as a :class:`~uuid.UUID`.

    Raises:
        InvalidTokenError: If the claim is not a string, or is a string that is not a UUID.
    """
    try:
        return UUID(_string_claim(value))
    except ValueError as error:
        raise InvalidTokenError from error


def _instant_claim(value: object) -> datetime:
    """Convert a numeric-date claim into an aware UTC instant.

    Both guards below exist because a probe against the pinned PyJWT found real inputs that
    survive its own validation and then break the conversion:

    * PyJWT coerces ``exp`` and ``iat`` with ``int()`` while leaving the claim as decoded, so
      a *numeric string* such as ``"1786162119"`` passes validation and then makes
      :meth:`~datetime.datetime.fromtimestamp` raise :class:`TypeError`.
    * A value far outside the platform's time range - ``1e30``, or ``NaN`` - also passes, then
      raises :class:`OverflowError` or :class:`ValueError`.

    A JSON boolean is rejected as well: :class:`bool` is a subclass of :class:`int`, so
    ``iat: true`` would otherwise be read as one second past the epoch rather than as the
    malformed claim it is.

    Args:
        value: The decoded ``iat`` or ``exp`` claim.

    Returns:
        The instant, with ``tzinfo`` set to UTC.

    Raises:
        InvalidTokenError: If the claim is not a finite number inside the representable range.
    """
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise InvalidTokenError
    try:
        return datetime.fromtimestamp(value, tz=UTC)
    except (OSError, OverflowError, ValueError) as error:
        raise InvalidTokenError from error


# ---------------------------------------------------------------------------------------
# Passwords
# ---------------------------------------------------------------------------------------


def hash_password(password: str) -> str:
    """Hash a plaintext password with argon2id.

    Produces the encoded string stored in ``users.password_hash``, which carries the variant,
    the version, the cost parameters and a freshly generated random salt inline - so two
    accounts with the same password have different hashes, and a future cost increase needs no
    schema change. The column is unbounded ``TEXT`` for exactly that reason.

    The password is passed through unmodified: argon2 has no bcrypt-style 72-byte input limit,
    so there is no truncation and no pre-hashing here, and none is wanted - silently
    truncating would make two different long passwords interchangeable. No maximum length is
    imposed either; bounding the input is the registration schema's job in
    ``app.schemas.auth``, where a rejection can be reported per field.

    Args:
        password: The plaintext password. Any Unicode string, including emoji, encoded as
            UTF-8 by the hasher.

    Returns:
        The encoded argon2id hash, beginning ``$argon2id$``. Safe to store; never log it.

    Examples:
        >>> stored = hash_password("correct horse battery staple")
        >>> verify_password("correct horse battery staple", stored)
        True
    """
    return _PASSWORD_HASHER.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    """Check a candidate password against a stored argon2id hash.

    Constant-time in the password, because argon2 verification compares digests rather than
    strings: a wrong password costs the same as a right one, so nothing about the correct
    value leaks through timing.

    **Never raises for a bad stored value.** pwdlib raises ``UnknownHashError`` when no
    configured hasher recognises the hash - an empty string, a truncated prefix, a bcrypt hash
    left behind by another system - and that is caught and reported as a failed verification.
    A corrupt row must present as a failed login, not as a 500 that tells an attacker they
    found a broken account. Malformed values that *are* recognisably argon2 need no catch:
    pwdlib's argon2 hasher already reports those as ``False``.

    A ``TypeError`` from a non-string argument is deliberately **not** caught. That is a caller
    defect rather than data corruption, mypy rejects it statically at every call site under
    this project's strict configuration, and swallowing it would hide the bug behind a login
    failure that looks like a wrong password.

    Verifying an unknown email is the caller's problem, not this function's: see
    :func:`dummy_password_hash`.

    Args:
        password: The plaintext password presented by the caller.
        password_hash: The stored hash to verify against.

    Returns:
        ``True`` only if the password matches the hash. ``False`` for a wrong password and for
        any hash this module cannot interpret.
    """
    try:
        return _PASSWORD_HASHER.verify(password, password_hash)
    except UnknownHashError:
        return False


def verify_and_update_password(password: str, password_hash: str) -> tuple[bool, str | None]:
    """Verify a password and report a replacement hash when the stored one is outdated.

    The upgrade path for argon2 cost parameters. When the tuned parameters change, existing
    hashes stay valid but under-cost; calling this on the login path lets a service re-hash the
    password it has just legitimately received - the only moment the plaintext is available -
    and write the stronger hash back. No batch migration is possible or needed, because a
    password cannot be re-hashed without the password.

    Args:
        password: The plaintext password presented by the caller.
        password_hash: The stored hash to verify against.

    Returns:
        ``(matched, replacement)``. ``replacement`` is a new hash to persist when the stored
        one was produced with outdated parameters, and ``None`` when it is already current or
        the password did not match - so a caller writes it back only when it is not ``None``.

    Examples:
        >>> stored = hash_password("correct horse battery staple")
        >>> verify_and_update_password("correct horse battery staple", stored)
        (True, None)
    """
    try:
        return _PASSWORD_HASHER.verify_and_update(password, password_hash)
    except UnknownHashError:
        return False, None


@cache
def dummy_password_hash() -> str:
    """Return a valid argon2id hash of a random, unknowable password.

    The material for closing a user-enumeration timing oracle. Login for an unknown email
    would otherwise return in microseconds while login for a known one spends the argon2 work
    factor, and that difference is measurable over a handful of requests - it turns the login
    route into an "is this address registered?" API. A caller verifies against this hash when
    no account matches, so both paths cost the same argon2 verification. In
    ``app.services.auth_service`` - not here, and note that ``UnauthorizedError`` is imported
    there rather than in this module:

    .. code-block:: python

        user = await repository.get_by_email(credentials.email)
        stored = user.password_hash if user else dummy_password_hash()
        if not verify_password(credentials.password, stored) or user is None:
            raise UnauthorizedError("Incorrect email or password.")

    The *policy* - that the two paths must be indistinguishable, and that both report the same
    message - belongs to ``app.services.auth_service``. This function only supplies a hash that
    cannot be matched: the password is drawn from the CSPRNG, is never returned, and is not
    retained after the hash is computed.

    Cached, so the argon2 cost is paid at most once per process and only if the unknown-account
    path is ever taken. The value is stable for the process lifetime, which is what keeps the
    timing profile of two consecutive unknown-email logins identical.

    Returns:
        An argon2id hash that no caller-supplied password can match.
    """
    # `secrets.DEFAULT_ENTROPY` is 32 bytes, the same 256-bit standard the refresh tokens
    # use. The generated value is consumed immediately and never bound to a name that
    # outlives this call.
    return _PASSWORD_HASHER.hash(secrets.token_urlsafe())


def warm_password_hashing() -> None:
    """Pay the dummy hash's argon2 cost now, before the first request can observe it.

    **This closes a user-enumeration oracle that survived the stand-in hash itself.**
    :func:`dummy_password_hash` is cached, which makes every unknown-email login after the first
    one cost exactly what a known-email login costs. The *first* one is different: it computes a
    real argon2id hash, so the very first attempt against an unregistered address pays a full
    hash **plus** a verify, while the first attempt against a registered one pays only the verify.
    That is a difference of the whole argon2 work factor - tens of milliseconds, not microseconds -
    and it is measurable on a single request by anyone who gets to a freshly started process
    first. Warming after startup made the asymmetry hard to see in a test suite rather than absent
    from the service.

    Called from ``app.main.lifespan`` so the cost lands in startup, where no client is waiting on
    it and nothing is being timed. Synchronous and not offloaded on purpose: at startup there is
    no event loop traffic to protect, and going through the bounded worker pool would mean
    startup depended on that pool being ready.

    Idempotent, because :func:`dummy_password_hash` is cached - a second call is a dictionary
    lookup. Safe to call from a test that has cleared the cache, and safe to call twice.

    Nothing is returned. The value is deliberately not exposed here: callers that need it use
    :func:`dummy_password_hash_async`, and a warm-up that handed the hash back would invite a
    caller to hold it in a variable of its own, where it would outlive the cache and stop being
    the single stable value that makes two unknown-email attempts indistinguishable.
    """
    dummy_password_hash()


# ---------------------------------------------------------------------------------------
# Passwords, off the event loop
#
# The three primitives above, each wrapped in the bounded offload that a request path must
# use. Thin on purpose: no rule, no branch and no error translation lives here that is not
# already in the function being wrapped, so the awaitable form and the synchronous form
# cannot come to disagree about what they do. This module's docstring records why the offload
# is bounded and what may not be sent through it.
# ---------------------------------------------------------------------------------------


async def hash_password_async(password: str) -> str:
    """Hash a plaintext password with argon2id, off the event loop.

    The form ``app.services.auth_service.register`` uses. Identical in result to
    :func:`hash_password` - it *is* that function, executed on a bounded worker thread - so the
    stored hash, the inline cost parameters and the freshly generated salt are all exactly as
    that function documents them.

    Args:
        password: The plaintext password. Handed to the worker thread as a value and not
            retained afterwards; the thread computes a hash and returns a string, so nothing
            about the credential outlives the call.

    Returns:
        The encoded argon2id hash, beginning ``$argon2id$``. Safe to store; never log it.

    Note:
        The awaited call is the only thing between the plaintext arriving and the hash being
        produced, so registration still holds the password for exactly one call - the thread hop
        does not widen that window, it only moves where the cost is paid.
    """
    return await run_cpu_bound(hash_password, password)


async def verify_password_async(password: str, password_hash: str) -> bool:
    """Check a candidate password against a stored argon2id hash, off the event loop.

    The form ``app.services.auth_service.authenticate`` uses. :func:`verify_password` runs whole
    inside the worker thread, so its ``UnknownHashError`` handling happens there too and a
    corrupt stored value still presents as a failed verification rather than as an exception
    crossing the thread boundary.

    Args:
        password: The plaintext password presented by the caller.
        password_hash: The stored hash to verify against. May equally be the value
            :func:`dummy_password_hash_async` returns, which is how the unknown-account path
            pays the same cost as a real one.

    Returns:
        ``True`` only if the password matches the hash. ``False`` for a wrong password and for
        any hash this module cannot interpret.

    Note:
        The timing property this function exists to preserve is unaffected by the offload,
        because the offload is on **both** paths: a known account and an unknown one each pay one
        token acquisition plus one argon2 verification. What would break it is offloading only
        one of them, or letting a token shortage on one path be answered from a cache on the
        other - neither of which can happen, because both paths reach the same limiter through
        the same function.
    """
    return await run_cpu_bound(verify_password, password, password_hash)


async def dummy_password_hash_async() -> str:
    """Return the cached argon2id hash of a random, unknowable password, off the event loop.

    The form ``app.services.auth_service.authenticate`` uses for the unknown-account path.
    :func:`dummy_password_hash` is cached, so the argon2 cost is paid inside a worker thread on
    the first unknown-email attempt this process sees and every later one returns the cached
    string; the thread hop remains on every call, which keeps the two paths' shapes identical.

    Returns:
        An argon2id hash that no caller-supplied password can match. The same value for the life
        of the process, which is what makes two consecutive unknown-email attempts
        indistinguishable from each other as well as from a real one.
    """
    return await run_cpu_bound(dummy_password_hash)


# ---------------------------------------------------------------------------------------
# Access tokens
# ---------------------------------------------------------------------------------------


def access_token_expires_at() -> datetime:
    """Return the instant an access token minted now would expire.

    For a caller that has to report the lifetime it just handed out - the ``expires_at`` or
    ``expires_in`` field of a token-pair response - without decoding its own token to find it.
    Derived from the same :func:`_access_token_lifetime` :func:`create_access_token` uses, so
    the two agree to within the sub-second cost of the two clock reads.

    Returns:
        An aware UTC instant, ``settings.ACCESS_TOKEN_EXPIRE_MINUTES`` from now.
    """
    return _utc_now() + _access_token_lifetime()


def create_access_token(
    *,
    subject: UUID | str,
    role: str,
    expires_delta: timedelta | None = None,
) -> str:
    """Mint a signed access token for a principal.

    The payload carries exactly five claims and nothing else:

    ==========  ===========================================================================
    ``sub``     The subject's UUID, as a **string**. The JWT specification requires a string
                subject, and PyJWT refuses to serialise a :class:`~uuid.UUID` object outright
                (``Object of type UUID is not JSON serializable``), so the value is
                stringified here rather than at every call site.
    ``role``    The ``UserRole`` label, as a plain string. ``str()`` is applied so a
                :class:`~enum.StrEnum` member is carried as ``"AUTHOR"`` rather than as
                anything enum-shaped.
    ``iat``     Issued-at.
    ``exp``     Expiry, ``iat`` plus the resolved lifetime.
    ``type``    :data:`TOKEN_TYPE_ACCESS`, so a refresh token cannot be replayed here.
    ==========  ===========================================================================

    ``jti``, ``nbf``, ``aud`` and ``iss`` are deliberately absent: no consumer in this
    single-audience service reads them, there is no access-token revocation list for a ``jti``
    to key, and every unused claim is bytes on every subsequent request.

    ``iat`` and ``exp`` are handed over as aware :class:`~datetime.datetime` values and PyJWT
    normalises them to integer POSIX seconds, so the encoded instants are truncated to whole
    seconds - the token's ``exp`` can be up to a second earlier than the value
    :func:`access_token_expires_at` reports. Sub-second precision in an expiry is meaningless
    against network latency, so this is recorded rather than corrected.

    Keyword-only by design: ``(subject, role)`` are two values of compatible type, and a
    positional call site that transposed them would mint a token whose role was a UUID and
    whose subject was ``"ADMIN"``.

    Args:
        subject: The authenticated user's identifier. A :class:`~uuid.UUID` is the expected
            form; a string is accepted for callers that already hold one.
        role: The role label to carry - ``READER``, ``AUTHOR`` or ``ADMIN``. A ``UserRole``
            member may be passed directly, since it is a string subclass. Typed as
            :class:`str` so this module stays free of any import from ``app.models``.
        expires_delta: Overrides the configured lifetime. Intended for tests, including the
            negative delta that proves an expired token is rejected.

    Returns:
        The encoded, signed JWT.

    Examples:
        >>> from uuid import uuid4
        >>> token = create_access_token(subject=uuid4(), role="AUTHOR")
        >>> decode_access_token(token).role
        'AUTHOR'
    """
    issued_at = _utc_now()
    payload: dict[str, Any] = {
        "sub": str(subject),
        "role": str(role),
        "iat": issued_at,
        "exp": issued_at + _access_token_lifetime(expires_delta),
        "type": TOKEN_TYPE_ACCESS,
    }
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def decode_access_token(token: str) -> AccessTokenClaims:
    """Verify an access token and return its validated claims.

    The single decode path in the service tier. ``app.core.dependencies.get_current_user``
    calls it with the value from an ``Authorization: Bearer`` header, and everything that can
    go wrong leaves here as a 401 in the
    :class:`~app.core.exceptions.UnauthorizedError` family - never as a ``PyJWT`` exception and
    never as a 500.

    Four checks, in this order, each of them load-bearing:

    1. **Signature, against an explicit algorithm allowlist.** ``algorithms`` is always the one
       configured algorithm, as a list, and never ``None``. Passing ``None`` would let the
       token's own ``alg`` header choose the verification algorithm - the classic
       algorithm-confusion vulnerability, where ``alg: none`` turns an unsigned token into a
       valid one. Verified against the pinned release: both ``alg: none`` and a token signed
       with a different HMAC algorithm are rejected.
    2. **Presence of every claim**, through :data:`_REQUIRED_CLAIMS`, so a token without an
       ``exp`` is malformed rather than eternal.
    3. **Expiry**, translated to :class:`~app.core.exceptions.TokenExpiredError`. Caught before
       the general clause because ``ExpiredSignatureError`` is a subclass of
       ``InvalidTokenError``: reversing the two would report every expiry as a generic invalid
       token and lose the distinction a server-side log needs to tell a lapsed session apart
       from a forged credential. Both are the same 401 to a client - see the module docstring.
    4. **Token type**, so a refresh token with a valid signature is not accepted as a bearer
       credential.

    The final ``except`` catches ``jwt.PyJWTError`` rather than ``jwt.InvalidTokenError``, and
    the difference matters: ``InvalidKeyError`` sits directly under ``PyJWTError``, *outside*
    the ``InvalidTokenError`` branch, so the narrower clause would let it escape as a 500.
    Catching the root of the hierarchy is what makes "no PyJWT exception leaves this module"
    true by construction rather than by enumeration.

    Args:
        token: The encoded JWT, without the ``Bearer`` scheme prefix.

    Returns:
        The validated claims. Every field has been checked, so no consumer re-validates.

    Raises:
        TokenExpiredError: The signature was valid but ``exp`` has passed.
        InvalidTokenError: Any other rejection - a bad signature, a malformed or truncated
            token, an unexpected algorithm, a missing or non-conforming claim, a subject that
            is not a UUID, or a token whose ``type`` is not :data:`TOKEN_TYPE_ACCESS`. Raised
            bare, so every one of those produces the same message on the wire.
    """
    try:
        payload = jwt.decode(
            token,
            key=settings.JWT_SECRET_KEY,
            algorithms=[settings.JWT_ALGORITHM],
            # A fresh dict per call. PyJWT merges options into its own defaults and mutates
            # the mapping it is given when signature verification is disabled; building one
            # here keeps the module constant beyond reach of that path.
            options={
                "require": list(_REQUIRED_CLAIMS),
                "verify_signature": True,
                "verify_exp": True,
            },
        )
    except jwt.ExpiredSignatureError as error:
        raise TokenExpiredError from error
    except jwt.PyJWTError as error:
        raise InvalidTokenError from error

    if _string_claim(payload.get("type")) != TOKEN_TYPE_ACCESS:
        raise InvalidTokenError

    return AccessTokenClaims(
        subject=_subject_claim(payload.get("sub")),
        role=_string_claim(payload.get("role")),
        issued_at=_instant_claim(payload.get("iat")),
        expires_at=_instant_claim(payload.get("exp")),
    )


# ---------------------------------------------------------------------------------------
# Refresh tokens
# ---------------------------------------------------------------------------------------


def refresh_token_expires_at() -> datetime:
    """Return the instant a refresh token generated now should expire.

    Written to ``refresh_tokens.expires_at``, a ``timestamptz`` column, which is why the value
    is aware rather than naive: handing psycopg a naive datetime would let the database apply
    its own session time zone and silently shift every session's lifetime.

    Refresh tokens rotate on use, so this bounds an *idle* session rather than an active one.

    Returns:
        An aware UTC instant, ``settings.REFRESH_TOKEN_EXPIRE_DAYS`` from now.
    """
    return _utc_now() + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)


def generate_refresh_token() -> str:
    """Generate a new opaque refresh token.

    **Not a JWT, on purpose.** A refresh token has to be revocable - logout must invalidate it
    immediately, and rotation must detect a replayed one - and revocation requires server-side
    state, so the token is looked up as a row rather than trusted as a signed assertion. Given
    that row, claims inside the token would add nothing and would cost something: a JWT's
    payload is only base64, so anyone holding the token could read the subject out of it, and
    it would still not be revocable.

    Drawn from the operating system's CSPRNG through :func:`secrets.token_urlsafe`, so the
    value is unpredictable even to a caller who has seen every token issued before it. That
    unguessability is the premise :func:`hash_refresh_token` relies on.

    The plaintext is returned to the caller exactly once, in the token-pair response, and is
    never persisted, never logged and never recoverable: only
    :func:`hash_refresh_token`'s digest reaches the database, so a database disclosure yields
    no usable session.

    Returns:
        A URL-safe token carrying :data:`REFRESH_TOKEN_ENTROPY_BYTES` bytes of entropy - 43
        characters, since base64url encodes three bytes as four characters. Safe in a JSON body
        and in an ``Authorization`` header without escaping.
    """
    return secrets.token_urlsafe(REFRESH_TOKEN_ENTROPY_BYTES)


def hash_refresh_token(token: str) -> str:
    """Return the SHA-256 digest under which a refresh token is stored.

    **SHA-256 here, argon2id for passwords, and the asymmetry is deliberate - please do not
    "fix" it.** Two properties drive it:

    * **Unguessability is already established.** The token is 256 bits of CSPRNG output from
      :func:`generate_refresh_token`, not a human-chosen secret. There is no dictionary to try
      and no rainbow table to build, so a salt and a work factor would protect against an
      attack that cannot happen.
    * **The digest must be findable.** ``refresh_tokens.token_hash`` carries a ``UNIQUE``
      index, and rotation, revocation and reuse detection all locate the presented token by its
      hash - one index probe. Argon2 embeds a fresh random salt in every hash, so the same
      token hashes differently every time and the value is unqueryable by construction:
      matching one would mean scanning every stored row and running the argon2 work factor
      against each. That is a full-table scan with a memory-hard verify per row, on the hot
      path of every refresh, and it gets worse as the table grows.

    Deterministic across calls, processes and hosts - the same token always yields the same
    64-character lowercase hex digest - which is precisely the property the unique index and
    the lookup depend on.

    Args:
        token: The plaintext refresh token, as returned by :func:`generate_refresh_token`.

    Returns:
        The lowercase hexadecimal SHA-256 digest of the token's UTF-8 bytes: 64 characters.

    Examples:
        >>> hash_refresh_token("a-token") == hash_refresh_token("a-token")
        True
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def verify_refresh_token(token: str, token_hash: str) -> bool:
    """Check a presented refresh token against a stored digest.

    Used where a candidate has to be compared against a digest already in hand - reuse
    detection during rotation, and revocation on logout - rather than fetched by it. The
    comparison runs through :func:`secrets.compare_digest` instead of ``==`` so it takes the
    same time whether the digests differ in the first character or the last: a plain string
    comparison short-circuits, and that timing is enough to reconstruct a target digest one
    character at a time.

    Both values are compared as bytes rather than as text, because
    :func:`secrets.compare_digest` refuses a :class:`str` containing any non-ASCII character.
    A digest this module produced is always hexadecimal, but ``token_hash`` arrives from the
    database, and a corrupt row must lose the comparison rather than raise.

    Args:
        token: The plaintext refresh token presented by the caller.
        token_hash: The stored digest to compare against.

    Returns:
        ``True`` only if ``token`` hashes to ``token_hash``.
    """
    return secrets.compare_digest(
        hash_refresh_token(token).encode("ascii"),
        token_hash.encode("utf-8"),
    )
