# M3.3 — Trust Boundary Audit (Mission 3.3.2)

**Commit:** `c29e08f`
**Date:** 2026-09-26
**Status:** NOT READY FOR IMPLEMENTATION — design gap is structural, not cosmetic

---

## THREAT MODEL

| Question | Verdict | Evidence |
|----------|---------|----------|
| Can an untrusted actor modify benchmark JSON? | **PROVEN: YES** | Store persists plaintext JSON under state root (`src/host/store.ts:290-309`). No integrity protection on write or read path. |
| Can that actor invoke benchmark tools? | **PROVEN: YES** | `registerToolSafe` (`src/host/dsh.ts:83-93`) has no auth gate. Any caller in the host process can invoke tools. |
| Can that actor invoke promotion? | **PROVEN: YES** | Four paths: `evo_promote` tool, `runPromotionPolicy` export (called by `evo_full_cycle`), direct module import. All without authentication. |
| Do benchmark and promotion run in the same process? | **PROVEN: YES** | Single `ModuleDeps` instance; shared `EvolutionStore`; same `stateRoot` directory. |
| Can promotion happen after restart? | **PROVEN: YES** | Promotion writes `active-version.json` pointer (`store.ts:439-442`) and `versions/vN/manifest.json`. Host boots and re-mounts from disk (`loader.ts:249-274`). |
| Is there any protected secret/key/trust anchor? | **PROVEN: NO** | Grep for `HMAC`, `Ed25519`, `RSA`, `secret`, `privateKey` → zero matches in `src/`. Only `crypto.createHash('sha256')` (`provenance.ts:1,38`) and `randomBytes` (`ids.ts:5`). |
| Can promotion cheaply perform a fresh benchmark? | **PROVEN: YES** — but degrades silently | `evo_benchmark_live` fails with "sandbox not available" if bwrap is absent. `evo_full_cycle` falls back to `evo_benchmark_run` (simulated) at `evolution/tools.ts:265-279`. |

**Residual assumption (UNKNOWN):** Whether `stateRoot` is writable by the candidate process when running *outside* the sandbox. If candidate files have host-level write access, the seal check is a no-op regardless of design. This is not answerable from the codebase alone.

---

## CURRENT EVIDENCE PATHS

### Path 1: `evo_benchmark_live` → promotion (the intended path)
```
evo_benchmark_live (benchmark/tools.ts:240-414)
  → mkdtemp + writeCandidateFiles (tmp dir)
  → sandbox.exec(command, {cwd: contained})
  → classifyOutcome(result, expectedExitCode, expectedOutput)
  → createLiveProvenance(candidateId, parentVersion, command, createdAt)
  → store.addBenchmark({mode:'live', provenance: seal, ...})
    [store overwrites createdAt via this.nowFn() — SEPARATE CLOCK READ]
  → store.updateCandidate(candidateId, {status:'benchmarked'})
```

At promotion:
```
evo_promote (promote/tools.ts:35-44)
  → listBenchmarks(500) → read all JSON files verbatim (no seal revalidation)
  → filter by candidateId, sort by createdAt desc
  → if mode !== 'live' → reject (hard gate)
  → evaluatePromotionPolicy (promote/index.ts:26-105)
    → capture active metrics
    → seal check: if candidateSealed || activeSealed → verifyLiveProvenance(candidateLatest)
    → beats_active: candidateSuccessRate > activeSuccessRate
  → executePromotion → createVersion → refreshActivation
```

### Path 2: `evo_benchmark_ab` → promotion (same structure)
```
evo_benchmark_ab (benchmark/tools.ts:417-663)
  → same live sandbox execution pattern
  → createLiveProvenance(candidateId, parentVersion, command, createdAt)
  → store.addBenchmark({mode:'live', provenance: seal, ...})
```

Same promotion path as Path 1.

### Path 3: `evo_benchmark_run` (simulated — cannot promote when active has live evidence)
```
evo_benchmark_run (benchmark/tools.ts:160-204)
  → reads experiences from store
  → computes metrics = proxy population from experience count
  → store.addBenchmark({mode:'simulated', ...})  ← no provenance seal
  → updateCandidate({status: verdict.passed ? 'benchmarked' : 'rejected'})
```

