import { registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { candidateTools } from './tools.ts'

export const name = 'candidate'
export const TOOLS = ['evo_candidate_create', 'evo_candidate_list', 'evo_candidate_inspect'] as const
export const readEndpoints = {}
export const writeEndpoints = {}

export function apply(deps: ModuleDeps): void {
  for (const tool of candidateTools(deps)) {
    registerToolSafe(deps.ctx, tool as never)
  }
}
