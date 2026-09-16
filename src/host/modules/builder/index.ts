import { registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { builderTools } from './tools.ts'

export const name = 'builder'
export const TOOLS = ['evo_builder_generate'] as const
export const readEndpoints = {}
export const writeEndpoints = {}

export function apply(deps: ModuleDeps): void {
  for (const tool of builderTools(deps)) {
    registerToolSafe(deps.ctx, tool as never)
  }
}
