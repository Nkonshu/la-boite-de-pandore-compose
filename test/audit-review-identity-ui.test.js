// H3-008D1O1B §1/§2/§3/§9 — preuve ciblée sur audit-review.html : Contact
// et Client identity rendus SÉPARÉMENT depuis les champs sémantiques
// backend explicites, le champ Tenant.Name n'est JAMAIS pré-rempli depuis
// le contact ni depuis un ancien champ générique "name", et la valeur
// réellement soumise à l'approbation est celle, éditable, confirmée par
// l'admin. Même technique vm que test/admin-navigation.test.js et
// test/social-accounts-tenant-context.test.js — AUCUN réseau réel.
//
// Usage : node test/audit-review-identity-ui.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const HTML_PATH = path.join(__dirname, '..', 'public', 'admin', 'audit-review.html');
const NAV_PATH = path.join(__dirname, '..', 'public', 'admin', 'nav.js');
const html = fs.readFileSync(HTML_PATH, 'utf8');
const navSource = fs.readFileSync(NAV_PATH, 'utf8');

const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  throw new Error('audit-review.html: <script> introuvable — le fichier a-t-il changé de structure ?');
}
const scriptSource = scriptMatch[1];

function fakeElement(initial) {
  return Object.assign({
    value: '', innerHTML: '', textContent: '', className: '',
    style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, disabled: false,
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

// runPage — construit un contexte frais par test. `pandoreSession`
// pré-remplit sessionStorage (identité Pandore déjà connectée dans
// l'onglet). `fetchImpl` reçoit chaque appel réseau simulé.
function runPage({ pandoreSession, adminPassword, fetchImpl }) {
  const elements = new Map();
  const calls = [];
  const sandbox = {
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, fakeElement());
        return elements.get(id);
      },
      head: { appendChild() {} },
      createElement() { return { textContent: '' }; },
    },
    location: { search: '?id=audit-fixture-1', href: 'https://pandore-test.example/admin/audit-review.html?id=audit-fixture-1' },
    localStorage: fakeStorage(adminPassword ? { pandore_admin_pw: adminPassword } : { pandore_admin_pw: 'pw' }),
    sessionStorage: fakeStorage(pandoreSession ? { pandore_session: JSON.stringify(pandoreSession) } : {}),
    URLSearchParams,
    console,
    fetch: async (url, opts) => {
      calls.push({ url: String(url), opts: opts || {} });
      return fetchImpl(String(url), opts || {});
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(navSource, sandbox);
  vm.runInContext(scriptSource, sandbox);
  sandbox.__elements = elements;
  sandbox.__calls = calls;
  return sandbox;
}

function jsonOk(body) { return { ok: true, status: 200, json: async () => body }; }

// extractTenantNameValue — le champ #tenantName est produit par un
// template literal directement dans innerHTML (jamais assigné
// programmatiquement à .value) : ce fake DOM ne parse pas le HTML, donc le
// seul moyen fiable de vérifier ce que le NAVIGATEUR afficherait vraiment
// comme valeur initiale est de lire l'attribut value="..." tel qu'écrit
// dans la chaîne rendue — même logique que admin-navigation.test.js qui
// vérifie des attributs/textes dans innerHTML plutôt qu'un état DOM vivant.
function extractTenantNameValue(html) {
  const m = html.match(/id="tenantName" value="([^"]*)"/);
  return m ? m[1] : null;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// pendingAuditFixture — forme EXACTE renvoyée par compose lui-même
// (toAdminAuditDetailView, src/server.js), jamais le DTO Go brut
// PascalCase : audit-review.html appelle /api/admin/audits/:id (compose),
// jamais directement le backend Go.
const pendingAuditFixture = {
  id: 'audit-fixture-1',
  contact_name: 'Guy',
  contact_email: 'guy@example.test',
  business_identity_candidate: 'Chap Chap',
  business_identity_candidate_provenance: 'USER_DECLARED',
  status: 'ANALYZED',
  submitted_at: '2026-01-01T00:00:00Z',
  raw_answers: { a0: 'Guy', a0b: 'guy@example.test', a5: 'Chap Chap' },
  draft: {
    id: 'draft-1', status: 'v0', identity: 'Fait des crêpes', audience: 'Familles',
    objectives: [], platforms: [], constraints: [], forbidden_topics: [],
    proposition: null, data_quality_flags: [], feasibility: null,
  },
};

test('Contact and Client identity render as visibly separate sections, from the backend semantic fields', async () => {
  const sandbox = runPage({
    pandoreSession: { token: 'tok', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } },
    fetchImpl: async (url) => {
      if (url.includes('/api/admin/audits/audit-fixture-1')) return jsonOk({ ...pendingAuditFixture, submission: { ...pendingAuditFixture.submission } });
      return jsonOk({});
    },
  });
  await sandbox.load();
  const content = sandbox.__elements.get('content');
  assert.ok(content.innerHTML.includes('Contact'), 'section Contact absente');
  assert.ok(content.innerHTML.includes('Identité client'), 'section Identité client absente');
  assert.ok(content.innerHTML.includes('Guy'), 'nom de contact absent');
  assert.ok(content.innerHTML.includes('guy@example.test'), 'email de contact absent');
});

test('the business identity candidate comes from the backend semantic field, never derived from raw_answers.a5 by this page', async () => {
  const sandbox = runPage({
    pandoreSession: { token: 'tok', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } },
    fetchImpl: async (url) => {
      if (url.includes('/api/admin/audits/audit-fixture-1')) {
        // a5 délibérément DIFFÉRENT du candidat backend explicite — si la
        // page lisait raw_answers.a5 elle-même, le préremplissage
        // afficherait "PAS Chap Chap depuis a5 direct" au lieu du candidat
        // fourni.
        return jsonOk({
          ...pendingAuditFixture,
          raw_answers: { a0: 'Guy', a0b: 'guy@example.test', a5: 'PAS Chap Chap depuis a5 direct' },
        });
      }
      return jsonOk({});
    },
  });
  await sandbox.load();
  const content = sandbox.__elements.get('content');
  assert.strictEqual(extractTenantNameValue(content.innerHTML), 'Chap Chap', 'attendu le candidat backend explicite, jamais une relecture de raw_answers.a5 par cette page');
});

