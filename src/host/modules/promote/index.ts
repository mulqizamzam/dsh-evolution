import { join } from 'node:path'
import { registerToolSafe } from '../../dsh.ts'
import { isSafeKey } from '../../../lib/ids.ts'
import { createLiveProvenance, verifyLiveProvenance } from '../../../lib/provenance.ts'
import type { ModuleDeps, Version, CandidateModule } from '../../types.ts'
import { promoteTools } from './tools.ts'

export const name = 'promote'
export const TOOLS = ['evo_promote', 'evo_rollback', 'evo_promote_list', 'evo_promote_decision'] as const
export const readEndpoints = {}
export const writeEndpoints = {}

/**
 * Evaluate the comparative `beats_active` gate for a candidate against the
 * currently active version. Returns the captured active metrics (for
 * provenance) on success, or null when the gate is skipped (first version
 * or no comparable live benchmark).
 *
 * Returns { ok: false, error } when the candidate fails the gate.
 *
 * This is a PURE evaluation: it reads store state and returns a decision
 * without creating any Version, updating any Candidate, or touching
 * activation state. Callers must perform the mutation steps only when
 * this returns ok:true.
 */
export async function evaluatePromotionPolicy(
  deps: ModuleDeps,
  candidate: CandidateModule,
): Promise<{ ok: true; activeMetrics: import('../../types.ts').BenchmarkMetrics | undefined } | { ok: false; error: string }> {
  const store = deps.store

  // ── beats_active gate (comparative promotion safety) ──
  // Find the active version's latest live benchmark metrics to compare
  // the candidate against.  Skipped when there is no comparable active
  // baseline (first-ever version, or no live benchmark on the active
  // module).  Tie with active = reject (monotonicity).
  const activeBeforePromote = await store.getActiveVersion()
  let capturedActiveMetrics: import('../../types.ts').BenchmarkMetrics | undefined
  let activeModuleBenchRecord: import('../../types.ts').BenchmarkRun | undefined
  if (activeBeforePromote?.modules?.length) {
    const activeModuleId = activeBeforePromote.modules[0]
    const allBenches = await store.listBenchmarks(500)
    const activeModuleBenches = allBenches
      .filter(b => b.candidateId === activeModuleId)
      .sort((x, y) => x.createdAt > y.createdAt ? -1 : 1)
    activeModuleBenchRecord = activeModuleBenches[0]
    if (activeModuleBenchRecord) {
      capturedActiveMetrics = activeModuleBenchRecord.metrics
    }
  }

  // Find the candidate's latest live benchmark metrics.
  const allCandidateBenchmarks = await store.listBenchmarks(500)
  const candidateBenchmarks = allCandidateBenchmarks
    .filter(b => b.candidateId === candidate.id)
    .sort((a, b) => a.createdAt > b.createdAt ? -1 : 1)
  const candidateLatest = candidateBenchmarks[0]

  // Reject: candidate's best evidence is simulated while active version has live evidence.
  // A candidate with only simulated evidence cannot promote when a live-active baseline exists.
  if (capturedActiveMetrics && candidateLatest && candidateLatest.mode === 'simulated') {
    return {
      ok: false,
      error: `promotion rejected: candidate has only simulated evidence (mode=simulated); run evo_benchmark_live or evo_benchmark_ab to produce execution evidence before promoting`,
    }
  }

  if (capturedActiveMetrics && candidateLatest && candidateLatest.mode !== 'simulated') {
    // Live records must carry a valid provenance seal when an active
    // baseline exists.  This closes the unsealed-record forgery bypass
    // (attacker flips mode='simulated'→'live' without adding a seal).
    //
    // Pre-seal records (no provenance field) from before M3.3 are tolerated
    // only when the active baseline's own record is also unsealed — in that
    // case neither side can be verified by seal and the gate falls back to
    // the beats_active comparison.  This preserves backward compatibility
    // for state roots created before the provenance mechanism was introduced.
    if (candidateLatest.mode === 'live') {
      const candidateSealed = candidateLatest.provenance !== undefined
      const activeSealed = capturedActiveMetrics !== undefined && (activeModuleBenchRecord?.provenance ?? undefined) !== undefined

      if (candidateSealed || activeSealed) {
        // At least one side is sealed → the seal check applies.
        if (!verifyLiveProvenance(candidateLatest)) {
          return {
            ok: false,
            error: candidateLatest.provenance
              ? 'benchmark provenance seal mismatch: evidence may have been tampered'
              : 'live benchmark provenance seal missing: record may have been forged; re-run evo_benchmark_live or evo_benchmark_ab to generate valid evidence',
          }
        }
      }
    }
    const activeSuccessRate = capturedActiveMetrics.successRate
    const candidateSuccessRate = candidateLatest.metrics.successRate
    if (candidateSuccessRate <= activeSuccessRate) {
      return {
        ok: false,
        error: `beats_active gate failed: candidate success rate ${(candidateSuccessRate * 100).toFixed(1)}% is not greater than active version ${(activeSuccessRate * 100).toFixed(1)}%`,
      }
    }
  }

  return { ok: true, activeMetrics: capturedActiveMetrics }
}

/**
 * Execute the full promotion after the policy gate has passed.
 * Creates the Version record, updates the Candidate status, materializes
 * the artifact (if needed), and refreshes activation.
 */
