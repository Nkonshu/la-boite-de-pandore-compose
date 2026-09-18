// H3-008D1O1B §4/§9 — preuve ciblée sur l'affordance de renommage ajoutée
// à social-accounts.html : utilise la version courante résolue, envoie
// expected_version, consomme la version RENVOYÉE après succès, surface un
// conflit CAS sans jamais réappliquer automatiquement, préserve Tenant.ID,
// et met à jour l'identité affichée (heading + fil d'Ariane) après un
// renommage réussi. Même technique vm que
// test/social-accounts-tenant-context.test.js — AUCUN réseau réel.
//
// Usage : node test/social-accounts-rename-ui.test.js
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

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const BASE_SESSION = { token: 'tok-rename', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } };

test('the identity panel shows the current Tenant.Name resolved from Pandore, and becomes visible once a tenant context is resolved', async () => {
  const sandbox = runPage({
    search: '?tenant_id=tenant-1',
    adminPassword: 'pw',
    pandoreSession: BASE_SESSION,
    fetchImpl: async (url) => {
      if (url.includes('/api/admin/tenants/tenant-1') && !url.includes('platform')) return jsonOk({ id: 'tenant-1', name: 'Guy', version: 3 });
      return jsonOk([]);
    },
  });
  await sandbox.showDashboard();
  await new Promise((r) => setTimeout(r, 10));
  const panel = sandbox.__elements.get('identityPanel');
  assert.notStrictEqual(panel.style.display, 'none', 'attendu le panneau d\'identité visible une fois le tenant résolu');
  const nameEl = sandbox.__elements.get('identityCurrentName');
  assert.strictEqual(nameEl.textContent, 'Guy');
});

// Note : currentTenantVersion est une variable top-level `let` du script de
// la page — jamais exposée comme propriété globale du sandbox vm (sémantique
// JS standard : seules les déclarations `var`/fonction le sont). Sa capture
// correcte est prouvée UNIQUEMENT par effet observable : le body envoyé au
// PUT suivant (voir les tests ci-dessous), jamais par une lecture directe.

test('saving a rename sends expected_version and the newly confirmed name through the generic PUT relay', async () => {
  const putCalls = [];
  const sandbox = runPage({
    search: '?tenant_id=tenant-1',
    adminPassword: 'pw',
    pandoreSession: BASE_SESSION,
    fetchImpl: async (url, opts) => {
      if (url.includes('/api/admin/tenants/tenant-1') && (!opts.method || opts.method === 'GET')) return jsonOk({ id: 'tenant-1', name: 'Guy', version: 3 });
      if (url.includes('/api/admin/tenants/tenant-1') && opts.method === 'PUT') {
        putCalls.push(JSON.parse(opts.body));
        return jsonOk({ id: 'tenant-1', name: 'Chap Chap', version: 4 });
      }
      return jsonOk([]);
    },
  });
  await sandbox.showDashboard();
  await new Promise((r) => setTimeout(r, 10));
  sandbox.document.getElementById('identityNameInput').value = 'Chap Chap';
  await sandbox.saveIdentity();

  assert.strictEqual(putCalls.length, 1, 'attendu exactement un appel PUT');
  assert.strictEqual(putCalls[0].name, 'Chap Chap');
  assert.strictEqual(putCalls[0].expected_version, 3, 'attendu la version COURANTE résolue envoyée, jamais une valeur devinée');
});

test('a successful rename replaces the local version with the one returned by the backend, never a client-side increment', async () => {
  const putBodies = [];
  const sandbox = runPage({
    search: '?tenant_id=tenant-1',
    adminPassword: 'pw',
    pandoreSession: BASE_SESSION,
    fetchImpl: async (url, opts) => {
      if (url.includes('/api/admin/tenants/tenant-1') && (!opts.method || opts.method === 'GET')) return jsonOk({ id: 'tenant-1', name: 'Guy', version: 3 });
      if (url.includes('/api/admin/tenants/tenant-1') && opts.method === 'PUT') {
        const body = JSON.parse(opts.body);
        putBodies.push(body);
        // Renvoie une version qui saute délibérément loin de 3+1=4, pour
        // distinguer sans ambiguïté "consomme la version renvoyée" de
        // "incrémente localement" au deuxième appel ci-dessous.
        return jsonOk({ id: 'tenant-1', name: 'Chap Chap', version: 9 });
      }
      return jsonOk([]);
    },
  });
  await sandbox.showDashboard();
  await new Promise((r) => setTimeout(r, 10));
  sandbox.document.getElementById('identityNameInput').value = 'Chap Chap';
  await sandbox.saveIdentity();

  // Second renommage : si la version locale avait été incrémentée à la
  // main (3+1=4) plutôt que remplacée par la valeur renvoyée (9), ce
  // deuxième appel enverrait expected_version=4, jamais 9.
  sandbox.document.getElementById('identityNameInput').value = 'Chap Chap Encore';
  await sandbox.saveIdentity();

  assert.strictEqual(putBodies.length, 2);
  assert.strictEqual(putBodies[1].expected_version, 9, 'attendu la version RENVOYÉE par le backend consommée telle quelle (jamais 3+1=4)');
});

