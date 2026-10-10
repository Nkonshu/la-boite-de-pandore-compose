// H3-008D1Q36N4A5D68T — relais public d'acceptation d'invitation : preuve que Compose ne transmet à Go
// QUE {token, password}, jamais dans l'URL, toujours dans le corps POST, sans jamais rien journaliser
// (ni le jeton, ni le mot de passe), via un backend Pandore SYNTHÉTIQUE intercepté (global.fetch), en
// démarrant le VRAI routeur Express sur un port éphémère — AUCUN réseau réel, AUCUN vrai jeton production.
//
// Usage : node test/accept-invitation-relay.test.js
'use strict';

const assert = require('assert');
const http = require('http');

process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.PANDORE_API_BASE = 'http://pandore-fake.test';
process.env.PANDORE_GO_INTERNAL_SECRET = 'test-go-internal-secret';
process.env.PANDORE_INTERNAL_SECRET = 'test-n8n-internal-secret';
delete process.env.META_APP_ID;
delete process.env.META_APP_SECRET;
delete process.env.META_REDIRECT_URI;

const BASE = 'http://pandore-fake.test';
const outbound = [];
const realFetch = global.fetch;
const SECRET_TOKEN = 'synthetic-invitation-token-should-never-leak';
const SECRET_PASSWORD = 'synthetic-password-should-never-leak';

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

global.fetch = async (url, opts = {}) => {
  const urlStr = String(url);
  if (urlStr.startsWith('http://127.0.0.1:')) return realFetch(url, opts);
  outbound.push({ url: urlStr, method: (opts.method || 'GET').toUpperCase(), headers: opts.headers || {}, body: opts.body });
  const u = new URL(urlStr);
  assert.strictEqual(u.pathname, '/auth/accept-invitation', 'le jeton ne doit JAMAIS apparaître dans le path/query upstream');
  assert.strictEqual(u.search, '', 'aucun paramètre de query string upstream (jamais ?token=...)');
  const sent = JSON.parse(opts.body);
  if (sent.token === 'tok-notfound') return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'invitation introuvable', request_id: 'r' } });
  if (sent.token === 'tok-expired') return jsonResponse(422, { error: { code: 'VALIDATION_FAILED', message: 'invitation: déjà acceptée ou expirée', request_id: 'r' } });
  if (sent.token === 'tok-shortpw') return jsonResponse(422, { error: { code: 'VALIDATION_FAILED', message: 'mot de passe trop court (8 caractères minimum)', request_id: 'r' } });
  if (sent.token === 'tok-conflict') return jsonResponse(409, { error: { code: 'EMAIL_ALREADY_HAS_ACCOUNT', message: 'cet email correspond déjà à un compte existant', request_id: 'r' } });
  if (sent.token === 'tok-down') throw new Error('connect ECONNREFUSED');
  return jsonResponse(201, { id: 'user-123', email: 'invitee@disposable.test', role: 'CLIENT_OWNER', tenant_id: 'tenant-123', active: true, created_at: '2026-01-01T00:00:00Z' });
};

const app = require('../src/server.js');

(async () => {
  const server = app.listen(0);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let passed = 0, failed = 0;
  async function test(name, fn) {
    try { outbound.length = 0; await fn(); console.log(`PASS - ${name}`); passed++; }
    catch (err) { console.log(`FAIL - ${name}\n  ${err.message}`); failed++; }
  }
  const call = (body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(base + '/api/auth/accept-invitation', {
      method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Connection: 'close' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, json: async () => JSON.parse(raw) });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

  try {
    await test('R1. public route, no admin password required (unlike /api/auth/login)', async () => {
      const res = await call({ token: 'tok-ok', password: 'a-real-password-1234' });
      assert.strictEqual(res.status, 201);
      const body = await res.json();
      assert.strictEqual(body.role, 'CLIENT_OWNER');
      assert.ok(!('password_hash' in body) && !('PasswordHash' in body));
    });

    await test('R2. relay forwards EXACTLY {token, password} in the body, never in the URL', async () => {
      await call({ token: SECRET_TOKEN, password: SECRET_PASSWORD });
      assert.strictEqual(outbound.length, 1);
      assert.strictEqual(outbound[0].url, `${BASE}/auth/accept-invitation`);
      assert.deepStrictEqual(JSON.parse(outbound[0].body), { token: SECRET_TOKEN, password: SECRET_PASSWORD });
      assert.ok(!outbound[0].url.includes(SECRET_TOKEN), 'le jeton ne doit jamais apparaître dans une URL');
    });

    await test('R3. relay never logs the token or the password (console.log/console.error)', async () => {
      const originalLog = console.log, originalError = console.error;
      const captured = [];
      console.log = (...args) => { captured.push(args.join(' ')); };
      console.error = (...args) => { captured.push(args.join(' ')); };
      try {
        await call({ token: SECRET_TOKEN, password: SECRET_PASSWORD });
      } finally {
        console.log = originalLog;
        console.error = originalError;
      }
      const all = captured.join('\n');
      assert.ok(!all.includes(SECRET_TOKEN), 'le jeton ne doit jamais être journalisé');
      assert.ok(!all.includes(SECRET_PASSWORD), 'le mot de passe ne doit jamais être journalisé');
    });

    await test('R4. 404 (unknown token) passes through unchanged, no secret added', async () => {
      const res = await call({ token: 'tok-notfound', password: 'a-real-password-1234' });
      assert.strictEqual(res.status, 404);
      assert.strictEqual((await res.json()).error.code, 'NOT_FOUND');
    });

    await test('R5. 422 expired/already-accepted and 422 short-password both pass through with distinct messages', async () => {
      const expired = await call({ token: 'tok-expired', password: 'a-real-password-1234' });
      assert.strictEqual(expired.status, 422);
      assert.ok((await expired.json()).error.message.includes('expirée'));
      const shortpw = await call({ token: 'tok-shortpw', password: 'short' });
      assert.strictEqual(shortpw.status, 422);
      assert.ok((await shortpw.json()).error.message.includes('mot de passe'));
    });

    await test('R6. 409 email-already-has-account passes through without a raw Postgres error', async () => {
      const res = await call({ token: 'tok-conflict', password: 'a-real-password-1234' });
      assert.strictEqual(res.status, 409);
      const text = JSON.stringify(await res.json());
      assert.ok(!text.toLowerCase().includes('duplicate key') && !text.toLowerCase().includes('constraint'));
    });

    await test('R7. Go unreachable -> 502 with a fixed generic message (no stack, no token)', async () => {
      const res = await call({ token: 'tok-down', password: 'a-real-password-1234' });
      assert.strictEqual(res.status, 502);
      const text = JSON.stringify(await res.json());
      assert.ok(!text.includes('tok-down') && !text.includes('ECONNREFUSED'));
    });

    await test('R8. missing token or password is rejected locally (400), never forwarded to Go', async () => {
      const res = await call({ password: 'a-real-password-1234' });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(outbound.length, 0);
    });
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
