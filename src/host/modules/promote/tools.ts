import { JSON_OBJECT_OUTPUT, defineTool, text } from '../../dsh.ts'
import type { ModuleDeps, ToolDefinition } from '../../types.ts'
import { DEFAULT_PROMOTION_POLICY } from '../../types.ts'
import { clampText } from '../../../lib/caps.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'
import { evaluatePromotionPolicy, executePromotion } from './index.ts'
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
        // Verify evidence trust boundary: candidate's latest benchmark must be live.
        // Simulated evidence cannot promote (contract C-1, docs/CONTRACTS.md) —
        // this closes the trust boundary gap.
        const allBenchmarks = await store.listBenchmarks(500)
        const candidateBenchmarks = allBenchmarks
          .filter(b => b.candidateId === candidateId)
          .sort((a, b) => a.createdAt > b.createdAt ? -1 : 1)
        const latestEvidence = candidateBenchmarks[0]
        if (!latestEvidence || latestEvidence.mode !== 'live') {
          return neutralizeDeep({
            ok: false,
            error: 'candidate has no live benchmark evidence; run evo_benchmark_live or evo_benchmark_ab before promoting (simulated evidence cannot promote)',
          })
        }
        // ── Step 1: Policy evaluation (pure read, no state mutation) ──
        // This is the authoritative beats_active gate. If it fails, NO version
        // record is created, NO artifact is materialized, and NO activation
        // state changes. The currently active version/tool remains untouched.
        const policyResult = await evaluatePromotionPolicy(deps, candidate)
        if (!policyResult.ok) {
          return neutralizeDeep({ ok: false, error: policyResult.error })
        }

        // ── Step 2: Compute the version id that executePromotion will create ──
        const versionNumber = (await store.listVersions(200)).reduce((max, v) => Math.max(max, v.number), 0) + 1
        const plannedVersionId = 'v' + String(versionNumber)

        // ── Step 3: Pre-flight (static validation + sandbox execution) BEFORE
        //           any store mutation. A broken candidate must NOT create a
        //           Version record or change activation state. ──
        const { materializeArtifact, validateArtifact } = await import('../activation/artifact.ts')
        const { activateVersion, activationState } = await import('../activation/loader.ts')

        // Materialize under the planned id first (pre-flight needs the artifact).
        // The composition base is the currently active version: its complete
        // artifact file tree is preserved and the candidate's files/tests
        // overlay it.  Missing candidate files never delete base files.
        const activeBeforeMaterialize = await store.getActiveVersion()
        let manifest: { toolName: string } | null = null
        try {
          manifest = await materializeArtifact(store.getRoot(), {
            id: plannedVersionId,
            number: versionNumber,
            label: candidate.name,
            createdAt: new Date().toISOString(),
            status: 'active',
            modules: [candidate.id],
          }, candidate, { baseVersionId: activeBeforeMaterialize?.id ?? null })
        } catch (error) {
          return neutralizeDeep({ ok: false, error: 'could not materialize the version artifact: ' + String(error instanceof Error ? error.message : error) })
        }

        const validation = await validateArtifact(store.getRoot(), plannedVersionId)
        if (!validation.valid) {
          return neutralizeDeep({ ok: false, error: 'version artifact did not validate', errors: validation.errors })
        }

        // Run pre-flight (sandbox syntax check + test command).
        // If this fails, the candidate is rejected — no Version is created.
        const probe = await activateVersion(deps, plannedVersionId)
        if (probe === null) {
          return neutralizeDeep({
            ok: false,
            error: 'candidate refused by activation pre-flight; version not created',
            activationReason: activationState().reason,
          })
        }

        // ── Step 3b: materialization succeeded under the planned id — the
        // composed artifact (base ∪ candidate) already exists there.
        // No rollback of base materialization is needed on validate/pre-flight
        // failure: the planned directory is an unreferenced scratch that will
        // be removed or overwritten on the next attempt.

        // ── Step 4: Execute promotion (version create + candidate status + re-materialize + activation) ──
        const result = await executePromotion(
          deps,
          candidate,
          clampText(typeof a.reason === 'string' ? a.reason : '', 500),
          plannedVersionId,
          policyResult.activeMetrics,
        )

        // ── Step 5: Report activation state after executePromotion ──
        const state = activationState()

        return neutralizeDeep({
          ok: true,
          version: result.version,
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

        // Pre-validate the rollback target's artifact when it has a known artifact
        // directory.  A baseline version (modules: []) legitimately has no artifact,
        // so only reject when the version record exists AND an artifact directory
        // is expected but missing/corrupt.  When the artifact directory was never
        // created (baseline), the rollback proceeds as before: activation will
        // simply not mount a tool (modules is empty), which is safe.
        const targetVersion = await store.getVersion(versionId)
        if (!targetVersion) {
          const result = await store.rollbackVersion(versionId)
          if (!result) return neutralizeDeep({ ok: false, error: 'no version ' + versionId })
          if (result.alreadyActive) return neutralizeDeep({ ok: false, error: 'version ' + versionId + ' is already active; nothing to roll back' })
          const { refreshActivation, activationState } = await import('../activation/loader.ts')
          await refreshActivation(deps)
          const state = activationState()
          return neutralizeDeep({ ok: true, versionId, restored: result.restored.id, deactivated: result.deactivated?.id ?? null, activation: { mountedVersionId: state.activeVersionId, mountedTool: state.activeTool, reason: state.reason } })
        }
        // The target has a non-empty modules list, so it was expected to have an
        // artifact.  Validate it before mutating the store.
        if (targetVersion.modules && targetVersion.modules.length > 0) {
          const { validateArtifact } = await import('../activation/artifact.ts')
          const validation = await validateArtifact(store.getRoot(), versionId)
          if (!validation.valid) {
            return neutralizeDeep({
              ok: false,
              error: 'rollback target ' + versionId + ' has an invalid artifact: ' + validation.errors.join('; '),
              validationErrors: validation.errors,
            })
          }
        }

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
          restored: result.restored.id,
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
          // modules[0] may be a full candidate object (test fixtures, non-normal
          // paths); coerce to a string id for the benchmark filter below.
          const rawId = activeVersion.modules[0]
          const activeModuleId = (typeof rawId === 'object' && rawId !== null && 'id' in rawId)
            ? String((rawId as { id: unknown }).id)
            : String(rawId)
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
