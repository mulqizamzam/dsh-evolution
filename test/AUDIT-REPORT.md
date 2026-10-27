# Audit Report: `addBenchmark` OLD API Pattern Compliance

**Audit date:** 2026-10-27  
**Scope:** All `addBenchmark` call sites in `test/` (including `test/helpers/`)  
**Auditor:** auditor (automated AST-based scan using TypeScript compiler API)  
**Script:** `test/audit-addbenchmark.cjs` (produces `test/audit-results.json`)

---

## 1. Executive Summary

A total of **78 `addBenchmark` calls** were found across 30 files in the `test/`
directory (29 `*.spec.ts` files + 1 helper in `test/helpers/`). Of those, **53 calls
(68%)** were flagged for one or more OLD API pattern violations.

> **Note on codebase state:** During the audit, 5 test files were observed being
> actively refactored by another process — `active-pointer.spec.ts`,
> `artifact-containment.spec.ts`, `crash-consistency.spec.ts`,
> `cumulative-composition.spec.ts`, and `evolution-experiment.spec.ts` were
> modified to route `addBenchmark` calls through the shared
> `seedLiveBenchmark` helper (in `test/helpers/seed-live-benchmark.ts`) instead
> of calling `store.addBenchmark` directly. These files therefore no longer
> contain direct `addBenchmark` calls and are excluded from the findings below.
> The remaining files may continue to change; readers should re-run
> `node test/audit-addbenchmark.cjs` to refresh.

### Issue frequency (per-issue count, not per-call)

| OLD API condition | Issue key | Count |
|---|---|---|
| `createdAt` passed inside the object argument | `createdAt-in-object` | 12 |
| Missing `command` for `mode: 'live'` | `missing-command-for-live` | 19 |
| Missing `provenance` for `mode: 'live'` | `missing-provenance-for-live` | 22 |
| No 2nd argument passed to `addBenchmark` | `no-second-arg` | 29 |

**78 total calls · 53 flagged · 82 individual issues** (some calls have multiple issues).

---

## 2. Methodology

The audit uses the **TypeScript compiler API** (`ts.createSourceFile`) to parse
each test file into an AST. It then walks the tree looking for `CallExpression`
nodes whose target is a `PropertyAccessExpression` with name `addBenchmark`
(matching `store.addBenchmark`, `testStore.addBenchmark`, `liveStore.addBenchmark`,
`f.store.addBenchmark`, etc.).

For each call, the script checks four conditions against the first argument
(object literal) and the argument list:

1. **`createdAt` in object** — Is `createdAt` a direct property key of the object
   argument? (Type assertions via `as` are unwrapped; spreads are noted but not
   fully resolved.)
2. **`mode: 'live'`** — Is the `mode` property a string literal `'live'`?
   (Variable-mode or non-live modes are reported but the command/provenance
   checks only apply to literal `mode: 'live'`.)
3. **`command` present** — Is `command` a direct property key? (Only checked for
   `mode: 'live'`.)
4. **`provenance` present** — Is `provenance` a direct property key? (Only checked
   for `mode: 'live'`.)
5. **2nd argument present** — Does `arguments.length >= 2`?

First arguments wrapped in `as` type assertions (e.g., `{ ... } as never`) are
unwrapped before analysis. First arguments that are bare identifiers (e.g.,
`store.addBenchmark(run, createdAt)` in helper functions) are reported as
`variable-arg` — these cannot be statically verified but are checked for
second-argument presence.

---

## 3. The Correct (New) API Pattern

Per `src/host/store.ts` (`addBenchmark` signature) and
`src/lib/provenance.ts` (`createLiveProvenance`), the correct pattern is:

```typescript
import { isoDateTime } from '../src/lib/ids.ts'
import { createLiveProvenance } from '../src/lib/provenance.ts'

const createdAt = isoDateTime(new Date())  // or new Date().toISOString()
await store.addBenchmark({
  mode: 'live',
  command: theCommand,
  provenance: createLiveProvenance(candidateId, version, theCommand, createdAt),
  // … other fields (candidateId, version, baseline, runs, metrics, passed, details, …)
  // NO createdAt here — it would be a duplicate and shadow the 2nd argument
}, createdAt)
```

Key rules:
- `createdAt` is **never** inside the object argument; it is the **2nd argument**.
- For `mode: 'live'`, both `command` and `provenance` must be present.
- `provenance` must be `createLiveProvenance(candidateId, version, command, createdAt)`.
- The `createdAt` used in `createLiveProvenance` **must be the same** value
  passed as the 2nd argument, so the store's `verifyLiveProvenance` check
  passes.

**Reference implementation (clean):** `test/helpers/seed-live-benchmark.ts:78`
```typescript
return store.addBenchmark(run, createdAt)
```
where `run` is built with `mode`, `command`, and `provenance` set when
`mode === 'live'`.

---

## 4. The Four OLD API Pattern Conditions

Each `addBenchmark` call is evaluated against these four conditions:

