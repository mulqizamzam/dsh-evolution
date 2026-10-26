import { join, dirname } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { JSON_OBJECT_OUTPUT, defineTool, text } from '../../dsh.ts'
import type {
  ModuleDeps,
  ToolDefinition,
  HostLlmGenerateOptions,
  HostLlmStreamChunk,
  CandidateFileSet,
  CandidateValidationResult,
  Pattern,
  ExperienceRecord,
  AgentDefaultModelService,
} from '../../types.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'
import { containPath } from '../../../lib/contain.ts'

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

// ── Host LLM caller (uses ctx.llm.stream from the Cordis runtime) ──

/** Real host token accounting: {@link TokenUsage} uses input/output naming. */
export interface HostUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  reasoningTokens: number
}

interface StreamOutcome {
  text: string
  reasoning: string
  finishKind: string
  failure: string
  usage: HostUsage
}

/**
 * Consume one host LLM stream completely.
 *
 * Reads the REAL chunk contract: `text-delta` for streamed text, `block-end`
 * for adapters that deliver an assembled text block instead of deltas,
 * `reasoning-delta` for thinking output, `usage` in input/output naming, and
 * `finish` for the terminal reason (which may be a failure).
 */
async function consumeStream(iterable: AsyncIterable<HostLlmStreamChunk>): Promise<StreamOutcome> {
  let text = ''
  let reasoning = ''
  let finishKind = 'unknown'
  let failure = ''
  const usage: HostUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0 }
  const deltaIndexes = new Set<number>()

  for await (const chunk of iterable as AsyncIterable<Record<string, unknown>>) {
    const type = chunk.type
    if (type === 'text-delta') {
      if (typeof chunk.text === 'string') text += chunk.text
      if (typeof chunk.index === 'number') deltaIndexes.add(chunk.index)
    } else if (type === 'reasoning-delta') {
      if (typeof chunk.text === 'string') reasoning += chunk.text
    } else if (type === 'block-end') {
      const block = chunk.block as { type?: string; text?: unknown } | undefined
      const index = typeof chunk.index === 'number' ? chunk.index : -1
      // An assembled text block is a fallback, never a duplicate of deltas.
      if (block?.type === 'text' && typeof block.text === 'string' && !deltaIndexes.has(index)) {
        text += block.text
      }
    } else if (type === 'usage') {
      const u = (chunk.usage ?? {}) as Record<string, number | undefined>
      usage.inputTokens = u.inputTokens ?? 0
      usage.outputTokens = u.outputTokens ?? 0
      usage.reasoningTokens = u.reasoningTokens ?? 0
      usage.totalTokens = (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
        + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
    } else if (type === 'finish') {
      const reason = (chunk.reason ?? {}) as { kind?: string; failure?: { message?: string } }
      finishKind = typeof reason.kind === 'string' ? reason.kind : 'unknown'
      if ((reason.kind === 'error' || reason.kind === 'aborted') && typeof reason.failure?.message === 'string') {
        failure = reason.failure.message
      }
    }
  }

  return { text, reasoning, finishKind, failure, usage }
}

