const db = require('../config/db');
const { logAction } = require('../utils/audit');
const { transaction } = require('../utils/transaction');
const v = require('../utils/validation');
const { HttpError, badRequest } = require('../utils/errors');
const { reconcile, lockPatient } = require('../services/reconciliation');

async function addPrescriber(req, res) {
  const name = v.text(req.body.name, 'name', { required: true, max: 200 });
  const specialty = v.text(req.body.specialty, 'specialty', { max: 200 });
  const clinic = v.text(req.body.clinic, 'clinic', { max: 200 });
  const phone = v.text(req.body.phone, 'phone', { max: 50 });
  const result = await db.query(
    `INSERT INTO prescribers (patient_id, name, specialty, clinic, phone)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, name, specialty, clinic, phone, created_at`,
    [req.params.patientId, name, specialty, clinic, phone]);
  await logAction(req.params.patientId, req.user.id, 'prescriber.added', { name });
  return res.status(201).json({ prescriber: result.rows[0] });
}

async function listPrescribers(req, res) {
  const result = await db.query(
    'SELECT id, name, specialty, clinic, phone FROM prescribers WHERE patient_id = $1 ORDER BY name',
    [req.params.patientId]);
  return res.json({ prescribers: result.rows });
}

function validateItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) badRequest('each item must be an object');
  const result = {
    raw_text: v.text(item.raw_text, 'raw_text', { required: true }),
    brand_name: v.text(item.brand_name, 'brand_name'),
    ingredient: v.text(item.ingredient, 'ingredient'),
    strength: v.text(item.strength, 'strength', { max: 100 }),
    dose_amount: item.dose_amount === undefined ? '1' : v.text(item.dose_amount, 'dose_amount', { required: true, max: 100 }),
    frequency: v.text(item.frequency, 'frequency', { max: 200 }),
    start_date: v.date(item.start_date, 'start_date'),
    end_date: v.date(item.end_date, 'end_date'),
    replaces_item_id: v.uuid(item.replaces_item_id, 'replaces_item_id', { required: false }),
  };
  v.dateRange(result.start_date, result.end_date);
  return result;
}

