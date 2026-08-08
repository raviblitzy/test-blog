"""The single dependency-injection wiring point: session, principal, authority, page window.

Four concerns are wired here and nowhere else, so that a reader looking for any one of them
has exactly one file to open:

* **The request-scoped database session.** :func:`get_db` yields one
  :class:`~sqlalchemy.ext.asyncio.AsyncSession` per request and owns its rollback and its
  close. It is the only way a route obtains a session, so no handler can reach a datastore
  directly.
* **Principal resolution.** :func:`get_current_user` turns an ``Authorization: Bearer``
  credential into a loaded :class:`~app.models.user.User`;
  :func:`get_current_user_optional` does the same but tolerates its absence, for the public
  reads whose projection depends on who is asking; :func:`get_current_active_user` adds the
  deactivated-account check and is what a protected route should normally depend on.
* **Authorisation.** :func:`require_admin` is the administrator gate, and
  :func:`is_admin`, :func:`can_modify` and :func:`ensure_can_modify` are the pure
  predicates the service layer calls so that one ownership rule is written once.
* **The request half of the pagination contract.** :class:`PageParams` normalises and
  bounds ``page`` and ``page_size`` for every list endpoint, so the feed, the profile
  listing and the administrative tables window identically and one client control pages
  them all.

The wiring vocabulary
---------------------
Five :data:`~typing.Annotated` aliases are exported so that no router re-spells a
``Depends`` chain and every signature in the API reads the same way:

=================  ==============================================================
:data:`DbSession`  A request-scoped session.
:data:`CurrentUser`  The authenticated, active principal. Rejects an absent, malformed
                   or expired credential with 401, and a deactivated account with 403.
:data:`OptionalUser`  The principal when one was presented, ``None`` when the caller is
                   anonymous. A *present but unusable* credential is still a 401.
:data:`AdminUser`  The authenticated, active principal, additionally required to hold
                   ``ADMIN``.
:data:`PageParamsDep`  The validated page window.
=================  ==============================================================

A router therefore reads ``async def list_posts(db: DbSession, page: PageParamsDep)`` and
carries no injection machinery of its own.

What this module replaces
-------------------------
The single-module application this service grew out of did the opposite of all four things.
Its five handlers mutated a module-level list directly - ``items.append(item)``,
``items[index] = updated_item``, ``items.pop(index)`` - with no session, no principal, no
authority check and no pagination anywhere, and the same identity predicate written out
independently in three handlers. There was no injected provider of any kind: the word
``Depends`` did not appear in the repository. Concentrating these four concerns in one file
is what makes that shape unavailable rather than merely discouraged.

Layering
--------
``app.core`` is the bottom of the backend import graph, and this module imports only
downward: :mod:`app.core.exceptions`, :mod:`app.core.security`, :mod:`app.db.session` and
:mod:`app.models.user`. Never ``app.api``, ``app.services``, ``app.repositories`` or
``app.schemas`` - every one of those sits above ``app.core`` and imports it, so a reference
in this direction would close a cycle.

Two adjacent modules are deliberately *not* imported. :mod:`app.core.pagination` owns the
*response* envelope (``Page`` and ``build_page``) while this module owns the *request*
window; the two meet in ``app.repositories.base``'s paginate primitive, and importing it
here would put FastAPI's request machinery inside a module the schema layer re-exports.
:mod:`app.core.config` is not imported either, because nothing here is configurable: see
:data:`MAX_PAGE_SIZE` for why the page bounds are module constants rather than a
fifteenth environment key.

No route in this service raises a framework exception, and neither does any dependency
here. Every rejection is a domain error from :mod:`app.core.exceptions`, which is what lets
the single registered handler render one problem document - ``type``, ``title``, ``status``,
``detail``, ``instance`` - for a missing credential, an expired token and a forbidden
operation alike.

Authority is checked against the database, never against the token
------------------------------------------------------------------
An access token carries a ``role`` claim, and this module ignores it for every decision.
:func:`require_admin` compares the role on the freshly loaded ``User`` row, so demoting an
administrator takes effect on their next request rather than whenever their current token
happens to expire. The claim is a convenience for a client that wants to render a menu; it
is not a capability.

Client-side route guards are defence in depth and not a substitute. ``middleware.ts`` in
the frontend keeps an anonymous visitor out of the dashboard and the administrative
section, and the client hides controls a role cannot use, but this module is the actual
boundary: every protected operation is re-checked here or in the service layer.

Nothing is logged
-----------------
There is no logger in this module, and that is a decision rather than an omission. Every
value in scope on a failure path is a credential - the bearer token itself, or the identity
it names - so :mod:`app.core.security`'s reasoning applies unchanged. The outcome is
already observable without it: ``app.middleware.request_context`` emits one structured
record per request carrying the status code and the bound ``request_id``, so a 401 or a 403
raised here appears in the log stream with its correlation identifier and its path, while
the credential that produced it never does. A line on the happy path of
:func:`get_current_user` would additionally be a line on every authenticated request in the
service.

Testability
-----------
Two properties are load-bearing for the test suite and must survive any edit here.
:func:`get_db` is a plain module-level function, neither wrapped in a factory nor memoised,
so ``app.dependency_overrides[get_db]`` can swap in the per-test transaction that is rolled
back after each test. And the three authority predicates take a user and an owner
identifier and nothing else - no request, no session, no ``Depends`` - so the ownership rule
is unit-testable from two constructed objects.
"""

