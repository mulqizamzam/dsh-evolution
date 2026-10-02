/**
 * Mission 2.3 — Deterministic Experience Pruning regression tests.
 */
import { describe, it, expect } from 'vitest'
import { mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { isoDateTime } from '../src/lib/ids.ts'
import { writeJsonFile } from '../src/lib/fsx.ts'

// ── helpers ──

const FROZEN_NOW = new Date('2026-09-26T12:00:00.000Z')
const FROZEN_TS = isoDateTime(FROZEN_NOW)
const RETENTION_DAYS = 30
const MAX_RECORDS = 5

async function makeStore(root: string): Promise<EvolutionStore> {
  const store = new EvolutionStore({ fallbackRoot: root, now: () => FROZEN_NOW })
  await store.init()
  return store
}

async function addExperiences(
  store: EvolutionStore,
  pairs: Array<{ id: string; timestamp: string; success: boolean }>,
): Promise<void> {
  const dir = store['experienceDir']()
  for (const p of pairs) {
    const rec = { id: p.id, timestamp: p.timestamp, prompt: 'test', summary: 'test', success: p.success }
    await writeJsonFile(join(dir, `${p.id}.json`), rec)
  }
}

// ── T1: equal timestamps, maxRecords ──

describe('T1 — equal timestamps + maxRecords', () => {
  it('same subset survives every run', async () => {
    const root = join(tmpdir(), 'evo-m23-t1-' + Date.now())
    try {
      const store = await makeStore(root)
      const ids = ['aaaaaaaaffff', 'bbbbbbbbeeee', 'ccccccccdddd', 'ddddddddcccc', 'eeeeeeeebbbb', 'ffffffffaaaa']
      await addExperiences(store, ids.map(id => ({ id, timestamp: FROZEN_TS, success: true })))

      const r1 = await store.pruneExperiences(MAX_RECORDS, RETENTION_DAYS)
      const survivors1 = (await store.listExperiences(100)).map(e => e.id).sort()
      const r2 = await store.pruneExperiences(MAX_RECORDS, RETENTION_DAYS)
      const survivors2 = (await store.listExperiences(100)).map(e => e.id).sort()

      expect(r1).toBe(1)
      expect(r2).toBe(0)
      expect(survivors1).toEqual(survivors2)
      expect(survivors1).toHaveLength(MAX_RECORDS)
      // lex-smallest pruned (first in sorted order), lex-largest 5 survive
      expect(survivors1).toEqual(['bbbbbbbbeeee', 'ccccccccdddd', 'ddddddddcccc', 'eeeeeeeebbbb', 'ffffffffaaaa'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ── T2: reordered input → same survivors ──

describe('T2 — reordered input lists produce same survivors', () => {
  it('different listDir order, same result', async () => {
    async function runWithOrder(presentOrder: string[]): Promise<string[]> {
      const root = join(tmpdir(), 'evo-m23-t2-' + Date.now() + '-' + Math.random())
      const store = await makeStore(root)
      const dir = store['experienceDir']()
      for (const id of presentOrder) {
        const rec = { id, timestamp: FROZEN_TS, prompt: 'test', summary: 'test', success: true }
        await writeJsonFile(join(dir, `${id}.json`), rec)
      }
      await store.pruneExperiences(MAX_RECORDS, RETENTION_DAYS)
      return (await store.listExperiences(100)).map(e => e.id).sort()
    }

    const ids = ['aaaaaaaaffff', 'bbbbbbbbeeee', 'ccccccccdddd', 'ddddddddcccc', 'eeeeeeeebbbb', 'ffffffffaaaa']
    const orderA = ids
    const orderB = [...ids].reverse()
    const survivalA = await runWithOrder(orderA)
    const survivalB = await runWithOrder(orderB)
    expect(survivalA).toEqual(survivalB)
  })
})

// ── T3: repeated execution idempotent ──

describe('T3 — repeated prune is idempotent', () => {
  it('second prune on already-capped store deletes nothing', async () => {
    const root = join(tmpdir(), 'evo-m23-t3-' + Date.now())
    try {
      const store = await makeStore(root)
      const ids = ['id0000000001', 'id0000000002', 'id0000000003', 'id0000000004', 'id0000000005', 'id0000000006']
      await addExperiences(store, ids.map(id => ({ id, timestamp: FROZEN_TS, success: true })))

      const r1 = await store.pruneExperiences(MAX_RECORDS, RETENTION_DAYS)
      const after1 = await store.listExperiences(100)
      const r2 = await store.pruneExperiences(MAX_RECORDS, RETENTION_DAYS)
      const after2 = await store.listExperiences(100)

      expect(r1).toBe(1)
      expect(r2).toBe(0)
      expect(after2.map(e => e.id)).toEqual(after1.map(e => e.id))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ── T4: distinct timestamps preserve existing newest semantics ──

describe('T4 — distinct timestamps preserve chronological behavior', () => {
  it('oldest records removed, newest retained', async () => {
    const root = join(tmpdir(), 'evo-m23-t4-' + Date.now())
    try {
      const store = await makeStore(root)
      const t1 = isoDateTime(new Date('2026-09-22T00:00:00.000Z'))
      const t2 = isoDateTime(new Date('2026-09-23T00:00:00.000Z'))
      const t3 = isoDateTime(new Date('2026-09-24T00:00:00.000Z'))
      const t4 = isoDateTime(new Date('2026-09-25T00:00:00.000Z'))
      await addExperiences(store, [
        { id: 'old-a', timestamp: t1, success: true },
        { id: 'old-b', timestamp: t2, success: false },
        { id: 'old-c', timestamp: t3, success: true },
        { id: 'new-a', timestamp: t4, success: true },
        { id: 'new-b', timestamp: t4, success: true },
        { id: 'new-c', timestamp: t4, success: false },
        { id: 'new-d', timestamp: t4, success: true },
      ])

      const removed = await store.pruneExperiences(MAX_RECORDS, RETENTION_DAYS)
      const survivors = (await store.listExperiences(100)).map(e => e.id).sort()

      expect(removed).toBe(2) // two oldest: old-a, old-b
      expect(survivors).toEqual(['new-a', 'new-b', 'new-c', 'new-d', 'old-c'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ── T5: TTL only ──

describe('T5 — TTL filtering unchanged', () => {
  it('expired records removed, non-expired retained regardless of count', async () => {
    const root = join(tmpdir(), 'evo-m23-t5-' + Date.now())
    try {
      const store = await makeStore(root)
      const tExpired = isoDateTime(new Date('2026-08-01T00:00:00.000Z'))
      const tValid = isoDateTime(new Date('2026-09-20T00:00:00.000Z'))
      await addExperiences(store, [
        { id: 'exp-a', timestamp: tExpired, success: true },
        { id: 'exp-b', timestamp: tExpired, success: false },
        { id: 'val-c', timestamp: tValid, success: true },
        { id: 'val-d', timestamp: tValid, success: true },
      ])

      const removed = await store.pruneExperiences(10, RETENTION_DAYS)
      const survivors = (await store.listExperiences(100)).map(e => e.id).sort()

      expect(removed).toBe(2)
      expect(survivors).toEqual(['val-c', 'val-d'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ── T6: TTL + cap ──

describe('T6 — TTL + cap together', () => {
  it('expired removed first, then cap applied to remainder', async () => {
    const root = join(tmpdir(), 'evo-m23-t6-' + Date.now())
    try {
      const store = await makeStore(root)
      const tExpired = isoDateTime(new Date('2026-08-01T00:00:00.000Z'))
      const tNow = FROZEN_TS
      const validIds = ['v-aaaa', 'v-bbbb', 'v-cccc', 'v-dddd', 'v-eeee', 'v-ffff']
      await addExperiences(store, [
        { id: 'expired-1', timestamp: tExpired, success: true },
        ...validIds.map(id => ({ id, timestamp: tNow, success: true })),
      ])

      const removed = await store.pruneExperiences(5, RETENTION_DAYS)
      const survivors = (await store.listExperiences(100)).map(e => e.id).sort()

      expect(removed).toBe(2)
      // v-aaaa is lex-smallest among tied timestamps → pruned first
      expect(survivors).toEqual(['v-bbbb', 'v-cccc', 'v-dddd', 'v-eeee', 'v-ffff'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ── T7: retained files byte-for-byte unchanged ──

describe('T7 — retained experience files are untouched', async () => {
  it('surviving records keep their exact JSON content', async () => {
    const root = join(tmpdir(), 'evo-m23-t7-' + Date.now())
    try {
      const store = await makeStore(root)
      // All 6 records same timestamp, capped to 5.
      // Sort: (timestamp asc, id asc) → all same ts, so id asc →
      // "aaaaaa" is lex-smallest → pruned; "bbbbb" through "ffffff" survive.
      const ids = ['a-0000000001', 'b-0000000002', 'c-0000000003', 'd-0000000004', 'e-0000000005', 'f-0000000006']
      await addExperiences(store, ids.map(id => ({ id, timestamp: FROZEN_TS, success: true })))

      // Capture pre-prune content of all files.
      const preContents = new Map<string, string>()
      for (const id of ids) {
        preContents.set(id, await readFile(join(store['experienceDir'](), `${id}.json`), 'utf8'))
      }

      const removed = await store.pruneExperiences(MAX_RECORDS, RETENTION_DAYS)
      expect(removed).toBe(1)

      // 5 survivors: b-0000000002 through f-0000000006
      const survivors = (await store.listExperiences(100)).map(e => e.id).sort()
      expect(survivors).toEqual(['b-0000000002', 'c-0000000003', 'd-0000000004', 'e-0000000005', 'f-0000000006'])

      // Each survivor is byte-for-byte unchanged
      for (const id of survivors) {
        const post = await readFile(join(store['experienceDir'](), `${id}.json`), 'utf8')
        expect(post).toBe(preContents.get(id))
      }

      // Pruned file is gone
      await expect(readFile(join(store['experienceDir'](), 'a-0000000001.json'), 'utf8'))
        .rejects.toThrow(/ENOENT/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ── T8: filesystem-order independence ──

describe('T8 — filesystem-order independence', () => {
  it('pruning result identical regardless of listDir sort order', async () => {
    const root = join(tmpdir(), 'evo-m23-t8-' + Date.now())
    try {
      const store = await makeStore(root)
      const ids = ['zzz-last', 'yyy-second', 'xxx-third', 'wwww-fourth', 'vvv-fifth', 'uuu-sixth']
      await addExperiences(store, ids.map(id => ({ id, timestamp: FROZEN_TS, success: true })))

      const removed = await store.pruneExperiences(MAX_RECORDS, RETENTION_DAYS)
      const survivors = (await store.listExperiences(100)).map(e => e.id).sort()

      expect(removed).toBe(1)
      // 'uuu-sixth' is lex-smallest → pruned; remaining 5 survive.
      expect(survivors).toEqual(['vvv-fifth', 'wwww-fourth', 'xxx-third', 'yyy-second', 'zzz-last'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ── T9: boundary — exactly maxRecords with tied timestamps ──

describe('T9 — boundary: exactly maxRecords tied', () => {
  it('no deletion when count equals cap', async () => {
    const root = join(tmpdir(), 'evo-m23-t9-' + Date.now())
    try {
      const store = await makeStore(root)
      const ids = ['id-1', 'id-2', 'id-3', 'id-4', 'id-5']
      await addExperiences(store, ids.map(id => ({ id, timestamp: FROZEN_TS, success: true })))

      const removed = await store.pruneExperiences(MAX_RECORDS, RETENTION_DAYS)
      const survivors = await store.listExperiences(100)

      expect(removed).toBe(0)
      expect(survivors).toHaveLength(5)
      expect(survivors.map(e => e.id).sort()).toEqual(ids.sort())
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ── T10: empty / small store ──

describe('T10 — empty and small store', () => {
  it('empty store prunes to zero', async () => {
    const root = join(tmpdir(), 'evo-m23-t10-' + Date.now())
    try {
      const store = await makeStore(root)
      const removed = await store.pruneExperiences(MAX_RECORDS, RETENTION_DAYS)
      expect(removed).toBe(0)
      expect(await store.listExperiences(100)).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fewer records than cap: no deletion', async () => {
    const root = join(tmpdir(), 'evo-m23-t10b-' + Date.now())
    try {
      const store = await makeStore(root)
      await addExperiences(store, [
        { id: 'a', timestamp: FROZEN_TS, success: true },
        { id: 'b', timestamp: FROZEN_TS, success: false },
      ])
      const removed = await store.pruneExperiences(MAX_RECORDS, RETENTION_DAYS)
      expect(removed).toBe(0)
      expect((await store.listExperiences(100))).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
