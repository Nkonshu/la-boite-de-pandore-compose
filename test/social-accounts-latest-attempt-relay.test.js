// H3-008D1Q16C — plus petit test pertinent possible, MÊME discipline que
// test/platform-integrations-relay.test.js (aucune nouvelle dépendance
// npm, aucun framework de test). Prouve le relais THIN GÉNÉRIQUE vers GET
// /admin/tenants/:id/social-accounts/:social_account_id/capabilities/latest-attempt
// via un backend Pandore synthétique intercepté (global.fetch), en
// démarrant le VRAI routeur Express sur un port éphémère (app.listen(0))
// — AUCUN réseau réel, AUCUNE valeur Meta réelle.
//
// H3-008D1Q16B a établi que les tests VM du frontend (fetch simulé avant
// même d'atteindre Express) et les tests httpapi Go (serveur Go direct,
// sans passer par Compose) ne pouvaient structurellement PAS détecter
// l'absence de cette route de relais — ce fichier comble exactement cette
// lacune de couverture en exerçant le VRAI app Express de Compose.
//
// Usage : node test/social-accounts-latest-attempt-relay.test.js
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
const AUTH_MARKER = 'test-bearer-LATEST-ATTEMPT-EXACT-PASSTHROUGH-PROOF';

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const realFetch = global.fetch;
const LOCALHOST_PREFIX = 'http://127.0.0.1:';
global.fetch = async (url, opts = {}) => {
  const urlStr = String(url);
  // Les requêtes du TEST lui-même vers son propre serveur Express local
  // (app.listen(0)) doivent emprunter le VRAI fetch réseau — seules les
  // requêtes SORTANTES émises par server.js vers PANDORE_API_BASE sont
  // interceptées ci-dessous (même distinction que
  // test/platform-integrations-relay.test.js).
  if (urlStr.startsWith(LOCALHOST_PREFIX)) return realFetch(url, opts);
  outboundCalls.push({ url: urlStr, method: (opts.method || 'GET').toUpperCase(), headers: opts.headers || {} });
  if (!urlStr.startsWith(process.env.PANDORE_API_BASE)) {
    throw new Error('cible fetch inattendue dans ce test: ' + urlStr);
  }
  const u = new URL(String(urlStr));
  const auth = (opts.headers || {}).Authorization;

  if (u.pathname === '/admin/tenants/t_fixture/social-accounts/sa_1/capabilities/latest-attempt') {
    if (auth !== `Bearer ${AUTH_MARKER}`) {
      throw new Error('attendu Authorization relayé exactement tel que reçu du navigateur, obtenu: ' + auth);
    }
    return jsonResponse(200, {
      exists: true, attempt_id: 'attempt-fixture-1', platform: 'facebook',
      triggered_at: '2026-09-19T22:29:14Z', finished_at: '2026-09-19T22:29:15Z', outcome: 'INCONCLUSIVE',
      observations: [{ capability: 'PUBLISH_TEXT', observed_state: 'UNKNOWN', observed_provenance: 'REAL_OBSERVATION', applied: false, skip_reason: 'ANTI_DOWNGRADE_UNKNOWN' }],
      external_effects: null,
    });
  }
  if (u.pathname === '/admin/tenants/t_fixture/social-accounts/sa_missing/capabilities/latest-attempt') {
    return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'compte social introuvable' } });
  }
  if (u.pathname === '/admin/tenants/tenant-xyz/social-accounts/account-abc/capabilities/latest-attempt') {
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
      const res = await fetch(`${base}/api/admin/tenants/t_fixture/social-accounts/sa_1/capabilities/latest-attempt`, { headers: bearerHeaders });
      assert.notStrictEqual(res.status, 404, 'la route doit exister dans le routeur Express réel — H3-008D1Q16B a prouvé son absence, ce test prouve sa présence');
    });

    await test('2/6. exactly one GET is forwarded to the expected Go path — never a POST', async () => {
      outboundCalls.length = 0;
      await fetch(`${base}/api/admin/tenants/t_fixture/social-accounts/sa_1/capabilities/latest-attempt`, { headers: bearerHeaders });
      assert.strictEqual(outboundCalls.length, 1, 'attendu exactement 1 appel sortant vers Pandore');
      assert.strictEqual(outboundCalls[0].method, 'GET', 'jamais un POST pour ce relais en lecture');
      assert.strictEqual(outboundCalls[0].url, 'http://pandore-fake.test/admin/tenants/t_fixture/social-accounts/sa_1/capabilities/latest-attempt');
    });

    await test('3. tenant_id and social_account_id path parameters are forwarded exactly, unmodified, never swapped', async () => {
      outboundCalls.length = 0;
      const res = await fetch(`${base}/api/admin/tenants/tenant-xyz/social-accounts/account-abc/capabilities/latest-attempt`, { headers: bearerHeaders });
      assert.strictEqual(res.status, 200);
      assert.ok(outboundCalls[0].url.includes('/tenants/tenant-xyz/'), 'tenant_id doit apparaître exactement dans l\'URL relayée');
      assert.ok(outboundCalls[0].url.includes('/social-accounts/account-abc/'), 'social_account_id doit apparaître exactement dans l\'URL relayée');
      assert.ok(!outboundCalls[0].url.includes('account-abc/social-accounts'), 'les deux identifiants ne doivent jamais être intervertis');
    });

    await test('4a. without x-admin-password, Compose itself rejects with 401 — never an outbound call', async () => {
      outboundCalls.length = 0;
      const res = await fetch(`${base}/api/admin/tenants/t_fixture/social-accounts/sa_1/capabilities/latest-attempt`, { headers: { Authorization: `Bearer ${AUTH_MARKER}` } });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(outboundCalls.length, 0, 'aucun appel sortant sans x-admin-password');
    });

    await test('4b. without a Bearer session, Compose itself rejects with 401 — never an outbound call', async () => {
      outboundCalls.length = 0;
      const res = await fetch(`${base}/api/admin/tenants/t_fixture/social-accounts/sa_1/capabilities/latest-attempt`, { headers: adminHeaders });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(outboundCalls.length, 0, 'aucun appel sortant sans session Pandore Bearer');
    });

    await test('4c. the real Pandore Bearer session is relayed to Pandore exactly as received (same auth contract as adjacent routes)', async () => {
      outboundCalls.length = 0;
      await fetch(`${base}/api/admin/tenants/t_fixture/social-accounts/sa_1/capabilities/latest-attempt`, { headers: bearerHeaders });
      assert.strictEqual(outboundCalls[0].headers.Authorization, `Bearer ${AUTH_MARKER}`);
    });

    await test('5. Pandore\'s status and body are relayed to the browser unchanged (success case)', async () => {
      const res = await fetch(`${base}/api/admin/tenants/t_fixture/social-accounts/sa_1/capabilities/latest-attempt`, { headers: bearerHeaders });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.exists, true);
      assert.strictEqual(body.outcome, 'INCONCLUSIVE');
      assert.strictEqual(body.observations[0].skip_reason, 'ANTI_DOWNGRADE_UNKNOWN');
      assert.strictEqual(body.external_effects, null, 'la distinction nil-vs-[] doit survivre au relais JSON, jamais convertie en []');
    });

    await test('5b. Pandore\'s status and body are relayed to the browser unchanged (error case, e.g. unknown account)', async () => {
      const res = await fetch(`${base}/api/admin/tenants/t_fixture/social-accounts/sa_missing/capabilities/latest-attempt`, { headers: bearerHeaders });
      assert.strictEqual(res.status, 404, 'le 404 de Pandore doit être relayé tel quel, jamais transformé en 200/500');
      const body = await res.json();
      assert.strictEqual(body.error.code, 'NOT_FOUND');
    });

    await test('7. this relay never reaches the revalidation route — structurally a GET-only handler, no fallback to POST', async () => {
      outboundCalls.length = 0;
      await fetch(`${base}/api/admin/tenants/t_fixture/social-accounts/sa_1/capabilities/latest-attempt`, { headers: bearerHeaders });
      const revalidateCalls = outboundCalls.filter((c) => c.url.includes('/capabilities/revalidate'));
      assert.strictEqual(revalidateCalls.length, 0, 'aucun appel vers /capabilities/revalidate ne doit jamais être émis par ce relais en lecture');
    });

    console.log(`\n${passed}/${passed + failed} test(s) passés.`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    server.close();
    global.fetch = realFetch;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
