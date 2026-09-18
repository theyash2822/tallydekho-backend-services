/**
 * HTTP + Socket.IO app factory for production server and RBAC integration tests.
 * Does not listen and does not start the scheduler.
 */
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';

import { setupSocket } from './socket/socketHandler.js';
import tallyWriteRoutes, { setTallyWriteSocket } from './routes/tally-write.js';
import authRoutes from './routes/auth.js';
import aiRoutes from './routes/ai.js';
import pairingRoutes from './routes/pairing.js';
import ingestRoutes, { setSocketService } from './routes/ingest.js';
import { setPairingSocket } from './routes/pairing.js';
import apiV1Routes, { setApiSocket } from './routes/api-v1.js';
import desktopWorkspaceRoutes, { localObjectPutHandler, localObjectGetHandler, setDesktopWorkspaceSocket } from './routes/desktopWorkspace.js';
import { setWorkspaceApiSocket } from './routes/workspaceApi.js';
import { setWorkspaceSocket } from './socket/workspaceEmit.js';

export function createApp() {
  const app = express();
  app.set('etag', false);
  const httpServer = createServer(app);
  const io = new SocketIO(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'], credentials: true },
    transports: ['websocket', 'polling'],
  });
  const socketService = setupSocket(io);

  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: '*', credentials: true }));
  app.use(compression());
  app.use('/ingest/chunk', express.raw({ type: '*/*', limit: '50mb' }));
  app.use('/desktop/backup/objects/:token', express.raw({ type: '*/*', limit: '2gb' }));
  // Razorpay signs the exact bytes it sent. Parsing to an object and
  // re-serialising changes key order and escaping, so the HMAC never matched and
  // every webhook was rejected as an invalid signature.
  app.use('/api/billing/webhooks/razorpay', express.raw({ type: '*/*', limit: '1mb' }));
  app.use(express.json({ limit: '10mb' }));

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, message: { status: false, message: 'Too many requests' } });
  // LEGACY-BLOCK-APP-AUTH: /app OTP/me retained for abandoned pre-V4 clients until traffic=0
  app.use('/app/send-otp', authLimiter);
  app.use('/app/verify-otp', authLimiter);

  app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

  app.use('/app', authRoutes);
  // Phase 5: /app data + companies + pairing mounts deleted — use /api and /desktop
  app.use('/api/ai', aiRoutes);
  app.use('/desktop', pairingRoutes);
  app.put('/desktop/backup/objects/:token', localObjectPutHandler);
  app.get('/desktop/backup/objects/:token', localObjectGetHandler);
  app.use('/desktop', desktopWorkspaceRoutes);
  app.use('/tally', tallyWriteRoutes);
  app.use('/api', apiV1Routes);
  app.use('/', ingestRoutes);

  app.use((req, res) => res.status(404).json({ status: false, message: `Route ${req.path} not found` }));
  app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ status: false, message: err.message });
  });

  setSocketService(socketService);
  setTallyWriteSocket(socketService);
  setPairingSocket(socketService);
  setApiSocket(socketService);
  setDesktopWorkspaceSocket(socketService);
  setWorkspaceApiSocket(socketService);
  setWorkspaceSocket(socketService);

  return { app, httpServer, io, socketService };
}
