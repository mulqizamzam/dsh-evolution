import { registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { evolutionTools } from './tools.ts'

export const name = 'evolution'
export const TOOLS = ['evo_status', 'evo_run_cycle'] as const
export const readEndpoints = {}
export const writeEndpoints = {}

export function apply(deps: ModuleDeps): void {
  for (const tool of evolutionTools(deps)) {
    registerToolSafe(deps.ctx, tool as never)
  }
}
