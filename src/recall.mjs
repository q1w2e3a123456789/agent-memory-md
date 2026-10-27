// BM25 recall over a folder of Markdown files.
//
// Design notes
// - Chinese text is tokenised into character bigrams, so no tokeniser/segmenter is needed.
// - A small synonym table + "topic terms" (see topics.mjs) expand the query.
// - Pseudo-relevance feedback (PRF) re-ranks with terms taken from the first pass.
// Everything is local: no embeddings, no server, no API calls.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_SKIP = ['node_modules', '.git'];
const K1 = 1.2;
const B = 0.75;

/** Generic Chinese/English tokeniser: latin words + CJK character bigrams. */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const tokens = [];
  for (const m of s.matchAll(/[a-z][a-z0-9_.-]{1,24}/g)) tokens.push(m[0]);
  for (const m of s.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0];
    if (run.length === 1) { tokens.push(run); continue; }
    for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2));
    if (run.length <= 2) tokens.push(run);
  }
  return tokens;
}

function walk(dir, skip, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || skip.includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, skip, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(p);
  }
  return out;
}

function dateOf(text, filePath) {
  const m = String(text).match(/20\d{2}-\d{2}-\d{2}|\b\d{1,2}-\d{2}\b/);
  if (m) return m[0];
  const fm = path.basename(filePath).match(/20\d{2}-\d{2}-\d{2}/);
  return fm ? fm[0] : '';
}

