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

const connectedClients = new Map(); // token/deviceId → socket

export function setupSocket(io) {
  io.on('connection', (socket) => {
    console.log(`[WS] client connected: ${socket.id}`);

    // Mobile/Web registers with token
    socket.on('register', ({ token, type, deviceId }) => {
      // Desktop sends: { type: 'desktop', deviceId } (no token)
      if (type === 'desktop' && deviceId) {
        socket.deviceId = deviceId;
        socket.clientType = 'desktop';
        connectedClients.set(`desktop_${deviceId}`, socket);
        console.log(`[WS] registered desktop via register event: ${deviceId}`);
        socket.emit('registered', { status: true });
        // Auto-retry offline entries
        query('SELECT user_id FROM devices WHERE device_id=$1 AND paired=TRUE LIMIT 1', [deviceId])
          .then(({ rows }) => {
            if (rows[0] && _retryOfflineEntries) {
              console.log(`[WS] desktop ${deviceId} online — auto-retrying offline entries`);
              _retryOfflineEntries(rows[0].user_id, null);
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
      } catch {
        socket.emit('error', { message: 'Invalid token' });
      }
    });

    // Desktop registers with device-id
    socket.on('register_desktop', ({ deviceId }) => {
      socket.deviceId = deviceId;
      socket.clientType = 'desktop';
      connectedClients.set(`desktop_${deviceId}`, socket);
      console.log(`[WS] registered desktop: ${deviceId}`);
      // Auto-retry offline entries for this device
      query('SELECT user_id FROM devices WHERE device_id=$1 AND paired=TRUE LIMIT 1', [deviceId])
        .then(({ rows }) => {
          if (rows[0] && _retryOfflineEntries) {
            console.log(`[WS] desktop ${deviceId} online — auto-retrying offline entries`);
            _retryOfflineEntries(rows[0].user_id, null);
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
      // Also notify the desktop so it refreshes its state
      for (const [key, s] of connectedClients.entries()) {
        if (key.startsWith('desktop_') && s?.connected) {
          s.emit('pairing_confirmed', { userId, pairedAt: new Date().toISOString() });
        }
      }
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
  };
}
