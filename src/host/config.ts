import z from 'schemastery'

export const STATE_DIR_NAME = 'dsh-evolution'

export interface EvoConfig {
  stateRoot: string
  inject: { enabled: boolean }
  evolution: {
    /** Master switch for the autonomous loop. */
    enabled: boolean
    /** Record an experience automatically after every completed turn. */
    autoRecord: boolean
    /** Run analysis + generation + promotion without a manual tool call. */
    autoTrigger: boolean
    analysis: {
      /** Completed experiences required before analysis runs. */
      minExperiences: number
      /** Occurrences required for a signature to count as a recurring pattern. */
      minOccurrences: number
    }
    generation: {
      /** Allow the LLM to generate a candidate module. */
      enabled: boolean
    }
    promotion: {
      /**
     * Gate automatic promotion in evo_full_cycle/the autonomous loop.
     * Explicit evo_promote and evo_rollback calls remain available.
     */
      enabled: boolean
    }
    /** Hard cap on autonomous cycles per host process (loop safety). */
    maxCyclesPerProcess: number
    /**
     * Minimum gap between productive cycles, in milliseconds. Guards against
     * rapid-fire analysis during bulk imports. Set to 0 to disable, which
     * multi-cycle probes do explicitly.
     */
    cycleDebounceMs: number
  }
  experience: { maxRecords: number; retentionDays: number }
  candidate: { maxActive: number }
  benchmark: { minRuns: number; maxRuns: number; improvementThreshold: number; regressionThreshold: number }
}

/**
 * Conservative defaults: 20 completed experiences and 5 occurrences before the
 * autonomous loop may act, generation and promotion both off until the operator
 * turns them on, and at most 3 autonomous cycles per host process.
 */
export const DEFAULT_CONFIG: EvoConfig = {
  stateRoot: '',
  inject: { enabled: true },
  evolution: {
    enabled: true,
    autoRecord: true,
    autoTrigger: true,
    analysis: { minExperiences: 20, minOccurrences: 5 },
    generation: { enabled: false },
    promotion: { enabled: false },
    maxCyclesPerProcess: 3,
    cycleDebounceMs: 2000,
  },
  experience: { maxRecords: 10000, retentionDays: 90 },
  candidate: { maxActive: 10 },
  benchmark: { minRuns: 3, maxRuns: 10, improvementThreshold: 0.05, regressionThreshold: 0.10 },
}

export const Config = z.object({
  stateRoot: z.string().default(DEFAULT_CONFIG.stateRoot),
  inject: z.object({
    enabled: z.boolean().default(DEFAULT_CONFIG.inject.enabled),
  }).default(DEFAULT_CONFIG.inject),
  evolution: z.object({
    enabled: z.boolean().default(DEFAULT_CONFIG.evolution.enabled),
    autoRecord: z.boolean().default(DEFAULT_CONFIG.evolution.autoRecord),
    autoTrigger: z.boolean().default(DEFAULT_CONFIG.evolution.autoTrigger),
    analysis: z.object({
      minExperiences: z.number().default(DEFAULT_CONFIG.evolution.analysis.minExperiences),
      minOccurrences: z.number().default(DEFAULT_CONFIG.evolution.analysis.minOccurrences),
    }).default(DEFAULT_CONFIG.evolution.analysis),
    generation: z.object({
      enabled: z.boolean().default(DEFAULT_CONFIG.evolution.generation.enabled),
    }).default(DEFAULT_CONFIG.evolution.generation),
    promotion: z.object({
      enabled: z.boolean().default(DEFAULT_CONFIG.evolution.promotion.enabled),
    }).default(DEFAULT_CONFIG.evolution.promotion),
    maxCyclesPerProcess: z.number().default(DEFAULT_CONFIG.evolution.maxCyclesPerProcess),
    cycleDebounceMs: z.number().default(DEFAULT_CONFIG.evolution.cycleDebounceMs),
  }).default(DEFAULT_CONFIG.evolution),
  experience: z.object({
    maxRecords: z.number().default(DEFAULT_CONFIG.experience.maxRecords),
    retentionDays: z.number().default(DEFAULT_CONFIG.experience.retentionDays),
  }).default(DEFAULT_CONFIG.experience),
  candidate: z.object({
    maxActive: z.number().default(DEFAULT_CONFIG.candidate.maxActive),
  }).default(DEFAULT_CONFIG.candidate),
  benchmark: z.object({
    minRuns: z.number().default(DEFAULT_CONFIG.benchmark.minRuns),
    maxRuns: z.number().default(DEFAULT_CONFIG.benchmark.maxRuns),
    improvementThreshold: z.number().default(DEFAULT_CONFIG.benchmark.improvementThreshold),
    regressionThreshold: z.number().default(DEFAULT_CONFIG.benchmark.regressionThreshold),
  }).default(DEFAULT_CONFIG.benchmark),
})

export type ResolvedConfig = EvoConfig

export const INJECT_LABEL = 'evolution'

/**
 * Parse a raw host config into a ResolvedConfig, applying defaults.
 *
 * Throws a descriptive Error when the input cannot be validated so callers
 * can decide whether to fail boot or log a warning. This is an *intentional*
 * surface: silent fallback to DEFAULT_CONFIG masked all malformed inputs
 * until a P7 audit flagged it as a gap.
 */
export function resolveConfig(raw: unknown): ResolvedConfig {
  const result = Config(raw as Parameters<typeof Config>[0]) as ResolvedConfig
  return result
}

/**
 * Parse like {@link resolveConfig} but return DEFAULT_CONFIG on any failure.
 *
 * Use this only in the startup path (boot) where a hard-fail is acceptable:
 * the plugin's degraded evo_status tool then reports the failure to the
 * operator. For all tool-level code paths, call {@link resolveConfig} and
 * catch explicitly.
 */
export function resolveConfigSafe(raw: unknown): ResolvedConfig {
  try {
    return resolveConfig(raw)
  } catch {
    return DEFAULT_CONFIG
  }
}
