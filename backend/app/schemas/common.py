"""The two response shapes every endpoint in this service shares.

Per-resource contracts - a post, a comment, a category, a token pair - live in the sibling
modules of ``app.schemas``. This module holds only what all of them have in common: the
envelope every collection route returns, and the single problem document every error response
carries. Both are declared once, here, and referenced from everywhere else.

Three rules describe the whole response surface
-----------------------------------------------
1. A collection returns :class:`~app.core.pagination.Page`, parameterised by its item model,
   as ``response_model=Page[PostSummary]``.
2. A single read returns the bare resource representation, with nothing wrapped around it.
3. Any failure returns :class:`ProblemDetail`, named in the route's ``responses=`` mapping.

There is no fourth rule, no other envelope, and none may be added to this module. In
particular there is no ``{"message": ..., "data": ...}`` shape anywhere. The service this
repository grew out of wrapped some of its five routes that way and not others -
``{"message": "Item created", "data": item}`` on create, ``{"message": "Item deleted"}`` on
delete, bare payloads on both reads - so a client could not tell from a route which of the two
it would receive. That inconsistency is being deleted rather than relocated, and the delete
case is why no message wrapper is needed at all: a delete and a logout answer ``204 No
Content`` with no body for a message to sit in.

``Page`` is re-exported here, not redeclared
--------------------------------------------
``Page`` is defined in :mod:`app.core.pagination` and only re-exported below, so that a
downstream author reaches both shared shapes from one import - ``from app.schemas.common
import Page, ProblemDetail`` - without this package acquiring a second, competing page model.
It is not subclassed, wrapped, aliased or extended: ``app.schemas.common.Page`` *is*
``app.core.pagination.Page``, the same class object, and the generic parameterises here
exactly as it does at its definition site.

``ProblemDetail`` documents a body this module never builds
----------------------------------------------------------
:class:`ProblemDetail` and :class:`ValidationErrorItem` describe the error body that
:mod:`app.core.exceptions` assembles - as a plain dict, in one function, rendered through
``ORJSONResponse`` at ``application/problem+json``. Two modules therefore describe one wire
format. That is a deliberate, load-bearing design decision, not an oversight to be fixed by
importing one from the other.

The reason is the import graph. ``app.core`` is its root: every layer above it may import from
``app.core``, and ``app.core`` imports from none of them. ``app.schemas`` sits above it and
takes ``Page`` from it in the import below, so a matching import back the other way -
``app.core.exceptions`` reaching for ``ProblemDetail`` - would close a cycle. The *behaviour*
therefore stays where the exception classes and the status codes already live, and the
*documented shape* lives here, where FastAPI can render it into ``/openapi.json`` as a single
reusable component that every router references from its ``responses=`` mapping, instead of
each route describing an ad-hoc error shape of its own.

The consequence for anyone editing either module: **change them together.** A key added to the
dict there and not to the model here means ``/openapi.json`` documents a body the service never
emits, which is exactly the class of defect this module exists to prevent.

Field names are copied from that module, not invented
-----------------------------------------------------
:mod:`app.core.exceptions` inserts six required top-level keys in the order ``type``, ``title``,
``status``, ``detail``, ``instance``, ``request_id``, and then the optional seventh, ``errors``,
only when a validation failure has per-field detail to report. All seven are declared below in
that same order, which is also the order they appear on the wire, so the published schema lists
six members under ``required`` and ``errors`` outside it. The three item-level keys - ``field``,
``message``, ``type`` - are taken verbatim from that module's ``FieldError`` TypedDict, and they
are the whole of it: the two keys Pydantic supplies and it drops, ``input`` and ``ctx``, are
absent here too, for the reasons recorded on :class:`ValidationErrorItem`.

Import purity
-------------
``typing``, ``pydantic`` and ``Page``, and no more. Not :mod:`app.core.exceptions` - that is the
cycle above. Not a sibling schema module, which would make the import order of this package
load-bearing. Not ``app.models``, not ``app.core.config``, not the environment: importing this
module performs no I/O, reaches no database and reads no setting, which is what lets a test
import it with nothing running.

Three names are exported beyond the two models, and the direction of each dependency is worth
noting: the five partial-update schemas import :func:`omit_null_default` *from here*, and the two
routers with a search parameter import :data:`SearchTerm` and
:data:`MAX_SEARCH_TERM_LENGTH` *from here*. So this module gains no import of its own by being
the place each shared rule is declared.
"""

