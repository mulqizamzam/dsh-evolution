import { join } from 'node:path'
import { registerToolSafe } from '../../dsh.ts'
import { isSafeKey } from '../../../lib/ids.ts'
import { createLiveProvenance, verifyLiveProvenance } from '../../../lib/provenance.ts'
import type { ModuleDeps, Version, CandidateModule } from '../../types.ts'
import { promoteTools } from './tools.ts'
import { evaluateRedTeamPromotionGate, redTeamGateError, type RedTeamGateReport } from './red-team.ts'

export const name = 'promote'
export const TOOLS = ['evo_promote', 'evo_rollback', 'evo_promote_list', 'evo_promote_decision'] as const
export const readEndpoints = {}
export const writeEndpoints = {}

/**
 * Evaluate the promotion policy for a candidate. This is the SINGLE policy
 * authority for every promotion path — `evo_promote` and `evo_full_cycle` both
 * route through here, so a rule enforced here is enforced everywhere.
 *
 * Two gates, in order:
 *
 *  1. **Evidence gate** — a candidate whose latest benchmark record has
 *     `mode === 'simulated'` is rejected unconditionally, including when no
 *     active version exists. Ratified as contract C-1 in `docs/CONTRACTS.md`.
 *  2. **Comparative gate (`beats_active`)** — the candidate's live metrics must
 *     strictly beat the active version's. Returns the captured active metrics
 *     (for provenance) on success, or `undefined` when the gate is skipped
 *     because there is no comparable active baseline (first version, or no
 *     benchmark on the active module). Tie with active = reject (monotonicity).
 *
 * Returns { ok: false, error } when the candidate fails either gate.
 *
 * This is a PURE evaluation: it reads store state and returns a decision
 * without creating any Version, updating any Candidate, or touching
 * activation state. Callers must perform the mutation steps only when
 * this returns ok:true.
 */
export async function evaluatePromotionPolicy(
  deps: ModuleDeps,
  candidate: CandidateModule,
): Promise<
  | { ok: true; activeMetrics: import('../../types.ts').BenchmarkMetrics | undefined; redTeamGate: RedTeamGateReport }
  | { ok: false; error: string; redTeamGate: RedTeamGateReport }
