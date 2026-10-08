import { JSON_OBJECT_OUTPUT, defineTool, text } from '../../dsh.ts'
import type { ExperienceRecord, ModuleDeps, Pattern, ToolDefinition } from '../../types.ts'
import { clampText } from '../../../lib/caps.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

/** Minimum observations required before a version is considered to have enough data for a signal. */
const VERSION_OBSERVATION_MIN = 5

/** Degradation thresholds — conservative so a single blip is not a signal. */
const DEGRADATION_SUCCESS_RATE_THRESHOLD = 0.6
const DEGRADATION_ERROR_RATE_THRESHOLD = 0.3

export interface VersionDegradationSignal {
  versionId: string
  total: number
  successRate: number
  errorRate: number
  avgStepCount: number
  isDegraded: boolean
  signals: string[]
}

/**
 * Compute a per-version degradation signal from the full experience set.
 *
 * Only flags a version as degraded when there are enough observations and the
 * aggregate metrics cross the thresholds — not a single bad turn. This keeps
 * the signal conservative and avoids noise from short observation windows.
 */
export function detectVersionDegradation(experiences: ExperienceRecord[]): VersionDegradationSignal | null {
  const byVersion = new Map<string, ExperienceRecord[]>()
  for (const e of experiences) {
    if (!e.versionId) continue
    const list = byVersion.get(e.versionId) ?? []
    list.push(e)
    byVersion.set(e.versionId, list)
  }

  if (byVersion.size === 0) return null

  let weakest: VersionDegradationSignal | null = null
  for (const [versionId, records] of byVersion) {
    if (records.length < VERSION_OBSERVATION_MIN) continue

    const successCount = records.filter(r => r.success).length
    const successRate = successCount / records.length
    const errorRecords = records.filter(r => !r.success)
    const errorRate = errorRecords.length / records.length

    const stepCounts = errorRecords
      .map(r => r.stepCount ?? 0)
      .filter(n => n > 0)
    const avgStepCount = stepCounts.length > 0
      ? stepCounts.reduce((s, n) => s + n, 0) / stepCounts.length
      : 0

    const signals: string[] = []
    const isDegraded = successRate < DEGRADATION_SUCCESS_RATE_THRESHOLD || errorRate > DEGRADATION_ERROR_RATE_THRESHOLD
    if (successRate < DEGRADATION_SUCCESS_RATE_THRESHOLD) {
      signals.push('success-rate-low:' + (successRate * 100).toFixed(1) + '%')
    }
    if (errorRate > DEGRADATION_ERROR_RATE_THRESHOLD) {
      signals.push('error-rate-high:' + (errorRate * 100).toFixed(1) + '%')
    }
    if (avgStepCount >= 15) {
      signals.push('high-step-count:' + avgStepCount.toFixed(1))
    }

    const signal: VersionDegradationSignal = {
      versionId,
      total: records.length,
      successRate,
      errorRate,
      avgStepCount,
      isDegraded,
      signals,
    }

    // Surface the worst signal so callers can prioritise.
    if (weakest === null || signal.total > weakest.total) {
      weakest = signal
    }
  }

  return weakest
}

/** Lightweight heuristic pattern detector over recorded experiences. */
export function detectPatterns(experiences: ExperienceRecord[], minOccurrences: number): Array<Omit<Pattern, 'id' | 'createdAt'>> {
  const bySignature = new Map<string, { count: number; sample: string; evidenceIds: string[] }>()
  let successCount = 0

  for (const e of experiences) {
    if (e.success) { successCount++ }
    // Cluster failures by their first error (or summary) signature.
    const seed = Array.isArray(e.errors) && e.errors.length > 0
      ? String(e.errors[0])
      : (e.summary ?? 'unknown-outcome')
    const signature = clampText(seed, 80)
    const entry = bySignature.get(signature) ?? { count: 0, sample: signature, evidenceIds: [] }
    entry.count++
    if (e.id) entry.evidenceIds.push(e.id)
    bySignature.set(signature, entry)
  }

  const patterns: Array<Omit<Pattern, 'id' | 'createdAt'>> = []
  for (const [signature, data] of bySignature) {
    if (data.count < minOccurrences) continue
    const isFailure = /fail|error|exception|reject|denied/i.test(signature)
    patterns.push({
      type: isFailure ? 'failure' : 'opportunity',
      evidence: 'INFERENCE',
      // Description is the dedup key downstream (`existingDescriptions` in the
      // tool, `seen` in runAutoCycle), so it must NOT embed the occurrence
      // count: the count grows every cycle, which would key each re-detection
      // as a brand new pattern and accumulate duplicates in the store.
      description: `Recurring signature: ${signature}`,
      occurrences: data.count,
      evidenceIds: [...new Set(data.evidenceIds)],
      confidence: Math.min(0.95, 0.4 + data.count * 0.05),
    })
  }

  // Global inefficiency signal: high average step count across failures.
  const failed = experiences.filter(e => !e.success)
  if (failed.length >= minOccurrences) {
    const steps = failed.map(e => e.stepCount ?? 0).filter(n => n > 0)
    const avg = steps.length > 0 ? steps.reduce((s, n) => s + n, 0) / steps.length : 0
    if (avg >= 10) {
      patterns.push({
        type: 'inefficiency',
        evidence: 'INFERENCE',
        // Same rule as the signature patterns: the average drifts as evidence
        // accumulates, so it must not appear in the dedup key.
        description: `Failed runs with high average step count; likely redundant or retried work.`,
        occurrences: failed.length,
        evidenceIds: [...new Set(failed.map(e => e.id).filter((id): id is string => typeof id === 'string'))],
        confidence: Math.min(0.9, 0.3 + failed.length * 0.05),
      })
    }
  }

  return patterns
}

export function analyzeTools(deps: ModuleDeps): ToolDefinition[] {
  const store = deps.store

  return [
    defineTool({
      name: 'evo_analyze_patterns',
      description: 'Analyze recorded experiences for recurring patterns such as repeated failures or inefficiencies. Detected patterns are persisted and returned.',
      parameters: {
        type: 'object',
        properties: {
          minOccurrences: { type: 'number', description: 'Minimum times a signature must recur to be reported. Defaults to 3.' },
        },
        required: [],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const min = typeof a.minOccurrences === 'number' ? Math.max(1, Math.floor(a.minOccurrences)) : 3
        const experiences = await store.listExperiences(500)
        const detected = detectPatterns(experiences, min)

        // Dedup: skip patterns whose description already exists in the store.
        const existing = await store.listPatterns(500)
        const existingDescriptions = new Set(existing.map(p => p.description))
        const fresh = detected.filter(p => !existingDescriptions.has(p.description))

        const stored: Pattern[] = []
        for (const p of fresh) {
          stored.push(await store.addPattern(p))
        }
        return neutralizeDeep({ analyzed: experiences.length, detected: fresh.length, patterns: stored })
      },
    } as never),

    defineTool({
      name: 'evo_analyze_report',
      description: 'Generate a summary report of all stored patterns grouped by type with average confidence.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async () => {
        const patterns = await store.listPatterns(500)
        const byType: Record<string, number> = {}
        let confidenceSum = 0
        for (const p of patterns) {
          byType[p.type] = (byType[p.type] ?? 0) + 1
          confidenceSum += p.confidence
        }
        const report = {
          totalPatterns: patterns.length,
          byType,
          averageConfidence: patterns.length > 0 ? confidenceSum / patterns.length : 0,
          patterns,
        }
        return neutralizeDeep(report)
      },
    } as never),
  ]
}
