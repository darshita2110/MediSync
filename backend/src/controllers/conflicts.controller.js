const db = require('../config/db');
const { reconcile, lockPatient } = require('../services/reconciliation');
const { transaction } = require('../utils/transaction');
const { HttpError, badRequest } = require('../utils/errors');

async function runCheck(req, res) {
  return res.json(await reconcile(req.params.patientId, req.user.id));
}

async function listConflicts(req, res) {
  const status = req.query.status || 'open';
  if (!['open', 'resolved', 'dismissed', 'all'].includes(status)) badRequest('Invalid conflict status');
  const result = await db.query(
    `SELECT c.*, a.raw_text AS item_a_text, b.raw_text AS item_b_text,
            da.name AS item_a_prescriber, dbb.name AS item_b_prescriber,
            pra.visit_date AS item_a_visit_date, prb.visit_date AS item_b_visit_date
     FROM conflicts c
     LEFT JOIN prescription_items a ON a.id = c.item_a_id
     LEFT JOIN prescription_items b ON b.id = c.item_b_id
     LEFT JOIN prescriptions pra ON pra.id = a.prescription_id
     LEFT JOIN prescriptions prb ON prb.id = b.prescription_id
     LEFT JOIN prescribers da ON da.id = pra.prescriber_id AND da.patient_id = c.patient_id
     LEFT JOIN prescribers dbb ON dbb.id = prb.prescriber_id AND dbb.patient_id = c.patient_id
     WHERE c.patient_id = $1 AND ($2::text IS NULL OR c.status = $2::conflict_status)
     ORDER BY c.created_at DESC, c.id`, [req.params.patientId, status === 'all' ? null : status]);
  // Keep older persisted findings readable without changing their audit history.
  return res.json({ conflicts: result.rows.map(row => ({ ...row, description: row.description.replace(/\bdose_amount\b/g, 'dose') })) });
}

async function updateConflict(req, res) {
  const { patientId, conflictId } = req.params;
  const { status } = req.body;
  if (!['resolved', 'dismissed'].includes(status)) badRequest('status must be resolved or dismissed');
  const conflict = await transaction(async client => {
    await lockPatient(client, patientId);
    const existing = await client.query('SELECT * FROM conflicts WHERE id = $1 AND patient_id = $2 FOR UPDATE', [conflictId, patientId]);
    if (!existing.rows.length) throw new HttpError(404, 'Conflict not found for this patient');
    if (existing.rows[0].status === status) return existing.rows[0];
    if (existing.rows[0].status !== 'open') throw new HttpError(409, 'Conflict is already closed');
    const result = await client.query(
      `UPDATE conflicts SET status = $1, resolved_at = now(), resolved_by = $2
       WHERE id = $3 AND patient_id = $4 RETURNING *`, [status, req.user.id, conflictId, patientId]);
    await client.query(
      `INSERT INTO audit_log (patient_id, actor_user_id, action, details) VALUES ($1, $2, $3, $4)`,
      [patientId, req.user.id, `conflict.${status}`, { conflict_id: conflictId }]);
    return result.rows[0];
  });
  return res.json({ conflict });
}

module.exports = { runCheck, listConflicts, updateConflict };
