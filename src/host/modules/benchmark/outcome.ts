import type { BenchmarkOutcome } from '../../types.ts'

/**
 * Classify one sandbox execution into an end-to-end outcome.
 *
 * The oracle is operator-owned: `expectedExitCode` is a caller-supplied
 * parameter, never derived from the candidate's own manifest or metadata.
 * When absent, legacy behaviour (exit-0 → task-successful) is preserved
 * so existing callers are not broken.
 *
 * Rule order (first match wins):
 *   1. OOM kill → execution-failure
 *   2. Timeout → execution-failure
 *   3. Spawn failure (exitCode null + non-empty stderr) → execution-failure
 *   4. When expectedExitCode is set:
 *        actual === expected  → task-successful
 *        actual !== expected  → unsuccessful-outcome
 *      Exit code is the trusted oracle; stdout presence is irrelevant.
 *   5. Legacy path (expectedExitCode absent):
 *        non-zero exit → unsuccessful-outcome
 *        exit 0       → task-successful
 */
export function classifyOutcome(
  result: { exitCode: number | null; timedOut: boolean; oomKilled: boolean; stdout: string; stderr: string },
  expectedExitCode?: number,
): BenchmarkOutcome {
  if (result.oomKilled) return 'execution-failure'
  if (result.timedOut) return 'execution-failure'
  // Spawn failure: bwrap ENOENT produces exitCode null and an error on stderr.
  if (result.exitCode === null && result.stderr.length > 0) return 'execution-failure'
  if (typeof expectedExitCode === 'number') {
    // Operator-owned oracle: compare against the explicit expected value.
    return result.exitCode === expectedExitCode ? 'task-successful' : 'unsuccessful-outcome'
  }
  // Legacy fallback: any non-zero exit is application-level failure.
  if (result.exitCode !== 0 && result.exitCode !== null) return 'unsuccessful-outcome'
  return 'task-successful'
}