test('a successful rename updates the displayed heading and breadcrumb business identity', async () => {
  const sandbox = runPage({
    search: '?tenant_id=tenant-1',
    adminPassword: 'pw',
    pandoreSession: BASE_SESSION,
    fetchImpl: async (url, opts) => {
      if (url.includes('/api/admin/tenants/tenant-1') && (!opts.method || opts.method === 'GET')) return jsonOk({ id: 'tenant-1', name: 'Guy', version: 3 });
      if (url.includes('/api/admin/tenants/tenant-1') && opts.method === 'PUT') return jsonOk({ id: 'tenant-1', name: 'Chap Chap', version: 4 });
      return jsonOk([]);
    },
  });
  await sandbox.showDashboard();
  await new Promise((r) => setTimeout(r, 10));
  sandbox.document.getElementById('identityNameInput').value = 'Chap Chap';
  await sandbox.saveIdentity();

  assert.strictEqual(sandbox.__elements.get('clientNameHeading').textContent, 'Chap Chap');
  assert.strictEqual(sandbox.__elements.get('identityCurrentName').textContent, 'Chap Chap');
});

test('a CAS conflict (409) is surfaced explicitly and is NEVER automatically retried', async () => {
  let putAttempts = 0;
  const sandbox = runPage({
    search: '?tenant_id=tenant-1',
    adminPassword: 'pw',
    pandoreSession: BASE_SESSION,
    fetchImpl: async (url, opts) => {
      if (url.includes('/api/admin/tenants/tenant-1') && (!opts.method || opts.method === 'GET')) return jsonOk({ id: 'tenant-1', name: 'Guy', version: 3 });
      if (url.includes('/api/admin/tenants/tenant-1') && opts.method === 'PUT') {
        putAttempts++;
        return jsonErr(409, { error: { code: 'CONFLICT', message: 'version obsolète — rechargez le tenant courant' } });
      }
      return jsonOk([]);
    },
  });
  await sandbox.showDashboard();
  await new Promise((r) => setTimeout(r, 10));
  sandbox.document.getElementById('identityNameInput').value = 'Chap Chap';
  await sandbox.saveIdentity();
  await new Promise((r) => setTimeout(r, 10));

  assert.strictEqual(putAttempts, 1, 'un conflit ne doit JAMAIS déclencher un nouvel essai automatique');
  const msg = sandbox.__elements.get('identityMsg');
  assert.ok(/conflit/i.test(msg.textContent), 'attendu un message de conflit explicite');
  assert.strictEqual(msg.className, 'msg err', 'attendu un message d\'erreur visible, jamais un succès silencieux');
});

test('after a CAS conflict, the panel reloads the real current state instead of silently overwriting it', async () => {
  let getCount = 0;
  const putBodies = [];
  const sandbox = runPage({
    search: '?tenant_id=tenant-1',
    adminPassword: 'pw',
    pandoreSession: BASE_SESSION,
    fetchImpl: async (url, opts) => {
      if (url.includes('/api/admin/tenants/tenant-1') && (!opts.method || opts.method === 'GET')) {
        getCount++;
        return jsonOk({ id: 'tenant-1', name: getCount === 1 ? 'Guy' : 'Nom Changé Ailleurs', version: getCount === 1 ? 3 : 5 });
      }
      if (url.includes('/api/admin/tenants/tenant-1') && opts.method === 'PUT') {
        const body = JSON.parse(opts.body);
        putBodies.push(body);
        if (putBodies.length === 1) return jsonErr(409, { error: { code: 'CONFLICT', message: 'version obsolète' } });
        return jsonOk({ id: 'tenant-1', name: body.name, version: 6 });
      }
      return jsonOk([]);
    },
  });
  await sandbox.showDashboard();
  await new Promise((r) => setTimeout(r, 10));
  sandbox.document.getElementById('identityNameInput').value = 'Ma Tentative';
  await sandbox.saveIdentity();
  await new Promise((r) => setTimeout(r, 10));

  // Effet observable du rechargement post-conflit : le nom RÉEL (jamais
  // "Ma Tentative") est ré-affiché après le 409.
  assert.strictEqual(sandbox.__elements.get('identityCurrentName').textContent, 'Nom Changé Ailleurs', 'attendu le nom RÉEL rechargé, jamais "Ma Tentative" appliqué silencieusement');

  // Un second essai explicite de l'admin doit envoyer la version RECHARGÉE
  // (5), jamais l'ancienne (3) qui a provoqué le premier conflit.
  sandbox.document.getElementById('identityNameInput').value = 'Chap Chap';
  await sandbox.saveIdentity();
  assert.strictEqual(putBodies.length, 2);
  assert.strictEqual(putBodies[1].expected_version, 5, 'attendu la version rechargée après conflit envoyée au second essai, jamais l\'ancienne version périmée');
});

