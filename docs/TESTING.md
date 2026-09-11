# Testing CatalogSync

Same shape as the rest of the portfolio: none of this exists yet, and
neither does the code it would test. This document is the spec for the
test suite to build alongside `docs/CURSOR_CONTEXT.md`'s implementation.
Section numbers here match the references already made in
`docs/ARCHITECTURE.md` and `docs/CURSOR_CONTEXT.md` — don't renumber
without updating both.

This project has two centerpieces, and they get proven first: atomic
stock reservation under real concurrency (§1), and the saga's
compensation logic (§2, §4). Everything else in this document matters,
but those two are what the entire architecture is actually staked on.

## 1. Reservation concurrency — the single most important test in this repo

The direct proof of `docs/ARCHITECTURE.md` §2 and `docs/PRD.md` success
criterion #1. Requires real Postgres — this is not a property a mock can
stand in for.

- **Exact-stock oversell test:** seed a listing with `on_hand_quantity =
  10`, `reserved_quantity = 0`. Fire 50 concurrent
  `ReserveStockCommand` calls, each requesting 1 unit, from genuinely
  concurrent connections (not sequential awaits — real parallel
  requests, e.g. `Promise.all` over 50 independent command dispatches,
  each hitting its own pooled connection). Assert: **exactly 10 succeed,
  exactly 40 fail** with `ErrInsufficientStock`, and the final
  `reserved_quantity` is exactly 10 — never 11 or more, never fewer than
  10 if 10 were actually available.
- **Partial-quantity contention:** seed `on_hand_quantity = 10`. Fire 5
  concurrent requests for 3 units each (15 requested against 10
  available). Assert exactly 3 succeed (using 9 of the 10) and one more
  either succeeds for the remaining 1 unit if it requested ≤1, or fails
  — construct the test to make the exact expected outcome unambiguous
  given the specific quantities requested, and assert that precise
  number, not just "some subset succeeded."
- **Release correctness under the same concurrency:** reserve to
  capacity, then fire concurrent `ReleaseStockCommand` calls for
  overlapping amounts; assert `reserved_quantity` never goes negative
  (the schema's `CHECK` constraint should make this impossible at the
  database level regardless, but assert the application-level affected-
  row-count handling behaves sanely — no unhandled exception, no silent
  double-release) and ends at the mathematically correct value.
- **The regression this test exists to catch:** if `Inventory.reserve()`
  were ever changed from the single conditional `UPDATE` to a
  `SELECT` (check availability) followed by a separate `UPDATE` (apply
  the reservation) — the classic check-then-act race — this test should
  fail by allowing `reserved_quantity` to exceed `on_hand_quantity`
  under load, even though the same code might pass a *sequential*,
  non-concurrent test with no failures at all. Run this test against a
  deliberately-broken check-then-act version once, to see it fail, before
  trusting the real implementation.

## 2. Saga compensation — the second centerpiece

Real Postgres, no mocked reservation logic — this needs to exercise the
actual write path.

- **Multi-vendor success:** a cart spanning 3 vendors, all with
  sufficient stock. Place the order. Assert: `customer_orders.status =
  'CONFIRMED'`, every `vendor_suborders.status = 'RESERVED'`, and each
  vendor's `inventory.reserved_quantity` reflects exactly what that
  vendor's suborder requested — no more, no less.
- **Single-vendor failure triggers full compensation:** the same
  3-vendor cart, but vendor B's listing has insufficient stock. Place
  the order. Assert: vendor B's suborder is `RESERVATION_FAILED`;
  vendor A's and vendor C's suborders — which *did* succeed — end at
  `ROLLED_BACK`, not `RESERVED`; **every vendor's `inventory` ends up
  exactly as it was before the order was attempted** (the direct proof
  of `docs/PRD.md` success criterion #2 — assert this against the raw
  `inventory` rows, not by inferring it from `vendor_suborders.status`
  alone, since the whole point is proving the actual stock numbers are
  correct, not just that the bookkeeping *says* they should be);
  `customer_orders.status = 'FAILED'`.
