/**
 * Regression tests for the host LLM call the builder makes.
 *
 * Found by LIVE runs against the configured model:
 *  1. "content.some is not a function" — the request passed `content` as a
 *     string, but the host adapter iterates it as a ContentBlock[].
 *  2. An empty/error finish silently produced '' and surfaced as an unrelated
 *     parse error.
 *  3. TokenUsage uses input/output naming, not prompt/completion.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { ModuleDeps, HostLlmGenerateOptions } from '../src/host/types.ts'
import type { HostContextShape } from '../src/host/dsh.ts'

/** Capture every request the builder sends to the host LLM. */
const captured: HostLlmGenerateOptions[] = []

function makeCtx(chunks: unknown[]): HostContextShape {
  return {
    tools: { register: () => {} },
    settings: { writable: true, register: () => ({ get: () => ({}) }) },
    agents: { get: () => undefined, roots: () => [] },
    get: (name: string) => {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test-route', model: 'test-model' }) }
      if (name === 'llm') {
        return {
          stream: async function* (options: HostLlmGenerateOptions) {
            captured.push(options)
            for (const chunk of chunks) yield chunk
          },
        }
      }
      return undefined
    },
    on: () => () => {},
    effect: () => () => {},
  }
}

function makeDeps(store: EvolutionStore, root: string, ctx: HostContextShape): ModuleDeps {
  return { ctx, cfg: () => resolveConfig({ stateRoot: root }), store, log: () => {}, warn: () => {} }
}

const GOOD_JSON = JSON.stringify({
  manifest: {
    name: 'm', version: '1.0.0', type: 'policy', description: 'd', entryPoint: 'src/index.ts',
    benchmarkCases: [{ id: 'c1', description: 'd', input: 'i', timeoutMs: 1000, successCriteria: 's' }],
  },
  files: [{ path: 'src/index.ts', content: 'export const x = 1' }],
  tests: [{ path: 'test/a.spec.ts', content: 't' }],
})

async function runBuilder(ctx: HostContextShape, root: string, store: EvolutionStore) {
  await store.addPattern({ type: 'failure', evidence: 'INFERENCE', description: 'p', occurrences: 3, evidenceIds: [], confidence: 0.7 })
  const pattern = (await store.listPatterns())[0]
  const { builderTools } = await import('../src/host/modules/builder/tools.ts')
  const tool = builderTools(makeDeps(store, root, ctx)).find(t => t.name === 'evo_builder_generate')!
  return await tool.execute({ patternIds: [pattern.id], parentVersion: 'v1' } as never, { signal: AbortSignal.timeout(10_000) }) as Record<string, unknown>
}

describe('builder LLM request shape', () => {
  let tmpRoot: string
  let store: EvolutionStore

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-llmcall-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
    captured.length = 0
  })

  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  it('sends content as a block ARRAY, never a bare string', async () => {
    const ctx = makeCtx([
      { type: 'text-delta', index: 0, text: GOOD_JSON },
      { type: 'usage', index: 0, usage: { inputTokens: 10, outputTokens: 20 } },
      { type: 'finish', index: 0, reason: { kind: 'stop' } },
    ])
    const result = await runBuilder(ctx, tmpRoot, store)
    expect(result.ok).toBe(true)

    expect(captured).toHaveLength(1)
    const message = captured[0].messages[0]
    expect(Array.isArray(message.content)).toBe(true)
    expect(message.content[0]).toEqual({ type: 'text', text: expect.any(String) })
    expect(message.role).toBe('user')
    expect(message.id).toBeTruthy()
    expect(message.source).toBeDefined()
  })

  it('reports usage with input/output naming plus a computed total', async () => {
    const ctx = makeCtx([
      { type: 'text-delta', index: 0, text: GOOD_JSON },
      { type: 'usage', index: 0, usage: { inputTokens: 123, outputTokens: 456 } },
      { type: 'finish', index: 0, reason: { kind: 'stop' } },
    ])
    const result = await runBuilder(ctx, tmpRoot, store) as { llmUsage: { inputTokens: number; outputTokens: number; totalTokens: number } }
    expect(result.llmUsage.inputTokens).toBe(123)
    expect(result.llmUsage.outputTokens).toBe(456)
    expect(result.llmUsage.totalTokens).toBe(579)
  })

  it('surfaces a terminal LLM failure instead of an empty response', async () => {
    const ctx = makeCtx([
      { type: 'finish', index: 0, reason: { kind: 'error', failure: { message: 'upstream exploded' } } },
    ])
    const result = await runBuilder(ctx, tmpRoot, store) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('upstream exploded')
  })

  it('retries once with a directive when the model emits only reasoning', async () => {
    // First call: reasoning only, no text. Second call: valid JSON.
    let call = 0
    const ctx = {
      tools: { register: () => {} },
      settings: { writable: true, register: () => ({ get: () => ({}) }) },
      agents: { get: () => undefined, roots: () => [] },
      get: (name: string) => {
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        if (name === 'llm') {
          return {
            stream: async function* (options: HostLlmGenerateOptions) {
              captured.push(options)
              call += 1
              if (call === 1) {
                yield { type: 'reasoning-delta', index: 0, text: 'thinking hard...' }
                yield { type: 'finish', index: 0, reason: { kind: 'max-tokens' } }
              } else {
                yield { type: 'text-delta', index: 0, text: GOOD_JSON }
                yield { type: 'finish', index: 0, reason: { kind: 'stop' } }
              }
            },
          }
        }
        return undefined
      },
      on: () => () => {},
      effect: () => () => {},
    } as HostContextShape

    const result = await runBuilder(ctx, tmpRoot, store) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(captured).toHaveLength(2)
    expect(captured[1].system).toContain('reply with the JSON object only')
  })

  it('writes candidate files into candidates/<candidateId>/ so the directory matches the id', async () => {
    const ctx = makeCtx([
      { type: 'text-delta', index: 0, text: GOOD_JSON },
      { type: 'finish', index: 0, reason: { kind: 'stop' } },
    ])
    const result = await runBuilder(ctx, tmpRoot, store) as { ok: boolean; candidateId: string; filesDir: string }

    expect(result.ok).toBe(true)
    // The returned directory must be exactly candidates/<candidateId>.
    expect(result.filesDir).toBe(join(tmpRoot, 'candidates', result.candidateId))

    const { readFile, access } = await import('node:fs/promises')
    await access(join(tmpRoot, 'candidates', result.candidateId, 'src/index.ts'))
    await access(join(tmpRoot, 'candidates', result.candidateId, 'manifest.json'))
    const written = await readFile(join(tmpRoot, 'candidates', result.candidateId, 'src/index.ts'), 'utf8')
    expect(written).toContain('export const x = 1')
  })

  it('reports diagnostics when every attempt returns no text', async () => {
    const ctx = makeCtx([
      { type: 'reasoning-delta', index: 0, text: 'only thinking, no json' },
      { type: 'finish', index: 0, reason: { kind: 'max-tokens' } },
    ])
    const result = await runBuilder(ctx, tmpRoot, store) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('returned no text')
    expect(result.error).toContain('reasoningChars=')
  })
})
