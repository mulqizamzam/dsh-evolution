import { join } from 'node:path'
import { ensureDir, ensureStateRoot, resolveStateRoot } from '../lib/home.ts'
import type { ContextGet } from '../lib/home.ts'
import { readJsonSafe, writeJsonAtomic, writeJsonFile, listDir, removeFile } from '../lib/fsx.ts'
import { newId, isoDateTime, versionId } from '../lib/ids.ts'
import type {
  ExperienceRecord, Pattern, CandidateModule, BenchmarkRun, Version,
} from './types.ts'

/** Path to the single canonical active-version pointer file. */
export const ACTIVE_VERSION_POINTER = 'active-version.json'

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

export class EvolutionStore {
  private root: string
  private nowFn: () => Date

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
      const pointer = await readJsonSafe(this.activePointerPath()) as { versionId: string } | null
      if (pointer && typeof pointer.versionId === 'string' && pointer.versionId !== '') return this.root
    } catch { /* missing — proceed to bootstrap */ }
    const versions = await this.listVersions()
    const activeVersions = versions.filter(v => v.status === 'active')
    if (activeVersions.length === 1) {
      await writeJsonAtomic(this.activePointerPath(), { versionId: activeVersions[0]!.id })
    } else if (activeVersions.length > 1) {
      throw new Error(
        'ambiguous legacy state at init: ' + activeVersions.map(v => v.id).join(', ')
          + ' all have status=active; cannot bootstrap canonical pointer'
      )
    }
    // Zero active versions (or no versions at all): leave pointer absent;
    // getActiveVersion() returns null in that case and activation deactivates.
    return this.root
  }

  getRoot(): string { return this.root }

  // ── Experience ──

  private experienceDir(): string { return join(this.root, 'experiences') }

  async addExperience(record: Omit<ExperienceRecord, 'id' | 'timestamp'>): Promise<ExperienceRecord> {
    const full: ExperienceRecord = {
      ...record,
      id: newId(),
      timestamp: isoDateTime(this.nowFn()),
    }
    await writeJsonAtomic(join(this.experienceDir(), `${full.id}.json`), full)
    return full
  }

  async getExperience(id: string): Promise<ExperienceRecord | null> {
    return (await readJsonSafe(join(this.experienceDir(), `${id}.json`))) as ExperienceRecord | null
  }

  async listExperiences(limit: number = 50): Promise<ExperienceRecord[]> {
    const files = await listDir(this.experienceDir(), limit)
    const records: ExperienceRecord[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const data = await readJsonSafe(join(this.experienceDir(), f))
      if (data && typeof data === 'object') records.push(data as ExperienceRecord)
    }
    return records
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
    const records: Array<{ id: string; timestamp: string }> = []
    for (const f of allFiles) {
      if (!f.endsWith('.json')) continue
      const data = await readJsonSafe(join(this.experienceDir(), f))
      if (data && typeof data === 'object' && 'timestamp' in (data as Record<string, unknown>)) {
        const rec = data as { id: string; timestamp: string }
        if (typeof rec.id === 'string' && typeof rec.timestamp === 'string') {
          records.push(rec)
        }
      }
    }

    const now = Date.now()
    const ttlMs = retentionDays * 24 * 60 * 60 * 1000
    const cutoff = now - ttlMs

    // Sort by timestamp ascending (oldest first) for deterministic pruning
    records.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

    let removed = 0
    // Phase 1: remove expired records (TTL)
    for (const r of records) {
      const ts = new Date(r.timestamp).getTime()
      if (ts < cutoff) {
        await removeFile(join(this.experienceDir(), `${r.id}.json`))
        removed++
      }
    }

    // Phase 2: enforce count cap (remove oldest first among remaining)
    const nonExpired = records.filter(r => new Date(r.timestamp).getTime() >= cutoff)
    if (nonExpired.length > maxRecords) {
      const toRemove = nonExpired.slice(0, nonExpired.length - maxRecords)
      for (const r of toRemove) {
        await removeFile(join(this.experienceDir(), `${r.id}.json`))
        removed++
      }
    }

    return removed
  }

  /**
   * Return only experiences that were recorded while a specific version was
   * active.  Used by post-promotion monitoring to attribute outcomes to the
   * version that was mounted at the time.
   */
  async listExperiencesByVersion(versionId: string, limit: number = 50): Promise<ExperienceRecord[]> {
    const all = await this.listExperiences(limit * 10)  // fetch more, filter client-side
    return all.filter((e): e is ExperienceRecord & { versionId: string } => e.versionId === versionId).slice(0, limit)
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
    return full
  }

  async listPatterns(limit: number = 100): Promise<Pattern[]> {
    const files = await listDir(this.patternDir(), limit)
    const patterns: Pattern[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const data = await readJsonSafe(join(this.patternDir(), f))
      if (data && typeof data === 'object') patterns.push(data as Pattern)
    }
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
    return full
  }

  async getCandidate(id: string): Promise<CandidateModule | null> {
    return (await readJsonSafe(join(this.candidateDir(), `${id}.json`))) as CandidateModule | null
  }

  async updateCandidate(id: string, updates: Partial<CandidateModule>): Promise<CandidateModule | null> {
    const existing = await this.getCandidate(id)
    if (!existing) return null
    const updated = { ...existing, ...updates, id, updatedAt: isoDateTime(this.nowFn()) }
    await writeJsonAtomic(join(this.candidateDir(), `${id}.json`), updated)
    return updated
  }

  async listCandidates(limit: number = 50): Promise<CandidateModule[]> {
    const files = await listDir(this.candidateDir(), limit)
    const candidates: CandidateModule[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const data = await readJsonSafe(join(this.candidateDir(), f))
      if (data && typeof data === 'object') candidates.push(data as CandidateModule)
    }
    return candidates
  }

  // ── Benchmarks ──

  private benchmarkDir(): string { return join(this.root, 'benchmarks') }

  async addBenchmark(run: Omit<BenchmarkRun, 'id' | 'createdAt'>): Promise<BenchmarkRun> {
    const full: BenchmarkRun = {
      ...run,
      id: newId(),
      createdAt: isoDateTime(this.nowFn()),
    }
    await writeJsonAtomic(join(this.benchmarkDir(), `${full.id}.json`), full)
    return full
  }

  async listBenchmarks(limit: number = 50): Promise<BenchmarkRun[]> {
    const files = await listDir(this.benchmarkDir(), limit)
    const runs: BenchmarkRun[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const data = await readJsonSafe(join(this.benchmarkDir(), f))
      if (data && typeof data === 'object') runs.push(data as BenchmarkRun)
    }
    return runs
  }

  // ── Versions ──

  private versionDir(): string { return join(this.root, 'versions') }

  async getVersion(id: string): Promise<Version | null> {
    return (await readJsonSafe(join(this.versionDir(), `${id}.json`))) as Version | null
  }

  /**
   * The single canonical persisted active-version pointer file.
   * Stores `{ versionId: "v2" }` — the authoritative answer to "which version
   * is active?". When the file is missing (fresh state root, or legacy data),
   * this falls back to scanning version records for status='active'.
   */
  private activePointerPath(): string { return join(this.root, ACTIVE_VERSION_POINTER) }

  async getActiveVersion(): Promise<Version | null> {
    // ── Canonical path: read the explicit pointer ──
    const pointer = (await readJsonSafe(this.activePointerPath())) as { versionId: string } | null
    if (pointer && typeof pointer.versionId === 'string' && pointer.versionId !== '') {
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
      await writeJsonAtomic(this.activePointerPath(), { versionId: activeVersions[0]!.id })
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
    // Capture the previous active version BEFORE any writes.  We read it from
    // the list rather than from getActiveVersion() to avoid the new canonical
    // pointer being seen mid-flight.
    // Only mark a version rolled-back if one was genuinely active; a historical
    // (rolled-back) record must not be silently re-selected by ordering.
    const oldActive = versions.find(v => v.status === 'active') ?? null
    // Write the new version record FIRST (survives a mid-write crash).
    await writeJsonAtomic(join(this.versionDir(), `${version.id}.json`), version)
    // Commit the canonical active pointer — this is the single authority.
    await writeJsonAtomic(this.activePointerPath(), { versionId: version.id })
    // Mark the previous active version as rolled-back (historical record only).
    if (oldActive && oldActive.id !== version.id) {
      await writeJsonAtomic(join(this.versionDir(), `${oldActive.id}.json`), { ...oldActive, status: 'rolled-back' })
    }
    return version
  }

  async listVersions(limit: number = 50): Promise<Version[]> {
    const files = await listDir(this.versionDir(), limit)
    const versions: Version[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const data = await readJsonSafe(join(this.versionDir(), f))
      if (data && typeof data === 'object') versions.push(data as Version)
    }
    return versions.sort((a, b) => a.number - b.number)
  }

  async rollbackVersion(versionId: string): Promise<{ restored: Version; deactivated: Version | null; alreadyActive: boolean } | null> {
    const target = await this.getVersion(versionId)
    if (!target) return null
    const active = await this.getActiveVersion()
    if (active?.id === target.id) return { restored: target, deactivated: null, alreadyActive: true }
    if (active) {
      // Mark old active as rolled-back (historical record only).
      await writeJsonAtomic(join(this.versionDir(), `${active.id}.json`), { ...active, status: 'rolled-back' })
    }
    // Mark target as active (historical record only — kept for query compatibility).
    await writeJsonAtomic(join(this.versionDir(), `${target.id}.json`), { ...target, status: 'active' })
    // Commit the canonical active pointer — the single authority.
    await writeJsonAtomic(this.activePointerPath(), { versionId: target.id })
    return { restored: target, deactivated: active, alreadyActive: false }
  }

  private async updateVersion(id: string, updates: Partial<Version>): Promise<Version | null> {
    const existing = await this.getVersion(id)
    if (!existing) return null
    const updated = { ...existing, ...updates }
    await writeJsonAtomic(join(this.versionDir(), `${id}.json`), updated)
    return updated
  }
}
