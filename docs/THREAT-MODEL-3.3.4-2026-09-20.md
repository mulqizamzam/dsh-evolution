# Threat Model + Security Scope — Mission 3.3.4

**Repository:** `dsh-evolution`  
**Date:** 2026-09-20  
**Source of truth:** `docs/RESEARCH-BENCHMARK-AUTHORITY-2026-09-19.md`  
**Status:** RESEARCH ONLY — no implementation, no commit, no code change.

---

## THREAT MODEL

### Actor-by-Actor Analysis

#### Actor A: Normal DSH Tool Caller
- **Can invoke:** All `evo_*` tools directly via the DSH tool registry (`registerToolSafe`, no auth gate). Confirmed by `docs/RESEARCH-BENCHMARK-AUTHORITY:99`: *"There is NO authentication gate at any tool registration layer."*
- **Can read:** Any benchmark JSON via `listBenchmarks()`, candidate JSON via `getCandidate()`, version JSON via `getActiveVersion()` — all files under `<stateRoot>/`.
- **Can write:** Can trigger `addBenchmark()` via `evo_benchmark_live` or `evo_benchmark_ab`; can trigger `addCandidate()` via `evo_candidate_create`; can trigger promotion via `evo_promote`.
- **Can modify:** Indirectly modifies state through tool calls. Cannot directly edit files from within the tool call path.
- **Trusted:** YES — the architecture treats the tool caller as the operator (or an agent the operator configured). No caller identity checking exists at any layer.
- **In threat model:** YES — but as a **trusted peer**, not an adversary. The architecture's design assumes the caller is the operator.

#### Actor B: Same-User Local Process
- **Can invoke:** Any Node.js module imported from the repo; can construct `EvolutionStore` directly; can call `createLiveProvenance()` (public hash, no secret).
- **Can read:** All files under `<stateRoot>/` (benchmarks/, candidates/, versions/, experiences/, patterns/). State root resolution (`src/lib/home.ts:26-50`) places it at `$DSH_HOME/dsh-evolution/<profile>` — an operator-owned directory.
- **Can write:** Direct filesystem access to all state root files. `writeJsonAtomic` provides atomic writes but zero access control.
- **Can modify:** Can read any benchmark record, compute a new seal for any chosen (candidateId, version, command, createdAt) tuple using the public `createLiveProvenance()` function, and write a forged record to `<stateRoot>/benchmarks/<id>.json`.
- **Trusted:** UNKNOWN — the repository does not distinguish Actor A from Actor B. Both are same-OS-user processes with identical filesystem access to the state root.
- **In threat model:** **PARTIAL** — the repository evidence does not establish whether this actor is intended to be in-scope. The seal mechanism (`provenance.ts:31-39`) is a public hash, meaning any same-user process can forge records. Whether this matters depends on the intended threat model, which the repository does not explicitly define.

#### Actor C: Benchmark Command / Candidate Code Inside Sandbox
- **Can invoke:** Only the command string provided by the caller, executed inside `BubblewrapSandbox`.
- **Can read:** Only files under `tmpDir` (the bind-mounted benchmark root); `--clearenv` clears environment; `--unshare-net` removes network; `--proc` and `--dev` are mounted but PID namespace isolates process view.
- **Can write:** Only to files under `tmpDir` (read-write bind mount). Cannot reach the state root.
- **Can modify:** Cannot modify persisted state (state root is outside the sandbox).
- **Trusted:** NO — the sandbox isolates candidate code from the host. This is the primary containment boundary.
- **In threat model:** YES — the sandbox is explicitly designed to contain candidate execution. `BubblewrapSandbox` provides: `--clearenv`, `--bind tmpDir/tmpDir`, `--chdir`, `--unshare-pid`, `--unshare-net`. 
- **Critical correction (ARGUS second review):** `NodeProcessSandbox` (`sandbox/index.ts:106-123`) is **dead code** — `getSandbox()` at `sandbox/index.ts:196-198` always returns `BubblewrapSandbox`. When bubblewrap is unavailable, `isAvailable()` returns false and the tool returns "sandbox not available" error (`benchmark/tools.ts:282`). The fallback path described in the first review does NOT exist in practice. The candidate CANNOT escape the sandbox via NodeProcessSandbox because it is never instantiated.
- **Evidence:** `sandbox/index.ts:40-101` (BubblewrapSandbox implementation). `sandbox/index.ts:196-198` (getSandbox() returns BubblewrapSandbox only). Test `test/sandbox.spec.ts:168-179` confirms refusal when unavailable.

#### Actor D: Candidate Author (LLM)
- **Can invoke:** Via `evo_builder_generate` — generates file content through LLM stream.
- **Can read:** Patterns and experiences from the store (passed to LLM as context in `buildUserPrompt`).
- **Can write:** Can generate candidate files (content) and tests. These are written to the candidate directory by `builder/tools.ts:425-441` via `writeFile`.
- **Can modify:** Can modify candidate content via `updateCandidate()` (if the LLM session has tool access), but cannot directly modify benchmark records or version records.
- **Trusted:** PARTIAL — the LLM output is structurally validated (path containment, extension filter, no `.sh`/`.exe`) but not semantically validated. No content hash binds the LLM's original output to the materialized artifact.
- **In threat model:** YES — but as a content injection vector, not a direct attacker. The builder validation (`builder/tools.ts:162-209`) is the trust boundary for LLM-generated content.

#### Actor E: Compromised Host Process
- **Can invoke:** All host functions; all store methods; all modules.
- **Can read:** All state root files; all in-memory process data (including any signing key if one existed).
- **Can write:** All state root files; all in-memory state.
- **Can modify:** Everything. The entire trust model collapses when the host process is compromised.
- **Trusted:** NO — by definition, a compromised host is the ultimate adversary.
- **In threat model:** **NO** — no existing system defends against a compromised host. This is a known architectural limitation, not a gap. The research report notes: *"A compromised host process (E) breaks all trust boundaries"* (from ARGUS review).