- **`saga_steps` records the complete, correctly-ordered sequence:** for
  the failure case above, assert the `saga_steps` log contains, in
  order: `RESERVE_ATTEMPTED`/`RESERVE_SUCCEEDED` for vendor A,
  `RESERVE_ATTEMPTED`/`RESERVE_SUCCEEDED` for vendor C (or whatever
  attempt order was used),`RESERVE_ATTEMPTED`/`RESERVE_FAILED` for
  vendor B, then `COMPENSATION_ATTEMPTED`/`COMPENSATION_SUCCEEDED` for
  both A and C. This is what makes the saga's behavior independently
  auditable, not just trusted from final state.
- **Gather-complete-information proof — the direct test of
  `docs/ARCHITECTURE.md` §7:** a cart spanning 3 vendors where **two**
  of them (not just one) have insufficient stock. Assert the saga's
  returned result (and the `saga_steps` log) shows reservation was
  *attempted* against all three vendors, including the second failing
  one — not short-circuited after the first failure was detected. This
  is the test that would fail if a future change added an early-exit
  optimization on the first failure.
- **All-or-nothing is really all-or-nothing:** the two-failures case
  above — assert the one vendor that *did* have sufficient stock is
  still rolled back, not left `RESERVED` as a "partial success." This is
  the direct proof that v1's policy (`docs/PRD.md` §4, §7) is what's
  actually implemented, not accidentally already partial fulfillment.

## 3. Database-role enforcement — proving §4's guarantee is real, not aspirational

Requires connecting directly to Postgres using each role's actual
credentials — not going through the application at all for this test.

- **The read role cannot write, anywhere:** connect using
  `catalogsync_read`'s credentials directly. Attempt an `UPDATE` against
  `catalog_listings_view` (the one table it *can* read); assert it fails
  with a Postgres permission error. Attempt a `SELECT` against
  `inventory` or `product_listings`; assert *that* fails too — this
  role should not even be able to read the write-side tables, let alone
  write to them.
- **The write role cannot read the read model:** connect using
  `catalogsync_write`'s credentials directly. Attempt a `SELECT` against
  `catalog_listings_view`; assert it fails with a permission error —
  this is the direct proof that the write path (and, critically, the
  saga) has no way to accidentally consult the read model even if a
  future code change tried to.
- **The projector role cannot write to write-side tables:** connect
  using `catalogsync_projector`'s credentials. Attempt an `UPDATE`
  against `inventory`; assert it fails. The projector observes; it does
  not mutate the source of truth it's projecting from.
- **The regression this test exists to catch:** if a future migration
  accidentally granted the wrong role too much access (a common,
  easy-to-miss mistake — a broad `GRANT ALL` added during some other,
  unrelated schema change), this is the test that catches it
  immediately, against the real database, rather than relying on
  someone noticing an overly generous `GRANT` statement during code
  review.

## 4. Saga timeout sweep

Real Postgres, with the sweep's interval configured short for test
speed (e.g. a few seconds, via environment override) rather than
production defaults.

- **A crashed saga is caught and compensated:** manually construct the
  state a crashed coordinator would leave behind — a `customer_orders`
  row `PENDING`, one `vendor_suborders` row `RESERVED` (with real
  reservations actually applied to `inventory`), created far enough in
  the past to be past the configured timeout. Run one sweep pass.
  Assert: the reservation is released (`inventory.reserved_quantity`
  decremented back), the suborder moves to `ROLLED_BACK`, the order
  moves to `FAILED`, and a `SWEEP_COMPENSATED` step (distinct from
  `COMPENSATION_SUCCEEDED`) is recorded.
- **The sweep doesn't touch orders that aren't actually stuck:** an
  order `PENDING` for only a few seconds (well within the timeout) is
  left untouched by a sweep pass — the sweep's `WHERE` clause is doing
  the right filtering, not just compensating everything indiscriminately.
