import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { createLiveProvenance } from '../src/lib/provenance.ts'
import { isoDateTime } from '../src/lib/ids.ts'
import type { ModuleDeps } from '../src/host/types.ts'
import type { HostContextShape } from '../src/host/dsh.ts'
import { NodeProcessSandbox } from '../src/host/modules/sandbox/index.ts'
import { makeFakeHost } from './helpers/fake-host.ts'

function makeHostCtx(): HostContextShape {
  const llm = {
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: '{"manifest":{"name":"smoke-test","version":"1.0.0","type":"policy","description":"Smoke test module","entryPoint":"src/index.ts","benchmarkCases":[{"id":"c1","description":"Basic test","input":"hello","timeoutMs":5000,"successCriteria":"exit 0"}]},"files":[{"path":"src/index.ts","content":"export default function check(): boolean { return true }"}],"tests":[{"path":"test/index.spec.ts","content":"export const t = 1"}]}' }
      yield { type: 'usage', index: 0, usage: { inputTokens: 100, outputTokens: 200 } }
      yield { type: 'finish', index: 0, reason: { kind: 'stop' } }
    },
  }
  return makeFakeHost({
    providers: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'glm', model: 'glm-4-flash' }) },
      llm,
    },
  }).ctx
}

function makeDeps(store: EvolutionStore, root: string, ctx?: HostContextShape): ModuleDeps {
  return {
    ctx: ctx ?? makeHostCtx(),
    cfg: () => ({
      stateRoot: root, inject: { enabled: true },
      experience: { maxRecords: 10000, retentionDays: 90 },
      candidate: { maxActive: 10 },
      benchmark: { minRuns: 3, maxRuns: 10, improvementThreshold: 0.05, regressionThreshold: 0.10 },
      evolution: {
        enabled: true, autoRecord: true, autoTrigger: true,
        analysis: { minExperiences: 20, minOccurrences: 5 },
        generation: { enabled: false }, promotion: { enabled: false }, maxCyclesPerProcess: 3,
      },
    }),
    store,
    log: () => {},
    warn: () => {},
  }
}

