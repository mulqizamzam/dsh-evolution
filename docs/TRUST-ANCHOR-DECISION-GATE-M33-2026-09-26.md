# M3.3.2 — Trust Anchor Decision Gate Report

**Commit:** c29e08f (M3.3)
**Date:** 2026-09-26
**Verdict:** NOT READY — key trust boundary cannot be established with config-file key;
**BOOT-GENERATED HMAC IS VIABLE AND PREFERRED OVER CONFIG-KEY HMAC**

---

## THREAT MODEL

### Attack Boundary Trace

```
candidate execution
  → sandbox (bubblewrap, --clearenv, no $DSH_HOME mount)
    → mounts: /usr, /lib, /bin, NODE_BIN_DIR, options.cwd (mkdtemp), tmpfs /tmp, /proc, /dev
    → stateRoot: <DSH_HOME>/dsh-evolution/<profile>/   ← ATTACKER-CONTROLLED
    → config: cordis.patch.yml (plugin source tree or profile bundle install dir)
    → environment: process.env (visible to same-user processes via /proc/<pid>/environ)
    → host process: Node.js, full filesystem access, NO sandbox isolation
    → benchmark tool: runs in-process, calls createLiveProvenance(), calls store.addBenchmark()
    → promotion: runs in-process, calls verifyLiveProvenance(), reads store state
```

### Attacker Capabilities — PROVEN

| Capability | Status | Evidence |
|-----------|--------|----------|
| Read stateRoot | **PROVEN** | `resolveStateRoot()` → `<DSH_HOME>/dsh-evolution/<profile>/` (home.ts:26-50) |
| Write stateRoot | **PROVEN** | `addBenchmark` uses `writeJsonAtomic` to `<root>/benchmarks/*.json` (store.ts:290-297) |
| Read config (cordis.patch.yml) | **INFERRED: YES** | Config is a plain YAML file on same filesystem under `$DSH_HOME/` or workspace root; same-user process can read all sibling files |
| Modify config | **INFERRED: YES** | `ctx.settings.register('dsh-evolution', ...)` at `index.ts:97` registers a **live-writable** settings scope; `settings/updated` event at lines 110-118 allows runtime override |
| Read environment | **PROVEN** | Same-user process can read `/proc/self/environ`; `process.env` is accessible |
| Influence environment consumed by host | **PROVEN** | Host reads `DSH_HOME`, `HOME`, `USERPROFILE` from `process.env` (home.ts:56-60); attacker sets env vars before host launch |
| Execute arbitrary host-side code | **UNKNOWN** | Depends on whether agent has tool access to host processes; DSH tool registry has no auth gate (`dsh.ts:83-93`) |
| Cause host to consume attacker-controlled config | **PROVEN** | `ctx.settings.register(..., { base: rawConfig, applies: 'live' })` at `index.ts:97` — runtime settings updates are delivered via `settings/updated` event handler at `index.ts:110-118` |

### Critical Trust Boundary Finding

**The host process and the state root share the same filesystem namespace with no OS-level isolation.** An attacker with state-root write access who also has same-user read access can:

1. Read the signing key from `cordis.patch.yml` (same filesystem, no sandbox boundary)
2. Or manipulate the live settings scope to inject a known key at runtime
3. Forge valid HMAC signatures with the known key

The bubblewrap sandbox isolates the **benchmark command** but does NOT isolate the **plugin host process**. The host process has unrestricted filesystem access. There is no `HostContextShape` service that provides a secret the host can read but the attacker cannot.

**This is UNKNOWN whether the attacker can read the config, because:**
- If the attacker is the LLM agent running inside the same DSH session: they can invoke any registered tool, but tools don't read config files directly — however, `ctx.settings.register` creates a live-writable scope that could be manipulated
- If the attacker is a different process on the same filesystem: they can read any file, including config
- If the attacker is the host operator: they control everything by definition

**The fundamental problem:** there is no trust anchor in this architecture. Every data source the plugin reads (config, state root, environment) is on the same filesystem and owned by the same user.

---