async function callHostLLM(
  deps: ModuleDeps,
  systemPrompt: string,
  userPrompt: string,
  overrides?: { provider?: string; model?: string },
): Promise<{ content: string; usage: HostUsage; rescuedFromReasoning: boolean }> {
  // Resolve the model from the host's default model service.
  const defaultModel = deps.ctx.get('agentDefaultModel') as AgentDefaultModelService | undefined
  const selection = defaultModel?.currentSelection()
  const provider = overrides?.provider ?? selection?.provider ?? ''
  const model = overrides?.model ?? selection?.model ?? ''

  if (!provider || !model) {
    throw new Error('no configured LLM model; set provider/model in agent-default-model settings or pass overrides')
  }

  const llm = deps.ctx.get('llm') as { stream(opts: HostLlmGenerateOptions): AsyncIterable<HostLlmStreamChunk> } | undefined
  if (!llm) {
    throw new Error('LLM service not available on host context')
  }

  const options: HostLlmGenerateOptions = {
    provider,
    model,
    system: systemPrompt,
    // The adapter reads `content` as a block ARRAY; a bare string throws
    // "content.some is not a function" inside the host.
    messages: [{
      id: 'evo-' + Date.now().toString(36),
      role: 'user',
      content: [{ type: 'text', text: userPrompt }],
      source: { kind: 'plugin', plugin: 'dsh-evolution' },
    }],
    maxTokens: 8192,
    // Pin the reasoning level for candidate generation.  Without this a
    // thinking route can spend the whole output budget on deliberation and
    // return an EMPTY answer (measured: 8192/8192 completion tokens went to
    // reasoning, content length 0, finish_reason=length).  That produced a
    // parse failure, an { ok:false } result, and a ~90s call whose failure
    // upstream test guards silently swallowed.  Generation needs a parseable
    // payload, not a long deliberation.
    //
    // 'low' rather than 'none': the router fans out to whichever backend is
    // available and they do NOT agree on the effort scale — 'none' drew
    // HTTP 400 "reasoning_effort 'none' is not supported ... Supported
    // values: [minimal, low, medium, high, xhigh, max]".  'low' is the
    // smallest level every backend in that list accepts.
    reasoningEffort: 'low',
  }

  let outcome = await consumeStream(llm.stream(options))

  if (outcome.failure !== '') {
    throw new Error('LLM call failed (' + outcome.finishKind + '): ' + outcome.failure)
  }

  // A thinking route can spend the entire output budget on reasoning and emit
  // no text. Retry once with a directive before giving up.
  if (outcome.text.trim() === '') {
    const retry = await consumeStream(llm.stream({
      ...options,
      system: systemPrompt + '\n\nIMPORTANT: reply with the JSON object only. No analysis, no preamble, and no markdown fences.',
    }))
    if (retry.failure !== '') {
      throw new Error('LLM call failed on retry (' + retry.finishKind + '): ' + retry.failure)
    }
    if (retry.text.trim() !== '') {
      outcome = retry
    } else if (retry.reasoning.includes('{')) {
      // Last resort: this route sometimes returns the payload inside the
      // reasoning channel. Use it, but report that it was rescued.
      return { content: retry.reasoning, usage: retry.usage, rescuedFromReasoning: true }
    }
  }

  if (outcome.text.trim() === '') {
    throw new Error(
      'the model returned no text (finish=' + outcome.finishKind
      + ', reasoningChars=' + outcome.reasoning.length
      + ', outputTokens=' + outcome.usage.outputTokens
      + ', reasoningTokens=' + outcome.usage.reasoningTokens + ')',
    )
  }

  return { content: outcome.text, usage: outcome.usage, rescuedFromReasoning: false }
}

// ── FileSet validation ──

export function validateCandidateFileSet(fileSet: CandidateFileSet): CandidateValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!fileSet.manifest.name) errors.push('manifest.name is required')
  if (!fileSet.manifest.description) errors.push('manifest.description is required')
  if (!fileSet.manifest.entryPoint) errors.push('manifest.entryPoint is required')
  if (!fileSet.manifest.type) errors.push('manifest.type is required')

  const allFiles = [...fileSet.files, ...fileSet.tests]

  // Preliminary gate only: the FINAL trust boundary is the filesystem writer
  // (materializeArtifact) and the artifact validator. This check shares the
  // plugin-wide containment rule so no module enforces a subtly different one.
  const nominalRoot = '/candidate-files'
  for (const file of allFiles) {
    if (containPath(nominalRoot, file.path) === null) {
      errors.push('path escapes the candidate root: ' + file.path)
    }
    const ext = file.path.split('.').pop()?.toLowerCase()
    const safeExts = ['ts', 'js', 'json', 'md', 'yml', 'yaml', 'txt']
    if (ext && !safeExts.includes(ext)) {
      errors.push('unsupported file type: ' + ext + ' in ' + file.path)
    }
    if (file.path.endsWith('.sh') || file.path.endsWith('.exe')) {
      errors.push('executable artifact not allowed: ' + file.path)
    }
  }

  if (typeof fileSet.manifest.entryPoint === 'string' && fileSet.manifest.entryPoint !== ''
    && containPath(nominalRoot, fileSet.manifest.entryPoint) === null) {
    errors.push('path escapes the candidate root: ' + fileSet.manifest.entryPoint)
  }

  const paths = allFiles.map(f => f.path)
  const dupes = paths.filter((p, i) => paths.indexOf(p) !== i)
  if (dupes.length > 0) errors.push('duplicate files: ' + dupes.join(', '))

  if (!allFiles.some(f => f.path === fileSet.manifest.entryPoint)) {
    warnings.push('entryPoint not found in candidate files')
  }
  if (fileSet.tests.length === 0) warnings.push('no test files provided')
  if (fileSet.manifest.benchmarkCases.length === 0) {
    errors.push('no benchmark cases defined')
  }

  return { valid: errors.length === 0, errors, warnings }
}

