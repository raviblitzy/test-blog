"""Unit suite for the response class the whole API serialises through.

``app.core.responses.ORJSONResponse`` is the project's own class, and this module exists
because the *reason* it is the project's own is not visible in its four lines of code. FastAPI
0.141.1 deprecates ``fastapi.responses.ORJSONResponse``; while the backend named that class,
every response construction emitted a ``FastAPIDeprecationWarning`` - 1,106 identical lines in
a single suite run, and four records in a live process emitted at ``level="warning"`` with a
``request_id`` attached. AAP §0.5.2 nonetheless requires ``orjson`` to be "used as the default
response class", so the resolution was to own the class rather than to drop orjson or to
silence the warning.

Both halves of that resolution can regress silently, which is why they are asserted here.

* **The bytes could change.** The swap was safe only because the render is the same render -
  ``orjson.dumps`` under the same option mask. A future edit that dropped
  ``OPT_NON_STR_KEYS``, or reached for ``json.dumps``, would keep every existing test green
  and change what the wire carries. So the render is asserted directly, against the value
  categories this domain actually emits: ``UUID`` and ``datetime`` identity and audit columns,
  ``Enum`` lifecycle states, and the non-string mapping keys the flag exists for.
* **The import could come back.** Nothing stops a later edit from writing
  ``from fastapi.responses import ORJSONResponse`` again, and nothing would fail if it did -
  the suite would simply be noisy again, which is how the finding arose in the first place. So
  the absence of that import across ``backend/app`` is asserted as a property of the tree, and
  the warning-free construction is asserted by promoting warnings to errors for the duration of
  one call.

The subject is a pure serialisation class: it reads no environment variable, opens no
connection and holds no state, so this is a ``unit`` module - it needs neither the database nor
the ASGI client.

Governing standards
-------------------
``review_rules`` reports that this project specifies **no user rules**; this module is in scope
because AAP §0.9.1 places ``backend/tests/**/*.py`` there. Two self-imposed standards from
AAP §0.10.1 shape it: *explicit API contracts* (#4), because the media type this class
advertises is what FastAPI writes into every operation's ``content`` block in the served
document; and *blocking quality gates* (#8), which is why the warning assertion is an assertion
rather than a comment - a warning channel nobody can read is not a gate.
"""

from __future__ import annotations

import ast
import uuid
import warnings
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Final

import orjson
import pytest
from fastapi.exceptions import FastAPIDeprecationWarning
from fastapi.responses import ORJSONResponse as DeprecatedFastAPIResponse
from starlette.responses import JSONResponse

from app.core.responses import ORJSON_OPTIONS, ORJSONResponse

pytestmark = pytest.mark.unit


APP_PACKAGE_DIR: Final[Path] = Path(__file__).resolve().parents[2] / "app"
"""The backend application package, walked module by module by the import assertions."""

_DEPRECATED_MODULE: Final[str] = "fastapi.responses"
"""The module the deprecated class lives in, named once so both assertions read the same."""

_DEPRECATED_NAME: Final[str] = "ORJSONResponse"
"""The class name that must not be imported from :data:`_DEPRECATED_MODULE` anywhere in ``app``."""


def _application_modules() -> list[Path]:
    """Every Python module under ``backend/app``, sorted for a deterministic failure order.

    Returns:
        The module paths. Sorted so that a failure names the same first offender on every
        machine, which matters when more than one module regresses at once.
    """
    return sorted(APP_PACKAGE_DIR.rglob("*.py"))


def _imports_deprecated_response(source: str) -> bool:
    """Report whether *source* imports the deprecated response class.

    Parsed rather than grepped. A textual search would match this very test module, a
    docstring that discusses the class - several backend modules do - or a comment explaining
    why it is not used, and a gate that fires on prose is a gate somebody switches off. The
    AST sees only real import statements.

    Both spellings are recognised: ``from fastapi.responses import ORJSONResponse`` and
    ``import fastapi.responses`` followed by attribute access. The second is caught by treating
    any import of the module itself as a hit, which is deliberately over-broad - no module in
    ``app`` has a legitimate reason to import ``fastapi.responses`` at all, because every
    response class the backend uses is either Starlette's or this project's.

    Args:
        source: The module's full text.

    Returns:
        ``True`` when an import of the deprecated class or its module is present.
    """
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == _DEPRECATED_MODULE:
            return True
        if isinstance(node, ast.Import) and any(
            alias.name == _DEPRECATED_MODULE for alias in node.names
        ):
            return True
    return False