#### Actor F: Operator / Administrator
- **Can invoke:** All tools (same as Actor A); configures DSH_HOME, profiles, plugin settings; chooses state root path.
- **Can read:** All state root files; all config; all audit logs.
- **Can write:** All state root files (same filesystem access as Actor B); all config files.
- **Can modify:** Everything — the operator IS the root of trust.
- **Trusted:** YES — the operator is the root of trust for the entire architecture.
- **In threat model:** YES — the operator is the intended authority. Config switches (`generation.enabled`, `promotion.enabled`) are the primary safety controls.

### Key Finding on A vs B

The repository architecture distinguishes Actors A and B at the **tool layer** (A goes through registered tools with parameter validation; B can import modules directly) but **not at the state-root layer** (both have identical filesystem read/write access to `<stateRoot>/benchmarks/`). The provenance seal is a **public SHA-256 hash** — any same-user process can recompute it for any chosen fields. This means the seal protects against accidental corruption (different from what it was named for) but does NOT create an attacker distinction between A and B.

---

## REQUIRED SECURITY PROPERTIES (P1–P12)

| Property | Classification | Evidence | Gap | Documented |
|----------|---------------|----------|-----|------------|
| **P1: persisted-evidence tamper resistance** | **OPTIONAL** | `provenance.ts:14-21` JSDoc explicitly disclaims metrics coverage. Seal is a public hash, not HMAC. `RESEARCH-BENCHMARK-AUTHORITY:550` — "zero HMAC/Ed25519/RSA/secret matches in src/". | Public hash is recomputable by any state-root writer. The seal detects accidental field corruption but not deliberate forgery. | Yes — explicitly documented in provenance.ts JSDoc and all three audit reports. |
| **P2: producer authenticity** | **OUT OF SCOPE** | `TRUST-BOUNDARY-AUDIT:340-342` — "The boundary exists in code but not in substance." `RESEARCH-BENCHMARK-AUTHORITY:588` — "No existing mechanism provides cryptographic authenticity." No host-held secret exists. | No mechanism. `process.pid`/`process.argv0` absent from `src/`. | Yes — audits explicitly document absence. |
| **P3: execution authenticity** | **REQUIRED (for live mode)** | `benchmark/tools.ts:367-369` — live benchmarks call `createLiveProvenance()`. `promote/index.ts:61-66` — simulated evidence rejected when active has live. `promote/tools.ts:40-44` — tool requires `mode === 'live'`. | Seal is self-referential (public hash). A forged record with matching seal fields passes `verifyLiveProvenance`. No attestation that sandbox actually executed. | Yes — I1 partially enforced per `TRUST-BOUNDARY-AUDIT:161-167`. |
| **P4: execution authorization** | **OUT OF SCOPE** | `RESEARCH-BENCHMARK-AUTHORITY:99` — "There is NO authentication gate at any tool registration layer." `dsh.ts:83-93` — `registerToolSafe` accepts no caller context. | Not applicable to threat model (operator-owned state root). | Yes — section 2 of authority report. |
| **P5: candidate identity binding** | **REQUIRED** | `provenance.ts:36-39` — `candidateId` is first input to seal: `${candidateId}\|${version}\|${command}\|${createdAt}`. `promote/index.ts:55` — seal re-derived using `record.candidateId`. Test 6 in `m33-evidence-trust-boundary.spec.ts` proves: cross-candidate copy without recomputation is rejected. | Candidate content is mutable after evidence creation (`store.ts:266-273`), but candidateId-to-record binding is enforced. | Yes — I3 CANDIDATE BINDING: PROVEN in `TRUST-BOUNDARY-AUDIT:164-167`. |
| **P6: candidate content binding** | **OPTIONAL** | `RESEARCH-BENCHMARK-AUTHORITY:541-543` — "Content authority: FAIL — candidate.content is mutable post-creation; no cryptographic binding." `store.ts:266-273` — `updateCandidate()` merges partial updates. `contentHash` computed in `artifact.ts:61-70` but NOT stored in candidate record. | A benchmark's candidateId may be correctly bound, but files/tests referenced by that ID can change after benchmark. | Yes — I7 confirmed in authority report. |
| **P7: baseline identity binding** | **REQUIRED** | `benchmark/tools.ts:511-524` — baseline resolved from `candidate.parentVersion`. `promote/index.ts:40-49` — active version's module and latest benchmark read at promotion time. | Baseline content is mutable (same as P6). No hash-of-baseline-content persisted. | Yes — I4 BASELINE BINDING: PARTIAL in `TRUST-BOUNDARY-AUDIT:165-167`. |
| **P8: baseline content binding** | **OPTIONAL** | `RESEARCH-BENCHMARK-AUTHORITY:587-589` — "Baseline content stability: FAIL — baseline files can be modified after benchmark without invalidating evidence." | Baseline candidate's `files`/`tests` arrays are mutable via `updateCandidate()`. | Yes — section 5 of authority report. |
| **P9: metrics authenticity** | **OPTIONAL (documented residual)** | `provenance.ts:14-21` — JSDoc explicitly disclaims: *"It does NOT cover the metrics blob."* `m33-evidence-trust-boundary.spec.ts:473-483` — test asserts metric inflation to 1.0 passes promotion (`expect(result.ok).toBe(true)`). T2 in `m33-integrity-regression.spec.ts` asserts same. | A forged benchmark record with inflated metrics and a valid seal over the context fields will promote. Closing requires extending seal to include `SHA-256(metrics)`. | Yes — prominently documented in provenance.ts JSDoc, test 8, T2, and all three audit docs. |
| **P10: promotion-context binding** | **OPTIONAL** | `promote/index.ts:40-101` — reads current active version at promotion time. `m33-integrity-regression.spec.ts:T6` — replay of old sealed record after active changes is not detected. Seal includes `version` (parentVersion at benchmark time) but no freshness window or active-version binding in seal input. | Old evidence can satisfy a new promotion if metrics are high enough. The seal does not bind to the active version at promotion time. | Yes — T6 in integrity regression spec; I5 REPLAY: PARTIAL in trust boundary audit. |
| **P11: simulated/legacy evidence exclusion** | **REQUIRED** | `promote/tools.ts:40-44` — tool rejects if `latestEvidence.mode !== 'live'`. `promote/index.ts:61-66` — policy rejects simulated when active has live. `benchmark/tools.ts:192-201` — simulated benchmarks carry no provenance seal. | `evo_full_cycle` calls `runPromotionPolicy` directly, bypassing tool-level mode check. On first promotion (no active version), simulated evidence CAN promote through `evaluatePromotionPolicy` (test 4). | Yes — I6 MODE: PARTIAL in trust boundary audit; test 4 documents first-version bypass. |
| **P12: cross-restart evidence validity** | **REQUIRED** | `fsx.ts:16-24` — `writeJsonAtomic` ensures atomic writes survive crashes. `store.ts:290-297` — `addBenchmark` uses atomic write. `test/test2-restart-persistence.spec.ts` — verifies state survives real restart. `promote/index.ts:179-185` — `createVersion` writes version record atomically. | `createdAt` race condition (`benchmark/tools.ts:368` vs `store.ts:294`): seal computed before `addBenchmark` sets internal `createdAt`; under I/O delay, legitimate records can fail verification. | Yes — `test/test2-restart-persistence.spec.ts`; `createdAt` race documented in `TRUST-BOUNDARY-AUDIT:484`. |