| # | Condition | Description | Applies to |
|---|---|---|---|
| 1 | `createdAt-in-object` | `createdAt` appears as a property inside the object argument. Should be the 2nd argument instead. | All calls |
| 2 | `missing-command-for-live` | `mode: 'live'` but no `command` property. | Only `mode: 'live'` |
| 3 | `missing-provenance-for-live` | `mode: 'live'` but no `provenance` property. | Only `mode: 'live'` |
| 4 | `no-second-arg` | `addBenchmark` called with only 1 argument (no `createdAt` as 2nd arg). | All calls |

---

## 5. Detailed Findings — The Six Required Files

### 5.1 `test/test-state-isolation.spec.ts` — 3/3 flagged

| Line | Store var | Issues |
|---|---|---|
| 130 | `testStore` | `missing-command-for-live`, `missing-provenance-for-live` |
| 160 | `liveStore` | `missing-command-for-live`, `missing-provenance-for-live` |
| 192 | `testStore` | `missing-command-for-live`, `missing-provenance-for-live` |

All three calls are `mode: 'live'` and now pass a 2nd-argument timestamp
(`isoDateTime(new Date())`), but they lack `command` and `provenance`.

**Example (L130):**
```typescript
await testStore.addBenchmark({
  candidateId: c.id, version: 'v1', baseline: 'unknown', runs: 5,
  metrics: { successRate: 0.95, avgScore: 0.95, errorRate: 0.02, avgSteps: 5, avgDurationMs: 100 },
  passed: true, details: 'v1', mode: 'live',
}, isoDateTime(new Date()))
```
**Correct pattern:** Add `command: theCommand` and
`provenance: createLiveProvenance(c.id, 'v1', theCommand, createdAt)` into the
object, and store the 2nd-arg timestamp in a `const` so it can be used in the
seal.

---

### 5.2 `test/test-state-profile-namespace.spec.ts` — 1/1 flagged

| Line | Store var | Issues |
|---|---|---|
| 73 | `webStore` | `missing-command-for-live`, `missing-provenance-for-live` |

**Example (L73):**
```typescript
await webStore.addBenchmark({
  candidateId: c.id, version: 'v1', baseline: 'unknown', runs: 5,
  metrics: { successRate: 0.95, avgScore: 0.95, errorRate: 0.02, avgSteps: 5, avgDurationMs: 100 },
  passed: true, details: 'web-v1', mode: 'live',
}, isoDateTime(new Date()))
```
**Correct pattern:** Same as §5.1 — add `command` and `provenance` with a
shared `createdAt` const.

---

### 5.3 `test/smoke-runtime.spec.ts` — 0/1 flagged (CLEAN)

| Line | Store var | Issues |
|---|---|---|
| 159 | `store` | None ✅ |

This call follows the correct new API:
```typescript
const createdAt = isoDateTime(new Date())
const command = 'node candidate.js'  // (or similar)
await store.addBenchmark({
  mode: 'live', candidateId, version: 'v1', baseline: 'v1', parentVersion: 'v1', runs: 3,
  metrics: { … }, passed: true, details: 'All thresholds met.',
  command, provenance: createLiveProvenance(candidate.id, 'v1', command, createdAt),
}, createdAt)
```

---

### 5.4 `test/m34-concurrency.spec.ts` — 1/1 flagged

| Line | Store var | Issues |
|---|---|---|
| 56 | `store` | `no-second-arg` |

The `addLiveBench` helper computes `createdAt` at line 55 and uses it for the
`provenance` seal, but does **not** pass it as the 2nd argument:

```typescript
async function addLiveBench(store: EvolutionStore, candidateId: string, successRate: number, command = 'node test.js') {
  const createdAt = isoDateTime(new Date())              // ← computed here
  const bench = await store.addBenchmark({
    mode: 'live', candidateId, version: 'v-temp', baseline: 'v-temp', runs: 3,
    metrics: { … }, passed: true, details: 'live',
    command,
    provenance: createLiveProvenance(candidateId, 'v-temp', command, createdAt),  // ← seal uses createdAt
  })                                                         // ← but no 2nd arg!
  await store.updateCandidate(candidateId, { status: 'benchmarked' })
  return bench
}
```

**Risk:** The store generates its own `createdAt` internally
(`isoDateTime(this.nowFn())`), so the persisted `createdAt` will differ from
the value baked into the `provenance` seal. `verifyLiveProvenance` will fail
because the re-derivation uses the *stored* `createdAt`, not the one used for
the seal.

**Correct pattern:** Add `, createdAt` after the object:
```typescript
  ...
  provenance: createLiveProvenance(candidateId, 'v-temp', command, createdAt),
}, createdAt)   // ← add this
```

---

### 5.5 `test/integration.spec.ts` — 1/3 flagged

| Line | Store var | Mode | Issues |
|---|---|---|---|
| 281 | `store` | live | None ✅ |
| 318 | `store` | live | None ✅ |
| 345 | `store` | simulated | `no-second-arg` |

Lines 281 and 318 are correctly sealed live benchmarks (have `command`,
`provenance`, and 2nd-arg `createdAt`). Line 345 is a **simulated** benchmark
without a 2nd argument:

```typescript
await store.addBenchmark({
  mode: 'simulated',
  candidateId: candidate.id, version: 'v1', baseline: 'v1', parentVersion: 'v1', runs: 5,
  metrics: { successRate: 0.95, avgScore: 0.9, errorRate: 0.02, avgSteps: 3, avgDurationMs: 5000 },
  passed: true, details: 'simulated only',
})
```

