import { registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps } from '../../types.ts'
import { benchmarkTools } from './tools.ts'

export const name = 'benchmark'
export const TOOLS = ['evo_benchmark_run', 'evo_benchmark_compare', 'evo_benchmark_live', 'evo_benchmark_ab'] as const
export const readEndpoints = {}
export const writeEndpoints = {}

export function apply(deps: ModuleDeps): void {
  for (const tool of benchmarkTools(deps)) {
    registerToolSafe(deps.ctx, tool as never)
  }
}
