import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { ModuleDeps } from '../src/host/types.ts'
import type { HostContextShape } from '../src/host/dsh.ts'

function makeCtx(): HostContextShape { return { tools: { register: () => {} }, settings: { writable: true, register: () => ({ get: () => ({}) }) }, agents: { get: () => undefined, roots: () => [] }, get: () => undefined, on: () => () => {}, effect: () => () => {} } }
function makeDeps(store: EvolutionStore, root: string): ModuleDeps { return { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: root }), store, log: () => {}, warn: () => {} } }

describe('Audit 6: Partial write corruption', () => {
  let tmpRoot: string, store: EvolutionStore
  beforeEach(async () => { tmpRoot = await mkdtemp(join(tmpdir(), 'evo-audit6-')); store = new EvolutionStore({ fallbackRoot: tmpRoot }); await store.init() })
  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  it('truncated experience JSON is skipped during list', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const valid = await store.addExperience({ success: true, score: 0.9, stepCount: 3, versionId: 'v1', prompt: 'valid' })
    await writeFile(join(tmpRoot, 'experiences', 'corrupt-trunc.json'), '{"success":true,"id":"corrupt-trunc","timestamp":"', 'utf8')
    const all = await store.listExperiences(100)
    expect(all.length).toBe(1)
    expect(all[0]!.id).toBe(valid.id)
  })

  it('garbage bytes in experience file are handled gracefully', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    for (let i = 0; i < 5; i++) await store.addExperience({ success: i % 2 === 0, stepCount: 5, versionId: 'v1', prompt: 'garbage-test-' + i })
    await writeFile(join(tmpRoot, 'experiences', 'garbage.json'), Buffer.from([0x7b, 0x22, 0x74, 0x65, 0x73, 0x74, 0x22, 0x3a, 0x20, 0x00, 0xff, 0xfe, 0x7d]), 'utf8')
    const all = await store.listExperiences(100)
    expect(all.length).toBe(5)
  })

  it('corrupt version file does not break listVersions', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })
    await writeFile(join(tmpRoot, 'versions', 'v2.json'), 'NOT VALID JSON {{{', 'utf8')
    const versions = await store.listVersions(100)
    expect(versions.length).toBe(1)
    expect(versions[0]!.id).toBe('v1')
  })

  it('multiple simultaneous corruptions do not cascade into total data loss', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const validIds: string[] = []
    for (let i = 0; i < 10; i++) validIds.push((await store.addExperience({ success: i < 5, stepCount: 5, versionId: 'v1', prompt: 'multi-corrupt-' + i })).id)
    const allExp = await store.listExperiences(100)
    for (let i = 0; i < 3 && i < allExp.length; i++) await writeFile(join(tmpRoot, 'experiences', allExp[i]!.id + '.json'), 'CORRUPTED' + i, 'utf8')
    const remaining = await store.listExperiences(100)
    expect(remaining.length).toBe(7)
  })
})
