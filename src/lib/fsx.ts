import { readFile, writeFile, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { newId } from './ids.ts'

/** Regex matching orphan .tmp.{id} files left by writeJsonAtomic/writeTextAtomic on crash. */
const TMP_ORPHAN_RE = /\.tmp\.[a-f0-9]{12}$/

/**
 * Scan a directory for orphan .tmp.* files (left after a crash mid-write) and
 * delete them. Returns the number of files removed.
 * Safe to call at startup — only touches known atomic-write temp names.
 */
export async function cleanupTmpOrphans(dir: string): Promise<number> {
  let removed = 0
  try {
    const entries = await readdir(dir)
    for (const name of entries) {
      if (!TMP_ORPHAN_RE.test(name)) continue
      try {
        await unlink(join(dir, name))
        removed++
      } catch { /* already gone */ }
    }
  } catch { /* dir may not exist yet */ }
  return removed
}

/** Read a JSON file safely; returns null on ENOENT or parse failure. */
export async function readJsonSafe(path: string): Promise<unknown> {
  try {
    const text = await readFile(path, 'utf8')
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Atomic JSON write: write to tmp then rename. */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  // The temp name must be unique per CALL, not per millisecond: two writers of
  // the same path inside one millisecond would share one temp file, and the
  // second rename then fails with ENOENT after the first consumed it.
  const tmp = path + '.tmp.' + newId()
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  const { rename } = await import('node:fs/promises')
  await rename(tmp, path)
}

/** Read text file safely; returns null on ENOENT. */
export async function readTextSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** Atomic text write. */
export async function writeTextAtomic(path: string, content: string): Promise<void> {
  const tmp = path + '.tmp.' + newId()
  await writeFile(tmp, content, 'utf8')
  const { rename } = await import('node:fs/promises')
  await rename(tmp, path)
}

/** List files in a directory, sorted by mtime descending. */
export async function listDir(dir: string, limit: number = 500): Promise<string[]> {
  try {
    const entries = await readdir(dir)
    const withMtime: Array<{ name: string; mtime: number }> = []
    // Every entry must be stat'd before the sort: readdir order is
    // filesystem-dependent, so pre-slicing to a window would drop entries the
    // sort never sees — with more files than the window, the newest records
    // would silently disappear from the result.
    for (const name of entries) {
      try {
        const s = await stat(join(dir, name))
        if (s.isFile()) withMtime.push({ name, mtime: s.mtimeMs })
      } catch { /* skip */ }
    }
    withMtime.sort((a, b) => b.mtime - a.mtime)
    return withMtime.slice(0, limit).map(e => e.name)
  } catch {
    return []
  }
}

/** Delete a file if it exists. */
export async function removeFile(path: string): Promise<boolean> {
  try {
    await unlink(path)
    return true
  } catch {
    return false
  }
}

/** Read a JSON file directly (no safety wrapper). Throws on failure. */
export async function readJsonFile<T = unknown>(path: string): Promise<T> {
  const text = await readFile(path, 'utf8')
  return JSON.parse(text) as T
}

/** Write a JSON file directly (no atomicity guarantee). */
export async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

/**
 * Read a newline-delimited JSON file.
 *
 * A single corrupt line must not discard the whole batch: line-by-line parsing
 * keeps every intact record. A file-level failure (missing/unreadable) still
 * yields an empty array, matching the previous contract.
 */
export async function readJsonlSafe(path: string): Promise<unknown[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }
  if (!text.trim()) return []
  const out: unknown[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch { /* skip a corrupt line, keep every intact record */ }
  }
  return out
}

/** Atomic newline-delimited JSON write: write to tmp then rename. */
export async function writeJsonlAtomic(path: string, records: unknown[]): Promise<void> {
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n'
  const tmp = path + '.tmp.' + newId()
  await writeFile(tmp, content, 'utf8')
  const { rename } = await import('node:fs/promises')
  await rename(tmp, path)
}
