"""Business rules for the ``comments`` relation: the discussion, and its moderation.

This module owns the comment half of requirement R4 - "each blog page should support comments,
likes, and social sharing" - and the whole of the moderation prerequisite that requirement
implies: managing comments presupposes a state an administrator can change, so a comment carries
:class:`~app.models.comment.CommentStatus` rather than existing only as visible text, and every
transition between those three states is declared here. It backs four public routes and one
administrative one::

    GET    /api/v1/posts/{post_id}/comments   -> CommentService.list_for_post
    POST   /api/v1/posts/{post_id}/comments   -> CommentService.create
    PATCH  /api/v1/comments/{comment_id}      -> CommentService.update
    DELETE /api/v1/comments/{comment_id}      -> CommentService.delete
    PATCH  /api/v1/admin/comments/{id}/status -> CommentService.set_status

The last of those is reached through ``app.services.admin_service``, which **delegates** to
:meth:`CommentService.set_status` rather than writing the column itself. That is why the method's
signature is a contract rather than an implementation detail, and why it re-checks administrator
authority even though ``require_admin`` is already applied at router level on the whole
administrative namespace: a rule enforced only at the entry point it happens to have today is a
rule that a second entry point silently bypasses.

Authority lives here, not in the route
--------------------------------------
An author may act only on their own comments; an administrator may act on any. That comparison is
made in this module - through ``app.core.dependencies.ensure_can_modify``, which is where the
comparison itself is declared - so the rule holds no matter which entry point invokes it and is
testable with no HTTP request in the picture::

    service = CommentService(session)
    comment = await service.update(comment_id, payload, actor=principal)  # ForbiddenError

A router's job is to resolve the principal, call one method here, and let
``app.core.exceptions`` translate whatever is raised. A client-side route guard and a hidden
button are user experience, never a security boundary: hiding a control does not stop a request
being made, so every protected operation below is re-checked server-side.

Four visibility rules, and where each one comes from
---------------------------------------------------
1. **Not found is resolved before forbidden**, on every path, and a resource the caller has no
   authority to know about is reported exactly as a missing one. Answering ``403`` in the second
   case would confirm that an identifier addresses something real, which is how an unauthorised
   caller enumerates identifiers by reading status codes.
2. **A comment thread is no more visible than the post it hangs off.** The draft rule is
   *imported*, not restated: :func:`~app.services.post_service.can_view_post` is the single
   declaration of "who may read this post", and :meth:`CommentService._load_visible_post` calls
   it before either reading or writing a thread. The retired service demonstrated the
   alternative, writing ``HTTPException(status_code=404, detail="Item not found")`` three separate
   times (``app.py:L31``, ``L40``, ``L49``) and the identity predicate three separate times
   (``L28-29``, ``L36-37``, ``L45-46``); a rule with three definitions is a rule that will
   eventually have three behaviours. The dependency edge is deliberately one-way -
   ``post_service`` never imports this module.
3. **Only approved comments are visible publicly**, replies included.
   :func:`_visible_comment_statuses` decides which moderation states a viewer may see, and
   ``app.repositories.comment_repository`` applies that one set at every level of the thread - to
   the roots, to the count, and to both terms of the recursive descent - so an unapproved reply
   cannot reach a public caller through an approved ancestor.
4. **A reply may only answer something its author can see**, which is the same rule as 3 applied
   to a write. It is expressed by calling the same helper rather than by a second predicate.

What this module does not contain, and why
------------------------------------------
* **No SQL and no statement construction.** Every read and every write goes through
  ``app.repositories``. ``select``, ``func`` and ``insert`` are not imported, and neither is
  ``app.db.session``: the session is injected, so a service cannot open a connection of its own.
* **No HTTP concern.** No ``Request``, no ``Response``, no ``HTTPException``, no status-code
  literal. Failures are the typed domain errors of ``app.core.exceptions``.
* **No schema declaration.** Request and response shapes belong to ``app.schemas.comment``.
* **No response envelope of its own.** A collection is the one page envelope every list surface
  in this API returns; a single comment is a bare representation. The
  ``{"message": ..., "data": ...}`` wrapper the retired service paired with three of its five
  routes (``app.py:L18``, ``L39``, ``L48``) while two returned bare payloads (``L23``, ``L30``)
  is deleted rather than relocated.
* **No recursive delete.** ``comments.parent_id`` is a self-referencing foreign key with
  ``ON DELETE CASCADE`` and ``Comment.replies`` carries ``passive_deletes=True``, so PostgreSQL
  removes a comment's whole subtree in the statement issued for that one row. A Python-side sweep
  would be slower, would need a query per level, and would be a second definition of a rule the
  schema already guarantees.
* **No module-level mutable state.** The constants below are immutable; the only mutable state is
  the session a caller injects.

Sanitisation
------------
Reader-authored text is the one stored-injection surface an unprivileged account can reach in
this product, and it is cleaned at two boundaries: here on write, and again where the client
renders it. Neither half substitutes for the other - this one is what makes the stored row safe
for *every* consumer of the API, including one that does not run the client's pipeline - and this
module never assumes the other will cover for it. The policy is a deliberately much narrower
allow-list than the one ``app.services.post_service`` applies to an article: see
:data:`COMMENT_ALLOWED_TAGS`.

Transactions
------------
``app.repositories`` flushes but never commits, and ``app.core.dependencies.get_db`` never commits
either, so the transaction boundary belongs to this layer - the layer that knows when a unit of
work is complete. Each mutating method below therefore commits once, on success, and lets every
exception propagate for ``get_db`` to roll back. Nothing here opens a transaction explicitly:
``session.begin()`` is never called, so the suite's outer transaction-per-test fixture keeps
working unchanged and a rolled-back test leaves no row behind.
"""

import uuid
from collections.abc import Mapping
from types import MappingProxyType
from typing import Final

import bleach
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import PageParams, ensure_can_modify, is_admin
from app.core.exceptions import (
    AppValidationError,
    ConflictError,
    FieldError,
    ForbiddenError,
    NotFoundError,
)
from app.core.logging import get_logger
from app.core.pagination import Page, build_page
from app.models import Comment, CommentStatus, Post, User
from app.repositories import CommentRepository, PostRepository
from app.schemas.comment import CommentCreate, CommentPublic, CommentUpdate
from app.services.post_service import can_view_post

__all__ = [
    "ALL_COMMENT_STATUSES",
    "COMMENT_ALLOWED_ATTRIBUTES",
    "COMMENT_ALLOWED_PROTOCOLS",
    "COMMENT_ALLOWED_TAGS",
    "MAX_REPLY_DEPTH",
    "PUBLIC_COMMENT_STATUSES",
    "CommentService",
]


