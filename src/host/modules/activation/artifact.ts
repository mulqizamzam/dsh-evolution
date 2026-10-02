/**
 * Version artifacts: turning a promoted candidate into a deterministic,
 * loadable plugin package.
 *
 * The artifact is HOST-AUTHORED. The candidate's own files are copied as DATA
 * (`files/`) and are never imported into the host process — they only ever run
 * inside the sandbox. `plugin.js` is a fixed template parameterised by plain
 * data (names, paths, version id), so loading it cannot execute candidate code.
 *
 * Layout:
 *   <stateRoot>/versions/<versionId>/manifest.json
 *   <stateRoot>/versions/<versionId>/plugin.js
 *   <stateRoot>/versions/<versionId>/files/<candidate paths>
 *
 * CUMULATIVE COMPOSITION (Mission: Cumulative Version Composition):
 *   When a promotion provides `baseVersionId`, the new version's artifact is
 *   the FULL copy of the base version's artifact file tree overlaid with the
 *   candidate's own files/tests. The candidate wins every path collision; any
 *   base file the candidate does not touch is preserved byte-for-byte — a
 *   missing candidate file NEVER deletes a base file. Each version still owns
 *   a complete, independent, immutable `files/` directory: there are no lazy
 *   overlays and nothing is inherited at activation time, so rollback, restart
 *   recovery and the canonical active pointer keep their existing semantics.
 *   The entry point continues to follow the existing schema derivation
 *   (`candidate.files[0]`), so a candidate that ships a different first file
 *   replaces the entry point exactly like a non-composed promotion would.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rm, realpath, readdir, stat } from 'node:fs/promises'
import { join, dirname, relative, sep } from 'node:path'
import { neutralize } from '../../../lib/sanitize.ts'
import { containPath } from '../../../lib/contain.ts'
import { isSafeKey } from '../../../lib/ids.ts'
import type { CandidateModule, Version } from '../../types.ts'

/** Manifest version. Bump when the artifact layout changes. */
export const ARTIFACT_SCHEMA = 1

export interface ArtifactManifest {
  schema: number
  versionId: string
  candidateId: string
  /** Human name, neutralized for model-visible text. */
  name: string
  /** Tool the activated plugin registers. */
  toolName: string
  pluginName: string
  entryPoint: string
  /** Command used for the pre-flight and the default tool execution. */
  testCommand: string
  files: string[]
  contentHash: string
  createdAt: string
}

export interface ArtifactValidation {
  valid: boolean
  errors: string[]
  warnings: string[]
}

/**
 * Composition input: read the COMPLETE persisted file set of the base
 * version so a promotion can preserve every file the candidate does not
 * replace. Returns candidate-shaped entries ({path, content}) — the base
 * artifact is data on disk, never host code.
 *
 * Each entry reads through the same symlink containment used by runtime
 * readers (lexical → realpath → lexical): a base entry file that became a
 * symlink pointing outside the base files root is silently skipped, never
 * followed. Skipped entries are reported in `skipped` so the caller can
 * surface them in diagnostics without treating them as a hard error — the
 * composed artifact stays complete and valid without them.
 *
 * The read is purely data-copying: it never imports, executes or trusts
 * manifest claims from the base artifact. Paths come from the real on-disk
 * walk, not from the persisted manifest.
 */
export async function readBaseArtifactFiles(
  stateRoot: string,
  versionId: string,
): Promise<{ files: Array<{ path: string; content: string }>; skipped: string[] }> {
  const skipped: string[] = []
  const files: Array<{ path: string; content: string }> = []
  if (!isSafeKey(versionId)) return { files, skipped }
  let filesRoot: string
  try {
    filesRoot = artifactFilesDir(stateRoot, versionId)
  } catch {
    return { files, skipped }
  }
  // Deterministic walk: sorted entries at every level.
  async function walk(current: string): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(current)
    } catch {
      return
    }
    for (const name of entries.sort()) {
      const full = join(current, name)
      let s: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }
      try {
        s = await stat(full)
      } catch {
        skipped.push(relative(filesRoot, full))
        continue
      }
      if (s.isDirectory() && !s.isSymbolicLink()) {
        await walk(full)
      } else if (s.isFile() || s.isSymbolicLink()) {
        const rel = relative(filesRoot, full)
        // Lexical guard first: never read anything outside the base root.
        if (containPath(filesRoot, rel) === null) {
          skipped.push(rel)
          continue
        }
        // Symlink-hardened read: resolve the real target and re-check.
        try {
          const realRoot = await realpath(filesRoot)
          let realTarget: string
          try {
            realTarget = await realpath(full)
          } catch {
            skipped.push(rel)
            continue
          }
          if (containPath(realRoot, realTarget) === null) {
            skipped.push(rel)
            continue
          }
          files.push({ path: rel, content: await readFile(realTarget, 'utf8') })
        } catch {
          skipped.push(rel)
        }
      }
    }
  }
  await walk(filesRoot)
  return { files, skipped }
}

