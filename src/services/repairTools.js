/**
 * Historical-damage diagnostics and scoped repairs (TD-FIX-2026-10-08 P7, audit I.1–I.8).
 *
 * Preview is the default and read-only. Applying needs the sha256 of the exact
 * manifest that was previewed; the state is re-diagnosed first and any change
 * refuses the run (REPAIR_STATE_CHANGED). Nothing here runs from app startup,
 * schedulers or tests against a real database.
 *
 * Classification (plan §9.2): every candidate is `suspected` or `unverifiable`
 * unless a check is decisive on its own (`confirmed`). Repairs never write guessed
 * values: damaged Tally data is re-fetched from Tally by resetting the voucher
 * watermark of the affected financial year; the next normal sync rewrites it.
 */
import crypto from 'node:crypto';

export const REPAIR_ITEMS = ['I.1', 'I.2', 'I.3', 'I.4', 'I.5', 'I.6', 'I.7', 'I.8'];
const STALE_RUN_SECONDS = 24 * 60 * 60;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function manifestHash(manifest) {
  return crypto.createHash('sha256').update(canonical(manifest)).digest('hex');
}

function repairError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function resolveScope(q, { workspaceId, companyId }) {
  if (!workspaceId || !companyId) throw repairError('REPAIR_SCOPE_REQUIRED', 'workspaceId and companyId are required');
  const { rows } = await q(
    `SELECT id, guid, name, workspace_id FROM companies WHERE id = $1 AND workspace_id = $2`,
    [companyId, workspaceId]
  );
  if (!rows[0]) throw repairError('REPAIR_SCOPE_INVALID', 'Company is not in this workspace');
  return { workspaceId, companyId: Number(rows[0].id), companyGuid: rows[0].guid };
}

async function diagnoseI1(q, s) {
  const vouchers = await q(
    `SELECT financial_year, COUNT(*)::int AS n FROM vouchers
      WHERE company_id = $1 AND voucher_number ~ '^[0-9]+$' GROUP BY financial_year ORDER BY financial_year`,
    [s.companyId]
  );
  const hsn = await q(
    `SELECT COUNT(*)::int AS n FROM stocks
      WHERE company_id = $1 AND hsn ~ '^[0-9]+$' AND length(hsn) NOT IN (2, 4, 6, 8)`,
    [s.companyId]
  );
  const phones = await q(
    `SELECT COUNT(*)::int AS n FROM ledgers
      WHERE company_id = $1 AND (phone ~ '^[1-9][0-9]{8}$' OR mobile ~ '^[1-9][0-9]{8}$')`,
    [s.companyId]
  );
  return {
    classification: 'suspected',
    note: 'Numeric-only voucher numbers can be valid; only a fresh Tally fetch confirms. Stocks heal on the next sync.',
    counts: {
      numericVoucherNumbersByFy: vouchers.rows,
      hsnOddLength: hsn.rows[0].n,
      ledgerNumbersShort: phones.rows[0].n,
    },
    refetchYears: vouchers.rows.map((r) => r.financial_year).filter(Boolean),
  };
}

async function diagnoseI2(q, s) {
  const { rows } = await q(
    `SELECT v.financial_year, COUNT(*)::int AS n FROM vouchers v
      WHERE v.company_id = $1
        AND (v.raw_data ILIKE '%INVENTORYENTRIES%' OR v.raw_data ILIKE '%inventoryEntries%')
        AND NOT EXISTS (
          SELECT 1 FROM voucher_items vi
           WHERE vi.company_id = v.company_id AND vi.voucher_guid = v.guid AND vi.item_name IS NOT NULL
        )
      GROUP BY v.financial_year ORDER BY v.financial_year`,
    [s.companyId]
  );
  return {
    classification: 'suspected',
    note: 'raw_data may itself be a stub (audit), so absence of inventory markers proves nothing.',
    counts: { vouchersMissingItemsByFy: rows },
    refetchYears: rows.map((r) => r.financial_year).filter(Boolean),
  };
}

async function diagnoseI3(q, s) {
  const pattern = '&#[0-9]+;';
  const v = await q(
    `SELECT financial_year, COUNT(*)::int AS n FROM vouchers
      WHERE company_id = $1 AND (party_name ~ $2 OR narration ~ $2 OR reference ~ $2)
      GROUP BY financial_year ORDER BY financial_year`,
    [s.companyId, pattern]
  );
  const masters = await q(
    `SELECT (SELECT COUNT(*)::int FROM ledgers WHERE company_id = $1 AND (name ~ $2 OR address ~ $2)) AS ledgers,
            (SELECT COUNT(*)::int FROM stocks WHERE company_id = $1 AND (name ~ $2 OR description ~ $2)) AS stocks`,
    [s.companyId, pattern]
  );
  return {
    classification: 'suspected',
    note: 'Entity-like text can be intentional; never decoded in place. Masters are rewritten by the next full master sync.',
    counts: { vouchersWithEntitiesByFy: v.rows, ...masters.rows[0] },
    refetchYears: v.rows.map((r) => r.financial_year).filter(Boolean),
  };
}