**Note:** For `mode: 'simulated'`, there is no `provenance` seal, so the
2nd-argument `createdAt` is not strictly required for correctness. However, the
task's audit criteria lists "no 2nd argument" as an OLD API pattern condition,
so this is reported. The `addBenchmark` signature accepts `createdAt` as
optional; passing it explicitly is the preferred NEW pattern but not
critical for simulated records.

---

### 5.6 `test/benchmark-functional-oracle.spec.ts` — 1/1 flagged

| Line | Store var | Mode | Issues |
|---|---|---|---|
| 659 | `store` | live | `missing-provenance-for-live`, `no-second-arg` |

```typescript
const recordId = await store.addBenchmark({
  mode: 'live', candidateId: id, version: 'v1', baseline: 'v1', parentVersion: 'v1', runs: 1,
  metrics: { successRate: 1, avgScore: 1, errorRate: 0, avgSteps: 0, avgDurationMs: 50 },
  thresholds: { … },
  command: 'echo survives-roundtrip',
  expectedExitCode: 0, expectedOutput: 'survives-roundtrip',
  passed: true, details: 'test persistence',
})
```

**Correct pattern:** Add `const createdAt = isoDateTime(new Date())` before the
call, inject `provenance: createLiveProvenance(id, 'v1', 'echo survives-roundtrip', createdAt)`
into the object, and pass `, createdAt` as the 2nd argument.

---

## 6. Detailed Findings — All Other Test Files

### 6.1 `test/autonomous-evolution-experiment.spec.ts` — 3/6 flagged

| Line | Mode | Issues | Snippet |
|---|---|---|---|
| 231 | live | `missing-command`, `missing-provenance`, `no-second-arg` | `store.addBenchmark({ …, mode: 'live', expectedOutput: …, expectedExitCode: … })` |
| 350 | live | `missing-command`, `missing-provenance`, `no-second-arg` | Same pattern — live benchmark with `expectedOutput`/`expectedExitCode` but no `command`/`provenance` and no 2nd arg. |
| 389 | live | None ✅ | Correctly sealed live benchmark. |
| 430 | live | None ✅ | Correctly sealed live benchmark. |
| 630 | live | `missing-command`, `missing-provenance`, `no-second-arg` | `store.addBenchmark({ …, mode: 'live', expectedOutput: …, expectedExitCode: … })` |
| 663 | live | None ✅ | Correctly sealed live benchmark. |

**Lines 231, 350, 630** all create `mode: 'live'` records with
`expectedOutput`/`expectedExitCode` but no `command`, no `provenance`, and no
2nd-argument `createdAt`. These appear to be benchmarks that used the live/evo
tool path (`evo_benchmark_live`) which should have produced a command and seal
but the test persist the results manually without them.

**Correct pattern:** Compute `createdAt` first, add `command` (the command
executed by the tool) and `provenance`, then pass `createdAt` as the 2nd arg.

---

### 6.2 `test/canonical-active-state.spec.ts` — 7/7 flagged

| Line | Mode | Issues |
|---|---|---|
| 66 | live | `missing-command-for-live`, `missing-provenance-for-live` |
| 105 | live | `missing-command-for-live`, `missing-provenance-for-live` |
| 146 | live | `missing-command-for-live`, `missing-provenance-for-live` |
| 225 | live | `missing-command-for-live`, `missing-provenance-for-live` |
| 324 | live | `missing-command-for-live`, `missing-provenance-for-live` |
| 400 | live | `missing-command-for-live`, `missing-provenance-for-live` |
| 438 | live | `missing-command-for-live`, `missing-provenance-for-live` |

All 7 calls follow this pattern:
```typescript
await store.addBenchmark({
  mode: 'live', candidateId: candidate.id, version: 'v1', baseline: 'v1', runs: 3,
  metrics: { successRate: 0.96, avgScore: 0.96, errorRate: 0, avgSteps: 0, avgDurationMs: 100 },
  passed: true, details: 'live',
}, new Date().toISOString())
```

These calls **do** pass a 2nd argument
(`new Date().toISOString()`) and **do** have `mode: 'live'`, but they are
missing `command` and `provenance`. The `createdAt` is correctly passed as the
2nd arg — so the only issue is the missing sealed fields.

**Correct pattern:** Add `command` and
`provenance: createLiveProvenance(candidate.id, 'v1', command, createdAt)`
into the object.

---

### 6.3 `test/check5-promotionSemantics.spec.ts` — 1/1 flagged

| Line | Mode | Issues |
|---|---|---|
| 38 | live | `createdAt-in-object` |

```typescript
const createdAt = isoDateTime(new Date())
const command = 'node candidate-under-test.js'
…
await store.addBenchmark({
  candidateId, version, baseline: 'unknown', runs: totalRuns,
  metrics: { … },
  passed: successRate >= 0.8,
  details: `live benchmark rate=${successRate}`,
  createdAt,                    // ← SHORTHAND: inside object (should be removed)
  mode: 'live',
  command,
  provenance: createLiveProvenance(candidateId, version, command, createdAt),
}, createdAt)                    // ← correctly passed as 2nd arg
```

