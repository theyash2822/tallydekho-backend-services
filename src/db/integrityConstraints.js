/**
 * Referential and uniqueness guarantees the code assumed but the database did
 * not enforce.
 *
 * Every statement here is additive and idempotent, so boot convergence can run
 * it and `scripts/schema-integrity-hardening.mjs` can apply the same set to a
 * controlled environment. Keeping one list means the two cannot drift.
 *
 * Delete rules are chosen per relationship rather than uniformly:
 *   RESTRICT  business data — a workspace holding queued writes or a bound
 *             Desktop must be unpaired and drained, never silently erased.
 *   CASCADE   data whose only meaning is the parent — a pairing session or a
 *             practice entry outlives nothing.
 */

/** Foreign keys: [constraint, table, column, references, onDelete] */
export const FOREIGN_KEYS = [
  ['fk_devices_workspace', 'devices', 'workspace_id', 'workspaces (id)', 'RESTRICT'],
  ['fk_write_queue_workspace', 'write_queue', 'workspace_id', 'workspaces (id)', 'RESTRICT'],
  ['fk_write_queue_company', 'write_queue', 'company_id', 'companies (id)', 'RESTRICT'],
  ['fk_demo_entries_workspace', 'demo_simulated_entries', 'workspace_id', 'workspaces (id)', 'CASCADE'],
  ['fk_pairing_sessions_workspace', 'desktop_pairing_sessions', 'workspace_id', 'workspaces (id)', 'CASCADE'],
];

/**
 * Voucher children keyed on (company_id, voucher_guid), which `vouchers`
 * carries as UNIQUE (company_id, guid).
 *
 * Only one child qualifies. A foreign key constrains insert order as well as
 * deletion, and `saveLedgerEntries()` is the sole child writer that runs inside
 * the voucher loop immediately after the parent upsert, in the same
 * transaction. Every other child — voucher_inventory_items, batch_allocations,
 * stock_transactions, gst_voucher_details, bill_outstanding, tax_transactions,
 * voucher_items, voucher_line_taxes, e_invoice_details, e_way_bill_details —
 * is written by a separate dataset handler in ingestProcessor with no ordering
 * guarantee against the vouchers dataset, so a Tally sync that delivered
 * inventory before vouchers would be rejected. All of them currently have zero
 * orphans; the blocker is ordering, not data.
 *
 * RESTRICT rather than CASCADE: purge already deletes children first, so the
 * constraint is a guard against a future purge that forgets one, which is
 * exactly how voucher_line_taxes came to be missing from that list.
 */
export const COMPOSITE_FOREIGN_KEYS = [
  {
    name: 'fk_voucher_ledger_entries_voucher',
    table: 'voucher_ledger_entries',
    columns: 'company_id, voucher_guid',
    references: 'vouchers (company_id, guid)',
    onDelete: 'RESTRICT',
    orphanSql: `SELECT count(*)::int AS n FROM voucher_ledger_entries c
                 WHERE c.company_id IS NOT NULL AND c.voucher_guid IS NOT NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM vouchers v
                      WHERE v.company_id = c.company_id AND v.guid = c.voucher_guid
                   )`,
  },
];

/**
 * Uniqueness the application relied on with SELECT-then-INSERT.
 *
 * A refresh token that hashes to an existing row would authenticate two
 * sessions; a Razorpay order id recorded twice is a payment counted twice.
 * Both are partial so historical NULLs stay legal.
 */
export const UNIQUE_INDEXES = [
  ['uq_auth_sessions_refresh_hash', 'auth_sessions', '(refresh_token_hash)', 'refresh_token_hash IS NOT NULL'],
  ['uq_payment_orders_provider_id', 'billing_payment_orders', '(provider_order_id)', 'provider_order_id IS NOT NULL'],
];

/** Lookup indexes for columns queried on every request but never indexed. */
export const LOOKUP_INDEXES = [
  ['idx_write_queue_workspace', 'write_queue', '(workspace_id)'],
  ['idx_pairing_sessions_workspace', 'desktop_pairing_sessions', '(workspace_id)'],
  ['idx_demo_entries_company', 'demo_simulated_entries', '(company_id)'],
];

/**
 * Indexes made redundant by another index with the same leading column.
 * Postgres can answer from the survivor, so the duplicate is write cost only.
 */
export const REDUNDANT_INDEXES = ['idx_financial_year_summaries_company_id'];

/** Columns the code treats as mandatory. Applied only when no NULL remains. */
export const NOT_NULL_COLUMNS = [
  ['write_queue', 'workspace_id'],
  ['write_queue', 'company_id'],
];

/**
 * Closed status vocabularies, enumerated from the statements that write them
 * and checked against live values before the constraint goes on. A typo in a
 * status is otherwise a silent state a reader never matches.
 *
 * write_queue.status    'pending' is the column default, 'processing' the
 *                       insert, and updateWriteQueue() resolves to exactly
 *                       desktop_offline | failed | success.
 * auth_sessions.status  created ACTIVE, only ever moved to REVOKED.
 * devices.binding_status ACTIVE / RESTORE_PENDING / REVOKED are written;
 *                       UNBOUND is the unpaired state already in the data.
 *
 * Deliberately not constrained: app_vouchers.tally_sync_status and the
 * e_invoice / e_way_bill status columns, whose vocabularies grow with provider
 * states that are not settled yet.
 */
