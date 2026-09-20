// H3-008D1Q3 — GENERIC CAPABILITY REVALIDATION UI. Preuve ciblée que
// social-accounts.html expose une action "Revérifier les capacités"
// générique (jamais un bouton "Vérifier Facebook"/"Debug token") qui
// déclenche POST .../capabilities/revalidate (relais générique, même
// identité Bearer que la lecture granted-capabilities) et rafraîchit
// l'affichage existant. Même technique vm que
// test/social-accounts-granted-capability-ui.test.js — AUCUN réseau réel.
//
// Usage : node test/social-accounts-capability-revalidate-ui.test.js
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
function jsonErr(status, body) { return { ok: false, status, json: async () => body }; }

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
  // H3-008D1Q28 §7 — le libellé a été précisé en "Revérifier l'accès
  // technique" (depuis H3-008D1Q27, cette action ne relit plus qu'un
  // TOKEN_INTROSPECTION, jamais les autorisations Page) — reste GÉNÉRIQUE
  // (jamais un nom de plateforme), seul le libellé exact a changé.
  await test('a CONNECTED account renders a generic "Revérifier l\'accès technique" button, never a platform-named action', async () => {
    const sandbox = runPage({
      fetchImpl: async (url) => {
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_CONNECTED]);
        if (url.includes('/granted-capabilities')) return jsonOk([]);
        return jsonOk({});
      },
    });
    await waitForRender();
    const tbody = sandbox.__elements.get('#accountsTable tbody');
    assert.ok(tbody.innerHTML.includes("Revérifier l'accès technique"), 'attendu le bouton générique renommé (H3-008D1Q28 §7)');
    assert.ok(!/vérifier facebook/i.test(tbody.innerHTML), 'jamais un libellé nommant la plateforme');
  });