### Path 4: `evo_full_cycle` (autonomous path)
```
evo_full_cycle (evolution/tools.ts:109-359)
  → observe → analyze → propose → build(LLM) → validate → sandbox→ benchmark
  → Step 6: tries evo_benchmark_live first
  → Step 7 fallback: if live fails, calls evo_benchmark_run (simulated)
  → Step 8: if !benchmarkPassed → reject; else updateCandidate({status:'benchmarked'})
  → runPromotionPolicy (promote/index.ts:210-221)
    → evaluatePromotionPolicy (policy gate)
    → executePromotion (mutation)
```

**Key observation:** The full-cycle path bypasses `evo_promote`'s hard gate (`tools.ts:40`) because it calls `runPromotionPolicy` directly. The policy gate only rejects simulated evidence when `capturedActiveMetrics` is defined — for the first-ever version (no active baseline), simulated evidence **can promote**.

### Path 5: `evo_promote_decision` (advisory only)
```
evo_promote_decision (promote/tools.ts:202-367)
  → accepts allowSimulated:true (returns PROMOTE recommendation from simulated)
  → reads latest.metrics directly from JSON (no seal check)
  → advisory return only — cannot mutate state
```

**Who controls each path:**

| Path | Source | Who Controls | Trust Established | Trust Consumed |
|------|--------|-------------|------------------|----------------|
| Live benchmark | `benchmark/tools.ts:368-392` | The tool itself (in-process) | `createLiveProvenance` called at tool runtime | `verifyLiveProvenance` at promotion |
| A/B benchmark | `benchmark/tools.ts:625-643` | The tool itself | Same as live | Same as live |
| Simulated benchmark | `benchmark/tools.ts:192-201` | The tool itself | None (by design) | `mode='simulated'` check at promotion |
| Direct JSON write | `<root>/benchmarks/<id>.json` | Any filesystem writer | None | `verifyLiveProvenance` (self-referential) |

---

## CURRENT BYPASSES

Six attacks were executed and traced to promotion. The regression test file `test/m33-integrity-regression.spec.ts` encodes each attack's outcome.

### Attack A: Recomputed seal with changed fields
- Mutation: change `command`, `createdAt` on a sealed record; recompute seal with new values
- Verification: `verifyLiveProvenance` recomputes from current fields → MATCHES (attacker controls all inputs)
- Policy: seal gate passes → beats_active uses attacker-controlled `metrics`
- Outcome: **PROMOTION SUCCEEDS**
- Test reference: T1 (`m33-integrity:102`) — currently asserts `typeof result === 'object'` (accepts pass)

### Attack B: Metrics tampering with original hash preserved
- Mutation: change `metrics.successRate` from 0.90 → 1.0 on a sealed record; leave seal untouched
- Verification: seal recomputed from unchanged `(candidateId, version, command, createdAt)` → MATCHES
- Policy: `beats_active` reads tampered `metrics.successRate = 1.0` → passes if active < 1.0
- Outcome: **PROMOTION SUCCEEDS**
- Test reference: T2 (`m33-integrity:136`) — currently asserts `result.ok === true`; explicitly documented residual in `provenance.ts:14-21`

### Attack C: Metrics tampering + recomputed seal
- Mutation: change `metrics.successRate` AND `command`; recompute seal
- Verification: seal recomputed from attacker-chosen fields → MATCHES
- Policy: seal passes → beats_active uses inflated metrics
- Outcome: **PROMOTION SUCCEEDS**
- Test reference: T3 (`m33-integrity:173`) — currently asserts `result.ok === true`

### Attack D: Copy evidence candidate A → B without recomputing seal
- Mutation: write A's record under B's candidateId, leave A's seal
- Verification: `verifyLiveProvenance` recomputes with B's candidateId → MISMATCH → FALSE
- Policy: rejected at line 84-91
- Outcome: **PROMOTION REJECTED** (this is the one attack the seal catches)
- Test reference: m33-evidence-trust-boundary test 6 (`m33-evidence-trust:265-324`)

### Attack E: Rebind A's evidence to B with recomputed seal
- Mutation: copy A's benchmark to B; set `candidateId=B`, `version=B-version`; recompute seal
- Verification: seal recomputed for B's identity → MATCHES
- Policy: seal passes → `beats_active` compares B's copied successRate (0.97) vs active (0.95) → passes
- Outcome: **PROMOTION SUCCEEDS**
- Test reference: T4 (`m33-integrity:206`) — currently asserts `result.ok === true`

