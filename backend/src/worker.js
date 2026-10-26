require('dotenv').config({ quiet: true });
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be configured');
const db = require('./config/db');
const { runReminderTick } = require('./services/reminders');
const interval = Number(process.env.REMINDER_INTERVAL_MS || 30000);
if (!Number.isInteger(interval) || interval < 1000 || interval > 60000) {
  throw new Error('REMINDER_INTERVAL_MS must be between 1000 and 60000');
}
let stopping = false, timer;
async function tick() {
  timer = null;
  try { await runReminderTick(); }
  catch (error) { console.error('Reminder tick failed:', error.code || error.name); }
  finally {
    if (stopping) await db.pool.end();
    else timer = setTimeout(tick, interval);
  }
}
function stop() {
  stopping = true;
  if (timer) { clearTimeout(timer); db.pool.end().catch(() => { process.exitCode = 1; }); }
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
console.log('MediSync reminder worker started (in-app inbox delivery)');
tick();
