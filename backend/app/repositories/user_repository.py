"""The ``users`` and ``refresh_tokens`` queries: identity lookup, and revocable sessions.

Two repositories live here, and both serve one concern - answering "who is this?" against
stored state. :class:`UserRepository` resolves an account by the natural keys the product
addresses accounts by, and windows the administrative user table.
:class:`RefreshTokenRepository` records an issued refresh token, finds one by its digest,
withdraws one or all of an account's tokens, and sweeps the rows that have lapsed.

Why two classes rather than one
-------------------------------
:class:`~app.repositories.base.BaseRepository` is generic over a single mapped class, so a
repository declared ``BaseRepository[User]`` types every inherited helper - ``get_by_id``,
``add``, ``save``, ``paginate`` - in terms of :class:`~app.models.user.User`. One class
covering both relations could not return a :class:`~app.models.refresh_token.RefreshToken`
from those helpers without widening them to ``Any``, which mypy's ``strict`` mode rejects and
which would erase exactly the type information the layer above relies on. Two
parameterisations cost nothing and keep both surfaces exact.

Case is the database's business, not this module's
--------------------------------------------------
``users.email`` and ``users.username`` are ``CITEXT``, so ``=`` against either is already
case-insensitive, and the unique indexes over them are what make a case-variant duplicate
account unstorable. Measured on PostgreSQL 18.4: inserting ``Alice`` / ``A@X.com`` and then
``alice`` / ``a@x.com`` raises a unique violation on the second insert. Two rules follow, and
both are load-bearing:

* **Nothing here lowercases anything.** No ``.lower()`` on an argument and no
  :func:`~sqlalchemy.func.lower` around a column. Wrapping the column would make the predicate
  ``lower(username) = :p``, which no index on ``username`` can serve, turning a single index
  probe into a sequential scan over every account - the same linear scan every addressed read
  in the retired implementation performed. Normalising the *argument* instead is no better: it
  would have to be applied on every write path and every lookup path, and the first path that
  forgot would silently admit the duplicate this design forbids.

  The one place a column is wrapped at all is the administrative containment search in
  :func:`_search_criteria`, which casts both columns to ``text``. That is the opposite case and
  it is deliberate: it is not an *equality* predicate, so it never had an index to lose, and the
  cast is what gives it one - ``ix_users_username_trgm`` and ``ix_users_email_trgm`` are GIN
  trigram indexes over exactly that expression, because ``gin_trgm_ops`` is defined over ``text``
  and cannot be applied to a citext column usefully. The operator becomes ``ILIKE`` in the same
  breath, because casting away citext casts away its case-folding too. The reasoning is recorded
  at that call site.
* **Nothing here pre-checks uniqueness as a guarantee.**
  :meth:`UserRepository.get_by_email_or_username` exists to make a registration conflict
  *friendly*, not to make it *safe*. Between that SELECT and the INSERT another transaction can
  claim the same address, so the unique index is what actually closes the window and
  ``app.services.auth_service`` must still translate the resulting
  :class:`~sqlalchemy.exc.IntegrityError` into its conflict error.

Rotation is one atomic claim
---------------------------
A refresh token is single-use, and "single-use" is a concurrency claim rather than a naming
convention. :meth:`RefreshTokenRepository.claim` therefore tests and spends a row in **one**
statement - ``UPDATE ... WHERE token_hash = :h AND revoked_at IS NULL AND expires_at > :now
RETURNING ...`` - so the liveness conditions are evaluated by PostgreSQL under the row lock
that the same statement takes to write. A row comes back only to the transaction that spent it.

Spelling that as a SELECT followed by an UPDATE would not be single-use at all. Two requests
presenting the same digest both read ``revoked_at IS NULL``, both conclude the token is good,
both revoke it and both commit, so one token mints two replacements - and a *replayed* token,
which is the observable signature of a leak, becomes indistinguishable from a legitimate first
use. Verified on PostgreSQL 18.4 by releasing two independent transactions onto one digest from
a barrier: exactly one received a row, and ``revoked_at`` was stamped once.

The two lookups are consequently not interchangeable, and the order is part of the contract:

1. :meth:`RefreshTokenRepository.claim` - the decision. A row means the caller may issue a
   replacement through :meth:`RefreshTokenRepository.create` in the same transaction.
2. :meth:`RefreshTokenRepository.get_by_hash` - the *diagnosis*, and only after a failed claim.
   It filters nothing, so a revoked row is visible as revoked, which is what lets
   ``app.services.auth_service`` tell a replayed token from an unknown one and respond to the
   former by revoking every token the account holds.

:meth:`RefreshTokenRepository.revoke` remains the logout path, where revoking twice is the same
outcome as revoking once and no replacement is minted. It is one statement for the same reason
:meth:`RefreshTokenRepository.claim` is - ``UPDATE ... SET revoked_at = coalesce(revoked_at,
:now) WHERE id = :id RETURNING ...`` - because the instant it records is evidence of when a
session ended, and a read-then-write pair lets the later of two concurrent logouts overwrite the
earlier one's timestamp. What differs is only what each statement has to establish: rotation
must prove it *alone* spent the token, so its predicate excludes an already-revoked row; logout
only has to end the session, so its predicate matches the row and lets ``coalesce`` keep
whichever instant got there first.

Only hashed token values cross this boundary
--------------------------------------------
:attr:`~app.models.refresh_token.RefreshToken.token_hash` stores a digest, never a token, and
this module neither computes nor verifies one. ``app.core.security.hash_refresh_token``
produces a deterministic SHA-256 digest - deterministic precisely so a presented token can be
*found* through the UNIQUE index rather than only verified against a row already in hand - and
the caller hands the result in. A raw token must never reach this layer: the moment one did,
the value in the WHERE clause would stop matching the value in the column, and every rotation
would fail to find a row that exists, silently and identically for every user.

What comes back, and what deliberately does not
-----------------------------------------------
Absence is ``None``, an empty result is an empty :class:`~collections.abc.Sequence`, and a bulk
statement reports how many rows it touched. Nothing here raises an HTTP artefact: no status
code, no framework exception, no domain exception. ``app.py`` raised the same
``HTTPException(404, "Item not found")`` three separate times from inside its data-access
loops, at ``L31``, ``L40`` and ``L49``; that judgement now belongs to ``app.core.exceptions``
and to the services, which alone know whether a missing row is a ``404``, a ``403`` in disguise
or a perfectly legitimate empty page.

:meth:`UserRepository.list_users` returns a plain ``(rows, total)`` tuple and does not import
``app.core.pagination``. ``Page`` is a wire shape, and the service layer owns the conversion by
calling ``build_page(list(rows), total, page, page_size)``.

Nothing here decides authority either. :class:`~app.models.user.UserRole` and ``is_active``
appear only as *filter* arguments; whether the caller may see the rows they select is settled
by ``require_admin`` in ``app.core.dependencies`` and by the service layer. A repository that
checked authority would let the next caller reach the same rows without the check.

Nothing here commits
--------------------
Every write ends at the ``flush()`` the inherited helpers perform. The service owns the commit,
``get_db`` rolls the session back on an exception, and ``tests/conftest.py`` rolls each test
back afterwards - a commit here would break all three at once.

Every instant is ``timestamptz``
--------------------------------
``app.db.base`` maps ``datetime`` to ``DateTime(timezone=True)``, so every instant this module
accepts or compares must be timezone-aware; a naive value would be read against the server's
session time zone, which is how an expiry sweep quietly removes the wrong rows.
:func:`_utc_now` is this module's fallback clock for the two revocation helpers, while
:meth:`RefreshTokenRepository.delete_expired` and
:meth:`RefreshTokenRepository.list_active_for_user` require the instant from the caller so a
test can control it exactly.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any, Final, cast

from sqlalchemy import (
    ColumnExpressionArgument,
    CursorResult,
    Text,
    UpdateBase,
    # Aliased because `typing.cast` is already imported above under the bare name, and the two
    # do entirely different things: one narrows a type for mypy, the other renders a SQL CAST.
    cast as sql_cast,
    delete,
    func,
    or_,
    select,
    update,
)

from app.models.refresh_token import RefreshToken
from app.models.user import User, UserRole
from app.repositories.base import UUIDPrimaryKeyRepository

__all__ = ["RefreshTokenRepository", "UserRepository"]


_LIKE_ESCAPE: Final = "\\"
"""The escape character :func:`_containment_pattern` uses inside a ``LIKE`` pattern.

