"""A ceiling on request body size, applied before anything reads or parses the body.

This middleware refuses a request whose body is larger than
``settings.MAX_REQUEST_BODY_BYTES``. It reads no body itself, allocates nothing proportional to
one, and adds a single integer comparison to every request that is not oversized.

Why a middleware and not a validator
------------------------------------
Every bound this API places on request *content* is declared on a schema - ``posts.content`` at
100 000 characters, a comment body at 5 000 - and each of those is enforced by Pydantic. All of
them are enforced too late to be a limit on *size*, because a schema cannot run until the body
has been read, decoded and parsed into the object it validates. Starlette buffers the whole body
before that happens; ``app.core.rate_limit`` throttles the authentication routes, but its
decorator runs on the handler, which is later still. So a single request declaring a hundred
megabytes of JSON was read in full, held in memory in full, and handed to a parser, before the
first rule that could object to its size ran - and an unauthenticated caller could issue it, in
parallel, against any route that takes a body. Bounding the field is not bounding the request.

The refusal therefore has to happen where no body has been read yet, and that is here.

Two checks, because a body can be oversized in two different ways
-----------------------------------------------------------------
* **A declared length.** ``Content-Length`` is compared to the ceiling before the application is
  called at all, so an oversized body is refused without a single byte of it being consumed.
  This is the ordinary case: every HTTP client that knows the size of what it is sending declares
  it, and a client that is lying about it is caught by the second check.
* **A delivered length.** A chunked body carries no ``Content-Length`` at all, and a client is free
  to declare one that is wrong. So the body is drawn from ``receive`` **here**, into a buffer this
  middleware bounds at the ceiling plus one byte, before the application is called: if the delivered
  total crosses the ceiling the request is refused and the remainder is never read. The count is of
  bytes actually delivered, which is what makes a misdeclared length no more useful than an honest
  one.

Both refusals raise :class:`~app.core.exceptions.RequestBodyTooLargeError`, so both render the one
problem document this API answers every failure with - the same ``type``, ``title``, ``status`` and
``request_id`` shape as a 404 or a 422. Neither states the ceiling: a limit quoted back to a caller
is a limit they can sit exactly beneath, and the published figure belongs in the API documentation
rather than in the response to whoever was probing for it.

Why the body is drawn here rather than counted on its way past
--------------------------------------------------------------
The obvious implementation - wrap ``receive``, count the chunks, and raise once the total is
exceeded - is wrong on this stack, and the way it fails is worth recording because it looks correct
in review and in a unit test.

Raising from inside ``receive`` means raising inside the read the *endpoint* is awaiting, and
FastAPI guards that read: ``fastapi.routing`` wraps body retrieval in ``try/except Exception`` and
re-raises anything that is not an ``HTTPException`` as ``HTTPException(400, "There was an error
parsing the body")``. So a 413 raised there was answered to the client as a **400**, with a detail
describing a parsing failure that had not happened. Measured, not assumed: the declared-length
check answered ``413 /errors/content-too-large`` while the streamed one answered ``400 /errors/bad-
request``. Returning ``http.disconnect`` instead fails the same way, because Starlette turns it
into ``ClientDisconnect`` and that is an ``Exception`` too.

Drawing the body here moves the decision *above* the framework entirely. The refusal is raised from
:meth:`BodyLimitMiddleware.__call__`, where nothing between this middleware and the exception
wrapper can reinterpret it, and the application is never called at all for a request that is
refused. The buffer is bounded by the very ceiling being enforced - at most ``max_body_bytes + 1``
bytes are ever held - so this is not a reintroduction of the unbounded buffering the module exists
to prevent; it is that buffering, made finite, and moved to the one place that can refuse.

Position in the stack - a requirement, not a preference
-------------------------------------------------------
Registered **first** in ``app.main.create_app``, which makes it the innermost of the added
wrappers, immediately outside the framework's own exception middleware::

    RequestContextMiddleware        <- the request already has its identifier
      SecurityHeadersMiddleware     <- the 413 is hardened like every other response
        CORSMiddleware              <- the 413 carries Access-Control-Allow-Origin
          ExceptionMiddleware       <- renders the refusal as the problem document
            BodyLimitMiddleware     <- HERE
              Router -> endpoint

Every layer above it is load-bearing for the refusal itself. Inside ``CORSMiddleware``, so a
browser can read the document instead of reporting an opaque cross-origin failure. Inside
``SecurityHeadersMiddleware``, so a rejected request is hardened exactly like a successful one.
Inside ``RequestContextMiddleware``, so the 413 carries the correlation identifier an operator
needs to find it - a burst of them is precisely the event worth correlating. And inside the added
``ExceptionMiddleware``, which is what renders the raised error: the framework's own exception
middleware sits *below* every added wrapper and therefore cannot see a failure raised by one, so
``app.core.exceptions.inner_exception_handlers`` registers :class:`AppError` on the added one for
this exact reason.

Being innermost also means it is not on the path of an ``OPTIONS`` preflight, which
``CORSMiddleware`` answers by itself. That is correct rather than a gap: a preflight carries no
body to bound.

What it deliberately does not do
--------------------------------
It does not enforce a limit the server has already enforced. A production deployment normally
bounds request size at the reverse proxy as well, and that bound is the first line; this one exists
because the application must not depend on a proxy it cannot see, and because the development and
test servers have no proxy in front of them at all.

It does not inspect the method. A ``GET`` with a body is unusual but legal, and a request that
carries one is bounded whatever its verb - special-casing methods would leave a hole behind
whichever verb was left off the list.

It does not decode, parse, alter or log the body. The bytes it draws are replayed to the
application exactly as they arrived, in the same chunks, so a route receives what the client sent
and nothing here can change what a schema then validates.
"""

