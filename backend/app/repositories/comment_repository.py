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

The reply loader carries the caller's status filter
---------------------------------------------------
``selectinload(Comment.replies.and_(...))`` is given the *same* status predicate as the parent
rows, built once by :func:`_status_criteria` and spread into both. Without it an unapproved reply
would reach a public caller through an approved parent - the parent passes the ``WHERE`` clause,
and an unfiltered collection loader then returns every child it has. That is the one leak this
module has to be written to avoid, and it is closed in the statement rather than by a caller
remembering to strip replies afterwards.

Verified against the pinned SQLAlchemy 2.0.51 and PostgreSQL 18.4 rather than assumed, because
the relationship is self-referential and the criteria therefore have to be adapted to the aliased
target of the ``selectin`` load: with a parent carrying one ``APPROVED`` and one ``PENDING``
reply, ``statuses=(CommentStatus.APPROVED,)`` returned the parent with exactly one reply loaded,
and ``statuses=None`` returned it with both.

Note the asymmetry that follows from the ``and_()`` criteria being *only* the status filter:
``parent_id IS NULL`` restricts the page, and it must not restrict the loader, or every replies
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

Ordering the loaded replies
---------------------------
``Comment.replies`` declares no ``order_by``, and a ``selectin`` load emits no ``ORDER BY`` of its
own, so the order PostgreSQL returns the collection in is unspecified. A thread reads forwards, so
the replies are put into ``(created_at, id)`` order by :func:`_sort_replies` after the window is
fetched - in Python, over rows that are already in memory, costing no additional statement. The
alternative would be one query per parent, which is precisely the N+1 pattern this layer exists to
prevent.

The sort is performed **in place with** :meth:`list.sort`, and that specific spelling is
load-bearing. Read out of SQLAlchemy 2.0.51's own collection instrumentation, the decorated list
methods are exactly ``__delitem__``, ``__iadd__``, ``__setitem__``, ``append``, ``clear``,
``extend``, ``insert``, ``pop`` and ``remove``; ``sort`` is not among them
(``InstrumentedList.sort is list.sort``), so an in-place sort produces no attribute history at
all - measured, with ``history.has_changes()`` ``False`` before and after and ``session.dirty``
empty, and the replies still present after a subsequent flush and commit. Slice assignment
(``collection[:] = sorted(collection)``) must **not** be used in its place: ``__setitem__`` *is*
instrumented, and :attr:`~app.models.comment.Comment.replies` carries
``cascade="all, delete-orphan"``, so the removal events it emits would mark every reply an orphan
and delete the thread on the next flush.

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
Two indexes serve this relation and each method is written to use one of them:

* :meth:`CommentRepository.list_for_post` filters ``post_id`` for equality and orders by
  ``created_at``, which ``ix_comments_post_id_created_at`` satisfies with one index - leading
  equality column, then sort column - so no separate sort step is needed for the leading keys.
* :meth:`CommentRepository.list_moderation_queue` filters ``status``, served by
  ``ix_comments_status``. Measured on PostgreSQL 18.4: the planner takes a bitmap index scan on
  that index for the queue's shape.
* :meth:`CommentRepository.get_parent` and the inherited ``get_by_id`` address the primary key.

No indexed column is ever wrapped in a function here. The one predicate with no index behind it is
the optional ``ILIKE`` containment search in the queue, and it is confined to the administrative
surface for exactly that reason - see :meth:`CommentRepository.list_moderation_queue`.

Deliberately absent
-------------------
No recursive common table expression. The requirement is threaded replies through a
self-referencing parent, and one eager-loaded level is that depth; a deeper level is reachable
through the same relation from the reply itself, so a hierarchical query would add a second way to
read the same edge. No reply-count aggregate: a count of a collection that is already loaded is
``len()`` at the layer that renders it. No moderation policy, no ownership rule, no sanitisation,
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
from sqlalchemy.orm import selectinload

from app.models.comment import Comment, CommentStatus
from app.repositories.base import BaseRepository

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


