# Architecture: principles → code

Same format as every project in this portfolio: each section names a
principle, what it means for a multi-vendor catalog and inventory engine
specifically, and exactly where `docs/CURSOR_CONTEXT.md` specifies it
needs to be implemented. This is the largest project in the portfolio so
far — the section count reflects that; read `docs/RESEARCH.md` alongside
this document for the prior art each section is grounded in.

## System shape

```
   vendor write API                          buyer read API
        │                                          │
        ▼                                          ▼
 ┌──────────────┐                         ┌──────────────────┐
 │ catalog-write   │  role: catalogsync_write │ catalog-read       │  role: catalogsync_read
 │ (commands)       │                         │ (queries, Redis     │  SELECT-only, ONE table
 └──────┬───────┘                         │  cache-aside in front)│
        │ product_listings, inventory      └────────┬─────────┘
        ▼ (trigger-enforced outbox)                  ▲
 ┌──────────────┐                                    │ never touches
 │ outbox_events   │                                  │ write-side tables —
 └──────┬───────┘                                  │ cannot, by grant
        │ drained by
        ▼
 ┌──────────────────┐   role: catalogsync_projector
 │ OutboxProjector      │   reads write-side, writes
 │ (src/projector)       │   catalog_listings_view +
 └──────────────────┘   invalidates Redis

        write-side also feeds:
        ┌──────────────────────┐
        │ OrderSagaService         │  reserves against inventory
        │ (src/ordering)            │  DIRECTLY — never the read model
        └──────────────────────┘
```

---

## 1. The read model is structurally incapable of deciding anything — the CQRS centerpiece

**The failure mode this exists to prevent:** the single most common way
"CQRS" systems quietly stop being CQRS is that the read model, built for
speed and denormalization, ends up being consulted by *some* write-path
decision because it's more convenient than threading a query through to
the authoritative source — most often, a checkout flow checking "is this
in stock" against the fast browsable catalog instead of the slower,
correct, write-side table. The moment that happens, the read model's
staleness — which was supposed to be a safe, bounded, explicitly-accepted
trade-off — becomes a source of real, customer-visible overselling.

**The mechanism:** `catalog_listings_view` (schema) is written
exclusively by `OutboxProjector` (`src/projector`), and read exclusively
by `catalog-read`'s query handlers (`src/catalog-read`). The order-
placement saga (`src/ordering`) and every stock-reservation command
(`src/catalog-write`) read `inventory` directly — never
`catalog_listings_view`, never anything cached in Redis. This isn't
just a module-boundary convention (though it is also that — see
`docs/CURSOR_CONTEXT.md`'s explicit note that NestJS's dependency
injection can't fully prevent a future contributor from importing the
wrong repository into the wrong module) — it's enforced one layer
further down, at the database itself, which is §4 below and the actual
guarantee this section depends on to be more than a good intention.

## 2. Atomic stock reservation — a single conditional update, computed availability

**Where:** reserving `qty` units of a listing is exactly one statement:

```sql
UPDATE inventory
SET reserved_quantity = reserved_quantity + :qty, updated_at = now()
WHERE listing_id = :listingId
  AND (on_hand_quantity - reserved_quantity) >= :qty
RETURNING listing_id;
```

