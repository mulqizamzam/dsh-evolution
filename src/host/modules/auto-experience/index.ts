import { registerToolSafe, JSON_OBJECT_OUTPUT, text } from '../../dsh.ts'
import type { ModuleDeps, ToolDefinition } from '../../types.ts'
import type { HostSessionEvent, HostSessionView, ObservedTurn } from '../../types.ts'
import { detectPatterns } from '../analyze/tools.ts'
import { clampText } from '../../../lib/caps.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'

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
}

export function resetAutoGuards(): void {
  guards.inFlight = false
  guards.cyclesRun = 0
  guards.lastCycleExperienceCount = -1
}

export function autoGuardState(): { inFlight: boolean; cyclesRun: number; lastCycleExperienceCount: number } {
  return { ...guards }
}

export interface AutoCycleOutcome {
  ran: boolean
  reason: string
  patterns?: number
  candidateId?: string
  verdict?: string
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

  guards.inFlight = true
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

    if (fresh.length === 0) return { ran: false, reason: 'no actionable recurring pattern', patterns: 0 }

    guards.cyclesRun += 1
    deps.log('auto-cycle: ' + fresh.length + ' new pattern(s) from ' + experiences.length + ' experiences')

    if (!cfg.generation.enabled) {
      return { ran: true, reason: 'patterns recorded; generation disabled', patterns: fresh.length }
    }

    // Generation + promotion delegate to the same deterministic pipeline the
    // manual tools use; the LLM proposes, the host decides.
    const { builderTools } = await import('../builder/tools.ts')
    const build = builderTools(deps).find(t => t.name === 'evo_builder_generate')
    if (!build) return { ran: true, reason: 'builder unavailable', patterns: fresh.length }

    const strongest = [...fresh].sort((a, b) => b.confidence - a.confidence)[0]
    const active = await deps.store.getActiveVersion()
    const built = await build.execute({
      patternIds: [strongest.id],
      parentVersion: active ? active.id : 'v0',
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
      const observed = observations.length
      return neutralizeDeep({
        observedTurnsThisProcess: observed,
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
        metadata: {
          sessionId: observed.sessionId,
          turn: observed.turn,
          reason: observed.reasonKind,
          toolCalls: observed.toolCallNames,
        },
      }).then(() => runAutoCycle(deps)).catch(() => { /* observation must never break the turn */ })
    } catch {
      // A listener failure must never surface into the agent loop.
    }
  }) as never)

  deps.log('auto-experience: registered evo_auto_record, evo_observe_state, session/event hook')
}

/** In-process observation ring, exposed for diagnostics via evo_observe_state. */
const observations: ObservedTurn[] = []
