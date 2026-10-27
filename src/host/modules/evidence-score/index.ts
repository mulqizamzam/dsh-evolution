import { JSON_OBJECT_OUTPUT, defineTool, registerToolSafe, text } from '../../dsh.ts'
import type { ModuleDeps, CandidateModule, ExperienceRecord, Pattern, BenchmarkRun, ToolDefinition } from '../../types.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'

type EvidenceScore = {
  candidateId: string
  score: number
  grade: 'strong' | 'promising' | 'weak' | 'insufficient'
  components: {
    evidenceCoverage: number
    outcomeQuality: number
    patternSupport: number
    benchmarkQuality: number
  }
  evidence: { experienceCount: number; patternCount: number; benchmarkCount: number; liveBenchmarkCount: number }
  reasons: string[]
  promotionEffect: 'informational-only'
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0))
}

export function calculateEvidenceScore(
  candidate: CandidateModule,
  experiences: ExperienceRecord[],
  patterns: Pattern[],
  benchmarks: BenchmarkRun[],
): EvidenceScore {
  const evidenceIds = new Set(candidate.evidenceIds ?? [])
  const linkedExperiences = experiences.filter(e => evidenceIds.has(e.id))
  const linkedPatterns = patterns.filter(p =>
    (candidate.patternIds ?? []).includes(p.id) || evidenceIds.has(p.id),
  )
  const relevantPatterns = linkedPatterns.filter(p =>
    (p.evidenceIds ?? []).some(id => evidenceIds.has(id)) || (candidate.patternIds ?? []).includes(p.id),
  )
  const latest = [...benchmarks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  const live = benchmarks.filter(b => b.mode === 'live')
  const evidenceCoverage = clamp01((linkedExperiences.length + relevantPatterns.length * 2) / 8)
  const outcomeQuality = linkedExperiences.length > 0
    ? clamp01(linkedExperiences.filter(e => e.success).length / linkedExperiences.length)
    : 0
  const patternSupport = relevantPatterns.length > 0
    ? clamp01(relevantPatterns.reduce((sum, p) => sum + clamp01(p.confidence), 0) / relevantPatterns.length)
    : 0
  const benchmarkQuality = latest?.mode === 'live'
    ? (latest.passed ? 1 : 0)
    : 0
  const score = Math.round(100 * (
    evidenceCoverage * 0.25 +
    outcomeQuality * 0.20 +
    patternSupport * 0.20 +
    benchmarkQuality * 0.35
  ))
  const grade: EvidenceScore['grade'] = linkedExperiences.length === 0 && relevantPatterns.length === 0
    ? 'insufficient'
    : score >= 80 ? 'strong' : score >= 60 ? 'promising' : score >= 35 ? 'weak' : 'insufficient'
  const reasons: string[] = []
  if (linkedExperiences.length === 0) reasons.push('No directly linked experience records were found.')
  if (relevantPatterns.length === 0) reasons.push('No supporting pattern with linked evidence was found.')
  if (!latest) reasons.push('No benchmark record exists; benchmark quality contributes zero.')
  else if (latest.mode !== 'live') reasons.push('Latest benchmark is not live execution evidence.')
  else if (!latest.passed) reasons.push('Latest live benchmark did not pass.')
  if (latest?.mode === 'live' && latest.passed) reasons.push('Latest benchmark is live and passed.')
  if (linkedExperiences.length > 0) reasons.push(`${linkedExperiences.length} linked experience record(s), ${linkedExperiences.filter(e => e.success).length} successful.`)
  if (relevantPatterns.length > 0) reasons.push(`${relevantPatterns.length} supporting pattern(s) matched.`)
  return {
    candidateId: candidate.id,
    score,
    grade,
    components: {
      evidenceCoverage: Math.round(evidenceCoverage * 100) / 100,
      outcomeQuality: Math.round(outcomeQuality * 100) / 100,
      patternSupport: Math.round(patternSupport * 100) / 100,
      benchmarkQuality: Math.round(benchmarkQuality * 100) / 100,
    },
    evidence: {
      experienceCount: linkedExperiences.length,
      patternCount: relevantPatterns.length,
      benchmarkCount: benchmarks.length,
      liveBenchmarkCount: live.length,
    },
    reasons,
    promotionEffect: 'informational-only',
  }
}

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

export const name = 'evidence-score'

export function apply(deps: ModuleDeps): void {
  const tool: ToolDefinition = defineTool({
    name: 'evo_evidence_score',
    description: 'Calculate an explainable evidence score for a candidate from linked experience records, supporting patterns, and its latest benchmark. This score is informational and does not override promotion policy.',
    parameters: {
      type: 'object',
      properties: {
        candidateId: { type: 'string', description: 'Candidate id to score.' },
      },
      required: ['candidateId'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never) => {
      const a = (args ?? {}) as Record<string, unknown>
      const candidateId = typeof a.candidateId === 'string' ? a.candidateId : ''
      if (!candidateId) return neutralizeDeep({ ok: false, error: 'candidateId is required' })
      const candidate = await deps.store.getCandidate(candidateId)
      if (!candidate) return neutralizeDeep({ ok: false, error: 'no candidate ' + candidateId })
      const [experiences, patterns, benchmarks] = await Promise.all([
        deps.store.listExperiences(10000),
        deps.store.listPatterns(1000),
        deps.store.listBenchmarksByCandidate(candidateId, true),
      ])
      return neutralizeDeep({ ok: true, ...calculateEvidenceScore(candidate, experiences, patterns, benchmarks) })
    },
  } as never)
  const result = registerToolSafe(deps.ctx, tool)
  if (!result.ok) deps.warn('evidence-score: tool registration failed: ' + result.error)
  deps.log('evidence-score: registered evo_evidence_score')
}
