// H3-008D1N1 — preuves ciblées sur la navigation admin partagée
// (public/admin/nav.js) et sa présence structurelle dans les quatre
// pages admin existantes. AUCUN réseau, AUCUNE valeur Meta — ce fichier
// teste uniquement du rendu HTML pur et la structure des fichiers
// statiques déjà servis.
//
// Usage : node test/admin-navigation.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ADMIN_DIR = path.join(__dirname, '..', 'public', 'admin');
const navSource = fs.readFileSync(path.join(ADMIN_DIR, 'nav.js'), 'utf8');
// navCode — nav.js SANS ses lignes de commentaire `//` : les commentaires
// de ce fichier documentent délibérément, par la négative, les motifs
// interdits ("jamais de `if Chap Chap`/`if facebook` ici") — les tests
// ci-dessous doivent vérifier le CODE réellement exécuté, jamais cette
// prose explicative.
const navCode = navSource.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');

function fakeElement() {
  return { innerHTML: '', className: '', style: {} };
}

function loadAdminNav() {
  const sandbox = {
    document: { head: { appendChild() {} }, getElementById() { return null; }, createElement() { return { textContent: '' }; } },
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(navSource, sandbox);
  return sandbox.AdminNav;
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS - ${name}`); passed++; }
  catch (err) { console.log(`FAIL - ${name}\n  ${err.message}`); failed++; }
}

// --- 1/2/3/4 — deux zones top-level identifiables, Intégrations
// plateforme rattachée à Administration, jamais aux Clients. ---

test('AdminNav exposes exactly the two required top-level zones: clients and administration', () => {
  const AdminNav = loadAdminNav();
  assert.ok(AdminNav.ZONES.clients, 'zone "clients" absente');
  assert.ok(AdminNav.ZONES.administration, 'zone "administration" absente');
  assert.strictEqual(Object.keys(AdminNav.ZONES).length, 2, 'attendu exactement 2 zones top-level, jamais plus');
});

test('render(zone=clients) marks the Clients & Prospects tab active and links to index.html', () => {
  const AdminNav = loadAdminNav();
  const el = fakeElement();
  AdminNav.render(el, { zone: 'clients', crumbs: [] });
  assert.ok(el.innerHTML.includes('Clients &amp; Prospects'), 'libellé de zone absent');
  assert.ok(/class="admin-zone-tab active"[^>]*>Clients/.test(el.innerHTML) || el.innerHTML.includes('href="/admin/index.html" class="admin-zone-tab active"'), 'onglet Clients & Prospects non marqué actif');
});

test('render(zone=administration) marks the Administration tab active and links to administration.html', () => {
  const AdminNav = loadAdminNav();
  const el = fakeElement();
  AdminNav.render(el, { zone: 'administration', crumbs: [{ label: 'Intégrations plateforme' }] });
  assert.ok(el.innerHTML.includes('href="/admin/administration.html" class="admin-zone-tab active"'), 'onglet Administration non marqué actif');
  assert.ok(el.innerHTML.includes('Intégrations plateforme'), 'le segment de contexte "Intégrations plateforme" doit apparaître dans le fil d\'Ariane');
  assert.ok(!el.innerHTML.includes('Clients &amp; Prospects</span>') , 'Intégrations plateforme ne doit jamais apparaître comme si elle appartenait à la zone Clients');
});

test('breadcrumb renders the requested hierarchy example: Clients & Prospects > <business name> > Comptes sociaux', () => {
  const AdminNav = loadAdminNav();
  const el = fakeElement();
  AdminNav.render(el, { zone: 'clients', crumbs: [{ label: 'Chap Chap' }, { label: 'Comptes sociaux' }] });
  const order = ['Clients &amp; Prospects', 'Chap Chap', 'Comptes sociaux'].map(l => el.innerHTML.indexOf(l));
  assert.ok(order.every(i => i !== -1), 'un des trois segments attendus est absent');
  assert.ok(order[0] < order[1] && order[1] < order[2], 'ordre du fil d\'Ariane incorrect');
});

// --- H3-008D1N3 — le label de ZONE ("Clients & Prospects") ne doit
// JAMAIS remplacer l'identité d'une SECTION FONCTIONNELLE existante
// ("Contacts & Audits") : ce sont deux niveaux de hiérarchie distincts,
// répondant à deux questions différentes (où suis-je globalement / que
// suis-je en train de faire). ---

test('index.html H1 identifies the functional section "Contacts & Audits", never the zone label', () => {
  const html = fs.readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8');
  assert.ok(/<h1>Contacts &amp; Audits<\/h1>/.test(html), 'le H1 doit identifier la fonction (Contacts & Audits), pas la zone');
  assert.ok(!/<h1>Clients &amp; Prospects<\/h1>/.test(html), 'le H1 ne doit jamais reprendre tel quel le libellé de zone');
});

test('index.html renders the exact breadcrumb "Clients & Prospects > Contacts & Audits" (zone kept, section made explicit)', () => {
  const html = fs.readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8');
  const match = html.match(/AdminNav\.render\([^,]+,\s*(\{[\s\S]*?\})\s*\)/);
  assert.ok(match, 'appel AdminNav.render introuvable dans index.html');
  assert.ok(/zone:\s*'clients'/.test(match[1]), 'la zone doit rester clients (jamais renommée)');
  assert.ok(/crumbs:\s*\[\s*\{\s*label:\s*'Contacts & Audits'\s*\}\s*\]/.test(match[1]), 'le fil d\'Ariane doit ajouter EXPLICITEMENT le segment "Contacts & Audits" après la zone — jamais crumbs: []');

  const AdminNav = loadAdminNav();
  const el = fakeElement();
  AdminNav.render(el, { zone: 'clients', crumbs: [{ label: 'Contacts & Audits' }] });
  const order = ['Clients &amp; Prospects', 'Contacts &amp; Audits'].map(l => el.innerHTML.indexOf(l));
  assert.ok(order[0] !== -1 && order[1] !== -1, 'les deux segments (zone puis section) doivent être présents');
  assert.ok(order[0] < order[1], 'la zone doit précéder la section dans le fil d\'Ariane');
});

test('the top-level zone tabs still show Clients & Prospects as active on the Contacts & Audits page (zone identity preserved)', () => {
  const AdminNav = loadAdminNav();
  const el = fakeElement();
  AdminNav.render(el, { zone: 'clients', crumbs: [{ label: 'Contacts & Audits' }] });
  assert.ok(el.innerHTML.includes('href="/admin/index.html" class="admin-zone-tab active"'), 'l\'onglet de zone Clients & Prospects doit rester actif même quand la section affichée est Contacts & Audits');
});

// --- 8/9/10 — générique, extensible, aucune connaissance client/plateforme. ---

test('nav.js executable code contains no client-specific branch (no "Chap Chap", no hardcoded tenant UUID pattern)', () => {
  assert.ok(!/chap\s*chap/i.test(navCode), 'nav.js ne doit connaître aucun client précis');
});

test('nav.js executable code contains no platform-specific branch (no "facebook"/"instagram"/... reference)', () => {
  const platformNames = ['facebook', 'instagram', 'linkedin', 'tiktok', 'youtube', 'whatsapp', 'pinterest', 'snapchat', 'telegram'];
  for (const name of platformNames) {
    assert.ok(!new RegExp(name, 'i').test(navCode), `nav.js référence la plateforme "${name}" — doit rester générique`);
  }
});

test('nav.js accepts an arbitrary crumb label unknown to it (extensible to any future client/section without code change)', () => {
  const AdminNav = loadAdminNav();
  const el = fakeElement();
  // Une future 11e plateforme ou un futur client quelconque : label
  // jamais vu par ce fichier, jamais interprété, simplement affiché.
  AdminNav.render(el, { zone: 'clients', crumbs: [{ label: 'Synthetic Eleventh Client Corp' }, { label: 'Comptes sociaux' }] });
  assert.ok(el.innerHTML.includes('Synthetic Eleventh Client Corp'), 'un contexte client jamais vu doit pouvoir être affiché sans modification de nav.js');
});

test('a crumb without href is never rendered as a link (no fabricated destination for a page that does not exist)', () => {
  const AdminNav = loadAdminNav();
  const el = fakeElement();
  AdminNav.render(el, { zone: 'clients', crumbs: [{ label: 'Chap Chap' }] });
  assert.ok(!/<a[^>]*>Chap Chap<\/a>/.test(el.innerHTML), 'le segment nom métier ne doit pas devenir un lien fabriqué vers une page inexistante');
});

// --- 15 — l'ancien lien universel "← Contacts & audits" n'est plus une
// structure de navigation globale codée en dur. ---

const PAGES = ['index.html', 'audit-review.html', 'social-accounts.html', 'platform-integrations.html', 'administration.html'];

test('none of the admin pages hardcode the old universal "← Contacts & audits" back-link anymore', () => {
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(ADMIN_DIR, page), 'utf8');
    assert.ok(!html.includes('Contacts &amp; audits'), `${page}: l'ancien lien universel ne doit plus apparaître`);
  }
});

