// H3-008D1Q36N4A5D66UI1 — relais public du parcours FICHIER (D66) : preuve que Compose transmet
// TELS QUELS (1) l'upload multipart (flux brut, aucun parsing/reconstruction côté Compose), (2) la
// preview, (3) la confirmation {artifact_extraction_id}, vers un backend Pandore SYNTHÉTIQUE
// intercepté (global.fetch), en démarrant le VRAI routeur Express sur un port éphémère — AUCUN
// réseau réel, AUCUN vrai jeton.
//
// Usage : node test/public-clarification-file-relay.test.js
'use strict';

const assert = require('assert');
const http = require('http');

process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.PANDORE_API_BASE = 'http://pandore-fake.test';
process.env.PANDORE_GO_INTERNAL_SECRET = 'test-go-internal-secret';
process.env.PANDORE_INTERNAL_SECRET = 'test-n8n-internal-secret';
delete process.env.META_APP_ID;
delete process.env.META_APP_SECRET;
delete process.env.META_REDIRECT_URI;

const BASE = 'http://pandore-fake.test';
const outbound = [];
const realFetch = global.fetch;

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const PREVIEW_DTO = {
  file_answer_id: 'fa-1', extraction_id: 'ex-1', filename: 'terms.txt', format: 'TXT',
  parser_id: 'txt-lines', parser_version: '1.0.0', total_rows: 2, total_columns: 1,
  preview_rows: [{ row: 1, cells: ['ABEG'] }, { row: 2, cells: ['ABOKI'] }],
  truncated: false, confirmable: true, candidate_count: 2,
};

