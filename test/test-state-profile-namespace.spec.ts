/**
 * Profile-namespace regression tests.
 *
 * When a profile name is supplied to resolveStateRoot / EvolutionStore,
 * the state root is namespaced under it.  Two profiles with different
 * names must therefore have fully independent mutable state.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveStateRoot } from '../src/lib/home.ts'
import { EvolutionStore } from '../src/host/store.ts'
import { seedLiveBenchmark } from './helpers/seed-live-benchmark.ts'

describe('RESOLVE_STATE_ROOT — profile namespacing', () => {
  it('no profile → legacy flat root (backward-compatible)', () => {
    const root = resolveStateRoot(undefined, '/tmp/my-dsh-evolution')
    expect(root).toBe('/tmp/my-dsh-evolution')
  })

  it('profile "web" → root + /web', () => {
    const root = resolveStateRoot(undefined, '/tmp/my-dsh-evolution', 'web')
    expect(root).toBe(join('/tmp/my-dsh-evolution', 'web'))
  })

  it('profile "evo-live" → root + /evo-live', () => {
    const root = resolveStateRoot(undefined, '/tmp/my-dsh-evolution', 'evo-live')
    expect(root).toBe(join('/tmp/my-dsh-evolution', 'evo-live'))
  })

  it('profile names are isolated from each other', () => {
    const webRoot = resolveStateRoot(undefined, '/home/u/.dsh/dsh-evolution', 'web')
    const liveRoot = resolveStateRoot(undefined, '/home/u/.dsh/dsh-evolution', 'evo-live')
    expect(webRoot).not.toBe(liveRoot)
    expect(webRoot).toBe(join('/home/u/.dsh/dsh-evolution', 'web'))
    expect(liveRoot).toBe(join('/home/u/.dsh/dsh-evolution', 'evo-live'))
  })
})

describe('STATE ROOT ISOLATION — cross-profile (regression)', () => {
  async function makeStore(root: string, profileName?: string): Promise<EvolutionStore> {
    const s = new EvolutionStore({ fallbackRoot: root, profileName })
    await s.init()
    return s
  }

  // ── Profile namespacing isolates state even when both under the same parent ──
  it('two profiles sharing a parent directory are fully isolated', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'evo-parent-'))
    try {
      const webStore = await makeStore(join(parentRoot, 'dsh-evolution'), 'web')
      const liveStore = await makeStore(join(parentRoot, 'dsh-evolution'), 'evo-live')

      // Different resolved roots
      expect(webStore.getRoot()).not.toBe(liveStore.getRoot())
      expect(webStore.getRoot()).toBe(join(parentRoot, 'dsh-evolution', 'web'))
      expect(liveStore.getRoot()).toBe(join(parentRoot, 'dsh-evolution', 'evo-live'))

      // Web writes state
      const exp = await webStore.addExperience({ success: true, prompt: 'web-task' })
      expect(exp.id).toBeDefined()
      const c = await webStore.addCandidate({
        parentVersion: 'v0', type: 'policy', name: 'web-candidate',
        description: 'd', reason: 'r', evidenceIds: [], patternIds: [],
        status: 'draft', files: [], tests: [],
        benchmarkConfig: {
          successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 },
          avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      await seedLiveBenchmark(webStore, c.id, 'v1', 'unknown', { successRate: 0.95, avgScore: 0.95, errorRate: 0.02, avgSteps: 5, avgDurationMs: 100 }, { passed: true, details: 'web-v1', runs: 5 })
      await webStore.createVersion({ label: 'v1', reason: 'web-release', promotedFrom: 'v0', modules: [c.id] })

      // evo-live sees NONE of the web state
      expect(await liveStore.listExperiences(100)).toHaveLength(0)
      expect(await liveStore.listCandidates(100)).toHaveLength(0)
      expect(await liveStore.listBenchmarks(100)).toHaveLength(0)
      expect(await liveStore.listVersions(100)).toHaveLength(0)
      expect(await liveStore.getActiveVersion()).toBeNull()

      // Reverse: evo-live writes state, web sees none
      const exp2 = await liveStore.addExperience({ success: true, prompt: 'live-task' })
      expect(exp2.id).toBeDefined()
      expect(await webStore.listExperiences(100)).toHaveLength(1) // only web-task
    } finally {
      await rm(parentRoot, { recursive: true, force: true })
    }
  })

  // ── No profile name → legacy flat root, state shared ──
  it('no profile name preserves legacy shared-root behavior', async () => {
    const sharedRoot = await mkdtemp(join(tmpdir(), 'evo-legacy-'))
    try {
      const storeA = await makeStore(sharedRoot) // no profile
      const storeB = await makeStore(sharedRoot) // no profile
      expect(storeA.getRoot()).toBe(storeB.getRoot())

      // Both see each other's data (legacy behavior, documented)
      await storeA.addExperience({ success: true, prompt: 'shared' })
      const shared = await storeB.listExperiences(100)
      expect(shared.length).toBe(1)
      expect(shared[0].prompt).toBe('shared')
    } finally {
      await rm(sharedRoot, { recursive: true, force: true })
    }
  })

  // ── Restart preserves isolation ──
  it('fresh store instances under the same profile stay isolated', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'evo-restart-'))
    try {
      const webStore1 = await makeStore(join(parentRoot, 'dsh-evolution'), 'web')
      await webStore1.addExperience({ success: true, prompt: 'web-restart-1' })

      // "Restart": fresh instances, same profile
      const webStore2 = await makeStore(join(parentRoot, 'dsh-evolution'), 'web')
      const liveStore2 = await makeStore(join(parentRoot, 'dsh-evolution'), 'evo-live')

      // Web sees its own restart state
      const webExps = await webStore2.listExperiences(100)
      expect(webExps.length).toBe(1)
      expect(webExps[0].prompt).toBe('web-restart-1')

      // Live sees nothing
      expect(await liveStore2.listExperiences(100)).toHaveLength(0)
    } finally {
      await rm(parentRoot, { recursive: true, force: true })
    }
  })
})
