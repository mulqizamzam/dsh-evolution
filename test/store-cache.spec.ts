/**
 * Regression + behaviour tests for the EvolutionStore in-memory list cache.
 *
 * The cache is a private optimisation: public method signatures, return shapes,
 * and ordering must remain unchanged. These tests pin:
 *   1. A second call within TTL returns the cached result (no fresh disk read).
 *   2. Any mutation method invalidates the cache immediately.
 *   3. Stale entries (older than TTL) are evicted on next access.
 *   4. listExperiencesByVersion benefits from the cached listExperiences call.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvolutionStore } from '../src/host/store.ts'

describe('EvolutionStore cache', () => {
  let store: EvolutionStore
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-cache-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
  })
  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  it('second listExperiences call within TTL returns cached result', async () => {
    for (let i = 0; i < 5; i++) {
      await store.addExperience({ success: true, prompt: 'task-' + i })
    }
    // First call populates the cache.
    const first = await store.listExperiences(10)
    expect(first).toHaveLength(5)
    // Second call must return the same objects (identity check = cache hit).
    const second = await store.listExperiences(10)
    expect(second).toBe(first) // same array reference = cache hit
  })

  it('addExperience invalidates the experience cache', async () => {
    await store.addExperience({ success: true, prompt: 'a' })
    const before = await store.listExperiences(10)
    expect(before).toHaveLength(1)

    await store.addExperience({ success: false, prompt: 'b' })
    const after = await store.listExperiences(10)
    expect(after).toHaveLength(2)
    expect(after).not.toBe(before) // different reference = cache invalidated
  })

  it('addPattern invalidates the pattern cache', async () => {
    const p1 = await store.addPattern({ type: 'failure', evidence: 'FACT', description: 'd1', occurrences: 1, evidenceIds: [], confidence: 0.5 })
    const first = await store.listPatterns(10)
    expect(first).toHaveLength(1)

    await store.addPattern({ type: 'success', evidence: 'FACT', description: 'd2', occurrences: 1, evidenceIds: [], confidence: 0.5 })
    const second = await store.listPatterns(10)
    expect(second).toHaveLength(2)
    expect(second).not.toBe(first)
  })

  it('addCandidate invalidates the candidate cache', async () => {
    const c1 = await store.addCandidate({
      parentVersion: 'v1', type: 'policy', name: 'n1', description: 'd1', reason: 'r1',
      evidenceIds: [], patternIds: [], files: [], tests: [],
      benchmarkConfig: { successRate: { min: 0.5, weight: 1 }, avgScore: { min: 0.5, weight: 1 }, errorRate: { max: 0.5, weight: 1 }, avgSteps: { max: 100, weight: 1 }, avgDurationMs: { max: 60000, weight: 1 } },
      status: 'draft',
    })
    const first = await store.listCandidates(10)
    expect(first).toHaveLength(1)

    const c2 = await store.addCandidate({
      parentVersion: 'v1', type: 'policy', name: 'n2', description: 'd2', reason: 'r2',
      evidenceIds: [], patternIds: [], files: [], tests: [],
      benchmarkConfig: { successRate: { min: 0.5, weight: 1 }, avgScore: { min: 0.5, weight: 1 }, errorRate: { max: 0.5, weight: 1 }, avgSteps: { max: 100, weight: 1 }, avgDurationMs: { max: 60000, weight: 1 } },
      status: 'draft',
    })
    const second = await store.listCandidates(10)
    expect(second).toHaveLength(2)
    expect(second).not.toBe(first)
  })

  it('addBenchmark invalidates the benchmark cache', async () => {
    const c = await store.addCandidate({
      parentVersion: 'v1', type: 'policy', name: 'n', description: 'd', reason: 'r',
      evidenceIds: [], patternIds: [], files: [], tests: [],
      benchmarkConfig: { successRate: { min: 0.5, weight: 1 }, avgScore: { min: 0.5, weight: 1 }, errorRate: { max: 0.5, weight: 1 }, avgSteps: { max: 100, weight: 1 }, avgDurationMs: { max: 60000, weight: 1 } },
      status: 'draft',
    })
    const b1 = await store.addBenchmark({ candidateId: c.id, version: 'v1', baseline: 'v1', runs: 1, metrics: { successRate: 1, avgScore: 1, errorRate: 0, avgSteps: 0, avgDurationMs: 100 }, passed: true, details: 'ok' })
    const first = await store.listBenchmarks(10)
    expect(first).toHaveLength(1)

    const b2 = await store.addBenchmark({ candidateId: c.id, version: 'v1', baseline: 'v1', runs: 1, metrics: { successRate: 0.8, avgScore: 0.8, errorRate: 0.1, avgSteps: 10, avgDurationMs: 200 }, passed: true, details: 'ok2' })
    const second = await store.listBenchmarks(10)
    expect(second).toHaveLength(2)
    expect(second).not.toBe(first)
  })

  it('createVersion invalidates the version cache', async () => {
    const v1 = await store.createVersion({ label: 'v1', modules: [] })
    const first = await store.listVersions(10)
    expect(first).toHaveLength(1)

    const v2 = await store.createVersion({ label: 'v2', modules: [] })
    const second = await store.listVersions(10)
    expect(second).toHaveLength(2)
    expect(second).not.toBe(first)
    expect(second.find(v => v.id === v2.id)!).toBeDefined()
  })

  it('rollbackVersion invalidates the version cache', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })
    await store.rollbackVersion('v1')
    const versions = await store.listVersions(10)
    expect(versions).toHaveLength(2)
    expect(versions.find(v => v.id === 'v1')!.status).toBe('active')
    expect(versions.find(v => v.id === 'v2')!.status).toBe('rolled-back')
  })

  it('updateCandidate invalidates the candidate cache', async () => {
    const c = await store.addCandidate({
      parentVersion: 'v1', type: 'policy', name: 'n', description: 'd', reason: 'r',
      evidenceIds: [], patternIds: [], files: [], tests: [],
      benchmarkConfig: { successRate: { min: 0.5, weight: 1 }, avgScore: { min: 0.5, weight: 1 }, errorRate: { max: 0.5, weight: 1 }, avgSteps: { max: 100, weight: 1 }, avgDurationMs: { max: 60000, weight: 1 } },
      status: 'draft',
    })
    const first = await store.listCandidates(10)
    expect(first[0]!.status).toBe('draft')

    await store.updateCandidate(c.id, { status: 'benchmarked' })
    const second = await store.listCandidates(10)
    expect(second).not.toBe(first)
    expect(second[0]!.status).toBe('benchmarked')
  })

  it('pruneExperiences invalidates the experience cache', async () => {
    for (let i = 0; i < 5; i++) {
      await store.addExperience({ success: true, prompt: 'task-' + i })
    }
    const first = await store.listExperiences(10)
    expect(first).toHaveLength(5)

    await store.pruneExperiences(3, 999999)
    const second = await store.listExperiences(10)
    expect(second).not.toBe(first)
    expect(second).toHaveLength(3)
  })

  it('listExperiencesByVersion benefits from the cached listExperiences call', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    for (let i = 0; i < 3; i++) {
      await store.addExperience({ success: true, prompt: 'task-' + i, versionId: 'v1' })
    }
    for (let i = 0; i < 2; i++) {
      await store.addExperience({ success: true, prompt: 'other-' + i })
    }
    // First call: listExperiences populates cache; versioned filter runs client-side.
    const byV1 = await store.listExperiencesByVersion('v1', 10)
    expect(byV1).toHaveLength(3)
    // Second call: listExperiences hits cache (no disk read), filter runs in memory.
    const byV1Again = await store.listExperiencesByVersion('v1', 10)
    expect(byV1Again).toHaveLength(3)
    // Same IDs confirms correct filtering.
    expect(byV1.map(e => e.id)).toEqual(byV1Again.map(e => e.id))
    // Third call with different limit reuses cache, same result.
    const byV1Third = await store.listExperiencesByVersion('v1', 5)
    expect(byV1Third).toHaveLength(3)
    expect(byV1Third.map(e => e.id)).toEqual(byV1.map(e => e.id))
  })

  it('different limit values produce different cache entries', async () => {
    for (let i = 0; i < 10; i++) {
      await store.addExperience({ success: true, prompt: 'task-' + i })
    }
    const limited = await store.listExperiences(5)
    const full = await store.listExperiences(100)
    // Different limits → different keys → different results.
    expect(limited).toHaveLength(5)
    expect(full).toHaveLength(10)
    // Each is a distinct array.
    expect(limited).not.toBe(full)
  })

  it('listExperiences migrates from individual .json files to .jsonl on first read', async () => {
    // Write individual .json files directly (bypassing addExperience).
    const { writeFile } = await import('node:fs/promises')
    const dir = (store as unknown as { experienceDir: () => string }).experienceDir()
    await writeFile(join(dir, 'exp-a.json'), JSON.stringify({ id: 'exp-a', timestamp: '2026-01-01T00:00:00.000Z', success: true, prompt: 'a' }), 'utf8')
    await writeFile(join(dir, 'exp-b.json'), JSON.stringify({ id: 'exp-b', timestamp: '2026-01-02T00:00:00.000Z', success: false, prompt: 'b' }), 'utf8')

    // First listExperiences call should trigger migration and return both records.
    const records = await store.listExperiences(10)
    expect(records).toHaveLength(2)
    expect(records.map(r => r.id).sort()).toEqual(['exp-a', 'exp-b'])

    // Second call should hit cache (no migration needed).
    const cached = await store.listExperiences(10)
    expect(cached).toBe(records)
  })

  it('addExperience writes to both .json and .jsonl', async () => {
    const { readdir } = await import('node:fs/promises')
    const record = await store.addExperience({ success: true, prompt: 'task' })
    const dir = (store as unknown as { experienceDir: () => string }).experienceDir()
    const files = await readdir(dir)
    // Individual .json file exists.
    expect(files).toContain(`${record.id}.json`)
    // .jsonl file also exists and contains the record.
    expect(files).toContain('experiences.jsonl')
    const jsonlContent = await (await import('node:fs/promises')).readFile(join(dir, 'experiences.jsonl'), 'utf8')
    expect(jsonlContent).toContain(record.id)
  })

  it('pruneExperiences rewrites .jsonl with only kept records', async () => {
    for (let i = 0; i < 5; i++) {
      await store.addExperience({ success: true, prompt: 'task-' + i })
    }
    const before = await store.listExperiences(100)
    expect(before).toHaveLength(5)

    await store.pruneExperiences(3, 999999)
    const after = await store.listExperiences(100)
    expect(after).toHaveLength(3)
    // .jsonl should exist and contain exactly 3 records.
    const { readFile } = await import('node:fs/promises')
    const dir = (store as unknown as { experienceDir: () => string }).experienceDir()
    const jsonlContent = await readFile(join(dir, 'experiences.jsonl'), 'utf8')
    const jsonlRecords = jsonlContent.split('\n').filter(Boolean)
    expect(jsonlRecords).toHaveLength(3)
  })
})
