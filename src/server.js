const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
// trust proxy = 1 : Traefik (coolify-proxy) est le seul reverse proxy en
// amont (même réseau Docker) — un seul hop de confiance, ni plus (un XFF
// forgé plus loin dans la chaîne ne doit jamais être cru) ni moins (sinon
// req.ip renvoie l'IP interne de Traefik, pas celle du vrai client — voir
// tranche F, correctif rate limiting).
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const RELEASES_DIR = path.join(__dirname, '..', 'releases');
const TMP_DIR = path.join(__dirname, '..', 'tmp');
fs.mkdirSync(RELEASES_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
app.use('/releases', express.static(RELEASES_DIR));

// Résout avec stderr (ffmpeg y écrit sa progression même en cas de succès ; utile pour
// le message d'erreur en cas d'échec).
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

// Résout avec stdout — pour les commandes dont la vraie valeur de retour (ex. ffprobe
// -of csv) est imprimée sur la sortie standard, pas sur stderr.
function runCapture(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

async function downloadTo(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Téléchargement échoué (${res.status}) : ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(destPath, buf);
}

function srtTime(sec) {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const msRem = ms % 1000;
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(msRem, 3)}`;
}

// captions: [{ text, start, end }] (secondes) OU [{ text }] / ["texte"] sans timing —
// dans ce cas la durée réelle de l'audio (mesurée par ffprobe) est répartie au prorata
// du nombre de caractères de chaque segment, plus fiable qu'une estimation de débit de
// parole calculée en amont dans n8n avant même que la voix off n'existe.
function withTiming(captions, totalDurationSec) {
  if (captions.every((c) => typeof c === 'object' && typeof c.start === 'number' && typeof c.end === 'number')) {
    return captions;
  }
  const texts = captions.map((c) => (typeof c === 'string' ? c : c.text));
  const totalChars = texts.reduce((sum, t) => sum + t.length, 0) || 1;
  let cursor = 0;
  return texts.map((text) => {
    const share = (text.length / totalChars) * totalDurationSec;
    const start = cursor;
    const end = Math.min(totalDurationSec, cursor + share);
    cursor = end;
    return { text, start, end };
  });
}

function buildSrt(captions) {
  return captions.map((c, i) =>
    `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`
  ).join('\n');
}

// Échappe les caractères que le filtre ffmpeg `subtitles=` interprète dans un chemin
// (les deux-points du lecteur Windows n'existent pas ici, mais les apostrophes dans les
// noms de fichiers temporaires génériques suffisent à casser le filtre sans cet échappement).
function escapeForFilter(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

app.post('/compose', async (req, res) => {
  const { audioUrl, videoUrl, captions, filename } = req.body || {};
  if (!audioUrl || !videoUrl || !Array.isArray(captions) || captions.length === 0) {
    return res.status(400).json({ error: 'audioUrl, videoUrl et captions (tableau non vide) sont requis' });
  }

  const jobId = crypto.randomUUID();
  const jobDir = path.join(TMP_DIR, jobId);
  await fsp.mkdir(jobDir, { recursive: true });

  const audioPath = path.join(jobDir, 'audio.mp3');
  const videoPath = path.join(jobDir, 'video.mp4');
  const srtPath = path.join(jobDir, 'captions.srt');
  const outName = (filename && /^[a-z0-9-]+$/i.test(filename)) ? `${filename}.mp4` : `pandore-${jobId}.mp4`;
  const outPath = path.join(RELEASES_DIR, outName);

  try {
    await Promise.all([
      downloadTo(audioUrl, audioPath),
      downloadTo(videoUrl, videoPath),
    ]);

    const durationOut = await runCapture('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioPath,
    ]);
    const durationSec = parseFloat(durationOut);
    if (!durationSec) throw new Error(`Impossible de déterminer la durée audio (ffprobe a renvoyé : "${durationOut.trim()}")`);

    const timedCaptions = withTiming(captions, durationSec);
    await fsp.writeFile(srtPath, buildSrt(timedCaptions), 'utf8');

    const subtitlesFilter = `subtitles=${escapeForFilter(srtPath)}:force_style='FontName=DejaVu Sans,FontSize=22,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=2,Shadow=0,Alignment=2,MarginV=190'`;

    await run('ffmpeg', [
      '-y',
      '-stream_loop', '-1', '-i', videoPath,
      '-i', audioPath,
      '-filter_complex',
      `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,${subtitlesFilter}[v]`,
      '-map', '[v]', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
      '-c:a', 'aac', '-b:a', '192k',
      '-t', String(durationSec),
      outPath,
    ]);

    res.json({ url: `/releases/${outName}`, durationSec });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
});

const N8N_BASE = process.env.N8N_BASE || 'https://n8n.le-shabba.fr';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
// INTERNAL_SECRET protège les webhooks n8n eux-mêmes (secret propre à n8n,
// jamais celui de pandore-api — les deux sont distincts malgré le nom de
// variable historique). GO_INTERNAL_SECRET protège /admin/* côté Go : ne
// jamais fusionner les deux, un bug réel de cette bascule (étape 8) est
// parti d'une confusion entre ces deux secrets.
const INTERNAL_SECRET = process.env.PANDORE_INTERNAL_SECRET;
const GO_INTERNAL_SECRET = process.env.PANDORE_GO_INTERNAL_SECRET;

// PANDORE_API_BASE — adresse interne de pandore-api (Go), atteinte via la
// gateway du réseau Docker Coolify (le process tourne sur l'hôte, hors
// Docker — voir scripts/deploy/deploy.sh du repo pandore), jamais exposée
// publiquement.
const PANDORE_API_BASE = process.env.PANDORE_API_BASE || 'http://10.0.1.1:4000';
// AUDIT_BACKEND — bascule étape 8 (docs/05_CLIENT_LIFECYCLE.md, repo
// pandore) : 'go' (Go, par défaut) ou 'n8n' (rollback immédiat sans
// redéploiement, juste une variable d'env Coolify à changer). À retirer
// une fois le rollback n8n plus nécessaire.
const AUDIT_BACKEND = process.env.AUDIT_BACKEND || 'go';

// F0.2 — pont d'identité humaine (remplace le compte de service F0,
// rejeté en revue : un service account substituait l'identité de
// n'importe quel humain cliquant "Approuver", cassant l'auditabilité
// exigée par la tranche C). Compose ne crée ni ne détient plus aucune
// session Go lui-même — il relaie tel quel le Bearer que le navigateur
// obtient en se connectant comme un vrai Pandore User (POST /auth/login,
// déjà existant, aucune Auth V2). ADMIN_PASSWORD reste la porte d'accès à
// l'UI legacy (inchangée) ; le Bearer Pandore est la seule source
// d'autorisation pour approveAudit — coexistence transitoire assumée
// (voir docs/11_SECURITY.md, repo pandore).

async function n8nWebhook(pathAndQuery, opts = {}) {
  const res = await fetch(`${N8N_BASE}/webhook/${pathAndQuery}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

function checkAdmin(req, res) {
  const pw = req.get('x-admin-password');
  if (!ADMIN_PASSWORD || pw !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Non autorisé' });
    return false;
  }
  return true;
}

app.post('/api/contact', async (req, res) => {
  const { name, email, message } = req.body || {};
  if (!name || !email || !message) return res.status(400).json({ error: 'name, email et message sont requis' });
  try {
    const { status, data } = await n8nWebhook('pandore-contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, message }),
    });
    res.status(status).json(data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Envoi impossible pour le moment' });
  }
});

app.post('/api/audit', async (req, res) => {
  const { name, email, answers, synthesis } = req.body || {};
  if (!name || !email || !answers) return res.status(400).json({ error: 'name, email et answers sont requis' });
  try {
    if (AUDIT_BACKEND === 'n8n') {
      const { status, data } = await n8nWebhook('pandore-audit-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, answers, synthesis }),
      });
      return res.status(status).json(data);
    }
    // Idempotency-Key : transmise telle quelle depuis le client (une seule
    // par tentative de soumission, voir public/audit/index.html) — c'est
    // elle qui doit faire autorité (technical/API.md, "clé générée côté
    // client"). Un hash du contenu ne sert qu'en repli défensif si jamais
    // absente, jamais comme mécanisme principal (un hash seul ne distingue
    // pas deux soumissions légitimes aux réponses identiques).
    const idempotencyKey = req.get('Idempotency-Key')
      || crypto.createHash('sha256').update(JSON.stringify({ email, answers })).digest('hex');
    const goRes = await fetch(`${PANDORE_API_BASE}/public/audits`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        // X-Pandore-Client-IP : pandore-api n'étant jamais exposé
        // publiquement, tout appel qui l'atteint vient nécessairement de ce
        // process compose — la frontière réseau (Traefik -> compose -> Go
        // interne uniquement) est elle-même la garantie de confiance, pas
        // un allowlisting d'IP supplémentaire (tranche F, correctif rate
        // limiting : deux visiteurs distincts derrière ce même compose ne
        // doivent plus partager un seul bucket).
        'X-Pandore-Client-IP': req.ip,
      },
      body: JSON.stringify({ audit_schema_version: 'v1', raw_answers: answers }),
    });
    const data = await goRes.json();
    res.status(goRes.status).json(data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Envoi impossible pour le moment' });
  }
});

