const { transaction } = require('../utils/transaction');
const { lockPatient } = require('./reconciliation');
const { HttpError } = require('../utils/errors');

async function actOnDose(patientId, doseId, userId, action, reference = new Date()) {
  if (!['taken', 'skipped', 'snooze'].includes(action)) throw new HttpError(400, 'Invalid dose action');
  return transaction(async client => {
    await lockPatient(client, patientId);
    // Recheck access after acquiring the patient lock: a revocation may have
    // completed after the HTTP middleware ran.
    const access = await client.query(
      `SELECT role FROM patient_access WHERE patient_id = $1 AND user_id = $2
       AND status = 'accepted' AND role IN ('owner', 'family_admin', 'helper')`, [patientId, userId]);
    if (!access.rows.length) throw new HttpError(403, 'Your role does not permit this action');
    const result = await client.query(
      `SELECT de.*, u.name AS confirmed_by_name,
        (s.is_active AND pi.status = 'active'
         AND (de.scheduled_for AT TIME ZONE p.timezone)::date >= GREATEST(s.start_date, pi.start_date)
         AND (s.end_date IS NULL OR (de.scheduled_for AT TIME ZONE p.timezone)::date <= s.end_date)
         AND (pi.end_date IS NULL OR (de.scheduled_for AT TIME ZONE p.timezone)::date <= pi.end_date)
         AND ($3::boolean = FALSE OR (de.scheduled_for AT TIME ZONE p.timezone)::date =
              ($4::timestamptz AT TIME ZONE p.timezone)::date)) AS eligible
       FROM dose_events de JOIN patients p ON p.id = de.patient_id
       JOIN schedules s ON s.id = de.schedule_id AND s.patient_id = de.patient_id
       JOIN prescription_items pi ON pi.id = s.prescription_item_id AND pi.patient_id = de.patient_id
       LEFT JOIN users u ON u.id = de.confirmed_by
       WHERE de.id = $1 AND de.patient_id = $2 FOR UPDATE OF de`,
      [doseId, patientId, access.rows[0].role === 'helper', reference.toISOString()]);
    const dose = result.rows[0];
    if (!dose) throw new HttpError(404, 'Dose not found for this patient');
    const unchanged = { changed: false, dose: { status: dose.status, confirmed_at: dose.confirmed_at, confirmed_by_name: dose.confirmed_by_name } };
    if (!dose.eligible || !['pending', 'missed'].includes(dose.status)) return unchanged;
    let saved;
    if (action === 'snooze') {
      const deadline = new Date(dose.scheduled_for).getTime() + 45 * 60000;
      if (dose.status !== 'pending' || new Date(dose.scheduled_for) > reference || reference.getTime() >= deadline) return unchanged;
      await client.query(
        `INSERT INTO dose_reminder_state (dose_id, next_reminder_at) VALUES ($1, $2)
         ON CONFLICT (dose_id) DO NOTHING`, [doseId, dose.scheduled_for]);
      const until = new Date(Math.min(reference.getTime() + 10 * 60000, deadline));
      const update = await client.query(
        `UPDATE dose_reminder_state SET next_reminder_at = $2, snoozed_until = $2
         WHERE dose_id = $1 AND reminders_sent < 3 RETURNING snoozed_until`, [doseId, until.toISOString()]);
      if (!update.rows.length) return unchanged;
      saved = { id: doseId, status: dose.status, ...update.rows[0] };
    } else {
      saved = (await client.query(
        `UPDATE dose_events SET status = $2, confirmed_by = $3, confirmed_at = $4
         WHERE id = $1 RETURNING id, status, confirmed_at`, [doseId, action, userId, reference.toISOString()])).rows[0];
      await client.query('UPDATE dose_reminder_state SET snoozed_until = NULL WHERE dose_id = $1', [doseId]);
    }
    await client.query(
      `INSERT INTO audit_log (patient_id, actor_user_id, action, details) VALUES ($1, $2, $3, $4)`,
      [patientId, userId, `dose.${action}`, { dose_id: doseId }]);
    return { changed: true, dose: saved };
  });
}

module.exports = { actOnDose };
