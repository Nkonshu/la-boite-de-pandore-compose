const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
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
    // Idempotency-Key dérivée du contenu (jamais aléatoire) : un vrai
    // retry du même formulaire (réseau, double-clic) redonne la même clé
    // et rejoue la même soumission côté Go plutôt que d'en créer deux.
    const idempotencyKey = crypto.createHash('sha256').update(JSON.stringify({ email, answers })).digest('hex');
    const goRes = await fetch(`${PANDORE_API_BASE}/public/audits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
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

app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3400;
app.listen(PORT, () => console.log(`compose service listening on ${PORT}`));
