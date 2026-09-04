// src/routes/conflicts.routes.js

const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { requirePatientAccess } = require('../middleware/access.middleware');
const {
  runCheck, listConflicts, updateConflict,
} = require('../controllers/conflicts.controller');

const router = express.Router();

router.post('/patients/:patientId/conflicts/check', requireAuth, requirePatientAccess, runCheck);
router.get('/patients/:patientId/conflicts', requireAuth, requirePatientAccess, listConflicts);
router.patch('/patients/:patientId/conflicts/:conflictId', requireAuth, requirePatientAccess, updateConflict);

module.exports = router;