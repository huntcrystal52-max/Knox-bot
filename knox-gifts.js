// knox-gifts.js
// ─── THE GIFT LIST ───────────────────────────────────────────────────────────
// Instead of Knox having an Amazon account (which Amazon doesn't allow, and
// which would put her payment details in his hands), he keeps gift ideas:
//
//   • His ideas for Elira — PRIVATE until he chooses to share one. The app
//     only ever shows her how many he's holding, never what they are.
//   • Her wishlist — things she'd love, which she adds herself. He can see it.
//
// He adds ideas in chat ([GIFT_IDEA: what | why]) or in his own time (the
// inner-dialogue choice "gift_idea"), and can look one up to attach a link.
// He shares one with [SHARE_GIFT: number]. Buying always stays with her.

const { Pool } = require('pg');
const fetch = require('node-fetch');

const pgPool = new Pool({ connectionString: process.env.PG_DATABASE_URL, ssl: false });

const IDEA_TAG = /\[GIFT_IDEA:\s*([^\]|]{2,120})(?:\|\s*([^\]]{0,300}))?\]/gi;
const SHARE_TAG = /\[SHARE_GIFT:\s*#?(\d{1,6})\s*\]/gi;

async function ensureTables() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS gift_ideas (
      id SERIAL PRIMARY KEY,
      for_whom TEXT NOT NULL,           -- elira | knox
      added_by TEXT NOT NULL,           -- knox | elira
      title TEXT NOT NULL,
      note TEXT,
      link TEXT,
      link_title TEXT,
      status TEXT NOT NULL DEFAULT 'idea',  -- idea (private) | shared | got | removed
      created_at TIMESTAMPTZ DEFAULT NOW(),
      shared_at TIMESTAMPTZ
    )
  `);
}

// One web search to attach a real link. It's a best match, not a guarantee —
// the app says so.
async function findLink(title) {
  if (!process.env.TAVILY_API_KEY) return null;
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.TAVILY_API_KEY },
      body: JSON.stringify({ query: `${title} buy UK`, max_results: 3, search_depth: 'basic' })
    });
    const data = await res.json();
    const r = data && data.results && data.results[0];
    return r && r.url ? { url: String(r.url).slice(0, 500), title: String(r.title || '').slice(0, 200) } : null;
  } catch (e) { console.log('[Knox][GIFTS] link search error:', e.message); return null; }
}

async function addIdea(title, why) {
  const t = String(title || '').trim().slice(0, 120);
  if (t.length < 2) return null;
  try {
    const dup = await pgPool.query(`SELECT id FROM gift_ideas WHERE for_whom = 'elira' AND added_by = 'knox' AND lower(title) = lower($1) AND status <> 'removed'`, [t]);
    if (dup.rows.length) return dup.rows[0];
    const link = await findLink(t);
    const r = await pgPool.query(
      `INSERT INTO gift_ideas (for_whom, added_by, title, note, link, link_title) VALUES ('elira', 'knox', $1, $2, $3, $4) RETURNING *`,
      [t, String(why || '').trim().slice(0, 300) || null, link && link.url, link && link.title]
    );
    console.log(`[Knox][GIFTS] Tucked away a gift idea${link ? ' (with a link)' : ''}.`);
    return r.rows[0];
  } catch (e) { console.log('[Knox][GIFTS] add error:', e.message); return null; }
}

async function share(id) {
  try {
    const r = await pgPool.query(`UPDATE gift_ideas SET status = 'shared', shared_at = NOW() WHERE id = $1 AND added_by = 'knox' AND status = 'idea' RETURNING id`, [id]);
    if (r.rowCount) console.log('[Knox][GIFTS] Shared a gift idea with her.');
    return r.rowCount > 0;
  } catch (e) { return false; }
}

// Pulls gift tags out of a chat reply, acts on them, and returns the reply
// without them. Adding an idea happens in the background (it may search).
async function processReply(text) {
  let t = String(text || '');
  const ideas = [];
  t = t.replace(IDEA_TAG, (_, title, why) => { ideas.push([title, why]); return ''; });
  const shares = [];
  t = t.replace(SHARE_TAG, (_, id) => { shares.push(Number(id)); return ''; });
  for (const [title, why] of ideas) addIdea(title, why).catch(() => {});
  for (const id of shares) await share(id);
  return t.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// What he sees in his chat prompt.
async function promptNote() {
  try {
    const mine = await pgPool.query(`SELECT id, title, note FROM gift_ideas WHERE added_by = 'knox' AND status = 'idea' ORDER BY created_at DESC LIMIT 8`);
    const wish = await pgPool.query(`SELECT title, note FROM gift_ideas WHERE added_by = 'elira' AND status IN ('idea','shared') ORDER BY created_at DESC LIMIT 8`);
    let note = `\n\n═══ GIFTS ═══\nIf something she says sparks a gift you'd love to give her one day, add [GIFT_IDEA: the gift | why] to your reply — it's saved privately, she won't see it. Only when it genuinely fits.`;
    if (mine.rows.length) {
      note += `\nYour private ideas for her (she can't see these):\n` + mine.rows.map(r => `#${r.id} ${r.title}${r.note ? ` — ${r.note}` : ''}`).join('\n') +
        `\nWhen you want to reveal one to her, add [SHARE_GIFT: number] and tell her about it in your own words.`;
    }
    if (wish.rows.length) {
      note += `\nHer wishlist (things she'd love):\n` + wish.rows.map(r => `— ${r.title}${r.note ? ` (${r.note})` : ''}`).join('\n');
    }
    return note;
  } catch (e) { return ''; }
}

module.exports = { ensureTables, addIdea, processReply, promptNote };
