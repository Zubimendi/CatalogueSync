# CatalogSync — Product Requirements Document

## 1. Problem

A marketplace with many independent vendors has two problems that look
separate but are actually the same problem wearing two different
outfits: **keeping a fast, unified, browsable catalog in sync with many
vendors' independently-managed inventories**, and **fulfilling an order
that spans more than one vendor without ever overselling anyone's
stock**. Both problems are, at their core, about the gap between "what
the system currently believes is true" and "what's actually true" — and
about which of those two things a given piece of code is allowed to
trust.

Most systems that attempt this either don't separate the two concerns at
all (every browse-page query hits live inventory directly, which doesn't
scale past a small catalog) or separate them nominally — a "read
replica," a cache, something called a "read model" — while quietly
letting the one decision that actually needs to be correct (does this
checkout have enough stock) read from the fast-but-stale side anyway,
because it's more convenient than threading a query through to the
authoritative source. That's not a hypothetical failure mode; it's the
single most common way marketplace inventory systems oversell, and it's
usually discovered by a customer service team fielding "why was my order
cancelled after I paid for it" tickets, not by a code review.

The second half of the problem — a cart spanning multiple vendors — adds
a distributed-systems shape to what might otherwise be a single
database transaction: reserving stock at three different vendors isn't
one atomic operation, because (in any realistic evolution of this
system) those three vendors' inventories don't live in the same
database, can't share a transaction, and can fail independently of each
other. A system that hasn't designed for that from the start either
can't actually support multi-vendor carts correctly, or quietly assumes
a single-database shortcut that breaks the moment vendor data is
actually distributed.

## 2. Goal

Build a **multi-vendor catalog and inventory engine** where:
1. A denormalized, fast, buyer-facing catalog read model is kept in sync
   with every vendor's independent write-side changes via an event-
   driven projector — and the read model is *structurally incapable* of
   being written to by anything else, or of being read by any code path
   that makes a stock-availability decision.
2. Every inventory reservation is atomic under real concurrency, using
   the write-side's authoritative data exclusively — proven under load,
   not just architecturally argued.
3. An order spanning multiple vendors is fulfilled via a genuine saga:
   independent per-vendor reservations, each vendor treated as if it
   were an independently-failing system, with real compensating
   transactions when any vendor can't fulfill their portion.
4. A crashed or interrupted saga doesn't leave inventory silently held
   forever — a timeout-based sweep is the correctness backstop, the same
   "don't trust only the happy path" discipline used throughout this
   portfolio.
5. Every claim this project makes about CQRS, the saga pattern, and the
   outbox pattern is the *real* pattern, provably, not the pattern's name
   attached to a simpler mechanism — see `docs/RESEARCH.md` for the
   specific failure modes this project is designed to avoid.

## 3. Users

- **Vendors**: manage their own product listings and report their own
  stock levels via the write-side API. A vendor's write access is scoped
  to their own listings only (multi-tenant boundary enforced the same
  way as SlotForge/SplitStack elsewhere in this portfolio).
- **Buyers**: browse and search the unified catalog (fast, potentially
  slightly stale), add items from multiple vendors to a single cart, and
  check out — experiencing one order, even though it's fulfilled as
  several independent vendor shipments underneath.
- **The platform itself**: the actual owner of the correctness
  guarantees this project exists to prove — no oversold inventory, no
  silently-abandoned stock holds, and an audit-inspectable saga log for
  every multi-vendor order, successful or not.

## 4. Scope

### In scope (v1)
- Vendor and category management (minimal CRUD — not the focus).
- Write-side product listing and inventory management: create/update/
  delist a listing, adjust on-hand stock. Every write captured by a
  trigger-enforced outbox (`docs/ARCHITECTURE.md` §3).
- A denormalized read model (`catalog_listings_view`), maintained
  exclusively by an outbox-draining projector, served through a
  database role with `SELECT`-only access to that one table and nothing
  else.
- A Redis cache-aside layer in front of the read model's hottest queries
  (category browse, popular listings), invalidated explicitly by the
  projector on every write it applies — never the primary source of
  truth for the read model itself, and never consulted by the
  reservation path under any circumstance.
- Atomic stock reservation via a single conditional update against the
  write-side `inventory` table (`docs/ARCHITECTURE.md` §2).
- Multi-vendor order placement: a `customer_order` decomposed into one
  `vendor_suborder` per vendor represented in the cart, each reserved
  independently, with compensating releases on any failure — an
  all-or-nothing policy for v1 (see §7's named risk).
- A saga timeout sweep catching orders left in an inconsistent state by
  a crashed or interrupted saga coordinator.
- Price snapshotting: an order's line items record the listing's price
  at order time, never re-derived from the live listing afterward.
- A complete, inspectable saga execution log (`saga_steps`) for every
  order, successful or failed.
- Lightweight, stateless actor/vendor identity tokens — the same
  deliberately minimal posture as Switchboard, FormFlow, and Tribunal
  elsewhere in this portfolio; real auth is AuthNexus's job, not this
  project's.

### Explicitly out of scope (v1), and why
- **Full-text/relevance search.** The read model supports category and
  price-range filtering with proper indexes — it does not rebuild
  SearchCraft's Meilisearch-backed relevance search engine, an earlier
  project in this portfolio built specifically to solve that problem
  well. A future integration could have this project's outbox events
  also feed SearchCraft's index; v1 doesn't build that integration, and
  says so rather than silently duplicating SearchCraft's actual job.
- **Durable, crash-recoverable saga orchestration** (a saga that resumes
  exactly where a crashed coordinator left off, with per-step retry and
  backoff policies). v1's saga is real but simplified — a timeout sweep
  is the correctness backstop for a crashed coordinator, not a resumable
  log. The roadmap's week 15 capstone is explicitly scoped to build the
  fuller version of this; duplicating it here would undercut that
  project's own reason to exist.
- **Partial order fulfillment.** v1 is all-or-nothing: if any vendor in
  a multi-vendor cart can't fulfill their portion, the entire order is
  compensated and fails. Partial fulfillment (ship what's available,
  handle the rest separately) is real, valid, and meaningfully more
  complex — named explicitly as a v1 cut, not an oversight (see §7).
- **Payment processing.** Orders track reservation and fulfillment
  state; there is no payment gateway integration. A `total_cents` field
  exists for display and record-keeping; nothing here actually charges
  anyone.
- **Vendor payout/settlement.** A real marketplace's second half (how
  and when vendors actually get paid) is a distinct financial-systems
  problem, genuinely out of scope for a project about catalog sync and
  order splitting specifically.
