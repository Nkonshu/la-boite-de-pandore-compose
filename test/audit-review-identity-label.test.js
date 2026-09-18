// H3-008D1O3 — AUDIT REVIEW IDENTITY LABEL CLOSURE. Le défaut de
// présentation trouvé par la revue humaine du parcours D1O2 : une fois un
// audit APPROUVÉ (Tenant réel existant), le H1/fil d'Ariane de cette page
// continuaient d'afficher contact_name, alors même que Pandore distingue
// désormais explicitement contact et identité client (H3-008D1O1/D1O1B).
// Ce fichier prouve que le repère de page (H1 + fil d'Ariane) vient
// désormais de l'identité Tenant RÉELLE (résolue via Pandore) pour un
// audit approuvé, jamais de contact_name — et reste un repère
// audit/prospect explicite, jamais une identité de marque inventée, pour
// un audit pas encore approuvé. Même technique vm que
// test/audit-review-identity-ui.test.js — AUCUN réseau réel.
//
// Usage : node test/audit-review-identity-label.test.js
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

function runPage({ search, pandoreSession, adminPassword, fetchImpl }) {
  const elements = new Map();
  const calls = [];
  const effectiveSearch = search || '?id=audit-fixture-1';
  const sandbox = {
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, fakeElement());
        return elements.get(id);
      },
      head: { appendChild() {} },
      createElement() { return { textContent: '' }; },
    },
    location: { search: effectiveSearch, href: 'https://pandore-test.example/admin/audit-review.html' + effectiveSearch },
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

// extractPageIdentityLabel — <span id="pageIdentityLabel"> est produit par
// un template literal directement dans innerHTML : ce fake DOM ne parse
// pas le HTML, donc document.getElementById('pageIdentityLabel') ne
// devient une entrée observable qu'APRÈS que du code réel l'ait
// explicitement interrogé (resolveApprovedTenantName, une fois sa
// résolution terminée) — jamais avant. Pour vérifier le repère INITIAL/
// PROVISOIRE (avant toute résolution), on lit directement la chaîne
// rendue, même logique que extractTenantNameValue dans
// audit-review-identity-ui.test.js.
function extractPageIdentityLabel(html) {
  const m = html.match(/id="pageIdentityLabel">([^<]*)</);
  return m ? m[1] : null;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const approvedFixture = {
  id: 'audit-fixture-1',
  contact_name: 'Guy',
  contact_email: 'guy@example.test',
  business_identity_candidate: 'Chap Chap',
  business_identity_candidate_provenance: 'USER_DECLARED',
  status: 'ANALYZED',
  submitted_at: '2026-01-01T00:00:00Z',
  raw_answers: { a0: 'Guy', a0b: 'guy@example.test', a5: 'Chap Chap' },
  draft: {
    id: 'draft-1', status: 'v1', identity: 'Fait des crêpes', audience: 'Familles',
    objectives: [], platforms: [], constraints: [], forbidden_topics: [],
    proposition: null, data_quality_flags: [], feasibility: null,
    approved_at: '2026-01-03T00:00:00Z', approved_by: 'admin-1', tenant_id: 'tenant-real-1',
  },
};

const unapprovedFixture = {
  id: 'audit-fixture-2',
  contact_name: 'Guy',
  contact_email: 'guy@example.test',
  business_identity_candidate: 'Chap Chap',
  business_identity_candidate_provenance: 'USER_DECLARED',
  status: 'ANALYZED',
  submitted_at: '2026-01-01T00:00:00Z',
  raw_answers: { a0: 'Guy', a0b: 'guy@example.test', a5: 'Chap Chap' },
  draft: {
    id: 'draft-2', status: 'v0', identity: 'Fait des crêpes', audience: 'Familles',
    objectives: [], platforms: [], constraints: [], forbidden_topics: [],
    proposition: null, data_quality_flags: [], feasibility: null,
  },
};

test('approved audit: breadcrumb uses the resolved current Tenant.Name, never contact_name', async () => {
  const sandbox = runPage({
    pandoreSession: { token: 'tok', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } },
    fetchImpl: async (url) => {
      if (url.includes('/api/admin/audits/audit-fixture-1')) return jsonOk(approvedFixture);
      if (url.includes('/api/admin/tenants/tenant-real-1')) return jsonOk({ id: 'tenant-real-1', name: 'Chap Chap', version: 5 });
      return jsonOk({});
    },
  });
  await sandbox.load();
  await new Promise((r) => setTimeout(r, 10));
  const nav = sandbox.__elements.get('adminNav');
  assert.ok(nav.innerHTML.includes('Chap Chap'), 'attendu le Tenant.Name résolu dans le fil d\'Ariane');
  assert.ok(!/current">Guy</.test(nav.innerHTML), 'le segment terminal du fil d\'Ariane ne doit jamais être le nom du contact une fois approuvé');
});

test('approved audit: H1 identifies the audit and uses the resolved Tenant.Name, never presents contact_name as the client identity', async () => {
  const sandbox = runPage({
    pandoreSession: { token: 'tok', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } },
    fetchImpl: async (url) => {
      if (url.includes('/api/admin/audits/audit-fixture-1')) return jsonOk(approvedFixture);
      if (url.includes('/api/admin/tenants/tenant-real-1')) return jsonOk({ id: 'tenant-real-1', name: 'Chap Chap', version: 5 });
      return jsonOk({});
    },
  });
  await sandbox.load();
  await new Promise((r) => setTimeout(r, 10));
  const content = sandbox.__elements.get('content');
  assert.ok(/<h1>Audit/.test(content.innerHTML), 'le H1 doit explicitement identifier une page d\'audit');
  const h1Label = sandbox.__elements.get('pageIdentityLabel');
  assert.strictEqual(h1Label.textContent, 'Chap Chap', 'attendu le Tenant.Name résolu comme repère H1');
});

