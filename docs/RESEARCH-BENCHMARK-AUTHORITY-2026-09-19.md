# Benchmark Authority Model — Research Report
**Repository:** `dsh-evolution`  
**Date:** 2026-09-19  
**Scope:** READ-ONLY RESEARCH — no implementation, no commit, no code change.

---

## 1. EXECUTION PIPELINE (Traced)

```
CALLER
  │
  ▼
[ TOOL / API LAYER ]
  evo_benchmark_run       → src/host/modules/benchmark/tools.ts:160
  evo_benchmark_live      → src/host/modules/benchmark/tools.ts:240
  evo_benchmark_ab        → src/host/modules/benchmark/tools.ts:417
  evo_full_cycle          → src/host/modules/evolution/tools.ts:108 (orchestrates above internally)
  │
  ▼
[ VALIDATION ]
  candidate = store.getCandidate(candidateId)     (store.ts:258)
  if (!candidate) → reject
  sandbox.isAvailable()                           (sandbox/index.ts:30)
  │
  ▼
[ CANDIDATE RESOLUTION ]
  store.getCandidate(id) → reads candidates/<id>.json
  candidate.files, candidate.tests loaded from in-memory object
  candidate.content = JSON field (persisted, mutable via updateCandidate)
  │
  ▼
[ COMMAND RESOLUTION ]
  evo_benchmark_live:  command ← caller argument (string)
  evo_benchmark_ab:    command ← caller argument (string)
  evo_full_cycle:      command ← caller argument (testCommand parameter)
  command is NOT derived from candidate data
  │
  ▼
[ BASELINE RESOLUTION ]
  evo_benchmark_ab:  baselineId = candidate.parentVersion
                     resolves baselineCandidate from store via getCandidate(baselineId)
                     fallback: activeVersion.modules[0] → getCandidate(modId)
  evo_benchmark_live: baseline = candidate.parentVersion (stored, NOT resolved separately)
  │
  ▼
[ SANDBOX EXECUTION ]
  sandbox.exec(command, { cwd, timeoutMs, allowNetwork })
  BubblewrapSandbox: --clearenv, --bind tmpDir/tmpDir, --chdir
  NodeProcessSandbox (fallback): no namespace isolation
  │
  ▼
[ OUTPUT COLLECTION ]
  stdout/stderr captured, exitCode, timedOut, oomKilled, durationMs
  classifyOutcome(result, expectedExitCode, expectedOutput) → outcome enum
  │
  ▼
[ METRIC DERIVATION ]
  metricsFromResults(results) or inline for single-run
  successRate = pass_count / total
  avgScore = mean(scores)
  errorRate = execution_failure_count / total
  avgSteps = 0 (never populated from results)
  avgDurationMs = mean(durations)
  │
  ▼
[ EVIDENCE CREATION ]
  store.addBenchmark({ mode, candidateId, version, baseline, runs, metrics, passed, ... })
  provenance = createLiveProvenance(candidateId, version, command, createdAt)   (lib/provenance.ts:31)
  createdAt = isoDateTime(this.nowFn())                                          (store.ts:293)
  │
  ▼
[ PERSISTENCE ]
  writeJsonAtomic(benchmarkDir() + `/id.json`, record)                          (store.ts:296)
  state root is a directory under DSH_HOME/dsh-evolution[/<profile>]
  JSON files are readable AND writable by any process with filesystem access
  │
  ▼
[ PROMOTION ]
  evo_promote tool → evaluatePromotionPolicy → executePromotion
  OR evo_full_cycle → runPromotionPolicy (internal)
  Policy gate: simulated rejection, provenance seal verification, beats_active comparison
```

---

## 2. CALLER AUTHORITY

| Path | Who Can Trigger | What They Control | Validation | Promotion-Eligible? |
|------|----------------|-------------------|------------|---------------------|
| `evo_benchmark_live` (public tool) | Any caller with tool access | candidateId, command, cwd, timeoutMs, allowNetwork, expectedExitCode, expectedOutput | candidate existence; sandbox availability; cwd containment | YES (creates live evidence with provenance) |
| `evo_benchmark_ab` (public tool) | Any caller with tool access | same as live + baseline resolution (partial) | candidate existence; sandbox availability | YES (creates live evidence with provenance) |
| `evo_benchmark_run` (public tool) | Any caller with tool access | candidateId, runs | candidate existence; candidate not promoted | NO (creates simulated evidence only) |
| `evo_benchmark_compare` (public tool) | Any caller with tool access | benchmarkId | benchmark existence; candidate existence | NO (read-only comparison) |
| `evo_full_cycle` (public tool) | Any caller with tool access | apiUrl, apiKey, model, testCommand, minOccurrences | generation.enabled config; promotion.enabled config; LLM build | YES (calls evo_benchmark_live internally, then runPromotionPolicy) |
| Internal: `runPromotionPolicy()` in promote/index.ts | evolution/tools.ts (evo_full_cycle), test paths | none directly — receives candidate object | called only after benchmark step | N/A (promotion, not benchmark) |
| Internal: `executePromotion()` in promote/index.ts | promote/tools.ts (evo_promote), runPromotionPolicy | none directly | requires candidate.status === 'benchmarked' + latestEvidence.mode === 'live' | N/A (promotion, not benchmark) |

**Key finding:** There is NO authentication gate at any tool registration layer. All `defineTool` calls register without access control. The DSH plugin system (registerToolSafe) does not enforce caller identity. Any session with plugin tools enabled can call any evolution tool directly.

---

## 3. CANDIDATE AUTHORITY

### Identity Authority
- **Origin:** `store.addCandidate()` → `newId()` (crypto.randomBytes(6).toString('hex'), 12 chars) — store.ts:247-254
- **Uniqueness:** random ID, no collision check — theoretically collisionable but statistically negligible
- **Storage:** `candidates/<id>.json` — flat JSON file on disk
- **Resolution:** `store.getCandidate(id)` validates id via `isSafeKey()` (regex `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`) before path construction — store.ts:258-264
- **Authority boundary:** The store's `addCandidate` is the sole writer; the candidate dir is the identity anchor.

