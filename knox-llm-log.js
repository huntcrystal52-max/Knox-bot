// knox-llm-log.js
// A quiet watcher on every call Knox makes to his language model. It changes
// nothing about how he behaves. It does two things:
//   1. Writes one short log line per call, naming WHICH part of Knox made it,
//      which model answered, how many tokens it used, and how long it took.
//      Failures (rate limits, blocked replies) get their own clear line.
//   2. Keeps running totals since the last deploy, for the "llm usage" command.
//
// It must be required FIRST in index.js (right after dotenv), because it wraps
// node-fetch before the other files pick it up. It never logs message text or keys.

const realFetch = require('node-fetch');

const stats = { since: Date.now(), byLabel: {}, byModel: {}, total: { calls: 0, errors: 0, prompt: 0, completion: 0 } };

function whoCalled() {
  const lines = String(new Error().stack || '').split('\n').slice(1);
  for (const l of lines) {
    if (l.includes('knox-llm-log')) continue;
    if (l.includes('node_modules') || l.includes('node:internal')) continue;
    const m = l.match(/at (?:async )?([^\s(]+) \(.*[\/\\]([^\/\\]+):(\d+):\d+\)/);
    if (m) return `${m[1]} (${m[2]}:${m[3]})`;
    const m2 = l.match(/at .*[\/\\]([^\/\\]+):(\d+):\d+/);
    if (m2) return `${m2[1]}:${m2[2]}`;
  }
  return 'unknown';
}

function bump(map, key, usage, failed) {
  const e = map[key] || (map[key] = { calls: 0, errors: 0, prompt: 0, completion: 0 });
  e.calls++; if (failed) e.errors++;
  e.prompt += usage.prompt; e.completion += usage.completion;
}

function record(label, model, usage, failed) {
  bump(stats.byLabel, label, usage, failed);
  bump(stats.byModel, model || 'unknown', usage, failed);
  stats.total.calls++; if (failed) stats.total.errors++;
  stats.total.prompt += usage.prompt; stats.total.completion += usage.completion;
}

function wrapped(url, opts) {
  const isLLM = typeof url === 'string' && /\/chat\/completions\/?$/.test(url);
  if (!isLLM) return realFetch(url, opts);

  const label = whoCalled();
  const started = Date.now();

  // Optional routing: tasks named in LLM_OLLAMA_TASKS (comma-separated, matched
  // against the label above) go to Ollama's flat-fee model instead of the main
  // one. Leave the setting empty and nothing is rerouted.
  const ollamaTasks = (process.env.LLM_OLLAMA_TASKS || '').split(',').map(t => t.trim()).filter(Boolean);
  if (ollamaTasks.length && process.env.OLLAMA_API_KEY && process.env.OLLAMA_MODEL && ollamaTasks.some(t => label.includes(t))) {
    try {
      const body = JSON.parse(opts.body);
      body.model = process.env.OLLAMA_MODEL;
      url = 'https://ollama.com/v1/chat/completions';
      opts = Object.assign({}, opts, {
        headers: Object.assign({}, opts.headers, { Authorization: 'Bearer ' + process.env.OLLAMA_API_KEY }),
        body: JSON.stringify(body)
      });
    } catch (e) { /* if anything is odd, leave the call as it was */ }
  }

  let model = 'unknown';
  try { model = JSON.parse(opts && opts.body).model || 'unknown'; } catch (e) {}

  return realFetch(url, opts).then(res => {
    try {
      res.clone().text().then(raw => {
        const ms = Date.now() - started;
        let d = null; try { d = JSON.parse(raw); } catch (e) {}
        const u = (d && d.usage) || {};
        const usage = { prompt: u.prompt_tokens || 0, completion: u.completion_tokens || 0 };
        const choice = d && d.choices && d.choices[0];
        const empty = !!choice && !(choice.message && (choice.message.content || choice.message.tool_calls));
        const failed = !res.ok || !choice || !!(d && d.error) || empty;
        record(label, model, usage, failed);
        if (failed) {
          const why = !res.ok ? `HTTP ${res.status}` : (d && d.error) ? 'error in reply' : empty ? `empty reply (finish: ${choice.finish_reason || '?'})` : 'no choices in reply';
          console.error(`[Knox][LLM] FAILED ${label} model=${model} ${why} ${ms}ms — ${raw.slice(0, 220).replace(/\s+/g, ' ')}`);
        } else {
          console.log(`[Knox][LLM] ${label} model=${model} in=${usage.prompt} out=${usage.completion} ${ms}ms`);
        }
      }).catch(() => {});
    } catch (e) {}
    return res;
  }, err => {
    record(label, model, { prompt: 0, completion: 0 }, true);
    console.error(`[Knox][LLM] FAILED ${label} model=${model} network error: ${err && err.message}`);
    throw err;
  });
}

// Keep everything else node-fetch offers (Headers, Response, default, ...)
Object.assign(wrapped, realFetch);
wrapped.default = wrapped;
try { require.cache[require.resolve('node-fetch')].exports = wrapped; } catch (e) { console.error('[Knox][LLM] could not attach watcher:', e.message); }

function fmt(n) { return Number(n || 0).toLocaleString('en-GB'); }

function usageReport() {
  const hrs = Math.max(0.01, (Date.now() - stats.since) / 3600000);
  const t = stats.total;
  const line = (name, e) => `• ${name}: ${e.calls} calls${e.errors ? ` (${e.errors} failed)` : ''}, in ${fmt(e.prompt)} / out ${fmt(e.completion)}`;
  const labels = Object.entries(stats.byLabel).sort((a, b) => (b[1].prompt + b[1].completion) - (a[1].prompt + a[1].completion)).slice(0, 12);
  const models = Object.entries(stats.byModel);
  return [
    `📈 **Model usage since the last deploy** (${hrs < 1 ? Math.round(hrs * 60) + ' min' : hrs.toFixed(1) + ' hrs'})`,
    '',
    `**Total:** ${t.calls} calls${t.errors ? `, ${t.errors} failed` : ''}`,
    `Tokens in: ${fmt(t.prompt)}  ·  out: ${fmt(t.completion)}`,
    `Average per hour: ${Math.round(t.calls / hrs)} calls, ~${fmt(Math.round((t.prompt + t.completion) / hrs))} tokens`,
    '',
    '**By model:**',
    ...(models.length ? models.map(([k, e]) => line(k, e)) : ['(nothing yet)']),
    '',
    '**Busiest parts of Knox:**',
    ...(labels.length ? labels.map(([k, e]) => line(k, e)) : ['(nothing yet)']),
    '',
    'Counts reset on every deploy. Tokens only show if the provider reports them.'
  ].join('\n');
}

module.exports = { usageReport, stats, _wrapped: wrapped };