# ---------------------------------------------------------------------------------------
# Write-side sanitisation policy
#
# Named, module-level and immutable, for the same three reasons `post_service` gives: the policy
# is a security control and a reviewer should be able to read it without reading the methods that
# apply it; it is shared by creation and by editing, so it exists once; and a frozenset is what
# bleach 6.4 expects, a list being the deprecated spelling.
#
# This module and `app.services.post_service` are the only two permitted to import bleach, and
# they deliberately keep SEPARATE policies rather than sharing one. Sharing would mean widening
# the article policy - which legitimately needs headings, images and tables - silently widens
# what a reader may store in a comment, and the weaker surface is the one an unprivileged account
# can reach. Every member below is also a member of `post_service.CONTENT_ALLOWED_TAGS`, so this
# set is a strict subset by construction; nothing here is permitted in a comment that is refused
# in an article.
# ---------------------------------------------------------------------------------------

COMMENT_ALLOWED_TAGS: Final[frozenset[str]] = frozenset(
    {
        # Paragraphs and line breaks: the only structure a discussion needs.
        "p",
        "br",
        # Inline emphasis.
        "strong",
        "b",
        "em",
        "i",
        "s",
        "del",
        # Inline code, so a reader can quote an identifier without it being reformatted.
        "code",
        # Links.
        "a",
    }
)
"""Elements a reader-authored comment may keep. Everything else is removed.

Ten elements, and the omissions are the policy rather than an oversight. A comment is a remark in
someone else's article, so it has no business carrying the article's own furniture: ``h1``-``h6``
would let a comment outrank the post's heading in the document outline; ``img`` would embed
third-party bytes into a page the author does not control and is a tracking pixel by another
name; ``table``, ``div``, ``blockquote``, ``hr``, ``ul``, ``ol`` and ``pre`` are block-level
layout that lets a comment restructure the page around it; and ``figure``/``figcaption`` exist to
caption media a comment cannot contain.

Absent for the reasons that hold everywhere: ``script`` and ``style`` execute or restyle the page;
``iframe``, ``object``, ``embed`` and ``applet`` load a third-party document; ``form``, ``input``,
``button`` and ``select`` phish for credentials inside what looks like a discussion; ``link``,
``meta`` and ``base`` rewrite the document's own resolution rules; and ``svg`` and ``math`` carry
their own scripting surfaces. bleach drops any element not named here, so the absence *is* the
control - there is no deny-list to keep up to date.
"""

COMMENT_ALLOWED_ATTRIBUTES: Final[Mapping[str, tuple[str, ...]]] = MappingProxyType(
    {"a": ("href", "title", "rel")}
)
"""Attributes each surviving element may keep, keyed by tag name.

One entry, because ``a`` is the only element above that carries anything useful. Nine of the ten
allowed tags therefore keep **no** attribute at all, which removes the whole ``on*`` event-handler
vector - ``onclick``, ``onerror``, ``onmouseover`` and every future sibling - by omission rather
than by enumeration, and removes ``class`` and ``style`` with it, so a comment cannot borrow the
site's own styling to impersonate part of the page.

``a`` keeps no ``target``: a link that opens a new browsing context needs ``rel="noopener"`` to be
safe, a commenter cannot be relied on to pair them, and the client decides link behaviour at
render time from a policy it controls. It keeps no ``name`` either - a comment may not plant an
anchor in the document it appears in.

Read-only all the way down - a :class:`~types.MappingProxyType` over tuples rather than a ``dict``
of ``list`` - and that is a property of the control rather than tidiness. ``Final`` stops the name
being rebound but nothing stops a mutable mapping being *edited*, and an edit here would widen a
security policy process-wide, for every comment written afterwards, with no diff to review.
"""

COMMENT_ALLOWED_PROTOCOLS: Final[frozenset[str]] = frozenset({"http", "https"})
"""URL schemes permitted in a comment's ``href``.

Two, and one fewer than an article is allowed. ``javascript:`` and ``vbscript:`` execute;
``data:`` smuggles a whole document past a scheme check; ``file:`` addresses the reader's own
machine. ``mailto:`` is refused here although ``post_service`` permits it in an article: an author
publishing their own address is a decision they are entitled to make, while a stranger seeding
addresses into other people's comment threads is how a discussion becomes a harvesting surface.

bleach drops the whole attribute when its value carries an unlisted scheme, so
``<a href="javascript:alert(1)">read this</a>`` survives as a plain ``<a>read this</a>`` with its
text intact rather than disappearing and taking the sentence with it.
"""

_NO_TAGS: Final[frozenset[str]] = frozenset()
"""The empty tag allow-list, used by :func:`_visible_text` to reduce a comment to its own text."""

_NO_ATTRIBUTES: Final[Mapping[str, tuple[str, ...]]] = MappingProxyType({})
"""The empty attribute allow-list that accompanies :data:`_NO_TAGS`.

Read-only for the same reason as :data:`COMMENT_ALLOWED_ATTRIBUTES`, and here the reason is
sharper: with no tag allowed to survive, an entry added to this mapping by accident would be the
only thing standing between a text extraction and markup.
"""


def _bleach_attributes(policy: Mapping[str, tuple[str, ...]]) -> dict[str, tuple[str, ...]]:
    """Adapt a read-only attribute policy to the concrete ``dict`` bleach insists on.

    ``bleach.sanitizer.attribute_filter_factory`` dispatches on ``callable``, then on
    ``isinstance(attributes, dict)``, then on ``isinstance(attributes, list)``, and raises
    ``ValueError`` for anything else - so a :class:`~types.MappingProxyType` cannot be passed
    straight through even though it satisfies the ``Mapping`` protocol this module wants for its
    policy. The copy is shallow and covers one key, which is immaterial beside parsing a body of
    up to five thousand characters, and it has a second effect worth having: the library is handed
    a mapping it may keep or mutate freely without reaching the policy itself.

    Args:
        policy: The read-only allow-list, keyed by tag name.

    Returns:
        A fresh ``dict`` with the same contents. The values stay tuples, which bleach tests with
        ``in`` exactly as it would a list.
    """
    return dict(policy)


# ---------------------------------------------------------------------------------------
# Error details
#
# One spelling per message, named once. The two "not found" strings are deliberately used for
# both halves of their respective rules - a row that does not exist and a row the caller may not
# know about report the same text - and naming them is what keeps those two cases identical
# rather than merely similar.
# ---------------------------------------------------------------------------------------

