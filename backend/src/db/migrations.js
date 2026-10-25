const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { inspectBaseline } = require('./schema-inspection');

const migrationDirectory = path.resolve(__dirname, '../../../database/migrations');
const manifestPath = path.resolve(__dirname, '../../../database/baseline.json');

function quoteSchema(schema) {
  if (typeof schema !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(schema) || schema.startsWith('pg_') || schema === 'information_schema') {
    throw new Error('Migration schema must be a non-system lowercase PostgreSQL identifier');
  }
  return `"${schema}"`;
}

async function loadMigrations(directory = migrationDirectory) {
  const filenames = (await fs.readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  if (!filenames.length) throw new Error('No migration files found');
  const migrations = [];
  for (const filename of filenames) {
    const match = /^(\d{3})_([a-z0-9_]+)\.sql$/.exec(filename);
    if (!match || Number(match[1]) !== migrations.length + 1) throw new Error(`Invalid or non-sequential migration: ${filename}`);
    const sql = await fs.readFile(path.join(directory, filename), 'utf8');
    // Normalize checkout line endings so Windows and Linux verify the same file.
    const normalized = sql.replace(/\r\n/g, '\n');
    migrations.push({ version: match[1], name: match[2], filename, sql: normalized,
      checksum: createHash('sha256').update(normalized).digest('hex') });
  }
  return migrations;
}

function validateHistory(migrations, rows) {
  rows.forEach((row, index) => {
    const expected = migrations[index];
    if (!expected || row.version !== expected.version || row.name !== expected.name || row.checksum !== expected.checksum) {
      throw new Error(`Migration history mismatch at ${row.version}; restore applied files and add a new migration instead of editing history`);
    }
  });
}

async function useSchema(client, schema) {
  const quoted = quoteSchema(schema);
  const exists = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
  if (!exists.rows.length) throw new Error(`Schema ${schema} does not exist`);
  await client.query(`SET LOCAL search_path TO ${quoted}`);
}

async function history(client) {
  const exists = await client.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS present");
  if (!exists.rows[0].present) return [];
  return (await client.query('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version')).rows;
}

async function migrationStatus(pool, { schema = 'public', directory } = {}) {
  const migrations = await loadMigrations(directory);
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await useSchema(client, schema);
    const rows = await history(client);
    validateHistory(migrations, rows);
    await client.query('COMMIT');
    return migrations.map((m, i) => ({ version: m.version, name: m.name, status: rows[i] ? 'applied' : 'pending' }));
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
    throw err;
  } finally { client.release(); }
}

async function migrate(pool, { schema = 'public', directory, baselinePath = manifestPath } = {}) {
  const migrations = await loadMigrations(directory);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await useSchema(client, schema);
    await client.query("SELECT pg_advisory_xact_lock(hashtext(current_database()), hashtext($1))", [`${schema}:medisync:migrations`]);
    const applied = await history(client);
    validateHistory(migrations, applied);
    let adopt = false;
    if (!applied.length) {
      const existing = await inspectBaseline(client, schema);
      if (existing.columns.length || existing.enums.length) {
        const expected = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
        if (!isDeepStrictEqual(existing, expected)) {
          throw new Error('Existing schema differs from the original MediSync baseline; no tables were changed. Review the schema before migration');
        }
        adopt = true;
      }
    }
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const changed = [];
    for (const migration of migrations.slice(applied.length)) {
      const adopted = adopt && migration.version === '001';
      if (!adopted) await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.name, migration.checksum]);
      changed.push({ version: migration.version, name: migration.name, action: adopted ? 'adopted' : 'applied' });
    }
    await client.query('COMMIT');
    return changed;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
    throw err;
  } finally { client.release(); }
}

module.exports = { migrate, migrationStatus, loadMigrations, quoteSchema };
