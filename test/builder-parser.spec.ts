/**
 * Regression tests for candidate-file-set extraction.
 *
 * Found by a LIVE run: the configured model wrapped its JSON in prose, so the
 * original parser (bare JSON or a ```json fence only) rejected a valid
 * candidate with "Failed to parse candidate file set". These tests pin every
 * real shape the model produced or could produce.
 */

import { describe, it, expect } from 'vitest'
import { parseFileSetFromLLMResponse } from '../src/host/modules/builder/tools.ts'

const VALID = {
  manifest: {
    name: 'pre-edit-verification', version: '1.0.0', type: 'verification-strategy',
    description: 'verify before editing', entryPoint: 'src/index.ts',
    benchmarkCases: [{ id: 'c1', description: 'basic', input: 'x', timeoutMs: 5000, successCriteria: 'exit 0' }],
  },
  files: [{ path: 'src/index.ts', content: 'export const x = 1' }],
  tests: [{ path: 'test/index.spec.ts', content: 'test' }],
}

describe('parseFileSetFromLLMResponse', () => {
  it('parses bare JSON', () => {
    const result = parseFileSetFromLLMResponse(JSON.stringify(VALID))
    expect(result.manifest.name).toBe('pre-edit-verification')
    expect(result.files).toHaveLength(1)
  })

  it('parses JSON inside a language-tagged fence', () => {
    const text = 'Here is the module:\n\n```json\n' + JSON.stringify(VALID) + '\n```\n\nLet me know!'
    const result = parseFileSetFromLLMResponse(text)
    expect(result.files).toHaveLength(1)
  })

  it('parses JSON inside an untagged fence with surrounding prose', () => {
    const text = 'Sure!\n```\n' + JSON.stringify(VALID) + '\n```\nDone.'
    expect(parseFileSetFromLLMResponse(text).files).toHaveLength(1)
  })

  it('parses raw JSON embedded in prose with no fence', () => {
    const text = 'I propose this candidate: ' + JSON.stringify(VALID) + ' — that should help.'
    expect(parseFileSetFromLLMResponse(text).files).toHaveLength(1)
  })

  it('tolerates trailing commas', () => {
    const text = '```json\n' + JSON.stringify(VALID).replace('}]}', '},]}') + '\n```'
    expect(parseFileSetFromLLMResponse(text).files).toHaveLength(1)
  })

  it('accepts files given as a path to content map', () => {
    const asMap = { manifest: VALID.manifest, files: { 'src/index.ts': 'export const x = 1' }, tests: {} }
    const result = parseFileSetFromLLMResponse(JSON.stringify(asMap))
    expect(result.files).toEqual([{ path: 'src/index.ts', content: 'export const x = 1' }])
  })

  it('defaults a missing manifest name instead of rejecting the set', () => {
    const partial = { manifest: { type: 'policy', description: 'd', entryPoint: 'src/index.ts', benchmarkCases: [] }, files: VALID.files, tests: [] }
    const result = parseFileSetFromLLMResponse(JSON.stringify(partial))
    expect(result.manifest.name).toBe('candidate')
    expect(result.manifest.version).toBe('1.0.0')
  })

  it('reports the response length and head when nothing parses', () => {
    const text = 'I cannot help with that request, sorry.'.repeat(3)
    try {
      parseFileSetFromLLMResponse(text)
      throw new Error('should have thrown')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('no parseable JSON file set')
      expect(message).toContain('length')
      expect(message).toContain('I cannot help')
    }
  })

  it('rejects a JSON object that carries no files', () => {
    const empty = JSON.stringify({ manifest: VALID.manifest, files: [], tests: [] })
    expect(() => parseFileSetFromLLMResponse(empty)).toThrow(/no parseable JSON file set/)
  })
})

/**
 * Found by a LIVE probe run: the model sometimes nests `files` under a
 * wrapper key (`{manifest: {...}, candidate: {files: [...]}}`) instead of
 * putting them at the top level.  The original parser only read `root.files`,
 * so this shape produced an empty file set and "no parseable JSON file set".
 */