_POST_NOT_FOUND: Final[str] = "Post not found"
_COMMENT_NOT_FOUND: Final[str] = "Comment not found"
_INVALID_PARENT: Final[str] = (
    "The comment being replied to does not exist on this post, or is not available to reply to."
)
_REPLY_TOO_DEEP: Final[str] = (
    "This reply would nest deeper than the thread allows. Reply to a comment further up instead."
)
_EMPTY_AFTER_SANITISATION: Final[str] = (
    "The comment body contains no text once unsupported markup is removed."
)
_THREAD_CHANGED: Final[str] = (
    "The post or the comment being replied to was removed while this comment was being written. "
    "Retry the request."
)
_FIELD_PARENT_ID: Final[str] = "parent_id"
_FIELD_BODY: Final[str] = "body"
_FIELD_ERROR_TYPE: Final[str] = "value_error"


# ---------------------------------------------------------------------------------------
# Moderation visibility
#
# Two tuples rather than a literal at each call site, and an explicit tuple rather than the
# `statuses=None` the repository also accepts. `list_for_post` takes the states to include as an
# ARGUMENT and decides nothing itself, so these are the values that decision resolves to - and a
# helper that returns one type on every branch is a plain value a unit test can compare.
# ---------------------------------------------------------------------------------------

PUBLIC_COMMENT_STATUSES: Final[tuple[CommentStatus, ...]] = (CommentStatus.APPROVED,)
"""What an anonymous or unrelated caller may see in a thread: approved comments only.

Named positively - "include APPROVED" rather than "exclude PENDING and REJECTED" - so a fourth
moderation state added later is invisible by default instead of appearing in every public thread
until somebody remembers to exclude it.
"""

ALL_COMMENT_STATUSES: Final[tuple[CommentStatus, ...]] = (
    CommentStatus.PENDING,
    CommentStatus.APPROVED,
    CommentStatus.REJECTED,
)
"""Every moderation state, for a caller entitled to the whole of a thread.

Spelled out rather than passed to the repository as ``statuses=None``, which means the same thing
to the query. The explicit tuple keeps the membership under review here if a fourth state is ever
added, and keeps :func:`_visible_comment_statuses` returning one type on every branch.
"""

MAX_REPLY_DEPTH: Final[int] = 8
"""How deep a reply may sit, counting a top-level comment as depth ``0``.

A rule about what may be **created**, which is why it lives here: ``comments.parent_id`` puts no
bound on nesting, ``app.schemas.comment.CommentPublic.replies`` is recursive without limit, and
``app.repositories.comment_repository`` reads whatever depth exists rather than truncating it -
each of those three modules records that the cap belongs to this service.

Eight is generous for a discussion and finite for a machine, and finiteness is the point. Without
a bound, a client that replies to its own reply in a loop builds an arbitrarily long chain, and
every subsequent read of that thread has to validate and serialise a structure nested that deeply
- a response no reader asked for, produced through the one write path an unprivileged account can
reach. Rejecting the ninth level costs a reader nothing: the comment is still writable one level
up, in the position a reader would have chosen anyway once the indentation stopped conveying
anything.

Rows written outside this service - ``app.db.seed``, the test factories, a data migration - are
not subject to the cap, and the read path handles any depth they produce. The cap constrains the
request path, which is the only path an untrusted caller has.
"""


def _visible_text(html: str) -> str:
    """Reduce a cleaned body to the text a reader would actually see.

    Used by :func:`_sanitize_body` to answer one question - does this comment say anything? - which
    cannot be answered by testing the cleaned string for emptiness. ``<p>   </p>`` is ten
    characters of a permitted element wrapped around nothing, and ``<br><br>`` is two;
    ``comments.body`` would store either quite happily, and a thread would render an empty bubble
    for it.

    Args:
        html: A body that has already been through :func:`_sanitize_body`'s allow-list pass, so
            every element still present is one of :data:`COMMENT_ALLOWED_TAGS`.

    Returns:
        The text content with every element removed and surrounding whitespace trimmed; the empty
        string when the value carries no text at all.

    Note:
        ``protocols`` is not passed, and its absence is deliberate rather than an omission: with
        :data:`_NO_ATTRIBUTES` in force no ``href`` survives to be scheme-checked, so a protocol
        allow-list would have nothing to act on. ``strip=True`` is what keeps the text of a removed
        element - the whole point here is to see the words, not the tags.

        A Unicode space such as ``\\xa0`` is trimmed by :meth:`str.strip` like any other, so a body
        padded with non-breaking spaces is recognised as saying nothing.
    """
    text: str = bleach.clean(
        html,
        tags=_NO_TAGS,
        attributes=_bleach_attributes(_NO_ATTRIBUTES),
        strip=True,
        strip_comments=True,
    )
    return text.strip()


def _sanitize_body(raw: str) -> str:
    """Clean reader-authored comment text for storage, keeping what the reader meant.

    The write-side half of the sanitisation pair. The client sanitises again where it renders, and
    this half is not skipped on the strength of that: the stored row has to be safe for every
    consumer of the API, not only for the one client in this repository.

    Args:
        raw: The submitted body, exactly as it arrived. Already trimmed, and already known to
            carry between one and five thousand characters, by
            ``app.schemas.comment.CommentBody``.

    Returns:
        The body with every element outside :data:`COMMENT_ALLOWED_TAGS` removed, every attribute
        outside :data:`COMMENT_ALLOWED_ATTRIBUTES` dropped, every URL scheme outside
        :data:`COMMENT_ALLOWED_PROTOCOLS` refused, and every comment stripped.

    Raises:
        AppValidationError: Nothing a reader could see survived. See the note - this is a rule the
            schema cannot express, because it is a property of the cleaned value rather than of the
            submitted one.

    Note:
        ``strip=True`` removes a disallowed element rather than escaping it into visible text, so
        a reader of ``<script>alert(1)</script>`` is shown ``alert(1)`` and not a literal script
        tag rendered as prose. The schema promises exactly that: a submission is never rejected
        for containing markup; the markup is cleaned.

        The one case where cleaning *is* a rejection is a body left with nothing to read.
        ``<img src=x onerror=alert(1)>`` is a single disallowed element with no text content, so
        stripping it leaves the empty string - and ``comments.body`` is ``NOT NULL`` with a
        documented floor of one non-whitespace character, whose whole purpose is to keep a comment
        that renders as an empty bubble out of a thread. The schema checked that floor against the
        *submitted* text and cannot check it again here, so this is the layer that must: a ``422``
        naming ``body`` is what the caller can act on, where storing the value would produce a
        thread entry with nothing in it.

        **Emptiness is tested against the text, not against the string**, which is why
        :func:`_visible_text` exists. ``<p>   </p>`` survives the allow-list pass intact - ``p`` is
        permitted - so a string-level test would accept ten characters of markup wrapped around
        nothing and store a comment that renders blank. Testing the text content catches that, and
        catches ``<br><br>``, ``<strong></strong>`` and a body of non-breaking spaces with it, while
        accepting any comment that carries a single readable glyph.

        A bare ``<`` or ``&`` in the text is escaped to its character reference, which is the
        correct and unavoidable outcome of parsing untrusted text as HTML - ``<`` genuinely may
        open a tag - and is what the client's renderer expects.
    """
    # Bound to an annotated local before returning. `bleach` publishes no type information -
    # `backend/pyproject.toml` records it under `ignore_missing_imports` - so the call's result is
    # `Any`, and binding it here is what keeps this function's declared return type honest without
    # a `# type: ignore`.
    cleaned: str = bleach.clean(
        raw,
        tags=COMMENT_ALLOWED_TAGS,
        attributes=_bleach_attributes(COMMENT_ALLOWED_ATTRIBUTES),
        protocols=COMMENT_ALLOWED_PROTOCOLS,
        strip=True,
        strip_comments=True,
    )

    # Trimmed before it is stored, so a body that arrives wrapped in a block element does not carry
    # the parser's surrounding whitespace into the column.
    trimmed = cleaned.strip()

    # Then judged on what it says rather than on how long it is. `_visible_text` records why the
    # string's own emptiness is the wrong test.
    if not _visible_text(trimmed):
        raise AppValidationError(
            _EMPTY_AFTER_SANITISATION,
            errors=[
                FieldError(
                    field=_FIELD_BODY,
                    message="Write the comment as plain text; the markup submitted was removed.",
                    type=_FIELD_ERROR_TYPE,
                )
            ],
        )
    return trimmed


