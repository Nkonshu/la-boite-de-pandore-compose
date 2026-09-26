// H3-008D1Q36N4A-5D32 — Knowledge Acquisition Candidates : preuve ciblée de la
// logique de public/admin/knowledge-candidates.html (file de revue D30 + décisions
// D28). Même technique vm que test/domain-applicability-ui.test.js : le <script>
// inline de la page est exécuté dans un contexte vm avec un faux DOM et un faux
// fetch — AUCUN réseau réel, AUCUN backend, AUCUN vrai secret (uniquement des
// marqueurs synthétiques).
//
// Usage : node test/knowledge-candidates-ui.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const HTML_PATH = path.join(__dirname, '..', 'public', 'admin', 'knowledge-candidates.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error('knowledge-candidates.html: <script> introuvable — le fichier a-t-il changé de structure ?');
const scriptSource = scriptMatch[1];
const navSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'nav.js'), 'utf8');

const SESSION_TOKEN = 'TOKEN-SESSION-MARKER-0001';
const ADMIN_PW = 'admin-pw-marker';
const CONFIRM_AUTHORIZE = "Autoriser Pandore à demander cette information au client par email ? Pandore revérifie les conditions avant de créer la demande. Aucun email n'est envoyé par cette action seule.";
const CONFIRM_REJECT = 'Rejeter ce candidat ? Décision définitive : Pandore ne le reproposera pas automatiquement pour cette information.';

function fakeElement(id) {
  const classes = new Set();
  const attrs = {};
  return {
    id, value: '', checked: false, disabled: false, style: {}, textContent: '', innerHTML: '', className: '', listeners: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      toggle: (c, force) => { const has = force === undefined ? !classes.has(c) : force; if (has) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return attrs[k]; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    appendChild() {},
  };
}

function fakeStorage(initial) {
  const m = new Map(Object.entries(initial || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), has: (k) => m.has(k) };
}

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

async function settle() { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); }

function item(id, o) {
  return Object.assign({
    candidate_id: id, tenant_id: 't1', status: 'PENDING_REVIEW', requirement_key: 'KEY_' + id, requirement_description: 'Description ' + id,
    cardinality: 'SINGLE', importance: 'REQUIRED', reason: 'UNRESOLVED_BLOCKING_GAP', source_generation_request_id: 'gen-' + id,
    created_at: '2026-09-26T08:00:00Z', decision: null, decided_at: null, decided_by_user_id: null, decided_by_role: null,
  }, o || {});
}

function decision(o) {
  return Object.assign({
    tenant_id: 't1', candidate_id: 'c1', status: 'CLOSED', decision: 'AUTHORIZED', decision_result: 'DECIDED', outcome: 'ACQUISITION_CREATED',
    authorized_channel: 'EMAIL', resulting_clarification_request_id: 'req-1', decided_at: '2026-09-26T10:00:00Z', decided_by_user_id: 'u1', decided_by_role: 'PANDORE_OPERATOR',
  }, o || {});
}

// makeEnv — exécute la page dans un contexte vm. opts.search : location.search ;
// opts.session : null pour aucune session Pandore ; opts.handler(url, opts) : faux backend.
async function makeEnv(opts) {
  opts = opts || {};
  const elements = {};
  const calls = [];
  const confirms = [];
  const env = { elements, calls, confirms, confirmAnswer: true };
  const sessionData = opts.session === null ? {} : { pandore_session: JSON.stringify({ token: SESSION_TOKEN, user: { email: 'operator@example.test', role: 'PANDORE_OPERATOR' } }) };
  const sandbox = {
    document: {
      getElementById(id) { return elements[id] || (elements[id] = fakeElement(id)); },
      head: { appendChild() {} }, createElement() { return { textContent: '' }; },
    },
    localStorage: fakeStorage({ pandore_admin_pw: ADMIN_PW }),
    sessionStorage: fakeStorage(sessionData),
    location: { search: opts.search === undefined ? '?tenant_id=t1&client_name=Client%20Test' : opts.search },
    URLSearchParams, console, Promise, encodeURIComponent, Set, Array, Object, JSON, String, Date,
    confirm(text) { confirms.push(text); return env.confirmAnswer; },
    fetch(url, o) {
      const call = { url: String(url), method: ((o && o.method) || 'GET').toUpperCase(), opts: o || {} };
      calls.push(call);
      if (call.url === '/api/admin/contacts') return Promise.resolve(response(200, []));
      return Promise.resolve((opts.handler || (() => response(200, [])))(call.url, call.opts, call));
    },
  };
  sandbox.window = sandbox;
  env.sandbox = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(navSource, sandbox);
  vm.runInContext(scriptSource, sandbox);
  env.eval = (code) => vm.runInContext(code, sandbox);
  env.el = (id) => sandbox.document.getElementById(id);
  env.body = () => env.el('candidatesBody').innerHTML;
  env.msg = () => env.el('actionMsg');
  env.candidateCalls = (method) => calls.filter((c) => c.url.includes('knowledge-acquisition-candidates') && (!method || c.method === method));
  await settle();
  return env;
}

