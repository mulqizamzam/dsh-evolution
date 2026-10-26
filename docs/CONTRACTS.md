# Repository Contracts

**Status:** AUTHORITATIVE — TRACKED
**Ratified by:** operator (human), by explicit decision
**Location:** `docs/CONTRACTS.md`

## What this file is

This file is the single authoritative source for ratified *behavioural contracts* in
this repository — rules that say what the system **must** do, as opposed to
analysis, audit findings, threat models, or research notes that describe what
someone *believes* the system does.

A contract entry here is binding on implementation, tests, and documentation
alike.

## Precedence

This section exists because the repository previously had **no** rule for
resolving conflicts between its own documents. Audit reports, threat-model
resolutions, and decision notes disagreed with each other and with committed
tests, and nothing said which one won. The following order is now binding:

1. **This file (`docs/CONTRACTS.md`)** — a ratified contract wins over everything
   below it.
2. **Tracked tests and tracked source comments** — they must conform to this file.
   Where a test asserts behaviour that this file contradicts, the test is wrong
   and must be updated. Tests do **not** create policy.
3. **Implementation behaviour** — never defines policy on its own. The code is
   the thing that conforms; it is not evidence of what the policy is.
4. **Analysis documents** (`docs/*.md` audits, threat models, research notes,
   decision notes) — **non-normative**. These record reasoning. They may be
   thorough, recent, emphatic, and even be marked "DECISION"; none of that
   confers authority. A statement here can only become policy by being
   ratified into this file.
5. **Untracked documents** — historical record only. Not part of the repository
   contract in any sense.

Recency does not confer authority. A document written yesterday does not
override one written last month, and a document marked "DECISION" or
"NOT READY" is still just a document.

## Change control

This file may only be changed by an explicit operator decision recorded as a
commit. An agent may not add, weaken, reinterpret, or delete a contract entry
on its own initiative, and may not infer a policy from existing behaviour,
test assertions, or document dates. If the correct policy is not recorded
here, it is **undetermined** — the correct action is to report that, not to
invent one.

---

## C-1 — First-promotion evidence

**Ratified:** operator decision, mission "RATIFY FIRST-PROMOTION EVIDENCE
CONTRACT". Supersedes the disputed/unresolved first-promotion rules previously
scattered across `docs/TRUST-ANCHOR-DECISION-GATE-M33-2026-09-26.md` and
`docs/THREAT-MODEL-3.3.5-RESOLUTION-2026-09-27.md`, neither of which was
ratified.

### The rule

> **When no active version exists, simulated benchmark evidence is REJECTED.**
> A candidate whose most recent benchmark record has `mode === 'simulated'`
> must not be promoted, whether or not an active version exists. This is not a
> special case for the first version — it is a special case for the *absence
> of an active baseline*, which is exactly the situation in which a
> simulated record would otherwise become the trust anchor.

### Rationale

The first promoted version becomes the baseline against which every later
`beats_active` comparison is measured. If that baseline is installed from
evidence that was never executed, the entire comparative-authority chain rests
on an unverified foundation, and there is no later promotion that can
re-establish it. Rejecting simulated evidence at first promotion is therefore
the same decision as rejecting it at every later promotion, applied
consistently.

### Enforced by

`evaluatePromotionPolicy` in `src/host/modules/promote/index.ts`, which is the
single policy authority for every promotion path:

- `evo_promote` (`src/host/modules/promote/tools.ts`) — already rejected
  simulated evidence at the tool layer before this contract existed; the
  contract makes the policy layer agree with the tool layer rather than the
  reverse.
- `evo_full_cycle` (`src/host/modules/evolution/tools.ts`) — routes through
  `runPromotionPolicy` and must surface the rejection as
  `verdict: 'REJECTED'` without creating a version.

### Consequence that is explicitly accepted

A fresh state root that has only ever produced simulated benchmarks **cannot
bootstrap**. There is no promotion path to a first active version until live
evidence exists. This is a deliberate consequence of the rule, not a defect to
be worked around. Making progress from that state requires running
`evo_benchmark_live` or `evo_benchmark_ab`.

### What this contract does NOT change

Everything below is explicitly out of scope and was not touched:

- Benchmark modes and their recording (`mode` is still `'simulated' | 'live' |
  'manifest'`, still optional, still never defaulted).
- Provenance sealing and verification, including the pre-seal backward-compat
  carve-out for state roots created before M3.3.
- The canonical `active-version.json` pointer, its `generation` CAS, and
  `checkPointerUnchanged`.
