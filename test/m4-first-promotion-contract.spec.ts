/**
 * MISSION M4 — First-promotion semantics (activeVersion === null).
 *
 * PURPOSE
 * This file pins the behaviour of the promotion policy at the version-creation
 * boundary, with emphasis on the first promotion (activeVersion === null).
 *
 * CONTRACT STATUS: RATIFIED as C-1 in docs/CONTRACTS.md
 * ---------------------------------------------------------------------------
 * This suite was originally a characterization harness written while the
 * repository's written contract on first promotion was DISPUTED: two
 * untracked documents contradicted each other, neither superseded the other,
 * and no precedence rule existed. The M4-R authority audit established that no
 * authoritative ratification was present.
 *
 * That dispute is now settled by explicit operator decision and ratified as
 * contract C-1 in docs/CONTRACTS.md:
 *
 *   "When no active version exists, simulated benchmark evidence is REJECTED."
 *
 * The tests that previously recorded the permissive behaviour (M4-1b, M4-1d)
 * and the tests that used simulated evidence merely as a convenient way to
 * reach a later code path (M4-3b, M4-4a, M4-4b) have been updated to use real
 * live evidence where the test is not about C-1, so they keep testing what they
 * were written to test instead of short-circuiting at the evidence gate.
 *
 * The rationale: the first promoted version becomes the baseline every later
 * beats_active comparison is measured against. Installing it from a record
 * that was never executed puts the whole comparative-authority chain on an
 * unverified foundation, and no later promotion can re-establish it.
 *
 * ENFORCEMENT POINT
 * The single policy authority is evaluatePromotionPolicy in
 * src/host/modules/promote/index.ts. The simulated-evidence rejection there is
 * deliberately NOT guarded by `capturedActiveMetrics` — that guard was the
 * whole bug: `capturedActiveMetrics` is undefined on a fresh root, so the gate
 * silently disappeared exactly when it mattered most. Both production callers
 * (evo_promote via tools.ts, evo_full_cycle via runPromotionPolicy) now agree
 * because they route through the same function.
 *
 * The accepted consequence, recorded in the contract: a state root that has
 * only ever produced simulated benchmarks cannot bootstrap. That is a
 * deliberate policy choice, not a defect to be worked around.
 *
 * NOT DECIDED BY C-1
 * C-1 speaks only to records whose mode is the literal string 'simulated'. It
 * does not decide promotion of a candidate with no benchmark at all, nor with
 * an absent/unrecognised mode. M4-1c pins the former as a recorded residual.
 *
 * Scope note: later promotions (active version present) are asserted by the
 * M4-5x block as a regression guard — C-1 must not have changed them.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import { isoDateTime } from '../src/lib/ids.ts'
import { createLiveProvenance } from '../src/lib/provenance.ts'
import type { ModuleDeps, HostContextShape, BenchmarkRun } from '../src/host/types.ts'
import { evaluatePromotionPolicy, runPromotionPolicy } from '../src/host/modules/promote/index.ts'
import { promoteTools } from '../src/host/modules/promote/tools.ts'

function makeCtx(): HostContextShape {
  return {
    tools: { register: () => {} },
    settings: { writable: true, register: () => ({ get: () => ({}) }) },
    agents: { get: () => undefined, roots: () => [] },
    get: () => undefined,
    on: () => {},
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

async function newStore(root: string): Promise<EvolutionStore> {
  const store = new EvolutionStore({ fallbackRoot: root })
  await store.init()
  return store
}

async function addCandidate(
  store: EvolutionStore,
  name: string,
  parentVersion: string,
  content = 'x=1\n',
): Promise<string> {
  const c = await store.addCandidate({
    parentVersion, type: 'policy', name, description: 'd', reason: 'r',
    evidenceIds: [], patternIds: [], status: 'benchmarked',
    files: [{ path: 'src/index.ts', content }],
    tests: [],
    benchmarkConfig: {
      successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
      errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 },
      avgDurationMs: { max: 60000, weight: 0.5 },
    },
  })
  return c.id
}

async function addSimBenchmark(
  store: EvolutionStore, candidateId: string, successRate: number,
): Promise<BenchmarkRun> {
  const candidate = await store.getCandidate(candidateId)
  if (!candidate) throw new Error('candidate fixture missing')
  return store.addBenchmark({
    candidateId, version: candidate.parentVersion, baseline: candidate.parentVersion, parentVersion: candidate.parentVersion, runs: 5,
    metrics: { successRate, avgScore: successRate, errorRate: 1 - successRate, avgSteps: 0, avgDurationMs: 100 },
    passed: successRate >= 0.8, details: 'simulated', mode: 'simulated',
  })
}

async function addLiveBenchmark(
  store: EvolutionStore, candidateId: string, successRate: number, command = 'node test.js',
): Promise<BenchmarkRun> {
  const createdAt = isoDateTime(new Date())
  const candidate = await store.getCandidate(candidateId)
  if (!candidate) throw new Error('candidate fixture missing')
  const version = candidate.parentVersion
  return store.addBenchmark({
    candidateId, version, baseline: version, parentVersion: version, runs: 5,
    metrics: { successRate, avgScore: successRate, errorRate: 1 - successRate, avgSteps: 0, avgDurationMs: 200 },
    passed: successRate >= 0.8, details: 'live sandbox execution: exit 0',
    mode: 'live', command, provenance: createLiveProvenance(candidateId, version, command, createdAt),
  }, createdAt)
}

/** Create an active v1 backed by a sealed live benchmark at `activeRate`. */
async function setupActiveLive(
  store: EvolutionStore, activeRate: number,
): Promise<{ v1Id: string; v2Id: string }> {
  const v1Id = await addCandidate(store, 'v1', 'v0', 'x=1\n')
  await addLiveBenchmark(store, v1Id, activeRate)
  await store.createVersion({ label: 'v1', reason: 'baseline', promotedFrom: 'v0', modules: [v1Id] })
  const v2Id = await addCandidate(store, 'v2', 'v1', 'x=2\n')
  return { v1Id, v2Id }
}