Success is "one row returned"; failure (insufficient stock, or the
listing doesn't exist) is "zero rows returned" — checked via the
returned row count, not by a separate `SELECT` beforehand that could go
stale between the check and the write. This is the same compare-and-swap
discipline used repeatedly elsewhere in this portfolio (LedgerLine's
balance updates, SplitStack's optimistic locking, PyDataRex's leader
election) — one round trip, no held lock across any other work, and a
result that's unambiguous. **`available` is never a stored column** —
it's always computed as `on_hand_quantity - reserved_quantity`, at read
time and inside this statement's own `WHERE` clause, specifically so
there is no second number that could independently drift out of sync
with the two that actually matter. Releasing a reservation (the
compensating action, §6) is the mirror-image statement, decrementing
`reserved_quantity`, with its own affected-row-count check — a release
that returns zero rows when the caller expected one is a bug signal
(the accounting says more was reserved than actually was), not a
silently-ignored no-op; see `docs/CURSOR_CONTEXT.md` for the specific
alerting behavior this should trigger.

## 3. The trigger-enforced outbox — reused from SearchCraft, on purpose

**Where:** `product_listings_outbox_trigger()` and
`inventory_outbox_trigger()` (`prisma/migrations/0001_init/migration.sql`)
are the same pattern as SearchCraft's `products_outbox_trigger()`
elsewhere in this portfolio: an `AFTER INSERT OR UPDATE OR DELETE`
trigger writes a row into `outbox_events` inside the exact same
transaction as the write it's recording, using Postgres's own
`to_jsonb(NEW)`/`to_jsonb(OLD)`. This means it is not possible for a
vendor's listing or stock change to reach the database without a
corresponding outbox event committing alongside it — not because
application code remembers to do it, but because syncing isn't
something application code is responsible for at all. Reusing this
mechanism from SearchCraft isn't incidental — it's the same underlying
correctness problem (a denormalized read side must never silently drift
from its source of truth) recognized in a second domain, and the fix
doesn't need to be reinvented to fit.

## 4. Three-role database access separation — the second centerpiece

**The gap this closes:** §1's structural claim ("the read model can't
decide anything, the write path never reads it") is, by itself, a
code-organization discipline — real, valuable, and also the exact kind
of discipline that erodes under deadline pressure, a rushed feature, or
a new contributor who doesn't know the convention. `docs/RESEARCH.md`
names this as the single most common real-world way CQRS's guarantees
quietly stop holding.

**The mechanism:** three separate Postgres roles, each with grants
scoped to exactly what that part of the system needs and nothing else
(`prisma/migrations/0001_init/migration.sql`):
- `catalogsync_write` — full DML on every write-side table, **no grants
  at all on `catalog_listings_view`**. The write path's database
  connection cannot query the read model even if a future bug tried —
  the query would fail with a Postgres permission error before it could
  return any (potentially stale) data to influence a decision.
- `catalogsync_read` — `SELECT` only, and only on
  `catalog_listings_view`. This role cannot see `product_listings`,
  `inventory`, `customer_orders`, or anything else, for any reason. A
  browse/search handler connected with this role's credentials
  literally cannot check live stock even if someone tried to make it —
  the permission doesn't exist to grant.
- `catalogsync_projector` — the only role that can both read write-side
  state and write the read model. It has no write access to any
  write-side table at all — it observes the outbox and the tables it
  describes, and produces the read model; it never mutates the source
  of truth it's projecting from.

This turns §1's claim from "our code is organized so this shouldn't
happen" into "this cannot happen, provably, and here's the failing
Postgres error that demonstrates it" — see `docs/TESTING.md` §3 for the
test that connects directly with the read role's own credentials and
confirms a write attempt is rejected by the database itself.

**Named limitation, not glossed over:** this protects against
*accidental* cross-boundary access from the wrong part of the
application — a bug, a shortcut, a new contributor reaching for the
wrong repository. It does not protect against someone who actually has
the `catalogsync_write` role's real password deciding to query
`catalog_listings_view` some other way, or against a compromised
credential generally. That's a different threat model (credential
security, network-level access control) outside what this project's
architecture is trying to solve — see `docs/PRD.md` §7.

## 5. The saga is modeled as if every vendor were an independently-failing system — even though it isn't, yet

**The temptation this deliberately resists:** every vendor's inventory
currently lives in the same physical Postgres instance. Nothing would
stop `OrderSagaService` from wrapping a multi-vendor order's entire
reservation sequence in one big ACID transaction — reserve stock at
vendor A, vendor B, and vendor C, and let Postgres's own transactional
guarantees handle "roll everything back if any one fails," for free,
with none of the compensating-transaction machinery a real saga needs.