class _Lifecycle(Enum):
    """A stand-in for the domain's ``str``-valued lifecycle enums, local to this module."""

    PUBLISHED = "PUBLISHED"


class TestRenderFidelity:
    """The bytes this class puts on the wire, asserted value category by value category."""

    def test_renders_bytes_not_str(self) -> None:
        """``orjson`` emits bytes with no intermediate string, which is why it is pinned."""
        rendered = ORJSONResponse({}).render({"ok": True})

        assert isinstance(rendered, bytes)
        assert rendered == b'{"ok":true}'

    def test_renders_identically_to_the_option_mask_it_declares(self) -> None:
        """The render is ``orjson.dumps`` under :data:`ORJSON_OPTIONS` and nothing else.

        Asserted against ``orjson`` directly rather than against a literal, so the property
        survives an ``orjson`` upgrade that changes formatting while still failing the moment
        the class starts serialising through something else.
        """
        body = {
            "id": uuid.UUID("11111111-2222-3333-4444-555555555555"),
            "published_at": datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC),
            "status": _Lifecycle.PUBLISHED,
            "view_count": 137,
            "excerpt": None,
        }

        assert ORJSONResponse({}).render(body) == orjson.dumps(body, option=ORJSON_OPTIONS)

    def test_serialises_the_domain_value_types_natively(self) -> None:
        """A ``UUID``, a timezone-aware ``datetime`` and a ``str`` enum need no encoder hook.

        This is the concrete reason the dependency exists: identity is a server-generated UUID
        and every audit column is ``timestamptz``, so a serialiser that could not render either
        would need a custom default for every response in the API.
        """
        body = {
            "id": uuid.UUID("11111111-2222-3333-4444-555555555555"),
            "published_at": datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC),
            "status": _Lifecycle.PUBLISHED,
        }

        decoded = orjson.loads(ORJSONResponse({}).render(body))

        assert decoded == {
            "id": "11111111-2222-3333-4444-555555555555",
            "published_at": "2026-01-02T03:04:05+00:00",
            "status": "PUBLISHED",
        }

    def test_serialises_non_string_mapping_keys(self) -> None:
        """``OPT_NON_STR_KEYS`` is load-bearing, so its effect is asserted rather than assumed.

        Without the flag this render raises ``TypeError`` and the response becomes a 500 with
        no useful message. A handler returning a plain dict - which is exactly how
        ``app.core.exceptions`` builds a problem document - is not reduced to primitives by
        FastAPI's field serialisation, so nothing else would catch the omission.
        """
        identifier = uuid.UUID("11111111-2222-3333-4444-555555555555")

        decoded = orjson.loads(ORJSONResponse({}).render({identifier: 1, 2: "two"}))

        assert decoded == {"11111111-2222-3333-4444-555555555555": 1, "2": "two"}

    def test_option_mask_carries_the_two_flags_it_documents(self) -> None:
        """The mask is the mask the retired class used - the basis for the swap being safe."""
        assert ORJSON_OPTIONS == orjson.OPT_NON_STR_KEYS | orjson.OPT_SERIALIZE_NUMPY


