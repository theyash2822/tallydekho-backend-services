import { v4 as uuid } from 'uuid';
import { query } from '../db/schema.js';
import { audit } from './auditService.js';
import { resolveMembership, isOwnerOrAdminMembership } from './authzService.js';
import { tryReserveCredits } from './billingStubService.js';

const now = () => Math.floor(Date.now() / 1000);
const DOMAINS = ['gst', 'einvoice', 'eway'];
const ACTIVATION_COST_CREDITS = { gst: 10, einvoice: 5, eway: 5 };

export class IntegrationError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function assertDomain(domain) {
  if (!DOMAINS.includes(domain)) throw new IntegrationError('VALIDATION_ERROR', `Unknown integration domain: ${domain}`, 400);
}

export async function getIntegration(workspaceId, domain) {
  assertDomain(domain);
  const { rows } = await query(
    `SELECT * FROM workspace_integrations WHERE workspace_id = $1 AND domain = $2 LIMIT 1`,
    [workspaceId, domain]
  );
  return rows[0] || { workspace_id: workspaceId, domain, status: 'NOT_CONFIGURED', config_json: null, activated_at: null };
}

export async function listIntegrations(workspaceId) {
  const { rows } = await query(`SELECT * FROM workspace_integrations WHERE workspace_id = $1`, [workspaceId]);
  const byDomain = new Map(rows.map((r) => [r.domain, r]));
  return DOMAINS.map((domain) => byDomain.get(domain) || { workspace_id: workspaceId, domain, status: 'NOT_CONFIGURED', config_json: null, activated_at: null });
}

/**
 * Sets the (non-secret) integration config. Real credentials live in the
 * existing encrypted `integrations` table (routes/integrations.js); this
 * table only tracks workspace-level activation state and non-secret prefs.
 */
export async function setIntegrationConfig({ workspaceId, domain, userId, config }) {
  assertDomain(domain);
  const membership = await resolveMembership(userId, workspaceId);
  const ownerOrAdmin = await isOwnerOrAdminMembership(membership);
  if (!ownerOrAdmin) throw new IntegrationError('WORKSPACE_ACCESS_DENIED', 'Only Owner/Admin can configure integrations.', 403);

  const existing = await getIntegration(workspaceId, domain);
  const nextStatus = existing.status === 'NOT_CONFIGURED' ? 'CONFIGURED' : existing.status;
  const id = existing.id || uuid();
  await query(
    `INSERT INTO workspace_integrations (id, workspace_id, domain, status, config_json, activated_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (workspace_id, domain) DO UPDATE SET
       status = EXCLUDED.status, config_json = EXCLUDED.config_json`,
    [id, workspaceId, domain, nextStatus, JSON.stringify(config || {}), existing.activated_at || null]
  );
  await audit(workspaceId, userId, 'integration.config_updated', { domain });
  return getIntegration(workspaceId, domain);
}

/**
 * Activates a paid integration domain: requires Owner/Admin, requires the
 * domain to already be CONFIGURED (not NOT_CONFIGURED), and requires enough
 * stub billing credits on the workspace owner's wallet.
 */
export async function activateIntegration({ workspaceId, domain, userId, idempotencyKey = null }) {
  assertDomain(domain);
  const membership = await resolveMembership(userId, workspaceId);
  const ownerOrAdmin = await isOwnerOrAdminMembership(membership);
  if (!ownerOrAdmin) throw new IntegrationError('WORKSPACE_ACCESS_DENIED', 'Only Owner/Admin can activate integrations.', 403);

  const integration = await getIntegration(workspaceId, domain);
  if (integration.status === 'NOT_CONFIGURED') {
    throw new IntegrationError('INTEGRATION_NOT_CONFIGURED', `Configure ${domain} before activating.`, 409);
  }
  if (integration.status === 'ACTIVE') return integration;

  const cost = ACTIVATION_COST_CREDITS[domain] ?? 10;
  const reservation = await tryReserveCredits(workspaceId, cost, idempotencyKey || `${workspaceId}:${domain}:activate`);
  if (!reservation.ok) {
    throw new IntegrationError('BILLING_INSUFFICIENT_CREDITS', 'Not enough credits to activate this integration.', 402);
  }

  const id = integration.id || uuid();
  const ts = now();
  await query(
    `INSERT INTO workspace_integrations (id, workspace_id, domain, status, config_json, activated_at)
     VALUES ($1,$2,$3,'ACTIVE',$4,$5)
     ON CONFLICT (workspace_id, domain) DO UPDATE SET status = 'ACTIVE', activated_at = EXCLUDED.activated_at`,
    [id, workspaceId, domain, JSON.stringify(integration.config_json || {}), ts]
  );
  await audit(workspaceId, userId, 'integration.activated', { domain, cost });
  return getIntegration(workspaceId, domain);
}
