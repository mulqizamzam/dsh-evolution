import { join } from 'node:path'
import { ensureDir, ensureStateRoot, resolveStateRoot } from '../lib/home.ts'
import type { ContextGet } from '../lib/home.ts'
import { readJsonSafe, writeJsonAtomic, writeJsonFile, listDir, removeFile, readJsonlSafe, writeJsonlAtomic } from '../lib/fsx.ts'
import { newId, isoDateTime, versionId, isSafeKey } from '../lib/ids.ts'
import type {
  ExperienceRecord, Pattern, CandidateModule, BenchmarkRun, Version,
} from './types.ts'

/** Path to the single canonical active-version pointer file. */
export const ACTIVE_VERSION_POINTER = 'active-version.json'

/**
 * Shape of the active-version pointer file on disk.
 *
 * `generation` is an optimistic-concurrency token that is incremented on
 * every pointer mutation (createVersion, rollbackVersion, bootstrap repair).
 * Before a mutation completes, the calling method re-reads the pointer and
 * compares its generation against the value observed at the start of the
 * operation.  A mismatch (another operation bumped it in the meantime)
 * causes the mutation to abort and report a conflict rather than silently
 * overwriting the winner's pointer.
 *
 * Legacy pointer files without a `generation` field are treated as
 * generation 0, so state roots created before M3.4 remain readable.
 */
export interface ActivePointer {
  versionId: string
  generation: number
}

/** Read the active pointer, normalising legacy (generation-free) files. */
async function readActivePointerSafe(path: string): Promise<ActivePointer | null> {
  const raw = (await readJsonSafe(path)) as { versionId?: unknown; generation?: unknown } | null
  if (!raw || typeof raw.versionId !== 'string' || raw.versionId === '') return null
  // Legacy pointer without generation field → treat as generation 0.
  const generation = typeof raw.generation === 'number' ? raw.generation : 0
  return { versionId: raw.versionId, generation }
}

/**
 * Result of an optimistic-concurrency check.  `ok: true` means the pointer
 * is unchanged since the observed generation; `ok: false` carries the
 * description of the conflict for the caller to surface.
 */
export type PointerConflictResult =
  | { ok: true }
  | { ok: false; error: string }

export interface StoreOptions {
  get?: ContextGet
  fallbackRoot?: string
  /**
   * Optional profile name (e.g. 'web', 'evo-live'). When supplied, the
   * resolved root is scoped under <home>/dsh-evolution/<profile> so that
   * different profiles maintain independent mutable state.
   */
  profileName?: string
  now?: () => Date
}

/** SCHEMA_VERSION: bumped when file layout changes. */
export const SCHEMA_VERSION = 1

/** Cache TTL for list operations: 5 seconds. Stale reads are acceptable because
 *  every mutation path invalidates the cache before returning. */
const CACHE_TTL_MS = 5_000

/**
 * In-memory cache entry for list operations. Keyed by "(method,limit)".
 */
type CacheEntry<T> = { ts: number; value: T }

export class EvolutionStore {
  private root: string
  private nowFn: () => Date
  /** LRU-style cache: key → { timestamp, value }. Cleared on every mutation. */
  private readonly cache = new Map<string, CacheEntry<unknown>>()
  /** In-memory index: candidateId → [BenchmarkRun, ...]. Populated on first read, invalidated on mutation. */
  private readonly _benchmarkByCandidate = new Map<string, BenchmarkRun[]>()
  /** In-memory index: versionId → [ExperienceRecord, ...]. Populated on first read, invalidated on mutation. */
  private readonly _experienceByVersion = new Map<string, ExperienceRecord[]>()

  constructor(options: StoreOptions) {
    this.root = resolveStateRoot(options.get, options.fallbackRoot, options.profileName)
    this.nowFn = options.now ?? (() => new Date())
  }