### Content Authority
- **Immutability:** NO. `updateCandidate(id, updates)` (store.ts:266-273) merges partial updates into existing record and rewrites the file atomically. Any caller with store access can change candidate content.
- **Files on disk:** `candidates/<id>/` directory created by builder (tools.ts:425-442). Files written via `writeFile`. No hash-based integrity check.
- **contentHash:** Computed in artifact.ts:61-70 (`hashFileSet`) during `materializeArtifact`, but NOT stored in the candidate record and NOT verified on read.
- **Resolution in benchmark:** `store.getCandidate(candidateId)` returns the current in-memory object. If the candidate was modified between creation and benchmark, the benchmark sees the modified content.
- **After evidence creation:** Candidate content CAN change (via updateCandidate) without invalidating existing benchmark records.

**Verdict:**
- Identity authority: **PROVEN** — store.addCandidate is the sole source
- Content authority: **FAIL** — candidate.content is mutable post-creation; no cryptographic binding between record id and file content

---

## 4. COMMAND AUTHORITY

### Source of Command
- **evo_benchmark_live:** `command` is a direct string parameter from caller args — benchmark/tools.ts:267
- **evo_benchmark_ab:** `command` is a direct string parameter from caller args — benchmark/tools.ts:445
- **evo_full_cycle:** `command` comes from `a.testCommand` parameter — evolution/tools.ts:250
- **NOT derived from candidate:** The command is caller-controlled, not extracted from candidate.manifest.benchmarkCases or any persisted candidate field.
- **NOT validated against candidate:** There is no check that the command matches what the candidate "expects". The command is simply executed.

### Caller Control Surface
| Field | Source | Controlled By |
|-------|--------|---------------|
| command | Caller argument | External caller |
| cwd | Caller argument (default: tmpDir root) | External caller |
| timeoutMs | Caller argument (default: 30000) | External caller |
| allowNetwork | Caller argument (default: false) | External caller |
| expectedExitCode | Caller argument (optional) | External caller |
| expectedOutput | Caller argument (optional) | External caller |

### Sandbox Execution Integrity
- `containBenchmarkCwd()` (benchmark/tools.ts:39-79) provides containment via lexical + symlink defense
- Sandbox bind-mounts `tmpDir` (mkdtemp-created) — candidate files are written there before execution
- The sandbox runs `/bin/sh -c '<command>'` — the command string is passed as a shell argument
- **No command canonicalization:** The command executed is exactly what the caller provided, verbatim
- **No command attribution:** The provenance seal includes `command`, but the seal verifies only that (candidateId, version, command, createdAt) were consistent at creation time — it does NOT verify that the executed command matched what was recorded

**Key finding:** A caller can provide a command, get a provenance seal for that command, then later edit the persisted benchmark record to change the command field to something different while keeping the same seal (if they also change createdAt to match). More importantly, the seal does not cover the actual execution — only the intended parameters.

---

## 5. BASELINE AUTHORITY

### Baseline Resolution in evo_benchmark_ab
```typescript
// benchmark/tools.ts:511-524
const baselineId = candidate.parentVersion
let baselineCandidate = await store.getCandidate(baselineId)
if (!baselineCandidate) {
  const activeVersion = await store.getActiveVersion()
  if (activeVersion) {
    for (const modId of activeVersion.modules) {
      const mod = await store.getCandidate(modId)
      if (mod) { baselineCandidate = mod; break }
    }
  }
}
```

### Baseline Identity
- **Who chooses:** The system chooses baseline from `candidate.parentVersion`, NOT from caller input
- **Canonical source:** `store.getCandidate(baselineId)` reads from persisted state
- **Fallback chain:** parentVersion → active version's first module → null
- **Baseline content:** Read from `baselineCandidate.files` and `baselineCandidate.tests` — same mutable store object as candidates

### Baseline in evo_benchmark_live
- Baseline is stored as `baseline: candidate.parentVersion` (string ID) — benchmark/tools.ts:374
- The live benchmark does NOT execute a baseline side; it only records the version ID

### Baseline After Evidence Creation
- **Can baseline content change?** YES — if `store.updateCandidate(baselineId, ...)` is called, the baseline files change but the benchmark record still references the old ID
- **Does promotion re-resolve baseline?** NO — `evaluatePromotionPolicy` reads `candidateLatest.metrics` directly from the persisted benchmark record; it does not re-execute the baseline
- **Does evidence remain valid after baseline change?** The provenance seal survives because it doesn't include baseline content. The metrics survive because they are stored independently. The evidence record is valid even if the baseline candidate was corrupted afterwards.

**Verdict:**
- Baseline identity: **PARTIAL** — resolved from canonical store, but store content is mutable
- Baseline content stability: **FAIL** — baseline files can be modified after benchmark without invalidating evidence

---

## 6. METRIC AUTHORITY

### Metric Derivation Source
```typescript
// benchmark/tools.ts:120-129
function metricsFromResults(results: BenchmarkExecutionResult[]): BenchmarkMetrics {
  const total = Math.max(1, results.length)
  const successCount = results.filter(r => r.outcome === 'task-successful').length
  const errored = results.filter(r => r.outcome === 'execution-failure').length
  const scores = results.map(r => r.score)
  const durations = results.map(r => r.durationMs)
  return computeMetrics(total, successCount, scores, errored, [], durations)
}
```

### Single-Run Live Metrics (evo_benchmark_live)
```typescript
// benchmark/tools.ts:359-365
const liveMetrics: BenchmarkMetrics = {
  successRate: outcome === 'task-successful' ? 1 : 0,
  avgScore: outcome === 'task-successful' ? 1 : 0,
  errorRate: outcome === 'execution-failure' ? 1 : 0,
  avgSteps: 0,
  avgDurationMs: result.durationMs,
}
```

### Metric Influence Chain
| Input | Source | Caller-Controlled? |
|-------|--------|-------------------|
| outcome | classifyOutcome(result, expectedExitCode, expectedOutput) | Partially (via expectedExitCode/expectedOutput) |
| score | outcome === 'task-successful' ? 1.0 : 0.0 | No (derived from outcome) |
| durationMs | result.durationMs (measured by sandbox) | No (measured value) |
| errorRate | outcome === 'execution-failure' ? 1 : 0 | No (derived from outcome) |
| avgSteps | Always 0 in live mode | N/A (placeholder) |

### classifyOutcome Logic (outcome.ts)
```typescript
// outcome.ts — three-way classification
// 'execution-failure'  → OOM, timeout, spawn failure (exitCode null)
// 'unsuccessful-outcome' → non-zero exit (legacy path)
// 'task-successful'    → exit 0 (or matches expectedExitCode)
```

