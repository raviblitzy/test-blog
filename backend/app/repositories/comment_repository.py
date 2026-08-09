"""Every statement over the ``comments`` relation: a post's threaded discussion, and the queue.

One relation, two reading surfaces, and they are deliberately two methods rather than one method
with a flag. :meth:`CommentRepository.list_for_post` assembles what a reader sees on a post page -
top-level comments in the order they were written, each carrying the replies that answer it -
while :meth:`CommentRepository.list_moderation_queue` assembles what an administrator works
through, which is every comment across every post regardless of depth. The two differ in their
filters, in their ordering, in what they eager-load and in what counts as a page member, so
collapsing them into one signature would produce a method whose behaviour is decided entirely by
its arguments and whose docstring would have to describe two queries anyway.

Moderation state is why the second surface exists at all. "Managing comments" presupposes a state
an administrator can change, so a comment carries :class:`~app.models.comment.CommentStatus`
rather than existing only as visible text - and this module is where that state becomes a
property of the *query*: the reader-facing path filters on the statuses its caller passes, and
the queue path filters on the ones its caller passes. Neither decides.

What this module owns, and what it does not
-------------------------------------------
It owns the ``comments`` queries and nothing else. In particular it does not sanitise a body
(``app.services.comment_service`` cleans reader-authored text with ``bleach`` on write, and a
cleaner invoked from a read path would run again on every row), it does not decide who may act on
a row (ownership - "a non-owner cannot edit another's comment" - lives in that same service, so
one rule holds whichever entry point invokes it and is unit-testable without an HTTP request), it
performs no moderation transition, it builds no wire envelope, and it chooses no error.

Paging is over top-level comments only
--------------------------------------
:meth:`CommentRepository.list_for_post` adds ``comments.parent_id IS NULL`` to its predicate set,
so a reply is never a page member: it arrives attached to the parent it answers, through the
eager loader. That is a correctness decision rather than a presentational one.

Were replies counted as page members, a thread of three top-level comments in which the first has
two replies would report ``total = 5``, and ``LIMIT 2`` would put the first comment and one of its
own replies on page one - the reply appearing twice on that page, once as a row and once nested
inside its parent - while page two would begin with the second reply and re-nest it under a
parent that page one already showed. ``total`` would then describe a set the client cannot
reconstruct, ``pages`` would be arithmetic over the wrong denominator, and the uniform pagination
contract that every list surface in this API shares would hold for three surfaces and not for the
fourth. Filtering to the roots makes a page a set of *threads*, which is the unit a reader
navigates.

A thread has no depth limit, so the descent is recursive
-------------------------------------------------------
Threading is ``comments.parent_id`` and nothing else, and nothing caps it: a reply names the
comment it answers, that comment may itself be a reply, and
:attr:`app.schemas.comment.CommentPublic.replies` is recursive without limit. A reply to a reply
is therefore an ordinary comment that the create endpoint accepts and the moderation queue lists.

A relationship loader cannot read that shape. ``selectinload(Comment.replies)`` follows exactly
one generation, so a thread fetched through it stops at the first level and every deeper comment
is absent from the response - present in the database, visible to an administrator, and
permanently invisible to the reader it was written for, with nothing raised and nothing logged.
Chaining the loader per level is not an answer either: the depth is not known when the statement
is built, and reaching the next level through the attribute instead is a lazy load, which under
an ``AsyncSession`` raises ``MissingGreenlet``.

:meth:`CommentRepository.list_for_post` therefore pages the roots and then hands their
identifiers to :meth:`CommentRepository._descendants_of`, which walks ``parent_id`` in **one**
``WITH RECURSIVE`` statement and returns every descendant at every depth.
:func:`_attach_replies` nests them afterwards, in memory. Five statements serve a page of any
size at any depth: the count, the roots, the roots' authors, the descent, and the descendants'
authors.

The caller's status filter is applied at every level
----------------------------------------------------
:func:`_status_criteria_on` builds the moderation predicate once, and it is applied to the roots,
to the count, to the recursive statement's anchor term **and** to its recursive term. Without the
last two an unapproved reply would reach a public caller through an approved ancestor: the
ancestor passes the ``WHERE`` clause, and an unfiltered descent then returns every child it has.
That is the one leak this module has to be written to avoid, and it is closed in the statements
rather than by a caller remembering to strip replies afterwards.

Two consequences are deliberate. Filtering the recursive term prunes whole **subtrees**: a reply
whose parent the caller may not see is never reached, which is right, because rendering it would
either place it under a parent that is not there or reparent it to the top of the thread and
misstate what it answers. And the predicate has to be rebuilt for the recursive term against that
term's alias - both ends of a self-reference are the same table - which is why
:func:`_status_criteria_on` takes the column rather than assuming the unaliased entity.

Verified against the pinned SQLAlchemy 2.0.51 and PostgreSQL 18.4 rather than assumed: over a
four-deep chain with a ``PENDING`` comment carrying an ``APPROVED`` reply of its own,
``statuses=(CommentStatus.APPROVED,)`` returned the three approved descendants and neither the
pending comment nor the approved reply beneath it, while ``statuses=None`` returned all five.

``parent_id IS NULL`` restricts the page, and it must not restrict the descent, or every replies
collection would come back empty.

The criteria alone are not sufficient, and that is the second half of the same guarantee. An eager
loader will not overwrite a collection an instance in the session's identity map has *already*
loaded, so the filter would otherwise hold only for a unit of work that had not read the thread
before. Measured on the same stack: a session that read the thread with ``statuses=None`` and then
read it again with ``statuses=(CommentStatus.APPROVED,)`` got the first, unfiltered collection back
and the unapproved reply reached the filtered caller. The rows statement therefore carries
``populate_existing``, which makes the loaders overwrite rather than skip - so what the statement
says is what the caller gets, in either order, and a security-relevant predicate does not depend on
a session's history. A request-scoped session reads a thread once, so the option costs nothing in
practice; it is there because "in practice" is not a guarantee.

Nesting and ordering the fetched rows
------------------------------------
The recursive statement returns a post's descendants as one flat sequence, and the response shape
is a tree, so :func:`_attach_replies` groups each row under the identifier in its own ``parent_id``
and writes the result into every comment's ``replies`` collection. It runs entirely over rows that
are already in memory and issues no statement at all. ``Comment.replies`` declares no ``order_by``
and PostgreSQL returns the descendants in no defined order, so each group is sorted into
``(created_at, id)`` order first - a thread reads forwards, and the identifier is what makes the
order total when a per-transaction clock has stamped several rows the same instant.

**How that collection is written is load-bearing**, because
:attr:`~app.models.comment.Comment.replies` carries ``cascade="all, delete-orphan"``.
:func:`~sqlalchemy.orm.attributes.set_committed_value` is used, which records the value as though
the database had just returned it: no attribute history, no load of the previous value, nothing
dirty. A plain assignment or a slice assignment must **not** be used in its place - both go through
the instrumented collection, whose removal events would mark every reply an orphan and delete the
thread on the next flush, and both first load the existing collection to compute the difference,
which under an ``AsyncSession`` raises ``MissingGreenlet``. Measured against SQLAlchemy 2.0.51:
after assembling a four-level thread this way, ``session.dirty`` and ``session.deleted`` are both
empty and a subsequent flush deletes nothing.

Every comment in the returned tree is given a value, the leaves included - an empty list rather
than nothing at all. "Nothing at all" means unloaded, and the first read of an unloaded collection
is the lazy load this design exists to make impossible, reached one layer away from the query that
forgot to ask.

Deletion belongs to the database
--------------------------------
There is no recursive delete in this module and there must never be one. ``comments.parent_id`` is
a self-referencing foreign key with ``ON DELETE CASCADE``, so PostgreSQL removes the rows that
referenced a deleted comment and then cascades again from each of those: removing a comment
removes its whole subtree in the one statement, which is what makes "deleting a parent removes its
replies" a schema guarantee. The cascades from ``posts`` and ``users`` remove a deleted post's or a
deleted account's comments the same way. Re-implementing any of that in Python would give one rule
two definitions to keep in step, and the Python one would be the slower and the less reliable.
:meth:`~app.repositories.base.BaseRepository.delete` is therefore the only removal this module
needs, and it is inherited rather than written.

What it returns, and what it deliberately does not
--------------------------------------------------
Both listing methods return a plain ``(rows, total)`` tuple. Neither builds
``app.core.pagination.Page``, and this module does not import that module at all: ``Page`` is a
wire shape, and keeping wire shapes out of the data layer is what layered separation means here.
``app.services.comment_service`` and ``app.services.admin_service`` project the rows into response
schemas and call ``build_page(list(rows), total, page, page_size)`` to produce the five-field
envelope every list endpoint serialises.

Nothing here raises. A parent that does not exist, and a parent that exists but hangs off another
post, are both reported as ``None`` by :meth:`CommentRepository.get_parent`; an empty page is
``([], total)``; a count with no matches is ``0``. No status code is chosen, no framework HTTP
exception is constructed and no domain exception is emitted, because a repository cannot know
whether a missing row is a ``404``, a ``403`` in disguise or a legitimately empty result. The
service this one replaced answered that question three times over, raising
``HTTPException(status_code=404, detail="Item not found")`` from three separate handlers
(``app.py:L31``, ``L40``, ``L49``); here the question is asked once, a layer up.

Nothing here commits either. Every write ends at ``flush()`` in
:class:`~app.repositories.base.BaseRepository`, so the service orchestrating a use case owns the
transaction boundary and the test suite can roll each test back.

Access paths
------------
Five indexes serve this relation and every statement below is written to use one of them:

* :meth:`CommentRepository.list_for_post` filters ``post_id`` for equality and orders by
  ``created_at``, which ``ix_comments_post_id_created_at`` satisfies with one index - leading
  equality column, then sort column - so no separate sort step is needed for the leading keys.
* :meth:`CommentRepository._descendants_of` filters ``parent_id`` for equality with the moderation
  state alongside it, at every level of the descent, which is exactly the shape
  ``ix_comments_parent_id_status`` was declared for. Measured on PostgreSQL 18.4 at twenty thousand
  comments: the anchor term plans as a bitmap index scan on it and the recursive term as
  ``Index Scan using ix_comments_parent_id_status`` with
  ``Index Cond: ((parent_id = comment_descendants.id) AND (status = ...))``, so the cost of reading
  a thread follows the size of that thread rather than the size of the relation.
* :meth:`CommentRepository.list_moderation_queue` filters ``status``, served by
  ``ix_comments_status``. Measured on PostgreSQL 18.4: the planner takes a bitmap index scan on
  that index for the queue's shape.
* :meth:`CommentRepository.list_moderation_queue` also accepts an optional body term, matched as
  ``ILIKE '%term%'`` and served by ``ix_comments_body_trgm``. A leading wildcard cannot use a
  B-tree at any size, so that GIN trigram index is the only thing that can answer it; ``body`` is
  plain ``TEXT``, so the predicate reaches the index with no cast.
* :meth:`CommentRepository.get_parent` and the inherited ``get_by_id`` address the primary key.

``ix_comments_author_id`` is the remaining one, and no statement here uses it: it exists for the
``ON DELETE CASCADE`` from ``users``, which locates an account's comments by that column when the
account is removed.

No indexed column is ever wrapped in a function here.

A thread response is bounded in SQL, not trimmed afterwards
----------------------------------------------------------
``page_size`` bounds the *roots* of a thread page, and roots alone are not the size of the
response: every root carries its reply tree, and ``app.schemas.comment.CommentPublic.replies``
serialises all of it. Nothing about ``comments`` limits how many replies one comment may attract,
so an unbounded descent means a twenty-item page can carry an unbounded number of rows and an
unbounded number of five-thousand-character bodies - reachable through the one write path any
authenticated reader has, which makes it a resource-exhaustion surface rather than a slow query.

Two bounds are therefore part of the statement itself, applied by PostgreSQL before a row is
returned rather than by Python after the graph has been materialised:

* :data:`MAX_THREAD_DEPTH` caps how far the recursive term descends.
* :data:`MAX_THREAD_DESCENDANTS` caps how many descendant rows the whole page may carry.

The row cap is ordered ``(depth, created_at, id)`` - **depth-major, and that is what makes
truncation coherent rather than arbitrary.** Every node at a shallower depth is returned before any
node at a deeper one, so if a node is retained its parent is retained too, and the retained set is
always a valid forest: :func:`_attach_replies` can never be handed a reply whose parent is missing.
Cutting on ``created_at`` alone could keep a grandchild while dropping its parent, and the reply
would then be silently reparented or silently dropped.

So the worst case a thread page can produce is ``page_size`` roots plus
:data:`MAX_THREAD_DESCENDANTS` descendants, whatever shape the discussion has - and the ordinary
case is unaffected, because an ordinary thread has neither eight levels nor two hundred replies.

Row locks over ``comments``, and where they sit in the global order
-----------------------------------------------------------------
Three methods here take a row lock, and the mode differs with what the lock is for.

* :meth:`CommentRepository.get_with_author` under ``for_update=True`` - ``FOR UPDATE``, for an
  operation that changes the comment itself: an owner's edit, a delete, an administrator's
  moderation transition.
* :meth:`CommentRepository.get_parent` under ``for_share=True`` - ``FOR SHARE``, for the parent a
  reply claims to answer. The parent's moderation state decides whether the reply may be written at
  all, so that state has to hold until the insert commits; a shared lock blocks the moderation
  transition and the cascade that would remove it while still letting other readers reply to the
  same comment.
* :meth:`CommentRepository.post_id_of` takes **no** lock, and exists precisely so that a caller can
  learn which post to lock *before* it locks anything.

**The order is ``posts`` -> ``comments`` -> ``post_likes``, globally, and it is never reversed.**
A caller reaching a locking method here is already holding
:meth:`~app.repositories.post_repository.PostRepository.get_for_share`'s shared lock on the owning
post, or is a path that never needs one. The hazard the order removes is concrete: deleting a post
holds ``FOR UPDATE`` on that post while its cascade locks the post's comments, so a transaction
that locked a comment and then reached back for its post would close a cycle and deadlock instead of
serialising. ``get_for_share`` carries the full statement of the order; this module states its
``comments`` half so neither can drift.

Deliberately absent
-------------------
No reply-count aggregate: a count of a collection that is already loaded is ``len()`` at the layer
that renders it. No moderation policy, no ownership rule, no sanitisation, no logging - request
correlation is bound once by ``app.middleware.request_context`` and the services log against it.
And no session or engine: a repository is *session-bound*, constructed with the ``AsyncSession``
that ``app.core.dependencies.get_db`` yielded, so ``app.db.session`` is not imported here.

The *creation* rule about nesting is still not here: whether a reply may be written at a given
depth is authority over input and belongs to ``app.services.comment_service``, which asks this
module for the depth through :meth:`CommentRepository.reply_depth_for_parent` and then decides.
:data:`MAX_THREAD_DEPTH` is the different question of how much of an existing thread one response
may carry, which is a property of the statement and therefore belongs here.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import datetime
from typing import Final

from sqlalchemy import ColumnElement, Select, func, literal, select
from sqlalchemy.orm import QueryableAttribute, aliased, selectinload
from sqlalchemy.orm.attributes import set_committed_value

from app.models.comment import Comment, CommentStatus
from app.models.user import User
from app.repositories.base import UUIDPrimaryKeyRepository

__all__ = ["MAX_THREAD_DEPTH", "MAX_THREAD_DESCENDANTS", "CommentRepository"]


MAX_THREAD_DEPTH: Final[int] = 8
"""How many generations below a root :meth:`CommentRepository.list_for_post` descends.