test('Tenant.ID is never altered by a rename (the URL path stays the same tenant id throughout)', async () => {
  const sandbox = runPage({
    search: '?tenant_id=tenant-1',
    adminPassword: 'pw',
    pandoreSession: BASE_SESSION,
    fetchImpl: async (url, opts) => {
      if (url.includes('/api/admin/tenants/tenant-1') && (!opts.method || opts.method === 'GET')) return jsonOk({ id: 'tenant-1', name: 'Guy', version: 3 });
      if (url.includes('/api/admin/tenants/tenant-1') && opts.method === 'PUT') return jsonOk({ id: 'tenant-1', name: 'Chap Chap', version: 4 });
      return jsonOk([]);
    },
  });
  await sandbox.showDashboard();
  await new Promise((r) => setTimeout(r, 10));
  sandbox.document.getElementById('identityNameInput').value = 'Chap Chap';
  await sandbox.saveIdentity();

  const putCall = sandbox.__calls.find((c) => c.opts && c.opts.method === 'PUT');
  assert.ok(putCall.url.includes('/tenant-1'), 'attendu le même tenant_id dans l\'URL du PUT, jamais un nouvel identifiant');
});

test('a rename attempt with an empty name is rejected client-side before any network call', async () => {
  const sandbox = runPage({
    search: '?tenant_id=tenant-1',
    adminPassword: 'pw',
    pandoreSession: BASE_SESSION,
    fetchImpl: async (url, opts) => {
      if (url.includes('/api/admin/tenants/tenant-1') && (!opts.method || opts.method === 'GET')) return jsonOk({ id: 'tenant-1', name: 'Guy', version: 3 });
      return jsonOk([]);
    },
  });
  await sandbox.showDashboard();
  await new Promise((r) => setTimeout(r, 10));
  const before = sandbox.__calls.length;
  sandbox.document.getElementById('identityNameInput').value = '   ';
  await sandbox.saveIdentity();
  assert.strictEqual(sandbox.__calls.length, before, 'aucun appel réseau ne doit partir pour un nom vide/blanc');
  const msg = sandbox.__elements.get('identityMsg');
  assert.ok(/requis/i.test(msg.textContent));
});

test('the identity panel fits the established navigation hierarchy: still under the clients zone, business name in the breadcrumb', async () => {
  const sandbox = runPage({
    search: '?tenant_id=tenant-1',
    adminPassword: 'pw',
    pandoreSession: BASE_SESSION,
    fetchImpl: async (url, opts) => {
      if (url.includes('/api/admin/tenants/tenant-1') && (!opts.method || opts.method === 'GET')) return jsonOk({ id: 'tenant-1', name: 'Guy', version: 3 });
      if (url.includes('/api/admin/tenants/tenant-1') && opts.method === 'PUT') return jsonOk({ id: 'tenant-1', name: 'Chap Chap', version: 4 });
      return jsonOk([]);
    },
  });
  await sandbox.showDashboard();
  await new Promise((r) => setTimeout(r, 10));
  sandbox.document.getElementById('identityNameInput').value = 'Chap Chap';
  await sandbox.saveIdentity();

  const nav = sandbox.__elements.get('adminNav');
  assert.ok(nav.innerHTML.includes('Clients &amp; Prospects'), 'attendu la zone Clients & Prospects toujours active');
  assert.ok(nav.innerHTML.includes('Chap Chap'), 'attendu le nom métier renommé reflété dans le fil d\'Ariane');
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