## HMAC FEASIBILITY

### Config-File HMAC Key — NOT VIABLE

| Criterion | Result | Reason |
|-----------|--------|--------|
| Key outside attacker control | **FAIL** | Key in cordis.patch.yml is on same filesystem as state root; attacker with state-root write + parent read can discover and read it |
| Attacker cannot replace key | **FAIL** | Config is live-writable via `ctx.settings.register` at `index.ts:97` |
| Survives restart | PASS | Config file persists across restarts |
| Metrics authenticated | PASS | metricsHash in seal input |
| Candidate/version binding | PASS | candidateId + version in seal input |
| Baseline/active binding | PARTIAL | Requires verification-time activeVersionId read from current pointer |
| Replay handled | PARTIAL | Requires activeVersionId read at verification time, not from record |
| No unauthenticated fallback | FAIL | Legacy tolerance path (`index.ts:73-77`) creates opening |
| First promotion rule | PARTIAL | Requires additional I6 fix in `evaluatePromotionPolicy` |
| Legacy data fail-closed | FAIL | Legacy tolerance path accepts unsealed records when both sides unsealed |

**Verdict:** Config-file HMAC is architecturally equivalent to no key. The "host-held" distinction evaporates when the host and attacker share a filesystem namespace.

### Boot-Generated Ephemeral HMAC — VIABLE (with caveats)

| Criterion | Result | Reason |
|-----------|--------|--------|
| Key outside attacker control | **PASS** | Key is `randomBytes(32)` in process memory; not on disk, not in config, not in environment |
| Attacker cannot replace key | **PASS** | Key exists only in memory; attacker cannot access process memory |
| Attacker cannot select key | **PASS** | Key is random, not configurable |
| Survives restart | **FAIL** (by design) | Key changes on each process start; old records unverifiable |
| Metrics authenticated | **PASS** | metricsHash in seal input |
| Candidate/version binding | **PASS** | candidateId + version in seal input |
| Baseline/active binding | **PASS** (if implemented correctly) | activeVersionId read from current `store.getActiveVersion()` at verification time |
| Replay handled | **PASS** (within-process) | Record's seal includes activeVersionId from creation time; replay against changed active fails |
| No unauthenticated fallback | **PASS** | All live records MUST have valid HMAC; no legacy tolerance |
| First promotion rule | **PARTIAL** | Requires separate I6 fix in `evaluatePromotionPolicy` (see below) |
| Legacy data behavior | **FAIL-CLOSED** | Pre-HMAC records have no valid HMAC → rejected; operator must re-benchmark |

**Verdict:** Boot-generated ephemeral HMAC is **architecturally superior** to config-file HMAC for the in-process threat model. It provides:
- An unguessable key (not discoverable in source, config, or filesystem)
- Stronger security posture (attacker would need to compromise process memory, not just read a file)
- Zero migration burden (old records are correctly rejected)
- Zero operator provisioning burden (no key to configure)

**Trade-off:** Records created in one process instance cannot be verified in another. This is acceptable because:
1. Each DSH profile has its own state root (per `index.ts:126-146`)
2. The threat model is in-process LLM forgery, not cross-host replay
3. Fail-closed behavior on old records is the correct security posture

---

## REPLAY MODEL

### The activeVersionId Question

The replay model has two implementation choices:

**Choice A — Seal at creation time, verify with record's activeVersionId:**
```
seal = HMAC(key, candidateId|version|command|createdAt|metricsHash|record.activeVersionId)
verify: HMAC(key, fields_from_record) === stored_seal
```
Result: replay within same active context succeeds (attacker copies record, active unchanged).
Replay across active changes fails (active changed → stored activeVersionId ≠ current).

**Choice B — Seal at creation time, verify with CURRENT activeVersionId:**
```
seal = HMAC(key, candidateId|version|command|createdAt|metricsHash|creation_activeVersionId)
verify: HMAC(key, fields_from_record + CURRENT activeVersionId) === stored_seal
```
Result: any replay where active has changed fails. Even same-candidate replay with different active fails.