---

## EXECUTION BOUNDARY

**Earliest trusted point:** `BubblewrapSandbox.exec()` (`sandbox/index.ts:40-101`)

Evidence:
- Caller-controlled input (command string) enters a host-controlled execution environment at line 98: `args.push('/bin/sh', '-c', command)`.
- Before this point, the pipeline is entirely caller-driven (candidate selection, command, oracles).
- After this point, classification (`classifyOutcome`, `outcome.ts:73-104`) and metric derivation (`metricsFromResults`, `benchmark/tools.ts:120-129`) are deterministic host functions.
- The sandbox provides: `--clearenv`, `--bind tmpDir/tmpDir`, `--chdir tmpDir`, `--unshare-pid`, `--unshare-net` (unless `allowNetwork=true`).
- **Caveat:** `NodeProcessSandbox` (`sandbox/index.ts:106-123`) is a fallback with NO namespace isolation. If bubblewrap is unavailable, candidate code runs with full host access. The singleton `getSandbox()` defaults to `BubblewrapSandbox` but returns the fallback if bwrap is absent.

**What this boundary proves:**
- The command executes in an isolated environment (when bubblewrap is available).
- The exit code, stdout, stderr, duration, OOM status are captured by host code.
- The seal computed afterward records the execution parameters — but the seal itself does not prove execution occurred (it is a post-hoc public hash).

**What this boundary does NOT prove:**
- That the same command was executed (a forged record with a recomputed seal is indistinguishable from a real one).
- That the metrics accurately reflect the execution (metrics are not part of the seal).
- That the caller was authorized to trigger execution (no authorization check exists).

---

## MEASUREMENT BOUNDARY

**Earliest trusted point:** `classifyOutcome()` in `src/host/modules/benchmark/outcome.ts:73-104`

Evidence:
- Raw sandbox output (`exitCode`, `stdout`, `stderr`, `timedOut`, `oomKilled`) is received from the sandbox.
- `classifyOutcome(result, expectedExitCode, expectedOutput)` deterministically maps the raw result to one of three outcomes: `task-successful`, `unsuccessful-outcome`, `execution-failure`.
- `metricsFromResults(results)` (`benchmark/tools.ts:120-129`) derives `successRate`, `avgScore`, `errorRate`, `avgDurationMs` from the classified outcomes.
- The oracles (`expectedExitCode`, `expectedOutput`) are caller-provided, operator-owned values — they define the success criteria, not the classification mechanism itself.

**Who controls what:**
| Input | Source | Caller-Controlled? |
|-------|--------|-------------------|
| `expectedExitCode` | Caller argument | YES |
| `expectedOutput` | Caller argument | YES |
| `timeoutMs` | Caller argument | YES |
| Raw sandbox result | Host (`BubblewrapSandbox.exec()`) | NO (host-derived) |
| Outcome enum | `classifyOutcome()` — deterministic | NO (host-derived) |
| Metrics | `metricsFromResults()` — pure function | NO (host-derived) |

**Critical finding:** A caller can obtain favorable metrics through a legitimate benchmark run by choosing favorable `expectedExitCode`/`expectedOutput` oracles combined with a command that passes those oracles. This is **intended system behavior** — the architecture explicitly positions these as "operator-owned trusted oracles" (`types.ts:95-106`, `types.ts:318-327`). The classifier is deterministic; the metrics are host-derived. There is no separate verification layer.

---

## EVIDENCE BOUNDARY

**Earliest trusted point:** `store.addBenchmark()` in `src/host/store.ts:290-297`

Evidence:
- The provenance seal is computed by `createLiveProvenance()` at `benchmark/tools.ts:368-369` (live) and `640` (A/B), using the tool's own `new Date().toISOString()` — a value computed BEFORE `addBenchmark` is called.
- `addBenchmark` then calls `isoDateTime(this.nowFn())` at `store.ts:294` — a **second clock read** — which may differ from the seal's `createdAt` by milliseconds under I/O delay.
- The record is persisted via `writeJsonAtomic()` (`fsx.ts:16-24`) to `<stateRoot>/benchmarks/<id>.json`.
- The provenance seal is a **public SHA-256 hash** over `(candidateId, version, command, createdAt)` — no secret key. Any process with filesystem access can recompute it.

**What the evidence boundary proves:**
- That a benchmark record was written atomically (no partial writes).
- That the four sealed fields are internally consistent at the time of write (accidental corruption of those fields is detectable).
- That the record's `mode` field distinguishes `live` from `simulated`.

**What the evidence boundary does NOT prove:**
- That the recorded metrics correspond to actual sandbox execution (metrics are excluded from the seal by design).
- That the record was created by the host process rather than by an attacker who computed the same hash.
- That the command field reflects the command that actually executed (an attacker can change both).

---

## NORMAL WORKFLOW (What It Legitimately Allows)

**Path: `evo_candidate_create` → `evo_benchmark_live` → `evo_promote`**

This is the intended operator workflow. What it proves:

