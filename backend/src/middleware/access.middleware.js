const db = require('../config/db');
const { HttpError } = require('../utils/errors');

async function requirePatientAccess(req, res, next) {
  const result = await db.query(
    `SELECT pa.role, p.timezone FROM patient_access pa
     JOIN patients p ON p.id = pa.patient_id
     WHERE pa.user_id = $1 AND pa.patient_id = $2 AND pa.status = 'accepted'`,
    [req.user.id, req.params.patientId]);
  if (!result.rows.length) throw new HttpError(403, 'You do not have access to this patient');
  req.patientRole = result.rows[0].role;
  req.patientTimezone = result.rows[0].timezone;
  next();
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.patientRole)) return res.status(403).json({ error: 'Your role does not permit this action' });
    next();
  };
}

const manageMedicines = requireRoles('owner', 'family_admin');
const readMedicalRecords = requireRoles('owner', 'family_admin', 'viewer');
const confirmDoses = requireRoles('owner', 'family_admin', 'helper');

module.exports = { requirePatientAccess, requireRoles, manageMedicines, readMedicalRecords, confirmDoses };