### Attack F: Replay old evidence after active version changes
- Mutation: take v1-era sealed record; write it under v3 candidate with `version=v0`; recompute seal
- Verification: seal matches B's identity tuple → MATCHES
- Policy: no version-baseline freshness check in `evaluatePromotionPolicy`; only numeric `successRate` comparison
- Outcome: **PROMOTION SUCCEEDS**
- Test reference: T6 (`m33-integrity:274`) — currently asserts `result.ok === true`

### Additional latent bug: `createdAt` race condition
- Location: `benchmark/tools.ts:368-369` (tool computes `new Date().toISOString()`) vs `store.ts:294` (store calls `this.nowFn()` again)
- Effect: under I/O delay, the seal's `createdAt` and the stored record's `createdAt` can differ by milliseconds → `verifyLiveProvenance` **rejects legitimate live benchmarks**
- Status: not exercised in any test (tests hand-build records with known `createdAt`)
- Severity: medium — breaks legitimate use but not an attacker vector per se

---

## INVARIANT MATRIX

| Invariant | Verdict | Key Code Location | Gap |
|-----------|---------|-------------------|-----|
| **I1 ORIGIN**: Evidence attributable to approved execution | **PARTIAL** | `benchmark/tools.ts:368-392`, `provenance.ts:31-39` | Seal does not bind to actual sandbox event. No verification that record was produced by the approved tool path vs. a hand-crafted JSON file. |
| **I2 METRICS**: Promotion cannot use attacker-modified metrics | **FAIL** | `provenance.ts:14-21`, `promote/index.ts:95` | `metrics` is excluded from seal input by design. Test #8 and T2 confirm: attacker inflates `successRate` to 1.0, seal still passes, promotion succeeds. |
| **I3 CANDIDATE BINDING**: Evidence belongs to exact candidate | **PROVEN** | `provenance.ts:66`, `promote/index.ts:55` | Seal includes `candidateId` as first input. Copying a record without recomputing seal fails (`verifyLiveProvenance` → false). Caveat: mutating candidate `files`/`tests` after benchmarking does not break the seal. |
| **I4 BASELINE BINDING**: Evidence belongs to exact baseline | **PARTIAL** | `promote/index.ts:42-49, 80` | Baseline record's provenance is never verified — only read to decide whether the seal gate applies. Attacker can tamper with active baseline's `metrics.successRate` to make `beats_active` easier. |
| **I5 REPLAY**: Old evidence cannot satisfy different promotion context | **PARTIAL** | `provenance.ts:62`, `promote/index.ts:94-99` | Seal pins to `createdAt` but does not encode which active version was in force. No freshness window. Old record with valid seal + inflated metrics promotes against a weaker active version. |
| **I6 MODE**: Simulated/test evidence cannot satisfy production | **PARTIAL** | `promote/tools.ts:40-44`, `promote/index.ts:61` | Tool path blocks simulated → live flip. BUT `evo_full_cycle` calls `runPromotionPolicy` directly; on first promotion (no active baseline), simulated evidence CAN promote (gap in `evaluatePromotionPolicy` at line 40). Also `evo_promote_decision` has `allowSimulated:true` escape hatch. |

---

## TRUST ANCHOR OPTIONS

Evaluated against repository evidence. No mechanism is supported by the existing architecture.

### Option 1: Fresh trusted benchmark execution at promotion time
- **What is trusted:** Re-executing the benchmark command in the sandbox immediately before promotion
- **Why attacker cannot reproduce:** The sandbox executes in bubblewrap; the command is operator-provided; the output is captured fresh
- **Protects metrics?** Yes — metrics are derived from actual execution, not persisted JSON
- **Binds candidate/version?** Yes — executed against the candidate's actual files
- **Binds baseline/active?** Partially — would need to also execute active version's command and compare
- **Prevents replay?** Yes — each promotion creates fresh evidence
- **Survives restart?** Yes — runs at promotion time, not read from disk
- **Runtime cost:** High — doubles sandbox execution time per promotion; requires sandbox to be available
- **Architectural impact:** Add `verifyLiveEvidenceAtPromotion` step in `executePromotion`; requires sandbox to be available at promotion time
- **Operational assumptions:** Sandbox must be available; if unavailable, promotion must fail closed (not fall back to simulated)
- **Verdict:** Viable but expensive. Closes all six invariants. Requires sandbox at promotion time.

