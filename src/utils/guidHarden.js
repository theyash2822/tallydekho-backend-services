/**
 * GUID harden helpers — prefer durable IDs over name joins for RBAS scopes.
 * Expand-only: callers should COALESCE(guid, name) during migration.
 * Never put Workspace ID into Tally XML.
 */

/** SQL fragment: party match prefers party_guid when present. */
export function partyMatchSql(alias = 'v', paramIdxGuid = 1, paramIdxName = 2) {
  return `(
    (${alias}.party_guid IS NOT NULL AND ${alias}.party_guid = $${paramIdxGuid})
    OR (${alias}.party_guid IS NULL AND ${alias}.party_name = $${paramIdxName})
  )`;
}

/** Prefer warehouse.guid when filtering godowns. */
export function godownMatchSql(alias = 'w', paramIdxGuid = 1, paramIdxName = 2) {
  return `(
    (${alias}.guid IS NOT NULL AND ${alias}.guid <> '' AND ${alias}.guid = $${paramIdxGuid})
    OR ((${alias}.guid IS NULL OR ${alias}.guid = '') AND ${alias}.name = $${paramIdxName})
  )`;
}

export function preferGuid(guid, name) {
  const g = guid != null ? String(guid).trim() : '';
  if (g) return { kind: 'guid', value: g };
  const n = name != null ? String(name).trim() : '';
  return { kind: 'name', value: n };
}
