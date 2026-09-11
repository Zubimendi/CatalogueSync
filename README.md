# CatalogSync

A multi-vendor marketplace catalog and inventory engine, built in
NestJS. Week 7, Project 14 of the backend roadmap — the largest project
in the portfolio so far: real CQRS (a write model with correctness
guarantees, a read model with performance guarantees, and a database-
enforced boundary between them), event-driven catalog sync across many
independent vendors, and order-splitting across vendors implemented as a
genuine, if deliberately simplified, saga.

## The problem this exists to solve

"CQRS" is one of the most name-dropped, least actually-implemented
patterns in backend engineering — most systems that claim it are really
"a cache in front of Postgres," where the thing that's supposed to be a
performance-only read path quietly becomes something a checkout flow
reads from to decide whether an item is in stock. The moment that
happens, CQRS's core promise — the read side can be stale, cached,
denormalized, anything, because nothing that requires correctness ever
depends on it — is broken, and overselling becomes a matter of when, not
if.

CatalogSync makes the claim real. The read model — the denormalized,
buyer-facing catalog view — is maintained by an event-driven projector
and served from a Postgres role that has `SELECT`-only access to exactly
one table. It is *structurally incapable* of writing anything, and the
write path's tables are invisible to it entirely, enforced by the
database's own permission system, not a code-review convention. Every
inventory reservation — the one decision in this whole system that
actually has to be correct under concurrency — happens against the
authoritative write-side table via a single atomic conditional update,
never the read model. See `docs/ARCHITECTURE.md` for the full mechanism,
and `docs/RESEARCH.md` for the prior art this design is grounded in.

## What's built (the architecture skeleton)

- **Schema** (`prisma/migrations/0001_init/migration.sql`) — write-side
  tables (`product_listings`, `inventory`), a trigger-enforced outbox
  (the same pattern SearchCraft uses elsewhere in this portfolio,
  applied here to catalog sync across many vendors), a denormalized
  read-model table (`catalog_listings_view`), the ordering/saga tables
  (`customer_orders`, `vendor_suborders`, `order_line_items`,
  `saga_steps`), and **three separate Postgres roles** enforcing the
  read/write/projector boundary at the database permission layer.
- Docker Compose (Postgres + Redis), Dockerfile skeleton, Makefile,
  `package.json`, `.env.example`.
- Full documentation: `docs/PRD.md`, `docs/ARCHITECTURE.md`,
  `docs/RESEARCH.md`, `docs/TESTING.md`, `docs/STORY.md`,
  `docs/CURSOR_CONTEXT.md`.

## Quickstart (once built)

```bash
git clone <your-fork-url> catalogsync && cd catalogsync
cp .env.example .env
npm install      # needs network access
make up            # Postgres + Redis, migrations, and the 3 DB roles
make dev             # API on :3000
make projector        # separate terminal: the outbox → read-model worker
make sweep              # separate terminal: the saga timeout sweep
```

```bash
# Seed a vendor and a couple of listings, then browse the read model
curl localhost:3000/v1/catalog?category=electronics

# Place a cart spanning multiple vendors
curl -X POST localhost:3000/v1/orders \
  -d '{"buyerRef":"buyer-42","items":[{"listingId":"...","quantity":1},{"listingId":"...","quantity":2}]}'
# -> {"orderId": "...", "status": "CONFIRMED", "vendorSuborders": [...]}
```

## Documentation

`docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/RESEARCH.md`,
`docs/TESTING.md`, `docs/STORY.md`, `docs/CURSOR_CONTEXT.md`.

## License

MIT — see `LICENSE`.
