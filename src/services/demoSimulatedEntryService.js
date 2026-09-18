/**
 * Private simulated Demo entries.
 *
 * Demo is one shared, immutable fixture — the known-good accounting baseline
 * everything else is measured against. A user practising data entry must not be
 * able to move those numbers, but they still need the real forms to do anything
 * useful. These rows are the difference: private to their author, visible in My
 * Entries, and invisible to the accounting tables.
 *
 * What they deliberately never touch:
 *   - vouchers / ledgers / stocks, so reports stay deterministic
 *   - write_queue, so the Desktop has nothing to claim
 *   - billing, because nothing here reaches a metered path
 *
 * The last two hold structurally rather than by policy: the Desktop reads
 * write_queue and this is not write_queue, and no billing code reads this table.
 */
import { query } from '../db/schema.js';

const now = () => Math.floor(Date.now() / 1000);

export const DEMO_ENTRY_STATUS = 'DEMO_SIMULATED';

/** Entry kinds the Demo forms can produce. Anything else is rejected. */
export const DEMO_ENTRY_TYPES = new Set([
  'sales_invoice',
  'purchase_invoice',
  'payment',
  'receipt',
  'journal',
  'contra',
  'credit_note',
  'debit_note',
  'ledger',
  'stock_item',
]);

function summarise(entryType, payload) {
  const p = payload || {};
  const party = p.partyName || p.party || p.name || null;
  if (party) return `${entryType.replace(/_/g, ' ')} — ${party}`;
  return entryType.replace(/_/g, ' ');
}

/**
 * Record one simulated entry.
 *
 * `companyId` is stored for context only. It is nullable and is never used to
 * grant access: ownership is the user, always.
 */
export async function createDemoEntry({ userId, workspaceId, companyId = null, entryType, payload = {} }) {
  if (!userId) throw Object.assign(new Error('userId required'), { httpStatus: 401 });
  if (!workspaceId) throw Object.assign(new Error('workspaceId required'), { httpStatus: 400 });
  if (!DEMO_ENTRY_TYPES.has(String(entryType))) {
    throw Object.assign(new Error(`Unsupported demo entry type: ${entryType}`), { httpStatus: 400 });
  }

  const amountRaw = payload?.total ?? payload?.amount ?? null;
  const amount = amountRaw == null || Number.isNaN(Number(amountRaw)) ? null : Number(amountRaw);
  const entryDate = typeof payload?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(payload.date)
    ? payload.date
    : null;
  const ts = now();

  const { rows } = await query(
    `INSERT INTO demo_simulated_entries
       (user_id, workspace_id, company_id, entry_type, title, amount, entry_date, payload, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$10)
     RETURNING *`,
    [
      userId, workspaceId, companyId, entryType,
      summarise(entryType, payload), amount, entryDate,
      JSON.stringify(payload || {}), DEMO_ENTRY_STATUS, ts,
    ]
  );
  return rows[0];
}

/**
 * List the caller's own simulated entries.
 *
 * Scoped by user_id in the statement itself. There is no code path that reads
 * another user's rows, so an attacker changing an id in a request has nothing to
 * reach.
 */
export async function listDemoEntries({ userId, workspaceId = null, limit = 100 }) {
  if (!userId) return [];
  const params = [userId];
  let where = 'user_id = $1';
  if (workspaceId) {
    params.push(workspaceId);
    where += ` AND workspace_id = $${params.length}`;
  }
  params.push(Math.min(Number(limit) || 100, 500));
  const { rows } = await query(
    `SELECT id, user_id, workspace_id, company_id, entry_type, title, amount,
            entry_date, payload, status, created_at, updated_at
       FROM demo_simulated_entries
      WHERE ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params
  );
  return rows;
}

/** Delete one of the caller's own entries. The user_id predicate is the guard. */
export async function deleteDemoEntry({ userId, entryId }) {
  if (!userId || !entryId) return false;
  const { rowCount } = await query(
    `DELETE FROM demo_simulated_entries WHERE id = $1 AND user_id = $2`,
    [entryId, userId]
  );
  return rowCount > 0;
}

/** Clear the caller's own entries, so a tester can reset without help. */
export async function clearDemoEntries({ userId, workspaceId = null }) {
  if (!userId) return 0;
  const params = [userId];
  let where = 'user_id = $1';
  if (workspaceId) {
    params.push(workspaceId);
    where += ` AND workspace_id = $${params.length}`;
  }
  const { rowCount } = await query(`DELETE FROM demo_simulated_entries WHERE ${where}`, params);
  return rowCount;
}

/** Shape for My Entries, alongside real rows. Never claims a Tally posting. */
export function toMyEntriesRow(row) {
  return {
    id: `demo-${row.id}`,
    source: 'DEMO_SIMULATED',
    _queue_status: DEMO_ENTRY_STATUS,
    entry_type: row.entry_type,
    title: row.title,
    amount: row.amount == null ? null : Number(row.amount),
    date: row.entry_date,
    workspace_id: row.workspace_id,
    created_at: row.created_at,
    // Explicitly not a Tally state. My Entries must not render "Posted to Tally"
    // for something that was never sent anywhere.
    tally_voucher_number: null,
    posted_to_tally: false,
  };
}