test('this page never reads RawAnswers.a5/a0 itself to derive an identity (structural proof on the real executable code, comments stripped)', () => {
  // Comments stripped — même discipline que nav.js/admin-navigation.test.js:
  // ce fichier documente délibérément, par la négative, ce qu'il ne doit
  // jamais faire ("jamais RawAnswers.a0/a5 lus ici") — le test doit vérifier
  // le CODE réellement exécuté, jamais cette prose explicative.
  const codeOnly = scriptSource.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.ok(!/RawAnswers/.test(codeOnly), 'audit-review.html ne doit jamais référencer RawAnswers (champ Go brut) directement dans son code exécutable');
  assert.ok(!/\.a5\b/.test(codeOnly), 'audit-review.html ne doit jamais lire .a5 lui-même dans son code exécutable — cette sémantique appartient exclusivement au backend');
});

test('the Tenant.Name field is NEVER prefilled from contact_name', async () => {
  const sandbox = runPage({
    pandoreSession: { token: 'tok', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } },
    fetchImpl: async (url) => {
      if (url.includes('/api/admin/audits/audit-fixture-1')) {
        return jsonOk({ ...pendingAuditFixture, contact_name: 'Guy', business_identity_candidate: '' });
      }
      return jsonOk({});
    },
  });
  await sandbox.load();
  const content = sandbox.__elements.get('content');
  const value = extractTenantNameValue(content.innerHTML);
  assert.notStrictEqual(value, 'Guy', 'le champ Tenant.Name ne doit jamais reprendre le nom du contact');
  assert.strictEqual(value, '', 'sans candidat métier, le champ doit rester vide, jamais rempli depuis le contact');
});

test('when no business candidate exists, the Tenant.Name field starts empty and requires explicit admin entry', async () => {
  const sandbox = runPage({
    pandoreSession: { token: 'tok', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } },
    fetchImpl: async (url) => {
      if (url.includes('/api/admin/audits/audit-fixture-1')) {
        return jsonOk({ ...pendingAuditFixture, business_identity_candidate: '', business_identity_candidate_provenance: '' });
      }
      return jsonOk({});
    },
  });
  await sandbox.load();
  const content = sandbox.__elements.get('content');
  assert.strictEqual(extractTenantNameValue(content.innerHTML), '', 'attendu un champ vide en l\'absence de candidat sûr');
});

test('a present business candidate is shown with a human-readable provenance note, never the raw USER_DECLARED enum', async () => {
  const sandbox = runPage({
    pandoreSession: { token: 'tok', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } },
    fetchImpl: async (url) => {
      if (url.includes('/api/admin/audits/audit-fixture-1')) return jsonOk(pendingAuditFixture);
      return jsonOk({});
    },
  });
  await sandbox.load();
  const content = sandbox.__elements.get('content');
  assert.ok(!content.innerHTML.includes('USER_DECLARED'), 'l\'enum brut ne doit jamais être affiché tel quel');
  assert.ok(/déclaré/i.test(content.innerHTML), 'attendu une note de provenance humainement lisible');
  assert.ok(/confirm/i.test(content.innerHTML), 'attendu une mention explicite qu\'une confirmation admin reste nécessaire');
});

