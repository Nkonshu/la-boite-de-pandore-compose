// Editorial Approval Public Frontend Readiness §10 — le plus petit test
// pertinent possible, SANS nouvelle dépendance npm (ce dépôt n'avait
// jusqu'ici aucune infrastructure de test). Extrait le <script> inline de
// public/plan-decision.html et l'exécute dans un contexte vm minimal
// (document/location/fetch simulés) — jamais de navigateur réel, jamais
// de nouveau framework de test.
//
// Usage : node test/plan-decision.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const HTML_PATH = path.join(__dirname, '..', 'public', 'plan-decision.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  throw new Error('plan-decision.html: <script> introuvable — le fichier a-t-il changé de structure ?');
}
const scriptSource = scriptMatch[1];

function fakeElement() {
  return {
    value: '',
    style: {},
    classList: { add() {}, remove() {} },
    addEventListener() {},
  };
}

// runPage — construit un contexte vm frais (token/app recalculés à
// l'exécution du script, comme dans un vrai chargement de page) et
// exécute le script inline dedans. locationSearch pilote le token lu par
// `new URLSearchParams(location.search).get('token')`.
function runPage(locationSearch) {
  const elements = new Map();
  const app = { innerHTML: '', querySelectorAll: () => [] };
  const sandbox = {
    document: {
      getElementById(id) {
        if (id === 'app') return app;
        if (!elements.has(id)) elements.set(id, fakeElement());
        return elements.get(id);
      },
    },
    location: { search: locationSearch || '' },
    URLSearchParams,
    console,
    fetch: () => Promise.reject(new Error('fetch non simulé pour ce test')),
  };
  vm.createContext(sandbox);
  vm.runInContext(scriptSource, sandbox);
  sandbox.__app = app;
  sandbox.__elements = elements;
  return sandbox;
}

const planFixture = {
  status: 'SENT',
  kind: 'PRESENTATION',
  objective_summary: 'Augmenter les téléchargements.',
  audience_summary: '18-40 ans.',
  channel: 'Facebook',
  cadence_summary: 'Une fois par jour.',
  validation_summary: 'Vous validez chaque publication.',
  what_we_understood: 'Compréhension du besoin.',
  what_pandore_proposes: 'Proposition de contenu.',
  pandore_commitments: ['Préparer le contenu.'],
  client_needs: ['Fournir la matière disponible.'],
  measurement_explanation: 'Suivi manuel.',
  decision_scope: 'Approuver ce plan lance la préparation du contenu.',
};

const editorialFixture = {
  status: 'PENDING',
  kind: 'EDITORIAL_REVIEW_PRESENTATION',
  statements: [
    { client_text: 'Le ton retenu pour vos contenus est pédagogique.', is_recommendation: false },
    { client_text: 'Nous recommandons un CTA court en fin de vidéo.', is_recommendation: true },
  ],
  decision_scope: "Approuver ceci valide la ligne éditoriale, jamais le contenu ni la publication.",
};

const FORBIDDEN_STRINGS = [
  'CANONICAL_SOURCE', 'EDITORIAL_RECOMMENDATION', 'AI_INFERENCE', 'ADMIN_VERIFIED',
  'CLIENT_VERIFIED', 'SourceRef', 'source_type', 'TenantConfiguration',
  'APPROVED_FOR_SIMULATION', 'DecisionTrace', 'strategy_id', 'presentation_id',
];

// tests — collectées d'abord, exécutées séquentiellement (await inclus)
// dans le runner en bas de fichier : un test() synchrone ne suffit pas ici
// puisque plusieurs cas (G/H/I/J) sont asynchrones (submit/load renvoient
// des Promises) — les exécuter sans attendre masquerait un rejet tardif
// derrière un "PASS" déjà affiché.
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// A — le rendu Plan existant continue de fonctionner sans changement de
// contenu (mêmes champs, mêmes libellés).
test('A. existing Plan approval still renders', () => {
  const sandbox = runPage('?token=plan-token');
  sandbox.renderPresentation(planFixture);
  const out = sandbox.__app.innerHTML;
  assert.ok(out.includes('Augmenter les téléchargements.'), 'objective_summary absent');
  assert.ok(out.includes('Oui, ce plan me convient'), 'libellé Plan inchangé attendu');
  assert.ok(out.includes('Approuver ce plan lance la préparation du contenu.'), 'decision_scope Plan absent');
});

// B — la présentation éditoriale se rend sans erreur et affiche son
// contenu client-safe.
test('B. editorial presentation renders', () => {
  const sandbox = runPage('?token=editorial-token');
  sandbox.renderEditorial(editorialFixture);
  const out = sandbox.__app.innerHTML;
  assert.ok(out.includes('Orientation éditoriale'), 'en-tête éditorial absent');
  assert.ok(out.includes('Le ton retenu pour vos contenus est pédagogique.'), 'statement canonique absent');
  assert.ok(out.includes('Nous recommandons un CTA court en fin de vidéo.'), 'statement recommandation absent');
});

