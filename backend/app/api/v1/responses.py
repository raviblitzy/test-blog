"""The published error contract, declared once for every route in the service.

Two things in this API are uniform by design and were, until this module existed, restated by
hand in nine files: every failure at every status returns one
:class:`~app.schemas.common.ProblemDetail` document, and every one of those documents is served
as ``application/problem+json``. Nine copies of ``{"model": ProblemDetail, "description": ...}``
is nine chances to omit the model - which publishes a status with no body schema at all - and no
number of copies could have fixed the media type, because the framework does not let a route
declare it. This module owns both halves.

What a router asks for
----------------------
:func:`problem_response` builds the one response object a router may attach to a status, and it
is the only place in this package that names ``ProblemDetail``. A router writes::

    from app.api.v1.responses import ProblemResponses, problem_response

    _NOT_FOUND: Final[dict[str, Any]] = problem_response(
        "No post is addressable that way. A draft the caller may not read answers this "
        "identically to a post that does not exist."
    )

    _DETAIL_RESPONSES: Final[ProblemResponses] = {
        status.HTTP_404_NOT_FOUND: _NOT_FOUND,
        status.HTTP_422_UNPROCESSABLE_CONTENT: _VALIDATION_FAILED,
    }

The wording stays with the route, because a description is specific to the operation that emits
it; the *shape* stops being the route's business.

Why the media type needs a document transform
---------------------------------------------
This was not a choice. Both alternatives were executed against FastAPI 0.141.1 and both fail:

* Adding ``"content": {"application/problem+json": {}}`` beside ``"model"`` publishes **both**
  media types on that response - the framework merges rather than replaces - so the document
  would advertise an ``application/json`` error body the service never sends.
* Omitting ``"model"`` and writing the ``content`` block by hand publishes the right media type
  and loses the ``$ref``, so the error body becomes untyped in the very document a client
  generator reads.

The framework attaches a declared model under ``route.response_class.media_type``, which is
``application/json`` for every JSON response class including ``ORJSONResponse``, and offers no
per-response override. So the only place the two facts - "this body is a problem document" and
"problem documents are ``application/problem+json``" - can be reconciled is the finished
document, which is what :func:`customise_openapi` installs.

Why the optional-credential reads need it too
---------------------------------------------
Four read operations resolve :data:`~app.core.dependencies.OptionalUser`: the feed, a post by
slug, a post's comment thread and a post's like summary. Each serves an anonymous caller and
enriches its answer for a credentialed one. The framework sees the security scheme in the
dependency tree and publishes ``security: [{"OAuth2PasswordBearer": []}]``, which states that a
credential is *required* - so a generated client refuses the call without one and interactive
documentation hides it behind an authorisation prompt. The accurate declaration is
``security: [{}, {"OAuth2PasswordBearer": []}]``: two alternatives, the first of which is "none".

``openapi_extra`` cannot express it. FastAPI merges that mapping into the operation with
``deep_dict_update``, which **concatenates** lists rather than replacing them, so a ``security``
key supplied there is appended to the framework's own entry and yields
``[{"OAuth2PasswordBearer": []}, {}]`` - which reads as "a credential is required, or optional",
an incoherent claim, and leaves the mandatory alternative first. A route therefore marks itself
with :data:`OPTIONAL_AUTHENTICATION`, and the transform rewrites the list.

Layering
--------
This module is API-tier and could not be anything else. ``app.core`` sits at the bottom of the
import graph - ``app.schemas.common`` imports ``app.core.pagination``, so nothing under
``app.core`` may import ``app.schemas`` - and the helper's whole purpose is to name a schema. It
imports the media-type constant from ``app.core.exceptions`` rather than restating it, which is
what makes the declared media type provably the one the handlers emit.

Nothing here is a route, a query, a session or a business rule, and nothing here reads the
environment.

Governing standards
-------------------
No user rules govern this project, so the repository's self-imposed standards stand in their
place. Three decide this file: *explicit API contracts*, which is the reason it exists at all -
a declared status with no schema is a contract a client cannot be generated against;
*layered separation of concerns*, which places it above ``app.core`` and below nothing; and
*blocking quality gates*, which is why the transform is written against the finished document
rather than against framework internals that a patch release may move.
"""