**Critical distinction:** The system authenticates a **metrics object produced by host code**, NOT the raw benchmark result. The provenance seal covers (candidateId, version, command, createdAt) but NOT the metrics blob. This means:
- The seal proves "this record was created at this time with these execution parameters"
- The seal does NOT prove "these metrics accurately reflect the execution outcome"

### Who Executes vs Who Parses
- **Executes:** `BubblewrapSandbox.exec()` or `NodeProcessSandbox.exec()` — host-controlled, no caller override
- **Parses output:** `classifyOutcome()` in outcome.ts — deterministic function, no caller influence on classification (except via expectedExitCode/expectedOutput oracles)
- **Derives metrics:** `metricsFromResults()` / inline computation in tools.ts — pure function of execution results
- **Writes record:** `store.addBenchmark()` — writes to disk, includes provenance seal

**Answer to Q (section 5):** The system authenticates the **metrics object produced by host code**, not the raw benchmark result. The provenance seal binds the execution context fields (candidateId, version, command, createdAt) but explicitly does NOT bind the metrics blob (documented in provenance.ts:17-21).

---

## 7. EVIDENCE AUTHORITY — What HMAC Actually Authenticates

### Provenance Seal Composition
```typescript
// provenance.ts:36-39
export function createLiveProvenance(candidateId, version, command, createdAt): string {
  const input = `${candidateId}|${version}|${command}|${createdAt}`
  return createHash('sha256').update(input).digest('hex')
}
```

### What the Seal Proves
| Claim | Verdict | Explanation |
|-------|---------|-------------|
| A. Producer authenticity | **FAIL** | SHA-256 is a hash, not a signature. Any process with access to the source fields can recompute the hash. No secret key is used. |
| B. Actual benchmark execution | **PARTIAL** | Proves the record was created with those parameters at that timestamp, but does not prove a sandbox process actually ran. The record could be fabricated with matching fields. |
| C. Authorized benchmark execution | **FAIL** | No authorization check is part of the seal. Anyone who knows candidateId, version, command, and createdAt can compute the seal. |
| D. Intended candidate | **PARTIAL** | candidateId is in the seal, but the seal doesn't prove the candidate existed at that time or had the content used in execution. |
| E. Intended baseline | **FAIL** | version is in the seal, but no baseline content check. |
| F. Authoritative metrics | **FAIL** | metrics blob is EXPLICITLY NOT part of the seal (documented in provenance.ts:17-21). |
| G. Valid promotion context | **PARTIAL** | The seal catches tampering of the four context fields. But metrics can be independently changed without breaking the seal. |

### Verification Logic (promote/index.ts:78-92)
```typescript
if (candidateSealed || activeSealed) {
  if (!verifyLiveProvenance(candidateLatest)) {
    return { ok: false, error: 'provenance seal mismatch...' }
  }
}
```
**Gap:** Verification ONLY runs when `candidateSealed || activeSealed`. If BOTH sides are unsealed (pre-M3.3 records), the seal check is skipped entirely. This is the documented "legacy unsealed evidence bypass" mentioned in the known facts.

---

## 8. PROMOTION AUTHORITY

### Authoritative Function
`evaluatePromotionPolicy()` in `src/host/modules/promote/index.ts:26-105` is the authoritative gate.

### Call Path Map
| Caller | Evidence Check | Trust Check | Policy Check | Effect |
|--------|---------------|-------------|--------------|--------|
| `evo_promote` (tool) | mode !== 'live' → reject | provenance seal (if either side sealed) | beats_active + thresholds | version create + artifact materialize + activation refresh |
| `evo_full_cycle` → `runPromotionPolicy()` | none (internal orchestration) | provenance seal (via evaluatePromotionPolicy) | beats_active + thresholds | version create + artifact materialize + activation refresh |
| `runPromotionPolicy()` | — | — | — | Delegates to evaluatePromotionPolicy + executePromotion |

### Promotion Bypass Vectors (Identified)

**Bypass 1: Simulated evidence on first promotion**
- `evaluatePromotionPolicy` skips beats_active when `capturedActiveMetrics` is undefined (no active version) — promote/index.ts:61-66
- `evo_promote` tool also checks `latestEvidence.mode !== 'live'` — but for the FIRST version, there is no active version to compare against
- Test 4 in m33-evidence-trust-boundary.spec.ts confirms: first version with simulated evidence IS accepted
- **Impact:** First promotion can succeed with simulated evidence

**Bypass 2: Legacy unsealed evidence**
- If both candidate and active benchmark records lack provenance seals, the seal check is skipped (promote/index.ts:82)
- A forged unsealed live record with high metrics would pass the beats_active comparison
- **Impact:** Records created before M3.3 (or records where provenance was never set) can promote if metrics are favorable

**Bypass 3: Direct store mutation**
- `store.addBenchmark()` has no authentication. An attacker with filesystem access can write a benchmark record with any fields
- The provenance seal is a hash, not a MAC — no secret key prevents forgery of the seal itself
- **Impact:** Attacker can create a benchmark record with forged provenance by computing the hash from chosen fields

**Bypass 4: Tool-level vs internal path divergence**
- `evo_promote` tool enforces `mode === 'live'` at line 40
- `runPromotionPolicy()` (called by evo_full_cycle) does NOT re-check mode — it delegates to evaluatePromotionPolicy which only rejects simulated when active has live evidence
- If an active version has simulated evidence, a candidate with simulated evidence can pass evaluatePromotionPolicy (no active live baseline to compare against)

### Re-resolution at Promotion
- **Candidate re-resolved?** YES — `executePromotion` receives the candidate object from the caller, but `materializeArtifact` re-reads `candidate.files` and `candidate.tests` at promotion time
- **Baseline re-resolved?** YES — `evaluatePromotionPolicy` reads the current active version and its latest benchmark each time
- **Evidence trusted directly?** PARTIALLY — metrics are read from the persisted record; provenance seal is verified if either side has one

---

## 9. EXISTING TRUST MECHANISMS

