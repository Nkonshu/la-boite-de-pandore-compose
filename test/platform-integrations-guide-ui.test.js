// H3-008D1M — preuve que le rendu du guide GUIDÉ est GÉNÉRIQUE : extrait
// le <script> inline de public/admin/platform-integrations.html (MÊME
// technique que test/platform-integrations-ui.test.js) et exerce
// renderGuideStep avec des données SYNTHÉTIQUES hors catalogue, prouvant
// qu'aucune étape/texte Facebook n'est codée en dur dans ce fichier — le
// contenu réel du guide Facebook vit exclusivement côté adaptateur Go
// (internal/platform/facebook/configuration_guide.go, repo pandore).
//
// Usage : node test/platform-integrations-guide-ui.test.js
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
    addEventListener() {}, querySelectorAll() { return []; }, innerHTML: '', textContent: '',
  };
}
function fakeStorage() {
  const store = new Map();
  return { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
}
function runScript() {
  const elements = new Map();
  const sandbox = {
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, fakeElement()); return elements.get(id); }, querySelectorAll: () => [], addEventListener() {} },
    localStorage: fakeStorage(), sessionStorage: fakeStorage(),
    fetch: () => Promise.reject(new Error('fetch non simulé pour ce test')),
    console, URLSearchParams, URL, navigator: { clipboard: { writeText: () => Promise.resolve() } },
  };
  vm.createContext(sandbox);
  vm.runInContext(scriptSource, sandbox);
  return sandbox;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- Guide SYNTHÉTIQUE hors catalogue, couvrant chaque propriété d'étape
// listée au §1 du mandat H3-008D1M (titre, objectif, explication, champ
// Pandore, navigation externe, image, URL externe, texte à rechercher,
// valeur à copier, bouton Copier, avertissements, action attendue,
// confirmation). ---
const syntheticStep = {
  key: 'locate_widget_key', title: 'Localiser la clé Widget', objective: 'Trouver l\'identifiant du Widget.',
  explanation: 'Le Widget Key identifie votre intégration auprès de Synthetic Platform.',
  pandore_field_key: 'widget_key',
  external_url: 'https://synthetic-platform.test/console',
  external_navigation: 'Dans Paramètres → Développeur, repérer Widget Key.',
  search_text: 'Widget Key', image_ref: 'synthetic/v1/01-widget-key.png',
  pandore_value: '', copyable: false,
  warnings: ['Ne partagez jamais cette valeur.'], expected_action: 'Copier la valeur affichée.',
  confirmation_kind: 'USER_CONFIRMS',
};
const syntheticSecretStep = {
  key: 'enter_widget_secret', title: 'Saisir le Widget Secret', pandore_field_key: 'widget_secret',
  confirmation_kind: 'USER_CONFIRMS',
};
const syntheticCopyStep = {
  key: 'show_callback', title: 'Callback calculé', pandore_value: 'https://synthetic.example/callback',
  copyable: true, confirmation_kind: 'USER_CONFIRMS',
};
const syntheticSchema = [
  { key: 'widget_key', label: 'Widget Key', kind: 'TEXT', required: true },
  { key: 'widget_secret', label: 'Widget Secret', kind: 'SECRET', required: true },
];

test('renderGuideStep includes title, objective, explanation, external link, nav instructions, search text, warnings, expected action', () => {
  const sandbox = runScript();
  const html = sandbox.renderGuideStep(syntheticStep, 0, 3, syntheticSchema, {}, {});
  assert.ok(html.includes('Localiser la clé Widget'));
  assert.ok(html.includes('Trouver l&#39;identifiant du Widget.'));
  assert.ok(html.includes('Le Widget Key identifie'));
  assert.ok(html.includes('https://synthetic-platform.test/console'));
  assert.ok(html.includes('Dans Paramètres → Développeur'));
  assert.ok(html.includes('Widget Key'));
  assert.ok(html.includes('Ne partagez jamais cette valeur.'));
  assert.ok(html.includes('Copier la valeur affichée.'));
  assert.ok(html.includes('Étape 1 / 3'));
});

test('renderGuideStep renders the linked Pandore field inline via the SAME generic renderConfigField used by quick mode', () => {
  const sandbox = runScript();
  const html = sandbox.renderGuideStep(syntheticStep, 0, 3, syntheticSchema, { non_secret_config: { widget_key: 'wk-12345' } }, {});
  assert.ok(html.includes('data-key="widget_key"'));
  assert.ok(html.includes('value="wk-12345"'), 'attendu la valeur non-secrète déjà connue de Pandore pré-remplie');
  assert.ok(html.includes('type="text"'));
});

