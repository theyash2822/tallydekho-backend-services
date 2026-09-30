/**
 * Split an ingest chunk by the company each record was fetched for.
 * Records without their own COMPANY_GUID use `fallbackGuid`; if there is no
 * fallback either they are counted in `missing` and left out of `groups`.
 * Map insertion order keeps companies in the order they appear in the chunk.
 */
export function groupRecordsByCompany(records, fallbackGuid = null) {
  const groups = new Map();
  let missing = 0;
  for (const record of Array.isArray(records) ? records : []) {
    const guid = String(record?.COMPANY_GUID || record?.company_guid || fallbackGuid || '').trim();
    if (!guid) { missing++; continue; }
    if (!groups.has(guid)) groups.set(guid, []);
    groups.get(guid).push(record);
  }
  return { groups, missing };
}

const BILL_PURGE_TTL_MS = 6 * 60 * 60 * 1000;
const billPurges = new Map();

/**
 * Bill outstanding is a full snapshot per company, but one company's rows can span
 * several chunks of the same upload. Returns true only for the first chunk of an
 * (upload, company) pair, so later chunks append instead of wiping earlier rows.
 * Without an uploadId every call purges (the previous behaviour).
 */
export function claimBillOutstandingPurge(uploadId, companyId, nowMs = Date.now()) {
  if (!uploadId || companyId == null) return true;
  for (const [key, at] of billPurges) {
    if (nowMs - at > BILL_PURGE_TTL_MS) billPurges.delete(key);
  }
  const key = `${uploadId}:${companyId}`;
  if (billPurges.has(key)) return false;
  billPurges.set(key, nowMs);
  return true;
}

/** Distinct company GUIDs named by `/ingest/complete` (explicit guid first, then the companies list). */
export function completeCompanyGuids(body, uploadCompanyGuid = null) {
  const out = [];
  const add = (g) => {
    const guid = String(g || '').trim();
    if (guid && !out.includes(guid)) out.push(guid);
  };
  add(body?.companyGuid);
  if (!out.length && Array.isArray(body?.companies)) {
    body.companies.forEach((c) => add(typeof c === 'string' ? c : c?.guid));
  }
  if (!out.length) add(uploadCompanyGuid);
  return out;
}
