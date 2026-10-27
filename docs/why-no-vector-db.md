# Why no vector database (and when you should add one)

This library retrieves from Markdown with BM25. That is a deliberate choice, not a shortcut.
Here is the reasoning, the measurements behind it, and the point at which you should graduate
to embeddings.

## The claim

For a personal agent with **tens of thousands of characters** of notes and **concrete questions**,
lexical retrieval is already near-perfect, and it costs nothing. Embeddings buy you robustness on
*vague* questions — which you can buy much more cheaply by letting a model look at the candidates.

## Measurements (Chinese, 5.7e4 chars, 112 chunks)

Twenty questions taken from real conversation, each with a ground-truth note:

| Question | BM25 | BM25 + topic terms + PRF |
| --- | --- | --- |
| 上次考试考得咋样 | ✓ | ✓ |
| 每天 14 条额度 | ✓ | ✓ |
| 群聊开关怎么关 | ✓ | ✓ |
| … (17 more concrete ones) | ✓ | ✓ |
| 他是不是其实挺喜欢跟我玩 | ✗ | ✗ (needs a model) |
| 他哪次不高兴了 | ✗ | ~ |

Concrete questions: **20/20 in both configurations**. So the first question to ask is not
"which retriever?" but "what kind of questions does my agent actually get?".

## Three negative results

1. **LLM query rewriting does not fix semantic gaps.** Asked to expand
   "他是不是其实挺喜欢跟我玩", a model produced *喜欢 / 陪我 / 一起玩 / 依赖 / 亲近 / 舍不得*.
   None of those words appear in the note that actually answers the question
   ("他损我 = 他放松" — he teases me, that means he is relaxed). Rewriting just swaps one
   absent vocabulary for another.

2. **Bigger `k` is not better.** Retrieving 10 chunks instead of 3 mostly added noise to the
   prompt. Precision at 3 was consistently the best trade for a chat turn.

3. **Character bigram keywords produce noisy "related" links** — two notes sharing `心情`
   (mood) looked related. Excluding boilerplate words and also linking entries by *topic
   membership* was what actually made the topic pages useful.

## What actually worked for vague questions

Show the model the candidates and let it judge:

```
You are helping a chat agent recall its own past. Here are candidate notes …
Pick only the notes that actually help answer it (at most 3).
```

On the same corpus, this surfaced the right notes ("he sent the same sticker twice to tease me",
"he liked it when I copied his dialect") for questions BM25 could not touch. Cost: one small
completion (**~1.5k tokens, ~2 s**) and only when local recall returns fewer than two hits.

That is why `rerankMemory` is optional and gated: it is the *exception* path, not the hot path.

## The cost table

| Approach | RAM | Latency | Money | Works offline |
| --- | --- | --- | --- | --- |
| BM25 (this library) | ~0 | < 50 ms | 0 | yes |
| + model rerank on weak recall | 0 (HTTP call) | ~2 s, rare | ~¥0.001 / call | no |
| Embedding model, resident (small, 95 MB) | +200–400 MB | 10–30 ms | 0 | yes |
| Embedding model, resident (bge-m3, 2.3 GB) | +2.5–3 GB | 200–500 ms | 0 | yes |
| Vector service (mem0/Zep/Letta) | process + DB | 50–300 ms | extraction call per turn | no |

On a 14 GB laptop, the small embedding model is affordable (+6 % RAM). The reason not to bother
here is not memory — it is that **the measured gain over BM25 at this corpus size was ~0**, while
the rerank path already covers the gap.

## When you *should* add embeddings

Add them when two or more of these are true:

1. Notes exceed ~2e5 characters (BM25 starts missing rather than merely mis-ranking).
2. Your questions are relational or emotional ("when was he most annoyed with me?") rather than
   factual.
3. You see "I know we wrote this down but I cannot find it" more than a few times a week.
4. You need cross-lingual recall (ask in English, notes in Chinese).

When you do, run **hybrid** (BM25 + vector, reciprocal rank fusion) rather than replacing BM25 —
lexical search still wins on names, numbers, and exact quotes.

## Design invariants

- **Never modify the user's notes.** Derived data goes to `.index/` and `topics/`.
- **Never call a model on the read path by default.** Latency in a chat turn is a product decision.
- **Fail open.** Every retrieval path returns `[]` on error; the agent keeps talking without memory.