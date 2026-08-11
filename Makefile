# ==========================================================================================
# Makefile - the developer entry points for the blog platform.
#
# EIGHT DOCUMENTED TARGETS, and they are a contract: these are the names README.md documents
# and .github/workflows/ci.yml mirrors as its gate set, so none of them is ever renamed, merged
# or split. (Both of those files are scheduled for a later stage of the plan and are not in the
# tree yet; when they land they name these eight and no others.)
#
#   install   every pinned dependency, both tiers   test       every suite, coverage floor included
#   migrate   the schema to head                    lint       ruff + eslint, zero warnings
#   seed      reference data, admin, demo posts     typecheck  mypy + tsc
#   dev       the whole stack under Compose         build      web bundle + container images
#
# Everything else here is a helper: either a tier-scoped half of one of those eight, or a
# convenience. `make help` lists the two groups separately so the contract stays legible.
# Four helpers are named by other tracked files and therefore cannot be renamed either:
# `migration` and `downgrade` (backend/alembic.ini), and `format` (frontend/eslint.config.mjs);
# `test` itself is named by frontend/vitest.setup.ts.
#
# RUNTIMES are pinned in their own files and are deliberately not restated as values here:
# Python 3.14.7 (backend/.python-version), Node.js 24.19.0 (frontend/.nvmrc) and
# PostgreSQL 18.4 (docker-compose.yml).
#
# EVERY TARGET IS NON-INTERACTIVE. Nothing prompts, nothing reads standard input and nothing
# enters a watch mode: the component tests run with `--run`, the frontend installs with
# `npm ci`, and the browser download never invokes a privileged package manager. The only
# targets that do not terminate on their own are the three servers - `dev`, `dev-backend` and
# `dev-frontend` - which run until Ctrl-C, as a development server should.
#
# THE GATES BLOCK. No recipe line carries make's `-` prefix, chained commands are joined with
# `&&` rather than `;`, and .SHELLFLAGS turns on errexit, nounset and pipefail - so the first
# failure inside a recipe stops the target and make exits non-zero. A `make lint` that exited 0
# while eslint had failed would defeat the only reason to have it.
#
# CONFIGURATION COMES ONLY FROM THE ENVIRONMENT. No secret, connection string, port or origin
# appears below. Targets that run project code source the repository-root .env when it is
# present ($(LOAD_ENV)) and are correct without it, so no target here requires that file to
# exist - `make help` needs no environment at all; the Compose targets pass nothing and let
# Compose read the same file itself. A parallel checkout overrides COMPOSE_PROJECT_NAME and the
# three *_HOST_PORT variables IN THE SHELL, exactly as docker-compose.yml documents - never in
# this file and never in .env, which the backend settings model reads with `extra="forbid"`.
#
# CONVENTIONS THIS FILE KEEPS
#   * Backend tools run from inside backend/ and are invoked by absolute path out of the
#     virtual environment, which is never activated and is never put on PATH. Both halves are
#     load-bearing: backend/ is where pyproject.toml and alembic.ini are found - from the
#     repository root, mypy and coverage silently miss their configuration and Alembic cannot
#     find migrations/ at all - and alembic.ini's post-write hooks use its `module` runner
#     precisely because .venv/bin is absent from PATH here.
#   * The API is addressed as `app.main:app` from inside backend/, and nowhere in this file
#     does that string appear without its `app.` prefix. The repository-root app.py is a
#     deprecated shim that no target uses, and the launch defect this project corrects - a
#     uvicorn target naming a `main` module that has never existed - is not reproduced here.
#   * ruff is the one exception that runs from the repository root with `backend` as its
#     argument: it resolves configuration per file on the way up, so it needs no cd.
#
# RECIPE LINES BEGIN WITH A HARD TAB. GNU make accepts nothing else - a space-indented recipe
# aborts the whole file with "missing separator" - and .editorconfig pins indent_style = tab
# for this file to stop an editor from converting them.
# ==========================================================================================

# bash rather than /bin/sh: pipefail is a bashism and the gates depend on it. errexit and
# nounset are on for every recipe, so an unset variable or a failed command stops the target
# instead of being carried past.
SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

# A recipe that fails leaves no half-written target behind.
.DELETE_ON_ERROR:

# Sequential, always. These targets share host-global resources - one database, one set of
# ports, one Compose project - so `make -j` would have two suites racing for the same port and
# the same schema. Ordering the gates also means the cheapest failure is reported first.
.NOTPARALLEL:

