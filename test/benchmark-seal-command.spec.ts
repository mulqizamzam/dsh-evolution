/**
 * Regression: the live benchmark tool sealed the RAW command while the store
 * persisted clampText(command, 500). verifyLiveProvenance() re-derives the
 * seal from the PERSISTED record, so any benchmark whose command exceeded 500
 * characters could never be promoted: the promotion gate rejected genuine,
 * internally consistent live evidence with "provenance consistency mismatch",
 * and re-running the benchmark reproduced the same mismatch forever.
 *
 * Drives the real evo_benchmark_live tool and the real promotion policy — the
 * same code path the defect lived on, not a hand-built record.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import { isoDateTime } from '../src/lib/ids.ts'
import { createLiveProvenance, verifyLiveProvenance } from '../src/lib/provenance.ts'
import { clampText } from '../src/lib/caps.ts'
import type { ModuleDeps, HostContextShape, CandidateModule } from '../src/host/types.ts'
import { evaluatePromotionPolicy } from '../src/host/modules/promote/index.ts'
import { benchmarkTools } from '../src/host/modules/benchmark/tools.ts'

function makeCtx(): HostContextShape {
  return {
    tools: { register: () => {} },
    settings: { writable: true, register: () => ({ get: () => ({}) }) },
    agents: { get: () => undefined, roots: () => [] },
    get: () => undefined,
    on: () => () => {},
    effect: () => () => {},
  } as unknown as HostContextShape
}

function makeDeps(store: EvolutionStore, root: string): ModuleDeps {
  return { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: root }), store, log: () => {}, warn: () => {} }
}

async function seedCandidate(store: EvolutionStore, name: string, parentVersion: string): Promise<CandidateModule> {
  return store.addCandidate({
    parentVersion, type: 'policy', name, description: 'd', reason: 'r',
    evidenceIds: [], patternIds: [], status: 'benchmarked',
    files: [{ path: 'src/index.ts', content: 'x = 1\n' }],
    tests: [],
    benchmarkConfig: {
      successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
      errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 },
      avgDurationMs: { max: 60000, weight: 0.5 },
    },
  })
}

describe('evo_benchmark_live seals the command it persists', () => {
  it('a live run with a >500-char command stays verifiable and promotable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evo-seal-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()
      const deps = makeDeps(store, root)

      // Active baseline v1 with a sealed live record at 0.95.
      const v1 = await seedCandidate(store, 'v1', 'v0')
      const baselineCreatedAt = isoDateTime(new Date())
      await store.addBenchmark({
        candidateId: v1.id, version: 'v-temp', baseline: 'unknown', runs: 5,
        metrics: { successRate: 0.95, avgScore: 0.95, errorRate: 0.05, avgSteps: 0, avgDurationMs: 200 },
        passed: true, details: 'live sandbox execution: exit 0', mode: 'live', command: 'node test.js',
        provenance: createLiveProvenance(v1.id, 'v-temp', 'node test.js', baselineCreatedAt),
      }, baselineCreatedAt)
      await store.createVersion({ label: 'v1', reason: 'release', promotedFrom: 'v0', modules: [v1.id] })

      const v2 = await seedCandidate(store, 'v2', 'v1')
      const rawCommand = 'echo seal-ok #' + 'x'.repeat(600)
      expect(rawCommand.length).toBeGreaterThan(500)

      const live = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!
      const res = await live.execute(
        { candidateId: v2.id, command: rawCommand, expectedExitCode: 0, timeoutMs: 20000 } as never,
        { signal: AbortSignal.timeout(30000) },
      ) as Record<string, unknown>
      expect(res.ok).toBe(true)
      expect(res.outcome).toBe('task-successful')

      // The record IS clamped on disk — that is unchanged behaviour.
      const record = (await store.listBenchmarks(50)).find(b => b.candidateId === v2.id)!
      expect(record.command).toBe(clampText(rawCommand, 500))
      expect(record.command!.length).toBe(500)

      // But the seal must be computed over exactly what was persisted, so the
      // promotion boundary can re-derive it.
      expect(record.provenance).toBe(
        createLiveProvenance(record.candidateId, record.version, record.command, record.createdAt),
      )
      expect(verifyLiveProvenance(record)).toBe(true)

      // Therefore the promotion gate must accept a strictly better candidate.
      const policy = await evaluatePromotionPolicy(deps, (await store.getCandidate(v2.id))!)
      expect(policy.ok).toBe(true)
      if (policy.ok) expect(policy.activeMetrics).toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})
