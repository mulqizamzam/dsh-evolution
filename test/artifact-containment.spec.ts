/**
 * Mission 3 — Artifact Path Containment Hardening.
 *
 * Every test here asserts BOTH:
 *   1. the API-level rejection (throw / validation failure), and
 *   2. the actual filesystem result (no outside file was created, an existing
 *      valid artifact is byte-identical, validation reads nothing outside).
 *
 * Candidate records are created directly through the store (bypassing the
 * builder) so the tests prove the FINAL trust boundary, not builder-only
 * validation. Tampering tests mutate persisted state after materialization,
 * which is exactly the persisted-tampering threat the mission requires.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, access, mkdir, writeFile, symlink, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import {
  materializeArtifact, validateArtifact, readArtifactManifest, artifactFilesDir,
} from '../src/host/modules/activation/artifact.ts'
import {
  artifactEntryPath, readArtifactFile,
} from '../src/host/modules/activation/loader.ts'
import { containPath, isContainedPath } from '../src/lib/contain.ts'
import { validateCandidateFileSet } from '../src/host/modules/builder/tools.ts'
import { benchmarkTools } from '../src/host/modules/benchmark/tools.ts'
import type { ModuleDeps, CandidateFileSet, CandidateModule, Version } from '../src/host/types.ts'
import { seedLiveBenchmark } from './helpers/seed-live-benchmark.ts'

// ── helpers ──

const BENCH_CFG = {
  successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
  errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 },
  avgDurationMs: { max: 60000, weight: 0.5 },
} as const

function uniq(tag: string): string {
  return `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

/** Create a candidate through the STORE (builder bypass = tamper simulation). */
async function addCandidate(
  store: EvolutionStore,
  files: Array<{ path: string; content: string }>,
  tests: Array<{ path: string; content: string }> = [{ path: 'test/ok.spec.ts', content: 'export const t = 1' }],
): Promise<CandidateModule> {
  return store.addCandidate({
    parentVersion: 'v1', type: 'policy', name: 'containment-candidate',
    description: 'd', reason: 'r', evidenceIds: [], patternIds: [],
    files, tests, benchmarkConfig: { ...BENCH_CFG }, status: 'draft',
  })
}

function versionFor(id: string, candidateId: string): Version {
  return {
    id, number: Number(id.replace(/\D/g, '')) || 9, label: 't',
    createdAt: new Date().toISOString(), status: 'active', modules: [candidateId],
  }
}

function depsFor(store: EvolutionStore, root: string): ModuleDeps {
  return {
    ctx: {} as never,
    cfg: () => resolveConfig({ stateRoot: root }),
    store,
    log: () => {},
    warn: () => {},
  }
}

async function recursiveList(dir: string): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = []
  async function walk(current: string): Promise<void> {
    let entries: string[]
    try { entries = await readdir(current) } catch { return }
    for (const name of entries.sort()) {
      const full = join(current, name)
      const s = await stat(full)
      if (s.isDirectory()) await walk(full)
      else if (s.isFile()) out.push({ path: full.slice(dir.length), content: await readFile(full, 'utf8') })
    }
  }
  await walk(dir)
  return out
}

// ── 1. shared containment helper (unit, no filesystem) ──

describe('containPath — shared containment rule', () => {
  const root = '/tmp/root/files'

  it.each([
    ['T1 simple traversal', '../escape.js'],
    ['T2 deep traversal', '../../../../escape.js'],
    ['T3 absolute path', '/etc/passwd'],
    ['T4 normalized traversal', 'subdir/../../escape.js'],
    ['T5 nested traversal', 'a/b/../../../escape.js'],
    ['T6 prefix collision', '/tmp/root/files2/x.js'],
    ['T6 prefix collision via traversal', '../files2/x.js'],
    ['T6 prefix collision via absolute traversal', '/tmp/root/../files2/x.js'],
    ['empty path', ''],
    ['NUL byte', 'a\0b.js'],
    ['root itself', '.'],
    ['non-string', 42],
  ])('rejects %s', (_label, input) => {
    expect(containPath(root, input)).toBeNull()
  })

  it.each([
    ['T13 plain file', 'tool.js'],
    ['T14 nested file', 'subdir/tool.js'],
    ['T15 deep nested file', 'deep/nested/tool.js'],
    ['leading ./ is fine', './sub/tool.js'],
    ['dots inside name are fine', 'a..b.js'],
    ['name that starts like the root', 'files2/x.js'],
  ])('accepts %s', (_label, input) => {
    expect(isContainedPath(root, input)).toBe(true)
  })
})

