// knox-video.js
// ─── VIDEOS ELIRA SENDS HIM ──────────────────────────────────────────────────
// Two ways:
//
// 1. A link — TikTok, Instagram, X/Twitter, Facebook (YouTube has its own
//    module, knox-youtube.js). Supadata gives the caption/title, who made it,
//    a still, and what's said in it (it makes a transcript with AI when the
//    video has no captions). Needs SUPADATA_API_KEY.
//
// 2. A clip from her phone, uploaded in the app's Home room (it goes straight
//    to Cloudinary). Cloudinary can hand back a still from any point in a
//    video and the sound as an mp3, so he looks at four stills from across
//    the clip and hears what's said (ElevenLabs, like voice notes).
//
// Everything he took in is kept in `shared_videos`, so if she says "that
// video" later, he still knows what was in it.

const { Pool } = require('pg');

const pgPool = new Pool({ connectionString: process.env.PG_DATABASE_URL, ssl: false });
const SUPADATA = 'https://api.supadata.ai/v1';

const LINK = /https?:\/\/(?:[a-z0-9-]+\.)*(?:tiktok\.com|instagram\.com|twitter\.com|x\.com|facebook\.com|fb\.watch)\/[^\s<>()"']+/gi;

async function ensureTables() {
  await pgPool.query(`CREATE TABLE IF NOT EXISTS shared_videos (
    url TEXT PRIMARY KEY,
    source TEXT,            -- tiktok, instagram, x, facebook, clip
    title TEXT, author TEXT, length_s INTEGER,
    transcript TEXT, transcript_note TEXT, frames TEXT,
    seen_at TIMESTAMPTZ DEFAULT NOW()
  )`);
}

const clock = (s) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const sourceOf = (url) => /tiktok/i.test(url) ? 'TikTok' : /instagram/i.test(url) ? 'Instagram' : /(twitter|x)\.com/i.test(url) ? 'X' : /facebook|fb\.watch/i.test(url) ? 'Facebook' : 'video';

function links(text) {
  const out = [];
  for (const m of String(text || '').matchAll(LINK)) {
    const u = m[0].replace(/[.,!?)\]]+$/, '');
    if (!out.includes(u)) out.push(u);
  }
  return out.slice(0, 2);
}

async function kept(url) {
  const r = await pgPool.query(`SELECT * FROM shared_videos WHERE url = $1`, [url]).catch(() => ({ rows: [] }));
  if (r.rows[0]) await pgPool.query(`UPDATE shared_videos SET seen_at = NOW() WHERE url = $1`, [url]).catch(() => {});
  return r.rows[0] || null;
}

async function keep(v) {
  await pgPool.query(
    `INSERT INTO shared_videos (url, source, title, author, length_s, transcript, transcript_note, frames, seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (url) DO UPDATE SET title=$3, author=$4, length_s=$5, transcript=$6, transcript_note=$7, frames=$8, seen_at=NOW()`,
    [v.url, v.source, v.title, v.author, v.length_s, v.transcript, v.transcript_note, v.frames]
  ).catch(e => console.log('[Knox][VIDEO] save error:', e.message));
}

// ── Links (Supadata) ─────────────────────────────────────────────────────────

async function supadata(path, params) {
  const key = (process.env.SUPADATA_API_KEY || '').trim();
  if (!key) return { ok: false, status: 0, data: {} };
  const qs = new URLSearchParams(params).toString();
  let res = await fetch(`${SUPADATA}/${path}?${qs}`, { headers: { 'x-api-key': key } });
  let data = await res.json().catch(() => ({}));
  if (res.status === 202 && data.jobId) { // a longer video — wait for it (up to ~60s)
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 5000));
      res = await fetch(`${SUPADATA}/${path}/${data.jobId}`, { headers: { 'x-api-key': key } });
      const d = await res.json().catch(() => ({}));
      if (d.status === 'completed' || d.content) { data = d; break; }
      if (d.status === 'failed') { data = d; break; }
    }
  }
  return { ok: res.ok && !data.error, status: res.status, data };
}

