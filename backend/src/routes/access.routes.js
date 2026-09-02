// src/routes/access.routes.js

const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const {
  inviteUser,
  listMyInvites,
  acceptInvite,
  listAccess,
} = require('../controllers/access.controller');

const router = express.Router();

// Invites addressed to the logged-in user (not tied to one patient).
router.get('/invites', requireAuth, listMyInvites);
router.post('/invites/:accessId/accept', requireAuth, acceptInvite);

// Access management for a specific patient.
router.post('/patients/:patientId/invites', requireAuth, inviteUser);
router.get('/patients/:patientId/access', requireAuth, listAccess);

module.exports = router;