test('renderGuideStep never exposes a secret value, only presence state, even for a field-linked step', () => {
  const sandbox = runScript();
  const html = sandbox.renderGuideStep(syntheticSecretStep, 1, 3, syntheticSchema, { secret_fields_set: { widget_secret: true } }, {});
  assert.ok(html.includes('type="password"'));
  assert.ok(html.includes('Secret défini'));
  assert.ok(!/value="[^"]+"/.test(html), 'aucune valeur secrète ne doit jamais apparaître, même via un guide');
});

test('renderGuideStep shows the in-session typed value on revisit without ever reading it from browser storage', () => {
  const sandbox = runScript();
  // "values" simule guidedFieldValues : un objet JS EN MÉMOIRE, jamais
  // localStorage/sessionStorage (vérifié structurellement plus bas).
  const html = sandbox.renderGuideStep(syntheticStep, 0, 3, syntheticSchema, {}, { widget_key: 'typed-this-session' });
  assert.ok(html.includes('value="typed-this-session"'));
});

test('renderGuideStep renders a copyable Pandore value with a Copier button, and a non-copyable one without', () => {
  const sandbox = runScript();
  const htmlCopyable = sandbox.renderGuideStep(syntheticCopyStep, 2, 3, [], {}, {});
  assert.ok(htmlCopyable.includes('https://synthetic.example/callback'));
  assert.ok(htmlCopyable.includes('Copier'));
  assert.ok(htmlCopyable.includes('data-copy-value='));

  const nonCopyableStep = { ...syntheticCopyStep, copyable: false };
  const htmlNonCopyable = sandbox.renderGuideStep(nonCopyableStep, 2, 3, [], {}, {});
  assert.ok(!htmlNonCopyable.includes('data-copy-value='));
});

test('renderGuideStep distinguishes MACHINE_VERIFIED from USER_CONFIRMS in its confirmation text', () => {
  const sandbox = runScript();
  const machineStep = { key: 'save', title: 'Enregistrer', confirmation_kind: 'MACHINE_VERIFIED' };
  const userStep = { key: 'external_action', title: 'Action externe', confirmation_kind: 'USER_CONFIRMS' };
  const htmlMachine = sandbox.renderGuideStep(machineStep, 0, 2, [], {}, {});
  const htmlUser = sandbox.renderGuideStep(userStep, 1, 2, [], {}, {});
  assert.ok(htmlMachine.includes('vérifiée par Pandore'));
  assert.ok(htmlUser.includes('à confirmer par vous-même'));
});

test('renderGuideStep shows an explicit placeholder when no illustration is available, never a fabricated image', () => {
  const sandbox = runScript();
  const stepWithoutImage = { key: 'x', title: 'Sans image', confirmation_kind: 'USER_CONFIRMS' };
  const html = sandbox.renderGuideStep(stepWithoutImage, 0, 1, [], {}, {});
  assert.ok(html.includes('Aucune illustration disponible'));
});

// --- H3-008D1M1 §1/§2/§7 — illustrations réelles : résolution d'asset,
// alt text, fallback propre, absence de secret. ---

test('resolveGuideAssetURL resolves an ImageRef to the expected static asset path, URL-encoding each segment', () => {
  const sandbox = runScript();
  assert.strictEqual(sandbox.resolveGuideAssetURL('facebook/v1/03-locate-app-id.png'), '/admin/guide-assets/facebook/v1/03-locate-app-id.png');
  // Segments contenant des caractères spéciaux restent sûrs (jamais une
  // injection de chemin construite depuis une donnée d'adaptateur).
  assert.strictEqual(sandbox.resolveGuideAssetURL('a b/v1/c.png'), '/admin/guide-assets/a%20b/v1/c.png');
});

test('renderGuideStep with an image_ref renders a real <img> resolved via resolveGuideAssetURL, with descriptive alt text and an onerror fallback — never a fabricated placeholder text', () => {
  const sandbox = runScript();
  const html = sandbox.renderGuideStep(syntheticStep, 0, 3, syntheticSchema, {}, {});
  assert.ok(html.includes('<img'), 'attendu une vraie balise <img> quand image_ref est présent');
  assert.ok(html.includes(sandbox.resolveGuideAssetURL(syntheticStep.image_ref)), 'attendu le src résolu via resolveGuideAssetURL, jamais une URL construite ailleurs');
  assert.ok(html.includes('alt="Copier la valeur affichée.') || /alt="[^"]+"/.test(html), 'attendu un alt text non vide et descriptif');
  assert.ok(html.includes('onerror='), 'attendu un fallback onerror, jamais une image cassée silencieuse');
  assert.ok(!/Illustration : /.test(html), 'jamais un texte affichant la référence brute comme substitut à une vraie image');
});