app.get('/api/audit/:id', async (req, res) => {
  try {
    if (AUDIT_BACKEND === 'n8n') {
      const { status, data } = await n8nWebhook(`pandore-audit-result?id=${encodeURIComponent(req.params.id)}`, { method: 'GET' });
      return res.status(status).json(data);
    }
    // GET /public/audits/{token} (pandore, étape 8) : DTO dédié, jamais le
    // même contrat que l'ancien webhook n8n — traduit ici vers la forme
    // attendue par public/audit/result/index.html plutôt que de modifier
    // cette page.
    const goRes = await fetch(`${PANDORE_API_BASE}/public/audits/${encodeURIComponent(req.params.id)}`);
    if (goRes.status === 404) return res.status(404).json({ error: 'not_found' });
    if (!goRes.ok) throw new Error(`go_status_${goRes.status}`);
    const data = await goRes.json();
    res.json({
      name: data.name,
      email: data.email,
      status: data.status,
      createdAt: data.submitted_at,
      synthesis: `## Réponses de l'audit\n${data.summary}`,
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Lecture impossible pour le moment' });
  }
});

app.get('/api/admin/contacts', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const { status, data } = await n8nWebhook('pandore-admin-contacts', {
      method: 'GET',
      headers: { 'x-internal-secret': INTERNAL_SECRET },
    });
    res.status(status).json(data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Lecture impossible' });
  }
});

// toAdminAuditView traduit un core.AuditSubmission (Go, champs PascalCase —
// ce type n'a pas de tags JSON, contrairement aux DTO dédiés) vers la forme
// attendue par public/admin/index.html. audit_id porte le
// PublicAccessToken, jamais l'ID interne (même règle que partout ailleurs
// dans cette bascule) — la page de résultat le résout via
// GET /public/audits/{token}.
function toAdminAuditView(submission) {
  const answers = submission.RawAnswers || {};
  return {
    id: submission.ID,
    createdAt: submission.SubmittedAt,
    name: answers.a0 || '',
    email: answers.a0b || '',
    status: submission.Status,
    audit_id: submission.PublicAccessToken || submission.ID,
    source: 'go',
  };
}

app.get('/api/admin/audits', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    // Fusion de deux sources tant que n8n reste le stockage historique
    // (audiences soumises avant la bascule étape 8) et Go la nouvelle
    // (docs/05_CLIENT_LIFECYCLE.md) — jamais l'une remplaçant l'autre en
    // silence, sous peine de faire disparaître des audits déjà reçus.
    const [n8nResult, goResult] = await Promise.all([
      n8nWebhook('pandore-admin-audits', { method: 'GET', headers: { 'x-internal-secret': INTERNAL_SECRET } })
        .catch(err => { console.error('admin audits (n8n):', err); return { status: 200, data: [] }; }),
      fetch(`${PANDORE_API_BASE}/admin/audits`, { headers: { 'x-internal-secret': GO_INTERNAL_SECRET } })
        .then(async r => ({ status: r.status, data: await r.json() }))
        .catch(err => { console.error('admin audits (go):', err); return { status: 200, data: [] }; }),
    ]);
    const n8nAudits = Array.isArray(n8nResult.data) ? n8nResult.data : [];
    const goAudits = Array.isArray(goResult.data) ? goResult.data.map(toAdminAuditView) : [];
    res.json([...n8nAudits, ...goAudits]);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Lecture impossible' });
  }
});