**Chosen model: Choice B.** The verifier reads the current active version from the store and includes it in the HMAC input at verification time. This means:
- A record created when active was v2 will fail verification if the active is now v3
- A record created and promoted against v2 can be promoted AGAIN against v2 (same active) — this is acceptable because the record's metrics were valid for that context
- Old records from previous sessions fail because the activeVersionId at creation time won't match the current pointer

**This is the correct model** because it enforces context-binding: evidence is valid only for the specific promotion context it was created in.

### When is replay valid?

| Scenario | Active at creation | Active at verification | Result |
|----------|-------------------|----------------------|--------|
| First promotion (no prior active) | n/a | null | **N/A** — first promotion has no active to compare; I6 policy applies separately |
| Same-candidate re-promotion | v2 | v2 | **Valid** — seal includes v2, verification uses current v2, match |
| Different candidate, same active | v2 | v2 | **Invalid** — candidateId differs in seal |
| Same candidate, changed active | v2 | v3 | **Invalid** — activeVersionId mismatch |
| Cross-process replay | v2 (process A) | v2 (process B) | **Invalid** — key changed (ephemeral) |

---

## I1–I6 MATRIX (Against Boot-Generated Ephemeral HMAC)

| Invariant | Verdict | Enforcing Code Path | Notes |
|-----------|---------|---------------------|-------|
| **I1 ORIGIN** | **PROVEN** | HMAC proves record was produced by process holding the key; key is in-memory random bytes | Seal input includes candidateId+version+command+createdAt — impossible to forge without key |
| **I2 METRICS** | **PROVEN** | `SHA-256(metrics)` in HMAC input | Attacker cannot modify metrics without breaking seal |
| **I3 CANDIDATE BINDING** | **PROVEN** | candidateId is first HMAC input | Cross-candidate copy fails seal check |
| **I4 BASELINE BINDING** | **PROVEN** | activeVersionId in HMAC input; verified against CURRENT store pointer | Baseline metrics tampering detectable (wrong activeVersionId in seal) |
| **I5 REPLAY** | **PROVEN** | activeVersionId read at verification time from `store.getActiveVersion()` | Cross-context replay fails; same-context replay is intentional (same evidence for same context) |
| **I6 MODE** | **PARTIAL** | Seal requires live mode + valid HMAC; BUT first-promotion bypass in `evaluatePromotionPolicy` still exists | Requires additional fix at `promote/index.ts:61` |

**I6 requires a separate change** beyond the HMAC seal:

Current code (`promote/index.ts:61`):
```typescript
if (capturedActiveMetrics && candidateLatest && candidateLatest.mode === 'simulated') {
  // reject — but skipped when capturedActiveMetrics is undefined (first promotion)
}
```

Fix: move the simulated-evidence rejection BEFORE the `capturedActiveMetrics` guard:
```typescript
// I6 fix: simulated evidence is never promotion-eligible, regardless of active baseline
if (candidateLatest && candidateLatest.mode === 'simulated') {
  return { ok: false, error: 'simulated evidence cannot promote' }
}
```

This closes the `evo_full_cycle` first-promotion bypass.

---

## FIRST-PROMOTION AUDIT

### Current Bypass Path (PROVEN)

`evaluatePromotionPolicy` at `promote/index.ts:26-105`:

```typescript
const activeBeforePromote = await store.getActiveVersion()  // line 37
// ...
if (activeBeforePromote?.modules?.length) {                // line 40
  // find active module's latest benchmark → capturedActiveMetrics
}

// Line 61 — simulated check ONLY runs when capturedActiveMetrics is defined:
if (capturedActiveMetrics && candidateLatest && candidateLatest.mode === 'simulated') {
  return { ok: false, error: '...' }
}
```

When `activeBeforePromote` is `null` (first promotion, no versions exist):
- `capturedActiveMetrics` is `undefined`
- Line 61's simulated check is **short-circuited**
- Line 68's seal check is **skipped** (condition at line 68 is false)
- Line 94's beats_active comparison is **skipped** (capturedActiveMetrics is undefined)
- Line 104 returns `{ ok: true }` — promotion proceeds