// C/D — le fait établi et la recommandation apparaissent sous deux
// intitulés distincts, jamais mélangés sans distinction.
test('C/D. canonical guidance and recommendations are distinguishable', () => {
  const sandbox = runPage('?token=editorial-token');
  sandbox.renderEditorial(editorialFixture);
  const out = sandbox.__app.innerHTML;
  const establishedIdx = out.indexOf('Ce qui est déjà établi');
  const recommendationsIdx = out.indexOf('Nos recommandations');
  assert.ok(establishedIdx !== -1, 'section "Ce qui est déjà établi" absente');
  assert.ok(recommendationsIdx !== -1, 'section "Nos recommandations" absente');
  const canonicalTextIdx = out.indexOf('pédagogique');
  const recommendationTextIdx = out.indexOf('CTA court');
  assert.ok(canonicalTextIdx > establishedIdx && canonicalTextIdx < recommendationsIdx, 'le fait établi doit apparaître dans sa propre section');
  assert.ok(recommendationTextIdx > recommendationsIdx, 'la recommandation doit apparaître dans sa propre section');
});

// E — jamais d'enum interne/ID/SourceRef affiché, ni pour Plan ni pour
// Editorial.
test('E. internal enums/IDs/SourceRefs are never shown', () => {
  const sandboxPlan = runPage('?token=plan-token');
  sandboxPlan.renderPresentation(planFixture);
  const sandboxEditorial = runPage('?token=editorial-token');
  sandboxEditorial.renderEditorial(editorialFixture);
  for (const out of [sandboxPlan.__app.innerHTML, sandboxEditorial.__app.innerHTML]) {
    for (const forbidden of FORBIDDEN_STRINGS) {
      assert.ok(!out.includes(forbidden), `chaîne interdite trouvée dans le rendu: ${forbidden}`);
    }
  }
});

// F — decision_scope (DecisionScopeText) est affiché tel quel.
test('F. DecisionScopeText is shown', () => {
  const sandbox = runPage('?token=editorial-token');
  sandbox.renderEditorial(editorialFixture);
  assert.ok(sandbox.__app.innerHTML.includes(editorialFixture.decision_scope), 'decision_scope absent du rendu');
});

// G — approve soumet bien decision=APPROVED vers l'API existante,
// inchangée (même endpoint que Plan).
test('G. approve submits the existing decision API correctly', async () => {
  const sandbox = runPage('?token=editorial-token');
  let capturedUrl, capturedBody;
  sandbox.fetch = (url, opts) => {
    capturedUrl = url;
    capturedBody = JSON.parse(opts.body);
    return Promise.resolve({ ok: true, json: async () => ({ status: 'decision enregistrée' }) });
  };
  await sandbox.submit('APPROVED');
  assert.strictEqual(capturedUrl, '/api/public/plans/editorial-token/decision');
  assert.strictEqual(capturedBody.decision, 'APPROVED');
});

// H — changes_requested exige un commentaire (garde côté client déjà
// existante, inchangée) et le transmet correctement une fois rempli.
test('H. changes-requested requires and submits comment correctly', async () => {
  const sandbox = runPage('?token=editorial-token');
  let fetchCalled = false;
  sandbox.fetch = () => { fetchCalled = true; return Promise.resolve({ ok: true, json: async () => ({}) }); };

  // Sans commentaire : aucun appel réseau, message requis affiché.
  await sandbox.submit('CHANGES_REQUESTED');
  assert.strictEqual(fetchCalled, false, 'aucune soumission ne doit partir sans commentaire');

  // Avec commentaire : soumission correcte.
  sandbox.document.getElementById('comment-CHANGES_REQUESTED').value = 'Merci de préciser le ton des tutoriels.';
  let capturedBody;
  sandbox.fetch = (url, opts) => { capturedBody = JSON.parse(opts.body); return Promise.resolve({ ok: true, json: async () => ({}) }); };
  await sandbox.submit('CHANGES_REQUESTED');
  assert.strictEqual(capturedBody.decision, 'CHANGES_REQUESTED');
  assert.strictEqual(capturedBody.comment, 'Merci de préciser le ton des tutoriels.');
});

// I — jeton invalide (404) et déjà décidé (statut != en-attente) sont
// gérés sans exposer les détails backend.
test('I. invalid token handled client-safely', async () => {
  const sandbox = runPage('?token=bad-token');
  sandbox.fetch = () => Promise.resolve({ status: 404, ok: false, json: async () => ({}) });
  await sandbox.load();
  assert.ok(sandbox.__app.innerHTML.includes('lien est invalide'), 'message jeton invalide attendu');
});

// J — une présentation déjà décidée affiche le message de statut, jamais
// le formulaire de décision à nouveau.
test('J. already-decided editorial request handled', async () => {
  const sandbox = runPage('?token=editorial-token');
  sandbox.fetch = () => Promise.resolve({
    status: 200, ok: true,
    json: async () => ({ ...editorialFixture, status: 'APPROVED' }),
  });
  await sandbox.load();
  const out = sandbox.__app.innerHTML;
  assert.ok(out.includes('Vous avez approuvé cette orientation éditoriale.'), 'message "déjà approuvé" éditorial attendu');
  assert.ok(!out.includes('Oui, cette orientation me convient'), 'le formulaire de décision ne doit pas réapparaître');
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log('PASS -', name);
    } catch (err) {
      console.error('FAIL -', name);
      console.error('  ' + err.message);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${tests.length} test(s) passés.`);
  if (process.exitCode) {
    console.error('ÉCHEC — voir les FAIL ci-dessus.');
  }
})();
