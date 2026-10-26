const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error('Set TEST_DATABASE_URL, or configure a local DATABASE_URL, to run integration tests');
const host = new URL(connectionString).hostname;
if (!process.env.TEST_DATABASE_URL && !['localhost', '127.0.0.1', '[::1]'].includes(host)) {
  throw new Error('Remote databases require an explicit TEST_DATABASE_URL');
}
const schema = `medisync_test_${randomUUID().replaceAll('-', '')}`;
process.env.DATABASE_URL = connectionString;
process.env.PGOPTIONS = `-c search_path=${schema}`;
process.env.DATABASE_SCHEMA = schema;
process.env.JWT_SECRET = 'medisync-integration-tests-only-secret';
process.env.ALLOWED_ORIGINS = 'http://localhost:5173,http://127.0.0.1:5173';
const admin = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
let db, server, base, owner, helper, viewer, family, outsider, patient, today;

async function api(method, route, body, token = owner?.token) {
  const response = await fetch(base + route, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.json() };
}

async function account(label) {
  const email = `${label}-${randomUUID()}@example.com`;
  const result = await api('POST', '/api/auth/signup', { email, password: 'Test-password-123', name: label }, null);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return { ...result.body, email };
}

async function newPatient(timezone = 'Asia/Kolkata') {
  const result = await api('POST', '/api/patients', { full_name: 'Test patient', timezone });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.patient;
}

async function medicine(patientId = patient.id, fields = {}) {
  const result = await api('POST', `/api/patients/${patientId}/prescriptions`, {
    visit_date: today, items: [{ raw_text: 'Example medicine', start_date: today, ...fields }],
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.prescription.items[0];
}

async function schedule(item, fields = {}, patientId = patient.id) {
  const result = await api('POST', `/api/patients/${patientId}/items/${item.id}/schedules`, { time_of_day: '08:00', ...fields });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.schedule;
}

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  db = require('../../src/config/db');
  const current = await db.query('SELECT current_schema() AS schema');
  assert.equal(current.rows[0].schema, schema, 'Schema isolation must be verified before applying migrations');
  await require('../../src/db/migrations').migrate(db.pool, { schema });
  server = require('../../src/app').listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await account('owner');
  helper = await account('helper');
  viewer = await account('viewer');
  family = await account('family');
  outsider = await account('outsider');
  patient = await newPatient();
  today = (await db.query("SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS day")).rows[0].day;
  for (const [user, role] of [[helper, 'helper'], [viewer, 'viewer'], [family, 'family_admin']]) {
    const invite = await api('POST', `/api/patients/${patient.id}/invites`, { email: user.email, role });
    assert.equal(invite.status, 201);
    assert.equal((await api('POST', `/api/invites/${invite.body.invite.id}/accept`, {}, user.token)).status, 200);
  }
});

