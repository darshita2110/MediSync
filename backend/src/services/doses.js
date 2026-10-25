const { transaction } = require('../utils/transaction');
const { lockPatient } = require('./reconciliation');

// Calendar arithmetic and timezone conversion stay in PostgreSQL. The optional
// reference instant makes DST and date-boundary behavior reproducible in tests.
async function generateForPatient(patientId, daysAhead = 7, reference = new Date()) {
  return transaction(async client => {
    await lockPatient(client, patientId);
    const result = await client.query(
      `WITH eligible AS (
         SELECT s.*, p.timezone, pi.start_date AS medicine_start, pi.end_date AS medicine_end
         FROM schedules s
         JOIN patients p ON p.id = s.patient_id
         JOIN prescription_items pi ON pi.id = s.prescription_item_id AND pi.patient_id = s.patient_id
         WHERE s.patient_id = $1 AND s.is_active AND pi.status = 'active'
       ), inserted AS (
         INSERT INTO dose_events (schedule_id, patient_id, scheduled_for)
         SELECT s.id, s.patient_id, (d.local_day + s.time_of_day) AT TIME ZONE s.timezone
         FROM eligible s CROSS JOIN generate_series(0, $2::integer) AS offsets(day_offset)
         CROSS JOIN LATERAL (
           SELECT ($3::timestamptz AT TIME ZONE s.timezone)::date + offsets.day_offset AS local_day
         ) d
         WHERE d.local_day >= GREATEST(s.start_date, s.medicine_start)
           AND (s.end_date IS NULL OR d.local_day <= s.end_date)
           AND (s.medicine_end IS NULL OR d.local_day <= s.medicine_end)
           AND (cardinality(s.days_of_week) = 0 OR EXTRACT(DOW FROM d.local_day)::smallint = ANY(s.days_of_week))
         ON CONFLICT (schedule_id, scheduled_for) DO NOTHING RETURNING id
       )
       SELECT (SELECT count(*)::integer FROM eligible) AS schedules_processed,
              (SELECT count(*)::integer FROM inserted) AS doses_created`,
      [patientId, daysAhead, reference.toISOString()]);
    return result.rows[0];
  });
}

module.exports = { generateForPatient };