1. **Candidate creation:** A new candidate is created with a crypto-random ID (`newId()`, `ids.ts:4-6`). The candidate starts in `draft` status with empty files/tests.

2. **Live benchmark:** The operator calls `evo_benchmark_live` with a `candidateId` and a `command`. The tool:
   - Resolves the candidate from the store
   - Writes candidate files to a sandbox-bound temp directory
   - Executes the command in `BubblewrapSandbox` (or `NodeProcessSandbox` fallback)
   - Classifies the outcome deterministically
   - Derives metrics from the classification
   - Computes a provenance seal over `(candidateId, version, command, createdAt)`
   - Persists the benchmark record with `mode: 'live'`
   - Updates candidate status to `benchmarked` or `rejected`

3. **Promotion:** The operator calls `evo_promote` with the `candidateId`. The tool:
   - Verifies the candidate is `benchmarked`
   - Verifies the latest evidence is `mode: 'live'` (not simulated)
   - Calls `evaluatePromotionPolicy`:
     - If no active version exists: `beats_active` gate **skipped** (first promotion)
     - If active version exists: compares `candidateSuccessRate > activeSuccessRate` (strict inequality)
     - If either side has a seal: verifies seal consistency
   - Pre-flights: materializes artifact, validates, runs sandbox pre-flight
   - Creates the version record, updates candidate to `promoted`, refreshes activation

**What this workflow proves (without assuming malicious intent):**
- The benchmark command was executed in a sandbox (when bubblewrap is available).
- The outcome was classified deterministically by host code.
- The metrics were derived from the classification.
- The record carries a seal consistent with its fields.
- The promotion decision respected the `beats_active` gate (when an active version exists).

**Classification:** LEGITIMATE BUT CALLER-INITIATED EXECUTION. The architecture intends for the tool caller to be the trusted operator. The gates (`mode === 'live'`, `beats_active`, seal verification) work as designed for this threat model.

---

## ATTACKER WORKFLOW (What It Can Actually Abuse)

**Path 1: Filesystem forgery (3 operations, no tool calls)**

1. Write forged benchmark JSON to `<stateRoot>/benchmarks/<id>.json`:
   ```json
   {
     "candidateId": "<target>",
     "version": "<parentVersion>",
     "baseline": "<parentVersion>",
     "runs": 1,
     "metrics": { "successRate": 1.0, "avgScore": 1.0, "errorRate": 0, "avgSteps": 0, "avgDurationMs": 100 },
     "passed": true,
     "mode": "live",
     "command": "node test.js",
     "provenance": "<sha256 of above fields>",
     "createdAt": "<any ISO timestamp>"
   }
   ```
2. Call `evo_promote(candidateId=<target>)`.
3. `evaluatePromotionPolicy` reads the forged record, computes the seal from the record's own fields → MATCHES (because `createLiveProvenance` is a public hash).
4. If `successRate: 1.0 > activeSuccessRate`, promotion succeeds. **No sandbox execution ever happened.**

**Why this works:** The provenance seal is a PUBLIC hash, not a MAC. Any actor who can write the benchmark JSON can also compute the seal. The seal proves nothing about who created the record — only that the fields are internally consistent.

**Path 2: Metrics inflation (2 operations, 1 forgery)**

1. Run legitimate `evo_benchmark_live` → get a record with `successRate: 0.98`.
2. Edit the benchmark JSON: change `metrics.successRate` to `1.0`. Leave seal untouched.
3. Call `evo_promote`.
4. Seal still matches (the four sealed fields are unchanged). `beats_active` reads `metrics.successRate = 1.0` → passes.

**Why this works:** The seal explicitly excludes metrics (`provenance.ts:14-21`). This is a documented residual.

**Path 3: First-promotion simulated evidence bypass (evo_full_cycle only)**

1. System has no active version (fresh state root).
2. `evo_full_cycle` runs with sandbox unavailable (or falls back to simulated).
3. `runPromotionPolicy` → `evaluatePromotionPolicy`: `capturedActiveMetrics` is undefined → `beats_active` skipped.
4. Simulated evidence is NOT rejected by `evaluatePromotionPolicy` when no active baseline exists (the rejection at `promote/index.ts:61` requires `capturedActiveMetrics` to be truthy).
5. Promotion succeeds with simulated evidence.

**Why this works:** The tool-level `mode === 'live'` check in `evo_promote` (`promote/tools.ts:40`) is NOT enforced by the internal `runPromotionPolicy` path used by `evo_full_cycle`.

---

## CANDIDATE AUTHORITY

### Identity Authority
- **Origin:** `store.addCandidate()` → `newId()` (crypto.randomBytes(6).toString('hex'), 12 chars) — `store.ts:247-254`.
- **Uniqueness:** Random ID, no collision check — statistically negligible but theoretically collisionable.
- **Storage:** `candidates/<id>.json` — flat JSON on disk.
- **Resolution:** `store.getCandidate(id)` validates via `isSafeKey()` (`ids.ts:19-21`) before path construction — path safety only.
- **Verdict:** **PROVEN** — `store.addCandidate` is the sole writer of candidate records.

### Content Authority
- **Immutability:** NONE. `updateCandidate(id, updates)` (`store.ts:266-273`) merges partial updates and rewrites atomically. Any caller with store access can change candidate content.
- **Files on disk:** `candidates/<id>/` created by builder (`builder/tools.ts:425-442`). Files written via `writeFile`. No hash-based integrity check.
- **contentHash:** Computed in `artifact.ts:61-70` during `materializeArtifact` but NOT stored in the candidate record and NOT verified on read.
- **After evidence creation:** Candidate content CAN change without invalidating existing benchmark records.
- **Verdict:** **FAIL** — `candidate.content` is mutable post-creation; no cryptographic binding between record ID and file content.

---

## BASELINE AUTHORITY

### Baseline Identity
- **Who chooses:** The system chooses baseline from `candidate.parentVersion`, NOT from caller input (`benchmark/tools.ts:511-524`).
- **Canonical source:** `store.getCandidate(baselineId)` reads from persisted state.
- **Fallback chain:** `parentVersion` → active version's first module → null.
- **Verdict:** **PARTIAL** — resolved from canonical store, but store content is mutable.

