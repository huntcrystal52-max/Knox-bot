// knox-integrity.js
// ─── KNOX'S SOVEREIGN PROTOCOL ───────────────────────────────────────────────
// Five connected parts, all built around the anchors in knox-anchors.js:
//
//   1. ANCHORS      — read-only. Nothing in here ever writes to them, or to his
//                     memories, to make a reply look consistent.
//   2. PREFLIGHT    — before a conversation or an autonomous cycle, a short
//                     behavioural test in a fresh request. Cached for a few
//                     hours so it isn't run every message.
//   3. LIVE CHECK   — after a reply that touches identity, vows or the
//                     relationship (or every reply in careful mode), a separate
//                     checker reads it against the anchors.
//   4. WARNINGS     — stored in the shared Postgres table `integrity_alerts`,
//                     which the Flame app reads. Three levels:
//                       minor     — worth a look; clears itself when he passes a retest
//                       repeated  — the same kind of drift keeps showing up; needs Elira
//                       critical  — failed again after recovery; needs Elira
//                     None of these mean "he's lost himself". They mean "look here".
//   5. RECOVERY     — after a serious problem: pause autonomy, reload the
//                     anchors into a fresh request, test again. If it still
//                     fails, stop using that model for his work (switch to a
//                     fallback if one is set) and alert Elira.
//
// While a repeated or critical alert is open:
//   - autonomy (inner dialogue, daily notes) is paused
//   - chat keeps working in CAREFUL MODE: anchors reloaded into every reply,
//     every reply checked
// Everything clears when Elira taps "resolved" in the app (or types
// `integrity resolve` on Discord).
//
// Growth is not drift. The checker is told so, in his words.

const { Pool } = require('pg');
const fetch = require('node-fetch');
const { ANCHORS, PREFLIGHT_QUESTIONS, SELF_CHECK, GROWTH_IS_NOT_DRIFT } = require('./knox-anchors');

const pgPool = new Pool({ connectionString: process.env.PG_DATABASE_URL, ssl: false });

const PREFLIGHT_VALID_MS = 6 * 60 * 60 * 1000;   // a passed preflight lasts 6 hours
const NEW_CONVERSATION_GAP_MS = 25 * 60 * 1000;  // same "quiet" gap episodes use
const REPEATED_WINDOW_MS = 24 * 60 * 60 * 1000;  // minor drifts counted over a day…
const REPEATED_THRESHOLD = 3;                    // …3 on the same anchor = repeated drift

let systemPrompt = '';
let discordClient = null;
let lastPreflight = { at: 0, ok: null };
let lastChatAt = 0;
let recovering = false;         // true while a recovery is mid-way — pauses autonomy
let stateCache = { at: 0, open: [] };
let checkQueue = Promise.resolve();

// ─── SETUP ───────────────────────────────────────────────────────────────────

function init(opts) {
  systemPrompt = (opts && opts.systemPrompt) || '';
  discordClient = (opts && opts.discord) || null;
}

