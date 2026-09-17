/**
 * Helper to create a version-history tool definition for tests.
 * Mirrors the real apply() logic without registering on a context.
 */
import { JSON_OBJECT_OUTPUT, defineTool } from '../../src/host/dsh.ts'
import type { ToolDefinition } from '../../src/host/types.ts'
import { neutralizeDeep } from '../../src/lib/sanitize.ts'
import { detectVersionDegradation } from '../../src/host/modules/analyze/tools.ts'
import type { EvolutionStore } from '../../src/host/store.ts'

export function versionHistoryApply(
  store: EvolutionStore,
): ToolDefinition {
  return defineTool({
    name: 'evo_version_history',
    description: 'Return post-promotion observation history for one version.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: JSON_OBJECT_OUTPUT,
      render: (_a: Record<string, unknown>, v: never) => [{ type: 'text', text: JSON.stringify(v) }],
    },
    execute: async (args: never) => {
      const a = (args ?? {}) as Record<string, unknown>
      const limit = typeof a.limit === 'number'
        ? Math.max(1, Math.min(500, Math.floor(a.limit)))
        : 50

      const versionIdToQuery = typeof a.versionId === 'string' && a.versionId !== ''
        ? a.versionId
        : await store.getActiveVersion().then(v => v?.id)

      if (!versionIdToQuery) {
        return neutralizeDeep({ ok: false, error: 'no version specified and no active version found' })
      }

      const records = await store.listExperiencesByVersion(versionIdToQuery, limit)
      const signal = records.length > 0 ? detectVersionDegradation(records) : null
      return neutralizeDeep({
        versionId: versionIdToQuery,
        observationCount: records.length,
        experiences: records,
        degradation: signal,
      })
    },
  } as never)
}
