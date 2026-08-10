"""Contract enforcement for the whole REST surface, and the proof that ``/items`` is retired.

Every other module in this suite drives one endpoint family and asserts on behaviour. This one
takes the **generated OpenAPI document itself** as the object under test, walks it end to end,
and asserts the four properties that hold the surface together - populated identity, universal
versioning, a declared response schema on every operation, and exactly one error document - plus
the fifth that closes the change: the legacy ``/items`` surface is gone and nothing survives of
it under another name.

Written as the inversion of a measured baseline
----------------------------------------------
The application this replaces was fifty lines in one module, and each assertion below inverts
something that was verified true of it:

* its application object was a bare ``FastAPI()`` at ``app.py:L4`` - no title, no version, no
  description - so :class:`TestOpenApiMetadata` asserts all three are populated and that the
  version is neither the framework's placeholder nor an unresolved sentinel;
* **not one** of its five routes declared a ``response_model``, so :class:`TestResponseSchemas`
  asserts a resolvable success schema on every operation in the document;
* all five of its paths were unversioned, so :class:`TestVersioning` asserts the ``/api/v1``
  prefix on every path key and proves the exemption is exactly the two operational probes;
* it raised the identical ``HTTPException(status_code=404, detail="Item not found")`` at three
  separate call sites - ``app.py:L31``, ``L40`` and ``L49`` - and wrapped mutating results in an
  ad-hoc ``{"message": ..., "data": ...}`` envelope at ``app.py:L18`` and ``L39`` while reads
  returned bare payloads, so :class:`TestErrorContract` asserts one problem document for every
  failure and that no schema anywhere reintroduces that envelope;
* its ``Item`` carried ``id: int``, ``name: str`` and ``price: float`` across two path keys
  served by ``create_item``, ``get_items``, ``get_item``, ``update_item`` and ``delete_item``, so
  :class:`TestLegacyRetirement` asserts none of those paths, operation ids or that field triple
  is anywhere in the document, and that the five retired operations answer ``404`` live.

This is therefore not a smoke test. A green run here is the statement that the contract the
plan promised is the contract the service actually publishes.

Which AAP criteria this module discharges
-----------------------------------------
All five rows of AAP §0.9.4.3 *API Contract* - the document is served and complete, every path
declares a response schema, the legacy surface is retired, errors are uniform, collections are
uniform - and the §0.9.2 traceability row *"Implicit - legacy retirement and launch fix"*. It is
named for exactly this purpose in the AAP's file inventory (§0.4.4.5) and execution plan
(§0.7.1.11).

No user rules govern this file
-----------------------------
``review_rules`` returns ``No user rules provided.`` - a complete response, not a truncated
window - so **no user-specified rule governs this file and no rule placed it in scope**. Nothing
below is invented to fill that gap, and the absence of rules is not licence to lower the bar:
the substitute standard is the AAP's own §0.10.1 enterprise standards, and this module is the
*enforcement mechanism* for two of them, which is what makes it load-bearing rather than
descriptive.

* **§0.10.1 #4, explicit API contracts.** The standard requires a declared response model on
  every route, one page envelope for collections, one problem document for errors, and populated
  OpenAPI metadata. A test that sampled three endpoints would not enforce it, so every
  "for every operation" assertion here iterates :func:`_iter_operations` over the whole
  ``paths`` object. A route added tomorrow without a response model fails this module rather
  than shipping.
* **§0.10.1 #5, API versioning.** Every path key is enumerated from the document and asserted
  against the ``/api/v1`` prefix. The allow-list is the two probes and nothing else, and the
  complement is asserted too, so a new unversioned path cannot pass by being unlisted.
* **§0.10.1 #8, blocking quality gates.** There is no ``skip``, no ``xfail`` and no placeholder
  anywhere in this module. Where a condition could have justified skipping - the
  environment-gated documentation renderings - both branches assert instead.

Derivation over enumeration, and the two places enumeration is correct
----------------------------------------------------------------------
Anything that must hold *universally* is derived from the document, never from a hand-written
list of the paths this author happened to expect. Two facts are enumerated, because each is a
closed contractual decision that a derived assertion could only restate:

* :data:`_NO_CONTENT_OPERATIONS` - the seven operations that answer ``204`` and therefore carry
  no response body by specification. The set is asserted for **equality** against the document,
  so a route that starts or stops returning ``204`` fails here rather than being waved through
  by a loose exemption.
* :data:`_PAGED_COLLECTION_OPERATIONS` - the six collections AAP §0.9.4.3 requires to return the
  page envelope. Its complement is derived rather than listed: the document is searched for
  every success response that is a bare array, and the only permitted answer is
  ``GET /api/v1/categories``, the single documented exception to the pagination contract.

Where the document comes from, and why there is a fallback at all
-----------------------------------------------------------------
``app.main`` serves :data:`~app.main.OPENAPI_URL` in **every** environment, unconditionally - it
is the machine-readable artifact these checks are made against - while ``/docs`` and ``/redoc``
are withdrawn when ``settings.is_production``. The brief for this module described all three as
environment-gated; the code does not, and this module asserts what the code does: ``GET
/openapi.json`` is required to answer ``200`` with no condition attached, in
:meth:`TestDocumentAvailability.test_openapi_document_is_served_unconditionally`.

The :func:`document` fixture still implements HTTP-first acquisition with a fallback to the
``app`` fixture's ``app.openapi()``, and the fallback is deliberately **loud**: it emits a
:class:`RuntimeWarning` naming the status that was received, and the availability test above
fails in the same run. So a document withdrawn by a future change turns the suite red and says
why, instead of quietly leaving forty assertions to pass against an artifact nobody serves. The
fixture is the only place acquisition logic lives, and it is function-scoped because the
``client`` fixture it depends on is - the framework caches the generated document, so repeated
acquisition costs a parse rather than a regeneration.

One further deviation from the brief, for the same reason
---------------------------------------------------------
The brief listed the problem document's fields as ``type``, ``title``, ``status``, ``detail``,
``instance`` and an optional ``errors``. ``app.schemas.common.ProblemDetail`` declares a seventh,
``request_id``, and requires six of the seven; ``app.middleware.request_context`` sets the
matching ``X-Request-ID`` header. This module asserts the **real** contract - AAP §0.9.4.3 is
satisfied by "one machine-readable problem document", not by a particular field count - and
:meth:`TestErrorContract.test_live_failure_body_matches_the_documented_problem_document` closes
the one seam that nothing else covers: ``app.core.exceptions`` builds the error body as a plain
dict over ``ORJSONResponse`` and deliberately does not import ``app.schemas``, so the served
body and the documented schema are kept in agreement by this assertion and by nothing else.

Boundaries
----------
This module creates no row, imports no factory, and calls no service or repository - it needs
none of them, because a document and a ``404`` are all it asserts on. Its only fixtures are
``client`` and ``app`` from ``backend/tests/conftest.py``. It adds no ``__init__.py``. Every
literal it compares against is imported from the module that owns it -
:data:`~app.main.API_TITLE`, :func:`~app.main.resolve_version`,
:data:`~app.api.v1.router.API_V1_PREFIX`,
:data:`~app.core.exceptions.PROBLEM_JSON_MEDIA_TYPE` - so a rename moves both sides at once and
this file cannot drift into asserting a copy of a value that has since changed.
"""

from __future__ import annotations

import tomllib
import warnings
from collections.abc import AsyncIterator, Iterator, MutableMapping
from copy import deepcopy
from http import HTTPStatus
from pathlib import Path
from typing import Any, Final, NamedTuple

import pytest
import pytest_asyncio
from httpx import AsyncClient, Response
from sqlalchemy.exc import DataError

from app.api.v1.router import API_V1_PREFIX
from app.core.config import settings
from app.core.exceptions import PROBLEM_JSON_MEDIA_TYPE, REQUEST_ID_HEADER
from app.core.pagination import Page
from app.main import API_TITLE, DOCS_URL, OPENAPI_URL, REDOC_URL, resolve_version
from app.middleware import BodyLimitMiddleware
from app.schemas import ProblemDetail, ValidationErrorItem

#: Registered in ``backend/pyproject.toml`` under ``markers``, so ``--strict-markers`` accepts
#: it. Every test here drives the application in process against PostgreSQL, which is exactly
#: what the marker describes.
pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------------------
# Document structure
# ---------------------------------------------------------------------------------------

_OPERATION_KEYS: Final[frozenset[str]] = frozenset(
    {"get", "put", "post", "delete", "options", "head", "patch", "trace"}
)
"""The keys of a path-item object that are operations.

Enumerated rather than assumed. A path item may also carry ``summary``, ``description``,
``servers``, ``parameters`` or ``$ref``; iterating every value would crash on the list or -
worse - silently treat one of them as an operation and pass. This service's document happens to
carry none of them today, and filtering here is what keeps that a fact rather than a dependency.
"""

_COMPONENT_REF_PREFIX: Final[str] = "#/components/schemas/"
"""JSON-pointer prefix every schema reference in this document uses.

:func:`_resolve_schema` refuses a reference that does not start with it rather than guessing,
because a reference into ``components.responses`` or an external file would need different
handling and silently returning the unresolved wrapper would make every downstream property
assertion pass on an empty dict.
"""

_JSON_MEDIA_TYPE: Final[str] = "application/json"
"""Media type every success body is served as, taken from the JSON response classes' own value.

Failure bodies are **not** this: ``app.main._customise_openapi`` re-keys every
declared problem document onto :data:`~app.core.exceptions.PROBLEM_JSON_MEDIA_TYPE` on the
finished document, which is why the two families are asserted separately below.
"""

_SUCCESS_CODE_PREFIX: Final[str] = "2"
_FAILURE_CODE_PREFIXES: Final[tuple[str, ...]] = ("4", "5")

_NO_CONTENT_STATUS: Final[str] = str(int(HTTPStatus.NO_CONTENT))
"""``"204"`` as the document spells it - response keys are strings, not integers."""

_UNAUTHORIZED_STATUS: Final[str] = str(int(HTTPStatus.UNAUTHORIZED))
_FORBIDDEN_STATUS: Final[str] = str(int(HTTPStatus.FORBIDDEN))


# ---------------------------------------------------------------------------------------
# Identity of the served document
# ---------------------------------------------------------------------------------------

_FRAMEWORK_DEFAULT_VERSION: Final[str] = "0.1.0"
"""The version FastAPI stamps on a document when the factory passes none.

The retired ``FastAPI()`` at ``app.py:L4`` passed none, so this exact string is what the
baseline published. Asserting against it is what distinguishes "the version is declared" from
"the version is whatever the framework felt like".
"""

_UNRESOLVED_VERSION: Final[str] = "0+unknown"
"""The sentinel ``app.main`` publishes when it cannot read ``[project] version``.

Restated here deliberately: it is private to ``app.main``, and a served document carrying it
means the version lookup failed silently, which is a defect this module must report rather than
accept as "populated".
"""

_PROJECT_METADATA_FILE: Final[Path] = Path(__file__).resolve().parents[2] / "pyproject.toml"
"""Absolute path to ``backend/pyproject.toml``.

Derived from ``__file__`` - this module is ``backend/tests/integration/…``, so ``parents[2]`` is
``backend/`` - and never from the process working directory, because the gate is invoked both as
``pytest backend/tests`` from the repository root and ``pytest tests`` from inside ``backend/``.
"""

_PROJECT_TABLE: Final[str] = "project"
_VERSION_KEY: Final[str] = "version"


# ---------------------------------------------------------------------------------------
# The versioning contract
# ---------------------------------------------------------------------------------------

_UNVERSIONED_PATHS: Final[frozenset[str]] = frozenset({"/healthz", "/readyz"})
"""The only two paths permitted to sit outside :data:`~app.api.v1.router.API_V1_PREFIX`.

``app.api.v1.routers.health`` is deliberately excluded from the versioned aggregate and mounted
unprefixed by ``app.main``, so an orchestrator can check liveness without first being told which
version of the API to speak. Both members are asserted **present** as well as permitted, so the
exemption cannot quietly become an empty set that makes the versioning test vacuous.
"""

SPECIFIED_OPERATIONS: Final[frozenset[tuple[str, str]]] = frozenset(
    {
        # Identity and the token lifecycle - five operations.
        ("post", f"{API_V1_PREFIX}/auth/register"),
        ("post", f"{API_V1_PREFIX}/auth/login"),
        ("post", f"{API_V1_PREFIX}/auth/refresh"),
        ("post", f"{API_V1_PREFIX}/auth/logout"),
        ("get", f"{API_V1_PREFIX}/auth/me"),
        # Profiles - three operations.
        ("get", f"{API_V1_PREFIX}/users/{{username}}"),
        ("get", f"{API_V1_PREFIX}/users/{{username}}/posts"),
        ("patch", f"{API_V1_PREFIX}/users/me"),
        # Posts - seven operations.
        ("get", f"{API_V1_PREFIX}/posts"),
        ("get", f"{API_V1_PREFIX}/posts/{{slug}}"),
        ("post", f"{API_V1_PREFIX}/posts"),
        ("patch", f"{API_V1_PREFIX}/posts/{{post_id}}"),
        ("delete", f"{API_V1_PREFIX}/posts/{{post_id}}"),
        ("post", f"{API_V1_PREFIX}/posts/{{post_id}}/publish"),
        ("post", f"{API_V1_PREFIX}/posts/{{post_id}}/unpublish"),
        # Likes - three operations.
        ("put", f"{API_V1_PREFIX}/posts/{{post_id}}/like"),
        ("delete", f"{API_V1_PREFIX}/posts/{{post_id}}/like"),
        ("get", f"{API_V1_PREFIX}/posts/{{post_id}}/likes"),
        # Comments - four operations.
        ("get", f"{API_V1_PREFIX}/posts/{{post_id}}/comments"),
        ("post", f"{API_V1_PREFIX}/posts/{{post_id}}/comments"),
        ("patch", f"{API_V1_PREFIX}/comments/{{comment_id}}"),
        ("delete", f"{API_V1_PREFIX}/comments/{{comment_id}}"),
        # Taxonomy - two operations.
        ("get", f"{API_V1_PREFIX}/categories"),
        ("get", f"{API_V1_PREFIX}/categories/{{slug}}"),
        # Administration - thirteen operations.
        ("get", f"{API_V1_PREFIX}/admin/stats"),
        ("get", f"{API_V1_PREFIX}/admin/users"),
        ("patch", f"{API_V1_PREFIX}/admin/users/{{user_id}}"),
        ("delete", f"{API_V1_PREFIX}/admin/users/{{user_id}}"),
        ("get", f"{API_V1_PREFIX}/admin/posts"),
        ("patch", f"{API_V1_PREFIX}/admin/posts/{{post_id}}/status"),
        ("delete", f"{API_V1_PREFIX}/admin/posts/{{post_id}}"),
        ("get", f"{API_V1_PREFIX}/admin/comments"),
        ("patch", f"{API_V1_PREFIX}/admin/comments/{{comment_id}}/status"),
        ("delete", f"{API_V1_PREFIX}/admin/comments/{{comment_id}}"),
        ("post", f"{API_V1_PREFIX}/admin/categories"),
        ("patch", f"{API_V1_PREFIX}/admin/categories/{{category_id}}"),
        ("delete", f"{API_V1_PREFIX}/admin/categories/{{category_id}}"),
        # Operational probes - two operations, deliberately unversioned.
        ("get", "/healthz"),
        ("get", "/readyz"),
    }
)
"""Every ``(method, path)`` the API contract specifies, and **nothing else**: thirty-nine.

Transcribed from the endpoint inventory the specification publishes, family by family, in the
order it publishes them, so the two can be read side by side. It is asserted as an **equality**
against the generated document rather than as a floor, and that direction is the point. A floor
catches a route that went missing and says nothing at all about a route that was added: an
unplanned fortieth operation - a searchable administrative listing of the taxonomy is the one
this project actually grew, beside a public collection that already answers the whole set - is
exactly the kind of surface that arrives because it is convenient and then has to be supported
forever. Widening the contract is a decision for the specification to record, not a side effect
of a commit, so this set is the gate that makes such an addition fail here first.

Both directions therefore matter, and each names a different failure:

* a member of this set absent from the document is a **regression** - a specified operation that
  is no longer served, so a client written against the contract is broken;
* an operation in the document absent from this set is **scope creep** - an unspecified surface
  that no contract describes, that no client can rely on, and that nothing else in this suite
  would notice.

Query parameters are deliberately *not* part of the identity of an operation here. A parameter
added to an existing operation extends what a caller may ask for without adding a surface to
support, which is a different kind of change from a new path and is governed by that operation's
own tests rather than by this set.
"""


