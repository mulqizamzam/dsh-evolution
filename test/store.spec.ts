import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvolutionStore } from '../src/host/store.ts'

describe('EvolutionStore', () => {
  let tmpRoot: string
  let store: EvolutionStore

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-test-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('initializes state root with required directories', async () => {
    const root = store.getRoot()
    expect(root).toBe(tmpRoot)
  })

  describe('Experience', () => {
    it('adds and retrieves an experience', async () => {
      const record = await store.addExperience({
        success: true,
        prompt: 'test task',
        score: 0.9,
      })
      expect(record.id).toBeDefined()
      expect(record.timestamp).toBeDefined()
      expect(record.success).toBe(true)
      expect(record.prompt).toBe('test task')

      const retrieved = await store.getExperience(record.id)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.id).toBe(record.id)
    })

    it('lists both experiences', async () => {
      await store.addExperience({ success: true, prompt: 'first' })
      await store.addExperience({ success: false, prompt: 'second' })
      const list = await store.listExperiences()
      expect(list.length).toBe(2)
      const prompts = list.map(r => r.prompt); expect(prompts).toContain('first'); expect(prompts).toContain('second')
    })
  })

  describe('Pattern', () => {
    it('adds and lists patterns', async () => {
      await store.addPattern({
        type: 'failure',
        evidence: 'FACT',
        description: 'recurring error',
        occurrences: 5,
        evidenceIds: ['exp1'],
        confidence: 0.7,
      })
      const patterns = await store.listPatterns()
      expect(patterns.length).toBe(1)
      expect(patterns[0].type).toBe('failure')
    })
  })

  describe('Candidate', () => {
    it('adds, retrieves, updates, and lists candidates', async () => {
      const candidate = await store.addCandidate({
        parentVersion: 'v1',
        type: 'policy',
        name: 'test policy',
        description: 'test',
        reason: 'test reason',
        evidenceIds: [],
        patternIds: [],
        files: [],
        tests: [],
        benchmarkConfig: {
          successRate: { min: 0.7, weight: 0.3 },
          avgScore: { min: 0.6, weight: 0.25 },
          errorRate: { max: 0.3, weight: 0.2 },
          avgSteps: { max: 20, weight: 0.15 },
          avgDurationMs: { max: 60000, weight: 0.1 },
        },
        status: 'draft',
      })
      expect(candidate.id).toBeDefined()
      expect(candidate.status).toBe('draft')

      const retrieved = await store.getCandidate(candidate.id)
      expect(retrieved).not.toBeNull()

      const updated = await store.updateCandidate(candidate.id, { status: 'validated' })
      expect(updated!.status).toBe('validated')
    })
  })

  describe('Version', () => {
    it('creates, lists, and rollback versions', async () => {
      const v1 = await store.createVersion({ label: 'initial', modules: [] })
      expect(v1.id).toBe('v1')
      expect(v1.status).toBe('active')

      const v2 = await store.createVersion({ label: 'improved', promotedFrom: 'candidate1', modules: ['mod.ts'] })
      expect(v2.id).toBe('v2')
      expect(v2.status).toBe('active')

      // After creating v2, v1 should be rolled-back
      const v1After = await store.getVersion('v1')
      expect(v1After!.status).toBe('rolled-back')

      // Rollback to v1
      const result = await store.rollbackVersion('v1')
      expect(result).not.toBeNull()
      // The returned version was the target before update
      expect(result!.restored.id).toBe('v1')
      expect(result!.deactivated).not.toBeNull()
      expect(result!.deactivated!.id).toBe('v2')

      // Verify on disk: v1 now active, v2 now rolled-back
      const v1Final = await store.getVersion('v1')
      expect(v1Final!.status).toBe('active')
      const v2Final = await store.getVersion('v2')
      expect(v2Final!.status).toBe('rolled-back')
    })

    it('rollback to already-active version returns alreadyActive:true', async () => {
      await store.createVersion({ label: 'v1', modules: [] })
      const result = await store.rollbackVersion('v1')
      expect(result).not.toBeNull()
      expect(result!.alreadyActive).toBe(true)
      expect(result!.restored.id).toBe('v1')
      expect(result!.deactivated).toBeNull()
    })

    it('rollback to non-existent version returns null', async () => {
      const result = await store.rollbackVersion('v99')
      expect(result).toBeNull()
    })
  })

  describe('Benchmark', () => {
    it('adds and lists benchmarks', async () => {
      const benchCreatedAt = new Date().toISOString()
      const run = await store.addBenchmark({
        candidateId: 'c1',
        version: 'v1',
        baseline: 'current',
        runs: 3,
        metrics: { successRate: 0.9, avgScore: 0.8, errorRate: 0.05, avgSteps: 5, avgDurationMs: 20000 },
        passed: true,
        details: 'all metrics improved',
      }, benchCreatedAt)
      expect(run.id).toBeDefined()

      const list = await store.listBenchmarks()
      expect(list.length).toBe(1)
    })
  })
})
