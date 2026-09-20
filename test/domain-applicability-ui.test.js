// H3-008D1Q36K — Generic Admin Domain Applicability Review UI. Preuve
// ciblée de la logique de public/admin/domain-applicability.html : les
// trois états produit (NOT_REVIEWED/REVIEWED_NONE/REVIEWED_WITH_PROFILES),
// le rendu dynamique du catalogue, la confirmation explicite avant POST,
// et la préservation des choix locaux après un échec. Même technique vm
// que test/social-accounts-connection-guard.test.js — AUCUN réseau réel,
// AUCUN profil réel Chap Chap (uniquement des profils SYNTHÉTIQUES
// génériques, jamais "gaming"/"saas"/"local_service"/"local_culture").
//
// Usage : node test/domain-applicability-ui.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const HTML_PATH = path.join(__dirname, '..', 'public', 'admin', 'domain-applicability.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  throw new Error('domain-applicability.html: <script> introuvable — le fichier a-t-il changé de structure ?');
}
const scriptSource = scriptMatch[1];
const navSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'nav.js'), 'utf8');

// fakeElement — même patron générique que les autres suites UI de ce
// dépôt, étendu avec un classList qui MÉMORISE réellement son état (les
// tests V/étroitesse de mise en page ne sont pas vérifiables ici — voir
// note en bas de fichier — mais disabled/checked doivent être réellement
// lisibles après un rendu).
function fakeElement(initial) {
  const classes = new Set();
  return Object.assign({
    value: '', checked: false, disabled: false, style: {}, textContent: '', innerHTML: '',
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      toggle: (c, force) => { const has = force === undefined ? !classes.has(c) : force; if (has) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
    getAttribute() { return null; },
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

function runPage({ search, pandoreSession, fetchImpl }) {
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
      head: { appendChild() {} },
    },
    location: { search: search || '', href: 'https://pandore-test.example/admin/domain-applicability.html' + (search || '') },
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
  vm.createContext(sandbox);
  vm.runInContext(navSource, sandbox);
  vm.runInContext(scriptSource, sandbox);
  sandbox.__elements = elements;
  sandbox.__calls = calls;
  return sandbox;
}

function jsonOk(body) { return { ok: true, status: 200, json: async () => body }; }
function jsonErr(status, body) { return { ok: false, status, json: async () => body }; }

const SESSION = { token: 'tok-domain-applicability', user: { email: 'op@example.test', role: 'PANDORE_OPERATOR' } };

const CATALOG = [
  { profile_id: 'synthetic:domain-alpha', name: 'Synthetic Alpha', description: 'Profil de test A', parent_id: '' },
  { profile_id: 'synthetic:domain-beta', name: 'Synthetic Beta', description: 'Profil de test B', parent_id: '' },
];

function fetchFor({ review, saveResult, catalog }) {
  return async (url) => {
    if (url.includes('/api/admin/contacts')) return jsonOk([]);
    if (url.includes('/api/admin/domain-profiles')) return jsonOk(catalog !== undefined ? catalog : CATALOG);
    if (url.includes('/domain-profile-selections') && !url.includes('POST_MARKER')) {
      return jsonOk(review);
    }
    throw new Error('appel inattendu dans ce test: ' + url);
  };
}

async function main() {
  let passed = 0, failed = 0;
  async function test(name, fn) {
    try { await fn(); console.log(`PASS - ${name}`); passed++; }
    catch (err) { console.log(`FAIL - ${name}\n  ${err.stack || err.message}`); failed++; }
  }

  await test('I. NOT_REVIEWED rendered distinctly', async () => {
    const sandbox = runPage({
      search: '?tenant_id=t1', pandoreSession: SESSION,
      fetchImpl: fetchFor({ review: { reviewed: false, selections: [] } }),
    });
    await sandbox.showDashboard();
    await new Promise((r) => setTimeout(r, 15));
    const banner = sandbox.__elements.get('stateBanner');
    assert.ok(banner.className.includes('not-reviewed'), 'attendu la classe not-reviewed');
    assert.ok(banner.innerHTML.includes('non revue'), 'attendu un libellé explicite non-revu');
  });

  await test('J. REVIEWED_NONE rendered distinctly', async () => {
    const sandbox = runPage({
      search: '?tenant_id=t1', pandoreSession: SESSION,
      fetchImpl: fetchFor({ review: { reviewed: true, reviewed_at: '2026-09-20T10:00:00Z', reviewed_by: 'op-1', selections: [] } }),
    });
    await sandbox.showDashboard();
    await new Promise((r) => setTimeout(r, 15));
    const banner = sandbox.__elements.get('stateBanner');
    assert.ok(banner.className.includes('reviewed-none'), 'attendu la classe reviewed-none');
    assert.ok(!banner.className.includes('not-reviewed'));
    assert.ok(banner.innerHTML.includes('aucun profil métier spécifique applicable'));
  });

  await test('K. REVIEWED_WITH_PROFILES rendered distinctly', async () => {
    const sandbox = runPage({
      search: '?tenant_id=t1', pandoreSession: SESSION,
      fetchImpl: fetchFor({ review: { reviewed: true, reviewed_at: '2026-09-20T10:00:00Z', reviewed_by: 'op-1', selections: [{ profile_id: 'synthetic:domain-alpha', kind: 'DOMAIN' }] } }),
    });
    await sandbox.showDashboard();
    await new Promise((r) => setTimeout(r, 15));
    const banner = sandbox.__elements.get('stateBanner');
    assert.ok(banner.className.includes('reviewed-with'), 'attendu la classe reviewed-with');
    assert.ok(banner.innerHTML.includes('synthetic:domain-alpha'));
  });

  await test('L. catalog dynamically rendered from backend data (no hardcoded names)', async () => {
    const sandbox = runPage({
      search: '?tenant_id=t1', pandoreSession: SESSION,
      fetchImpl: fetchFor({ review: { reviewed: false, selections: [] } }),
    });
    await sandbox.showDashboard();
    await new Promise((r) => setTimeout(r, 15));
    const list = sandbox.__elements.get('profileList');
    assert.ok(list.innerHTML.includes('Synthetic Alpha'));
    assert.ok(list.innerHTML.includes('Synthetic Beta'));
    assert.ok(list.innerHTML.includes('synthetic:domain-alpha'));
    assert.strictEqual(sandbox.catalog.length, 2);
  });

  await test('M. existing profiles preselected for REVIEWED_WITH_PROFILES', async () => {
    const sandbox = runPage({
      search: '?tenant_id=t1', pandoreSession: SESSION,
      fetchImpl: fetchFor({ review: { reviewed: true, reviewed_at: '2026-09-20T10:00:00Z', reviewed_by: 'op-1', selections: [{ profile_id: 'synthetic:domain-beta', kind: 'FACET' }] } }),
    });
    await sandbox.showDashboard();
    await new Promise((r) => setTimeout(r, 15));
    assert.ok(sandbox.selectedProfileIdSet.has('synthetic:domain-beta'), 'attendu synthetic:domain-beta présélectionné');
    assert.ok(!sandbox.selectedProfileIdSet.has('synthetic:domain-alpha'));
    assert.strictEqual(sandbox.noneApplicableChecked, false);
  });

  await test('N. zero-profile review possible (none-applicable toggle)', async () => {
    const sandbox = runPage({
      search: '?tenant_id=t1', pandoreSession: SESSION,
      fetchImpl: fetchFor({ review: { reviewed: false, selections: [] } }),
    });
    await sandbox.showDashboard();
    await new Promise((r) => setTimeout(r, 15));
    sandbox.handleNoneApplicableToggle(true);
    assert.strictEqual(sandbox.selectedProfileIds().length, 0);
    assert.strictEqual(sandbox.noneApplicableChecked, true);
  });

  await test('O. multiple profiles possible', async () => {
    const sandbox = runPage({
      search: '?tenant_id=t1', pandoreSession: SESSION,
      fetchImpl: fetchFor({ review: { reviewed: false, selections: [] } }),
    });
    await sandbox.showDashboard();
    await new Promise((r) => setTimeout(r, 15));
    sandbox.handleProfileCheckboxToggle('synthetic:domain-alpha', true);
    sandbox.handleProfileCheckboxToggle('synthetic:domain-beta', true);
    const ids = sandbox.selectedProfileIds();
    assert.strictEqual(ids.length, 2);
    assert.ok(ids.includes('synthetic:domain-alpha') && ids.includes('synthetic:domain-beta'));
  });

  await test('P. no POST before explicit confirmation', async () => {
    let postCalled = false;
    const sandbox = runPage({
      search: '?tenant_id=t1', pandoreSession: SESSION,
      fetchImpl: async (url, opts) => {
        if (url.includes('/api/admin/contacts')) return jsonOk([]);
        if (url.includes('/api/admin/domain-profiles')) return jsonOk(CATALOG);
        if ((opts.method || 'GET') === 'POST') { postCalled = true; return jsonOk({ reviewed: true, selections: [] }); }
        return jsonOk({ reviewed: false, selections: [] });
      },
    });
    await sandbox.showDashboard();
    await new Promise((r) => setTimeout(r, 15));
    sandbox.handleProfileCheckboxToggle('synthetic:domain-alpha', true);
    // confirmCheckbox jamais coché ici : saveReview doit être un no-op.
    await sandbox.saveReview();
    assert.strictEqual(postCalled, false, 'aucun POST ne doit partir sans confirmation explicite');
    assert.strictEqual(sandbox.__elements.get('saveBtn').disabled, true, 'le bouton Enregistrer doit rester désactivé sans confirmation');
  });

  await test('Q. successful POST refreshes authoritative state', async () => {
    let getCallCount = 0;
    const sandbox = runPage({
      search: '?tenant_id=t1', pandoreSession: SESSION,
      fetchImpl: async (url, opts) => {
        if (url.includes('/api/admin/contacts')) return jsonOk([]);
        if (url.includes('/api/admin/domain-profiles')) return jsonOk(CATALOG);
        if ((opts.method || 'GET') === 'POST') {
          return jsonOk({ reviewed: true, reviewed_at: '2026-09-21T00:00:00Z', reviewed_by: 'op-1', selections: [{ profile_id: 'synthetic:domain-alpha', kind: 'DOMAIN' }] });
        }
        getCallCount++;
        return jsonOk(getCallCount === 1 ? { reviewed: false, selections: [] } : { reviewed: true, reviewed_at: '2026-09-21T00:00:00Z', reviewed_by: 'op-1', selections: [{ profile_id: 'synthetic:domain-alpha', kind: 'DOMAIN' }] });
      },
    });
    await sandbox.showDashboard();
    await new Promise((r) => setTimeout(r, 15));
    sandbox.handleProfileCheckboxToggle('synthetic:domain-alpha', true);
    sandbox.__elements.get('confirmCheckbox').checked = true;
    await sandbox.saveReview();
    assert.ok(sandbox.__elements.get('stateBanner').className.includes('reviewed-with'), 'attendu l\'état rafraîchi après succès');
    assert.strictEqual(sandbox.__elements.get('saveMsg').className, 'msg ok');
  });

  await test('R. failed POST preserves unsaved choices and shows error', async () => {
    const sandbox = runPage({
      search: '?tenant_id=t1', pandoreSession: SESSION,
      fetchImpl: async (url, opts) => {
        if (url.includes('/api/admin/contacts')) return jsonOk([]);
        if (url.includes('/api/admin/domain-profiles')) return jsonOk(CATALOG);
        if ((opts.method || 'GET') === 'POST') return jsonErr(422, { error: { code: 'VALIDATION_FAILED', message: 'conflit simulé' } });
        return jsonOk({ reviewed: false, selections: [] });
      },
    });
    await sandbox.showDashboard();
    await new Promise((r) => setTimeout(r, 15));
    sandbox.handleProfileCheckboxToggle('synthetic:domain-alpha', true);
    sandbox.handleProfileCheckboxToggle('synthetic:domain-beta', true);
    sandbox.__elements.get('confirmCheckbox').checked = true;
    await sandbox.saveReview();
    assert.strictEqual(sandbox.__elements.get('saveMsg').className, 'msg err');
    assert.ok(sandbox.__elements.get('saveMsg').textContent.includes('conflit simulé'));
    // Les choix locaux ne sont jamais réinitialisés après un échec.
    const idsAfterFailure = sandbox.selectedProfileIds();
    assert.strictEqual(idsAfterFailure.length, 2, 'les choix locaux non enregistrés doivent survivre à un échec de POST');
  });

  await test('S. switching tenant reloads state (fresh page load per tenant_id, no bleed)', async () => {
    const sandboxA = runPage({
      search: '?tenant_id=t_a', pandoreSession: SESSION,
      fetchImpl: fetchFor({ review: { reviewed: true, reviewed_at: '2026-09-20T10:00:00Z', reviewed_by: 'op-1', selections: [{ profile_id: 'synthetic:domain-alpha', kind: 'DOMAIN' }] } }),
    });
    await sandboxA.showDashboard();
    await new Promise((r) => setTimeout(r, 15));
    assert.strictEqual(sandboxA.currentTenantId, 't_a');
    assert.ok(sandboxA.selectedProfileIdSet.has('synthetic:domain-alpha'));

    // Une navigation réelle vers un autre tenant_id recharge la page
    // entière (aucun état "global" partagé côté navigateur) — simulé ici
    // par un second contexte sandbox complètement indépendant.
    const sandboxB = runPage({
      search: '?tenant_id=t_b', pandoreSession: SESSION,
      fetchImpl: fetchFor({ review: { reviewed: false, selections: [] } }),
    });
    await sandboxB.showDashboard();
    await new Promise((r) => setTimeout(r, 15));
    assert.strictEqual(sandboxB.currentTenantId, 't_b');
    assert.strictEqual(sandboxB.selectedProfileIdSet.size, 0, 'le tenant B ne doit jamais hériter de la sélection du tenant A');
  });

  await test('T. reviewer/time cannot be client-supplied (never sent in the POST body)', async () => {
    let capturedBody = null;
    const sandbox = runPage({
      search: '?tenant_id=t1', pandoreSession: SESSION,
      fetchImpl: async (url, opts) => {
        if (url.includes('/api/admin/contacts')) return jsonOk([]);
        if (url.includes('/api/admin/domain-profiles')) return jsonOk(CATALOG);
        if ((opts.method || 'GET') === 'POST') { capturedBody = JSON.parse(opts.body); return jsonOk({ reviewed: true, selections: [] }); }
        return jsonOk({ reviewed: false, selections: [] });
      },
    });
    await sandbox.showDashboard();
    await new Promise((r) => setTimeout(r, 15));
    sandbox.handleNoneApplicableToggle(true);
    sandbox.__elements.get('confirmCheckbox').checked = true;
    await sandbox.saveReview();
    assert.ok(capturedBody, 'attendu un appel POST');
    assert.strictEqual('reviewed_by' in capturedBody, false, 'reviewed_by ne doit jamais être envoyé par le client');
    assert.strictEqual('reviewed_at' in capturedBody, false, 'reviewed_at ne doit jamais être envoyé par le client');
    assert.deepStrictEqual(Object.keys(capturedBody).sort(), ['reviewed', 'selections']);
  });

  await test('U. no hardcoded profile-ID branching in save/consequence logic', async () => {
    const sandbox = runPage({
      search: '?tenant_id=t1', pandoreSession: SESSION,
      fetchImpl: fetchFor({ review: { reviewed: false, selections: [] } }),
    });
    await sandbox.showDashboard();
    await new Promise((r) => setTimeout(r, 15));
    sandbox.handleProfileCheckboxToggle('synthetic:domain-alpha', true);
    const payload = sandbox.selectedProfileIds().map(id => ({ profile_id: id, kind: sandbox.deriveProfileKind(id) }));
    assert.strictEqual(payload[0].profile_id, 'synthetic:domain-alpha');
    assert.strictEqual(payload[0].kind, 'DOMAIN', 'le kind doit être dérivé du préfixe générique "domain:", jamais du nom du profil');
    assert.strictEqual(sandbox.deriveProfileKind('synthetic-subdomain:whatever'.replace('synthetic-', '')), 'SUBDOMAIN');
    assert.strictEqual(sandbox.deriveProfileKind('facet:whatever'), 'FACET');
  });

  await test('W. future synthetic profile renders without any code change (genericity)', async () => {
    const futureCatalog = [
      { profile_id: 'domain:future-vertical-not-yet-invented', name: 'Future Vertical', description: 'Un profil qui n\'existe pas encore aujourd\'hui', parent_id: '' },
    ];
    const sandbox = runPage({
      search: '?tenant_id=t1', pandoreSession: SESSION,
      fetchImpl: fetchFor({ review: { reviewed: false, selections: [] }, catalog: futureCatalog }),
    });
    await sandbox.showDashboard();
    await new Promise((r) => setTimeout(r, 15));
    const list = sandbox.__elements.get('profileList');
    assert.ok(list.innerHTML.includes('Future Vertical'));
    assert.ok(list.innerHTML.includes('domain:future-vertical-not-yet-invented'));
  });

  await test('extra. no tenant_id renders an explicit message, never a silent blank form', async () => {
    const sandbox = runPage({ search: '', pandoreSession: SESSION, fetchImpl: fetchFor({ review: { reviewed: false, selections: [] } }) });
    await sandbox.showDashboard();
    await new Promise((r) => setTimeout(r, 15));
    assert.strictEqual(sandbox.__elements.get('noTenantMsg').style.display, 'block');
  });

  await test('V. responsive/narrow layout — NOT VERIFIABLE by this DOM-less harness', async () => {
    // §21/TEST V du mandat : le comportement responsive/mobile réel repose
    // sur les media queries CSS (voir @media (max-width: 520px) dans
    // domain-applicability.html) et sur les contrôles restant des
    // <input>/<button> natifs empilés en colonne, jamais un tableau
    // desktop-only à défilement horizontal. Ce harnais vm (sans moteur de
    // rendu/CSSOM) ne peut structurellement pas mesurer un layout — ce test
    // documente honnêtement cette limite plutôt que de prétendre une
    // couverture inexistante. Vérifié à la place par lecture directe du
    // CSS (voir rapport Q36K) : aucune règle desktop-only, aucun tableau
    // exigeant un défilement horizontal pour les contrôles de sélection.
    assert.ok(html.includes('@media (max-width: 520px)'), 'attendu au moins une règle de mise en page adaptative dans la feuille de style');
    assert.ok(!/<table/i.test(html), 'cette page ne doit jamais utiliser de tableau desktop-only pour les contrôles de sélection');
  });


  console.log(`\n${passed}/${passed + failed} test(s) passés.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
