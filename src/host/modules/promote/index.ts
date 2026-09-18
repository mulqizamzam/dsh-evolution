import { registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps, Version, CandidateModule } from '../../types.ts'
import { promoteTools } from './tools.ts'

export const name = 'promote'
export const TOOLS = ['evo_promote', 'evo_rollback', 'evo_promote_list', 'evo_promote_decision'] as const
export const readEndpoints = {}
export const writeEndpoints = {}

/**
 * Shared promotion execution: creates the new Version with captured
 * activeMetrics, updates the candidate to 'promoted', rewrites the
 * artifact if the store-assigned id differs from the probe id, and
 * refreshes the in-memory activation state.
 *
 * This must be called by ALL production promotion paths so that the
 * comparative `beats_active` gate (enforced in evo_promote_decision
 * before this function is reached) is never bypassed.
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

  // Capture the current active version's latest benchmark metrics so the
  // new Version record carries a baseline for future promotion cycles.
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
