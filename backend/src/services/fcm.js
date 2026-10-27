function pushConfigured(env = process.env) {
  return env.PUSH_ENABLED === 'true' && /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(env.FIREBASE_PROJECT_ID || '');
}

function buildMessage(job, reference = new Date()) {
  const expires = new Date(job.expires_at);
  return { token: job.token,
    data: { notification_id: job.notification_id, binding_id: job.binding_id,
      kind: job.kind, expires_at: expires.toISOString() },
    android: { priority: 'HIGH', ttl: `${Math.max(0, Math.floor((expires - reference) / 1000))}s` } };
}

// Only this adapter knows about Google credentials. No patient name, medicine,
// dose amount, JWT, installation secret or prescription text enters FCM.
let auth;
async function sendFcm(job, reference = new Date()) {
  if (!pushConfigured()) throw Object.assign(new Error('Push disabled'), { code: 'DISABLED' });
  const { GoogleAuth } = require('google-auth-library');
  auth ||= new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    clientOptions: { transporterOptions: { timeout: 10000, retry: false } } });
  const accessToken = await auth.getAccessToken();
  if (!accessToken) throw Object.assign(new Error('No access token'), { code: 'AUTH' });
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/messages:send`, {
    method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: buildMessage(job, reference) }), signal: AbortSignal.timeout(10000),
  });
  const body = await response.json();
  if (!response.ok) {
    const details = body.error?.details || [];
    const code = details.find(d => d['@type']?.endsWith('FcmError'))?.errorCode || body.error?.status || `HTTP_${response.status}`;
    // Store a bounded code, never the provider's message (which may echo tokens).
    throw Object.assign(new Error('FCM rejected message'), { code, retryAfter: response.headers.get('retry-after') });
  }
  // Accepted by FCM is not evidence of physical-device receipt.
  return { accepted: true };
}

module.exports = { pushConfigured, buildMessage, sendFcm };