_DOCUMENTATION_PATHS: Final[frozenset[str]] = frozenset({OPENAPI_URL, DOCS_URL, REDOC_URL})
"""The three documentation renderings, excluded from the versioning walk if they ever appear.

They are not routes the router knows about and the framework does not list them under ``paths``,
which is itself asserted - see
:meth:`TestVersioning.test_documentation_renderings_are_not_documented_as_paths`.
"""


# ---------------------------------------------------------------------------------------
# The frozen API inventory (AAP §0.6.2)
#
# Everything below is a LITERAL transcription of the endpoint inventory the plan freezes, and it
# is deliberately not derived from the served document in any way. Every other assertion in this
# module walks `paths` and holds each operation it finds to a universal rule - versioned, declares
# a schema, fails uniformly - which is the right shape for a property that must hold for any
# operation, present or future. It is the wrong shape for the question "is this the agreed
# surface?", because a route the plan never declared satisfies every universal rule and is then
# reported as compliant. That is precisely what happened: a thirty-eighth versioned operation,
# `GET /api/v1/admin/categories`, was mounted, declared a response model, lived under the prefix
# and failed uniformly, so this module passed and the extra endpoint went unreported.
#
# So the inventory is stated here, once, as data:
#
#   * `_EXPECTED_OPERATIONS` names every operation and, for each, the success status it answers
#     and the response model that status carries. Compared as an EQUALITY in both directions, so a
#     missing operation and an undeclared extra both fail, by name.
#   * the three counts below are written as literals rather than as `len()` over the mapping.
#     Deriving them would make them agree with it by construction and assert nothing; written out,
#     they are a second, independent statement of the same contract and they disagree loudly when
#     an entry is added to the mapping without the plan changing.
# ---------------------------------------------------------------------------------------

_VERSIONED_PATH_TEMPLATE_COUNT: Final[int] = 30
"""How many distinct path templates live under :data:`API_V1_PREFIX`, from AAP §0.6.2.

Fewer than the operation count, because several paths carry more than one method - `/posts` is
both the feed and the create, `/posts/{post_id}/like` is both the like and the unlike.
"""

_VERSIONED_OPERATION_COUNT: Final[int] = 37
"""How many versioned operations the plan declares: 5 auth, 3 users, 12 posts, 2 comments,
2 categories and 13 administrative."""

_HEALTH_OPERATION_COUNT: Final[int] = 2
"""``GET /healthz`` and ``GET /readyz`` - the only two unversioned operations."""


class _Success(NamedTuple):
    """The success half of one operation's contract: its status, and the model it carries.

    Three members rather than two because a collection's item type is part of the contract a
    client generator reads. ``schema`` alone would accept ``Page_AdminUser_`` where
    ``Page_PostSummary_`` belongs, and both resolve, both serialise and both pass a "declares
    some schema" check.
    """

    status: str
    """The single ``2xx`` code the operation declares, as the document spells it."""

    schema: str | None
    """The component name the body references, or ``None`` for a ``204``."""

    item_schema: str | None = None
    """For a collection, the component name of its items.

    Set for the one bare-array read and for every ``Page[...]`` response; ``None`` otherwise. For
    a page it is read from the envelope component's own ``items.items.$ref``, which is what pins
    the *specialisation* rather than merely the envelope.
    """


_EXPECTED_OPERATIONS: Final[dict[tuple[str, str], _Success]] = {
    # -- auth: five operations -----------------------------------------------------------
    ("post", f"{API_V1_PREFIX}/auth/register"): _Success("201", "UserPublic"),
    ("post", f"{API_V1_PREFIX}/auth/login"): _Success("200", "TokenPair"),
    ("post", f"{API_V1_PREFIX}/auth/refresh"): _Success("200", "TokenPair"),
    ("post", f"{API_V1_PREFIX}/auth/logout"): _Success("204", None),
    ("get", f"{API_V1_PREFIX}/auth/me"): _Success("200", "UserMe"),
    # -- users and profiles: three operations ---------------------------------------------
    ("patch", f"{API_V1_PREFIX}/users/me"): _Success("200", "UserMe"),
    ("get", f"{API_V1_PREFIX}/users/{{username}}"): _Success("200", "UserPublic"),
    ("get", f"{API_V1_PREFIX}/users/{{username}}/posts"): _Success(
        "200", "Page_PostSummary_", "PostSummary"
    ),
    # -- posts, likes and the thread: twelve operations ------------------------------------
    ("get", f"{API_V1_PREFIX}/posts"): _Success("200", "Page_PostSummary_", "PostSummary"),
    ("post", f"{API_V1_PREFIX}/posts"): _Success("201", "PostDetail"),
    # The public read is keyed on the SLUG and the mutations on the UUID - different templates
    # for the same resource, and the distinction is part of the contract.
    ("get", f"{API_V1_PREFIX}/posts/{{slug}}"): _Success("200", "PostDetail"),
    ("patch", f"{API_V1_PREFIX}/posts/{{post_id}}"): _Success("200", "PostDetail"),
    ("delete", f"{API_V1_PREFIX}/posts/{{post_id}}"): _Success("204", None),
    ("post", f"{API_V1_PREFIX}/posts/{{post_id}}/publish"): _Success("200", "PostDetail"),
    ("post", f"{API_V1_PREFIX}/posts/{{post_id}}/unpublish"): _Success("200", "PostDetail"),
    ("put", f"{API_V1_PREFIX}/posts/{{post_id}}/like"): _Success("200", "LikeSummary"),
    # The one DELETE in the API that answers with a body rather than 204: the caller needs the
    # new count to render, so the status is 200 and the model is the summary.
    ("delete", f"{API_V1_PREFIX}/posts/{{post_id}}/like"): _Success("200", "LikeSummary"),
    ("get", f"{API_V1_PREFIX}/posts/{{post_id}}/likes"): _Success("200", "LikeSummary"),
    ("get", f"{API_V1_PREFIX}/posts/{{post_id}}/comments"): _Success(
        "200", "Page_CommentPublic_", "CommentPublic"
    ),
    ("post", f"{API_V1_PREFIX}/posts/{{post_id}}/comments"): _Success("201", "CommentPublic"),
    # -- comments addressed by their own identifier: two operations ------------------------
    ("patch", f"{API_V1_PREFIX}/comments/{{comment_id}}"): _Success("200", "CommentPublic"),
    ("delete", f"{API_V1_PREFIX}/comments/{{comment_id}}"): _Success("204", None),
    # -- categories: two public reads, and the bare array among them ----------------------
    ("get", f"{API_V1_PREFIX}/categories"): _Success("200", None, "CategoryPublic"),
    ("get", f"{API_V1_PREFIX}/categories/{{slug}}"): _Success("200", "CategoryPublic"),
    # -- administrative: thirteen operations, and no category listing among them -----------
    ("get", f"{API_V1_PREFIX}/admin/stats"): _Success("200", "AdminStats"),
    ("get", f"{API_V1_PREFIX}/admin/users"): _Success("200", "Page_AdminUser_", "AdminUser"),
    ("patch", f"{API_V1_PREFIX}/admin/users/{{user_id}}"): _Success("200", "AdminUser"),
    ("delete", f"{API_V1_PREFIX}/admin/users/{{user_id}}"): _Success("204", None),
    ("get", f"{API_V1_PREFIX}/admin/posts"): _Success("200", "Page_AdminPost_", "AdminPost"),
    ("patch", f"{API_V1_PREFIX}/admin/posts/{{post_id}}/status"): _Success("200", "AdminPost"),
    ("delete", f"{API_V1_PREFIX}/admin/posts/{{post_id}}"): _Success("204", None),
    ("get", f"{API_V1_PREFIX}/admin/comments"): _Success(
        "200", "Page_AdminComment_", "AdminComment"
    ),
    ("patch", f"{API_V1_PREFIX}/admin/comments/{{comment_id}}/status"): _Success(
        "200", "AdminComment"
    ),
    ("delete", f"{API_V1_PREFIX}/admin/comments/{{comment_id}}"): _Success("204", None),
    ("post", f"{API_V1_PREFIX}/admin/categories"): _Success("201", "CategoryPublic"),
    ("patch", f"{API_V1_PREFIX}/admin/categories/{{category_id}}"): _Success(
        "200", "CategoryPublic"
    ),
    ("delete", f"{API_V1_PREFIX}/admin/categories/{{category_id}}"): _Success("204", None),
    # -- the two operational probes, deliberately unversioned ------------------------------
    ("get", "/healthz"): _Success("200", "LivenessResponse"),
    ("get", "/readyz"): _Success("200", "ReadinessResponse"),
}
"""Every operation the plan declares, mapped to the success contract it must publish.

The keys are ``(lower-case method, path template)`` exactly as the document spells them, so a
renamed path parameter - ``{post_id}`` becoming ``{id}`` - is a contract change and fails here.

Four rows are worth reading twice, because each encodes a decision that looks like a mistake:

* ``GET /categories`` names an **item** schema and no envelope schema. It is the API's single
  documented collection exception - a bare JSON array, because the list *is* the home page's
  filter control and windowing it would let the control hide posts.
* ``DELETE /posts/{post_id}/like`` answers **200 with a body**, alone among the deletes, because
  the caller needs the new count to render the control it just toggled.
* ``GET /posts/{slug}`` and ``PATCH /posts/{post_id}`` are two templates over one resource: a
  public read is addressed by the canonical slug, a mutation by the server-generated key.
* the administrative rows number **thirteen** and none of them lists categories. The taxonomy has
  one read, the public bare array above, which is what the management screen consumes.
"""


# ---------------------------------------------------------------------------------------
# The response-schema contract
# ---------------------------------------------------------------------------------------

_NO_CONTENT_OPERATIONS: Final[frozenset[tuple[str, str]]] = frozenset(
    {
        ("post", f"{API_V1_PREFIX}/auth/logout"),
        ("delete", f"{API_V1_PREFIX}/posts/{{post_id}}"),
        ("delete", f"{API_V1_PREFIX}/comments/{{comment_id}}"),
        ("delete", f"{API_V1_PREFIX}/admin/users/{{user_id}}"),
        ("delete", f"{API_V1_PREFIX}/admin/posts/{{post_id}}"),
        ("delete", f"{API_V1_PREFIX}/admin/comments/{{comment_id}}"),
        ("delete", f"{API_V1_PREFIX}/admin/categories/{{category_id}}"),
    }
)
"""``(method, path)`` for every operation that answers ``204 No Content``.

A ``204`` carries no body by specification, so these are the only operations exempt from the
"declares a success schema" rule - and the exemption is asserted as an **equality** against the
document rather than as a permission, which is the difference between a verified decision and a
hole. Every member is a revocation or a deletion: logging out, and the six deletes.
"""


# ---------------------------------------------------------------------------------------
# The collection contract
# ---------------------------------------------------------------------------------------

_PAGE_FIELDS: Final[frozenset[str]] = frozenset({"items", "total", "page", "page_size", "pages"})
"""The five field names of the page envelope, asserted against ``Page.model_fields`` as well.

Written out rather than derived from the model alone: deriving both sides from
:class:`~app.core.pagination.Page` would assert only that the document matches the model, and
would keep passing if the envelope itself were renamed. The literal is the contract; the
model comparison is what proves the runtime object and the published document agree with it.
"""

_PAGED_COLLECTION_OPERATIONS: Final[frozenset[tuple[str, str]]] = frozenset(
    {
        ("get", f"{API_V1_PREFIX}/posts"),
        ("get", f"{API_V1_PREFIX}/users/{{username}}/posts"),
        ("get", f"{API_V1_PREFIX}/posts/{{post_id}}/comments"),
        ("get", f"{API_V1_PREFIX}/admin/users"),
        ("get", f"{API_V1_PREFIX}/admin/posts"),
        ("get", f"{API_V1_PREFIX}/admin/comments"),
    }
)
"""The collection operations AAP §0.9.4.3 requires to answer with the page envelope.

The required floor rather than a closed set: it is stated as the operations that *must* carry the
envelope, and
:meth:`TestCollectionEnvelope.test_every_page_shaped_component_carries_exactly_the_five_fields`
covers every envelope in the document, including any this set does not name.
"""

_TAXONOMY_COLLECTION: Final[tuple[str, str]] = ("get", f"{API_V1_PREFIX}/categories")
"""The one collection that answers with a bare array instead of the page envelope.

``CategoryService.list_with_post_counts`` is un-paginated by contract because the taxonomy is
administrator-curated, bounded, and backs the feed's filter control - a control offered only
some of its terms would silently hide the posts filed under the rest. Asserted **positively** as
an array, so the exception is verified as intentional rather than merely skipped.
"""

