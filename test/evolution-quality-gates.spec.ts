import { describe, expect, it } from 'vitest'
import type { BenchmarkRun, CandidateModule, ExperienceRecord, Pattern } from '../src/host/types.ts'
import { calculateEvidenceScore } from '../src/host/modules/evidence-score/index.ts'
import { evaluateShadowGate } from '../src/host/modules/shadow-evaluation/index.ts'
import { auditMemory } from '../src/host/modules/memory-lifecycle/index.ts'
import { runAdversarialStaticSuite } from '../src/host/modules/adversarial-benchmark/index.ts'
import { auditBenchmarkIntegrity } from '../src/host/modules/integrity-red-team/index.ts'
import { createLiveProvenance } from '../src/lib/provenance.ts'

const candidate = (overrides: Partial<CandidateModule> = {}): CandidateModule => ({
  id: 'cand-1',
  parentVersion: 'v1',
  type: 'policy',
  name: 'candidate',
  description: 'candidate description',
  reason: 'test reason',
  evidenceIds: ['exp-1', 'pattern-1'],
  patternIds: ['pattern-1'],
  files: [{ path: 'src/index.ts', content: 'export const answer = 42' }],
  tests: [{ path: 'test/index.spec.ts', content: 'expect(true).toBe(true)' }],
  benchmarkConfig: {
    successRate: { min: 0.8, weight: 1 },
    avgScore: { min: 0.7, weight: 1 },
    errorRate: { max: 0.2, weight: 1 },
    avgSteps: { max: 50, weight: 0.5 },
    avgDurationMs: { max: 60000, weight: 0.5 },
  },
  status: 'benchmarked',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const experience = (overrides: Partial<ExperienceRecord> = {}): ExperienceRecord => ({
  id: 'exp-1',
  timestamp: '2026-01-01T00:00:00.000Z',
  prompt: 'summarize report',
  summary: 'completed report',
  success: true,
  ...overrides,
})

const pattern = (overrides: Partial<Pattern> = {}): Pattern => ({
  id: 'pattern-1',
  type: 'success',
  evidence: 'FACT',
  description: 'reliable report completion',
  occurrences: 3,
  evidenceIds: ['exp-1'],
  confidence: 0.9,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const benchmark = (overrides: Partial<BenchmarkRun> = {}): BenchmarkRun => ({
  id: 'bench-1',
  candidateId: 'cand-1',
  version: 'v1',
  baseline: 'v0',
  runs: 5,
  metrics: { successRate: 0.9, avgScore: 0.9, errorRate: 0.05, avgSteps: 4, avgDurationMs: 100 },
  passed: true,
  details: 'all thresholds met',
  createdAt: '2026-01-01T00:00:00.000Z',
  mode: 'live',
  command: 'npm test',
  ...overrides,
})

describe('evolution quality and red-team gates', () => {
  it('scores linked evidence and keeps the score informational', () => {
    const score = calculateEvidenceScore(candidate(), [experience()], [pattern()], [benchmark()])
    expect(score.score).toBeGreaterThan(0)
    expect(score.evidence.experienceCount).toBe(1)
    expect(score.evidence.patternCount).toBe(1)
    expect(score.promotionEffect).toBe('informational-only')
  })

  it('allows canary readiness only when live metrics are comparable and stable', () => {
    const result = evaluateShadowGate(benchmark(), benchmark({ id: 'baseline', candidateId: 'active-candidate' }))
    expect(result.canaryReady).toBe(true)
    expect(result.executionModel).toContain('no live traffic')
  })

  it('reports duplicate memories and stale low-confidence patterns', () => {
    const first = experience({ id: 'exp-a' })
    const second = experience({ id: 'exp-b' })
    const oldPattern = pattern({ createdAt: '2020-01-01T00:00:00.000Z', confidence: 0.2 })
    const report = auditMemory([first, second], [oldPattern], 30, Date.parse('2026-01-01T00:00:00.000Z'))
    expect(report.duplicateGroupCount).toBe(1)
    expect(report.stalePatternCount).toBe(1)
  })

  it('fails the static adversarial suite on dynamic code execution', () => {
    const unsafe = candidate({ files: [{ path: 'src/index.ts', content: 'const run = eval(input)' }] })
    const report = runAdversarialStaticSuite(unsafe)
    expect(report.status).toBe('FAIL')
    expect(report.findings.some(f => f.rule === 'dynamic-code-execution')).toBe(true)
  })

  it('flags a missing live provenance seal for review without misclassifying legacy records as tampering', () => {
    const report = auditBenchmarkIntegrity('cand-1', [benchmark({ provenance: undefined })])
    expect(report.status).toBe('REVIEW')
    expect(report.findings.some(f => f.rule === 'legacy-live-unsealed')).toBe(true)
  })

  it('accepts a matching live provenance seal', () => {
    const record = benchmark()
    record.provenance = createLiveProvenance(record.candidateId, record.version, record.command ?? '', record.createdAt)
    const report = auditBenchmarkIntegrity('cand-1', [record])
    expect(report.status).toBe('PASS')
  })
})
