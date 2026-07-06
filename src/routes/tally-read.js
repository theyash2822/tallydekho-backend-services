// Tally Read API — fetches master collections from Tally via desktop proxy.
// Flow: App → Backend → Desktop (via WebSocket 'tally:read') → Tally HTTP :9000
//
// Purpose: Fetch country + state masters from Tally directly so the mobile
// Party Form dropdowns match Tally's canonical spellings (each installation
// may have different masters — worldwide countries, custom states, etc.).
//
// Strategy: fetch ONCE per company on first request. Cache in DB forever.
// No manual refresh button, no piggyback on sync, no auto-refresh timer.
// If Tally adds new masters in future, we deal with it then (rare event).
//
// Fallback: if desktop is offline or fetch fails, endpoints return whatever
// cache exists (may be empty). Mobile handles empty response by falling back
// to hardcoded COUNTRIES + INDIAN_STATES constants. Form never breaks.
//
// Endpoints:
//   GET /api/tally/masters/countries → { status, data: [{name}] }
//   GET /api/tally/masters/states    → { status, data: [{name, country, gstStateCode}] }
//
// Auth: authMiddleware (same as /api/parties)
// Scope: per-company (companyGuid required via query param)

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { authMiddleware } from '../middleware/auth.js';
import { query } from '../db/schema.js';

// Socket service reference — injected from server.js after startup
let _socketService = null;
export function setTallyReadSocket(s) { _socketService = s; }

const router = Router();

// ── XML payloads (from user 2026-07-06 — verified TDL collection format) ─────
const XML_COUNTRIES = `<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE>
  <ID>TDKCountryCollection</ID>
 </HEADER>
 <BODY>
  <DESC>
   <STATICVARIABLES>
    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
   </STATICVARIABLES>
   <TDL>
    <TDLMESSAGE>
     <COLLECTION NAME="TDKCountryCollection" ISMODIFY="No">
      <TYPE>Country</TYPE>
      <NATIVEMETHOD>Name</NATIVEMETHOD>
     </COLLECTION>
    </TDLMESSAGE>
   </TDL>
  </DESC>
 </BODY>
</ENVELOPE>`;

const XML_STATES = `<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE>
  <ID>TDKStateCountryCollection</ID>
 </HEADER>
 <BODY>
  <DESC>
   <STATICVARIABLES>
    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
   </STATICVARIABLES>
   <TDL>
    <TDLMESSAGE>
     <COLLECTION NAME="TDKStateCountryCollection" ISMODIFY="No">
      <TYPE>State</TYPE>
      <NATIVEMETHOD>Name</NATIVEMETHOD>
      <NATIVEMETHOD>CountryName</NATIVEMETHOD>
      <NATIVEMETHOD>GSTStateCode</NATIVEMETHOD>
     </COLLECTION>
    </TDLMESSAGE>
   </TDL>
  </DESC>
 </BODY>
</ENVELOPE>`;

// ── Helper: sanitize Tally sentinel values ────────────────────────────────────
// Tally returns "♦ Not Applicable", "Any Country", "Any State" etc. as
// meta-entries. Filter these out — no user should ever pick them.
const isMetaValue = (s) => {
  if (!s || typeof s !== 'string') return true;
  const trimmed = s.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('♦')) return true;
  if (lower === 'not applicable') return true;
  if (lower === 'any country') return true;
  if (lower === 'any state') return true;
  if (lower === 'end of list') return true;
  return false;
};

// ── Helper: forward XML to desktop via WebSocket, return raw XML response ────
async function fetchFromTallyViaDesktop(companyGuid, userId, xmlBody) {
  console.log('[tally-read] fetchFromTallyViaDesktop start', { companyGuid, userId, xmlLen: xmlBody?.length });
  const { rows } = await query(
    'SELECT * FROM devices WHERE user_id = $1 AND paired = TRUE ORDER BY last_seen DESC LIMIT 1',
    [userId]
  );
  const device = rows[0];
  console.log('[tally-read] device lookup', { found: !!device, deviceId: device?.device_id?.slice(0, 12) });
  if (!device) throw new Error('No paired desktop found');

  if (!_socketService || !_socketService.connectedClients) {
    console.log('[tally-read] socket service check FAIL', { hasService: !!_socketService, hasMap: !!_socketService?.connectedClients });
    throw new Error('Socket service not initialised');
  }
  const socketKey = 'desktop_' + device.device_id;
  const desktopSocket = _socketService.connectedClients.get(socketKey);
  const allKeys = Array.from(_socketService.connectedClients.keys()).map(k => k.length > 40 ? k.slice(0, 20) + '...' : k);
  console.log('[tally-read] socket lookup', { socketKey: socketKey.slice(0, 30) + '...', found: !!desktopSocket, connected: desktopSocket?.connected, allKeys });
  if (!desktopSocket || !desktopSocket.connected) {
    throw new Error('Desktop not connected');
  }

  const jobId = randomUUID();
  console.log('[tally-read] emitting tally:read event', { jobId });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.log('[tally-read] TIMEOUT after 5s', { jobId });
      reject(new Error('Tally read timeout (5s) — Tally may not be running'));
    }, 5000);
    desktopSocket.emit('tally:read', { jobId, xml: xmlBody }, (result) => {
      clearTimeout(timeout);
      console.log('[tally-read] callback received', { jobId, status: result?.status, dataLen: result?.data?.length, msg: result?.message });
      if (result && result.status && result.data) {
        resolve(result.data);
      } else {
        reject(new Error((result && result.message) || 'Tally read failed'));
      }
    });
  });
}