  async init(): Promise<string> {
    await ensureStateRoot(this.root)
    // Legacy bootstrap: if no canonical pointer exists and exactly one version
    // is unambiguously active, create the pointer once so subsequent boots use
    // the canonical path rather than re-scanning.
    //
    // Case 1 (zero versions): leave as-is — empty state is valid.
    // Case 2 (one active): deterministic bootstrap, pointer written once.
    // Case 3 (multiple active): throw — ambiguous legacy state must not be
    //   silently resolved; operator must repair.
    try {
      const pointer = await readActivePointerSafe(this.activePointerPath())
      if (pointer) return this.root
    } catch { /* missing — proceed to bootstrap */ }
    const versions = await this.listVersions()
    const activeVersions = versions.filter(v => v.status === 'active')
    if (activeVersions.length === 1) {
      await writeJsonAtomic(this.activePointerPath(), {
        versionId: activeVersions[0]!.id,
        generation: 1,
      } satisfies ActivePointer)
    } else if (activeVersions.length > 1) {
      throw new Error(
        'ambiguous legacy state at init: ' + activeVersions.map(v => v.id).join(', ')
          + ' all have status=active; cannot bootstrap canonical pointer'
      )
    }
    // Zero active versions (or no versions at all): leave pointer absent;
    // getActiveVersion() returns null in that case and activation deactivates.
    // Invalidate the cache so the first read-after-init sees the current disk
    // state, not whatever was present when the instance was constructed.
    this.invalidateCache()
    return this.root
  }

  getRoot(): string { return this.root }

  // ── Cache helpers ──

  private getCache<T>(key: string): T | null {
    const entry = this.cache.get(key)
    if (!entry) return null
    if (Date.now() - entry.ts < CACHE_TTL_MS) return entry.value as T
    this.cache.delete(key)
    return null
  }

  private setCache<T>(key: string, value: T): void {
    this.cache.set(key, { ts: Date.now(), value })
  }

  /** Invalidate every cached list entry. Called after any mutation. */
  private invalidateCache(): void {
    this.cache.clear()
    this._benchmarkByCandidate.clear()
    this._experienceByVersion.clear()
  }

  // ── Experience ──

  private experienceDir(): string { return join(this.root, 'experiences') }

  async addExperience(record: Omit<ExperienceRecord, 'id' | 'timestamp'>): Promise<ExperienceRecord> {
    const full: ExperienceRecord = {
      ...record,
      id: newId(),
      timestamp: isoDateTime(this.nowFn()),
    }
    await writeJsonAtomic(join(this.experienceDir(), `${full.id}.json`), full)
    // Also write to the .jsonl batch file for efficient bulk reads.
    await this.appendExperienceJsonl(full)
    this.invalidateCache()
    return full
  }

  /** Ensure the .jsonl file exists by migrating from individual .json files if needed. */
  private async ensureJsonlExists(): Promise<void> {
    const jsonlPath = join(this.experienceDir(), 'experiences.jsonl')
    try {
      await (await import('node:fs/promises')).access(jsonlPath)
      return // already exists
    } catch { /* doesn't exist — migrate */ }
    const files = await listDir(this.experienceDir(), Number.MAX_SAFE_INTEGER)
    const records: ExperienceRecord[] = []
    for (const f of files) {
      if (!f.endsWith('.json') || f === 'experiences.jsonl') continue
      const data = await readJsonSafe(join(this.experienceDir(), f))
      if (data && typeof data === 'object' && 'id' in (data as Record<string, unknown>)) {
        records.push(data as ExperienceRecord)
      }
    }
    if (records.length > 0) {
      await writeJsonlAtomic(jsonlPath, records)
    }
  }

  private async appendExperienceJsonl(record: ExperienceRecord): Promise<void> {
    const jsonlPath = join(this.experienceDir(), 'experiences.jsonl')
    try {
      await (await import('node:fs/promises')).appendFile(jsonlPath, JSON.stringify(record) + '\n', 'utf8')
    } catch {
      // File doesn't exist yet — create it with just this record.
      await writeJsonlAtomic(jsonlPath, [record])
    }
  }

  async getExperience(id: string): Promise<ExperienceRecord | null> {
    // id can originate from persisted evidence references (tamperable state);
    // it becomes a path component, so refuse anything that is not a safe key.
    if (!isSafeKey(id)) return null
    return (await readJsonSafe(join(this.experienceDir(), `${id}.json`))) as ExperienceRecord | null
  }

