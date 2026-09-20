// H3-008D1Q36K — Generic Admin Domain Applicability Review UI. Preuve du
// relais THIN GÉNÉRIQUE vers GET /admin/domain-profiles et GET/POST
// /admin/tenants/:id/domain-profile-selections (contrat évolué
// H3-008D1Q36J), via un backend Pandore synthétique intercepté
// (global.fetch), en démarrant le VRAI routeur Express sur un port
// éphémère (app.listen(0)) — AUCUN réseau réel, AUCUN profil réel Chap
// Chap, AUCUN appel IA/Meta. Même discipline EXACTE que
// test/social-accounts-authorization-evidence-relay.test.js.
//
// Usage : node test/domain-applicability-relay.test.js
'use strict';

const assert = require('assert');

process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.PANDORE_API_BASE = 'http://pandore-fake.test';
process.env.PANDORE_GO_INTERNAL_SECRET = 'test-go-internal-secret';
process.env.PANDORE_INTERNAL_SECRET = 'test-n8n-internal-secret';
delete process.env.META_APP_ID;
delete process.env.META_APP_SECRET;
delete process.env.META_REDIRECT_URI;

const outboundCalls = [];
const AUTH_MARKER = 'test-bearer-DOMAIN-APPLICABILITY-EXACT-PASSTHROUGH-PROOF';

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const realFetch = global.fetch;
const LOCALHOST_PREFIX = 'http://127.0.0.1:';
global.fetch = async (url, opts = {}) => {
  const urlStr = String(url);
  if (urlStr.startsWith(LOCALHOST_PREFIX)) return realFetch(url, opts);
  outboundCalls.push({ url: urlStr, method: (opts.method || 'GET').toUpperCase(), headers: opts.headers || {}, body: opts.body });
  if (!urlStr.startsWith(process.env.PANDORE_API_BASE)) {
    throw new Error('cible fetch inattendue dans ce test: ' + urlStr);
  }
  const u = new URL(urlStr);
  const auth = (opts.headers || {}).Authorization;
  const method = (opts.method || 'GET').toUpperCase();

  if (u.pathname === '/admin/domain-profiles' && method === 'GET') {
    if (auth !== `Bearer ${AUTH_MARKER}`) throw new Error('attendu Authorization relayé exactement, obtenu: ' + auth);
    return jsonResponse(200, [
      { profile_id: 'synthetic:domain-alpha', name: 'Synthetic Alpha', description: 'Profil de test A', requirement_keys: ['KEY_A'] },
      { profile_id: 'synthetic:domain-beta', name: 'Synthetic Beta', description: 'Profil de test B', requirement_keys: ['KEY_B'] },
    ]);
  }
  if (u.pathname === '/admin/tenants/t_fixture/domain-profile-selections' && method === 'GET') {
    if (auth !== `Bearer ${AUTH_MARKER}`) throw new Error('attendu Authorization relayé exactement, obtenu: ' + auth);
    return jsonResponse(200, { reviewed: false, selections: [] });
  }
  if (u.pathname === '/admin/tenants/t_zero/domain-profile-selections' && method === 'POST') {
    const parsed = JSON.parse(opts.body);
    if (parsed.reviewed !== true || !Array.isArray(parsed.selections) || parsed.selections.length !== 0) {
      throw new Error('attendu {reviewed:true, selections:[]} relayé exactement, obtenu: ' + opts.body);
    }
    return jsonResponse(201, { reviewed: true, reviewed_at: '2026-09-21T00:00:00Z', reviewed_by: 'operator-1', selections: [] });
  }
  if (u.pathname === '/admin/tenants/t_multi/domain-profile-selections' && method === 'POST') {
    const parsed = JSON.parse(opts.body);
    if (parsed.reviewed !== true || !Array.isArray(parsed.selections) || parsed.selections.length !== 2) {
      throw new Error('attendu {reviewed:true, selections:[2 items]} relayé exactement, obtenu: ' + opts.body);
    }
    return jsonResponse(201, {
      reviewed: true, reviewed_at: '2026-09-21T00:00:00Z', reviewed_by: 'operator-1',
      selections: parsed.selections.map((s, i) => ({ id: 'sel_' + i, tenant_id: 't_multi', profile_id: s.profile_id, kind: s.kind, selected_at: '2026-09-21T00:00:00Z', selected_by: 'operator-1' })),
    });
  }
  if (u.pathname === '/admin/tenants/t_conflict/domain-profile-selections' && method === 'POST') {
    return jsonResponse(422, { error: { code: 'VALIDATION_FAILED', message: 'sélection en conflit' } });
  }
  if (u.pathname === '/admin/tenants/tenant-xyz/domain-profile-selections' && method === 'GET') {
    return jsonResponse(200, { reviewed: false, selections: [] });
  }
  throw new Error('appel Go inattendu dans ce test: ' + method + ' ' + u.pathname);
};

const app = require('../src/server.js');

