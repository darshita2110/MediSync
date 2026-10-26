const db = require('../config/db');
const { transaction } = require('../utils/transaction');
const { generateWithClient } = require('./doses');
const { reconcileWithClient } = require('./reconciliation');

const MINUTE = 60000;
const DEADLINE_MINUTES = 45;

// No replay burst after downtime: send at most one reminder per tick, then wait
// another 15 minutes. Snooze never changes the original 45-minute deadline.
function reminderDecision(dose, state, reference) {
  const elapsed = reference.getTime() - new Date(dose.scheduled_for).getTime();
  if (elapsed < 0) return 'wait';
  if (elapsed >= DEADLINE_MINUTES * MINUTE) return 'missed';
  if (state.reminders_sent >= 3 || new Date(state.next_reminder_at) > reference) return 'wait';
  return 'reminder';
}

async function notify(client, dose, kind, stage, reference) {
  // Helpers receive today's dose reminders; only the owner/family admins receive
  // escalation alerts. Pending invitations and read-only viewers receive neither.
  await client.query(
    `INSERT INTO care_notifications (user_id, patient_id, dose_id, kind, stage, created_at)
     SELECT pa.user_id, de.patient_id, de.id, $2, $3, $4 FROM dose_events de
     JOIN patients p ON p.id = de.patient_id
     JOIN patient_access pa ON pa.patient_id = p.id AND pa.status = 'accepted'
     WHERE de.id = $1 AND (pa.role IN ('owner', 'family_admin') OR
       ($2 = 'reminder' AND pa.role = 'helper' AND
        (de.scheduled_for AT TIME ZONE p.timezone)::date = ($4::timestamptz AT TIME ZONE p.timezone)::date))
     ON CONFLICT (user_id, dose_id, stage) DO NOTHING`,
    [dose.id, kind, stage, reference.toISOString()]);
}

async function processPatient(patientId, reference) {
  return transaction(async client => {
    // The same row lock is used by schedule/lifecycle/access writes and dose
    // actions. Multiple workers may safely run; a busy patient waits one tick.
    const locked = await client.query('SELECT id FROM patients WHERE id = $1 FOR UPDATE SKIP LOCKED', [patientId]);
    if (!locked.rows.length) return { skipped: true };
    const generated = await generateWithClient(client, patientId, 7, reference);
    const day = (await client.query(
      'SELECT ($2::timestamptz AT TIME ZONE timezone)::date::text AS day FROM patients WHERE id = $1',
      [patientId, reference.toISOString()])).rows[0].day;
    const previous = await client.query('SELECT reconciled_day FROM patient_worker_state WHERE patient_id = $1', [patientId]);
    if (previous.rows[0]?.reconciled_day !== day) {
      await reconcileWithClient(client, patientId, null, reference);
      await client.query(
        `INSERT INTO patient_worker_state (patient_id, reconciled_day) VALUES ($1, $2)
         ON CONFLICT (patient_id) DO UPDATE SET reconciled_day = EXCLUDED.reconciled_day`, [patientId, day]);
    }
    const due = await client.query(
      `SELECT de.id, de.scheduled_for FROM dose_events de
       JOIN patients p ON p.id = de.patient_id
       JOIN schedules s ON s.id = de.schedule_id AND s.patient_id = de.patient_id
       JOIN prescription_items pi ON pi.id = s.prescription_item_id AND pi.patient_id = de.patient_id
       WHERE de.patient_id = $1 AND de.status = 'pending' AND de.scheduled_for <= $2
         AND s.is_active AND pi.status = 'active'
         AND (de.scheduled_for AT TIME ZONE p.timezone)::date >= GREATEST(s.start_date, pi.start_date)
         AND (s.end_date IS NULL OR (de.scheduled_for AT TIME ZONE p.timezone)::date <= s.end_date)
         AND (pi.end_date IS NULL OR (de.scheduled_for AT TIME ZONE p.timezone)::date <= pi.end_date)
       ORDER BY de.scheduled_for, de.id FOR UPDATE OF de`, [patientId, reference.toISOString()]);
    let reminders = 0, missed = 0;
    for (const dose of due.rows) {
      await client.query(
        `INSERT INTO dose_reminder_state (dose_id, next_reminder_at) VALUES ($1, $2)
         ON CONFLICT (dose_id) DO NOTHING`, [dose.id, dose.scheduled_for]);
      const state = (await client.query('SELECT * FROM dose_reminder_state WHERE dose_id = $1', [dose.id])).rows[0];
      const decision = reminderDecision(dose, state, reference);
      if (decision === 'missed') {
        await client.query("UPDATE dose_events SET status = 'missed' WHERE id = $1", [dose.id]);
        // Old backlog still becomes missed, but never floods the family with
        // alerts for doses more than 24 hours old after an extended outage.
        if (reference - new Date(dose.scheduled_for) <= 24 * 60 * MINUTE) {
          await notify(client, dose, 'missed', 3, reference);
        }
        missed++;
      } else if (decision === 'reminder') {
        await notify(client, dose, 'reminder', state.reminders_sent, reference);
        await client.query(
          `UPDATE dose_reminder_state SET reminders_sent = reminders_sent + 1,
           next_reminder_at = $2::timestamptz + interval '15 minutes', snoozed_until = NULL WHERE dose_id = $1`,
          [dose.id, reference.toISOString()]);
        reminders++;
      }
    }
    return { ...generated, reminders, missed };
  });
}

async function runReminderTick(reference = new Date()) {
  const patients = await db.query('SELECT id FROM patients ORDER BY id');
  let failed = 0;
  for (const patient of patients.rows) {
    try { await processPatient(patient.id, reference); }
    catch (error) {
      failed++;
      // Do not log patient IDs, prescription text or database credentials.
      console.error('Reminder patient job failed:', error.code || error.name);
    }
  }
  await db.query(
    failed
      ? 'UPDATE reminder_worker_status SET last_failed_at = $1 WHERE singleton'
      : 'UPDATE reminder_worker_status SET last_completed_at = $1 WHERE singleton', [reference.toISOString()]);
  if (failed) throw new Error(`${failed} reminder patient jobs failed`);
  return { patients_processed: patients.rows.length };
}

module.exports = { reminderDecision, processPatient, runReminderTick };
