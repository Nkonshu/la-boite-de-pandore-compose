// H3-008D1Q15 — LATEST REVALIDATION ATTEMPT READ MODEL (UI). Preuve ciblée
// que social-accounts.html reconstruit l'issue de la DERNIÈRE tentative de
// revalidation depuis la persistance (GET .../capabilities/latest-attempt),
// jamais seulement depuis la réponse POST transitoire — fermant le
// READ_MODEL_GAP identifié par l'audit H3-008D1Q14. Même technique vm que
// test/social-accounts-granted-capability-ui.test.js — AUCUN réseau réel.
//
// Usage : node test/social-accounts-latest-attempt-ui.test.js
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

function runPage({ fetchImpl }) {
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
    sessionStorage: fakeStorage({ pandore_session: JSON.stringify({ token: 'real-pandore-session-token', user: { email: 'operateur@example.com', role: 'PANDORE_OPERATOR' } }) }),
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
  status: 'CONNECTED', granted_scopes: ['pages_show_list'],
  connected_at: '2026-09-01T10:00:00Z',
};

async function waitForRender() {
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
  await test('a page load with no previous attempt renders the authoritative pill without any attempt-note line', async () => {
    const sandbox = runPage({
      fetchImpl: async (url) => {
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_CONNECTED]);
        if (url.includes('/granted-capabilities')) return jsonOk([]);
        if (url.includes('/capabilities/latest-attempt')) return jsonOk({ exists: false });
        return jsonOk({});
      },
    });
    await waitForRender();
    const tbody = sandbox.__elements.get('#accountsTable tbody');
    assert.ok(tbody.innerHTML.includes('Jamais vérifiée'), 'état autoritaire attendu');
    assert.ok(!tbody.innerHTML.includes('attempt-note'), 'aucune ligne de tentative pour un compte jamais revérifié');
  });

  await test('reload reconstructs a fresh confirmed (APPLIED) attempt from the persisted read model, distinct from the authoritative pill', async () => {
    const sandbox = runPage({
      fetchImpl: async (url) => {
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_CONNECTED]);
        if (url.includes('/granted-capabilities')) {
          return jsonOk([{ capability: 'PUBLISH_TEXT', state: 'GRANTED', provenance: 'REAL_OBSERVATION', verified_at: '2026-09-19T21:37:16Z' }]);
        }
        if (url.includes('/capabilities/latest-attempt')) {
          return jsonOk({
            exists: true, attempt_id: 'attempt-applied-1', platform: 'facebook',
            triggered_at: '2026-09-19T21:37:16Z', finished_at: '2026-09-19T21:37:16Z', outcome: 'APPLIED',
            observations: [{ capability: 'PUBLISH_TEXT', observed_state: 'GRANTED', observed_provenance: 'REAL_OBSERVATION', applied: true, skip_reason: '' }],
            external_effects: null,
          });
        }
        return jsonOk({});
      },
    });
    await waitForRender();
    const tbody = sandbox.__elements.get('#accountsTable tbody');
    assert.ok(tbody.innerHTML.includes('cap-granted'), 'attendu le pill autoritaire Accordée');
    assert.ok(tbody.innerHTML.includes('Dernière revérification'), 'attendu une ligne distincte décrivant la tentative');
    assert.ok(tbody.innerHTML.includes('concluante'), 'attendu que la tentative APPLIED soit décrite comme concluante');
  });

  await test('reload reconstructs an inconclusive (anti-downgrade) attempt from the persisted read model — never claims a fresh confirmation, authoritative state stays separately correct', async () => {
    const sandbox = runPage({
      fetchImpl: async (url) => {
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_CONNECTED]);
        if (url.includes('/granted-capabilities')) {
          // L'état autoritaire reste GRANTED (préservé), verified_at INCHANGÉ
          // depuis la confirmation historique — jamais avancé par la
          // tentative inconclusive.
          return jsonOk([{ capability: 'PUBLISH_TEXT', state: 'GRANTED', provenance: 'REAL_OBSERVATION', verified_at: '2026-09-19T19:24:21Z' }]);
        }
        if (url.includes('/capabilities/latest-attempt')) {
          return jsonOk({
            exists: true, attempt_id: 'attempt-inconclusive-1', platform: 'facebook',
            triggered_at: '2026-09-19T21:37:16Z', finished_at: '2026-09-19T21:37:16Z', outcome: 'INCONCLUSIVE',
            observations: [{ capability: 'PUBLISH_TEXT', observed_state: 'UNKNOWN', observed_provenance: 'REAL_OBSERVATION', applied: false, skip_reason: 'ANTI_DOWNGRADE_UNKNOWN' }],
            external_effects: null,
          });
        }
        return jsonOk({});
      },
    });
    await waitForRender();
    const tbody = sandbox.__elements.get('#accountsTable tbody');
    assert.ok(tbody.innerHTML.includes('cap-granted'), 'attendu le pill autoritaire GRANTED préservé');
    assert.ok(tbody.innerHTML.includes('Accordée'), 'attendu le libellé Accordée pour l\'état autoritaire');
    assert.ok(tbody.innerHTML.includes('non concluante'), 'attendu que la tentative INCONCLUSIVE soit décrite comme non concluante');
    assert.ok(tbody.innerHTML.includes('état précédent conservé'), 'attendu une mention explicite de préservation, jamais une confirmation fraîche fabriquée');
    assert.ok(!tbody.innerHTML.includes('Capacités revérifiées.'), 'jamais le message ambigu inconditionnel pour une tentative inconclusive');
  });

  await test('a historical attempt without Q11 telemetry (Q5/Q9-shaped) is described honestly as detail-unavailable, never as a confirmation or a failure', async () => {
    const sandbox = runPage({
      fetchImpl: async (url) => {
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_CONNECTED]);
        if (url.includes('/granted-capabilities')) {
          return jsonOk([{ capability: 'PUBLISH_TEXT', state: 'GRANTED', provenance: 'REAL_OBSERVATION', verified_at: '2026-09-19T19:24:21Z' }]);
        }
        if (url.includes('/capabilities/latest-attempt')) {
          return jsonOk({
            exists: true, attempt_id: 'trigger-q5', platform: 'facebook',
            triggered_at: '2026-09-19T19:24:21Z', finished_at: null, outcome: 'OBSERVED',
            observations: [], external_effects: null,
          });
        }
        return jsonOk({});
      },
    });
    await waitForRender();
    const tbody = sandbox.__elements.get('#accountsTable tbody');
    assert.ok(tbody.innerHTML.includes('détail non disponible'), 'attendu une mention honnête d\'absence de détail Q11');
    assert.ok(!tbody.innerHTML.includes('concluante') || tbody.innerHTML.includes('non concluante') === false, 'ne doit jamais qualifier une ligne historique de "concluante"');
  });

  await test('the latest-attempt lookup is scoped by tenant_id and social_account_id, and carries the real Pandore Bearer session (same identity as granted-capabilities)', async () => {
    const sandbox = runPage({
      fetchImpl: async (url) => {
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_CONNECTED]);
        if (url.includes('/granted-capabilities')) return jsonOk([]);
        if (url.includes('/capabilities/latest-attempt')) return jsonOk({ exists: false });
        return jsonOk({});
      },
    });
    await waitForRender();
    const call = sandbox.__calls.find((c) => c.url.includes('/capabilities/latest-attempt'));
    assert.ok(call, 'attendu un appel latest-attempt');
    assert.ok(call.url.includes('/api/admin/tenants/t_fixture/social-accounts/sa_1/capabilities/latest-attempt'), `URL inattendue: ${call.url}`);
    assert.strictEqual(call.opts.headers.Authorization, 'Bearer real-pandore-session-token');
    assert.strictEqual(call.opts.method, undefined, 'un GET ne doit jamais spécifier de méthode POST/PUT');
  });

  await test('a REVOKED account never triggers a latest-attempt lookup', async () => {
    const ACCOUNT_REVOKED = { id: 'sa_2', platform: 'facebook', display_name: 'Old Page', status: 'REVOKED', granted_scopes: [], connected_at: '2026-08-01T10:00:00Z' };
    const sandbox = runPage({
      fetchImpl: async (url) => {
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_REVOKED]);
        if (url.includes('/capabilities/latest-attempt')) throw new Error('ne doit jamais être appelé pour un compte révoqué');
        return jsonOk({});
      },
    });
    await waitForRender();
    const calls = sandbox.__calls.filter((c) => c.url.includes('/capabilities/latest-attempt'));
    assert.strictEqual(calls.length, 0, 'un compte révoqué ne doit jamais déclencher cette lecture');
  });

  console.log(`\n${passed}/${passed + failed} test(s) passés.`);
  if (failed > 0) process.exit(1);
})();