### Baseline Content
- **Can baseline content change?** YES — if `store.updateCandidate(baselineId, ...)` is called, baseline files change but the benchmark record still references the old ID.
- **Does promotion re-resolve baseline?** NO — `evaluatePromotionPolicy` reads `candidateLatest.metrics` directly from the persisted benchmark record; it does not re-execute the baseline.
- **Does evidence remain valid after baseline change?** YES — the provenance seal survives because it doesn't include baseline content. The metrics survive because they are stored independently.
- **Verdict:** **FAIL** — baseline content is mutable after benchmark without invalidating evidence.

### Is `activeVersionId` sufficient for baseline authority?
**NO.** `activeVersionId` resolves the *identity* of the active version, but:
- The active version's benchmark metrics are read from the persisted record (which can be tampered with).
- The active version's files can change after the benchmark was computed.
- There is no binding between the active version ID and the metrics values used in the `beats_active` comparison.

`activeVersionId` is sufficient for **identity** binding but NOT for **content** binding.

---

## METRIC AUTHORITY

### Trace
```
benchmark execution (sandbox.exec)
  → raw result (exitCode, stdout, stderr, timedOut, oomKilled, durationMs)
  → classifyOutcome(result, expectedExitCode, expectedOutput)  [deterministic, host-controlled]
  → metricsFromResults([classified result])                     [pure function, host-controlled]
  → store.addBenchmark({metrics, ...})                          [persists to JSON]
  → evaluatePromotionPolicy reads metrics from persisted record
```

### Who controls what
| Step | Controlled By |
|------|--------------|
| `command` | Caller |
| `expectedExitCode` / `expectedOutput` (oracles) | Caller (operator-provided) |
| Raw sandbox output | Host (sandbox-isolated execution) |
| Outcome classification | Host (deterministic function) |
| Metrics derivation | Host (pure function) |
| Persistence | Host (atomic write) |

### Can a caller obtain favorable metrics through legitimate execution?
**YES.** The caller controls `command`, `expectedExitCode`, and `expectedOutput`. By choosing a command that exits 0 and an oracle that matches, the caller can ensure `successRate: 1.0`. This is **intended system behavior** — the architecture positions the operator as the oracle provider.

### Is this a security vulnerability?
**No.** The architecture explicitly defines these as "operator-owned trusted oracles" (`types.ts:95-106`). The classification is deterministic; the metrics are host-derived. There is no separate verification layer because the operator IS the authority.

### Can metrics be inflated through persisted-state tampering?
**YES.** If an attacker can write to `<stateRoot>/benchmarks/`, they can change `metrics.successRate` without breaking the seal (metrics are excluded from the seal by design, `provenance.ts:14-21`). This is a documented residual gap, not a design flaw — it exists because the threat model treats the state root as operator-owned.

---

## HMAC SCOPE

Evaluating HMAC (secret-key MAC) ONLY as an evidence-authentication mechanism:

| Property | PROVES | DOES NOT PROVE |
|----------|--------|----------------|
| Persisted-record authenticity | YES — only a holder of the secret key can produce a valid MAC | That the record corresponds to actual sandbox execution |
| Producer authenticity | PARTIAL — proves the record was signed by a process holding the key | Which process, which session, which operator invoked it |
| Execution authenticity | NO — the seal is computed at write time, not at execution time | That the sandbox actually ran the command |
| Execution authorization | PARTIAL — if key is provisioned per-operator, limits who can sign | To which operations (all `evo_benchmark_*` tools share the same key) |
| Candidate identity binding | YES — candidateId is in the HMAC input | That the candidate had the content used in execution |
| Candidate-content binding | NO — candidate files are not hashed into the seal | |
| Baseline identity binding | PARTIAL — `version` (parentVersion) is in the input | That the baseline had the content used in execution |
| Baseline content binding | NO — baseline files are not hashed into the seal | |
| Metrics authenticity | YES — if `SHA-256(metrics)` is included in the HMAC input | That the metrics were derived from actual execution (only that they match what was recorded) |
| Promotion-context binding | PARTIAL — if `activeVersionId` is included in the HMAC input | That the active version was stable between benchmark and promotion |
| Simulated/legacy evidence exclusion | NO — mode is a separate field, HMAC covers live records only | The mode field itself is writable |
| Cross-restart evidence validity | YES — HMAC is stateless; verified on read regardless of process restart | The `createdAt` race condition still exists |

**Verdict:** HMAC closes the forgery vector (Path 1) and the metrics-tampering vector (Path 2) IF metrics are included in the HMAC input. It does NOT establish execution authenticity, candidate/baseline content binding, or first-promotion bypass protection. It is a **necessary but not sufficient** mechanism for complete authority.

---

## EPHEMERAL KEY LIFECYCLE

**Scenario:** Benchmark persisted → host restart → new process-local key → old evidence unverifiable.

If an HMAC key were introduced as a process-local secret (generated at boot, not persisted):

1. **After restart, old evidence becomes unverifiable** — the new process has a different key, so `verifyLiveProvenance` fails for all pre-restart records.
2. **Candidates with unverifiable evidence cannot promote** — `evaluatePromotionPolicy` would reject all sealed records.
3. **The system enters a deadlock** — no new benchmarks can be created (no active version to compare against means no seal check is required, but promoted versions become stuck).

**Classification:** ARCHITECTURAL MISMATCH

The current architecture (public hash, no key) survives restart because the seal is stateless. Introducing a process-local HMAC key would break this property. The key would need to be:
- Persisted across restarts (in a location outside the state root), OR
- Recovered from a secure enclave/OS credential store, OR
- Paired with a migration path for legacy records.

**Current behavior (no key):** The `createdAt` race condition (`benchmark/tools.ts:368` vs `store.ts:294`) can cause legitimate records to fail verification across restarts even without a key — the seal's `createdAt` and the stored record's `createdAt` may differ by milliseconds under I/O delay.

---

## FIRST-PROMOTION + LEGACY

