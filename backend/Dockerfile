# ==========================================================================================
# Production container image for the FastAPI service tier.
#
# Two stages. The first builds the dependency tree and stages the application payload; the
# second is the image that ships, and it receives only artifacts - never a compiler, never a
# package index cache, never a test, never a development tool. Agent Action Plan section
# 0.4.4.1 specifies a "Multi-stage image running the service under Gunicorn with Uvicorn
# workers" and section 0.7.1.2 adds "as a non-root user"; both are literal here.
#
# BUILD CONTEXT IS `backend/`, not the repository root:
#
#     docker build -t blog-api-backend backend/
#
# so every COPY source below is relative to backend/. That context is a property of this file
# alone and is stated here because it is not guessable from the outside: a build launched from
# the repository root fails on the first COPY. The plan schedules a `docker-compose.yml` for a
# later stage; no such file exists in the repository yet, so nothing here depends on one, and
# when it arrives it will need this same context, and the port, module path and probe path
# chosen below are the values it should publish and gate on.
#
# RUN IT with configuration supplied at run time and nothing baked in:
#
#     docker run --rm -p 8000:8000 --env-file .env blog-api-backend
#
# WHAT THIS IMAGE DELIBERATELY DOES NOT DO
#
#   * It does not apply migrations. Applying them belongs to whatever starts the service -
#     the plan gives that job to the `docker-compose.yml` it schedules for a later stage -
#     because putting `alembic upgrade head` in CMD here would run it again on every restart
#     and weld the image to one orchestration. The image's duty is to make the command
#     POSSIBLE - which is why alembic.ini and migrations/ are copied in and the venv's
#     `alembic` is on PATH - and to stop there. `docker run --rm --env-file .env
#     blog-api-backend alembic upgrade head` works today, and an orchestrator that overrides
#     `command:` will work the same way.
#   * It does not carry configuration. Not one of the eleven backend environment variables
#     has a default here, and no secret appears as ENV, as a build ARG, or in a comment: the
#     only ENV entries are non-secret interpreter and pip behaviour flags. No `.env` is ever
#     copied, and two independent things keep it that way: the root `.gitignore` excludes the
#     file so it cannot be committed in the first place, and no COPY below names it, so even a
#     local `backend/.env` - which a developer may create, commonly as a symlink to the root
#     one, and which would then point OUTSIDE this build context and be uncopyable anyway -
#     cannot reach the image. `.env.example` is the documented contract.
#   * It does not run as root. See the `blog` user below.
#
# WHY EVERY COPY IS NARROW AND EXPLICIT, AND WHY THERE IS NO `COPY . .`
#
# This plan contains no `.dockerignore`, by design, which moves the whole burden of exclusion
# onto the COPY lines. Most of the context must never reach an image, and it is not a rounding
# error: a developer's `.venv/` alone runs to hundreds of megabytes of host-built,
# interpreter-specific artifacts, beside `.mypy_cache/`, `.ruff_cache/`, `tests/`,
# `requirements-dev.txt`, the `.env` symlink, and `__pycache__/` directories inside `app/` and
# `migrations/`. Four narrow COPY statements name exactly what ships. The `__pycache__` trees
# are the one hazard a narrow COPY cannot dodge, because they live INSIDE the two directories
# that do ship, so the builder stage strips them and then asserts they are gone - see the
# payload staging step.
# ==========================================================================================


# ------------------------------------------------------------------------------------------
# Stage 1 - builder: resolve dependencies, stage the payload
# ------------------------------------------------------------------------------------------
#
# The tag is the EXACT patch version, matching backend/.python-version (3.14.7) and
# backend/pyproject.toml's `requires-python = "==3.14.7"`. `python:3`, `python:3.14` and
# `python:latest` are all forbidden, and the precision is load-bearing rather than tidy:
# backend/app/main.py relies on PEP 758 (unparenthesized `except A, B:`), which is a syntax
# error before 3.14, so a floating tag that drifted DOWN would not degrade this service - it
# would refuse to import at all.
FROM python:3.14.7-slim AS builder

