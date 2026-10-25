const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
});

pool.on('error', (err) => {
    console.error('Unexpected database error', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
