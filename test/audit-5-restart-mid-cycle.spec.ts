import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { ModuleDeps } from '../src/host/types.ts'
import type { HostContextShape } from '../src/host/dsh.ts'
import { runAutoCycle, resetAutoGuards, autoGuardState } from '../src/host/modules/auto-experience/index.ts'
import { seedExperiencesForVersion } from './helpers/seed-experiences.ts'

function makeCtx(): HostContextShape { return { tools: { register: () => {} }, settings: { writable: true, register: () => ({ get: () => ({}) }) }, agents: { get: () => undefined, roots: () => [] }, get: () => undefined, on: () => () => {}, effect: () => () => {} } }
function makeDeps(store: EvolutionStore, root: string, overrides?: Record<string, unknown>): ModuleDeps { return { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: root, ...overrides }), store, log: () => {}, warn: () => {} } }

const OVERRIDE_EVO = {
  evolution: {
    enabled: true, autoTrigger: true, autoRecord: true,
    analysis: { minExperiences: 5, minOccurrences: 2 },
    generation: { enabled: false },
    promotion: { enabled: false },
    maxCyclesPerProcess: 10,
  },
}

describe('Audit 5: Restart mid-cycle recovery', () => {
  let tmpRoot: string, store: EvolutionStore
  beforeEach(async () => { tmpRoot = await mkdtemp(join(tmpdir(), 'evo-audit5-')); store = new EvolutionStore({ fallbackRoot: tmpRoot }); await store.init() })
  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  it('fresh store after crash: guards reset, can run new cycle', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2-degraded', modules: [] })
    await seedExperiencesForVersion(store, v2.id, { successes: 0, failures: 10, errors: ['crash-test'] })
    resetAutoGuards()
    const deps1 = makeDeps(store, tmpRoot, OVERRIDE_EVO)
    const o1 = await runAutoCycle(deps1)
    expect(o1.ran).toBe(true)
    expect(autoGuardState().inFlight).toBe(false)
    // Simulate crash: new store instance, guards are module-level
    const crashStore = new EvolutionStore({ fallbackRoot: tmpRoot })
    await crashStore.init()
    resetAutoGuards()
    const deps2 = makeDeps(crashStore, tmpRoot, OVERRIDE_EVO)
    const o2 = await runAutoCycle(deps2)
    expect(o2.ran).toBe(true)
    expect(autoGuardState().inFlight).toBe(false)
  })

  it('cycle cap is per-process, not persisted', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })
    for (let i = 0; i < 25; i++) await store.addExperience({ success: false, errors: ['cap-test-' + (i % 5)], stepCount: 15, versionId: 'v2', prompt: 'task-' + i })
    const depsCap = makeDeps(store, tmpRoot, {
      ...OVERRIDE_EVO,
      evolution: { ...OVERRIDE_EVO.evolution, maxCyclesPerProcess: 3 },
    })
    resetAutoGuards()
    let count = 0
    for (let i = 0; i < 3; i++) { const o = await runAutoCycle(depsCap); if (o.ran) count++ }
    expect(count).toBeGreaterThanOrEqual(1)
    // Guard state persists across cycle calls in same process
    const prevRuns = autoGuardState().cyclesRun
    // Simulate restart: new deps with same root but fresh guards
    resetAutoGuards()
    const freshDeps = makeDeps(store, tmpRoot, {
      ...OVERRIDE_EVO,
      evolution: { ...OVERRIDE_EVO.evolution, maxCyclesPerProcess: 3 },
    })
    const oAfterReset = await runAutoCycle(freshDeps)
    expect(oAfterReset.ran).toBe(true)
    expect(autoGuardState().cyclesRun).toBe(0)
  })

  it('lastCycleExperienceCount resets on restart, allowing re-analysis', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })
    for (let i = 0; i < 10; i++) await store.addExperience({ success: false, errors: ['drift-sig'], stepCount: 12, versionId: 'v2', prompt: 'drift-' + i })
    resetAutoGuards()
    const deps1 = makeDeps(store, tmpRoot, OVERRIDE_EVO)
    await runAutoCycle(deps1)
    expect(autoGuardState().lastCycleExperienceCount).toBe(10)
    // Simulate restart
    const freshStore = new EvolutionStore({ fallbackRoot: tmpRoot })
    await freshStore.init()
    resetAutoGuards()
    expect(autoGuardState().lastCycleExperienceCount).toBe(-1)
    const deps2 = makeDeps(freshStore, tmpRoot, OVERRIDE_EVO)
    const o = await runAutoCycle(deps2)
    expect(o.ran).toBe(true)
  })
})