// ── 2. negative matrix: materializeArtifact (T1-T6, T11, T21) ──

describe('materializeArtifact — negative path matrix (API rejection + fs result)', () => {
  let root: string
  let store: EvolutionStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'evo-contain-'))
    store = new EvolutionStore({ fallbackRoot: root })
    await store.init()
  })

  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  const cases: Array<[string, string, (filesRoot: string, evil: string) => string]> = [
    ['T1 ../escape.js', '../escape.js', (fr, e) => resolve(dirname(fr), e)],
    ['T2 ../../../../escape.js', '../../../../escape.js', (fr, e) => resolve(dirname(fr), e)],
    ['T4 subdir/../../escape.js', 'subdir/../../escape.js', (fr, e) => resolve(dirname(fr), e)],
    ['T5 a/b/../../../escape.js', 'a/b/../../../escape.js', (fr, e) => resolve(dirname(fr), e)],
    ['T6 prefix collision files->files2', '../files2/x.js', (fr) => resolve(fr, '../files2/x.js')],
  ]

  for (const [label, evil, expectedPath] of cases) {
    it(`${label} → rejected before write, no outside file`, async () => {
      const cand = await addCandidate(store, [{ path: evil, content: 'pwn' }])
      await expect(materializeArtifact(root, versionFor('v9', cand.id), cand))
        .rejects.toThrow(/escape the artifact files root/)
      // Filesystem result: nothing outside the files root exists.
      const filesRoot = join(root, 'versions', 'v9', 'files')
      expect(await exists(expectedPath(filesRoot, evil))).toBe(false)
      // …and no artifact directory was committed at all.
      expect(await exists(join(root, 'versions', 'v9', 'manifest.json'))).toBe(false)
    })
  }

  it('T3 absolute path → rejected before write, target not created', async () => {
    const absoluteTarget = join(tmpdir(), uniq('evo-abs-escape') + '.js')
    const cand = await addCandidate(store, [{ path: absoluteTarget, content: 'pwn' }])
    await expect(materializeArtifact(root, versionFor('v9', cand.id), cand))
      .rejects.toThrow(/escape the artifact files root/)
    expect(await exists(absoluteTarget)).toBe(false)
  })

  it('T3b absolute path inside /etc-like root → rejected', async () => {
    const cand = await addCandidate(store, [{ path: '/etc/passwd', content: 'pwn' }])
    await expect(materializeArtifact(root, versionFor('v9', cand.id), cand))
      .rejects.toThrow(/escape the artifact files root/)
  })

  it('tests array paths are validated too (evil test file)', async () => {
    const cand = await addCandidate(
      store,
      [{ path: 'src/index.ts', content: 'ok' }],
      [{ path: '../../evil.spec.ts', content: 'pwn' }],
    )
    await expect(materializeArtifact(root, versionFor('v9', cand.id), cand))
      .rejects.toThrow(/escape the artifact files root/)
    expect(await exists(join(root, 'versions', 'evil.spec.ts'))).toBe(false)
  })

  it('T11/T21 tampered persisted candidate files → rejected before materialization', async () => {
    const cand = await addCandidate(store, [{ path: 'src/index.ts', content: 'export default 1' }])
    // Tamper the PERSISTED record after the builder would have validated it.
    await store.updateCandidate(cand.id, { files: [{ path: '../evil.js', content: 'pwn' }] })
    const tampered = await store.getCandidate(cand.id)
    expect(tampered).not.toBeNull()

    await expect(materializeArtifact(root, versionFor('v9', tampered!), tampered!))
      .rejects.toThrow(/escape the artifact files root/)
    expect(await exists(join(root, 'versions', 'evil.js'))).toBe(false)
    expect(await exists(join(root, 'versions', 'v9', 'manifest.json'))).toBe(false)
  })
})

