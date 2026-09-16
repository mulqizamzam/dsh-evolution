import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// lib tests
import { neutralize, neutralizeDeep } from '../src/lib/sanitize.ts'
import { clampText } from '../src/lib/caps.ts'
import { newId, isoDate, isSafeKey, versionId } from '../src/lib/ids.ts'
import { errorMessage, attempt, attemptSync } from '../src/lib/errors.ts'
import { resolveStateRoot, envStateRoot, ensureStateRoot } from '../src/lib/home.ts'
import { readJsonSafe, writeJsonAtomic, listDir } from '../src/lib/fsx.ts'

describe('sanitize', () => {
  it('neutralize removes brace pairs', () => {
    expect(neutralize('{{test}}')).toBe('test')
    expect(neutralize('hello {{world}} and {{universe}}')).toBe('hello world and universe')
  })

  it('neutralizeDeep neutralizes nested strings', () => {
    const obj = { a: '{{injected}}', b: [{ c: 'safe' }, { d: '{{bad}}' }] }
    const result = neutralizeDeep(obj)
    expect(result.a).toBe('injected')
    expect(result.b[0].c).toBe('safe')
    expect(result.b[1].d).toBe('bad')
  })

  it('neutralizeDeep handles null/primitives', () => {
    expect(neutralizeDeep(null)).toBe(null)
    expect(neutralizeDeep(42)).toBe(42)
    expect(neutralizeDeep('text')).toBe('text')
  })
})

/**
 * The host snapshots every tool return value with `snapshotJsonValue`, which
 * rejects `undefined` properties, non-finite numbers, `-0`, cycles, sparse
 * arrays and non-plain objects. A rejection fails the whole tool call with
 * "value is not lossless JSON" even though the tool ran. These tests pin the
 * lossless contract; `test/lossless-host-validator.spec.ts` re-checks it
 * against the host's own validator.
 */
describe('neutralizeDeep produces lossless JSON', () => {
  it('drops undefined properties instead of emitting them', () => {
    const result = neutralizeDeep({ ok: true, error: undefined, nested: { missing: undefined, kept: 1 } }) as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(result, 'error')).toBe(false)
    expect(Object.keys(result.nested as object)).toEqual(['kept'])
    expect(JSON.stringify(result)).toBe('{"ok":true,"nested":{"kept":1}}')
  })

  it('drops undefined inside arrays as null to keep them dense', () => {
    const result = neutralizeDeep([1, undefined, 3]) as unknown[]
    expect(result).toEqual([1, null, 3])
    expect(result.length).toBe(3)
  })

  it('maps non-finite numbers and negative zero to JSON-safe values', () => {
    const result = neutralizeDeep({ nan: NaN, inf: Infinity, ninf: -Infinity, neg: -0 }) as Record<string, number>
    expect(result.nan).toBe(null)
    expect(result.inf).toBe(null)
    expect(result.ninf).toBe(null)
    expect(Object.is(result.neg, 0)).toBe(true)
  })

  it('converts Date to an ISO string', () => {
    const result = neutralizeDeep({ when: new Date('2026-09-16T00:00:00.000Z') }) as Record<string, string>
    expect(result.when).toBe('2026-09-16T00:00:00.000Z')
  })

  it('breaks cycles instead of throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'a' }
    cyclic.self = cyclic
    const result = neutralizeDeep(cyclic) as Record<string, unknown>
    expect(result.name).toBe('a')
    expect(Object.prototype.hasOwnProperty.call(result, 'self')).toBe(false)
  })

  it('drops functions and symbols', () => {
    const result = neutralizeDeep({ fn: () => 1, sym: Symbol('s'), kept: 'yes' }) as Record<string, unknown>
    expect(Object.keys(result)).toEqual(['kept'])
  })

  it('survives a JSON round trip with no undefined anywhere', () => {
    const messy = {
      a: undefined, b: { c: undefined, d: [1, undefined] }, e: NaN, f: new Date(0), g: null,
    }
    const result = neutralizeDeep(messy)
    const roundTripped = JSON.parse(JSON.stringify(result))
    expect(JSON.stringify(result)).toBe(JSON.stringify(roundTripped))
    expect(JSON.stringify(result)).not.toContain('undefined')
  })
})