export async function executePromotion(
  deps: ModuleDeps,
  candidate: CandidateModule,
  reason: string,
  plannedVersionId: string,
  capturedActiveMetrics: import('../../types.ts').BenchmarkMetrics | undefined,
): Promise<{ ok: true; version: Version }> {
  const store = deps.store
  // plannedVersionId becomes a path component under versions/ (access + rm);
  // every current caller computes it as `v<n>`, so anything else is refused
  // before it can direct a filesystem operation.
  if (plannedVersionId !== '' && !isSafeKey(plannedVersionId)) {
    throw new Error('invalid planned version id: ' + JSON.stringify(String(plannedVersionId)))
  }
  const { materializeArtifact, validateArtifact } = await import('../activation/artifact.ts')
  const { refreshActivation } = await import('../activation/loader.ts')

  // ── Safe ordering: materialize + validate artifact BEFORE any store mutation ──
  // createVersion writes to persisted state (marks old active as rolled-back,
  // writes new version record).  If the artifact cannot be materialized or
  // validated, the version record must not be created — so no persisted state
  // can ever claim a version whose artifact does not exist.
  //
  // When plannedVersionId is non-empty AND matches what createVersion will
  // assign, the evo_promote pre-flight has already materialized the artifact
  // under that id.  In that case we only need to re-validate before proceeding.
  const { access } = await import('node:fs/promises')
  const manifestPath = join(store.getRoot(), 'versions', plannedVersionId, 'manifest.json')
  const artifactPreExists = plannedVersionId !== '' &&
    (await access(manifestPath).then(() => true).catch(() => false))

  let versionNumber: number
  if (artifactPreExists) {
    // Pre-flight already materialized under plannedVersionId.
    // Derive the version number from the planned id (the store has no record yet
    // because we deliberately defer createVersion until after materialization).
    const match = /^v(\d+)$/.exec(plannedVersionId)
    versionNumber = match ? parseInt(match[1], 10) : 0
  } else {
    // Compute the next version number the same way createVersion does.
    const versions = await store.listVersions(200)
    versionNumber = versions.length === 0 ? 1 : Math.max(...versions.map(v => v.number)) + 1
    // Materialize first, then validate.  If this throws or fails, no version
    // record is created — the previously active version remains intact.
    // Clean up any partial artifact from a previous failed attempt (e.g. a
    // v2 dir left behind when validateArtifact threw after materialization).
    const probeVersion = {
      id: 'v' + String(versionNumber),
      number: versionNumber,
      label: candidate.name,
      createdAt: new Date().toISOString(),
      status: 'active' as const,
      modules: [candidate.id],
    }
    const { rm } = await import('node:fs/promises')
    await rm(join(store.getRoot(), 'versions', probeVersion.id), { recursive: true, force: true })
    await materializeArtifact(store.getRoot(), probeVersion, candidate)
    const validation = await validateArtifact(store.getRoot(), probeVersion.id)
    if (!validation.valid) {
      // Clean up the orphaned artifact directory so it does not leak disk space.
      const { rm } = await import('node:fs/promises')
      await rm(join(store.getRoot(), 'versions', probeVersion.id), { recursive: true, force: true })
      throw new Error('version artifact did not validate: ' + validation.errors.join('; '))
    }
  }

  // ── Now it is safe to mutate persisted state ──
  const version = await store.createVersion({
    label: candidate.name,
    reason,
    promotedFrom: candidate.parentVersion,
    modules: [candidate.id],
    activeMetrics: capturedActiveMetrics,
  })
  await store.updateCandidate(candidate.id, { status: 'promoted' })

  // If the real version id differs from what was materialized, re-materialize
  // under the correct id.  This is the fallback path for callers that passed
  // an empty plannedVersionId (e.g. legacy runPromotionPolicy from evo_full_cycle).
  const { rm } = await import('node:fs/promises')
  const expectedArtifactPath = join(store.getRoot(), 'versions', version.id)
  const artifactAtRealId = await access(join(expectedArtifactPath, 'manifest.json')).then(() => true).catch(() => false)
  if (!artifactAtRealId && version.id !== plannedVersionId) {
    await materializeArtifact(store.getRoot(), version, candidate)
  }
  await refreshActivation(deps)

  return { ok: true, version }
}

/**
 * Backward-compatible wrapper that combines evaluate + execute in one call.
 * Used by evolution/tools.ts (evo_full_cycle).
 *
 * The policy gate runs first; if it passes, the mutation (version create,
 * candidate status update, artifact materialize, activation refresh) follows.
 * If the policy gate fails, NO version or candidate mutation occurs.
 */
export async function runPromotionPolicy(
  deps: ModuleDeps,
  candidate: CandidateModule,
  reason: string,
  plannedVersionId: string,
): Promise<{ ok: true; version: Version } | { ok: false; error: string }> {
  const evaluation = await evaluatePromotionPolicy(deps, candidate)
  if (!evaluation.ok) return evaluation

  const { ok, version } = await executePromotion(deps, candidate, reason, plannedVersionId, evaluation.activeMetrics)
  return { ok, version }
}

export function apply(deps: ModuleDeps): void {
  for (const tool of promoteTools(deps)) {
    registerToolSafe(deps.ctx, tool as never)
  }
}
