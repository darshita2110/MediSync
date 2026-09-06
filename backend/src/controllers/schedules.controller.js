// src/controllers/schedules.controller.js
// Schedules (repeating rules) and dose_events (the actual doses generated
// from those rules that caregivers confirm).

const db = require('../config/db');
const { logAction } = require('../utils/audit');

function blockViewers(req, res) {
  if (req.patientRole === 'viewer') {
    res.status(403).json({ error: 'Viewers cannot make changes' });
    return true;
  }
  return false;
}

// ---- Schedules --------------------------------------------------------

// POST /api/patients/:patientId/items/:itemId/schedules
// Body: { time_of_day: "08:00", days_of_week?: [1,3,5], start_date?, end_date? }
// days_of_week: empty/omitted = every day. 0=Sun .. 6=Sat.
async function createSchedule(req, res) {
  if (blockViewers(req, res)) return;
  const { patientId, itemId } = req.params;
  const { time_of_day, days_of_week, start_date, end_date } = req.body;

  if (!time_of_day) {
    return res.status(400).json({ error: 'time_of_day is required (e.g. "08:00")' });
  }

  try {
    // Make sure the item actually belongs to this patient.
    const itemCheck = await db.query(
      `SELECT id FROM prescription_items WHERE id = $1 AND patient_id = $2`,
      [itemId, patientId]
    );
    if (itemCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Medicine not found for this patient' });
    }

    const result = await db.query(
      `INSERT INTO schedules
         (prescription_item_id, patient_id, time_of_day, days_of_week,
          start_date, end_date)
       VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_DATE), $6)
       RETURNING id, time_of_day, days_of_week, start_date, end_date, is_active`,
      [itemId, patientId, time_of_day, days_of_week || [], start_date || null, end_date || null]
    );

    await logAction(patientId, req.user.id, 'schedule.created',
      { item_id: itemId, time_of_day });
    return res.status(201).json({ schedule: result.rows[0] });
  } catch (err) {
    console.error('Create schedule error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

// GET /api/patients/:patientId/schedules  — all active schedules + medicine name
async function listSchedules(req, res) {
  const { patientId } = req.params;
  try {
    const result = await db.query(
      `SELECT s.id, s.time_of_day, s.days_of_week, s.start_date, s.end_date,
              s.is_active, pi.raw_text AS medicine, pi.brand_name
       FROM schedules s
       JOIN prescription_items pi ON pi.id = s.prescription_item_id
       WHERE s.patient_id = $1 AND s.is_active = TRUE
       ORDER BY s.time_of_day`,
      [patientId]
    );
    return res.json({ schedules: result.rows });
  } catch (err) {
    console.error('List schedules error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

// ---- Dose generation --------------------------------------------------

// Does a schedule apply on a given date? Checks the date window and the
// days_of_week filter (empty array = every day).
function scheduleAppliesOn(schedule, date) {
  const d = new Date(date);
  const start = schedule.start_date ? new Date(schedule.start_date) : null;
  const end = schedule.end_date ? new Date(schedule.end_date) : null;
  if (start && d < start) return false;
  if (end && d > end) return false;

  const dow = schedule.days_of_week || [];
  if (dow.length === 0) return true;          // every day
  return dow.includes(d.getDay());            // getDay: 0=Sun..6=Sat
}

// POST /api/patients/:patientId/doses/generate
// Body: { days_ahead?: 7 }  — creates dose_events for today..today+days_ahead.
// Safe to run repeatedly: the UNIQUE(schedule_id, scheduled_for) constraint
// means already-created doses are skipped, not duplicated.
async function generateDoses(req, res) {
  if (blockViewers(req, res)) return;
  const { patientId } = req.params;
  const daysAhead = Number(req.body.days_ahead) || 7;

  try {
    const schedulesResult = await db.query(
      `SELECT id, time_of_day, days_of_week, start_date, end_date
       FROM schedules
       WHERE patient_id = $1 AND is_active = TRUE`,
      [patientId]
    );
    const schedules = schedulesResult.rows;

    let created = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let offset = 0; offset <= daysAhead; offset++) {
      const day = new Date(today);
      day.setDate(today.getDate() + offset);

      for (const schedule of schedules) {
        if (!scheduleAppliesOn(schedule, day)) continue;

        // Combine the day with the schedule's time to get the exact moment.
        const [hh, mm] = schedule.time_of_day.split(':');
        const scheduledFor = new Date(day);
        scheduledFor.setHours(Number(hh), Number(mm), 0, 0);

        // ON CONFLICT DO NOTHING relies on the UNIQUE(schedule_id,
        // scheduled_for) constraint — the heart of "no duplicate doses".
        const result = await db.query(
          `INSERT INTO dose_events (schedule_id, patient_id, scheduled_for, status)
           VALUES ($1, $2, $3, 'pending')
           ON CONFLICT (schedule_id, scheduled_for) DO NOTHING
           RETURNING id`,
          [schedule.id, patientId, scheduledFor.toISOString()]
        );
        if (result.rows.length > 0) created++;
      }
    }

    return res.json({ schedules_processed: schedules.length, doses_created: created });
  } catch (err) {
    console.error('Generate doses error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

// ---- Viewing and confirming doses -------------------------------------

// GET /api/patients/:patientId/doses?from=YYYY-MM-DD&to=YYYY-MM-DD
// Defaults to today..+7 days if no range given.
async function listDoses(req, res) {
  const { patientId } = req.params;
  const from = req.query.from || null;
  const to = req.query.to || null;

  try {
    const result = await db.query(
      `SELECT de.id, de.scheduled_for, de.status, de.confirmed_at,
              u.name AS confirmed_by_name,
              pi.raw_text AS medicine, pi.brand_name, pi.dose_amount
       FROM dose_events de
       JOIN schedules s  ON s.id = de.schedule_id
       JOIN prescription_items pi ON pi.id = s.prescription_item_id
       LEFT JOIN users u ON u.id = de.confirmed_by
       WHERE de.patient_id = $1
         AND de.scheduled_for >= COALESCE($2::timestamptz, now()::date)
         AND de.scheduled_for <  COALESCE($3::timestamptz, now()::date + INTERVAL '8 days')
       ORDER BY de.scheduled_for`,
      [patientId, from, to]
    );
    return res.json({ doses: result.rows });
  } catch (err) {
    console.error('List doses error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

// PATCH /api/patients/:patientId/doses/:doseId
// Body: { status: 'taken' | 'skipped' }
// Records who confirmed it. If someone already confirmed, we say so instead
// of silently overwriting — the "two people, one dose" story.
async function confirmDose(req, res) {
  if (blockViewers(req, res)) return;
  const { patientId, doseId } = req.params;
  const { status } = req.body;

  if (!['taken', 'skipped'].includes(status)) {
    return res.status(400).json({ error: "status must be 'taken' or 'skipped'" });
  }

  try {
    // Only update if it's still pending. If it isn't, someone beat us to it.
    const result = await db.query(
      `UPDATE dose_events
       SET status = $1, confirmed_by = $2, confirmed_at = now()
       WHERE id = $3 AND patient_id = $4 AND status = 'pending'
       RETURNING id, status, confirmed_at`,
      [status, req.user.id, doseId, patientId]
    );

    if (result.rows.length === 0) {
      // Either it doesn't exist, or it was already confirmed. Find out which.
      const existing = await db.query(
        `SELECT de.status, u.name AS confirmed_by_name, de.confirmed_at
         FROM dose_events de
         LEFT JOIN users u ON u.id = de.confirmed_by
         WHERE de.id = $1 AND de.patient_id = $2`,
        [doseId, patientId]
      );
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Dose not found for this patient' });
      }
      const row = existing.rows[0];
      return res.status(409).json({
        error: `Already ${row.status}` +
               (row.confirmed_by_name ? ` by ${row.confirmed_by_name}` : ''),
        dose: row,
      });
    }

    await logAction(patientId, req.user.id, 'dose.' + status, { dose_id: doseId });
    return res.json({ dose: result.rows[0] });
  } catch (err) {
    console.error('Confirm dose error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

module.exports = {
  createSchedule, listSchedules,
  generateDoses, listDoses, confirmDose,
};