test('renderGuideStep image never leaks a secret value in its src or alt attributes', () => {
  const sandbox = runScript();
  const stepWithImageAndSecretField = { ...syntheticSecretStep, image_ref: 'synthetic/v1/02-widget-secret.png' };
  const html = sandbox.renderGuideStep(stepWithImageAndSecretField, 1, 3, syntheticSchema, { secret_fields_set: { widget_secret: true } }, { widget_secret: 'typed-secret-must-never-leak' });
  assert.ok(!html.includes('typed-secret-must-never-leak'), 'attendu la valeur secrète absente MÊME lorsque l’étape a une image');
});

test('a step without image_ref never renders an <img> tag, only the explicit unavailable message (no fabricated illustration)', () => {
  const sandbox = runScript();
  const stepWithoutImage = { key: 'x', title: 'Sans image', confirmation_kind: 'USER_CONFIRMS' };
  const html = sandbox.renderGuideStep(stepWithoutImage, 0, 1, [], {}, {});
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('Aucune illustration disponible'));
});

// --- H3-008D1M1 §3 — manifeste de provenance/version des assets ---

test('validateGuideAssetManifest accepts a well-formed manifest with a single CURRENT entry per platform/step', () => {
  const sandbox = runScript();
  const result = sandbox.validateGuideAssetManifest([
    { image_ref: 'facebook/v1/03-locate-app-id.png', platform: 'facebook', guide_version: 'v1', steps: ['locate_app_id'], verified_at: '2026-09-17', provenance: 'REAL_MANUAL_SETUP', status: 'CURRENT' },
  ]);
  assert.strictEqual(result.valid, true);
  // .length plutôt que deepStrictEqual([]) : `result` provient d'un
  // contexte vm distinct (Array.prototype d'une autre "réalité" JS) — un
  // artefact d'isolation, jamais un vrai désaccord de structure.
  assert.strictEqual(result.errors.length, 0);
});

test('validateGuideAssetManifest rejects two CURRENT entries for the same platform+step (contradictory illustrations)', () => {
  const sandbox = runScript();
  const result = sandbox.validateGuideAssetManifest([
    { image_ref: 'facebook/v1/03-locate-app-id.png', platform: 'facebook', steps: ['locate_app_id'], provenance: 'REAL_MANUAL_SETUP', status: 'CURRENT' },
    { image_ref: 'facebook/v2/03-locate-app-id-new.png', platform: 'facebook', steps: ['locate_app_id'], provenance: 'REAL_MANUAL_SETUP', status: 'CURRENT' },
  ]);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('conflit CURRENT')));
});

test('validateGuideAssetManifest allows replacing an image when the old entry is marked SUPERSEDED', () => {
  const sandbox = runScript();
  const result = sandbox.validateGuideAssetManifest([
    { image_ref: 'facebook/v1/03-locate-app-id.png', platform: 'facebook', steps: ['locate_app_id'], provenance: 'REAL_MANUAL_SETUP', status: 'SUPERSEDED' },
    { image_ref: 'facebook/v2/03-locate-app-id-new.png', platform: 'facebook', steps: ['locate_app_id'], provenance: 'REAL_MANUAL_SETUP', status: 'CURRENT' },
  ]);
  assert.strictEqual(result.valid, true);
});

test('validateGuideAssetManifest rejects any provenance other than REAL_MANUAL_SETUP (never a fabricated/generated capture)', () => {
  const sandbox = runScript();
  const result = sandbox.validateGuideAssetManifest([
    { image_ref: 'facebook/v1/x.png', platform: 'facebook', steps: ['x'], provenance: 'AI_GENERATED', status: 'CURRENT' },
  ]);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('REAL_MANUAL_SETUP')));
});

// --- H3-008D1M1 (reprise) — le paquet facebook-guide-assets-v1.zip a été
// reçu, inspecté image par image (pas de confiance dans les noms de
// fichiers fournis — voir internal/platform/facebook/configuration_guide.go
// côté pandore), et installé. Le manifeste n'est plus vide : ces preuves
// remplacent l'ancienne preuve "manifeste vide et honnête". ---