  async listExperiences(limit: number = 50): Promise<ExperienceRecord[]> {
    const key = `listExperiences:${limit}`
    const cached = this.getCache<ExperienceRecord[]>(key)
    if (cached !== null) return cached
    const jsonlPath = join(this.experienceDir(), 'experiences.jsonl')
    let records: ExperienceRecord[]
    try {
      await (await import('node:fs/promises')).access(jsonlPath)
      records = (await readJsonlSafe(jsonlPath)) as ExperienceRecord[]
    } catch {
      // .jsonl doesn't exist yet — migrate from individual files.
      await this.ensureJsonlExists()
      records = (await readJsonlSafe(jsonlPath)) as ExperienceRecord[]
    }
    // Sort by timestamp descending (newest first) to match listDir ordering.
    records.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    const result = records.slice(0, limit)
    this.setCache(key, result)
    return result
  }

  /**
   * Prune experience records based on TTL and count cap.
   * Removes records older than `retentionDays` and, if count exceeds `maxRecords`,
   * removes the oldest records until the cap is met.
   * Retained records are never rewritten — they remain byte-for-byte unchanged.
   * Missing or corrupt files are silently skipped (consistent with existing read semantics).
   *
   * @returns number of records removed
   */
  async pruneExperiences(maxRecords: number, retentionDays: number): Promise<number> {
    // Read ALL experience files (no limit here — we need the full set to prune correctly)
    const allFiles = await listDir(this.experienceDir(), 100000)
    // `file` is the readdir-derived name (a single directory-entry component,
    // inherently confined to this directory). Deletion uses `file`, NEVER the
    // record's `id` FIELD: the record content is persisted state that may have
    // been tampered with, and a crafted id like `../../x` must not be able to
    // direct a delete outside the experiences directory.
    const records: Array<{ id: string; timestamp: string; file: string; record: ExperienceRecord }> = []
    for (const f of allFiles) {
      if (!f.endsWith('.json')) continue
      const data = await readJsonSafe(join(this.experienceDir(), f))
      if (data && typeof data === 'object' && 'timestamp' in (data as Record<string, unknown>)) {
        const rec = data as ExperienceRecord
        if (typeof rec.id === 'string' && typeof rec.timestamp === 'string') {
          records.push({ id: rec.id, timestamp: rec.timestamp, file: f, record: rec })
        }
      }
    }

    const now = this.nowFn().getTime()
    const ttlMs = retentionDays * 24 * 60 * 60 * 1000
    const cutoff = now - ttlMs

    // Sort by timestamp ascending (oldest first) for deterministic pruning.
    // Secondary sort by id breaks ties when two records share an identical
    // timestamp — without this, the order depends on the original input
    // array (which is listDir's mtime-descending enumeration), making pruning
    // non-deterministic across runs with the same logical data.
    // id is a 12-char hex string from randomBytes(6), so lexicographic order
    // is a stable total order over the id space.
    records.sort((a, b) => {
      const t = a.timestamp.localeCompare(b.timestamp)
      return t !== 0 ? t : a.id.localeCompare(b.id)
    })

    let removed = 0
    const removedIds = new Set<string>()
    // Phase 1: remove expired records (TTL)
    for (const r of records) {
      const ts = new Date(r.timestamp).getTime()
      if (ts < cutoff) {
        await removeFile(join(this.experienceDir(), r.file))
        removedIds.add(r.id)
        removed++
      }
    }

    // Phase 2: enforce count cap (remove oldest first among remaining)
    const nonExpired = records.filter(r => new Date(r.timestamp).getTime() >= cutoff)
    if (nonExpired.length > maxRecords) {
      const toRemove = nonExpired.slice(0, nonExpired.length - maxRecords)
      for (const r of toRemove) {
        await removeFile(join(this.experienceDir(), r.file))
        removedIds.add(r.id)
        removed++
      }
    }

    // Phase 3: reconcile the .jsonl batch file.
    // `listExperiences()` reads experiences.jsonl as the authoritative source,
    // so a prune that only deletes .json files leaves the pruned records
    // visible on read. Every phase that removes something must therefore
    // rewrite the batch file from the surviving records.
    if (removed > 0) {
      const kept = records.filter(r => !removedIds.has(r.id))
      const keptIds = new Set(kept.map(r => r.id))
      // Preserve records that exist only in .jsonl (e.g. a .json write was
      // lost): dropping them here would silently delete live data.
      const jsonlOnly = (await readJsonlSafe(join(this.experienceDir(), 'experiences.jsonl')))
        .filter((r): r is ExperienceRecord => {
          if (!r || typeof r !== 'object') return false
          const rec = r as ExperienceRecord
          return typeof rec.id === 'string' && typeof rec.timestamp === 'string'
            && !keptIds.has(rec.id) && !removedIds.has(rec.id)
        })
      const survivors = [...kept.map(r => r.record), ...jsonlOnly]
      const jsonlPath = join(this.experienceDir(), 'experiences.jsonl')
      if (survivors.length > 0) {
        await writeJsonlAtomic(jsonlPath, survivors)
      } else {
        await removeFile(jsonlPath)
      }
    }

    this.invalidateCache()
    return removed
  }

