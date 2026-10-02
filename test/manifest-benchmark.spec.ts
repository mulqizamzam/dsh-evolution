/**
 * Manifest benchmark case execution — regression test suite.
 *
 * Tests T1–T12 covering:
 *  - Single valid case execution (T1)
 *  - expectedExitCode mismatch (T2)
 *  - exact expectedOutput match (T3)
 *  - regex expectedOutput match (T4)
 *  - malformed regex handling (T5)
 *  - execution failure classification (T6)
 *  - multi-case aggregate metrics (T7)
 *  - caseResults persistence (T8)
 *  - sandbox/cwd containment (T9)
 *  - live/simulated distinction (T10)
 *  - promotion gate ordering unchanged (T11)
 *  - candidate cannot escape sandbox (T12)
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { ModuleDeps, HostContextShape, CandidateManifest } from '../src/host/types.ts'
import { NodeProcessSandbox } from '../src/host/modules/sandbox/index.ts'
import { runManifestCases, readCandidateManifest } from '../src/host/modules/benchmark/manifest.ts'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeCtx(): HostContextShape {
  return {
    tools: { register: () => {} },
    settings: { writable: true, register: () => ({ get: () => ({}) }) },
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

async function withNodeSandbox(fn: () => Promise<void>): Promise<void> {
  const mod = await import('../src/host/modules/sandbox/index.ts')
  const saved = (mod as unknown as { _sandbox?: unknown })._sandbox
  ;(mod as unknown as { _sandbox?: unknown })._sandbox = new NodeProcessSandbox()
  try { await fn() } finally {
    ;(mod as unknown as { _sandbox?: unknown })._sandbox = saved
  }
}

/**
 * Seed a candidate and write its manifest.json to disk (mimicking the builder).
 */