# A bare `make` prints help rather than silently running whichever target happens to be first.
.DEFAULT_GOAL := help

# Catch a mistyped variable name instead of expanding it to nothing. `m` is declared empty
# below because `make migration` is allowed to be called without it - and is then told so.
MAKEFLAGS += --warn-undefined-variables

# ------------------------------------------------------------------------------------------
# Paths and commands. Simple expansion throughout; a command-line assignment such as
# `make dev-backend DEV_API_PORT=8100` still overrides any of them.
# ------------------------------------------------------------------------------------------
BACKEND_DIR  := backend
FRONTEND_DIR := frontend

# The interpreter used to CREATE the virtual environment; backend/.python-version pins which
# one that must be.
PYTHON       := python3.14
VENV_DIR     := $(CURDIR)/$(BACKEND_DIR)/.venv
VENV_BIN     := $(VENV_DIR)/bin
PY           := $(VENV_BIN)/python
ALEMBIC      := $(VENV_BIN)/alembic
RUFF         := $(VENV_BIN)/ruff
MYPY         := $(VENV_BIN)/mypy

NPM          := npm
# Local binaries by path, never through a package runner: `npx` and `npm exec` offer to
# install a missing package, and that offer is a prompt.
PRETTIER     := ./node_modules/.bin/prettier
PLAYWRIGHT   := ./node_modules/.bin/playwright

# The plugin form, which is the one docker-compose.yml's own instructions use. The legacy
# `docker-compose` script is not used anywhere in this project.
COMPOSE      := docker compose

# The backend coverage floor. One number, stated once, and blocking.
COVERAGE_MIN := 80

# The only browser the three Playwright viewport projects drive.
E2E_BROWSER  := chromium

# Where `make dev-backend` binds. Loopback by default; these are make variables, so they are
# overridden on the command line - `make dev-backend DEV_API_HOST=0.0.0.0` - and not by exporting
# a shell variable, which a `:=` assignment here outranks.
DEV_API_HOST := 127.0.0.1
DEV_API_PORT := 8000

# Message for `make migration`, empty unless supplied: make migration m="add a table"
m :=

# The environment contract. .env is git-ignored and may not exist; .env.example documents it
# and names this exact loading form as one the format supports. Sourced rather than exported
# key by key, so nothing here has to know which keys exist - which is also what keeps this
# file free of configuration.
#
# Precedence, stated because it is worth knowing: the file is sourced after the recipe has
# inherited the shell environment, so where .env sets a key, .env wins for these targets -
# change the value there. Where there is no .env, as in continuous integration, this expands to
# nothing and the environment is the only source. The Compose targets never reach this at all:
# Compose reads the same file itself, with the shell taking precedence, which is why the
# parallel-checkout overrides belong in the shell.
ENV_FILE := $(CURDIR)/.env
LOAD_ENV := if [ -f '$(ENV_FILE)' ]; then set -a; . '$(ENV_FILE)'; set +a; fi

.PHONY: help \
        install install-backend install-frontend install-browsers install-browser-deps venv \
        migrate migration downgrade migrate-check migrate-reversibility \
        seed \
        dev dev-backend dev-frontend \
        test test-backend test-frontend e2e \
        lint lint-backend lint-frontend format \
        typecheck typecheck-backend typecheck-frontend \
        build build-frontend build-images verify-clean \
        check db-up db-wait db-down clean \
        _require-venv _require-node-modules

help: #> Print this message (the default goal)
	@printf '\nusage: make <target>\n\nThe eight documented targets:\n\n'
	@awk 'BEGIN { FS = ":[^#]*## " } /^[a-zA-Z][a-zA-Z0-9_-]*:[^#]*## / { printf "  %-22s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@printf '\nHelpers (not part of the documented contract):\n\n'
	@awk 'BEGIN { FS = ":[^#]*#> " } /^[a-zA-Z][a-zA-Z0-9_-]*:[^#]*#> / { printf "  %-22s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@printf '\nfirst run:  make install && make db-up && make migrate && make seed\n'
	@printf 'gates:      make lint && make typecheck && make test && make build\n\n'

# ------------------------------------------------------------------------------------------
# Guards. A fresh clone that skips `make install` gets an instruction rather than a
# "No such file or directory" from whichever binary the target reached for first.
# ------------------------------------------------------------------------------------------
_require-venv:
	@test -x '$(PY)' || { \
		echo 'backend/.venv is absent or incomplete - run: make install' >&2; \
		exit 1; \
	}

