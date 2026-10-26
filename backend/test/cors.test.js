const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cors } = require('../src/middleware/cors.middleware');

test('CORS configuration rejects wildcard and non-origin URLs', () => {
  for (const origins of ['*', 'null', 'https://example.com/path', 'file:///test', 'https://example.com/']) {
    assert.throws(() => cors({ origins }), /exact HTTP\(S\) origins/);
  }
});

test('production does not allow browser origins without explicit configuration', () => {
  let status;
  const res = { vary() {}, status(value) { status = value; return this; }, json() {} };
  cors({ production: true, origins: '' })({ get: () => 'http://localhost:5173' }, res, () => assert.fail('should reject'));
  assert.equal(status, 403);
});