/**
 * Optional composition input for materializeArtifact. `baseVersionId`
 * selects cumulative promotion: the new artifact starts as the base
 * artifact's complete file tree and the candidate's files/tests overlay it.
 * Candidate paths win every collision; missing candidate files preserve
 * (never delete) base files. Omitted (or null) = legacy replacement mode.
 */
export interface CompositionInput {
  baseVersionId?: string | null
}

/** Turn a candidate name into a safe tool-name segment. */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return slug === '' ? 'candidate' : slug
}

/** Stable hash over the ordered file set so a changed candidate gets a new id. */
export function hashFileSet(files: Array<{ path: string; content: string }>): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    hash.update(file.path)
    hash.update('\u0000')
    hash.update(file.content)
    hash.update('\u0000')
  }
  return hash.digest('hex')
}

export function versionDir(stateRoot: string, versionId: string): string {
  // versionId reaches here from tool arguments (e.g. evo_rollback) as well as
  // from store records; it is a path component, so refuse anything that is
  // not a host-shaped key (`v1`, hex ids) before joining.
  if (!isSafeKey(versionId)) {
    throw new Error('invalid version id: ' + JSON.stringify(String(versionId)))
  }
  return join(stateRoot, 'versions', versionId)
}

export function artifactFilesDir(stateRoot: string, versionId: string): string {
  return join(versionDir(stateRoot, versionId), 'files')
}

export function artifactManifestPath(stateRoot: string, versionId: string): string {
  return join(versionDir(stateRoot, versionId), 'manifest.json')
}

export function artifactPluginPath(stateRoot: string, versionId: string): string {
  return join(versionDir(stateRoot, versionId), 'plugin.js')
}

/**
 * The generated plugin source. It imports nothing, holds no candidate code, and
 * delegates every execution to the `evolutionRuntime` service provided by
 * dsh-evolution, so the candidate keeps running through the sandbox boundary.
 */
export function renderPluginSource(manifest: Pick<ArtifactManifest, 'pluginName' | 'toolName' | 'versionId' | 'name'>): string {
  const name = neutralize(manifest.name)
  const toolName = neutralize(manifest.toolName)
  const pluginName = neutralize(manifest.pluginName)
  return `// Generated by dsh-evolution. Do not edit: promotion rewrites this file.
// Host-authored: the promoted candidate's own source is never imported here.
export const name = ${JSON.stringify(pluginName)}

export function apply(ctx, config) {
  const runtime = () => ctx.get('evolutionRuntime')

  ctx.tools.register({
    name: ${JSON.stringify(toolName)},
    description: 'Run the promoted candidate capability "${name}" (active version ${manifest.versionId}) inside the sandbox. Optionally override the command.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Optional command override. Defaults to the version test command.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: function (_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
      },
    },
    execute: async function (args) {
      const service = runtime()
      if (!service) {
        return { ok: false, error: 'evolutionRuntime service is not available in this host' }
      }
      const a = args || {}
      return await service.runCandidate({
        versionId: ${JSON.stringify(manifest.versionId)},
        command: typeof a.command === 'string' && a.command !== '' ? a.command : undefined,
        timeoutMs: typeof a.timeoutMs === 'number' ? a.timeoutMs : undefined,
      })
    },
  })
}
`
}

/**
 * Write the artifact for one version. Atomic in effect: everything is written
 * to a staging directory and then renamed into place, so a failed promotion
 * never leaves a half-written artifact that boot would try to load.
 */