// toAdminAuditDetailView traduit {submission, draft} (Go, champs
// PascalCase pour les deux types sans tags JSON propres — Proposition/
// Feasibility/DataQualityFlags sont déjà en snake_case, définis avec leurs
// propres tags) vers une forme homogène pour l'écran de revue.
function toAdminAuditDetailView(data) {
  const s = data.submission || {};
  const d = data.draft || null;
  return {
    id: s.ID,
    name: (s.RawAnswers || {}).a0 || '',
    email: (s.RawAnswers || {}).a0b || '',
    status: s.Status,
    submitted_at: s.SubmittedAt,
    raw_answers: s.RawAnswers || {},
    draft: d ? {
      id: d.ID,
      status: d.Status,
      identity: d.Identity,
      audience: d.Audience,
      objectives: d.Objectives || [],
      platforms: d.Platforms || [],
      constraints: d.Constraints || [],
      forbidden_topics: d.ForbiddenTopics || [],
      proposition: d.Proposition || null,
      data_quality_flags: d.DataQualityFlags || [],
      feasibility: d.Feasibility || null,
      analysis_version: d.AnalysisVersion,
      feasibility_model_version: d.FeasibilityModelVersion,
      ai_model: d.AIModel,
      created_at: d.CreatedAt,
      approved_at: d.ApprovedAt,
      approved_by: d.ApprovedBy,
      tenant_id: d.TenantID,
    } : null,
  };
}

