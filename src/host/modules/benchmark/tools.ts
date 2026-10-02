import { JSON_OBJECT_OUTPUT, defineTool, text } from '../../dsh.ts'
import type { BenchmarkConfig, BenchmarkExecutionResult, BenchmarkMetrics, ModuleDeps, ToolDefinition } from '../../types.ts'
import { DEFAULT_PROMOTION_POLICY } from '../../types.ts'
import { clampText } from '../../../lib/caps.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'
import { containPath } from '../../../lib/contain.ts'
import { classifyOutcome, evaluateExpectedOutput } from './outcome.ts'
import { createLiveProvenance } from '../../../lib/provenance.ts'
import { isoDateTime } from '../../../lib/ids.ts'
import { getSandbox } from '../sandbox/index.ts'
import { mkdtemp, rm, mkdir, writeFile, access, lstat, realpath } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, sep, dirname } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Constrain a benchmark `cwd` input so it cannot escape the temp directory
 * created by this benchmark run.
 *
 * The benchmark root (`tmpDir`) is what gets bind-mounted into the sandbox;
 * every `cwd` value must resolve to a directory that sits strictly inside
 * (or equal to) that root.  We reuse the lexical proof from `containPath`
 * (resolve + relative + ".."-check) rather than a string-prefix comparison.
 *
 * Unlike `containPath` (which rejects the root itself — it is for files),
 * the root directory is a valid `cwd`: `resolve(base, '.') === base` and
 * `resolve(base, '')` returns `base`, both of which must be allowed.
 *
 * Symlink defense (HIGH-severity finding, Argus/BadSector):
 *   After the lexical check passes, the target is stat()-checked.  If it is
 *   a symlink, it is resolved to its real filesystem target via lstat+readlink,
 *   and containment is re-checked against the real target.  This mirrors the
 *   existing pattern in `readArtifactFile` (loader.ts:340–353) and closes the
 *   TOCTOU symlink-follow vector on the benchmark tmpDir.
 *
 * @param tmpDir   the mkdtemp'd benchmark root
 * @param cwdInput the caller-supplied `cwd` string (or undefined/empty → default)
 * @returns the resolved absolute path when contained, `null` when it would
 *          resolve outside `tmpDir` or when the input is malformed.
 */
async function containBenchmarkCwd(tmpDir: string, cwdInput: unknown): Promise<string | null> {
  // undefined / empty / "." / "." + trailing separators all mean "use the root".
  if (cwdInput === undefined || cwdInput === '' || cwdInput === '.' || cwdInput === './') {
    return resolve(tmpDir)
  }
  if (typeof cwdInput !== 'string') return null
  if (cwdInput.includes('\0')) return null

  const base = resolve(tmpDir)
  const target = resolve(base, cwdInput)

  // target === base is a valid cwd (equivalent to ".").
  if (target === base) return base

  // Directory-boundary proof via relative() — the same rule used by
  // containPath for files.  A relative path that is ".." or starts with
  // "../" (i.e. walks outside `base`) is rejected.
  const rel = relative(base, target)
  if (rel === '' || isAbsolute(rel)) return null
  if (rel === '..' || rel.startsWith('..' + sep)) return null

  // Symlink defense: if the lexical path points to a symlink, resolve its
  // real filesystem target and re-check containment.  This follows the same
  // pattern as readArtifactFile (loader.ts:340–353).
  try {
    const st = await lstat(target)
    if (st.isSymbolicLink()) {
      const realTarget = await realpath(target).catch(() => target) // fall back to lexical if realpath fails
      const realRel = relative(base, realTarget)
      if (realRel === '' || isAbsolute(realRel)) return null
      if (realRel === '..' || realRel.startsWith('..' + sep)) return null
      return realTarget
    }
  } catch {
    // Target does not exist yet (e.g. cwd="subdir" where subdir hasn't been
    // created by writeCandidateFiles yet) — lexical check is sufficient.
    // The directory will be created by the sandbox binding; no further check needed.
  }

  return target
}

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

function emptyMetrics(): BenchmarkMetrics {
  return { successRate: 0, avgScore: 0, errorRate: 0, avgSteps: 0, avgDurationMs: 0 }
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((s, n) => s + n, 0) / values.length
}

