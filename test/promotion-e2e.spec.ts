import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { seedLiveBenchmark } from './helpers/seed-live-benchmark.ts'

describe('E2E: realistic promotion safety experiment', () => {
  it('worse candidate (0.86) rejected when active is 0.95, better candidate (0.98) accepted, tie (0.95) rejected', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-e2e-probe-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()

      // v1: active version at 0.95
      const v1 = await store.addCandidate({
        parentVersion: 'v0', type: 'policy', name: 'tracker-v1', description: 'correct', reason: 'orig',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'export function f() { return 42; }\n' }],
        tests: [],
        benchmarkConfig: { successRate:{min:0.8,weight:1}, avgScore:{min:0.7,weight:1}, errorRate:{max:0.2,weight:1}, avgSteps:{max:50,weight:0.5}, avgDurationMs:{max:60000,weight:0.5} },
      })
      await seedLiveBenchmark(store, v1.id, 'v0', 'unknown', { successRate: 0.95, avgScore: 0.95, errorRate: 0.02, avgSteps: 5, avgDurationMs: 200 }, { passed: true, details: 'v1', runs: 20 })
      await store.createVersion({ label: 'v1-good', reason: 'release', promotedFrom: 'v0', modules: [v1.id] })

      // v2: regressed to 0.86 — should be REJECTED
      const v2 = await store.addCandidate({
        parentVersion: 'v1', type: 'policy', name: 'tracker-v2', description: 'regr', reason: 'bad',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'export function f() { return null; }\n' }],
        tests: [],
        benchmarkConfig: { successRate:{min:0.8,weight:1}, avgScore:{min:0.7,weight:1}, errorRate:{max:0.2,weight:1}, avgSteps:{max:50,weight:0.5}, avgDurationMs:{max:60000,weight:0.5} },
      })
      await seedLiveBenchmark(store, v2.id, 'v1', 'unknown', { successRate: 0.86, avgScore: 0.86, errorRate: 0.08, avgSteps: 5, avgDurationMs: 210 }, { passed: true, details: 'v2', runs: 20 })

      // v3: improved to 0.98 — should be ACCEPTED
      const v3 = await store.addCandidate({
        parentVersion: 'v2', type: 'policy', name: 'tracker-v3', description: 'better', reason: 'good',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'export function f() { return 99; }\n' }],
        tests: [],
        benchmarkConfig: { successRate:{min:0.8,weight:1}, avgScore:{min:0.7,weight:1}, errorRate:{max:0.2,weight:1}, avgSteps:{max:50,weight:0.5}, avgDurationMs:{max:60000,weight:0.5} },
      })
      await seedLiveBenchmark(store, v3.id, 'v2', 'unknown', { successRate: 0.98, avgScore: 0.98, errorRate: 0.01, avgSteps: 4, avgDurationMs: 190 }, { passed: true, details: 'v3', runs: 20 })

      // v4: tie at 0.95 — should be REJECTED
      const v4 = await store.addCandidate({
        parentVersion: 'v3', type: 'policy', name: 'tracker-v4', description: 'tie', reason: 'same',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'export function f() { return 42; }\n' }],
        tests: [],
        benchmarkConfig: { successRate:{min:0.8,weight:1}, avgScore:{min:0.7,weight:1}, errorRate:{max:0.2,weight:1}, avgSteps:{max:50,weight:0.5}, avgDurationMs:{max:60000,weight:0.5} },
      })
      await seedLiveBenchmark(store, v4.id, 'v3', 'unknown', { successRate: 0.95, avgScore: 0.95, errorRate: 0.02, avgSteps: 5, avgDurationMs: 200 }, { passed: true, details: 'v4', runs: 20 })

      const deps = {
        ctx: { tools:{register:()=>{}}, settings:{writable:true,register:()=>({get:()=>({})})}, agents:{get:()=>undefined,roots:()=>[]}, get:()=>undefined, on:()=>()=>{}, effect:()=>()=>{} },
        cfg: () => ({ stateRoot: tmpRoot, benchmark: { minRuns: 3, maxRuns: 20 }, evolution: {} }),
        store, log: () => {}, warn: () => {}
      }
      const promoteTools = (await import('../src/host/modules/promote/tools.ts')).promoteTools(deps)
      const decisionTool = promoteTools.find(t => t.name === 'evo_promote_decision')!

      // v2 (0.86 < active 0.95) → REJECT
      const d2 = await decisionTool.execute({ candidateId: v2.id } as never, { signal: AbortSignal.timeout(5_000) }) as { recommendation?: string; checks?: Array<{ gate: string; pass: boolean }> }
      expect(d2.recommendation).toContain('REJECT')
      const g2 = d2.checks?.find(c => c.gate === 'beats_active')
      expect(g2).toBeDefined()
      expect(g2!.pass).toBe(false)

      // v3 (0.98 > active 0.95) → PROMOTE
      const d3 = await decisionTool.execute({ candidateId: v3.id } as never, { signal: AbortSignal.timeout(5_000) }) as { recommendation?: string; checks?: Array<{ gate: string; pass: boolean }> }
      expect(d3.recommendation).toContain('PROMOTE')
      const g3 = d3.checks?.find(c => c.gate === 'beats_active')
      expect(g3).toBeDefined()
      expect(g3!.pass).toBe(true)

      // v4 (0.95 == active 0.95) → REJECT (tie fails strict >)
      const d4 = await decisionTool.execute({ candidateId: v4.id } as never, { signal: AbortSignal.timeout(5_000) }) as { recommendation?: string }
      expect(d4.recommendation).toContain('REJECT')

      // Inspect persisted state
      const versions = await store.listVersions()
      expect(versions.length).toBe(1)
      expect(versions[0].status).toBe('active')
      expect(versions[0].modules[0]).toBe(v1.id)

      const benchmarks = await store.listBenchmarks(500)
      expect(benchmarks.filter(b => b.candidateId === v1.id).length).toBe(1)
      expect(benchmarks.filter(b => b.candidateId === v2.id).length).toBe(1)
      expect(benchmarks.filter(b => b.candidateId === v3.id).length).toBe(1)
      expect(benchmarks.filter(b => b.candidateId === v4.id).length).toBe(1)
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })
})
