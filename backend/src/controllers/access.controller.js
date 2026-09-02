// src/controllers/access.controller.js
// Invite a user to a patient, accept an invite, and list a patient's access.

const db = require('../config/db');

const INVITABLE_ROLES = ['family_admin', 'helper', 'viewer'];

// Helper: does this user have an accepted access row for this patient,
// and if so, what role? Returns the role string or null.
async function getAccessRole(userId, patientId) {
  const result = await db.query(
    `SELECT role FROM patient_access
     WHERE user_id = $1 AND patient_id = $2 AND status = 'accepted'`,
    [userId, patientId]
  );
  return result.rows[0] ? result.rows[0].role : null;
}

// POST /api/patients/:patientId/invites
// Owner (or family_admin) invites someone by email at a given role.
async function inviteUser(req, res) {
  const inviterId = req.user.id;
  const { patientId } = req.params;
  const { email, role } = req.body;

  if (!email || !role) {
    return res.status(400).json({ error: 'email and role are required' });
  }
  if (!INVITABLE_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${INVITABLE_ROLES.join(', ')}` });
  }

  try {
    // 1. The inviter must be an owner or family_admin of this patient.
    const inviterRole = await getAccessRole(inviterId, patientId);
    if (inviterRole !== 'owner' && inviterRole !== 'family_admin') {
      return res.status(403).json({ error: 'You do not have permission to invite people to this patient' });
    }

    // 2. Find the user being invited (they must already have an account).
    const userResult = await db.query(
      `SELECT id, email, name FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );
    const invitee = userResult.rows[0];
    if (!invitee) {
      return res.status(404).json({ error: 'No user with that email. Ask them to sign up first.' });
    }

    // 3. Create a pending access row. If one already exists, the UNIQUE
    //    (patient_id, user_id) constraint (code 23505) tells us so.
    const accessResult = await db.query(
      `INSERT INTO patient_access (patient_id, user_id, role, status, invited_by)
       VALUES ($1, $2, $3, 'pending', $4)
       RETURNING id, patient_id, user_id, role, status`,
      [patientId, invitee.id, role, inviterId]
    );

    return res.status(201).json({ invite: accessResult.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That person already has access (or a pending invite) for this patient' });
    }
    console.error('Invite error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

// GET /api/invites  — invites waiting for the logged-in user to accept.
async function listMyInvites(req, res) {
  const userId = req.user.id;
  try {
    const result = await db.query(
      `SELECT pa.id, pa.role, pa.created_at,
              p.id AS patient_id, p.full_name AS patient_name
       FROM patient_access pa
       JOIN patients p ON p.id = pa.patient_id
       WHERE pa.user_id = $1 AND pa.status = 'pending'
       ORDER BY pa.created_at DESC`,
      [userId]
    );
    return res.json({ invites: result.rows });
  } catch (err) {
    console.error('List invites error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

// POST /api/invites/:accessId/accept  — the invited user accepts.
async function acceptInvite(req, res) {
  const userId = req.user.id;
  const { accessId } = req.params;
  try {
    // Only flip a row that belongs to THIS user and is still pending.
    const result = await db.query(
      `UPDATE patient_access
       SET status = 'accepted', accepted_at = now()
       WHERE id = $1 AND user_id = $2 AND status = 'pending'
       RETURNING id, patient_id, role, status`,
      [accessId, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No pending invite found for you with that id' });
    }
    return res.json({ access: result.rows[0] });
  } catch (err) {
    console.error('Accept invite error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

// GET /api/patients/:patientId/access  — who can see this patient.
async function listAccess(req, res) {
  const userId = req.user.id;
  const { patientId } = req.params;
  try {
    // Caller must have access to this patient to see its access list.
    const callerRole = await getAccessRole(userId, patientId);
    if (!callerRole) {
      return res.status(403).json({ error: 'You do not have access to this patient' });
    }

    const result = await db.query(
      `SELECT pa.id, pa.role, pa.status, pa.created_at,
              u.id AS user_id, u.email, u.name
       FROM patient_access pa
       JOIN users u ON u.id = pa.user_id
       WHERE pa.patient_id = $1
       ORDER BY pa.created_at`,
      [patientId]
    );
    return res.json({ access: result.rows });
  } catch (err) {
    console.error('List access error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

module.exports = { inviteUser, listMyInvites, acceptInvite, listAccess };