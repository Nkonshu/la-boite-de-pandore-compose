// H3-008D1K — plus petit test pertinent possible, MÊME discipline que
// test/plan-decision.test.js et test/platform-connections.test.js (aucune
// nouvelle dépendance npm, aucun framework de test). Prouve le relais THIN
// GÉNÉRIQUE vers GET/PUT /admin/platform-integrations[/:platform] via un
// backend Pandore synthétique intercepté (global.fetch) — AUCUN réseau
// réel, AUCUNE valeur Meta réelle.
//
// Usage : node test/platform-integrations-relay.test.js
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
const AUTH_MARKER = 'test-bearer-PI-EXACT-PASSTHROUGH-PROOF';
const NON_SUPER_ADMIN_MARKER = 'test-bearer-NON-SUPER-ADMIN';

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// État en mémoire du backend Pandore SYNTHÉTIQUE — jamais une vraie
// base, jamais un vrai chiffrement (ce test ne prouve pas le chiffrement,
// déjà prouvé côté Go — voir internal/platformconfig, repo pandore).
let facebookConfig = null; // null = jamais configuré

function fakePandoreBackend(urlStr, opts) {
  const u = new URL(urlStr);
  const method = (opts.method || 'GET').toUpperCase();
  const headers = opts.headers || {};
  const auth = headers.Authorization || headers.authorization;

  if (auth === `Bearer ${NON_SUPER_ADMIN_MARKER}`) {
    return jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'action réservée à PANDORE_SUPER_ADMIN' } });
  }
  if (auth !== `Bearer ${AUTH_MARKER}`) {
    throw new Error('attendu Authorization relayé exactement tel que reçu du navigateur, obtenu: ' + auth);
  }

  if (u.pathname === '/admin/platform-integrations' && method === 'GET') {
    return jsonResponse(200, [
      {
        platform_id: 'facebook', display_name: 'Facebook', connection_flow_kind: 'OAUTH_REDIRECT',
        configuration_schema: facebookSchema(), configured: !!facebookConfig,
        status: facebookConfig ? facebookConfig.status : undefined,
        secret_fields_set: facebookConfig ? { app_secret: true } : undefined,
      },
      // Preuve d'extensibilité au niveau du RELAIS (le rendu générique
      // profond est prouvé par test/platform-integrations-ui.test.js) :
      // une plateforme synthétique HORS catalogue traverse le MÊME relais,
      // sans aucune branche compose spécifique.
      {
        platform_id: 'synthetic-non-catalog', display_name: 'Synthetic Platform', connection_flow_kind: 'OUT_OF_BAND_MANUAL',
        configuration_schema: [{ key: 'webhook_url', label: 'Webhook URL', kind: 'URL', required: true }],
        configured: false,
      },
    ]);
  }

  if (u.pathname === '/admin/platform-integrations/facebook' && method === 'GET') {
    return jsonResponse(200, facebookDetail());
  }

  if (u.pathname === '/admin/platform-integrations/facebook' && method === 'PUT') {
    let body = {};
    try { body = JSON.parse(opts.body || '{}'); } catch { /* laissé vide */ }
    if (facebookConfig && body.expected_version !== facebookConfig.version) {
      return jsonResponse(409, { error: { code: 'CONFLICT', message: 'version obsolète — rechargez la configuration courante' } });
    }
    if (!facebookConfig && (!body.non_secret_config || !body.non_secret_config.app_id || !body.secret_config || !body.secret_config.app_secret)) {
      return jsonResponse(422, { error: { code: 'VALIDATION_FAILED', message: 'champ requis manquant' } });
    }
    const previousSecret = facebookConfig ? facebookConfig.appSecretPlaintext : undefined;
    facebookConfig = {
      appId: (body.non_secret_config && body.non_secret_config.app_id) || (facebookConfig && facebookConfig.appId),
      appSecretPlaintext: (body.secret_config && body.secret_config.app_secret) || previousSecret,
      status: body.status || (facebookConfig ? facebookConfig.status : 'ACTIVE'),
      version: (facebookConfig ? facebookConfig.version : 0) + 1,
    };
    return jsonResponse(200, facebookDetail());
  }

  throw new Error('route Pandore synthétique non gérée dans ce test: ' + method + ' ' + u.pathname);
}

function facebookSchema() {
  return [
    { key: 'app_id', label: 'Meta App ID', kind: 'TEXT', required: true },
    { key: 'app_secret', label: 'Meta App Secret', kind: 'SECRET', required: true },
  ];
}

