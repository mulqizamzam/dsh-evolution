/**
 * Mission 2.2.2 — Align createVersion / rollbackVersion active-resolution
 * with canonical pointer.
 *
 * Verifies that when pointer/status diverge, createVersion() and
 * rollbackVersion() use the canonical pointer (not status='active' scan)
 * to identify the old active version.
 *
 * T1  pointer=v3, status(active)=v2 → createVersion treats v3 as oldActive
 * T2  pointer=v3, status(active)=v2 → rollback operates from canonical v3
 * T3  pointer valid + duplicate active statuses → all three resolve same
 * T4  legacy: no pointer, exactly one active → bootstrap preserved
 * T5  legacy: no pointer, multiple active → ambiguity error preserved
 * T6  legacy: no pointer, zero active + historical → explicit null, never historical
 * T7  Search regression: no production store path uses status='active' for
 *     canonical active identity (except init/getActive recovery)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore, ACTIVE_VERSION_POINTER } from '../src/host/store.ts'

async function writeVersion(root: string, id: string, number: number, label: string, status: string): Promise<void> {
  await writeFile(join(root, 'versions', `${id}.json`), JSON.stringify({
    id, number, label, createdAt: new Date().toISOString(), status, modules: [],
  }) + '\n', 'utf8')
}

async function writePointer(root: string, versionId: string): Promise<void> {
  await writeFile(join(root, ACTIVE_VERSION_POINTER), JSON.stringify({ versionId }), 'utf8')
}

async function readPointer(root: string): Promise<{ versionId: string } | null> {
  try {
    const raw = await import('node:fs/promises').then(m => m.readFile(join(root, ACTIVE_VERSION_POINTER), 'utf8'))
    return JSON.parse(raw) as { versionId: string }
  } catch { return null }
}

describe('Mission 2.2.2 — Canonical pointer alignment for createVersion/rollback', () => {
  let root: string
  let store: EvolutionStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'evo-222-'))
    store = new EvolutionStore({ fallbackRoot: root })
    await store.init()
    const fs = await import('node:fs/promises')
    await fs.mkdir(join(root, 'versions'), { recursive: true })
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  // ──────────────────────────────────────────────────────────────────────────
  // T1 — createVersion resolves oldActive from canonical pointer, not status
  // ──────────────────────────────────────────────────────────────────────────
  it('T1: pointer=v3, status(active)=v2 → createVersion treats v3 as oldActive', async () => {
    // Setup divergent state
    await writeVersion(root, 'v1', 1, 'old', 'rolled-back')
    await writeVersion(root, 'v2', 2, 'false-active', 'active')
    await writeVersion(root, 'v3', 3, 'canonical', 'rolled-back')
    await writePointer(root, 'v3')

    // Record pre-condition
    const prePointer = await readPointer(root)
    expect(prePointer!.versionId).toBe('v3')
    const preV2 = await store.getVersion('v2')
    expect(preV2!.status).toBe('active')
    const preV3 = await store.getVersion('v3')
    expect(preV3!.status).toBe('rolled-back')

    // Create a new version — oldActive must be v3 (canonical), NOT v2
    const v4 = await store.createVersion({ label: 'v4-new', modules: [] })
    expect(v4.id).toBe('v4')

    // Pointer must point to v4
    const postPointer = await readPointer(root)
    expect(postPointer!.versionId).toBe('v4')

    // v3 must be marked rolled-back (it was already; no change)
    const postV3 = await store.getVersion('v3')
    expect(postV3!.status).toBe('rolled-back')

    // v2 must NOT be modified (it was never canonical active)
    const postV2 = await store.getVersion('v2')
    expect(postV2!.status).toBe('active') // still active — untouched

    // v4 is active
    expect(v4.status).toBe('active')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // T2 — rollbackVersion resolves target from canonical pointer, not status
  // ──────────────────────────────────────────────────────────────────────────
  it('T2: pointer=v3, status(active)=v2 → rollback operates from canonical v3', async () => {
    await writeVersion(root, 'v1', 1, 'target', 'rolled-back')
    await writeVersion(root, 'v2', 2, 'false-active', 'active')
    await writeVersion(root, 'v3', 3, 'canonical', 'rolled-back')
    await writePointer(root, 'v3')

    // Record pre
    expect((await readPointer(root))!.versionId).toBe('v3')

    // Rollback to v1 — should deactivate v3 (canonical), NOT v2
    const result = await store.rollbackVersion('v1')
    expect(result).not.toBeNull()
    expect(result!.restored.id).toBe('v1')
    expect(result!.deactivated!.id).toBe('v3') // was canonical
    expect(result!.alreadyActive).toBe(false)

    // Pointer now points to v1
    const postPointer = await readPointer(root)
    expect(postPointer!.versionId).toBe('v1')

    // v3 status changed to rolled-back (was already); v2 untouched
    const postV2 = await store.getVersion('v2')
    expect(postV2!.status).toBe('active')
    const postV3 = await store.getVersion('v3')
    expect(postV3!.status).toBe('rolled-back')
    const postV1 = await store.getVersion('v1')
    expect(postV1!.status).toBe('active')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // T3 — pointer valid + duplicate active statuses → all resolve same
  // ──────────────────────────────────────────────────────────────────────────
  it('T3: pointer=v2 + duplicate status(active) on v2,v3 → all resolve v2', async () => {
    await writeVersion(root, 'v1', 1, 'hist', 'rolled-back')
    await writeVersion(root, 'v2', 2, 'canonical', 'active')
    await writeVersion(root, 'v3', 3, 'dup-active', 'active')
    await writePointer(root, 'v2')

    // Three callers must agree
    const activeViaGet = await store.getActiveVersion()
    expect(activeViaGet!.id).toBe('v2')

    const v4 = await store.createVersion({ label: 'v4', modules: [] })
    expect(v4.id).toBe('v4')

    // createVersion should have deactivated v2 (canonical), leaving v3 as
    // stale duplicate status
    const postV2 = await store.getVersion('v2')
    expect(postV2!.status).toBe('rolled-back') // was canonical, deactivated
    const postV3 = await store.getVersion('v3')
    expect(postV3!.status).toBe('active') // stale duplicate, untouched

    const postPointer = await readPointer(root)
    expect(postPointer!.versionId).toBe('v4')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // T4 — legacy: no pointer, exactly one active → bootstrap preserved
  // ──────────────────────────────────────────────────────────────────────────
  it('T4: legacy no-pointer + one active → bootstrap creates pointer', async () => {
    // Write v1 directly to simulate legacy state (avoiding store.createVersion for setup)
    await writeVersion(root, 'v1', 1, 'baseline', 'active')

    // No pointer file — legacy state
    const ptrBefore = await readPointer(root)
    expect(ptrBefore).toBeNull()

    const fresh = new EvolutionStore({ fallbackRoot: root })
    await fresh.init()

    // Bootstrap must have created the pointer
    const pointer = await readPointer(root)
    expect(pointer).not.toBeNull()
    expect(pointer!.versionId).toBe('v1')

    // createVersion uses the newly-bootstrapped pointer
    const v2 = await fresh.createVersion({ label: 'v2', modules: [] })
    expect(v2.id).toBe('v2')
    expect((await readPointer(root))!.versionId).toBe('v2')
    const postV1 = await fresh.getVersion('v1')
    expect(postV1!.status).toBe('rolled-back')

    // Verify canonical active count stays correct
    const versions = await fresh.listVersions()
    var activeByStatus = versions.filter(v => v.status === 'active')
    expect(activeByStatus.length).toBe(1)
    expect(activeByStatus[0]!.id).toBe('v2')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // T5 — legacy: no pointer, multiple active → ambiguity error preserved
  // ──────────────────────────────────────────────────────────────────────────
  it('T5: legacy no-pointer + multiple active → throws ambiguity', async () => {
    await writeVersion(root, 'v1', 1, 'a', 'active')
    await writeVersion(root, 'v2', 2, 'b', 'active')
    try { await rm(join(root, ACTIVE_VERSION_POINTER)) } catch { /* ok */ }

    const fresh = new EvolutionStore({ fallbackRoot: root })
    await expect(fresh.init()).rejects.toThrow('ambiguous legacy state')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // T6 — legacy: no pointer, zero active + historical → null, never historical
  // ──────────────────────────────────────────────────────────────────────────
  it('T6: legacy no-pointer + zero active + historical versions → null', async () => {
    await writeVersion(root, 'v1', 1, 'hist1', 'rolled-back')
    await writeVersion(root, 'v2', 2, 'hist2', 'rolled-back')
    try { await rm(join(root, ACTIVE_VERSION_POINTER)) } catch { /* ok */ }

    const fresh = new EvolutionStore({ fallbackRoot: root })
    await fresh.init()

    const active = await fresh.getActiveVersion()
    expect(active).toBeNull()

    const pointer = await readPointer(root)
    expect(pointer).toBeNull() // no bootstrap — state is ambiguous (all rolled-back)
  })

  // ──────────────────────────────────────────────────────────────────────────
  // T7 — search regression: grep for status === 'active' in store.ts
  // ──────────────────────────────────────────────────────────────────────────
  it('T7: no production store path uses status=active to identify canonical active', async () => {
    // Reads the source file at its canonical location and verifies that
    // createVersion() and rollbackVersion() do NOT discover oldActive by
    // scanning status='active' fields. Only init() bootstrap and
    // getActiveVersion() recovery are allowed to use that pattern.
    const fs = await import('node:fs/promises')
    // The source lives at a fixed path relative to the package root.
    const srcPath = join(process.cwd(), 'src', 'host', 'store.ts')
    const src = await fs.readFile(srcPath, 'utf8')

    // Extract the createVersion method body
    const cvMatch = src.match(/createVersion\(.*?\) *:.*?\{[\s\S]*?\n  \}/m)
    expect(cvMatch).not.toBeNull()
    const cvBody = cvMatch![0]
    // Invariant: createVersion must not use versions.find(v => v.status === 'active')
    expect(/versions\.find.*status.*active/.test(cvBody)).toBe(false)

    // Extract the rollbackVersion method body
    const rbMatch = src.match(/rollbackVersion\(.*?\) *:.*?\{[\s\S]*?\n  \}/m)
    expect(rbMatch).not.toBeNull()
    const rbBody = rbMatch![0]
    // Invariant: rollbackVersion must not discover active by status scan
    expect(/versions\.find.*status.*active/.test(rbBody)).toBe(false)

    // Invariant: no ordering fallback (versions[0]) in any production path
    // (already covered by 2.2.1, but re-assert here for completeness)
    const cvFallback = /versions\[0\]/.test(cvBody)
    const rbFallback = /versions\[0\]/.test(rbBody)
    expect(cvFallback).toBe(false)
    expect(rbFallback).toBe(false)
  })
})