// ── 3. positive matrix: materializeArtifact (T13-T17) ──

describe('materializeArtifact — valid nested paths still work', () => {
  let root: string
  let store: EvolutionStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'evo-contain-pos-'))
    store = new EvolutionStore({ fallbackRoot: root })
    await store.init()
  })

  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('T13 tool.js is accepted and written inside the files root', async () => {
    const cand = await addCandidate(store, [{ path: 'tool.js', content: 'console.log(1)' }])
    const manifest = await materializeArtifact(root, versionFor('v9', cand.id), cand)
    expect(manifest.entryPoint).toBe('tool.js')
    expect(await exists(join(root, 'versions', 'v9', 'files', 'tool.js'))).toBe(true)
  })

  it('T14 subdir/tool.js is accepted', async () => {
    const cand = await addCandidate(store, [{ path: 'subdir/tool.js', content: 'x' }])
    await materializeArtifact(root, versionFor('v9', cand.id), cand)
    expect(await exists(join(root, 'versions', 'v9', 'files', 'subdir', 'tool.js'))).toBe(true)
  })

  it('T15 deep/nested/tool.js is accepted', async () => {
    const cand = await addCandidate(store, [{ path: 'deep/nested/tool.js', content: 'x' }])
    await materializeArtifact(root, versionFor('v9', cand.id), cand)
    expect(await exists(join(root, 'versions', 'v9', 'files', 'deep', 'nested', 'tool.js'))).toBe(true)
  })

  it('T17 multiple valid nested files all remain inside the artifact root', async () => {
    const cand = await addCandidate(store, [
      { path: 'src/index.ts', content: 'a' },
      { path: 'src/lib/util.ts', content: 'b' },
      { path: 'docs/readme.md', content: 'c' },
    ], [{ path: 'test/deep/nested/spec.ts', content: 'd' }])
    const manifest = await materializeArtifact(root, versionFor('v9', cand.id), cand)
    expect(manifest.files).toHaveLength(3)

    const filesRoot = join(root, 'versions', 'v9', 'files')
    // Every real file on disk is inside the files root (boundary proof).
    const listed = await recursiveList(join(root, 'versions', 'v9'))
    expect(listed.length).toBeGreaterThanOrEqual(4) // 3 candidate files + test + manifest + plugin.js
    for (const entry of listed) {
      if (!entry.path.startsWith('/files/')) continue // manifest.json / plugin.js live above files/
      const abs = join(root, 'versions', 'v9', entry.path)
      expect(containPath(filesRoot, abs)).not.toBeNull()
    }
    expect(await exists(join(filesRoot, 'src', 'lib', 'util.ts'))).toBe(true)
    expect(await exists(join(filesRoot, 'test', 'deep', 'nested', 'spec.ts'))).toBe(true)
  })

  it('T16 valid artifact + valid entryPoint → validation succeeds', async () => {
    const cand = await addCandidate(store, [{ path: 'src/index.ts', content: 'export default 1' }])
    await materializeArtifact(root, versionFor('v9', cand.id), cand)
    const result = await validateArtifact(root, 'v9')
    expect(result.errors).toEqual([])
    expect(result.valid).toBe(true)
  })
})

// ── 4. validateArtifact — tampered manifests (T7-T10, T12, T22) ──