_require-node-modules:
	@test -d '$(FRONTEND_DIR)/node_modules' || { \
		echo 'frontend/node_modules is absent - run: make install' >&2; \
		exit 1; \
	}

# ------------------------------------------------------------------------------------------
# 1. install - every dependency, and only from the pinned manifests.
# ------------------------------------------------------------------------------------------
install: install-backend install-frontend install-browsers ## Install every pinned dependency for both tiers

venv: #> Create backend/.venv with the pinned interpreter if it is not there already
	test -d '$(VENV_DIR)' || $(PYTHON) -m venv '$(VENV_DIR)'

# Both manifests are named explicitly even though requirements-dev.txt already chains
# `-r requirements.txt`: the runtime set is what production installs, and this target should
# say so rather than depend on one file's include. Both are fully hash-pinned, and
# --require-hashes makes that a requirement rather than a happy accident - a future edit that
# drops a hash fails here instead of resolving something new. Nothing is resolved at install
# time and no version is named in this file.
install-backend: venv #> Install the backend runtime + development pins into backend/.venv
	cd $(BACKEND_DIR) && '$(PY)' -m pip install --no-input --require-hashes \
		-r requirements.txt -r requirements-dev.txt

# `ci`, never `install`: it installs exactly what package-lock.json resolves, and fails when
# the lockfile and the manifest disagree - which is the entire reason the lockfile is tracked.
install-frontend: #> Install the frontend pins from package-lock.json (npm ci)
	cd $(FRONTEND_DIR) && $(NPM) ci --no-audit --no-fund

# The browser binary only. `playwright install --with-deps` also installs system packages, and
# anywhere it is not already root that step escalates and can prompt for a password, which no
# target here is allowed to do - see install-browser-deps for the privileged half.
install-browsers: _require-node-modules #> Download the Playwright browser the e2e projects drive
	cd $(FRONTEND_DIR) && $(PLAYWRIGHT) install $(E2E_BROWSER)

install-browser-deps: _require-node-modules #> Install the browser's system libraries (needs root; not part of install)
	cd $(FRONTEND_DIR) && $(PLAYWRIGHT) install-deps $(E2E_BROWSER)

# ------------------------------------------------------------------------------------------
# 2. migrate - Alembic owns the schema outright, and every revision reverses.
#
# backend/alembic.ini deliberately carries no sqlalchemy.url: migrations/env.py takes the
# connection URL from the settings object, so the application and the migration runner can
# never disagree about which database they are pointed at. That is why these targets load the
# environment rather than passing a URL.
# ------------------------------------------------------------------------------------------
migrate: _require-venv ## Apply every migration up to head (start the database first: make db-up)
	$(LOAD_ENV); \
	cd $(BACKEND_DIR) && '$(ALEMBIC)' upgrade head

migration: _require-venv #> Autogenerate a revision: make migration m="add a table"
	@test -n "$(strip $(m))" || { \
		echo 'usage: make migration m="short imperative message"' >&2; \
		exit 1; \
	}
	$(LOAD_ENV); \
	cd $(BACKEND_DIR) && '$(ALEMBIC)' revision --autogenerate -m "$(m)"

downgrade: _require-venv #> Roll back exactly one revision
	$(LOAD_ENV); \
	cd $(BACKEND_DIR) && '$(ALEMBIC)' downgrade -1

migrate-check: _require-venv #> Fail if the models have drifted from the migration chain
	$(LOAD_ENV); \
	cd $(BACKEND_DIR) && '$(ALEMBIC)' check

# The reversibility proof, in one command: base, head, then drift. It DROPS EVERY TABLE on the
# way down, so point DATABASE_URL at a scratch database before running it.
migrate-reversibility: _require-venv #> Prove the chain reverses: downgrade base, upgrade head, then check (DESTRUCTIVE)
	$(LOAD_ENV); \
	cd $(BACKEND_DIR) \
		&& '$(ALEMBIC)' downgrade base \
		&& '$(ALEMBIC)' upgrade head \
		&& '$(ALEMBIC)' check

