# Measured performance

`pnpm bench 1000` on 2026-11-06: one laptop, local PostgreSQL, 1000 synthetic messages, no network or provider latency. A starting point for SLOs, not a production measurement.

Ingestion (parse, scan, encrypt, classify, store): **43 messages/s**, one worker.

| Operation | p50 ms | p95 ms |
|---|---|---|
| Inbox page (50 threads) | 24 | 36 |
| Focus | 37 | 81 |
| Search, one term | 30 | 38 |
| Search, field + filter | 32 | 42 |
| Open thread | 3 | 6 |

Semantic search, measured separately on 2026-11-07, on the same kind of laptop with other work running, so treat these as rough. `semantic-search.bench.test.ts` and `semantic-search.real.test.ts`, with `--silent=false`:

| Operation | Result |
|---|---|
| Whole `listThreads` call at the bound: 5,000 sealed 384-dimension vectors selected under RLS, opened, ranked, merged, 20 rows hydrated | median about 500 to 570 ms, slowest of 7 about 2.5 s |
| Real model, one short message | 3.5 to 5 ms |
| Real model, first load from disk | about 0.7 s, on a thread |
| Memory, for each process that has loaded the model | Resident size about 240 MB higher after loading, about 270 MB after 200 embeddings. Mostly native, so `maxOldGenerationSizeMb` doesn't limit it |

That's a linear scan of decrypted vectors, on every search, on the web process's CPU, so it's the cost of keeping vectors sealed and it grows with the bound. It holds for one search at a time and hasn't been load tested. The bound is what stops it getting worse.
