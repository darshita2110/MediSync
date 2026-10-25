const db = require('../config/db');

async function transaction(work) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the original error. */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { transaction };
