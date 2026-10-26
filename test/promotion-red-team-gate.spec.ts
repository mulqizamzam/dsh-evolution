import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import { isoDateTime } from '../src/lib/ids.ts'
import { createLiveProvenance } from '../src/lib/provenance.ts'
import type { ModuleDeps } from '../src/host/types.ts'
import { evaluatePromotionPolicy } from '../src/host/modules/promote/index.ts'
import { evaluateRedTeamPromotionGate } from '../src/host/modules/promote/red-team.ts'
import { promoteTools } from '../src/host/modules/promote/tools.ts'

const BENCHMARK_CONFIG = {
  successRate: { min: 0.8, weight: 1 },
  avgScore: { min: 0.7, weight: 1 },
  errorRate: { max: 0.2, weight: 1 },
  avgSteps: { max: 50, weight: 0.5 },
  avgDurationMs: { max: 60_000, weight: 0.5 },
}

function makeDeps(store: EvolutionStore, root: string): ModuleDeps {
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
        generation: { enabled: false },
        promotion: { enabled: true },
        maxCyclesPerProcess: 10,
        cycleDebounceMs: 0,
      },
    }),
    store,
    log: () => {},
    warn: () => {},
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'evo-red-team-gate-'))
  const store = new EvolutionStore({ fallbackRoot: root })
  await store.init()
  const candidate = await store.addCandidate({
    parentVersion: 'v0',
    type: 'policy',
    name: 'red-team-fixture',
    description: 'fixture used for red-team promotion gate tests',
    reason: 'test',
    evidenceIds: [],
    patternIds: [],
    status: 'benchmarked',
    files: [{ path: 'src/index.ts', content: 'export const value = 1;\\n' }],
    tests: [],
    benchmarkConfig: BENCHMARK_CONFIG,
  })
  return { root, store, candidate, deps: makeDeps(store, root) }
}

async function addLiveEvidence(
  store: EvolutionStore,
  candidateId: string,
  overrides: Record<string, unknown> = {},
) {
  const createdAt = isoDateTime(new Date())
  const version = 'v0'
  const command = 'node candidate.js'
  return store.addBenchmark({
    candidateId,
    version,
    baseline: version,
    parentVersion: version,
    runs: 1,
    metrics: {
      successRate: 0.95,
      avgScore: 0.95,
      errorRate: 0.05,
      avgSteps: 1,
      avgDurationMs: 25,
    },
    passed: true,
    details: 'live sandbox execution fixture',
    mode: 'live',
    command,
    provenance: createLiveProvenance(candidateId, version, command, createdAt),
    ...overrides,
  } as never, createdAt)
}

