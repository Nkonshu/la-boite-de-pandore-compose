// H3-008D1J — plus petit test pertinent possible, MÊME discipline que
// test/plan-decision.test.js (aucune nouvelle dépendance npm, aucun
// framework de test — ce dépôt n'en a toujours aucun). Simule le backend
// Pandore (Go) en interceptant `global.fetch` — AUCUN réseau réel, AUCUNE
// valeur Meta réelle (§14/§15 du mandat H3-008D1J : "Use synthetic
// platform/Meta values only. No external network.").
//
// Usage : node test/platform-connections.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Variables d'environnement de test — DÉLIBÉRÉMENT synthétiques, jamais un
// vrai credential. META_APP_ID/META_APP_SECRET/META_REDIRECT_URI sont
// explicitement ABSENTS : preuve comportementale (pas seulement de lecture
// du code source) que server.js démarre et fonctionne intégralement sans
// eux (§14 : "Compose source has no functional META_APP_ID/APP_SECRET/
// REDIRECT_URI read").
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.PANDORE_API_BASE = 'http://pandore-fake.test';
process.env.PANDORE_GO_INTERNAL_SECRET = 'test-go-internal-secret';
process.env.PANDORE_INTERNAL_SECRET = 'test-n8n-internal-secret';
delete process.env.META_APP_ID;
delete process.env.META_APP_SECRET;
delete process.env.META_REDIRECT_URI;
process.env.PORT = '0'; // jamais utilisé : require.main !== module dans ce test (voir server.js)

// --- interception fetch : enregistre chaque appel sortant, refuse tout ce
// qui ressemblerait à un appel Meta réel, répond en Pandore synthétique
// pour le reste. ---
const outboundCalls = [];
const AUTH_MARKER = 'test-bearer-EXACT-PASSTHROUGH-PROOF';
const AUTHORIZATION_URL_MARKER = 'https://www.facebook.com/v21.0/dialog/oauth?marker=EXACT-PASSTHROUGH-PROOF';

const sessions = new Map(); // session_ref -> { status, tenantId, platformId }

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function fakePandoreBackend(urlStr, opts) {
  const u = new URL(urlStr);
  const method = (opts.method || 'GET').toUpperCase();
  const headers = opts.headers || {};

  if (u.pathname === '/auth/login' && method === 'POST') {
    return jsonResponse(200, { token: AUTH_MARKER, expires_at: '2999-01-01T00:00:00Z', user: { id: 'u1', email: 'operator@example.test', role: 'PANDORE_OPERATOR' } });
  }

  let m = u.pathname.match(/^\/admin\/tenants\/([^/]+)\/platform-connections\/available$/);
  if (m && method === 'GET') {
    assertBearer(headers);
    return jsonResponse(200, [{ platform_id: 'facebook', display_name: 'Facebook', connection_flow_kind: 'OAUTH_REDIRECT' }]);
  }

  m = u.pathname.match(/^\/admin\/tenants\/([^/]+)\/platform-connections\/([^/]+)\/connect$/);
  if (m && method === 'POST') {
    assertBearer(headers);
    const sessionRef = 'sess-' + (sessions.size + 1) + '-' + Math.random().toString(16).slice(2);
    sessions.set(sessionRef, { status: 'PENDING', tenantId: m[1], platformId: m[2] });
    return jsonResponse(201, {
      session_ref: sessionRef, platform_id: m[2], flow_kind: 'OAUTH_REDIRECT', status: 'PENDING',
      expires_at: '2999-01-01T00:00:00Z',
      payload: { authorization_url: `${AUTHORIZATION_URL_MARKER}&state=${sessionRef}` },
    });
  }

  m = u.pathname.match(/^\/oauth\/platforms\/([^/]+)\/callback$/);
  if (m) {
    const state = u.searchParams.get('state');
    const sess = sessions.get(state);
    if (!sess) return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'session de connexion introuvable' } });
    if (sess.platformId !== m[1]) return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'session introuvable pour cette plateforme' } });
    if (sess.status !== 'PENDING') return jsonResponse(409, { error: { code: 'CONFLICT', message: 'session déjà consommée' } });
    sess.status = 'CONSUMED';
    return jsonResponse(200, { session_ref: state, platform_id: sess.platformId, status: 'CONSUMED' });
  }

  m = u.pathname.match(/^\/admin\/tenants\/([^/]+)\/platform-connections\/([^/]+)\/([^/]+)\/resources$/);
  if (m && method === 'GET') {
    assertBearer(headers);
    return jsonResponse(200, [{ external_id: 'page-1', display_name: 'Synthetic Page', metadata: {} }]);
  }

  m = u.pathname.match(/^\/admin\/tenants\/([^/]+)\/platform-connections\/([^/]+)\/([^/]+)\/select$/);
  if (m && method === 'POST') {
    assertBearer(headers);
    return jsonResponse(201, {
      ID: 'acct-1', TenantID: m[1], Platform: m[2], ExternalAccountID: 'page-1', DisplayName: 'Synthetic Page',
      GrantedScopes: ['pages_show_list'], Status: 'CONNECTED', ConnectedAt: '2026-01-01T00:00:00Z', ConnectedBy: 'operator@example.test',
    });
  }

  throw new Error(`route Pandore synthétique non gérée dans ce test: ${method} ${u.pathname}`);
}

