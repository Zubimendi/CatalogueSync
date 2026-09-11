# Agent context: building CatalogSync

Read this file first, then `docs/ARCHITECTURE.md`, then `docs/PRD.md`
and `docs/RESEARCH.md`, before writing anything. **This document is the
spec — the actual implementation instructions — for code that doesn't
exist yet.** This is the largest, most detailed build spec in this
portfolio; read it fully before starting, not module-by-module as you
go, since several early decisions (the three-role connection setup,
specifically) affect how almost everything else is wired.

## Project identity

- **Name:** CatalogSync — multi-vendor marketplace catalog and inventory
  engine.
- **Stack:** NestJS 10, TypeScript, `@nestjs/cqrs` (CommandBus/QueryBus/
  EventBus — used deliberately partially, see `docs/ARCHITECTURE.md`
  §6), PostgreSQL 16 via Prisma, Redis (`ioredis`), Prometheus
  (`prom-client`), Docker Compose.
- **Purpose:** see `docs/PRD.md` for the full brief,
  `docs/ARCHITECTURE.md` for why every decision below is made the way
  it's made, and `docs/RESEARCH.md` for the prior art grounding CQRS,
  the saga pattern, and the outbox pattern specifically — read the
  reasoning, don't just implement the shape.
- **Companion projects:** SearchCraft (the trigger-enforced outbox
  pattern, reused directly — §3 of `docs/ARCHITECTURE.md`), FlagForge
  (Redis cache-aside with explicit invalidation — reused for mechanism,
  explicitly *not* reused for Redis's role in the architecture, see
  `docs/ARCHITECTURE.md` §10), FormFlow and Tribunal (pin-state-at-
  creation-time, applied here to price), SlotForge and PyDataRex (the
  CAS conditional-update idiom, and the lease-based leader-election
  pattern referenced but not built for the sweep's future HA path).

## Current state

### Done
- `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/RESEARCH.md`,
  `docs/TESTING.md`, `docs/STORY.md`, this file, `README.md`.
- Schema: `prisma/migrations/0001_init/migration.sql` — write-side
  tables, the trigger-enforced outbox, the denormalized read model,
  ordering/saga tables, and the three Postgres roles
  (`catalogsync_write`, `catalogsync_read`, `catalogsync_projector`) —
  the single most important object in this migration, alongside the two
  outbox triggers.
- `docker-compose.yml` (Postgres + Redis), `Dockerfile` (will not build
  until `src/main.ts` exists), `Makefile`, `.env.example`,
  `package.json` (dependency list only — nothing imports them yet).

### Not done — this entire document is the task list

Every `src/*` directory is empty except for a `.gitkeep`. Build in the
order listed; later modules depend on earlier ones.

---

#### 0. Resolving the PRD's open question: vendor suspension mid-saga

Before writing any ordering code, make this call explicitly (it's left
open in `docs/PRD.md` §7): **when `vendors.status` flips to `SUSPENDED`
while one of that vendor's suborders is `PENDING_RESERVATION` or
already `RESERVED`, the suspension does not retroactively fail or
compensate an already-in-flight saga.** A suspension blocks *new*
listings and orders from that vendor going forward (checked at listing
lookup / order placement time, §5 below) but does not reach into a
saga that's already running — reaching backward into in-flight sagas
from an unrelated administrative action adds real complexity (the sweep
and the suspension logic would need to coordinate) for a case that's
rare and, for v1, acceptable to leave as "the in-flight order completes
or times out normally, the vendor simply can't be selected for anything
new." Document this decision with a comment at the point
`vendors.status` is checked (§5) and in `SagaReconciliationService`
itself, referencing this section, so a future contributor doesn't
"fix" the apparent gap without understanding it was a deliberate call.

#### 1. `src/common/db` — the three-connection foundation, build this first

Three separate Prisma clients (or, if Prisma's connection-per-client
model proves awkward for three roles against one schema, three separate
`pg`/`Pool` instances wrapped in a thin repository layer — decide and
document which, since this is a foundational choice everything else
depends on; Prisma is listed as the ORM in this project's stack, but if
raw connection-role separation is meaningfully easier with `pg` directly
for the read and projector roles specifically, say so explicitly rather
than forcing Prisma into a shape it resists):
- `WriteDbService` — connects using `catalogsync_write`'s credentials
  (`DATABASE_URL_WRITE`). Injected into `src/catalog-write` and
  `src/ordering` only.
- `ReadDbService` — connects using `catalogsync_read`'s credentials
  (`DATABASE_URL_READ`). Injected into `src/catalog-read` only.
- `ProjectorDbService` — connects using `catalogsync_projector`'s
  credentials (`DATABASE_URL_PROJECTOR`). Injected into `src/projector`
  only.

**Enforce this at the NestJS module level, not just by convention**:
`CatalogWriteModule` exports only providers built on `WriteDbService`;
`CatalogReadModule` exports only providers built on `ReadDbService`.
Neither module imports the other's database service at all — there
should be no NestJS provider anywhere in the dependency graph that has
both a write connection and a read connection injected into the same
class. This is the code-organization half of §1's guarantee; §4's
database roles are the half that actually holds even if this
convention is violated by a future mistake — build both, don't treat
either as sufficient alone.

#### 2. `src/catalog-write` — the write-side aggregates and command handlers

**Domain models** (as `@nestjs/cqrs` `AggregateRoot` subclasses):
`ProductListing` (id, vendorId, categoryId, sku, title, description,
priceCents, currency, status) and `Inventory` (listingId,
onHandQuantity, reservedQuantity) — `Inventory.reserve(qty)` and
`.release(qty)` are the methods that apply the CAS update from
`docs/ARCHITECTURE.md` §2 and, on success, call `this.apply(new
StockReservedEvent(...))` / `StockReleasedEvent(...)` per the
`@nestjs/cqrs` aggregate pattern.

**Commands** (`ICommand` + `ICommandHandler` pairs): `CreateListingCommand`,
`UpdateListingCommand`, `DelistListingCommand`, `AdjustStockCommand`
(a vendor reporting a new on-hand count — not the same as reservation;
document the distinction clearly: `AdjustStockCommand` changes
`on_hand_quantity` directly, e.g. from a vendor's own warehouse count
sync, and must itself be a CAS-safe operation too if it's a relative
adjustment rather than an absolute set — decide which semantics
(absolute set vs. relative delta) and document it, since they have
different concurrency implications), `ReserveStockCommand`,
`ReleaseStockCommand`. Every handler here uses `WriteDbService`
exclusively.

**Every command handler validates `vendorId` from the actor token
against the target listing's own `vendorId`** before doing anything else
— per `docs/ARCHITECTURE.md` §11, this check plus the query's own
`WHERE vendor_id = :actorVendorId` (not just a check-then-proceed) is
what makes cross-vendor writes structurally impossible, not just
rejected after the fact.

`src/catalog-write/errors.ts` — `ErrListingNotFound`,
`ErrNotYourListing`, `ErrInsufficientStock`, `ErrVendorSuspended`.

**Write `test/integration/reservation-concurrency.spec.ts` immediately
after `Inventory.reserve()` exists** — see `docs/TESTING.md` §1. This is
the project's first centerpiece; prove it before building anything that
depends on it.

#### 3. `src/projector` — the outbox-draining read-model builder

`OutboxProjectorService`, structurally the same shape as SearchCraft's
`OutboxWorker`: polls `outbox_events` for unprocessed rows (`SELECT ...
WHERE processed_at IS NULL ORDER BY id LIMIT :batchSize FOR UPDATE SKIP
LOCKED`, using `ProjectorDbService`), and for each batch:
1. For `entity_type = 'product_listing'` events: upsert the
   corresponding `catalog_listings_view` row, joining in the current
   `vendors.name`/`.status` and `categories.name` (read live from the
   write-side tables via the same `ProjectorDbService` connection — this
   role has `SELECT` on those tables specifically so it can build a
   correctly denormalized row).
2. For `entity_type = 'inventory'` events: recompute and update just the
   `available_quantity` column on the corresponding
   `catalog_listings_view` row (`on_hand_quantity - reserved_quantity`
   from the event's payload).
3. For a `DELETE` operation on either entity type: remove or
   soft-status the corresponding read-model row (decide and document
   which — a hard delete is simpler, a soft "DELISTED" status preserves
   the row for any in-flight order history that might reference it via
   the read model for display purposes; check whether anything actually
   needs that before choosing the more complex option).
4. Set `catalog_listings_view.last_synced_outbox_id` to the applied
   event's id, `processed_at` on the outbox row, and — the invalidation
   half of `docs/ARCHITECTURE.md` §10 — delete the corresponding Redis
   cache keys (`src/catalog-read`'s cache-key scheme, §4 below) for
   every query shape that could be affected (at minimum: the listing's
   own cache key and its category's browse-page cache key).

Batch failures increment `attempts`/`last_error` on the affected outbox
rows and do not mark them processed, the same retry-without-blocking-
the-queue shape as SearchCraft's worker (rows past
`OUTBOX_MAX_ATTEMPTS` stop being selected by the poll query, visible via
a `GET /internal/outbox/stuck` endpoint — same dead-letter visibility
pattern as SearchCraft's `/v1/admin/outbox/stuck`).

#### 4. `src/catalog-read` — queries and the Redis cache-aside layer

Query handlers (`IQuery`/`IQueryHandler`): `BrowseListingsQuery`
(category + price-range filters, pagination), `GetListingQuery` (single
listing by id), `SearchListingsByVendorQuery`. Every handler uses
`ReadDbService` exclusively — **this module never imports
`WriteDbService` or `ProjectorDbService` at all; there is no legitimate
reason for it to**.

Cache-aside wrapper (`CatalogCacheService`): a documented, deterministic
key scheme (e.g. `catalog:listing:{id}`, `catalog:category:{categoryId}:page:{n}`)
with a TTL (`CATALOG_CACHE_TTL_SECONDS`, a backstop, not the primary
consistency mechanism — same discipline as FlagForge's evaluation
cache) and explicit `del()` calls driven by `OutboxProjectorService`
(§3). Document plainly, at the top of this file, that this cache is
**never** consulted by anything in `src/catalog-write` or
`src/ordering` — grep for any future import of `CatalogCacheService`
outside `src/catalog-read` as a quick self-check before merging any
change to either of those modules.

#### 5. `src/vendors` — minimal vendor/category CRUD

Not the focus of this project — keep this small. `POST /v1/vendors`,
`PATCH /v1/vendors/{id}` (status only — `ACTIVE`/`SUSPENDED`), `POST
/v1/categories`. Listing creation (`src/catalog-write`) and order
placement (`src/ordering`) both check `vendors.status = 'ACTIVE'`
before proceeding — reject with `ErrVendorSuspended` otherwise. This is
the "blocks new things going forward" half of §0's decision above; the
"doesn't reach into an in-flight saga" half is `SagaReconciliationService`
simply not checking vendor status at all when deciding what to
compensate.

#### 6. `src/ordering` — the saga, its compensation, and the timeout sweep

**`OrderSagaService.placeOrder(buyerRef, items: {listingId, quantity}[])`**
— `docs/ARCHITECTURE.md` §5–7's full sequence, exactly:
1. Look up each `listingId`'s `vendorId` (via `WriteDbService` — this
   entire module uses the write connection exclusively, same as
   `catalog-write`), group items by vendor.
2. In one initial transaction: insert `customer_orders` (`PENDING`),
   one `vendor_suborders` row per vendor group (`PENDING_RESERVATION`),
   and their `order_line_items` (capturing `unit_price_cents` from each
   listing's *current* price at this exact moment — §9's snapshot).
3. For **every** `vendor_suborder`, in its own separate transaction
   (§5 — never one shared transaction across vendors): attempt
   `Inventory.reserve()` for every line item belonging to that
   suborder. Record a `saga_steps` row for each attempt
   (`RESERVE_ATTEMPTED`, then `RESERVE_SUCCEEDED` or `RESERVE_FAILED`).
   Set the suborder's status accordingly. **Do not stop after the first
   failure — attempt every vendor's suborder regardless of earlier
   results** (§7).
4. If every suborder reached `RESERVED`: set `customer_orders.status =
   'CONFIRMED'`.
5. If any suborder is `RESERVATION_FAILED`: for every *other* suborder
   that reached `RESERVED`, call `Inventory.release()` for its line
   items, in its own transaction, recording `COMPENSATION_ATTEMPTED`/
   `COMPENSATION_SUCCEEDED` steps, setting that suborder's status to
   `ROLLED_BACK`. Set `customer_orders.status = 'FAILED'`.
6. Return the full result — every suborder's final status — so the
   caller can report exactly which vendor(s) failed, not just "order
   failed" (this is the payoff of §7's "gather complete information"
   decision).

**`SagaReconciliationService`** — a scheduled sweep
(`@Interval(SAGA_SWEEP_INTERVAL_MS)`): finds `customer_orders` with
`status = 'PENDING'` and `created_at < now() - SAGA_TIMEOUT_SECONDS`,
and for each, forces every non-terminal `vendor_suborder`
(`PENDING_RESERVATION` or `RESERVED`) to compensate — releasing any
actual reservations found (a `RESERVED` suborder really did reserve
stock; a `PENDING_RESERVATION` one that never got attempted has nothing
to release, only a status flip to `ROLLED_BACK`) — recording
`SWEEP_COMPENSATED` steps distinctly from the inline
`COMPENSATION_SUCCEEDED` steps §6 produces, per
`docs/ARCHITECTURE.md` §12's observability note (the two should be
countable separately). Sets `customer_orders.status = 'FAILED'`.

`src/ordering/errors.ts` — `ErrEmptyCart`, `ErrListingsSpanTooManyVendors`
(decide on and document a sane per-order vendor cap, e.g. 10, as a
sanity limit — not a hard architectural requirement, just a reasonable
guard against a degenerate request), `ErrOrderNotFound`.

**Write `test/integration/saga-compensation.spec.ts` and
`saga-timeout-sweep.spec.ts` immediately after this module compiles** —
see `docs/TESTING.md` §2 and §4. This is the project's second
centerpiece.

#### 7. `src/auth` — deliberately minimal actor/vendor tokens

Same HMAC-signed, stateless shape as Switchboard's `wsauth`, FormFlow's
admin key, and Tribunal's actor tokens elsewhere in this portfolio:
`Claims {actorId, vendorId?, roles: string[]}` (a buyer token has no
`vendorId`; a vendor token does — the field's presence is itself the
distinguishing signal between the two actor types), `issue`/`verify` via
HMAC-SHA256, `hmac.compare`/timing-safe comparison, no database lookup
in verification. AuthNexus, a later roadmap project, is where a real
identity system belongs — don't scope-creep it in here.

#### 8. `src/observability` and `src/health`

Metrics per `docs/ARCHITECTURE.md` §12 (`prom-client`): reservation
outcome counters, saga outcome counters (with the inline-vs-sweep
compensation distinction), outbox lag gauge, Redis cache hit-rate
counter. `GET /health/live`; `GET /health/ready` checks all three
database roles' connections independently (report which specific role
is unreachable if any is — a `catalogsync_read`-only outage, for
instance, would be a meaningfully different incident than a full
Postgres outage, and the health check should be able to say so) plus
Redis. `GET /metrics` via `prom-client`'s registry.

