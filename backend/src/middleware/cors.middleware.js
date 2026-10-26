function cors({ origins = process.env.ALLOWED_ORIGINS,
  production = process.env.NODE_ENV === 'production' } = {}) {
  const configured = origins === undefined
    ? (production ? [] : ['http://localhost:5173', 'http://127.0.0.1:5173'])
    : origins.split(',').map(value => value.trim()).filter(Boolean);
  for (const origin of configured) {
    let url;
    try { url = new URL(origin); } catch { throw new Error('ALLOWED_ORIGINS must contain exact HTTP(S) origins'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new Error('ALLOWED_ORIGINS must contain exact HTTP(S) origins');
    }
  }
  const allowed = new Set(configured);
  return (req, res, next) => {
    const origin = req.get('Origin');
    if (origin) {
      res.vary('Origin');
      if (!allowed.has(origin)) return res.status(403).json({ error: 'This browser origin is not allowed' });
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
      res.set('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
}

module.exports = { cors };
