/**
 * Legacy invite helpers — NOT wired by workspaceApi routes.
 * Source of truth for invitations: workspaceService.createInvitation / accept / decline.
 * Kept for reference; do not import from routes.
 */
import { v4 as uuid } from 'uuid';
import { query, getClient } from '../db/schema.js';
import { flags } from '../config/featureFlags.js';
import { audit } from './auditService.js';
import { upsertScopePolicy } from './scopeService.js';

const now = () => Math.floor(Date.now() / 1000);
const INVITE_TTL = 48 * 60 * 60; // 48h

export class InviteError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function requireInvitesEnabled() {
  if (!flags.member_invites_enabled()) {
    throw new InviteError('FEATURE_DISABLED', 'Member invitations are disabled.', 403);
  }
}

export async function createInvitation({
  workspaceId,
  inviteeUserId = null,
  inviteeMobile = null,
  roleId,
  invitedByUserId,
  reservedSeatId = null,
  scopeSnapshot = null,
}) {
  requireInvitesEnabled();
  if (!inviteeUserId && !inviteeMobile) {
    throw new InviteError('VALIDATION_ERROR', 'inviteeUserId or inviteeMobile is required.', 400);
  }
  const id = uuid();
  const ts = now();
  await query(
    `INSERT INTO workspace_invitations
       (id, workspace_id, invitee_user_id, invitee_mobile, role_id, reserved_seat_id, status,
        expires_at, invited_by_user_id, created_at, scope_snapshot_json)
     VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7,$8,$9,$10)`,
    [id, workspaceId, inviteeUserId, inviteeMobile, roleId, reservedSeatId, ts + INVITE_TTL, invitedByUserId, ts,
      scopeSnapshot ? JSON.stringify(scopeSnapshot) : null]
  );
  await audit(workspaceId, invitedByUserId, 'invite.created', { invitationId: id, inviteeUserId, inviteeMobile });
  const { rows } = await query('SELECT * FROM workspace_invitations WHERE id = $1', [id]);
  return rows[0];
}

async function expireIfStale(invitation) {
  if (invitation.status === 'PENDING' && invitation.expires_at && invitation.expires_at < now()) {
    await query(`UPDATE workspace_invitations SET status = 'EXPIRED' WHERE id = $1 AND status = 'PENDING'`, [invitation.id]);
    invitation.status = 'EXPIRED';
  }
  return invitation;
}

/**
 * Lists PENDING (non-expired) invitations addressed to this user, matched
 * either by user id (already-known account) or mobile number (invited
 * before they signed up). Lazily expires stale rows as it goes.
 */
export async function listForUser(userId, mobile = null) {
  if (!flags.member_invites_enabled()) return [];
  const { rows } = await query(
    `SELECT i.*, w.name AS workspace_name, r.name AS role_name
     FROM workspace_invitations i
     JOIN workspaces w ON w.id = i.workspace_id
     LEFT JOIN workspace_roles r ON r.id = i.role_id
     WHERE (i.invitee_user_id = $1 OR ($2::text IS NOT NULL AND i.invitee_mobile = $2))
       AND i.status = 'PENDING'
     ORDER BY i.created_at DESC`,
    [userId, mobile || null]
  );
  const results = [];
  for (const row of rows) {
    const fresh = await expireIfStale(row);
    if (fresh.status === 'PENDING') results.push(fresh);
  }
  return results;
}

async function loadOwnInvitation(invitationId, userId, mobile) {
  const { rows } = await query('SELECT * FROM workspace_invitations WHERE id = $1', [invitationId]);
  const invitation = rows[0];
  if (!invitation) throw new InviteError('NOT_FOUND', 'Invitation not found.', 404);
  const belongsToUser = invitation.invitee_user_id === userId || (mobile && invitation.invitee_mobile === mobile);
  if (!belongsToUser) throw new InviteError('INVITE_NOT_FOR_YOU', 'This invitation is not addressed to you.', 403);
  return expireIfStale(invitation);
}

/**
 * Accepts an invitation: creates (or reactivates) the membership, consumes
 * the reserved seat if any, and copies the scope snapshot captured at
 * invite time. Only the invitee (matched by user id or mobile) may accept.
 */
export async function accept(invitationId, userId, mobile = null) {
  requireInvitesEnabled();
  const invitation = await loadOwnInvitation(invitationId, userId, mobile);
  if (invitation.status === 'EXPIRED') throw new InviteError('INVITE_EXPIRED', 'This invitation has expired.', 410);
  if (invitation.status !== 'PENDING') throw new InviteError('INVITE_ALREADY_HANDLED', `Invitation already ${invitation.status.toLowerCase()}.`, 409);

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const ts = now();

    const { rows: existing } = await client.query(
      `SELECT * FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
      [invitation.workspace_id, userId]
    );
    let membership = existing[0];
    if (membership) {
      await client.query(
        `UPDATE workspace_memberships SET status = 'ACTIVE', role_id = $2, seat_id = COALESCE($3, seat_id), removed_at = NULL, suspended_at = NULL
         WHERE id = $1`,
        [membership.id, invitation.role_id, invitation.reserved_seat_id]
      );
    } else {
      const membershipId = uuid();
      await client.query(
        `INSERT INTO workspace_memberships (id, workspace_id, user_id, membership_type, role_id, status, seat_id, joined_at)
         VALUES ($1,$2,$3,'MEMBER',$4,'ACTIVE',$5,$6)`,
        [membershipId, invitation.workspace_id, userId, invitation.role_id, invitation.reserved_seat_id, ts]
      );
      membership = { id: membershipId };
    }

    if (invitation.reserved_seat_id) {
      await client.query(
        `UPDATE workspace_seats SET status = 'OCCUPIED', occupied_membership_id = $2
         WHERE id = $1 AND workspace_id = $3`,
        [invitation.reserved_seat_id, membership.id, invitation.workspace_id]
      );
    }

    await client.query(
      `UPDATE workspace_invitations SET status = 'ACCEPTED', accepted_at = $2, invitee_user_id = $3 WHERE id = $1`,
      [invitation.id, ts, userId]
    );

    await client.query('COMMIT');

    if (invitation.scope_snapshot_json) {
      await upsertScopePolicy(membership.id, invitation.scope_snapshot_json).catch(() => {});
    }
    await audit(invitation.workspace_id, userId, 'invite.accepted', { invitationId: invitation.id });
    const { rows } = await query('SELECT * FROM workspace_memberships WHERE id = $1', [membership.id]);
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function decline(invitationId, userId, mobile = null) {
  requireInvitesEnabled();
  const invitation = await loadOwnInvitation(invitationId, userId, mobile);
  if (invitation.status === 'EXPIRED') throw new InviteError('INVITE_EXPIRED', 'This invitation has expired.', 410);
  if (invitation.status !== 'PENDING') throw new InviteError('INVITE_ALREADY_HANDLED', `Invitation already ${invitation.status.toLowerCase()}.`, 409);
  await query(`UPDATE workspace_invitations SET status = 'DECLINED', declined_at = $2 WHERE id = $1`, [invitation.id, now()]);
  await audit(invitation.workspace_id, userId, 'invite.declined', { invitationId: invitation.id });
  return { id: invitation.id, status: 'DECLINED' };
}

export async function revoke(invitationId, revokedByUserId) {
  await query(
    `UPDATE workspace_invitations SET status = 'REVOKED', revoked_at = $2 WHERE id = $1 AND status = 'PENDING'`,
    [invitationId, now()]
  );
  await audit(null, revokedByUserId, 'invite.revoked', { invitationId });
}
