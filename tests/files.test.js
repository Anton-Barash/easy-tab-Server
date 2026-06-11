const { test } = require('node:test');
const assert = require('node:assert');
const buildApp = require('../src/app');

test('Health check route returns ok', async (t) => {
  const app = buildApp();

  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/health',
  });

  assert.strictEqual(response.statusCode, 200);
  const body = response.json();
  assert.strictEqual(body.status, 'ok');
  assert.ok(body.timestamp);
  assert.ok(body.uptime);
});

test('Files list returns empty array initially', async (t) => {
  const app = buildApp();

  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/files/list',
  });

  assert.strictEqual(response.statusCode, 200);
  const body = response.json();
  assert.ok(Array.isArray(body.files));
});

test('Upload requires a file', async (t) => {
  const app = buildApp();

  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/files/upload',
  });

  assert.strictEqual(response.statusCode, 400);
});

test('Download non-existent file returns 404', async (t) => {
  const app = buildApp();

  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/files/download/nonexistent.txt',
  });

  assert.strictEqual(response.statusCode, 404);
});