# Interpreter and pip behaviour only - no application configuration lives in ENV anywhere in
# this file. PIP_NO_CACHE_DIR keeps the wheel cache out of the layer, and the version check is
# silenced rather than acted on: pip is deliberately NOT upgraded, because an unpinned install
# of anything - pip included - reintroduces exactly the drift the pinned requirement set exists
# to remove.
ENV PIP_NO_CACHE_DIR=1 \
  PIP_DISABLE_PIP_VERSION_CHECK=1 \
  PYTHONDONTWRITEBYTECODE=1

WORKDIR /build

# Dependency manifest first, alone, so this layer and the install below cache on the pin set
# and are not invalidated by an edit to application code.
COPY requirements.txt ./

# A virtual environment rather than a --prefix install: /opt/venv is one self-contained
# directory the runtime stage copies wholesale, and putting its bin/ on PATH there makes
# `gunicorn`, `uvicorn` and `alembic` directly invocable without a wrapper or an activate step.
#
# `--require-hashes` is passed explicitly. requirements.txt already forces hash-checking mode
# by carrying a --hash on every entry, but its own header asks for the flag "in any pipeline
# that wants the check to be mandatory rather than merely available", and a production image
# build is precisely that pipeline: with the flag, a requirement that ever loses its digests
# fails the build instead of quietly installing unverified bytes.
#
# ONLY requirements.txt is installed. requirements-dev.txt is neither copied nor installed, so
# pytest, ruff, mypy, httpx and Faker are absent from the shipped image by construction rather
# than by pruning. No package is installed by name here: the 19 direct pins and their 29
# pinned transitive dependencies are the complete, reproducible contents of this environment.
#
# No compiler is installed, and none is needed - verified, not assumed. The dependency set
# chose `psycopg[binary]` and `pwdlib[argon2]` specifically because they publish wheels, and
# this install resolves to wheels for all 48 distributions on linux/amd64, so build-essential
# would add a toolchain to a stage that has nothing to compile.
RUN python -m venv /opt/venv \
  && /opt/venv/bin/pip install --require-hashes --requirement requirements.txt

# ------------------------------------------------------------------------------------------
# Payload staging
#
# Assembled here rather than copied straight into the runtime stage so that the byte-code
# caches never exist in ANY layer of the shipped image. Deleting them in the runtime stage
# would hide them from `find` while leaving their bytes in the layer beneath; stripping them
# here means the runtime stage copies an already-clean tree.
#
# Four sources, each named on purpose:
#   app/          the service itself, entered at app.main:app
#   migrations/   Alembic's script_location, so `alembic upgrade head` is available
#   alembic.ini   Alembic's entry point: script_location=migrations, prepend_sys_path=.
#   gunicorn.conf.py  REQUIRED for a single-format log stream, not optional polish. Gunicorn's
#                 arbiter forks workers in a process that never imports app.main, so the
#                 import-time and lifespan calls to configure_logging cannot reach it and every
#                 arbiter line - boot, signals, shutdown - stays plain text in an otherwise JSON
#                 stream. Measured in this image's own invocation: 9 of 30 lines plain without
#                 this file, 0 of 30 with it. It publishes the logger_class that reconfigures
#                 logging inside the arbiter before its first line is written, and it is the ONLY
#                 place that selection is made - the CMD below deliberately passes no competing
#                 flag, because a command-line setting would outrank this file. The file itself
#                 documents why a logger class rather than an on_starting hook is the only
#                 placement that closes the window.
#   pyproject.toml  DELIBERATE, and the one inclusion that looks wrong at first glance. It is
#                 mostly tool configuration - ruff, mypy, pytest, coverage - which the
#                 container never reads. But backend/app/main.py resolves the service version
#                 from `[project] version` in this exact file whenever the distribution is not
#                 installed, and this image installs dependencies only, never the distribution
#                 itself. Verified both ways inside the built image: with the file present the
#                 served /openapi.json reports `info.version` 1.0.0, and with it masked the
#                 resolution falls through to the `0+unknown` marker and the API advertises no
#                 real version. One small tracked secret-free TOML file is a cheap price for
#                 correct OpenAPI metadata.
# ------------------------------------------------------------------------------------------
COPY app /payload/app
COPY migrations /payload/migrations
COPY alembic.ini /payload/alembic.ini
COPY gunicorn.conf.py /payload/gunicorn.conf.py
COPY pyproject.toml /payload/pyproject.toml

