/**
 * The evidence chain: live execution must produce PERSISTED evidence, and the
 * deterministic gate must only act on evidence that actually came from
 * execution. Found live: evo_benchmark_live ran the candidate but recorded
 * nothing, so the gate had no live evidence to decide on.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { ModuleDeps } from '../src/host/types.ts'
import type { HostContextShape } from '../src/host/dsh.ts'

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

describe('live benchmark evidence chain', () => {
  let tmpRoot: string
  let store: EvolutionStore
  let deps: ModuleDeps
  const exec = { signal: AbortSignal.timeout(60_000) }

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-evidence-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
    deps = { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: tmpRoot }), store, log: () => {}, warn: () => {} }
  })

  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  async function seedCandidate() {
    await store.createVersion({ label: 'v1', modules: [] })
    return await store.addCandidate({
      parentVersion: 'v1', type: 'policy', name: 'probe', description: 'd', reason: 'r',
      evidenceIds: [], patternIds: [],
      files: [{ path: 'src/index.ts', content: 'export const ok = true' }], tests: [],
      benchmarkConfig: {
        successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
        errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 },
        avgDurationMs: { max: 60000, weight: 0.5 },
      },
      status: 'draft',
    })
  }

  it('a PASSING live run persists live evidence and benchmarks the candidate', async () => {
    const candidate = await seedCandidate()
    const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
    const live = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!

    const result = await live.execute({
      candidateId: candidate.id, command: 'echo CHAIN_OK', timeoutMs: 20_000,
    } as never, exec) as { ok: boolean; passed: boolean; benchmarkRunId: string; evidenceMode: string }

    expect(result.ok).toBe(true)
    expect(result.passed).toBe(true)
    expect(result.evidenceMode).toBe('live')

    const stored = await store.listBenchmarks()
    expect(stored).toHaveLength(1)
    expect(stored[0].mode).toBe('live')
    expect(stored[0].id).toBe(result.benchmarkRunId)
    expect(stored[0].passed).toBe(true)
    expect(stored[0].metrics.successRate).toBe(1)
    expect(stored[0].avgDurationMs ?? stored[0].metrics.avgDurationMs).toBeGreaterThan(0)

    const after = await store.getCandidate(candidate.id)
    expect(after!.status).toBe('benchmarked')
  })

  it('a FAILING live run persists evidence and rejects the candidate', async () => {
    const candidate = await seedCandidate()
    const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
    const live = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!

    const result = await live.execute({
      candidateId: candidate.id, command: 'exit 3', timeoutMs: 20_000,
    } as never, exec) as { ok: boolean; passed: boolean; evidenceMode: string }

    expect(result.ok).toBe(true)
    expect(result.passed).toBe(false)
    expect(result.evidenceMode).toBe('live')

    const after = await store.getCandidate(candidate.id)
    expect(after!.status).toBe('rejected')
  })

  it('a single live run is not enough evidence: the gate refuses on min_runs', async () => {
    const candidate = await seedCandidate()
    const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
    const { promoteTools } = await import('../src/host/modules/promote/tools.ts')

    await benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!
      .execute({ candidateId: candidate.id, command: 'echo ONE_OK', timeoutMs: 20_000 } as never, exec)

    const decision = promoteTools(deps).find(t => t.name === 'evo_promote_decision')!
    const verdict = await decision.execute({ candidateId: candidate.id } as never, exec) as {
      ok: boolean; recommendation: string; evidenceMode: string; rejectionReasons: string[]
    }
    expect(verdict.ok).toBe(true)
    expect(verdict.evidenceMode).toBe('live')
    // One execution is real evidence but not enough of it.
    expect(verdict.recommendation).toBe('REJECT')
    expect(verdict.rejectionReasons.join(' ')).toContain('min_runs')
  })

  it('repeated live A/B evidence drives the deterministic gate to PROMOTE', async () => {
    const candidate = await seedCandidate()
    const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
    const { promoteTools } = await import('../src/host/modules/promote/tools.ts')

    const ab = await benchmarkTools(deps).find(t => t.name === 'evo_benchmark_ab')!
      .execute({ candidateId: candidate.id, command: 'echo GATE_OK', runs: 3, timeoutMs: 20_000 } as never, exec) as { ok: boolean; passed: boolean; evidenceMode: string }
    expect(ab.ok).toBe(true)

    const decision = promoteTools(deps).find(t => t.name === 'evo_promote_decision')!
    const verdict = await decision.execute({ candidateId: candidate.id } as never, exec) as {
      ok: boolean; recommendation: string; evidenceMode: string; checks: Array<{ gate: string; pass: boolean }>
    }
    expect(verdict.ok).toBe(true)
    expect(verdict.evidenceMode).toBe('live')
    expect(verdict.recommendation).toBe('PROMOTE')
    expect(verdict.checks.find(c => c.gate === 'min_runs')!.pass).toBe(true)
  })

  it('A/B persists comparative live evidence with both sides measured', async () => {
    const candidate = await seedCandidate()
    const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
    const ab = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_ab')!

    const result = await ab.execute({
      candidateId: candidate.id, command: 'echo AB_OK', runs: 2, timeoutMs: 20_000,
    } as never, exec) as { ok: boolean; benchmarkRunId: string; evidenceMode: string }

    expect(result.ok).toBe(true)
    expect(result.evidenceMode).toBe('live')

    const stored = await store.listBenchmarks()
    const record = stored.find(r => r.id === result.benchmarkRunId)!
    expect(record.mode).toBe('live')
    expect(record.runs).toBe(2)
    expect(record.baselineMetrics).toBeDefined()
    expect(record.comparison).toBeDefined()
    expect(record.caseResults?.length).toBeGreaterThan(0)
  })

  it('a simulated record is never labelled live', async () => {
    const candidate = await seedCandidate()
    const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
    await store.addExperience({ success: true, score: 0.9, stepCount: 4, durationMs: 5000 })

    await benchmarkTools(deps).find(t => t.name === 'evo_benchmark_run')!
      .execute({ candidateId: candidate.id, runs: 3 } as never, exec)

    const stored = await store.listBenchmarks()
    expect(stored[0].mode).toBe('simulated')
  })
})