import dataclasses
from collections.abc import AsyncGenerator
from typing import Annotated, Final
from uuid import UUID

from fastapi import Depends, Query
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenError, UnauthorizedError
from app.core.security import decode_access_token
from app.db.session import AsyncSessionLocal
from app.models.user import User, UserRole

__all__ = [
    "DEFAULT_PAGE_SIZE",
    "MAX_PAGE_SIZE",
    "MIN_PAGE",
    "MIN_PAGE_SIZE",
    "TOKEN_URL",
    "AdminUser",
    "CurrentUser",
    "DbSession",
    "OptionalUser",
    "PageParams",
    "PageParamsDep",
    "can_modify",
    "ensure_can_modify",
    "get_current_active_user",
    "get_current_user",
    "get_current_user_optional",
    "get_db",
    "is_admin",
    "oauth2_scheme",
    "require_admin",
]


# ---------------------------------------------------------------------------------------
# Page-window bounds
#
# Named constants rather than literals buried in the field metadata, because three
# separate things have to agree on them: the `Query` validators below, the docstrings
# that state the contract, and the tests that assert it.
# ---------------------------------------------------------------------------------------

MIN_PAGE: Final[int] = 1
"""Lowest accepted ``page``. Pages are 1-based, so ``0`` is a client defect, not page one.

A 0-based interpretation would make ``page=0`` and ``page=1`` return the same rows and
every page number in a shared link ambiguous, so the value is rejected outright rather
than coerced. ``app.core.pagination.build_page`` echoes the requested page back verbatim,
which only reads correctly if the two ends agree that counting starts here.
"""

MIN_PAGE_SIZE: Final[int] = 1
"""Smallest accepted ``page_size``.

Zero is rejected here rather than left to be handled downstream. It has no meaningful
answer - a window of no rows over a non-empty collection - and it is the one input
``app.core.pagination.build_page`` raises on, because ``pages = ceil(total / page_size)``
cannot be computed from it. Bounding it at the edge is what makes that raise unreachable
from a request.
"""

MAX_PAGE_SIZE: Final[int] = 100
"""Largest accepted ``page_size``, and the reason this module needs no configuration.

The cap exists so that a single request cannot ask the database for an unbounded window:
without it ``?page_size=1000000`` is a legal request that becomes a full table scan, a
response the client cannot render and a memory profile no amount of indexing improves.

It is a module constant and deliberately *not* a settings field. ``.env.example`` is a
closed contract of fourteen variables that four other files are written against, and a
deployment able to raise this ceiling is a deployment able to turn every list endpoint
into a denial-of-service vector. This is a property of the API contract, not of an
environment.

Note the asymmetry with :data:`MIN_PAGE`: ``page_size`` is capped and ``page`` is not. A
page past the end is not an error - the windowed query legitimately matches nothing, and
the requested page is echoed back next to the real page count so a client can tell it has
run off the end. Clamping ``page`` to the last page would instead answer a different
question from the one that was asked, and silently.
"""

