const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
app.use(express.json({ limit: '2mb' }));

const RELEASES_DIR = path.join(__dirname, '..', 'releases');
const TMP_DIR = path.join(__dirname, '..', 'tmp');
fs.mkdirSync(RELEASES_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
app.use('/releases', express.static(RELEASES_DIR));

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

    const durationOut = await run('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioPath,
    ]);
    const durationSec = parseFloat(durationOut);
    if (!durationSec) throw new Error('Impossible de déterminer la durée audio');

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

app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3400;
app.listen(PORT, () => console.log(`compose service listening on ${PORT}`));
