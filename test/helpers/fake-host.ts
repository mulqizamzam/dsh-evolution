/**
 * A faithful-enough Cordis host façade for tests.
 *
 * It implements the three verbs activation actually uses — `tools.register`,
 * `plugin`, `provide`/`get` — so a test can assert RUNTIME behaviour (which
 * tools exist and what they return) instead of only filesystem state.
 */

import type { HostContextShape, ToolDefinition } from '../../src/host/dsh.ts'

export interface FakeHost {
  ctx: HostContextShape
  /** Every tool currently registered, by name. */
  tools(): string[]
  /** Call one registered tool by name. */
  call(name: string, args?: Record<string, unknown>): Promise<unknown>
  /** Providers still alive. */
  provided(): string[]
  /** Plugins mounted right now. */
  mounted(): string[]
  /** Event names subscribed by the plugin under test. */
  listeners(event: string): Array<unknown>
  /** Mount a plugin object directly (as the loader would). */
  mount(plugin: unknown, config?: unknown): Promise<{ dispose: () => void }>
}

interface MountedPlugin {
  name: string
  dispose: () => void
}

export function makeFakeHost(seed?: { providers?: Record<string, unknown> }): FakeHost {
  const registry = new Map<string, ToolDefinition>()
  const providers = new Map<string, unknown>(Object.entries(seed?.providers ?? {}))
  const subscriptions = new Map<string, Array<unknown>>()
  const mounted: MountedPlugin[] = []

  const ctx = {
    tools: {
      register: (def: ToolDefinition) => {
        registry.set(def.name, def)
      },
    },
    settings: {
      writable: true,
      // Honour 'base' the way the real settings service does: activation reads
      // stateRoot from here, and an empty scope would silently fall back to the
      // process-wide DSH home.
      register: (_ns: string, _schema: unknown, options?: { base?: unknown }) => ({ get: () => options?.base ?? {} }),
    },
    agents: { get: () => undefined, roots: () => [] },
    get: (name: string) => providers.get(name),
    on: (event: string, listener: unknown) => {
      const list = subscriptions.get(event) ?? []
      list.push(listener)
      subscriptions.set(event, list)
      return () => {
        const current = subscriptions.get(event) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
      }
    },
    effect: (callback: () => (() => unknown) | void) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    provide: (name: string, value: unknown) => {
      providers.set(name, value)
      return () => { providers.delete(name) }
    },
    plugin: (plugin: unknown, config?: unknown) => {
      const moduleObject = plugin as { name?: string; apply?: (c: unknown, cfg?: unknown) => unknown }
      const name = typeof moduleObject?.name === 'string' ? moduleObject.name : 'anon'
      if (typeof moduleObject?.apply !== 'function') {
        throw new Error('plugin has no apply()')
      }
      // Cordis scopes registrations to the mounted fiber: disposing a plugin
      // unregisters what it registered. Model that, or a disposal would look
      // like a no-op to callers.
      const owned = new Set<string>()
      const register = ctx.tools.register.bind(ctx.tools)
      ;(ctx.tools as { register: (def: ToolDefinition) => void }).register = (def: ToolDefinition) => {
        owned.add(def.name)
        register(def)
      }
      const record: MountedPlugin = {
        name,
        dispose: () => {
          for (const toolName of owned) registry.delete(toolName)
          ;(ctx.tools as { register: (def: ToolDefinition) => void }).register = register
          const index = mounted.indexOf(record)
          if (index >= 0) mounted.splice(index, 1)
        },
      }
      moduleObject.apply(ctx, config)
      mounted.push(record)
      return record
    },
  } as unknown as HostContextShape

  return {
    ctx,
    tools: () => [...registry.keys()].sort(),
    async call(name, args = {}) {
      const def = registry.get(name)
      if (!def) throw new Error('no such tool: ' + name)
      return await def.execute(args as never, { signal: AbortSignal.timeout(60_000) })
    },
    provided: () => [...providers.keys()],
    listeners: (event: string) => [...(subscriptions.get(event) ?? [])],
    mounted: () => mounted.map(m => m.name),
    async mount(plugin, config) {
      const record = (ctx as unknown as { plugin: (p: unknown, c?: unknown) => MountedPlugin }).plugin(plugin, config)
      return { dispose: record.dispose }
    },
  }
}
