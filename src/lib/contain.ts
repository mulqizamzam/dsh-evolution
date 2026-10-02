import { resolve, relative, isAbsolute, sep } from 'node:path'

/**
 * Path containment for untrusted, candidate-controlled relative paths.
 *
 * This is the SINGLE containment rule for the plugin (one helper, every
 * boundary). The property it enforces is containment, not normalization:
 * `resolve(root, candidate)` must land strictly INSIDE `root`, proven with
 * `relative()` (a directory-boundary proof) rather than a string-prefix
 * comparison — a prefix check would wrongly accept `/root/files2/x`
 * for root `/root/files`.
 *
 * Rejects, without touching the filesystem (so it is safe to call before any
 * directory is created and never reads an outside file just to validate):
 *   - non-string / empty paths and paths containing NUL bytes;
 *   - absolute paths (`/etc/passwd`, and any path that resolves outside);
 *   - `..` traversal in every position (`../x`, `sub/../../x`, `a/b/../../../x`);
 *   - prefix collisions (`files` vs `files2`) — `relative()` yields `../files2/...`;
 *   - paths that resolve to the root itself (the root is a directory, not a file).
 *
 * Platform contract: Linux/POSIX path semantics (the deployment target of this
 * plugin — FACT from `os.platform() === 'linux'`). Backslash is an ordinary
 * filename byte on POSIX, so Windows-style separators need no special handling
 * here: `a\..\..\x` is a single filename that stays inside the root.
 *
 * Symlinks: this check is purely lexical. A caller that must be robust against
 * a SYMLINK already present on disk (tampered persisted artifacts) has to
 * re-check the real filesystem target with `realpath` after this check.
 *
 * @returns the resolved absolute path when contained, otherwise null.
 */
export function containPath(root: string, candidatePath: unknown): string | null {
  if (typeof candidatePath !== 'string') return null
  if (candidatePath === '' || candidatePath.includes('\0')) return null

  const base = resolve(root)
  const target = resolve(base, candidatePath)
  if (target === base) return null // the root itself is not a contained file

  const rel = relative(base, target)
  // Directory-boundary proof: inside iff rel is a non-empty, non-absolute
  // relative path that does not start with '..' (or '..' + separator).
  if (rel === '') return null
  if (isAbsolute(rel)) return null
  if (rel === '..' || rel.startsWith('..' + sep)) return null
  return target
}

/** Boolean convenience wrapper over {@link containPath}. */
export function isContainedPath(root: string, candidatePath: unknown): boolean {
  return containPath(root, candidatePath) !== null
}