DEFAULT_PAGE_SIZE: Final[int] = 20
"""``page_size`` applied when the caller does not ask for one.

Comfortably inside :data:`MAX_PAGE_SIZE`, large enough that the home feed fills a desktop
grid without a second request, and small enough that a mobile client is not made to
download rows it will never scroll to.
"""

TOKEN_URL: Final[str] = "/api/v1/auth/login"
"""Path of the token endpoint advertised to OpenAPI by :data:`oauth2_scheme`.

Stated once, here, because two things must agree on it or the ``Authorize`` control in the
generated documentation posts credentials into a 404: this scheme's declaration and the
route ``app.api.v1.routers.auth`` mounts. It is the fully prefixed path, since the value is
what a documentation client is told to call, not a path relative to a router's own prefix.
"""


# ---------------------------------------------------------------------------------------
# Request-scoped database session
# ---------------------------------------------------------------------------------------


async def get_db() -> AsyncGenerator[AsyncSession]:
    """Yield one database session for the lifetime of a request.

    The single source of a session in the service tier. A route declares
    :data:`DbSession` and receives a live :class:`~sqlalchemy.ext.asyncio.AsyncSession`;
    it never constructs one, and neither does a service or a repository - they receive the
    session that was injected here. That is what makes "no handler touches a datastore
    directly" a property of the wiring rather than a convention.

    Lifecycle, in full:

    * ``async with AsyncSessionLocal()`` guarantees the session is closed and its
      connection returned to the pool on every exit path, including cancellation.
    * An exception propagating out of the route is rolled back **before** it is re-raised,
      so the connection cannot be handed back to the pool still inside a failed
      transaction. Without this, the next request to check that connection out would
      inherit an aborted transaction and fail on a statement of its own.
    * The exception is then re-raised untouched, so ``app.core.exceptions`` still sees the
      domain error the service raised and renders the intended problem document. Swallowing
      it here would turn a 404 into a 200 with an empty body.

    **Nothing is committed here.** Transaction boundaries belong to the service layer,
    which knows when a unit of work is complete - a post created, its categories
    associated, its slug de-duplicated. An automatic commit on the way out would persist
    half of that work whenever a later step failed, which is the one failure mode a
    transaction exists to prevent. A route that only reads therefore commits nothing, and a
    route that writes commits explicitly.

    Yields:
        A session bound to a pooled connection, with ``expire_on_commit=False`` so a model
        instance stays readable after the commit that saved it - which is what lets a route
        commit and then serialise its response.

    Note:
        This is a plain module-level function on purpose: not a class, not a factory that
        returns a dependency, and not memoised. ``backend/tests/conftest.py`` replaces it
        through ``app.dependency_overrides[get_db]`` with a session bound to a transaction
        it rolls back after every test, and every one of the integration suites depends on
        that substitution working. Any indirection added here would have to be mirrored
        there.

        The return annotation is ``AsyncGenerator[AsyncSession]`` rather than the
        three-argument spelling: from Python 3.13 the send and return parameters carry
        defaults, and ruff's ``UP043`` rejects restating them under this project's
        ``py314`` target.
    """
    async with AsyncSessionLocal() as session:
        try:
            yield session
        except Exception:
            # Roll back before the connection returns to the pool, then let the original
            # exception continue unchanged - `raise` with no argument preserves the
            # traceback, which `raise error` would truncate.
            await session.rollback()
            raise


DbSession = Annotated[AsyncSession, Depends(get_db)]
"""A request-scoped :class:`~sqlalchemy.ext.asyncio.AsyncSession`.

The spelling every router uses: ``async def get_post(slug: str, db: DbSession)``. Because
the alias resolves through :func:`get_db`, a test that overrides ``get_db`` also redirects
every dependency built on top of it, including the principal resolvers below.
"""


# ---------------------------------------------------------------------------------------
# The bearer scheme
# ---------------------------------------------------------------------------------------

