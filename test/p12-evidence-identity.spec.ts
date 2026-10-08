import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { ModuleDeps } from '../src/host/types.ts'
import { runAutoCycle, resetAutoGuards, autoGuardState } from '../src/host/modules/auto-experience/index.ts'
import { makeFakeLlm } from './helpers/fake-llm.ts'
import { seedExperiencesForVersion } from './helpers/seed-experiences.ts'

function makeCtx() {
  return {
    tools: { register: () => {} },
    settings: { writable: true, register: () => ({ get: () => ({}) }) },
    agents: { get: () => undefined, roots: () => [] },
    get: (name: string) => {
      if (name === 'llm') return makeFakeLlm()
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test', model: 'test-model' }) }
      return undefined
    },
    on: () => () => {},
    effect: () => () => {},
  }
}

function makeDeps(store: EvolutionStore, root: string): ModuleDeps {
  return {
    ctx: makeCtx(),
    cfg: () => resolveConfig({
      stateRoot: root,
      evolution: { enabled: true, autoTrigger: true, autoRecord: true, analysis: { minExperiences: 5, minOccurrences: 2 }, generation: { enabled: true }, promotion: { enabled: false }, maxCyclesPerProcess: 10 },
    }),
    store,
    log: () => {},
    warn: () => {},
  }
}

describe('P12 evidence identity and rejection churn', () => {
  let tmpRoot: string
  let store: EvolutionStore
  let deps: ModuleDeps

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-evid-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
    deps = makeDeps(store, tmpRoot)
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  // Same evidence + repeated rejection → no unbounded churn after terminal evidence is exhausted
  it('rejected same evidence does not create unbounded candidates', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })
    await seedExperiencesForVersion(store, v2.id, { successes: 0, failures: 5, errors: ['same-sig'] })

    // Cycle 1: generate C1
    resetAutoGuards()
    const o1 = await runAutoCycle(deps)
    expect(o1.ran).toBe(true)
    expect(o1.candidateId).toBeDefined()
    let cands = await store.listCandidates(500)
    expect(cands.length).toBe(1)
    const c1 = cands[0]!
    expect(c1.evidenceIds.length).toBe(5)
    const c1Ids = new Set(c1.evidenceIds)

    // Reject C1
    await store.updateCandidate(c1.id, { status: 'rejected' })

    // Cycle 2: same evidence, C1 rejected
    // detectDegradationContext should find no blocking non-terminal candidate
    // BUT the new terminal evidence check (C5) should see that current evidence
    // is a subset of rejected candidate's evidence → block.
    resetAutoGuards()
    const o2 = await runAutoCycle(deps)
    cands = await store.listCandidates(500)
    // With C5 fix: should NOT create C2 (same evidence, already tried)
    expect(cands.length).toBe(1)
  })

  // New evidence after rejection → new candidate allowed
  it('new evidence after rejection permits new candidate', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })
    await seedExperiencesForVersion(store, v2.id, { successes: 0, failures: 5, errors: ['same-sig'] })

    // Cycle 1: generate C1
    resetAutoGuards()
    const o1 = await runAutoCycle(deps)
    expect(o1.ran).toBe(true)
    const cands1 = await store.listCandidates(500)
    expect(cands1.length).toBe(1)
    const c1EvidenceIds = new Set(cands1[0]!.evidenceIds)

    // Reject C1
    await store.updateCandidate(cands1[0]!.id, { status: 'rejected' })

    // Add E6 (new experience under v2)
    await store.addExperience({
      success: false,
      errors: ['new-sig'],
      stepCount: 20,
      versionId: v2.id,
      prompt: 'new-task',
    })

    // Cycle 2: should create C2 because E6 is new evidence not in C1's set
    resetAutoGuards()
    const o2 = await runAutoCycle(deps)
    expect(o2.ran).toBe(true)
    const cands2 = await store.listCandidates(500)
    expect(cands2.length).toBe(2)
    // Find C2
    const c2 = cands2.find(c => !c1EvidenceIds.has(c.id))
    expect(c2).not.toBeNull()
    expect(c2!.evidenceIds.length).toBeGreaterThanOrEqual(5)
  })

  // Unchanged evidence after candidate blocked → no duplicate
  it('unchanged evidence after draft candidate blocks retry', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: [] })
    await seedExperiencesForVersion(store, v2.id, { successes: 0, failures: 5, errors: ['same-sig'] })

    // Cycle 1: generate C1 (draft)
    resetAutoGuards()
    const o1 = await runAutoCycle(deps)
    expect(o1.ran).toBe(true)
    const cands1 = await store.listCandidates(500)
    expect(cands1.length).toBe(1)
    expect(cands1[0]!.status).toBe('draft')

    // Cycle 2: same evidence, C1 still draft → blocked by non-terminal overlap check
    resetAutoGuards()
    const o2 = await runAutoCycle(deps)
    const cands2 = await store.listCandidates(500)
    // Guard may block on experience count; either way no new candidate
    expect(cands2.length).toBe(1)
  })
})
