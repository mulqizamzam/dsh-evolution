# dsh-evolution

Self-evolution system for DeepSeek Harness. Collects task experiences, detects patterns, generates improvement candidates, benchmarks them against baselines, and manages versioned promotion with rollback.

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │         Evolution Controller          │
                    │    (evo_status, evo_run_cycle)        │
                    └──────────┬──────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                     │
   ┌──────▼──────┐    ┌───────▼───────┐    ┌───────▼───────┐
   │  Experience  │    │    Pattern    │    │   Candidate   │
   │  Collector   │───▶│    Analyzer   │───▶│    Builder    │
   │ 3 tools      │    │ 2 tools       │    │ 3 tools       │
   └──────────────┘    └───────────────┘    └───────┬───────┘
                                                     │
                                            ┌────────▼────────┐
                                            │    Benchmark    │
                                            │     Runner      │
                                            │ 4 tools         │
                                            └────────┬────────┘
                                                     │
                                            ┌────────▼────────┐
                                            │  Promotion Mgr  │
                                            │ (promote/       │
                                            │  rollback/list) │
                                            │ 4 tools         │
                                            └─────────────────┘

Beyond this core loop: sandbox execution, the LLM candidate builder, automatic
turn observation, and boot-time activation of the promoted version.

Storage: File-backed JSON in $DSH_HOME/dsh-evolution/
  ├── experiences/    (append-only experience records)
  ├── patterns/       (detected behavioral patterns)
  ├── candidates/     (improvement candidates)
  ├── benchmarks/     (benchmark run results)
  ├── versions/       (immutable version history)
  └── tmp/
```

## Installation

Add to your DSH profile's `package.json`:

```json
{
  "dependencies": {
    "dsh-evolution": "link:/path/to/dsh-evolution"
  }
}
```

Add to `cordis.patch.yml`:

```yaml
- insert:
    id: dsh-evolution
    config:
      stateRoot: ''
      inject: { enabled: true }
      experience:
        maxRecords: 10000
        retentionDays: 90
      candidate:
        maxActive: 10
      benchmark:
        minRuns: 3
        maxRuns: 10
        improvementThreshold: 0.05
        regressionThreshold: 0.10
```

## Tools

| Tool | Description |
|------|-------------|
| `evo_experience_record` | Record a completed task execution |
| `evo_experience_list` | List recent experiences |
| `evo_experience_inspect` | Get full details of one experience |
| `evo_auto_record` | Record a task out-of-band (the host records turns automatically) |
| `evo_observe_state` | Automatic observation state: turns observed, loop guard counters, thresholds |
| `evo_analyze_patterns` | Detect recurring patterns from experiences |
| `evo_analyze_report` | Summary report of all stored patterns |
| `evo_candidate_create` | Create a new improvement candidate |
| `evo_candidate_list` | List candidates with optional status filter |
| `evo_candidate_inspect` | Get full details of one candidate |
| `evo_builder_generate` | Use the configured host LLM to generate a candidate module (source, tests, manifest, benchmark cases); files are safety-validated before acceptance |
| `evo_benchmark_run` | Benchmark a candidate against thresholds |
| `evo_benchmark_compare` | Compare benchmark metrics to thresholds |
| `evo_benchmark_live` | Execute a command in a live sandbox against a candidate's files (stdout, stderr, exit code, timing) |
| `evo_benchmark_ab` | A/B benchmark a candidate against its baseline over multiple sandboxed runs |
| `evo_promote` | Promote a benchmarked candidate to new version |
| `evo_rollback` | Rollback to a previous version |
| `evo_promote_list` | List all versions |
| `evo_promote_decision` | Apply the promotion policy to the latest benchmark evidence; returns promote/reject with the justifying metrics |
| `evo_status` | Show evolution status overview |
| `evo_run_cycle` | Run one analysis/candidate generation cycle |
| `evo_full_cycle` | Run the complete autonomous cycle (analyze, generate, validate, sandbox, benchmark, promote/reject); requires an LLM endpoint |
| `evo_sandbox_exec` | Execute a shell command in a sandbox — requires bubblewrap (bwrap); the call is refused when it is unavailable |
| `evo_activation_status` | Report which version artifact is mounted, which tool it registered, and why activation did not happen |
| `evo_activation_refresh` | Re-read the active version and mount or unmount its artifact |
| `evo_health` | Plugin health check |

## Example Evolution Run

### v1: Initial Baseline

```
1. Record experiences:
   evo_experience_record(success=true, prompt="fix login bug", score=0.9, stepCount=3)
   evo_experience_record(success=false, prompt="deploy service", errors=["timeout"])
   evo_experience_record(success=false, prompt="deploy service", errors=["timeout"])
   evo_experience_record(success=false, prompt="deploy service", errors=["timeout"])

2. Analyze patterns:
   evo_analyze_patterns(minOccurrences=3)
   → Detected: "Recurring signature observed 3 times: timeout" (confidence: 0.55)

3. Create candidate:
   evo_candidate_create(type="retry-strategy", name="Deploy retry policy",
     description="Add retry with backoff for deploy timeouts",
     reason="3 deploy timeouts observed", parentVersion="v1")

4. Benchmark:
   evo_benchmark_run(candidateId="abc123")
   → Passed: all metrics within thresholds

5. Promote:
   evo_promote(candidateId="abc123", reason="Benchmark passed")
   → Created v2, v1 marked rolled-back
```

### Rollback

```
evo_rollback(versionId="v1")
→ v1 restored to active, v2 marked rolled-back
```

## Data Flow

```
Completed Task
    │
    ▼
Experience Record ──▶ experiences/*.json
    │
    ▼
Pattern Analyzer ──▶ patterns/*.json
    │                (FACT / INFERENCE / HYPOTHESIS)
    ▼
Candidate Builder ──▶ candidates/*.json
    │
    ▼
Benchmark Runner ──▶ benchmarks/*.json
    │
    ▼
Promotion Manager ──▶ versions/*.json (immutable)
    │
    ▼
New Active Version ──▶ Previous version preserved for rollback
```

## Design Principles

- **Immutable versions**: Once created, version records are never modified
- **Append-only experience store**: Old records are never overwritten
- **Evidence-based evolution**: Every pattern must cite experience IDs
- **Threshold-gated promotion**: Candidates must pass benchmarks before promotion
- **Rollback-safe**: Any version can be restored without data loss
- **File-backed persistence**: No database dependency, human-readable JSON
- **No automatic fine-tuning**: Agent generates module code, not model weights

## Testing

```bash
npm test
```

151 tests across 14 files covering lib utilities, store operations, tool definitions, and end-to-end evolution cycles.

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `experience.maxRecords` | 10000 | Maximum stored experiences — **declared but not enforced**: nothing reads this key yet, so `experiences/` grows one file per recorded turn |
| `experience.retentionDays` | 90 | Days before experience cleanup — **declared but not enforced**, see `maxRecords` |
| `candidate.maxActive` | 10 | Maximum draft candidates |
| `benchmark.minRuns` | 3 | Minimum benchmark runs |
| `benchmark.maxRuns` | 10 | Maximum benchmark runs |
| `benchmark.improvementThreshold` | 0.05 | Required improvement for promotion |
| `benchmark.regressionThreshold` | 0.10 | Allowed regression before rejection |
