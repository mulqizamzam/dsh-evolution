import type { BenchmarkOutcome } from '../../types.ts'

/**
 * Classify one sandbox execution into an end-to-end outcome using only the
 * fields SandboxExecResult already carries — no invented signals.
 *
 * Rule order (first match wins):
 *   1. OOM kill → execution-failure
 *   2. Timeout (timedOut) → execution-failure
 *   3. Spawn failure (exitCode null + non-0 signal / error in stderr) → execution-failure
 *   4. Non-zero exit code → unsuccessful-outcome (process ran, but did not succeed)
 *   5. Exit 0 + stdout non-empty → task-successful
 *   6. Exit 0 + stdout empty (successful-but-empty) → unsuccessful-outcome
 */
export function classifyOutcome(
  result: { exitCode: number | null; timedOut: boolean; oomKilled: boolean; stdout: string; stderr: string },
): BenchmarkOutcome {
  if (result.oomKilled) return 'execution-failure'
  if (result.timedOut) return 'execution-failure'
  // Spawn failure: bwrap ENOENT produces exitCode null and an error on stderr.
  if (result.exitCode === null && result.stderr.length > 0) return 'execution-failure'
  if (result.exitCode !== 0 && result.exitCode !== null) return 'unsuccessful-outcome'
  // Exit code 0 from here.
  if (result.stdout.trim() === '') return 'unsuccessful-outcome'
  return 'task-successful'
}