| Mechanism | Location | What It Proves | What It Does NOT Prove | Who Controls It |
|-----------|----------|----------------|------------------------|-----------------|
| `isSafeKey()` | lib/ids.ts:19 | Path component is alphanumeric-safe | That the ID refers to the intended entity | Host code |
| `writeJsonAtomic()` | lib/fsx.ts | Atomic write (no partial reads) | That the content is correct/untampered | Host code |
| `containPath()` | lib/contain.ts | File path is within expected root | That the content is correct | Host code |
| `containBenchmarkCwd()` | benchmark/tools.ts:39 | CWD is within tmpDir | That the command is the intended one | Host code |
| `createLiveProvenance()` | lib/provenance.ts:31 | Fields were consistent at record-write time | That execution actually occurred; that metrics are accurate | Anyone with field values |
| `verifyLiveProvenance()` | lib/provenance.ts:55 | Fields match the recorded seal | That metrics are authoritative; that execution was authorized | Anyone who can read the record |
| `evaluation.generation` | host/store.ts:27-30 | Optimistic concurrency on active pointer | That the pointer points to a valid artifact | Host code |
| `ArtifactManifest.contentHash` | host/modules/activation/artifact.ts:61 | Hash of candidate files at artifact-materialization time | That the candidate record matches; not verified on read | Host code |
| `candidate.status` | host/types.ts:57 | Lifecycle state machine value | That the status reflects actual execution | Host code (mutable) |
| `DEFAULT_PROMOTION_POLICY` | host/types.ts:366 | Fixed thresholds for promotion | That the thresholds are appropriate for the domain | Config |
| `cfg().evolution.generation.enabled` | host/config.ts | Operator toggle for auto-generation | — | Operator config |
| `cfg().evolution.promotion.enabled` | host/config.ts | Operator toggle for auto-promotion | — | Operator config |
| `active-version.json` | host/store.ts | Canonical pointer to active version | That the pointed-to version is valid | Host code |

**No existing mechanism establishes:**
- Cryptographic attestation of sandbox execution
- Binding between candidate ID and candidate content (no hash-in-ID scheme)
- Authentication of benchmark metrics against actual execution output
- Caller authorization for tool execution
- Baseline content stability guarantee

---

## 10. ATTACK PATH (Minimal Path to Promotion-Eligible Evidence)

### Path 1: Direct Store Forgery (filesystem access)
```
1. Attacker writes to <stateRoot>/benchmarks/<id>.json
   {
     "candidateId": "<target>",
     "version": "<parentVersion>",
     "baseline": "<parentVersion>",
     "runs": 3,
     "metrics": { "successRate": 1.0, "avgScore": 1.0, "errorRate": 0, "avgSteps": 0, "avgDurationMs": 100 },
     "passed": true,
     "mode": "live",
     "command": "node test.js",
     "provenance": sha256("<target>|<parentVersion>|node test.js|<any-ISO-timestamp>"),
     "createdAt": "<that-same-ISO-timestamp>"
   }
2. Attacker calls evo_promote with candidateId=<target>
3. evaluatePromotionPolicy reads the record, verifies seal (matches), checks metrics (1.0 >= 0.8)
4. Promotion succeeds — candidate promotes without ever being executed in a sandbox
```
**Why this works:** The provenance seal is a PUBLIC hash, not a secret-key MAC. Any actor who can write the benchmark JSON can also compute the seal. The seal proves nothing about who created the record — only that the fields are internally consistent.

### Path 2: Call Chain Override (tool-level)
```
1. Attacker calls evo_benchmark_live with:
   - candidateId=<any-existing-candidate>
   - command=<attacker-chosen-command>
   - expectedExitCode=0
2. The tool executes the command (possibly benign, possibly arbitrary if sandbox is compromised)
3. The tool creates a benchmark record with the ACTUAL execution result
4. If the command happens to pass, the candidate gets benchmarked status
5. Attacker calls evo_promote
6. Promotion proceeds if metrics pass threshold
```
**Why this works:** There is no authorization check on who can call evo_benchmark_live. Any caller can benchmark any candidate they know the ID of.

### Path 3: Simulated Evidence First Promotion (documented bypass)
```
1. System has no active version (fresh state root or all versions rolled back)
2. Attacker calls evo_benchmark_run with candidateId=<target>
3. simulated evidence is created (mode='simulated', metrics derived from experiences)
4. Attacker calls evo_promote
5. evaluatePromotionPolicy: capturedActiveMetrics is undefined → beats_active gate SKIPPED
6. evo_promote tool: latestEvidence.mode === 'simulated' → REJECTED
   BUT: runPromotionPolicy (internal) does NOT check mode === 'live'
7. If evo_full_cycle is running, it calls runPromotionPolicy directly, bypassing the tool-level check
```
**Why this works:** The tool-level mode check in evo_promote (tools.ts:40) is not enforced by the internal policy path (index.ts). evo_full_cycle uses runPromotionPolicy which skips the tool-level check.

---

## 11. I1-I7 MATRIX

| Claim | PROVEN | PARTIAL | FAIL | UNKNOWN |
|-------|--------|---------|------|---------|
| I1: A caller with tool access can trigger benchmark execution | | | X | |
| I2: Benchmark execution produces a record that can be read by any caller | X | | | |
| I3: The provenance seal is computable by anyone who knows the four fields | X | | | |
| I4: The provenance seal does NOT cover metrics | X | | | |
| I5: First-version promotion accepts simulated evidence (policy gate) | | | X | |
| I6: Legacy unsealed evidence bypasses seal verification when both sides unsealed | | X | | |
| I7: Candidate content is mutable after benchmark evidence creation | | | X | |
| I8: Baseline content is mutable after benchmark evidence creation | | | X | |
| I9: No caller authorization exists on any benchmark tool | X | | | |
| I10: Sandbox isolation prevents host process escape (bubblewrap) | | X | | (only verified for BubblewrapSandbox; NodeProcessSandbox has no isolation) |
| I11: The evo_promote tool blocks simulated evidence; runPromotionPolicy does not | | X | | |
| I12: Artifact materialization re-reads candidate content at promotion time | X | | | |

---

## 12. HMAC SUFFICIENCY

**Current mechanism:** SHA-256 hash over (candidateId, version, command, createdAt) — NO secret key.

**Classification:** This is a **hash**, not an HMAC. The term "HMAC" in the research question is a misnomer for the current implementation.

### Would an HMAC (secret-key MAC) solve the authority problem?

