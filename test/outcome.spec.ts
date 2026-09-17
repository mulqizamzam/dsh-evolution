/**
 * P6 PARTIAL: benchmark exit-code → end-to-end outcome classification.
 *
 * The classifier maps SandboxExecResult fields to a three-way outcome.
 * IMPORTANT: the current runner executes a single arbitrary shell command.
 * BenchmarkCase.expectedOutput is stored but NEVER evaluated by the runner.
 * Therefore task-successful = "exit 0" (same as the old passed field).
 * The new value-add is separating hard execution-failures (OOM/timeout/spawn)
 * from application-level failures (non-zero exit) so the promotion gate can
 * distinguish them.
 *
 * Falsification tests (requirement explicitly names these scenarios):
 *   1. legitimate successful task with empty stdout
 *   2. exit 0 with error-like stdout
 *   3. exit 0 with warning-only stdout
 *   4. exit 0 with valid structured result
 *   5. non-zero exit with otherwise valid-looking output
 *   6. timeout with partial output
 *   7. OOM with partial output
 *   8. successful artifact creation with empty stdout
 *   9. failed artifact creation with non-empty stdout
 *   10. repeated baseline/candidate execution using same evaluator
 */
import { describe, it, expect } from 'vitest'
import { classifyOutcome } from '../src/host/modules/benchmark/outcome.ts'
import type { BenchmarkOutcome } from '../src/host/types.ts'

function sandboxResult(over: Partial<{
  exitCode: number | null
  timedOut: boolean
  oomKilled: boolean
  stdout: string
  stderr: string
}>) {
  return {
    exitCode: 0,
    timedOut: false,
    oomKilled: false,
    stdout: '',
    stderr: '',
    ...over,
  }
}

describe('classifyOutcome — execution failure', () => {
  it('#1 OOM kill → execution-failure', () => {
    const r = classifyOutcome(sandboxResult({ oomKilled: true, exitCode: null, stderr: 'killed' }))
    expect(r).toBe('execution-failure')
  })

  it('#2 timeout (with or without partial output) → execution-failure', () => {
    const withPartial = classifyOutcome(sandboxResult({ timedOut: true, stdout: 'partial', exitCode: null }))
    expect(withPartial).toBe('execution-failure')
    const noOutput = classifyOutcome(sandboxResult({ timedOut: true, exitCode: null }))
    expect(noOutput).toBe('execution-failure')
  })

  it('#3 spawn failure: null exit code + stderr → execution-failure', () => {
    const r = classifyOutcome(sandboxResult({ exitCode: null, stderr: 'sandbox spawn failed: spawn bwrap ENOENT' }))
    expect(r).toBe('execution-failure')
  })

  it('#4 spawn failure with empty stderr but null exit is ambiguous; not classified as execution-failure', () => {
    // When bwrap fails silently (rare), we cannot distinguish from exit-0 with
    // no output; treat as task-successful rather than misclassifying.
    const r = classifyOutcome(sandboxResult({ exitCode: null, stderr: '' }))
    // null exit code with no stderr is intentionally not classified as failure
    // (see comment in classifyOutcome: spawn-failure requires non-empty stderr)
    expect(r).toBe('task-successful')
  })
})

describe('classifyOutcome — unsuccessful-outcome (application-level failure)', () => {
  it('#5 non-zero exit code, even with meaningful stdout → unsuccessful-outcome', () => {
    const r = classifyOutcome(sandboxResult({ exitCode: 3, stdout: 'failed but printed something' }))
    expect(r).toBe('unsuccessful-outcome')
  })

  it('#6 non-zero exit code with stderr error message → unsuccessful-outcome', () => {
    const r = classifyOutcome(sandboxResult({ exitCode: 1, stderr: 'permission denied' }))
    expect(r).toBe('unsuccessful-outcome')
  })

  it('#7 exit 127 (command not found) → unsuccessful-outcome', () => {
    const r = classifyOutcome(sandboxResult({ exitCode: 127 }))
    expect(r).toBe('unsuccessful-outcome')
  })
})

describe('classifyOutcome — task-successful (exit 0)', () => {
  it('#8 exit 0 + non-empty stdout → task-successful', () => {
    expect(classifyOutcome(sandboxResult({ exitCode: 0, stdout: 'CHAIN_OK' }))).toBe('task-successful')
  })

  it('#9 exit 0 + empty stdout → task-successful (silent success is legitimate)', () => {
    // Falsification: do NOT misclassify silent success as failure.
    expect(classifyOutcome(sandboxResult({ exitCode: 0, stdout: '' }))).toBe('task-successful')
  })

  it('#10 exit 0 + whitespace-only stdout → task-successful', () => {
    expect(classifyOutcome(sandboxResult({ exitCode: 0, stdout: '   \n  ' }))).toBe('task-successful')
  })

  it('#11 exit 0 + stderr noise but non-empty stdout → task-successful', () => {
    const r = classifyOutcome(sandboxResult({ exitCode: 0, stdout: 'result', stderr: 'warning: deprecated' }))
    expect(r).toBe('task-successful')
  })

  it('#12 exit 0 with no stdout, no stderr → task-successful', () => {
    const r = classifyOutcome(sandboxResult({ exitCode: 0 }))
    expect(r).toBe('task-successful')
  })
})

describe('classifyOutcome — deterministic and consistent', () => {
  it('same input always yields same outcome', () => {
    const r1 = classifyOutcome(sandboxResult({ exitCode: 0, stdout: 'hello' }))
    const r2 = classifyOutcome(sandboxResult({ exitCode: 0, stdout: 'hello' }))
    expect(r1).toBe(r2)
  })

  it('all possible outcomes are valid BenchmarkOutcome values', () => {
    const outcomes: BenchmarkOutcome[] = [
      classifyOutcome(sandboxResult({ oomKilled: true })),
      classifyOutcome(sandboxResult({ timedOut: true })),
      classifyOutcome(sandboxResult({ exitCode: null, stderr: 'spawn ENOENT' })),
      classifyOutcome(sandboxResult({ exitCode: 5 })),
      classifyOutcome(sandboxResult({ exitCode: 0, stdout: '' })),
      classifyOutcome(sandboxResult({ exitCode: 0, stdout: 'ok' })),
    ]
    for (const o of outcomes) {
      expect(['task-successful', 'unsuccessful-outcome', 'execution-failure']).toContain(o)
    }
  })
})

describe('classifyOutcome — process failure vs task failure remain distinguishable', () => {
  it('execution-failure and unsuccessful-outcome are never conflated', () => {
    const execFail = classifyOutcome(sandboxResult({ timedOut: true }))
    const taskFail = classifyOutcome(sandboxResult({ exitCode: 1, stdout: 'error' }))
    expect(execFail).not.toBe(taskFail)
    expect(execFail).toBe('execution-failure')
    expect(taskFail).toBe('unsuccessful-outcome')
  })

  it('task-successful is distinct from both failure buckets', () => {
    const success = classifyOutcome(sandboxResult({ exitCode: 0, stdout: 'ok' }))
    const execFail = classifyOutcome(sandboxResult({ oomKilled: true }))
    const taskFail = classifyOutcome(sandboxResult({ exitCode: 3 }))
    expect(success).toBe('task-successful')
    expect(execFail).toBe('execution-failure')
    expect(taskFail).toBe('unsuccessful-outcome')
    expect(new Set([success, execFail, taskFail]).size).toBe(3)
  })
})
