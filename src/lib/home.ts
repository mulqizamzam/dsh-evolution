import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Basename of this plugin's data directory inside the Harness home. */
export const STATE_DIR_NAME = 'dsh-evolution'

/** Shape of the host dshHomePath service. */
export type DshHomePath = (...segments: string[]) => string

/** Narrowed ctx.get, injected so unit tests need no host. */
export type ContextGet = (name: string) => unknown

/**
 * Resolve the state root.
 * The host dshHomePath service wins; fallback is env-based.
 */
export function resolveStateRoot(get: ContextGet | undefined, fallbackRoot: string = envStateRoot()): string {
  try {
    const service = typeof get === 'function' ? get('dshHomePath') : undefined
    if (typeof service !== 'function') return fallbackRoot
    const value = (service as DshHomePath)(STATE_DIR_NAME)
    return typeof value === 'string' && value !== '' ? value : fallbackRoot
  } catch {
    return fallbackRoot
  }
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
