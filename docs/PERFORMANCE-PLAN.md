# Performance Improvement Plan — dsh-evolution

## Change Classification
**Cross-module feature + refactor.** Touches `store.ts`, `auto-experience/index.ts`, `builder/tools.ts`. No public API contract changes; no schema migration. Single-process runtime (no concurrency risk).

## Evidence Base

| Bottleneck | Evidence | Impact |
|---|---|---|
| `listExperiences()` does `readdir + stat + readFile` per file, no cache | `fsx.ts:69-77`: `stat()` on every entry; called 4×/cycle | ~16K syscalls/cycle at 500 experiences |
| `listExperiencesByVersion()` calls `listExperiences(limit*10)` then filters client-side | `store.ts:214` | Double I/O for version-filtered queries |
| LLM prompt unbounded | `builder/tools.ts:691-699`: `patternSummary` + `recentFailures` not truncated | Token cost grows with experience count |
| `runAutoCycle()` fires on every turn add | `auto-experience/index.ts:571`: `void runAutoCycle(deps)` in `.then()` | Analysis runs even when no new patterns |

**Non-goals:**
- Optimizing the LLM call itself (network-bound, outside plugin control)
- Changing persistence format (backward-compatibility break)
- Parallelizing the auto-cycle (single-threaded JS event loop)

**Must-not-regress:**
- All 681 existing passing tests
- `evo_observe_state` return shape (field names)
- `pruneExperiences()` semantics (TTL + cap order)
- Atomic write contract (no partial writes)

---

## Dependency Graph

```
Card A (store cache) ──┬──▶ Card B (listExperiencesByVersion opt)
                       │
                       └──▶ Card C (prompt compression)
Card D (cycle debounce) [independent]
Card E (batch write)    [after A — touches store write path]
```

- A must ship first: all other cards depend on a cached store.
- B and C are independent of each other but both depend on A.
- D is fully independent — can run in parallel with A.
- E depends on A (cache invalidation must cover batch writes).

---

## Work Cards

---

### Card A — In-memory store cache for list operations

**Why:** Every `listExperiences()` call does `readdir + stat + readFile` for every file. In a typical auto-cycle this happens 4 times (lines 353, 365, 410, 510 of `auto-experience/index.ts`). At 500 experiences that's ~6,000 stat syscalls per cycle.

**Depends on:** none

**Owns:** `src/host/store.ts` (+ tests)

**Must not change:**
- Public method signatures (`listExperiences`, `listPatterns`, etc.)
- Return shape or ordering
- `pruneExperiences()` semantics
- Atomic write contract

**Behavior/invariant:**
- Cache key = `(method, limit)` → `Promise<result[]>`
- TTL = 5 seconds (configurable via private const)
- Invalidation triggers: `addExperience()`, `addPattern()`, `addCandidate()`, `addBenchmark()`, `pruneExperiences()`, `createVersion()`, `rollbackVersion()`
- Stale reads after invalidation are OK (5s window); correctness is preserved because all writers use `writeJsonAtomic`

**Implementation constraints:**
- Cache is instance-scoped (one `EvolutionStore` instance = one cache)
- Use `Map<string, { ts: number; value: ExperienceRecord[] }>` — simple, no external deps
- `getCache(key)` returns cached value if `Date.now() - ts < TTL` else null
- `setCache(key, value)` stores with current timestamp
- `invalidate()` clears all entries
- Call `invalidate()` at end of every mutation method

**Acceptance evidence:**
```bash
npx vitest run test/lib.spec.ts test/activation.spec.ts test/tools.spec.ts test/auto-experience.spec.ts
# All 79 tests must pass
```
Plus new tests:
- `test/store-cache.spec.ts`: cache hit returns same result within TTL
- `test/store-cache.spec.ts`: cache invalidates after `addExperience()`
- `test/store-cache.spec.ts`: cache miss after TTL expiry

**Rollback/recovery:** Pure addition — removing the cache code reverts to previous behavior. No data loss risk.

**Integration handoff:** Cards B and C depend on this card's cached store interface.

**Parallel-safe with:** Card D

---

### Card B — `listExperiencesByVersion` filesystem-level filter

**Why:** Currently calls `listExperiences(limit * 10)` (full readdir+stat+readFile) then filters client-side. With cache from Card A, this becomes a cheap in-memory filter — but without the cache it doubles I/O. Post-cache, this still saves one redundant `listExperiences` call in the degradation path.

