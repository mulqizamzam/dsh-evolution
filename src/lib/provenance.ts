import { createHash } from 'node:crypto'

/**
 * Compute a deterministic provenance seal for a live benchmark record.
 *
 * The seal is a SHA-256 hex digest over the immutable execution parameters
 * that identify *which* sandbox run produced the evidence:
 *   candidateId · version · command · createdAt
 *
 * A record whose sealed fields (candidateId, version, command, or
 * createdAt) no longer match the stored seal produces a consistency
 * mismatch and is rejected at the promotion boundary.
 *
 * **Scope limitation:** the seal covers execution-context fields only. It
 * does NOT cover the `metrics` blob — an attacker who edits
 * `metrics.successRate` on an existing sealed record without touching the
 * four sealed fields will still pass seal verification.  This is the
 * documented residual risk of the minimal M3.3 mechanism; closing it would
 * require extending the seal to incorporate a metrics hash, which would
 * invalidate all pre-existing sealed records and is deliberately out of
 * scope.
 *
 * The command is the trusted operator-provided shell command executed in
 * the sandbox.  createdAt is the authoritative timestamp for the record —
 * it is computed once at write time by the caller and persisted with the
 * record; the seal is derived from it.
 *
 * Returns a 64-character lowercase hex string.  Callers that need to
 * distinguish "no seal" from "seal present" should check the caller-side
 * `undefined` on the `BenchmarkRun.provenance` field, not this function.
 */
export function createLiveProvenance(
  candidateId: string,
  version: string,
  command: string,
  createdAt: string,
): string {
  const input = `${candidateId}|${version}|${command}|${createdAt}`
  return createHash('sha256').update(input).digest('hex')
}

/**
 * Verify that a live benchmark record's stored provenance matches the
 * deterministic seal derived from its fields.
 *
 * Returns `true` when:
 *  - The record is NOT live (simulated records carry no seal and are
 *    validated by their mode field at the promotion boundary), OR
 *  - The record is live AND its stored provenance is present AND matches
 *    the freshly computed seal.
 *
 * Returns `false` when a live record is
 * missing its provenance seal or the seal does not match — indicating
 * either a code bug or inconsistency in the persisted JSON.
 */
export function verifyLiveProvenance(record: {
  mode?: string
  candidateId?: string
  version?: string
  command?: string
  createdAt?: string
  provenance?: string
}): boolean {
  if (record.mode !== 'live') return true
  if (!record.provenance) return false
  const expected = createLiveProvenance(
    record.candidateId ?? '',
    record.version ?? '',
    record.command ?? '',
    record.createdAt ?? '',
  )
  return record.provenance === expected
}
