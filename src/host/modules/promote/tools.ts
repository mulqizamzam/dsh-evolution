import { JSON_OBJECT_OUTPUT, defineTool, text } from '../../dsh.ts'
import type { ModuleDeps, ToolDefinition } from '../../types.ts'
import { DEFAULT_PROMOTION_POLICY } from '../../types.ts'
import { clampText } from '../../../lib/caps.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

export function promoteTools(deps: ModuleDeps): ToolDefinition[] {
  const store = deps.store

  return [
    defineTool({
      name: 'evo_promote',
      description: 'Promote a benchmarked candidate to the active version. The previous active version is marked rolled-back. Only candidates in benchmarked status are accepted.',
      parameters: {
        type: 'object',
        properties: {
          candidateId: { type: 'string', description: 'The candidate id to promote.' },
          reason: { type: 'string', description: 'Short reason for promotion.' },
        },
        required: ['candidateId'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const candidateId = typeof a.candidateId === 'string' ? a.candidateId : ''
        const candidate = await store.getCandidate(candidateId)
        if (!candidate) return neutralizeDeep({ ok: false, error: 'no candidate ' + candidateId })
        if (candidate.status !== 'benchmarked') {
          return neutralizeDeep({ ok: false, error: 'candidate ' + candidateId + ' is ' + candidate.status + '; must be benchmarked before promotion' })
        }
        // Promotion must produce a deterministic, loadable artifact. Build and
        // validate it BEFORE creating the version, so a candidate that cannot
        // activate never becomes the active version.
        const { materializeArtifact, validateArtifact } = await import('../activation/artifact.ts')
        const { activateVersion, refreshActivation, activationState } = await import('../activation/loader.ts')

        // The version id is decided by the store; materialize under a probe id
        // first, then rewrite under the real id once it is known.
        const versionNumber = (await store.listVersions(200)).reduce((max, v) => Math.max(max, v.number), 0) + 1
        const plannedVersionId = 'v' + String(versionNumber)

        let manifest: { toolName: string } | null = null
        try {
          manifest = await materializeArtifact(store.getRoot(), {
            id: plannedVersionId,
            number: versionNumber,
            label: candidate.name,
            createdAt: new Date().toISOString(),
            status: 'active',
            modules: [candidate.id],
          }, candidate)
        } catch (error) {
          return neutralizeDeep({ ok: false, error: 'could not materialize the version artifact: ' + String(error instanceof Error ? error.message : error) })
        }

        const validation = await validateArtifact(store.getRoot(), plannedVersionId)
        if (!validation.valid) {
          return neutralizeDeep({ ok: false, error: 'version artifact did not validate', errors: validation.errors })
        }

        // Pre-flight executes the candidate in the sandbox: an incompatible or
        // broken candidate is refused here, before any state changes.
        const probe = await activateVersion(deps, plannedVersionId)
        if (probe === null) {
          return neutralizeDeep({
            ok: false,
            error: 'candidate refused by activation pre-flight; version not created',
            activationReason: activationState().reason,
          })
        }

        // Capture the current active version's benchmarked success rate so
        // that subsequent promotion cycles can compare against a known
        // baseline rather than a static threshold floor.  For the first
        // version (no active) this is omitted — the version record has no
        // activeMetrics field.
        const activeBeforePromote = await store.getActiveVersion()
        let capturedActiveMetrics: import('../../types.ts').BenchmarkMetrics | undefined
        if (activeBeforePromote?.modules?.length) {
          const activeModuleId = activeBeforePromote.modules[0]
          const allBenches = await store.listBenchmarks(500)
          const activeModuleBenches = allBenches
            .filter(b => b.candidateId === activeModuleId)
            .sort((x, y) => x.createdAt > y.createdAt ? -1 : 1)
          const activeModuleBench = activeModuleBenches[0]
          if (activeModuleBench) {
            capturedActiveMetrics = activeModuleBench.metrics
          }
        }

        const version = await store.createVersion({
          label: candidate.name,
          reason: clampText(typeof a.reason === 'string' ? a.reason : '', 500),
          promotedFrom: candidate.parentVersion,
          modules: [candidate.id],
          activeMetrics: capturedActiveMetrics,
        })
        await store.updateCandidate(candidateId, { status: 'promoted' })

        // The store may assign a different id than the probe used; make the
        // mounted artifact match the real active version.
        if (version.id !== plannedVersionId) {
          await materializeArtifact(store.getRoot(), version, candidate)
        }
        await refreshActivation(deps)
        const state = activationState()

        return neutralizeDeep({
          ok: true,
          version,
          candidateId,
          activation: { mountedVersionId: state.activeVersionId, mountedTool: state.activeTool, reason: state.reason },
        })
      },
    } as never),

    defineTool({
      name: 'evo_rollback',
      description: 'Rollback to a previous version, making it the active version and marking the current active one rolled-back.',
      parameters: {
        type: 'object',
        properties: {
          versionId: { type: 'string', description: 'The version id to roll back to, e.g. v1.' },
        },
        required: ['versionId'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const versionId = typeof a.versionId === 'string' ? a.versionId : ''
        const result = await store.rollbackVersion(versionId)
        if (!result) return neutralizeDeep({ ok: false, error: 'no version ' + versionId })
        if (result.alreadyActive) return neutralizeDeep({ ok: false, error: 'version ' + versionId + ' is already active; nothing to roll back' })

        // Deactivation is immediate: the running host must stop exposing the
        // rolled-back version's tool.
        const { refreshActivation, activationState } = await import('../activation/loader.ts')
        await refreshActivation(deps)
        const state = activationState()

        return neutralizeDeep({
          ok: true,
          versionId,
          restored: result.restored,
          deactivated: result.deactivated?.id ?? null,
          activation: { mountedVersionId: state.activeVersionId, mountedTool: state.activeTool, reason: state.reason },
        })
      },
    } as never),

    defineTool({
      name: 'evo_promote_list',
      description: 'List all versions ordered by number, showing status and promoted modules.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximum number of versions to return. Defaults to 50.' },
        },
        required: [],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const limit = typeof a.limit === 'number' ? Math.max(1, Math.min(200, Math.floor(a.limit))) : 50
        const versions = await store.listVersions(limit)
        return neutralizeDeep({ count: versions.length, versions })
      },
    } as never),

    defineTool({
      name: 'evo_promote_decision',
      description: 'Read the latest benchmark evidence for a candidate and apply the promotion policy. Returns a recommendation of promote or reject with the exact metrics that justify the decision.',
      parameters: {
        type: 'object',
        properties: {
          candidateId: { type: 'string', description: 'The candidate id to evaluate for promotion.' },
          allowSimulated: { type: 'boolean', description: 'Allow a decision from simulated evidence. Defaults to false: simulated runs are not execution evidence and cannot promote a candidate unless this is explicitly set.' },
        },
        required: ['candidateId'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const candidateId = typeof a.candidateId === 'string' ? a.candidateId : ''

        // Load candidate
        const candidate = await store.getCandidate(candidateId)
        if (!candidate) return neutralizeDeep({ ok: false, error: 'no candidate ' + candidateId })

        // Find latest benchmark for this candidate
        const allBenchmarks = await store.listBenchmarks(500)
        const candidateBenchmarks = allBenchmarks
          .filter(b => b.candidateId === candidateId)
          .sort((a, b) => a.createdAt > b.createdAt ? -1 : 1)
        const latest = candidateBenchmarks[0]
        if (!latest) {
          return neutralizeDeep({
            ok: false,
            error: 'no benchmark evidence for candidate ' + candidateId + '; run evo_benchmark_run or evo_benchmark_ab before requesting a promotion decision',
          })
        }

        // Simulated runs are inferred from stored experience, not measured by
        // execution, so they cannot justify a promotion on their own.
        const evidenceMode = latest.mode ?? 'simulated'
        if (evidenceMode !== 'live' && a.allowSimulated !== true) {
          return neutralizeDeep({
            ok: false,
            evidenceMode,
            benchmarkRunId: latest.id,
            error: 'the latest benchmark evidence is SIMULATED, not execution evidence;'
              + ' run evo_benchmark_live or evo_benchmark_ab to produce live evidence,'
              + ' or pass allowSimulated true to decide on simulated data explicitly',
          })
        }

        const policy = DEFAULT_PROMOTION_POLICY
        const thresholdCfg = candidate.benchmarkConfig
        const m = latest.metrics

        // Find the active version's latest benchmark metrics to compare the
        // candidate against.  For the first-ever version this will be null,
        // so the gate is skipped.  For subsequent versions this prevents a
        // candidate from replacing an objectively better active version.
        const activeVersion = await store.getActiveVersion()
        let activeMetrics: { successRate: number } | null = null
        if (activeVersion?.modules?.length) {
          const activeModuleId = activeVersion.modules[0]
          const activeModuleBenchmarks = allBenchmarks
            .filter(b => b.candidateId === activeModuleId)
            .sort((x, y) => x.createdAt > y.createdAt ? -1 : 1)
          const activeModuleBench = activeModuleBenchmarks[0]
          if (activeModuleBench && activeModuleBench.mode !== 'simulated') {
            activeMetrics = activeModuleBench.metrics
          }
        }

        // Compute deltas against the configured thresholds (thresholds act as the baseline).
        const successDelta = m.successRate - thresholdCfg.successRate.min
        const errorDelta = m.errorRate - thresholdCfg.errorRate.max
        const latencyRatio = thresholdCfg.avgDurationMs.max > 0
          ? m.avgDurationMs / thresholdCfg.avgDurationMs.max
          : 0

        // ── Policy gate checks ──
        const checks: Array<{ gate: string; pass: boolean; actual: string; threshold: string }> = []

        // 1. Benchmark must have passed its threshold evaluation.
        checks.push({
          gate: 'benchmark_passed',
          pass: latest.passed,
          actual: String(latest.passed),
          threshold: 'true',
        })

        // 2. Minimum number of benchmark runs.
        checks.push({
          gate: 'min_runs',
          pass: latest.runs >= policy.minRuns,
          actual: String(latest.runs),
          threshold: String(policy.minRuns),
        })

        // 3. Success rate improvement over the configured minimum.
        checks.push({
          gate: 'success_improvement',
          pass: successDelta >= policy.minSuccessImprovement,
          actual: (successDelta * 100).toFixed(1) + '%',
          threshold: (policy.minSuccessImprovement * 100).toFixed(1) + '%',
        })

        // 4. Error rate must not regress beyond the allowed maximum.
        //    errorDelta < 0 means actual error rate is BELOW the threshold (good).
        //    errorDelta > 0 means actual error rate EXCEEDS the threshold (bad).
        //    maxRegression is negative (e.g. -0.05), so we check the error
        //    rate is not more than |maxRegression| above the threshold.
        checks.push({
          gate: 'max_regression',
          pass: m.errorRate <= thresholdCfg.errorRate.max + Math.abs(policy.maxRegression),
          actual: (m.errorRate * 100).toFixed(1) + '%',
          threshold: ((thresholdCfg.errorRate.max + Math.abs(policy.maxRegression)) * 100).toFixed(1) + '%',
        })

        // 5. Latency multiplier must stay within bounds.
        checks.push({
          gate: 'latency_multiplier',
          pass: latencyRatio <= policy.maxLatencyMultiplier,
          actual: latencyRatio.toFixed(2) + 'x',
          threshold: policy.maxLatencyMultiplier + 'x',
        })

        // 6. Candidate must not be worse than the active version under the
        //    same trusted evaluation.  Skipped when there is no comparable
        //    active baseline (first-ever version, or no live benchmark on
        //    the active module).  Tie with active = reject (monotonicity).
        if (activeMetrics) {
          const activeSuccessRate = activeMetrics.successRate
          checks.push({
            gate: 'beats_active',
            pass: m.successRate > activeSuccessRate,
            actual: (m.successRate * 100).toFixed(1) + '%',
            threshold: (activeSuccessRate * 100).toFixed(1) + '% (must exceed active version)',
          })
        }

        const failedChecks = checks.filter(c => !c.pass)
        const promote = failedChecks.length === 0

        return neutralizeDeep({
          ok: true,
          candidateId,
          recommendation: promote ? 'PROMOTE' : 'REJECT',
          evidenceMode,
          benchmarkRunId: latest.id,
          thresholds: thresholdCfg,
          parentVersion: candidate.parentVersion,
          metrics: m,
          deltas: {
            successDelta: parseFloat(successDelta.toFixed(4)),
            errorDelta: parseFloat(errorDelta.toFixed(4)),
            latencyRatio: parseFloat(latencyRatio.toFixed(4)),
          },
          checks,
          rejectionReasons: failedChecks.map(c => c.gate + ': ' + c.actual + ' (required ' + c.threshold + ')'),
          passed: promote,
          details: promote
            ? 'All policy gates passed. Candidate is eligible for promotion.'
            : 'Policy gates failed: ' + failedChecks.map(c => c.gate).join(', '),
        })
      },
    } as never),
  ]
}
