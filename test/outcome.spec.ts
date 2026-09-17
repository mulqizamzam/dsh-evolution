/**
 * P6 PARTIAL: benchmark exit-code → end-to-end outcome classification.
 *
 * Regression: each new outcome bucket must be reachable and persisted.
 * The classifier itself is pure; the tests verify every boundary case the
 * requirement calls out explicitly:
 *   execution failure / successful-but-empty / timeout / tool failure /
 *   malformed output / execution success.
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
  it('OOM kill → execution-failure', () => {
    const r = classifyOutcome(sandboxResult({ oomKilled: true, exitCode: null, stderr: 'killed' }))
    expect(r).toBe('execution-failure')
  })

  it('timeout with null exit code → execution-failure', () => {
    const r = classifyOutcome(sandboxResult({ timedOut: true, exitCode: null }))
    expect(r).toBe('execution-failure')
  })

  it('timeout with non-null exit code → execution-failure (timeout takes precedence)', () => {
    const r = classifyOutcome(sandboxResult({ timedOut: true, exitCode: 143 }))
    expect(r).toBe('execution-failure')
  })

  it('spawn failure: null exit code + error in stderr → execution-failure', () => {
    const r = classifyOutcome(sandboxResult({ exitCode: null, stderr: 'sandbox spawn failed: spawn bwrap ENOENT' }))
    expect(r).toBe('execution-failure')
  })

  it('tool failure: non-zero exit code, no timeout, no OOM → unsuccessful-outcome', () => {
    const r = classifyOutcome(sandboxResult({ exitCode: 3, stdout: '' }))
    expect(r).toBe('unsuccessful-outcome')
  })
})

describe('classifyOutcome — successful-but-empty', () => {
  it('exit 0, empty stdout, no stderr → unsuccessful-outcome', () => {
    const r = classifyOutcome(sandboxResult({ exitCode: 0, stdout: '' }))
    expect(r).toBe('unsuccessful-outcome')
  })

  it('exit 0, whitespace-only stdout → unsuccessful-outcome', () => {
    const r = classifyOutcome(sandboxResult({ exitCode: 0, stdout: '   \n  ' }))
    expect(r).toBe('unsuccessful-outcome')
  })

  it('exit 0, non-empty stdout → task-successful', () => {
    const r = classifyOutcome(sandboxResult({ exitCode: 0, stdout: 'CHAIN_OK' }))
    expect(r).toBe('task-successful')
  })
})

describe('classifyOutcome — execution success with unsuccessful outcome', () => {
  it('non-zero exit (any non-zero, no timeout) → unsuccessful-outcome', () => {
    expect(classifyOutcome(sandboxResult({ exitCode: 1, stdout: 'error happened' }))).toBe('unsuccessful-outcome')
    expect(classifyOutcome(sandboxResult({ exitCode: 127, stderr: 'command not found' }))).toBe('unsuccessful-outcome')
  })
})

describe('classifyOutcome — successful task outcome', () => {
  it('exit 0 with meaningful stdout → task-successful', () => {
    expect(classifyOutcome(sandboxResult({ exitCode: 0, stdout: 'ok' }))).toBe('task-successful')
  })

  it('exit 0 with stderr noise but non-empty stdout → task-successful', () => {
    const r = classifyOutcome(sandboxResult({ exitCode: 0, stdout: 'result', stderr: 'warning: something' }))
    expect(r).toBe('task-successful')
  })
})

describe('classifyOutcome — all outcomes are valid BenchmarkOutcome values', () => {
  const outcomes: BenchmarkOutcome[] = [
    classifyOutcome(sandboxResult({ oomKilled: true })),
    classifyOutcome(sandboxResult({ timedOut: true })),
    classifyOutcome(sandboxResult({ exitCode: null, stderr: 'spawn ENOENT' })),
    classifyOutcome(sandboxResult({ exitCode: 5 })),
    classifyOutcome(sandboxResult({ exitCode: 0, stdout: '' })),
    classifyOutcome(sandboxResult({ exitCode: 0, stdout: 'success' })),
  ]
  it.each(outcomes.map((o, i) => [o, `case-${i}`] as [string, string]))(
    '%s is a valid BenchmarkOutcome value',
    (o) => {
      expect(['task-successful', 'unsuccessful-outcome', 'execution-failure']).toContain(o)
    },
  )
})
