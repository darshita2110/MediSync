// src/routes/schedules.routes.js

const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { requirePatientAccess } = require('../middleware/access.middleware');
const {
  createSchedule, listSchedules,
  generateDoses, listDoses, confirmDose,
} = require('../controllers/schedules.controller');

const router = express.Router();

// Schedules
router.post('/patients/:patientId/items/:itemId/schedules', requireAuth, requirePatientAccess, createSchedule);
router.get('/patients/:patientId/schedules', requireAuth, requirePatientAccess, listSchedules);

// Doses
router.post('/patients/:patientId/doses/generate', requireAuth, requirePatientAccess, generateDoses);
router.get('/patients/:patientId/doses', requireAuth, requirePatientAccess, listDoses);
router.patch('/patients/:patientId/doses/:doseId', requireAuth, requirePatientAccess, confirmDose);

module.exports = router;