oauth2_scheme: Final[OAuth2PasswordBearer] = OAuth2PasswordBearer(
    tokenUrl=TOKEN_URL,
    auto_error=False,
)
"""Extracts the credential from the ``Authorization: Bearer`` header. Nothing more.

Two constructor arguments, and both are load-bearing.

**Why ``OAuth2PasswordBearer`` and not ``HTTPBearer``.** The scheme it declares in the
OpenAPI document is what drives the ``Authorize`` control in the generated documentation:
it renders a username-and-password form and posts it, as ``application/x-www-form-urlencoded``,
to :data:`TOKEN_URL`. That is why ``python-multipart`` is a runtime dependency and why the
login route accepts the standard password grant. ``HTTPBearer`` would advertise a bare
token field instead, so a reader of ``/docs`` would have to obtain a token by some other
means before they could exercise a single protected route.

**Why ``auto_error=False``.** Left at its default of ``True``, the scheme raises a framework
error of its own when the header is absent, and answers with the body
``{"detail": "Not authenticated"}`` - the one error shape in the entire API that a client
would have to parse differently, and a direct contradiction of the requirement that every
error response be the same problem document. With the flag off, the scheme returns ``None``
and the rejection becomes this module's to make: :func:`get_current_user` raises
:class:`~app.core.exceptions.UnauthorizedError`, the registered handler renders the uniform
document, and ``WWW-Authenticate: Bearer`` still reaches the wire because that error class
carries the challenge in its default headers. It is also what makes
:func:`get_current_user_optional` expressible at all - an anonymous read cannot be served
by a scheme that raises before the endpoint is entered.

The scheme performs no verification of its own. It reads a header, checks the ``Bearer``
prefix and hands over the remaining characters; whether those characters are a token is
decided by :func:`app.core.security.decode_access_token`.
"""

_BearerToken = Annotated[str | None, Depends(oauth2_scheme)]
"""The raw credential, or ``None`` when the caller presented no usable ``Authorization``.

Private, because it is a *parameter* type for the two resolvers below rather than part of
the wiring vocabulary. A router that reached for a raw token would be re-implementing the
principal resolution this module exists to centralise, so the name is deliberately not
exported.
"""


# ---------------------------------------------------------------------------------------
# Principal resolution
# ---------------------------------------------------------------------------------------


async def _resolve_principal(token: str, db: AsyncSession) -> User:
    """Decode a credential and load the account it names.

    Shared by :func:`get_current_user` and :func:`get_current_user_optional`, which differ
    only in how they treat an *absent* credential. Once a credential is present the two
    must behave identically - the same signature checks, the same expiry handling, the same
    treatment of a subject with no row - and factoring the common path into one private
    helper is what guarantees that rather than hoping two copies stay in step.

    Args:
        token: The credential, already stripped of its ``Bearer`` prefix by
            :data:`oauth2_scheme`. Non-empty; the callers reject the empty case first.
        db: The request-scoped session.

    Returns:
        The loaded principal.

    Raises:
        TokenExpiredError: The token's signature was valid but its lifetime has elapsed.
            Propagated from :func:`app.core.security.decode_access_token` untouched, so a
            client can tell "refresh me" from "sign in again".
        InvalidTokenError: The token failed signature, structure or claim validation, or it
            was a refresh token presented as a bearer credential.
        UnauthorizedError: The token was valid but names an account that no longer exists.
    """
    # Every decode failure already leaves `decode_access_token` as a 401 in the
    # UnauthorizedError family, so it is neither caught nor re-wrapped here: catching it to
    # re-raise a generic error would discard the expired-versus-invalid distinction the
    # client uses to decide whether refreshing is worth attempting.
    claims = decode_access_token(token)

    # A primary-key identity load, not a query. `AsyncSession.get` consults the session's
    # identity map before it touches the database and emits a single indexed lookup when it
    # has to - there is no filtering, ordering or composition to speak of, so this is not
    # the query construction that belongs to `app.repositories`. Reaching for
    # `app.repositories.user_repository` from here would invert the layering instead: the
    # repositories sit above `app.core` and import it, so the reference would close a cycle
    # to save nothing.
    #
    # No relationship is loaded. The principal is needed for identity and authority only,
    # and `app.models.user` sets no eager strategy precisely so that a byline lookup does
    # not drag in every post, comment, like and refresh token the account owns.
    user = await db.get(User, claims.subject)

    if user is None:
        # The signature was genuine, so the token was minted by this service - the account
        # it names has since been deleted. This is a 401 and never a 404: answering "not
        # found" would confirm that the subject in a token was once a real account, and
        # would report a *credential* problem as a *resource* problem, sending a client
        # looking for a missing page instead of signing in again. Raised bare, so the
        # message is identical to the one an absent or malformed credential produces.
        raise UnauthorizedError

    return user


