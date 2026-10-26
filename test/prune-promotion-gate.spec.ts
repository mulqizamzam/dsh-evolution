/**
 * Tests for:
 * 1. Promotion gate ordering — evaluate runs BEFORE any state mutation
 * 2. Experience retention: maxRecords cap
 * 3. Experience retention: retentionDays TTL
 * 4. Combined cap + TTL
 * 5. storedExperiences reflects post-prune count
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import { isoDateTime } from '../src/lib/ids.ts'
import type { ModuleDeps, HostContextShape } from '../src/host/types.ts'
import { evaluatePromotionPolicy } from '../src/host/modules/promote/index.ts'

function makeCtx(): HostContextShape {
  return {
    tools: { register: () => {} },
    settings: { writable: true, register: () => ({ get: () => ({}) }) },
    agents: { get: () => undefined, roots: () => [] },
    get: () => undefined,
    on: () => () => {},
    effect: () => () => {},
  }
}

async function addExperiences(store: EvolutionStore, count: number, baseTimestamp?: Date) {
  const records = []
  for (let i = 0; i < count; i++) {
    const ts = baseTimestamp
      ? isoDateTime(new Date(baseTimestamp.getTime() - (count - i) * 60_000))
      : undefined
    const rec = await store.addExperience({
      success: i % 3 !== 0,
      prompt: 'task-' + i,
      summary: 'summary ' + i,
    })
    // Override timestamp if provided
    if (ts) {
      const path = join(store.getRoot(), 'experiences', `${rec.id}.json`)
      const { writeJsonAtomic } = await import('../src/lib/fsx.ts')
      await writeJsonAtomic(path, { ...rec, timestamp: ts })
    }
    records.push(rec)
  }
  return records
}

describe('Promotion gate ordering — evaluate before mutation', () => {
  it('evaluatePromotionPolicy rejects without creating any version or updating candidate status', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-gate-order-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()

      // Active version v1 at 0.95
      const v1 = await store.addCandidate({
        parentVersion: 'v0', type: 'policy', name: 'v1', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [], tests: [],
        benchmarkConfig: { successRate:{min:0.8,weight:1}, avgScore:{min:0.7,weight:1}, errorRate:{max:0.2,weight:1}, avgSteps:{max:50,weight:0.5}, avgDurationMs:{max:60000,weight:0.5} },
      })
      await store.addBenchmark({
        candidateId: v1.id, version: 'v1', baseline: 'unknown', runs: 20,
        metrics: { successRate: 0.95, avgScore: 0.95, errorRate: 0.02, avgSteps: 5, avgDurationMs: 200 },
        passed: true, details: 'v1', createdAt: isoDateTime(new Date()), mode: 'live',
      })
      await store.createVersion({ label: 'v1', reason: 'release', modules: [v1.id] })

      // Candidate v2 at 0.86 — worse than active
      const v2 = await store.addCandidate({
        parentVersion: 'v1', type: 'policy', name: 'v2-worse', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [], tests: [],
        benchmarkConfig: { successRate:{min:0.8,weight:1}, avgScore:{min:0.7,weight:1}, errorRate:{max:0.2,weight:1}, avgSteps:{max:50,weight:0.5}, avgDurationMs:{max:60000,weight:0.5} },
      })
      await store.addBenchmark({
        candidateId: v2.id, version: 'v2', baseline: 'unknown', runs: 20,
        metrics: { successRate: 0.86, avgScore: 0.86, errorRate: 0.08, avgSteps: 5, avgDurationMs: 210 },
        passed: true, details: 'v2', createdAt: isoDateTime(new Date()), mode: 'live',
      })

      const deps: ModuleDeps = { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: tmpRoot }), store, log: () => {}, warn: () => {} }

      // Evaluate policy FIRST — should reject
      const evaluation = await evaluatePromotionPolicy(deps, v2)
      expect(evaluation.ok).toBe(false)
      if (!evaluation.ok) {
        expect(evaluation.error).toContain('beats_active')
      }

      // NO version should have been created
      const versions = await store.listVersions()
      expect(versions.length).toBe(1)
      expect(versions[0].id).toBe('v1')

      // v1 should still be active
      const active = await store.getActiveVersion()
      expect(active!.id).toBe('v1')
      expect(active!.modules[0]).toBe(v1.id)

      // v2 status should still be 'benchmarked'
      const v2State = await store.getCandidate(v2.id)
      expect(v2State!.status).toBe('benchmarked')

      // No new benchmark records created by the evaluation
      const benchmarks = await store.listBenchmarks(500)
      expect(benchmarks.filter(b => b.candidateId === v2.id).length).toBe(1)
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })

  it('successful evaluation allows executePromotion to create version and activate', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-gate-ok-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()

      const v1 = await store.addCandidate({
        parentVersion: 'v0', type: 'policy', name: 'v1', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [], tests: [],
        benchmarkConfig: { successRate:{min:0.8,weight:1}, avgScore:{min:0.7,weight:1}, errorRate:{max:0.2,weight:1}, avgSteps:{max:50,weight:0.5}, avgDurationMs:{max:60000,weight:0.5} },
      })
      await store.addBenchmark({
        candidateId: v1.id, version: 'v1', baseline: 'unknown', runs: 20,
        metrics: { successRate: 0.90, avgScore: 0.90, errorRate: 0.03, avgSteps: 5, avgDurationMs: 200 },
        passed: true, details: 'v1', createdAt: isoDateTime(new Date()), mode: 'live',
      })
      await store.createVersion({ label: 'v1', reason: 'release', modules: [v1.id] })

      const v2 = await store.addCandidate({
        parentVersion: 'v1', type: 'policy', name: 'v2-better', description: 'd', reason: 'r',
        evidenceIds: [], patternIds: [], status: 'benchmarked',
        files: [{ path: 'src/index.ts', content: 'export function f() { return 42; }\n' }], tests: [],
        benchmarkConfig: { successRate:{min:0.8,weight:1}, avgScore:{min:0.7,weight:1}, errorRate:{max:0.2,weight:1}, avgSteps:{max:50,weight:0.5}, avgDurationMs:{max:60000,weight:0.5} },
      })
      await store.addBenchmark({
        candidateId: v2.id, version: 'v2', baseline: 'unknown', runs: 20,
        metrics: { successRate: 0.96, avgScore: 0.96, errorRate: 0.01, avgSteps: 4, avgDurationMs: 190 },
        passed: true, details: 'v2', createdAt: isoDateTime(new Date()), mode: 'live',
      })

      const deps: ModuleDeps = { ctx: makeCtx(), cfg: () => resolveConfig({ stateRoot: tmpRoot }), store, log: () => {}, warn: () => {} }

      // Evaluate first — should pass
      const evalResult = await evaluatePromotionPolicy(deps, v2)
      expect(evalResult.ok).toBe(true)
      if (evalResult.ok) {
        expect(evalResult.activeMetrics).toBeDefined()
        expect(evalResult.activeMetrics!.successRate).toBeCloseTo(0.90, 2)
      }

      // Then execute — should create version
      const { executePromotion } = await import('../src/host/modules/promote/index.ts')
      const execResult = await executePromotion(deps, v2, 'test', 'v2-probe', evalResult.activeMetrics)
      expect(execResult.ok).toBe(true)
      if (execResult.ok) {
        expect(execResult.version.id).toBe('v2')
        expect(execResult.version.status).toBe('active')
        expect(execResult.version.modules[0]).toBe(v2.id)
      }

      // v1 should be rolled-back
      const v1Ver = await store.getVersion('v1')
      expect(v1Ver!.status).toBe('rolled-back')

      // v2 candidate should be promoted
      const v2Cand = await store.getCandidate(v2.id)
      expect(v2Cand!.status).toBe('promoted')
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })
})

describe('Experience pruning — maxRecords cap', () => {
  it('keeps only the newest N records when maxRecords is exceeded', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-prune-cap-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()

      // Add 5 records with distinct timestamps (oldest first)
      const now = new Date()
      await addExperiences(store, 5, new Date(now.getTime() - 5 * 60_000))

      // Capture all 5 before pruning
      const before = await store.listExperiences(100)
      expect(before.length).toBe(5)
      const originalIds = before.map(r => r.id)

      // Prune with maxRecords=3
      const removed = await store.pruneExperiences(3, 999999) // TTL far in future
      expect(removed).toBe(2)

      // Only 3 newest should remain
      const remaining = await store.listExperiences(100)
      expect(remaining.length).toBe(3)

      // The 3 retained should be the last 3 IDs (newest by timestamp)
      const sortedRemaining = [...remaining].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      const sortedOriginal = [...before].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      const remainingIds = sortedRemaining.map(r => r.id)
      const expectedIds = sortedOriginal.slice(-3).map(r => r.id)
      expect(remainingIds).toEqual(expectedIds)
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })

  it('retained records are byte-content unchanged after pruning', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-prune-intact-'))
    try {
      // Pin the clock so all three records land in DISTINCT milliseconds.
      // Without this, fast execution (82/200 in the collision probe) gives
      // rec1/rec2/rec3 the SAME ISO timestamp; the prune tie-break then
      // falls to random id.localeCompare, and rec2 — not rec1 — is dropped.
      const t = Date.now()
      let tick = 0
      const store = new EvolutionStore({
        fallbackRoot: tmpRoot,
        now: () => new Date(t + tick++),
      })
      await store.init()

      // Add 3 records
      const rec1 = await store.addExperience({ success: true, prompt: 'keep-me-1', summary: 'summary1' })
      const rec2 = await store.addExperience({ success: false, prompt: 'keep-me-2', summary: 'summary2' })
      const rec3 = await store.addExperience({ success: true, prompt: 'keep-me-3', summary: 'summary3' })
      // Distinct timestamps, rec1 < rec2 < rec3 by construction.
      // ISO-8601 strings sort lexicographically, so plain < is the correct
      // ordering test (toBeLessThan is number-only).
      expect(rec1.timestamp < rec2.timestamp).toBe(true)
      expect(rec2.timestamp < rec3.timestamp).toBe(true)

      // Capture original content of ALL records BEFORE pruning
      const before = await store.listExperiences(100)
      const originalMap = new Map<string, string>()
      for (const r of before) {
        originalMap.set(r.id, JSON.stringify(r))
      }

      // Prune to 2 (should remove rec1, keep rec2+rec3)
      await store.pruneExperiences(2, 999999)

      // rec1 should be gone
      const afterRec1 = await store.getExperience(rec1.id)
      expect(afterRec1).toBeNull()

      // rec2 and rec3 should still exist with SAME content
      for (const id of [rec2.id, rec3.id]) {
        const after = await store.getExperience(id)
        expect(after).not.toBeNull()
        expect(JSON.stringify(after)).toBe(originalMap.get(id))
      }

      // List should show 2
      const all = await store.listExperiences(100)
      expect(all.length).toBe(2)
      expect(all.map(r => r.id).includes(rec2.id)).toBe(true)
      expect(all.map(r => r.id).includes(rec3.id)).toBe(true)
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })
})

describe('Experience pruning — retentionDays TTL', () => {
  it('removes records older than retentionDays', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-prune-ttl-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()

      const now = new Date()

      // Add 2 old records (3 days ago)
      await store.addExperience({ success: true, prompt: 'old-1', summary: 'old-s1' })
      await store.addExperience({ success: false, prompt: 'old-2', summary: 'old-s2' })

      // Add 3 new records (just now)
      await store.addExperience({ success: true, prompt: 'new-1', summary: 'new-s1' })
      await store.addExperience({ success: true, prompt: 'new-2', summary: 'new-s2' })
      await store.addExperience({ success: false, prompt: 'new-3', summary: 'new-s3' })

      // Override old records to have timestamps 3 days ago
      const allBefore = await store.listExperiences(100)
      const oldIds = allBefore.slice(0, 2).map(r => r.id)
      const { writeJsonAtomic } = await import('../src/lib/fsx.ts')
      for (const id of oldIds) {
        const rec = await store.getExperience(id)
        if (rec) {
          const oldTs = isoDateTime(new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000))
          await writeJsonAtomic(join(store.getRoot(), 'experiences', `${id}.json`), { ...rec, timestamp: oldTs })
        }
      }

      // Prune with 1-day TTL — old records should go, new should stay
      const removed = await store.pruneExperiences(100, 1)
      expect(removed).toBe(2)

      const remaining = await store.listExperiences(100)
      expect(remaining.length).toBe(3)
      // All remaining should have recent timestamps
      for (const r of remaining) {
        const ageDays = (now.getTime() - new Date(r.timestamp).getTime()) / (24 * 60 * 60 * 1000)
        expect(ageDays).toBeLessThan(1)
      }
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })

  it('does not remove records within retention window', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-prune-within-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()

      // Add 5 records, all recent
      for (let i = 0; i < 5; i++) {
        await store.addExperience({ success: i % 2 === 0, prompt: 'recent-' + i, summary: 's' + i })
      }

      const removed = await store.pruneExperiences(100, 1)
      expect(removed).toBe(0)

      const remaining = await store.listExperiences(100)
      expect(remaining.length).toBe(5)
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })
})

describe('Experience pruning — combined cap + TTL', () => {
  it('applies TTL first, then cap on remaining records', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-prune-combo-'))
    try {
      // Use a controlled clock so each addExperience gets a distinct timestamp;
      // without distinct timestamps, addExperience calls land in the same
      // millisecond and the tie-break between test oracle and prune differs.
      let tick = 0
      const base = new Date('2026-01-01T00:00:00.000Z').getTime()
      const store = new EvolutionStore({
        fallbackRoot: tmpRoot,
        now: () => { tick += 100; return new Date(base + tick) },
      })
      await store.init()

      // Add 4 old records (> 1 day)
      for (let i = 0; i < 4; i++) {
        const rec = await store.addExperience({ success: true, prompt: 'old-' + i, summary: 'os' + i })
        // Rewrite with an old timestamp in both .json and .jsonl so prune and
        // listExperiences agree on which records are expired.
        const oldTs = isoDateTime(new Date(base - 2 * 24 * 60 * 60 * 1000))
        const { writeJsonAtomic } = await import('../src/lib/fsx.ts')
        await writeJsonAtomic(join(store.getRoot(), 'experiences', `${rec.id}.json`), { ...rec, timestamp: oldTs })
      }

      // Add 3 new records
      for (let i = 0; i < 3; i++) {
        await store.addExperience({ success: false, prompt: 'new-' + i, summary: 'ns' + i })
      }

      // Capture original order before prune
      const before = await store.listExperiences(100)
      const newIds = before.filter(r => r.prompt.startsWith('new-')).map(r => r.id)

      // Prune: TTL=1 day removes 4 old, cap=2 would remove 1 more from the 3 new
      const removed = await store.pruneExperiences(2, 1)
      // TTL removes 4 old records. Then cap=2 on remaining 3 new → remove 1 oldest new
      expect(removed).toBe(5)

      const remaining = await store.listExperiences(100)
      expect(remaining.length).toBe(2)
      // Remaining should be the 2 newest by timestamp
      const sortedRemaining2 = [...remaining].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id))
      const sortedNew = [...before.filter(r => r.prompt.startsWith('new-'))].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id))
      const expectedIds2 = sortedNew.slice(-2).map(r => r.id)
      const remainingIds2 = sortedRemaining2.map(r => r.id)
      expect(remainingIds2).toEqual(expectedIds2)
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })
})

describe('storedExperiences reflects post-prune state', () => {
  it('after pruning, listExperiences count matches pruned count', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'evo-prune-count-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: tmpRoot })
      await store.init()

      // Add 5 records
      for (let i = 0; i < 5; i++) {
        await store.addExperience({ success: true, prompt: 'task-' + i })
      }

      // Prune to 3
      await store.pruneExperiences(3, 999999)

      // listExperiences should return 3
      const all = await store.listExperiences(100)
      expect(all.length).toBe(3)
    } finally { await rm(tmpRoot, { recursive: true, force: true }) }
  })
})