describe('Red Team Promotion Gate', () => {
  it('passes only a live, passing, sealed, well-formed and attested record', async () => {
    const f = await fixture()
    try {
      await addLiveEvidence(f.store, f.candidate.id)
      const gate = await evaluateRedTeamPromotionGate(f.deps, f.candidate)
      expect(gate.verdict).toBe('PASS')
      expect(gate.blocked).toBe(false)
      expect(gate.checks.every(check => check.verdict === 'PASS')).toBe(true)
      expect(gate.auditRecordId).toBeTruthy()
      const audit = await f.store.listPromotionGateRuns(f.candidate.id, 10)
      expect(audit.some(record => record.id === gate.auditRecordId && record.verdict === 'PASS')).toBe(true)
      const policy = await evaluatePromotionPolicy(f.deps, f.candidate)
      expect(policy.ok).toBe(true)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it('reports INCONCLUSIVE and blocks when no benchmark evidence exists', async () => {
    const f = await fixture()
    try {
      const gate = await evaluateRedTeamPromotionGate(f.deps, f.candidate)
      expect(gate.verdict).toBe('INCONCLUSIVE')
      expect(gate.blocked).toBe(true)
      expect(gate.auditRecordId).toBeTruthy()

      const tool = promoteTools(f.deps).find(item => item.name === 'evo_promote')!
      const result = await tool.execute({ candidateId: f.candidate.id } as never, {
        signal: AbortSignal.timeout(5_000),
      }) as { ok: boolean; redTeamGate?: { verdict: string } }
      expect(result.ok).toBe(false)
      expect(result.redTeamGate?.verdict).toBe('INCONCLUSIVE')
      expect(await f.store.listVersions(200)).toHaveLength(0)
      expect(await f.store.getActiveVersion()).toBeNull()
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it('rejects simulated evidence even if its metrics claim a perfect result', async () => {
    const f = await fixture()
    try {
      await f.store.addBenchmark({
        candidateId: f.candidate.id,
        version: 'v0',
        baseline: 'v0',
        parentVersion: 'v0',
        runs: 5,
        metrics: { successRate: 1, avgScore: 1, errorRate: 0, avgSteps: 0, avgDurationMs: 1 },
        passed: true,
        details: 'forged-looking simulated evidence',
        mode: 'simulated',
        command: 'node candidate.js',
      })
      const gate = await evaluateRedTeamPromotionGate(f.deps, f.candidate)
      expect(gate.verdict).toBe('FAIL')
      expect(gate.checks.find(check => check.id === 'evidence-mode')?.verdict).toBe('FAIL')
      const policy = await evaluatePromotionPolicy(f.deps, f.candidate)
      expect(policy.ok).toBe(false)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it('rejects live evidence bound to a different candidate parent version', async () => {
    const f = await fixture()
    try {
      const createdAt = isoDateTime(new Date())
      const wrongVersion = 'v1'
      const command = 'node candidate.js'
      await f.store.addBenchmark({
        candidateId: f.candidate.id,
        version: wrongVersion,
        baseline: wrongVersion,
        parentVersion: wrongVersion,
        runs: 3,
        metrics: { successRate: 1, avgScore: 1, errorRate: 0, avgSteps: 1, avgDurationMs: 10 },
        passed: true,
        details: 'mismatched parent version fixture',
        mode: 'live',
        command,
        provenance: createLiveProvenance(f.candidate.id, wrongVersion, command, createdAt),
      }, createdAt)
      const gate = await evaluateRedTeamPromotionGate(f.deps, f.candidate)
      expect(gate.verdict).toBe('FAIL')
      expect(gate.checks.find(check => check.id === 'candidate-parent-binding')?.verdict).toBe('FAIL')
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it('reports INCONCLUSIVE for manifest-only evidence', async () => {
    const f = await fixture()
    try {
      await f.store.addBenchmark({
        candidateId: f.candidate.id,
        version: 'v0',
        baseline: 'v0',
        parentVersion: 'v0',
        runs: 2,
        metrics: { successRate: 1, avgScore: 1, errorRate: 0, avgSteps: 1, avgDurationMs: 10 },
        passed: true,
        details: 'manifest-only fixture',
        mode: 'manifest',
        command: 'manifest-cases',
      })
      const gate = await evaluateRedTeamPromotionGate(f.deps, f.candidate)
      expect(gate.verdict).toBe('INCONCLUSIVE')
      expect(gate.blocked).toBe(true)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it('fails closed on a forged or missing live provenance seal', async () => {
    const f = await fixture()
    try {
      await addLiveEvidence(f.store, f.candidate.id, { provenance: '0'.repeat(64) })
      const gate = await evaluateRedTeamPromotionGate(f.deps, f.candidate)
      expect(gate.verdict).toBe('FAIL')
      expect(gate.checks.find(check => check.id === 'provenance-seal')?.verdict).toBe('FAIL')
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it('detects metrics-only tampering that the legacy provenance seal does not bind', async () => {
    const f = await fixture()
    try {
      const record = await addLiveEvidence(f.store, f.candidate.id)
      const path = join(f.root, 'benchmarks', record.id + '.json')
      const persisted = JSON.parse(await readFile(path, 'utf8')) as {
        metrics: Record<string, number>
      }
      persisted.metrics.successRate = 1
      await writeFile(path, JSON.stringify(persisted), 'utf8')

      const gate = await evaluateRedTeamPromotionGate(f.deps, f.candidate)
      expect(gate.verdict).toBe('FAIL')
      expect(gate.checks.find(check => check.id === 'record-attestation')?.verdict).toBe('FAIL')
      const policy = await evaluatePromotionPolicy(f.deps, f.candidate)
      expect(policy.ok).toBe(false)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it('rejects out-of-range metrics and failed benchmark outcomes', async () => {
    const f = await fixture()
    try {
      await addLiveEvidence(f.store, f.candidate.id, {
        metrics: { successRate: 1.2, avgScore: 0.9, errorRate: 0, avgSteps: 1, avgDurationMs: 10 },
        passed: false,
      })
      const gate = await evaluateRedTeamPromotionGate(f.deps, f.candidate)
      expect(gate.verdict).toBe('FAIL')
      expect(gate.checks.find(check => check.id === 'metrics-range')?.verdict).toBe('FAIL')
      expect(gate.checks.find(check => check.id === 'benchmark-outcome')?.verdict).toBe('FAIL')
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it('treats a record without a current attestation as INCONCLUSIVE', async () => {
    const f = await fixture()
    try {
      const record = await addLiveEvidence(f.store, f.candidate.id)
      const path = join(f.root, 'benchmarks', record.id + '.json')
      const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      delete persisted.attestation
      await writeFile(path, JSON.stringify(persisted), 'utf8')
      const gate = await evaluateRedTeamPromotionGate(f.deps, f.candidate)
      expect(gate.verdict).toBe('INCONCLUSIVE')
      expect(gate.blocked).toBe(true)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })
})