async def get_current_user(token: _BearerToken, db: DbSession) -> User:
    """Resolve the authenticated principal from the ``Authorization`` header.

    The foundation the other two resolvers are built on, and rarely the right dependency to
    use directly: it establishes *who* the caller is without checking whether the account
    is still permitted to act. Prefer :data:`CurrentUser`, which adds that check.

    Args:
        token: The credential extracted by :data:`oauth2_scheme`, or ``None`` when the
            request carried no usable ``Authorization`` header.
        db: The request-scoped session.

    Returns:
        The loaded principal, freshly read on this request - so its ``role`` and
        ``is_active`` reflect the database now rather than whenever the token was issued.

    Raises:
        UnauthorizedError: No credential was presented, or the one presented was malformed,
            expired, of the wrong token type, or names an account that no longer exists.
            Every one of those produces the same ``detail`` and the same
            ``WWW-Authenticate: Bearer`` challenge, because telling a caller which check
            failed tells an attacker which one to fix next.
    """
    # `not token` covers both cases the scheme can produce for a caller with no usable
    # credential: a missing or non-Bearer header, which yields None, and a well-formed
    # `Authorization: Bearer` with nothing after the prefix, which yields "". An empty
    # string would otherwise reach `decode_access_token` and be rejected there anyway, but
    # as an InvalidTokenError - "the token is invalid" - which misdescribes a request that
    # presented no token at all.
    if not token:
        raise UnauthorizedError

    return await _resolve_principal(token, db)


async def get_current_user_optional(token: _BearerToken, db: DbSession) -> User | None:
    """Resolve the principal when one was presented, and return ``None`` when none was.

    For the public reads whose *content* depends on who is asking. The feed and a post
    detail hide drafts from everyone except their author and an administrator; a like
    summary reports whether the caller has already liked the post; a comment list shows
    only approved comments to the public. Each of those is readable anonymously and richer
    when it is not, and without this resolver every one of those routers would parse the
    ``Authorization`` header itself - which is the duplication this module exists to
    prevent.

    The asymmetry between the two failure modes is the whole point of the function:

    * **No credential** is not an error. The caller is anonymous and the endpoint serves
      its public projection.
    * **A credential that is present but unusable** *is* an error, and it is not quietly
      downgraded to anonymous. The client owns refresh-on-401: a 401 is precisely the signal
      that makes it exchange its refresh token and retry. Swallowing it would leave a reader
      holding a stale token, permanently served the anonymous view, with nothing in the
      response to tell them their session had lapsed - and no route to recovering it.

    Args:
        token: The credential extracted by :data:`oauth2_scheme`, or ``None``.
        db: The request-scoped session.

    Returns:
        The loaded principal, or ``None`` when the request was anonymous.

    Raises:
        UnauthorizedError: A credential was presented and could not be used - malformed,
            expired, of the wrong token type, or naming an account that no longer exists.

    Note:
        This resolver deliberately does **not** apply the deactivated-account check. It
        answers "who is asking", and a deactivated account reading a public page is still
        reading a public page. Anything a deactivated account must be barred from doing is
        a protected operation and therefore depends on :data:`CurrentUser` instead.
    """
    if not token:
        return None

    return await _resolve_principal(token, db)