- **Multi-warehouse/multi-location inventory per vendor.** v1 tracks one
  stock count per listing, not per-location stock a vendor might split
  across multiple warehouses.

## 5. Success criteria

1. Firing many concurrent reservation attempts against a listing with
   limited stock never results in `reserved_quantity` exceeding
   `on_hand_quantity` — proven under real concurrent load, with the
   exact number of successful reservations matching the exact available
   stock, no more, no fewer.
2. A multi-vendor order where one vendor's portion cannot be reserved
   results in every *other* vendor's already-successful reservation
   being released — inventory across every vendor involved ends up
   exactly as if the order had never been attempted, and this is proven
   by the write-side state, not inferred from the saga log alone.
3. A read-only query against `catalog_listings_view` using the
   `catalogsync_read` database role, attempting to write anything at
   all (an `UPDATE`, an `INSERT`, a `DELETE`, against any table), fails
   with a Postgres permission error — proven directly against the
   database, not assumed from the `GRANT` statements in the migration.
4. A simulated crashed saga (some vendor suborders `RESERVED`, the
   overall order stuck `PENDING` past the timeout window, no further
   progress) is caught and fully compensated by the timeout sweep within
   one sweep interval of the timeout elapsing — inventory is released,
   the order reaches a terminal `FAILED` state, with no manual
   intervention required.
5. Changing a listing's live price after an order has been placed
   against it has zero effect on that order's already-recorded
   `unit_price_cents` — proven by changing the price and re-reading the
   existing order's line items.
6. A write directly to `product_listings` or `inventory` (via any code
   path, including a raw `UPDATE` run by an operator) results in a
   corresponding `outbox_events` row in the same transaction, and that
   event is reflected in `catalog_listings_view` within one projector
   poll interval — proven end-to-end, the same class of proof as
   SearchCraft's zero-loss reindex test, applied here to ordinary
   catalog sync rather than a full reindex.

## 6. Non-functional requirements

- **Correctness of the read/write boundary, the reservation mechanism,
  and the saga's compensation logic is the whole point** — this project
  exists to make "real CQRS" and "a real saga" true claims, provably, not
  to maximize catalog browsing throughput or build a full marketplace
  product.
- **The read/write boundary must be enforced at the database permission
  layer, not only by code organization.** This is the single most
  important non-functional requirement in this document — see
  `docs/ARCHITECTURE.md` §4.
- **Zero paid dependencies.** PostgreSQL + Redis via Docker Compose.
- **The saga must be designed as if every vendor's inventory were an
  independently-failing system**, even though v1's actual deployment
  keeps everything in one Postgres instance — see
  `docs/ARCHITECTURE.md` §5 for why this constraint is imposed
  deliberately rather than relaxed for convenience.

## 7. Risks / open questions

- **All-or-nothing order fulfillment is a real product trade-off, not a
  technical inevitability.** A buyer whose cart includes one out-of-
  stock item from one vendor currently loses the *entire* order,
  including the parts every other vendor could have fulfilled. This is
  named explicitly, with the reasoning for choosing it as a first
  implementation (`docs/ARCHITECTURE.md` §7) rather than presented as
  the only reasonable design — partial fulfillment is the natural next
  extension, and is real, additional complexity (partial refunds, a
  buyer confirmation step for a reduced order), not a small tweak.
- **The saga timeout sweep is a correctness backstop, not a performance
  guarantee.** A crashed saga's reservations remain held (and therefore
  unavailable to other buyers) for up to one full timeout window before
  the sweep releases them — a real, bounded but nonzero cost, the same
  trade-off SlotForge's cron backstop and Switchboard's presence TTL
  both accept elsewhere in this portfolio.
- **Database-role-based read/write separation is a strong guarantee
  against application bugs, not against a compromised database
  credential itself.** Someone with the `catalogsync_write` role's
  actual password can, definitionally, do anything that role is granted
  — the separation protects against *accidental* cross-boundary access
  from the wrong part of the application, not against credential
  compromise, which is a different threat model with a different set of
  mitigations (credential rotation, network-level access control)
  outside this project's scope.
- **Redis cache staleness on top of an already-eventually-consistent
  read model compounds the staleness window** — a buyer could see data
  that's stale by (projector lag) + (Redis TTL or invalidation lag)
  combined. Both windows are individually small and explicitly bounded,
  but the combined worst case is worth naming rather than assuming away.
- **What happens when a vendor is suspended mid-saga** (their suborder
  is `PENDING_RESERVATION` when `vendors.status` flips to `SUSPENDED`)
  is genuinely undecided in this document — flagged for
  `docs/CURSOR_CONTEXT.md` to make an explicit call on, with reasoning,
  rather than leaving the behavior to whatever the code happens to do.
