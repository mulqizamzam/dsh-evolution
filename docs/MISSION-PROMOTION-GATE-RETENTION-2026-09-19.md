# Mission Report: Promotion Gate Order + Experience Retention

**Date**: 2026-09-19  
**Branch**: main (HEAD 4bfa3d5)  
**Result**: ✅ PASSED — 364/364 tests, tsc clean, build complete

---

## 1. What Changed

### A. Promotion Gate Order (`src/host/modules/promote/`)

**Problem**: `evo_promote` called `activateVersion()` (mounting candidate tool into host) at line 66 of the original `promote/tools.ts`, then called `runPromotionPolicy()` (beats_active gate) at line 84. A policy rejection left the candidate tool mounted with no Version record — the active version/tool was already replaced.

**Fix**: Split promotion into three phases:
1. **`evaluatePromotionPolicy()`** — pure read, beats_active gate only. No store mutation, no activation change.
2. **Pre-flight** (in `tools.ts`) — materialize artifact under planned id, validate, sandbox `activateVersion`. If this fails, return error immediately — no Version created, no activation changed.
3. **`executePromotion()`** — creates Version, updates Candidate status, materializes final artifact (skips if already exists), refreshes activation.

`runPromotionPolicy()` preserved as backward-compatible wrapper for `evo_full_cycle`.

**New order in `evo_promote`**:
```
candidate check → policy evaluate → pre-flight → execute promotion → report state
```

**Critical invariant now enforced**: Policy rejection creates NO version, NO artifact mutation, NO activation change. The currently active version/tool is never replaced by a rejected candidate.

### B. Experience Retention (`src/host/store.ts`)

Added `pruneExperiences(maxRecords, retentionDays): Promise<number>` to `EvolutionStore`:
- Reads ALL experience files (no limit — needs full set for correct pruning)
- Filters by TTL: removes records older than `retentionDays * 24h`
- Then enforces count cap: removes oldest first until `≤ maxRecords`
- Retained records are never rewritten — byte-for-byte unchanged
- Missing/corrupt files silently skipped (consistent with existing `readJsonSafe` semantics)
- Returns count of removed records

### C. Wiring Pruning (`src/host/modules/experience/tools.ts`, `src/host/modules/auto-experience/index.ts`)

- `evo_experience_record`: calls `store.pruneExperiences()` after each manual record, fire-and-forget
- `session/event` listener: calls `store.pruneExperiences()` after each auto-recorded turn, fire-and-forget (wrapped in try/catch so pruning failures never break the turn)

Both use `deps.cfg().experience` for config values — never duplicate defaults.

---

## 2. Why

### Promotion Order
The baseline audit (docs/BASELINE-2026-09-19.md) confirmed:
> **CRITICAL BUG**: `activateVersion` at `promote/tools.ts:66` runs before `runPromotionPolicy` at line 84. If `activateVersion` succeeds but `runPromotionPolicy` rejects, the candidate's tool is already mounted in the host with no version record.

The fix ensures the policy gate is the FIRST mutation boundary. Pre-flight runs before version creation but after policy passes — so a broken candidate is refused without creating a version.

### Retention Limits
`experience.maxRecords` and `experience.retentionDays` were documented as "declared but unenforced" (confirmed: zero usages in any write path or cleanup logic). Without enforcement, the store grows unbounded, degrading `listExperiences` performance (O(N) stat calls per call).

---

## 3. Files Changed

| File | Lines | Change |
|------|-------|--------|
| `src/host/modules/promote/index.ts` | +79/-13 | Split `runPromotionPolicy` → `evaluatePromotionPolicy` + `executePromotion` + backward compat wrapper |
| `src/host/modules/promote/tools.ts` | +53/-30 | Reorder: policy → pre-flight → execute; fix double-import |
| `src/host/store.ts` | +57/-2 | Add `pruneExperiences()` method |
| `src/host/modules/experience/tools.ts` | +3 | Wire prune after `addExperience` |
| `src/host/modules/auto-experience/index.ts` | +8/-1 | Wire prune after auto-recorded experience |
| `test/prune-promotion-gate.spec.ts` | NEW | 8 tests: promotion gate isolation, maxRecords cap, TTL, combined, byte-preservation |

