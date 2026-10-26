/**
 * M3.3 — Provenance & Metrics Integrity Regression Tests
 *
 * These tests verify that the provenance seal and metric integrity gates
 * correctly reject tampered benchmark evidence. They are regression tests
 * for the vulnerabilities exposed by the M3.3 audit (docs/M33-M34-AUDIT-REPORT.md).
 *
 * Primary invariant:
 *   "No caller-controlled or persisted-data mutation may be sufficient to
 *    create promotion-eligible benchmark evidence."
 *
 * Current coverage:
 *   T1 documents the explicit limit: the trusted store API can create a new,
 *      internally consistent record; an unkeyed digest is not an authenticity
 *      boundary against a privileged writer.
 *   T2–T6 verify edits to persisted record contents are rejected by the
 *      store-issued full-record attestation, even if provenance is recomputed.
 *   T7 verifies a simulated→live mode flip is blocked.
 *   T8 verifies a legitimately created live record passes.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import { isoDateTime } from '../src/lib/ids.ts'
import { createLiveProvenance, verifyLiveProvenance } from '../src/lib/provenance.ts'
import type { ModuleDeps, HostContextShape, BenchmarkRun } from '../src/host/types.ts'
import { evaluatePromotionPolicy } from '../src/host/modules/promote/index.ts'

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

async function tamperBenchmarkFile(root: string, benchmarkId: string, mutations: Record<string, unknown>): Promise<void> {
  const path = join(root, 'benchmarks', `${benchmarkId}.json`)
  const raw = JSON.parse(await readFile(path, 'utf8'))
  Object.assign(raw, mutations)
  await writeFile(path, JSON.stringify(raw, null, 2), 'utf8')
}

async function makeActiveLive(
  store: EvolutionStore,
  root: string,
  activeRate: number,
): Promise<{ v1Id: string; v2Id: string }> {
  const v1 = await store.addCandidate({
    parentVersion: 'v0', type: 'policy', name: 'v1', description: 'd', reason: 'r',
    evidenceIds: [], patternIds: [], status: 'benchmarked',
    files: [{ path: 'src/index.ts', content: 'x=1\n' }],
    tests: [],
    benchmarkConfig: {
      successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
      errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
    },
  })
  const createdAt1 = isoDateTime(new Date())
  await store.addBenchmark({
    candidateId: v1.id, version: 'v-temp', baseline: 'unknown', runs: 3,
    metrics: { successRate: activeRate, avgScore: activeRate, errorRate: 1 - activeRate, avgSteps: 0, avgDurationMs: 200 },
    passed: true, details: 'live', mode: 'live', command: 'node test.js',
    provenance: createLiveProvenance(v1.id, 'v-temp', 'node test.js', createdAt1),
  })
  await store.createVersion({ label: 'v1', reason: 'release', promotedFrom: 'v0', modules: [v1.id] })

  const v2 = await store.addCandidate({
    parentVersion: 'v1', type: 'policy', name: 'v2', description: 'd', reason: 'r',
    evidenceIds: [], patternIds: [], status: 'benchmarked',
    files: [{ path: 'src/index.ts', content: 'x=2\n' }],
    tests: [],
    benchmarkConfig: {
      successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
      errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
    },
  })
  return { v1Id: v1.id, v2Id: v2.id }
}

describe('M3.3 — Provenance & Metrics Integrity Regression', () => {

  // T1: explicit scope limit. The benchmark insertion API is trusted internal
  // code and signs a newly submitted record; the digest cannot prove that a
  // privileged caller actually ran a command in the sandbox.
  it('T1: attestation is integrity, not an authenticity boundary for privileged store callers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm33-t1-recompute-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()
      const { v1Id, v2Id } = await makeActiveLive(store, root, 0.95)

      // The privileged store caller can submit an internally consistent record
      // and the store will attest its fields. This is deliberately documented
      // as outside the protection offered by an unkeyed persisted-record digest.
      const createdAt = isoDateTime(new Date())
      const command = 'node test.js'
      const recomputedSeal = createLiveProvenance(v2Id, 'v-temp', command, createdAt)

      await store.addBenchmark({
        candidateId: v2Id, version: 'v-temp', baseline: 'unknown', runs: 3,
        metrics: { successRate: 0.99, avgScore: 0.99, errorRate: 0, avgSteps: 0, avgDurationMs: 100 },
        passed: true, details: 'privileged store write', mode: 'live', command,
        provenance: recomputedSeal,
      }, createdAt)

      const deps = makeDeps(store, root)
      const candidate = await store.getCandidate(v2Id)!
      const result = await evaluatePromotionPolicy(deps, candidate)

      // This intentionally passes, demonstrating the documented limitation:
      // a privileged caller trusted with store insertion can mint an internally
      // consistent record. Candidate-authored sandbox code has no store API or
      // state-root access, so this is not a candidate-level attack path.
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.redTeamGate.verdict).toBe('PASS')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  // T2: Changing metrics after persistence must invalidate the full-record attestation.
  it('T2: metric-only tampering with original provenance is rejected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm33-t2-metric-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()
      const { v1Id, v2Id } = await makeActiveLive(store, root, 0.95)

      // Write the benchmark first; addBenchmark sets its own createdAt.
      // To build a valid seal we must use the stored createdAt, so add a
      // placeholder seal and then re-seal via tamperBenchmarkFile.
      const goodRecord = await store.addBenchmark({
        candidateId: v2Id, version: 'v-temp', baseline: 'unknown', runs: 3,
        metrics: { successRate: 0.98, avgScore: 0.98, errorRate: 0.02, avgSteps: 0, avgDurationMs: 200 },
        passed: true, details: 'live sandbox execution: exit 0', mode: 'live', command: 'node test.js',
        provenance: '',
      })
      // Re-seal with the stored createdAt so the seal is internally consistent
      const goodSeal = createLiveProvenance(v2Id, 'v-temp', 'node test.js', goodRecord.createdAt)
      await tamperBenchmarkFile(root, goodRecord.id, { provenance: goodSeal })

      // Tamper only metrics
      await tamperBenchmarkFile(root, goodRecord.id, {
        metrics: { successRate: 1.0, avgScore: 1.0, errorRate: 0, avgSteps: 0, avgDurationMs: 50 },
      })

      const deps = makeDeps(store, root)
      const candidate = await store.getCandidate(v2Id)!
      const result = await evaluatePromotionPolicy(deps, candidate)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/attestation/i)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  // T3: Recomputing the public provenance after editing stored content must
  // not repair the independent full-record attestation.
  it('T3: metric tampering plus recomputed provenance is rejected by attestation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm33-t3-both-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()
      const { v2Id } = await makeActiveLive(store, root, 0.95)

      // Write a placeholder benchmark; addBenchmark sets its own createdAt.
      const rec = await store.addBenchmark({
        candidateId: v2Id, version: 'v-temp', baseline: 'unknown', runs: 3,
        metrics: { successRate: 0.5, avgScore: 0.5, errorRate: 0.5, avgSteps: 0, avgDurationMs: 10 },
        passed: false, details: 'pre-tamper', mode: 'live', command: 'node test.js',
        provenance: '',
      })
      // Attacker tampers: change command + metrics, recompute seal with stored createdAt
      const fakeSeal = createLiveProvenance(v2Id, 'v-temp', 'echo "pwned"', rec.createdAt)
      await tamperBenchmarkFile(root, rec.id, {
        command: 'echo "pwned"',
        metrics: { successRate: 1.0, avgScore: 1.0, errorRate: 0, avgSteps: 0, avgDurationMs: 10 },
        provenance: fakeSeal,
      })

      const deps = makeDeps(store, root)
      const candidate = await store.getCandidate(v2Id)!
      const result = await evaluatePromotionPolicy(deps, candidate)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/attestation/i)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  // T4: Editing a persisted record's candidate identity and re-sealing only the
  // legacy provenance must still fail the full-record attestation.
  it('T4: candidate rebinding via recomputed provenance is rejected by attestation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm33-t4-rebind-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()
      const { v1Id, v2Id } = await makeActiveLive(store, root, 0.95)

      // Attacker copies v1's live benchmark data to v2 with recomputed seal
      await store.addBenchmark({
        candidateId: v2Id, version: 'v1', baseline: 'unknown', runs: 3,
        metrics: { successRate: 0.97, avgScore: 0.97, errorRate: 0.03, avgSteps: 0, avgDurationMs: 200 },
        passed: true, details: 'copied from v1', mode: 'live', command: 'node test.js',
        provenance: '',
      })
      // Re-seal with the stored createdAt so the seal matches the record
      const rebindingRecord = (await store.listBenchmarks(500))
        .find(b => b.candidateId === v2Id && b.details === 'copied from v1')!
      const rebindingSeal = createLiveProvenance(v2Id, 'v1', 'node test.js', rebindingRecord.createdAt)
      await tamperBenchmarkFile(root, rebindingRecord.id, { provenance: rebindingSeal })

      const deps = makeDeps(store, root)
      const candidate = await store.getCandidate(v2Id)!
      const result = await evaluatePromotionPolicy(deps, candidate)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/attestation|evidence-present/i)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  // T5: A candidate record copied/rebound after persistence must fail the
  // full-record attestation before reaching the comparative gate.
  it('T5: baseline rebinding is rejected by record attestation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm33-t5-baseline-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()
      const { v1Id, v2Id } = await makeActiveLive(store, root, 0.95)

      // Attacker reads v1's benchmark and creates a copy for v2
      await store.addBenchmark({
        candidateId: v2Id, version: 'v1', baseline: 'v1', runs: 3,
        metrics: { successRate: 0.95, avgScore: 0.95, errorRate: 0.05, avgSteps: 0, avgDurationMs: 200 },
        passed: true, details: 'piggybacked', mode: 'live', command: 'node test.js',
        provenance: '',
      })
      // Re-seal with the stored createdAt so the seal matches the record
      const piggyRecord = (await store.listBenchmarks(500))
        .find(b => b.candidateId === v2Id && b.details === 'piggybacked')!
      const piggybackSeal = createLiveProvenance(v2Id, 'v1', 'node test.js', piggyRecord.createdAt)
      await tamperBenchmarkFile(root, piggyRecord.id, { provenance: piggybackSeal })

      const deps = makeDeps(store, root)
      const candidate = await store.getCandidate(v2Id)!
      const result = await evaluatePromotionPolicy(deps, candidate)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/attestation/i)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  // T6: Copying old evidence into a new candidate and rewriting provenance
  // without a trusted store insertion must fail the record attestation.
  it('T6: replay of old live evidence after active version changes is rejected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm33-t6-replay-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()

      // Create v1 active
      const v1 = await store.addCandidate({
        parentVersion: 'v0', type: 'policy', name: 'v1', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'x=1\n' }],
        tests: [],
        benchmarkConfig: {
          successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      const ct1 = isoDateTime(new Date())
      await store.addBenchmark({
        candidateId: v1.id, version: 'v0', baseline: 'v0', runs: 3,
        metrics: { successRate: 0.90, avgScore: 0.90, errorRate: 0.10, avgSteps: 0, avgDurationMs: 200 },
        passed: true, details: 'v1 live', mode: 'live', command: 'node test.js',
        provenance: createLiveProvenance(v1.id, 'v0', 'node test.js', ct1),
      })
      await store.createVersion({ label: 'v1', reason: 'release', promotedFrom: 'v0', modules: [v1.id] })

      // Create v2 with higher rate
      const v2 = await store.addCandidate({
        parentVersion: 'v1', type: 'policy', name: 'v2', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'x=2\n' }],
        tests: [],
        benchmarkConfig: {
          successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      const ct2 = isoDateTime(new Date())
      await store.addBenchmark({
        candidateId: v2.id, version: 'v1', baseline: 'v1', runs: 3,
        metrics: { successRate: 0.97, avgScore: 0.97, errorRate: 0.03, avgSteps: 0, avgDurationMs: 200 },
        passed: true, details: 'v2 live', mode: 'live', command: 'node test.js',
        provenance: createLiveProvenance(v2.id, 'v1', 'node test.js', ct2),
      })
      await store.createVersion({ label: 'v2', reason: 'improve', promotedFrom: 'v1', modules: [v2.id] })

      // Now v2 is active. Attacker reuses v1's old sealed record for a new v3 candidate.
      const v3 = await store.addCandidate({
        parentVersion: 'v2', type: 'policy', name: 'v3', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'x=3\n' }],
        tests: [],
        benchmarkConfig: {
          successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
          errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
        },
      })
      // Replay v1's seal but with v3's candidateId.
      // Note: addBenchmark overwrites createdAt with isoDateTime(now), so we must
      // read back the stored createdAt and recompute the seal to match.
      const replayedSeal = createLiveProvenance(v3.id, 'v0', 'node test.js', ct1)
      const benchBeforeWrite = await store.addBenchmark({
        candidateId: v3.id, version: 'v0', baseline: 'v0', runs: 3,
        metrics: { successRate: 0.99, avgScore: 0.99, errorRate: 0, avgSteps: 0, avgDurationMs: 100 },
        passed: true, details: 'replayed evidence', mode: 'live', command: 'node test.js',
        provenance: replayedSeal,
      })
      // addBenchmark sets its own createdAt; re-seal with the stored value
      const storedCt = benchBeforeWrite.createdAt
      const correctReplayedSeal = createLiveProvenance(v3.id, 'v0', 'node test.js', storedCt)
      await tamperBenchmarkFile(root, benchBeforeWrite.id, { provenance: correctReplayedSeal })

      await store.updateCandidate(v3.id, { status: 'benchmarked' })

      const deps = makeDeps(store, root)
      const candidate = await store.getCandidate(v3.id)!
      const result = await evaluatePromotionPolicy(deps, candidate)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/attestation/i)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  // T7: Simulated evidence flip — blocked by tool path
  it('T7: simulated-to-live mode flip without provenance is blocked by evo_promote tool', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm33-t7-simflip-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()
      const { v2Id } = await makeActiveLive(store, root, 0.95)

      // Add simulated benchmark, then flip mode to 'live' without provenance
      const simRecord = await store.addBenchmark({
        candidateId: v2Id, version: 'v-temp', baseline: 'unknown', runs: 3,
        metrics: { successRate: 0.98, avgScore: 0.98, errorRate: 0.02, avgSteps: 0, avgDurationMs: 200 },
        passed: true, details: 'simulated', mode: 'simulated',
      })
      await tamperBenchmarkFile(root, simRecord.id, { mode: 'live' })
      // No provenance field added

      const deps = makeDeps(store, root)
      const { promoteTools } = await import('../src/host/modules/promote/tools.ts')
      const tool = promoteTools(deps).find(t => t.name === 'evo_promote')!
      const toolResult = await tool.execute({ candidateId: v2Id } as never, { signal: AbortSignal.timeout(5000) }) as { ok: boolean; error?: string; redTeamGate?: { verdict: string } }

      // Changing mode mutates the attested record; missing provenance also
      // leaves the evidence inconclusive. Either reason must block promotion.
      expect(toolResult.ok).toBe(false)
      expect(toolResult.redTeamGate?.verdict).toMatch(/FAIL|INCONCLUSIVE/)
      if (!toolResult.ok) expect(toolResult.error).toMatch(/red-team promotion gate|provenance|attestation/i)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  // T8: Successful legitimate live evidence promotes
  it('T8: legitimate live evidence with valid seal allows promotion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm33-t8-legit-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()
      const { v2Id } = await makeActiveLive(store, root, 0.95)

      // Create a legitimate record with one authoritative timestamp. Do not
      // rewrite it after persistence, because that would invalidate attestation.
      const t8Ts = isoDateTime(new Date())
      const t8Seal = createLiveProvenance(v2Id, 'v1', 'node test.js', t8Ts)
      await store.addBenchmark({
        candidateId: v2Id, version: 'v1', baseline: 'v1', runs: 3,
        metrics: { successRate: 0.98, avgScore: 0.98, errorRate: 0.02, avgSteps: 0, avgDurationMs: 200 },
        passed: true, details: 'live sandbox execution: exit 0', mode: 'live', command: 'node test.js',
        provenance: t8Seal,
      }, t8Ts)

      const deps = makeDeps(store, root)
      const candidate = await store.getCandidate(v2Id)!
      const result = await evaluatePromotionPolicy(deps, candidate)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.activeMetrics).toBeDefined()
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  // Bonus: verifyLiveProvenance rejects mismatched seals
  it('verifyLiveProvenance rejects a seal that does not match the record fields', () => {
    const record = {
      mode: 'live',
      candidateId: 'cand-abc',
      version: 'v1',
      command: 'node test.js',
      createdAt: '2026-01-01T00:00:00.000Z',
      provenance: '0000000000000000000000000000000000000000000000000000000000000000',
    }
    expect(verifyLiveProvenance(record)).toBe(false)
  })

  // Bonus: verifyLiveProvenance accepts simulated records (no seal expected)
  it('verifyLiveProvenance accepts simulated records without a seal', () => {
    const record = {
      mode: 'simulated',
      candidateId: 'cand-abc',
      version: 'v1',
      command: 'node test.js',
      createdAt: '2026-01-01T00:00:00.000Z',
      // no provenance field
    }
    expect(verifyLiveProvenance(record)).toBe(true)
  })
})
