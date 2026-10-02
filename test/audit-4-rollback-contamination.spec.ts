import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { ModuleDeps } from '../src/host/types.ts'
import type { HostContextShape } from '../src/host/dsh.ts'
import { runAutoCycle, resetAutoGuards } from '../src/host/modules/auto-experience/index.ts'
import { seedExperiencesForVersion } from './helpers/seed-experiences.ts'
import { makeFakeLlm } from './helpers/fake-llm.ts'

function makeCtx(): HostContextShape { return { tools: { register: () => {} }, settings: { writable: true, register: () => ({ get: () => ({}) }) }, agents: { get: () => undefined, roots: () => [] }, get: () => undefined, on: () => () => {}, effect: () => () => {} } }
function makeDeps(store: EvolutionStore, root: string, overrides?: Record<string, unknown>): ModuleDeps { return { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: root, ...overrides }), store, log: () => {}, warn: () => {} } }

describe('Audit 4: Rollback contamination', () => {
  let tmpRoot: string, store: EvolutionStore
  beforeEach(async () => { tmpRoot = await mkdtemp(join(tmpdir(), 'evo-audit4-')); store = new EvolutionStore({ fallbackRoot: tmpRoot }); await store.init() })
  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  it('v1 health is NOT contaminated by v2 degradation after rollback', async () => {
    const v1 = await store.createVersion({ label: 'v1-healthy', modules: [] })
    await seedExperiencesForVersion(store, v1.id, { successes: 10, failures: 0 })
    const v2 = await store.createVersion({ label: 'v2-degraded', modules: [] })
    await seedExperiencesForVersion(store, v2.id, { successes: 0, failures: 10, errors: ['v2-fail'] })
    const { detectVersionDegradation } = await import('../src/host/modules/analyze/tools.ts')
    expect(detectVersionDegradation(await store.listExperiencesByVersion('v1', 100))!.isDegraded).toBe(false)
    expect(detectVersionDegradation(await store.listExperiencesByVersion('v2', 100))!.isDegraded).toBe(true)
    await store.rollbackVersion('v1')
    expect(detectVersionDegradation(await store.listExperiencesByVersion('v1', 100))!.isDegraded).toBe(false)
    expect(detectVersionDegradation(await store.listExperiencesByVersion('v2', 100))!.isDegraded).toBe(true)
    expect((await store.getActiveVersion())!.id).toBe('v1')
  })

  it('auto-cycle after rollback evaluates reactivated version only', async () => {
    const v1 = await store.createVersion({ label: 'v1-healthy', modules: [] })
    const v2 = await store.createVersion({ label: 'v2-degraded', modules: [] })
    await seedExperiencesForVersion(store, v1.id, { successes: 10, failures: 0 })
    await seedExperiencesForVersion(store, v2.id, { successes: 0, failures: 10, errors: ['v2-fail'] })
    await store.rollbackVersion('v1')
    const cycleDeps = makeDeps(store, tmpRoot, {
      evolution: { enabled: true, autoTrigger: true, autoRecord: true, analysis: { minExperiences: 5, minOccurrences: 2 }, generation: { enabled: false }, promotion: { enabled: false }, maxCyclesPerProcess: 10 },
    })
    resetAutoGuards()
    const outcome = await runAutoCycle(cycleDeps)
    expect(outcome.ran).toBe(true)
  })
})