A bound on the *response*, and deliberately not the same rule as
``app.services.comment_service.MAX_REPLY_DEPTH``, which bounds what may be *created*. The two carry
the same number on purpose: eight is the deepest reply the request path will accept, so a thread
written entirely through the API is returned complete, and the cap costs a reader nothing.

They are separate constants because they answer to different things. The service's cap protects the
data from an untrusted writer looping replies onto its own replies. This one protects the
*statement* from data the service never saw: ``app.db.seed``, the test factories and a data
migration all write comments without passing through the request path, so the read path cannot
assume the created-depth rule ever applied. Without a bound here, one hand-written chain of ten
thousand replies would make every subsequent read of that thread descend ten thousand levels.

Beyond this depth a reply is present in the database, visible in the administrative moderation
queue, and simply not carried by the public thread response - which is the honest outcome for a
structure no reader could act on anyway, and the alternative to it is an unbounded response.
"""

MAX_THREAD_DESCENDANTS: Final[int] = 200
"""How many descendant rows one page of :meth:`CommentRepository.list_for_post` may carry in total.

The bound that actually makes a thread response finite. Depth alone does not: a single root with
fifty thousand direct replies is one level deep, and ``CommentPublic.replies`` would serialise every
one of them. This is a cap on rows rather than on levels, applied as a ``LIMIT`` inside the
statement, so PostgreSQL stops producing rows rather than Python discarding them afterwards.