**Issue:** `createdAt` appears both inside the object (as a shorthand property)
AND as the 2nd argument. The `addBenchmark` signature omits `createdAt` from the
first argument type, so this is a type error in strict mode. The fix is to
remove the `createdAt,` line from the object.

---

### 6.4 `test/integration.spec.ts` — see §5.5.

---

### 6.5 `test/m1-comparative-authority.spec.ts` — 1/1 flagged

| Line | Mode | Issues | Nuance |
|---|---|---|---|
| 47 | unset (variable) | `createdAt-in-object` | Conditional spread |

```typescript
await store.addBenchmark({
  candidateId, version, baseline: 'unknown', runs: 10,
  metrics: { … },
  passed: successRate >= 0.8,
  details: `benchmark rate=${successRate}`,
  createdAt,                          // ← in object (shorthand)
  mode,                               // ← mode is a variable, not 'live' literal
  ...(mode === 'live' ? {
    command,
    provenance: createLiveProvenance(candidateId, version, command, createdAt),
  } : {}),
}, createdAt)
```

**Nuance:** `mode` is passed as a variable (`mode`), so the static analyzer
cannot determine if it is `'live'`. When `mode === 'live'`, the conditional
spread *does* include `command` and `provenance`. The only real issue is
`createdAt` inside the object. Removing the `createdAt,` shorthand fixes this.

---

### 6.6 `test/m33-evidence-trust-boundary.spec.ts` — 4/5 flagged

| Line | Mode | Issues | Notes |
|---|---|---|---|
| 58 | simulated | `no-second-arg` | `addSimBenchmark` helper — simulated benchmark, no `command`/`provenance` needed. |
| 88 | live | None ✅ | `addLiveBenchmark` helper — correctly sealed. |
| 259 | live | `no-second-arg` | **Intentional:** `provenance: badProvenance` — deliberately wrong seal to test rejection at the promotion gate. |
| 322 | live | `no-second-arg` | **Intentional:** `provenance: stolenProvenance` — cross-candidate evidence reuse test. |
| 398 | live | `missing-provenance-for-live`, `no-second-arg` | **Intentional:** "live unsealed" fixture — deliberately omits `provenance` to test the red-team gate rejection. |

All four flagged calls are in test fixtures that deliberately create records
with wrong or missing provenance to exercise the promotion gate's verification
logic. The `no-second-arg` condition is a *side effect* of these being
test fixtures — the store generates its own `createdAt`, and the test
re-seals via `tamperBenchmarkFile` if needed (see
`test/m33-integrity-regression.spec.ts` comments).

**Recommendation:** Even for intentional test fixtures, passing `createdAt` as
the 2nd argument would make the tests more deterministic and avoid relying on
the store's auto-generated timestamp.

---

### 6.7 `test/m33-integrity-regression.spec.ts` — 9/11 flagged

| Line | Mode | Issues | Notes |
|---|---|---|---|
| 77 | live | `no-second-arg` | `makeActiveLive` helper: seal computed with `createdAt1` but not passed as 2nd arg. |
| 117 | live | None ✅ | Correctly sealed (re-sealed via `tamperBenchmarkFile` after creation). |
| 148 | live | `no-second-arg` | **Intentional:** `provenance: ''` placeholder, re-sealed via `tamperBenchmarkFile`. |
| 182 | live | `no-second-arg` | Same pattern — placeholder `provenance: ''`, re-sealed after. |
| 215 | live | `no-second-arg` | Same pattern — `provenance: ''` placeholder. |
| 246 | live | `no-second-arg` | Same pattern — `provenance: ''` placeholder. |
| 287 | live | `no-second-arg` | Live benchmark in `makeActiveLive`-style setup; seal computed with `ct1` but not passed as 2nd arg. |
| 307 | live | `no-second-arg` | Same pattern — seal computed with `ct1`, not passed as 2nd arg. |
| 330 | live | `no-second-arg` | **Intentional:** `provenance: replayedSeal` (computed with wrong `createdAt`), re-sealed via `tamperBenchmarkFile` using the stored `createdAt`. |
| 361 | simulated | `no-second-arg` | Simulated benchmark. |
| 394 | live | None ✅ | Correctly sealed. |

**Key finding:** The `makeActiveLive` helper (L77) computes `createdAt1` and
uses it for the provenance seal but does **not** pass it as the 2nd argument to
`addBenchmark`. The comment at L287 confirms this pattern:
> "addBenchmark sets its own createdAt; re-seal with the stored createdAt and
> recompute the seal to match."

This is the **exact OLD API pattern** the `m33-createdAt-consistency` tests
(L83–L277, all clean) were designed to eliminate. The `makeActiveLive` helper
reverts to the old pattern.

---

### 6.8 `test/m34-concurrency.spec.ts` — see §5.4.

---

### 6.9 `test/m4-first-promotion-contract.spec.ts` — 1/2 flagged

| Line | Mode | Issues |
|---|---|---|
| 118 | simulated | `no-second-arg` |
| 132 | live | None ✅ |

---

### 6.10 `test/mission-b-stale-parent.spec.ts` — 2/3 flagged

