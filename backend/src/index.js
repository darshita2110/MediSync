require('dotenv').config({ quiet: true });

if (!process.env.DATABASE_URL || !process.env.JWT_SECRET) {
  throw new Error('DATABASE_URL and JWT_SECRET must be configured');
}
if (process.env.NODE_ENV === 'production' && process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must contain at least 32 characters in production');
}

const app = require('./app');
const db = require('./config/db');
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');

const server = app.listen(port, () => console.log(`MediSync API listening on port ${port}`));
function shutdown() {
  const timeout = setTimeout(() => process.exit(1), 10000);
  timeout.unref();
  server.close(async () => {
    await db.pool.end();
    clearTimeout(timeout);
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
