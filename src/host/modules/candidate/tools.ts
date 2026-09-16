import { JSON_OBJECT_OUTPUT, defineTool, text } from '../../dsh.ts'
import type { BenchmarkConfig, CandidateType, ModuleDeps, ToolDefinition } from '../../types.ts'
import { clampText } from '../../../lib/caps.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

const CANDIDATE_TYPES: CandidateType[] = [
  'policy', 'workflow', 'skill', 'routing-rule',
  'verification-strategy', 'retry-strategy', 'tool-selection-rule',
]

function defaultBenchmarkConfig(): BenchmarkConfig {
  return {
    successRate: { min: 0.8, weight: 1 },
    avgScore: { min: 0.7, weight: 1 },
    errorRate: { max: 0.2, weight: 1 },
    avgSteps: { max: 50, weight: 0.5 },
    avgDurationMs: { max: 60000, weight: 0.5 },
  }
}

export function candidateTools(deps: ModuleDeps): ToolDefinition[] {
  const store = deps.store

  return [
    defineTool({
      name: 'evo_candidate_create',
      description: 'Create a new candidate improvement module from observed evidence. Returns the created candidate in draft status.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: CANDIDATE_TYPES, description: 'Kind of candidate improvement to propose.' },
          name: { type: 'string', description: 'Short name for the candidate.' },
          description: { type: 'string', description: 'What the candidate changes and why.' },
          reason: { type: 'string', description: 'Rationale grounded in evidence.' },
          evidenceIds: { type: 'array', items: { type: 'string' }, description: 'Ids of experiences or patterns supporting this candidate.' },
          parentVersion: { type: 'string', description: 'Version this candidate is based on, e.g. v1.' },
        },
        required: ['type', 'name', 'description', 'reason', 'parentVersion'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const typeRaw = typeof a.type === 'string' ? a.type : ''
        const type = (CANDIDATE_TYPES as string[]).includes(typeRaw) ? (typeRaw as CandidateType) : 'policy'
        const candidate = await store.addCandidate({
          parentVersion: String(a.parentVersion ?? ''),
          type,
          name: clampText(String(a.name ?? ''), 200),
          description: clampText(String(a.description ?? ''), 1000),
          reason: clampText(String(a.reason ?? ''), 1000),
          evidenceIds: Array.isArray(a.evidenceIds) ? a.evidenceIds.map(String) : [],
          patternIds: [],
          files: [],
          tests: [],
          benchmarkConfig: defaultBenchmarkConfig(),
          status: 'draft',
        })
        return neutralizeDeep(candidate)
      },
    } as never),

    defineTool({
      name: 'evo_candidate_list',
      description: 'List candidate improvement modules, optionally filtered by status, most recent first.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Optional status filter: draft, validated, benchmarked, promoted, rejected.' },
          limit: { type: 'number', description: 'Maximum number of candidates to return. Defaults to 50.' },
        },
        required: [],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const status = typeof a.status === 'string' ? a.status : undefined
        const limit = typeof a.limit === 'number' ? Math.max(1, Math.min(200, Math.floor(a.limit))) : 50
        let candidates = await store.listCandidates(limit)
        if (status !== undefined) candidates = candidates.filter(c => c.status === status)
        return neutralizeDeep({ count: candidates.length, candidates })
      },
    } as never),

    defineTool({
      name: 'evo_candidate_inspect',
      description: 'Get the full detail of a single candidate module by its id.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The candidate id to inspect.' },
        },
        required: ['id'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const id = typeof a.id === 'string' ? a.id : ''
        const candidate = await store.getCandidate(id)
        return neutralizeDeep({ found: candidate !== null, candidate })
      },
    } as never),
  ]
}