/** Derive benchmark metrics from recorded experiences (proxy population). */
function computeMetrics(experienceCount: number, successCount: number, scores: number[], errored: number, steps: number[], durations: number[]): BenchmarkMetrics {
  const total = Math.max(1, experienceCount)
  return {
    successRate: successCount / total,
    avgScore: mean(scores),
    errorRate: errored / total,
    avgSteps: mean(steps),
    avgDurationMs: mean(durations),
  }
}

function evaluate(metrics: BenchmarkMetrics, cfg: BenchmarkConfig): { passed: boolean; details: string } {
  const checks: Array<{ label: string; pass: boolean }> = [
    { label: 'successRate >= ' + cfg.successRate.min, pass: metrics.successRate >= cfg.successRate.min },
    { label: 'avgScore >= ' + cfg.avgScore.min, pass: metrics.avgScore >= cfg.avgScore.min },
    { label: 'errorRate <= ' + cfg.errorRate.max, pass: metrics.errorRate <= cfg.errorRate.max },
    { label: 'avgSteps <= ' + cfg.avgSteps.max, pass: metrics.avgSteps <= cfg.avgSteps.max },
    { label: 'avgDurationMs <= ' + cfg.avgDurationMs.max, pass: metrics.avgDurationMs <= cfg.avgDurationMs.max },
  ]
  const failed = checks.filter(c => !c.pass).map(c => c.label)
  return {
    passed: failed.length === 0,
    details: failed.length === 0 ? 'All thresholds met.' : 'Failed: ' + failed.join('; '),
  }
}

/** Derive metrics from a set of execution results. */
function metricsFromResults(results: BenchmarkExecutionResult[]): BenchmarkMetrics {
  const total = Math.max(1, results.length)
  // Task-level counts: "passed" = the process ran and produced non-empty output
  const successCount = results.filter(r => r.outcome === 'task-successful').length
  // Execution-level failures: OOM, timeout, or spawn failure
  const errored = results.filter(r => r.outcome === 'execution-failure').length
  const scores = results.map(r => r.score)
  const durations = results.map(r => r.durationMs)
  return computeMetrics(total, successCount, scores, errored, [], durations)
}

/** Write candidate files (and tests) to a directory. Returns number of files written. */
async function writeCandidateFiles(candidateDir: string, files: Array<{ path: string; content: string }>, tests: Array<{ path: string; content: string }>): Promise<number> {
  const all = [...files, ...tests]
  // Resolve every target through the shared containment rule BEFORE any write:
  // candidate-controlled paths must stay inside the directory this benchmark
  // run owns, and a rejected path must not produce a partial outside write.
  const targets: Array<{ target: string; content: string }> = []
  for (const f of all) {
    const target = containPath(candidateDir, f.path)
    if (target === null) {
      throw new Error('candidate path escapes the benchmark directory: ' + String(f.path))
    }
    targets.push({ target, content: f.content })
  }
  let count = 0
  for (const { target, content } of targets) {
    const dir = dirname(target)
    await mkdir(dir, { recursive: true })
    await writeFile(target, content, 'utf8')
    count++
  }
  return count
}