| Line | Mode | Issues |
|---|---|---|
| 88 | live | None ✅ |
| 231 | live | `createdAt-in-object`, `missing-command-for-live`, `missing-provenance-for-live`, `no-second-arg` |
| 369 | live | `createdAt-in-object`, `missing-command-for-live`, `missing-provenance-for-live`, `no-second-arg` |

Both flagged calls follow this pattern:
```typescript
await store.addBenchmark({
  mode: 'live', candidateId: …, version: …, baseline: …, parentVersion: …, runs: 3,
  metrics: { … },
  passed: true, details: 'direct stamping check',
  createdAt: new Date().toISOString(),   // ← in object
  // no command, no provenance, no 2nd arg
})
```

**All four conditions violated.** This is the most severe form of the OLD API
pattern.

---

### 6.11 `test/promotion-baseline-window.spec.ts` — 2/2 flagged

| Line | Mode | Issues | Nuance |
|---|---|---|---|
| 64 | live | `missing-provenance-for-live` | **Conditional spread** — `provenance` is included via `...(opts.sealed ? { provenance: createLiveProvenance(...) } : {})`. Statically absent, conditionally present. |
| 75 | simulated | `no-second-arg` | Filler benchmark to push baseline out of list window. |

**Line 64 nuance:** The `provenance` is inside a conditional spread, so it is
present when `opts.sealed === true` but absent otherwise. The static analyzer
reports it as "missing" because it is not a direct property. This is a
false-positive-ish finding — the provenance *is* conditionally provided.
However, when `opts.sealed === false`, the record is a live benchmark **without**
a provenance seal, which would cause `verifyLiveProvenance` to return `false`.
Whether this is intentional (testing the unsealed path) should be verified.

---

### 6.12 `test/promotion-e2e.spec.ts` — 4/4 flagged

| Line | Mode | Issues |
|---|---|---|
| 27 | live | `createdAt-in-object` |
| 47 | live | `createdAt-in-object` |
| 66 | live | `createdAt-in-object` |
| 85 | live | `createdAt-in-object` |

All four calls have `createdAt` as a shorthand property inside the object while
also correctly passing it as the 2nd argument and including `command` and
`provenance`. The sole issue is the duplicate `createdAt` inside the object.

```typescript
const createdAt = isoDateTime(new Date(Date.now() - 86400000))  // or new Date()
const command = 'node candidate-under-test.js'
await store.addBenchmark({
  …, createdAt, mode: 'live', command,
  provenance: createLiveProvenance(v1.id, 'v0', command, createdAt),
}, createdAt)   // ← 2nd arg present, but createdAt is ALSO in the object
```

**Fix:** Remove the `createdAt,` shorthand from the object. The 2nd-argument
`createdAt` is sufficient.

---

### 6.13 `test/promotion-red-team-gate.spec.ts` — 2/4 flagged

| Line | Mode | Issues |
|---|---|---|
| 79 | live | None ✅ (passed via `as never` type assertion) |
| 144 | simulated | `no-second-arg` |
| 172 | live | None ✅ |
| 196 | manifest | `no-second-arg` |

All four calls are inside the `addLiveEvidence` helper which uses `as never` to
bypass TypeScript's `Omit<BenchmarkRun, 'id' | 'createdAt'>` type. The script
unwrapped the `as` assertion to correctly analyze the object.

**Line 144:** Simulated benchmark (forged-looking evidence fixture) — no 2nd arg.  
**Line 196:** Manifest benchmark — no 2nd arg.  
**Lines 79, 172:** Live benchmarks with correct `command`, `provenance`, and 2nd-arg `createdAt`.

---

### 6.14 `test/promotion-switch-semantics.spec.ts` — 1/1 flagged

| Line | Mode | Issues |
|---|---|---|
| 99 | live | `createdAt-in-object` |

```typescript
await store.addBenchmark({
  …, createdAt, command,
  provenance: createLiveProvenance(candidate.id, 'v0', command, createdAt) ?? undefined,
  mode: 'live',
}, createdAt)
```

`createdAt` is a shorthand property inside the object AND passed as the 2nd
arg. Remove the `createdAt,` shorthand from the object.

---

### 6.15 `test/promotion-unified.spec.ts` — 1/1 flagged

| Line | Mode | Issues | Nuance |
|---|---|---|---|
| 53 | unset (variable) | `createdAt-in-object` | Conditional spread |

Same pattern as `m1-comparative-authority.spec.ts:47` — `createdAt` in object,
`mode` is a variable, `command`/`provenance` are conditionally spread. Fix:
remove `createdAt,` from the object.

---

### 6.16 `test/prune-promotion-gate.spec.ts` — 4/4 flagged

| Line | Mode | Issues |
|---|---|---|
| 68 | live | `missing-command-for-live`, `missing-provenance-for-live` |
| 85 | live | `createdAt-in-object` |
| 134 | live | `missing-command-for-live`, `missing-provenance-for-live` |
| 150 | live | `createdAt-in-object` |

- **L68, L134:** Live benchmarks with 2nd-arg `isoDateTime(new Date())` but no
  `command` or `provenance`.
  ```typescript
  await store.addBenchmark({ … details: 'v1', mode: 'live', }, isoDateTime(new Date()))
  ```
- **L85, L150:** Live benchmarks with `createdAt` shorthand in object, 2nd-arg
  `createdAt` present, and `command`/`provenance` correctly included. Fix:
  remove `createdAt,` from the object.