**Depends on:** Card A

**Owns:** `src/host/store.ts` (+ tests)

**Must not change:**
- Return shape or ordering
- `listExperiences()` signature or behavior

**Behavior/invariant:**
- After Card A lands, `listExperiences()` is cached, so `listExperiencesByVersion()` can safely call it without double-I/O penalty
- No filesystem-level optimization needed post-cache (cache makes it O(1) lookup)
- If cache miss, falls back to existing behavior (read all, filter client-side)

**Implementation constraints:**
- Minimal change: just ensure `listExperiencesByVersion()` uses the cached `listExperiences()` result
- No new filesystem calls needed — the cache handles it

**Acceptance evidence:**
```bash
npx vitest run test/check6-liveCycle.spec.ts test/p12-degradation.spec.ts
# Degradation and evidence-chain tests must pass
```
Plus new test:
- `listExperiencesByVersion` returns only records matching the version ID
- `listExperiencesByVersion` respects the limit param

**Rollback/recovery:** Safe — cache fallback preserves existing behavior.

**Integration handoff:** None (terminal card).

**Parallel-safe with:** Card C

---

### Card C — LLM prompt compression

**Why:** `buildUserPrompt()` at `builder/tools.ts:691` includes full `patternSummary` (all patterns) and up to 10 `recentFailures`. With 50+ patterns and 10 failures, this can easily exceed 3000 chars — wasting tokens and increasing LLM latency.

**Depends on:** Card A

**Owns:** `src/host/modules/builder/tools.ts` (+ tests)

**Must not change:**
- `callHostLLM()` signature
- `evo_builder_generate` tool parameters
- Response parsing logic
- What patterns/experiences are selected (top-by-confidence still applies)

**Behavior/invariant:**
- `patternSummary`: cap at top-5 patterns by confidence (was: all patterns)
- `recentFailures`: cap at 5 (was: 10), clamp each line to 120 chars
- Total prompt size target: ≤ 2000 chars (down from unbounded)

**Implementation constraints:**
- Sort patterns by `confidence` descending before slicing to top 5
- Apply `clampText(line, 120)` to each failure line
- Document the compression in a comment on `buildUserPrompt`

**Acceptance evidence:**
```bash
npx vitest run test/tools.spec.ts test/builder-parser.spec.ts test/builder-llm-call.spec.ts
```
Plus new test:
- `buildUserPrompt` output length ≤ 2000 chars with 50 patterns and 20 failures
- Top-5 patterns by confidence are included
- Failure lines are clamped to 120 chars

**Rollback/recovery:** Revert `buildUserPrompt` to previous implementation. No data impact.

**Integration handoff:** None (terminal card).

**Parallel-safe with:** Card B

---

### Card D — Auto-cycle debounce / coalescing

**Why:** `runAutoCycle()` is fire-and-forget on every `addExperience()` (line 571). If the operator rapidly adds experiences (e.g., bulk import), multiple cycles could queue up. The `guards.inFlight` check prevents true concurrency, but doesn't prevent sequential waste.

**Depends on:** none (independent)

**Owns:** `src/host/modules/auto-experience/index.ts` (+ tests)

**Must not change:**
- `runAutoCycle()` logic
- `guards` shape
- Tool return values

**Behavior/invariant:**
- Add a `lastCycleAt` timestamp to guards
- If `Date.now() - lastCycleAt < 2000ms`, skip the cycle (debounce window)
- `lastCycleAt` is updated only when the cycle actually runs (`slotConsumed = true`)
- This is a soft optimization — never blocks or drops experiences

**Implementation constraints:**
- Add `lastCycleAt: number` to the `guards` object (default `0`)
- Check at top of `runAutoCycle()`, after existing `inFlight` check
- Update `guards.lastCycleAt = Date.now()` when cycle commits (`slotConsumed = true`)

**Acceptance evidence:**
```bash
npx vitest run test/auto-experience.spec.ts
```
Plus new test:
- Two rapid `addExperience()` calls within 2s debounce window: second cycle skipped
- Cycle that runs updates `lastCycleAt`

**Rollback/recovery:** Remove the debounce check — existing behavior restored. No data impact.

**Integration handoff:** None.

**Parallel-safe with:** Cards A, B, C

---

### Card E — Batch experience writes

