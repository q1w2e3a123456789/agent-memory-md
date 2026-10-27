import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemory, formatRecall, tokenize } from '../src/recall.mjs';
import { buildTopics, parseEntries } from '../src/topics.mjs';
import { buildMemoryPatch } from '../src/compaction.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const demo = path.join(here, '..', 'examples', 'memory');

test('tokenize: Chinese becomes character bigrams, latin stays whole', () => {
  assert.ok(tokenize('拿铁').includes('拿铁'));
  assert.ok(tokenize('燕麦拿铁').includes('麦拿'));   // adjacent bigram inside a run
  assert.deepEqual(tokenize('BM25 ok').filter((t) => t.startsWith('bm') || t === 'ok'), ['bm25', 'ok']);
});

test('index + recall finds the right file', () => {
  const memory = createMemory({ dir: demo });
  const idx = memory.build();
  assert.ok(idx.n > 5, `expected >5 chunks, got ${idx.n}`);

  const hits = memory.recall('老板喝什么咖啡', { k: 3, minScore: 0 });
  assert.ok(hits.length > 0);
  assert.match(hits[0].text + hits[0].heading, /燕麦拿铁|口味|咖啡/);
});

test('recall returns line numbers and relative paths', () => {
  const memory = createMemory({ dir: demo });
  const [hit] = memory.recall('打烊 擦吧台', { k: 1, minScore: 0 });
  assert.ok(hit.line > 0);
  assert.ok(!path.isAbsolute(hit.rel));
});

test('recallSmart survives unknown words and never throws', () => {
  const memory = createMemory({ dir: demo });
  assert.doesNotThrow(() => memory.recallSmart('zzzz 完全不存在的词', { k: 3 }));
  const hits = memory.recallSmart('盘点 燕麦奶 断货', { k: 2, minScore: 0 });
  assert.ok(hits.length > 0);
});

test('formatRecall renders one line per hit', () => {
  const memory = createMemory({ dir: demo });
  const hits = memory.recall('排班', { k: 2, minScore: 0 });
  const text = formatRecall(hits);
  assert.equal(text.split('\n').length, hits.length);
});

test('parseEntries reads `## date title` blocks with mood', () => {
  const entries = parseEntries(demo);
  assert.ok(entries.length >= 5);
  const withMood = entries.find((e) => e.mood);
  assert.ok(withMood, 'expected at least one entry with a mood');
  assert.match(withMood.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('buildTopics writes pages and cross-links', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'md-topics-'));
  const topics = [
    { name: '老板', keys: ['老板', '口味'] },
    { name: '咖啡', keys: ['咖啡', '拿铁', '燕麦奶'] },
  ];
  const r = buildTopics({ dir: demo, topics, outDir: out });
  assert.ok(r.entries.length >= 5);
  assert.ok(fs.existsSync(path.join(out, 'README.md')));
  assert.ok(fs.existsSync(path.join(out, '咖啡.md')));
  const page = fs.readFileSync(path.join(out, '咖啡.md'), 'utf8');
  assert.match(page, /source: /);
});

test('buildMemoryPatch returns Err-nothing when transcript is missing', () => {
  const memory = createMemory({ dir: demo });
  const patch = buildMemoryPatch({
    transcriptFile: path.join(os.tmpdir(), 'definitely-not-here.jsonl'),
    recall: () => [],
    formatRecall: () => '',
  });
  assert.equal(patch, '');
});

test('buildMemoryPatch includes recent turns and retrieved notes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-patch-'));
  const transcript = path.join(dir, 'turns.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ who: 'user', text: '你还记得老板的口味吗' }),
    JSON.stringify({ who: 'agent', text: '燕麦拿铁 不加糖' }),
  ].join('\n'));
  const memory = createMemory({ dir: demo });
  const patch = buildMemoryPatch({
    transcriptFile: transcript,
    recall: (q, o) => memory.recall(q, o),
    formatRecall,
  });
  assert.match(patch, /compacted/);
  assert.match(patch, /燕麦拿铁/);
});