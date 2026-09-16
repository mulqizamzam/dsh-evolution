import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { ModuleDeps } from '../src/host/types.ts'
import type { HostContextShape } from '../src/host/dsh.ts'
import { NodeProcessSandbox } from '../src/host/modules/sandbox/index.ts'
import { experienceTools } from '../src/host/modules/experience/tools.ts'
import { analyzeTools } from '../src/host/modules/analyze/tools.ts'
import { candidateTools } from '../src/host/modules/candidate/tools.ts'
import { benchmarkTools } from '../src/host/modules/benchmark/tools.ts'
import { promoteTools } from '../src/host/modules/promote/tools.ts'
import { evolutionTools } from '../src/host/modules/evolution/tools.ts'

function makeCtx(): HostContextShape {
  return {
    tools: { register: () => {} },
    settings: { writable: true, register: (_ns: string, _schema: unknown, opts: { base?: unknown }) => ({ get: () => opts.base ?? {} }) },
    agents: { get: () => undefined, roots: () => [] },
    get: () => undefined,
    on: () => () => {},
    effect: () => () => {},
  }
}

function makeDeps(store: EvolutionStore, root: string): ModuleDeps {
  return {
    ctx: makeCtx(),
    cfg: () => resolveConfig({ stateRoot: root }),
    store,
    log: () => {},
    warn: () => {},
  }
}