- Rollback semantics.
- Cumulative composition of promoted versions.
- **M1 comparative authority**: the `beats_active` gate, including its
  "skipped when there is no comparable active baseline" behaviour and the
  tie-equals-reject monotonicity rule. Under C-1, a first promotion with *live*
  evidence still has no baseline to beat and therefore still skips that gate —
  C-1 governs *evidence mode*, not the *comparative* gate.
- Mission C behaviour.
- Autonomous promotion gating (`evolution.promotion.enabled`).

### Explicitly not decided by this contract

C-1 speaks only to records whose `mode` is the literal string `'simulated'`.
It does **not** decide, and this contract must not be read as deciding:

- Promotion of a candidate that has **no benchmark record at all**.
- Promotion of a candidate whose `mode` is absent or an unrecognised value.

Both remain undetermined and behave as they did before ratification.

### Verification status — M4 and M4-LIVE closed

Recorded on operator instruction ("close M4/M4-LIVE with an explicit
residual"). This subsection adds **no new rule and changes no behaviour**; it
records what was mechanically proven and what was not.

**Closed and proven.** The `evo_full_cycle` STEP 6 → STEP 7 → C-1 chain is
locked end to end by `test/m4-live-fallback-c1-integration.spec.ts`, which
drives the real `evo_full_cycle` tool against a real store. When the live
benchmark returns `ok:false`, the STEP 7 fallback to `evo_benchmark_run`
writes a `mode:'simulated'` record that **passes** every configured threshold,
so the cycle cannot short-circuit at `'benchmark did not pass'`; the rejection
is then produced by the C-1 gate itself, leaving no version record, no active
pointer, and no active version, before or after a simulated restart.

This is genuine new coverage, not a duplicate. Every pre-existing C-1 test
(`m4-first-promotion-contract.spec.ts`, `promotion-unified.spec.ts`,
`m33-evidence-trust-boundary.spec.ts`) injects its simulated record directly
via `store.addBenchmark` and never runs `evo_full_cycle`; all of them would
still pass if the STEP 7 fallback were deleted outright.

The suite was shown load-bearing by neutering the C-1 gate in
`evaluatePromotionPolicy` (`if (false && …)`), which makes it fail with
`expected true to be false` — the promotion succeeds without the gate. The
production file was restored byte-exact afterwards (sha256 verified).

**Residual (explicit).** The natural, unforced end-to-end occurrence of this
chain has never been observed on a host with bubblewrap. The suite forces the
`ok:false` by stubbing `evo_benchmark_live`, so it proves the *wiring* and the
rejection authority, **not** the natural trigger. `/usr/bin/bwrap` is present
on the verification host, so the `'sandbox not available'` path cannot be
reproduced there.

Bubblewrap is **not** the only reason the natural path is unobserved, and this
residual must not be read as though it were. On a bwrap-equipped host the
fallback is the *normal* outcome for at least:

- `evo_benchmark_live` returning `ok:false` with `'candidate has no files to
  execute'` (`src/host/modules/benchmark/tools.ts:301`), reached whenever the
  LLM returns a well-formed manifest with `benchmarkCases` but an empty
  `files`/`tests` array. `validateCandidateFileSet`
  (`src/host/modules/builder/tools.ts:198-208`) treats that as **warnings
  only**, and `valid` is `errors.length === 0`.
- A throw from `writeCandidateFiles` when an LLM-supplied file path escapes
  containment (`benchmark/tools.ts:142`); `evolution/tools.ts:254-256` swallows
  the throw, and a null `benchResult` satisfies the same fallback condition.
- `mkdtemp`/write failures, or the STEP 6 `AbortSignal.timeout(120_000)`
  expiring.

**Historical status note, clarified by contract C-2 below.** Earlier audit
notes classified the absence of an `evolution.promotion.enabled` check in
`evo_promote` and `evo_rollback` as a gap in the operator stop. The operator
has now explicitly chosen a narrower meaning for that setting: it gates
automatic promotion in `evo_full_cycle` and the autonomous loop, not explicit
`evo_promote` tool calls or the recovery path `evo_rollback`. This is an
intentional policy distinction, not a global emergency-stop guarantee.

**Also undecided, unchanged by the above.** The `'manifest'` and absent-`mode`
gap is real at the policy layer: `evaluatePromotionPolicy` tests only the
literal string `'simulated'`. It is unreachable from both production callers
today (`evo_promote` blocks it at `tools.ts:41`; `evo_full_cycle` can only
write `'live'` or `'simulated'`), but it rests solely on a tool-layer check.


---

## C-2 — Scope of the autonomous promotion switch

**Ratified:** explicit operator instruction on 2026-10-27 to define
`evolution.promotion.enabled` as an automatic-promotion control while keeping
the explicit promotion and rollback tool paths available. Recorded in the
commit that adds this contract.

### The rule

- When `evolution.promotion.enabled === false`, automatic promotion performed
  inside `evo_full_cycle` and the autonomous loop must remain blocked.
- The setting does **not** block an explicit invocation of `evo_promote`.
  That path remains subject to candidate-state checks, live-evidence
  requirements, `evaluatePromotionPolicy`, artifact validation, and activation
  pre-flight.
- The setting does **not** block `evo_rollback`. Rollback is an explicit
  recovery operation and remains available when automatic promotion is off.
- The setting is **not** a global emergency stop and does not unregister the
  `evo_*` tools.

### Security boundary

An explicit `evo_promote` tool call is an available manual control path; it is
not proof of authenticated human identity. The current tool registry does not
authenticate or distinguish a human operator from another caller. Deployments
that need a hard stop against all callers must disable or remove tool access at
the host/plugin boundary rather than rely on this setting.

### Verification intent

Tests must establish that automatic promotion remains blocked when the setting
is false, that a valid explicit `evo_promote` call can still pass the normal
promotion gates, and that `evo_rollback` remains available. This contract does
not weaken evidence, comparative-promotion, artifact-validation, or sandbox
requirements.



---

## C-3 — Red Team Promotion Gate

**Ratified:** explicit operator instruction on 2026-10-27 to implement a
runtime Red Team gate whose only promotable verdict is PASS, together with
adversarial regression tests.

### The rule

Every candidate promotion path must pass the shared runtime Red Team gate
before artifact pre-flight, version creation, or activation mutation. The gate
returns one of **PASS**, **FAIL**, or **INCONCLUSIVE**, with per-check reasons
and the benchmark record ID when available.

- **PASS** is the only verdict that may proceed to the existing promotion
  policy and activation pre-flight.
- **FAIL** blocks promotion when evidence is explicitly simulated or failed,
  provenance is invalid, the record attestation mismatches, or metrics/run
  metadata are malformed or out of range.
- **INCONCLUSIVE** also blocks promotion when evidence is absent, non-live,
  unrecognised, legacy/unattested, or cannot be verified. Missing information
  is not treated as a passing result.
- The manual `evo_promote` path, autonomous `evo_full_cycle` path, and
  advisory `evo_promote_decision` must all use or report this same gate.
  `evo_promote_decision` must not recommend promotion when the gate is not
  PASS.
- A benchmark must also bind to the candidate's immutable `parentVersion`:
  the benchmark's `version` and any supplied `parentVersion` must match that
  creation-time parent, preventing cross-version evidence replay.
- The gate does not replace the existing comparative `beats_active` policy,
  artifact validation, activation pre-flight, or sandbox controls. Those gates
  still run after a PASS.

### Evidence integrity

`EvolutionStore.addBenchmark` generates an integrity attestation over the
complete persisted benchmark record, including metrics, outcome, execution
metadata, thresholds, provenance, and captured case results. Promotion verifies
the attestation and the existing live provenance seal. The store, not the
calling tool, derives the attestation.

This deliberately supersedes the earlier C-1 section's undecided treatment of
missing/unrecognised benchmark modes and its pre-seal compatibility allowance
for *candidate promotion evidence*: records without an attestation are now
INCONCLUSIVE and must be re-benchmarked through a current supported live path.
C-1 still independently rejects simulated evidence, including first promotion.
This contract does not require an active baseline when none exists and does not
change the current `beats_active` rule for absent comparable baselines.

### Scope and residual limitation

The attestation is an **unkeyed SHA-256 integrity digest**, not a digital
signature or proof of sandbox execution. It detects partial/persisted record
changes when the digest is not recomputed, including metric-only changes that
the older provenance seal does not cover. It cannot authenticate against an
attacker who can rewrite the record and recompute the digest, or compromise the
running host/code. The host/plugin boundary and state-root access controls
remain the trust boundary for that stronger threat model.

C-3 does not change C-2: `evolution.promotion.enabled` still gates automatic
promotion only; explicit `evo_promote` and recovery through `evo_rollback`
remain available. This gate applies to promotion of a new candidate, not to
rollback/recovery.
