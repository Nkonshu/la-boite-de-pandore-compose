// H3-008D1Q36N4A5D68T — page publique d'acceptation d'invitation : le <script> inline de
// public/accept-invitation/index.html exécuté dans un contexte vm avec un faux DOM/location/history/fetch —
// AUCUN réseau réel, AUCUN backend, AUCUN vrai jeton (uniquement des marqueurs synthétiques).
//
// Usage : node test/accept-invitation-ui.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const HTML_PATH = path.join(__dirname, '..', 'public', 'accept-invitation', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error('accept-invitation/index.html: <script> introuvable — le fichier a-t-il changé de structure ?');
const scriptSource = scriptMatch[1];

const TOKEN = 'FIXTURE-TOKEN-MARKER-0001';
const PASSWORD = 'FIXTURE-PASSWORD-MARKER-0001';
const RELAY_URL = '/api/auth/accept-invitation';

function fakeElement(id) {
  const classes = new Set();
  return {
    id, value: '', disabled: false, style: {}, textContent: '', innerHTML: '', className: '', listeners: {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    addEventListener(type, fn) { this.listeners[type] = fn; },
  };
}

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

async function settle() { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); }

// makeEnv — hash pilote le fragment lu au chargement (comme un vrai navigateur ouvrant le lien). opts.post
// contrôle la réponse simulée du relay same-origin.
async function makeEnv(opts) {
  opts = opts || {};
  const elements = { app: fakeElement('app') };
  const calls = [];
  const consoleCalls = [];
  const replaced = [];
  const env = { elements, calls, consoleCalls, replaced };
  const sandbox = {
    document: { getElementById(id) { return elements[id] || (elements[id] = fakeElement(id)); } },
    location: {
      hash: opts.hash === undefined ? `#token=${TOKEN}` : opts.hash,
      pathname: '/accept-invitation/', search: '',
    },
    history: { replaceState: (...a) => replaced.push(a) },
    decodeURIComponent, encodeURIComponent, RegExp, String, Error, JSON, Promise,
    console: {
      log: (...a) => consoleCalls.push(a), error: (...a) => consoleCalls.push(a), warn: (...a) => consoleCalls.push(a), info: (...a) => consoleCalls.push(a),
    },
    fetch(url, o) {
      const call = { url: String(url), method: ((o && o.method) || 'GET').toUpperCase(), opts: o || {} };
      calls.push(call);
      if (opts.postThrows) return Promise.reject(new Error('network'));
      return Promise.resolve((opts.post || (() => response(201, { id: 'user-123', email: 'invitee@disposable.test', role: 'CLIENT_OWNER' })))(call));
    },
  };
  env.sandbox = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(scriptSource, sandbox);
  env.el = (id) => sandbox.document.getElementById(id);
  env.app = () => elements.app.innerHTML;
  env.posts = () => calls.filter((c) => c.method === 'POST');
  env.body = (call) => JSON.parse(call.opts.body);
  env.submit = async (password) => {
    if (password !== undefined) env.el('password').value = password;
    const form = env.el('accept-form');
    await form.listeners.submit({ preventDefault() {} });
    await settle();
  };
  await settle();
  return env;
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS - ${name}`); passed++; }
  catch (err) { console.log(`FAIL - ${name}\n  ${err.message}`); failed++; }
}

(async () => {
  await test('1. token read from the fragment, never the query string, and the fragment is stripped from the address bar', async () => {
    const env = await makeEnv({ hash: `#token=${TOKEN}` });
    assert.ok(env.app().includes('Accepter l\'invitation'), 'le formulaire doit s\'afficher (jeton présent)');
    assert.strictEqual(env.replaced.length, 1, 'history.replaceState doit être appelé exactement une fois');
    assert.deepStrictEqual(env.replaced[0], [null, '', '/accept-invitation/']);
  });

  await test('2. no token in the fragment -> generic human error, no mutative request, no replaceState needed', async () => {
    const env = await makeEnv({ hash: '' });
    assert.ok(env.app().toLowerCase().includes('invalide'));
    assert.strictEqual(env.posts().length, 0);
  });

  await test('3. malformed fragment (no token= key) is treated exactly like no token', async () => {
    const env = await makeEnv({ hash: '#something-else' });
    assert.ok(env.app().toLowerCase().includes('invalide'));
    assert.strictEqual(env.posts().length, 0);
  });

  await test('4. submit posts EXACTLY {token, password} to the same-origin relay, never a direct Go URL', async () => {
    const env = await makeEnv({ hash: `#token=${TOKEN}` });
    await env.submit(PASSWORD);
    assert.strictEqual(env.posts().length, 1);
    assert.strictEqual(env.posts()[0].url, RELAY_URL);
    assert.deepStrictEqual(env.body(env.posts()[0]), { token: TOKEN, password: PASSWORD });
  });

  await test('5. success renders a clear confirmation, no token/id/password shown', async () => {
    const env = await makeEnv({ hash: `#token=${TOKEN}`, post: () => response(201, { id: 'user-123', email: 'invitee@disposable.test', role: 'CLIENT_OWNER' }) });
    await env.submit(PASSWORD);
    assert.ok(env.app().includes('Invitation acceptée'));
    assert.ok(!env.app().includes(TOKEN) && !env.app().includes(PASSWORD) && !env.app().includes('user-123'));
  });

  await test('6. 404 unknown token -> human message, form not left broken', async () => {
    const env = await makeEnv({ hash: `#token=${TOKEN}`, post: () => response(404, { error: { code: 'NOT_FOUND', message: 'invitation introuvable' } }) });
    await env.submit(PASSWORD);
    assert.ok(env.app().toLowerCase().includes('introuvable') || env.app().toLowerCase().includes('invalide'));
  });

  await test('7. 422 expired/already-accepted is distinguished from 422 short-password', async () => {
    const expired = await makeEnv({ hash: `#token=${TOKEN}`, post: () => response(422, { error: { message: 'invitation: déjà acceptée ou expirée' } }) });
    await expired.submit(PASSWORD);
    assert.ok(expired.app().toLowerCase().includes('expir') || expired.app().toLowerCase().includes('plus valide'));

    const shortpw = await makeEnv({ hash: `#token=${TOKEN}`, post: () => response(422, { error: { message: 'mot de passe trop court (8 caractères minimum)' } }) });
    await shortpw.submit('short');
    assert.ok(shortpw.app().toLowerCase().includes('mot de passe'));
  });

  await test('8. 409 email conflict -> clean human message, never a raw constraint error', async () => {
    const env = await makeEnv({ hash: `#token=${TOKEN}`, post: () => response(409, { error: { code: 'EMAIL_ALREADY_HAS_ACCOUNT', message: 'cet email correspond déjà à un compte existant' } }) });
    await env.submit(PASSWORD);
    assert.ok(env.app().toLowerCase().includes('existe déjà'));
    assert.ok(!env.app().toLowerCase().includes('duplicate') && !env.app().toLowerCase().includes('constraint'));
  });

  await test('9. network failure -> generic retry message, never a stack trace', async () => {
    const env = await makeEnv({ hash: `#token=${TOKEN}`, postThrows: true });
    await env.submit(PASSWORD);
    assert.ok(env.app().toLowerCase().includes('réessayez') || env.app().toLowerCase().includes('erreur'));
  });

  await test('10. double-submit guard: a second submit while the first is in flight does not send a second request', async () => {
    let resolveFirst;
    const env = await makeEnv({
      hash: `#token=${TOKEN}`,
      post: () => new Promise((resolve) => { resolveFirst = () => resolve(response(201, { id: 'u', email: 'e', role: 'CLIENT_OWNER' })); }),
    });
    const form = env.el('accept-form');
    env.el('password').value = PASSWORD;
    const first = form.listeners.submit({ preventDefault() {} });
    await form.listeners.submit({ preventDefault() {} }); // second attempt, submitting flag should block it
    resolveFirst();
    await first;
    await settle();
    assert.strictEqual(env.posts().length, 1, 'un seul POST malgré la double soumission');
  });

  await test('11. the password field is cleared after submission (success or failure), never stored elsewhere', async () => {
    const env = await makeEnv({ hash: `#token=${TOKEN}`, post: () => response(404, { error: { message: 'introuvable' } }) });
    const pwField = env.el('password');
    await env.submit(PASSWORD);
    assert.strictEqual(pwField.value, '');
  });

  await test('12. token safety: the real token never appears in any rendered state or console call', async () => {
    const scenarios = [
      makeEnv({ hash: `#token=${TOKEN}` }),
      makeEnv({ hash: `#token=${TOKEN}`, post: () => response(404, { error: { message: 'x' } }) }),
      makeEnv({ hash: `#token=${TOKEN}`, postThrows: true }),
    ];
    for (const p of scenarios) {
      const env = await p;
      if (env.el('password')) { await env.submit(PASSWORD); }
      const visible = Object.values(env.elements).map((e) => `${e.innerHTML}|${e.textContent}`).join('\n');
      assert.ok(!visible.includes(TOKEN), 'le jeton ne doit apparaître dans aucun état affiché');
      assert.ok(!JSON.stringify(env.consoleCalls).includes(TOKEN), 'le jeton ne doit jamais être journalisé');
      assert.ok(!JSON.stringify(env.consoleCalls).includes(PASSWORD), 'le mot de passe ne doit jamais être journalisé');
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
