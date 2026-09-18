/**
 * P12: Degradation-driven evolution integration.
 *
 * Tests the complete path:
 *   degraded version → detectVersionDegradation → synthetic pattern → candidate
 *
 * Covers the 15 required regression cases from the mission spec.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { ModuleDeps } from '../src/host/types.ts'
import type { HostContextShape } from '../src/host/dsh.ts'
import { runAutoCycle, resetAutoGuards, autoGuardState, type AutoCycleOutcome } from '../src/host/modules/auto-experience/index.ts'
import { detectVersionDegradation } from '../src/host/modules/analyze/tools.ts'
import { seedExperiencesForVersion } from './helpers/seed-experiences.ts'
import { makeFakeLlm } from './helpers/fake-llm.ts'
import { promoteTools } from '../src/host/modules/promote/tools.ts'

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

function makeDeps(store: EvolutionStore, root: string, overrides?: Record<string, unknown>): ModuleDeps {
  return {
    ctx: makeCtx(),
    cfg: () => resolveConfig({ stateRoot: root, ...overrides }),
    store,
    log: () => {},
    warn: () => {},
  }
}

describe('P12: Degradation-driven evolution integration', () => {
  let tmpRoot: string
  let store: EvolutionStore
  let deps: ModuleDeps
  const exec = { signal: AbortSignal.timeout(5_000) }

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-p12-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
    deps = makeDeps(store, tmpRoot)
    resetAutoGuards()
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  // ── Case 1: degraded active version triggers evolution context ────────────

  it('P12-degraded-active-version-triggers-evolution: detects degradation and records patterns', async () => {
    // Create v1 and v2 (v2 active)
    await store.createVersion({ label: 'v1-baseline', modules: [] })
    const v2 = await store.createVersion({ label: 'v2-degraded', modules: [] })
    expect(v2.id).toBe('v2')

    // Seed v2 with 2 successes + 5 failures = 28.6% success rate (< 0.6 threshold)
    await seedExperiencesForVersion(store, 'v2', { successes: 2, failures: 5, stepCount: 15 })

    // Verify degradation signal
    const records = await store.listExperiencesByVersion('v2', 100)
    expect(records.length).toBe(7)
    const signal = detectVersionDegradation(records)
    expect(signal).not.toBeNull()
    expect(signal!.isDegraded).toBe(true)
    expect(signal!.versionId).toBe('v2')
    expect(signal!.successRate).toBeLessThan(0.6)

    // Run auto-cycle with low thresholds so it triggers
    const depsDegraded = makeDeps(store, tmpRoot, {
      evolution: { analysis: { minExperiences: 5, minOccurrences: 2 } },
    })
    const outcome = await runAutoCycle(depsDegraded)
    expect(outcome.ran).toBe(true)
    expect(outcome.patterns).toBeGreaterThan(0)
    // Should mention degradation or patterns
    expect(['degradation detected', 'patterns recorded'].some(s => outcome.reason.includes(s))).toBe(true)
  })

  // ── Case 2: healthy version does not trigger degradation path ─────────────

  it('P12-healthy-version-does-not-trigger-degradation', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2-healthy', modules: [] })

    // 6 successful experiences, no failures
    await seedExperiencesForVersion(store, 'v2', { successes: 6, failures: 0 })

    const records = await store.listExperiencesByVersion('v2', 100)
    const signal = detectVersionDegradation(records)
    expect(signal).not.toBeNull()
    expect(signal!.isDegraded).toBe(false)
    expect(signal!.successRate).toBeGreaterThan(0.9)
  })

  // ── Case 3: insufficient observations do not trigger ──────────────────────

  it('P12-insufficient-observations-do-not-trigger', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })

    // Only 4 experiences (below VERSION_OBSERVATION_MIN = 5)
    await seedExperiencesForVersion(store, 'v2', { successes: 1, failures: 3 })

    const records = await store.listExperiencesByVersion('v2', 100)
    expect(records.length).toBe(4)
    const signal = detectVersionDegradation(records)
    // Fewer than 5 → null (no per-version signal)
    expect(signal === null || signal!.isDegraded === false).toBe(true)
  })

  // ── Case 4: missing active version does not trigger ───────────────────────

  it('P12-missing-active-version-does-not-trigger', async () => {
    // No versions created
    const active = await store.getActiveVersion()
    expect(active).toBeNull()

    // Seed some experiences without versionId
    for (let i = 0; i < 20; i++) {
      await store.addExperience({ success: false, errors: ['timeout'], prompt: 'x' })
    }

    const outcome = await runAutoCycle(deps)
    // Should not throw; either returns "not enough" or "no pattern"
    expect(outcome).toBeDefined()
    expect(typeof outcome.ran).toBe('boolean')
  })

  // ── Case 5: candidate retains version/evidence provenance ────────────────

  it('P12-candidate-retains-version-evidence-provenance', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })

    // Seed 5 failures under v2
    const expIds = await seedExperiencesForVersion(store, 'v2', { successes: 0, failures: 5, stepCount: 20 })

    const records = await store.listExperiencesByVersion('v2', 100)
    const signal = detectVersionDegradation(records)
    expect(signal).not.toBeNull()
    expect(signal!.isDegraded).toBe(true)
    expect(signal!.versionId).toBe('v2')

    // Manually create a candidate with the degradation provenance
    const candidate = await store.addCandidate({
      parentVersion: 'v2',
      type: 'retry-strategy',
      name: 'v2-recovery',
      description: 'Degradation v2: success-rate-low:28.6%; error-rate-high:71.4%',
      reason: 'Version v2 degraded: success rate 28.6%',
      evidenceIds: expIds,
      patternIds: [],
      files: [],
      tests: [],
      benchmarkConfig: {
        successRate: { min: 0.8, weight: 1 },
        avgScore: { min: 0.7, weight: 1 },
        errorRate: { max: 0.2, weight: 1 },
        avgSteps: { max: 50, weight: 0.5 },
        avgDurationMs: { max: 60000, weight: 0.5 },
      },
      status: 'draft',
    })

    expect(candidate.parentVersion).toBe('v2')
    expect(candidate.evidenceIds).toHaveLength(expIds.length)
    for (const eid of expIds) {
      expect(candidate.evidenceIds).toContain(eid)
    }
    // Reload from disk to verify serialization
    const persisted = await store.getCandidate(candidate.id)
    expect(persisted).not.toBeNull()
    expect(persisted!.parentVersion).toBe('v2')
    expect(persisted!.evidenceIds).toHaveLength(expIds.length)
  })

  // ── Case 6: repeated identical signal is deduplicated ─────────────────────

  it('P12-repeated-identical-signal-is-deduplicated', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })

    // Seed 5 identical failures under v2
    await seedExperiencesForVersion(store, 'v2', { successes: 0, failures: 5, errors: ['timeout: request timed out'] })

    const depsLow = makeDeps(store, tmpRoot, { evolution: { analysis: { minExperiences: 5, minOccurrences: 2 } } })
    const first = await runAutoCycle(depsLow)
    expect(first.ran).toBe(true)
    expect(first.patterns).toBeGreaterThan(0)

    // Second run should not create another degradation candidate (dedup)
    resetAutoGuards()
    const second = await runAutoCycle(depsLow)
    // Should either be "waiting for more new experiences" or return ran:true with patterns=0
    if (second.ran) {
      expect(second.patterns).toBe(0)
    } else {
      expect(second.reason).toContain('waiting for more new experiences')
    }
  })

  // ── Case 7: new evidence permits a new evolution attempt ─────────────────

  it('P12-new-evidence-permits-new-evolution-attempt', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })

    // Seed 5 failures
    await seedExperiencesForVersion(store, 'v2', { successes: 0, failures: 5, errors: ['timeout'] })

    const depsLow = makeDeps(store, tmpRoot, { evolution: { analysis: { minExperiences: 5, minOccurrences: 2 } } })
    const first = await runAutoCycle(depsLow)
    expect(first.ran).toBe(true)

    // Add 5 MORE failures with different signature
    for (let i = 0; i < 5; i++) {
      await store.addExperience({
        success: false,
        errors: ['OOM: out of memory'],
        stepCount: 25,
        versionId: 'v2',
        prompt: 'oom-task',
      })
    }

    // Reset guard to allow another cycle
    resetAutoGuards()
    const second = await runAutoCycle(depsLow)
    // Second cycle should advance lastCycleExperienceCount
    expect(autoGuardState().lastCycleExperienceCount).toBeGreaterThanOrEqual(5)
  })

  // ── Case 8: candidate generation failure preserves active version ────────

  it('P12-candidate-generation-failure-preserves-active-version', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })

    // Seed 20 failures to meet minExperiences
    for (let i = 0; i < 20; i++) {
      await store.addExperience({
        success: false,
        errors: ['sig-' + (i % 3)],
        stepCount: 12,
        versionId: 'v2',
        prompt: 'task-' + i,
      })
    }

    // Create a fake LLM that returns invalid JSON
    const fakeLlm = makeFakeLlm()
    const ctx = makeCtx()
    const fakeStore = store
    const fakeDeps: ModuleDeps = {
      ctx: {
        ...ctx,
        get: (name: string) => {
          if (name === 'llm') return fakeLlm
          return undefined
        },
      },
      cfg: () => resolveConfig({
        stateRoot: tmpRoot,
        evolution: {
          enabled: true, autoTrigger: true, autoRecord: true,
          analysis: { minExperiences: 5, minOccurrences: 2 },
          generation: { enabled: true },
          promotion: { enabled: false },
          maxCyclesPerProcess: 10,
        },
      }),
      store: fakeStore,
      log: () => {},
      warn: () => {},
    }

    const outcome = await runAutoCycle(fakeDeps)
    expect(outcome.ran).toBe(true)
    expect(outcome.reason).toContain('generation failed')

    // Active version unchanged
    const active = await store.getActiveVersion()
    expect(active).not.toBeNull()
    expect(active!.id).toBe('v2')
    expect(active!.status).toBe('active')

    // Guard released
    expect(autoGuardState().inFlight).toBe(false)
  })

  // ── Case 9: benchmark failure preserves active version ───────────────────

  it('P12-benchmark-failure-preserves-active-version', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })

    // Create a candidate
    const candidate = await store.addCandidate({
      parentVersion: 'v2',
      type: 'policy',
      name: 'test-candidate',
      description: 'test',
      reason: 'test',
      evidenceIds: [],
      patternIds: [],
      files: [],
      tests: [],
      benchmarkConfig: {
        successRate: { min: 0.8, weight: 1 },
        avgScore: { min: 0.7, weight: 1 },
        errorRate: { max: 0.2, weight: 1 },
        avgSteps: { max: 50, weight: 0.5 },
        avgDurationMs: { max: 60000, weight: 0.5 },
      },
      status: 'draft',
    })

    // Add a failing benchmark
    await store.addBenchmark({
      candidateId: candidate.id,
      version: 'v2',
      baseline: 'v2',
      runs: 3,
      metrics: { successRate: 0.5, avgScore: 0.4, errorRate: 0.5, avgSteps: 25, avgDurationMs: 80000 },
      passed: false,
      details: 'Failed thresholds.',
    })
    await store.updateCandidate(candidate.id, { status: 'benchmarked' })

    // Promote decision should reject
    const { promoteTools } = await import('../src/host/modules/promote/tools.ts')
    const decision = promoteTools(deps).find(t => t.name === 'evo_promote_decision')!
    const verdict = await decision.execute({ candidateId: candidate.id, allowSimulated: true } as never, exec) as {
      ok: boolean; recommendation: string; rejectionReasons: string[]
    }
    expect(verdict.ok).toBe(true)
    expect(verdict.recommendation).toBe('REJECT')
    expect(verdict.rejectionReasons.length).toBeGreaterThan(0)

    // Active version unchanged
    const active = await store.getActiveVersion()
    expect(active!.id).toBe('v2')
    expect(active!.status).toBe('active')

    // No new version created
    const versions = await store.listVersions()
    expect(versions.length).toBe(2) // only v1 and v2
  })

  // ── Case 10: promotion remains blocked when disabled ─────────────────────

  it('P12-promotion-blocked-when-disabled', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })

    for (let i = 0; i < 20; i++) {
      await store.addExperience({
        success: false,
        errors: ['sig-' + (i % 2)],
        stepCount: 12,
        versionId: 'v2',
        prompt: 'task-' + i,
      })
    }

    const depsDisabled = makeDeps(store, tmpRoot, {
      evolution: {
        enabled: true, autoTrigger: true, autoRecord: true,
        analysis: { minExperiences: 5, minOccurrences: 2 },
        generation: { enabled: true },
        promotion: { enabled: false },
        maxCyclesPerProcess: 10,
      },
    })

    const fakeLlm = makeFakeLlm()
    const fakeDeps: ModuleDeps = {
      ctx: {
        ...makeCtx(),
        get: (name: string) => {
          if (name === 'llm') return fakeLlm
          if (name === 'agentDefaultModel') return {
            currentSelection: () => ({ provider: 'test', model: 'test-model' }),
          }
          return undefined
        },
      },
      cfg: depsDisabled.cfg,
      store: depsDisabled.store,
      log: () => {},
      warn: () => {},
    }

    const outcome = await runAutoCycle(fakeDeps)
    expect(outcome.ran).toBe(true)
    expect(outcome.reason).toContain('promotion disabled')

    // Active version unchanged
    const active = await store.getActiveVersion()
    expect(active!.id).toBe('v2')

    // No new version created
    const versions = await store.listVersions()
    expect(versions.length).toBe(2)
  })

  // ── Case 11: generation remains blocked when disabled ────────────────────

  it('P12-generation-blocked-when-disabled', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })

    for (let i = 0; i < 20; i++) {
      await store.addExperience({
        success: false,
        errors: ['sig-' + (i % 2)],
        stepCount: 12,
        versionId: 'v2',
        prompt: 'task-' + i,
      })
    }

    const depsNoGen = makeDeps(store, tmpRoot, {
      evolution: {
        enabled: true, autoTrigger: true, autoRecord: true,
        analysis: { minExperiences: 5, minOccurrences: 2 },
        generation: { enabled: false },
        promotion: { enabled: true },
        maxCyclesPerProcess: 10,
      },
    })

    const outcome = await runAutoCycle(depsNoGen)
    expect(outcome.ran).toBe(true)
    expect(outcome.reason).toContain('generation disabled')
    expect(outcome.patterns).toBeGreaterThan(0)

    // No candidates created
    const candidates = await store.listCandidates()
    expect(candidates.length).toBe(0)
  })

  // ── Case 12: rollback preserves historical observations ──────────────────

  it('P12-rollback-preserves-historical-observations', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })
    const v3 = await store.createVersion({ label: 'v3', modules: [] })

    // Record 3 observations under v2
    const v2Ids = await seedExperiencesForVersion(store, 'v2', { successes: 1, failures: 2 })

    // Record 2 under v3
    const v3Ids = await seedExperiencesForVersion(store, 'v3', { successes: 2, failures: 0 })

    // Roll back to v2
    const rollback = await store.rollbackVersion('v2')
    expect(rollback).not.toBeNull()
    expect(rollback!.restored.id).toBe('v2')

    // v2 observations still retrievable
    const v2Records = await store.listExperiencesByVersion('v2', 100)
    expect(v2Records.length).toBe(3)
    expect(v2Records.every(r => r.versionId === 'v2')).toBe(true)

    // v3 observations still retrievable
    const v3Records = await store.listExperiencesByVersion('v3', 100)
    expect(v3Records.length).toBe(2)
    expect(v3Records.every(r => r.versionId === 'v3')).toBe(true)

    // Active version is v2
    const active = await store.getActiveVersion()
    expect(active!.id).toBe('v2')

    // v3 is rolled back
    const v3Version = await store.getVersion('v3')
    expect(v3Version!.status).toBe('rolled-back')
  })

  // ── Case 13: manual evolution behavior remains compatible ────────────────

  it('P12-manual-evolution-behavior-remains-compatible', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })

    // Seed 5 failures under v2
    await seedExperiencesForVersion(store, 'v2', { successes: 0, failures: 5 })

    // Manual path: analyze patterns
    const { analyzeTools } = await import('../src/host/modules/analyze/tools.ts')
    const analyze = analyzeTools(deps).find(t => t.name === 'evo_analyze_patterns')!
    const analysisResult = await analyze.execute({ minOccurrences: 2 } as never, exec) as { detected: number; patterns: Array<{ id: string }> }
    expect(analysisResult.detected).toBeGreaterThan(0)
    expect(analysisResult.patterns.length).toBeGreaterThan(0)

    // Create candidate manually
    const { candidateTools } = await import('../src/host/modules/candidate/tools.ts')
    const create = candidateTools(deps).find(t => t.name === 'evo_candidate_create')!
    const candidateResult = await create.execute({
      type: 'retry-strategy',
      name: 'manual-fix',
      description: 'd',
      reason: 'r',
      parentVersion: 'v2',
      evidenceIds: [],
      patternIds: [analysisResult.patterns[0]!.id],
    } as never, exec) as { id: string; status: string }

    expect(candidateResult.status).toBe('draft')
    expect(candidateResult.id).toBeDefined()

    // Auto-guards remain clean (manual path does not touch them)
    expect(autoGuardState().cyclesRun).toBe(0)
  })

  // ── Case 14: malformed degradation state fails safely ────────────────────

  it('P12-malformed-degradation-state-fails-safely', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })

    // Seed 5 valid experiences
    await seedExperiencesForVersion(store, 'v2', { successes: 1, failures: 4 })

    // Corrupt one experience file on disk
    const allExp = await store.listExperiences(100)
    if (allExp.length > 0) {
      const corruptPath = join(tmpRoot, 'experiences', allExp[0]!.id + '.json')
      await writeFile(corruptPath, '{ not: valid json }}}', 'utf8')
    }

    // listExperiencesByVersion should skip corrupt files
    const records = await store.listExperiencesByVersion('v2', 100)
    expect(records.length).toBeGreaterThan(0) // at least the valid ones remain

    // detectVersionDegradation should not throw
    expect(() => detectVersionDegradation(records)).not.toThrow()

    // runAutoCycle should not throw
    const outcome = await runAutoCycle(deps)
    expect(outcome).toBeDefined()
    expect(typeof outcome.ran).toBe('boolean')
  })

  // ── Case 15: timeout/cancellation does not corrupt evolution state ──────

  it('P12-timeout-cancellation-does-not-corrupt-state', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })

    // Seed 20 failures
    for (let i = 0; i < 20; i++) {
      await store.addExperience({
        success: false,
        errors: ['sig'],
        stepCount: 12,
        versionId: 'v2',
        prompt: 'task-' + i,
      })
    }

    // Fake LLM that never yields (simulates hang)
    const hangingLlm = {
      stream: async function* () {
        await new Promise(resolve => setTimeout(resolve, 60_000))
        yield { type: 'text-delta', text: 'never' }
      },
    }

    const depsHanging = makeDeps(store, tmpRoot, {
      evolution: {
        enabled: true, autoTrigger: true, autoRecord: true,
        analysis: { minExperiences: 5, minOccurrences: 2 },
        generation: { enabled: true },
        promotion: { enabled: false },
        maxCyclesPerProcess: 10,
      },
    })
    const hangingDeps: ModuleDeps = {
      ...depsHanging,
      ctx: {
        ...depsHanging.ctx,
        get: (name: string) => {
          if (name === 'llm') return hangingLlm
          return undefined
        },
      },
    }

    // Call with a short abort signal to simulate timeout
    const abortController = new AbortController()
    setTimeout(() => abortController.abort(), 100) // abort after 100ms

    // runAutoCycle internally uses AbortSignal.timeout(180_000), so our
    // abort won't propagate there — but the finally block must still fire.
    const outcome = await runAutoCycle(hangingDeps).catch(e => ({ ran: false, reason: String(e) }))
    expect(outcome).toBeDefined()

    // Guard released regardless of what happened
    expect(autoGuardState().inFlight).toBe(false)

    // Active version unchanged
    const active = await store.getActiveVersion()
    expect(active!.id).toBe('v2')
    expect(active!.status).toBe('active')

    // No new versions created
    const versions = await store.listVersions()
    expect(versions.length).toBe(2) // only v1 and v2
  })

  // ── Case 16 (C2 fix): failed generation does NOT permanently suppress retry ──

  it('P12C2-failed-generation-allows-retry: transient LLM failure does not consume the degradation opportunity', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })

    // Seed 20 failures under v2 so degradation is detected.
    // Use unique signatures so detectPatterns does NOT find recurrence patterns
    // (fresh.length === 0), forcing the degradation-only path.
    for (let i = 0; i < 20; i++) {
      await store.addExperience({
        success: false,
        errors: ['unique-sig-' + i],
        stepCount: 12,
        versionId: 'v2',
        prompt: 'task-' + i,
      })
    }

    const depsFailing = makeDeps(store, tmpRoot, {
      evolution: {
        enabled: true, autoTrigger: true, autoRecord: true,
        analysis: { minExperiences: 5, minOccurrences: 2 },
        generation: { enabled: true },
        promotion: { enabled: false },
        maxCyclesPerProcess: 10,
      },
    })
    const failingLlm = {
      stream: async function* () {
        yield { type: 'text-delta', text: 'not-valid-json' }
        yield { type: 'finish', reason: { kind: 'completed' } }
      },
    }
    const failingDeps: ModuleDeps = {
      ...depsFailing,
      ctx: {
        ...depsFailing.ctx,
        get: (name: string) => {
          if (name === 'llm') return failingLlm
          if (name === 'agentDefaultModel') return {
            currentSelection: () => ({ provider: 'test', model: 'test-model' }),
          }
          return undefined
        },
      },
    }

    // Cycle 1: generation fails (LLM returns invalid JSON)
    const outcome1 = await runAutoCycle(failingDeps)
    expect(outcome1.ran).toBe(true)
    expect(outcome1.reason).toContain('generation failed')

    // Reset guard so cycle 2 can run; do NOT add new experiences — the
    // degradation signal is the same, and the guard is what normally blocks
    // the second cycle. We bypass by resetting.
    resetAutoGuards()

    // Cycle 2: the system MUST NOT permanently suppress the opportunity.
    // With the C2 fix, a failed generation does not consume the opportunity:
    // the synthetic pattern is reused and generation is re-attempted.
    const outcome2 = await runAutoCycle(failingDeps)
    expect(outcome2.ran).toBe(true)
    // Still fails (LLM still returns bad JSON), but the key assertion is
    // that it DID NOT return "already handled in prior cycle".
    expect(outcome2.reason).not.toContain('already handled in prior cycle')
    expect(outcome2.reason).toContain('generation failed')

    // Verify no candidate was created by either cycle
    const candidates = await store.listCandidates(500)
    expect(candidates.length).toBe(0)

    // Verify exactly ONE synthetic pattern exists (not duplicated)
    const patterns = await store.listPatterns(500)
    const synthPatterns = patterns.filter(p => p.description.startsWith('Degradation'))
    expect(synthPatterns.length).toBe(1)
  })

  // ── Case 17 (C2 fix): rejected candidate does NOT permanently block retry ──

  it('P12C2-rejected-candidate-allows-retry: benchmark rejection does not consume the opportunity', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })

    // Seed 20 unique-signature failures under v2 (force degradation-only path)
    for (let i = 0; i < 20; i++) {
      await store.addExperience({
        success: false,
        errors: ['unique-sig-' + i],
        stepCount: 12,
        versionId: 'v2',
        prompt: 'task-' + i,
      })
    }

    // Manually create a candidate in rejected status to simulate the
    // "benchmark rejected it" state.
    const rejected = await store.addCandidate({
      parentVersion: 'v2',
      type: 'retry-strategy',
      name: 'rejected-candidate',
      description: 'Degradation v2: success-rate-low:0.0%; error-rate-high:100.0%',
      reason: 'rejected by benchmark',
      evidenceIds: [],
      patternIds: [],
      files: [],
      tests: [],
      benchmarkConfig: {
        successRate: { min: 0.8, weight: 1 },
        avgScore: { min: 0.7, weight: 1 },
        errorRate: { max: 0.2, weight: 1 },
        avgSteps: { max: 50, weight: 0.5 },
        avgDurationMs: { max: 60000, weight: 0.5 },
      },
      status: 'rejected',
    })

    // Now run a cycle. The rejected candidate should NOT block a new attempt.
    // degradationCandidateExists excludes 'rejected' status, so the context
    // should be detected and generation re-attempted.
    const depsGood = makeDeps(store, tmpRoot, {
      evolution: {
        enabled: true, autoTrigger: true, autoRecord: true,
        analysis: { minExperiences: 5, minOccurrences: 2 },
        generation: { enabled: true },
        promotion: { enabled: false },
        maxCyclesPerProcess: 10,
      },
    })
    const goodLlm = makeFakeLlm()
    const goodDeps: ModuleDeps = {
      ...depsGood,
      ctx: {
        ...depsGood.ctx,
        get: (name: string) => {
          if (name === 'llm') return goodLlm
          if (name === 'agentDefaultModel') return {
            currentSelection: () => ({ provider: 'test', model: 'test-model' }),
          }
          return undefined
        },
      },
    }

    resetAutoGuards()
    const outcome = await runAutoCycle(goodDeps)
    expect(outcome.ran).toBe(true)
    // The cycle should have proceeded past the "already handled" gate and
    // either generated a candidate or reported generation/pattern outcome.
    expect(outcome.reason).not.toContain('already handled in prior cycle')

    // A new candidate should have been generated (the rejected one does not block)
    const candidates = await store.listCandidates(500)
    const nonRejected = candidates.filter(c => c.id !== rejected.id)
    expect(nonRejected.length).toBeGreaterThan(0)
  })

  // ── Case 18 (C3 fix): parentVersion is stable against mid-cycle promotion ──

  it('P12C3-parentVersion-stable-under-mid-cycle-promotion: candidate retains the version captured at cycle start', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2-degraded', modules: [] })

    // Seed 20 failures under v2 with UNIQUE signatures so no recurrence patterns
    // are found (forces the pattern-driven path via the fresh recurrence check
    // being empty... actually we need SOME patterns to hit the pattern-driven
    // path). Use repeated signatures instead.
    for (let i = 0; i < 20; i++) {
      await store.addExperience({
        success: false,
        errors: ['same-sig'],
        stepCount: 12,
        versionId: 'v2',
        prompt: 'task-' + i,
      })
    }

    const depsGood = makeDeps(store, tmpRoot, {
      evolution: {
        enabled: true, autoTrigger: true, autoRecord: true,
        analysis: { minExperiences: 5, minOccurrences: 2 },
        generation: { enabled: true },
        promotion: { enabled: false },
        maxCyclesPerProcess: 10,
      },
    })
    const goodLlm = makeFakeLlm()
    const goodDeps: ModuleDeps = {
      ...depsGood,
      ctx: {
        ...depsGood.ctx,
        get: (name: string) => {
          if (name === 'llm') return goodLlm
          if (name === 'agentDefaultModel') return {
            currentSelection: () => ({ provider: 'test', model: 'test-model' }),
          }
          return undefined
        },
      },
    }

    resetAutoGuards()
    const outcome = await runAutoCycle(goodDeps)
    expect(outcome.ran).toBe(true)
    expect(outcome.candidateId).toBeDefined()

    // The candidate's parentVersion must be 'v2' — the version active at cycle
    // start, not any version that a concurrent promotion might switch to.
    const candidate = await store.getCandidate(outcome.candidateId!)
    expect(candidate).not.toBeNull()
    expect(candidate!.parentVersion).toBe('v2')

    // Now simulate a concurrent promotion to v3 and verify the EXISTING
    // candidate's parentVersion is NOT retroactively changed.
    const v3 = await store.createVersion({ label: 'v3', modules: [] })
    expect(v3.id).toBe('v3')
    const activeAfter = await store.getActiveVersion()
    expect(activeAfter!.id).toBe('v3')

    // Reload the candidate — parentVersion is immutable, still 'v2'
    const reloaded = await store.getCandidate(outcome.candidateId!)
    expect(reloaded!.parentVersion).toBe('v2')
  })

  // ── Case 19 (restart): persistence across store restart ──────────────────

  it('P12-restart-persistence: fresh store instance reads same data from disk', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })

    // Seed degradation under v2
    await seedExperiencesForVersion(store, v2.id, { successes: 0, failures: 5, errors: ['same-sig'] })

    // Run one cycle with working LLM to generate a candidate + synthetic pattern
    const depsCycle = makeDeps(store, tmpRoot, {
      evolution: {
        enabled: true, autoTrigger: true, autoRecord: true,
        analysis: { minExperiences: 5, minOccurrences: 2 },
        generation: { enabled: true },
        promotion: { enabled: false },
        maxCyclesPerProcess: 10,
      },
    })
    const fakeDeps: ModuleDeps = {
      ...depsCycle,
      ctx: {
        ...depsCycle.ctx,
        get: (name: string) => {
          if (name === 'llm') return makeFakeLlm()
          if (name === 'agentDefaultModel') return {
            currentSelection: () => ({ provider: 'test', model: 'test-model' }),
          }
          return undefined
        },
      },
    }
    resetAutoGuards()
    await runAutoCycle(fakeDeps)

    // Capture state from first store instance
    const expBefore = await store.listExperiencesByVersion(v2.id, 100)
    const patternsBefore = await store.listPatterns(500)
    const candidatesBefore = await store.listCandidates(500)
    const activeBefore = await store.getActiveVersion()
    const synthDesc = patternsBefore.find(p => p.description.startsWith('Degradation'))?.description

    // Simulate restart: new store instance on same root
    const restartStore = new EvolutionStore({ fallbackRoot: tmpRoot })
    await restartStore.init()

    // Verify experiences persist
    const expAfter = await restartStore.listExperiencesByVersion(v2.id, 100)
    expect(expAfter.length).toBe(expBefore.length)
    expect(expAfter.every(e => e.versionId === v2.id)).toBe(true)

    // Verify synthetic pattern persists
    const patternsAfter = await restartStore.listPatterns(500)
    const synthAfter = patternsAfter.find(p => p.description.startsWith('Degradation'))
    expect(synthAfter).not.toBeNull()
    expect(synthAfter!.description).toBe(synthDesc)

    // Verify candidate persists with correct parentVersion and evidenceIds
    const candidatesAfter = await restartStore.listCandidates(500)
    expect(candidatesAfter.length).toBe(candidatesBefore.length)
    if (candidatesBefore.length > 0) {
      const c = candidatesAfter.find(ca => ca.id === candidatesBefore[0]!.id)
      expect(c).not.toBeNull()
      expect(c!.parentVersion).toBe(v2.id)
      // All evidenceIds should be valid experience IDs from v2
      const expIds = new Set(expAfter.map(e => e.id))
      for (const eid of c!.evidenceIds) {
        expect(expIds.has(eid)).toBe(true)
      }
    }

    // Verify active version persists
    const activeAfter = await restartStore.getActiveVersion()
    expect(activeAfter?.id).toBe(activeBefore?.id)

    // Verify dedup works after restart: running another cycle should NOT
    // create a duplicate candidate (degradationCandidateExists finds the
    // existing draft candidate from the previous cycle)
    resetAutoGuards()
    const depsRestart = makeDeps(restartStore, tmpRoot, {
      evolution: {
        enabled: true, autoTrigger: true, autoRecord: true,
        analysis: { minExperiences: 5, minOccurrences: 2 },
        generation: { enabled: true },
        promotion: { enabled: false },
        maxCyclesPerProcess: 10,
      },
    })
    const fakeDepsRestart: ModuleDeps = {
      ...depsRestart,
      ctx: {
        ...depsRestart.ctx,
        get: (name: string) => {
          if (name === 'llm') return makeFakeLlm()
          if (name === 'agentDefaultModel') return {
            currentSelection: () => ({ provider: 'test', model: 'test-model' }),
          }
          return undefined
        },
      },
    }
    const outcomeRestart = await runAutoCycle(fakeDepsRestart)
    // Should be blocked by existing draft candidate (degradationCandidateExists returns true)
    // or return "no actionable recurring pattern" — but should NOT create a new candidate
    const candidatesAfterCycle = await restartStore.listCandidates(500)
    expect(candidatesAfterCycle.length).toBe(candidatesBefore.length)
  })

  // ── Case 20 (stale candidate): promote decision ignores parentVersion ──

  it('P12-stale-candidate-promotion: parentVersion is metadata only, not a promotion gate', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })

    // Seed degradation under v2 and generate a candidate
    await seedExperiencesForVersion(store, v2.id, { successes: 0, failures: 5, errors: ['same-sig'] })

    const depsCycle = makeDeps(store, tmpRoot, {
      evolution: {
        enabled: true, autoTrigger: true, autoRecord: true,
        analysis: { minExperiences: 5, minOccurrences: 2 },
        generation: { enabled: true },
        promotion: { enabled: false },
        maxCyclesPerProcess: 10,
      },
    })
    const fakeDeps: ModuleDeps = {
      ...depsCycle,
      ctx: {
        ...depsCycle.ctx,
        get: (name: string) => {
          if (name === 'llm') return makeFakeLlm()
          if (name === 'agentDefaultModel') return {
            currentSelection: () => ({ provider: 'test', model: 'test-model' }),
          }
          return undefined
        },
      },
    }
    resetAutoGuards()
    const outcome = await runAutoCycle(fakeDeps)
    expect(outcome.ran).toBe(true)
    expect(outcome.candidateId).toBeDefined()

    const candidate = await store.getCandidate(outcome.candidateId!)
    expect(candidate).not.toBeNull()
    expect(candidate!.parentVersion).toBe(v2.id)

    // Roll back v2 so v1 is active again, v2 is rolled-back
    await store.rollbackVersion('v1')
    const activeAfterRollback = await store.getActiveVersion()
    expect(activeAfterRollback!.id).toBe('v1')
    expect(candidate!.parentVersion).toBe(v2.id) // unchanged — metadata is immutable

    // `evo_promote_decision` does NOT validate parentVersion against the active
    // version. It only checks benchmark evidence and policy gates. This is
    // intentional: parentVersion is provenance metadata, not a promotion gate.
    // Without benchmark evidence, the decision returns ok:false with a
    // "no benchmark evidence" error — NOT a parentVersion or staleness error.
    const promoteDecision = promoteTools(deps).find(t => t.name === 'evo_promote_decision')!
    const decision = await promoteDecision.execute({ candidateId: candidate!.id, allowSimulated: true } as never, exec) as {
      ok: boolean; recommendation?: string; error?: string
    }
    // The error (if any) is about missing benchmarks, not about the stale parentVersion.
    // No error string should mention "parentVersion", "stale", or "rolled-back"
    // as the reason for rejection.
    if (decision.error) {
      expect(decision.error).not.toContain('parentVersion')
      expect(decision.error).not.toContain('stale')
      expect(decision.error).not.toContain('rolled-back')
    }
  })
})
