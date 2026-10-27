const express = require('express');
const { createHash, timingSafeEqual } = require('node:crypto');
const db = require('../config/db');
const { transaction } = require('../utils/transaction');
const { requireAuth } = require('../middleware/auth.middleware');
const v = require('../utils/validation');
const { HttpError, badRequest } = require('../utils/errors');
const { pushConfigured } = require('../services/fcm');
const router = express.Router();
v.registerIds(router, ['deviceId']);
router.use(requireAuth);

function secret(body) {
  if (typeof body.installation_secret !== 'string' || !/^[a-f0-9]{64}$/.test(body.installation_secret)) {
    badRequest('installation_secret must contain 64 lowercase hexadecimal characters');
  }
  return createHash('sha256').update(body.installation_secret).digest('hex');
}

router.put('/:deviceId', async (req, res) => {
  const hash = secret(req.body);
  const binding = v.uuid(req.body.binding_id, 'binding_id');
  if (req.body.platform !== 'android') badRequest('Only Android push is configured at this checkpoint');
  const token = v.text(req.body.token, 'token', { required: true, max: 4096 });
  if (!/^[A-Za-z0-9_:.-]{20,4096}$/.test(token)) badRequest('Invalid push token');
  const device = await transaction(async client => {
    // Serialize first registrations as well as updates for this installation.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [req.params.deviceId]);
    const previous = (await client.query('SELECT * FROM push_devices WHERE id = $1 FOR UPDATE', [req.params.deviceId])).rows[0];
    if (previous && !timingSafeEqual(Buffer.from(previous.secret_hash), Buffer.from(hash))) {
      throw new HttpError(403, 'Installation credentials do not match');
    }
    if (previous && previous.user_id !== req.user.id && previous.binding_id === binding) {
      throw new HttpError(409, 'Use a new device binding when switching accounts');
    }
    const collision = await client.query('SELECT id FROM push_devices WHERE token = $1 AND id <> $2', [token, req.params.deviceId]);
    if (collision.rows.length) throw new HttpError(409, 'Refresh the push token and try again');
    let result;
    try {
      result = await client.query(`INSERT INTO push_devices (id, user_id, secret_hash, binding_id, token, platform)
        VALUES ($1, $2, $3, $4, $5, 'android') ON CONFLICT (id) DO UPDATE SET
        user_id = EXCLUDED.user_id, binding_id = EXCLUDED.binding_id, token = EXCLUDED.token,
        active = TRUE, updated_at = now() RETURNING id, binding_id, active`,
      [req.params.deviceId, req.user.id, hash, binding, token]);
    } catch (error) {
      if (error.code === '23505') throw new HttpError(409, 'Refresh the push token and try again');
      throw error;
    }
    await client.query(`UPDATE push_deliveries SET status = 'cancelled', lease_id = NULL, lease_until = NULL
      WHERE device_id = $1 AND binding_id <> $2 AND status IN ('pending', 'sending')`, [req.params.deviceId, binding]);
    return result.rows[0];
  });
  return res.json({ device, push_configured: pushConfigured() });
});

router.delete('/:deviceId', async (req, res) => {
  const hash = secret(req.body);
  const binding = v.uuid(req.body.binding_id, 'binding_id');
  await transaction(async client => {
    const updated = await client.query(`UPDATE push_devices SET active = FALSE, updated_at = now()
      WHERE id = $1 AND user_id = $2 AND binding_id = $3 AND secret_hash = $4 RETURNING id`,
    [req.params.deviceId, req.user.id, binding, hash]);
    if (updated.rows.length) await client.query(`UPDATE push_deliveries SET status = 'cancelled', lease_id = NULL, lease_until = NULL
      WHERE device_id = $1 AND binding_id = $2 AND status IN ('pending', 'sending')`, [req.params.deviceId, binding]);
  });
  return res.json({ disabled: true });
});

module.exports = router;