test('approved audit: before resolution completes, the provisional label is the business candidate, never contact_name', async () => {
  let resolveTenantFetch;
  const tenantFetchPromise = new Promise((resolve) => { resolveTenantFetch = resolve; });
  const sandbox = runPage({
    pandoreSession: { token: 'tok', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } },
    fetchImpl: async (url) => {
      if (url.includes('/api/admin/audits/audit-fixture-1')) return jsonOk(approvedFixture);
      if (url.includes('/api/admin/tenants/tenant-real-1')) {
        await tenantFetchPromise;
        return jsonOk({ id: 'tenant-real-1', name: 'Chap Chap', version: 5 });
      }
      return jsonOk({});
    },
  });
  const loadPromise = sandbox.load();
  await new Promise((r) => setTimeout(r, 5));
  // Avant que la résolution Pandore n'ait répondu : jamais "Guy" (le
  // contact), au mieux le candidat métier déjà connu.
  const provisional = extractPageIdentityLabel(sandbox.__elements.get('content').innerHTML);
  assert.notStrictEqual(provisional, 'Guy', 'le repère provisoire ne doit jamais être le nom du contact');
  assert.strictEqual(provisional, 'Chap Chap', 'attendu le candidat métier déjà connu comme repère provisoire');
  resolveTenantFetch();
  await loadPromise;
  await new Promise((r) => setTimeout(r, 5));
});

test('approved audit without any business candidate never falls back to contact_name as the provisional label', async () => {
  const fixtureNoCandidate = { ...approvedFixture, business_identity_candidate: '', business_identity_candidate_provenance: '' };
  let resolveTenantFetch;
  const tenantFetchPromise = new Promise((resolve) => { resolveTenantFetch = resolve; });
  const sandbox = runPage({
    pandoreSession: { token: 'tok', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } },
    fetchImpl: async (url) => {
      if (url.includes('/api/admin/audits/audit-fixture-1')) return jsonOk(fixtureNoCandidate);
      if (url.includes('/api/admin/tenants/tenant-real-1')) { await tenantFetchPromise; return jsonOk({ id: 'tenant-real-1', name: 'Chap Chap', version: 5 }); }
      return jsonOk({});
    },
  });
  const loadPromise = sandbox.load();
  await new Promise((r) => setTimeout(r, 5));
  const provisional = extractPageIdentityLabel(sandbox.__elements.get('content').innerHTML);
  assert.notStrictEqual(provisional, 'Guy', 'jamais un repli sur contact_name, même sans candidat métier connu');
  assert.strictEqual(provisional, 'Client', 'attendu le repère générique neutre en l\'absence de tout candidat métier');
  resolveTenantFetch();
  await loadPromise;
});

test('the Contact block still displays contact_name/contact_email even for an approved audit', async () => {
  const sandbox = runPage({
    pandoreSession: { token: 'tok', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } },
    fetchImpl: async (url) => {
      if (url.includes('/api/admin/audits/audit-fixture-1')) return jsonOk(approvedFixture);
      if (url.includes('/api/admin/tenants/tenant-real-1')) return jsonOk({ id: 'tenant-real-1', name: 'Chap Chap', version: 5 });
      return jsonOk({});
    },
  });
  await sandbox.load();
  await new Promise((r) => setTimeout(r, 10));
  const content = sandbox.__elements.get('content');
  assert.ok(content.innerHTML.includes('Contact'), 'section Contact absente');
  assert.ok(content.innerHTML.includes('Guy'), 'le nom de contact doit rester visible dans le bloc Contact');
  assert.ok(content.innerHTML.includes('guy@example.test'), 'l\'email de contact doit rester visible');
});

