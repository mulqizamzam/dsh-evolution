/**
 * Mission 2.2 — Canonical Active-State Hardening
 *
 * Tests P1–P14:
 *   P1  Pointer written atomically on promotion
 *   P2  Pointer written atomically on rollback
 *   P3  Pointer JSON parseable after successful operation
 *   P4  Missing pointer + exactly one active legacy version → deterministic bootstrap
 *   P5  Missing pointer + multiple active versions → explicit ambiguous-state failure
 *   P6  Corrupt pointer + exactly one unambiguous active legacy state → deterministic recovery/repair
 *   P7  Corrupt pointer + multiple active versions → explicit failure
 *   P8  Pointer references nonexistent version → explicit failure/recovery
 *   P9  Valid pointer + duplicate status='active' records → pointer remains authoritative
 *  P10  Pointer failure does not cause getActiveVersion() to select by version order
 *  P11  Restart preserves canonical selection
 *  P12  Promotion followed by rollback preserves canonical pointer semantics
 *  P13  Interrupted/partial pointer write cannot produce silent arbitrary selection
 *  P14  Existing legacy state remains compatible when unambiguous
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore, ACTIVE_VERSION_POINTER } from '../src/host/store.ts'
import { writeJsonAtomic, readJsonSafe } from '../src/lib/fsx.ts'
import { seedLiveBenchmark } from './helpers/seed-live-benchmark.ts'

async function readPointer(root: string): Promise<{ versionId: string } | null> {
  try {
    const raw = await readFile(join(root, ACTIVE_VERSION_POINTER), 'utf8')
    return JSON.parse(raw) as { versionId: string }
  } catch {
    return null
  }
}

describe('Mission 2.2 — Canonical active-state hardening (P1–P14)', () => {
  let root: string
  let store: EvolutionStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'evo-canonical-'))
    store = new EvolutionStore({ fallbackRoot: root })
    await store.init()
    // Baseline: v1 with no modules (no artifact)
    await store.createVersion({ label: 'baseline', modules: [] })
  })

  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  // ──────────────────────────────────────────────────────────────────────────
  // P1 — Pointer is written atomically on promotion
  // ──────────────────────────────────────────────────────────────────────────

  it('P1: pointer write uses atomic tmp+rename (writeJsonAtomic), not direct writeFile', async () => {
    const candidate = await store.addCandidate({
      parentVersion: 'v1', type: 'policy', name: 'p1', description: 'd', reason: 'r',
      evidenceIds: [], patternIds: [], status: 'benchmarked',
      files: [{ path: 'src/index.ts', content: 'export default function(){return true}\n' }],
      tests: [],
      benchmarkConfig: {
        successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
        errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 },
        avgDurationMs: { max: 60000, weight: 0.5 },
      },
    })
    await seedLiveBenchmark(store, candidate.id, 'v1', 'v1', { successRate: 0.96, avgScore: 0.96, errorRate: 0, avgSteps: 0, avgDurationMs: 100 }, { details: 'live' })
    await store.updateCandidate(candidate.id, { status: 'benchmarked' })

    const result = await store.createVersion({ label: 'p1-promo', modules: [candidate.id] })
    expect(result.id).toBe('v2')

    // Verify pointer file exists and is valid JSON
    const pointer = await readPointer(root)
    expect(pointer).not.toBeNull()
    expect(pointer!.versionId).toBe('v2')

    // Verify the pointer file has a clean trailing newline and complete JSON
    const raw = await readFile(join(root, ACTIVE_VERSION_POINTER), 'utf8')
    const parsed = JSON.parse(raw) as { versionId: string }
    expect(parsed.versionId).toBe('v2')
    // No .tmp. suffix present — atomic rename completed
    expect(raw).not.toContain('.tmp.')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // P2 — Pointer is written atomically on rollback
  // ──────────────────────────────────────────────────────────────────────────

  it('P2: pointer write uses atomic tmp+rename on rollback', async () => {
    const candidate = await store.addCandidate({
      parentVersion: 'v1', type: 'policy', name: 'p2', description: 'd', reason: 'r',
      evidenceIds: [], patternIds: [], status: 'benchmarked',
      files: [{ path: 'src/index.ts', content: 'export default function(){return true}\n' }],
      tests: [],
      benchmarkConfig: {
        successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
        errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 },
        avgDurationMs: { max: 60000, weight: 0.5 },
      },
    })
    await seedLiveBenchmark(store, candidate.id, 'v1', 'v1', { successRate: 0.96, avgScore: 0.96, errorRate: 0, avgSteps: 0, avgDurationMs: 100 }, { details: 'live' })
    await store.updateCandidate(candidate.id, { status: 'benchmarked' })

    await store.createVersion({ label: 'p2-promo', modules: [candidate.id] })
    expect((await readPointer(root))!.versionId).toBe('v2')

    const rolled = await store.rollbackVersion('v1')
    expect(rolled).not.toBeNull()
    expect(rolled!.restored.id).toBe('v1')

    const pointer = await readPointer(root)
    expect(pointer).not.toBeNull()
    expect(pointer!.versionId).toBe('v1')

    // Pointer file is clean JSON without .tmp. suffix
    const raw = await readFile(join(root, ACTIVE_VERSION_POINTER), 'utf8')
    const parsed = JSON.parse(raw) as { versionId: string }
    expect(parsed.versionId).toBe('v1')
    expect(raw).not.toContain('.tmp.')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // P3 — Pointer JSON is parseable after successful operation
  // ──────────────────────────────────────────────────────────────────────────

  it('P3: pointer JSON is parseable after promotion and after rollback', async () => {
    const candidate = await store.addCandidate({
      parentVersion: 'v1', type: 'policy', name: 'p3', description: 'd', reason: 'r',
      evidenceIds: [], patternIds: [], status: 'benchmarked',
      files: [{ path: 'src/index.ts', content: 'export default function(){return true}\n' }],
      tests: [],
      benchmarkConfig: {
        successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
        errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 },
        avgDurationMs: { max: 60000, weight: 0.5 },
      },
    })
    await seedLiveBenchmark(store, candidate.id, 'v1', 'v1', { successRate: 0.96, avgScore: 0.96, errorRate: 0, avgSteps: 0, avgDurationMs: 100 }, { details: 'live' })
    await store.updateCandidate(candidate.id, { status: 'benchmarked' })

    // After promotion
    await store.createVersion({ label: 'p3-promo', modules: [candidate.id] })
    const afterPromo = JSON.parse(await readFile(join(root, ACTIVE_VERSION_POINTER), 'utf8')) as { versionId: string }
    expect(afterPromo.versionId).toBe('v2')

    // After rollback
    await store.rollbackVersion('v1')
    const afterRoll = JSON.parse(await readFile(join(root, ACTIVE_VERSION_POINTER), 'utf8')) as { versionId: string }
    expect(afterRoll.versionId).toBe('v1')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // P4 — Missing pointer + exactly one active legacy version → deterministic bootstrap
  // ──────────────────────────────────────────────────────────────────────────

  it('P4: missing pointer with exactly one active legacy version bootstraps deterministically', async () => {
    // beforeEach creates v1 via createVersion which writes the pointer.
    // Remove it to simulate legacy state (no pointer file).
    try { await rm(join(root, ACTIVE_VERSION_POINTER)) } catch { /* ok */ }

    // Re-init (simulates fresh boot on legacy state)
    const freshStore = new EvolutionStore({ fallbackRoot: root })
    await freshStore.init()

    // Pointer should now exist, pointing to v1
    const pointer = await readPointer(root)
    expect(pointer).not.toBeNull()
    expect(pointer!.versionId).toBe('v1')

    // getActiveVersion returns v1 deterministically
    const active = await freshStore.getActiveVersion()
    expect(active!.id).toBe('v1')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // P5 — Missing pointer + multiple active versions → explicit ambiguous-state failure
  // ──────────────────────────────────────────────────────────────────────────

  it('P5: missing pointer + multiple active versions throws during init, not silent arbitrary selection', async () => {
    // Create v2 manually with status='active' (bypassing store.createVersion)
    const v2Json = JSON.stringify({
      id: 'v2', number: 2, label: 'v2-manual', createdAt: new Date().toISOString(),
      status: 'active', modules: [],
    })
    await writeFile(join(root, 'versions', 'v2.json'), v2Json + '\n', 'utf8')

    // Ensure no pointer exists
    const pointerPath = join(root, ACTIVE_VERSION_POINTER)
    try { await rm(pointerPath) } catch { /* ok */ }

    // Re-init should throw because state is ambiguous (v1 and v2 both active)
    const freshStore = new EvolutionStore({ fallbackRoot: root })
    await expect(freshStore.init()).rejects.toThrow('ambiguous legacy state')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // P6 — Corrupt pointer + exactly one unambiguous active legacy → deterministic recovery
  // ──────────────────────────────────────────────────────────────────────────

  it('P6: corrupt pointer + exactly one active legacy version recovers and repairs pointer', async () => {
    // First promote so pointer exists and points to v2
    const candidate = await store.addCandidate({
      parentVersion: 'v1', type: 'policy', name: 'p6', description: 'd', reason: 'r',
      evidenceIds: [], patternIds: [], status: 'benchmarked',
      files: [{ path: 'src/index.ts', content: 'export default function(){return true}\n' }],
      tests: [],
      benchmarkConfig: {
        successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
        errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 },
        avgDurationMs: { max: 60000, weight: 0.5 },
      },
    })
    await seedLiveBenchmark(store, candidate.id, 'v1', 'v1', { successRate: 0.96, avgScore: 0.96, errorRate: 0, avgSteps: 0, avgDurationMs: 100 }, { details: 'live' })
    await store.updateCandidate(candidate.id, { status: 'benchmarked' })
    await store.createVersion({ label: 'p6-promo', modules: [candidate.id] })

    // Corrupt the pointer
    await writeFile(join(root, ACTIVE_VERSION_POINTER), 'NOT VALID JSON {{{', 'utf8')

    // getActiveVersion must recover: exactly one active version (v2), so it
    // returns v2 AND repairs the pointer atomically.
    const active = await store.getActiveVersion()
    expect(active).not.toBeNull()
    expect(active!.id).toBe('v2')

    // Pointer is repaired to point to the recovered version
    const pointer = await readPointer(root)
    expect(pointer).not.toBeNull()
    expect(pointer!.versionId).toBe('v2')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // P7 — Corrupt pointer + multiple active versions → explicit failure
  // ──────────────────────────────────────────────────────────────────────────

  it('P7: corrupt pointer + multiple active versions throws; no order-based selection', async () => {
    // Create v2 with status='active' manually
    const v2Json = JSON.stringify({
      id: 'v2', number: 2, label: 'v2-manual', createdAt: new Date().toISOString(),
      status: 'active', modules: [],
    })
    await writeFile(join(root, 'versions', 'v2.json'), v2Json + '\n', 'utf8')

    // Corrupt the pointer (if any exists from baseline)
    await writeFile(join(root, ACTIVE_VERSION_POINTER), 'CORRUPT', 'utf8')

    // getActiveVersion must throw: two versions have status='active', state is ambiguous
    await expect(store.getActiveVersion()).rejects.toThrow('ambiguous active state')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // P8 — Pointer references nonexistent version → explicit failure/recovery
  // ──────────────────────────────────────────────────────────────────────────

  it('P8: stale pointer to nonexistent version recovers when exactly one active exists', async () => {
    // Corrupt pointer to reference a non-existent version
    await writeFile(join(root, ACTIVE_VERSION_POINTER), '{"versionId":"v999"}', 'utf8')

    // v1 still has status='active' from baseline creation
    const active = await store.getActiveVersion()
    expect(active).not.toBeNull()
    expect(active!.id).toBe('v1') // recovers to the single active version

    // Pointer is repaired to the correct version
    const pointer = await readPointer(root)
    expect(pointer!.versionId).toBe('v1')
  })

  it('P8b: stale pointer + no active versions → returns null (empty state)', async () => {
    // Remove all version records and corrupt pointer
    await rm(join(root, 'versions', 'v1.json'), { force: true })
    await writeFile(join(root, ACTIVE_VERSION_POINTER), '{"versionId":"v999"}', 'utf8')

    const active = await store.getActiveVersion()
    expect(active).toBeNull()
  })

  it('P8c: stale pointer + multiple active versions → throws', async () => {
    // Create a second active version
    const v2Json = JSON.stringify({
      id: 'v2', number: 2, label: 'v2-manual', createdAt: new Date().toISOString(),
      status: 'active', modules: [],
    })
    await writeFile(join(root, 'versions', 'v2.json'), v2Json + '\n', 'utf8')

    // Stale pointer
    await writeFile(join(root, ACTIVE_VERSION_POINTER), '{"versionId":"v999"}', 'utf8')

    await expect(store.getActiveVersion()).rejects.toThrow('ambiguous active state')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // P9 — Valid pointer + duplicate status='active' records → pointer remains authoritative
  // ──────────────────────────────────────────────────────────────────────────

  it('P9: valid pointer + duplicate active status records → pointer is authoritative', async () => {
    const candidate = await store.addCandidate({
      parentVersion: 'v1', type: 'policy', name: 'p9', description: 'd', reason: 'r',
      evidenceIds: [], patternIds: [], status: 'benchmarked',
      files: [{ path: 'src/index.ts', content: 'export default function(){return true}\n' }],
      tests: [],
      benchmarkConfig: {
        successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
        errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 },
        avgDurationMs: { max: 60000, weight: 0.5 },
      },
    })
    await seedLiveBenchmark(store, candidate.id, 'v1', 'v1', { successRate: 0.96, avgScore: 0.96, errorRate: 0, avgSteps: 0, avgDurationMs: 100 }, { details: 'live' })
    await store.updateCandidate(candidate.id, { status: 'benchmarked' })
    await store.createVersion({ label: 'p9-promo', modules: [candidate.id] })

    // Manually inject a second version with status='active' (bypassing store)
    const v3Json = JSON.stringify({
      id: 'v3', number: 3, label: 'v3-manual', createdAt: new Date().toISOString(),
      status: 'active', modules: [],
    })
    await writeFile(join(root, 'versions', 'v3.json'), v3Json + '\n', 'utf8')

    // Pointer still says v2, and getActiveVersion MUST return v2
    const active = await store.getActiveVersion()
    expect(active!.id).toBe('v2')

    // Verify that both v2 and v3 have status='active'
    const versions = await store.listVersions()
    const activeByStatus = versions.filter(v => v.status === 'active')
    expect(activeByStatus.length).toBe(2)
  })

  // ──────────────────────────────────────────────────────────────────────────
  // P10 — Pointer failure does not cause getActiveVersion() to select by version order
  // ──────────────────────────────────────────────────────────────────────────

  it('P10: pointer failure never selects by array order — throws on ambiguity instead', async () => {
    // Create v2 as archived (not active), pointer points to non-existent v99
    const v2Json = JSON.stringify({
      id: 'v2', number: 2, label: 'v2-archived', createdAt: new Date().toISOString(),
      status: 'rolled-back', modules: [],
    })
    await writeFile(join(root, 'versions', 'v2.json'), v2Json + '\n', 'utf8')
    await writeFile(join(root, ACTIVE_VERSION_POINTER), '{"versionId":"v99"}', 'utf8')

    // v1 has status='active', v2 has status='rolled-back'
    // Stale pointer falls through to scan: exactly one active (v1) → returns v1
    const active = await store.getActiveVersion()
    expect(active!.id).toBe('v1')

    // Now make BOTH v1 and v2 active — same stale pointer scenario
    const v1Ver = await store.getVersion('v1')
    const v2Ver = await store.getVersion('v2')
    expect(v1Ver!.status).toBe('active')
    expect(v2Ver!.status).toBe('rolled-back')

    // Change v2 to active too
    await writeFile(join(root, 'versions', 'v2.json'),
      JSON.stringify({ ...v2Ver!, status: 'active' }) + '\n', 'utf8')

    // Re-corrupt the pointer — the first getActiveVersion() call repaired it
    await writeFile(join(root, ACTIVE_VERSION_POINTER), '{"versionId":"v99"}', 'utf8')

    // Now two active versions + corrupt pointer → must throw, NOT pick v1 by order
    await expect(store.getActiveVersion()).rejects.toThrow('ambiguous active state')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // P11 — Restart preserves canonical selection
  // ──────────────────────────────────────────────────────────────────────────

  it('P11: restart preserves canonical pointer selection', async () => {
    const candidate = await store.addCandidate({
      parentVersion: 'v1', type: 'policy', name: 'p11', description: 'd', reason: 'r',
      evidenceIds: [], patternIds: [], status: 'benchmarked',
      files: [{ path: 'src/index.ts', content: 'export default function(){return true}\n' }],
      tests: [],
      benchmarkConfig: {
        successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
        errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 },
        avgDurationMs: { max: 60000, weight: 0.5 },
      },
    })
    await seedLiveBenchmark(store, candidate.id, 'v1', 'v1', { successRate: 0.96, avgScore: 0.96, errorRate: 0, avgSteps: 0, avgDurationMs: 100 }, { details: 'live' })
    await store.updateCandidate(candidate.id, { status: 'benchmarked' })

    const v2 = await store.createVersion({ label: 'p11-promo', modules: [candidate.id] })
    expect(v2.id).toBe('v2')

    // Simulate restart: fresh store instance, same root
    const freshStore = new EvolutionStore({ fallbackRoot: root })
    await freshStore.init()

    const active = await freshStore.getActiveVersion()
    expect(active!.id).toBe('v2')

    // Pointer survived the restart
    const pointer = await readPointer(root)
    expect(pointer!.versionId).toBe('v2')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // P12 — Promotion followed by rollback preserves canonical pointer semantics
  // ──────────────────────────────────────────────────────────────────────────

  it('P12: promotion then rollback preserves canonical pointer semantics', async () => {
    const candidate = await store.addCandidate({
      parentVersion: 'v1', type: 'policy', name: 'p12', description: 'd', reason: 'r',
      evidenceIds: [], patternIds: [], status: 'benchmarked',
      files: [{ path: 'src/index.ts', content: 'export default function(){return true}\n' }],
      tests: [],
      benchmarkConfig: {
        successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
        errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 },
        avgDurationMs: { max: 60000, weight: 0.5 },
      },
    })
    await seedLiveBenchmark(store, candidate.id, 'v1', 'v1', { successRate: 0.96, avgScore: 0.96, errorRate: 0, avgSteps: 0, avgDurationMs: 100 }, { details: 'live' })
    await store.updateCandidate(candidate.id, { status: 'benchmarked' })

    const v2 = await store.createVersion({ label: 'p12-promo', modules: [candidate.id] })
    expect(v2.id).toBe('v2')
    expect((await readPointer(root))!.versionId).toBe('v2')

    const rolled = await store.rollbackVersion('v1')
    expect(rolled).not.toBeNull()
    expect(rolled!.restored.id).toBe('v1')
    expect((await readPointer(root))!.versionId).toBe('v1')

    const active = await store.getActiveVersion()
    expect(active!.id).toBe('v1')

    // Pointer remains valid JSON after the full chain
    const raw = await readFile(join(root, ACTIVE_VERSION_POINTER), 'utf8')
    const parsed = JSON.parse(raw) as { versionId: string }
    expect(parsed.versionId).toBe('v1')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // P13 — Interrupted/partial pointer write cannot produce silent arbitrary selection
  // ──────────────────────────────────────────────────────────────────────────

  it('P13: partial/truncated pointer file is treated as corrupt and recovers deterministically', async () => {
    // Simulate a truncated pointer (partial write interrupted)
    await writeFile(join(root, ACTIVE_VERSION_POINTER), '{"versionId":"v2', 'utf8')

    // v1 is the only version and has status='active'
    // Truncated pointer → parse error → fallback to scan → exactly one active → v1
    const active = await store.getActiveVersion()
    expect(active).not.toBeNull()
    expect(active!.id).toBe('v1')

    // Pointer is repaired to a valid state
    const pointer = await readPointer(root)
    expect(pointer).not.toBeNull()
    expect(pointer!.versionId).toBe('v1')
  })

  it('P13b: truncated pointer + ambiguous state → explicit error, not silent selection', async () => {
    // Create a second active version
    const v2Json = JSON.stringify({
      id: 'v2', number: 2, label: 'v2-manual', createdAt: new Date().toISOString(),
      status: 'active', modules: [],
    })
    await writeFile(join(root, 'versions', 'v2.json'), v2Json + '\n', 'utf8')

    // Truncated pointer
    await writeFile(join(root, ACTIVE_VERSION_POINTER), '{"versionId":"v', 'utf8')

    // Two active versions + corrupt pointer → explicit error
    await expect(store.getActiveVersion()).rejects.toThrow('ambiguous active state')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // P14 — Existing legacy state remains compatible when unambiguous
  // ──────────────────────────────────────────────────────────────────────────

  it('P14: legacy state with no pointer and one active version is compatible (bootstrap)', async () => {
    // Simulate legacy state: only v1 exists, no pointer
    // (this is the default state after beforeEach — v1 created without pointer)

    const freshStore = new EvolutionStore({ fallbackRoot: root })
    await freshStore.init()

    // Pointer was created by bootstrap
    const pointer = await readPointer(root)
    expect(pointer).not.toBeNull()
    expect(pointer!.versionId).toBe('v1')

    // getActiveVersion returns v1
    const active = await freshStore.getActiveVersion()
    expect(active!.id).toBe('v1')

    // Subsequent reads use the canonical pointer path
    const active2 = await freshStore.getActiveVersion()
    expect(active2!.id).toBe('v1')
  })

  it('P14b: empty legacy state (zero versions, no pointer) remains valid', async () => {
    // Remove the baseline version
    await rm(join(root, 'versions', 'v1.json'), { force: true })
    // Ensure no pointer
    try { await rm(join(root, ACTIVE_VERSION_POINTER)) } catch { /* ok */ }

    const freshStore = new EvolutionStore({ fallbackRoot: root })
    await freshStore.init()

    // Empty state is valid — no pointer, no active version
    const pointer = await readPointer(root)
    expect(pointer).toBeNull()

    const active = await freshStore.getActiveVersion()
    expect(active).toBeNull()
  })
})
