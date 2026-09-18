// H3-008D1M §5/§6/§10 — preuve que le contexte tenant se résout
// AUTOMATIQUEMENT à l'arrivée (aucun clic "Charger" nécessaire) et que
// l'identité MÉTIER du client est affichée en priorité. Extrait le
// <script> inline de public/admin/social-accounts.html (même technique
// vm que les autres tests de ce dépôt) avec un `fetch` et un
// `sessionStorage` simulés — AUCUN réseau réel, AUCUNE valeur Meta.
//
// Usage : node test/social-accounts-tenant-context.test.js
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

// runPage — construit un contexte frais par test. `search` pilote
// location.search (simulant l'arrivée via un lien tenant_id=...).
// `pandoreSession` pré-remplit sessionStorage (simulant "déjà connecté à
// Pandore dans cet onglet", exactement le scénario du bug rapporté :
// naviguer vers un NOUVEAU tenant alors qu'une session Pandore existe
// déjà). `fetchImpl` reçoit chaque appel réseau simulé.
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
    localStorage: fakeStorage(adminPassword ? { pandore_admin_pw: adminPassword } : {}),
    sessionStorage: fakeStorage(pandoreSession ? { pandore_session: JSON.stringify(pandoreSession) } : {}),
    URL: class {
      constructor(href) { this._href = href; this.searchParams = new URLSearchParams(href.split('?')[1] || ''); }
      toString() { return this._href.split('?')[0] + '?' + this.searchParams.toString(); }
    },
    URLSearchParams,
    console,
    fetch: async (url, opts) => {
      calls.push({ url: String(url), opts });
      return fetchImpl(String(url), opts || {});
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(scriptSource, sandbox);
  sandbox.__elements = elements;
  sandbox.__calls = calls;
  return sandbox;
}

function jsonOk(body) { return { ok: true, status: 200, json: async () => body }; }

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('arriving with tenant_id + an already-active Pandore session auto-loads platforms WITHOUT a Charger click', async () => {
  const sandbox = runPage({
    search: '?tenant_id=tenant-chapchap&client_name=Chap%20Chap',
    adminPassword: 'pw',
    pandoreSession: { token: 'tok-123', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } },
    fetchImpl: async (url) => {
      if (url.includes('/platform-connections/available')) return jsonOk([{ platform_id: 'facebook', display_name: 'Facebook', connection_flow_kind: 'OAUTH_REDIRECT' }]);
      if (url.includes('/social-accounts?')) return jsonOk([]);
      if (url.includes('/api/admin/tenants/tenant-chapchap')) return jsonOk({ id: 'tenant-chapchap', name: 'Chap Chap' });
      return jsonOk({});
    },
  });
  await sandbox.showDashboard();
  // Laisse les promesses internes (fetch async) se résoudre.
  await new Promise((r) => setTimeout(r, 10));

  const platformCall = sandbox.__calls.find((c) => c.url.includes('/platform-connections/available'));
  assert.ok(platformCall, 'attendu un appel automatique à la liste des plateformes, sans clic Charger');
  assert.ok(platformCall.url.includes('tenant-chapchap'), 'attendu le BON tenant_id (celui de l\'URL, pas un tenant précédent)');
});

test('the business name is shown as the primary heading, from the query-string fallback immediately, then confirmed by Pandore', async () => {
  const sandbox = runPage({
    search: '?tenant_id=tenant-chapchap&client_name=Chap%20Chap',
    adminPassword: 'pw',
    pandoreSession: { token: 'tok-123', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } },
    fetchImpl: async (url) => {
      if (url.includes('/api/admin/tenants/tenant-chapchap')) return jsonOk({ id: 'tenant-chapchap', name: 'Chap Chap (confirmé)' });
      return jsonOk([]);
    },
  });
  await sandbox.showDashboard();
  const heading = sandbox.__elements.get('clientNameHeading');
  assert.strictEqual(heading.textContent, 'Chap Chap', 'attendu le nom métier affiché immédiatement (repli query string), jamais le tenant_id en premier');
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(heading.textContent, 'Chap Chap (confirmé)', 'attendu le nom résolu de façon AUTORITAIRE par Pandore, remplaçant le repli');
});

