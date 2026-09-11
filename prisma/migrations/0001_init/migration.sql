-- 0001_init/migration.sql
-- Schema only — see docs/CURSOR_CONTEXT.md for the NestJS code that
-- reads and writes these tables, none of which exists yet.
--
-- This migration does five things, in order: (1) write-side tables —
-- the authoritative source of truth for vendor listings and inventory;
-- (2) the trigger-enforced outbox, same pattern as SearchCraft
-- elsewhere in this portfolio, applied here to catalog sync across many
-- vendors instead of search-index sync; (3) the denormalized read
-- model the outbox projector maintains; (4) ordering/saga tables; and
-- (5) three separate Postgres roles enforcing, at the database
-- permission level, that the read path can never write and the write
-- path's tables can never be touched by the read connection pool — see
-- docs/ARCHITECTURE.md §4 for why this is a database-enforced
-- guarantee, not a code-organization convention.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- 1. WRITE SIDE — authoritative source of truth
-- ============================================================

CREATE TABLE vendors (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL UNIQUE,
    status     TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | SUSPENDED
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE categories (
    id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE
);

CREATE TABLE product_listings (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id   UUID NOT NULL REFERENCES vendors(id),
    category_id UUID NOT NULL REFERENCES categories(id),
    sku         TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price_cents BIGINT NOT NULL CHECK (price_cents >= 0),
    currency    TEXT NOT NULL DEFAULT 'USD',
    status      TEXT NOT NULL DEFAULT 'DRAFT',  -- DRAFT | ACTIVE | DELISTED
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (vendor_id, sku)
);

CREATE INDEX idx_product_listings_vendor ON product_listings (vendor_id);
CREATE INDEX idx_product_listings_category ON product_listings (category_id);

CREATE TABLE inventory (
    listing_id        UUID PRIMARY KEY REFERENCES product_listings(id) ON DELETE CASCADE,
    -- Total physical stock the vendor reports. `available` is never
    -- stored directly — it's always (on_hand - reserved), computed at
    -- read time, so there is exactly one place either number can drift:
    -- nowhere, because there's only one number for each, not two kept
    -- in sync by convention.
    on_hand_quantity  INT NOT NULL DEFAULT 0 CHECK (on_hand_quantity >= 0),
    -- Held for orders that have reserved but not yet been fulfilled or
    -- released — see docs/ARCHITECTURE.md §2 for the exact CAS update
    -- this column is designed around.
    reserved_quantity INT NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (reserved_quantity <= on_hand_quantity)
);

-- ============================================================
-- 2. THE TRIGGER-ENFORCED OUTBOX — same pattern as SearchCraft,
--    applied here to catalog sync across many vendors
-- ============================================================

CREATE TABLE outbox_events (
    id           BIGSERIAL PRIMARY KEY,
    entity_type  TEXT NOT NULL,   -- 'product_listing' | 'inventory'
    entity_id    UUID NOT NULL,
    vendor_id    UUID,            -- denormalized onto the event for fast per-vendor debugging/filtering
    operation    TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
    payload      JSONB NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ,
    attempts     INT NOT NULL DEFAULT 0,
    last_error   TEXT
);

CREATE INDEX idx_outbox_unprocessed ON outbox_events (id) WHERE processed_at IS NULL;

CREATE OR REPLACE FUNCTION product_listings_outbox_trigger() RETURNS TRIGGER AS $$
DECLARE
    v_row RECORD;
BEGIN
    v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    INSERT INTO outbox_events (entity_type, entity_id, vendor_id, operation, payload)
    VALUES ('product_listing', v_row.id, v_row.vendor_id, TG_OP, to_jsonb(v_row));
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_product_listings_outbox
    AFTER INSERT OR UPDATE OR DELETE ON product_listings
    FOR EACH ROW EXECUTE FUNCTION product_listings_outbox_trigger();

CREATE OR REPLACE FUNCTION inventory_outbox_trigger() RETURNS TRIGGER AS $$
DECLARE
    v_row RECORD;
    v_vendor_id UUID;
BEGIN
    v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    SELECT vendor_id INTO v_vendor_id FROM product_listings WHERE id = v_row.listing_id;
    INSERT INTO outbox_events (entity_type, entity_id, vendor_id, operation, payload)
    VALUES ('inventory', v_row.listing_id, v_vendor_id, TG_OP, to_jsonb(v_row));
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_inventory_outbox
    AFTER INSERT OR UPDATE OR DELETE ON inventory
    FOR EACH ROW EXECUTE FUNCTION inventory_outbox_trigger();

-- ============================================================
-- 3. READ SIDE — the denormalized catalog view. Written EXCLUSIVELY
--    by the outbox projector. Never written by any command handler,
--    the ordering saga, or anything else — see docs/ARCHITECTURE.md §1.
-- ============================================================

CREATE TABLE catalog_listings_view (
    listing_id           UUID PRIMARY KEY,
    vendor_id            UUID NOT NULL,
    vendor_name          TEXT NOT NULL,
    vendor_status        TEXT NOT NULL,
    category_id          UUID NOT NULL,
    category_name        TEXT NOT NULL,
    title                TEXT NOT NULL,
    description          TEXT NOT NULL,
    price_cents          BIGINT NOT NULL,
    currency             TEXT NOT NULL,
    status               TEXT NOT NULL,
    -- A projected snapshot for DISPLAY ONLY. Eventually consistent by
    -- design — never read by the reservation path. See
    -- docs/ARCHITECTURE.md §1 and §2.
    available_quantity   INT NOT NULL,
    -- The highest outbox_events.id this row reflects — lets an
    -- operator (or a test) answer "how stale is this row, in outbox
    -- events" precisely, not just "recently-ish."
    last_synced_outbox_id BIGINT NOT NULL,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_catalog_view_category ON catalog_listings_view (category_id) WHERE status = 'ACTIVE';
CREATE INDEX idx_catalog_view_vendor ON catalog_listings_view (vendor_id);
CREATE INDEX idx_catalog_view_price ON catalog_listings_view (price_cents);

-- ============================================================
-- 4. ORDERING AND THE SIMPLIFIED SAGA
-- ============================================================

CREATE TABLE customer_orders (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_ref   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | CONFIRMED | FAILED | CANCELLED
    total_cents BIGINT NOT NULL DEFAULT 0,
    currency    TEXT NOT NULL DEFAULT 'USD',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The saga's per-vendor unit of work. Modeled and coordinated as if
-- each vendor's inventory lived in a genuinely separate database, even
-- though v1 happens to run every vendor's data in one physical
-- Postgres instance — see docs/ARCHITECTURE.md §5 for why that's a
-- deliberate choice, not an oversight.
CREATE TABLE vendor_suborders (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_order_id UUID NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
    vendor_id         UUID NOT NULL REFERENCES vendors(id),
    status            TEXT NOT NULL DEFAULT 'PENDING_RESERVATION',
        -- PENDING_RESERVATION | RESERVED | RESERVATION_FAILED | ROLLED_BACK | FULFILLED | CANCELLED
    subtotal_cents    BIGINT NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (customer_order_id, vendor_id)
);

CREATE INDEX idx_vendor_suborders_order ON vendor_suborders (customer_order_id);
-- The saga timeout sweep's exact query shape: PENDING orders whose
-- suborders haven't all resolved past a timeout window.
CREATE INDEX idx_vendor_suborders_pending ON vendor_suborders (customer_order_id) WHERE status = 'PENDING_RESERVATION';

CREATE TABLE order_line_items (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_suborder_id UUID NOT NULL REFERENCES vendor_suborders(id) ON DELETE CASCADE,
    listing_id        UUID NOT NULL REFERENCES product_listings(id),
    quantity          INT NOT NULL CHECK (quantity > 0),
    -- Snapshotted at order time, never re-read from the live listing
    -- price afterward — the same "pin state at the moment it mattered"
    -- discipline as FormFlow's version pinning and Tribunal's workflow
    -- version pinning, applied here to price instead of a rule set.
    unit_price_cents  BIGINT NOT NULL CHECK (unit_price_cents >= 0),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_order_line_items_suborder ON order_line_items (vendor_suborder_id);

-- The saga's explicit execution log — every attempted reservation,
-- success, failure, and compensation, in order. This is what makes the
-- saga's behavior inspectable and testable directly, not just inferred
-- from the final state of vendor_suborders.
CREATE TABLE saga_steps (
    id                 BIGSERIAL PRIMARY KEY,
    customer_order_id  UUID NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
    vendor_suborder_id UUID REFERENCES vendor_suborders(id),
    step_type          TEXT NOT NULL,
        -- RESERVE_ATTEMPTED | RESERVE_SUCCEEDED | RESERVE_FAILED |
        -- COMPENSATION_ATTEMPTED | COMPENSATION_SUCCEEDED | SWEEP_COMPENSATED
    detail             JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_saga_steps_order ON saga_steps (customer_order_id, occurred_at);

-- ============================================================
-- 5. THREE-ROLE DATABASE ACCESS SEPARATION — the second centerpiece.
--    Passwords here are local-dev placeholders; see .env.example.
--    See docs/ARCHITECTURE.md §4 for the full reasoning.
-- ============================================================

-- The write-side application pool: full DML on every write-side table,
-- INSERT/SELECT on outbox_events for observability, but explicitly NO
-- grants at all on catalog_listings_view — the write path has no way
-- to accidentally query the read model even if a future bug tried.
CREATE ROLE catalogsync_write LOGIN PASSWORD 'catalogsync_write_dev_password';
GRANT SELECT, INSERT, UPDATE, DELETE ON
    vendors, categories, product_listings, inventory,
    customer_orders, vendor_suborders, order_line_items, saga_steps
    TO catalogsync_write;
GRANT SELECT ON outbox_events TO catalogsync_write;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO catalogsync_write;

-- The read-side application pool: SELECT only, and only on the
-- denormalized view — this role cannot see product_listings, inventory,
-- customer_orders, or anything else, even for a read. A bug that tried
-- to make the browse/search path check live inventory for a stocking
-- decision would fail at the database permission layer, not just get
-- caught in code review.
CREATE ROLE catalogsync_read LOGIN PASSWORD 'catalogsync_read_dev_password';
GRANT SELECT ON catalog_listings_view TO catalogsync_read;

-- The projector's pool: the only role that can both read write-side
-- state (to build a denormalized row) and write the read model. It
-- cannot write to any write-side table — it observes, it never
-- mutates the source of truth.
CREATE ROLE catalogsync_projector LOGIN PASSWORD 'catalogsync_projector_dev_password';
GRANT SELECT ON vendors, categories, product_listings, inventory TO catalogsync_projector;
GRANT SELECT, UPDATE ON outbox_events TO catalogsync_projector;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog_listings_view TO catalogsync_projector;
