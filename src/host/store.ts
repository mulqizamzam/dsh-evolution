import { join } from 'node:path'
import { ensureDir, ensureStateRoot, resolveStateRoot } from '../lib/home.ts'
import type { ContextGet } from '../lib/home.ts'
import { readJsonSafe, writeJsonAtomic, listDir } from '../lib/fsx.ts'
import { newId, isoDateTime, versionId } from '../lib/ids.ts'
import type {
  ExperienceRecord, Pattern, CandidateModule, BenchmarkRun, Version,
} from './types.ts'

export interface StoreOptions {
  get?: ContextGet
  fallbackRoot?: string
  now?: () => Date
}

/** SCHEMA_VERSION: bumped when file layout changes. */
export const SCHEMA_VERSION = 1

export class EvolutionStore {
  private root: string
  private nowFn: () => Date

  constructor(options: StoreOptions) {
    this.root = resolveStateRoot(options.get, options.fallbackRoot)
    this.nowFn = options.now ?? (() => new Date())
  }

  async init(): Promise<string> {
    await ensureStateRoot(this.root)
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

  async getActiveVersion(): Promise<Version | null> {
    const versions = await this.listVersions()
    return versions.find(v => v.status === 'active') ?? versions[0] ?? null
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
    // Mark existing active version as rolled-back
    const active = await this.getActiveVersion()
    if (active) {
      await writeJsonAtomic(join(this.versionDir(), `${active.id}.json`), { ...active, status: 'rolled-back' })
    }
    await writeJsonAtomic(join(this.versionDir(), `${version.id}.json`), version)
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
      await writeJsonAtomic(join(this.versionDir(), `${active.id}.json`), { ...active, status: 'rolled-back' })
    }
    await writeJsonAtomic(join(this.versionDir(), `${target.id}.json`), { ...target, status: 'active' })
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
