import type { EvolutionStore } from '../../src/host/store.ts'
import type { BenchmarkRun } from '../../src/host/types.ts'
import { createLiveProvenance } from '../../src/lib/provenance.ts'

/**
 * Seed a live benchmark record for tests that exercise promotion behavior.
 * The record is sealed exactly like a live evidence row, so these tests reach
 * the behavior under test instead of failing at the evidence-integrity gate.
 *
 * Tests that specifically exercise missing/forged provenance should continue
 * writing directly through the store and mutate the persisted record.
 */
export type LiveBenchmarkFixture = Omit<
  BenchmarkRun,
  'id' | 'createdAt' | 'attestation' | 'command' | 'mode' | 'provenance'
> & {
  createdAt?: string
  command?: string
}

export async function addSealedLiveBenchmark(
  store: EvolutionStore,
  input: LiveBenchmarkFixture,
): Promise<BenchmarkRun> {
  const createdAt = input.createdAt ?? new Date().toISOString()
  const command = input.command?.trim() || 'node candidate-under-test.js'
  return store.addBenchmark({
    ...input,
    mode: 'live',
    createdAt,
    command,
    provenance: createLiveProvenance(input.candidateId, input.version, command, createdAt),
  }, createdAt)
}
