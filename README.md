# dsh-evolution

**Evidence-driven self-evolution for DeepSeek Harness (DSH).**

dsh-evolution turns completed task experiences into traceable improvement candidates, evaluates them against benchmarks, and manages versioned promotion and rollback. Patterns link back to evidence, generated candidates are validated, and versioned artifacts support recovery.

> **Safety defaults:** automatic experience recording and the evolution trigger are enabled by default. LLM-based candidate generation and autonomous promotion are disabled by default and should be enabled deliberately.

## How it works

```text
Completed tasks
      │
      ▼
Experience store ──► Pattern analysis ──► Candidate generation
                                               │
                                               ▼
                                      Validation & sandbox
                                               │
                                               ▼
                                         Benchmark gate
                                               │
                                     ┌─────────┴─────────┐
                                     ▼                   ▼
                                  Promote              Reject
                                     │
                                     ▼
                              Versioned activation
                                     │
                              Rollback when needed
```

1. **Capture experience.** Store task outcomes and relevant execution metadata as JSON records.
2. **Find recurring patterns.** Analyze records for repeated signals and retain links to supporting evidence.
3. **Build a candidate.** Create an improvement candidate; when enabled, the configured host LLM can generate module files, tests, a manifest, and benchmark cases.
4. **Validate and evaluate.** Validate candidate files and run benchmark checks. Sandbox execution is available where the host supports it.
5. **Manage versions.** Promotion is gated by configuration and benchmark evidence. Version artifacts can be activated at startup, and a previous version can be restored.

## Key capabilities

- **Evidence-linked analysis** — patterns can be traced to the experience records that support them.
- **Candidate lifecycle management** — create, inspect, and list proposed changes.
- **Benchmarking** — run threshold-based checks, compare results, and perform live or A/B benchmark runs.
- **Red Team promotion gate** — every new candidate promotion requires PASS from a fail-closed evidence-integrity gate; missing or unverifiable evidence blocks promotion with per-check reasons.
- **Controlled promotion** — autonomous promotion is disabled by default and depends on benchmark evidence.
- **Version history and rollback** — versioned artifacts support recovery to a prior version.
- **Sandboxed execution** — the dedicated sandbox tool requires Bubblewrap (`bwrap`) and refuses execution when it is unavailable.
- **File-backed persistence** — human-readable JSON records; no separate database service is required.
- **Runtime visibility** — inspect plugin status, health, observation state, and activation status.

dsh-evolution generates and evaluates **module code**; it does not fine-tune or update model weights.

## Requirements

The requirements below come from the package manifest and the runtime features used by the plugin.

- **DeepSeek Harness (DSH):** a version that satisfies the declared `engines.dsh` range, `>=0.1.1-rc.1`.
- **Node.js:** version **20 or newer**, as declared by `engines.node` in `package.json`.
- **DSH plugin-management command:** installation is performed through `dsh plugin`, which delegates package operations to the package manager configured by the DSH installation.
- **Host LLM configuration (optional):** needed for LLM-backed candidate generation and the full autonomous cycle; it is not needed just to install the bundle or use the experience, analysis, status, and other non-generation tools.
- **Bubblewrap (`bwrap`, optional):** required for isolated shell execution through `evo_sandbox_exec`. Sandbox-dependent candidate validation/benchmark paths also need the sandbox runtime to be available.

## Installation

`dsh-evolution` is an installable **DSH bundle package**: `package.json` declares `dsh.bundle.patch`, and the package ships `lib/` plus `cordis.patch.yml`. Install it with the DSH plugin command so DSH can register it in the selected profile's bundle list. Do not manually copy the bundle's `insert` block into the profile for a normal installation.

### Option A — install from GitHub

Run this from a terminal where the `dsh` command is available. Replace `web` with the profile you want to use.

```bash
dsh plugin --profile web add github:mulqizamzam/dsh-evolution#main
```

The command installs the repository as a package. Because the package declares a DSH bundle patch, DSH registers `dsh-evolution` in that profile's `dsh.profile.bundles` list.

Verify that the bundle layer is present in the effective configuration:

```bash
dsh --profile web --dump-config
```

