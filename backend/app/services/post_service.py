"""Business rules for the ``posts`` relation: the post lifecycle, ownership, and the feed.

This module owns the whole of requirement R2 - create, edit, delete, publish - and the service
half of R3, the home feed with free-text search, category filtering and pagination. It also
carries the **single declaration of the draft-confidentiality rule**, in
:func:`visible_statuses_for` and :func:`can_view_post`, which ``app.services.comment_service``
and ``app.services.like_service`` import rather than re-derive.

Authority lives here, not in the route
--------------------------------------
Post authority has two halves and a mutation must satisfy both. The **capability**: only an
account holding ``AUTHOR`` or ``ADMIN`` may author at all, so demoting an author to ``READER``
actually revokes something rather than merely relabelling the row. The **ownership rule**: an
author may act only on their own posts, while an administrator may act on any. Both comparisons
are made in this module by calling the predicates ``app.core.dependencies`` declares -
``ensure_can_author`` and ``ensure_can_modify`` - so each rule has one definition, holds no
matter which entry point invokes it, and is testable without an HTTP request:

.. code-block:: python

    service = PostService(session)
    post = await service.publish(post_id, actor=principal)  # 403 if READER, or if not theirs

A router's job is to resolve the principal, call one method here and let
``app.core.exceptions`` translate whatever is raised. A client-side route guard and a hidden
button are user experience, never a security boundary, so every protected operation is
re-checked below.

Why the retired service is not the pattern
------------------------------------------
The repository this replaces kept all five of its handlers in one module beside a
module-level list, wrote the identity predicate ``item.id == item_id`` three separate times,
raised ``HTTPException(status_code=404, detail="Item not found")`` three separate times, and
disagreed with itself about the response shape - two routes wrapped their result in
``{"message": ..., "data": ...}`` while two returned bare payloads. Each of those is a rule
with more than one definition, which is the failure mode this layering exists to remove.
Accordingly this module contains:

* **No SQL and no statement construction.** Every read and every write goes through
  ``app.repositories``. ``select``, ``func`` and ``insert`` are not imported, and neither is
  ``app.db.session``.
* **No HTTP concern.** No ``Request``, no ``Response``, no ``HTTPException``, no status-code
  literal. Failures are the typed domain errors of ``app.core.exceptions``.
* **No schema declaration.** Request and response shapes belong to ``app.schemas``.
* **No module-level mutable state.** The constants below are immutable, and the only mutable
  state in the module is the session a caller injects.

What the database guarantees, and what this module still must do
---------------------------------------------------------------
``posts`` carries ``CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL)``. That
constraint is a **backstop that must never fire**: :meth:`PostService.publish` assigns the
lifecycle state and the publication instant in one adjacent pair of statements, so no code
path can reach the database with one set and the other missing. Likewise
``posts.search_vector`` is ``GENERATED ... STORED``, so PostgreSQL re-derives the search index
on every write - it is never assigned here, and there is no index-maintenance step to forget.
``ON DELETE CASCADE`` on ``comments``, ``post_likes`` and ``post_categories`` removes a
deleted post's dependents, so :meth:`PostService.delete` deletes exactly one row.

Transactions
------------
``app.repositories`` flushes but never commits, and ``app.core.dependencies.get_db`` never
commits either: the transaction boundary belongs to this layer, because this is the layer that
knows when a unit of work is complete - a post created, its slug de-duplicated and its
categories associated. Each mutating method below therefore commits once, on success, and lets
every exception propagate for ``get_db`` to roll back. Nothing here opens a transaction
explicitly: ``session.begin()`` is never called, so the suite's outer transaction-per-test
fixture keeps working unchanged.

Sanitisation
------------
Author-authored Markdown is the one stored-injection surface this product has, and it is
cleaned at two boundaries: here on write, and again where it is rendered. Neither substitutes
for the other, and this module never assumes the client will cover for it. The allow-lists are
module-level named constants so they can be reviewed in one place - see
:data:`CONTENT_ALLOWED_TAGS`.

The write-side pass is itself two passes, because the field is Markdown that may embed HTML and
each syntax hides what the other cannot see. :func:`_sanitize_markdown_urls` neutralises a link,
image, autolink or reference definition whose destination names a scheme outside
:data:`CONTENT_ALLOWED_PROTOCOLS` - ``[text](javascript:...)`` carries no markup, so an HTML
sanitiser reads it as prose and passes it through intact - and ``bleach.clean`` then handles
markup written out longhand. Running only one of the two leaves a live vector, and the value both
protect is the *stored* one, which is what makes every consumer of ``GET /api/v1/posts/{slug}``
safe rather than only the renderer in this repository.

Both passes are CPU-bound over a body of up to a hundred thousand characters, so neither runs on
the event loop: every write path hands them to :func:`~app.core.security.run_cpu_bound`, which
offloads to a worker thread through a shared :class:`~anyio.CapacityLimiter` so an authoring burst
queues for a slot instead of occupying every thread the process has.
"""

import html
import re
import uuid
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from types import MappingProxyType
from typing import Final

import bleach
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import PageParams, ensure_can_author, ensure_can_modify, is_admin
from app.core.exceptions import (
    AppValidationError,
    ConflictError,
    FieldError,
    NotFoundError,
    integrity_constraint_name,
)
from app.core.logging import get_logger, log_safe_text
from app.core.pagination import Page, build_page
from app.core.security import run_cpu_bound
from app.core.slug import slugify_title, unique_slug
from app.models import Category, Post, PostStatus, User
from app.repositories import CategoryRepository, PostRepository, PostSort, UserRepository
from app.schemas.post import DEFAULT_POST_SORT_OPTION, PostCreate, PostSummary, PostUpdate

__all__ = [
    "ALL_POST_STATUSES",
    "CONTENT_ALLOWED_ATTRIBUTES",
    "CONTENT_ALLOWED_PROTOCOLS",
    "CONTENT_ALLOWED_TAGS",
    "PUBLIC_POST_STATUSES",
    "PostService",
    "can_view_post",
    "visible_statuses_for",
]


# ---------------------------------------------------------------------------------------
# Write-side sanitisation policy
#
# Named, module-level and immutable, for three reasons: the policy is a security control and
# a reviewer should be able to read it without reading the methods that apply it; the same
# protocol allow-list is shared by the body and the excerpt, so it exists once; and a
# frozenset is what bleach 6.4 expects, a list being the deprecated spelling.
#
# `app.services.comment_service` is the only other module permitted to import bleach. It
# deliberately keeps its OWN, much narrower allow-list: a reader-authored comment has no
# business carrying a heading, a table or an image, and widening one policy to serve both
# surfaces would silently widen the weaker one.
# ---------------------------------------------------------------------------------------

CONTENT_ALLOWED_TAGS: Final[frozenset[str]] = frozenset(
    {
        # Block structure an article legitimately uses.
        "p",
        "br",
        "hr",
        "div",
        "span",
        "blockquote",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        # Inline emphasis.
        "strong",
        "b",
        "em",
        "i",
        "u",
        "s",
        "del",
        "ins",
        "mark",
        "small",
        "sub",
        "sup",
        # Lists.
        "ul",
        "ol",
        "li",
        "dl",
        "dt",
        "dd",
        # Code, which a technical post cannot do without.
        "pre",
        "code",
        "kbd",
        "samp",
        # Links and media. `img` is a URL reference only; this API accepts no uploaded bytes.
        "a",
        "img",
        "figure",
        "figcaption",
        # Tables, as GitHub-flavoured Markdown produces them.
        "table",
        "thead",
        "tbody",
        "tfoot",
        "tr",
        "th",
        "td",
        "caption",
        "colgroup",
        "col",
    }
)
"""Elements author-authored content may keep. Everything else is removed.

Deliberately more permissive than a comment's policy and deliberately narrower than "any
HTML". Absent by design, and each absence is the point of the allow-list rather than an
oversight: ``script`` and ``style`` execute or restyle the page; ``iframe``, ``object``,
``embed`` and ``applet`` load a third-party document; ``form``, ``input``, ``button`` and
``select`` phish for credentials inside what looks like an article; ``link``, ``meta`` and
``base`` rewrite the document's own resolution rules; and ``svg`` and ``math`` carry their own
scripting surfaces.
"""

CONTENT_ALLOWED_ATTRIBUTES: Final[Mapping[str, tuple[str, ...]]] = MappingProxyType(
    {
        "a": ("href", "title", "rel", "name"),
        "img": ("src", "alt", "title", "width", "height", "loading"),
        "code": ("class",),
        "pre": ("class",),
        "span": ("class",),
        "div": ("class",),
        "ol": ("start", "reversed"),
        "li": ("value",),
        "th": ("colspan", "rowspan", "scope", "abbr"),
        "td": ("colspan", "rowspan", "headers"),
        "col": ("span",),
        "colgroup": ("span",),
        "table": ("summary",),
    }
)
"""Attributes each surviving element may keep, keyed by tag name.

An allow-list per element rather than a global one, because an attribute that is harmless on
``code`` is not harmless everywhere: ``class`` is how a syntax highlighter finds a fenced
block, and it has no business on an anchor. Every ``on*`` event handler is absent from every
entry, which is what removes the ``onerror``/``onclick`` vector - bleach drops any attribute
not named here, so the omission is the control.

``a`` keeps no ``target``: a link that opens a new context needs ``rel="noopener"`` to be safe
and an author cannot be relied on to pair them, so the client decides link behaviour at render
time from a policy it controls.

Read-only all the way down - a :class:`~types.MappingProxyType` over tuples rather than a
``dict`` of ``list`` - and that is a property of the control, not tidiness. ``Final`` stops the
name being rebound but nothing stops a mutable mapping being *edited*, and an edit here would
widen a security policy process-wide, for every post written afterwards, with no diff to review.
The same reasoning is why ``app.core.exceptions`` holds its shared header mapping this way.
Because bleach 6.4 requires ``attributes`` to be a callable, a ``list`` or a ``dict``
*instance* - a mapping proxy raises ``ValueError`` there - :func:`_bleach_attributes` hands it a
fresh ``dict`` per call, which also means the library cannot retain a reference to this one.
"""

CONTENT_ALLOWED_PROTOCOLS: Final[frozenset[str]] = frozenset({"http", "https", "mailto"})
"""URL schemes permitted in ``href`` and ``src``.

Three, and no more. ``javascript:`` and ``vbscript:`` execute; ``data:`` smuggles a document
past a scheme check; ``file:`` addresses the reader's own machine. bleach drops the whole
attribute when its value carries an unlisted scheme, so ``<a href="javascript:...">`` survives
as a plain ``<a>`` with its text intact rather than disappearing and taking the sentence with
it.

The same three schemes govern the **Markdown** link and image destinations
:func:`_sanitize_markdown_urls` inspects, so the policy is one set for both syntaxes rather
than an HTML rule and a Markdown rule that could drift apart.
"""

_URL_STRIPPED_CHARACTERS: Final[str] = "\t\n\r"
"""The characters a URL parser removes from *anywhere* inside a URL: tab, line feed, return.

Not a stylistic detail - it is the reason a scheme allow-list gets walked past. WHATWG URL
removes exactly these three from the whole input before parsing, so a tab in the middle of
``javascript`` still resolves to the ``javascript`` scheme in a browser while being an unknown
string to a naive comparison.

Space is deliberately **absent**. Leading and trailing spaces are stripped from a URL, but an
interior space is percent-encoded rather than removed, so ``foo bar:`` is not a scheme - and
treating it as one would defuse ``[text](foo bar)``, which Markdown never read as a link in the
first place.
"""

_MARKDOWN_SCHEME_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"""
    \A
    [\x00-\x20]*                     # leading C0 controls and spaces, which a URL parser strips
    (?P<scheme>
        [a-zA-Z]                     # a scheme must open with a letter
        [a-zA-Z0-9+.\-\t\n\r]*       # then scheme characters, interleaved padding tolerated
    )
    [\x00-\x20]*                     # and padding immediately before the colon
    :
    """,
    re.VERBOSE,
)
"""Matches the scheme of a Markdown destination, tolerating the padding a browser tolerates.

Anchored, so it answers "does this destination *open* with a scheme" and never finds one later
in the string - ``/a/b:c`` is a relative path whose colon is part of a segment, not a scheme.

Three kinds of padding are admitted, and each because a browser admits it: C0 controls and
spaces before the scheme, the three characters in :data:`_URL_STRIPPED_CHARACTERS` *inside* the
scheme name, and padding immediately before the colon. A pattern built on ``\\s`` alone, or one
that ended the scheme at the first unexpected character, would read a tab-interrupted
``javascript`` as no scheme at all, pass it through as safe, and hand a live script URL to
whichever renderer received the row - which is the classic way a scheme allow-list is walked
past. :func:`_destination_scheme` removes the padding from the captured value before comparing.
"""