from collections.abc import Iterator
from typing import Any, Final

from fastapi import FastAPI

from app.core.exceptions import PROBLEM_JSON_MEDIA_TYPE
from app.schemas import ProblemDetail

__all__ = [
    "OPTIONAL_AUTHENTICATION",
    "ProblemResponses",
    "customise_openapi",
    "problem_response",
]


ProblemResponses = dict[int | str, dict[str, Any]]
"""Shape of a route's ``responses=`` mapping: status code to response object.

``int | str`` keys because that is what the framework accepts - a range key such as ``"4XX"`` is
legal - and the alias exists so each router's constants are annotated explicitly rather than
having their type inferred from a literal nested in a decorator argument.
"""


# ---------------------------------------------------------------------------------------
# The one response object
# ---------------------------------------------------------------------------------------


def problem_response(description: str) -> dict[str, Any]:
    """Build the response object for one documented failure.

    The single place in this package that names :class:`~app.schemas.common.ProblemDetail`.
    ``model`` is the load-bearing key: without it the failure body is absent from the generated
    document and a client generator emits no type for the error path, which is exactly the gap
    the *explicit API contracts* standard closes. Routing every declaration through this
    function is what makes forgetting it impossible rather than merely unlikely.

    The media type is deliberately **not** set here. It cannot be - see *Why the media type
    needs a document transform* in the module docstring - and :func:`customise_openapi`
    publishes it on the finished document instead.

    Args:
        description: What this failure means and what a client should do about it, in Markdown.
            Written by the route that emits it, because the condition is specific to the
            operation: "no post carries that identifier" and "the `author` filter names no
            account" are both 404 and are not the same sentence.

    Returns:
        A fresh ``{"model": ProblemDetail, "description": ...}`` mapping. Fresh on every call, so
        two routes sharing a description cannot end up sharing one mutable object that a third
        could edit.
    """
    return {"model": ProblemDetail, "description": description}


# ---------------------------------------------------------------------------------------
# The optional-credential marker
#
# A vendor extension rather than a `security` override, because `openapi_extra` concatenates
# lists - see the module docstring. It is removed from the operation by the transform, so it
# never reaches a consumer: the served document carries the corrected `security` list and no
# `x-` key.
#
# A marker is also the honest place for the fact. "This operation accepts a credential and
# does not require one" is a property of the route's own dependency, so it is stated at the
# decorator that declares that dependency rather than inferred elsewhere by inspecting the
# dependency tree - which would couple this module to framework internals and would silently
# stop working the day a dependency is wrapped.
# ---------------------------------------------------------------------------------------

_OPTIONAL_AUTHENTICATION_EXTENSION: Final[str] = "x-optional-authentication"
"""Name of the operation-level marker :func:`customise_openapi` consumes and removes."""

OPTIONAL_AUTHENTICATION: Final[dict[str, Any]] = {_OPTIONAL_AUTHENTICATION_EXTENSION: True}
"""``openapi_extra`` for an operation that accepts a bearer credential without requiring one.

Attach it to the four reads that resolve :data:`~app.core.dependencies.OptionalUser`::

    @router.get("", response_model=Page[PostSummary], openapi_extra=OPTIONAL_AUTHENTICATION)

and the served document declares ``security: [{}, {"OAuth2PasswordBearer": []}]`` for that
operation - anonymous *or* bearer, in that order - instead of the framework's mandatory
single-alternative list. Attaching it to a route that genuinely requires a credential would be a
security-documentation defect, so it belongs only where the handler takes ``OptionalUser``.
"""


