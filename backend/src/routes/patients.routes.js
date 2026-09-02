// src/routes/patients.routes.js

const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { createPatient, listPatients } = require('../controllers/patients.controller');

const router = express.Router();

// Both routes are protected — you must be logged in.
router.post('/', requireAuth, createPatient);
router.get('/', requireAuth, listPatients);

module.exports = router;