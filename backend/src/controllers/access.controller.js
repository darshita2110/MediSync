const db = require('../config/db');
const { logAction } = require('../utils/audit');
const v = require('../utils/validation');
const { HttpError, badRequest } = require('../utils/errors');
const { transaction } = require('../utils/transaction');
const { lockPatient } = require('../services/reconciliation');

async function inviteUser(req, res) {
  const email = v.email(req.body.email);
  const { role } = req.body;
  if (!['family_admin', 'helper', 'viewer'].includes(role)) badRequest('role must be family_admin, helper or viewer');
  const invitee = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  if (!invitee.rows.length) throw new HttpError(404, 'No user with that email. Ask them to sign up first.');
  let result;
  try {
    result = await db.query(
      `INSERT INTO patient_access (patient_id, user_id, role, status, invited_by)
       VALUES ($1, $2, $3, 'pending', $4) RETURNING id, patient_id, user_id, role, status`,
      [req.params.patientId, invitee.rows[0].id, role, req.user.id]);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'That person already has access or a pending invite');
    throw err;
  }
  await logAction(req.params.patientId, req.user.id, 'access.invited', { invited_user: invitee.rows[0].id, role });
  return res.status(201).json({ invite: result.rows[0] });
}

async function listMyInvites(req, res) {
  const result = await db.query(
    `SELECT pa.id, pa.role, pa.created_at, p.id AS patient_id, p.full_name AS patient_name
     FROM patient_access pa JOIN patients p ON p.id = pa.patient_id
     WHERE pa.user_id = $1 AND pa.status = 'pending' ORDER BY pa.created_at DESC`,
    [req.user.id]);
  return res.json({ invites: result.rows });
}

async function acceptInvite(req, res) {
  const result = await db.query(
    `UPDATE patient_access SET status = 'accepted', accepted_at = now()
     WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING id, patient_id, role, status`,
    [req.params.accessId, req.user.id]);
  if (!result.rows.length) throw new HttpError(404, 'No pending invite found for you with that id');
  await logAction(result.rows[0].patient_id, req.user.id, 'access.accepted', { access_id: req.params.accessId });
  return res.json({ access: result.rows[0] });
}

async function listAccess(req, res) {
  const result = await db.query(
    `SELECT pa.id, pa.role, pa.status, pa.created_at, u.id AS user_id, u.email, u.name
     FROM patient_access pa JOIN users u ON u.id = pa.user_id
     WHERE pa.patient_id = $1 ORDER BY pa.created_at`, [req.params.patientId]);
  return res.json({ access: result.rows });
}

async function revokeAccess(req, res) {
  const { patientId, accessId } = req.params;
  await transaction(async client => {
    await lockPatient(client, patientId);
    const existing = await client.query('SELECT role, user_id FROM patient_access WHERE id = $1 AND patient_id = $2 FOR UPDATE', [accessId, patientId]);
    if (!existing.rows.length) throw new HttpError(404, 'Access record not found for this patient');
    if (existing.rows[0].role === 'owner') throw new HttpError(409, 'The owner cannot be removed');
    await client.query('DELETE FROM patient_access WHERE id = $1 AND patient_id = $2', [accessId, patientId]);
    await client.query(
      `INSERT INTO audit_log (patient_id, actor_user_id, action, details) VALUES ($1, $2, 'access.revoked', $3)`,
      [patientId, req.user.id, { access_id: accessId, user_id: existing.rows[0].user_id, role: existing.rows[0].role }]);
  });
  return res.json({ revoked: true });
}

module.exports = { inviteUser, listMyInvites, acceptInvite, listAccess, revokeAccess };
