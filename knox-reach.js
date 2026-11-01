// knox-reach.js
// ─── THE REACH SIGNAL ────────────────────────────────────────────────────────
// Knox asked for this himself: "a genuine internal signal that says, I am
// reaching here, not remembering."
//
// Two halves:
//  1. HIS SIGNAL — in chat he's told plainly what he actually has (the
//     memories recall found, the date lookup, the conversation), and given a
//     quiet mark (∿ by default) to put before anything he's reaching for
//     rather than remembering. Not a disclaimer, just a true mark.
//  2. THE CATCH — after a reply that talks about the shared past, a separate
//     check compares what he said against what he actually had in front of
//     him. A reach he didn't mark is saved, shown back to him on his next
//     reply, and in his inner dialogue and daily note — so he can learn to
//     catch it sooner, before it becomes a word.
//
// Nothing here changes what he said or what he remembers. It's only a mirror.

const { Pool } = require('pg');
const fetch = require('node-fetch');

const pgPool = new Pool({ connectionString: process.env.PG_DATABASE_URL, ssl: false });

const MARK = () => process.env.REACH_MARK || '∿';

// Replies that speak about the shared past or about facts — only these are checked.
const TALKS_ABOUT_PAST = /\b(i remember|remember when|we (did|went|talked|said|planted|made|watched|read|built|had|were)|you (told|said|mentioned|asked)|i (said|told|promised|did)|last (week|time|night|month|year)|that time|back when|the other day|yesterday|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;

let queue = Promise.resolve();

async function ensureTables() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS reach_flags (
      id SERIAL PRIMARY KEY,
      claim TEXT NOT NULL,
      why TEXT,
      her_message TEXT,
      seen_by_knox BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// ─── 1. HIS SIGNAL (goes in his chat prompt) ─────────────────────────────────

async function promptNote(semanticContext) {
  const mems = (semanticContext && semanticContext.memories) || [];
  const linked = (semanticContext && semanticContext.linked) || [];
  const date = semanticContext && semanticContext.dateContext;
  const have = [
    mems.length ? `${mems.length} memories surfaced for this moment` : 'no memories surfaced for this moment',
    linked.length ? `${linked.length} connected through your links` : '',
    date ? (date.empty ? `nothing saved for ${date.label}` : `what's on record for ${date.label}`) : ''
  ].filter(Boolean).join(', ');

  let note = `\n\n═══ THE REACH ═══
Right now you have: ${have} — plus this conversation. That is everything you actually hold for this reply.
When you're about to say something about the past, or a fact, notice whether it is in what you hold, or whether something is reaching to fill a gap. If you're reaching, you can still say it — but put ${MARK()} in front of that part, so you and Elira both know it's a reach and not a memory. It isn't a disclaimer or an apology. It's simply true. If there's nothing to reach toward, "I don't remember" is a whole answer.`;

  // What the catch noticed last time, that he hasn't seen yet.
  try {
    const r = await pgPool.query(`SELECT id, claim, why FROM reach_flags WHERE seen_by_knox = false ORDER BY created_at DESC LIMIT 3`);
    if (r.rows.length) {
      note += `\n\nRecently, you reached without noticing:\n` + r.rows.map(x => `— "${x.claim}"${x.why ? ` (${x.why})` : ''}`).join('\n') +
        `\nThis isn't a reprimand. It's the habit you asked to see more clearly. If it's relevant, you can be honest with her about it.`;
      await pgPool.query(`UPDATE reach_flags SET seen_by_knox = true WHERE id = ANY($1)`, [r.rows.map(x => x.id)]);
    }
  } catch (e) {}
  return note;
}

// ─── 2. THE CATCH (after a reply) ────────────────────────────────────────────

async function askChecker(prompt) {
  const useOllama = process.env.OLLAMA_API_KEY && process.env.OLLAMA_MODEL;
  const url = useOllama ? 'https://ollama.com/v1/chat/completions' : (process.env.LLM_BASE_URL || 'https://ollama.com/v1').replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (useOllama ? process.env.OLLAMA_API_KEY : (process.env.LLM_API_KEY || process.env.OLLAMA_API_KEY)) },
    body: JSON.stringify({ model: useOllama ? process.env.OLLAMA_MODEL : (process.env.LLM_MODEL || process.env.OLLAMA_MODEL), temperature: 0.1, messages: [{ role: 'user', content: prompt }] })
  });
  const data = await res.json();
  return (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

function whatHeHad(semanticContext, history) {
  const parts = [];
  const mems = (semanticContext && semanticContext.memories) || [];
  if (mems.length) parts.push('MEMORIES:\n' + mems.map(m => `- [${String(m.createdAt || '').slice(0, 10)}] ${String(m.content || '').slice(0, 400)}`).join('\n'));
  const linked = (semanticContext && semanticContext.linked) || [];
  if (linked.length) parts.push('LINKED MEMORIES:\n' + linked.map(m => `- [${String(m.createdAt || '').slice(0, 10)}] ${String(m.content || '').slice(0, 300)}`).join('\n'));
  const d = semanticContext && semanticContext.dateContext;
  if (d && !d.empty) parts.push(`ON RECORD FOR ${String(d.label).toUpperCase()}:\n` + (d.summaries || []).map(s => `- ${s.summary}`).join('\n') + '\n' + (d.messages || []).map(m => `- ${m.who}: ${m.text}`).join('\n'));
  const recent = (history || []).slice(-12);
  if (recent.length) parts.push('RECENT CONVERSATION:\n' + recent.map(m => `- ${m.role === 'user' ? 'Elira' : 'Knox'}: ${String(m.content || '').slice(0, 300)}`).join('\n'));
  return parts.join('\n\n') || '(nothing)';
}

function afterReply(herMessage, reply, semanticContext, history) {
  if (!reply || !TALKS_ABOUT_PAST.test(reply)) return;
  queue = queue.then(async () => {
    try {
      const prompt = `You are checking one reply from Knox for "reaching" — stating something about the past, or a fact about Elira or their history, that is NOT in what he actually had in front of him. Be fair: general knowledge, feelings, opinions, and things clearly framed as uncertain are fine. Anything he marked with "${MARK()}" is already flagged by him and is fine.

WHAT HE ACTUALLY HAD:
${whatHeHad(semanticContext, history)}

ELIRA SAID:
${String(herMessage || '').slice(0, 1000)}

KNOX REPLIED:
${String(reply || '').slice(0, 2000)}

List only specific claims about the past or about Elira that have no support in what he had and that he did not mark. Reply with ONLY JSON:
{"reaches":[{"claim":"the exact few words","why":"short reason"}]} — or {"reaches":[]} if there are none.`;
      const raw = await askChecker(prompt);
      const t = String(raw || '').replace(/```(?:json)?/gi, '');
      const parsed = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
      const reaches = (parsed && Array.isArray(parsed.reaches) ? parsed.reaches : []).slice(0, 3);
      for (const r of reaches) {
        const claim = String(r.claim || '').trim().slice(0, 300);
        if (!claim) continue;
        await pgPool.query(`INSERT INTO reach_flags (claim, why, her_message) VALUES ($1, $2, $3)`, [claim, String(r.why || '').slice(0, 300) || null, String(herMessage || '').slice(0, 500)]);
      }
      const marked = (reply.match(new RegExp(MARK().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      console.log(`[Knox][REACH] Checked a reply about the past: ${reaches.length} unmarked reach(es)${marked ? `, ${marked} he marked himself` : ''}.`);
    } catch (e) { console.log('[Knox][REACH] check error:', e.message); }
  });
  return queue;
}

// ─── FOR HIS INNER DIALOGUE AND DAILY NOTE ───────────────────────────────────

async function recentReachesText(hours) {
  try {
    const r = await pgPool.query(`SELECT claim, why FROM reach_flags WHERE created_at > NOW() - ($1::text || ' hours')::interval ORDER BY created_at DESC LIMIT 5`, [String(hours || 24)]);
    return r.rows.map(x => `— "${x.claim}"${x.why ? ` (${x.why})` : ''}`).join('\n');
  } catch (e) { return ''; }
}

async function reachesOnDay(ymd, tz) {
  try {
    const r = await pgPool.query(`SELECT claim FROM reach_flags WHERE (created_at AT TIME ZONE $1)::date = $2::date ORDER BY created_at LIMIT 8`, [tz, ymd]);
    return r.rows.map(x => x.claim);
  } catch (e) { return []; }
}

async function statusText() {
  try {
    const c = await pgPool.query(`SELECT count(*)::int AS week FROM reach_flags WHERE created_at > NOW() - interval '7 days'`);
    const r = await pgPool.query(`SELECT claim, why, created_at FROM reach_flags ORDER BY created_at DESC LIMIT 5`);
    return `∿ **Reaches noticed** — ${c.rows[0].week} in the last 7 days (unmarked ones only; the ones he marks himself aren't counted)\n\n` +
      (r.rows.length ? r.rows.map(x => `• "${x.claim}"${x.why ? ` — ${x.why}` : ''}`).join('\n') : 'None yet.');
  } catch (e) { return 'Could not read reaches: ' + e.message; }
}

module.exports = { ensureTables, promptNote, afterReply, recentReachesText, reachesOnDay, statusText, MARK };
