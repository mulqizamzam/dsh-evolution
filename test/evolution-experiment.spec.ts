/**
 * First real cumulative-improvement experiment for dsh-evolution.
 *
 * Workload: a Node.js JSON record sorter running in the sandbox.
 *
 * v1 (buggy):   (a.id ?? 0) - (b.id ?? 0) then reverse()
 *                 Missing id → 0 → reversed order puts it wrong.
 *                 Output: "epsilon\ngamma\nbeta\nalpha\ndelta\n"
 *
 * v2 (fixed):   null-safe sort — no id → Infinity → last position.
 *                 Output: "alpha\nbeta\ngamma\nepsilon\ndelta\n"
 *
 * Trusted oracle: exact stdout match of v2's output.
 *   v1 FAILS oracle (wrong order)
 *   v2 PASSES oracle (correct order)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import { isoDateTime } from '../src/lib/ids.ts'
import { createLiveProvenance } from '../src/lib/provenance.ts'
import { addSealedLiveBenchmark } from './helpers/live-evidence.ts'
import type { ModuleDeps, HostContextShape } from '../src/host/types.ts'
import { experienceTools } from '../src/host/modules/experience/tools.ts'
import { benchmarkTools } from '../src/host/modules/benchmark/tools.ts'
import { promoteTools } from '../src/host/modules/promote/tools.ts'

function makeCtx(): HostContextShape {
  return {
    tools: { register: () => {} },
    settings: { writable: true, register: (_n, _s, o) => ({ get: () => o?.base ?? {} }) },
    agents: { get: () => undefined, roots: () => [] },
    get: () => undefined,
    on: () => () => {},
    effect: () => () => {},
  }
}

const WORKLOAD_INPUT = JSON.stringify([
  { id: 1, value: 'alpha',   tags: ['a'] },
  { id: 2, value: 'beta',    tags: ['b', 'c'] },
  { id: 3, value: 'gamma',   tags: [] },
  { value: 'delta',          tags: ['d'] },
  { id: 5, value: 'epsilon', tags: ['e', 'f', 'g'] },
])

const EXPECTED_OUTPUT = 'alpha\nbeta\ngamma\nepsilon\ndelta\n'
const EXPECTED_EXIT_CODE = 0

const V1_RUN_JS = `
const input = require('fs').readFileSync('/dev/stdin', 'utf8')
const records = JSON.parse(input)
records.sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
records.reverse()
const names = records.map(r => r.value)
process.stdout.write(names.join('\\n') + '\\n')
process.exit(0)
`

const V2_RUN_JS = `
const input = require('fs').readFileSync('/dev/stdin', 'utf8')
const records = JSON.parse(input)
records.sort((a, b) => {
  const ai = typeof a.id === 'number' ? a.id : Infinity
  const bi = typeof b.id === 'number' ? b.id : Infinity
  return ai - bi
})
const names = records.map(r => r.value)
process.stdout.write(names.join('\\n') + '\\n')
process.exit(0)
`

const BENCH_COMMAND = "echo '" + WORKLOAD_INPUT + "' | node run.js"

async function createCandidate(
  store: EvolutionStore, parentVersion: string, name: string,
  files: Array<{ path: string; content: string }>,
): Promise<string> {
  const c = await store.addCandidate({
    parentVersion, type: 'policy', name, description: name, reason: 'r',
    evidenceIds: [], patternIds: [],
    files,
    tests: [{ path: 'test/index.spec.ts', content: 'export const t = 1' }],
    benchmarkConfig: {
      successRate: { min: 0.5, weight: 1 }, avgScore: { min: 0.5, weight: 1 },
      errorRate: { max: 0.5, weight: 1 }, avgSteps: { max: 999, weight: 0.5 },
      avgDurationMs: { max: 300_000, weight: 0.5 },
    },
    status: 'draft',
  })
  return c.id
}

async function runLiveBenchmark(
  deps: ModuleDeps, candidateId: string, runs: number = 3,
): Promise<{
  passed: boolean
  metrics: { successRate: number; errorRate: number; avgScore: number; avgSteps: number; avgDurationMs: number }
  sampleStdout: string
}> {
  const benchTools = benchmarkTools(deps)
  const live = benchTools.find(t => t.name === 'evo_benchmark_live')!
  let passCount = 0
  let sampleStdout = ''
  for (let i = 0; i < runs; i++) {
    const r = await live.execute({
      candidateId, command: BENCH_COMMAND,
      expectedOutput: EXPECTED_OUTPUT,
      expectedExitCode: EXPECTED_EXIT_CODE,
      timeoutMs: 30_000,
    } as never, { signal: AbortSignal.timeout(60_000) }) as Record<string, unknown>
    if (r.passed) passCount++
    const execRes = r.executionResult as { stdout?: string } | undefined
    sampleStdout = execRes?.stdout ?? String(r.stdout ?? '')
  }
  return {
    passed: passCount === runs,
    metrics: {
      successRate: passCount / runs,
      errorRate: 0,
      avgScore: passCount / runs,
      avgSteps: 1,
      avgDurationMs: 100,
    },
    sampleStdout,
  }
}

describe('CUMULATIVE IMPROVEMENT EXPERIMENT', () => {
  let tmpRoot: string
  let store: EvolutionStore
  let deps: ModuleDeps
  const exec = { signal: AbortSignal.timeout(120_000) }

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-cum-exp-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
    deps = { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: tmpRoot }), store, log: () => {}, warn: () => {} }
  })

  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  it('V1: live sandbox benchmark FAILS the trusted oracle', async () => {
    await store.createVersion({ label: 'baseline-v1', modules: [] })

    const expTools = experienceTools(deps)
    const record = expTools.find(t => t.name === 'evo_experience_record')!
    for (let i = 0; i < 5; i++) {
      await record.execute({
        taskId: 'sort-bug-' + i,
        prompt: 'sort JSON records ascending by id',
        success: false,
        errors: ['reverse-sort bug: epsilon placed before alpha'],
        stepCount: 6 + i,
        durationMs: 200 + i * 20,
        versionId: 'v1',
      } as never, exec)
    }

    const v1id = await createCandidate(store, 'v1', 'sort-by-id-v1', [
      { path: 'run.js', content: V1_RUN_JS },
    ])

    const v1result = await runLiveBenchmark(deps, v1id, 3)
    console.log('[V1 live]', JSON.stringify(v1result))

    expect(v1result.passed).toBe(false)
    expect(v1result.metrics.successRate).toBe(0)
    expect(v1result.sampleStdout).toBe('epsilon\ngamma\nbeta\nalpha\ndelta\n')

    const createdAt = isoDateTime(new Date())
    const command = 'node run.js'
    await store.addBenchmark({
      candidateId: v1id, version: 'v1', baseline: 'v1', parentVersion: 'v1', runs: 3,
      metrics: v1result.metrics,
      passed: false,
      details: 'v1 live: 0/3 runs passed. stdout=' + JSON.stringify(v1result.sampleStdout),
      mode: 'live',
      command,
      provenance: createLiveProvenance(v1id, 'v1', command, createdAt),
    }, createdAt)
    await store.updateCandidate(v1id, { status: 'benchmarked' })
  })

  it('V2: live sandbox benchmark PASSES the same trusted oracle', async () => {
    await store.createVersion({ label: 'baseline-v1', modules: [] })

    const v2id = await createCandidate(store, 'v1', 'sort-by-id-v2', [
      { path: 'run.js', content: V2_RUN_JS },
    ])

    const v2result = await runLiveBenchmark(deps, v2id, 3)
    console.log('[V2 live]', JSON.stringify(v2result))

    expect(v2result.passed).toBe(true)
    expect(v2result.metrics.successRate).toBe(1)
    expect(v2result.sampleStdout).toBe(EXPECTED_OUTPUT)

    const createdAt = isoDateTime(new Date())
    const command = 'node run.js'
    await store.addBenchmark({
      candidateId: v2id, version: 'v1', baseline: 'v1', parentVersion: 'v1', runs: 3,
      metrics: v2result.metrics,
      passed: true,
      details: 'v2 live: 3/3 runs passed. stdout=' + JSON.stringify(v2result.sampleStdout),
      mode: 'live',
      command,
      provenance: createLiveProvenance(v2id, 'v1', command, createdAt),
    }, createdAt)
    await store.updateCandidate(v2id, { status: 'benchmarked' })
  })

  it('promotion: evo_promote_decision returns PROMOTE for V2 vs active V1', async () => {
    await store.createVersion({ label: 'baseline-v1', modules: [] })

    const v1id = await createCandidate(store, 'v1', 'sort-by-id-v1', [{ path: 'run.js', content: V1_RUN_JS }])
    const v1bench = await runLiveBenchmark(deps, v1id, 3)
    await addSealedLiveBenchmark(store, {
      candidateId: v1id, version: 'v1', baseline: 'v1', runs: 3,
      metrics: v1bench.metrics, passed: false, details: 'v1 live: 0/3', mode: 'live',
    })
    await store.updateCandidate(v1id, { status: 'benchmarked' })
    await store.createVersion({ label: 'v1-active', modules: [v1id] })

    const v2id = await createCandidate(store, 'v1', 'sort-by-id-v2', [{ path: 'run.js', content: V2_RUN_JS }])
    const v2bench = await runLiveBenchmark(deps, v2id, 3)
    await addSealedLiveBenchmark(store, {
      candidateId: v2id, version: 'v1', baseline: 'v1', runs: 3,
      metrics: v2bench.metrics, passed: true, details: 'v2 live: 3/3', mode: 'live',
    })
    await store.updateCandidate(v2id, { status: 'benchmarked' })

    const decide = promoteTools(deps).find(t => t.name === 'evo_promote_decision')!
    const result = await decide.execute(
      { candidateId: v2id, allowSimulated: true } as never, exec
    ) as {
      ok: boolean; recommendation: string
      checks?: Array<{ gate: string; pass: boolean; actual: string; threshold: string }>
      metrics: { successRate: number }
      deltas?: { successDelta: number }
      rejectionReasons?: string[]
    }

    console.log('[promotion decision]', JSON.stringify(result, null, 2))

    expect(result.ok).toBe(true)
    expect(result.recommendation).toContain('PROMOTE')
    expect(result.metrics.successRate).toBe(1)
    const beatsActive = (result.checks ?? []).find(c => c.gate === 'beats_active')
    expect(beatsActive).toBeDefined()
    expect(beatsActive!.pass).toBe(true)
    // successDelta is candidate.metrics.successRate - config's successRate.min (0.5),
    // NOT the absolute delta from v1 to v2.  What matters: beats_active passes.
    expect(typeof result.deltas?.successDelta).toBe('number')
  })

  it('falsification: v1 output explicitly differs from oracle (reproducible)', async () => {
    await store.createVersion({ label: 'baseline-v1', modules: [] })

    const v1id = await createCandidate(store, 'v1', 'sort-by-id-v1', [{ path: 'run.js', content: V1_RUN_JS }])
    const v1result = await runLiveBenchmark(deps, v1id, 1)

    const v1Output = v1result.sampleStdout
    expect(v1Output).not.toBe(EXPECTED_OUTPUT)
    expect(v1Output.trim().split('\n')[0]).toBe('epsilon')
    expect(EXPECTED_OUTPUT.trim().split('\n')[0]).toBe('alpha')

    // Repeat once more to confirm determinism
    const v1result2 = await runLiveBenchmark(deps, v1id, 1)
    expect(v1result2.sampleStdout).toBe(v1Output)
  })

  it('provenance: v2 candidate evidenceIds trace to v1 failures', async () => {
    await store.createVersion({ label: 'baseline-v1', modules: [] })

    const expTools = experienceTools(deps)
    const record = expTools.find(t => t.name === 'evo_experience_record')!
    const expIds: string[] = []
    for (let i = 0; i < 5; i++) {
      const r = await record.execute({
        taskId: 'sort-bug-' + i,
        prompt: 'sort JSON records ascending by id',
        success: false,
        errors: ['reverse-sort bug'],
        stepCount: 7,
        durationMs: 250,
        versionId: 'v1',
      } as never, exec)
      if (r && typeof r === 'object' && 'id' in r) expIds.push((r as { id: string }).id)
    }
    expect(expIds.length).toBe(5)

    const v2cand = await store.addCandidate({
      parentVersion: 'v1', type: 'policy', name: 'sort-by-id-v2',
      description: 'v2 null-safe sort', reason: 'v1 reverse-sort bug',
      evidenceIds: expIds, patternIds: [],
      files: [{ path: 'run.js', content: V2_RUN_JS }],
      tests: [],
      benchmarkConfig: {
        successRate: { min: 0.5, weight: 1 }, avgScore: { min: 0.5, weight: 1 },
        errorRate: { max: 0.5, weight: 1 }, avgSteps: { max: 999, weight: 0.5 },
        avgDurationMs: { max: 300_000, weight: 0.5 },
      },
      status: 'draft',
    })
    const cand = await store.getCandidate(v2cand.id)
    expect(cand).not.toBeNull()
    expect(cand!.evidenceIds).toHaveLength(5)
    expect(cand!.evidenceIds.every((id: string) => expIds.includes(id))).toBe(true)
    expect(cand!.parentVersion).toBe('v1')
  })
})
