// H3-008D1Q36N4A-5D32 — Knowledge Acquisition Candidates : preuve du relais THIN
// vers GET /admin/tenants/{id}/knowledge-acquisition-candidates (Go D30) et
// POST .../{candidate_id}/authorize|reject (Go D28), via un backend Pandore
// SYNTHÉTIQUE intercepté (global.fetch), en démarrant le VRAI routeur Express
// sur un port éphémère — AUCUN réseau réel. Même discipline que
// test/domain-applicability-relay.test.js.
//
// Usage : node test/knowledge-candidates-relay.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.PANDORE_API_BASE = 'http://pandore-fake.test';
process.env.PANDORE_GO_INTERNAL_SECRET = 'test-go-internal-secret';
process.env.PANDORE_INTERNAL_SECRET = 'test-n8n-internal-secret';
delete process.env.META_APP_ID;
delete process.env.META_APP_SECRET;
delete process.env.META_REDIRECT_URI;

const outboundCalls = [];
const AUTH_MARKER = 'test-bearer-CANDIDATES-EXACT-PASSTHROUGH-PROOF';
const BASE = 'http://pandore-fake.test';

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Statuts d'erreur que le faux Go renvoie selon le tenant t_status_<code>.
const ERROR_BODIES = {
  400: { error: { code: 'VALIDATION_FAILED', message: 'bad', request_id: 'req_x' } },
  401: { error: { code: 'UNAUTHORIZED', message: 'session invalide', request_id: 'req_x' } },
  403: { error: { code: 'FORBIDDEN', message: 'permission manquante', request_id: 'req_x' } },
  404: { error: { code: 'NOT_FOUND', message: 'candidat introuvable', request_id: 'req_x' } },
  409: { error: { code: 'KNOWLEDGE_ACQUISITION_CANDIDATE_ALREADY_DECIDED', message: 'déjà décidé', request_id: 'req_x' } },
  422: { error: { code: 'NO_VERIFIED_EMAIL_CONTACT', message: 'aucun contact', request_id: 'req_x' } },
  500: { error: { code: 'INTERNAL_ERROR', message: 'erreur interne', request_id: 'req_x' } },
};

const realFetch = global.fetch;
const LOCALHOST_PREFIX = 'http://127.0.0.1:';
global.fetch = async (url, opts = {}) => {
  const urlStr = String(url);
  if (urlStr.startsWith(LOCALHOST_PREFIX)) return realFetch(url, opts);
  outboundCalls.push({ url: urlStr, method: (opts.method || 'GET').toUpperCase(), headers: opts.headers || {}, body: opts.body, hasBodyKey: 'body' in opts });
  if (!urlStr.startsWith(process.env.PANDORE_API_BASE)) throw new Error('cible fetch inattendue dans ce test: ' + urlStr);
  const u = new URL(urlStr);
  const m = u.pathname.match(/^\/admin\/tenants\/([^/]+)\/knowledge-acquisition-candidates(?:\/([^/]+)\/(authorize|reject))?$/);
  if (!m) throw new Error('appel Go inattendu dans ce test: ' + u.pathname);
  const tenant = decodeURIComponent(m[1]);
  const method = (opts.method || 'GET').toUpperCase();
  if (tenant === 't_down') throw new Error('connect ECONNREFUSED http://pandore-fake.test:4000 at TCPConnectWrap.afterConnect (net.js:1)');
  const errMatch = tenant.match(/^t_status_(\d+)$/);
  if (errMatch) return jsonResponse(Number(errMatch[1]), ERROR_BODIES[Number(errMatch[1])]);
  if (m[2] === undefined) {
    if (method !== 'GET') throw new Error('GET attendu pour la file');
    return jsonResponse(200, [
      { candidate_id: 'c1', tenant_id: tenant, status: u.searchParams.get('status') || 'PENDING_REVIEW', requirement_key: 'KEY_A' },
    ]);
  }
  if (method !== 'POST') throw new Error('POST attendu pour une décision');
  return jsonResponse(200, {
    tenant_id: tenant, candidate_id: decodeURIComponent(m[2]), status: m[3] === 'authorize' ? 'CLOSED' : 'REJECTED',
    decision: m[3] === 'authorize' ? 'AUTHORIZED' : 'REJECTED', decision_result: 'DECIDED',
    outcome: m[3] === 'authorize' ? 'ACQUISITION_CREATED' : null, authorized_channel: m[3] === 'authorize' ? 'EMAIL' : null,
    resulting_clarification_request_id: m[3] === 'authorize' ? 'req-1' : null,
    decided_at: '2026-09-26T10:00:00Z', decided_by_user_id: 'u1', decided_by_role: 'PANDORE_OPERATOR',
  });
};

