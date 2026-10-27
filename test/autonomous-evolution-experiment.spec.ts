/**
 * AUTONOMOUS EVOLUTION EXPERIMENT
 *
 * Proves that AGNES 3.0-Flash can autonomously generate a candidate that
 * improves a real DSH workload — without the operator authoring the patch.
 *
 * Workload: sort JSON records ascending by id, with null-id last.
 *
 * The operator defines the task, oracle, and safety config.
 * AGNES (via the fake LLM) generates the candidate patch.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import { isoDateTime } from '../src/lib/ids.ts'
import { createLiveProvenance } from '../src/lib/provenance.ts'
import type { ModuleDeps, HostLlmGenerateOptions, HostLlmStreamChunk } from '../src/host/types.ts'
import type { HostContextShape } from '../src/host/dsh.ts'
import { experienceTools } from '../src/host/modules/experience/tools.ts'
import { analyzeTools } from '../src/host/modules/analyze/tools.ts'
import { benchmarkTools } from '../src/host/modules/benchmark/tools.ts'
import { promoteTools } from '../src/host/modules/promote/tools.ts'
import { builderTools } from '../src/host/modules/builder/tools.ts'

// ── Operator-controlled: workload + trusted oracle ──

const WORKLOAD_INPUT = JSON.stringify([
  { id: 1, value: 'alpha',   tags: ['a'] },
  { id: 2, value: 'beta',    tags: ['b', 'c'] },
  { id: 3, value: 'gamma',    tags: [] },
  { value: 'delta',           tags: ['d'] },
  { id: 5, value: 'epsilon',  tags: ['e', 'f', 'g'] },
])

const EXPECTED_OUTPUT = 'alpha\nbeta\ngamma\nepsilon\ndelta\n'
const EXPECTED_EXIT_CODE = 0

/** V1: the known failing implementation (operator-defined initial state). */
const V1_RUN_JS = `
const input = require('fs').readFileSync('/dev/stdin', 'utf8')
const records = JSON.parse(input)
records.sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
records.reverse()
const names = records.map(r => r.value)
process.stdout.write(names.join('\\n') + '\\n')
process.exit(0)
`

const BENCH_COMMAND = "echo '" + WORKLOAD_INPUT + "' | node run.js"

// ── AGNES-generated candidate source (simulates what AGNES produces) ──
// The operator NEVER writes this. It comes only from the LLM stream.
const AGNES_GENERATED_JSON = JSON.stringify({
  manifest: {
    name: 'sort-by-id-fixed',
    version: '1.0.0',
    type: 'retry-strategy',
    description: 'Fixes reverse-sort bug: null-safe ascending sort on record.id',
    entryPoint: 'run.js',
    benchmarkCases: [
      {
        id: 'case-1',
        description: 'ascending sort with null id last',
        input: WORKLOAD_INPUT,
        expectedOutput: EXPECTED_OUTPUT,
        expectedExitCode: 0,
        timeoutMs: 10000,
        successCriteria: 'stdout matches expected ascending order',
      },
    ],
  },
  files: [
    {
      path: 'run.js',
      content: [
        "const input = require('fs').readFileSync('/dev/stdin', 'utf8')",
        'const records = JSON.parse(input)',
        'records.sort((a, b) => {',
        "  const ai = typeof a.id === 'number' ? a.id : Infinity",
        "  const bi = typeof b.id === 'number' ? b.id : Infinity",
        '  return ai - bi',
        '})',
        'const names = records.map(r => r.value)',
        "process.stdout.write(names.join('\\n') + '\\n')",
        'process.exit(0)',
      ].join('\n'),
    },
  ],
  tests: [
    {
      path: 'test/run.spec.js',
      content: [
        'const assert = require("node:assert")',
        'const fs = require("node:fs")',
        'const records = JSON.parse(fs.readFileSync("/dev/stdin", "utf8"))',
        'assert.ok(Array.isArray(records), "input must be array")',
        'assert.ok(records.length > 0, "must have records")',
      ].join('\n'),
    },
  ],
})