// Faux backend standard : file PENDING/REJECTED + décisions programmables.
function backend(state) {
  return (url, o) => {
    const u = new URL('http://x' + url);
    const method = ((o && o.method) || 'GET').toUpperCase();
    const m = u.pathname.match(/^\/api\/admin\/tenants\/([^/]+)\/knowledge-acquisition-candidates(?:\/([^/]+)\/(authorize|reject))?$/);
    if (!m) throw new Error('URL inattendue: ' + url);
    if (m[2] === undefined) {
      if (u.searchParams.get('status') === 'REJECTED') return response(200, state.rejected || []);
      return response(200, state.pending || []);
    }
    return state.onDecide ? state.onDecide(m[3], decodeURIComponent(m[2]), o) : response(200, decision());
  };
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS - ${name}`); passed++; }
  catch (err) { console.log(`FAIL - ${name}\n  ${err.message}`); failed++; }
}

function everything(env) {
  return Object.values(env.elements).map((e) => `${e.innerHTML}|${e.textContent}`).join('\n');
}

(async () => {
  // ------------------------------------------------------------------ rendu
  await test('A. initial load: GET without status, rows rendered in backend (FIFO) order, description used, key fallback, actions visible', async () => {
    const state = { pending: [item('cB', { importance: 'OPTIONAL' }), item('cA', { requirement_description: null, importance: 'CRITICAL' }), item('cC', { source_generation_request_id: null })] };
    const env = await makeEnv({ handler: backend(state) });
    const gets = env.candidateCalls('GET');
    assert.strictEqual(gets.length, 1, 'un seul chargement initial');
    assert.strictEqual(gets[0].url, '/api/admin/tenants/t1/knowledge-acquisition-candidates', 'aucun paramètre status pour la vue par défaut');
    const body = env.body();
    const pos = ['cB', 'cA', 'cC'].map((id) => body.indexOf(`data-candidate-id="${id}"`));
    assert.ok(pos.every((p) => p > 0) && pos[0] < pos[1] && pos[1] < pos[2], 'ordre backend conservé (aucun tri, importance comprise)');
    assert.ok(body.includes('Description cB'), 'la description est affichée');
    assert.ok(body.includes('KEY_cB'), 'la clé reste visible en secondaire');
    assert.ok(body.includes('<span class="req-desc">KEY_cA</span>') && !body.includes('Description cA'), 'description null : repli sur la clé');
    assert.ok(body.includes('UNRESOLVED_BLOCKING_GAP'), 'code de raison brut');
    assert.ok(body.includes('gen-cB') && body.includes('—'), 'génération source en texte, « — » si absente (jamais un lien)');
    assert.ok(!/<a\b/.test(body), 'aucun lien fabriqué vers une génération');
    assert.strictEqual((body.match(/data-action="authorize"/g) || []).length, 3);
    assert.strictEqual((body.match(/data-action="reject"/g) || []).length, 3);
    assert.ok(env.el('candidatesHead').innerHTML.includes('Actions') && env.el('candidatesHead').innerHTML.includes('Génération source'));
    assert.strictEqual(env.el('viewTitle').textContent, 'À traiter');
  });

  await test('B. Rejetés view: GET status=REJECTED, decision info shown, NO AUTHORIZE / REJECT anywhere, never called « à traiter »', async () => {
    const state = { pending: [item('c1')], rejected: [item('r1', { status: 'REJECTED', decision: 'REJECTED', decided_at: '2026-09-26T09:00:00Z', decided_by_user_id: 'user-rej-1', decided_by_role: 'PANDORE_SUPER_ADMIN' })] };
    const env = await makeEnv({ handler: backend(state) });
    env.eval("switchView('REJECTED')");
    await settle();
    const gets = env.candidateCalls('GET');
    assert.strictEqual(gets[gets.length - 1].url, '/api/admin/tenants/t1/knowledge-acquisition-candidates?status=REJECTED');
    const body = env.body();
    assert.ok(body.includes('data-candidate-id="r1"') && !body.includes('data-candidate-id="c1"'));
    assert.ok(body.includes('PANDORE_SUPER_ADMIN') && body.includes('user-rej-1'), 'rôle et identifiant de décision affichés');
    assert.ok(!body.includes('data-action') && !body.includes('Autoriser') && !body.includes('Rejeter'), 'aucune action sur une ligne rejetée');
    assert.ok(!env.el('candidatesHead').innerHTML.includes('Actions'));
    assert.strictEqual(env.el('viewTitle').textContent, 'Rejetés');
    assert.ok(!/à traiter/i.test(env.el('viewTitle').textContent + env.el('viewHelp').textContent), 'jamais présenté comme à traiter');
    assert.strictEqual(env.el('viewRejectedBtn').getAttribute('aria-pressed'), 'true');
    // une action reste refusée hors de la vue à traiter, sans POST
    await env.eval("handleAction('authorize', 'r1')");
    assert.strictEqual(env.candidateCalls('POST').length, 0);
    assert.strictEqual(env.confirms.length, 0);
  });

  await test('C. empty states: [] is an ordinary empty message, not an error (both views)', async () => {
    const env = await makeEnv({ handler: backend({ pending: [], rejected: [] }) });
    assert.ok(env.body().includes('Aucun élément à examiner.') && !env.body().includes('error-row'));
    assert.ok(!env.msg().className.includes('err'));
    env.eval("switchView('REJECTED')");
    await settle();
    assert.ok(env.body().includes('Aucun candidat rejeté.') && !env.body().includes('error-row'));
  });

  await test('D. loading: « Chargement… » while the GET is pending', async () => {
    let release;
    const env = await makeEnv({ handler: () => new Promise((r) => { release = () => r(response(200, [item('c1')])); }) });
    assert.ok(env.body().includes('Chargement…'));
    release(); await settle();
    assert.ok(env.body().includes('data-candidate-id="c1"'));
  });

  await test('E. load error: an error row + .msg.err, never an empty list; Rafraîchir re-reads', async () => {
    let fail = true;
    const env = await makeEnv({ handler: () => (fail ? response(500, { error: { code: 'INTERNAL_ERROR', message: 'RAW-SQL-MARKER' } }) : response(200, [item('c1')])) });
    assert.ok(env.body().includes('error-row') && env.body().includes('Lecture impossible pour le moment.'), env.body());
    assert.ok(!env.body().includes('Aucun élément à examiner.'), "une liste vide n'est pas présentée comme un succès");
    assert.ok(env.msg().className.includes('err') && !everything(env).includes('RAW-SQL-MARKER'));
    fail = false;
    await env.el('refreshBtn').listeners.click();
    await settle();
    assert.ok(env.body().includes('data-candidate-id="c1"'));
  });

  await test('F. no tenant_id: no candidate API call, the existing message is shown', async () => {
    const env = await makeEnv({ search: '', handler: backend({ pending: [item('c1')] }) });
    assert.strictEqual(env.candidateCalls().length, 0);
    assert.strictEqual(env.el('noTenantMsg').style.display, 'block');
    assert.strictEqual(env.el('queuePanel').style.display, 'none');
    assert.ok(env.el('adminNav').innerHTML.includes('Connaissances à valider'));
  });

  await test('G. AdminNav: zone clients, breadcrumb « <client> › Connaissances à valider », tenant id fallback without client_name', async () => {
    let env = await makeEnv({ handler: backend({}) });
    const nav = env.el('adminNav').innerHTML;
    assert.ok(nav.includes('Client Test') && nav.includes('Connaissances à valider') && nav.includes('href="/admin/index.html" class="admin-zone-tab active"'));
    assert.strictEqual(env.el('clientNameHeading').textContent, 'Client Test');
    env = await makeEnv({ search: '?tenant_id=t1', handler: backend({}) });
    assert.strictEqual(env.el('clientNameHeading').textContent, 't1');
    assert.ok(env.el('adminNav').innerHTML.includes('t1'));
    assert.strictEqual(env.candidateCalls().filter((c) => c.url.includes('/tenants/t1')).length >= 1, true);
  });

  await test('H. URLs: tenant and candidate ids are encoded; exact D30/D28 relay paths', async () => {
    const env = await makeEnv({ search: '?tenant_id=t%2Fx&client_name=N', handler: backend({ pending: [] }) });
    assert.strictEqual(env.candidateCalls('GET')[0].url, '/api/admin/tenants/t%2Fx/knowledge-acquisition-candidates');
    assert.strictEqual(typeof env.eval("authorizeCandidate('t 1', 'c/1')").then, 'function');
    assert.strictEqual(typeof env.eval("rejectCandidate('t 1', 'c/1')").then, 'function');
    await settle();
    const posts = env.candidateCalls('POST').map((c) => c.url);
    assert.deepStrictEqual(posts, [
      '/api/admin/tenants/t%201/knowledge-acquisition-candidates/c%2F1/authorize',
      '/api/admin/tenants/t%201/knowledge-acquisition-candidates/c%2F1/reject',
    ]);
  });

  // ---------------------------------------------------------------- actions
  await test('I. AUTHORIZE happy path: confirm text exact, ONE POST without body/Content-Type, refetch, success message AFTER the refetch, no « email envoyé »', async () => {
    const state = { pending: [item('c1')] };
    const env = await makeEnv({ handler: backend(state) });
    state.pending = []; // la relecture après décision ne renvoie plus le candidat
    await env.eval("handleAction('authorize', 'c1')");
    assert.deepStrictEqual(env.confirms, [CONFIRM_AUTHORIZE]);
    const posts = env.candidateCalls('POST');
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].url, '/api/admin/tenants/t1/knowledge-acquisition-candidates/c1/authorize');
    assert.ok(!('body' in posts[0].opts), 'aucun body (ni {}, ni chaîne vide)');
    const headerKeys = Object.keys(posts[0].opts.headers).map((k) => k.toLowerCase()).sort();
    assert.deepStrictEqual(headerKeys, ['authorization', 'x-admin-password'], 'aucun Content-Type');
    assert.strictEqual(posts[0].opts.headers.Authorization, `Bearer ${SESSION_TOKEN}`);
    assert.strictEqual(env.candidateCalls('GET').length, 2, 'relecture après succès');
    assert.strictEqual(env.msg().textContent, "Demande d'information créée.");
    assert.ok(env.msg().className.includes('ok'));
    assert.ok(!/email envoy|envoy.{0,12}email|a été envoy/i.test(env.msg().textContent), "jamais « email envoyé »");
    assert.ok(env.body().includes('Aucun élément à examiner.'), 'la ligne décidée a disparu de la file');
    assert.strictEqual(env.eval('actionInFlight'), false);
    assert.ok(!/envoy/i.test(env.eval('OUTCOME_MESSAGES.ACQUISITION_CREATED')), 'aucun message de succès ne prétend un envoi');
  });

  await test('J. all nine outcomes map to their exact explicit message; an unknown outcome gets a generic success without invented meaning', async () => {
    const expected = {
      ACQUISITION_CREATED: "Demande d'information créée.",
      NOT_NEEDED_ALREADY_KNOWN: "Aucune demande nécessaire : l'information est déjà connue.",
      ALREADY_PENDING: 'Une demande est déjà en cours pour cette information.',
      SUPPRESSED_ANSWERED_UNKNOWN: "Aucune demande : le client a déjà répondu qu'il ne sait pas.",
      SUPPRESSED_DELIVERED_UNANSWERED: 'Aucune demande : une demande précédente est restée sans réponse.',
      SUPPRESSED_UNSUPPORTED_REFRESH: "Aucune demande : la mise à jour de cette information n'est pas gérée automatiquement.",
      NO_LONGER_APPLICABLE: "Aucune demande : cette information ne s'applique plus à ce client.",
      NO_LONGER_CLIENT_OWNED: "Aucune demande : cette information n'est plus à demander au client.",
      METADATA_CHANGED: 'Aucune demande : la définition de cette information a changé.',
    };
    for (const [outcome, message] of Object.entries(expected)) {
      const env = await makeEnv({ handler: backend({ pending: [item('c1')], onDecide: () => response(200, decision({ outcome })) }) });
      await env.eval("handleAction('authorize', 'c1')");
      assert.strictEqual(env.msg().textContent, message, outcome);
    }
    const env = await makeEnv({ handler: backend({ pending: [item('c1')], onDecide: () => response(200, decision({ outcome: 'SOMETHING_NEW' })) }) });
    await env.eval("handleAction('authorize', 'c1')");
    assert.strictEqual(env.msg().textContent, 'Décision enregistrée.');
    assert.ok(env.msg().className.includes('ok'));
  });

  await test('K. REJECT happy path: confirm text exact, ONE POST without body, refetch, « Candidat rejeté. »', async () => {
    const state = { pending: [item('c1')], onDecide: () => response(200, decision({ status: 'REJECTED', decision: 'REJECTED', outcome: null, authorized_channel: null, resulting_clarification_request_id: null })) };
    const env = await makeEnv({ handler: backend(state) });
    await env.eval("handleAction('reject', 'c1')");
    assert.deepStrictEqual(env.confirms, [CONFIRM_REJECT]);
    const posts = env.candidateCalls('POST');
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].url, '/api/admin/tenants/t1/knowledge-acquisition-candidates/c1/reject');
    assert.ok(!('body' in posts[0].opts));
    assert.strictEqual(env.candidateCalls('GET').length, 2);
    assert.strictEqual(env.msg().textContent, 'Candidat rejeté.');
  });

  await test('L. cancelled confirmation: NO POST, no lasting in-flight, table and message unchanged (both actions)', async () => {
    const env = await makeEnv({ handler: backend({ pending: [item('c1')] }) });
    env.confirmAnswer = false;
    const before = env.body();
    for (const action of ['authorize', 'reject']) {
      await env.eval(`handleAction('${action}', 'c1')`);
      assert.strictEqual(env.candidateCalls('POST').length, 0);
      assert.strictEqual(env.eval('actionInFlight'), false);
      assert.strictEqual(env.body(), before);
      assert.strictEqual(env.msg().textContent, '');
    }
    assert.deepStrictEqual(env.confirms, [CONFIRM_AUTHORIZE, CONFIRM_REJECT]);
    assert.strictEqual(env.candidateCalls('GET').length, 1, 'aucune relecture');
  });

  await test('M. replay (REPLAYED_SAME_DECISION) is an idempotent SUCCESS: outcome message, refetch, no error', async () => {
    const env = await makeEnv({ handler: backend({ pending: [item('c1')], onDecide: () => response(200, decision({ decision_result: 'REPLAYED_SAME_DECISION', outcome: 'ALREADY_PENDING' })) }) });
    await env.eval("handleAction('authorize', 'c1')");
    assert.strictEqual(env.msg().textContent, 'Une demande est déjà en cours pour cette information.');
    assert.ok(env.msg().className.includes('ok') && !env.msg().className.includes('err'));
    assert.strictEqual(env.candidateCalls('GET').length, 2);
    // rejeu d'un rejet
    const env2 = await makeEnv({ handler: backend({ pending: [item('c1')], onDecide: () => response(200, decision({ decision_result: 'REPLAYED_SAME_DECISION', status: 'REJECTED', decision: 'REJECTED', outcome: null })) }) });
    await env2.eval("handleAction('reject', 'c1')");
    assert.strictEqual(env2.msg().textContent, 'Candidat rejeté.');
    assert.strictEqual(env2.candidateCalls('GET').length, 2);
  });

  await test('N. 409: fixed message, refetch, NO automatic retry of the action (one POST), backend text ignored', async () => {
    const env = await makeEnv({ handler: backend({ pending: [item('c1')], onDecide: () => response(409, { error: { code: 'KNOWLEDGE_ACQUISITION_CANDIDATE_ALREADY_DECIDED', message: 'MARKER-BACKEND-TEXT' } }) }) });
    await env.eval("handleAction('authorize', 'c1')");
    assert.strictEqual(env.msg().textContent, 'Ce candidat a déjà été décidé par un autre opérateur ou par une décision opposée.');
    assert.ok(env.msg().className.includes('err'));
    assert.strictEqual(env.candidateCalls('POST').length, 1, 'aucun retry automatique');
    assert.strictEqual(env.candidateCalls('GET').length, 2, 'relecture après 409');
    assert.ok(!everything(env).includes('MARKER-BACKEND-TEXT'));
  });

  await test('O. 404 on an action: « Candidat introuvable. » and refetch', async () => {
    const env = await makeEnv({ handler: backend({ pending: [item('c1')], onDecide: () => response(404, { error: { code: 'NOT_FOUND', message: 'x' } }) }) });
    await env.eval("handleAction('reject', 'c1')");
    assert.strictEqual(env.msg().textContent, 'Candidat introuvable.');
    assert.strictEqual(env.candidateCalls('GET').length, 2);
    assert.strictEqual(env.candidateCalls('POST').length, 1);
  });

  await test('P. the five 422 codes: exact French message, row KEPT (pending), no refetch, no terminal state, no retry, actions re-enabled', async () => {
    const messages = {
      APPLICABILITY_UNKNOWN: "Impossible pour le moment : l'applicabilité doit être déterminée.",
      NO_ELIGIBLE_QUESTION_BRICK: "Aucune question compatible n'est disponible.",
      AMBIGUOUS_QUESTION_BRICK_SELECTION: 'Plusieurs questions compatibles empêchent une sélection sûre.',
      NO_VERIFIED_EMAIL_CONTACT: "Aucun contact email vérifié n'est disponible.",
      AMBIGUOUS_VERIFIED_EMAIL_CONTACT: 'Plusieurs contacts email vérifiés empêchent une sélection sûre.',
    };
    for (const [code, message] of Object.entries(messages)) {
      const env = await makeEnv({ handler: backend({ pending: [item('c1')], onDecide: () => response(422, { error: { code, message: 'MARKER-BACKEND-TEXT' } }) }) });
      const before = env.eval('candidates.length');
      await env.eval("handleAction('authorize', 'c1')");
      assert.strictEqual(env.msg().textContent, message, code);
      assert.ok(env.msg().className.includes('err'));
      assert.ok(env.body().includes('data-candidate-id="c1"'), 'la ligne est conservée');
      assert.strictEqual(env.eval('candidates.length'), before);
      assert.strictEqual(env.candidateCalls('GET').length, 1, 'aucune relecture obligatoire, aucun état terminal simulé');
      assert.strictEqual(env.candidateCalls('POST').length, 1, 'aucune nouvelle tentative automatique');
      assert.ok(env.body().includes('data-action="authorize"') && !env.body().includes('disabled'), 'actions réactivées');
      assert.ok(!everything(env).includes('MARKER-BACKEND-TEXT'));
    }
  });

  await test('Q. technical errors (500, 502 string envelope, network failure): generic message, row kept, no raw text, manual refresh available', async () => {
    const cases = [
      () => response(500, { error: { code: 'INTERNAL_ERROR', message: 'RAW-SQL-MARKER select * from x' } }),
      () => response(502, { error: 'Décision impossible pour le moment RAW-UPSTREAM-MARKER http://pandore-fake.test:4000' }),
      () => { throw new Error('connect ECONNREFUSED RAW-NETWORK-MARKER'); },
    ];
    for (const onDecide of cases) {
      const env = await makeEnv({ handler: backend({ pending: [item('c1')], onDecide }) });
      await env.eval("handleAction('authorize', 'c1')");
      assert.strictEqual(env.msg().textContent, 'Une erreur technique est survenue.');
      assert.ok(env.body().includes('data-candidate-id="c1"'), 'la ligne est conservée');
      assert.strictEqual(env.candidateCalls('GET').length, 1);
      const all = everything(env);
      for (const marker of ['RAW-SQL-MARKER', 'RAW-UPSTREAM-MARKER', 'RAW-NETWORK-MARKER', 'select * from', 'pandore-fake']) assert.ok(!all.includes(marker), marker);
      await env.el('refreshBtn').listeners.click();
      await settle();
      assert.strictEqual(env.candidateCalls('GET').length, 2, 'rafraîchissement manuel possible');
    }
  });

  await test('R. double submit: a second click while the POST is pending sends NO second POST; all row actions disabled; state restored afterwards', async () => {
    let release;
    const state = { pending: [item('c1'), item('c2')], onDecide: () => new Promise((r) => { release = () => r(response(200, decision())); }) };
    const env = await makeEnv({ handler: backend(state) });
    const first = env.eval("handleAction('authorize', 'c1')");
    const second = env.eval("handleAction('reject', 'c2')");   // autre ligne, même page
    const third = env.el('candidatesBody').listeners.click({ target: { closest: () => ({ disabled: false, getAttribute: (k) => (k === 'data-action' ? 'authorize' : 'c1') }) } });
    await settle();
    assert.strictEqual(env.candidateCalls('POST').length, 1, 'un seul POST malgré trois clics');
    assert.strictEqual(env.eval('actionInFlight'), true);
    assert.strictEqual((env.body().match(/ disabled/g) || []).length, 4, 'les deux actions des DEUX lignes sont désactivées');
    assert.strictEqual(env.confirms.length, 1, "un clic ignoré n'ouvre même pas la confirmation");
    state.pending = [item('c2')];
    release();
    await Promise.all([first, second, third]);
    await settle();
    assert.strictEqual(env.eval('actionInFlight'), false);
    assert.ok(!env.body().includes(' disabled') && env.body().includes('data-action="authorize"'), 'état restauré');
  });

  await test('S. view-switch race: a late PENDING response never replaces the current REJECTED view', async () => {
    let releasePending;
    let firstPendingCall = true;
    const handler = (url) => {
      if (url.includes('status=REJECTED')) return response(200, [item('r1', { status: 'REJECTED', decision: 'REJECTED', decided_at: '2026-09-26T09:00:00Z', decided_by_role: 'PANDORE_OPERATOR', decided_by_user_id: 'u9' })]);
      if (firstPendingCall) { firstPendingCall = false; return new Promise((r) => { releasePending = () => r(response(200, [item('LATE')])); }); }
      return response(200, [item('LATE')]);
    };
    const env = await makeEnv({ handler });          // le chargement initial PENDING reste en attente
    env.eval("switchView('REJECTED')");              // puis la vue Rejetés répond vite
    await settle();
    assert.ok(env.body().includes('data-candidate-id="r1"'));
    releasePending();                                // la réponse PENDING ancienne arrive APRÈS
    await settle();
    assert.strictEqual(env.eval('currentView'), 'REJECTED');
    assert.ok(env.body().includes('data-candidate-id="r1"') && !env.body().includes('LATE'), 'la vue courante est conservée');
    assert.ok(!env.body().includes('data-action'));
  });

  await test('T. error branching reads err.code / err.status, NEVER err.message', async () => {
    const env = await makeEnv({ handler: backend({}) });
    const same = env.eval("describeActionError({ status: 422, code: 'NO_VERIFIED_EMAIL_CONTACT', message: 'texte quelconque' })");
    const other = env.eval("describeActionError({ status: 422, code: 'NO_VERIFIED_EMAIL_CONTACT', message: 'un tout autre texte' })");
    assert.deepStrictEqual(JSON.parse(JSON.stringify(same)), JSON.parse(JSON.stringify(other)));
    // un message qui RESSEMBLE à un texte connu, sans code : jamais interprété
    const lookalike = env.eval("describeActionError({ status: 500, message: 'Ce candidat a déjà été décidé par un autre opérateur ou par une décision opposée.' })");
    assert.strictEqual(lookalike.message, 'Une erreur technique est survenue.');
    assert.strictEqual(lookalike.refetch, false);
    // 403 par le statut, message ignoré
    assert.strictEqual(env.eval("describeActionError({ status: 403, message: 'permission manquante: x' })").message, 'Accès refusé.');
    // le code est conservé par le wrapper API
    const env2 = await makeEnv({ handler: () => response(409, { error: { code: 'KNOWLEDGE_ACQUISITION_CANDIDATE_ALREADY_DECIDED', message: 'm' } }) });
    const err = await env2.eval("apiWithPandoreSession('/api/x').catch(e => e)");
    assert.strictEqual(err.code, 'KNOWLEDGE_ACQUISITION_CANDIDATE_ALREADY_DECIDED');
    assert.strictEqual(err.status, 409);
    // garde source : describeActionError ne lit jamais .message
    const fn = scriptSource.match(/function describeActionError\(err\) \{[\s\S]*?\n\}/)[0];
    assert.ok(!/\.message\b/.test(fn.replace(/\{ message:/g, '').replace(/return \{ message/g, '')), 'describeActionError ne doit pas lire err.message');
  });

  await test('U. auth: Pandore-session 401 clears ONLY the session (login bar); admin-password 401 clears ONLY the password (gate); 403 -> « Accès refusé. »', async () => {
    let env = await makeEnv({ handler: () => response(401, { error: { code: 'UNAUTHORIZED', message: 'session invalide' } }) });
    assert.ok(!env.sandbox.sessionStorage.has('pandore_session'), 'session Pandore retirée');
    assert.ok(env.sandbox.localStorage.has('pandore_admin_pw'), 'mot de passe admin conservé');
    assert.ok(env.el('pandoreSessionBar').innerHTML.includes('Connexion Pandore'), 'barre de connexion re-rendue');
    env = await makeEnv({ handler: () => response(401, { error: 'Non autorisé' }) });
    assert.ok(!env.sandbox.localStorage.has('pandore_admin_pw'), 'mot de passe admin retiré');
    assert.ok(env.sandbox.sessionStorage.has('pandore_session'), 'session Pandore conservée');
    assert.strictEqual(env.el('gate').style.display, 'flex', 'porte legacy affichée');
    env = await makeEnv({ handler: backend({ pending: [item('c1')], onDecide: () => response(403, { error: { code: 'FORBIDDEN', message: 'permission manquante: manage_tenant_knowledge' } }) }) });
    await env.eval("handleAction('authorize', 'c1')");
    assert.strictEqual(env.msg().textContent, 'Accès refusé.');
    assert.ok(env.body().includes('data-candidate-id="c1"'), 'la ligne reste inchangée');
    assert.ok(!everything(env).includes('manage_tenant_knowledge'));
    env = await makeEnv({ handler: () => response(403, { error: { code: 'FORBIDDEN', message: 'permission manquante' } }) });
    assert.ok(env.body().includes('Accès refusé.') && env.body().includes('error-row'), 'lecture refusée : message fixe, pas de liste');
    env = await makeEnv({ session: null, handler: backend({ pending: [item('c1')] }) });
    assert.strictEqual(env.candidateCalls().length, 0, 'sans session Pandore : aucun appel');
    assert.ok(env.el('pandoreSessionBar').innerHTML.includes('Connexion Pandore'));
  });

  await test('V. privacy: contact/token/raw-message markers planted in fixtures and errors never reach the visible DOM; the bearer token is never rendered', async () => {
    const dirty = (id, extra) => item(id, Object.assign({
      contact_email: 'MARKER-CONTACT@example.test', token: 'MARKER-TOKEN-XYZ', knowledge_value: 'MARKER-KNOWLEDGE', raw_message: 'MARKER-RAW-BACKEND',
      question_brick_text: 'MARKER-BRICK', prompt: 'MARKER-PROMPT',
    }, extra || {}));
    const state = {
      pending: [dirty('c1'), dirty('c2')], rejected: [dirty('r1', { status: 'REJECTED', decision: 'REJECTED', decided_at: '2026-09-26T09:00:00Z', decided_by_role: 'PANDORE_OPERATOR', decided_by_user_id: 'u1' })],
      onDecide: () => response(422, { error: { code: 'NO_VERIFIED_EMAIL_CONTACT', message: 'MARKER-RAW-BACKEND MARKER-CONTACT@example.test', contact: 'MARKER-CONTACT@example.test' } }),
    };
    const env = await makeEnv({ handler: backend(state) });
    await env.eval("handleAction('authorize', 'c1')");
    env.eval("switchView('REJECTED')");
    await settle();
    const all = everything(env);
    for (const marker of ['MARKER-CONTACT', 'MARKER-TOKEN-XYZ', 'MARKER-KNOWLEDGE', 'MARKER-RAW-BACKEND', 'MARKER-BRICK', 'MARKER-PROMPT', SESSION_TOKEN, ADMIN_PW]) {
      assert.ok(!all.includes(marker), `${marker} ne doit jamais apparaître dans le DOM`);
    }
  });

  await test('W. source guards: no client sort/ranking, no CLOSED, no polling/WebSocket/SSE, no i18n, no secret, no client-side catalog, no contact display', async () => {
    const code = scriptSource.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/\.sort\(|\.toSorted\(|\.reverse\(/.test(code), 'aucun tri côté client');
    assert.ok(!/CLOSED/.test(html.replace(scriptSource, code)), 'aucune référence à CLOSED dans le balisage ni le code (hors commentaires)');
    assert.ok(!/setInterval|setTimeout|WebSocket|EventSource|requestAnimationFrame/.test(code), 'aucun polling/WebSocket/SSE');
    assert.ok(!/i18n|intl-messageformat|translations|locale\s*[:=]/i.test(code), 'aucune i18n');
    assert.ok(!/x-internal-secret|INTERNAL_SECRET|Bearer [A-Za-z0-9._-]{8,}/.test(code), 'aucun secret codé en dur');
    assert.ok(!/contact_email|\.email\b.*candidate|client_contact/i.test(code.replace(/session\.user\.email/g, '')), 'aucune donnée contact demandée');
    assert.ok(!/const\s+(REQUIREMENT_DESCRIPTIONS|REQUIREMENT_CATALOG|DESCRIPTIONS)\b/.test(code), 'aucun catalogue de descriptions côté client');
    assert.ok(!/importance[^\n]*(sort|score|rank|urgent)/i.test(code), "l'importance n'est jamais un classement");
    assert.ok(!/status=CLOSED|VIEW_CLOSED/.test(code));
    // switchView refuse tout ce qui n'est pas PENDING_REVIEW / REJECTED (jamais de requête CLOSED)
    const env = await makeEnv({ handler: backend({ pending: [item('c1')] }) });
    const getsBefore = env.candidateCalls('GET').length;
    env.eval("switchView('CLOSED')");
    await settle();
    assert.strictEqual(env.candidateCalls('GET').length, getsBefore);
    assert.strictEqual(env.eval('currentView'), 'PENDING_REVIEW');
    // le POST des actions ne construit ni body, ni JSON.stringify, ni Content-Type
    for (const fn of ['authorizeCandidate', 'rejectCandidate']) {
      const src = scriptSource.match(new RegExp(`function ${fn}\\([\\s\\S]*?\\n\\}`))[0];
      assert.ok(!/body|JSON\.stringify|Content-Type/.test(src), `${fn} ne doit envoyer aucun corps`);
    }
  });

  await test('X. success ordering: the refetch runs BEFORE the success message is set (feedback is never erased by the reload)', async () => {
    let seen = null;
    let gets = 0;
    const base = backend({ pending: [item('c1')] });
    const env = await makeEnv({
      handler: (url, o) => {
        if (!(o && o.method === 'POST')) { gets++; if (gets === 2) seen = env.msg().textContent; }
        return base(url, o);
      },
    });
    await env.eval("handleAction('authorize', 'c1')");
    assert.strictEqual(seen, 'Enregistrement…', "pendant la relecture, le message de succès n'est pas encore posé");
    assert.strictEqual(env.msg().textContent, "Demande d'information créée.", 'le message final est le succès');
  });

  console.log(`\n${passed}/${passed + failed} test(s) passés.`);
  if (failed > 0) process.exit(1);
})();