function timed(content) {
  if (typeof content === 'string') return content.trim();
  let out = ''; let lastMark = -999;
  for (const c of content || []) {
    const s = (c.offset || 0) / 1000; const t = String(c.text || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (s - lastMark >= 30) { out += `${out ? '\n' : ''}[${clock(s)}] `; lastMark = s; }
    out += t + ' ';
  }
  return out.trim();
}

async function watchLink(url, helpers) {
  const old = await kept(url);
  if (old) return Object.assign({ fresh: false }, old);
  if (!(process.env.SUPADATA_API_KEY || '').trim()) return null;

  const [meta, tr] = await Promise.all([
    supadata('metadata', { url }).catch(e => ({ ok: false, data: { message: e.message } })),
    supadata('transcript', { url, mode: 'auto', lang: 'en' }).catch(e => ({ ok: false, data: { message: e.message } }))
  ]);
  if (!meta.ok) console.log('[Knox][VIDEO] Supadata details:', meta.status, String(meta.data.message || meta.data.error || '').slice(0, 150));
  if (!tr.ok) console.log('[Knox][VIDEO] Supadata transcript:', tr.status, String(tr.data.message || tr.data.error || '').slice(0, 150));

  const m = meta.ok ? meta.data : {};
  const media = m.media || {};
  const thumb = media.thumbnailUrl || (Array.isArray(media.items) && media.items[0] && (media.items[0].thumbnailUrl || media.items[0].url)) || media.url || null;
  let frames = '';
  if (thumb && helpers && helpers.describeImage) {
    const seen = await helpers.describeImage(thumb).catch(() => null);
    if (seen) frames = `the cover still: ${String(seen).replace(/\s+/g, ' ').slice(0, 700)}`;
  }
  const transcript = tr.ok ? timed(tr.data.content) : '';
  const v = {
    url, source: sourceOf(url) !== 'video' ? sourceOf(url) : (m.platform || 'video'),
    title: m.title || null,
    author: (m.author && (m.author.displayName || m.author.username)) || null,
    length_s: media.duration ? Math.round(media.duration) : null,
    transcript: transcript.slice(0, 200000) || null,
    transcript_note: transcript ? 'what was said' : (tr.status === 404 || tr.status === 206 ? 'there was no speech to transcribe (maybe just music)' : 'the transcript couldn\'t be fetched'),
    frames: frames || null,
    caption: m.description || null
  };
  if (v.caption) v.title = v.title && v.title !== v.caption ? `${v.title} — ${v.caption}` : v.caption;
  if (v.title) v.title = v.title.slice(0, 1500);
  if (!v.title && !v.transcript && !v.frames) { console.log(`[Knox][VIDEO] Couldn't get anything for ${url}.`); return null; }
  await keep(v);
  console.log(`[Knox][VIDEO] Watched a ${sourceOf(url)} video — transcript: ${v.transcript ? v.transcript.length + ' chars' : 'none'}, still: ${frames ? 'yes' : 'no'}.`);
  return Object.assign({ fresh: true }, v);
}

// ── Clips she uploads (Cloudinary) ───────────────────────────────────────────

// Cloudinary video link → a still at `pct`% through, or the sound as mp3.
const cloudinaryPart = (url, transform, ext) => url.replace('/video/upload/', `/video/upload/${transform ? transform + '/' : ''}`).replace(/\.[a-z0-9]+(\?.*)?$/i, `.${ext}`);
const isCloudinaryVideo = (url) => /^https:\/\/res\.cloudinary\.com\/[^/]+\/video\/upload\/.+\.[a-z0-9]+$/i.test(String(url || ''));

// Cloudinary makes stills and sound the first time they're asked for, which
// can take a moment for a big clip — so ask, and wait and ask again if needed.
async function fetchMade(u, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(u);
      if (res.ok) return res;
      console.log(`[Knox][VIDEO] Cloudinary ${res.status} for ${u.split('/upload/')[1]}${i < tries - 1 ? ' — waiting and trying again' : ''}`);
      if (res.status === 404 || res.status === 400) return null;
    } catch (e) { console.log('[Knox][VIDEO] fetch error:', e.message); }
    await new Promise(r => setTimeout(r, 6000));
  }
  return null;
}

