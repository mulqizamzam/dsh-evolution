/**
 * P12: Post-promotion version observation and degradation detection.
 *
 * Tests:
 *  - version attribution on experience records
 *  - evo_version_history returns observations for a given version
 *  - degradation signal is raised when success rate drops
 *  - rollback preserves historical observations
 *  - repeated observations for the same version
 *  - no versionId → no observations returned
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import { detectVersionDegradation, analyzeTools } from '../src/host/modules/analyze/tools.ts'
import { experienceTools } from '../src/host/modules/experience/tools.ts'
import { versionHistoryApply } from './helpers/version-history-apply.ts'
import type { ModuleDeps, ExperienceRecord } from '../src/host/types.ts'
import type { HostContextShape } from '../src/host/dsh.ts'

function makeCtx(): HostContextShape {
  const registry = new Map<string, never>()
  return {
    tools: { register: (def: never) => { registry.set((def as { name: string }).name, undefined) } },
    settings: { writable: true, register: (_ns: string, _schema: unknown, opts: { base?: unknown }) => ({ get: () => opts.base ?? {} }) },
    agents: { get: () => undefined, roots: () => [] },
    get: () => undefined,
    on: () => () => {},
    effect: () => () => {},
  }
}

function makeDeps(store: EvolutionStore, root: string): ModuleDeps {
  return {
    ctx: makeCtx(),
    cfg: () => resolveConfig({ stateRoot: root }),
    store,
    log: () => {},
    warn: () => {},
  }
}

const exec = { signal: AbortSignal.timeout(5000) }

describe('P12: Version observation and degradation', () => {
  let tmpRoot: string
  let store: EvolutionStore
  let deps: ModuleDeps

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-p12-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
    deps = makeDeps(store, tmpRoot)
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  // ── Requirement 1: Successful post-promotion execution ──

  it('records a successful observation attributed to a specific version', async () => {
    await store.createVersion({ label: 'v1-baseline', modules: [] })
    const v2 = await store.createVersion({ label: 'v2-improved', modules: ['mod'], promotedFrom: 'v1' })
    expect(v2.id).toBe('v2')

    const expTools = experienceTools(deps)
    const record = expTools.find(t => t.name === 'evo_experience_record')!
    await record.execute({
      taskId: 'post-promo-task-1',
      prompt: 'run post-promotion check',
      success: true,
      score: 0.92,
      stepCount: 3,
      durationMs: 12000,
      versionId: 'v2',
    } as never, exec)

    const retrieved = await store.listExperiencesByVersion('v2', 10)
    expect(retrieved.length).toBe(1)
    expect(retrieved[0].versionId).toBe('v2')
    expect(retrieved[0].success).toBe(true)
  })

  // ── Requirement 2: Degraded outcome is detectable ──

  it('detects degradation when success rate falls below threshold', async () => {
    // Seed v2 with a mix: 2 successes + 5 failures = 28.6% success rate
    for (let i = 0; i < 2; i++) {
      await store.addExperience({
        success: true,
        score: 0.9,
        stepCount: 2,
        durationMs: 5000,
        versionId: 'v2',
        prompt: 'ok-task',
      })
    }
    for (let i = 0; i < 5; i++) {
      await store.addExperience({
        success: false,
        errors: ['timeout: request timed out'],
        stepCount: 15,
        durationMs: 45000,
        versionId: 'v2',
        prompt: 'fail-task',
      })
    }

    const all = await store.listExperiences(100)
    const v2Records = all.filter(e => e.versionId === 'v2')
    const signal = detectVersionDegradation(v2Records)
    expect(signal).not.toBeNull()
    expect(signal!.isDegraded).toBe(true)
    expect(signal!.versionId).toBe('v2')
    expect(signal!.successRate).toBeLessThan(0.6)
  })

  it('does NOT flag a healthy version as degraded', async () => {
    for (let i = 0; i < 6; i++) {
      await store.addExperience({
        success: true,
        score: 0.95,
        stepCount: 2,
        durationMs: 4000,
        versionId: 'v3',
        prompt: 'healthy-task',
      })
    }

    const all = await store.listExperiences(100)
    const v3Records = all.filter(e => e.versionId === 'v3')
    const signal = detectVersionDegradation(v3Records)
    expect(signal).not.toBeNull()
    expect(signal!.isDegraded).toBe(false)
    expect(signal!.successRate).toBeGreaterThan(0.9)
  })

  // ── Requirement 3: Version attribution ──

  it('experiences without versionId are not attributed to any version', async () => {
    await store.addExperience({
      success: true,
      prompt: 'no-version task',
    })

    const all = await store.listExperiences(10)
    expect(all.length).toBe(1)
    expect(all[0].versionId).toBeUndefined()

    // Querying a version should return 0 results
    const v1Records = await store.listExperiencesByVersion('v1', 10)
    expect(v1Records.length).toBe(0)
  })

  // ── Requirement 4: Rollback preserves historical observations ──

  it('observations recorded under a rolled-back version are still retrievable', async () => {
    await store.createVersion({ label: 'v1-baseline', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: ['mod'] })
    expect(v2.id).toBe('v2')

    // Record observations under v2
    await store.addExperience({
      success: true,
      versionId: 'v2',
      prompt: 'v2-observation-1',
    })
    await store.addExperience({
      success: false,
      errors: ['something broke'],
      versionId: 'v2',
      prompt: 'v2-observation-2',
    })

    // Roll back to v1
    const result = await store.rollbackVersion('v1')
    expect(result).not.toBeNull()

    // v2 observations are still retrievable
    const v2Records = await store.listExperiencesByVersion('v2', 10)
    expect(v2Records.length).toBe(2)
    expect(v2Records[0].versionId).toBe('v2')
    expect(v2Records[1].versionId).toBe('v2')
  })

  // ── Requirement 5: Repeated observations for the same version ──

  it('accumulates observations across multiple runs of the same version', async () => {
    for (let i = 0; i < 10; i++) {
      await store.addExperience({
        success: i % 4 !== 0, // 25% failure rate
        versionId: 'v5',
        prompt: 'repeated-task-' + i,
      })
    }

    const v5Records = await store.listExperiencesByVersion('v5', 100)
    expect(v5Records.length).toBe(10)
    const successCount = v5Records.filter(r => r.success).length
    expect(successCount).toBe(7) // i%4===0 at 0,4,8 → 3 failures, 7 successes
  })

  // ── Requirement 6: evo_version_history tool works ──

  it('evo_version_history returns observations and degradation signal', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: ['mod'] })

    // 5 successful observations
    for (let i = 0; i < 5; i++) {
      await store.addExperience({
        success: true,
        score: 0.9,
        stepCount: 2,
        versionId: 'v2',
      })
    }

    const versionHistoryModule = versionHistoryApply(store)
    const result = await versionHistoryModule.execute(
      { versionId: 'v2', limit: 20 } as never,
      exec,
    ) as Record<string, unknown>

    expect(result.versionId).toBe('v2')
    expect((result.observationCount as number)).toBe(5)

    const degradation = result.degradation as Record<string, unknown> | null
    expect(degradation).not.toBeNull()
    expect((degradation!.isDegraded as boolean)).toBe(false)
  })

  it('evo_version_history flags degraded versions', async () => {
    await store.createVersion({ label: 'v1', modules: [] })
    const v2 = await store.createVersion({ label: 'v2', modules: ['mod'] })

    // 2 successes, 4 failures → degraded
    for (let i = 0; i < 2; i++) {
      await store.addExperience({ success: true, versionId: 'v2', stepCount: 2 })
    }
    for (let i = 0; i < 4; i++) {
      await store.addExperience({
        success: false,
        errors: ['failure-' + i],
        versionId: 'v2',
        stepCount: 20,
      })
    }

    const versionHistoryModule = versionHistoryApply(store)
    const result = await versionHistoryModule.execute(
      { versionId: 'v2' } as never,
      exec,
    ) as Record<string, unknown>

    const degradation = result.degradation as Record<string, unknown>
    expect((degradation.isDegraded as boolean)).toBe(true)
    expect(Array.isArray(degradation.signals)).toBe(true)
    expect((degradation.signals as string[]).length).toBeGreaterThan(0)
  })

  it('evo_version_history returns error when no active version exists', async () => {
    // No versions created
    const versionHistoryModule = versionHistoryApply(store)
    const result = await versionHistoryModule.execute(
      {} as never,
      exec,
    ) as Record<string, unknown>

    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('no active version')
  })
})

describe('detectVersionDegradation: unit', () => {
  it('returns null when no experiences have versionId', () => {
    const experiences: ExperienceRecord[] = [
      { id: 'e1', timestamp: '2025-01-01T00:00:00Z', success: true },
      { id: 'e2', timestamp: '2025-01-01T00:01:00Z', success: false, errors: ['fail'] },
    ]
    expect(detectVersionDegradation(experiences)).toBeNull()
  })

  it('does not flag a version with fewer than 5 observations', () => {
    const experiences: ExperienceRecord[] = [
      { id: 'e1', timestamp: '2025-01-01T00:00:00Z', success: false, versionId: 'v1' },
      { id: 'e2', timestamp: '2025-01-01T00:01:00Z', success: false, versionId: 'v1' },
      { id: 'e3', timestamp: '2025-01-01T00:02:00Z', success: false, versionId: 'v1' },
    ]
    const signal = detectVersionDegradation(experiences)
    // Fewer than 5 observations → no degradation signal, even if all failed
    expect(signal === null || signal.isDegraded === false).toBe(true)
  })

  it('flags degradation with ≥5 observations and low success rate', () => {
    const experiences: ExperienceRecord[] = [
      { id: 'e1', timestamp: 't', success: false, versionId: 'v1' },
      { id: 'e2', timestamp: 't', success: false, versionId: 'v1' },
      { id: 'e3', timestamp: 't', success: false, versionId: 'v1' },
      { id: 'e4', timestamp: 't', success: false, versionId: 'v1' },
      { id: 'e5', timestamp: 't', success: false, versionId: 'v1' },
      { id: 'e6', timestamp: 't', success: true,  versionId: 'v1' },
    ]
    const signal = detectVersionDegradation(experiences)!
    expect(signal.isDegraded).toBe(true)
    expect(signal.signals.length).toBeGreaterThan(0)
  })

  it('computes average step count for failed runs', () => {
    const experiences: ExperienceRecord[] = [
      { id: 'e1', timestamp: 't', success: false, versionId: 'v9', stepCount: 20 },
      { id: 'e2', timestamp: 't', success: false, versionId: 'v9', stepCount: 25 },
      { id: 'e3', timestamp: 't', success: false, versionId: 'v9', stepCount: 30 },
      { id: 'e4', timestamp: 't', success: true,  versionId: 'v9', stepCount: 3 },
      { id: 'e5', timestamp: 't', success: true,  versionId: 'v9', stepCount: 4 },
      { id: 'e6', timestamp: 't', success: false, versionId: 'v9', stepCount: 35 },
      { id: 'e7', timestamp: 't', success: false, versionId: 'v9', stepCount: 40 },
    ]
    const signal = detectVersionDegradation(experiences)!
    // Failed step counts: 20+25+30+35+40 = 150 / 5 = 30
    expect(signal.avgStepCount).toBeCloseTo(30, 0)
  })
})
