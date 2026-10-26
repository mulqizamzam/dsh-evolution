import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import { isoDateTime } from '../src/lib/ids.ts'
import { createLiveProvenance } from '../src/lib/provenance.ts'
import type { ModuleDeps } from '../src/host/types.ts'
import { promoteTools } from '../src/host/modules/promote/tools.ts'
import { evolutionTools } from '../src/host/modules/evolution/tools.ts'

// These tests exercise promotion-switch policy, not the sandbox itself.
// Sandbox pre-flight has separate coverage; keep this policy test independent
// of whether Bubblewrap is installed on the test runner.
vi.mock('../src/host/modules/activation/loader.ts', () => ({
  activateVersion: vi.fn(async () => ({ toolName: 'evo-test' })),
  activationState: vi.fn(() => ({
    activeVersionId: null,
    activeTool: null,
    reason: 'test activation stub',
  })),
  refreshActivation: vi.fn(async () => {}),
}))

vi.mock('../src/host/modules/builder/tools.ts', () => ({
  builderTools: (deps: { store: EvolutionStore }) => [{
    name: 'evo_builder_generate',
    execute: async () => {
      const candidates = await deps.store.listCandidates(500)
      const candidate = candidates.find(c => c.status === 'draft' && c.name.startsWith('auto: '))
      if (!candidate) throw new Error('expected evo_full_cycle to create a draft candidate')
      return { ok: true, candidateId: candidate.id, validation: { valid: true, errors: [] } }
    },
  }],
}))

vi.mock('../src/host/modules/benchmark/tools.ts', () => ({
  benchmarkTools: () => [
    { name: 'evo_benchmark_live', execute: async () => ({ ok: true, passed: true }) },
    { name: 'evo_benchmark_run', execute: async () => ({ ok: true, passed: true }) },
  ],
}))

const BENCHMARK_CONFIG = {
  successRate: { min: 0.8, weight: 1 },
  avgScore: { min: 0.7, weight: 1 },
  errorRate: { max: 0.2, weight: 1 },
  avgSteps: { max: 50, weight: 0.5 },
  avgDurationMs: { max: 60_000, weight: 0.5 },
}

function makeDeps(store: EvolutionStore, root: string, generationEnabled = false): ModuleDeps {
  return {
    ctx: {
      tools: { register: () => {} },
      settings: { writable: true, register: () => ({ get: () => ({}) }) },
      agents: { get: () => undefined, roots: () => [] },
      get: () => undefined,
      on: () => () => {},
      effect: () => () => {},
    },
    cfg: () => resolveConfig({
      stateRoot: root,
      evolution: {
        enabled: true,
        autoRecord: true,
        autoTrigger: false,
        analysis: { minExperiences: 5, minOccurrences: 3 },
        generation: { enabled: generationEnabled },
        promotion: { enabled: false },
        maxCyclesPerProcess: 10,
        cycleDebounceMs: 0,
      },
    }),
    store,
    log: () => {},
    warn: () => {},
  }
}

async function addCandidateWithLiveEvidence(store: EvolutionStore) {
  const candidate = await store.addCandidate({
    parentVersion: 'v0',
    type: 'policy',
    name: 'manual-promotion',
    description: 'promotion switch regression fixture',
    reason: 'test',
    evidenceIds: [],
    patternIds: [],
    status: 'benchmarked',
    files: [{ path: 'src/index.ts', content: 'export const value = 1;\n' }],
    tests: [],
    benchmarkConfig: BENCHMARK_CONFIG,
  })

  const createdAt = isoDateTime(new Date())
  const command = 'node candidate.js'
  await store.addBenchmark({
    candidateId: candidate.id,
    version: 'v1',
    baseline: 'unknown',
    runs: 3,
    metrics: {
      successRate: 1,
      avgScore: 1,
      errorRate: 0,
      avgSteps: 1,
      avgDurationMs: 10,
    },
    passed: true,
    details: 'test live evidence',
    createdAt,
    command,
    provenance: createLiveProvenance(candidate.id, 'v1', command, createdAt) ?? undefined,
    mode: 'live',
  })
  return candidate
}

describe('evolution.promotion.enabled switch semantics', () => {
  it('blocks automatic promotion inside evo_full_cycle when the switch is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evo-full-cycle-switch-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()
      for (let i = 0; i < 5; i++) {
        await store.addExperience({
          taskId: 'switch-' + i,
          prompt: 'repeat failed task',
          summary: 'Repeated error during task',
          success: false,
          errors: ['repeat error: test failure'],
          stepCount: 2,
        })
      }

      const deps = makeDeps(store, root, true)
      const tool = evolutionTools(deps).find(t => t.name === 'evo_full_cycle')!
      const result = await tool.execute({
        apiUrl: 'https://example.invalid',
        apiKey: 'test-key',
        model: 'test-model',
        testCommand: 'node candidate.js',
      } as never, { signal: AbortSignal.timeout(10_000) }) as {
        ok: boolean
        verdict?: string
        candidateId?: string
        reason?: string
      }

      expect(result.ok).toBe(false)
      expect(result.verdict).toBe('REJECTED')
      expect(result.reason).toContain('promotion is disabled by config')
      expect(result.candidateId).toBeTruthy()
      expect((await store.getCandidate(result.candidateId!))?.status).toBe('rejected')
      expect(await store.listVersions(200)).toHaveLength(0)
      expect(await store.getActiveVersion()).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not block an explicit manual evo_promote call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evo-manual-switch-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()
      const candidate = await addCandidateWithLiveEvidence(store)
      const deps = makeDeps(store, root)
      const tool = promoteTools(deps).find(t => t.name === 'evo_promote')!

      const result = await tool.execute(
        { candidateId: candidate.id, reason: 'operator-approved' } as never,
        { signal: AbortSignal.timeout(10_000) },
      ) as { ok: boolean; error?: string; version?: { modules: string[] } }

      expect(result.ok).toBe(true)
      expect(result.error).toBeUndefined()
      expect(result.version?.modules[0]).toBe(candidate.id)
      expect((await store.getActiveVersion())?.modules[0]).toBe(candidate.id)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps explicit rollback available while automatic promotion is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evo-rollback-switch-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()
      const original = await store.createVersion({
        label: 'original',
        reason: 'test',
        modules: [],
      })
      await store.createVersion({
        label: 'newer',
        reason: 'test',
        modules: [],
      })

      const deps = makeDeps(store, root)
      const tool = promoteTools(deps).find(t => t.name === 'evo_rollback')!
      const result = await tool.execute(
        { versionId: original.id } as never,
        { signal: AbortSignal.timeout(10_000) },
      ) as { ok: boolean; error?: string; restored?: string }

      expect(result.ok).toBe(true)
      expect(result.restored).toBe(original.id)
      expect((await store.getActiveVersion())?.id).toBe(original.id)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