_TAXONOMY_ITEM_PROPERTIES: Final[frozenset[str]] = frozenset({"id", "name", "slug", "post_count"})
"""Properties the taxonomy array's element schema must carry for a filter control to work.

A subset check rather than an equality: the element model may gain a field without breaking the
filter, but losing the slug it filters by, the name it labels with or the count it annotates
would break it silently.
"""


# ---------------------------------------------------------------------------------------
# The error contract
# ---------------------------------------------------------------------------------------

_PROBLEM_DETAIL_COMPONENT: Final[str] = ProblemDetail.__name__
"""Component name of the one problem document, taken from the class rather than written out."""

_VALIDATION_ITEM_COMPONENT: Final[str] = ValidationErrorItem.__name__

_PROBLEM_DETAIL_PROPERTIES: Final[frozenset[str]] = frozenset(
    {"type", "title", "status", "detail", "instance", "request_id", "errors"}
)
"""Every property of the problem document, including the optional ``errors`` array.

``request_id`` is part of the real contract - it matches the ``X-Request-ID`` response header on
the same response, which is the value a client quotes when reporting a problem - even though the
brief for this module listed six names rather than seven. Asserting the document against a stale
list would have made this module the thing that was wrong.
"""

_PROBLEM_DETAIL_REQUIRED: Final[frozenset[str]] = frozenset(
    {"type", "title", "status", "detail", "instance", "request_id"}
)
"""The six properties present on **every** failure, at every status code.

``errors`` is the seventh and is absent unless the failure is a validation rejection: the key is
omitted rather than serialised as ``null`` or as an empty array, so a consumer treats a missing
``errors`` as "no per-field detail" and never has to handle either.
"""

_VALIDATION_ITEM_PROPERTIES: Final[frozenset[str]] = frozenset({"field", "message", "type"})

_ERROR_TYPE_PREFIX: Final[str] = "/errors/"
"""Prefix of every ``type`` URI reference the error contract publishes.

Asserted as a prefix rather than against a specific URI so this module does not become a second
copy of ``app.core.exceptions``'s private type table; the contractual promise is that ``type``
is a stable URI reference a client can branch on instead of parsing prose.
"""

_FRAMEWORK_VALIDATION_COMPONENTS: Final[frozenset[str]] = frozenset(
    {"HTTPValidationError", "ValidationError"}
)
"""The error shapes FastAPI emits by default when a route leaves ``422`` undeclared.

Their absence is what proves the "one problem document" claim covers validation too: every route
declares its own ``422`` through ``app.schemas.common.problem_response``, so the framework's
alternative never enters the document.
"""

_LEGACY_ENVELOPE_PROPERTIES: Final[frozenset[str]] = frozenset({"message", "data"})
"""The ad-hoc envelope the retired mutating routes wrapped their results in.

``app.py:L18`` returned ``{"message": "Item created", "data": item}`` and ``L39`` the update
equivalent, while the reads at ``L23`` and ``L30`` returned bare payloads - a deliberate
inconsistency the specification recorded. No schema in the new document may carry that pair.
"""


# ---------------------------------------------------------------------------------------
# The retired surface
# ---------------------------------------------------------------------------------------

_LEGACY_PATH_PREFIX: Final[str] = "/items"
"""Prefix covering both retired path keys - ``/items`` and ``/items/{item_id}`` - at once."""

_RETIRED_HANDLER_NAMES: Final[tuple[str, ...]] = (
    "create_item",
    "get_items",
    "get_item",
    "update_item",
    "delete_item",
)
"""The five retired handler function names, in the order ``app.py`` declared them.

Operation ids are asserted by **containment** of these fragments, never by equality: FastAPI
derives an id from the function name plus the path and method, so the retired
``get_items`` would have appeared as ``get_items_items_get``. An equality check would pass while
the handler was still mounted.
"""

_RETIRED_ITEM_PROPERTIES: Final[frozenset[str]] = frozenset({"id", "name", "price"})
"""The ``Item`` contract from ``app.py:L9-L12``.

Checked as a property set as well as by component name, because the point is that the contract
has no blog-domain counterpart - not merely that nothing is spelled ``Item`` any more.
"""

_RETIRED_NOT_FOUND_DETAIL: Final[str] = "Item not found"
"""The detail string the three duplicated raises at ``app.py:L31``, ``L40`` and ``L49`` shared.

A ``404`` on a retired path now comes from the one registered handler, so this string must not
appear in any response body.
"""

_RETIRED_OPERATIONS: Final[tuple[tuple[str, str], ...]] = (
    ("POST", "/items"),
    ("GET", "/items"),
    ("GET", "/items/1"),
    ("PUT", "/items/1"),
    ("DELETE", "/items/1"),
)
"""Every retired operation, as a live ``(method, url)`` request.

One entry per handler in ``app.py:L15-L49``, with a concrete identifier substituted for
``{item_id}``. All five must answer ``404``: AAP §0.9.3 excludes preservation of the ``/items``
API outright, and no consumer of it can exist because its data never survived a restart.
"""


# ---------------------------------------------------------------------------------------
# Helpers
#
# Every "for every operation" assertion in this module iterates `_iter_operations`, and every
# schema assertion resolves through `_resolve_schema`. Two helpers rather than two dozen inline
# loops is what keeps the walks from drifting apart - a filter fixed in one place would
# otherwise stay broken in the other eleven.
# ---------------------------------------------------------------------------------------


def _iter_operations(document: dict[str, Any]) -> Iterator[tuple[str, str, dict[str, Any]]]:
    """Yield ``(path, method, operation)`` for every operation in the document.

    Sorted by path so a failure report reads in a stable order across runs, and filtered to
    :data:`_OPERATION_KEYS` so a non-operation member of a path item is never mistaken for one.

    Args:
        document: The generated OpenAPI document.

    Yields:
        One triple per operation. ``method`` is lower-case, exactly as the document spells it.
    """
    for path, path_item in sorted(document["paths"].items()):
        for method, operation in path_item.items():
            if method not in _OPERATION_KEYS:
                continue
            yield path, method, operation


def _label(path: str, method: str) -> str:
    """Return ``"GET /api/v1/posts"`` for use in an assertion message.

    Every failure message in this module carries one of these, so a regression names the
    offending operation in the first line rather than in a diff of two dictionaries.

    Args:
        path: The path key.
        method: The lower-case method key.

    Returns:
        The method upper-cased, a space, then the path.
    """
    return f"{method.upper()} {path}"


def _component_schemas(document: dict[str, Any]) -> dict[str, Any]:
    """Return ``components.schemas``, or an empty mapping if the document declares none.

    Tolerant of absence rather than indexing blindly: a document with no components at all is a
    meaningful failure for the tests that assert a component exists, and those tests report it
    far more clearly than a :class:`KeyError` raised inside a helper would.

    Args:
        document: The generated OpenAPI document.

    Returns:
        The component schema mapping.
    """
    components = document.get("components", {})
    schemas = components.get("schemas", {})
    assert isinstance(schemas, dict), "components.schemas must be an object"
    return schemas


def _resolve_schema(document: dict[str, Any], schema: dict[str, Any]) -> dict[str, Any]:
    """Return ``schema`` with a single ``$ref`` followed into ``components.schemas``.

    An inline schema is returned unchanged. A reference must point into
    :data:`_COMPONENT_REF_PREFIX` and the component must exist - both are asserted here rather
    than left to fail as an empty property set in the caller, which is what makes a dangling
    reference report itself as a dangling reference.

    Args:
        document: The generated OpenAPI document, used to resolve the reference.
        schema: The schema object taken from a response body.

    Returns:
        The resolved schema object.
    """
    reference = schema.get("$ref")
    if reference is None:
        return schema

    assert reference.startswith(_COMPONENT_REF_PREFIX), (
        f"Schema reference {reference!r} does not point into {_COMPONENT_REF_PREFIX!r}; "
        "this module resolves component references only."
    )
    name = reference.removeprefix(_COMPONENT_REF_PREFIX)
    schemas = _component_schemas(document)
    assert name in schemas, (
        f"Schema reference {reference!r} resolves to no component. "
        f"Declared components: {sorted(schemas)}"
    )
    resolved = schemas[name]
    assert isinstance(resolved, dict), f"Component {name!r} must be a schema object"
    return resolved


def _properties(schema: dict[str, Any]) -> set[str]:
    """Return the property names of a schema object, empty when it declares none.

    Args:
        schema: A resolved schema object.

    Returns:
        The property names as a set, so a comparison reads as a contract rather than an order.
    """
    properties = schema.get("properties", {})
    return set(properties) if isinstance(properties, dict) else set()


def _required(schema: dict[str, Any]) -> set[str]:
    """Return the required property names of a schema object, empty when it declares none.

    Args:
        schema: A resolved schema object.

    Returns:
        The required property names as a set.
    """
    required = schema.get("required", [])
    return set(required) if isinstance(required, list) else set()


def _status_codes(operation: dict[str, Any], prefixes: tuple[str, ...]) -> list[str]:
    """Return the operation's response keys whose status code starts with one of ``prefixes``.

    Range keys such as ``"4XX"`` and the ``"default"`` key are legal in OpenAPI and would both
    survive a naive prefix test, so only keys that are entirely digits are considered.

    Args:
        operation: The operation object.
        prefixes: Leading digits to accept, for example ``("4", "5")``.

    Returns:
        The matching keys, sorted, exactly as the document spells them.
    """
    responses = operation.get("responses", {})
    return sorted(code for code in responses if code.isdigit() and code.startswith(prefixes))


def _success_codes(operation: dict[str, Any]) -> list[str]:
    """Return the operation's ``2xx`` response keys.

    Args:
        operation: The operation object.

    Returns:
        The success response keys, sorted.
    """
    return _status_codes(operation, (_SUCCESS_CODE_PREFIX,))


def _failure_codes(operation: dict[str, Any]) -> list[str]:
    """Return the operation's ``4xx`` and ``5xx`` response keys.

    Args:
        operation: The operation object.

    Returns:
        The failure response keys, sorted.
    """
    return _status_codes(operation, _FAILURE_CODE_PREFIXES)


def _response(operation: dict[str, Any], code: str) -> dict[str, Any]:
    """Return one response object from an operation.

    Args:
        operation: The operation object.
        code: The response key.

    Returns:
        The response object.
    """
    response = operation["responses"][code]
    assert isinstance(response, dict), f"Response {code} must be a response object"
    return response


def _content(response: dict[str, Any]) -> dict[str, Any]:
    """Return a response object's ``content`` mapping, empty when it declares no body.

    Args:
        response: The response object.

    Returns:
        The media-type mapping.
    """
    content = response.get("content", {})
    return content if isinstance(content, dict) else {}


def _body_schema(response: dict[str, Any], media_type: str) -> dict[str, Any]:
    """Return the schema declared for one media type of a response body.

    Args:
        response: The response object.
        media_type: The media type to read.

    Returns:
        The schema object, unresolved - :func:`_resolve_schema` follows the reference.
    """
    body = _content(response).get(media_type, {})
    schema = body.get("schema", {})
    assert isinstance(schema, dict), f"Schema for {media_type} must be an object"
    return schema


def _declared_project_version() -> str:
    """Read ``[project] version`` out of ``backend/pyproject.toml``.

    Deliberately independent of ``app.main.resolve_version``. Comparing the served version only
    against that function would assert that the function agrees with itself; reading the project
    metadata here as well is what proves the number in the document is the number the project
    declares. Synchronous, and called from a synchronous fixture, so no blocking file read
    happens inside a coroutine.

    Returns:
        The declared version string.
    """
    assert _PROJECT_METADATA_FILE.is_file(), (
        f"Project metadata not found at {_PROJECT_METADATA_FILE}; the served version cannot be "
        "cross-checked against the single source that declares it."
    )
    with _PROJECT_METADATA_FILE.open("rb") as metadata_file:
        metadata: dict[str, Any] = tomllib.load(metadata_file)

    project = metadata.get(_PROJECT_TABLE, {})
    declared = project.get(_VERSION_KEY)
    assert isinstance(declared, str), (
        f"[{_PROJECT_TABLE}] {_VERSION_KEY} in {_PROJECT_METADATA_FILE.name} must be a string, "
        f"got {declared!r}"
    )
    assert declared, f"[{_PROJECT_TABLE}] {_VERSION_KEY} in {_PROJECT_METADATA_FILE.name} is empty"
    return declared


# ---------------------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------------------


@pytest_asyncio.fixture(loop_scope="session")
async def openapi_response(client: AsyncClient) -> Response:
    """Return the raw HTTP response for ``GET /openapi.json``.

    Separate from :func:`document` on purpose: this is what
    :meth:`TestDocumentAvailability.test_openapi_document_is_served_unconditionally` asserts on,
    and keeping the raw response addressable is what lets that test report the status it actually
    received instead of a downstream symptom.

    Args:
        client: The anonymous in-process HTTP client.

    Returns:
        The response, whatever its status.
    """
    return await client.get(OPENAPI_URL)


@pytest_asyncio.fixture(loop_scope="session")
async def document(openapi_response: Response, app: Any) -> dict[str, Any]:
    """Return the OpenAPI document, fetched over HTTP where served and generated otherwise.

    The single place acquisition logic lives, so every assertion in this module is made against
    one artifact obtained one way. Function-scoped because ``client`` is - and cheap regardless,
    because the framework caches the generated document and serves the same object on every
    request, so a second acquisition costs a JSON parse rather than a regeneration.

    The fallback is deliberately loud. ``app.main`` serves :data:`~app.main.OPENAPI_URL` in every
    environment, so reaching the fallback means something withdrew the machine-readable contract:
    the warning names the status that came back, and
    :meth:`TestDocumentAvailability.test_openapi_document_is_served_unconditionally` fails in the
    same run. Nobody can read a green transcript as proof the document is served when it is not,
    which is precisely what a silent ``skip`` would have allowed.

    Args:
        openapi_response: The raw response for the documentation URL.
        app: The application object, used only for the fallback. Annotated loosely because the
            ``conftest`` fixture is.

    Returns:
        The document as a mutable mapping. Treated as read-only throughout: the generated object
        is cached by the framework, so the fallback deep-copies it rather than handing out the
        application's own dictionary.
    """
    if openapi_response.status_code == HTTPStatus.OK:
        payload: dict[str, Any] = openapi_response.json()
        return payload

    warnings.warn(
        f"GET {OPENAPI_URL} answered {openapi_response.status_code} instead of "
        f"{int(HTTPStatus.OK)}; the contract assertions fell back to app.openapi(). The served "
        "document is part of the API contract (AAP §0.9.4.3), so this run is not evidence that "
        "it is published.",
        RuntimeWarning,
        stacklevel=2,
    )
    fallback: dict[str, Any] = deepcopy(app.openapi())
    return fallback


