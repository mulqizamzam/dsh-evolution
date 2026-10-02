/**
 * Manifest benchmark case execution — the missing path.
 *
 * Executes `CandidateManifest.benchmarkCases` as real sandbox benchmarks.
 * Each case's `input` field is the command to execute in the sandbox. The
 * case's `expectedOutput` and `expectedExitCode` are the candidate-declared
 * oracles (functional evidence).
 *
 * AUTHORITY MODEL:
 *   - Candidate declares cases (functional evidence)
 *   - Host executes in sandbox (host-controlled execution boundary)
 *   - Host classifies outcomes via host functions (host-controlled oracle logic)
 *   - Promotion authority remains with evo_benchmark_live / evo_benchmark_ab
 *     and evaluatePromotionPolicy — manifest cases are ADDITIONAL evidence
 *
 * MANIFEST SOURCE: candidates/<id>/manifest.json written by the builder tool.
 * CandidateModule does NOT carry a manifest field — the manifest is a separate
 * file on disk. This function reads it back via readCandidateManifest().
 */

import type {
  BenchmarkCase,
  BenchmarkExecutionResult,
  BenchmarkMetrics,
  BenchmarkOutcome,
  CandidateManifest,
  CandidateModule,
  ModuleDeps,
} from '../../types.ts'
import { classifyOutcome, evaluateExpectedOutput } from './outcome.ts'
import { createLiveProvenance } from '../../../lib/provenance.ts'
import { isoDateTime } from '../../../lib/ids.ts'
import { clampText } from '../../../lib/caps.ts'
import { containPath } from '../../../lib/contain.ts'
import { readJsonSafe } from '../../../lib/fsx.ts'
import { getSandbox } from '../sandbox/index.ts'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, sep, dirname } from 'node:path'
import { tmpdir } from 'node:os'

// ── Helpers ──────────────────────────────────────────────────────────────────

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((s, n) => s + n, 0) / values.length
}

/** Derive benchmark metrics from per-case execution results. */
function metricsFromCaseResults(results: BenchmarkExecutionResult[]): BenchmarkMetrics {
  const total = Math.max(1, results.length)
  const successCount = results.filter(r => r.outcome === 'task-successful').length
  const errored = results.filter(r => r.outcome === 'execution-failure').length
  const scores = results.map(r => r.score)
  const durations = results.map(r => r.durationMs)
  return {
    successRate: successCount / total,
    avgScore: mean(scores),
    errorRate: errored / total,
    avgSteps: 0,
    avgDurationMs: mean(durations),
  }
}

/**
 * Build per-case evaluation evidence string for persistence.
 * Mirrors the evaluation logic in evo_benchmark_live but is per-case scoped.
 */
function buildCaseEvaluation(
  result: { exitCode: number | null; timedOut: boolean; oomKilled: boolean; stdout: string; stderr: string },
  expectedExitCode: number | undefined,
  expectedOutput: string | undefined,
  timeoutMs: number,
): string {
  if (result.oomKilled) return 'OOM kill: process terminated by resource limit'
  if (result.timedOut) return 'Timeout: execution exceeded ' + timeoutMs + 'ms'
  if (result.exitCode === null && result.stderr.length > 0) return 'Spawn failure: ' + result.stderr.slice(0, 200)
  if (typeof expectedOutput === 'string') {
    const evalResult = evaluateExpectedOutput(result.stdout, expectedOutput)
    return evalResult.detail
      + (typeof expectedExitCode === 'number'
        ? '; process: exit ' + String(result.exitCode)
          + (result.exitCode === expectedExitCode ? ' matches' : ' does not match')
          + ' expected ' + expectedExitCode
        : '')
  }
  if (typeof expectedExitCode === 'number') {
    return result.exitCode === expectedExitCode
      ? 'exit code ' + result.exitCode + ' matches expected ' + expectedExitCode
      : 'exit code ' + result.exitCode + ' does not match expected ' + expectedExitCode
  }
  return 'legacy mode: exit code ' + String(result.exitCode)
    + (result.exitCode === 0 ? ' (exit-0 = success)' : ' (non-zero exit = failure)')
}