### Option 2: Protected authenticated persisted evidence (HMAC/signature)
- **What is trusted:** A signing key held outside the state root (e.g., in host config, not in plugin state)
- **Why attacker cannot reproduce:** Attacker has write access to state root but NOT to the signing key
- **Protects metrics?** Yes — metrics are part of the signed payload
- **Binds candidate/version?** Yes — included in signed payload
- **Binds baseline/active?** Yes — `activeVersionId` added as sealed input
- **Prevents replay?** Yes — signed payload includes context hash or timestamp
- **Survives restart?** Yes — signature verified on read
- **Runtime cost:** Low — one HMAC computation at write, one at verification
- **Architectural impact:** Key must live in host config (not plugin state); `createLiveProvenance` becomes `signBenchmarkRecord`; `verifyLiveProvenance` verifies signature against host-held key
- **Operational assumptions:** Key must be provisioned by operator; key rotation is a lifecycle concern; state roots created before key introduction need migration path
- **Verdict:** Best cost-performance ratio. Requires a new trust primitive (a key). Not present in current architecture.

### Option 3: Trusted in-memory execution state
- **What is trusted:** In-memory benchmark results not persisted to JSON, accessible only via tool call
- **Why attacker cannot reproduce:** Results never written to attacker-writable disk
- **Protects metrics?** Yes — metrics are in-process memory
- **Binds candidate/version?** Yes — bound to the tool invocation
- **Binds baseline/active?** No — in-memory state is lost on restart
- **Prevents replay?** Partially — replay requires in-memory state to still exist
- **Survives restart?** **NO** — in-memory state is lost
- **Runtime cost:** None (no disk I/O for evidence)
- **Architectural impact:** Evidence stored only in process memory; no persistence layer for benchmarks
- **Verdict:** Reject. Does not survive restart — violates the requirement that promotion can happen after restart.

### Option 4: Existing protected runtime/repository mechanism
- **What exists:** Search for `HMAC`, `Ed25519`, `RSA`, `secret`, `key` in plugin source → **zero matches**. No protected runtime mechanism exists in the plugin.
- **Verdict:** Reject — no existing mechanism to build on.

### Option 5: Host-supplied audit log (hash chain)
- **What is trusted:** A hash-chained append-only log written by the host process (not the plugin)
- **Why attacker cannot reproduce:** Log is external to state root; host process signs/appends; plugin reads and verifies
- **Protects metrics?** Yes — each log entry contains a hash of the full record including metrics
- **Binds candidate/version?** Yes — included in log entry
- **Binds baseline/active?** Yes — can include `activeVersionId` at time of benchmark
- **Prevents replay?** Yes — log entries are append-only with chain integrity
- **Survives restart?** Yes — log persists on disk outside state root
- **Runtime cost:** Moderate — host maintains separate log file; plugin verifies chain on read
- **Architectural impact:** Requires host to maintain audit log; plugin reads log entries and verifies chain; `verifyLiveProvenance` checks log membership instead of self-referential hash
- **Verdict:** Strongest guarantee. More complex than Option 2. Best for high-trust scenarios.

---

## PREFERRED DESIGN

**Chosen: Option 2 — HMAC-signed benchmark records with a host-held key.**

### Why this design

The seal in M3.3 (`SHA-256(candidateId | version | command | createdAt)`) is a **self-referential consistency digest**, not a trust anchor. It proves internal consistency among fields the attacker can freely rewrite in the same JSON file. Extending the seal to include `metrics` (Option 2a: minimal fix) closes the most exploitable gap (I2 FAIL) but still does not close the structural gap (attacker can recompute the entire seal including metrics hash).

Option 2 (HMAC with host-held key) closes ALL six invariants with minimal architectural change:
- The key lives in host configuration (`cordis.patch.yml` or env), NOT in the plugin state root
- The seal input becomes: `candidateId | version | command | createdAt | SHA-256(metrics)` (metrics inclusion closes I2)
- The verification uses HMAC-SHA256(key, input) instead of raw SHA-256(input)
- Attacker can still recompute the input string, but cannot produce the correct HMAC without the key
- The seal becomes an authenticity check, not just a consistency check

### Why other options are rejected

- **Option 1 (fresh execution):** Closes all invariants but requires sandbox at promotion time. Adds significant latency and a new dependency (sandbox must be available). Also, `evo_full_cycle` already falls back to simulated when sandbox is unavailable — promoting would block the entire auto-evolution path. Too expensive for the common case.
- **Option 3 (in-memory):** Fails restart survival.
- **Option 4 (existing mechanism):** Nothing to build on.
- **Option 5 (host audit log):** Stronger than Option 2 but requires host-side changes (new append-only log format, host participation in benchmark lifecycle). Higher architectural impact for marginal benefit over HMAC.

