// Ingest pipeline — receives chunked data from Desktop
import { Router } from 'express';
import { query } from '../db/schema.js';
import { v4 as uuid } from 'uuid';
import { processIngestedData } from '../controllers/ingestProcessor.js';

let _socketService = null;
export function setSocketService(s) { _socketService = s; }
const socketService = { notifySynced: (...args) => _socketService?.notifySynced(...args) };

const router = Router();
const now = () => Math.floor(Date.now() / 1000);

// POST /desktop/init-sync
router.post('/desktop/init-sync', async (req, res) => {
  const deviceId = req.headers['device-id'];
  const { companies } = req.body || {};
  console.log(`[SYNC] init-sync from device ${deviceId}, companies: ${companies?.length}`);

  try {
    const { rows: devices } = await query('SELECT * FROM devices WHERE device_id = $1', [deviceId]);
    const device = devices[0];
    const userId = device?.user_id;

    if (!userId) return res.status(403).json({ status: false, message: 'Device not paired' });

    const alterIds = {};
    if (companies) {
      for (const c of companies) {
        const { rows: lRows } = await query('SELECT MAX(alter_id) as max FROM ledgers WHERE company_guid = $1', [c.guid]);
        alterIds[c.guid] = { master: lRows[0]?.max || 0, voucher: {} };

        try {
          await query(`
            INSERT INTO companies (guid, user_id, device_id, name, formal_name, gstin, fy_start, fy_end, synced_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (guid) DO UPDATE SET
              name = EXCLUDED.name, formal_name = EXCLUDED.formal_name,
              gstin = EXCLUDED.gstin, fy_start = EXCLUDED.fy_start,
              fy_end = EXCLUDED.fy_end, synced_at = EXCLUDED.synced_at
          `, [c.guid, userId, deviceId, c.name || c.NAME || 'Unknown', c.formalName || c.name || '',
              c.gstin || c.GSTIN || null, c.startingFrom || null, c.endingAt || null, now()]);
          console.log(`[DB] Company saved: ${c.name || c.guid}`);

          // Store all financial years for this company
          const allYears = c.allYears || c.years || [];
          console.log(`[DB] Years for ${c.name}:`, allYears.length, allYears[0]);
          for (const y of allYears) {
            // finYear can be '2017-2018' or '2017-18' or just a string
            const finYear = y.finYear || y.fin_year || y.name || null;
            const beginDate = y.begin || y.beginDate || y.startDate || null;
            const endDate = y.end || y.endDate || null;
            if (!finYear || !beginDate || !endDate) {
              console.log('[DB] Skipping year (missing fields):', y);
              continue;
            }
            // Normalize: '20170401' -> '2017-04-01'
            const norm = d => d && d.length === 8 ? `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}` : d;
            try {
              await query(`
                INSERT INTO company_years (company_guid, fin_year, begin_date, end_date)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (company_guid, fin_year) DO UPDATE SET
                  begin_date = EXCLUDED.begin_date, end_date = EXCLUDED.end_date
              `, [c.guid, finYear, norm(beginDate), norm(endDate)]);
            } catch (ye) { console.warn('[DB] Year insert failed:', ye.message, y); }
          }
        } catch (e) {
          console.warn('[DB] Company save failed:', e.message);
        }
      }
    }

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
  } catch (err) {
    console.error('[SYNC] init-sync error:', err.message);
    res.status(500).json({ status: false, message: 'Sync init failed' });
  }
});

// POST /ingest/init
router.post('/ingest/init', async (req, res) => {
  const deviceId = req.headers['device-id'];
  const uploadId = uuid();
  try {
    await query('INSERT INTO ingest_uploads (id, device_id) VALUES ($1, $2)', [uploadId, deviceId]);
    console.log(`[INGEST] init upload ${uploadId} from device ${deviceId}`);
    res.json({ status: true, data: { uploadId } });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Init failed' });
  }
});

