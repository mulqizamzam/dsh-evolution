/**
 * Mission 2.2.1 — No order-based active-version fallback
 *
 * Verifies that when no version is active (zero status='active'), the system
 * returns null rather than selecting a historical version by ordering.
 *
 * T1–T4: zero-active with various pointer states
 * T5–T7: recovery with exactly one active
 * T8–T9: ambiguity error with multiple active
 * T10: valid pointer wins over duplicate status
 * T11: reordered version list does not change selection
 * T12: restart preserves zero-active state
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore, ACTIVE_VERSION_POINTER } from '../src/host/store.ts'

async function writeVersion(root: string, id: string, number: number, label: string, status: string): Promise<void> {
  const ver = {
    id, number, label,
    createdAt: new Date().toISOString(),
    status,
    modules: [],
  }
  await writeFile(join(root, 'versions', `${id}.json`), JSON.stringify(ver) + '\n', 'utf8')
}

async function writePointer(root: string, versionId: string): Promise<void> {
  await writeFile(join(root, ACTIVE_VERSION_POINTER), JSON.stringify({ versionId }), 'utf8')
}

async function readPointer(root: string): Promise<{ versionId: string } | null> {
  try {
    const raw = await import('node:fs/promises').then(m => m.readFile(join(root, ACTIVE_VERSION_POINTER), 'utf8'))
    return JSON.parse(raw) as { versionId: string }
  } catch {
    return null
  }
}

describe('Mission 2.2.1 — Remove remaining order-based active-version fallback', () => {
  let root: string
  let store: EvolutionStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'evo-221-'))
    store = new EvolutionStore({ fallbackRoot: root })
    await store.init()
    // Ensure version directory exists
    await import('node:fs/promises').then(m => m.mkdir(join(root, 'versions'), { recursive: true }))
  })

  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  // ──────────────────────────────────────────────────────────────────────────
  // T1 — zero versions, no pointer → explicit no-active state (null)
  // ──────────────────────────────────────────────────────────────────────────
  it('T1: zero versions + no pointer returns null', async () => {
    const active = await store.getActiveVersion()
    expect(active).toBeNull()
  })

  // ──────────────────────────────────────────────────────────────────────────
  // T2 — historical versions, zero active, no pointer → null (not versions[0])
  // ──────────────────────────────────────────────────────────────────────────
  it('T2: historical versions + zero active + no pointer → null, not versions[0]', async () => {
    await writeVersion(root, 'v1', 1, 'historical', 'rolled-back')
    await writeVersion(root, 'v2', 2, 'historical', 'rolled-back')
    await writeVersion(root, 'v3', 3, 'historical', 'rolled-back')

    const active = await store.getActiveVersion()
    expect(active).toBeNull()

    // Verify historical records are still readable and unmodified
    const v1 = await store.getVersion('v1')
    expect(v1).not.toBeNull()
    expect(v1!.status).toBe('rolled-back')
    expect(v1!.id).toBe('v1')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // T3 — stale pointer + historical versions + zero active → null
  // ──────────────────────────────────────────────────────────────────────────
  it('T3: stale pointer + historical versions + zero active → null', async () => {
    await writeVersion(root, 'v1', 1, 'historical', 'rolled-back')
    await writeVersion(root, 'v2', 2, 'historical', 'rolled-back')
    await writePointer(root, 'v999')

    const active = await store.getActiveVersion()
    expect(active).toBeNull()

    // Pointer should NOT have been repaired (no active version to recover)
    const pointer = await readPointer(root)
    expect(pointer).not.toBeNull()
    expect(pointer!.versionId).toBe('v999') // stale pointer preserved
  })

  // ──────────────────────────────────────────────────────────────────────────
  // T4 — corrupt pointer + historical versions + zero active → null
  // ──────────────────────────────────────────────────────────────────────────
  it('T4: corrupt pointer + historical versions + zero active → null', async () => {
    await writeVersion(root, 'v1', 1, 'historical', 'rolled-back')
    await writeVersion(root, 'v2', 2, 'historical', 'rolled-back')
    await writeFile(join(root, ACTIVE_VERSION_POINTER), 'CORRUPT', 'utf8')

    const active = await store.getActiveVersion()
    expect(active).toBeNull()
  })

  // ──────────────────────────────────────────────────────────────────────────
  // T5 — missing pointer + exactly one active + historical versions → recovery
  // ──────────────────────────────────────────────────────────────────────────
  it('T5: missing pointer + exactly one active + historical → deterministic recovery', async () => {
    await writeVersion(root, 'v1', 1, 'historical', 'rolled-back')
    await writeVersion(root, 'v2', 2, 'historical', 'rolled-back')
    await writeVersion(root, 'v3', 3, 'target', 'active')

    const active = await store.getActiveVersion()
    expect(active).not.toBeNull()
    expect(active!.id).toBe('v3')

    // Pointer should be repaired
    const pointer = await readPointer(root)
    expect(pointer).not.toBeNull()
    expect(pointer!.versionId).toBe('v3')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // T6 — corrupt pointer + exactly one active + historical → recovery
  // ──────────────────────────────────────────────────────────────────────────
  it('T6: corrupt pointer + exactly one active + historical → deterministic recovery', async () => {
    await writeVersion(root, 'v1', 1, 'historical', 'rolled-back')
    await writeVersion(root, 'v2', 2, 'historical', 'rolled-back')
    await writeVersion(root, 'v3', 3, 'target', 'active')
    await writeFile(join(root, ACTIVE_VERSION_POINTER), 'NOT_JSON', 'utf8')

    const active = await store.getActiveVersion()
    expect(active).not.toBeNull()
    expect(active!.id).toBe('v3')

    const pointer = await readPointer(root)
    expect(pointer!.versionId).toBe('v3')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // T7 — stale pointer + exactly one active + historical → recovery
  // ──────────────────────────────────────────────────────────────────────────
  it('T7: stale pointer + exactly one active + historical → deterministic recovery', async () => {
    await writeVersion(root, 'v1', 1, 'historical', 'rolled-back')
    await writeVersion(root, 'v2', 2, 'historical', 'rolled-back')
    await writeVersion(root, 'v3', 3, 'target', 'active')
    await writePointer(root, 'v999')

    const active = await store.getActiveVersion()
    expect(active).not.toBeNull()
    expect(active!.id).toBe('v3')

    const pointer = await readPointer(root)
    expect(pointer!.versionId).toBe('v3')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // T8 — missing pointer + multiple active + historical → ambiguity error
  // ──────────────────────────────────────────────────────────────────────────
  it('T8: missing pointer + multiple active + historical → throws ambiguity error', async () => {
    await writeVersion(root, 'v1', 1, 'historical', 'rolled-back')
    await writeVersion(root, 'v2', 2, 'target-a', 'active')
    await writeVersion(root, 'v3', 3, 'target-b', 'active')

    await expect(store.getActiveVersion()).rejects.toThrow('ambiguous active state')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // T9 — corrupt pointer + multiple active + historical → ambiguity error
  // ──────────────────────────────────────────────────────────────────────────
  it('T9: corrupt pointer + multiple active + historical → throws ambiguity error', async () => {
    await writeVersion(root, 'v1', 1, 'historical', 'rolled-back')
    await writeVersion(root, 'v2', 2, 'target-a', 'active')
    await writeVersion(root, 'v3', 3, 'target-b', 'active')
    await writeFile(join(root, ACTIVE_VERSION_POINTER), 'CORRUPT', 'utf8')

    await expect(store.getActiveVersion()).rejects.toThrow('ambiguous active state')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // T10 — valid pointer + duplicate status metadata → pointer wins
  // ──────────────────────────────────────────────────────────────────────────
  it('T10: valid pointer + duplicate status metadata → pointer remains authoritative', async () => {
    await writeVersion(root, 'v1', 1, 'target', 'active')
    await writeVersion(root, 'v2', 2, 'duplicate', 'active')
    await writePointer(root, 'v1')

    const active = await store.getActiveVersion()
    expect(active).not.toBeNull()
    expect(active!.id).toBe('v1') // pointer wins, not first by status scan
  })

  // ──────────────────────────────────────────────────────────────────────────
  // T11 — reordered version list → same result (order independence)
  // ──────────────────────────────────────────────────────────────────────────
  it('T11: reordered version list does not affect zero-active result', async () => {
    // Create versions in reverse order (v3 first, then v2, then v1)
    await writeVersion(root, 'v3', 3, 'historical', 'rolled-back')
    await writeVersion(root, 'v2', 2, 'historical', 'rolled-back')
    await writeVersion(root, 'v1', 1, 'historical', 'rolled-back')

    const active = await store.getActiveVersion()
    expect(active).toBeNull()

    // Same result regardless of creation order
    await rm(join(root, 'versions', 'v1.json'), { force: true })
    await rm(join(root, 'versions', 'v2.json'), { force: true })
    await rm(join(root, 'versions', 'v3.json'), { force: true })

    await writeVersion(root, 'v1', 1, 'historical', 'rolled-back')
    await writeVersion(root, 'v2', 2, 'historical', 'rolled-back')
    await writeVersion(root, 'v3', 3, 'historical', 'rolled-back')

    const active2 = await store.getActiveVersion()
    expect(active2).toBeNull()
  })

  // ──────────────────────────────────────────────────────────────────────────
  // T12 — restart preserves zero-active state
  // ──────────────────────────────────────────────────────────────────────────
  it('T12: restart preserves zero-active state with historical versions', async () => {
    await writeVersion(root, 'v1', 1, 'historical', 'rolled-back')
    await writeVersion(root, 'v2', 2, 'historical', 'rolled-back')

    const active = await store.getActiveVersion()
    expect(active).toBeNull()

    // Simulate restart: fresh store instance, same root
    const freshStore = new EvolutionStore({ fallbackRoot: root })
    await freshStore.init()

    const activeAfterRestart = await freshStore.getActiveVersion()
    expect(activeAfterRestart).toBeNull()

    // Historical versions remain readable
    const v1 = await freshStore.getVersion('v1')
    expect(v1).not.toBeNull()
    expect(v1!.status).toBe('rolled-back')
  })

  // ──────────────────────────────────────────────────────────────────────────
  // T13 — init does not assign historical versions as active
  // ──────────────────────────────────────────────────────────────────────────
  it('T13: init() leaves pointer absent when zero active versions exist', async () => {
    await writeVersion(root, 'v1', 1, 'historical', 'rolled-back')
    await writeVersion(root, 'v2', 2, 'historical', 'rolled-back')

    const freshStore = new EvolutionStore({ fallbackRoot: root })
    await freshStore.init()

    const pointer = await readPointer(root)
    expect(pointer).toBeNull() // no pointer created

    const active = await freshStore.getActiveVersion()
    expect(active).toBeNull()
  })
})