_MARKDOWN_CODE_SPAN_PATTERN: Final[re.Pattern[str]] = re.compile(r"(?P<fence>`+)(?:.|\n)*?\1")
"""Matches an inline code span: a backtick run, its content, and a run of the same length.

CommonMark closes a code span with a backtick run of *exactly* the opening length, which the
back-reference expresses. Non-greedy, so ```` ``a`` and ``b`` ```` is two spans rather than one.
"""

_MARKDOWN_FENCE_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"^(?P<indent>[ \t]*)(?P<fence>`{3,}|~{3,})[^\n]*\n"
    r"(?:.*?\n)??"
    r"(?:(?P=indent)?(?P=fence)[`~]*[ \t]*$|\Z)",
    re.MULTILINE | re.DOTALL,
)
"""Matches a fenced code block, closed or left open at the end of the document.

Both fence characters, three or more of them, and a closing fence of at least the opening
length. An unclosed fence runs to the end of the input, which is what CommonMark specifies and
what stops a trailing ``` from making the rest of a document look like prose.
"""

_MARKDOWN_DESTINATION: Final[str] = (
    r"(?:"
    r"<[^<>\n]*>"  # an angle-bracketed destination
    r"|"
    r"(?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))+"  # or a bare one, parens balanced once
    r")"
)
"""Sub-pattern for a Markdown link destination, in either of its two spellings.

The bare form permits **one level of balanced parentheses**, which is what CommonMark itself
permits and what a real destination needs: ``javascript:fetch('/x')`` and
``https://en.wikipedia.org/wiki/Foo_(bar)`` both carry a parenthesised tail, and a class that
simply excluded ``(`` would fail to match either - leaving the link unmatched and, for the first
of the two, unneutralised. Backslash escapes are consumed as single units, so an escaped closing
parenthesis inside a destination does not close it early.

One level and not arbitrary nesting, deliberately: a recursive pattern is not expressible here
and an unbounded one would backtrack, which on a body of a hundred thousand characters is a
denial-of-service surface of its own. Anything this does not match is caught by
:func:`_break_unsafe_link_syntax`, which is why the bound is safe rather than merely pragmatic.
"""

_MARKDOWN_INLINE_LINK_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"""
    (?P<bang>!?)                     # an image when present, a link when not
    \[(?P<label>[^\]]*)\]            # the visible text
    \(
        [ \t]*
        (?P<destination>"""
    + _MARKDOWN_DESTINATION
    + r""")
        (?P<title>[ \t]+(?:"[^"]*"|'[^']*'|\([^)\n]*\))\s*)?
        [ \t]*
    \)
    """,
    re.VERBOSE,
)
"""Matches an inline Markdown link or image and captures its destination and title separately.

The label class excludes ``]`` rather than balancing brackets, which keeps the expression
linear and cannot backtrack pathologically on a body of up to a hundred thousand characters. A
nested-bracket label is therefore matched from its innermost ``]``; that produces a *shorter*
match, never a missed destination, so the scheme check still sees the URL.
"""

_MARKDOWN_LINK_OPENING_PATTERN: Final[re.Pattern[str]] = re.compile(r"\]\(")
"""Matches the two characters that open an inline destination, and nothing else.

The anchor for the safety net. It cannot fail to find a link, because ``](`` is the one thing
every inline link and image must contain - which is exactly the property
:func:`_break_unsafe_link_syntax` needs and the structural pattern above cannot promise.
"""

_MARKDOWN_TRAILING_SCHEME_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"""
    [\x00-\x20]*                     # optional padding after the opening parenthesis
    <?                               # the angle-bracketed spelling of a destination
    [\x00-\x20]*
    (?P<scheme>[a-zA-Z][a-zA-Z0-9+.\-\t\n\r]*)
    [\x00-\x20]*
    :
    """,
    re.VERBOSE,
)
"""The scheme matcher the safety net applies at a position inside the document.

Identical in meaning to :data:`_MARKDOWN_SCHEME_PATTERN` and deliberately *not* anchored with
``\\A``, because it is used through ``Pattern.match(text, position)`` - which anchors at the
position it is given, while ``\\A`` would keep insisting on the start of the whole string and
never match. Matching at a position rather than against a slice is what keeps the net linear: a
document with a thousand links would otherwise copy a tail per link.
"""

_MARKDOWN_AUTOLINK_PATTERN: Final[re.Pattern[str]] = re.compile(r"<(?P<destination>[^<>\s]+)>")
r"""Matches an angle-bracketed, whitespace-free token - a CommonMark autolink, or one spelled
like one.

The colon is deliberately **not** required by the pattern, and that is a widening over the obvious
spelling ``<[^<>\s]+:[^<>\s]*>``. The scheme is decided by :func:`_is_safe_destination`, which
decodes the destination first, so requiring a literal colon here would have made
``<javascript&#58;alert(1)>`` unmatchable - it carries no colon in the source - and left it in the
stored row. Strict CommonMark does not read that as an autolink either, so the one renderer in this
repository renders it inert; the stored representation nonetheless has to be safe for **any**
consumer, including a laxer renderer, which is the whole reason this pass exists.

Matching more is free here because deciding is separate from matching: a token that names no
scheme - ``<em>``, ``</em>``, ``<0>`` - is reported safe and returned untouched, so ordinary markup
and ordinary prose pass through unchanged.
"""

_MARKDOWN_REFERENCE_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"""
    ^(?P<prefix>[ \t]{0,3}\[(?P<label>[^\]]+)\]:[ \t]*)
    (?P<destination><[^<>\n]*>|\S+)
    (?P<suffix>[ \t]*(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\))?[ \t]*)$
    """,
    re.VERBOSE | re.MULTILINE,
)
"""Matches a link reference definition - ``[label]: destination "title"`` on its own line.

Indented at most three spaces, because four opens an indented code block instead. Reference
definitions matter as much as inline links: a body may carry ``[x][ref]`` far from the
``[ref]: javascript:...`` line that arms it, so a sanitiser that inspected only inline
destinations would leave the whole indirect form untouched.
"""

_MARKDOWN_BACKSLASH_ESCAPE_PATTERN: Final[re.Pattern[str]] = re.compile(r"\\([!-/:-@\[-`{-~])")
r"""Matches a CommonMark backslash escape: ``\`` followed by one ASCII punctuation character.

The character class is exactly the ASCII punctuation set the CommonMark specification names as
escapable, which is why it is written as four ranges rather than as a generic non-word class: a
backslash before a letter, a digit or a space is *not* an escape and must survive unchanged, while
``\:`` **is** a colon and is what makes ``[x](javascript\:alert(1))`` resolve as a ``javascript:``
URL in a renderer while carrying no colon at all in the source.
"""

_DESTINATION_HEAD_LIMIT: Final[int] = 4096
"""How much of an unparsed destination the safety net decodes before checking its scheme.

A bound is needed because the net works at an offset inside the document rather than on a parsed
destination, and decoding an unbounded tail per ``](`` would make the pass quadratic. 4096 is far
beyond any legitimate scheme: the longest dangerous one is ten characters, each of which can be
spelled as a character reference of at most ten (``&#x0006A;``), so even a fully obfuscated
``javascript:`` occupies barely a hundred. The structural pass above has no such bound - it decodes
the whole destination it captured - so this limit applies only to spellings that pass parsing
altogether, and the net's answer for those is to break the link syntax rather than to trust them.
"""

_NO_TAGS: Final[frozenset[str]] = frozenset()
"""The empty tag allow-list used for the title and the excerpt: strip every element, keep the
text."""

_TITLE_SANITISE_PASSES: Final[int] = 12
"""How many strip-and-decode passes :func:`_sanitize_title` may perform before it gives up.

A **bound on a search for a fixed point**, not a number of passes to perform. The loop stops as
soon as a pass changes nothing - which is what "fixed point" means here, and which the ordinary
title reaches in one - and if it has not converged within this many passes the title is *refused*
rather than stored. That distinction is the whole correctness argument: a bounded number of passes
that stores whatever the last one produced can store raw markup, because the last operation in a
pass is a decode, so a title whose entity nesting outlasts the bound arrives at storage with a
live-looking ``<script>`` in it. Refusing instead means the function is total on hostile input
*and* every value it returns is a proven fixed point.

Twelve is generous rather than tight, and deliberately so. Each nesting level of an
entity-encoded ``<`` costs four characters (``&lt;`` -> ``&amp;lt;`` -> ``&amp;amp;lt;``), and
``app.schemas.post.PostTitle`` bounds a title at 120 characters, so the deepest nesting a title can
carry is around ten levels for a single tag - already below this bound, which is why a legitimate
title can never be refused by exhaustion. Each pass is monotone in the sense that matters: the
decode strictly shortens the value while any character reference remains, so convergence is
guaranteed and the bound is a guard rather than the mechanism.
"""

_TITLE_MARKUP_SURVIVED: Final[str] = (
    "The title could not be reduced to plain text. Remove the markup and the character "
    "references from it and submit it again."
)
"""Reported when :func:`_sanitize_title` cannot prove the value it holds is tag-free."""

_FIELD_TITLE: Final[str] = "title"
"""The member name reported in ``errors`` when a title cannot be accepted.

The submitted member's own name, so a client's form attaches the message to the control the author
typed into - the same contract ``ValidationErrorItem.field`` publishes for a schema rejection.
"""

_FIELD_ERROR_TYPE: Final[str] = "value_error"
"""Validator identifier for a service-raised field error.

Pydantic's own code for "a validator rejected this value", reused deliberately: a client
switching on ``type`` cannot tell whether the rejection came from the schema or from this layer,
and it should not have to - the two are the same kind of failure about the same member.
"""

_TITLE_EMPTY_AFTER_SANITISATION: Final[str] = (
    "The title must contain text of its own. Everything submitted was markup, and removing it "
    "left nothing to publish."
)
"""Detail for a title that sanitises away to nothing.

Says what happened and what to do about it without quoting what was submitted, which is the rule
every ``detail`` in this service is held to. The parallel message for a comment body lives in
``app.services.comment_service`` and is worded the same way for the same reason.
"""

_NO_ATTRIBUTES: Final[Mapping[str, tuple[str, ...]]] = MappingProxyType({})
"""The empty attribute allow-list that accompanies :data:`_NO_TAGS`.

Read-only for the same reason as :data:`CONTENT_ALLOWED_ATTRIBUTES`, and here the reason is
sharper: with no tag allowed, an entry added to this mapping by accident would be the only thing
standing between a plain-text excerpt and markup.
"""


def _bleach_attributes(policy: Mapping[str, tuple[str, ...]]) -> dict[str, tuple[str, ...]]:
    """Adapt a read-only attribute policy to the concrete ``dict`` bleach insists on.

    ``bleach.sanitizer.attribute_filter_factory`` dispatches on ``callable``, then on
    ``isinstance(attributes, dict)``, then on ``isinstance(attributes, list)``, and raises
    ``ValueError`` for anything else - so a :class:`~types.MappingProxyType` cannot be passed
    straight through even though it satisfies the ``Mapping`` protocol the code needs. The copy
    is shallow and covers thirteen keys at most, which is immaterial beside parsing a body of up
    to a hundred thousand characters, and it has a second effect worth having: the library is
    handed a mapping it may keep or mutate freely without reaching the policy.

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
# One spelling per message. `post_service` reports a post that does not exist and a post the
# caller may not see with the SAME detail, and that identity is the whole point of naming the
# string once - see PostService.get_by_slug.
# ---------------------------------------------------------------------------------------

_POST_NOT_FOUND: Final[str] = "Post not found"
_AUTHOR_NOT_FOUND: Final[str] = "Author not found"
_SLUG_CONFLICT: Final[str] = (
    "A post with a conflicting URL slug was created concurrently. Retry the request."
)

_CATEGORY_FILING_CONFLICT: Final[str] = (
    "This post's category filings were changed concurrently. Reload the post and retry."
)

_SLUG_UNIQUE_INDEX: Final[str] = "ix_posts_slug"
"""Name of the unique index that makes a duplicate slug unstorable.