// ── JSON parser (handles raw JSON and markdown-wrapped) ──

/**
 * Coerce a parsed object into the file-set shape. Real models return `files`
 * as either an array of {path, content} or a plain path->content map, and may
 * omit `tests` entirely. A single {path, content} OBJECT (not wrapped in an
 * array) is also observed and must yield ONE file, not a two-entry map.
 */
function toFileArray(value: unknown): Array<{ path: string; content: string }> {
  if (Array.isArray(value)) {
    const out: Array<{ path: string; content: string }> = []
    for (const entry of value) {
      if (entry === null || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      if (typeof e.path === 'string') {
        out.push({ path: e.path, content: typeof e.content === 'string' ? e.content : '' })
        continue
      }
      // A path whose VALUE is an object, observed live in a `files` ARRAY:
      // {"path":{"src/index.ts":"IGNORE"},"content":""}. Dropping this entry
      // silently is what turned one model quirk into "no parseable JSON file
      // set" — the first entry was valid but the array lost its identity.
      if (e.path !== null && typeof e.path === 'object' && !Array.isArray(e.path)) {
        for (const [k, v] of Object.entries(e.path as Record<string, unknown>)) {
          if (typeof v === 'string') out.push({ path: k, content: v })
        }
      }
    }
    return out
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    // A lone file descriptor, not a map. Without this the branch below reads
    // the keys 'path' and 'content' as two filenames.
    if (typeof obj.path === 'string') {
      return [{ path: obj.path, content: typeof obj.content === 'string' ? obj.content : '' }]
    }
    // A path whose VALUE is an object is observed live: {"path":
    // {"src/index.ts":"IGNORE"}, "content":""}. The nested keys are the real
    // paths; recover them rather than dropping the whole candidate.
    if (obj.path !== null && typeof obj.path === 'object' && !Array.isArray(obj.path)) {
      const recovered = Object.entries(obj.path as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'string')
        .map(([k, v]) => ({ path: k, content: String(v) }))
      if (recovered.length > 0) return recovered
    }
    return Object.entries(obj)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => ({ path: k, content: v as string }))
  }
  return []
}

/**
 * Find `files`/`tests` arrays even when nested under a wrapper key.
 *
 * Real models sometimes wrap the payload: `{"manifest": {...}, "candidate": {"files": [...]}}`
 * instead of putting `files` at the top level.  The original parser only read
 * `root.files`, so this shape produced an empty file set and a hard parse failure.
 */