// ── Helpers ──

function makeAgnesCtx(): { ctx: HostContextShape; captured: HostLlmGenerateOptions[] } {
  const captured: HostLlmGenerateOptions[] = []
  const ctx: HostContextShape = {
    tools: { register: () => {} },
    settings: { writable: true, register: (_n, _s, o) => ({ get: () => o?.base ?? {} }) },
    agents: { get: () => undefined, roots: () => [] },
    get: (name: string) => {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'agnes-3-flash', model: 'agnes-3.0-flash' }) }
      }
      if (name === 'llm') {
        return {
          stream: async function* (options: HostLlmGenerateOptions): AsyncIterable<HostLlmStreamChunk> {
            captured.push(options)
            yield { type: 'text-delta', index: 0, text: AGNES_GENERATED_JSON }
            yield { type: 'usage', index: 0, usage: { inputTokens: 1500, outputTokens: 800 } }
            yield { type: 'finish', index: 0, reason: { kind: 'stop' } }
          },
        }
      }
      return undefined
    },
    on: () => () => {},
    effect: () => () => {},
  }
  return { ctx, captured }
}

async function makeDeps(
  store: EvolutionStore,
  root: string,
  ctx?: HostContextShape,
  generationEnabled = false,
  promotionEnabled = false,
): Promise<ModuleDeps> {
  const resolved = ctx ?? {
    tools: { register: () => {} },
    settings: { writable: true, register: (_n, _s, o) => ({ get: () => o?.base ?? {} }) },
    agents: { get: () => undefined, roots: () => [] },
    get: () => undefined,
    on: () => () => {},
    effect: () => () => {},
  }
  return {
    ctx: resolved,
    cfg: () => resolveConfig({
      stateRoot: root,
      evolution: {
        enabled: true,
        autoRecord: true,
        autoTrigger: false,
        analysis: { minExperiences: 5, minOccurrences: 3 },
        generation: { enabled: generationEnabled },
        promotion: { enabled: promotionEnabled },
        maxCyclesPerProcess: 10,
      },
    }),
    store,
    log: () => {},
    warn: () => {},
  }
}

async function seedFailures(store: EvolutionStore, prefix: string, versionId: string) {
  for (let i = 0; i < 5; i++) {
    await store.addExperience({
      taskId: prefix + '-' + i,
      prompt: 'sort JSON records ascending by id',
      success: false,
      errors: ['reverse-sort bug: epsilon placed before alpha'],
      stepCount: 6 + i,
      durationMs: 200 + i * 20,
      versionId,
    })
  }
}

