import { JSON_OBJECT_OUTPUT, defineTool, registerToolSafe, text } from '../../dsh.ts'
import type { BenchmarkRun, ModuleDeps, ToolDefinition } from '../../types.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

function latestLive(records: BenchmarkRun[]): BenchmarkRun | undefined {
  return records
    .filter(record => record.mode === 'live')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
}

export const name = 'shadow-evaluation'

export function evaluateShadowGate(candidateRun: BenchmarkRun, baselineRun: BenchmarkRun | undefined) {
  const reasons: string[] = []
  if (candidateRun.mode !== 'live') reasons.push('Candidate evidence is not live execution evidence.')
  if (!baselineRun) reasons.push('No live benchmark baseline exists for the active version.')
  if (baselineRun && baselineRun.mode !== 'live') reasons.push('Active baseline is not live execution evidence.')
  const enoughRuns = candidateRun.runs >= 3
  if (!enoughRuns) reasons.push('Candidate has fewer than 3 benchmark runs.')
  const comparable = Boolean(baselineRun && candidateRun.mode === 'live' && baselineRun.mode === 'live')
  const successNoRegression = comparable && candidateRun.metrics.successRate >= baselineRun!.metrics.successRate
  const errorNoMaterialRegression = comparable && candidateRun.metrics.errorRate <= baselineRun!.metrics.errorRate + 0.05
  const latencyNoMaterialRegression = comparable &&
    (baselineRun!.metrics.avgDurationMs <= 0
      ? candidateRun.metrics.avgDurationMs <= 0
      : candidateRun.metrics.avgDurationMs <= baselineRun!.metrics.avgDurationMs * 1.25)
  if (comparable && !successNoRegression) reasons.push('Success rate regresses against the active baseline.')
  if (comparable && !errorNoMaterialRegression) reasons.push('Error rate regresses by more than 5 percentage points.')
  if (comparable && !latencyNoMaterialRegression) reasons.push('Average latency regresses by more than 25%.')
  const ready = comparable && enoughRuns && successNoRegression && errorNoMaterialRegression && latencyNoMaterialRegression
  if (ready) reasons.push('Recorded live metrics satisfy the conservative canary-entry gate.')
  return {
    canaryReady: ready,
    comparison: baselineRun ? {
      successRateDelta: candidateRun.metrics.successRate - baselineRun.metrics.successRate,
      errorRateDelta: candidateRun.metrics.errorRate - baselineRun.metrics.errorRate,
      avgDurationMsDelta: candidateRun.metrics.avgDurationMs - baselineRun.metrics.avgDurationMs,
    } : null,
    reasons,
    executionModel: 'benchmark-only; no live traffic is routed or shifted',
  }
}

export function apply(deps: ModuleDeps): void {
  const tool: ToolDefinition = defineTool({
    name: 'evo_shadow_evaluate',
    description: 'Compare a candidate latest live benchmark with the active version live benchmark and report whether it meets conservative canary-entry criteria. This is a decision report only: the current DSH activation model does not split live traffic.',
    parameters: {
      type: 'object',
      properties: { candidateId: { type: 'string', description: 'Candidate id to evaluate.' } },
      required: ['candidateId'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never) => {
      const a = (args ?? {}) as Record<string, unknown>
      const candidateId = typeof a.candidateId === 'string' ? a.candidateId : ''
      if (!candidateId) return neutralizeDeep({ ok: false, error: 'candidateId is required' })
      const candidate = await deps.store.getCandidate(candidateId)
      if (!candidate) return neutralizeDeep({ ok: false, error: 'no candidate ' + candidateId })
      const active = await deps.store.getActiveVersion()
      if (!active || !active.modules[0]) {
        return neutralizeDeep({ ok: true, candidateId, canaryReady: false, comparison: null, reasons: ['No active version is available as a baseline.'], executionModel: 'benchmark-only; no live traffic is routed or shifted' })
      }
      const [candidateRecords, baselineRecords] = await Promise.all([
        deps.store.listBenchmarksByCandidate(candidateId, true),
        deps.store.listBenchmarksByCandidate(active.modules[0], true),
      ])
      const candidateRun = latestLive(candidateRecords)
      const baselineRun = latestLive(baselineRecords)
      if (!candidateRun) {
        return neutralizeDeep({ ok: true, candidateId, canaryReady: false, comparison: null, reasons: ['Candidate has no live benchmark record; run evo_benchmark_live or evo_benchmark_ab first.'], executionModel: 'benchmark-only; no live traffic is routed or shifted' })
      }
      return neutralizeDeep({
        ok: true,
        candidateId,
        activeVersionId: active.id,
        candidateBenchmarkId: candidateRun.id,
        baselineBenchmarkId: baselineRun?.id ?? null,
        ...evaluateShadowGate(candidateRun, baselineRun),
      })
    },
  } as never)
  const result = registerToolSafe(deps.ctx, tool)
  if (!result.ok) deps.warn('shadow-evaluation: tool registration failed: ' + result.error)
  deps.log('shadow-evaluation: registered evo_shadow_evaluate')
}
