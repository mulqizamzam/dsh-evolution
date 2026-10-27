# Evolution Quality and Red Team Gates

This document describes six opt-in diagnostics added to dsh-evolution. They are intentionally additive: the first release does not silently change the existing promotion policy.

## 1. Evidence-based Evolution Score

Tool: `evo_evidence_score`

Computes an explainable 0–100 score from directly linked experience outcomes, supporting patterns, and the candidate's latest benchmark. The score is informational only and is not a substitute for the promotion policy or live execution evidence.

## 2. Shadow Evaluation and Canary Readiness

Tool: `evo_shadow_evaluate`

Compares the latest live benchmark for a candidate with the latest live benchmark for the active version. It checks minimum run count, success-rate non-regression, error-rate tolerance, and latency tolerance. It reports canary-entry readiness but does not split or redirect production traffic; the current DSH activation API mounts one active version and does not expose traffic weights.

## 3. Evolution Memory Lifecycle

Tool: `evo_memory_lifecycle`

Audits duplicate experience signatures and old low-confidence patterns. It is read-only by default. Setting `applyRetention=true` explicitly runs the already-configured record-count and retention-day pruning policy. Duplicate records and patterns are reported, not deleted.

## 4. Adversarial Benchmark Suite

Tool: `evo_adversarial_benchmark`

Runs deterministic static checks against candidate files and tests for path traversal, dynamic code execution, possible embedded credentials, shell execution, network access, environment access, and filesystem mutation. This is a heuristic static review; it does not execute candidate code and can produce false positives. Use sandboxed live benchmarks for behavioral evidence.

## 5. Evolution Integrity Red Team

Tool: `evo_integrity_redteam`

Audits benchmark candidate binding, live provenance seals, metric bounds, timestamps, run counts, duplicate ids, and unknown evidence modes. The current provenance seal covers candidate id, version, command, and timestamp but not the metrics payload. A clean report is not proof of an uncompromised host or store.

## 6. Blast-Radius and Recovery Drill

Tool: `evo_recovery_drill`

Validates a previous version's artifact and runs its recorded test command inside the configured sandbox with network disabled. It never changes the active version. It does not prove that a host-level rollback operation will succeed; it checks artifact integrity and test readiness without performing a destructive drill.

## Safety boundaries

- Diagnostics do not promote, activate, or rollback a version.
- Static checks and reports do not replace sandbox execution.
- No diagnostic result should be interpreted as a cryptographic guarantee unless the underlying evidence explicitly provides one.
- Canary readiness is a gate report, not traffic-splitting capability.
- Memory pruning is the only mutating operation in this set and requires an explicit `applyRetention=true` argument.