  /**
   * Return only experiences that were recorded while a specific version was
   * active.  Used by post-promotion monitoring to attribute outcomes to the
   * version that was mounted at the time.
   *
   * Uses the in-memory experience-by-version index (populated on first call,
   * invalidated on mutation) so repeated calls avoid re-filtering the full
   * experience set from disk.
   */
  async listExperiencesByVersion(versionId: string, limit: number = 50): Promise<ExperienceRecord[]> {
    let index = this._experienceByVersion.get(versionId)
    if (index === undefined) {
      const all = await this.listExperiences(limit * 10)
      index = all.filter((e): e is ExperienceRecord & { versionId: string } => e.versionId === versionId)
      this._experienceByVersion.set(versionId, index)
    }
    return index.slice(0, limit)
  }

  // ── Patterns ──

  private patternDir(): string { return join(this.root, 'patterns') }

  async addPattern(pattern: Omit<Pattern, 'id' | 'createdAt'>): Promise<Pattern> {
    const full: Pattern = {
      ...pattern,
      id: newId(),
      createdAt: isoDateTime(this.nowFn()),
    }
    await writeJsonAtomic(join(this.patternDir(), `${full.id}.json`), full)
    this.invalidateCache()
    return full
  }

  async listPatterns(limit: number = 100): Promise<Pattern[]> {
    const key = `listPatterns:${limit}`
    const cached = this.getCache<Pattern[]>(key)
    if (cached !== null) return cached
    const files = await listDir(this.patternDir(), limit)
    const patterns: Pattern[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const data = await readJsonSafe(join(this.patternDir(), f))
      if (data && typeof data === 'object') patterns.push(data as Pattern)
    }
    this.setCache(key, patterns)
    return patterns
  }

  // ── Candidates ──

  private candidateDir(): string { return join(this.root, 'candidates') }

  async addCandidate(candidate: Omit<CandidateModule, 'id' | 'createdAt' | 'updatedAt'>): Promise<CandidateModule> {
    const full: CandidateModule = {
      ...candidate,
      id: newId(),
      createdAt: isoDateTime(this.nowFn()),
      updatedAt: isoDateTime(this.nowFn()),
    }
    await writeJsonAtomic(join(this.candidateDir(), `${full.id}.json`), full)
    this.invalidateCache()
    return full
  }

  async getCandidate(id: string): Promise<CandidateModule | null> {
    // candidateId reaches this from tool arguments and from persisted records
    // (benchmarks, versions) that may have been tampered with; it becomes a
    // path component under candidates/, so an unsafe key must never be joined.
    if (!isSafeKey(id)) return null
    return (await readJsonSafe(join(this.candidateDir(), `${id}.json`))) as CandidateModule | null
  }

  async updateCandidate(id: string, updates: Partial<CandidateModule>): Promise<CandidateModule | null> {
    if (!isSafeKey(id)) return null
    const existing = await this.getCandidate(id)
    if (!existing) return null
    const updated = { ...existing, ...updates, id, updatedAt: isoDateTime(this.nowFn()) }
    await writeJsonAtomic(join(this.candidateDir(), `${id}.json`), updated)
    this.invalidateCache()
    return updated
  }