def _visible_comment_statuses(post: Post, viewer: User | None) -> tuple[CommentStatus, ...]:
    """Report which moderation states this viewer may see in this post's thread.

    The value handed to ``CommentRepository.list_for_post`` as ``statuses``, and therefore the
    control that keeps an unapproved comment out of a public thread. The repository takes the
    states as an argument and decides nothing; this is where the decision is made, once, for both
    the read path and the reply-parent check.

    Args:
        post: The post whose thread is being read or written. Only ``author_id`` is read, and it
            is a mapped column that is always populated - never the ``author`` relationship, which
            is unloaded on the entity a locked or plain primary-key fetch returns and whose access
            under an ``AsyncSession`` would raise ``MissingGreenlet``.
        viewer: The resolved principal, or ``None`` for an anonymous caller.

    Returns:
        :data:`ALL_COMMENT_STATUSES` for an administrator and for the post's own author;
        :data:`PUBLIC_COMMENT_STATUSES` for everyone else, including an authenticated reader on
        somebody else's post.

    Note:
        **The post's author sees the whole thread on their own post**, pending and rejected
        comments included, which is the reading
        ``app.repositories.comment_repository.CommentRepository.list_for_post`` documents for its
        ``statuses`` argument. It is also the useful behaviour: the moderation queue belongs to an
        administrator, but an author is the person who notices that a reader is waiting on
        approval under their article, and hiding that from them would leave the thread they own
        looking emptier to them than it is.

        **Widening for the author widens the replies too**, deliberately. The repository applies
        this one set to the roots and to every level of the recursive descent, so an author sees
        unapproved replies nested under approved parents on their own post. That is the same
        entitlement stated for the top level, and the alternative - a wider set for roots and a
        narrower one for replies - would show an author a parent whose answer is silently missing.

        **"Approved, or my own" is deliberately not expressible here.** A reader's own pending
        comment does not appear in the thread listing, because the repository filters on a set of
        *states* and per-row authorship is not a state; expressing it would need a new predicate
        in a statement, and statements do not belong in this layer. The comment is not lost to its
        author - it is still addressable by identifier through the ownership-scoped
        :meth:`CommentService.update` and :meth:`CommentService.delete` - and the API tells them
        what happened, because ``CommentPublic.status`` is returned on the creating response.
    """
    if viewer is None:
        return PUBLIC_COMMENT_STATUSES
    if is_admin(viewer):
        return ALL_COMMENT_STATUSES
    # The post's author, on their own post. `can_modify` is not used for this: it answers "may
    # this principal mutate the post", which is a different question that happens to share a
    # comparison, and borrowing it would make a later change to mutation authority silently
    # change who can read a thread.
    if viewer.id == post.author_id:
        return ALL_COMMENT_STATUSES
    return PUBLIC_COMMENT_STATUSES


async def _reply_depth(parent: Comment) -> int:
    """Report how deep a reply to ``parent`` would sit, with a top-level comment at depth ``0``.

    The measurement behind :data:`MAX_REPLY_DEPTH`. Walking ``parent_id`` upwards is the only way
    to answer it from this layer: depth is not a stored column, and a recursive statement to
    derive it would be SQL in a module that must contain none.

    Args:
        parent: The comment being replied to, freshly fetched, so its ``parent_id`` column is
            populated.

    Returns:
        ``1`` when ``parent`` is top-level, ``2`` when it is a reply to a top-level comment, and
        so on. The value is exact up to :data:`MAX_REPLY_DEPTH`; beyond that the walk stops early
        and returns the first depth that exceeds the cap, because the only question asked of this
        result is whether the cap has been passed.

    Note:
        **The walk is bounded by the cap, not by the thread.** It performs at most
        :data:`MAX_REPLY_DEPTH` steps whatever the shape of the data, so the pathological chain
        the cap exists to prevent cannot make this measurement expensive either.

        Each step is a primary-key lookup through ``awaitable_attrs``, which is the accessor
        ``app.db.base`` provides for reaching a relationship under an async session. Most steps
        cost nothing: a reply is usually one or two levels down, and an ancestor already loaded in
        this unit of work comes from the session's identity map with no round trip. The read path
        never comes through here - it reads a whole thread in one recursive statement - so this is
        a write-path cost only, paid once per reply.

        The ``ancestor is None`` guard is unreachable in practice, because ``parent_id`` is a
        foreign key and the row it names therefore exists; it is written rather than asserted so
        the loop terminates on a value the type system admits instead of on one it does not.
    """
    depth = 1
    ancestor: Comment | None = parent
    while ancestor is not None and ancestor.parent_id is not None:
        depth += 1
        if depth > MAX_REPLY_DEPTH:
            return depth
        ancestor = await ancestor.awaitable_attrs.parent
    return depth