| Aspect | Current Hash | HMAC (secret key) |
|--------|-------------|-------------------|
| A. Producer authenticity | FAIL | PARTIAL — proves host process had the key, but key could be leaked |
| B. Actual benchmark execution | PARTIAL | PARTIAL — proves record was signed, but not that sandbox ran |
| C. Authorized benchmark execution | FAIL | PARTIAL — key holder = authorized, but key management is the question |
| D. Intended candidate | PARTIAL | PARTIAL — candidateId in seal, but content not verified |
| E. Intended baseline | FAIL | FAIL — baseline not in seal |
| F. Authoritative metrics | FAIL | FAIL — metrics not in seal |
| G. Valid promotion context | PARTIAL | PARTIAL — catches field tampering, not metrics tampering |

**Verdict:** HMAC alone is **INSUFFICIENT**. It would close the forgery vector (Path 1 above) but would NOT:
- Bind metrics to execution
- Prevent a legitimate execution from producing manipulated metrics
- Cover baseline content
- Authenticate that the right candidate content was used
- Prevent the simulated-evidence first-promotion bypass

---

## 13. FRESH EXECUTION

### Does the architecture support it?
**Partial yes.** `evaluatePromotionPolicy` is a pure function that reads store state and returns a decision. `executePromotion` performs mutations. The architecture could support a pattern where:

```
promotion-requested
  → resolve candidate from store (canonical)
  → resolve baseline from store (canonical)
  → execute benchmark in sandbox (host-controlled, no caller input)
  → derive metrics from result
  → apply promotion policy to fresh metrics
  → if passes, execute promotion
```

### Prerequisites
1. **Sandbox availability:** `getSandbox().isAvailable()` — already checked in benchmark tools
2. **Candidate resolution at promotion time:** Already happens (executePromotion takes candidate object)
3. **Baseline resolution at promotion time:** Already happens (evaluatePromotionPolicy resolves active version)
4. **No caller-controlled command at promotion:** Would require removing command from promotion inputs

### Limitations
- **State root race:** Between resolution and execution, another promotion could change the active version
- **Candidate mutability:** Between resolution and execution, candidate.content could change
- **No replay protection:** A fresh execution at promotion time cannot be verified against the original benchmark (the original evidence would be orphaned)
- **Performance:** Fresh execution on every promotion request adds latency

### Would it materially change promotion semantics?
**Yes.** It would replace evidence-based promotion with execution-based promotion. The current model trusts persisted evidence; the fresh-execution model trusts the act of execution itself. This is a fundamentally different trust model — not an enhancement, but a replacement.

---

## 14. AUTHORITY MODEL (Complete Chain)

```
CALLER
  ↓  [REQUEST AUTHORITY]
  TRUSTED SOURCE: DSH tool registry (no access control)
  CONTROLLED BY: Any session with plugin tools enabled
  VERIFIED WHERE: Nowhere — no verification exists
  PROVEN / UNKNOWN: UNKNOWN (no authorization layer)
  │
  ▼
CANDIDATE AUTHORITY
  TRUSTED SOURCE: store.addCandidate() → newId() (crypto-random)
  CONTROLLED BY: Any caller with evo_candidate_create or evo_builder_generate
  VERIFIED WHERE: isSafeKey() at read time (path safety only)
  PROVEN / UNKNOWN: Identity PROVEN; Content UNKNOWN (mutable)
  │
  ▼
COMMAND AUTHORITY
  TRUSTED SOURCE: Caller argument (string)
  CONTROLLED BY: Caller
  VERIFIED WHERE: containBenchmarkCwd() (containment only)
  PROVEN / UNKNOWN: UNKNOWN — command is not bound to any authoritative source
  │
  ▼
BASELINE AUTHORITY
  TRUSTED SOURCE: store.getCandidate(candidate.parentVersion)
  CONTROLLED BY: Store state (mutable)
  VERIFIED WHERE: None at benchmark time; re-resolved at promotion time
  PROVEN / UNKNOWN: Identity PARTIAL; Content UNKNOWN (mutable)
  │
  ▼
EXECUTION AUTHORITY
  TRUSTED SOURCE: BubblewrapSandbox.exec() / NodeProcessSandbox.exec()
  CONTROLLED BY: Host process (sandbox isolation)
  VERIFIED WHERE: classifyOutcome() — deterministic, no caller influence on outcome enum
  PROVEN / UNKNOWN: Execution is host-controlled; classification is deterministic
  │
  ▼
METRIC AUTHORITY
  TRUSTED SOURCE: metricsFromResults() — pure function of execution results
  CONTROLLED BY: Host code (no caller influence after execution)
  VERIFIED WHERE: NEVER — metrics are written to disk without verification
  PROVEN / UNKNOWN: UNKNOWN — metrics trust depends on execution integrity, not independent verification
  │
  ▼
EVIDENCE AUTHORITY
  TRUSTED SOURCE: store.addBenchmark() writes provenance seal
  CONTROLLED BY: Host code (provenance computation)
  VERIFIED WHERE: evaluatePromotionPolicy → verifyLiveProvenance()
  PROVEN / UNKNOWN: Seal proves field consistency, NOT metrics accuracy
  │
  ▼
PROMOTION AUTHORITY
  TRUSTED SOURCE: evaluatePromotionPolicy() — policy gate
  CONTROLLED BY: Policy configuration (DEFAULT_PROMOTION_POLICY)
  VERIFIED WHERE: Provenance seal check (conditional on seal presence)
  PROVEN / UNKNOWN: PARTIAL — gate exists but has documented bypasses
```

### First Untrusted-to-Trusted Transition Point
**The earliest point where untrusted caller input becomes trusted state is at `store.addBenchmark()` (store.ts:290).** Specifically:

1. Caller provides `candidateId` → resolved via `store.getCandidate()` (trusted resolution)
2. Caller provides `command` → executed in sandbox (host-controlled execution)
3. Execution result → classified deterministically (host-controlled)
4. Metrics computed from classification (host-controlled)
5. **Record written to disk with provenance seal** (host-controlled computation, but seal is a public hash)

The transition from "caller-controlled command" to "host-authored evidence" occurs at step 4-5. The provenance seal is computed by host code and included in the record — this is the first point where a trustworthy marker is added. However, because the seal is a PUBLIC hash (not an HMAC with a secret key), it provides no authenticity guarantee against an attacker who can write to the state root directory.

---

## 15. FIVE-ROLE REVIEW