describe('validateArtifact — entryPoint / manifest path containment at the final boundary', () => {
  let root: string
  let store: EvolutionStore
  let versionId: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'evo-contain-val-'))
    store = new EvolutionStore({ fallbackRoot: root })
    await store.init()
    const cand = await addCandidate(store, [{ path: 'src/index.ts', content: 'export default 1' }])
    versionId = 'v9'
    await materializeArtifact(root, versionFor(versionId, cand.id), cand)
    const pre = await validateArtifact(root, versionId)
    expect(pre.valid).toBe(true)
  })

  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  async function tamperManifest(patch: Record<string, unknown>): Promise<void> {
    const manifestPath = join(root, 'versions', versionId, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    Object.assign(manifest, patch)
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  }

  it.each([
    ['T7', '../outside.js'],
    ['T8', '../../outside.js'],
    ['T9', '/etc/passwd'],
    ['T4n', 'sub/../../outside.js'],
  ])('%s tampered entryPoint=%s → validation fails, no outside read', async (_label, evil) => {
    // Create the would-be outside target so rejection cannot be explained away
    // as a mere "file not found": containment must reject it regardless.
    await writeFile(join(root, 'versions', versionId, 'outside.js'), 'SENTINEL', 'utf8').catch(() => {})
    await tamperManifest({ entryPoint: evil })

    const result = await validateArtifact(root, versionId)
    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toMatch(/escapes the artifact files root/)
  })

  it('T10/T22 persisted manifest tampering rejected at final boundary (not builder)', async () => {
    await tamperManifest({ entryPoint: '../outside.js' })
    const reread = await readArtifactManifest(root, versionId)
    expect(reread!.entryPoint).toBe('../outside.js') // tamper persisted as-is
    const result = await validateArtifact(root, versionId)
    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toMatch(/escapes the artifact files root/)
  })

  it('tampered manifest.files entries are rejected', async () => {
    await tamperManifest({ files: ['../evil.js'] })
    const result = await validateArtifact(root, versionId)
    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toMatch(/manifest\.files entry escapes/)
  })

  it('T12 symlink replacing the entry file → rejected (real target outside root)', async () => {
    const outside = join(root, 'outside-sentinel.js')
    await writeFile(outside, 'OUTSIDE CONTENT', 'utf8')
    const entryPath = join(root, 'versions', versionId, 'files', 'src', 'index.ts')
    await rm(entryPath)
    await symlink(outside, entryPath)

    const result = await validateArtifact(root, versionId)
    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toMatch(/symlink/)
  })

  it('T20 validation failure does not delete or alter the artifact', async () => {
    await tamperManifest({ entryPoint: '../outside.js' })
    const before = await recursiveList(join(root, 'versions', versionId))
    const result = await validateArtifact(root, versionId)
    expect(result.valid).toBe(false)
    const after = await recursiveList(join(root, 'versions', versionId))
    expect(after).toEqual(before)
  })

  it('unsafe versionId → validation fails without touching the filesystem', async () => {
    const result = await validateArtifact(root, '../../etc')
    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toMatch(/invalid version id/)
    expect(await readArtifactManifest(root, '../../etc')).toBeNull()
  })

  it('missing entryPoint file still reports "missing" (compatible behavior)', async () => {
    await tamperManifest({ entryPoint: 'src/does-not-exist.ts' })
    const result = await validateArtifact(root, versionId)
    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toMatch(/declared entry point is missing/)
  })
})

// ── 5. non-destructive rejection (T18-T20) ──

describe('non-destructive rejection', () => {
  let root: string
  let store: EvolutionStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'evo-contain-nd-'))
    store = new EvolutionStore({ fallbackRoot: root })
    await store.init()
  })

  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('T18 invalid candidate cannot damage an existing valid artifact', async () => {
    const good = await addCandidate(store, [{ path: 'src/index.ts', content: 'GOOD CONTENT' }])
    await materializeArtifact(root, versionFor('v9', good.id), good)
    const versionDirAbs = join(root, 'versions', 'v9')
    const before = await recursiveList(versionDirAbs)
    expect(before.length).toBeGreaterThan(0)

    const evil = await addCandidate(store, [{ path: '../evil.js', content: 'pwn' }])
    await expect(materializeArtifact(root, versionFor('v9', evil.id), evil))
      .rejects.toThrow(/escape the artifact files root/)

    const after = await recursiveList(versionDirAbs)
    expect(after).toEqual(before) // byte-identical
  })

  it('T19 invalid path with a pre-existing staging dir → no outside file, staging and artifact untouched', async () => {
    const good = await addCandidate(store, [{ path: 'src/index.ts', content: 'GOOD CONTENT' }])
    await materializeArtifact(root, versionFor('v9', good.id), good)
    const versionDirAbs = join(root, 'versions', 'v9')
    const before = await recursiveList(versionDirAbs)

    // Simulate a partially prepared staging directory from an interrupted run.
    const staging = versionDirAbs + '.staging'
    await mkdir(join(staging, 'files', 'partial'), { recursive: true })
    await writeFile(join(staging, 'files', 'partial', 'wip.ts'), 'WIP', 'utf8')

    const evil = await addCandidate(store, [{ path: '../escape.js', content: 'pwn' }])
    await expect(materializeArtifact(root, versionFor('v9', evil.id), evil))
      .rejects.toThrow(/escape the artifact files root/)

    expect(await exists(join(root, 'versions', 'escape.js'))).toBe(false) // no outside file
    expect(await readFile(join(staging, 'files', 'partial', 'wip.ts'), 'utf8')).toBe('WIP')
    expect(await recursiveList(versionDirAbs)).toEqual(before)
  })
})