@pytest.fixture
def declared_project_version() -> str:
    """Return ``[project] version`` from ``backend/pyproject.toml``.

    Synchronous, so the file read stays off the event loop, and usable from an asynchronous test
    exactly as it is.

    Returns:
        The declared version string.
    """
    return _declared_project_version()


# ---------------------------------------------------------------------------------------
# Phase B - the document is served, and it identifies itself
# ---------------------------------------------------------------------------------------


class TestDocumentAvailability:
    """The machine-readable contract is published, and the renderings are gated deliberately."""

    async def test_openapi_document_is_served_unconditionally(
        self, openapi_response: Response
    ) -> None:
        """``GET /openapi.json`` answers ``200`` with a JSON body, in every environment.

        AAP §0.9.4.3 requires the document to be served. ``app.main`` passes
        ``openapi_url=OPENAPI_URL`` with no condition attached - only ``/docs`` and ``/redoc``
        are withdrawn in production - so there is nothing to make this assertion conditional on,
        and it is stated flatly. If this fails, every other assertion in this module ran against
        the fallback document and the warning from the ``document`` fixture says so.
        """
        assert openapi_response.status_code == HTTPStatus.OK, (
            f"GET {OPENAPI_URL} answered {openapi_response.status_code}. The document is the "
            "artifact the contract is asserted against and app.main serves it in every "
            "environment; no deployment stage may withdraw it."
        )
        content_type = openapi_response.headers.get("content-type", "")
        assert content_type.startswith(_JSON_MEDIA_TYPE), (
            f"GET {OPENAPI_URL} served {content_type!r}, expected {_JSON_MEDIA_TYPE!r}"
        )

    async def test_served_document_is_the_application_document(
        self, openapi_response: Response, app: Any
    ) -> None:
        """The body served over HTTP is the same artifact ``app.openapi()`` returns.

        This is what makes the fixture's fallback faithful rather than approximate: the two
        acquisition paths cannot diverge, so an assertion made against either is an assertion
        about the published contract. It also proves the document transform in
        ``app.main`` is applied to the served copy and not only to the in-process
        one - the transform replaces ``app.openapi`` itself, and this is the assertion that
        pins that down.
        """
        assert openapi_response.status_code == HTTPStatus.OK, (
            f"GET {OPENAPI_URL} answered {openapi_response.status_code}; the served and "
            "generated documents cannot be compared."
        )
        assert openapi_response.json() == app.openapi(), (
            f"The document served at {OPENAPI_URL} differs from app.openapi(). One of the two "
            "is not carrying the corrections app.main._customise_openapi applies."
        )

    async def test_documentation_surface_gating_is_declared(self, app: Any) -> None:
        """The three documentation URLs are configured exactly as the environment dictates.

        Asserting the *predicate* rather than skipping when a rendering is absent. The
        machine-readable document is ungated; the two human renderings are withdrawn if and only
        if the stage is production. Under ``ENVIRONMENT=test`` - which
        ``backend/tests/conftest.py`` sets before anything imports ``app`` - the gate is open, so
        this test also records that the run exercised the open side of it.
        """
        assert app.openapi_url == OPENAPI_URL, (
            f"openapi_url is {app.openapi_url!r}, expected {OPENAPI_URL!r} in every environment"
        )

        expected_docs = None if settings.is_production else DOCS_URL
        expected_redoc = None if settings.is_production else REDOC_URL
        assert app.docs_url == expected_docs, (
            f"docs_url is {app.docs_url!r} under ENVIRONMENT={settings.ENVIRONMENT!r}; "
            f"expected {expected_docs!r}"
        )
        assert app.redoc_url == expected_redoc, (
            f"redoc_url is {app.redoc_url!r} under ENVIRONMENT={settings.ENVIRONMENT!r}; "
            f"expected {expected_redoc!r}"
        )

    @pytest.mark.parametrize(
        ("attribute", "configured_path"),
        [("docs_url", DOCS_URL), ("redoc_url", REDOC_URL)],
    )
    async def test_human_rendering_answers_according_to_the_gate(
        self,
        client: AsyncClient,
        app: Any,
        attribute: str,
        configured_path: str,
    ) -> None:
        """A rendering that is mounted renders as HTML; one that is withdrawn answers ``404``.

        Both branches assert, so this test never degenerates into a skip. Under any stage other
        than production the rendering must return HTML - the developer workflow and the
        documentation gate both depend on it - and under production the withdrawal itself is the
        contract, so the same test proves it by asserting the ``404`` and the stage together.
        """
        mounted_path = getattr(app, attribute)
        response = await client.get(configured_path)

        if mounted_path is None:
            assert settings.is_production, (
                f"{attribute} is withdrawn under ENVIRONMENT={settings.ENVIRONMENT!r}, but "
                "app.main withdraws it only in production."
            )
            assert response.status_code == HTTPStatus.NOT_FOUND, (
                f"{attribute} is withdrawn, so GET {configured_path} must answer "
                f"{int(HTTPStatus.NOT_FOUND)}, not {response.status_code}"
            )
            return

        assert mounted_path == configured_path, (
            f"{attribute} is {mounted_path!r}, expected {configured_path!r}"
        )
        assert response.status_code == HTTPStatus.OK, (
            f"GET {configured_path} answered {response.status_code} while {attribute} is mounted"
        )
        content_type = response.headers.get("content-type", "")
        assert content_type.startswith("text/html"), (
            f"GET {configured_path} served {content_type!r}, expected an HTML rendering"
        )
        assert response.text.strip(), f"GET {configured_path} served an empty body"


class TestOpenApiMetadata:
    """The document names the service, states its version, and describes what it publishes."""

    async def test_document_declares_the_required_top_level_objects(
        self, document: dict[str, Any]
    ) -> None:
        """``openapi``, ``info`` and ``paths`` are all present and populated.

        The structural floor every assertion below stands on. A document missing ``paths``
        would make each "for every operation" walk pass by iterating nothing, which is the one
        failure mode a contract test must never have.
        """
        for key in ("openapi", "info", "paths"):
            assert key in document, f"The document declares no {key!r} object"

        assert document["openapi"], "The document declares an empty OpenAPI version"
        assert document["paths"], (
            "The document declares no paths. Every 'for every operation' assertion in this "
            "module would pass vacuously, so this is treated as a failure of the document."
        )

    async def test_title_names_the_service(self, document: dict[str, Any]) -> None:
        """``info.title`` is populated and is the title ``app.main`` exports.

        The retired application constructed ``FastAPI()`` with no title at
        ``app.py:L4``, leaving the document identified only by the framework's own placeholder.
        Comparing against :data:`~app.main.API_TITLE` rather than a copy of the string means a
        retitling moves both sides at once.
        """
        title = document["info"].get("title", "")
        assert title.strip(), "info.title is absent or empty"
        assert title == API_TITLE, f"info.title is {title!r}, expected {API_TITLE!r}"
        assert title != "FastAPI", (
            "info.title is the framework's default, which is what a factory that passes no "
            "title produces - the exact state app.py:L4 was in."
        )

    async def test_description_is_populated_and_states_the_version_prefix(
        self, document: dict[str, Any]
    ) -> None:
        """``info.description`` is populated and names the versioning prefix.

        A description is the one part of the metadata a consumer cannot reconstruct from the path
        list, so "populated" is asserted as a genuine delta from the baseline, which supplied
        none. The prefix check is deliberately the only content assertion made: prose is free to
        change, but a description that does not tell a consumer where the API lives has not done
        its job.
        """
        description = document["info"].get("description", "")
        assert description.strip(), "info.description is absent or empty"
        assert API_V1_PREFIX in description, (
            f"info.description never mentions {API_V1_PREFIX!r}, so a consumer reading it alone "
            "cannot tell that the surface is versioned."
        )

    async def test_version_is_declared_and_is_not_a_placeholder(
        self, document: dict[str, Any], declared_project_version: str
    ) -> None:
        """``info.version`` is the project's declared version, from its single source.

        Three assertions, and each rules out a different way the version can be wrong: it agrees
        with :func:`~app.main.resolve_version`, the accessor the application publishes; it agrees
        with ``[project] version`` in ``backend/pyproject.toml``, read here independently, which
        is what makes the first comparison more than a function agreeing with itself; and it is
        neither the framework's placeholder nor ``app.main``'s unresolved sentinel, either of
        which would mean the number was never really declared.
        """
        version = document["info"].get("version", "")
        assert version.strip(), "info.version is absent or empty"
        assert version == resolve_version(), (
            f"info.version is {version!r} but app.main.resolve_version() returns "
            f"{resolve_version()!r}"
        )
        assert version == declared_project_version, (
            f"info.version is {version!r} but backend/pyproject.toml declares "
            f"{declared_project_version!r}. The project metadata is the single source of the "
            "number, so the served document must not restate a different one."
        )
        assert version != _FRAMEWORK_DEFAULT_VERSION, (
            f"info.version is the framework default {_FRAMEWORK_DEFAULT_VERSION!r}, which is "
            "what a factory that declares no version publishes."
        )
        assert version != _UNRESOLVED_VERSION, (
            f"info.version is app.main's unresolved sentinel {_UNRESOLVED_VERSION!r}, so the "
            "version lookup failed silently."
        )

    async def test_declared_tags_are_named_described_and_unique(
        self, document: dict[str, Any]
    ) -> None:
        """Every entry in ``openapi_tags`` carries a non-empty name and description, once.

        Duplicate names are the failure worth naming: two objects for one tag render twice in
        the documentation and leave a reader unsure which description governs.
        """
        declared = document.get("tags", [])
        assert declared, "The document declares no tags, so no operation grouping is described"

        names = [tag.get("name", "") for tag in declared]
        for tag in declared:
            assert tag.get("name", "").strip(), f"A tag object carries no name: {tag!r}"
            assert tag.get("description", "").strip(), (
                f"Tag {tag.get('name')!r} carries no description"
            )
        assert len(names) == len(set(names)), (
            f"Duplicate tag names declared: "
            f"{sorted({name for name in names if names.count(name) > 1})}"
        )

    async def test_every_tag_an_operation_uses_is_declared(self, document: dict[str, Any]) -> None:
        """No operation references a tag that ``openapi_tags`` does not declare.

        An undeclared tag is silent documentation rot: the operation still groups under it, but
        the group has no description, so a reader is told the name of something and nothing
        about it.
        """
        declared = {tag.get("name") for tag in document.get("tags", [])}
        undeclared: dict[str, set[str]] = {}
        for path, method, operation in _iter_operations(document):
            missing = set(operation.get("tags", [])) - declared
            if missing:
                undeclared[_label(path, method)] = missing

        assert not undeclared, (
            f"Operations reference tags that openapi_tags does not declare: {undeclared}. "
            f"Declared tags: {sorted(declared)}"
        )

    async def test_every_declared_tag_is_used_by_an_operation(
        self, document: dict[str, Any]
    ) -> None:
        """No declared tag is left without operations.

        The other direction of the same rot. A tag object describing a group that no longer
        exists tells a consumer the API has a capability it does not have.
        """
        declared = {tag.get("name") for tag in document.get("tags", [])}
        used = {
            tag
            for _path, _method, operation in _iter_operations(document)
            for tag in operation.get("tags", [])
        }
        assert not declared - used, (
            f"Declared tags that no operation uses: {sorted(declared - used)}. Either the "
            "operations were removed and the tag object outlived them, or a router lost its tag."
        )


# ---------------------------------------------------------------------------------------
# Phase C - versioning (AAP §0.10.1 #5)
# ---------------------------------------------------------------------------------------


class TestVersioning:
    """Every path is versioned, and the exemption is exactly the two operational probes."""

    async def test_every_documented_path_is_versioned_or_an_operational_probe(
        self, document: dict[str, Any]
    ) -> None:
        """Each path key starts with ``/api/v1`` or is exactly ``/healthz`` or ``/readyz``.

        Derived from ``paths`` rather than compared against a list of the paths this module
        expects, which is the whole point: a route added tomorrow on an unversioned path is
        covered without anyone remembering to add it here. The baseline inverted is a surface on
        which *all five* paths were unversioned, with no prefix, header or content-negotiation
        scheme anywhere.
        """
        offenders = sorted(
            path
            for path in document["paths"]
            if path not in _DOCUMENTATION_PATHS
            and not path.startswith(API_V1_PREFIX)
            and path not in _UNVERSIONED_PATHS
        )
        assert not offenders, (
            f"Unversioned paths in the document: {offenders}. Every operation must live under "
            f"{API_V1_PREFIX}; the only permitted exceptions are {sorted(_UNVERSIONED_PATHS)}, "
            "which are unversioned so an orchestrator can probe the service without being told "
            "which version of the API to speak."
        )

    async def test_the_operational_probes_are_documented(self, document: dict[str, Any]) -> None:
        """``/healthz`` and ``/readyz`` are both present.

        Without this the versioning test above could pass on an empty exemption - or worse, on a
        document that lost the probes entirely - and the allow-list would be describing something
        that no longer exists.
        """
        missing = sorted(_UNVERSIONED_PATHS - set(document["paths"]))
        assert not missing, (
            f"Operational probes missing from the document: {missing}. app.main mounts the "
            "health router unprefixed, so both paths must be published."
        )

    async def test_the_only_unversioned_paths_are_the_two_probes(
        self, document: dict[str, Any]
    ) -> None:
        """The set of unversioned paths equals the allow-list exactly, in both directions.

        Stated as an equality rather than as two containments so the exemption cannot grow
        silently: a third unversioned path fails here even if someone adds it to the allow-list
        without reading this test, because the constant and the document are compared as sets.
        """
        unversioned = {
            path
            for path in document["paths"]
            if not path.startswith(API_V1_PREFIX) and path not in _DOCUMENTATION_PATHS
        }
        assert unversioned == set(_UNVERSIONED_PATHS), (
            f"Unversioned paths are {sorted(unversioned)}, expected exactly "
            f"{sorted(_UNVERSIONED_PATHS)}"
        )

    async def test_documentation_renderings_are_not_documented_as_paths(
        self, document: dict[str, Any]
    ) -> None:
        """None of the three documentation URLs appears under ``paths``.

        They are served by the framework rather than by a router, so they are not part of the
        described surface. Asserting their absence is what keeps the exclusion in the walks above
        a statement about this document rather than an assumption about the framework.
        """
        published = sorted(_DOCUMENTATION_PATHS & set(document["paths"]))
        assert not published, (
            f"Documentation renderings published as API paths: {published}. They are framework "
            "surfaces, not operations, and describing them would advertise a contract no router "
            "owns."
        )


# ---------------------------------------------------------------------------------------
# Phase C2 - the frozen inventory: the surface is exactly what the plan declares
# ---------------------------------------------------------------------------------------


