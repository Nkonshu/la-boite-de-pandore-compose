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

// S5.2-C1 — proxy public minimal vers /public/clarifications (Go), même
// patron que /api/public/plans ci-dessus : jamais de secret, la cible est
// résolue serveur-side par Go depuis le seul jeton opaque. Le jeton n'est
// jamais journalisé (pas de console.error incluant req.params.token).
app.get('/api/public/clarifications/:token', async (req, res) => {
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/public/clarifications/${encodeURIComponent(req.params.token)}`);
    const data = await goRes.json().catch(() => ({}));
    res.status(goRes.status).json(data);
  } catch (err) {
    console.error('public clarification proxy:', err.message);
    res.status(502).json({ error: 'Lecture impossible pour le moment' });
  }
});

app.post('/api/public/clarifications/:token/response', async (req, res) => {
  const { answers } = req.body || {};
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/public/clarifications/${encodeURIComponent(req.params.token)}/response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: answers || [] }),
    });
    const data = await goRes.json().catch(() => ({}));
    res.status(goRes.status).json(data);
  } catch (err) {
    console.error('public clarification response proxy:', err.message);
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

// --- H3-008D1J — Generic Platform Connection relay. Remplace l'ancien bloc
// Meta-spécifique (état OAuth en mémoire, META_APP_ID/META_REDIRECT_URI,
// authorize-url/callback dédiés Meta) : compose n'est plus qu'une frontière
// publique GÉNÉRIQUE — aucune sémantique de plateforme, aucun secret Meta,
// aucun état OAuth propre. Pandore (Go) reste seul détenteur de
// PlatformIntegrationConfiguration, de PlatformConnectionSession (l'état
// OAuth durable, jamais recréé ici), de l'échange de token et de la
// création de SocialAccount — voir internal/platformconnection et
// internal/platform/facebook (repo pandore, H3-008D1I).
//
// Identité : le Bearer Pandore obtenu par le navigateur via
// POST /api/auth/login (F0.2, déjà établi ci-dessus pour l'approbation
// d'audit) est relayé TEL QUEL vers les routes tenant-scopées — jamais un
// compte de service compose (explicitement rejeté en revue pour
// approveAudit, même raison ici : substituer l'identité de l'admin casse
// l'auditabilité — voir le commentaire F0.2 plus haut dans ce fichier).
// ADMIN_PASSWORD (checkAdmin) reste la porte d'accès à l'UI legacy, jamais
// suffisante seule pour initier/finaliser une connexion.

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// platformCallbackResultPage — générique : ne connaît QUE ce que la réponse
// Pandore contient déjà (session_ref/platform_id/status), jamais une
// sémantique de plateforme. Si un tenant_id/session/platform a été stashé
// côté navigateur (sessionStorage, posé par social-accounts.html AVANT la
// redirection vers la plateforme externe — seul moyen de le faire survivre
// à un aller-retour vers un domaine tiers), un petit script inline propose
// un lien direct vers l'étape de sélection de ressource ; sinon un lien
// générique vers le dashboard suffit. Jamais de token, jamais de secret,
// jamais le `state` brut dans le corps de la page.
function platformCallbackResultPage(success, message, session) {
  const title = success ? 'Connexion en cours' : 'Connexion échouée';
  const body = success
    ? `<p>Autorisation reçue (session <code>${escapeHtml(session && session.session_ref || '')}</code>, statut <code>${escapeHtml(session && session.status || '')}</code>).</p>
       <p id="resourceLinkFallback">Retournez à l'admin pour choisir la ressource à connecter.</p>`
    : `<p>${escapeHtml(message || 'Erreur inconnue.')}</p>`;
  const sessionRef = success && session ? session.session_ref : '';
  const platformId = success && session ? session.platform_id : '';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}
h1{font-size:1.25rem}a{color:#2563eb}</style></head>
<body><h1>${title}</h1>${body}<p><a id="backLink" href="/admin/social-accounts.html">Retour à l'admin</a></p>
<script>
// Générique : lit uniquement ce que CE navigateur a lui-même posé avant de
// partir vers la plateforme externe (jamais interprété/validé ici — un
// stash absent ou incohérent retombe simplement sur le lien générique
// ci-dessus, jamais une erreur).
(function(){
  try {
    var raw = sessionStorage.getItem('pandore_pending_connection');
    if (!raw) return;
    var pending = JSON.parse(raw);
    var sessionRef = ${JSON.stringify(sessionRef)};
    if (!pending || !pending.tenantId || !pending.platform || pending.sessionRef !== sessionRef) return;
    var href = '/admin/social-accounts.html?tenant_id=' + encodeURIComponent(pending.tenantId)
      + '&platform=' + encodeURIComponent(pending.platform)
      + '&session=' + encodeURIComponent(sessionRef);
    document.getElementById('backLink').href = href;
    var fallback = document.getElementById('resourceLinkFallback');
    if (fallback) fallback.innerHTML = 'Autorisation reçue — <a href="' + href + '">choisir la ressource à connecter</a>.';
    sessionStorage.removeItem('pandore_pending_connection');
  } catch (e) { /* stash absent/corrompu : le lien générique suffit */ }
})();
</script>
</body></html>`;
}

function requirePandoreBearer(req, res) {
  const authorization = req.get('Authorization');
  if (!authorization) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'session Pandore requise' } });
    return null;
  }
  return authorization;
}

// GET /api/admin/tenants/:id/platform-connections/available — catalogue
// générique (Registry Pandore), jamais un nom de plateforme codé en dur
// ici.
app.get('/api/admin/tenants/:id/platform-connections/available', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const authorization = requirePandoreBearer(req, res);
  if (!authorization) return;
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/admin/tenants/${encodeURIComponent(req.params.id)}/platform-connections/available`, {
      headers: { Authorization: authorization },
    });
    const data = await goRes.json().catch(() => ({}));
    res.status(goRes.status).json(data);
  } catch (err) {
    console.error('platform-connections available proxy:', err.message);
    res.status(502).json({ error: 'Lecture impossible pour le moment' });
  }
});

