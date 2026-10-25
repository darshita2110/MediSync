const db = require('../config/db');
const { logAction } = require('../utils/audit');
const { transaction } = require('../utils/transaction');
const v = require('../utils/validation');
const { badRequest } = require('../utils/errors');

async function createPatient(req, res) {
  const fullName = v.text(req.body.full_name, 'full_name', { required: true, max: 200 });
  const timezone = v.timezone(req.body.timezone);
  const dateOfBirth = v.date(req.body.date_of_birth, 'date_of_birth');
  const today = await db.query('SELECT (now() AT TIME ZONE $1)::date::text AS today', [timezone]);
  if (dateOfBirth && dateOfBirth > today.rows[0].today) badRequest('date_of_birth cannot be in the future');
  const patient = await transaction(async client => {
    const result = await client.query(
      `INSERT INTO patients (full_name, timezone, date_of_birth, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id, full_name, timezone, date_of_birth, created_at`,
      [fullName, timezone, dateOfBirth, req.user.id]);
    await client.query(
      `INSERT INTO patient_access (patient_id, user_id, role, status, accepted_at)
       VALUES ($1, $2, 'owner', 'accepted', now())`, [result.rows[0].id, req.user.id]);
    return result.rows[0];
  });
  await logAction(patient.id, req.user.id, 'patient.created', { full_name: fullName });
  return res.status(201).json({ patient });
}

async function listPatients(req, res) {
  const result = await db.query(
    `SELECT p.id, p.full_name, p.timezone, p.date_of_birth, pa.role
     FROM patients p JOIN patient_access pa ON pa.patient_id = p.id
     WHERE pa.user_id = $1 AND pa.status = 'accepted' ORDER BY p.created_at DESC`,
    [req.user.id]);
  return res.json({ patients: result.rows });
}

module.exports = { createPatient, listPatients };