app.get('/api/admin/audits/:id', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/admin/audits/${encodeURIComponent(req.params.id)}`, {
      headers: { 'x-internal-secret': GO_INTERNAL_SECRET },
    });
    if (goRes.status === 404) return res.status(404).json({ error: 'not_found' });
    if (!goRes.ok) throw new Error(`go_status_${goRes.status}`);
    const data = await goRes.json();
    res.json(toAdminAuditDetailView(data));
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Lecture impossible' });
  }
});

// approve/reject/reprocess — jamais déclenchés automatiquement : chaque
// appel correspond à un clic explicite de l'admin sur l'écran de revue
// (audit-review.html), pas à une action système.
// F0 : approved_by n'est plus envoyé — Go l'ignore depuis la tranche C
// (il dérive systématiquement l'identité de la session), le renvoyer
// laisserait croire à tort qu'il compte encore.
// F0.2 : la vraie autorisation vient exclusivement du Bearer Pandore
// relayé tel quel — ADMIN_PASSWORD (checkAdmin) reste une porte d'accès à
// l'UI legacy, jamais suffisante seule pour approuver (docs métier F0.2
// §6/§10). Aucune identité de substitution : le header Authorization
// reçu du navigateur est transmis sans modification, jamais recréé ni
// remplacé par une session compose.
app.post('/api/admin/audits/:id/approve', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const authorization = req.get('Authorization');
  if (!authorization) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'session Pandore requise pour approuver' } });
  }
  const { tenant_id, tenant_name } = req.body || {};
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/admin/audits/${encodeURIComponent(req.params.id)}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify({ tenant_id: tenant_id || '', tenant_name: tenant_name || '' }),
    });
    const data = await goRes.json();
    res.status(goRes.status).json(data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Approbation impossible' });
  }
});

// F0.2 — proxy minimal vers l'auth Pandore existante (aucune Auth V2).
// pandore-api n'est jamais exposé directement (docs infra) ; ADMIN_PASSWORD
// reste la porte d'entrée à l'UI legacy avant même de pouvoir tenter un
// login Pandore. Ni le mot de passe ni le Bearer ne sont jamais logués.
app.post('/api/auth/login', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email et password requis' });
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await goRes.json();
    res.status(goRes.status).json(data);
  } catch (err) {
    console.error('auth login proxy:', err.message);
    res.status(502).json({ error: 'Connexion impossible' });
  }
});

// Tranche F — proxies publics minimaux vers /public/contacts et
// /public/plans (Go). Aucun secret ici : la preuve est le jeton opaque
// lui-même, la cible est toujours résolue serveur-side côté Go (jamais un
// tenant_id/contact_id/plan_id fourni par le navigateur, voir verify-contact.html
// et plan-decision.html). Pas de checkAdmin : ces routes sont publiques par
// nature, comme /api/audit.
app.get('/api/public/contacts/:token/verify', async (req, res) => {
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/public/contacts/${encodeURIComponent(req.params.token)}/verify`);
    const data = await goRes.json().catch(() => ({}));
    res.status(goRes.status).json(data);
  } catch (err) {
    console.error('public contact verify proxy:', err.message);
    res.status(502).json({ error: 'Vérification impossible pour le moment' });
  }
});

