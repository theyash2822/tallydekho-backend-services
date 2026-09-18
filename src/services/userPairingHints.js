/**
 * Workspace-backed pairing / company hints — never uses companies.user_id or devices.user_id.
 */
import { query } from '../db/schema.js';

const PAIRED_SQL = `
  SELECT d.device_id FROM devices d
  JOIN workspace_tally_bindings b ON b.device_id = d.device_id
  JOIN workspace_memberships m ON m.workspace_id = b.workspace_id
  WHERE m.user_id = $1 AND m.status = 'ACTIVE'
    AND COALESCE(b.connection_status, '') = 'CONNECTED'
  LIMIT 1`;

const COMPANY_SQL = `
  SELECT c.guid, c.name, c.gstin FROM companies c
  JOIN workspaces w ON w.id = c.workspace_id
  WHERE w.owner_user_id = $1 AND c.is_active = TRUE
  ORDER BY c.name ASC LIMIT 1`;

export async function getUserPairingHints(userId) {
  const { rows: devices } = await query(PAIRED_SQL, [userId]);
  const isPaired = devices.length > 0;
  let company = null;
  if (isPaired) {
    const { rows: companies } = await query(COMPANY_SQL, [userId]);
    if (companies[0]) {
      company = {
        guid: companies[0].guid,
        name: companies[0].name,
        gstin: companies[0].gstin || null,
      };
    }
  }
  return { isPaired, company, deviceId: devices[0]?.device_id || null };
}
