// src/routes/prescriptions.routes.js

const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { requirePatientAccess } = require('../middleware/access.middleware');
const {
  addPrescriber, listPrescribers,
  createPrescription, listPrescriptions, listActiveItems,
} = require('../controllers/prescriptions.controller');

const router = express.Router();

// Every route: must be logged in (requireAuth) AND have access to this
// patient (requirePatientAccess). The two middlewares run in order.
router.post('/patients/:patientId/prescribers', requireAuth, requirePatientAccess, addPrescriber);
router.get('/patients/:patientId/prescribers', requireAuth, requirePatientAccess, listPrescribers);

router.post('/patients/:patientId/prescriptions', requireAuth, requirePatientAccess, createPrescription);
router.get('/patients/:patientId/prescriptions', requireAuth, requirePatientAccess, listPrescriptions);

router.get('/patients/:patientId/items', requireAuth, requirePatientAccess, listActiveItems);

module.exports = router;