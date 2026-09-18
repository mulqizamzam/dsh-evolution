/**
 * Test 1: Repeated Rejection Candidate Churn (C5 fix verification)
 *
 * Verifies that when the same evidence (same-signature failures) triggers
 * repeated rejection cycles, the system does NOT create a new candidate for
 * each rejection — the total candidate count stays at 1.
 *
 * This tests the C5 terminal evidence-identity guard in detectDegradationContext:
 *   - After a candidate is rejected with the same evidence set, subsequent
 *     cycles are blocked because evidenceIds.every(eid => terminal.has(eid))
 *   - New evidence after rejection allows a fresh candidate
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { ModuleDeps } from '../src/host/types.ts'
import type { HostContextShape } from '../src/host/dsh.ts'
import { runAutoCycle, resetAutoGuards, autoGuardState } from '../src/host/modules/auto-experience/index.ts'
import { seedExperiencesForVersion } from './helpers/seed-experiences.ts'
import { makeFakeLlm } from './helpers/fake-llm.ts'

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

describe('Test 1: Repeated Rejection Candidate Churn', () => {
  let tmpRoot: string
  let store: EvolutionStore
  let deps: ModuleDeps

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-reject-churn-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
    deps = makeDeps(store, tmpRoot, {
      evolution: {
        enabled: true, autoTrigger: true, autoRecord: true,
        analysis: { minExperiences: 5, minOccurrences: 2 },
        generation: { enabled: true },
        promotion: { enabled: false },
        maxCyclesPerProcess: 10,
      },
    })
  })

  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  it('after N rejections with SAME evidence, total candidate count stays at 1 (C5 blocks churn)', async () => {
    // Step 1: Create v1, v2 (v2 active)
    await store.createVersion({ label: 'v1-baseline', modules: [] })
    const v2 = await store.createVersion({ label: 'v2-degraded', modules: [] })
    expect(v2.id).toBe('v2')

    // Step 2: Seed 5 failures under v2 with SAME signature
    const expIds = await seedExperiencesForVersion(store, 'v2', {
      successes: 0,
      failures: 5,
      errors: ['timeout: request timed out'],
      stepCount: 15,
    })
    expect(expIds.length).toBe(5)

    const records = await store.listExperiencesByVersion('v2', 100)
    expect(records.length).toBe(5)
    for (const r of records) {
      expect(r.errors).toEqual(['timeout: request timed out'])
      expect(r.versionId).toBe('v2')
    }

    // Set up deps with fake LLM for generation
    const fakeLlm = makeFakeLlm()
    const genDeps: ModuleDeps = {
      ...deps,
      ctx: {
        ...deps.ctx,
        get: (name: string) => {
          if (name === 'llm') return fakeLlm
          if (name === 'agentDefaultModel') return {
            currentSelection: () => ({ provider: 'test', model: 'test-model' }),
          }
          return undefined
        },
      },
    }

    // Step 3: Run auto-cycle → candidate C1 created in draft
    resetAutoGuards()
    const outcome1 = await runAutoCycle(genDeps)
    expect(outcome1.ran).toBe(true)
    expect(outcome1.candidateId).toBeDefined()
    console.log(`[Cycle 1] outcome: ${outcome1.reason}, candidate: ${outcome1.candidateId}`)

    const candidatesAfterCycle1 = await store.listCandidates(500)
    expect(candidatesAfterCycle1.length).toBe(1)
    const c1Id = candidatesAfterCycle1[0]!.id
    expect(c1Id).toBe(outcome1.candidateId)
    expect(candidatesAfterCycle1[0]!.status).toBe('draft')
    expect(candidatesAfterCycle1[0]!.parentVersion).toBe('v2')
    expect(candidatesAfterCycle1[0]!.evidenceIds.length).toBe(5)
    console.log(`[Cycle 1] C1 created: id=${c1Id}, status=draft, parentVersion=v2`)

    // Step 4: Manually set C1 to 'rejected' (simulating benchmark failure)
    await store.updateCandidate(c1Id, { status: 'rejected' })
    const c1AfterReject = await store.getCandidate(c1Id)
    expect(c1AfterReject!.status).toBe('rejected')
    console.log(`[Reject] C1 set to rejected`)

    // Step 5-6: Run auto-cycles again after resetting guards
    // C5 terminal evidence-identity guard should BLOCK new candidate creation
    const candidateCounts: number[] = []
    const outcomes: string[] = []

    for (let cycle = 2; cycle <= 3; cycle++) {
      resetAutoGuards()
      const outcome = await runAutoCycle(genDeps)
      outcomes.push(outcome.reason)
      console.log(`[Cycle ${cycle}] outcome: ${outcome.reason}, candidate: ${outcome.candidateId}`)

      const allCandidates = await store.listCandidates(500)
      candidateCounts.push(allCandidates.length)

      const rejected = allCandidates.filter(c => c.status === 'rejected').length
      const draft = allCandidates.filter(c => c.status === 'draft').length
      console.log(`[Cycle ${cycle}] total=${allCandidates.length}, draft=${draft}, rejected=${rejected}`)
    }

    // Step 7: Assert — total candidate count stays at 1 after all rejections
    // (C5 terminal evidence-identity guard blocks churn)
    const finalCandidates = await store.listCandidates(500)
    console.log(`[Final] Total candidates: ${finalCandidates.length}`)
    console.log(`[Final] Candidates: ${finalCandidates.map(c => `${c.id}(${c.status})`).join(', ')}`)

    // Key assertion (C5): after N rejections with SAME evidence, only 1 candidate exists
    expect(finalCandidates.length).toBe(1)
    expect(finalCandidates[0]!.id).toBe(c1Id)
    expect(finalCandidates[0]!.status).toBe('rejected')
    expect(finalCandidates[0]!.evidenceIds.length).toBe(5)

    // All cycles after rejection returned "blocked" (not "candidate generated")
    for (const reason of outcomes) {
      expect(reason).not.toContain('candidate generated')
    }

    // Guards should be clean
    expect(autoGuardState().inFlight).toBe(false)
  })

  it('verifies: rejected candidate DOES allow retry when evidence changes', async () => {
    await store.createVersion({ label: 'v1-baseline', modules: [] })
    const v2 = await store.createVersion({ label: 'v2-degraded', modules: [] })

    await seedExperiencesForVersion(store, 'v2', {
      successes: 0, failures: 5, errors: ['same-sig'], stepCount: 15,
    })

    const fakeLlm = makeFakeLlm()
    const genDeps: ModuleDeps = {
      ...deps,
      ctx: {
        ...deps.ctx,
        get: (name: string) => {
          if (name === 'llm') return fakeLlm
          if (name === 'agentDefaultModel') return {
            currentSelection: () => ({ provider: 'test', model: 'test-model' }),
          }
          return undefined
        },
      },
    }

    resetAutoGuards()
    const outcome1 = await runAutoCycle(genDeps)
    expect(outcome1.ran).toBe(true)
    expect(outcome1.candidateId).toBeDefined()

    // Reject C1
    await store.updateCandidate(outcome1.candidateId!, { status: 'rejected' })

    // Add NEW failures with DIFFERENT signature (new evidence)
    for (let i = 0; i < 5; i++) {
      await store.addExperience({
        success: false,
        errors: ['sig-B-new-' + i],
        stepCount: 18,
        versionId: 'v2',
        prompt: 'new-task-' + i,
      })
    }

    resetAutoGuards()
    const outcome2 = await runAutoCycle(genDeps)
    console.log(`[New evidence] outcome: ${outcome2.reason}, candidate: ${outcome2.candidateId}`)

    // With different evidence, a new candidate IS allowed
    const allCandidates = await store.listCandidates(500)
    console.log(`[New evidence] total candidates: ${allCandidates.length}`)
    expect(allCandidates.length).toBe(2) // C1 (rejected) + C2 (draft)
    expect(outcome2.candidateId).toBeDefined()

    // Verify C2 has new evidence IDs
    const c2 = allCandidates.find(c => c.id === outcome2.candidateId)
    expect(c2).not.toBeNull()
    expect(c2!.evidenceIds.length).toBeGreaterThanOrEqual(6)
  })
})
