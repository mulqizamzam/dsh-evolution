import { JSON_OBJECT_OUTPUT, defineTool, registerToolSafe, text } from '../../dsh.ts'
import type { ModuleDeps, ToolDefinition } from '../../types.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'
import { detectVersionDegradation } from '../analyze/tools.ts'

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

export const name = 'version-history'
export const TOOLS = ['evo_version_history'] as const
export const readEndpoints = {}
export const writeEndpoints = {}

export function apply(deps: ModuleDeps): void {
  const tool: ToolDefinition = {
    name: 'evo_version_history',
    description: 'Return post-promotion observation history for one version, including attribution and a degradation signal when enough evidence exists.',
    parameters: {
      type: 'object',
      properties: {
        versionId: {
          type: 'string',
          description: 'The version to query. Omit to get the currently active version (if any).',
        },
        limit: {
          type: 'number',
          description: 'Maximum observations to return. Defaults to 50, capped at 500.',
        },
      },
      required: [],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never) => {
      const a = (args ?? {}) as Record<string, unknown>
      const limit = typeof a.limit === 'number'
        ? Math.max(1, Math.min(500, Math.floor(a.limit)))
        : 50

      const allExperiences = await deps.store.listExperiences(500)
      const targetVersionId = typeof a.versionId === 'string' && a.versionId !== ''
        ? a.versionId
        : undefined

      // If no versionId given, fall back to the active version.
      let versionIdToQuery: string | undefined = targetVersionId
      if (!versionIdToQuery) {
        const active = await deps.store.getActiveVersion()
        versionIdToQuery = active?.id
      }

      if (!versionIdToQuery) {
        return neutralizeDeep({
          ok: false,
          error: 'no version specified and no active version found',
        })
      }

      const records = await deps.store.listExperiencesByVersion(versionIdToQuery, limit)

      // Compute the degradation signal only when there are enough observations.
      let signal = null
      if (records.length > 0) {
        signal = detectVersionDegradation(records)
      }

      return neutralizeDeep({
        versionId: versionIdToQuery,
        observationCount: records.length,
        experiences: records,
        degradation: signal,
      })
    },
  } as never

  registerToolSafe(deps.ctx, tool)
  deps.log('version-history: registered evo_version_history')
}
