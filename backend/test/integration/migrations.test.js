const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { migrate, migrationStatus } = require('../../src/db/migrations');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error('Configure TEST_DATABASE_URL or a local DATABASE_URL for migration tests');
if (!process.env.TEST_DATABASE_URL && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
  throw new Error('Remote databases require an explicit TEST_DATABASE_URL');
}
const directory = path.resolve(__dirname, '../../../database/migrations');
const tables = ['users', 'patients', 'patient_access', 'audit_log', 'prescribers', 'prescriptions', 'prescription_items', 'schedules', 'dose_events', 'conflicts'];

async function isolated(work) {
  const schema = `medisync_test_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000, options: `-c search_path=${schema}` });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await work(pool, schema);
  } finally {
    assert.match(schema, /^medisync_test_[a-f0-9]{32}$/);
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}

async function migrationFiles(work) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'medisync-migrations-'));
  try {
    for (const filename of await fs.readdir(directory)) await fs.copyFile(path.join(directory, filename), path.join(temporary, filename));
    await work(temporary);
  } finally {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('medisync-migrations-'));
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function legacy(pool) { await pool.query(await fs.readFile(path.join(directory, '001_initial.sql'), 'utf8')); }

async function seed(pool) {
  const user = (await pool.query("INSERT INTO users (email, password_hash, name) VALUES ('fixture@example.com', 'synthetic-test-hash', 'Fixture') RETURNING id")).rows[0].id;
  const patients = [];
  const doctors = [];
  const prescriptions = [];
  const items = [];
  for (let i = 0; i < 2; i++) {
    patients.push((await pool.query('INSERT INTO patients (full_name, created_by) VALUES ($1, $2) RETURNING id', [`Fixture patient ${i}`, user])).rows[0].id);
    await pool.query("INSERT INTO patient_access (patient_id, user_id, role, status, accepted_at) VALUES ($1, $2, 'owner', 'accepted', now())", [patients[i], user]);
    doctors.push((await pool.query("INSERT INTO prescribers (patient_id, name) VALUES ($1, 'Fixture doctor') RETURNING id", [patients[i]])).rows[0].id);
    prescriptions.push((await pool.query('INSERT INTO prescriptions (patient_id, prescriber_id, visit_date, created_by) VALUES ($1, $2, CURRENT_DATE, $3) RETURNING id', [patients[i], doctors[i], user])).rows[0].id);
    items.push((await pool.query("INSERT INTO prescription_items (prescription_id, patient_id, raw_text) VALUES ($1, $2, 'Fixture medicine') RETURNING id", [prescriptions[i], patients[i]])).rows[0].id);
  }
  const schedule = (await pool.query("INSERT INTO schedules (prescription_item_id, patient_id, time_of_day) VALUES ($1, $2, '08:00') RETURNING id", [items[0], patients[0]])).rows[0].id;
  const dose = (await pool.query('INSERT INTO dose_events (schedule_id, patient_id, scheduled_for) VALUES ($1, $2, now()) RETURNING id', [schedule, patients[0]])).rows[0].id;
  const conflict = (await pool.query("INSERT INTO conflicts (patient_id, level, kind, description, item_a_id) VALUES ($1, 1, 'course_ended', 'Synthetic fixture', $2) RETURNING id", [patients[0], items[0]])).rows[0].id;
  await pool.query("INSERT INTO audit_log (patient_id, actor_user_id, action) VALUES ($1, $2, 'fixture.seed')", [patients[0], user]);
  return { user, patients, doctors, prescriptions, items, schedule, dose, conflict };
}

async function snapshot(pool) {
  const result = {};
  for (const table of tables) result[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`)).rows;
  return result;
}

