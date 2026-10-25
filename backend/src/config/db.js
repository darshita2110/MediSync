const { Pool } = require('pg');
const { quoteSchema } = require('../db/migrations');

const schema = process.env.DATABASE_SCHEMA;
if (schema) quoteSchema(schema);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
  ...(schema ? { options: `-c search_path=${schema}` } : {}),
});

pool.on('error', (err) => {
    console.error('Unexpected database error', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