test('arriving without tenant_id shows a client search bar instead of a raw tenant_id field as the primary control', async () => {
  const sandbox = runPage({
    search: '',
    adminPassword: 'pw',
    pandoreSession: { token: 'tok-123', user: { email: 'admin@example.test', role: 'PANDORE_SUPER_ADMIN' } },
    fetchImpl: async (url) => {
      if (url === 'https://pandore-test.example/api/admin/tenants' || /\/api\/admin\/tenants$/.test(url)) {
        return jsonOk([{ id: 't1', name: 'Chap Chap' }, { id: 't2', name: 'Autre Client' }]);
      }
      return jsonOk([]);
    },
  });
  await sandbox.showDashboard();
  await new Promise((r) => setTimeout(r, 10));
  const searchBar = sandbox.__elements.get('tenantSearchBar');
  assert.notStrictEqual(searchBar.style.display, 'none', 'attendu la barre de recherche client visible sans contexte tenant');
  const heading = sandbox.__elements.get('clientNameHeading');
  assert.strictEqual(heading.textContent, 'Comptes sociaux');
});

test('selecting a tenant from search navigates with tenant_id AND client_name, the same generic path as an incoming link', () => {
  const sandbox = runPage({ search: '', fetchImpl: async () => jsonOk([]) });
  sandbox.selectTenantFromSearch('tenant-xyz', 'Autre Client');
  assert.ok(sandbox.location.href.includes('tenant_id=tenant-xyz'));
  assert.ok(sandbox.location.href.includes('client_name=Autre'));
});

// --- H3-008D1M1 §5 — fermeture du parcours réel : Audit approuvé →
// "Gérer les comptes sociaux" → Comptes sociaux aboutit DIRECTEMENT à un
// tenant résolu, un nom métier affiché, les plateformes chargées, et
// Facebook affiché PRÊT (Level A CONFIGURED+ACTIVE) — sans aucun clic
// "Charger", sans jamais devoir copier/coller un tenant_id. Une seule
// preuve intégrée couvrant TOUTES ces assertions à la fois, exactement le
// parcours décrit par le Product Owner. ---
test('CLOSURE: approved-audit link -> Comptes sociaux resolves tenant, shows business name, loads platforms, and shows Facebook as ready — zero Charger click, zero tenant_id to copy/paste', async () => {
  const sandbox = runPage({
    // Reproduit EXACTEMENT le lien construit par audit-review.html après
    // H3-008D1M : tenant_id + client_name, jamais un tenant_id seul à
    // copier/coller.
    search: '?tenant_id=tenant-chapchap&client_name=Chap%20Chap',
    adminPassword: 'pw',
    pandoreSession: { token: 'tok-closure', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } },
    fetchImpl: async (url) => {
      if (url.includes('/platform-connections/available')) return jsonOk([{ platform_id: 'facebook', display_name: 'Facebook' }]);
      if (url.includes('/api/admin/platform-integrations') && !url.includes('platform-connections')) {
        return jsonOk([{ platform_id: 'facebook', configured: true, status: 'ACTIVE' }]);
      }
      if (url.includes('/social-accounts?')) return jsonOk([]);
      if (url.includes('/api/admin/tenants/tenant-chapchap')) return jsonOk({ id: 'tenant-chapchap', name: 'Chap Chap' });
      return jsonOk([]);
    },
  });

  await sandbox.showDashboard();
  await new Promise((r) => setTimeout(r, 15));

  // 1. tenant résolu (le bon tenant_id a bien servi à charger les comptes
  //    ET les plateformes, jamais un tenant précédent/vide).
  const accountsCall = sandbox.__calls.find((c) => c.url.includes('/social-accounts?tenant_id=tenant-chapchap'));
  const platformsCall = sandbox.__calls.find((c) => c.url.includes('/platform-connections/available'));
  assert.ok(accountsCall, 'attendu le chargement automatique des comptes pour le bon tenant');
  assert.ok(platformsCall && platformsCall.url.includes('tenant-chapchap'), 'attendu le chargement automatique des plateformes pour le bon tenant');

  // 2. nom métier affiché (jamais le tenant_id en premier).
  const heading = sandbox.__elements.get('clientNameHeading');
  assert.strictEqual(heading.textContent, 'Chap Chap');

  // 3. Facebook affiché PRÊT (Level A CONFIGURED + ACTIVE) — bouton
  //    Connecter cliquable, jamais désactivé.
  const platformButtons = sandbox.__elements.get('platformButtons');
  assert.ok(platformButtons.innerHTML.includes('Connecter Facebook'));
  assert.ok(!platformButtons.innerHTML.includes('disabled'), 'attendu un bouton Connecter ACTIF, la config Level A étant CONFIGURED+ACTIVE');

  // 4. aucun clic "Charger" requis : le seul appel jamais émis vers
  //    loadTenantBtn dans ce test est... aucun — nous n'avons simulé
  //    AUCUN clic, uniquement showDashboard(). Les assertions 1-3
  //    ci-dessus prouvent déjà que tout s'est chargé sans lui.

  // 5. aucun tenant_id à copier/coller : la zone technique (<details>,
  //    jamais un <input> visible en tête de page) n'est ni ouverte par
  //    défaut dans le markup, ni forcée ouverte par le JS (aucun code ne
  //    référence advancedTenantBar — vérifié structurellement).
  const src = fs.readFileSync(HTML_PATH, 'utf8');
  assert.ok(/<details class="tenant-bar" id="advancedTenantBar">/.test(src), 'attendu un <details> fermé par défaut (aucun attribut "open")');
  const scriptOnly = src.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.ok(!scriptOnly.includes('advancedTenantBar'), 'attendu qu’aucun code JS ne force l’ouverture de la zone avancée');
});