Not invented: the index is produced by ``unique=True, index=True`` on ``Post.slug`` under the
``"ix": "ix_%(column_0_label)s"`` convention in ``app.db.base``, revision ``0001`` creates it
under that name, and PostgreSQL reports it as the ``constraint_name`` on the violation -
confirmed by execution against PostgreSQL 18.4, which answered ``SQLSTATE 23505`` with
``diag.constraint_name = 'ix_posts_slug'``.
"""

_POST_CATEGORIES_PRIMARY_KEY: Final[str] = "pk_post_categories"
"""Composite primary key ``(post_id, category_id)`` on the filing association."""

_POST_CATEGORIES_CATEGORY_FK: Final[str] = "fk_post_categories_category_id_categories"
"""Foreign key from a filing to the category it names."""

_CONFLICT_CONSTRAINTS: Final[Mapping[str, str]] = MappingProxyType(
    {
        # Two concurrent creates of the same title. The taken-slug set was read a moment before
        # the INSERT, so the loser of the race arrives here; a retry sees the row that won and
        # derives the next free suffix, which is why this is reported as contention.
        _SLUG_UNIQUE_INDEX: _SLUG_CONFLICT,
        # Two concurrent writers filing this post under the same category. The ORM computes the
        # association delta from the membership it loaded, so a filing added in between is a row
        # the delta does not know about.
        _POST_CATEGORIES_PRIMARY_KEY: _CATEGORY_FILING_CONFLICT,
        # A category deleted after `_resolve_categories` confirmed it existed. The identifier was
        # valid when the request was validated, so this is contention rather than a bad request -
        # and the 404 that a genuinely unknown identifier earns is raised before any statement.
        _POST_CATEGORIES_CATEGORY_FK: _CATEGORY_FILING_CONFLICT,
    }
)
"""The only integrity failures this service is willing to translate, and what each becomes.

Everything absent from this mapping is re-raised. That is the point of expressing it as an
allow-list: a check violation on ``ck_posts_published_at_required``, a foreign key to a deleted
author, a ``NOT NULL`` violation - each says something has gone wrong *here*, in this service,
and reporting one as "somebody else got there first" would send a client to retry a request that
cannot succeed while hiding the defect behind ordinary-looking contention.

Read-only, for the reason recorded on :data:`CONTENT_ALLOWED_ATTRIBUTES`: ``Final`` stops the
name being rebound but nothing stops a mutable mapping being edited, and an entry added here at
runtime would widen error translation process-wide with no diff to review.
"""

SLUG_ALLOCATION_ATTEMPTS: Final[int] = 4
"""How many times :meth:`PostService.create` re-derives a slug and re-inserts after losing a race.

Slug allocation is read-then-insert: :meth:`PostService._derive_slug` reads the taken members of a
slug family and picks the first free suffix, and a concurrent create of the same title can take
that suffix between the read and the ``INSERT``. Reporting the loser a ``409`` would break the
promise the route publishes - that a colliding title is de-duplicated with an ascending suffix and
succeeds - so the loser retries instead: it re-reads the family, sees the row that won, and takes
the next suffix.

Four attempts, and the number is a bound on *contention*, not on collisions. Each retry re-reads
the family, so N concurrent creates of one title need at most N attempts between them and any single
request needs one more attempt only if it loses again - which requires another writer to commit
inside the window between this request's re-read and its re-insert. Four therefore covers three
consecutive losses, and a request that loses four times is contending with a volume of identical
titles that is no longer an allocation race; it receives the ``409`` the contract documents, which
is honest rather than retried forever. The bound also guarantees the method terminates, which an
unbounded ``while`` would not.
"""

_TRANSLATABLE_SQLSTATES: Final[frozenset[str]] = frozenset({"23505", "23503"})
"""``unique_violation`` and ``foreign_key_violation`` - the two classes that can be contention.

Checked alongside the constraint name rather than instead of it, so one differently-classed
error that happens to name the same object cannot satisfy the test. Deliberately excluded:
``23514`` (``check_violation``) and ``23502`` (``not_null_violation``), neither of which a
concurrent request can cause - both mean this service assembled a row it should not have.
"""


def _conflict_detail(error: IntegrityError) -> str | None:
    """Classify an integrity failure, returning the conflict to report or ``None`` to re-raise.

    One classifier shared by :meth:`PostService.create` and :meth:`PostService.update`, so the
    two paths cannot disagree about which failures are contention. Before it existed, ``create``
    reported *every* integrity error as a slug collision - masking a check violation, a dangling
    author and a missing column behind one misleading ``409`` - while ``update`` translated
    nothing at all, so the concurrent category-filing race it can genuinely lose surfaced as an
    unhandled ``500``.

    Args:
        error: The failure SQLAlchemy raised, wrapping the driver's own exception in ``orig``.

    Returns:
        The ``detail`` for a :class:`~app.core.exceptions.ConflictError` when the failure is one
        of the recognised races in :data:`_CONFLICT_CONSTRAINTS`; ``None`` when it is anything
        else, which the caller must re-raise untouched.

    Note:
        The discriminator is the driver's diagnostic, never a substring search of the message.
        ``psycopg`` populates ``diag.constraint_name`` from the server's own error fields, so the
        comparison is against the identity PostgreSQL reports; matching on message text would
        depend on the server's locale and on wording that is free to change between releases.

        Written defensively about the *shape* of ``orig`` rather than about the outcome: a driver
        exposing no ``diag`` yields ``None`` and the failure propagates. Failing closed means an
        unrecognised error is reported as an error.

        Renaming any of the three constraints is a change this mapping has to make with it, and
        forgetting is visible rather than silent - a genuine slug race would answer ``500`` where
        the published contract promises ``409``.
    """
    constraint = integrity_constraint_name(error, sqlstates=_TRANSLATABLE_SQLSTATES)
    if constraint is None:
        return None
    return _CONFLICT_CONSTRAINTS.get(constraint)


def _is_slug_race(error: IntegrityError) -> bool:
    """Report whether this failure is specifically the slug unique violation, and nothing else.

    Narrower than :func:`_conflict_detail` on purpose, and the two are not interchangeable. A
    category-filing race is also a conflict this service translates, but it is **not** retryable
    here: retrying it would re-attempt the same filing against a taxonomy that has changed, so the
    caller is told to reload. Only the slug race is resolved by trying again, because the retry
    reads the family afresh and takes a suffix that is now free.

    Args:
        error: The failure SQLAlchemy raised.

    Returns:
        ``True`` when the driver reports a unique violation on :data:`_SLUG_UNIQUE_INDEX`.
    """
    return integrity_constraint_name(error, sqlstates=_TRANSLATABLE_SQLSTATES) == _SLUG_UNIQUE_INDEX


# ---------------------------------------------------------------------------------------
# Lifecycle visibility
#
# Two tuples rather than two literals at each call site. `list_posts` takes the states to
# include as an ARGUMENT and takes no authority decision of its own, so these are the values
# that decision resolves to.
# ---------------------------------------------------------------------------------------

PUBLIC_POST_STATUSES: Final[tuple[PostStatus, ...]] = (PostStatus.PUBLISHED,)
"""What an anonymous or unrelated caller may see in any listing: published posts only.

``ARCHIVED`` is absent deliberately. An archived post has been withdrawn without being
deleted, so it is no more public than a draft; only its author and an administrator may still
list it.
"""

ALL_POST_STATUSES: Final[tuple[PostStatus, ...]] = (
    PostStatus.DRAFT,
    PostStatus.PUBLISHED,
    PostStatus.ARCHIVED,
)
"""Every lifecycle state, for a caller entitled to the whole of a listing.

