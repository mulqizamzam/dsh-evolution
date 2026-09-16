/** Extract an error message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

/** A result envelope. */
export interface EvoResult<T> {
  ok: boolean
  value?: T
  message?: string
}

/** Wrap an async function in try/catch, returning a result envelope. */
export async function attempt<T>(fn: () => Promise<T>): Promise<EvoResult<T>> {
  try {
    const value = await fn()
    return { ok: true, value }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

/** Wrap a sync function in try/catch. */
export function attemptSync<T>(fn: () => T): EvoResult<T> {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

/** Simple logger. */
export type LogFn = (message: string) => void

export function makeLogger(prefix: string): { info: LogFn; warn: LogFn } {
  return {
    info: (msg: string) => { /* noop in production; tests can capture */ },
    warn: (msg: string) => { /* noop in production; tests can capture */ },
  }
}