async function withStore(fn: (store: EvolutionStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'm4-first-'))
  try { await fn(await newStore(root), root) } finally { await rm(root, { recursive: true, force: true }) }
}

describe('M4 — first promotion: supported evidence modes (policy level)', () => {
  it('M4-1a: no active version + LIVE evidence → policy allows promotion', async () => {
    await withStore(async (store, root) => {
      const v1Id = await addCandidate(store, 'v1', 'v0')
      await addLiveBenchmark(store, v1Id, 0.95)

      const result = await evaluatePromotionPolicy(makeDeps(store, root), await store.getCandidate(v1Id)!)

      expect(result.ok).toBe(true)
      if (result.ok) {
        // No active baseline exists, so no metrics are captured for provenance.
        expect(result.activeMetrics).toBeUndefined()
      }
    })
  })

  it('M4-1b: no active version + SIMULATED evidence → policy REJECTS (contract C-1)', async () => {
    // This is the case the disputed guard got wrong. The simulated-evidence
    // rejection used to require `capturedActiveMetrics`, which is undefined on
    // a fresh root, so the gate disappeared precisely when there was no
    // baseline to catch the fabrication.
    await withStore(async (store, root) => {
      const v1Id = await addCandidate(store, 'v1', 'v0')
      await addSimBenchmark(store, v1Id, 0.95)

      const result = await evaluatePromotionPolicy(makeDeps(store, root), await store.getCandidate(v1Id)!)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/simulated evidence/)
    })
  })

  it('M4-1c: no active version + NO benchmark at all → Red Team gate is INCONCLUSIVE (C-3)', async () => {
    // C-3 supersedes the earlier residual: missing evidence must never be
    // interpreted as promotion eligibility. The shared policy blocks it.
    await withStore(async (store, root) => {
      const v1Id = await addCandidate(store, 'v1', 'v0')
      expect(await store.listBenchmarks(500)).toHaveLength(0)

      const result = await evaluatePromotionPolicy(makeDeps(store, root), await store.getCandidate(v1Id)!)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.redTeamGate.verdict).toBe('INCONCLUSIVE')
        expect(result.error).toMatch(/red-team promotion gate INCONCLUSIVE/)
      }
    })
  })

  it('M4-1d: runPromotionPolicy REJECTS a first promotion on simulated evidence (the evo_full_cycle path)', async () => {
    // runPromotionPolicy is what evo_full_cycle calls (evolution/tools.ts:332).
    // Before C-1 this path succeeded on a fresh root and created v1 as active
    // from a never-executed record; evo_promote on the same store rejected it.
    // The two callers now agree because they share one policy authority.
    await withStore(async (store, root) => {
      const v1Id = await addCandidate(store, 'v1', 'v0')
      await addSimBenchmark(store, v1Id, 0.95)

      const result = await runPromotionPolicy(
        makeDeps(store, root), await store.getCandidate(v1Id)!, 'first-promotion', 'v1',
      )

      expect(result.ok).toBe(false)
      expect(await store.listVersions(200)).toHaveLength(0)
      expect(await store.readPointer()).toBeNull()
      expect(await store.getActiveVersion()).toBeNull()
    })
  })
})