class TestResponseContract:
    """What the class advertises to FastAPI, Starlette and the generated document."""

    def test_is_a_starlette_json_response(self) -> None:
        """Subclassing Starlette's class is what keeps every response behaviour inherited."""
        assert issubclass(ORJSONResponse, JSONResponse)

    def test_is_not_the_deprecated_framework_class(self) -> None:
        """The whole point of the module: this class is the project's, not the framework's.

        Expressed through the qualified name and the MRO rather than with ``is``. An identity
        comparison would be the obvious spelling and is rejected by the gate: ``mypy`` reports
        it as a non-overlapping identity check, because it can already prove the two are
        distinct types - which is the property this test wants, established statically. What
        cannot be established statically is that the class is not a *subclass* of the
        deprecated one - a subclass would inherit the deprecated render while passing an
        ``is not`` check, and its own construction would be silent, so both assertions below
        are needed to make the silence in :class:`TestNoDeprecationWarning` mean something.
        """
        assert not issubclass(ORJSONResponse, DeprecatedFastAPIResponse)
        assert DeprecatedFastAPIResponse not in ORJSONResponse.__mro__
        assert ORJSONResponse.__module__ == "app.core.responses"
        assert ORJSONResponse.__qualname__ == "ORJSONResponse"

    def test_advertises_the_json_media_type(self) -> None:
        """FastAPI keys each operation's ``content`` block on ``response_class.media_type``.

        Inherited rather than redeclared, and asserted here because a change to it would move
        every operation in the served document to a different content key - a contract change
        that no route-level test would notice.
        """
        assert ORJSONResponse.media_type == "application/json"

    def test_honours_a_per_response_media_type_override(self) -> None:
        """``app.core.exceptions`` emits ``application/problem+json`` through this class.

        One serialiser, two media types: the error contract's media type is passed per
        response, so the problem document is rendered by the same code as every success body.
        """
        response = ORJSONResponse(
            content={"type": "/errors/not-found"},
            status_code=404,
            media_type="application/problem+json",
        )

        assert response.headers["content-type"] == "application/problem+json"
        assert response.status_code == 404
        assert response.body == b'{"type":"/errors/not-found"}'


class TestNoDeprecationWarning:
    """The finding this module closes: constructing a response must warn about nothing."""

    def test_construction_emits_no_warning_at_all(self) -> None:
        """Promoted to an error for the duration, so any warning fails rather than prints.

        ``simplefilter("error")`` rather than a filter naming ``FastAPIDeprecationWarning``:
        the property worth holding is that this construction is silent, whatever the source of
        a future warning - a ``DeprecationWarning`` from ``orjson``, a ``ResourceWarning``, or
        the same FastAPI notice arriving by another route.
        """
        with warnings.catch_warnings():
            warnings.simplefilter("error")

            response = ORJSONResponse({"ok": True})

        assert response.body == b'{"ok":true}'

    def test_the_deprecated_class_still_warns(self) -> None:
        """The control. Without it, the assertion above could pass for the wrong reason.

        If a future FastAPI stopped deprecating its class - or if the warning category were
        renamed - the silence above would prove nothing, so the mechanism is pinned here. This
        is the only place in the suite that constructs the deprecated class, and it does so to
        demonstrate exactly what the backend no longer does.
        """
        with pytest.warns(FastAPIDeprecationWarning, match="ORJSONResponse is deprecated"):
            DeprecatedFastAPIResponse({"ok": True})


class TestApplicationTreeDoesNotImportTheDeprecatedClass:
    """A property of the tree, not of one module, because the import could return anywhere."""

    def test_no_application_module_imports_fastapi_responses(self) -> None:
        """Every module under ``backend/app`` is parsed; the failure names the offenders.

        Reported as a whole list rather than one at a time, so a reintroduction across several
        modules is fixed in one pass.
        """
        offenders = [
            module.relative_to(APP_PACKAGE_DIR).as_posix()
            for module in _application_modules()
            if _imports_deprecated_response(module.read_text(encoding="utf-8"))
        ]

        assert offenders == [], (
            f"{_DEPRECATED_MODULE}.{_DEPRECATED_NAME} is deprecated in the pinned FastAPI and "
            f"its construction emits a FastAPIDeprecationWarning on every response. Import "
            f"app.core.responses.ORJSONResponse instead. Offending modules: {offenders}"
        )

    def test_the_sweep_can_actually_see_an_import(self) -> None:
        """The negative control for the sweep, so a broken detector cannot report success."""
        assert _imports_deprecated_response(
            f"from {_DEPRECATED_MODULE} import {_DEPRECATED_NAME}\n"
        )
        assert _imports_deprecated_response(f"import {_DEPRECATED_MODULE}\n")
        assert not _imports_deprecated_response("from app.core.responses import ORJSONResponse\n")

    def test_the_sweep_reads_a_non_empty_tree(self) -> None:
        """Guards the assertion above against an empty walk trivially passing."""
        modules = _application_modules()

        assert len(modules) > 50
        assert APP_PACKAGE_DIR / "main.py" in modules
        assert APP_PACKAGE_DIR / "core" / "exceptions.py" in modules
