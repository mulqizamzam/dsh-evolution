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

describe('E2E: Full evolution cycle', () => {
  let tmpRoot: string
  let store: EvolutionStore
  let deps: ModuleDeps
  const exec = { signal: AbortSignal.timeout(5000) }

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-e2e-'))
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

  it('completes full cycle: record -> analyze -> candidate -> benchmark -> promote -> rollback', async () => {
    // Step 1: Create initial version v1
    const v1 = await store.createVersion({ label: 'Initial baseline', modules: [] })
    expect(v1.id).toBe('v1')

    // Step 2: Record experiences
    const expTools = experienceTools(deps)
    const record = expTools.find(t => t.name === 'evo_experience_record')!
    for (let i = 0; i < 5; i++) {
      await record.execute({
        taskId: `task-${i}`,
        prompt: 'tool selection task',
        success: false,
        errors: ['bad tool selection'],
        stepCount: 10 + i,
        durationMs: 30000 + i * 1000,
      } as never, exec)
    }
    for (let i = 0; i < 3; i++) {
      await record.execute({
        taskId: `task-ok-${i}`,
        prompt: 'simple task',
        success: true,
        score: 0.8 + i * 0.05,
        stepCount: 3,
        durationMs: 10000,
      } as never, exec)
    }

    // Verify
    const listExp = expTools.find(t => t.name === 'evo_experience_list')!
    const listed = await listExp.execute({} as never, exec) as { count: number }
    expect(listed.count).toBe(8)

    // Step 3: Analyze patterns
    const analyzeT = analyzeTools(deps)
    const analyze = analyzeT.find(t => t.name === 'evo_analyze_patterns')!
    const analysisResult = await analyze.execute({ minOccurrences: 3 } as never, exec) as { analyzed: number; detected: number }
    expect(analysisResult.analyzed).toBe(8)
    expect(analysisResult.detected).toBeGreaterThan(0)

    const patterns = await store.listPatterns()
    expect(patterns.length).toBeGreaterThan(0)

    // Step 4: Create candidate
    const candidateT = candidateTools(deps)
    const create = candidateT.find(t => t.name === 'evo_candidate_create')!
    const candidateResult = await create.execute({
      type: 'tool-selection-rule',
      name: 'Smart tool selector',
      description: 'Improve tool selection',
      reason: 'Recurring pattern detected',
      parentVersion: 'v1',
      evidenceIds: [],
      patternIds: [patterns[0].id],
    } as never, exec) as { id: string; status: string }
    expect(candidateResult.id).toBeDefined()
    expect(candidateResult.status).toBe('draft')
    const candidateId = candidateResult.id

    // Step 5: Benchmark candidate
    const benchmarkT = benchmarkTools(deps)
    const benchRun = benchmarkT.find(t => t.name === 'evo_benchmark_run')!
    const benchResult = await benchRun.execute({ candidateId, runs: 3 } as never, exec) as {
      ok: boolean; benchmarkRunId: string; passed: boolean
    }
    expect(benchResult.ok).toBe(true)
    expect(benchResult.benchmarkRunId).toBeDefined()

    // Benchmark may pass or fail depending on thresholds
    if (!benchResult.passed) {
      const candidateAfter = await store.getCandidate(candidateId)
      expect(candidateAfter!.status).toBe('rejected')
      return
    }

    // Step 6: Promote candidate
    const promoteT = promoteTools(deps)
    const promote = promoteT.find(t => t.name === 'evo_promote')!
    const promoteResult = await promote.execute({ candidateId, reason: 'Benchmark passed' } as never, exec) as {
      ok: boolean; version: { id: string; number: number }
    }
    expect(promoteResult.ok).toBe(true)
    expect(promoteResult.version.id).toBe('v2')

    // v1 should be rolled-back
    const v1After = await store.getVersion('v1')
    expect(v1After!.status).toBe('rolled-back')

    // Candidate should be promoted
    const candidateAfter = await store.getCandidate(candidateId)
    expect(candidateAfter!.status).toBe('promoted')

    // Step 7: Rollback to v1
    const rollback = promoteT.find(t => t.name === 'evo_rollback')!
    const rollbackResult = await rollback.execute({ versionId: 'v1' } as never, exec) as {
      ok: boolean; restored: { id: string }; deactivated: string
    }
    expect(rollbackResult.ok).toBe(true)
    expect(rollbackResult.restored.id).toBe('v1')

    const v1Final = await store.getVersion('v1')
    expect(v1Final!.status).toBe('active')
    const v2Final = await store.getVersion('v2')
    expect(v2Final!.status).toBe('rolled-back')

    // Step 8: Check evolution status
    const evoT = evolutionTools(deps)
    const evoStatus = evoT.find(t => t.name === 'evo_status')!
    const status = await evoStatus.execute({} as never, exec) as {
      counts: { experiences: number; patterns: number; candidates: number }
    }
    expect(status.counts.experiences).toBe(8)
    expect(status.counts.patterns).toBeGreaterThan(0)
  })

  it('evo_run_cycle detects patterns from experiences', async () => {
    for (let i = 0; i < 5; i++) {
      await store.addExperience({
        success: false,
        errors: ['timeout: request timed out'],
        stepCount: 15,
        prompt: 'complex task',
      })
    }
    for (let i = 0; i < 5; i++) {
      await store.addExperience({
        success: true,
        score: 0.9,
        stepCount: 3,
        prompt: 'simple task',
      })
    }

    const evoT = evolutionTools(deps)
    const run = evoT.find(t => t.name === 'evo_run_cycle')!
    const result = await run.execute({ analyzeOnly: false } as never, exec) as {
      analyzed: boolean; created: number; patterns: Array<{ id: string }>
    }
    expect(result.analyzed).toBe(true)
    expect(result.patterns.length).toBeGreaterThan(0)
  })
})