describe('parseFileSetFromLLMResponse — nested wrapper shapes', () => {
  it('finds files nested under a wrapper key', () => {
    const nested = {
      manifest: VALID.manifest,
      candidate: {
        files: [{ path: 'src/index.ts', content: 'export const x = 1' }],
        tests: [{ path: 'test/i.ts', content: 't' }],
      },
    }
    const result = parseFileSetFromLLMResponse(JSON.stringify(nested))
    expect(result.files).toHaveLength(1)
    expect(result.files[0]!.path).toBe('src/index.ts')
    expect(result.tests).toHaveLength(1)
  })

  it('finds files nested two levels deep', () => {
    const deep = {
      manifest: VALID.manifest,
      wrapper: { inner: { files: [{ path: 'src/a.ts', content: 'a' }] } },
    }
    const result = parseFileSetFromLLMResponse(JSON.stringify(deep))
    expect(result.files).toHaveLength(1)
    expect(result.files[0]!.path).toBe('src/a.ts')
  })

  it('still prefers top-level files over a nested copy', () => {
    const both = {
      manifest: VALID.manifest,
      files: [{ path: 'src/top.ts', content: 'top' }],
      candidate: { files: [{ path: 'src/nested.ts', content: 'nested' }] },
    }
    const result = parseFileSetFromLLMResponse(JSON.stringify(both))
    expect(result.files).toHaveLength(1)
    expect(result.files[0]!.path).toBe('src/top.ts')
  })

  it('does not recurse past depth 3', () => {
    const tooDeep = {
      manifest: VALID.manifest,
      a: { b: { c: { d: { files: [{ path: 'src/x.ts', content: 'x' }] } } } },
    }
    // depth 3 from root: a(1) -> b(2) -> c(3) -> d(4) stops.
    // findKeyDeep checks `key in obj` first at each level, so files at depth 4
    // is NOT reached — this documents the guard, not a preference.
    expect(() => parseFileSetFromLLMResponse(JSON.stringify(tooDeep))).toThrow(/no parseable JSON file set/)
  })
})

/**
 * Found by a LIVE run: the model emitted the same path twice in `files`,
 * and validateCandidateFileSet rejected the set with
 * "duplicate files: test/index.spec.ts".  De-duplicating at normalize time
 * (keep last) is strictly better than failing the whole candidate.
 */
describe('parseFileSetFromLLMResponse — duplicate file paths', () => {
  it('de-duplicates files by path, keeping the last occurrence', () => {
    const dupe = {
      manifest: VALID.manifest,
      files: [
        { path: 'src/index.ts', content: 'first version' },
        { path: 'src/index.ts', content: 'second version' },
      ],
      tests: [],
    }
    const result = parseFileSetFromLLMResponse(JSON.stringify(dupe))
    expect(result.files).toHaveLength(1)
    expect(result.files[0]!.content).toBe('second version')
  })

  it('de-duplicates tests independently of files', () => {
    const dupe = {
      manifest: VALID.manifest,
      files: [{ path: 'src/index.ts', content: 'x' }],
      tests: [
        { path: 'test/a.ts', content: 'v1' },
        { path: 'test/a.ts', content: 'v2' },
      ],
    }
    const result = parseFileSetFromLLMResponse(JSON.stringify(dupe))
    expect(result.tests).toHaveLength(1)
    expect(result.tests[0]!.content).toBe('v2')
  })

  it('keeps distinct paths untouched', () => {
    const multi = {
      manifest: VALID.manifest,
      files: [
        { path: 'src/a.ts', content: 'a' },
        { path: 'src/b.ts', content: 'b' },
      ],
      tests: [],
    }
    const result = parseFileSetFromLLMResponse(JSON.stringify(multi))
    expect(result.files).toHaveLength(2)
  })
})

/**
 * A single `{path, content}` object (not wrapped in an array) used to be read
 * as a path→content map, producing two fake files named `path` and `content`
 * — which then failed validation with "unsupported file type". Pin the fix.
 */