function findKeyDeep(obj: Record<string, unknown>, key: string, depth = 0): unknown {
  if (depth > 3) return undefined
  if (key in obj) return obj[key]
  for (const v of Object.values(obj)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const found = findKeyDeep(v as Record<string, unknown>, key, depth + 1)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** De-duplicate files by path, keeping the LAST occurrence (later wins). */
function dedupeFiles(files: Array<{ path: string; content: string }>): Array<{ path: string; content: string }> {
  const byPath = new Map<string, { path: string; content: string }>()
  for (const f of files) byPath.set(f.path, f)
  return [...byPath.values()]
}

function normalizeFileSet(parsed: unknown): CandidateFileSet {
  const root = (parsed ?? {}) as Record<string, unknown>
  const manifest = (root.manifest ?? root) as Record<string, unknown>
  const rawManifest = manifest as unknown as CandidateFileSet['manifest']
  const cases = Array.isArray(manifest.benchmarkCases) ? manifest.benchmarkCases : []

  // files/tests may sit at top level or under a wrapper key (shape B).
  const filesRaw = 'files' in root ? root.files : findKeyDeep(root, 'files')
  const testsRaw = 'tests' in root ? root.tests : findKeyDeep(root, 'tests')

  return {
    manifest: {
      ...rawManifest,
      name: typeof manifest.name === 'string' ? manifest.name : 'candidate',
      version: typeof manifest.version === 'string' ? manifest.version : '1.0.0',
      description: typeof manifest.description === 'string' ? manifest.description : '',
      entryPoint: typeof manifest.entryPoint === 'string' ? manifest.entryPoint : 'src/index.ts',
      benchmarkCases: cases as CandidateFileSet['manifest']['benchmarkCases'],
    },
    files: dedupeFiles(toFileArray(filesRaw)),
    tests: dedupeFiles(toFileArray(testsRaw)),
  }
}

/** Remove trailing commas that some models emit, without touching strings. */
function stripTrailingCommas(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (escaped) { out += ch; escaped = false; continue }
    if (ch === '\\') { out += ch; escaped = true; continue }
    if (ch === '"') { inString = !inString; out += ch; continue }
    if (!inString && ch === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j += 1
      if (text[j] === '}' || text[j] === ']') continue
    }
    out += ch
  }
  return out
}

/**
 * Escape sequences JSON actually accepts. Anything else after a backslash
 * inside a string is a hard parse error.
 */
const VALID_JSON_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u'])

/**
 * Repair backslash escapes that JSON does not accept.
 *
 * Measured on a live model response: a TypeScript payload emitted `\order?`
 * and `\n` sequences inside a JSON string, where `\o` is not a legal JSON
 * escape. The document was otherwise complete (`finish_reason: stop`, no
 * truncation) but `JSON.parse` rejected it with
 * "Bad escaped character in JSON at position 1383" — so an entire candidate was
 * lost to one character.
 *
 * A backslash that cannot start a valid escape is a literal backslash in the
 * source the model meant to send, so it is doubled. Valid escapes are left
 * untouched, and a `\` before a quote is always a real escape, never doubled.
 * This only runs as a fallback after the untouched parse already failed.
 */
function repairInvalidEscapes(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (!inString) {
      if (ch === '"') inString = true
      out += ch
      continue
    }
    if (ch === '"') { inString = false; out += ch; continue }
    if (ch !== '\\') { out += ch; continue }
    const next = text[i + 1]
    // Trailing backslash before end-of-input: nothing to escape, keep as-is.
    if (next === undefined) { out += ch; continue }
    // `\u` needs four hex digits. This must be checked BEFORE the generic
    // escape set, because 'u' is itself a valid escape lead: a `\u00zz` would
    // otherwise pass through untouched and fail later as a bad unicode escape
    // with the same fatal result this function exists to prevent.
    if (next === 'u') {
      const hex = text.slice(i + 2, i + 6)
      if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += text.slice(i, i + 6); i += 5; continue }
      out += '\\\\'
      continue
    }
    // Consume the whole escape pair. Emitting only `ch` and advancing by one
    // re-read the second backslash of a valid `\\` pair as a fresh escape lead,
    // so the character after it was doubled into an illegal escape (`\\d` became
    // `\\\d`) and the whole document stopped parsing. Mirrors the `\u` branch
    // above, which already skips its full sequence.
    if (VALID_JSON_ESCAPES.has(next)) { out += ch + next; i += 1; continue }
    out += '\\\\'
  }
  return out
}

/**
 * Repair mismatched brackets in an otherwise-parsable document.
 *
 * Measured live: a response truncated MID-document leaves a `{` open at the
 * point where a `]` arrives (`..."content":"..." ]`) — the closer is owed
 * THERE, not appended at the end, which is why a naive append-only repair
 * still failed to parse.
 *
 * String-aware, so braces inside a file's content never affect the count.
 * On a closer it closes any inner frames left open above the matching opener
 * first (they are owed before this closer can land), and drops a closer with
 * no matching opener at all — an extra one can only be spurious, and keeping
 * it makes the document parse as "trailing content after JSON".
 *
 * A response cut in the middle of a string is missing real content: closing it
 * would invent data, so it is returned unchanged and the caller falls through
 * to the next attempt.
 */