# ------------------------------------------------------------------------------------------
# 3. seed - reference categories, the administrator account and the demonstration corpus.
#
# Idempotent by construction: a second run adopts what it finds and writes nothing, so it is
# safe to repeat and there is deliberately no reset here. The administrator's identity and
# credential come from SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in the environment - neither
# is named as a value anywhere in this repository. `migrate` is a declared prerequisite
# because the documented order is schema to head, then data.
# ------------------------------------------------------------------------------------------
seed: migrate ## Seed reference data, the administrator and demo posts (idempotent; implies migrate)
	$(LOAD_ENV); \
	cd $(BACKEND_DIR) && '$(PY)' -m app.db.seed

# ------------------------------------------------------------------------------------------
# 4. dev - the one-command path, the same one docker-compose.yml's own instructions give.
#
# Compose brings up PostgreSQL with its health check, then the backend, which applies
# migrations before it serves, then the frontend. It stays attached so the logs of all three
# are in front of you; Ctrl-C stops the stack. Compose reads .env itself, so nothing is passed.
# ------------------------------------------------------------------------------------------
dev: ## Build and run the whole stack under Compose (db, backend, frontend; Ctrl-C to stop)
	$(COMPOSE) up --build

# The container-free path, for when only one tier is being worked on. Two shells, two targets.
dev-backend: _require-venv #> Run the API alone with reload (DEV_API_HOST, DEV_API_PORT)
	$(LOAD_ENV); \
	cd $(BACKEND_DIR) && '$(VENV_BIN)/uvicorn' app.main:app --reload \
		--host $(DEV_API_HOST) --port $(DEV_API_PORT)

dev-frontend: _require-node-modules #> Run the Next.js development server alone
	$(LOAD_ENV); \
	cd $(FRONTEND_DIR) && $(NPM) run dev

# ------------------------------------------------------------------------------------------
# 5. test - all three suites, cheapest failure first.
#
# The backend suite needs PostgreSQL: it derives a dedicated *_test database from DATABASE_URL
# and refuses to touch the working one. `make db-up` provides it locally; continuous
# integration supplies its own service container, which is why no Compose target is a
# prerequisite here. The end-to-end suite starts and stops its own API and web server.
# ------------------------------------------------------------------------------------------
test: test-backend test-frontend e2e ## Run every suite: backend coverage gate, component tests, end-to-end journeys

# Run from backend/ so pyproject.toml is found as both the pytest and the coverage
# configuration - branch coverage, the omit list and the exclusion patterns all come from
# there. The floor is restated on the command line so it blocks even if that file is not
# read. Same scope as `pytest backend/tests --cov=backend/app`, with the configuration honoured.
test-backend: _require-venv #> Backend unit + integration suites with the coverage floor enforced
	$(LOAD_ENV); \
	cd $(BACKEND_DIR) && '$(PY)' -m pytest --cov=app --cov-fail-under=$(COVERAGE_MIN)

# `--run` is not optional: vitest defaults to watch mode, which would never return.
test-frontend: _require-node-modules #> Component tests, once, never in watch mode
	cd $(FRONTEND_DIR) && $(NPM) run test -- --run

# Six specs, per playwright.config.ts, across its 375, 768 and 1440 pixel viewport projects. The
# suite needs the browser `make install-browsers` downloads and the two NEXT_PUBLIC_ origins,
# which is what the environment load supplies - that config refuses to guess either of them.
e2e: _require-node-modules #> Playwright journeys across the three viewports (starts its own servers)
	$(LOAD_ENV); \
	cd $(FRONTEND_DIR) && $(NPM) run e2e

# ------------------------------------------------------------------------------------------
# 6. lint - zero warnings tolerated on either tier.
#
# Two commands on the backend, on two lines, so each one can fail the target on its own:
# `check` is the rule set and `format --check` is the layout, and neither substitutes for the
# other. The frontend script already carries --max-warnings=0.
# ------------------------------------------------------------------------------------------
lint: lint-backend lint-frontend ## Lint and format-check both tiers, tolerating zero warnings

lint-backend: _require-venv #> ruff check + ruff format --check over backend/
	'$(RUFF)' check $(BACKEND_DIR)
	'$(RUFF)' format --check $(BACKEND_DIR)

lint-frontend: _require-node-modules #> ESLint over frontend/ with --max-warnings=0
	cd $(FRONTEND_DIR) && $(NPM) run lint

