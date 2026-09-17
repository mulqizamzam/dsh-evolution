import type { BenchmarkOutcome } from '../../types.ts'

/**
 * Classify one sandbox execution into an end-to-end outcome using only the
 * fields SandboxExecResult already carries — no invented signals.
 *
 * Rule order (first match wins):
 *   1. OOM kill → execution-failure
 *   2. Timeout → execution-failure
 *   3. Spawn failure (exitCode null + non-empty stderr) → execution-failure
 *   4. Non-zero exit code → unsuccessful-outcome (process ran, but did not
 *      succeed; may still have emitted partial output)
 *   5. Exit 0 → task-successful (the process completed; stdout presence is
 *      intentionally NOT used as a success oracle because legitimate
 *      benchmarks such as silent-build-tools may produce zero stdout on
 *      success, and no task-specific expected-output evaluation exists in
 *      the current runner.)
 *
 * IMPORTANT (P6 PARTIAL, see docs/AUDIT-2026-09-18.md §8):
 *   The benchmark runner executes a single arbitrary shell command.
 *   BenchmarkCase.expectedOutput / expectedExitCode are stored but NEVER
 *   evaluated. Therefore task-successful currently means "the process exited
 *   zero" — equivalent to the old `passed` field. The distinction between
 *   execution-failure and unsuccessful-outcome IS new and useful: it separates
 *   hard process errors (OOM/timeout/spawn-fail) from application-level
 *   failure (non-zero exit) so the promotion gate can tell them apart.
 *
 * To make outcome a true end-to-end task oracle, the runner must:
 *   (a) read manifest.benchmarkCases from candidates/<id>/manifest.json,
 *   (b) run each case with its expectedOutput regex and expectedExitCode,
 *   (c) map per-case results into BenchmarkExecutionResult.outcome.
 *   None of (a)-(c) exists in the current codebase; adding them is a
 *   structural change outside this mission's scope.
 */
export function classifyOutcome(
  result: { exitCode: number | null; timedOut: boolean; oomKilled: boolean; stdout: string; stderr: string },
): BenchmarkOutcome {
  if (result.oomKilled) return 'execution-failure'
  if (result.timedOut) return 'execution-failure'
  // Spawn failure: bwrap ENOENT produces exitCode null and an error on stderr.
  if (result.exitCode === null && result.stderr.length > 0) return 'execution-failure'
  if (result.exitCode !== 0 && result.exitCode !== null) return 'unsuccessful-outcome'
  // Exit code 0: the process completed successfully.
  return 'task-successful'
}