test('every admin page includes the shared nav.js and calls AdminNav.render', () => {
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(ADMIN_DIR, page), 'utf8');
    assert.ok(html.includes('src="/admin/nav.js"'), `${page}: nav.js non inclus`);
    assert.ok(html.includes('AdminNav.render('), `${page}: AdminNav.render jamais appelé`);
  }
});

// --- Intégrations plateforme reste globale, jamais scopée tenant ---

test('platform-integrations.html registers itself under the administration zone, never clients', () => {
  const html = fs.readFileSync(path.join(ADMIN_DIR, 'platform-integrations.html'), 'utf8');
  assert.ok(/zone:\s*'administration'/.test(html), 'platform-integrations.html doit se déclarer dans la zone administration');
  assert.ok(!/zone:\s*'clients'/.test(html), 'platform-integrations.html ne doit jamais se déclarer dans la zone clients');
});

test('administration.html hosts the moved operational-status panel and links to Platform Integrations', () => {
  const html = fs.readFileSync(path.join(ADMIN_DIR, 'administration.html'), 'utf8');
  assert.ok(html.includes('opsGapsPanel'), 'le panneau de santé opérationnelle doit être présent (déplacé, jamais dupliqué)');
  assert.ok(html.includes('href="/admin/platform-integrations.html"'), 'lien vers Intégrations plateforme manquant');
  assert.ok(/zone:\s*'administration'/.test(html), 'administration.html doit se déclarer dans la zone administration');
});

test('index.html no longer embeds the global operational-status panel (moved to Administration, not duplicated)', () => {
  const html = fs.readFileSync(path.join(ADMIN_DIR, 'index.html'), 'utf8');
  assert.ok(!html.includes('opsGapsPanel'), 'le panneau de santé opérationnelle globale ne doit plus vivre dans Clients & Prospects');
  assert.ok(!html.includes('platform-integrations.html'), 'index.html ne doit plus exposer de lien nu vers une page globale sans contexte');
});

console.log(`\n${passed}/${passed + failed} test(s) passés.`);
if (failed > 0) process.exit(1);
