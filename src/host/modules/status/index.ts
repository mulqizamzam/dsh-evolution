import { JSON_OBJECT_OUTPUT, defineTool, registerToolSafe, text } from '../../dsh.ts'
import type { ToolDefinition, HostContextShape } from '../../dsh.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'
import type { ModuleDeps } from '../../types.ts'
import type { EvolutionStore } from '../../store.ts'
import { VERSION } from '../../index.ts'

type Args = Record<string, unknown>
interface Execution { signal: AbortSignal; agent?: unknown }

const RENDER = (_a: Record<string, unknown>, v: never): Array<{ type: 'text'; text: string }> => text(v)

export const name = 'status'

function statusTool(store: EvolutionStore, version: string): ToolDefinition {
  return defineTool({
    name: 'evo_health',
    description:
      'Check plugin health: state root, schema version, record counts, active version.',
    parameters: { type: 'object', properties: {} },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (_args: never, _exec: Execution) => {
      const [experiences, patterns, candidates, versions, activeVersion] = await Promise.all([
        store.listExperiences(10000),
        store.listPatterns(),
        store.listCandidates(),
        store.listVersions(),
        store.getActiveVersion(),
      ])
      return neutralizeDeep({
        status: 'ok',
        plugin: 'dsh-evolution',
        version,
        stateRoot: store.getRoot(),
        schemaVersion: 1,
        activeVersion: activeVersion?.id ?? 'none',
        counts: {
          experiences: experiences.length,
          patterns: patterns.length,
          candidates: candidates.length,
          versions: versions.length,
        },
      })
    },
  } as never)
}

export function apply(deps: ModuleDeps): void {
  const def = statusTool(deps.store, VERSION)
  const result = registerToolSafe(deps.ctx, def)
  if (!result.ok) deps.warn(`status: tool registration failed: ${result.error}`)
  deps.log('status: registered 1 tool')
}