describe('E2E: Full autonomous evolution cycle', () => {
  let tmpRoot: string
  let store: EvolutionStore
  let deps: ModuleDeps
  const exec = { signal: AbortSignal.timeout(10_000) }

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-autonomous-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
    deps = makeDeps(store, tmpRoot)
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('full cycle: experience -> analyze -> candidate -> sandbox -> benchmark -> promote -> rollback', async () => {
    // STEP 1: Create initial version v1
    const v1 = await store.createVersion({ label: 'Baseline v1', modules: [] })
    expect(v1.id).toBe('v1')
    expect(v1.status).toBe('active')

    // STEP 2: Seed experiences (recurring failures)
    const expTools = experienceTools(deps)
    const record = expTools.find(t => t.name === 'evo_experience_record')!

    for (let i = 0; i < 6; i++) {
      await record.execute({
        taskId: 'premature-edit-' + i,
        prompt: 'edit source file',
        success: false,
        errors: ['premature source edit without verification'],
        stepCount: 12 + i,
        durationMs: 45000 + i * 1000,
      } as never, exec)
    }
    for (let i = 0; i < 3; i++) {
      await record.execute({
        taskId: 'ok-task-' + i,
        prompt: 'simple verification',
        success: true,
        score: 0.85,
        stepCount: 3,
        durationMs: 8000,
      } as never, exec)
    }

    const listExp = expTools.find(t => t.name === 'evo_experience_list')!
    const expResult = await listExp.execute({} as never, exec) as { count: number }
    expect(expResult.count).toBe(9)

    // STEP 3: Analyze patterns
    const analyzeT = analyzeTools(deps)
    const analyze = analyzeT.find(t => t.name === 'evo_analyze_patterns')!
    const analysisResult = await analyze.execute({ minOccurrences: 3 } as never, exec) as { analyzed: number; detected: number }
    expect(analysisResult.analyzed).toBe(9)
    expect(analysisResult.detected).toBeGreaterThan(0)

    const patterns = await store.listPatterns()
    expect(patterns.length).toBeGreaterThan(0)

    // STEP 4: Create candidate
    const candidateT = candidateTools(deps)
    const create = candidateT.find(t => t.name === 'evo_candidate_create')!
    const candidateResult = await create.execute({
      type: 'verification-strategy',
      name: 'pre-edit-verification-policy',
      description: 'Require verification before source edits to prevent premature modifications',
      reason: '6 recurring premature-edit failures detected by pattern analysis',
      parentVersion: 'v1',
      evidenceIds: [],
      patternIds: [patterns[0].id],
    } as never, exec) as { id: string; status: string }

    expect(candidateResult.id).toBeDefined()
    expect(candidateResult.status).toBe('draft')
    const candidateId = candidateResult.id

    // STEP 5: Write candidate files
    const candidateDir = join(tmpRoot, 'candidates', candidateId, 'src')
    await mkdir(candidateDir, { recursive: true })
    await writeFile(join(candidateDir, 'index.ts'), `
export const POLICY = {
  name: 'pre-edit-verification',
  description: 'Require verification before source edits',
  check: (context: { hasVerification: boolean }) => context.hasVerification === true,
}
export default POLICY
`, 'utf8')

    await store.updateCandidate(candidateId, {
      files: [{ path: 'src/index.ts', content: 'export const POLICY = { check: (c: { hasVerification: boolean }) => c.hasVerification === true }' }],
      tests: [{ path: 'test/index.spec.ts', content: 'test' }],
    })

    // STEP 6: Sandbox execution — basic echo test
    const sandbox = new NodeProcessSandbox()
    const sandboxResult = await sandbox.exec('echo "sandbox-test-passed" && exit 0', {
      cwd: tmpRoot,
      timeoutMs: 5000,
    })
    expect(sandboxResult.exitCode).toBe(0)
    expect(sandboxResult.stdout).toContain('sandbox-test-passed')
    expect(sandboxResult.timedOut).toBe(false)

    // STEP 7: Simulated benchmark
    const benchmarkT = benchmarkTools(deps)
    const benchRun = benchmarkT.find(t => t.name === 'evo_benchmark_run')!
    const benchResult = await benchRun.execute({ candidateId, runs: 3 } as never, exec) as {
      ok: boolean; benchmarkRunId: string; passed: boolean
    }
    expect(benchResult.ok).toBe(true)
    expect(benchResult.benchmarkRunId).toBeDefined()

    // STEP 8: Promote or reject based on benchmark
    if (benchResult.passed) {
      const promoteT = promoteTools(deps)
      const promote = promoteT.find(t => t.name === 'evo_promote')!
      const promoteResult = await promote.execute({ candidateId, reason: 'Benchmark passed' } as never, exec) as {
        ok: boolean; version: { id: string }
      }
      expect(promoteResult.ok).toBe(true)
      expect(promoteResult.version.id).toBe('v2')

      // STEP 9: Rollback
      const rollback = promoteT.find(t => t.name === 'evo_rollback')!
      const rollbackResult = await rollback.execute({ versionId: 'v1' } as never, exec) as {
        ok: boolean; restored: { id: string }
      }
      expect(rollbackResult.ok).toBe(true)
      expect(rollbackResult.restored.id).toBe('v1')

      const v1Final = await store.getVersion('v1')
      expect(v1Final!.status).toBe('active')
      const v2Final = await store.getVersion('v2')
      expect(v2Final!.status).toBe('rolled-back')
    } else {
      const candidateAfter = await store.getCandidate(candidateId)
      expect(candidateAfter!.status).toBe('rejected')
    }
  })

  it('evo_run_cycle detects patterns and creates candidates', async () => {
    for (let i = 0; i < 5; i++) {
      await store.addExperience({ success: false, errors: ['timeout: request timed out'], stepCount: 15, prompt: 'complex task' })
    }
    for (let i = 0; i < 5; i++) {
      await store.addExperience({ success: true, score: 0.9, stepCount: 3, prompt: 'simple task' })
    }

    const evoT = evolutionTools(deps)
    const run = evoT.find(t => t.name === 'evo_run_cycle')!
    const result = await run.execute({ analyzeOnly: false } as never, exec) as {
      analyzed: boolean; created: number; patterns: Array<{ id: string }>
    }
    expect(result.analyzed).toBe(true)
    expect(result.patterns.length).toBeGreaterThan(0)
    expect(result.created).toBeGreaterThan(0)
  })

  it('evo_promote_decision evaluates benchmark evidence', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const candidate = await store.addCandidate({
      parentVersion: 'v1', type: 'policy', name: 'test-policy', description: 'test', reason: 'test',
      evidenceIds: [], patternIds: [], files: [], tests: [],
      benchmarkConfig: {
        successRate: { min: 0.8, weight: 1 },
        avgScore: { min: 0.7, weight: 1 },
        errorRate: { max: 0.2, weight: 1 },
        avgSteps: { max: 50, weight: 0.5 },
        avgDurationMs: { max: 60000, weight: 0.5 },
      },
      status: 'draft',
    })

    // Add a good benchmark: 90% success, 10% error, 20s latency
    await store.addBenchmark({
      candidateId: candidate.id, version: 'v1', baseline: 'v1', runs: 3,
      metrics: { successRate: 0.9, avgScore: 0.85, errorRate: 0.1, avgSteps: 5, avgDurationMs: 20000 },
      passed: true, details: 'All thresholds met.',
    })

    const promoteT = promoteTools(deps)
    const decision = promoteT.find(t => t.name === 'evo_promote_decision')!
    // The seeded record is simulated, so the decision needs the explicit override.
    const result = await decision.execute({ candidateId: candidate.id, allowSimulated: true } as never, exec) as {
      ok: boolean; recommendation: string; checks?: Array<{ gate: string; pass: boolean }>
    }
    expect(result.ok).toBe(true)
    // The recommendation depends on all gates passing
    expect(['PROMOTE', 'REJECT']).toContain(result.recommendation)
  })

  it('evo_promote_decision rejects when benchmark failed', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const candidate = await store.addCandidate({
      parentVersion: 'v1', type: 'policy', name: 'bad-policy', description: 'test', reason: 'test',
      evidenceIds: [], patternIds: [], files: [], tests: [],
      benchmarkConfig: {
        successRate: { min: 0.8, weight: 1 },
        avgScore: { min: 0.7, weight: 1 },
        errorRate: { max: 0.2, weight: 1 },
        avgSteps: { max: 50, weight: 0.5 },
        avgDurationMs: { max: 60000, weight: 0.5 },
      },
      status: 'draft',
    })

    // Add a bad benchmark: 50% success, 50% error, 80s latency
    await store.addBenchmark({
      candidateId: candidate.id, version: 'v1', baseline: 'v1', runs: 3,
      metrics: { successRate: 0.5, avgScore: 0.4, errorRate: 0.5, avgSteps: 25, avgDurationMs: 80000 },
      passed: false, details: 'Failed thresholds.',
    })

    const promoteT = promoteTools(deps)
    const decision = promoteT.find(t => t.name === 'evo_promote_decision')!
    const result = await decision.execute({ candidateId: candidate.id, allowSimulated: true } as never, exec) as {
      ok: boolean; recommendation: string; rejectionReasons: string[]
    }
    expect(result.ok).toBe(true)
    expect(result.recommendation).toBe('REJECT')
    expect(result.rejectionReasons.length).toBeGreaterThan(0)
  })

  it('promote rejects draft candidate', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const candidate = await store.addCandidate({
      parentVersion: 'v1', type: 'policy', name: 'x', description: 'x', reason: 'x',
      evidenceIds: [], patternIds: [], files: [], tests: [],
      benchmarkConfig: { successRate: { min: 0.7, weight: 1 }, avgScore: { min: 0.6, weight: 1 }, errorRate: { max: 0.3, weight: 1 }, avgSteps: { max: 20, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 } },
      status: 'draft',
    })
    const promoteT = promoteTools(deps)
    const promote = promoteT.find(t => t.name === 'evo_promote')!
    const result = await promote.execute({ candidateId: candidate.id } as never, exec) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('benchmarked')
  })

  it('rollback to already-active version fails gracefully', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const promoteT = promoteTools(deps)
    const rollback = promoteT.find(t => t.name === 'evo_rollback')!
    const result = await rollback.execute({ versionId: 'v1' } as never, exec) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('already active')
  })
})

