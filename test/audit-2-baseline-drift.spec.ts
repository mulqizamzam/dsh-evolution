import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { ModuleDeps } from '../src/host/types.ts'
import type { HostContextShape } from '../src/host/dsh.ts'

function makeCtx(): HostContextShape {
  return { tools: { register: () => {} }, settings: { writable: true, register: () => ({ get: () => ({}) }) }, agents: { get: () => undefined, roots: () => [] }, get: () => undefined, on: () => () => {}, effect: () => () => {} }
}

function makeDeps(store: EvolutionStore, root: string): ModuleDeps {
  return { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: root }), store, log: () => {}, warn: () => {} }
}

describe('Audit 2: Baseline drift', () => {
  let tmpRoot: string, store: EvolutionStore
  beforeEach(async () => { tmpRoot = await mkdtemp(join(tmpdir(), 'evo-audit2-')); store = new EvolutionStore({ fallbackRoot: tmpRoot }); await store.init() })
  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  it('new failure mode after promotion is still detected', async () => {
    await store.createVersion({ label: 'v1-baseline', modules: [] })
    const v2 = await store.createVersion({ label: 'v2-promoted', modules: [] })
    for (let i = 0; i < 10; i++) await store.addExperience({ success: false, errors: ['timeout: request timed out'], stepCount: 15, versionId: 'v2', prompt: 'original-task-' + i })
    const { detectVersionDegradation } = await import('../src/host/modules/analyze/tools.ts')
    let signal = detectVersionDegradation(await store.listExperiencesByVersion('v2', 100))
    expect(signal!.isDegraded).toBe(true)
    for (let i = 0; i < 10; i++) await store.addExperience({ success: false, errors: ['network-error: connection refused'], stepCount: 30, versionId: 'v2', prompt: 'drifted-task-' + i })
    signal = detectVersionDegradation(await store.listExperiencesByVersion('v2', 100))
    expect(signal!.isDegraded).toBe(true)
    expect(signal!.total).toBe(20)
    expect(signal!.errorRate).toBe(1.0)
  })

  it('drift recovery: enough new successes restore healthy signal', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })
    for (let i = 0; i < 10; i++) await store.addExperience({ success: false, errors: ['new-error-pattern-' + (i % 3)], stepCount: 25, versionId: 'v2', prompt: 'drifted-' + i })
    const { detectVersionDegradation } = await import('../src/host/modules/analyze/tools.ts')
    let signal = detectVersionDegradation(await store.listExperiencesByVersion('v2', 100))
    expect(signal!.isDegraded).toBe(true)
    // Need: successRate >= 0.6 AND errorRate <= 0.3
    // With N total: successes/N >= 0.6 AND failures/N <= 0.3
    // failures=10: need N >= 34 (10/34=0.294) → add 24 successes → 34 total
    for (let i = 0; i < 24; i++) await store.addExperience({ success: true, score: 0.9, stepCount: 5, versionId: 'v2', prompt: 'recovered-' + i })
    signal = detectVersionDegradation(await store.listExperiencesByVersion('v2', 100))
    expect(signal!.isDegraded).toBe(false)
    expect(signal!.successRate).toBeGreaterThan(0.6)
    expect(signal!.errorRate).toBeLessThanOrEqual(0.3)
  })
})
