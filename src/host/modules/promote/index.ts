import { registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { promoteTools } from './tools.ts'

export const name = 'promote'
export const TOOLS = ['evo_promote', 'evo_rollback', 'evo_promote_list', 'evo_promote_decision'] as const
export const readEndpoints = {}
export const writeEndpoints = {}

export function apply(deps: ModuleDeps): void {
  for (const tool of promoteTools(deps)) {
    registerToolSafe(deps.ctx, tool as never)
  }
}