test('the actual manifest.json shipped with this repo is non-empty, valid, and every entry uses REAL_MANUAL_SETUP provenance with CURRENT status', () => {
  const sandbox = runScript();
  const manifestPath = path.join(__dirname, '..', 'public', 'admin', 'guide-assets', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.ok(manifest.length > 0, 'attendu un manifeste non vide maintenant que les captures réelles ont été fournies');
  for (const entry of manifest) {
    assert.strictEqual(entry.provenance, 'REAL_MANUAL_SETUP', `${entry.image_ref}: provenance doit être REAL_MANUAL_SETUP`);
    assert.strictEqual(entry.status, 'CURRENT', `${entry.image_ref}: statut attendu CURRENT`);
    assert.ok(Array.isArray(entry.steps) && entry.steps.length > 0, `${entry.image_ref}: doit être rattaché à au moins une étape`);
  }
  const result = sandbox.validateGuideAssetManifest(manifest);
  assert.strictEqual(result.valid, true, `manifeste invalide: ${JSON.stringify(result.errors)}`);
});

test('every image_ref declared in the real manifest resolves to a file that actually exists on disk (no dangling/fabricated reference)', () => {
  const manifestPath = path.join(__dirname, '..', 'public', 'admin', 'guide-assets', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const entry of manifest) {
    const assetPath = path.join(__dirname, '..', 'public', 'admin', 'guide-assets', ...entry.image_ref.split('/'));
    assert.ok(fs.existsSync(assetPath), `fichier attendu manquant pour ${entry.image_ref}: ${assetPath}`);
  }
});

test('no two CURRENT manifest entries claim the same platform+step (no contradictory illustration in the real manifest)', () => {
  const manifestPath = path.join(__dirname, '..', 'public', 'admin', 'guide-assets', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const seen = new Set();
  for (const entry of manifest) {
    if (entry.status !== 'CURRENT') continue;
    for (const step of entry.steps) {
      const k = `${entry.platform}:${step}`;
      assert.ok(!seen.has(k), `conflit CURRENT détecté pour ${k}`);
      seen.add(k);
    }
  }
});

test('no real asset PNG bytes contain the Pandore-configured App Secret/token/credential markers as plain text (defense-in-depth, on top of manual visual review)', () => {
  const assetsDir = path.join(__dirname, '..', 'public', 'admin', 'guide-assets', 'facebook', 'v1');
  const forbidden = ['app_secret', 'appsecret', 'access_token', 'client_secret'];
  for (const file of fs.readdirSync(assetsDir)) {
    const raw = fs.readFileSync(path.join(assetsDir, file), 'latin1').toLowerCase();
    for (const marker of forbidden) {
      assert.ok(!raw.includes(marker), `${file}: contient un marqueur textuel suspect (${marker})`);
    }
  }
});

// --- Preuve d'agnosticisme structurel : rien dans ce fichier ne mentionne
// Facebook/Meta dans la logique de rendu du guide (le contenu réel vit
// côté adaptateur Go, jamais ici). ---
test('guide rendering engine contains no Facebook/Meta-specific branch or hardcoded guide content', () => {
  const src = fs.readFileSync(HTML_PATH, 'utf8');
  const scriptOnly = src.match(/<script>([\s\S]*?)<\/script>/)[1];
  // Les commentaires de conception PEUVENT mentionner "Facebook" à titre
  // d'exemple (voir le mandat lui-même) — ce qui est interdit, c'est un
  // contenu de guide réel codé en dur ou une branche fonctionnelle par
  // plateforme, jamais le mot dans un commentaire explicatif.
  assert.ok(!/meta for developers/i.test(scriptOnly), 'attendu aucun texte de guide Facebook codé en dur');
  assert.ok(!/localiser le meta app id/i.test(scriptOnly), 'attendu aucune étape Facebook codée en dur dans le moteur générique');
  assert.ok(!/if\s*\(.*platform_id.*===/.test(scriptOnly), 'attendu aucune branche par platform_id dans le moteur de guide');
  assert.ok(!/switch\s*\(.*platform/i.test(scriptOnly), 'attendu aucun switch par plateforme dans le moteur de guide');
});

let passed = 0;
for (const t of tests) {
  try { t.fn(); console.log(`PASS - ${t.name}`); passed++; }
  catch (err) { console.error(`FAIL - ${t.name}`); console.error(err); process.exitCode = 1; }
}
console.log(`${passed}/${tests.length} test(s) passés.`);
if (passed !== tests.length) process.exitCode = 1;