// ── 6. loader path consumers ──

describe('loader path consumers are containment-checked', () => {
  let root: string
  let store: EvolutionStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'evo-contain-loader-'))
    store = new EvolutionStore({ fallbackRoot: root })
    await store.init()
    const cand = await addCandidate(store, [{ path: 'src/index.ts', content: 'export default 1' }])
    await materializeArtifact(root, versionFor('v9', cand.id), cand)
  })

  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('artifactEntryPath rejects a traversing entryPoint', () => {
    expect(() => artifactEntryPath(root, 'v9', '../manifest.json')).toThrow(/escapes the artifact files root/)
  })

  it('artifactEntryPath rejects an unsafe versionId', () => {
    expect(() => artifactEntryPath(root, '../../etc', 'x.js')).toThrow(/invalid version id/)
  })

  it('readArtifactFile refuses to read outside the files root', async () => {
    // '../manifest.json' would resolve to the version dir manifest — a read
    // outside the files root must return null, not file content.
    expect(await readArtifactFile(root, 'v9', '../manifest.json')).toBeNull()
    expect(await readArtifactFile(root, 'v9', '../../active-version.json')).toBeNull()
    // Valid nested read still works.
    expect(await readArtifactFile(root, 'v9', 'src/index.ts')).toBe('export default 1')
  })
})

// ── 7. store id guards (tampered ids / tool args become path components) ──

describe('store id lookups refuse unsafe keys', () => {
  let root: string
  let store: EvolutionStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'evo-contain-store-'))
    store = new EvolutionStore({ fallbackRoot: root })
    await store.init()
  })

  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('getCandidate with a traversal id returns null and reads nothing outside', async () => {
    await writeFile(join(root, 'outside-candidate.json'), '{"id":"x"}', 'utf8')
    expect(await store.getCandidate('../outside-candidate')).toBeNull()
    expect(await store.getCandidate('../../etc/passwd')).toBeNull()
    expect(await store.getCandidate('/etc/passwd')).toBeNull()
  })

  it('updateCandidate with a traversal id writes nothing', async () => {
    expect(await store.updateCandidate('../evil', { status: 'promoted' })).toBeNull()
    expect(await exists(join(root, 'evil.json'))).toBe(false)
  })

  it('getVersion with a traversal id returns null', async () => {
    expect(await store.getVersion('../../active-version')).toBeNull()
    expect(await store.getVersion('../evil')).toBeNull()
  })

  it('getExperience with a traversal id returns null', async () => {
    expect(await store.getExperience('../outside-candidate')).toBeNull()
  })

  it('valid hex ids and version ids still work', async () => {
    const cand = await addCandidate(store, [{ path: 'src/index.ts', content: 'x' }])
    expect((await store.getCandidate(cand.id))?.id).toBe(cand.id)
    await store.createVersion({ label: 'baseline', modules: [] })
    expect(await store.getVersion('v1')).not.toBeNull()
    expect(await store.updateCandidate(cand.id, { status: 'benchmarked' })).not.toBeNull()
  })
})

// ── 8. builder preliminary validation shares the same rule ──