describe('M4 — first promotion: the manual tool applies a stricter gate', () => {
  it('M4-2a: evo_promote on a FRESH ROOT rejects simulated evidence (no live benchmark)', async () => {
    // The manual tool gate in promote/tools.ts is unconditional: it does not
    // consult whether an active version exists. It now AGREES with the policy
    // layer pinned by M4-1b — before C-1 these two disagreed, and that
    // disagreement was the defect this contract closes.
    await withStore(async (store, root) => {
      const v1Id = await addCandidate(store, 'v1', 'v0')
      await addSimBenchmark(store, v1Id, 0.95)

      const tool = promoteTools(makeDeps(store, root)).find(t => t.name === 'evo_promote')!
      const result = await tool.execute({ candidateId: v1Id } as never, { signal: AbortSignal.timeout(10_000) }) as { ok: boolean; error?: string }

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/red-team promotion gate FAIL|simulated evidence is not promotion-eligible|simulated evidence/i)
    })
  })

  it('M4-2b: evo_promote on a FRESH ROOT accepts live evidence past the evidence gate', async () => {
    // Asserts only that the live-evidence gate is passed. The outcome after
    // that point depends on sandbox availability, so it is deliberately not
    // asserted here.
    await withStore(async (store, root) => {
      const v1Id = await addCandidate(store, 'v1', 'v0')
      await addLiveBenchmark(store, v1Id, 0.95)

      const tool = promoteTools(makeDeps(store, root)).find(t => t.name === 'evo_promote')!
      const result = await tool.execute({ candidateId: v1Id } as never, { signal: AbortSignal.timeout(20_000) }) as { ok: boolean; error?: string }

      // Whatever happens downstream, the evidence gate must not be what blocked it.
      expect(result.error ?? '').not.toMatch(/red-team promotion gate FAIL|simulated evidence is not promotion-eligible|simulated evidence/i)
    })
  })
})

