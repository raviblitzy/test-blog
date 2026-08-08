"""Package marker for ``app.api.v1``, the only version namespace of the REST API.

``router.py`` holds the aggregate ``api_router`` that ``app.main`` mounts at ``/api/v1``, and
``routers/`` holds the route modules behind it beside the ``health`` probes mounted unprefixed.
There is deliberately no ``v2``, so no version constant, negotiation scheme or compatibility
alias belongs here either.

Apart from this docstring the module is empty, and that is a correctness requirement.
Re-exporting the aggregate would close a cycle, since ``router.py`` reaches modules that sit
inside the very package whose ``__init__`` would still be mid-execution. It would also drag the
services, the models and the async engine behind ``app.db.session`` onto the import path of
``app.api.v1.routers.health``, whose ``GET /healthz`` has to answer without touching the database.
"""