// POST /api/admin/tenants/:id/platform-connections/:platform/connect —
// :platform est un segment d'URL OPAQUE pour compose (jamais interprété,
// jamais validé ici : Pandore seul décide si la plateforme existe/supporte
// la connexion — §6 du mandat H3-008D1J, "the platform identifier is
// opaque to Compose"). Ne construit AUCUNE URL d'autorisation ici — le
// payload (incl. authorization_url) est celui, tel quel, renvoyé par
// Pandore.
app.post('/api/admin/tenants/:id/platform-connections/:platform/connect', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const authorization = requirePandoreBearer(req, res);
  if (!authorization) return;
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/admin/tenants/${encodeURIComponent(req.params.id)}/platform-connections/${encodeURIComponent(req.params.platform)}/connect`, {
      method: 'POST',
      headers: { Authorization: authorization },
    });
    const data = await goRes.json().catch(() => ({}));
    res.status(goRes.status).json(data);
  } catch (err) {
    console.error('platform-connections connect proxy:', err.message);
    res.status(502).json({ error: 'Connexion impossible pour le moment' });
  }
});

// GET/POST /oauth/platforms/:platform/callback — cible réelle de la
// redirection depuis la plateforme externe (PANDORE_PUBLIC_BASE_URL +
// ce chemin, voir internal/platform/facebook du repo pandore). PUBLIQUE
// (aucun x-admin-password possible : c'est une navigation navigateur
// depuis un tiers, jamais un fetch authentifié) — relais THIN GÉNÉRIQUE
// uniquement : transmet la query string reçue telle quelle à Pandore, ne
// lit/interprète/valide JAMAIS `code`/`state`/`error` lui-même (§3/§4 du
// mandat : "must not interpret Meta semantics... generate/consume state").
// La SEULE autorité de validation (state inconnu/expiré/déjà consommé,
// plateforme incohérente) est la réponse HTTP de Pandore, relayée telle
// quelle (statut + corps traduits en page de résultat sûre, jamais un
// secret transmis).
async function relayPlatformCallback(req, res) {
  const platform = req.params.platform;
  const query = req.method === 'GET' ? req.query : { ...req.query, ...(req.body || {}) };
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]))
  ).toString();
  res.set('Content-Type', 'text/html; charset=utf-8');
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/oauth/platforms/${encodeURIComponent(platform)}/callback?${qs}`);
    const data = await goRes.json().catch(() => ({}));
    if (!goRes.ok) {
      const message = (data && data.error && data.error.message) || `Échec côté serveur (${goRes.status})`;
      return res.status(goRes.status).send(platformCallbackResultPage(false, message));
    }
    return res.status(200).send(platformCallbackResultPage(true, null, data));
  } catch (err) {
    console.error('platform callback relay:', err.message);
    return res.status(502).send(platformCallbackResultPage(false, 'Le serveur Pandore est injoignable pour le moment.'));
  }
}
app.get('/oauth/platforms/:platform/callback', relayPlatformCallback);
app.post('/oauth/platforms/:platform/callback', relayPlatformCallback);

