const express = require('express');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth.middleware');
const { registerIds, uuid } = require('../utils/validation');
const { HttpError } = require('../utils/errors');
const router = express.Router();
registerIds(router, ['notificationId']);
router.use(requireAuth);

// Recheck current membership on every read, including helper calendar limits.
// This also hides alerts from a previous, revoked membership after re-inviting.
const visible = `
  n.user_id = $1 AND pa.status = 'accepted'
  AND n.created_at >= COALESCE(pa.accepted_at, pa.created_at)
  AND (pa.role IN ('owner', 'family_admin') OR
    (pa.role = 'helper' AND n.kind = 'reminder' AND
     (de.scheduled_for AT TIME ZONE p.timezone)::date = (now() AT TIME ZONE p.timezone)::date))`;
const joins = `FROM care_notifications n
  JOIN patients p ON p.id = n.patient_id
  JOIN patient_access pa ON pa.patient_id = n.patient_id AND pa.user_id = n.user_id
  JOIN dose_events de ON de.id = n.dose_id AND de.patient_id = n.patient_id`;

router.get('/', async (req, res) => {
  const before = uuid(req.query.before, 'before', { required: false });
  const result = await db.query(
    `SELECT n.*, p.full_name AS patient_name, p.timezone, pa.role,
       de.scheduled_for, de.status, de.confirmed_at, u.name AS confirmed_by_name,
       pi.raw_text AS medicine, pi.dose_amount, rs.snoozed_until, COALESCE(rs.reminders_sent, 0) AS reminders_sent,
       (de.status IN ('pending', 'missed') AND s.is_active AND pi.status = 'active'
        AND (de.scheduled_for AT TIME ZONE p.timezone)::date >= GREATEST(s.start_date, pi.start_date)
        AND (s.end_date IS NULL OR (de.scheduled_for AT TIME ZONE p.timezone)::date <= s.end_date)
        AND (pi.end_date IS NULL OR (de.scheduled_for AT TIME ZONE p.timezone)::date <= pi.end_date)) AS is_actionable
     ${joins}
     JOIN schedules s ON s.id = de.schedule_id AND s.patient_id = de.patient_id
     JOIN prescription_items pi ON pi.id = s.prescription_item_id AND pi.patient_id = de.patient_id
     LEFT JOIN users u ON u.id = de.confirmed_by
     LEFT JOIN dose_reminder_state rs ON rs.dose_id = de.id
     WHERE ${visible} AND ($2::uuid IS NULL OR (n.created_at, n.id) <
       (SELECT created_at, id FROM care_notifications WHERE id = $2 AND user_id = $1))
     ORDER BY n.created_at DESC, n.id DESC LIMIT 51`, [req.user.id, before]);
  const rows = result.rows.slice(0, 50);
  const worker = (await db.query('SELECT last_completed_at, last_failed_at FROM reminder_worker_status WHERE singleton')).rows[0];
  return res.json({ notifications: rows, next_before: result.rows.length > 50 ? rows.at(-1).id : null,
    delivery: { channel: 'in_app', push_configured: false, ...worker } });
});

router.patch('/:notificationId/read', async (req, res) => {
  const result = await db.query(
    `UPDATE care_notifications SET read_at = COALESCE(read_at, now()) WHERE id IN
     (SELECT n.id ${joins} WHERE ${visible} AND n.id = $2) RETURNING id, read_at`,
    [req.user.id, req.params.notificationId]);
  if (!result.rows.length) throw new HttpError(404, 'Notification not found');
  return res.json({ notification: result.rows[0] });
});

module.exports = router;
