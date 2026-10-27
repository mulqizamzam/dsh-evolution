import { registerToolSafe, JSON_OBJECT_OUTPUT, text } from '../../dsh.ts'
import type { ModuleDeps, ToolDefinition } from '../../types.ts'
import type { HostSessionEvent, HostSessionView, ObservedTurn } from '../../types.ts'
import { detectPatterns, detectVersionDegradation } from '../analyze/tools.ts'
import type { VersionDegradationSignal } from '../analyze/tools.ts'
import { clampText } from '../../../lib/caps.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'
import { activationState } from '../activation/loader.ts'

export const name = 'auto-experience'
export const TOOLS = ['evo_auto_record', 'evo_observe_state'] as const
export const readEndpoints = {}
export const writeEndpoints = {}

const RENDER = (_a: Record<string, unknown>, v: never): Array<{ type: 'text'; text: string }> => text(v)

/** Extract plain text from model-facing content blocks, skipping non-text. */
function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const value = (block as { text?: unknown }).text
      if (typeof value === 'string') parts.push(value)
    }
  }
  return parts.join('\n')
}

/**
 * Project one completed turn onto an experience record using the REAL host
 * contract: `turn/end` carries only `{ turn, reason }`, so everything else is
 * derived from the session log the listener also receives.
 */
export function observeTurn(session: HostSessionView, event: HostSessionEvent): ObservedTurn | null {
  if (event.type !== 'turn/end') return null
  const turn = typeof event.data.turn === 'number' ? event.data.turn : -1
  const reason = (event.data.reason ?? {}) as { kind?: string; error?: { message?: string } }
  const events = Array.isArray(session.events) ? session.events : []

  let promptText = ''
  let stepCount = 0
  let turnStartTime = event.time
  const toolCallNames: string[] = []

  // `turn/start` and `turn/end` carry `data.turn`, but surface events such as
  // `user/message` do not. Bracket the turn by sequence position instead of
  // assuming every event names its turn.
  let inTurn = false
  for (const item of events) {
    const itemTurn = typeof item.data?.turn === 'number' ? item.data.turn : undefined

    if (item.type === 'turn/start') {
      inTurn = itemTurn === turn
      if (inTurn) turnStartTime = item.time
      continue
    }
    if (item.type === 'turn/end') {
      if (itemTurn === turn) break
      inTurn = false
      continue
    }
    if (!inTurn) continue

    if (item.type === 'step/start') {
      stepCount += 1
    } else if (item.type === 'user/message') {
      const source = item.data?.source as { kind?: string } | undefined
      // Prefer the human prompt: injected plugin context must not masquerade
      // as the task description.
      if (source?.kind === 'user') promptText = textFromContent(item.data?.content)
    } else if (item.type === 'tool/call') {
      const toolName = item.data?.name
      if (typeof toolName === 'string' && toolCallNames.length < 64) toolCallNames.push(toolName)
    }
  }

  const reasonKind = typeof reason.kind === 'string' ? reason.kind : 'unknown'
  const success = reasonKind === 'completed'
  const errors: string[] = []
  if (reasonKind === 'error') {
    const message = reason.error?.message
    errors.push(typeof message === 'string' && message !== '' ? clampText(message, 500) : 'turn failed')
  } else if (reasonKind === 'aborted') {
    errors.push('turn aborted')
  } else if (reasonKind === 'blocked') {
    errors.push('turn blocked')
  } else if (reasonKind === 'max-tokens') {
    errors.push('step reached output-token ceiling')
  }

  return {
    sessionId: typeof session.header?.id === 'string' ? session.header.id : 'unknown-session',
    turn,
    prompt: promptText === '' ? undefined : clampText(promptText, 2000),
    success,
    reasonKind,
    errors: errors.length > 0 ? errors : undefined,
    stepCount,
    durationMs: Math.max(0, event.time - turnStartTime),
    toolCallNames,
  }
}

/**
 * Autonomous loop guards, one per host process. These bound the loop so a
 * misconfiguration cannot spin: a single in-flight cycle, a hard per-process
 * cycle cap, and a re-analysis interval measured in NEW experiences.
 */
const guards = {
  inFlight: false,
  cyclesRun: 0,
  lastCycleExperienceCount: -1,
  /** Timestamp of the last productive cycle (ms since epoch). Used for debounce. */
  lastCycleAt: 0,
}