function facebookDetail() {
  return {
    platform_id: 'facebook', display_name: 'Facebook', connection_flow_kind: 'OAUTH_REDIRECT',
    configuration_schema: facebookSchema(),
    configured: !!facebookConfig,
    non_secret_config: facebookConfig ? { app_id: facebookConfig.appId } : undefined,
    status: facebookConfig ? facebookConfig.status : undefined,
    secret_fields_set: facebookConfig ? { app_secret: true } : undefined,
    version: facebookConfig ? facebookConfig.version : undefined,
  };
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
  const bearerHeaders = { ...adminHeaders, Authorization: `Bearer ${AUTH_MARKER}` };

  try {
    // --- unauthenticated (pas de Bearer) : rejeté par COMPOSE lui-même,
    // jamais un appel sortant vers Pandore. ---
    let before = outboundCalls.length;
    let res = await fetch(`${base}/api/admin/platform-integrations`, { headers: adminHeaders });
    assert.strictEqual(res.status, 401, 'sans Bearer -> 401');
    assert.strictEqual(outboundCalls.length, before, 'aucun appel sortant émis sans Bearer');

    // --- liste générique : Facebook UNCONFIGURED + plateforme synthétique
    // hors catalogue, toutes deux via le MÊME relais ---
    res = await fetch(`${base}/api/admin/platform-integrations`, { headers: bearerHeaders });
    assert.strictEqual(res.status, 200);
    let list = await res.json();
    assert.strictEqual(list.length, 2);
    const fb = list.find((p) => p.platform_id === 'facebook');
    assert.ok(fb && fb.configured === false, 'Facebook apparaît non configuré');
    const synthetic = list.find((p) => p.platform_id === 'synthetic-non-catalog');
    assert.ok(synthetic, 'plateforme synthétique hors catalogue également listée, sans code compose dédié');

    // --- détail avant configuration ---
    res = await fetch(`${base}/api/admin/platform-integrations/facebook`, { headers: bearerHeaders });
    assert.strictEqual(res.status, 200);
    let detail = await res.json();
    assert.strictEqual(detail.configured, false);

    // --- non-SUPER_ADMIN : le relais transmet le 403 de Pandore tel quel,
    // compose n'invente AUCUNE logique d'autorisation propre ---
    res = await fetch(`${base}/api/admin/platform-integrations/facebook`, {
      method: 'PUT', headers: { ...adminHeaders, Authorization: `Bearer ${NON_SUPER_ADMIN_MARKER}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ non_secret_config: { app_id: 'x' }, secret_config: { app_secret: 'y' } }),
    });
    assert.strictEqual(res.status, 403, 'non-SUPER_ADMIN rejeté, relayé tel quel');

    // --- première sauvegarde : app_id + app_secret synthétiques ---
    res = await fetch(`${base}/api/admin/platform-integrations/facebook`, {
      method: 'PUT', headers: { ...bearerHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ non_secret_config: { app_id: 'synthetic-app-id-v1' }, secret_config: { app_secret: 'synthetic-app-secret-v1' }, status: 'ACTIVE' }),
    });
    assert.strictEqual(res.status, 200, 'première configuration');
    let saved = await res.json();
    assert.strictEqual(saved.configured, true);
    assert.strictEqual(saved.version, 1);
    assert.strictEqual(saved.non_secret_config.app_id, 'synthetic-app-id-v1');
    assert.strictEqual(saved.secret_fields_set.app_secret, true);
    assert.strictEqual(saved.secret_config, undefined, 'jamais de secret_config en retour');
    const rawBody = JSON.stringify(saved);
    assert.ok(!rawBody.includes('synthetic-app-secret-v1'), 'la valeur secrète JAMAIS renvoyée par le relais');

    // --- relecture : App ID visible, secret jamais présent ---
    res = await fetch(`${base}/api/admin/platform-integrations/facebook`, { headers: bearerHeaders });
    detail = await res.json();
    assert.strictEqual(detail.non_secret_config.app_id, 'synthetic-app-id-v1');
    assert.strictEqual(detail.secret_fields_set.app_secret, true);
    assert.ok(!JSON.stringify(detail).includes('synthetic-app-secret-v1'));

    // --- CAS : version obsolète -> 409, jamais appliqué ---
    res = await fetch(`${base}/api/admin/platform-integrations/facebook`, {
      method: 'PUT', headers: { ...bearerHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ non_secret_config: { app_id: 'should-not-apply' }, expected_version: 0 }),
    });
    assert.strictEqual(res.status, 409, 'version obsolète -> conflit relayé');

    // --- édition non-secrète, secret omis -> préservé (backend
    // synthétique simule la préservation Go réelle) ---
    res = await fetch(`${base}/api/admin/platform-integrations/facebook`, {
      method: 'PUT', headers: { ...bearerHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ non_secret_config: { app_id: 'synthetic-app-id-v2' }, expected_version: 1 }),
    });
    assert.strictEqual(res.status, 200, 'édition non-secrète');
    saved = await res.json();
    assert.strictEqual(saved.version, 2);
    assert.strictEqual(saved.non_secret_config.app_id, 'synthetic-app-id-v2');
    assert.strictEqual(saved.secret_fields_set.app_secret, true, 'secret préservé après omission');

    // --- rotation du secret ---
    res = await fetch(`${base}/api/admin/platform-integrations/facebook`, {
      method: 'PUT', headers: { ...bearerHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ non_secret_config: { app_id: 'synthetic-app-id-v2' }, secret_config: { app_secret: 'synthetic-app-secret-v2' }, expected_version: 2 }),
    });
    assert.strictEqual(res.status, 200, 'rotation du secret');
    saved = await res.json();
    assert.strictEqual(saved.version, 3);
    assert.ok(!JSON.stringify(saved).includes('synthetic-app-secret-v2'), 'secret rotaté jamais renvoyé');

    console.log('platform-integrations-relay.test.js: toutes les assertions ont réussi (' + outboundCalls.length + ' appels sortants interceptés, zéro réseau réel)');
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