function repairBrackets(text: string): string {
  const stack: string[] = []
  let out = ''
  let inString = false
  let escaped = false
  for (const ch of text) {
    if (inString) {
      out += ch
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    if (ch === '{') { stack.push('}'); out += ch; continue }
    if (ch === '[') { stack.push(']'); out += ch; continue }
    if (ch !== '}' && ch !== ']') { out += ch; continue }
    // Closer: close any frames still open above the matching opener, then
    // pop them along with the closer itself.
    const idx = stack.lastIndexOf(ch)
    if (idx === -1) {
      // Stack already empty: this is not an extra trailing closer — a frame
      // was closed too early and we are seeing its late arrival. Attempting
      // to repair by dropping it would silently mangle the document (observed:
      // a stray `]` after the array closed the root early, leaving the
      // remainder parseable but structurally wrong). Abort and fall through
      // to the retry path in callHostLLM.
      return text
    }
    for (let k = stack.length - 1; k > idx; k -= 1) out += stack[k]!
    out += ch
    stack.length = idx
  }
  if (inString) return text
  while (stack.length > 0) out += stack.pop()!
  return out
}

/**
 * Cheap structural gate: detect the unrepairable shapes that the live runs
 * actually produced, so the caller can retry fast instead of after the whole
 * repair ladder.
 *
 * Per candidate the scan is string-aware:
 *  - ends inside an open string (inString=true at end of input) → shape 2;
 *  - sees an extra closer (stack empty on a `}`/`]`) → shape 3;
 *  - sees an UNESCAPED `"` that does not cleanly terminate the enclosing
 *    string context — that is shape 1 and JSON.parse will reject it as
 *    "unterminated string" or "expected property name".
 *
 * Returns the diagnosis as a message suffix, or null when every candidate is
 * structurally clean.
 */
function diagnoseResponseShape(response: string): string | null {
  if (response === '') return null
  let inString = false
  let escaped = false
  const stack: string[] = []
  let extraCloser = false
  for (const ch of response) {
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') { stack.push('}'); continue }
    if (ch === '[') { stack.push(']'); continue }
    if (ch === '}' || ch === ']') {
      const idx = stack.lastIndexOf(ch)
      if (idx === -1) { extraCloser = true; continue }
      stack.length = idx
    }
  }
  if (inString) {
    return 'response truncated inside a string — closing it would invent data; retrying'
  }
  if (extraCloser) {
    return 'response has an extra `}` or `]` with no matching opener — structural damage; retrying'
  }
  // Balanced, no extra closers, not truncated — shape 1 may still be present
  // (an unescaped quote that happens to land right before a valid closer).
  // That is JSON.parse's job; the ladder already handles it.
  return null
}

/**
 * Slice out the first COMPLETE JSON object using a string-aware brace scan.
 *
 * Measured live: a response ended `..."}]}\n  }\n}` — a valid object followed by
 * two stray closers. `content.indexOf('{')` … `content.lastIndexOf('}')`
 * therefore spans PAST the end of the object, and JSON.parse rejects the whole
 * thing with "Unexpected non-whitespace character after JSON at position
 * 5662". Scanning for the frame that actually closes at depth 0 recovers the
 * real object (measured: parses with 2 files).
 *
 * Returns null when the document is never balanced, which is the truncation
 * case the pre-flight gate reports instead.
 */
function extractFirstCompleteObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let inString = false
  let escaped = false
  let depth = 0
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Extract a candidate file set from a model response.
 */
export function parseFileSetFromLLMResponse(content: string): CandidateFileSet {
  const attempts: string[] = []
  const trimmed = content.trim()
  if (trimmed !== '') attempts.push(trimmed)

  for (const fence of content.matchAll(/```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)```/g)) {
    if (fence[1] && fence[1].trim() !== '') attempts.push(fence[1].trim())
  }

  const firstBrace = content.indexOf('{')
  const lastBrace = content.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    attempts.push(content.slice(firstBrace, lastBrace + 1))
  }

  // A string-aware brace scan for the first COMPLETE object. Measured live:
  // a valid object followed by two stray closers — the slice above runs
  // past the object's end and JSON.parse rejects it; this recovers it.
  const complete = extractFirstCompleteObject(content)
  if (complete !== null && !attempts.includes(complete)) {
    attempts.push(complete)
  }

  // PRE-FLIGHT: reject an unrepairable document before running the repair
  // ladder. Measured on 40 live runs, every failure was one of three shapes,
  // and none is repairable by string surgery:
  //   1. an unescaped `"` inside a content string (the model writes \", so
  //      the JSON string ends early and the rest becomes garbage);
  //   2. a response cut mid-STRING or mid-structure (real content is missing
  //      — closing it would invent data);
  //   3. extra or misplaced closers.
  // The diagnosis runs over the WHOLE response, not over a slice: a
  // truncated document has no trailing `}`, so the brace-balanced attempt is
  // a shorter slice that ends inside the manifest and looks perfectly
  // balanced — reading it instead of the response would miss the truncation.
  const shapeProblem = diagnoseResponseShape(trimmed)
  if (shapeProblem !== null) {
    const head = content.trim().slice(0, 200).replace(/\s+/g, ' ')
    throw new Error(
      shapeProblem + ' (length ' + content.length + '); head: ' + head,
    )
  }

  // Repair ladder, cheapest and least-invasive first. Bracket repair is last
  // because it is the only variant that infers something the model did not
  // send, so an intact response must never depend on it.
  const repairs = [
    (s: string) => s,
    stripTrailingCommas,
    repairInvalidEscapes,
    (s: string) => repairInvalidEscapes(stripTrailingCommas(s)),
    repairBrackets,
    (s: string) => repairBrackets(stripTrailingCommas(s)),
    (s: string) => repairBrackets(repairInvalidEscapes(s)),
    (s: string) => repairBrackets(repairInvalidEscapes(stripTrailingCommas(s))),
  ]

  for (const attempt of attempts) {
    for (const repair of repairs) {
      try {
        const parsed = JSON.parse(repair(attempt))
        const fileSet = normalizeFileSet(parsed)
        if (fileSet.files.length > 0) return fileSet
      } catch {
        // try the next shape
      }
    }
  }

  const head = content.trim().slice(0, 200).replace(/\s+/g, ' ')
  throw new Error(
    'no parseable JSON file set in the model response (length ' + content.length
    + '); head: ' + head,
  )
}