async def get_current_active_user(user: Annotated[User, Depends(get_current_user)]) -> User:
    """Require an authenticated principal whose account is still permitted to act.

    The dependency a protected route should normally use, exported as :data:`CurrentUser`.
    Deactivation is how an account is withdrawn without deleting the content it authored,
    so it has to be enforced on every authenticated operation rather than at sign-in: an
    access token already in circulation would otherwise keep working until it expired.

    Args:
        user: The principal resolved by :func:`get_current_user`.

    Returns:
        The same principal, once confirmed active.

    Raises:
        ForbiddenError: The account is deactivated.

    Note:
        403 and not 401, and the distinction is functional rather than pedantic. The
        credential is genuine and refreshing it would produce another perfectly valid
        credential for the same deactivated account, so a 401 would send a well-behaved
        client into a refresh-and-retry loop it could never exit. 403 says the answer will
        not change. The ``detail`` names the account state and nothing else: the caller has
        already proved they hold a credential for this account, so it discloses nothing they
        did not present.
    """
    if not user.is_active:
        raise ForbiddenError("This account has been deactivated.")

    return user


CurrentUser = Annotated[User, Depends(get_current_active_user)]
"""The authenticated, active principal. The default dependency for a protected route.

Rejects an absent, malformed, expired or wrong-type credential with 401, an account that no
longer exists with 401, and a deactivated account with 403.
"""

OptionalUser = Annotated[User | None, Depends(get_current_user_optional)]
"""The principal when one was presented, ``None`` when the caller is anonymous.

For a public endpoint whose projection widens for a known caller. A *present but unusable*
credential is still a 401 - see :func:`get_current_user_optional`.
"""


# ---------------------------------------------------------------------------------------
# Authorisation
#
# One dependency and three pure predicates. The dependency gates a whole namespace; the
# predicates are what a service calls when authority depends on the row being acted on,
# which a dependency cannot know.
# ---------------------------------------------------------------------------------------


async def require_admin(user: CurrentUser) -> User:
    """Require the principal to hold ``ADMIN``. The administrative gate.

    **Apply this at router level, not per route.** The administrative namespace is mounted
    as ``APIRouter(prefix="/admin", dependencies=[Depends(require_admin)])`` in
    ``app.api.v1.routers.admin``, so the gate covers every operation beneath it - including
    one added months later by someone who never read this docstring. Applying it per route
    is a latent hole rather than an equivalent style: it holds only for as long as every
    author of every future route remembers, and the one route that forgets is an
    unauthenticated administrative endpoint that no test asks about because no test knows it
    exists. Where an individual handler also needs the administrator *object* - to attribute
    an action, say - it declares :data:`AdminUser` as a parameter; the router-level
    dependency stays regardless, and FastAPI resolves the shared dependency once per
    request either way.

    Args:
        user: The authenticated, active principal, resolved through :data:`CurrentUser` - so
            an absent credential is already a 401 and a deactivated account already a 403
            before this check is reached.

    Returns:
        The same principal, once confirmed to hold ``ADMIN``.

    Raises:
        ForbiddenError: The principal holds ``READER`` or ``AUTHOR``. 403, not 404: the
            administrative namespace is documented, so hiding its existence buys nothing,
            and not 401 either, because the credential is perfectly good. Raised bare, so
            the response says only that permission is lacking and never which role would
            have sufficed.

    Note:
        The comparison is against the role on the **loaded row**, never against the token's
        ``role`` claim. Both are available at this point and only one of them is current: a
        token minted while its holder was an administrator carries ``role: "ADMIN"`` for the
        rest of its lifetime, so trusting the claim would leave a demoted administrator in
        full command of this namespace until their access token expired. Reading the row
        makes a revocation effective on the very next request. It costs nothing extra -
        :func:`get_current_user` has already loaded the account to authenticate it.
    """
    if not is_admin(user):
        raise ForbiddenError

    return user


AdminUser = Annotated[User, Depends(require_admin)]
"""The authenticated, active principal, additionally required to hold ``ADMIN``.

Declared as a parameter by an administrative handler that needs the principal itself. It is
not a substitute for the router-level ``dependencies=[Depends(require_admin)]`` that gates
the namespace - see :func:`require_admin`.
"""