# The write counterpart of lint. It rewrites files, so it is never part of a gate.
#
# Prettier is pointed at the repository-root .gitignore deliberately. It looks for an ignore
# file in its own working directory, there is no frontend/.gitignore and no
# frontend/.prettierignore, and without one it walks straight into .next/, playwright-report/,
# test-results/, next-env.d.ts and the tsbuildinfo - hundreds of generated files, not one of them
# anyone's to format. The tracked root ignore list already names every one of them.
format: _require-venv _require-node-modules #> Apply both formatters in place (the write half of lint)
	'$(RUFF)' format $(BACKEND_DIR)
	'$(RUFF)' check --fix $(BACKEND_DIR)
	cd $(FRONTEND_DIR) && $(PRETTIER) --write . --ignore-path '$(CURDIR)/.gitignore'

# ------------------------------------------------------------------------------------------
# 7. typecheck - both tiers, strict.
# ------------------------------------------------------------------------------------------
typecheck: typecheck-backend typecheck-frontend ## Type-check both tiers

# The scope is the backend app package. Run from backend/, because mypy discovers its
# configuration - including the strict settings and the missing-import overrides - relative to
# the working directory, and from the repository root it silently finds none of it.
typecheck-backend: _require-venv #> mypy over the backend app package
	cd $(BACKEND_DIR) && '$(MYPY)' app

typecheck-frontend: _require-node-modules #> tsc --noEmit over frontend/
	cd $(FRONTEND_DIR) && $(NPM) run typecheck

# ------------------------------------------------------------------------------------------
# 8. build - the deployable artifacts.
#
# The web build must leave the working tree untouched: Next.js rewrites tsconfig.json when
# `jsx` is not already `react-jsx`, and frontend/tsconfig.json declares it for exactly that
# reason. `make verify-clean` is how that invariant is asserted rather than assumed - it is a
# separate target on purpose, so an unrelated edit in progress cannot fail a build.
# ------------------------------------------------------------------------------------------
build: build-frontend build-images ## Build the deployable artifacts: the web bundle and both images

build-frontend: _require-node-modules #> Next.js production build (prerenders the static routes)
	$(LOAD_ENV); \
	cd $(FRONTEND_DIR) && $(NPM) run build

build-images: #> Build the backend and frontend container images with Compose
	$(COMPOSE) build

verify-clean: #> Fail if the working tree is dirty (assert a build rewrote no tracked file)
	@test -z "$$(git status --porcelain)" || { \
		echo 'the working tree is not clean - git status --porcelain reported:' >&2; \
		git status --porcelain >&2; \
		echo 'a build must rewrite no tracked file; commit or remove anything else first' >&2; \
		exit 1; \
	}
	@echo 'working tree clean'

# ------------------------------------------------------------------------------------------
# Aggregate and database helpers.
# ------------------------------------------------------------------------------------------
check: lint typecheck test #> Every gate the pipeline enforces, in pipeline order

db-up: #> Start PostgreSQL alone and wait for its health check
	$(COMPOSE) up -d db
	$(MAKE) db-wait

# Bounded, silent and never interactive: sixty attempts two seconds apart, then a failure that
# says so. The role and database are shell expansions with the same defaults docker-compose.yml
# gives the container, so they stay correct under an override.
db-wait: #> Block until PostgreSQL accepts connections, then return
	@for _ in $$(seq 1 60); do \
		if $(COMPOSE) exec -T db pg_isready -U "$${POSTGRES_USER:-blog}" -d "$${POSTGRES_DB:-blog}" -q; then \
			echo 'postgres is ready'; \
			exit 0; \
		fi; \
		sleep 2; \
	done; \
	echo 'postgres did not become ready within 120 seconds' >&2; \
	exit 1

db-down: #> Stop the Compose stack, keeping the data volume
	$(COMPOSE) down

# Caches and build output only. Installed dependencies survive, because reinstalling a
# hash-pinned set to clear a cache is nobody's intent. Every path is inside this checkout.
clean: #> Remove caches and build output (installed dependencies are kept)
	find $(BACKEND_DIR) -path '$(BACKEND_DIR)/.venv' -prune \
		-o -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -rf .ruff_cache \
		$(BACKEND_DIR)/.pytest_cache $(BACKEND_DIR)/.ruff_cache $(BACKEND_DIR)/.mypy_cache \
		$(BACKEND_DIR)/.coverage $(BACKEND_DIR)/htmlcov
	rm -rf $(FRONTEND_DIR)/.next $(FRONTEND_DIR)/coverage \
		$(FRONTEND_DIR)/playwright-report $(FRONTEND_DIR)/test-results
