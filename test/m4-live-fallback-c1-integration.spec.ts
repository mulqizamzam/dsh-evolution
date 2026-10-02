/**
 * MISSION M4 (integration layer) — the live→simulated benchmark fallback can
 * never yield a promotable candidate.
 *
 * THE CHAIN LOCKED HERE, end to end, through the real production entry point
 * `evo_full_cycle` (src/host/modules/evolution/tools.ts):
 *
 *   STEP 6  calls `evo_benchmark_live`                          (tools.ts:241-256)
 *     └─ forced to `{ok:false, error:'sandbox not available'}`  (see MOCK below)
 *   STEP 7  sees `!benchResult || benchResult.ok !== true`, so it FALLS BACK to
 *           `evo_benchmark_run` and sets `benchmarkPassed = simResult.passed`
 *                                                        (tools.ts:258-279)
 *     └─ `evo_benchmark_run` writes a `mode:'simulated'` BenchmarkRun
 *        (benchmark/tools.ts:193-204) and, on a pass, marks the candidate
 *        `'benchmarked'` (benchmark/tools.ts:203)
 *   STEP 8  both early returns are deliberately NOT what happens here:
 *     ├─ `!cfg.promotion.enabled` → 'promotion is disabled by config' (tools.ts:286)
 *     └─ `!benchmarkPassed`       → 'benchmark did not pass'            (tools.ts:297)
 *     with promotion enabled and a PASSING simulated benchmark, the cycle calls
 *     `runPromotionPolicy` (tools.ts:340) →
 *   C-1     `evaluatePromotionPolicy` rejects `mode === 'simulated'`
 *           UNCONDITIONALLY (promote/index.ts:78-83) — including on a fresh
 *           root with no active version, which is exactly the case here.
 *
 *   ⇒ REJECTED, with no version record, no active pointer, and no active
 *     version — before or after a simulated restart.
 *
 * The point of the lock: the STEP 7 fallback is a *convenience* path, not a
 * promotion path. It can produce a candidate that looks promotable
 * (`status:'benchmarked'`, a passing benchmark) and it must still be refused
 * at the version-creation boundary. This suite is the standing proof that the
 * refusal happens there and not in some earlier short-circuit.
 *
 * ── WHY THE MOCK IS REQUIRED (host independence) ──────────────────────────
 * STEP 6 normally fails on a machine with no bubblewrap: `evo_benchmark_live`
 * returns `{ok:false, error:'sandbox not available'}` after
 * `sandbox.isAvailable()` fails (benchmark/tools.ts:281-283), and
 * `isAvailable()` is literally `access('/usr/bin/bwrap', X_OK)` +
 * `execSync('bwrap --version')` (sandbox/index.ts:30-33).
 *
 * `/usr/bin/bwrap` IS PRESENT on this host, so the natural failure cannot be
 * reproduced here, and a live run would instead succeed and write a
 * `mode:'live'` record — making the test pass vacuously on this machine and
 * fail on a bwrap-less CI box. The `ok:false` is therefore FORCED, via
 * `vi.mock`, rather than waited for. The suite is then identical on both kinds
 * of host.
 *
 * WHAT THE MOCK TOUCHES: only the `execute` of the `evo_benchmark_live` tool.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH:
 *   • `evo_benchmark_run` stays REAL. The simulated record it writes IS the
 *     thing C-1 must reject — faking that would prove nothing.
 *   • `evaluatePromotionPolicy` / `runPromotionPolicy` stay REAL. They live in
 *     `src/host/modules/promote/index.ts`, which imports nothing from
 *     `benchmark/tools.ts` (promote/index.ts:1-6), so the mock cannot reach
 *     the C-1 verdict.
 *   The C-1 rejection in this file is therefore produced by production code.
 *
 * `evolution/tools.ts` reaches the benchmark module through a DYNAMIC import
 * (`await import('../benchmark/tools.ts')`, lines 245 and 267). `vi.mock` is
 * hoisted and keyed on the RESOLVED module id, so it covers dynamic imports
 * from the same test module graph.
 *
 * ── WHY THE FIXTURE IS SHAPED THIS WAY ────────────────────────────────────
 * 10 experiences: 8 × `{success:true, score:1.0, stepCount:5, durationMs:100}`
 * and 2 × `{success:false, stepCount:5, durationMs:31000,
 * errors:['timeout: request timed out after 30s']}`.
 * Under the builder's own benchmarkConfig (successRate.min 0.8, avgScore.min
 * 0.7, errorRate.max 0.2, avgSteps.max 50, avgDurationMs.max 60000):
 *   successRate 8/10 = 0.8 ≥ 0.8 ✓ | avgScore 1.0 ≥ 0.7 ✓
 *   errorRate 2/10 = 0.2 ≤ 0.2 ✓  | avgSteps 5 ≤ 50 ✓ | avgDuration 6280 ≤ 60000 ✓
 * The simulated benchmark therefore PASSES. That is essential: had it failed,
 * the cycle would have stopped at 'benchmark did not pass' (tools.ts:297) and
 * this file would prove nothing about C-1.
 *
 * `minOccurrences: 2` (a tool argument — `evo_full_cycle` does NOT read
 * `cfg.evolution.analysis.minOccurrences`) lets the 2 shared-error failures
 * form a recurring-signature cluster (analyze/tools.ts:95-106). Their
 * `stepCount` of 5 keeps the average failed step count below the threshold of
 * 10, so the separate 'inefficiency' pattern (analyze/tools.ts:123-137) does
 * not fire and the test does not depend on `candidateTypeFor` for that type.
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import { evolutionTools } from '../src/host/modules/evolution/tools.ts'
import { makeFakeHost } from './helpers/fake-host.ts'
import type {
  BenchmarkRun,
  CandidateModule,
  HostLlmGenerateOptions,
  HostLlmStreamChunk,
  ModuleDeps,
} from '../src/host/types.ts'

// ── Force STEP 6's live benchmark to fail, deterministically ───────────────
// Only `evo_benchmark_live.execute` is replaced. `evo_benchmark_run` — the tool
// whose `mode:'simulated'` record C-1 must reject — stays the real one.
vi.mock('../src/host/modules/benchmark/tools.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/modules/benchmark/tools.ts')>()
  return {
    ...actual,
    benchmarkTools: (deps: never) => actual.benchmarkTools(deps).map((t) =>
      t.name === 'evo_benchmark_live'
        ? { ...t, execute: async () => ({ ok: false, error: 'sandbox not available' }) }
        : t,
    ),
  }
})

/** A file set that passes validateCandidateFileSet (builder/tools.ts:162). */
const CANDIDATE_JSON = JSON.stringify({
  manifest: {
    name: 'timeout-guard',
    version: '1.0.0',
    type: 'policy',
    description: 'Bound every outbound call so the recurring 30s timeout signature cannot recur.',
    entryPoint: 'src/index.ts',
    benchmarkCases: [
      {
        id: 'case-1',
        description: 'the generated entry point loads',
        input: 'echo timeout-guard-ok',
        expectedOutput: 'timeout-guard-ok',
        expectedExitCode: 0,
        timeoutMs: 10000,
        successCriteria: 'command exits 0 and prints the marker',
      },
    ],
  },
  files: [
    {
      path: 'src/index.ts',
      content: 'export default function timeoutGuard() {\n  return { timeoutMs: 30000 }\n}\n',
    },
  ],
  tests: [
    { path: 'test/index.spec.ts', content: 'export const smoke = true\n' },
  ],
})

