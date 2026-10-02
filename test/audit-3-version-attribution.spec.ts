import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { ModuleDeps } from '../src/host/types.ts'
import type { HostContextShape } from '../src/host/dsh.ts'

function makeCtx(): HostContextShape { return { tools: { register: () => {} }, settings: { writable: true, register: () => ({ get: () => ({}) }) }, agents: { get: () => undefined, roots: () => [] }, get: () => undefined, on: () => () => {}, effect: () => () => {} } }
function makeDeps(store: EvolutionStore, root: string): ModuleDeps { return { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: root }), store, log: () => {}, warn: () => {} } }

describe('Audit 3: Version attribution stability', () => {
  let tmpRoot: string, store: EvolutionStore
  beforeEach(async () => { tmpRoot = await mkdtemp(join(tmpdir(), 'evo-audit3-')); store = new EvolutionStore({ fallbackRoot: tmpRoot }); await store.init() })
  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  it('experiences written under v1 remain attributed to v1 after v2 is promoted', async () => {
    const v1 = await store.createVersion({ label: 'v1-baseline', modules: [] })
    const v2 = await store.createVersion({ label: 'v2-promoted', modules: [] })
    const v1Ids: string[] = []
    for (let i = 0; i < 5; i++) v1Ids.push((await store.addExperience({ success: i % 2 === 0, score: 0.9, stepCount: 5, versionId: 'v1', prompt: 'v1-task-' + i })).id)
    const v1After = await store.listExperiencesByVersion('v1', 100)
    expect(v1After.length).toBe(5)
    expect(v1After.every(e => e.versionId === 'v1')).toBe(true)
    for (const id of v1Ids) expect(v1After.map(e => e.id)).toContain(id)
  })

  it('experiences written under v1 remain attributed to v1 after rollback to v1', async () => {
    const v1 = await store.createVersion({ label: 'v1-baseline', modules: [] })
    const v2 = await store.createVersion({ label: 'v2-promoted', modules: [] })
    const v1Ids: string[] = []
    for (let i = 0; i < 5; i++) v1Ids.push((await store.addExperience({ success: true, score: 0.9, stepCount: 3, versionId: 'v1', prompt: 'v1-task-' + i })).id)
    for (let i = 0; i < 3; i++) await store.addExperience({ success: false, errors: ['v2-error'], stepCount: 20, versionId: 'v2', prompt: 'v2-task-' + i })
    await store.rollbackVersion('v1')
    const v1After = await store.listExperiencesByVersion('v1', 100)
    expect(v1After.length).toBe(5)
    expect(v1After.every(e => e.versionId === 'v1')).toBe(true)
  })

  it('unversioned experiences are excluded from per-version queries', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    await store.createVersion({ label: 'v2', modules: [] })
    for (let i = 0; i < 5; i++) await store.addExperience({ success: i % 2 === 0, stepCount: 8, prompt: 'unattributed-' + i })
    expect((await store.listExperiencesByVersion('v1', 100)).length).toBe(0)
    expect((await store.listExperiencesByVersion('v2', 100)).length).toBe(0)
  })
})