  async listCandidates(limit: number = 50): Promise<CandidateModule[]> {
    const key = `listCandidates:${limit}`
    const cached = this.getCache<CandidateModule[]>(key)
    if (cached !== null) return cached
    const files = await listDir(this.candidateDir(), limit)
    const candidates: CandidateModule[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const data = await readJsonSafe(join(this.candidateDir(), f))
      if (data && typeof data === 'object') candidates.push(data as CandidateModule)
    }
    this.setCache(key, candidates)
    return candidates
  }

  // ── Benchmarks ──

  private benchmarkDir(): string { return join(this.root, 'benchmarks') }

  async addBenchmark(
    run: Omit<BenchmarkRun, 'id' | 'createdAt'>,
    createdAt?: string,
  ): Promise<BenchmarkRun> {
    const full: BenchmarkRun = {
      ...run,
      id: newId(),
      createdAt: createdAt ?? isoDateTime(this.nowFn()),
    }
    await writeJsonAtomic(join(this.benchmarkDir(), `${full.id}.json`), full)
    this.invalidateCache()
    return full
  }

  async listBenchmarks(limit: number = 50): Promise<BenchmarkRun[]> {
    const key = `listBenchmarks:${limit}`
    const cached = this.getCache<BenchmarkRun[]>(key)
    if (cached !== null) return cached
    const files = await listDir(this.benchmarkDir(), limit)
    const runs: BenchmarkRun[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const data = await readJsonSafe(join(this.benchmarkDir(), f))
      if (data && typeof data === 'object') runs.push(data as BenchmarkRun)
    }
    this.setCache(key, runs)
    return runs
  }

  /**
   * Every benchmark record for one candidate, newest first.
   *
   * Uses an in-memory index (populated on first call, invalidated on mutation)
   * so subsequent lookups are O(1) instead of scanning every file on disk.
   *
   * @param forceRefresh when true, bypasses the cache and reads from disk.
   *   Use this in security-critical paths (promotion policy evaluation) where
   *   the on-disk record may have been tampered with outside the store API.
   */
  async listBenchmarksByCandidate(candidateId: string, forceRefresh = false): Promise<BenchmarkRun[]> {
    if (!forceRefresh) {
      const cached = this._benchmarkByCandidate.get(candidateId)
      if (cached !== undefined) return cached
    }
    const files = await listDir(this.benchmarkDir(), Number.MAX_SAFE_INTEGER)
    const runs: BenchmarkRun[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const data = await readJsonSafe(join(this.benchmarkDir(), f))
      if (data && typeof data === 'object' && (data as BenchmarkRun).candidateId === candidateId) {
        runs.push(data as BenchmarkRun)
      }
    }
    runs.sort((x, y) => (x.createdAt > y.createdAt ? -1 : 1))
    if (!forceRefresh) this._benchmarkByCandidate.set(candidateId, runs)
    return runs
  }

  // ── Versions ──

  private versionDir(): string { return join(this.root, 'versions') }

  async getVersion(id: string): Promise<Version | null> {
    if (!isSafeKey(id)) return null
    return (await readJsonSafe(join(this.versionDir(), `${id}.json`))) as Version | null
  }

  /**
   * The single canonical persisted active-version pointer file.
   * Stores `{ versionId, generation }` — the authoritative answer to
   * "which version is active?" and "how many times has the pointer been
   * mutated?".  When the file is missing (fresh state root, or legacy data),
   * this falls back to scanning version records for status='active'.
   */
  private activePointerPath(): string { return join(this.root, ACTIVE_VERSION_POINTER) }

  /**
   * Read the current active-version pointer, returning both the version and
   * the generation token.  Used by `createVersion` and `rollbackVersion` to
   * implement optimistic concurrency: the caller passes the observed
   * generation back when committing, and the store rejects the commit if
   * the pointer has been mutated by a concurrent operation in the meantime.
   */
  async readPointer(): Promise<ActivePointer | null> {
    return readActivePointerSafe(this.activePointerPath())
  }