### What the HMAC design looks like

```ts
// src/lib/provenance.ts — NEW
import { createHmac } from 'node:crypto'

// Key is injected from host config at boot time, never read from state root
let _signingKey: string | null = null

export function configureProvenanceKey(key: string): void {
  _signingKey = key
}

export function createLiveProvenance(
  candidateId: string,
  version: string,
  command: string,
  createdAt: string,
  metrics: BenchmarkMetrics,
): string {
  const metricsHash = createHash('sha256').update(JSON.stringify(metrics)).digest('hex')
  const input = `${candidateId}|${version}|${command}|${createdAt}|${metricsHash}`
  return _signingKey
    ? createHmac('sha256', _signingKey).update(input).digest('hex')
    : createLiveProvenanceSimple(input) // fallback for pre-key state
}
```

At promotion:
```ts
// verifyLiveProvenance now verifies the HMAC, not just internal consistency
// If key is absent (pre-M3.4 state root), fall back to checking seal presence
// + active baseline seal status (same bootstrap logic as today)
```

### Migration path
- Pre-M3.4 records (no key, no metrics in seal): marked `legacy=true`
- First benchmark with key present: re-signs all legacy records with new key (one-time migration)
- Key absent → promotion fails closed (no untrusted record can promote)
- Key present → all records verified against key

---

## PROMOTION TRUST BOUNDARY

### Primary trust boundary: `evaluatePromotionPolicy` in `src/host/modules/promote/index.ts:26-105`

This is the **exact function** where the system decides whether benchmark evidence is trustworthy enough to influence promotion:

```
INPUTS:
  deps: ModuleDeps (store, cfg, log, warn, ctx)
  candidate: CandidateModule (the candidate being evaluated)

TRUST CHECKS:
  Line 40:  if (activeBeforePromote?.modules?.length) → active baseline exists
  Line 42-49: Find active module's latest benchmark → capturedActiveMetrics
  Line 53-57: Find candidate's latest benchmark → candidateLatest
  Line 61-66:  if (capturedActiveMetrics && candidateLatest.mode === 'simulated') → REJECT
  Line 78-93:  if (candidate.mode === 'live'):
                 candidateSealed = candidateLatest.provenance !== undefined
                 activeSealed = activeModuleBenchRecord?.provenance !== undefined
                 if (candidateSealed || activeSealed) → verifyLiveProvenance(candidateLatest)
                   → false → REJECT with provenance error
  Line 94-101: candidateSuccessRate > activeSuccessRate (beats_active gate)

POLICY CHECKS:
  Line 61-66: simulated evidence rejected when active has live evidence
  Line 84-91: seal mismatch rejected
  Line 96-100: non-improving candidate rejected

PROMOTION EFFECT:
  { ok: true, activeMetrics } → caller proceeds to executePromotion
  { ok: false, error } → promotion blocked, no state mutation
```

### Secondary trust boundary: `evo_promote` tool in `src/host/modules/promote/tools.ts:35-44`

```
INPUTS: candidateId
TRUST CHECKS:
  Line 35-39: listBenchmarks → find latest
  Line 40-44: if (!latestEvidence || latestEvidence.mode !== 'live') → REJECT
POLICY CHECKS: None additional
PROMOTION EFFECT: Blocks if latest evidence is not live (stronger than policy gate alone)
```

### Verdict: NO REAL TRUST BOUNDARY EXISTS (structurally)

The `evaluatePromotionPolicy` function is the trust boundary **by intention** — it is the only place where evidence integrity is checked before promotion. However, the mechanism it uses (`verifyLiveProvenance`) is a self-referential hash over attacker-controlled fields. The boundary is **performative**: it looks like a lock but is actually just a consistency check on data the attacker also controls. The boundary exists in code but not in substance.

---

## IMPLEMENTATION PLAN

### Files/functions likely to change