**The bypass exists in TWO paths:**
1. `evo_full_cycle` (evolution/tools.ts:332): calls `runPromotionPolicy` → `evaluatePromotionPolicy` directly, bypassing the tool-level `mode !== 'live'` check in `evo_promote` (tools.ts:40)
2. Direct `runPromotionPolicy` caller (any module that imports the function)

**Auto-experience path:** `auto-experience/index.ts:312-331` and `432-450` use `evo_promote_decision` (advisory tool) — they DO NOT call `runPromotionPolicy` directly. The `evo_promote_decision` tool (`promote/tools.ts:213-367`) checks `evidenceMode !== 'live'` at line 237 and rejects simulated evidence unless `allowSimulated: true`. However, `allowSimulated` defaults to `false` — so the advisory path is safe. But the advisory output could be used by an agent to decide to call `evo_promote` directly.

### Proposed Fix for I6

Add unconditional simulated-evidence rejection at the TOP of `evaluatePromotionPolicy`, before the `capturedActiveMetrics` block:

```typescript
// NEW: I6 enforcement — simulated evidence never promotes, even on first version
if (candidateLatest && candidateLatest.mode === 'simulated') {
  return {
    ok: false,
    error: 'promotion rejected: candidate has only simulated evidence (mode=simulated); run evo_benchmark_live or evo_benchmark_ab to produce execution evidence before promoting',
  }
}
```

This closes the bypass in both `evo_full_cycle` and any direct `runPromotionPolicy` caller.

---

## EXACT TRUST BOUNDARY

### Primary: `evaluatePromotionPolicy` in `src/host/modules/promote/index.ts:26-105`

This is the **exact function** where benchmark evidence trust is decided. Changes required:
1. Add unconditional simulated-evidence rejection (I6 fix) at line 58, before the `capturedActiveMetrics` block
2. Update seal verification to use HMAC with boot-generated key
3. Update `verifyLiveProvenance` to accept `currentActiveVersionId` as a parameter (read from `store.getActiveVersion()` at verification time, not from the record)
4. Reject all records with M3.3 self-referential seals (legacy tolerance removed when HMAC key is active)

### Secondary: `evo_promote` tool in `src/host/modules/promote/tools.ts:25-114`

Current tool-level check at lines 35-44 already rejects non-live evidence. This remains as defense-in-depth.

### Creation boundary: `createLiveProvenance` in `src/lib/provenance.ts:31-39`

Changes required:
1. Replace `createHash('sha256')` with `createHmac('sha256', key)` where key is process-memory ephemeral random bytes
2. Include `SHA-256(JSON.stringify(metrics))` in HMAC input
3. Accept `activeVersionId` as parameter (computed from `store.getActiveVersion()` at call time in benchmark tools)
4. Fix `createdAt` race: read `record.createdAt` from `addBenchmark()` return value, then compute seal with that value

### Critical bug to fix simultaneously

**`createdAt` race condition** (`benchmark/tools.ts:368-369` vs `store.ts:294`):
- The tool computes `createdAt` locally for the seal input
- The store overwrites `createdAt` with `this.nowFn()` in `addBenchmark()`
- Under M3.4, this causes every legitimate record to fail verification
- **Fix**: pass `createdAt` from the returned record back into the seal, OR have `addBenchmark` accept an optional `createdAt` field

---

## FIVE-ROLE REVIEW

### ARGUS — Trust Boundary & Key Isolation
**Scope:** Can any trust anchor be established given the filesystem layout?
**Method:** Traced filesystem boundary from state root through config to host process. Checked HostContextShape for secret-hosting capability.
**Evidence:**
- State root, config, and host process are on the SAME filesystem under the same user (home.ts:31-50, index.ts:92-197)
- `HostContextShape` (`dsh.ts:50-64`) has NO secret-hosting service; `ctx.get()` returns `undefined` for any secret key
- bubblewrap sandbox (`sandbox/index.ts:16-101`) isolates benchmark COMMAND, not the host process
- `ctx.settings.register` at `index.ts:97` creates a LIVE-WRITABLE config scope
**Finding:** Config-file key is attacker-accessible. Ephemeral in-memory key is NOT attacker-accessible (process memory boundary).
**Residual risk:** Cross-process record sharing (key changes on restart); requires operator awareness.
**Verdict:** HMAC is VIABLE with boot-generated ephemeral key. Config-file key is NOT viable.