test('business identity candidate (pending approval) remains a visibly distinct, separately labeled block from Contact', async () => {
  const sandbox = runPage({
    search: '?id=audit-fixture-2',
    pandoreSession: { token: 'tok', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } },
    fetchImpl: async (url) => {
      if (url.includes('/api/admin/audits/audit-fixture-2')) return jsonOk(unapprovedFixture);
      return jsonOk({});
    },
  });
  await sandbox.load();
  await new Promise((r) => setTimeout(r, 10));
  const content = sandbox.__elements.get('content');
  assert.ok(content.innerHTML.includes('Identité client'), 'la section Identité client doit rester présente et distincte avant approbation');
});

test('approved audit: the "Client actif" status block shows the resolved name, distinct from the H1 identity label element', async () => {
  const sandbox = runPage({
    pandoreSession: { token: 'tok', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } },
    fetchImpl: async (url) => {
      if (url.includes('/api/admin/audits/audit-fixture-1')) return jsonOk(approvedFixture);
      if (url.includes('/api/admin/tenants/tenant-real-1')) return jsonOk({ id: 'tenant-real-1', name: 'Chap Chap', version: 5 });
      return jsonOk({});
    },
  });
  await sandbox.load();
  await new Promise((r) => setTimeout(r, 10));
  const content = sandbox.__elements.get('content');
  assert.ok(content.innerHTML.includes('Client actif'), 'le statut "Client actif" doit rester présent après approbation');
  const statusEl = sandbox.__elements.get('approvedTenantName');
  assert.strictEqual(statusEl.textContent, 'Chap Chap', 'attendu le nom résolu reflété aussi dans le statut "Client actif"');
});

test('unapproved audit (no tenant yet): no business identity is invented, breadcrumb stays a single explicit segment', async () => {
  const sandbox = runPage({
    search: '?id=audit-fixture-2',
    pandoreSession: { token: 'tok', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } },
    fetchImpl: async (url) => {
      if (url.includes('/api/admin/audits/audit-fixture-2')) return jsonOk(unapprovedFixture);
      return jsonOk({});
    },
  });
  await sandbox.load();
  await new Promise((r) => setTimeout(r, 10));
  const nav = sandbox.__elements.get('adminNav');
  // Un seul segment de contexte (jamais "> Audit" en plus tant qu'aucun
  // Tenant n'existe — rien à hiérarchiser sous un prospect). Le motif
  // exclut délibérément "admin-crumb-sep" (séparateur visuel, pas un
  // segment) — un simple `.includes('admin-crumb')` le compterait à tort.
  const crumbSegments = (nav.innerHTML.match(/class="admin-crumb(?:"| current")/g) || []).length;
  assert.strictEqual(crumbSegments, 2, 'attendu exactement 2 segments pour un prospect (zone + contact), jamais un 3e "Audit" ajouté sans tenant');
  assert.ok(!nav.innerHTML.includes('Chap Chap'), 'aucune identité métier ne doit être inventée avant approbation');
});

test('unapproved audit: H1 explicitly frames the label as an audit/prospect context, not a confirmed client identity', async () => {
  const sandbox = runPage({
    search: '?id=audit-fixture-2',
    pandoreSession: { token: 'tok', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } },
    fetchImpl: async (url) => {
      if (url.includes('/api/admin/audits/audit-fixture-2')) return jsonOk(unapprovedFixture);
      return jsonOk({});
    },
  });
  await sandbox.load();
  await new Promise((r) => setTimeout(r, 10));
  const content = sandbox.__elements.get('content');
  assert.ok(/<h1>Audit/.test(content.innerHTML), 'le H1 doit explicitement se présenter comme une page d\'audit, jamais une fiche client');
  assert.strictEqual(extractPageIdentityLabel(content.innerHTML), 'Guy', 'le contact reste le repère de page tant qu\'aucun tenant n\'existe, mais toujours sous "Audit —"');
});

test('no silent fallback ever promotes contact_name to the resolved Tenant.Name label after resolution', async () => {
  const sandbox = runPage({
    pandoreSession: { token: 'tok', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } },
    fetchImpl: async (url) => {
      if (url.includes('/api/admin/audits/audit-fixture-1')) return jsonOk(approvedFixture);
      // Résolution Pandore échoue (ex. session expirée) : la page ne doit
      // JAMAIS se rabattre sur contact_name pour autant.
      if (url.includes('/api/admin/tenants/tenant-real-1')) return { ok: false, status: 401, json: async () => ({}) };
      return jsonOk({});
    },
  });
  await sandbox.load();
  await new Promise((r) => setTimeout(r, 10));
  const label = extractPageIdentityLabel(sandbox.__elements.get('content').innerHTML);
  assert.notStrictEqual(label, 'Guy', 'un échec de résolution ne doit jamais retomber sur le nom du contact');
  assert.strictEqual(label, 'Chap Chap', 'attendu le candidat métier provisoire conservé (jamais écrasé par un échec de résolution)');
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
