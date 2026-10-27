// Topic pages: turn a flat pile of memory notes into browsable, cross-linked topics.
//
// The idea is borrowed from A-MEM ("notes should grow links"), but implemented with plain
// Markdown and no model calls: every `## <date> <title>` block becomes an entry with derived
// metadata (date / title / mood / keywords), entries sharing keywords get cross-linked, and
// each topic gets its own page. Your original notes are never modified.
import fs from 'node:fs';
import path from 'node:path';
import { tokenize } from './recall.mjs';

const STOP = new Set(['的', '了', '是', '我', '他', '你', '在', '和', '就', '都', '也', '说', '着', '这', '那', '不', '一', '个', '有', '被', '给', '让', '把', '去', '来', '后', '前', '时候', '心情', 'the', 'and', 'for', 'that', 'with', 'this']);

/**
 * Parse `## <date> <title>` blocks from every .md file in `dir` (recursively, skipping `skip`).
 * Returns entries in date order.
 */
export function parseEntries(dir, { skip = ['node_modules', '.git', '.index', 'topics'] } = {}) {
  const root = path.resolve(dir);
  const files = [];
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (e.name.startsWith('.') || skip.includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) files.push(p);
    }
  };
  walk(root);

  const entries = [];
  for (const file of files) {
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = raw.split(/\r?\n/);
    let cur = null;
    const push = () => {
      if (!cur) return;
      const body = cur.body.join('\n').trim();
      if (body.length < 10) { cur = null; return; }
      const mood = (body.match(/（心情：([^）]*)）/) || body.match(/\(mood:\s*([^)]*)\)/))?.[1]?.trim() ?? '';
      const counts = new Map();
      for (const tok of tokenize(`${cur.title}\n${body}`)) {
        if (tok.length < 2 || STOP.has(tok)) continue;
        counts.set(tok, (counts.get(tok) || 0) + 1);
      }
      const titleTokens = new Set(tokenize(cur.title));
      const keywords = [...counts.entries()]
        .map(([k, v]) => [k, v + (titleTokens.has(k) ? 2 : 0)])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([k]) => k);
      entries.push({
        id: `${path.relative(root, file)}#L${cur.line}`,
        file: path.relative(root, file),
        line: cur.line,
        date: cur.date,
        title: cur.title,
        mood,
        keywords,
        excerpt: body.replace(/（心情：[^）]*）/g, '').replace(/\s+/g, ' ').trim().slice(0, 240),
      });
      cur = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^##\s+(?:(\d{4}-\d{2}-\d{2}|\d{1,2}-\d{2})\s+)?(.+)$/);
      if (m && lines[i].startsWith('## ')) {
        push();
        const raw = m[1] || '';
        const date = /^\d{1,2}-\d{2}$/.test(raw) ? `${new Date().getFullYear()}-${raw}` : raw;
        cur = { date, title: (m[2] || '').trim(), body: [], line: i + 1 };
        continue;
      }
      if (cur) cur.body.push(lines[i]);
    }
    push();
  }
  entries.sort((a, b) => (a.date === b.date ? a.line - b.line : a.date < b.date ? -1 : 1));
  return entries;
}

function scoreEntry(entry, keys) {
  let score = 0;
  for (const k of keys) {
    if (entry.title.includes(k)) score += 3;
    if (entry.excerpt.includes(k)) score += 1;
    if (entry.keywords.some((kw) => kw.includes(k) || k.includes(kw))) score += 1;
  }
  return score;
}

/**
 * Build topic pages under `<dir>/topics/` plus an index. Returns a summary object.
 * @param {object} o
 * @param {string} o.dir     memory folder
 * @param {{name:string, keys:string[]}[]} o.topics
 * @param {string} [o.outDir] defaults to `<dir>/topics`
 */
export function buildTopics({ dir, topics, outDir } = {}) {
  const root = path.resolve(dir);
  const out = path.resolve(outDir ?? path.join(root, 'topics'));
  const entries = parseEntries(root);
  for (const e of entries) e.topics = (topics || []).filter((t) => scoreEntry(e, t.keys) > 0).map((t) => t.name);

  const links = new Map();
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const shared = entries[i].keywords.filter((k) => entries[j].keywords.includes(k));
      if (shared.length < 2) continue;
      const a = entries[i].id;
      const b = entries[j].id;
      if (!links.has(a)) links.set(a, new Set());
      if (!links.has(b)) links.set(b, new Set());
      links.get(a).add(b);
      links.get(b).add(a);
    }
  }

  // 同主题的条目也算相关（比"共享两个字"更稳）
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const sharedTopic = (entries[i].topics || []).find((t) => (entries[j].topics || []).includes(t));
      if (!sharedTopic) continue;
      const a = entries[i].id;
      const b = entries[j].id;
      if (!links.has(a)) links.set(a, new Set());
      if (!links.has(b)) links.set(b, new Set());
      links.get(a).add(b);
      links.get(b).add(a);
    }
  }

  try { fs.mkdirSync(out, { recursive: true }); } catch {}
  const summary = [];
  for (const t of topics || []) {
    const list = entries.filter((e) => e.topics.includes(t.name));
    summary.push({ name: t.name, n: list.length });
    if (!list.length) continue;
    const lines = [`# ${t.name}`, '', `_${list.length} entries · generated ${new Date().toISOString().slice(0, 10)}_`, ''];
    for (const e of list) {
      lines.push(`## ${e.date ? e.date + ' ' : ''}${e.title}`, '', `> ${e.excerpt}`, '');
      const meta = [`source: \`${e.file}\` L${e.line}`];
      if (e.mood) meta.push(`mood: ${e.mood}`);
      lines.push(`- ${meta.join(' · ')}`);
      const rel = [...(links.get(e.id) || [])].slice(0, 3)
        .map((id) => entries.find((x) => x.id === id))
        .filter(Boolean)
        .map((x) => `\`${x.date} ${x.title}\``);
      if (rel.length) lines.push(`- related: ${rel.join('; ')}`);
      lines.push('');
    }
    fs.writeFileSync(path.join(out, `${t.name}.md`), lines.join('\n'), 'utf8');
  }

  const idx = ['# Topics', '', `_generated ${new Date().toISOString().slice(0, 10)}_`, ''];
  for (const s of summary.filter((x) => x.n > 0).sort((a, b) => b.n - a.n)) {
    idx.push(`- [${s.name}](./${s.name}.md) — ${s.n}`);
  }
  idx.push('', `> ${entries.length} entries · ${links.size} cross-linked`);
  fs.writeFileSync(path.join(out, 'README.md'), idx.join('\n'), 'utf8');

  return { entries, summary, outDir: out, linked: links.size };
}