describe('caps', () => {
  it('clampText truncates long strings', () => {
    const long = 'a'.repeat(1000)
    expect(clampText(long, 10).length).toBe(10)
    expect(clampText(long, 10)).toBe('aaaaaaa...')
  })

  it('clampText returns short strings as-is', () => {
    expect(clampText('hello', 10)).toBe('hello')
  })

  it('clampText handles empty/non-string', () => {
    expect(clampText('', 10)).toBe('')
    expect(clampText(null as never, 10)).toBe('')
  })
})

describe('ids', () => {
  it('newId returns 12-char hex', () => {
    const id = newId()
    expect(id.length).toBe(12)
    expect(/^[0-9a-f]{12}$/.test(id)).toBe(true)
  })

  it('newId returns unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newId()))
    expect(ids.size).toBe(100)
  })

  it('isoDate returns YYYY-MM-DD', () => {
    expect(/^\d{4}-\d{2}-\d{2}$/.test(isoDate())).toBe(true)
  })

  it('isSafeKey validates safe keys', () => {
    expect(isSafeKey('abc123')).toBe(true)
    expect(isSafeKey('my-file.json')).toBe(true)
    expect(isSafeKey('')).toBe(false)
    expect(isSafeKey('../attack')).toBe(false)
    expect(isSafeKey('/absolute')).toBe(false)
  })

  it('versionId formats correctly', () => {
    expect(versionId(1)).toBe('v1')
    expect(versionId(42)).toBe('v42')
  })
})

describe('errors', () => {
  it('errorMessage extracts from Error objects', () => {
    expect(errorMessage(new Error('test'))).toBe('test')
    expect(errorMessage('string error')).toBe('string error')
    expect(errorMessage(42)).toBe('42')
  })

  it('attempt returns ok envelope on success', async () => {
    const result = await attempt(async () => 42)
    expect(result.ok).toBe(true)
    expect(result.value).toBe(42)
  })

  it('attempt returns error envelope on failure', async () => {
    const result = await attempt(async () => { throw new Error('fail') })
    expect(result.ok).toBe(false)
    expect(result.message).toBe('fail')
  })

  it('attemptSync works', () => {
    expect(attemptSync(() => 42).value).toBe(42)
    expect(attemptSync(() => { throw new Error('boom') }).ok).toBe(false)
  })
})

describe('home', () => {
  it('resolveStateRoot uses get callback', () => {
    const get = () => ((...args: string[]) => args.join('/'))
    const root = resolveStateRoot(get as never)
    expect(root).toContain('dsh-evolution')
  })

  it('resolveStateRoot falls back to env', () => {
    const root = resolveStateRoot(undefined, '/tmp/test-evo')
    expect(root).toBe('/tmp/test-evo')
  })

  it('envStateRoot uses DSH_HOME', () => {
    const root = envStateRoot({ DSH_HOME: '/my/home' })
    expect(root).toBe('/my/home/dsh-evolution')
  })

  it('ensureStateRoot creates directories', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'evo-home-'))
    try {
      await ensureStateRoot(tmp)
      const dirs = ['experiences', 'candidates', 'versions', 'benchmarks', 'patterns', 'tmp']
      for (const d of dirs) {
        const { access } = await import('node:fs/promises')
        await access(join(tmp, d))
      }
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})

describe('fsx', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'evo-fsx-'))
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('readJsonSafe returns null for missing file', async () => {
    expect(await readJsonSafe(join(tmp, 'missing.json'))).toBeNull()
  })

  it('writeJsonAtomic + readJsonSafe round-trip', async () => {
    const path = join(tmp, 'data.json')
    await writeJsonAtomic(path, { hello: 'world' })
    const data = await readJsonSafe(path)
    expect(data).toEqual({ hello: 'world' })
  })

  it('listDir returns empty for missing dir', async () => {
    expect(await listDir(join(tmp, 'missing'))).toEqual([])
  })

  it('listDir returns files', async () => {
    await writeJsonAtomic(join(tmp, 'a.json'), { a: 1 })
    await writeJsonAtomic(join(tmp, 'b.json'), { b: 2 })
    const files = await listDir(tmp)
    expect(files.length).toBe(2)
  })
})
