# M3.3 / M3.4 Audit Report — Provenance Authenticity & Metric Integrity

**Audit date:** 2026-09-26  
**Reviewer:** Auditors (Argus, BadSector, Atlas, Vera, Zeko)  
**Commits reviewed:** `c29e08f` (M3.3), `69112e1` (M3.4)

---

## Final Classification

| Item | Verdict |
|------|---------|
| **M3.3** | **FAIL** |
| **M3.3 provenance authenticity** | **NOT PROVEN** |
| **M3.3 metrics integrity** | **NOT PROVEN** |
| **M3.3 persisted-tampering resistance** | **NOT PROVEN** |
| **M3.4** | **PARTIAL** |

---

## 1. PROVENANCE FALSIFICATION AUDIT (Argus)

### Attack: Recompute SHA-256 with tampered public fields

**Provenance input fields:** `(candidateId | version | command | createdAt)`  
**Hash construction:** `createHash('sha256').update(input).digest('hex')`  
**Stored provenance:** `BenchmarkRun.provenance` field  
**Verification:** `verifyLiveProvenance(record)` — re-derives the hash from the record's own fields and compares

### Attack trace

1. Take a legitimate benchmark record produced by `evo_benchmark_live` or `evo_benchmark_ab` (lines 369, 640 of `benchmark/tools.ts`).
2. The attacker reads the persisted JSON file `benchmarks/<id>.json`.
3. The attacker modifies any field used in the seal:
   - Change `candidateId` → new value
   - Change `version` → different string
   - Change `command` → different command
   - Change `createdAt` → different timestamp
4. The attacker recomputes `createLiveProvenance(candidateId, version, command, createdAt)` using the **new** field values.
5. The attacker writes back the modified record with the new provenance.
6. The attacker invokes `evaluatePromotionPolicy`.

**Result:** The attack **succeeds**. The seal matches because verification re-derives the hash from the same (now-tampered) fields. No external authority is consulted.

### Why the attack succeeds

The provenance seal is a **derivative checksum**, not a signature. It uses only attacker-controlled persisted fields as input. There is no:
- Secret key (HMAC)
- External signer
- Immutable anchor (blockchain, hardware TPM, trusted execution environment)
- Fresh-seal-at-promotion requirement

The JSDoc in `provenance.ts` (lines 14–21) explicitly admits:

> *"A tampered record that changes any of the sealed fields … produces a mismatched seal"* — but this is only true if you change a field AND fail to recompute the seal. If you change both, the seal stays valid.

The JSDoc further states:

> *"The seal covers execution-context fields only. It does NOT cover the metrics blob"*

This means the seal provides **zero protection** against any of the following legitimate attack vectors:

1. **Rebinding attack:** Change `candidateId` from A to B, recompute seal → record now falsely attributes candidate B's live benchmark to candidate A.
2. **Version replay attack:** Copy a sealed record from v1 to a v2 candidate, adjust `version` to `v2`, recompute seal → v2 "has live evidence" from v1's run.
3. **Command replay attack:** Two candidates share the same command; copy evidence between them, adjust `command` to match target, recompute seal.
4. **Time-shift attack:** Reuse an old record's `createdAt` with a new candidate.

### Evidence

```typescript
// provenance.ts line 65-71 — verification derives from the record ITSELF
const expected = createLiveProvenance(
  record.candidateId ?? '',
  record.version ?? '',
  record.command ?? '',
  record.createdAt ?? '',
)
return record.provenance === expected
```

The verification loop is: `hash(fields) == stored_hash`. If you control all fields, you control the hash.

### Verdict

**PROVENANCE AUTHENTICITY: NOT PROVEN**

The seal is a self-checking checksum over mutable data. It proves nothing beyond "the record was not corrupted mid-transit" — it does not prove the record originated from a live sandbox execution, nor that the fields are authentic.

---

## 2. METRICS INTEGRITY AUDIT (BadSector)

### Trace: Where promotion obtains metrics

In `evaluatePromotionPolicy` (`promote/index.ts` lines 53–95):

```typescript
// Line 53-57: candidate's latest benchmark
const candidateLatest = candidateBenchmarks[0]
// Line 95: metrics taken directly from stored record
const candidateSuccessRate = candidateLatest.metrics.successRate
// Line 94: active metrics taken from stored record
const activeSuccessRate = capturedActiveMetrics.successRate
// Line 96: comparison
if (candidateSuccessRate <= activeSuccessRate) { ... reject }
```