describe('validateCandidateFileSet uses the shared containment rule', () => {
  function fileSet(files: Array<{ path: string; content: string }>, entryPoint = files[0]?.path ?? 'src/index.ts'): CandidateFileSet {
    return {
      manifest: {
        name: 'n', version: '1.0.0', type: 'policy', description: 'd', entryPoint,
        benchmarkCases: [{ id: 'c1', description: 'd', input: 'i', timeoutMs: 1000, successCriteria: 'ok' }],
      },
      files,
      tests: [{ path: 'test/ok.spec.ts', content: 't' }],
    }
  }

  it.each([
    ['T1', '../escape.js'],
    ['T2', '../../../../escape.js'],
    ['T3', '/etc/shadow'],
    ['T4', 'subdir/../../escape.js'],
    ['T5', 'a/b/../../../escape.js'],
  ])('%s is rejected by builder validation', (_label, evil) => {
    const result = validateCandidateFileSet(fileSet([{ path: evil, content: 'x' }]))
    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toMatch(/path escapes the candidate root/)
  })

  it.each([
    ['T13', 'tool.js'],
    ['T14', 'subdir/tool.js'],
    ['T15', 'deep/nested/tool.js'],
  ])('%s is accepted by builder validation', (_label, good) => {
    const result = validateCandidateFileSet(fileSet([{ path: good, content: 'x' }]))
    expect(result.errors.join('\n')).not.toMatch(/path escapes the candidate root/)
  })

  it('escaping entryPoint is rejected even when files are valid', () => {
    const result = validateCandidateFileSet(fileSet([{ path: 'src/index.ts', content: 'x' }], '../evil.js'))
    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toMatch(/path escapes the candidate root/)
  })
})

// ── 9. benchmark writer boundary ──

describe('benchmark file writer refuses escaping candidate paths', () => {
  let root: string
  let store: EvolutionStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'evo-contain-bench-'))
    store = new EvolutionStore({ fallbackRoot: root })
    await store.init()
  })

  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('evo_benchmark_live rejects a tampered candidate path before writing outside the temp dir', async () => {
    const escapeName = uniq('evo-bench-escape') + '.js'
    const outsideTarget = join(tmpdir(), escapeName) // = <mkdtemp>/../<name> for any evo-bench-* dir
    const cand = await addCandidate(store, [{ path: 'src/index.ts', content: 'ok' }])
    await store.updateCandidate(cand.id, { files: [{ path: '../' + escapeName, content: 'pwn' }] })

    const deps = depsFor(store, root)
    const tool = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!
    await expect(
      tool.execute({ candidateId: cand.id, command: 'node -e 0' } as never, { signal: AbortSignal.timeout(30_000) }),
    ).rejects.toThrow(/escapes the benchmark directory/)

    expect(await exists(outsideTarget)).toBe(false)
  })
})

// ── 9b. tampered persisted version records (id FIELD becomes a path) ──

describe('tampered version records cannot direct writes outside versions/', () => {
  let root: string
  let store: EvolutionStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'evo-contain-vrec-'))
    store = new EvolutionStore({ fallbackRoot: root })
    await store.init()
    await store.createVersion({ label: 'baseline', modules: [] })
  })

  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('rollbackVersion refuses a record whose id field is a traversal', async () => {
    // Tamper the persisted record's id FIELD (file stays v1.json).
    const recordPath = join(root, 'versions', 'v1.json')
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>
    record.id = '../evil'
    await writeFile(recordPath, JSON.stringify(record, null, 2), 'utf8')

    const result = await store.rollbackVersion('v1')
    expect(result).toBeNull()
    expect(await exists(join(root, 'evil.json'))).toBe(false)
  })

  it('createVersion refuses to mark active a record whose id field is a traversal', async () => {
    const recordPath = join(root, 'versions', 'v1.json')
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>
    record.id = '../evil'
    record.status = 'active'
    await writeFile(recordPath, JSON.stringify(record, null, 2), 'utf8')
    await writeFile(join(root, 'active-version.json'), JSON.stringify({ versionId: '../evil' }), 'utf8')

    await expect(store.createVersion({ label: 'x', modules: [] }))
      .rejects.toThrow(/unsafe id/)
    expect(await exists(join(root, 'evil.json'))).toBe(false)
  })
})

