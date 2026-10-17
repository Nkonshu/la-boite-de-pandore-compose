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

// H3-008D1Q36N4A5D68EC — fixture représentative de la vraie réponse
// backend pour une ReviewRequest Content (toPublicContentReviewView),
// jamais un jeton réel.
const contentFixture = {
  kind: 'CONTENT',
  status: 'PENDING',
  version: 3,
  platform: 'facebook',
  format: 'Vidéo courte',
  hook: 'Connaissez-vous ce mot qui fait rire tous les Camerounais ?',
  body: 'Dans Chap Chap, le jeu mobile qui célèbre argot camerounais...',
  cta: 'Accédez à la version de test via le lien invitation.',
  caption: 'Testez votre connaissance de l’argot camerounais !',
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

// --- H3-008D1Q36N4A5D68EC — support de kind="CONTENT" ---

// K — une réponse Content PENDING s'affiche réellement (plus de "Ce lien
// n'est plus actif.") avec les actions de décision visibles.
test('K. Content PENDING renders with decision actions visible', async () => {
  const sandbox = runPage('?token=content-token');
  sandbox.fetch = () => Promise.resolve({ status: 200, ok: true, json: async () => contentFixture });
  await sandbox.load();
  const out = sandbox.__app.innerHTML;
  assert.ok(!out.includes("Ce lien n'est plus actif."), 'ne doit PAS afficher le message générique "lien plus actif" pour un Content PENDING');
  assert.ok(out.includes(contentFixture.hook), 'hook absent du rendu');
  assert.ok(out.includes(contentFixture.body), 'body absent du rendu');
  assert.ok(out.includes(contentFixture.cta), 'cta absent du rendu');
  assert.ok(out.includes(contentFixture.caption), 'caption absent du rendu');
  assert.ok(out.includes('3'), 'version absente du rendu');
  assert.ok(out.includes('facebook'), 'platform absente du rendu');
  assert.ok(out.includes('Oui, ce contenu me convient'), 'action Approuver absente');
  assert.ok(out.includes('Ce contenu ne me convient pas'), 'action Rejeter absente');
  assert.ok(out.includes('modifier certains points'), 'action Modifications absente');
});

// L/M/N/O — statuts terminaux Content : message spécifique, jamais le
// formulaire de décision.
test('L. Content APPROVED shows terminal message, no decision form', async () => {
  const sandbox = runPage('?token=content-token');
  sandbox.fetch = () => Promise.resolve({ status: 200, ok: true, json: async () => ({ ...contentFixture, status: 'APPROVED' }) });
  await sandbox.load();
  const out = sandbox.__app.innerHTML;
  assert.ok(out.includes('Vous avez approuvé ce contenu.'), 'message "approuvé" Content attendu');
  assert.ok(!out.includes('Oui, ce contenu me convient'), 'le formulaire de décision ne doit pas réapparaître');
});

test('M. Content REJECTED shows terminal message, no decision form', async () => {
  const sandbox = runPage('?token=content-token');
  sandbox.fetch = () => Promise.resolve({ status: 200, ok: true, json: async () => ({ ...contentFixture, status: 'REJECTED' }) });
  await sandbox.load();
  const out = sandbox.__app.innerHTML;
  assert.ok(out.includes('Vous avez indiqué que ce contenu ne vous convient pas.'), 'message "rejeté" Content attendu');
  assert.ok(!out.includes('Oui, ce contenu me convient'), 'le formulaire de décision ne doit pas réapparaître');
});

test('N. Content CHANGES_REQUESTED shows terminal message, no decision form', async () => {
  const sandbox = runPage('?token=content-token');
  sandbox.fetch = () => Promise.resolve({ status: 200, ok: true, json: async () => ({ ...contentFixture, status: 'CHANGES_REQUESTED' }) });
  await sandbox.load();
  const out = sandbox.__app.innerHTML;
  assert.ok(out.includes('Votre demande de modification a bien été enregistrée.'), 'message "modifications demandées" Content attendu');
  assert.ok(!out.includes('Oui, ce contenu me convient'), 'le formulaire de décision ne doit pas réapparaître');
});

test('O. Content EXPIRED shows terminal message, no decision form', async () => {
  const sandbox = runPage('?token=content-token');
  sandbox.fetch = () => Promise.resolve({ status: 200, ok: true, json: async () => ({ ...contentFixture, status: 'EXPIRED' }) });
  await sandbox.load();
  const out = sandbox.__app.innerHTML;
  // "Ce lien n'est plus actif." passe par esc() dans le rendu (l'apostrophe
  // devient &#39;) — on vérifie un fragment sans apostrophe, même patron
  // que les tests I/J déjà existants.
  assert.ok(out.includes('Ce lien') && out.includes('actif.'), 'message EXPIRED Content attendu (cas légitime, distinct du bug D68EB)');
  assert.ok(!out.includes('Oui, ce contenu me convient'), 'le formulaire de décision ne doit pas réapparaître');
});

// P — un kind réellement inconnu échoue fermé : jamais rendu comme Plan,
// jamais de formulaire de décision exposé (régression D68EB/§8).
test('P. Unknown kind fails closed, never silently rendered as Plan', async () => {
  const sandbox = runPage('?token=future-token');
  sandbox.fetch = () => Promise.resolve({
    status: 200, ok: true,
    json: async () => ({ kind: 'FUTURE_UNKNOWN_TYPE', status: 'PENDING' }),
  });
  await sandbox.load();
  const out = sandbox.__app.innerHTML;
  assert.ok(out.includes('pas pris en charge'), 'message "type non pris en charge" attendu');
  assert.ok(!out.includes("Ce lien n'est plus actif."), 'ne doit pas réutiliser le message générique trompeur du bug D68EB');
  assert.ok(!/data-decision/.test(out), 'aucun bouton de décision ne doit être exposé pour un kind inconnu');
});

// Q — sécurité XSS : les champs Content sont des données, jamais injectées
// sans échappement (même garantie déjà exigée pour Plan/Editorial, test E).
test('Q. Content fields are XSS-safe (no raw HTML/script execution)', async () => {
  const hostile = {
    ...contentFixture,
    hook: '<script>window.__xss_hook = true;</script>',
    body: '<img src=x onerror="window.__xss_body = true">',
    cta: `"><svg onload="window.__xss_cta=true">`,
    caption: `& < > " ' caractères spéciaux`,
  };
  const sandbox = runPage('?token=content-token');
  sandbox.fetch = () => Promise.resolve({ status: 200, ok: true, json: async () => hostile });
  await sandbox.load();
  const out = sandbox.__app.innerHTML;
  // La propriété de sécurité réelle : aucune balise active NON échappée —
  // un "<" littéral suivi d'un nom de balise ne doit jamais apparaître.
  // Vérifier la simple PRÉSENCE de "onerror="/"onload=" en texte serait un
  // faux positif : une fois son "<"/">" échappés, la balise n'est plus
  // qu'une chaîne inerte, même si elle contient encore ce mot.
  assert.ok(!out.includes('<script>') && !out.includes('<script '), 'un <script> brut ne doit jamais apparaître dans le HTML généré');
  assert.ok(!out.includes('<img '), 'une balise <img> brute ne doit jamais apparaître');
  assert.ok(!out.includes('<svg '), 'une balise <svg> brute ne doit jamais apparaître');
  assert.ok(out.includes('&lt;script&gt;'), 'le hook hostile doit être échappé, jamais exécutable');
  assert.ok(out.includes('&lt;img'), 'le body hostile doit être échappé, jamais un vrai <img>');
  assert.ok(out.includes('&lt;svg'), 'le cta hostile doit être échappé, jamais un vrai <svg>');
  assert.ok(out.includes('&amp;') && out.includes('&quot;') && out.includes('&#39;'), 'les caractères spéciaux de caption doivent être échappés');
});

// R/S/T — compatibilité du schéma POST de décision pour Content (même
// endpoint/contrat que Plan/Editorial, submit() reste générique).
test('R. Content APPROVED decision POST schema compatible', async () => {
  const sandbox = runPage('?token=content-token');
  sandbox.fetch = () => Promise.resolve({ status: 200, ok: true, json: async () => contentFixture });
  await sandbox.load();
  let capturedUrl, capturedBody;
  sandbox.fetch = (url, opts) => {
    capturedUrl = url;
    capturedBody = JSON.parse(opts.body);
    return Promise.resolve({ ok: true, json: async () => ({ status: 'decision enregistrée' }) });
  };
  await sandbox.submit('APPROVED');
  assert.strictEqual(capturedUrl, '/api/public/plans/content-token/decision');
  assert.deepStrictEqual(capturedBody, { decision: 'APPROVED', comment: '' });
});

test('S. Content REJECTED decision POST schema compatible', async () => {
  const sandbox = runPage('?token=content-token');
  sandbox.fetch = () => Promise.resolve({ status: 200, ok: true, json: async () => contentFixture });
  await sandbox.load();
  let capturedBody;
  sandbox.fetch = (url, opts) => { capturedBody = JSON.parse(opts.body); return Promise.resolve({ ok: true, json: async () => ({}) }); };
  await sandbox.submit('REJECTED');
  assert.strictEqual(capturedBody.decision, 'REJECTED');
});

test('T. Content CHANGES_REQUESTED decision POST schema compatible (comment required)', async () => {
  const sandbox = runPage('?token=content-token');
  sandbox.fetch = () => Promise.resolve({ status: 200, ok: true, json: async () => contentFixture });
  await sandbox.load();
  let fetchCalled = false;
  sandbox.fetch = () => { fetchCalled = true; return Promise.resolve({ ok: true, json: async () => ({}) }); };
  await sandbox.submit('CHANGES_REQUESTED');
  assert.strictEqual(fetchCalled, false, 'aucune soumission sans commentaire, même règle que Plan/Editorial');

  sandbox.document.getElementById('comment-CHANGES_REQUESTED').value = 'Merci de raccourcir le hook.';
  let capturedBody;
  sandbox.fetch = (url, opts) => { capturedBody = JSON.parse(opts.body); return Promise.resolve({ ok: true, json: async () => ({}) }); };
  await sandbox.submit('CHANGES_REQUESTED');
  assert.strictEqual(capturedBody.decision, 'CHANGES_REQUESTED');
  assert.strictEqual(capturedBody.comment, 'Merci de raccourcir le hook.');
});

// U — réponse Content malformée (hook/body indispensables absents) :
// échec sûr, jamais une review vide avec un formulaire de décision actif.
test('U. Malformed Content response fails safe, no empty review shown', async () => {
  const sandbox = runPage('?token=content-token');
  sandbox.fetch = () => Promise.resolve({ status: 200, ok: true, json: async () => ({ kind: 'CONTENT', status: 'PENDING', version: 3 }) });
  await sandbox.load();
  const out = sandbox.__app.innerHTML;
  assert.ok(out.includes('incomplet'), 'message "contenu incomplet" attendu');
  assert.ok(!/data-decision/.test(out), 'aucun bouton de décision ne doit être exposé pour une réponse incomplète');
});

// V — régression explicite LEGACY (inchangé par ce lot).
test('V. Legacy plan rendering unaffected by Content support', () => {
  const sandbox = runPage('?token=legacy-token');
  const legacyFixture = {
    status: 'SENT', kind: 'LEGACY',
    problem_understood: 'Problème compris.', audience: 'Audience legacy.',
    proposal: 'Proposition legacy.', pandore_responsibilities: 'Pandore fera X.',
    client_responsibilities: 'Client fera Y.', measurement_method: 'Mesure legacy.',
  };
  sandbox.renderLegacy(legacyFixture);
  const out = sandbox.__app.innerHTML;
  assert.ok(out.includes('Proposition legacy.'), 'rendu Legacy inchangé attendu');
  assert.ok(out.includes('Oui, ce plan me convient'), 'copy de décision Legacy (Plan) inchangée');
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