export function resetAutoGuards(): void {
  guards.inFlight = false
  guards.cyclesRun = 0
  guards.lastCycleExperienceCount = -1
  guards.lastCycleAt = 0
}

export function autoGuardState(): { inFlight: boolean; cyclesRun: number; lastCycleExperienceCount: number; lastCycleAt: number } {
  return { ...guards }
}

export interface AutoCycleOutcome {
  ran: boolean
  reason: string
  patterns?: number
  candidateId?: string
  verdict?: string
}

/** Deterministic description for a synthetic degradation pattern. */
function synthDegradationDescription(versionId: string, signals: string[]): string {
  return 'Degradation ' + versionId + ': ' + signals.join('; ')
}

/**
 * Determine whether a candidate for the given degradation context already
 * exists in a non-terminal status. Returns true if it does.
 */
async function degradationCandidateExists(deps: ModuleDeps, desc: string): Promise<boolean> {
  const candidates = await deps.store.listCandidates(500)
  return candidates.some(c => c.description === desc && c.status !== 'promoted' && c.status !== 'rejected')
}

/**
 * Determine whether a synthetic pattern with the given description already
 * exists in the store. Returns true if it does.
 */
async function syntheticPatternExists(deps: ModuleDeps, desc: string): Promise<boolean> {
  const patterns = await deps.store.listPatterns(500)
  return patterns.some(p => p.description === desc)
}

/**
 * Check whether the active version has a degradation signal and whether a
 * candidate for that signal already exists. Returns { versionId, evidenceIds,
 * signals, total, description } when the version is degraded and no active
 * candidate is already queued, or null otherwise.
 */
async function detectDegradationContext(
  deps: ModuleDeps,
): Promise<{ versionId: string; evidenceIds: string[]; signals: string[]; total: number; description: string } | null> {
  const active = await deps.store.getActiveVersion()
  if (!active) return null

  const records = await deps.store.listExperiencesByVersion(active.id, 500)
  if (records.length < 5) return null

  const signal = detectVersionDegradation(records)
  if (!signal || !signal.isDegraded) return null

  // Dedup: skip if a non-terminal candidate for this exact degradation already
  // exists. We check by BOTH:
  //   (a) synthetic-description match (legacy path, where candidate.description
  //       happened to equal the synthetic description — rare but possible)
  //   (b) (parentVersion, evidenceIds overlap): a candidate already generated
  //       for this version's degradation will have parentVersion === the
  //       version ID and evidenceIds drawn from the same experience set,
  //       regardless of which pattern triggered the builder call.
  const desc = synthDegradationDescription(signal.versionId, signal.signals)
  if (await degradationCandidateExists(deps, desc)) return null

  const evidenceIds = records.map(r => r.id).filter((id): id is string => typeof id === 'string')

  // (b) Non-terminal candidate check — covers candidates created through the
  //     pattern-driven path where the builder's patternIds point to a
  //     recurrence pattern, not the synthetic degradation pattern.
  //
  // We block only when the current evidence set is a SUBSET of (or equal to)
  // an existing non-terminal candidate's evidence set: no new evidence has
  // arrived since that candidate was generated. If the current evidenceIds
  // contains IDs the candidate does not have, the opportunity has materially
  // changed and a new candidate is permitted.
  const candidates = await deps.store.listCandidates(500)
  for (const c of candidates) {
    if (c.status === 'promoted' || c.status === 'rejected') continue
    if (c.parentVersion !== signal.versionId) continue
    if (!Array.isArray(c.evidenceIds) || c.evidenceIds.length === 0) continue
    const candidateSet = new Set(c.evidenceIds)
    const hasNewEvidence = evidenceIds.some(eid => !candidateSet.has(eid))
    if (!hasNewEvidence) return null
  }

  // (c) Terminal evidence-identity check — blocks re-generation when the
  //     current evidence set has already been fully consumed by a terminal
  //     (promoted or rejected) candidate for the same version. This prevents
  //     unbounded candidate churn: without this, every cycle after a
  //     rejection would generate another candidate from identical evidence.
  //
  // Any single experience ID not present in the terminal evidence set
  // unblocks: materially new evidence permits a fresh candidate.
  const terminalEvidence = new Set(
    candidates
      .filter(c => (c.status === 'promoted' || c.status === 'rejected')
               && c.parentVersion === signal.versionId
               && Array.isArray(c.evidenceIds) && c.evidenceIds.length > 0)
      .flatMap(c => c.evidenceIds!),
  )
  if (evidenceIds.every(eid => terminalEvidence.has(eid))) return null

  return {
    versionId: signal.versionId,
    evidenceIds,
    signals: signal.signals,
    total: signal.total,
    description: desc,
  }
}

