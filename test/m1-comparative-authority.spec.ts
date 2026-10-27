/**
 * M1 — Comparative promotion authority acceptance.
 *
 * Proves every promotion path reuses the single canonical beats_active gate
 * (evaluatePromotionPolicy → runPromotionPolicy) and that a failed
 * comparative evaluation leaves active state unchanged (pointer generation,
 * version record, artifact tree).
 *
 * This file does NOT modify M4, does NOT introduce a second policy, and
 * does NOT change gate ordering — it locks the existing behavior.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { access } from 'node:fs/promises'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import { isoDateTime } from '../src/lib/ids.ts'
import { createLiveProvenance } from '../src/lib/provenance.ts'
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

async function runBenchmark(
  store: EvolutionStore,
  candidateId: string,
  successRate: number,
  mode: 'live' | 'simulated' = 'live',
) {
  const createdAt = isoDateTime(new Date())
  const command = 'node candidate-under-test.js'
  const candidate = await store.getCandidate(candidateId)
  if (!candidate) throw new Error('candidate fixture missing')
  const version = candidate.parentVersion
  await store.addBenchmark({
    candidateId,
    version,
    baseline: 'unknown',
    runs: 10,
    metrics: {
      successRate,
      avgScore: successRate,
      errorRate: 0,
      avgSteps: 0,
      avgDurationMs: 100,
    },
    passed: successRate >= 0.8,
    details: `benchmark rate=${successRate}`,
    createdAt,
    mode,
    ...(mode === 'live' ? {
      command,
      provenance: createLiveProvenance(candidateId, version, command, createdAt),
    } : {}),
  }, createdAt)
  await store.updateCandidate(candidateId, { status: 'benchmarked' })
}

describe('M1 — comparative authority (single canonical gate)', () => {
  it('autonomous candidate beats active → promotion allowed', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-m1-beats-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()

      const v1 = await store.addCandidate({
        parentVersion: 'v0', type: 'policy', name: 'v1', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'x=1\n' }], tests: [],
        benchmarkConfig: {
          successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      await runBenchmark(store, v1.id, 0.95)
      await store.createVersion({ label: 'v1', reason: 'r', promotedFrom: 'v0', modules: [v1.id] })

      const v2 = await store.addCandidate({
        parentVersion: 'v1', type: 'policy', name: 'v2', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'x=2\n' }], tests: [],
        benchmarkConfig: {
          successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      await runBenchmark(store, v2.id, 0.96)

      const deps: ModuleDeps = { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: tmpRoot }), store, log: () => {}, warn: () => {} }
      const res = await runPromotionPolicy(deps, v2, 'm1-beats', 'v2-probe')
      expect(res.ok).toBe(true)
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })

  it('autonomous candidate does not beat active → promotion rejected (beats_active)', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-m1-nobeats-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()

      const v1 = await store.addCandidate({
        parentVersion: 'v0', type: 'policy', name: 'v1', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'x=1\n' }], tests: [],
        benchmarkConfig: {
          successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      await runBenchmark(store, v1.id, 0.95)
      await store.createVersion({ label: 'v1', reason: 'r', promotedFrom: 'v0', modules: [v1.id] })

      const v2 = await store.addCandidate({
        parentVersion: 'v1', type: 'policy', name: 'v2', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'x=2\n' }], tests: [],
        benchmarkConfig: {
          successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      await runBenchmark(store, v2.id, 0.86)

      const deps: ModuleDeps = { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: tmpRoot }), store, log: () => {}, warn: () => {} }
      const res = await runPromotionPolicy(deps, v2, 'm1-nobeats', 'v2-probe')
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toContain('beats_active')
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })

  it('equality/tie with active is rejected (strict greater)', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-m1-tie-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()

      const v1 = await store.addCandidate({
        parentVersion: 'v0', type: 'policy', name: 'v1', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'x=1\n' }], tests: [],
        benchmarkConfig: {
          successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      await runBenchmark(store, v1.id, 0.90)
      await store.createVersion({ label: 'v1', reason: 'r', promotedFrom: 'v0', modules: [v1.id] })

      const v2 = await store.addCandidate({
        parentVersion: 'v1', type: 'policy', name: 'v2', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'x=2\n' }], tests: [],
        benchmarkConfig: {
          successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      await runBenchmark(store, v2.id, 0.90)

      const deps: ModuleDeps = { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: tmpRoot }), store, log: () => {}, warn: () => {} }
      const res = await runPromotionPolicy(deps, v2, 'm1-tie', 'v2-probe')
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toContain('beats_active')
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })

  it('failed autonomous promotion leaves active pointer/version/artifact unchanged', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-m1-nomut-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()

      const v1 = await store.addCandidate({
        parentVersion: 'v0', type: 'policy', name: 'v1', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'x=1\n' }], tests: [],
        benchmarkConfig: {
          successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      await runBenchmark(store, v1.id, 0.95)
      await store.createVersion({ label: 'v1', reason: 'r', promotedFrom: 'v0', modules: [v1.id] })

      const beforePointer = await store.readPointer()
      const beforeActive = await store.getActiveVersion()
      const beforeVersions = await store.listVersions()
      expect(beforePointer).not.toBeNull()
      expect(beforePointer!.generation).toBe(1)
      expect(beforeActive!.id).toBe('v1')
      expect(beforeVersions.length).toBe(1)

      const v2 = await store.addCandidate({
        parentVersion: 'v1', type: 'policy', name: 'v2', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'x=2\n' }], tests: [],
        benchmarkConfig: {
          successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      await runBenchmark(store, v2.id, 0.86)

      const deps: ModuleDeps = { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: tmpRoot }), store, log: () => {}, warn: () => {} }
      const res = await runPromotionPolicy(deps, v2, 'm1-nomut', 'v2-probe')
      expect(res.ok).toBe(false)

      const afterPointer = await store.readPointer()
      const afterActive = await store.getActiveVersion()
      const afterVersions = await store.listVersions()
      expect(afterPointer!.versionId).toBe(beforePointer!.versionId)
      expect(afterPointer!.generation).toBe(beforePointer!.generation)
      expect(afterActive!.id).toBe(beforeActive!.id)
      expect(afterActive!.modules[0]).toBe(v1.id)
      expect(afterVersions.length).toBe(1)
      // No artifact was materialized for the rejected candidate
      const probeManifest = join(tmpRoot, 'versions', 'v2-probe', 'manifest.json')
      const probeExists = await access(probeManifest).then(() => true).catch(() => false)
      expect(probeExists).toBe(false)
      // Candidate stays benchmarked, not promoted
      const v2State = await store.getCandidate(v2.id)
      expect(v2State!.status).toBe('benchmarked')
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })

  it('canonical evo_promote rejects worse candidate via the same gate (no second policy)', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-m1-canonical-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()

      const v1 = await store.addCandidate({
        parentVersion: 'v0', type: 'policy', name: 'v1', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'x=1\n' }], tests: [],
        benchmarkConfig: {
          successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      await runBenchmark(store, v1.id, 0.95)
      await store.createVersion({ label: 'v1', reason: 'r', promotedFrom: 'v0', modules: [v1.id] })

      const v2 = await store.addCandidate({
        parentVersion: 'v1', type: 'policy', name: 'v2', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'x=1\n' }], tests: [],
        benchmarkConfig: {
          successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      await runBenchmark(store, v2.id, 0.86)

      // Verify the advisory decision tool and the enforcing gate agree (single policy)
      const deps: ModuleDeps = { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: tmpRoot }), store, log: () => {}, warn: () => {} }
      const { promoteTools } = await import('../src/host/modules/promote/tools.ts')
      const decision = promoteTools(deps).find(t => t.name === 'evo_promote_decision')!
      const adv = await decision.execute({ candidateId: v2.id } as never, { signal: AbortSignal.timeout(5_000) }) as { recommendation?: string }
      expect(adv.recommendation).toContain('REJECT')

      const enforced = await runPromotionPolicy(deps, v2, 'canonical', 'v2-probe')
      expect(enforced.ok).toBe(false)
      if (!enforced.ok) expect(enforced.error).toContain('beats_active')
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })
})