Declared once and passed to every ``ilike()`` call built from it, because a pattern escaped
with one character and matched with another is not a subtle bug - it is a search that silently
treats a user's ``%`` as a wildcard.
"""


def _utc_now() -> datetime:
    """Return the current instant as a timezone-aware UTC :class:`~datetime.datetime`.

    Every temporal column in this schema is ``TIMESTAMP WITH TIME ZONE``, so an aware value is
    required rather than merely tidy: a naive one is interpreted against the server's session
    time zone, which makes a revocation instant depend on where the process happens to run.

    ``app.core.security`` keeps a private clock of its own, and this module deliberately does
    not reach for it. That module sits above the data layer and owns hashing and token issuance;
    importing it here would invert the dependency arrow and pull cryptography into a repository
    to obtain a one-line call to the standard library. The two helpers are independent by
    design, not by oversight - and the callers that care about determinism
    (:meth:`RefreshTokenRepository.delete_expired`,
    :meth:`RefreshTokenRepository.list_active_for_user`) take their instant as an argument and
    never consult this function at all.
    """
    return datetime.now(UTC)


def _containment_pattern(term: str) -> str:
    """Turn a caller's search term into a ``LIKE`` pattern that matches it literally.

    Wildcards in the *term* are escaped, so a term is always matched as text rather than as a
    pattern. This is not hypothetical tidiness: measured against PostgreSQL 18.4 on a
    ``CITEXT`` column holding four rows, the unescaped term ``%`` matched all four, while the
    escaped forms of ``c%r`` and ``d_a`` matched exactly the one row each was meant to. An
    administrator searching for a literal underscore in a username would otherwise get every
    account whose name has any character in that position, and a term of ``%`` alone would
    silently degrade the filter into "everything".

    The backslash itself is escaped first. Doing it in any other order would double-escape the
    escapes introduced for ``%`` and ``_``, so a term containing a real backslash would stop
    matching.

    Args:
        term: The raw search text, already stripped and known non-empty by the caller.

    Returns:
        A pattern of the form ``%<escaped term>%``, to be used with
        ``escape=``:data:`_LIKE_ESCAPE`.
    """
    escaped = (
        term.replace(_LIKE_ESCAPE, _LIKE_ESCAPE * 2)
        .replace("%", f"{_LIKE_ESCAPE}%")
        .replace("_", f"{_LIKE_ESCAPE}_")
    )
    return f"%{escaped}%"


class UserRepository(UUIDPrimaryKeyRepository[User]):
    """Queries over the ``users`` relation: natural-key lookup, and the administrative table.

    Every method is a single composed statement, and the inherited helpers cover the rest of
    the relation's needs. In particular the following are **not** re-implemented here:

    * ``get_by_id`` - the identity predicate, defined once for the whole codebase.
    * ``add`` - registration. ``app.services.auth_service`` builds the
      :class:`~app.models.user.User` with the argon2id hash from ``app.core.security`` and hands
      the instance over; identity comes from PostgreSQL's ``gen_random_uuid()``, so no caller
      supplies an ``id``.
    * ``save`` - ``PATCH /api/v1/users/me``. The service mutates ``display_name``, ``bio`` or
      ``avatar_url`` in place and this flushes and reloads the row.
    * ``delete`` - administrative removal. The ``ON DELETE CASCADE`` foreign keys on ``posts``,
      ``comments``, ``post_likes`` and ``refresh_tokens`` remove everything the account owned in
      the statement PostgreSQL itself issues, so nothing here hand-deletes a child row.
    """

    model = User

    async def get_by_email(self, email: str) -> User | None:
        """Fetch the account registered with this email address, or ``None``.

        The comparison is a plain ``=`` against a ``CITEXT`` column, so ``A@X.com`` and
        ``a@x.com`` resolve to the same account and the lookup is served by the unique index
        ``ix_users_email`` as a single probe. The argument is passed through untouched - see
        "Case is the database's business" in the module docstring for why lowercasing either
        side would be actively harmful.

        Args:
            email: The address to look up, in whatever case the caller received it.

        Returns:
            The account, or ``None`` when no account carries that address. Absence is never an
            error here: on the login path it means "no such account", and on the registration
            path it means "the address is free".
        """
        return await self.get_or_none(User.email == email)

    async def get_by_username(self, username: str) -> User | None:
        """Fetch the account holding this public handle, or ``None``.

        The lookup behind ``GET /api/v1/users/{username}``, the client's ``/u/[username]`` route
        and the feed's author filter, so it is on the hot path of the public site and must stay
        an index probe. ``CITEXT`` plus the unique index ``ix_users_username`` give that, and
        they are also what makes ``/u/Alice`` and ``/u/alice`` one profile rather than one
        profile and one ``404``.

        Args:
            username: The handle to look up, in whatever case the URL supplied it.

        Returns:
            The account, or ``None`` when the handle is unclaimed.
        """
        return await self.get_or_none(User.username == username)

    async def get_by_email_or_username(self, email: str, username: str) -> User | None:
        """Fetch the first account already using either of these identifiers, or ``None``.

        One statement with ``LIMIT 1``, so registration can report *that* something is taken in
        a single round trip instead of two.

        This is a **convenience, not the guarantee.** The two ``CITEXT`` unique indexes are what
        actually prevent a duplicate: another transaction can claim the same address between
        this SELECT and the INSERT that follows, and no amount of pre-checking closes that
        window. ``app.services.auth_service`` must therefore still translate the
        :class:`~sqlalchemy.exc.IntegrityError` from the insert into its conflict error, and
        treat this call purely as the source of a friendlier message.

        Args:
            email: The candidate email address.
            username: The candidate handle.

        Returns:
            An account matching either identifier, or ``None`` when both are free. Which of the
            two collided is deliberately not reported: the row is returned whole, so the caller
            can compare whichever fields its message needs without a second query.
        """
        return await self.get_or_none(or_(User.email == email, User.username == username))

    async def list_users(
        self,
        *,
        q: str | None = None,
        role: UserRole | None = None,
        is_active: bool | None = None,
        limit: int,
        offset: int,
    ) -> tuple[Sequence[User], int]:
        """Window the administrative user table, filtered and newest first.

        Backs ``GET /api/v1/admin/users``. The three filters compose: supplying a role and an
        active state and a search term applies all three, and ``total`` counts the filtered set
        rather than the relation.

        The ordering is ``created_at DESC`` with ``id DESC`` as a tiebreaker, and the tiebreaker
        is required rather than decorative. ``created_at`` defaults to ``now()``, which
        PostgreSQL evaluates once per *transaction*, so every account created by one seed run or
        one test fixture shares a single instant. Ordering on that column alone would leave
        their relative order unspecified, and an unspecified order under ``LIMIT``/``OFFSET`` is
        how a row appears on two consecutive pages while another appears on neither. Adding the
        primary key makes the ordering total, so paging is stable.

        Args:
            q: Optional free-text term matched against ``username`` and ``email``. Whitespace is
                stripped and a blank term is treated as absent, so ``?q=`` does not add a
                predicate that matches everything. Wildcards inside the term are escaped by
                :func:`_containment_pattern` and matched literally.
            role: Optional exact authority filter.
            is_active: Optional exact activity filter. Tested against ``None`` rather than for
                truth, because ``False`` is a meaningful value here - "show me the suspended
                accounts" is the reason the filter exists.
            limit: Rows per page.
            offset: Rows to skip.

        Returns:
            ``(rows, total)``. A page past the end returns an empty sequence beside the real
            total, which is how the caller detects it has run off the end;
            ``app.services.admin_service`` turns the pair into the wire envelope through
            ``build_page``.
        """
        criteria = self._filter_criteria(q=q, role=role, is_active=is_active)
        statement = select(User).where(*criteria).order_by(User.created_at.desc(), User.id.desc())
        return await self.paginate(statement, limit=limit, offset=offset)

    async def count_users(
        self,
        *,
        role: UserRole | None = None,
        is_active: bool | None = None,
    ) -> int:
        """Count accounts, optionally narrowed by authority and activity.

        Feeds the aggregate figures on ``GET /api/v1/admin/stats``, where the total is wanted
        without any of the rows. The inherited ``count`` emits ``SELECT count(*)`` and builds no
        entities, so this costs one round trip regardless of how many accounts exist.

        The predicates come from the same builder :meth:`list_users` uses, which is what keeps a
        count and its table consistent: a filter added to one cannot go missing from the other.

        Args:
            role: Optional exact authority filter.
            is_active: Optional exact activity filter.

        Returns:
            The number of matching accounts, or ``0`` when none match.
        """
        return await self.count(*self._filter_criteria(role=role, is_active=is_active))

    @staticmethod
    def _filter_criteria(
        *,
        q: str | None = None,
        role: UserRole | None = None,
        is_active: bool | None = None,
    ) -> list[ColumnExpressionArgument[bool]]:
        """Build the ``WHERE`` terms shared by :meth:`list_users` and :meth:`count_users`.

        The single definition of what "filtered users" means. Both callers pass their own
        arguments through it, so the table and its count can never apply different predicates -
        which is the same reason the identity predicate lives once in
        :meth:`~app.repositories.base.BaseRepository.get_by_id` rather than three times across
        three handlers.

        Every filter is skipped when its argument is ``None``, so an omitted filter contributes
        no term at all rather than a tautology for the planner to work around.

        Args:
            q: Optional search term. Only whitespace, or an empty string, counts as absent.
            role: Optional exact authority filter.
            is_active: Optional exact activity filter.

        Returns:
            Zero to three SQL boolean expressions, to be combined with ``AND`` by the caller.
        """
        criteria: list[ColumnExpressionArgument[bool]] = []

        term = q.strip() if q is not None else ""
        if term:
            # Both columns are matched through an explicit cast to `text`, and both with `ilike`.
            # Neither choice is stylistic - together they are what makes this containment search
            # index-served rather than a sequential scan over every account in the system.
            #
            # THE CAST. `ix_users_username_trgm` and `ix_users_email_trgm` are GIN trigram indexes
            # over `(column::text)`, and they are declared that way because they must be:
            # `gin_trgm_ops` is defined over `text`, while citext's own `~~`/`~~*` operators are
            # not in that operator family, so an index declared directly on a citext column is
            # accepted by PostgreSQL and then never chosen by the planner - at any size, because
            # the operator family never matches. Measured on 18.4: a leading-wildcard containment
            # on the bare column is a sequential scan even with the unique index present, while
            # over the cast the same predicate plans as an `Index Cond` on both indexes under a
            # BitmapOr. Whether the planner PREFERS that bitmap to reading the table is a separate
            # cost question that arrives with volume - it still scans at thirty thousand accounts
            # and takes both indexes at three hundred thousand - but reachability is the part this
            # spelling controls. The predicate has to be spelled the way the index is, so the cast
            # is here rather than only there.
            #
            # THE OPERATOR. `ilike` is now load-bearing rather than merely expressive: casting a
            # citext value to `text` also casts away its case-insensitivity, so `LIKE` over the
            # cast would silently become a case-SENSITIVE search - an administrator typing `alice`
            # would stop finding `Alice`. `ILIKE` restores the folding the column type was
            # providing, so the result set is identical to the pre-cast predicate.
            #
            # Only this containment predicate is cast. The equality lookups in `get_by_email` and
            # `get_by_username` compare the columns themselves, so they keep using the unique
            # citext indexes and are unaffected by anything here.
            pattern = _containment_pattern(term)
            criteria.append(
                or_(
                    sql_cast(User.username, Text).ilike(pattern, escape=_LIKE_ESCAPE),
                    sql_cast(User.email, Text).ilike(pattern, escape=_LIKE_ESCAPE),
                )
            )

        if role is not None:
            criteria.append(User.role == role)

        if is_active is not None:
            criteria.append(User.is_active.is_(is_active))

        return criteria


class RefreshTokenRepository(UUIDPrimaryKeyRepository[RefreshToken]):
    """Queries over the ``refresh_tokens`` relation: issuance, claiming, revocation, sweeping.

    The whole point of the relation is that a signed access token cannot be withdrawn, so the
    long-lived half of the pair is recorded as a row that can be marked spent. These methods are
    what ``app.services.auth_service`` needs in order to do that: record an issuance, **claim a
    presented token exactly once**, look one up whatever state it is in, withdraw one or all of
    them, and clear away what has lapsed.

    :meth:`claim` and :meth:`get_by_hash` are two different questions about one digest and the
    order they are asked in is the whole of rotation's correctness - see "Rotation is one atomic
    claim" in the module docstring. :meth:`claim` is the only method that decides a token is
    spent; :meth:`get_by_hash` never does.

    Every value handled here is already a digest. Nothing in this class hashes, generates,
    compares or judges a token - see "Only hashed token values cross this boundary" in the
    module docstring.
    """

    model = RefreshToken

    async def create(
        self,
        *,
        user_id: uuid.UUID,
        token_hash: str,
        expires_at: datetime,
    ) -> RefreshToken:
        """Record one issued refresh token.

        Keyword-only on purpose: three arguments of which two are opaque strings-and-UUIDs is
        exactly the shape where a positional call eventually transposes a pair, and here the
        transposition would be silent rather than loud.

        Args:
            user_id: The account the token was issued to. A server-generated
                :class:`~uuid.UUID` read from an existing row, never a client-supplied value.
            token_hash: The **already-hashed** token, as produced by
                ``app.core.security.hash_refresh_token``. This layer never hashes, so passing a
                raw token here would store a value no later lookup could match. The UNIQUE
                constraint ``uq_refresh_tokens_token_hash`` means re-recording a digest fails at
                the flush rather than creating a second, divergent record of one token.
            expires_at: Timezone-aware instant after which the token can no longer be exchanged,
                already computed by ``app.core.security`` from the configured lifetime.

        Returns:
            The persisted row with ``id`` and ``created_at`` populated by the database.
            ``revoked_at`` is ``NULL``, which is what "still exchangeable" means on this
            relation.
        """
        return await self.add(
            RefreshToken(user_id=user_id, token_hash=token_hash, expires_at=expires_at)
        )

    async def claim(self, token_hash: str, *, now: datetime | None = None) -> RefreshToken | None:
        """Spend one refresh token, atomically, and return it - or return ``None``.

        **This is the only correct entry point for rotation**, and it is one statement rather
        than a read followed by a write:

        .. code-block:: sql

            UPDATE refresh_tokens SET revoked_at = :now
             WHERE token_hash = :hash AND revoked_at IS NULL AND expires_at > :now
            RETURNING ...

        The conditions and the revocation are evaluated by PostgreSQL in the same statement, so
        the row is tested and spent under one row lock. Two concurrent requests presenting the
        same digest therefore cannot both succeed: the second blocks on the first's lock, then
        re-evaluates ``revoked_at IS NULL`` against the *committed* value, finds it set, matches
        nothing and returns ``None``. Verified on PostgreSQL 18.4 by racing two independent
        transactions on one digest from a barrier - exactly one received a row, and
        ``revoked_at`` was stamped once.

        Doing this as :meth:`get_by_hash` then :meth:`revoke` cannot give that guarantee however
        the calls are ordered. Both readers observe ``revoked_at IS NULL``, both decide the token
        is good, both write, and both commit - so one presented token mints two refresh tokens,
        single-use rotation is not single-use, and the replay of a leaked token is
        indistinguishable from its legitimate first use.

        Args:
            token_hash: The digest of the presented token, computed by the caller through
                ``app.core.security.hash_refresh_token``. Matched against the UNIQUE column, so
                at most one row can qualify.
            now: Optional timezone-aware instant, used both as the expiry cutoff and as the
                recorded revocation instant. Defaults to :func:`_utc_now`. One value serves both
                so the row cannot be judged live against one clock and stamped from another; a
                test pins it the same way :meth:`delete_expired` allows.

        Returns:
            The row, with ``revoked_at`` now set, when the digest named a token that was
            unrevoked and unexpired at *now*. ``None`` in every other case - no such digest, one
            already spent, one past its expiry, or one another transaction claimed first.

        Note:
            **``None`` is not an error and not a diagnosis.** Rotation needs to tell "never
            issued" from "already spent" from "expired", because the middle case is evidence a
            token leaked, and this method deliberately collapses all three. The caller resolves
            them by asking :meth:`get_by_hash` *after* a failed claim: that read is unfiltered,
            so a revoked row is visible as such and reuse detection becomes possible one layer
            up, where "revoke every token this account holds" is a decision rather than a query.

            **The replacement is a separate call.** :meth:`create` records the new token, and the
            service performs both inside one transaction, so the claim and the issuance commit
            together or not at all.

            ``populate_existing`` is passed so the returned entity reflects the row as the UPDATE
            left it even when this unit of work already held a copy - without it the identity map
            would keep a stale ``revoked_at`` of ``None`` on the very object the caller is about
            to act on. ``synchronize_session=False`` is passed for the reason
            :meth:`_execute_bulk` records, and is safe here precisely because ``RETURNING``
            refreshes the affected row directly rather than leaving the session to guess which
            objects a set-based write touched. ``"fetch"`` is not an option: measured against
            SQLAlchemy 2.0.51, it issues its reconciling SELECT outside the async bridge and
            raises ``MissingGreenlet``.

            Both execution options are passed as an ``execute()`` keyword rather than chained
            onto the statement. Chaining returns a plain ``Executable`` and drops the
            ``ReturningUpdate`` generic, which is what lets ``result.scalars().first()`` type as
            ``RefreshToken | None`` here instead of ``Any``.
        """
        instant = _utc_now() if now is None else now
        statement = (
            update(RefreshToken)
            .where(
                RefreshToken.token_hash == token_hash,
                # The two liveness conditions, evaluated by the database at the moment of the
                # write rather than by Python at the moment of an earlier read. This is the
                # entire difference between this method and the sequence it replaces.
                RefreshToken.revoked_at.is_(None),
                RefreshToken.expires_at > instant,
            )
            .values(revoked_at=instant)
            .returning(RefreshToken)
        )
        result = await self.session.execute(
            statement,
            execution_options={"synchronize_session": False, "populate_existing": True},
        )
        return result.scalars().first()

    async def get_by_hash(self, token_hash: str) -> RefreshToken | None:
        """Fetch the row carrying this digest, **whatever state it is in**.

        The **diagnostic** read, and it is deliberately not the rotation path. Rotation spends a
        token through :meth:`claim`; this method exists to explain a claim that came back empty.

        Served by the UNIQUE constraint on ``token_hash``, which guarantees at most one match,
        so rotation is never forced to choose between candidates.

        Revoked and expired rows are deliberately **not** filtered out, and that is the single
        most important property of this method. Rotation has to *see* a spent row to recognise
        that a digest which was already exchanged is being presented again - which is evidence
        that a token leaked. A query that quietly returned ``None`` for a revoked row would make
        that reuse indistinguishable from a token that never existed, and reuse detection would
        become impossible to implement in any layer above. Whether a row that exists is still
        *good* is a judgement about time and state, and it belongs to
        ``app.services.auth_service``, not to a WHERE clause here.

        Args:
            token_hash: The digest of the presented token, computed by the caller through
                ``app.core.security.hash_refresh_token``.

        Returns:
            The row - active, revoked or expired - or ``None`` when no token was ever issued with
            that digest.

        Note:
            **This method must not be used to decide that a token may be exchanged.** Reading a
            row here and revoking it afterwards is two statements with a window between them, and
            two concurrent requests both pass through that window; :meth:`claim` closes it by
            testing and spending the row in one statement. Ask this question only *after* a claim
            has already failed, when the row's state is settled and the only remaining question is
            which of "never issued", "already spent" or "expired" the caller is looking at.
        """
        return await self.get_or_none(RefreshToken.token_hash == token_hash)

    async def revoke(
        self, token: RefreshToken, *, now: datetime | None = None
    ) -> RefreshToken | None:
        """Withdraw one token, idempotently. The **logout** path, not the rotation path.

        ``revoked_at`` is stamped only when it is currently ``NULL``, so revoking an
        already-revoked token leaves the original instant intact. That matters beyond tidiness:
        the first instant is the evidence of when the session actually ended, and overwriting it
        on a retry - or on a replayed logout - would destroy the audit trail that rotation-reuse
        detection reads.

        The first instant is preserved **by the database**, not by a Python check
        ----------------------------------------------------------------------
        One statement, and the guard is inside it:

        .. code-block:: sql

            UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, :now)
             WHERE id = :id
            RETURNING ...

        Reading ``token.revoked_at`` in Python and then writing an unconditional value cannot
        offer that guarantee, however the two are ordered: two sessions both load the row while
        it is ``NULL``, both decide to stamp, and the later ``UPDATE`` overwrites the earlier
        instant - so the recorded end of the session is whichever logout happened to commit
        second, and the idempotency this method's contract promises does not hold. ``coalesce``
        closes it because PostgreSQL re-evaluates the ``SET`` expression against the *committed*
        row after the second session's write unblocks: it sees the first instant and writes it
        back unchanged. Verified on PostgreSQL 18.4 by revoking twice with two different instants
        - ``2026-01-01`` then ``2026-06-01`` - and reading ``2026-01-01`` back from both calls.

        ``coalesce`` rather than a ``WHERE revoked_at IS NULL`` term, because the two differ in
        what they return rather than in what they write. With the term, the second call matches
        no row and has nothing to hand back, so it would need a second statement to re-read the
        settled value - and an empty result would then mean two different things, "already
        revoked" and "no such row". With ``coalesce`` the statement always matches a row that
        exists, so one round trip serves both the first call and every repeat, and an empty result
        has exactly one meaning. The write it performs on a repeat is a no-op in value terms -
        this relation carries no ``updated_at`` and no trigger, so rewriting the same instant
        changes nothing an observer can read.

        Args:
            token: A persistent row the caller already holds, typically the one
                :meth:`get_by_hash` just returned. Only its ``id`` is used, so a stale
                ``revoked_at`` on the instance cannot influence the outcome.
            now: Optional timezone-aware instant to record. Defaults to :func:`_utc_now`, so the
                specified ``revoke(token)`` call is exactly what a service writes; supplying it
                explicitly lets a test pin the instant, matching how
                :meth:`delete_expired` takes its clock.

        Returns:
            The row as the write left it, with ``revoked_at`` set - to *this* call's instant if
            it was the first to revoke, and to the earlier one if it was not. It is the same
            object the caller passed, refreshed in place by ``populate_existing``.

            ``None`` when no row carries that key any more. The predicate is an unconditional
            match on the primary key, so that is the only thing an empty result can mean, and it
            has exactly one cause: :meth:`delete_expired` swept the row between the caller's read
            and this write, which it only ever does to a token already past its expiry. There is
            then nothing to revoke - the token cannot be exchanged either way - so the layer's
            own convention applies and absence is reported as ``None`` rather than raised. Logout
            reads that as success; nothing here decides it is a ``404``.

        Note:
            Logout is the use case this serves, and the difference from :meth:`claim` is what
            each has to establish. Logout only has to end the session, and ending it twice is the
            same outcome as ending it once. Rotation *mints a replacement*, so it must establish
            that it alone spent the token - a fact no statement about idempotency can supply.
            Never build rotation out of ``get_by_hash`` plus ``revoke``; call :meth:`claim`.

            The two execution options are the ones :meth:`claim` documents, for the same reasons:
            ``populate_existing`` so the identity map cannot keep a stale ``revoked_at`` of
            ``None`` on the object the caller holds, and ``synchronize_session=False`` because
            ``RETURNING`` refreshes the affected row directly.
        """
        instant = _utc_now() if now is None else now
        statement = (
            update(RefreshToken)
            .where(RefreshToken.id == token.id)
            # The idempotency guard, evaluated by the database at the moment of the write
            # rather than by Python at the moment of an earlier read.
            .values(revoked_at=func.coalesce(RefreshToken.revoked_at, instant))
            .returning(RefreshToken)
        )
        result = await self.session.execute(
            statement,
            execution_options={"synchronize_session": False, "populate_existing": True},
        )
        # `first()` rather than `one_or_none()`: the predicate is the primary key, so the result
        # is one row or none, and an empty one means the row was swept - see `Returns:`.
        return result.scalars().first()

    async def revoke_all_for_user(self, user_id: uuid.UUID, *, now: datetime | None = None) -> int:
        """Withdraw every token an account still holds, in one statement.

        What "log out everywhere" and "this account was compromised" both reduce to, and the
        reason ``ix_refresh_tokens_user_id`` exists. One bulk UPDATE, so the cost does not grow
        with the number of sessions the account has open.

        The ``revoked_at IS NULL`` term does two jobs: it makes the returned count mean
        *previously active* rather than "all rows this account has ever held", and it protects
        the instant already recorded on rows revoked earlier. Calling this twice is therefore
        safe - the second call matches nothing and returns ``0``.

        **Precondition: the caller must already hold the exclusive lock on the owning ``users``
        row.** This statement revokes the rows it can *see*, and on its own that is not the same as
        revoking everything the account holds: a concurrent rotation inserting a successor produces
        a row this UPDATE never considers, because the row did not exist when the statement's
        snapshot was taken - and no row-level lock over the current members can exclude an insert
        that adds a new one. Every caller therefore locks the account first, which forces the
        rotation to either finish before this runs (so the successor is visible and revoked) or wait
        until after it (so the token it was spending is already revoked and it refuses).
        ``AuthService._lock_account`` is where that lock is taken and where the protocol is
        documented; ``AdminService.update_user`` takes the same lock before its suspension sweep. Do
        not call this from a path that does not hold it - the statement will succeed and report a
        count, and the account will still be holding a live credential.

        Args:
            user_id: The account whose tokens are being withdrawn.
            now: Optional timezone-aware instant to record; defaults to :func:`_utc_now`.

        Returns:
            How many tokens were active and are now revoked; ``0`` when the account held none.
        """
        return await self._execute_bulk(
            update(RefreshToken)
            .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
            .values(revoked_at=_utc_now() if now is None else now)
        )

    async def delete_expired(self, *, now: datetime) -> int:
        """Remove every token whose expiry has passed, in one statement.

        The sweep ``ix_refresh_tokens_expires_at`` exists for, so clearing dead rows is an index
        range scan rather than a full pass over every token the system has ever issued.

        Only *expired* rows are removed. A revoked-but-unexpired row is left in place on purpose:
        it is the evidence that lets rotation recognise the reuse of a digest that has already
        been exchanged, and deleting it would delete the detection. Expiry is the point at which
        the row stops being useful for that too, because a token past its expiry is rejected on
        its own terms.

        Args:
            now: The timezone-aware instant to compare against, supplied by the caller rather
                than read from a clock here. That is what makes the sweep deterministic under
                test - a fixture can assert that exactly the rows it aged out were removed - and
                it lets an operator sweep to a chosen cutoff.

        Returns:
            How many rows were removed; ``0`` when nothing had expired.
        """
        return await self._execute_bulk(delete(RefreshToken).where(RefreshToken.expires_at < now))

    async def list_active_for_user(
        self,
        user_id: uuid.UUID,
        *,
        now: datetime,
    ) -> Sequence[RefreshToken]:
        """List the tokens an account can still exchange, newest first.

        The bookkeeping view behind rotation: which sessions are genuinely live, as opposed to
        every row the account has accumulated. All three terms are index-supported by
        ``ix_refresh_tokens_user_id`` narrowing to the account first.

        Ordering carries the same ``id`` tiebreaker as :meth:`UserRepository.list_users`, and for
        the same measured reason - ``created_at`` comes from ``now()``, which PostgreSQL
        evaluates once per transaction, so tokens issued in one transaction share an instant and
        need a total order to be listed deterministically.

        Args:
            user_id: The account whose live tokens are wanted.
            now: The timezone-aware instant "still valid" is judged against, supplied by the
                caller for the same determinism :meth:`delete_expired` needs.

        Returns:
            The unrevoked, unexpired rows, or an empty sequence when the account has no live
            session. Never ``None``.
        """
        result = await self.session.execute(
            select(RefreshToken)
            .where(
                RefreshToken.user_id == user_id,
                RefreshToken.revoked_at.is_(None),
                RefreshToken.expires_at > now,
            )
            .order_by(RefreshToken.created_at.desc(), RefreshToken.id.desc())
        )
        return result.scalars().all()

    async def _execute_bulk(self, statement: UpdateBase) -> int:
        """Execute a bulk UPDATE or DELETE and report how many rows it touched.

        The one place this module issues a set-based write, shared by
        :meth:`revoke_all_for_user` and :meth:`delete_expired` so that the execution option and
        the narrowing cast below are each stated once.

        ``synchronize_session=False`` is passed as an ``execute()`` keyword rather than chained
        onto the statement, and the spelling is forced rather than preferred: chaining
        ``.execution_options()`` returns a plain ``Executable``, which drops the overload
        resolution and made mypy report ``"Result[Any]" has no attribute "rowcount"``. Passing it
        here leaves the statement an :class:`~sqlalchemy.sql.expression.UpdateBase`, which is
        what the caller's own type annotation then documents. The option itself keeps the bulk
        write from walking the identity map to synchronise objects the session is not holding;
        the corollary is that an instance loaded *before* one of these calls keeps its stale
        value until it is refreshed. The two per-row paths, :meth:`claim` and :meth:`revoke`, are
        statements as well but are deliberately not routed through this helper: each carries
        ``RETURNING`` and is executed with ``populate_existing`` beside the same option, which
        refreshes the affected row directly - so neither needs the identity-map walk this
        disables, and neither reads a ``rowcount``, having a row to return instead.

        The cast is honest rather than convenient. At runtime a bulk UPDATE or DELETE always
        yields a :class:`~sqlalchemy.CursorResult`; it is
        :meth:`~sqlalchemy.ext.asyncio.AsyncSession.execute` that is annotated less precisely
        than its synchronous counterpart - inspected against SQLAlchemy 2.0.51, the async method
        declares only ``TypedReturnsRows[_T] -> Result[_T]`` and ``Executable -> Result[Any]``,
        with no ``UpdateBase -> CursorResult[Any]`` overload. Narrowing here confines that gap to
        a single line instead of leaking ``Any`` into two public return types.

        Args:
            statement: A fully composed bulk ``UPDATE`` or ``DELETE`` over
                :class:`~app.models.refresh_token.RefreshToken`.

        Returns:
            The number of rows the statement affected.
        """
        result = await self.session.execute(
            statement, execution_options={"synchronize_session": False}
        )
        return cast("CursorResult[Any]", result).rowcount