from typing import Annotated, Any, Final

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints
from pydantic.json_schema import SkipJsonSchema

from app.core.pagination import Page

# `Page` is listed here because it is re-exported rather than used, and listing it is what
# makes that legitimate on both gates at once: ruff stops reporting the import above as unused,
# and mypy's strict no-implicit-reexport lets a sibling module write
# `from app.schemas.common import Page`. A per-line lint suppression would have silenced only
# the first of those, so this list is functional rather than decorative - keep it exactly in
# step with what the module defines.
__all__ = ["Page", "ProblemDetail", "ValidationErrorItem", "omit_null_default"]


def omit_null_default(json_schema: dict[str, Any]) -> None:
    """Strip the ``default: null`` a non-nullable optional field would otherwise publish.

    The second half of this package's **optional-but-not-nullable** pattern, and the reason it
    exists is that Pydantic offers no single spelling for "this member may be omitted, and may
    not be sent as null". Making a member optional requires a default, the only sensible default
    is ``None``, and Pydantic then advertises two things a caller should not believe: ``null`` as
    a permitted type, and ``null`` as the member's default value. The first is removed by
    annotating the union member as ``SkipJsonSchema[None]``; the second is removed by this
    function, passed as ``json_schema_extra``::

        display_name: DisplayName | SkipJsonSchema[None] = Field(
            default=None, json_schema_extra=omit_null_default, description=...
        )

    The published member is then exactly ``{"type": "string", ...}``: not required, no ``null``
    branch, no contradictory default. That matters because ``/openapi.json`` is what generated
    clients and ``/docs`` are built from, and a schema advertising ``null`` on a member the API
    rejects publishes requests that cannot succeed.

    Runtime validation is deliberately untouched. ``SkipJsonSchema`` affects the generated schema
    only, so the annotation still admits ``None`` and the model still needs its own field
    validator to reject an explicit null - which is the right division: the validator is what
    produces a ``422`` naming the field, and this function is what stops the document promising
    that ``null`` would have been accepted.

    Declared here rather than in each partial-update module because six models share it, and a
    helper copied six times is six chances for one of them to drift. Mutating the mapping in
    place and returning ``None`` is the callable contract Pydantic defines for
    ``json_schema_extra``; returning a value would be ignored.

    Args:
        json_schema: The generated schema for one field, mutated in place. ``default`` is
            removed when present, and its absence is not an error - the same helper is safe on a
            field whose default was never serialised.
    """
    json_schema.pop("default", None)


MAX_SEARCH_TERM_LENGTH: Final[int] = 256
"""Longest free-text search term any listing in this service accepts.

Every ``?q=`` parameter in the API is bounded by this one number - the public feed and the three
administrative listings - so a term that one surface refuses cannot be accepted by another.

The bound exists because an unbounded term is not merely untidy. It is parsed by PostgreSQL's
full-text query parser, matched against a trigram index, and written into a structured log line,
so its length is multiplied by the work each of those does; a megabyte of ``q`` would be a
megabyte of parsing, of index probing and of log volume for a request that cannot usefully match
anything. 256 characters is far longer than any real search - it is roughly three sentences -
and short enough that none of those three costs can be driven by the caller.

Enforced by :data:`SearchTerm`, published as ``maxLength`` on each parameter in
``/openapi.json``, and mirrored by ``MAX_SEARCH_TERM_LENGTH`` in ``frontend/src/lib/types.ts``
so a client refuses an over-long term before spending a request on it. Deliberately off
``__all__``: it is shared machinery reachable at this module address, exactly as the length
bounds in ``app.schemas.category`` and ``app.schemas.post`` are.
"""