| File | Change |
|------|--------|
| `src/lib/provenance.ts` | Replace `createLiveProvenance` with HMAC-based `createLiveProvenance` that takes `metrics` as input and signs with host-held key. Add `configureProvenanceKey(key)` for host wiring. |
| `src/host/modules/benchmark/tools.ts` | Pass `metrics` blob into `createLiveProvenance` at lines 369 and 640. Fix the `createdAt` race: compute seal AFTER `addBenchmark` returns and use the stored `createdAt` from the returned record. |
| `src/host/modules/promote/index.ts` | Update `verifyLiveProvenance` to use HMAC verification. Remove the `candidateSealed || activeSealed` bootstrap ORphan — if key is present, ALL live records MUST be HMAC-signed; unsealed records are rejected. |
| `src/host/index.ts` | Read key from config at boot; call `configureProvenanceKey(key)`. Fail boot if key is configured but empty. |
| `src/host/config.ts` | Add `evolution.provenance.key?: string` to config schema. |
| `test/m33-integrity-regression.spec.ts` | Update T1-T6 assertions: all should now assert `result.ok === false`. Add T9: attack with valid seal but no key. |
| `test/m33-evidence-trust-boundary.spec.ts` | Update test 8 (metrics tampering) to assert rejection. Fix test 4 (first version simulated) to account for new key requirement. |
| `docs/M33-M34-AUDIT-REPORT.md` | Document the new HMAC design, the key provisioning model, and the migration path from self-referential seals. |

### What data becomes authoritative
- The HMAC signature over `(candidateId, version, command, createdAt, SHA-256(metrics))` becomes the authoritative proof that a benchmark record was produced by an authorized process holding the signing key.
- The host-held signing key (from config, not state root) is the trust anchor.

### What persisted data must no longer be trusted
- Any benchmark record with `mode: 'live'` and no valid HMAC signature (when key is configured) must be rejected outright.
- Legacy self-referential seals (M3.3) are no longer accepted when the key is active — they become migration artifacts.

### Required candidate/baseline binding
- Candidate binding: `candidateId` in HMAC input (already present, still required)
- Baseline binding: add `activeVersionId` to HMAC input at benchmark time, so replaying an old benchmark against a different active version fails

### Replay handling
- Include `activeVersionId` in the HMAC input at the time of benchmark execution. If the active version changes between benchmark and promotion, the seal won't match the new active version's ID.
- Alternatively (lighter): add a `contextHash` field to the seal input that is derived from the active version's latest benchmark metrics — binds evidence to the promotion context.

### Metrics handling
- Include `SHA-256(JSON.stringify(metrics))` in the HMAC input. This closes I2 (the critical gap).

### Backward-compatibility considerations
- Pre-M3.4 state roots have no key and self-referential seals. On first key provisioning:
  1. Detect legacy state (no key in config)
  2. Require operator to run a migration: re-benchmark all active candidates to produce HMAC-signed records
  3. After migration, all future promotions require HMAC; legacy unsealed records are rejected
- The `createLiveProvenance` fallback (no key → self-referential SHA-256) must be removed post-migration, or the key must be mandatory for all live records.

### Required regression/falsification tests
- T1-T6: all currently-passing attacks must now assert `result.ok === false`
- T9: forged record with invalid HMAC → rejected
- T10: legitimate live record with valid HMAC → promotes
- T11: legacy record (pre-key) with no HMAC → rejected when key is active
- T12: replay of old HMAC-signed record against changed active version → rejected
- T13: `createdAt` race fix verified — seal uses stored `createdAt`, not tool-time `createdAt`

### Failure behavior
- Key missing + live record present → **fail closed**: promotion rejected with error "provenance key not configured; re-run benchmark to generate signed evidence"
- Key present + record has no HMAC → **fail closed**: rejection
- HMAC mismatch → **fail closed**: rejection with "provenance seal mismatch: evidence may have been tampered"
- Sandbox unavailable during live benchmark → **fail closed**: tool returns error; candidate status unchanged; no promoted version

---

## FIVE-ROLE REVIEW

### ARGUS — Origin/Trust-Boundary Attack
**Scope:** Can an attacker create a valid live benchmark record without executing in a sandbox?
**Method:** Traced three attack vectors through the full code path from JSON write to promotion decision.
**Concrete evidence:**
- Attack A (provenance theft): caught only when live active baseline with seal exists; bypassed by editing active baseline's JSON to remove its seal (index.ts:79-80: `activeSealed` becomes false → seal gate skipped)
- Attack B (version replay): **SUCCEEDS** — recomputed seal with new version string passes all checks (index.ts:84, provenance.ts:65-70)
- Attack C (fully forged): **SUCCEEDS** — attacker writes all four seal fields + seal from scratch; no sandbox invocation needed (index.ts:82-91)
**Finding:** The seal is a syntactic self-consistency check, not a trust anchor. The origin claim ("evidence is attributable to approved execution") is **not established** by the current mechanism.
**Residual risk:** First-version promotion with no active baseline; legacy unsealed state root; forward-compatibility path where key is introduced later.
**Verdict:** M3.3 PROVENANCE IS INCOMPLETE — seal detects accidental corruption but not deliberate forgery.

