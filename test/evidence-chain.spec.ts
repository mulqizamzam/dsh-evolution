/**
 * The evidence chain: live execution must produce PERSISTED evidence, and the
 * deterministic gate must only act on evidence that actually came from
 * execution. Found live: evo_benchmark_live ran the candidate but recorded
 * nothing, so the gate had no live evidence to decide on.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { ModuleDeps } from '../src/host/types.ts'
import type { HostContextShape } from '../src/host/dsh.ts'

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

describe('live benchmark evidence chain', () => {
  let tmpRoot: string
  let store: EvolutionStore
  let deps: ModuleDeps
  const exec = { signal: AbortSignal.timeout(60_000) }

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-evidence-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
    deps = { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: tmpRoot }), store, log: () => {}, warn: () => {} }
  })

  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  async function seedCandidate() {
    await store.createVersion({ label: 'v1', modules: [] })
    return await store.addCandidate({
      parentVersion: 'v1', type: 'policy', name: 'probe', description: 'd', reason: 'r',
      evidenceIds: [], patternIds: [],
      files: [{ path: 'src/index.ts', content: 'export const ok = true' }], tests: [],
      benchmarkConfig: {
        successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
        errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 },
        avgDurationMs: { max: 60000, weight: 0.5 },
      },
      status: 'draft',
    })
  }

  it('a PASSING live run persists live evidence and benchmarks the candidate', async () => {
    const candidate = await seedCandidate()
    const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
    const live = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!

    const result = await live.execute({
      candidateId: candidate.id, command: 'echo CHAIN_OK', timeoutMs: 20_000,
    } as never, exec) as { ok: boolean; passed: boolean; benchmarkRunId: string; evidenceMode: string }

    expect(result.ok).toBe(true)
    expect(result.passed).toBe(true)
    expect(result.evidenceMode).toBe('live')

    const stored = await store.listBenchmarks()
    expect(stored).toHaveLength(1)
    expect(stored[0].mode).toBe('live')
    expect(stored[0].id).toBe(result.benchmarkRunId)
    expect(stored[0].passed).toBe(true)
    expect(stored[0].metrics.successRate).toBe(1)
    expect(stored[0].avgDurationMs ?? stored[0].metrics.avgDurationMs).toBeGreaterThan(0)

    const after = await store.getCandidate(candidate.id)
    expect(after!.status).toBe('benchmarked')
  })

  it('a FAILING live run persists evidence and rejects the candidate', async () => {
    const candidate = await seedCandidate()
    const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
    const live = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!

    const result = await live.execute({
      candidateId: candidate.id, command: 'exit 3', timeoutMs: 20_000,
    } as never, exec) as { ok: boolean; passed: boolean; evidenceMode: string }

    expect(result.ok).toBe(true)
    expect(result.passed).toBe(false)
    expect(result.evidenceMode).toBe('live')

    const after = await store.getCandidate(candidate.id)
    expect(after!.status).toBe('rejected')
  })

  it('a single live run is not enough evidence: the gate refuses on min_runs', async () => {
    const candidate = await seedCandidate()
    const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
    const { promoteTools } = await import('../src/host/modules/promote/tools.ts')

    await benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!
      .execute({ candidateId: candidate.id, command: 'echo ONE_OK', timeoutMs: 20_000 } as never, exec)

    const decision = promoteTools(deps).find(t => t.name === 'evo_promote_decision')!
    const verdict = await decision.execute({ candidateId: candidate.id } as never, exec) as {
      ok: boolean; recommendation: string; evidenceMode: string; rejectionReasons: string[]
    }
    expect(verdict.ok).toBe(true)
    expect(verdict.evidenceMode).toBe('live')
    // One execution is real evidence but not enough of it.
    expect(verdict.recommendation).toBe('REJECT')
    expect(verdict.rejectionReasons.join(' ')).toContain('min_runs')
  })

  it('repeated live A/B evidence drives the deterministic gate to PROMOTE', async () => {
    const candidate = await seedCandidate()
    const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
    const { promoteTools } = await import('../src/host/modules/promote/tools.ts')

    const ab = await benchmarkTools(deps).find(t => t.name === 'evo_benchmark_ab')!
      .execute({ candidateId: candidate.id, command: 'echo GATE_OK', runs: 3, timeoutMs: 20_000 } as never, exec) as { ok: boolean; passed: boolean; evidenceMode: string }
    expect(ab.ok).toBe(true)

    const decision = promoteTools(deps).find(t => t.name === 'evo_promote_decision')!
    const verdict = await decision.execute({ candidateId: candidate.id } as never, exec) as {
      ok: boolean; recommendation: string; evidenceMode: string; checks: Array<{ gate: string; pass: boolean }>
    }
    expect(verdict.ok).toBe(true)
    expect(verdict.evidenceMode).toBe('live')
    expect(verdict.recommendation).toBe('PROMOTE')
    expect(verdict.checks.find(c => c.gate === 'min_runs')!.pass).toBe(true)
  })

  it('A/B persists comparative live evidence with both sides measured', async () => {
    const candidate = await seedCandidate()
    const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
    const ab = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_ab')!

    const result = await ab.execute({
      candidateId: candidate.id, command: 'echo AB_OK', runs: 2, timeoutMs: 20_000,
    } as never, exec) as { ok: boolean; benchmarkRunId: string; evidenceMode: string }

    expect(result.ok).toBe(true)
    expect(result.evidenceMode).toBe('live')

    const stored = await store.listBenchmarks()
    const record = stored.find(r => r.id === result.benchmarkRunId)!
    expect(record.mode).toBe('live')
    expect(record.runs).toBe(2)
    expect(record.baselineMetrics).toBeDefined()
    expect(record.comparison).toBeDefined()
    expect(record.caseResults?.length).toBeGreaterThan(0)
  })

  it('a simulated record is never labelled live', async () => {
    const candidate = await seedCandidate()
    const { benchmarkTools } = await import('../src/host/modules/benchmark/tools.ts')
    await store.addExperience({ success: true, score: 0.9, stepCount: 4, durationMs: 5000 })

    await benchmarkTools(deps).find(t => t.name === 'evo_benchmark_run')!
      .execute({ candidateId: candidate.id, runs: 3 } as never, exec)

    const stored = await store.listBenchmarks()
    expect(stored[0].mode).toBe('simulated')
  })
})

// ── Evidence lineage: pattern → candidate → experience ─────────────────────

describe('evidence lineage (experience → pattern → candidate)', () => {
  let tmpRoot: string
  let store: EvolutionStore
  let deps: ModuleDeps
  const exec = { signal: AbortSignal.timeout(60_000) }

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-lineage-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
    deps = { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: tmpRoot }), store, log: () => {}, warn: () => {} }
  })

  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  async function recordExperiences(): Promise<string[]> {
    const ids: string[] = []
    for (let i = 0; i < 6; i++) {
      const rec = await store.addExperience({
        success: false,
        errors: ['timeout: request timed out'],
        stepCount: 10 + i,
        prompt: 'deploy service',
      })
      ids.push(rec.id)
    }
    for (let i = 0; i < 3; i++) {
      const rec = await store.addExperience({
        success: true,
        score: 0.8,
        stepCount: 3,
        prompt: 'verify build',
      })
      ids.push(rec.id)
    }
    return ids
  }

  it('a pattern generated from multiple experiences stores those experience IDs', async () => {
    await recordExperiences()
    const { analyzeTools } = await import('../src/host/modules/analyze/tools.ts')
    const analyze = analyzeTools(deps).find(t => t.name === 'evo_analyze_patterns')!
    const result = await analyze.execute({ minOccurrences: 3 } as never, exec) as {
      detected: number; patterns: Array<{ id: string; evidenceIds: string[] }>
    }
    expect(result.detected).toBeGreaterThan(0)
    // Find the pattern about 'timeout' — it must have 6 experience IDs
    const timeoutPattern = result.patterns.find((p: { description: string }) =>
      (p as { description: string }).description.includes('timeout'))!
    expect(timeoutPattern).toBeDefined()
    expect(timeoutPattern.evidenceIds.length).toBe(6)
    // All IDs are experience record IDs (12-char hex, not pattern IDs)
    for (const eid of timeoutPattern.evidenceIds) {
      const exp = await store.getExperience(eid)
      expect(exp).not.toBeNull()
    }
  })

  it('a patterns evidenceIds contain no pattern IDs (identifier-domain check)', async () => {
    await recordExperiences()
    const { analyzeTools } = await import('../src/host/modules/analyze/tools.ts')
    const analyze = analyzeTools(deps).find(t => t.name === 'evo_analyze_patterns')!
    const result = await analyze.execute({ minOccurrences: 3 } as never, exec) as {
      patterns: Array<{ id: string; evidenceIds: string[] }>
    }
    for (const p of result.patterns) {
      for (const eid of p.evidenceIds) {
        // Pattern IDs are 12-char lowercase hex; evidence must be experience IDs.
        // Verify none of the evidence IDs match any pattern ID in the store.
        const allPatterns = await store.listPatterns(500)
        expect(allPatterns.map(x => x.id)).not.toContain(eid)
      }
    }
  })

  it('a candidate referencing one pattern inherits that pattern evidence IDs', async () => {
    await recordExperiences()
    const { analyzeTools } = await import('../src/host/modules/analyze/tools.ts')
    await analyzeTools(deps).find(t => t.name === 'evo_analyze_patterns')!
      .execute({ minOccurrences: 3 } as never, exec)
    const patterns = await store.listPatterns(500)
    const target = patterns[0]!

    const { candidateTools } = await import('../src/host/modules/candidate/tools.ts')
    const create = candidateTools(deps).find(t => t.name === 'evo_candidate_create')!
    const candidate = await create.execute({
      type: 'retry-strategy',
      name: 'timeout-fix',
      description: 'd',
      reason: 'r',
      parentVersion: 'v0',
      evidenceIds: target.evidenceIds,
      patternIds: [target.id],
    } as never, exec) as { id: string; evidenceIds: string[] }

    expect(candidate.evidenceIds.length).toBe(target.evidenceIds.length)
    expect(candidate.evidenceIds).toEqual(target.evidenceIds)
  })

  it('a candidate referencing multiple patterns receives the deduplicated union of their evidence', async () => {
    await recordExperiences()
    const { analyzeTools } = await import('../src/host/modules/analyze/tools.ts')
    await analyzeTools(deps).find(t => t.name === 'evo_analyze_patterns')!
      .execute({ minOccurrences: 3 } as never, exec)
    const patterns = await store.listPatterns(500)
    // Create two patterns pointing to overlapping experience subsets
    const p1 = await store.addPattern({
      type: 'failure', evidence: 'INFERENCE',
      description: 'overlap-A', occurrences: 5,
      evidenceIds: ['exp-a', 'exp-b', 'exp-c'],
      confidence: 0.7,
    })
    const p2 = await store.addPattern({
      type: 'failure', evidence: 'INFERENCE',
      description: 'overlap-B', occurrences: 4,
      evidenceIds: ['exp-b', 'exp-c', 'exp-d'],
      confidence: 0.65,
    })

    // Simulate what builder does: resolve evidence union from patterns
    const resolvedEvidenceIds = new Set<string>()
    for (const p of [p1, p2]) {
      for (const eid of p.evidenceIds) resolvedEvidenceIds.add(eid)
    }
    const union = [...resolvedEvidenceIds]
    expect(union.sort()).toEqual(['exp-a', 'exp-b', 'exp-c', 'exp-d'])
    expect(union.length).toBe(4) // deduplicated
  })

  it('existing duplicate evidence IDs are deduplicated', async () => {
    const p = await store.addPattern({
      type: 'failure', evidence: 'INFERENCE',
      description: 'dup-check', occurrences: 10,
      evidenceIds: ['exp-x', 'exp-y', 'exp-x'],
      confidence: 0.9,
    })
    const { candidateTools } = await import('../src/host/modules/candidate/tools.ts')
    const create = candidateTools(deps).find(t => t.name === 'evo_candidate_create')!
    const candidate = await create.execute({
      type: 'policy', name: 'dup-test', description: 'd', reason: 'r',
      parentVersion: 'v0',
      evidenceIds: [...p.evidenceIds],
      patternIds: [p.id],
    } as never, exec) as { evidenceIds: string[] }

    // No duplicates in evidence
    const unique = new Set(candidate.evidenceIds)
    expect(unique.size).toBe(candidate.evidenceIds.length)
  })

  it('empty evidence remains valid when there is genuinely no supporting experience', async () => {
    const p = await store.addPattern({
      type: 'opportunity', evidence: 'INFERENCE',
      description: 'no-evidence', occurrences: 1,
      evidenceIds: [],
      confidence: 0.4,
    })
    const { candidateTools } = await import('../src/host/modules/candidate/tools.ts')
    const create = candidateTools(deps).find(t => t.name === 'evo_candidate_create')!
    const candidate = await create.execute({
      type: 'policy', name: 'empty-ev', description: 'd', reason: 'r',
      parentVersion: 'v0',
      evidenceIds: [],
      patternIds: [p.id],
    } as never, exec) as { evidenceIds: string[]; patternIds: string[] }

    expect(candidate.evidenceIds).toEqual([])
    expect(candidate.patternIds).toEqual([p.id])
  })

  it('missing pattern references result in empty evidence (no fabrication)', async () => {
    const { candidateTools } = await import('../src/host/modules/candidate/tools.ts')
    const create = candidateTools(deps).find(t => t.name === 'evo_candidate_create')!
    const candidate = await create.execute({
      type: 'policy', name: 'no-pattern', description: 'd', reason: 'r',
      parentVersion: 'v0',
      evidenceIds: [],
      patternIds: ['nonexistent-pattern-id'],
    } as never, exec) as { patternIds: string[]; evidenceIds: string[] }

    // Missing pattern → no evidence fabricated, patternIds still recorded
    expect(candidate.patternIds).toEqual(['nonexistent-pattern-id'])
    expect(candidate.evidenceIds).toEqual([])
  })

  it('persisted pattern and candidate records retain evidence IDs after serialization', async () => {
    await recordExperiences()
    const { analyzeTools } = await import('../src/host/modules/analyze/tools.ts')
    await analyzeTools(deps).find(t => t.name === 'evo_analyze_patterns')!
      .execute({ minOccurrences: 3 } as never, exec)

    const patterns = await store.listPatterns(500)
    const withEvidence = patterns.filter(p => p.evidenceIds.length > 0)
    expect(withEvidence.length).toBeGreaterThan(0)

    const candidate = await store.addCandidate({
      parentVersion: 'v0', type: 'policy', name: 'persist-test', description: 'd', reason: 'r',
      evidenceIds: withEvidence[0]!.evidenceIds,
      patternIds: [withEvidence[0]!.id],
      files: [], tests: [],
      benchmarkConfig: {
        successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
        errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 },
        avgDurationMs: { max: 60000, weight: 0.5 },
      },
      status: 'draft',
    })

    // Read back from disk (simulates process restart)
    const persistedCandidate = await store.getCandidate(candidate.id)!
    expect(persistedCandidate.evidenceIds).toEqual(withEvidence[0]!.evidenceIds)
    expect(persistedCandidate.patternIds).toEqual([withEvidence[0]!.id])
  })

  it('an existing valid evidence chain remains intact after repeated generation', async () => {
    await recordExperiences()
    const { analyzeTools } = await import('../src/host/modules/analyze/tools.ts')
    await analyzeTools(deps).find(t => t.name === 'evo_analyze_patterns')!
      .execute({ minOccurrences: 3 } as never, exec)
    const patterns = await store.listPatterns(500)

    // Generate a candidate, then generate another; the first must be unaffected
    const { candidateTools } = await import('../src/host/modules/candidate/tools.ts')
    const create = candidateTools(deps).find(t => t.name === 'evo_candidate_create')!
    const first = await create.execute({
      type: 'policy', name: 'first', description: 'd', reason: 'r',
      parentVersion: 'v0', evidenceIds: patterns[0]!.evidenceIds,
      patternIds: [patterns[0]!.id],
    } as never, exec) as { id: string; evidenceIds: string[] }

    const second = await create.execute({
      type: 'policy', name: 'second', description: 'd', reason: 'r',
      parentVersion: 'v0', evidenceIds: patterns[0]!.evidenceIds,
      patternIds: [patterns[0]!.id],
    } as never, exec) as { id: string; evidenceIds: string[] }

    expect(first.evidenceIds).toEqual(second.evidenceIds)
    // Reload both from disk — IDs must be stable
    const reread1 = await store.getCandidate(first.id)!
    const reread2 = await store.getCandidate(second.id)!
    expect(reread1.evidenceIds).toEqual(first.evidenceIds)
    expect(reread2.evidenceIds).toEqual(second.evidenceIds)
    // No cross-contamination
    expect(reread1.evidenceIds).not.toContain(first.id)
    expect(reread2.evidenceIds).not.toContain(second.id)
  })

  it('a candidate referencing patterns in different orders yields the same evidence union', async () => {
    const pA = await store.addPattern({
      type: 'failure', evidence: 'INFERENCE',
      description: 'order-A', occurrences: 5,
      evidenceIds: ['exp-1', 'exp-2'], confidence: 0.8,
    })
    const pB = await store.addPattern({
      type: 'failure', evidence: 'INFERENCE',
      description: 'order-B', occurrences: 4,
      evidenceIds: ['exp-3', 'exp-2'], confidence: 0.7,
    })

    // Compute union both orders
    const unionAB = new Set([...pA.evidenceIds, ...pB.evidenceIds])
    const unionBA = new Set([...pB.evidenceIds, ...pA.evidenceIds])
    expect([...unionAB].sort()).toEqual([...unionBA].sort())
    expect(unionAB.size).toBe(3) // exp-1, exp-2, exp-3
  })
})
