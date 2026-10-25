const db = require('../config/db');
const { logAction } = require('../utils/audit');
const { generateForPatient } = require('../services/doses');
const v = require('../utils/validation');
const { HttpError, badRequest } = require('../utils/errors');
const { transaction } = require('../utils/transaction');
const { lockPatient } = require('../services/reconciliation');

async function createSchedule(req, res) {
  const { patientId, itemId } = req.params;
  const time = v.time(req.body.time_of_day);
  const days = v.weekdays(req.body.days_of_week);
  const start = v.date(req.body.start_date, 'start_date');
  const end = v.date(req.body.end_date, 'end_date');
  v.dateRange(start, end);
  const saved = await transaction(async client => {
    await lockPatient(client, patientId);
    const item = await client.query(
      `SELECT pi.status, pi.start_date::text, pi.end_date::text,
              (now() AT TIME ZONE p.timezone)::date::text AS today
       FROM prescription_items pi JOIN patients p ON p.id = pi.patient_id
       WHERE pi.id = $1 AND pi.patient_id = $2`, [itemId, patientId]);
    if (!item.rows.length) throw new HttpError(404, 'Medicine not found for this patient');
    const medicine = item.rows[0];
    if (medicine.status !== 'active') throw new HttpError(409, 'Only active medicines can have schedules');
    const effectiveStart = start || (medicine.start_date > medicine.today ? medicine.start_date : medicine.today);
    v.dateRange(effectiveStart, end);
    if (effectiveStart < medicine.start_date || (medicine.end_date && effectiveStart > medicine.end_date)) {
      badRequest('schedule start_date must fall within the medicine course');
    }
    if (end && medicine.end_date && end > medicine.end_date) badRequest('schedule end_date cannot exceed the medicine course');
    const overlap = await client.query(
      `SELECT id FROM schedules WHERE prescription_item_id = $1 AND patient_id = $2 AND is_active
         AND time_of_day = $3::time
         AND start_date <= COALESCE($6::date, 'infinity'::date)
         AND COALESCE(end_date, 'infinity'::date) >= $5::date
         AND (cardinality(days_of_week) = 0 OR cardinality($4::smallint[]) = 0 OR days_of_week && $4::smallint[])`,
      [itemId, patientId, time, days, effectiveStart, end || medicine.end_date]);
    if (overlap.rows.length) throw new HttpError(409, 'An overlapping active schedule already exists for this medicine and time');
    const result = await client.query(
      `INSERT INTO schedules (prescription_item_id, patient_id, time_of_day, days_of_week, start_date, end_date)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [itemId, patientId, time, days, effectiveStart, end || medicine.end_date]);
    return result.rows[0];
  });
  await logAction(patientId, req.user.id, 'schedule.created', { item_id: itemId, time_of_day: time });
  return res.status(201).json({ schedule: saved });
}

async function listSchedules(req, res) {
  const result = await db.query(
    `SELECT s.*, pi.raw_text AS medicine, pi.brand_name, pi.dose_amount
     FROM schedules s JOIN prescription_items pi ON pi.id = s.prescription_item_id AND pi.patient_id = s.patient_id
     JOIN patients p ON p.id = s.patient_id
     WHERE s.patient_id = $1 AND s.is_active AND pi.status = 'active'
       AND ($2::boolean = FALSE OR (
         (now() AT TIME ZONE p.timezone)::date >= GREATEST(s.start_date, pi.start_date)
         AND (s.end_date IS NULL OR s.end_date >= (now() AT TIME ZONE p.timezone)::date)
         AND (pi.end_date IS NULL OR pi.end_date >= (now() AT TIME ZONE p.timezone)::date)
         AND (cardinality(s.days_of_week) = 0 OR
              EXTRACT(DOW FROM now() AT TIME ZONE p.timezone)::smallint = ANY(s.days_of_week))))
     ORDER BY s.time_of_day, s.id`, [req.params.patientId, req.patientRole === 'helper']);
  return res.json({ schedules: result.rows });
}

async function generateDoses(req, res) {
  const daysAhead = v.integer(req.body.days_ahead, 'days_ahead', 7, 0, 30);
  const result = await generateForPatient(req.params.patientId, daysAhead);
  return res.json(result);
}

async function listDoses(req, res) {
  const from = v.date(req.query.from, 'from');
  const to = v.date(req.query.to, 'to');
  if (from && to && to < from) badRequest('to must be on or after from');
  if (from && to && (Date.parse(to) - Date.parse(from)) / 86400000 > 90) badRequest('dose date range cannot exceed 90 days');
  const helper = req.patientRole === 'helper';
  const result = await db.query(
    `SELECT de.id, de.scheduled_for, de.status, de.confirmed_at, de.confirmed_by,
            u.name AS confirmed_by_name, pi.raw_text AS medicine, pi.brand_name, pi.dose_amount
     FROM dose_events de JOIN patients p ON p.id = de.patient_id
     JOIN schedules s ON s.id = de.schedule_id AND s.patient_id = de.patient_id
     JOIN prescription_items pi ON pi.id = s.prescription_item_id AND pi.patient_id = de.patient_id
     LEFT JOIN users u ON u.id = de.confirmed_by
     CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE p.timezone)::date AS today) d
     WHERE de.patient_id = $1
       AND de.scheduled_for >= (
         (CASE WHEN $4::boolean THEN d.today ELSE COALESCE($2::date, d.today) END)::timestamp AT TIME ZONE p.timezone)
       AND de.scheduled_for < (
         ((CASE WHEN $4::boolean THEN d.today ELSE COALESCE($3::date, COALESCE($2::date, d.today) + 7) END) + 1)::timestamp AT TIME ZONE p.timezone)
     ORDER BY de.scheduled_for, de.id`, [req.params.patientId, from, to, helper]);
  return res.json({ doses: result.rows });
}

async function confirmDose(req, res) {
  const { patientId, doseId } = req.params;
  const { status } = req.body;
  if (!['taken', 'skipped'].includes(status)) badRequest("status must be 'taken' or 'skipped'");
  const result = await db.query(
    `UPDATE dose_events de SET status = $1, confirmed_by = $2, confirmed_at = now()
     FROM patients p, schedules s, prescription_items pi
     WHERE de.id = $3 AND de.patient_id = $4 AND de.status = 'pending'
       AND p.id = de.patient_id AND s.id = de.schedule_id AND s.patient_id = de.patient_id
       AND pi.id = s.prescription_item_id AND pi.patient_id = de.patient_id
       AND pi.status = 'active' AND s.is_active
       AND (de.scheduled_for AT TIME ZONE p.timezone)::date >= GREATEST(pi.start_date, s.start_date)
       AND (pi.end_date IS NULL OR (de.scheduled_for AT TIME ZONE p.timezone)::date <= pi.end_date)
       AND (s.end_date IS NULL OR (de.scheduled_for AT TIME ZONE p.timezone)::date <= s.end_date)
       AND ($5::boolean = FALSE OR
         (de.scheduled_for AT TIME ZONE p.timezone)::date = (now() AT TIME ZONE p.timezone)::date)
     RETURNING de.id, de.status, de.confirmed_at`,
    [status, req.user.id, doseId, patientId, req.patientRole === 'helper']);
  if (!result.rows.length) {
    const existing = await db.query(
      `SELECT de.status, de.confirmed_at, u.name AS confirmed_by_name
       FROM dose_events de LEFT JOIN users u ON u.id = de.confirmed_by
       WHERE de.id = $1 AND de.patient_id = $2`, [doseId, patientId]);
    if (!existing.rows.length) throw new HttpError(404, 'Dose not found for this patient');
    return res.status(409).json({ error: 'Dose is already confirmed or is no longer eligible', dose: existing.rows[0] });
  }
  await logAction(patientId, req.user.id, 'dose.' + status, { dose_id: doseId });
  return res.json({ dose: result.rows[0] });
}

async function deactivateSchedule(req, res) {
  if (req.body.is_active !== false) badRequest('Set is_active to false; create a new schedule to change a dosing rule');
  const { patientId, scheduleId } = req.params;
  const schedule = await transaction(async client => {
    await lockPatient(client, patientId);
    const result = await client.query('UPDATE schedules SET is_active = FALSE WHERE id = $1 AND patient_id = $2 RETURNING *', [scheduleId, patientId]);
    if (!result.rows.length) throw new HttpError(404, 'Schedule not found for this patient');
    await client.query("DELETE FROM dose_events WHERE schedule_id = $1 AND patient_id = $2 AND status = 'pending' AND scheduled_for > now()", [scheduleId, patientId]);
    await client.query(
      `INSERT INTO audit_log (patient_id, actor_user_id, action, details) VALUES ($1, $2, 'schedule.deactivated', $3)`,
      [patientId, req.user.id, { schedule_id: scheduleId }]);
    return result.rows[0];
  });
  return res.json({ schedule });
}

module.exports = { createSchedule, listSchedules, generateDoses, listDoses, confirmDose, deactivateSchedule };
