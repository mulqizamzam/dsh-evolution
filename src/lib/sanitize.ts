/**
 * Model-visible text safety and lossless-JSON safety in one pass.
 *
 * Two host rules drive this module:
 *
 * 1. RULE (host issue-class #53): brace pairs in model-visible text can throw
 *    in the prompt renderer and deadlock a turn, so `{{`/`}}` are stripped.
 * 2. RULE (host tools core): a tool return value is snapshotted with
 *    `snapshotJsonValue`, which REJECTS any `undefined` property, non-finite
 *    number, `-0`, cyclic reference, sparse array, or non-plain object. A
 *    rejected value fails the whole tool call with "value is not lossless
 *    JSON" — the tool ran, but the caller never sees its result.
 */

/** Strip brace pairs from model-visible text. */
export function neutralize(input: string): string {
  if (typeof input !== 'string') return ''
  return input.replace(/\{\{/g, '').replace(/\}\}/g, '')
}

/** Sentinel meaning "this value cannot be represented; the caller drops it". */
const DROP = Symbol('drop')

/**
 * Convert one value into lossless JSON, neutralizing strings on the way.
 * @param value - candidate value of any type.
 * @param ancestors - objects on the current path, for cycle detection.
 * @returns the lossless value, or {@link DROP} when it cannot be represented.
 */
function toLossless(value: unknown, ancestors: Set<object>): unknown {
  if (value === null) return null

  switch (typeof value) {
    case 'string':
      return neutralize(value)
    case 'boolean':
      return value
    case 'number': {
      const n = value
      if (!Number.isFinite(n)) return null          // NaN / Infinity have no JSON form
      return Object.is(n, -0) ? 0 : n               // -0 is rejected by the host
    }
    case 'bigint':
      return String(value)
    case 'undefined':
    case 'function':
    case 'symbol':
      return DROP
    default:
      break
  }

  const object = value as object
  if (ancestors.has(object)) return DROP            // cycle: unrepeatable

  if (Array.isArray(object)) {
    ancestors.add(object)
    const out: unknown[] = []
    for (const item of object) {
      const converted = toLossless(item, ancestors)
      // A hole or dropped item becomes null so the array stays dense.
      out.push(converted === DROP ? null : converted)
    }
    ancestors.delete(object)
    return out
  }

  if (object instanceof Date) return object.toISOString()

  const prototype = Object.getPrototypeOf(object)
  if (prototype !== Object.prototype && prototype !== null) {
    // Exotic instance (Map, Set, class): keep whatever survives a JSON
    // round-trip, and drop it entirely when nothing does.
    try {
      return toLossless(JSON.parse(JSON.stringify(object)), ancestors)
    } catch {
      return DROP
    }
  }

  ancestors.add(object)
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(object as Record<string, unknown>)) {
    const converted = toLossless(item, ancestors)
    // DROP, never emit `undefined`: one undefined property invalidates the
    // host's lossless-JSON snapshot for the entire result.
    if (converted === DROP) continue
    // Object keys carry user text just like values: strip brace pairs from
    // them too, otherwise `{{`/`}}` in a metadata key survives neutralizeDeep.
    out[neutralize(key)] = converted
  }
  ancestors.delete(object)
  return out
}

/**
 * Neutralize brace pairs and guarantee the result satisfies the host's
 * lossless-JSON contract. Use on EVERY tool return value.
 */
export function neutralizeDeep<T>(obj: T): T {
  const converted = toLossless(obj, new Set<object>())
  return (converted === DROP ? null : converted) as T
}
