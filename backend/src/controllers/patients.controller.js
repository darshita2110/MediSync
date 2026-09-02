// src/controllers/patients.controller.js
// Create a patient (caller becomes owner) and list patients the caller can access.

const db = require('../config/db');

async function createPatient(req, res) {
  // requireAuth put the logged-in user on req.user, so we know who is creating this.
  const userId = req.user.id;
  const { full_name, timezone, date_of_birth } = req.body;

  if (!full_name) {
    return res.status(400).json({ error: 'full_name is required' });
  }

  // We need TWO inserts to both succeed: the patient row, and an owner
  // access row linking this user to it. If only the first ran, we'd have a
  // patient nobody can reach. A transaction makes them all-or-nothing.
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const patientResult = await client.query(
      `INSERT INTO patients (full_name, timezone, date_of_birth, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, full_name, timezone, date_of_birth, created_at`,
      [full_name, timezone || 'Asia/Kolkata', date_of_birth || null, userId]
    );
    const patient = patientResult.rows[0];

    await client.query(
      `INSERT INTO patient_access (patient_id, user_id, role, status, accepted_at)
       VALUES ($1, $2, 'owner', 'accepted', now())`,
      [patient.id, userId]
    );

    await client.query('COMMIT');
    return res.status(201).json({ patient });
  } catch (err) {
    await client.query('ROLLBACK');   // undo everything if any step failed
    console.error('Create patient error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  } finally {
    client.release();                 // always give the connection back to the pool
  }
}

async function listPatients(req, res) {
  const userId = req.user.id;
  try {
    // Only patients this user has an accepted access row for.
    const result = await db.query(
      `SELECT p.id, p.full_name, p.timezone, p.date_of_birth, pa.role
       FROM patients p
       JOIN patient_access pa ON pa.patient_id = p.id
       WHERE pa.user_id = $1 AND pa.status = 'accepted'
       ORDER BY p.created_at DESC`,
      [userId]
    );
    return res.json({ patients: result.rows });
  } catch (err) {
    console.error('List patients error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

module.exports = { createPatient, listPatients };