def _normalise_search_term(value: str | None) -> str | None:
    """Collapse a submitted search term's whitespace, and fold an empty result to ``None``.

    One normalisation for every ``?q=`` in the service, so "no filter" has exactly one meaning
    on the wire. Without it each surface decides for itself whether ``"   "`` is a term, and a
    search box that submits its blank value would add a predicate matching everything on one
    listing and be ignored on another.

    Two things happen, and only two. Runs of whitespace - including the ``%20`` a URL-encoded
    space arrives as, tabs and newlines - collapse to single spaces, and leading and trailing
    whitespace disappears with them; a result with no characters left becomes ``None``. Nothing
    else is touched: the term is **not** lower-cased, quoted, tokenised or stripped of
    punctuation, because ``websearch_to_tsquery`` parses its own operator syntax and a reader who
    typed ``"exact phrase" -excluded`` on purpose must have it reach the parser intact.

    Args:
        value: The submitted term, or ``None`` when the parameter was omitted.

    Returns:
        The whitespace-collapsed term, or ``None`` when the parameter was absent or carried no
        non-whitespace character.
    """
    if value is None:
        return None
    # `str.split()` with no argument splits on arbitrary whitespace runs and discards empties,
    # so joining its result performs the collapse and the strip in one pass.
    collapsed = " ".join(value.split())
    return collapsed or None


SearchTerm = Annotated[
    str | None,
    StringConstraints(max_length=MAX_SEARCH_TERM_LENGTH),
    AfterValidator(_normalise_search_term),
]
"""The ``?q=`` query parameter, bounded and normalised, for every listing that accepts one.

Used as the annotation of the parameter itself, with the route supplying only its own
description::

    q: Annotated[SearchTerm, Query(description="Free-text search term ...")] = None

**The order of the two metadata entries is load-bearing.** The constraint is applied before the
validator, so an over-long term is refused as a ``422`` naming ``q`` while it is still the string
the caller sent - the length a client is told about is the length it submitted. Reversing them
makes the framework apply ``max_length`` to the validator's *result*, which raises a
``TypeError`` on a blank term the moment it normalises to ``None``. Verified by execution: in
this order an absent, blank, padded, at-bound and over-bound term answer ``None``, ``None``, the
collapsed term, the term, and ``422`` respectively.

Composing it with a route's ``Query(...)`` is safe because nested ``Annotated`` flattens
left-to-right, which keeps the constraint ahead of the validator however the route annotates it.
"""

ValidationErrors = Annotated[list["ValidationErrorItem"], Field(min_length=1)]
"""A non-empty list of field-level failures.

The bound is the contract rather than a precaution. ``app.core.exceptions`` emits ``errors``
only for a validation failure and only with at least one entry - its request-validation handler
substitutes a placeholder entry rather than emitting an empty list, and its single assembly site
normalises an empty sequence away - so ``minItems: 1`` in the published schema is a statement of
what the service actually sends. Without it the document would permit ``"errors": []``, which is
a self-contradictory validation failure: a client would iterate it, find nothing, and have
nothing to show the reader.
"""