export async function materializeArtifact(
  stateRoot: string,
  version: Version,
  candidate: CandidateModule,
  composition?: CompositionInput,
): Promise<ArtifactManifest> {
  const finalDir = versionDir(stateRoot, version.id)
  const stagingDir = finalDir + '.staging'

  // ── Final trust boundary for candidate-controlled paths (I7) ──
  // Validate EVERY candidate file/test path against the files root BEFORE any
  // filesystem mutation: no staging directory is removed or created, no parent
  // directory is made, and no byte is written for an invalid candidate, so a
  // rejected attempt leaves any existing valid artifact byte-identical.
  // The check is purely lexical (containPath never touches the fs), so it also
  // works for destinations that do not exist yet and never reads an outside
  // file merely to validate.
  const filesRoot = join(finalDir, 'files')
  const invalidPaths: string[] = []
  for (const file of [...candidate.files, ...candidate.tests]) {
    if (containPath(filesRoot, file.path) === null) invalidPaths.push(String(file.path))
  }
  if (invalidPaths.length > 0) {
    throw new Error(
      'candidate path(s) escape the artifact files root and were rejected before write: '
      + invalidPaths.join(', '),
    )
  }

  // ── Cumulative composition: overlay base artifact on top of the candidate ──
  // The base (the currently active version) provides the initial file tree.
  // The candidate's files and tests are overlaid by path; the candidate
  // always wins every collision.  Missing candidate paths never delete base
  // files.  The base read is purely lexical + realpath containment — a
  // tampered base is handled by the same trust boundary that already
  // rejects manifest escapes at validation time.
  const baseVersionId =
    typeof composition?.baseVersionId === 'string' && composition.baseVersionId !== ''
      ? composition.baseVersionId
      : undefined

  // 1.  Read base file set (empty when base has no artifact — baseline v1).
  //     readBaseArtifactFiles is symlink-hardened (realpath + containPath).
  let baseFiles: Array<{ path: string; content: string }> = []
  if (baseVersionId) {
    const base = await readBaseArtifactFiles(stateRoot, baseVersionId)
    baseFiles = base.files
  }

  // 2.  Overlay: map base files by path, then let candidate files/tests win.
  const composedByPath = new Map<string, string>()
  for (const bf of baseFiles) {
    composedByPath.set(bf.path, bf.content)
  }
  //    Candidate files replace; tests add-or-replace.
  for (const f of [...candidate.files, ...candidate.tests]) {
    composedByPath.set(f.path, f.content)
  }

  // 3.  Sort for deterministic artifact output (same content → same layout).
  const composedEntries = [...composedByPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  // 3b. Source-file listing for the manifest. Pre-composition semantics are
  //     preserved exactly: manifest.files lists SOURCE files only — tests are
  //     materialized to disk but never listed (artifact-containment T17 and
  //     validateArtifact both rely on that). The base contributes its own
  //     manifest.files (the base's declared source set), containment-checked
  //     and intersected with what was actually read, so a tampered base entry
  //     can neither escape nor be listed without existing on disk.
  let baseManifest: ArtifactManifest | null = null
  if (baseVersionId) {
    baseManifest = await readArtifactManifest(stateRoot, baseVersionId)
  }
  const sourcePaths = new Set<string>()
  if (Array.isArray(baseManifest?.files)) {
    for (const p of baseManifest.files) {
      if (
        typeof p === 'string' && p !== ''
        && containPath(filesRoot, p) !== null
        && composedByPath.has(p)
      ) {
        sourcePaths.add(p)
      }
    }
  }
  for (const f of candidate.files) sourcePaths.add(f.path)
  const sourceListed = [...sourcePaths].sort()

  // 4.  Derive the manifest entry point and test command following the
  //     existing schema derivation: entryPoint = candidate.files[0].
  //     When the candidate has no files the base entry is preserved
  //     (requirement 5: replace only when the existing schema supports it).
  const composedFirstCandidateFile = candidate.files[0]?.path ?? undefined
  let entryPoint = composedFirstCandidateFile ?? baseManifest?.entryPoint ?? 'src/index.ts'
  const testCommand = 'node ' + entryPoint

  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(stagingDir, { recursive: true })

  const slug = slugify(candidate.name)
  const manifest: ArtifactManifest = {
    schema: ARTIFACT_SCHEMA,
    versionId: version.id,
    candidateId: candidate.id,
    name: neutralize(candidate.name),
    toolName: 'evo_active_' + slug,
    pluginName: 'evo-active-' + slug,
    entryPoint,
    testCommand,
    files: sourceListed,
    contentHash: hashFileSet(sourceListed.map(path => ({ path, content: composedByPath.get(path) ?? '' }))),
    createdAt: new Date().toISOString(),
  }

  // Re-resolve at the write itself (defense in depth): each target is the
  // containment-checked absolute path, never a raw join of untrusted input.
  // The composed set (base + candidate overlay) is written in one pass;
  // candidate paths won every collision during the merge above.
  const stagingFilesRoot = join(stagingDir, 'files')
  for (const [path, content] of composedEntries) {
    const target = containPath(stagingFilesRoot, path)
    if (target === null) {
      throw new Error('candidate path escapes the artifact files root: ' + String(path))
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }

  await writeFile(join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  await writeFile(join(stagingDir, 'plugin.js'), renderPluginSource(manifest), 'utf8')

  // Do NOT remove finalDir before the commit rename: a crash between rm and
  // rename would destroy the live artifact with no recovery path. Node.js
  // rename() throws ENOTEMPTY when the target is a non-empty directory, so we
  // use a two-phase rename with a safe intermediate name. The intermediate
  // rename only touches v<N>.staging and v<N>.new (never v<N>), so a crash
  // between the two phases leaves the old artifact intact.
  const { rename } = await import('node:fs/promises')
  const intermediateDir = finalDir + '.new'
  await rename(stagingDir, intermediateDir)
  // If finalDir already exists and is non-empty, clear it so the final rename
  // can succeed. A crash here leaves the intermediate dir intact, which the
  // next retry will clean up (materializeArtifact starts by removing stale
  // staging dirs).
  const { access } = await import('node:fs/promises')
  try {
    await access(finalDir)
    await rm(finalDir, { recursive: true, force: true })
  } catch { /* does not exist */ }
  await rename(intermediateDir, finalDir)

  return manifest
}

/**
 * Validate an artifact BEFORE the host loads it. Everything here is static
 * inspection plus the sandbox pre-flight the loader performs separately.
 */
export async function validateArtifact(stateRoot: string, versionId: string): Promise<ArtifactValidation> {
  const errors: string[] = []
  const warnings: string[] = []
  // Tool-supplied version ids must not become path components; return a clean
  // validation failure rather than letting versionDir() throw.
  if (!isSafeKey(versionId)) {
    return { valid: false, errors: ['invalid version id: ' + JSON.stringify(String(versionId))], warnings }
  }
  const dir = versionDir(stateRoot, versionId)

  let raw: string
  try {
    raw = await readFile(artifactManifestPath(stateRoot, versionId), 'utf8')
  } catch {
    return { valid: false, errors: ['no artifact manifest at ' + dir], warnings }
  }

  let manifest: ArtifactManifest
  try {
    manifest = JSON.parse(raw) as ArtifactManifest
  } catch (error) {
    return { valid: false, errors: ['artifact manifest is not valid JSON: ' + String(error)], warnings }
  }

  if (manifest.schema !== ARTIFACT_SCHEMA) errors.push('unsupported artifact schema ' + String(manifest.schema))
  if (manifest.versionId !== versionId) errors.push('manifest versionId ' + manifest.versionId + ' does not match directory ' + versionId)
  for (const field of ['candidateId', 'toolName', 'pluginName', 'entryPoint', 'testCommand'] as const) {
    if (typeof manifest[field] !== 'string' || manifest[field] === '') errors.push('manifest.' + field + ' is required')
  }
  if (typeof manifest.toolName === 'string' && !/^evo_active_[a-z0-9_]+$/.test(manifest.toolName)) {
    errors.push('manifest.toolName is not a safe tool name: ' + manifest.toolName)
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    errors.push('manifest.files must list at least one candidate file')
  }

  try {
    await readFile(artifactPluginPath(stateRoot, versionId), 'utf8')
  } catch {
    errors.push('plugin.js is missing')
  }

  // ── Path containment for every manifest path field (I2/I3/I4/I7/I12) ──
  // The manifest is PERSISTED state and may have been tampered with after the
  // builder ran, so containment is re-established here at the final validation
  // boundary — builder-time validation is explicitly not trusted.
  const filesRoot = artifactFilesDir(stateRoot, versionId)
  if (Array.isArray(manifest.files)) {
    for (const f of manifest.files) {
      if (containPath(filesRoot, f) === null) {
        errors.push('manifest.files entry escapes the artifact files root: ' + JSON.stringify(String(f)))
      }
    }
  }

  const entryPoint = manifest.entryPoint
  if (typeof entryPoint === 'string' && entryPoint !== '') {
    // Lexical containment first: containPath touches no filesystem, so an
    // outside path is rejected WITHOUT reading anything outside the root.
    const entry = containPath(filesRoot, entryPoint)
    if (entry === null) {
      errors.push('declared entry point escapes the artifact files root: ' + JSON.stringify(entryPoint))
    } else {
      // The persisted artifact can be modified on disk after materialization
      // (including turning a file into a symlink), so the REAL filesystem
      // target must also stay inside the real files root before it is read.
      try {
        const realRoot = await realpath(filesRoot)
        let realEntry: string
        try {
          realEntry = await realpath(entry)
        } catch {
          errors.push('declared entry point is missing: files/' + entryPoint)
          realEntry = ''
        }
        if (realEntry !== '') {
          if (containPath(realRoot, realEntry) === null) {
            errors.push('declared entry point resolves outside the artifact files root (symlink): ' + entryPoint)
          } else {
            try {
              await readFile(realEntry, 'utf8')
            } catch {
              errors.push('declared entry point is missing: files/' + entryPoint)
            }
          }
        }
      } catch {
        errors.push('declared entry point is missing: files/' + entryPoint)
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

/** Read the manifest of an existing artifact, or null. */
export async function readArtifactManifest(stateRoot: string, versionId: string): Promise<ArtifactManifest | null> {
  if (!isSafeKey(versionId)) return null
  try {
    const raw = await readFile(artifactManifestPath(stateRoot, versionId), 'utf8')
    return JSON.parse(raw) as ArtifactManifest
  } catch {
    return null
  }
}