Spelled out rather than passed to the repository as ``statuses=None``, which means the same
thing to the query. An explicit tuple keeps :func:`visible_statuses_for` returning one type on
every branch, which is what makes it a plain value a unit test can compare, and it keeps the
membership under review here if a fourth state is ever added.
"""


def _normalise_scheme(scheme: str) -> str:
    """Reduce a captured scheme to the spelling a URL parser would resolve it as.

    Args:
        scheme: The scheme exactly as written, padding included.

    Returns:
        The scheme with every character in :data:`_URL_STRIPPED_CHARACTERS` removed and the rest
        lower-cased, which is the form :data:`CONTENT_ALLOWED_PROTOCOLS` is written in.

    Note:
        Shared by :func:`_destination_scheme` and by the safety net in
        :func:`_break_unsafe_link_syntax`, so the two cannot disagree about what a padded or
        mixed-case scheme reduces to. Two copies of this three-line reduction is exactly how one
        of them ends up comparing ``JAVA\tSCRIPT`` against an allow-list of lower-case names and
        concluding it is unknown, therefore safe.
    """
    for stripped in _URL_STRIPPED_CHARACTERS:
        scheme = scheme.replace(stripped, "")
    return scheme.lower()


def _decode_markdown_destination(destination: str) -> str:
    """Resolve a destination to the characters a Markdown renderer will actually see.

    **The scheme check must run on this, never on the source text.** CommonMark resolves both
    backslash escapes and HTML character references inside a link destination before the URL is
    handed to the renderer, so three spellings of one dangerous URL exist:

    * ``javascript:alert(1)`` - the literal form;
    * ``javascript&#58;alert(1)`` - a numeric character reference for the colon, which also has
      the hexadecimal spelling ``&#x3A;`` and the named spelling ``&colon;``;
    * ``javascript\\:alert(1)`` - a backslash escape of the colon.

    All three become ``javascript:`` in the rendered document, and the second and third contain no
    ``:`` at all in the source. A check that matched the source therefore concluded "this
    destination names no scheme, so it is relative and safe" and stored the payload untouched -
    which is precisely the bypass this function closes. The obfuscation is not limited to the
    colon either: ``&#106;avascript:`` decodes to ``javascript:``, so the whole head is decoded
    rather than only the delimiter.

    Percent-encoding is deliberately **not** decoded. A browser does not resolve ``javascript%3A``
    as a scheme - the value is a relative reference whose first path segment happens to contain an
    encoded colon - so decoding it here would refuse links that are in fact inert.

    Order matters: the backslash escapes are removed first, because ``\\&#58;`` is an escaped
    ampersand and must *not* then be read as a character reference. Removing the escapes first
    turns it into a literal ``&`` before ``html.unescape`` runs, so the reference is not
    reconstituted by this function's own first step.

    Args:
        destination: A link, image, autolink or reference-definition destination as written, with
            any surrounding angle brackets already removed.

    Returns:
        The destination with CommonMark backslash escapes resolved and HTML character references
        decoded. Not a URL to store or emit - only a value to inspect.
    """
    unescaped = _MARKDOWN_BACKSLASH_ESCAPE_PATTERN.sub(r"\1", destination)
    return html.unescape(unescaped)


def _destination_scheme(destination: str) -> str | None:
    """Report the URL scheme a Markdown destination opens with, lower-cased.

    Args:
        destination: A link or image destination, already stripped of any surrounding angle
            brackets.

    Returns:
        The scheme in lower case with its internal padding removed, or ``None`` when the
        destination carries none - a relative path, a bare fragment, a query, or a
        protocol-relative ``//host/path``. All four are safe by construction: none of them can
        name a scheme, so the document they resolve against decides, and that document is the
        site's own.

    Note:
        The destination is decoded by :func:`_decode_markdown_destination` before the match, so an
        entity-encoded or backslash-escaped colon is seen as the colon a renderer will see. That
        decode is the whole reason this function is not a one-line regular expression match.

        The padding is removed *after* the match rather than being excluded by the pattern,
        because a browser resolves ``java\\tscript:x`` and ``jav\\nascript:x`` as
        ``javascript:``. Comparing the padded spelling against the allow-list would find no
        match, conclude "no scheme", and pass exactly the value the check exists to catch. See
        :data:`_URL_STRIPPED_CHARACTERS` for which characters are stripped, and why a space is
        not one of them.
    """
    match = _MARKDOWN_SCHEME_PATTERN.match(_decode_markdown_destination(destination))
    if match is None:
        return None
    return _normalise_scheme(match.group("scheme"))


def _is_safe_destination(destination: str) -> bool:
    """Report whether a Markdown destination may keep its link.

    Args:
        destination: The raw destination as written, angle brackets included if present.

    Returns:
        ``True`` when the destination carries no scheme at all, or carries one named in
        :data:`CONTENT_ALLOWED_PROTOCOLS`; ``False`` otherwise.
    """
    inner = destination.strip()
    if inner.startswith("<") and inner.endswith(">"):
        inner = inner[1:-1]
    scheme = _destination_scheme(inner)
    return scheme is None or scheme in CONTENT_ALLOWED_PROTOCOLS


def _code_spans(raw: str) -> list[tuple[int, int]]:
    """Locate every region of a Markdown document that renders as literal text.

    Fenced code blocks, in both fence characters and whether or not they are closed, and inline
    code spans. Nothing inside either is a link to a Markdown renderer, so nothing inside either
    may be rewritten by :func:`_sanitize_markdown_urls`.

    Args:
        raw: The submitted body.

    Returns:
        Non-overlapping ``(start, end)`` half-open ranges, in ascending order.

    Note:
        Fences are collected first and a code span is accepted only when it lies entirely outside
        every fence. The order matters: a fenced block may legitimately contain unbalanced
        backticks, so a span search run first would pair a backtick inside the block with the
        fence marker that closes it and swallow the boundary.

        Ranges rather than placeholder substitution, and that is the difference between a correct
        implementation and a nearly-correct one. Substituting a sentinel - ``\\x00<index>\\x00``,
        say - assumes the document contains no occurrence of the sentinel, and an author's body is
        untrusted input that can contain anything: a body carrying the sentinel's own spelling
        would have its text replaced by an unrelated code block, or raise an index error and
        answer 500. Working in offsets removes the assumption instead of hardening it.
    """
    spans: list[tuple[int, int]] = [match.span() for match in _MARKDOWN_FENCE_PATTERN.finditer(raw)]

    for match in _MARKDOWN_CODE_SPAN_PATTERN.finditer(raw):
        start, end = match.span()
        overlaps_fence = any(
            start < fence_end and fence_start < end for fence_start, fence_end in spans
        )
        if not overlaps_fence:
            spans.append((start, end))

    spans.sort()
    return spans


def _break_unsafe_link_syntax(text: str) -> str:
    """Make any inline destination this module could not parse inert, without deleting anything.

    The safety net, and the reason the structural rewrite above is allowed to be a regular
    expression at all. :data:`_MARKDOWN_INLINE_LINK_PATTERN` has to bound its destination
    somewhere - one level of balanced parentheses, no newline in a title - and every bound is a
    spelling it will not match. An unmatched link is a link left untouched, which for a
    ``javascript:`` destination is precisely the outcome that must not be possible. So this pass
    asks a question that has no bound: for every ``](`` in the document, does what follows open
    with a scheme this policy refuses?

    Where it does, the *link syntax* is broken rather than the text removed: a space is inserted
    between the label's ``]`` and the ``(``, which is enough for Markdown to stop reading the two
    as a link and render both as ordinary characters. Nothing is deleted, so an author can see
    exactly what they wrote and why it did not become a link, and the destination cannot become
    an ``href`` in any renderer because there is no longer a link for it to belong to.

    Args:
        text: The body, after the structural rewrite and with code regions still masked.

    Returns:
        The body with every unparsed unsafe destination defused. In the ordinary case the
        structural pass has already removed them all and this returns its argument unchanged.

    Note:
        The scheme is read from the text *following* the ``](`` with the same anchored matcher
        the structural pass uses, so the two agree about what a scheme is and about the padding a
        browser tolerates. Only the head of the destination is examined, which is why no bound on
        the destination's length is needed here.
    """

    def defuse(match: re.Match[str]) -> str:
        # A bounded head rather than the whole tail, so a document with many links stays linear -
        # see `_DESTINATION_HEAD_LIMIT`. It has to be a slice rather than a match at an offset,
        # because the head is DECODED before the scheme is read: an entity-encoded or
        # backslash-escaped colon contains no `:` in the source, so a matcher applied to the
        # source would find no scheme and conclude the destination was relative - the same
        # bypass `_decode_markdown_destination` closes for the structural pass.
        head = _decode_markdown_destination(
            text[match.end() : match.end() + _DESTINATION_HEAD_LIMIT]
        )
        scheme_match = _MARKDOWN_TRAILING_SCHEME_PATTERN.match(head)
        if scheme_match is None:
            # No scheme follows, so the destination is relative, a fragment, a query or
            # protocol-relative. All four resolve against this site's own document.
            return match.group(0)
        if _normalise_scheme(scheme_match.group("scheme")) in CONTENT_ALLOWED_PROTOCOLS:
            return match.group(0)
        return "] ("

    return _MARKDOWN_LINK_OPENING_PATTERN.sub(defuse, text)


def _sanitize_markdown_urls(raw: str) -> str:
    """Neutralise Markdown link and image destinations whose scheme is not permitted.

    The **Markdown** half of the write-side content policy, and the half an HTML sanitiser
    cannot supply. ``posts.content`` is stored as Markdown and rendered as Markdown, so
    ``[Click here](javascript:fetch('/steal'))`` contains no markup for :func:`bleach.clean` to
    inspect: it passes the HTML pass through byte for byte and becomes
    ``<a href="javascript:...">`` in whichever renderer receives it. This function is what makes
    the *stored representation* safe, so every consumer of ``GET /api/v1/posts/{slug}`` is
    protected rather than only the one renderer in this repository.

    Four constructs carry a destination, and all four are covered, because leaving any one of
    them would leave the vector intact by a different spelling:

    * an inline link, ``[text](destination)``
    * an inline image, ``![alt](destination)``
    * an autolink, ``<scheme:rest>``
    * a link reference definition, ``[label]: destination``, which arms every ``[text][label]``
      in the document from a line that may be nowhere near them

    Args:
        raw: The submitted body exactly as it arrived, before the HTML pass.

    Returns:
        The body with every unsafe destination removed and its visible text preserved: a link
        becomes its label, an image becomes its alt text, an autolink becomes its own literal
        characters, and a reference definition's destination becomes an empty fragment so the
        definition still parses and resolves nowhere. Safe destinations, and every other
        character of the document, are returned untouched.

    Note:
        **Code is left alone, and that is a correctness requirement rather than a nicety.** A
        technical article legitimately contains ``[x](javascript:void(0))`` inside a fenced
        block or a code span as the *subject* of the prose, where Markdown renders it as text
        and it is inert. Rewriting it would corrupt the author's example to remove a risk that
        was never there, so the document is split on the ranges :func:`_code_spans` reports -
        fenced blocks in both fence characters, closed or unclosed, and inline code spans - and
        only the gaps between them are rewritten. Indented code blocks are not excluded: an
        indented line is still parsed for nothing but text, and the one construct that *is*
        position-sensitive there, the reference definition, already refuses an indent of four or
        more spaces in :data:`_MARKDOWN_REFERENCE_PATTERN`.

        **The link is dropped and the text kept**, which is the same choice bleach makes for
        ``<a href="javascript:...">``: it removes the attribute and leaves the sentence
        readable. Deleting the label with it would silently edit an author's paragraph, and
        rejecting the whole submission would make a defensible article unpublishable over one
        bad URL.

        **Two layers, not one.** The four patterns above remove an unsafe link precisely and
        keep its text; :func:`_break_unsafe_link_syntax` then guarantees that anything they could
        not parse is inert anyway. A regular expression over Markdown necessarily bounds what it
        matches, and every bound is a spelling that would otherwise slip through - so the second
        layer is what makes the guarantee unconditional rather than dependent on the first
        layer's coverage.

        This runs *before* the HTML pass, on the raw text, so Markdown syntax is still intact -
        after bleach a bare ``<`` has become ``&lt;`` and an autolink is no longer recognisable
        as one.
    """

    def rewrite_inline(match: re.Match[str]) -> str:
        if _is_safe_destination(match.group("destination")):
            return match.group(0)
        # The label for a link, the alt text for an image. Both are the visible content, so
        # keeping them is what leaves the sentence intact.
        return match.group("label")

    def rewrite_autolink(match: re.Match[str]) -> str:
        if _is_safe_destination(match.group("destination")):
            return match.group(0)
        # The angle brackets are dropped with the link. What remains is ordinary text, and the
        # HTML pass that follows escapes anything in it that could open a tag.
        return match.group("destination")

    def rewrite_reference(match: re.Match[str]) -> str:
        if _is_safe_destination(match.group("destination")):
            return match.group(0)
        # The definition is kept and pointed at an empty fragment rather than deleted. Deleting
        # it would turn every `[text][label]` that used it into literal brackets in the middle
        # of a paragraph; pointing it at `#` leaves the prose reading as the author wrote it.
        return f"{match.group('prefix')}#{match.group('suffix')}"

    def clean(segment: str) -> str:
        segment = _MARKDOWN_INLINE_LINK_PATTERN.sub(rewrite_inline, segment)
        segment = _MARKDOWN_AUTOLINK_PATTERN.sub(rewrite_autolink, segment)
        segment = _MARKDOWN_REFERENCE_PATTERN.sub(rewrite_reference, segment)
        # Last, and on the result of the three above: whatever they could not parse is defused
        # here rather than left to a renderer. See `_break_unsafe_link_syntax`.
        return _break_unsafe_link_syntax(segment)

    # Rewrite the gaps between the code regions and copy the code regions through untouched. The
    # common case - a body with no code in it at all - is one segment and one pass.
    pieces: list[str] = []
    cursor = 0
    for start, end in _code_spans(raw):
        pieces.append(clean(raw[cursor:start]))
        pieces.append(raw[start:end])
        cursor = end
    pieces.append(clean(raw[cursor:]))

    return "".join(pieces)


def _sanitize_content(raw: str) -> str:
    """Clean author-authored Markdown for storage, keeping the document intact.

    The write-side half of the sanitisation pair. The client sanitises again where it renders,
    and neither half is redundant: this one is what makes the stored row safe for **any**
    consumer, including a future one that does not run the client's pipeline.

    Args:
        raw: The submitted body, exactly as it arrived. Already length-bounded and known to
            carry a non-whitespace character by ``app.schemas.post.PostContent``.

    Returns:
        The body with every unsafe **Markdown** destination neutralised by
        :func:`_sanitize_markdown_urls`, then every element outside
        :data:`CONTENT_ALLOWED_TAGS` removed, every attribute outside
        :data:`CONTENT_ALLOWED_ATTRIBUTES` dropped, every URL scheme outside
        :data:`CONTENT_ALLOWED_PROTOCOLS` refused, and every comment stripped.

    Note:
        **Two passes, in this order, because the field is Markdown that may embed HTML.** The
        Markdown pass runs first, while ``[x](javascript:…)`` is still recognisable as a link
        and before bleach escapes the ``<`` an autolink needs; the HTML pass then handles any
        markup the author wrote out longhand. Either pass alone leaves a live vector: bleach
        sees no markup in a Markdown link, and the Markdown pass does not parse HTML. The
        stored value is what both protect, so every consumer of the API inherits the result and
        none of them has to repeat it.

        ``strip=True`` removes a disallowed element rather than escaping it into visible text.
        A reader of ``<script>alert(1)</script>`` is shown ``alert(1)``, not a literal script
        tag rendered as prose. The schema promises exactly this - "a submission is never
        rejected for containing markup; the markup is simply cleaned".

        Markdown structure is preserved because none of it is markup to an HTML parser:
        headings, list bullets, fenced blocks and the four-space indent that opens a code block
        all pass through byte for byte. The one mutation to be aware of is that a bare ``<`` or
        ``&`` in the body is escaped to its character reference, which is the correct and
        unavoidable outcome of parsing untrusted text as HTML - ``<`` genuinely may open a tag.
        Markdown resolves a character reference on render, so the reader sees what the author
        typed.
    """
    # Bound to an annotated local before returning. `bleach` publishes no type information -
    # `backend/pyproject.toml` records it under `ignore_missing_imports` - so the call's result
    # is `Any`, and binding it here is what keeps the function's declared return type honest
    # without a `# type: ignore`.
    cleaned: str = bleach.clean(
        _sanitize_markdown_urls(raw),
        tags=CONTENT_ALLOWED_TAGS,
        attributes=_bleach_attributes(CONTENT_ALLOWED_ATTRIBUTES),
        protocols=CONTENT_ALLOWED_PROTOCOLS,
        strip=True,
        strip_comments=True,
    )
    return cleaned


def _sanitize_excerpt(raw: str) -> str | None:
    """Reduce a submitted excerpt to plain text, or to ``None`` when nothing survives.

    The excerpt is not a document. It is rendered as the feed card's summary, as the page's
    ``meta`` description and as the ``description`` member of the ``BlogPosting`` structured
    data, and none of those three positions can carry an element - so every tag is stripped
    rather than allow-listed.

    Args:
        raw: The submitted excerpt, already trimmed and length-bounded by
            ``app.schemas.post.PostExcerpt``.

    Returns:
        The text with all markup removed, or ``None`` when the submission was nothing but
        markup and stripping leaves it empty.

    Note:
        Folding an empty result to ``None`` keeps the column's single representation of "this
        post has no excerpt". ``app.schemas.post`` folds a blank submission the same way and
        for the same reason: two representations of one state is a defect waiting to happen,
        because ``excerpt or fallback`` and ``excerpt is None`` would then disagree.

        Character references are left in their escaped form. That is the safe form at all
        three of the positions above, and decoding them here would hand a raw ``<`` to a
        consumer that has already been told the value is plain text.
    """
    cleaned: str = bleach.clean(
        raw,
        tags=_NO_TAGS,
        attributes=_bleach_attributes(_NO_ATTRIBUTES),
        protocols=CONTENT_ALLOWED_PROTOCOLS,
        strip=True,
        strip_comments=True,
    )
    return cleaned.strip() or None


def _strip_and_decode(value: str) -> str:
    """Run one title-sanitisation pass: decode, strip every element, decode again, trim.

    Factored out of :func:`_sanitize_title` because the pass is applied in two places for two
    different reasons - once per iteration of the convergence loop, and once more afterwards to
    *prove* the converged value is a fixed point - and a second copy of a five-line sanitisation
    step is exactly the kind of duplication that comes to disagree with itself.

    The leading decode is what lets the loop make progress on an encoded tag: ``&lt;b&gt;`` is
    text to a stripper and only becomes an element once decoded. The trailing decode resolves the
    references ``bleach.clean`` introduces while escaping, so ``Tips & Tricks`` is not stored as
    ``Tips &amp; Tricks`` - the reason a title cannot simply reuse :func:`_sanitize_excerpt`.

    Args:
        value: The current candidate title.

    Returns:
        The candidate after one pass. Equal to its argument exactly when the argument is a fixed
        point, which is the property the caller tests.
    """
    stripped: str = bleach.clean(
        html.unescape(value),
        tags=_NO_TAGS,
        attributes=_bleach_attributes(_NO_ATTRIBUTES),
        protocols=CONTENT_ALLOWED_PROTOCOLS,
        strip=True,
        strip_comments=True,
    )
    return html.unescape(stripped).strip()


def _sanitize_title(raw: str) -> str:
    """Reduce a submitted title to the plain text it claims to be, or refuse it.

    The title had been the one authored member that reached its column exactly as it arrived,
    while its plain-text sibling ``excerpt`` was stripped and the Markdown body was cleaned. That
    asymmetry meant a title reading ``XSS <script>alert(1)</script> probe`` was stored, served and
    slugified verbatim, so every consumer of this API inherited raw markup in the one field it is
    told is a label - and the slug derived from it carried the tag names into a canonical URL.

    Why this is not simply :func:`_sanitize_excerpt`
    -----------------------------------------------
    Because ``bleach.clean`` escapes as well as strips. It is the right answer for the excerpt,
    which is emitted into a ``meta`` description and into structured data where the escaped form is
    the safe one - and its docstring says so deliberately. Applied to a title it would be a new
    defect rather than a fix: ``Tips & Tricks`` would be **stored** as ``Tips &amp; Tricks``,
    rendered that way in every card heading and ``h1``, and slugified to ``tips-amp-tricks``. A
    title is a label, so the stored value has to be the text a reader typed.

    So each pass strips markup and then decodes the character references the strip introduced,
    and the passes repeat **until the value stops changing**. Convergence is what closes the
    entity-encoded form: ``&lt;script&gt;alert(1)&lt;/script&gt;`` survives one pass unchanged as
    escaped text, decodes to real markup, and is stripped on the next - so a single pass would
    have stored a title containing a live-looking ``<script>`` element.

    A fixed point is the *guarantee*, and reaching one is a precondition for storing anything.
    Because the last operation in a pass is a decode, a loop that simply ran a fixed number of
    passes and kept the result could store raw markup: at depth *n* + 1 the final decode
    reintroduces the ``<`` that the next pass would have removed. So the loop is bounded by
    :data:`_TITLE_SANITISE_PASSES` and **fails closed** when it exhausts that bound without
    converging, and the returned value is additionally proved tag-free by one further strip that
    must change nothing. Convergence itself is guaranteed rather than hoped for - each decode
    strictly shortens the value while any character reference remains - and the bound is far above
    the deepest nesting a 120-character title can carry, so no legitimate title is ever refused
    by exhaustion.

    Verified by execution on the pinned bleach 6.4.0: markup is removed
    (``<script>``/``<b>`` leave their text, ``<img>``/``<svg>``/``<iframe>`` leave nothing), while
    ``&``, ``<`` and ``>`` used as prose, ``C++``, ``C#``, an em dash, CJK text, emoji, quotes and
    apostrophes all survive byte for byte.

    Args:
        raw: The submitted title, already trimmed and length-bounded by
            ``app.schemas.post.PostTitle``. Not offloaded to a worker thread as the body is: a
            title is at most 120 characters, so the parse is bounded by the schema rather than by
            the scheduler.

    Returns:
        The title as plain text, trimmed, with every element removed and no character reference
        left behind.

    Raises:
        AppValidationError: If nothing survives - a title that was only markup, such as
            ``<img src=x>``. ``posts.title`` is ``NOT NULL`` and the schema requires at least one
            character, so there is no value left to store, and the honest answer is the same one
            ``app.services.comment_service`` gives a body that sanitises to nothing: a ``422``
            naming the member, rather than a title silently replaced by something the author did
            not write. Also if the value does not reach a fixed point within
            :data:`_TITLE_SANITISE_PASSES` passes, or if the converged value still carries markup -
            both fail closed, because storing a title this function cannot prove is plain text is
            the one outcome it exists to prevent.
    """
    current = raw
    converged = False
    for _ in range(_TITLE_SANITISE_PASSES):
        candidate = _strip_and_decode(current)
        if candidate == current:
            converged = True
            break
        current = candidate

    if not current:
        raise AppValidationError(
            _TITLE_EMPTY_AFTER_SANITISATION,
            errors=[
                FieldError(
                    field=_FIELD_TITLE,
                    message="Write the title as plain text; the markup submitted was removed.",
                    type=_FIELD_ERROR_TYPE,
                )
            ],
        )

    # The final guarantee, asserted rather than assumed, and in two parts because they can fail
    # independently. `converged` says the loop reached a fixed point instead of running out of
    # passes; the second test re-runs one pass on the value about to be returned and requires it to
    # change nothing, which is what proves the value carries no element and no character reference
    # that would decode into one. A value that fails either is refused, never trimmed and stored:
    # the alternative is a title the author did not write, or markup in the field every consumer of
    # this API is told is a plain-text label.
    if not converged or _strip_and_decode(current) != current:
        raise AppValidationError(
            _TITLE_MARKUP_SURVIVED,
            errors=[
                FieldError(
                    field=_FIELD_TITLE,
                    message=(
                        "Write the title as plain text. Deeply nested character references "
                        "cannot be reduced to a stable value, so the title was not stored."
                    ),
                    type=_FIELD_ERROR_TYPE,
                )
            ],
        )
    return current


def _omit_blank(value: str | None) -> str | None:
    """Fold a whitespace-only filter argument to ``None``, so it narrows nothing.

    A query string carries ``?category=`` as the empty string rather than as an absent
    parameter, and an empty category slug matches no category - which would silently return an
    empty feed for what the caller meant as "no filter". Restated privately here rather than
    imported from ``app.schemas``, which folds blanks for its own nullable columns; each module
    answers for its own boundary.

    Args:
        value: A raw filter argument.

    Returns:
        ``None`` when ``value`` is absent or has no non-whitespace character; ``value``
        unchanged otherwise.
    """
    if value is None or not value.strip():
        return None
    return value


def _utc_now() -> datetime:
    """Return the current instant as a timezone-aware UTC value.

    ``posts.published_at`` is ``TIMESTAMPTZ``, so a naive value would be interpreted against
    the connection's time zone and would make the publication instant depend on where the
    process happens to run. Named rather than inlined so that the one instant the lifecycle
    records is produced in one place.

    Returns:
        ``datetime.now(UTC)`` - aware, and in UTC.
    """
    return datetime.now(UTC)


def _default_sort_for(q: str | None) -> PostSort:
    """Choose the ordering a caller who named none should get.

    A search is a request to be shown the best match, and a browse is a request to be shown
    the newest thing, so the default follows the presence of a term. An explicit ``sort``
    argument always wins over this; the ranking itself belongs to
    ``app.repositories.post_repository`` and is not reimplemented here.

    **This is reachable only because the route lets ``sort`` be absent.**
    ``app.api.v1.routers.posts`` declares the parameter as ``PostSortOption | None = None`` and
    forwards it unchanged for exactly that reason: a route-level default would substitute a value
    before this function was consulted, and every search that named no ordering would then be
    answered by recency - the ranked query composed by the repository would never run.

    Args:
        q: The caller's search term, or ``None``. Whitespace alone counts as absent, through
            :func:`_omit_blank`, so a blank search box browses rather than searching.

    Returns:
        ``"relevance"`` when a term is present, and :data:`DEFAULT_POST_SORT_OPTION` - the wire
        contract's own browse default, imported rather than restated - otherwise.
    """
    return DEFAULT_POST_SORT_OPTION if _omit_blank(q) is None else "relevance"


# ---------------------------------------------------------------------------------------
# The draft-confidentiality rule
#
# Declared ONCE, here, in two pure functions - one for listings and one for a single
# resource. `app.services.comment_service` and `app.services.like_service` IMPORT them and
# must not restate the comparison: a rule repeated per call site drifts, which is exactly
# what the three byte-identical `HTTPException(404, "Item not found")` raises in the retired
# module demonstrated.
#
# Both are synchronous, pure and free of any session, request or ORM I/O, so
# `backend/tests/unit/test_permissions.py` exercises them against plainly constructed objects
# with no database and no HTTP client in the picture.
# ---------------------------------------------------------------------------------------


def visible_statuses_for(
    viewer: User | None,
    author_id: uuid.UUID | None = None,
) -> tuple[PostStatus, ...]:
    """Report which lifecycle states a listing may include for this viewer.

    The value passed as ``statuses`` to ``PostRepository.list_posts`` for an **author-scoped**
    listing. The repository takes the states as an argument and decides nothing; this is where
    the decision is made.

    It is deliberately *not* consulted by the public feed. ``PostService.list_feed`` passes
    :data:`PUBLIC_POST_STATUSES` unconditionally in its default mode, because a listing whose
    scope depended on who was asking would give two callers different ``total`` values and
    different page boundaries for one URL, and would put a draft in a category-filtered result
    for a privileged reader - both of which AAP §0.9.4.4 forbids. This predicate serves the
    listings that *are* scoped to one author: the private workspace mode of the feed, and the
    profile listing, which passes a viewer of ``None``.

    Args:
        viewer: The resolved principal, or ``None`` for an anonymous caller.
        author_id: The author whose posts are being listed, when the listing is scoped to one
            author - a profile page, an author's own workspace, or the feed filtered by
            ``?author=``. ``None`` for an unscoped listing such as the home feed, where no
            single author's drafts could be in scope.

    Returns:
        :data:`ALL_POST_STATUSES` when the viewer is an administrator, or when the viewer is
        the very author being listed; :data:`PUBLIC_POST_STATUSES` for everyone else,
        including an authenticated reader browsing someone else's work.

    Note:
        **A viewer that is not ``None`` is an ACTIVE account**, guaranteed by
        ``app.core.dependencies.get_current_user_optional``, which resolves a deactivated
        account as anonymous rather than as a principal. So this predicate does not test
        ``is_active`` and must not start to: the widening below would otherwise have to
        remember the check, as would ``can_view_post`` and ``_visible_comment_statuses``, and a
        suspended author would keep reading their own drafts through whichever of the three
        forgot.

        This predicate is never reached from the public feed at all, so no caller of that
        surface - administrator included - can be shown an unpublished post through it. An
        author's unpublished work belongs on their workspace, which asks for it explicitly
        (``own=True``) and is scoped to the principal's own ``author_id``.

    Examples:
        >>> visible_statuses_for(None) == (PostStatus.PUBLISHED,)
        True
    """
    if viewer is None:
        return PUBLIC_POST_STATUSES
    if is_admin(viewer):
        return ALL_POST_STATUSES
    # Scoped to this viewer's own posts: they may see every state of their own work.
    if author_id is not None and viewer.id == author_id:
        return ALL_POST_STATUSES
    return PUBLIC_POST_STATUSES


def can_view_post(post: Post, viewer: User | None) -> bool:
    """Report whether this viewer may read this single post.

    The single-resource counterpart to :func:`visible_statuses_for`, and the predicate
    ``comment_service`` and ``like_service`` call before they let a caller read or write
    anything hanging off a post - a comment thread on an invisible draft has to be invisible
    too.

    Args:
        post: The post in question. Only its own columns are read.
        viewer: The resolved principal, or ``None`` for an anonymous caller.

    Returns:
        ``True`` when the post is ``PUBLISHED``, when the viewer wrote it, or when the viewer
        is an administrator; ``False`` otherwise - which covers an anonymous caller reading a
        draft and an authenticated reader reading someone else's draft or archived post.

    Note:
        **A viewer that is not ``None`` is an ACTIVE account** - see the note on
        :func:`visible_statuses_for`. Deactivation is enforced once, in the resolver, so a
        suspended author reaches this predicate as an anonymous caller and is refused their own
        draft.

        The ownership test reads ``post.author_id``, a mapped column that is always present,
        and never ``post.author``, a relationship that is unloaded on anything
        ``PostRepository.get_for_update`` returns. Touching an unloaded relationship under an
        ``AsyncSession`` raises ``MissingGreenlet``, so a predicate that reached for the entity
        would be a synchronous function that fails at runtime depending on how its argument was
        fetched.
    """
    if post.status is PostStatus.PUBLISHED:
        return True
    if viewer is None:
        return False
    return viewer.id == post.author_id or is_admin(viewer)


class PostService:
    """Every business rule the post lifecycle and the feed need, and no query and no route.

    Constructed per request from the session ``app.core.dependencies.get_db`` yields, and in the
    suite from the transactional fixture::

        service = PostService(session)
        feed = await service.list_feed(page=1, page_size=12, q="fastapi", viewer=None)
        draft = await service.create(payload, author=principal)
        live = await service.publish(draft.id, actor=principal)

    Read methods take a ``viewer`` - the resolved principal or ``None`` - because what a caller
    may *see* depends on who they are. Mutating methods take an ``actor``, which is never
    optional, because an anonymous caller cannot reach them at all: the router's dependency has
    already answered ``401`` by then, and this layer answers the question that dependency
    cannot, which is whether *this* principal may act on *this* row.

    Ordering of the two failure modes is fixed and is a confidentiality property rather than a
    style: a resource that does not exist is reported before authority is considered, and a
    resource the caller has no authority to know about is reported the same way as one that is
    missing. Answering ``403`` in the second case would let an unauthorised caller enumerate
    identifiers by reading status codes.
    """

    __slots__ = ("_categories", "_posts", "_session", "_users")

    def __init__(self, session: AsyncSession) -> None:
        """Bind the service to one request's session and its repositories.

        Args:
            session: The live session ``get_db`` yielded. It is **injected, never created**
                here: this module does not import ``app.db.session``, so a service cannot open
                a connection of its own, and every repository below shares the one session so
                a multi-step use case stays a single transaction.

        Note:
            Three repositories, and each is needed for a distinct reason.
            ``PostRepository`` owns the relation. ``CategoryRepository`` resolves the
            identifiers a caller files a post under - a lookup belongs to a repository, so this
            module does not call ``category_service`` to perform one. ``UserRepository``
            resolves the username the feed's ``?author=`` filter carries into the identifier the
            query needs.
        """
        self._session = session
        self._posts = PostRepository(session)
        self._categories = CategoryRepository(session)
        self._users = UserRepository(session)

    # -----------------------------------------------------------------------------------
    # Reads
    # -----------------------------------------------------------------------------------

    async def list_feed(
        self,
        *,
        page: int,
        page_size: int,
        q: str | None = None,
        category_slug: str | None = None,
        author_username: str | None = None,
        sort: PostSort | None = None,
        viewer: User | None = None,
        own: bool = False,
        status: PostStatus | None = None,
    ) -> Page[PostSummary]:
        """List posts for ``GET /api/v1/posts``: search, filter, order and window, in one query.

        The service half of R3. Every argument narrows the result independently, so the home
        feed, a category-filtered view and an author-filtered view are the same call with
        different arguments - which is what keeps one pagination control correct for all of
        them and keeps the index usage of all of them identical.

        **The public feed is PUBLISHED-only for every caller, without exception.** Not "for
        anonymous callers", not "unless the viewer is an administrator", and not "unless the
        viewer happens to be filtering by their own username: every caller of the public mode
        sees the same rows, the same ``total`` and the same page boundaries. That is what makes
        the feed a shared, cacheable, crawlable surface, and it is the confidentiality rule
        AAP §0.9.4.4 states - a draft never appears in the public feed, in a category-filtered
        result or on a public profile. A feed that silently widened for a privileged reader
        would also make ``total`` and ``pages`` differ per caller on a surface whose page
        boundaries clients share.

        **An author reads their own unpublished work by asking for it.** ``own=True`` is the
        private author-workspace mode: it requires a resolved principal, scopes the listing to
        that principal's own posts, and admits every lifecycle state. The widening is therefore
        *requested* rather than *inferred from identity*, which is the whole difference - a
        caller who did not ask can never be shown a draft, and a caller who did ask can only
        ever be shown their own. ``status`` narrows that mode to one state, which is how the
        author workspace groups by lifecycle without paging through the other two.

        Args:
            page: The 1-based page requested. A page beyond the last is not an error - it
                returns an empty ``items`` list beside the real ``total`` and ``pages``, which
                is how a client detects it has run off the end.
            page_size: Rows per page, as bounded by ``PageParams`` at the route boundary.
            q: Free-text search term, or ``None``. Whitespace-only is equivalent to absent.
            category_slug: The ``?category=`` slug to filter by. Matched case-insensitively by
                the ``citext`` column; an empty string is treated as absent.
            author_username: The ``?author=`` username to filter by. Resolved to an identifier
                here, because the wire speaks usernames and the query speaks identifiers.
            sort: ``"recent"`` or ``"relevance"``, or ``None`` to accept the default for the
                request - see :func:`_default_sort_for`.
            viewer: The resolved principal, or ``None`` for an anonymous caller. Read **only** by
                the ``own`` mode below; it decides nothing at all about the public feed, which is
                the same for everybody.
            own: Whether this is the private author-workspace listing rather than the public
                feed. ``True`` scopes the result to ``viewer``'s own posts and admits every
                lifecycle state; ``False`` - the default, and every anonymous or ordinary read -
                answers published posts only.
            status: A single lifecycle state to narrow to. Accepted only in the ``own`` mode,
                because narrowing the public feed by state is either a no-op (``PUBLISHED``) or a
                request for somebody else's unpublished work.

        Returns:
            A :class:`~app.core.pagination.Page` of :class:`~app.schemas.post.PostSummary`,
            carrying ``items``, ``total``, ``page``, ``page_size`` and ``pages``. The summary
            projection deliberately omits the body, so a feed page stays small however long the
            articles are.

        Raises:
            NotFoundError: ``author_username`` names no account. Reported rather than silently
                answered with an empty page, so a mistyped filter is distinguishable from an
                author who has published nothing.
            ValueError: ``own=True`` with no ``viewer``, or ``status`` outside the ``own`` mode.
                Both are defects in a caller rather than caller-supplied conditions - the route
                refuses each with a documented status before it gets here - so they fail loudly
                instead of silently downgrading to a public read, which is the failure mode that
                would leak.

        Note:
            **One composed statement, plus its one count.** The repository is asked exactly
            once and the rows it returns already carry ``author`` and ``categories``, narrowed to
            the columns ``PostSummary`` serialises, so projecting them issues no follow-up query.
            A member missing from that projection does not degrade quietly: reading a deferred
            column under an async session raises ``MissingGreenlet``, so the profile is enforced by
            the runtime rather than by review. If a member of ``PostSummary`` were ever
            missing here that would be a column to add to the repository's projection, and
            never a reason to iterate.

            The state scope is decided here and nowhere else on this path. The public mode passes
            :data:`PUBLIC_POST_STATUSES` unconditionally; the ``own`` mode passes the states
            :func:`visible_statuses_for` reports for a viewer reading their own work, which is the
            single declaration of the draft rule that ``comment_service`` and ``like_service``
            import rather than restate.
        """
        if own and viewer is None:
            message = (
                "list_feed(own=True) needs a resolved principal: the private workspace listing "
                "is scoped to the caller's own posts, so there is nobody to scope it to."
            )
            raise ValueError(message)
        if status is not None and not own:
            message = (
                "list_feed(status=...) is accepted only with own=True. The public feed is "
                "PUBLISHED-only for every caller, so narrowing it by lifecycle state is either "
                "a no-op or a request for another author's unpublished work."
            )
            raise ValueError(message)

        author = await self._resolve_author(author_username)
        author_id = None if author is None else author.id

        # `own and viewer is None` was refused above, so `own` implies a resolved principal and
        # this condition is exactly `own` - written with the null test first so the narrowing is
        # visible to a reader and to the type checker without an `assert` that `-O` would strip.
        if viewer is not None and own:
            # The scope is the principal's own identifier rather than whatever `?author=` carried,
            # so this mode cannot be pointed at somebody else's drafts by adding a parameter.
            author_id = viewer.id
            statuses = visible_statuses_for(viewer, author_id) if status is None else (status,)
        else:
            # Unconditional, and deliberately not `visible_statuses_for`: the public feed asks
            # nobody who is calling. See the paragraph in this method's docstring.
            statuses = PUBLIC_POST_STATUSES

        # The window arithmetic has exactly one definition, in `PageParams`. Recomputing
        # `(page - 1) * page_size` inline is one off-by-one away from a feed that skips or
        # repeats a row at every page boundary, so the value is taken from there instead. The
        # bounds on the two fields are FastAPI query metadata and are inert in plain Python, so
        # an out-of-range page still passes through to be answered with an empty page.
        window = PageParams(page=page, page_size=page_size)

        rows, total = await self._posts.list_posts(
            q=_omit_blank(q),
            category_slug=_omit_blank(category_slug),
            author_id=author_id,
            statuses=statuses,
            sort=_default_sort_for(q) if sort is None else sort,
            # The compact projection, named explicitly rather than inherited from the
            # repository's default: this listing serialises `PostSummary`, which carries neither
            # `content` nor any private `users` column, so the statement is told to fetch neither.
            # A feed page under the wide profile moved every article body it then discarded.
            projection="summary",
            limit=window.limit,
            offset=window.offset,
        )

        items = [PostSummary.model_validate(row) for row in rows]
        return build_page(items, total, window.page, window.page_size)

    async def get_by_slug(self, slug: str, *, viewer: User | None) -> Post:
        """Resolve one post by its canonical slug, applying the draft rule.

        Serves ``GET /api/v1/posts/{slug}`` and the client's ``/blog/[slug]`` page. The entity
        is returned with ``author`` and ``categories`` loaded, so the router projects it into
        :class:`~app.schemas.post.PostDetail` without a further query.

        Args:
            slug: The slug from the URL. ``posts.slug`` is ``citext``, so the match is
                case-insensitive at the database level and nothing is lower-cased here.
            viewer: The resolved principal, or ``None`` for an anonymous caller.

        Returns:
            The post, with both relationships loaded.

        Raises:
            NotFoundError: No post carries that slug, **or** the post is not published and the
                caller is neither its author nor an administrator.

        Note:
            Those two cases raise the same error with the same detail, and that identity is the
            point. A ``ForbiddenError`` for the second would confirm that the slug exists, which
            is precisely the fact an unpublished post is entitled to keep - an author's
            in-progress title is guessable, and a 403/404 split would let anyone map the drafts
            on the site by reading status codes. ``app.core.exceptions.NotFoundError`` documents
            the same rule from the other side.

            ``posts.view_count`` is deliberately **not** advanced here, and its absence is a
            decision rather than an omission. Advancing it correctly means a single atomic
            ``UPDATE ... SET view_count = view_count + 1``; the repository layer, which owns
            every statement in this service tier, exposes no such method, and writing the
            statement here would put SQL in the layer that must not contain any. A
            read-modify-write in Python would additionally lose counts under concurrency and
            would turn every article read into a write transaction. The column therefore holds
            what it was seeded with, exactly as ``app.schemas.post.PostSummary`` documents, and
            wiring a counter is a repository method plus a call from here.
        """
        post = await self._posts.get_by_slug(slug, with_relations=True)
        if post is None:
            raise NotFoundError(_POST_NOT_FOUND)
        if not can_view_post(post, viewer):
            raise NotFoundError(_POST_NOT_FOUND)
        return post

    # -----------------------------------------------------------------------------------
    # Private resolution helpers
    # -----------------------------------------------------------------------------------

    async def _resolve_author(self, username: str | None) -> User | None:
        """Resolve the feed's ``?author=`` username to an account.

        Args:
            username: The username filter, or ``None``. Whitespace-only is treated as absent,
                because a query string spells an unset parameter as the empty string.

        Returns:
            The account, or ``None`` when no author filter was requested.

        Raises:
            NotFoundError: The username names no account.
        """
        normalised = _omit_blank(username)
        if normalised is None:
            return None
        author = await self._users.get_by_username(normalised)
        if author is None:
            raise NotFoundError(_AUTHOR_NOT_FOUND)
        return author

    async def _resolve_categories(self, category_ids: Sequence[uuid.UUID]) -> list[Category]:
        """Turn the identifiers a caller supplied into the rows the association needs.

        Args:
            category_ids: The identifiers from ``PostCreate`` or ``PostUpdate``, already bounded
                to ten by the schema. Order carries no meaning and repeats are collapsed.

        Returns:
            The matching categories, de-duplicated, in the order they were first named. Empty
            for an empty input, which files the post under nothing.

        Raises:
            NotFoundError: At least one identifier names no category. ``404`` is the status the
                published schema promises for this case, so it is reported as a domain
                not-found rather than as a validation failure - and every bad identifier is
                named, so a client fixes one request instead of bisecting a list. Naming them
                discloses nothing: they are the caller's own input, and ``GET
                /api/v1/categories`` lists the whole taxonomy publicly.

        Note:
            **Duplicates are collapsed before anything is written.** ``post_categories`` is
            keyed ``(post_id, category_id)``, so filing the same category twice would raise an
            integrity error from the driver on a request the schema had already accepted - the
            schema records that this service owns the collapse.

            One round trip, whatever the identifier count: the taxonomy is fetched once with
            ``list_all`` and indexed in memory, rather than probed once per identifier. That is
            sound because the taxonomy is bounded by editorial effort, which is the same reason
            ``list_all`` is unpaginated.
        """
        if not category_ids:
            return []

        # `dict.fromkeys` de-duplicates while preserving first-seen order, which keeps the
        # association deterministic for a given request and therefore keeps tests stable.
        wanted = list(dict.fromkeys(category_ids))

        known = {category.id: category for category in await self._categories.list_all()}
        missing = [str(category_id) for category_id in wanted if category_id not in known]
        if missing:
            raise NotFoundError(f"No category exists with id: {', '.join(sorted(missing))}")

        return [known[category_id] for category_id in wanted]

    async def _get_for_update(
        self, post_id: uuid.UUID, *, actor: User, with_relations: bool = True
    ) -> Post:
        """Lock one post for writing and confirm the actor may write it.

        The shared preamble of :meth:`update`, :meth:`delete`, :meth:`publish` and
        :meth:`unpublish`, so the three failure modes are ordered identically on all four paths
        and the ordering is stated once. Writing it per method is how four copies of one rule
        drift apart - and how one of them ends up answering ``403`` for a row that does not
        exist.

        Args:
            post_id: The post's server-generated identifier, from the URL path.
            actor: The resolved principal attempting the mutation.
            with_relations: Whether the repository should eager-load ``author`` and
                ``categories`` alongside the locked row. ``True`` by default because three of
                the four callers render the post afterwards, and :meth:`update` additionally
                needs the existing ``categories`` collection loaded before it can assign a
                replacement. :meth:`delete` passes ``False``: it answers ``204`` with no body,
                so a byline it will not render is a statement with no consumer.

        Returns:
            The locked post, with ``author`` and ``categories`` loaded unless
            ``with_relations`` was ``False``. The loading is the repository's - no relationship
            is ever reached for from this module.

        Raises:
            ForbiddenError: The actor holds ``READER``, or holds ``AUTHOR`` and did not write
                this post. Both are raised by the predicates in
                ``app.core.dependencies`` - ``ensure_can_author`` for the role and
                ``ensure_can_modify`` for the ownership - which are the one definition of each
                comparison; this module does not restate either.
            NotFoundError: No post carries that identifier.

        Note:
            **Three checks, in this order, and the order is the interesting part.** The role
            check runs first because it depends on nothing but the principal, so a ``READER``
            is refused without a row being read or a lock being taken - and the refusal is
            identical for every identifier, so it separates no post from any other. The lock
            comes next, then the ownership check.

            ``SELECT ... FOR UPDATE`` is taken before the ownership check rather than after, so
            two requests that both read a draft and both decide to publish it cannot interleave
            between the read and the write: the second blocks until the first's transaction
            ends and then observes its outcome. The lock is released by the commit each caller
            performs.

            Not-found is resolved before ownership, and for an unpublished post that ordering
            is also what keeps its existence private: a caller who may not modify a draft
            learns nothing here that a caller who may not *see* it would not already have
            learned from :meth:`get_by_slug`.
        """
        # The role gate, before anything is read. `AUTHOR` or `ADMIN`; a demoted account is
        # refused here, which is what makes the demotion an administrator performs effective.
        ensure_can_author(actor)

        post = await self._posts.get_for_update(post_id, with_relations=with_relations)
        if post is None:
            raise NotFoundError(_POST_NOT_FOUND)
        # Only ownership remains: the role gate above already refused a READER before a row was
        # read, and nothing between the two can have changed the principal - `actor` is the
        # resolved request principal, not a row this method re-fetched. Repeating
        # `ensure_can_author(actor)` here asked the same question of the same object twice.
        ensure_can_modify(actor, post.author_id)
        return post

    async def _derive_slug(self, title: str) -> str:
        """Derive a unique slug for ``title`` from the slugs already taken.

        Args:
            title: The post's title.

        Returns:
            A slug absent from the database at the moment it was read: the slugified stem when
            that is free, or the stem with the lowest free ``-2``, ``-3``, … suffix.

        Note:
            The stem is asked for first so the "taken" query can be anchored to that one slug
            family, which is what bounds the lookup to a handful of rows instead of the whole
            relation. Resolving the collision before the ``INSERT`` is what makes a second post
            with the same title succeed with a suffixed slug rather than fail on the unique
            index; the index remains the backstop for the narrow race between reading the set
            and inserting, which :meth:`create` **retries** rather than reports - see
            :data:`SLUG_ALLOCATION_ATTEMPTS`. That is also why this method is called from inside
            that retry loop rather than once above it: a retry that reused the slug the losing
            attempt derived would collide again on every attempt.
        """
        stem = slugify_title(title)
        return unique_slug(stem, await self._posts.slugs_starting_with(stem))

    # -----------------------------------------------------------------------------------
    # Writes
    # -----------------------------------------------------------------------------------

    async def create(self, payload: PostCreate, *, author: User) -> Post:
        """Create a draft for ``POST /api/v1/posts``.

        Args:
            payload: The validated request body. It carries what a human decides - title,
                excerpt, body, cover image and categories - and cannot carry anything else:
                ``extra="forbid"`` refuses ``id``, ``slug``, ``status``, ``published_at``,
                ``view_count`` and ``author_id``, every one of which is produced below or by the
                database.
            author: The resolved principal. The post's ``author_id`` is taken from **here** and
                could not have come from the body.

        Returns:
            The persisted post, with ``author`` and ``categories`` loaded, in state ``DRAFT``
            with ``published_at`` unset.

        Raises:
            ForbiddenError: The principal holds ``READER``. Raised by ``ensure_can_author``.
            NotFoundError: A supplied category identifier names no category.
            AppValidationError: The title was nothing but markup, so sanitising it left no text to
                store, or it could not be reduced to a stable plain-text value. Reported as a
                ``422`` naming ``title``.
            ConflictError: A category this post was being filed under changed underneath the
                insert, or the derived slug was claimed by another writer on every one of
                :data:`SLUG_ALLOCATION_ATTEMPTS` attempts. A **single** lost slug race is not a
                conflict - it is retried, because the route publishes collision suffixing as a
                promise and the loser of a race is a perfectly valid request. See the note.

        Note:
            **A created post is always a draft, and there is no argument that changes that.**
            It is therefore absent from the public feed until ``POST /api/v1/posts/{id}/publish``
            runs, which is what stops an author publishing by accident and what keeps the
            publication instant and the lifecycle state written together.

            **``AUTHOR`` or ``ADMIN`` is required, and authorship is not granted by writing.**
            A self-registered account already holds ``AUTHOR`` - ``app.services.auth_service``
            assigns it at registration - so this gate costs a new reader nothing and the
            authoring screens work the moment an account exists. What it does cost is the one
            case it exists for: an account an administrator has demoted to ``READER`` through
            ``PATCH /api/v1/admin/users/{id}``, or a reader account created by
            ``app.db.seed``, cannot write. Promoting such an account here instead - "a reader
            who writes their first post becomes an author" - would make the demotion revoke
            nothing at all, because the very next write would hand the role straight back.

            **All three text members are sanitised before anything is stored** - the Markdown
            body against the element allow-list, the excerpt and the title down to plain text.
            The client sanitises again where it renders, and this half is not skipped on the
            strength of that: the row has to be safe for every consumer of the API, not only for
            the one client in this repository. The title is cleaned *before* the slug is derived
            from it, so the canonical URL is built from the stored text rather than from markup.

            **A lost slug race is retried, not reported.** Slug allocation reads the taken members
            of a family and picks the first free suffix, so a concurrent create of the same title
            can take that suffix in the window before this insert. The route promises
            de-duplication - ``python``, ``python-2``, ``python-3`` - so refusing the loser would
            break the contract for a request that is entirely valid. The loser re-reads the family,
            sees the row that won, and takes the next suffix; only sustained contention across
            :data:`SLUG_ALLOCATION_ATTEMPTS` attempts produces the documented ``409``. A
            category-filing race is *not* retried, because re-attempting the same filing against a
            taxonomy that has changed underneath cannot succeed.

            ``search_vector`` is never assigned. It is a generated column, so committing this
            insert is what derives it - there is no trigger to fire and no index to maintain.
        """
        # The role gate, first and before any read: authoring is an authority this principal
        # either holds or does not, and it does not depend on anything in the payload.
        ensure_can_author(author)

        # Resolved before the row is built so that a bad identifier fails the request before any
        # slug is reserved or any INSERT is attempted.
        categories = await self._resolve_categories(payload.category_ids)

        # Sanitised on a bounded worker thread rather than on this one. Parsing untrusted markup
        # costs time in proportion to its length, and `PostContent` admits up to 100 000
        # characters, so a single large submission would otherwise stall every other request this
        # worker is serving for the duration. Hoisted out of the constructor below because it is
        # awaited; the values are what the entity is built from.
        content = await run_cpu_bound(_sanitize_content, payload.content)
        excerpt = (
            None
            if payload.excerpt is None
            else await run_cpu_bound(_sanitize_excerpt, payload.excerpt)
        )
        # Sanitised on this thread, unlike the two above: a title is bounded at 120 characters by
        # the schema, so the parse cannot be made expensive by the caller and an offload would cost
        # a thread hop for nothing. Cleaned BEFORE the slug is derived, so the canonical URL is
        # built from the text that will actually be stored rather than from markup the author sent.
        title = _sanitize_title(payload.title)

        # Read ONCE, before the loop, and used everywhere below in place of `author.id`. This is
        # not a micro-optimisation: `session.rollback()` expires every instance the session holds,
        # including the principal `get_current_user` loaded, and touching an expired attribute
        # afterwards makes the ORM issue a refresh from inside synchronous attribute access - which
        # under an async session raises `MissingGreenlet` and answers 500. So nothing in this method
        # reads an ORM attribute after the first attempt; the identifier is a plain UUID and cannot
        # expire.
        author_id = author.id

        # One attempt per iteration, and every step that depends on database state is INSIDE the
        # loop. A retry after a lost slug race has to re-derive the slug - that is the whole point -
        # and it has to re-resolve the categories too, for the expiry reason above: the rollback
        # detached every `Category` the aborted transaction had loaded, and a detached instance
        # cannot be filed against a new post. What is deliberately outside the loop is the
        # sanitisation: it is pure CPU over the payload, its result cannot change between attempts,
        # and re-parsing a 100 000-character body per retry would turn contention into a denial of
        # service.
        for attempt in range(SLUG_ALLOCATION_ATTEMPTS):
            filed_under = (
                categories if attempt == 0 else await self._resolve_categories(payload.category_ids)
            )
            post = Post(
                author_id=author_id,
                title=title,
                slug=await self._derive_slug(title),
                excerpt=excerpt,
                content=content,
                # `HttpUrl` validated the scheme and the host; the column is text, and the schema
                # names `str(value)` as the coercion this layer owes it.
                cover_image_url=(
                    None if payload.cover_image_url is None else str(payload.cover_image_url)
                ),
                # Stated explicitly rather than left to the column's server default, so that the
                # one lifecycle guarantee this method makes is visible in this method.
                status=PostStatus.DRAFT,
                published_at=None,
                categories=filed_under,
            )

            try:
                # Insert, flush, and load the byline and badges the response needs - all inside
                # the transaction, so the COMMIT below is the last database action this request
                # takes. The ordering is the point: a load issued after the commit could fail on a
                # post that is already durable, and the client would then see an error for a post
                # that exists.
                persisted = await self._posts.add_with_relations(post)
                await self._session.commit()
            except IntegrityError as error:
                # Rolled back FIRST and unconditionally - the transaction is aborted either way,
                # so anything else issued on this session would fail too - and only then is the
                # failure classified.
                await self._session.rollback()

                # The slug race, and the only failure this loop retries. `_derive_slug` reads the
                # taken members of the family and picks the first free suffix, so a concurrent
                # create of the same title can take that suffix in between. The route publishes
                # de-duplication as a PROMISE - `python`, `python-2`, `python-3` - so answering the
                # loser a 409 would break the contract for a request that is entirely valid. The
                # retry re-reads the family, sees the row that won, and takes the next suffix.
                if _is_slug_race(error) and attempt + 1 < SLUG_ALLOCATION_ATTEMPTS:
                    continue

                # Everything else. `_conflict_detail` recognises the exhausted slug race and the
                # two category-filing races and nothing else: a check violation, a dangling author
                # or a missing required column is re-raised untouched, so a defect in this service
                # surfaces as one instead of being reported to the author as somebody else's title.
                # A category-filing race is deliberately NOT retried - re-attempting the same
                # filing against a taxonomy that has changed underneath would loop on a request
                # that cannot succeed, so the caller is told to reload.
                detail = _conflict_detail(error)
                if detail is None:
                    raise
                raise ConflictError(detail) from error
            else:
                categories = filed_under
                break

        get_logger(__name__).info(
            "post created",
            post_id=str(persisted.id),
            slug=log_safe_text(persisted.slug),
            # The hoisted value, for the expiry reason recorded above the loop.
            author_id=str(author_id),
            category_count=len(categories),
        )
        return persisted

    async def update(self, post_id: uuid.UUID, payload: PostUpdate, *, actor: User) -> Post:
        """Apply a partial update for ``PATCH /api/v1/posts/{id}``.

        A genuine partial update: an omitted member is left exactly as it is. That is the
        difference from the whole-object ``PUT`` this replaces, which assigned the submitted
        object over the stored one and so let a client holding a stale copy silently revert
        every field it had not refreshed.

        Args:
            post_id: The post's identifier, from the URL path.
            payload: The members that are changing. ``title``, ``content`` and ``category_ids``
                refuse an explicit null; ``excerpt`` and ``cover_image_url`` accept one, and it
                means "clear this".
            actor: The resolved principal. Must hold ``AUTHOR`` or ``ADMIN``, and must own
                the post unless it holds ``ADMIN``.

        Returns:
            The updated post, with ``author`` and ``categories`` loaded.

        Raises:
            NotFoundError: No post carries that identifier, or a supplied category identifier
                names no category.
            ForbiddenError: The actor holds ``READER``, or holds ``AUTHOR`` and did not
                write this post.
            AppValidationError: A submitted title was nothing but markup, so sanitising it left no
                text to store - the same rule creation applies, so a title this method accepts is
                one ``create`` would have accepted too.

        Note:
            **The slug is not re-derived, and that is a guarantee rather than an omission.** A
            post may be retitled; its address may not move. The slug is in every published
            link, every sitemap entry and every canonical tag already emitted, so recomputing it
            from a new title would break links that are indexed and forfeit whatever they have
            earned. ``app.core.slug`` ships no helper that recomputes one and ``PostUpdate``
            exposes no member that could ask for it, so the invariant holds at three layers.

            **Neither ``status`` nor ``published_at`` can be reached from here.** Publishing is a
            transition, not a field, and the two transitions set the lifecycle state and the
            publication instant together - which is what keeps the database's publication
            ``CHECK`` satisfiable by construction. A patchable flag would let one half of that
            pair be written without the other, and the failure would surface as an integrity
            violation several layers from the request that caused it. ``PostUpdate`` declares
            neither member, so a request naming one is already a ``422`` before this method runs.

            **``category_ids`` replaces the association set; it does not add to it.** Omitted
            leaves the filings untouched, an empty list unfiles the post, and a populated list
            becomes exactly the post's categories.

            Retitling a published post needs no search-index step: ``search_vector`` is
            generated, so the commit below re-derives it and the new title is immediately
            findable.
        """
        post = await self._get_for_update(post_id, actor=actor)

        # Which members the caller actually sent. The values are then read from the typed model
        # attributes rather than from this dict, for two reasons: the dump types every value as
        # `Any`, and it renders `cover_image_url` as a `Url` object rather than as the string the
        # column takes. The dict is consulted only for the two members where `None` is a genuine
        # instruction and absence therefore has to be told apart from it.
        provided = payload.model_dump(exclude_unset=True)

        # `title` and `content` refuse an explicit null at the schema, so "is not None" and
        # "was sent" are the same condition for them - and this spelling is the one that narrows
        # the optional away for the type checker.
        if payload.title is not None:
            # Held to exactly the rule creation is held to, so a title refused by `create` cannot
            # be introduced by patching one that was accepted. The slug is deliberately NOT
            # re-derived from it - see this method's note on why a canonical URL does not move.
            post.title = _sanitize_title(payload.title)
        if payload.content is not None:
            # Off the event loop, for the reason `create` records. The row is held under
            # `FOR UPDATE` while this runs, which is the narrow cost of sanitising after the
            # authority check rather than before it: an unauthorised caller must not be able to
            # spend this worker's CPU, so the lock is taken first and held across the offload.
            # The lock is on one post, so the only request it can delay is another edit of that
            # same post.
            post.content = await run_cpu_bound(_sanitize_content, payload.content)

        if "excerpt" in provided:
            post.excerpt = (
                None
                if payload.excerpt is None
                else await run_cpu_bound(_sanitize_excerpt, payload.excerpt)
            )
        if "cover_image_url" in provided:
            post.cover_image_url = (
                None if payload.cover_image_url is None else str(payload.cover_image_url)
            )

        if payload.category_ids is not None:
            categories = await self._resolve_categories(payload.category_ids)
            # The current membership is already loaded - `_get_for_update` asked the repository
            # for it - which is what makes this assignment legal: SQLAlchemy computes the delta
            # against the existing collection, and assigning to an unloaded one under an async
            # session raises `MissingGreenlet`. The rows `post_categories` gains and loses are the
            # ORM's to emit; this module never writes to the association table itself.
            post.categories = categories

        # Flush the UPDATE and re-read the row with its relations, inside the transaction, so the
        # response is fully materialised before anything is made durable and the COMMIT below is
        # the last database action of the request.
        try:
            updated = await self._posts.save_with_relations(post)
        except IntegrityError as error:
            # The same classifier :meth:`create` uses, and it belongs here for a reason that is
            # easy to miss: this method never touches the slug, but it *does* rewrite
            # ``post_categories``, whose primary key is ``(post_id, category_id)``. The ORM
            # computes that association's delta from the membership it loaded, so a filing added
            # concurrently - or a category deleted after `_resolve_categories` confirmed it -
            # raises an integrity error on a request that was perfectly valid. Untranslated it
            # became a 500 describing a constraint; classified here it is either a recognised
            # conflict a retry resolves or a genuine defect re-raised as one, never the wrong one
            # of the two.
            await self._session.rollback()
            detail = _conflict_detail(error)
            if detail is None:
                raise
            raise ConflictError(detail) from error
        await self._session.commit()

        get_logger(__name__).info(
            "post updated",
            post_id=str(updated.id),
            slug=log_safe_text(updated.slug),
            actor_id=str(actor.id),
            changed=sorted(provided),
        )
        return updated

    async def delete(self, post_id: uuid.UUID, *, actor: User) -> None:
        """Delete a post for ``DELETE /api/v1/posts/{id}``.

        Args:
            post_id: The post's identifier, from the URL path.
            actor: The resolved principal. Must hold ``AUTHOR`` or ``ADMIN``, and must own
                the post unless it holds ``ADMIN``.

        Raises:
            NotFoundError: No post carries that identifier.
            ForbiddenError: The actor holds ``READER``, or holds ``AUTHOR`` and did not
                write this post.

        Note:
            **The post's comments, likes and category filings are not deleted here.** Every one
            of those foreign keys declares ``ON DELETE CASCADE``, so PostgreSQL removes them in
            the statement it issues for this row. Re-implementing that in Python would give one
            rule two definitions to keep in step, and the Python copy is the one that would
            drift - it would be the copy that forgets a relation added later.

            Deletion is final; ``ARCHIVED`` exists for a post that should stop being public
            without ceasing to exist, and :meth:`unpublish` for one that should return to
            drafting.
        """
        # `with_relations=False`: this path answers 204 with no body, so the byline and the
        # category badges have no consumer and the two batched loader statements would be work
        # with no output.
        post = await self._get_for_update(post_id, actor=actor, with_relations=False)

        # Captured before the row goes: the instance is deleted after the commit below, so
        # reading either attribute for the audit line afterwards would fail.
        deleted_id = str(post.id)
        deleted_slug = log_safe_text(post.slug)

        await self._posts.delete(post)
        await self._session.commit()

        get_logger(__name__).info(
            "post deleted",
            post_id=deleted_id,
            slug=deleted_slug,
            actor_id=str(actor.id),
        )

    async def publish(self, post_id: uuid.UUID, *, actor: User) -> Post:
        """Transition a post to ``PUBLISHED`` for ``POST /api/v1/posts/{id}/publish``.

        A first-class transition rather than a flag on a general update. It is the only way a
        post reaches the public feed, and it is the reason the publication instant and the
        lifecycle state cannot be written apart.

        Args:
            post_id: The post's identifier, from the URL path.
            actor: The resolved principal. Must hold ``AUTHOR`` or ``ADMIN``, and must own
                the post unless it holds ``ADMIN``.

        Returns:
            The published post, with ``author`` and ``categories`` loaded, its ``status`` set to
            ``PUBLISHED`` and its ``published_at`` guaranteed non-null.

        Raises:
            NotFoundError: No post carries that identifier.
            ForbiddenError: The actor holds ``READER``, or holds ``AUTHOR`` and did not
                write this post.

        Note:
            **Idempotent.** Publishing a post that is already published returns it unchanged
            rather than raising, so a double submission or a retried request cannot produce an
            error the author has no way to act on. Crucially it does **not** re-stamp
            ``published_at``: the default feed ordering is ``(status, published_at DESC)``, so
            re-stamping would silently move a months-old article to the top of the home page.

            **The publication instant is preserved wherever one already exists**, which also
            covers publishing an archived post: it returns to the feed carrying the date it
            first went public, because that is the date readers, sitemaps and structured data
            have already been given.

            **Both members of the database invariant are assigned, adjacently and
            unconditionally**, with ``published_at`` written first. The constraint
            ``CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL)`` therefore cannot be
            reached by this path even in principle - it is a backstop against a defect elsewhere,
            and a defect here would have to be a change to these two lines.
        """
        post = await self._get_for_update(post_id, actor=actor)

        if post.status is PostStatus.PUBLISHED:
            # Nothing to write. The commit is still issued, and deliberately: it ends the
            # transaction that holds this row's `FOR UPDATE` lock, which would otherwise be held
            # for the remainder of the request against a post nobody is changing. Nothing is read
            # after it - the locked fetch already returned the relations this response needs.
            await self._session.commit()
            return post

        # `posts.slug` is NOT NULL, so a persisted post always carries one and this branch is
        # defence in depth rather than an expected path: NOT NULL does not forbid the empty
        # string, and a post can only become public with an address a reader can use.
        if not post.slug:
            post.slug = await self._derive_slug(post.title)

        post.published_at = post.published_at if post.published_at is not None else _utc_now()
        post.status = PostStatus.PUBLISHED

        # Flush and re-read with relations inside the transaction; the COMMIT is then the last
        # database action, so a failure cannot leave a published post beside an error response.
        published = await self._posts.save_with_relations(post)
        await self._session.commit()

        # Narrowed for the type checker rather than asserted: the assignment above guarantees a
        # non-null instant, and `save_with_relations` re-read the row, so this cannot be None. The
        # audit line formats it, and a bare `.isoformat()` on an optional would not type-check.
        published_at = published.published_at
        get_logger(__name__).info(
            "post published",
            post_id=str(published.id),
            slug=log_safe_text(published.slug),
            actor_id=str(actor.id),
            published_at=None if published_at is None else published_at.isoformat(),
        )
        return published

    async def unpublish(self, post_id: uuid.UUID, *, actor: User) -> Post:
        """Return a post to ``DRAFT`` for ``POST /api/v1/posts/{id}/unpublish``.

        The inverse transition. It removes the post from the public feed, from category-filtered
        results and from its author's public profile immediately, because every one of those
        surfaces scopes itself with :func:`visible_statuses_for`.

        Args:
            post_id: The post's identifier, from the URL path.
            actor: The resolved principal. Must hold ``AUTHOR`` or ``ADMIN``, and must own
                the post unless it holds ``ADMIN``.

        Returns:
            The post, with ``author`` and ``categories`` loaded, its ``status`` set to ``DRAFT``.

        Raises:
            NotFoundError: No post carries that identifier.
            ForbiddenError: The actor holds ``READER``, or holds ``AUTHOR`` and did not
                write this post.

        Note:
            **``published_at`` is deliberately preserved, not cleared.** The column records when
            the post first became public, and ``status`` alone records whether it is public now,
            so the two answer different questions and clearing one to express the other would
            lose information the system has no way to recover. Three consequences follow, and
            all three are the intended behaviour: re-publishing keeps the original date, so the
            feed does not silently reorder; the author's workspace can still show when a
            withdrawn post was live; and the ``DRAFT`` state remains distinguishable from
            "never published", which is the only state where ``published_at`` is null. Clearing
            it would satisfy the publication ``CHECK`` just as well - the constraint only
            constrains the published state - so this is a choice about meaning, not about
            validity.

            **Idempotent**, for the same reason as :meth:`publish`: a post already in ``DRAFT``
            is returned unchanged.
        """
        post = await self._get_for_update(post_id, actor=actor)

        if post.status is PostStatus.DRAFT:
            # Already drafted. Commit to release the row lock, as in `publish`, and read nothing
            # after it - the locked fetch already returned the relations this response needs.
            await self._session.commit()
            return post

        post.status = PostStatus.DRAFT

        # Flush and re-read with relations inside the transaction; the COMMIT is last.
        drafted = await self._posts.save_with_relations(post)
        await self._session.commit()

        get_logger(__name__).info(
            "post unpublished",
            post_id=str(drafted.id),
            slug=log_safe_text(drafted.slug),
            actor_id=str(actor.id),
        )
        return drafted
