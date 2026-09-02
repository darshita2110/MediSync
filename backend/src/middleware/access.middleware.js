// src/middleware/access.middleware.js
// Checks that the logged-in user has accepted access to the patient named
// in the URL (:patientId), and remembers their role on the request.
//
// Use it AFTER requireAuth (it needs req.user) on any route shaped like
//   /api/patients/:patientId/...
// Then controllers can read req.patientRole to decide what's allowed.

const db = require('../config/db');

async function requirePatientAccess(req, res, next) {
  const userId = req.user.id;
  const { patientId } = req.params;

  try {
    const result = await db.query(
      `SELECT role FROM patient_access
       WHERE user_id = $1 AND patient_id = $2 AND status = 'accepted'`,
      [userId, patientId]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'You do not have access to this patient' });
    }

    req.patientRole = result.rows[0].role;   // 'owner' | 'family_admin' | 'helper' | 'viewer'
    next();
  } catch (err) {
    console.error('Access check error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

module.exports = { requirePatientAccess };