test('the candidate remains editable: changing the input value is what gets submitted, not the original candidate', async () => {
  const sandbox = runPage({
    pandoreSession: { token: 'tok', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } },
    fetchImpl: async (url, opts) => {
      if (url.includes('/api/admin/audits/audit-fixture-1') && (!opts.method || opts.method === 'GET')) return jsonOk(pendingAuditFixture);
      if (url.includes('/approve')) return jsonOk({ ID: 'draft-1', Status: 'v1' });
      return jsonOk({});
    },
  });
  await sandbox.load();
  const content = sandbox.__elements.get('content');
  assert.strictEqual(extractTenantNameValue(content.innerHTML), 'Chap Chap', 'préremplissage initial attendu depuis le candidat backend');
  // Simule l'admin éditant le champ dans un vrai navigateur (ce fake DOM ne
  // parse pas innerHTML — voir extractTenantNameValue) : le handler réel
  // lit .value au moment du clic, jamais le HTML initial. getElementById
  // force la création de l'élément factice (jamais encore référencé tant
  // qu'aucun handler ne l'a lu) avant de poser sa valeur éditée.
  const tenantNameInput = sandbox.document.getElementById('tenantName');
  tenantNameInput.value = 'Chap Chap Corrigé';
  // wireActions() attache le vrai handler sur l'élément réel via
  // addEventListener — cet élément factice le capture, on l'invoque
  // directement pour simuler le clic (même patron que les autres tests vm
  // de ce dépôt qui n'ont pas de DOM réel disponible).
  const confirmBtn = sandbox.__elements.get('btnConfirmApprove');
  let capturedHandler = null;
  confirmBtn.addEventListener = (evt, fn) => { if (evt === 'click') capturedHandler = fn; };
  await sandbox.wireActions();
  assert.ok(capturedHandler, 'attendu un handler de clic enregistré sur btnConfirmApprove');
  await capturedHandler();
  const approveCall = sandbox.__calls.find((c) => c.url.includes('/approve'));
  assert.ok(approveCall, 'attendu un appel à /approve');
  const body = JSON.parse(approveCall.opts.body);
  assert.strictEqual(body.tenant_name, 'Chap Chap Corrigé', 'attendu la valeur ÉDITÉE par l\'admin envoyée, jamais le candidat original figé');
});

test('approval does not happen automatically merely because a candidate exists — an explicit click on Confirmer is still required', async () => {
  const sandbox = runPage({
    pandoreSession: { token: 'tok', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } },
    fetchImpl: async (url, opts) => {
      if (url.includes('/api/admin/audits/audit-fixture-1') && (!opts.method || opts.method === 'GET')) return jsonOk(pendingAuditFixture);
      if (url.includes('/approve')) return jsonOk({ ID: 'draft-1', Status: 'v1' });
      return jsonOk({});
    },
  });
  await sandbox.load();
  const approveCall = sandbox.__calls.find((c) => c.url.includes('/approve'));
  assert.ok(!approveCall, 'aucun appel /approve ne doit jamais se produire sans clic explicite');
});

test('once approved, the displayed "Client actif" name is resolved authoritatively from Pandore (GET /api/admin/tenants/:id), never the contact name', async () => {
  const approvedFixture = {
    ...pendingAuditFixture,
    draft: { ...pendingAuditFixture.draft, status: 'v1', approved_at: '2026-01-03T00:00:00Z', approved_by: 'admin-1', tenant_id: 'tenant-real-1' },
  };
  const sandbox = runPage({
    pandoreSession: { token: 'tok', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } },
    fetchImpl: async (url) => {
      if (url.includes('/api/admin/audits/audit-fixture-1')) return jsonOk(approvedFixture);
      if (url.includes('/api/admin/tenants/tenant-real-1')) return jsonOk({ id: 'tenant-real-1', name: 'Chap Chap', version: 3 });
      return jsonOk({});
    },
  });
  await sandbox.load();
  await new Promise((r) => setTimeout(r, 10));
  const nameEl = sandbox.__elements.get('approvedTenantName');
  assert.strictEqual(nameEl.textContent, 'Chap Chap', 'attendu le Tenant.Name réel résolu via Pandore, jamais le contact_name/tenant_id figés au moment de l\'approbation');
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
