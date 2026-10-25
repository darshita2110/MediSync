require('dotenv').config({ path: require('node:path').resolve(__dirname, '../.env'), quiet: true });
const { Pool } = require('pg');
const { migrate, migrationStatus } = require('../src/db/migrations');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be configured');
  const command = process.argv[2];
  if (!['migrate', 'status'].includes(command)) throw new Error('Usage: node scripts/database.js migrate|status');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    const options = { schema: process.env.DATABASE_SCHEMA || 'public' };
    const result = command === 'migrate' ? await migrate(pool, options) : await migrationStatus(pool, options);
    if (!result.length) console.log('Database is up to date.');
    for (const row of result) console.log(`${row.version} ${row.name}: ${row.action || row.status}`);
  } finally { await pool.end(); }
}

main().catch(err => { console.error(`Database command failed: ${err.message}`); process.exitCode = 1; });