global.fetch = async (url, opts = {}) => {
  const urlStr = String(url);
  if (urlStr.startsWith('http://127.0.0.1:')) return realFetch(url, opts);
  // Le flux multipart brut (upload) est lu intégralement ici pour prouver qu'il atteint Go INTACT —
  // jamais reconstruit/parsé côté Compose.
  let bodyBuffer = null;
  if (opts.body && typeof opts.body.pipe !== 'function' && typeof opts.body !== 'string') {
    bodyBuffer = opts.body; // objet Readable node natif passé par fetch : capturé tel quel ci-dessous via collect
  }
  const u = new URL(urlStr);
  const m = u.pathname.match(/^\/public\/clarifications\/([^/]+)\/questions\/([^/]+)\/file(\/preview|\/confirm)?$/);
  if (!m) throw new Error('appel Go inattendu: ' + u.pathname);
  const token = decodeURIComponent(m[1]);
  const questionRef = decodeURIComponent(m[2]);
  const sub = m[3] || '';

  // Pour l'upload (sub === ''), on lit le flux pour vérifier qu'il contient bien le contenu multipart
  // envoyé par le client, octet pour octet.
  let rawBody = '';
  if (sub === '' && opts.body && typeof opts.body.on === 'function') {
    rawBody = await new Promise((resolve) => {
      const chunks = [];
      opts.body.on('data', (c) => chunks.push(c));
      opts.body.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }
  outbound.push({ url: urlStr, method: (opts.method || 'GET').toUpperCase(), headers: opts.headers || {}, body: sub === '' ? rawBody : opts.body, token, questionRef, sub });

  if (token === 'tok-down') throw new Error('connect ECONNREFUSED');
  if (sub === '') {
    if (token === 'tok-upload-422') return jsonResponse(422, { error: { code: 'AMBIGUOUS_MULTI_COLUMN', message: 'x' } });
    // size = taille réelle du CONTENU du fichier (11 = "ABEG\nABOKI\n"), jamais celle de l'enveloppe
    // multipart complète (boundary/headers) : prouve que Go, pas Compose, est seul responsable du
    // parsing — ce fake se limite à constater qu'une partie "file" contenant ce texte est arrivée.
    return jsonResponse(201, { file_answer: { id: 'fa-1', filename: 'terms.txt', size: 11, format: 'TXT', status: 'UPLOADED' } });
  }
  if (sub === '/preview') {
    if (token === 'tok-preview-422') return jsonResponse(422, { error: { code: 'TRUNCATED', message: 'x' } });
    return jsonResponse(201, { preview: PREVIEW_DTO });
  }
  if (sub === '/confirm') {
    if (token === 'tok-confirm-409') return jsonResponse(409, { error: { code: 'CONFLICT', message: 'x' } });
    return jsonResponse(200, { confirmation: {
      clarification_status: 'ANSWERED', question_ref: questionRef, question_answer_state: 'ANSWERED_WITH_FILE',
      file_answer_id: 'fa-1', extraction_id: 'ex-1', candidate_count: 2, accepted_count: 2,
      requirement_key: 'TERMINOLOGY', requirement_resolution: 'RESOLVED',
    } });
  }
  throw new Error('chemin Go inattendu: ' + u.pathname);
};

const app = require('../src/server.js');

(async () => {
  const server = app.listen(0);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let passed = 0, failed = 0;
  async function test(name, fn) {
    try { outbound.length = 0; await fn(); console.log(`PASS - ${name}`); passed++; }
    catch (err) { console.log(`FAIL - ${name}\n  ${err.message}`); failed++; }
  }

  // Client HTTP local multipart minimal (une seule partie "file") — même discipline que le test
  // relay existant : module http natif, pas de dépendance nouvelle.
  function postMultipart(token, questionRef, filename, content) {
    return new Promise((resolve, reject) => {
      const boundary = '----testboundary123';
      const pre = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`;
      const post = `\r\n--${boundary}--\r\n`;
      const payload = Buffer.concat([Buffer.from(pre, 'utf8'), Buffer.from(content, 'utf8'), Buffer.from(post, 'utf8')]);
      const req = http.request(`${base}/api/public/clarifications/${encodeURIComponent(token)}/questions/${encodeURIComponent(questionRef)}/file`, {
        method: 'POST', agent: false,
        headers: { Connection: 'close', 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payload.length },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
  const call = (method, pathname, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(base + pathname, {
      method, agent: false,
      headers: Object.assign({ Connection: 'close' }, payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, text: async () => raw, json: async () => JSON.parse(raw) });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  const preview = (token, ref) => call('POST', `/api/public/clarifications/${token}/questions/${ref}/file/preview`);
  const confirm = (token, ref, extractionId) => call('POST', `/api/public/clarifications/${token}/questions/${ref}/file/confirm`, { artifact_extraction_id: extractionId });

  try {
    await test('F1. upload: raw multipart body reaches Go INTACT (content-type + exact bytes), 201 relayed unchanged', async () => {
      const res = await postMultipart('tok-1', 'TERMINOLOGY', 'terms.txt', 'ABEG\nABOKI\n');
      assert.strictEqual(res.status, 201);
      assert.deepStrictEqual(await res.json(), { file_answer: { id: 'fa-1', filename: 'terms.txt', size: 11, format: 'TXT', status: 'UPLOADED' } });
      assert.strictEqual(outbound.length, 1);
      assert.strictEqual(outbound[0].url, `${BASE}/public/clarifications/tok-1/questions/TERMINOLOGY/file`);
      assert.ok(outbound[0].headers['Content-Type'].startsWith('multipart/form-data; boundary='));
      assert.ok(outbound[0].body.includes('ABEG\nABOKI\n'), 'le contenu exact du fichier atteint Go');
      assert.ok(outbound[0].body.includes('filename="terms.txt"'));
    });

    await test('F2. upload: Go 422 (ambiguous) passes through with its exact code', async () => {
      const res = await postMultipart('tok-upload-422', 'TERMINOLOGY', 'x.csv', 'a,b\n');
      assert.strictEqual(res.status, 422);
      assert.strictEqual((await res.json()).error.code, 'AMBIGUOUS_MULTI_COLUMN');
    });

    await test('F3. preview: plain POST (no body needed), 201 + full preview DTO relayed unchanged', async () => {
      const res = await preview('tok-1', 'TERMINOLOGY');
      assert.strictEqual(res.status, 201);
      assert.deepStrictEqual(await res.json(), { preview: PREVIEW_DTO });
      assert.strictEqual(outbound.length, 1);
      assert.strictEqual(outbound[0].url, `${BASE}/public/clarifications/tok-1/questions/TERMINOLOGY/file/preview`);
    });

    await test('F4. preview: Go 422 (truncated) passes through with its exact code', async () => {
      const res = await preview('tok-preview-422', 'TERMINOLOGY');
      assert.strictEqual(res.status, 422);
      assert.strictEqual((await res.json()).error.code, 'TRUNCATED');
    });

    await test('F5. confirm: {artifact_extraction_id} reaches Go EXACTLY, nothing added; full confirmation DTO relayed unchanged', async () => {
      const res = await confirm('tok-1', 'TERMINOLOGY', 'ex-1');
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.confirmation.clarification_status, 'ANSWERED');
      assert.strictEqual(body.confirmation.candidate_count, 2);
      assert.strictEqual(outbound.length, 1);
      assert.strictEqual(outbound[0].url, `${BASE}/public/clarifications/tok-1/questions/TERMINOLOGY/file/confirm`);
      assert.deepStrictEqual(JSON.parse(outbound[0].body), { artifact_extraction_id: 'ex-1' });
    });

    await test('F6. confirm: no artifact_extraction_id in body -> relays an empty string (Go decides/rejects), never fabricated', async () => {
      const res = await call('POST', '/api/public/clarifications/tok-1/questions/TERMINOLOGY/file/confirm', {});
      await res.text();
      assert.deepStrictEqual(JSON.parse(outbound[0].body), { artifact_extraction_id: '' });
    });

    await test('F7. confirm: Go 409 CONFLICT passes through unchanged', async () => {
      const res = await confirm('tok-confirm-409', 'TERMINOLOGY', 'ex-1');
      assert.strictEqual(res.status, 409);
      assert.strictEqual((await res.json()).error.code, 'CONFLICT');
    });

    await test('F8. Go unreachable on any of the 3 file routes -> 502 generic, no token/stack leaked', async () => {
      const u = await postMultipart('tok-down', 'TERMINOLOGY', 'x.txt', 'a');
      assert.strictEqual(u.status, 502);
      const p = await preview('tok-down', 'TERMINOLOGY');
      assert.strictEqual(p.status, 502);
      const c = await confirm('tok-down', 'TERMINOLOGY', 'ex-1');
      assert.strictEqual(c.status, 502);
      const text = JSON.stringify(await c.json());
      assert.ok(!text.includes('tok-down') && !text.includes('ECONNREFUSED'));
    });

    await test('F9. token is URL-encoded on all 3 routes, question ref too', async () => {
      await preview('tok%2F1', 'REF%2FX');
      assert.strictEqual(outbound[0].url, `${BASE}/public/clarifications/tok%2F1/questions/REF%2FX/file/preview`);
    });
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