### ARGUS (Earliest attacker-controlled input becoming trusted)
- **Scope:** End-to-end pipeline from caller to promotion
- **Method:** Trace every input field from caller argument to trusted state
- **Evidence:** benchmark/tools.ts:267 (command ← caller), store.ts:290 (addBenchmark writes seal)
- **Finding:** The earliest transition is at `store.addBenchmark()` — caller-controlled command becomes host-authored evidence via provenance seal computation. However, there is an EARLIER transition point: `writeCandidateFiles()` at benchmark/tools.ts:149 writes attacker-controlled file content to tmpDir BEFORE sandbox execution. And `sandbox.exec()` at benchmark/tools.ts:309 is where the command enters host-controlled territory (~61 lines before addBenchmark). The report's "earliest trusted point" claim was PARTIALLY WRONG: `BubblewrapSandbox.exec()` (line 309) is earlier than `store.addBenchmark()` (line 370) for the command path, and `writeCandidateFiles()` (line 149) is an even earlier transition for the candidate-content path.
- **Residual:** Seal computation is a post-hoc marker, not an entry-point into trust. The sandbox execution IS the true authority boundary for command; the file write is the boundary for candidate content.
- **Verdict:** The earliest trusted transition for COMMAND is `sandbox.exec()` at tools.ts:309. For CANDIDATE CONTENT it is `writeCandidateFiles()` at tools.ts:149. The report's claim about `store.addBenchmark()` being the earliest is WRONG for command flow.

### BADSECTOR (Smallest attacker path without forging HMAC)
- **Scope:** Minimal attack requiring only filesystem write access to state root
- **Method:** Construct the shortest sequence of operations that produces promotion-eligible evidence
- **Evidence:** provenance.ts:31-39 (public hash); store.ts:290-297 (unauthenticated write); badsector agent confirmed 3-tool-call path
- **Finding — Minimal path (3 tool calls, 0 file writes):**
  1. `evo_candidate_create` with files: [{path: "src/index.ts", content: "console.log('ok'); process.exit(0);"}]
  2. `evo_benchmark_live` with command: "node src/index.ts", expectedExitCode: 0
  3. `evo_promote` with candidateId
  All 7 policy gates collapse to no-ops on first promotion (no active version). The only hard gate is #3 (mode === 'live' check at promote/tools.ts:35-45), which is satisfied by step 2.
- **Alternative path (3 operations, filesystem access required):**
  1. Write forged benchmark JSON with computed `sha256(candidateId|version|command|createdAt)` seal
  2. Call `evo_promote`
  3. Promotion succeeds — no sandbox execution ever happened
- **Verdict:** Two distinct attack surfaces: (a) tool-level attack with legitimate execution (3 calls), (b) filesystem-level attack with forged records (3 operations). Neither requires a secret key.

### ATLAS (Existing authority boundary reuse potential)
- **Scope:** Search for mechanisms that could serve as trust anchors
- **Method:** Enumerate all candidate mechanisms, assess reuse potential
- **Evidence:** 11 mechanisms audited (Atlas subagent) — provenance seal, generation counter, createdAt timestamps, ModuleDeps/ctx, newId(), state-root scoping, sandbox isolation, writeJsonAtomic, active-version pointer, in-memory activation state, absence of process.pid/argv0
- **Finding:** NO existing mechanism provides cryptographic authenticity. Key findings:
  - `provenance` seal: field-level consistency check only; no host identity input (recomputable by anyone with the four field values)
  - `generation` counter: monotonic per-store-instance but scoped to store, not host process
  - `createdAt` timestamps: wall-clock, forgeable, no monotonic guarantee
  - `ctx`/`ModuleDeps`: dependency-injection handle with no identity-bearing property; same shape in tests and production
  - `newId()`: pure crypto-randomness; zero authority attribution
  - `process.pid`/`process.argv0`: NOT present anywhere in src/ — no process identity is captured at all
  - Sandbox isolation: execution is isolated but the evidence record wrapping carries no attestation
- **Residual:** The architecture contains zero properties tying a persisted benchmark record to the identity of the host process that wrote it. An attacker with filesystem write access can recompute any provenance seal from the four field values and forge an indistinguishable record.
- **Verdict:** NOT REUSABLE. Any trust-boundary mechanism requires introducing a new host-bound secret (boot-generated key, process-local nonce, or similar out-of-band property). No existing mechanism can serve this role.

### VERA (Authority claims mapped to tests)
- **Scope:** Map each test to the architectural claim it actually proves
- **Method:** Read test files, identify what is actually verified
- **Evidence:** m33-evidence-trust-boundary.spec.ts (8 tests), check6-liveCycle.spec.ts, promotion-e2e.spec.ts
- **Mapping:**
  | Test | Claim | Actually Proves |
  |------|-------|-----------------|
  | m33-1: simulated rejected by policy | Simulated evidence fails beats_active | TRUE when active has live evidence; SKIP when no active |
  | m33-2: simulated rejected by tool | Tool blocks simulated | TRUE |
  | m33-3: live evidence allows promotion | Live evidence passes policy | TRUE (if seal valid + beats_active) |
  | m33-4: first version simulated accepted | First version has no active to compare | TRUE — documented bypass |
  | m33-5: forged provenance rejected | Wrong seal is caught | TRUE |
  | m33-6: cross-candidate reuse rejected | Seal binds candidateId | TRUE |
  | m33-7: replay documented | Residual gap noted | TRUE — acknowledges tool path is the real gate |
  | m33-8: metrics tampering not caught | Seal doesn't cover metrics | TRUE — documented limitation |
- **Verdict:** Tests correctly document the authority model. No test claims more than what the code delivers.

### ZEKO (Term-to-evidence alignment)
- **Scope:** Verify security-relevant terminology against actual implementation
- **Method:** Search codebase for terms, compare claim vs. reality
- **Evidence:** grep results + code inspection
- **Findings:**
  | Term | Appears In | Supported By Code? |
  |------|-----------|-------------------|
  | trusted | promote/tools.ts:253 ("trusted oracle") | Yes — describes operator-provided oracles |
  | authorized | No matches in evolution code | No — no authorization mechanism exists |
  | authenticated | No matches in evolution code | No — no authentication mechanism exists |
  | provenance | provenance.ts, promote/index.ts | Yes — public hash over 4 fields |
  | attestation | No matches | No — no attestation mechanism |
  | integrity | No matches in evolution code | No — integrity not verified at read time |
  | execution evidence | types.ts:87 ("evidence was produced") | Yes — mode field distinguishes simulated vs live |