from __future__ import annotations

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.exceptions import RequestBodyTooLargeError

__all__ = ["BodyLimitMiddleware"]


#: The header a client uses to declare the size of the body it is about to send.
#:
#: Lower-cased, because ASGI delivers header names lower-cased and
#: :class:`~starlette.datastructures.Headers` compares case-insensitively either way. Named as a
#: constant so the declared-length check and its docstring cannot come to disagree about which
#: header is being read.
_CONTENT_LENGTH_HEADER: str = "content-length"

#: The ASGI message type that carries a chunk of the request body.
_HTTP_REQUEST_MESSAGE: str = "http.request"


class BodyLimitMiddleware:
    """Pure-ASGI middleware that refuses a request body larger than a configured ceiling.

    Written against the raw ASGI interface rather than ``BaseHTTPMiddleware``, and here that is
    not a performance preference but the only way the thing can work. ``BaseHTTPMiddleware``
    hands a subclass a ``Request`` object, and reading a body through it is what this middleware
    exists to prevent happening before the size is known; wrapping ``receive`` requires the raw
    interface. It also means a body is forwarded chunk for chunk, so a route sees exactly the
    bytes the client sent.

    One instance serves the whole process, and it holds no per-request state: the byte counter
    and the wrapped ``receive`` are created inside :meth:`__call__`, as locals of that call, so
    two concurrent requests cannot see each other's totals.
    """

    def __init__(self, app: ASGIApp, *, max_body_bytes: int) -> None:
        """Bind the middleware to the application it wraps and to its ceiling.

        Args:
            app: The next application in the chain - the added ``ExceptionMiddleware``'s inner
                app in practice. Called unchanged for every request that is not oversized.
            max_body_bytes: The largest body, in bytes, that may be read. Keyword-only and
                **required**: a default here would be a second definition of the limit, and the
                one in ``app.core.config`` is the one an operator can set. ``app.main`` passes
                ``settings.MAX_REQUEST_BODY_BYTES``, which is validated at startup to be at
                least 64 KiB, so this class does no range checking of its own - a value that
                reached here has already been rejected if it was unusable.
        """
        self.app = app
        self.max_body_bytes = max_body_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Refuse an oversized body, and otherwise forward the request with its body intact.

        Args:
            scope: The connection scope. Anything that is not ``http`` - a lifespan message, a
                WebSocket handshake - is forwarded without inspection, because neither carries a
                request body and neither has a ``Content-Length`` to read.
            receive: The channel the body arrives on. Drawn from here, up to the ceiling plus one
                byte, and then replayed to the application unchanged.
            send: The channel the response leaves on. Forwarded untouched: this middleware emits no
                response of its own, because the refusal is an exception and the added
                ``ExceptionMiddleware`` above renders it.

        Raises:
            RequestBodyTooLargeError: The declared ``Content-Length`` exceeds the ceiling, or the
                delivered body did. Rendered as the 413 problem document by the handler registered
                in ``app.core.exceptions.inner_exception_handlers``.
        """
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # The declared length, checked first and before a single byte is drawn. This is the fast
        # path for the ordinary case: a client that knows it is sending a hundred megabytes says so,
        # and is refused without the body being read at all. A malformed or absent value is simply
        # not a declaration - `int()` raising means the header cannot be trusted as a length - and
        # the delivered count below is what bounds the request in that case.
        declared = Headers(scope=scope).get(_CONTENT_LENGTH_HEADER)
        if declared is not None:
            try:
                declared_bytes = int(declared)
            except ValueError:
                declared_bytes = None
            if declared_bytes is not None and declared_bytes > self.max_body_bytes:
                raise RequestBodyTooLargeError

        # Locals of this call, never attributes: one instance of this class serves the whole
        # process, so a buffer or a counter held on `self` would be shared between concurrent
        # requests and would refuse one of them for another's traffic.
        buffered: list[Message] = []
        received = 0

        while True:
            message = await receive()

            if message["type"] != _HTTP_REQUEST_MESSAGE:
                # `http.disconnect` in practice. It carries no body, and it ends the stream: there
                # is nothing further to draw, and it must be replayed so the application learns the
                # client is gone rather than waiting for a body that will never arrive.
                buffered.append(message)
                break

            received += len(message.get("body", b""))
            if received > self.max_body_bytes:
                # Refused HERE, from the middleware body, which is the entire reason the body is
                # drawn in this loop rather than counted on its way to the endpoint: raised inside
                # the endpoint's own read, this exception is caught by FastAPI's body-parsing guard
                # and re-reported as a 400 about a parsing error that never happened. Raised here,
                # nothing between this line and the exception wrapper can reinterpret it.
                #
                # The remainder is never read. The loop exits with the bytes still in flight
                # belonging to the connection rather than to this process, and `buffered` is
                # discarded with the frame - so at most one chunk beyond the ceiling was ever held.
                raise RequestBodyTooLargeError

            buffered.append(message)
            if not message.get("more_body", False):
                # The end of the body, as the server declared it. Trusting this flag rather than
                # reading until the channel is exhausted is what keeps a request with no body - a
                # GET, a DELETE - to the single `receive()` call the application would have made.
                break

        # Replayed in the order it arrived, chunk for chunk, so the application reads exactly what
        # the client sent. `iter` over the buffered list gives each message exactly once.
        replay = iter(buffered)

        async def buffered_receive() -> Message:
            """Hand the application the drawn body, then defer to the real channel.

            Returns:
                The next buffered message while any remain, and thereafter whatever the underlying
                channel produces - which is how an application that keeps reading after the body is
                complete still observes a later ``http.disconnect``.
            """
            return next(replay, None) or await receive()

        await self.app(scope, buffered_receive, send)