const app = require('../src/server.js');

async function main() {
  const server = app.listen(0);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const adminHeaders = { 'x-admin-password': process.env.ADMIN_PASSWORD };
  const bearerHeaders = { ...adminHeaders, Authorization: `Bearer ${AUTH_MARKER}` };
  const LIST = (tenant) => `${base}/api/admin/tenants/${tenant}/knowledge-acquisition-candidates`;
  const ACTION = (tenant, cand, action) => `${LIST(tenant)}/${cand}/${action}`;

  let passed = 0, failed = 0;
  async function test(name, fn) {
    try { outboundCalls.length = 0; await fn(); console.log(`PASS - ${name}`); passed++; }
    catch (err) { console.log(`FAIL - ${name}\n  ${err.message}`); failed++; }
  }
  function assertNoSecrets(call) {
    const keys = Object.keys(call.headers).map((k) => k.toLowerCase());
    assert.ok(!keys.some((k) => k.includes('internal-secret')), 'aucun en-tête internal-secret');
    assert.ok(!keys.includes('x-admin-password'), "le mot de passe admin Compose n'est jamais relayé à Go");
    assert.ok(!keys.includes('x-actor-id') && !keys.some((k) => k.startsWith('x-actor')), 'aucun en-tête acteur personnalisé');
    assert.strictEqual(call.headers.Authorization, `Bearer ${AUTH_MARKER}`, 'Bearer utilisateur relayé exactement');
  }

  try {
    // ------------------------------------------------------------------ GET
    await test('GET-A. without the admin password -> 401 (existing), never an outbound call', async () => {
      const res = await fetch(LIST('t1'), { headers: { Authorization: `Bearer ${AUTH_MARKER}` } });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(outboundCalls.length, 0);
    });

    await test('GET-B. without a Pandore Bearer -> 401 (existing), never an outbound call', async () => {
      const res = await fetch(LIST('t1'), { headers: adminHeaders });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(outboundCalls.length, 0);
    });

    await test('GET-C. default: the Go URL carries NO status (Go applies its PENDING default); Bearer exact; no body', async () => {
      const res = await fetch(LIST('t1'), { headers: bearerHeaders });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body) && body[0].candidate_id === 'c1');
      assert.strictEqual(outboundCalls.length, 1);
      assert.strictEqual(outboundCalls[0].method, 'GET');
      assert.strictEqual(outboundCalls[0].url, `${BASE}/admin/tenants/t1/knowledge-acquisition-candidates`);
      assert.ok(!outboundCalls[0].url.includes('?'), "aucune query n'est ajoutée");
      assert.deepStrictEqual(Object.keys(outboundCalls[0].headers), ['Authorization']);
      assertNoSecrets(outboundCalls[0]);
    });

    for (const status of ['PENDING_REVIEW', 'REJECTED']) {
      await test(`GET-D. status=${status} is forwarded exactly`, async () => {
        const res = await fetch(`${LIST('t1')}?status=${status}`, { headers: bearerHeaders });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(outboundCalls[0].url, `${BASE}/admin/tenants/t1/knowledge-acquisition-candidates?status=${status}`);
        assertNoSecrets(outboundCalls[0]);
      });
    }

    await test('GET-D2. an accepted query is forwarded in CANONICAL form only (never the raw incoming query string)', async () => {
      const cases = [
        ['?status=REJECTED&', 'REJECTED'], ['?&status=PENDING_REVIEW', 'PENDING_REVIEW'], ['?%73tatus=REJECTED', 'REJECTED'], ['?status=REJECTED&&', 'REJECTED'],
      ];
      for (const [query, status] of cases) {
        outboundCalls.length = 0;
        const res = await fetch(`${LIST('t1')}${query}`, { headers: bearerHeaders });
        assert.strictEqual(res.status, 200, query);
        assert.strictEqual(outboundCalls[0].url, `${BASE}/admin/tenants/t1/knowledge-acquisition-candidates?status=${status}`, query);
      }
    });

    const rejectedQueries = [
      'status=CLOSED', 'status=pending_review', 'status=Rejected', 'status=%20PENDING_REVIEW', 'status=PENDING_REVIEW%20',
      'status=', 'status', 'status=UNKNOWN', 'status=PENDING_REVIEW,REJECTED', 'status=AUTHORIZED',
      'limit=10', 'page=2', 'offset=1', 'cursor=x', 'sort=created_at', 'page_size=5', 'foo=bar', 'order=desc',
      'status=PENDING_REVIEW&limit=10', 'limit=10&status=REJECTED', 'status=PENDING_REVIEW&foo=bar',
      'status=PENDING_REVIEW&status=REJECTED', 'status=REJECTED&status=PENDING_REVIEW', 'status=PENDING_REVIEW&status=PENDING_REVIEW',
      '%zz=1', 'limit=%zz', 'status=PENDING_REVIEW;limit=1', '=x', 'tenant_id=other',
    ];
    await test(`GET-E. ${rejectedQueries.length} out-of-contract queries -> local 400, never forwarded, never silently dropped`, async () => {
      for (const q of rejectedQueries) {
        const res = await fetch(`${LIST('t1')}?${q}`, { headers: bearerHeaders });
        assert.strictEqual(res.status, 400, `?${q} : 400 attendu, obtenu ${res.status}`);
        const body = await res.json();
        assert.strictEqual(body.error.code, 'VALIDATION_FAILED');
      }
      assert.strictEqual(outboundCalls.length, 0, 'aucun appel sortant pour une requête hors contrat');
    });

    await test('GET-F. the upstream status and JSON are forwarded as-is (400/401/403/404/500), never turned into 200', async () => {
      for (const code of [400, 401, 403, 404, 500]) {
        const res = await fetch(LIST(`t_status_${code}`), { headers: bearerHeaders });
        assert.strictEqual(res.status, code);
        assert.deepStrictEqual(await res.json(), ERROR_BODIES[code]);
      }
    });

    await test('GET-G. upstream unreachable -> 502 with a fixed message (no upstream URL, no stack)', async () => {
      const res = await fetch(LIST('t_down'), { headers: bearerHeaders });
      assert.strictEqual(res.status, 502);
      const text = JSON.stringify(await res.json());
      assert.ok(!text.includes('pandore-fake') && !text.includes('ECONNREFUSED') && !text.includes('net.js'), 'aucun détail réseau au navigateur: ' + text);
    });

    // ----------------------------------------------------------------- POST
    for (const action of ['authorize', 'reject']) {
      await test(`POST-A[${action}]. without the admin password or Bearer -> 401, never an outbound call`, async () => {
        let res = await fetch(ACTION('t1', 'c1', action), { method: 'POST', headers: { Authorization: `Bearer ${AUTH_MARKER}` } });
        assert.strictEqual(res.status, 401);
        res = await fetch(ACTION('t1', 'c1', action), { method: 'POST', headers: adminHeaders });
        assert.strictEqual(res.status, 401);
        assert.strictEqual(outboundCalls.length, 0);
      });

      await test(`POST-B[${action}]. exact Go URL, POST, Bearer only, NO body, NO {} , NO Content-Type`, async () => {
        const res = await fetch(ACTION('t1', 'c1', action), { method: 'POST', headers: bearerHeaders });
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.decision_result, 'DECIDED');
        assert.strictEqual(outboundCalls.length, 1);
        const call = outboundCalls[0];
        assert.strictEqual(call.method, 'POST');
        assert.strictEqual(call.url, `${BASE}/admin/tenants/t1/knowledge-acquisition-candidates/c1/${action}`);
        assert.strictEqual(call.body, undefined, 'aucun corps vers Go');
        assert.strictEqual(call.hasBodyKey, false, "aucune clé `body` dans les options fetch (ni {}, ni '')");
        assert.deepStrictEqual(Object.keys(call.headers), ['Authorization'], 'ni Content-Type ni aucun autre en-tête');
        assertNoSecrets(call);
      });

      await test(`POST-C[${action}]. a non-empty incoming body ({} included, any content-type) is REFUSED locally (400), never stripped silently`, async () => {
        for (const [contentType, body] of [['application/json', '{}'], ['application/json', '{"user_id":"x"}'], ['text/plain', 'x'], ['application/json', '[]']]) {
          const res = await fetch(ACTION('t1', 'c1', action), { method: 'POST', headers: { ...bearerHeaders, 'Content-Type': contentType }, body });
          assert.strictEqual(res.status, 400, `${contentType} ${body} : 400 attendu, obtenu ${res.status}`);
          assert.strictEqual((await res.json()).error.code, 'VALIDATION_FAILED');
        }
        assert.strictEqual(outboundCalls.length, 0);
      });

      await test(`POST-D[${action}]. the upstream status and JSON are forwarded as-is (403/404/409/422/500)`, async () => {
        for (const code of [403, 404, 409, 422, 500]) {
          const res = await fetch(ACTION(`t_status_${code}`, 'c1', action), { method: 'POST', headers: bearerHeaders });
          assert.strictEqual(res.status, code);
          assert.deepStrictEqual(await res.json(), ERROR_BODIES[code]);
        }
      });

      await test(`POST-E[${action}]. upstream unreachable -> 502 with a fixed message (no upstream URL, no stack)`, async () => {
        const res = await fetch(ACTION('t_down', 'c1', action), { method: 'POST', headers: bearerHeaders });
        assert.strictEqual(res.status, 502);
        const text = JSON.stringify(await res.json());
        assert.ok(!text.includes('pandore-fake') && !text.includes('ECONNREFUSED') && !text.includes('net.js'), 'aucun détail réseau au navigateur: ' + text);
      });
    }

    await test('POST-F. path parameters are forwarded exactly (a candidate id needing encoding stays encoded)', async () => {
      const res = await fetch(ACTION('tenant-xyz', 'cand%2Fid', 'authorize'), { method: 'POST', headers: bearerHeaders });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(outboundCalls[0].url, `${BASE}/admin/tenants/tenant-xyz/knowledge-acquisition-candidates/cand%2Fid/authorize`);
    });

    await test('POST-G. no route other than the three exists (no detail, no list POST, no CLOSED history)', async () => {
      const bad = [
        ['GET', `${LIST('t1')}/c1`], ['POST', LIST('t1')], ['GET', ACTION('t1', 'c1', 'authorize')],
        ['POST', ACTION('t1', 'c1', 'approve')], ['DELETE', ACTION('t1', 'c1', 'reject')],
      ];
      for (const [method, url] of bad) {
        const res = await fetch(url, { method, headers: bearerHeaders });
        assert.ok(res.status === 404 || res.status === 405, `${method} ${url} : 404/405 attendu, obtenu ${res.status}`);
      }
      assert.strictEqual(outboundCalls.length, 0);
    });

    await test('SRC. the D32 relay block never uses the internal secret, a service token, JSON body building or a JSON Content-Type', async () => {
      const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
      const start = source.indexOf('// --- H3-008D1Q36N4A-5D32');
      const end = source.indexOf('// --- H3-008D1K');
      assert.ok(start > 0 && end > start, 'bloc D32 introuvable');
      const code = source.slice(start, end).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      for (const forbidden of ['INTERNAL_SECRET', 'x-internal-secret', 'JSON.stringify', 'Content-Type', 'req.body', 'checkAdminOrService']) {
        assert.ok(!code.includes(forbidden), `${forbidden} ne doit pas apparaître dans le code du relais D32`);
      }
      assert.strictEqual((code.match(/checkAdmin\(req, res\)/g) || []).length, 2, 'checkAdmin sur le GET et sur le relais partagé des actions');
      assert.strictEqual((code.match(/requirePandoreBearer\(req, res\)/g) || []).length, 2, 'Bearer utilisateur exigé sur les trois routes');
    });

    console.log(`\n${passed}/${passed + failed} test(s) passés.`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    server.close();
    global.fetch = realFetch;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
