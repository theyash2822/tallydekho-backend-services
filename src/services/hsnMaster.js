/**
 * HSN/SAC master — existence validation against a local table.
 * Seed / refresh from free open GST JSON (no paid API).
 */
import { query } from '../db/schema.js';

const DEFAULT_SOURCE =
  'https://raw.githubusercontent.com/mhdstk/gst-master-data/main/data/master_hsn_sac.json';

/** Normalize to digits-only for lookup. */
export function normalizeHsnCode(raw) {
  return String(raw || '').replace(/\D/g, '');
}

/**
 * Validate HSN/SAC existence (not product-category match).
 * Accepts 4 / 6 / 8 digit codes if the code or a parent prefix exists.
 */
export async function validateHsnCode(raw) {
  const code = normalizeHsnCode(raw);
  if (!code) {
    return { valid: false, status: 'missing', code: '', message: 'HSN is empty' };
  }
  if (![4, 6, 8].includes(code.length) && code.length < 4) {
    return { valid: false, status: 'bad_format', code, message: 'HSN should be 4, 6, or 8 digits' };
  }
  if (code.length > 8 || (code.length > 4 && ![4, 6, 8].includes(code.length))) {
    // Allow other lengths only if exact match exists
    const { rows } = await query(`SELECT code, description FROM hsn_sac_codes WHERE code=$1 LIMIT 1`, [code]);
    if (rows[0]) return { valid: true, status: 'valid', code: rows[0].code, description: rows[0].description };
    return { valid: false, status: 'bad_format', code, message: 'HSN format not recognized' };
  }

  // Exact match
  {
    const { rows } = await query(
      `SELECT code, description FROM hsn_sac_codes WHERE code=$1 LIMIT 1`,
      [code]
    );
    if (rows[0]) {
      return { valid: true, status: 'valid', code: rows[0].code, description: rows[0].description };
    }
  }

  // Parent chapter / heading (8→6→4)
  const prefixes = [];
  if (code.length >= 6) prefixes.push(code.slice(0, 6));
  if (code.length >= 4) prefixes.push(code.slice(0, 4));
  for (const p of prefixes) {
    const { rows } = await query(
      `SELECT code, description FROM hsn_sac_codes WHERE code=$1 LIMIT 1`,
      [p]
    );
    if (rows[0]) {
      return {
        valid: true,
        status: 'valid_chapter',
        code,
        matched: rows[0].code,
        description: rows[0].description,
      };
    }
  }

  // Any child under this chapter (user entered 4-digit, we have 8-digit children)
  if (code.length === 4 || code.length === 6) {
    const { rows } = await query(
      `SELECT code, description FROM hsn_sac_codes WHERE code LIKE $1 LIMIT 1`,
      [`${code}%`]
    );
    if (rows[0]) {
      return {
        valid: true,
        status: 'valid_chapter',
        code,
        matched: rows[0].code,
        description: rows[0].description,
      };
    }
  }

  return { valid: false, status: 'unknown', code, message: 'HSN not found in our list' };
}

function extractCodesFromPayload(data) {
  const out = [];
  const push = (code, description, codeType) => {
    const c = normalizeHsnCode(code);
    if (!c || c.length < 4) return;
    out.push({
      code: c,
      description: String(description || '').slice(0, 500),
      code_type: codeType === 'sac' || c.startsWith('99') ? 'sac' : 'hsn',
    });
  };

  if (Array.isArray(data)) {
    for (const row of data) {
      if (!row || typeof row !== 'object') continue;
      const code = row.code || row.hsn || row.HSN || row.hsn_code || row.HSN_CD || row.sac || row.SAC;
      const desc = row.description || row.desc || row.Description || row.HSN_DESC || '';
      const typ = row.type || row.code_type || (row.sac || row.SAC ? 'sac' : 'hsn');
      push(code, desc, typ);
    }
    return out;
  }

  if (data && typeof data === 'object') {
    // { hsn: [...], sac: [...] } or flat map
    for (const [key, val] of Object.entries(data)) {
      if (Array.isArray(val)) {
        const typ = /sac/i.test(key) ? 'sac' : 'hsn';
        for (const row of val) {
          if (typeof row === 'string') push(row, '', typ);
          else if (row && typeof row === 'object') {
            push(row.code || row.hsn || row.HSN || key, row.description || row.desc || '', typ);
          }
        }
      } else if (typeof val === 'string' && /^\d{4,8}$/.test(normalizeHsnCode(key))) {
        push(key, val, 'hsn');
      }
    }
  }
  return out;
}

