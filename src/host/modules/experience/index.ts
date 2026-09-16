import { registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { experienceTools } from './tools.ts'

export const name = 'experience'
export const TOOLS = ['evo_experience_record', 'evo_experience_list', 'evo_experience_inspect'] as const
export const readEndpoints = {}
export const writeEndpoints = {}

export function apply(deps: ModuleDeps): void {
  for (const tool of experienceTools(deps)) {
    registerToolSafe(deps.ctx, tool as never)
  }
}
