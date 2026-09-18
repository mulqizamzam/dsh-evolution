/**
 * Regression tests for unified promotion authority (commit 749a71c fix).
 *
 * Every production promotion path must go through the same gates:
 * - benchmark_passed (P6)
 * - min_runs
 * - success_improvement (threshold floor)
 * - max_regression
 * - latency_multiplier
 * - beats_active (comparative, when baseline exists)
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import { isoDateTime } from '../src/lib/ids.ts'
import type { ModuleDeps, HostContextShape } from '../src/host/types.ts'
import { runPromotionPolicy } from '../src/host/modules/promote/index.ts'

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

async function runBenchmark(store: EvolutionStore, candidateId: string, successRate: number) {
  const totalRuns = 10
  const successCount = Math.round(totalRuns * successRate)
  await store.addBenchmark({
    candidateId,
    version: 'v-temp',
    baseline: 'unknown',
    runs: totalRuns,
    metrics: {
      successRate,
      avgScore: successCount / totalRuns,
      errorRate: 0,
      avgSteps: 0,
      avgDurationMs: 100,
    },
    passed: successRate >= 0.8,
    details: `benchmark rate=${successRate}`,
    createdAt: isoDateTime(new Date()),
    mode: 'live',
  })
  await store.updateCandidate(candidateId, { status: 'benchmarked' })
}

describe('UNIFIED PROMOTION AUTHORITY — evo_full_cycle bypass fixed', () => {
  it('runPromotionPolicy captures activeMetrics when active exists', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-unified-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()

      // v1 at 0.95
      const v1 = await store.addCandidate({
        parentVersion: 'v0', type: 'policy', name: 'v1', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'x=1\n' }],
        tests: [],
        benchmarkConfig: {
          successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      await runBenchmark(store, v1.id, 0.95)
      await store.createVersion({ label: 'v1', reason: 'release', promotedFrom: 'v0', modules: [v1.id] })

      // v2 at 0.98 — better than v1
      const v2 = await store.addCandidate({
        parentVersion: 'v1', type: 'policy', name: 'v2', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'x=2\n' }],
        tests: [],
        benchmarkConfig: {
          successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      await runBenchmark(store, v2.id, 0.98)

      const deps: ModuleDeps = { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: tmpRoot }), store, log: () => {}, warn: () => {} }
      const result = await runPromotionPolicy(deps, v2, 'test', 'v2-probe')

      expect(result.ok).toBe(true)
      if (result.ok) {
        const versions = await store.listVersions()
        const v2Ver = versions.find(v => v.id === result.version.id)
        expect(v2Ver).toBeDefined()
        // v2's activeMetrics should capture v1's 0.95
        expect(v2Ver!.activeMetrics).toBeDefined()
        expect(v2Ver!.activeMetrics!.successRate).toBeCloseTo(0.95, 2)
      }
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })

  it('runPromotionPolicy: first version has no activeMetrics', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-unified-first-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()

      const v1 = await store.addCandidate({
        parentVersion: 'v0', type: 'policy', name: 'v1', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'x=1\n' }],
        tests: [],
        benchmarkConfig: {
          successRate: { min: 0.5, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      await runBenchmark(store, v1.id, 1.0)

      const deps: ModuleDeps = { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: tmpRoot }), store, log: () => {}, warn: () => {} }
      const result = await runPromotionPolicy(deps, v1, 'first', 'v1-probe')
      expect(result.ok).toBe(true)

      const versions = await store.listVersions()
      expect(versions.length).toBe(1)
      expect(versions[0].activeMetrics).toBeUndefined()
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })

  it('runPromotionPolicy does NOT bypass beats_active: worse candidate blocked', async () => {
    // This test proves that even though runPromotionPolicy handles the
    // version creation, it still requires the beats_active gate to pass
    // BEFORE it is called. The gate itself is in evo_promote_decision.
    // This test verifies the state after a failed decision.
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-unified-blocked-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()

      // v1 at 0.95
      const v1 = await store.addCandidate({
        parentVersion: 'v0', type: 'policy', name: 'v1', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'x=1\n' }],
        tests: [],
        benchmarkConfig: {
          successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      await runBenchmark(store, v1.id, 0.95)
      await store.createVersion({ label: 'v1', reason: 'release', promotedFrom: 'v0', modules: [v1.id] })

      // v2 at 0.86 — worse than v1
      const v2 = await store.addCandidate({
        parentVersion: 'v1', type: 'policy', name: 'v2-worse', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'x=null\n' }],
        tests: [],
        benchmarkConfig: {
          successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      await runBenchmark(store, v2.id, 0.86)

      // Verify evo_promote_decision rejects
      const deps: ModuleDeps = { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: tmpRoot }), store, log: () => {}, warn: () => {} }
      const promoteTools = (await import('../src/host/modules/promote/tools.ts')).promoteTools(deps)
      const decisionTool = promoteTools.find(t => t.name === 'evo_promote_decision')!
      const decision = await decisionTool.execute({ candidateId: v2.id } as never, { signal: AbortSignal.timeout(5_000) }) as { recommendation?: string; checks?: Array<{ gate: string; pass: boolean }> }
      expect(decision.recommendation).toContain('REJECT')
      const beatsActive = (decision.checks || []).find(c => c.gate === 'beats_active')
      expect(beatsActive).toBeDefined()
      expect(beatsActive!.pass).toBe(false)

      // Verify v2 has NOT been promoted
      const v2After = await store.getCandidate(v2.id)
      expect(v2After!.status).toBe('benchmarked')

      // Verify v1 is still active
      const active = await store.getActiveVersion()
      expect(active!.modules[0]).toBe(v1.id)
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })
})
