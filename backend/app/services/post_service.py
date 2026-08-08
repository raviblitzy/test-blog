"""Business rules for the ``posts`` relation: the post lifecycle, ownership, and the feed.

This module owns the whole of requirement R2 - create, edit, delete, publish - and the service
half of R3, the home feed with free-text search, category filtering and pagination. It also
carries the **single declaration of the draft-confidentiality rule**, in
:func:`visible_statuses_for` and :func:`can_view_post`, which ``app.services.comment_service``
and ``app.services.like_service`` import rather than re-derive.

Authority lives here, not in the route
--------------------------------------
An author may act only on their own posts; an administrator may act on any. That comparison is
made in this module and nowhere else, so the rule holds no matter which entry point invokes it
and is testable without an HTTP request:

.. code-block:: python

    service = PostService(session)
    post = await service.publish(post_id, actor=principal)  # ForbiddenError if not theirs

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
"""

import uuid
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from types import MappingProxyType
from typing import Final

import bleach
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import PageParams, ensure_can_modify, is_admin
from app.core.exceptions import ConflictError, NotFoundError
from app.core.logging import get_logger, log_safe_text
from app.core.pagination import Page, build_page
from app.core.slug import slugify_title, unique_slug
from app.models import Category, Post, PostStatus, User
from app.repositories import CategoryRepository, PostRepository, PostSort, UserRepository
from app.schemas.post import PostCreate, PostSummary, PostUpdate

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
"""

_NO_TAGS: Final[frozenset[str]] = frozenset()
"""The empty tag allow-list used for the excerpt: strip every element, keep the text."""

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


def _sanitize_content(raw: str) -> str:
    """Clean author-authored Markdown for storage, keeping the document intact.

    The write-side half of the sanitisation pair. The client sanitises again where it renders,
    and neither half is redundant: this one is what makes the stored row safe for **any**
    consumer, including a future one that does not run the client's pipeline.

    Args:
        raw: The submitted body, exactly as it arrived. Already length-bounded and known to
            carry a non-whitespace character by ``app.schemas.post.PostContent``.

    Returns:
        The body with every element outside :data:`CONTENT_ALLOWED_TAGS` removed, every
        attribute outside :data:`CONTENT_ALLOWED_ATTRIBUTES` dropped, every URL scheme outside
        :data:`CONTENT_ALLOWED_PROTOCOLS` refused, and every comment stripped.

    Note:
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
        raw,
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

    Args:
        q: The caller's search term, or ``None``.

    Returns:
        ``"relevance"`` when a term is present, ``"recent"`` otherwise.
    """
    return "recent" if _omit_blank(q) is None else "relevance"


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

    The value passed as ``statuses`` to ``PostRepository.list_posts``, and therefore the
    control that keeps a draft out of the public feed, out of a category-filtered result and
    off a public profile. The repository takes the states as an argument and decides nothing;
    this is where the decision is made.

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
        An authenticated author browsing the *unscoped* feed gets the public set, not their own
        drafts mixed in. That is deliberate: the home feed is a shared surface whose ``total``
        and page boundaries would otherwise differ per caller, and an author's unpublished work
        belongs on their workspace, which scopes itself with ``author_id``.

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


async def _load_relations(post: Post) -> Post:
    """Load ``author`` and ``categories`` on a post fetched without eager loaders.

    ``PostRepository.get_for_update`` attaches no loader options - its purpose is a lock over
    one row - so the entity a mutating method holds carries its own columns and nothing else.
    A response model needs the byline and the category badges, so they are requested here,
    after the write has been committed.

    ``awaitable_attrs`` is the accessor ``app.db.base`` provides for exactly this, and it is
    used the way that module prescribes: as a safety valve on a single entity, never inside a
    loop. A listing must not come through here - it eager-loads both relationships in the one
    composed statement instead, which is what keeps the feed at two round trips however many
    posts it returns.

    Args:
        post: A persistent post whose relationships may be unloaded.

    Returns:
        The same instance, with both relationships loaded.
    """
    await post.awaitable_attrs.author
    await post.awaitable_attrs.categories
    return post


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
    ) -> Page[PostSummary]:
        """List posts for ``GET /api/v1/posts``: search, filter, order and window, in one query.

        The service half of R3. Every argument narrows the result independently, so the home
        feed, a category-filtered view and an author-filtered view are the same call with
        different arguments - which is what keeps one pagination control correct for all of
        them and keeps the index usage of all of them identical.

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
            viewer: The resolved principal, or ``None`` for an anonymous caller. Decides which
                lifecycle states are in scope, and nothing else.

        Returns:
            A :class:`~app.core.pagination.Page` of :class:`~app.schemas.post.PostSummary`,
            carrying ``items``, ``total``, ``page``, ``page_size`` and ``pages``. The summary
            projection deliberately omits the body, so a feed page stays small however long the
            articles are.

        Raises:
            NotFoundError: ``author_username`` names no account. Reported rather than silently
                answered with an empty page, so a mistyped filter is distinguishable from an
                author who has published nothing.

        Note:
            **One composed statement, plus its one count.** The repository is asked exactly
            once and the rows it returns already carry ``author`` and ``categories``, so
            projecting them issues no follow-up query. If a member of ``PostSummary`` were ever
            missing here that would be a loader option to add to the repository's statement, and
            never a reason to iterate.

            Public callers see published posts only. That is not enforced by a filter written
            here but by :func:`visible_statuses_for`, so the feed, a profile listing and a
            comment thread all answer the question the same way.
        """
        author = await self._resolve_author(author_username)
        author_id = None if author is None else author.id

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
            statuses=visible_statuses_for(viewer, author_id),
            sort=_default_sort_for(q) if sort is None else sort,
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

    async def _get_for_update(self, post_id: uuid.UUID, *, actor: User) -> Post:
        """Lock one post for writing and confirm the actor may write it.

        The shared preamble of :meth:`update`, :meth:`delete`, :meth:`publish` and
        :meth:`unpublish`, so the two failure modes are ordered identically on all four paths
        and the ordering is stated once. Writing it per method is how four copies of one rule
        drift apart - and how one of them ends up answering ``403`` for a row that does not
        exist.

        Args:
            post_id: The post's server-generated identifier, from the URL path.
            actor: The resolved principal attempting the mutation.

        Returns:
            The locked post. Its own columns are populated; its relationships are not - see
            :func:`_load_relations`.

        Raises:
            NotFoundError: No post carries that identifier.
            ForbiddenError: The actor neither wrote the post nor holds ``ADMIN``. Raised by
                ``ensure_can_modify``, which is the one definition of that comparison; this
                module does not restate it.

        Note:
            ``SELECT ... FOR UPDATE`` is taken before the authority check rather than after, so
            two requests that both read a draft and both decide to publish it cannot interleave
            between the read and the write: the second blocks until the first's transaction
            ends and then observes its outcome. The lock is released by the commit each caller
            performs.

            Not-found is resolved first, and for an unpublished post that ordering is also what
            keeps its existence private: a caller who may not modify a draft learns nothing
            here that a caller who may not *see* it would not already have learned from
            :meth:`get_by_slug`.
        """
        post = await self._posts.get_for_update(post_id)
        if post is None:
            raise NotFoundError(_POST_NOT_FOUND)
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
            and inserting, which :meth:`create` translates into a conflict.
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
            NotFoundError: A supplied category identifier names no category.
            ConflictError: The derived slug was taken between the moment the taken set was read
                and the moment the row was inserted. See the note.

        Note:
            **A created post is always a draft, and there is no argument that changes that.**
            It is therefore absent from the public feed until ``POST /api/v1/posts/{id}/publish``
            runs, which is what stops an author publishing by accident and what keeps the
            publication instant and the lifecycle state written together.

            No role is required beyond authentication, which is the contract the endpoint
            table states: a reader who writes their first post is an author by doing so. The
            ``AUTHOR`` role exists to describe an account, not to gate this call, and gating it
            would make the account a new registration receives unable to use the authoring
            screens it is shown.

            **Both text members are sanitised before anything is stored.** The client sanitises
            again where it renders, and this half is not skipped on the strength of that: the
            row has to be safe for every consumer of the API, not only for the one client in
            this repository.

            ``search_vector`` is never assigned. It is a generated column, so committing this
            insert is what derives it - there is no trigger to fire and no index to maintain.
        """
        # Resolved before the row is built so that a bad identifier fails the request before any
        # slug is reserved or any INSERT is attempted.
        categories = await self._resolve_categories(payload.category_ids)

        post = Post(
            author_id=author.id,
            title=payload.title,
            slug=await self._derive_slug(payload.title),
            excerpt=None if payload.excerpt is None else _sanitize_excerpt(payload.excerpt),
            content=_sanitize_content(payload.content),
            # `HttpUrl` validated the scheme and the host; the column is text, and the schema
            # names `str(value)` as the coercion this layer owes it.
            cover_image_url=(
                None if payload.cover_image_url is None else str(payload.cover_image_url)
            ),
            # Stated explicitly rather than left to the column's server default, so that the
            # one lifecycle guarantee this method makes is visible in this method.
            status=PostStatus.DRAFT,
            published_at=None,
            categories=categories,
        )

        try:
            await self._posts.add(post)
            await self._session.commit()
        except IntegrityError as error:
            # The slug is de-duplicated against the slugs that existed a moment ago, so two
            # concurrent creates of the same title can still collide on `ix_posts_slug`. The
            # unique index is the backstop and this is its translation: a conflict with the
            # database's current state, which a retry resolves because the retry sees the row
            # that won. Rolled back first - the transaction is aborted, so anything else issued
            # on this session would fail too.
            await self._session.rollback()
            raise ConflictError(_SLUG_CONFLICT) from error

        get_logger(__name__).info(
            "post created",
            post_id=str(post.id),
            slug=log_safe_text(post.slug),
            author_id=str(author.id),
            category_count=len(categories),
        )
        return await _load_relations(post)

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
            actor: The resolved principal. Must own the post or hold ``ADMIN``.

        Returns:
            The updated post, with ``author`` and ``categories`` loaded.

        Raises:
            NotFoundError: No post carries that identifier, or a supplied category identifier
                names no category.
            ForbiddenError: The actor neither wrote the post nor holds ``ADMIN``.

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
            post.title = payload.title
        if payload.content is not None:
            post.content = _sanitize_content(payload.content)

        if "excerpt" in provided:
            post.excerpt = None if payload.excerpt is None else _sanitize_excerpt(payload.excerpt)
        if "cover_image_url" in provided:
            post.cover_image_url = (
                None if payload.cover_image_url is None else str(payload.cover_image_url)
            )

        if payload.category_ids is not None:
            categories = await self._resolve_categories(payload.category_ids)
            # The current membership has to be loaded before it can be replaced: SQLAlchemy
            # computes the delta against it, and the locked fetch above attaches no loaders, so
            # assigning to an unloaded collection would raise `MissingGreenlet`. The rows
            # `post_categories` gains and loses are the ORM's to emit - this module never writes
            # to the association table itself.
            await post.awaitable_attrs.categories
            post.categories = categories

        await self._posts.save(post)
        await self._session.commit()

        get_logger(__name__).info(
            "post updated",
            post_id=str(post.id),
            slug=log_safe_text(post.slug),
            actor_id=str(actor.id),
            changed=sorted(provided),
        )
        return await _load_relations(post)

    async def delete(self, post_id: uuid.UUID, *, actor: User) -> None:
        """Delete a post for ``DELETE /api/v1/posts/{id}``.

        Args:
            post_id: The post's identifier, from the URL path.
            actor: The resolved principal. Must own the post or hold ``ADMIN``.

        Raises:
            NotFoundError: No post carries that identifier.
            ForbiddenError: The actor neither wrote the post nor holds ``ADMIN``.

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
        post = await self._get_for_update(post_id, actor=actor)

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
            actor: The resolved principal. Must own the post or hold ``ADMIN``.

        Returns:
            The published post, with ``author`` and ``categories`` loaded, its ``status`` set to
            ``PUBLISHED`` and its ``published_at`` guaranteed non-null.

        Raises:
            NotFoundError: No post carries that identifier.
            ForbiddenError: The actor neither wrote the post nor holds ``ADMIN``.

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
            # for the remainder of the request against a post nobody is changing.
            await self._session.commit()
            return await _load_relations(post)

        # `posts.slug` is NOT NULL, so a persisted post always carries one and this branch is
        # defence in depth rather than an expected path: NOT NULL does not forbid the empty
        # string, and a post can only become public with an address a reader can use.
        if not post.slug:
            post.slug = await self._derive_slug(post.title)

        post.published_at = post.published_at if post.published_at is not None else _utc_now()
        post.status = PostStatus.PUBLISHED

        await self._posts.save(post)
        await self._session.commit()

        get_logger(__name__).info(
            "post published",
            post_id=str(post.id),
            slug=log_safe_text(post.slug),
            actor_id=str(actor.id),
            published_at=post.published_at.isoformat(),
        )
        return await _load_relations(post)

    async def unpublish(self, post_id: uuid.UUID, *, actor: User) -> Post:
        """Return a post to ``DRAFT`` for ``POST /api/v1/posts/{id}/unpublish``.

        The inverse transition. It removes the post from the public feed, from category-filtered
        results and from its author's public profile immediately, because every one of those
        surfaces scopes itself with :func:`visible_statuses_for`.

        Args:
            post_id: The post's identifier, from the URL path.
            actor: The resolved principal. Must own the post or hold ``ADMIN``.

        Returns:
            The post, with ``author`` and ``categories`` loaded, its ``status`` set to ``DRAFT``.

        Raises:
            NotFoundError: No post carries that identifier.
            ForbiddenError: The actor neither wrote the post nor holds ``ADMIN``.

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
            # Already drafted. Commit to release the row lock, as in `publish`.
            await self._session.commit()
            return await _load_relations(post)

        post.status = PostStatus.DRAFT

        await self._posts.save(post)
        await self._session.commit()

        get_logger(__name__).info(
            "post unpublished",
            post_id=str(post.id),
            slug=log_safe_text(post.slug),
            actor_id=str(actor.id),
        )
        return await _load_relations(post)
