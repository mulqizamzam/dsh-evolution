import type { EvolutionStore } from '../../src/host/store.ts'
import type { BenchmarkRun, BenchmarkMetrics } from '../../src/host/types.ts'
import { isoDateTime } from '../../src/lib/ids.ts'
import { createLiveProvenance } from '../../src/lib/provenance.ts'

/**
 * Seed a benchmark record into the store, auto-computing the `createdAt`
 * timestamp and the provenance seal so callers never have to spell out the
 * benchCreatedAt / benchCommand / createLiveProvenance boilerplate themselves.
 *
 * - `createdAt` is auto-computed via `isoDateTime(new Date())`.
 * - `provenance` is auto-computed via `createLiveProvenance` (only when
 *   `mode === 'live'`), binding (candidateId, version, command, createdAt).
 * - `createdAt` is passed as the 2nd argument to `store.addBenchmark()` so the
 *   persisted record and its seal share one authoritative timestamp.
 *
 * Individual metric overrides (`successRate`, `avgScore`, etc.) in `options`
 * take precedence over the corresponding value in the `metrics` parameter.
 */
export async function seedLiveBenchmark(
  store: EvolutionStore,
  candidateId: string,
  version: string,
  baseline: string,
  metrics: BenchmarkMetrics,
  options?: {
    passed?: boolean,
    details?: string,
    mode?: 'live' | 'simulated' | 'manifest',
    command?: string,
    errorRate?: number,
    successRate?: number,
    avgScore?: number,
    avgSteps?: number,
    avgDurationMs?: number,
    runs?: number,
  },
): Promise<BenchmarkRun> {
  const {
    passed = true,
    details = 'live evidence',
    mode = 'live',
    command = 'node candidate-under-test.js',
    runs = 3,
    successRate,
    avgScore,
    errorRate,
    avgSteps,
    avgDurationMs,
  } = options ?? {}

  const resolvedMetrics: BenchmarkMetrics = {
    successRate: successRate ?? metrics.successRate,
    avgScore: avgScore ?? metrics.avgScore,
    errorRate: errorRate ?? metrics.errorRate,
    avgSteps: avgSteps ?? metrics.avgSteps,
    avgDurationMs: avgDurationMs ?? metrics.avgDurationMs,
  }

  const createdAt = isoDateTime(new Date())

  const run: Omit<BenchmarkRun, 'id' | 'createdAt'> = {
    candidateId,
    version,
    baseline,
    mode,
    runs,
    metrics: resolvedMetrics,
    passed,
    details,
  }

  if (mode === 'live') {
    run.command = command
    run.provenance = createLiveProvenance(candidateId, version, command, createdAt)
  }

  return store.addBenchmark(run, createdAt)
}
