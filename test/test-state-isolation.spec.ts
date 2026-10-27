/**
 * Cross-profile state isolation tests.
 *
 * Two independent EvolutionStore instances must NOT share mutable state.
 * If both point at the same filesystem root, writes from one are visible to
 * the other — this is a contamination defect.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { seedLiveBenchmark } from './helpers/seed-live-benchmark.ts'

async function makeStore(root: string): Promise<EvolutionStore> {
  const s = new EvolutionStore({ fallbackRoot: root })
  await s.init()
  return s
}

function benchmarkConfig() {
  return {
    successRate: { min: 0.8, weight: 1 },
    avgScore: { min: 0.7, weight: 1 },
    errorRate: { max: 0.2, weight: 1 },
    avgSteps: { max: 50, weight: 0.5 },
    avgDurationMs: { max: 60000, weight: 0.5 },
  }
}

describe('STATE ROOT ISOLATION — cross-profile contamination', () => {
  // ── Falsification 1: TEST writes experience → LIVE should not see it ──
  it('experience written to TEST root is not visible in LIVE root', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'evo-test1-'))
    const liveRoot = await mkdtemp(join(tmpdir(), 'evo-live1-'))
    try {
      const testStore = await makeStore(testRoot)
      const liveStore = await makeStore(liveRoot)

      const exp = await testStore.addExperience({ success: true, prompt: 'test-only-task' })
      expect(exp.id).toBeDefined()

      const liveExps = await liveStore.listExperiences(100)
      expect(liveExps.length).toBe(0)
    } finally {
      await rm(testRoot, { recursive: true, force: true })
      await rm(liveRoot, { recursive: true, force: true })
    }
  })

  // ── Falsification 2: LIVE writes experience → TEST should not see it ──
  it('experience written to LIVE root is not visible in TEST root', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'evo-test2-'))
    const liveRoot = await mkdtemp(join(tmpdir(), 'evo-live2-'))
    try {
      const testStore = await makeStore(testRoot)
      const liveStore = await makeStore(liveRoot)

      await liveStore.addExperience({ success: true, prompt: 'live-only-task' })
      const testExps = await testStore.listExperiences(100)
      expect(testExps.length).toBe(0)
    } finally {
      await rm(testRoot, { recursive: true, force: true })
      await rm(liveRoot, { recursive: true, force: true })
    }
  })

  // ── Falsification 3: TEST creates candidate → LIVE should not see it ──
  it('candidate created in TEST root is not visible in LIVE root', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'evo-test3-'))
    const liveRoot = await mkdtemp(join(tmpdir(), 'evo-live3-'))
    try {
      const testStore = await makeStore(testRoot)
      const liveStore = await makeStore(liveRoot)

      const c = await testStore.addCandidate({
        parentVersion: 'v0', type: 'policy', name: 'test-candidate',
        description: 'test', reason: 'test',
        evidenceIds: [], patternIds: [], status: 'draft',
        files: [], tests: [], benchmarkConfig: benchmarkConfig(),
      })
      expect(c.id).toBeDefined()

      const liveCands = await liveStore.listCandidates(100)
      expect(liveCands.length).toBe(0)
    } finally {
      await rm(testRoot, { recursive: true, force: true })
      await rm(liveRoot, { recursive: true, force: true })
    }
  })

  // ── Falsification 4: LIVE creates candidate → TEST should not see it ──
  it('candidate created in LIVE root is not visible in TEST root', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'evo-test4-'))
    const liveRoot = await mkdtemp(join(tmpdir(), 'evo-live4-'))
    try {
      const testStore = await makeStore(testRoot)
      const liveStore = await makeStore(liveRoot)

      await liveStore.addCandidate({
        parentVersion: 'v0', type: 'policy', name: 'live-candidate',
        description: 'live', reason: 'live',
        evidenceIds: [], patternIds: [], status: 'draft',
        files: [], tests: [], benchmarkConfig: benchmarkConfig(),
      })

      const testCands = await testStore.listCandidates(100)
      expect(testCands.length).toBe(0)
    } finally {
      await rm(testRoot, { recursive: true, force: true })
      await rm(liveRoot, { recursive: true, force: true })
    }
  })

  // ── Falsification 5: TEST promotes version → LIVE active state unchanged ──
  it('version promoted in TEST root does not affect LIVE active state', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'evo-test5-'))
    const liveRoot = await mkdtemp(join(tmpdir(), 'evo-live5-'))
    try {
      const testStore = await makeStore(testRoot)
      const liveStore = await makeStore(liveRoot)

      const c = await testStore.addCandidate({
        parentVersion: 'v0', type: 'policy', name: 'v1',
        description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'x=1\n' }], tests: [],
        benchmarkConfig: benchmarkConfig(),
      })
      await seedLiveBenchmark(testStore, c.id, 'v1', 'unknown', { successRate: 0.95, avgScore: 0.95, errorRate: 0.02, avgSteps: 5, avgDurationMs: 100 }, { passed: true, details: 'v1', runs: 5 })
      await testStore.createVersion({ label: 'v1', reason: 'test-release', promotedFrom: 'v0', modules: [c.id] })

      const liveActive = await liveStore.getActiveVersion()
      expect(liveActive).toBeNull()
    } finally {
      await rm(testRoot, { recursive: true, force: true })
      await rm(liveRoot, { recursive: true, force: true })
    }
  })

  // ── Falsification 6: LIVE promotes version → TEST active state unchanged ──
  it('version promoted in LIVE root does not affect TEST active state', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'evo-test6-'))
    const liveRoot = await mkdtemp(join(tmpdir(), 'evo-live6-'))
    try {
      const testStore = await makeStore(testRoot)
      const liveStore = await makeStore(liveRoot)

      const c = await liveStore.addCandidate({
        parentVersion: 'v0', type: 'policy', name: 'v1',
        description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'x=1\n' }], tests: [],
        benchmarkConfig: benchmarkConfig(),
      })
      await seedLiveBenchmark(liveStore, c.id, 'v1', 'unknown', { successRate: 0.95, avgScore: 0.95, errorRate: 0.02, avgSteps: 5, avgDurationMs: 100 }, { passed: true, details: 'v1', runs: 5 })
      await liveStore.createVersion({ label: 'v1', reason: 'live-release', promotedFrom: 'v0', modules: [c.id] })

      const testActive = await testStore.getActiveVersion()
      expect(testActive).toBeNull()
    } finally {
      await rm(testRoot, { recursive: true, force: true })
      await rm(liveRoot, { recursive: true, force: true })
    }
  })

  // ── Falsification 7: TEST benchmark does not affect LIVE promotion ──
  it('benchmark in TEST root does not make LIVE promotion eligible', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'evo-test7-'))
    const liveRoot = await mkdtemp(join(tmpdir(), 'evo-live7-'))
    try {
      const testStore = await makeStore(testRoot)
      const liveStore = await makeStore(liveRoot)

      // LIVE creates candidate
      const c = await liveStore.addCandidate({
        parentVersion: 'v0', type: 'policy', name: 'v1',
        description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'draft',
        files: [], tests: [], benchmarkConfig: benchmarkConfig(),
      })

      // TEST writes a benchmark for the same candidate ID (cross-profile leak)
      await seedLiveBenchmark(testStore, c.id, 'v1', 'unknown', { successRate: 1.0, avgScore: 1.0, errorRate: 0, avgSteps: 5, avgDurationMs: 100 }, { passed: true, details: 'cross-profile', runs: 5 })

      // LIVE should not see the TEST benchmark
      const liveBenches = await liveStore.listBenchmarks(100)
      expect(liveBenches.length).toBe(0)
    } finally {
      await rm(testRoot, { recursive: true, force: true })
      await rm(liveRoot, { recursive: true, force: true })
    }
  })

  // ── Falsification 9: fresh store instances (restart simulation) ──
  it('restart preserves isolation (fresh instances read only their own root)', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'evo-test9-'))
    const liveRoot = await mkdtemp(join(tmpdir(), 'evo-live9-'))
    try {
      // Write state in both
      const testStore1 = await makeStore(testRoot)
      await testStore1.addExperience({ success: true, prompt: 'test-restart' })
      const liveStore1 = await makeStore(liveRoot)
      await liveStore1.addExperience({ success: true, prompt: 'live-restart' })

      // "Restart" both — fresh instances
      const testStore2 = await makeStore(testRoot)
      const liveStore2 = await makeStore(liveRoot)

      const testExps2 = await testStore2.listExperiences(100)
      expect(testExps2.length).toBe(1)
      expect(testExps2[0].prompt).toBe('test-restart')

      const liveExps2 = await liveStore2.listExperiences(100)
      expect(liveExps2.length).toBe(1)
      expect(liveExps2[0].prompt).toBe('live-restart')
    } finally {
      await rm(testRoot, { recursive: true, force: true })
      await rm(liveRoot, { recursive: true, force: true })
    }
  })
})