// ── Parser: extract array of Country names from Tally XML response ───────────
// Tally XML shape:
// <ENVELOPE><COLLECTION><COUNTRY NAME="India"><NAME>India</NAME></COUNTRY>...
function parseCountriesXml(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const results = new Set();

  // Attempt 1: attribute-based <COUNTRY NAME="...">
  const attrRegex = /<COUNTRY\s+NAME="([^"]+)"/gi;
  let m;
  while ((m = attrRegex.exec(xml)) !== null) {
    if (!isMetaValue(m[1])) results.add(m[1].trim());
  }

  // Attempt 2: child-tag-based <NAME>...</NAME> inside <COUNTRY>
  if (results.size === 0) {
    const blockRegex = /<COUNTRY[^>]*>[\s\S]*?<\/COUNTRY>/gi;
    const nameRegex = /<NAME>([^<]+)<\/NAME>/i;
    let block;
    while ((block = blockRegex.exec(xml)) !== null) {
      const nm = block[0].match(nameRegex);
      if (nm && !isMetaValue(nm[1])) results.add(nm[1].trim());
    }
  }

  return Array.from(results).sort();
}

// ── Parser: extract array of {name, country, gstStateCode} from States XML ──
function parseStatesXml(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const results = [];
  const seenKeys = new Set();

  // Tally shape: <STATE NAME="Karnataka"><NAME>Karnataka</NAME><COUNTRYNAME>India</COUNTRYNAME><GSTSTATECODE>29</GSTSTATECODE></STATE>
  const blockRegex = /<STATE[^>]*>([\s\S]*?)<\/STATE>/gi;
  let block;
  while ((block = blockRegex.exec(xml)) !== null) {
    const body = block[1];
    // Prefer attribute NAME, fall back to inner <NAME>
    const attrMatch = block[0].match(/<STATE\s+NAME="([^"]+)"/i);
    const innerName = body.match(/<NAME>([^<]+)<\/NAME>/i);
    const rawName = (attrMatch && attrMatch[1]) || (innerName && innerName[1]) || '';
    if (isMetaValue(rawName)) continue;

    const countryMatch = body.match(/<COUNTRYNAME>([^<]*)<\/COUNTRYNAME>/i);
    const country = countryMatch ? (isMetaValue(countryMatch[1]) ? '' : countryMatch[1].trim()) : '';

    const codeMatch = body.match(/<GSTSTATECODE>([^<]*)<\/GSTSTATECODE>/i);
    const gstStateCode = codeMatch ? (codeMatch[1] || '').trim() : '';

    const key = `${rawName.trim().toLowerCase()}|${country.toLowerCase()}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    results.push({ name: rawName.trim(), country, gstStateCode: gstStateCode || null });
  }

  return results.sort((a, b) => {
    if (a.country !== b.country) return a.country.localeCompare(b.country);
    return a.name.localeCompare(b.name);
  });
}

// ── DB: read cached countries for company ────────────────────────────────────
async function readCountriesCache(companyGuid) {
  const { rows } = await query(
    'SELECT name FROM tally_country_master WHERE company_guid = $1 ORDER BY name ASC',
    [companyGuid]
  );
  return rows.map(r => ({ name: r.name }));
}

// ── DB: read cached states for company (optionally filtered by country) ──────
async function readStatesCache(companyGuid, country) {
  const sql = country
    ? 'SELECT name, country, gst_state_code FROM tally_state_master WHERE company_guid = $1 AND LOWER(country) = LOWER($2) ORDER BY name ASC'
    : 'SELECT name, country, gst_state_code FROM tally_state_master WHERE company_guid = $1 ORDER BY country ASC, name ASC';
  const params = country ? [companyGuid, country] : [companyGuid];
  const { rows } = await query(sql, params);
  return rows.map(r => ({ name: r.name, country: r.country, gstStateCode: r.gst_state_code }));
}

// ── DB: write countries cache (replace-all for the company) ──────────────────
async function writeCountriesCache(companyGuid, countries) {
  if (!countries.length) return;
  const now = Math.floor(Date.now() / 1000);
  // Delete existing then bulk insert. Small dataset (<300 rows), safe.
  await query('DELETE FROM tally_country_master WHERE company_guid = $1', [companyGuid]);
  for (const c of countries) {
    await query(
      'INSERT INTO tally_country_master (company_guid, name, fetched_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [companyGuid, c.name, now]
    );
  }
}

async function writeStatesCache(companyGuid, states) {
  if (!states.length) return;
  const now = Math.floor(Date.now() / 1000);
  await query('DELETE FROM tally_state_master WHERE company_guid = $1', [companyGuid]);
  for (const s of states) {
    await query(
      `INSERT INTO tally_state_master (company_guid, name, country, gst_state_code, fetched_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [companyGuid, s.name, s.country || '', s.gstStateCode || null, now]
    );
  }
}