class ValidationErrorItem(BaseModel):
    """One field-level validation failure, as it appears in ``ProblemDetail.errors``.

    Three fields, and the omissions are the security-relevant part. Pydantic's own error
    entries carry two more, and :mod:`app.core.exceptions` drops both deliberately rather
    than incidentally:

    ``input``
        The value the caller actually submitted. For a password that fails a length rule that
        value *is* the plaintext password, so echoing it would put a credential into a
        response body, into an access log, and into whatever the client renders next.
    ``ctx``
        Validator context, which can hold a live exception object. It is not
        JSON-serialisable, so serialising it would make the error handler itself raise while
        it was halfway through rendering an error.

    Only the field path, the message and the validator identifier are published, and all three
    are always populated - a malformed entry yields a placeholder rather than ``null`` - so a
    client iterating ``errors`` never has to guard against a missing key.
    """

    model_config = ConfigDict(
        json_schema_extra={
            # A post title that failed its minimum-length rule: a real Pydantic message and a
            # real `type`, and nothing resembling a credential. This example is published
            # verbatim in /openapi.json and rendered on /docs, so it is chosen for that
            # audience - and a field whose rejected value would be sensitive is precisely the
            # case the absent `input` key exists to protect.
            "example": {
                "field": "title",
                "message": "String should have at least 1 character",
                "type": "string_too_short",
            }
        }
    )

    field: str = Field(
        ...,
        description=(
            "Dotted path of the offending value, in the syntax the client's form library "
            "already consumes, so a server-side rejection can be attached to the control "
            "that produced it. Pydantic's leading request-part marker is dropped whenever a "
            "field follows it, so ('body', 'email') reports as `email`, and integer indices "
            "are rendered decimally, so ('body', 'categories', 0, 'slug') reports as "
            "`categories.0.slug`. Empty only when the location names no field at all, which "
            "happens when a whole body is missing or could not be parsed."
        ),
    )
    message: str = Field(
        ...,
        description=(
            "Human-readable description of the failure as the validator produced it, for "
            "example `String should have at least 1 character`. Never quotes the value that "
            "was submitted."
        ),
    )
    type: str = Field(
        ...,
        description=(
            "Machine-readable validator identifier, such as `string_too_short` or "
            "`int_parsing`, for a client that would rather localise the message itself than "
            "display it. This is the field to switch on; `message` is for humans."
        ),
    )