async def _load_author(comment: Comment) -> Comment:
    """Load ``author`` on a comment returned from a write, so a response can be rendered.

    ``BaseRepository.add`` and ``BaseRepository.save`` both refresh the instance, which reloads its
    columns and leaves its relationships unloaded; a byline needs the account. ``awaitable_attrs``
    is the accessor ``app.db.base`` provides for exactly this, used the way that module prescribes
    - on a single entity after a write, never inside a loop over a listing.

    Args:
        comment: A persistent comment whose ``author`` may be unloaded.

    Returns:
        The same instance, with ``author`` loaded.

    Note:
        **``replies`` is deliberately left unloaded, and that is a security property.** The
        relationship is the ownership edge: one generation, unfiltered by moderation state. A
        single-resource response carries no thread, so loading it would serve no member of the
        response - and handing a caller an unfiltered collection is precisely the leak
        ``app.repositories.comment_repository`` builds its recursive, status-filtered descent to
        prevent.

        A router must therefore project a comment from any of the mutating methods with the
        explicit constructor form ``app.schemas.comment`` documents, leaving ``replies`` out so
        its empty default applies, rather than with ``CommentPublic.model_validate(comment)``.
        Validating the whole model would touch the unloaded collection and fail loudly - as a
        response-validation error - which is the intended outcome: a noisy failure beats a quiet
        disclosure.
    """
    await comment.awaitable_attrs.author
    return comment


