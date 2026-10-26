import { errorMessage, makeLogger } from '../lib/errors.ts'
import { neutralize } from '../lib/sanitize.ts'
import { resolveStateRoot } from '../lib/home.ts'
import { cleanupTmpOrphans } from '../lib/fsx.ts'
import { Config, DEFAULT_CONFIG, INJECT_LABEL, resolveConfig } from './config.ts'
import type { EvoConfig } from './config.ts'
import { EvolutionStore, SCHEMA_VERSION } from './store.ts'
import type { ModuleDeps } from './types.ts'
import { JSON_OBJECT_OUTPUT, defineTool, registerToolSafe, text } from './dsh.ts'
import type { HostContextShape } from './dsh.ts'
import * as experienceModule from './modules/experience/index.ts'
import * as analyzeModule from './modules/analyze/index.ts'
import * as candidateModule from './modules/candidate/index.ts'
import * as benchmarkModule from './modules/benchmark/index.ts'
import * as promoteModule from './modules/promote/index.ts'
import * as evolutionModule from './modules/evolution/index.ts'
import * as statusModule from './modules/status/index.ts'
import * as sandboxModule from './modules/sandbox/index.ts'
import * as builderModule from './modules/builder/index.ts'
import * as autoExperienceModule from './modules/auto-experience/index.ts'
import * as activationModule from './modules/activation/index.ts'
import * as versionHistoryModule from './modules/version-history/index.ts'
import * as evidenceScoreModule from './modules/evidence-score/index.ts'
import * as shadowEvaluationModule from './modules/shadow-evaluation/index.ts'
import * as memoryLifecycleModule from './modules/memory-lifecycle/index.ts'
import * as adversarialBenchmarkModule from './modules/adversarial-benchmark/index.ts'

export const name = 'dsh-evolution'

/**
 * Plugin version — injected at build time by tsdown from package.json.
 * Do NOT import package.json directly: the bundled lib/ must not depend
 * on the source-tree layout at runtime (see the createRequire bug report).
 */
declare const PKG_VERSION: string
export const VERSION = typeof PKG_VERSION === 'string' && PKG_VERSION !== ''
  ? PKG_VERSION
  : '0.1.0'
export const inject = ['tools', 'settings', 'agents']

export interface EvoModule {
  name: string
  apply: (deps: ModuleDeps) => void
}

export const MODULES: EvoModule[] = [
  experienceModule,
  analyzeModule,
  candidateModule,
  benchmarkModule,
  promoteModule,
  evolutionModule,
  statusModule,
  sandboxModule,
  builderModule,
  autoExperienceModule,
  // Activation mounts the active version's artifact, so it must run last.
  activationModule,
  versionHistoryModule,
  evidenceScoreModule,
  shadowEvaluationModule,
  memoryLifecycleModule,
  adversarialBenchmarkModule,
] as unknown as EvoModule[]

/**
 * Plugin entry (HOST-API §1). The host calls `apply(ctx, config?)` where
 * config is the row from cordis.patch.yml. We pass it through schemastery
 * and register a live settings scope so the UI can hot-swap config.
 */
export async function apply(rawContext: unknown, rawConfig: Partial<EvoConfig> = {}): Promise<void> {
  const log = makeLogger('dsh-evolution')
  const ctx = rawContext as HostContextShape
  try {
    // Awaited so the promoted capability is mounted before the first turn.
    await boot(ctx, rawConfig, log)
    log.info('ready: ' + MODULES.map(function (m) { return m.name }).join(', '))
  } catch (error) {
    const detail = errorMessage(error)
    console.error('[dsh-evolution] boot failed; registering status-only tool:', detail)
    log.warn('boot failed: ' + detail)
    try {
      registerToolSafe(ctx, defineTool({
        name: 'evo_status',
        description: 'dsh-evolution failed to start; this status-only tool reports why. No other evo_* tool is available this session.',
        parameters: { type: 'object', properties: {} },
        output: { schema: JSON_OBJECT_OUTPUT, render: function (_args: Record<string, unknown>, value: never) { return text(value) } },
        execute: async () => ({
          plugin: 'dsh-evolution',
          state: 'failed',
          error: neutralize(detail),
          hint: 'Fix the cause and restart the host; plugin data on disk is untouched.',
        }),
      } as never))
    } catch {
      // Even the degraded path failing must not escape.
    }
  }
}