### First-Promotion Simulated Evidence Bypass
- **Behavior:** When no active version exists, `evaluatePromotionPolicy` skips the `beats_active` gate (line 37: `if (activeBeforePromote?.modules?.length)` is false). The simulated-evidence rejection at line 61 requires `capturedActiveMetrics` to be truthy.
- **Path:** `evo_full_cycle` calls `runPromotionPolicy` directly, which delegates to `evaluatePromotionPolicy`. The tool-level `mode === 'live'` check in `evo_promote` (`promote/tools.ts:40`) is NOT enforced.
- **Impact:** Simulated evidence can promote on a fresh root through the autonomous path.

**Classification:** **POLICY** — this is an intentional design choice. On a fresh root, there is no active baseline to compare against, so the comparative gate is skipped. The operator controls this via `generation.enabled` and `promotion.enabled` config switches.

**Not a security issue in the intended threat model** (operator-owned state root). But it IS a gap if the threat model includes untrusted callers within the same process.

### Legacy Unsealed Evidence Bypass
- **Behavior:** At `promote/index.ts:78-93`, the seal check runs only when `candidateSealed || activeSealed`. If BOTH sides are unsealed (pre-M3.3 records), the seal check is skipped entirely.
- **Impact:** A forged unsealed live record with high metrics would pass the `beats_active` comparison.
- **Mitigation:** If either side is sealed, the seal check applies to both. This prevents a fully-forged record from being accepted when a sealed active baseline exists.

**Classification:** **COMPATIBILITY** — this is a backward-compatibility measure. Pre-M3.3 state roots had no seal. The dual-unsealed bypass allows these legacy state roots to continue functioning while requiring seals on new records.

**Not a security issue in the intended threat model** — legacy records predate the seal mechanism and are expected to be re-benchmarked.

---

## SECURITY PROPERTY MATRIX

| Property | Current Mechanism | Current Guarantee | Is Property Required? | Can HMAC Help? | What HMAC Cannot Solve | Remaining Control |
|----------|------------------|-------------------|----------------------|----------------|----------------------|-------------------|
| P1: Tamper resistance | Public SHA-256 over 4 fields | Detects accidental corruption of sealed fields; NOT deliberate forgery | OPTIONAL | Yes — closes forgery vector | Execution authenticity, metrics accuracy | Operator (state root is trusted) |
| P2: Producer authenticity | None | None | OUT OF SCOPE | Partial — proves key-holder origin | Which process, which session | — |
| P3: Execution authenticity | Sandbox isolation + mode field + seal | Sandbox runs command (when bubblewrap available); seal confirms field consistency | REQUIRED (for live mode) | Partial — proves record was signed | Actual execution occurred; metrics accuracy | BubblewrapSandbox (exec boundary) |
| P4: Execution authorization | None | None | OUT OF SCOPE | Partial — key possession limits who can sign | Operator-in-the-loop design already handles this | Config switches (generation/promotion.enabled) |
| P5: Candidate identity binding | candidateId in seal input | Cross-candidate reuse without recomputation is rejected | REQUIRED | Yes — candidateId in HMAC input | Content mutability after benchmark | Operator (who creates candidates) |
| P6: Candidate content binding | None | None | OPTIONAL | No — candidate files not in seal | Content changes after benchmark | Operator (re-benchmark after changes) |
| P7: Baseline identity binding | version in seal input | Baseline resolved from canonical store | REQUIRED | Yes — version in HMAC input | Content mutability after benchmark | Operator (who sets parentVersion) |
| P8: Baseline content binding | None | None | OPTIONAL | No — baseline files not in seal | Content changes after benchmark | Operator (re-benchmark after changes) |
| P9: Metrics authenticity | Explicitly excluded from seal | None — documented residual | OPTIONAL | Yes — if SHA-256(metrics) included in HMAC input | Accuracy of metrics vs. actual execution | Operator (trusting host-derived metrics) |
| P10: Promotion-context binding | None | None | OPTIONAL | Partial — if activeVersionId included in HMAC input | Replay of old evidence against new context | Operator (re-benchmark for new context) |
| P11: Simulated/legacy exclusion | mode field + tool-level check | Tool path blocks simulated; policy path allows on fresh root | REQUIRED | No — mode is a separate field | First-promotion bypass via evo_full_cycle | Config switches (generation/promotion.enabled) |
| P12: Cross-restart validity | writeJsonAtomic + seal | Records persist across restarts; seal verified on read | REQUIRED | Yes — HMAC verified on read regardless of restart | createdAt race condition; key persistence | Operator (key must survive restart) |

---

## FIVE-ROLE REVIEW

### ARGUS (Threat Model Actor Challenge)
**Scope:** Six actors (A-F) analyzed against the repository's tool registration, state root access, and sandbox isolation.

**Method:** Traced each actor's capabilities through `src/host/dsh.ts`, `src/host/store.ts`, `src/lib/home.ts`, `src/host/modules/sandbox/index.ts`, and audit reports.

**Concrete evidence:**
- Actor A (tool caller): `dsh.ts:83-93` — `registerToolSafe` has no auth gate. Any session with plugin tools can call any evolution tool.
- Actor B (same-user process): `store.ts:290-309` — state root is plaintext JSON, no access control. `createLiveProvenance` is a public hash — any process can recompute.
- Actor C (sandboxed candidate): `sandbox/index.ts:40-101` — bubblewrap isolates execution but does NOT authenticate the caller. `NodeProcessSandbox` (`sandbox/index.ts:106-123`) has zero isolation.
- Actor D (LLM author): `builder/tools.ts:162-209` — structural validation only (path containment, extension filter). No semantic validation.
- Actor E (compromised host): Breaks all boundaries — no in-process secret exists.
- Actor F (operator): Root of trust — all trust boundaries terminate here.

**Finding:** The provenance seal is a self-referential consistency fingerprint, not a trust boundary. It defends against accidental JSON corruption of four fields, not against deliberate forgery by any same-OS-user attacker. The architecture treats the tool caller as trusted; Actors A and B are not distinguished at the state-root layer.

**Residual:** The critical structural gap: the state root is a shared, unauthenticated, same-user filesystem. The only defense against Actor B is a public hash that Actor B can recompute. Until an HMAC key mechanism is implemented, no actor with same-OS-user filesystem access can be prevented from forging promotion-eligible evidence.

