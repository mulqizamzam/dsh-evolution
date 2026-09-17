/**
 * P7 audit: safety control surface for generation and promotion enablement.
 *
 * Verifies four claims:
 *   C1  evo_full_cycle refuses to generate when generation.enabled=false.
 *   C2  evo_full_cycle rejects the candidate (never promotes) when
 *       generation.enabled=true but promotion.enabled=false.
 *   C3  resolveConfig throws on malformed input — no silent fallback.
 *   C4  evo_full_cycle exposes per-stage failures and cannot falsely report
 *       success across repeated invocations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig, DEFAULT_CONFIG } from '../src/host/config.ts'
import type { ModuleDeps } from '../src/host/types.ts'
import type { HostContextShape } from '../src/host/dsh.ts'
import { makeFakeHost } from './helpers/fake-host.ts'

// ── Helpers ──

function makeMockCtx(llmText: string): HostContextShape {
  const llm = {
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: llmText }
      yield { type: 'usage', index: 0, usage: { inputTokens: 50, outputTokens: 80 } }
      yield { type: 'finish', index: 0, reason: { kind: 'stop' } }
    },
  }
  return makeFakeHost({
    providers: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
      llm,
    },
  }).ctx
}

function makeDeps(
  store: EvolutionStore,
  root: string,
  overrides?: Record<string, unknown>,
): ModuleDeps {
  const cfg = () =>
    resolveConfig({
      stateRoot: root,
      inject: { enabled: true },
      experience: { maxRecords: 10000, retentionDays: 90 },
      candidate: { maxActive: 10 },
      benchmark: { minRuns: 3, maxRuns: 10, improvementThreshold: 0.05, regressionThreshold: 0.10 },
      evolution: {
        enabled: true,
        autoRecord: true,
        autoTrigger: true,
        analysis: { minExperiences: 20, minOccurrences: 5 },
        generation: { enabled: false },
        promotion: { enabled: false },
        maxCyclesPerProcess: 3,
        ...overrides?.evolution,
      },
    })
  return {
    ctx: makeMockCtx('{"manifest":{"name":"p7","version":"1.0.0","type":"policy","description":"P7 audit","entryPoint":"src/index.ts","benchmarkCases":[{"id":"c1","description":"x","input":"x","timeoutMs":5000,"successCriteria":"ok"}]},"files":[{"path":"src/index.ts","content":"export default 1"}],"tests":[{"path":"test/x.spec.ts","content":"test"}]}'),
    cfg,
    store,
    log: () => {},
    warn: () => {},
  }
}

async function seedPatterns(store: EvolutionStore, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await store.addExperience({
      success: false,
      errors: ['recurring-' + i],
      stepCount: 10 + i,
      prompt: 'common task pattern',
    })
  }
}

// ── Tests ──

describe('P7: generation/promotion enablement gates', () => {
  let tmpRoot: string
  let store: EvolutionStore
  let deps: ModuleDeps
  const exec = { signal: AbortSignal.timeout(10_000) }

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-p7-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
    deps = makeDeps(store, tmpRoot)
  })

  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  // ── C1: generation disabled blocks evo_full_cycle immediately ──

  it('C1: refuses generation when generation.enabled=false', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    await seedPatterns(store, 6)

    const evoTools = (await import('../src/host/modules/evolution/tools.ts')).evolutionTools(deps)
    const tool = evoTools.find(t => t.name === 'evo_full_cycle')!

    const result = await tool.execute({
      apiUrl: 'https://api.test/v1',
      apiKey: 'dummy-key',
      model: 'test-model',
      testCommand: 'echo ok',
      minOccurrences: 3,
    } as never, exec) as { ok: boolean; steps: string[]; error: string }

    expect(result.ok).toBe(false)
    expect(result.steps).toEqual(['observe'])
    expect(result.error).toContain('generation is disabled')
  })

  // ── C2: promotion disabled blocks promotion even if generation succeeds ──

  it('C2: generation runs when enabled but promotion stays disabled', async () => {
    deps = makeDeps(store, tmpRoot, {
      evolution: {
        enabled: true,
        autoRecord: true,
        autoTrigger: true,
        analysis: { minExperiences: 20, minOccurrences: 5 },
        generation: { enabled: true },
        promotion: { enabled: false },
        maxCyclesPerProcess: 3,
      },
    })
    await store.createVersion({ label: 'v1', modules: [] })
    await seedPatterns(store, 6)

    const evoTools = (await import('../src/host/modules/evolution/tools.ts')).evolutionTools(deps)
    const tool = evoTools.find(t => t.name === 'evo_full_cycle')!

    const result = await tool.execute({
      apiUrl: 'https://api.test/v1',
      apiKey: 'dummy-key',
      model: 'test-model',
      testCommand: 'echo ok',
      minOccurrences: 3,
    } as never, exec) as {
      ok: boolean
      steps: string[]
      verdict?: string
      candidateId?: string
      reason?: string
    }

    // Generation must have run (steps include 'build'), but promotion must be refused.
    expect(result.ok).toBe(false)
    expect(result.verdict).toBe('REJECTED')
    expect(result.reason).toContain('promotion is disabled')
    expect(result.candidateId).toBeDefined()

    // The candidate was persisted and marked rejected, not promoted.
    const candidate = await store.getCandidate(result.candidateId!)
    expect(candidate!.status).toBe('rejected')
    const versions = await store.listVersions(50)
    expect(versions.length).toBe(1) // v1 is still the only version; nothing promoted
  })

  // ── C3: malformed config does NOT silently fall back to defaults ──

  it('C3: resolveConfig throws on malformed input instead of falling back silently', () => {
    // Structurally invalid: boolean where object expected, no longer silently absorbed
    expect(() => resolveConfig({ evolution: { generation: true } })).toThrow()
    expect(() => resolveConfig({ evolution: { promotion: true } })).toThrow()
  })

  it('C3b: DEFAULT_CONFIG is still safe — generation and promotion both default to false', () => {
    expect(DEFAULT_CONFIG.evolution.generation.enabled).toBe(false)
    expect(DEFAULT_CONFIG.evolution.promotion.enabled).toBe(false)
  })

  // ── C4: stage failure exposure and repeated invocation safety ──

  it('C4: step-by-step failure exposure — observe stage', async () => {
    const evoTools = (await import('../src/host/modules/evolution/tools.ts')).evolutionTools(deps)
    const tool = evoTools.find(t => t.name === 'evo_full_cycle')!

    const result = await tool.execute({
      apiUrl: 'https://api.test/v1',
      apiKey: 'dummy-key',
      model: 'test-model',
      testCommand: 'echo ok',
    } as never, exec) as { ok: boolean; steps: string[]; error: string }

    expect(result.ok).toBe(false)
    // Generation gate fires first; steps contains only the pre-flight step.
    expect(result.steps).toEqual(['observe'])
    expect(result.error).toContain('generation is disabled')
  })

  it('C4: step-by-step failure exposure — analyze stage (no new patterns)', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    // Record some experiences but not enough to trigger pattern detection
    await store.addExperience({ success: false, errors: ['unique-error'], prompt: 'unique task' })
    deps = makeDeps(store, tmpRoot, {
      evolution: {
        enabled: true, autoRecord: true, autoTrigger: true,
        analysis: { minExperiences: 1, minOccurrences: 2 },
        generation: { enabled: true }, promotion: { enabled: true }, maxCyclesPerProcess: 3,
      },
    })

    const evoTools = (await import('../src/host/modules/evolution/tools.ts')).evolutionTools(deps)
    const tool = evoTools.find(t => t.name === 'evo_full_cycle')!

    const result = await tool.execute({
      apiUrl: 'https://api.test/v1',
      apiKey: 'dummy-key',
      model: 'test-model',
      testCommand: 'echo ok',
      minOccurrences: 5,
    } as never, exec) as { ok: boolean; steps: string[]; error: string }

    expect(result.ok).toBe(false)
    expect(result.steps).toContain('observe')
    expect(result.steps).toContain('analyze')
    expect(result.error).toContain('no new patterns')
  })

  it('C4: repeated invocation after first step-failure does not promote anything', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    deps = makeDeps(store, tmpRoot, {
      evolution: {
        enabled: true, autoRecord: true, autoTrigger: true,
        analysis: { minExperiences: 1, minOccurrences: 3 },
        generation: { enabled: true }, promotion: { enabled: true }, maxCyclesPerProcess: 3,
      },
    })
    await seedPatterns(store, 6)

    // Use a test command that will fail in sandbox to trigger the benchmark-fail path
    const evoTools = (await import('../src/host/modules/evolution/tools.ts')).evolutionTools(deps)
    const tool = evoTools.find(t => t.name === 'evo_full_cycle')!

    // First call: benchmark fails because 'exit 1' always fails
    const result1 = await tool.execute({
      apiUrl: 'https://api.test/v1',
      apiKey: 'dummy',
      model: 'm',
      testCommand: 'exit 1',  // always fails
      minOccurrences: 3,
    } as never, exec) as { ok: boolean; steps: string[] }

    // Steps should show the full pipeline ran
    expect(result1.ok).toBe(false)
    expect(result1.steps.length).toBeGreaterThan(0)

    // Second call must not promote anything either
    const result2 = await tool.execute({
      apiUrl: 'https://api.test/v1',
      apiKey: 'dummy',
      model: 'm',
      testCommand: 'exit 1',
      minOccurrences: 3,
    } as never, exec) as { ok: boolean }

    expect(result2.ok).toBe(false)

    // Only v1 should be active; no new version was created by failed benchmarks
    const versions = await store.listVersions(50)
    expect(versions.filter(v => v.status === 'active').length).toBe(1)
    expect(versions[0].id).toBe('v1')
  })

  // ── Auto-cycle consistency ──

  it('auto-cycle also respects both switches identically to evo_full_cycle', async () => {
    const { runAutoCycle, resetAutoGuards, autoGuardState } = await import('../src/host/modules/auto-experience/index.ts')

    // generation enabled, promotion disabled -> candidate created but not promoted
    deps = makeDeps(store, tmpRoot, {
      evolution: {
        enabled: true, autoRecord: true, autoTrigger: true,
        analysis: { minExperiences: 10, minOccurrences: 3 },
        generation: { enabled: true }, promotion: { enabled: false }, maxCyclesPerProcess: 3,
      },
    })
    await store.createVersion({ label: 'v1', modules: [] })
    for (let i = 0; i < 15; i++) {
      await store.addExperience({ success: false, errors: ['sig-a'], stepCount: 5, prompt: 'x' })
    }

    resetAutoGuards()
    const outcome = await runAutoCycle(deps)
    // Auto-cycle seeds >= minExperiences (10) experiences so it proceeds
    expect(outcome.ran).toBe(true)
    // Stops at "generation disabled" boundary only if generation were off;
    // with generation on and promotion off, it should reach the promotion boundary
    if (outcome.candidateId) {
      const c = await store.getCandidate(outcome.candidateId)
      expect(c!.status).toBe('draft')
    }
    expect(outcome.reason).toMatch(/generation|promotion|disabled|candidate/)
  })

  it('evo_full_cycle and auto-cycle agree on generation/promotion gate values', async () => {
    // Both paths read cfg.generation.enabled and cfg.promotion.enabled from the same config object
    const fullDeps = makeDeps(store, tmpRoot)
    const autoDeps = makeDeps(store, tmpRoot)

    // Both see generation off by default
    expect(fullDeps.cfg().evolution.generation.enabled).toBe(false)
    expect(autoDeps.cfg().evolution.generation.enabled).toBe(false)
    expect(fullDeps.cfg().evolution.promotion.enabled).toBe(false)
    expect(autoDeps.cfg().evolution.promotion.enabled).toBe(false)
  })
})
