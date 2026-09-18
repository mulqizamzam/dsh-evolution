import { registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps, Version, CandidateModule } from '../../types.ts'
import { promoteTools } from './tools.ts'

export const name = 'promote'
export const TOOLS = ['evo_promote', 'evo_rollback', 'evo_promote_list', 'evo_promote_decision'] as const
export const readEndpoints = {}
export const writeEndpoints = {}

/**
 * Shared promotion execution: enforces the comparative `beats_active` gate
 * before creating the new Version, then captures activeMetrics for
 * provenance, updates the candidate to 'promoted', rewrites the artifact if
 * the store-assigned id differs from the probe id, and refreshes the
 * in-memory activation state.
 *
 * This is the single authoritative promotion boundary: ALL production
 * promotion paths (manual evo_promote and autonomous evo_full_cycle) must
 * call this function. The gate here ensures that no path can promote a
 * candidate that is worse than or equal to the active version.
 */
export async function runPromotionPolicy(
  deps: ModuleDeps,
  candidate: CandidateModule,
  reason: string,
  plannedVersionId: string,
): Promise<{ ok: true; version: Version } | { ok: false; error: string }> {
  const store = deps.store
  const { materializeArtifact } = await import('../activation/artifact.ts')
  const { refreshActivation, activationState } = await import('../activation/loader.ts')

  // ── beats_active gate (comparative promotion safety) ──
  // Find the active version's latest live benchmark metrics to compare
  // the candidate against.  Skipped when there is no comparable active
  // baseline (first-ever version, or no live benchmark on the active
  // module).  Tie with active = reject (monotonicity).
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

  // Find the candidate's latest live benchmark metrics.
  const allCandidateBenchmarks = await store.listBenchmarks(500)
  const candidateBenchmarks = allCandidateBenchmarks
    .filter(b => b.candidateId === candidate.id)
    .sort((a, b) => a.createdAt > b.createdAt ? -1 : 1)
  const candidateLatest = candidateBenchmarks[0]

  if (capturedActiveMetrics && candidateLatest && candidateLatest.mode !== 'simulated') {
    const activeSuccessRate = capturedActiveMetrics.successRate
    const candidateSuccessRate = candidateLatest.metrics.successRate
    if (candidateSuccessRate <= activeSuccessRate) {
      return {
        ok: false,
        error: `beats_active gate failed: candidate success rate ${(candidateSuccessRate * 100).toFixed(1)}% is not greater than active version ${(activeSuccessRate * 100).toFixed(1)}%`,
      }
    }
  }

  const version = await store.createVersion({
    label: candidate.name,
    reason,
    promotedFrom: candidate.parentVersion,
    modules: [candidate.id],
    activeMetrics: capturedActiveMetrics,
  })
  await store.updateCandidate(candidate.id, { status: 'promoted' })

  // The store may assign a different id than the probe used; make the
  // mounted artifact match the real active version.
  if (version.id !== plannedVersionId) {
    await materializeArtifact(store.getRoot(), version, candidate)
  }
  await refreshActivation(deps)

  return { ok: true, version }
}

export function apply(deps: ModuleDeps): void {
  for (const tool of promoteTools(deps)) {
    registerToolSafe(deps.ctx, tool as never)
  }
}