describe('parseFileSetFromLLMResponse — single file object', () => {
  it('treats a lone {path, content} object as one file, not a two-entry map', () => {
    const body = JSON.stringify({
      manifest: VALID.manifest,
      files: { path: 'src/index.ts', content: 'export const x = 1' },
      tests: [],
    })
    const result = parseFileSetFromLLMResponse(body)
    expect(result.files).toHaveLength(1)
    expect(result.files[0]!.path).toBe('src/index.ts')
    expect(result.files[0]!.content).toBe('export const x = 1')
  })

  it('still treats a multi-key map as a path→content map', () => {
    const body = JSON.stringify({
      manifest: VALID.manifest,
      files: { 'src/a.ts': 'a', 'src/b.ts': 'b' },
      tests: [],
    })
    const result = parseFileSetFromLLMResponse(body)
    expect(result.files).toHaveLength(2)
  })
})

/**
 * Found by a LIVE run (mimo-v2.6-flash-free): the second element of a `files`
 * ARRAY carried an object as its path —
 *   {"path":{"src/index.ts":"IGNORE"},"content":""}
 * The old array branch filtered on `typeof entry.path === 'string'`, so that
 * entry was dropped. With only the placeholder remaining, normalization
 * yielded no parseable JSON file set — one model quirk discarded a valid
 * module.
 */
describe('parseFileSetFromLLMResponse — pre-flight shape gate', () => {
  it('rejects a response truncated inside a string, without inventing content', () => {
    // The model cut off mid-string: the closing quote never arrived.
    const truncated = '{"manifest":' + JSON.stringify(VALID.manifest)
      + ',"files":[{"path":"src/index.ts","content":"export const x = 1'
    expect(() => parseFileSetFromLLMResponse(truncated)).toThrow(/truncated inside a string/)
  })

  it('rejects an extra closer with no matching opener', () => {
    // An extra `]` closes the root early; the rest is structural damage.
    const extra = '{"manifest":' + JSON.stringify(VALID.manifest)
      + ',"files":[]]}],"tests":[]}'
    expect(() => parseFileSetFromLLMResponse(extra)).toThrow(/extra `\}` or `\]`/)
  })

  it('does NOT pre-reject a response whose only problem is a trailing comma', () => {
    // The repair ladder must still handle this — the gate is structural only.
    const body = '{"manifest":' + JSON.stringify(VALID.manifest)
      + ',"files":[' + JSON.stringify(VALID.files[0]) + ',],}'
    const result = parseFileSetFromLLMResponse(body)
    expect(result.files).toHaveLength(1)
  })

  it('does NOT pre-reject a response whose only problem is an invalid escape', () => {
    const body = '{"manifest":' + JSON.stringify(VALID.manifest)
      + ',"files":[{"path":"src/index.ts","content":"\\order"}]}'
    const result = parseFileSetFromLLMResponse(body)
    expect(result.files[0]!.content).toContain('\\order')
  })

  it('still parses an intact response with balanced brackets', () => {
    const result = parseFileSetFromLLMResponse(JSON.stringify(VALID))
    expect(result.files).toHaveLength(1)
  })
})

/**
 * Found by a LIVE run (mimo-v2.6-flash-free): the second element of a `files`
 * ARRAY carried an object as its path —
 *   {"path":{"src/index.ts":"IGNORE"},"content":""}
 * The old array branch filtered on `typeof entry.path === 'string'`, so that
 * entry was dropped. With only the placeholder remaining, normalization
 * yielded no parseable JSON file set — one model quirk discarded a valid
 * module.
 */
describe('parseFileSetFromLLMResponse — object-valued path in array', () => {
  it('keeps the valid entries when one array element has an object-valued path', () => {
    const body = JSON.stringify({
      manifest: VALID.manifest,
      files: [
        { path: 'src/index.ts', content: 'real content' },
        { path: { 'src/index.ts': 'IGNORE' }, content: '' },
      ],
      tests: [],
    })
    const result = parseFileSetFromLLMResponse(body)
    expect(result.files.length).toBeGreaterThan(0)
    expect(result.files.some(f => f.path === 'src/index.ts')).toBe(true)
  })

  it('recovers paths from an object-valued path entry inside an array', () => {
    const body = JSON.stringify({
      manifest: VALID.manifest,
      files: [{ path: { 'src/a.ts': 'aaa' }, content: 'ignored' }],
      tests: [],
    })
    const result = parseFileSetFromLLMResponse(body)
    expect(result.files).toEqual([{ path: 'src/a.ts', content: 'aaa' }])
  })

  it('recovers paths from an object-valued path on a lone object', () => {
    const body = JSON.stringify({
      manifest: VALID.manifest,
      files: { path: { 'src/b.ts': 'bbb' }, content: 'ignored' },
      tests: [],
    })
    const result = parseFileSetFromLLMResponse(body)
    expect(result.files).toEqual([{ path: 'src/b.ts', content: 'bbb' }])
  })

  it('drops an array element whose path object is not recoverable', () => {
    const body = JSON.stringify({
      manifest: VALID.manifest,
      files: [
        { path: 'src/index.ts', content: 'good' },
        { path: { nested: { too: 'deep' } }, content: 'bad' },
      ],
      tests: [],
    })
    const result = parseFileSetFromLLMResponse(body)
    expect(result.files).toEqual([{ path: 'src/index.ts', content: 'good' }])
  })
})