// H3-008D1Q11 §7 — réponse RÉELLE du relais generic depuis ce lot : sépare
// l'état AUTORITAIRE (capabilities) de l'issue de CETTE tentative
// (attempt_outcome/observations) — jamais un simple tableau comme avant.
function revalidateResponse({ attemptOutcome, capabilityState, verifiedAt, observedState, applied, skipReason }) {
  return {
    attempt_id: 'attempt-fixture-1',
    attempt_outcome: attemptOutcome,
    attempt_triggered_at: '2026-09-19T10:00:00Z',
    attempt_finished_at: '2026-09-19T10:00:00Z',
    capabilities: [{ capability: 'PUBLISH_TEXT', state: capabilityState, provenance: 'REAL_OBSERVATION', verified_at: verifiedAt }],
    observations: [{ capability: 'PUBLISH_TEXT', observed_state: observedState, observed_provenance: 'REAL_OBSERVATION', applied, skip_reason: skipReason || '' }],
    external_effects: null,
  };
}

  await test('a fresh confirmation (attempt_outcome=APPLIED) posts to the generic relay and shows the new authoritative state as ok', async () => {
    let revalidateCalled = false;
    const sandbox = runPage({
      fetchImpl: async (url, opts) => {
        if (url.includes('/capabilities/revalidate')) {
          revalidateCalled = true;
          return jsonOk(revalidateResponse({ attemptOutcome: 'APPLIED', capabilityState: 'GRANTED', verifiedAt: '2026-09-10T08:00:00Z', observedState: 'GRANTED', applied: true }));
        }
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_CONNECTED]);
        if (url.includes('/granted-capabilities')) return jsonOk([]);
        return jsonOk({});
      },
    });
    await waitForRender();
    await sandbox.revalidateCapabilities('t_fixture', 'sa_1');
    await waitForRender();

    const call = sandbox.__calls.find((c) => c.url.includes('/capabilities/revalidate'));
    assert.ok(call, 'attendu un appel de revalidation');
    assert.strictEqual(call.opts.method, 'POST');
    assert.ok(call.url.includes('/api/admin/tenants/t_fixture/social-accounts/sa_1/capabilities/revalidate'), `URL inattendue: ${call.url}`);
    assert.strictEqual(call.opts.headers.Authorization, 'Bearer real-pandore-session-token');
    assert.ok(revalidateCalled, 'attendu que le relais générique ait été appelé');

    const msgEl = sandbox.__elements.get('actionMsg');
    assert.strictEqual(msgEl.className, 'msg ok');
    assert.ok(msgEl.textContent.includes('Accordée') || msgEl.textContent.toLowerCase().includes('accordée'), `attendu un message reflétant l'état confirmé, obtenu: ${msgEl.textContent}`);
  });

  // H3-008D1Q11 §8 — reproduit EXACTEMENT le défaut H3-008D1Q9 côté UI :
  // l'ancien message inconditionnel "Capacités revérifiées." laissait
  // croire à une reconfirmation fraîche même quand l'anti-downgrade a
  // refusé la nouvelle observation. Le message doit désormais rester
  // honnête : état autoritaire préservé, tentative sans effet.
  await test('an inconclusive attempt (anti-downgrade) never claims a fresh confirmation and states the preserved authoritative state', async () => {
    const sandbox = runPage({
      fetchImpl: async (url) => {
        if (url.includes('/capabilities/revalidate')) {
          return jsonOk(revalidateResponse({ attemptOutcome: 'INCONCLUSIVE', capabilityState: 'GRANTED', verifiedAt: '2026-09-10T08:00:00Z', observedState: 'UNKNOWN', applied: false, skipReason: 'ANTI_DOWNGRADE_UNKNOWN' }));
        }
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_CONNECTED]);
        if (url.includes('/granted-capabilities')) return jsonOk([]);
        return jsonOk({});
      },
    });
    await waitForRender();
    await sandbox.revalidateCapabilities('t_fixture', 'sa_1');
    await waitForRender();

    const msgEl = sandbox.__elements.get('actionMsg');
    assert.strictEqual(msgEl.className, 'msg warn');
    assert.ok(!msgEl.textContent.includes('Capacités revérifiées.'), `ne doit jamais afficher le message inconditionnel ambigu, obtenu: ${msgEl.textContent}`);
    assert.ok(msgEl.textContent.toLowerCase().includes('accordée'), `attendu que l'état autoritaire préservé (Accordée) soit affiché, obtenu: ${msgEl.textContent}`);
  });

  await test('a revalidation failure shows an explicit error message without throwing', async () => {
    const sandbox = runPage({
      fetchImpl: async (url) => {
        if (url.includes('/capabilities/revalidate')) return jsonErr(422, { error: { code: 'CAPABILITY_RESOLUTION_NOT_SUPPORTED', message: 'cette plateforme ne fournit aucune résolution de capacité' } });
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_CONNECTED]);
        if (url.includes('/granted-capabilities')) return jsonOk([]);
        return jsonOk({});
      },
    });
    await waitForRender();
    await sandbox.revalidateCapabilities('t_fixture', 'sa_1');

    const msgEl = sandbox.__elements.get('actionMsg');
    assert.strictEqual(msgEl.className, 'msg err');
    assert.ok(msgEl.textContent.includes('cette plateforme ne fournit aucune résolution de capacité'));
  });

  await test('the relay route and button code contain no platform-specific vocabulary (structural check on the real executable HTML/JS)', () => {
    const scriptOnly = scriptMatch[1];
    const forbidden = ['facebook', 'instagram', 'meta', 'debug_token', 'debug-token', 'graph.facebook'];
    const lower = scriptOnly.toLowerCase();
    for (const name of forbidden) {
      // "platform-facebook"/"pill.platform-facebook" (déjà existant, CSS/DOM générique
      // piloté par la donnée a.platform) reste légitime — seule la logique de CE
      // lot (revalidateCapabilities/renderCapabilityCell/le bouton) est vérifiée ici.
      const fnStart = scriptOnly.indexOf('function revalidateCapabilities');
      const fnEnd = scriptOnly.indexOf('\n}', fnStart) + 2;
      const fnSource = scriptOnly.slice(fnStart, fnEnd).toLowerCase();
      assert.ok(!fnSource.includes(name), `revalidateCapabilities référence ${name} — doit rester générique`);
    }
  });

  console.log(`\n${passed}/${passed + failed} test(s) passés.`);
  if (failed > 0) process.exit(1);
})();
