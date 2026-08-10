"""Unit suite for the two declared surfaces nothing else in the gate set compares.

A "declared surface" here is a set the project states in one place and *relies on* somewhere else:
the configuration contract that ``.env.example`` publishes, and the export list
``app.services.__all__`` publishes. Both are ordinary Python objects, so both are trivially
readable - and neither was ever compared against the thing it claims to describe. What existed
instead was prose: comments and docstrings carrying a *number* of configuration keys and a *number*
of exported services.

Every one of those numbers had drifted. A count written into a comment is a second declaration of a
set that already exists in executable form, and the second declaration has no gate: it can only be
kept true by somebody remembering. Reviewing this repository found comments claiming fourteen
configuration keys against twelve settings fields plus three frontend keys, and a docstring example
asserting nine exported services against ten. Neither number was load-bearing; both were misleading
in exactly the way a stale comment is worst, because they read as authoritative.

So the numerals are gone from those files and the relationships are asserted here instead. There is
no count in this module either - each test compares two sets and reports the symmetric difference,
so adding a configuration key or a service needs no edit here, while adding one to *one* side of a
pair fails immediately and names what is missing.

Why these two live together
---------------------------
They are the same failure with different consequences, and neither belongs to any existing module's
subject. The API's operation inventory is already asserted as an equality against ``app.openapi()``
by ``backend/tests/integration/test_openapi_contract.py``, and the readiness vocabulary against
``ReadinessFailureClass`` by ``backend/tests/integration/test_health.py``; these are the remaining
two of the four surfaces, and both are import-time properties needing no database, no client and no
configuration beyond what ``conftest`` already bootstraps - hence a unit module.

What each failure would mean in production
------------------------------------------
An **undocumented configuration key** is a value the service reads that nobody deploying it knows
exists. It takes its default silently, which is the worst outcome for the two keys where a default
is a policy decision rather than a convenience - the request body ceiling and the authentication
rate limit.

An **undocumented key in the example file** is the mirror image and fails harder: ``Settings`` is
declared ``extra="forbid"``, so a key in an env file that the model neither declares nor tolerates
stops the process at start-up. A name added to ``.env.example`` without being added to the model
therefore turns a copied example file into a service that will not boot.

A **service missing from ``__all__``** is not a start-up failure, which is why it needs a test: the
package imports cleanly and the class is simply unreachable through the barrel every router imports
from, so the failure surfaces as an ``ImportError`` in whichever router is written next.

Governing standards
-------------------
``review_rules`` reports that this project specifies **no user rules**; this module is in scope
because AAP §0.9.1 places ``backend/tests/**/*.py`` there. Two self-imposed standards from
AAP §0.10.1 decide its shape: *configuration from the environment only* (#12), whose premise is that
``.env.example`` is the contract - a claim only an assertion can keep true; and *blocking quality
gates* (#8), which is why nothing here is skipped or conditional.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Final

import pytest

from app import services
from app.core.config import _FRONTEND_ENV_KEYS, Settings

pytestmark = pytest.mark.unit

REPO_ROOT: Final[Path] = Path(__file__).resolve().parents[3]
"""The repository root, resolved from this file so the suite runs from any working directory."""

ENV_EXAMPLE_PATH: Final[Path] = REPO_ROOT / ".env.example"
"""The committed configuration contract - the only environment file that is ever committed."""

SERVICES_DIR: Final[Path] = Path(services.__file__).parent
"""The service package's directory, walked to find modules the barrel might have forgotten."""

_ASSIGNMENT: Final[re.Pattern[str]] = re.compile(r"^(?P<key>[A-Z][A-Z0-9_]*)=")
"""Matches a variable assignment at the start of a line, which is the file's whole grammar.

Anchored, upper-case and comment-blind by construction: ``.env.example`` documents each key in a
comment block above it, and those comments name other keys freely - so a search that was not
anchored to a line's first character would count prose as a declaration.
"""


def _documented_keys() -> set[str]:
    """Return every key ``.env.example`` actually assigns a value to.

    Returns:
        The set of assigned names. Assignments only: a key named in a comment is documentation
        *about* the contract rather than part of it, and counting those is how a search-based check
        would report a key as documented when no deployment copying the file would receive it.
    """
    return {
        match.group("key")
        for line in ENV_EXAMPLE_PATH.read_text(encoding="utf-8").splitlines()
        if (match := _ASSIGNMENT.match(line)) is not None
    }


class TestConfigurationContract:
    """``.env.example`` and the settings model describe the same set of keys."""

    def test_the_example_file_documents_every_key_the_service_reads(self) -> None:
        """A key the service reads and the contract omits takes its default in silence."""
        recognised = set(Settings.model_fields) | set(_FRONTEND_ENV_KEYS)
        documented = _documented_keys()

        assert recognised - documented == set(), (
            ".env.example documents no value for "
            f"{sorted(recognised - documented)}, so a deployment copying it gets whatever default "
            "the source happens to carry without being told the setting exists"
        )

    def test_the_example_file_documents_nothing_the_service_would_refuse(self) -> None:
        """The mirror image, and it is a start-up failure rather than a silent default.

        ``Settings`` is declared ``extra="forbid"`` and tolerates exactly the frontend block by
        name, so a key present in an env file and unknown to the model stops the process. A name
        added to ``.env.example`` alone therefore turns a copied example into a service that will
        not boot - and the copy is the documented first step of running this project.
        """
        recognised = set(Settings.model_fields) | set(_FRONTEND_ENV_KEYS)
        documented = _documented_keys()

        assert documented - recognised == set(), (
            f".env.example assigns {sorted(documented - recognised)}, which app.core.config "
            "neither declares nor tolerates, so copying the file produces a start-up failure"
        )


class TestServiceExports:
    """``app.services.__all__`` resolves completely and leaves no service module behind."""

    def test_every_exported_name_resolves(self) -> None:
        """A name in ``__all__`` that does not resolve is an ``ImportError`` for the whole package.

        Not a lint finding: ``from app.services import X`` is how every router reaches this tier, so
        an unresolvable export breaks the application's import graph rather than one call site.
        """
        unresolved = [name for name in services.__all__ if not hasattr(services, name)]

        assert unresolved == [], f"app.services.__all__ names {unresolved}, which do not resolve"

    def test_no_service_module_is_missing_from_the_barrel(self) -> None:
        """Every ``*_service`` module contributes at least one name to the barrel.

        The failure this catches is quiet: the package still imports, the module still exists, and
        the class is simply unreachable through the barrel every router imports from - so it
        surfaces as an ``ImportError`` in whichever router is written next rather than here.

        Membership is checked per module rather than by name-mangling a module into a class name,
        because that mapping is a convention and this assertion should not encode a second copy of
        it: what matters is that *something* from each module is exported.
        """
        exported_modules = {
            getattr(services, name).__module__
            for name in services.__all__
            if hasattr(services, name)
        }
        module_files = {
            f"app.services.{path.stem}"
            for path in SERVICES_DIR.glob("*_service.py")
            if not path.stem.startswith("_")
        }

        assert module_files - exported_modules == set(), (
            f"{sorted(module_files - exported_modules)} export nothing through app.services, so "
            "the barrel every router imports from cannot reach them"
        )