describe('M4 — failed first promotion leaves no partial active state', () => {
  it('M4-3a: rejected first promotion creates no version, no pointer, no active', async () => {
    await withStore(async (store, root) => {
      const v1Id = await addCandidate(store, 'v1', 'v0')
      await addSimBenchmark(store, v1Id, 0.95)

      const tool = promoteTools(makeDeps(store, root)).find(t => t.name === 'evo_promote')!
      const result = await tool.execute({ candidateId: v1Id } as never, { signal: AbortSignal.timeout(10_000) }) as { ok: boolean }
      expect(result.ok).toBe(false)

      // No version record, no active pointer, active state still null.
      expect(await store.listVersions(200)).toHaveLength(0)
      expect(await store.readPointer()).toBeNull()
      expect(await store.getActiveVersion()).toBeNull()
      // The version artifact directory is intentionally NOT asserted absent:
      // promote/tools.ts:100-104 documents the planned directory as an
      // unreferenced scratch that survives a failed pre-flight.
      void root
    })
  })

  it('M4-3b: first promotion with an artifact that cannot validate throws before any store mutation', async () => {
    await withStore(async (store, root) => {
      // A candidate whose file path escapes containment cannot materialize.
      const bad = await store.addCandidate({
        parentVersion: 'v0', type: 'policy', name: 'bad', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: '../../escape.ts', content: 'boom\n' }],
        tests: [],
        benchmarkConfig: {
          successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 },
          avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      await addLiveBenchmark(store, bad.id, 0.95)

      // Either outcome is acceptable; what must hold is that no active state
      // is created when the promotion does not succeed.
      let ok = false
      try {
        const r = await runPromotionPolicy(
          makeDeps(store, root), await store.getCandidate(bad.id)!, 'bad', 'v1',
        )
        ok = r.ok
      } catch {
        ok = false
      }

      if (!ok) {
        expect(await store.readPointer()).toBeNull()
        expect(await store.getActiveVersion()).toBeNull()
        expect(await access(join(root, 'versions', 'v1.json')).then(() => true).catch(() => false)).toBe(false)
      }
    })
  })
})

describe('M4 — first promotion: pointer generation and restart recovery', () => {
  it('M4-4a: a successful first promotion writes pointer generation 1 pointing at v1', async () => {
    await withStore(async (store, root) => {
      expect(await store.readPointer()).toBeNull()

      const v1Id = await addCandidate(store, 'v1', 'v0')
      await addLiveBenchmark(store, v1Id, 0.95)
      const result = await runPromotionPolicy(
        makeDeps(store, root), await store.getCandidate(v1Id)!, 'first-promotion', 'v1',
      )
      expect(result.ok).toBe(true)

      const pointer = await store.readPointer()
      expect(pointer).toMatchObject({ versionId: 'v1', generation: 1 })
    })
  })

  it('M4-4b: after restart the first active version resolves from the pointer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm4-restart-'))
    try {
      const store = await newStore(root)
      const v1Id = await addCandidate(store, 'v1', 'v0')
      await addLiveBenchmark(store, v1Id, 0.95)
      const result = await runPromotionPolicy(
        makeDeps(store, root), await store.getCandidate(v1Id)!, 'first-promotion', 'v1',
      )
      expect(result.ok).toBe(true)

      // Simulate a process restart: a brand-new store instance on the same root.
      const reopened = await newStore(root)
      const active = await reopened.getActiveVersion()
      expect(active).toMatchObject({ id: 'v1', status: 'active' })
      expect(await reopened.readPointer()).toMatchObject({ versionId: 'v1', generation: 1 })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('M4-4c: a rejected first promotion leaves no phantom active state after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm4-reject-restart-'))
    try {
      const store = await newStore(root)
      const v1Id = await addCandidate(store, 'v1', 'v0')
      await addSimBenchmark(store, v1Id, 0.95)

      const tool = promoteTools(makeDeps(store, root)).find(t => t.name === 'evo_promote')!
      const result = await tool.execute({ candidateId: v1Id } as never, { signal: AbortSignal.timeout(10_000) }) as { ok: boolean }
      expect(result.ok).toBe(false)

      // A restart must not resurrect an active version from the rejected
      // attempt: there is no version record and no pointer to resolve.
      const reopened = await newStore(root)
      expect(await reopened.getActiveVersion()).toBeNull()
      expect(await reopened.readPointer()).toBeNull()
      expect(await reopened.listVersions(200)).toHaveLength(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

describe('M4 — later promotions remain unchanged (regression guard)', () => {
  it('M4-5a: active version + SIMULATED evidence → still rejected by the policy gate', async () => {
    await withStore(async (store, root) => {
      const { v2Id } = await setupActiveLive(store, 0.95)
      await addSimBenchmark(store, v2Id, 0.99)

      const result = await evaluatePromotionPolicy(makeDeps(store, root), await store.getCandidate(v2Id)!)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/simulated evidence/)
    })
  })

  it('M4-5b: active version + LIVE evidence that does not beat active → beats_active still enforced', async () => {
    await withStore(async (store, root) => {
      const { v2Id } = await setupActiveLive(store, 0.95)
      await addLiveBenchmark(store, v2Id, 0.90)

      const result = await evaluatePromotionPolicy(makeDeps(store, root), await store.getCandidate(v2Id)!)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/beats_active gate failed/)
    })
  })

  it('M4-5c: active version + better LIVE evidence → allowed, and the active baseline is captured', async () => {
    await withStore(async (store, root) => {
      const { v2Id } = await setupActiveLive(store, 0.95)
      await addLiveBenchmark(store, v2Id, 0.98)

      const result = await evaluatePromotionPolicy(makeDeps(store, root), await store.getCandidate(v2Id)!)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.activeMetrics?.successRate).toBeCloseTo(0.95, 2)
      }
    })
  })

  it('M4-5d: a rejected later promotion leaves the active version untouched', async () => {
    await withStore(async (store, root) => {
      const { v1Id, v2Id } = await setupActiveLive(store, 0.95)
      await addSimBenchmark(store, v2Id, 0.99)
      const before = await store.readPointer()

      const result = await runPromotionPolicy(
        makeDeps(store, root), await store.getCandidate(v2Id)!, 'should-not-promote', 'v2',
      )

      expect(result.ok).toBe(false)
      expect(await store.getActiveVersion()).toMatchObject({ id: 'v1' })
      expect(await store.readPointer()).toMatchObject(before!)
    })
  })
})

