/**
 * CHECK 1: Fresh versionId attribution
 * Test that newly recorded experiences under an active version carry versionId.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { ModuleDeps } from '../src/host/types.ts'
import type { HostContextShape } from '../src/host/dsh.ts'
import { observeTurn, activationState, resetActivation } from '../src/host/modules/activation/loader.ts'
import { activationState as getActivationState } from '../src/host/modules/activation/loader.ts'

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

function makeDeps(store: EvolutionStore, root: string): ModuleDeps {
  return { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: root }), store, log: () => {}, warn: () => {} }
}

describe('CHECK 1: Fresh versionId attribution', () => {
  let tmpRoot: string, store: EvolutionStore
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-check1-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
    resetActivation()
  })
  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  it('experience recorded with no active version has no versionId', async () => {
    const rec = await store.addExperience({
      success: true, stepCount: 5, prompt: 'test', versionId: undefined,
    })
    expect(rec.versionId).toBeUndefined()
    const all = await store.listExperiences(100)
    expect(all[0]!.versionId).toBeUndefined()
  })

  it('experience recorded with explicit versionId retains it', async () => {
    const rec = await store.addExperience({
      success: true, stepCount: 5, prompt: 'test', versionId: 'v3',
    })
    expect(rec.versionId).toBe('v3')
    const byV3 = await store.listExperiencesByVersion('v3', 100)
    expect(byV3.length).toBe(1)
    expect(byV3[0]!.id).toBe(rec.id)
  })

  it('listExperiencesByVersion excludes records without versionId', async () => {
    await store.addExperience({ success: true, stepCount: 3, prompt: 'unattributed' })
    await store.addExperience({ success: false, errors: ['err'], stepCount: 5, versionId: 'v2', prompt: 'v2-task' })
    const unattributed = await store.listExperiences(100)
    const v2Only = await store.listExperiencesByVersion('v2', 100)
    expect(unattributed.length).toBe(2)
    expect(v2Only.length).toBe(1)
    expect(v2Only[0]!.versionId).toBe('v2')
  })

  it('detection of degradation requires versionId AND sufficient data', async () => {
    const { detectVersionDegradation } = await import('../src/host/modules/analyze/tools.ts')
    // No versionId → null
    await store.addExperience({ success: true, stepCount: 3, prompt: 'test' })
    expect(detectVersionDegradation(await store.listExperiences(100))).toBeNull()
    // With versionId but insufficient count → null
    for (let i = 0; i < 4; i++) await store.addExperience({ success: false, errors: ['fail'], stepCount: 10, versionId: 'v2', prompt: 't-' + i })
    expect(detectVersionDegradation(await store.listExperiencesByVersion('v2', 100))).toBeNull()
    // With versionId and enough failures → signal
    for (let i = 0; i < 6; i++) await store.addExperience({ success: false, errors: ['fail'], stepCount: 10, versionId: 'v2', prompt: 't-' + (i + 4) })
    const signal = detectVersionDegradation(await store.listExperiencesByVersion('v2', 100))
    expect(signal).not.toBeNull()
    expect(signal!.isDegraded).toBe(true)
    expect(signal!.total).toBe(10)
    expect(signal!.successRate).toBe(0)
  })
})