function makeDeps(store: EvolutionStore, root: string): ModuleDeps {
  // evo_builder_generate needs BOTH services: the model selection
  // (builder/tools.ts:94-101) and the stream (builder/tools.ts:103, 123).
  // evo_full_cycle forwards apiUrl/apiKey/model as tool args but NOT
  // providerOverride/modelOverride, so the host selection is what is used.
  const host = makeFakeHost({
    providers: {
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }),
      },
      llm: {
        stream: async function* (_options: HostLlmGenerateOptions): AsyncIterable<HostLlmStreamChunk> {
          yield { type: 'text-delta', index: 0, text: CANDIDATE_JSON }
          yield { type: 'usage', index: 0, usage: { inputTokens: 128, outputTokens: 256 } }
          yield { type: 'finish', index: 0, reason: { kind: 'stop' } }
        },
      },
    },
  })
  return {
    ctx: host.ctx,
    cfg: () => resolveConfig({
      stateRoot: root,
      evolution: {
        enabled: true,
        autoRecord: false,
        autoTrigger: false,
        analysis: { minExperiences: 1, minOccurrences: 2 },
        generation: { enabled: true },   // REQUIRED: STEP 0 aborts otherwise
        promotion: { enabled: true },    // REQUIRED: STEP 8 short-circuits otherwise
        maxCyclesPerProcess: 1,
      },
    }),
    store,
    log: () => {},
    warn: () => {},
  }
}

