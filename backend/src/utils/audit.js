// src/utils/audit.js
// Small helper to record "who did what" to the audit_log table.
//
// Design rule: auditing must NEVER break the real action. If the log
// write fails, we swallow the error (console only) so the invite/accept/
// etc. still succeeds. The audit trail matters, but not more than the
// action the user was actually performing.

const db = require('../config/db');

/**
 * @param {string}  patientId  the patient this action concerns (or null)
 * @param {string}  actorUserId the logged-in user who did it
 * @param {string}  action     a short verb string, e.g. 'access.invited'
 * @param {object}  [details]  any extra context, stored as JSON
 */
async function logAction(patientId, actorUserId, action, details = {}) {
  try {
    await db.query(
      `INSERT INTO audit_log (patient_id, actor_user_id, action, details)
       VALUES ($1, $2, $3, $4)`,
      [patientId, actorUserId, action, details]
    );
  } catch (err) {
    // Never let an audit failure bubble up into the request.
    console.error('audit log failed:', action, err.message);
  }
}

module.exports = { logAction };