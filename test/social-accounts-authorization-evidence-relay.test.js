// H3-008D1Q28 (Q23 Lot 5) — même discipline EXACTE que
// test/social-accounts-latest-attempt-relay.test.js (précédent
// H3-008D1Q16C) : prouve le relais THIN GÉNÉRIQUE vers GET
// /admin/tenants/:id/social-accounts/:social_account_id/authorization-evidence
// via un backend Pandore synthétique intercepté (global.fetch), en
// démarrant le VRAI routeur Express sur un port éphémère (app.listen(0))
// — AUCUN réseau réel, AUCUNE valeur Meta réelle. Cette route est
// introduite et relayée dans le MÊME lot, jamais laissée reproduire
// l'omission constatée pour latest-attempt en H3-008D1Q16B/Q16C.
//
// Usage : node test/social-accounts-authorization-evidence-relay.test.js
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
const AUTH_MARKER = 'test-bearer-AUTHORIZATION-EVIDENCE-EXACT-PASSTHROUGH-PROOF';

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const realFetch = global.fetch;
const LOCALHOST_PREFIX = 'http://127.0.0.1:';
global.fetch = async (url, opts = {}) => {
  const urlStr = String(url);
  if (urlStr.startsWith(LOCALHOST_PREFIX)) return realFetch(url, opts);
  outboundCalls.push({ url: urlStr, method: (opts.method || 'GET').toUpperCase(), headers: opts.headers || {} });
  if (!urlStr.startsWith(process.env.PANDORE_API_BASE)) {
    throw new Error('cible fetch inattendue dans ce test: ' + urlStr);
  }
  const u = new URL(String(urlStr));
  const auth = (opts.headers || {}).Authorization;

  if (u.pathname === '/admin/tenants/t_fixture/social-accounts/sa_1/authorization-evidence') {
    if (auth !== `Bearer ${AUTH_MARKER}`) {
      throw new Error('attendu Authorization relayé exactement tel que reçu du navigateur, obtenu: ' + auth);
    }
    return jsonResponse(200, {
      exists: true, evidence_id: 'evidence-fixture-1', observed_at: '2026-09-18T10:00:00Z',
      source_operation: 'META_ACCOUNTS_LISTING', provenance: 'CONNECTION_TIME_OBSERVATION',
    });
  }
  if (u.pathname === '/admin/tenants/t_fixture/social-accounts/sa_noevidence/authorization-evidence') {
    return jsonResponse(200, { exists: false });
  }
  if (u.pathname === '/admin/tenants/t_fixture/social-accounts/sa_missing/authorization-evidence') {
    return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'compte social introuvable' } });
  }
  if (u.pathname === '/admin/tenants/t_fixture/social-accounts/sa_readfail/authorization-evidence') {
    return jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'panne simulée' } });
  }
  if (u.pathname === '/admin/tenants/tenant-xyz/social-accounts/account-abc/authorization-evidence') {
    return jsonResponse(200, { exists: false });
  }
  throw new Error('appel Go inattendu dans ce test: ' + u.pathname);
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
    await test('1. the route exists — a well-formed authenticated request never returns 404', async () => {
      const res = await fetch(`${base}/api/admin/tenants/t_fixture/social-accounts/sa_1/authorization-evidence`, { headers: bearerHeaders });
      assert.notStrictEqual(res.status, 404, 'la route doit exister dans le routeur Express réel');
    });

    await test('2. exactly one GET is forwarded to the expected Go path — never a POST', async () => {
      outboundCalls.length = 0;
      await fetch(`${base}/api/admin/tenants/t_fixture/social-accounts/sa_1/authorization-evidence`, { headers: bearerHeaders });
      assert.strictEqual(outboundCalls.length, 1, 'attendu exactement 1 appel sortant vers Pandore');
      assert.strictEqual(outboundCalls[0].method, 'GET', 'jamais un POST pour ce relais en lecture');
      assert.strictEqual(outboundCalls[0].url, 'http://pandore-fake.test/admin/tenants/t_fixture/social-accounts/sa_1/authorization-evidence');
    });

    await test('3. tenant_id and social_account_id path parameters are forwarded exactly, unmodified, never swapped', async () => {
      outboundCalls.length = 0;
      const res = await fetch(`${base}/api/admin/tenants/tenant-xyz/social-accounts/account-abc/authorization-evidence`, { headers: bearerHeaders });
      assert.strictEqual(res.status, 200);
      assert.ok(outboundCalls[0].url.includes('/tenants/tenant-xyz/'), 'tenant_id doit apparaître exactement dans l\'URL relayée');
      assert.ok(outboundCalls[0].url.includes('/social-accounts/account-abc/'), 'social_account_id doit apparaître exactement dans l\'URL relayée');
    });

    await test('4a. without x-admin-password, Compose itself rejects with 401 — never an outbound call', async () => {
      outboundCalls.length = 0;
      const res = await fetch(`${base}/api/admin/tenants/t_fixture/social-accounts/sa_1/authorization-evidence`, { headers: { Authorization: `Bearer ${AUTH_MARKER}` } });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(outboundCalls.length, 0, 'aucun appel sortant sans x-admin-password');
    });

    await test('4b. without a Bearer session, Compose itself rejects with 401 — never an outbound call', async () => {
      outboundCalls.length = 0;
      const res = await fetch(`${base}/api/admin/tenants/t_fixture/social-accounts/sa_1/authorization-evidence`, { headers: adminHeaders });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(outboundCalls.length, 0, 'aucun appel sortant sans session Pandore Bearer');
    });

    await test('4c. the real Pandore Bearer session is relayed to Pandore exactly as received', async () => {
      outboundCalls.length = 0;
      await fetch(`${base}/api/admin/tenants/t_fixture/social-accounts/sa_1/authorization-evidence`, { headers: bearerHeaders });
      assert.strictEqual(outboundCalls[0].headers.Authorization, `Bearer ${AUTH_MARKER}`);
    });

    await test('5. Pandore\'s status and body are relayed to the browser unchanged (evidence present)', async () => {
      const res = await fetch(`${base}/api/admin/tenants/t_fixture/social-accounts/sa_1/authorization-evidence`, { headers: bearerHeaders });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.exists, true);
      assert.strictEqual(body.observed_at, '2026-09-18T10:00:00Z');
      assert.strictEqual(body.source_operation, 'META_ACCOUNTS_LISTING');
      assert.strictEqual(body.provenance, 'CONNECTION_TIME_OBSERVATION');
    });

    await test('5b. Pandore\'s status and body are relayed to the browser unchanged (no evidence — legitimate, never an error)', async () => {
      const res = await fetch(`${base}/api/admin/tenants/t_fixture/social-accounts/sa_noevidence/authorization-evidence`, { headers: bearerHeaders });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.exists, false);
    });

    await test('5c. Pandore\'s 404 (unknown account) is relayed unchanged', async () => {
      const res = await fetch(`${base}/api/admin/tenants/t_fixture/social-accounts/sa_missing/authorization-evidence`, { headers: bearerHeaders });
      assert.strictEqual(res.status, 404);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'NOT_FOUND');
    });

    await test('5d. Pandore\'s 500 (read failure) is relayed unchanged — never silently downgraded to exists:false', async () => {
      const res = await fetch(`${base}/api/admin/tenants/t_fixture/social-accounts/sa_readfail/authorization-evidence`, { headers: bearerHeaders });
      assert.strictEqual(res.status, 500);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'INTERNAL_ERROR');
    });

    await test('6. the response body never carries task values or any credential-bearing field', async () => {
      const res = await fetch(`${base}/api/admin/tenants/t_fixture/social-accounts/sa_1/authorization-evidence`, { headers: bearerHeaders });
      const body = await res.json();
      const keys = Object.keys(body);
      for (const forbidden of ['provider_task_values', 'access_token', 'app_secret', 'authorization_code', 'authorizing_actor_id']) {
        assert.ok(!keys.includes(forbidden), `champ interdit présent dans la réponse: ${forbidden}`);
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