- **Verdict:** The codebase uses "trusted" and "provenance" correctly. Terms like "authorized", "authenticated", and "integrity" have NO supporting implementation. The provenance mechanism is accurately described as a "seal" (not a signature or MAC).

---

## 16. RESEARCH CONCLUSIONS

### Q1. What is the earliest trusted point in the benchmark pipeline?
**The earliest trusted point is `BubblewrapSandbox.exec()`** (or `NodeProcessSandbox.exec()` as fallback). This is where caller-controlled input (command string) enters a host-controlled execution environment. Before this point, the pipeline is entirely caller-driven (candidate selection, command, oracles). After this point, classification and metric derivation are deterministic host functions.

However, the **first point where a trustworthy marker is added** is `store.addBenchmark()` with provenance seal computation. This is weak trust because the seal is a public hash.

### Q2. Can an untrusted caller cause the host to create promotion-eligible evidence without knowing the HMAC key?
**YES, trivially.** There is no HMAC key. The provenance mechanism is a PUBLIC SHA-256 hash. An untrusted caller with filesystem write access can:
1. Read any existing benchmark record to learn the format
2. Compute the hash for any chosen (candidateId, version, command, createdAt) tuple
3. Write a benchmark record with the computed hash
4. Call evo_promote to promote based on the forged evidence

The hash provides NO secrecy. It only provides a consistency check that can be satisfied by the forger themselves.

### Q3. If yes, what exactly is being authenticated?
The current mechanism authenticates **field consistency**, not execution. Specifically:
- It proves that a record's (candidateId, version, command, createdAt) tuple is self-consistent
- It does NOT prove that the recorded metrics correspond to any actual execution
- It does NOT prove that the record was created by the host process (as opposed to an attacker who computed the same hash)

### Q4. What existing mechanism, if any, establishes candidate authority?
**Identity authority:** `store.addCandidate()` → `newId()` — the only writer of candidate records. **Content authority:** NONE. `updateCandidate()` allows arbitrary content changes. `contentHash` is computed at artifact materialization but never verified on read.

### Q5. What existing mechanism, if any, establishes baseline authority?
**None.** Baseline is resolved from `candidate.parentVersion` at benchmark time, but baseline content is the same mutable candidate record. No binding exists between the baseline ID and its content at the time of benchmark.

### Q6. What existing mechanism, if any, establishes metrics authority?
**None.** Metrics are derived deterministically from execution results by host code, but the derived metrics are stored without any verification mechanism. The provenance seal explicitly excludes the metrics blob.

### Q7. Is HMAC alone sufficient?
**NO.** Even with a proper secret-key HMAC:
- It would prevent forgery of the seal (closes Path 1)
- It would NOT bind metrics to execution (metrics not in seal)
- It would NOT prevent authorized execution of wrong commands (command in seal but not verified post-execution)
- It would NOT address the first-promotion simulated evidence bypass
- It would NOT address legacy unsealed evidence bypass
- It would NOT prevent baseline content drift

### Q8. Is one additional authority boundary sufficient?
**No.** The authority gaps are multi-dimensional:
- Caller authorization (who can trigger benchmark)
- Candidate content binding (ID ↔ content)
- Baseline content binding (ID ↔ content)
- Metrics binding (execution ↔ metrics)
- First-promotion special case
- Legacy record compatibility

One boundary (e.g., HMAC with key) closes the forgery vector but leaves all other gaps open.

### Q9. Is fresh execution required?
**Not strictly required, but it would materially strengthen the model.** Fresh execution at promotion time eliminates the need to trust persisted evidence. However, it introduces new concerns:
- Race conditions between resolution and execution
- State root consistency
- Performance overhead
- Determinism (same candidate + command may produce different outcomes due to environment variance)

Fresh execution is a **sufficient but not necessary** condition for strong authority. It trades evidence trust for execution trust.

### Q10. What is the smallest change that creates a real authority boundary?
**Adding a boot-generated process-local secret key to the provenance seal computation** (making it a true HMAC instead of a public hash). This single change:
- Closes the direct forgery vector (Path 1) — an attacker without the key cannot compute a valid seal
- Makes the seal meaningful as an authenticity marker — only the host process that generated the key can produce valid seals
- Requires no architectural restructuring
- Is backward-compatible (existing unsealed records remain unsealed; new records get HMAC seals)

**However**, this is a necessary but NOT sufficient change for complete authority. It does NOT address:
- Metrics binding (metrics not in seal)
- Candidate content binding (no hash-of-contents in candidate record)
- Baseline content binding
- First-promotion simulated-evidence bypass
- Legacy unsealed-record bypass
- Caller authorization
- NodeProcessSandbox fallback (no namespace isolation)

---

## 17. FINAL RESEARCH REPORT

### 1. EXECUTION PIPELINE
Traced completely from caller → tool → validation → candidate resolution → command resolution → baseline resolution → sandbox execution → output collection → metric derivation → evidence creation → persistence → promotion. Full detail in sections 1-8 above.

### 2. CALLER AUTHORITY
Any caller with tool access can trigger any benchmark path. No authentication gate exists at the tool registration or execution level. `evo_full_cycle` internally calls `evo_benchmark_live` with caller-provided `testCommand`.

### 3. CANDIDATE AUTHORITY
Identity: PROVEN (store.addCandidate is sole writer). Content: FAIL (mutable via updateCandidate, no content-hash binding).

### 4. COMMAND AUTHORITY
Command is caller-controlled string, executed verbatim in sandbox. Not derived from candidate data. No command-canonicalization or command-attribution check beyond containment.

