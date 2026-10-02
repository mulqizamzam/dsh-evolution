import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { ModuleDeps } from '../src/host/types.ts'
import type { HostContextShape } from '../src/host/dsh.ts'
import { seedExperiencesForVersion } from './helpers/seed-experiences.ts'

function makeCtx(): HostContextShape {
  return { tools: { register: () => {} }, settings: { writable: true, register: () => ({ get: () => ({}) }) }, agents: { get: () => undefined, roots: () => [] }, get: () => undefined, on: () => () => {}, effect: () => () => {} }
}

function makeDeps(store: EvolutionStore, root: string): ModuleDeps {
  return { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: root }), store, log: () => {}, warn: () => {} }
}

describe('Audit 1: Cross-task regression', () => {
  let tmpRoot: string, store: EvolutionStore
  beforeEach(async () => { tmpRoot = await mkdtemp(join(tmpdir(), 'evo-audit1-')); store = new EvolutionStore({ fallbackRoot: tmpRoot }); await store.init() })
  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  it('candidate passing class-A but breaking class-B triggers degradation signal', async () => {
    await store.createVersion({ label: 'v1-baseline', modules: [] })
    const v2 = await store.createVersion({ label: 'v2-candidate', modules: [] })
    await seedExperiencesForVersion(store, v2.id, { successes: 6, failures: 0, stepCount: 3 })
    await seedExperiencesForVersion(store, v2.id, { successes: 0, failures: 5, errors: ['regression-in-class-b'], stepCount: 20 })
    const records = await store.listExperiencesByVersion(v2.id, 100)
    const { detectVersionDegradation } = await import('../src/host/modules/analyze/tools.ts')
    const signal = detectVersionDegradation(records)
    expect(signal).not.toBeNull()
    expect(signal!.isDegraded).toBe(true)
    expect(signal!.signals.some(s => s.includes('success-rate-low'))).toBe(true)
  })

  it('high aggregate but broken sub-class: pattern detection finds regression', async () => {
    await store.createVersion({ label: 'v1-baseline', modules: [] })
    const v2 = await store.createVersion({ label: 'v2-mixed', modules: [] })
    await seedExperiencesForVersion(store, v2.id, { successes: 12, failures: 0, stepCount: 3 })
    await seedExperiencesForVersion(store, v2.id, { successes: 0, failures: 3, errors: ['specific-regression'], stepCount: 25 })
    const records = await store.listExperiencesByVersion(v2.id, 100)
    const { detectVersionDegradation, detectPatterns } = await import('../src/host/modules/analyze/tools.ts')
    const signal = detectVersionDegradation(records)
    expect(signal!.isDegraded).toBe(false)
    const patterns = detectPatterns(records, 2)
    const regressionPattern = patterns.find(p => p.description.includes('specific-regression'))
    expect(regressionPattern).not.toBeNull()
    expect(regressionPattern!.occurrences).toBe(3)
  })
})
