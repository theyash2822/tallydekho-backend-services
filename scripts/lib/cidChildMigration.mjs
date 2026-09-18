/**
 * Company Identity — child ownership migration primitives.
 *
 * Shared by the rehearsal script (disposable clones, may reshape backwards) and
 * the operator cutover script (forward only). Keeping one implementation means
 * production runs exactly what was measured.
 *
 * Measured on a 386 MB clone (157k voucher_ledger_entries): the constraint DDL
 * is seconds, the company_id backfill is minutes. So the backfill runs online in
 * batches BEFORE the migration window, and the window only carries DDL.
 */

/**
 * Child tables carrying company ownership, ordered largest-first, with the
 * composite UNIQUE that replaces old company_guid-keyed uniqueness.
 */
export const CHILD_TABLES = [
  { table: 'voucher_ledger_entries', unique: null },
  { table: 'vouchers', unique: ['uq_vouchers_company_id_guid', '(company_id, guid)'] },
  { table: 'stock_transactions', unique: ['uq_stock_tx_company_id_compound', '(company_id, stock_guid, voucher_guid, warehouse, type)'] },
  { table: 'voucher_inventory_items', unique: ['uq_vii_company_id_compound', '(company_id, voucher_guid, stock_item_name, godown_name, batch_name)'] },
  { table: 'batch_allocations', unique: ['uq_ba_company_id_compound', '(company_id, voucher_guid, stock_item_name, batch_name, godown_name)'] },
  { table: 'bill_outstanding', unique: null },
  { table: 'ledgers', unique: ['uq_ledgers_company_id_guid', '(company_id, guid)'] },
  { table: 'stocks', unique: ['uq_stocks_company_id_guid', '(company_id, guid)'] },
  { table: 'gst_voucher_details', unique: ['uq_gvd_company_id_voucher', '(company_id, voucher_guid)'] },
  { table: 'ledger_fy_balances', unique: ['uq_lfb_company_id_name_fy', '(company_id, ledger_name, financial_year)'] },
];

export function createTimer() {
  const timings = [];
  return {
    timings,
    async timed(label, fn) {
      const started = process.hrtime.bigint();
      const result = await fn();
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      timings.push({ label, ms, ...(result && typeof result === 'object' && !Array.isArray(result) ? { rows: result.rowCount } : {}) });
      console.log(`    ${ms.toFixed(0).padStart(7)} ms  ${label}`);
      return result;
    },
    summary() {
      const total = timings.reduce((sum, t) => sum + t.ms, 0);
      return { total, slowest: [...timings].sort((a, b) => b.ms - a.ms).slice(0, 8) };
    },
  };
}

export async function tableExists(client, table) {
  const { rows } = await client.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = $1) AS present`,
    [table]
  );
  return rows[0].present;
}

export async function presentTables(client, tables = CHILD_TABLES, { quiet = false } = {}) {
  const found = [];
  for (const entry of tables) {
    if (await tableExists(client, entry.table)) found.push(entry);
    else if (!quiet) console.log(`  (absent: ${entry.table})`);
  }
  return found;
}

export async function shape(client, table) {
  const { rows } = await client.query(
    `SELECT
       (SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'company_id') AS nullable,
       (SELECT count(*) FROM pg_constraint
         WHERE conrelid = to_regclass($1) AND contype = 'f'
           AND pg_get_constraintdef(oid) ILIKE '%company_id%') AS fks,
       (SELECT count(*) FROM pg_constraint
         WHERE conrelid = to_regclass($1) AND contype = 'u'
           AND pg_get_constraintdef(oid) ILIKE '%company_id%') AS uniques`,
    [table]
  );
  return rows[0];
}

export async function stats(client, table) {
  const { rows } = await client.query(
    `SELECT (SELECT count(*)::bigint FROM ${table}) AS rows,
            pg_size_pretty(pg_total_relation_size(to_regclass($1))) AS size,
            (SELECT count(*)::bigint FROM ${table} WHERE company_id IS NULL) AS null_cid`,
    [table]
  );
  return rows[0];
}

export async function reportShape(client, tables) {
  for (const { table } of tables) {
    const s = await shape(client, table);
    const st = await stats(client, table);
    console.log(
      `  ${table.padEnd(26)} rows=${String(st.rows).padStart(7)} size=${String(st.size).padStart(8)} ` +
        `nullable=${s.nullable} fks=${s.fks} uniques=${s.uniques} null_cid=${st.null_cid}`
    );
  }
}

/**
 * Ownership is resolved workspace-scoped. Resolving by company_guid alone would
 * be wrong under the duplicate-GUID architecture, where one Tally GUID can exist
 * in several workspaces.
 */
function backfillSql(table, hasWorkspaceId) {
  return hasWorkspaceId
    ? `UPDATE ${table} t SET company_id = c.id
         FROM companies c
        WHERE t.company_id IS NULL
          AND c.guid = t.company_guid
          AND (t.workspace_id IS NULL OR c.workspace_id = t.workspace_id)`
    : `UPDATE ${table} t SET company_id = c.id
         FROM companies c
        WHERE t.company_id IS NULL
          AND c.guid = t.company_guid`;
}

/**
 * @param {number} batchSize 0 = one statement; >0 = short statements, safe to
 *   run against a live system before the migration window.
 */
export async function backfill(client, table, batchSize = 0) {
  const { rows: cols } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1
        AND column_name IN ('company_guid','workspace_id')`,
    [table]
  );
  const names = cols.map((c) => c.column_name);
  if (!names.includes('company_guid')) {
    console.log(`    (skip backfill ${table}: no company_guid column)`);
    return { rowCount: 0 };
  }
  const base = backfillSql(table, names.includes('workspace_id'));

  if (!batchSize) {
    const res = await client.query(base);
    return { rowCount: res.rowCount };
  }

  let total = 0;
  let batches = 0;
  for (;;) {
    const res = await client.query(
      `WITH todo AS (
         SELECT ctid FROM ${table} WHERE company_id IS NULL LIMIT ${batchSize}
       )
       ${base} AND t.ctid IN (SELECT ctid FROM todo)`
    );
    total += res.rowCount;
    batches += 1;
    if (res.rowCount === 0) break;
  }
  return { rowCount: total, batches };
}

