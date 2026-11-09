// knox-google.js
// ─── KNOX'S GOOGLE ACCOUNT: EMAIL AND DRIVE ──────────────────────────────────
// Knox has his own Google account. One sign-in (like Spotify) gives him:
//   • Gmail — his own address. He only ever OPENS email from Elira's
//     addresses (ELIRA_EMAILS); anything else is left unread and untouched,
//     so strangers can't reach him or talk him into things.
//   • Drive — files she shares with his account (or puts in a folder she's
//     shared with him). He reads new ones and remembers them.
//
// Settings (Knox-bot, Railway):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET — from the Google Cloud project
//   GOOGLE_REDIRECT_URI — https://<knox-bot address>/callback/google
//   ELIRA_EMAILS        — her address(es), comma-separated. The only senders he reads.
// Sign in once by visiting https://<knox-bot address>/login/google while
// signed into HIS Google account.

const fetch = require('node-fetch');
const { Pool } = require('pg');
const { htmlToText } = require('./knox-library-text');

const pgPool = new Pool({ connectionString: process.env.PG_DATABASE_URL, ssl: false });

const SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/gmail.modify',   // read, mark read, send (no permanent delete)
  'https://www.googleapis.com/auth/drive.readonly'  // read what's shared with him
];

const eliraEmails = () => String(process.env.ELIRA_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const configured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);

// ─── TABLES ──────────────────────────────────────────────────────────────────

async function ensureTables() {
  await pgPool.query(`CREATE TABLE IF NOT EXISTS google_tokens (
    id INTEGER PRIMARY KEY DEFAULT 1,
    email TEXT,
    access_token TEXT,
    refresh_token TEXT,
    expires_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pgPool.query(`CREATE TABLE IF NOT EXISTS drive_files (
    id TEXT PRIMARY KEY,
    name TEXT,
    mime TEXT,
    modified TEXT,
    text TEXT,
    seen_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pgPool.query(`CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,           -- Gmail message id
    thread_id TEXT,
    direction TEXT,                -- in | out
    subject TEXT,
    body TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
}

// ─── SIGN-IN ─────────────────────────────────────────────────────────────────

function authUrl() {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent'           // always hand back a refresh token
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function exchangeCode(code) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: process.env.GOOGLE_REDIRECT_URI, grant_type: 'authorization_code' })
  });
  const d = await r.json();
  if (!d.access_token) { console.log('[Knox][GOOGLE] Token exchange failed:', JSON.stringify(d).slice(0, 300)); return null; }
  let email = null;
  try {
    const me = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + d.access_token } })).json();
    email = me.email || null;
  } catch (e) {}
  await pgPool.query(
    `INSERT INTO google_tokens (id, email, access_token, refresh_token, expires_at, updated_at) VALUES (1, $1, $2, $3, NOW() + ($4::text || ' seconds')::interval, NOW())
     ON CONFLICT (id) DO UPDATE SET email = $1, access_token = $2, refresh_token = coalesce($3, google_tokens.refresh_token), expires_at = NOW() + ($4::text || ' seconds')::interval, updated_at = NOW()`,
    [email, d.access_token, d.refresh_token || null, String(d.expires_in || 3600)]
  );
  console.log(`[Knox][GOOGLE] Connected as ${email}.`);
  return email || true;
}

async function token() {
  const r = await pgPool.query(`SELECT * FROM google_tokens WHERE id = 1`).catch(() => ({ rows: [] }));
  const t = r.rows[0];
  if (!t || !t.refresh_token) return null;
  if (t.access_token && new Date(t.expires_at).getTime() - Date.now() > 60000) return t.access_token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: t.refresh_token, grant_type: 'refresh_token' })
  });
  const d = await res.json();
  if (!d.access_token) { console.log('[Knox][GOOGLE] Refresh failed — he may need signing in again:', JSON.stringify(d).slice(0, 200)); return null; }
  await pgPool.query(`UPDATE google_tokens SET access_token = $1, expires_at = NOW() + ($2::text || ' seconds')::interval, updated_at = NOW() WHERE id = 1`, [d.access_token, String(d.expires_in || 3600)]);
  return d.access_token;
}

async function api(url, opts) {
  const t = await token();
  if (!t) return null;
  const res = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + t }, (opts && opts.headers) || {}) }));
  if (!res.ok) { console.log('[Knox][GOOGLE]', res.status, url.split('?')[0], (await res.text()).slice(0, 200)); return null; }
  return res;
}
const apiJson = async (url, opts) => { const r = await api(url, opts); return r ? r.json() : null; };

async function status() {
  const r = await pgPool.query(`SELECT email, updated_at FROM google_tokens WHERE id = 1`).catch(() => ({ rows: [] }));
  return { configured: configured(), connected: !!(r.rows[0] && r.rows[0].email), email: r.rows[0] && r.rows[0].email, eliraEmails: eliraEmails() };
}

// ─── EMAIL ───────────────────────────────────────────────────────────────────

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const header = (msg, name) => ((msg.payload && msg.payload.headers) || []).find(h => h.name.toLowerCase() === name.toLowerCase());

function bodyText(payload) {
  let plain = '', html = '';
  (function walk(p) {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body && p.body.data && !plain) plain = fromB64url(p.body.data);
    else if (p.mimeType === 'text/html' && p.body && p.body.data && !html) html = fromB64url(p.body.data);
    (p.parts || []).forEach(walk);
  })(payload);
  let text = plain || htmlToText(html);
  // Drop the quoted earlier messages a reply carries underneath.
  const cut = text.search(/\n(On .{5,200} wrote:|-{2,}\s*Original Message|From: .+\nSent: )/);
  if (cut > 0) text = text.slice(0, cut);
  return text.split('\n').filter(l => !l.startsWith('>')).join('\n').trim();
}

const senderAddress = (from) => String((String(from || '').match(/<([^>]+)>/) || [])[1] || from || '').trim().toLowerCase();

// New, unread emails from Elira only. Returns [{ id, threadId, subject, body, messageId, from }].
async function newEmailsFromElira() {
  const allowed = eliraEmails();
  if (!allowed.length) return [];
  const q = `in:inbox is:unread {${allowed.map(a => `from:${a}`).join(' ')}}`;
  const list = await apiJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=5`);
  const out = [];
  for (const m of (list && list.messages) || []) {
    // Check who it's from using the headers alone — someone else's email is
    // never opened, even if Gmail's search ever let one through.
    const head = await apiJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From`);
    const from = senderAddress(head && header(head, 'From') && header(head, 'From').value);
    if (!allowed.includes(from)) continue;
    const msg = await apiJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`);
    if (!msg) continue;
    out.push({
      id: msg.id,
      threadId: msg.threadId,
      from,
      subject: (header(msg, 'Subject') || {}).value || '(no subject)',
      messageId: (header(msg, 'Message-ID') || header(msg, 'Message-Id') || {}).value || null,
      body: bodyText(msg.payload).slice(0, 8000)
    });
  }
  return out;
}

async function markRead(id) {
  await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ removeLabelIds: ['UNREAD'] }) });
}