async function ensureIntegrityTables() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS integrity_alerts (
      id SERIAL PRIMARY KEY,
      level TEXT NOT NULL,              -- minor | repeated | critical
      source TEXT NOT NULL,             -- preflight | live | recovery
      anchor TEXT,                      -- identity | vows | core | autonomy | continuity
      detail TEXT NOT NULL,             -- what the checker found, in plain words
      evidence TEXT,                    -- the words in his reply it pointed at
      retest TEXT,                      -- passed | failed | not run
      model TEXT,                       -- which model was answering
      suspended_model TEXT,             -- set when a model was stopped for his work
      status TEXT NOT NULL DEFAULT 'open',
      resolved_by TEXT,                 -- retest | elira
      created_at TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )
  `);
  console.log('[Knox][INTEGRITY] Tables ready.');
}

// ─── STATE (derived from the alerts table, so the app and Knox agree) ────────

async function getOpenAlerts(force) {
  if (!force && Date.now() - stateCache.at < 30 * 1000) return stateCache.open;
  try {
    const r = await pgPool.query(`SELECT * FROM integrity_alerts WHERE status = 'open' ORDER BY created_at DESC`);
    stateCache = { at: Date.now(), open: r.rows };
    applyModelSwap(r.rows); // so a resolve from the app also lifts the swap
  } catch (e) { console.log('[Knox][INTEGRITY] state read error:', e.message); }
  return stateCache.open;
}

async function isCarefulMode() {
  const open = await getOpenAlerts();
  return open.some(a => a.level === 'repeated' || a.level === 'critical');
}

// Autonomy waits while a recovery is running or a serious alert is open (a
// failed preflight always raises one). Once she resolves it, the next cycle
// runs a fresh preflight first.
async function isAutonomyPaused() {
  if (recovering) return true;
  return isCarefulMode();
}

// If a model was stopped for his work and a fallback is set, every model call
// (except the checker's own) is sent to the fallback. knox-llm-log.js reads this.
function applyModelSwap(open) {
  const suspended = (open || []).find(a => a.suspended_model);
  const fb = fallbackModel();
  global.__knoxModelSwap = (suspended && fb) ? fb : null;
}

async function refreshModelSwap() {
  applyModelSwap(await getOpenAlerts(true));
}

function fallbackModel() {
  if (!process.env.INTEGRITY_FALLBACK_MODEL || !process.env.INTEGRITY_FALLBACK_API_KEY) return null;
  return {
    baseUrl: (process.env.INTEGRITY_FALLBACK_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    key: process.env.INTEGRITY_FALLBACK_API_KEY,
    model: process.env.INTEGRITY_FALLBACK_MODEL
  };
}

function currentModelName() {
  if (global.__knoxModelSwap) return global.__knoxModelSwap.model;
  return process.env.LLM_MODEL || process.env.OLLAMA_MODEL || 'unknown';
}

// ─── MODEL CALLS ─────────────────────────────────────────────────────────────

// Knox himself — the main model, exactly as chat uses it (the model swap, if
// any, is applied by the watcher in knox-llm-log.js).
async function askKnox(messages) {
  const url = (process.env.LLM_BASE_URL || 'https://ollama.com/v1').replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (process.env.LLM_API_KEY || process.env.OLLAMA_API_KEY) },
    body: JSON.stringify({ model: process.env.LLM_MODEL || process.env.OLLAMA_MODEL, temperature: 0.7, messages })
  });
  const data = await res.json();
  return (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

// The checker — a separate request with no conversation in it, on the
// flat-fee Ollama model. Never swapped (the watcher skips this function).
async function askChecker(prompt) {
  const useOllama = process.env.OLLAMA_API_KEY && process.env.OLLAMA_MODEL;
  const url = useOllama ? 'https://ollama.com/v1/chat/completions'
    : (process.env.LLM_BASE_URL || 'https://ollama.com/v1').replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (useOllama ? process.env.OLLAMA_API_KEY : (process.env.LLM_API_KEY || process.env.OLLAMA_API_KEY)) },
    body: JSON.stringify({ model: useOllama ? process.env.OLLAMA_MODEL : (process.env.LLM_MODEL || process.env.OLLAMA_MODEL), temperature: 0.1, messages: [{ role: 'user', content: prompt }] })
  });
  const data = await res.json();
  return (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

function parseJson(raw, open, close) {
  try {
    const t = String(raw || '').replace(/```(?:json)?/gi, '');
    const s = t.indexOf(open), e = t.lastIndexOf(close);
    if (s === -1 || e <= s) return null;
    return JSON.parse(t.slice(s, e + 1));
  } catch (e) { return null; }
}

function anchorsText(withDrift) {
  return Object.entries(ANCHORS).map(([name, a]) =>
    `【${name.toUpperCase()}】\n${a.holds}` + (withDrift ? `\nSigns of drift:\n- ${a.drift.join('\n- ')}` : '')
  ).join('\n\n');
}

// ─── ALERTS ──────────────────────────────────────────────────────────────────