async function createPrescription(req, res) {
  const { patientId } = req.params;
  const prescriberId = v.uuid(req.body.prescriber_id, 'prescriber_id', { required: false });
  const visitDate = v.date(req.body.visit_date, 'visit_date', { required: true });
  const notes = v.text(req.body.notes, 'notes', { max: 5000 });
  if (!Array.isArray(req.body.items) || !req.body.items.length || req.body.items.length > 100) {
    badRequest('items must contain between 1 and 100 medicines');
  }
  const items = req.body.items.map(validateItem);
  const replacements = items.map(i => i.replaces_item_id).filter(Boolean);
  if (new Set(replacements).size !== replacements.length) badRequest('A medicine can only be replaced once in a prescription');
  const prescription = await transaction(async client => {
    await lockPatient(client, patientId);
    if (prescriberId) {
      const doctor = await client.query(
        'SELECT id FROM prescribers WHERE id = $1 AND patient_id = $2 FOR SHARE', [prescriberId, patientId]);
      if (!doctor.rows.length) throw new HttpError(404, 'Doctor not found for this patient');
    }
    const todayResult = await client.query(
      'SELECT (now() AT TIME ZONE timezone)::date::text AS today FROM patients WHERE id = $1', [patientId]);
    const today = todayResult.rows[0].today;
    for (const item of items) v.dateRange(item.start_date || today, item.end_date);
    const result = await client.query(
      `INSERT INTO prescriptions (patient_id, prescriber_id, visit_date, notes, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, visit_date, notes, created_at`,
      [patientId, prescriberId, visitDate, notes, req.user.id]);
    const prescription = result.rows[0];
    const savedItems = [];
    for (const item of items) {
      if (item.replaces_item_id) {
        const priorReplacement = await client.query(
          "SELECT id FROM prescription_items WHERE patient_id = $1 AND replaces_item_id = $2 AND status = 'active'",
          [patientId, item.replaces_item_id]);
        if (priorReplacement.rows.length) throw new HttpError(409, 'This medicine already has an active replacement');
        const old = await client.query(
          'SELECT id, status FROM prescription_items WHERE id = $1 AND patient_id = $2 FOR UPDATE',
          [item.replaces_item_id, patientId]);
        if (!old.rows.length) throw new HttpError(404, 'Replacement medicine not found for this patient');
        if (old.rows[0].status !== 'active') throw new HttpError(409, 'Only active medicines can be replaced');
        const replacementStart = item.start_date || today;
        if (replacementStart < today) badRequest('A replacement cannot be backdated');
        if (replacementStart === today) {
          await closeMedicine(client, patientId, item.replaces_item_id, 'stopped');
        } else {
          const oldWindow = await client.query(
            'SELECT start_date::text FROM prescription_items WHERE id = $1', [item.replaces_item_id]);
          if (oldWindow.rows[0].start_date >= replacementStart) badRequest('A future replacement must start after the previous medicine starts');
          await client.query(
            `UPDATE prescription_items SET end_date = LEAST(COALESCE(end_date, $2::date - 1), $2::date - 1), updated_at = now()
             WHERE id = $1`, [item.replaces_item_id, replacementStart]);
          await client.query(
            `UPDATE schedules SET end_date = CASE WHEN start_date >= $2::date THEN end_date
                    ELSE LEAST(COALESCE(end_date, $2::date - 1), $2::date - 1) END,
                    is_active = is_active AND start_date < $2::date WHERE prescription_item_id = $1`,
            [item.replaces_item_id, replacementStart]);
          await client.query(
            `DELETE FROM dose_events de USING schedules s, patients p
             WHERE de.schedule_id = s.id AND s.prescription_item_id = $1 AND p.id = de.patient_id
               AND de.status = 'pending' AND de.scheduled_for >= ($2::date::timestamp AT TIME ZONE p.timezone)`,
            [item.replaces_item_id, replacementStart]);
        }
        await client.query(
          `INSERT INTO audit_log (patient_id, actor_user_id, action, details) VALUES ($1, $2, 'medicine.replaced', $3)`,
          [patientId, req.user.id, { previous_item_id: item.replaces_item_id, start_date: replacementStart }]);
      }
      const saved = await client.query(
        `INSERT INTO prescription_items
         (prescription_id, patient_id, raw_text, brand_name, ingredient, strength, dose_amount, frequency, start_date, end_date, replaces_item_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [prescription.id, patientId, item.raw_text, item.brand_name, item.ingredient,
          item.strength, item.dose_amount, item.frequency, item.start_date || today, item.end_date, item.replaces_item_id]);
      savedItems.push(saved.rows[0]);
    }
    const reconciliation = await reconcile(patientId, req.user.id, client);
    return { ...prescription, items: savedItems, reconciliation };
  });
  await logAction(patientId, req.user.id, 'prescription.created',
    { prescription_id: prescription.id, item_count: prescription.items.length });
  return res.status(201).json({ prescription });
}

async function listPrescriptions(req, res) {
  const result = await db.query(
    `SELECT pr.id, pr.visit_date, pr.notes, pr.created_at, pr.prescriber_id,
            d.name AS prescriber_name, d.specialty AS prescriber_specialty,
            COALESCE(json_agg(pi ORDER BY pi.created_at, pi.id)
              FILTER (WHERE pi.id IS NOT NULL), '[]') AS items
     FROM prescriptions pr LEFT JOIN prescribers d ON d.id = pr.prescriber_id AND d.patient_id = pr.patient_id
     LEFT JOIN prescription_items pi ON pi.prescription_id = pr.id
     WHERE pr.patient_id = $1 GROUP BY pr.id, d.name, d.specialty ORDER BY pr.visit_date DESC, pr.id`,
    [req.params.patientId]);
  return res.json({ prescriptions: result.rows });
}

async function listActiveItems(req, res) {
  const result = await db.query(
    `SELECT pi.*, d.name AS prescriber_name
     FROM prescription_items pi JOIN patients p ON p.id = pi.patient_id
     JOIN prescriptions pr ON pr.id = pi.prescription_id
     LEFT JOIN prescribers d ON d.id = pr.prescriber_id AND d.patient_id = pr.patient_id
     WHERE pi.patient_id = $1 AND pi.status = 'active'
       AND pi.start_date <= (now() AT TIME ZONE p.timezone)::date
       AND (pi.end_date IS NULL OR pi.end_date >= (now() AT TIME ZONE p.timezone)::date)
     ORDER BY pi.brand_name NULLS LAST, pi.raw_text, pi.id`, [req.params.patientId]);
  return res.json({ items: result.rows });
}

async function closeMedicine(client, patientId, itemId, status) {
  const result = await client.query(
    `UPDATE prescription_items SET status = $3, updated_at = now()
     WHERE id = $1 AND patient_id = $2 RETURNING *`, [itemId, patientId, status]);
  await client.query('UPDATE schedules SET is_active = FALSE WHERE prescription_item_id = $1 AND patient_id = $2', [itemId, patientId]);
  // Generated future pending doses are forecasts; preserve all confirmed doses
  // and historical pending doses so the adherence record is not rewritten.
  await client.query(
    `DELETE FROM dose_events de USING schedules s
     WHERE de.schedule_id = s.id AND s.prescription_item_id = $1 AND de.patient_id = $2
       AND de.status = 'pending' AND de.scheduled_for > now()`, [itemId, patientId]);
  return result.rows[0];
}

async function updateItem(req, res) {
  const { patientId, itemId } = req.params;
  const { status } = req.body;
  if (!['stopped', 'completed'].includes(status)) badRequest('status must be stopped or completed; use a replacement prescription for a changed medicine');
  const result = await transaction(async client => {
    await lockPatient(client, patientId);
    const existing = await client.query('SELECT * FROM prescription_items WHERE id = $1 AND patient_id = $2 FOR UPDATE', [itemId, patientId]);
    if (!existing.rows.length) throw new HttpError(404, 'Medicine not found for this patient');
    if (existing.rows[0].status === status) return { item: existing.rows[0], reconciliation: await reconcile(patientId, req.user.id, client) };
    if (existing.rows[0].status !== 'active') throw new HttpError(409, 'This medicine is already closed');
    const item = await closeMedicine(client, patientId, itemId, status);
    await client.query(
      `INSERT INTO audit_log (patient_id, actor_user_id, action, details) VALUES ($1, $2, $3, $4)`,
      [patientId, req.user.id, `medicine.${status}`, { item_id: itemId }]);
    return { item, reconciliation: await reconcile(patientId, req.user.id, client) };
  });
  return res.json(result);
}

module.exports = { addPrescriber, listPrescribers, createPrescription, listPrescriptions, listActiveItems, updateItem };
