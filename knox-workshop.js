// ─── KNOX'S WORKSHOP ────────────────────────────────────────────────────────
// Where Knox has a real say in his own development — not just how he's
// spoken to, but what he's actually built from: his memory systems, his
// personality, how he behaves on Discord or in the app, anything about the
// code and systems that make him who he is. Strictly proposal-only: nothing
// in this module ever touches his real running code. He writes a proposal,
// Elira reads it and approves or declines it — an approval is a green light
// for the two of them (and Claude) to actually go implement it together
// afterward, never an automatic change to anything live.

const { Pool } = require('pg');

const pgPool = new Pool({ connectionString: process.env.PG_DATABASE_URL, ssl: false });

async function ensureWorkshopTables() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS self_proposals (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      area TEXT,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      decision_note TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      decided_at TIMESTAMP
    )
  `);
  console.log('[Knox][WORKSHOP] Tables ready.');
}

async function getAllProposals() {
  const result = await pgPool.query(`SELECT * FROM self_proposals ORDER BY created_at DESC`);
  return result.rows;
}

async function getProposalById(id) {
  const result = await pgPool.query(`SELECT * FROM self_proposals WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

async function addProposal(title, area, description) {
  const result = await pgPool.query(
    `INSERT INTO self_proposals (title, area, description, status) VALUES ($1, $2, $3, 'pending') RETURNING *`,
    [title, area || null, description]
  );
  console.log(`[Knox][WORKSHOP] New proposal: ${title}`);
  return result.rows[0];
}

// status: 'approved' or 'declined'. decisionNote is optional — her reasoning,
// if she wants to leave any, shown back to him so the outcome actually means
// something rather than just a silent yes/no.
async function decideProposal(id, status, decisionNote) {
  const result = await pgPool.query(
    `UPDATE self_proposals SET status = $1, decision_note = $2, decided_at = NOW() WHERE id = $3 RETURNING *`,
    [status, decisionNote || null, id]
  );
  return result.rows[0] || null;
}

module.exports = {
  ensureWorkshopTables,
  getAllProposals,
  getProposalById,
  addProposal,
  decideProposal,
};