# ---------------------------------------------------------------------------------------
# Authority predicates
#
# Plain functions: no `Depends`, no `Request`, no session, no I/O and no await. That is
# what lets `backend/tests/unit/test_permissions.py` cover every branch from two
# constructed objects, with no HTTP client and no database, and it is why the ownership
# rule is expressed once here instead of being spelled out inside each service.
#
# The services own the authority *decision* - `post_service` decides that editing a post
# is an ownership-scoped operation - and they make it by calling these, so the rule itself
# has one definition. A dependency could not do this work: whether a caller may act
# depends on the row being acted on, which is not known until the service has loaded it.
# ---------------------------------------------------------------------------------------


def is_admin(user: User) -> bool:
    """Report whether a principal holds the administrator role.

    Identity comparison against the enum member rather than a string comparison against
    ``"ADMIN"``. ``UserRole`` is a :class:`~enum.StrEnum`, so ``user.role == "ADMIN"`` would
    also be true and would also be a latent typo: ``"Admin"`` compiles, reads correctly and
    is silently false for every caller. Comparing members makes a misspelling an
    ``AttributeError`` at import time instead of an authorisation bypass at runtime.

    Args:
        user: The principal to test. Expected to have been loaded on this request, since a
            stale instance would answer with a stale role.

    Returns:
        ``True`` for ``ADMIN``; ``False`` for ``AUTHOR`` and ``READER``.
    """
    return user.role is UserRole.ADMIN


def can_modify(user: User, owner_id: UUID) -> bool:
    """Report whether a principal may mutate a resource owned by ``owner_id``.

    The whole of the ownership rule, in one place: an author may act on their own content,
    an administrator may act on anyone's. It is written here rather than in each service so
    that the two services enforcing it - posts and comments - cannot drift apart, and so
    that a third one added later inherits the rule instead of reinventing it.

    Args:
        user: The principal attempting the mutation.
        owner_id: The ``author_id`` of the resource. A plain :class:`~uuid.UUID` rather than
            an entity, so the predicate is usable from a service that holds only the
            identifier and cannot be tempted into a lazy relationship load - which under an
            async session raises ``MissingGreenlet`` rather than answering the question.

    Returns:
        ``True`` when the principal owns the resource or holds ``ADMIN``.

    Examples:
        >>> can_modify(author, author.id)
        True
    """
    # Ownership first: the common case, and it needs no role lookup.
    return user.id == owner_id or is_admin(user)


def ensure_can_modify(user: User, owner_id: UUID) -> None:
    """Raise unless the principal may mutate a resource owned by ``owner_id``.

    The form a service actually calls, so that the guard is one statement at the top of a
    mutating method rather than an ``if`` whose ``else`` branch someone can forget to write.
    Returning ``None`` on success is deliberate: there is no truthy value to accidentally
    discard, so ``ensure_can_modify(user, post.author_id)`` on a line of its own is complete
    and correct, and a reviewer can see at a glance that the check is not merely computed.

    Args:
        user: The principal attempting the mutation.
        owner_id: The ``author_id`` of the resource.

    Raises:
        ForbiddenError: The principal neither owns the resource nor holds ``ADMIN``. Raised
            bare, so the response never reveals who does own it.

    Note:
        403 is correct only once the caller is already entitled to know the resource exists.
        Where visibility is itself privileged - an unpublished draft, which is invisible to
        everyone but its author and an administrator - the service reports
        :class:`~app.core.exceptions.NotFoundError` *before* reaching this check, so that a
        missing draft and an invisible one are indistinguishable and identifiers cannot be
        enumerated by reading status codes.
    """
    if not can_modify(user, owner_id):
        raise ForbiddenError