app.get('/api/public/plans/:token', async (req, res) => {
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/public/plans/${encodeURIComponent(req.params.token)}`);
    const data = await goRes.json().catch(() => ({}));
    res.status(goRes.status).json(data);
  } catch (err) {
    console.error('public plan proxy:', err.message);
    res.status(502).json({ error: 'Lecture impossible pour le moment' });
  }
});

app.post('/api/public/plans/:token/decision', async (req, res) => {
  const { decision, comment } = req.body || {};
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/public/plans/${encodeURIComponent(req.params.token)}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, comment: comment || '' }),
    });
    const data = await goRes.json().catch(() => ({}));
    res.status(goRes.status).json(data);
  } catch (err) {
    console.error('public plan decision proxy:', err.message);
    res.status(502).json({ error: 'Enregistrement impossible pour le moment' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const authorization = req.get('Authorization');
  if (!authorization) return res.json({ status: 'ok' });
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: authorization },
    });
    const data = await goRes.json().catch(() => ({}));
    res.status(goRes.status).json(data);
  } catch (err) {
    console.error('auth logout proxy:', err.message);
    res.status(502).json({ error: 'Déconnexion impossible' });
  }
});

app.post('/api/admin/audits/:id/reject', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/admin/audits/${encodeURIComponent(req.params.id)}/reject`, {
      method: 'POST',
      headers: { 'x-internal-secret': GO_INTERNAL_SECRET },
    });
    const data = await goRes.json();
    res.status(goRes.status).json(data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Rejet impossible' });
  }
});