async function diagnoseI4(q, s) {
  const { rows } = await q(
    `SELECT financial_year, COUNT(*)::int AS n FROM ledger_fy_balances WHERE company_id = $1
      GROUP BY financial_year ORDER BY financial_year`,
    [s.companyId]
  );
  return {
    classification: 'unverifiable',
    note: 'Balances can only be judged against a fresh Tally fetch. Owner operation: hard sync of the company for the affected years.',
    counts: { ledgerFyBalanceRowsByFy: rows },
    ownerOperation: 'HARD_SYNC_COMPANY',
  };
}

async function diagnoseI5(q, s) {
  const { rows } = await q(
    `SELECT COUNT(*)::int AS n FROM hard_sync_jobs WHERE company_id = $1 AND status = 'published'`,
    [s.companyId]
  );
  return {
    classification: 'unverifiable',
    note: 'Ghost vouchers/masters are only identifiable from a complete, context-correct Tally inventory (P4 hard sync).',
    counts: { publishedHardSyncs: rows[0].n },
    ownerOperation: rows[0].n ? null : 'HARD_SYNC_COMPANY',
  };
}

async function diagnoseI6(q, s) {
  const empty = await q(
    `SELECT (SELECT COUNT(*)::int FROM vouchers WHERE company_id = $1) AS vouchers,
            (SELECT COUNT(*)::int FROM hard_sync_requests r
              WHERE r.workspace_id = $2 AND r.status IN ('EXECUTED','CONSUMED')) AS executed_requests`,
    [s.companyId, s.workspaceId]
  );
  const irn = await q(
    `SELECT COUNT(*)::int AS n FROM vouchers v
      WHERE v.company_id = $1 AND v.irn IS NOT NULL AND v.irn <> ''
        AND NOT EXISTS (SELECT 1 FROM e_invoice_details e WHERE e.company_id = v.company_id AND e.voucher_guid = v.guid)`,
    [s.companyId]
  );
  const e = empty.rows[0];
  return {
    classification: 'suspected',
    note: 'An empty company is not proof of a failed hard sync. IRN/EWB details are not reconstructable from Tally; recovery needs an authorised IRP source (no tax-service calls are made).',
    counts: { vouchers: e.vouchers, executedHardSyncRequests: e.executed_requests, irnWithoutDetails: irn.rows[0].n },
    ownerOperation: e.vouchers === 0 && e.executed_requests > 0 ? 'HARD_SYNC_COMPANY' : null,
  };
}

async function diagnoseI7(q, s, nowSec) {
  const { rows } = await q(
    `SELECT id::text AS id FROM sync_runs
      WHERE company_id = $1 AND status = 'running'
        AND COALESCE(heartbeat_at, started_at) < to_timestamp($2)
      ORDER BY id::text`,
    [s.companyId, nowSec - STALE_RUN_SECONDS]
  );
  const synced = await q(
    `SELECT c.synced_at IS NOT NULL AS has_synced_at,
            EXISTS (SELECT 1 FROM sync_log l WHERE l.company_id = c.id AND l.status IN ('success','completed')) AS has_success
       FROM companies c WHERE c.id = $1`,
    [s.companyId]
  );
  const r = synced.rows[0] || {};
  const syncedAtUnverified = Boolean(r.has_synced_at && !r.has_success);
  return {
    classification: rows.length ? 'confirmed' : 'none',
    note: 'A run with no heartbeat for a day has no live owner. companies.synced_at older than P2 may be an attempt time; it is reported, not rewritten.',
    counts: { staleRunningRuns: rows.length, syncedAtUnverified },
    staleRunIds: rows.map((x) => x.id),
  };
}

async function diagnoseI8(q, s) {
  const { rows } = await q(
    `SELECT id, fin_year, begin_date, end_date FROM company_years
      WHERE company_id = $1 AND is_active = FALSE ORDER BY begin_date`,
    [s.companyId]
  );
  return {
    classification: rows.length ? 'suspected' : 'none',
    note: 'Inactive years may be deliberate. Only years the owner explicitly selects are reactivated.',
    counts: { inactiveYears: rows.length },
    inactiveYears: rows.map((y) => ({ id: Number(y.id), finYear: y.fin_year, beginDate: y.begin_date, endDate: y.end_date })),
  };
}

const DIAGNOSE = { 'I.1': diagnoseI1, 'I.2': diagnoseI2, 'I.3': diagnoseI3, 'I.4': diagnoseI4, 'I.5': diagnoseI5, 'I.6': diagnoseI6, 'I.7': diagnoseI7, 'I.8': diagnoseI8 };