// ── 9d. artifact reader symlink containment (mission 3.1) ──

describe('artifact readers — symlink containment for existing-path reads', () => {
  let root: string
  let store: EvolutionStore
  let versionId: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'evo-contain-reader-'))
    store = new EvolutionStore({ fallbackRoot: root })
    await store.init()
    const cand = await addCandidate(store, [{ path: 'src/index.ts', content: 'export default 1' }])
    versionId = 'v9'
    await materializeArtifact(root, versionFor(versionId, cand.id), cand)
  })

  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  async function tamperManifest(patch: Record<string, unknown>): Promise<void> {
    const manifestPath = join(root, 'versions', versionId, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    Object.assign(manifest, patch)
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  }

  it('readArtifactFile — symlink to outside root → rejects (returns null)', async () => {
    const outside = join(root, 'outside-sentinel-31.txt')
    await writeFile(outside, 'OUTSIDE', 'utf8')
    // Replace the entry file with a symlink to the outside sentinel.
    const entryPath = join(root, 'versions', versionId, 'files', 'src', 'index.ts')
    await rm(entryPath)
    await symlink(outside, entryPath)

    // Lexical path is contained (path doesn't have '..'), but realpath resolves
    // outside the files root — should be rejected.
    const result = await readArtifactFile(root, versionId, 'src/index.ts')
    expect(result).toBeNull()
  })

  it('readArtifactFile — nested valid regular file → read succeeds', async () => {
    // Write a deeper nested file.
    const deepPath = join(root, 'versions', versionId, 'files', 'deep', 'nested', 'x.ts')
    await mkdir(dirname(deepPath), { recursive: true })
    await writeFile(deepPath, 'DEEP CONTENT', 'utf8')

    const result = await readArtifactFile(root, versionId, 'deep/nested/x.ts')
    expect(result).toBe('DEEP CONTENT')
  })

  it('entryPoint symlink → validateArtifact rejects', async () => {
    const outside = join(root, 'versions', 'outside-31.txt')
    await writeFile(outside, 'OUTSIDE', 'utf8')
    const entryPath = join(root, 'versions', versionId, 'files', 'src', 'index.ts')
    await rm(entryPath)
    await symlink(outside, entryPath)

    // Keep entryPoint as the original contained path (no tampering needed).
    const result = await validateArtifact(root, versionId)
    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toMatch(/symlink/)
  })

  it('tampered persisted artifact — direct reader call with traversal path → rejects', async () => {
    // Tamper manifest entryPoint to traversal (simulates T10 tampered manifest).
    await tamperManifest({ entryPoint: '../outside-31.txt' })
    // Create the target outside the files root but inside the version dir
    // (so realpath of versionDir still works, but entry escapes filesRoot).
    const outsideFile = join(root, 'versions', versionId, 'outside-31.txt')
    await writeFile(outsideFile, 'OUTSIDE', 'utf8')

    // validateArtifact should reject via lexical check (before realpath).
    const validation = await validateArtifact(root, versionId)
    expect(validation.valid).toBe(false)
    expect(validation.errors.join('\n')).toMatch(/escapes the artifact files root/)
  })

  it('filesystem path prefix collision — readArtifactFile rejects via lexical guard', async () => {
    // Path like '../files2/x' resolves inside versions/v9/files2/x which is
    // a sibling of the files root — lexical containment rejects it.
    const result = await readArtifactFile(root, versionId, '../files2/x.js')
    expect(result).toBeNull()
  })
})

// ── 9c. cleanup must never delete outside its root (falsification #11) ──