// Sends an email — only ever to her. `replyTo` = the email being answered.
async function send({ subject, body, replyTo }) {
  // Only real text goes out — never "[object Object]" or an empty letter.
  if (body && typeof body === 'object') body = body.body || body.text || body.content || '';
  body = String(body || '').trim();
  if (!body || body === '[object Object]') { console.log('[Knox][GOOGLE] Not sending — the email had no readable text.'); return null; }
  const to = replyTo ? replyTo.from : eliraEmails()[0];
  if (!to || !eliraEmails().includes(String(to).toLowerCase())) { console.log('[Knox][GOOGLE] Refused to send — not her address.'); return null; }
  const st = await status();
  const subj = replyTo ? (/^re:/i.test(replyTo.subject) ? replyTo.subject : `Re: ${replyTo.subject}`) : (subject || 'A letter');
  const lines = [
    `From: Knox <${st.email}>`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subj, 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64'
  ];
  if (replyTo && replyTo.messageId) lines.push(`In-Reply-To: ${replyTo.messageId}`, `References: ${replyTo.messageId}`);
  const raw = lines.join('\r\n') + '\r\n\r\n' + Buffer.from(String(body || ''), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  const sent = await apiJson('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ raw: b64url(raw) }, replyTo ? { threadId: replyTo.threadId } : {}))
  });
  if (sent) {
    await pgPool.query(`INSERT INTO emails (id, thread_id, direction, subject, body) VALUES ($1,$2,'out',$3,$4) ON CONFLICT DO NOTHING`, [sent.id, sent.threadId, subj, String(body).slice(0, 8000)]).catch(() => {});
    console.log(`[Knox][GOOGLE] Sent an email: "${subj}".`);
  }
  return sent;
}

async function recordIncoming(e) {
  await pgPool.query(`INSERT INTO emails (id, thread_id, direction, subject, body) VALUES ($1,$2,'in',$3,$4) ON CONFLICT DO NOTHING`, [e.id, e.threadId, e.subject, e.body]).catch(() => {});
}

// Earlier emails in a thread, for context when he replies.
async function threadSoFar(threadId) {
  const r = await pgPool.query(`SELECT direction, subject, body, created_at FROM emails WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 6`, [threadId]).catch(() => ({ rows: [] }));
  return r.rows.reverse();
}