### BADSECTOR — Persisted JSON, Metrics, Rebinding, Replay
**Scope:** Attack the persistence layer and metrics integrity specifically.
**Method:** Executed 6 concrete mutation scenarios (A-F) tracing each through `addBenchmark` → `listBenchmarks` → `evaluatePromotionPolicy`.
**Concrete evidence:**
- Attack B (metrics-only tamper): confirmed by test #8 in m33-evidence-trust-boundary.spec.ts (line 467-483) and T2 in m33-integrity-regression.spec.ts (line 136-169) — both assert `result.ok === true`
- Attack F (replay after active changes): confirmed by T6 (m33-integrity:274-357) — `0.99 > 0.97` passes beats_active with no version freshness check
- Latent bug: `createdAt` race (tools.ts:368-369 vs store.ts:294) — seal uses tool-time `new Date()`, store overwrites with `nowFn()`; can cause legitimate records to fail verification
- `evo_benchmark_compare` serves as oracle for iterative metric inflation — attacker can verify each trial via tool output (tools.ts:221-236)
**Finding:** The metrics gap is the most exploitable vulnerability. It is documented in the JSDoc but unmitigated.
**Residual risk:** `createdAt` race breaks legitimate records; backward-compat carve-out (both sides unsealed) skips seal entirely.
**Verdict:** I2 (METRICS) **FAIL**. T1-T6, T2, T3, T4, T5, T6 all currently accept attack outcomes.

### ATLAS — Architectural Fit and Complexity
**Scope:** Is the seal justified by the threat model? Does complexity match guarantee?
**Method:** Compared what the seal actually does vs. what the call-site documentation claims.
**Concrete evidence:**
- Seal guarantees: accidental JSON corruption of four fields (real, narrow)
- Seal claims: "attacker tampering detected", "evidence may have been forged" (overstated)
- The `||` bootstrap (index.ts:82) is asymmetric — when candidate is sealed but active is not, active's unsealed metrics are used in `beats_active` with no integrity assertion surfaced to operator
- Self-referential nature: seal inputs all live in the same JSON the attacker writes; no external binding exists
**Finding:** The module's complexity (72 lines provenance.ts + ~20 lines benchmark/tools.ts + ~15 lines promote/index.ts) is low; the problem is not cost but **false confidence** — the seal looks like a lock while the decision is made in the back room.
**Residual risk:** The terminology ("seal", "tamper detection", "integrity", "live evidence") misleads operators into believing stronger guarantees exist than the mechanism provides.
**Verdict:** Mechanism is structurally unsuited for attacker-tamper detection. Rename to "consistency fingerprint" and re-scope; or replace with HMAC-based design.

### VERA — I1-I6 Invariant Mapping
**Scope:** Map each required invariant to actual enforcement.
**Method:** Traced each invariant through code to find gaps.
**Concrete evidence:**

| Invariant | Verdict | Gap |
|-----------|---------|-----|
| I1 ORIGIN | PARTIAL | Seal doesn't prove execution occurred; no verification that record was produced by approved tool path |
| I2 METRICS | **FAIL** | Metrics excluded from seal by design; test #8 confirms inflation to 1.0 passes promotion |
| I3 CANDIDATE | PROVEN | candidateId is first seal input; cross-candidate copy without recompute is rejected |
| I4 BASELINE | PARTIAL | Baseline provenance never verified; attacker can tamper active metrics to ease beats_active |
| I5 REPLAY | PARTIAL | No freshness window; no active-version binding; old record with valid seal re-promotes |
| I6 MODE | PARTIAL | Tool path blocks simulated flip; BUT evo_full_cycle bypasses tool gate; first-version simulated can promote |

**Finding:** Only I3 is fully proven. I2 is the hardest failure. I1, I4, I5, I6 are partially enforced with clear bypass paths.
**Verdict:** 1/6 invariants fully met; 4/6 partial; 1/6 failing.

### ZEKO — Terminology vs. Actual Guarantees
**Scope:** Check whether terms match the guarantees.
**Method:** Cross-checked each term used in code/docs against the actual mechanism.
**Concrete evidence:**