**Verdict:** The six-actor model is correct. The threat model's scope is narrower than the mission's default assumption — the architecture does not defend against Actor B (same-user process) as a distinct adversary from Actor A (tool caller). Whether this is acceptable depends on the intended use case.

---

### BADSECTOR (Normal Tool to Promotion Path)
**Scope:** Shortest promotion path using only public `evo_*` tools, no filesystem tampering, no persisted-record forgery.

**Method:** Traced each of three paths through complete execution chains, identifying every gate, every caller-controlled input, and every host-derived decision point.

**Concrete evidence:**
- PATH 1 (3 calls): `evo_candidate_create` → `evo_benchmark_live(candidateId=X, command="node src/index.ts", expectedExitCode=0)` → `evo_promote(candidateId=X)`. Succeeds on fresh root because `evaluatePromotionPolicy` skips `beats_active` when no active version exists (`promote/index.ts:37`).
- PATH 2 (full_cycle): `evo_full_cycle` with `generation.enabled=true` and `promotion.enabled=true`. On fresh root, simulated fallback at step 7 can promote without any sandbox execution when sandbox is unavailable.
- PATH 3 (A/B): `evo_benchmark_ab` → `evo_promote`. Same gates as live; produces identical live evidence format.

**Finding:** The shortest path from legitimate tool access to promotion is a 3-call sequence on a fresh root requiring zero forgery. The architecture intends for the tool caller to be the trusted operator. No authorization boundary exists between "benchmark executor" and "promotion approver" because they are designed to be the same role.

**Residual:** The simulated-fallback path in `evo_full_cycle` (PATH 2) creates a secondary surface: when sandbox is unavailable on a fresh root, the autonomous cycle can promote using simulated evidence derived from historical experience data, without any sandbox execution occurring.

**Verdict:** All three paths are **LEGITIMATE BUT CALLER-INITIATED EXECUTION**. The system behaves as designed — the operator is trusted. The question is whether this trust model matches the intended deployment.

---

### ATLAS (Security Scope vs Architecture Purpose)
**Scope:** Whether the proposed security scope (threat model, required properties) exceeds the architecture's actual purpose.

**Method:** Read-only analysis of boot sequence, config schema, autonomous loop guards, state root resolution, tool registration, and three audit reports.

**Concrete evidence:**
- `src/host/config.ts:42-57` — `generation.enabled: false` and `promotion.enabled: false` are defaults. Comment at line 38-41: *"Conservative defaults: 20 completed experiences and 5 occurrences before the autonomous loop may act, generation and promotion both off until the operator turns them on."*
- `src/lib/home.ts:26-50` — State root is operator-controlled filesystem path, not a security boundary.
- `src/host/modules/auto-experience/index.ts:110-114` — Guards are operational safety (inFlight, cyclesRun, maxCyclesPerProcess), not security controls.
- `src/host/dsh.ts:83-93` — `registerToolSafe` has no access control — architectural choice for local dev tool.

**Finding:** The security properties P1 (tamper resistance) and P2 (producer authenticity) are OUT OF SCOPE for this architecture. The architecture is a **local development tool** where the operator controls the host process, the filesystem, and all tool invocations. The defaults (generation off, promotion off, max 3 cycles/process) confirm this is an operator-driven tool, not an autonomous system.

**Residual:** If the architecture's purpose were to change (multi-tenant deployment, untrusted agent execution, or operator-without-filesystem-access scenario), then P1 and P2 would become required and the HMAC design would need implementation.

**Verdict:** **P1 — OUT OF SCOPE. P2 — OUT OF SCOPE. P3 — PARTIALLY IN SCOPE. P4 — OUT OF SCOPE.** The promotion evidence does not need to provide cryptographic tamper resistance, producer authenticity, or execution authorization because the architecture's threat model is the operator's own local development environment, not an adversarial one. The mission's security scope exceeds the architecture's actual purpose.

---

### VERA (Property-to-Evidence Mapping)
**Scope:** Map each security property P1-P12 to concrete repository evidence.

**Method:** Traced each property to source files, tests, and audit documentation.

**Concrete evidence (key findings):**
- P1 (tamper resistance): OPTIONAL — `provenance.ts:14-21` explicitly disclaims metrics; seal is public hash; attacks T1-T6 in `m33-integrity-regression.spec.ts` currently assert `ok=true`.
- P2 (producer authenticity): OUT OF SCOPE — zero HMAC/secret in src/.
- P3 (execution authenticity): REQUIRED for live mode — `mode` field + seal verification at promotion boundary. Gap: seal doesn't prove execution occurred.
- P4 (execution authorization): OUT OF SCOPE — no auth gate exists; operator-in-the-loop design.
- P5 (candidate identity): REQUIRED — proven. `candidateId` is first seal input; cross-candidate copy without recompute is rejected (test 6).
- P6 (candidate content): OPTIONAL — content is mutable; no hash binding.
- P7 (baseline identity): REQUIRED — `version` in seal input; resolved from canonical store.
- P8 (baseline content): OPTIONAL — content mutable; no hash binding.
- P9 (metrics authenticity): OPTIONAL — explicitly excluded from seal; test 8 and T2 confirm attack succeeds.
- P10 (promotion-context): OPTIONAL — no replay protection; T6 confirms old evidence replays.
- P11 (simulated exclusion): REQUIRED — `mode` field enforced at tool and policy level. Gap: `evo_full_cycle` bypasses tool-level check on first promotion.
- P12 (cross-restart): REQUIRED — atomic writes survive restarts. Gap: `createdAt` race condition.

**Verdict:** The repository establishes 4 REQUIRED properties (P5, P7, P11, P12) with partial enforcement gaps in P3 and P10. Six properties are OPTIONAL or OUT OF SCOPE. The primary security gap — metrics integrity (P9) — is documented, tested, and pending remediation in M3.4.

---

### ZEKO (Terminology Consistency)
**Scope:** Check whether security-relevant terms are used consistently against their actual guarantees.

**Method:** Grep'd all occurrences of 12 security terms across `src/` and `docs/`; read each in context; compared implication vs. delivery.

