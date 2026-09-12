/**
 * Tally dataset lineage vs a Workspace binding.
 * Physical computer may change; unrelated Tally data must not overwrite a Workspace.
 */

export function evaluateLineage(knownGuids = [], incomingGuids = []) {
  const known = [...new Set((knownGuids || []).filter(Boolean))];
  const incoming = [...new Set((incomingGuids || []).filter(Boolean))];
  const knownSet = new Set(known);
  const incomingSet = new Set(incoming);

  if (known.length === 0) {
    return { ok: true, reason: 'first_bind', extra: incoming, missing: [] };
  }
  if (incoming.length === 0) {
    return { ok: true, reason: 'empty_discovery', extra: [], missing: known };
  }

  const overlap = incoming.filter((g) => knownSet.has(g));
  const extra = incoming.filter((g) => !knownSet.has(g));
  const missing = known.filter((g) => !incomingSet.has(g));

  if (overlap.length === 0) {
    return {
      ok: false,
      code: 'TALLY_DATA_MISMATCH',
      reason: 'unrelated',
      extra,
      missing,
    };
  }

  // Known companies dropped AND new GUIDs appeared → possible GUID replacement, not silent normal sync.
  if (missing.length > 0 && extra.length > 0) {
    return {
      ok: false,
      code: 'TALLY_DATA_MISMATCH',
      reason: 'guid_replacement_candidate',
      extra,
      missing,
    };
  }

  return { ok: true, reason: extra.length ? 'new_companies' : 'match', extra, missing };
}

export function pickRetentionDeletes(successfulBackups, keep = 3) {
  const list = [...(successfulBackups || [])].sort((a, b) => {
    const ta = Number(a.completed_at || a.created_at || 0);
    const tb = Number(b.completed_at || b.created_at || 0);
    return tb - ta;
  });
  return list.slice(keep);
}
