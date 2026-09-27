// H3-008D1Q36N4A5D58F1 — page publique de clarification : contrat de réponse STRUCTURÉE.
// Même technique vm que test/knowledge-candidates-ui.test.js : le <script> inline de
// public/clarification/index.html est exécuté dans un contexte vm avec un faux DOM et un faux fetch —
// AUCUN réseau réel, AUCUN backend, AUCUN vrai jeton (uniquement des marqueurs synthétiques).
//
// Le faux GET reproduit le DTO Go public actuel (internal/httpapi/clarification_requests.go,
// publicClarificationView) : { status, expires_at, questions: [ { ref, prompt, allowed_states? } ] }.
//
// Usage : node test/public-clarification-ui.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const HTML_PATH = path.join(__dirname, '..', 'public', 'clarification', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error('clarification/index.html: <script> introuvable — le fichier a-t-il changé de structure ?');
const scriptSource = scriptMatch[1];

const TOKEN = 'FIXTURE-TOKEN-MARKER-0001';
const GET_URL = `/api/public/clarifications/${TOKEN}`;
const POST_URL = `/api/public/clarifications/${TOKEN}/response`;
const GONE = "Ce lien n'est plus valide.";

function fakeElement(id) {
  const classes = new Set();
  return {
    id, value: '', checked: false, disabled: false, style: {}, textContent: '', innerHTML: '', className: '', listeners: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      toggle: (c, force) => { const has = force === undefined ? !classes.has(c) : force; if (has) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    setAttribute() {}, getAttribute() { return null; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
  };
}

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

async function settle() { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); }

// Réponse GET réaliste, alignée sur le DTO Go (status PENDING => allowed_states présents).
const KNOWLEDGE = ['ANSWERED_WITH_VALUE', 'UNKNOWN'];
const NON_KNOWLEDGE = ['ANSWERED_WITH_VALUE'];
function view(questions, status) {
  return { status: status || 'PENDING', expires_at: '2099-01-01T00:00:00Z', questions };
}
function q(ref, allowed, prompt) {
  const o = { ref, prompt: prompt || `Question ${ref} ?` };
  if (allowed !== undefined) o.allowed_states = allowed;
  return o;
}

// makeEnv — opts.get : { status, body } renvoyé par le GET ; opts.post : (call) => réponse (ou promesse).
async function makeEnv(opts) {
  opts = opts || {};
  const elements = { app: fakeElement('app') };
  const calls = [];
  const consoleCalls = [];
  const replaced = [];
  const env = { elements, calls, consoleCalls, replaced };
  const sandbox = {
    document: {
      title: 'Précisions demandées',
      getElementById(id) { return elements[id] || (elements[id] = fakeElement(id)); },
    },
    location: { search: opts.search === undefined ? `?token=${TOKEN}` : opts.search, pathname: '/clarification/' },
    URLSearchParams, Promise, encodeURIComponent, Set, Array, Object, JSON, String, Error,
    console: {
      log: (...a) => consoleCalls.push(a), error: (...a) => consoleCalls.push(a), warn: (...a) => consoleCalls.push(a), info: (...a) => consoleCalls.push(a),
    },
    fetch(url, o) {
      const call = { url: String(url), method: ((o && o.method) || 'GET').toUpperCase(), opts: o || {} };
      calls.push(call);
      if (call.method === 'GET') {
        if (opts.getThrows) return Promise.reject(new Error('network'));
        const g = opts.get || { status: 200, body: view([q('R1', KNOWLEDGE)]) };
        return Promise.resolve(response(g.status, g.body));
      }
      if (opts.postThrows) return Promise.reject(new Error('network'));
      return Promise.resolve((opts.post || (() => response(200, { status: 'réponse enregistrée' })))(call));
    },
  };
  sandbox.window = { history: { replaceState: (...a) => replaced.push(a) } };
  env.sandbox = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(scriptSource, sandbox);
  env.el = (id) => sandbox.document.getElementById(id);
  // le vrai DOM rend &#39; en apostrophe : on compare le texte visible, pas l'entité.
  env.app = () => elements.app.innerHTML.replace(/&#39;/g, "'");
  env.posts = () => calls.filter((c) => c.method === 'POST');
  env.type = (i, text) => { env.el(`answer-${i}`).value = text; };
  env.check = (i, on) => { const box = env.el(`unknown-${i}`); box.checked = on; if (box.listeners.change) box.listeners.change(); };
  env.click = () => env.el('submit-btn').listeners.click();
  env.body = (call) => JSON.parse(call.opts.body);
  await settle();
  return env;
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS - ${name}`); passed++; }
  catch (err) { console.log(`FAIL - ${name}\n  ${err.message}`); failed++; }
}

(async () => {
  // ----------------------------------------------------------------- valeur / UNKNOWN / vide
  await test('1. knowledge question, value typed -> exactly ONE POST {question_ref, state: ANSWERED_WITH_VALUE, text: exact value}', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([q('REF_ONE', KNOWLEDGE)]) } });
    assert.ok(env.app().includes('id="answer-0"') && env.app().includes('id="unknown-0"'), 'textarea + option « Je ne sais pas »');
    env.type(0, 'https://example.test/app');
    await env.click(); await settle();
    assert.strictEqual(env.posts().length, 1);
    assert.strictEqual(env.posts()[0].url, POST_URL);
    assert.strictEqual(env.posts()[0].opts.headers['Content-Type'], 'application/json');
    assert.deepStrictEqual(env.body(env.posts()[0]), { answers: [{ question_ref: 'REF_ONE', state: 'ANSWERED_WITH_VALUE', text: 'https://example.test/app' }] });
  });

  await test('2. « Je ne sais pas » chosen -> exactly ONE POST {state: UNKNOWN} with NO text key (even if a value was typed first)', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([q('REF_ONE', KNOWLEDGE)]) } });
    env.type(0, 'valeur tapée puis abandonnée');
    env.check(0, true);
    assert.strictEqual(env.el('answer-0').disabled, true, 'le champ est désactivé quand UNKNOWN est choisi');
    await env.click(); await settle();
    assert.strictEqual(env.posts().length, 1);
    const body = env.body(env.posts()[0]);
    assert.deepStrictEqual(body, { answers: [{ question_ref: 'REF_ONE', state: 'UNKNOWN' }] });
    assert.ok(!('text' in body.answers[0]), 'UNKNOWN ne porte AUCUN texte');
    env.check(0, false);
    assert.strictEqual(env.el('answer-0').disabled, false, 'décocher réactive le champ');
  });

  await test('3. empty value and UNKNOWN not chosen -> NO POST, validation shown (also whitespace only)', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([q('REF_ONE', KNOWLEDGE)]) } });
    await env.click(); await settle();
    assert.strictEqual(env.posts().length, 0);
    assert.ok(env.el('req-0').classList.contains('show') && env.el('req-0').textContent.length > 0, 'message de validation visible');
    env.type(0, '   \n\t ');
    await env.click(); await settle();
    assert.strictEqual(env.posts().length, 0, 'un blanc n\'est jamais ANSWERED_WITH_VALUE');
    assert.strictEqual(env.calls.filter((c) => c.method === 'POST').length, 0);
  });

  await test('4. UNKNOWN NOT in allowed_states -> no « Je ne sais pas » option, and UNKNOWN can never be produced', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([q('REF_ONE', NON_KNOWLEDGE)]) } });
    assert.ok(!env.app().includes('id="unknown-0"') && !env.app().includes('Je ne sais pas</label>') && !/type="checkbox"/.test(env.app()), env.app());
    env.type(0, 'texte');
    await env.click(); await settle();
    assert.deepStrictEqual(env.body(env.posts()[0]), { answers: [{ question_ref: 'REF_ONE', state: 'ANSWERED_WITH_VALUE', text: 'texte' }] });
    const env2 = await makeEnv({ get: { status: 200, body: view([q('REF_ONE', NON_KNOWLEDGE)]) } });
    await env2.click(); await settle();
    assert.strictEqual(env2.posts().length, 0, 'champ vide : aucune requête, jamais UNKNOWN automatique');
  });

  await test('5. only UNKNOWN announced (no value state) -> no textarea; submit needs the explicit choice', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([q('REF_ONE', ['UNKNOWN'])]) } });
    assert.ok(!env.app().includes('id="answer-0"') && env.app().includes('id="unknown-0"'));
    await env.click(); await settle();
    assert.strictEqual(env.posts().length, 0);
    env.check(0, true);
    await env.click(); await settle();
    assert.deepStrictEqual(env.body(env.posts()[0]), { answers: [{ question_ref: 'REF_ONE', state: 'UNKNOWN' }] });
  });

  await test('6. no allowed_states (legacy text-only question) -> payload {question_ref, text} with NO state; empty blocked', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([q('REF_L', undefined)]) } });
    assert.ok(!env.app().includes('id="unknown-0"'));
    await env.click(); await settle();
    assert.strictEqual(env.posts().length, 0);
    env.type(0, 'réponse libre');
    await env.click(); await settle();
    const body = env.body(env.posts()[0]);
    assert.deepStrictEqual(body, { answers: [{ question_ref: 'REF_L', text: 'réponse libre' }] });
    assert.ok(!('state' in body.answers[0]), "aucun état inventé quand le backend n'en annonce pas");
  });

  await test('7. mixed request: each question follows ITS OWN metadata (knowledge value + non-knowledge + UNKNOWN + legacy)', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([q('A', KNOWLEDGE), q('B', NON_KNOWLEDGE), q('C', KNOWLEDGE), q('D')]) } });
    env.type(0, 'valeur A'); env.type(1, 'valeur B'); env.check(2, true); env.type(3, 'valeur D');
    await env.click(); await settle();
    assert.strictEqual(env.posts().length, 1);
    assert.deepStrictEqual(env.body(env.posts()[0]), { answers: [
      { question_ref: 'A', state: 'ANSWERED_WITH_VALUE', text: 'valeur A' },
      { question_ref: 'B', state: 'ANSWERED_WITH_VALUE', text: 'valeur B' },
      { question_ref: 'C', state: 'UNKNOWN' },
      { question_ref: 'D', text: 'valeur D' },
    ] });
  });

  await test('8. one unanswered question among several blocks the WHOLE submission (no partial POST)', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([q('A', KNOWLEDGE), q('B', KNOWLEDGE)]) } });
    env.type(0, 'ok');
    await env.click(); await settle();
    assert.strictEqual(env.posts().length, 0);
    assert.ok(!env.el('req-0').classList.contains('show') && env.el('req-1').classList.contains('show'));
  });

  await test('9. payload built from the model only: no tenant, contact, actor or admin field; token only in the route', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([q('REF_ONE', KNOWLEDGE)]) } });
    env.type(0, 'v');
    await env.click(); await settle();
    const call = env.posts()[0];
    assert.deepStrictEqual(Object.keys(env.body(call)), ['answers']);
    assert.deepStrictEqual(Object.keys(env.body(call).answers[0]).sort(), ['question_ref', 'state', 'text']);
    assert.ok(!call.opts.body.includes(TOKEN), 'le jeton ne figure pas dans le corps');
    assert.deepStrictEqual(Object.keys(call.opts.headers), ['Content-Type'], 'aucun en-tête admin');
  });

  // ----------------------------------------------------------------- généricité (comportementale)
  // Fixtures 100 % synthétiques : les refs et les « origines » n'ont aucune signification métier.
  const GENERIC_REFS = ['GENERIC_REQUIREMENT_ALPHA', 'GENERIC_REQUIREMENT_BETA', 'GENERIC_REQUIREMENT_GAMMA'];
  const GENERIC_PROMPT = 'Question générique ?';
  const genericQuestion = (ref, allowed, i) => Object.assign(q(ref, allowed, GENERIC_PROMPT), { origin: `synthetic-origin-${i}`, source: `synthetic-source-${i}` });
  const genericView = (ref, allowed, i) => ({ get: { status: 200, body: view([genericQuestion(ref, allowed, i)]) } });

  await test('10a. behavioural invariance (value): different refs/origins, same allowed_states -> identical rendering and identical structural payload', async () => {
    for (const allowed of [KNOWLEDGE, NON_KNOWLEDGE]) {
      const rendered = [], sent = [];
      for (let i = 0; i < GENERIC_REFS.length; i++) {
        const env = await makeEnv(genericView(GENERIC_REFS[i], allowed, i));
        rendered.push(env.app());
        env.type(0, 'valeur synthétique');
        await env.click(); await settle();
        assert.strictEqual(env.posts().length, 1);
        sent.push(env.body(env.posts()[0]));
      }
      assert.strictEqual(new Set(rendered).size, 1, "le rendu ne dépend ni de la ref ni de l'origine");
      sent.forEach((body, i) => {
        assert.deepStrictEqual(body, { answers: [{ question_ref: GENERIC_REFS[i], state: 'ANSWERED_WITH_VALUE', text: 'valeur synthétique' }] });
      });
    }
  });

  await test('10b. behavioural invariance (UNKNOWN): offered iff announced in allowed_states, for every synthetic ref; explicit choice -> {question_ref, state: UNKNOWN}, no text', async () => {
    for (let i = 0; i < GENERIC_REFS.length; i++) {
      const withUnknown = await makeEnv(genericView(GENERIC_REFS[i], KNOWLEDGE, i));
      assert.ok(withUnknown.app().includes('id="unknown-0"'), `option annoncée -> proposée (${GENERIC_REFS[i]})`);
      withUnknown.check(0, true);
      await withUnknown.click(); await settle();
      assert.strictEqual(withUnknown.posts().length, 1);
      const answer = withUnknown.body(withUnknown.posts()[0]).answers[0];
      assert.deepStrictEqual(answer, { question_ref: GENERIC_REFS[i], state: 'UNKNOWN' });
      assert.ok(!('text' in answer));

      const withoutUnknown = await makeEnv(genericView(GENERIC_REFS[i], NON_KNOWLEDGE, i));
      assert.ok(!withoutUnknown.app().includes('unknown-0'), `option non annoncée -> jamais proposée (${GENERIC_REFS[i]})`);
    }
  });

  await test('10c. no literal comparison on a question ref in the page source (ref / question_ref / q.ref / question.ref, either operand order, switch)', async () => {
    const refName = '(?:[A-Za-z_$][\\w$]*\\.)?(?:question_ref|ref)';
    const literal = '(?:\'[^\'\\n]*\'|"[^"\\n]*"|`[^`\\n]*`)';
    const detectors = [
      new RegExp(`\\b${refName}\\s*[!=]==?\\s*${literal}`),
      new RegExp(`${literal}\\s*[!=]==?\\s*${refName}\\b`),
      new RegExp(`switch\\s*\\(\\s*${refName}\\s*\\)`),
      new RegExp(`\\[[^\\]]*${literal}[^\\]]*\\]\\s*\\.includes\\(\\s*${refName}\\s*\\)`),
    ];
    // Auto-contrôle : la garde reconnaît des exemples fautifs (elle n'est pas vide) ...
    const bad = ["if (q.ref === 'SOME_KEY') {}", 'if ("SOME_KEY" == question.ref) {}', 'if (question_ref !== `K`) {}', 'switch (q.ref) {}', "['A','B'].includes(q.ref)"];
    bad.forEach((snippet) => assert.ok(detectors.some((re) => re.test(snippet)), `détecteur aveugle: ${snippet}`));
    // ... et laisse passer le vocabulaire générique du contrat.
    const fine = ["const STATE_VALUE = 'ANSWERED_WITH_VALUE';", 'states.includes(STATE_UNKNOWN)', '{ question_ref: q.ref, state: STATE_UNKNOWN }', "if (data.status === 'PENDING')"];
    fine.forEach((snippet) => assert.ok(!detectors.some((re) => re.test(snippet)), `faux positif: ${snippet}`));
    detectors.forEach((re) => assert.ok(!re.test(scriptSource), `comparaison littérale sur une ref dans la page: ${re}`));
  });

  await test('11. the page consumes allowed_states: the SAME question with different allowed_states renders differently', async () => {
    const both = await makeEnv({ get: { status: 200, body: view([q('R', KNOWLEDGE)]) } });
    const valueOnly = await makeEnv({ get: { status: 200, body: view([q('R', NON_KNOWLEDGE)]) } });
    assert.notStrictEqual(both.app(), valueOnly.app());
    assert.ok(both.app().includes('unknown-0') && !valueOnly.app().includes('unknown-0'));
  });

  // ----------------------------------------------------------------- GET : 410 / 404 / autres
  await test('12. GET 410 -> final « Ce lien n\'est plus valide. », no form, no button, no « réessayez », no POST', async () => {
    const env = await makeEnv({ get: { status: 410, body: { error: { code: 'GONE', message: GONE, request_id: 'r' } } } });
    assert.ok(env.app().includes(GONE));
    assert.ok(!/réessay/i.test(env.app()) && !env.app().includes('submit-btn') && !env.app().includes('textarea'), env.app());
    assert.strictEqual(env.posts().length, 0);
    assert.strictEqual(env.calls.length, 1, 'un seul GET, aucun retry automatique');
  });

  await test('13. GET 404 keeps its distinct message (never turned into the 410 message)', async () => {
    const env = await makeEnv({ get: { status: 404, body: { error: { code: 'NOT_FOUND', message: 'lien invalide' } } } });
    assert.ok(env.app().includes('Ce lien est invalide ou a expiré.') && !env.app().includes(GONE));
    assert.ok(!env.app().includes('submit-btn'));
  });

  await test('14. GET 5xx / network error keep the retry hint; ANSWERED / EXPIRED / unusable statuses keep their finals', async () => {
    assert.ok((await makeEnv({ get: { status: 500, body: {} } })).app().includes('réessayez'));
    assert.ok((await makeEnv({ getThrows: true })).app().includes('réessayez'));
    assert.ok((await makeEnv({ get: { status: 200, body: view([q('R', KNOWLEDGE)], 'ANSWERED') } })).app().includes('déjà répondu'));
    const expired = await makeEnv({ get: { status: 200, body: view([q('R')], 'EXPIRED') } });
    assert.ok(expired.app().includes(GONE) && !expired.app().includes('submit-btn'));
    assert.ok((await makeEnv({ get: { status: 200, body: view([]) } })).app().includes("n'est plus disponible"));
    assert.ok((await makeEnv({ search: '' })).app().includes('Aucun lien valide'));
  });

  await test('15. a question whose states the page does not understand fails closed (no form, no POST)', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([q('R', ['SOMETHING_NEW'])]) } });
    assert.ok(!env.app().includes('submit-btn') && !env.app().includes('textarea'));
    assert.strictEqual(env.posts().length, 0);
  });

  // ----------------------------------------------------------------- POST : 422 / succès / double clic / retry
  await test('16. POST 422 VALIDATION_FAILED -> one POST, error shown inline, form kept, NOT success, button re-enabled, no automatic retry, backend text never shown', async () => {
    const env = await makeEnv({ post: () => response(422, { error: { code: 'VALIDATION_FAILED', message: 'clarification_request: état de réponse structurel requis RAW-BACKEND-TEXT' } }) });
    env.type(0, 'valeur');
    await env.click(); await settle();
    await new Promise((r) => setTimeout(r, 30)); await settle();
    assert.strictEqual(env.posts().length, 1, 'un seul POST, aucun retry automatique');
    const err = env.el('form-error');
    assert.ok(err.classList.contains('show') && err.textContent.includes("n'a pas pu être enregistrée"));
    assert.ok(!env.app().includes('bien été enregistrées'), 'jamais présenté comme un succès');
    assert.ok(env.app().includes('id="answer-0"') && env.app().includes('submit-btn'), 'formulaire conservé (valeurs saisies non perdues)');
    assert.strictEqual(env.el('submit-btn').disabled, false, 'la reprise reste une action utilisateur');
    const everything = Object.values(env.elements).map((e) => `${e.innerHTML}|${e.textContent}`).join('\n');
    assert.ok(!everything.includes('RAW-BACKEND-TEXT'), 'aucun message technique du backend affiché');
  });

  await test('17. POST 422 REQUEST_NOT_PENDING -> final state (no form), single POST', async () => {
    const env = await makeEnv({ post: () => response(422, { error: { code: 'REQUEST_NOT_PENDING', message: 'déjà répondue' } }) });
    env.type(0, 'valeur');
    await env.click(); await settle();
    assert.strictEqual(env.posts().length, 1);
    assert.ok(env.app().includes('ne peuvent plus être enregistrées') && !env.app().includes('submit-btn'));
  });

  await test('18. POST 410 / 404 -> final states; 409 / 429 / 5xx / network error -> inline error, one POST each, form kept', async () => {
    for (const [status, body, expect] of [[410, { error: { code: 'GONE' } }, GONE], [404, { error: { code: 'NOT_FOUND' } }, 'invalide ou a expiré']]) {
      const env = await makeEnv({ post: () => response(status, body) });
      env.type(0, 'v'); await env.click(); await settle();
      assert.ok(env.app().includes(expect) && !env.app().includes('submit-btn'), `${status}: ${env.app()}`);
      assert.strictEqual(env.posts().length, 1);
    }
    for (const [status, expect] of [[409, 'équivalente'], [429, 'Trop de tentatives'], [500, 'Erreur lors de l']]) {
      const env = await makeEnv({ post: () => response(status, { error: { code: 'X' } }) });
      env.type(0, 'v'); await env.click(); await settle();
      assert.ok(env.el('form-error').textContent.includes(expect), `${status}: ${env.el('form-error').textContent}`);
      assert.strictEqual(env.posts().length, 1);
      assert.strictEqual(env.el('submit-btn').disabled, false);
    }
    const net = await makeEnv({ postThrows: true });
    net.type(0, 'v'); await net.click(); await settle();
    assert.ok(net.el('form-error').classList.contains('show') && net.posts().length === 1 && net.el('submit-btn').disabled === false);
  });

  await test('19. POST accepted -> success state, token stripped from the address bar, and the page can NOT produce a second request', async () => {
    const env = await makeEnv({});
    env.type(0, 'valeur');
    await env.click(); await settle();
    assert.ok(env.app().includes('bien été enregistrées') && !env.app().includes('submit-btn'));
    assert.strictEqual(env.replaced.length, 1);
    assert.strictEqual(env.replaced[0][2], '/clarification/', "l'URL sans jeton remplace l'historique");
    // même en rappelant directement le gestionnaire : aucune deuxième requête
    await env.el('submit-btn').listeners.click(); await settle();
    assert.strictEqual(env.posts().length, 1);
  });

  await test('20. double click while the first POST is in flight -> exactly ONE POST; button disabled meanwhile', async () => {
    let release;
    const env = await makeEnv({ post: () => new Promise((r) => { release = () => r(response(200, { status: 'ok' })); }) });
    env.type(0, 'valeur');
    const p1 = env.click();
    const p2 = env.click();
    const p3 = env.click();
    await settle();
    assert.strictEqual(env.posts().length, 1, 'un seul POST en vol');
    assert.strictEqual(env.el('submit-btn').disabled, true);
    release(); await Promise.all([p1, p2, p3]); await settle();
    assert.strictEqual(env.posts().length, 1);
    assert.ok(env.app().includes('bien été enregistrées'));
  });

  await test('21. after a failed attempt a NEW user click sends ONE more request (one attempt = one request)', async () => {
    let n = 0;
    const env = await makeEnv({ post: () => (++n === 1 ? response(422, { error: { code: 'VALIDATION_FAILED' } }) : response(200, {})) });
    env.type(0, 'valeur');
    await env.click(); await settle();
    assert.strictEqual(env.posts().length, 1);
    await env.click(); await settle();
    assert.strictEqual(env.posts().length, 2);
    assert.ok(env.app().includes('bien été enregistrées'));
  });

  await test('22. token safety: never logged, never shown in any error/final state', async () => {
    const scenarios = [
      makeEnv({ get: { status: 410, body: {} } }),
      makeEnv({ get: { status: 404, body: {} } }),
      makeEnv({ getThrows: true }),
      makeEnv({ post: () => response(422, { error: { code: 'VALIDATION_FAILED' } }) }),
      makeEnv({ postThrows: true }),
    ];
    for (const p of scenarios) {
      const env = await p;
      if (env.el('answer-0') && env.app().includes('answer-0')) { env.type(0, 'v'); await env.click(); await settle(); }
      const visible = Object.values(env.elements).map((e) => `${e.innerHTML}|${e.textContent}`).join('\n');
      assert.ok(!visible.includes(TOKEN), 'le jeton ne doit apparaître dans aucun état affiché');
      assert.ok(!JSON.stringify(env.consoleCalls).includes(TOKEN), 'le jeton ne doit jamais être journalisé');
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
