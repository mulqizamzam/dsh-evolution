/**
 * Verify plugin tool outputs against the REAL host lossless-JSON boundary.
 *
 * Uses the harness' own `snapshotJsonValue` / `isJsonValue`
 * (packages/core/session/src/json.ts) — the exact function the tool runtime
 * calls — instead of a local re-implementation.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { snapshotJsonValue, isJsonValue } from '/home/administrator/deepseek-harness/packages/core/session/src/json.ts'
import { EvolutionStore } from '../src/host/store.ts'
import { benchmarkTools } from '../src/host/modules/benchmark/tools.ts'
import { promoteTools } from '../src/host/modules/promote/tools.ts'
import { experienceTools } from '../src/host/modules/experience/tools.ts'
import { evolutionTools } from '../src/host/modules/evolution/tools.ts'

const root = await mkdtemp(join(tmpdir(), 'evo-lossless-'))
const store = new EvolutionStore({ fallbackRoot: root })
await store.init()

const cfg = () => ({
  stateRoot: root,
  inject: { enabled: true },
  evolution: {
    enabled: true, autoRecord: true, autoTrigger: true,
    analysis: { minExperiences: 20, minOccurrences: 5 },
    generation: { enabled: false }, promotion: { enabled: false }, maxCyclesPerProcess: 3,
  },
  experience: { maxRecords: 10000, retentionDays: 90 },
  candidate: { maxActive: 10 },
  benchmark: { minRuns: 3, maxRuns: 10, improvementThreshold: 0.05, regressionThreshold: 0.10 },
})

const ctx = {
  tools: { register: () => {} },
  settings: { writable: true, register: () => ({ get: () => ({}) }) },
  agents: { get: () => undefined, roots: () => [] },
  get: () => undefined,
  on: () => () => {},
  effect: () => () => {},
} as never

const deps = { ctx, cfg, store, log: () => {}, warn: () => {} } as never

await store.createVersion({ label: 'v1', modules: [] })
const candidate = await store.addCandidate({
  parentVersion: 'v1', type: 'policy', name: 'lossless-probe', description: 'd', reason: 'r',
  evidenceIds: [], patternIds: [],
  files: [{ path: 'src/index.ts', content: 'export const x = 1' }], tests: [],
  benchmarkConfig: {
    successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
    errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 },
    avgDurationMs: { max: 60000, weight: 0.5 },
  },
  status: 'draft',
})

const exec = { signal: AbortSignal.timeout(60_000) }
const checks: Array<[string, unknown]> = []

// The exact call that failed live with "value is not lossless JSON".
const live = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!
checks.push(['evo_benchmark_live', await live.execute({
  candidateId: candidate.id, command: 'echo REAL_VALIDATOR_PROBE', timeoutMs: 20000,
} as never, exec)])

checks.push(['evo_benchmark_run', await benchmarkTools(deps).find(t => t.name === 'evo_benchmark_run')!
  .execute({ candidateId: candidate.id, runs: 3 } as never, exec)])

checks.push(['evo_promote_decision', await promoteTools(deps).find(t => t.name === 'evo_promote_decision')!
  .execute({ candidateId: candidate.id } as never, exec)])

checks.push(['evo_experience_inspect', await experienceTools(deps).find(t => t.name === 'evo_experience_inspect')!
  .execute({ id: 'does-not-exist' } as never, exec)])

checks.push(['evo_status', await evolutionTools(deps).find(t => t.name === 'evo_status')!
  .execute({} as never, exec)])

let failures = 0
for (const [name, value] of checks) {
  const snapshot = snapshotJsonValue(value)
  const ok = snapshot !== undefined && isJsonValue(value)
  if (!ok) failures += 1
  console.log(
    (ok ? 'PASS' : 'FAIL') + '  ' + name.padEnd(24)
    + ' snapshot=' + (snapshot === undefined ? 'REJECTED' : 'ok')
    + ' isJsonValue=' + isJsonValue(value),
  )
}

console.log(failures === 0
  ? '\nALL TOOL OUTPUTS PASS THE REAL HOST LOSSLESS-JSON BOUNDARY'
  : '\n' + failures + ' OUTPUT(S) REJECTED BY THE HOST BOUNDARY')

await rm(root, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
