import { JSON_OBJECT_OUTPUT, defineTool, text } from '../../dsh.ts'
import type { ModuleDeps, ToolDefinition } from '../../types.ts'
import { clampText } from '../../../lib/caps.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

export function experienceTools(deps: ModuleDeps): ToolDefinition[] {
  const store = deps.store

  return [
    defineTool({
      name: 'evo_experience_record',
      description: 'Record a completed task as an experience record for later pattern analysis. Provide a success flag and optional metrics such as score, duration and step count.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Optional task identifier linking this experience to a run.' },
          prompt: { type: 'string', description: 'The task prompt or instruction; long text is clamped.' },
          summary: { type: 'string', description: 'Short human summary of what happened.' },
          success: { type: 'boolean', description: 'Whether the task succeeded.' },
          score: { type: 'number', description: 'Optional quality score between 0 and 1.' },
          durationMs: { type: 'number', description: 'Optional task duration in milliseconds.' },
          stepCount: { type: 'number', description: 'Optional number of agent steps taken.' },
          errors: { type: 'array', items: { type: 'string' }, description: 'Optional list of error messages encountered.' },
          metadata: { type: 'object', description: 'Optional free-form metadata map.' },
          versionId: { type: 'string', description: 'Optional evolution version ID active at the time of this outcome. Set by auto-observation; manual callers may pass it explicitly.' },
        },
        required: ['success'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const record = {
          taskId: typeof a.taskId === 'string' ? a.taskId : undefined,
          prompt: typeof a.prompt === 'string' ? clampText(a.prompt, 500) : undefined,
          summary: typeof a.summary === 'string' ? clampText(a.summary, 500) : undefined,
          success: Boolean(a.success),
          score: typeof a.score === 'number' ? a.score : undefined,
          durationMs: typeof a.durationMs === 'number' ? a.durationMs : undefined,
          stepCount: typeof a.stepCount === 'number' ? a.stepCount : undefined,
          errors: Array.isArray(a.errors) ? a.errors.map(String) : undefined,
          metadata: a.metadata && typeof a.metadata === 'object' ? (a.metadata as Record<string, unknown>) : undefined,
          versionId: typeof a.versionId === 'string' && a.versionId !== '' ? a.versionId : undefined,
        }
        const created = await store.addExperience(record)
        // Enforce retention and count cap using the resolved config limits.
        const expCfg = deps.cfg().experience
        void store.pruneExperiences(expCfg.maxRecords, expCfg.retentionDays).catch(() => {})
        return neutralizeDeep(created)
      },
    } as never),

    defineTool({
      name: 'evo_experience_list',
      description: 'List recent experience records, most recent first. Use this to survey collected task outcomes before analysis.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximum number of records to return. Defaults to 20.' },
        },
        required: [],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const limit = typeof a.limit === 'number' ? Math.max(1, Math.min(200, Math.floor(a.limit))) : 20
        const records = await store.listExperiences(limit)
        return neutralizeDeep({ count: records.length, records })
      },
    } as never),

    defineTool({
      name: 'evo_experience_inspect',
      description: 'Get the full detail of a single experience record by its id.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The experience record id to inspect.' },
        },
        required: ['id'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const id = typeof a.id === 'string' ? a.id : ''
        const record = await store.getExperience(id)
        return neutralizeDeep({ found: record !== null, record })
      },
    } as never),
  ]
}
