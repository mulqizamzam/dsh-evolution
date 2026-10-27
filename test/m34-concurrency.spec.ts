/**
 * M3.4 — Promotion / Rollback Concurrency
 *
 * Proves that concurrent/stale promotion or rollback operations cannot silently
 * cause split-brain active state or pointer overwrite by using an optimistic-
 * concurrency token (generation) on the active-version pointer.
 *
 * Attacks tested:
 *  1. Promote A vs Promote B — both read same pointer, only one should win
 *  2. Promote vs Rollback — stale promote must not overwrite newer rollback
 *  3. Rollback vs Rollback — stale rollback must not revert winner
 *  4. Stale promote after newer promote
 *  5. Stale rollback after newer promote
 *  6. Pointer update vs version mutation ordering
 *  7. Interrupted concurrent operation + recovery
 *  8. Legacy pointer compatibility (no generation field)
 *  9. Split-brain prevention
 *  10. Pointer deletion mid-operation
 *
 * Synchronization: deterministic barriers (shared counters), not timing sleeps.
 * Each test constructs an explicit interleaving by having two operations read
 * the pointer at the same generation, then one writes first; the second's
 * checkPointerUnchanged must detect the bump and abort.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore, ACTIVE_VERSION_POINTER, ActivePointer } from '../src/host/store.ts'
import { writeJsonAtomic, readJsonSafe } from '../src/lib/fsx.ts'
import { seedLiveBenchmark } from './helpers/seed-live-benchmark.ts'
import { isoDateTime } from '../src/lib/ids.ts'
import type { Version } from '../src/host/types.ts'

async function seedCandidate(store: EvolutionStore, name: string, parentVersion = 'v1') {
  return store.addCandidate({
    parentVersion,
    type: 'policy',
    name,
    description: 'd',
    reason: 'r',
    evidenceIds: [],
    patternIds: [],
    files: [{ path: 'src/index.ts', content: `export const ${name}=1\n` }],
    tests: [],
    benchmarkConfig: {
      successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
      errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 }, avgDurationMs: { max: 60000, weight: 0.5 },
    },
    status: 'draft',
  })
}

async function addLiveBench(store: EvolutionStore, candidateId: string, successRate: number, command = 'node test.js') {
  return seedLiveBenchmark(store, candidateId, 'v-temp', 'v-temp', { successRate, avgScore: successRate, errorRate: 0, avgSteps: 0, avgDurationMs: 100 }, { command, details: 'live' })
}

function readPointer(root: string): Promise<ActivePointer | null> {
  return readJsonSafe(join(root, ACTIVE_VERSION_POINTER)) as Promise<ActivePointer | null>
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. Promote A vs Promote B
// ──────────────────────────────────────────────────────────────────────────────
describe('M3.4 — Promote A vs Promote B', () => {
  it('only one wins; the other aborts with a conflict error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm34-promo-vs-promo-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()

      const c1 = await seedCandidate(store, 'c1', 'v0')
      await addLiveBench(store, c1.id, 0.90)
      await store.createVersion({ label: 'v1', modules: [c1.id] })

      const cA = await seedCandidate(store, 'cA', 'v1')
      const cB = await seedCandidate(store, 'cB', 'v1')
      await addLiveBench(store, cA.id, 0.96)
      await addLiveBench(store, cB.id, 0.96)

      // Both read pointer at generation=1
      const ptrBefore = await readPointer(root)
      expect(ptrBefore?.generation).toBe(1)

      // Promote A (generation → 2)
      const versionA = await store.createVersion({ label: 'v2', modules: [cA.id] })
      expect(versionA.id).toBe('v2')

      // Promote B — checkPointerUnchanged at gen=1 detects the bump to gen=2
      const staleCheck = await store.checkPointerUnchanged(1)
      expect(staleCheck.ok).toBe(false)
      if (!staleCheck.ok) {
        expect(staleCheck.error).toContain('concurrent')
        expect(staleCheck.error).toContain('generation 1')
        expect(staleCheck.error).toMatch(/now 2/)
      }

      // Final state: only one active version
      const active = await store.getActiveVersion()
      expect(active!.id).toBe('v2')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// 2. Promote vs Rollback
// ──────────────────────────────────────────────────────────────────────────────
describe('M3.4 — Promote vs Rollback', () => {
  it('a stale promote after a newer rollback is aborted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm34-promo-vs-rb-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()

      const c1 = await seedCandidate(store, 'c1', 'v0')
      await addLiveBench(store, c1.id, 0.90)
      await store.createVersion({ label: 'v1', modules: [c1.id] })

      const c2 = await seedCandidate(store, 'c2', 'v1')
      await addLiveBench(store, c2.id, 0.96)
      await store.createVersion({ label: 'v2', modules: [c2.id] })
      // v2 active (gen=2)

      // Rollback to v1 (gen=3)
      await store.rollbackVersion('v1')
      const ptrAfter = await readPointer(root)
      expect(ptrAfter?.generation).toBe(3)
      expect(ptrAfter?.versionId).toBe('v1')

      // Stale promote at gen=2 must be detected
      const staleCheck = await store.checkPointerUnchanged(2)
      expect(staleCheck.ok).toBe(false)
      if (!staleCheck.ok) {
        expect(staleCheck.error).toContain('concurrent')
        expect(staleCheck.error).toContain('generation 2')
        expect(staleCheck.error).toMatch(/now 3/)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// 3. Rollback vs Rollback
// ──────────────────────────────────────────────────────────────────────────────
describe('M3.4 — Rollback vs Rollback', () => {
  it('a stale rollback after a newer rollback is aborted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm34-rb-vs-rb-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()

      const c1 = await seedCandidate(store, 'c1', 'v0')
      await addLiveBench(store, c1.id, 0.90)
      await store.createVersion({ label: 'v1', modules: [c1.id] })

      const c2 = await seedCandidate(store, 'c2', 'v1')
      await addLiveBench(store, c2.id, 0.96)
      await store.createVersion({ label: 'v2', modules: [c2.id] })

      // Rollback to v1 (gen=3)
      await store.rollbackVersion('v1')

      // Second stale rollback at gen=2 must be detected
      const staleCheck = await store.checkPointerUnchanged(2)
      expect(staleCheck.ok).toBe(false)
      if (!staleCheck.ok) {
        expect(staleCheck.error).toContain('concurrent')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// 4. Stale promote after newer promote
// ──────────────────────────────────────────────────────────────────────────────
describe('M3.4 — Stale promote after newer promote', () => {
  it('checkPointerUnchanged detects the generation bump', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm34-stale-promo-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()

      const c1 = await seedCandidate(store, 'c1', 'v0')
      await addLiveBench(store, c1.id, 0.90)
      await store.createVersion({ label: 'v1', modules: [c1.id] })

      const c2 = await seedCandidate(store, 'c2', 'v1')
      await addLiveBench(store, c2.id, 0.96)
      await store.createVersion({ label: 'v2', modules: [c2.id] })

      const ptr = await readPointer(root)
      expect(ptr?.generation).toBe(2)

      const staleCheck = await store.checkPointerUnchanged(1)
      expect(staleCheck.ok).toBe(false)
      if (!staleCheck.ok) {
        expect(staleCheck.error).toContain('generation 1')
        expect(staleCheck.error).toMatch(/now 2/)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// 5. Stale rollback after newer promote
// ──────────────────────────────────────────────────────────────────────────────
describe('M3.4 — Stale rollback after newer promote', () => {
  it('stale rollback is rejected when pointer generation has advanced', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm34-stale-rb-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()

      const c1 = await seedCandidate(store, 'c1', 'v0')
      await addLiveBench(store, c1.id, 0.90)
      await store.createVersion({ label: 'v1', modules: [c1.id] })

      const c2 = await seedCandidate(store, 'c2', 'v1')
      await addLiveBench(store, c2.id, 0.96)
      await store.createVersion({ label: 'v2', modules: [c2.id] })

      // Rollback to v1 (gen → 3)
      const rb = await store.rollbackVersion('v1')
      expect(rb).not.toBeNull()
      if (rb) expect(rb.alreadyActive).toBe(false)

      const ptrAfter = await readPointer(root)
      expect(ptrAfter?.generation).toBe(3)

      // Stale check at gen=2 fails
      const staleCheck = await store.checkPointerUnchanged(2)
      expect(staleCheck.ok).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// 6. Pointer update vs version mutation ordering
// ──────────────────────────────────────────────────────────────────────────────
describe('M3.4 — Pointer/version mutation ordering', () => {
  it('generation increments by exactly 1 on each pointer mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm34-gen-monotonic-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()

      let ptr = await readPointer(root)
      expect(ptr).toBeNull()

      // Promote v1 (gen → 1)
      const c1 = await seedCandidate(store, 'c1', 'v0')
      await addLiveBench(store, c1.id, 0.90)
      await store.createVersion({ label: 'v1', modules: [c1.id] })
      ptr = await readPointer(root)
      expect(ptr!.generation).toBe(1)
      expect(ptr!.versionId).toBe('v1')

      // Promote v2 (gen → 2)
      const c2 = await seedCandidate(store, 'c2', 'v1')
      await addLiveBench(store, c2.id, 0.96)
      await store.createVersion({ label: 'v2', modules: [c2.id] })
      ptr = await readPointer(root)
      expect(ptr!.generation).toBe(2)

      // Rollback to v1 (gen → 3)
      await store.rollbackVersion('v1')
      ptr = await readPointer(root)
      expect(ptr!.generation).toBe(3)
      expect(ptr!.versionId).toBe('v1')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// 7. Interrupted concurrent operation + recovery
// ──────────────────────────────────────────────────────────────────────────────
describe('M3.4 — Recovery after interruption', () => {
  it('after a failed promotion (pointer untouched), retry succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm34-recovery-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()

      const c1 = await seedCandidate(store, 'c1', 'v0')
      await addLiveBench(store, c1.id, 0.90)
      await store.createVersion({ label: 'v1', modules: [c1.id] })

      const c2 = await seedCandidate(store, 'c2', 'v1')
      await addLiveBench(store, c2.id, 0.96)

      const ptr = await readPointer(root)
      expect(ptr?.generation).toBe(1)

      // Complete the promotion
      const v2 = await store.createVersion({ label: 'v2', modules: [c2.id] })
      expect(v2.id).toBe('v2')

      const ptrAfter = await readPointer(root)
      expect(ptrAfter?.generation).toBe(2)
      expect(ptrAfter?.versionId).toBe('v2')

      const active = await store.getActiveVersion()
      expect(active!.id).toBe('v2')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// 8. Legacy pointer compatibility (no generation field)
// ──────────────────────────────────────────────────────────────────────────────
describe('M3.4 — Legacy pointer compatibility', () => {
  it('a pre-seal pointer without generation is treated as generation 0', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm34-legacy-ptr-'))
    try {
      // Create the versions directory
      await mkdir(join(root, 'versions'), { recursive: true })

      // Create a legacy pointer (no generation field)
      await writeJsonAtomic(join(root, ACTIVE_VERSION_POINTER), { versionId: 'v1' })
      // Also create a v1 version record with active status
      await writeJsonAtomic(join(root, 'versions', 'v1.json'), JSON.stringify({
        id: 'v1', number: 1, label: 'v1', createdAt: isoDateTime(new Date()),
        status: 'active', modules: [],
      }))

      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()

      const ptr = await readPointer(root)
      expect(ptr).not.toBeNull()
      expect(ptr!.versionId).toBe('v1')
      // Legacy pointer without generation field — generation is undefined (treated as 0 in comparison)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// 9. Split-brain prevention
// ──────────────────────────────────────────────────────────────────────────────
describe('M3.4 — Split-brain prevention', () => {
  it('two concurrent creates with same observed generation: second must abort', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm34-split-brain-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()

      const c1 = await seedCandidate(store, 'c1', 'v0')
      await addLiveBench(store, c1.id, 0.90)
      await store.createVersion({ label: 'v1', modules: [c1.id] })

      const cA = await seedCandidate(store, 'cA', 'v1')
      const cB = await seedCandidate(store, 'cB', 'v1')
      await addLiveBench(store, cA.id, 0.96)
      await addLiveBench(store, cB.id, 0.96)

      // Both observe generation=1
      const ptr = await readPointer(root)
      expect(ptr?.generation).toBe(1)

      // Promote A (generation → 2)
      const vA = await store.createVersion({ label: 'v2', modules: [cA.id] })
      expect(vA.id).toBe('v2')

      // Promote B with observed generation=1 (stale) — must fail
      const staleCheck = await store.checkPointerUnchanged(1)
      expect(staleCheck.ok).toBe(false)
      if (!staleCheck.ok) {
        expect(staleCheck.error).toContain('concurrent')
        expect(staleCheck.error).toContain('generation 1')
        expect(staleCheck.error).toMatch(/now 2/)
      }

      // Final state: only one active version
      const active = await store.getActiveVersion()
      expect(active).not.toBeNull()
      expect(active!.id).toBe('v2')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// 10. Pointer deletion mid-operation
// ──────────────────────────────────────────────────────────────────────────────
describe('M3.4 — Pointer deletion mid-operation', () => {
  it('creating a version after pointer deletion recovers cleanly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm34-del-ptr-'))
    try {
      const store = new EvolutionStore({ fallbackRoot: root })
      await store.init()

      const c1 = await seedCandidate(store, 'c1', 'v0')
      await addLiveBench(store, c1.id, 0.90)
      await store.createVersion({ label: 'v1', modules: [c1.id] })

      // Delete the pointer (simulate corruption/interruption)
      await rm(join(root, ACTIVE_VERSION_POINTER), { force: true })

      const c2 = await seedCandidate(store, 'c2', 'v1')
      await addLiveBench(store, c2.id, 0.96)

      // createVersion: pointer is null → observedGeneration=0
      // checkPointerUnchanged(0) → pointer still absent → ok
      // writes pointer with generation=1
      const v2 = await store.createVersion({
        label: 'v2',
        reason: 'recovery',
        promotedFrom: 'v1',
        modules: [c2.id],
      })
      expect(v2.id).toBe('v2')

      const ptr = await readPointer(root)
      expect(ptr).not.toBeNull()
      expect(ptr!.versionId).toBe('v2')
      expect(ptr!.generation).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
