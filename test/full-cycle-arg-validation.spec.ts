/**
 * Input validation hardening for evo_full_cycle.
 * Verifies that apiUrl, apiKey, model, and testCommand are validated
 * before any analysis, LLM, or sandbox work begins — fail fast on
 * malformed or missing trust-boundary inputs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import type { ModuleDeps } from '../src/host/types.ts'
import type { HostContextShape } from '../src/host/dsh.ts'
import { makeFakeHost } from './helpers/fake-host.ts'

function makeDeps(store: EvolutionStore, root: string): ModuleDeps {
  const ctx = makeFakeHost().ctx
  return {
    ctx,
    cfg: () => ({
      stateRoot: root, inject: { enabled: true },
      experience: { maxRecords: 10000, retentionDays: 90 },
      candidate: { maxActive: 10 },
      benchmark: { minRuns: 3, maxRuns: 10, improvementThreshold: 0.05, regressionThreshold: 0.10 },
      evolution: {
        enabled: true, autoRecord: true, autoTrigger: true,
        analysis: { minExperiences: 20, minOccurrences: 5 },
        generation: { enabled: true },
        promotion: { enabled: true },
        maxCyclesPerProcess: 3, cycleDebounceMs: 0,
      },
    }),
    store,
    log: () => {},
    warn: () => {},
  }
}

describe('evo_full_cycle input validation', () => {
  let tmpRoot: string
  let store: EvolutionStore

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-full-cycle-validation-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  async function callFullCycle(args: Record<string, unknown>): Promise<{ ok: boolean; error?: string; steps?: string[] }> {
    const deps = makeDeps(store, tmpRoot)
    const { evolutionTools } = await import('../src/host/modules/evolution/tools.ts')
    const tool = evolutionTools(deps).find(t => t.name === 'evo_full_cycle')!
    return tool.execute(args as never, { signal: AbortSignal.timeout(5000) }) as Promise<{ ok: boolean; error?: string; steps?: string[] }>
  }

  it('rejects non-HTTP(S) apiUrl before analysis', async () => {
    const result = await callFullCycle({
      apiUrl: 'ssh://evil.example.com', apiKey: 'test-key', model: 'test-model', testCommand: 'echo hi',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/apiUrl/i)
    expect(result.error).toMatch(/scheme|http/i)
    // Must not have reached any analysis step
    expect(result.steps ?? []).not.toContain('analyze')
  })

  it('rejects file:// apiUrl', async () => {
    const result = await callFullCycle({
      apiUrl: 'file:///etc/passwd', apiKey: 'test-key', model: 'test-model', testCommand: 'echo hi',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/apiUrl/i)
  })

  it('rejects empty apiKey', async () => {
    const result = await callFullCycle({
      apiUrl: 'https://api.example.com/v1', apiKey: '', model: 'test-model', testCommand: 'echo hi',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/apiKey/i)
  })

  it('rejects missing model', async () => {
    const result = await callFullCycle({
      apiUrl: 'https://api.example.com/v1', apiKey: 'test-key', model: '', testCommand: 'echo hi',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/model/i)
  })

  it('rejects empty testCommand', async () => {
    const result = await callFullCycle({
      apiUrl: 'https://api.example.com/v1', apiKey: 'test-key', model: 'test-model', testCommand: '   ',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/testCommand/i)
  })
})
