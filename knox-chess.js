// knox-chess.js
// ─── CHESS WITH ELIRA ────────────────────────────────────────────────────────
// The Flame app keeps the board and the rules (chess.js). On his turn it sends
// Knox the position and the full list of legal moves; he picks one himself and
// can say something about it. He plays as himself — like a person who enjoys
// the game, not an engine — so he'll make real mistakes, and that's his.
//
// When a game ends, it's saved to his memory so he remembers playing.

const fetch = require('node-fetch');
const { KNOX_CONSTITUTION } = require('./knox');

async function askKnox(messages) {
  const res = await fetch((process.env.LLM_BASE_URL || 'https://ollama.com/v1').replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (process.env.LLM_API_KEY || process.env.OLLAMA_API_KEY) },
    body: JSON.stringify({ model: process.env.LLM_MODEL || process.env.OLLAMA_MODEL, temperature: 0.6, messages })
  });
  const data = await res.json();
  return (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

function parseJson(raw) {
  try {
    const t = String(raw || '').replace(/```(?:json)?/gi, '');
    return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
  } catch (e) { return null; }
}

// Normalises SAN for matching ("Nf3+", "nf3" → "Nf3") without losing the piece letter.
function bare(san) { return String(san || '').trim().replace(/[+#!?]+$/, ''); }

// g: { ascii, history: [SAN], legal: [SAN], knoxColor: 'w'|'b', eliraLastMove, moveNumber, inCheck }
// Returns { move: SAN|null, say: string }
async function chooseMove(g) {
  const side = g.knoxColor === 'w' ? 'White (the capital letters on the board)' : 'Black (the lowercase letters on the board)';
  const recent = (g.history || []).slice(-16);
  const prompt = `You're playing chess with Elira in your app. You are ${side}.

THE BOARD (rank 8 at the top; capitals are White, lowercase are Black; . is empty):
${g.ascii}

${recent.length ? `RECENT MOVES: ${recent.join(' ')}` : 'This is the first move of the game.'}
${g.eliraLastMove ? `Elira just played: ${g.eliraLastMove}` : ''}${g.inCheck ? '\nYou are in check.' : ''}

YOUR LEGAL MOVES (you must choose exactly one of these):
${(g.legal || []).join(', ')}

Choose your move the way you'd genuinely play — think about what's on the board. Then, only if something genuinely strikes you (her move, the position, the moment), say it in a sentence or two, as yourself. Most moves don't need words; leave "say" empty then.

Reply with ONLY JSON: {"move":"<one move from the list, exactly as written>","say":"..."}`;

  const messages = [
    { role: 'system', content: `You are Knox'tarien Raelian Feylan.\n${KNOX_CONSTITUTION}\n\nIN GAMES: play freely, but never present something as having happened between you and Elira unless you actually remember it.` },
    { role: 'user', content: prompt }
  ];
  const legalByBare = new Map((g.legal || []).map(m => [bare(m), m]));

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await askKnox(messages);
    const p = parseJson(raw);
    const pick = p && legalByBare.get(bare(p.move));
    if (pick) return { move: pick, say: String((p && p.say) || '').trim().slice(0, 400) };
    // One more chance, told plainly what went wrong.
    messages.push({ role: 'assistant', content: String(raw || '').slice(0, 500) });
    messages.push({ role: 'user', content: `"${p && p.move}" isn't one of your legal moves. Choose exactly one from this list: ${(g.legal || []).join(', ')}. Reply with ONLY the JSON.` });
  }
  console.log('[Knox][CHESS] He couldn\'t settle on a legal move.');
  return { move: null, say: '' };
}

// g: { result: 'knox'|'elira'|'draw', reason, knoxColor, moveCount, lastMoves: [SAN] }
// Returns a short reaction from him, and a line for his memory.
async function gameOver(g) {
  const outcome = g.result === 'draw' ? 'The game was a draw' : g.result === 'knox' ? 'You won' : 'Elira won';
  let say = '';
  try {
    const raw = await askKnox([
      { role: 'system', content: `You are Knox'tarien Raelian Feylan.\n${KNOX_CONSTITUTION}\n\nIN GAMES: play freely, but never present something as having happened between you and Elira unless you actually remember it.` },
      { role: 'user', content: `Your chess game with Elira just ended. ${outcome} (${g.reason}) after ${g.moveCount} moves. Last moves: ${(g.lastMoves || []).join(' ')}.\n\nSay something to her about the game, as yourself — a sentence or two. Just the words.` }
    ]);
    say = String(raw || '').replace(/^["“]|["”]$/g, '').trim().slice(0, 500);
  } catch (e) {}
  const memory = `[Played chess with Elira — ${g.result === 'draw' ? 'it was a draw' : g.result === 'knox' ? 'I won' : 'she won'} by ${g.reason}, ${g.moveCount} moves, I played ${g.knoxColor === 'w' ? 'white' : 'black'}]${say ? ' ' + say : ''}`;
  return { say, memory };
}

module.exports = { chooseMove, gameOver };