/**
 * Create the synthetic degradation pattern if it does not already exist.
 * Returns the pattern id, or null if the pattern was already present.
 */
async function ensureSyntheticPattern(deps: ModuleDeps, ctx: {
  description: string; total: number; evidenceIds: string[]
}): Promise<string | null> {
  if (await syntheticPatternExists(deps, ctx.description)) return null
  const pattern = await deps.store.addPattern({
    type: 'failure',
    evidence: 'FACT',
    description: ctx.description,
    occurrences: ctx.total,
    evidenceIds: ctx.evidenceIds,
    confidence: Math.min(0.95, 0.5 + ctx.total * 0.02),
  })
  return pattern.id
}

/**
 * Run one degradation-driven synthesis when no pattern-driven patterns are
 * available. Returns a non-null outcome only when a degradation-driven
 * candidate was actually created; otherwise returns null so the caller can
 * fall through to the generic "no patterns" response.
 *
 * Retry semantics: `ensureSyntheticPattern` persists the synthetic pattern
 * even when generation later fails. That is intentional — it preserves
 * provenance. The pattern is NOT a terminal dedup marker: a failed or
 * rejected candidate does not permanently consume the degradation
 * opportunity. The next cycle re-attempts generation using the existing
 * pattern; a new candidate is only created if one is not already in flight
 * or terminal (enforced by `degradationCandidateExists` inside
 * `detectDegradationContext`).
 */
async function detectDegradationAndSynthesize(deps: ModuleDeps): Promise<AutoCycleOutcome | null> {
  const cfg = deps.cfg().evolution
  const ctx = await detectDegradationContext(deps)
  if (!ctx) return null

  const genEnabled = cfg.generation.enabled
  const patternId = await ensureSyntheticPattern(deps, ctx)

  if (!genEnabled) {
    return { ran: true, reason: 'degradation detected; generation disabled', patterns: patternId !== null ? 1 : 0, candidateId: undefined }
  }

  // Resolve a pattern ID for the builder. If the synthetic pattern already
  // exists from a prior failed attempt, reuse it; the builder still needs a
  // valid pattern ID to anchor evidence lineage.
  let resolvedPatternId = patternId
  if (resolvedPatternId === null) {
    const patterns = await deps.store.listPatterns(500)
    const existing = patterns.find(p => p.description === ctx.description)
    if (!existing) {
      // Defensive: should not happen after ensureSyntheticPattern ran, but
      // guard against a race that deleted the pattern between the two calls.
      return { ran: true, reason: 'degradation detected; pattern not found', patterns: 0 }
    }
    resolvedPatternId = existing.id
  }

  // Delegate to the same builder pipeline as pattern-driven generation.
  // The builder reads pattern.evidenceIds (experience IDs) and uses
  // patternIds for attribution — both stay correct for synthetic patterns.
  const { builderTools } = await import('../builder/tools.ts')
  const build = builderTools(deps).find(t => t.name === 'evo_builder_generate')
  if (!build) {
    return { ran: true, reason: 'builder unavailable', patterns: 1 }
  }

  const built = await build.execute({
    patternIds: [resolvedPatternId],
    parentVersion: ctx.versionId,
  } as never, { signal: AbortSignal.timeout(180_000) }) as { ok?: boolean; candidateId?: string; error?: string }

  if (built?.ok !== true || typeof built.candidateId !== 'string') {
    return { ran: true, reason: 'generation failed: ' + String(built?.error ?? 'unknown'), patterns: patternId !== null ? 1 : 0 }
  }

  if (!cfg.promotion.enabled) {
    return { ran: true, reason: 'candidate generated; promotion disabled', patterns: patternId !== null ? 1 : 0, candidateId: built.candidateId }
  }

  const { promoteTools } = await import('../promote/tools.ts')
  const decision = promoteTools(deps).find(t => t.name === 'evo_promote_decision')
  if (!decision) {
    return { ran: true, reason: 'promote module unavailable', patterns: patternId !== null ? 1 : 0 }
  }

  const verdict = await decision.execute({ candidateId: built.candidateId } as never, { signal: AbortSignal.timeout(60_000) }) as {
    ok?: boolean; recommendation?: string
  }
  return {
    ran: true,
    reason: 'candidate generated and evaluated from degradation signal',
    patterns: patternId !== null ? 1 : 0,
    candidateId: built.candidateId,
    verdict: verdict?.recommendation,
  }
}