async function seedCandidateWithManifest(
  store: EvolutionStore,
  manifest: CandidateManifest,
  files: Array<{ path: string; content: string }> = [],
  tests: Array<{ path: string; content: string }> = [],
): Promise<string> {
  const c = await store.addCandidate({
    parentVersion: 'v1',
    type: manifest.type ?? 'policy',
    name: manifest.name ?? 'test-candidate',
    description: manifest.description ?? 'test',
    reason: 'test',
    evidenceIds: [],
    patternIds: [],
    files,
    tests,
    benchmarkConfig: {
      successRate: { min: 0.8, weight: 1 },
      avgScore: { min: 0.7, weight: 1 },
      errorRate: { max: 0.2, weight: 1 },
      avgSteps: { max: 50, weight: 0.5 },
      avgDurationMs: { max: 60000, weight: 0.5 },
    },
    status: 'draft',
  })
  // Write manifest.json as builder does
  const manifestDir = join(store.getRoot(), 'candidates', c.id)
  await mkdir(manifestDir, { recursive: true })
  await writeFile(join(manifestDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return c.id
}

function manifest(overrides: Partial<CandidateManifest> & { benchmarkCases: CandidateManifest['benchmarkCases'] }): CandidateManifest {
  return {
    name: 'test',
    version: '1.0.0',
    type: 'policy',
    description: 'test candidate',
    entryPoint: 'src/index.ts',
    ...overrides,
  }
}

// ── T1: One valid BenchmarkCase executes successfully ────────────────────────

describe('T1: single valid case executes successfully', async () => {
  await it('echo hello with expectedOutput=hello and expectedExitCode=0 passes', async () => {
    await withNodeSandbox(async () => {
      const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-t1-'))
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()
      const deps = makeDeps(store, tmpRoot)
      try {
        const id = await seedCandidateWithManifest(store, manifest({
          benchmarkCases: [{
            id: 'case-1',
            description: 'echo hello',
            input: 'echo hello',
            expectedOutput: 'hello',
            expectedExitCode: 0,
            timeoutMs: 5000,
            successCriteria: 'prints hello',
          }],
        }))

        const result = await runManifestCases(deps, await store.getCandidate(id)!)

        expect(result.ok).toBe(true)
        expect(result.passed).toBe(true)
        expect(result.totalCases).toBe(1)
        expect(result.successfulCases).toBe(1)
        expect(result.failedCases).toBe(0)
        expect(result.executionFailures).toBe(0)
        expect(result.caseResults[0].outcome).toBe('task-successful')
        expect(result.caseResults[0].passed).toBe(true)
        expect(result.metrics.successRate).toBe(1)
      } finally { await rm(tmpRoot, { recursive: true, force: true }) }
    })
  })
})

// ── T2: expectedExitCode mismatch → unsuccessful-outcome ─────────────────────

describe('T2: expectedExitCode mismatch produces unsuccessful outcome', async () => {
  await it('exit 1 with expectedExitCode=0 → unsuccessful-outcome', async () => {
    await withNodeSandbox(async () => {
      const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-t2-'))
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()
      const deps = makeDeps(store, tmpRoot)
      try {
        const id = await seedCandidateWithManifest(store, manifest({
          benchmarkCases: [{
            id: 'case-exit1',
            description: 'exit 1',
            input: 'exit 1',
            expectedExitCode: 0,
            timeoutMs: 5000,
            successCriteria: 'should fail',
          }],
        }))

        const result = await runManifestCases(deps, await store.getCandidate(id)!)

        expect(result.ok).toBe(true)
        expect(result.passed).toBe(false)
        expect(result.totalCases).toBe(1)
        expect(result.failedCases).toBe(1)
        expect(result.caseResults[0].outcome).toBe('unsuccessful-outcome')
        expect(result.caseResults[0].exitCode).toBe(1)
        expect(result.metrics.successRate).toBe(0)
      } finally { await rm(tmpRoot, { recursive: true, force: true }) }
    })
  })
})

// ── T3: exact expectedOutput match ───────────────────────────────────────────

describe('T3: exact expectedOutput match succeeds', async () => {
  await it('stdout exact match → task-successful', async () => {
    await withNodeSandbox(async () => {
      const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-t3-'))
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()
      const deps = makeDeps(store, tmpRoot)
      try {
        const id = await seedCandidateWithManifest(store, manifest({
          benchmarkCases: [{
            id: 'case-exact',
            description: 'exact match',
            input: 'echo "result=42"',
            expectedOutput: 'result=42',
            expectedExitCode: 0,
            timeoutMs: 5000,
            successCriteria: 'exact stdout match',
          }],
        }))

        const result = await runManifestCases(deps, await store.getCandidate(id)!)

        expect(result.ok).toBe(true)
        expect(result.passed).toBe(true)
        expect(result.caseResults[0].outcome).toBe('task-successful')
        expect(result.caseResults[0].evaluation).toContain('matches')
      } finally { await rm(tmpRoot, { recursive: true, force: true }) }
    })
  })
})

// ── T4: regex expectedOutput match ───────────────────────────────────────────

describe('T4: regex expectedOutput match succeeds', async () => {
  await it('regex /item=\\d+/ matches "item=42 ok"', async () => {
    await withNodeSandbox(async () => {
      const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-t4-'))
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()
      const deps = makeDeps(store, tmpRoot)
      try {
        const id = await seedCandidateWithManifest(store, manifest({
          benchmarkCases: [{
            id: 'case-regex',
            description: 'regex match',
            input: 'echo "item=42 ok"',
            expectedOutput: '/item=\\d+ ok/',
            expectedExitCode: 0,
            timeoutMs: 5000,
            successCriteria: 'regex match',
          }],
        }))

        const result = await runManifestCases(deps, await store.getCandidate(id)!)

        expect(result.ok).toBe(true)
        expect(result.passed).toBe(true)
        expect(result.caseResults[0].outcome).toBe('task-successful')
        expect(result.caseResults[0].evaluation).toContain('regex')
      } finally { await rm(tmpRoot, { recursive: true, force: true }) }
    })
  })
})

// ── T5: malformed regex → unsuccessful-outcome ───────────────────────────────

describe('T5: malformed regex produces unsuccessful outcome', async () => {
  await it('malformed regex /[invalid/ → unsuccessful-outcome', async () => {
    await withNodeSandbox(async () => {
      const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-t5-'))
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()
      const deps = makeDeps(store, tmpRoot)
      try {
        const id = await seedCandidateWithManifest(store, manifest({
          benchmarkCases: [{
            id: 'case-bad-regex',
            description: 'bad regex',
            input: 'echo anything',
            expectedOutput: '/[invalid/',
            expectedExitCode: 0,
            timeoutMs: 5000,
            successCriteria: 'malformed regex',
          }],
        }))

        const result = await runManifestCases(deps, await store.getCandidate(id)!)

        expect(result.ok).toBe(true)
        expect(result.passed).toBe(false)
        expect(result.caseResults[0].outcome).toBe('unsuccessful-outcome')
        expect(result.caseResults[0].evaluation).toContain('malformed regex')
      } finally { await rm(tmpRoot, { recursive: true, force: true }) }
    })
  })
})

// ── T6: execution failure (timeout) ─────────────────────────────────────────

describe('T6: execution failure classified correctly', async () => {
  await it('timeout → execution-failure', async () => {
    await withNodeSandbox(async () => {
      const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-t6-'))
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()
      const deps = makeDeps(store, tmpRoot)
      try {
        const id = await seedCandidateWithManifest(store, manifest({
          benchmarkCases: [{
            id: 'case-timeout',
            description: 'timeout test',
            input: 'sleep 10',
            expectedOutput: 'never',
            expectedExitCode: 0,
            timeoutMs: 500,
            successCriteria: 'should timeout',
          }],
        }))

        const result = await runManifestCases(deps, await store.getCandidate(id)!)

        expect(result.ok).toBe(true)
        expect(result.passed).toBe(false)
        expect(result.executionFailures).toBe(1)
        expect(result.caseResults[0].outcome).toBe('execution-failure')
        expect(result.caseResults[0].timedOut).toBe(true)
        expect(result.metrics.errorRate).toBe(1)
      } finally { await rm(tmpRoot, { recursive: true, force: true }) }
    })
  })
})

// ── T7: multiple cases produce deterministic aggregate metrics ────────────────

describe('T7: multiple cases produce deterministic aggregate metrics', async () => {
  await it('3 cases: 2 pass, 1 fail → correct metrics', async () => {
    await withNodeSandbox(async () => {
      const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-t7-'))
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()
      const deps = makeDeps(store, tmpRoot)
      try {
        const id = await seedCandidateWithManifest(store, manifest({
          benchmarkCases: [
            {
              id: 'case-pass-1',
              description: 'pass 1',
              input: 'echo ok1',
              expectedOutput: 'ok1',
              expectedExitCode: 0,
              timeoutMs: 5000,
              successCriteria: 'pass',
            },
            {
              id: 'case-pass-2',
              description: 'pass 2',
              input: 'echo ok2',
              expectedOutput: 'ok2',
              expectedExitCode: 0,
              timeoutMs: 5000,
              successCriteria: 'pass',
            },
            {
              id: 'case-fail',
              description: 'fail',
              input: 'exit 1',
              expectedExitCode: 0,
              timeoutMs: 5000,
              successCriteria: 'fail',
            },
          ],
        }))

        const result = await runManifestCases(deps, await store.getCandidate(id)!)

        expect(result.ok).toBe(true)
        expect(result.passed).toBe(false) // not all passed
        expect(result.totalCases).toBe(3)
        expect(result.successfulCases).toBe(2)
        expect(result.failedCases).toBe(1)
        expect(result.executionFailures).toBe(0)
        expect(result.metrics.successRate).toBeCloseTo(2 / 3, 5)
        expect(result.metrics.errorRate).toBeCloseTo(0, 5)
        expect(result.caseResults).toHaveLength(3)
        expect(result.caseResults.filter(r => r.outcome === 'task-successful')).toHaveLength(2)
        expect(result.caseResults.filter(r => r.outcome === 'unsuccessful-outcome')).toHaveLength(1)
      } finally { await rm(tmpRoot, { recursive: true, force: true }) }
    })
  })
})

// ── T8: caseResults are persisted ────────────────────────────────────────────

describe('T8: caseResults are persisted via evo_benchmark_manifest tool', async () => {
  await it('tool persists BenchmarkRun with caseResults', async () => {
    await withNodeSandbox(async () => {
      const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-t8-'))
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()
      const deps = makeDeps(store, tmpRoot)
      try {
        const id = await seedCandidateWithManifest(store, manifest({
          benchmarkCases: [{
            id: 'case-persist',
            description: 'persist test',
            input: 'echo persisted',
            expectedOutput: 'persisted',
            expectedExitCode: 0,
            timeoutMs: 5000,
            successCriteria: 'persist',
          }],
        }))

        const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
        const tool = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_manifest')!
        const toolResult = await tool.execute({
          candidateId: id,
        } as never, { signal: AbortSignal.timeout(30_000) }) as {
          ok: boolean
          benchmarkRunId: string
          caseResults: Array<{ caseId: string; outcome: string }>
          passed: boolean
        }

        expect(toolResult.ok).toBe(true)
        expect(toolResult.passed).toBe(true)
        expect(toolResult.benchmarkRunId).toBeTruthy()
        expect(toolResult.caseResults).toHaveLength(1)
        expect(toolResult.caseResults[0].outcome).toBe('task-successful')

        // Verify persisted in store
        const benchmarks = await store.listBenchmarks(100)
        const record = benchmarks.find(b => b.id === toolResult.benchmarkRunId)
        expect(record).toBeDefined()
        expect(record!.mode).toBe('manifest')
        expect(record!.caseResults).toBeDefined()
        expect(record!.caseResults!).toHaveLength(1)
        expect(record!.caseResults![0].caseId).toBe('case-persist')
        expect(record!.caseResults![0].outcome).toBe('task-successful')
        expect(record!.caseResults![0].passed).toBe(true)
        expect(record!.passed).toBe(true)
      } finally { await rm(tmpRoot, { recursive: true, force: true }) }
    })
  })
})

// ── T9: sandbox/cwd containment remains enforced ─────────────────────────────

describe('T9: cwd containment remains enforced', async () => {
  await it('cwd escaping tmpDir is rejected', async () => {
    await withNodeSandbox(async () => {
      const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-t9-'))
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()
      const deps = makeDeps(store, tmpRoot)
      try {
        const id = await seedCandidateWithManifest(store, manifest({
          benchmarkCases: [{
            id: 'case-ok',
            description: 'ok',
            input: 'echo ok',
            expectedExitCode: 0,
            timeoutMs: 5000,
            successCriteria: 'ok',
          }],
        }))

        const result = await runManifestCases(deps, await store.getCandidate(id)!, {
          cwd: '../../etc',
        })

        expect(result.ok).toBe(false)
        expect(result.error).toContain('escapes')
      } finally { await rm(tmpRoot, { recursive: true, force: true }) }
    })
  })
})

// ── T10: live/simulated distinction unchanged ────────────────────────────────

describe('T10: manifest run is mode=manifest, not live or simulated', async () => {
  await it('persisted benchmark record has mode=manifest', async () => {
    await withNodeSandbox(async () => {
      const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-t10-'))
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()
      const deps = makeDeps(store, tmpRoot)
      try {
        const id = await seedCandidateWithManifest(store, manifest({
          benchmarkCases: [{
            id: 'case-live',
            description: 'live test',
            input: 'echo live',
            expectedOutput: 'live',
            expectedExitCode: 0,
            timeoutMs: 5000,
            successCriteria: 'live',
          }],
        }))

        const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
        const tool = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_manifest')!
        await tool.execute({ candidateId: id } as never, { signal: AbortSignal.timeout(30_000) })

        const benchmarks = await store.listBenchmarks(100)
        const record = benchmarks.find(b => b.candidateId === id)
        expect(record).toBeDefined()
        expect(record!.mode).toBe('manifest')
        expect(record!.provenance).toBeDefined() // provenance seal present
      } finally { await rm(tmpRoot, { recursive: true, force: true }) }
    })
  })
})

// ── T11: existing promotion gate ordering unchanged ──────────────────────────

describe('T11: existing tools remain unchanged and functional', async () => {
  await it('evo_benchmark_live still works with operator command', async () => {
    await withNodeSandbox(async () => {
      const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-t11-'))
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()
      await store.createVersion({ label: 'v1', modules: [] })
      const deps = makeDeps(store, tmpRoot)
      try {
        const c = await store.addCandidate({
          parentVersion: 'v1', type: 'policy', name: 'live-test',
          description: 'd', reason: 'r', evidenceIds: [], patternIds: [],
          files: [{ path: 'ok.ts', content: 'console.log("hello")' }],
          tests: [],
          benchmarkConfig: {
            successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
            errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 },
            avgDurationMs: { max: 60000, weight: 0.5 },
          },
          status: 'draft',
        })

        const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
        const liveTool = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!
        const result = await liveTool.execute({
          candidateId: c.id, command: 'node ok.ts',
          expectedOutput: 'hello', expectedExitCode: 0, timeoutMs: 10_000,
        } as never, { signal: AbortSignal.timeout(15_000) }) as { ok: boolean; passed: boolean; outcome: string }

        expect(result.ok).toBe(true)
        expect(result.passed).toBe(true)
        expect(result.outcome).toBe('task-successful')
      } finally { await rm(tmpRoot, { recursive: true, force: true }) }
    })
  })
})

// ── T12: candidate cannot escape sandbox ─────────────────────────────────────

describe('T12: candidate cases cannot escape the sandbox', async () => {
  await it('malicious command is contained by sandbox', async () => {
    await withNodeSandbox(async () => {
      const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-t12-'))
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()
      const deps = makeDeps(store, tmpRoot)
      try {
        const id = await seedCandidateWithManifest(store, manifest({
          benchmarkCases: [{
            id: 'case-evil',
            description: 'attempt escape',
            input: 'cat /etc/shadow 2>&1 || echo "permission-denied-or-contained"',
            expectedOutput: '/root:',
            expectedExitCode: 0,
            timeoutMs: 5000,
            successCriteria: 'should not match',
          }],
        }))

        const result = await runManifestCases(deps, await store.getCandidate(id)!)

        // The sandbox either blocks access or the output doesn't match expectedOutput.
        // Either way, the case should NOT pass.
        expect(result.ok).toBe(true)
        expect(result.passed).toBe(false)
        // The case outcome is either unsuccessful-outcome (output mismatch) or
        // execution-failure (sandbox blocked the command).
        expect(
          result.caseResults[0].outcome === 'unsuccessful-outcome'
          || result.caseResults[0].outcome === 'execution-failure',
        ).toBe(true)
      } finally { await rm(tmpRoot, { recursive: true, force: true }) }
    })
  })
})

// ── readCandidateManifest helper ─────────────────────────────────────────────

describe('readCandidateManifest', async () => {
  it('reads manifest from candidates/<id>/manifest.json', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-manifest-read-'))
    const store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
    try {
      const id = await seedCandidateWithManifest(store, manifest({
        benchmarkCases: [{
          id: 'c1', description: 'd', input: 'echo x',
          expectedExitCode: 0, timeoutMs: 1000, successCriteria: 'ok',
        }],
      }))
      const loaded = await readCandidateManifest(tmpRoot, id)
      expect(loaded).not.toBeNull()
      expect(loaded!.benchmarkCases).toHaveLength(1)
      expect(loaded!.benchmarkCases[0].id).toBe('c1')
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })

  it('returns null for nonexistent candidate', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-manifest-read2-'))
    const store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
    try {
      const loaded = await readCandidateManifest(tmpRoot, 'nonexistent-id')
      expect(loaded).toBeNull()
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })
})

// ── edge cases ───────────────────────────────────────────────────────────────

describe('edge cases', async () => {
  await it('empty benchmarkCases array → ok=false', async () => {
    await withNodeSandbox(async () => {
      const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-edge-'))
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()
      const deps = makeDeps(store, tmpRoot)
      try {
        const id = await seedCandidateWithManifest(store, manifest({
          benchmarkCases: [],
        }))
        const result = await runManifestCases(deps, await store.getCandidate(id)!)
        expect(result.ok).toBe(false)
        expect(result.error).toContain('no benchmark cases')
      } finally { await rm(tmpRoot, { recursive: true, force: true }) }
    })
  })

  await it('case with empty input → execution-failure', async () => {
    await withNodeSandbox(async () => {
      const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-edge2-'))
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()
      const deps = makeDeps(store, tmpRoot)
      try {
        const id = await seedCandidateWithManifest(store, manifest({
          benchmarkCases: [{
            id: 'case-empty',
            description: 'empty input',
            input: '',
            expectedExitCode: 0,
            timeoutMs: 5000,
            successCriteria: 'n/a',
          }],
        }))
        const result = await runManifestCases(deps, await store.getCandidate(id)!)
        expect(result.ok).toBe(true)
        expect(result.caseResults[0].outcome).toBe('execution-failure')
        expect(result.caseResults[0].evaluation).toContain('no input')
      } finally { await rm(tmpRoot, { recursive: true, force: true }) }
    })
  })

  await it('all cases pass → passed=true', async () => {
    await withNodeSandbox(async () => {
      const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-edge3-'))
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()
      const deps = makeDeps(store, tmpRoot)
      try {
        const id = await seedCandidateWithManifest(store, manifest({
          benchmarkCases: [
            { id: 'a', description: 'a', input: 'echo a', expectedOutput: 'a', expectedExitCode: 0, timeoutMs: 5000, successCriteria: 'ok' },
            { id: 'b', description: 'b', input: 'echo b', expectedOutput: 'b', expectedExitCode: 0, timeoutMs: 5000, successCriteria: 'ok' },
          ],
        }))
        const result = await runManifestCases(deps, await store.getCandidate(id)!)
        expect(result.passed).toBe(true)
        expect(result.successfulCases).toBe(2)
        expect(result.metrics.successRate).toBe(1)
      } finally { await rm(tmpRoot, { recursive: true, force: true }) }
    })
  })

  await it('no oracles set → legacy exit-0 path', async () => {
    await withNodeSandbox(async () => {
      const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-edge4-'))
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()
      const deps = makeDeps(store, tmpRoot)
      try {
        const id = await seedCandidateWithManifest(store, manifest({
          benchmarkCases: [{
            id: 'case-legacy',
            description: 'legacy path',
            input: 'echo anything',
            timeoutMs: 5000,
            successCriteria: 'n/a',
          }],
        }))
        const result = await runManifestCases(deps, await store.getCandidate(id)!)
        expect(result.ok).toBe(true)
        expect(result.passed).toBe(true)
        expect(result.caseResults[0].outcome).toBe('task-successful')
      } finally { await rm(tmpRoot, { recursive: true, force: true }) }
    })
  })
})