/**
 * Found by a LIVE run: with reasoning pinned off the model produced a COMPLETE
 * document (finish_reason "stop", no truncation) whose TypeScript payload
 * contained `\order?` inside a JSON string. `\o` is not a legal JSON escape, so
 * `JSON.parse` rejected the whole candidate with "Bad escaped character in JSON
 * at position 1383" — one character discarded an entire generated module.
 */
describe('parseFileSetFromLLMResponse — invalid escape repair', () => {
  // Built by concatenation so the single backslash survives into the fixture.
  const broken = '{"manifest":' + JSON.stringify(VALID.manifest)
    + ',"files":[{"path":"src/index.ts","content":"type Opts = {\\order?: 1 }"}]}'

  it('the pinned fixture really is unparseable as-is', () => {
    // Guards the fixture itself: if a future change made this legal, the tests
    // below would pass without exercising the repair at all.
    expect(() => JSON.parse(broken)).toThrow(/Bad escaped character/)
  })

  it('recovers a file set whose content has an illegal escape', () => {
    const result = parseFileSetFromLLMResponse(broken)
    expect(result.files).toHaveLength(1)
    expect(result.manifest.name).toBe(VALID.manifest.name)
  })

  it('recovers the literal backslash into the file content', () => {
    const result = parseFileSetFromLLMResponse(broken)
    // The model meant a literal backslash; the repair doubles it, and JSON.parse
    // hands the single backslash back.
    expect(result.files[0]!.content).toContain('\\order?')
  })

  it('leaves valid escapes untouched', () => {
    // A newline escape and a doubled backslash must NOT be re-escaped.
    const validEscapes = '{"manifest":' + JSON.stringify(VALID.manifest)
      + ',"files":[{"path":"src/index.ts","content":"line1\\nline2\\\\end"}]}'
    const result = parseFileSetFromLLMResponse(validEscapes)
    expect(result.files[0]!.content).toBe('line1\nline2\\end')
  })

  it('does not treat an escaped quote as a literal backslash', () => {
    // `\"` is a legal escape; doubling it would corrupt code that legitimately
    // contains quoted strings.
    const quoted = '{"manifest":' + JSON.stringify(VALID.manifest)
      + ',"files":[{"path":"src/index.ts","content":"const s = \\"hi\\""}]}'
    const result = parseFileSetFromLLMResponse(quoted)
    expect(result.files[0]!.content).toBe('const s = "hi"')
  })

  it('repairs escapes even when the document also has trailing commas', () => {
    const both = '{"manifest":' + JSON.stringify(VALID.manifest)
      + ',"files":[{"path":"src/index.ts","content":"\\order"},],}'
    const result = parseFileSetFromLLMResponse(both)
    expect(result.files[0]!.content).toContain('\\order')
  })

  it('repairs a malformed \\u escape into literal text', () => {
    const badUnicode = '{"manifest":' + JSON.stringify(VALID.manifest)
      + ',"files":[{"path":"src/index.ts","content":"\\u00zz"}]}'
    // A \uXXXX with non-hex digits is not an escape; it must become literal
    // text rather than a silently mangled unicode sequence.
    const result = parseFileSetFromLLMResponse(badUnicode)
    expect(result.files[0]!.content).toContain('u00zz')
  })
})