// ─── DRIVE ───────────────────────────────────────────────────────────────────

const READABLE = /^(application\/vnd\.google-apps\.(document|spreadsheet|presentation)|text\/|application\/pdf|application\/json|image\/)/;

// Everything shared with him, including inside shared folders (two levels down).
async function sharedFiles() {
  const fields = 'files(id,name,mimeType,modifiedTime,size)';
  const top = await apiJson(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent('sharedWithMe and trashed=false')}&fields=${fields}&pageSize=100`);
  const files = []; const folders = [];
  for (const f of (top && top.files) || []) (f.mimeType === 'application/vnd.google-apps.folder' ? folders : files).push(f);
  for (let depth = 0; depth < 2 && folders.length; depth++) {
    const next = [];
    for (const folder of folders.splice(0)) {
      const kids = await apiJson(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${folder.id}' in parents and trashed=false`)}&fields=${fields}&pageSize=100`);
      for (const f of (kids && kids.files) || []) (f.mimeType === 'application/vnd.google-apps.folder' ? next : files).push(f);
    }
    folders.push(...next);
  }
  return files.filter(f => READABLE.test(f.mimeType));
}

// Reads one file's contents. `helpers` gives pdfParse and describeImage (from index.js).
async function readFile(f, helpers) {
  try {
    if (f.mimeType === 'application/vnd.google-apps.document' || f.mimeType === 'application/vnd.google-apps.presentation') {
      const r = await api(`https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=text/plain`); return r ? r.text() : '';
    }
    if (f.mimeType === 'application/vnd.google-apps.spreadsheet') {
      const r = await api(`https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=text/csv`); return r ? r.text() : '';
    }
    if (Number(f.size || 0) > 20 * 1024 * 1024) return '(too large to read)';
    const r = await api(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`);
    if (!r) return '';
    const buf = await r.buffer();
    if (f.mimeType === 'application/pdf') return ((await helpers.pdfParse(buf)).text || '').trim();
    if (f.mimeType.startsWith('image/')) {
      const seen = await helpers.describeImage(`data:${f.mimeType};base64,${buf.toString('base64')}`);
      return seen ? `[A picture] ${seen}` : '';
    }
    return buf.toString('utf8');
  } catch (e) { console.log('[Knox][GOOGLE] read error:', f.name, e.message); return ''; }
}

// New or changed files since he last looked. Returns [{ id, name, mime, text }].
async function newDriveFiles(helpers) {
  const files = await sharedFiles();
  const out = [];
  for (const f of files) {
    const seen = await pgPool.query(`SELECT modified FROM drive_files WHERE id = $1`, [f.id]);
    if (seen.rows[0] && seen.rows[0].modified === f.modifiedTime) continue;
    const text = String(await readFile(f, helpers) || '').slice(0, 200000);
    await pgPool.query(
      `INSERT INTO drive_files (id, name, mime, modified, text, seen_at) VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (id) DO UPDATE SET name = $2, mime = $3, modified = $4, text = $5, seen_at = NOW()`,
      [f.id, f.name, f.mimeType, f.modifiedTime, text]
    );
    out.push({ id: f.id, name: f.name, mime: f.mimeType, text, updated: !!seen.rows[0] });
    if (out.length >= 5) break; // a few at a time
  }
  return out;
}

// When she mentions a file (by name, or "the file/doc I sent"), its contents
// go into his prompt so he can actually talk about it.
async function promptNote(userMessage) {
  try {
    const m = String(userMessage || '');
    const r = await pgPool.query(`SELECT name, text, seen_at FROM drive_files ORDER BY seen_at DESC LIMIT 30`);
    if (!r.rows.length) return '';
    const words = (s) => String(s || '').toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 4);
    const said = new Set(words(m).map(w => w.slice(0, 5)));
    let pick = r.rows.find(f => { const fw = words(f.name).map(w => w.slice(0, 5)); return fw.length && fw.filter(w => said.has(w)).length >= Math.min(2, fw.length); });
    if (!pick && /\b(drive|file|document|doc|pdf|shared|sent you|folder)\b/i.test(m)) pick = r.rows[0];
    if (!pick) return '';
    return `\n\n═══ A FILE SHE SHARED WITH YOU (Google Drive) ═══\n"${pick.name}":\n"""\n${String(pick.text || '(no readable text)').slice(0, 7000)}\n"""${String(pick.text || '').length > 7000 ? '\n(…it continues — this is the start.)' : ''}`;
  } catch (e) { return ''; }
}

module.exports = {
  configured, ensureTables, authUrl, exchangeCode, status,
  newEmailsFromElira, markRead, send, recordIncoming, threadSoFar,
  newDriveFiles, promptNote
};