#### 9. `src/main.ts` and module wiring

`AppModule` imports `CommonDbModule`, `CatalogWriteModule`,
`CatalogReadModule`, `ProjectorModule`, `OrderingModule`, `VendorsModule`,
`AuthModule`, `ObservabilityModule`, `HealthModule`. Bootstrap with
global validation pipes (`whitelist: true, forbidNonWhitelisted: true`,
the same server-side-validation discipline as every other project in
this portfolio), graceful shutdown hooks closing all three database
connections and the Redis client.

**Decide and document whether `OutboxProjectorService` and
`SagaReconciliationService` run in-process (as NestJS scheduled
tasks/intervals within the main API process) or as separate processes**
(mirroring SearchCraft's and FormFlow's separate-worker-process
pattern). Given this project's emphasis on the read/write boundary being
structurally separate, running the projector as a genuinely separate
process (its own `main.ts` entrypoint, `npm run projector`) is more
consistent with the rest of this portfolio's conventions and makes the
three-connection separation even more concrete operationally (a
separate OS process, not just a separate NestJS provider, holding the
`catalogsync_projector` credentials) — recommended, but make the call
explicitly rather than defaulting silently to whichever is easier to
wire up first.

---

## Design decisions already made — don't relitigate without reason

1. **The read model is never consulted by any write-path decision, at
   two independent layers** — NestJS module boundaries (convention) and
   Postgres role grants (enforced). Don't let a future feature add a
   "quick read" from `catalog_listings_view` into `src/catalog-write`
   or `src/ordering` for convenience; that's precisely the drift
   `docs/ARCHITECTURE.md` §1 and §4 exist to prevent.