Look for the `dsh-evolution` layer. Restart the profile or DSH process if it was already running when you installed the bundle.

### Option B — install a local checkout (development)

Use this when you want to work from a clone of this repository. Run the commands from the repository root:

```bash
git clone https://github.com/mulqizamzam/dsh-evolution.git
cd dsh-evolution
npm ci
npm run build
dsh plugin --profile web add .
```

Replace `web` with your target profile. `npm ci` installs the dependencies recorded in `package-lock.json`; `npm run build` refreshes the generated files under `lib/` from the TypeScript source before linking the checkout into the profile.

Verify the resulting layer:

```bash
dsh --profile web --dump-config
```

### Configuration overrides

The package's own `cordis.patch.yml` supplies the shipped defaults. Add overrides in the selected profile's `cordis.patch.yml` only when you need to change those defaults. DSH applies the profile patch after bundle layers.

For example, this top-level row override disables automatic evolution while leaving the manually callable `evo_*` tools installed:

```yaml
- id: dsh-evolution
  config:
    evolution:
      enabled: false
      autoRecord: false
      autoTrigger: false
      analysis:
        minExperiences: 20
        minOccurrences: 5
      generation:
        enabled: false
      promotion:
        enabled: false
      maxCyclesPerProcess: 3
```

The row override replaces that row's entire `config` object; restate any non-default configuration you need to preserve. To uninstall the bundle and unregister its tools, use the DSH plugin manager rather than leaving the dependency installed:

```bash
dsh plugin --profile web remove dsh-evolution
```

## Configuration

The defaults below reflect the plugin's declared configuration. Generation and promotion deliberately default to `false`.

| Option | Default | Purpose |
|---|---:|---|
| `stateRoot` | `""` | Optional explicit state directory. When empty, the plugin resolves the root using the host and environment configuration. |
| `inject.enabled` | `true` | Injection setting exposed by the plugin configuration. |
| `evolution.enabled` | `true` | Master switch for the autonomous evolution loop. |
| `evolution.autoRecord` | `true` | Record completed turns automatically. |
| `evolution.autoTrigger` | `true` | Allow automatic evolution-cycle triggers. |
| `evolution.analysis.minExperiences` | `20` | Completed experiences required before analysis can run. |
| `evolution.analysis.minOccurrences` | `5` | Occurrences required for a signature to count as recurring. |
| `evolution.generation.enabled` | `false` | Permit LLM-backed candidate generation. |
| `evolution.promotion.enabled` | `false` | Gate automatic promotion in the full-cycle/autonomous path. Explicit `evo_promote` and recovery via `evo_rollback` remain available; this is not a global emergency stop or caller-authentication control. |
| `evolution.maxCyclesPerProcess` | `3` | Per-process cap for autonomous cycles. |
| `experience.maxRecords` | `10000` | Declared experience-retention limit. **Not currently enforced.** |
| `experience.retentionDays` | `90` | Declared retention period. **Not currently enforced.** |
| `candidate.maxActive` | `10` | Declared limit for active draft candidates. |
| `benchmark.minRuns` | `3` | Configured minimum number of benchmark runs. |
| `benchmark.maxRuns` | `10` | Configured maximum number of benchmark runs. |
| `benchmark.improvementThreshold` | `0.05` | Configured improvement threshold. |
| `benchmark.regressionThreshold` | `0.10` | Configured regression threshold. |

The experience limits are currently configuration declarations, not enforced storage policies. Experience records can therefore continue to accumulate. Plan for disk usage accordingly.

### Disabling automatic evolution

To stop automatic recording and autonomous triggers, override the bundle's row configuration with the required fields restated. The `evo_*` tools remain registered and can still be invoked manually when `evolution.enabled` is false. To remove those tools as well, remove the bundle from the DSH profile.

```yaml
- id: dsh-evolution
  config:
    evolution:
      enabled: false
      autoRecord: false
      autoTrigger: false
      analysis:
        minExperiences: 20
        minOccurrences: 5
      generation:
        enabled: false
      promotion:
        enabled: false
      maxCyclesPerProcess: 3
```

## Tool reference

Tools are grouped by task rather than listed as one long catalog.

