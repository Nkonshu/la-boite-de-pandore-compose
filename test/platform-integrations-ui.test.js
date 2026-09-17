// H3-008D1K §11 — preuve d'extensibilité GÉNÉRIQUE du rendu de formulaire :
// extrait le <script> inline de public/admin/platform-integrations.html et
// exécute renderConfigField/buildConfigFormHTML dans un contexte vm minimal
// (MÊME technique EXACTE que test/plan-decision.test.js — aucune nouvelle
// dépendance npm, jamais un navigateur réel). Prouve qu'un schéma
// SYNTHÉTIQUE hors des dix plateformes initiales, couvrant les cinq Kind
// (TEXT/SECRET/URL/BOOLEAN/SELECT), se rend correctement SANS modifier le
// fichier HTML/JS et SANS aucune branche par platform_id.
//
// Usage : node test/platform-integrations-ui.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const HTML_PATH = path.join(__dirname, '..', 'public', 'admin', 'platform-integrations.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  throw new Error('platform-integrations.html: <script> introuvable — le fichier a-t-il changé de structure ?');
}
const scriptSource = scriptMatch[1];

function fakeElement() {
  return {
    value: '', style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelectorAll() { return []; }, innerHTML: '',
    textContent: '',
  };
}

function fakeStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

// runScript — construit un contexte vm frais et exécute le script inline
// dedans (le code top-level attache des addEventListener sur des éléments
// factices et exécute l'IIFE finale — jamais de fetch réel déclenché,
// localStorage vide => showGate(false) seulement).
function runScript() {
  const elements = new Map();
  const sandbox = {
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, fakeElement());
        return elements.get(id);
      },
      querySelectorAll: () => [],
    },
    localStorage: fakeStorage(),
    sessionStorage: fakeStorage(),
    fetch: () => Promise.reject(new Error('fetch non simulé pour ce test')),
    console,
    URLSearchParams,
    URL,
  };
  vm.createContext(sandbox);
  vm.runInContext(scriptSource, sandbox);
  return sandbox;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- schéma synthétique HORS catalogue, cinq Kind, jamais Facebook ---
const syntheticSchema = [
  { key: 'endpoint_url', label: 'Webhook Endpoint', kind: 'URL', required: true, help_text: 'URL HTTPS complète.' },
  { key: 'bot_token', label: 'Bot Token', kind: 'SECRET', required: true },
  { key: 'display_label', label: 'Nom affiché', kind: 'TEXT', required: false },
  { key: 'auto_retry', label: 'Relance automatique', kind: 'BOOLEAN', required: false },
  { key: 'region', label: 'Région', kind: 'SELECT', required: true, options: ['eu', 'us', 'apac'] },
];

test('URL field renders type=url, current value, required marker, help text', () => {
  const sandbox = runScript();
  const html = sandbox.renderConfigField(syntheticSchema[0], 'https://example.test/hook', false);
  assert.ok(html.includes('type="url"'), 'attendu input type=url');
  assert.ok(html.includes('value="https://example.test/hook"'), 'attendu valeur actuelle pré-remplie');
  assert.ok(html.includes('class="req"'), 'attendu marqueur requis');
  assert.ok(html.includes('URL HTTPS complète.'), 'attendu help_text affiché');
  assert.ok(html.includes('data-kind="URL"'), 'attendu data-kind=URL pour la collecte au submit');
});

test('SECRET field never renders the value, only presence state (set)', () => {
  const sandbox = runScript();
  const html = sandbox.renderConfigField(syntheticSchema[1], 'this-must-never-appear', true);
  assert.ok(html.includes('type="password"'), 'attendu input type=password');
  assert.ok(!html.includes('this-must-never-appear'), 'la valeur secrète ne doit JAMAIS apparaître dans le HTML rendu');
  assert.ok(!/value="[^"]+"/.test(html), 'aucun attribut value non vide sur un champ SECRET (jamais de placeholder faux secret envoyé comme valeur)');
  assert.ok(html.includes('Secret défini'), 'attendu état "défini" affiché');
  assert.ok(html.includes('class="secret-state set"'), 'attendu classe visuelle "set"');
});

