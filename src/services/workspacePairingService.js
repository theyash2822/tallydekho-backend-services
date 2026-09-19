/**
 * WorkspacePairingService — sole authority for Workspace ↔ Desktop binding.
 * Evolves workspace_tally_bindings (no parallel ownership table).
 *
 * Phase B: canonical pair/unpair, idempotency, status contract, session schema hooks.
 * Phase C: Desktop HTTP claim/ACK (createPairingSession already usable).
 */
import { v4 as uuid } from 'uuid';
import crypto from 'crypto';
import { query } from '../db/schema.js';
import { audit } from './auditService.js';
import { assertCapability, authorize } from './authorizationService.js';
import { generateDeviceSecret, hashSecret, hashToken } from './deviceCredential.js';

const now = () => Math.floor(Date.now() / 1000);

const RESTORE_REPLACE_MSG =
  'This Workspace already has a connected Tally Desktop. If the old computer is unavailable, use Restore / Replace Computer.';

const DEVICE_ELSEWHERE_MSG =
  'This Tally Desktop is already connected to another TallyDekho workspace.';

export class BindingError extends Error {
  constructor(code, message, httpStatus = 409) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export async function getBindingRow(workspaceId) {
  const { rows } = await query(
    `SELECT connection_status, active_device_id, lineage_id, first_bound_at, last_verified_at
     FROM workspace_tally_bindings WHERE workspace_id = $1 LIMIT 1`,
    [workspaceId]
  );
  return rows[0] || null;
}

export async function getConnectionStatus(workspaceId) {
  const binding = await getBindingRow(workspaceId);
  if (binding?.connection_status) return String(binding.connection_status).toUpperCase();
  const { rows } = await query(`SELECT tally_connection FROM workspaces WHERE id = $1 LIMIT 1`, [workspaceId]);
  return String(rows[0]?.tally_connection || 'UNPAIRED').toUpperCase();
}

/** DEMO | LIVE | LOCKED — shared data-mode for /api and /app */
export async function getTallyActionFlags(userId, workspaceId, status = null) {
  const conn = String(status || (await getConnectionStatus(workspaceId))).toUpperCase();
  const pair = await authorize({ userId, workspaceId, capability: 'tally.pair' });
  const unpair = await authorize({ userId, workspaceId, capability: 'tally.unpair' });
  const restore = await authorize({ userId, workspaceId, capability: 'tally.restore_replace' });
  const canPairCap = pair.decision === 'ALLOW';
  const canUnpairCap = unpair.decision === 'ALLOW';
  const canRestoreCap = restore.decision === 'ALLOW';
  const bound = conn === 'CONNECTED' || conn === 'RECONNECTING' || conn === 'RESTORE_PENDING';
  return {
    canPair: !!(canPairCap && conn === 'UNPAIRED'),
    canUnpair: !!(canUnpairCap && bound),
    canApproveHardSync: !!canRestoreCap,
    canApproveRestore: !!canRestoreCap,
  };
}

export async function buildTallyStatusPayload(workspaceId, userId = null) {
  const binding = await getBindingRow(workspaceId);
  const { rows: ws } = await query(
    `SELECT tally_connection, lifecycle_status, commercial_status FROM workspaces WHERE id = $1`,
    [workspaceId]
  );
  const status = String(
    binding?.connection_status || ws[0]?.tally_connection || 'UNPAIRED'
  ).toUpperCase();
  const deviceId = binding?.active_device_id || null;
  let desktopOnline = false;
  let tallyOnline = false;
  let lastHeartbeatAt = null;
  if (deviceId) {
    const { rows: d } = await query(
      `SELECT last_seen FROM devices WHERE device_id = $1 LIMIT 1`,
      [deviceId]
    );
    if (d[0]?.last_seen) {
      lastHeartbeatAt = Number(d[0].last_seen);
      const age = now() - lastHeartbeatAt;
      desktopOnline = age < 5 * 60;
      // Separate health signal; Desktop may report Tally port later — do not collapse into connectionStatus.
      tallyOnline = desktopOnline;
    }
  }
  const flags = userId
    ? await getTallyActionFlags(userId, workspaceId, status)
    : { canPair: false, canUnpair: false, canApproveHardSync: false, canApproveRestore: false };

  return {
    status,
    demoMode: status === 'UNPAIRED' || status === 'RECONNECTING',
    firstSyncPending: status === 'RECONNECTING',
    activeDeviceId: deviceId,
    lineageId: binding?.lineage_id || null,
    desktopOnline,
    tallyOnline,
    lastHeartbeatAt,
    lastSyncAt: binding?.last_verified_at || null,
    lastSyncError: null,
    lifecycleStatus: ws[0]?.lifecycle_status || null,
    commercialStatus: ws[0]?.commercial_status || null,
    ...flags,
  };
}

/**
 * Pair Desktop to Workspace by permanent/legacy pairing code (Phase B bridge).
 * Phase C will prefer approvePairingSession; this remains until Desktop migrates.
 */
export async function pairDeviceToWorkspace({ device, userId, workspaceId = null }) {
  let workspace;
  if (workspaceId) {
    const { rows } = await query('SELECT * FROM workspaces WHERE id = $1', [workspaceId]);
    workspace = rows[0];
    if (!workspace) {
      throw new BindingError('WORKSPACE_NOT_FOUND', 'Workspace not found', 404);
    }
    try {
      await assertCapability(userId, workspaceId, 'tally.pair');
    } catch {
      throw new BindingError(
        'PAIRING_NOT_ALLOWED',
        'Capability tally.pair required to pair Tally for this workspace.',
        403
      );
    }
  } else {
    // Legacy callers without workspace — require explicit id going forward.
    throw new BindingError(
      'WORKSPACE_REQUIRED',
      'Workspace id is required to pair Tally Desktop.',
      400
    );
  }

  const ts = now();

  // Idempotent: same Device + same Workspace already bound → no secret rotation
  if (
    device.paired &&
    device.workspace_id === workspace.id &&
    (device.binding_status === 'ACTIVE' || device.binding_status == null)
  ) {
    const binding = await getBindingRow(workspace.id);
    const status = String(binding?.connection_status || workspace.tally_connection || 'RECONNECTING').toUpperCase();
    await audit(workspace.id, userId, 'tally.pair.idempotent', { deviceId: device.device_id, status });
    return {
      workspace,
      deviceSecret: null,
      alreadyBound: true,
      connectionStatus: status,
    };
  }

  if (device.paired && device.workspace_id && device.workspace_id !== workspace.id) {
    throw new BindingError('DEVICE_ALREADY_PAIRED', DEVICE_ELSEWHERE_MSG, 409);
  }

  // A paired device with no workspace predates the binding model and cannot be
  // attributed to a tenant, so it must be unpaired before it can be re-claimed.
  if (device.paired && !device.workspace_id) {
    throw new BindingError('DEVICE_ALREADY_PAIRED', DEVICE_ELSEWHERE_MSG, 409);
  }

  const { rows: bound } = await query(
    `SELECT device_id FROM devices
     WHERE workspace_id = $1 AND paired = TRUE AND device_id <> $2
     LIMIT 1`,
    [workspace.id, device.device_id]
  );
  if (bound[0]) {
    throw new BindingError('WORKSPACE_ALREADY_HAS_DESKTOP', RESTORE_REPLACE_MSG, 409);
  }

  const { rows: bindActive } = await query(
    `SELECT active_device_id FROM workspace_tally_bindings
     WHERE workspace_id = $1 AND active_device_id IS NOT NULL
       AND connection_status IN ('CONNECTED','RECONNECTING','RESTORE_PENDING')
       AND active_device_id <> $2
     LIMIT 1`,
    [workspace.id, device.device_id]
  );
  if (bindActive[0]) {
    throw new BindingError('WORKSPACE_ALREADY_HAS_DESKTOP', RESTORE_REPLACE_MSG, 409);
  }

  const secret = generateDeviceSecret();
  const secretHash = await hashSecret(secret);

  // Ownership = Workspace. Phase 4: do not write devices.user_id
  await query(
    `UPDATE devices SET
       workspace_id = $1,
       paired = TRUE,
       binding_status = 'ACTIVE',
       device_secret_hash = $2,
       credential_claimed_at = NULL,
       last_seen = $3
     WHERE device_id = $4`,
    [workspace.id, secretHash, ts, device.device_id]
  );

  // Attach device companies to workspace ownership — do NOT force is_active
  await query(
    `UPDATE companies SET workspace_id = $1
     WHERE device_id = $2 AND (workspace_id IS NULL OR workspace_id = $1)`,
    [workspace.id, device.device_id]
  ).catch(() => {});

  await query(
    `INSERT INTO workspace_tally_bindings (id, workspace_id, active_device_id, lineage_id, connection_status, first_bound_at, last_verified_at, updated_at)
     VALUES ($1,$2,$3,$4,'RECONNECTING',$5,$5,$5)
     ON CONFLICT (workspace_id) DO UPDATE SET
       active_device_id = EXCLUDED.active_device_id,
       connection_status = 'RECONNECTING',
       last_verified_at = EXCLUDED.last_verified_at,
       updated_at = EXCLUDED.updated_at`,
    [uuid(), workspace.id, device.device_id, uuid(), ts]
  );

  await query(
    `UPDATE workspaces SET tally_connection = 'RECONNECTING', updated_at = $2 WHERE id = $1`,
    [workspace.id, ts]
  );

  await audit(workspace.id, userId, 'tally.pair', {
    deviceId: device.device_id,
    pairedByUserId: userId,
  });

  return {
    workspace,
    deviceSecret: secret,
    alreadyBound: false,
    connectionStatus: 'RECONNECTING',
  };
}

/**
 * Unpair by Workspace → active binding → Device.
 * Non-destructive: never touches companies.is_active or companies.workspace_id.
 */
export async function unpairWorkspace({ workspaceId, actorUserId }) {
  try {
    await assertCapability(actorUserId, workspaceId, 'tally.unpair');
  } catch {
    throw new BindingError(
      'PAIRING_NOT_ALLOWED',
      'Capability tally.unpair required to unpair Tally for this workspace.',
      403
    );
  }

  const { rows } = await query(
    `SELECT device_id FROM devices WHERE workspace_id = $1 AND paired = TRUE LIMIT 1`,
    [workspaceId]
  );
  const deviceId = rows[0]?.device_id || null;
  if (!deviceId) {
    const binding = await getBindingRow(workspaceId);
    if (!binding?.active_device_id) {
      return { alreadyUnpaired: true, newCode: null, deviceId: null, workspaceId };
    }
  }

  const result = await unpairDevice(deviceId || (await getBindingRow(workspaceId))?.active_device_id, actorUserId);
  return {
    alreadyUnpaired: false,
    newCode: result.newCode,
    deviceId: result.deviceId || deviceId,
    workspaceId,
  };
}

export async function unpairDevice(deviceId, actorUserId = null) {
  const { rows } = await query('SELECT * FROM devices WHERE device_id = $1', [deviceId]);
  const device = rows[0];
  if (!device) return { newCode: null, workspaceId: null, deviceId: null };

  const ts = now();
  // Do NOT invent a claimable pairing_code here — without a PENDING session it is not
  // usable, and Desktop must GET /desktop/pairing-code to create a real session.
  await query(
    `UPDATE devices SET
       paired = FALSE,
       workspace_id = NULL,
       binding_status = 'REVOKED',
       device_secret_hash = NULL,
       credential_claimed_at = NULL,
       pairing_code = NULL,
       code_expires = NULL
     WHERE device_id = $1`,
    [deviceId]
  );

  // Critical: cancel open pairing sessions so Desktop pollClaim cannot re-bind after unpair.
  // Without this, an APPROVED (or CLAIM_PENDING_ACK) session remains claimable and silently
  // restores RECONNECTING — Admin then hits 409 on the next intentional pair.
  const { rowCount: cancelledSessions } = await query(
    `UPDATE desktop_pairing_sessions
     SET status = 'CANCELLED', cancelled_at = $2
     WHERE status IN ('PENDING', 'APPROVED', 'CLAIM_PENDING_ACK')
       AND (device_id = $1 OR ($3::text IS NOT NULL AND workspace_id = $3))`,
    [deviceId, ts, device.workspace_id || null]
  );

  if (device.workspace_id) {
    await query(
      `UPDATE workspace_tally_bindings SET active_device_id = NULL, connection_status = 'UNPAIRED', updated_at = $2
       WHERE workspace_id = $1 AND (active_device_id = $3 OR active_device_id IS NULL)`,
      [device.workspace_id, ts, deviceId]
    );
    await query(
      `UPDATE workspaces SET tally_connection = 'UNPAIRED', updated_at = $2 WHERE id = $1`,
      [device.workspace_id, ts]
    );
    await audit(device.workspace_id, actorUserId || null, 'tally.unpair', {
      deviceId,
      cancelledSessions: cancelledSessions || 0,
    });
    console.log(
      `[PAIRING] unpair workspace=${device.workspace_id} device=${deviceId} actor=${actorUserId || 'device'} cancelledSessions=${cancelledSessions || 0}`
    );
  } else if (cancelledSessions) {
    console.log(`[PAIRING] unpair device=${deviceId} cancelledSessions=${cancelledSessions}`);
  }

  // Intentionally NO companies UPDATE — visibility is connection-state driven.
  return { newCode: null, workspaceId: device.workspace_id, deviceId };
}

export async function markFirstSyncConnected(workspaceId, deviceId, companies = []) {
  const ts = now();
  await query(
    `UPDATE workspace_tally_bindings SET connection_status = 'CONNECTED', last_verified_at = $2, updated_at = $2
     WHERE workspace_id = $1`,
    [workspaceId, ts]
  );
  await query(
    `UPDATE workspaces SET tally_connection = 'CONNECTED', updated_at = $2 WHERE id = $1`,
    [workspaceId, ts]
  );
  for (const c of companies) {
    const guid = c.guid || c.GUID;
    if (!guid) continue;
    await query(
      `INSERT INTO workspace_tally_lineage_companies
         (workspace_id, tally_company_guid, company_name, first_seen_at, last_seen_at, status)
       VALUES ($1,$2,$3,$4,$4,'ACTIVE')
       ON CONFLICT (workspace_id, tally_company_guid) DO UPDATE SET
         company_name = COALESCE(EXCLUDED.company_name, workspace_tally_lineage_companies.company_name),
         last_seen_at = EXCLUDED.last_seen_at,
         status = 'ACTIVE'`,
      [workspaceId, guid, c.name || c.NAME || null, ts]
    );
  }
  await audit(workspaceId, null, 'FIRST_SYNC_SUCCEEDED', { deviceId }).catch(() => {});
  console.log(`[PAIRING] first_sync_success workspace=${workspaceId} device=${deviceId} → CONNECTED`);
}

export async function getKnownLineageGuids(workspaceId) {
  const { rows } = await query(
    `SELECT tally_company_guid FROM workspace_tally_lineage_companies
     WHERE workspace_id = $1 AND status = 'ACTIVE'`,
    [workspaceId]
  );
  return rows.map((r) => r.tally_company_guid);
}

// ── Pairing sessions (Phase B schema + create; claim/ACK completed in Phase C) ──

const PAIRING_CODE_TTL_SECS = Number(process.env.PAIRING_SESSION_TTL_SECS || 600);

function randomPairingCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function createPairingSession(deviceId) {
  if (!deviceId) {
    throw new BindingError('VALIDATION_ERROR', 'device_id required', 400);
  }
  const { rows: devices } = await query(`SELECT * FROM devices WHERE device_id = $1`, [deviceId]);
  let device = devices[0];
  if (!device) {
    await query(
      `INSERT INTO devices (device_id, name, last_seen, pairing_code)
       VALUES ($1, 'Desktop', $2, $3)
       ON CONFLICT (device_id) DO NOTHING`,
      [deviceId, now(), randomPairingCode()]
    );
    const { rows } = await query(`SELECT * FROM devices WHERE device_id = $1`, [deviceId]);
    device = rows[0];
  }

  if (device.paired && device.workspace_id) {
    throw new BindingError(
      'DEVICE_ALREADY_PAIRED',
      DEVICE_ELSEWHERE_MSG,
      409
    );
  }

  // Cancel prior PENDING sessions for this device
  await query(
    `UPDATE desktop_pairing_sessions SET status = 'CANCELLED', cancelled_at = $2
     WHERE device_id = $1 AND status = 'PENDING'`,
    [deviceId, now()]
  );

  let pairingCode = randomPairingCode();
  for (let i = 0; i < 8; i++) {
    const { rows: clash } = await query(
      `SELECT 1 FROM desktop_pairing_sessions
       WHERE code_lookup_hash = $1 AND status = 'PENDING' AND expires_at > $2
       LIMIT 1`,
      [hashToken(pairingCode), now()]
    );
    if (!clash[0]) break;
    pairingCode = randomPairingCode();
  }

  const claimToken = crypto.randomBytes(32).toString('hex');
  const sessionId = uuid();
  const expiresAt = now() + PAIRING_CODE_TTL_SECS;

  await query(
    `INSERT INTO desktop_pairing_sessions
       (id, device_id, code_lookup_hash, claim_token_hash, status, created_at, expires_at)
     VALUES ($1,$2,$3,$4,'PENDING',$5,$6)`,
    [sessionId, deviceId, hashToken(pairingCode), hashToken(claimToken), now(), expiresAt]
  );

  // Bridge: keep devices.pairing_code in sync so current Web/Mobile pair still works until Phase C cutover
  await query(
    `UPDATE devices SET pairing_code = $2, code_expires = $3 WHERE device_id = $1`,
    [deviceId, pairingCode, expiresAt * 1000]
  );

  await audit(null, null, 'PAIR_SESSION_CREATED', { sessionId, deviceId }).catch(() => {});
  console.log(`[PAIRING] session_created sessionId=${sessionId} device=${deviceId} expiresAt=${expiresAt}`);

  return {
    sessionId,
    pairingCode,
    claimToken,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

/**
 * Owner/Admin approves a PENDING pairing session by human code.
 * Does NOT issue device_secret — Desktop must HTTP-claim (Phase C).
 */
export async function approvePairing({ workspaceId, actorUserId, pairingCode }) {
  await requireWorkspaceId(workspaceId);
  try {
    await assertCapability(actorUserId, workspaceId, 'tally.pair');
  } catch {
    throw new BindingError(
      'PAIRING_NOT_ALLOWED',
      'Capability tally.pair required to pair Tally for this workspace.',
      403
    );
  }
  const code = String(pairingCode || '').trim();
  if (!code) {
    throw new BindingError('VALIDATION_ERROR', 'Pairing code required', 400);
  }

  const codeHash = hashToken(code);
  const ts = now();

  // Prefer short-lived session
  let { rows: sessions } = await query(
    `SELECT * FROM desktop_pairing_sessions
     WHERE code_lookup_hash = $1 AND status = 'PENDING'
     ORDER BY created_at DESC LIMIT 1`,
    [codeHash]
  );
  let session = sessions[0];

  if (session && session.expires_at < ts) {
    await query(
      `UPDATE desktop_pairing_sessions SET status = 'EXPIRED' WHERE id = $1 AND status = 'PENDING'`,
      [session.id]
    );
    throw new BindingError('PAIRING_SESSION_EXPIRED', 'Pairing code expired. Generate a new one on Desktop.', 400);
  }

  // Already approved race
  if (!session) {
    const { rows: approved } = await query(
      `SELECT * FROM desktop_pairing_sessions
       WHERE code_lookup_hash = $1 AND status = 'APPROVED'
       ORDER BY created_at DESC LIMIT 1`,
      [codeHash]
    );
    if (approved[0]) {
      throw new BindingError(
        'PAIRING_SESSION_ALREADY_APPROVED',
        'This pairing code was already approved. Wait for Desktop to finish connecting.',
        409
      );
    }
  }

  // Used / cancelled / expired session for this code — Desktop UI often still shows the old digits
  if (!session) {
    const { rows: prior } = await query(
      `SELECT status FROM desktop_pairing_sessions
       WHERE code_lookup_hash = $1
       ORDER BY created_at DESC LIMIT 1`,
      [codeHash]
    );
    if (prior[0]) {
      throw new BindingError(
        'PAIRING_CODE_INVALID',
        'This pairing code is no longer valid. On Desktop, tap Refresh code and enter the new one.',
        400
      );
    }
  }

  // Legacy bridge: code on devices row without session row
  if (!session) {
    const { rows } = await query(`SELECT * FROM devices WHERE pairing_code = $1`, [code]);
    const device = rows[0];
    if (!device) {
      throw new BindingError('PAIRING_CODE_INVALID', 'Invalid pairing code', 400);
    }
    if (device.code_expires && Date.now() > Number(device.code_expires)) {
      throw new BindingError('PAIRING_SESSION_EXPIRED', 'Pairing code expired. Generate a new one on Desktop.', 400);
    }
    // Fall back to immediate bind + secret (old Desktop that never created a session)
    const bound = await pairDeviceToWorkspace({ device, userId: actorUserId, workspaceId });
    return {
      mode: 'legacy_immediate',
      workspace: bound.workspace,
      deviceId: device.device_id,
      deviceSecret: bound.deviceSecret,
      alreadyBound: !!bound.alreadyBound,
      connectionStatus: bound.connectionStatus || 'RECONNECTING',
      sessionId: null,
    };
  }

  const { rows: devices } = await query(`SELECT * FROM devices WHERE device_id = $1`, [session.device_id]);
  const device = devices[0];
  if (!device) {
    throw new BindingError('PAIRING_SESSION_NOT_FOUND', 'Device for pairing session not found', 404);
  }

  // Idempotent: already bound same workspace
  if (device.paired && device.workspace_id === workspaceId) {
    const status = await getConnectionStatus(workspaceId);
    return {
      mode: 'session_approved',
      workspace: (await query('SELECT * FROM workspaces WHERE id = $1', [workspaceId])).rows[0],
      deviceId: device.device_id,
      deviceSecret: null,
      alreadyBound: true,
      connectionStatus: status,
      sessionId: session.id,
    };
  }

  if (device.paired && device.workspace_id && device.workspace_id !== workspaceId) {
    throw new BindingError('DEVICE_ALREADY_PAIRED', DEVICE_ELSEWHERE_MSG, 409);
  }

  const { rows: otherDev } = await query(
    `SELECT device_id FROM devices
     WHERE workspace_id = $1 AND paired = TRUE AND device_id <> $2 LIMIT 1`,
    [workspaceId, device.device_id]
  );
  if (otherDev[0]) {
    throw new BindingError('WORKSPACE_ALREADY_HAS_DESKTOP', RESTORE_REPLACE_MSG, 409);
  }

  const { rows: updated } = await query(
    `UPDATE desktop_pairing_sessions
     SET status = 'APPROVED', workspace_id = $2, approved_by_user_id = $3, approved_at = $4
     WHERE id = $1 AND status = 'PENDING' AND expires_at >= $4
     RETURNING *`,
    [session.id, workspaceId, actorUserId, ts]
  );
  if (!updated[0]) {
    throw new BindingError(
      'PAIRING_SESSION_ALREADY_APPROVED',
      'This pairing code was already approved. Wait for Desktop to finish connecting.',
      409
    );
  }

  const { rows: ws } = await query(`SELECT * FROM workspaces WHERE id = $1`, [workspaceId]);
  await audit(workspaceId, actorUserId, 'PAIR_SESSION_APPROVED', {
    sessionId: session.id,
    deviceId: device.device_id,
  });
  console.log(`[PAIRING] approved sessionId=${session.id} workspace=${workspaceId} device=${device.device_id} actor=${actorUserId}`);

  return {
    mode: 'session_approved',
    workspace: ws[0],
    deviceId: device.device_id,
    deviceSecret: null,
    alreadyBound: false,
    connectionStatus: 'UNPAIRED', // until claim
    sessionId: session.id,
    firstSyncPending: true,
  };
}

/**
 * Desktop claims device_secret after APPROVED session (HTTP; socket optional wake-up).
 */
export async function claimPairingCredential({ sessionId, claimToken }) {
  if (!sessionId || !claimToken) {
    throw new BindingError('VALIDATION_ERROR', 'sessionId and claimToken required', 400);
  }
  const ts = now();
  const { rows } = await query(`SELECT * FROM desktop_pairing_sessions WHERE id = $1`, [sessionId]);
  const session = rows[0];
  if (!session) {
    throw new BindingError('PAIRING_SESSION_NOT_FOUND', 'Pairing session not found', 404);
  }
  if (hashToken(claimToken) !== session.claim_token_hash) {
    throw new BindingError('PAIRING_CODE_INVALID', 'Invalid claim token', 403);
  }
  if (session.status === 'CLAIMED') {
    throw new BindingError('PAIRING_SESSION_ALREADY_APPROVED', 'Credential already claimed and acknowledged', 409);
  }
  if (session.status === 'EXPIRED' || session.status === 'CANCELLED') {
    throw new BindingError('PAIRING_SESSION_EXPIRED', 'Pairing session is no longer valid', 400);
  }
  if (session.status !== 'APPROVED' && session.status !== 'CLAIM_PENDING_ACK') {
    // Existing PENDING (or other non-approved) session — not missing
    throw new BindingError(
      'PAIRING_SESSION_PENDING',
      'Pairing session is not approved yet',
      409
    );
  }
  if (session.expires_at < ts && session.status === 'APPROVED' && !session.claimed_at) {
    await query(`UPDATE desktop_pairing_sessions SET status = 'EXPIRED' WHERE id = $1`, [sessionId]);
    throw new BindingError('PAIRING_SESSION_EXPIRED', 'Approval expired before Desktop claimed the credential', 400);
  }
  if (!session.workspace_id) {
    throw new BindingError('WORKSPACE_REQUIRED', 'Session has no workspace', 400);
  }

  const { rows: devices } = await query(`SELECT * FROM devices WHERE device_id = $1`, [session.device_id]);
  const device = devices[0];
  if (!device) {
    throw new BindingError('PAIRING_SESSION_NOT_FOUND', 'Device not found', 404);
  }

  // Idempotent if already bound to this workspace with valid hash — rotate only for CLAIM_PENDING_ACK recovery
  const secret = generateDeviceSecret();
  const secretHash = await hashSecret(secret);
  const actorUserId = session.approved_by_user_id;

  const { rows: wsRows } = await query(`SELECT * FROM workspaces WHERE id = $1`, [session.workspace_id]);
  const workspace = wsRows[0];
  if (!workspace) {
    throw new BindingError('WORKSPACE_NOT_FOUND', 'Workspace not found', 404);
  }

  // Lock the session first so a concurrent unpair (CANCELLED) cannot lose the race after we bind.
  const { rows: locked } = await query(
    `UPDATE desktop_pairing_sessions
     SET status = 'CLAIM_PENDING_ACK', claimed_at = COALESCE(claimed_at, $2), pending_secret_hash = $3
     WHERE id = $1 AND status IN ('APPROVED', 'CLAIM_PENDING_ACK')
     RETURNING *`,
    [sessionId, ts, secretHash]
  );
  if (!locked[0]) {
    throw new BindingError('PAIRING_SESSION_EXPIRED', 'Pairing session is no longer valid', 400);
  }

  // Two Desktops can both reach APPROVED before either claims, so the winner is
  // settled here. idx_devices_one_paired_per_workspace is the real guarantee;
  // without this catch its unique violation escaped as a raw Postgres error and
  // the losing Desktop got a 500 rather than being told what actually happened.
  try {
    await query(
      `UPDATE devices SET
         workspace_id = $1,
         paired = TRUE,
         binding_status = 'ACTIVE',
         device_secret_hash = $2,
         credential_claimed_at = NULL,
         last_seen = $3
       WHERE device_id = $4`,
      [workspace.id, secretHash, ts, device.device_id]
    );
  } catch (e) {
    if (e?.code === '23505') {
      throw new BindingError('WORKSPACE_ALREADY_HAS_DESKTOP', RESTORE_REPLACE_MSG, 409);
    }
    throw e;
  }

  await query(
    `UPDATE companies SET workspace_id = $1
     WHERE device_id = $2 AND (workspace_id IS NULL OR workspace_id = $1)`,
    [workspace.id, device.device_id]
  ).catch(() => {});

  await query(
    `INSERT INTO workspace_tally_bindings (id, workspace_id, active_device_id, lineage_id, connection_status, first_bound_at, last_verified_at, updated_at)
     VALUES ($1,$2,$3,$4,'RECONNECTING',$5,$5,$5)
     ON CONFLICT (workspace_id) DO UPDATE SET
       active_device_id = EXCLUDED.active_device_id,
       connection_status = 'RECONNECTING',
       last_verified_at = EXCLUDED.last_verified_at,
       updated_at = EXCLUDED.updated_at`,
    [uuid(), workspace.id, device.device_id, uuid(), ts]
  );
  await query(
    `UPDATE workspaces SET tally_connection = 'RECONNECTING', updated_at = $2 WHERE id = $1`,
    [workspace.id, ts]
  );

  await audit(workspace.id, actorUserId, 'DEVICE_CREDENTIAL_CLAIMED', {
    sessionId,
    deviceId: device.device_id,
  });
  console.log(`[PAIRING] credential_claimed sessionId=${sessionId} workspace=${workspace.id} device=${device.device_id}`);

  return {
    workspace: { id: workspace.id, name: workspace.name },
    deviceId: device.device_id,
    deviceSecret: secret,
    connectionStatus: 'RECONNECTING',
  };
}

export async function acknowledgePairingCredential({ sessionId, deviceId, deviceSecret }) {
  if (!sessionId || !deviceId || !deviceSecret) {
    throw new BindingError('VALIDATION_ERROR', 'sessionId, deviceId and deviceSecret required', 400);
  }
  const { rows } = await query(`SELECT * FROM desktop_pairing_sessions WHERE id = $1`, [sessionId]);
  const session = rows[0];
  if (!session) {
    throw new BindingError('PAIRING_SESSION_NOT_FOUND', 'Pairing session not found', 404);
  }
  if (session.device_id !== deviceId) {
    throw new BindingError('PAIRING_CODE_INVALID', 'Device mismatch', 403);
  }
  const { rows: devices } = await query(
    `SELECT device_secret_hash FROM devices WHERE device_id = $1`,
    [deviceId]
  );
  const hash = devices[0]?.device_secret_hash;
  const { verifySecret } = await import('./deviceCredential.js');
  const ok = await verifySecret(deviceSecret, hash);
  if (!ok) {
    throw new BindingError('DEVICE_CREDENTIAL_INVALID', 'Device credential invalid', 403);
  }

  await query(
    `UPDATE desktop_pairing_sessions SET status = 'CLAIMED', pending_secret_hash = NULL WHERE id = $1`,
    [sessionId]
  );
  await query(
    `UPDATE devices SET credential_claimed_at = $2 WHERE device_id = $1`,
    [deviceId, now()]
  );
  await audit(session.workspace_id, session.approved_by_user_id, 'DEVICE_CREDENTIAL_ACKNOWLEDGED', {
    sessionId,
    deviceId,
  });
  await audit(session.workspace_id, session.approved_by_user_id, 'WORKSPACE_PAIRING_RECONNECTING', {
    deviceId,
  });
  console.log(`[PAIRING] credential_ack sessionId=${sessionId} workspace=${session.workspace_id} device=${deviceId} → RECONNECTING`);

  return { status: 'CLAIMED', connectionStatus: 'RECONNECTING' };
}

/** Legacy personal-workspace fallback removed — callers must pass workspaceId. */
export async function requireWorkspaceId(workspaceId) {
  if (!workspaceId) {
    throw new BindingError('WORKSPACE_REQUIRED', 'Workspace id is required', 400);
  }
  return String(workspaceId);
}
