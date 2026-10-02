/**
 * Activation: making the ACTIVE version's artifact live inside a running host.
 *
 * Boot path: dsh-evolution's apply() calls {@link refreshActivation}, which
 * reads the active version, validates its artifact, runs the sandbox
 * pre-flight, and mounts the generated plugin through `ctx.plugin`.
 *
 * Runtime path: promotion and rollback call the same function, so the live
 * process reflects the new active version without a restart.
 *
 * Safety: nothing here imports candidate code. The imported module is the
 * host-authored `plugin.js`; candidate files only ever execute inside the
 * sandbox (pre-flight and tool calls alike).
 */

import { pathToFileURL } from 'node:url'
import { readFile, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { readdirSync } from 'node:fs'
import {
  artifactFilesDir, artifactPluginPath, readArtifactManifest, validateArtifact, versionDir,
} from './artifact.ts'
import type { ArtifactManifest } from './artifact.ts'
import { containPath } from '../../../lib/contain.ts'
import type { ModuleDeps, SandboxRunner } from '../../types.ts'
import { getSandbox } from '../sandbox/index.ts'
import { errorMessage } from '../../../lib/errors.ts'

/** What the activation manager currently has mounted. */
export interface ActivationState {
  /** Version whose artifact is mounted, or null. */
  activeVersionId: string | null
  /** Tool the mounted plugin registered, or null. */
  activeTool: string | null
  /** Why activation did not happen, when it did not. */
  reason: string | null
  /** Pre-flight evidence for the last successful activation. */
  preflight: { syntaxOk: boolean; behaviorOk: boolean; detail: string } | null
}

const state: ActivationState = {
  activeVersionId: null,
  activeTool: null,
  reason: null,
  preflight: null,
}

let mountedFiber: { dispose?: () => unknown } | null = null
let sandboxRef: SandboxRunner | null = null

/**
 * The sandbox used for pre-flight and for the activated tool. Falls back to the
 * shared singleton, so activation never depends on module mount order.
 */
function runner(): SandboxRunner {
  return sandboxRef ?? getSandbox()
}

export function activationState(): ActivationState {
  return { ...state, preflight: state.preflight === null ? null : { ...state.preflight } }
}

export function setActivationSandbox(runner: SandboxRunner): void {
  sandboxRef = runner
}

/** Reset for tests. */
export function resetActivation(): void {
  state.activeVersionId = null
  state.activeTool = null
  state.reason = null
  state.preflight = null
  mountedFiber = null
}

/**
 * Run the version's code inside the sandbox and require a clean exit. This is
 * real execution evidence, not a filesystem check.
 */
async function runInSandbox(
  deps: ModuleDeps,
  cwd: string,
  command: string,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  const sandbox = runner()
  try {
    if (!(await sandbox.isAvailable())) return { ok: false, detail: 'sandbox is not available on this host' }
    const result = await sandbox.exec(command, { cwd, timeoutMs })
    const ok = result.exitCode === 0 && !result.timedOut
    return {
      ok,
      detail: command + ' -> exit ' + String(result.exitCode)
        + (result.timedOut ? ' (timed out)' : '')
        + (ok ? '' : ' :: ' + (result.stderr || result.stdout).slice(0, 300)),
    }
  } catch (error) {
    return { ok: false, detail: command + ' failed: ' + errorMessage(error) }
  }
}

/**
 * Pre-flight an artifact before the host loads it:
 *  1. the generated plugin must be syntactically valid JavaScript;
 *  2. the candidate's own entry must execute cleanly in the sandbox.
 * A candidate that cannot pass both is never activated.
 */
async function preflight(
  deps: ModuleDeps,
  versionId: string,
  manifest: ArtifactManifest,
): Promise<{ ok: boolean; syntaxOk: boolean; behaviorOk: boolean; detail: string }> {
  const root = deps.store.getRoot()
  const syntax = await runInSandbox(deps, versionDir(root, versionId), 'node --check plugin.js', 15_000)
  if (!syntax.ok) {
    return { ok: false, syntaxOk: false, behaviorOk: false, detail: 'generated plugin.js failed syntax check: ' + syntax.detail }
  }

  const behavior = await runInSandbox(
    deps,
    artifactFilesDir(root, versionId),
    manifest.testCommand,
    30_000,
  )
  return {
    ok: behavior.ok,
    syntaxOk: true,
    behaviorOk: behavior.ok,
    detail: syntax.detail + ' | ' + behavior.detail,
  }
}

/** Unmount whatever is currently active. Safe to call when nothing is mounted. */
export async function deactivate(reason: string | null): Promise<void> {
  const fiber = mountedFiber
  mountedFiber = null
  state.activeVersionId = null
  state.activeTool = null
  state.preflight = null
  state.reason = reason
  if (fiber && typeof fiber.dispose === 'function') {
    try {
      await fiber.dispose()
    } catch {
      // Disposal failure must not escape into the host.
    }
  }
}

/**
 * Load the artifact for one version and mount it.
 * @returns the mounted tool name, or null with {@link activationState}.reason set.
 */
export async function activateVersion(deps: ModuleDeps, versionId: string): Promise<string | null> {
  const root = deps.store.getRoot()

  // No early return on module state: within one process the mounted fiber can
  // be gone (host reload, disposal) while the state still names it, and a fresh
  // host needs its own mount. Deactivate-then-mount is the only safe order.
  await deactivate(null)

  const validation = await validateArtifact(root, versionId)
  if (!validation.valid) {
    state.reason = 'artifact for ' + versionId + ' is not loadable: ' + validation.errors.join('; ')
    return null
  }

  const manifest = await readArtifactManifest(root, versionId)
  if (!manifest) {
    state.reason = 'artifact manifest for ' + versionId + ' disappeared during validation'
    return null
  }

  const flight = await preflight(deps, versionId, manifest)
  if (!flight.ok) {
    state.reason = 'pre-flight refused ' + versionId + ': ' + flight.detail
    return null
  }

  // Only the host-authored module is imported; candidate files are data.
  const pluginPath = artifactPluginPath(root, versionId)
  let module: unknown
  try {
    module = await import(pathToFileURL(pluginPath).href)
  } catch (error) {
    state.reason = 'importing the generated plugin failed: ' + errorMessage(error)
    return null
  }

  const ctx = deps.ctx
  if (typeof ctx.plugin !== 'function') {
    state.reason = 'the host context does not expose ctx.plugin; dynamic activation is unavailable'
    return null
  }

  try {
    const fiber = ctx.plugin(module, {
      versionId,
      candidateId: manifest.candidateId,
      toolName: manifest.toolName,
      testCommand: manifest.testCommand,
    }) as { dispose?: () => unknown }
    await (fiber as unknown as Promise<unknown>)
    mountedFiber = fiber
  } catch (error) {
    state.reason = 'mounting the generated plugin failed: ' + errorMessage(error)
    return null
  }

  state.activeVersionId = versionId
  state.activeTool = manifest.toolName
  state.reason = null
  state.preflight = { syntaxOk: flight.syntaxOk, behaviorOk: flight.behaviorOk, detail: flight.detail }
  deps.log('activation: mounted ' + manifest.toolName + ' for ' + versionId)
  return manifest.toolName
}

/**
 * Clean up orphaned .staging directories from previously-crashed materializations.
 * Safe to call on every refresh — only removes directories whose sibling (without
 * the suffix) does not contain a valid manifest.  Never touches live artifacts.
 */
async function pruneStaleStaging(stateRoot: string): Promise<void> {
  try {
    const entries = readdirSync(join(stateRoot, 'versions'))
    for (const entry of entries) {
      if (!entry.endsWith('.staging')) continue
      const siblingId = entry.slice(0, -'.staging'.length)
      // If the sibling is a version directory with a valid manifest, the staging
      // dir may be an in-progress replacement — skip it.
      const siblingManifest = join(stateRoot, 'versions', siblingId, 'manifest.json')
      try {
        await readFile(siblingManifest, 'utf8')
        continue
      } catch {
        // No valid manifest in the sibling — the staging dir is an orphan.
      }
      await rm(join(stateRoot, 'versions', entry), { recursive: true, force: true })
    }
  } catch {
    // Pruning must never break activation.
  }
}

/**
 * Bring the mounted plugin in line with the ACTIVE version. Called at boot and
 * after every promotion/rollback. Never throws.
 */
export async function refreshActivation(deps: ModuleDeps): Promise<void> {
  // Clean up any stale .staging directories left by previously-crashed
  // materializations before attempting to mount the active artifact.
  await pruneStaleStaging(deps.store.getRoot())
  try {
    const active = await deps.store.getActiveVersion()
    if (!active) {
      await deactivate('no active version')
      return
    }
    // Prefer the version's own module list; fall back to the version id.
    const candidateId = active.modules[0]
    if (!candidateId) {
      await deactivate('active version ' + active.id + ' has no promoted module')
      return
    }

    const tool = await activateVersion(deps, active.id)
    if (tool === null) {
      deps.warn('activation: ' + String(state.reason))
    }
  } catch (error) {
    await deactivate('activation failed: ' + errorMessage(error))
    deps.warn('activation: ' + String(state.reason))
  }
}

/**
 * The service the generated plugin calls. Execution goes through the same
 * sandbox runner the rest of the plugin uses, with the version's own file copy
 * as the working directory.
 */
export interface EvolutionRuntimeService {
  runCandidate(request: { versionId: string; command?: string; timeoutMs?: number }): Promise<Record<string, unknown>>
}

export function createRuntimeService(deps: ModuleDeps): EvolutionRuntimeService {
  return {
    async runCandidate(request) {
      const root = deps.store.getRoot()
      const versionId = request.versionId
      const manifest = await readArtifactManifest(root, versionId)
      if (!manifest) {
        return { ok: false, error: 'no artifact for version ' + versionId, versionId }
      }

      const sandbox = runner()
      if (!(await sandbox.isAvailable())) {
        return { ok: false, error: 'sandbox is not available on this host', versionId }
      }

      const command = request.command ?? manifest.testCommand
      const cwd = artifactFilesDir(root, versionId)
      const timeoutMs = typeof request.timeoutMs === 'number' ? request.timeoutMs : 30_000

      const result = await sandbox.exec(command, { cwd, timeoutMs })
      const passed = result.exitCode === 0 && !result.timedOut
      return {
        ok: true,
        passed,
        versionId,
        candidateId: manifest.candidateId,
        tool: manifest.toolName,
        command,
        sandbox: sandbox.name,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdout: result.stdout.slice(0, 10_000),
        stderr: result.stderr.slice(0, 10_000),
      }
    },
  }
}

/** Absolute path to a version's copied candidate entry file (diagnostics). */
export function artifactEntryPath(stateRoot: string, versionId: string, entryPoint: string): string {
  const filesRoot = artifactFilesDir(stateRoot, versionId)
  const target = containPath(filesRoot, entryPoint)
  if (target === null) {
    throw new Error('entry point escapes the artifact files root: ' + JSON.stringify(String(entryPoint)))
  }
  return target
}

/** Read a copied artifact file (diagnostics/tests). */
export async function readArtifactFile(stateRoot: string, versionId: string, path: string): Promise<string | null> {
  const filesRoot = artifactFilesDir(stateRoot, versionId)
  // Lexical containment first: reject without touching the filesystem.
  const target = containPath(filesRoot, path)
  if (target === null) return null
  // For a path that points to an EXISTING file we are about to read, the file
  // may have been turned into a symlink AFTER materialization (tampered
  // persisted artifact — T10/T11 class). Resolve the real filesystem target
  // and re-check containment against the real files root so a symlink that
  // points outside cannot be followed.
  try {
    const realRoot = await realpath(filesRoot)
    let realTarget: string
    try {
      realTarget = await realpath(target)
    } catch {
      return null // not found
    }
    if (containPath(realRoot, realTarget) === null) return null // symlink points outside
    return await readFile(realTarget, 'utf8')
  } catch {
    return null
  }
}