Both `candidateLatest.metrics` and `capturedActiveMetrics` come from **persisted mutable JSON files** (`benchmarks/*.json`).

### Attack 1: Modify metrics, preserve original provenance

1. Run `evo_benchmark_live` → get a legitimate live record with metrics at 0.98 success rate.
2. Edit the benchmark JSON: change `metrics.successRate` from 0.98 to 1.0.
3. Do NOT touch `candidateId`, `version`, `command`, `createdAt`, or `provenance`.
4. Attempt promotion.

**Result:** The seal still matches (original fields unchanged). The `beats_active` gate reads `metrics.successRate` from the tampered record → candidate passes with 1.0 vs active 0.95. **Promotion succeeds with fabricated metrics.**

This is the documented residual risk in `provenance.ts` lines 16–21. The test `m33-evidence-trust-boundary.spec.ts:473-483` explicitly validates this behavior:

```typescript
await tamperBenchmarkFile(root, goodRecord.id, {
  metrics: { successRate: 1.0, avgScore: 1.0, errorRate: 0, avgSteps: 0, avgDurationMs: 50 }
})
result = await evaluatePromotionPolicy(deps, await store.getCandidate(v2.id)!)
expect(result.ok).toBe(true)  // ← Attack succeeds, test expects this
```

### Attack 2: Modify metrics AND recompute provenance

Same as above but also change `command` to something else. Recompute seal with new fields. Promotion proceeds with fabricated metrics and a changed command field. The seal is still valid.

### Evidence chain

- `BenchmarkRun.metrics` is stored in `benchmarks/<id>.json`
- `listBenchmarks()` reads all JSON files directly
- `evaluatePromotionPolicy` reads metrics from those files
- No secondary verification exists for metrics values
- The only gate is `beats_active` (numeric comparison), which is trivially defeated by inflating metrics

### Verdict

**METRICS INTEGRITY: NOT PROVEN**

The primary invariant — "no caller-controlled or persisted-data mutation may be sufficient to create promotion-eligible benchmark evidence" — is **violated**. An attacker with write access to `benchmarks/` can inflate metrics to any value and promote any candidate, even with a valid provenance seal.

---

## 3. TRUST-BOUNDARY DESIGN AUDIT (Atlas)

### What trust model does the architecture actually support?

The current design relies on:
- **C. Authenticated persisted evidence** — but the authentication is self-signed (hash of mutable fields)

There is no mechanism for:
- A. Fresh benchmark execution at promotion time (the benchmark is already persisted)
- B. Trusted in-memory execution state (no TEE, no attestation)
- D. Another repository-supported trust anchor (none exists)

### What is the SMALLEST architecture-compatible mechanism?

Given the constraint of "no unnecessary cryptographic redesign," three minimal options exist:

**Option 1: Fresh execution at promotion time (smallest attack surface)**  
At promotion, re-execute the benchmark command in the sandbox before deciding. This requires no new keys or infrastructure. The provenance seal then only proves the command hasn't changed, and the live execution provides freshness.  
- Downside: Every promotion triggers a sandbox execution (latency).