/**
 * Run analysis (and optionally generation + promotion) when enough evidence
 * exists. Deterministic host code owns every safety decision; the LLM only
 * proposes. Never throws: the caller is an event listener.
 */
export async function runAutoCycle(deps: ModuleDeps): Promise<AutoCycleOutcome> {
  const cfg = deps.cfg().evolution
  if (!cfg.enabled || !cfg.autoTrigger) return { ran: false, reason: 'auto trigger disabled' }
  if (guards.inFlight) return { ran: false, reason: 'a cycle is already running' }
  if (guards.cyclesRun >= cfg.maxCyclesPerProcess) {
    return { ran: false, reason: 'per-process cycle cap reached' }
  }
  // Debounce: skip if a productive cycle ran within the configured window.
  // This prevents rapid-fire analysis during bulk experience imports while still
  // allowing the first cycle to run immediately. Non-productive skips (not enough
  // experiences) do NOT update lastCycleAt so the next turn can retry. The window
  // is configurable so multi-cycle probes can disable it explicitly.
  const debounceMs = cfg.cycleDebounceMs
  if (debounceMs > 0 && Date.now() - guards.lastCycleAt < debounceMs) {
    return { ran: false, reason: 'debounce: last cycle ran less than ' + debounceMs + 'ms ago' }
  }

  guards.inFlight = true
  // Track whether this cycle consumed a slot so the catch block can roll it
  // back: a cycle that threw after the increment did not complete productively
  // and must not burn the per-process cap.
  let slotConsumed = false
  try {
    const experiences = await deps.store.listExperiences(cfg.analysis.minExperiences * 4)
    if (experiences.length < cfg.analysis.minExperiences) {
      return { ran: false, reason: 'not enough experiences: ' + experiences.length + ' of ' + cfg.analysis.minExperiences }
    }

    // Only re-analyze once enough NEW experiences accumulated.
    if (guards.lastCycleExperienceCount >= 0
      && experiences.length - guards.lastCycleExperienceCount < cfg.analysis.minExperiences) {
      return { ran: false, reason: 'waiting for more new experiences' }
    }

    const detected = detectPatterns(experiences, cfg.analysis.minOccurrences)
    const existing = await deps.store.listPatterns(500)
    const seen = new Set(existing.map(p => p.description))
    const pending = detected.filter(p => !seen.has(p.description))

    // Persist first: only stored patterns carry the id later stages reference.
    const fresh: Array<{ id: string; confidence: number }> = []
    for (const p of pending) {
      const storedPattern = await deps.store.addPattern(p)
      fresh.push({ id: storedPattern.id, confidence: storedPattern.confidence })
    }

    guards.lastCycleExperienceCount = experiences.length

    // Capture the active version once at the top of the cycle. A manual
    // promotion/rollback that lands mid-cycle must not silently shift
    // parentVersion to a different version.  This value is passed to every
    // downstream builder call in this cycle.
    const cycleActiveVersion = await deps.store.getActiveVersion()
    const cycleParentVersion = cycleActiveVersion ? cycleActiveVersion.id : 'v0'

    if (fresh.length === 0) {
      // No recurrence-based patterns detected; check whether the active version
      // shows degradation and synthesize a candidate from the signal.
      const degraded = await detectDegradationAndSynthesize(deps)
      if (degraded) return degraded
      return { ran: false, reason: 'no actionable recurring pattern', patterns: 0 }
    }

    guards.cyclesRun += 1
    slotConsumed = true
    // Mark the timestamp so the debounce gate can skip rapid re-runs.
    guards.lastCycleAt = Date.now()
    deps.log('auto-cycle: ' + fresh.length + ' new pattern(s) from ' + experiences.length + ' experiences')

    // If the active version is degraded, prepend a synthetic degradation
    // pattern so downstream stages can react to it independently of the
    // recurrence-based patterns. `ensureSyntheticPattern` reuses a recorded
    // pattern when the same description already exists, so this path never
    // writes a second copy of one signal.
    const degradedCtx = await detectDegradationContext(deps)
    if (degradedCtx) {
      const synthId = await ensureSyntheticPattern(deps, degradedCtx)
      if (synthId !== null) {
        fresh.unshift({ id: synthId, confidence: Math.min(0.95, 0.5 + degradedCtx.total * 0.02) })
      } else {
        // Already recorded by an earlier cycle: reuse it rather than write a
        // second copy of the same signal.
        const existing = (await deps.store.listPatterns(500)).find(p => p.description === degradedCtx.description)
        if (existing) fresh.unshift({ id: existing.id, confidence: existing.confidence })
      }
      deps.log('auto-cycle: degradation signal detected for ' + degradedCtx.versionId)
    }

    if (!cfg.generation.enabled) {
      return { ran: true, reason: 'patterns recorded; generation disabled', patterns: fresh.length }
    }

    // Generation + promotion delegate to the same deterministic pipeline the
    // manual tools use; the LLM proposes, the host decides.
    const { builderTools } = await import('../builder/tools.ts')
    const build = builderTools(deps).find(t => t.name === 'evo_builder_generate')
    if (!build) return { ran: true, reason: 'builder unavailable', patterns: fresh.length }

    const strongest = [...fresh].sort((a, b) => b.confidence - a.confidence)[0]
    // Use the version captured at cycle start (not a fresh read) so that a
    // mid-cycle promotion/rollback does not shift parentVersion.
    const built = await build.execute({
      patternIds: [strongest.id],
      parentVersion: cycleParentVersion,
    } as never, { signal: AbortSignal.timeout(180_000) }) as { ok?: boolean; candidateId?: string; error?: string }

    if (built?.ok !== true || typeof built.candidateId !== 'string') {
      return { ran: true, reason: 'generation failed: ' + String(built?.error ?? 'unknown'), patterns: fresh.length }
    }

    if (!cfg.promotion.enabled) {
      return { ran: true, reason: 'candidate generated; promotion disabled', patterns: fresh.length, candidateId: built.candidateId }
    }

    // Promotion stays deterministic: only the measured gate may promote.
    const { promoteTools } = await import('../promote/tools.ts')
    const decision = promoteTools(deps).find(t => t.name === 'evo_promote_decision')
    if (!decision) return { ran: true, reason: 'promote module unavailable', patterns: fresh.length }

    const verdict = await decision.execute({ candidateId: built.candidateId } as never, { signal: AbortSignal.timeout(60_000) }) as {
      ok?: boolean; recommendation?: string
    }
    return {
      ran: true,
      reason: 'candidate generated and evaluated',
      patterns: fresh.length,
      candidateId: built.candidateId,
      verdict: verdict?.recommendation,
    }
  } catch (error) {
    // Return the slot so a transient I/O failure cannot exhaust the cap.
    if (slotConsumed) guards.cyclesRun -= 1
    return { ran: false, reason: 'cycle failed: ' + String(error instanceof Error ? error.message : error) }
  } finally {
    guards.inFlight = false
  }
}

