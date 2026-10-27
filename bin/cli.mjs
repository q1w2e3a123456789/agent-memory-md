#!/usr/bin/env node
// memory-md — tiny CLI for markdown-native agent memory.
//
//   memory-md index   --dir ./memory
//   memory-md recall  "last exam" --dir ./memory [-k 3] [--smart]
//   memory-md topics  --dir ./memory [--topics ./topics.config.mjs]
//   memory-md patch   --dir ./memory --transcript ./turns.jsonl
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMemory, formatRecall } from '../src/recall.mjs';
import { buildTopics } from '../src/topics.mjs';
import { buildMemoryPatch } from '../src/compaction.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name, def = '') => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};

const dir = opt('--dir', './memory');
const k = Number(opt('-k', '3')) || 3;
const topicsFile = opt('--topics', '');

let topics = [];
if (topicsFile) {
  const mod = await import(pathToFileURL(path.resolve(topicsFile)).href);
  topics = mod?.topics ?? mod?.default?.topics ?? mod?.default ?? [];
}

const memory = createMemory({ dir, topics });

switch (cmd) {
  case 'index': {
    const idx = memory.build();
    console.log(`indexed ${idx.n} chunks -> ${path.join(dir, '.index', 'index.json')}`);
    break;
  }
  case 'recall': {
    const query = argv[1] && !argv[1].startsWith('-') ? argv[1] : opt('--query', '');
    if (!query) { console.error('usage: memory-md recall "your query" --dir ./memory'); process.exit(1); }
    const smart = argv.includes('--smart');
    const items = smart ? memory.recallSmart(query, { k }) : memory.recall(query, { k });
    if (!items.length) { console.log('(no match)'); break; }
    for (const it of items) {
      console.log(`\n[${it.score}] ${it.rel}${it.date ? ' · ' + it.date : ''}  (L${it.line})`);
      console.log(it.text.replace(/\s+/g, ' ').slice(0, 400));
    }
    break;
  }
  case 'topics': {
    const r = buildTopics({ dir, topics });
    console.log(`topics: ${r.summary.filter((t) => t.n).length} pages, ${r.entries.length} entries, ${r.linked} cross-linked`);
    for (const t of r.summary.sort((a, b) => b.n - a.n)) if (t.n) console.log(`  ${t.name}: ${t.n}`);
    memory.build();   // keep the recall index in sync
    break;
  }
  case 'patch': {
    const transcript = opt('--transcript', '');
    if (!transcript) { console.error('usage: memory-md patch --dir ./memory --transcript ./turns.jsonl'); process.exit(1); }
    const patch = buildMemoryPatch({
      transcriptFile: path.resolve(transcript),
      recall: (q, o) => memory.recallSmart(q, o),
      formatRecall,
    });
    console.log(patch || '(nothing to patch)');
    break;
  }
  default:
    console.log(`memory-md — markdown-native memory for AI agents

  memory-md index   --dir ./memory
  memory-md recall  "query" --dir ./memory [-k 3] [--smart]
  memory-md topics  --dir ./memory [--topics ./topics.config.mjs]
  memory-md patch   --dir ./memory --transcript ./turns.jsonl
`);
}