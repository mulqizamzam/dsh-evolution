/**
 * CHECK 4: Benchmark oracle semantics and destructive counterexample
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { ModuleDeps, HostContextShape } from '../src/host/types.ts'

function makeCtx(): HostContextShape {
  return {
    tools: { register: () => {} },
    settings: { writable: true, register: () => ({ get: () => ({}) }) },
    agents: { get: () => undefined, roots: () => [] },
    get: () => undefined,
    on: () => () => {},
    effect: () => () => {},
  }
}

describe('CHECK 4: Benchmark oracle semantics', () => {
  it('classifyOutcome: exit 0 = task-successful regardless of stdout', async () => {
    const { classifyOutcome } = await import('../src/host/modules/benchmark/outcome.ts')
    // Empty stdout, exit 0 → task-successful
    expect(classifyOutcome({ exitCode: 0, timedOut: false, oomKilled: false, stdout: '', stderr: '' })).toBe('task-successful')
    // Non-empty stdout, exit 0 → task-successful
    expect(classifyOutcome({ exitCode: 0, timedOut: false, oomKilled: false, stdout: 'HELLO', stderr: '' })).toBe('task-successful')
    // Exit 1 → unsuccessful-outcome
    expect(classifyOutcome({ exitCode: 1, timedOut: false, oomKilled: false, stdout: '', stderr: '' })).toBe('unsuccessful-outcome')
    // Timeout → execution-failure
    expect(classifyOutcome({ exitCode: null, timedOut: true, oomKilled: false, stdout: '', stderr: 'timed out' })).toBe('execution-failure')
  })

  it('destructive candidate passes string-search benchmark', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-check4-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()
      await store.createVersion({ label: 'v1', modules: [] })
      // Create a "useful" candidate (baseline) with a real function
      const baseline = await store.addCandidate({
        parentVersion: 'v1', type: 'policy', name: 'useful-baseline', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'draft',
        files: [{ path: 'src/index.ts', content: 'export function helpfulFunction() { return 42; }\n' }],
        tests: [],
        benchmarkConfig: { successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 }, errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 } },
      })
      // Create a "destructive" candidate that keeps the function NAME but does nothing useful
      const destructive = await store.addCandidate({
        parentVersion: 'v1', type: 'policy', name: 'destructive-candidate', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'draft',
        files: [{ path: 'src/index.ts', content: 'export function helpfulFunction() { return null; /* broken! */ }\n' }],
        tests: [],
        benchmarkConfig: { successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 }, errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 } },
      })
      // Benchmark command: grep for function name
      const command = 'grep -q helpfulFunction src/index.ts && echo OK'
      const deps: ModuleDeps = {
        ctx: makeCtx(),
        cfg: () => resolveConfig({ stateRoot: tmpRoot }),
        store, log: () => {}, warn: () => {},
      }
      const benchTools = (await import('../src/host/modules/benchmark/tools.ts')).benchmarkTools(deps)
      const liveBench = benchTools.find(t => t.name === 'evo_benchmark_live')!
      // Run baseline
      const baselineResult = await liveBench.execute({ candidateId: baseline.id, command, timeoutMs: 10_000 } as never, { signal: AbortSignal.timeout(10_000) }) as { ok: boolean; passed: boolean }
      // Run destructive
      const destructiveResult = await liveBench.execute({ candidateId: destructive.id, command, timeoutMs: 10_000 } as never, { signal: AbortSignal.timeout(10_000) }) as { ok: boolean; passed: boolean }
      // Both pass the same string-search benchmark
      expect(baselineResult.passed).toBe(true)
      expect(destructiveResult.passed).toBe(true)
      // The destructive candidate is objectively worse (returns null instead of 42)
      // but the benchmark cannot distinguish them
      const stored = await store.listBenchmarks()
      expect(stored.length).toBe(2)
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })
})
