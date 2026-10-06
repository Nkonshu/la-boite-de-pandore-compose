// H3-008D1Q36N4A5D66UI1 — page publique de clarification : parcours FICHIER (upload -> preview ->
// confirm). Même technique vm que test/public-clarification-ui.test.js : le <script> inline de
// public/clarification/index.html est exécuté dans un contexte vm avec un faux DOM, un faux fetch et
// un faux FormData/File — AUCUN réseau réel, AUCUN backend, AUCUN vrai jeton.
//
// Les faux GET/POST reproduisent les DTO Go réels :
//   GET  .../clarifications/:token                -> allowed_response_modes + file_upload (D66F2/F3)
//   POST .../questions/:ref/file                  -> { file_answer: {...} }                  (D66F3)
//   POST .../questions/:ref/file/preview           -> { preview: {...} }                       (D66F4/I1)
//   POST .../questions/:ref/file/confirm           -> { confirmation: {...} }                   (D66I1)
//
// Usage : node test/public-clarification-file-ui.test.js
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

const TOKEN = 'FIXTURE-TOKEN-MARKER-0002';
const REF = 'TERMINOLOGY';
const FILE_URL = `/api/public/clarifications/${TOKEN}/questions/${REF}/file`;
const PREVIEW_URL = `${FILE_URL}/preview`;
const CONFIRM_URL = `${FILE_URL}/confirm`;