function assertBearer(headers) {
  const auth = headers.Authorization || headers.authorization;
  if (!auth) throw new Error('attendu un header Authorization relayé tel quel, absent');
  if (auth !== `Bearer ${AUTH_MARKER}`) throw new Error(`attendu Authorization relayé EXACTEMENT tel que reçu du navigateur, obtenu: ${auth}`);
}

// realFetch — le VRAI fetch natif, réservé aux appels du TEST lui-même
// vers le serveur compose sous test (http://127.0.0.1:<port éphémère>,
// jamais vers Meta ni vers Pandore) : global.fetch ci-dessous est
// remplacé pour intercepter UNIQUEMENT ce que server.js appelle en
// interne.
const realFetch = global.fetch;
const LOCALHOST_PREFIX = 'http://127.0.0.1:';

global.fetch = async (url, opts = {}) => {
  const urlStr = String(url);
  if (urlStr.startsWith(LOCALHOST_PREFIX)) {
    return realFetch(url, opts);
  }
  outboundCalls.push({ url: urlStr, method: (opts && opts.method) || 'GET' });
  if (/facebook\.com|graph\.facebook\.com/i.test(urlStr) && !urlStr.startsWith(process.env.PANDORE_API_BASE)) {
    throw new Error('ÉCHEC DE TEST : tentative d\'appel réseau réel vers Meta: ' + urlStr);
  }
  if (!urlStr.startsWith(process.env.PANDORE_API_BASE)) {
    throw new Error('cible fetch inattendue dans ce test (ni Pandore ni Meta): ' + urlStr);
  }
  return fakePandoreBackend(urlStr, opts);
};

// Chargé APRÈS la mise en place de l'environnement/de l'interception fetch
// ci-dessus (server.js lit process.env.* et utilise `fetch` à l'appel, pas
// au chargement — l'ordre ne compte que pour les env vars, lues au
// chargement du module).
const app = require('../src/server.js');

