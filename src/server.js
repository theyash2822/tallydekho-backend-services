import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';

import { getDb } from './db/schema.js';
import { setupSocket } from './socket/socketHandler.js';
import authRoutes from './routes/auth.js';
import pairingRoutes from './routes/pairing.js';
import companiesRoutes from './routes/companies.js';
import ingestRoutes, { setSocketService } from './routes/ingest.js';
import dataRoutes from './routes/data.js';

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3001;

// ── Socket.io ──────────────────────────────────────────────────────────────
const io = new SocketIO(httpServer, {
  cors: { origin: process.env.ALLOWED_ORIGINS?.split(',') || '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});
export const socketService = setupSocket(io);

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*', credentials: true }));
app.use(morgan('dev'));
app.use(compression());

// Larger body for ingest chunk uploads only
app.use('/ingest/chunk', express.raw({ type: '*/*', limit: '50mb' }));
app.use(express.json({ limit: '10mb' }));

// Rate limiting for auth routes
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { status: false, message: 'Too many requests' } });
app.use('/app/send-otp', authLimiter);
app.use('/app/verify-otp', authLimiter);

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' }));

// ── Routes ─────────────────────────────────────────────────────────────────
// Mobile/Web app routes — prefix /app
app.use('/app', authRoutes);
app.use('/app', companiesRoutes);
app.use('/app', dataRoutes);

// Pairing routes — both /app and /desktop
app.use('/app', pairingRoutes);
app.use('/desktop', pairingRoutes);

// Ingest (desktop sync pipeline)
app.use('/', ingestRoutes);

// ── Notify on ingest complete (wire sync → WebSocket) ──────────────────────
// Override ingest complete to emit synced event
app.post('/ingest/complete-notify', express.json(), (req, res) => {
  const secret = req.headers['x-internal-secret'];
  if (secret !== process.env.INTERNAL_SECRET) {
    return res.status(403).json({ status: false, message: 'Forbidden' });
  }
  const { userId, companyGuid } = req.body;
  if (userId) socketService.notifySynced(userId, companyGuid);
  res.json({ status: true });
});

// ── 404 ────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ status: false, message: `Route ${req.path} not found` }));

// ── Error handler ──────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ status: false, message: err.message });
});

// ── Inject socketService into ingest routes (avoid circular import) ────────
setSocketService(socketService);

// ── Start ──────────────────────────────────────────────────────────────────
getDb(); // Initialize DB

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════╗
║     TallyDekho Backend Server v1.0.0          ║
╠═══════════════════════════════════════════════╣
║  HTTP  : http://0.0.0.0:${PORT}                   ║
║  WS    : ws://0.0.0.0:${PORT}                     ║
║  Health: http://localhost:${PORT}/health           ║
╠═══════════════════════════════════════════════╣
║  Routes:                                      ║
║  POST /app/send-otp                           ║
║  POST /app/verify-otp                         ║
║  GET  /app/companies                          ║
║  POST /app/ledgers                            ║
║  POST /app/stocks                             ║
║  POST /app/vouchers          ← NEW            ║
║  POST /app/dashboard         ← NEW            ║
║  POST /app/reports/pl        ← NEW            ║
║  POST /app/reports/balance-sheet ← NEW        ║
║  GET  /desktop/pairing-code                   ║
║  POST /ingest/init                            ║
║  POST /ingest/chunk                           ║
║  POST /ingest/complete                        ║
╚═══════════════════════════════════════════════╝
  `);
});

export default app;
