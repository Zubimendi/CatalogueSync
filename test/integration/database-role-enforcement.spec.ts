import { Client } from 'pg';

describe('Database Role Enforcement (Test §3)', () => {
  const writeUrl =
    process.env.DATABASE_URL_WRITE ||
    'postgres://catalogsync_write:catalogsync_write_dev_password@localhost:5432/catalogsync';

  const readUrl =
    process.env.DATABASE_URL_READ ||
    'postgres://catalogsync_read:catalogsync_read_dev_password@localhost:5432/catalogsync';

  const projectorUrl =
    process.env.DATABASE_URL_PROJECTOR ||
    'postgres://catalogsync_projector:catalogsync_projector_dev_password@localhost:5432/catalogsync';

  it('The read role cannot write anywhere, nor read write-side tables', async () => {
    const client = new Client({ connectionString: readUrl });
    await client.connect();

    try {
      // 1. catalogsync_read cannot UPDATE catalog_listings_view
      let updateError: any;
      try {
        await client.query(
          "UPDATE catalog_listings_view SET title = 'Hacked' WHERE listing_id = '00000000-0000-0000-0000-000000000000'::uuid;",
        );
      } catch (err) {
        updateError = err;
      }
      expect(updateError).toBeDefined();
      expect(updateError.code).toBe('42501'); // 42501 = insufficient_privilege

      // 2. catalogsync_read cannot SELECT from write-side inventory
      let selectInvError: any;
      try {
        await client.query('SELECT * FROM inventory LIMIT 1;');
      } catch (err) {
        selectInvError = err;
      }
      expect(selectInvError).toBeDefined();
      expect(selectInvError.code).toBe('42501');

      // 3. catalogsync_read cannot SELECT from write-side product_listings
      let selectListingsError: any;
      try {
        await client.query('SELECT * FROM product_listings LIMIT 1;');
      } catch (err) {
        selectListingsError = err;
      }
      expect(selectListingsError).toBeDefined();
      expect(selectListingsError.code).toBe('42501');

      // 4. catalogsync_read CAN SELECT from catalog_listings_view
      const res = await client.query('SELECT count(*) FROM catalog_listings_view;');
      expect(res.rows).toBeDefined();
    } finally {
      await client.end();
    }
  });

  it('The write role cannot read the read model (catalog_listings_view)', async () => {
    const client = new Client({ connectionString: writeUrl });
    await client.connect();

    try {
      // catalogsync_write cannot SELECT from catalog_listings_view
      let selectViewError: any;
      try {
        await client.query('SELECT * FROM catalog_listings_view LIMIT 1;');
      } catch (err) {
        selectViewError = err;
      }
      expect(selectViewError).toBeDefined();
      expect(selectViewError.code).toBe('42501'); // insufficient_privilege

      // catalogsync_write CAN SELECT from write tables
      const res = await client.query('SELECT count(*) FROM product_listings;');
      expect(res.rows).toBeDefined();
    } finally {
      await client.end();
    }
  });

  it('The projector role cannot mutate write-side tables (inventory)', async () => {
    const client = new Client({ connectionString: projectorUrl });
    await client.connect();

    try {
      // catalogsync_projector cannot UPDATE inventory
      let updateInvError: any;
      try {
        await client.query(
          "UPDATE inventory SET on_hand_quantity = 999 WHERE listing_id = '00000000-0000-0000-0000-000000000000'::uuid;",
        );
      } catch (err) {
        updateInvError = err;
      }
      expect(updateInvError).toBeDefined();
      expect(updateInvError.code).toBe('42501'); // insufficient_privilege

      // catalogsync_projector CAN SELECT from inventory to compute denormalized values
      const res = await client.query('SELECT count(*) FROM inventory;');
      expect(res.rows).toBeDefined();
    } finally {
      await client.end();
    }
  });
});
