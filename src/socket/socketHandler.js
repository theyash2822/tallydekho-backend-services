// WebSocket handler — same events as mobile app expects
// Events: synced, unpaired, logout, register

import jwt from 'jsonwebtoken';

const connectedClients = new Map(); // token/deviceId → socket

export function setupSocket(io) {
  io.on('connection', (socket) => {
    console.log(`[WS] client connected: ${socket.id}`);

    // Mobile/Web registers with token
    socket.on('register', ({ token, type }) => {
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        const userId = payload.userId;
        socket.userId = userId;
        socket.clientType = type || 'mobile'; // 'mobile' | 'web' | 'desktop'
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

    // Called when device is unpaired
    notifyUnpaired: (userId) => {
      ['mobile', 'web'].forEach(type => {
        const client = connectedClients.get(`${type}_${userId}`);
        if (client?.connected) client.emit('unpaired', {});
      });
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