async function main() {
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const adminHeaders = { 'x-admin-password': process.env.ADMIN_PASSWORD };

  try {
    // --- login proxy (F0.2, déjà établi — vérifié ici pour construire le
    // Bearer utilisé par le reste du test) ---
    let res = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'operator@example.test', password: 'whatever' }),
    });
    assert.strictEqual(res.status, 200, 'login proxy');
    const loginData = await res.json();
    assert.strictEqual(loginData.token, AUTH_MARKER);
    const bearerHeaders = { ...adminHeaders, Authorization: `Bearer ${loginData.token}` };

    // --- generic connection initiation reaches Pandore ---
    res = await fetch(`${base}/api/admin/tenants/t1/platform-connections/facebook/connect`, { method: 'POST', headers: bearerHeaders });
    assert.strictEqual(res.status, 201, 'connect facebook');
    const beginData = await res.json();
    assert.ok(beginData.session_ref, 'session_ref présent');
    // Compose ne construit AUCUNE URL d'autorisation elle-même : la valeur
    // reçue doit être EXACTEMENT celle fournie par le Pandore synthétique
    // (marqueur distinctif), jamais une reconstruction/reformattage.
    assert.strictEqual(beginData.payload.authorization_url, `${AUTHORIZATION_URL_MARKER}&state=${beginData.session_ref}`, 'authorization_url relayée telle quelle, jamais reconstruite');
    const sessionRef = beginData.session_ref;

    // --- relay is platform-name agnostic : un second "platform" arbitraire
    // traverse EXACTEMENT le même code, sans branche spécifique ---
    res = await fetch(`${base}/api/admin/tenants/t1/platform-connections/synthetic-other-platform/connect`, { method: 'POST', headers: bearerHeaders });
    assert.strictEqual(res.status, 201, 'connect via un identifiant de plateforme arbitraire (agnosticisme du relais)');

    // --- generic callback relay forwards to Pandore (GET, contrat Meta réel) ---
    res = await fetch(`${base}/oauth/platforms/facebook/callback?state=${encodeURIComponent(sessionRef)}&code=synthetic-code`);
    assert.strictEqual(res.status, 200, 'callback réussi');
    const callbackHtml = await res.text();
    assert.ok(!callbackHtml.includes(AUTH_MARKER), 'callback ne fuite jamais le Bearer');
    assert.ok(!/app_secret|client_secret/i.test(callbackHtml), 'callback ne fuite jamais un App Secret');

    // --- invalid state rejected ---
    res = await fetch(`${base}/oauth/platforms/facebook/callback?state=never-issued-state&code=x`);
    assert.strictEqual(res.status, 404, 'state inconnu rejeté');

    // --- consumed state rejected (rejouer le MÊME callback déjà traité) ---
    res = await fetch(`${base}/oauth/platforms/facebook/callback?state=${encodeURIComponent(sessionRef)}&code=x`);
    assert.strictEqual(res.status, 409, 'state déjà consommé rejeté');

    // --- callback relay is ALSO platform-name agnostic (POST variant too) ---
    res = await fetch(`${base}/oauth/platforms/synthetic-other-platform/callback?state=totally-unknown&code=x`, { method: 'POST' });
    assert.strictEqual(res.status, 404, 'callback générique fonctionne identiquement pour une plateforme arbitraire');

    // --- resource list through the generic path ---
    res = await fetch(`${base}/api/admin/tenants/t1/platform-connections/facebook/${sessionRef}/resources`, { headers: bearerHeaders });
    assert.strictEqual(res.status, 200, 'liste des ressources');
    const resources = await res.json();
    assert.strictEqual(resources.length, 1);
    assert.strictEqual(resources[0].external_id, 'page-1');

    // --- resource selection reaches the generic Pandore endpoint; SocialAccount
    // materializes ONLY now, never earlier (no auto-connect-all) ---
    res = await fetch(`${base}/api/admin/tenants/t1/platform-connections/facebook/${sessionRef}/select`, {
      method: 'POST', headers: { ...bearerHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ external_id: 'page-1' }),
    });
    assert.strictEqual(res.status, 201, 'sélection de ressource');
    const account = await res.json();
    // toAdminSocialAccountView (déjà établi, réutilisé) traduit le
    // core.SocialAccount PascalCase de Go vers le snake_case attendu.
    assert.strictEqual(account.platform, 'facebook');
    assert.strictEqual(account.external_account_id, 'page-1');
    assert.strictEqual(account.status, 'CONNECTED');

    // --- no auto-connect-all: exactement UN appel /select a été émis pour
    // exactement UNE ressource, jamais un balayage de toutes les ressources
    // découvertes ---
    const selectCalls = outboundCalls.filter((c) => /\/select$/.test(c.url));
    assert.strictEqual(selectCalls.length, 1, 'exactement un appel de sélection, jamais un balayage automatique');

    // --- legacy Meta-specific endpoints are gone ---
    res = await fetch(`${base}/api/admin/social-accounts/meta/authorize-url?tenant_id=t1`, { headers: adminHeaders });
    assert.strictEqual(res.status, 404, 'ancien endpoint authorize-url retiré');
    res = await fetch(`${base}/oauth/meta/callback?code=x&state=y`);
    assert.strictEqual(res.status, 404, 'ancien callback Meta-spécifique retiré');

    // --- compose never called the legacy x-internal-secret social-account
    // callback (POST /admin/social-accounts/oauth-callback) ---
    assert.ok(!outboundCalls.some((c) => c.url.includes('/admin/social-accounts/oauth-callback')), 'aucun appel au callback legacy Go');

    // --- source-level proof: no functional META_* env read remains, no
    // in-memory OAuth state store remains ---
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    assert.ok(!/process\.env\.META_APP_ID/.test(src), 'aucune lecture de META_APP_ID');
    assert.ok(!/process\.env\.META_APP_SECRET/.test(src), 'aucune lecture de META_APP_SECRET');
    assert.ok(!/process\.env\.META_REDIRECT_URI/.test(src), 'aucune lecture de META_REDIRECT_URI');
    assert.ok(!/metaOAuthStates/.test(src), 'aucun store OAuth state en mémoire');
    assert.ok(!/oauth-callback/.test(src), 'aucune référence restante à /admin/social-accounts/oauth-callback');

    console.log('platform-connections.test.js: toutes les assertions ont réussi (' + outboundCalls.length + ' appels sortants interceptés, zéro réseau réel)');
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
