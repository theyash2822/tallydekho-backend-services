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

  for (const [name, table, columns, where] of UNIQUE_INDEXES) {
    try {
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON ${table} ${columns} WHERE ${where}`
      );
      log(`unique ensured: ${name} on ${table} ${columns}`);
    } catch (e) {
      if (e.code !== '42P01') log(`unique skipped: ${name}: ${e.message}`);
    }
  }

  for (const [name, table, columns] of LOOKUP_INDEXES) {
    try {
      await client.query(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} ${columns}`);
      log(`index ensured: ${name} on ${table} ${columns}`);
    } catch (e) {
      if (e.code !== '42P01') log(`index skipped: ${name}: ${e.message}`);
    }
  }

  for (const name of REDUNDANT_INDEXES) {
    try {
      await client.query(`DROP INDEX IF EXISTS ${name}`);
      log(`redundant index dropped: ${name}`);
    } catch (e) {
      log(`redundant index kept: ${name}: ${e.message}`);
    }
  }

  for (const [table, column] of NOT_NULL_COLUMNS) {
    try {
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
}
