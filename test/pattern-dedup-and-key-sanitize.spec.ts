/**
 * Regression: pattern dedup key must not embed mutable state, and
 * neutralizeDeep must sanitize object KEYS as well as string values.
 *
 * Both tests go through the real tool execute() path, not the pure helpers,
 * so they cover the tool registry return-value boundary the host snapshots.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { ModuleDeps } from '../src/host/types.ts'
import { experienceTools } from '../src/host/modules/experience/tools.ts'
import { analyzeTools } from '../src/host/modules/analyze/tools.ts'
import type { HostContextShape } from '../src/host/dsh.ts'

describe('pattern dedup survives a change in occurrence count', () => {
  let tmpRoot: string
  let store: EvolutionStore
  let deps: ModuleDeps

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-dedup-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
    const ctx: HostContextShape = {
      tools: { register: () => {} },
      settings: { writable: true, register: (_ns: string, _schema: unknown, opts: { base?: unknown }) => ({ get: () => opts.base ?? {} }) },
      agents: { get: () => undefined, roots: () => [] },
      get: () => undefined,
      on: () => () => {},
      effect: () => () => {},
    }
    deps = {
      ctx,
      cfg: () => resolveConfig({ stateRoot: tmpRoot }),
      store,
      log: () => {},
      warn: () => {},
    }
  })
  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  async function seedFailures(n: number, marker: string): Promise<void> {
    for (let i = 0; i < n; i++) {
      await store.addExperience({
        success: false,
        errors: ['TimeoutError: upstream timed out'],
        stepCount: 12,
        prompt: marker + '-' + i,
      })
    }
  }

  it('does not persist a second pattern when the same signature gains occurrences', async () => {
    await seedFailures(3, 'round-one')
    const analyze = analyzeTools(deps).find(t => t.name === 'evo_analyze_patterns')!

    const first = await analyze.execute(
      { minOccurrences: 3 } as never,
      { signal: AbortSignal.timeout(5000) },
    ) as { detected: number; patterns: Array<{ description: string }> }
    expect(first.detected).toBeGreaterThan(0)
    const afterFirst = await store.listPatterns(500)
    expect(afterFirst.length).toBeGreaterThan(0)

    // The signature is unchanged, but its occurrence count grows 3 -> 6. A dedup
    // key that embeds the count produces a different description here and the
    // store accumulates a duplicate record.
    await seedFailures(3, 'round-two')

    const second = await analyze.execute(
      { minOccurrences: 3 } as never,
      { signal: AbortSignal.timeout(5000) },
    ) as { detected: number; patterns: Array<{ description: string }> }
    expect(second.detected).toBe(0)
    expect(second.patterns).toHaveLength(0)

    const afterSecond = await store.listPatterns(500)
    expect(afterSecond.length).toBe(afterFirst.length)
    const descriptions = afterSecond.map(p => p.description)
    expect(new Set(descriptions).size).toBe(descriptions.length)
  })

  it('detected description carries no embedded occurrence count', async () => {
    await seedFailures(3, 'count-probe')
    const analyze = analyzeTools(deps).find(t => t.name === 'evo_analyze_patterns')!
    const result = await analyze.execute(
      { minOccurrences: 3 } as never,
      { signal: AbortSignal.timeout(5000) },
    ) as { patterns: Array<{ description: string; occurrences: number }> }
    const signature = result.patterns.find(p => p.description.includes('TimeoutError'))
    expect(signature).toBeDefined()
    expect(signature!.description).not.toContain('observed 3 times')
    expect(signature!.occurrences).toBe(3)
  })
})

describe('neutralizeDeep sanitizes object keys', () => {
  let tmpRoot: string
  let store: EvolutionStore
  let deps: ModuleDeps

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-keys-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
    const ctx: HostContextShape = {
      tools: { register: () => {} },
      settings: { writable: true, register: (_ns: string, _s: unknown, o: { base?: unknown }) => ({ get: () => o.base ?? {} }) },
      agents: { get: () => undefined, roots: () => [] },
      get: () => undefined, on: () => () => {}, effect: () => () => {},
    }
    deps = {
      ctx,
      cfg: () => resolveConfig({ stateRoot: tmpRoot }),
      store,
      log: () => {},
      warn: () => {},
    }
  })
  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  it('strips brace pairs from free-form metadata keys returned by a tool', async () => {
    const record = experienceTools(deps).find(t => t.name === 'evo_experience_record')!
    const result = await record.execute(
      {
        success: true,
        summary: 'recorded from a hostile payload',
        metadata: { '{{inject}}': 'value', '}}inject{{': 1, safe: 'ok' },
      } as never,
      { signal: AbortSignal.timeout(5000) },
    ) as { metadata: Record<string, unknown> }

    const keys = Object.keys(result.metadata)
    // No key should retain literal {{ or }}
    expect(keys.some(k => k.includes('{{') || k.includes('}}'))).toBe(false)
    expect(keys).toContain('safe')
    // Keys retain their identity after brace-pair removal.
    expect(keys).toContain('inject')
  })

  it('keys nested deeper are also sanitized and survive structurally', async () => {
    const record = experienceTools(deps).find(t => t.name === 'evo_experience_record')!
    const result = await record.execute(
      {
        success: true,
        summary: 'nested metadata keys',
        metadata: { outer: { '{{deep}}': 'x', list: [{ '{{deeper}}': 1 }] } },
      } as never,
      { signal: AbortSignal.timeout(5000) },
    ) as { metadata: { outer: Record<string, unknown>; } }

    const keysOut = Object.keys(result.metadata.outer)
    // The brace pair is stripped from the key name.
    expect(keysOut).toContain('deep')
    // No key retains literal {{ or }}.
    expect(keysOut.some(k => k.includes('{{') || k.includes('}}'))).toBe(false)
    // Value survives alongside the key.
    expect(result.metadata.outer.deep).toBe('x')
  })
})