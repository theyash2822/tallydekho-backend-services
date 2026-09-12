import { v4 as uuid } from 'uuid';
import { query } from '../db/schema.js';

const now = () => Math.floor(Date.now() / 1000);

export async function audit(workspaceId, actorUserId, eventType, payload = {}) {
  try {
    await query(
      `INSERT INTO workspace_audit_log (id, workspace_id, actor_user_id, event_type, payload, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [uuid(), workspaceId || null, actorUserId || null, eventType, JSON.stringify(payload || {}), now()]
    );
  } catch (err) {
    console.warn('[audit] skipped:', err.message);
  }
}