/**
 * CONTRACT REGRESSION SUITE FOR C-1 (docs/CONTRACTS.md)
 *
 * One test per clause of the ratified contract, named after the clause rather
 * than after the mission that produced it. The M4 blocks above record the
 * historical dispute matrix; this block is the standing proof that the
 * ratified rule holds and that the two promotion paths cannot drift apart
 * again.
 *
 * C-1: "When no active version exists, simulated benchmark evidence is
 * REJECTED." Nothing else about promotion is changed by it.
 */
describe('C-1 — first-promotion evidence contract', () => {
  it('C1-1: first promotion with LIVE evidence is allowed and creates the active version', async () => {
    await withStore(async (store, root) => {
      const v1Id = await addCandidate(store, 'v1', 'v0')
      await addLiveBenchmark(store, v1Id, 0.95)

      const result = await runPromotionPolicy(
        makeDeps(store, root), await store.getCandidate(v1Id)!, 'c1-first-live', 'v1',
      )

      // Live evidence is never blocked by C-1, so a fresh root is not a dead end.
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.version.id).toBe('v1')
        expect(result.version.status).toBe('active')
      }
      expect(await store.getActiveVersion()).toMatchObject({ id: 'v1' })
      expect(await store.readPointer()).toMatchObject({ versionId: 'v1', generation: 1 })
    })
  })

  it('C1-2: first promotion with SIMULATED evidence is REJECTED by both production paths', async () => {
    await withStore(async (store, root) => {
      const v1Id = await addCandidate(store, 'v1', 'v0')
      await addSimBenchmark(store, v1Id, 0.95)
      const deps = makeDeps(store, root)

      // Autonomous path (evo_full_cycle → runPromotionPolicy).
      const viaPolicy = await runPromotionPolicy(
        deps, await store.getCandidate(v1Id)!, 'c1-first-sim-auto', 'v1',
      )
      // Manual path (evo_promote).
      const tool = promoteTools(deps).find(t => t.name === 'evo_promote')!
      const viaTool = await tool.execute(
        { candidateId: v1Id } as never, { signal: AbortSignal.timeout(10_000) },
      ) as { ok: boolean; error?: string }

      expect(viaPolicy.ok).toBe(false)
      if (!viaPolicy.ok) expect(viaPolicy.error).toMatch(/simulated evidence/)
      expect(viaTool.ok).toBe(false)
      expect(viaTool.error).toMatch(/red-team promotion gate FAIL|simulated evidence is not promotion-eligible|simulated evidence/i)

      // Neither path may leave partial state behind.
      expect(await store.listVersions(200)).toHaveLength(0)
      expect(await store.readPointer()).toBeNull()
      expect(await store.getActiveVersion()).toBeNull()
    })
  })

  it('C1-3: active version + SIMULATED evidence is rejected (C-1 does not weaken later promotions)', async () => {
    await withStore(async (store, root) => {
      const { v2Id } = await setupActiveLive(store, 0.95)
      // Strictly better than active, so only the evidence mode can be the reason.
      await addSimBenchmark(store, v2Id, 0.99)

      const result = await evaluatePromotionPolicy(makeDeps(store, root), await store.getCandidate(v2Id)!)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/simulated evidence/)
    })
  })

  it('C1-4: active version + LIVE evidence is judged comparatively, not on evidence mode alone', async () => {
    await withStore(async (store, root) => {
      const { v2Id } = await setupActiveLive(store, 0.95)
      await addLiveBenchmark(store, v2Id, 0.98)

      const allowed = await evaluatePromotionPolicy(makeDeps(store, root), await store.getCandidate(v2Id)!)
      expect(allowed.ok).toBe(true)
      if (allowed.ok) expect(allowed.activeMetrics?.successRate).toBeCloseTo(0.95, 2)

      // Worse than active → the beats_active gate (M1) still owns this case.
      const { v2Id: v3Id } = await setupActiveLive(store, 0.95)
      await addLiveBenchmark(store, v3Id, 0.90)
      const rejected = await evaluatePromotionPolicy(makeDeps(store, root), await store.getCandidate(v3Id)!)
      expect(rejected.ok).toBe(false)
      if (!rejected.ok) expect(rejected.error).toMatch(/beats_active gate failed/)
    })
  })

  it('C1-5: a failed promotion leaves the active state completely unchanged', async () => {
    // (a) first promotion fails → nothing becomes active.
    await withStore(async (store, root) => {
      const v1Id = await addCandidate(store, 'v1', 'v0')
      await addSimBenchmark(store, v1Id, 0.95)

      const failed = await runPromotionPolicy(
        makeDeps(store, root), await store.getCandidate(v1Id)!, 'c1-fail-first', 'v1',
      )

      expect(failed.ok).toBe(false)
      expect(await store.listVersions(200)).toHaveLength(0)
      expect(await store.readPointer()).toBeNull()
      expect(await store.getActiveVersion()).toBeNull()
      // The candidate is not left claiming a promoted state either.
      expect((await store.getCandidate(v1Id))?.status).toBe('benchmarked')
    })

    // (b) later promotion fails → the previously active version stays active,
    //     with its pointer untouched down to the generation number.
    await withStore(async (store, root) => {
      const { v2Id } = await setupActiveLive(store, 0.95)
      const pointerBefore = await store.readPointer()
      await addSimBenchmark(store, v2Id, 0.99)

      const failed = await runPromotionPolicy(
        makeDeps(store, root), await store.getCandidate(v2Id)!, 'c1-fail-later', 'v2',
      )

      expect(failed.ok).toBe(false)
      expect(await store.getActiveVersion()).toMatchObject({ id: 'v1' })
      expect(await store.readPointer()).toEqual(pointerBefore)
      expect(await store.listVersions(200)).toHaveLength(1)
    })
  })
})
