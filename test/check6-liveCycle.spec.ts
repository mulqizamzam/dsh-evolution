/**
 * CHECK 6: Live evolution cycle trace
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { ModuleDeps, HostContextShape } from '../src/host/types.ts'
import { runAutoCycle, resetAutoGuards } from '../src/host/modules/auto-experience/index.ts'

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

describe('CHECK 6: Live evolution cycle trace', () => {
  it('trace: experience → pattern → detectPatternEvidenceIds → persist', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-check6-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()
      await store.createVersion({ label: 'v1-baseline', modules: [] })

      // STEP 1: Record 12 experiences with recurring failure
      for (let i = 0; i < 12; i++) {
        const exp = await store.addExperience({
          success: false,
          errors: ['timeout: request timed out after 30s'],
          stepCount: 15,
          versionId: 'v1',
          prompt: 'failing-task-' + i,
        })
        expect(exp.id).toBeTruthy()
      }

      // STEP 2: Verify pattern detection produces evidenceIds
      const { detectPatterns } = await import('../src/host/modules/analyze/tools.ts')
      const experiences = await store.listExperiences(100)
      const patterns = detectPatterns(experiences, 3)
      expect(patterns.length).toBeGreaterThan(0)
      const pattern = patterns[0]!
      expect(pattern.evidenceIds.length).toBeGreaterThan(0)

      // STEP 3: Verify evidenceIds reference real experience IDs
      const evidenceIdsSet = new Set(pattern.evidenceIds)
      for (const eid of pattern.evidenceIds) {
        const found = experiences.find(e => e.id === eid)
        expect(found).toBeDefined()
      }

      // STEP 4: Run auto-cycle and verify pattern persistence
      const deps: ModuleDeps = {
        ctx: makeCtx(),
        cfg: () => resolveConfig({ stateRoot: tmpRoot, evolution: { enabled: true, autoTrigger: true, autoRecord: true, analysis: { minExperiences: 5, minOccurrences: 3 }, generation: { enabled: false }, promotion: { enabled: false }, maxCyclesPerProcess: 10 } }),
        store, log: () => {}, warn: () => {},
      }
      resetAutoGuards()
      const outcome = await runAutoCycle(deps)
      expect(outcome.ran).toBe(true)

      // STEP 5: Verify persisted pattern has evidenceIds
      const persistedPatterns = await store.listPatterns(100)
      const freshPattern = persistedPatterns[persistedPatterns.length - 1]!
      expect(freshPattern.evidenceIds.length).toBeGreaterThan(0)

      console.log('[CHECK6] Pattern', freshPattern.id, 'has', freshPattern.evidenceIds.length, 'evidenceIds')
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })
})
