const { test } = require('node:test');
const assert = require('node:assert/strict');
const { quoteSchema, loadMigrations } = require('../src/db/migrations');

test('migration targets reject system schemas and SQL fragments', () => {
  assert.equal(quoteSchema('public'), '"public"');
  for (const schema of ['pg_catalog', 'information_schema', 'public; DROP SCHEMA public', 'A', '', null]) {
    assert.throws(() => quoteSchema(schema), /non-system lowercase/);
  }
});

test('migration files are ordered, immutable inputs with complete SHA-256 checksums', async () => {
  const migrations = await loadMigrations();
  assert.deepEqual(migrations.map(m => m.version), ['001', '002']);
  assert.ok(migrations.every(m => /^[a-f0-9]{64}$/.test(m.checksum)));
  assert.ok(migrations.every(m => !/DROP TABLE/i.test(m.sql)));
});
