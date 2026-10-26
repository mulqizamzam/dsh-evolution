import { JSON_OBJECT_OUTPUT, defineTool, registerToolSafe, text } from '../../dsh.ts'
import type { BenchmarkRun, ModuleDeps, ToolDefinition } from '../../types.ts'
import { verifyLiveProvenance } from '../../../lib/provenance.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

export function auditBenchmarkIntegrity(candidateId: string, records: BenchmarkRun[]) {
  const findings: Array<{ severity: 'critical' | 'high' | 'medium'; rule: string; benchmarkId: string; detail: string }> = []
  const seen = new Set<string>()
  for (const record of records) {
    if (record.candidateId !== candidateId) {
      findings.push({ severity: 'critical', rule: 'candidate-binding-mismatch', benchmarkId: record.id, detail: 'Benchmark record is returned under a different candidate id.' })
    }
    if (seen.has(record.id)) {
      findings.push({ severity: 'high', rule: 'duplicate-benchmark-id', benchmarkId: record.id, detail: 'Duplicate benchmark id appears in the candidate evidence list.' })
    }
    seen.add(record.id)
    if (record.mode === 'live' && !verifyLiveProvenance(record)) {
      findings.push({ severity: 'critical', rule: 'live-provenance-invalid', benchmarkId: record.id, detail: 'Live benchmark is missing a valid provenance seal or its sealed fields were changed.' })
    }
    if (record.mode !== 'live' && record.mode !== 'simulated' && record.mode !== 'manifest') {
      findings.push({ severity: 'high', rule: 'unknown-evidence-mode', benchmarkId: record.id, detail: 'Evidence mode is absent or unrecognized; do not treat it as verified live execution.' })
    }
    const m = record.metrics
    if (![m.successRate, m.avgScore, m.errorRate, m.avgSteps, m.avgDurationMs].every(Number.isFinite)) {
      findings.push({ severity: 'critical', rule: 'non-finite-metrics', benchmarkId: record.id, detail: 'One or more benchmark metrics are not finite numbers.' })
    }
    if (m.successRate < 0 || m.successRate > 1 || m.errorRate < 0 || m.errorRate > 1 || m.avgDurationMs < 0 || m.avgSteps < 0) {
      findings.push({ severity: 'high', rule: 'metric-out-of-range', benchmarkId: record.id, detail: 'Success/error rates or non-negative metrics are outside expected bounds.' })
    }
    if (!Number.isFinite(Date.parse(record.createdAt))) {
      findings.push({ severity: 'high', rule: 'invalid-timestamp', benchmarkId: record.id, detail: 'Benchmark timestamp cannot be parsed.' })
    }
    if (!Number.isInteger(record.runs) || record.runs < 1) {
      findings.push({ severity: 'high', rule: 'invalid-run-count', benchmarkId: record.id, detail: 'Benchmark run count must be a positive integer.' })
    }
  }
  const criticalCount = findings.filter(f => f.severity === 'critical').length
  const highCount = findings.filter(f => f.severity === 'high').length
  return {
    status: criticalCount > 0 ? 'FAIL' : highCount > 0 || reviewCount > 0 ? 'REVIEW' : 'PASS',
    candidateId,
    benchmarkCount: records.length,
    liveCount: records.filter(r => r.mode === 'live').length,
    simulatedCount: records.filter(r => r.mode === 'simulated').length,
    sealedLiveCount: records.filter(r => r.mode === 'live' && Boolean(r.provenance)).length,
    criticalCount,
    highCount,
    findings,
    limitations: [
      'The current provenance seal covers candidateId, version, command, and createdAt; it does not cryptographically cover the metrics payload.',
      'A clean report is a consistency check, not proof that the benchmark host or stored filesystem is uncompromised.',
    ],
  }
}

export const name = 'integrity-red-team'

export function apply(deps: ModuleDeps): void {
  const tool: ToolDefinition = defineTool({
    name: 'evo_integrity_redteam',
    description: 'Audit candidate benchmark records for provenance mismatches, missing or invalid live seals, invalid metric ranges, malformed timestamps, duplicate ids, and unknown evidence modes. Read-only; does not alter evidence or promotion state.',
    parameters: {
      type: 'object',
      properties: { candidateId: { type: 'string', description: 'Candidate id whose benchmark evidence should be audited.' } },
      required: ['candidateId'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never) => {
      const a = (args ?? {}) as Record<string, unknown>
      const candidateId = typeof a.candidateId === 'string' ? a.candidateId : ''
      if (!candidateId) return neutralizeDeep({ ok: false, error: 'candidateId is required' })
      const candidate = await deps.store.getCandidate(candidateId)
      if (!candidate) return neutralizeDeep({ ok: false, error: 'no candidate ' + candidateId })
      const records = await deps.store.listBenchmarksByCandidate(candidateId, true)
      return neutralizeDeep({ ok: true, ...auditBenchmarkIntegrity(candidateId, records) })
    },
  } as never)
  const result = registerToolSafe(deps.ctx, tool)
  if (!result.ok) deps.warn('integrity-red-team: tool registration failed: ' + result.error)
  deps.log('integrity-red-team: registered evo_integrity_redteam')
}