// ── Prompts ──

/**
 * Generation prompt, tightened against the failure shapes measured live.
 *
 * Measured over 20 live runs against the rotating 9Router backends
 * (baseline, before this change): ~15% parse failures. Reading the captured
 * bytes showed THREE distinct causes, and only one of them was "bad JSON":
 *
 *   1. finish_reason=length at 8192/8192 tokens (2 of 3 captured failures).
 *      The model spent the whole budget and was cut off MID-STRING. Not a
 *      JSON defect at all — a SIZE defect. The original prompt never said
 *      how big the answer should be, so a backend that elaborated tests and
 *      JSDoc ran out of room. Hence the explicit budget below.
 *   2. structural drift (1 of 3): the model emitted a different shape, e.g.
 *      `{"name":"compareIds","signature":...}` where a {path, content}
 *      entry was required.
 *   3. genuinely malformed JSON: an unescaped `"` inside a content string.
 *
 * So the rules below are ordered by what the measurements said mattered:
 * size first, shape second, escaping third.
 */
function buildSystemPrompt(): string {
  return [
    'You generate one candidate improvement module for DSH, returned as a single JSON object.',
    '',
    'OUTPUT BUDGET — read this first:',
    'The entire response must stay UNDER 3000 characters.',
    'Write ONE source file and ONE test file. Keep each under 25 lines.',
    'No JSDoc blocks, no banner comments, no extra helper files, no second',
    'test file, no "type"/"interface" ceremony beyond what the code needs.',
    'A terse correct module beats a thorough one that gets cut off mid-string.',
    '',
    'The response must be EXACTLY this JSON shape and nothing else:',
    '{"manifest":{"name":"kebab-case-name","version":"1.0.0","type":"verification-strategy",',
    '"description":"one short sentence","entryPoint":"src/index.ts",',
    '"benchmarkCases":[{"id":"case-1","description":"d","input":"i",',
    '"expectedOutput":"o","expectedExitCode":0,"timeoutMs":10000,',
    '"successCriteria":"s"}]},',
    '"files":[{"path":"src/index.ts","content":"..."}],',
    '"tests":[{"path":"test/index.spec.ts","content":"..."}]}',
    '',
    'HARD RULES — each one is a failure shape observed in real responses:',
    '1. Output the JSON object and NOTHING else. No prose before or after it.',
    '   Do not restate these rules: a stray quote in the restatement is enough',
    '   to end the JSON string early.',
    '2. Every "content" value is a plain JSON string. Never embed a JavaScript',
    '   expression, a .replace() call, or template-literal syntax there — a',
    '   real response did, and it is unrecoverable.',
    '3. Inside a content string, every double quote MUST be written as \\" and',
    '   every backslash as \\\\ . An unescaped quote ends the string early.',
    '4. files and tests are arrays of objects with EXACTLY the keys "path" and',
    '   "content" (both strings). No extra keys, no nested objects, no',
    '   signature/type/name descriptors.',
    '5. No trailing commas, no comments, no duplicate keys anywhere.',
    '6. Paths are relative, start with src/ or test/, end in .ts, and contain',
    '   neither ../ nor a leading /.',
    '7. manifest.type is exactly one of: policy, workflow, skill, routing-rule,',
    '   verification-strategy, retry-strategy, tool-selection-rule.',
    '8. manifest.entryPoint names one of the paths in "files".',
    '',
    'Respond now with only the JSON object.',
  ].join('\n')
}