def _status_criteria(statuses: Sequence[CommentStatus] | None) -> list[ColumnElement[bool]]:
    """Build the moderation-state predicate, or none at all.

    Called once per listing and spread into every statement that listing builds - the rows select,
    the count select and, in :meth:`CommentRepository.list_for_post`, the reply loader's own
    criteria. One definition is what makes "the replies are filtered by the same statuses as their
    parents" true by construction instead of true by inspection.

    Args:
        statuses: The moderation states to include, or ``None`` for every state. ``None`` adds no
            predicate at all rather than a tautology for the planner to work around. An **empty**
            sequence is a different request and is honoured literally: ``IN ()`` renders as a
            guaranteed-false expression, so "include none of these states" yields no rows.

    Returns:
        Zero or one SQL boolean expression, to be combined with ``AND`` by the caller.

    Note:
        ``in_()`` on the native ``comment_status`` column, which leaves the column expression
        untouched and therefore keeps ``ix_comments_status`` usable. A single-member sequence
        renders as ``IN (...)`` rather than as ``=``; PostgreSQL plans the two identically.

        Which states a caller asks for is never decided here. A public thread narrows to
        :attr:`~app.models.comment.CommentStatus.APPROVED`, an author viewing their own post's
        thread may ask for more, and the moderation queue asks for a state or for all of them.
        Choosing between those is authority, and authority lives in
        ``app.services.comment_service``.
    """
    if statuses is None:
        return []
    return [Comment.status.in_(statuses)]


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
        The ``ILIKE`` containment match is the one predicate in this module with no index behind
        it: a leading wildcard cannot use a b-tree, and ``comments.body`` is unindexed ``TEXT``, so
        this term implies a sequential scan over the relation. That is acceptable **only** because
        it is reached by an authenticated administrator on a paginated table, and it must not be
        copied into the reader-facing thread, which is a public and far busier surface.

        ``ilike`` rather than ``lower(body) LIKE lower(:term)``: wrapping the column in a function
        is what would make an index on it unusable if one were ever added, and the operator states
        the intent at the call site.
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


def _sort_replies(parents: Sequence[Comment]) -> None:
    """Put each parent's already-loaded replies into thread order, in place.

    Runs after the window has been fetched and touches nothing but memory: the collections were
    populated by the ``selectinload`` in the statement, so this issues no SQL and cannot introduce
    an N+1. A parent with no replies is a no-op.

    Args:
        parents: The page of top-level comments returned by
            :meth:`~app.repositories.base.BaseRepository.paginate`, each with its ``replies``
            collection already loaded. Mutated in place; nothing is returned, because the caller
            already holds the rows.

    Note:
        :meth:`list.sort` is used deliberately and must not be replaced by slice assignment. The
        module docstring records the measurement behind that: ``sort`` is not among the methods
        SQLAlchemy 2.0.51 instruments on a collection, so it emits no attribute history, whereas
        ``__setitem__`` is instrumented and would make ``cascade="all, delete-orphan"`` delete the
        very replies being ordered.
    """
    for parent in parents:
        parent.replies.sort(key=_thread_order)