// ── Shared execution function ────────────────────────────────────────────────

export interface ManifestCaseRunOptions {
  /** Allow network access in the sandbox. Default false. */
  allowNetwork?: boolean
  /** Override cwd inside the tmp dir. Default tmp dir root. */
  cwd?: string
}

export interface ManifestCaseRunResult {
  ok: boolean
  error?: string
  /** Per-case execution results. */
  caseResults: BenchmarkExecutionResult[]
  /** Aggregated metrics from all cases. */
  metrics: BenchmarkMetrics
  /** Overall pass verdict: true only when ALL cases are task-successful. */
  passed: boolean
  /** Total number of cases executed. */
  totalCases: number
  /** Number of cases with task-successful outcome. */
  successfulCases: number
  /** Number of cases with unsuccessful-outcome. */
  failedCases: number
  /** Number of cases with execution-failure. */
  executionFailures: number
  /** Summary text. */
  details: string
}

/**
 * Execute all benchmark cases declared in a candidate's manifest.
 *
 * For each case:
 *   1. Validate the case
 *   2. Write candidate files to an isolated tmp directory
 *   3. Execute `case.input` as a shell command inside BubblewrapSandbox
 *   4. Classify the outcome via host classifyOutcome()
 *   5. Record a BenchmarkExecutionResult with candidate-declared oracles
 *
 * The function does NOT persist results — the caller decides how to store them.
 * This keeps the function reusable across manual and autonomous paths.
 *
 * COMMAND SOURCE: BenchmarkCase.input (candidate-declared, but executed inside
 * the existing sandbox containment model — same isolation as evo_benchmark_live).
 *
 * SANDBOX BOUNDARY: Same BubblewrapSandbox (or NodeProcessSandbox fallback)
 * used by evo_benchmark_live. Network, filesystem, and process isolation are
 * identical.
 *
 * CWD BOUNDARY: containBenchmarkCwd() applied per-case, same as existing tools.
 *
 * ORACLE BOUNDARY: classifyOutcome(result, case.expectedExitCode, case.expectedOutput)
 * — host function, candidate-declared values. The candidate controls what it
 * claims should happen; the HOST function makes the classification decision.
 */
/**
 * Read the CandidateManifest persisted at candidates/<id>/manifest.json.
 * Returns null when the file is missing or unparseable.
 */
export async function readCandidateManifest(
  storeRoot: string,
  candidateId: string,
): Promise<CandidateManifest | null> {
  const path = join(storeRoot, 'candidates', candidateId, 'manifest.json')
  const raw = await readJsonSafe(path)
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.benchmarkCases)) return null
  // Minimal validation — benchmarkCases must exist and have at least one entry
  if (obj.benchmarkCases.length === 0) {
    return obj as unknown as CandidateManifest
  }
  return obj as unknown as CandidateManifest
}