**Why that shortcut is refused on purpose:** the entire point of this
project is demonstrating the coordination pattern a real, larger
marketplace would need the moment vendor inventories are actually
sharded across separate databases (a realistic evolution — different
vendors at real scale often *do* end up on physically separate systems,
whether through deliberate sharding, acquisition, or a vendor-hosted
inventory integration). If this project took the one-big-transaction
shortcut now, "add the saga pattern" would become a second, later
migration project the moment vendor data actually became distributed —
throwing away the exact lesson this project exists to teach at the
moment it would actually matter. Instead, `OrderSagaService` treats each
`vendor_suborder`'s reservation as its own independent transaction,
coordinated explicitly, with explicit compensating releases — genuinely
correct today, and structurally ready for vendor data to actually move
to separate systems later without needing to be redesigned, only
re-pointed at different connections.

## 6. Orchestration, not choreography — and the specific tension with `@nestjs/cqrs`'s `Saga` primitive

**Where:** `OrderSagaService.placeOrder()` (`src/ordering`) is a single
method explicitly driving every step of the saga — group cart items by
vendor, attempt each vendor's reservation, decide the overall outcome,
compensate if needed — rather than a set of event handlers independently
reacting to each other's output. This is a deliberate choice between the
two standard implementation styles for a saga (`docs/RESEARCH.md`):
orchestration (one coordinator, explicit control flow, easier to test
and reason about for a moderate step count) versus choreography (each
participant reacts to events, no central coordinator, scales better to
many loosely-coupled participants at the cost of the overall flow being
implicit rather than visible in one place).

**Worth naming directly:** `@nestjs/cqrs`, the library this project uses
for its command/query/event infrastructure, ships a `@Saga()` decorator
— but it's a *choreography* helper (it maps an incoming event stream to
a new command to dispatch), not an orchestration one. Using it for
`OrderSagaService` would mean scattering the reservation-then-compensate
logic across several independent event handlers reacting to each
other's `ReservationFailed`/`ReservationSucceeded` events, rather than
one method that reads clearly top to bottom and that a test can drive
directly. For a first, simplified saga implementation — where testability
and having the compensation logic legible in one place matters more than
choreography's larger-scale decoupling benefits — this project uses
`@nestjs/cqrs`'s `CommandBus`/`EventBus` for the individual reservation
and release operations, but keeps the saga's own control flow in a plain
orchestrating service, not the library's `Saga` primitive. This is a
specific, deliberate library-usage decision, not a gap in familiarity
with what the library offers.

## 7. Gather complete information before compensating — don't short-circuit on the first failure

**Where:** `OrderSagaService` attempts reservation for **every**
`vendor_suborder` in an order before deciding whether to compensate
anything — it does not stop at the first vendor that fails. Only after
every vendor's reservation has been attempted does the saga decide the
overall outcome and, if any vendor failed, compensate every vendor that
succeeded. This is a deliberate trade-off: stopping early would save a
small amount of work in the failure case, but it means a buyer whose
order fails only ever learns about the *first* vendor that happened to
be out of stock, not the complete picture ("vendor B was out of stock;
everything else was available") — worse information for a worse
experience, to save a small amount of work in an already-failing path.
`docs/PRD.md` §7 names the deeper version of this trade-off explicitly:
v1 still fails the *entire* order even with complete information about
which vendors would have succeeded (all-or-nothing), but having that
complete information is what makes partial fulfillment (a named future
extension) possible to build later without re-architecting how the saga
gathers its results.

## 8. The saga timeout sweep — the correctness backstop for a crashed coordinator

**The gap this closes, named honestly:** v1's saga runs within one
orchestrating request; it has no durable, resumable log the way the
roadmap's week 15 capstone will build. If the process running
`OrderSagaService.placeOrder()` crashes after successfully reserving
stock at vendor A and B but before attempting vendor C, those
reservations are real, held, and correct — but nothing will ever
compensate them if the crash is the last thing that happens to that
order.

**The mechanism:** `SagaReconciliationService` (`src/ordering`), a
scheduled sweep, queries for `customer_orders` still `PENDING` past
`SAGA_TIMEOUT_SECONDS` with any `vendor_suborders` still
`PENDING_RESERVATION` or stuck `RESERVED` with no forward progress, and
force-compensates them — releasing every reservation held by that order
and transitioning it to `FAILED`. This is the same "don't trust only the
happy-path signal, have an independent, timeout-based correction
mechanism" principle used throughout this portfolio (SlotForge's cron
backstop for expired holds, Switchboard's presence TTL, PyDataRex's
lease-based leader election) — recognized here in a fifth domain. A
single sweep replica is sufficient for v1; if this ever needed to run as
multiple replicas for availability, the natural mechanism is the exact
lease-row-plus-conditional-`UPDATE` pattern PyDataRex uses for its own
leader election, not rebuilt from scratch — not built in v1, since one
replica is enough to start.

