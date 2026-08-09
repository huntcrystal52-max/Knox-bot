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
  console.log('[Knox][GARDEN] Foundation laid — the lake is in place.');
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

async function generateGardenImage(sceneDescription) {
  try {
    // Pushed further after the previous attempt only partially worked —
    // "lake" alone still pulled strong lush-forest associations, so this
    // leans into stark, dry, undeveloped-lot framing to counteract it.
    const prompt = `A flat, mostly empty dirt lot, dry cracked earth and dust, like an undeveloped construction site before anything is built — bare and open under the sky. The only thing here: ${sceneDescription}. The entire rest of the ground is empty dirt and dust — no grass, no trees, no bushes, nothing green.`;
    const res = await fetch('https://fal.run/fal-ai/flux/dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Key ' + process.env.FAL_API_KEY },
      body: JSON.stringify({ prompt, image_size: 'landscape_16_9', num_images: 1, num_inference_steps: 28 })
    });
    const data = await res.json();
    if (data.images && data.images[0]) return data.images[0].url;
    console.log('[Knox][GARDEN] No image in response.');
    return null;
  } catch (e) { console.log('[Knox][GARDEN] Image generation error:', e.message); return null; }
}

async function updateGardenImage() {
  const sceneDescription = await buildSceneDescription();
  const imageUrl = await generateGardenImage(sceneDescription);
  if (imageUrl) {
    await pgPool.query(
      `INSERT INTO garden_meta (id, last_image_url, last_updated) VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET last_image_url = $1, last_updated = NOW()`,
      [imageUrl]
    );
  }
  return { imageUrl, sceneDescription };
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
  getAllPlantings,
  addPlanting,
  tendRandomPlanting,
  buildSceneDescription,
  generateGardenImage,
  updateGardenImage,
  getGardenMeta,
  incrementVisits
};