export async function runManifestCases(
  deps: ModuleDeps,
  candidate: CandidateModule,
  options?: ManifestCaseRunOptions,
): Promise<ManifestCaseRunResult> {
  // Manifest is persisted at candidates/<id>/manifest.json (written by builder).
  // CandidateModule does NOT carry a manifest field — read it from disk.
  let manifestCases: BenchmarkCase[] | null = null
  try {
    const manifest = await readCandidateManifest(deps.store.getRoot(), candidate.id)
    if (manifest) manifestCases = manifest.benchmarkCases
  } catch { /* fallback to inline cases below */ }

  const cases: BenchmarkCase[] = manifestCases
    ?? ((candidate as unknown as { manifest?: { benchmarkCases: BenchmarkCase[] } }).manifest?.benchmarkCases ?? [])
  if (cases.length === 0) {
    return {
      ok: false,
      error: 'candidate has no benchmark cases in manifest',
      caseResults: [],
      metrics: { successRate: 0, avgScore: 0, errorRate: 0, avgSteps: 0, avgDurationMs: 0 },
      passed: false,
      totalCases: 0,
      successfulCases: 0,
      failedCases: 0,
      executionFailures: 0,
      details: 'no benchmark cases defined',
    }
  }

  const sandbox = getSandbox()
  const available = await sandbox.isAvailable()
  if (!available) {
    return {
      ok: false,
      error: 'sandbox not available',
      caseResults: [],
      metrics: { successRate: 0, avgScore: 0, errorRate: 0, avgSteps: 0, avgDurationMs: 0 },
      passed: false,
      totalCases: cases.length,
      successfulCases: 0,
      failedCases: 0,
      executionFailures: 0,
      details: 'sandbox not available',
    }
  }

  const allowNetwork = options?.allowNetwork ?? false
  const tmpDir = await mkdtemp(join(tmpdir(), 'evo-manifest-'))

  try {
    // Write candidate files (same containment as evo_benchmark_live)
    const targets: Array<{ target: string; content: string }> = []
    const allFiles = [...candidate.files, ...candidate.tests]
    for (const f of allFiles) {
      const target = containPath(tmpDir, f.path)
      if (target === null) {
        return {
          ok: false,
          error: 'candidate path escapes the benchmark directory: ' + String(f.path),
          caseResults: [],
          metrics: { successRate: 0, avgScore: 0, errorRate: 0, avgSteps: 0, avgDurationMs: 0 },
          passed: false,
          totalCases: cases.length,
          successfulCases: 0,
          failedCases: 0,
          executionFailures: 0,
          details: 'file path containment violation',
        }
      }
      targets.push({ target, content: f.content })
    }
    for (const { target, content } of targets) {
      const dir = dirname(target)
      await mkdir(dir, { recursive: true })
      await writeFile(target, content, 'utf8')
    }

    // CWD containment
    const baseCwd = resolve(tmpDir)
    let execCwd = baseCwd
    if (typeof options?.cwd === 'string' && options.cwd !== '') {
      const contained = await containBenchmarkCwd(tmpDir, options.cwd)
      if (contained === null) {
        return {
          ok: false,
          error: 'cwd escapes the benchmark directory: ' + options.cwd,
          caseResults: [],
          metrics: { successRate: 0, avgScore: 0, errorRate: 0, avgSteps: 0, avgDurationMs: 0 },
          passed: false,
          totalCases: cases.length,
          successfulCases: 0,
          failedCases: 0,
          executionFailures: 0,
          details: 'cwd containment violation',
        }
      }
      execCwd = contained
    }

    // Execute each case
    const caseResults: BenchmarkExecutionResult[] = []

    for (const benchmarkCase of cases) {
      // Validate case has a command to execute
      if (typeof benchmarkCase.input !== 'string' || benchmarkCase.input.trim() === '') {
        caseResults.push({
          caseId: benchmarkCase.id,
          passed: false,
          score: 0,
          outcome: 'execution-failure',
          error: 'case has no input (command) to execute',
          durationMs: 0,
          stdout: '',
          stderr: 'no input command provided',
          exitCode: null,
          timedOut: false,
          expectedExitCode: benchmarkCase.expectedExitCode,
          expectedOutput: benchmarkCase.expectedOutput,
          evaluation: 'validation failure: no input command',
        })
        continue
      }

      const caseTimeoutMs = typeof benchmarkCase.timeoutMs === 'number' && benchmarkCase.timeoutMs > 0
        ? benchmarkCase.timeoutMs
        : 30_000

      try {
        const execResult = await sandbox.exec(benchmarkCase.input, {
          cwd: execCwd,
          timeoutMs: caseTimeoutMs,
          allowNetwork,
        })

        const outcome: BenchmarkOutcome = classifyOutcome(
          execResult,
          benchmarkCase.expectedExitCode,
          benchmarkCase.expectedOutput,
        )

        const evaluation = buildCaseEvaluation(
          execResult,
          benchmarkCase.expectedExitCode,
          benchmarkCase.expectedOutput,
          caseTimeoutMs,
        )

        caseResults.push({
          caseId: benchmarkCase.id,
          passed: outcome === 'task-successful',
          score: outcome === 'task-successful' ? 1.0 : 0.0,
          outcome,
          error: execResult.stderr || undefined,
          durationMs: execResult.durationMs,
          stdout: clampText(execResult.stdout, 10_000),
          stderr: clampText(execResult.stderr, 10_000),
          exitCode: execResult.exitCode,
          timedOut: execResult.timedOut,
          expectedExitCode: benchmarkCase.expectedExitCode,
          expectedOutput: benchmarkCase.expectedOutput,
          evaluation,
        })
      } catch (error) {
        caseResults.push({
          caseId: benchmarkCase.id,
          passed: false,
          score: 0,
          outcome: 'execution-failure',
          error: error instanceof Error ? error.message : String(error),
          durationMs: 0,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: null,
          timedOut: false,
          expectedExitCode: benchmarkCase.expectedExitCode,
          expectedOutput: benchmarkCase.expectedOutput,
          evaluation: 'exception during execution: ' + (error instanceof Error ? error.message : String(error)),
        })
      }
    }

    // Aggregate
    const metrics = metricsFromCaseResults(caseResults)
    const successfulCases = caseResults.filter(r => r.outcome === 'task-successful').length
    const failedCases = caseResults.filter(r => r.outcome === 'unsuccessful-outcome').length
    const executionFailures = caseResults.filter(r => r.outcome === 'execution-failure').length
    const passed = caseResults.length > 0 && caseResults.every(r => r.outcome === 'task-successful')

    const details = passed
      ? 'all ' + cases.length + ' manifest cases passed'
      + (executionFailures > 0 ? ' (' + executionFailures + ' execution failures)' : '')
      + (failedCases > 0 ? ' (' + failedCases + ' functional failures)' : '')
      : successfulCases + '/' + cases.length + ' cases passed'
      + (executionFailures > 0 ? '; ' + executionFailures + ' execution failures' : '')
      + (failedCases > 0 ? '; ' + failedCases + ' functional failures' : '')

    return {
      ok: true,
      caseResults,
      metrics,
      passed,
      totalCases: cases.length,
      successfulCases,
      failedCases,
      executionFailures,
      details,
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

// ── CWD containment (reused from tools.ts) ───────────────────────────────────

/**
 * Constrain a benchmark `cwd` input so it cannot escape the temp directory.
 * Identical logic to containBenchmarkCwd in tools.ts — duplicated here to
 * avoid a circular import while keeping the containment rule shared.
 */
async function containBenchmarkCwd(tmpDir: string, cwdInput: unknown): Promise<string | null> {
  if (cwdInput === undefined || cwdInput === '' || cwdInput === '.' || cwdInput === './') {
    return resolve(tmpDir)
  }
  if (typeof cwdInput !== 'string') return null
  if (cwdInput.includes('\0')) return null

  const base = resolve(tmpDir)
  const target = resolve(base, cwdInput)
  if (target === base) return base

  const rel = relative(base, target)
  if (rel === '' || isAbsolute(rel)) return null
  if (rel === '..' || rel.startsWith('..' + sep)) return null

  try {
    const { lstat, realpath } = await import('node:fs/promises')
    const st = await lstat(target)
    if (st.isSymbolicLink()) {
      const realTarget = await realpath(target).catch(() => target)
      const realRel = relative(base, realTarget)
      if (realRel === '' || isAbsolute(realRel)) return null
      if (realRel === '..' || realRel.startsWith('..' + sep)) return null
      return realTarget
    }
  } catch {
    // Target does not exist yet — lexical check is sufficient.
  }

  return target
}