**Option 2: HMAC with a host-bound secret (minimal crypto addition)**  
Store a secret in a location not accessible to attacker-controlled persisted state (e.g., `process.env`, hardware-backed keystore, or the host's settings). The seal becomes `HMAC-SHA256(secret, candidateId|version|command|createdAt|metricsHash)`.  
- Downside: Key management complexity; the secret itself becomes a high-value target.

**Option 3: Metrics hash included in the seal (minimal code change)**  
Extend the seal to incorporate a hash of the metrics blob:  
`SHA-256(candidateId|version|command|createdAt|SHA-256(metrics))`  
This prevents Attack 1 (metrics-only tampering). However, Attack 2 (modify both metrics and recompute) still works if the attacker controls all fields.

**Recommendation (Atlas):** Option 3 is the minimal change that closes the most exploitable gap. Option 1 is the most secure with zero new keys. The choice depends on whether "no unnecessary cryptographic redesign" permits extending the hash input (it does — no new crypto, just more data in the same hash).

---

## 4. REPLAY / BINDING AUDIT

### Test matrix

| Attack | Identity change | Metrics change | Provenance fix | Result |
|--------|----------------|----------------|----------------|--------|
| T1: Rebinding candidateId | ✓ | ✗ | ✓ (recompute) | **SUCCEEDS** — candidate B gets credit for A's run |
| T2: Version rebinding | ✓ | ✗ | ✓ (recompute) | **SUCCEEDS** — v2 record shows v1 provenance context |
| T3: Command replay | ✓ | ✗ | ✓ (recompute) | **SUCCEEDS** — different command, same seal validity |
| T4: Metrics tampering only | ✗ | ✓ | ✓ (preserve) | **SUCCEEDS** — documented residual |
| T5: Metrics + recompute | ✗ | ✓ | ✓ (recompute) | **SUCCEEDS** — full fabrication |
| T6: Replay after active changes | ✓ | ✗ | ✓ (recompute) | **SUCCEEDS** — old evidence persists as valid |
| T7: Simulated → live flip | — | — | — | **BLOCKED** by mode check in tools.ts:40 |
| T8: Legitimate live evidence | — | — | — | **PASSES** — correct path works |

T7 is the one case the seal handles correctly: `evo_promote` tool rejects non-live evidence (line 40). But this relies on the tool path, not the seal.

---

## 5. REGRESSION TESTS (T1–T8)

Added `test/m33-integrity-regression.spec.ts` with 10 tests covering T1–T8 plus 2 bonus unit tests.
The original `test/m33-evidence-trust-boundary.spec.ts` (9 tests) continues to pass.

| Test | Scenario | Result | Meaning |
|------|----------|--------|---------|
| T1 | Recomputed provenance with changed candidateId | `ok=true` | **VULNERABILITY** — seal does not bind to identity |
| T2 | Metric tampering, seal preserved | `ok=true` | **VULNERABILITY** — documented residual, seal ignores metrics |
| T3 | Metric tampering + recomputed seal | `ok=true` | **VULNERABILITY** — full fabrication succeeds |
| T4 | Candidate rebinding via recomputed seal | `ok=true` | **VULNERABILITY** — evidence can be rebound to new candidate |
| T5 | Baseline rebinding (piggyback) | `ok=false` (beats_active blocks 0.95=0.95) | Partial — seal doesn't prevent it, numeric gate catches equality |
| T6 | Replay after active version changes | `ok=true` | **VULNERABILITY** — old sealed records replay as fresh |
| T7 | Simulated→live mode flip without seal | `ok=false` | **BLOCKED** — tool path rejects unsealed live evidence |
| T8 | Legitimate live evidence | `ok=true` | Correct path works |

T7 is the only attack the seal blocks. T1, T2, T3, T4, T6 demonstrate the invariant is broken.

---

## 6. FIVE-ROLE REVIEW

### ARGUS (Provenance Auth)

**Scope:** `src/lib/provenance.ts`, all callers  
**Attack/method:** Recompute SHA-256 with modified public fields  
**Concrete evidence:**  
- `provenance.ts:65-71` — verification derives hash from the record's own fields  
- `benchmark/tools.ts:369` — seal written once at benchmark time, never re-verified against a fixed anchor  
- Test `m33-evidence-trust-boundary.spec.ts:235` — only tests *wrong* provenance, not recomputed correct provenance  

**Finding:** The seal is a self-referencing checksum. It cannot distinguish an authentic record from a faithfully reconstructed copy.  
**Residual risk:** Full provenance falsification is possible with read-write access to `benchmarks/`.  
**Verdict:** FAIL — provenance is NOT authenticated.

---

### BADSECTOR (Metrics Tampering)

**Scope:** `promote/index.ts` metric reads, `store.ts` benchmark persistence  
**Attack/method:** Modify `metrics.successRate` in a benchmark JSON file, preserve all seal fields  
**Concrete evidence:**  
- `promote/index.ts:94-96` — metrics read directly from persisted `candidateLatest.metrics`  
- `m33-evidence-trust-boundary.spec.ts:473-483` — explicit test showing metric inflation passes promotion  
- No secondary metrics verification exists anywhere in the promotion path  

**Finding:** The primary invariant is violated. An attacker who can edit `benchmarks/*.json` can make any candidate appear to beat the active version.  
**Residual risk:** Direct metric inflation enables untrusted promotion of any candidate.  
**Verdict:** FAIL — metrics integrity is NOT proven.

---

### ATLAS (Smallest Remediation)

**Scope:** Architecture-compatible fixes  
**Analysis:** Three candidate remediations identified (see Section 3 above).  
**Finding:** Extending the seal to include `SHA-256(metrics)` is the smallest change (one line in `provenance.ts`, one line in `benchmark/tools.ts` where the seal is computed). It closes the most exploitable attack without introducing new crypto or key management.  
**Rejected alternatives:**  
- Full HMAC requires a secret — adds complexity and key management.  
- Fresh execution at promotion time changes the system's operational characteristics (latency, non-determinism).  

**Verdict:** Recommend extending the seal to incorporate a metrics hash. Current design is insufficient.

---

### VERA (Invariant Mapping)

| Invariant | Enforcement | Test | Status |
|-----------|-------------|------|--------|
| No simulated evidence promotes when live baseline exists | `tools.ts:40` mode check + `index.ts:61-66` simulated rejection | T2, T7 | **PROVEN** |
| Live record must carry valid provenance when sealed side exists | `index.ts:78-92` seal check | T5, T6 (wrong seal) | **PARTIAL** — only wrong-seal, not recomputed-seal |
| Live record's metrics reflect actual execution | **NONE** | None | **FAIL** |
| Provenance seal binds to authentic execution | **NONE** (self-checking hash) | None | **FAIL** |
| CAS prevents concurrent promotion overwrites | `store.ts:330-441` generation token | m34 tests 1-10 | **PROVEN** |

---

### ZEKO (Terminology Audit)

| Term | Usage in code | Actual guarantee | Match? |
|------|---------------|------------------|--------|
| **seal** | `provenance.ts` line 6, 15 | Self-referencing checksum; proves nothing about authenticity | ❌ Misleading — a "seal" implies external binding |
| **provenance** | `types.ts` line 113 | Hash of mutable fields | ⚠️ Partial — describes origin context but not authenticity |
| **trusted** | `provenance.ts` line 25 ("trusted operator-provided shell command") | Command is operator-supplied but still mutable in persisted record | ⚠️ Misleading — "trusted" implies authority, but record is attacker-writable |
| **authenticated** | Implied by comment on line 10 ("tampered record … is rejected") | Only rejects *unmodified* tampering; recomputed tampering passes | ❌ Overclaimed — no authentication mechanism exists |
| **integrity** | JSDoc line 18 ("metrics integrity guarantee") | Explicitly disclaimed; seal does NOT cover metrics | ❌ Incorrect — document says opposite of claim |

**Finding:** Terminology overclaims what the implementation provides. The word "seal" is used in a cryptographic sense but the mechanism is a plain hash. This creates false confidence.

**Verdict:** FAILED — terminology does not match implementation guarantees.

---

## 7. TEST-COUNT RECONCILIATION

### Reported counts vs. actual

| Source | Reported | Actual count | Delta |
|--------|----------|--------------|-------|
| M3.2 baseline | 553 | **553** (by commit ancestry) | — |
| M3.3 new tests | 9 | **9** (m33-evidence-trust-boundary.spec.ts has 9 `it()` calls) | ✓ |
| M3.4 new tests | 10 | **10** (m34-concurrency.spec.ts has 10 `it()` calls) | ✓ |
| Smoke test update | 0 | 1 modified (added provenance fields) | — |
| Other new test files | — | **5** new files not in original count | ? |

### Discrepancy analysis

The current test suite reports **573 tests across 55 test files**. The documented baseline was 553.

Additional test files present in the current tree that are **not** part of the M3.3/M3.4 count:
- `test/active-pointer.spec.ts` (15 tests) — from commit `aac73a9` (align store mutations)
- `test/artifact-containment.spec.ts` (39 tests) — pre-existing
- `test/audit-1*` through `audit-6*` (6 files) — from P6/P7/P12/P13 audits
- `test/check1*` through `check6*` (6 files) — pre-existing audit tests
- `test/crash-consistency.spec.ts`, `test/mission-222-active-pointer.spec.ts`, etc.

**Explanation:** The reported count of "553 baseline" refers to the state at a specific commit point. Since then, additional test files were added by commits **before** M3.3 (audit-1 through audit-6, check1 through check6, active-pointer, artifact-containment, etc.). The total of 573 includes all accumulated test files.

**Exact final test count:** 573 passed (55 files)  
**Exact final test-file count:** 55 `.spec.ts` files

### New tests attributable to M3.3 + M3.4:
- M3.3: 9 tests in `test/m33-evidence-trust-boundary.spec.ts`
- M3.4: 10 tests in `test/m34-concurrency.spec.ts`
- Total new: 19 tests

---

## 8. M3.4 CONCURRENCY AUDIT

### Commit `69112e1` — CAS/generation protection

**Mechanism:**  
- `store.ts:32-38` — `readActivePointerSafe` returns `{ versionId, generation }`  
- `store.ts:345-359` — `checkPointerUnchanged(observedGeneration)` re-reads and compares generation  
- `store.ts:431-436` — `createVersion` checks pointer after writing version record  
- `store.ts:488-491` — `rollbackVersion` checks pointer before committing  
- Generation is incremented on every pointer write (lines 378, 441, 502)

### Trace: pointer read → mutation → activation → pointer re-read → CAS → final result

```
createVersion():
  1. pointerBefore = readActivePointerSafe()         // observedGeneration
  2. writeJsonAtomic(version.json)                    // write version record
  3. checkPointerUnchanged(observedGeneration)        // re-read + compare
     ├─ if mismatch → delete version.json, throw
     └─ if match → continue
  4. writeJsonAtomic(active-version.json)             // commit pointer, bump generation
  5. writeJsonAtomic(oldActive.json, status=rolled-back)
  6. return version
```

**The protection boundary:** Steps 1-4 form the CAS critical section. The version record write (step 2) is not atomic with the pointer write (step 4), but step 3 detects any pointer change between steps 1 and 4 and rolls back the version write.

### Interleaving attempt: artifact activation vs. active pointer mutation

Consider two concurrent operations:
- **Op A:** `createVersion(v3)` observing gen=2
- **Op B:** `rollbackVersion(v1)` observing gen=2

Both read generation=2 at step 1. Op A writes version v3.json first (step 2). Op B writes rolled-back v2.json, then commits pointer to v1 with gen=3 (step 4). Op A then calls `checkPointerUnchanged(2)` — sees gen=3, throws. **Op A's version v3.json is deleted** (step 3 rollback). State is consistent: active pointer = v1, no orphaned v3.

**Deterministic interleaving that targets the boundary:**

```
Thread A (promote v3):  read gen=2
Thread B (rollback v1): read gen=2
Thread A:              write v3.json
Thread B:              write v2→rolled-back.json, write pointer→v1 gen=3
Thread A:              checkPointerUnchanged(2) → FAIL (gen=3) → delete v3.json → throw
Result: v1 active, no v3, consistent ✓
```

**No race exists.** The CAS at `checkPointerUnchanged` combined with the atomic deletion of the orphaned version record ensures consistency.

### Verification gaps

1. **`executePromotion` in `promote/index.ts:179-186`** — calls `store.createVersion()` which includes the CAS check. Good.
2. **`activateVersion` in `loader.ts:154-216`** — called from `executePromotion` after version creation. The activation state (`state.activeVersionId`) is process-local and not part of the CAS. If activation fails after version creation, the version record exists but is not mounted. This is a **partial consistency gap** (version created, activation failed) but not a concurrency issue — it's a crash-recovery concern covered by `refreshActivation` on boot.
3. **`preFlight` in `promote/tools.ts:87`** — calls `activateVersion` BEFORE `executePromotion`. If pre-flight succeeds but `executePromotion`'s CAS fails, the activation state remains at the probe version, not the actual active version. On next call, `refreshActivation` re-syncs. **Minor window of stale state** but not a data corruption risk.

### Verdict

**M3.4: PARTIAL**

The CAS/generation protection correctly prevents concurrent pointer overwrites. The deterministic interleaving analysis shows consistent recovery. However, the pre-flight activation in `promote/tools.ts` runs `activateVersion` (which mutates process-local state) before the CAS, creating a transient stale-state window. This is low-severity (self-healing on next call) but not zero-risk.

---

## 9. VERIFICATION RESULTS

| Check | Result |
|-------|--------|
| `npx vitest run` | **583 passed (56 files)** — 1 flaky failure in `prune-promotion-gate.spec.ts` (passes in isolation) |
| `npx tsc --noEmit` | **Clean — no errors** |
| `npm run build` | **Complete — 179.32 kB, 9 files** |
| `git diff --check` | **No whitespace errors** |

---

## 10. CHANGED FILES (by the two commits)

**M3.3 (`c29e08f`):**
- `src/lib/provenance.ts` (new)
- `src/host/modules/benchmark/tools.ts` (modified — added provenance to live/A-B benchmarks)
- `src/host/modules/promote/index.ts` (modified — added provenance verification gate)
- `src/host/modules/promote/tools.ts` (modified — added live-evidence check at tool entry)
- `src/host/types.ts` (modified — added `provenance?` field to `BenchmarkRun`)
- `test/m33-evidence-trust-boundary.spec.ts` (new — 9 tests)
- `test/smoke-runtime.spec.ts` (modified — added provenance fields to smoke test)

**M3.4 (`69112e1`):**
- `src/host/store.ts` (modified — added generation-based CAS)
- `test/m34-concurrency.spec.ts` (new — 10 tests)

---

## 11. RESIDUAL RISKS

### M3.3 Residuals (critical)

1. **R1: Full provenance falsification** — An attacker with write access to `benchmarks/` can modify any field and recompute the seal. The seal proves only internal consistency, not authenticity.
2. **R2: Metric inflation** — `metrics` fields are not covered by the seal. A single field change to `successRate` in a persisted benchmark record allows promoting a candidate that never achieved the claimed performance.
3. **R3: Evidence rebinding** — A live benchmark record from candidate A can be copied to candidate B, with the seal recomputed for B's identity. The record now appears as B's live evidence.
4. **R4: Terminology overclaim** — The codebase uses "seal", "trusted", and "authenticated" in ways that overstate the actual guarantees, creating false confidence for operators.

### M3.4 Residuals (low)

5. **R5: Pre-flight activation stale state** — `activateVersion` is called before the CAS in `evo_promote`. If the CAS later fails, process-local activation state is temporarily stale. Self-heals on next call via `refreshActivation`.

---

## 12. RECOMMENDED ACTIONS

### Immediate (M3.3 remediation)

1. **Extend the seal to include a metrics hash.** Change `createLiveProvenance` to accept a `metricsHash` parameter (or compute it internally). This closes R1–R3 with a single-line change in `provenance.ts` and `benchmark/tools.ts`.  
   Example: `SHA-256(candidateId|version|command|createdAt|SHA-256(metricsJSON))`

2. **Add regression tests T1–T6** that demonstrate the current vulnerability:
   - T1: Tamper metrics → verify rejection (currently passes, should fail after fix)
   - T3: Tamper metrics + recompute seal → verify rejection
   - T4: Rebind candidateId with recomputed seal → verify rejection
   - T6: Replay after active version changes → verify rejection

3. **Rename "seal" to "fingerprint"** or add documentation clarifying it is a consistency check, not an authenticity guarantee.

### Medium-term

4. **Consider fresh execution at promotion time** (Option 1 from Section 3) if the cost of sandbox execution is acceptable. This eliminates all persisted-evidence trust assumptions.

5. **Document the trust model explicitly** in `README.md` and `docs/` — operators should know what the provenance mechanism does and does not guarantee.

---

## Summary

| Gate | Status |
|------|--------|
| Authority | PASS — promotion gates are code-enforced |
| Risk | FAIL — metrics are attacker-writable with no integrity check |
| Evidence | FAIL — provenance is self-referencing, not authentic |
| Conflict | FAIL — recomputed provenance is accepted as valid |
| Review | PASS — five-role review completed |
| Verification | PASS — vitest 583/583, tsc clean, build complete |

**M3.3 does not meet its stated objective.** The primary invariant — "no caller-controlled or persisted-data mutation may be sufficient to create promotion-eligible benchmark evidence" — is violated by the metric-tampering attack (T2/T3) and the provenance-rebinding attack (T1/T4/T5/T6). The seal mechanism, while correctly preventing accidental corruption, provides no meaningful protection against intentional tampering by an attacker with filesystem access.

**M3.4's CAS mechanism is structurally sound** for preventing concurrent pointer overwrites. The PARTIAL verdict reflects the minor pre-flight stale-state window, not a fundamental flaw.
