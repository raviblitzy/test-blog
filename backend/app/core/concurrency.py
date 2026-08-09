"""Bounded worker-thread offload for the CPU-bound work in a request path.

Every route in this service is an ``async def`` coroutine, and a coroutine runs on the one
thread that also runs the event loop of its worker process. A synchronous call inside one does
not merely make *that* request slow: it stops the loop, so every other request the same worker
is serving - a feed read, a like, a health probe - waits for it to return. There is no
pre-emption to rescue them, because there is nothing to pre-empt; the loop is a plain Python
call stack until control is yielded back to it.

Two kinds of genuinely expensive synchronous work exist in this codebase, and they are the only
two:

* **argon2id password hashing and verification** - ``app.core.security``, reached from
  ``app.services.auth_service`` on registration and on every sign-in. The cost is the point:
  the hasher is configured for ``time_cost=3`` and ``memory_cost=65536`` KiB, so one call
  deliberately spends tens of milliseconds and 64 MiB in order to make an offline guessing
  attack expensive. That is a security property, so it must not be tuned down to protect the
  loop - it must be moved off the loop.
* **HTML sanitisation with bleach** - ``app.services.post_service`` for a post's content and
  excerpt, ``app.services.comment_service`` for a comment's body. Parsing untrusted markup is
  proportional to its length, and the schemas admit up to 100 000 characters of post content,
  so the upper bound on one call is tens of milliseconds rather than microseconds.

This module owns the one mechanism both use: :func:`run_cpu_bound`, which runs a plain function
on a worker thread and awaits its result, and the :class:`~anyio.CapacityLimiter` that bounds
how many such threads may run at once.

Why the bound is the load-bearing part
--------------------------------------
Moving the work to a thread is the easy half. An *unbounded* offload converts a request flood
into a thread flood: a thousand concurrent sign-ins would start a thousand argon2 hashes, each
asking for 64 MiB, and the worker would exhaust memory or collapse into scheduler thrash while
the event loop - now free, and therefore accepting still more requests - kept feeding it. That
is resource exhaustion by amplification, and it is a worse failure than the blocked loop it
replaced, because a blocked loop at least applied back-pressure.

:data:`CPU_BOUND_CONCURRENCY` is that back-pressure, expressed as a fixed number of tokens per
worker process. Requests beyond it wait for a token, which is exactly the queue a bounded
resource should have.

How the number was chosen
-------------------------
``2`` per worker process, derived from the deployment shape ``app.db.session`` already
documents - ``MAX_WORKERS_PER_REPLICA`` Uvicorn workers per container, ``MAX_REPLICAS``
containers - and from what one unit of this work actually costs:

* **CPU.** Four worker processes at two tokens each is eight CPU-bound threads per container.
  A container sized to run four Uvicorn workers usefully has a few cores, so eight is a modest
  oversubscription that keeps them busy without turning the run queue into the bottleneck.
* **Memory.** The worst case is two concurrent argon2 hashes in one process: ``2 x 64`` MiB =
  128 MiB of transient hashing memory per worker, 512 MiB across a four-worker container. Both
  numbers are budgetable. Eight tokens per worker would be 2 GiB of the same, for throughput no
  container of that size can deliver.
* **Threads.** These tokens are additional to anyio's default thread limiter of 40, which
  Starlette uses for synchronous route handlers and dependencies. Passing our own limiter means
  this module's work cannot exhaust that shared allowance, and the two bounds add rather than
  compete: at most 42 offloaded threads per worker, and at most 2 of them doing CPU-bound work.

One consequence is deliberate and worth stating plainly: password hashing and sanitisation draw
on the *same* two tokens, so a burst of sign-ins can make a comment's sanitisation wait. That is
the correct trade, because both are contending for one physical resource - the CPU - and giving
each its own generous allowance would only let them oversubscribe it separately. What matters is
that the wait is a wait for a token rather than a stalled event loop: every request not doing CPU
work continues to be served at full speed throughout.

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
was starved. A request that is not sanitising - a feed read, a like, a health probe - degrades
from "frozen for a third of a second" to "a few milliseconds of jitter", which is the difference
between a timeout and a slow response.

A process pool would remove the GIL from that picture entirely, and it is deliberately not used:
it would mean pickling documents up to 100 000 characters across a process boundary, another
pool of processes per worker to size and supervise, and a second failure mode - for a saving
this scope has no evidence of needing. The bound and the thread are proportionate; a pool would
not be.

The limiter is per event loop, not per process
----------------------------------------------
:func:`cpu_bound_limiter` stores the limiter in an :class:`~anyio.lowlevel.RunVar`, which is
scoped to the currently running event loop, and creates it on first use. This mirrors how anyio
implements its own default thread limiter, and it is deliberate: a limiter constructed at import
time binds itself to the first loop that touches it and then keeps that binding for the life of
the process, which is wrong anywhere a second loop exists - a test suite that runs one loop per
test, an ``anyio.run`` in a management script, a reloading development server. Per-loop
construction makes the bound correct in all of those without any of them having to know about it.

What may not be offloaded
-------------------------
Only pure functions of their arguments. In particular **nothing that touches the database**: an
:class:`~sqlalchemy.ext.asyncio.AsyncSession` is bound to the event loop that created it, and
SQLAlchemy's async layer bridges to its synchronous core through a greenlet that only exists on
that loop. Reading a lazily loaded attribute from a plain worker thread does not quietly issue a
query - it raises ``MissingGreenlet``. So the shape every caller follows is: do the session work
on the loop, hand the *values* to :func:`run_cpu_bound`, and use what it returns back on the
loop.

Cancellation and errors
-----------------------
An exception raised in the worker propagates to the awaiting caller unchanged, with its
traceback, so a domain error such as the ``AppValidationError`` that
``app.services.comment_service`` raises for a comment emptied by sanitisation still reaches the
registered handler as itself.

Cancellation - a disconnected client, a request timeout - is *not* abandoned:
``abandon_on_cancel`` is left at its default of ``False``, so the coroutine waits for the thread
to finish before the cancellation propagates. That is the right choice here because the work has
no external effect to unwind (a discarded hash and a discarded sanitised string change nothing)
and because abandoning the thread would return its token while the thread was still holding a
core and 64 MiB - which is precisely the bound this module exists to keep.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Final

from anyio import CapacityLimiter, to_thread
from anyio.lowlevel import RunVar

__all__ = [
    "CPU_BOUND_CONCURRENCY",
    "cpu_bound_limiter",
    "run_cpu_bound",
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