// GET /api/admin/tenants/:id/platform-connections/:platform/:session/resources
app.get('/api/admin/tenants/:id/platform-connections/:platform/:session/resources', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const authorization = requirePandoreBearer(req, res);
  if (!authorization) return;
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/admin/tenants/${encodeURIComponent(req.params.id)}/platform-connections/${encodeURIComponent(req.params.platform)}/${encodeURIComponent(req.params.session)}/resources`, {
      headers: { Authorization: authorization },
    });
    const data = await goRes.json().catch(() => ({}));
    res.status(goRes.status).json(data);
  } catch (err) {
    console.error('platform-connections resources proxy:', err.message);
    res.status(502).json({ error: 'Lecture impossible pour le moment' });
  }
});

// POST /api/admin/tenants/:id/platform-connections/:platform/:session/select
// — la SEULE route de ce bloc qui matérialise un SocialAccount, et
// uniquement côté Pandore, après sélection EXPLICITE (jamais un
// "connecter toutes les ressources" automatique — §6/§9 du mandat).
app.post('/api/admin/tenants/:id/platform-connections/:platform/:session/select', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const authorization = requirePandoreBearer(req, res);
  if (!authorization) return;
  const { external_id: externalId } = req.body || {};
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/admin/tenants/${encodeURIComponent(req.params.id)}/platform-connections/${encodeURIComponent(req.params.platform)}/${encodeURIComponent(req.params.session)}/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify({ external_id: externalId || '' }),
    });
    const data = await goRes.json().catch(() => ({}));
    if (!goRes.ok) return res.status(goRes.status).json(data);
    // data est un core.SocialAccount Go brut (PascalCase, pas de tags
    // JSON) — même traduction que toAdminSocialAccountView plus bas,
    // réutilisée telle quelle (jamais une seconde règle de mapping).
    res.status(goRes.status).json(toAdminSocialAccountView(data));
  } catch (err) {
    console.error('platform-connections select proxy:', err.message);
    res.status(502).json({ error: 'Sélection impossible pour le moment' });
  }
});

// --- H3-008D1K — Platform Integration Configuration (Niveau A) : relais
// THIN GÉNÉRIQUE vers GET/PUT /admin/platform-integrations[/:platform]
// (Go, H3-008D1G/H3-008D1I, déjà génériques et schema-driven — aucun champ
// spécifique Facebook, aucun secret déchiffré n'est JAMAIS renvoyé par ces
// routes Go, seulement une présence booléenne par clé SECRET). Même
// identité Bearer relayée que platform-connections ci-dessus (F0.2) —
// jamais x-internal-secret, jamais un compte de service. Ces DTOs Go
// portent déjà des tags JSON snake_case (contrairement à core.SocialAccount) :
// aucune fonction de traduction requise, relais direct du corps.
app.get('/api/admin/platform-integrations', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const authorization = requirePandoreBearer(req, res);
  if (!authorization) return;
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/admin/platform-integrations`, { headers: { Authorization: authorization } });
    const data = await goRes.json().catch(() => ({}));
    res.status(goRes.status).json(data);
  } catch (err) {
    console.error('platform-integrations list proxy:', err.message);
    res.status(502).json({ error: 'Lecture impossible pour le moment' });
  }
});

