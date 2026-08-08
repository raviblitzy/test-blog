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

Deliberately absent
-------------------
No reply-count aggregate: a count of a collection that is already loaded is ``len()`` at the layer
that renders it. No depth cap: how deeply a reply may nest is a rule about what may be *created*,
and rules about creation live in ``app.services.comment_service``, so this module reads whatever
depth exists rather than truncating it. No moderation policy, no ownership rule, no sanitisation,
no logging - request correlation is bound once by ``app.middleware.request_context`` and the
services log against it. And no session or engine: a repository is *session-bound*, constructed
with the ``AsyncSession`` that ``app.core.dependencies.get_db`` yielded, so ``app.db.session`` is
not imported here.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import datetime
from typing import Final

from sqlalchemy import ColumnElement, Select, func, select
from sqlalchemy.orm import QueryableAttribute, aliased, selectinload
from sqlalchemy.orm.attributes import set_committed_value

from app.models.comment import Comment, CommentStatus
from app.repositories.base import UUIDPrimaryKeyRepository

__all__ = ["CommentRepository"]


_LIKE_ESCAPE: Final = "\\"
"""The escape character :func:`_containment_pattern` uses inside its ``LIKE`` pattern.

Declared once and passed to the ``ilike()`` call built from it. A pattern escaped with one
character and matched with another is not a subtle bug - it is a moderator's search silently
treating their ``%`` as a wildcard.
"""


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

    The in-memory half of :meth:`CommentRepository.list_for_post`. The recursive statement returns
    a post's descendants as one flat sequence, and this function turns that sequence into the
    nested shape ``app.schemas.comment.CommentPublic`` serialises, by grouping each row under the
    identifier in its own ``parent_id`` and sorting each group into thread order.

    It issues **no SQL at all** and cannot: every value it reads - ``id``, ``parent_id``,
    ``created_at`` - is a column of a row already fetched, and every value it writes is written
    through :func:`~sqlalchemy.orm.attributes.set_committed_value`.

    Args:
        roots: This page of top-level comments.
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

    Four methods, and between them they back every comment-shaped surface in the API::

        GET  /api/v1/posts/{id}/comments   -> list_for_post(post_id, statuses=(APPROVED,), ...)
        POST /api/v1/posts/{id}/comments   -> get_parent(...) to validate a reply, then add(...)
        GET  /api/v1/admin/comments        -> list_moderation_queue(...)
        GET  /api/v1/admin/stats           -> count_comments()

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

        **Depth is not capped.** ``comments.parent_id`` puts no bound on how deeply a reply may
        nest, ``app.schemas.comment.CommentPublic.replies`` is recursive without limit, and a
        reply to a reply is therefore an ordinary, storable comment. So this method returns the
        entire subtree under each root: the descendants come from one recursive common table
        expression over ``parent_id``, and :func:`_attach_replies` nests them. Loading only the
        first level would drop every deeper reply from the response with nothing raised and
        nothing logged - the comment would be in the database, visible in the moderation queue,
        and permanently invisible to the reader it answers.

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
            ``(rows, total)`` - this page of top-level comments, each with ``author`` loaded and
            its complete ``replies`` tree loaded and ordered, every node in that tree also carrying
            its own ``author`` and its own ``replies``, plus the number of top-level comments
            matching the filters. Deliberately not a ``Page``: the service projects the rows and
            calls ``build_page(list(rows), total, page, page_size)``.

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

            **Bounded statements, whatever the page size or the depth.** Measured against
            SQLAlchemy 2.0.51: five in total - the count, the roots window, one batched
            ``selectin`` for the roots' authors, one recursive statement returning every descendant
            at every depth, and one batched ``selectin`` for those descendants' authors. None of
            them is per row and none is per level, which is the property a recursive CTE buys over
            walking :attr:`~app.models.comment.Comment.replies` one generation at a time - that
            would be one statement per level, and under an ``AsyncSession`` each of those levels
            would be a lazy load raising ``MissingGreenlet`` instead. ``selectinload`` is used for
            the many-to-one ``author`` as well: it keys its extra ``SELECT`` on the fetched
            identifiers, so it multiplies no rows, which is what lets the count be a plain
            ``count(*)`` and the rows need no ``.unique()``.

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
            # The byline every rendered comment needs. `replies` is deliberately NOT loaded here:
            # a relationship loader can only follow one generation, and this thread has no depth
            # limit, so the whole subtree is fetched by `_descendants_of` below instead.
            .options(selectinload(Comment.author))
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
        """Fetch every comment below *root_ids*, at any depth, in one statement.

        The recursive half of :meth:`list_for_post`, kept separate so that the paging statement and
        the descent statement are each readable on their own. It renders as::

            WITH RECURSIVE comment_descendants AS (
                SELECT ... FROM comments
                 WHERE parent_id IN (:roots) AND status IN (:states)      -- anchor
                UNION ALL
                SELECT reply.* FROM comments AS reply, comment_descendants
                 WHERE reply.parent_id = comment_descendants.id
                   AND reply.status IN (:states)                          -- recursive term
            )
            SELECT ... FROM comment_descendants

        Args:
            root_ids: The identifiers of this page's top-level comments. Never empty - the caller
                skips the call rather than issuing an empty ``IN``.
            statuses: Exactly what :meth:`list_for_post` received, so the tree and its roots cannot
                disagree about what is visible. The predicate is built from it for **both** terms:
                on the anchor it filters the first generation, and on the recursive term it filters
                every generation after it and prunes whatever hangs below an excluded comment.

        Returns:
            The descendants as a flat sequence, each with ``author`` loaded, in no particular
            order - :func:`_attach_replies` nests and sorts them. Empty when no root has a reply
            the caller may see.

        Note:
            **The rows are hydrated straight out of the common table expression.** The anchor
            selects the whole entity, so the expression carries every mapped column, and
            :func:`~sqlalchemy.orm.aliased` maps it back onto :class:`~app.models.comment.Comment`.
            That makes this one statement rather than two: selecting only identifiers here would
            need a second pass over ``comments`` to fetch the rows behind them.

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

            **Termination is structural.** ``comments.parent_id`` is acyclic in practice because a
            reply names a comment that already existed when it was written, so the working set
            shrinks to nothing and the expression stops. ``UNION ALL`` rather than ``UNION``
            because the tree admits no duplicate - each comment has exactly one parent, so it is
            reached exactly once - and ``UNION`` would pay for a de-duplication that can never
            remove a row.
        """
        anchor = select(Comment).where(
            Comment.parent_id.in_(root_ids),
            *_status_criteria_on(Comment.status, statuses),
        )
        descent = anchor.cte("comment_descendants", recursive=True)

        reply = aliased(Comment, name="reply")
        descent = descent.union_all(
            select(reply).where(
                reply.parent_id == descent.c.id,
                *_status_criteria_on(reply.status, statuses),
            )
        )

        node = aliased(Comment, descent, name="descendant")
        result = await self.session.execute(
            select(node)
            .options(selectinload(node.author))
            .execution_options(populate_existing=True)
        )
        return result.scalars().all()

    async def get_parent(self, parent_id: uuid.UUID, *, post_id: uuid.UUID) -> Comment | None:
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

            Built on :meth:`~app.repositories.base.BaseRepository.get_or_none`, so the statement -
            ``WHERE id = ... AND post_id = ... LIMIT 1`` - is composed in one place. The primary
            key resolves it, and the second term is a cheap filter on the row it finds.
        """
        return await self.get_or_none(Comment.id == parent_id, Comment.post_id == post_id)

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
            ``(rows, total)`` - this page of comments with ``author`` and ``post`` loaded, and the
            number matching the filters. ``app.services.admin_service`` turns the pair into the
            wire envelope through ``build_page``.

        Note:
            **Newest first**, because the queue is worked from the top and a moderator wants the
            most recent submissions in front of them - the inverse of the thread ordering, and for
            the same reason inverted. ``id`` descending is the deterministic tiebreaker, required
            rather than decorative: ``created_at`` comes from a per-transaction clock, so a batch
            of comments written by one request shares an instant.

            **Both relationships are loaded because the table renders both.** Each row shows who
            wrote the comment and which post it is on, so ``author`` and ``post`` are requested in
            the statement. Under an ``AsyncSession`` a lazy access would raise ``MissingGreenlet``
            at render time, one layer away from the query that forgot to ask.

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
            # selectinload for both, though both are many-to-one: one strategy across this layer
            # keeps the joinedload-against-a-collection trap - multiplied rows, a wrong count and
            # a mandatory `.unique()` - out of reach entirely, and a batched IN lookup keyed on
            # the page's foreign keys is at most two extra statements for the whole page.
            .options(selectinload(Comment.author), selectinload(Comment.post))
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