| Term | Implies | Delivers | Gap |
|------|---------|----------|-----|
| Provenance seal | WHERE evidence came from | That 4 record-internal fields are self-consistent | No origin attestation |
| Integrity | Metrics are protected | Metrics explicitly excluded | Dangerous |
| Tamper detection | All material tampering caught | Only seal-field + mode tampering caught | Metrics tampering undetected; unsealed records skip check |
| Live evidence | Actually executed live | mode field says "live" | No execution attestation |

**Finding:** The most consequential gap is the metrics exclusion (#2/#3): the seal was designed to stop post-write tampering, but the very attack an operator would rely on it for — editing `successRate` — still promotes successfully.
**Verdict:** Terminology overclaims. Code is honest in its JSDoc but surrounding framing (error messages, test names) creates false impression of stronger guarantees.

---

## RESIDUAL RISKS

1. **Key provisioning:** If the HMAC key is stored in the same directory as the state root (e.g., a config file under stateRoot), the attacker can also modify the key and re-sign records. The key MUST be provisioned from a location outside the attacker's write scope (e.g., host-level config, environment variable, or OS credential store).

2. **First-version promotion:** When no active version exists, `evaluatePromotionPolicy` skips the simulated-evidence gate. An attacker who forges a live benchmark for a first-time candidate can promote it. This is a pre-existing gap (before M3.3) that the HMAC design does not address — it requires operator consent for first promotion.

3. **Key rotation:** When the signing key changes, old records signed with the previous key become unverifiable. A migration path must support multiple active keys during transition.

4. **Forward compatibility:** If the key is lost or the key provider becomes unavailable, all promoted versions built on HMAC-signed evidence become unrevisable (cannot re-benchmark or rollback with valid evidence). Key backup is an operational requirement.

5. **`createdAt` race (latent bug):** `benchmark/tools.ts:368` computes `new Date().toISOString()` for the seal input, but `store.addBenchmark` at `store.ts:294` sets the record's `createdAt` via a second `new Date()` call. Under I/O delay, these can differ, causing `verifyLiveProvenance` to reject a legitimate record. Fix: compute the seal AFTER `addBenchmark` returns, using the stored `createdAt`.

---

## OPEN ASSUMPTIONS

1. **State root isolation (UNKNOWN):** We assume the state root is writable only by the host process. If any untrusted process (including a candidate running outside the sandbox) can write to `<stateRoot>/benchmarks/`, the HMAC key must be in a location that process cannot read. This is unverified from the codebase.

2. **Sandbox isolation of benchmark execution:** We assume the sandbox correctly isolates the benchmark command from the state root. If the sandbox leaks write access to the state root, the attacker can modify benchmark files from inside the sandbox, defeating the HMAC. This is assumed PROVEN based on `bubblewrap` usage (`sandbox/index.ts:16-100`) but not tested for state-root write-leakage.

3. **Operator intent for first promotion:** The first-ever promotion (no active baseline) currently allows simulated evidence through `evaluatePromotionPolicy` (when `capturedActiveMetrics` is undefined). Whether this should be tightened to require live evidence even on first promotion is a policy decision not addressed by the trust boundary design.

---

## DECISION

**NOT READY FOR IMPLEMENTATION**

The M3.3 provenance seal (commit `c29e08f`) addresses a real but narrow threat: accidental JSON corruption of the four sealed fields. It does NOT establish the trust boundary it was designed for — distinguishing trusted benchmark execution from attacker-controlled persisted evidence. The seal is a self-referential consistency digest over attacker-controllable fields; it provides no authenticity guarantee.

**Recommended next mission (M3.4 scope):**

1. Replace the self-referential SHA-256 seal with an HMAC-SHA256 signed by a host-held key (not in state root)
2. Include `SHA-256(metrics)` in the HMAC input to close I2
3. Include `activeVersionId` in the HMAC input to close I5 (replay) and strengthen I4 (baseline binding)
4. Fix the `createdAt` race condition in `benchmark/tools.ts:368-369`
5. Add migration path: detect legacy state, require operator to re-benchmark, then enforce HMAC on all new records
6. Close the `evo_full_cycle` simulated-evidence bypass on first promotion (T12 regression test)

**Immediate action for operators:** Until M3.4 is implemented, do not trust M3.3-sealed benchmark records as proof of authentic execution if the state root is accessible to any untrusted process. The seal detects accidental corruption; it does not prevent deliberate forgery.