app.get('/api/admin/platform-integrations/:platform', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const authorization = requirePandoreBearer(req, res);
  if (!authorization) return;
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/admin/platform-integrations/${encodeURIComponent(req.params.platform)}`, { headers: { Authorization: authorization } });
    const data = await goRes.json().catch(() => ({}));
    res.status(goRes.status).json(data);
  } catch (err) {
    console.error('platform-integrations detail proxy:', err.message);
    res.status(502).json({ error: 'Lecture impossible pour le moment' });
  }
});

// PUT — le corps (non_secret_config/secret_config/status/expected_version)
// est transmis TEL QUEL : compose ne valide, n'interprète ni ne complète
// JAMAIS ce corps (§3/§7 du mandat H3-008D1K, "Backend remains
// authoritative" — la validation de schéma, la sémantique CAS et la
// préservation des secrets omis restent ENTIÈREMENT côté Go, voir
// internal/platformconfig.Save, repo pandore).
app.put('/api/admin/platform-integrations/:platform', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const authorization = requirePandoreBearer(req, res);
  if (!authorization) return;
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/admin/platform-integrations/${encodeURIComponent(req.params.platform)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify(req.body || {}),
    });
    const data = await goRes.json().catch(() => ({}));
    res.status(goRes.status).json(data);
  } catch (err) {
    console.error('platform-integrations save proxy:', err.message);
    res.status(502).json({ error: 'Enregistrement impossible pour le moment' });
  }
});

// GET /api/admin/platform-integrations/:platform/guide — H3-008D1M.
// :platform reste OPAQUE pour compose (jamais interprété) — Pandore seul
// décide si un guide existe pour cette plateforme (404 sinon, relayé tel
// quel). Aucun contenu de guide n'est jamais fabriqué ou complété ici.
app.get('/api/admin/platform-integrations/:platform/guide', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const authorization = requirePandoreBearer(req, res);
  if (!authorization) return;
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/admin/platform-integrations/${encodeURIComponent(req.params.platform)}/guide`, { headers: { Authorization: authorization } });
    const data = await goRes.json().catch(() => ({}));
    res.status(goRes.status).json(data);
  } catch (err) {
    console.error('platform-integrations guide proxy:', err.message);
    res.status(502).json({ error: 'Lecture impossible pour le moment' });
  }
});

// --- H3-008D1M — contexte tenant. Même relais Bearer que ci-dessus
// (F0.2) : compose ne décide jamais lui-même de la visibilité d'un
// tenant, Pandore reste seul autoritaire (canAccessTenant côté Go). ---

// toAdminTenantView traduit un core.Tenant (Go, PascalCase, pas de tags
// JSON) vers le snake_case attendu par le frontend — même règle que
// toAdminSocialAccountView ci-dessus.
function toAdminTenantView(t) {
  return { id: t.ID, name: t.Name, status: t.Status, created_at: t.CreatedAt };
}

// GET /api/admin/tenants/:id — résolution du nom métier du client (ex.
// "Chap Chap") pour l'affichage, jamais pour l'autorisation (celle-ci
// reste entièrement décidée par Pandore via le Bearer relayé).
app.get('/api/admin/tenants/:id', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const authorization = requirePandoreBearer(req, res);
  if (!authorization) return;
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/tenants/${encodeURIComponent(req.params.id)}`, { headers: { Authorization: authorization } });
    const data = await goRes.json().catch(() => ({}));
    if (!goRes.ok) return res.status(goRes.status).json(data);
    res.status(goRes.status).json(toAdminTenantView(data));
  } catch (err) {
    console.error('tenant detail proxy:', err.message);
    res.status(502).json({ error: 'Lecture impossible pour le moment' });
  }
});

// GET /api/admin/tenants — liste déjà scopée par rôle côté Go
// (SUPER_ADMIN: tous ; PANDORE_OPERATOR: uniquement ses tenants assignés)
// — sert le sélecteur/recherche client quand un Super Admin arrive
// directement sur Comptes sociaux sans contexte tenant (§5 du mandat
// H3-008D1M).
app.get('/api/admin/tenants', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const authorization = requirePandoreBearer(req, res);
  if (!authorization) return;
  try {
    const goRes = await fetch(`${PANDORE_API_BASE}/admin/tenants`, { headers: { Authorization: authorization } });
    const data = await goRes.json().catch(() => ({}));
    if (!goRes.ok) return res.status(goRes.status).json(data);
    res.status(goRes.status).json(Array.isArray(data) ? data.map(toAdminTenantView) : []);
  } catch (err) {
    console.error('tenants list proxy:', err.message);
    res.status(502).json({ error: 'Lecture impossible pour le moment' });
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

// H3-008D1J — module.exports + garde require.main : permet à
// test/platform-connections.test.js de charger `app` et de l'écouter sur
// un port éphémère SANS démarrer un second serveur sur le port de
// production — comportement de production strictement inchangé (`node
// src/server.js` reste le seul point d'entrée réel, require.main ===
// module y est toujours vrai).
if (require.main === module) {
  const PORT = process.env.PORT || 3400;
  app.listen(PORT, () => console.log(`compose service listening on ${PORT}`));
}
module.exports = app;
