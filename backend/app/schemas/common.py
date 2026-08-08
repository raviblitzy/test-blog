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
The six top-level keys are inserted in :mod:`app.core.exceptions` in the order ``type``,
``title``, ``status``, ``detail``, ``instance``, then ``errors``, and they are declared below in
that same order, which is also the order they appear on the wire. The three item-level keys -
``field``, ``message``, ``type`` - are taken verbatim from that module's ``FieldError``
TypedDict, and they are the whole of it: the two keys Pydantic supplies and it drops, ``input``
and ``ctx``, are absent here too, for the reasons recorded on :class:`ValidationErrorItem`.

Import purity
-------------
Two imports, and no more: ``pydantic`` and ``Page``. Not :mod:`app.core.exceptions` - that is
the cycle above. Not a sibling schema module, which would make the import order of this package
load-bearing. Not ``app.models``, not ``app.core.config``, not the environment: importing this
module performs no I/O, reaches no database and reads no setting, which is what lets a test
import it with nothing running.
"""

from pydantic import BaseModel, ConfigDict, Field

from app.core.pagination import Page

# `Page` is listed here because it is re-exported rather than used, and listing it is what
# makes that legitimate on both gates at once: ruff stops reporting the import above as unused,
# and mypy's strict no-implicit-reexport lets a sibling module write
# `from app.schemas.common import Page`. A per-line lint suppression would have silenced only
# the first of those, so this list is functional rather than decorative - keep it exactly in
# step with what the module defines.
__all__ = ["Page", "ProblemDetail", "ValidationErrorItem"]


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

    Five fields are always present. ``errors`` is the sixth, and it appears only when there is
    per-field information to report - in practice, a payload that failed its model:

    .. code-block:: json

        {
          "type": "/errors/validation-error",
          "title": "Validation Error",
          "status": 422,
          "detail": "The request payload failed validation.",
          "instance": "/api/v1/posts",
          "errors": [
            {
              "field": "title",
              "message": "String should have at least 1 character",
              "type": "string_too_short"
            }
          ]
        }

    Two properties of that document are contractual rather than incidental. ``errors`` is
    *omitted* from every other response rather than sent as ``null``, so a consumer must treat
    an absent key and a null value as the same thing. And there is deliberately no
    ``request_id`` member: correlation travels in the ``X-Request-ID`` response header, which
    keeps a value that matters to support out of a body a client may render to a reader.

    Extra members are neither declared nor forbidden. RFC 9457 allows a problem document to be
    extended, so configuring ``extra="forbid"`` would publish ``additionalProperties: false``
    into the schema and contradict that; the "exactly these six fields" guarantee comes instead
    from there being one assembly point in :mod:`app.core.exceptions`, and from the Pydantic
    mypy plugin rejecting an unknown keyword at every construction site. A test that wants
    exact parity with the wire should compare key sets directly rather than rely on parsing
    failing.
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
    errors: list[ValidationErrorItem] | None = Field(
        default=None,
        description=(
            "Per-field detail, present only for a validation failure and then never empty. "
            "Absent for every other failure: the key is omitted rather than serialised as "
            "null, so treat a missing `errors` and a null `errors` as the same thing."
        ),
    )