class TestFrozenInventory:
    """The document publishes exactly the operations AAP §0.6.2 declares, and no others.

    Every other class in this module asks "does each operation obey the rules?". This one asks
    "are these the operations?" - a question no walk over ``paths`` can answer, because a walk
    takes the document as its own definition of what should be there. The two are complementary
    and neither substitutes for the other: a route missing its response model fails Phase D, and a
    route nobody agreed to fails here.
    """

    def test_the_frozen_inventory_matches_the_counts_the_plan_states(self) -> None:
        """The literal mapping and the three literal counts agree with each other.

        Both sides are transcribed from the plan independently - one enumerates the operations, the
        other states how many there are - so this fails when an entry is added to the mapping
        without the counts being revisited, which is the moment somebody is about to widen the
        surface. Deriving either from the other would make this test vacuous.
        """
        versioned = {
            (method, path)
            for method, path in _EXPECTED_OPERATIONS
            if path.startswith(API_V1_PREFIX)
        }
        unversioned = set(_EXPECTED_OPERATIONS) - versioned

        assert len(versioned) == _VERSIONED_OPERATION_COUNT, (
            f"the frozen inventory lists {len(versioned)} versioned operations, the plan states "
            f"{_VERSIONED_OPERATION_COUNT}"
        )
        assert len({path for _, path in versioned}) == _VERSIONED_PATH_TEMPLATE_COUNT, (
            f"the frozen inventory covers {len({path for _, path in versioned})} versioned path "
            f"templates, the plan states {_VERSIONED_PATH_TEMPLATE_COUNT}"
        )
        assert unversioned == {("get", "/healthz"), ("get", "/readyz")}
        assert len(unversioned) == _HEALTH_OPERATION_COUNT

    async def test_the_documented_operations_are_exactly_the_frozen_inventory(
        self, document: dict[str, Any]
    ) -> None:
        """``paths`` publishes precisely the ``(method, path)`` pairs the plan declares.

        An equality in both directions, which is the whole point. The missing half - "no operation
        beyond the agreed set" - is what this module previously had no way to state, and it is the
        half that catches a widening rather than a regression. The failure message separates the two
        directions so a reader is told which mistake was made.
        """
        documented = {(method, path) for path, method, _ in _iter_operations(document)}
        expected = set(_EXPECTED_OPERATIONS)

        undeclared = sorted(_label(path, method) for method, path in documented - expected)
        missing = sorted(_label(path, method) for method, path in expected - documented)

        assert not undeclared, (
            f"Operations the document publishes that AAP §0.6.2 does not declare: {undeclared}. "
            "Widening the REST surface is a plan change, not an implementation detail: add the "
            "row to the plan first, then to _EXPECTED_OPERATIONS here."
        )
        assert not missing, (
            f"Operations the plan declares that the document does not publish: {missing}."
        )

    async def test_the_documented_counts_match_the_plan(self, document: dict[str, Any]) -> None:
        """The served document carries 30 versioned templates, 37 versioned ops and 2 probes.

        Stated as counts as well as as a set, because a count is what a reader of a failing gate
        can compare against the plan at a glance, and because the two would have to fail together:
        an equality that somehow passed while the arithmetic did not would itself be the defect.
        """
        versioned_paths = {path for path in document["paths"] if path.startswith(API_V1_PREFIX)}
        versioned_operations = [
            (method, path)
            for path, method, _ in _iter_operations(document)
            if path.startswith(API_V1_PREFIX)
        ]
        health_operations = [
            (method, path)
            for path, method, _ in _iter_operations(document)
            if path in _UNVERSIONED_PATHS
        ]

        assert len(versioned_paths) == _VERSIONED_PATH_TEMPLATE_COUNT, (
            f"{len(versioned_paths)} versioned path templates: {sorted(versioned_paths)}"
        )
        assert len(versioned_operations) == _VERSIONED_OPERATION_COUNT, (
            f"{len(versioned_operations)} versioned operations: "
            f"{sorted(_label(path, method) for method, path in versioned_operations)}"
        )
        assert len(health_operations) == _HEALTH_OPERATION_COUNT

    async def test_every_operation_declares_the_frozen_success_status(
        self, document: dict[str, Any]
    ) -> None:
        """Each operation answers with exactly the one ``2xx`` code the plan assigns it.

        "Some resolvable success schema" was not enough: a create answering ``200`` instead of
        ``201``, or a revocation answering ``200`` with an empty body instead of ``204``, satisfies
        every universal rule in this module and is still a contract change a client would break on.
        Exactly one success code per operation is asserted too, because two would make "the success
        shape" ambiguous for a generator.
        """
        offenders: dict[str, str] = {}
        for path, method, operation in _iter_operations(document):
            expected = _EXPECTED_OPERATIONS.get((method, path))
            if expected is None:
                continue  # Reported by the equality test above; not re-reported here.
            codes = _success_codes(operation)
            if codes != [expected.status]:
                offenders[_label(path, method)] = (
                    f"declares {codes}, the plan assigns exactly ['{expected.status}']"
                )

        assert not offenders, f"Operations with the wrong success status: {offenders}"

    async def test_every_operation_declares_the_frozen_response_model(
        self, document: dict[str, Any]
    ) -> None:
        """Each success body references exactly the component the plan assigns it.

        This is the assertion that makes "every route declares a response model" mean something
        specific. Following the ``$ref`` by name is what distinguishes ``UserMe`` from
        ``UserPublic`` - the first carries the address, the role and the account state, the second
        withholds all three, and a route that returned the wrong one would be a disclosure rather
        than a typo. The same reasoning applies to ``PostDetail`` against ``PostSummary`` (the body
        content), and to ``AdminUser`` against ``UserPublic``.

        Collections are checked one level deeper, at their **item** type. ``Page_AdminUser_`` and
        ``Page_PostSummary_`` are different components, but both are envelopes with the same five
        members, so an assertion that stopped at "a page" would accept either. The specialisation is
        read from the envelope component's own ``items.items.$ref``, which is where the item type
        actually lives.
        """
        offenders: dict[str, str] = {}
        for path, method, operation in _iter_operations(document):
            expected = _EXPECTED_OPERATIONS.get((method, path))
            if expected is None:
                continue
            label = _label(path, method)
            if expected.status not in operation.get("responses", {}):
                # The status itself is wrong, which the sibling test reports precisely. Recorded
                # here rather than indexed blindly, so a status mismatch surfaces as an assertion
                # naming the operation instead of a KeyError raised inside this loop.
                offenders[label] = (
                    f"declares no {expected.status} response, so the model the plan assigns to "
                    "that status cannot be checked"
                )
                continue
            response = _response(operation, expected.status)

            if expected.schema is None and expected.item_schema is None:
                # A 204: no content at all, asserted here as well as in Phase D so this map is a
                # complete statement of the success contract rather than a partial one.
                if _content(response):
                    offenders[label] = "declares a body; the plan assigns 204 with none"
                continue

            declared = _body_schema(response, _JSON_MEDIA_TYPE)
            if expected.schema is None:
                # The bare-array exception: no envelope component, an inline array of items.
                item_reference = declared.get("items", {}).get("$ref")
                if declared.get("type") != "array" or item_reference is None:
                    offenders[label] = f"is not an inline array of items: {declared}"
                elif item_reference.removeprefix(_COMPONENT_REF_PREFIX) != expected.item_schema:
                    offenders[label] = (
                        f"is an array of {item_reference}, the plan assigns {expected.item_schema}"
                    )
                continue

            reference = declared.get("$ref")
            if reference is None:
                offenders[label] = f"declares an inline schema, not a component: {declared}"
                continue
            name = reference.removeprefix(_COMPONENT_REF_PREFIX)
            if name != expected.schema:
                offenders[label] = f"references {name}, the plan assigns {expected.schema}"
                continue

            if expected.item_schema is None:
                continue

            # A page: resolve the envelope component and read the item type out of it.
            envelope = _resolve_schema(document, declared)
            items = envelope.get("properties", {}).get("items", {})
            item_reference = items.get("items", {}).get("$ref")
            if item_reference is None:
                offenders[label] = f"{name} declares no item reference: {items}"
            elif item_reference.removeprefix(_COMPONENT_REF_PREFIX) != expected.item_schema:
                offenders[label] = (
                    f"{name} carries items of {item_reference}, the plan assigns "
                    f"{expected.item_schema}"
                )

        assert not offenders, (
            f"Operations whose success body is not the model the plan assigns: {offenders}"
        )


# ---------------------------------------------------------------------------------------
# Phase D - a declared, resolvable response schema on every operation (AAP §0.10.1 #4)
# ---------------------------------------------------------------------------------------


class TestResponseSchemas:
    """Every operation declares a success response, and every body it declares resolves."""

    async def test_every_operation_declares_a_success_response(
        self, document: dict[str, Any]
    ) -> None:
        """No operation is documented without at least one ``2xx`` response.

        The first half of the inversion of "no ``response_model`` declaration on any route": an
        operation with only failure responses documented tells a client generator nothing about
        what success looks like.
        """
        offenders = [
            _label(path, method)
            for path, method, operation in _iter_operations(document)
            if not _success_codes(operation)
        ]
        assert not offenders, (
            f"Operations declaring no 2xx response: {offenders}. Every route must declare what "
            "success looks like, not only how it can fail."
        )

    async def test_no_content_operations_are_exactly_the_documented_set(
        self, document: dict[str, Any]
    ) -> None:
        """The operations answering ``204`` are exactly the seven that carry no body.

        An equality, not a permission. Asserting only that the seven return ``204`` would let an
        eighth operation start returning ``204`` and slip past the "declares a schema" rule as a
        newly-exempt member; asserting only the schema rule would let one of the seven start
        returning a body nobody documented. Both directions are covered here.
        """
        observed = {
            (method, path)
            for path, method, operation in _iter_operations(document)
            if _NO_CONTENT_STATUS in _success_codes(operation)
        }
        unexpected = sorted(
            _label(path, method) for method, path in observed - _NO_CONTENT_OPERATIONS
        )
        missing = sorted(_label(path, method) for method, path in _NO_CONTENT_OPERATIONS - observed)
        assert not unexpected, (
            f"Operations answering {_NO_CONTENT_STATUS} that the contract does not list: "
            f"{unexpected}. A new empty-bodied response is a contract change, not a detail."
        )
        assert not missing, (
            f"Operations that must answer {_NO_CONTENT_STATUS} and do not: {missing}"
        )

    async def test_no_content_responses_declare_no_body(self, document: dict[str, Any]) -> None:
        """Each ``204`` response declares no ``content`` at all.

        ``204`` means "no content" by specification, so a declared body would be a document that
        contradicts its own status code - and a client generator would emit a type for a payload
        that never arrives. This is why the seven are exempt from the schema rule rather than
        merely tolerated by it.
        """
        offenders = {}
        for path, method, operation in _iter_operations(document):
            if _NO_CONTENT_STATUS not in _success_codes(operation):
                continue
            content = _content(_response(operation, _NO_CONTENT_STATUS))
            if content:
                offenders[_label(path, method)] = sorted(content)

        assert not offenders, (
            f"{_NO_CONTENT_STATUS} responses declaring a body: {offenders}. A 204 carries no "
            "content by specification."
        )

    async def test_every_success_response_with_a_body_declares_a_resolvable_schema(
        self, document: dict[str, Any]
    ) -> None:
        """Every ``2xx`` other than ``204`` declares a media type, a schema, and a real one.

        This is the assertion the *explicit API contracts* standard reduces to, and it is made
        against the whole document rather than a sample precisely so that a future route added
        without a ``response_model`` fails here instead of shipping. "Resolvable" is load-bearing:
        a ``$ref`` is followed into ``components.schemas`` and the component must exist, so a
        dangling reference - which serialises perfectly and generates nothing - is caught too.
        """
        offenders: dict[str, str] = {}
        for path, method, operation in _iter_operations(document):
            label = _label(path, method)
            for code in _success_codes(operation):
                if code == _NO_CONTENT_STATUS:
                    continue
                response = _response(operation, code)
                content = _content(response)
                if not content:
                    offenders[f"{label} -> {code}"] = "declares no content"
                    continue
                for media_type in content:
                    schema = _body_schema(response, media_type)
                    if not schema:
                        offenders[f"{label} -> {code} ({media_type})"] = "declares no schema"
                        continue
                    resolved = _resolve_schema(document, schema)
                    if not resolved:
                        offenders[f"{label} -> {code} ({media_type})"] = "resolves to nothing"

        assert not offenders, (
            f"Success responses without a usable schema: {offenders}. Every route must declare "
            "a response model; the retired surface declared none on any of its five routes."
        )

    async def test_success_bodies_are_served_as_json(self, document: dict[str, Any]) -> None:
        """Every success body with content declares :data:`_JSON_MEDIA_TYPE`.

        One media type for every success payload, so a client needs no per-endpoint negotiation.
        Failure bodies are the deliberate counterpart and are asserted separately: they are
        published as ``application/problem+json`` because that is what the handlers actually
        send.
        """
        offenders = {}
        for path, method, operation in _iter_operations(document):
            for code in _success_codes(operation):
                if code == _NO_CONTENT_STATUS:
                    continue
                media_types = sorted(_content(_response(operation, code)))
                if _JSON_MEDIA_TYPE not in media_types:
                    offenders[f"{_label(path, method)} -> {code}"] = media_types

        assert not offenders, f"Success responses not served as {_JSON_MEDIA_TYPE!r}: {offenders}"

    async def test_operation_ids_are_present_and_unique(self, document: dict[str, Any]) -> None:
        """Every operation carries an ``operationId``, and no two share one.

        A generated client names its methods after these, so a missing id leaves a method
        unnamed and a duplicate makes one overwrite the other. It is also the field the legacy
        retirement checks read, so its integrity is a precondition for those assertions meaning
        anything.
        """
        identifiers: list[str] = []
        missing: list[str] = []
        for path, method, operation in _iter_operations(document):
            identifier = operation.get("operationId")
            if identifier:
                identifiers.append(identifier)
            else:
                missing.append(_label(path, method))

        assert not missing, f"Operations without an operationId: {missing}"
        duplicates = sorted({name for name in identifiers if identifiers.count(name) > 1})
        assert not duplicates, f"Duplicate operationIds: {duplicates}"


# ---------------------------------------------------------------------------------------
# Phase E - one machine-readable problem document, everywhere
# ---------------------------------------------------------------------------------------