> {
  const store = deps.store
  // Read the candidate evidence once and pass that exact snapshot to the gate,
  // avoiding a second read between integrity validation and policy evaluation.
  const candidateLatest = (await store.listBenchmarksByCandidate(candidate.id, true))[0]
  // This is the shared fail-closed gate for manual and automatic promotion.
  // INCONCLUSIVE is deliberately not promotable.
  const redTeamGate = await evaluateRedTeamPromotionGate(deps, candidate, candidateLatest ?? null)
  if (redTeamGate.verdict !== 'PASS') {
    return { ok: false, error: redTeamGateError(redTeamGate), redTeamGate }
  }

  // ── beats_active gate (comparative promotion safety) ──
  // Find the active version's latest live benchmark metrics to compare
  // the candidate against.  Skipped when there is no comparable active
  // baseline (first-ever version, or no live benchmark on the active
  // module).  Tie with active = reject (monotonicity).
  const activeBeforePromote = await store.getActiveVersion()
  let capturedActiveMetrics: import('../../types.ts').BenchmarkMetrics | undefined
  let activeModuleBenchRecord: import('../../types.ts').BenchmarkRun | undefined
  // A missing record and a record outside listBenchmarks()'s newest-N window
  // must not look alike: the gates below are nested behind
  // `capturedActiveMetrics`, so a windowed lookup silently disabled both the
  // comparative check and the provenance-seal check once the state root grew.
  if (activeBeforePromote?.modules?.length) {
    const activeModuleId = activeBeforePromote.modules[0]
    activeModuleBenchRecord = (await store.listBenchmarksByCandidate(activeModuleId, true))[0]
    if (activeModuleBenchRecord) {
      capturedActiveMetrics = activeModuleBenchRecord.metrics
    }
  }

  // candidateLatest is the exact record snapshot that passed the Red Team gate.

  // Reject: candidate's most recent evidence is simulated.
  //
  // Per contract C-1 (docs/CONTRACTS.md), simulated evidence is rejected
  // UNCONDITIONALLY — including when no active version exists. The fresh-root
  // case is precisely why: without this the very first promoted version, which
  // becomes the baseline every later beats_active comparison is measured
  // against, would be installed from evidence that was never executed.
  //
  // This condition is deliberately not gated on `capturedActiveMetrics`.
  if (candidateLatest && candidateLatest.mode === 'simulated') {
    return {
      ok: false,
      error: `promotion rejected: candidate has only simulated evidence (mode=simulated); run evo_benchmark_live or evo_benchmark_ab to produce execution evidence before promoting`,
      redTeamGate,
    }
  }

  if (capturedActiveMetrics && candidateLatest && candidateLatest.mode !== 'simulated') {
    // The Red Team gate has already required valid candidate provenance.
    // Keep this defensive check adjacent to the comparative decision as well.
    if (candidateLatest.mode === 'live' && !verifyLiveProvenance(candidateLatest)) {
      return {
        ok: false,
        error: 'provenance consistency mismatch: stored seal does not match the record fields; re-run evo_benchmark_live or evo_benchmark_ab to generate valid evidence',
        redTeamGate,
      }
    }
    const activeSuccessRate = capturedActiveMetrics.successRate
    const candidateSuccessRate = candidateLatest.metrics.successRate
    if (candidateSuccessRate <= activeSuccessRate) {
      return {
        ok: false,
        error: `beats_active gate failed: candidate success rate ${(candidateSuccessRate * 100).toFixed(1)}% is not greater than active version ${(activeSuccessRate * 100).toFixed(1)}%`,
        redTeamGate,
      }
    }
  }

  return { ok: true, activeMetrics: capturedActiveMetrics, redTeamGate }
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

  // ── Resolve the composition base BEFORE any store mutation ──
  // The candidate is promoted on top of the currently active version (A).
  // Reading the active version before createVersion guarantees A is the base
  // even for the re-materialization fallback that runs AFTER createVersion.
  const baseVersionForComposition = await store.getActiveVersion()
  const baseVersionId: string | null | undefined = baseVersionForComposition?.id

  // ── Safe ordering: materialize + validate artifact BEFORE any store mutation ──
  // createVersion writes to persisted state (marks old active as rolled-back,
  // writes new version record).  If the artifact cannot be materialized or
  // validated, the version record must not be created — so no persisted state
  // can ever claim a version whose artifact does not exist.
  //
  // When plannedVersionId is non-empty AND matches what createVersion will
  // assign, the evo_promote pre-flight has already materialized the artifact
  // under that id.  In that case we only need to re-validate before proceeding.
  const { access, rm } = await import('node:fs/promises')
  let materializedVersionId = plannedVersionId
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
    materializedVersionId = probeVersion.id
    await rm(join(store.getRoot(), 'versions', probeVersion.id), { recursive: true, force: true })
    await materializeArtifact(store.getRoot(), probeVersion, candidate, { baseVersionId })
    const validation = await validateArtifact(store.getRoot(), probeVersion.id)
    if (!validation.valid) {
      // Clean up the orphaned artifact directory so it does not leak disk space.
      await rm(join(store.getRoot(), 'versions', probeVersion.id), { recursive: true, force: true })
      throw new Error('version artifact did not validate: ' + validation.errors.join('; '))
    }
  }

  // Re-evaluate immediately before persisted state mutation. This closes the
  // pre-flight window in which benchmark evidence or the active baseline could
  // have changed after the initial policy decision.
  const finalPolicy = await evaluatePromotionPolicy(deps, candidate)
  if (!finalPolicy.ok) {
    await rm(join(store.getRoot(), 'versions', materializedVersionId), { recursive: true, force: true })
    throw new Error('promotion aborted by final Red Team/policy recheck: ' + finalPolicy.error)
  }
  capturedActiveMetrics = finalPolicy.activeMetrics

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
  // under the correct id. This is the fallback path for callers that passed an
  // empty plannedVersionId (e.g. legacy runPromotionPolicy from evo_full_cycle).
  const expectedArtifactPath = join(store.getRoot(), 'versions', version.id)
  const artifactAtRealId = await access(join(expectedArtifactPath, 'manifest.json')).then(() => true).catch(() => false)
  if (!artifactAtRealId && version.id !== plannedVersionId) {
    await materializeArtifact(store.getRoot(), version, candidate, { baseVersionId })
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
): Promise<
  | { ok: true; version: Version; redTeamGate: RedTeamGateReport }
  | { ok: false; error: string; redTeamGate: RedTeamGateReport }
> {
  const evaluation = await evaluatePromotionPolicy(deps, candidate)
  if (!evaluation.ok) return evaluation

  const { ok, version } = await executePromotion(deps, candidate, reason, plannedVersionId, evaluation.activeMetrics)
  return { ok, version, redTeamGate: evaluation.redTeamGate }
}

export function apply(deps: ModuleDeps): void {
  for (const tool of promoteTools(deps)) {
    registerToolSafe(deps.ctx, tool as never)
  }
}