class CommentService:
    """Every business rule a discussion and its moderation need, and no query and no route.

    Constructed per request from the session ``app.core.dependencies.get_db`` yields, and in the
    suite from the transactional fixture::

        service = CommentService(session)
        thread = await service.list_for_post(post_id, viewer=None, page=1, page_size=20)
        comment = await service.create(post_id, payload, author=principal)
        edited = await service.update(comment.id, patch, actor=principal)
        await service.set_status(comment.id, CommentStatus.APPROVED, actor=administrator)

    Read methods take a ``viewer`` - the resolved principal or ``None`` - because what a caller may
    *see* depends on who they are. Mutating methods take an ``author`` or an ``actor``, neither of
    which is optional, because an anonymous caller cannot reach them at all: the router's
    dependency has already answered ``401`` by then, and this layer answers the question that
    dependency cannot, which is whether *this* principal may act on *this* row.

    Ordering of the two failure modes is fixed on every method and is a confidentiality property
    rather than a style: a resource that does not exist is reported before authority is considered,
    and a resource the caller has no authority to know about is reported the same way as one that
    is missing.
    """

    __slots__ = ("_comments", "_posts", "_session")

    def __init__(self, session: AsyncSession) -> None:
        """Bind the service to one request's session and its repositories.

        Args:
            session: The live session ``get_db`` yielded. It is **injected, never created** here:
                this module does not import ``app.db.session``, so a service cannot open a
                connection of its own, and both repositories below share the one session so a
                multi-step use case stays a single transaction.

        Note:
            Two repositories, each for a distinct reason. ``CommentRepository`` owns the relation
            this service is about. ``PostRepository`` is needed because a thread's visibility is a
            property of its *post*: the draft rule has to be evaluated against a real ``posts``
            row before a comment on it can be read or written, and fetching that row is a
            repository's job rather than another service's.
        """
        self._session = session
        self._comments = CommentRepository(session)
        self._posts = PostRepository(session)

    # -----------------------------------------------------------------------------------
    # Private resolution helpers
    # -----------------------------------------------------------------------------------

    async def _load_visible_post(self, post_id: uuid.UUID, viewer: User | None) -> Post:
        """Fetch the post a thread hangs off, and confirm this viewer may see it.

        The shared preamble of :meth:`list_for_post` and :meth:`create`, so that the two agree
        about which posts have a reachable discussion. A comment thread cannot be more visible than
        the article it is attached to: if the post is an unpublished draft belonging to somebody
        else, then for this caller the thread does not exist either, in both directions - it cannot
        be read and it cannot be written to.

        Args:
            post_id: The post's identifier, from the URL path.
            viewer: The resolved principal, or ``None`` for an anonymous caller.

        Returns:
            The post. Its own columns are populated; its relationships are not, and nothing here
            needs them - :func:`_visible_comment_statuses` reads ``author_id`` and
            :func:`~app.services.post_service.can_view_post` reads ``status`` and ``author_id``,
            all three of which are mapped columns.

        Raises:
            NotFoundError: No post carries that identifier, **or** the post is not published and
                the caller is neither its author nor an administrator.

        Note:
            Those two cases raise the same error with the same detail, and the identity is the
            point. ``ForbiddenError`` for the second would confirm that the identifier addresses a
            real post, which is precisely the fact an unpublished draft is entitled to keep: a
            reader who cannot see a draft must not be able to discover that it exists by posting a
            comment at it and reading the status code. ``app.services.post_service.get_by_slug``
            answers the same question the same way for the article itself, so a probe learns
            nothing from either surface.

            The draft rule itself is **not** re-derived here.
            :func:`~app.services.post_service.can_view_post` is its single declaration, and this
            method calls it: a rule repeated per call site drifts, which is exactly what the
            retired service demonstrated by writing its one identity predicate three times over.
        """
        post = await self._posts.get_by_id(post_id)
        if post is None:
            raise NotFoundError(_POST_NOT_FOUND)
        if not can_view_post(post, viewer):
            raise NotFoundError(_POST_NOT_FOUND)
        return post

    async def _load_for_update(self, comment_id: uuid.UUID) -> Comment:
        """Lock one comment for writing and report a missing row before anything else.

        The shared preamble of :meth:`update`, :meth:`delete` and :meth:`set_status`. It stops
        deliberately short of the authority check, because the three callers do not share one:
        two require ownership or administrator, the third requires administrator outright. What
        they do share is the ordering - not-found first, always - and stating it once here is what
        keeps one of the three from drifting into answering ``403`` for a row that does not exist.

        Args:
            comment_id: The comment's identifier, from the URL path.

        Returns:
            The locked comment. Its own columns are populated; its relationships are not.

        Raises:
            NotFoundError: No comment carries that identifier.

        Note:
            ``SELECT ... FOR UPDATE`` is taken before the authority check rather than after, which
            ``app.repositories.base`` prescribes for exactly these read-check-write sequences: two
            requests that both read a comment and both decide to act on it cannot interleave
            between the read and the write, because the second blocks until the first's transaction
            ends and then observes its outcome. Without it, an author's edit and an
            administrator's approval racing on one row could each write from the pre-state and one
            of the two decisions would vanish. The lock is released by the commit each caller
            performs, or by the rollback ``get_db`` performs if one raises.

            A locked read also reports a row a concurrent transaction deleted and committed as
            absent rather than handing back a snapshot copy, so the ``404`` above is a fact rather
            than a guess - and it is why the mutating methods need no integrity guard of their own
            around their own writes.
        """
        comment = await self._comments.get_by_id(comment_id, for_update=True)
        if comment is None:
            raise NotFoundError(_COMMENT_NOT_FOUND)
        return comment

    async def _resolve_parent(
        self,
        parent_id: uuid.UUID,
        *,
        post: Post,
        author: User,
    ) -> Comment:
        """Validate the comment a reply claims to answer, and return it.

        Three rules, one rejection. The parent must exist, it must belong to the same post as the
        reply, and it must be a comment this author is entitled to see.

        Args:
            parent_id: The identifier the client sent as ``parent_id``.
            post: The post the reply is being written on, already confirmed visible to ``author``.
            author: The resolved principal writing the reply.

        Returns:
            The parent comment.

        Raises:
            AppValidationError: The parent does not exist, hangs off another post, is in a
                moderation state this author may not see, or sits at the maximum reply depth. The
                first three share one detail and one field error; the depth case has its own,
                because it is actionable and discloses nothing the caller does not already know.

        Note:
            **422 rather than 404, and the choice is about which value is wrong.** The request
            addresses a post that does exist and that this caller may see; what is wrong is a
            member of the submitted body. ``app.core.exceptions.AppValidationError`` names this
            exact case - "a comment whose parent belongs to a different post" - as the rule it
            exists for, and answering it with a field error keyed to ``parent_id`` lets a client
            attach the failure to the control that caused it instead of guessing which of the path
            and the body it got wrong.

            **The first three cases are deliberately indistinguishable.**
            ``CommentRepository.get_parent`` already conflates "no such comment" with "that comment
            is on another post" by returning ``None`` for both, leaving the choice of error here;
            this method extends the same treatment to a parent whose moderation state the author
            may not see. Reporting that one separately would turn the reply endpoint into an oracle
            for whether a given identifier names a comment awaiting moderation, which is a fact the
            public thread withholds - so the reply path must withhold it too.

            **A reply may only answer what its author can see**, and that is the same rule the
            listing applies, evaluated through the same :func:`_visible_comment_statuses` call
            rather than through a second predicate. It follows that an ordinary reader may reply
            only to an approved comment, while the post's author and an administrator - who both
            see the whole thread - may reply anywhere in it. Refusing a reply to an unapproved
            comment for the reader who cannot see it is the safe default in both directions: they
            could not have obtained the identifier from any surface this API exposes to them, and
            a subtree hanging off a hidden parent is pruned by the read path, so the reply would be
            written into a position no reader could ever reach.
        """
        parent = await self._comments.get_parent(parent_id, post_id=post.id)
        if parent is None or parent.status not in _visible_comment_statuses(post, author):
            raise AppValidationError(
                _INVALID_PARENT,
                errors=[
                    FieldError(
                        field=_FIELD_PARENT_ID,
                        message="No such comment on this post.",
                        type=_FIELD_ERROR_TYPE,
                    )
                ],
            )

        if await _reply_depth(parent) > MAX_REPLY_DEPTH:
            raise AppValidationError(
                _REPLY_TOO_DEEP,
                errors=[
                    FieldError(
                        field=_FIELD_PARENT_ID,
                        message=f"Replies may nest at most {MAX_REPLY_DEPTH} levels deep.",
                        type=_FIELD_ERROR_TYPE,
                    )
                ],
            )
        return parent

    # -----------------------------------------------------------------------------------
    # Reads
    # -----------------------------------------------------------------------------------

    async def list_for_post(
        self,
        post_id: uuid.UUID,
        *,
        viewer: User | None,
        page: int,
        page_size: int,
    ) -> Page[CommentPublic]:
        """List one post's discussion for ``GET /api/v1/posts/{post_id}/comments``.

        A page of **threads**, not of comments: its members are the post's top-level comments, each
        carrying the replies that answer it, nested to whatever depth they go. So ``total`` and
        ``pages`` count top-level comments, and a reply is never a page member in its own right.
        ``app.repositories.comment_repository`` records why in full - counting replies as members
        would let one appear on two consecutive pages and would leave ``total`` describing a set the
        client could not reconstruct.

        Args:
            post_id: The post whose thread to read, from the URL path.
            viewer: The resolved principal, or ``None`` for an anonymous caller. It decides two
                things and nothing else: whether the post is visible at all, and which moderation
                states are in scope.
            page: The 1-based page requested. A page beyond the last is not an error - it returns
                an empty ``items`` list beside the real ``total`` and ``pages``, which is how a
                client detects it has run off the end.
            page_size: Rows per page, as bounded to ``1..100`` by ``PageParams`` at the route
                boundary.

        Returns:
            A :class:`~app.core.pagination.Page` of
            :class:`~app.schemas.comment.CommentPublic` carrying ``items``, ``total``, ``page``,
            ``page_size`` and ``pages`` - the one envelope every collection in this API returns, so
            the client pages a thread with the same control it pages the feed with.

        Raises:
            NotFoundError: No post carries that identifier, or the post is not visible to this
                caller. Reported before any comment statement is issued, so an invisible draft's
                thread is unreachable rather than merely empty.
            ValueError: Propagated from ``build_page`` if ``page_size`` is not positive, which can
                only arrive from a defect in a caller - request-supplied values are bounded long
                before they reach here.

        Note:
            **One repository call, and the thread arrives complete.** The rows it returns already
            carry ``author`` at every level and their ``replies`` collections are already populated,
            so the projection below issues no further statement. There is deliberately no loop that
            fetches replies per comment: that would be the N+1 the repository's recursive statement
            exists to avoid, and under an async session each of those loads would raise
            ``MissingGreenlet`` rather than merely being slow.

            **The thread is returned nested, not flattened.**
            :attr:`~app.schemas.comment.CommentPublic.replies` carries the shape the repository
            assembled, so a client renders the discussion without re-joining rows by identifier.

            **Which comments are in scope is not decided by a filter written here.** It is
            :func:`_visible_comment_statuses`, which the reply-parent check also calls, so the read
            surface and the write surface cannot disagree about what a caller may see.
        """
        # Resolved FIRST, and not merely for tidiness: the repository treats a post with no
        # comments and a post that does not exist identically - both are an empty page - so an
        # invisible or missing post has to become a 404 here rather than degenerating into a
        # successful empty thread that discloses nothing but also states nothing true.
        post = await self._load_visible_post(post_id, viewer)

        # The window arithmetic has exactly one definition, in `PageParams`. Recomputing
        # `(page - 1) * page_size` inline is one off-by-one away from a thread that skips or
        # repeats a comment at every page boundary. The bounds on the two fields are FastAPI query
        # metadata and are inert in plain Python, so an out-of-range page passes through to be
        # answered with an empty page rather than rejected.
        window = PageParams(page=page, page_size=page_size)

        rows, total = await self._comments.list_for_post(
            post.id,
            statuses=_visible_comment_statuses(post, viewer),
            limit=window.limit,
            offset=window.offset,
        )

        items = [CommentPublic.model_validate(row) for row in rows]
        return build_page(items, total, window.page, window.page_size)

    # -----------------------------------------------------------------------------------
    # Writes
    # -----------------------------------------------------------------------------------

    async def create(self, post_id: uuid.UUID, payload: CommentCreate, *, author: User) -> Comment:
        """Add a comment or a reply for ``POST /api/v1/posts/{post_id}/comments``.

        Args:
            post_id: The post being commented on, from the URL path. It is **not** taken from the
                body, and ``CommentCreate`` forbids it there: a body-supplied post identifier would
                let a caller write into a thread other than the one the URL names, and the
                visibility check above would then have been performed on the wrong post.
            payload: The validated request body - the text, and optionally the comment being
                replied to. It cannot carry anything else: ``extra="forbid"`` refuses ``id``,
                ``post_id``, ``author_id`` and ``status``, every one of which is produced here or
                by the database.
            author: The resolved principal. The comment's ``author_id`` is taken from **here** and
                could not have come from the body.

        Returns:
            The persisted comment with ``author`` loaded and ``replies`` deliberately unloaded -
            see :func:`_load_author` for how a router must project it.

        Raises:
            NotFoundError: No post carries that identifier, or it is not visible to this caller.
            AppValidationError: The body sanitises to nothing, or ``parent_id`` names a comment
                that does not exist on this post, that this author may not see, or that already
                sits at the maximum reply depth.
            ConflictError: The post, the parent or the account referenced was removed between the
                checks above and the insert. See the note.

        Note:
            **A comment is created ``PENDING``, and there is no argument that changes that.** The
            state is assigned here as well as being the column's server default, so the guarantee
            is visible in the method that makes it: nothing a reader writes is public until an
            administrator moves it on through :meth:`set_status`. Post-hoc moderation - storing
            ``APPROVED`` and withdrawing later - would leave the moderation queue permanently empty
            and the administrative screen decorative, and would make the first thing a stranger
            writes on somebody else's article public by default.

            The response therefore reports a state the author did not ask for, which is why
            ``CommentPublic`` publishes ``status``: the client renders "awaiting moderation" from
            it rather than showing the comment in the thread as though it were live.

            **The body is sanitised before anything is stored**, and sanitising is done before the
            parent is looked up because it needs no round trip - a body that cleans to nothing
            fails without touching the database.

            **No role is required beyond authentication.** Commenting is gated on a bearer token,
            not on authority: a reader who has just registered may join a discussion, and requiring
            ``AUTHOR`` would make the comment form the client renders unusable for the account it
            renders it to.

            **The integrity guard is not defensive noise.** Three foreign keys are checked at the
            insert - ``post_id``, ``author_id`` and ``parent_id`` - and each names a row this method
            read a moment earlier without locking it. A post deleted, or a parent comment deleted,
            between the read and the insert would otherwise surface as a driver-level violation and
            a ``500`` describing a constraint. Nothing is locked to prevent that on purpose: taking
            a write lock on a whole post to add one comment would serialise a public, high-frequency
            operation against every other comment on the same article, and a retry after a ``409``
            resolves the race with a clean ``404``.
        """
        post = await self._load_visible_post(post_id, author)

        body = _sanitize_body(payload.body)

        parent = (
            None
            if payload.parent_id is None
            else await self._resolve_parent(payload.parent_id, post=post, author=author)
        )

        comment = Comment(
            post_id=post.id,
            author_id=author.id,
            parent_id=None if parent is None else parent.id,
            body=body,
            # Stated explicitly rather than left to the column's server default, so the one
            # moderation guarantee this method makes is legible in this method. The default remains
            # the floor for any other writer of the relation.
            status=CommentStatus.PENDING,
        )

        try:
            await self._comments.add(comment)
            await self._session.commit()
        except IntegrityError as error:
            # Rolled back first: the transaction is aborted, so anything else issued on this
            # session would fail too and `get_db` would have nothing left to close cleanly.
            await self._session.rollback()
            raise ConflictError(_THREAD_CHANGED) from error

        get_logger(__name__).info(
            "comment created",
            comment_id=str(comment.id),
            post_id=str(post.id),
            author_id=str(author.id),
            parent_id=None if parent is None else str(parent.id),
            status=comment.status.value,
            # The length, never the text. A comment body is untrusted reader input and has no place
            # in a log line; its size is what an operator actually wants to correlate.
            body_length=len(comment.body),
        )
        return await _load_author(comment)

    async def update(
        self,
        comment_id: uuid.UUID,
        payload: CommentUpdate,
        *,
        actor: User,
    ) -> Comment:
        """Edit a comment's text for ``PATCH /api/v1/comments/{comment_id}``.

        A genuine partial update, and a one-member one: an omitted ``body`` leaves the comment
        exactly as it is. That is the difference from the whole-object ``PUT`` this API replaces,
        which required a client to resend every field it was not changing and overwrote the stored
        record with whatever arrived.

        Args:
            comment_id: The comment's identifier, from the URL path.
            payload: The replacement text, or an empty patch. ``CommentUpdate`` carries no
                ``status`` and no ``parent_id``: the first would be a moderation bypass on a route
                the comment's own author can reach, and the second would silently re-parent a
                comment other readers have already replied within.
            actor: The resolved principal. Must own the comment or hold ``ADMIN``.

        Returns:
            The updated comment with ``author`` loaded and ``replies`` deliberately unloaded.

        Raises:
            NotFoundError: No comment carries that identifier.
            ForbiddenError: The actor neither wrote the comment nor holds ``ADMIN``. Raised by
                ``ensure_can_modify``, which is the one definition of that comparison; this module
                does not restate it.
            AppValidationError: The replacement body sanitises to nothing.

        Note:
            **An accepted edit returns an ``APPROVED`` comment to ``PENDING``, whoever made it.**
            This is the second half of withholding ``status`` from the input model, and without it
            the first half is worthless: submit something innocuous, wait for approval, then swap
            the body, and the replacement would be public unreviewed - sitting in the thread
            indistinguishably from moderated text and absent from the queue an administrator works.
            Approval attaches to the text a moderator read, not to the row that held it.

            There is no exemption for an administrator, and that is deliberate rather than an
            oversight: a role branch here would be a second rule to keep in step, and an
            administrator who wants their edit public re-approves it through :meth:`set_status`,
            which is one call they already have. A comment already ``PENDING`` or ``REJECTED`` is
            left where it is - an edit must not lift a rejection, or a rejected author could return
            themselves to the queue indefinitely by editing.

            **An empty patch is a legitimate no-op.** It changes nothing, emits no ``UPDATE`` -
            ``save`` finds nothing dirty to flush - and is therefore not an edit, so it does not
            re-open moderation either. There is no "at least one field required" rule, because an
            editor submitted without edits is a legitimate request with a legitimate outcome.

            **The replacement text is sanitised on write**, by the same policy and the same
            function creation uses, so an edit cannot be a way past a rule creation enforces.
        """
        comment = await self._load_for_update(comment_id)
        ensure_can_modify(actor, comment.author_id)

        # Which members the caller actually sent. `body` refuses an explicit null at the schema, so
        # "is not None" and "was sent" are the same condition for it - and that spelling is the one
        # that narrows the optional away for the type checker. The dump is what makes the audit line
        # below describe the request rather than a guess at it, and it is the shape that stays
        # correct if this model ever gains a second editable member.
        provided = payload.model_dump(exclude_unset=True)

        if payload.body is not None:
            comment.body = _sanitize_body(payload.body)
            if comment.status is CommentStatus.APPROVED:
                comment.status = CommentStatus.PENDING

        # No integrity guard here, unlike `create`: the row is held under `FOR UPDATE`, so it cannot
        # be deleted from beneath this transaction, and a row already deleted and committed was
        # reported as a 404 by the locked read above.
        await self._comments.save(comment)
        await self._session.commit()

        get_logger(__name__).info(
            "comment updated",
            comment_id=str(comment.id),
            post_id=str(comment.post_id),
            actor_id=str(actor.id),
            changed=sorted(provided),
            status=comment.status.value,
            body_length=len(comment.body),
        )
        return await _load_author(comment)

    async def delete(self, comment_id: uuid.UUID, *, actor: User) -> None:
        """Delete a comment for ``DELETE /api/v1/comments/{comment_id}``.

        Args:
            comment_id: The comment's identifier, from the URL path.
            actor: The resolved principal. Must own the comment or hold ``ADMIN``.

        Raises:
            NotFoundError: No comment carries that identifier.
            ForbiddenError: The actor neither wrote the comment nor holds ``ADMIN``.

        Note:
            **The comment's replies are not deleted here, and must never be.**
            ``comments.parent_id`` is a self-referencing foreign key with ``ON DELETE CASCADE``, so
            PostgreSQL removes the rows that referenced this comment and then cascades again from
            each of those: one statement removes the whole subtree, at any depth.
            ``Comment.replies`` additionally carries ``passive_deletes=True``, which is what stops
            SQLAlchemy loading every descendant in order to delete rows the database was going to
            remove anyway - so this method issues no query per level and reads no collection.

            A Python-side sweep would be a second definition of a rule the schema already
            guarantees, and the Python copy is the one that would drift: it would be the copy that
            forgets a relation added later. The response carries no body at all - ``204``, with no
            ``{"deleted": true}`` and no prose envelope - so there is nothing here to project.

            Deletion is final and is the reason ``REJECTED`` exists as a distinct state: a comment
            that should stop being public without ceasing to exist is rejected through
            :meth:`set_status`, which keeps the decision reversible and the author's history
            visible.
        """
        comment = await self._load_for_update(comment_id)
        ensure_can_modify(actor, comment.author_id)

        # Captured before the row goes: the instance is deleted by the statement below, so reading
        # either attribute for the audit line afterwards would fail.
        deleted_id = str(comment.id)
        post_id = str(comment.post_id)
        author_id = str(comment.author_id)

        await self._comments.delete(comment)
        await self._session.commit()

        get_logger(__name__).info(
            "comment deleted",
            comment_id=deleted_id,
            post_id=post_id,
            author_id=author_id,
            actor_id=str(actor.id),
        )

    async def set_status(
        self,
        comment_id: uuid.UUID,
        status: CommentStatus,
        *,
        actor: User,
    ) -> Comment:
        """Move a comment to a moderation state, for ``PATCH /api/v1/admin/comments/{id}/status``.

        The one transition an administrator makes, and the only way a comment becomes publicly
        visible. ``app.services.admin_service`` **delegates** here rather than writing the column
        itself, so this signature is a contract: the administrative surface adds its own listing and
        projection around this call and nothing about the transition is restated there.

        Args:
            comment_id: The comment's identifier, from the URL path.
            status: The state to move it to. Every one of the three is reachable from every other -
                approve a pending comment, reject it, or return a decided comment to the queue -
                so there is no transition table here and no illegal pair to reject. Retaining a
                rejected row rather than deleting it is what makes moderation reversible, and
                reversibility is meaningless if the reverse transition is refused.
            actor: The resolved principal. Must hold ``ADMIN``.

        Returns:
            The comment in its new state, with ``author`` loaded and ``replies`` deliberately
            unloaded.

        Raises:
            NotFoundError: No comment carries that identifier. Resolved before authority, as
                everywhere else in this module.
            ForbiddenError: The actor does not hold ``ADMIN``.

        Note:
            **The administrator check is made here even though ``require_admin`` is applied at
            router level** on the whole administrative namespace, so no administrative route can
            omit it. The redundancy is the point: this method is also reachable from
            ``admin_service``, and a rule enforced only at whichever entry point exists today is a
            rule the next entry point bypasses silently. ``is_admin`` is called rather than
            ``ensure_can_modify``, because ownership is not a route to this operation - a comment's
            author must not approve their own comment, which is the whole reason moderation is a
            separate method from :meth:`update`.

            **Setting the state a comment is already in is a no-op, not an error.** ``save`` finds
            nothing dirty, so no ``UPDATE`` is emitted; that makes the endpoint idempotent and safe
            for an administrative client to retry, and it means two moderators reaching the same
            decision do not produce a conflict.

            **No projection logic belongs here.** The administrative table needs a comment's author
            and its post, which is a different shape from the one a thread needs;
            ``app.schemas.admin`` owns that projection and ``admin_service`` applies it to what this
            method returns.
        """
        comment = await self._load_for_update(comment_id)
        if not is_admin(actor):
            raise ForbiddenError

        # Captured before the assignment, so the audit line records the transition rather than only
        # its destination - which is the part a moderation trail is actually read for.
        previous = comment.status
        comment.status = status

        await self._comments.save(comment)
        await self._session.commit()

        get_logger(__name__).info(
            "comment moderated",
            comment_id=str(comment.id),
            post_id=str(comment.post_id),
            author_id=str(comment.author_id),
            actor_id=str(actor.id),
            previous_status=previous.value,
            status=comment.status.value,
        )
        return await _load_author(comment)
