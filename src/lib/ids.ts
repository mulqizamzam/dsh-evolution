import { randomBytes } from 'node:crypto'

/** Generate a short random id (12 hex chars). */
export function newId(): string {
  return randomBytes(6).toString('hex')
}

/** ISO date string for today (UTC). */
export function isoDate(date?: Date): string {
  return (date ?? new Date()).toISOString().slice(0, 10)
}

/** ISO datetime string (UTC). */
export function isoDateTime(date?: Date): string {
  return (date ?? new Date()).toISOString()
}

/** Validate a key is safe for filesystem use (alphanum, dash, underscore, dot). */
export function isSafeKey(key: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(key)
}

/** Generate a version id like v1, v2, v3. */
export function versionId(n: number): string {
  return `v${String(n)}`
}