function chunkFile(filePath, { maxChunk }) {
  let raw = '';
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
  const lines = raw.split(/\r?\n/);
  const chunks = [];
  let heading = '';
  let buf = [];
  let bufStart = 1;
  let inFrontmatter = lines[0]?.trim() === '---';

  const flush = () => {
    const text = buf.join('\n').trim();
    buf = [];
    if (text.length < 24) return;
    chunks.push({
      f: filePath,
      l: bufStart,
      h: heading,
      d: dateOf(text, filePath) || dateOf(heading, filePath),
      t: text,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inFrontmatter) {
      if (i > 0 && line.trim() === '---') inFrontmatter = false;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      flush();
      heading = line.replace(/^#{1,6}\s*/, '').trim();
      bufStart = i + 2;
      continue;
    }
    buf.push(line);
    if (buf.join('\n').length >= maxChunk) flush();
  }
  flush();
  return chunks;
}

/**
 * Create a memory store bound to a directory.
 * @param {object} o
 * @param {string} o.dir                    folder containing .md memory files
 * @param {[string,string[]][]} [o.synonyms] query-side synonym expansion
 * @param {{name:string, keys:string[]}[]} [o.topics] topic definitions (see topics.mjs)
 * @param {string[]} [o.skip]               directory names to ignore
 * @param {number} [o.maxChunk]             max characters per chunk (default 420)
 */
export function createMemory({ dir, synonyms = [], topics = [], skip = DEFAULT_SKIP, maxChunk = 420 } = {}) {
  if (!dir) throw new Error('createMemory: `dir` is required');
  const root = path.resolve(dir);
  const indexDir = path.join(root, '.index');
  const indexFile = path.join(indexDir, 'index.json');
  let cached = null;
  let cachedAt = 0;

  function build() {
    const files = walk(root, [...skip, '.index', 'topics'].flat());
    const chunks = [];
    for (const f of files) {
      for (const c of chunkFile(f, { maxChunk })) {
        const tf = Object.create(null);
        for (const tok of tokenize(`${c.h}\n${c.t}`)) tf[tok] = (tf[tok] || 0) + 1;
        let dl = 0;
        for (const k in tf) dl += tf[k];
        if (!dl) continue;
        chunks.push({ ...c, dl, tf });
      }
    }
    const df = Object.create(null);
    for (const c of chunks) for (const k in c.tf) df[k] = (df[k] || 0) + 1;
    const index = {
      v: 1,
      builtAt: new Date().toISOString(),
      n: chunks.length,
      avgdl: chunks.reduce((s, c) => s + c.dl, 0) / Math.max(1, chunks.length),
      df,
      chunks,
    };
    try { fs.mkdirSync(indexDir, { recursive: true }); } catch {}
    fs.writeFileSync(indexFile, JSON.stringify(index), 'utf8');
    cached = index;
    cachedAt = Date.now();
    return index;
  }

  function index({ force = false, maxAgeMs = 6 * 3600 * 1000 } = {}) {
    if (!force && cached && Date.now() - cachedAt < maxAgeMs) return cached;
    if (!force) {
      try {
        const st = fs.statSync(indexFile);
        if (Date.now() - st.mtimeMs < maxAgeMs) {
          cached = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
          cachedAt = Date.now();
          return cached;
        }
      } catch { /* rebuild below */ }
    }
    return build();
  }

  function expandQuery(query) {
    let q = String(query ?? '');
    for (const [key, alts] of synonyms) {
      if (q.includes(key) || (alts || []).some((a) => a && q.includes(a))) q += ' ' + (alts || []).join(' ');
    }
    return q;
  }

  /** Plain BM25 recall. */
  function recall(query, { k = 3, minScore = 0.5, idx = null } = {}) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    const ix = idx || index();
    const qSet = [...new Set(tokenize(expandQuery(q)))];
    if (!qSet.length) return [];
    const N = Math.max(1, ix.n);
    const avgdl = ix.avgdl || 1;
    const scored = [];
    for (const c of ix.chunks) {
      let score = 0;
      let hit = 0;
      for (const tok of qSet) {
        const tf = c.tf[tok];
        if (!tf) continue;
        const df = ix.df[tok] || 1;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + B * (c.dl / avgdl)));
        hit++;
      }
      if (!hit) continue;
      const bonus = qSet.length > 1 ? 1 + (0.35 * (hit - 1)) / (qSet.length - 1) : 0.8;
      const final = score * bonus;
      if (final >= minScore) scored.push({ ...c, score: final });
    }
    scored.sort((a, b) => b.score - a.score);
    const out = [];
    for (const c of scored) {
      if (out.some((o) => o.f === c.f && Math.abs(o.l - c.l) < 6)) continue;
      out.push(c);
      if (out.length >= k) break;
    }
    return out.map((c) => ({
      file: c.f,
      rel: path.relative(root, c.f),
      line: c.l,
      heading: c.h,
      date: c.d,
      text: c.t,
      score: Number(c.score.toFixed(2)),
    }));
  }

  function topicTerms(query) {
    const q = String(query ?? '');
    const out = [];
    for (const t of topics) {
      for (const k of t.keys || []) if (k && q.includes(k)) out.push(k);
      if (q.includes(t.name)) out.push(t.name);
    }
    return [...new Set(out)].slice(0, 6);
  }

  /** BM25 + topic-term expansion + pseudo-relevance feedback, merged with weights. */
  function recallSmart(query, { k = 3, minScore = 0.5, idx = null } = {}) {
    const ix = idx || index();
    const base = recall(query, { k: k * 3, minScore, idx: ix });
    const extras = [...topicTerms(query)];
    if (base.length) {
      const freq = new Map();
      for (const c of base) for (const tok of tokenize(c.text)) if (tok.length >= 2) freq.set(tok, (freq.get(tok) || 0) + 1);
      extras.push(...[...freq.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t));
    }
    if (!extras.length) return base.slice(0, k);
    const wide = recall(`${query} ${[...new Set(extras)].join(' ')}`, { k: k * 3, minScore, idx: ix });
    const merged = new Map();
    for (const it of base) merged.set(`${it.file}#${it.line}`, { ...it });
    for (const it of wide) {
      const key = `${it.file}#${it.line}`;
      const add = it.score * 0.6;
      const prev = merged.get(key);
      if (prev) prev.score += add;
      else merged.set(key, { ...it, score: add });
    }
    return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, k);
  }

  return { dir: root, index, build, recall, recallSmart, tokenize, topicTerms };
}

/** Compact one-line-per-hit formatting, suitable for a prompt. */
export function formatRecall(items, { maxChars = 320 } = {}) {
  if (!items?.length) return '';
  return items
    .map((it) => {
      const where = `${it.rel}${it.date ? ` · ${it.date}` : ''}`;
      return `- ${it.text.replace(/\s+/g, ' ').slice(0, maxChars)}  (${where})`;
    })
    .join('\n');
}