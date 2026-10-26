// Isolated API for Flutter smoke tests and local visual QA. Never used by start.
require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../.env'), quiet: true });
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const express = require('express');
const { migrate } = require('../../src/db/migrations');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!url || (!process.env.TEST_DATABASE_URL && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))) {
  throw new Error('Use TEST_DATABASE_URL or a local DATABASE_URL for the isolated client server');
}
const schema = `medisync_test_${randomUUID().replaceAll('-', '')}`;
process.env.DATABASE_URL = url;
process.env.DATABASE_SCHEMA = schema;
process.env.JWT_SECRET = 'medisync-client-integration-synthetic-secret';
process.env.ALLOWED_ORIGINS = 'http://localhost:5173,http://127.0.0.1:5173';
const admin = new Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
let server, db, stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  if (server) {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
  if (db) await db.pool.end();
  if (!/^medisync_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected cleanup schema');
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
  console.log('Isolated client server stopped and its test schema removed.');
}

(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  db = require('../../src/config/db');
  await migrate(db.pool, { schema });
  const wrapper = express();
  wrapper.get('/api/__test_scope', (req, res) => res.json({ isolated: true, scope: schema }));
  wrapper.post('/api/__test_scope/tick', express.json(), async (req, res) => {
    if (req.body?.scope !== schema) return res.status(403).json({ error: 'Incorrect test scope' });
    const reference = req.body.reference ? new Date(req.body.reference) : new Date();
    if (!Number.isFinite(reference.getTime())) return res.status(400).json({ error: 'Invalid test instant' });
    await require('../../src/services/reminders').runReminderTick(reference);
    res.json({ completed: true });
  });
  wrapper.post('/api/__test_scope/close', express.json(), (req, res) => {
    if (req.body?.scope !== schema) return res.status(403).json({ error: 'Incorrect test scope' });
    res.json({ stopping: true });
    setImmediate(() => stop().catch(err => { console.error(err.message); process.exitCode = 1; }));
  });
  wrapper.use(require('../../src/app'));
  server = wrapper.listen(31328, '127.0.0.1', () => console.log('Isolated client API ready: http://127.0.0.1:31328'));
  server.on('error', err => { console.error(err.message); process.exitCode = 1; stop().catch(cleanupError => console.error(cleanupError.message)); });
  process.once('SIGINT', () => { stop().catch(err => { console.error(err.message); process.exitCode = 1; }); });
  process.once('SIGTERM', () => { stop().catch(err => { console.error(err.message); process.exitCode = 1; }); });
})().catch(async err => { console.error(err.message); process.exitCode = 1; await stop(); });
