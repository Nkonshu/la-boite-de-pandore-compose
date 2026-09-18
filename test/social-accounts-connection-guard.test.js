// H3-008D1P2 — ACTIVE RESOURCE-SELECTION UX GUARD. Preuve ciblée du
// correctif minimal établi par le diagnostic H3-008D1P1 : la boucle
// observée en production venait d'un second clic réel sur "Connecter
// <plateforme>" pendant qu'une sélection de ressource était déjà active
// pour cette même plateforme — le vrai endpoint de sélection
// (selectResource) n'a jamais été en cause. Ce fichier prouve que, tant
// qu'une sélection de ressource reste active pour une plateforme P donnée,
// aucun second bouton "Connecter P" concurrent ne reste actionnable, sans
// jamais affecter une autre plateforme Q ni jamais bloquer
// définitivement l'écran si la session devient invalide. Deux plateformes
// SYNTHÉTIQUES génériques (jamais "facebook"/"instagram") — même
// discipline que test/platform-integrations-relay.test.js et
// nav.js/admin-navigation.test.js. Même technique vm que
// test/social-accounts-tenant-context.test.js — AUCUN réseau réel.
//
// Usage : node test/social-accounts-connection-guard.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const HTML_PATH = path.join(__dirname, '..', 'public', 'admin', 'social-accounts.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  throw new Error('social-accounts.html: <script> introuvable — le fichier a-t-il changé de structure ?');
}
const scriptSource = scriptMatch[1];
const navSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'nav.js'), 'utf8');

function fakeElement(initial) {
  return Object.assign({
    value: '', style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelectorAll() { return []; }, innerHTML: '', textContent: '',
  }, initial || {});
}
function fakeStorage(seed) {
  const store = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

function runPage({ search, pandoreSession, adminPassword, fetchImpl }) {
  const elements = new Map();
  const calls = [];
  const sandbox = {
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, fakeElement());
        return elements.get(id);
      },
      querySelectorAll: () => [],
      querySelector(sel) {
        if (!elements.has(sel)) elements.set(sel, fakeElement());
        return elements.get(sel);
      },
    },
    location: { search: search || '', href: 'https://pandore-test.example/admin/social-accounts.html' + (search || '') },
    history: { replaceState() {} },
    localStorage: fakeStorage(adminPassword ? { pandore_admin_pw: adminPassword } : { pandore_admin_pw: 'pw' }),
    sessionStorage: fakeStorage(pandoreSession ? { pandore_session: JSON.stringify(pandoreSession) } : {}),
    URL: class {
      constructor(href) { this._href = href; this.searchParams = new URLSearchParams(href.split('?')[1] || ''); }
      toString() { return this._href.split('?')[0] + '?' + this.searchParams.toString(); }
    },
    URLSearchParams,
    console,
    fetch: async (url, opts) => {
      calls.push({ url: String(url), opts: opts || {} });
      return fetchImpl(String(url), opts || {});
    },
  };
  sandbox.window = sandbox;
  sandbox.document.head = { appendChild() {} };
  vm.createContext(sandbox);
  vm.runInContext(navSource, sandbox);
  vm.runInContext(scriptSource, sandbox);
  sandbox.__elements = elements;
  sandbox.__calls = calls;
  return sandbox;
}

function jsonOk(body) { return { ok: true, status: 200, json: async () => body }; }
function jsonErr(status, body) { return { ok: false, status, json: async () => body }; }

const PLATFORM_P = 'synthetic-platform-p';
const PLATFORM_Q = 'synthetic-platform-q';
const BASE_SESSION = { token: 'tok-guard', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } };

