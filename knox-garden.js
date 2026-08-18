// ─── KNOX'S GARDEN ──────────────────────────────────────────────────────────
// A real visual place, not a metaphor — a lake, trees, flowers, tended over
// time by Knox and Elira together. No true image-editing exists in this
// stack, so continuity works by tracking everything planted as data, then
// describing the FULL current state fresh each time an image is generated —
// the garden's content persists and accumulates even if the exact rendering
// varies a little between images.

const fetch = require('node-fetch');
const { Pool } = require('pg');

const pgPool = new Pool({ connectionString: process.env.PG_DATABASE_URL, ssl: false });

const GROWTH_STAGES = ['seedling', 'growing', 'flourishing'];

// A real photo (Pexels, free to use) — aerial shot of a pond surrounded by
// grass and farmland, no forest. Used as the actual starting point instead
// of AI generation, after four straight attempts all defaulted to lush
// forest regardless of technique. Everything planted after this point is
// edited onto this real base using image-to-image, not reimagined from text.
const FOUNDATION_IMAGE_URL = 'https://images.pexels.com/photos/27985283/pexels-photo-27985283.jpeg?auto=compress&cs=tinysrgb&w=1600';

async function ensureGardenTables() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS garden_plantings (
      id SERIAL PRIMARY KEY,
      type TEXT,
      description TEXT,
      planted_by TEXT,
      growth_stage TEXT DEFAULT 'seedling',
      planted_at TIMESTAMP DEFAULT NOW(),
      last_tended_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS garden_meta (
      id INT PRIMARY KEY DEFAULT 1,
      last_image_url TEXT,
      last_updated TIMESTAMP DEFAULT NOW(),
      visits INT DEFAULT 0
    )
  `);
  console.log('[Knox][GARDEN] Tables ready.');
}

async function ensureFoundation() {
  const existing = await pgPool.query(`SELECT COUNT(*) FROM garden_plantings`);
  if (parseInt(existing.rows[0].count, 10) > 0) return false;
  await pgPool.query(
    `INSERT INTO garden_plantings (type, description, planted_by, growth_stage) VALUES ($1, $2, $3, $4)`,
    ['lake', 'A still, clear lake at the heart of the garden — the one thing that was always there, before anything was planted.', 'foundation', 'flourishing']
  );
  // Foundation image is a real photo, not AI-generated — see FOUNDATION_IMAGE_URL note above.
  await pgPool.query(
    `INSERT INTO garden_meta (id, last_image_url, last_updated) VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET last_image_url = $1, last_updated = NOW()`,
    [FOUNDATION_IMAGE_URL]
  );
  console.log('[Knox][GARDEN] Foundation laid — the lake is in place (real photo, not generated).');
  return true;
}

async function getAllPlantings() {
  const result = await pgPool.query(`SELECT * FROM garden_plantings ORDER BY planted_at ASC`);
  return result.rows;
}

async function addPlanting(type, description, plantedBy) {
  const result = await pgPool.query(
    `INSERT INTO garden_plantings (type, description, planted_by, growth_stage) VALUES ($1, $2, $3, 'seedling') RETURNING *`,
    [type, description, plantedBy]
  );
  console.log(`[Knox][GARDEN] Planted: ${type} (${plantedBy})`);
  return result.rows[0];
}

// Picks one non-flourishing planting to grow — favors things that haven't
// been tended in a while, so nothing gets left behind forever.
async function tendRandomPlanting() {
  const result = await pgPool.query(
    `SELECT * FROM garden_plantings WHERE growth_stage != 'flourishing' ORDER BY last_tended_at ASC LIMIT 5`
  );
  if (!result.rows.length) return null;
  const chosen = result.rows[Math.floor(Math.random() * result.rows.length)];
  const currentIndex = GROWTH_STAGES.indexOf(chosen.growth_stage);
  const nextStage = GROWTH_STAGES[Math.min(currentIndex + 1, GROWTH_STAGES.length - 1)];
  await pgPool.query(`UPDATE garden_plantings SET growth_stage = $1, last_tended_at = NOW() WHERE id = $2`, [nextStage, chosen.id]);
  return { ...chosen, growth_stage: nextStage };
}

function stagePhrase(stage) {
  if (stage === 'seedling') return 'just planted, still tender and new';
  if (stage === 'growing') return 'taking root, growing steadily';
  if (stage === 'flourishing') return 'fully grown and flourishing';
  return stage;
}

async function buildSceneDescription() {
  const plantings = await getAllPlantings();
  if (!plantings.length) return 'An empty stretch of bare ground, waiting for the first thing to be planted.';
  return plantings.map(p => {
    if (p.type === 'lake' || p.planted_by === 'foundation') return `The lake: ${p.description}`;
    return `A ${p.type} (${stagePhrase(p.growth_stage)}): ${p.description}`;
  }).join('\n');
}

// Edits the CURRENT garden image with one targeted change, rather than
// reimagining the whole scene from a text description — this is what
// FLUX Kontext is actually built for ("add this while keeping everything
// else the same"), and it's the fix for four straight text-to-image
// attempts all defaulting to lush regardless of wording.
async function editGardenImage(editInstruction) {
  try {
    const meta = await getGardenMeta();
    const currentImageUrl = (meta && meta.last_image_url) || FOUNDATION_IMAGE_URL;
    const prompt = `${editInstruction} Keep everything else in the image exactly as it is — same composition, same lighting, same everything else. Only make this one change.`;
    const res = await fetch('https://fal.run/fal-ai/flux-kontext/dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Key ' + process.env.FAL_API_KEY },
      body: JSON.stringify({ prompt, image_url: currentImageUrl })
    });
    const data = await res.json();
    if (data.images && data.images[0]) return data.images[0].url;
    console.log('[Knox][GARDEN] Kontext edit — no image in response:', JSON.stringify(data).slice(0, 300));
    return null;
  } catch (e) { console.log('[Knox][GARDEN] Image edit error:', e.message); return null; }
}

// editInstruction: what's changing right now (e.g. "Add a small newly-
// planted willow sapling near the water's edge, tender and small"). If
// omitted, just returns the current image without generating anything new —
// there's nothing to show that isn't already shown.
async function updateGardenImage(editInstruction) {
  if (!editInstruction) {
    const meta = await getGardenMeta();
    return { imageUrl: meta ? meta.last_image_url : null, sceneDescription: await buildSceneDescription() };
  }
  const imageUrl = await editGardenImage(editInstruction);
  if (imageUrl) {
    await pgPool.query(
      `INSERT INTO garden_meta (id, last_image_url, last_updated) VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET last_image_url = $1, last_updated = NOW()`,
      [imageUrl]
    );
  }
  return { imageUrl, sceneDescription: await buildSceneDescription() };
}

// Builds a natural edit instruction for a growth-stage change, used when
// tending an existing planting rather than adding something new.
function buildTendEditInstruction(planting) {
  const stageAction = planting.growth_stage === 'growing'
    ? `taking root and growing fuller than before`
    : `now fully grown and flourishing`;
  return `The ${planting.type} in this image has grown — make it visibly ${stageAction}, larger and more developed than its current state.`;
}

async function resetToFoundationImage() {
  await pgPool.query(
    `INSERT INTO garden_meta (id, last_image_url, last_updated) VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET last_image_url = $1, last_updated = NOW()`,
    [FOUNDATION_IMAGE_URL]
  );
  console.log('[Knox][GARDEN] Image reset to the real photo foundation.');
  return true;
}

async function getGardenMeta() {
  const result = await pgPool.query(`SELECT * FROM garden_meta WHERE id = 1`);
  return result.rows[0] || null;
}

async function incrementVisits() {
  await pgPool.query(
    `INSERT INTO garden_meta (id, visits, last_updated) VALUES (1, 1, NOW())
     ON CONFLICT (id) DO UPDATE SET visits = garden_meta.visits + 1`
  );
}

module.exports = {
  ensureGardenTables,
  ensureFoundation,
  resetToFoundationImage,
  getAllPlantings,
  addPlanting,
  tendRandomPlanting,
  buildSceneDescription,
  editGardenImage,
  updateGardenImage,
  buildTendEditInstruction,
  getGardenMeta,
  incrementVisits
};
