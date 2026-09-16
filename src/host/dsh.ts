/**
 * Minimal typed model of the host surface evolution uses.
 * Transcribed from dsh-cortex/src/host/dsh.ts (which mirrors HOST-API).
 * Every optional field in the host is optional here so a reduced profile
 * type-checks and degrades instead of crashing.
 */
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/** HOST-API §5 wire envelope. */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code?: string; message: string } }

/** Object output schema (host-supported subset). */
export const JSON_OBJECT_OUTPUT = {
  type: 'object',
  properties: {},
  additionalProperties: true,
}

/** HOST-API §4. */
export interface HostSettingsScope<T> {
  get(): T
}

export interface HostSettingsService {
  readonly writable: boolean
  register<T>(
    namespace: string,
    schema: unknown,
    options: { base?: Partial<T>; applies: 'live' | 'restart'; validate?: (value: T) => void },
  ): HostSettingsScope<T>
}

/** HOST-API §6 (subset). */
export interface HostAgent {
  id: string
  status: 'idle' | 'running'
  options?: { provider?: string; model?: string }
  session: { header?: { cwd?: string } }
  ctx: { on(name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): () => unknown }
}

export interface HostAgentsService {
  get(id: string): HostAgent | undefined
  roots(): HostAgent[]
  create?(options: unknown): Promise<unknown>
}

/** HOST-API §1: the cordis context a plugin `apply()` receives. */
export interface HostContextShape {
  tools: { register(def: ToolDefinition): void }
  settings: HostSettingsService
  agents: HostAgentsService
  /** Web-only; absent in non-web profiles. */
  connection?: unknown
  get(name: string): unknown
  inject(services: string[], callback: (ctx: HostContextShape) => void): unknown
  on(name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): () => unknown
  effect(callback: () => (() => unknown) | void, label?: string): () => unknown
  /** Cordis: mount a plugin (module object or function) under this fiber. */
  plugin?(plugin: unknown, config?: unknown): unknown
  /** Cordis: expose a non-service value for `get(name)`. Returns a disposer. */
  provide?(name: string, value: unknown): () => void
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: Record<string, unknown>, value: never) => Array<{ type: 'text'; text: string }>
  }
  execute: (args: never, execution: { signal: AbortSignal; agent?: HostAgent }) => Promise<unknown>
  presentCall?: (args: never) => Record<string, unknown>
  presentResult?: () => Record<string, unknown>
}

export function defineTool(def: ToolDefinition): ToolDefinition {
  return def
}

export function registerToolSafe(
  ctx: HostContextShape,
  definition: ToolDefinition,
): { name: string; ok: boolean; error?: string } {
  try {
    ctx.tools.register(definition)
    return { name: definition.name, ok: true }
  } catch (error) {
    return { name: definition.name, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function text(value: unknown): Array<{ type: 'text'; text: string }> {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  return [{ type: 'text', text: JSON.stringify(value) }]
}