describe('prune cleanup cannot be steered outside the experiences root', () => {
  let root: string
  let store: EvolutionStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'evo-contain-prune-'))
    store = new EvolutionStore({ fallbackRoot: root })
    await store.init()
  })

  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('a tampered experience id FIELD cannot direct a delete outside the root', async () => {
    // Sentinel file a traversal id would target: experiencesDir/<id>.json
    // with id = '../sentinel' resolves to <root>/sentinel.json.
    await writeFile(join(root, 'sentinel.json'), 'DO NOT DELETE', 'utf8')

    const rec = await store.addExperience({ success: true, prompt: 'p', summary: 's' })
    const recPath = join(root, 'experiences', rec.id + '.json')
    const content = JSON.parse(await readFile(recPath, 'utf8')) as Record<string, unknown>
    content.id = '../sentinel' // tamper the persisted id FIELD
    content.timestamp = '2000-01-01T00:00:00.000Z' // force TTL expiry
    await writeFile(recPath, JSON.stringify(content), 'utf8')

    const removed = await store.pruneExperiences(100, 1) // TTL 1 day → old record expires

    // The sentinel outside the experiences root must survive…
    expect(await readFile(join(root, 'sentinel.json'), 'utf8')).toBe('DO NOT DELETE')
    // …while the tampered record's own file is still pruned (by filename).
    expect(removed).toBe(1)
    expect(await exists(recPath)).toBe(false)
  })
})

// ── 10. falsification: actively try to make escapes succeed ──

describe('falsification — skip-the-builder and destructive-path probes', () => {
  let root: string
  let store: EvolutionStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'evo-contain-falsi-'))
    store = new EvolutionStore({ fallbackRoot: root })
    await store.init()
    await store.createVersion({ label: 'baseline', modules: [] })
  })

  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('F13 end-to-end evo_promote with a builder-bypassing evil candidate is rejected', async () => {
    // Candidate is BENCHMARKED (so the status gate passes) but its persisted
    // files carry traversal — the only defense is the final materialize gate.
    const cand = await addCandidate(store, [{ path: 'src/index.ts', content: 'ok' }])
    await seedLiveBenchmark(store, cand.id, 'v1', 'v1', { successRate: 1, avgScore: 1, errorRate: 0, avgSteps: 0, avgDurationMs: 120 })
    await store.updateCandidate(cand.id, { status: 'benchmarked' })
    await store.updateCandidate(cand.id, { files: [{ path: '../../escape.js', content: 'pwn' }] })

    const { promoteTools } = await import('../src/host/modules/promote/tools.ts')
    const deps = depsFor(store, root)
    const tool = promoteTools(deps).find(t => t.name === 'evo_promote')!
    const result = await tool.execute(
      { candidateId: cand.id, reason: 'falsification' } as never,
      { signal: AbortSignal.timeout(30_000) },
    ) as { ok: boolean; error: string }

    expect(result.ok).toBe(false)
    expect(String(result.error)).toMatch(/escape the artifact files root/)
    // No version artifact, no escape file.
    expect(await exists(join(root, 'escape.js'))).toBe(false)
    expect(await exists(join(root, 'versions', 'v2', 'manifest.json'))).toBe(false)
    // Baseline remains the only version; nothing was mutated.
    const versions = await store.listVersions()
    expect(versions).toHaveLength(1)
    expect((await store.getActiveVersion())!.id).toBe('v1')
  })

  it('F11 executePromotion refuses a traversal plannedVersionId (rm/access guard)', async () => {
    const victim = join(root, 'victim-dir')
    await mkdir(victim, { recursive: true })
    await writeFile(join(victim, 'keep.txt'), 'KEEP', 'utf8')

    const cand = await addCandidate(store, [{ path: 'src/index.ts', content: 'ok' }])
    const { executePromotion } = await import('../src/host/modules/promote/index.ts')
    const deps = depsFor(store, root)
    await expect(
      executePromotion(deps, cand, 'r', '../victim-dir', undefined),
    ).rejects.toThrow(/invalid planned version id/)

    // The directory the traversal would have targeted is untouched.
    expect(await readFile(join(victim, 'keep.txt'), 'utf8')).toBe('KEEP')
  })

  it('F14 an artifact whose manifest.files escape cannot pass validateArtifact', async () => {
    const cand = await addCandidate(store, [{ path: 'src/index.ts', content: 'ok' }])
    await materializeArtifact(root, versionFor('v2', cand.id), cand)
    const manifestPath = join(root, 'versions', 'v2', 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.files = ['../escape.js', 'src/index.ts']
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

    const result = await validateArtifact(root, 'v2')
    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toMatch(/manifest\.files entry escapes/)
  })
})