---

### 6.17 `test/real-agnes-experiment.spec.ts` — 1/1 flagged

| Line | Mode | Issues |
|---|---|---|
| 156 | live | `missing-command-for-live`, `missing-provenance-for-live`, `no-second-arg` |

```typescript
await store.addBenchmark({ candidateId: v1cand.id, version: 'v1', baseline: 'v1', runs: 3,
  metrics: { … }, passed: false, details: 'v1 failed oracle', mode: 'live',
  expectedOutput: EXPECTED_OUTPUT, expectedExitCode: EXPECTED_EXIT_CODE })
```

All four conditions violated — no `command`, no `provenance`, no 2nd arg, and
the `mode: 'live'` benchmark is missing `command`.

---

### 6.18 `test/store-cache.spec.ts` — 2/2 flagged

| Line | Mode | Issues |
|---|---|---|
| 90 | unset | `no-second-arg` |
| 94 | unset | `no-second-arg` |

Both are simple benchmarks without a `mode` field (defaults to undefined, not
`'live'`). No `command` or `provenance` is needed. The `no-second-arg` is the
only issue — the store auto-generates `createdAt`.

---

### 6.19 `test/store.spec.ts` — 1/1 flagged

| Line | Mode | Issues |
|---|---|---|
| 146 | unset | `no-second-arg` |

Basic store smoke test — creates a benchmark without `mode` and without a 2nd
arg.

---

### 6.20 `test/test-state-isolation.spec.ts` — see §5.1.

---

### 6.21 `test/test-state-profile-namespace.spec.ts` — see §5.2.

---

### 6.22 `test/helpers/seed-live-benchmark.ts` — 0/1 flagged (CLEAN)

| Line | Mode | Issues |
|---|---|---|
| 78 | variable-arg | None ✅ |

The shared helper function is the **model correct pattern**:
```typescript
const createdAt = isoDateTime(new Date())
const run: Omit<BenchmarkRun, 'id' | 'createdAt'> = {
  candidateId, version, baseline, mode, runs, metrics, passed, details,
}
if (mode === 'live') {
  run.command = command
  run.provenance = createLiveProvenance(candidateId, version, command, createdAt)
}
return store.addBenchmark(run, createdAt)   // ← 2nd arg present, no createdAt in object
```

---

## 7. Complete Inventory of Flagged Calls

| # | File | Line | Mode | Issues |
|---|---|---|---|---|
| 1 | autonomous-evolution-experiment.spec.ts | 231 | live | missing-command, missing-provenance, no-second-arg |
| 2 | autonomous-evolution-experiment.spec.ts | 350 | live | missing-command, missing-provenance, no-second-arg |
| 3 | autonomous-evolution-experiment.spec.ts | 630 | live | missing-command, missing-provenance, no-second-arg |
| 4 | benchmark-functional-oracle.spec.ts | 659 | live | missing-provenance, no-second-arg |
| 5 | canonical-active-state.spec.ts | 66 | live | missing-command, missing-provenance |
| 6 | canonical-active-state.spec.ts | 105 | live | missing-command, missing-provenance |
| 7 | canonical-active-state.spec.ts | 146 | live | missing-command, missing-provenance |
| 8 | canonical-active-state.spec.ts | 225 | live | missing-command, missing-provenance |
| 9 | canonical-active-state.spec.ts | 324 | live | missing-command, missing-provenance |
| 10 | canonical-active-state.spec.ts | 400 | live | missing-command, missing-provenance |
| 11 | canonical-active-state.spec.ts | 438 | live | missing-command, missing-provenance |
| 12 | check5-promotionSemantics.spec.ts | 38 | live | createdAt-in-object |
| 13 | integration.spec.ts | 345 | simulated | no-second-arg |
| 14 | m1-comparative-authority.spec.ts | 47 | unset | createdAt-in-object |
| 15 | m33-evidence-trust-boundary.spec.ts | 58 | simulated | no-second-arg |
| 16 | m33-evidence-trust-boundary.spec.ts | 259 | live | no-second-arg |
| 17 | m33-evidence-trust-boundary.spec.ts | 322 | live | no-second-arg |
| 18 | m33-evidence-trust-boundary.spec.ts | 398 | live | missing-provenance, no-second-arg |
| 19 | m33-integrity-regression.spec.ts | 77 | live | no-second-arg |
| 20 | m33-integrity-regression.spec.ts | 148 | live | no-second-arg |
| 21 | m33-integrity-regression.spec.ts | 182 | live | no-second-arg |
| 22 | m33-integrity-regression.spec.ts | 215 | live | no-second-arg |
| 23 | m33-integrity-regression.spec.ts | 246 | live | no-second-arg |
| 24 | m33-integrity-regression.spec.ts | 287 | live | no-second-arg |
| 25 | m33-integrity-regression.spec.ts | 307 | live | no-second-arg |
| 26 | m33-integrity-regression.spec.ts | 330 | live | no-second-arg |
| 27 | m33-integrity-regression.spec.ts | 361 | simulated | no-second-arg |
| 28 | m34-concurrency.spec.ts | 56 | live | no-second-arg |
| 29 | m4-first-promotion-contract.spec.ts | 118 | simulated | no-second-arg |
| 30 | mission-b-stale-parent.spec.ts | 231 | live | createdAt-in-object, missing-command, missing-provenance, no-second-arg |
| 31 | mission-b-stale-parent.spec.ts | 369 | live | createdAt-in-object, missing-command, missing-provenance, no-second-arg |
| 32 | promotion-baseline-window.spec.ts | 64 | live | missing-provenance *(conditional spread)* |
| 33 | promotion-baseline-window.spec.ts | 75 | simulated | no-second-arg |
| 34 | promotion-e2e.spec.ts | 27 | live | createdAt-in-object |
| 35 | promotion-e2e.spec.ts | 47 | live | createdAt-in-object |
| 36 | promotion-e2e.spec.ts | 66 | live | createdAt-in-object |
| 37 | promotion-e2e.spec.ts | 85 | live | createdAt-in-object |
| 38 | promotion-red-team-gate.spec.ts | 144 | simulated | no-second-arg |
| 39 | promotion-red-team-gate.spec.ts | 196 | manifest | no-second-arg |
| 40 | promotion-switch-semantics.spec.ts | 99 | live | createdAt-in-object |
| 41 | promotion-unified.spec.ts | 53 | unset | createdAt-in-object |
| 42 | prune-promotion-gate.spec.ts | 68 | live | missing-command, missing-provenance |
| 43 | prune-promotion-gate.spec.ts | 85 | live | createdAt-in-object |
| 44 | prune-promotion-gate.spec.ts | 134 | live | missing-command, missing-provenance |
| 45 | prune-promotion-gate.spec.ts | 150 | live | createdAt-in-object |
| 46 | real-agnes-experiment.spec.ts | 156 | live | missing-command, missing-provenance, no-second-arg |
| 47 | store-cache.spec.ts | 90 | unset | no-second-arg |
| 48 | store-cache.spec.ts | 94 | unset | no-second-arg |
| 49 | store.spec.ts | 146 | unset | no-second-arg |
| 50 | test-state-isolation.spec.ts | 130 | live | missing-command, missing-provenance |
| 51 | test-state-isolation.spec.ts | 160 | live | missing-command, missing-provenance |
| 52 | test-state-isolation.spec.ts | 192 | live | missing-command, missing-provenance |
| 53 | test-state-profile-namespace.spec.ts | 73 | live | missing-command, missing-provenance |

