// WebSocket handler — same events as mobile app expects
// Events: synced, unpaired, logout, register

import jwt from 'jsonwebtoken';
import { query } from '../db/schema.js';
// Lazy import to avoid circular dep at startup
let _retryOfflineEntries = null;
setTimeout(async () => {
  const mod = await import('../routes/tally-write.js');
  _retryOfflineEntries = mod.retryOfflineEntries;
}, 1000);

// ── Module-level io reference (set by setupSocket) ────────────────────────────
let _io = null;

// ── Voucher lifecycle emitters ────────────────────────────────────────────────
// Clients join `company:<guid>` room when they register (see register handler below).

export function emitVoucherRegularized(companyGuid, tdkRef, tallyVoucherNo) {
  if (!_io) return;
  _io.to(`company:${companyGuid}`).emit('voucher:regularized', {
    companyGuid,
    tdkReferenceNo: tdkRef,
    tallyVoucherNo,
    currentEntryType: 'regular',
    booksImpactStatus: 'posted',
    conversionStatus: 'converted',
    timestamp: new Date().toISOString(),
  });
  console.log(`[socket] voucher:regularized emitted for ${tdkRef}`);
}

export function emitVoucherSynced(companyGuid, tdkRef, tallyVoucherNo) {
  if (!_io) return;
  _io.to(`company:${companyGuid}`).emit('voucher:tallySynced', {
    companyGuid,
    tdkReferenceNo: tdkRef,
    tallyVoucherNo,
    tallySyncStatus: 'synced',
    booksImpactStatus: 'posted',
    timestamp: new Date().toISOString(),
  });
  // Spec-compliant event for the invoice preview/share flow
  _io.to(`company:${companyGuid}`).emit('invoice_posting_updated', {
    referenceNumber: tdkRef,
    postingTag: 'Posted',
    invoiceNumberLabel: tallyVoucherNo,
    tallyVoucherNo,
    timestamp: new Date().toISOString(),
  });
  console.log(`[socket] voucher:tallySynced + invoice_posting_updated emitted for ${tdkRef}`);
}

const connectedClients = new Map(); // token/deviceId → socket