### 5. BASELINE AUTHORITY
Resolved from store (candidate.parentVersion or active version's first module). Content is mutable. No binding between baseline ID and content at benchmark time.

### 6. METRIC AUTHORITY
Metrics are host-derived from execution results. No verification mechanism exists. The system authenticates a metrics OBJECT, not the benchmark RESULT. The provenance seal explicitly excludes metrics.

### 7. EVIDENCE AUTHORITY
The current "provenance seal" is a PUBLIC SHA-256 hash, not an HMAC. It proves field consistency, not execution authenticity. Verification is conditional (skipped when both sides unsealed).

### 8. PROMOTION AUTHORITY
`evaluatePromotionPolicy` is the authoritative gate. Three bypass vectors identified:
1. First promotion with simulated evidence (no active to compare)
2. Legacy unsealed records (seal check skipped when both sides unsealed)
3. Direct store mutation (public hash is forgeable)

### 9. EXISTING TRUST MECHANISMS
12 mechanisms identified. None provide cryptographic authenticity. The closest are writeJsonAtomic (atomicity) and generation counter (concurrency safety).

### 10. ATTACK PATH
**Minimal path (3 operations):**
1. Attacker writes forged benchmark JSON with computed hash to `<stateRoot>/benchmarks/<id>.json`
2. Attacker calls `evo_promote(candidateId=<target>)`
3. Promotion succeeds if forged metrics exceed thresholds

**Alternative path (tool-level):**
1. Attacker calls `evo_benchmark_live(candidateId=<target>, command=<any>)`
2. Executes actual command in sandbox
3. If exit-0, candidate gets benchmarked status
4. Attacker calls `evo_promote` — promotion proceeds

### 11. I1-I7 MATRIX
| ID | Claim | Verdict |
|----|-------|---------|
| I1 | Caller can trigger benchmark | FAIL (no auth) |
| I2 | Record is readable by any caller | PROVEN |
| I3 | Seal is computable by anyone | PROVEN (public hash) |
| I4 | Seal doesn't cover metrics | PROVEN (documented) |
| I5 | First promotion accepts simulated | FAIL (bypass) |
| I6 | Legacy unsealed bypasses seal | PARTIAL (conditional) |
| I7 | Candidate content is mutable | FAIL (no binding) |

### 12. HMAC SUFFICIENCY
**INSUFFICIENT.** Current mechanism is a public hash, not an HMAC. Even a proper HMAC would not bind metrics, candidates, or baselines.

### 13. FRESH EXECUTION
**CONDITIONAL.** Architecture supports it but with race-condition and determinism concerns. Would replace evidence trust with execution trust — a semantic shift, not an incremental improvement.

### 14. SMALLEST TRUST-BOUNDARY CHANGE
**Make the provenance seal a true HMAC with a process-local secret key.** This is a one-line change in `lib/provenance.ts` (replace `createHash('sha256')` with `createHmac('sha256', secret).update(...)`). This closes the forgery vector. However, additional changes are needed for complete authority.

### 15. FIVE-ROLE REVIEW
- **ARGUS:** Earliest trusted transition for COMMAND is `sandbox.exec()` at benchmark/tools.ts:309 (~61 lines before addBenchmark). For CANDIDATE CONTENT it is `writeCandidateFiles()` at line 149. The report's earlier claim that `store.addBenchmark()` was the earliest was WRONG — the provenance seal is a post-hoc verification marker, not an entry-point into trust territory.
- **BADSECTOR:** Two distinct minimal attack paths: (a) 3-tool-call legitimate path (create→benchmark_live→promote) that requires no forgery, only knowledge of candidateId and a passing command; (b) 3-operation filesystem path (write forged JSON with computed hash → call promote) that bypasses sandbox entirely. Neither requires a secret key.
- **ATLAS:** 11 mechanisms audited. ZERO provide cryptographic authenticity. `process.pid`/`process.argv0` are not present in src/ — no process identity is captured. Any trust anchor requires introducing a new host-bound secret. NOT REUSABLE as-is.
- **VERA:** 6 claims verified. 4 PROVEN (addCandidate sole writer, seal covers 4 fields not metrics, first-promotion simulated accepted, no caller auth). 1 PARTIAL (candidate content mutability is type-possible but untested via updateCandidate with files). 1 PROVEN with test gap (legacy unsealed bypass — code proven, no dedicated dual-unsealed test).
- **ZEKO:** Terminology is largely accurate but with one credibility gap: "provenance seal" and "integrity gate" borrow cryptographic connotations from a keyless SHA-256 fingerprint. The code is transparent about the limitation (explicit scope-limitation comment at provenance.ts:14-21, regression test m33-integrity-regression.spec.ts), but a reader skimming the term "seal" without reading the comments would overestimate the guarantee.
- **ATLAS:** No existing mechanism can serve as trust anchor without adding a secret key. Generation counter pattern is adaptable.
- **VERA:** Tests correctly document the authority model. No over-claiming. Test m33-8 explicitly acknowledges the metrics-gap limitation.
- **ZEKO:** "Authorized", "authenticated", "integrity", "attestation" have NO implementation support. "Provenance" and "trusted" are used correctly.

### 16. RESIDUAL RISKS
1. **Public hash forgery:** Any filesystem-writable process can forge benchmark records
2. **Metrics decoupling:** Provenance seal does not cover metrics blob
3. **First-promotion bypass:** Simulated evidence accepted when no active version exists
4. **Legacy bypass:** Unsealed records skip seal verification when both sides are unsealed
5. **Content mutability:** Candidate and baseline content can change after evidence creation
6. **No caller authorization:** Any tool caller can trigger any benchmark path
7. **NodeProcessSandbox fallback:** No namespace isolation when bubblewrap is unavailable
8. **Race condition in promotion:** Active version can change between policy evaluation and execution

### 17. OPEN QUESTIONS
1. What is the threat model for the state root directory? Who has write access, and under what conditions?
2. Should the provenance seal include a metrics hash? (Would invalidate all existing sealed records)
3. Is caller authorization a requirement, or is the threat model limited to offline state-root tampering?
4. Should first-promotion simulated evidence be rejected unconditionally, or is the current behavior acceptable for bootstrap?
5. What is the operational impact of making the provenance key process-local (key loss on restart = all new records un-verifiable by old records)?
6. Is the NodeProcessSandbox fallback a security risk, and should it be disabled in production?

### 18. DECISION
**NOT READY for design.**

The authority model has not been fully traced. Critical gaps exist at multiple layers (caller auth, content binding, metrics binding). The current "HMAC" is a public hash, not a authentication mechanism. Before designing any trust mechanism, the threat model must be clarified (Q1 above), and the scope of the authority boundary must be defined (what exactly must be protected against).

The research demonstrates that:
- The system has NO caller authorization
- The provenance seal is NOT an authentication mechanism
- Evidence can be forged with filesystem write access
- Multiple documented bypass paths exist

Any design that addresses only the HMAC weakness without addressing the broader authority gaps would be insufficient. A complete design requires:
1. Clarified threat model
2. Defined authority boundary scope
3. Multi-layer mechanism design (auth + binding + metrics)

---

**End of Research Report.**