- **Idempotent re-sweep:** run the sweep twice in a row against the same
  already-compensated order; assert the second pass is a safe no-op
  (the order is no longer `PENDING`, so it's not selected again) — no
  double-release, no duplicate `SWEEP_COMPENSATED` step.

## 5. Outbox-to-read-model sync

Mirrors SearchCraft's zero-loss reindex test in spirit, applied here to
ordinary catalog sync rather than a full reindex.

- **A write reaches the read model within one poll interval:** create a
  listing via `CreateListingCommand`, confirm the outbox trigger fired
  (a row exists in `outbox_events`), start the projector, and confirm
  `catalog_listings_view` reflects the new listing — correct title,
  price, vendor name (denormalized correctly), category name — within
  one projector poll interval.
- **A stock change updates `available_quantity` correctly:** reserve
  some stock (changing `reserved_quantity`, not `on_hand_quantity`),
  confirm the read model's `available_quantity` reflects the new,
  lower number after the next projector pass.
- **A delete/delist is reflected, not left stale:** delist a listing;
  confirm the read model reflects whichever policy was chosen in
  `docs/CURSOR_CONTEXT.md` §3 (hard delete vs. soft `DELISTED` status) —
  and specifically confirm a *browse* query no longer returns it,
  regardless of which policy was chosen for the underlying row.
- **`last_synced_outbox_id` is accurate:** after a sequence of writes to
  one listing, confirm the read model's `last_synced_outbox_id` matches
  the id of the *last* outbox event actually applied to that row — this
  is what makes "how stale is this specific row" a precise, answerable
  question in production, not a guess.
- **Redis invalidation happens alongside the read-model write:** warm
  the cache for a listing (a read that populates it), then change the
  listing; confirm the corresponding Redis key is gone after the next
  projector pass, and the next read repopulates it with the new data —
  not the stale cached value.

## 6. Price snapshotting

- Place an order for a listing at its current price. Change the
  listing's live price (via `UpdateListingCommand`). Re-fetch the
  original order's `order_line_items`; assert `unit_price_cents` is
  **unchanged** — still the price at the moment of reservation, not the
  new live price.
- Place a *second* order for the same listing, after the price change;
  assert its line items capture the *new* price — proving the snapshot
  happens at each order's own reservation time, not a global "price
  frozen forever" mistake.

## 7. Vendor-scoped write boundaries

- Vendor A's token attempting `UpdateListingCommand` against vendor B's
  listing is rejected with `ErrNotYourListing` — and confirm this is
  enforced by the query's own `WHERE vendor_id = :actorVendorId` (check
  that the underlying SQL actually scopes by vendor, not just that the
  handler happens to check-then-reject after an unscoped read — the
  distinction `docs/CURSOR_CONTEXT.md` §2 calls out explicitly).
- A suspended vendor's token attempting to create a new listing, or
  being selected as part of a new order's vendor group, is rejected —
  but an *already-running* saga involving that vendor (suspended
  mid-saga) is unaffected, per §0's documented decision. Construct this
  exact scenario directly: start a saga, suspend the vendor mid-flight
  (before the sweep or the saga's own completion), confirm the saga
  still resolves normally based on stock alone, not vendor status.

## 8. End-to-end flow test

Drive the full HTTP API as a real client would: create two vendors and
listings for each, place a multi-vendor order via `POST /v1/orders`,
confirm the response reports per-vendor outcomes correctly, browse the
catalog via `GET /v1/catalog` and confirm the reserved stock is
reflected (after allowing one projector interval), and confirm
`GET /health/ready` reports all three database roles and Redis as
healthy throughout.

## Known gaps to plan for once the base suite exists

- No load test characterizing reservation throughput or saga latency
  under realistic concurrent order volume — §1 and §2 prove correctness
  at a fixed, deliberately adversarial N; neither characterizes
  sustained throughput.
- No test yet for the `AdjustStockCommand` absolute-vs-relative
  semantics decision from `docs/CURSOR_CONTEXT.md` §2 — add tests once
  that decision is made and documented, specifically covering the
  concurrency behavior of whichever semantics is chosen.
- No test for Redis being entirely unavailable — the cache-aside layer
  should degrade to querying `catalog_listings_view` directly rather
  than failing the request outright; this fallback behavior needs an
  explicit test once `CatalogCacheService` exists.
- No test for the per-order vendor-count sanity cap
  (`ErrListingsSpanTooManyVendors`) — add once the actual cap value is
  decided in `docs/CURSOR_CONTEXT.md` §6.