/** Upsert codes; returns inserted/updated count. */
export async function upsertHsnCodes(rows, sourceUrl) {
  let n = 0;
  const chunk = 200;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    for (const r of slice) {
      await query(
        `INSERT INTO hsn_sac_codes (code, description, code_type, source, updated_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (code) DO UPDATE SET
           description = COALESCE(NULLIF(EXCLUDED.description,''), hsn_sac_codes.description),
           code_type = EXCLUDED.code_type,
           source = EXCLUDED.source,
           updated_at = NOW()`,
        [r.code, r.description || '', r.code_type || 'hsn', sourceUrl || 'seed']
      );
      n += 1;
    }
  }
  const { rows: cnt } = await query(`SELECT COUNT(*)::int AS c FROM hsn_sac_codes`);
  await query(`DELETE FROM hsn_sac_meta`);
  await query(
    `INSERT INTO hsn_sac_meta (last_refresh, source_url, row_count, status)
     VALUES (NOW(), $1, $2, 'ok')`,
    [sourceUrl || 'seed', cnt[0]?.c || n]
  );
  return { upserted: n, total: cnt[0]?.c || n };
}

/** Minimal bootstrap so validation works before first network refresh. */
const BOOTSTRAP_CODES = [
  { code: '3923', description: 'Articles for the conveyance or packing of goods, of plastics', code_type: 'hsn' },
  { code: '3924', description: 'Tableware, kitchenware, other household articles of plastics', code_type: 'hsn' },
  { code: '7323', description: 'Table, kitchen or other household articles of iron or steel', code_type: 'hsn' },
  { code: '9617', description: 'Vacuum flasks and other vacuum vessels', code_type: 'hsn' },
  { code: '7010', description: 'Carboys, bottles, flasks of glass', code_type: 'hsn' },
  { code: '7013', description: 'Glassware of a kind used for table, kitchen, toilet, office', code_type: 'hsn' },
  { code: '1006', description: 'Rice', code_type: 'hsn' },
  { code: '1701', description: 'Cane or beet sugar', code_type: 'hsn' },
  { code: '2201', description: 'Waters, including natural or artificial mineral waters', code_type: 'hsn' },
  { code: '3004', description: 'Medicaments', code_type: 'hsn' },
  { code: '8471', description: 'Automatic data processing machines', code_type: 'hsn' },
  { code: '8517', description: 'Telephone sets, including smartphones', code_type: 'hsn' },
  { code: '998314', description: 'IT design and development services', code_type: 'sac' },
];

export async function ensureHsnBootstrap() {
  const { rows } = await query(`SELECT COUNT(*)::int AS c FROM hsn_sac_codes`).catch(() => ({ rows: [{ c: 0 }] }));
  if ((rows[0]?.c || 0) > 0) return { seeded: false, total: rows[0].c };
  await upsertHsnCodes(BOOTSTRAP_CODES, 'bootstrap');
  return { seeded: true, total: BOOTSTRAP_CODES.length };
}

export async function refreshHsnMasterFromUrl(url = DEFAULT_SOURCE) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HSN refresh HTTP ${res.status}`);
  const data = await res.json();
  const rows = extractCodesFromPayload(data);
  if (!rows.length) throw new Error('HSN refresh: no codes parsed from payload');
  return upsertHsnCodes(rows, url);
}

export async function maybeRefreshHsnMaster({ force = false, maxAgeDays = 15 } = {}) {
  await ensureHsnBootstrap();
  const { rows } = await query(
    `SELECT last_refresh, row_count FROM hsn_sac_meta ORDER BY id DESC LIMIT 1`
  ).catch(() => ({ rows: [] }));
  const last = rows[0]?.last_refresh ? new Date(rows[0].last_refresh).getTime() : 0;
  const ageMs = Date.now() - last;
  const stale = !last || ageMs > maxAgeDays * 864e5;
  const thin = (rows[0]?.row_count || 0) < 1000;
  if (!force && !stale && !thin) {
    return { skipped: true, reason: 'fresh', row_count: rows[0]?.row_count };
  }
  try {
    const result = await refreshHsnMasterFromUrl();
    return { skipped: false, ...result };
  } catch (err) {
    console.warn('[hsn] refresh failed:', err.message);
    return { skipped: true, error: err.message, row_count: rows[0]?.row_count || 0 };
  }
}

export { DEFAULT_SOURCE };