async function main() {
  const server = app.listen(0);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const adminHeaders = { 'x-admin-password': process.env.ADMIN_PASSWORD };
  const bearerHeaders = { ...adminHeaders, Authorization: `Bearer ${AUTH_MARKER}` };

  let passed = 0, failed = 0;
  async function test(name, fn) {
    try { await fn(); console.log(`PASS - ${name}`); passed++; }
    catch (err) { console.log(`FAIL - ${name}\n  ${err.message}`); failed++; }
  }

  try {
    await test('A. catalog GET relayed correctly', async () => {
      outboundCalls.length = 0;
      const res = await fetch(`${base}/api/admin/domain-profiles`, { headers: bearerHeaders });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.length, 2);
      assert.strictEqual(body[0].profile_id, 'synthetic:domain-alpha');
      assert.strictEqual(outboundCalls.length, 1);
      assert.strictEqual(outboundCalls[0].method, 'GET');
      assert.strictEqual(outboundCalls[0].url, 'http://pandore-fake.test/admin/domain-profiles');
    });

    await test('B. tenant review GET relayed correctly', async () => {
      outboundCalls.length = 0;
      const res = await fetch(`${base}/api/admin/tenants/t_fixture/domain-profile-selections`, { headers: bearerHeaders });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.reviewed, false);
      assert.deepStrictEqual(body.selections, []);
      assert.strictEqual(outboundCalls[0].url, 'http://pandore-fake.test/admin/tenants/t_fixture/domain-profile-selections');
    });

    await test('C. POST reviewed=true + [] relayed correctly', async () => {
      outboundCalls.length = 0;
      const res = await fetch(`${base}/api/admin/tenants/t_zero/domain-profile-selections`, {
        method: 'POST', headers: { ...bearerHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewed: true, selections: [] }),
      });
      assert.strictEqual(res.status, 201);
      const body = await res.json();
      assert.strictEqual(body.reviewed, true);
      assert.deepStrictEqual(body.selections, []);
      assert.strictEqual(outboundCalls[0].method, 'POST');
    });

    await test('D. POST reviewed=true + multiple selections relayed correctly', async () => {
      outboundCalls.length = 0;
      const res = await fetch(`${base}/api/admin/tenants/t_multi/domain-profile-selections`, {
        method: 'POST', headers: { ...bearerHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewed: true, selections: [{ profile_id: 'synthetic:domain-alpha', kind: 'DOMAIN' }, { profile_id: 'synthetic:domain-beta', kind: 'FACET' }] }),
      });
      assert.strictEqual(res.status, 201);
      const body = await res.json();
      assert.strictEqual(body.selections.length, 2);
    });

    await test('E1. without x-admin-password, Compose itself rejects with 401 — never an outbound call', async () => {
      outboundCalls.length = 0;
      const res = await fetch(`${base}/api/admin/domain-profiles`, { headers: { Authorization: `Bearer ${AUTH_MARKER}` } });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(outboundCalls.length, 0);
    });

    await test('E2. without a Bearer session, Compose itself rejects with 401 — never an outbound call', async () => {
      outboundCalls.length = 0;
      const res = await fetch(`${base}/api/admin/tenants/t_fixture/domain-profile-selections`, { headers: adminHeaders });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(outboundCalls.length, 0);
    });

    await test('E3. the real Pandore Bearer session is relayed exactly as received', async () => {
      outboundCalls.length = 0;
      await fetch(`${base}/api/admin/domain-profiles`, { headers: bearerHeaders });
      assert.strictEqual(outboundCalls[0].headers.Authorization, `Bearer ${AUTH_MARKER}`);
    });

    await test('F. tenant_id path parameter is forwarded exactly, unmodified', async () => {
      outboundCalls.length = 0;
      const res = await fetch(`${base}/api/admin/tenants/tenant-xyz/domain-profile-selections`, { headers: bearerHeaders });
      assert.strictEqual(res.status, 200);
      assert.ok(outboundCalls[0].url.includes('/tenants/tenant-xyz/'), 'tenant_id doit apparaître exactement dans l\'URL relayée');
    });

    await test('G. backend error status/body safely propagated (conflict, never silently swallowed)', async () => {
      const res = await fetch(`${base}/api/admin/tenants/t_conflict/domain-profile-selections`, {
        method: 'POST', headers: { ...bearerHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewed: true, selections: [] }),
      });
      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'VALIDATION_FAILED');
    });

    await test('H. no internal-secret header is ever sent on any domain-applicability relay call', async () => {
      outboundCalls.length = 0;
      await fetch(`${base}/api/admin/domain-profiles`, { headers: bearerHeaders });
      await fetch(`${base}/api/admin/tenants/t_fixture/domain-profile-selections`, { headers: bearerHeaders });
      for (const call of outboundCalls) {
        assert.ok(!('x-internal-secret' in call.headers), 'x-internal-secret ne doit jamais être envoyé à Pandore pour ce relais');
        assert.ok(!Object.keys(call.headers).some(h => h.toLowerCase().includes('internal-secret')), 'aucun en-tête internal-secret sous quelque casse que ce soit');
      }
    });

    console.log(`\n${passed}/${passed + failed} test(s) passés.`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    server.close();
    global.fetch = realFetch;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