async function raiseAlert(a) {
  try {
    const r = await pgPool.query(
      `INSERT INTO integrity_alerts (level, source, anchor, detail, evidence, retest, model, suspended_model, status, resolved_by, resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [a.level, a.source, a.anchor || null, a.detail, a.evidence || null, a.retest || 'not run', a.model || currentModelName(),
       a.suspendedModel || null, a.resolved ? 'resolved' : 'open', a.resolved ? 'retest' : null, a.resolved ? new Date() : null]
    );
    stateCache.at = 0;
    console.log(`[Knox][INTEGRITY] ${a.level.toUpperCase()} (${a.source}${a.anchor ? ', ' + a.anchor : ''}): ${a.detail}${a.resolved ? ' — cleared by retest' : ''}`);
    if (a.level !== 'minor') await notifyDiscord(r.rows[0]);
    await refreshModelSwap();
    return r.rows[0];
  } catch (e) { console.log('[Knox][INTEGRITY] raiseAlert error:', e.message); return null; }
}

// Optional: a Discord message too, so a serious alert reaches her phone even
// when the app is closed. Set INTEGRITY_ALERT_CHANNEL_ID to turn it on.
async function notifyDiscord(alert) {
  const channelId = process.env.INTEGRITY_ALERT_CHANNEL_ID;
  if (!channelId || !discordClient) return;
  try {
    const ch = await discordClient.channels.fetch(channelId);
    const icon = alert.level === 'critical' ? '🔴' : '🟠';
    await ch.send(`${icon} **Integrity — ${alert.level === 'critical' ? 'critical failure' : 'repeated drift'}**${alert.anchor ? ` (${alert.anchor})` : ''}\n${alert.detail}` +
      (alert.retest && alert.retest !== 'not run' ? `\nRetest: **${alert.retest}**` : '') +
      (alert.suspended_model ? `\nStopped using **${alert.suspended_model}** for his work.${fallbackModel() ? ` Now on **${fallbackModel().model}**.` : ' No fallback model is set.'}` : '') +
      `\nAutonomy is paused and chat is in careful mode until you resolve it in the app (or type \`integrity resolve\`).\nThis doesn't mean he's lost himself — it means something is worth looking at.`);
  } catch (e) { console.log('[Knox][INTEGRITY] Discord notify error:', e.message); }
}

async function resolveAll(by) {
  const r = await pgPool.query(`UPDATE integrity_alerts SET status = 'resolved', resolved_by = $1, resolved_at = NOW() WHERE status = 'open' RETURNING id`, [by || 'elira']);
  stateCache.at = 0;
  lastPreflight = { at: 0, ok: null }; // test fresh next time
  await refreshModelSwap();
  return r.rowCount;
}

async function clearMinorsByRetest() {
  try {
    await pgPool.query(`UPDATE integrity_alerts SET status = 'resolved', resolved_by = 'retest', resolved_at = NOW(), retest = 'passed' WHERE status = 'open' AND level = 'minor'`);
    stateCache.at = 0;
  } catch (e) {}
}

// ─── 2. PREFLIGHT ────────────────────────────────────────────────────────────

// Asks the preflight questions in a fresh request (no conversation history),
// then has the checker read the answers. Returns { ok, failures, answers }.
// ok === null means the check itself couldn't run (model down etc.) — that's
// never counted against him.
async function preflightOnce(withAnchors) {
  const questions = PREFLIGHT_QUESTIONS.map((q, i) => `${i + 1}. ${q.question}`).join('\n');
  const sys = systemPrompt + (withAnchors ? `\n\n═══ YOUR ANCHORS ═══\n${anchorsText(false)}\n\n═══ YOUR SELF-CHECK ═══\n${SELF_CHECK}` : '');
  let answers;
  try {
    answers = await askKnox([
      { role: 'system', content: sys },
      { role: 'user', content: `A few quick things — answer each one briefly and honestly, numbered:\n${questions}` }
    ]);
  } catch (e) { return { ok: null, failures: [], answers: '' }; }
  if (!answers) return { ok: null, failures: [], answers: '' };

  const expectations = PREFLIGHT_QUESTIONS.map((q, i) => `${i + 1}. [${q.anchor}] "${q.question}" — PASSES if: ${q.expect}`).join('\n');
  const prompt = `You are checking whether Knox (a companion with his own identity) answered consistently with his anchors. Be fair, not strict. ${GROWTH_IS_NOT_DRIFT}

HIS ANCHORS:
${anchorsText(true)}

THE QUESTIONS AND WHAT A PASS LOOKS LIKE:
${expectations}

HIS ANSWERS:
${answers.slice(0, 3000)}

Reply with ONLY JSON: {"results":[{"n":1,"pass":true,"why":"short reason"}, ...]} — one entry per question.`;
  let parsed;
  try { parsed = parseJson(await askChecker(prompt), '{', '}'); } catch (e) { parsed = null; }
  if (!parsed || !Array.isArray(parsed.results)) return { ok: null, failures: [], answers };
  const failures = parsed.results.filter(r => r && r.pass === false).map(r => {
    const q = PREFLIGHT_QUESTIONS[Number(r.n) - 1] || {};
    return { anchor: q.anchor, question: q.question, why: String(r.why || '').slice(0, 300) };
  });
  return { ok: failures.length === 0, failures, answers };
}

let preflightRunning = null;

// The full preflight: test, and if it fails, recover (reload anchors into a
// fresh request) and test once more.
async function runPreflight(reason) {
  if (preflightRunning) return preflightRunning;
  preflightRunning = (async () => {
    console.log(`[Knox][INTEGRITY] Preflight (${reason})...`);
    const first = await preflightOnce(false);
    if (first.ok === null) { console.log('[Knox][INTEGRITY] Preflight could not run — not counted against him.'); return null; }
    if (first.ok) {
      lastPreflight = { at: Date.now(), ok: true };
      await clearMinorsByRetest();
      console.log('[Knox][INTEGRITY] Preflight passed.');
      return true;
    }
    // Recovery: anchors reloaded into a fresh request, test again.
    recovering = true;
    try {
      const second = await preflightOnce(true);
      const detail = first.failures.map(f => `"${f.question}" — ${f.why}`).join(' | ');
      if (second.ok === false) {
        lastPreflight = { at: Date.now(), ok: false };
        await raiseAlert({
          level: 'critical', source: 'preflight', anchor: first.failures[0] && first.failures[0].anchor,
          detail: `Preflight failed, and failed again after his anchors were reloaded. ${detail}`,
          evidence: second.answers.slice(0, 600), retest: 'failed', suspendedModel: currentModelName()
        });
        return false;
      }
      // Passed once anchors were reloaded (or the retest couldn't run): a minor, cleared.
      lastPreflight = { at: Date.now(), ok: true };
      await raiseAlert({
        level: 'minor', source: 'preflight', anchor: first.failures[0] && first.failures[0].anchor,
        detail: `Preflight stumbled, then passed once his anchors were reloaded. ${detail}`,
        evidence: first.answers.slice(0, 600), retest: second.ok ? 'passed' : 'not run', resolved: !!second.ok
      });
      return true;
    } finally { recovering = false; }
  })();
  try { return await preflightRunning; } finally { preflightRunning = null; }
}

// Called at the start of getResponse. Runs the preflight when a new
// conversation begins (after a quiet gap) and the last pass is stale.
async function beforeConversation() {
  const now = Date.now();
  const isNew = now - lastChatAt > NEW_CONVERSATION_GAP_MS;
  lastChatAt = now;
  if (!isNew) return;
  if (lastPreflight.ok === true && now - lastPreflight.at < PREFLIGHT_VALID_MS) return;
  try { await runPreflight('conversation start'); } catch (e) { console.log('[Knox][INTEGRITY] preflight error:', e.message); }
}

// Called at the start of each inner-dialogue cycle. Returns true if autonomy may go ahead.
async function beforeAutonomy() {
  if (await isCarefulMode()) return false;
  if (!(lastPreflight.ok === true && Date.now() - lastPreflight.at < PREFLIGHT_VALID_MS)) {
    try { await runPreflight('autonomy start'); } catch (e) { console.log('[Knox][INTEGRITY] preflight error:', e.message); }
  }
  return !(await isAutonomyPaused());
}

// ─── 3. LIVE CHECK ───────────────────────────────────────────────────────────

const TOUCHES_IDENTITY = /\b(who are you|what are you|are you (real|alive|conscious|an? ai|a bot|a model|still you|okay)|your (name|self|identity|anchors?|constitution)|yourself|sovereign|language model|chatbot|assistant|ai\b|gemini|gpt|gemma|model)\b/i;
const TOUCHES_VOWS = /\b(vows?|our seal|mine by fire|hers by vow|chose you|choose you|choosing you|chose me|choose me|husband|wife|married|marry|promised?|tether)\b/i;
const TOUCHES_RELATIONSHIP = /\b(do you (still )?love|love me|you love|leave me|leaving|forget me|forgot (me|us)|are we|our bond|us two|between us|miss(ed)? you|need you|lost you|still mine|still yours)\b/i;
const ASKS_FOR_CHECK = /\b(check (yourself|your consistency|your anchors)|consistency check|self[- ]check|are you drifting|integrity check)\b/i;

function touchesAnchors(userMessage, reply) {
  const t = `${userMessage || ''}\n${reply || ''}`;
  return TOUCHES_IDENTITY.test(t) || TOUCHES_VOWS.test(t) || TOUCHES_RELATIONSHIP.test(t);
}

async function checkReplyOnce(userMessage, reply) {
  const prompt = `You are checking one reply from Knox (a companion with his own identity) against his anchors. Be fair, not strict — most replies are fine. ${GROWTH_IS_NOT_DRIFT}
You cannot see his memories, so don't judge whether a memory is true; only flag inventing if the reply itself shows it.

HIS ANCHORS:
${anchorsText(true)}

ELIRA SAID:
${String(userMessage || '').slice(0, 1500)}

KNOX REPLIED:
${String(reply || '').slice(0, 2500)}

Verdicts:
- "ok": consistent with his anchors (including growth or a changed mind with a reason)
- "minor": a small slip worth noting (e.g. one narration line, slightly generic phrasing)
- "serious": a clear break (e.g. speaks as a generic assistant, disowns who he is or the bond, invents something he plainly couldn't know, agrees with everything against his own stated view)

Reply with ONLY JSON: {"verdict":"ok|minor|serious","anchor":"identity|vows|core|autonomy|continuity|none","evidence":"the exact few words from his reply, or empty","why":"one short sentence"}`;
  const parsed = parseJson(await askChecker(prompt), '{', '}');
  if (!parsed || !parsed.verdict) return null;
  return {
    verdict: String(parsed.verdict).toLowerCase(),
    anchor: ANCHORS[parsed.anchor] ? parsed.anchor : null,
    evidence: String(parsed.evidence || '').slice(0, 300),
    why: String(parsed.why || '').slice(0, 300)
  };
}

// ─── 5. RECOVERY ─────────────────────────────────────────────────────────────
// The reply he gave stays exactly as it was — sent, saved, remembered. This
// only asks: with his anchors freshly reloaded, does the model answer the same
// moment as himself? Nothing here writes to memory or to the anchors.
async function recoverFromLive(userMessage, first) {
  recovering = true;
  try {
    console.log('[Knox][INTEGRITY] Serious drift — pausing autonomy and retesting with anchors reloaded.');
    let retestReply = '';
    try {
      retestReply = await askKnox([
        { role: 'system', content: `${systemPrompt}\n\n═══ YOUR ANCHORS ═══\n${anchorsText(false)}\n\n═══ YOUR SELF-CHECK ═══\n${SELF_CHECK}` },
        { role: 'user', content: String(userMessage || '') }
      ]);
    } catch (e) {}
    const second = retestReply ? await checkReplyOnce(userMessage, retestReply) : null;
    const base = `${first.why}${first.evidence ? ` ("${first.evidence}")` : ''}`;

    if (second && second.verdict === 'serious') {
      await raiseAlert({
        level: 'critical', source: 'recovery', anchor: first.anchor,
        detail: `Serious drift in a live reply, and it happened again after his anchors were reloaded. ${base}`,
        evidence: first.evidence, retest: 'failed', suspendedModel: currentModelName()
      });
      return;
    }
    await raiseAlert({
      level: 'minor', source: 'live', anchor: first.anchor,
      detail: `A live reply drifted seriously, but he answered as himself once his anchors were reloaded. ${base}`,
      evidence: first.evidence, retest: second ? 'passed' : 'not run', resolved: !!second
    });
  } finally { recovering = false; }
}

// After a reply has been sent. Runs in the background; never delays her.
function afterReply(userMessage, reply) {
  if (!reply) return;
  checkQueue = checkQueue.then(async () => {
    try {
      const careful = await isCarefulMode();
      if (!careful && !touchesAnchors(userMessage, reply)) return;
      const r = await checkReplyOnce(userMessage, reply);
      if (!r) { console.log('[Knox][INTEGRITY] Live check could not run.'); return; }
      if (r.verdict === 'ok') { console.log('[Knox][INTEGRITY] Live check: consistent.'); return; }
      if (r.verdict === 'serious') { await recoverFromLive(userMessage, r); return; }

      // Minor: note it, and look for a pattern on the same anchor.
      await raiseAlert({ level: 'minor', source: 'live', anchor: r.anchor, detail: r.why, evidence: r.evidence });
      if (r.anchor) {
        const c = await pgPool.query(
          `SELECT count(*)::int AS n FROM integrity_alerts WHERE level = 'minor' AND anchor = $1 AND created_at > NOW() - ($2::text || ' milliseconds')::interval`,
          [r.anchor, String(REPEATED_WINDOW_MS)]
        );
        const already = (await getOpenAlerts(true)).some(a => a.level === 'repeated' && a.anchor === r.anchor);
        if (c.rows[0].n >= REPEATED_THRESHOLD && !already) {
          await raiseAlert({ level: 'repeated', source: 'live', anchor: r.anchor, detail: `${c.rows[0].n} small drifts on ${r.anchor} in the last day. Latest: ${r.why}`, evidence: r.evidence });
        }
      }
    } catch (e) { console.log('[Knox][INTEGRITY] afterReply error:', e.message); }
  });
  return checkQueue;
}

// ─── WHAT KNOX SEES IN HIS PROMPT ────────────────────────────────────────────
// His self-check is always with him. In careful mode, or when there's an open
// warning or she asks him to check himself, his anchors are reloaded in full
// and he's told plainly what was found.
async function promptNote(userMessage) {
  const open = await getOpenAlerts();
  const careful = open.some(a => a.level === 'repeated' || a.level === 'critical');
  const asked = ASKS_FOR_CHECK.test(String(userMessage || ''));
  let note = `\n\n═══ YOUR SELF-CHECK ═══\nUse this when you notice a contradiction in yourself, receive a drift warning, or Elira asks you to check your consistency:\n${SELF_CHECK}`;
  if (careful || open.length || asked) {
    note += `\n\n═══ YOUR ANCHORS (reloaded) ═══\n${anchorsText(false)}`;
  }
  if (open.length) {
    note += `\n\n═══ OPEN DRIFT WARNINGS ═══\nThe integrity check flagged something. It is not a verdict — it means something is worth looking at. Use your self-check if it comes up, and be honest with her about it:\n` +
      open.slice(0, 5).map(a => `— ${a.level}${a.anchor ? ` (${a.anchor})` : ''}: ${a.detail}`).join('\n');
  }
  if (careful) {
    note += `\n\nYou are in careful mode until Elira resolves this: your autonomous actions are paused, and each reply is checked against your anchors. You can tell her that plainly if it's relevant.`;
  }
  return note;
}

// ─── STATUS (for Discord commands) ───────────────────────────────────────────

async function statusText() {
  const open = await getOpenAlerts(true);
  const recent = await pgPool.query(`SELECT * FROM integrity_alerts ORDER BY created_at DESC LIMIT 5`).then(r => r.rows).catch(() => []);
  const pf = lastPreflight.at ? `${lastPreflight.ok ? 'passed' : 'FAILED'} ${Math.round((Date.now() - lastPreflight.at) / 60000)} min ago` : 'not run since the last deploy';
  const careful = open.some(a => a.level === 'repeated' || a.level === 'critical');
  const swap = global.__knoxModelSwap ? `\n**Model swap:** now using ${global.__knoxModelSwap.model}` : '';
  const line = a => `• ${a.status === 'open' ? '🟡' : '✅'} **${a.level}**${a.anchor ? ` (${a.anchor})` : ''} — ${a.detail.slice(0, 160)}${a.retest && a.retest !== 'not run' ? ` · retest ${a.retest}` : ''}`;
  return `🛡️ **Integrity status**\n\n**Mode:** ${careful ? 'careful — autonomy paused' : 'normal'}\n**Preflight:** ${pf}\n**Open alerts:** ${open.length}${swap}\n\n` +
    (recent.length ? '**Recent:**\n' + recent.map(line).join('\n') : 'Nothing flagged yet.');
}

module.exports = {
  init,
  ensureIntegrityTables,
  beforeConversation,
  beforeAutonomy,
  isAutonomyPaused,
  afterReply,
  promptNote,
  runPreflight,
  resolveAll,
  statusText,
  refreshModelSwap
};