after(async () => {
  if (server) {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
  if (db) await db.pool.end();
  assert.match(schema, /^medisync_test_[0-9a-f]{32}$/);
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

test('health and authentication protection work through HTTP', async () => {
  assert.equal((await api('GET', '/api/health', undefined, null)).status, 200);
  assert.equal((await api('GET', '/api/health/db', undefined, null)).status, 200);
  assert.equal((await api('GET', '/api/patients', undefined, null)).status, 401);
  assert.equal((await api('GET', '/api/patients', undefined, 'invalid')).status, 401);
  const malformedToken = jwt.sign({ userId: 'not-a-uuid' }, process.env.JWT_SECRET);
  assert.equal((await api('GET', '/api/patients', undefined, malformedToken)).status, 401);
});

test('signup/login normalize email, return no hash and reject duplicate accounts', async () => {
  const login = await api('POST', '/api/auth/login', { email: `  ${owner.email.toUpperCase()} `, password: 'Test-password-123' }, null);
  assert.equal(login.status, 200);
  assert.equal(login.body.user.id, owner.user.id);
  assert.equal(login.body.user.password_hash, undefined);
  assert.equal((await api('POST', '/api/auth/signup', { email: owner.email, password: 'Test-password-123' }, null)).status, 409);
  assert.equal((await api('POST', '/api/auth/login', { email: owner.email, password: 'wrong-password' }, null)).status, 401);
});

test('invalid bodies, malformed JSON and IDs return JSON client errors', async () => {
  for (const body of [{ email: 123, password: 'valid-password' }, { email: 'invalid', password: 'valid-password' }, [], null]) {
    assert.equal((await api('POST', '/api/auth/signup', body, null)).status, 400);
  }
  const malformed = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'Invalid JSON' });
  assert.equal((await api('GET', '/api/patients/not-a-uuid/items')).status, 400);
  assert.equal((await api('GET', '/api/does-not-exist')).status, 404);
});

test('patient creation is atomic and validates names, birth dates and timezones', async () => {
  for (const fields of [{ full_name: ' ' }, { full_name: 'Test', timezone: 'Invalid/Zone' }, { full_name: 'Test', date_of_birth: '2025-02-29' }, { full_name: 'Test', date_of_birth: '2999-01-01' }]) {
    assert.equal((await api('POST', '/api/patients', fields)).status, 400);
  }
  const access = await db.query('SELECT role, status FROM patient_access WHERE patient_id = $1 AND user_id = $2', [patient.id, owner.user.id]);
  assert.deepEqual(access.rows[0], { role: 'owner', status: 'accepted' });
  const list = await api('GET', '/api/patients', undefined, outsider.token);
  assert.deepEqual(list.body.patients, []);
});

test('pending invites grant no access and only the invitee can accept them', async () => {
  const p = await newPatient();
  const invite = await api('POST', `/api/patients/${p.id}/invites`, { email: outsider.email, role: 'viewer' });
  assert.equal(invite.status, 201);
  assert.equal((await api('GET', `/api/patients/${p.id}/items`, undefined, outsider.token)).status, 403);
  assert.equal((await api('POST', `/api/invites/${invite.body.invite.id}/accept`, {}, helper.token)).status, 404);
  assert.equal((await api('POST', `/api/invites/${invite.body.invite.id}/accept`, {}, outsider.token)).status, 200);
  assert.equal((await api('GET', `/api/patients/${p.id}/items`, undefined, outsider.token)).status, 200);
});

test('helpers and viewers cannot manage medicines or generate doses; only owners invite', async () => {
  for (const user of [helper, viewer]) {
    assert.equal((await api('POST', `/api/patients/${patient.id}/prescribers`, { name: 'Doctor' }, user.token)).status, 403);
    assert.equal((await api('POST', `/api/patients/${patient.id}/prescriptions`, { visit_date: today, items: [{ raw_text: 'Example' }] }, user.token)).status, 403);
    assert.equal((await api('POST', `/api/patients/${patient.id}/doses/generate`, {}, user.token)).status, 403);
    assert.equal((await api('POST', `/api/patients/${patient.id}/conflicts/check`, {}, user.token)).status, 403);
  }
  assert.equal((await api('POST', `/api/patients/${patient.id}/prescribers`, { name: 'Family doctor' }, family.token)).status, 201);
  assert.equal((await api('POST', `/api/patients/${patient.id}/invites`, { email: outsider.email, role: 'viewer' }, family.token)).status, 403);
  for (const resource of ['prescribers', 'prescriptions', 'items', 'conflicts', 'access']) {
    assert.equal((await api('GET', `/api/patients/${patient.id}/${resource}`, undefined, helper.token)).status, 403);
    assert.equal((await api('GET', `/api/patients/${patient.id}/${resource}`, undefined, viewer.token)).status, 200);
  }
});

test('unrelated users cannot read or mutate another patient', async () => {
  for (const resource of ['items', 'prescribers', 'prescriptions', 'conflicts', 'schedules', 'doses', 'access']) {
    assert.equal((await api('GET', `/api/patients/${patient.id}/${resource}`, undefined, outsider.token)).status, 403);
  }
});

test('prescriptions cannot link to a doctor belonging to another patient', async () => {
  const p = await newPatient();
  const doctor = await api('POST', `/api/patients/${p.id}/prescribers`, { name: 'Other doctor' });
  const result = await api('POST', `/api/patients/${patient.id}/prescriptions`, { prescriber_id: doctor.body.prescriber.id, visit_date: today, items: [{ raw_text: 'Example' }] });
  assert.equal(result.status, 404);
  const persisted = await db.query('SELECT count(*)::integer AS n FROM prescriptions WHERE patient_id = $1 AND prescriber_id = $2', [patient.id, doctor.body.prescriber.id]);
  assert.equal(persisted.rows[0].n, 0);
});

test('invalid medicine batches are rejected before a partial prescription can persist', async () => {
  const before = await db.query('SELECT count(*)::integer AS n FROM prescriptions WHERE patient_id = $1', [patient.id]);
  for (const items of [[{ raw_text: 'Valid' }, null], [{ raw_text: ' ' }], [{ raw_text: 'Example', start_date: '2026-03-01', end_date: '2026-02-28' }]]) {
    assert.equal((await api('POST', `/api/patients/${patient.id}/prescriptions`, { visit_date: today, items })).status, 400);
  }
  const after = await db.query('SELECT count(*)::integer AS n FROM prescriptions WHERE patient_id = $1', [patient.id]);
  assert.equal(after.rows[0].n, before.rows[0].n);
});

test('active medicine list excludes future, expired, and stopped courses', async () => {
  const p = await newPatient();
  const current = await medicine(p.id);
  await medicine(p.id, { start_date: '2999-01-01' });
  await medicine(p.id, { start_date: '2000-01-01', end_date: '2000-01-02' });
  const stopped = await medicine(p.id);
  await db.query("UPDATE prescription_items SET status = 'stopped' WHERE id = $1", [stopped.id]);
  const list = await api('GET', `/api/patients/${p.id}/items`);
  assert.deepEqual(list.body.items.map(x => x.id), [current.id]);
});

test('schedule validation rejects invalid times, weekdays, course dates and cross-patient items', async () => {
  const item = await medicine();
  for (const fields of [{ time_of_day: '24:00' }, { time_of_day: '08:00', days_of_week: [7] }, { time_of_day: '08:00', days_of_week: [1, 1] }, { time_of_day: '08:00', start_date: '2000-01-01' }]) {
    assert.equal((await api('POST', `/api/patients/${patient.id}/items/${item.id}/schedules`, fields)).status, 400);
  }
  const p = await newPatient();
  assert.equal((await api('POST', `/api/patients/${p.id}/items/${item.id}/schedules`, { time_of_day: '08:00' })).status, 404);
});

test('zero-day generation creates only today, is idempotent, and preserves schedule seconds', async () => {
  const p = await newPatient();
  const item = await medicine(p.id);
  const s = await schedule(item, { time_of_day: '08:00:37' }, p.id);
  const first = await api('POST', `/api/patients/${p.id}/doses/generate`, { days_ahead: 0 });
  assert.equal(first.status, 200);
  assert.equal(first.body.doses_created, 1);
  assert.equal((await api('POST', `/api/patients/${p.id}/doses/generate`, { days_ahead: 0 })).body.doses_created, 0);
  const dose = await db.query('SELECT scheduled_for FROM dose_events WHERE schedule_id = $1', [s.id]);
  assert.equal(dose.rows[0].scheduled_for.toISOString(), `${today}T02:30:37.000Z`);
  for (const days of [-1, 31, '7', 0.5]) assert.equal((await api('POST', `/api/patients/${p.id}/doses/generate`, { days_ahead: days })).status, 400);
});

test('generation honors medicine end dates, stopped medicines and weekday filters', async () => {
  const p = await newPatient();
  const item = await medicine(p.id, { end_date: today });
  await schedule(item, {}, p.id);
  assert.equal((await api('POST', `/api/patients/${p.id}/doses/generate`, { days_ahead: 7 })).body.doses_created, 1);
  await db.query("UPDATE prescription_items SET status = 'stopped' WHERE id = $1", [item.id]);
  assert.equal((await api('POST', `/api/patients/${p.id}/doses/generate`, { days_ahead: 7 })).body.schedules_processed, 0);
  const weekdayItem = await medicine(p.id);
  await schedule(weekdayItem, { days_of_week: [new Date(today + 'T00:00:00Z').getUTCDay()] }, p.id);
  assert.equal((await api('POST', `/api/patients/${p.id}/doses/generate`, { days_ahead: 6 })).body.doses_created, 1);
});

test('patient-local generation crosses daylight saving and midnight independently of server timezone', async () => {
  const { generateForPatient } = require('../../src/services/doses');
  const p = await newPatient('America/New_York');
  const item = await medicine(p.id, { start_date: '2026-01-01', end_date: '2026-12-31' });
  const s = await schedule(item, { time_of_day: '08:00', start_date: '2026-01-01', end_date: '2026-12-31' }, p.id);
  await generateForPatient(p.id, 1, new Date('2026-03-07T12:00:00Z'));
  const doses = await db.query('SELECT scheduled_for FROM dose_events WHERE schedule_id = $1 ORDER BY scheduled_for', [s.id]);
  assert.deepEqual(doses.rows.map(x => x.scheduled_for.toISOString()), ['2026-03-07T13:00:00.000Z', '2026-03-08T12:00:00.000Z']);
  const result = await generateForPatient(p.id, 0, new Date('2026-03-10T02:00:00Z'));
  assert.equal(result.doses_created, 1);
  const last = await db.query('SELECT scheduled_for FROM dose_events WHERE schedule_id = $1 ORDER BY scheduled_for DESC LIMIT 1', [s.id]);
  assert.equal(last.rows[0].scheduled_for.toISOString(), '2026-03-09T12:00:00.000Z');
});

test('concurrent confirmations accept one caregiver and preserve that confirmation', async () => {
  const item = await medicine();
  const s = await schedule(item);
  await api('POST', `/api/patients/${patient.id}/doses/generate`, { days_ahead: 0 });
  const dose = (await db.query('SELECT id FROM dose_events WHERE schedule_id = $1', [s.id])).rows[0];
  const results = await Promise.all([
    api('PATCH', `/api/patients/${patient.id}/doses/${dose.id}`, { status: 'taken' }, owner.token),
    api('PATCH', `/api/patients/${patient.id}/doses/${dose.id}`, { status: 'skipped' }, helper.token),
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const saved = (await db.query('SELECT status, confirmed_by FROM dose_events WHERE id = $1', [dose.id])).rows[0];
  const winner = results.findIndex(r => r.status === 200);
  assert.equal(saved.status, winner === 0 ? 'taken' : 'skipped');
  assert.equal(saved.confirmed_by, winner === 0 ? owner.user.id : helper.user.id);
  assert.equal((await api('PATCH', `/api/patients/${patient.id}/doses/${dose.id}`, { status: 'taken' }, viewer.token)).status, 403);
});

test('helpers see only today and cannot confirm another day even when requesting a wider range', async () => {
  const item = await medicine();
  const s = await schedule(item);
  await api('POST', `/api/patients/${patient.id}/doses/generate`, { days_ahead: 1 });
  const list = await api('GET', `/api/patients/${patient.id}/doses?from=2000-01-01&to=2000-01-02`, undefined, helper.token);
  assert.equal(list.status, 200);
  assert.ok(list.body.doses.length > 0);
  assert.ok(list.body.doses.every(d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d.scheduled_for)) === today));
  const future = (await db.query('SELECT id FROM dose_events WHERE schedule_id = $1 ORDER BY scheduled_for DESC LIMIT 1', [s.id])).rows[0];
  assert.equal((await api('PATCH', `/api/patients/${patient.id}/doses/${future.id}`, { status: 'taken' }, helper.token)).status, 409);
});

test('dose filtering includes the entire to date in the patient timezone', async () => {
  const list = await api('GET', `/api/patients/${patient.id}/doses?from=${today}&to=${today}`);
  assert.equal(list.status, 200);
  assert.ok(list.body.doses.length > 0);
  assert.equal((await api('GET', `/api/patients/${patient.id}/doses?from=2026-02-30`)).status, 400);
  assert.equal((await api('GET', `/api/patients/${patient.id}/conflicts?status=invalid`)).status, 400);
});

test('prescription creation automatically checks every duplicate pair and different instructions', async () => {
  const p = await newPatient();
  const doctorA = (await api('POST', `/api/patients/${p.id}/prescribers`, { name: 'Dr. A' })).body.prescriber;
  const doctorB = (await api('POST', `/api/patients/${p.id}/prescribers`, { name: 'Dr. B' })).body.prescriber;
  for (const [doctor, amount] of [[doctorA, '1 tablet'], [doctorB, '2 tablets'], [doctorB, '1 tablet']]) {
    const result = await api('POST', `/api/patients/${p.id}/prescriptions`, {
      prescriber_id: doctor.id, visit_date: today, items: [{ raw_text: 'Example brand', brand_name: 'Example', dose_amount: amount }],
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
  }
  const list = await api('GET', `/api/patients/${p.id}/conflicts`);
  assert.equal(list.body.conflicts.filter(c => c.kind === 'duplicate_medicine').length, 3);
  assert.equal(list.body.conflicts.filter(c => c.kind === 'different_instructions').length, 2);
  assert.ok(list.body.conflicts.every(c => c.description.includes('Dr.')));
});

test('concurrent reconciliation checks do not duplicate findings and dismissed findings stay dismissed', async () => {
  const p = await newPatient();
  await medicine(p.id, { brand_name: 'Duplicate' });
  await medicine(p.id, { brand_name: 'Duplicate' });
  const checks = await Promise.all(Array.from({ length: 4 }, () => api('POST', `/api/patients/${p.id}/conflicts/check`, {})));
  assert.ok(checks.every(c => c.status === 200 && c.body.new_conflicts === 0));
  const conflicts = (await api('GET', `/api/patients/${p.id}/conflicts`)).body.conflicts;
  assert.equal(conflicts.length, 1);
  assert.equal((await api('PATCH', `/api/patients/${p.id}/conflicts/${conflicts[0].id}`, { status: 'dismissed' })).status, 200);
  assert.equal((await api('POST', `/api/patients/${p.id}/conflicts/check`, {})).body.new_conflicts, 0);
  assert.equal((await api('GET', `/api/patients/${p.id}/conflicts`)).body.conflicts.length, 0);
  assert.equal((await api('GET', `/api/patients/${p.id}/conflicts?status=all`)).body.conflicts.length, 1);
});

test('overdue courses are flagged while completed courses disappear from open conflicts', async () => {
  const p = await newPatient();
  const item = await medicine(p.id, { start_date: '2000-01-01', end_date: '2000-01-02' });
  const conflicts = (await api('GET', `/api/patients/${p.id}/conflicts`)).body.conflicts;
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, 'course_ended');
  assert.equal((await api('PATCH', `/api/patients/${p.id}/items/${item.id}`, { status: 'completed' })).status, 200);
  assert.equal((await api('GET', `/api/patients/${p.id}/conflicts`)).body.conflicts.length, 0);
  assert.equal((await api('GET', `/api/patients/${p.id}/conflicts?status=resolved`)).body.conflicts.length, 1);
});

test('stopping a medicine deactivates schedules, removes future pending forecasts and preserves confirmations', async () => {
  const p = await newPatient();
  const item = await medicine(p.id);
  const s = await schedule(item, {}, p.id);
  await api('POST', `/api/patients/${p.id}/doses/generate`, { days_ahead: 2 });
  const dose = (await db.query('SELECT id FROM dose_events WHERE schedule_id = $1 ORDER BY scheduled_for LIMIT 1', [s.id])).rows[0];
  assert.equal((await api('PATCH', `/api/patients/${p.id}/doses/${dose.id}`, { status: 'taken' })).status, 200);
  const stopped = await api('PATCH', `/api/patients/${p.id}/items/${item.id}`, { status: 'stopped' });
  assert.equal(stopped.status, 200);
  assert.equal((await api('PATCH', `/api/patients/${p.id}/items/${item.id}`, { status: 'stopped' })).status, 200);
  assert.equal((await api('PATCH', `/api/patients/${p.id}/items/${item.id}`, { status: 'completed' })).status, 409);
  assert.equal((await api('GET', `/api/patients/${p.id}/schedules`)).body.schedules.length, 0);
  assert.equal((await api('POST', `/api/patients/${p.id}/doses/generate`, { days_ahead: 2 })).body.doses_created, 0);
  const saved = await db.query('SELECT status FROM dose_events WHERE schedule_id = $1', [s.id]);
  assert.deepEqual(saved.rows, [{ status: 'taken' }]);
});

test('medicine lifecycle permissions and patient boundaries are enforced', async () => {
  const item = await medicine();
  for (const user of [helper, viewer]) assert.equal((await api('PATCH', `/api/patients/${patient.id}/items/${item.id}`, { status: 'stopped' }, user.token)).status, 403);
  const other = await newPatient();
  assert.equal((await api('PATCH', `/api/patients/${other.id}/items/${item.id}`, { status: 'stopped' })).status, 404);
  assert.equal((await api('PATCH', `/api/patients/${patient.id}/items/${item.id}`, { status: 'active' })).status, 400);
  assert.equal((await api('PATCH', `/api/patients/${patient.id}/items/${item.id}`, { status: 'completed' }, family.token)).status, 200);
});

test('immediate replacements close the previous medicine and preserve the replacement link atomically', async () => {
  const p = await newPatient();
  const item = await medicine(p.id);
  await schedule(item, {}, p.id);
  const replacement = await medicine(p.id, { raw_text: 'Changed medicine', replaces_item_id: item.id });
  assert.equal(replacement.replaces_item_id, item.id);
  const old = (await db.query('SELECT status FROM prescription_items WHERE id = $1', [item.id])).rows[0];
  assert.equal(old.status, 'stopped');
  const active = (await api('GET', `/api/patients/${p.id}/items`)).body.items;
  assert.deepEqual(active.map(i => i.id), [replacement.id]);
  assert.equal((await api('GET', `/api/patients/${p.id}/schedules`)).body.schedules.length, 0);
});

test('future replacements bound the previous course without stopping it early', async () => {
  const p = await newPatient();
  const item = await medicine(p.id);
  const s = await schedule(item, {}, p.id);
  const tomorrow = (await db.query('SELECT ($1::date + 1)::text AS day', [today])).rows[0].day;
  const laterSchedule = await schedule(item, { time_of_day: '20:00', start_date: tomorrow }, p.id);
  await api('POST', `/api/patients/${p.id}/doses/generate`, { days_ahead: 7 });
  const replacement = await medicine(p.id, { start_date: tomorrow, replaces_item_id: item.id });
  assert.equal(replacement.replaces_item_id, item.id);
  const old = (await db.query('SELECT status, end_date::text FROM prescription_items WHERE id = $1', [item.id])).rows[0];
  assert.deepEqual(old, { status: 'active', end_date: today });
  assert.deepEqual((await api('GET', `/api/patients/${p.id}/items`)).body.items.map(i => i.id), [item.id]);
  const doses = await db.query('SELECT id FROM dose_events WHERE schedule_id = $1', [s.id]);
  assert.equal(doses.rows.length, 1);
  const bounded = (await db.query('SELECT is_active, end_date IS NULL OR end_date >= start_date AS valid_window FROM schedules WHERE id = $1', [laterSchedule.id])).rows[0];
  assert.deepEqual(bounded, { is_active: false, valid_window: true });
  const duplicate = await api('POST', `/api/patients/${p.id}/prescriptions`, { visit_date: today, items: [{ raw_text: 'Another', start_date: tomorrow, replaces_item_id: item.id }] });
  assert.equal(duplicate.status, 409);
});

test('a failed replacement batch rolls back all medicine and schedule changes', async () => {
  const p = await newPatient();
  const item = await medicine(p.id);
  const s = await schedule(item, {}, p.id);
  const result = await api('POST', `/api/patients/${p.id}/prescriptions`, {
    visit_date: today, items: [{ raw_text: 'Valid replacement', replaces_item_id: item.id }, { raw_text: 'Invalid replacement', replaces_item_id: randomUUID() }],
  });
  assert.equal(result.status, 404);
  assert.equal((await db.query('SELECT status FROM prescription_items WHERE id = $1', [item.id])).rows[0].status, 'active');
  assert.equal((await db.query('SELECT is_active FROM schedules WHERE id = $1', [s.id])).rows[0].is_active, true);
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM prescriptions WHERE patient_id = $1', [p.id])).rows[0].n, 1);
});

test('stopping one duplicate automatically resolves its open conflict', async () => {
  const p = await newPatient();
  await medicine(p.id, { brand_name: 'Duplicate' });
  const item = await medicine(p.id, { brand_name: 'Duplicate' });
  assert.equal((await api('GET', `/api/patients/${p.id}/conflicts`)).body.conflicts.length, 1);
  const result = await api('PATCH', `/api/patients/${p.id}/items/${item.id}`, { status: 'stopped' });
  assert.equal(result.body.reconciliation.auto_resolved, 1);
  assert.equal((await api('GET', `/api/patients/${p.id}/conflicts`)).body.conflicts.length, 0);
});

test('owners can revoke accepted or pending access; removed caregivers lose access immediately', async () => {
  const p = await newPatient();
  let invite = await api('POST', `/api/patients/${p.id}/invites`, { email: outsider.email, role: 'helper' });
  await api('POST', `/api/invites/${invite.body.invite.id}/accept`, {}, outsider.token);
  assert.equal((await api('GET', `/api/patients/${p.id}/doses`, undefined, outsider.token)).status, 200);
  assert.equal((await api('DELETE', `/api/patients/${p.id}/access/${invite.body.invite.id}`)).status, 200);
  assert.equal((await api('GET', `/api/patients/${p.id}/doses`, undefined, outsider.token)).status, 403);
  invite = await api('POST', `/api/patients/${p.id}/invites`, { email: outsider.email, role: 'viewer' });
  assert.equal(invite.status, 201);
  assert.equal((await api('DELETE', `/api/patients/${p.id}/access/${invite.body.invite.id}`)).status, 200);
  assert.equal((await api('POST', `/api/invites/${invite.body.invite.id}/accept`, {}, outsider.token)).status, 404);
});

test('owner protection, revocation role boundaries and cross-patient access IDs are enforced', async () => {
  const access = (await api('GET', `/api/patients/${patient.id}/access`)).body.access;
  const ownerRow = access.find(a => a.role === 'owner');
  const helperRow = access.find(a => a.user_id === helper.user.id);
  assert.equal((await api('DELETE', `/api/patients/${patient.id}/access/${ownerRow.id}`)).status, 409);
  for (const user of [family, helper, viewer]) assert.equal((await api('DELETE', `/api/patients/${patient.id}/access/${helperRow.id}`, undefined, user.token)).status, 403);
  const p = await newPatient();
  assert.equal((await api('DELETE', `/api/patients/${p.id}/access/${helperRow.id}`)).status, 404);
});

test('overlapping schedules are rejected concurrently, and deactivation preserves history', async () => {
  const p = await newPatient();
  const item = await medicine(p.id);
  const results = await Promise.all(Array.from({ length: 2 }, () => api('POST', `/api/patients/${p.id}/items/${item.id}/schedules`, { time_of_day: '08:00' })));
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  const s = results.find(r => r.status === 201).body.schedule;
  await api('POST', `/api/patients/${p.id}/doses/generate`, { days_ahead: 1 });
  const dose = (await db.query('SELECT id FROM dose_events WHERE schedule_id = $1 ORDER BY scheduled_for LIMIT 1', [s.id])).rows[0];
  await api('PATCH', `/api/patients/${p.id}/doses/${dose.id}`, { status: 'taken' });
  assert.equal((await api('PATCH', `/api/patients/${p.id}/schedules/${s.id}`, { is_active: false })).status, 200);
  const remaining = (await db.query('SELECT status FROM dose_events WHERE schedule_id = $1', [s.id])).rows;
  assert.deepEqual(remaining, [{ status: 'taken' }]);
  assert.equal((await api('POST', `/api/patients/${p.id}/doses/generate`, { days_ahead: 1 })).body.doses_created, 0);
});

test('browser preflights allow only configured origins and still require authentication for data', async () => {
  const preflight = await fetch(base + '/api/patients', { method: 'OPTIONS', headers: {
    Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type',
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const denied = await fetch(base + '/api/patients', { headers: { Origin: 'https://untrusted.example', Authorization: `Bearer ${owner.token}` } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  const anonymous = await fetch(base + '/api/patients', { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(anonymous.status, 401);
});

test('calendar dates are returned as YYYY-MM-DD rather than timezone-dependent instants', async () => {
  const p = await api('POST', '/api/patients', { full_name: 'Calendar test', date_of_birth: '1958-03-15' });
  assert.equal(p.body.patient.date_of_birth, '1958-03-15');
  const result = await api('POST', `/api/patients/${p.body.patient.id}/prescriptions`, {
    visit_date: '2026-10-25', items: [{ raw_text: 'Calendar medicine', start_date: '2026-10-25', end_date: '2026-11-01' }],
  });
  assert.equal(result.body.prescription.visit_date, '2026-10-25');
  assert.equal(result.body.prescription.items[0].start_date, '2026-10-25');
  assert.equal(result.body.prescription.items[0].end_date, '2026-11-01');
});

test('timeline marks inactive historical pending doses as ineligible', async () => {
  const p = await newPatient();
  const item = await medicine(p.id);
  const s = await schedule(item, { time_of_day: '00:00' }, p.id);
  await api('POST', `/api/patients/${p.id}/doses/generate`, { days_ahead: 0 });
  let list = await api('GET', `/api/patients/${p.id}/doses?from=${today}&to=${today}`);
  assert.equal(list.body.doses[0].is_actionable, true);
  await api('PATCH', `/api/patients/${p.id}/schedules/${s.id}`, { is_active: false });
  list = await api('GET', `/api/patients/${p.id}/doses?from=${today}&to=${today}`);
  assert.equal(list.body.doses[0].is_actionable, false);
});

// Synthetic clock fixtures exercise production SQL without a 45-minute wait.
async function reminderFixture(offset = 0) {
  const p = await newPatient('UTC');
  const item = await medicine(p.id, { start_date: '2020-01-01' });
  const rule = await schedule(item, { start_date: '2020-01-01', time_of_day: '23:59' }, p.id);
  const reference = new Date(Date.now() + offset * 60000);
  await db.query("UPDATE patient_access SET accepted_at = $2::timestamptz - interval '2 days' WHERE patient_id = $1", [p.id, reference.toISOString()]);
  for (const [user, role] of [[family, 'family_admin'], [helper, 'helper'], [viewer, 'viewer']]) {
    await db.query(`INSERT INTO patient_access (patient_id, user_id, role, status, accepted_at)
      VALUES ($1, $2, $3, 'accepted', $4::timestamptz - interval '2 days')`, [p.id, user.user.id, role, reference.toISOString()]);
  }
  const dose = (await db.query(`INSERT INTO dose_events (schedule_id, patient_id, scheduled_for)
    VALUES ($1, $2, $3) RETURNING *`, [rule.id, p.id, reference.toISOString()])).rows[0];
  return { patient: p, item, rule, dose, reference, at: minute => new Date(reference.getTime() + minute * 60000) };
}
async function alertsFor(id) {
  return (await db.query('SELECT * FROM care_notifications WHERE dose_id = $1 ORDER BY stage, user_id', [id])).rows;
}

test('worker generates automatically, sends three reminders, and alerts only family at 45 minutes', async () => {
  const { processPatient } = require('../../src/services/reminders');
  const noon = new Date(); noon.setUTCHours(12, 0, 0, 0);
  const f = await reminderFixture((noon.getTime() - Date.now()) / 60000);
  for (const minute of [0, 15, 30, 45]) {
    await Promise.all([processPatient(f.patient.id, f.at(minute)), processPatient(f.patient.id, f.at(minute))]);
    await processPatient(f.patient.id, f.at(minute));
  }
  const rows = await alertsFor(f.dose.id);
  assert.equal(rows.filter(n => n.kind === 'reminder').length, 9);
  assert.equal(rows.filter(n => n.kind === 'missed').length, 2);
  assert.ok(rows.filter(n => n.kind === 'missed').every(n => [owner.user.id, family.user.id].includes(n.user_id)));
  assert.ok(rows.every(n => n.user_id !== viewer.user.id));
  assert.equal((await db.query('SELECT status FROM dose_events WHERE id = $1', [f.dose.id])).rows[0].status, 'missed');
  assert.equal((await db.query('SELECT reminders_sent FROM dose_reminder_state WHERE dose_id = $1', [f.dose.id])).rows[0].reminders_sent, 3);
  assert.ok((await db.query('SELECT count(*)::int AS n FROM dose_events WHERE patient_id = $1', [f.patient.id])).rows[0].n > 1);
});

test('snooze is durable and shared, and never moves the escalation deadline', async () => {
  const { processPatient } = require('../../src/services/reminders');
  const { actOnDose } = require('../../src/services/dose-actions');
  const noon = new Date(); noon.setUTCHours(12, 0, 0, 0);
  const f = await reminderFixture((noon.getTime() - Date.now()) / 60000);
  await processPatient(f.patient.id, f.reference);
  const result = await actOnDose(f.patient.id, f.dose.id, helper.user.id, 'snooze', f.at(1));
  assert.ok(result.changed);
  assert.equal(result.dose.snoozed_until.toISOString(), f.at(11).toISOString());
  await processPatient(f.patient.id, f.at(10));
  assert.equal((await alertsFor(f.dose.id)).length, 3);
  await processPatient(f.patient.id, f.at(11));
  assert.equal((await alertsFor(f.dose.id)).length, 6);
  await actOnDose(f.patient.id, f.dose.id, owner.user.id, 'snooze', f.at(40));
  await processPatient(f.patient.id, f.at(44));
  assert.equal((await alertsFor(f.dose.id)).length, 6);
  await processPatient(f.patient.id, f.at(45));
  assert.equal((await alertsFor(f.dose.id)).filter(n => n.kind === 'missed').length, 2);
  assert.equal((await actOnDose(f.patient.id, f.dose.id, owner.user.id, 'snooze', f.at(46))).changed, false);
});

test('missed doses accept one late confirmation and show the saved result in family alerts', async () => {
  const { processPatient } = require('../../src/services/reminders');
  const f = await reminderFixture(-46);
  await processPatient(f.patient.id, f.at(45));
  const path = `/api/patients/${f.patient.id}/doses/${f.dose.id}`;
  const confirmations = await Promise.all([
    api('PATCH', path, { status: 'taken' }), api('PATCH', path, { status: 'skipped' }, family.token),
  ]);
  assert.deepEqual(confirmations.map(r => r.status).sort(), [200, 409]);
  const saved = (await db.query('SELECT status FROM dose_events WHERE id = $1', [f.dose.id])).rows[0].status;
  await processPatient(f.patient.id, new Date());
  assert.equal((await alertsFor(f.dose.id)).length, 2);
  const inbox = await api('GET', '/api/notifications');
  assert.equal(inbox.body.notifications.find(n => n.dose_id === f.dose.id).status, saved);
  assert.equal((await api('POST', path + '/snooze', {})).status, 409);
});

test('delayed ticks avoid reminder bursts and old backlog emits no family alerts', async () => {
  const { processPatient } = require('../../src/services/reminders');
  const f = await reminderFixture(-26 * 60);
  await processPatient(f.patient.id, f.at(26 * 60));
  assert.equal((await alertsFor(f.dose.id)).length, 0);
  assert.equal((await db.query('SELECT status FROM dose_events WHERE id = $1', [f.dose.id])).rows[0].status, 'missed');
  const recent = await reminderFixture();
  await processPatient(recent.patient.id, recent.at(29));
  await processPatient(recent.patient.id, recent.at(30));
  assert.equal((await alertsFor(recent.dose.id)).length, 3);
  await processPatient(recent.patient.id, recent.at(44));
  assert.equal((await alertsFor(recent.dose.id)).length, 6);
});

test('inbox is private, read-idempotent, paginated, and respects revocation and helper dates', async () => {
  const { processPatient } = require('../../src/services/reminders');
  const f = await reminderFixture();
  await processPatient(f.patient.id, f.reference);
  assert.equal((await api('GET', '/api/notifications', undefined, null)).status, 401);
  const inbox = await api('GET', '/api/notifications');
  assert.equal(inbox.status, 200);
  assert.equal(inbox.body.delivery.push_configured, false);
  const alert = inbox.body.notifications.find(n => n.dose_id === f.dose.id);
  assert.ok(alert);
  assert.equal((await api('PATCH', `/api/notifications/${alert.id}/read`, {}, outsider.token)).status, 404);
  const first = await api('PATCH', `/api/notifications/${alert.id}/read`, {});
  const again = await api('PATCH', `/api/notifications/${alert.id}/read`, {});
  assert.equal(first.status, 200);
  assert.equal(first.body.notification.read_at, again.body.notification.read_at);
  assert.equal((await api('GET', '/api/notifications?before=invalid')).status, 400);
  assert.equal((await api('GET', '/api/notifications', undefined, viewer.token)).body.notifications.length, 0);
  assert.ok((await api('GET', '/api/notifications', undefined, helper.token)).body.notifications.some(n => n.dose_id === f.dose.id));
  const access = (await db.query('SELECT id FROM patient_access WHERE patient_id = $1 AND user_id = $2', [f.patient.id, helper.user.id])).rows[0];
  assert.equal((await api('DELETE', `/api/patients/${f.patient.id}/access/${access.id}`)).status, 200);
  assert.ok(!(await api('GET', '/api/notifications', undefined, helper.token)).body.notifications.some(n => n.dose_id === f.dose.id));
  assert.equal((await api('POST', `/api/patients/${f.patient.id}/doses/${f.dose.id}/snooze`, {}, helper.token)).status, 403);
  await db.query(`INSERT INTO patient_access (patient_id, user_id, role, status, accepted_at)
    VALUES ($1, $2, 'helper', 'accepted', now())`, [f.patient.id, helper.user.id]);
  assert.ok(!(await api('GET', '/api/notifications', undefined, helper.token)).body.notifications.some(n => n.dose_id === f.dose.id), 'A new membership must not reveal old alerts');
  // Seed enough alerts to cross a page boundary, including tied timestamps.
  await db.query(`INSERT INTO dose_events (schedule_id, patient_id, scheduled_for)
    SELECT $1, $2, $3::timestamptz + (n * interval '1 hour') FROM generate_series(1, 25) n
    ON CONFLICT DO NOTHING`, [f.rule.id, f.patient.id, f.reference.toISOString()]);
  for (let stage = 0; stage < 3; stage++) {
    await db.query(`INSERT INTO care_notifications (user_id, patient_id, dose_id, kind, stage)
      SELECT $1, de.patient_id, de.id, 'reminder', $3 FROM dose_events de WHERE de.patient_id = $2
      ON CONFLICT DO NOTHING`, [owner.user.id, f.patient.id, stage]);
  }
  const ids = new Set();
  let before;
  do {
    const page = await api('GET', '/api/notifications' + (before ? `?before=${before}` : ''));
    for (const row of page.body.notifications) { assert.ok(!ids.has(row.id)); ids.add(row.id); }
    before = page.body.next_before;
  } while (before);
  assert.ok(ids.size > 50);
});

test('snooze rejects future doses and viewers; stopped medicines produce no alerts', async () => {
  const { processPatient } = require('../../src/services/reminders');
  const f = await reminderFixture(10);
  const path = `/api/patients/${f.patient.id}/doses/${f.dose.id}/snooze`;
  assert.equal((await api('POST', path, {})).status, 409);
  assert.equal((await api('POST', path, {}, viewer.token)).status, 403);
  await api('PATCH', `/api/patients/${f.patient.id}/items/${f.item.id}`, { status: 'stopped' });
  await processPatient(f.patient.id, f.at(60));
  assert.equal((await alertsFor(f.dose.id)).length, 0);
});


test('worker reconciles daily, excludes pending invitations, and updates its heartbeat', async () => {
  const { processPatient, runReminderTick } = require('../../src/services/reminders');
  const f = await reminderFixture();
  await db.query(`INSERT INTO patient_access (patient_id, user_id, role, status, invited_by)
    VALUES ($1, $2, 'family_admin', 'pending', $3)`, [f.patient.id, outsider.user.id, owner.user.id]);
  await processPatient(f.patient.id, f.reference);
  assert.ok((await alertsFor(f.dose.id)).every(n => n.user_id !== outsider.user.id));
  const yesterday = new Date(f.reference.getTime() - 86400000).toISOString().slice(0, 10);
  await db.query('UPDATE prescription_items SET end_date = $2 WHERE id = $1', [f.item.id, yesterday]);
  // A new local calendar day triggers a fresh reconciliation; it does not
  // require a caregiver opening the app or editing a prescription.
  await processPatient(f.patient.id, f.at(24 * 60));
  await processPatient(f.patient.id, f.at(24 * 60));
  const findings = await db.query("SELECT id FROM conflicts WHERE patient_id = $1 AND kind = 'course_ended'", [f.patient.id]);
  assert.equal(findings.rows.length, 1);
  await runReminderTick();
  const status = (await api('GET', '/api/notifications')).body.delivery;
  assert.ok(status.last_completed_at);
});

test('helper inbox excludes previous local dates and confirmation wins against a worker race', async () => {
  const { processPatient } = require('../../src/services/reminders');
  const { actOnDose } = require('../../src/services/dose-actions');
  const f = await reminderFixture(-24 * 60);
  await processPatient(f.patient.id, f.reference);
  const inbox = await api('GET', '/api/notifications', undefined, helper.token);
  assert.ok(!inbox.body.notifications.some(n => n.dose_id === f.dose.id));
  await Promise.all([
    processPatient(f.patient.id, f.at(45)),
    actOnDose(f.patient.id, f.dose.id, owner.user.id, 'taken', f.at(45)),
  ]);
  assert.equal((await db.query('SELECT status FROM dose_events WHERE id = $1', [f.dose.id])).rows[0].status, 'taken');
  const count = (await alertsFor(f.dose.id)).length;
  await processPatient(f.patient.id, f.at(50));
  assert.equal((await alertsFor(f.dose.id)).length, count);
});
