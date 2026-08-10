"""Deprecated shim that keeps the historical ``uvicorn app:app`` invocation resolving.

It holds no application code. It only re-exports the object the factory in
``backend/app/main.py`` builds, so addressing the application as ``app:app`` from the
repository root - the invocation this project used to document - still resolves rather
than breaking. Prefer the canonical entry point, which does not involve this file at
all: ``uvicorn app.main:app --reload`` from inside ``backend/``.

Which artifacts agree with that today, stated as it actually stands rather than as it
will: ``backend/Dockerfile`` is the only other file in the repository that names an entry
point, and it serves ``app.main:app``, so the module path above is the one the image
already runs. ``README.md`` has not been rewritten yet and still documents
``uvicorn main:app --reload`` against a ``main`` module that has never existed - the one
defect the plan classifies as leaving a feature non-functional. A ``Makefile`` and a
``docker-compose.yml`` are scheduled for a later stage of the plan and do not exist; when
they land they are to name this same canonical path, which is why it is stated here once.

Known limitation: ``import app`` reaches this shim only while the repository root is on
``sys.path`` - in practice only when the process working directory is the repository
root, where Uvicorn's ``--app-dir`` default puts it. From anywhere else the name
resolves elsewhere, or not at all, and no code here can intervene. Once this module
does run, it locates the backend package from ``__file__``, never from the directory.

The legacy ``/items`` surface is retired and is not returning: its five handlers, its
``Item`` model and the module-level list they mutated gave way to the versioned blog
API under ``/api/v1`` over PostgreSQL, so those paths now answer ``404`` and appear
nowhere in the generated OpenAPI document.
"""

import importlib.util
import sys
import warnings
from pathlib import Path

_PACKAGE_DIR = Path(__file__).resolve().parent / "backend" / "app"
_CANONICAL = "uvicorn app.main:app --reload"

warnings.warn(
    f"The repository-root `app` module is deprecated; run `{_CANONICAL}` from inside "
    "`backend/` instead.",
    DeprecationWarning,
    stacklevel=2,
)

# `backend/` joins sys.path so `app.<anything>` resolves as it does under the canonical
# invocation; guarded, because a repeat import must not grow the path.
if str(_PACKAGE_DIR.parent) not in sys.path:
    sys.path.insert(0, str(_PACKAGE_DIR.parent))

try:
    # This file is imported as `app` itself, so `sys.modules["app"]` holds a plain
    # module and `from app.main import ...` fails with "'app' is not a package". Bind
    # the real package to that name first, located by path - resolving `app` by name
    # would find, and re-execute, this shim, recursing until the interpreter gives up.
    _spec = importlib.util.spec_from_file_location(
        "app",
        _PACKAGE_DIR / "__init__.py",
        submodule_search_locations=[str(_PACKAGE_DIR)],
    )
    if _spec is None or _spec.loader is None:
        raise ImportError(f"no importable package at {_PACKAGE_DIR}")
    _package = importlib.util.module_from_spec(_spec)
    sys.modules["app"] = _package
    _spec.loader.exec_module(_package)
    app = importlib.import_module("app.main").app
except (ImportError, OSError) as exc:
    raise RuntimeError(
        "The repository-root `app` module is a deprecated shim and could not load the "
        f"backend application package from {_PACKAGE_DIR}. It resolves only from the "
        f"repository root, with the backend dependencies installed - use `{_CANONICAL}`"
        " from inside `backend/` instead."
    ) from exc

# `sys.modules["app"]` is the backend package now, and its `__init__.py` declares no
# `app` attribute, so Uvicorn's `getattr(import_module("app"), "app")` step would fail
# even though every import above succeeded. Re-attach to whatever holds the name.
_holder = sys.modules.get("app", _package)
_holder.__dict__.setdefault("app", app)

__all__ = ["app"]