async function watchClip(url, helpers, lengthS) {
  if (!isCloudinaryVideo(url)) return null;
  const old = await kept(url);
  if (old) return Object.assign({ fresh: false }, old);

  const stills = [['near the start', 5], ['a quarter in', 30], ['past halfway', 60], ['near the end', 90]];
  const look = Promise.all(stills.map(async ([label, pct]) => {
    try {
      const still = cloudinaryPart(url, `so_${pct}p,w_768,c_limit`, 'jpg');
      if (!helpers.describeImage || !(await fetchMade(still, 3))) return null;
      const d = await helpers.describeImage(still);
      return d ? `${label}: ${String(d).replace(/\s+/g, ' ').slice(0, 600)}` : null;
    } catch (e) { return null; }
  }));
  const listen = (async () => {
    if (!helpers.transcribe) return { text: null, note: 'he can\'t hear videos yet (ElevenLabs isn\'t set up)' };
    try {
      const res = await fetchMade(cloudinaryPart(url, '', 'mp3'));
      if (!res) return { text: null, note: 'the sound couldn\'t be taken out of the clip' };
      const data = Buffer.from(await res.arrayBuffer());
      const text = await helpers.transcribe({ id: null, mime: 'audio/mpeg', data, transcript: null });
      return { text, note: text ? 'sounds are in brackets, like (music)' : 'no speech was picked up' };
    } catch (e) { console.log('[Knox][VIDEO] Sound error:', e.message); return { text: null, note: 'the sound couldn\'t be heard' }; }
  })();
  const [seen, heard] = await Promise.all([look, listen]);
  const frames = seen.filter(Boolean).join('\n');
  const v = {
    url, source: 'clip', title: null, author: 'Elira',
    length_s: Number.isFinite(lengthS) ? Math.round(lengthS) : null,
    transcript: heard.text ? String(heard.text).slice(0, 100000) : null,
    transcript_note: heard.note,
    frames: frames || null
  };
  if (!v.frames && !v.transcript) { console.log('[Knox][VIDEO] Couldn\'t see or hear the clip.'); return null; }
  await keep(v);
  console.log(`[Knox][VIDEO] Watched her clip — stills: ${seen.filter(Boolean).length}, transcript: ${v.transcript ? v.transcript.length + ' chars' : 'none'}.`);
  return Object.assign({ fresh: true }, v);
}

// ── What he's told ───────────────────────────────────────────────────────────

function describe(v, max) {
  const from = v.source === 'clip' ? 'A video Elira recorded or saved on her phone' : `A ${v.source || 'video'} video${v.author ? ` by ${v.author}` : ''}`;
  const len = v.length_s ? ` (${clock(v.length_s)} long)` : '';
  const t = String(v.transcript || '');
  return `${from}${len}` +
    (v.title ? `\nCaption: ${v.title.replace(/\s+/g, ' ').slice(0, 600)}` : '') +
    (v.frames ? `\nWhat you saw:\n${v.frames}` : '') +
    (t ? `\nWhat you heard (${v.transcript_note}):\n"""\n${t.length > max ? t.slice(0, max) + '\n(…it goes on — this is most of it.)' : t}\n"""`
       : `\nNo words — ${v.transcript_note}. Go by what you saw and the caption, and be honest about what you couldn't hear.`);
}

// For his prompt when her message has a TikTok/Instagram/X/Facebook link,
// or when she mentions "that video" soon after. Returns { note, fresh }.
async function promptNote(userMessage, helpers) {
  try {
    const m = String(userMessage || '');
    const urls = links(m);
    if (urls.length) {
      if (!(process.env.SUPADATA_API_KEY || '').trim()) {
        return { note: `\n\n═══ A VIDEO LINK ═══\nElira sent a ${sourceOf(urls[0])} link, but you can't open those yet (Supadata isn't set up). Tell her honestly — don't guess what's in it.`, fresh: [] };
      }
      const vids = (await Promise.all(urls.map(u => watchLink(u, helpers)))).filter(Boolean);
      if (!vids.length) return { note: `\n\n═══ A VIDEO LINK ═══\nElira sent a ${sourceOf(urls[0])} link, but it wouldn't open just now (it may be private). Tell her honestly — don't guess what's in it.`, fresh: [] };
      return { note: `\n\n═══ ${vids.length > 1 ? 'VIDEOS' : 'A VIDEO'} ELIRA SENT YOU ═══\nYou've watched it — this is what you saw and heard.\n\n${vids.map(v => describe(v, Math.floor(10000 / vids.length))).join('\n\n───\n\n')}`, fresh: vids.filter(v => v.fresh) };
    }
    if (!/^Elira sent you a video\./.test(m) && /\b(video|tiktok|reel|clip|vid)\b/i.test(m)) {
      const r = await pgPool.query(`SELECT * FROM shared_videos WHERE seen_at > NOW() - INTERVAL '2 days' ORDER BY seen_at DESC LIMIT 1`);
      if (r.rows[0]) return { note: `\n\n═══ THE LAST VIDEO ELIRA SENT YOU ═══\n${describe(r.rows[0], 6000)}`, fresh: [] };
    }
  } catch (e) { console.log('[Knox][VIDEO] note error:', e.message); }
  return { note: '', fresh: [] };
}

module.exports = { ensureTables, links, watchLink, watchClip, describe, promptNote, isCloudinaryVideo, cloudinaryPart };
