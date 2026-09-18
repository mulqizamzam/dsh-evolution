import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Basename of this plugin's data directory inside the Harness home. */
export const STATE_DIR_NAME = 'dsh-evolution'

/** Shape of the host dshHomePath service. */
export type DshHomePath = (...segments: string[]) => string

/** Narrowed ctx.get, injected so unit tests need no host. */
export type ContextGet = (name: string) => unknown

/**
 * Profile-aware state root resolution.
 *
 * When a profile name is supplied, the state root is namespaced under it
 * so that different DSH profiles (e.g. "web" vs "evo-live") keep fully
 * independent mutable evolution state.  Without a profile name the legacy
 * flat path is returned for backward compatibility.
 *
 * Precedence:
 *   1. Explicit stateRoot in plugin config  (operator-authorized, always wins)
 *   2. Profile-namespaced dshHomePath        (prevents cross-profile bleed)
 *   3. Env fallback $DSH_HOME/dsh-evolution  (legacy, flat)
 */
export function resolveStateRoot(
  get: ContextGet | undefined,
  fallbackRoot: string | undefined,
  profileName?: string,
): string {
  // Resolve the base root: service wins, then env fallback.
  let base: string
  if (fallbackRoot !== undefined && fallbackRoot !== '') {
    base = fallbackRoot
  } else {
    try {
      const service = typeof get === 'function' ? get('dshHomePath') : undefined
      if (typeof service !== 'function') base = envStateRoot()
      else {
        const value = (service as DshHomePath)(STATE_DIR_NAME)
        base = typeof value === 'string' && value !== '' ? value : envStateRoot()
      }
    } catch {
      base = envStateRoot()
    }
  }

  // Append profile namespace when available.
  return profileName ? join(base, profileName) : base
}

/**
 * Fallback root: $DSH_HOME/dsh-evolution, else $HOME/.dsh/dsh-evolution.
 */
export function envStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return join(configured.trim(), STATE_DIR_NAME)
  const home = env.HOME ?? env.USERPROFILE
  if (typeof home === 'string' && home !== '') return join(home, '.dsh', STATE_DIR_NAME)
  return join('.dsh', STATE_DIR_NAME)
}

/** mkdir -p; returns the path. */
export async function ensureDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true })
  return path
}

/** Create the fixed scaffold every collection assumes exists. */
export async function ensureStateRoot(root: string): Promise<string> {
  await ensureDir(root)
  await ensureDir(join(root, 'experiences'))
  await ensureDir(join(root, 'candidates'))
  await ensureDir(join(root, 'versions'))
  await ensureDir(join(root, 'benchmarks'))
  await ensureDir(join(root, 'patterns'))
  await ensureDir(join(root, 'tmp'))
  return root
}