### Experience and observation

| Tool | Purpose |
|---|---|
| `evo_experience_record` | Record a completed task execution. |
| `evo_experience_list` | List recent experience records. |
| `evo_experience_inspect` | Inspect a specific experience record. |
| `evo_auto_record` | Record an experience explicitly outside the automatic observer. |
| `evo_observe_state` | Inspect automatic observation counters and loop-guard state. |

### Analysis and candidates

| Tool | Purpose |
|---|---|
| `evo_analyze_patterns` | Detect recurring patterns in stored experiences. |
| `evo_analyze_report` | Summarize detected patterns. |
| `evo_candidate_create` | Create an improvement candidate. |
| `evo_candidate_list` | List candidates, optionally filtered by status. |
| `evo_candidate_inspect` | Inspect a candidate. |
| `evo_builder_generate` | Generate candidate module files using the configured host LLM; generated files are validated before acceptance. |

### Benchmarks and promotion

| Tool | Purpose |
|---|---|
| `evo_benchmark_run` | Run a candidate benchmark against configured checks. |
| `evo_benchmark_compare` | Compare benchmark metrics against thresholds. |
| `evo_benchmark_live` | Run a command in a live sandbox and return output, exit code, and timing. |
| `evo_benchmark_ab` | Compare a candidate with its baseline across multiple sandboxed runs. |
| `evo_promote_decision` | Evaluate the latest benchmark evidence against the promotion policy. |
| `evo_promote` | Promote an eligible, benchmarked candidate to a new version. |
| `evo_promote_list` | List version history. |
| `evo_rollback` | Restore a previous version. |

### Runtime and diagnostics

| Tool | Purpose |
|---|---|
| `evo_status` | Show an evolution status overview. |
| `evo_run_cycle` | Run one analysis/candidate-generation cycle. |
| `evo_full_cycle` | Run the complete autonomous cycle; requires an LLM endpoint and appropriate generation/promotion configuration. |
| `evo_sandbox_exec` | Execute a shell command in a Bubblewrap sandbox; refuses to run if `bwrap` is unavailable. |
| `evo_activation_status` | Inspect active artifact and activation diagnostics. |
| `evo_activation_refresh` | Refresh activation from the selected version artifact. |
| `evo_health` | Check plugin health. |

## Data and persistence

By default, state is stored under `$DSH_HOME/dsh-evolution/` (profile-scoped when the host exposes a profile path). Set `stateRoot` to use an explicit state directory.

```text
dsh-evolution/
├── experiences/   # Task execution records
├── patterns/      # Detected behavioral patterns
├── candidates/    # Proposed improvements and candidate files
├── benchmarks/    # Benchmark results
├── versions/      # Version records and activation artifacts
└── tmp/           # Temporary files
```

The store is file-backed and uses JSON, so records can be inspected with standard tools. Experience records are append-oriented, while version history is managed as versioned records. A promoted artifact is validated and preflighted before it can become active; activation is refreshed at startup and after version changes.

## Development

Install dependencies and run the available checks:

```bash
npm install
npm run typecheck
npm test
npm run build
```

The default test command is `vitest run --exclude test/real-agnes-experiment.spec.ts`. The live experiment is separate and can be run with:

```bash
npm run test:live
```

The live experiment may require a working DSH environment and configured model endpoint.

## Design principles

- **Evidence before conclusions:** pattern analysis is grounded in stored experiences.
- **Validation before activation:** generated candidate files are checked before acceptance and promotion.
- **Explicit safety controls:** generation and autonomous promotion are disabled by default.
- **Versioned recovery:** previous versions can be restored.
- **Operational transparency:** status and activation tools expose runtime state and failure reasons.
- **No model-weight updates:** evolution targets modular code, not fine-tuning.

## Known limitations

- `experience.maxRecords` and `experience.retentionDays` are declared defaults but are not currently enforced; stored experience files can accumulate.
- Full autonomous generation requires a working host LLM endpoint.
- The sandbox command requires Bubblewrap (`bwrap`); it is refused when that dependency is unavailable.
- Automatic generation and promotion are separate opt-in settings and are off by default.

## License

MIT — see `package.json`.