function buildUserPrompt(patterns: Pattern[], experiences: ExperienceRecord[], parentVersion: string): string {
  // Aggressive compression: cap patterns to top-3 by confidence, limit failures
  // to 3 lines, clamp each line to 100 chars. A global 1200-char hard cap keeps
  // the prompt small enough that even the slowest backend parses within budget
  // without truncating mid-string — the primary cause of parse failures.
  const clamp = (s: string) => (s.length > 100 ? s.slice(0, 97) + '...' : s)
  const sortedPatterns = [...patterns].sort((a, b) => b.confidence - a.confidence).slice(0, 3)
  const patternSummary = sortedPatterns.map(p =>
    '- Pattern ' + p.id + ' (' + p.type + '): ' + clamp(p.description) + ' (occ: ' + p.occurrences + ')'
  ).join('\n')
  const recentFailures = experiences.filter(e => !e.success).slice(0, 3).map(e =>
    '- Task ' + clamp(e.taskId ?? 'unknown') + ': ' + clamp(e.summary ?? e.prompt ?? 'no summary') + ' | errors: ' + clamp((e.errors ?? []).join(', '))
  ).join('\n')

  let prompt = 'Parent version: ' + parentVersion + '\n\nOBSERVED PATTERNS:\n' + patternSummary + '\n\nRECENT FAILURES:\n' + (recentFailures || '(none)') + '\n\nGenerate a candidate module that addresses the observed patterns.'
  // Hard global cap: truncate from the end if the prompt exceeds the budget.
  // Truncating mid-pattern would lose signal; truncating the footer is safe.
  if (prompt.length > 1200) prompt = prompt.slice(0, 1197) + '...'
  return prompt
}

// ── Tool definition ──

