/**
 * Activation module: the boot-time and runtime side of candidate activation.
 *
 * It provides the `evolutionRuntime` service the generated artifact calls, and
 * exposes diagnostics. The heavy lifting lives in ./artifact.ts (build the
 * loadable package) and ./loader.ts (validate, pre-flight, mount).
 */

import { JSON_OBJECT_OUTPUT, defineTool, registerToolSafe, text } from '../../dsh.ts'
import type { ModuleDeps, ToolDefinition } from '../../types.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'
import { getSandbox } from '../sandbox/index.ts'
import { artifactManifestPath, artifactPluginPath, versionDir } from './artifact.ts'
import {
  activationState, createRuntimeService, refreshActivation, setActivationSandbox,
} from './loader.ts'

export const name = 'activation'
export const TOOLS = ['evo_activation_status', 'evo_activation_refresh'] as const
export const readEndpoints = {}
export const writeEndpoints = {}

const RENDER = (_a: Record<string, unknown>, v: never): Array<{ type: 'text'; text: string }> => text(v)

export function apply(deps: ModuleDeps): void {
  // The sandbox must be shared: activation executes candidate code through the
  // same runner the rest of the plugin uses.
  setActivationSandbox(getSandbox())

  // The generated plugin resolves this service to execute candidate code.
  if (typeof deps.ctx.provide === 'function') {
    const dispose = deps.ctx.provide('evolutionRuntime', createRuntimeService(deps))
    if (typeof deps.ctx.effect === 'function' && typeof dispose === 'function') {
      deps.ctx.effect(() => dispose)
    }
  } else {
    deps.warn('activation: ctx.provide is unavailable; the generated plugin cannot reach the sandbox service')
  }

  const statusTool: ToolDefinition = {
    name: 'evo_activation_status',
    description: 'Report which version artifact is currently mounted in this host, which tool it registered, and why activation did not happen when it did not.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async () => {
      const root = deps.store.getRoot()
      const active = await deps.store.getActiveVersion()
      const state = activationState()
      return neutralizeDeep({
        mountedVersionId: state.activeVersionId,
        mountedTool: state.activeTool,
        reason: state.reason,
        preflight: state.preflight,
        activeVersionInStore: active ? active.id : null,
        activeModules: active ? active.modules : [],
        artifactPath: active ? artifactPluginPath(root, active.id) : null,
        artifactManifestPath: active ? artifactManifestPath(root, active.id) : null,
        artifactDir: active ? versionDir(root, active.id) : null,
      })
    },
  } as never

  const refreshTool: ToolDefinition = {
    name: 'evo_activation_refresh',
    description: 'Re-read the active version and mount (or unmount) its artifact so the running host matches the promoted version.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async () => {
      await refreshActivation(deps)
      const state = activationState()
      return neutralizeDeep({ mountedVersionId: state.activeVersionId, mountedTool: state.activeTool, reason: state.reason })
    },
  } as never

  registerToolSafe(deps.ctx, statusTool)
  registerToolSafe(deps.ctx, refreshTool)
  deps.log('activation: registered evo_activation_status, evo_activation_refresh')
}
