const { randomUUID } = require('node:crypto');
const db = require('../config/db');
const { transaction } = require('../utils/transaction');
const { pushConfigured, sendFcm } = require('./fcm');

function retryDelay(attempt, retryAfter, reference) {
  const seconds = Number(retryAfter);
  const advertised = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(retryAfter) - reference.getTime();
  return Math.max(60000 * 2 ** Math.max(0, attempt - 1), Number.isFinite(advertised) ? Math.min(advertised, 3600000) : 0);
}

async function claim(reference) {
  return transaction(async client => {
    // Expired leases may have been accepted by FCM before a worker crashed.
    // Redelivery carries the same notification ID and replaces the device card.
    await client.query(`UPDATE push_deliveries SET status = 'failed', lease_id = NULL, lease_until = NULL,
      last_error = 'ATTEMPTS_EXHAUSTED' WHERE attempts >= 6 AND status = 'sending' AND lease_until <= $1`, [reference.toISOString()]);
    const row = (await client.query(`SELECT id FROM push_deliveries
      WHERE attempts < 6 AND ((status = 'pending' AND available_at <= $1) OR
        (status = 'sending' AND lease_until <= $1)) ORDER BY available_at, id FOR UPDATE SKIP LOCKED LIMIT 1`,
    [reference.toISOString()])).rows[0];
    if (!row) return null;
    return (await client.query(`UPDATE push_deliveries SET status = 'sending', attempts = attempts + 1,
      lease_id = $2, lease_until = $3::timestamptz + interval '2 minutes' WHERE id = $1 RETURNING *`,
    [row.id, randomUUID(), reference.toISOString()])).rows[0];
  });
}

async function eligible(delivery, reference) {
  const result = await db.query(`SELECT n.id AS notification_id, n.kind, d.token, d.binding_id,
    CASE WHEN n.kind = 'reminder' THEN LEAST(de.scheduled_for + interval '45 minutes', n.created_at + interval '15 minutes')
      ELSE n.created_at + interval '1 hour' END AS expires_at
    FROM push_deliveries q JOIN care_notifications n ON n.id = q.notification_id
    JOIN push_devices d ON d.id = q.device_id AND d.binding_id = q.binding_id AND d.user_id = n.user_id AND d.active
    JOIN patient_access pa ON pa.patient_id = n.patient_id AND pa.user_id = n.user_id AND pa.status = 'accepted'
    JOIN patients p ON p.id = n.patient_id
    JOIN dose_events de ON de.id = n.dose_id AND de.patient_id = n.patient_id
    JOIN schedules s ON s.id = de.schedule_id AND s.patient_id = de.patient_id
    JOIN prescription_items pi ON pi.id = s.prescription_item_id AND pi.patient_id = de.patient_id
    LEFT JOIN dose_reminder_state rs ON rs.dose_id = de.id
    WHERE q.id = $1 AND q.lease_id = $2 AND q.status = 'sending'
      AND n.read_at IS NULL AND n.created_at >= COALESCE(pa.accepted_at, pa.created_at)
      AND (pa.role IN ('owner', 'family_admin') OR (pa.role = 'helper' AND n.kind = 'reminder'
        AND (de.scheduled_for AT TIME ZONE p.timezone)::date = ($3::timestamptz AT TIME ZONE p.timezone)::date))
      AND s.is_active AND pi.status = 'active'
      AND (n.kind = 'missed' AND de.status = 'missed' OR n.kind = 'reminder' AND de.status = 'pending'
        AND COALESCE(rs.snoozed_until, '-infinity') <= $3::timestamptz)
      AND (de.scheduled_for AT TIME ZONE p.timezone)::date >= GREATEST(s.start_date, pi.start_date)
      AND (s.end_date IS NULL OR (de.scheduled_for AT TIME ZONE p.timezone)::date <= s.end_date)
      AND (pi.end_date IS NULL OR (de.scheduled_for AT TIME ZONE p.timezone)::date <= pi.end_date)`,
  [delivery.id, delivery.lease_id, reference.toISOString()]);
  const job = result.rows[0];
  return job && new Date(job.expires_at) > reference ? job : null;
}

async function finish(delivery, status, { error = null, reference = new Date(), delay = 0 } = {}) {
  await db.query(`UPDATE push_deliveries SET status = $3, lease_id = NULL, lease_until = NULL,
    accepted_at = CASE WHEN $3 = 'accepted' THEN $4::timestamptz ELSE accepted_at END,
    available_at = $4::timestamptz + ($5 * interval '1 millisecond'), last_error = $6
    WHERE id = $1 AND lease_id = $2 AND status = 'sending'`,
  [delivery.id, delivery.lease_id, status, reference.toISOString(), delay, error]);
}

async function runPushTick({ reference = new Date(), send = sendFcm, enabled = pushConfigured(), limit = 50, shouldStop = () => false } = {}) {
  if (!enabled) return { accepted: 0, disabled: true };
  let accepted = 0;
  for (let i = 0; i < limit && !shouldStop(); i++) {
    const delivery = await claim(reference);
    if (!delivery) break;
    const job = await eligible(delivery, reference);
    if (!job) { await finish(delivery, 'cancelled', { reference }); continue; }
    try {
      await send(job, reference);
      await finish(delivery, 'accepted', { reference });
      accepted++;
    } catch (error) {
      const code = /^[A-Z_0-9-]{1,80}$/.test(error.code || '') ? error.code : 'TRANSPORT_ERROR';
      if (code === 'UNREGISTERED') {
        await db.query('UPDATE push_devices SET active = FALSE WHERE id = $1 AND binding_id = $2', [delivery.device_id, delivery.binding_id]);
      }
      const permanent = ['UNREGISTERED', 'INVALID_ARGUMENT', 'SENDER_ID_MISMATCH'].includes(code);
      await finish(delivery, permanent || delivery.attempts >= 6 ? 'failed' : 'pending', {
        error: code, reference, delay: retryDelay(delivery.attempts, error.retryAfter, reference),
      });
    }
  }
  return { accepted };
}

module.exports = { retryDelay, runPushTick };
