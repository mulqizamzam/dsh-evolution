/**
 * Lazy prune guard — verifies that pruneExperiences is gated by a time-based
 * interval so the hot path (every completed task) does NOT trigger a full
 * disk scan.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeJsonFile } from '../src/lib/fsx.ts'
import { EvolutionStore } from '../src/host/store.ts'

const PRUNE_INTERVAL_MS = 30 * 60 * 1000

describe('lazy prune guard (maybePruneExperiences)', () => {
  let tmpRoot: string
  let store: EvolutionStore

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-27T00:00:00.000Z'))
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-lazy-prune-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await rm(tmpRoot, { recursive: true, force: true })
  })

  async function addN(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await store.addExperience({
        success: true, stepCount: 1, summary: 'test-' + i,
      })
    }
  }

  it('T1 — prunes immediately on cold start (lastPruneAt = 0)', async () => {
    await addN(10)
    const removed = await store.maybePruneExperiences(5, 30)
    expect(removed).toBe(5)
  })

  it('T2 — skips prune within interval after first call', async () => {
    await addN(10)
    await store.maybePruneExperiences(5, 30)
    // 5 survivors remain; add 5 more to exceed cap
    await addN(5)
    const skipped = await store.maybePruneExperiences(5, 30)
    expect(skipped).toBe(0)
  })

  it('T3 — prunes again after interval elapses', async () => {
    await addN(10)
    await store.maybePruneExperiences(5, 30)
    await addN(5)
    // Advance past the interval
    vi.advanceTimersByTime(PRUNE_INTERVAL_MS + 1)
    const removed = await store.maybePruneExperiences(5, 30)
    expect(removed).toBe(5)
  })

  it('T4 — does not prune when under the cap and interval has not elapsed', async () => {
    await addN(3)
    const removed1 = await store.maybePruneExperiences(100, 30)
    // Under cap + just pruned → returns 0
    expect(removed1).toBe(0)
    // Second call within interval → still 0
    const removed2 = await store.maybePruneExperiences(100, 30)
    expect(removed2).toBe(0)
  })

  it('T5 — TTL expiry still prunes on a real prune pass', async () => {
    // Plant an expired experience file directly (bypass addExperience, which
    // always stamps the current timestamp).  This mirrors prune-deterministic.
    const expDir = store['experienceDir']()
    const expiredTs = new Date('2026-08-01T00:00:00.000Z').toISOString()
    await writeJsonFile(join(expDir, 'expired-exp.json'), {
      id: 'expired-exp', timestamp: expiredTs, success: true, summary: 'old',
    })
    // Force interval elapse
    vi.advanceTimersByTime(PRUNE_INTERVAL_MS + 1)
    const removed = await store.maybePruneExperiences(10000, 30)
    expect(removed).toBe(1)
  })
})
