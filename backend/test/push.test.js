const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildMessage, pushConfigured } = require('../src/services/fcm');
const { retryDelay } = require('../src/services/push');

test('push requires explicit configuration and never includes medical or account secrets', () => {
  assert.equal(pushConfigured({}), false);
  assert.equal(pushConfigured({ PUSH_ENABLED: 'true', FIREBASE_PROJECT_ID: 'medisync-4aec5' }), true);
  assert.equal(pushConfigured({ PUSH_ENABLED: 'true', FIREBASE_PROJECT_ID: '../wrong' }), false);
  const message = buildMessage({ token: 'device-token', notification_id: 'notification', binding_id: 'binding',
    kind: 'reminder', expires_at: '2026-10-26T08:15:00Z', patient_name: 'Private', medicine: 'Private' }, new Date('2026-10-26T08:00:00Z'));
  assert.deepEqual(Object.keys(message.data).sort(), ['binding_id', 'expires_at', 'kind', 'notification_id']);
  assert.equal(JSON.stringify(message).includes('Private'), false);
  assert.equal(message.android.ttl, '900s');
  assert.equal(message.android.priority, 'HIGH');
  assert.equal(message.notification, undefined, 'Android data messages are rendered once by the client');
});

test('delivery retries back off and respect provider Retry-After values', () => {
  const now = new Date('2026-10-26T08:00:00Z');
  assert.equal(retryDelay(1, null, now), 60000);
  assert.equal(retryDelay(3, null, now), 240000);
  assert.equal(retryDelay(1, '120', now), 120000);
  assert.equal(retryDelay(1, 'Mon, 26 Oct 2026 08:05:00 GMT', now), 300000);
});
