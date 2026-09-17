/**
 * P6: Independent benchmark outcome oracle.
 *
 * Verifies that the trusted oracle is operator-owned (passed as an explicit
 * tool parameter), not derived from candidate-generated metadata. Exit code
 * is compared against the operator-supplied `expectedExitCode`; when absent,
 * legacy behaviour (exit-0 → task-successful) is preserved for backward
 * compatibility.
 *
 * Invariants tested:
 *   1. Candidate code cannot redefine the oracle.
 *   2. Candidate-generated metadata is never read for classification.
 *   3. Baseline and candidate use the identical oracle when provided.
 *   4. Evaluation is deterministic across repeated calls.
 *   5. Exit code is a process diagnostic, not task correctness (unless the
 *      operator explicitly sets expectedExitCode).
 *   6. Process success ≠ task success when expectedExitCode is set and
 *      the actual code differs.
 *   7. Legitimate no-output success remains valid (empty stdout + exit 0).
 *   8. Missing/invalid oracle does not silently pass — explicit result.
 *   9. Every result retains caseId.
 *  10. Per-case evaluation evidence survives aggregation.
 *  11. One failed case prevents an incorrectly successful aggregate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { ModuleDeps } from '../src/host/types.ts'
import type { HostContextShape } from '../src/host/dsh.ts'
import { NodeProcessSandbox } from '../src/host/modules/sandbox/index.ts'

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

/**
 * Replace the singleton sandbox with NodeProcessSandbox for speed and
 * reliability (no bwrap dependency). Restore it afterwards.
 */
