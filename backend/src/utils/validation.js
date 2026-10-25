const { badRequest } = require('./errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value, name, { required = false, max = 500 } = {}) {
  if (value === undefined || value === null) {
    if (required) badRequest(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string') badRequest(`${name} must be text`);
  const result = value.trim();
  if (!result) {
    if (required) badRequest(`${name} is required`);
    return null;
  }
  if (result.length > max) badRequest(`${name} must be at most ${max} characters`);
  return result;
}

function email(value) {
  const result = text(value, 'email', { required: true, max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) badRequest('email must be valid');
  return result;
}

function password(value, { signup = false } = {}) {
  if (typeof value !== 'string' || !value) badRequest('password is required');
  // bcrypt only uses the first 72 bytes. Reject rather than silently truncate.
  if (Buffer.byteLength(value, 'utf8') > 72) badRequest('password must be at most 72 UTF-8 bytes');
  if (signup && value.length < 8) badRequest('password must be at least 8 characters');
  return value;
}

function uuid(value, name, { required = true } = {}) {
  if (!required && (value === undefined || value === null)) return null;
  if (typeof value !== 'string' || !UUID.test(value)) badRequest(`${name} must be a UUID`);
  return value;
}

function date(value, name, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) badRequest(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '9999-12-31') {
    badRequest(`${name} must be a date in YYYY-MM-DD format (1900-9999)`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) badRequest(`${name} is not a valid calendar date`);
  return value;
}

function dateRange(start, end) {
  if (start && end && end < start) badRequest('end_date must be on or after start_date');
}

function timezone(value = 'Asia/Kolkata') {
  const result = text(value, 'timezone', { required: true, max: 100 });
  if (result !== 'UTC' && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+$/.test(result)) badRequest('timezone must be an IANA timezone');
  try { new Intl.DateTimeFormat('en', { timeZone: result }); }
  catch { badRequest('timezone must be a valid IANA timezone'); }
  return result;
}

function time(value) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) {
    badRequest('time_of_day must be HH:MM or HH:MM:SS in 24-hour time');
  }
  return value;
}

function weekdays(value = []) {
  if (!Array.isArray(value) || value.length > 7 || value.some(d => !Number.isInteger(d) || d < 0 || d > 6) || new Set(value).size !== value.length) {
    badRequest('days_of_week must contain unique integers from 0 (Sunday) to 6 (Saturday)');
  }
  return value;
}

function integer(value, name, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) badRequest(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

function registerIds(router, names) {
  for (const name of names) router.param(name, (req, res, next, value) => {
    try { uuid(value, name); next(); } catch (err) { next(err); }
  });
}

module.exports = { text, email, password, uuid, date, dateRange, timezone, time, weekdays, integer, registerIds };
