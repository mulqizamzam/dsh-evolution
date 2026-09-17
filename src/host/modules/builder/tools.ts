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

function validateCandidateFileSet(fileSet: CandidateFileSet): CandidateValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!fileSet.manifest.name) errors.push('manifest.name is required')
  if (!fileSet.manifest.description) errors.push('manifest.description is required')
  if (!fileSet.manifest.entryPoint) errors.push('manifest.entryPoint is required')
  if (!fileSet.manifest.type) errors.push('manifest.type is required')

  const allFiles = [...fileSet.files, ...fileSet.tests]

  for (const file of allFiles) {
    if (file.path.includes('..')) errors.push('path traversal in: ' + file.path)
    if (file.path.startsWith('/')) errors.push('absolute path: ' + file.path)
    const ext = file.path.split('.').pop()?.toLowerCase()
    const safeExts = ['ts', 'js', 'json', 'md', 'yml', 'yaml', 'txt']
    if (ext && !safeExts.includes(ext)) {
      errors.push('unsupported file type: ' + ext + ' in ' + file.path)
    }
    if (file.path.endsWith('.sh') || file.path.endsWith('.exe')) {
      errors.push('executable artifact not allowed: ' + file.path)
    }
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
 * omit `tests` entirely.
 */
function toFileArray(value: unknown): Array<{ path: string; content: string }> {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
      .filter(entry => typeof entry.path === 'string')
      .map(entry => ({ path: String(entry.path), content: typeof entry.content === 'string' ? entry.content : '' }))
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => ({ path: k, content: v as string }))
  }
  return []
}

function normalizeFileSet(parsed: unknown): CandidateFileSet {
  const root = (parsed ?? {}) as Record<string, unknown>
  const manifest = (root.manifest ?? root) as Record<string, unknown>
  const rawManifest = manifest as unknown as CandidateFileSet['manifest']
  const cases = Array.isArray(manifest.benchmarkCases) ? manifest.benchmarkCases : []
  return {
    manifest: {
      ...rawManifest,
      name: typeof manifest.name === 'string' ? manifest.name : 'candidate',
      version: typeof manifest.version === 'string' ? manifest.version : '1.0.0',
      description: typeof manifest.description === 'string' ? manifest.description : '',
      entryPoint: typeof manifest.entryPoint === 'string' ? manifest.entryPoint : 'src/index.ts',
      benchmarkCases: cases as CandidateFileSet['manifest']['benchmarkCases'],
    },
    files: toFileArray(root.files),
    tests: toFileArray(root.tests),
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
 * Extract a candidate file set from a model response. Models wrap JSON in
 * prose or fences, so try, in order: the raw text, every fenced block, and the
 * outermost brace-balanced span — each with and without trailing-comma repair.
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

  for (const attempt of attempts) {
    for (const variant of [attempt, stripTrailingCommas(attempt)]) {
      try {
        const parsed = JSON.parse(variant)
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

function buildSystemPrompt(): string {
  return 'You are an expert DSH plugin developer. Generate a candidate improvement module.\n\nYou MUST return a single JSON object with this exact shape:\n{\n  "manifest": {\n    "name": "short-name",\n    "version": "1.0.0",\n    "type": "<one of: policy, workflow, skill, routing-rule, verification-strategy, retry-strategy, tool-selection-rule>",\n    "description": "what this module does",\n    "entryPoint": "src/index.ts",\n    "benchmarkCases": [\n      {\n        "id": "case-1",\n        "description": "test case description",\n        "input": "the test input",\n        "expectedOutput": "regex pattern or exact string",\n        "expectedExitCode": 0,\n        "timeoutMs": 10000,\n        "successCriteria": "what success looks like"\n      }\n    ]\n  },\n  "files": [\n    { "path": "src/index.ts", "content": "..." }\n  ],\n  "tests": [\n    { "path": "test/index.spec.ts", "content": "..." }\n  ]\n}\n\nRULES:\n- Files MUST use .ts or .js extension only\n- Paths MUST be relative (no leading /)\n- No path traversal (no ../)\n- Include at least one benchmark case\n- Include at least one test file\n- The module must be self-contained\n- Do NOT attempt to modify DSH core or other plugins\n- The entryPoint must exist in the files array\n\nReturn ONLY the JSON object. No markdown. No explanation.'
}

function buildUserPrompt(patterns: Pattern[], experiences: ExperienceRecord[], parentVersion: string): string {
  const patternSummary = patterns.map(p =>
    '- Pattern ' + p.id + ' (' + p.type + '): ' + p.description + ' (occurrences: ' + p.occurrences + ', confidence: ' + p.confidence + ')'
  ).join('\n')
  const recentFailures = experiences.filter(e => !e.success).slice(0, 10).map(e =>
    '- Task ' + (e.taskId ?? 'unknown') + ': ' + (e.summary ?? e.prompt ?? 'no summary') + ' | errors: ' + (e.errors ?? []).join(', ')
  ).join('\n')

  return 'Parent version: ' + parentVersion + '\n\nOBSERVED PATTERNS:\n' + patternSummary + '\n\nRECENT FAILURES:\n' + (recentFailures || '(none)') + '\n\nGenerate a candidate module that addresses the observed patterns. The module should propose a concrete improvement to reduce the failure rate or improve efficiency.'
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

        // Parse response
        let fileSet: CandidateFileSet
        try {
          fileSet = parseFileSetFromLLMResponse(llmResponse.content)
        } catch (error) {
          return neutralizeDeep({ ok: false, error: 'Failed to parse LLM response: ' + (error instanceof Error ? error.message : String(error)) })
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
        for (const file of [...fileSet.files, ...fileSet.tests]) {
          const filePath = join(candidatesDir, file.path)
          await mkdir(dirname(filePath), { recursive: true })
          await writeFile(filePath, file.content, 'utf8')
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