// ── Route: GET /api/tally/masters/countries ──────────────────────────────────
router.get('/masters/countries', authMiddleware, async (req, res) => {
  const { companyGuid } = req.query;
  if (!companyGuid) {
    return res.status(400).json({ status: false, message: 'companyGuid query param required' });
  }
  try {
    // Cache hit — return DB rows
    const cached = await readCountriesCache(companyGuid);
    if (cached.length > 0) {
      return res.json({ status: true, source: 'cache', data: cached });
    }

    // Cache miss — try live fetch (graceful degradation on failure)
    console.log('[tally-read] countries cache MISS, attempting live fetch');
    try {
      const xml = await fetchFromTallyViaDesktop(companyGuid, req.user.userId, XML_COUNTRIES);
      console.log('[tally-read] countries xml received', { xmlLen: xml?.length, preview: (xml || '').slice(0, 300) });
      const parsed = parseCountriesXml(xml);
      console.log('[tally-read] countries parsed', { count: parsed.length, sample: parsed.slice(0, 5) });
      if (parsed.length > 0) {
        const rows = parsed.map(name => ({ name }));
        await writeCountriesCache(companyGuid, rows);
        return res.json({ status: true, source: 'live', data: rows });
      }
      // Parsed empty — return empty and let mobile fall back to hardcoded
      return res.json({ status: true, source: 'live_empty', data: [] });
    } catch (fetchErr) {
      console.log('[tally-read] countries fetch FAILED', { msg: fetchErr.message });
      // Desktop offline / Tally not reachable / timeout — return empty
      return res.json({
        status: true,
        source: 'fallback',
        data: [],
        note: fetchErr.message || 'live fetch unavailable',
      });
    }
  } catch (err) {
    console.error('[tally-read] countries error:', err.message);
    return res.status(500).json({ status: false, message: err.message });
  }
});

// ── Route: GET /api/tally/masters/states ─────────────────────────────────────
router.get('/masters/states', authMiddleware, async (req, res) => {
  const { companyGuid, country } = req.query;
  if (!companyGuid) {
    return res.status(400).json({ status: false, message: 'companyGuid query param required' });
  }
  try {
    // Cache hit — return DB rows (optionally filtered by country)
    const cached = await readStatesCache(companyGuid, country);
    if (cached.length > 0) {
      return res.json({ status: true, source: 'cache', data: cached });
    }

    // Cache miss — try live fetch
    console.log('[tally-read] states cache MISS, attempting live fetch');
    try {
      const xml = await fetchFromTallyViaDesktop(companyGuid, req.user.userId, XML_STATES);
      console.log('[tally-read] states xml received', { xmlLen: xml?.length, preview: (xml || '').slice(0, 500) });
      const parsed = parseStatesXml(xml);
      console.log('[tally-read] states parsed', { count: parsed.length, sample: parsed.slice(0, 3) });
      if (parsed.length > 0) {
        await writeStatesCache(companyGuid, parsed);
        // Return filtered by country if requested
        if (country) {
          return res.json({
            status: true,
            source: 'live',
            data: parsed.filter(s => (s.country || '').toLowerCase() === String(country).toLowerCase()),
          });
        }
        return res.json({ status: true, source: 'live', data: parsed });
      }
      return res.json({ status: true, source: 'live_empty', data: [] });
    } catch (fetchErr) {
      console.log('[tally-read] states fetch FAILED', { msg: fetchErr.message });
      return res.json({
        status: true,
        source: 'fallback',
        data: [],
        note: fetchErr.message || 'live fetch unavailable',
      });
    }
  } catch (err) {
    console.error('[tally-read] states error:', err.message);
    return res.status(500).json({ status: false, message: err.message });
  }
});

export default router;