# ---------------------------------------------------------------------------------------
# Document constants
#
# All three describe the SERVED artifact rather than any framework object, which is what
# keeps the transform below independent of FastAPI's internals.
# ---------------------------------------------------------------------------------------

_JSON_MEDIA_TYPE: Final[str] = "application/json"
"""The media type the framework attaches a declared response model under.

Taken from the JSON response classes' own ``media_type``, which is a hard-coded class attribute
rather than anything a route can influence - the reason the remap exists.
"""

_PROBLEM_SCHEMA_REF: Final[str] = f"#/components/schemas/{ProblemDetail.__name__}"
"""JSON-pointer reference the framework emits for a response whose model is the problem document.

Derived from the class rather than written out, so renaming the model cannot leave the transform
matching a component name that no longer exists.
"""

_OPERATION_KEYS: Final[frozenset[str]] = frozenset(
    {"get", "put", "post", "delete", "options", "head", "patch", "trace"}
)
"""The keys of a path-item object that are operations.

Enumerated rather than assumed: a path item may also carry ``summary``, ``description``,
``servers``, ``parameters`` or ``$ref``, none of which is an operation and one of which is a
list. Iterating every value would either crash on those or, worse, silently treat one as an
operation.
"""

_ANONYMOUS_SECURITY: Final[dict[str, list[str]]] = {}
"""The security requirement object that permits an anonymous call.

An empty requirement object is the specification's way of saying "no scheme has to be
satisfied". Listed *first* among the alternatives so a reader and a code generator both meet
"this may be called without a credential" before the bearer alternative.
"""


