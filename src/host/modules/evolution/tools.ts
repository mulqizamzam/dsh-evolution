import { JSON_OBJECT_OUTPUT, defineTool, text } from '../../dsh.ts'
import type { CandidateType, ModuleDeps, PatternType, ToolDefinition } from '../../types.ts'
import { clampText } from '../../../lib/caps.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'
import { detectPatterns } from '../analyze/tools.ts'
import { runPromotionPolicy } from '../promote/index.ts'

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

function candidateTypeFor(patternType: PatternType): CandidateType {
  switch (patternType) {
    case 'failure': return 'retry-strategy'
    case 'inefficiency': return 'workflow'
    case 'opportunity': return 'routing-rule'
    case 'success': return 'policy'
  }
}

export function evolutionTools(deps: ModuleDeps): ToolDefinition[] {
  const store = deps.store

  return [
    defineTool({
      name: 'evo_status',
      description: 'Show current evolution status: the active version, and counts of experiences, patterns and candidates.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async () => {
        const [active, experiences, patterns, candidates] = await Promise.all([
          store.getActiveVersion(),
          store.listExperiences(5000),
          store.listPatterns(5000),
          store.listCandidates(5000),
        ])
        return neutralizeDeep({
          activeVersion: active,
          counts: {
            experiences: experiences.length,
            patterns: patterns.length,
            candidates: candidates.length,
          },
        })
      },
    } as never),

    defineTool({
      name: 'evo_run_cycle',
      description: 'Run one evolution cycle. With analyzeOnly true (default) it only detects and reports patterns. With analyzeOnly false it also creates draft candidates from detected patterns.',
      parameters: {
        type: 'object',
        properties: {
          analyzeOnly: { type: 'boolean', description: 'When true, only analyze and report. When false, also create candidates. Defaults to true.' },
        },
        required: [],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const analyzeOnly = a.analyzeOnly !== false
        const experiences = await store.listExperiences(500)
        const detected = detectPatterns(experiences, 3)

        // Dedup: skip patterns whose description already exists in the store.
        const existing = await store.listPatterns(500)
        const existingDescriptions = new Set(existing.map(p => p.description))
        const fresh = detected.filter(p => !existingDescriptions.has(p.description))

        const persisted = []
        for (const p of fresh) persisted.push(await store.addPattern(p))

        if (analyzeOnly) {
          return neutralizeDeep({ analyzed: true, created: 0, patterns: persisted })
        }

        const active = await store.getActiveVersion()
        const parentVersion = active ? active.id : 'v0'
        const created = []
        for (const p of persisted) {
          const candidate = await store.addCandidate({
            parentVersion,
            type: candidateTypeFor(p.type),
            name: clampText('fix: ' + p.description.slice(0, 120), 200),
            description: clampText(p.description, 1000),
            reason: clampText('Generated from pattern ' + p.id + ' (occurrences ' + p.occurrences + ').', 1000),
            evidenceIds: Array.isArray(p.evidenceIds) ? p.evidenceIds : [],
            patternIds: [p.id],
            files: [],
            tests: [],
            benchmarkConfig: {
              successRate: { min: 0.8, weight: 1 },
              avgScore: { min: 0.7, weight: 1 },
              errorRate: { max: 0.2, weight: 1 },
              avgSteps: { max: 50, weight: 0.5 },
              avgDurationMs: { max: 60000, weight: 0.5 },
            },
            status: 'draft',
          })
          created.push(candidate)
        }
        return neutralizeDeep({ analyzed: true, created: created.length, patterns: persisted, candidates: created })
      },
    } as never),

    defineTool({
      name: 'evo_full_cycle',
      description: 'Run the complete autonomous evolution cycle: analyze experiences, detect patterns, generate a candidate via LLM, validate, sandbox-execute, benchmark, and promote or reject based on measured evidence. Requires LLM endpoint configuration.',
      parameters: {
        type: 'object',
        properties: {
          apiUrl: { type: 'string', description: 'LLM API endpoint URL for candidate generation.' },
          apiKey: { type: 'string', description: 'LLM API access token.' },
          model: { type: 'string', description: 'LLM model identifier.' },
          testCommand: { type: 'string', description: 'Command to execute in sandbox for benchmarking, e.g. node test.js.' },
          minOccurrences: { type: 'number', description: 'Minimum pattern occurrences to trigger analysis. Defaults to 3.' },
        },
        required: ['apiUrl', 'apiKey', 'model', 'testCommand'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const steps: string[] = []

        // ── SAFETY GATE ──
        // Respect the same generation/promotion switches the auto-cycle uses.
        // A manual tool call must never bypass the operator's disable gate.
        const cfg = deps.cfg().evolution
        if (!cfg.generation.enabled) {
          return neutralizeDeep({
            ok: false,
            steps: ['observe'],
            error: 'evo_full_cycle: autonomous candidate generation is disabled by config (evolution.generation.enabled = false)',
          })
        }

        // STEP 1: OBSERVE
        steps.push('observe')
        const experiences = await store.listExperiences(500)
        if (experiences.length === 0) {
          return neutralizeDeep({ ok: false, steps, error: 'no experiences recorded; record some first with evo_experience_record' })
        }

        // ── STEP 2: ANALYZE ──
        steps.push('analyze')
        const min = typeof a.minOccurrences === 'number' ? Math.max(1, Math.floor(a.minOccurrences)) : 3
        const detected = detectPatterns(experiences, min)
        const existing = await store.listPatterns(500)
        const existingDescriptions = new Set(existing.map(p => p.description))
        const fresh = detected.filter(p => !existingDescriptions.has(p.description))
        const persisted = []
        for (const p of fresh) persisted.push(await store.addPattern(p))

        if (persisted.length === 0) {
          return neutralizeDeep({ ok: false, steps, error: 'no new patterns detected; need more experiences with recurring signatures' })
        }

        // ── STEP 3: PROPOSE ──
        steps.push('propose')
        const active = await store.getActiveVersion()
        const parentVersion = active ? active.id : 'v0'

        // Create a draft candidate from the strongest pattern
        const strongestPattern = persisted.sort((a, b) => b.confidence - a.confidence)[0]
        const draftCandidate = await store.addCandidate({
          parentVersion,
          type: candidateTypeFor(strongestPattern.type),
          name: clampText('auto: ' + strongestPattern.description.slice(0, 120), 200),
          description: clampText(strongestPattern.description, 1000),
          reason: clampText('Auto-generated from pattern ' + strongestPattern.id + ' (confidence ' + strongestPattern.confidence.toFixed(2) + ').', 1000),
          evidenceIds: Array.isArray(strongestPattern.evidenceIds) ? strongestPattern.evidenceIds : [],
          patternIds: [strongestPattern.id],
          files: [],
          tests: [],
          benchmarkConfig: {
            successRate: { min: 0.8, weight: 1 },
            avgScore: { min: 0.7, weight: 1 },
            errorRate: { max: 0.2, weight: 1 },
            avgSteps: { max: 50, weight: 0.5 },
            avgDurationMs: { max: 60000, weight: 0.5 },
          },
          status: 'draft',
        })

        // ── STEP 4: BUILD (LLM candidate generation) ──
        steps.push('build')
        const { builderTools } = await import('../builder/tools.ts')
        const genTool = builderTools(deps).find(t => t.name === 'evo_builder_generate')
        if (!genTool) {
          return neutralizeDeep({ ok: false, steps, error: 'builder module not available' })
        }

        let buildResult: Record<string, unknown>
        try {
          buildResult = (await genTool.execute({
            patternIds: [strongestPattern.id],
            parentVersion,
            apiUrl: String(a.apiUrl),
            apiKey: String(a.apiKey),
            model: String(a.model),
          } as never, { signal: AbortSignal.timeout(180_000) })) as Record<string, unknown>
        } catch (error) {
          // LLM build failed - keep the draft candidate as-is
          return neutralizeDeep({
            ok: false,
            steps,
            error: 'LLM candidate generation failed: ' + (error instanceof Error ? error.message : String(error)),
            pattern: strongestPattern.id,
            draftCandidateId: draftCandidate.id,
          })
        }

        if (!buildResult || buildResult.ok !== true) {
          return neutralizeDeep({
            ok: false,
            steps,
            error: buildResult?.error ?? 'unknown build error',
            pattern: strongestPattern.id,
            draftCandidateId: draftCandidate.id,
          })
        }

        const generatedCandidateId = String(buildResult.candidateId ?? '')

        // ── STEP 5: VALIDATE ──
        steps.push('validate')
        const validation = buildResult.validation as { valid: boolean; errors?: string[] } | undefined
        if (validation && !validation.valid) {
          await store.updateCandidate(generatedCandidateId, { status: 'rejected' })
          return neutralizeDeep({
            ok: false,
            steps,
            error: 'candidate validation failed',
            validationErrors: validation.errors,
            candidateId: generatedCandidateId,
          })
        }

        // ── STEP 6: SANDBOX ──
        steps.push('sandbox')
        let benchResult: Record<string, unknown> | null = null
        try {
          const { benchmarkTools } = await import('../benchmark/tools.ts')
          const liveTool = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')
          if (liveTool) {
            benchResult = (await liveTool.execute({
              candidateId: generatedCandidateId,
              command: String(a.testCommand),
              timeoutMs: 30000,
            } as never, { signal: AbortSignal.timeout(120_000) })) as Record<string, unknown>
          }
        } catch {
          // Sandbox may fail - continue to promotion decision
        }

        // ── STEP 7: BENCHMARK ──
        steps.push('benchmark')
        let benchmarkPassed = false
        if (benchResult && benchResult.ok === true) {
          benchmarkPassed = Boolean(benchResult.passed)
        }
        // If no live benchmark, use the existing simulated benchmark
        if (!benchResult || benchResult.ok !== true) {
          try {
            const { benchmarkTools } = await import('../benchmark/tools.ts')
            const simTool = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_run')
            if (simTool) {
              const simResult = (await simTool.execute({
                candidateId: generatedCandidateId,
                runs: 3,
              } as never, { signal: AbortSignal.timeout(30_000) })) as Record<string, unknown>
              benchmarkPassed = simResult?.passed === true
            }
          } catch {
            // Fall through to rejection
          }
        }

        // ── STEP 8: PROMOTE or REJECT ──
        steps.push('promote-or-reject')

        // Generation is gated above; promotion must also stay gated so the
        // tool cannot silently promote without explicit operator consent.
        if (!cfg.promotion.enabled) {
          await store.updateCandidate(generatedCandidateId, { status: 'rejected' })
          return neutralizeDeep({
            ok: false,
            steps,
            verdict: 'REJECTED',
            candidateId: generatedCandidateId,
            reason: 'promotion is disabled by config (evolution.promotion.enabled = false)',
          })
        }

        if (!benchmarkPassed) {
          await store.updateCandidate(generatedCandidateId, { status: 'rejected' })
          return neutralizeDeep({
            ok: false,
            steps,
            verdict: 'REJECTED',
            candidateId: generatedCandidateId,
            pattern: strongestPattern.id,
            reason: 'benchmark did not pass',
            benchResult: benchResult ?? null,
          })
        }

        // Mark as benchmarked, then promote via the shared promotion authority.
        // runPromotionPolicy enforces the comparative beats_active gate at the
        // version-creation boundary, so both autonomous (evo_full_cycle) and
        // manual (evo_promote) paths are protected by the same policy.
        await store.updateCandidate(generatedCandidateId, { status: 'benchmarked' })

        // Compute the probe version id that runPromotionPolicy will use
        const versionNumber = (await store.listVersions(200)).reduce((max, v) => Math.max(max, v.number), 0) + 1
        const plannedVersionId = 'v' + String(versionNumber)

        const candidate = await store.getCandidate(generatedCandidateId)
        if (!candidate) {
          await store.updateCandidate(generatedCandidateId, { status: 'rejected' })
          return neutralizeDeep({
            ok: false,
            steps,
            verdict: 'REJECTED',
            candidateId: generatedCandidateId,
            reason: 'candidate ' + generatedCandidateId + ' not found in store',
          })
        }

        const promoResult = await runPromotionPolicy(
          deps,
          candidate,
          clampText('auto: ' + strongestPattern.description.slice(0, 80), 200),
          plannedVersionId,
        )
        if (!promoResult.ok) {
          await store.updateCandidate(generatedCandidateId, { status: 'rejected' })
          return neutralizeDeep({
            ok: false,
            steps,
            verdict: 'REJECTED',
            candidateId: generatedCandidateId,
            pattern: strongestPattern.id,
            reason: 'promotion failed: ' + promoResult.error,
          })
        }

        return neutralizeDeep({
          ok: true,
          steps,
          verdict: 'PROMOTED',
          candidateId: generatedCandidateId,
          versionId: promoResult.version.id,
          pattern: strongestPattern.id,
          benchResult: benchResult ?? null,
        })
      },
    } as never),
  ]
}
