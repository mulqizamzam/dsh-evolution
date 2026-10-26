/**
 * Regression: the promotion policy read the active baseline through
 * store.listBenchmarks(500), a newest-N-by-mtime window. Once a state root
 * accumulated more benchmark files than the window, the active module's own
 * record fell outside it, `capturedActiveMetrics` became undefined, and BOTH
 * the comparative beats_active gate and the provenance-seal check — which are
 * nested behind that same condition — silently switched off. A strictly worse
 * candidate, or a candidate whose live record carried no seal, was then
 * accepted with no warning at all. The gate could not tell "no baseline
 * exists" apart from "the baseline is older than the window".
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import { isoDateTime } from '../src/lib/ids.ts'
import { createLiveProvenance } from '../src/lib/provenance.ts'
import type { ModuleDeps, HostContextShape, CandidateModule, BenchmarkRun } from '../src/host/types.ts'
import { evaluatePromotionPolicy } from '../src/host/modules/promote/index.ts'

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

async function addLive(
  store: EvolutionStore,
  candidateId: string,
  successRate: number,
  opts: { sealed: boolean },
): Promise<BenchmarkRun> {
  const createdAt = isoDateTime(new Date())
  const command = 'node test.js'
  const candidate = await store.getCandidate(candidateId)
  if (!candidate) throw new Error('candidate fixture missing')
  const version = candidate.parentVersion
  return store.addBenchmark({
    candidateId, version, baseline: version, parentVersion: version, runs: 5,
    metrics: { successRate, avgScore: successRate, errorRate: 1 - successRate, avgSteps: 0, avgDurationMs: 200 },
    passed: successRate >= 0.8, details: 'live sandbox execution: exit 0', mode: 'live', command,
    ...(opts.sealed ? { provenance: createLiveProvenance(candidateId, version, command, createdAt) } : {}),
  }, createdAt)
}

/** Push the baseline record out of listBenchmarks(500), which slices by count. */
async function pushBaselineOutOfWindow(store: EvolutionStore, record: BenchmarkRun, fillers: number): Promise<void> {
  for (let i = 0; i < fillers; i++) {
    await store.addBenchmark({
      candidateId: 'filler-' + i, version: 'v-filler', baseline: 'unknown', runs: 1,
      metrics: { successRate: 0, avgScore: 0, errorRate: 1, avgSteps: 0, avgDurationMs: 1 },
      passed: false, details: 'filler ' + i, mode: 'simulated',
    })
  }
  // Precondition: the windowed list must no longer see the baseline record,
  // while the record itself is still on disk.
  const inWindow = (await store.listBenchmarks(500)).some(b => b.id === record.id)
  expect(inWindow).toBe(false)
  const onDisk = (await store.listBenchmarks(10000)).some(b => b.id === record.id)
  expect(onDisk).toBe(true)
}

describe('promotion gates do not depend on the benchmark list window', () => {
  it('still rejects a strictly worse candidate when the baseline record is outside the window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evo-window-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()
      const deps = makeDeps(store, root)

      const v1 = await seedCandidate(store, 'v1', 'v0')
      const activeRec = await addLive(store, v1.id, 0.95, { sealed: true })
      await store.createVersion({ label: 'v1', reason: 'release', promotedFrom: 'v0', modules: [v1.id] })

      const v2 = await seedCandidate(store, 'v2', 'v1')
      await addLive(store, v2.id, 0.60, { sealed: true })

      // Control: with the baseline inside the window the gate rejects.
      const control = await evaluatePromotionPolicy(deps, (await store.getCandidate(v2.id))!)
      expect(control.ok).toBe(false)
      if (!control.ok) expect(control.error).toMatch(/beats_active/)

      await pushBaselineOutOfWindow(store, activeRec, 520)

      // The baseline is still on disk and still sealed — the gate must apply.
      const policy = await evaluatePromotionPolicy(deps, (await store.getCandidate(v2.id))!)
      expect(policy.ok).toBe(false)
      if (!policy.ok) expect(policy.error).toMatch(/beats_active/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('still rejects an unsealed live record when the sealed baseline is outside the window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evo-window-seal-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()
      const deps = makeDeps(store, root)

      const v1 = await seedCandidate(store, 'v1', 'v0')
      const activeRec = await addLive(store, v1.id, 0.95, { sealed: true })
      await store.createVersion({ label: 'v1', reason: 'release', promotedFrom: 'v0', modules: [v1.id] })

      const v2 = await seedCandidate(store, 'v2', 'v1')
      await addLive(store, v2.id, 0.99, { sealed: false })

      const control = await evaluatePromotionPolicy(deps, (await store.getCandidate(v2.id))!)
      expect(control.ok).toBe(false)
      if (!control.ok) expect(control.error).toMatch(/provenance.*seal|INCONCLUSIVE/)

      await pushBaselineOutOfWindow(store, activeRec, 520)

      const policy = await evaluatePromotionPolicy(deps, (await store.getCandidate(v2.id))!)
      expect(policy.ok).toBe(false)
      if (!policy.ok) expect(policy.error).toMatch(/provenance seal missing/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
