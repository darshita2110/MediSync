const express = require('express');
const db = require('./config/db');
const { cors } = require('./middleware/cors.middleware');

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Request body must be a JSON object' });
  }
  next();
});

app.get('/', (req, res) => res.send('MediSync API is alive'));
app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'medisync' }));
app.get('/api/health/db', async (req, res) => {
  await db.query('SELECT 1');
  res.json({ status: 'ok' });
});

app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/patients', require('./routes/patients.routes'));
app.use('/api', require('./routes/access.routes'));
app.use('/api', require('./routes/prescriptions.routes'));
app.use('/api', require('./routes/conflicts.routes'));
app.use('/api', require('./routes/schedules.routes'));
app.use('/api/notifications', require('./routes/notifications.routes'));

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large' });
  if (err.status && err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error('Request failed:', err.code || err.name);
  return res.status(500).json({ error: 'Something went wrong' });
});

module.exports = app;