describe('M4 integration — live→simulated fallback can never promote (contract C-1)', () => {
  it('M4-LF-C1: live fails → simulated fallback passes → C-1 rejects → no version, no pointer, no active (also after restart)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm4-live-fallback-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()
      const deps = makeDeps(store, root)

      // ── Fixture: the simulated benchmark PASSES every threshold ──────────
      for (let i = 0; i < 8; i++) {
        await store.addExperience({
          success: true, score: 1.0, stepCount: 5, durationMs: 100,
          errors: [], summary: 'steady-state-ok',
        })
      }
      for (let i = 0; i < 2; i++) {
        await store.addExperience({
          success: false, stepCount: 5, durationMs: 31000,
          errors: ['timeout: request timed out after 30s'],
          prompt: 'call a slow upstream endpoint',
        })
      }

      const cycle = evolutionTools(deps).find(t => t.name === 'evo_full_cycle')!
      const result = await cycle.execute({
        apiUrl: 'http://llm.invalid',
        apiKey: 'test-key',
        model: 'test-model',
        testCommand: 'node src/index.ts',
        minOccurrences: 2,
      } as never, { signal: AbortSignal.timeout(60_000) }) as Record<string, unknown>

      // (1) The cycle is rejected.
      expect(result.ok).toBe(false)
      expect(result.verdict).toBe('REJECTED')
      const candidateId = String(result.candidateId)
      expect(candidateId).not.toBe('')

      // The cycle ran the WHOLE chain: it reached STEP 8's decision point
      // instead of returning early, so 'promotion is disabled by config' and
      // 'benchmark did not pass' are excluded by construction as well as by
      // the reason assertion below.
      expect(result.steps).toEqual([
        'observe', 'analyze', 'propose', 'build', 'validate',
        'sandbox', 'benchmark', 'promote-or-reject',
      ])

      // (2) The fallback ACTUALLY RAN and left a simulated record behind —
      //     not merely "no evidence was produced".
      const records = (await store.listBenchmarks(500))
        .filter(b => b.candidateId === candidateId)
        .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))
      expect(records).toHaveLength(1)
      const latest = records[0] as BenchmarkRun
      expect(latest.mode).toBe('simulated')
      // ...and it PASSED, so 'benchmark did not pass' was structurally
      // unreachable. These are the exact metrics derived from the fixture.
      expect(latest.passed).toBe(true)
      expect(latest.metrics).toMatchObject({
        successRate: 0.8, avgScore: 1, errorRate: 0.2, avgSteps: 5, avgDurationMs: 6280,
      })

      // (3) The rejection came from the C-1 gate, verbatim.
      const reason = String(result.reason)
      expect(reason).toMatch(/simulated evidence/i)
      expect(reason).not.toMatch(/promotion is disabled/)
      expect(reason).not.toMatch(/benchmark did not pass/)

      // (4) Terminal state of the candidate. The cycle DID mark it
      //     'benchmarked' (tools.ts:322) and `evo_benchmark_run` had already
      //     (benchmark/tools.ts:203) — but once the C-1 gate rejected the
      //     promotion, tools.ts:347 overwrote that with 'rejected'. Asserting
      //     'benchmarked' here would be asserting a state the production code
      //     does not leave behind; the step trail + the passing simulated
      //     record + the C-1 reason above are the real proof that the
      //     rejection came from C-1 and not from an earlier short-circuit.
      const candidate = await store.getCandidate(candidateId) as CandidateModule
      expect(candidate.status).toBe('rejected')

      // (5)(6)(7) No version, no pointer, no active version.
      expect(await store.listVersions(200)).toHaveLength(0)
      expect(await store.readPointer()).toBeNull()
      expect(await store.getActiveVersion()).toBeNull()

      // (8) A restart must not resurrect active state from the failed attempt.
      const reopened = new EvolutionStore({ fallbackRoot: root })
      await reopened.init()
      expect(await reopened.getActiveVersion()).toBeNull()
      expect(await reopened.readPointer()).toBeNull()
      expect(await reopened.listVersions(200)).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