  /**
   * Check whether the pointer has been mutated since the given observed
   * generation.  Returns `{ ok: true }` when unchanged (generation matches
   * or the pointer is absent), and a conflict error otherwise.
   */
  async checkPointerUnchanged(observedGeneration: number): Promise<PointerConflictResult> {
    const current = await readActivePointerSafe(this.activePointerPath())
    if (current === null) {
      // Pointer was deleted or never created; legacy state.  Only safe when
      // the observed generation was also 0 (no prior pointer).
      if (observedGeneration === 0) return { ok: true }
      return { ok: false, error: `active pointer deleted unexpectedly (observed generation ${observedGeneration}, now absent)` }
    }
    if (current.generation !== observedGeneration) {
      return {
        ok: false,
        error: `active pointer changed concurrently: observed generation ${observedGeneration}, now ${current.generation} (points to ${current.versionId}); aborting to prevent stale overwrite`,
      }
    }
    return { ok: true }
  }

  async getActiveVersion(): Promise<Version | null> {
    // ── Canonical path: read the explicit pointer ──
    const pointer = await readActivePointerSafe(this.activePointerPath())
    if (pointer) {
      const candidate = await this.getVersion(pointer.versionId)
      if (candidate) return candidate
      // Pointer references a version that no longer exists on disk — fall
      // through to recovery scan.
    }
    // Pointer missing or stale — recover from version records.
    const versions = await this.listVersions()
    const activeVersions = versions.filter(v => v.status === 'active')
    if (activeVersions.length === 1) {
      // Unambiguous: repair the pointer atomically so subsequent reads use
      // the canonical path instead of re-scanning.
      const currentPointer = await readActivePointerSafe(this.activePointerPath())
      const newGeneration = (currentPointer?.generation ?? 0) + 1
      await writeJsonAtomic(this.activePointerPath(), {
        versionId: activeVersions[0]!.id,
        generation: newGeneration,
      } satisfies ActivePointer)
      return activeVersions[0]
    }
    if (activeVersions.length > 1) {
      throw new Error(
        'ambiguous active state: ' + activeVersions.map(v => v.id).join(', ')
          + ' all have status=active; pointer is missing/corrupt and underlying state is ambiguous'
      )
    }
    // No pointer and zero active versions — explicit no-active state.
    // Historical versions (status='rolled-back') must never be selected by
    // ordering alone. Return null so callers can distinguish "no active" from
    // "active is vN".
    return null
  }

  async createVersion(data: { label: string; reason?: string; promotedFrom?: string; benchmarkRunId?: string; activeMetrics?: import('./types.ts').BenchmarkMetrics; modules: string[] }): Promise<Version> {
    const versions = await this.listVersions()
    const nextNumber = versions.length === 0 ? 1 : Math.max(...versions.map(v => v.number)) + 1
    const version: Version = {
      id: versionId(nextNumber),
      number: nextNumber,
      label: data.label,
      createdAt: isoDateTime(this.nowFn()),
      promotedFrom: data.promotedFrom,
      benchmarkRunId: data.benchmarkRunId,
      reason: data.reason,
      status: 'active',
      modules: data.modules,
      activeMetrics: data.activeMetrics,
    }
    // Capture the previous active version BEFORE any writes.  Resolve from the
    // canonical pointer (not status metadata) so that createVersion() and
    // getActiveVersion() cannot diverge when pointer/status are out of sync.
    // Only mark a version rolled-back if one was genuinely active; a historical
    // (rolled-back) record must not be silently re-selected by ordering.
    const pointerBefore = await readActivePointerSafe(this.activePointerPath())
    const observedGeneration = pointerBefore?.generation ?? 0
    const oldActive = pointerBefore
      ? versions.find(v => v.id === pointerBefore.versionId) ?? null
      : null
    // The record's `id` FIELD is persisted state and can be tampered with; it
    // becomes a path component below, so refuse to write through it.
    if (oldActive && !isSafeKey(oldActive.id)) {
      throw new Error('corrupted active version record has an unsafe id: ' + JSON.stringify(String(oldActive.id)))
    }
    // Write the new version record FIRST (survives a mid-write crash).
    await writeJsonAtomic(join(this.versionDir(), `${version.id}.json`), version)
    // Before committing the pointer, verify no concurrent mutation happened.
    const check = await this.checkPointerUnchanged(observedGeneration)
    if (!check.ok) {
      // Undo the version record we just wrote to keep state consistent.
      await removeFile(join(this.versionDir(), `${version.id}.json`))
      throw new Error('concurrent promotion/rollback conflict: ' + check.error)
    }
    // Commit the canonical active pointer — this is the single authority.
    // Bump the generation so future concurrent operations detect this write.
    await writeJsonAtomic(this.activePointerPath(), {
      versionId: version.id,
      generation: observedGeneration + 1,
    } satisfies ActivePointer)
    // Mark the previous active version as rolled-back (historical record only).
    if (oldActive && oldActive.id !== version.id) {
      await writeJsonAtomic(join(this.versionDir(), `${oldActive.id}.json`), { ...oldActive, status: 'rolled-back' })
    }
    this.invalidateCache()
    return version
  }

