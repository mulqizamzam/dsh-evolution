/**
 * Cumulative Version Composition.
 *
 * A promoted candidate no longer replaces the active version's artifact
 * wholesale: the new version C = (active A's complete artifact file tree)
 * overlaid with candidate B's files/tests.
 *
 * Invariants under test:
 *   - candidate paths win every collision (B replaces matching A artifact)
 *   - a path the candidate does not supply is PRESERVED from A (no implicit
 *     deletion — missing candidate files never delete A files)
 *   - the composed artifact passes the existing containment/validation rules
 *   - C is a new immutable version; A's artifact is byte-identical afterwards
 *   - the canonical active pointer / CAS generation semantics are unchanged
 *   - rollback C → A restores A exactly; A → C → D supports rollback D → C
 *   - restart (fresh store over the same root) recovers C via the pointer
 *   - a failed promotion leaves A active
 *
 * The promotion path runs real materialization + validate + sandbox pre-flight
 * through the existing evo_promote tool (fake host, temp state root), so the
 * tests exercise the production code path, not a test-only shim.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, symlink, access, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import { makeFakeHost } from './helpers/fake-host.ts'
import type { FakeHost } from './helpers/fake-host.ts'
import type { ModuleDeps, CandidateModule, Version } from '../src/host/types.ts'
import { isoDateTime } from '../src/lib/ids.ts'
import { createLiveProvenance } from '../src/lib/provenance.ts'
import {
  materializeArtifact, validateArtifact, readArtifactManifest,
  artifactFilesDir, readBaseArtifactFiles,
} from '../src/host/modules/activation/artifact.ts'
import { resetActivation, readArtifactFile } from '../src/host/modules/activation/loader.ts'

const BOOT = '../src/host/index.ts'

const BENCH_CFG = {
  successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
  errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 },
  avgDurationMs: { max: 60000, weight: 0.5 },
} as const

/** Valid, executable entry: preflight runs `node src/index.ts`. */
const ENTRY_OK_V1 = 'console.log("BASE_RAN")\n'
const ENTRY_OK_V2 = 'console.log("CAND_RAN")\n'

function depsFor(host: FakeHost, store: EvolutionStore, root: string): ModuleDeps {
  return {
    ctx: host.ctx,
    cfg: () => resolveConfig({ stateRoot: root }),
    store,
    log: () => {},
    warn: () => {},
  }
}

