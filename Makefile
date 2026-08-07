# Developer entry points for the blog platform (all targets non-interactive).
#
# Runtimes pinned for this repository:
#   Python      3.14.7  (backend/.python-version)
#   Node.js     24.19.0 (frontend/.nvmrc)
#   PostgreSQL  18.4    (docker-compose.yml)

SHELL := /bin/bash
.DEFAULT_GOAL := help

PY            := python3.14
VENV          := $(CURDIR)/backend/.venv
VENV_BIN      := $(VENV)/bin
BACKEND       := backend
FRONTEND      := frontend
COMPOSE       := docker compose

.PHONY: help install install-backend install-frontend venv db-up db-down db-wait db-shell \
        migrate migration downgrade seed dev dev-backend dev-frontend build build-frontend \
        test test-backend test-frontend e2e lint lint-backend lint-frontend format \
        typecheck typecheck-backend typecheck-frontend check clean

help: ## Show the available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# --------------------------------------------------------------------------- #
# Install
# --------------------------------------------------------------------------- #
install: install-backend install-frontend ## Install every dependency (both tiers)

venv: ## Create the backend virtual environment with Python 3.14.7
	test -d $(VENV) || $(PY) -m venv $(VENV)
	$(VENV_BIN)/python -m pip install --upgrade pip setuptools wheel

install-backend: venv ## Install backend runtime + development dependencies
	$(VENV_BIN)/python -m pip install -r $(BACKEND)/requirements-dev.txt

install-frontend: ## Install frontend dependencies (npm ci when a lock file is present)
	cd $(FRONTEND) && if [ -f package-lock.json ]; then \
		npm ci --no-audit --no-fund; \
	else \
		npm install --no-audit --no-fund; \
	fi

# --------------------------------------------------------------------------- #
# Database
# --------------------------------------------------------------------------- #
db-up: ## Start PostgreSQL 18.4 and wait until it is healthy
	$(COMPOSE) up -d db
	$(MAKE) db-wait

db-wait: ## Block until PostgreSQL accepts connections
	@for i in $$(seq 1 60); do \
		if $(COMPOSE) exec -T db pg_isready -U "$${POSTGRES_USER:-blog}" -d "$${POSTGRES_DB:-blog}" >/dev/null 2>&1; then \
			echo "postgres ready"; exit 0; \
		fi; \
		sleep 2; \
	done; echo "postgres did not become ready" >&2; exit 1

db-down: ## Stop PostgreSQL (data volume preserved)
	$(COMPOSE) down

db-shell: ## Open a psql shell on the development database
	$(COMPOSE) exec db psql -U "$${POSTGRES_USER:-blog}" -d "$${POSTGRES_DB:-blog}"

# --------------------------------------------------------------------------- #
# Migrations and seed data
# --------------------------------------------------------------------------- #
migrate: ## Apply every migration
	cd $(BACKEND) && $(VENV_BIN)/alembic upgrade head

migration: ## Autogenerate a revision: make migration m="add table"
	cd $(BACKEND) && $(VENV_BIN)/alembic revision --autogenerate -m "$(m)"

downgrade: ## Roll back one revision
	cd $(BACKEND) && $(VENV_BIN)/alembic downgrade -1

seed: ## Load reference categories, the administrator account and demo posts
	cd $(BACKEND) && $(VENV_BIN)/python -m app.db.seed

# --------------------------------------------------------------------------- #
# Run
# --------------------------------------------------------------------------- #
dev: ## Reminder: run the two tiers in separate shells
	@echo "Run in separate shells:  make dev-backend   |   make dev-frontend"

dev-backend: ## Start the API with reload on :8000
	cd $(BACKEND) && $(VENV_BIN)/uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

dev-frontend: ## Start the Next.js development server on :3000
	cd $(FRONTEND) && npm run dev

# --------------------------------------------------------------------------- #
# Quality gates
# --------------------------------------------------------------------------- #
build: build-frontend ## Build every deployable artifact

build-frontend: ## Production build of the Next.js application
	cd $(FRONTEND) && npm run build

test: test-backend test-frontend ## Run every test suite

test-backend: ## Backend unit + integration tests with the coverage floor
	cd $(BACKEND) && $(VENV_BIN)/python -m pytest --cov=app --cov-fail-under=80

test-frontend: ## Frontend component tests (no watch mode)
	cd $(FRONTEND) && npm run test

e2e: ## Playwright end-to-end suite across the three viewports
	cd $(FRONTEND) && npm run e2e

lint: lint-backend lint-frontend ## Lint both tiers

lint-backend: ## ruff check + format verification
	$(VENV_BIN)/ruff check $(BACKEND)
	$(VENV_BIN)/ruff format --check $(BACKEND)

lint-frontend: ## ESLint with zero tolerated warnings
	cd $(FRONTEND) && npm run lint

format: ## Apply formatters to both tiers
	$(VENV_BIN)/ruff format $(BACKEND)
	$(VENV_BIN)/ruff check --fix $(BACKEND)
	cd $(FRONTEND) && npm run format

typecheck: typecheck-backend typecheck-frontend ## Static typing for both tiers

typecheck-backend: ## mypy over the backend package
	cd $(BACKEND) && $(VENV_BIN)/mypy app

typecheck-frontend: ## TypeScript with no emit
	cd $(FRONTEND) && npm run typecheck

check: lint typecheck test ## Everything CI enforces

clean: ## Remove caches and build output (dependencies are kept)
	find . -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
	rm -rf $(BACKEND)/.pytest_cache $(BACKEND)/.ruff_cache $(BACKEND)/.mypy_cache $(BACKEND)/htmlcov
	rm -rf $(FRONTEND)/.next $(FRONTEND)/out $(FRONTEND)/coverage $(FRONTEND)/playwright-report $(FRONTEND)/test-results