class CommentRepository(BaseRepository[Comment]):
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
        """Window one post's thread: top-level comments, each with its replies already loaded.

        Backs ``GET /api/v1/posts/{id}/comments``. A page is a page of *threads*: the window and
        the count are both over comments whose ``parent_id`` is ``NULL``, and a reply reaches the
        caller nested inside the parent it answers rather than as a row of its own. The module
        docstring sets out why in full - in short, counting replies as page members would let one
        appear on two consecutive pages and would leave ``total`` describing a set the client
        cannot reconstruct.

        Args:
            post_id: The post whose thread to read. Compared for equality against the leading
                column of ``ix_comments_post_id_created_at``, which serves the filter and the
                ordering together. A post that does not exist is not an error here - it simply has
                no comments, and whether that should be a ``404`` is the service's question to
                answer from the ``posts`` relation.
            statuses: The moderation states to include, and **the same filter is applied to the
                replies**. A public caller passes :attr:`~app.models.comment.CommentStatus.APPROVED`
                alone; an administrator, or an author reading their own post's thread, passes
                ``None`` for every state. ``None`` is the default because a repository must not be
                the thing that decides a caller's visibility - that is authority, and it belongs to
                ``app.services.comment_service``, which is also the only layer that knows who is
                asking.
            limit: Rows per page. Non-positive yields no rows rather than an invalid ``LIMIT``;
                request-supplied values are bounded to ``1..100`` by ``PageParams`` long before
                they arrive here.
            offset: Rows to skip. An offset past the end returns an empty sequence beside the real
                ``total``, never an error, which is how a client detects it has run off the end.

        Returns:
            ``(rows, total)`` - this page of top-level comments, each with ``author`` loaded and
            ``replies`` loaded, ordered and themselves carrying their authors, plus the number of
            top-level comments matching the filters. Deliberately not a ``Page``: the service
            projects the rows and calls ``build_page(list(rows), total, page, page_size)``.

        Note:
            **One predicate set, three uses.** :func:`_status_criteria` is called once and spread
            into the rows select, the count select and the reply loader's ``and_()`` criteria, so
            the three cannot disagree about which states are visible. The count restates nothing.

            **The reply loader carries the status filter but not the paging filter.**
            ``parent_id IS NULL`` narrows the page; adding it to the loader would return every
            replies collection empty, since a reply by definition has a parent.

            **The filter holds regardless of what the session already loaded.** The rows statement
            carries ``populate_existing``, so the loaders overwrite an existing instance's
            collection instead of skipping it. Without that option the guarantee would depend on
            the order of reads within one unit of work, and one of the two orders leaks - the
            measurement is recorded beside the option.

            **Bounded statements, whatever the page size.** Measured against SQLAlchemy 2.0.51:
            four statements for the rows path - the window, one batched ``selectin`` for the
            replies, one for the parents' authors and one for the replies' authors - plus the
            count, and none of them per row. ``selectinload`` is used for the many-to-one
            ``author`` as well as for the ``replies`` collection: it keys its extra ``SELECT`` on
            the parent identifiers, so it multiplies no rows, which is what lets the count be a
            plain ``count(*)`` and the rows need no ``.unique()``.

            **The replies are ordered after the fetch, not by a second query.**
            :func:`_sort_replies` orders collections that are already in memory; the module
            docstring records why the in-place :meth:`list.sort` spelling is the only safe one
            against ``cascade="all, delete-orphan"``.
        """
        status_criteria = _status_criteria(statuses)
        # `parent_id IS NULL` belongs to the PAGE, and only to the page. It is what makes a page
        # member a thread rather than a comment, so it goes into both statements below and into
        # neither loader.
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
            .options(
                selectinload(Comment.author),
                # The same status criteria as the page, adapted by SQLAlchemy to the aliased
                # target of the selectin load - which is what makes this correct on a
                # self-referential relationship. Verified on PostgreSQL 18.4: an unapproved reply
                # is absent from an approved parent's collection under a public status filter, and
                # present when the caller asks for every state. `and_()` with zero criteria is
                # legal and warning-free here (unlike the bare `sqlalchemy.and_()`, which is
                # deprecated with no arguments), so `statuses=None` needs no separate branch.
                selectinload(Comment.replies.and_(*status_criteria)).options(
                    selectinload(Comment.author)
                ),
            )
            # The status filter must hold whatever this unit of work has already loaded, so the
            # loaders are told to overwrite rather than to skip. Measured on SQLAlchemy 2.0.51:
            # without this option, a session that read the thread unfiltered and then read it
            # again through the public filter got the FIRST result back - `replies` was already
            # loaded, so the second statement's criteria were never applied and the unapproved
            # reply was returned to the filtered caller. That is the very leak this method is
            # written to prevent, so the guarantee must not depend on the order in which one
            # session happens to issue its reads. Autoflush runs before the SELECT, so a pending
            # modification is written and then read back rather than discarded.
            .execution_options(populate_existing=True)
        )

        # Identical predicates, no loader options and no ORDER BY: none of the three changes a
        # count, and the sort PostgreSQL would perform for a result nobody reads is pure cost.
        # Passed explicitly so `paginate` does not wrap the rows statement in a subquery of its
        # own - and so `total` is visibly a count of top-level comments.
        count_stmt: Select[tuple[int]] = (
            select(func.count()).select_from(Comment).where(*predicates)
        )

        parents, total = await self.paginate(
            rows_stmt, limit=limit, offset=offset, count_stmt=count_stmt
        )
        _sort_replies(parents)
        return parents, total

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

            **The search term is the one unindexed predicate in this module**, and it is confined
            here on purpose; :func:`_queue_criteria` records the reasoning at the call site.
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