app.post('/api/admin/audits/:id/reprocess', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/admin/audits/${encodeURIComponent(req.params.id)}/reprocess`, {
      method: 'POST',
      headers: { 'x-internal-secret': GO_INTERNAL_SECRET },
    });
    const data = await goRes.json();
    res.status(goRes.status).json(data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Relance impossible' });
  }
});

app.post('/api/admin/status', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { table, id, status: newStatus } = req.body || {};
  if (!table || !id || !newStatus) return res.status(400).json({ error: 'table, id, status requis' });
  const webhookPath = table === 'contacts' ? 'pandore-admin-status-contact'
    : table === 'audits' ? 'pandore-admin-status-audit'
    : null;
  if (!webhookPath) return res.status(400).json({ error: 'table invalide' });
  try {
    const { status, data } = await n8nWebhook(webhookPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify({ id, status: newStatus }),
    });
    res.status(status).json(data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Mise à jour impossible' });
  }
});

// --- Platform Engine V1 — connexion de comptes Meta (docs/08_PLATFORM_ENGINE.md,
// repo pandore) : Go reste le seul détenteur du secret Meta et de la
// logique d'échange (voir internal/platform/meta, internal/httpapi/admin_platform.go)
// — compose ne fait que déclencher la redirection OAuth et relayer le
// `code` reçu, jamais un appel Graph API direct.

const META_APP_ID = process.env.META_APP_ID;
const META_REDIRECT_URI = process.env.META_REDIRECT_URI;
const META_OAUTH_SCOPES = ['pages_show_list', 'pages_read_engagement', 'instagram_basic'].join(',');

// metaOAuthStates — liaison CSRF state -> tenant_id pour la danse OAuth en
// cours. En mémoire seulement (process unique, pas de cluster ici) : rien
// de sensible n'y est stocké, juste quel admin a initié quelle connexion,
// avec un TTL court (la danse OAuth se termine en quelques minutes ou pas
// du tout).
const metaOAuthStates = new Map();
const META_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function pruneMetaOAuthStates() {
  const now = Date.now();
  for (const [state, entry] of metaOAuthStates) {
    if (entry.expiresAt < now) metaOAuthStates.delete(state);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function oauthResultPage(success, message, connectedNames = [], tenantId = '') {
  const title = success ? 'Connexion réussie' : 'Connexion échouée';
  const body = success
    ? `<p>Compte(s) connecté(s) :</p><ul>${connectedNames.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
    : `<p>${escapeHtml(message || 'Erreur inconnue.')}</p>`;
  const backHref = tenantId ? `/admin/social-accounts.html?tenant_id=${encodeURIComponent(tenantId)}` : '/admin/social-accounts.html';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}
h1{font-size:1.25rem}a{color:#2563eb}</style></head>
<body><h1>${title}</h1>${body}<p><a href="${backHref}">Retour à l'admin</a></p></body></html>`;
}

// GET /api/admin/social-accounts/meta/authorize-url — appelé en fetch (avec
// x-admin-password) depuis social-accounts.html, qui navigue ensuite le
// navigateur vers l'URL renvoyée. Une redirection directe depuis un
// handler admin-protégé ne fonctionnerait pas : la navigation qui suit ne
// porte aucun header custom.
app.get('/api/admin/social-accounts/meta/authorize-url', (req, res) => {
  if (!checkAdmin(req, res)) return;
  if (!META_APP_ID || !META_REDIRECT_URI) {
    return res.status(503).json({ error: 'Intégration Meta non configurée côté compose (META_APP_ID/META_REDIRECT_URI)' });
  }
  const tenantId = req.query.tenant_id;
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requis' });

  pruneMetaOAuthStates();
  const state = crypto.randomUUID();
  metaOAuthStates.set(state, {
    tenantId,
    connectedBy: req.query.connected_by || '',
    expiresAt: Date.now() + META_OAUTH_STATE_TTL_MS,
  });

  const params = new URLSearchParams({
    client_id: META_APP_ID,
    redirect_uri: META_REDIRECT_URI,
    state,
    scope: META_OAUTH_SCOPES,
    response_type: 'code',
  });
  res.json({ url: `https://www.facebook.com/v21.0/dialog/oauth?${params}` });
});

// GET /oauth/meta/callback — cible réelle de META_REDIRECT_URI, atteinte
// par une redirection navigateur depuis Meta (jamais par fetch) : pas de
// x-admin-password possible sur cette requête. La preuve d'autorisation
// est le `code` OAuth lui-même (usage unique, expire vite, lié à cette app
// + ce redirect_uri) combiné au `state` vérifié contre metaOAuthStates —
// pas un mot de passe admin.
app.get('/oauth/meta/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  res.set('Content-Type', 'text/html; charset=utf-8');

  if (error) {
    return res.status(400).send(oauthResultPage(false, errorDescription || error));
  }

  pruneMetaOAuthStates();
  const pending = state && metaOAuthStates.get(state);
  if (!pending) {
    return res.status(400).send(oauthResultPage(false, "Session de connexion expirée ou invalide — recommencez depuis l'admin."));
  }
  metaOAuthStates.delete(state);

  if (!code) {
    return res.status(400).send(oauthResultPage(false, "Code d'autorisation manquant."));
  }

  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/admin/social-accounts/oauth-callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': GO_INTERNAL_SECRET },
      body: JSON.stringify({ tenant_id: pending.tenantId, code, connected_by: pending.connectedBy }),
    });
    const data = await goRes.json();
    if (!goRes.ok) {
      const message = (data && data.error && data.error.message) || `Échec côté serveur (${goRes.status})`;
      return res.status(goRes.status).send(oauthResultPage(false, message, [], pending.tenantId));
    }
    const names = Array.isArray(data) ? data.map((a) => `${a.Platform} · ${a.DisplayName}`) : [];
    return res.send(oauthResultPage(true, null, names, pending.tenantId));
  } catch (err) {
    console.error('oauth meta callback:', err);
    return res.status(502).send(oauthResultPage(false, 'Le serveur Pandore est injoignable pour le moment.', [], pending.tenantId));
  }
});

