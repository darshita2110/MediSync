const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
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
process.env.JWT_SECRET = 'medisync-integration-tests-only-secret';
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
  assert.equal(current.rows[0].schema, schema, 'Schema isolation must be verified before applying the legacy schema');
  await db.query(await readFile(path.resolve(__dirname, '../../../database/schema.sql'), 'utf8'));
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