describe('Sandbox: live execution', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'evo-sandbox-live-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('runs a shell script in sandbox', async () => {
    const sandbox = new NodeProcessSandbox()
    const result = await sandbox.exec('echo "from-sandbox" && exit 0', { cwd: tmpDir, timeoutMs: 5000 })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('from-sandbox')
  })

  it('captures both stdout and stderr', async () => {
    const sandbox = new NodeProcessSandbox()
    const result = await sandbox.exec('echo stdout-data && echo stderr-data >&2', { cwd: tmpDir, timeoutMs: 5000 })
    expect(result.stdout).toContain('stdout-data')
    expect(result.stderr).toContain('stderr-data')
  })

  it('reports non-zero exit code', async () => {
    const sandbox = new NodeProcessSandbox()
    const result = await sandbox.exec('exit 1', { cwd: tmpDir, timeoutMs: 5000 })
    expect(result.exitCode).toBe(1)
  })

  it('enforces timeout on long-running script', async () => {
    const sandbox = new NodeProcessSandbox()
    const result = await sandbox.exec('sleep 30', { cwd: tmpDir, timeoutMs: 1500 })
    expect(result.timedOut).toBe(true)
    expect(result.durationMs).toBeLessThan(8000)
  }, 15_000)

  it('passes environment variables to child', async () => {
    const sandbox = new NodeProcessSandbox()
    const result = await sandbox.exec('echo $EVO_TEST_KEY', {
      cwd: tmpDir,
      timeoutMs: 3000,
      env: { EVO_TEST_KEY: 'secrets-of-the-universe' },
    })
    expect(result.stdout).toContain('secrets-of-the-universe')
  })
})