export const STATUS_CHECKS = [
  ['chk_write_queue_status', 'write_queue', 'status',
    ['pending', 'processing', 'desktop_offline', 'failed', 'success']],
  ['chk_auth_sessions_status', 'auth_sessions', 'status',
    ['ACTIVE', 'REVOKED']],
  ['chk_devices_binding_status', 'devices', 'binding_status',
    ['ACTIVE', 'UNBOUND', 'RESTORE_PENDING', 'REVOKED']],
];

/**
 * Apply every statement. `log` receives one line per change or skip so the
 * script can print them and boot can stay quiet.
 */
export async function applyIntegrityConstraints(client, log = () => {}) {
  for (const [name, table, column, references, onDelete] of FOREIGN_KEYS) {
    try {
      const { rows } = await client.query(
        `SELECT 1 FROM pg_constraint WHERE conname = $1`,
        [name]
      );
      if (rows.length) continue;
      await client.query(
        `ALTER TABLE ${table} ADD CONSTRAINT ${name}
           FOREIGN KEY (${column}) REFERENCES ${references} ON DELETE ${onDelete}`
      );
      log(`fk added: ${name} (${table}.${column} → ${references} ON DELETE ${onDelete})`);
    } catch (e) {
      if (e.code !== '42P01') log(`fk skipped: ${name}: ${e.message}`);
    }
  }

  for (const fk of COMPOSITE_FOREIGN_KEYS) {
    try {
      const { rows } = await client.query(
        `SELECT 1 FROM pg_constraint WHERE conname = $1`,
        [fk.name]
      );
      if (rows.length) continue;
      const { rows: orphans } = await client.query(fk.orphanSql);
      if (orphans[0].n > 0) {
        log(`fk skipped: ${fk.name} has ${orphans[0].n} rows with no parent voucher`);
        continue;
      }
      await client.query(
        `ALTER TABLE ${fk.table} ADD CONSTRAINT ${fk.name}
           FOREIGN KEY (${fk.columns}) REFERENCES ${fk.references} ON DELETE ${fk.onDelete}`
      );
      log(`fk added: ${fk.name} (${fk.table} → ${fk.references} ON DELETE ${fk.onDelete})`);
    } catch (e) {
      if (e.code !== '42P01') log(`fk skipped: ${fk.name}: ${e.message}`);
    }
  }

  for (const [name, table, columns, where] of UNIQUE_INDEXES) {
    try {
      if (await indexExists(client, name)) continue;
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON ${table} ${columns} WHERE ${where}`
      );
      log(`unique added: ${name} on ${table} ${columns}`);
    } catch (e) {
      if (e.code !== '42P01') log(`unique skipped: ${name}: ${e.message}`);
    }
  }

  for (const [name, table, columns] of LOOKUP_INDEXES) {
    try {
      if (await indexExists(client, name)) continue;
      await client.query(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} ${columns}`);
      log(`index added: ${name} on ${table} ${columns}`);
    } catch (e) {
      if (e.code !== '42P01') log(`index skipped: ${name}: ${e.message}`);
    }
  }

  for (const name of REDUNDANT_INDEXES) {
    try {
      if (!(await indexExists(client, name))) continue;
      await client.query(`DROP INDEX IF EXISTS ${name}`);
      log(`redundant index dropped: ${name}`);
    } catch (e) {
      log(`redundant index kept: ${name}: ${e.message}`);
    }
  }

  for (const [table, column] of NOT_NULL_COLUMNS) {
    try {
      const { rows: already } = await client.query(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [table, column]
      );
      if (!already.length || already[0].is_nullable === 'NO') continue;
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${column} IS NULL`
      );
      if (rows[0].n > 0) {
        log(`not null skipped: ${table}.${column} still has ${rows[0].n} NULL rows`);
        continue;
      }
      await client.query(`ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL`);
      log(`not null applied: ${table}.${column}`);
    } catch (e) {
      if (e.code !== '42P01') log(`not null skipped: ${table}.${column}: ${e.message}`);
    }
  }

  for (const [name, table, column, values] of STATUS_CHECKS) {
    try {
      const { rows: exists } = await client.query(
        `SELECT 1 FROM pg_constraint WHERE conname = $1`,
        [name]
      );
      if (exists.length) continue;
      const list = values.map((v) => `'${v}'`).join(', ');
      const { rows: unknown } = await client.query(
        `SELECT DISTINCT ${column} AS v FROM ${table}
          WHERE ${column} IS NOT NULL AND ${column} <> ALL($1::text[])`,
        [values]
      );
      if (unknown.length) {
        log(`check skipped: ${table}.${column} holds ${unknown.map((r) => r.v).join(', ')}`);
        continue;
      }
      await client.query(
        `ALTER TABLE ${table} ADD CONSTRAINT ${name}
           CHECK (${column} IS NULL OR ${column} IN (${list}))`
      );
      log(`check added: ${name} on ${table}.${column}`);
    } catch (e) {
      if (e.code !== '42P01') log(`check skipped: ${name}: ${e.message}`);
    }
  }
}

async function indexExists(client, name) {
  const { rows } = await client.query(
    `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
    [name]
  );
  return rows.length > 0;
}