/** Read-only. */
export async function diagnose(q, { workspaceId, companyId, items = REPAIR_ITEMS, nowSec = Math.floor(Date.now() / 1000) }) {
  const scope = await resolveScope(q, { workspaceId, companyId });
  const findings = {};
  for (const item of items) {
    if (!DIAGNOSE[item]) throw repairError('REPAIR_ITEM_UNKNOWN', `Unknown repair item ${item}`);
    findings[item] = await DIAGNOSE[item](q, scope, nowSec);
  }
  return { scope, findings };
}

/**
 * Actions the owner may approve. `selectYearIds` limits I.8 to explicitly chosen
 * years; refetch years come from I.1–I.3 evidence only.
 */
export function buildManifest(diagnosis, { selectYearIds = [] } = {}) {
  const { scope, findings } = diagnosis;
  const actions = [];
  const refetch = new Set();
  for (const item of ['I.1', 'I.2', 'I.3']) for (const fy of findings[item]?.refetchYears || []) refetch.add(fy);
  for (const fy of [...refetch].sort()) actions.push({ type: 'reset_voucher_watermark', item: 'I.1-I.3', finYear: fy });
  for (const id of findings['I.7']?.staleRunIds || []) actions.push({ type: 'expire_stale_run', item: 'I.7', runId: id });
  const allowed = new Set((findings['I.8']?.inactiveYears || []).map((y) => y.id));
  for (const id of [...new Set(selectYearIds.map(Number))].sort((a, b) => a - b)) {
    if (!allowed.has(id)) throw repairError('REPAIR_SELECTION_INVALID', `Year ${id} is not an inactive year of this company`);
    actions.push({ type: 'reactivate_year', item: 'I.8', yearId: id });
  }
  const ownerOperations = Object.entries(findings)
    .filter(([, f]) => f.ownerOperation)
    .map(([item, f]) => ({ item, operation: f.ownerOperation, status: 'OWNER_OPERATION_PENDING' }));
  const manifest = {
    version: 1,
    workspaceId: scope.workspaceId,
    companyId: scope.companyId,
    companyGuid: scope.companyGuid,
    items: Object.keys(findings).sort(),
    actions,
    evidence: Object.fromEntries(Object.entries(findings).map(([k, f]) => [k, { classification: f.classification, counts: f.counts }])),
  };
  const selectableYears = findings['I.8']?.inactiveYears || [];
  return { manifest, hash: manifestHash(manifest), ownerOperations, selectableYears };
}

async function countState(q, s) {
  const { rows } = await q(
    `SELECT (SELECT COUNT(*)::int FROM voucher_sync_watermarks WHERE company_id = $1) AS watermarks,
            (SELECT COUNT(*)::int FROM sync_runs WHERE company_id = $1 AND status = 'running') AS running_runs,
            (SELECT COUNT(*)::int FROM company_years WHERE company_id = $1 AND is_active = FALSE) AS inactive_years,
            (SELECT COUNT(*)::int FROM vouchers WHERE company_id = $1) AS vouchers`,
    [s.companyId]
  );
  return rows[0];
}

/**
 * Applies a previewed manifest in one transaction. `client` must be a dedicated
 * connection (BEGIN/COMMIT are issued on it).
 */
export async function applyManifest(client, { workspaceId, companyId, items, selectYearIds = [], approvedHash, nowSec }) {
  const q = (text, params) => client.query(text, params);
  if (!approvedHash) throw repairError('REPAIR_APPROVAL_REQUIRED', 'Approve the previewed manifest hash');
  await client.query('BEGIN');
  try {
    const diagnosis = await diagnose(q, { workspaceId, companyId, items, nowSec });
    const { manifest, hash } = buildManifest(diagnosis, { selectYearIds });
    if (hash !== approvedHash) throw repairError('REPAIR_STATE_CHANGED', 'State changed since the preview; preview again');
    const s = diagnosis.scope;
    const before = await countState(q, s);
    const applied = [];
    for (const a of manifest.actions) {
      if (a.type === 'reset_voucher_watermark') {
        const r = await q(`DELETE FROM voucher_sync_watermarks WHERE company_id = $1 AND fin_year = $2`, [s.companyId, a.finYear]);
        applied.push({ ...a, rows: r.rowCount });
      } else if (a.type === 'expire_stale_run') {
        const r = await q(
          `UPDATE sync_runs SET status = 'abandoned', completed_at = NOW(),
                  error_message = COALESCE(error_message, 'expired by repair tool: no heartbeat for 24 h')
            WHERE id::text = $1 AND company_id = $2 AND status = 'running'`,
          [a.runId, s.companyId]
        );
        applied.push({ ...a, rows: r.rowCount });
      } else if (a.type === 'reactivate_year') {
        const r = await q(`UPDATE company_years SET is_active = TRUE WHERE id = $1 AND company_id = $2 AND is_active = FALSE`, [a.yearId, s.companyId]);
        applied.push({ ...a, rows: r.rowCount });
      }
    }
    const after = await countState(q, s);
    if (after.vouchers !== before.vouchers) throw repairError('REPAIR_INVARIANT', 'Voucher count changed during repair');
    await client.query('COMMIT');
    return { hash, applied, before, after };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}
