import { readFile, writeFile, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { newId } from './ids.ts'

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
