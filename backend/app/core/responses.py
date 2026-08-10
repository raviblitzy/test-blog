"""The one response class every route and every error handler serialises through.

``orjson`` is pinned for exactly one purpose, stated in AAP §0.5.2: "Fast JSON serialisation
used as the default response class". This module is that class. ``app.main`` installs it as
the application's ``default_response_class`` and ``app.core.exceptions`` returns it from every
error handler, so the success path and the failure path share one serialiser rather than two -
which is the property that makes the response contract uniform in *bytes* and not merely in
shape.

Why the project owns this class instead of importing FastAPI's
--------------------------------------------------------------
FastAPI shipped ``fastapi.responses.ORJSONResponse`` and, as of the pinned 0.141.1, deprecates
it: the framework now serialises directly to JSON bytes through Pydantic when a route declares
a response model, so its own orjson class has no remaining purpose *for a route that declares
one*. Naming the deprecated class was therefore a standing cost with two edges, both measured
rather than assumed:

* Every construction emitted a ``FastAPIDeprecationWarning``. Under the test suite that is
  1,106 identical lines per run - enough to bury a genuinely new warning, which is the only
  reason the warning channel is worth having. In a live process Python's ``default`` filter
  dedups per code location, so it was 4 records rather than a flood, but they were emitted at
  ``level="warning"`` with a ``request_id`` attached, which is precisely the shape an operator
  is meant to be able to trust.
* Deprecated becomes removed. The class disappearing from a future FastAPI would have taken
  the error contract with it, because ``app.core.exceptions`` renders every problem document
  through it.

Dropping orjson instead was not open: AAP §0.5.2 makes it the default response class, and the
uniformity that gives the error path is not something the framework's Pydantic serialisation
can supply - a problem document is a plain ``dict`` assembled by hand (``app.core.exceptions``
deliberately does not import ``app.schemas``, to keep ``app.core`` free of cycles), so no
response model exists for Pydantic to serialise it through.

So the class lives here, over ``starlette.responses.JSONResponse``, with the same ``render``
body FastAPI's carried. The name is kept identical on purpose: it is a drop-in replacement, the
two modules that use it change only their import line, and every docstring across the backend
that already describes "the ``ORJSONResponse`` bodies" stays true. What changes is ownership -
this class is the project's, it is not deprecated, and it cannot be withdrawn from underneath
the error contract by a dependency bump.

What this module is not
-----------------------
It is not a place for response *helpers*. There is no ``json_response()`` function, no
envelope builder and no status-code convenience wrapper: collections are shaped by
``app.core.pagination``, error bodies by ``app.core.exceptions``, and every route declares its
own ``response_model``. Adding a second way to build a body here would reintroduce exactly the
inconsistency the uniform contract exists to remove.

Layering
--------
``app.core`` is the bottom layer of the backend, and this is the smallest module in it. It
imports the standard library, ``orjson`` and Starlette - nothing from ``app`` at all, not even
``app.core.config``. It reads no environment variable, opens no connection and holds no state,
so it can be imported from anywhere without ordering consequences.
"""

from typing import Any, Final

import orjson
from starlette.responses import JSONResponse

__all__ = [
    "ORJSON_OPTIONS",
    "ORJSONResponse",
]


ORJSON_OPTIONS: Final[int] = orjson.OPT_NON_STR_KEYS | orjson.OPT_SERIALIZE_NUMPY
"""The option mask :meth:`ORJSONResponse.render` serialises with.

Identical to the mask the retired ``fastapi.responses.ORJSONResponse`` used, so the bytes on
the wire are unchanged by the ownership move - which is what let the swap be verified by
comparing response bodies rather than by trusting it.

* ``OPT_NON_STR_KEYS`` serialises a mapping whose keys are not strings - a ``UUID``, an ``int``,
  an ``Enum`` - instead of raising. Most bodies reach this class already reduced to primitives
  by FastAPI's field serialisation, but a handler that returns a plain dict is not reduced by
  anything, so without this flag such a body would fail at render time as a 500 with no useful
  message.
* ``OPT_SERIALIZE_NUMPY`` is inert here and kept deliberately: ``numpy`` is not among the
  eighteen runtime pins and no response carries an array, so the flag never fires. It costs a
  bit in a mask that is computed once at import, and keeping it means this mask is provably the
  same mask as before rather than nearly the same.
"""


class ORJSONResponse(JSONResponse):
    """A JSON response rendered by ``orjson``, owned by this project.

    Behaviourally identical to the deprecated class it replaces, including the inherited
    ``media_type`` of ``application/json``: nothing here overrides it, so the media type this
    class advertises to FastAPI's OpenAPI generation - which reads ``response_class.media_type``
    to key each operation's ``content`` block - is exactly what the generated document carried
    before. A handler that needs a different media type passes ``media_type=`` per response,
    which is how ``app.core.exceptions`` emits ``application/problem+json`` while still
    serialising through this class.

    Construction emits no warning of any kind, which is the point: the backend's warning
    channel is a signal again, so a future deprecation from any dependency is visible in a
    suite run instead of being one line among a thousand.
    """

    def render(self, content: Any) -> bytes:
        """Serialise *content* to the JSON bytes of the response body.

        Args:
            content: The already-encoded body. For a route this is what FastAPI produced from
                the declared ``response_model``; for an error it is the problem document
                ``app.core.exceptions`` assembled.

        Returns:
            The body as UTF-8 JSON bytes. ``orjson`` emits bytes directly, with no intermediate
            ``str`` and no re-encode, which is the whole reason it is pinned.
        """
        return orjson.dumps(content, option=ORJSON_OPTIONS)