test('migrations initialize a fresh schema and repeated application is a no-op', async () => isolated(async (pool, schema) => {
  assert.deepEqual((await migrationStatus(pool, { schema })).map(m => m.status), ['pending', 'pending', 'pending']);
  const changed = await migrate(pool, { schema });
  assert.deepEqual(changed.map(m => m.action), ['applied', 'applied', 'applied']);
  assert.deepEqual(await migrate(pool, { schema }), []);
  assert.deepEqual((await migrationStatus(pool, { schema })).map(m => m.status), ['applied', 'applied', 'applied']);
  const names = (await pool.query('SELECT table_name FROM information_schema.tables WHERE table_schema = $1', [schema])).rows.map(t => t.table_name);
  assert.deepEqual(names.sort(), [...tables, 'schema_migrations', 'dose_reminder_state', 'care_notifications', 'patient_worker_state', 'reminder_worker_status'].sort());
}));

test('legacy adoption preserves every row in all ten original tables', async () => isolated(async (pool, schema) => {
  await legacy(pool);
  await seed(pool);
  const before = await snapshot(pool);
  const changed = await migrate(pool, { schema });
  assert.deepEqual(changed.map(m => m.action), ['adopted', 'applied', 'applied']);
  assert.deepEqual(await snapshot(pool), before);
}));

test('partial and altered legacy schemas are rejected without creating migration history', async t => {
  for (const variant of ['partial', 'altered']) await t.test(variant, async () => isolated(async (pool, schema) => {
    if (variant === 'partial') await pool.query('CREATE TABLE users (id UUID PRIMARY KEY)');
    else {
      await legacy(pool);
      await pool.query('ALTER TABLE patients ADD COLUMN legacy_note TEXT');
    }
    await assert.rejects(migrate(pool, { schema }), /differs from the original MediSync baseline/);
    assert.equal((await pool.query("SELECT to_regclass('schema_migrations') AS ledger")).rows[0].ledger, null);
  }));
});

test('invalid legacy records roll back the full upgrade; fixing the record allows a retry', async () => isolated(async (pool, schema) => {
  await legacy(pool);
  const fixture = await seed(pool);
  await pool.query('UPDATE prescription_items SET end_date = start_date - 1 WHERE id = $1', [fixture.items[0]]);
  const before = await snapshot(pool);
  await assert.rejects(migrate(pool, { schema }), err => err.code === '23514' && err.constraint === 'items_valid_dates');
  assert.deepEqual(await snapshot(pool), before);
  assert.equal((await pool.query("SELECT to_regclass('schema_migrations') AS ledger")).rows[0].ledger, null);
  await pool.query('UPDATE prescription_items SET end_date = NULL WHERE id = $1', [fixture.items[0]]);
  assert.equal((await migrate(pool, { schema })).length, 3);
}));

test('concurrent migration runners apply each migration exactly once', async () => isolated(async (pool, schema) => {
  const results = await Promise.all(Array.from({ length: 3 }, () => migrate(pool, { schema })));
  assert.equal(results.flat().length, 3);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM schema_migrations')).rows[0].n, 3);
}));

test('checksums tolerate Windows line endings and reject edits to applied files', async () => isolated(async (pool, schema) => {
  await migrate(pool, { schema });
  await migrationFiles(async temporary => {
    const initial = path.join(temporary, '001_initial.sql');
    const sql = await fs.readFile(initial, 'utf8');
    await fs.writeFile(initial, sql.replace(/\r?\n/g, '\r\n'));
    assert.deepEqual(await migrate(pool, { schema, directory: temporary }), []);
    await fs.appendFile(initial, '\n-- changed history\n');
    await assert.rejects(migrate(pool, { schema, directory: temporary }), /Migration history mismatch/);
    await assert.rejects(migrationStatus(pool, { schema, directory: temporary }), /Migration history mismatch/);
  });
}));

test('a failed pending migration rolls back its DDL and leaves the applied ledger intact', async () => isolated(async (pool, schema) => {
  await migrate(pool, { schema });
  await migrationFiles(async temporary => {
    await fs.writeFile(path.join(temporary, '004_failure.sql'), 'CREATE TABLE should_rollback (id INTEGER); SELECT 1 / 0;');
    await assert.rejects(migrate(pool, { schema, directory: temporary }), err => err.code === '22012');
    assert.equal((await pool.query("SELECT to_regclass('should_rollback') AS relation")).rows[0].relation, null);
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM schema_migrations')).rows[0].n, 3);
  });
}));