**Build output**: `lib/index.js` regenerated (expected — source changed).

---

## 4. Tests/Checks Executed

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | ✅ Clean (0 errors) |
| `npx vitest run` (45 files, 364 tests) | ✅ All pass |
| `npm run build` | ✅ Complete (125ms) |
| `test/activation.spec.ts` (9 tests) | ✅ All pass |
| `test/promotion-unified.spec.ts` (10 tests) | ✅ All pass |
| `test/promotion-e2e.spec.ts` (1 test) | ✅ Pass |
| `test/check5-promotionSemantics.spec.ts` (5 tests) | ✅ All pass |
| `test/prune-promotion-gate.spec.ts` (8 new tests) | ✅ All pass |
| `test/auto-experience.spec.ts` (13 tests) | ✅ All pass |
| `test/p7-audit.spec.ts` (7 tests) | ✅ All pass |
| `test/evidence-chain.spec.ts` (16 tests) | ✅ All pass |
| `test/integration.spec.ts` (12 tests) | ✅ All pass |

---

## 5. Verification Results

### Promotion Gate (Invariants 1–3)
- ✅ A failing `evaluatePromotionPolicy` returns `{ ok: false }` with NO version created, NO candidate status changed, NO activation changed
- ✅ Pre-flight failure (broken entry point) returns error with NO version created
- ✅ Successful promotion: Version created, Candidate marked 'promoted', artifact materialized, tool mounted
- ✅ `runPromotionPolicy` backward compat: still works for `evo_full_cycle`, preserves all provenance fields

### Experience Retention (Invariants 4–6)
- ✅ `maxRecords=3`: adding 5 records, pruning to 3 → exactly newest 3 retained
- ✅ `retentionDays=1`: old records (>1 day) removed, new records preserved
- ✅ Combined cap + TTL: TTL applied first, then count cap on survivors
- ✅ Retained records are byte-for-byte unchanged (no rewrite)
- ✅ Append-only semantics preserved (prune deletes, never modifies)

### Status/Observability (Invariant D)
- ✅ `listExperiences()` reflects post-prune count (confirmed by test)
- ✅ `evo_observe_state.storedExperiences` reads from store directly — reflects post-prune state naturally

### Failure Path (Invariant 7)
- ✅ Pre-flight failure: no version created, no activation changed
- ✅ Policy rejection: no version created, no candidate updated, no activation changed
- ✅ Activation failure AFTER version create: version record remains (existing behavior), candidate stays 'benchmarked'

---

## 6. Known Limitations

1. **Pruning is fire-and-forget**: failures in `pruneExperiences()` are silently caught. This is intentional — pruning must never block experience recording or turn processing. A failed prune simply means the next add will attempt again.

2. **`evo_observe_state.observedTurnsThisProcess` still reports ring buffer size** (known bug from baseline, out of scope).

3. **No pruning for benchmarks/patterns/candidates**: only experiences are pruned. The config declares `maxActive: 10` for candidates but this is also unenforced.

4. **`materializeArtifact` can destroy live artifact on crash**: the `rm(finalDir)` before `rename` window still exists (`artifact.ts:176`). This was in scope for baseline but not for this mission.

5. **`listExperiences` still O(N) stat calls**: pruning reduces N but doesn't change the algorithm. A versionId index would be needed for O(log N) lookups.

---

## 7. Remaining Uncertainty

- **Concurrent prune calls**: if two experiences are added simultaneously, both trigger prune. The second prune sees fewer records and may over-prune. In practice, the event loop serializes these, so this is extremely unlikely.

- **Timestamp precision**: pruning uses ISO timestamp strings compared via `localeCompare`. This is deterministic for ISO 8601 strings but depends on consistent timestamp generation (already guaranteed by `isoDateTime`).

---

## 8. Assumption Contradicting Baseline

**None found.** The baseline report correctly identified the promotion order bug and the unenforced lifecycle limits. This mission addressed exactly those two gaps without introducing behavioral changes to unrelated paths.

---

*Report generated by dsh-evolution mission execution. All assertions verified against live test runs.*