# ---------------------------------------------------------------------------------------
# The request page window
# ---------------------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True, slots=True)
class PageParams:
    """The validated, bounded window a client asked for. One definition, every list route.

    Three list surfaces have to window results identically or the client cannot share one
    pagination control between them: the home feed, an author's profile listing, and each of
    the administrative tables. Declaring the two parameters once, here, is what makes that
    true - a route writes ``page: PageParamsDep`` and inherits the names, the defaults, the
    bounds and the OpenAPI documentation without restating any of them.

    FastAPI reads the ``Query`` metadata off the annotations below and treats the two fields
    as query parameters of the route that depends on this class, so ``?page=2&page_size=50``
    is validated before the endpoint is entered and a violation becomes the standard 422
    problem document with a populated ``errors`` list. No route validates these values, and
    none needs to.

    Frozen, so a service cannot quietly renumber the window it was handed and answer a
    different question from the one that was asked. Slotted, because there are no dynamic
    attributes to allow.

    Attributes:
        page: The 1-based page requested. At least :data:`MIN_PAGE`, with **no upper
            bound** - see the note below.
        page_size: Rows per page. Between :data:`MIN_PAGE_SIZE` and :data:`MAX_PAGE_SIZE`,
            defaulting to :data:`DEFAULT_PAGE_SIZE`.

    Note:
        The bounds are deliberately asymmetric. ``page_size`` is capped so that one request
        cannot ask the database for an unbounded window. ``page`` is not capped, and must
        never be clamped to the last page: a page past the end is a legitimate request that
        matches no rows, and the contract is that it answers with an empty ``items`` list
        while echoing the requested page back next to the real page count - which is how a
        client detects that it has run off the end. Clamping would instead return the last
        page's rows under the page number the caller asked for, silently answering a
        different question. An out-of-range page is a 200, never a 404 and never a 422.

        Only ``page`` and ``page_size`` live here. ``q``, ``category``, ``author`` and
        ``sort`` are feed-specific filters that ``app.api.v1.routers.posts`` declares on its
        own signature; folding them in would push feed concerns into the comment listing and
        every administrative table, and would document four parameters on routes that have
        no use for them.

        This class is the *request* half of the pagination contract. The *response* half -
        ``Page`` and ``build_page``, carrying ``items``, ``total``, ``page``, ``page_size``
        and ``pages`` - belongs to :mod:`app.core.pagination`, which is why nothing is
        imported from there: it holds no FastAPI dependency and must stay importable from
        the schema layer. The two halves meet in ``app.repositories.base``, whose paginate
        primitive consumes :attr:`limit` and :attr:`offset` and whose caller passes
        :attr:`page` and :attr:`page_size` to ``build_page``.
    """

    page: Annotated[
        int,
        Query(
            ge=MIN_PAGE,
            description="1-based page number. A page past the last one returns no items.",
        ),
    ] = MIN_PAGE

    page_size: Annotated[
        int,
        Query(
            ge=MIN_PAGE_SIZE,
            le=MAX_PAGE_SIZE,
            description=f"Rows per page, {MIN_PAGE_SIZE}-{MAX_PAGE_SIZE}.",
        ),
    ] = DEFAULT_PAGE_SIZE

    @property
    def offset(self) -> int:
        """Rows to skip to reach the requested page - the SQL ``OFFSET``.

        Exposed as a property so the window arithmetic is performed in exactly one place. A
        repository that recomputed ``(page - 1) * page_size`` inline would be one
        off-by-one away from a feed that silently skips or repeats a row at every page
        boundary, and the defect would have to be found once per repository.

        Returns:
            ``(page - 1) * page_size``: zero for the first page, non-negative always,
            because :data:`MIN_PAGE` and :data:`MIN_PAGE_SIZE` are both positive.
        """
        return (self.page - 1) * self.page_size

    @property
    def limit(self) -> int:
        """Rows to return - the SQL ``LIMIT``.

        Identical to :attr:`page_size` by definition, and named separately so that a
        repository signature reads in the vocabulary of the statement it builds
        (``paginate(stmt, limit=..., offset=...)``) rather than in the vocabulary of the
        query string. Guaranteed positive by the field's own lower bound, which is what
        keeps ``LIMIT`` from ever being emitted as zero or negative.

        Returns:
            The validated ``page_size``.
        """
        return self.page_size


PageParamsDep = Annotated[PageParams, Depends()]
"""The validated page window, injected into a list route.

``Depends()`` is intentionally argument-free: FastAPI takes the annotated type itself as the
dependency, constructing a :class:`PageParams` from the request's query string. A route
declares ``page: PageParamsDep`` and receives an object whose bounds have already been
enforced.
"""