export function setupSocket(io) {
  _io = io; // Store reference for module-level emitters

  io.on('connection', (socket) => {
    console.log(`[WS] client connected: ${socket.id}`);

    // Mobile/Web registers with token
    socket.on('register', ({ token, type, deviceId, deviceSecret }) => {
      // Desktop sends: { type: 'desktop', deviceId, deviceSecret? }
      if (type === 'desktop' && deviceId) {
        query('SELECT user_id, workspace_id, device_secret_hash, paired, binding_status FROM devices WHERE device_id=$1 LIMIT 1', [deviceId])
          .then(async ({ rows }) => {
            const d = rows[0];
            if (d?.device_secret_hash) {
              const { verifySecret } = await import('../services/deviceCredential.js');
              const ok = deviceSecret ? await verifySecret(deviceSecret, d.device_secret_hash) : false;
              if (!ok) {
                socket.emit('error', { code: 'DEVICE_CREDENTIAL_INVALID', message: 'Device credential invalid' });
                return;
              }
            }
            socket.deviceId = deviceId;
            socket.clientType = 'desktop';
            connectedClients.set(`desktop_${deviceId}`, socket);
            console.log(`[WS] registered desktop via register event: ${deviceId}`);
            socket.emit('registered', { status: true });
            if (!d || !d.paired) return;
            if (d.workspace_id) socket.join(`workspace:${d.workspace_id}`);
            const userId = d.user_id;
            const workspaceId = d.workspace_id || null;
            if (_retryOfflineEntries) {
              console.log(`[WS] desktop ${deviceId} online — auto-retrying offline entries`);
              _retryOfflineEntries(userId, null, workspaceId);
            }
            const pendingSql = workspaceId
              ? `SELECT COUNT(*) AS cnt FROM write_queue
                 WHERE workspace_id=$1 AND status IN ('desktop_offline','failed') AND attempt_count < 5
                 AND (lock_expires_at IS NULL OR lock_expires_at < EXTRACT(EPOCH FROM NOW())::BIGINT)`
              : `SELECT COUNT(*) AS cnt FROM write_queue
                 WHERE user_id=$1 AND status IN ('desktop_offline','failed') AND attempt_count < 5
                 AND (lock_expires_at IS NULL OR lock_expires_at < EXTRACT(EPOCH FROM NOW())::BIGINT)`;
            const { rows: pendingRows } = await query(pendingSql, [workspaceId || userId]).catch(() => ({ rows: [] }));
            const pendingCount = parseInt(pendingRows[0]?.cnt || 0, 10);
            if (pendingCount) {
              socket.emit('pending_tally_writeback_available', {
                count: pendingCount,
                entityType: 'mixed',
                workspaceId: workspaceId || null,
              });
            }
          }).catch(() => {});
        return;
      }
      // Web/mobile: token-based
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        const userId = payload.userId;
        socket.userId = userId;
        socket.clientType = type || 'mobile';
        connectedClients.set(`${type}_${userId}`, socket);
        console.log(`[WS] registered ${type} client for user ${userId}`);
        socket.emit('registered', { status: true });
        // Join company room so targeted lifecycle events reach this client
        query('SELECT guid FROM companies WHERE user_id=$1 AND is_active=TRUE ORDER BY synced_at DESC NULLS LAST LIMIT 1', [userId])
          .then(({ rows }) => {
            if (rows[0]?.guid) {
              socket.join(`company:${rows[0].guid}`);
              console.log(`[WS] user ${userId} joined company room: ${rows[0].guid}`);
            }
          }).catch(() => {});
      } catch {
        socket.emit('error', { message: 'Invalid token' });
      }
    });

    // Mobile/Web: join workspace room after picking active Workspace (JWT stays user-only)
    socket.on('workspace:register', async ({ workspaceId }) => {
      try {
        if (!socket.userId || !workspaceId) return;
        const { rows } = await query(
          `SELECT status FROM workspace_memberships
           WHERE workspace_id = $1 AND user_id = $2 AND status = 'ACTIVE' LIMIT 1`,
          [workspaceId, socket.userId]
        );
        if (!rows[0]) {
          socket.emit('workspace_access_denied', { workspaceId });
          return;
        }
        if (socket.workspaceRoom) socket.leave(socket.workspaceRoom);
        if (Array.isArray(socket.companyRooms)) {
          for (const room of socket.companyRooms) socket.leave(room);
        }
        socket.companyRooms = [];
        socket.workspaceRoom = `workspace:${workspaceId}`;
        socket.join(socket.workspaceRoom);
        socket.workspaceId = workspaceId;
        console.log(`[WS] user ${socket.userId} joined ${socket.workspaceRoom}`);
        const { rows: cos } = await query(
          `SELECT guid FROM companies
           WHERE (workspace_id = $1 OR (workspace_id IS NULL AND user_id = (
             SELECT owner_user_id FROM workspaces WHERE id = $1
           ))) AND (is_active = TRUE OR is_active IS NULL)`,
          [workspaceId]
        );
        for (const c of cos) {
          if (c.guid) {
            const room = `company:${c.guid}`;
            socket.join(room);
            socket.companyRooms.push(room);
          }
        }
        socket.emit('workspace_registered', { workspaceId, companies: cos.map((c) => c.guid) });
      } catch (err) {
        console.warn('[WS] workspace:register failed', err.message);
      }
    });

    socket.on('company:register', async ({ companyGuid }) => {
      try {
        if (!companyGuid || !socket.userId) return;
        const workspaceId = socket.workspaceId;
        if (!workspaceId) {
          socket.emit('company_access_denied', { companyGuid, code: 'WORKSPACE_REQUIRED' });
          return;
        }
        const { rows: mem } = await query(
          `SELECT id, membership_type FROM workspace_memberships
           WHERE workspace_id = $1 AND user_id = $2 AND status = 'ACTIVE' LIMIT 1`,
          [workspaceId, socket.userId]
        );
        if (!mem[0]) {
          socket.emit('company_access_denied', { companyGuid, code: 'WORKSPACE_ACCESS_DENIED' });
          return;
        }
        const { rows: cos } = await query(
          `SELECT guid FROM companies
           WHERE guid = $1 AND (
             workspace_id = $2
             OR (workspace_id IS NULL AND user_id = (SELECT owner_user_id FROM workspaces WHERE id = $2))
           ) LIMIT 1`,
          [companyGuid, workspaceId]
        );
        if (!cos[0]) {
          socket.emit('company_access_denied', { companyGuid, code: 'COMPANY_SCOPE_DENIED' });
          return;
        }
        if (mem[0].membership_type !== 'OWNER') {
          try {
            const { assertCompanyAccess } = await import('../services/scopeService.js');
            await assertCompanyAccess(mem[0].id, companyGuid);
          } catch {
            socket.emit('company_access_denied', { companyGuid, code: 'COMPANY_SCOPE_DENIED' });
            return;
          }
        }
        const room = `company:${companyGuid}`;
        if (!Array.isArray(socket.companyRooms)) socket.companyRooms = [];
        if (!socket.companyRooms.includes(room)) {
          socket.join(room);
          socket.companyRooms.push(room);
        }
      } catch (err) {
        console.warn('[WS] company:register failed', err.message);
      }
    });

    // Desktop registers with device-id
    socket.on('register_desktop', ({ deviceId }) => {
      socket.deviceId = deviceId;
      socket.clientType = 'desktop';
      connectedClients.set(`desktop_${deviceId}`, socket);
      console.log(`[WS] registered desktop: ${deviceId}`);
      // Auto-retry offline entries for this device
      query('SELECT user_id, workspace_id FROM devices WHERE device_id=$1 AND paired=TRUE LIMIT 1', [deviceId])
        .then(({ rows }) => {
          if (rows[0] && _retryOfflineEntries) {
            console.log(`[WS] desktop ${deviceId} online — auto-retrying offline entries`);
            _retryOfflineEntries(rows[0].user_id, null, rows[0].workspace_id || null);
          }
        }).catch(() => {});
    });

    // Mobile emits this on manual logout so server cleans up immediately
    socket.on('client-disconnect', () => {
      console.log(`[WS] client-disconnect from ${socket.id} (manual logout)`);
      for (const [key, s] of connectedClients.entries()) {
        if (s.id === socket.id) connectedClients.delete(key);
      }
      socket.disconnect(true);
    });

    socket.on('disconnect', () => {
      console.log(`[WS] disconnected: ${socket.id}`);
      for (const [key, s] of connectedClients.entries()) {
        if (s.id === socket.id) connectedClients.delete(key);
      }
    });
  });

  return {
    // Called after ingest complete — notifies mobile/web that new data is available
    notifySynced: (userId, companyGuid) => {
      const payload = { companyGuid, syncedAt: new Date().toISOString() };
      ['mobile', 'web'].forEach(type => {
        const client = connectedClients.get(`${type}_${userId}`);
        if (client?.connected) {
          client.emit('synced', payload);
          console.log(`[WS] notified ${type} client for user ${userId}`);
        }
      });
    },

    // Called when device is successfully paired - refresh all clients
    notifyPaired: (userId, deviceName) => {
      ['mobile', 'web'].forEach(type => {
        const client = connectedClients.get(`${type}_${userId}`);
        if (client?.connected) {
          client.emit('paired', { deviceName, pairedAt: new Date().toISOString() });
          console.log(`[WS] notified ${type} client: paired for user ${userId}`);
        }
      });
    },

    notifyDesktop: (deviceId, event, payload) => {
      const s = connectedClients.get(`desktop_${deviceId}`);
      if (s?.connected) s.emit(event, payload);
    },

    notifyWorkspaceRoom: (workspaceId, event, payload) => {
      if (!_io || !workspaceId) return;
      _io.to(`workspace:${workspaceId}`).emit(event, payload);
    },

    notifyWorkspace: (userId, event, payload) => {
      ['mobile', 'web'].forEach(type => {
        const client = connectedClients.get(`${type}_${userId}`);
        if (client?.connected) client.emit(event, payload);
      });
    },

    // Called when device is unpaired
    // newCode: the freshly generated replacement pairing code (for desktop to display)
    notifyUnpaired: (userId, newCode) => {
      // Notify mobile + web: they are now unpaired
      ['mobile', 'web'].forEach(type => {
        const client = connectedClients.get(`${type}_${userId}`);
        if (client?.connected) client.emit('unpaired', {});
      });
      // Notify desktop: update pairing panel with the new code
      for (const [key, s] of connectedClients.entries()) {
        if (key.startsWith('desktop_') && s?.connected) {
          s.emit('unpaired', { newCode: newCode || null });
        }
      }
    },

    // Force logout (e.g. login on another device)
    notifyLogout: (userId) => {
      ['mobile', 'web'].forEach(type => {
        const client = connectedClients.get(`${type}_${userId}`);
        if (client?.connected) client.emit('logout', {});
      });
    },

    connectedClients,
    // Expose lifecycle emitters via socketService for callers that use the injected service
    emitVoucherRegularized,
    emitVoucherSynced,
  };
}