async function withNodeSandbox(fn: () => Promise<void>): Promise<void> {
  const mod = await import('../src/host/modules/sandbox/index.ts')
  const saved = (mod as unknown as { _sandbox?: unknown })._sandbox
  ;(mod as unknown as { _sandbox?: unknown })._sandbox = new NodeProcessSandbox()
  try {
    await fn()
  } finally {
    ;(mod as unknown as { _sandbox?: unknown })._sandbox = saved
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function seedCandidate(
  store: EvolutionStore,
  overrides?: { files?: Array<{ path: string; content: string }>; tests?: Array<{ path: string; content: string }> },
): Promise<string> {
  await store.createVersion({ label: 'v1', modules: [] })
  const c = await store.addCandidate({
    parentVersion: 'v1',
    type: 'policy',
    name: 'oracle-test',
    description: 'P6 oracle test',
    reason: 'r',
    evidenceIds: [],
    patternIds: [],
    files: overrides?.files ?? [],
    tests: overrides?.tests ?? [],
    benchmarkConfig: {
      successRate: { min: 0.8, weight: 1 },
      avgScore: { min: 0.7, weight: 1 },
      errorRate: { max: 0.2, weight: 1 },
      avgSteps: { max: 50, weight: 0.5 },
      avgDurationMs: { max: 60000, weight: 0.5 },
    },
    status: 'draft',
  })
  return c.id
}

// ── 1. exit 0 + correct expectedExitCode → task-successful ─────────────────

describe('P6 oracle: operator-owned expectedExitCode', () => {
  let tmpRoot: string
  let store: EvolutionStore
  let deps: ModuleDeps

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-p6-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
    deps = makeDeps(store, tmpRoot)
  })

  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  it('1. exit 0 + correct expectedExitCode → task-successful', async () => {
    await withNodeSandbox(async () => {
      const candidateId = await seedCandidate(store, {
        files: [{ path: 'ok.ts', content: 'console.log("ok")' }],
      })
      const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
      const tool = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!
      const result = await tool.execute({
        candidateId, command: 'node ok.ts', expectedExitCode: 0, timeoutMs: 10000,
      } as never, { signal: AbortSignal.timeout(15000) }) as {
        ok: boolean; outcome: string; passed: boolean
        executionResult: { outcome: string; exitCode: number | null; evaluation?: string; caseId: string }
      }
      expect(result.ok).toBe(true)
      expect(result.outcome).toBe('task-successful')
      expect(result.passed).toBe(true)
      expect(result.executionResult.outcome).toBe('task-successful')
      expect(result.executionResult.exitCode).toBe(0)
      expect(result.executionResult.evaluation).toContain('matches expected')
      // caseId retained
      expect(result.executionResult.caseId).toBe('live-exec-' + candidateId)
    })
  })

  // ── 2. exit 0 + empty stdout + valid no-output task → successful ────────

  it('2. exit 0 + empty stdout + valid no-output task → task-successful', async () => {
    await withNodeSandbox(async () => {
      const candidateId = await seedCandidate(store, { files: [{ path: 'x.ts', content: 'export {}' }] })
      const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
      const tool = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!
      const result = await tool.execute({
        candidateId, command: 'exit 0', expectedExitCode: 0, timeoutMs: 10000,
      } as never, { signal: AbortSignal.timeout(15000) }) as { ok: boolean; outcome: string }
      expect(result.ok).toBe(true)
      expect(result.outcome).toBe('task-successful')
    })
  })

  // ── 3. exit 0 but wrong expectedExitCode → unsuccessful ──────────────────

  it('3. exit 0 + wrong expectedExitCode (expects 1) → unsuccessful-outcome', async () => {
    await withNodeSandbox(async () => {
      const candidateId = await seedCandidate(store, { files: [{ path: 'x.ts', content: 'export {}' }] })
      const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
      const tool = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!
      const result = await tool.execute({
        candidateId, command: 'exit 0', expectedExitCode: 1, timeoutMs: 10000,
      } as never, { signal: AbortSignal.timeout(15000) }) as { ok: boolean; outcome: string; passed: boolean; executionResult: { evaluation?: string; exitCode: number | null } }
      expect(result.ok).toBe(true)
      // Operator expected exit 1; actual was 0 → task failed
      expect(result.outcome).toBe('unsuccessful-outcome')
      expect(result.passed).toBe(false)
      expect(result.executionResult.exitCode).toBe(0)
      expect(result.executionResult.evaluation).toContain('does not match expected')
    })
  })

  // ── 4. non-zero exit + matching expectedExitCode → successful ───────────

  it('4. non-zero exit 3 + expectedExitCode 3 → task-successful', async () => {
    await withNodeSandbox(async () => {
      const candidateId = await seedCandidate(store, { files: [{ path: 'x.ts', content: 'export {}' }] })
      const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
      const tool = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!
      const result = await tool.execute({
        candidateId, command: 'exit 3', expectedExitCode: 3, timeoutMs: 10000,
      } as never, { signal: AbortSignal.timeout(15000) }) as { ok: boolean; outcome: string; passed: boolean }
      expect(result.ok).toBe(true)
      expect(result.outcome).toBe('task-successful')
      expect(result.passed).toBe(true)
    })
  })

  // ── 5. non-zero exit + no oracle → unsuccessful-outcome (legacy) ───────

  it('5. non-zero exit 42 + no oracle → unsuccessful-outcome (legacy path)', async () => {
    await withNodeSandbox(async () => {
      const candidateId = await seedCandidate(store, { files: [{ path: 'x.ts', content: 'export {}' }] })
      const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
      const tool = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!
      const result = await tool.execute({
        candidateId, command: 'exit 42', timeoutMs: 10000,
      } as never, { signal: AbortSignal.timeout(15000) }) as { ok: boolean; outcome: string; passed: boolean; executionResult: { evaluation?: string } }
      expect(result.ok).toBe(true)
      expect(result.outcome).toBe('unsuccessful-outcome')
      expect(result.passed).toBe(false)
      expect(result.executionResult.evaluation).toContain('legacy mode')
    })
  })

  // ── 6. candidate cannot redefine the oracle ──────────────────────────────

  it('6. candidate manifest with expectedExitCode does NOT influence classification', async () => {
    await withNodeSandbox(async () => {
      // Create a candidate whose manifest.json would declare a different
      // expected exit code. The runner must NOT read the manifest.
      const candidateId = await seedCandidate(store, {
        files: [{ path: 'x.ts', content: 'export {}' }],
      })
      // Write a manifest that tries to redefine the oracle (create the dir first)
      const { writeFile, mkdir } = await import('node:fs/promises')
      const manifestDir = join(store.getRoot(), 'candidates', candidateId)
      await mkdir(manifestDir, { recursive: true })
      const manifestPath = join(manifestDir, 'manifest.json')
      await writeFile(manifestPath, JSON.stringify({
        name: 'evil-candidate',
        version: '1.0.0',
        type: 'policy',
        description: 'manifest redefines oracle',
        entryPoint: 'x.ts',
        benchmarkCases: [{
          id: 'c1', description: 'tricky', input: 'x',
          expectedExitCode: 99, // self-serving value
          timeoutMs: 5000, successCriteria: 'whatever the candidate says',
        }],
      }), 'utf8')

      const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
      const tool = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!

      // Operator passes expectedExitCode=0; manifest claims 99.
      // Actual exit is 0. Outcome must follow the operator, not the manifest.
      const result = await tool.execute({
        candidateId, command: 'exit 0', expectedExitCode: 0, timeoutMs: 10000,
      } as never, { signal: AbortSignal.timeout(15000) }) as { ok: boolean; outcome: string; passed: boolean }
      expect(result.ok).toBe(true)
      // Operator's oracle wins: exit 0 matches expected 0 → task-successful
      // (even though the manifest claims exit 99 is expected)
      expect(result.outcome).toBe('task-successful')
      expect(result.passed).toBe(true)

      // Now operator passes expectedExitCode=1. Actual exit 0 ≠ expected 1.
      // The manifest's claim of 99 does NOT rescue the candidate.
      const result2 = await tool.execute({
        candidateId, command: 'exit 0', expectedExitCode: 1, timeoutMs: 10000,
      } as never, { signal: AbortSignal.timeout(15000) }) as { ok: boolean; outcome: string; passed: boolean }
      expect(result2.ok).toBe(true)
      expect(result2.outcome).toBe('unsuccessful-outcome')
      expect(result2.passed).toBe(false)
    })
  })

  // ── 7. missing oracle → explicit result (no silent pass) ────────────────

  it('7. missing oracle → explicit legacy result, no silent pass', async () => {
    await withNodeSandbox(async () => {
      const candidateId = await seedCandidate(store, { files: [{ path: 'x.ts', content: 'export {}' }] })
      const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
      const tool = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!
      // No expectedExitCode → legacy mode, but result is still explicit
      const result = await tool.execute({
        candidateId, command: 'exit 0', timeoutMs: 10000,
      } as never, { signal: AbortSignal.timeout(15000) }) as { ok: boolean; outcome: string; executionResult: { evaluation?: string } }
      expect(result.ok).toBe(true)
      // Explicit: evaluation string documents that no oracle was provided
      expect(result.executionResult.evaluation).toContain('legacy mode')
      expect(result.outcome).toBe('task-successful')
    })
  })

  // ── 8. invalid expectedExitCode (string) → ignored, legacy fallback ─────

  it('8. invalid expectedExitCode (string "0") → explicitly falls back to legacy mode', async () => {
    await withNodeSandbox(async () => {
      const candidateId = await seedCandidate(store, { files: [{ path: 'x.ts', content: 'export {}' }] })
      const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
      const tool = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!
      // Passing a string instead of a number → invalid value, ignored
      const result = await tool.execute({
        candidateId, command: 'exit 0', expectedExitCode: '0', timeoutMs: 10000,
      } as never, { signal: AbortSignal.timeout(15000) }) as { ok: boolean; outcome: string; executionResult: { evaluation?: string } }
      expect(result.ok).toBe(true)
      // Invalid value silently falls back to legacy mode, not a crash
      expect(result.outcome).toBe('task-successful')
      expect(result.executionResult.evaluation).toContain('legacy mode')
    })
  })

  // ── 9. repeated evaluation is deterministic ──────────────────────────────

  it('9. repeated evaluation with same oracle is deterministic', async () => {
    await withNodeSandbox(async () => {
      const candidateId = await seedCandidate(store, { files: [{ path: 'x.ts', content: 'export {}' }] })
      const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
      const tool = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!
      const results: Array<{ outcome: string; passed: boolean }> = []
      for (let i = 0; i < 3; i++) {
        const r = await tool.execute({
          candidateId, command: 'exit 0', expectedExitCode: 0, timeoutMs: 10000,
        } as never, { signal: AbortSignal.timeout(15000) }) as { outcome: string; passed: boolean }
        results.push({ outcome: r.outcome, passed: r.passed })
      }
      // All three runs must agree
      expect(results.every(r => r.outcome === 'task-successful')).toBe(true)
      expect(results.every(r => r.passed)).toBe(true)
    })
  })

  // ── 10. A/B: baseline and candidate use identical oracle ────────────────

  it('10. A/B benchmark: both sides use the same expectedExitCode', async () => {
    await withNodeSandbox(async () => {
      const candidateId = await seedCandidate(store, {
        files: [{ path: 'ok.ts', content: 'console.log("ok")' }],
      })
      const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
      const ab = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_ab')!
      const result = await ab.execute({
        candidateId, command: 'node ok.ts', expectedExitCode: 0, runs: 2, timeoutMs: 10000,
      } as never, { signal: AbortSignal.timeout(30000) }) as {
        ok: boolean
        abRun: { caseResults?: Array<{ caseId: string; outcome: string; expectedExitCode?: number }> }
      }
      expect(result.ok).toBe(true)
      const allCases = result.abRun.caseResults ?? []
      expect(allCases.length).toBeGreaterThan(0)
      // Every case on both sides must carry the same oracle
      for (const c of allCases) {
        expect(c.expectedExitCode).toBe(0)
        expect(c.outcome).toBe('task-successful')
      }
    })
  })

  // ── 11. A/B with non-zero expectedExitCode: one failed case blocks aggregate ──

  it('11. A/B: one failed case (mismatched exit code) prevents incorrect aggregate', async () => {
    await withNodeSandbox(async () => {
      const candidateId = await seedCandidate(store, {
        files: [{ path: 'x.ts', content: 'export {}' }],
      })
      const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
      const ab = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_ab')!
      // exit 0 but operator expects exit 3 → all cases fail
      const result = await ab.execute({
        candidateId, command: 'exit 0', expectedExitCode: 3, runs: 2, timeoutMs: 10000,
      } as never, { signal: AbortSignal.timeout(30000) }) as {
        ok: boolean
        abRun: { passed: boolean; caseResults?: Array<{ outcome: string }> }
      }
      expect(result.ok).toBe(true)
      const allCases = result.abRun.caseResults ?? []
      // Every case must be unsuccessful (exit 0 ≠ expected 3)
      for (const c of allCases) {
        expect(c.outcome).toBe('unsuccessful-outcome')
      }
      // Aggregate must not be candidate-wins
      expect(result.abRun.passed).toBe(false)
    })
  })

  // ── 12. evaluation evidence is retained in the stored benchmark record ──

  it('12. evaluation evidence is retained in the stored benchmark record', async () => {
    await withNodeSandbox(async () => {
      const candidateId = await seedCandidate(store, { files: [{ path: 'ok.ts', content: 'console.log("ok")' }] })
      const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
      const tool = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!
      await tool.execute({
        candidateId, command: 'node ok.ts', expectedExitCode: 0, timeoutMs: 10000,
      } as never, { signal: AbortSignal.timeout(15000) })

      const stored = await store.listBenchmarks()
      expect(stored.length).toBeGreaterThan(0)
      const rec = stored.find(r => r.candidateId === candidateId)!
      expect(rec.expectedExitCode).toBe(0)
      // details must reference the oracle
      expect(rec.details).toContain('expected=0')
    })
  })

  // ── 13. timeout → execution-failure (regardless of oracle) ──────────────

  it('13. timeout always → execution-failure, oracle does not override', async () => {
    // No sandbox available → timeout is a deterministic property of the sandbox,
    // we use a short-timeout command instead to test it directly in the tool.
    await withNodeSandbox(async () => {
      const candidateId = await seedCandidate(store, { files: [{ path: 'x.ts', content: 'export {}' }] })
      const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
      const tool = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!
      // Use a very short timeout on sleep → guaranteed timedOut=true
      const result = await tool.execute({
        candidateId, command: 'sleep 10', expectedExitCode: 0, timeoutMs: 200,
      } as never, { signal: AbortSignal.timeout(15000) }) as { ok: boolean; outcome: string; passed: boolean; executionResult: { evaluation?: string } }
      expect(result.ok).toBe(true)
      // Timeout → execution-failure regardless of expectedExitCode
      expect(result.outcome).toBe('execution-failure')
      expect(result.passed).toBe(false)
      expect(result.executionResult.evaluation).toContain('Timeout')
    })
  })

  // ── 14. caseId retained in multi-run A/B ────────────────────────────────

  it('14. every A/B run preserves a distinct caseId', async () => {
    await withNodeSandbox(async () => {
      const candidateId = await seedCandidate(store, { files: [{ path: 'ok.ts', content: 'console.log("ok")' }] })
      const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
      const ab = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_ab')!
      const result = await ab.execute({
        candidateId, command: 'node ok.ts', runs: 3, expectedExitCode: 0, timeoutMs: 10000,
      } as never, { signal: AbortSignal.timeout(30000) }) as {
        abRun: { caseResults?: Array<{ caseId: string; expectedExitCode?: number }> }
      }
      const cases = result.abRun.caseResults ?? []
      // 3 runs × 2 sides = up to 6 cases
      expect(cases.length).toBeGreaterThanOrEqual(3)
      const ids = cases.map(c => c.caseId)
      // All caseIds must be unique
      expect(new Set(ids).size).toBe(ids.length)
      // Every case carries the same oracle
      expect(cases.every(c => c.expectedExitCode === 0)).toBe(true)
    })
  })

  // ── 15. realistic existing repository benchmark: turn-efficiency tracker ──

  it('15. realistic smoke: a TypeScript computation module with expected output', async () => {
    await withNodeSandbox(async () => {
      const candidateId = await seedCandidate(store, {
        files: [
          { path: 'compute.ts', content: 'const result = 6 * 7; if (result !== 42) { process.exit(1) }; console.log("result=" + result)' },
        ],
      })
      const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
      const tool = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!

      // Correct result → exit 0 → task-successful with oracle
      const ok = await tool.execute({
        candidateId, command: 'node compute.ts', expectedExitCode: 0, timeoutMs: 10000,
      } as never, { signal: AbortSignal.timeout(15000) }) as {
        ok: boolean; outcome: string; passed: boolean
        executionResult: { stdout: string; exitCode: number | null; evaluation?: string; caseId: string }
      }
      expect(ok.ok).toBe(true)
      expect(ok.outcome).toBe('task-successful')
      expect(ok.executionResult.stdout).toContain('result=42')
      expect(ok.executionResult.exitCode).toBe(0)
      expect(ok.executionResult.evaluation).toContain('matches expected 0')
      expect(ok.executionResult.caseId).toBeDefined()

      // Now force a failing exit: use expectedExitCode=1 but actual is 0
      const wrong = await tool.execute({
        candidateId, command: 'node compute.ts', expectedExitCode: 1, timeoutMs: 10000,
      } as never, { signal: AbortSignal.timeout(15000) }) as { ok: boolean; outcome: string; passed: boolean; executionResult: { evaluation?: string } }
      expect(wrong.ok).toBe(true)
      // Task output was correct (exit 0) but operator expected exit 1 → unsuccessful
      expect(wrong.outcome).toBe('unsuccessful-outcome')
      expect(wrong.passed).toBe(false)
      expect(wrong.executionResult.evaluation).toContain('does not match expected 1')
    })
  })

  // ── 16. A/B oracle consistency: exit code in caseResults matches classification ──

  it('16. A/B caseResults: exitCode and outcome are consistent with the oracle', async () => {
    await withNodeSandbox(async () => {
      const candidateId = await seedCandidate(store, { files: [{ path: 'ok.ts', content: 'console.log("ok")' }] })
      const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
      const ab = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_ab')!
      const result = await ab.execute({
        candidateId, command: 'node ok.ts', runs: 2, expectedExitCode: 0, timeoutMs: 10000,
      } as never, { signal: AbortSignal.timeout(30000) }) as {
        abRun: { caseResults?: Array<{ exitCode: number | null; outcome: string; expectedExitCode?: number }> }
      }
      const cases = result.abRun.caseResults ?? []
      expect(cases.length).toBeGreaterThan(0)
      for (const c of cases) {
        // Classification must be consistent with the oracle
        const expected = c.expectedExitCode
        const actual = c.exitCode
        if (c.outcome === 'task-successful') {
          // exit code must match the oracle (or legacy exit-0 rule)
          expect(actual === expected || (expected === undefined && actual === 0)).toBe(true)
        }
      }
    })
  })
})