def _operations(document: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """Yield every operation object in *document*, in document order.

    Args:
        document: A generated OpenAPI document, mutated in place by the callers of this
            function - so the mappings yielded are the document's own, not copies.

    Yields:
        Each operation object under each path item, skipping the path-item members that are not
        operations and skipping anything that is not a mapping, so a hand-written extension
        cannot make the transform raise.
    """
    paths = document.get("paths")
    if not isinstance(paths, dict):
        return
    for path_item in paths.values():
        if not isinstance(path_item, dict):
            continue
        for method, operation in path_item.items():
            if method in _OPERATION_KEYS and isinstance(operation, dict):
                yield operation


def _publish_problem_media_type(document: dict[str, Any]) -> None:
    """Re-key every declared problem-document body from JSON to ``application/problem+json``.

    Resolution of the drift between what the handlers send and what the document claimed: every
    handler in ``app.core.exceptions`` returns its body with
    :data:`~app.core.exceptions.PROBLEM_JSON_MEDIA_TYPE`, while the framework published the same
    body as ``application/json`` because that is the media type of the response class. A
    generated client therefore parsed - or refused - the wrong content type.

    Only a response whose ``application/json`` schema is exactly a reference to the problem
    document is touched. A success body is never a problem document, so no successful response
    is reachable by this test, and a response that already declares the problem media type is
    left alone.

    Args:
        document: The generated document, mutated in place.
    """
    for operation in _operations(document):
        responses = operation.get("responses")
        if not isinstance(responses, dict):
            continue
        for response in responses.values():
            if not isinstance(response, dict):
                continue
            content = response.get("content")
            if not isinstance(content, dict):
                continue
            body = content.get(_JSON_MEDIA_TYPE)
            if not _is_problem_document(body):
                continue
            # Removed and re-added rather than copied to both keys: the service emits one media
            # type, so the document must declare one. Declaring both would restate the very
            # inaccuracy this transform exists to remove.
            del content[_JSON_MEDIA_TYPE]
            content[PROBLEM_JSON_MEDIA_TYPE] = body


def _is_problem_document(body: object) -> bool:
    """Report whether *body* is a media-type object whose schema is the problem document.

    Args:
        body: The candidate media-type object, read straight out of the document and therefore
            of unverified shape.

    Returns:
        Whether it declares exactly ``{"$ref": "#/components/schemas/ProblemDetail"}`` as its
        schema. A composed schema - an array of them, a ``oneOf``, an inline object - is
        deliberately not matched: nothing in this service declares one, and a loose test here
        could re-key a success body that merely mentions the component.
    """
    if not isinstance(body, dict):
        return False
    schema = body.get("schema")
    return isinstance(schema, dict) and schema.get("$ref") == _PROBLEM_SCHEMA_REF


def _publish_optional_authentication(document: dict[str, Any]) -> None:
    """Turn each marked operation's mandatory security into anonymous-or-bearer alternatives.

    An operation carrying :data:`OPTIONAL_AUTHENTICATION` accepts a bearer credential and serves
    a caller who presents none. The framework cannot know that - it sees the security scheme in
    the dependency tree and publishes a single mandatory requirement - so the marker is what
    tells this function to prepend :data:`_ANONYMOUS_SECURITY`.

    The marker is removed from every operation it appears on, whether or not the rewrite
    applies, so the served document carries no vendor extension.

    Args:
        document: The generated document, mutated in place.
    """
    for operation in _operations(document):
        if not operation.pop(_OPTIONAL_AUTHENTICATION_EXTENSION, False):
            continue
        declared = operation.get("security")
        if not isinstance(declared, list) or not declared:
            # Nothing to relax: the operation already requires no scheme. Reached only if the
            # marker is attached to a route with no security dependency, which is a
            # mis-annotation rather than a document defect - and writing `[{}]` here would
            # publish a security block that says nothing.
            continue
        if _ANONYMOUS_SECURITY in declared:
            continue
        # A COPY of the constant, not the constant itself. `app.main._openapi_tags` states the
        # same rule for the same reason: two applications built by the factory would otherwise
        # hold one shared mutable object, and a consumer editing the document it was handed
        # would edit it for every other application in the process.
        operation["security"] = [dict(_ANONYMOUS_SECURITY), *declared]


def customise_openapi(application: FastAPI) -> None:
    """Install the two document corrections on *application*, replacing its ``openapi`` callable.

    The one wiring call this module needs, made by ``app.main.create_app`` after the routers are
    mounted. Everything it corrects is a property of the finished document, so it runs on the
    generated artifact rather than on the routes:

    1. Every declared problem-document body is published as ``application/problem+json``, which
       is what the handlers actually send.
    2. Every operation marked :data:`OPTIONAL_AUTHENTICATION` publishes anonymous *and* bearer
       as alternatives instead of bearer as a requirement.

    The framework's own generator is called first and its cache is honoured afterwards, so the
    document is still built once per application and every subsequent request to
    ``/openapi.json`` serves the same object. The cache is cleared on installation so that a
    document generated before this call - which nothing does today, but which a future
    assertion in the factory easily could - cannot be served uncorrected.

    Args:
        application: The application to correct. Its ``openapi`` attribute is replaced, and its
            cached document discarded.
    """
    # Bound before the replacement, so the closure calls the framework's generator rather than
    # itself. Rebinding `application.openapi` to a function that reached for `application.openapi`
    # would recurse until the stack ended.
    generate_document = application.openapi

    def openapi() -> dict[str, Any]:
        """Return the corrected document, generating and caching it on first call."""
        if application.openapi_schema is not None:
            return application.openapi_schema
        # `generate_document` stores its result on `application.openapi_schema` itself; the
        # corrections below therefore mutate the cached object in place, and the assignment
        # after them is what makes that explicit rather than incidental.
        document = generate_document()
        _publish_problem_media_type(document)
        _publish_optional_authentication(document)
        application.openapi_schema = document
        return document

    application.openapi_schema = None
    # Assigning over a method is how the framework's own documentation prescribes customising
    # the generated document; the code is named because a bare ignore is banned by
    # `[tool.mypy] enable_error_code = ["ignore-without-code"]`.
    application.openapi = openapi  # type: ignore[method-assign]