---

## 8. Nuances and Edge Cases

### 8.1 Conditional spreads (`...(mode === 'live' ? { command, provenance } : {})`)

Three calls use conditional spreads to include `command` and `provenance` only
when `mode === 'live'`:

- `test/m1-comparative-authority.spec.ts:47`
- `test/promotion-unified.spec.ts:53`
- `test/promotion-baseline-window.spec.ts:64`

For the first two, `mode` is a **variable** (not a string literal `'live'`), so
the static analyzer cannot confirm `mode === 'live'`. The only issue reported
is `createdAt-in-object` (the `createdAt` shorthand is always present). The
conditional spread means `command`/`provenance` *would* be present at runtime
when `mode === 'live'`, so no `missing-command`/`missing-provenance` finding
is reported.

For `promotion-baseline-window.spec.ts:64`, `mode: 'live'` IS a literal, but
`provenance` is inside `...(opts.sealed ? { provenance: … } : {})`. When
`opts.sealed === false`, the record is a live benchmark **without** a provenance
seal, which would fail `verifyLiveProvenance`. This may be intentional (testing
the unsealed path) but should be verified.

### 8.2 `{ ... } as never` type assertions

`test/promotion-red-team-gate.spec.ts:79` wraps the object literal in
`as never` to bypass TypeScript's type checker. The script unwraps `as`
expressions to correctly analyze the underlying object. This call is **clean**.

### 8.3 Intentional test fixtures (not bugs)

Several flagged calls in `m33-evidence-trust-boundary.spec.ts` and
`m33-integrity-regression.spec.ts` **intentionally** create records with wrong
or missing provenance to test the promotion gate's verification logic:

- `provenance: ''` (empty placeholder, re-sealed via `tamperBenchmarkFile`)
- `provenance: badProvenance` (deliberately wrong candidateId in seal)
- `provenance: stolenProvenance` (cross-candidate evidence reuse)
- Live benchmark without any `provenance` field (testing unsealed detection)

These are **correct by design** for their test purpose, but they still match
the audit criteria. They should not be "fixed" without understanding the test
intent.

### 8.4 `no-second-arg` for non-live benchmarks

For `mode: 'simulated'`, `mode: 'manifest'`, or no `mode` at all, the `createdAt`
field has no provenance seal to match. The store auto-generates
`isoDateTime(this.nowFn())` when no 2nd argument is passed. This is functionally
correct but does not follow the new API convention of explicitly passing
`createdAt`. The task criteria lists "no 2nd argument" as a condition to report,
so these are flagged, but they are lower-priority than live-benchmark violations.

### 8.5 Actively evolving codebase

Five test files were refactored during this audit to use the shared
`seedLiveBenchmark` helper (`test/helpers/seed-live-benchmark.ts`), which
correctly implements the new API pattern. This suggests an ongoing migration
effort. The audit results reflect the state at the time of the final run;
re-run `node test/audit-addbenchmark.cjs` for the latest state.

