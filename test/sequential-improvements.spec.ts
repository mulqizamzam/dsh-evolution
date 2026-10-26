/**
 * Sequential Improvements Capability Probe — Mission C.1
 *
 * Proves that the autonomous evolution cycle can produce multiple productive
 * cycles in one process, recording candidate/evidence/promotion state after
 * each. Determines exactly where/why progression stops and classifies the
 * stop reason against six candidate categories:
 *   a) cap exhaustion
 *   b) fresh-experience requirement
 *   c) pattern dedup (exact description including occurrence count)
 *   d) promotion rejection
 *   e) candidate/evidence identity dedup
 *   f) another concrete blocker
 *
 * This is a READ-ONLY probe: no product code changes.
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

// ── Deterministic LLM stub ──

const STUBBED_FILE_SET = JSON.stringify({
  manifest: {
    name: 'probe-candidate',
    version: '1.0.0',
    type: 'policy',
    description: 'Deterministic stub for sequential probe',
    entryPoint: 'run.js',
    benchmarkCases: [{
      id: 'case-1',
      description: 'stub benchmark',
      input: '',
      expectedOutput: '',
      expectedExitCode: 0,
      timeoutMs: 5000,
      successCriteria: 'returns ok',
    }],
  },
  files: [{ path: 'run.js', content: 'console.log(1)' }],
  tests: [{ path: 'test.spec.js', content: 'console.log(1)' }],
})

function makeStubCtx(): HostContextShape {
  return {
    tools: { register: () => {} },
    settings: { writable: true, register: () => ({ get: () => ({}) }) },
    agents: { get: () => undefined, roots: () => [] },
    get: (name: string) => {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'stub', model: 'stub-probe' }) }
      }
      if (name === 'llm') {
        return {
          stream: async function* () {
            yield { type: 'text-delta', index: 0, text: STUBBED_FILE_SET }
            yield { type: 'finish', index: 0, reason: { kind: 'stop' } }
          },
        }
      }
      return undefined
    },
    on: () => () => {},
    effect: () => () => {},
  }
}

function makeDeps(store: EvolutionStore, root: string, overrides?: Record<string, unknown>): ModuleDeps {
  return {
    ctx: makeStubCtx(),
    cfg: () => resolveConfig({ stateRoot: root, ...overrides }),
    store,
    log: () => {},
    warn: () => {},
  }
}

// ── Probe types ──

interface CycleRecord {
  cycle: number
  ran: boolean
  reason: string
  candidateId?: string
  verdict?: string
  patterns: number
  cyclesRun: number
  totalCandidates: number
  totalPatterns: number
}

// ── Tests ──

describe('sequential-improvements.spec.ts — Mission C.1 capability probe', () => {
  let tmpRoot: string
  let store: EvolutionStore

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-seq-probe-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
    resetAutoGuards()
  })

  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  /**
   * Phase A: shipped-cap probe.
   * Uses the shipped default cap=3 with generation+promotion enabled and a
   * deterministic stub LLM. Attempts 5 cycles; expects exactly 3 productive,
   * then cap exhaustion.
   *
   * Between each cycle, adds MIN_EXP fresh experiences with a UNIQUE error
   * signature so the fresh-experience gate passes and pattern dedup does not
   * fire. stepCount is kept small (3) to avoid the inefficiency pattern.
   */
  it('runs >=3 productive cycles with shipped cap (3), stops at cap exhaustion', async () => {
    const CAP = 3
    const MIN_EXP = 5
    const MIN_OCC = 2

    const deps = makeDeps(store, tmpRoot, {
      evolution: {
        maxCyclesPerProcess: CAP,
        analysis: { minExperiences: MIN_EXP, minOccurrences: MIN_OCC },
        generation: { enabled: true },
        promotion: { enabled: true },
        cycleDebounceMs: 0,
      },
    })

    // Seed first batch with a unique signature
    for (let i = 0; i < MIN_EXP; i++) {
      await store.addExperience({ success: false, errors: ['probe-sig-A'], stepCount: 3, prompt: 'probe-task-A' })
    }

    const records: CycleRecord[] = []
    let stopClassification = ''

    for (let cycle = 1; cycle <= 5; cycle++) {
      const outcome = await runAutoCycle(deps)
      const guard = autoGuardState()
      const candidates = await store.listCandidates(500)
      const patterns = await store.listPatterns(500)

      records.push({
        cycle,
        ran: outcome.ran,
        reason: outcome.reason,
        candidateId: outcome.candidateId,
        verdict: outcome.verdict,
        patterns: outcome.patterns ?? 0,
        cyclesRun: guard.cyclesRun,
        totalCandidates: candidates.length,
        totalPatterns: patterns.length,
      })

      if (!outcome.ran) {
        if (outcome.reason.includes('cap reached')) stopClassification = 'a) cap exhaustion'
        else if (outcome.reason.includes('waiting for more new experiences')) stopClassification = 'b) fresh-experience requirement'
        else if (outcome.reason.includes('no actionable recurring pattern')) stopClassification = 'c) pattern dedup (exact description match)'
        else stopClassification = 'f) another concrete blocker: ' + outcome.reason
        break
      }

      // Add fresh experiences with a NEW signature for the next cycle
      const sig = String.fromCharCode(65 + cycle) // B, C, D, E
      for (let i = 0; i < MIN_EXP; i++) {
        await store.addExperience({ success: false, errors: ['probe-sig-' + sig], stepCount: 3, prompt: 'probe-task-' + sig })
      }
    }

    // ── Assertions ──
    const productive = records.filter(r => r.ran)
    expect(productive.length).toBe(CAP)

    // Each productive cycle created a candidate
    for (const r of productive) {
      expect(r.candidateId).toBeDefined()
    }

    // Progression stopped at cap exhaustion (classification a)
    expect(stopClassification).toBe('a) cap exhaustion')
    expect(autoGuardState().cyclesRun).toBe(CAP)

    // Total candidates equals productive cycles
    const finalCandidates = await store.listCandidates(500)
    expect(finalCandidates.length).toBe(CAP)

    // ── Report ──
    console.log('\n[sequential-probe] Cycle records:')
    for (const r of records) {
      console.log(`  Cycle ${r.cycle}: ran=${r.ran}, candidate=${r.candidateId ?? 'none'}, `
        + `verdict=${r.verdict ?? 'undefined (no benchmark evidence)'}, `
        + `patterns=${r.patterns}, cyclesRun=${r.cyclesRun}, `
        + `totalCandidates=${r.totalCandidates}, totalPatterns=${r.totalPatterns}`)
    }
    console.log(`[sequential-probe] Stop classification: ${stopClassification}`)
    console.log(`[sequential-probe] Productive cycles: ${productive.length} / cap ${CAP}`)
    console.log(`[sequential-probe] Total candidates: ${finalCandidates.length}`)
    console.log('[sequential-probe] Note: runAutoCycle never benchmarks candidates internally, so')
    console.log('  promotion verdicts are always undefined (no benchmark evidence). Sequential')
    console.log('  promotion is not demonstrated by the autonomous loop alone.')
  })

  /**
   * Phase B: higher-cap probe (test-only override, product default unchanged).
   * Uses cap=10 to discover whether anything other than the shipped cap
   * blocks sequential progression when distinct fresh signatures are supplied.
   *
   * This is a genuine probe: it records the actual stop reason and does not
   * pre-assume the outcome.
   */
  it('with cap=10 (test override), attempts 12 cycles and classifies the stop reason', async () => {
    const CAP = 10
    const MIN_EXP = 5
    const MIN_OCC = 2

    const deps = makeDeps(store, tmpRoot, {
      evolution: {
        maxCyclesPerProcess: CAP,
        analysis: { minExperiences: MIN_EXP, minOccurrences: MIN_OCC },
        generation: { enabled: true },
        promotion: { enabled: true },
        cycleDebounceMs: 0,
      },
    })

    // Seed first batch
    for (let i = 0; i < MIN_EXP; i++) {
      await store.addExperience({ success: false, errors: ['probe2-sig-A'], stepCount: 3, prompt: 'probe2-task-A' })
    }

    const records: CycleRecord[] = []
    let stopClassification = ''

    for (let cycle = 1; cycle <= CAP + 2; cycle++) {
      const outcome = await runAutoCycle(deps)
      const guard = autoGuardState()

      records.push({
        cycle,
        ran: outcome.ran,
        reason: outcome.reason,
        candidateId: outcome.candidateId,
        verdict: outcome.verdict,
        patterns: outcome.patterns ?? 0,
        cyclesRun: guard.cyclesRun,
        totalCandidates: (await store.listCandidates(500)).length,
        totalPatterns: (await store.listPatterns(500)).length,
      })

      if (!outcome.ran) {
        if (outcome.reason.includes('cap reached')) stopClassification = 'a) cap exhaustion'
        else if (outcome.reason.includes('waiting for more new experiences')) stopClassification = 'b) fresh-experience requirement'
        else if (outcome.reason.includes('no actionable recurring pattern')) stopClassification = 'c) pattern dedup (exact description match)'
        else stopClassification = 'f) another concrete blocker: ' + outcome.reason
        break
      }

      const sig = String.fromCharCode(65 + cycle) // B, C, D, ..., K, L
      for (let i = 0; i < MIN_EXP; i++) {
        await store.addExperience({ success: false, errors: ['probe2-sig-' + sig], stepCount: 3, prompt: 'probe2-task-' + sig })
      }
    }

    const productive = records.filter(r => r.ran)
    expect(productive.length).toBeGreaterThanOrEqual(3)

    // Each productive cycle created a candidate
    for (const r of productive) {
      expect(r.candidateId).toBeDefined()
    }

    // Stop reason must be one of the classified categories.
    // b) fires when the read-window `listExperiences(minExperiences*4)` truncates
    // the total before it grows beyond minExp*4 — a known product characteristic,
    // not a probe defect. Report whichever blocker actually fired.
    const validClassifications = [
      'a) cap exhaustion',
      'b) fresh-experience requirement',
      'c) pattern dedup (exact description match)',
    ]
    expect(validClassifications).toContain(stopClassification)

    console.log(`\n[sequential-probe-cap10] Productive: ${productive.length} / cap ${CAP}`)
    console.log(`[sequential-probe-cap10] Stop: ${stopClassification}`)
    console.log('[sequential-probe-cap10] Records:')
    for (const r of records) {
      console.log(`  Cycle ${r.cycle}: ran=${r.ran}, candidate=${r.candidateId ?? 'none'}, cyclesRun=${r.cyclesRun}, patterns=${r.patterns}, totalPatterns=${r.totalPatterns}`)
    }
    console.log(`[sequential-probe-cap10] Conclusion: progression stopped at "${stopClassification}" after ${productive.length} productive cycles.`)
    if (stopClassification.startsWith('b)')) {
      console.log('  (b) is caused by the product\'s bounded read `listExperiences(minExp*4)`:')
      console.log('  once total experiences exceed that window, the observed delta undercounts')
      console.log('  new records. The probe surface the gate; do not inflate the window to hide it.')
    }
    if (stopClassification.startsWith('c)')) {
      console.log('  If pattern dedup (c), exact-description matching (including occurrence')
      console.log('  count) prevents new cycles even when fresh experiences exist.')
    }
  })
})
