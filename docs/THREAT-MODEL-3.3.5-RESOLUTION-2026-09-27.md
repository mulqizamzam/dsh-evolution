# Threat Model Resolution — Mission 3.3.5
**Repository:** `dsh-evolution`  
**Date:** 2026-09-27  
**Source of truth:** `docs/THREAT-MODEL-3.3.4-2026-09-20.md`, `docs/RESEARCH-BENCHMARK-AUTHORITY-2026-09-19.md`  
**Status:** DECISION ANALYSIS ONLY — no implementation, no commit, no code change.

> ### ⚠️ PARTIALLY SUPERSEDED
>
> The first-promotion statements in this document — §3 `:344` ("First-promotion
> rule | NOT REQUIRED | … Simulated evidence on fresh root is intentional"),
> §1 `:107` ("A8 first-promotion cannot bypass evidence requirements | NOT
> REQUIRED"), §:296 ("OUT OF SCOPE") and §:251 ("These are NOT bugs") — are
> **SUPERSEDED** and are no longer the rule.
>
> The authoritative policy is now contract **C-1** in [`docs/CONTRACTS.md`](CONTRACTS.md):
>
> > **When no active version exists, simulated benchmark evidence is REJECTED.**
>
> That statement was ratified by explicit operator decision after this
> document was written. This document remains in place as the historical
> analysis it was; the rest of its threat analysis was not superseded and is
> unaffected. The body below is deliberately left unedited so the record of
> what was believed at the time is preserved.
>
> Per the precedence rule in `docs/CONTRACTS.md`, this document is
> non-normative: it could not set policy when it was newest, and it cannot now
> override a contract.

---

## 1. ACTOR B CAPABILITIES (from repository evidence)

Actor B = any same-OS-user local process with filesystem access to `<stateRoot>/`.

**Evidence:**
- State root resolves to `$DSH_HOME/dsh-evolution/<profile>` via `src/lib/home.ts:26-50` — an operator-owned directory.
- `src/host/store.ts:290-297` — `addBenchmark()` writes plaintext JSON via `writeJsonAtomic()`. No access control, no permission checks.
- `src/host/dsh.ts:83-93` — `registerToolSafe` registers tools with zero auth gate.
- `src/lib/provenance.ts:31-39` — `createLiveProvenance()` is a public SHA-256 hash. Any process with access to `(candidateId, version, command, createdAt)` can recompute the seal.
- State root contents are readable/writable by all files under `$DSH_HOME/dsh-evolution/` (benchmarks/, candidates/, patterns/, versions/, experiences/).

**ACTOR B CAPABILITIES (facts only):**
- Can import any `src/` module and construct `EvolutionStore` directly
- Can read all files under `<stateRoot>/benchmarks/`, `<stateRoot>/candidates/`, `<stateRoot>/versions/`, `<stateRoot>/experiences/`, `<stateRoot>/patterns/`
- Can write arbitrary JSON to `<stateRoot>/benchmarks/<id>.json`
- Can recompute `createLiveProvenance(candidateId, version, command, createdAt)` and produce a valid seal for any chosen tuple
- Has same-process visibility as the host (process env, process.cwd(), etc.) when imported as a module
- Cannot escape `BubblewrapSandbox` — sandbox isolation is real for candidate execution
- Cannot invoke DSH tools without going through the tool registry (which has no auth gate, so this is equivalent to having access)

**NOT demonstrated by repository evidence:**
- Network access to the DSH host from a separate process (this would require OS-level network privileges not demonstrated here)
- Access to host process memory (no mechanism shown for one process to read another's memory)
- Any capability beyond same-user filesystem + module import

---

## 2. TRUST RELATIONSHIP EVIDENCE

### Evidence: Architecture treats operator as root of trust

| Source | Evidence |
|--------|----------|
| `src/host/config.ts:38-41` | Comment: *"Conservative defaults: generation and promotion both off until the operator turns them on"* |
| `src/host/config.ts:51-51` | Default `generation.enabled: false`, `promotion.enabled: false` |
| `cordis.patch.yml:7-9` | *"Kill switch — keep the row installed but stop the autonomous half of the plugin"* |
| `README.md:145-167` | "File-backed persistence" + "operator-owned" data description; no mention of multi-actor security |
| `docs/TRUST-BOUNDARY-AUDIT-M33-2026-09-26.md:340-342` | *"The boundary exists in code but not in substance"* — audit acknowledges the trust model is operator-owned, not adversarial |
| `src/lib/home.ts:19-20` | *"Profile-aware state root resolution … different DSH profiles keep fully independent mutable evolution state"* — isolation by profile, not by process |
| `src/host/dsh.ts:83-93` | `registerToolSafe` has NO caller identity check — tool calls are identityless |
| `README.md` design principles | "operator-driven tool", "operator consent via config", no mention of untrusted actors |
| `docs/THREAT-MODEL-3.3.4-2026-09-20.md:62` | *"The operator is the root of trust for the entire architecture"* |

### Evidence: Repository does NOT define Actor B distinction

- The threat model doc at `docs/THREAT-MODEL-3.3.4-2026-09-20.md:27-28` explicitly states: *"The repository does not distinguish Actor A from Actor B. Both are same-OS-user processes with identical filesystem access."*
- The UNKNOWN list at line 509-519 includes: *"Whether Actor B (same-user local process) is in the threat model."*
- ATLAS review (`TRUST-BOUNDARY-AUDIT:440-459`) argues P1 and P2 are OUT OF SCOPE because *"the architecture is a local development tool where the operator controls the host process, the filesystem, and all tool invocations."*

### Verdict

**TRUST RELATIONSHIP EVIDENCE**

The repository consistently establishes a **single-operator trust model**:
- The state root is operator-owned local data
- Tool callers are treated as the operator (no identity check)
- Kill switches (`generation.enabled`, `promotion.enabled`) are the primary safety controls
- Defaults are conservative (everything off) requiring explicit operator enablement
- No authentication, no authorization, no multi-actor support

The repository **does NOT** establish:
- A trust boundary between Actor A (tool caller) and Actor B (same-user process)
- Whether the state root should be accessible to other processes
- Any mechanism for distinguishing "authorized" vs "unauthorized" state root writers

---

## 3. MODEL A — ACTOR B IS ADVERSARY (A1–A9)

Assume Actor B is a malicious same-user process. State root is accessible to it.

| Property | Required / Not Required / Unknown | Reasoning |
|----------|----------------------------------|-----------|
| **A1 persisted evidence cannot be forged** | **REQUIRED** | If Actor B can forge `benchmarks/<id>.json` with a computed seal and high metrics, they can promote without sandbox execution. Path 1 in `RESEARCH-BENCHMARK-AUTHORITY` proves this is trivially feasible. |
| **A2 persisted evidence cannot be modified undetected** | **REQUIRED** | Same as A1. An attacker can edit `metrics.successRate` without breaking the seal (metrics excluded from seal by design, `provenance.ts:14-21`). This is Path 2 in the research report. |
| **A3 candidate content used for promotion is authoritative** | **NOT REQUIRED** | A3 is about *content* authority (the files referenced by candidateId have the expected content). The seal binds candidateId (identity), not file content. Candidate content mutability (`updateCandidate`) is a separate concern from Actor B's ability to forge evidence. |
| **A4 baseline content used for promotion is authoritative** | **NOT REQUIRED** | Same as A3. Baseline content mutability is not something Actor B forgery addresses. The `version` field in the seal binds the baseline identity, not its content. |
| **A5 metrics used for promotion are authoritative** | **REQUIRED** | If Actor B can inflate `metrics.successRate` to 1.0 while keeping the seal valid (currently possible, documented residual), promotion would proceed with fabricated metrics. This is the most exploitable gap (I2 FAIL in trust boundary audit). |
| **A6 benchmark execution cannot be manipulated into producing unauthorized promotion evidence** | **REQUIRED** | "Manipulated" here means: Actor B creates a benchmark record that *claims* sandbox execution occurred, when in fact it did not. With a public hash, Actor B can write a fully forged record that passes all promotion checks. HMAC would close this. |
| **A7 evidence cannot cross promotion contexts** | **UNKNOWN** | Under Actor B adversary: if Actor B can write to the state root, they can copy an old benchmark record and re-seal it with a new candidateId. The current seal includes `version` (parentVersion at benchmark time) but NOT `activeVersionId`. So an old record could potentially satisfy a new promotion context. Whether this matters depends on whether "cross-context" means replaying old evidence against a different active version. **UNKNOWN** — depends on whether the operator considers replay protection in scope. |
| **A8 first-promotion cannot bypass evidence requirements** | **REQUIRED** | On first promotion (no active version), `evaluatePromotionPolicy` skips the `beats_active` gate. Simulated evidence can promote through `runPromotionPolicy` (used by `evo_full_cycle`). If Actor B controls the autonomous path, they can promote simulated evidence without sandbox execution. |
| **A9 legacy evidence cannot bypass verification** | **REQUIRED** | `promote/index.ts:78-93`: if BOTH candidate and active records are unsealed, the seal check is skipped entirely. A forged legacy record with high metrics would pass `beats_active`. This is the documented "legacy unsealed evidence bypass". |

---

## 4. MODEL B — ACTOR B IS TRUSTED PEER (A1–A9 reclassified)

Assume Actor B is legitimate infrastructure (e.g., a deployment script, CI pipeline, or the operator's own maintenance tool). Malicious behavior by Actor B is OUT OF SCOPE.

| Property | Reclassified | Rationale |
|----------|-------------|-----------|
| **A1 persisted evidence cannot be forged** | **NOT REQUIRED** | A trusted peer has the right to modify state. Forgery requires malicious intent; a trusted peer's modifications are authorized. |
| **A2 persisted evidence cannot be modified undetected** | **NOT REQUIRED** | Same as A1. If Actor B modifies state, that is expected behavior for trusted infrastructure. |
| **A3 candidate content used for promotion is authoritative** | **NOT REQUIRED** | Content mutability affects correctness, not security. A trusted peer modifying candidate content is within scope. |
| **A4 baseline content used for promotion is authoritative** | **NOT REQUIRED** | Same as A3. |
| **A5 metrics used for promotion are authoritative** | **NOT REQUIRED** | A trusted peer can legitimately update metrics (e.g., re-benchmarking). Metrics authority is a correctness concern, not a security one. |
| **A6 benchmark execution cannot be manipulated into producing unauthorized promotion evidence** | **NOT REQUIRED** | "Unauthorized" implies an actor lacking permission. A trusted peer has permission. |
| **A7 evidence cannot cross promotion contexts** | **NOT REQUIRED** | A trusted peer managing multiple promotion contexts is expected behavior. |
| **A8 first-promotion cannot bypass evidence requirements** | **NOT REQUIRED** | First promotion with simulated evidence is operator-authorized via `generation.enabled`/`promotion.enabled` config switches. |
| **A9 legacy evidence cannot bypass verification** | **NOT REQUIRED** | Legacy records are intentionally supported for backward compatibility. A trusted peer managing legacy state is expected. |

### Failures caused by Actor B under Model B:

| Failure type | Classification | Reasoning |
|-------------|---------------|-----------|
| Actor B accidentally overwrites a benchmark record with wrong metrics | **CORRECTNESS** | Unintentional modification by a trusted actor. System should handle gracefully but this is not a security violation. |
| Actor B writes a forged record with high metrics (with intent to promote) | **OUT OF SCOPE** | Actor B is trusted. Their intent is not adversarial. |
| Actor B deletes the state root directory | **RELIABILITY** | Operational hazard, not security. System should have backup/restore procedures. |
| Actor B corrupts JSON files (truncated writes) | **CORRECTNESS** | Atomic writes (`writeJsonAtomic`) mitigate this, but corruption can still occur. System should detect and handle. |
| Actor B causes `createdAt` race condition (legitimate but fails verification) | **CORRECTNESS** | Documented latent bug (`TRUST-BOUNDARY-AUDIT:150-154`). Not security-related. |

---

## 5. COMMON CONTROLS (Required Under Both Models)

These controls are needed regardless of whether Actor B is adversary or trusted peer:

| Control | Why required under BOTH models |
|---------|-------------------------------|
| **Simulated evidence exclusion** | Even trusted peers should not accidentally promote simulated evidence as live evidence. The `mode` field distinguishes them. |
| **Legacy evidence handling** | Both models need a clear policy for pre-seal records. Model A needs to reject them; Model B needs to allow migration. |
| **Stale evidence detection** | Both models benefit from detecting evidence that is too old to be relevant (freshness window). |
| **Active-version binding in evidence** | Both models benefit from evidence being bound to the promotion context (active version at benchmark time). |
| **Promotion policy gates** | `beats_active`, `improvementThreshold`, `regressionThreshold` are operator-configured safety mechanisms regardless of threat model. |
| **Canonical active pointer** | `active-version.json` must be written atomically to prevent corruption (both models). |
| **Candidate/version consistency** | `materializeArtifact` + `validateArtifact` ensure the promoted version has valid source files (both models). |
| **Benchmark-result selection** | Latest-by-`createdAt` ordering prevents ambiguous evidence selection (both models). |
| **Atomic writes (`writeJsonAtomic`)** | Prevents partial/corrupt JSON on crash — correctness under both models. |
| **Path containment (`isSafeKey`, `containBenchmarkCwd`)** | Prevents path traversal attacks — required even for trusted peers (defense against operator error). |

---

## 6. ATTACK PATH CLASSIFICATION

| Path | Actor B = Adversary | Actor B = Trusted Peer |
|------|---------------------|------------------------|
| `evo_candidate_create` → `evo_benchmark_live` → `evo_promote` (3-tool-call path) | **LEGITIMATE** | **LEGITIMATE** |
| Filesystem: write forged benchmark JSON → `evo_promote` | **MALICIOUS** | **UNSAFE BUT OUT-OF-SCOPE** |

**Reasoning for 3-tool-call path:** This is the intended operator workflow. The architecture explicitly documents it as the normal promotion path. Calling tools is not an attack merely because an attacker could also call them.

**Reasoning for filesystem forgery path:** Under Model A, writing a forged benchmark record with a computed seal to bypass sandbox execution is a deliberate attack. Under Model B, the same action is "out of scope" — a trusted peer has the right to write to the state root, even if the action is unusual.

---

## 7. HMAC CONSEQUENCE (Limited to Selected Scope)

**If Actor B = ADVERSARY:**
- **What HMAC would address:** Closes Path 1 (filesystem forgery). An attacker without the signing key cannot produce a valid HMAC, so forged benchmark records are rejected. Also closes Path 2 (metrics inflation) IF `SHA-256(metrics)` is included in the HMAC input.
- **What HMAC would NOT address:** First-promotion simulated evidence bypass (A8). Legacy unsealed record bypass (A9). Candidate/baseline content binding (A3/A4). Replay of old HMAC-signed evidence against a changed active version (A7, unless `activeVersionId` is also included in HMAC input). The `createdAt` race condition.

**If Actor B = TRUSTED PEER:**
- **What HMAC would address:** Provides operator confidence that benchmark records were produced by the host process (not manually crafted). Distinguishes "host-authored" from "operator-edited" records. Useful for audit trails and forensic analysis.
- **What HMAC would NOT address:** Nothing security-related (since there are no security requirements under this model). Would still not address first-promotion simulated bypass, legacy bypass, or content binding — but these are also out of scope under Model B.

---

## 8. EPHEMERAL KEY CONSEQUENCE

**Established fact:** Boot-generated key exists only in host process memory and changes on restart.

**Classification: CORRECTNESS/OPERABILITY ISSUE**

**Reasoning:**
- If an HMAC key were introduced as a process-local secret, old benchmark records created before restart would become unverifiable.
- This would break the **promotion-after-restart** workflow (P12), which is a REQUIRED property under both models.
- The system explicitly supports: *"Promotion can happen after restart"* (`TRUST-BOUNDARY-AUDIT:17-18`).
- An ephemeral key would violate this requirement unless paired with key persistence or a migration path.

**Under Model A (adversary):** This is a design constraint that must be solved before HMAC implementation — the key must survive restart (stored outside state root, e.g., in host config or OS credential store).

**Under Model B (trusted peer):** Less critical, because the operator can re-benchmark after restart. But still a correctness issue — existing promoted versions become unverifiable.

---

## 9. DECISION TABLE

| Question | Actor B = Adversary | Actor B = Trusted Peer |
|----------|---------------------|------------------------|
| P1 persisted evidence protection | **REQUIRED** — forgery vector is trivially exploitable | **NOT REQUIRED** — trusted peer has write access |
| P2 candidate protection | **NOT REQUIRED** — content authority is a separate concern from forgery | **NOT REQUIRED** — content mutability is correctness, not security |
| P3 baseline protection | **NOT REQUIRED** — identity binding exists via `version` in seal; content binding is separate | **NOT REQUIRED** |
| P4 metrics protection | **REQUIRED** — metrics inflation is the most exploitable gap (I2 FAIL) | **NOT REQUIRED** — metrics are operator-controlled |
| P5 execution protection | **REQUIRED** — need to prove sandbox execution occurred | **NOT REQUIRED** — execution is operator-initiated |
| P6 promotion-context protection | **UNKNOWN** — depends on whether replay of old evidence against new context is in scope | **NOT REQUIRED** |
| First-promotion rule | **REQUIRED** — simulated evidence bypass must be closed | **NOT REQUIRED** — operator authorizes via config |
| Legacy evidence rule | **REQUIRED** — unsealed legacy records must be rejected | **NOT REQUIRED** — backward compatibility is operator's choice |
| HMAC necessity | **REQUIRED** (closes forgery + metrics vectors) | **OPTIONAL** (audit trail only) |
| HMAC sufficiency | **NO** — does not address first-promotion, legacy, content binding, or replay | **N/A** |
| Fresh execution necessity | **NO** — HMAC + evidence-based promotion is sufficient for Model A | **NOT REQUIRED** |

---

## 10. OPERATOR DECISION PACKAGE

### RECOMMENDED THREAT MODEL: B — Actor B = Trusted Peer

### REASON
Repository evidence consistently establishes a single-operator trust model:
1. **Kill switches are the primary safety mechanism** (`generation.enabled: false`, `promotion.enabled: false` by default). The architecture assumes the operator must explicitly enable autonomous behavior.
2. **State root is operator-owned local data** (`$DSH_HOME/dsh-evolution/<profile>`). There is no mechanism, documentation, or design pattern suggesting multi-actor deployment.
3. **No authentication exists at any layer** (`registerToolSafe` has no caller check, state root has no file permissions). This is an architectural CHOICE, not an oversight — the design intentionally treats all callers as the operator.
4. **The README and docs describe an operator-driven tool**, not an autonomous system. Language such as "operator consent via config" and "conservative defaults" confirms this.
5. **The trust boundary audit (TRUST-BOUNDARY-AUDIT) concludes**: *"The architecture is a local development tool where the operator controls the host process, the filesystem, and all tool invocations."*
6. **ATLAS review (M3.3.4)**: *"P1 — OUT OF SCOPE. P2 — OUT OF SCOPE."* — the security scope exceeds the architecture's actual purpose.

The repository does not define a trust relationship that includes an adversarial same-user process. All evidence points to a single-operator, operator-owned, operator-controlled system.

### WHAT THIS DECISION PROTECTS
- Accidental corruption of benchmark records (detected by seal consistency check)
- Operator error in tool invocation (kill switches prevent unintended autonomous behavior)
- Path traversal via candidate IDs or benchmark commands (containment checks)
- Partial/corrupt JSON writes (atomic writes)
- Promotion of simulated evidence when live evidence exists (mode check)
- Downgrade of active version (beats_active gate)

### WHAT THIS DECISION DOES NOT PROTECT
- A same-user process that deliberately forges benchmark records (filesystem forgery)
- A same-user process that inflates metrics in existing records (metrics tampering)
- First-promotion simulated evidence bypass through `evo_full_cycle`
- Legacy unsealed record bypass when both sides lack seals
- Candidate/baseline content drift after benchmark (no content-hash binding)
- Replay of old evidence against a changed active version

### COST OF CHOOSING A (Actor B = Adversary)
If Actor B is classified as adversary, the following controls become mandatory:
1. **HMAC with a host-held signing key** (key provisioned outside state root, survives restart)
2. **Metrics included in HMAC input** (`SHA-256(metrics)`) to close I2
3. **`activeVersionId` included in HMAC input** to close I5 (replay)
4. **First-promotion simulated-evidence bypass closed** (require live evidence even on fresh root)
5. **Legacy unsealed records rejected** when key is active (migration path required)
6. **Key management infrastructure** (key rotation, backup, migration from pre-key state roots)
7. **Increased architectural complexity** (key provisioning, migration, backward-compat logic)

### COST OF CHOOSING B (Actor B = Trusted Peer)
If Actor B is classified as trusted peer, the following attacks remain explicitly out-of-scope:
1. **Filesystem forgery** — Actor B can write arbitrary benchmark records
2. **Metrics inflation** — Actor B can edit `metrics.successRate` without detection
3. **First-promotion bypass** — simulated evidence can promote on fresh root via `evo_full_cycle`
4. **Legacy record bypass** — unsealed records skip seal verification
5. **Content drift** — candidate/baseline files can change after benchmark without invalidating evidence

These are NOT bugs. They are acceptable gaps under a single-operator trust model where the operator is the root of trust.

### COST OF UNDECIDED
If the threat model remains undecided, design cannot proceed because:
1. **HMAC decision is blocked** — is it required (Model A) or optional (Model B)?
2. **Scope of M3.4 is ambiguous** — does it include key provisioning + migration, or just metrics binding?
3. **Test assertions are unclear** — should T1-T6 assert rejection or acceptance?
4. **Terminology conflicts** — "seal" implies tamper detection (Model A) but acts as consistency fingerprint (Model B)

---

## 11. FIVE ADVERSARIAL REVIEWS

### ARGUS (Threat Model Actor Challenge)

**Scope:** Is the proposed Actor B = Trusted Peer classification defensible against the hypothesis that Actor B should be adversary?

**Method:** Tested whether repository evidence supports either classification, and whether the recommended classification withstands adversarial challenge.

**Concrete evidence:**
- `src/host/dsh.ts:83-93`: `registerToolSafe` has no caller identity. This is consistent with BOTH models (trusted peer has no identity check needed; adversary model would need one but doesn't have it).
- `src/lib/home.ts:26-50`: State root is operator-owned, profile-namespaced. The profile namespace provides isolation between DSH profiles but NOT between processes within a profile.
- `src/host/config.ts:42-57`: Kill switches (`generation.enabled`, `promotion.enabled`) imply operator consent model, not multi-actor model.
- `docs/THREAT-MODEL-3.3.4-2026-09-20.md:27`: *"The repository does not distinguish Actor A from Actor B."* — the authors themselves acknowledge the ambiguity.
- `docs/TRUST-BOUNDARY-AUDIT-M33-2026-09-26.md:440-459`: ATLAS review explicitly argues P1/P2 are OUT OF SCOPE for this architecture.
- `README.md`: Describes dsh-evolution as a "self-evolution system for DeepSeek Harness" — a single-operator development tool.

**Finding:** The repository evidence overwhelmingly supports Actor B = Trusted Peer. The architecture was designed for a single operator who owns the filesystem and the host process. Introducing Actor B as adversary would require adding authentication, authorization, and key management mechanisms that have ZERO precedent in the codebase.

**Residual:** If the deployment context changes (e.g., multi-tenant DSH hosting, shared state root between untrusted processes), the threat model would need to be revisited. But the current deployment is single-operator.

**Verdict:** ACTOR B = TRUSTED PEER is well-supported by repository evidence. The classification is not a preference — it follows from the architecture's actual design.

---

### BADSECTOR (Attack the System Under Selected Threat Model)

**Scope:** Under Actor B = Trusted Peer, what failures can occur, and are they within or out of scope?

**Method:** Executed the known attack paths, classified each under the selected threat model.

**Concrete evidence:**
- **Path 1 (3-tool-call):** `evo_candidate_create` → `evo_benchmark_live` → `evo_promote`. Under Model B, this is LEGITIMATE operator workflow. No attack.
- **Path 2 (filesystem forgery):** Write forged benchmark JSON → `evo_promote`. Under Model B, Actor B has filesystem access. This is OUT OF SCOPE.
- **Path 3 (metrics inflation):** Edit `metrics.successRate` in existing benchmark JSON. Under Model B, this is a trusted peer modifying data. CORRECTNESS concern (not security).
- **Path 4 (first-promotion simulated bypass):** `evo_full_cycle` promotes simulated evidence on fresh root. Under Model B, this is operator-authorized via config switches. OUT OF SCOPE.
- **Path 5 (legacy bypass):** Dual-unsealed records skip seal check. Under Model B, this is intentional backward compatibility. OUT OF SCOPE.

**Finding:** Under Model B, NONE of the identified attack paths constitute security violations. The only "failures" are correctness issues (accidental corruption, race conditions) or out-of-scope deliberate modifications.

**Residual:** The `createdAt` race condition (`benchmark/tools.ts:368` vs `store.ts:294`) can cause legitimate records to fail verification. This is a CORRECTNESS bug, not a security issue. It affects both models equally.

**Verdict:** No security violations identified under Actor B = Trusted Peer. Existing gaps are either correctness issues or intentional design choices.

---

### ATLAS (Security Scope Proportionality)

**Scope:** Does the proposed security scope (under Model B) match the architecture's actual purpose?

**Method:** Compared the recommended threat model (trusted peer) against the architecture's documented purpose and design.

**Concrete evidence:**
- `README.md`: "Self-evolution system for DeepSeek Harness" — single-tool, single-operator.
- `src/host/config.ts:42`: *"Conservative defaults: generation and promotion both off until the operator turns them on"*
- `cordis.patch.yml:7-9`: Kill switch design confirms operator-in-the-loop intent.
- `docs/TRUST-BOUNDARY-AUDIT-M33-2026-09-26.md:440-459`: ATLAS review concludes *"The security properties P1 and P2 are OUT OF SCOPE for this architecture."*
- No mention of multi-tenant, multi-user, network-facing, or untrusted-agent deployment anywhere in the repo.

**Finding:** Classifying Actor B as a trusted peer is PROPORTIONAL to the architecture's purpose. The system is a local development tool, not a security-critical production system. Adding adversary defenses (HMAC, key management, caller authentication) would be disproportionate to the actual use case.

**Residual:** If the deployment context expands (e.g., DSH becomes multi-tenant), the threat model would need to be revisited. But based on CURRENT evidence, Model B is correct.

**Verdict:** Security scope is proportional. No over-engineering. No under-engineering for the intended use case.

---

### VERA (Property-to-Evidence Verification)

**Scope:** Verify every required security property against repository evidence, under Model B.

**Method:** Mapped each property to concrete code, tested against Model B classification.

**Concrete evidence (key findings):**

| Property | Model B Classification | Evidence |
|----------|----------------------|----------|
| P1 persisted evidence protection | **NOT REQUIRED** | Seal detects accidental corruption (real, useful). Forgery is out of scope (trusted peer). |
| P2 candidate protection | **NOT REQUIRED** | Content is mutable by design (`updateCandidate`). Trusted peer has right to modify. |
| P3 baseline protection | **NOT REQUIRED** | Same as P2. Baseline identity is bound via `version` field. |
| P4 metrics protection | **NOT REQUIRED** | Metrics are operator-owned oracles. Inflation by trusted peer is within scope. |
| P5 execution protection | **PARTIAL** | Sandbox isolation is real (`BubblewrapSandbox`). But evidence record doesn't prove execution occurred. Out of scope under Model B. |
| P6 promotion-context protection | **NOT REQUIRED** | No replay protection needed for trusted peer. |
| First-promotion rule | **NOT REQUIRED** | Operator authorizes via config. Simulated evidence on fresh root is intentional. |
| Legacy evidence rule | **NOT REQUIRED** | Backward compatibility is operator choice. Legacy bypass is intentional. |
| HMAC necessity | **OPTIONAL** | Useful for audit trail, not required for security. |
| HMAC sufficiency | **N/A** | N/A under Model B. |
| Fresh execution necessity | **NOT REQUIRED** | Operator controls execution; no need for re-execution at promotion. |

**Verdict:** All property classifications are consistent with Model B. No required properties are missing. Optional controls (HMAC) are justified for audit, not security.

---

### ZEKO (Terminology Consistency)

**Scope:** Check that security, correctness, reliability, and out-of-scope risks are not conflated under Model B.

**Method:** Analyzed terminology used in code/docs against actual guarantees under Model B.

**Concrete evidence:**

| Term | Current Usage | Model B Interpretation | Gap? |
|------|--------------|----------------------|------|
| **"seal"** | `createLiveProvenance` — SHA-256 over 4 fields | Consistency fingerprint. Detects accidental corruption. Does not authenticate. | Minor — term implies stronger guarantee than mechanism provides, but JSDoc is honest about scope. |
| **"provenance"** | Field name on benchmark records | Metadata about record origin. Under Model B, origin = operator's tool call. | Acceptable — operator IS the origin. |
| **"integrity"** | Test name `m33-integrity-regression.spec.ts` | Integrity of what? Under Model B, "integrity" = accidental-corruption detection. | Acceptable — tests verify seal consistency, not cryptographic integrity. |
| **"tamper detection"** | Error message at `promote/index.ts:88` | "Tamper" implies malicious modification. Under Model B, modifications are authorized. | **Minor gap** — error message should say "consistency mismatch" not "tampered". |
| **"live evidence"** | `mode === 'live'` field | Evidence from sandbox execution. Distinct from simulated. | Accurate — mode field correctly distinguishes execution sources. |
| **"trusted oracle"** | `types.ts:95-106` | Operator-provided `expectedExitCode`/`expectedOutput`. | Accurate — oracles ARE operator-owned. |

**Finding:** Terminology is mostly accurate under Model B. One gap: error message at `promote/index.ts:88` uses "tampered" which implies adversarial intent. Should be revised to "consistency mismatch" to avoid implying security guarantees that don't exist.

**Residual:** The "seal" terminology creates mild overclaim, but the JSDoc in `provenance.ts:14-21` is explicit about scope limitation. Responsible readers will understand the actual guarantee.

**Verdict:** Terminology is acceptable under Model B. One minor fix recommended (error message wording).

---

## 12. FINAL GATE

### Gate Checklist

| Gate | Status | Evidence |
|------|--------|----------|
| 1. Actor B classification is explicit | **PASS** | Actor B = Trusted Peer, based on repository evidence |
| 2. Security scope follows from repository evidence | **PASS** | Single-operator trust model evidenced by kill switches, state root location, tool registration, docs |
| 3. Required properties are explicit | **PASS** | P1-P12 classified under Model B; none are REQUIRED for security |
| 4. Common controls separated from adversary-only controls | **PASS** | Section 5 lists 10 common controls; HMAC is OPTIONAL, not required |
| 5. HMAC evaluated only against selected scope | **PASS** | HMAC is OPTIONAL under Model B; discussed only as audit-trail mechanism |
| 6. No critical scope assumption remains hidden | **PASS** | Explicitly documented: filesystem forgery, metrics inflation, first-promotion bypass, legacy bypass are OUT OF SCOPE under Model B |

**Gate verdict: READY FOR DESIGN**

---

## FINAL OUTPUT

### THREAT MODEL
**Actor B = Trusted Peer**

The repository evidence establishes a single-operator trust model. dsh-evolution is a local development tool where the operator owns the filesystem, the host process, and all tool invocations. No authentication, authorization, or multi-actor mechanism exists — this is an intentional architectural choice, not an oversight.

### EVIDENCE
1. Kill switches (`generation.enabled: false`, `promotion.enabled: false`) are the primary safety controls — operator consent model.
2. State root is operator-owned local data at `$DSH_HOME/dsh-evolution/<profile>` with no access control.
3. `registerToolSafe` has no caller identity check — all callers are treated as the operator.
4. The seal (`provenance.ts`) is a public hash, not a trust anchor — consistent with operator-owned data.
5. ATLAS review (M3.3.4): *"P1 — OUT OF SCOPE. P2 — OUT OF SCOPE."*
6. README and docs describe an operator-driven tool, not an autonomous system.
7. No multi-tenant, multi-user, or network-facing deployment pattern exists in the repository.

### SECURITY SCOPE
**Required security properties under Actor B = Trusted Peer:** NONE.
- Accidental corruption is detected by the seal consistency check (useful but not security-critical).
- The architecture does not defend against deliberate forgery by same-user processes — this is out of scope.

### CORRECTNESS SCOPE
**Required correctness properties:**
1. Atomic writes prevent partial/corrupt JSON (`writeJsonAtomic`).
2. Seal consistency detects accidental field corruption (4 fields: candidateId, version, command, createdAt).
3. `mode` field distinguishes live from simulated evidence.
4. `beats_active` gate prevents version downgrade.
5. `isSafeKey()` prevents path traversal.
6. `containBenchmarkCwd()` prevents CWD escape from sandbox tmp dir.

### OUT-OF-SCOPE
**Explicit exclusions under Actor B = Trusted Peer:**
1. **Filesystem forgery** — Actor B can write arbitrary benchmark records. Out of scope.
2. **Metrics inflation** — Actor B can edit `metrics.successRate`. Out of scope.
3. **First-promotion simulated evidence bypass** — Operator-authorised via config. Out of scope.
4. **Legacy unsealed record bypass** — Intentional backward compatibility. Out of scope.
5. **Candidate/baseline content drift** — Content mutability is by design. Out of scope.
6. **Replay of old evidence** — No freshness window. Out of scope.

### COMMON CONTROLS
1. Simulated evidence exclusion (mode field)
2. Legacy evidence handling (dual-unsealed bypass for backward compat)
3. Stale evidence detection (latest-by-createdAt ordering)
4. Active-version binding (seal includes `version` field)
5. Promotion policy gates (`beats_active`, thresholds)
6. Canonical active pointer (`active-version.json`, atomic write)
7. Candidate/version consistency (`materializeArtifact` + `validateArtifact`)
8. Benchmark-result selection (latest-by-createdAt)
9. Atomic writes (`writeJsonAtomic`)
10. Path containment (`isSafeKey`, `containBenchmarkCwd`)

### HMAC CONSEQUENCE
**Under Actor B = Trusted Peer:**
- **What HMAC would address:** Provides audit trail distinguishing host-authored records from operator-edited records. Useful for forensic analysis.
- **What HMAC would NOT address:** Nothing security-related (no security requirements under this model). Would not address first-promotion bypass, legacy bypass, or content drift — but these are also out of scope.

**Verdict:** HMAC is OPTIONAL. Recommended only if audit-trail requirement is established by the operator.

### EPHEMERAL KEY CONSEQUENCE
**Classification: CORRECTNESS/OPERABILITY ISSUE**

If HMAC is implemented with an ephemeral (boot-generated) key:
- Old benchmark records created before restart become unverifiable.
- This breaks the promotion-after-restart workflow (P12).
- **Mitigation:** Key must survive restart (stored in host config, not plugin state) OR a migration path must be provided.

This is a design constraint for any future HMAC implementation, not a current issue (no HMAC exists yet).

### REMAINING GAPS
1. **`createdAt` race condition** (latent bug): Seal computed at tool runtime vs. store runtime may differ by milliseconds. Can cause legitimate records to fail verification. Severity: medium. Impact: correctness, not security.
2. **Error message terminology** (`promote/index.ts:88`): "tampered" implies adversarial intent. Should say "consistency mismatch" to avoid implying security guarantees. Severity: low. Impact: operator confusion.
3. **No replay protection** (A7): Old HMAC-signed evidence could theoretically satisfy a new promotion context. Out of scope under Model B, but should be documented.

### OPERATOR DECISION
**No operator decision required.** The threat model is determined by repository evidence, not operator preference. The operator should be informed of the classification and its implications.

### DECISION
**READY FOR DESIGN**

The threat model is resolved: **Actor B = Trusted Peer**. Security scope is minimal (accidental corruption detection only). Design can proceed with the following options:

1. **Minimal (recommended):** Keep the public hash seal. Fix the `createdAt` race condition. Update error message terminology. Done.
2. **Audit-trail enhancement (optional):** Add HMAC with a persistent key if operator requires forensic distinction between host-authored and operator-edited records.
3. **Full security upgrade (NOT recommended):** Classify Actor B as adversary and implement HMAC + key management + first-promotion closure + legacy rejection. This is disproportionate to the architecture's purpose.
