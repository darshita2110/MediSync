// src/controllers/prescriptions.controller.js
// Doctors (prescribers), visits (prescriptions), and the medicines on
// them (prescription_items).

const db = require('../config/db');
const { logAction } = require('../utils/audit');

// Viewers can look but not change. Reused by the write endpoints below.
function blockViewers(req, res) {
  if (req.patientRole === 'viewer') {
    res.status(403).json({ error: 'Viewers cannot make changes' });
    return true;
  }
  return false;
}

// ---- Prescribers (doctors) --------------------------------------------

// POST /api/patients/:patientId/prescribers
async function addPrescriber(req, res) {
  if (blockViewers(req, res)) return;
  const { patientId } = req.params;
  const { name, specialty, clinic, phone } = req.body;

  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const result = await db.query(
      `INSERT INTO prescribers (patient_id, name, specialty, clinic, phone)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, specialty, clinic, phone, created_at`,
      [patientId, name, specialty || null, clinic || null, phone || null]
    );
    await logAction(patientId, req.user.id, 'prescriber.added', { name });
    return res.status(201).json({ prescriber: result.rows[0] });
  } catch (err) {
    console.error('Add prescriber error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

// GET /api/patients/:patientId/prescribers
async function listPrescribers(req, res) {
  const { patientId } = req.params;
  try {
    const result = await db.query(
      `SELECT id, name, specialty, clinic, phone, created_at
       FROM prescribers WHERE patient_id = $1 ORDER BY name`,
      [patientId]
    );
    return res.json({ prescribers: result.rows });
  } catch (err) {
    console.error('List prescribers error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

// ---- Prescriptions (a visit + its medicines) --------------------------

// POST /api/patients/:patientId/prescriptions
// Body: { prescriber_id?, visit_date, notes?, items: [ {raw_text, brand_name?,
//         ingredient?, strength?, dose_amount?, frequency?, start_date?, end_date?}, ... ] }
async function createPrescription(req, res) {
  if (blockViewers(req, res)) return;
  const { patientId } = req.params;
  const { prescriber_id, visit_date, notes, items } = req.body;

  if (!visit_date) return res.status(400).json({ error: 'visit_date is required' });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array' });
  }

  // A visit and all its medicines must save together, or not at all.
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const presResult = await client.query(
      `INSERT INTO prescriptions (patient_id, prescriber_id, visit_date, notes, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, visit_date, notes, created_at`,
      [patientId, prescriber_id || null, visit_date, notes || null, req.user.id]
    );
    const prescription = presResult.rows[0];

    const savedItems = [];
    for (const item of items) {
      if (!item.raw_text) {
        throw new Error('each item needs raw_text');   // triggers ROLLBACK below
      }
      const itemResult = await client.query(
        `INSERT INTO prescription_items
           (prescription_id, patient_id, raw_text, brand_name, ingredient,
            strength, dose_amount, frequency, start_date, end_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 COALESCE($9, CURRENT_DATE), $10)
         RETURNING id, raw_text, brand_name, ingredient, strength,
                   dose_amount, frequency, start_date, end_date, status`,
        [
          prescription.id, patientId, item.raw_text, item.brand_name || null,
          item.ingredient || null, item.strength || null,
          item.dose_amount || '1', item.frequency || null,
          item.start_date || null, item.end_date || null,
        ]
      );
      savedItems.push(itemResult.rows[0]);
    }

    await client.query('COMMIT');
    await logAction(patientId, req.user.id, 'prescription.created',
      { prescription_id: prescription.id, item_count: savedItems.length });

    return res.status(201).json({ prescription: { ...prescription, items: savedItems } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create prescription error:', err);
    return res.status(500).json({ error: err.message || 'Something went wrong' });
  } finally {
    client.release();
  }
}

// GET /api/patients/:patientId/prescriptions
// Returns each visit with its doctor and its medicines nested inside.
async function listPrescriptions(req, res) {
  const { patientId } = req.params;
  try {
    const result = await db.query(
      `SELECT pr.id, pr.visit_date, pr.notes, pr.created_at,
              d.name AS prescriber_name, d.specialty AS prescriber_specialty,
              COALESCE(
                json_agg(
                  json_build_object(
                    'id', pi.id, 'raw_text', pi.raw_text,
                    'brand_name', pi.brand_name, 'ingredient', pi.ingredient,
                    'strength', pi.strength, 'dose_amount', pi.dose_amount,
                    'frequency', pi.frequency, 'start_date', pi.start_date,
                    'end_date', pi.end_date, 'status', pi.status
                  ) ORDER BY pi.created_at
                ) FILTER (WHERE pi.id IS NOT NULL),
                '[]'
              ) AS items
       FROM prescriptions pr
       LEFT JOIN prescribers d ON d.id = pr.prescriber_id
       LEFT JOIN prescription_items pi ON pi.prescription_id = pr.id
       WHERE pr.patient_id = $1
       GROUP BY pr.id, d.name, d.specialty
       ORDER BY pr.visit_date DESC`,
      [patientId]
    );
    return res.json({ prescriptions: result.rows });
  } catch (err) {
    console.error('List prescriptions error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

// GET /api/patients/:patientId/items
// The flat list of medicines the patient is CURRENTLY meant to be taking.
// This is the exact input the conflict checker (step 4) will run on.
async function listActiveItems(req, res) {
  const { patientId } = req.params;
  try {
    const result = await db.query(
      `SELECT id, raw_text, brand_name, ingredient, strength,
              dose_amount, frequency, start_date, end_date
       FROM prescription_items
       WHERE patient_id = $1
         AND status = 'active'
         AND (end_date IS NULL OR end_date >= CURRENT_DATE)
       ORDER BY brand_name NULLS LAST, raw_text`,
      [patientId]
    );
    return res.json({ items: result.rows });
  } catch (err) {
    console.error('List active items error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

module.exports = {
  addPrescriber, listPrescribers,
  createPrescription, listPrescriptions, listActiveItems,
};