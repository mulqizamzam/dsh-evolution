import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { ModuleDeps } from '../src/host/types.ts'
import { experienceTools } from '../src/host/modules/experience/tools.ts'
import { analyzeTools } from '../src/host/modules/analyze/tools.ts'
import { candidateTools } from '../src/host/modules/candidate/tools.ts'
import { benchmarkTools } from '../src/host/modules/benchmark/tools.ts'
import { promoteTools } from '../src/host/modules/promote/tools.ts'
import { evolutionTools } from '../src/host/modules/evolution/tools.ts'
import type { HostContextShape } from '../src/host/dsh.ts'

describe('Tool definitions', () => {
  let tmpRoot: string
  let store: EvolutionStore
  let deps: ModuleDeps

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-tools-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
    const ctx: HostContextShape = {
      tools: { register: () => {} },
      settings: { writable: true, register: (_ns: string, _schema: unknown, opts: { base?: unknown }) => ({ get: () => opts.base ?? {} }) },
      agents: { get: () => undefined, roots: () => [] },
      get: () => undefined,
      on: () => () => {},
      effect: () => () => {},
    }
    deps = {
      ctx,
      cfg: () => resolveConfig({ stateRoot: tmpRoot }),
      store,
      log: () => {},
      warn: () => {},
    }
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  describe('experienceTools', () => {
    it('returns 3 tools with correct names', () => {
      const tools = experienceTools(deps)
      expect(tools.length).toBe(3)
      const names = tools.map(t => t.name)
      expect(names).toContain('evo_experience_record')
      expect(names).toContain('evo_experience_list')
      expect(names).toContain('evo_experience_inspect')
    })

    it('evo_experience_record has required params', () => {
      const tools = experienceTools(deps)
      const record = tools.find(t => t.name === 'evo_experience_record')!
      const params = record.parameters as { required: string[]; properties: Record<string, unknown> }
      expect(params.required).toContain('success')
      expect(params.properties).toHaveProperty('prompt')
      expect(params.properties).toHaveProperty('score')
    })

    it('evo_experience_record creates a record', async () => {
      const tools = experienceTools(deps)
      const record = tools.find(t => t.name === 'evo_experience_record')!
      const result = await record.execute(
        { success: true, prompt: 'test', score: 0.9 } as never,
        { signal: AbortSignal.timeout(1000) },
      ) as Record<string, unknown>
      // Returns the raw experience record object (neutralizeDeep)
      expect(result).toHaveProperty('id')
      expect(result).toHaveProperty('success')
      expect(result.success).toBe(true)
    })

    it('evo_experience_list returns count and records', async () => {
      const tools = experienceTools(deps)
      const list = tools.find(t => t.name === 'evo_experience_list')!
      const result = await list.execute(
        {} as never,
        { signal: AbortSignal.timeout(1000) },
      ) as { count: number }
      expect(result.count).toBe(0)
    })
  })

  describe('analyzeTools', () => {
    it('returns 2 tools', () => {
      const tools = analyzeTools(deps)
      expect(tools.length).toBe(2)
      expect(tools.map(t => t.name)).toContain('evo_analyze_patterns')
      expect(tools.map(t => t.name)).toContain('evo_analyze_report')
    })

    it('analyze_patterns works with empty store', async () => {
      const tools = analyzeTools(deps)
      const analyze = tools.find(t => t.name === 'evo_analyze_patterns')!
      const result = await analyze.execute(
        {} as never,
        { signal: AbortSignal.timeout(1000) },
      ) as { analyzed: number; detected: number }
      // No experiences -> 0 analyzed, 0 patterns
      expect(result.analyzed).toBe(0)
      expect(result.detected).toBe(0)
    })

    it('analyze_patterns deduplicates: second call creates no new patterns', async () => {
      // Seed experiences that produce a recurring failure pattern.
      for (let i = 0; i < 5; i++) {
        await store.addExperience({
          success: false,
          errors: ['TimeoutError: request timed out'],
          stepCount: 12,
          prompt: 'complex task',
        })
      }
      const tools = analyzeTools(deps)
      const analyze = tools.find(t => t.name === 'evo_analyze_patterns')!
      // First call: detects and persists patterns.
      const first = await analyze.execute(
        { minOccurrences: 3 } as never,
        { signal: AbortSignal.timeout(2000) },
      ) as { detected: number; patterns: Array<{ id: string }> }
      expect(first.detected).toBeGreaterThan(0)
      const countAfterFirst = (await store.listPatterns(500)).length
      expect(countAfterFirst).toBeGreaterThan(0)

      // Second call with same data: should detect same patterns but persist NONE (dedup).
      const second = await analyze.execute(
        { minOccurrences: 3 } as never,
        { signal: AbortSignal.timeout(2000) },
      ) as { detected: number; patterns: Array<{ id: string }> }
      expect(second.detected).toBe(0)
      expect(second.patterns).toHaveLength(0)
      const countAfterSecond = (await store.listPatterns(500)).length
      expect(countAfterSecond).toBe(countAfterFirst)
    })
  })

  describe('candidateTools', () => {
    it('returns 3 tools', () => {
      const tools = candidateTools(deps)
      expect(tools.length).toBe(3)
      expect(tools.map(t => t.name)).toContain('evo_candidate_create')
      expect(tools.map(t => t.name)).toContain('evo_candidate_list')
      expect(tools.map(t => t.name)).toContain('evo_candidate_inspect')
    })

    it('candidate_create creates a draft candidate', async () => {
      const tools = candidateTools(deps)
      const create = tools.find(t => t.name === 'evo_candidate_create')!
      const result = await create.execute(
        {
          type: 'policy',
          name: 'retry policy',
          description: 'Retry failed tool calls',
          reason: 'High failure rate observed',
          parentVersion: 'v1',
        } as never,
        { signal: AbortSignal.timeout(1000) },
      ) as { status: string; id: string; name: string }
      // Returns neutralizeDeep(candidate) with status field
      expect(result.id).toBeDefined()
      expect(result.name).toBe('retry policy')
    })

    it('candidate_create defaults to draft status', async () => {
      const tools = candidateTools(deps)
      const create = tools.find(t => t.name === 'evo_candidate_create')!
      const result = await create.execute(
        { type: 'policy', name: 'x', description: 'y', reason: 'z', parentVersion: 'v0' } as never,
        { signal: AbortSignal.timeout(1000) },
      ) as Record<string, unknown>
      expect(result.status).toBe('draft')
    })
  })

  describe('benchmarkTools', () => {
    it('returns 5 tools', () => {
      const tools = benchmarkTools(deps)
      expect(tools.length).toBe(5)
      expect(tools.map(t => t.name)).toContain('evo_benchmark_run')
      expect(tools.map(t => t.name)).toContain('evo_benchmark_compare')
      expect(tools.map(t => t.name)).toContain('evo_benchmark_live')
      expect(tools.map(t => t.name)).toContain('evo_benchmark_ab')
      expect(tools.map(t => t.name)).toContain('evo_benchmark_manifest')
    })

    it('benchmark_run handles non-existent candidate', async () => {
      const tools = benchmarkTools(deps)
      const run = tools.find(t => t.name === 'evo_benchmark_run')!
      const result = await run.execute(
        { candidateId: 'nonexistent' } as never,
        { signal: AbortSignal.timeout(1000) },
      ) as Record<string, unknown>
      expect(result).toBeDefined()
    })
  })

  describe('promoteTools', () => {
    it('returns 4 tools', () => {
      const tools = promoteTools(deps)
      expect(tools.length).toBe(4)
      expect(tools.map(t => t.name)).toContain('evo_promote')
      expect(tools.map(t => t.name)).toContain('evo_rollback')
      expect(tools.map(t => t.name)).toContain('evo_promote_list')
      expect(tools.map(t => t.name)).toContain('evo_promote_decision')
    })

    it('promote rejects non-benchmarked candidate', async () => {
      const candidate = await store.addCandidate({
        parentVersion: 'v1',
        type: 'policy',
        name: 'test',
        description: 'test',
        reason: 'test',
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
      const tools = promoteTools(deps)
      const promote = tools.find(t => t.name === 'evo_promote')!
      const result = await promote.execute(
        { candidateId: candidate.id } as never,
        { signal: AbortSignal.timeout(1000) },
      ) as { ok: boolean; error: string }
      expect(result.ok).toBe(false)
      expect(result.error).toContain('benchmarked')
    })

    it('promote rejects validated candidate (must go through benchmark)', async () => {
      const candidate = await store.addCandidate({
        parentVersion: 'v1',
        type: 'policy',
        name: 'test-validated',
        description: 'test',
        reason: 'test',
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
        status: 'validated',
      })
      const tools = promoteTools(deps)
      const promote = tools.find(t => t.name === 'evo_promote')!
      const result = await promote.execute(
        { candidateId: candidate.id } as never,
        { signal: AbortSignal.timeout(1000) },
      ) as { ok: boolean; error: string }
      expect(result.ok).toBe(false)
      expect(result.error).toContain('benchmarked')
    })

    it('rollback to already-active version returns ok:false with explicit message', async () => {
      await store.createVersion({ label: 'v1', modules: [] })
      const tools = promoteTools(deps)
      const rollback = tools.find(t => t.name === 'evo_rollback')!
      const result = await rollback.execute(
        { versionId: 'v1' } as never,
        { signal: AbortSignal.timeout(1000) },
      ) as { ok: boolean; error: string }
      expect(result.ok).toBe(false)
      expect(result.error).toContain('already active')
    })
  })

  describe('evolutionTools', () => {
    it('returns 3 tools', () => {
      const tools = evolutionTools(deps)
      expect(tools.length).toBe(3)
      expect(tools.map(t => t.name)).toContain('evo_status')
      expect(tools.map(t => t.name)).toContain('evo_run_cycle')
      expect(tools.map(t => t.name)).toContain('evo_full_cycle')
    })

    it('evo_status shows initial state', async () => {
      const tools = evolutionTools(deps)
      const status = tools.find(t => t.name === 'evo_status')!
      const result = await status.execute(
        {} as never,
        { signal: AbortSignal.timeout(1000) },
      ) as { activeVersion: unknown; counts: { experiences: number } }
      expect(result.activeVersion).toBeDefined()
      expect(result.counts.experiences).toBe(0)
    })
  })
})