**Concrete evidence:**

| Term | Occurrences in src/ | Classification | Key Gap |
|------|-------------------|----------------|---------|
| **seal** | 23 lines | **CRITICAL** | Term implies externally-applied tamper-evident binding; mechanism is self-referential SHA-256 with no secret key. Error message at `promote/index.ts:88` ("evidence may have been tampered") creates false confidence. |
| **provenance** | 25 lines | **MODERATE** | Used for field-consistency fingerprint. SLSA/Sigstore connotation of "authentic origin" overstates the guarantee. |
| **evidence** | 40 lines | **MODERATE** | Simulated/live distinction is internally consistent. "Live evidence" cannot be verified as actual execution. |
| **trusted / trust** | 15 lines | **MODERATE** | "Trusted operator-provided" is correct. "Trust boundary violation" at `provenance.ts:51` implies security domain crossing that is actually just a hash mismatch. |
| **integrity** | 0 in src/ | **LOW** | Docs only. Test file name `m33-integrity-regression.spec.ts` could mislead a skimmer. |
| **boundary** | 17 lines | **LOW** | Containment-boundary usage is precise. Trust-boundary usage is a mild overclaim. |
| authorized/authenticated/attestation/security/threat/attack | 0-1 in src/ | **NONE** | Absent or used accurately to describe missing capabilities. |

**Verdict:** The codebase is honest in its JSDoc scope-limitation comments, but the terms "seal" and "provenance" create false confidence in operators who do not read the comments. The error message at `promote/index.ts:88` is the highest-priority terminology fix: "seal mismatch" → "consistency fingerprint mismatch" or clearer wording that does not imply tamper detection.

---

## REMAINING UNKNOWNs

The following items remain **UNKNOWN** — not because evidence is absent, but because the repository does not establish a requirement or boundary for them:

1. **Whether Actor B (same-user local process) is in the threat model.** The repository does not distinguish Actor A from Actor B at the state-root layer. If the state root is intended to be accessible only to the host process (not other user processes), this is not enforced by code. **UNKNOWN** — depends on deployment context.

2. **Whether first-promotion simulated-evidence bypass is acceptable.** The architecture allows simulated evidence to promote on a fresh root (no active baseline). This is controlled by `generation.enabled` and `promotion.enabled` config switches, but the bypass exists even when those are true (through `runPromotionPolicy`). **UNKNOWN** — may be intentional (operator consent via config) or a gap (should require live evidence even on first promotion).

3. **Whether NodeProcessSandbox fallback is acceptable for production use.** When bubblewrap is unavailable, candidate code runs with full host access. The sandbox tool refuses to execute (`sandbox.spec.ts:168-179`), but `evo_benchmark_live` falls through to `getSandbox()` which may return the fallback. **UNKNOWN** — depends on deployment environment.

4. **Whether the `createdAt` race condition is operationally significant.** The seal is computed at tool runtime (`benchmark/tools.ts:368`) but `addBenchmark` sets its own `createdAt` via `this.nowFn()` (`store.ts:294`). Under normal I/O latency, these should match. Under high load or slow disk, they may differ by milliseconds, causing legitimate records to fail verification. **UNKNOWN** — no test exercises this race; no production data shows failures.

5. **Whether the operator-in-the-loop threat model is sufficient for the intended use case.** The architecture treats all tool callers as trusted operators. If the deployment context changes (multi-agent, shared host, untrusted sessions), the threat model would need to expand. **UNKNOWN** — depends on deployment.

---

## DECISION

**DECISION = NOT READY**

The following required items remain UNKNOWN:

1. **IN-SCOPE ACTORS** — UNKNOWN: Whether Actor B (same-user process) is intended to be in-scope as an adversary or as a trusted peer. The repository does not distinguish them.
2. **REQUIRED SECURITY PROPERTIES** — PARTIALLY KNOWN: P1 and P2 are argued as OUT OF SCOPE by ATLAS, but ARGUS demonstrates they matter if the threat model includes Actor B. This conflict must be resolved before design.
3. **EXECUTION BOUNDARY** — KNOWN: `BubblewrapSandbox.exec()` is the earliest trusted point. Caveat: NodeProcessSandbox fallback has zero isolation.
4. **MEASUREMENT BOUNDARY** — KNOWN: `classifyOutcome()` is the deterministic measurement boundary. Oracles are caller-controlled.
5. **EVIDENCE BOUNDARY** — KNOWN: `store.addBenchmark()` is the persistence boundary. The seal is a public hash, not a trust anchor.

**The unresolved issue is not another cryptographic detail.**

**The unresolved issue is:**

**WHAT SECURITY PROPERTY MUST PROMOTION EVIDENCE ACTUALLY PROVIDE?**

The mission states: "Do not assume that 'authorized execution' is required. Do not assume that 'HMAC' is the solution. Do not assume that a caller with tool access is an attacker in scope."

The repository evidence shows:
- The architecture is a **local development tool** with operator-in-the-loop design (defaults: generation off, promotion off).
- The state root is **operator-owned local data** with no access control.
- The seal is a **consistency fingerprint**, not a trust anchor.
- The provenance mechanism detects **accidental corruption**, not **deliberate forgery**.
- The threat model is **not explicitly defined** in the repository.

The classification of P1 and P2 (tamper resistance and producer authenticity) depends on whether the intended threat model includes:
- (a) An operator who accidentally corrupts their own state root → consistency fingerprint is sufficient
- (b) A same-user process (malicious or buggy) that writes to the state root → HMAC or equivalent is required
- (c) An external attacker with network access to the DSH host → no current mechanism addresses this

**The repository evidence does not establish which of (a), (b), or (c) is the intended threat model.** Therefore, the required security properties for promotion evidence cannot be determined from the repository alone.

**To resolve:**
1. The operator must define the intended threat model (which actors are in-scope adversaries?).
2. Once the threat model is defined, the required properties can be classified as REQUIRED/OPTIONAL/OUT OF SCOPE.
3. Only then can a design (HMAC, fresh execution, or other mechanism) be scoped appropriately.

**Until the threat model is defined, the correct decision is: NOT READY FOR DESIGN.**