2. **`available` is never a stored column** — always
   `on_hand_quantity - reserved_quantity`, computed in the same
   statement that reads or writes it. Don't add a cached/materialized
   `available_quantity` column to the *write-side* `inventory` table
   "for convenience" (the read-model's `catalog_listings_view` having
   one is fine and expected — that one is explicitly a denormalized
   snapshot, not the source of truth).
3. **The outbox is populated exclusively by database triggers**, not
   application code — see `docs/ARCHITECTURE.md` §3. Don't add an
   application-level outbox write anywhere, even as a "just in case"
   backup to the trigger.
4. **Every vendor's reservation within a saga happens in its own
   transaction**, never one shared transaction across vendors, even
   though the current deployment could technically support the
   shortcut — see `docs/ARCHITECTURE.md` §5. This is the single most
   important discipline in `src/ordering` to preserve.
5. **The saga never stops at the first vendor failure** — every vendor
   is attempted before any compensation decision is made. See
   `docs/ARCHITECTURE.md` §7.
6. **`OrderSagaService` stays a plain orchestrating service, not
   `@nestjs/cqrs`'s `@Saga()` choreography primitive.** See
   `docs/ARCHITECTURE.md` §6 for exactly why.
7. **`order_line_items.unit_price_cents` is captured once and never
   re-derived from the live listing.** See `docs/ARCHITECTURE.md` §9.