Two hundred against a default ``page_size`` of twenty is ten replies per root on average, and a
worst case of two hundred bodies at ``app.schemas.comment.BODY_MAX_LENGTH`` characters each - a
bounded payload for a page of a discussion, where the alternative was unbounded. A reader who
reaches that ceiling on one page sees the shallowest replies, because the cap is applied under a
depth-major ordering; the deeper tail is still moderable and still readable one page along, since
paging the roots changes which trees are drawn from.
"""


_LIKE_ESCAPE: Final = "\\"
"""The escape character :func:`_containment_pattern` uses inside its ``LIKE`` pattern.

Declared once and passed to the ``ilike()`` call built from it. A pattern escaped with one
character and matched with another is not a subtle bug - it is a moderator's search silently
treating their ``%`` as a wildcard.
"""


_PUBLIC_AUTHOR_COLUMNS: Final = (
    # The six members app.schemas.user.UserPublic declares - the whole of a rendered byline, and
    # the whole of what any comment response is entitled to show about its author.
    #
    # Everything else on `users` is deferred, and `password_hash` is the reason this tuple exists
    # rather than being an optimisation: a thread page that loaded whole `User` entities pulled
    # every participant's argon2id hash out of the database and held it in the session's identity
    # map for the duration of the request. `email`, `role` and `is_active` are withheld for the
    # same reason - none is a member of any response model a public caller receives.
    #
    # `id` is included automatically by load_only, being the primary key, and is what the batched
    # `selectin` lookup keys on.
    User.username,
    User.display_name,
    User.bio,
    User.avatar_url,
    User.created_at,
)
"""The ``users`` columns a rendered byline needs, and no others."""


def _containment_pattern(term: str) -> str:
    """Turn a moderator's search term into a ``LIKE`` pattern that matches it literally.

    Wildcards in the *term* are escaped, so the term is matched as text rather than as a pattern.
    Without this a search for ``%`` alone would match every comment - degrading the filter into
    "everything" - and a search containing ``_`` would match any character in that position.

    The backslash is escaped first. In any other order the escapes introduced for ``%`` and ``_``
    would themselves be doubled, so a term containing a real backslash would stop matching.

    Args:
        term: The raw search text, already stripped and known non-empty by the caller.

    Returns:
        A pattern of the form ``%<escaped term>%``, to be used with ``escape=``:data:`_LIKE_ESCAPE`.
    """
    escaped = (
        term.replace(_LIKE_ESCAPE, _LIKE_ESCAPE * 2)
        .replace("%", f"{_LIKE_ESCAPE}%")
        .replace("_", f"{_LIKE_ESCAPE}_")
    )
    return f"%{escaped}%"


def _status_criteria_on(
    column: QueryableAttribute[CommentStatus],
    statuses: Sequence[CommentStatus] | None,
) -> list[ColumnElement[bool]]:
    """Build the moderation-state predicate over a given ``status`` column, or none at all.

    The single definition of "which moderation states are visible", expressed against whichever side
    of a statement needs it. The parameter is not generality for its own sake: the recursive descent
    in :meth:`CommentRepository._descendants_of` joins ``comments`` to itself, so its recursive term
    filters an **alias** of the relation, and a predicate bound to the unaliased entity would
    silently filter the wrong side of that join.

    Args:
        column: The ``status`` column to constrain - :attr:`~app.models.comment.Comment.status`, or
            the same attribute reached through an :func:`~sqlalchemy.orm.aliased` entity.
        statuses: The moderation states to include, or ``None`` for every state. ``None`` adds no
            predicate at all rather than a tautology for the planner to work around. An **empty**
            sequence is a different request and is honoured literally: ``IN ()`` renders as a
            guaranteed-false expression, so "include none of these states" yields no rows.

    Returns:
        Zero or one SQL boolean expression, to be combined with ``AND`` by the caller.

    Note:
        ``in_()`` on the native ``comment_status`` column, which leaves the column expression
        untouched and therefore keeps both ``ix_comments_status`` and
        ``ix_comments_parent_id_status`` usable. A single-member sequence renders as ``IN (...)``
        rather than as ``=``; PostgreSQL plans the two identically.
    """
    if statuses is None:
        return []
    return [column.in_(statuses)]


def _status_criteria(statuses: Sequence[CommentStatus] | None) -> list[ColumnElement[bool]]:
    """Build the moderation-state predicate over the unaliased relation.

    Called once per listing and spread into every statement that listing builds - the rows select,
    the count select and, in :meth:`CommentRepository.list_for_post`, the anchor term of the
    recursive descent. One definition is what makes "the replies are filtered by the same statuses
    as their parents" true by construction instead of true by inspection.

    Args:
        statuses: The moderation states to include, or ``None`` for every state.

    Returns:
        Zero or one SQL boolean expression, to be combined with ``AND`` by the caller.

    Note:
        Which states a caller asks for is never decided here. A public thread narrows to
        :attr:`~app.models.comment.CommentStatus.APPROVED`, an author viewing their own post's
        thread may ask for more, and the moderation queue asks for a state or for all of them.
        Choosing between those is authority, and authority lives in
        ``app.services.comment_service``.
    """
    return _status_criteria_on(Comment.status, statuses)


def _queue_criteria(
    *,
    statuses: Sequence[CommentStatus] | None,
    q: str | None,
    post_id: uuid.UUID | None,
) -> list[ColumnElement[bool]]:
    """Build the ``WHERE`` terms shared by the moderation queue's rows and its count.

    The single definition of what "the filtered queue" means, for the same reason the identity
    predicate lives once in :meth:`~app.repositories.base.BaseRepository.get_by_id` rather than
    three times across three handlers: two hand-written copies of a filter set are two things to
    keep in step, and the symptom of their drifting apart is a ``total`` that does not describe the
    rows the window drew from.

    Every filter is skipped when its argument is absent, so an omitted filter contributes no term.
    There is deliberately **no** ``parent_id`` term: a moderator must see replies as well as
    top-level comments, which is the whole reason the queue is a separate method from the
    reader-facing thread.

    Args:
        statuses: The moderation states to include, or ``None`` for every state.
        q: Optional free-text term matched against the comment body. Whitespace-only and ``None``
            are equivalent, so ``?q=`` adds no predicate.
        post_id: Optional restriction to one post's comments, or ``None`` for every post.

    Returns:
        Zero to three SQL boolean expressions, to be combined with ``AND`` by the caller.

    Note:
        The ``ILIKE`` containment match is served by ``ix_comments_body_trgm``, a GIN trigram index
        over ``comments.body`` built by revision ``0002``. That index is what makes this predicate
        affordable at all: a leading wildcard cannot use a b-tree, so without it every keystroke in
        the moderation search box was a sequential scan over the largest relation in this schema.
        Measured on PostgreSQL 18.4, and stated as two claims because they are two claims: the
        predicate plans as an ``Index Cond`` on that index at any row count, and the planner
        prefers it to reading the relation once the relation is large enough for that to pay - a
        scan still wins at twenty thousand comments, the index wins at two hundred thousand.

        ``body`` is plain ``TEXT``, so the operator class sits directly on the column and this
        predicate needs no cast to reach the index - unlike the citext columns in
        ``user_repository`` and ``category_repository``, which have to match an expression index.

        ``ilike`` rather than ``lower(body) LIKE lower(:term)``: wrapping the column in a function
        is what would make the trigram index unusable, so the operator is not merely more
        expressive here, it is the difference between using the index and not.
    """
    criteria: list[ColumnElement[bool]] = _status_criteria(statuses)

    if post_id is not None:
        criteria.append(Comment.post_id == post_id)

    term = q.strip() if q is not None else ""
    if term:
        criteria.append(Comment.body.ilike(_containment_pattern(term), escape=_LIKE_ESCAPE))

    return criteria


def _thread_order(reply: Comment) -> tuple[datetime, uuid.UUID]:
    """Sort key placing a reply in thread order, with the primary key breaking every tie.

    ``created_at`` defaults to ``now()``, which PostgreSQL evaluates once per *transaction*, so
    every reply written by one seed run or one test fixture shares a single instant. Ordering on
    that column alone would leave their relative order unspecified from one read to the next, which
    is how a rendered thread appears to shuffle itself between two requests that fetched the same
    rows. Appending the identifier makes the order total.

    Args:
        reply: A loaded comment. Both attributes are columns of the row that was just fetched, so
            reading them triggers no lazy load and cannot raise ``MissingGreenlet``.

    Returns:
        The ``(created_at, id)`` pair, ascending - oldest reply first, because a discussion reads
        forwards.
    """
    return reply.created_at, reply.id


def _attach_replies(roots: Sequence[Comment], descendants: Sequence[Comment]) -> None:
    """Assemble the fetched rows into trees by populating every ``replies`` collection.

    The in-memory half of :meth:`CommentRepository.list_for_post` and of
    :meth:`CommentRepository.load_visible_replies`. The recursive statement returns the descendants
    of the given roots as one flat sequence, and this function turns that sequence into the nested
    shape ``app.schemas.comment.CommentPublic`` serialises, by grouping each row under the
    identifier in its own ``parent_id`` and sorting each group into thread order.

    It issues **no SQL at all** and cannot: every value it reads - ``id``, ``parent_id``,
    ``created_at`` - is a column of a row already fetched, and every value it writes is written
    through :func:`~sqlalchemy.orm.attributes.set_committed_value`.

    Args:
        roots: The comments to nest under - this page of top-level comments, or the single
            comment a mutating route is answering with.
        descendants: Every comment reachable from those roots through ``parent_id``, at any depth,
            already narrowed to the caller's moderation states. Order is irrelevant - the grouping
            below does not depend on it.

    Note:
        :func:`~sqlalchemy.orm.attributes.set_committed_value` is the only safe way to do this, and
        the reason is :attr:`~app.models.comment.Comment.replies` carrying
        ``cascade="all, delete-orphan"``. A plain assignment (``comment.replies = [...]``) goes
        through the instrumented collection, which does two things this must not do: it emits
        attribute history, so every child *absent* from the new list is treated as an orphan and
        deleted on the next flush; and it first loads the existing collection in order to compute
        that difference, which under an ``AsyncSession`` raises ``MissingGreenlet``. Setting the
        value as *committed* records it as though the database had just returned it - no history,
        no load, nothing dirty. Verified against SQLAlchemy 2.0.51: after assembling a four-level
        thread this way, ``session.dirty`` and ``session.deleted`` are both empty and a subsequent
        ``flush()`` deletes nothing.

        **Every comment gets a value, including the leaves.** A comment at the deepest level is
        given an empty list rather than left alone, because "left alone" means unloaded, and the
        first thing that reads ``leaf.replies`` - the response model walking the tree - would
        trigger the lazy load this whole design exists to make impossible. Assigning to every node
        is what makes the returned tree completely self-contained.

        A descendant whose ``parent_id`` names a comment the status filter excluded contributes to
        no group and simply does not appear, which is correct: a reply cannot be rendered beneath a
        parent the caller may not see.
    """
    children: dict[uuid.UUID, list[Comment]] = {}
    for descendant in descendants:
        # `parent_id` is never NULL on a descendant - the recursive statement starts from the
        # roots' children - but the mapped type is optional, so the guard is what keeps this
        # total rather than an assertion about a value the type system cannot narrow.
        if descendant.parent_id is not None:
            children.setdefault(descendant.parent_id, []).append(descendant)

    for comment in (*roots, *descendants):
        nested = sorted(children.get(comment.id, ()), key=_thread_order)
        set_committed_value(comment, "replies", nested)


class CommentRepository(UUIDPrimaryKeyRepository[Comment]):
    """Data access for the ``comments`` relation: threaded reads, the queue, and one lookup.

    Five methods, and between them they back every comment-shaped surface in the API::

        GET   /api/v1/posts/{id}/comments  -> list_for_post(post_id, statuses=(APPROVED,), ...)
        POST  /api/v1/posts/{id}/comments  -> get_parent(...) to validate a reply, then add(...)
        PATCH /api/v1/comments/{id}        -> save(...), then load_visible_replies(comment, ...)
        GET   /api/v1/admin/comments       -> list_moderation_queue(...)
        GET   /api/v1/admin/stats          -> count_comments()

    Everything else a comment needs is inherited from
    :class:`~app.repositories.base.BaseRepository` and is deliberately not re-implemented here:
    ``get_by_id`` is where an edit, a delete and a moderation transition all start, ``add``
    persists a comment the service has already sanitised and whose parent it has already validated,
    ``save`` writes an edited body or a new moderation state that the service assigned, and
    ``delete`` removes a comment and - through the database's own cascade - the whole subtree
    beneath it.

    Nothing on this class commits, raises, logs or checks authority. The class docstring on
    :class:`~app.repositories.base.BaseRepository` states those invariants for every subclass and
    the module docstring above records what each of them means for this relation in particular.
    """

    model = Comment

    async def list_for_post(
        self,
        post_id: uuid.UUID,
        *,
        statuses: Sequence[CommentStatus] | None = None,
        limit: int,
        offset: int,
    ) -> tuple[Sequence[Comment], int]:
        """Window one post's thread: top-level comments, each carrying its **whole** reply tree.

        Backs ``GET /api/v1/posts/{id}/comments``. A page is a page of *threads*: the window and
        the count are both over comments whose ``parent_id`` is ``NULL``, and a reply reaches the
        caller nested inside the parent it answers rather than as a row of its own. The module
        docstring sets out why in full - in short, counting replies as page members would let one
        appear on two consecutive pages and would leave ``total`` describing a set the client
        cannot reconstruct.

        **Replies are nested at every depth, and the response is bounded in SQL.**
        ``comments.parent_id`` puts no bound on how deeply a reply may nest and
        ``app.schemas.comment.CommentPublic.replies`` is recursive without limit, so a reply to a
        reply is an ordinary, storable comment and loading only the first level would drop every
        deeper one from the response with nothing raised and nothing logged. This method therefore
        descends: the descendants come from one recursive common table expression over ``parent_id``
        and :func:`_attach_replies` nests them.

        The descent is bounded, though, and by the statement rather than by trust in the data.
        ``page_size`` bounds only the roots, and a root may attract any number of replies, so an
        unbounded descent made a twenty-item page carry an unbounded number of five-thousand
        character bodies - through the one write path every authenticated reader has.
        :data:`MAX_THREAD_DEPTH` caps how far the recursion goes and
        :data:`MAX_THREAD_DESCENDANTS` caps how many descendant rows the page may carry in total, so
        the worst case is ``page_size`` roots plus two hundred descendants whatever shape the
        discussion has. Both live in the statement, and the row cap is applied under a depth-major
        ordering so that the retained set is always a valid forest - see :meth:`_descendants_of`.

        Args:
            post_id: The post whose thread to read. Compared for equality against the leading
                column of ``ix_comments_post_id_created_at``, which serves the filter and the
                ordering together. A post that does not exist is not an error here - it simply has
                no comments, and whether that should be a ``404`` is the service's question to
                answer from the ``posts`` relation.
            statuses: The moderation states to include, and **the same filter is applied at every
                level of the tree**. A public caller passes
                :attr:`~app.models.comment.CommentStatus.APPROVED` alone; an administrator, or an
                author reading their own post's thread, passes ``None`` for every state. ``None``
                is the default because a repository must not be the thing that decides a caller's
                visibility - that is authority, and it belongs to
                ``app.services.comment_service``, which is also the only layer that knows who is
                asking.
            limit: Rows per page. Non-positive yields no rows rather than an invalid ``LIMIT``;
                request-supplied values are bounded to ``1..100`` by ``PageParams`` long before
                they arrive here.
            offset: Rows to skip. An offset past the end returns an empty sequence beside the real
                ``total``, never an error, which is how a client detects it has run off the end.

        Returns:
            ``(rows, total)`` - this page of top-level comments, each with ``author`` loaded and its
            ``replies`` tree loaded and ordered to the bounds above, every node in that tree also
            carrying its own ``author`` and its own ``replies``, plus the number of top-level
            comments matching the filters. Deliberately not a ``Page``: the service projects the
            rows and calls ``build_page(list(rows), total, page, page_size)``.

        Note:
            **One predicate set, four uses.** :func:`_status_criteria` produces the moderation
            filter once, and it is spread into the roots select, the count select, the recursive
            statement's anchor term and its recursive term, so none of the four can disagree about
            which states are visible. The count restates nothing.

            **``parent_id IS NULL`` narrows the page and nothing else.** It appears in the roots
            select and the count, and in neither half of the recursive statement - a descendant has
            a parent by definition, so applying it there would return every tree empty.

            **A hidden comment hides its subtree, and that is correct.** The status filter is
            applied to the anchor and to the recursive step, so a reply whose parent the caller may
            not see is never reached. The alternative - returning it anyway - would render a reply
            under a parent that is not there, or reparent it to the root of the thread, which
            misattributes what it is answering.

            **The filter holds regardless of what the session already loaded.** Both statements
            carry ``populate_existing``, so the loaders overwrite an existing instance's attributes
            rather than skipping it. Without that option the guarantee would depend on the order of
            reads within one unit of work, and one of the two orders leaks: measured on SQLAlchemy
            2.0.51, a session that read the thread unfiltered and then read it again through the
            public filter got the FIRST result back, and the unapproved reply was returned to the
            filtered caller.

            **Bounded statements AND bounded rows, whatever the page size or the depth.** Measured
            against SQLAlchemy 2.0.51: five statements in total - the count, the roots window, one
            batched ``selectin`` for the roots' authors, one recursive statement returning the
            bounded descendant set, and one batched ``selectin`` for those descendants' authors.
            None of them is per row and none is per level, which is the property a recursive CTE
            buys over walking :attr:`~app.models.comment.Comment.replies` one generation at a time -
            that would be one statement per level, and under an ``AsyncSession`` each of those
            levels would be a lazy load raising ``MissingGreenlet`` instead. A fixed statement count
            was never the whole story, though: five statements can still return an unbounded number
            of rows, which is why :data:`MAX_THREAD_DESCENDANTS` bounds the fourth one.
            ``selectinload`` is used for the many-to-one ``author`` as well: it keys its extra
            ``SELECT`` on the fetched identifiers, so it multiplies no rows, which is what lets the
            count be a plain ``count(*)`` and the rows need no ``.unique()``.

            **The tree is nested and ordered in memory, not by a further query.**
            :func:`_attach_replies` groups the descendants under their parents and sorts each
            group; it records why
            :func:`~sqlalchemy.orm.attributes.set_committed_value` is the only safe way to write a
            collection that cascades ``delete-orphan``.
        """
        status_criteria = _status_criteria(statuses)
        # `parent_id IS NULL` belongs to the PAGE, and only to the page. It is what makes a page
        # member a thread rather than a comment, so it goes into both statements below and into
        # neither half of the recursive descent.
        predicates: list[ColumnElement[bool]] = [
            Comment.post_id == post_id,
            Comment.parent_id.is_(None),
            *status_criteria,
        ]

        rows_stmt = (
            select(Comment)
            .where(*predicates)
            # Oldest first, because a discussion reads forwards - the inverse of the feed, whose
            # ordering is descending for the same reason. `id` is the deterministic final
            # tiebreaker: `created_at` is stamped from a per-transaction clock, so a seed run or a
            # test fixture gives many rows one instant, and an unspecified order under
            # LIMIT/OFFSET is how a row lands on two consecutive pages while another lands on
            # none.
            .order_by(Comment.created_at.asc(), Comment.id.asc())
            # The byline every rendered comment needs, narrowed to the six public fields - a
            # thread renders a username, a display name and an avatar, never an email address, a
            # role or a password hash. `replies` is deliberately NOT loaded here: a relationship
            # loader can only follow one generation, so the subtree is fetched by
            # `_descendants_of` below, which bounds it by depth and by row count.
            .options(selectinload(Comment.author).load_only(*_PUBLIC_AUTHOR_COLUMNS))
            # The status filter must hold whatever this unit of work has already loaded, so the
            # loader is told to overwrite rather than to skip. Measured on SQLAlchemy 2.0.51:
            # without this option, a session that read the thread unfiltered and then read it
            # again through the public filter got the FIRST result back, so the second statement's
            # criteria were never applied and the unapproved comment was returned to the filtered
            # caller. That is the very leak this method is written to prevent, so the guarantee
            # must not depend on the order in which one session happens to issue its reads.
            # Autoflush runs before the SELECT, so a pending modification is written and then read
            # back rather than discarded.
            .execution_options(populate_existing=True)
        )

        # Identical predicates, no loader options and no ORDER BY: none of the three changes a
        # count, and the sort PostgreSQL would perform for a result nobody reads is pure cost.
        # Passed explicitly so `paginate` does not wrap the rows statement in a subquery of its
        # own - and so `total` is visibly a count of top-level comments.
        count_stmt: Select[tuple[int]] = (
            select(func.count()).select_from(Comment).where(*predicates)
        )

        roots, total = await self.paginate(
            rows_stmt, limit=limit, offset=offset, count_stmt=count_stmt
        )

        # An empty page has no roots to descend from, so the recursive statement is skipped
        # entirely rather than issued with an empty IN list. `_attach_replies` still runs, over two
        # empty sequences, because it is a no-op there and a branch would be one more thing to
        # keep in step.
        descendants = (
            await self._descendants_of([root.id for root in roots], statuses=statuses)
            if roots
            else ()
        )
        _attach_replies(roots, descendants)
        return roots, total

    async def _descendants_of(
        self,
        root_ids: Sequence[uuid.UUID],
        *,
        statuses: Sequence[CommentStatus] | None,
    ) -> Sequence[Comment]:
        """Fetch the comments below *root_ids* in one statement, bounded by depth and by row count.

        The recursive half of :meth:`list_for_post` and of :meth:`load_visible_replies`, kept
        separate so that the paging statement and the descent statement are each readable on their
        own, and so that both callers descend by one definition. It renders as::

            WITH RECURSIVE comment_descendants AS (
                SELECT ..., 1 AS depth FROM comments
                 WHERE parent_id IN (:roots) AND status IN (:states)      -- anchor
                UNION ALL
                SELECT reply.*, comment_descendants.depth + 1
                  FROM comments AS reply, comment_descendants
                 WHERE reply.parent_id = comment_descendants.id
                   AND reply.status IN (:states)
                   AND comment_descendants.depth < :max_depth             -- recursive term
            )
            SELECT ... FROM comment_descendants
             ORDER BY depth, created_at, id
             LIMIT :max_descendants

        Args:
            root_ids: The identifiers to descend from - this page's top-level comments, or the
                single comment a mutating route is answering with. Never empty: a caller with no
                roots skips the call rather than issuing an empty ``IN``.
            statuses: Exactly what the calling method received, so the tree and its roots cannot
                disagree about what is visible. The predicate is built from it for **both** terms:
                on the anchor it filters the first generation, and on the recursive term it filters
                every generation after it and prunes whatever hangs below an excluded comment.

        Returns:
            At most :data:`MAX_THREAD_DESCENDANTS` descendants, none deeper than
            :data:`MAX_THREAD_DEPTH` generations below its root, as a flat sequence with ``author``
            loaded - :func:`_attach_replies` nests and sorts them. Empty when no root has a reply
            the caller may see.

        Note:
            **Both bounds are in the statement, and neither is a post-filter.** The depth cap is a
            predicate on the recursive term, so PostgreSQL stops descending rather than descending
            and discarding; the row cap is a ``LIMIT``, so it stops producing rows. Materialising an
            unbounded graph and trimming it in Python would have already paid the cost the bounds
            exist to avoid - the rows would have been read, transferred and hydrated into ORM
            instances before anything was discarded.

            **The ordering is depth-major, and that is a correctness requirement rather than a
            preference.** ``ORDER BY depth, created_at, id`` returns every node at a shallower depth
            before any node at a deeper one, so a retained node's parent is always retained too and
            the truncated set is a valid forest. Ordering by ``created_at`` alone could keep a
            grandchild whose parent fell outside the limit, and :func:`_attach_replies` would then
            drop it silently - a reply present in the response's row set but attached to nothing.
            ``id`` is the final tiebreaker for the usual reason: ``created_at`` comes from a
            per-transaction clock, so a batch of replies shares one instant and the cut has to fall
            in the same place on every read.

            **The rows are hydrated straight out of the common table expression.** The anchor
            selects the whole entity plus the depth counter, so the expression carries every mapped
            column, and :func:`~sqlalchemy.orm.aliased` maps it back onto
            :class:`~app.models.comment.Comment`. That makes this one statement rather than two:
            selecting only identifiers here would need a second pass over ``comments`` to fetch the
            rows behind them. ``depth`` is a member of the expression but not of the entity, so it
            is ordered by and never mapped.

            **The recursive term uses its own alias.** Both ends of a self-reference are the same
            table, so the term needs a distinct name to join the working set against, and the status
            predicate has to be built against that alias rather than reused from the anchor - a
            predicate bound to the unaliased entity would filter the wrong side. That is what
            :func:`_status_criteria_on` exists for, and why both call sites below go through it: one
            definition of "which states are visible", applied to two different sides.

            **The access path is ``ix_comments_parent_id_status``**, and this statement is why that
            index exists. Measured on PostgreSQL 18.4 at twenty thousand comments: the anchor plans
            as a bitmap index scan on it and the recursive term as
            ``Index Scan using ix_comments_parent_id_status`` with
            ``Index Cond: ((parent_id = comment_descendants.id) AND (status = ...))``, so the cost
            follows the size of the thread rather than the size of the relation.

            **Termination no longer rests on the data being well-shaped.** ``comments.parent_id`` is
            acyclic in practice - a reply names a comment that already existed - so the working set
            would shrink to nothing on its own, but the depth predicate makes termination a property
            of the statement instead of an assumption about the rows. ``UNION ALL`` rather than
            ``UNION`` because the tree admits no duplicate - each comment has exactly one parent, so
            it is reached exactly once - and ``UNION`` would pay for a de-duplication that can never
            remove a row.

            **The author loader is narrowed to the public byline fields.** A rendered comment shows
            a username, a display name and an avatar; it never shows an email address, a role or a
            password hash, so the batched ``selectin`` statement selects none of them.
        """
        anchor = select(Comment, literal(1).label("depth")).where(
            Comment.parent_id.in_(root_ids),
            *_status_criteria_on(Comment.status, statuses),
        )
        descent = anchor.cte("comment_descendants", recursive=True)

        reply = aliased(Comment, name="reply")
        descent = descent.union_all(
            select(reply, (descent.c.depth + 1).label("depth")).where(
                reply.parent_id == descent.c.id,
                *_status_criteria_on(reply.status, statuses),
                # The depth bound, on the recursive term rather than on the final select: a
                # generation the expression must not carry is a generation it must not fetch.
                descent.c.depth < MAX_THREAD_DEPTH,
            )
        )

        node = aliased(Comment, descent, name="descendant")
        result = await self.session.execute(
            select(node)
            # Depth-major, then thread order, then the primary key - see the note above for why
            # the leading key must be depth.
            .order_by(descent.c.depth.asc(), node.created_at.asc(), node.id.asc())
            .limit(MAX_THREAD_DESCENDANTS)
            .options(selectinload(node.author).load_only(*_PUBLIC_AUTHOR_COLUMNS))
            .execution_options(populate_existing=True)
        )
        return result.scalars().all()

    async def reply_depth_for_parent(self, parent_id: uuid.UUID, *, max_depth: int) -> int | None:
        """Report how deep a reply to *parent_id* would sit, in one statement.

        The measurement behind ``app.services.comment_service.MAX_REPLY_DEPTH``. Depth is not a
        stored column, so it has to be derived by walking ``parent_id`` upwards - and walking it one
        generation per round trip is what this method exists to replace: the service used to follow
        the ``parent`` relationship in a loop, issuing a primary-key query per ancestor for every
        reply created. Here the walk is a recursive common table expression, so any depth costs one
        statement.

        It renders as::

            WITH RECURSIVE ancestry AS (
                SELECT id, parent_id, 1 AS depth FROM comments WHERE id = :parent_id
                UNION ALL
                SELECT c.id, c.parent_id, ancestry.depth + 1
                  FROM comments AS c, ancestry
                 WHERE c.id = ancestry.parent_id AND ancestry.depth <= :max_depth
            )
            SELECT max(depth) FROM ancestry

        Args:
            parent_id: The comment being replied to.
            max_depth: The caller's cap. The ascent stops one step past it, which is all the
                caller needs: the only question asked of the result is whether the cap has been
                exceeded, so the exact depth of a pathological chain is not worth the round trips
                to establish. Passed in rather than read from a constant here, because the cap is
                the service's rule - see :data:`MAX_THREAD_DEPTH` for the different bound this
                module does own.

        Returns:
            ``1`` when *parent_id* is a top-level comment, ``2`` when it is a reply to one, and so
            on - the depth a *reply to it* would occupy. Exact up to ``max_depth``; beyond that it
            returns the first value that exceeds the cap rather than the true depth. ``None`` when
            no comment carries that identifier, which the service reports as an invalid parent.

        Note:
            **The ascent is bounded, so a pathological chain cannot make the measurement expensive
            either.** ``depth <= max_depth`` on the recursive term stops the expression a step past
            the cap; a ten-thousand-deep chain written outside the request path is answered in the
            same one statement as a two-deep one.

            **It selects three columns, not entities.** No ``Comment`` is hydrated: the expression
            carries ``id``, ``parent_id`` and the counter, and the outer statement reduces them to a
            single integer. Nothing enters the session's identity map, so this measurement cannot
            leave a stale ancestor behind for a later read to find.

            **The access path is the primary key** at every step - ``c.id = ancestry.parent_id`` -
            so the ascent is an index probe per generation inside one statement rather than a scan.
        """
        anchor = select(
            Comment.id.label("id"),
            Comment.parent_id.label("parent_id"),
            literal(1).label("depth"),
        ).where(Comment.id == parent_id)
        ancestry = anchor.cte("ancestry", recursive=True)

        ancestor = aliased(Comment, name="ancestor")
        ancestry = ancestry.union_all(
            select(
                ancestor.id.label("id"),
                ancestor.parent_id.label("parent_id"),
                (ancestry.c.depth + 1).label("depth"),
            ).where(
                ancestor.id == ancestry.c.parent_id,
                # One step past the cap is enough to answer "has it been exceeded".
                ancestry.c.depth <= max_depth,
            )
        )

        # `max(...)` over an empty expression yields one row holding NULL rather than no rows, so
        # `scalar_one_or_none` returns None for an identifier that matches nothing - which is the
        # "no such parent" answer the service needs. The result is bound to an annotated local
        # because the aggregate's Python type is `Any` to the type checker, and binding it here is
        # what keeps this method's declared return type honest without a cast.
        result = await self.session.execute(select(func.max(ancestry.c.depth)))
        depth: int | None = result.scalar_one_or_none()
        return depth

    async def get_with_author(
        self, comment_id: uuid.UUID, *, for_update: bool = False
    ) -> Comment | None:
        """Fetch one comment with its byline loaded, optionally holding a row lock.

        The read behind every single-comment response. ``app.schemas.comment.CommentPublic`` and
        ``app.schemas.admin.AdminComment`` both render an author, and a lazy access under an
        ``AsyncSession`` raises ``MissingGreenlet`` - so the byline is requested here, in the layer
        that owns queries, rather than reached for from a service through ``awaitable_attrs``.

        Args:
            comment_id: The comment's identifier.
            for_update: Whether to take ``SELECT ... FOR UPDATE`` on the comment row. ``True`` for
                the read-check-write sequences behind edit, delete and moderation, so two requests
                that both read a comment and both decide to act on it cannot interleave between the
                read and the write.

        Returns:
            The comment with ``author`` loaded, or ``None`` when no row carries that key. Absence is
            not an error here - the service turns it into a ``404``.

        Note:
            **The lock covers ``comments`` and nothing else.** ``FOR UPDATE`` applies to the
            rows the primary statement returns; ``author`` arrives through ``selectinload``'s
            separate unlocked statement, so no account is held under a write lock because a byline
            had to be rendered.

            **``replies`` is deliberately left unloaded, and that is a security property.** The
            relationship is the ownership edge - one generation, unfiltered by moderation state - so
            handing a caller an unfiltered collection is precisely the leak
            :meth:`list_for_post` builds its status-filtered descent to prevent. A single-resource
            response carries no thread, so a router must project these entities with the explicit
            constructor form ``app.schemas.comment`` documents, leaving ``replies`` to its empty
            default rather than validating the whole model.

            **``populate_existing`` makes this a re-read.** Without it a caller could take the lock
            and then make its decision from a stale in-session copy, which is exactly the hazard the
            lock was acquired to remove.
        """
        stmt = select(Comment).where(Comment.id == comment_id)
        if for_update:
            stmt = stmt.with_for_update()
        result = await self.session.execute(
            stmt.options(
                selectinload(Comment.author).load_only(*_PUBLIC_AUTHOR_COLUMNS)
            ).execution_options(populate_existing=True)
        )
        return result.scalars().first()

    async def add_with_author(self, comment: Comment) -> Comment:
        """Insert a comment and return it with its byline loaded.

        What ``comment_service.create`` calls instead of
        :meth:`~app.repositories.base.UUIDPrimaryKeyRepository.add`. ``add`` flushes and refreshes,
        and a refresh expires every relationship, so a service that needed the byline afterwards had
        to load it itself - after its commit, which is what made a failed load able to leave a
        durable comment beside an error response.

        Args:
            comment: A transient comment built by the service from validated input, carrying no
                ``id`` - identity is ``gen_random_uuid()``'s.

        Returns:
            The same instance, persistent, with the generated ``id``, the audit timestamps and
            ``author`` loaded.

        Note:
            The INSERT is flushed here, so the three foreign keys and every constraint apply now
            and a violation surfaces at this call rather than at some later commit. Nothing is
            committed: the transaction boundary is the service's, and this method exists precisely
            so the service can finish assembling its response before committing.
        """
        self.session.add(comment)
        await self.session.flush()
        return await self.reload_with_author(comment)

    async def save_with_author(self, comment: Comment) -> Comment:
        """Flush a mutated comment and return it with its byline loaded.

        What the edit and moderation paths call instead of
        :meth:`~app.repositories.base.BaseRepository.save`. It replaces that method's ``refresh``
        rather than following it: :meth:`reload_with_author` re-reads every mapped column *and* the
        author in one statement, so the re-derived ``updated_at`` is current for the same reason
        ``refresh`` was mandatory, and the byline is present without a second round trip.

        Args:
            comment: A persistent comment already mutated in place. Calling this with nothing dirty
                is harmless: the flush emits no ``UPDATE`` and the re-read returns the row.

        Returns:
            The same instance, reloaded, with ``author`` loaded.
        """
        await self.session.flush()
        return await self.reload_with_author(comment)

    async def reload_with_author(self, comment: Comment) -> Comment:
        """Re-read one comment's columns and its byline in a single statement.

        The shared tail of :meth:`add_with_author` and :meth:`save_with_author`, and the answer to
        "who loads a relationship the response needs": this layer, as a statement, never a service
        reaching through ``awaitable_attrs``.

        Args:
            comment: A persistent comment. Only its ``id`` is read, so it is safe to call
                immediately after a flush when other attributes are expired.

        Returns:
            The same identity-mapped instance, with every column re-read and ``author`` populated.

        Raises:
            RuntimeError: The row is gone. Unreachable through the two callers - one has just
                inserted it, the other holds it under ``FOR UPDATE`` - so it is raised rather than
                returning ``None`` in order to keep both callers' return types non-optional instead
                of pushing an impossible branch into the service.
        """
        stmt = (
            select(Comment)
            .where(Comment.id == comment.id)
            .options(selectinload(Comment.author).load_only(*_PUBLIC_AUTHOR_COLUMNS))
            .execution_options(populate_existing=True)
        )
        result = await self.session.execute(stmt)
        reloaded = result.scalars().first()
        if reloaded is None:  # pragma: no cover - the caller holds the row in its transaction
            raise RuntimeError(f"comment {comment.id} vanished inside its own transaction")
        return reloaded

    async def load_visible_replies(
        self,
        root: Comment,
        *,
        statuses: Sequence[CommentStatus] | None,
    ) -> Comment:
        """Populate one comment's ``replies`` with its whole visible subtree, at every depth.

        The single-comment counterpart of :meth:`list_for_post`, and the second caller of
        :meth:`_descendants_of`. It exists for the mutating routes: ``PATCH
        /api/v1/comments/{comment_id}`` answers with a comment that may already have replies
        beneath it, and a response whose ``replies`` were left at their empty default would tell a
        client that the thread under the edited comment is empty. A client caching a thread and
        replacing the edited node with that answer would then drop every descendant from the
        rendered discussion - so the tree is loaded here rather than defaulted away.

        The subtree is narrowed by the *same* ``statuses`` argument :meth:`list_for_post` takes, and
        that is the whole reason this method exists instead of the relationship being read directly:
        :attr:`~app.models.comment.Comment.replies` is the unfiltered ownership edge - one
        generation, every moderation state - so following it would disclose a pending or rejected
        reply to a caller who may not see it, and would only ever reach one level deep.

        Args:
            root: A persistent comment whose own columns are populated. Only ``id`` is read to
                start the descent, so no lazy load can fire on the way in.
            statuses: The moderation states this caller may see, exactly as
                ``app.services.comment_service`` derived them for the owning post. ``None`` means
                every state. The value is applied to every level of the descent, so the subtree
                cannot be more visible than the thread listing would be for the same caller.

        Returns:
            The same instance, with ``replies`` populated to the full visible depth and every node
            in the subtree carrying its own ``author`` and its own ``replies`` - the shape
            ``app.schemas.comment.CommentPublic.model_validate`` may walk without touching an
            unloaded attribute.

        Note:
            **Two statements, whatever the depth**: one recursive descent and one batched
            ``selectin`` for the descendants' authors. The bound is the same one
            :meth:`_descendants_of` documents, and it is why walking
            :attr:`~app.models.comment.Comment.replies` generation by generation is not the
            alternative - that is one statement per level, and under an ``AsyncSession`` each level
            is a lazy load raising ``MissingGreenlet``.

            **A leaf is populated too, with an empty list.** :func:`_attach_replies` assigns to
            every node it is given, so a comment with no visible reply comes back with a loaded
            empty collection rather than an unloaded one - which is what makes the returned value
            safe to validate rather than merely usually safe.

            **Nothing is written.** The collection is set through
            :func:`~sqlalchemy.orm.attributes.set_committed_value`, so the instance is not made
            dirty and the ``delete-orphan`` cascade on that relationship cannot mistake an absent
            child for an orphan. :func:`_attach_replies` records that reasoning in full.
        """
        # One root, so the `IN` list is never empty and the call is never skipped - unlike
        # `list_for_post`, which has to guard against a page with no rows at all.
        descendants = await self._descendants_of([root.id], statuses=statuses)
        _attach_replies((root,), descendants)
        return root

    async def get_parent(
        self, parent_id: uuid.UUID, *, post_id: uuid.UUID, for_share: bool = False
    ) -> Comment | None:
        """Fetch a candidate parent comment, but only if it belongs to the given post.

        The lookup behind reply creation. ``comments.parent_id`` is a foreign key, so the database
        already guarantees that a parent exists; what it cannot guarantee without a redundant
        column is that the parent hangs off the *same post* as the reply. This method answers both
        questions in one statement, and answers them with a row or with ``None``.

        Args:
            parent_id: The identifier the client supplied as the comment being replied to.
            post_id: The post the reply is being written on. Keyword-only, so a call site cannot
                transpose the two identifiers - both are UUIDs, and a positional pair would
                type-check either way round while silently asking a different question.
            for_share: When ``True``, emit ``SELECT ... FOR SHARE`` so the parent row is locked
                for the rest of this transaction and is re-read rather than served from the
                identity map.

                Ask for it whenever the parent's *moderation state* is about to decide whether the
                reply may be written - which is every reply, because a reader may only answer a
                comment they are entitled to see. Without the lock that decision comes from an
                older ``READ COMMITTED`` snapshot than the insert it authorises, so a concurrent
                ``PATCH /api/v1/admin/comments/{id}/status`` could reject the parent, or a
                concurrent delete of an ancestor could cascade it away, between the check and the
                write - placing a reply beneath a parent no reader can reach, or surfacing the
                race as a driver-level foreign-key violation.

                A **shared** lock rather than an exclusive one, deliberately: it conflicts with the
                ``FOR UPDATE`` that ``comment_service``'s ``set_status`` and ``delete`` take on that
                same row, and with the cascade that removes it, which is the whole requirement -
                while remaining compatible with every other reader replying to the same popular
                comment, so a busy thread is not serialised behind one lock.

        Returns:
            The parent comment, or ``None``.

        Note:
            **``None`` deliberately conflates two cases.** "No such comment" and "that comment
            exists but is on another post" are one return value here, because distinguishing them
            is choosing an error, and choosing an error is not a repository's job.
            ``app.services.comment_service`` decides which of a ``404`` or a ``422`` the client is
            told, and it is the only layer with the context to decide. Nothing in this method
            raises.

            **Nothing is eager-loaded.** The caller is validating, not rendering: it needs the row
            and its ``post_id``, both of which are columns. Attaching loaders would fetch an author
            and a post that no response will contain.

            Built on :meth:`~app.repositories.base.BaseRepository.get_or_none` in the unlocked
            mode, so the statement - ``WHERE id = ... AND post_id = ... LIMIT 1`` - is composed in
            one place. The primary key resolves it, and the second term is a cheap filter on the
            row it finds.

            **The locked mode is composed here rather than in the primitive**, because
            ``get_or_none`` takes no lock argument and giving it one would offer every sibling
            repository a lock with no policy attached. The predicate is the same either way; only
            the locking clause and ``populate_existing`` differ.

            **The lock order is global and this is its ``comments`` half.** Locks are taken
            ``posts`` -> ``comments`` -> ``post_likes`` and never the reverse, so a caller reaching
            this method under ``for_share=True`` is already holding
            :meth:`~app.repositories.post_repository.PostRepository.get_for_share`'s shared lock on
            the owning post. That ordering - documented in full on ``get_for_share`` - is what keeps
            a reply from deadlocking against ``post_service.delete``, whose cascade locks comments
            while it holds ``FOR UPDATE`` on the post.
        """
        if not for_share:
            return await self.get_or_none(Comment.id == parent_id, Comment.post_id == post_id)

        result = await self.session.execute(
            select(Comment)
            .where(Comment.id == parent_id, Comment.post_id == post_id)
            .with_for_update(read=True)
            .execution_options(populate_existing=True)
        )
        return result.scalars().first()

    async def post_id_of(self, comment_id: uuid.UUID) -> uuid.UUID | None:
        """Report which post a comment hangs off, reading that one column and nothing else.

        A deliberately minimal read with one job: tell a caller *which* ``posts`` row it must lock
        before it locks the comment. ``app.services.comment_service.update`` needs the owning post
        to decide whether the actor may still see the thread it is about to edit and project, and
        the global lock order - ``posts`` -> ``comments`` -> ``post_likes``, documented on
        :meth:`~app.repositories.post_repository.PostRepository.get_for_share` - forbids it from
        discovering that identifier by locking the comment first. Reversing the order would close a
        cycle with ``post_service.delete``, which holds ``FOR UPDATE`` on a post while its cascade
        locks that post's comments, and the two transactions would deadlock rather than serialise.

        Args:
            comment_id: The comment's identifier, from the URL path.

        Returns:
            The owning post's identifier, or ``None`` when no comment carries that key. ``None``
            is not an error: the caller reports the missing comment the same way the locked read
            that follows would, and it is deliberately indistinguishable from a comment that is
            deleted a moment later.

        Note:
            **Unlocked, and safe precisely because ``comments.post_id`` never changes.** Nothing in
            the codebase assigns it after construction and
            ``app.schemas.comment.CommentUpdate`` exposes no ``post_id`` member, so a comment
            cannot be re-parented onto another article - which is what makes an unlocked read a
            sound way to choose a lock target. Everything else about the row *can* change, so
            nothing else may be read from here: this is not a substitute for
            :meth:`get_with_author`, and a caller still performs its authoritative, locked read
            afterwards.

            **One column, not an entity.** ``select(Comment.post_id)`` returns a scalar from the
            primary-key index without constructing a ``Comment``, attaching it to the identity map
            or loading a byline the caller has no use for yet. The authoritative read that follows
            carries ``populate_existing``, so nothing this method put in the session could shadow
            it in any case.
        """
        result = await self.session.execute(select(Comment.post_id).where(Comment.id == comment_id))
        return result.scalars().first()

    async def list_moderation_queue(
        self,
        *,
        statuses: Sequence[CommentStatus] | None = None,
        q: str | None = None,
        post_id: uuid.UUID | None = None,
        limit: int,
        offset: int,
    ) -> tuple[Sequence[Comment], int]:
        """Window the administrative comment table: every comment, newest first, filtered.

        Backs ``GET /api/v1/admin/comments``. Unlike :meth:`list_for_post` this includes comments
        at **every** depth - a reply is as moderable as a top-level comment, and a queue that
        omitted replies would leave the worst of them permanently unreachable - which is exactly
        why the two surfaces are separate methods rather than one with a flag. The three filters
        compose freely, and ``total`` counts the filtered set rather than the relation.

        Args:
            statuses: The moderation states to include, or ``None`` for every state. A single
                state is the ordinary case, and ``ix_comments_status`` serves it.
                :attr:`~app.models.comment.CommentStatus.PENDING` is the queue of work an
                administrator has still to do; :attr:`~app.models.comment.CommentStatus.REJECTED`
                is the record of decisions already taken.
            q: Optional case-insensitive containment match on the comment body. Whitespace-only
                and ``None`` are equivalent, and wildcards in the term are escaped so they match
                literally.
            post_id: Optional restriction to one post's comments, for moderating a single
                discussion.
            limit: Rows per page.
            offset: Rows to skip. Past the end this is an empty sequence beside the real total,
                not an error.

        Returns:
            ``(rows, total)`` - this page of comments with ``author`` loaded, and the number
            matching the filters. ``app.services.admin_service`` turns the pair into the wire
            envelope through ``build_page``.

        Note:
            **Newest first**, because the queue is worked from the top and a moderator wants the
            most recent submissions in front of them - the inverse of the thread ordering, and for
            the same reason inverted. ``id`` descending is the deterministic tiebreaker, required
            rather than decorative: ``created_at`` comes from a per-transaction clock, so a batch
            of comments written by one request shares an instant.

            **The byline is loaded because the table renders it; the post is not, because the
            table does not.** ``app.schemas.admin.AdminComment`` carries ``post_id`` - a column of
            the comment row - and no post object, so requesting ``Comment.post`` fetched an entire
            ``Post`` per distinct post on the page, body and search vector included, to serialise a
            UUID that was already in hand. ``author`` is requested, narrowed to the six public
            fields. Under an ``AsyncSession`` a lazy access would raise ``MissingGreenlet`` at
            render time, one layer away from the query that forgot to ask - which is what makes
            requesting exactly the response's needs, and nothing else, safe to do.

            **The search term is served by ``ix_comments_body_trgm``**, so the queue's text filter
            is an index scan rather than a pass over every comment ever written;
            :func:`_queue_criteria` records why the operator and the column type decide the
            spelling. It remains confined to this administrative surface, and must not be copied
            into the reader-facing thread, which is public and far busier.
        """
        predicates = _queue_criteria(statuses=statuses, q=q, post_id=post_id)

        rows_stmt = (
            select(Comment)
            .where(*predicates)
            .order_by(Comment.created_at.desc(), Comment.id.desc())
            # The byline only, narrowed to the six public author fields.
            #
            # `Comment.post` is deliberately NOT loaded. `app.schemas.admin.AdminComment` carries
            # `post_id` - a column of this row - and no post object at all, so loading the related
            # entity fetched a whole `Post` per distinct post on the page, including `content` (up
            # to 100,000 characters) and the `search_vector` derived from it, for a table that
            # renders none of it. An administrator who needs the article opens it by that id.
            #
            # selectinload rather than joinedload, though the relationship is many-to-one: one
            # strategy across this layer keeps the joinedload-against-a-collection trap -
            # multiplied rows, a wrong count and a mandatory `.unique()` - out of reach entirely,
            # and a batched IN lookup keyed on the page's foreign keys is one extra statement for
            # the whole page.
            .options(selectinload(Comment.author).load_only(*_PUBLIC_AUTHOR_COLUMNS))
        )

        count_stmt: Select[tuple[int]] = (
            select(func.count()).select_from(Comment).where(*predicates)
        )

        return await self.paginate(rows_stmt, limit=limit, offset=offset, count_stmt=count_stmt)

    async def count_comments(self, *, statuses: Sequence[CommentStatus] | None = None) -> int:
        """Count comments, optionally narrowed to a set of moderation states.

        Feeds the aggregate figures on ``GET /api/v1/admin/stats``, where the total and the size of
        the pending queue are two calls to this method with different arguments.

        Args:
            statuses: The moderation states to count, or ``None`` to count every comment regardless
                of state. ``None`` is the default because the administrative overview asks for the
                whole relation.

        Returns:
            The number of matching rows; ``0`` when nothing matches, never ``None``.

        Note:
            Counts comments at every depth, matching :meth:`list_moderation_queue` rather than
            :meth:`list_for_post`: an overview figure is about the volume of moderated content, and
            a reply is content.

            Delegates to :meth:`~app.repositories.base.BaseRepository.count`, which emits
            ``SELECT count(*)`` with no entity construction. It is deliberately not built on
            :meth:`list_moderation_queue`: a count needs neither a window, an ordering nor a loader
            option, and asking a listing for a total would pay for all three.
        """
        if statuses is None:
            return await self.count()
        return await self.count(Comment.status.in_(statuses))