test('unknown migration history is rejected instead of silently skipping upgrades', async () => isolated(async (pool, schema) => {
  await migrate(pool, { schema });
  await pool.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ('999', 'unknown', 'synthetic')");
  await assert.rejects(migrate(pool, { schema }), /Migration history mismatch at 999/);
}));

test('composite foreign keys reject cross-patient links even when SQL bypasses the API', async () => isolated(async (pool, schema) => {
  await migrate(pool, { schema });
  const f = await seed(pool);
  const attempts = [
    ['UPDATE prescriptions SET prescriber_id = $1 WHERE id = $2', [f.doctors[1], f.prescriptions[0]]],
    ['UPDATE prescription_items SET prescription_id = $1 WHERE id = $2', [f.prescriptions[1], f.items[0]]],
    ['UPDATE prescription_items SET replaces_item_id = $1 WHERE id = $2', [f.items[1], f.items[0]]],
    ['UPDATE schedules SET prescription_item_id = $1 WHERE id = $2', [f.items[1], f.schedule]],
    ['UPDATE dose_events SET patient_id = $1 WHERE id = $2', [f.patients[1], f.dose]],
    ['UPDATE conflicts SET item_a_id = $1 WHERE id = $2', [f.items[1], f.conflict]],
  ];
  for (const [sql, params] of attempts) await assert.rejects(pool.query(sql, params), err => err.code === '23503');
}));

test('database constraints reject invalid dates, weekdays, confirmation state, owners and duplicate findings', async () => isolated(async (pool, schema) => {
  await migrate(pool, { schema });
  const f = await seed(pool);
  for (const sql of [
    'UPDATE prescription_items SET end_date = start_date - 1',
    'UPDATE schedules SET days_of_week = ARRAY[7]::smallint[]',
    "UPDATE schedules SET time_of_day = TIME '24:00'",
    "UPDATE dose_events SET status = 'taken'",
    "UPDATE patients SET full_name = ' '",
  ]) await assert.rejects(pool.query(sql), err => err.code === '23514');
  const otherUser = (await pool.query("INSERT INTO users (email, password_hash) VALUES ('other@example.com', 'synthetic') RETURNING id")).rows[0].id;
  await assert.rejects(pool.query("INSERT INTO patient_access (patient_id, user_id, role, status) VALUES ($1, $2, 'owner', 'accepted')", [f.patients[0], otherUser]), err => err.code === '23505');
  const otherItem = (await pool.query("INSERT INTO prescription_items (prescription_id, patient_id, raw_text) VALUES ($1, $2, 'Other medicine') RETURNING id", [f.prescriptions[0], f.patients[0]])).rows[0].id;
  const params = [f.patients[0], f.items[0], otherItem];
  await pool.query("INSERT INTO conflicts (patient_id, level, kind, description, item_a_id, item_b_id) VALUES ($1, 1, 'duplicate_medicine', 'Synthetic', $2, $3)", params);
  await assert.rejects(pool.query("INSERT INTO conflicts (patient_id, level, kind, description, item_a_id, item_b_id) VALUES ($1, 1, 'duplicate_medicine', 'Reversed pair', $3, $2)", params), err => err.code === '23505');
}));

test('integrity upgrades preserve existing set-null and cascade deletion behavior', async () => isolated(async (pool, schema) => {
  await migrate(pool, { schema });
  const f = await seed(pool);
  await pool.query('DELETE FROM prescribers WHERE id = $1', [f.doctors[0]]);
  assert.equal((await pool.query('SELECT prescriber_id FROM prescriptions WHERE id = $1', [f.prescriptions[0]])).rows[0].prescriber_id, null);
  await pool.query('DELETE FROM prescription_items WHERE id = $1', [f.items[0]]);
  for (const table of ['schedules', 'dose_events', 'conflicts']) {
    assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${table} WHERE patient_id = $1`, [f.patients[0]])).rows[0].n, 0);
  }
  await pool.query('DELETE FROM patients WHERE id = $1', [f.patients[1]]);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM prescriptions WHERE id = $1', [f.prescriptions[1]])).rows[0].n, 0);
}));
