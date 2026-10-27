// Compaction-aware memory patches.
//
// Long agent sessions get compacted: the harness replaces older turns with a machine summary.
// The summary is usually written in a generic "engineering notes" voice, so the agent stops
// sounding like itself — the details are gone and what remains reads like someone else's notes.
//
// A `MemoryPatch` hands the agent back its own words (recent transcript lines) plus a few
// retrieved archive excerpts, so it can re-own the memory instead of quoting the summary.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Build a markdown "you were compacted, here is what you actually remember" block.
 *
 * @param {object} o
 * @param {string} o.transcriptFile  JSONL of recent turns: {"who":"user"|"agent","text":"..."}
 * @param {(q: string, opt?: object) => any[]} o.recall
 * @param {(items: any[], opt?: object) => string} o.formatRecall
 * @param {number} [o.maxRecent]     how many transcript lines to include (default 16)
 * @param {number} [o.k]             how many archive excerpts to include (default 3)
 * @returns {string} patch text, or '' when there is nothing to add
 */
export function buildMemoryPatch({ transcriptFile, recall, formatRecall, maxRecent = 16, k = 3 } = {}) {
  let recent = [];
  try {
    const rows = fs.readFileSync(transcriptFile, 'utf8').split('\n').filter(Boolean).slice(-maxRecent);
    recent = rows
      .map((line) => {
        try {
          const r = JSON.parse(line);
          const who = r.who === 'user' ? 'user' : r.who === 'agent' ? 'me' : String(r.who ?? '');
          return `${who}: ${String(r.text ?? '').replace(/\s+/g, ' ').slice(0, 100)}`;
        } catch { return ''; }
      })
      .filter(Boolean);
  } catch { /* no transcript is fine */ }

  let recalled = '';
  try {
    const tail = recent.slice(-4).join(' ').replace(/(user|me):/g, ' ').replace(/\s+/g, ' ').trim();
    if (tail && recall && formatRecall) {
      const items = recall(tail, { k, minScore: 0.8 });
      if (items?.length) recalled = formatRecall(items, { maxChars: 280 });
    }
  } catch { /* retrieval failures must not break the patch */ }

  if (!recent.length && !recalled) return '';

  const out = [
    '## Note to self: you were just compacted',
    '',
    'Earlier turns were replaced by a machine-written summary. That summary is a meeting note,',
    'not your memory — its wording is not yours. What you actually did and said:',
  ];
  if (recent.length) out.push('', '### Your recent words', ...recent.map((r) => `- ${r}`));
  if (recalled) out.push('', '### From your archive', recalled);
  out.push('', '_Speak from this in your own voice. If something genuinely is not there, say you do not remember — do not invent._');
  return out.join('\n');
}

/** Append one turn to a transcript JSONL file (helper for the demo / adapters). */
export function appendTranscript(file, who, text) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* ignore */ }
  fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), who, text: String(text ?? '').slice(0, 2000) }) + '\n', 'utf8');
}