// POST /ingest/chunk
router.post('/ingest/chunk', async (req, res) => {
  const uploadId  = req.headers['upload-id'];
  const streamName = req.headers['stream-name'];
  const chunkIndex = parseInt(req.headers['chunk-index'] || '0');
  const deviceId  = req.headers['device-id'];

  if (!uploadId || !streamName) return res.status(400).json({ status: false, message: 'Missing headers' });

  try {
    const { rows: devices } = await query('SELECT * FROM devices WHERE device_id = $1', [deviceId]);
    const device = devices[0];
    const userId = device?.user_id;

    let data;
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
    if (typeof raw === 'string') {
      const lines = raw.trim().split('\n').filter(Boolean);
      data = lines.length > 1
        ? lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        : JSON.parse(raw);
    } else {
      data = raw;
    }
    if (!Array.isArray(data)) data = data ? [data] : [];

    let companyGuid = req.headers['company-guid'];
    if (!companyGuid && data.length > 0) {
      companyGuid = data[0]?.COMPANY_GUID || data[0]?.company_guid || null;
    }
    if (!companyGuid) {
      const { rows } = await query('SELECT company_guid FROM ingest_uploads WHERE id = $1', [uploadId]);
      companyGuid = rows[0]?.company_guid;
    }
    if (companyGuid) {
      await query('UPDATE ingest_uploads SET company_guid = $1 WHERE id = $2', [companyGuid, uploadId]);
    }

    console.log(`[INGEST] chunk ${chunkIndex} | stream: ${streamName} | company: ${companyGuid || 'unknown'} | records: ${data.length}`);

    if (data.length > 0) {
      await processIngestedData(streamName, data, companyGuid, userId, deviceId);
    }

    await query('UPDATE ingest_uploads SET chunks = chunks + 1 WHERE id = $1', [uploadId]);
    res.json({ status: true, data: { received: true, chunkIndex } });
  } catch (err) {
    console.error('[INGEST] chunk error:', err.message);
    res.status(500).json({ status: false, message: 'Chunk processing failed' });
  }
});

// POST /ingest/complete
router.post('/ingest/complete', async (req, res) => {
  let body = req.body;
  if (Buffer.isBuffer(body)) { try { body = JSON.parse(body.toString()); } catch { body = {}; } }
  const { uploadId } = body || {};
  let { companyGuid } = body || {};
  const deviceId = req.headers['device-id'];

  try {
    if (!companyGuid && uploadId) {
      const { rows } = await query('SELECT company_guid FROM ingest_uploads WHERE id = $1', [uploadId]);
      companyGuid = rows[0]?.company_guid;
    }

    await query('UPDATE ingest_uploads SET status = $1, completed_at = $2 WHERE id = $3', ['complete', now(), uploadId || '']);
    await query('UPDATE devices SET last_seen = $1 WHERE device_id = $2', [now(), deviceId]);

    const { rows: devices } = await query('SELECT * FROM devices WHERE device_id = $1', [deviceId]);
    const userId = devices[0]?.user_id;

    if (companyGuid) {
      await query('UPDATE companies SET synced_at = $1 WHERE guid = $2', [now(), companyGuid]);
      await query(`INSERT INTO sync_log (company_guid, device_id, stream, status, completed_at) VALUES ($1, $2, 'complete', 'success', $3)`,
        [companyGuid, deviceId, now()]);
    }

    console.log(`[INGEST] ✅ Sync complete | device: ${deviceId} | company: ${companyGuid} | user: ${userId}`);

    if (userId) {
      try { socketService.notifySynced(userId, companyGuid); } catch (e) { console.warn('[WS] emit failed:', e.message); }
    }

    res.json({ status: true, message: 'Sync complete' });
  } catch (err) {
    console.error('[INGEST] complete error:', err.message);
    res.status(500).json({ status: false, message: 'Complete failed' });
  }
});

export default router;