async function boot(ctx: HostContextShape, rawConfig: Partial<EvoConfig>, log: ReturnType<typeof makeLogger>): Promise<void> {
  // Config: compose defaults with host-provided config, then register a live
  // settings scope so the UI can hot-swap values without restart.
  let resolved = resolveConfig(rawConfig)
  try {
    const scope = ctx.settings.register<EvoConfig>('dsh-evolution', Config, { base: rawConfig as EvoConfig, applies: 'live' })
    try {
      resolved = resolveConfig(scope.get())
    } catch (error) {
      log.warn('settings scope read failed, using composed defaults: ' + errorMessage(error))
    }
  } catch (error) {
    // Settings service may be absent in reduced profiles; degrade silently.
    log.warn('settings.register unavailable: ' + errorMessage(error))
  }

  // Subscribe to live config updates (mirrors dsh-cortex pattern).
  try {
    ctx.on('settings/updated', (function (namespace: string, next: EvoConfig) {
      if (namespace !== 'dsh-evolution') return
      try {
        resolved = resolveConfig(next)
        log.info('config swapped (live)')
      } catch (error) {
        log.warn('config swap failed, keeping previous: ' + errorMessage(error))
      }
    }) as never)
  } catch {
    // Non-fatal in reduced profiles.
  }

  // Derive the running profile name from the host's baseUrl so the state root
  // is scoped per-profile and two independently-launched profiles cannot bleed
  // into each other's mutable evolution namespace.
  let profileName: string | undefined
  try {
    const ctxRecord = ctx as unknown as Record<string, unknown>
    const baseUrl = typeof ctxRecord.baseUrl === 'string'
      ? ctxRecord.baseUrl
      : ''
    if (baseUrl) {
      const url = new URL(baseUrl)
      // Extract the profile name from the last path segment before STATE_DIR_NAME.
      // e.g. file:///path/to/dsh/profiles/web/ → 'web'
      const dirPath = url.pathname
      const parts = dirPath.split('/')
      const idx = parts.lastIndexOf('profiles')
      if (idx >= 0 && idx + 1 < parts.length) {
        const name = parts[idx + 1]
        if (name && /^[a-z0-9_-]+$/.test(name)) profileName = name
      }
    }
  } catch {
    // ignore: non-standard baseUrl or parse failure; fall back to flat path
  }

  // State root: config override > host dshHomePath service (profile-scoped) > env fallback.
  //
  // A configured stateRoot is an operator-supplied ABSOLUTE root and is used
  // verbatim: the store receives no profileName so it cannot re-append one.
  // Otherwise profile scoping is delegated entirely to the store (it is the
  // only component that owns the "<base>/<profile>" contract).  Appending the
  // profile here AND passing it to the store appended it twice, producing
  // `<base>/web/web` — a root nothing else in the system ever reads.
  const getFn = function (name2: string) { return ctx.get(name2) }
  const configuredRoot = resolved.stateRoot
  const store = configuredRoot !== ''
    ? new EvolutionStore({ get: getFn, fallbackRoot: configuredRoot })
    : new EvolutionStore({ get: getFn, profileName })
  const root = store.getRoot()

  // Awaited: activation below reads the active version from disk, so the
  // scaffold must exist first.
  try {
    await store.init()
    // Clean up any .tmp.* orphans left by crashes in previous writeAtomic calls.
    const cleaned = await cleanupTmpOrphans(root)
    if (cleaned > 0) log.info('cleaned ' + cleaned + ' tmp orphan(s) at startup')
    log.info('state ready at ' + root)
  } catch (error) {
    log.warn('state scaffold failed: ' + errorMessage(error))
  }

  const cfg = function (): typeof resolved { return resolved }
  const deps: ModuleDeps = {
    ctx,
    cfg,
    store,
    log: function (message: string) { log.info(message) },
    warn: function (message: string) { log.warn(message) },
  }

  for (const module of MODULES) {
    try {
      module.apply(deps)
    } catch (error) {
      log.warn('module "' + module.name + '" failed, continuing: ' + errorMessage(error))
    }
  }

  // Boot-time activation (Step 13): a fresh host discovers the promoted
  // version's artifact and mounts it. Never fatal — a host with no active
  // version, or an artifact that fails pre-flight, boots normally.
  try {
    const { refreshActivation, activationState } = await import('./modules/activation/loader.ts')
    await refreshActivation(deps)
    const state = activationState()
    if (state.activeTool !== null) {
      log.info('activated ' + state.activeTool + ' from ' + String(state.activeVersionId))
    } else {
      log.info('no candidate activated: ' + String(state.reason ?? 'unknown'))
    }
  } catch (error) {
    log.warn('activation failed at boot: ' + errorMessage(error))
  }
}

export { Config, DEFAULT_CONFIG, INJECT_LABEL, resolveConfig, EvolutionStore, SCHEMA_VERSION }
