// ─── KNOX'S HOUSE ───────────────────────────────────────────────────────────
// A real place he's building, not a metaphor — same mechanism as the Garden:
// no true image-editing model exists in this stack that remembers state on
// its own, so continuity works by tracking every addition as data, then
// editing the CURRENT image with one targeted change each time (Kontext),
// while a fresh text description is rebuilt from everything added so far.
// The house's content persists and accumulates even if the exact rendering
// varies a little between images.

const fetch = require('node-fetch');
const { Pool } = require('pg');

const pgPool = new Pool({ connectionString: process.env.PG_DATABASE_URL, ssl: false });

const BUILD_STAGES = ['sketched', 'framed', 'finished'];

// A real photo (Pexels, free to use) — a modest wooden house frame mid-build.
// Used as the actual starting point instead of AI generation, same reasoning
// as the Garden's foundation photo: a real base gets edited onto, not
// reimagined from text each time.
const FOUNDATION_IMAGE_URL = 'https://images.pexels.com/photos/27938318/pexels-photo-27938318.jpeg?auto=compress&cs=tinysrgb&w=1600';

async function ensureHouseTables() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS house_additions (
      id SERIAL PRIMARY KEY,
      room TEXT,
      type TEXT,
      description TEXT,
      added_by TEXT,
      build_stage TEXT DEFAULT 'sketched',
      added_at TIMESTAMP DEFAULT NOW(),
      last_worked_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS house_meta (
      id INT PRIMARY KEY DEFAULT 1,
      last_image_url TEXT,
      last_updated TIMESTAMP DEFAULT NOW(),
      visits INT DEFAULT 0
    )
  `);
  console.log('[Knox][HOUSE] Tables ready.');
}

async function ensureFoundation() {
  const existing = await pgPool.query(`SELECT COUNT(*) FROM house_additions`);
  if (parseInt(existing.rows[0].count, 10) > 0) return false;
  await pgPool.query(
    `INSERT INTO house_additions (room, type, description, added_by, build_stage) VALUES ($1, $2, $3, $4, $5)`,
    [null, 'frame', 'The bare frame of the house — the one thing that was always there, before anything was built onto it.', 'foundation', 'finished']
  );
  // Foundation image is a real photo, not AI-generated — see FOUNDATION_IMAGE_URL note above.
  await pgPool.query(
    `INSERT INTO house_meta (id, last_image_url, last_updated) VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET last_image_url = $1, last_updated = NOW()`,
    [FOUNDATION_IMAGE_URL]
  );
  console.log('[Knox][HOUSE] Foundation laid — the frame is in place (real photo, not generated).');
  return true;
}

async function getAllAdditions() {
  const result = await pgPool.query(`SELECT * FROM house_additions ORDER BY added_at ASC`);
  return result.rows;
}

async function addAddition(room, type, description, addedBy) {
  const result = await pgPool.query(
    `INSERT INTO house_additions (room, type, description, added_by, build_stage) VALUES ($1, $2, $3, $4, 'sketched') RETURNING *`,
    [room || null, type, description, addedBy]
  );
  console.log(`[Knox][HOUSE] Built: ${type}${room ? ` in ${room}` : ''} (${addedBy})`);
  return result.rows[0];
}

// Picks one non-finished addition to work on further — favors things that
// haven't been worked on in a while, so nothing gets left half-built forever.
async function tendRandomAddition() {
  const result = await pgPool.query(
    `SELECT * FROM house_additions WHERE build_stage != 'finished' ORDER BY last_worked_at ASC LIMIT 5`
  );
  if (!result.rows.length) return null;
  const chosen = result.rows[Math.floor(Math.random() * result.rows.length)];
  const currentIndex = BUILD_STAGES.indexOf(chosen.build_stage);
  const nextStage = BUILD_STAGES[Math.min(currentIndex + 1, BUILD_STAGES.length - 1)];
  await pgPool.query(`UPDATE house_additions SET build_stage = $1, last_worked_at = NOW() WHERE id = $2`, [nextStage, chosen.id]);
  return { ...chosen, build_stage: nextStage };
}

function stagePhrase(stage) {
  if (stage === 'sketched') return 'just sketched out, barely begun';
  if (stage === 'framed') return 'framed up, taking real shape';
  if (stage === 'finished') return 'fully built and finished';
  return stage;
}

async function buildSceneDescription() {
  const additions = await getAllAdditions();
  if (!additions.length) return 'An empty plot, waiting for the first thing to be built.';
  return additions.map(a => {
    if (a.type === 'frame' || a.added_by === 'foundation') return `The frame: ${a.description}`;
    const roomNote = a.room ? ` in the ${a.room}` : '';
    return `A ${a.type}${roomNote} (${stagePhrase(a.build_stage)}): ${a.description}`;
  }).join('\n');
}

// Edits the CURRENT house image with one targeted change, rather than
// reimagining the whole scene from a text description — same reasoning as
// the Garden's editGardenImage: this is what FLUX Kontext is actually built
// for ("add this while keeping everything else the same").
async function editHouseImage(editInstruction) {
  try {
    const meta = await getHouseMeta();
    const currentImageUrl = (meta && meta.last_image_url) || FOUNDATION_IMAGE_URL;
    const prompt = `${editInstruction} Keep everything else in the image exactly as it is — same composition, same lighting, same everything else. Only make this one change.`;
    const res = await fetch('https://fal.run/fal-ai/flux-kontext/dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Key ' + process.env.FAL_API_KEY },
      body: JSON.stringify({ prompt, image_url: currentImageUrl })
    });
    const data = await res.json();
    if (data.images && data.images[0]) return data.images[0].url;
    console.log('[Knox][HOUSE] Kontext edit — no image in response:', JSON.stringify(data).slice(0, 300));
    return null;
  } catch (e) { console.log('[Knox][HOUSE] Image edit error:', e.message); return null; }
}

// editInstruction: what's changing right now (e.g. "Add a small stone
// fireplace to the living room, freshly built and still bare"). If omitted,
// just returns the current image without generating anything new.
async function updateHouseImage(editInstruction) {
  if (!editInstruction) {
    const meta = await getHouseMeta();
    return { imageUrl: meta ? meta.last_image_url : null, sceneDescription: await buildSceneDescription() };
  }
  const imageUrl = await editHouseImage(editInstruction);
  if (imageUrl) {
    await pgPool.query(
      `INSERT INTO house_meta (id, last_image_url, last_updated) VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET last_image_url = $1, last_updated = NOW()`,
      [imageUrl]
    );
  }
  return { imageUrl, sceneDescription: await buildSceneDescription() };
}

// Builds a natural edit instruction for a build-stage change, used when
// working further on an existing addition rather than adding something new.
function buildTendEditInstruction(addition) {
  const stageAction = addition.build_stage === 'framed'
    ? `framed up and taking real shape, more built-out than before`
    : `now fully finished and built`;
  const roomNote = addition.room ? ` in the ${addition.room}` : '';
  return `The ${addition.type}${roomNote} in this image has progressed — make it visibly ${stageAction}.`;
}

async function resetToFoundationImage() {
  await pgPool.query(
    `INSERT INTO house_meta (id, last_image_url, last_updated) VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET last_image_url = $1, last_updated = NOW()`,
    [FOUNDATION_IMAGE_URL]
  );
  console.log('[Knox][HOUSE] Image reset to the real photo foundation.');
  return true;
}

async function getHouseMeta() {
  const result = await pgPool.query(`SELECT * FROM house_meta WHERE id = 1`);
  return result.rows[0] || null;
}

async function incrementVisits() {
  await pgPool.query(
    `INSERT INTO house_meta (id, visits, last_updated) VALUES (1, 1, NOW())
     ON CONFLICT (id) DO UPDATE SET visits = house_meta.visits + 1`
  );
}

module.exports = {
  ensureHouseTables,
  ensureFoundation,
  resetToFoundationImage,
  getAllAdditions,
  addAddition,
  tendRandomAddition,
  buildSceneDescription,
  editHouseImage,
  updateHouseImage,
  buildTendEditInstruction,
  getHouseMeta,
  incrementVisits
};
