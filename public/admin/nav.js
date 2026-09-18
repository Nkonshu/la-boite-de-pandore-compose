// H3-008D1N1 — plus petite abstraction de navigation partagée entre les
// pages admin. Remplace les topbars/back-links codés indépendamment page
// par page (chacun réimplémentait "← Contacts & audits" en dur).
//
// Deux zones top-level FIXES (jamais dérivées d'un tenant/plateforme
// précis, jamais de `if Chap Chap`/`if facebook` ici) : "clients"
// (Clients & Prospects, opérations tenant) et "administration"
// (configuration globale Pandore). Une page appelle AdminNav.render une
// fois avec sa zone + les segments de contexte réels qu'elle connaît
// (ex. le nom métier déjà résolu) — ce fichier ne connaît lui-même AUCUN
// tenant, AUCUNE plateforme : il ne fait que composer une liste de
// libellés/liens qu'on lui donne.
(function () {
  'use strict';

  var ZONES = {
    clients: { label: 'Clients & Prospects', href: '/admin/index.html' },
    administration: { label: 'Administration', href: '/admin/administration.html' },
  };

  var STYLE_ID = 'admin-nav-style';

  function escHTML(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '.admin-nav { margin-bottom: 18px; }',
      '.admin-nav .admin-zone-tabs { display: flex; gap: 6px; margin-bottom: 8px; }',
      '.admin-nav .admin-zone-tab {',
      '  font-family: "IBM Plex Mono", monospace; font-size: 11.5px; letter-spacing: 0.04em;',
      '  text-transform: uppercase; padding: 5px 11px; border-radius: 999px; text-decoration: none;',
      '  color: var(--mute, #8B909A); border: 1px solid var(--border, #262B33); background: transparent;',
      '}',
      '.admin-nav .admin-zone-tab.active {',
      '  color: var(--bg, #0B0D10); background: var(--accent, #E8A33D); border-color: var(--accent, #E8A33D); font-weight: 700;',
      '}',
      '.admin-nav .admin-breadcrumb { font-size: 13px; color: var(--mute-dim, #5B616B); display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }',
      '.admin-nav .admin-crumb { color: var(--mute-dim, #5B616B); text-decoration: none; }',
      '.admin-nav .admin-crumb[href] { color: var(--accent, #E8A33D); }',
      '.admin-nav .admin-crumb.current { color: var(--text, #F3F1EC); font-weight: 600; }',
      '.admin-nav .admin-crumb-sep { color: var(--border, #262B33); }',
    ].join('\n');
    document.head.appendChild(style);
  }

  // render — opts.zone: 'clients' | 'administration' (requis).
  // opts.crumbs: segments SUPPLEMENTAIRES après la zone elle-même, dans
  // l'ordre d'affichage (ex. [{label: businessName}, {label: 'Comptes
  // sociaux'}]). Un segment sans `href` n'est jamais un lien (page
  // courante, ou contexte pour lequel aucune destination distincte
  // n'existe encore) — jamais un lien fabriqué vers une page qui
  // n'existe pas.
  function render(containerEl, opts) {
    if (!containerEl || !opts || !ZONES[opts.zone]) return;
    ensureStyle();
    var zone = ZONES[opts.zone];
    var crumbs = [{ label: zone.label, href: zone.href }].concat(opts.crumbs || []);

    var tabsHTML = Object.keys(ZONES).map(function (key) {
      var z = ZONES[key];
      var active = key === opts.zone;
      return '<a href="' + z.href + '" class="admin-zone-tab' + (active ? ' active' : '') + '">' + escHTML(z.label) + '</a>';
    }).join('');

    var crumbHTML = crumbs.map(function (c, i) {
      var isLast = i === crumbs.length - 1;
      if (isLast || !c.href) {
        return '<span class="admin-crumb current">' + escHTML(c.label) + '</span>';
      }
      return '<a class="admin-crumb" href="' + c.href + '">' + escHTML(c.label) + '</a>';
    }).join('<span class="admin-crumb-sep">&rsaquo;</span>');

    containerEl.className = (containerEl.className ? containerEl.className + ' ' : '') + 'admin-nav';
    containerEl.innerHTML =
      '<div class="admin-zone-tabs">' + tabsHTML + '</div>' +
      '<div class="admin-breadcrumb">' + crumbHTML + '</div>';
  }

  window.AdminNav = { render: render, ZONES: ZONES };
})();