### BADSECTOR — Metrics, Replay, Key Replacement, Legacy
**Scope:** Attack every vector that HMAC must close.
**Method:** Executed 12 attack scenarios (A-L) against the proposed M3.4 design.
**Evidence:**
- Attacks A-I are BLOCKED by HMAC (key not in attacker's writable namespace)
- Attack G (replay with different activeVersionId): BLOCKED if verifier reads current active from store; VULNERABLE if verifier reads record's activeVersionId field
- Attack J (legacy evidence): VULNERABLE if legacy tolerance path remains; MUST be fail-closed
- Attack K (key replacement): BLOCKED with ephemeral key (not on disk); VULNERABLE with config-file key
- Attack L (key influence): BLOCKED with ephemeral key; VULNERABLE with config-file key
- `createdAt` race: CRITICAL — every legitimate record fails under M3.4 unless fixed
**Finding:** Ephemeral HMAC closes all key-related vulnerabilities. Must fix createdAt race and legacy tolerance.
**Residual risk:** None, once createdAt race and legacy tolerance are addressed.
**Verdict:** VIABLE with three mandatory fixes: (1) fix createdAt race, (2) use verification-time activeVersionId, (3) fail-closed on legacy.

### ATLAS — Architectural Fit and Minimalism
**Scope:** Is HMAC the smallest viable change? Are there simpler alternatives?
**Method:** Evaluated 5 alternatives plus the boot-generated HMAC variant.
**Evidence:**
- Option 1 (metrics-only seal extension): closes 2/6 invariants — insufficient
- Option 2 (fresh execution): closes all 6 but requires sandbox at promotion time — too expensive
- Option 3 (hash chain): closes 0/6 — counterproductive
- Option 4 (operator approval): different product, not a code fix
- Option 5 (kill switch): closes 0/6 — already proven ineffective
- **Boot-generated ephemeral HMAC**: closes all 6 invariants (with I6 fix), requires 2 files changed, zero config changes, zero migration
**Finding:** Boot-generated HMAC is strictly better than config-key HMAC: stronger (unpredictable, ephemeral), simpler (no config field, no provisioning, no migration), and architecturally aligned (each process instance is an isolated trust domain).
**Residual risk:** None — cross-process verification is not a requirement in the current architecture.
**Verdict:** Boot-generated ephemeral HMAC is the MINIMAL and STRONGEST design.

### VERA — I1-I6 Invariant Mapping
**Scope:** Map each invariant against the proposed HMAC design.
**Method:** Traced each invariant through the proposed code paths.
**Evidence:**
- I1: PROVEN — HMAC proves process-origin, not just field consistency
- I2: PROVEN — metricsHash in HMAC input; impossible to inflate without key
- I3: PROVEN — candidateId in HMAC input
- I4: PROVEN — activeVersionId read at verification time from store (not from record)
- I5: PROVEN — context binding via verification-time activeVersionId
- I6: PARTIAL — seal requires live mode, but first-promotion bypass in evaluatePromotionPolicy must be fixed separately
**Finding:** I1-I5 are fully closed by the HMAC design. I6 requires one additional line of code.
**Residual risk:** First-promotion simulated bypass (documented, fixable in 2 lines).
**Verdict:** 5/6 fully proven, 1/6 partial (fixable).

### ZEKO — Terminology Audit
**Scope:** Check whether terms match the actual guarantees.
**Method:** Cross-checked each term against the proposed HMAC mechanism.
**Evidence:**
- "Provenance seal" → for HMAC: accurate (provenance IS authenticated origin)
- "Integrity" → for HMAC: accurate (data hasn't been altered since signing)
- "Tamper detection" → for HMAC: accurate (any modification breaks the HMAC)
- "Authenticated" → for HMAC: accurate (origin is verified via key)
- "Host-held key" → for ephemeral key: accurate (key lives in host process memory)
- "Secure" → for ephemeral HMAC: accurate (attacker cannot access process memory)
**Finding:** Terminology becomes accurate with HMAC. M3.3 terminology was misleading; M3.4 terminology is correct.
**Residual risk:** None — terminology matches the mechanism.
**Verdict:** TERMINOLOGY CLEAN for M3.4.

---

## RESIDUAL RISKS

1. **Cross-process replay (design choice, not vulnerability):** Records signed with key from process A cannot be verified in process B. This is intentional — it prevents cross-host forgery but requires re-benchmarking after host restart. The operator should be aware.

2. **First-promotion simulated bypass (fixable in 2 lines):** `evaluatePromotionPolicy` at `promote/index.ts:61` short-circuits the simulated-evidence check when `capturedActiveMetrics` is undefined. Fix: move the check before the `capturedActiveMetrics` guard.

3. **`createdAt` race (must fix):** `benchmark/tools.ts:368` computes `createdAt` for the seal, but `store.addBenchmark()` at `store.ts:294` overwrites it. Every legitimate record fails verification. Fix: pass the stored `createdAt` back into the seal computation.

4. **Legacy tolerance (must remove):** The backward-compatibility path at `promote/index.ts:73-77` (skip seal check when both sides are unsealed) creates an attack surface for pre-HMAC records. Must be replaced with fail-closed: all live records require valid HMAC.

5. **Process memory compromise:** If the attacker can read process memory (e.g., via a sandbox escape or debugger), the HMAC key is compromised. This is an extreme threat model not addressed by any cryptographic mechanism. Document as out-of-scope.

---

## OPEN ASSUMPTIONS

1. **In-process threat model:** The attacker is assumed to have write access to the state root directory and the ability to invoke tools within the same DSH session. The attacker does NOT have OS-level process memory access. If the threat model changes to include process compromise, no in-memory key can help.

2. **Single-process promotion:** Each DSH profile runs one process instance. Cross-process record verification is not required. If multi-process sharing is needed in the future, a persistent key (TPM/HSM) would be required.

3. **Operator awareness of restart behavior:** After a host restart, all existing benchmark records become unverifiable. The operator must re-run live benchmarks to produce new HMAC-signed records. This is a policy decision, not a code defect.

---

## DECISION

**HMAC IS READY FOR IMPLEMENTATION** with the following conditions:

1. **Use boot-generated ephemeral HMAC key** — NOT config-file key. Key is `crypto.randomBytes(32)` in process memory at boot. This is the only configuration that places the key outside the attacker's write scope.

2. **Three mandatory fixes before M3.4 ships:**
   - Fix `createdAt` race: pass store-generated `createdAt` back into seal computation
   - Use verification-time `activeVersionId`: read current active version from store at verification time, not from the record
   - Fail-closed on legacy: remove the backward-compatibility carve-out; all live records require valid HMAC

3. **One additional fix for I6:** Move the simulated-evidence rejection in `evaluatePromotionPolicy` before the `capturedActiveMetrics` guard.

4. **Legacy data policy:** All pre-HMAC records are rejected at the promotion boundary. The operator must re-run `evo_benchmark_live` or `evo_benchmark_ab` for any candidate they want to promote. No migration grace period.

5. **Terminology update:** Replace "provenance seal" with "authentication tag" in docs and error messages to distinguish from the self-referential M3.3 mechanism.

---

## IMPLEMENTATION CONTRACT

### Trust Anchor
- **Source:** `crypto.randomBytes(32)` generated at boot in `src/host/index.ts`
- **Storage:** Process memory only (module-level variable, reset on each boot)
- **Lifetime:** Single process lifecycle; invalid after restart

### Key Boundary
- **Who can read:** Plugin host process only (in-memory)
- **Who can write:** Plugin host process only (generated at boot)
- **Attacker access:** Impossible without process memory compromise

### Authenticated Payload
```
HMAC-SHA256(key, candidateId + "|" + version + "|" + command + "|" + createdAt + "|" + metricsHash + "|" + activeVersionIdAtCreationTime)
```
Where:
- `metricsHash = SHA-256(JSON.stringify(metrics))`
- `activeVersionIdAtCreationTime` = the active version ID read from `store.getActiveVersion()` at benchmark creation time
- `createdAt` = the TIMESTAMP stored IN THE RECORD (returned by `addBenchmark`), NOT the tool's local `new Date()`

### Evidence Lifecycle
1. **Creation:** `evo_benchmark_live` or `evo_benchmark_ab` reads current active version, computes metricsHash, calls `store.addBenchmark()`, reads back `record.createdAt`, computes HMAC with `record.createdAt` and `activeVersionId` from step 1
2. **Persistence:** HMAC stored in `BenchmarkRun.provenance` field alongside the JSON record
3. **Verification:** `verifyLiveProvenance(record, currentActiveVersionId)` recomputes HMAC from record fields + current active version ID and compares
4. **Promotion:** `evaluatePromotionPolicy` calls `verifyLiveProvenance(candidateLatest, currentActiveVersion.id)`; rejects if false

### Replay Rule
- A record is VALID if and only if:
  1. Its HMAC matches (computed with current active version ID at verification time)
  2. Its `mode === 'live'`
  3. Its `candidateId` matches the candidate being evaluated
- A record is INVALID (replayed) if:
  1. The active version has changed since the record was created (verification-time activeVersionId ≠ creation-time activeVersionId)
  2. The record's HMAC does not match its fields (tampered)
  3. The record's mode is 'simulated'

### First-Promotion Rule
- Simulated evidence is ALWAYS rejected, regardless of whether an active baseline exists
- First promotion requires a live benchmark record with valid HMAC
- No special case for first-ever version

### Promotion Trust Boundary
- **Exact function:** `evaluatePromotionPolicy` in `src/host/modules/promote/index.ts:26-105`
- **Change:** Add simulated-evidence rejection at line 58 (before capturedActiveMetrics block); update seal verification to HMAC

### Legacy Data Rule
- Pre-HMAC records (M3.3 self-referential seals) are REJECTED at the promotion boundary
- The backward-compatibility carve-out (`index.ts:73-77`) is REMOVED
- Operator must re-run benchmarks to produce HMAC-signed records

### Fail-Closed Conditions
- HMAC key not loaded (process not started) → all live evidence rejected
- Legacy seal present (M3.3 SHA-256) → rejected, no grace period
- Missing provenance on live record → rejected
- HMAC mismatch → rejected

### Regression Tests
| Test | Attack | Expected Result |
|------|--------|-----------------|
| T1 | Recomputed seal with changed candidateId | REJECT |
| T2 | Metrics tampering only | REJECT |
| T3 | Metrics + command + recomputed seal | REJECT |
| T4 | Candidate rebinding with recomputed seal | REJECT |
| T5 | Baseline rebinding (piggyback) | REJECT (beats_active catches, but seal also blocks) |
| T6 | Replay old evidence against new active | REJECT |
| T7 | Simulated→live flip without HMAC | REJECT (tool path) + REJECT (policy path) |
| T8 | Legitimate live evidence with valid HMAC | ACCEPT |
| T9 | Forgery with wrong key | REJECT |
| T10 | Legacy M3.3 record after upgrade | REJECT |
| T11 | Replay with changed activeVersionId | REJECT |
| T12 | First promotion with simulated evidence | REJECT (I6 fix) |
| T13 | First promotion with live HMAC evidence | ACCEPT |

### Migration
- One-time operation: operator runs `evo_benchmark_live` or `evo_benchmark_ab` for each candidate they want to promote
- No automated migration — legacy records are intentionally rejected
- Documentation must state: "After M3.4 upgrade, all existing benchmark records must be re-executed"
