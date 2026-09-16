import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import { makeFakeHost } from '../test/helpers/fake-host.ts'
import { promoteTools } from '../src/host/modules/promote/tools.ts'

const root = await mkdtemp(join(tmpdir(), 'probe-promote-'))
const store = new EvolutionStore({ fallbackRoot: root })
await store.init()
const deps = {
  ctx: makeFakeHost().ctx,
  cfg: () => resolveConfig({ stateRoot: root }),
  store, log: () => {}, warn: (m: string) => console.log('WARN', m),
} as never

await store.createVersion({ label: 'baseline', modules: [] })
const candidate = await store.addCandidate({
  parentVersion: 'v1', type: 'policy', name: 'probe', description: 'd', reason: 'r',
  evidenceIds: [], patternIds: [],
  files: [{ path: 'src/index.ts', content: 'export default function verify() { return true }' }],
  tests: [{ path: 'test/index.spec.ts', content: 'test' }],
  benchmarkConfig: {
    successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
    errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 },
    avgDurationMs: { max: 60000, weight: 0.5 },
  },
  status: 'draft',
})
await store.addBenchmark({
  mode: 'live', candidateId: candidate.id, version: 'v1', baseline: 'v1', runs: 3,
  metrics: { successRate: 1, avgScore: 1, errorRate: 0, avgSteps: 0, avgDurationMs: 100 },
  passed: true, details: 'ok',
})
await store.updateCandidate(candidate.id, { status: 'benchmarked' })

const promote = promoteTools(deps).find(t => t.name === 'evo_promote')!
const result = await promote.execute({ candidateId: candidate.id, reason: 'probe' } as never, { signal: AbortSignal.timeout(120_000) })
console.log(JSON.stringify(result, null, 2))
