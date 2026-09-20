// H3-008D1Q28 (Q23 Lot 5) — AUTHORIZATION EVIDENCE FRESHNESS READ MODEL
// (UI). Preuve ciblée que social-accounts.html rend la ligne "Autorisations
// de la Page" comme un signal temporel SÉPARÉ de la ligne de revalidation
// technique (voir social-accounts-latest-attempt-ui.test.js), et que le
// wording reste honnête dans les trois états (présente / non capturée /
// échec de lecture). Même technique vm que les fichiers UI voisins —
// AUCUN réseau réel.
//
// Usage : node test/social-accounts-authorization-evidence-ui.test.js
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
  await test('evidence present renders the connection-time observation wording with its own timestamp, distinct from the latest-attempt line', async () => {
    const sandbox = runPage({
      fetchImpl: async (url) => {
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_CONNECTED]);
        if (url.includes('/granted-capabilities')) {
          return jsonOk([{ capability: 'PUBLISH_TEXT', state: 'GRANTED', provenance: 'REAL_OBSERVATION', verified_at: '2026-09-19T21:37:16Z' }]);
        }
        if (url.includes('/capabilities/latest-attempt')) return jsonOk({ exists: false });
        if (url.includes('/authorization-evidence')) {
          return jsonOk({ exists: true, evidence_id: 'ev-1', observed_at: '2026-07-15T09:00:00Z', source_operation: 'META_ACCOUNTS_LISTING', provenance: 'CONNECTION_TIME_OBSERVATION' });
        }
        return jsonOk({});
      },
    });
    await waitForRender();
    const tbody = sandbox.__elements.get('#accountsTable tbody');
    assert.ok(tbody.innerHTML.includes('Autorisations de la Page'), 'attendu la ligne dédiée aux autorisations de Page');
    assert.ok(tbody.innerHTML.includes('observées lors de la connexion'), 'attendu un wording factuel, jamais "actuellement valides"');
    assert.ok(!tbody.innerHTML.includes('actuellement valides'), 'ne doit jamais affirmer une validité présente non prouvée');
    assert.ok(!tbody.innerHTML.includes('expirée') && !tbody.innerHTML.includes('expiré'), 'aucun TTL/expiration inventé pour de l\'évidence ancienne');
  });

  await test('no evidence captured yet renders a truthful not-yet-captured state — never implies denied/missing/disconnected/invalid token, and coexists with an authoritative GRANTED pill', async () => {
    const sandbox = runPage({
      fetchImpl: async (url) => {
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_CONNECTED]);
        if (url.includes('/granted-capabilities')) {
          // Compte Chap Chap réel : historiquement GRANTED, jamais reconnecté
          // depuis H3-008D1Q26 — la coexistence est INTENTIONNELLE (§5 du
          // mandat), jamais une contradiction à masquer.
          return jsonOk([{ capability: 'PUBLISH_TEXT', state: 'GRANTED', provenance: 'REAL_OBSERVATION', verified_at: '2026-01-10T08:00:00Z' }]);
        }
        if (url.includes('/capabilities/latest-attempt')) return jsonOk({ exists: false });
        if (url.includes('/authorization-evidence')) return jsonOk({ exists: false });
        return jsonOk({});
      },
    });
    await waitForRender();
    const tbody = sandbox.__elements.get('#accountsTable tbody');
    assert.ok(tbody.innerHTML.includes('cap-granted'), 'attendu le pill autoritaire GRANTED, jamais caché par l\'absence d\'évidence corrigée');
    assert.ok(tbody.innerHTML.includes('non encore vérifiées'), 'attendu un wording honnête "non encore capturée"');
    for (const forbidden of ['refusée', 'manquante', 'déconnecté', 'invalide', 'reconnexion requise', 'reconnecter']) {
      assert.ok(!tbody.innerHTML.toLowerCase().includes(forbidden), `ne doit jamais impliquer "${forbidden}" en l'absence d'évidence`);
    }
  });

  await test('a read failure on the evidence endpoint renders a distinct error state, never silently collapsed into the not-yet-captured wording', async () => {
    const sandbox = runPage({
      fetchImpl: async (url) => {
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_CONNECTED]);
        if (url.includes('/granted-capabilities')) return jsonOk([]);
        if (url.includes('/capabilities/latest-attempt')) return jsonOk({ exists: false });
        if (url.includes('/authorization-evidence')) return jsonErr(500, { error: { code: 'INTERNAL_ERROR', message: 'panne simulée' } });
        return jsonOk({});
      },
    });
    await waitForRender();
    const tbody = sandbox.__elements.get('#accountsTable tbody');
    assert.ok(tbody.innerHTML.includes('lecture impossible'), 'attendu un état d\'erreur visible et distinct');
    assert.ok(!tbody.innerHTML.includes('non encore vérifiées'), 'un échec de lecture ne doit jamais s\'afficher comme "non encore capturée"');
  });

  await test('a read failure on the latest-attempt endpoint renders a distinct error state, never silently collapsed into "never revalidated" (closes LATEST_ATTEMPT_ERROR_VISIBILITY_DEBT)', async () => {
    const sandbox = runPage({
      fetchImpl: async (url) => {
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_CONNECTED]);
        if (url.includes('/granted-capabilities')) return jsonOk([]);
        if (url.includes('/capabilities/latest-attempt')) return jsonErr(500, { error: { code: 'INTERNAL_ERROR', message: 'panne simulée' } });
        if (url.includes('/authorization-evidence')) return jsonOk({ exists: false });
        return jsonOk({});
      },
    });
    await waitForRender();
    const tbody = sandbox.__elements.get('#accountsTable tbody');
    assert.ok(tbody.innerHTML.includes('Dernière revérification technique : lecture impossible'), 'attendu un état d\'erreur visible et distinct pour la lecture de tentative');
  });

  await test('the revalidation button is labeled with precise, non-Page-authorization-implying wording', async () => {
    const sandbox = runPage({
      fetchImpl: async (url) => {
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_CONNECTED]);
        if (url.includes('/granted-capabilities')) return jsonOk([]);
        if (url.includes('/capabilities/latest-attempt')) return jsonOk({ exists: false });
        if (url.includes('/authorization-evidence')) return jsonOk({ exists: false });
        return jsonOk({});
      },
    });
    await waitForRender();
    const tbody = sandbox.__elements.get('#accountsTable tbody');
    assert.ok(tbody.innerHTML.includes("Revérifier l'accès technique"), 'attendu le libellé précis du bouton');
    assert.ok(!tbody.innerHTML.includes('Revérifier les capacités'), 'l\'ancien libellé ambigu ne doit plus apparaître');
  });

  await test('the authorization-evidence lookup is scoped by tenant_id and social_account_id, carries the real Pandore Bearer session, and is never triggered for a REVOKED account', async () => {
    const sandbox = runPage({
      fetchImpl: async (url) => {
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_CONNECTED]);
        if (url.includes('/granted-capabilities')) return jsonOk([]);
        if (url.includes('/capabilities/latest-attempt')) return jsonOk({ exists: false });
        if (url.includes('/authorization-evidence')) return jsonOk({ exists: false });
        return jsonOk({});
      },
    });
    await waitForRender();
    const call = sandbox.__calls.find((c) => c.url.includes('/authorization-evidence'));
    assert.ok(call, 'attendu un appel authorization-evidence');
    assert.ok(call.url.includes('/api/admin/tenants/t_fixture/social-accounts/sa_1/authorization-evidence'), `URL inattendue: ${call.url}`);
    assert.strictEqual(call.opts.headers.Authorization, 'Bearer real-pandore-session-token');
    assert.strictEqual(call.opts.method, undefined, 'un GET ne doit jamais spécifier de méthode POST/PUT');

    const sandbox2 = runPage({
      fetchImpl: async (url) => {
        const ACCOUNT_REVOKED = { id: 'sa_2', platform: 'facebook', display_name: 'Old Page', status: 'REVOKED', granted_scopes: [], connected_at: '2026-08-01T10:00:00Z' };
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_REVOKED]);
        if (url.includes('/authorization-evidence')) throw new Error('ne doit jamais être appelé pour un compte révoqué');
        return jsonOk({});
      },
    });
    await waitForRender();
    const revokedCalls = sandbox2.__calls.filter((c) => c.url.includes('/authorization-evidence'));
    assert.strictEqual(revokedCalls.length, 0, 'un compte révoqué ne doit jamais déclencher cette lecture');
  });

  await test('no provider/Meta call and no revalidation occur merely from loading the page (structural: only Pandore admin/session endpoints are ever called)', async () => {
    let sawUnexpected = false;
    const sandbox = runPage({
      fetchImpl: async (url) => {
        if (url.includes('/api/admin/social-accounts?')) return jsonOk([ACCOUNT_CONNECTED]);
        if (url.includes('/granted-capabilities')) return jsonOk([]);
        if (url.includes('/capabilities/latest-attempt')) return jsonOk({ exists: false });
        if (url.includes('/authorization-evidence')) return jsonOk({ exists: false });
        if (url.includes('graph.facebook.com') || url.includes('/capabilities/revalidate')) sawUnexpected = true;
        return jsonOk({});
      },
    });
    await waitForRender();
    assert.strictEqual(sawUnexpected, false, 'un simple chargement de page ne doit jamais déclencher un appel provider ou une revalidation');
    const revalidateCalls = sandbox.__calls.filter((c) => c.url.includes('/capabilities/revalidate'));
    assert.strictEqual(revalidateCalls.length, 0);
  });

  console.log(`\n${passed}/${passed + failed} test(s) passés.`);
  if (failed > 0) process.exit(1);
})();