**Why:** Each `addExperience()` does a separate `writeJsonAtomic` (write tmp + rename). During bulk operations or rapid turns, this creates N file system operations. Batching reduces I/O.

**Depends on:** Card A (cache invalidation must cover batch writes)

**Owns:** `src/host/store.ts` (+ `src/lib/fsx.ts`) (+ tests)

**Must not change:**
- `addExperience()` individual return shape
- Atomic write contract (each batch write is still atomic)
- Existing callers' behavior

**Behavior/invariant:**
- Add `addExperiences(records: Omit<...>[]): Promise<ExperienceRecord[]>` to store
- Each record gets its own `id` and `timestamp` (individual identity preserved)
- All records written to a single `.tmp` file, then atomically renamed to `experiences.jsonl` (newline-delimited, one JSON object per line)
- `listExperiences()` reads the `.jsonl` file (single read) instead of N individual `.json` files
- **Migration path**: On first read, if `.jsonl` exists use it; if not, fall back to reading individual `.json` files and create `.jsonl` on the fly (backward compatible)

**Implementation constraints:**
- New file format: `experiences.jsonl` — one compact JSON object per line
- `readJsonlSafe(path)` helper in `fsx.ts` — reads file, splits by newline, parses each line
- `writeJsonlAtomic(path, records)` helper — writes all records to tmp then rename
- `listExperiences()` checks for `.jsonl` first, falls back to per-file reads
- All existing mutation methods (`addExperience`, `pruneExperiences`, etc.) update the `.jsonl` file

**Acceptance evidence:**
```bash
npx vitest run test/store.spec.ts test/prune-deterministic.spec.ts
```
Plus new tests:
- `addExperiences` writes all records to `.jsonl` atomically
- `listExperiences` reads from `.jsonl` correctly
- Migration: store with individual `.json` files falls back and creates `.jsonl`
- `pruneExperiences` works correctly with `.jsonl` format

**Rollback/recovery:** If `.jsonl` is corrupt, fall back to reading individual `.json` files (already handled by the migration path). Safe degradation.

**Integration handoff:** Terminal card. Updates `store.ts` contract — all downstream cards (B, C) already depend on A which is this card's prerequisite.

**Parallel-safe with:** none (touches store write path)

---

## Integration Ownership

**Card A+B+C+D integration proof:** Run the full auto-cycle end-to-end:
```bash
npx vitest run test/auto-experience.spec.ts test/check6-liveCycle.spec.ts test/p12-degradation.spec.ts
```
All must pass. These tests cover the full experience → pattern → cycle path.

**Card E integration proof:**
```bash
npx vitest run test/store.spec.ts test/prune-deterministic.spec.ts test/audit-*.spec.ts
```
Ensures store mutation and pruning semantics are preserved with the new `.jsonl` format.

**Full regression:**
```bash
npx vitest run
```
Target: 681 passed, 0 new failures. (The 9 pre-existing failures in `prune-deterministic`, `real-agnes-experiment`, `sequential-improvements` are known and unrelated.)

---

## Execution Order

```
Phase 1 (sequential, 2 cards):
  Card A → Card B
  Card A → Card C
  Card D (parallel with A)

Phase 2 (sequential, 1 card):
  Card E (depends on A's cache invalidation pattern)
```

**Recommended parallel execution:**
- Worker 1: Card A + Card D (both independent, different files)
- Worker 2: Card B (depends on A)
- Worker 3: Card C (depends on A)
- After A+B+C merge: Card E

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| Cache stale read causes wrong pattern detection | Low (5s TTL, invalidated on write) | Tests cover fresh vs cached paths |
| `.jsonl` migration corrupts existing data | Low (read-first, write-once pattern) | Fallback to per-file reads on parse error |
| Debounce skips a legitimate cycle | None (soft debounce, not hard) | `inFlight` guard still prevents concurrency |
| Prompt compression misses important patterns | Low (top-5 by confidence is heuristic) | Existing pattern dedup still works |

---

## Completion Criteria

- [ ] All 5 cards implemented
- [ ] 681+ tests passing (no new failures vs baseline)
- [ ] `listExperiences()` cache hit measurable in timing (optional benchmark)
- [ ] LLM prompt size ≤ 2000 chars (verified by test)
- [ ] `.jsonl` migration tested with existing `.json` data
- [ ] `git push origin main`