# Strip the host's byte-code caches, then ASSERT the strip worked. The test is not decoration:
# it converts "someone changed a COPY and a stale .pyc rode along" from a defect discovered in
# production into a failed build.
RUN find /payload -type d -name '__pycache__' -prune -exec rm -rf {} + \
  && find /payload -type f -name '*.py[co]' -delete \
  && test -z "$(find /payload -name '__pycache__' -o -name '*.py[co]')"


# ------------------------------------------------------------------------------------------
# Stage 2 - runtime: the image that ships
# ------------------------------------------------------------------------------------------
FROM python:3.14.7-slim

# Factual metadata only. Deliberately no version label: the version lives in exactly one place
# (pyproject.toml, read at run time) and a second copy here is a copy that drifts the first
# time only one of the two is bumped.
LABEL org.opencontainers.image.title="blog-api-backend" \
  org.opencontainers.image.description="FastAPI service tier of the blog platform, persisted in PostgreSQL" \
  org.opencontainers.image.base.name="docker.io/library/python:3.14.7-slim"

# PYTHONUNBUFFERED is an observability requirement, not a preference: the service logs through
# structlog to stdout, and without it those lines sit in a block buffer instead of reaching
# `docker logs` when they happen - which is the whole point of structured logging. Bytecode
# writing stays off because the code tree is intentionally read-only to the runtime user, so
# every attempted write would be a silently swallowed failure.
ENV PYTHONDONTWRITEBYTECODE=1 \
  PYTHONUNBUFFERED=1 \
  PATH="/opt/venv/bin:$PATH"

# Least privilege: a dedicated system account with fixed numeric IDs, no login shell, and no
# password. Fixed IDs rather than whatever the next `useradd` happens to allocate, so a mounted
# volume's ownership means the same thing on every host. --system keeps the account out of the
# human UID range; the home directory exists and is owned by the account so that anything
# expecting a resolvable HOME finds one, though nothing on the boot path needs to write there.
RUN groupadd --system --gid 10001 blog \
  && useradd --system --uid 10001 --gid blog --create-home --home-dir /home/blog \
    --shell /usr/sbin/nologin blog

# The dependency tree, and nothing else, from the builder. Left root-owned: the runtime user
# reads and executes these packages but must never be able to modify them.
COPY --from=builder /opt/venv /opt/venv

# NOT /app. With `COPY app ./app` that would produce the baffling /app/app and invite a
# "corrective" `COPY app .` that flattens the package and breaks the app.main:app module path
# outright. /srv/backend is neutral and mirrors the source layout: app/, migrations/ and
# alembic.ini sit side by side in one directory, which is the cwd, which is what lets both
# `gunicorn app.main:app` and `alembic upgrade head` resolve with no PYTHONPATH and no --chdir.
WORKDIR /srv/backend

# Owner root, group blog, modes carried over from the tracked sources (644 files, 755
# directories). Chowning to root rather than to `blog` is the point of the --chown, read for
# intent rather than for the letter: the runtime user reads and traverses the code tree through
# its group and cannot write to it, so a compromised request handler cannot rewrite the code
# that serves the next one. Owning the tree with the account that executes it would hand exactly
# that ability away for nothing.
COPY --from=builder --chown=root:blog /payload ./

# One port, used consistently by EXPOSE, by the health probe and by the bind address below, and
# it is the port the rest of the project already assumes: `.env.example` points the frontend at
# http://localhost:8000/api/v1. Operators remap it at run time - `-p`, or the port mapping of
# whatever orchestrates the container - rather than by rebuilding.
EXPOSE 8000

