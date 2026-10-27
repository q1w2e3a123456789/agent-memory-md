// Optional: let a model pick the relevant memories instead of trusting BM25 scores.
//
// Why this exists: BM25 (and embeddings, in practice) cannot bridge phrases that share no
// words — "does he actually enjoy hanging out with me" never matches a note that says
// "he teases me, that means he's relaxed". Rewriting the query does not help either (the
// rewritten words are just as absent). What does work: show the model the candidates and
// ask which ones answer the question. That is ~2 s and a few hundred tokens, so it is worth
// doing only when local recall is weak.
//
// This module is model-agnostic: you pass a `complete(prompt) -> Promise<string>` function.
// See README for wiring it to OpenAI / Ollama / a local agent runtime.
import fs from 'node:fs';

/**
 * @param {object} o
 * @param {string} o.query
 * @param {{text:string}[]} o.candidates   ordered candidates (12 or fewer is plenty)
 * @param {(prompt: string) => Promise<string>} o.complete
 * @param {number} [o.pick]                how many to keep (default 3)
 * @returns {Promise<number[]>} chosen indices (0-based); [] on failure
 */
export async function rerankMemory({ query, candidates, complete, pick = 3 } = {}) {
  const q = String(query ?? '').trim().slice(0, 240);
  const list = (candidates || []).slice(0, 14);
  if (!q || list.length < 2 || typeof complete !== 'function') return [];
  const body = list.map((c, i) => `${i + 1}. ${String(c.text ?? c.excerpt ?? '').replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');
  const prompt = [
    'You are helping a chat agent recall its own past. Below are candidate notes from its memory.',
    `The agent was asked: "${q}"`,
    `Pick only the notes that actually help answer it (at most ${pick}; if none fit, output 0).`,
    'Output the numbers only, space separated (e.g. "3 7"). No explanation.',
    '',
    body,
  ].join('\n');

  let text = '';
  try {
    text = String(await complete(prompt) ?? '');
  } catch {
    return [];
  }
  if (/^\s*0\s*$/.test(text)) return [];
  const idx = [...new Set((text.match(/\d+/g) || []).map((n) => Number(n) - 1))]
    .filter((n) => n >= 0 && n < list.length)
    .slice(0, pick);
  return idx;
}

/**
 * Convenience adapter: an OpenAI-compatible chat completion endpoint.
 * Works with OpenAI, DeepSeek, Qwen, Ollama (/v1), LM Studio, vLLM, ...
 */
export function openAiCompatibleComplete({ baseURL, apiKey, model, maxTokens = 60 }) {
  return async (prompt) => {
    const res = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: maxTokens,
      }),
    });
    if (!res.ok) throw new Error(`completion HTTP ${res.status}`);
    const json = await res.json();
    return json?.choices?.[0]?.message?.content ?? '';
  };
}

/** Read the last N lines of a JSONL transcript (helper). */
export function readTranscript(file, n = 16) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}