describe('Runtime smoke test', () => {
  let tmpRoot: string
  let store: EvolutionStore

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-smoke-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
    delete (globalThis as Record<string, unknown>).__evoHookRegistered
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
    delete (globalThis as Record<string, unknown>).__evoHookRegistered
  })

  it('SMOKE: reads agent-default-model and calls host LLM', async () => {
    const deps = makeDeps(store, tmpRoot)

    for (let i = 0; i < 6; i++) {
      await store.addExperience({ success: false, errors: ['timeout'], stepCount: 15, prompt: 'complex' })
    }

    const { analyzeTools } = await import('../src/host/modules/analyze/tools.ts')
    const analyze = analyzeTools(deps).find(t => t.name === 'evo_analyze_patterns')!
    await analyze.execute({ minOccurrences: 3 } as never, { signal: AbortSignal.timeout(5000) })

    const patterns = await store.listPatterns()
    expect(patterns.length).toBeGreaterThan(0)

    const { builderTools } = await import('../src/host/modules/builder/tools.ts')
    const builder = builderTools(deps).find(t => t.name === 'evo_builder_generate')!
    const result = await builder.execute({
      patternIds: [patterns[0].id],
      parentVersion: 'v1',
    } as never, { signal: AbortSignal.timeout(10000) }) as { ok: boolean; candidateId?: string; llmUsage?: { totalTokens: number } }

    expect(result.ok).toBe(true)
    expect(result.candidateId).toBeDefined()
    expect(result.llmUsage!.inputTokens).toBe(100)
    expect(result.llmUsage!.outputTokens).toBe(200)
    expect(result.llmUsage!.totalTokens).toBe(300)

    const candidate = await store.getCandidate(result.candidateId!)
    expect(candidate!.name).toBe('smoke-test')
  })

  it('SMOKE: session/event hook registered', async () => {
    const host = makeFakeHost()
    const { apply } = await import('../src/host/modules/auto-experience/index.ts')
    apply(makeDeps(store, tmpRoot, host.ctx))
    expect(host.listeners('session/event').length).toBeGreaterThan(0)
    // and the observation tools were registered on the host
    expect(host.tools()).toContain('evo_auto_record')
    expect(host.tools()).toContain('evo_observe_state')
  })

  it('SMOKE: real sandbox execution', async () => {
    const sandbox = new NodeProcessSandbox()
    const testDir = join(tmpRoot, 'candidate-files')
    await mkdir(testDir, { recursive: true })

    // Use echo to verify sandbox works — the NodeProcessSandbox runs /bin/sh
    const result = await sandbox.exec('echo "PASS-42" && exit 0', { cwd: testDir, timeoutMs: 10000 })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('PASS-42')
    expect(result.timedOut).toBe(false)
  })

  it('SMOKE: full lifecycle end-to-end', async () => {
    const baseline = await store.createVersion({ label: 'baseline', modules: [] })
    expect(baseline.id).toBe('v1')

    for (let i = 0; i < 8; i++) {
      await store.addExperience({ success: false, errors: ['premature edit'], stepCount: 12, prompt: 'edit' })
    }
    for (let i = 0; i < 4; i++) {
      await store.addExperience({ success: true, score: 0.9, stepCount: 3, prompt: 'verify' })
    }

    const deps = makeDeps(store, tmpRoot)
    const { analyzeTools } = await import('../src/host/modules/analyze/tools.ts')
    const analysis = await analyzeTools(deps).find(t => t.name === 'evo_analyze_patterns')!
      .execute({ minOccurrences: 3 } as never, { signal: AbortSignal.timeout(5000) }) as { detected: number }
    expect(analysis.detected).toBeGreaterThan(0)

    const patterns = await store.listPatterns()
    const { candidateTools } = await import('../src/host/modules/candidate/tools.ts')
    const candResult = await candidateTools(deps).find(t => t.name === 'evo_candidate_create')!
      .execute({
        type: 'policy', name: 'pre-edit-verify', description: 'verify before edit',
        reason: 'pattern', parentVersion: 'v1',
        patternIds: [patterns[0].id], evidenceIds: [],
      } as never, { signal: AbortSignal.timeout(5000) }) as { id: string }
    const candidateId = candResult.id

    await store.updateCandidate(candidateId, {
      files: [{ path: 'src/index.ts', content: 'export default function verify() { return true }' }],
      tests: [{ path: 'test/index.spec.ts', content: 'test' }],
    })

    const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
    const liveResult = await benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!
      .execute({ candidateId, command: 'echo "LIVE-PASS"', timeoutMs: 10000 } as never, { signal: AbortSignal.timeout(15000) }) as { ok: boolean; executionResult: { stdout: string; exitCode: number | null } }
    expect(liveResult.ok).toBe(true)
    expect(liveResult.executionResult.stdout).toContain('LIVE-PASS')
    expect(liveResult.executionResult.exitCode).toBe(0)

    const createdAt = isoDateTime(new Date())
    const command = 'echo "LIVE-PASS"'
    await store.addBenchmark({
      candidateId, version: 'v1', baseline: 'v1', parentVersion: 'v1', runs: 3,
      metrics: { successRate: 0.95, avgScore: 0.9, errorRate: 0.05, avgSteps: 4, avgDurationMs: 8000 },
      passed: true, details: 'All thresholds met.',
      mode: 'live',
      command,
      provenance: createLiveProvenance(candidateId, 'v1', command, createdAt),
    }, createdAt)
    await store.updateCandidate(candidateId, { status: 'benchmarked' })

    const { promoteTools } = await import('../src/host/modules/promote/tools.ts')
    const promoted = await promoteTools(deps).find(t => t.name === 'evo_promote')!
      .execute({ candidateId, reason: 'smoke' } as never, { signal: AbortSignal.timeout(5000) }) as { ok: boolean; version: { id: string } }
    expect(promoted.ok).toBe(true)

    const v1 = await store.getVersion('v1')
    expect(v1!.status).toBe('rolled-back')
    const v2 = await store.getVersion(promoted.version.id)
    expect(v2!.status).toBe('active')

    const rolled = await promoteTools(deps).find(t => t.name === 'evo_rollback')!
      .execute({ versionId: 'v1' } as never, { signal: AbortSignal.timeout(5000) }) as { ok: boolean }
    expect(rolled.ok).toBe(true)

    const v1Final = await store.getVersion('v1')
    expect(v1Final!.status).toBe('active')
    const v2Final = await store.getVersion(promoted.version.id)
    expect(v2Final!.status).toBe('rolled-back')
  })
})