class ProblemDetail(BaseModel):
    """The single error body this API returns, for every failure, at every status code.

    One shape, declared once. A route names it in its ``responses=`` mapping rather than
    describing an error inline, so ``/openapi.json`` carries exactly one error component and a
    client can be written against exactly one parser:

    .. code-block:: python

        @router.get(
            "/posts/{slug}",
            response_model=PostDetail,
            responses={404: {"model": ProblemDetail}},
        )
        async def read_post(slug: str) -> PostDetail:
            return await service.get_published(slug)

    Six fields are always present. ``errors`` is the seventh, and it appears only when there is
    per-field information to report - in practice, a payload that failed its model:

    .. code-block:: json

        {
          "type": "/errors/validation-error",
          "title": "Validation Error",
          "status": 422,
          "detail": "The request payload failed validation.",
          "instance": "/api/v1/posts",
          "request_id": "b3d0f7a19c4e4f0d8a1c2e5b7d9f0a13",
          "errors": [
            {
              "field": "title",
              "message": "String should have at least 1 character",
              "type": "string_too_short"
            }
          ]
        }

    Two properties of that document are contractual rather than incidental. ``errors`` is
    *omitted* from every other response - never ``null``, never ``[]`` - and the published
    schema says exactly that: the member is not required, its declared type is an array with
    ``minItems: 1``, and ``null`` is not one of its permitted values. So a consumer writes one
    check, "is the key present", and needs no guard for a null or a zero-length list, because
    neither is representable. And ``request_id`` is present on *every* failure, carrying the
    same correlation value as the ``X-Request-ID`` response header: both are written from one
    value at the single assembly point in :mod:`app.core.exceptions`, so the body and the
    header cannot disagree, and a reader who can quote only what is on screen can still be
    matched to the exact log line that recorded the failure.

    Extra members are neither declared nor forbidden. RFC 9457 allows a problem document to be
    extended, so configuring ``extra="forbid"`` would publish ``additionalProperties: false``
    into the schema and contradict that; the "exactly these seven fields" guarantee comes
    instead from there being one assembly point in :mod:`app.core.exceptions`, and from the
    Pydantic mypy plugin rejecting an unknown keyword at every construction site. A test that
    wants exact parity with the wire should compare key sets directly rather than rely on
    parsing failing.
    """

    model_config = ConfigDict(
        json_schema_extra={
            # The 404 from reading a post by a slug nothing matches: the most common failure
            # in the API, and the one that shows `errors` omitted rather than null - the
            # property of this document readers most often get wrong. Kept identical to the
            # example in app/core/exceptions.py, so the two descriptions of one wire format
            # agree literally as well as structurally.
            "example": {
                "type": "/errors/not-found",
                "title": "Not Found",
                "status": 404,
                "detail": "Post not found",
                "instance": "/api/v1/posts/does-not-exist",
                "request_id": "b3d0f7a19c4e4f0d8a1c2e5b7d9f0a13",
            }
        }
    )

    type: str = Field(
        ...,
        description=(
            "Stable, machine-readable identifier for the KIND of failure, as a URI "
            "reference: `/errors/` followed by a kebab-case name - `/errors/not-found`, "
            "`/errors/unauthorized`, `/errors/forbidden`, `/errors/conflict`, "
            "`/errors/validation-error`, `/errors/rate-limit-exceeded`. This is the only "
            "field a client should branch on; `title` and `detail` are prose."
        ),
    )
    title: str = Field(
        ...,
        description=(
            "Short human-readable summary of the problem type, such as `Not Found`. Stable "
            "per type - it never varies between two occurrences of the same failure - so it "
            "is safe to use as a dialog heading or as a log dimension."
        ),
    )
    status: int = Field(
        ...,
        description=(
            "The HTTP status code, repeated in the body as a number. Always equal to the "
            "response's own status line, because both are taken from one value where the "
            "document is assembled, so the two cannot disagree."
        ),
    )
    detail: str = Field(
        ...,
        description=(
            "Human-readable explanation of THIS occurrence, and the only field that varies "
            "between two of them. Always safe to show a client: never a traceback, never a "
            "stack frame, never SQL, never a configuration value, never an exception class "
            "name. A 500 carries a deliberately generic sentence, and the real cause is "
            "recorded in the structured log instead."
        ),
    )
    instance: str = Field(
        ...,
        description=(
            "Path of the request the failure occurred on, such as "
            "`/api/v1/posts/does-not-exist`. The path only: the query string is excluded on "
            "every response, both because a filter expression is not part of the failure's "
            "identity and because a query string is where credentials get pasted by mistake."
        ),
    )
    request_id: str = Field(
        ...,
        description=(
            "Correlation identifier for the request that failed, identical to the value on "
            "the `X-Request-ID` response header. Present on every failure, and the field to "
            "quote when reporting one: every structured log line emitted while the request "
            "was in flight carries the same value, so it is what turns a screenshot into a "
            "single log query. Echoed from the inbound `X-Request-ID` header when the caller "
            "supplies a usable one, otherwise generated per request. Empty only if the "
            "correlation middleware did not run, which cannot happen in the assembled "
            "application."
        ),
    )
    errors: ValidationErrors | SkipJsonSchema[None] = Field(
        default=None,
        json_schema_extra=omit_null_default,
        description=(
            "Per-field detail, present only for a validation failure and then never empty. "
            "Absent for every other failure: the key is omitted rather than serialised as "
            "null or as an empty array, so a consumer treats a missing `errors` as 'no "
            "per-field detail' and never has to handle a null or a zero-length list."
        ),
    )
    """Field-level failures, omitted rather than nulled, and never empty when present.

    The declaration is the module's optional-but-not-nullable pattern applied to a list, and
    each of its three parts answers something the emitter actually guarantees.
    :data:`ValidationErrors` carries ``minItems: 1``, because ``app.core.exceptions`` never
    sends a zero-length list. ``SkipJsonSchema[None]`` keeps ``null`` out of the published
    type, because the key is omitted rather than nulled. :func:`omit_null_default` removes the
    ``default: null`` that the ``None`` default would otherwise advertise on a member whose
    published type is an array.

    The result is that the schema describes the emitted document exactly rather than a superset
    of it. That equality is the point: this member is the one part of the problem document a
    client has to branch on structurally, and a document permitting ``null`` and ``[]`` would
    force every consumer to write two guards that can never fire.

    ``frontend/src/lib/types.ts`` mirrors all three properties on its own
    ``ProblemDetail.errors`` - optional, never ``null``, never empty - so ``if (problem.errors)``
    is a complete test on that side of the wire. Widening this member without widening that one,
    or the reverse, reintroduces exactly the guard the pair exists to remove: change them
    together.
    """
