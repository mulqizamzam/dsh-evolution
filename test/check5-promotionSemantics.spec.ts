/**
 * CHECK 5: Promotion-vs-baseline semantics
 *
 * Verifies that promotion compares candidate against the active version's
 * actual benchmarked performance (monotonicity gate), not just a static
 * threshold floor.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import { seedLiveBenchmark } from './helpers/seed-live-benchmark.ts'
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

async function runBenchmark(store: EvolutionStore, candidateId: string, successRate: number) {
  const totalRuns = 10
  const successCount = Math.round(totalRuns * successRate)
  const candidate = await store.getCandidate(candidateId)
  if (!candidate) throw new Error('candidate fixture missing')
  const version = candidate.parentVersion
  await seedLiveBenchmark(store, candidateId, version, 'unknown', {
    successRate,
    avgScore: successCount / totalRuns,
    errorRate: 0,
    avgSteps: 0,
    avgDurationMs: 100,
  }, {
    passed: successRate >= 0.8,
    details: `live benchmark rate=${successRate}`,
    runs: totalRuns,
  })
  // Mark candidate as benchmarked (evo_promote requires this status)
  await store.updateCandidate(candidateId, { status: 'benchmarked' })
}

describe('CHECK 5: Promotion vs baseline semantics', () => {
  it('default policy constants are unchanged', async () => {
    const { DEFAULT_PROMOTION_POLICY } = await import('../src/host/types.ts')
    expect(DEFAULT_PROMOTION_POLICY.minSuccessImprovement).toBe(0.05)
    expect(DEFAULT_PROMOTION_POLICY.maxRegression).toBe(-0.05)
  })

  it('first version (no active) is still judged against threshold floor only', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-check5-first-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()

      const candidate = await store.addCandidate({
        parentVersion: 'v0', type: 'policy', name: 'first', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'draft',
        files: [{ path: 'src/index.ts', content: 'export const x = 1\n' }],
        tests: [],
        benchmarkConfig: {
          successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      const deps: ModuleDeps = { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: tmpRoot }), store, log: () => {}, warn: () => {} }
      await runBenchmark(store, candidate.id, 1.0)

      const promoteDecision = (await import('../src/host/modules/promote/tools.ts')).promoteTools(deps).find(t => t.name === 'evo_promote_decision')!
      const decision = await promoteDecision.execute({ candidateId: candidate.id } as never, { signal: AbortSignal.timeout(5_000) }) as { ok: boolean; recommendation?: string; checks?: Array<{ gate: string; pass: boolean }> }
      // First version: no activeMetrics → beats_active gate absent → threshold-only applies.
      expect(decision.recommendation).toContain('PROMOTE')
      const beatsActiveGate = (decision.checks || []).find(c => c.gate === 'beats_active')
      expect(beatsActiveGate).toBeUndefined()
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })

  it('candidate worse than active version is rejected (falsification)', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-check5-worse-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()

      // v1: high performer (0.95)
      const v1Candidate = await store.addCandidate({
        parentVersion: 'v0', type: 'policy', name: 'v1-good', description: 'good', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'draft',
        files: [{ path: 'src/index.ts', content: 'export const x = 1\n' }],
        tests: [],
        benchmarkConfig: {
          successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      const deps: ModuleDeps = { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: tmpRoot }), store, log: () => {}, warn: () => {} }
      await runBenchmark(store, v1Candidate.id, 0.95)

      // Manually create v1 version (bypassing evo_promote which needs sandbox pre-flight)
      const v1Version = await store.createVersion({
        label: 'v1-good',
        reason: 'first promotion',
        promotedFrom: 'v0',
        modules: [v1Candidate.id],
      })
      const av = await store.getActiveVersion()
      expect(av?.id).toBe(v1Version.id)
      expect(av?.modules[0]).toBe(v1Candidate.id)

      // v2: regressed to 0.86 — above threshold 0.8 but BELOW v1's 0.95
      const v2Candidate = await store.addCandidate({
        parentVersion: 'v1', type: 'policy', name: 'v2-regressed', description: 'regr', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'draft',
        files: [{ path: 'src/index.ts', content: 'export const x = null\n' }],
        tests: [],
        benchmarkConfig: {
          successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      await runBenchmark(store, v2Candidate.id, 0.86)

      const decisionTool = (await import('../src/host/modules/promote/tools.ts')).promoteTools(deps).find(t => t.name === 'evo_promote_decision')!
      const decision = await decisionTool.execute({ candidateId: v2Candidate.id } as never, { signal: AbortSignal.timeout(5_000) }) as { ok: boolean; recommendation?: string; checks?: Array<{ gate: string; pass: boolean }> }
      // Counterexample: 0.86 > 0.80 floor but 0.86 < 0.95 active → REJECT via beats_active
      expect(decision.recommendation).toContain('REJECT')
      const beatsActive = (decision.checks || []).find(c => c.gate === 'beats_active')
      expect(beatsActive).toBeDefined()
      expect(beatsActive!.pass).toBe(false)
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })

  it('candidate better than active version is accepted', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-check5-better-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()

      // v1: moderate (0.80)
      const v1Candidate = await store.addCandidate({
        parentVersion: 'v0', type: 'policy', name: 'v1-mid', description: 'mid', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'draft',
        files: [{ path: 'src/index.ts', content: 'export const x = 1\n' }],
        tests: [],
        benchmarkConfig: {
          successRate: { min: 0.5, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      const deps: ModuleDeps = { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: tmpRoot }), store, log: () => {}, warn: () => {} }
      await runBenchmark(store, v1Candidate.id, 0.80)

      // Manually create v1
      await store.createVersion({ label: 'v1-mid', reason: 'first', promotedFrom: 'v0', modules: [v1Candidate.id] })

      // v2: improved (0.95) — above v1's 0.80
      const v2Candidate = await store.addCandidate({
        parentVersion: 'v1', type: 'policy', name: 'v2-better', description: 'better', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'draft',
        files: [{ path: 'src/index.ts', content: 'export const x = 42\n' }],
        tests: [],
        benchmarkConfig: {
          successRate: { min: 0.5, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      await runBenchmark(store, v2Candidate.id, 0.95)

      const decisionTool = (await import('../src/host/modules/promote/tools.ts')).promoteTools(deps).find(t => t.name === 'evo_promote_decision')!
      const decision = await decisionTool.execute({ candidateId: v2Candidate.id } as never, { signal: AbortSignal.timeout(5_000) }) as { ok: boolean; recommendation?: string; checks?: Array<{ gate: string; pass: boolean }> }
      expect(decision.recommendation).toContain('PROMOTE')
      const beatsActive = (decision.checks || []).find(c => c.gate === 'beats_active')
      expect(beatsActive).toBeDefined()
      expect(beatsActive!.pass).toBe(true)
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })

  it('tie with active version is rejected (monotonicity)', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-check5-tie-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()

      // v1: 0.90
      const v1Candidate = await store.addCandidate({
        parentVersion: 'v0', type: 'policy', name: 'v1', description: 'v1', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'draft',
        files: [{ path: 'src/index.ts', content: 'export const x = 1\n' }],
        tests: [],
        benchmarkConfig: {
          successRate: { min: 0.5, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      const deps: ModuleDeps = { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: tmpRoot }), store, log: () => {}, warn: () => {} }
      await runBenchmark(store, v1Candidate.id, 0.90)

      // Manually create v1
      await store.createVersion({ label: 'v1', reason: 'first', promotedFrom: 'v0', modules: [v1Candidate.id] })

      // v2: same 0.90 → tie → reject (strictly greater required)
      const v2Candidate = await store.addCandidate({
        parentVersion: 'v1', type: 'policy', name: 'v2-tie', description: 'tie', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'draft',
        files: [{ path: 'src/index.ts', content: 'export const x = 1\n' }],
        tests: [],
        benchmarkConfig: {
          successRate: { min: 0.5, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      await runBenchmark(store, v2Candidate.id, 0.90)

      const decisionTool = (await import('../src/host/modules/promote/tools.ts')).promoteTools(deps).find(t => t.name === 'evo_promote_decision')!
      const decision = await decisionTool.execute({ candidateId: v2Candidate.id } as never, { signal: AbortSignal.timeout(5_000) }) as { ok: boolean; recommendation?: string }
      // 0.90 is NOT > 0.90 → beats_active fails → REJECT
      expect(decision.recommendation).toContain('REJECT')
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })
})