  async listVersions(limit: number = 50): Promise<Version[]> {
    const key = `listVersions:${limit}`
    const cached = this.getCache<Version[]>(key)
    if (cached !== null) return cached
    const files = await listDir(this.versionDir(), limit)
    const versions: Version[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const data = await readJsonSafe(join(this.versionDir(), f))
      if (data && typeof data === 'object') versions.push(data as Version)
    }
    const sorted = versions.sort((a, b) => a.number - b.number)
    this.setCache(key, sorted)
    return sorted
  }

  async rollbackVersion(versionId: string): Promise<{ restored: Version; deactivated: Version | null; alreadyActive: boolean } | null> {
    if (!isSafeKey(versionId)) return null
    const target = await this.getVersion(versionId)
    if (!target) return null
    // target/active are persisted records whose `id` field becomes a path
    // component below; a tampered field must not direct the write.
    if (!isSafeKey(target.id)) return null

    // Read the pointer to get the observed generation before any writes.
    const pointerBefore = await readActivePointerSafe(this.activePointerPath())
    const observedGeneration = pointerBefore?.generation ?? 0

    // Resolve active from the pointer directly (fast path) or fall back to
    // version scan (legacy state).  We deliberately do NOT call getActiveVersion()
    // here because that method may repair the pointer, which would bump the
    // generation and invalidate observedGeneration.
    const activeVersion: Version | null = pointerBefore
      ? await this.getVersion(pointerBefore.versionId)
      : await this.getActiveVersion()
    const active = activeVersion ?? null

    if (active && !isSafeKey(active.id)) {
      throw new Error('corrupted active version record has an unsafe id: ' + JSON.stringify(String(active.id)))
    }
    if (active?.id === target.id) return { restored: target, deactivated: null, alreadyActive: true }

    // Verify the pointer has not been mutated by a concurrent operation.
    const check = await this.checkPointerUnchanged(observedGeneration)
    if (!check.ok) {
      throw new Error('concurrent promotion/rollback conflict: ' + check.error)
    }

    if (active) {
      // Mark old active as rolled-back (historical record only).
      await writeJsonAtomic(join(this.versionDir(), `${active.id}.json`), { ...active, status: 'rolled-back' })
    }
    // Mark target as active (historical record only — kept for query compatibility).
    await writeJsonAtomic(join(this.versionDir(), `${target.id}.json`), { ...target, status: 'active' })
    // Commit the canonical active pointer — the single authority.
    await writeJsonAtomic(this.activePointerPath(), {
      versionId: target.id,
      generation: observedGeneration + 1,
    } satisfies ActivePointer)
    this.invalidateCache()
    return { restored: target, deactivated: active, alreadyActive: false }
  }

  private async updateVersion(id: string, updates: Partial<Version>): Promise<Version | null> {
    if (!isSafeKey(id)) return null
    const existing = await this.getVersion(id)
    if (!existing) return null
    const updated = { ...existing, ...updates }
    await writeJsonAtomic(join(this.versionDir(), `${id}.json`), updated)
    this.invalidateCache()
    return updated
  }
}
