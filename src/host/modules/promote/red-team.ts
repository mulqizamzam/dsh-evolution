import type { BenchmarkRun, CandidateModule, ModuleDeps } from '../../types.ts'
import { verifyBenchmarkAttestation, verifyLiveProvenance } from '../../../lib/provenance.ts'

export type RedTeamVerdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE'

export interface RedTeamCheck {
  id: string
  verdict: RedTeamVerdict
  detail: string
}

export interface RedTeamGateReport {
  verdict: RedTeamVerdict
  blocked: boolean
  candidateId: string
  benchmarkRunId?: string
  checkedAt: string
  checks: RedTeamCheck[]
}

/**
 * Runtime integrity gate for promotion-eligible evidence.
 *
 * This is intentionally fail-closed: an absent or legacy/unclassifiable
 * attestation is INCONCLUSIVE, and only PASS is promotable. Existing comparative
 * policy remains separate and is still evaluated after this evidence gate.
 *
 * The attestation is an unkeyed integrity digest. It detects record mutation
 * when fields are changed without recomputing the digest; it is not an
 * authenticity boundary against an attacker who can rewrite both data and code.
 */
export async function evaluateRedTeamPromotionGate(
  deps: ModuleDeps,
  candidate: CandidateModule,
  evidenceSnapshot?: BenchmarkRun | null,
): Promise<RedTeamGateReport> {
  const checkedAt = new Date().toISOString()
  const latest = evidenceSnapshot === undefined
    ? (await deps.store.listBenchmarksByCandidate(candidate.id, true))[0] as BenchmarkRun | undefined
    : evidenceSnapshot ?? undefined
  const checks: RedTeamCheck[] = []

  const add = (id: string, verdict: RedTeamVerdict, detail: string) => {
    checks.push({ id, verdict, detail })
  }

  if (!latest) {
    add('evidence-present', 'INCONCLUSIVE', 'No benchmark record exists for this candidate.')
    return report(candidate.id, checkedAt, checks)
  }

  if (latest.mode === 'simulated') {
    add('evidence-mode', 'FAIL', 'simulated evidence is not promotion-eligible.')
  } else if (latest.mode === 'live') {
    add('evidence-mode', 'PASS', 'Latest evidence is marked live.')
  } else {
    add(
      'evidence-mode',
      'INCONCLUSIVE',
      'Latest evidence is missing a recognized live mode; manifest, absent, or unknown modes cannot establish promotion eligibility.',
    )
  }

  if (latest.candidateId !== candidate.id) {
    add('candidate-binding', 'FAIL', 'Benchmark candidateId does not match the candidate being promoted.')
  } else {
    add('candidate-binding', 'PASS', 'Benchmark is bound to the requested candidate ID.')
  }

  if (latest.passed === true) {
    add('benchmark-outcome', 'PASS', 'Benchmark recorded passed=true.')
  } else if (latest.passed === false) {
    add('benchmark-outcome', 'FAIL', 'Latest benchmark explicitly failed.')
  } else {
    add('benchmark-outcome', 'INCONCLUSIVE', 'Latest benchmark has no valid boolean pass/fail outcome.')
  }

  const metrics = latest.metrics as unknown as Record<string, unknown> | null | undefined
  const metricBounds: Array<{ key: string; min: number; max?: number }> = [
    { key: 'successRate', min: 0, max: 1 },
    { key: 'avgScore', min: 0, max: 1 },
    { key: 'errorRate', min: 0, max: 1 },
    { key: 'avgSteps', min: 0 },
    { key: 'avgDurationMs', min: 0 },
  ]
  if (!metrics || typeof metrics !== 'object') {
    add('metrics-shape', 'INCONCLUSIVE', 'Benchmark metrics are missing or not an object.')
  } else {
    let malformed = false
    let outOfRange = false
    for (const bound of metricBounds) {
      const value = metrics[bound.key]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        malformed = true
        continue
      }
      if (value < bound.min || (bound.max !== undefined && value > bound.max)) outOfRange = true
    }
    if (outOfRange) {
      add('metrics-range', 'FAIL', 'One or more metrics are outside their permitted numeric range.')
    } else if (malformed) {
      add('metrics-range', 'INCONCLUSIVE', 'One or more required metrics are missing or non-finite.')
    } else {
      add('metrics-range', 'PASS', 'All benchmark metrics are finite and within expected bounds.')
    }
  }

  if (typeof latest.runs !== 'number' || !Number.isInteger(latest.runs)) {
    add('run-count', 'INCONCLUSIVE', 'Benchmark run count is missing or malformed.')
  } else if (latest.runs < 1) {
    add('run-count', 'FAIL', 'Benchmark run count must be at least one.')
  } else {
    add('run-count', 'PASS', 'Benchmark run count is a positive integer.')
  }

  const metadataValid =
    typeof latest.id === 'string' && latest.id.length > 0 &&
    typeof latest.version === 'string' && latest.version.length > 0 &&
    typeof latest.createdAt === 'string' && Number.isFinite(Date.parse(latest.createdAt)) &&
    typeof latest.command === 'string' && latest.command.trim().length > 0
  if (!metadataValid) {
    add('execution-metadata', 'INCONCLUSIVE', 'Execution ID, timestamp, version, or command is missing or malformed.')
  } else {
    add('execution-metadata', 'PASS', 'Execution metadata is present and parseable.')
  }

  if (latest.mode === 'live') {
    if (typeof latest.provenance !== 'string' || latest.provenance.length === 0) {
      add('provenance-seal', 'INCONCLUSIVE', 'Live evidence has no provenance seal.')
    } else if (!verifyLiveProvenance(latest)) {
      add('provenance-seal', 'FAIL', 'Live provenance seal does not match the record fields.')
    } else {
      add('provenance-seal', 'PASS', 'Live provenance seal matches candidate, version, command, and timestamp.')
    }
  } else {
    add('provenance-seal', 'INCONCLUSIVE', 'Provenance cannot certify a non-live evidence mode.')
  }

  const rawLatest = latest as unknown as Record<string, unknown>
  if (typeof rawLatest.attestation !== 'string' || rawLatest.attestation.length === 0) {
    add('record-attestation', 'INCONCLUSIVE', 'Benchmark predates the integrity attestation or has no attestation.')
  } else if (!verifyBenchmarkAttestation(rawLatest)) {
    add('record-attestation', 'FAIL', 'Benchmark content does not match its integrity attestation; possible record tampering.')
  } else {
    add('record-attestation', 'PASS', 'Benchmark content matches its integrity attestation.')
  }

  return report(candidate.id, checkedAt, checks, latest.id)
}

function report(
  candidateId: string,
  checkedAt: string,
  checks: RedTeamCheck[],
  benchmarkRunId?: string,
): RedTeamGateReport {
  const verdict: RedTeamVerdict = checks.some(check => check.verdict === 'FAIL')
    ? 'FAIL'
    : checks.some(check => check.verdict === 'INCONCLUSIVE')
      ? 'INCONCLUSIVE'
      : 'PASS'
  return {
    verdict,
    blocked: verdict !== 'PASS',
    candidateId,
    benchmarkRunId,
    checkedAt,
    checks,
  }
}

export function redTeamGateError(gate: RedTeamGateReport): string {
  const reasons = gate.checks
    .filter(check => check.verdict !== 'PASS')
    .map(check => check.id + ': ' + check.detail)
  return 'red-team promotion gate ' + gate.verdict + ' (fail-closed): ' + reasons.join(' ')
}
