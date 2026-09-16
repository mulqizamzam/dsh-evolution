import { registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { analyzeTools } from './tools.ts'

export const name = 'analyze'
export const TOOLS = ['evo_analyze_patterns', 'evo_analyze_report'] as const
export const readEndpoints = {}
export const writeEndpoints = {}

export function apply(deps: ModuleDeps): void {
  for (const tool of analyzeTools(deps)) {
    registerToolSafe(deps.ctx, tool as never)
  }
}
