/**
 * CHECK 3: P7 gate semantics - autonomous vs manual paths
 * Trace each tool path and verify gate enforcement.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { ModuleDeps, HostContextShape } from '../src/host/types.ts'
import { runAutoCycle, resetAutoGuards } from '../src/host/modules/auto-experience/index.ts'

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

describe('CHECK 3: P7 gate semantics', () => {
  it('runAutoCycle: minExperiences gate fires before generation gate', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-p7a-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()
      await store.createVersion({ label: 'v1', modules: [] })
      // Only 10 experiences — below default minExperiences=20
      for (let i = 0; i < 10; i++) {
        await store.addExperience({ success: false, errors: ['repeat-fail'], stepCount: 10, prompt: 't-' + i })
      }
      const deps = {
        ctx: makeCtx(),
        cfg: () => resolveConfig({ stateRoot: tmpRoot, evolution: { generation: { enabled: false }, promotion: { enabled: false } } }),
        store, log: () => {}, warn: () => {},
      }
      resetAutoGuards()
      const outcome = await runAutoCycle(deps)
      expect(outcome.ran).toBe(false)
      // Gate fires at minExperiences check first
      expect(outcome.reason).toContain('not enough experiences')
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })

  it('runAutoCycle respects generation.enabled=false when minExperiences is met', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-p7b-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()
      await store.createVersion({ label: 'v1', modules: [] })
      // 25 experiences — above default minExperiences=20
      for (let i = 0; i < 25; i++) {
        await store.addExperience({ success: false, errors: ['repeat-fail'], stepCount: 10, prompt: 't-' + i })
      }
      const deps = {
        ctx: makeCtx(),
        cfg: () => resolveConfig({ stateRoot: tmpRoot, evolution: { generation: { enabled: false }, promotion: { enabled: false } } }),
        store, log: () => {}, warn: () => {},
      }
      resetAutoGuards()
      const outcome = await runAutoCycle(deps)
      expect(outcome.ran).toBe(true) // cycle runs
      // But no candidate should be generated (generation disabled)
      const candidates = await store.listCandidates(100)
      // No new candidates from this cycle
      expect(candidates.length).toBe(0)
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })

  it('evo_promote requires candidate.status === benchmarked (gate exists)', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-p7c-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()
      await store.createVersion({ label: 'v1', modules: [] })
      const candidate = await store.addCandidate({
        parentVersion: 'v1', type: 'policy', name: 'test', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'draft',
        files: [], tests: [],
        benchmarkConfig: { successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 }, errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 } },
      })
      const deps = { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: tmpRoot }), store, log: () => {}, warn: () => {} }
      const promoteTools = (await import('../src/host/modules/promote/tools.ts')).promoteTools(deps)
      const promote = promoteTools.find(t => t.name === 'evo_promote')!
      // Should fail because status is 'draft', not 'benchmarked'
      const result = await promote.execute({ candidateId: candidate.id } as never, { signal: AbortSignal.timeout(5_000) }) as { ok: boolean; error?: string }
      expect(result.ok).toBe(false)
      expect(result.error).toContain('benchmarked')
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })
})
