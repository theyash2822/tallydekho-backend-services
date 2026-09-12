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

/** Restore may only activate if discovered/restored GUIDs overlap the approved backup manifest. */
export function lineageMatchesBackupManifest(backupManifest = [], lineageGuids = []) {
  let manifest = backupManifest;
  if (typeof manifest === 'string') {
    try { manifest = JSON.parse(manifest); } catch { manifest = []; }
  }
  const fromManifest = [...new Set(
    (Array.isArray(manifest) ? manifest : [])
      .map((c) => c?.guid || c.tally_company_guid)
      .filter(Boolean)
  )];
  const incoming = [...new Set((lineageGuids || []).filter(Boolean))];
  if (!fromManifest.length || !incoming.length) return { ok: true, reason: 'skipped' };
  const set = new Set(fromManifest);
  const overlap = incoming.filter((g) => set.has(g));
  if (overlap.length === 0) {
    return { ok: false, code: 'TALLY_DATA_MISMATCH', reason: 'restore_manifest_mismatch', extra: incoming, missing: fromManifest };
  }
  return { ok: true, reason: 'overlap', overlap };
}

/** On-disk company folders after restore must overlap backup company names (not a GUID echo). */
export function lineageMatchesRestoredFolders(backupManifest = [], restoredFolders = []) {
  let manifest = backupManifest;
  if (typeof manifest === 'string') {
    try { manifest = JSON.parse(manifest); } catch { manifest = []; }
  }
  const names = [...new Set(
    (Array.isArray(manifest) ? manifest : [])
      .flatMap((c) => [c?.name, c.company_name, c.folder, c.folder_name])
      .map((n) => String(n || '').trim())
      .filter(Boolean)
  )];
  const folders = [...new Set((restoredFolders || []).map((n) => String(n || '').trim()).filter(Boolean))];
  if (!names.length) return { ok: true, reason: 'skipped' };
  if (!folders.length) {
    return { ok: false, code: 'TALLY_DATA_MISMATCH', reason: 'restore_folders_missing', extra: [], missing: names };
  }
  const folderSet = new Set(folders.map((n) => n.toLowerCase()));
  const overlap = names.filter((n) => folderSet.has(n.toLowerCase()));
  if (overlap.length === 0) {
    return { ok: false, code: 'TALLY_DATA_MISMATCH', reason: 'restore_folder_mismatch', extra: folders, missing: names };
  }
  return { ok: true, reason: 'folder_overlap', overlap };
}

export function pickRetentionDeletes(successfulBackups, keep = 3) {
  const list = [...(successfulBackups || [])].sort((a, b) => {
    const ta = Number(a.completed_at || a.created_at || 0);
    const tb = Number(b.completed_at || b.created_at || 0);
    return tb - ta;
  });
  return list.slice(keep);
}