function twoSyntheticPlatformsFetch(extra) {
  return async (url, opts) => {
    if (url.includes('/platform-connections/available')) {
      return jsonOk([
        { platform_id: PLATFORM_P, display_name: 'Synthetic P', connection_flow_kind: 'OAUTH_REDIRECT' },
        { platform_id: PLATFORM_Q, display_name: 'Synthetic Q', connection_flow_kind: 'OAUTH_REDIRECT' },
      ]);
    }
    if (url.includes('/api/admin/platform-integrations') && !url.includes('platform-connections')) {
      return jsonOk([
        { platform_id: PLATFORM_P, configured: true, status: 'ACTIVE' },
        { platform_id: PLATFORM_Q, configured: true, status: 'ACTIVE' },
      ]);
    }
    if (extra) {
      const handled = await extra(url, opts);
      if (handled) return handled;
    }
    return jsonOk([]);
  };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- A/C — garde active pour P, Q indépendant ---

test('A/C: active resource selection for P disables only P\'s Connecter button, Q stays fully actionable', async () => {
  const sandbox = runPage({
    search: `?tenant_id=tenant-1&platform=${PLATFORM_P}&session=sess-1`,
    adminPassword: 'pw',
    pandoreSession: BASE_SESSION,
    fetchImpl: twoSyntheticPlatformsFetch(async (url) => {
      if (url.includes('/platform-connections/') && url.includes('/resources')) {
        return jsonOk([{ external_id: 'res-1', display_name: 'Resource One' }]);
      }
      if (url.includes('/api/admin/tenants/tenant-1') && !url.includes('platform')) return jsonOk({ id: 'tenant-1', name: 'Tenant Fixture', version: 1 });
      return null;
    }),
  });
  await sandbox.showDashboard();
  await new Promise((r) => setTimeout(r, 15));

  const buttons = sandbox.__elements.get('platformButtons');
  // P : bouton désactivé, jamais câblé (pas de data-platform), message
  // explicite de garde présent.
  const pButtonMatch = buttons.innerHTML.match(new RegExp(`disabled[^>]*>Connecter Synthetic P<`));
  assert.ok(pButtonMatch, 'attendu le bouton Connecter de P rendu désactivé pendant la sélection active');
  assert.ok(!new RegExp(`data-platform="${PLATFORM_P}"`).test(buttons.innerHTML), 'le bouton de P ne doit jamais porter data-platform (jamais câblé à connectPlatform) pendant la sélection active');
  assert.ok(buttons.innerHTML.includes('Autorisation reçue'), 'attendu le message explicite de garde pour P');

  // Q : bouton normal, actionnable, câblé.
  assert.ok(new RegExp(`data-platform="${PLATFORM_Q}"[^>]*>Connecter Synthetic Q<`).test(buttons.innerHTML) || new RegExp(`>Connecter Synthetic Q</button>`).test(buttons.innerHTML), 'attendu le bouton Connecter de Q rendu normalement, actionnable');
  assert.ok(buttons.innerHTML.includes(`data-platform="${PLATFORM_Q}"`), 'Q doit rester câblé à connectPlatform');
});

// --- B — la sélection de ressource reste actionnable ---

test('B: the resource-selection action (Connecter cette ressource) remains available while P is guarded', async () => {
  const sandbox = runPage({
    search: `?tenant_id=tenant-1&platform=${PLATFORM_P}&session=sess-1`,
    adminPassword: 'pw',
    pandoreSession: BASE_SESSION,
    fetchImpl: twoSyntheticPlatformsFetch(async (url) => {
      if (url.includes('/platform-connections/') && url.includes('/resources')) {
        return jsonOk([{ external_id: 'res-1', display_name: 'Resource One' }]);
      }
      return null;
    }),
  });
  await sandbox.showDashboard();
  await new Promise((r) => setTimeout(r, 15));

  const panel = sandbox.__elements.get('resourceSelectionPanel');
  assert.notStrictEqual(panel.style.display, 'none', 'attendu le panneau de sélection de ressource visible');
  const list = sandbox.__elements.get('resourceList');
  assert.ok(list.innerHTML.includes('Resource One'), 'attendu la ressource découverte affichée');
  assert.ok(list.innerHTML.includes('Connecter cette ressource'), 'attendu l\'action de sélection explicite toujours présente');
  assert.ok(list.innerHTML.includes('data-external-id="res-1"'), 'attendu le bouton de sélection lié à la ressource réelle');
});

// --- D — pas de sélection active : rendu normal ---

test('D: no active selection context restores the normal Connecter button for every platform', async () => {
  const sandbox = runPage({
    search: '?tenant_id=tenant-1',
    adminPassword: 'pw',
    pandoreSession: BASE_SESSION,
    fetchImpl: twoSyntheticPlatformsFetch(),
  });
  await sandbox.showDashboard();
  await new Promise((r) => setTimeout(r, 15));

  const buttons = sandbox.__elements.get('platformButtons');
  assert.ok(buttons.innerHTML.includes(`data-platform="${PLATFORM_P}"`), 'sans sélection active, P doit rester normalement actionnable');
  assert.ok(buttons.innerHTML.includes(`data-platform="${PLATFORM_Q}"`), 'sans sélection active, Q doit rester normalement actionnable');
  assert.ok(!buttons.innerHTML.includes('Autorisation reçue'), 'aucun message de garde ne doit apparaître sans sélection active');
});

// --- E — session invalide/expirée : échec sûr, jamais un verrouillage permanent ---

test('E: an invalid/expired selection session fails safe — the guard lifts and P becomes normally actionable again', async () => {
  const sandbox = runPage({
    search: `?tenant_id=tenant-1&platform=${PLATFORM_P}&session=sess-expired`,
    adminPassword: 'pw',
    pandoreSession: BASE_SESSION,
    fetchImpl: twoSyntheticPlatformsFetch(async (url) => {
      if (url.includes('/platform-connections/') && url.includes('/resources')) {
        return jsonErr(410, { error: { code: 'EXPIRED', message: 'session de connexion expirée' } });
      }
      return null;
    }),
  });
  await sandbox.showDashboard();
  await new Promise((r) => setTimeout(r, 20));

  const buttons = sandbox.__elements.get('platformButtons');
  assert.ok(buttons.innerHTML.includes(`data-platform="${PLATFORM_P}"`), 'attendu P redevenu normalement actionnable après un échec de session (jamais un verrouillage permanent)');
  assert.ok(!buttons.innerHTML.includes('Autorisation reçue'), 'la garde ne doit plus apparaître une fois la session invalide constatée');
  const resourceMsg = sandbox.__elements.get('resourceMsg');
  assert.ok(/expir/i.test(resourceMsg.textContent), 'l\'échec réel doit rester visible à l\'admin, pas seulement silencieusement absorbé');
});

test('E-bis: zero discovered resources also lifts the guard (nothing left to select)', async () => {
  const sandbox = runPage({
    search: `?tenant_id=tenant-1&platform=${PLATFORM_P}&session=sess-empty`,
    adminPassword: 'pw',
    pandoreSession: BASE_SESSION,
    fetchImpl: twoSyntheticPlatformsFetch(async (url) => {
      if (url.includes('/platform-connections/') && url.includes('/resources')) return jsonOk([]);
      return null;
    }),
  });
  await sandbox.showDashboard();
  await new Promise((r) => setTimeout(r, 20));

  const buttons = sandbox.__elements.get('platformButtons');
  assert.ok(buttons.innerHTML.includes(`data-platform="${PLATFORM_P}"`), 'attendu P redevenu actionnable quand aucune ressource n\'a été découverte');
});

// --- post-finalisation ---

test('a successful resource selection clears the guard and restores normal post-connection rendering for P', async () => {
  let selectCalled = false;
  const sandbox = runPage({
    search: `?tenant_id=tenant-1&platform=${PLATFORM_P}&session=sess-1`,
    adminPassword: 'pw',
    pandoreSession: BASE_SESSION,
    fetchImpl: twoSyntheticPlatformsFetch(async (url, opts) => {
      if (url.includes('/platform-connections/') && url.includes('/resources')) {
        return jsonOk([{ external_id: 'res-1', display_name: 'Resource One' }]);
      }
      if (url.includes('/platform-connections/') && url.includes('/select')) {
        selectCalled = true;
        return jsonOk({ id: 'sa-1', tenant_id: 'tenant-1', platform: PLATFORM_P, external_account_id: 'res-1', status: 'CONNECTED' });
      }
      if (url.includes('/social-accounts?')) return jsonOk([]);
      return null;
    }),
  });
  await sandbox.showDashboard();
  await new Promise((r) => setTimeout(r, 15));
  await sandbox.selectResource('tenant-1', PLATFORM_P, 'sess-1', 'res-1');
  await new Promise((r) => setTimeout(r, 15));

  assert.ok(selectCalled, 'attendu un appel réel à l\'endpoint de sélection');
  const buttons = sandbox.__elements.get('platformButtons');
  assert.ok(buttons.innerHTML.includes(`data-platform="${PLATFORM_P}"`), 'attendu P redevenu normalement actionnable après une sélection finalisée avec succès');
  assert.ok(!buttons.innerHTML.includes('Autorisation reçue'), 'la garde doit disparaître après finalisation');
});

// --- F — aucune branche spécifique à une plateforme précise ---

test('F: the guard logic contains no platform-specific branch (no "facebook"/"instagram"/... reference in executable code)', () => {
  const codeOnly = scriptSource.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  const platformNames = ['facebook', 'instagram', 'linkedin', 'tiktok', 'youtube', 'whatsapp', 'pinterest', 'snapchat', 'telegram'];
  for (const name of platformNames) {
    assert.ok(!new RegExp(name, 'i').test(codeOnly), `social-accounts.html référence la plateforme "${name}" dans son code exécutable — la garde doit rester générique`);
  }
});

test('F-bis: platformReadiness treats the active-selection platform generically, by ID comparison only', () => {
  const sandbox = runPage({ search: '', fetchImpl: async () => jsonOk([]) });
  const guarded = sandbox.platformReadiness(PLATFORM_P, { [PLATFORM_P]: { configured: true, status: 'ACTIVE' } }, PLATFORM_P);
  assert.strictEqual(guarded.ready, false, 'attendu non-actionnable pour la plateforme en sélection active, même si Level A est par ailleurs prête');
  const unaffected = sandbox.platformReadiness(PLATFORM_Q, { [PLATFORM_Q]: { configured: true, status: 'ACTIVE' } }, PLATFORM_P);
  assert.strictEqual(unaffected.ready, true, 'attendu une autre plateforme non affectée par la garde');
  const noSelection = sandbox.platformReadiness(PLATFORM_P, { [PLATFORM_P]: { configured: true, status: 'ACTIVE' } }, null);
  assert.strictEqual(noSelection.ready, true, 'sans sélection active (null), la même plateforme redevient normalement actionnable');
});

async function main() {
  let passed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`PASS - ${t.name}`); passed++; }
    catch (err) { console.error(`FAIL - ${t.name}`); console.error(err); process.exitCode = 1; }
  }
  console.log(`${passed}/${tests.length} test(s) passés.`);
  if (passed !== tests.length) process.exitCode = 1;
}
main();