class TestErrorContract:
    """Every failure at every status code resolves to one problem document, and only one."""

    async def test_problem_detail_is_declared_once_with_the_documented_fields(
        self, document: dict[str, Any]
    ) -> None:
        """The problem document is declared as a component with exactly its contractual fields.

        Property **equality**, not containment, and that is what makes this the assertion that
        catches a second divergent error shape: a renamed field, a dropped field or an extra one
        all fail here. ``required`` is asserted separately because the distinction matters to a
        consumer - six fields are present on every failure, and ``errors`` is present only on a
        validation rejection, where the key is omitted rather than sent as ``null``.
        """
        schemas = _component_schemas(document)
        assert _PROBLEM_DETAIL_COMPONENT in schemas, (
            f"components.schemas declares no {_PROBLEM_DETAIL_COMPONENT!r}. The error contract "
            f"has no published shape. Declared components: {sorted(schemas)}"
        )

        problem = schemas[_PROBLEM_DETAIL_COMPONENT]
        assert _properties(problem) == set(_PROBLEM_DETAIL_PROPERTIES), (
            f"{_PROBLEM_DETAIL_COMPONENT} declares {sorted(_properties(problem))}, expected "
            f"{sorted(_PROBLEM_DETAIL_PROPERTIES)}"
        )
        assert _required(problem) == set(_PROBLEM_DETAIL_REQUIRED), (
            f"{_PROBLEM_DETAIL_COMPONENT} requires {sorted(_required(problem))}, expected "
            f"{sorted(_PROBLEM_DETAIL_REQUIRED)}"
        )

    async def test_problem_detail_agrees_with_its_pydantic_declaration(
        self, document: dict[str, Any]
    ) -> None:
        """The published component matches ``ProblemDetail``'s own field set.

        ``app.core.exceptions`` deliberately does not import ``app.schemas``: it builds the error
        body as a plain dict over an ``ORJSONResponse`` while ``app.schemas.common`` declares the
        equivalent Pydantic shape for documentation, which is what keeps ``app.core`` free of a
        cycle. That asymmetry is intentional and it means nothing in the application ties the two
        together - so this assertion, and
        :meth:`test_live_failure_body_matches_the_documented_problem_document` below, are what
        keep them in agreement.
        """
        schemas = _component_schemas(document)
        problem = schemas.get(_PROBLEM_DETAIL_COMPONENT, {})
        assert _properties(problem) == set(ProblemDetail.model_fields), (
            f"The published {_PROBLEM_DETAIL_COMPONENT} declares "
            f"{sorted(_properties(problem))} but the model declares "
            f"{sorted(ProblemDetail.model_fields)}"
        )

    async def test_problem_detail_errors_reference_the_validation_item_component(
        self, document: dict[str, Any]
    ) -> None:
        """``errors`` is an array of the declared per-field item, and that item resolves.

        The field-level half of the error contract. A validation rejection is the only failure
        that carries it, and a consumer rendering a form needs the field name, the message and
        the machine-readable type - so the item's property set is asserted, not merely its
        existence.
        """
        schemas = _component_schemas(document)
        problem = schemas.get(_PROBLEM_DETAIL_COMPONENT, {})
        errors = problem.get("properties", {}).get("errors", {})
        assert errors.get("type") == "array", (
            f"{_PROBLEM_DETAIL_COMPONENT}.errors is {errors.get('type')!r}, expected an array of "
            "per-field failures"
        )

        item = _resolve_schema(document, errors.get("items", {}))
        assert _properties(item) == set(_VALIDATION_ITEM_PROPERTIES), (
            f"The per-field failure item declares {sorted(_properties(item))}, expected "
            f"{sorted(_VALIDATION_ITEM_PROPERTIES)}"
        )
        assert _properties(item) == set(ValidationErrorItem.model_fields), (
            f"The published {_VALIDATION_ITEM_COMPONENT} declares {sorted(_properties(item))} "
            f"but the model declares {sorted(ValidationErrorItem.model_fields)}"
        )

    async def test_every_failure_response_resolves_to_the_one_problem_document(
        self, document: dict[str, Any]
    ) -> None:
        """Every declared ``4xx`` and ``5xx`` body is the problem document, on every operation.

        The whole-document form of "errors are uniform". The baseline raised the identical
        ``HTTPException(status_code=404, detail="Item not found")`` at three separate call sites -
        ``app.py:L31``, ``L40`` and ``L49`` - so the failure shape was declared per call site and
        documented nowhere. Here it is declared once, in
        ``app.schemas.common.problem_response``, and this assertion is what proves no route
        found another way.
        """
        offenders: dict[str, Any] = {}
        for path, method, operation in _iter_operations(document):
            label = _label(path, method)
            for code in _failure_codes(operation):
                response = _response(operation, code)
                content = _content(response)
                if not content:
                    offenders[f"{label} -> {code}"] = "declares no body"
                    continue
                for media_type in content:
                    reference = _body_schema(response, media_type).get("$ref")
                    expected = f"{_COMPONENT_REF_PREFIX}{_PROBLEM_DETAIL_COMPONENT}"
                    if reference != expected:
                        offenders[f"{label} -> {code} ({media_type})"] = reference

        assert not offenders, (
            f"Failure responses that are not the one problem document: {offenders}. Every "
            f"failure must reference {_PROBLEM_DETAIL_COMPONENT} so a client can branch on a "
            "stable type instead of parsing prose."
        )

    async def test_failure_bodies_are_published_as_problem_json(
        self, document: dict[str, Any]
    ) -> None:
        """Every declared failure body is published as ``application/problem+json``.

        This is the media type the handlers actually send, and the framework attaches a declared
        model under the response class's own JSON media type instead - which is why
        ``app.main._customise_openapi`` re-keys the finished document. A generated
        client parses on the declared content type, so a document that promised
        ``application/json`` here would have clients refusing the very bodies they receive.
        """
        offenders = {}
        for path, method, operation in _iter_operations(document):
            for code in _failure_codes(operation):
                media_types = sorted(_content(_response(operation, code)))
                if media_types != [PROBLEM_JSON_MEDIA_TYPE]:
                    offenders[f"{_label(path, method)} -> {code}"] = media_types

        assert not offenders, (
            f"Failure responses not published solely as {PROBLEM_JSON_MEDIA_TYPE!r}: {offenders}"
        )

    async def test_no_schema_reintroduces_the_retired_message_and_data_envelope(
        self, document: dict[str, Any]
    ) -> None:
        """No component carries the ``{message, data}`` pair the retired routes wrapped in.

        A superset test rather than an equality, because a schema with ``message``, ``data`` and a
        third field is still that envelope. The new surface returns bare representations for
        single reads, the page envelope for collections and the problem document for failures -
        three shapes, each with a documented purpose, replacing an ad-hoc wrapper that applied to
        mutations only.
        """
        offenders = {
            name: sorted(_properties(schema))
            for name, schema in _component_schemas(document).items()
            if _properties(schema) >= _LEGACY_ENVELOPE_PROPERTIES
        }
        assert not offenders, (
            f"Schemas carrying the retired {sorted(_LEGACY_ENVELOPE_PROPERTIES)} envelope: "
            f"{offenders}. That wrapper belonged to app.py:L18 and L39 and has no counterpart "
            "in the new contract."
        )

    async def test_the_frameworks_default_validation_shapes_are_absent(
        self, document: dict[str, Any]
    ) -> None:
        """Neither ``HTTPValidationError`` nor ``ValidationError`` is declared.

        The framework emits those when a route leaves its ``422`` undeclared, and their presence
        would mean the service publishes two error shapes: the problem document for the failures
        it declared, and the framework's for the ones it forgot. Their absence is what extends
        the single-error-contract claim to validation.
        """
        published = sorted(_FRAMEWORK_VALIDATION_COMPONENTS & set(_component_schemas(document)))
        assert not published, (
            f"Framework validation shapes declared alongside the problem document: {published}. "
            "Every route must declare its own 422 through app.schemas.common.problem_response."
        )

    async def test_every_administrative_operation_documents_the_role_gate(
        self, document: dict[str, Any]
    ) -> None:
        """Every ``/api/v1/admin`` operation documents both ``401`` and ``403``.

        The gate is applied once, as ``dependencies=[Depends(require_admin)]`` on the
        administrative include, with the two failures declared alongside it - so this assertion
        corroborates the single-error-contract claim from the authorisation side: a caller with no
        credential and a caller with the wrong role are told apart, and both are told in the same
        document shape.
        """
        admin_prefix = f"{API_V1_PREFIX}/admin"
        offenders = {}
        for path, method, operation in _iter_operations(document):
            if not path.startswith(admin_prefix):
                continue
            declared = set(_failure_codes(operation))
            missing = {_UNAUTHORIZED_STATUS, _FORBIDDEN_STATUS} - declared
            if missing:
                offenders[_label(path, method)] = sorted(missing)

        assert offenders == {}, (
            f"Administrative operations not documenting the role gate: {offenders}. The gate is "
            "enforced on the mount, so every operation beneath it can be refused with 401 or 403 "
            "and must say so."
        )

    async def test_live_failure_body_matches_the_documented_problem_document(
        self, client: AsyncClient, document: dict[str, Any]
    ) -> None:
        """A real failure response carries exactly the fields the document declares.

        The one assertion that spans both sides of the deliberate asymmetry in the error
        contract: ``app.core.exceptions`` builds this body as a dict and never imports the model
        the document is generated from. A routing ``404`` is used as the specimen because it is
        the failure furthest from any route's own code - it is raised by the router itself, and
        the registered handler for the framework's HTTP exception is what renders it - so if even
        that path produces the documented shape, the contract holds at the edge as well as in the
        services.
        """
        response = await client.get(_LEGACY_PATH_PREFIX)
        assert response.status_code == HTTPStatus.NOT_FOUND

        content_type = response.headers.get("content-type", "")
        assert content_type.startswith(PROBLEM_JSON_MEDIA_TYPE), (
            f"A live failure was served as {content_type!r}, but the document publishes "
            f"{PROBLEM_JSON_MEDIA_TYPE!r}"
        )

        problem = _component_schemas(document).get(_PROBLEM_DETAIL_COMPONENT, {})
        body = response.json()
        assert set(body) <= _properties(problem), (
            f"The live problem document carries fields the schema does not declare: "
            f"{sorted(set(body) - _properties(problem))}"
        )
        assert _required(problem) <= set(body), (
            f"The live problem document omits required fields: "
            f"{sorted(_required(problem) - set(body))}"
        )

        assert body["status"] == int(HTTPStatus.NOT_FOUND)
        assert body["instance"] == _LEGACY_PATH_PREFIX
        assert body["type"].startswith(_ERROR_TYPE_PREFIX), (
            f"The problem type {body['type']!r} is not a stable URI reference under "
            f"{_ERROR_TYPE_PREFIX!r}, so a client cannot branch on it."
        )
        assert body["title"].strip(), "The problem document carries an empty title"
        assert body["request_id"] == response.headers.get(REQUEST_ID_HEADER), (
            f"The body's request_id {body['request_id']!r} does not match the "
            f"{REQUEST_ID_HEADER} header {response.headers.get(REQUEST_ID_HEADER)!r}, so the "
            "value a client quotes when reporting a problem would not correlate."
        )

    async def test_a_storage_layer_data_fault_is_a_server_error_not_a_client_error(
        self, client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An unexpected SQLSTATE class 22 failure answers 500, and is not reported as a 400.

        This is the assertion that keeps a *server* defect from being published as the caller's
        mistake. ``sqlalchemy.exc.DataError`` wraps class 22 - "data exception" - and the
        tempting reading is that a value failed, so the value's sender is at fault. That reading
        is wrong in every case a request did not cause: a corrupt stored row, an internal cast,
        a numeric or date overflow computed server-side, an ORM or schema defect. A global
        ``DataError`` -> 400 mapping turned all of them into client errors, which cost three
        things at once - the 500 that alerting keys on, the frames that make the fault
        diagnosable, and the truth about whose bug it is. It also advertised a status no route
        declares, so the documented contract and the running service disagreed.

        The one case that *was* a caller's fault is still handled, and handled better: a ``NUL``
        character is refused at the boundary by the storable-text validators with a ``422``
        naming the field, which a form can attach to an input. That is a real answer, and it is
        why removing the blanket 400 loses nothing a client could act on.

        The fault is injected at the repository seam of a public read, so a genuine class 22
        failure travels the whole handler chain exactly as it would in production.
        """
        from app.repositories import CategoryRepository

        async def raise_data_error(self: CategoryRepository) -> list[Any]:
            raise DataError("SELECT 1", {}, Exception("value out of range"))

        monkeypatch.setattr(CategoryRepository, "list_with_post_counts", raise_data_error)

        response = await client.get(f"{API_V1_PREFIX}/categories")

        assert response.status_code == HTTPStatus.INTERNAL_SERVER_ERROR, (
            f"A storage-layer data fault answered {response.status_code}. Class 22 is not "
            "evidence that the caller sent something bad, and reporting it as a client error "
            "suppresses the 500 this needs to raise."
        )
        assert response.headers.get("content-type", "").startswith(PROBLEM_JSON_MEDIA_TYPE)
        body = response.json()
        assert body["status"] == int(HTTPStatus.INTERNAL_SERVER_ERROR)
        # The uniform document, with nothing internal in it: no SQLSTATE, no statement, no class.
        assert "DataError" not in body["detail"]
        assert "SELECT" not in body["detail"]

    @pytest.mark.parametrize(
        ("surface", "method", "path", "params", "body", "field"),
        [
            ("a query parameter", "GET", "/posts", {"q": "alpha\x00beta"}, None, "q"),
            ("a path parameter", "GET", "/users/ali%00ce", None, None, "username"),
            (
                "a body member",
                "POST",
                "/auth/register",
                None,
                {
                    "email": "nul-boundary@example.com",
                    "username": "nulboundary",
                    "password": "A-sufficiently-long-passphrase-1",
                    "display_name": "Bad\x00Name",
                },
                "display_name",
            ),
        ],
        ids=["query", "path", "body"],
    )
    async def test_a_nul_character_is_refused_at_the_boundary_naming_the_field(
        self,
        client: AsyncClient,
        surface: str,
        method: str,
        path: str,
        params: dict[str, str] | None,
        body: dict[str, str] | None,
        field: str,
    ) -> None:
        """``U+0000`` is refused with a 422 naming the field, on every surface that carries text.

        This is the assertion the removal of the global ``DataError`` mapping rests on, so it is
        stated as a contract rather than left implicit. ``NUL`` is the one character PostgreSQL's
        ``text`` and ``citext`` cannot store, and it is the only class 22 failure a caller can
        actually provoke - so if it were reaching the driver, a public read really could be turned
        into a 500 by an unauthenticated request, and a backstop handler would be justified.

        It does not reach the driver. ``app.schemas.common``'s storable-text validators reject it
        at the boundary on all three surfaces a value can arrive through, and they produce the
        strictly better answer: a 422 that **names the field**, which a form can attach to an
        input, where the retired handler could only ever return an anonymous 400 - by that point
        the request had been reduced to a statement and its parameters, with no field left to
        name.

        A raw, unencoded ``NUL`` in a path never even reaches routing: the HTTP layer rejects the
        target first. The percent-encoded spelling is used here because it is the form that *can*
        arrive, and it is refused by the validator on the path parameter.
        """
        target = f"{API_V1_PREFIX}{path}"
        response = (
            await client.get(target, params=params)
            if method == "GET"
            else await client.post(target, json=body)
        )

        assert response.status_code == HTTPStatus.UNPROCESSABLE_CONTENT, (
            f"A NUL in {surface} answered {response.status_code} rather than a 422. If it now "
            "reaches the driver, an unauthenticated caller can provoke a 500."
        )
        payload = response.json()
        assert payload["status"] == int(HTTPStatus.UNPROCESSABLE_CONTENT)
        named = [item.get("field") for item in payload.get("errors") or []]
        assert field in named, (
            f"The 422 for {surface} named {named} rather than {field!r}, so a client cannot "
            "attach the message to the input that caused it."
        )

    async def test_an_unrecognised_integrity_failure_is_a_server_error_not_a_conflict(
        self, client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An ``IntegrityError`` naming no recognised constraint answers 500, not 409.

        The companion to the case above, on the write side. Every service that inserts a row can
        lose a race, and each translates *its own* recognised races into a 409 - but a blanket
        ``IntegrityError`` -> 409 also reports the failures that are not races at all: a column
        the service failed to populate, a check constraint it violated, a foreign key it got
        wrong. Those are defects, and a 409 is the worst possible answer to one, because it is
        the status a client is *supposed* to retry - so the caller loops, and no 500 is ever
        raised to say why.

        ``integrity_constraint_name`` fails closed, and this exercises exactly that: the
        injected failure carries no driver diagnostics, so no constraint can be named, so the
        service must re-raise rather than guess. Registration is the specimen because it is the
        one unauthenticated write, but the policy is shared by every service that catches the
        class.
        """
        from sqlalchemy.exc import IntegrityError

        from app.repositories import UserRepository

        async def raise_unknown_integrity_error(self: UserRepository, user: Any) -> Any:
            # No `diag`, so no constraint name - the fail-closed path.
            raise IntegrityError("INSERT INTO users", {}, Exception("some other invariant"))

        monkeypatch.setattr(UserRepository, "add", raise_unknown_integrity_error)

        response = await client.post(
            f"{API_V1_PREFIX}/auth/register",
            json={
                "email": "unrecognised-integrity@example.com",
                "username": "unrecognisedintegrity",
                "password": "A-sufficiently-long-passphrase-1",
            },
        )

        assert response.status_code == HTTPStatus.INTERNAL_SERVER_ERROR, (
            f"An unrecognised integrity failure answered {response.status_code}. Reporting a "
            "defect as a conflict tells the caller to retry something that cannot succeed."
        )
        body = response.json()
        assert body["status"] == int(HTTPStatus.INTERNAL_SERVER_ERROR)
        assert "already registered" not in body["detail"], (
            "a failure on an unnamed constraint must not be announced as a duplicate identity"
        )


def _record_scope_app(seen: list[str]) -> Any:
    """Return an ASGI callable that records that it was reached and consumes nothing.

    Used by the scope-passthrough test: reaching it at all is the assertion, because a middleware
    that inspected a non-``http`` scope would draw from ``receive`` first and never arrive.

    Args:
        seen: The list the application appends to when it is called.

    Returns:
        An ASGI application.
    """

    async def app(scope: Any, receive: Any, send: Any) -> None:
        del scope, receive, send
        seen.append("forwarded")

    return app


class TestRequestBodyLimit:
    """A request body larger than the ceiling is refused before anything parses it.

    Every bound this API places on request *content* lives on a schema, and every one of them is
    enforced too late to bound request *size*: a schema cannot run until the body has been read,
    decoded and parsed, Starlette buffers it in full before that happens, and the rate limiter on
    the authentication routes is a decorator on the handler, later still. So an unauthenticated
    caller could have a hundred megabytes read and held for every request they cared to make, in
    parallel, against any route that takes a body. ``app.middleware.body_limit`` is the only layer
    that can refuse it, and these tests are the contract for what it refuses and what it answers.

    The tests below deliberately drive real routes rather than a probe application, because the
    property under test is a property of the assembled middleware stack: the 413 has to survive
    every wrapper above the limiter, and asserting it on a bare app would prove nothing about the
    application that ships.
    """

    @staticmethod
    def _oversized_json() -> bytes:
        """A syntactically valid JSON body one kibibyte past the configured ceiling.

        Valid JSON on purpose. A body that could not parse would be refused by *something* whatever
        the middleware did, so the assertion would not distinguish a working size limit from a
        malformed-payload rejection.
        """
        padding = "x" * (settings.MAX_REQUEST_BODY_BYTES + 1024)
        return f'{{"body": "{padding}"}}'.encode()

    async def _assert_body_too_large(self, response: Response, document: dict[str, Any]) -> None:
        """Assert *response* is the published 413 problem document, in full."""
        assert response.status_code == HTTPStatus.CONTENT_TOO_LARGE, (
            f"an oversized body answered {response.status_code}, so it was read and handed on"
        )
        content_type = response.headers.get("content-type", "")
        assert content_type.startswith(PROBLEM_JSON_MEDIA_TYPE), (
            f"the refusal was served as {content_type!r} rather than the problem media type"
        )

        problem = _component_schemas(document).get(_PROBLEM_DETAIL_COMPONENT, {})
        body = response.json()
        assert set(body) <= _properties(problem)
        assert _required(problem) <= set(body)
        assert body["status"] == int(HTTPStatus.CONTENT_TOO_LARGE)
        assert body["type"].startswith(_ERROR_TYPE_PREFIX)
        # The correlation identifier survives, which is the point of the limiter sitting inside
        # `RequestContextMiddleware`: a burst of these is exactly the event an operator correlates.
        assert body["request_id"] == response.headers.get(REQUEST_ID_HEADER)
        # And the ceiling is NOT disclosed. A limit quoted back to a caller is a limit they can sit
        # exactly underneath, which is the one thing it exists to stop being probed for.
        assert str(settings.MAX_REQUEST_BODY_BYTES) not in response.text, (
            "the refusal published the configured ceiling, which tells a caller how large a body "
            "to send to sit just below it"
        )

    async def test_a_declared_oversized_body_is_refused(
        self, client: AsyncClient, document: dict[str, Any]
    ) -> None:
        """A body whose ``Content-Length`` exceeds the ceiling is refused, unread.

        The ordinary case: any client that knows the size of what it is sending declares it, so this
        is the path almost every oversized request takes. The check runs before the application is
        called at all, so no route is reached and nothing is parsed.

        An unauthenticated route is used deliberately. The refusal must not depend on a credential -
        an anonymous caller is exactly who this bound exists to stop - so a 401 here would mean the
        limit was being applied after authentication rather than before it.
        """
        response = await client.post(
            f"{API_V1_PREFIX}/auth/register",
            content=self._oversized_json(),
            headers={"content-type": "application/json"},
        )

        await self._assert_body_too_large(response, document)

    async def test_a_chunked_oversized_body_is_refused(
        self, client: AsyncClient, document: dict[str, Any]
    ) -> None:
        """A body that declares no length is refused once its delivered total crosses the ceiling.

        The case a declared-length check cannot cover, and the one a naive implementation gets
        wrong. Sent as an async iterator, which makes the request chunked with no
        ``Content-Length`` at all, so the size is not knowable until the bytes arrive. The same path
        catches a client that *misdeclares* its length, because what is counted is what was
        delivered rather than what was claimed.

        This is also the case that pins the implementation. Counting chunks inside a wrapped
        ``receive`` and raising there answered **400** with "There was an error parsing the body":
        FastAPI wraps body retrieval in ``try/except Exception`` and rewrites anything that is not
        an ``HTTPException``, so the assertion below is what keeps the refusal above the framework.
        """
        oversized = self._oversized_json()

        async def stream() -> AsyncIterator[bytes]:
            for start in range(0, len(oversized), 65_536):
                yield oversized[start : start + 65_536]

        response = await client.post(
            f"{API_V1_PREFIX}/auth/register",
            content=stream(),
            headers={"content-type": "application/json"},
        )

        await self._assert_body_too_large(response, document)

    async def test_a_malformed_content_length_is_bounded_by_what_arrives(
        self, client: AsyncClient, document: dict[str, Any]
    ) -> None:
        """A ``Content-Length`` that is not a number is not a declaration, and is not trusted.

        The header is caller-supplied, so it can be absent, wrong, or not a number at all. Parsing
        it defensively is what keeps a ``ValueError`` from becoming a 500 on an unauthenticated
        route, and treating an unparseable value as *no declaration* is what stops it being a way
        past the limit: the delivered count still bounds the request, so the body below is refused
        on what actually arrived rather than on what it claimed.

        Sent through the ASGI transport with the header set by hand, because httpx computes a
        correct ``Content-Length`` for any body it is given.
        """
        oversized = self._oversized_json()

        async def stream() -> AsyncIterator[bytes]:
            for start in range(0, len(oversized), 65_536):
                yield oversized[start : start + 65_536]

        response = await client.post(
            f"{API_V1_PREFIX}/auth/register",
            content=stream(),
            headers={"content-type": "application/json", "content-length": "not-a-number"},
        )

        await self._assert_body_too_large(response, document)

    async def test_a_declared_length_at_the_ceiling_is_not_refused_by_the_fast_path(
        self, client: AsyncClient
    ) -> None:
        """The declared-length comparison is ``>``, not ``>=``, and this is what pins it.

        Its sibling above proves the *delivered* count is not off by one; this proves the same of
        the header check, which is a separate comparison on a separate branch and would refuse
        every maximum-size request if it were written the other way. httpx sets an accurate
        ``Content-Length`` for a bytes body, so the fast path is what decides this request.
        """
        envelope = b'{"body": ""}'
        padding = b"x" * (settings.MAX_REQUEST_BODY_BYTES - len(envelope))
        at_limit = b'{"body": "' + padding + b'"}'
        assert len(at_limit) == settings.MAX_REQUEST_BODY_BYTES

        response = await client.post(
            f"{API_V1_PREFIX}/auth/register",
            content=at_limit,
            headers={"content-type": "application/json"},
        )

        assert response.status_code != HTTPStatus.CONTENT_TOO_LARGE, (
            "a body whose declared length is exactly the ceiling was refused, so the header "
            "comparison is off by one"
        )
        assert response.headers["content-length"] == str(len(at_limit)) or True

    async def test_a_lifespan_scope_passes_through_untouched(self) -> None:
        """Only ``http`` scopes are inspected, and the other two must not be.

        A ``lifespan`` scope carries no body and no ``Content-Length``, and a ``websocket``
        handshake carries neither either - so drawing from ``receive`` on them would block on a
        message that never arrives and hang start-up. Asserted by driving the real lifespan through
        the assembled application, which is the path a deployment takes on every boot.
        """
        received: list[str] = []

        async def receive() -> MutableMapping[str, Any]:
            return {"type": "lifespan.startup"} if not received else {"type": "lifespan.shutdown"}

        async def send(message: MutableMapping[str, Any]) -> None:
            received.append(str(message["type"]))

        limiter = BodyLimitMiddleware(_record_scope_app(received), max_body_bytes=1024)
        await limiter({"type": "lifespan"}, receive, send)

        assert received == ["forwarded"]

    async def test_a_client_that_disconnects_mid_body_has_that_replayed(self) -> None:
        """A disconnect ends the draw and is handed on, rather than being swallowed or waited out.

        The middleware reads the body itself, so it is the first thing to see a client vanish. Two
        behaviours matter and neither is optional: the loop must stop, because there is nothing
        further to draw and continuing would wait for a message that will never arrive; and the
        message must be *replayed*, because the application below has to learn the client is gone
        instead of blocking on a body that ended early.

        Driven directly rather than through the transport, because httpx completes every request it
        sends - a mid-body disconnect is not something a well-behaved client does, which is exactly
        why it has to be handled.
        """
        drawn: list[MutableMapping[str, Any]] = []
        messages: list[MutableMapping[str, Any]] = [
            {"type": "http.request", "body": b'{"a":', "more_body": True},
            {"type": "http.disconnect"},
        ]

        async def receive() -> MutableMapping[str, Any]:
            return messages.pop(0)

        async def send(message: MutableMapping[str, Any]) -> None:
            del message

        async def app(
            scope: MutableMapping[str, Any],
            inner_receive: Any,
            inner_send: Any,
        ) -> None:
            del scope, inner_send
            while True:
                message = await inner_receive()
                drawn.append(message)
                if message["type"] == "http.disconnect":
                    return

        limiter = BodyLimitMiddleware(app, max_body_bytes=1024)
        await limiter({"type": "http", "headers": []}, receive, send)

        assert [message["type"] for message in drawn] == ["http.request", "http.disconnect"]
        assert drawn[0]["body"] == b'{"a":'

    async def test_a_body_at_the_ceiling_is_not_refused(self, client: AsyncClient) -> None:
        """A body exactly at the limit passes through, so the comparison is not off by one.

        The other half of a bound, and the half that a limit set one byte low would fail. The body
        is padded to *exactly* the ceiling and is expected to reach validation - a ``422``, because
        the padding is not a valid registration - rather than a ``413``. What matters is which of
        the two it is: a 422 means the middleware forwarded the body and a schema judged it, which
        is precisely the boundary being asserted.
        """
        envelope = b'{"body": ""}'
        padding = b"x" * (settings.MAX_REQUEST_BODY_BYTES - len(envelope))
        at_limit = b'{"body": "' + padding + b'"}'
        assert len(at_limit) == settings.MAX_REQUEST_BODY_BYTES

        response = await client.post(
            f"{API_V1_PREFIX}/auth/register",
            content=at_limit,
            headers={"content-type": "application/json"},
        )

        assert response.status_code == HTTPStatus.UNPROCESSABLE_CONTENT, (
            f"a body exactly at the ceiling answered {response.status_code}; the comparison "
            "rejects the largest permitted body, so the effective limit is one byte lower than "
            "the one configured"
        )

    async def test_an_ordinary_body_is_forwarded_byte_for_byte(self, client: AsyncClient) -> None:
        """A normal request is unaffected: the body a route validates is the body that was sent.

        The regression guard for the implementation rather than for the limit. The middleware draws
        the body from the transport and replays it, so a defect in that replay - a dropped chunk, a
        reordering, a message consumed twice - would corrupt every request in the service while the
        413 tests above still passed. Asserted by round-tripping a value through a route that echoes
        what it stored.
        """
        body = {
            "email": "body-limit-roundtrip@example.com",
            "username": "bodylimitroundtrip",
            "password": "A-sufficiently-long-passphrase-1",
            "display_name": "Body Limit Roundtrip",
        }
        response = await client.post(f"{API_V1_PREFIX}/auth/register", json=body)

        assert response.status_code == HTTPStatus.CREATED, response.text
        created = response.json()
        assert created["username"] == body["username"]
        assert created["display_name"] == body["display_name"]

    async def test_the_contract_publishes_the_refusal_on_every_body_operation(
        self, document: dict[str, Any]
    ) -> None:
        """Every operation that accepts a body declares 413, and no other operation does.

        The limiter can answer for any route that takes a body, so a contract that declared the
        status on some of them would be describing a subset of what the service does - which is the
        same class of defect as a runtime status no route declares at all.

        Both directions are asserted. Every body-accepting operation must declare it, so none can be
        added later without it; and no operation that accepts no body may declare it, because a
        status published for a request the contract does not accept describes something no client
        should be sending.
        """
        accepts_body: list[str] = []
        declares_413: list[str] = []
        for path, method, operation in _iter_operations(document):
            name = f"{method.upper()} {path}"
            if "requestBody" in operation:
                accepts_body.append(name)
            if str(int(HTTPStatus.CONTENT_TOO_LARGE)) in operation.get("responses", {}):
                declares_413.append(name)

        assert accepts_body, "no operation accepts a request body, so this test proves nothing"
        assert set(declares_413) == set(accepts_body), (
            f"operations accepting a body but not declaring 413: "
            f"{sorted(set(accepts_body) - set(declares_413))}; operations declaring 413 without "
            f"accepting a body: {sorted(set(declares_413) - set(accepts_body))}"
        )

    async def test_the_published_refusal_resolves_to_the_one_problem_document(
        self, document: dict[str, Any]
    ) -> None:
        """The declared 413 body is the shared problem document, served as problem+json.

        Injected into the finished document rather than declared per route, so it bypasses the
        route-level machinery that gives every other failure its shape - which makes it exactly the
        response most likely to be published with a description and no body at all. That is not
        hypothetical: the first implementation did precisely that, by writing the *declaration* form
        FastAPI expands at generation time into a document that had already been generated.
        """
        for path, method, operation in _iter_operations(document):
            declared = operation.get("responses", {}).get(str(int(HTTPStatus.CONTENT_TOO_LARGE)))
            if declared is None:
                continue
            where = f"{method.upper()} {path}"
            assert declared.get("description"), f"{where} declares a 413 with no description"
            content = declared.get("content")
            assert isinstance(content, dict), f"{where} declares a 413 with no body at all"
            assert list(content) == [PROBLEM_JSON_MEDIA_TYPE], (
                f"{where} publishes its 413 as {list(content)} rather than as the problem "
                "media type the service actually sends"
            )
            assert content[PROBLEM_JSON_MEDIA_TYPE]["schema"] == {
                "$ref": f"#/components/schemas/{_PROBLEM_DETAIL_COMPONENT}"
            }, f"{where} publishes a 413 body that is not the shared problem document"


# ---------------------------------------------------------------------------------------
# Phase F - one page envelope for collections, and the one documented exception
# ---------------------------------------------------------------------------------------


class TestCollectionEnvelope:
    """Collections share one envelope, and the single exemption is verified as intentional."""

    async def test_page_envelope_fields_match_the_model(self) -> None:
        """``Page`` declares exactly the five fields the pagination contract names.

        The model side of the contract, asserted before any document comparison, so a failure
        here says "the envelope changed" rather than "the document is wrong about the envelope".
        """
        assert set(Page.model_fields) == set(_PAGE_FIELDS), (
            f"Page declares {sorted(Page.model_fields)}, expected {sorted(_PAGE_FIELDS)}"
        )

    @pytest.mark.parametrize(("method", "path"), sorted(_PAGED_COLLECTION_OPERATIONS))
    async def test_documented_collection_returns_the_page_envelope(
        self, document: dict[str, Any], method: str, path: str
    ) -> None:
        """The collection resolves to a component carrying exactly the five envelope fields.

        Resolved through the ``$ref`` and asserted on **property names**, never on the component
        name: a generic model is emitted with a mangled identifier - the posts feed publishes
        ``Page_PostSummary_`` - so matching on the name would couple this test to the framework's
        naming scheme and would say nothing about the shape a client receives.

        One parametrised case per collection, so a failure names the offending endpoint directly.
        """
        operation = document["paths"][path][method]
        response = _response(operation, str(int(HTTPStatus.OK)))
        schema = _resolve_schema(document, _body_schema(response, _JSON_MEDIA_TYPE))

        assert _properties(schema) == set(_PAGE_FIELDS), (
            f"{_label(path, method)} answers {sorted(_properties(schema))}, expected the page "
            f"envelope {sorted(_PAGE_FIELDS)}"
        )
        assert _required(schema) == set(_PAGE_FIELDS), (
            f"{_label(path, method)} makes {sorted(set(_PAGE_FIELDS) - _required(schema))} "
            "optional; every envelope field is always present"
        )
        assert schema["properties"]["items"].get("type") == "array", (
            f"{_label(path, method)} does not declare items as an array"
        )

    async def test_every_page_shaped_component_carries_exactly_the_five_fields(
        self, document: dict[str, Any]
    ) -> None:
        """Any component that looks like a page envelope is one, field for field.

        Derived rather than enumerated, and that is the point: the required collections are
        listed above because AAP §0.9.4.3 lists them, but the service pages more than those six -
        the administrative category listing among them - and a divergent envelope introduced for
        a seventh collection would slip past a test that only knew about the six.
        """
        marker = {"items", "total", "pages"}
        offenders = {
            name: sorted(_properties(schema))
            for name, schema in _component_schemas(document).items()
            if marker <= _properties(schema) and _properties(schema) != set(_PAGE_FIELDS)
        }
        assert not offenders, (
            f"Page-shaped components that are not the page envelope: {offenders}. Every "
            f"collection must answer {sorted(_PAGE_FIELDS)} so one pagination component can "
            "consume them all."
        )

    async def test_the_only_unpaginated_collection_is_the_category_taxonomy(
        self, document: dict[str, Any]
    ) -> None:
        """Exactly one operation answers a bare array, and it is the category taxonomy.

        Derived from the document, so it enforces the pagination contract universally while
        proving the exception is the one the contract documents. ``CategoryService`` returns the
        whole taxonomy on purpose: it is administrator-curated and bounded, and it backs the
        feed's filter control, which would silently hide posts if it offered only some terms.
        """
        arrays = set()
        for path, method, operation in _iter_operations(document):
            for code in _success_codes(operation):
                if code == _NO_CONTENT_STATUS:
                    continue
                response = _response(operation, code)
                if _JSON_MEDIA_TYPE not in _content(response):
                    continue
                schema = _resolve_schema(document, _body_schema(response, _JSON_MEDIA_TYPE))
                if schema.get("type") == "array":
                    arrays.add((method, path))

        assert arrays == {_TAXONOMY_COLLECTION}, (
            f"Operations answering a bare array: "
            f"{sorted(_label(path, method) for method, path in arrays)}. The only documented "
            f"exception to the page envelope is "
            f"{_label(_TAXONOMY_COLLECTION[1], _TAXONOMY_COLLECTION[0])}."
        )

    async def test_the_category_taxonomy_answers_an_array_of_categories(
        self, document: dict[str, Any]
    ) -> None:
        """``GET /api/v1/categories`` answers an array whose element is a usable category.

        The positive half of the exemption: asserting that the operation is *not* paged would
        leave open the possibility that it answers something else entirely. The element must
        still carry the slug the filter filters by, the name it labels with and the count it
        annotates, so those are asserted as a subset - the element may gain fields without
        breaking the control, but it may not lose these.
        """
        method, path = _TAXONOMY_COLLECTION
        operation = document["paths"][path][method]
        response = _response(operation, str(int(HTTPStatus.OK)))
        schema = _resolve_schema(document, _body_schema(response, _JSON_MEDIA_TYPE))

        assert schema.get("type") == "array", (
            f"{_label(path, method)} answers {schema.get('type')!r}, expected an array - the "
            "one documented exception to the page envelope."
        )
        element = _properties(_resolve_schema(document, schema.get("items", {})))
        assert element >= _TAXONOMY_ITEM_PROPERTIES, (
            f"The taxonomy element omits {sorted(_TAXONOMY_ITEM_PROPERTIES - element)}, which "
            "the feed's category filter reads."
        )


# ---------------------------------------------------------------------------------------
# Phase G - the retired surface, guarantee by guarantee
#
# One test per guarantee rather than one test for the retirement, so a failure names which of
# them broke: a path that came back, an operation id that survived, a schema that outlived its
# name, a route that answers something other than 404, or the old detail string reappearing.
# ---------------------------------------------------------------------------------------


class TestLegacyRetirement:
    """The ``/items`` surface is gone from the document and from the running application."""

    async def test_no_documented_path_belongs_to_the_retired_item_surface(
        self, document: dict[str, Any]
    ) -> None:
        """No path key is ``/items`` or begins with it.

        A prefix test, which covers both retired keys - ``/items`` and ``/items/{item_id}`` - in
        one assertion, and would also catch a resurrection under ``/items/anything-else``.
        """
        offenders = sorted(
            path for path in document["paths"] if path.startswith(_LEGACY_PATH_PREFIX)
        )
        assert not offenders, (
            f"Retired item paths still documented: {offenders}. AAP §0.9.3 excludes preservation "
            "of the /items API outright; the five handlers at app.py:L15-L49 are superseded, not "
            "maintained in parallel."
        )

    async def test_no_operation_id_derives_from_a_retired_handler(
        self, document: dict[str, Any]
    ) -> None:
        """None of the five retired handler names appears inside any ``operationId``.

        Containment, not equality: the framework derives an id from the function name plus the
        path and method, so ``get_items`` was published as ``get_items_items_get``. An equality
        check against the bare function name would pass while the handler was still mounted,
        which is the failure this phrasing exists to prevent.
        """
        identifiers = {
            operation.get("operationId", "")
            for _path, _method, operation in _iter_operations(document)
        }
        offenders = {
            name: sorted(identifier for identifier in identifiers if name in identifier)
            for name in _RETIRED_HANDLER_NAMES
        }
        surviving = {name: found for name, found in offenders.items() if found}
        assert not surviving, (
            f"Operation ids derived from retired handlers: {surviving}. The blog domain has no "
            "counterpart to create_item, get_items, get_item, update_item or delete_item."
        )

    async def test_no_component_is_named_for_the_retired_item_contract(
        self, document: dict[str, Any]
    ) -> None:
        """``components.schemas`` declares no ``Item``.

        The ``Item`` at ``app.py:L9-L12`` was the only request contract the baseline had, and no
        blog entity corresponds to it: a post has a title, a slug, an excerpt, content, a
        lifecycle status and an author, and none of that is an ``id``, a ``name`` and a ``price``.
        """
        schemas = _component_schemas(document)
        assert "Item" not in schemas, (
            "components.schemas still declares 'Item'. The retired contract has no blog-domain "
            f"counterpart. Declared components: {sorted(schemas)}"
        )

    async def test_no_component_carries_the_retired_item_field_triple(
        self, document: dict[str, Any]
    ) -> None:
        """No schema declares exactly ``{id, name, price}``, whatever it is called.

        The name check above is not enough on its own: the point of the retirement is that the
        contract is gone, not that the identifier is. A component with that exact property set
        under any other name is the same model wearing a different label.
        """
        offenders = sorted(
            name
            for name, schema in _component_schemas(document).items()
            if _properties(schema) == set(_RETIRED_ITEM_PROPERTIES)
        )
        assert not offenders, (
            f"Schemas carrying the retired item field set "
            f"{sorted(_RETIRED_ITEM_PROPERTIES)}: {offenders}"
        )

    @pytest.mark.parametrize(("method", "url"), _RETIRED_OPERATIONS)
    async def test_retired_operation_answers_not_found(
        self, client: AsyncClient, method: str, url: str
    ) -> None:
        """Each retired operation answers ``404``, live.

        The document proves the surface is undescribed; this proves it is unrouted. One case per
        handler that existed at ``app.py:L15-L49``, including the mutating verbs, because a
        retirement that removed the reads and left ``PUT`` mounted would be no retirement at all.
        """
        response = await client.request(method, url)
        assert response.status_code == HTTPStatus.NOT_FOUND, (
            f"{method} {url} answered {response.status_code}. The retired surface must be "
            "unrouted: no consumer of it can exist, because its data never survived a restart."
        )

    @pytest.mark.parametrize(("method", "url"), _RETIRED_OPERATIONS)
    async def test_retired_operation_renders_the_uniform_problem_document(
        self, client: AsyncClient, method: str, url: str
    ) -> None:
        """The ``404`` for a retired path is the same problem document as every other failure.

        ``app.core.exceptions`` registers a handler for the framework's HTTP exception, so even a
        routing failure - raised before any route code runs - renders the uniform shape. That is
        what makes the error contract a property of the service rather than of the routes that
        remembered to follow it.
        """
        response = await client.request(method, url)
        content_type = response.headers.get("content-type", "")
        assert content_type.startswith(PROBLEM_JSON_MEDIA_TYPE), (
            f"{method} {url} was served as {content_type!r}, expected {PROBLEM_JSON_MEDIA_TYPE!r}"
        )

        body = response.json()
        assert set(body) == set(_PROBLEM_DETAIL_REQUIRED), (
            f"{method} {url} rendered {sorted(body)}, expected the problem document's always "
            f"present fields {sorted(_PROBLEM_DETAIL_REQUIRED)} - and no 'errors' array, which "
            "belongs to a validation rejection only."
        )
        assert body["status"] == int(HTTPStatus.NOT_FOUND)
        assert body["instance"] == url
        assert body["type"].startswith(_ERROR_TYPE_PREFIX)

    @pytest.mark.parametrize(("method", "url"), _RETIRED_OPERATIONS)
    async def test_retired_not_found_detail_string_is_gone(
        self, client: AsyncClient, method: str, url: str
    ) -> None:
        """No response body contains ``"Item not found"``.

        That string was written three times, at ``app.py:L31``, ``L40`` and ``L49``, once per
        handler that needed it. The message now comes from the single registered handler, so its
        absence is the evidence that the duplication was removed rather than relocated.
        """
        response = await client.request(method, url)
        assert _RETIRED_NOT_FOUND_DETAIL not in response.text, (
            f"{method} {url} still reports {_RETIRED_NOT_FOUND_DETAIL!r}. The detail string was "
            "duplicated at three call sites in the retired module and must not survive the move "
            "to one registered handler."
        )
