# agent-memory-md

**Long-term memory for AI agents, stored as plain Markdown.**
BM25 recall, auto-built topic pages, and compaction-aware memory patches — no vector database, no server, no per-message LLM calls.

> 给 AI Agent 用的「Markdown 原生」长期记忆：BM25 召回、自动主题页、压缩后补记忆。
> **不装向量库、不跑服务、每轮不额外烧 token。**

---

## Why another memory layer?

Existing options (mem0, Zep, Letta, and friends) assume you want a **memory service**: a vector
store, an ingestion pipeline, and an LLM call per message to "extract facts". That is the right
tool for a product with thousands of users.

This library assumes something different: **your agent already writes its memory as Markdown**
(`CLAUDE.md`, `AGENTS.md`, an Obsidian vault, a folder of notes). What it lacks is not storage —
it is *finding the right paragraph again*. So instead of inventing a new store, it indexes the
files you already have:

| | agent-memory-md | mem0 / Zep / Letta |
| --- | --- | --- |
| Storage | your `.md` files | its own DB |
| Background process | none | yes |
| Cost per turn | **0** | an extraction call (+ retrieval) |
| Works offline | yes | depends |
| Understands meaning | BM25 (+ optional model rerank) | embeddings |
| Requires migrating notes | no | yes |

If your notes are plain text and your queries are concrete ("what did the boss order last time"),
lexical retrieval is enough — and it is free.

## Install

```bash
npm i agent-memory-md
```

…or just copy `src/` into your project — it is four files with zero dependencies.

## 30 seconds

```js
import { createMemory, formatRecall } from 'agent-memory-md';

const memory = createMemory({ dir: './memory' });      // a folder of .md files

const hits = memory.recallSmart('老板上次喝什么', { k: 3 });
// [{ rel: '老板这个人.md', line: 4, date: '2026-09-12', text: '老板只喝燕麦拿铁…', score: 5.08 }, ...]

if (hits.length) prompt += '\n\nWhat you remember:\n' + formatRecall(hits);
```

That is the whole integration. Everything else is optional.

## What you get

### 1. `recall` / `recallSmart` — retrieval that costs nothing

- **BM25** over Markdown chunks; Chinese is tokenised as **character bigrams**, so no segmenter is needed.
- Query-side **synonym table** (you control it) and **topic-term expansion**.
- **Pseudo-relevance feedback**: the first pass votes for extra terms, then a weighted second pass merges both.
- Pure computation: ~20 ms to index 600 KB of notes, < 50 ms per query, no network.

### 2. `buildTopics` — topic pages and cross-links (A-MEM, but as Markdown)

Every `## <date> <title>` block becomes an entry with derived metadata (date, mood, keywords).
Entries that share keywords **or belong to the same topic** get cross-linked, and each topic gets
a browsable page. **Your original notes are never modified** — pages land in `<dir>/topics/`.

```bash
memory-md topics --dir ./memory --topics ./topics.config.mjs
```

### 3. `buildMemoryPatch` — what to do when the context gets compacted

Long sessions get compacted, and the harness usually replaces old turns with a machine summary.
The agent then reads a summary written in someone else's voice and loses the details.

A patch hands the agent back **its own words**: the last N transcript lines plus a few retrieved
archive excerpts, framed as *"you were compacted — this is what you actually said"*.

```js
const patch = buildMemoryPatch({ transcriptFile: './turns.jsonl', recall: memory.recallSmart, formatRecall });
// → "## Note to self: you were just compacted … ### Your recent words … ### From your archive …"
```

### 4. `rerankMemory` — optional, for questions that share no words

"Does he actually enjoy hanging out with me?" never matches a note that says
"he teases me, that means he is relaxed" — no shared characters at all.
Local recall cannot bridge that; a model can. Pass any `complete(prompt)` function:

```js
import { rerankMemory, openAiCompatibleComplete } from 'agent-memory-md';

const complete = openAiCompatibleComplete({
  baseURL: 'https://api.deepseek.com', apiKey: process.env.API_KEY, model: 'deepseek-chat',
});
const candidates = memory.recall(q, { k: 12, minScore: 0.3 });
const picks = await rerankMemory({ query: q, candidates, complete });
```

Call it **only when local recall is weak** (`hits.length < 2`) — ~2 s and a few hundred tokens,
occasionally, instead of on every turn.

## CLI

```bash
memory-md index  --dir ./memory
memory-md recall "老板喝什么咖啡" --dir ./memory --smart -k 2
memory-md topics --dir ./memory --topics ./topics.config.mjs
memory-md patch  --dir ./memory --transcript ./turns.jsonl
```

## Measured on a real corpus

5.7 万字中文记忆（112 chunks / 81 dated entries），20 条由真实对话里抽出来的问题：

| | BM25 | + topic terms + PRF |
| --- | --- | --- |
| Concrete questions ("上次考试", "14 条额度", "群聊开关") | **20/20** | **20/20** |
| Vague questions ("他是不是其实挺喜欢跟我玩") | ✗ | ✓ (with `rerankMemory`) |

Two negative results worth knowing:

- **Rewriting the query with an LLM did not help.** The rewritten words ("likes me / spends time with
  me") are just as absent from the notes as the original phrase.
- **Raising `k` hurt precision** more often than it helped recall; 3–5 is the sweet spot for prompts.

Details and the reasoning in [`docs/why-no-vector-db.md`](./docs/why-no-vector-db.md).

## Conventions

```
memory/
├─ <anything>.md          # notes; "## 2026-09-12 title" blocks become entries
├─ .index/index.json      # generated (gitignore this)
└─ topics/                # generated topic pages (optional to commit)
```

- The parser reads `## <date> <title>` blocks; `（心情：…）` (or `(mood: …)`) is picked up as mood.
- Your notes are read-only to this library.

## Roadmap

- [ ] optional BM25 score normalisation for hybrid reranking
- [ ] pluggable tokenizer (Japanese/Korean bigrams, jieba loader)
- [ ] `memory-md serve` (read-only local HTTP API) — for languages that cannot import Node

## License

MIT