export function builderTools(deps: ModuleDeps): ToolDefinition[] {
  const store = deps.store

  return [
    defineTool({
      name: 'evo_builder_generate',
      description: 'Use the configured DSH LLM to generate a candidate module from observed patterns and experiences. The LLM generates source files, tests, manifest, and benchmark cases. Generated files are validated for safety before acceptance. The LLM endpoint is read from the host agent-default-model settings; pass provider/model overrides for testing.',
      parameters: {
        type: 'object',
        properties: {
          patternIds: { type: 'array', items: { type: 'string' }, description: 'Pattern ids to base the candidate on.' },
          parentVersion: { type: 'string', description: 'Version to build against, e.g. v1.' },
          providerOverride: { type: 'string', description: 'Optional provider override (default: host agent-default-model).' },
          modelOverride: { type: 'string', description: 'Optional model override (default: host agent-default-model).' },
        },
        required: ['patternIds', 'parentVersion'],
      },
      output: { schema: JSON_OBJECT_OUTPUT, render: (_a: Record<string, unknown>, v: never) => text(v) },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>

        // Fetch patterns and supporting experiences
        const patternIds = (a.patternIds as string[]) ?? []
        const allPatterns = await store.listPatterns(500)
        const patterns = allPatterns.filter(p => patternIds.includes(p.id))

        if (patterns.length === 0) {
          return neutralizeDeep({ ok: false, error: 'no matching patterns found' })
        }

        const experiences = await store.listExperiences(50)
        const systemPrompt = buildSystemPrompt()
        const userPrompt = buildUserPrompt(patterns, experiences, String(a.parentVersion))

        // Call the host LLM
        let llmResponse: { content: string; usage: HostUsage; rescuedFromReasoning: boolean }
        try {
          llmResponse = await callHostLLM(deps, systemPrompt, userPrompt, {
            provider: a.providerOverride as string | undefined,
            model: a.modelOverride as string | undefined,
          })
        } catch (error) {
          return neutralizeDeep({ ok: false, error: 'LLM call failed: ' + (error instanceof Error ? error.message : String(error)) })
        }

        // Parse response. On a parse failure, the model emitted something that
        // no amount of string repair can make valid — observed live: a JS
        // expression where a JSON string was required ("src/index.ts".replace(
        // …)). Retrying once with the original prompt is the robust path: the
        // backend rotates, so a second call often produces a clean document.
        let fileSet: CandidateFileSet
        let lastParseError: string = ''
        try {
          fileSet = parseFileSetFromLLMResponse(llmResponse.content)
        } catch (error) {
          lastParseError = error instanceof Error ? error.message : String(error)
          // Retry once with the same prompt.
          let retry: { content: string; usage: HostUsage; rescuedFromReasoning: boolean }
          try {
            retry = await callHostLLM(deps, systemPrompt, userPrompt, {
              provider: a.providerOverride as string | undefined,
              model: a.modelOverride as string | undefined,
            })
          } catch (rErr) {
            return neutralizeDeep({ ok: false, error: 'LLM retry failed: ' + (rErr instanceof Error ? rErr.message : String(rErr)) })
          }
          try {
            fileSet = parseFileSetFromLLMResponse(retry.content)
          } catch (rErr) {
            const retryMsg = rErr instanceof Error ? rErr.message : String(rErr)
            return neutralizeDeep({
              ok: false,
              error: 'Failed to parse LLM response (both attempts failed)',
              firstAttempt: lastParseError,
              retryAttempt: retryMsg,
            })
          }
        }

        // Validate
        const validation = validateCandidateFileSet(fileSet)
        if (!validation.valid) {
          return neutralizeDeep({ ok: false, error: 'Candidate validation failed', errors: validation.errors })
        }

        // Populate candidate.evidenceIds by resolving the experience IDs
        // referenced by each matched pattern. patternIds stay as-is; only
        // evidenceIds carries experience IDs.
        const resolvedEvidenceIds = new Set<string>()
        for (const p of patterns) {
          if (Array.isArray(p.evidenceIds)) {
            for (const eid of p.evidenceIds) {
              if (typeof eid === 'string' && eid !== '') resolvedEvidenceIds.add(eid)
            }
          }
        }

        // Store the candidate FIRST: the store is the id authority, and the
        // on-disk directory must be candidates/<candidate-id>/ — a locally
        // invented directory name would diverge from the id every later tool
        // resolves by.
        const candidate = await store.addCandidate({
          parentVersion: String(a.parentVersion),
          type: fileSet.manifest.type,
          name: fileSet.manifest.name,
          description: fileSet.manifest.description,
          reason: 'LLM-generated from patterns: ' + patterns.map(p => p.id).join(', '),
          evidenceIds: [...resolvedEvidenceIds],
          patternIds,
          files: fileSet.files,
          tests: fileSet.tests,
          benchmarkConfig: {
            successRate: { min: 0.8, weight: 1 },
            avgScore: { min: 0.7, weight: 1 },
            errorRate: { max: 0.2, weight: 1 },
            avgSteps: { max: 50, weight: 0.5 },
            avgDurationMs: { max: 60000, weight: 0.5 },
          },
          status: 'draft',
        })

        const candidatesDir = join(store.getRoot(), 'candidates', candidate.id)
        await mkdir(candidatesDir, { recursive: true })
        // Final boundary for THIS writer: resolve every target through the
        // shared containment rule before any per-file directory is created,
        // so an escaping path cannot produce even a partial outside write.
        const targets: Array<{ target: string; content: string }> = []
        for (const file of [...fileSet.files, ...fileSet.tests]) {
          const target = containPath(candidatesDir, file.path)
          if (target === null) {
            return neutralizeDeep({ ok: false, error: 'candidate path escapes the candidate directory: ' + file.path })
          }
          targets.push({ target, content: file.content })
        }
        for (const { target, content } of targets) {
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, content, 'utf8')
        }
        await writeFile(join(candidatesDir, 'manifest.json'), JSON.stringify(fileSet.manifest, null, 2), 'utf8')

        return neutralizeDeep({
          ok: true,
          candidateId: candidate.id,
          filesDir: candidatesDir,
          files: fileSet.files.map(f => f.path),
          tests: fileSet.tests.map(f => f.path),
          manifest: fileSet.manifest,
          validation,
          llmUsage: llmResponse.usage,
          rescuedFromReasoning: llmResponse.rescuedFromReasoning,
        })
      },
    } as never),
  ]
}