## 9. Price snapshotting — pin what mattered, when it mattered

**Where:** `order_line_items.unit_price_cents` is captured once, at the
moment a `vendor_suborder`'s reservation succeeds, from the listing's
price at that instant — and is never re-read from the live
`product_listings.price_cents` afterward, for any reason, including
displaying an existing order's history. This is the same "pin the state
that governed a decision at the moment it was made, permanently" theme
as FormFlow's form-version pinning and Tribunal's workflow-version
pinning elsewhere in this portfolio, applied here to a single scalar
(price) rather than an entire rule document — proportionate to what's
actually at stake: a vendor changing their price tomorrow must never
retroactively change what a customer already agreed to pay today.

## 10. Redis is a pure performance cache here — never a decision store

**Where:** `src/catalog-read`'s cache-aside layer wraps queries against
`catalog_listings_view` with a Redis cache, invalidated explicitly by
`OutboxProjector` on every write it applies (the same "explicit
invalidation, TTL as a backstop only" discipline FlagForge uses for its
evaluation cache elsewhere in this portfolio) — but the resemblance to
FlagForge stops there, on purpose. FlagForge's Redis cache *is* the
system's read-path source of truth for flag evaluation; there's no
slower, more-authoritative fallback a client would ever want instead.
CatalogSync's Redis cache is a pure speed optimization sitting in front
of an already-separate, already-eventually-consistent Postgres read
model — the single most reservation-critical number in this entire
system, available stock, is deliberately never cached here for a
decision, only ever computed live against the write-side `inventory`
table by the reservation path in §2. Two projects in this portfolio use
Redis for genuinely different roles, and conflating them — treating
CatalogSync's cache as if it carried FlagForge's authority — would be
exactly the kind of read-model-creep §1 exists to prevent.

## 11. Vendor-scoped write boundaries

**Where:** every write-side command handler (`src/catalog-write`) takes
`vendorId` from the authenticated actor token, never from a
client-supplied field in the request body, and every write's `WHERE`
clause includes it — the same tenant-scoping discipline as SlotForge's
and SplitStack's `orgId` handling elsewhere in this portfolio. A
vendor's write access is structurally confined to their own
`product_listings`/`inventory` rows; there is no code path where one
vendor's command handler can affect another vendor's data, by construction
of the query itself, not a permission check layered on top of an
otherwise-unscoped query.

## 12. Observability

**Where:** Prometheus metrics (per `docs/CURSOR_CONTEXT.md`) track
reservation outcomes (success/insufficient-stock, broken out — a rising
insufficient-stock rate on a specific listing is a real, actionable
signal, not noise), saga outcomes (confirmed/compensated, and
compensated-by-sweep separately from compensated-inline, since the
former specifically indicates a crashed or slow coordinator worth
investigating), outbox lag (the age of the oldest unprocessed event —
the read model's actual real-time freshness signal), and Redis cache hit
rate. `/health/live` and `/health/ready` (Postgres — checked against
*all three* roles' connections, plus Redis) follow the same shape as
every other project in this portfolio.

## What's out of scope, and why

- **Full-text/relevance search** — delegated conceptually to SearchCraft,
  an earlier project in this portfolio already built to solve that
  problem; not duplicated here. See `docs/PRD.md` §4.
- **Durable, resumable saga orchestration** — the week 15 capstone's
  explicit job; v1's timeout-sweep backstop is real but simpler, named
  honestly in §8.
- **Partial order fulfillment, payments, and vendor payouts** — real
  product features, genuinely orthogonal to this project's actual
  subject (catalog sync correctness and order-splitting coordination).
  See `docs/PRD.md` §4 for the full reasoning on each.
