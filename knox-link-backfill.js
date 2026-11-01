// knox-link-backfill.js
// ─── LINKING HIS OLDER MEMORIES ──────────────────────────────────────────────
// New conversations are linked as they happen. This goes back through the
// memories that came before, one at a time, and lets Knox decide which earlier
// memories each one genuinely connects to — exactly the same way, with his
// reason stored on the link.
//
// Slow on purpose: by default 90 memories an hour on the flat-fee Ollama
// model. It steps aside while Elira is chatting, and while the integrity
// protocol has autonomy paused. Progress lives on the memories themselves
// (links_checked_at), so a deploy or a pause never loses its place. Whether
// it's running is kept in Postgres, so it carries on after a redeploy.
//
// It only ever ADDS links. It never changes or deletes a memory.

const { Pool } = require('pg');
const neo4jMemory = require('./knox-neo4j');
const integrity = require('./knox-integrity');

const pgPool = new Pool({ connectionString: process.env.PG_DATABASE_URL, ssl: false });

const PER_HOUR = Math.max(10, Math.min(600, parseInt(process.env.LINK_BACKFILL_PER_HOUR, 10) || 90));
const STEP_MS = Math.round(3600000 / PER_HOUR);

let timer = null;
let busy = false;
let isChatting = () => false;
let session = { since: null, checked: 0, links: 0, failures: 0 };

async function ensureTables() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS link_backfill_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      running BOOLEAN NOT NULL DEFAULT false,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    )
  `);
  await pgPool.query(`INSERT INTO link_backfill_state (id, running) VALUES (1, false) ON CONFLICT (id) DO NOTHING`);
}

async function isRunning() {
  const r = await pgPool.query(`SELECT running FROM link_backfill_state WHERE id = 1`);
  return !!(r.rows[0] && r.rows[0].running);
}

async function setRunning(on, finished) {
  await pgPool.query(
    `UPDATE link_backfill_state SET running = $1,
       started_at = CASE WHEN $1 THEN NOW() ELSE started_at END,
       finished_at = CASE WHEN $2 THEN NOW() ELSE finished_at END
     WHERE id = 1`, [on, !!finished]);
}

async function step() {
  if (busy) return;
  busy = true;
  try {
    if (!(await isRunning())) { stopTimer(); return; }
    if (isChatting()) return;                              // she's here — step aside
    if (await integrity.isAutonomyPaused()) return;       // careful mode — wait

    const mem = await neo4jMemory.nextUncheckedMemory();
    if (!mem) {
      await setRunning(false, true);
      stopTimer();
      console.log(`[Knox][BACKFILL] Finished — every older memory has been looked at. (${session.links} links made this run.)`);
      return;
    }
    const made = await neo4jMemory.backfillOne(mem);
    if (made === null) {
      session.failures++;
      console.log('[Knox][BACKFILL] Model gave no usable answer — will try that memory again later.');
      return;
    }
    session.checked++;
    session.links += made;
    if (made) console.log(`[Knox][BACKFILL] ${String(mem.createdAt || '').slice(0, 10)} memory → ${made} link(s).`);
    if (session.checked % 25 === 0) console.log(`[Knox][BACKFILL] Progress: ${session.checked} looked at, ${session.links} links made this run.`);
  } catch (e) {
    session.failures++;
    console.log('[Knox][BACKFILL] step error:', e.message);
  } finally { busy = false; }
}

function startTimer() {
  if (timer) return;
  timer = setInterval(step, STEP_MS);
}
function stopTimer() {
  if (timer) { clearInterval(timer); timer = null; }
}

// Called once on start-up: picks up where it left off if it was running.
async function init(opts) {
  if (opts && typeof opts.isConversationActive === 'function') isChatting = opts.isConversationActive;
  await ensureTables();
  if (await isRunning()) {
    session = { since: Date.now(), checked: 0, links: 0, failures: 0 };
    startTimer();
    console.log(`[Knox][BACKFILL] Resuming the backfill of older memory links (${PER_HOUR}/hour).`);
  }
}

async function start() {
  await setRunning(true, false);
  session = { since: Date.now(), checked: 0, links: 0, failures: 0 };
  startTimer();
  setTimeout(step, 2000);
}

async function pause() {
  await setRunning(false, false);
  stopTimer();
}

async function statusText() {
  const running = await isRunning();
  const c = await neo4jMemory.backfillCounts();
  const left = c.mainLeft + c.archivalLeft;
  const hours = left / PER_HOUR;
  const eta = hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min` : hours < 48 ? `${Math.round(hours)} hours` : `${Math.round(hours / 24)} days`;
  const why = !running ? '' : isChatting() ? ' (stepping aside while you\'re chatting)' : (await integrity.isAutonomyPaused()) ? ' (waiting — integrity has autonomy paused)' : '';
  return `🕸️ **Backfilling older memory links**\n\n` +
    `**State:** ${running ? 'running' : (left ? 'paused' : 'finished')}${why} · ${PER_HOUR} memories/hour\n` +
    `**Looked at:** ${c.done.toLocaleString('en-GB')}\n` +
    `**Still to go:** ${c.mainLeft.toLocaleString('en-GB')} main memories, then ${c.archivalLeft.toLocaleString('en-GB')} archival` +
    (left && running ? `\n**Roughly:** ${eta} at this pace` : '') +
    (session.since ? `\n**Since last start/deploy:** ${session.checked} looked at, ${session.links} links made${session.failures ? `, ${session.failures} retries` : ''}` : '') +
    `\n\nCommands: \`backfill links start\` · \`backfill links pause\` · \`backfill links status\` · \`memory links\` to see the latest links.`;
}

module.exports = { init, start, pause, statusText };