8. **Vendor suspension does not reach backward into an already-running
   saga** — see §0 above. This was a genuinely open question in
   `docs/PRD.md`; the decision and its reasoning live here now.
9. **Redis here is a pure performance cache with explicit invalidation
   and a TTL backstop — never a source of truth for any decision.**
   Don't treat it the way FlagForge treats its evaluation cache; see
   `docs/ARCHITECTURE.md` §10 for the explicit contrast.

## Suggested build order (restated as a checklist)

1. `src/common/db` — the three-connection foundation. Nothing else
   should be started until this is right.
2. `src/catalog-write` — write **and immediately test**
   `reservation-concurrency.spec.ts` (`docs/TESTING.md` §1) before
   moving on. This is the project's first centerpiece.
3. `src/projector` — write the outbox-to-read-model sync test
   (`docs/TESTING.md` §5) right after.
4. `src/catalog-read` — including the Redis cache-aside layer.
5. `src/vendors`, `src/auth`.
6. `src/ordering` — write **and immediately test**
   `saga-compensation.spec.ts` and `saga-timeout-sweep.spec.ts`
   (`docs/TESTING.md` §2, §4) right after. This is the project's second
   centerpiece.
7. `src/observability`, `src/health`.
8. `src/main.ts` — the first point at which `make dev` should actually
   start a server. Decide the in-process-vs-separate-process question
   for the projector and sweep here, explicitly (§9 above).
9. The database-role enforcement test (`docs/TESTING.md` §3) and the
   price-snapshot test (`docs/TESTING.md` §6) — quick to write, easy to
   defer by accident; don't.

## How to give a fresh agent session everything it needs

Point it at, in this order: this file → `docs/ARCHITECTURE.md` →
`docs/PRD.md` → `docs/RESEARCH.md`. Tell it explicitly: "nothing in
`src/` is written yet — this file's numbered sections are the actual
spec, build in the order listed, and do not deviate from the 'design
decisions already made' list without first re-reading why each one is
the way it is in `docs/ARCHITECTURE.md` — this project has two
centerpieces (the atomic reservation + database-role separation, and
the saga's compensation logic), and both need their own tests proven
before anything else is built on top of them."