export function apply(deps: ModuleDeps): void {
  const store = deps.store

  const recordTool: ToolDefinition = {
    name: 'evo_auto_record',
    description: 'Record a completed agent task as an experience record. The host also records turns automatically; use this for out-of-band observations.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Optional task or session identifier.' },
        prompt: { type: 'string', description: 'The task prompt.' },
        summary: { type: 'string', description: 'Short human summary.' },
        success: { type: 'boolean', description: 'Whether the task succeeded.' },
        errors: { type: 'array', items: { type: 'string' }, description: 'Error messages encountered.' },
        durationMs: { type: 'number', description: 'Duration in milliseconds.' },
        stepCount: { type: 'number', description: 'Number of agent steps.' },
        score: { type: 'number', description: 'Optional quality score between 0 and 1.' },
      },
      required: ['success'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never) => {
      const a = (args ?? {}) as Record<string, unknown>
      const record = await store.addExperience({
        taskId: typeof a.taskId === 'string' ? a.taskId : undefined,
        prompt: typeof a.prompt === 'string' ? clampText(a.prompt, 2000) : undefined,
        summary: typeof a.summary === 'string' ? clampText(a.summary, 500) : undefined,
        success: Boolean(a.success),
        errors: Array.isArray(a.errors) ? a.errors.map(e => clampText(String(e), 500)) : undefined,
        durationMs: typeof a.durationMs === 'number' ? a.durationMs : undefined,
        stepCount: typeof a.stepCount === 'number' ? a.stepCount : undefined,
        score: typeof a.score === 'number' ? a.score : undefined,
      })
      return neutralizeDeep({ ok: true, id: record.id })
    },
  } as never

  const stateTool: ToolDefinition = {
    name: 'evo_observe_state',
    description: 'Report the automatic observation state: how many turns were observed, the guard counters that bound the autonomous loop, and the configured thresholds.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async () => {
      const cfg = deps.cfg().evolution
      const experiences = await store.listExperiences(10000)
      // Use the stored experience count, not the in-memory ring buffer length,
      // so callers see the true persistence count even after a process restart.
      const storedCount = experiences.length
      return neutralizeDeep({
        observedTurnsThisProcess: storedCount,
        ringBufferInFlight: observations.length,
        lastObservation: observations.length > 0 ? observations[observations.length - 1] : null,
        guards: autoGuardState(),
        thresholds: {
          minExperiences: cfg.analysis.minExperiences,
          minOccurrences: cfg.analysis.minOccurrences,
          generationEnabled: cfg.generation.enabled,
          promotionEnabled: cfg.promotion.enabled,
          maxCyclesPerProcess: cfg.maxCyclesPerProcess,
        },
        storedExperiences: experiences.length,
      })
    },
  } as never

  registerToolSafe(deps.ctx, recordTool)
  registerToolSafe(deps.ctx, stateTool)

  observations.length = 0

  // Subscribe to the REAL host event: `session/event` carries (session, event).
  deps.ctx.on('session/event', ((session: HostSessionView, event: HostSessionEvent) => {
    try {
      if (!deps.cfg().evolution.enabled || !deps.cfg().evolution.autoRecord) return
      const observed = observeTurn(session, event)
      if (!observed) return

      if (observations.length < 50) observations.push(observed)

      const versionId = activationState().activeVersionId
      void store.addExperience({
        taskId: observed.sessionId + '#' + observed.turn,
        prompt: observed.prompt,
        // Stable per OUTCOME, never per turn: detectPatterns clusters on
        // this text when a turn recorded no error, so a turn number here
        // would make every observation unique and no pattern could form.
        summary: 'turn ended: ' + observed.reasonKind,
        success: observed.success,
        errors: observed.errors,
        durationMs: observed.durationMs,
        stepCount: observed.stepCount,
        // Preserve version identity so post-promotion observations can be
        // attributed to the version that was active at the time.
        versionId: versionId ?? undefined,
        metadata: {
          sessionId: observed.sessionId,
          turn: observed.turn,
          reason: observed.reasonKind,
          toolCalls: observed.toolCallNames,
        },
      }).then(async () => {
        // Enforce retention and count cap so the store stays within configured limits.
        // Failures are fire-and-forget: they must not block pattern analysis.
        // Uses time-gated pruning (maybePruneExperiences) to avoid an O(n) disk
        // scan on every completed task — pruning runs at most once per process
        // hour, and always on the first experience after process start.
        const expCfg = deps.cfg().experience
        try { await deps.store.maybePruneExperiences(expCfg.maxRecords, expCfg.retentionDays) } catch { /* ignore prune failures */ }
        void runAutoCycle(deps)
      }).catch(() => { /* observation must never break the turn */ })
    } catch {
      // A listener failure must never surface into the agent loop.
    }
  }) as never)

  deps.log('auto-experience: registered evo_auto_record, evo_observe_state, session/event hook')
}

/** In-process observation ring, exposed for diagnostics via evo_observe_state. */
const observations: ObservedTurn[] = []