function fakeElement(id) {
  const classes = new Set();
  return {
    id, value: '', checked: false, disabled: false, style: {}, textContent: '', innerHTML: '', className: '', listeners: {}, files: [],
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      toggle: (c, force) => { const has = force === undefined ? !classes.has(c) : force; if (has) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    setAttribute() {}, getAttribute() { return null; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
  };
}
function response(status, body) { return { status, ok: status >= 200 && status < 300, json: async () => body }; }
async function settle() { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); }

function view(questions, status) { return { status: status || 'PENDING', expires_at: '2099-01-01T00:00:00Z', questions }; }
function fileQuestion(ref, opts) {
  opts = opts || {};
  const o = { ref, prompt: opts.prompt || `Question ${ref} ?` };
  o.allowed_states = opts.allowedStates === undefined ? [] : opts.allowedStates;
  o.allowed_response_modes = opts.modes || ['TEXT', 'FILE'];
  o.file_upload = opts.fileUpload === undefined
    ? { allowed_formats: ['CSV', 'TXT', 'XLSX'], max_bytes: 2097152, max_files: 1 }
    : opts.fileUpload;
  return o;
}
function textOnlyQuestion(ref) {
  return { ref, prompt: `Question ${ref} ?`, allowed_states: ['ANSWERED_WITH_VALUE'] };
}

const PREVIEW_OK = {
  file_answer_id: 'fa-1', extraction_id: 'ex-1', filename: 'terms.txt', format: 'TXT',
  parser_id: 'txt-lines', parser_version: '1.0.0', total_rows: 2, total_columns: 1,
  preview_rows: [{ row: 1, cells: ['ABEG'] }, { row: 2, cells: ['ABOKI'] }],
  truncated: false, warnings: [], confirmable: true, candidate_count: 2, validation_code: '',
};
const PREVIEW_TRUNCATED = Object.assign({}, PREVIEW_OK, { confirmable: false, truncated: true, validation_code: 'TRUNCATED' });

// makeEnv — opts.get, opts.upload, opts.preview, opts.confirm : { status, body } ou fonction(call)=>réponse.
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
    URLSearchParams, Promise, encodeURIComponent, Set, Array, Object, JSON, String, Error, Math,
    console: { log: (...a) => consoleCalls.push(a), error: (...a) => consoleCalls.push(a), warn: (...a) => consoleCalls.push(a), info: (...a) => consoleCalls.push(a) },
    // FormData minimal : append/get suffisent à la production et aux assertions de test.
    FormData: class { constructor() { this._m = new Map(); } append(k, v) { this._m.set(k, v); } get(k) { return this._m.get(k); } },
    fetch(url, o) {
      const call = { url: String(url), method: ((o && o.method) || 'GET').toUpperCase(), opts: o || {} };
      calls.push(call);
      if (call.method === 'GET') {
        if (opts.getThrows) return Promise.reject(new Error('network'));
        const g = opts.get || { status: 200, body: view([]) };
        return Promise.resolve(response(g.status, g.body));
      }
      // Correspondance par SUFFIXE (jamais par ref figée) : plusieurs tests utilisent des refs
      // différentes (TERMINOLOGY, F1, T1...) sur la même session de fetch simulé.
      if (call.url.endsWith('/file/preview')) {
        if (opts.previewThrows) return Promise.reject(new Error('network'));
        const p = typeof opts.preview === 'function' ? opts.preview(call) : (opts.preview || { status: 201, body: { preview: PREVIEW_OK } });
        return Promise.resolve(response(p.status, p.body));
      }
      if (call.url.endsWith('/file/confirm')) {
        if (opts.confirmThrows) return Promise.reject(new Error('network'));
        const c = typeof opts.confirm === 'function' ? opts.confirm(call) : (opts.confirm || { status: 200, body: { confirmation: { clarification_status: 'ANSWERED', question_ref: REF, question_answer_state: 'ANSWERED_WITH_FILE', file_answer_id: 'fa-1', extraction_id: 'ex-1', candidate_count: 2, accepted_count: 2, requirement_key: REF, requirement_resolution: 'RESOLVED' } } });
        return Promise.resolve(response(c.status, c.body));
      }
      if (call.url.endsWith('/file')) {
        if (opts.uploadThrows) return Promise.reject(new Error('network'));
        const u = typeof opts.upload === 'function' ? opts.upload(call) : (opts.upload || { status: 201, body: { file_answer: { id: 'fa-1', filename: 'terms.txt', size: 11, format: 'TXT', status: 'UPLOADED' } } });
        return Promise.resolve(response(u.status, u.body));
      }
      throw new Error('fetch inattendu: ' + call.url);
    },
  };
  sandbox.window = { history: { replaceState: (...a) => replaced.push(a) } };
  env.sandbox = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(scriptSource, sandbox);
  env.el = (id) => sandbox.document.getElementById(id);
  env.app = () => elements.app.innerHTML.replace(/&#39;/g, "'");
  env.calls = calls;
  env.uploads = () => calls.filter((c) => c.url === FILE_URL);
  env.previews = () => calls.filter((c) => c.url === PREVIEW_URL);
  env.confirms = () => calls.filter((c) => c.url === CONFIRM_URL);
  env.textPosts = () => calls.filter((c) => c.url.endsWith('/response'));
  env.selectFile = (i, file) => { const input = env.el(`file-${i}`); input.files = file ? [file] : []; if (input.listeners.change) input.listeners.change(); };
  env.clickUpload = (i) => env.el(`file-upload-btn-${i}`).listeners.click();
  env.clickConfirm = (i) => env.el(`file-confirm-btn-${i}`).listeners.click();
  env.fakeFile = (name, size) => ({ name, size: size === undefined ? 11 : size, type: 'text/plain' });
  await settle();
  return env;
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS - ${name}`); passed++; }
  catch (err) { console.log(`FAIL - ${name}\n  ${err.message}`); failed++; }
}

(async () => {
  // T1 — TEXT-only : aucun contrôle FILE.
  await test('T1. TEXT-only question (no FILE in allowed_response_modes) -> no file control rendered', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([textOnlyQuestion('R1')]) } });
    assert.ok(!env.app().includes(`id="file-0"`) && !env.app().includes('Envoyer ce fichier'), env.app());
  });

  // T2 — TEXT+FILE : contrôle FILE visible.
  await test('T2. TEXT+FILE question -> file input control visible alongside TEXT', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([fileQuestion(REF, { allowedStates: ['ANSWERED_WITH_VALUE'] })]) } });
    assert.ok(env.app().includes(`id="file-0"`) && env.app().includes(`id="answer-0"`), env.app());
  });

  // T3 — formats acceptés dérivés du contrat.
  await test('T3. allowed formats (CSV/TXT/XLSX) correctly derived into the accept attribute and hint text', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([fileQuestion(REF)]) } });
    assert.ok(env.app().includes('accept=".csv,.txt,.xlsx"'), env.app());
    assert.ok(env.app().includes('CSV, TXT, XLSX'));
    assert.ok(env.app().includes('2 Mo') || env.app().includes('2097152'));
  });

  // T4 — rejet frontend si taille > max, avant tout upload.
  await test('T4. oversize file -> rejected client-side BEFORE any upload call, error shown', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([fileQuestion(REF, { fileUpload: { allowed_formats: ['TXT'], max_bytes: 10, max_files: 1 } })]) } });
    env.selectFile(0, env.fakeFile('big.txt', 999));
    assert.strictEqual(env.uploads().length, 0);
    assert.ok(env.el('file-status-0').textContent.length > 0, 'message affiché');
    assert.strictEqual(env.el('file-upload-btn-0').disabled, true);
  });

  // T5 — upload réussi -> transition vers preview.
  await test('T5. upload success -> automatically transitions into preview, candidates rendered', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([fileQuestion(REF)]) } });
    env.selectFile(0, env.fakeFile('terms.txt'));
    env.clickUpload(0);
    await settle();
    assert.strictEqual(env.uploads().length, 1);
    assert.strictEqual(env.previews().length, 1, 'preview déclenché automatiquement après upload');
    const previewHtml = env.el('preview-0').innerHTML;
    assert.ok(previewHtml.includes('ABEG') && previewHtml.includes('ABOKI'), previewHtml);
  });

  // T6 — échec upload -> erreur visible, aucune confirmation possible.
  await test('T6. upload failure -> inline error, no preview call, confirm never reachable', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([fileQuestion(REF)]) }, upload: { status: 422, body: { error: { code: 'AMBIGUOUS_MULTI_COLUMN' } } } });
    env.selectFile(0, env.fakeFile('terms.csv'));
    env.clickUpload(0);
    await settle();
    assert.strictEqual(env.uploads().length, 1);
    assert.strictEqual(env.previews().length, 0);
    assert.ok(env.el('file-status-0').classList.contains('err'));
    assert.strictEqual(env.el('preview-0').innerHTML, '', 'aucun preview/bouton confirm rendu');
  });

  // T7 — preview réussi -> candidates rendus (ordinal/valeurs).
  await test('T7. preview success -> exact candidate values rendered from preview_rows, in order', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([fileQuestion(REF)]) } });
    env.selectFile(0, env.fakeFile('terms.txt'));
    env.clickUpload(0);
    await settle();
    const previewHtml = env.el('preview-0').innerHTML;
    assert.ok(previewHtml.indexOf('ABEG') < previewHtml.indexOf('ABOKI'), 'ordre préservé: ' + previewHtml);
    assert.ok(previewHtml.includes('2 valeur'), previewHtml);
  });

  // T8 — extraction tronquée/non confirmable -> confirmation désactivée.
  await test('T8. truncated/non-confirmable preview -> confirm button disabled, reason shown', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([fileQuestion(REF)]) }, preview: { status: 201, body: { preview: PREVIEW_TRUNCATED } } });
    env.selectFile(0, env.fakeFile('terms.txt'));
    env.clickUpload(0);
    await settle();
    const btn = env.el('file-confirm-btn-0');
    assert.strictEqual(btn.disabled, true);
    const previewHtml = env.el('preview-0').innerHTML;
    assert.ok(previewHtml.includes('tronqué') || previewHtml.includes('Ce fichier'), previewHtml);
  });

  // T9 — confirm utilise l'ID exact du preview courant.
  await test('T9. confirm sends the EXACT extraction_id from the current preview, nothing else', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([fileQuestion(REF)]) } });
    env.selectFile(0, env.fakeFile('terms.txt'));
    env.clickUpload(0);
    await settle();
    env.clickConfirm(0);
    await settle();
    assert.strictEqual(env.confirms().length, 1);
    const body = JSON.parse(env.confirms()[0].opts.body);
    assert.deepStrictEqual(body, { artifact_extraction_id: 'ex-1' });
  });

  // T10 — ré-upload invalide l'ancien extraction_id.
  await test('T10. re-selecting a new file invalidates the previous preview/extraction_id; a fresh preview is required before confirm', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([fileQuestion(REF)]) } });
    env.selectFile(0, env.fakeFile('terms.txt'));
    env.clickUpload(0);
    await settle();
    assert.ok(env.el('preview-0').innerHTML.includes('file-confirm-btn-0'), 'bouton confirm présent après le premier preview');
    env.selectFile(0, env.fakeFile('terms2.txt'));
    assert.strictEqual(env.el('preview-0').innerHTML, '', 'ancien preview effacé, confirm plus disponible tant que non ré-uploadé');
    assert.strictEqual(env.uploads().length, 1, 'aucun nouvel upload tant que le bouton Envoyer n\'est pas recliqué');
  });

  // T11 — exclusivité TEXT/FILE/UNKNOWN.
  await test('T11. mode exclusivity: selecting a file disables TEXT and UNKNOWN for that question', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([fileQuestion(REF, { allowedStates: ['ANSWERED_WITH_VALUE', 'UNKNOWN'] })]) } });
    env.selectFile(0, env.fakeFile('terms.txt'));
    assert.strictEqual(env.el('answer-0').disabled, true, 'TEXT désactivé par la sélection FILE');
    assert.strictEqual(env.el('unknown-0').disabled, true, 'UNKNOWN désactivé par la sélection FILE');
  });
  await test('T11b. mode exclusivity: typing TEXT disables the FILE input', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([fileQuestion(REF, { allowedStates: ['ANSWERED_WITH_VALUE'] })]) } });
    const field = env.el('answer-0');
    field.value = 'une réponse';
    if (field.listeners.input) field.listeners.input();
    assert.strictEqual(env.el('file-0').disabled, true, 'FILE désactivé dès qu\'une réponse texte est saisie');
  });
  await test('T11c. mode exclusivity: checking UNKNOWN disables the FILE input', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([fileQuestion(REF, { allowedStates: ['ANSWERED_WITH_VALUE', 'UNKNOWN'] })]) } });
    env.el('unknown-0').checked = true;
    if (env.el('unknown-0').listeners.change) env.el('unknown-0').listeners.change();
    assert.strictEqual(env.el('file-0').disabled, true);
  });

  // T12 — double confirm impossible.
  await test('T12. double click on confirm while in flight -> exactly ONE confirm call; button disabled meanwhile', async () => {
    let release;
    const env = await makeEnv({ get: { status: 200, body: view([fileQuestion(REF)]) }, confirm: () => new Promise((r) => { release = () => r(response(200, { confirmation: { clarification_status: 'ANSWERED', question_ref: REF } })); }) });
    env.selectFile(0, env.fakeFile('terms.txt'));
    env.clickUpload(0);
    await settle();
    const p1 = env.clickConfirm(0);
    const p2 = env.clickConfirm(0);
    await settle();
    assert.strictEqual(env.confirms().length, 1, 'un seul confirm en vol');
    release(); await Promise.all([p1, p2]); await settle();
    assert.strictEqual(env.confirms().length, 1);
  });

  // T13 — FILE confirmé -> pas de soumission TEXT secondaire.
  await test('T13. after FILE confirmed, the whole request becomes ANSWERED (same final state as text success); global submit never fires a TEXT payload for it', async () => {
    const env = await makeEnv({ get: { status: 200, body: view([fileQuestion(REF, { allowedStates: ['ANSWERED_WITH_VALUE'] })]) } });
    env.selectFile(0, env.fakeFile('terms.txt'));
    env.clickUpload(0);
    await settle();
    env.clickConfirm(0);
    await settle();
    assert.ok(env.app().includes('bien été enregistrées'), 'état final identique au succès texte');
    assert.strictEqual(env.textPosts().length, 0, 'jamais de second chemin métier via /response');
  });
  await test('T13b. FILE question confirmed while clarification defensively stays PENDING -> question locked, no TEXT resubmission, submit still works for the rest', async () => {
    const env = await makeEnv({
      get: { status: 200, body: view([fileQuestion('F1', { allowedStates: ['ANSWERED_WITH_VALUE'] }), textOnlyQuestion('T1')]) },
      confirm: { status: 200, body: { confirmation: { clarification_status: 'PENDING', question_ref: 'F1', question_answer_state: 'ANSWERED_WITH_FILE', candidate_count: 1, accepted_count: 1 } } },
    });
    env.selectFile(0, env.fakeFile('terms.txt'));
    env.clickUpload(0);
    await settle();
    env.clickConfirm(0);
    await settle();
    assert.ok(env.el('fileblock-0').innerHTML.includes('enregistré'), 'question fichier verrouillée visuellement');
    env.el('answer-1').value = 'autre réponse';
    env.el('submit-btn').listeners.click();
    await settle();
    assert.strictEqual(env.textPosts().length, 1);
    const body = JSON.parse(env.textPosts()[0].opts.body);
    assert.deepStrictEqual(body, { answers: [{ question_ref: 'T1', state: 'ANSWERED_WITH_VALUE', text: 'autre réponse' }] }, 'la question F1 (fichier confirmé) est exclue du payload');
  });

  // T14 — aucune fuite du token par le nouveau code.
  await test('T14. token never logged/persisted by the file flow (upload, preview, confirm, errors)', async () => {
    const scenarios = [
      makeEnv({ get: { status: 200, body: view([fileQuestion(REF)]) }, upload: { status: 422, body: { error: { code: 'NO_VALID_ITEM' } } } }),
      makeEnv({ get: { status: 200, body: view([fileQuestion(REF)]) }, previewThrows: true }),
      makeEnv({ get: { status: 200, body: view([fileQuestion(REF)]) }, confirm: { status: 409, body: { error: { code: 'CONFLICT' } } } }),
    ];
    for (const p of scenarios) {
      const env = await p;
      env.selectFile(0, env.fakeFile('terms.txt'));
      env.clickUpload(0);
      await settle();
      if (env.el('file-confirm-btn-0') && env.el('file-confirm-btn-0').listeners.click) { env.clickConfirm(0); await settle(); }
      const visible = Object.values(env.elements).map((e) => `${e.innerHTML}|${e.textContent}`).join('\n');
      assert.ok(!visible.includes(TOKEN), 'le jeton ne doit apparaître dans aucun état affiché');
      assert.ok(!JSON.stringify(env.consoleCalls).includes(TOKEN), 'le jeton ne doit jamais être journalisé');
      for (const call of env.calls) {
        assert.ok(!(call.opts.body && typeof call.opts.body === 'string' && call.opts.body.includes(TOKEN)), 'le jeton ne figure jamais dans un corps de requête');
      }
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