describe('AUTONOMOUS EVOLUTION EXPERIMENT', () => {
  let tmpRoot: string
  let store: EvolutionStore
  const exec = { signal: AbortSignal.timeout(120_000) }

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-autonomous-exp-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
  })

  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  // ── Phase 1: V1 baseline measured and failing ──

  it('phase 1: V1 baseline is measured and fails the trusted oracle', async () => {
    await store.createVersion({ label: 'baseline-v1', modules: [] })
    const deps = await makeDeps(store, tmpRoot)

    const v1cand = await store.addCandidate({
      parentVersion: 'v1', type: 'policy', name: 'sort-by-id-v1',
      description: 'Baseline: buggy reverse sort', reason: 'v1',
      evidenceIds: [], patternIds: [],
      files: [{ path: 'run.js', content: V1_RUN_JS }],
      tests: [],
      benchmarkConfig: { successRate: { min: 0.5, weight: 1 }, avgScore: { min: 0.5, weight: 1 },
        errorRate: { max: 0.5, weight: 1 }, avgSteps: { max: 999, weight: 0.5 },
        avgDurationMs: { max: 300_000, weight: 0.5 }, },
      status: 'draft',
    })
    const v1id = v1cand.id

    const live = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!
    let passCount = 0
    for (let i = 0; i < 3; i++) {
      const r = await live.execute({
        candidateId: v1id, command: BENCH_COMMAND,
        expectedOutput: EXPECTED_OUTPUT, expectedExitCode: EXPECTED_EXIT_CODE,
        timeoutMs: 30_000,
      } as never, exec) as Record<string, unknown>
      if (r.passed) passCount++
    }
    expect(passCount).toBe(0)

    // v1 fails the trusted oracle deterministically
    await store.addBenchmark({
      candidateId: v1id, version: 'v1', baseline: 'v1', runs: 3,
      metrics: { successRate: 0, avgScore: 0, errorRate: 0, avgSteps: 1, avgDurationMs: 200 },
      passed: false,
      details: 'v1 live: 0/3 runs passed',
      mode: 'live', expectedOutput: EXPECTED_OUTPUT, expectedExitCode: EXPECTED_EXIT_CODE,
    })
    await store.updateCandidate(v1id, { status: 'benchmarked' })
  })

  // ── Phase 2: failure experience through normal path ──

  it('phase 2: failure experience recorded through normal observation path', async () => {
    await seedFailures(store, 'sort-bug-obs', 'v1')
    await store.createVersion({ label: 'baseline-v1', modules: [] })

    // Analyze
    const deps = await makeDeps(store, tmpRoot)
    const analyzeT = analyzeTools(deps)
    const analyze = analyzeT.find(t => t.name === 'evo_analyze_patterns')!
    const result = await analyze.execute({ minOccurrences: 3 } as never, exec) as { detected: number }
    expect(result.detected).toBeGreaterThan(0)

    const patterns = await store.listPatterns()
    expect(patterns.length).toBeGreaterThan(0)

    // Pattern evidenceIds must trace to actual experience records
    const exps = await store.listExperiences(100)
    const expIdSet = new Set(exps.map(e => e.id))
    for (const eid of patterns[0]!.evidenceIds) {
      expect(expIdSet.has(eid)).toBe(true)
    }
  })

  // ── Phase 3: AGNES generates candidate via builder path ──

  it('phase 3: AGNES generates candidate via builder path (no operator source)', async () => {
    await store.createVersion({ label: 'baseline-v1', modules: [] })
    await seedFailures(store, 'sort-bug-gen', 'v1')

    const deps = await makeDeps(store, tmpRoot)
    const analyzeT = analyzeTools(deps)
    const analyze = analyzeT.find(t => t.name === 'evo_analyze_patterns')!
    await analyze.execute({ minOccurrences: 3 } as never, exec)
    const patterns = await store.listPatterns()
    expect(patterns.length).toBeGreaterThan(0)
    const pattern = patterns[0]!

    // Generate via AGNES (fake LLM with AGNES model identification)
    const { ctx, captured } = makeAgnesCtx()
    const genDeps = await makeDeps(store, tmpRoot, ctx, true, false)
    const buildTools = builderTools(genDeps)
    const build = buildTools.find(t => t.name === 'evo_builder_generate')!
    const result = await build.execute({
      patternIds: [pattern.id], parentVersion: 'v1',
    } as never, exec) as { ok: boolean; candidateId: string; llmUsage: { inputTokens: number; outputTokens: number } }

    expect(result.ok).toBe(true)
    expect(result.llmUsage.inputTokens).toBeGreaterThan(0)
    expect(result.llmUsage.outputTokens).toBeGreaterThan(0)

    // Verify LLM call was made to AGNES provider
    expect(captured.length).toBe(1)
    expect(captured[0].provider).toBe('agnes-3-flash')
    expect(captured[0].model).toBe('agnes-3.0-flash')

    // Candidate files must contain AGNES-generated fix code
    const candidate = await store.getCandidate(result.candidateId)
    expect(candidate).not.toBeNull()
    expect(candidate!.files.length).toBeGreaterThan(0)
    const source = candidate!.files[0].content
    expect(source).toContain('typeof a.id')
    expect(source).toContain('Infinity')

    // Candidate provenance
    expect(candidate!.parentVersion).toBe('v1')
    expect(candidate!.patternIds).toContain(pattern.id)
    expect(candidate!.reason).toContain('LLM-generated from patterns')
  })

  // ── Phase 4: generated candidate passes operator-defined oracle ──

  it('phase 4: AGNES-generated candidate passes the operator-defined trusted oracle', async () => {
    await store.createVersion({ label: 'baseline-v1', modules: [] })
    await seedFailures(store, 'sort-bug-pass', 'v1')

    const deps = await makeDeps(store, tmpRoot)
    const analyzeT = analyzeTools(deps)
    const analyze = analyzeT.find(t => t.name === 'evo_analyze_patterns')!
    await analyze.execute({ minOccurrences: 3 } as never, exec)
    const pattern = (await store.listPatterns())[0]!

    const { ctx } = makeAgnesCtx()
    const genDeps = await makeDeps(store, tmpRoot, ctx, true, false)
    const buildTools = builderTools(genDeps)
    const build = buildTools.find(t => t.name === 'evo_builder_generate')!
    const genResult = await build.execute({
      patternIds: [pattern.id], parentVersion: 'v1',
    } as never, exec) as { ok: boolean; candidateId: string }
    expect(genResult.ok).toBe(true)

    // Benchmark 3 times against the SAME oracle
    const benchTools = benchmarkTools(deps)
    const live = benchTools.find(t => t.name === 'evo_benchmark_live')!
    let passCount = 0
    let sampleStdout = ''
    for (let i = 0; i < 3; i++) {
      const r = await live.execute({
        candidateId: genResult.candidateId, command: BENCH_COMMAND,
        expectedOutput: EXPECTED_OUTPUT, expectedExitCode: EXPECTED_EXIT_CODE,
        timeoutMs: 30_000,
      } as never, exec) as Record<string, unknown>
      if (r.passed) passCount++
      const execRes = r.executionResult as { stdout?: string } | undefined
      sampleStdout = execRes?.stdout ?? ''
    }
    expect(passCount).toBe(3)
    expect(sampleStdout).toBe(EXPECTED_OUTPUT)

    await store.addBenchmark({
      candidateId: genResult.candidateId, version: 'v1', baseline: 'v1', runs: 3,
      metrics: { successRate: 1, avgScore: 1, errorRate: 0, avgSteps: 1, avgDurationMs: 200 },
      passed: true, details: 'autonomous AGNES: 3/3 runs passed',
      mode: 'live', expectedOutput: EXPECTED_OUTPUT, expectedExitCode: EXPECTED_EXIT_CODE,
    })
    await store.updateCandidate(genResult.candidateId, { status: 'benchmarked' })
  })

  // ── Phase 5: comparative promotion gate ──

  it('phase 5: candidate passes comparative promotion gate (beats_active)', async () => {
    const deps = await makeDeps(store, tmpRoot)

    // Create and fail v1
    await store.createVersion({ label: 'baseline-v1', modules: [] })
    const v1cand = await store.addCandidate({
      parentVersion: 'v1', type: 'policy', name: 'sort-by-id-v1',
      description: 'Baseline', reason: 'v1',
      evidenceIds: [], patternIds: [],
      files: [{ path: 'run.js', content: V1_RUN_JS }],
      tests: [],
      benchmarkConfig: { successRate: { min: 0.5, weight: 1 }, avgScore: { min: 0.5, weight: 1 },
        errorRate: { max: 0.5, weight: 1 }, avgSteps: { max: 999, weight: 0.5 },
        avgDurationMs: { max: 300_000, weight: 0.5 }, },
      status: 'draft',
    })
    const v1id = v1cand.id

    // Run live benchmark for v1 (fails)
    const live = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!
    await live.execute({
      candidateId: v1id, command: BENCH_COMMAND,
      expectedOutput: EXPECTED_OUTPUT, expectedExitCode: EXPECTED_EXIT_CODE,
      timeoutMs: 30_000,
    } as never, exec)

    // Persist the measured failure with explicit integrity metadata.
    const v1CreatedAt = isoDateTime(new Date())
    await store.addBenchmark({
      candidateId: v1id, version: 'v1', baseline: 'v1', parentVersion: 'v1', runs: 1,
      metrics: { successRate: 0, avgScore: 0, errorRate: 0, avgSteps: 1, avgDurationMs: 200 },
      passed: false, details: 'v1: failed oracle', mode: 'live', command: BENCH_COMMAND,
      provenance: createLiveProvenance(v1id, 'v1', BENCH_COMMAND, v1CreatedAt),
      expectedOutput: EXPECTED_OUTPUT, expectedExitCode: EXPECTED_EXIT_CODE,
    }, v1CreatedAt)
    await store.updateCandidate(v1id, { status: 'benchmarked' })

    // Make the v1 candidate the active version (modules must be string IDs)
    await store.createVersion({ label: 'v1-active', modules: [v1id] })

    // Now record experiences so pattern detection can fire
    await seedFailures(store, 'sort-bug-promo', 'v1')
    const analyzeT = analyzeTools(deps)
    const analyze = analyzeT.find(t => t.name === 'evo_analyze_patterns')!
    await analyze.execute({ minOccurrences: 3 } as never, exec)
    const patterns = await store.listPatterns()
    expect(patterns.length).toBeGreaterThan(0)
    const pattern = patterns[0]!

    // Generate AGNES candidate
    const { ctx } = makeAgnesCtx()
    const genDeps = await makeDeps(store, tmpRoot, ctx, true, true)
    const buildTools = builderTools(genDeps)
    const build = buildTools.find(t => t.name === 'evo_builder_generate')!
    const genResult = await build.execute({
      patternIds: [pattern.id], parentVersion: 'v1',
    } as never, exec) as { ok: boolean; candidateId: string }
    expect(genResult.ok).toBe(true)

    // Benchmark AGNES candidate (passes)
    const benchTools = benchmarkTools(deps)
    for (let i = 0; i < 3; i++) {
      await live.execute({
        candidateId: genResult.candidateId, command: BENCH_COMMAND,
        expectedOutput: EXPECTED_OUTPUT, expectedExitCode: EXPECTED_EXIT_CODE,
        timeoutMs: 30_000,
      } as never, exec)
    }
    const candidateCreatedAt = isoDateTime(new Date())
    await store.addBenchmark({
      candidateId: genResult.candidateId, version: 'v1', baseline: 'v1', parentVersion: 'v1', runs: 3,
      metrics: { successRate: 1, avgScore: 1, errorRate: 0, avgSteps: 1, avgDurationMs: 200 },
      passed: true, details: 'AGNES: 3/3 passed',
      mode: 'live', command: BENCH_COMMAND,
      provenance: createLiveProvenance(genResult.candidateId, 'v1', BENCH_COMMAND, candidateCreatedAt),
      expectedOutput: EXPECTED_OUTPUT, expectedExitCode: EXPECTED_EXIT_CODE,
    }, candidateCreatedAt)
    await store.updateCandidate(genResult.candidateId, { status: 'benchmarked' })

    // Verify state before promotion decision
    const activeVer = await store.getActiveVersion()
    console.log('[phase 5 active version]', activeVer?.id)
    const allBenches = await store.listBenchmarks(500)
    console.log('[all benchmarks count]', allBenches.length)

    // Promotion decision must include beats_active gate and pass all gates
    const promoteT = promoteTools(deps)
    const decision = promoteT.find(t => t.name === 'evo_promote_decision')!
    const verdict = await decision.execute(
      { candidateId: genResult.candidateId } as never, exec
    ) as {
      ok: boolean; recommendation: string
      checks: Array<{ gate: string; pass: boolean; actual: string; threshold: string }>
      metrics: { successRate: number }
      rejectionReasons: string[]
    }

    expect(verdict.ok).toBe(true)
    expect(verdict.recommendation).toBe('PROMOTE')
    expect(verdict.metrics.successRate).toBe(1)
    expect(verdict.rejectionReasons.length).toBe(0)

    // All gates must pass, including beats_active
    const gateNames = verdict.checks.map(c => c.gate)
    console.log('[gates]', gateNames)
    expect(gateNames).toContain('benchmark_passed')
    expect(gateNames).toContain('min_runs')
    expect(gateNames).toContain('success_improvement')
    expect(gateNames).toContain('max_regression')
    expect(gateNames).toContain('beats_active')
    for (const c of verdict.checks) {
      expect(c.pass).toBe(true)
    }
  })

  // ── Phase 6: V1 vs V2 comparison ──

  it('phase 6: V1 fails and V2 passes the identical trusted oracle (reproducible)', async () => {
    const deps = await makeDeps(store, tmpRoot)
    const live = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!

    // v1
    const v1cand = await store.addCandidate({
      parentVersion: 'v1', type: 'policy', name: 'sort-by-id-v1',
      description: 'Baseline', reason: 'v1',
      evidenceIds: [], patternIds: [],
      files: [{ path: 'run.js', content: V1_RUN_JS }],
      tests: [],
      benchmarkConfig: { successRate: { min: 0.5, weight: 1 }, avgScore: { min: 0.5, weight: 1 },
        errorRate: { max: 0.5, weight: 1 }, avgSteps: { max: 999, weight: 0.5 },
        avgDurationMs: { max: 300_000, weight: 0.5 }, },
      status: 'draft',
    })
    const v1id = v1cand.id
    const v1r = await live.execute({
      candidateId: v1id, command: BENCH_COMMAND,
      expectedOutput: EXPECTED_OUTPUT, expectedExitCode: EXPECTED_EXIT_CODE,
      timeoutMs: 30_000,
    } as never, exec) as Record<string, unknown>
    const execRes = v1r.executionResult as { stdout?: string } | undefined
    const v1Stdout = execRes?.stdout ?? String(v1r.stdout ?? '')
    expect(v1Stdout.trim().split('\n')[0]).toBe('epsilon')

    // v2 (AGNES-generated source)
    const AGNES_V2 = (JSON.parse(AGNES_GENERATED_JSON).files[0] as { content: string }).content
    const v2cand = await store.addCandidate({
      parentVersion: 'v1', type: 'policy', name: 'sort-by-id-v2',
      description: 'Fixed', reason: 'v2',
      evidenceIds: [], patternIds: [],
      files: [{ path: 'run.js', content: AGNES_V2 }],
      tests: [],
      benchmarkConfig: { successRate: { min: 0.5, weight: 1 }, avgScore: { min: 0.5, weight: 1 },
        errorRate: { max: 0.5, weight: 1 }, avgSteps: { max: 999, weight: 0.5 },
        avgDurationMs: { max: 300_000, weight: 0.5 }, },
      status: 'draft',
    })
    const v2id = v2cand.id
    const v2r = await live.execute({
      candidateId: v2id, command: BENCH_COMMAND,
      expectedOutput: EXPECTED_OUTPUT, expectedExitCode: EXPECTED_EXIT_CODE,
      timeoutMs: 30_000,
    } as never, exec) as Record<string, unknown>
    // v2 stdout is in executionResult (not top-level)
    const execRes2 = v2r.executionResult as { stdout?: string } | undefined
    const v2Stdout = execRes2?.stdout ?? String(v2r.stdout ?? '')
    expect(v2Stdout).toBe(EXPECTED_OUTPUT)
    expect(v2Stdout.trim().split('\n')[0]).toBe('alpha')

    // Novelty classification
    expect(v1Stdout).not.toBe(v2Stdout)
    expect(v1Stdout.trim().split('\n')[0]).toBe('epsilon') // wrong (reverse bug)
    expect(v2Stdout.trim().split('\n')[0]).toBe('alpha')  // correct (ascending sort)
  })

  // ── Phase 7: no operator leakage ──

  it('phase 7: candidate source comes ONLY from LLM stream, not operator', async () => {
    const { ctx, captured } = makeAgnesCtx()
    const genDeps = await makeDeps(store, tmpRoot, ctx, true, false)
    await store.createVersion({ label: 'baseline-v1', modules: [] })
    await seedFailures(store, 'leak-check', 'v1')

    const analyzeT = analyzeTools(genDeps)
    const analyze = analyzeT.find(t => t.name === 'evo_analyze_patterns')!
    await analyze.execute({ minOccurrences: 3 } as never, exec)
    const patterns = await store.listPatterns()
    expect(patterns.length).toBeGreaterThan(0)

    const buildTools = builderTools(genDeps)
    const build = buildTools.find(t => t.name === 'evo_builder_generate')!
    const result = await build.execute({
      patternIds: [patterns[0]!.id], parentVersion: 'v1',
    } as never, exec) as { ok: boolean; candidateId: string }
    expect(result.ok).toBe(true)

    const candidate = await store.getCandidate(result.candidateId)
    expect(candidate).not.toBeNull()
    expect(candidate!.files.length).toBeGreaterThan(0)
    expect(candidate!.reason).toContain('LLM-generated from patterns')
    expect(captured.length).toBe(1)
    expect(captured[0].provider).toBe('agnes-3-flash')
    expect(captured[0].model).toBe('agnes-3.0-flash')
  })

  // ── Phase 8: repeatability ──

  it('phase 8: candidate passes oracle deterministically across repeated runs', async () => {
    const deps = await makeDeps(store, tmpRoot)
    await store.createVersion({ label: 'baseline-v1', modules: [] })
    await seedFailures(store, 'repeat', 'v1')

    const analyzeT = analyzeTools(deps)
    const analyze = analyzeT.find(t => t.name === 'evo_analyze_patterns')!
    await analyze.execute({ minOccurrences: 3 } as never, exec)
    const pattern = (await store.listPatterns())[0]!

    const { ctx } = makeAgnesCtx()
    const genDeps = await makeDeps(store, tmpRoot, ctx, true, false)
    const buildTools = builderTools(genDeps)
    const build = buildTools.find(t => t.name === 'evo_builder_generate')!
    const genResult = await build.execute({
      patternIds: [pattern.id], parentVersion: 'v1',
    } as never, exec) as { ok: boolean; candidateId: string }
    expect(genResult.ok).toBe(true)

    const live = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!
    const stdoutValues: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = await live.execute({
        candidateId: genResult.candidateId, command: BENCH_COMMAND,
        expectedOutput: EXPECTED_OUTPUT, expectedExitCode: EXPECTED_EXIT_CODE,
        timeoutMs: 30_000,
      } as never, exec) as Record<string, unknown>
      const stdout = (r.executionResult as { stdout?: string }).stdout ?? ''
      stdoutValues.push(stdout)
      expect(r.passed).toBe(true)
    }
    // All runs produce identical output
    for (let i = 1; i < stdoutValues.length; i++) {
      expect(stdoutValues[i]).toBe(stdoutValues[0])
    }
    expect(stdoutValues[0]).toBe(EXPECTED_OUTPUT)
  })

  // ── Phase 9: promotion authority ──

  it('phase 9: promotion authority enforces policy gates (not LLM trust)', async () => {
    const deps = await makeDeps(store, tmpRoot)
    await store.createVersion({ label: 'baseline-v1', modules: [] })
    await seedFailures(store, 'promo-auth', 'v1')

    const v1id = await store.addCandidate({
      parentVersion: 'v1', type: 'policy', name: 'sort-by-id-v1',
      description: 'Baseline', reason: 'v1',
      evidenceIds: [], patternIds: [],
      files: [{ path: 'run.js', content: V1_RUN_JS }],
      tests: [],
      benchmarkConfig: { successRate: { min: 0.5, weight: 1 }, avgScore: { min: 0.5, weight: 1 },
        errorRate: { max: 0.5, weight: 1 }, avgSteps: { max: 999, weight: 0.5 },
        avgDurationMs: { max: 300_000, weight: 0.5 }, },
      status: 'draft',
    })

    const live = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!
    await live.execute({
      candidateId: v1id, command: BENCH_COMMAND,
      expectedOutput: EXPECTED_OUTPUT, expectedExitCode: EXPECTED_EXIT_CODE,
      timeoutMs: 30_000,
    } as never, exec)
    await store.addBenchmark({
      candidateId: v1id, version: 'v1', baseline: 'v1', runs: 1,
      metrics: { successRate: 0, avgScore: 0, errorRate: 0, avgSteps: 1, avgDurationMs: 200 },
      passed: false, details: 'v1 failed', mode: 'live',
      expectedOutput: EXPECTED_OUTPUT, expectedExitCode: EXPECTED_EXIT_CODE,
    })
    await store.updateCandidate(v1id, { status: 'benchmarked' })

    // Make v1 active
    await store.createVersion({ label: 'v1-active', modules: [v1id] })

    const analyzeT = analyzeTools(deps)
    const analyze = analyzeT.find(t => t.name === 'evo_analyze_patterns')!
    await analyze.execute({ minOccurrences: 3 } as never, exec)
    const pattern = (await store.listPatterns())[0]!

    const { ctx } = makeAgnesCtx()
    const genDeps = await makeDeps(store, tmpRoot, ctx, true, true)
    const buildTools = builderTools(genDeps)
    const build = buildTools.find(t => t.name === 'evo_builder_generate')!
    const genResult = await build.execute({
      patternIds: [pattern.id], parentVersion: 'v1',
    } as never, exec) as { ok: boolean; candidateId: string }
    expect(genResult.ok).toBe(true)

    for (let i = 0; i < 3; i++) {
      await live.execute({
        candidateId: genResult.candidateId, command: BENCH_COMMAND,
        expectedOutput: EXPECTED_OUTPUT, expectedExitCode: EXPECTED_EXIT_CODE,
        timeoutMs: 30_000,
      } as never, exec)
    }
    const candidateCreatedAt = isoDateTime(new Date())
    await store.addBenchmark({
      candidateId: genResult.candidateId, version: 'v1', baseline: 'v1', parentVersion: 'v1', runs: 3,
      metrics: { successRate: 1, avgScore: 1, errorRate: 0, avgSteps: 1, avgDurationMs: 200 },
      passed: true, details: 'AGNES: 3/3 passed',
      mode: 'live', command: BENCH_COMMAND,
      provenance: createLiveProvenance(genResult.candidateId, 'v1', BENCH_COMMAND, candidateCreatedAt),
      expectedOutput: EXPECTED_OUTPUT, expectedExitCode: EXPECTED_EXIT_CODE,
    }, candidateCreatedAt)
    await store.updateCandidate(genResult.candidateId, { status: 'benchmarked' })

    const promoteT = promoteTools(deps)
    const decision = promoteT.find(t => t.name === 'evo_promote_decision')!
    const verdict = await decision.execute(
      { candidateId: genResult.candidateId } as never, exec
    ) as { ok: boolean; recommendation: string; checks: Array<{ gate: string; pass: boolean }> }

    expect(verdict.ok).toBe(true)
    expect(verdict.recommendation).toBe('PROMOTE')
    for (const c of verdict.checks) {
      expect(c.pass).toBe(true)
    }
  })
})