test('SECRET field renders "not set" state distinctly when absent', () => {
  const sandbox = runScript();
  const html = sandbox.renderConfigField(syntheticSchema[1], undefined, false);
  assert.ok(html.includes('Secret non défini'), 'attendu état "non défini" affiché');
  assert.ok(html.includes('class="secret-state unset"'));
  assert.ok(html.includes('requis'), 'placeholder invite à saisir puisque rien n\'est configuré');
});

test('TEXT field renders type=text, optional field has no required marker', () => {
  const sandbox = runScript();
  const html = sandbox.renderConfigField(syntheticSchema[2], 'Mon Bot', false);
  assert.ok(html.includes('type="text"'));
  assert.ok(html.includes('value="Mon Bot"'));
  assert.ok(!html.includes('class="req"'), 'champ non requis : pas de marqueur *');
});

test('BOOLEAN field renders a true/false/unset select, never a free-text input', () => {
  const sandbox = runScript();
  const html = sandbox.renderConfigField(syntheticSchema[3], 'true', false);
  assert.ok(html.includes('<select'), 'attendu un <select> pour BOOLEAN');
  assert.ok(html.includes('<option value="true" selected>true</option>') || /value="true"[^>]*selected/.test(html), 'valeur true présélectionnée');
  assert.ok(html.includes('value="false"'), 'option false disponible');
});

test('SELECT field renders exactly the adapter-declared options, current value preselected', () => {
  const sandbox = runScript();
  const html = sandbox.renderConfigField(syntheticSchema[4], 'us', true);
  ['eu', 'us', 'apac'].forEach((opt) => {
    assert.ok(html.includes(`value="${opt}"`), `option ${opt} attendue`);
  });
  assert.ok(/<option value="us" selected>/.test(html), 'valeur courante présélectionnée');
});

test('buildConfigFormHTML renders all five kinds together from a single generic call, no platform-specific branch needed', () => {
  const sandbox = runScript();
  const detail = {
    non_secret_config: { endpoint_url: 'https://hook.example.test', display_label: 'Synthetic', auto_retry: 'false', region: 'apac' },
    secret_fields_set: { bot_token: true },
  };
  const html = sandbox.buildConfigFormHTML(syntheticSchema, detail);
  assert.ok(html.includes('Webhook Endpoint'));
  assert.ok(html.includes('Bot Token'));
  assert.ok(html.includes('Nom affiché'));
  assert.ok(html.includes('Relance automatique'));
  assert.ok(html.includes('Région'));
  assert.ok(!html.includes('this-must-never-appear'));
  // Preuve d'agnosticisme : rien dans platform-integrations.html ne
  // mentionne "facebook"/"app_id"/"app_secret" en dur — le même code a
  // rendu un schéma totalement différent sans modification.
  const fs2 = require('fs');
  const src = fs2.readFileSync(HTML_PATH, 'utf8');
  assert.ok(!/if\s*\(.*platform_id.*===.*facebook/i.test(src), 'aucune branche par platform_id dans le renderer');
  assert.ok(!/case\s*['"]facebook['"]/i.test(src), 'aucun switch par plateforme dans le renderer');
});

test('Facebook schema (2 fields) renders through the exact same generic function, no special casing', () => {
  const sandbox = runScript();
  const facebookSchema = [
    { key: 'app_id', label: 'Meta App ID', kind: 'TEXT', required: true },
    { key: 'app_secret', label: 'Meta App Secret', kind: 'SECRET', required: true },
  ];
  const detail = { non_secret_config: { app_id: 'synthetic-app-id' }, secret_fields_set: { app_secret: true } };
  const html = sandbox.buildConfigFormHTML(facebookSchema, detail);
  assert.ok(html.includes('synthetic-app-id'));
  assert.ok(!html.includes('synthetic-app-secret'), 'schéma Facebook: aucune valeur secrète dans le rendu, même chemin générique');
});

let passed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`PASS - ${t.name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL - ${t.name}`);
    console.error(err);
    process.exitCode = 1;
  }
}
console.log(`${passed}/${tests.length} test(s) passés.`);
if (passed !== tests.length) process.exitCode = 1;
