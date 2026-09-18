// H3-008D1O1B §4/§7 — plus petit test pertinent possible (même discipline
// que test/platform-integrations-relay.test.js) prouvant le relais THIN
// GÉNÉRIQUE PUT /api/admin/tenants/:id -> PUT /admin/tenants/{id} (Go) via
// un backend Pandore synthétique intercepté (global.fetch) — AUCUN réseau
// réel, AUCUNE valeur Meta.
//
// Usage : node test/tenant-rename-relay.test.js
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
const AUTH_MARKER = 'test-bearer-TENANT-RENAME-EXACT-PASSTHROUGH-PROOF';

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// État en mémoire du backend Pandore SYNTHÉTIQUE — jamais une vraie base ;
// ce test ne prouve pas la CAS Postgres réelle (déjà prouvée côté Go, voir
// internal/tenantidentity, repo pandore), seulement que compose relaie
// {name, expected_version} tel quel et ne réinterprète jamais la réponse.
let tenant = { ID: 'tenant-fixture-1', Name: 'Guy', Status: 'ONBOARDING', CreatedAt: '2026-01-01T00:00:00Z', Version: 1, UpdatedAt: '2026-01-01T00:00:00Z', UpdatedBy: '' };

function fakePandoreBackend(urlStr, opts) {
  const u = new URL(urlStr);
  const method = (opts.method || 'GET').toUpperCase();
  const headers = opts.headers || {};
  const auth = headers.Authorization || headers.authorization;

  if (auth !== `Bearer ${AUTH_MARKER}`) {
    throw new Error('attendu Authorization relayé exactement tel que reçu du navigateur, obtenu: ' + auth);
  }

  if (u.pathname === `/admin/tenants/${tenant.ID}` && method === 'PUT') {
    let body = {};
    try { body = JSON.parse(opts.body || '{}'); } catch { /* laissé vide */ }
    if (!body.name || !body.name.trim()) {
      return jsonResponse(422, { error: { code: 'VALIDATION_FAILED', message: 'nom invalide' } });
    }
    if (body.expected_version !== tenant.Version) {
      return jsonResponse(409, { error: { code: 'CONFLICT', message: 'version obsolète — rechargez le tenant courant' } });
    }
    tenant = { ...tenant, Name: body.name.trim(), Version: tenant.Version + 1, UpdatedBy: 'admin-fixture', UpdatedAt: '2026-01-02T00:00:00Z' };
    return jsonResponse(200, tenant);
  }

  throw new Error('route Pandore synthétique non gérée dans ce test: ' + method + ' ' + u.pathname);
}

const realFetch = global.fetch;
const LOCALHOST_PREFIX = 'http://127.0.0.1:';
global.fetch = async (url, opts = {}) => {
  const urlStr = String(url);
  if (urlStr.startsWith(LOCALHOST_PREFIX)) return realFetch(url, opts);
  outboundCalls.push({ url: urlStr, method: (opts && opts.method) || 'GET' });
  if (!urlStr.startsWith(process.env.PANDORE_API_BASE)) {
    throw new Error('cible fetch inattendue dans ce test: ' + urlStr);
  }
  return fakePandoreBackend(urlStr, opts);
};

const app = require('../src/server.js');

async function main() {
  const server = app.listen(0);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const adminHeaders = { 'x-admin-password': process.env.ADMIN_PASSWORD };
  const bearerHeaders = { ...adminHeaders, Authorization: `Bearer ${AUTH_MARKER}`, 'Content-Type': 'application/json' };

  try {
    // --- unauthenticated (pas de Bearer) : rejeté par COMPOSE lui-même,
    // jamais un appel sortant vers Pandore. ---
    let before = outboundCalls.length;
    let res = await fetch(`${base}/api/admin/tenants/${tenant.ID}`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ name: 'x', expected_version: 1 }),
    });
    assert.strictEqual(res.status, 401, 'sans Bearer -> 401');
    assert.strictEqual(outboundCalls.length, before, 'aucun appel sortant émis sans Bearer');

    // --- validation : nom vide relayé tel quel (422 Go, jamais recodé) ---
    res = await fetch(`${base}/api/admin/tenants/${tenant.ID}`, {
      method: 'PUT', headers: bearerHeaders, body: JSON.stringify({ name: '   ', expected_version: 1 }),
    });
    assert.strictEqual(res.status, 422, 'nom invalide -> 422 relayé tel quel');

    // --- CAS : version obsolète -> 409, jamais appliqué ---
    res = await fetch(`${base}/api/admin/tenants/${tenant.ID}`, {
      method: 'PUT', headers: bearerHeaders, body: JSON.stringify({ name: 'Chap Chap', expected_version: 0 }),
    });
    assert.strictEqual(res.status, 409, 'version obsolète -> conflit relayé');
    assert.strictEqual(tenant.Name, 'Guy', 'aucune application partielle après un 409');

    // --- renommage réussi : version courante fournie ---
    res = await fetch(`${base}/api/admin/tenants/${tenant.ID}`, {
      method: 'PUT', headers: bearerHeaders, body: JSON.stringify({ name: 'Chap Chap', expected_version: 1 }),
    });
    assert.strictEqual(res.status, 200, 'renommage avec la bonne version -> succès');
    let saved = await res.json();
    assert.strictEqual(saved.id, tenant.ID, 'Tenant.ID préservé (jamais recréé)');
    assert.strictEqual(saved.name, 'Chap Chap');
    assert.strictEqual(saved.version, 2, 'version renvoyée incrémentée par le backend, jamais devinée par compose');

    // --- rejouer la MÊME expected_version après succès -> 409 (la version
    // a changé, exactement le scénario "second admin avec un onglet
    // périmé") ---
    res = await fetch(`${base}/api/admin/tenants/${tenant.ID}`, {
      method: 'PUT', headers: bearerHeaders, body: JSON.stringify({ name: 'Encore un autre nom', expected_version: 1 }),
    });
    assert.strictEqual(res.status, 409, 'rejouer une version déjà consommée -> conflit');
    assert.strictEqual(tenant.Name, 'Chap Chap', 'le nom confirmé précédemment reste inchangé après le conflit');

    console.log('tenant-rename-relay.test.js: toutes les assertions ont réussi (' + outboundCalls.length + ' appels sortants interceptés, zéro réseau réel)');
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