---

## 9. Recommendations

| Priority | Action | Files affected |
|---|---|---|
| **High** | Add `command` + `provenance` + 2nd-arg `createdAt` to all `mode: 'live'` calls missing them | autonomous-evolution-experiment (L231, L350, L630); benchmark-functional-oracle (L659); canonical-active-state (all 7); real-agnes-experiment (L156); mission-b-stale-parent (L231, L369) |
| **High** | Pass `createdAt` as 2nd arg in `m34-concurrency.spec.ts:56` (`addLiveBench` helper) and `m33-integrity-regression.spec.ts:77` (`makeActiveLive` helper) | m34-concurrency, m33-integrity-regression |
| **High** | Add `command` + `provenance` to `mode: 'live'` calls in `test/test-state-isolation.spec.ts` (L130, L160, L192) and `test/test-state-profile-namespace.spec.ts:73` | These 6 required files |
| **High** | Add `provenance` to `mode: 'live'` call in `benchmark-functional-oracle.spec.ts:659` | benchmark-functional-oracle |
| **High** | Add `command` + `provenance` to `mode: 'live'` calls in `prune-promotion-gate.spec.ts:68,134` | prune-promotion-gate |
| **Medium** | Remove `createdAt` from object argument where it duplicates the 2nd arg | check5 (L38), m1-comparative-authority (L47), promotion-e2e (L27/47/66/85), promotion-switch-semantics (L99), promotion-unified (L53), prune-promotion-gate (L85/150), mission-b-stale-parent (L231/369) |
| **Low** | Add 2nd-arg `createdAt` to simulated/manifest benchmark calls (not critical but preferred) | integration (L345), m33-evidence-trust-boundary (L58), m33-integrity-regression (L361), m4-first-promotion-contract (L118), promotion-red-team-gate (L144/196), promotion-baseline-window (L75), store-cache (L90/94), store (L146) |
| **Note** | Intentional test fixtures — do NOT fix blindly | m33-evidence-trust-boundary (L259, L322, L398); m33-integrity-regression (L148, L182, L215, L246, L330) |

### Priority reference: the `createdAt` + `provenance` pair

Every `mode: 'live'` benchmark **must** have all four:
1. `command` — the command executed in the sandbox
2. `provenance` — `createLiveProvenance(candidateId, version, command, createdAt)`
3. `createdAt` passed as the **2nd argument** (not inside the object)
4. No `createdAt` key inside the object argument

---

## 10. Files Scanned

**30 files** contained `addBenchmark` calls (29 `*.spec.ts` + 1 helper):

| File | Calls | Flagged |
|---|---|---|
| autonomous-evolution-experiment.spec.ts | 6 | 3 |
| benchmark-functional-oracle.spec.ts | 1 | 1 |
| benchmark-seal-command.spec.ts | 1 | 0 ✅ |
| canonical-active-state.spec.ts | 7 | 7 |
| check5-promotionSemantics.spec.ts | 1 | 1 |
| e2e-autonomous.spec.ts | 2 | 0 ✅ |
| integration.spec.ts | 3 | 1 |
| m1-comparative-authority.spec.ts | 1 | 1 |
| m33-createdAt-consistency.spec.ts | 7 | 0 ✅ |
| m33-evidence-trust-boundary.spec.ts | 5 | 4 |
| m33-integrity-regression.spec.ts | 11 | 9 |
| m34-concurrency.spec.ts | 1 | 1 |
| m4-first-promotion-contract.spec.ts | 2 | 1 |
| mission-b-stale-parent.spec.ts | 3 | 2 |
| p12-degradation.spec.ts | 1 | 0 ✅ |
| promotion-baseline-window.spec.ts | 2 | 2 |
| promotion-e2e.spec.ts | 4 | 4 |
| promotion-red-team-gate.spec.ts | 4 | 2 |
| promotion-switch-semantics.spec.ts | 1 | 1 |
| promotion-unified.spec.ts | 1 | 1 |
| prune-promotion-gate.spec.ts | 4 | 4 |
| real-agnes-experiment.spec.ts | 1 | 1 |
| smoke-runtime.spec.ts | 1 | 0 ✅ |
| store-cache.spec.ts | 2 | 2 |
| store.spec.ts | 1 | 1 |
| test-state-isolation.spec.ts | 3 | 3 |
| test-state-profile-namespace.spec.ts | 1 | 1 |

**5 additional files** previously contained `addBenchmark` calls but were
refactored during this audit to use the `seedLiveBenchmark` helper
(test/helpers/seed-live-benchmark.ts) — these are now clean:
`active-pointer.spec.ts`, `artifact-containment.spec.ts`,
`crash-consistency.spec.ts`, `cumulative-composition.spec.ts`,
`evolution-experiment.spec.ts`.

**Helper file:** `test/helpers/seed-live-benchmark.ts:78` — 1 call, **CLEAN** ✅
(follows the correct new API pattern exactly).

---

*Generated by `test/audit-addbenchmark.cjs` using the TypeScript compiler API.
Raw machine-readable results: `test/audit-results.json`.
Re-run anytime with: `node test/audit-addbenchmark.cjs`*
