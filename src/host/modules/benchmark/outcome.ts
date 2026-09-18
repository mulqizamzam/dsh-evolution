import type { BenchmarkOutcome } from '../../types.ts'

/**
 * Evaluate the operator-owned functional oracle against stdout.
 *
 * Returns the evaluation text (for persistence) and a boolean indicating
 * whether the output matched the expected value.
 *
 * Matching modes:
 *   - Plain string (or empty string): exact match after trimming trailing
 *     whitespace/newlines from both sides, so console.log-generated output
 *     (which ends in \\n) is handled correctly.
 *   - Regex literal `/pattern/flags`: regex match against stdout.
 *     Invalid regex → explicit "malformed regex" result (never success).
 */
export function evaluateExpectedOutput(
  stdout: string,
  expectedOutput: string,
): { ok: boolean; detail: string } {
  if (expectedOutput === '') {
    // Empty expectedOutput means "output is allowed but not required";
    // treat as a pass only when the process exited 0 (handled upstream).
    return { ok: true, detail: 'expectedOutput is empty — stdout not checked' }
  }
  const trimmed = expectedOutput.trim()
  // Trim trailing whitespace/newlines from stdout so that console.log output
  // (which ends in \\n) matches the operator's plain-text expectation.
  const normalizedStdout = stdout.replace(/\s+$/, '')
  if (trimmed.startsWith('/') && trimmed.endsWith('/') && trimmed.length > 2) {
    // Regex literal: /pattern/flags or /pattern
    const inner = trimmed.slice(1, -1)
    const slashIdx = inner.lastIndexOf('/')
    const pattern = slashIdx >= 0 ? inner.slice(0, slashIdx) : inner
    const flags = slashIdx >= 0 ? inner.slice(slashIdx + 1) : ''
    try {
      const re = new RegExp(pattern, flags)
      if (re.test(stdout)) {
        return { ok: true, detail: 'stdout matches regex ' + trimmed }
      }
      return { ok: false, detail: 'stdout does not match regex ' + trimmed }
    } catch {
      return { ok: false, detail: 'malformed regex ' + trimmed }
    }
  }
  // Exact string match (both sides trimmed)
  if (normalizedStdout === trimmed) {
    return { ok: true, detail: 'stdout matches expected text exactly' }
  }
  return { ok: false, detail: 'stdout does not match expected text (expected ' + JSON.stringify(trimmed) + ')' }
}

/**
 * Classify one sandbox execution into an end-to-end outcome.
 *
 * The oracles are operator-owned: both `expectedExitCode` and
 * `expectedOutput` are caller-supplied parameters, never derived from
 * the candidate's own manifest or metadata.
 *
 * Rule order (first match wins):
 *   1. OOM kill → execution-failure
 *   2. Timeout → execution-failure
 *   3. Spawn failure (exitCode null + non-empty stderr) → execution-failure
 *   4. When expectedOutput is set:
 *        matches → check expectedExitCode (if also set) or task-successful
 *        does not match → unsuccessful-outcome (functional failure)
 *   5. When expectedExitCode is set:
 *        actual === expected  → task-successful
 *        actual !== expected  → unsuccessful-outcome
 *   6. Legacy path (neither oracle set):
 *        non-zero exit → unsuccessful-outcome
 *        exit 0       → task-successful
 */
export function classifyOutcome(
  result: { exitCode: number | null; timedOut: boolean; oomKilled: boolean; stdout: string; stderr: string },
  expectedExitCode?: number,
  expectedOutput?: string,
): BenchmarkOutcome {
  if (result.oomKilled) return 'execution-failure'
  if (result.timedOut) return 'execution-failure'
  // Spawn failure: bwrap ENOENT produces exitCode null and an error on stderr.
  if (result.exitCode === null && result.stderr.length > 0) return 'execution-failure'

  // Functional oracle takes precedence when provided (operator-owned).
  if (typeof expectedOutput === 'string') {
    const evalResult = evaluateExpectedOutput(result.stdout, expectedOutput)
    if (!evalResult.ok) {
      // Functional mismatch is a task failure regardless of exit code.
      return 'unsuccessful-outcome'
    }
    // Output matches. If exit code oracle is also set, respect it too.
    if (typeof expectedExitCode === 'number') {
      return result.exitCode === expectedExitCode ? 'task-successful' : 'unsuccessful-outcome'
    }
    // Only functional oracle set — exit code is diagnostic, not gating.
    return result.exitCode !== null ? 'task-successful' : 'task-successful'
  }

  // Exit-code oracle (operator-owned).
  if (typeof expectedExitCode === 'number') {
    return result.exitCode === expectedExitCode ? 'task-successful' : 'unsuccessful-outcome'
  }
  // Legacy fallback: any non-zero exit is application-level failure.
  if (result.exitCode !== 0 && result.exitCode !== null) return 'unsuccessful-outcome'
  return 'task-successful'
}