async function bootPlugin(host: FakeHost, root: string): Promise<void> {
  const mod = await import(BOOT)
  await mod.apply(host.ctx, { stateRoot: root })
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

/** Seed a benchmarked candidate whose latest live evidence beats `successRate`. */
async function seedCandidate(
  store: EvolutionStore,
  name: string,
  files: Array<{ path: string; content: string }>,
  opts?: {
    tests?: Array<{ path: string; content: string }>
    successRate?: number
    parentVersion?: string
    status?: CandidateModule['status']
    withBenchmark?: boolean
  },
): Promise<CandidateModule> {
  const candidate = await store.addCandidate({
    parentVersion: opts?.parentVersion ?? 'v1',
    type: 'policy',
    name,
    description: 'composition-test candidate',
    reason: 'r',
    evidenceIds: [],
    patternIds: [],
    files,
    tests: opts?.tests ?? [{ path: 'test/ok.spec.ts', content: 'export const t = 1' }],
    benchmarkConfig: { ...BENCH_CFG },
    status: 'draft',
  })
  if (opts?.withBenchmark !== false) {
    const rate = opts?.successRate ?? 0.99
    const createdAt = isoDateTime(new Date())
    const version = candidate.parentVersion
    const command = 'node candidate-under-test.js'
    await store.addBenchmark({
      mode: 'live',
      candidateId: candidate.id,
      version,
      baseline: version,
      parentVersion: version,
      command,
      provenance: createLiveProvenance(candidate.id, version, command, createdAt),
      runs: 3,
      metrics: { successRate: rate, avgScore: rate, errorRate: 0, avgSteps: 3, avgDurationMs: 100 },
      passed: true,
      details: 'live evidence for composition test',
    }, createdAt)
  }
  await store.updateCandidate(candidate.id, { status: opts?.status ?? 'benchmarked' })
  return candidate
}

async function promote(
  deps: ModuleDeps,
  candidateId: string,
  reason = 'composition',
): Promise<{ ok: boolean; error?: string; version?: Version }> {
  const { promoteTools } = await import('../src/host/modules/promote/tools.ts')
  const tool = promoteTools(deps).find(t => t.name === 'evo_promote')!
  return await tool.execute(
    { candidateId, reason } as never,
    { signal: AbortSignal.timeout(120_000) },
  ) as { ok: boolean; error?: string; version?: Version }
}

async function rollback(
  deps: ModuleDeps,
  versionId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { promoteTools } = await import('../src/host/modules/promote/tools.ts')
  const tool = promoteTools(deps).find(t => t.name === 'evo_rollback')!
  return await tool.execute({ versionId } as never, { signal: AbortSignal.timeout(60_000) }) as
    { ok: boolean; error?: string }
}

function versionFor(id: string, candidateId: string): Version {
  return {
    id,
    number: Number(id.replace(/\D/g, '')) || 9,
    label: 't',
    createdAt: new Date().toISOString(),
    status: 'active',
    modules: [candidateId],
  }
}

describe('Cumulative version composition', () => {
  let root: string
  let store: EvolutionStore
  let host: FakeHost
  let deps: ModuleDeps

  beforeEach(async () => {
    resetActivation()
    root = await mkdtemp(join(tmpdir(), 'evo-comp-'))
    store = new EvolutionStore({ fallbackRoot: root })
    await store.init()
    // Create baseline v1 (modules:[]) so the first candidate promote lands on v2.
    // This mirrors the setup in every existing promotion test (crash-consistency,
    // activation, active-pointer etc.) and is required for evaluatePromotionPolicy
    // to find a version record when checking the active baseline.
    await store.createVersion({ label: 'baseline', modules: [] })
    host = makeFakeHost()
    await bootPlugin(host, root)
    deps = depsFor(host, store, root)
  })

  afterEach(async () => {
    resetActivation()
    await rm(root, { recursive: true, force: true })
  })

  // ── 1 + 3. A + B preserves unchanged A artifacts; absent B file keeps A ──

  it('A + B: files of A that B does not supply are preserved byte-for-byte', async () => {
    // Promote B1 over baseline v1 → v2 with three files.
    const b1 = await seedCandidate(store, 'comp-b1', [
      { path: 'src/index.ts', content: ENTRY_OK_V1 },
      { path: 'src/keep.ts', content: 'export const KEEP = "v2"\n' },
      { path: 'src/only-in-a.ts', content: 'export const ONLY_A = 1\n' },
    ])
    const r1 = await promote(deps, b1.id, 'first')
    expect(r1.ok).toBe(true)
    expect((await store.getActiveVersion())!.id).toBe('v2')

    // B2 replaces src/index.ts and ADDS a new file, but supplies NO keep.ts
    // and NO only-in-a.ts — both must survive into v3.
    const b2 = await seedCandidate(store, 'comp-b2', [
      { path: 'src/index.ts', content: ENTRY_OK_V2 },
      { path: 'src/new.ts', content: 'export const NEW = 1\n' },
    ], { parentVersion: 'v2', successRate: 0.995 })

    const r2 = await promote(deps, b2.id, 'second')
    expect(r2.ok).toBe(true)

    const filesRoot = artifactFilesDir(root, 'v3')
    // Requirement: preserved (B did not supply them).
    expect(await readArtifactFile(root, 'v3', 'src/keep.ts')).toBe('export const KEEP = "v2"\n')
    expect(await readArtifactFile(root, 'v3', 'src/only-in-a.ts')).toBe('export const ONLY_A = 1\n')
    // Requirement: replaced (B supplied it).
    expect(await readArtifactFile(root, 'v3', 'src/index.ts')).toBe(ENTRY_OK_V2)
    // Requirement: added (B's new file).
    expect(await readArtifactFile(root, 'v3', 'src/new.ts')).toBe('export const NEW = 1\n')
    // Requirement: B's test file also present.
    expect(await readArtifactFile(root, 'v3', 'test/ok.spec.ts')).toBe('export const t = 1')
    // No implicit deletion: the manifest lists every preserved path.
    const manifest = (await readArtifactManifest(root, 'v3'))!
    expect(manifest.files).toContain('src/keep.ts')
    expect(manifest.files).toContain('src/only-in-a.ts')
    expect(manifest.files).toContain('src/index.ts')
    expect(manifest.files).toContain('src/new.ts')
    // The files root contains what the manifest claims.
    expect(await exists(join(filesRoot, 'src', 'keep.ts'))).toBe(true)
  })

  // ── 2. B replaces an existing A artifact ──

  it('B replaces a matching A artifact (content is B, path count does not grow)', async () => {
    const b1 = await seedCandidate(store, 'rep-b1', [
      { path: 'src/index.ts', content: ENTRY_OK_V1 },
      { path: 'src/shared.ts', content: 'export const SHARED = "A"\n' },
    ])
    expect((await promote(deps, b1.id)).ok).toBe(true)

    const b2 = await seedCandidate(store, 'rep-b2', [
      { path: 'src/index.ts', content: ENTRY_OK_V2 },
      { path: 'src/shared.ts', content: 'export const SHARED = "B"\n' },
    ], { parentVersion: 'v2', successRate: 0.995 })
    expect((await promote(deps, b2.id)).ok).toBe(true)

    expect(await readArtifactFile(root, 'v3', 'src/shared.ts')).toBe('export const SHARED = "B"\n')
    expect(await readArtifactFile(root, 'v3', 'src/index.ts')).toBe(ENTRY_OK_V2)
    const manifest = (await readArtifactManifest(root, 'v3'))!
    // Exactly one entry for the replaced path — replacement, not duplication.
    expect(manifest.files.filter(f => f === 'src/shared.ts')).toHaveLength(1)
  })

  // ── 4. No implicit deletion ──

  it('no implicit deletion: a candidate with a single file does not drop the rest of A', async () => {
    const b1 = await seedCandidate(store, 'nd-b1', [
      { path: 'src/index.ts', content: ENTRY_OK_V1 },
      { path: 'src/a.ts', content: 'a\n' },
      { path: 'src/b.ts', content: 'b\n' },
      { path: 'docs/readme.md', content: '# docs\n' },
      { path: 'test/extra.spec.ts', content: 'export const x = 1\n' },
    ])
    expect((await promote(deps, b1.id)).ok).toBe(true)
    const aManifest = (await readArtifactManifest(root, 'v2'))!
    const aFiles = new Set(aManifest.files)

    const b2 = await seedCandidate(store, 'nd-b2', [
      { path: 'src/index.ts', content: ENTRY_OK_V2 },
    ], { parentVersion: 'v2', successRate: 0.995 })
    expect((await promote(deps, b2.id)).ok).toBe(true)

    const cManifest = (await readArtifactManifest(root, 'v3'))!
    // Every A file is still present in C (superset property).
    for (const f of aFiles) expect(cManifest.files).toContain(f)
    // A's test file (not listed in manifest.files, but on disk) survives too.
    expect(await readArtifactFile(root, 'v3', 'test/extra.spec.ts')).toBe('export const x = 1\n')
  })

  // ── 5. Composed entryPoint behavior ──

  it('entryPoint: candidate.files[0] wins (existing schema derivation); candidate-less candidate keeps base entry', async () => {
    // Base v2 has entry src/index.ts.
    const b1 = await seedCandidate(store, 'ep-b1', [{ path: 'src/index.ts', content: ENTRY_OK_V1 }])
    expect((await promote(deps, b1.id)).ok).toBe(true)
    const baseManifest = (await readArtifactManifest(root, 'v2'))!
    expect(baseManifest.entryPoint).toBe('src/index.ts')

    // B2's first file is src/main.ts → entryPoint replaces (schema-supported).
    const b2 = await seedCandidate(store, 'ep-b2', [
      { path: 'src/main.ts', content: 'console.log("MAIN")\n' },
      { path: 'src/index.ts', content: ENTRY_OK_V2 },
    ], { parentVersion: 'v2', successRate: 0.995 })
    expect((await promote(deps, b2.id)).ok).toBe(true)
    const cManifest = (await readArtifactManifest(root, 'v3'))!
    expect(cManifest.entryPoint).toBe('src/main.ts')
    expect(cManifest.testCommand).toBe('node src/main.ts')

    // Direct materialization with a candidate that has NO files: the base
    // entryPoint is preserved (requirement 5 — replace only when the schema
    // derivation supplies a candidate file).
    const emptyCand = await store.addCandidate({
      parentVersion: 'v3', type: 'policy', name: 'ep-empty', description: 'd', reason: 'r',
      evidenceIds: [], patternIds: [], files: [], tests: [],
      benchmarkConfig: { ...BENCH_CFG }, status: 'draft',
    })
    await materializeArtifact(root, versionFor('v9', emptyCand.id), emptyCand, { baseVersionId: 'v3' })
    const v9Manifest = (await readArtifactManifest(root, 'v9'))!
    expect(v9Manifest.entryPoint).toBe('src/main.ts') // base entry preserved
    expect(v9Manifest.testCommand).toBe('node src/main.ts')
    // And the file set is exactly the base set (nothing added, nothing lost).
    expect(new Set(v9Manifest.files)).toEqual(new Set(cManifest.files))
  })

  // ── 6. Containment validation of the composed set ──

  it('containment: composed artifact passes validateArtifact as a complete set; a malicious candidate path still rejects before write', async () => {
    const b1 = await seedCandidate(store, 'ct-b1', [
      { path: 'src/index.ts', content: ENTRY_OK_V1 },
      { path: 'src/keep.ts', content: 'k\n' },
    ])
    expect((await promote(deps, b1.id)).ok).toBe(true)

    // Evil candidate: traversal path must be rejected BEFORE any write, and
    // the existing v2 artifact must remain byte-identical.
    const keepBefore = await readArtifactFile(root, 'v2', 'src/keep.ts')
    const evil = await store.addCandidate({
      parentVersion: 'v2', type: 'policy', name: 'ct-evil', description: 'd', reason: 'r',
      evidenceIds: [], patternIds: [],
      files: [{ path: '../escape.js', content: 'pwn' }],
      tests: [], benchmarkConfig: { ...BENCH_CFG }, status: 'benchmarked',
    })
    await store.addBenchmark({
      mode: 'live', candidateId: evil.id, version: 'v2', baseline: 'v2', runs: 3,
      metrics: { successRate: 0.999, avgScore: 1, errorRate: 0, avgSteps: 1, avgDurationMs: 50 },
      passed: true, details: 'live', createdAt: new Date().toISOString(),
    })
    const evilResult = await promote(deps, evil.id, 'evil')
    expect(evilResult.ok).toBe(false)
    expect(String(evilResult.error)).toMatch(/escape the artifact files root/)
    // A untouched, still active, no escape file.
    expect(await readArtifactFile(root, 'v2', 'src/keep.ts')).toBe(keepBefore)
    expect(await exists(join(root, 'escape.js'))).toBe(false)
    expect((await store.getActiveVersion())!.id).toBe('v2')
    // No v3 was created.
    expect(await exists(join(root, 'versions', 'v3', 'manifest.json'))).toBe(false)

    // And a directly-composed artifact with valid paths validates cleanly.
    const good = await seedCandidate(store, 'ct-good', [
      { path: 'src/index.ts', content: ENTRY_OK_V2 },
    ], { parentVersion: 'v2', successRate: 0.999 })
    expect((await promote(deps, good.id)).ok).toBe(true)
    const validation = await validateArtifact(root, 'v3')
    expect(validation.errors).toEqual([])
    expect(validation.valid).toBe(true)
    const manifest = (await readArtifactManifest(root, 'v3'))!
    for (const f of manifest.files) {
      expect(await readArtifactFile(root, 'v3', f)).not.toBeNull()
    }
  })

  // ── 7. Immutable new version ──

  it('C is a new immutable version: A artifact bytes unchanged, distinct directory, distinct content hash', async () => {
    const b1 = await seedCandidate(store, 'im-b1', [
      { path: 'src/index.ts', content: ENTRY_OK_V1 },
      { path: 'src/frozen.ts', content: 'export const FROZEN = "v2"\n' },
    ])
    expect((await promote(deps, b1.id)).ok).toBe(true)
    const aManifestBefore = JSON.parse(
      await readFile(join(root, 'versions', 'v2', 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>
    const aFrozenBefore = await readArtifactFile(root, 'v2', 'src/frozen.ts')

    const b2 = await seedCandidate(store, 'im-b2', [
      { path: 'src/index.ts', content: ENTRY_OK_V2 },
      { path: 'src/frozen.ts', content: 'export const FROZEN = "v3"\n' },
    ], { parentVersion: 'v2', successRate: 0.995 })
    expect((await promote(deps, b2.id)).ok).toBe(true)

    // A (v2) is byte-identical after C's promotion.
    const aManifestAfter = JSON.parse(
      await readFile(join(root, 'versions', 'v2', 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(aManifestAfter).toEqual(aManifestBefore)
    expect(await readArtifactFile(root, 'v2', 'src/frozen.ts')).toBe(aFrozenBefore)
    // C is a distinct directory with its own record.
    const cRecord = (await store.getVersion('v3'))!
    expect(cRecord.id).not.toBe('v2')
    // Composed content differs from the base (candidate won the collision).
    const cManifest = (await readArtifactManifest(root, 'v3'))!
    const aManifest = (await readArtifactManifest(root, 'v2'))!
    expect(cManifest.contentHash).not.toBe(aManifest.contentHash)
    expect(cManifest.versionId).toBe('v3')
    // v1 baseline record untouched.
    expect(await store.getVersion('v1')).not.toBeNull()
  })

  // ── 8. Active pointer / CAS ──

  it('active pointer/CAS: pointer generation increments on promotion and the version id stays consistent', async () => {
    const p0 = await store.readPointer()
    const b1 = await seedCandidate(store, 'cas-b1', [{ path: 'src/index.ts', content: ENTRY_OK_V1 }])
    expect((await promote(deps, b1.id)).ok).toBe(true)
    const p1 = await store.readPointer()
    expect(p1!.versionId).toBe('v2')
    expect(p1!.generation).toBe((p0?.generation ?? 0) + 1)

    // A second promotion bumps the generation again.
    const b2 = await seedCandidate(store, 'cas-b2', [
      { path: 'src/index.ts', content: ENTRY_OK_V2 },
    ], { parentVersion: 'v2', successRate: 0.995 })
    expect((await promote(deps, b2.id)).ok).toBe(true)
    const p2 = await store.readPointer()
    expect(p2!.versionId).toBe('v3')
    expect(p2!.generation).toBe(p1!.generation + 1)
    expect(p2!.generation).toBe(3)

    // Rollback also increments generation (not just promote).
    const rb = await rollback(deps, 'v2')
    expect(rb.ok).toBe(true)
    const p3 = await store.readPointer()
    expect(p3!.versionId).toBe('v2')
    expect(p3!.generation).toBe(p2!.generation + 1)

    // The final state is self-consistent: the pointer matches the active version.
    expect((await store.getActiveVersion())!.id).toBe(p3!.versionId)
  })

  // ── 9. Rollback C → A restores A exactly ──

  it('rollback C → A restores A exactly (artifact bytes + active pointer + mounted tool)', async () => {
    const b1 = await seedCandidate(store, 'rb-b1', [
      { path: 'src/index.ts', content: ENTRY_OK_V1 },
      { path: 'src/keep.ts', content: 'export const KEEP = "A"\n' },
    ])
    expect((await promote(deps, b1.id)).ok).toBe(true)
    const aManifest = JSON.parse(
      await readFile(join(root, 'versions', 'v2', 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>
    const aKeep = await readArtifactFile(root, 'v2', 'src/keep.ts')

    const b2 = await seedCandidate(store, 'rb-b2', [
      { path: 'src/index.ts', content: ENTRY_OK_V2 },
      { path: 'src/keep.ts', content: 'export const KEEP = "C"\n' },
    ], { parentVersion: 'v2', successRate: 0.995 })
    expect((await promote(deps, b2.id)).ok).toBe(true)
    expect((await store.getActiveVersion())!.id).toBe('v3')

    const rb = await rollback(deps, 'v2')
    expect(rb.ok).toBe(true)
    expect((await store.getActiveVersion())!.id).toBe('v2')
    // A's artifact restored exactly (it was never touched, but prove bytes).
    const aManifestAfter = JSON.parse(
      await readFile(join(root, 'versions', 'v2', 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(aManifestAfter).toEqual(aManifest)
    expect(await readArtifactFile(root, 'v2', 'src/keep.ts')).toBe(aKeep)
    // Pointer points at A; C record still exists (rolled-back history).
    expect((await store.readPointer())!.versionId).toBe('v2')
    expect((await store.getVersion('v3'))!.status).toBe('rolled-back')
    // The mounted tool follows the rollback.
    const { activationState } = await import('../src/host/modules/activation/loader.ts')
    expect(activationState().activeVersionId).toBe('v2')
  })

  // ── 10. A → C → D then rollback D → C ──

  it('A → C → D supports rollback D → C with C restored exactly', async () => {
    // A = v2
    const a = await seedCandidate(store, 'chain-a', [
      { path: 'src/index.ts', content: ENTRY_OK_V1 },
      { path: 'src/shared.ts', content: 'export const S = "A"\n' },
      { path: 'src/a-only.ts', content: 'a\n' },
    ])
    expect((await promote(deps, a.id)).ok).toBe(true)

    // C = v3 (replaces shared, adds c-only)
    const c = await seedCandidate(store, 'chain-c', [
      { path: 'src/index.ts', content: ENTRY_OK_V2 },
      { path: 'src/shared.ts', content: 'export const S = "C"\n' },
      { path: 'src/c-only.ts', content: 'c\n' },
    ], { parentVersion: 'v2', successRate: 0.995 })
    expect((await promote(deps, c.id)).ok).toBe(true)
    const cManifest = JSON.parse(
      await readFile(join(root, 'versions', 'v3', 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>
    const cShared = await readArtifactFile(root, 'v3', 'src/shared.ts')

    // D = v4 (replaces shared again, adds d-only)
    const d = await seedCandidate(store, 'chain-d', [
      { path: 'src/index.ts', content: 'console.log("D")\n' },
      { path: 'src/shared.ts', content: 'export const S = "D"\n' },
      { path: 'src/d-only.ts', content: 'd\n' },
    ], { parentVersion: 'v3', successRate: 0.999 })
    expect((await promote(deps, d.id)).ok).toBe(true)
    expect((await store.getActiveVersion())!.id).toBe('v4')

    // D must have accumulated A's + C's preserved files too.
    expect(await readArtifactFile(root, 'v4', 'src/a-only.ts')).toBe('a\n')
    expect(await readArtifactFile(root, 'v4', 'src/c-only.ts')).toBe('c\n')

    const rb = await rollback(deps, 'v3')
    expect(rb.ok).toBe(true)
    expect((await store.getActiveVersion())!.id).toBe('v3')
    const cManifestAfter = JSON.parse(
      await readFile(join(root, 'versions', 'v3', 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(cManifestAfter).toEqual(cManifest)
    expect(await readArtifactFile(root, 'v3', 'src/shared.ts')).toBe(cShared)
    expect(await readArtifactFile(root, 'v3', 'src/a-only.ts')).toBe('a\n')
    expect((await store.readPointer())!.versionId).toBe('v3')
    const { activationState } = await import('../src/host/modules/activation/loader.ts')
    expect(activationState().activeVersionId).toBe('v3')
  })

  // ── 11. Restart recovery through the canonical pointer ──

  it('restart after activating C recovers C through the canonical active pointer', async () => {
    const b1 = await seedCandidate(store, 'rs-b1', [
      { path: 'src/index.ts', content: ENTRY_OK_V1 },
      { path: 'src/keep.ts', content: 'export const KEEP = 1\n' },
    ])
    expect((await promote(deps, b1.id)).ok).toBe(true)
    const b2 = await seedCandidate(store, 'rs-b2', [
      { path: 'src/index.ts', content: ENTRY_OK_V2 },
    ], { parentVersion: 'v2', successRate: 0.995 })
    expect((await promote(deps, b2.id)).ok).toBe(true)
    expect((await store.readPointer())!.versionId).toBe('v3')

    // Simulate restart: reset in-memory activation, fresh store + fresh host
    // over the SAME state root, then boot the plugin.
    resetActivation()
    const store2 = new EvolutionStore({ fallbackRoot: root })
    await store2.init()
    const host2 = makeFakeHost()
    await bootPlugin(host2, root)
    const deps2 = depsFor(host2, store2, root)

    // Canonical pointer recovers C.
    expect((await store2.getActiveVersion())!.id).toBe('v3')
    const { activationState } = await import('../src/host/modules/activation/loader.ts')
    expect(activationState().activeVersionId).toBe('v3')
    // C's composed artifact is complete after restart.
    const validation = await validateArtifact(root, 'v3')
    expect(validation.valid).toBe(true)
    expect(await readArtifactFile(root, 'v3', 'src/keep.ts')).toBe('export const KEEP = 1\n')
    // And the runtime service executes C's composed file set.
    const service = host2.ctx.get('evolutionRuntime') as {
      runCandidate(r: { versionId: string }): Promise<Record<string, unknown>>
    } | undefined
    expect(service).toBeDefined()
    const run = await service!.runCandidate({ versionId: 'v3' })
    expect(run.ok).toBe(true)
    expect(String(run.stdout)).toContain('CAND_RAN')
  })

  // ── 12. Failed promotion leaves A active ──

  it('failed promotion leaves A active: broken pre-flight rejects without mutating pointer, versions, or A artifact', async () => {
    const b1 = await seedCandidate(store, 'fp-b1', [
      { path: 'src/index.ts', content: ENTRY_OK_V1 },
      { path: 'src/keep.ts', content: 'export const KEEP = 1\n' },
    ])
    expect((await promote(deps, b1.id)).ok).toBe(true)
    const pointerBefore = await store.readPointer()
    const versionsBefore = (await store.listVersions()).map(v => v.id).sort()
    const aManifestBefore = await readFile(join(root, 'versions', 'v2', 'manifest.json'), 'utf8')

    // Candidate with invalid JS entry: validate passes (file exists), but the
    // sandbox pre-flight (`node src/index.ts`) refuses it → no Version created.
    const broken = await seedCandidate(store, 'fp-broken', [
      { path: 'src/index.ts', content: 'NOT VALID JS (((\n' },
      { path: 'src/keep.ts', content: 'export const KEEP = "tampered"\n' },
    ], { parentVersion: 'v2', successRate: 0.995 })
    const result = await promote(deps, broken.id, 'broken')
    expect(result.ok).toBe(false)

    // Store state unchanged: pointer, active version, version records.
    expect((await store.readPointer())!.versionId).toBe(pointerBefore!.versionId)
    expect((await store.getActiveVersion())!.id).toBe('v2')
    expect((await store.listVersions()).map(v => v.id).sort()).toEqual(versionsBefore)
    // A artifact byte-identical.
    expect(await readFile(join(root, 'versions', 'v2', 'manifest.json'), 'utf8')).toBe(aManifestBefore)
    expect(await readArtifactFile(root, 'v2', 'src/keep.ts')).toBe('export const KEEP = 1\n')
    // Failed candidate not marked promoted.
    expect((await store.getCandidate(broken.id))!.status).toBe('benchmarked')
  })

  // ── readBaseArtifactFiles hardening ──

  it('readBaseArtifactFiles skips a base entry replaced by an escaping symlink (never follows outside)', async () => {
    const b1 = await seedCandidate(store, 'sy-b1', [
      { path: 'src/index.ts', content: ENTRY_OK_V1 },
      { path: 'src/link-me.ts', content: 'export const L = 1\n' },
    ])
    expect((await promote(deps, b1.id)).ok).toBe(true)

    // Tamper v2 AFTER materialization: replace src/link-me.ts with a symlink
    // pointing outside the artifact files root.
    const outside = join(root, 'outside-secret.txt')
    await writeFile(outside, 'OUTSIDE_SECRET', 'utf8')
    const linkPath = join(root, 'versions', 'v2', 'files', 'src', 'link-me.ts')
    await rm(linkPath, { force: true })
    await symlink(outside, linkPath)

    const base = await readBaseArtifactFiles(root, 'v2')
    expect(base.files.find(f => f.path === 'src/link-me.ts')).toBeUndefined()
    expect(base.skipped).toContain(join('src', 'link-me.ts'))
    // The outside content never entered the read set.
    expect(base.files.some(f => f.content.includes('OUTSIDE_SECRET'))).toBe(false)
    // The intact entry is still read.
    expect(base.files.find(f => f.path === 'src/index.ts')?.content).toBe(ENTRY_OK_V1)

    // Composing onto that tampered base still yields a valid, contained C.
    const b2 = await seedCandidate(store, 'sy-b2', [
      { path: 'src/index.ts', content: ENTRY_OK_V2 },
    ], { parentVersion: 'v2', successRate: 0.995 })
    expect((await promote(deps, b2.id)).ok).toBe(true)
    const validation = await validateArtifact(root, 'v3')
    expect(validation.valid).toBe(true)
    expect(await readArtifactFile(root, 'v3', 'src/link-me.ts')).toBeNull()
    expect(await exists(join(root, 'versions', 'v3', 'files', 'src', 'link-me.ts'))).toBe(false)
  })

  // ── manifest.files ∩ on-disk intersection ──

  it('manifest/files intersection: every entry in manifest.files exists on disk and no on-disk file outside manifest.files is fabricated', async () => {
    const b1 = await seedCandidate(store, 'if-b1', [
      { path: 'src/index.ts', content: ENTRY_OK_V1 },
      { path: 'src/a.ts', content: 'export const A = 1\n' },
      { path: 'src/b.ts', content: 'export const B = 1\n' },
    ])
    expect((await promote(deps, b1.id)).ok).toBe(true)

    const b2 = await seedCandidate(store, 'if-b2', [
      { path: 'src/index.ts', content: ENTRY_OK_V2 },
      { path: 'src/c.ts', content: 'export const C = 1\n' },
    ], { parentVersion: 'v2', successRate: 0.995 })
    expect((await promote(deps, b2.id)).ok).toBe(true)

    const versionId = 'v3'

    // Build both inventories — manifest (authoritative listing) and files/ on disk.
    const manifest = (await readArtifactManifest(root, versionId))!
    const filesRoot = join(root, 'versions', versionId, 'files')

    async function walkFiles(dir: string): Promise<string[]> {
      const collected: string[] = []
      async function recur(current: string): Promise<void> {
        let names: string[]
        try { names = await readdir(current) } catch { return }
        for (const name of names) {
          const full = join(current, name)
          const s = await stat(full)
          if (s.isDirectory()) await recur(full)
          else if (s.isFile() || s.isSymbolicLink()) {
            // Record with POSIX-style separator (how manifests list paths).
            collected.push(full.slice(filesRoot.length + 1).split(sep).join('/'))
          }
        }
      }
      await recur(dir)
      return collected.sort()
    }

    const onDiskFiles = await walkFiles(filesRoot)
    const manifestSet = [...manifest.files].sort()

    // 1. Every manifest.files entry must exist on disk (no dangling listing).
    for (const listed of manifestSet) {
      expect(onDiskFiles).toContain(listed)
    }

    // 2. Every on-disk SOURCE file (non-test) is listed in manifest.files.
    //    Tests are intentionally excluded from manifest.files: they are on disk
    //    but never appear in the manifest listing, so they are the explicit
    //    allowed exception documented in artifact.ts.
    for (const onDisk of onDiskFiles) {
      if (onDisk.startsWith('test/')) continue
      expect(manifestSet).toContain(onDisk)
    }

    // 3. Fresh validation confirms the artifact's containment before promotion.
    const validation = await validateArtifact(root, versionId)
    expect(validation.valid).toBe(true)
    expect(validation.errors).toHaveLength(0)
    // The manifest entryPoint is readable through the real reader.
    expect(await readArtifactFile(root, versionId, manifest.entryPoint)).not.toBeNull()
  })
})