// --- H3-008D1M §7 — readiness gating: PLATFORM_CAPABILITY (registered
// adapter) is never conflated with Level-A CONFIGURED/ACTIVE. ---

test('platformReadiness: unconfigured Level-A -> not ready, with an explicit explanatory reason', () => {
  const sandbox = runPage({ search: '', fetchImpl: async () => jsonOk([]) });
  const result = sandbox.platformReadiness('facebook', {});
  assert.strictEqual(result.ready, false);
  assert.ok(result.reason.length > 0);
});

test('platformReadiness: DISABLED Level-A -> not ready, distinct reason from unconfigured', () => {
  const sandbox = runPage({ search: '', fetchImpl: async () => jsonOk([]) });
  const disabled = sandbox.platformReadiness('facebook', { facebook: { configured: true, status: 'DISABLED' } });
  const unconfigured = sandbox.platformReadiness('facebook', {});
  assert.strictEqual(disabled.ready, false);
  assert.notStrictEqual(disabled.reason, unconfigured.reason, 'attendu des messages distincts: CONFIGURED et ACTIVE ne sont jamais synonymes');
});

test('platformReadiness: configured AND ACTIVE -> ready, Connecter action available', () => {
  const sandbox = runPage({ search: '', fetchImpl: async () => jsonOk([]) });
  const result = sandbox.platformReadiness('facebook', { facebook: { configured: true, status: 'ACTIVE' } });
  assert.strictEqual(result.ready, true);
});

test('loadPlatformButtons renders a disabled Connecter button with an explanation when Level-A is not ready, never a clickable action', async () => {
  const sandbox = runPage({
    search: '?tenant_id=t1',
    adminPassword: 'pw',
    pandoreSession: { token: 'tok', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } },
    fetchImpl: async (url) => {
      if (url.includes('/platform-connections/available')) return jsonOk([{ platform_id: 'facebook', display_name: 'Facebook' }]);
      if (url.includes('/api/admin/platform-integrations') && !url.includes('platform-connections')) return jsonOk([{ platform_id: 'facebook', configured: false }]);
      return jsonOk([]);
    },
  });
  await sandbox.showDashboard();
  await new Promise((r) => setTimeout(r, 10));
  const container = sandbox.__elements.get('platformButtons');
  assert.ok(container.innerHTML.includes('disabled'), 'attendu un bouton désactivé, jamais une action Connecter cliquable sans configuration Level A');
  assert.ok(container.innerHTML.includes('Configuration Level A manquante'));
});

test('secret-safety: this file never reads or writes a platform SECRET value to localStorage/sessionStorage (only the admin password and the Pandore Bearer session, an already-accepted distinct mechanism)', () => {
  const src = fs.readFileSync(HTML_PATH, 'utf8');
  const scriptOnly = src.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.ok(!/localStorage\.(setItem|getItem)\([^)]*secret/i.test(scriptOnly));
  assert.ok(!/sessionStorage\.(setItem|getItem)\([^)]*app_secret/i.test(scriptOnly));
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
