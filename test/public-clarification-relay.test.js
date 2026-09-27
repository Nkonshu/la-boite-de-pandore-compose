// H3-008D1Q36N4A5D58F1 — relais public de clarification : preuve que Compose transmet TELS QUELS
// (1) le DTO Go public (avec allowed_states) et ses statuts (410/404/422...), (2) les réponses
// structurées {question_ref, state, text?} sans rien ajouter ni perdre, via un backend Pandore
// SYNTHÉTIQUE intercepté (global.fetch), en démarrant le VRAI routeur Express sur un port éphémère —
// AUCUN réseau réel, AUCUN vrai jeton.
//
// Usage : node test/public-clarification-relay.test.js
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

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// DTO Go public réel (publicClarificationView) : allowed_states par question.
const GO_VIEW = {
  status: 'PENDING',
  expires_at: '2099-01-01T00:00:00Z',
  questions: [
    { ref: 'K1', prompt: 'Question de connaissance ?', allowed_states: ['ANSWERED_WITH_VALUE', 'UNKNOWN'] },
    { ref: 'N1', prompt: 'Question ordinaire ?', allowed_states: ['ANSWERED_WITH_VALUE'] },
  ],
};

global.fetch = async (url, opts = {}) => {
  const urlStr = String(url);
  if (urlStr.startsWith('http://127.0.0.1:')) return realFetch(url, opts);
  outbound.push({ url: urlStr, method: (opts.method || 'GET').toUpperCase(), headers: opts.headers || {}, body: opts.body });
  const u = new URL(urlStr);
  const m = u.pathname.match(/^\/public\/clarifications\/([^/]+)(\/response)?$/);
  if (!m) throw new Error('appel Go inattendu: ' + u.pathname);
  const token = decodeURIComponent(m[1]);
  if (token === 'tok-down') throw new Error('connect ECONNREFUSED');
  if (token === 'tok-gone') return jsonResponse(410, { error: { code: 'GONE', message: "Ce lien n'est plus valide.", request_id: 'r' } });
  if (token === 'tok-unknown') return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'lien invalide', request_id: 'r' } });
  if (token === 'tok-422') return jsonResponse(422, { error: { code: 'VALIDATION_FAILED', message: 'état requis', request_id: 'r' } });
  if (token === 'tok-notpending') return jsonResponse(422, { error: { code: 'REQUEST_NOT_PENDING', message: 'déjà répondue', request_id: 'r' } });
  if (m[2]) return jsonResponse(200, { status: 'réponse enregistrée' });
  return jsonResponse(200, GO_VIEW);
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
  // Client HTTP local via le module http (agent:false, Connection: close) : aucun socket keep-alive
  // résiduel à la fin du process (le fetch global laisse une assertion libuv intermittente sous Windows).
  const call = (method, pathname, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(base + pathname, {
      method, agent: false,
      headers: Object.assign({ Connection: 'close' }, payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, text: async () => raw, json: async () => JSON.parse(raw) });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  const post = (token, body) => call('POST', `/api/public/clarifications/${token}/response`, body);
  const get = (token) => call('GET', `/api/public/clarifications/${token}`);

  try {
    await test('R1. GET relays the Go DTO unchanged (allowed_states preserved) — public, no admin password, no secret forwarded', async () => {
      const res = await get('tok-1');
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(await res.json(), GO_VIEW);
      assert.strictEqual(outbound.length, 1);
      assert.strictEqual(outbound[0].url, `${BASE}/public/clarifications/tok-1`);
      assert.deepStrictEqual(outbound[0].headers, {}, 'aucun en-tête (ni admin, ni secret, ni Authorization) vers Go');
    });

    await test('R2. GET status codes pass through unchanged: 410 stays 410, 404 stays 404 (never merged)', async () => {
      const gone = await get('tok-gone');
      assert.strictEqual(gone.status, 410);
      assert.strictEqual((await gone.json()).error.code, 'GONE');
      const unknown = await get('tok-unknown');
      assert.strictEqual(unknown.status, 404);
      await unknown.text();
    });

    await test('R3. POST value answer: the structured entry reaches Go EXACTLY (state + text), nothing added', async () => {
      const answers = [{ question_ref: 'K1', state: 'ANSWERED_WITH_VALUE', text: 'https://example.test/app' }, { question_ref: 'N1', state: 'ANSWERED_WITH_VALUE', text: 'x' }];
      const res = await post('tok-1', { answers, tenant_id: 'forged', actor: 'forged' });
      assert.strictEqual(res.status, 200);
      await res.text();
      assert.strictEqual(outbound.length, 1);
      assert.strictEqual(outbound[0].method, 'POST');
      assert.strictEqual(outbound[0].url, `${BASE}/public/clarifications/tok-1/response`);
      assert.deepStrictEqual(JSON.parse(outbound[0].body), { answers }, 'seul `answers` est relayé : aucun champ forgé');
    });

    await test('R4. POST UNKNOWN answer: {question_ref, state: UNKNOWN} reaches Go with NO text key', async () => {
      const answers = [{ question_ref: 'K1', state: 'UNKNOWN' }];
      const res = await post('tok-1', { answers });
      assert.strictEqual(res.status, 200);
      await res.text();
      const sent = JSON.parse(outbound[0].body);
      assert.deepStrictEqual(sent, { answers });
      assert.ok(!('text' in sent.answers[0]));
    });

    await test('R5. POST: Go 422 (validation / not pending) and 410 pass through with their status and code', async () => {
      const v = await post('tok-422', { answers: [{ question_ref: 'K1', text: 'x' }] });
      assert.strictEqual(v.status, 422);
      assert.strictEqual((await v.json()).error.code, 'VALIDATION_FAILED');
      const n = await post('tok-notpending', { answers: [{ question_ref: 'K1', state: 'UNKNOWN' }] });
      assert.strictEqual(n.status, 422);
      assert.strictEqual((await n.json()).error.code, 'REQUEST_NOT_PENDING');
      const g = await post('tok-gone', { answers: [] });
      assert.strictEqual(g.status, 410);
      await g.text();
    });

    await test('R6. Go unreachable -> 502 with a fixed generic message (no stack, no token, no internal detail)', async () => {
      const g = await get('tok-down');
      assert.strictEqual(g.status, 502);
      await g.text();
      const p = await post('tok-down', { answers: [] });
      assert.strictEqual(p.status, 502);
      const text = JSON.stringify(await p.json());
      assert.ok(!text.includes('tok-down') && !text.includes('ECONNREFUSED'));
    });

    await test('R7. POST without answers relays an empty list (Go decides); token is URL-encoded in the Go path', async () => {
      const res = await post('tok%2F1', {});
      assert.strictEqual(res.status, 200);
      await res.text();
      assert.deepStrictEqual(JSON.parse(outbound[0].body), { answers: [] });
      assert.strictEqual(outbound[0].url, `${BASE}/public/clarifications/tok%2F1/response`);
    });
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
