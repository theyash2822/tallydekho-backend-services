// Ingest pipeline — receives chunked data from Desktop app
// Matches Desktop's xml.js upload protocol exactly
import { Router } from 'express';
import { getDb } from '../db/schema.js';
import { v4 as uuid } from 'uuid';
import { processIngestedData } from '../controllers/ingestProcessor.js';
// socketService injected at runtime to avoid circular import
let _socketService = null;
export function setSocketService(s) { _socketService = s; }
const socketService = { notifySynced: (...args) => _socketService?.notifySynced(...args) };

const router = Router();

// POST /desktop/init-sync — Desktop calls before sync
router.post('/desktop/init-sync', (req, res) => {
  const deviceId = req.headers['device-id'];
  const { companies } = req.body || {};
  console.log(`[SYNC] init-sync from device ${deviceId}, companies: ${companies?.length}`);

  const db = getDb();
  const device = db.prepare('SELECT * FROM devices WHERE device_id=?').get(deviceId);
  const userId = device?.user_id;

  if (!userId) return res.status(403).json({ status: false, message: 'Device not paired' });

  // Build alter IDs response (tells desktop what data is already synced)
  const alterIds = {};
  if (companies) {
    companies.forEach(c => {
      const latestLedger = db.prepare('SELECT MAX(alter_id) as max FROM ledgers WHERE company_guid=?').get(c.guid);
      const latestVoucher = db.prepare('SELECT MAX(alter_id) as max FROM vouchers WHERE company_guid=?').get(c.guid);
      alterIds[c.guid] = {
        master: latestLedger?.max || 0,
        voucher: {},
      };
    });
  }

  // Year IDs mapping
  const yearIds = {};
  if (companies) {
    companies.forEach(c => {
      yearIds[c.id || c.guid] = {};
      (c.allYears || c.years || []).forEach(y => {
        yearIds[c.id || c.guid][y.finYear || y] = `${c.guid}_${y.finYear || y}`;
      });
    });
  }

  res.json({ status: true, data: { alterIds, yearIds, uploadId: uuid() } });
});

// POST /ingest/init — Start a chunked upload
router.post('/ingest/init', (req, res) => {
  const deviceId = req.headers['device-id'];
  const uploadId = uuid();
  const db = getDb();
  const device = db.prepare('SELECT * FROM devices WHERE device_id=?').get(deviceId);
  db.prepare('INSERT INTO ingest_uploads (id, device_id) VALUES (?, ?)').run(uploadId, deviceId);
  console.log(`[INGEST] init upload ${uploadId} from device ${deviceId}`);
  res.json({ status: true, data: { uploadId } });
});

// POST /ingest/chunk — Receive data chunk
router.post('/ingest/chunk', async (req, res) => {
  const uploadId = req.headers['upload-id'];
  const streamName = req.headers['stream-name'];
  const chunkIndex = parseInt(req.headers['chunk-index'] || '0');
  const deviceId = req.headers['device-id'];

  if (!uploadId || !streamName) return res.status(400).json({ status: false, message: 'Missing headers' });

  const db = getDb();
  const device = db.prepare('SELECT * FROM devices WHERE device_id=?').get(deviceId);
  const userId = device?.user_id;

  // Parse the incoming data — desktop sends ndjson or json
  let data;
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
    if (typeof raw === 'string') {
      // Try NDJSON first (one JSON object per line)
      const lines = raw.trim().split('\n').filter(Boolean);
      if (lines.length > 1) {
        data = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } else {
        data = JSON.parse(raw);
      }
    } else {
      data = raw;
    }
  } catch {
    data = req.body;
  }

  if (!Array.isArray(data)) data = data ? [data] : [];

  // Extract companyGuid from data items (desktop embeds COMPANY_GUID in each record)
  let companyGuid = req.headers['company-guid'];
  if (!companyGuid && data.length > 0) {
    companyGuid = data[0]?.COMPANY_GUID || data[0]?.company_guid || null;
  }

  // Also try to get from upload record
  if (!companyGuid) {
    const upload = db.prepare('SELECT company_guid FROM ingest_uploads WHERE id=?').get(uploadId);
    companyGuid = upload?.company_guid;
  }

  // Save companyGuid to upload record if we found it
  if (companyGuid) {
    db.prepare('UPDATE ingest_uploads SET company_guid=? WHERE id=?').run(companyGuid, uploadId);
  }

  console.log(`[INGEST] chunk ${chunkIndex} | stream: ${streamName} | company: ${companyGuid || 'unknown'} | records: ${data.length}`);

  // Process chunk immediately
  if (data.length > 0) {
    try {
      await processIngestedData(db, streamName, data, companyGuid, userId, deviceId);
    } catch (err) {
      console.error('[INGEST] Processing error:', err.message);
    }
  }

  // Update chunk count
  db.prepare('UPDATE ingest_uploads SET chunks=chunks+1 WHERE id=?').run(uploadId);

  res.json({ status: true, data: { received: true, chunkIndex } });
});

// POST /ingest/complete — Finalize upload + notify mobile/web via WebSocket
router.post('/ingest/complete', async (req, res) => {
  let body = req.body;
  if (Buffer.isBuffer(body)) {
    try { body = JSON.parse(body.toString()); } catch { body = {}; }
  }
  const { uploadId } = body || {};
  let { companyGuid } = body || {};
  const deviceId = req.headers['device-id'];

  const db = getDb();

  // Get companyGuid from upload record if not in body
  if (!companyGuid && uploadId) {
    const upload = db.prepare('SELECT company_guid FROM ingest_uploads WHERE id=?').get(uploadId);
    companyGuid = upload?.company_guid;
  }

  db.prepare('UPDATE ingest_uploads SET status=?, completed_at=unixepoch() WHERE id=?').run('complete', uploadId || '');
  db.prepare('UPDATE devices SET last_seen=unixepoch() WHERE device_id=?').run(deviceId);

  const device = db.prepare('SELECT * FROM devices WHERE device_id=?').get(deviceId);
  const userId = device?.user_id;

  if (companyGuid) {
    db.prepare('UPDATE companies SET synced_at=unixepoch() WHERE guid=?').run(companyGuid);
    db.prepare(`INSERT INTO sync_log (company_guid, device_id, stream, status, completed_at)
      VALUES (?, ?, 'complete', 'success', unixepoch())`).run(companyGuid, deviceId);
  }

  console.log(`[INGEST] ✅ Sync complete | device: ${deviceId} | company: ${companyGuid} | user: ${userId}`);

  // 🔔 Notify mobile + web portal via WebSocket
  if (userId) {
    try {
      socketService.notifySynced(userId, companyGuid);
      console.log(`[WS] Emitted 'synced' to user ${userId}`);
    } catch (e) {
      console.warn('[WS] Could not emit synced:', e.message);
    }
  }

  res.json({ status: true, message: 'Sync complete' });
});

export default router;
