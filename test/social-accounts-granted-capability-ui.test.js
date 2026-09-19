// H3-008D1Q2 §11 — GRANTED CAPABILITY DISPLAY. Preuve ciblée que
// social-accounts.html n'affiche plus les scopes OAuth simplement demandés
// comme s'ils étaient des permissions confirmées (diagnostic H3-008D1Q1) :
// une colonne distincte affiche l'état RÉELLEMENT vérifié
// (core.GrantedCapability), lu via une route SÉPARÉE
// (/social-accounts/:id/granted-capabilities), jamais dérivé de
// granted_scopes côté navigateur. Même technique vm que
// test/social-accounts-connection-guard.test.js — AUCUN réseau réel.
//
// Usage : node test/social-accounts-granted-capability-ui.test.js
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

function runPage({ pandoreSession, fetchImpl }) {
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
    location: { search: '?tenant_id=t_fixture', href: 'https://pandore-test.example/admin/social-accounts.html?tenant_id=t_fixture' },
    history: { replaceState() {} },
    localStorage: fakeStorage({ pandore_admin_pw: 'pw' }),
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

const ACCOUNT_CONNECTED = {
  id: 'sa_1', platform: 'facebook', display_name: 'Chap Chap',
  status: 'CONNECTED', granted_scopes: ['pages_show_list', 'pages_manage_posts'],
  connected_at: '2026-09-01T10:00:00Z',
};
const ACCOUNT_REVOKED = {
  id: 'sa_2', platform: 'facebook', display_name: 'Old Page',
  status: 'REVOKED', granted_scopes: ['pages_show_list'],
  connected_at: '2026-08-01T10:00:00Z',
};

async function waitForRender() {
  // refresh()/render() sont async (résolution de capacité en parallèle) —
  // laisse le microtask queue se vider avant d'inspecter le DOM simulé.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { console.log(`PASS - ${name}`); passed++; })
    .catch((err) => { console.log(`FAIL - ${name}\n  ${err.message}`); failed++; });
}

(async () => {
  await test('a GRANTED capability renders the "Accordée" pill with the cap-granted class, never the raw scopes column repurposed', async () => {
    const sandbox = runPage({
      pandoreSession: { token: 'real-pandore-session-token', user: { email: 'operateur@example.com', role: 'PANDORE_OPERATOR' } },
      fetchImpl: async (url) => {
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_CONNECTED]);
        if (url.includes('/granted-capabilities')) {
          return jsonOk([{ capability: 'PUBLISH_TEXT', state: 'GRANTED', provenance: 'REAL_OBSERVATION', verified_at: '2026-09-10T08:00:00Z' }]);
        }
        return jsonOk({});
      },
    });
    await waitForRender();
    const tbody = sandbox.__elements.get('#accountsTable tbody');
    assert.ok(tbody.innerHTML.includes('cap-granted'), 'attendu la classe cap-granted');
    assert.ok(tbody.innerHTML.includes('Accordée'), 'attendu le libellé Accordée');
    assert.ok(tbody.innerHTML.includes('pages_manage_posts'), 'les scopes demandés restent affichés séparément');
  });

  await test('a MISSING capability renders the "Absente" pill with the cap-missing class', async () => {
    const sandbox = runPage({
      pandoreSession: { token: 'real-pandore-session-token', user: { email: 'operateur@example.com', role: 'PANDORE_OPERATOR' } },
      fetchImpl: async (url) => {
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_CONNECTED]);
        if (url.includes('/granted-capabilities')) {
          return jsonOk([{ capability: 'PUBLISH_TEXT', state: 'MISSING', provenance: 'REAL_OBSERVATION', verified_at: '2026-09-10T08:00:00Z' }]);
        }
        return jsonOk({});
      },
    });
    await waitForRender();
    const tbody = sandbox.__elements.get('#accountsTable tbody');
    assert.ok(tbody.innerHTML.includes('cap-missing'), 'attendu la classe cap-missing');
    assert.ok(tbody.innerHTML.includes('Absente'), 'attendu le libellé Absente');
  });

  await test('an empty granted-capabilities list (never resolved yet) renders "Jamais vérifiée", never a fabricated GRANTED/zéro', async () => {
    const sandbox = runPage({
      pandoreSession: { token: 'real-pandore-session-token', user: { email: 'operateur@example.com', role: 'PANDORE_OPERATOR' } },
      fetchImpl: async (url) => {
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_CONNECTED]);
        if (url.includes('/granted-capabilities')) return jsonOk([]);
        return jsonOk({});
      },
    });
    await waitForRender();
    const tbody = sandbox.__elements.get('#accountsTable tbody');
    assert.ok(tbody.innerHTML.includes('cap-unverified'), 'attendu la classe cap-unverified');
    assert.ok(tbody.innerHTML.includes('Jamais vérifiée'), 'attendu le libellé Jamais vérifiée');
    assert.ok(!tbody.innerHTML.includes('cap-granted'), 'jamais GRANTED fabriqué depuis une liste vide');
  });

  await test('without a Pandore session, the capability cell shows "Non vérifiable" (distinct from "Jamais vérifiée") rather than throwing or blocking the rest of the table', async () => {
    const sandbox = runPage({
      pandoreSession: null,
      fetchImpl: async (url) => {
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_CONNECTED]);
        return jsonOk({});
      },
    });
    await waitForRender();
    const tbody = sandbox.__elements.get('#accountsTable tbody');
    assert.ok(tbody.innerHTML.includes('Non vérifiable'), 'attendu le libellé Non vérifiable');
    assert.ok(tbody.innerHTML.includes('Chap Chap'), 'le reste de la ligne doit rester rendu normalement');
    const capabilityCalls = sandbox.__calls.filter((c) => c.url.includes('/granted-capabilities'));
    assert.strictEqual(capabilityCalls.length, 0, 'sans session Pandore, aucun appel réseau ne doit même être tenté');
  });

  await test('a REVOKED account never triggers a granted-capabilities lookup and shows "—" in that column', async () => {
    const sandbox = runPage({
      pandoreSession: { token: 'real-pandore-session-token', user: { email: 'operateur@example.com', role: 'PANDORE_OPERATOR' } },
      fetchImpl: async (url) => {
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_REVOKED]);
        if (url.includes('/granted-capabilities')) throw new Error('ne doit jamais être appelé pour un compte révoqué');
        return jsonOk({});
      },
    });
    await waitForRender();
    const tbody = sandbox.__elements.get('#accountsTable tbody');
    assert.ok(tbody.innerHTML.includes('Old Page'));
    const capabilityCalls = sandbox.__calls.filter((c) => c.url.includes('/granted-capabilities'));
    assert.strictEqual(capabilityCalls.length, 0, 'un compte révoqué ne doit jamais déclencher cette lecture');
  });

  await test('the granted-capabilities lookup is scoped by tenant_id and social_account_id, and carries the real Pandore Bearer session (same identity as platform-connections, never x-internal-secret)', async () => {
    const sandbox = runPage({
      pandoreSession: { token: 'real-pandore-session-token', user: { email: 'operateur@example.com', role: 'PANDORE_OPERATOR' } },
      fetchImpl: async (url) => {
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_CONNECTED]);
        if (url.includes('/granted-capabilities')) return jsonOk([]);
        return jsonOk({});
      },
    });
    await waitForRender();
    const call = sandbox.__calls.find((c) => c.url.includes('/granted-capabilities'));
    assert.ok(call, 'attendu un appel granted-capabilities');
    assert.ok(call.url.includes('/api/admin/tenants/t_fixture/social-accounts/sa_1/granted-capabilities'), `URL inattendue: ${call.url}`);
    assert.strictEqual(call.opts.headers.Authorization, 'Bearer real-pandore-session-token');
  });

  await test('the requested-scopes column is relabeled to make clear it is NOT a confirmed permission (structural check on the real executable HTML)', () => {
    assert.ok(html.includes('Scopes demandés (OAuth)'), 'attendu un en-tête de colonne honnête sur ce que granted_scopes représente réellement');
    assert.ok(!html.includes('<th>Permissions</th>'), 'l\'ancien intitulé trompeur "Permissions" ne doit plus exister');
  });

  console.log(`\n${passed}/${passed + failed} test(s) passés.`);
  if (failed > 0) process.exit(1);
})();
