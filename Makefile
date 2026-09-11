.PHONY: up down migrate dev projector sweep test test-integration lint

up:
	docker compose up -d
	@until docker compose exec -T postgres pg_isready -U catalogsync >/dev/null 2>&1; do sleep 1; done
	@until docker compose exec -T redis redis-cli ping >/dev/null 2>&1; do sleep 1; done
	@echo "applying migrations and creating the three application roles..."
	@$(MAKE) migrate

migrate:
	PGPASSWORD=catalogsync psql -h localhost -U catalogsync -d catalogsync \
		-f prisma/migrations/0001_init/migration.sql

down:
	docker compose down

# Runs src/main.ts — does not exist yet, see docs/CURSOR_CONTEXT.md.
dev:
	npm run start:dev

# Runs the outbox → read-model projector as its own process — does not
# exist yet. See docs/CURSOR_CONTEXT.md §9 for the in-process-vs-
# separate-process decision this target assumes was made in favor of
# a separate process.
projector:
	npm run start:projector

# Runs the saga timeout sweep as its own process — does not exist yet.
sweep:
	npm run start:sweep

# Pure-logic unit tests. No Docker required once these exist.
test:
	npm run test

# The reservation-concurrency, saga-compensation, database-role, and
# outbox-sync suite in test/integration — requires `make up` running.
test-integration:
	npm run test:integration

lint:
	npm run lint