# Liveness, and `/healthz` rather than `/readyz` on purpose. `/healthz` answers 200 from the
# process alone and touches no database; `/readyz` answers only when a trivial query succeeds.
# A container health check drives restart policy, so pointing it at readiness would have an
# orchestrator kill a perfectly healthy service every time PostgreSQL blinked. Readiness gating
# - deciding whether to send traffic - is the orchestrator's call against `/readyz`.
#
# Probed with the interpreter because this base image ships NEITHER curl NOR wget (verified),
# and a HEALTHCHECK that shells out to a binary that does not exist reports `unhealthy` forever
# while the service is fine. urlopen raises on any non-2xx or on a connection failure, so the
# explicit 200 comparison is the only case that exits 0. Exec form, so no shell is involved -
# which also means no variable expansion, hence the literal port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4).status == 200 else 1)"]

# Everything above this line runs as root because it must - installing packages, creating an
# account, writing into /srv. Nothing below it does.
USER blog

# Gunicorn supervising Uvicorn workers, exec form so gunicorn is PID 1 and receives Docker's
# SIGTERM directly instead of through a shell that would swallow it.
#
# `app.main:app`, never `main:app`. README.md documents `uvicorn main:app --reload` and no
# `main` module has ever existed - the plan classifies that as the repository's one
# non-functional feature. The repository-root app.py shim is equally unusable here: it resolves
# the backend package only when the process working directory is the repository root, which is
# never true inside this image.
#
# WORKER CLASS - checked against the pinned uvicorn rather than assumed. Uvicorn split its
# Gunicorn worker out into the separate `uvicorn-worker` distribution during the 0.30 series,
# so the conventional spelling is not automatically correct any more. Probed on the pinned
# uvicorn[standard]==0.52.1: `import uvicorn.workers` SUCCEEDS and exposes UvicornWorker, so the
# classic path is used and no dependency is added. It does emit a DeprecationWarning naming
# `uvicorn-worker` as the successor (invisible under Python's default warning filters). If a
# future uvicorn bump removes the module, the fix is to add that distribution as an exact `==`
# pin to requirements.txt AND to pyproject.toml's dependencies array, keeping the two in
# parity, and switch to `uvicorn_worker.UvicornWorker` - not to abandon Gunicorn.
#
# Two workers, a literal rather than a count derived from the host: a container sees the host's
# CPUs regardless of the quota it is actually allowed, so deriving from them over-subscribes.
# Multiple workers are correct here only because the system of record moved into PostgreSQL -
# the retired in-memory design gave each worker a private list and answered identical requests
# differently. Tune without rebuilding via gunicorn's own GUNICORN_CMD_ARGS, or by overriding
# the container's command from whatever starts it.
#
# Two is the SHIPPED DEFAULT; the supported maximum is app.db.session.MAX_WORKERS_PER_REPLICA,
# which is 4. That module's connection budget is sized against the maximum rather than against
# this default, so raising the count to four needs no code change and no re-derivation - the
# import-time assertion in that module is what fails if anyone goes past it.
#
# --no-control-socket because gunicorn 26 otherwise opens a control socket under $HOME on every
# boot. The `blog` account below does have a writable home, so the default would work as
# shipped - but the moment anyone runs this image with `--user 65534:65534` or under a read-only
# root filesystem, both routine hardening moves, it logs `Control server error: [Errno 13]
# Permission denied` at ERROR for a service that is in fact perfectly healthy. That was observed
# in a probe and removed by this flag, and a permanent false ERROR is an observability defect,
# not a cosmetic one. Declining a control channel nothing here uses costs the deployment
# nothing; an operator who wants it passes `--control-socket <writable path>` through
# GUNICORN_CMD_ARGS.
#
# --worker-tmp-dir /dev/shm is the OTHER half of accommodating a read-only root filesystem, and
# it was missing: gunicorn's arbiter gives each worker a heartbeat file, created with
# `tempfile.mkstemp` in this directory, and the arbiter touches it to decide whether that worker
# is alive. With the default of `/tmp` and `--read-only`, the container did not degrade - it
# never started: `FileNotFoundError: No usable temporary directory found in ['/tmp', '/var/tmp',
# '/usr/tmp', '/srv/backend']` from `gunicorn/workers/workertmp.py`, exit 255, HEALTHCHECK
# unhealthy, every endpoint unreachable. So the flag above declined a channel nothing needs while
# the container still could not boot the way its own comment said it accommodated.
#
# /dev/shm rather than documenting `--tmpfs /tmp` for the operator, and the difference is who has
# to know: Docker mounts /dev/shm as a read-write tmpfs even under --read-only, so this flag makes
# the image boot hardened with no extra run argument at all, whereas the documented-flag route
# fails closed the first time somebody adds `read_only: true` without reading the note. It is also
# the placement gunicorn's own documentation recommends for containers, because a heartbeat file
# on a disk-backed /tmp is a write per worker per second against the container filesystem.
#
# One caveat, recorded rather than defended: `docker run --ipc=none` removes /dev/shm entirely, and
# under that flag this path does not exist. Nothing in this project's documented deployment uses
# it, and an operator who does needs `--worker-tmp-dir` pointed somewhere writable through
# GUNICORN_CMD_ARGS - the same override that tunes every other setting on this command line.
#
# Both logs go to `-`, which gunicorn maps to stdout for access lines and stderr for error
# lines, so the container log stream is the only place logs live - no files, no rotation, no
# writable volume required.
#
# The ARBITER'S own log lines are structured by `logger_class`, and that setting is made in
# gunicorn.conf.py rather than here. It is a correctness requirement of this image rather than a
# preference: the arbiter - the process this CMD starts - binds the socket, forks the workers and
# handles signals WITHOUT ever importing app.main, so the `configure_logging()` call on the
# application's import path cannot reach it. Measured before the hook existed: 9 plain-text lines
# per container lifecycle, every one from the arbiter (`Starting gunicorn`, `Listening at:`,
# `Using worker:`, two `Booting worker with pid:`, `Handling signal: term`, two
# `Worker … was sent SIGTERM!`, `Shutting down: Master`), while every worker-side line including
# all request records was already JSON. A JSON-only collector treats each of those as unparsed, so
# the boot and shutdown of every container is exactly the window an operator cannot query.
# `app.core.logging.StructlogGunicornLogger`, which gunicorn.conf.py publishes as `logger_class`,
# closes it - measured after: 0 plain-text lines.
#
# There is deliberately NO `--logger-class` flag here, and its absence is the fix rather than an
# omission. This CMD used to pass one naming that same class while gunicorn.conf.py assigned a
# second, identical implementation of its own; a command-line setting outranks a configuration
# file, so the config-file class was never constructed in the shipped image even though it had
# tests that appeared to cover the container's behaviour. One hook needs one selection point, and
# --config below is it.
#
# `gunicorn.access` is silenced by the same `configure_logging()` call, so `--access-logfile -`
# above remains correct and inert: app.middleware.request_context is the single owner of the
# access record, and the flag is kept so that nothing falls back to gunicorn's default access sink
# if that ever changes.
#
# --config names ./gunicorn.conf.py explicitly even though gunicorn would discover that exact
# path in the working directory by itself. The redundancy carries real weight now that the file is
# the only place `logger_class` is set: an explicit --config that names a missing file is a hard
# startup error, whereas discovery of a missing file is silent and the only symptom is a log
# stream that quietly goes back to being half plain text. A COPY dropped from the payload above
# should break the container, not degrade its observability.
CMD ["gunicorn", "app.main:app", \
  "--config", "gunicorn.conf.py", \
  "--worker-class", "uvicorn.workers.UvicornWorker", \
  "--workers", "2", \
  "--bind", "0.0.0.0:8000", \
  "--no-control-socket", \
  "--worker-tmp-dir", "/dev/shm", \
  "--access-logfile", "-", \
  "--error-logfile", "-"]