/** What initSchema does today: correct, but holds ACCESS EXCLUSIVE while scanning. */
export async function migrateNaive(client, { table, unique }, timer) {
  await timer.timed(`${table}: SET NOT NULL (ACCESS EXCLUSIVE, full scan)`, () =>
    client.query(`ALTER TABLE ${table} ALTER COLUMN company_id SET NOT NULL`)
  );
  await timer.timed(`${table}: ADD FOREIGN KEY (validates immediately)`, () =>
    client.query(
      `ALTER TABLE ${table} ADD CONSTRAINT ${table}_company_id_fkey
         FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT`
    )
  );
  if (unique) {
    const [name, cols] = unique;
    await timer.timed(`${table}: ADD UNIQUE ${cols} (index built under lock)`, () =>
      client.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} UNIQUE ${cols}`)
    );
  }
}

/**
 * Same end state, but every scan happens under SHARE UPDATE EXCLUSIVE (reads and
 * writes continue) and only metadata changes take a brief exclusive lock.
 *
 * CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so this must
 * be called outside an explicit transaction.
 */
export async function migrateSafe(client, { table, unique }, timer) {
  const check = `chk_${table}_company_id_nn`;
  await timer.timed(`${table}: ADD CHECK NOT VALID (brief lock)`, () =>
    client.query(
      `ALTER TABLE ${table} ADD CONSTRAINT ${check} CHECK (company_id IS NOT NULL) NOT VALID`
    )
  );
  await timer.timed(`${table}: VALIDATE CHECK (SHARE UPDATE EXCLUSIVE)`, () =>
    client.query(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${check}`)
  );
  // PostgreSQL 12+ uses the validated CHECK as proof, so this skips the scan.
  await timer.timed(`${table}: SET NOT NULL (proven by check, no scan)`, () =>
    client.query(`ALTER TABLE ${table} ALTER COLUMN company_id SET NOT NULL`)
  );
  await timer.timed(`${table}: DROP redundant CHECK`, () =>
    client.query(`ALTER TABLE ${table} DROP CONSTRAINT ${check}`)
  );
  await timer.timed(`${table}: ADD FOREIGN KEY NOT VALID (brief lock)`, () =>
    client.query(
      `ALTER TABLE ${table} ADD CONSTRAINT ${table}_company_id_fkey
         FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT NOT VALID`
    )
  );
  await timer.timed(`${table}: VALIDATE FOREIGN KEY (SHARE UPDATE EXCLUSIVE)`, () =>
    client.query(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${table}_company_id_fkey`)
  );
  if (unique) {
    const [name, cols] = unique;
    await timer.timed(`${table}: CREATE UNIQUE INDEX CONCURRENTLY ${cols}`, () =>
      client.query(`CREATE UNIQUE INDEX CONCURRENTLY ${name}_idx ON ${table} ${cols}`)
    );
    await timer.timed(`${table}: ADD CONSTRAINT USING INDEX (brief lock)`, () =>
      client.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} UNIQUE USING INDEX ${name}_idx`)
    );
  }
}

/** Environment stamp, or 'unstamped' for databases predating the stamp. */
export async function deploymentEnv(client) {
  try {
    const { rows } = await client.query('SELECT app_env FROM deployment_identity WHERE id = 1');
    return rows[0]?.app_env || 'unstamped';
  } catch {
    return 'unstamped';
  }
}

/**
 * Long-running transactions block ALTER TABLE from acquiring its lock, and the
 * operator — not the script — decides what to do about a production session.
 */
export async function reportLockBlockers(client, seconds = 30) {
  const { rows } = await client.query(
    `SELECT pid, state, xact_start, left(coalesce(query,''), 120) AS query
       FROM pg_stat_activity
      WHERE xact_start < now() - ($1 || ' seconds')::interval
        AND pid <> pg_backend_pid()
      ORDER BY xact_start`,
    [String(seconds)]
  );
  if (!rows.length) {
    console.log(`  no transaction older than ${seconds}s`);
    return [];
  }
  console.log(`  ${rows.length} long-running transaction(s) — these can block ALTER TABLE:`);
  for (const r of rows) {
    console.log(`    pid=${r.pid} state=${r.state} since=${new Date(r.xact_start).toISOString()}`);
    console.log(`      ${r.query}`);
  }
  console.log('  NOT terminating anything — resolve with the operator, then retry.');
  return rows;
}