// toAdminSocialAccountView traduit un core.SocialAccount (Go, PascalCase,
// pas de tags JSON) vers le snake_case attendu par social-accounts.html —
// même règle que toAdminAuditView plus haut.
function toAdminSocialAccountView(a) {
  return {
    id: a.ID,
    tenant_id: a.TenantID,
    platform: a.Platform,
    external_account_id: a.ExternalAccountID,
    display_name: a.DisplayName,
    granted_scopes: a.GrantedScopes || [],
    status: a.Status,
    token_expires_at: a.TokenExpiresAt,
    connected_at: a.ConnectedAt,
    connected_by: a.ConnectedBy,
    revoked_at: a.RevokedAt,
  };
}

app.get('/api/admin/social-accounts', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const tenantId = req.query.tenant_id;
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requis' });
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/admin/social-accounts?tenant_id=${encodeURIComponent(tenantId)}`, {
      headers: { 'x-internal-secret': GO_INTERNAL_SECRET },
    });
    const data = await goRes.json();
    if (!goRes.ok) return res.status(goRes.status).json(data);
    res.json(Array.isArray(data) ? data.map(toAdminSocialAccountView) : []);
  } catch (err) {
    console.error('admin social-accounts (list):', err);
    res.status(502).json({ error: 'Lecture impossible' });
  }
});

app.post('/api/admin/social-accounts/:id/revoke', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/admin/social-accounts/${encodeURIComponent(req.params.id)}/revoke`, {
      method: 'POST',
      headers: { 'x-internal-secret': GO_INTERNAL_SECRET },
    });
    const data = await goRes.json();
    if (!goRes.ok) return res.status(goRes.status).json(data);
    res.json(toAdminSocialAccountView(data));
  } catch (err) {
    console.error('admin social-accounts (revoke):', err);
    res.status(502).json({ error: 'Révocation impossible' });
  }
});

// GET /api/admin/platform-status — proxy vers GET /admin/status (Go) :
// état de préparation opérationnelle (Meta configuré ou non, clé de
// chiffrement présente ou non), affiché en bandeau dans le dashboard admin
// (public/admin/index.html) pour un suivi visible plutôt qu'à retrouver
// dans les logs du VPS.
app.get('/api/admin/platform-status', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/admin/status`, {
      headers: { 'x-internal-secret': GO_INTERNAL_SECRET },
    });
    const data = await goRes.json();
    if (!goRes.ok) return res.status(goRes.status).json(data);
    res.json(data);
  } catch (err) {
    console.error('admin platform-status:', err);
    res.status(502).json({ error: 'Lecture impossible' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3400;
app.listen(PORT, () => console.log(`compose service listening on ${PORT}`));