export function benchmarkTools(deps: ModuleDeps): ToolDefinition[] {
  const store = deps.store
  const cfg = deps.cfg

  return [
    defineTool({
      name: 'evo_benchmark_run',
      description: 'Run a benchmark comparison for a candidate against recorded experience metrics and its configured thresholds. Reports pass or fail.',
      parameters: {
        type: 'object',
        properties: {
          candidateId: { type: 'string', description: 'The candidate id to benchmark.' },
          runs: { type: 'number', description: 'Number of runs to report; clamped to configured min and max. Defaults to 3.' },
        },
        required: ['candidateId'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const candidateId = typeof a.candidateId === 'string' ? a.candidateId : ''
        const candidate = await store.getCandidate(candidateId)
        if (!candidate) return neutralizeDeep({ ok: false, error: 'no candidate ' + candidateId })
        if (candidate.status === 'promoted') return neutralizeDeep({ ok: false, error: 'candidate already promoted' })

        const limits = cfg().benchmark
        let runs = typeof a.runs === 'number' ? Math.floor(a.runs) : limits.minRuns
        runs = Math.max(limits.minRuns, Math.min(limits.maxRuns, runs))

        const experiences = await store.listExperiences(500)
        const successCount = experiences.filter(e => e.success).length
        const scores = experiences.map(e => e.score).filter((s): s is number => typeof s === 'number')
        const errored = experiences.filter(e => Array.isArray(e.errors) && e.errors.length > 0).length
        const steps = experiences.map(e => e.stepCount).filter((s): s is number => typeof s === 'number')
        const durations = experiences.map(e => e.durationMs).filter((d): d is number => typeof d === 'number')
        const metrics = computeMetrics(experiences.length, successCount, scores, errored, steps, durations)
        const verdict = evaluate(metrics, candidate.benchmarkConfig)

        const run = await store.addBenchmark({
          mode: 'simulated',
          candidateId,
          version: candidate.parentVersion,
          baseline: candidate.parentVersion,
          runs,
          metrics,
          passed: verdict.passed,
          details: clampText(verdict.details, 500),
        })
        await store.updateCandidate(candidateId, { status: verdict.passed ? 'benchmarked' : 'rejected' })
        return neutralizeDeep({ ok: true, candidateId, benchmarkRunId: run.id, runs, metrics, passed: verdict.passed, details: verdict.details, evidenceMode: 'simulated' })
      },
    } as never),

    defineTool({
      name: 'evo_benchmark_compare',
      description: 'Compare a stored benchmark run against its candidate thresholds, per metric and overall.',
      parameters: {
        type: 'object',
        properties: {
          benchmarkId: { type: 'string', description: 'The benchmark run id to compare.' },
        },
        required: ['benchmarkId'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const benchmarkId = typeof a.benchmarkId === 'string' ? a.benchmarkId : ''
        const runs = await store.listBenchmarks(500)
        const run = runs.find(r => r.id === benchmarkId)
        if (!run) return neutralizeDeep({ ok: false, error: 'no benchmark ' + benchmarkId })
        const candidate = await store.getCandidate(run.candidateId)
        if (!candidate) return neutralizeDeep({ ok: false, error: 'no candidate ' + run.candidateId })
        const verdict = evaluate(run.metrics, candidate.benchmarkConfig)
        return neutralizeDeep({
          ok: true,
          benchmarkId,
          candidateId: run.candidateId,
          metrics: run.metrics,
          thresholds: candidate.benchmarkConfig,
          passed: verdict.passed,
          details: verdict.details,
        })
      },
    } as never),

    defineTool({
      name: 'evo_benchmark_live',
      description: 'Execute a command in a live sandbox against a candidate file set and return detailed execution results including stdout, stderr, exit code, and timing. When expectedExitCode is provided, it is used as the trusted oracle for task classification — independent of any candidate-generated metadata.',
      parameters: {
        type: 'object',
        properties: {
          candidateId: { type: 'string', description: 'The candidate id whose files to execute.' },
          command: { type: 'string', description: 'The shell command to run in the sandbox (e.g. "node test.js").' },
          cwd: { type: 'string', description: 'Optional override for the working directory inside the temp dir. Defaults to the temp dir root.' },
          timeoutMs: { type: 'number', description: 'Timeout in milliseconds. Defaults to 30000.' },
          allowNetwork: { type: 'boolean', description: 'Whether to allow network access in the sandbox. Defaults to false.' },
          expectedExitCode: {
            type: 'number',
            description:
              'The operator-owned expected exit code for task success. When provided, the actual exit code is compared against this value to classify the outcome. Candidate-generated metadata is never read for this value.',
          },
          expectedOutput: {
            type: 'string',
            description:
              'The operator-owned expected stdout content (exact string or /regex/ literal). When provided, stdout is evaluated against it regardless of exit code. Supersedes exit-code-only classification when both are set. Candidate-generated metadata is never read for this value.',
          },
        },
        required: ['candidateId', 'command'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const candidateId = typeof a.candidateId === 'string' ? a.candidateId : ''
        const command = typeof a.command === 'string' ? a.command : ''
        const timeoutMs = typeof a.timeoutMs === 'number' ? a.timeoutMs : 30_000
        const allowNetwork = typeof a.allowNetwork === 'boolean' ? a.allowNetwork : false
        const expectedExitCode = typeof a.expectedExitCode === 'number' ? a.expectedExitCode : undefined
        const expectedOutput = typeof a.expectedOutput === 'string' ? a.expectedOutput : undefined

        if (!candidateId || !command) {
          return neutralizeDeep({ ok: false, error: 'candidateId and command are required' })
        }

        const candidate = await store.getCandidate(candidateId)
        if (!candidate) return neutralizeDeep({ ok: false, error: 'no candidate ' + candidateId })

        const sandbox = getSandbox()
        const available = await sandbox.isAvailable()
        if (!available) return neutralizeDeep({ ok: false, error: 'sandbox not available' })

        const tmpDir = await mkdtemp(join(tmpdir(), 'evo-bench-'))
        try {
          // Write candidate files to temp directory
          const filesDir = join(store.getRoot(), 'candidates', candidateId)

          // Check if physical files exist on disk alongside the JSON metadata
          let filesWritten = 0
          try {
            await access(filesDir)
            // Physical directory exists but may only contain JSON; fall back to in-memory files
            filesWritten = await writeCandidateFiles(tmpDir, candidate.files, candidate.tests)
          } catch {
            filesWritten = await writeCandidateFiles(tmpDir, candidate.files, candidate.tests)
          }

          if (filesWritten === 0) {
            return neutralizeDeep({ ok: false, error: 'candidate has no files to execute' })
          }

          const cwdInput = typeof a.cwd === 'string' ? a.cwd : ''
          const execCwd = await containBenchmarkCwd(tmpDir, cwdInput)
          if (execCwd === null) {
            return neutralizeDeep({ ok: false, error: 'cwd escapes the benchmark directory: ' + cwdInput })
          }

          const result = await sandbox.exec(command, {
            cwd: execCwd,
            timeoutMs,
            allowNetwork,
          })

          // Functional + process outcome classification (operator-owned oracles).
          const outcome = classifyOutcome(result, expectedExitCode, expectedOutput)

          // Build evaluation evidence string for the benchmark record.
          let evaluation: string
          if (result.oomKilled) {
            evaluation = 'OOM kill: process terminated by resource limit; cannot evaluate'
          } else if (result.timedOut) {
            evaluation = 'Timeout: execution exceeded ' + timeoutMs + 'ms; cannot evaluate'
          } else if (result.exitCode === null && result.stderr.length > 0) {
            evaluation = 'Spawn failure: ' + result.stderr.slice(0, 200)
          } else if (typeof expectedOutput === 'string') {
            // Functional oracle was used — report both functional and process evidence.
            const evalResult = evaluateExpectedOutput(result.stdout, expectedOutput)
            evaluation = evalResult.detail
            + (typeof expectedExitCode === 'number'
              ? '; process: exit ' + String(result.exitCode) + (result.exitCode === expectedExitCode ? ' matches' : ' does not match') + ' expected ' + expectedExitCode
              : '')
          } else if (typeof expectedExitCode === 'number') {
            evaluation = result.exitCode === expectedExitCode
              ? 'exit code ' + result.exitCode + ' matches expected ' + expectedExitCode
              : 'exit code ' + result.exitCode + ' does not match expected ' + expectedExitCode
          } else {
            evaluation = 'legacy mode: exit code ' + String(result.exitCode) +
              (result.exitCode === 0 ? ' (exit-0 = success)' : ' (non-zero exit = failure)')
          }

          const executionResult: BenchmarkExecutionResult = {
            caseId: 'live-exec-' + candidateId,
            passed: outcome === 'task-successful',
            score: outcome === 'task-successful' ? 1.0 : 0.0,
            outcome,
            error: result.stderr || undefined,
            durationMs: result.durationMs,
            stdout: clampText(result.stdout, 10_000),
            stderr: clampText(result.stderr, 10_000),
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            expectedExitCode,
            evaluation,
          }

          // Evidence produced by REAL execution must be recorded, or the
          // deterministic gate has nothing to decide on.
          const liveMetrics: BenchmarkMetrics = {
            successRate: outcome === 'task-successful' ? 1 : 0,
            avgScore: outcome === 'task-successful' ? 1 : 0,
            errorRate: outcome === 'execution-failure' ? 1 : 0,
            avgSteps: 0,
            avgDurationMs: result.durationMs,
          }
          // Compute provenance seal: deterministic fingerprint of the live execution.
          // This makes a forged mode='live' record detectable at the promotion boundary.
          // The authoritative timestamp is computed ONCE and passed to both the seal
          // and the store so that verifyLiveProvenance() — which re-derives the seal
          // from the persisted record — finds an exact match.
          const createdAt = isoDateTime(new Date())
          const provenance = createLiveProvenance(candidateId, candidate.parentVersion, command, createdAt)
          const record = await store.addBenchmark({
            mode: 'live',
            candidateId,
            version: candidate.parentVersion,
            baseline: candidate.parentVersion,
            parentVersion: candidate.parentVersion,
            runs: 1,
            metrics: liveMetrics,
            thresholds: candidate.benchmarkConfig,
            command: clampText(command, 500),
            expectedExitCode,
            expectedOutput,
            provenance,
            passed: outcome === 'task-successful',
            details: clampText(
              'live sandbox execution (' + sandbox.name + '): exit ' + String(result.exitCode)
              + (result.timedOut ? ', timed out' : '')
              + ', outcome=' + outcome
              + (typeof expectedExitCode === 'number' ? ', expectedExit=' + expectedExitCode : '')
              + (typeof expectedOutput === 'string' ? ', expectedOutput=(' + expectedOutput.slice(0, 60) + ')' : ''),
              500,
            ),
          }, createdAt)
          await store.updateCandidate(candidateId, { status: outcome === 'task-successful' ? 'benchmarked' : 'rejected' })

          return neutralizeDeep({
            ok: true,
            candidateId,
            command,
            sandbox: sandbox.name,
            executionResult,
            outcome,
            expectedExitCode,
            expectedOutput,
            filesWritten,
            benchmarkRunId: record.id,
            metrics: liveMetrics,
            passed: outcome === 'task-successful',
            evidenceMode: 'live',
          })
        } finally {
          await rm(tmpDir, { recursive: true, force: true })
        }
      },
    } as never),

    defineTool({
      name: 'evo_benchmark_ab',
      description: 'Run an A/B benchmark comparing a candidate against its baseline by executing a command in a sandbox for multiple runs and computing comparative metrics. When expectedExitCode and/or expectedOutput are provided, they are used as the trusted oracles for both sides — independent of any candidate-generated metadata.',
      parameters: {
        type: 'object',
        properties: {
          candidateId: { type: 'string', description: 'The candidate id to compare against baseline.' },
          command: { type: 'string', description: 'The shell command to run in the sandbox for each execution (e.g. "node test.js").' },
          runs: { type: 'number', description: 'Number of runs for each side (baseline and candidate). Defaults to 3.' },
          timeoutMs: { type: 'number', description: 'Timeout per execution in milliseconds. Defaults to 30000.' },
          allowNetwork: { type: 'boolean', description: 'Whether to allow network access in the sandbox. Defaults to false.' },
          expectedExitCode: {
            type: 'number',
            description:
              'The operator-owned expected exit code for task success. When provided, the actual exit code is compared against this value to classify outcomes for both baseline and candidate.',
          },
          expectedOutput: {
            type: 'string',
            description:
              'The operator-owned expected stdout content (exact string or /regex/ literal). When provided, stdout is evaluated against it for both sides. Supersedes exit-code-only classification. Candidate-generated metadata is never read.',
          },
          cwd: { type: 'string', description: 'Optional override for the working directory inside the temp dir. Defaults to the temp dir root.' },
        },
        required: ['candidateId', 'command'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const candidateId = typeof a.candidateId === 'string' ? a.candidateId : ''
        const command = typeof a.command === 'string' ? a.command : ''
        const numRuns = typeof a.runs === 'number' ? Math.max(1, Math.floor(a.runs)) : 3
        const timeoutMs = typeof a.timeoutMs === 'number' ? a.timeoutMs : 30_000
        const allowNetwork = typeof a.allowNetwork === 'boolean' ? a.allowNetwork : false
        const expectedExitCode = typeof a.expectedExitCode === 'number' ? a.expectedExitCode : undefined
        const expectedOutput = typeof a.expectedOutput === 'string' ? a.expectedOutput : undefined
        const cwdInput = typeof a.cwd === 'string' ? a.cwd : ''

        if (!candidateId || !command) {
          return neutralizeDeep({ ok: false, error: 'candidateId and command are required' })
        }

        const candidate = await store.getCandidate(candidateId)
        if (!candidate) return neutralizeDeep({ ok: false, error: 'no candidate ' + candidateId })

        const sandbox = getSandbox()
        const available = await sandbox.isAvailable()
        if (!available) return neutralizeDeep({ ok: false, error: 'sandbox not available' })

        // Helper: write files from a CandidateModule to a temp dir
        async function setupSide(sideLabel: string, files: Array<{ path: string; content: string }>, tests: Array<{ path: string; content: string }>): Promise<string> {
          const dir = await mkdtemp(join(tmpdir(), `evo-ab-${sideLabel}-`))
          await writeCandidateFiles(dir, files, tests)
          return dir
        }

        // Helper: run one side N times
        async function runSide(sideLabel: string, dir: string, runs: number): Promise<BenchmarkExecutionResult[]> {
          // Apply cwd containment to each side's temp dir.
          const sideCwd = await containBenchmarkCwd(dir, cwdInput)
          if (sideCwd === null) {
            throw new Error('cwd escapes the benchmark directory: ' + cwdInput)
          }
          const results: BenchmarkExecutionResult[] = []
          for (let i = 0; i < runs; i++) {
            const execResult = await sandbox.exec(command, {
              cwd: sideCwd,
              timeoutMs,
              allowNetwork,
            })
            const outcome = classifyOutcome(execResult, expectedExitCode, expectedOutput)
            // Build evaluation evidence when functional oracle is used.
            let evaluation: string | undefined
            if (typeof expectedOutput === 'string') {
              evaluation = evaluateExpectedOutput(execResult.stdout, expectedOutput).detail
            }
            results.push({
              caseId: `${sideLabel}-run-${i + 1}`,
              passed: outcome === 'task-successful',
              score: outcome === 'task-successful' ? 1.0 : 0.0,
              outcome,
              error: execResult.stderr || undefined,
              durationMs: execResult.durationMs,
              stdout: clampText(execResult.stdout, 10_000),
              stderr: clampText(execResult.stderr, 10_000),
              exitCode: execResult.exitCode,
              timedOut: execResult.timedOut,
              expectedExitCode,
              expectedOutput,
              evaluation,
            })
          }
          return results
        }

        // Find baseline: the parent version's candidate or the current promoted version
        const baselineId = candidate.parentVersion
        let baselineCandidate = await store.getCandidate(baselineId)

        // Fallback: if parentVersion is not a candidate id, try the active version's module list
        if (!baselineCandidate) {
          const activeVersion = await store.getActiveVersion()
          if (activeVersion) {
            // Use first module from active version as baseline reference
            for (const modId of activeVersion.modules) {
              const mod = await store.getCandidate(modId)
              if (mod) { baselineCandidate = mod; break }
            }
          }
        }

        let baselineDir: string | null = null
        let candidateDir: string | null = null
        const allCaseResults: BenchmarkExecutionResult[] = []

        try {
          // Setup and run baseline
          let baselineResults: BenchmarkExecutionResult[] = []
          if (baselineCandidate) {
            baselineDir = await setupSide('baseline', baselineCandidate.files, baselineCandidate.tests)
            baselineResults = await runSide('baseline', baselineDir, numRuns)
            allCaseResults.push(...baselineResults)
          }

          // Setup and run candidate
          candidateDir = await setupSide('candidate', candidate.files, candidate.tests)
          const candidateResults = await runSide('candidate', candidateDir, numRuns)
          allCaseResults.push(...candidateResults)

          // Compute metrics for each side
          const baselineMetrics = baselineCandidate ? metricsFromResults(baselineResults) : emptyMetrics()
          const candidateMetrics = metricsFromResults(candidateResults)

          // Compute comparison deltas
          const successRateDelta = candidateMetrics.successRate - baselineMetrics.successRate
          const scoreDelta = candidateMetrics.avgScore - baselineMetrics.avgScore
          const errorRateDelta = candidateMetrics.errorRate - baselineMetrics.errorRate
          const latencyDeltaMs = candidateMetrics.avgDurationMs - baselineMetrics.avgDurationMs

          // Determine verdict based on promotion policy
          const policy = DEFAULT_PROMOTION_POLICY

          const rejectionReasons: string[] = []
          const baselinePassRate = baselineMetrics.successRate

          // Check: candidate must not regress too much
          if (successRateDelta < policy.maxRegression) {
            rejectionReasons.push(`success rate regression: ${(successRateDelta * 100).toFixed(1)}% (max allowed: ${policy.maxRegression * 100}%)`)
          }

          // Check: candidate should show minimum improvement
          if (successRateDelta < policy.minSuccessImprovement && baselinePassRate > 0) {
            rejectionReasons.push(`insufficient improvement: ${(successRateDelta * 100).toFixed(1)}% (min: ${policy.minSuccessImprovement * 100}%)`)
          }

          // Check: latency must not explode
          if (baselineMetrics.avgDurationMs > 0) {
            const latencyMultiplier = candidateMetrics.avgDurationMs / baselineMetrics.avgDurationMs
            if (latencyMultiplier > policy.maxLatencyMultiplier) {
              rejectionReasons.push(`latency ${latencyMultiplier.toFixed(1)}x baseline (max: ${policy.maxLatencyMultiplier}x)`)
            }
          }

          // Check: minimum candidate cases passing
          const candidatePassCount = candidateResults.filter(r => r.passed).length
          if (candidatePassCount < policy.minCandidateCases) {
            rejectionReasons.push(`only ${candidatePassCount}/${numRuns} runs passed (min: ${policy.minCandidateCases})`)
          }

          let verdict: 'candidate-wins' | 'baseline-wins' | 'tie'
          if (rejectionReasons.length > 0) {
            verdict = 'baseline-wins'
          } else if (successRateDelta > 0) {
            verdict = 'candidate-wins'
          } else if (successRateDelta < 0) {
            verdict = 'baseline-wins'
          } else {
            verdict = 'tie'
          }

          const passed = verdict === 'candidate-wins'
          const details = passed
            ? `Candidate wins: +${(successRateDelta * 100).toFixed(1)}% success, +${scoreDelta.toFixed(2)} score, ${latencyDeltaMs.toFixed(0)}ms latency delta.`
            : `Verdict: ${verdict}. ` + (rejectionReasons.length > 0 ? rejectionReasons.join('; ') : 'No significant improvement.')

          // Provenance seal for the A/B live benchmark record.
          // The authoritative timestamp is computed ONCE and passed to both the seal
          // and the store so that verifyLiveProvenance() finds an exact match.
          const abRecordCreatedAt = isoDateTime(new Date())
          // Store the AB run
          const abRun = {
            id: candidateId + '-ab-' + Date.now(),
            candidateId,
            version: candidate.parentVersion,
            baseline: baselineCandidate?.id ?? 'unknown',
            runs: numRuns,
            baselineMetrics,
            candidateMetrics,
            comparison: {
              successRateDelta,
              scoreDelta,
              errorRateDelta,
              latencyDeltaMs,
              verdict,
              rejectionReasons,
            },
            caseResults: allCaseResults,
            passed,
            details: clampText(details, 500),
            createdAt: abRecordCreatedAt,
          }

          const abRecord = await store.addBenchmark({
            mode: 'live',
            candidateId,
            version: candidate.parentVersion,
            baseline: baselineCandidate?.id ?? 'unknown',
            parentVersion: candidate.parentVersion,
            runs: numRuns,
            metrics: candidateMetrics,
            baselineMetrics,
            comparison: abRun.comparison,
            caseResults: allCaseResults,
            thresholds: candidate.benchmarkConfig,
            command: clampText(command, 500),
            expectedExitCode,
            expectedOutput,
            provenance: createLiveProvenance(candidateId, candidate.parentVersion, command, abRecordCreatedAt) ?? undefined,
            passed,
            details: clampText(details, 500),
          }, abRecordCreatedAt)
          await store.updateCandidate(candidateId, { status: passed ? 'benchmarked' : 'rejected' })

          return neutralizeDeep({
            ok: true,
            benchmarkRunId: abRecord.id,
            abRun,
            summary: {
              baselineRuns: baselineCandidate ? numRuns : 0,
              candidateRuns: numRuns,
              verdict,
              passed,
            },
            evidenceMode: 'live',
          })
        } finally {
          if (baselineDir) await rm(baselineDir, { recursive: true, force: true })
          if (candidateDir) await rm(candidateDir, { recursive: true, force: true })
        }
      },
    } as never),

    defineTool({
      name: 'evo_benchmark_manifest',
      description: 'Execute all benchmark cases declared in a candidate\'s manifest as real sandbox benchmarks. Each case\'s input field is the command to execute; expectedOutput and expectedExitCode are the per-case oracles. Results are persisted as a mode=manifest BenchmarkRun with caseResults. This provides candidate-declared functional evidence only; manifest evidence is diagnostic and does not independently satisfy promotion requirements — run evo_benchmark_live or evo_benchmark_ab for promotion-eligible evidence.',
      parameters: {
        type: 'object',
        properties: {
          candidateId: { type: 'string', description: 'The candidate id whose manifest cases to execute.' },
          allowNetwork: { type: 'boolean', description: 'Whether to allow network access in the sandbox. Defaults to false.' },
          cwd: { type: 'string', description: 'Optional override for the working directory inside the temp dir. Defaults to the temp dir root.' },
        },
        required: ['candidateId'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const candidateId = typeof a.candidateId === 'string' ? a.candidateId : ''

        if (!candidateId) {
          return neutralizeDeep({ ok: false, error: 'candidateId is required' })
        }

        const candidate = await store.getCandidate(candidateId)
        if (!candidate) return neutralizeDeep({ ok: false, error: 'no candidate ' + candidateId })
        if (candidate.status === 'promoted') return neutralizeDeep({ ok: false, error: 'candidate already promoted' })

        // Manifest is persisted at candidates/<id>/manifest.json (written by builder).
        // CandidateModule does NOT carry a manifest field — read it from disk.
        const { readCandidateManifest } = await import('./manifest.ts')
        const manifest = await readCandidateManifest(store.getRoot(), candidateId)
        const cases = manifest?.benchmarkCases ?? []
        if (cases.length === 0) {
          return neutralizeDeep({ ok: false, error: 'candidate has no benchmark cases in manifest' })
        }

        const { runManifestCases } = await import('./manifest.ts')
        const result = await runManifestCases(deps, candidate, {
          allowNetwork: typeof a.allowNetwork === 'boolean' ? a.allowNetwork : undefined,
          cwd: typeof a.cwd === 'string' ? a.cwd : undefined,
        })

        if (!result.ok) {
          return neutralizeDeep({ ok: false, error: result.error, details: result.details })
        }

        // Persist as a manifest BenchmarkRun with caseResults.
        // mode='manifest' distinguishes candidate-declared evidence from
        // operator-controlled live benchmarks. Manifest evidence is
        // diagnostic — it does not independently satisfy promotion
        // requirements (promotion authority remains with evo_benchmark_live
        // / evo_benchmark_ab). The provenance seal is still computed for
        // tamper-detection on the persisted record.
        const createdAt = isoDateTime(new Date())
        const provenance = createLiveProvenance(candidateId, candidate.parentVersion, 'manifest-cases', createdAt)

        const record = await store.addBenchmark({
          mode: 'manifest',
          candidateId,
          version: candidate.parentVersion,
          baseline: candidate.parentVersion,
          parentVersion: candidate.parentVersion,
          runs: result.totalCases,
          metrics: result.metrics,
          thresholds: candidate.benchmarkConfig,
          command: 'manifest-cases',
          provenance,
          passed: result.passed,
          caseResults: result.caseResults,
          details: clampText(result.details, 500),
        }, createdAt)

        await store.updateCandidate(candidateId, { status: result.passed ? 'benchmarked' : 'rejected' })

        return neutralizeDeep({
          ok: true,
          candidateId,
          benchmarkRunId: record.id,
          totalCases: result.totalCases,
          successfulCases: result.successfulCases,
          failedCases: result.failedCases,
          executionFailures: result.executionFailures,
          metrics: result.metrics,
          passed: result.passed,
          caseResults: result.caseResults,
          details: result.details,
          evidenceMode: 'manifest',
        })
      },
    } as never),
  ]
}
