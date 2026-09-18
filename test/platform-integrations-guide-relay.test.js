// H3-008D1M — relais THIN GÉNÉRIQUE vers GET /admin/platform-integrations/:platform/guide
// (Pandore synthétique intercepté, zéro réseau réel). Même discipline que
// test/platform-integrations-relay.test.js.
//
// Usage : node test/platform-integrations-guide-relay.test.js
'use strict';

const assert = require('assert');

process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.PANDORE_API_BASE = 'http://pandore-fake.test';
process.env.PANDORE_GO_INTERNAL_SECRET = 'test-go-internal-secret';
process.env.PANDORE_INTERNAL_SECRET = 'test-n8n-internal-secret';

const outboundCalls = [];
const AUTH_MARKER = 'test-bearer-GUIDE-RELAY-PROOF';

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const syntheticGuide = {
  platform_id: 'synthetic-relay-platform',
  version: 'v1',
  last_verified_at: '2026-01-01T00:00:00Z',
  steps: [
    { key: 'step1', title: 'Étape 1', confirmation_kind: 'USER_CONFIRMS' },
    { key: 'step2', title: 'Étape 2', pandore_field_key: 'api_key', confirmation_kind: 'USER_CONFIRMS' },
  ],
};

function fakePandoreBackend(urlStr, opts) {
  const u = new URL(urlStr);
  const headers = opts.headers || {};
  const auth = headers.Authorization || headers.authorization;
  if (auth !== `Bearer ${AUTH_MARKER}`) throw new Error('attendu Authorization relayé tel quel, obtenu: ' + auth);

  if (u.pathname === '/admin/platform-integrations/synthetic-relay-platform/guide') {
    return jsonResponse(200, syntheticGuide);
  }
  if (u.pathname === '/admin/platform-integrations/no-guide-platform/guide') {
    return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'aucun guide de configuration disponible pour cette plateforme' } });
  }
  if (u.pathname === '/tenants/tenant-abc') {
    return jsonResponse(200, { ID: 'tenant-abc', Name: 'Chap Chap', Status: 'CRUISE', CreatedAt: '2026-01-01T00:00:00Z' });
  }
  if (u.pathname === '/admin/tenants') {
    return jsonResponse(200, [
      { ID: 'tenant-abc', Name: 'Chap Chap', Status: 'CRUISE', CreatedAt: '2026-01-01T00:00:00Z' },
      { ID: 'tenant-xyz', Name: 'Autre Client', Status: 'ONBOARDING', CreatedAt: '2026-01-02T00:00:00Z' },
    ]);
  }
  throw new Error('route Pandore synthétique non gérée: ' + u.pathname);
}

const realFetch = global.fetch;
const LOCALHOST_PREFIX = 'http://127.0.0.1:';
global.fetch = async (url, opts = {}) => {
  const urlStr = String(url);
  if (urlStr.startsWith(LOCALHOST_PREFIX)) return realFetch(url, opts);
  outboundCalls.push({ url: urlStr });
  if (!urlStr.startsWith(process.env.PANDORE_API_BASE)) throw new Error('cible fetch inattendue: ' + urlStr);
  return fakePandoreBackend(urlStr, opts);
};

const app = require('../src/server.js');

async function main() {
  const server = app.listen(0);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const bearerHeaders = { 'x-admin-password': process.env.ADMIN_PASSWORD, Authorization: `Bearer ${AUTH_MARKER}` };

  try {
    // --- guide relay, forwarded verbatim ---
    let res = await fetch(`${base}/api/admin/platform-integrations/synthetic-relay-platform/guide`, { headers: bearerHeaders });
    assert.strictEqual(res.status, 200);
    const guide = await res.json();
    assert.strictEqual(guide.version, 'v1');
    assert.strictEqual(guide.steps.length, 2);
    assert.strictEqual(guide.steps[1].pandore_field_key, 'api_key');

    // --- 404 (no guide) relayed as-is, never fabricated ---
    res = await fetch(`${base}/api/admin/platform-integrations/no-guide-platform/guide`, { headers: bearerHeaders });
    assert.strictEqual(res.status, 404);

    // --- unauthenticated: compose itself rejects, no outbound call ---
    const before = outboundCalls.length;
    res = await fetch(`${base}/api/admin/platform-integrations/synthetic-relay-platform/guide`, { headers: { 'x-admin-password': process.env.ADMIN_PASSWORD } });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(outboundCalls.length, before, 'aucun appel sortant sans Bearer');

    // --- tenant business-name resolution, translated to snake_case ---
    res = await fetch(`${base}/api/admin/tenants/tenant-abc`, { headers: bearerHeaders });
    assert.strictEqual(res.status, 200);
    const tenant = await res.json();
    assert.strictEqual(tenant.id, 'tenant-abc');
    assert.strictEqual(tenant.name, 'Chap Chap');

    // --- tenant list (search/selector), translated ---
    res = await fetch(`${base}/api/admin/tenants`, { headers: bearerHeaders });
    assert.strictEqual(res.status, 200);
    const tenants = await res.json();
    assert.strictEqual(tenants.length, 2);
    assert.strictEqual(tenants[0].name, 'Chap Chap');
    assert.strictEqual(tenants[1].id, 'tenant-xyz');

    console.log('platform-integrations-guide-relay.test.js: toutes les assertions ont réussi (' + outboundCalls.length + ' appels sortants interceptés, zéro réseau réel)');
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
