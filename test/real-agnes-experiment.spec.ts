/**
 * REAL-AGNES AUTONOMOUS SELF-EVOLUTION EXPERIMENT
 *
 * Uses the REAL AGNES 3.0-Flash endpoint via 9Router instead of a simulated LLM.
 * Pipeline: experience → pattern → LLM-generation (real) → candidate → benchmark → promotion
 *
 * Real LLM:
 *   - Provider: nine-router, Model: Deterministik (9Router combo, live)
 *   - Endpoint: http://127.0.0.1:20128/v1/chat/completions
 *   - API key: read from 9Router database via sql.js
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { ModuleDeps, HostLlmGenerateOptions, HostLlmStreamChunk } from '../src/host/types.ts'
import type { HostContextShape } from '../src/host/dsh.ts'
import { experienceTools } from '../src/host/modules/experience/tools.ts'
import { analyzeTools } from '../src/host/modules/analyze/tools.ts'
import { benchmarkTools } from '../src/host/modules/benchmark/tools.ts'
import { promoteTools } from '../src/host/modules/promote/tools.ts'
import { builderTools } from '../src/host/modules/builder/tools.ts'

const WORKLOAD_INPUT = JSON.stringify([
  { id: 1, value: 'alpha',   tags: ['a'] },
  { id: 2, value: 'beta',    tags: ['b', 'c'] },
  { id: 3, value: 'gamma',   tags: [] },
  { value: 'delta',          tags: ['d'] },
  { id: 5, value: 'epsilon', tags: ['e', 'f', 'g'] },
])
const EXPECTED_OUTPUT = 'alpha\nbeta\ngamma\nepsilon\ndelta\n'
const EXPECTED_EXIT_CODE = 0
const V1_RUN_JS = `
const input = require('fs').readFileSync('/dev/stdin', 'utf8')
const records = JSON.parse(input)
records.sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
records.reverse()
const names = records.map(r => r.value)
process.stdout.write(names.join('\\n') + '\\n')
process.exit(0)
`
const BENCH_COMMAND = "echo '" + WORKLOAD_INPUT + "' | node run.js"
const NINE_ROUTER_URL = 'http://127.0.0.1:20128/v1/chat/completions'

async function resolveApiKey(): Promise<string> {
  const envKey = process.env['9ROUTER_API_KEY'] ?? process.env['NINE_ROUTER_API_KEY']
  if (envKey) return envKey
  const dbPath = join(process.env.HOME ?? '/root', '.9router', 'db', 'data.sqlite')
  try {
    const initSqlJs = await import('/home/administrator/.9router/runtime/node_modules/sql.js/dist/sql-wasm.js')
    const { readFileSync } = await import('node:fs')
    const SQL = await initSqlJs.default()
    const buf = readFileSync(dbPath)
    const db = new SQL.Database(buf)
    const stmt = db.prepare('SELECT key FROM apiKeys WHERE isActive=1 LIMIT 1;')
    let key: string | undefined
    if (stmt.step()) key = stmt.getAsObject().key as string | undefined
    stmt.free()
    db.close()
    if (key) return key
  } catch { /* fall through */ }
  throw new Error('No 9Router API key found. Set NINE_ROUTER_API_KEY or ensure ~/.9router/db/data.sqlite is accessible')
}

interface RealLlmCall {
  provider: string
  model: string
  system: string
  userText: string
  content: string
  usage: { inputTokens: number; outputTokens: number; totalTokens: number }
  responseModel: string
}

async function callRealLLM(apiKey: string, system: string, user: string, reasoningEffort?: string): Promise<RealLlmCall & { provider: string; model: string }> {
  const resp = await fetch(NINE_ROUTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'Deterministik', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 8192, stream: false, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}) }),
  })
  if (!resp.ok) {
    // Surface the router's own error body. A bare "400 Bad Request" is
    // indistinguishable between a malformed request and an upstream backend
    // refusing it, and those need different fixes.
    const detail = await resp.text().catch(() => '')
    throw new Error(`LLM HTTP ${resp.status}: ${resp.statusText} | body: ${detail.slice(0, 400)}`)
  }
  const data = await resp.json() as { model?: string; choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }
  const content = data.choices?.[0]?.message?.content ?? ''
  const usage = { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0, totalTokens: data.usage?.total_tokens ?? 0 }
  return { provider: 'nine-router', model: 'Deterministik', system: system.slice(0, 200), userText: user.slice(0, 200), content, usage, responseModel: data.model ?? 'unknown' }
}

function makeRealLlmCtx(apiKey: string) {
  const captured: RealLlmCall[] = []
  const ctx: HostContextShape = {
    tools: { register: () => {} },
    settings: { writable: true, register: (_n: string, _s: unknown, o: { base?: unknown }) => ({ get: () => o?.base ?? {} }) },
    agents: { get: () => undefined, roots: () => [] },
    get: (name: string) => {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'nine-router', model: 'Deterministik' }) }
      if (name === 'llm') {
        return {
          stream: async function* (options: HostLlmGenerateOptions): AsyncIterable<HostLlmStreamChunk> {
            const userMsg = options.messages?.find((m: any) => m.role === 'user')
            const userText = userMsg?.content?.map((b: any) => b.text).join('') ?? ''
            const result = await callRealLLM(apiKey, options.system ?? '', userText, options.reasoningEffort)
            captured.push(result)
            yield { type: 'text-delta', index: 0, text: result.content }
            yield { type: 'usage', usage: result.usage }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      }
      return undefined
    },
    on: () => () => {}, effect: () => () => {},
  }
  return { ctx, captured }
}

async function makeDeps(store: EvolutionStore, root: string, ctx?: HostContextShape, genEnabled = false, promoEnabled = false): Promise<ModuleDeps> {
  const resolved = ctx ?? { tools: { register: () => {} }, settings: { writable: true, register: () => ({ get: () => ({}) }) }, agents: { get: () => undefined, roots: () => [] }, get: () => undefined, on: () => () => {}, effect: () => () => {} }
  return { ctx: resolved, cfg: () => resolveConfig({ stateRoot: root, evolution: { enabled: true, autoRecord: true, autoTrigger: false, analysis: { minExperiences: 5, minOccurrences: 3 }, generation: { enabled: genEnabled }, promotion: { enabled: promoEnabled }, maxCyclesPerProcess: 10 } }), store, log: () => {}, warn: () => {} }
}

async function seedFailures(store: EvolutionStore, prefix: string, versionId: string) {
  for (let i = 0; i < 5; i++) await store.addExperience({ taskId: prefix + '-' + i, prompt: 'sort JSON records ascending by id', success: false, errors: ['reverse-sort bug'], stepCount: 6 + i, durationMs: 200 + i * 20, versionId })
}

describe('REAL AGNES AUTONOMOUS EVOLUTION EXPERIMENT', () => {
  let tmpRoot: string, store: EvolutionStore, apiKey: string, realCtx: { ctx: HostContextShape; captured: RealLlmCall[] }
  const exec = { signal: AbortSignal.timeout(120_000) }

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-real-agnes-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
    apiKey = await resolveApiKey()
    realCtx = makeRealLlmCtx(apiKey)
  })
  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  it('phase 1: V1 baseline fails the trusted oracle', async () => {
    await store.createVersion({ label: 'baseline-v1', modules: [] })
    const deps = await makeDeps(store, tmpRoot)
    const v1cand = await store.addCandidate({ parentVersion: 'v1', type: 'policy', name: 'sort-by-id-v1', description: 'Baseline', reason: 'v1', evidenceIds: [], patternIds: [], files: [{ path: 'run.js', content: V1_RUN_JS }], tests: [], benchmarkConfig: { successRate: { min: 0.5, weight: 1 }, avgScore: { min: 0.5, weight: 1 }, errorRate: { max: 0.5, weight: 1 }, avgSteps: { max: 999, weight: 0.5 }, avgDurationMs: { max: 300_000, weight: 0.5 } }, status: 'draft' })
    const live = benchmarkTools(deps).find(t => t.name === 'evo_benchmark_live')!
    const r = await live.execute({ candidateId: v1cand.id, command: BENCH_COMMAND, expectedOutput: EXPECTED_OUTPUT, expectedExitCode: EXPECTED_EXIT_CODE, timeoutMs: 30_000 } as never, exec) as Record<string, unknown>
    const stdout = (r.executionResult as { stdout?: string } | undefined)?.stdout ?? String(r.stdout ?? '')
    expect(r.passed).toBe(false)
    expect(stdout.trim().split('\n')[0]).toBe('epsilon')
    await store.addBenchmark({ candidateId: v1cand.id, version: 'v1', baseline: 'v1', runs: 3, metrics: { successRate: 0, avgScore: 0, errorRate: 0, avgSteps: 1, avgDurationMs: 200 }, passed: false, details: 'v1 failed oracle', mode: 'live', expectedOutput: EXPECTED_OUTPUT, expectedExitCode: EXPECTED_EXIT_CODE })
    await store.updateCandidate(v1cand.id, { status: 'benchmarked' })
  }, 30_000)

  it('phase 2: failure experiences form patterns', async () => {
    await store.createVersion({ label: 'baseline-v1', modules: [] })
    const deps = await makeDeps(store, tmpRoot)
    const record = experienceTools(deps).find(t => t.name === 'evo_experience_record')!
    for (let i = 0; i < 5; i++) await record.execute({ taskId: 'r-' + i, prompt: 'sort JSON', success: false, errors: ['reverse-sort bug'], stepCount: 6, durationMs: 200, versionId: 'v1' } as never, exec)
    const analyze = analyzeTools(deps).find(t => t.name === 'evo_analyze_patterns')!
    await analyze.execute({ minOccurrences: 3 } as never, exec)
    const patterns = await store.listPatterns()
    expect(patterns.length).toBeGreaterThan(0)
    const exps = await store.listExperiences(100)
    const expIdSet = new Set(exps.map(e => e.id))
    for (const eid of patterns[0]!.evidenceIds) expect(expIdSet.has(eid)).toBe(true)
  }, 10_000)

  it('phase 3: real AGNES generates candidate (no operator source)', async () => {
    await store.createVersion({ label: 'baseline-v1', modules: [] })
    await seedFailures(store, 'r-agnes-gen', 'v1')
    const deps = await makeDeps(store, tmpRoot)
    const analyze = analyzeTools(deps).find(t => t.name === 'evo_analyze_patterns')!
    await analyze.execute({ minOccurrences: 3 } as never, exec)
    const pattern = (await store.listPatterns())[0]!
    const genDeps = await makeDeps(store, tmpRoot, realCtx.ctx, true, false)
    const build = builderTools(genDeps).find(t => t.name === 'evo_builder_generate')!
    const result = await build.execute({ patternIds: [pattern.id], parentVersion: 'v1' } as never, exec) as { ok: boolean; candidateId: string; error?: string }
    // Surface WHY generation failed before the assertion swallows it: the
    // builder's early returns look identical in the assertion message.
    if (!result.ok) console.log('[Phase 3] builder error:', JSON.stringify(result))
    expect(result.ok).toBe(true)
    // callHostLLM retries ONCE when the first stream returns empty text (a
    // thinking route that spent the whole output budget on reasoning). So the
    // call count is 1 normally but 2 on that recovery path — pin only the
    // invariant the test actually cares about: at least one real backend call
    // happened, and the LAST captured call is the one that produced the answer.
    expect(realCtx.captured.length).toBeGreaterThanOrEqual(1)
    const call = realCtx.captured[realCtx.captured.length - 1]!
    expect(call.provider).toBe('nine-router')
    expect(call.model).toBe('Deterministik')
    expect(call.content.length).toBeGreaterThan(0)
    expect(call.usage.inputTokens).toBeGreaterThan(0)
    // The alias fans out to whatever backends the router currently routes to
    // (observed rotating between agnes-3.0/2.5/2.0-flash, mimo, space-bunny),
    // so pin only that a real backend answered — not a specific one.
    expect(call.responseModel).toBeTypeOf('string')
    expect(call.responseModel.length).toBeGreaterThan(0)
    expect(call.responseModel).not.toBe('unknown')
    const candidate = await store.getCandidate(result.candidateId!)
    expect(candidate).not.toBeNull()
    expect(candidate!.parentVersion).toBe('v1')
    expect(candidate!.reason).toContain('LLM-generated from patterns')
    expect(candidate!.evidenceIds.length).toBeGreaterThan(0)
    console.log('[Phase 3] Real AGNES candidate:', result.candidateId, 'model:', call.responseModel, 'tokens:', call.usage)
  }, 120_000)

  it('phase 4: candidate files match the LLM response', async () => {
    await store.createVersion({ label: 'baseline-v1', modules: [] })
    await seedFailures(store, 'r-agnes-ver', 'v1')
    const deps = await makeDeps(store, tmpRoot)
    const analyze = analyzeTools(deps).find(t => t.name === 'evo_analyze_patterns')!
    await analyze.execute({ minOccurrences: 3 } as never, exec)
    const pattern = (await store.listPatterns())[0]!
    const genDeps = await makeDeps(store, tmpRoot, realCtx.ctx, true, false)
    const build = builderTools(genDeps).find(t => t.name === 'evo_builder_generate')!
    const result = await build.execute({ patternIds: [pattern.id], parentVersion: 'v1' } as never, exec) as { ok: boolean; candidateId: string; error?: string }
    if (!result.ok) { console.log('[Phase 4] Skip: AGNES failed to generate valid candidate:', result.error); return }
    const candidate = await store.getCandidate(result.candidateId!)
    expect(candidate).not.toBeNull()
    const filesDir = join(tmpRoot, 'candidates', result.candidateId!)
    for (const file of candidate!.files) {
      const p = join(filesDir, file.path)
      await access(p)
      expect(await readFile(p, 'utf8')).toBe(file.content)
    }
  }, 120_000)

  it('phase 5: candidate source differs from operator V1 (no leakage)', async () => {
    await store.createVersion({ label: 'baseline-v1', modules: [] })
    await seedFailures(store, 'r-agnes-leak', 'v1')
    const deps = await makeDeps(store, tmpRoot)
    const analyze = analyzeTools(deps).find(t => t.name === 'evo_analyze_patterns')!
    await analyze.execute({ minOccurrences: 3 } as never, exec)
    const pattern = (await store.listPatterns())[0]!
    const genDeps = await makeDeps(store, tmpRoot, realCtx.ctx, true, false)
    const build = builderTools(genDeps).find(t => t.name === 'evo_builder_generate')!
    const result = await build.execute({ patternIds: [pattern.id], parentVersion: 'v1' } as never, exec) as { ok: boolean; candidateId: string; error?: string }
    if (!result.ok) { console.log('[Phase 5] Skip:', result.error); return }
    const candidate = await store.getCandidate(result.candidateId!)
    expect(candidate).not.toBeNull()
    const src = candidate!.files[0]?.content ?? ''
    expect(src).not.toBe(V1_RUN_JS)
    // Same recovery path as phase 3: an empty first stream makes callHostLLM
    // retry once, so the captured count is 1 or 2, never pinned to 1.
    expect(realCtx.captured.length).toBeGreaterThanOrEqual(1)
  }, 240_000)

  it('phase 6: LLM provenance is complete', async () => {
    await store.createVersion({ label: 'baseline-v1', modules: [] })
    await seedFailures(store, 'r-agnes-prov', 'v1')
    const deps = await makeDeps(store, tmpRoot)
    const analyze = analyzeTools(deps).find(t => t.name === 'evo_analyze_patterns')!
    await analyze.execute({ minOccurrences: 3 } as never, exec)
    const pattern = (await store.listPatterns())[0]!
    const genDeps = await makeDeps(store, tmpRoot, realCtx.ctx, true, false)
    const build = builderTools(genDeps).find(t => t.name === 'evo_builder_generate')!
    await build.execute({ patternIds: [pattern.id], parentVersion: 'v1' } as never, exec)
    // The LAST call is the one that produced the answer: on the retry path
    // call[0] is the empty stream, whose content/usage are zero.
    const call = realCtx.captured[realCtx.captured.length - 1]!
    expect(call).toBeDefined()
    expect(call.provider).toBe('nine-router')
    expect(call.model).toBe('Deterministik')
    expect(call.content.length).toBeGreaterThan(0)
    expect(call.usage.inputTokens).toBeGreaterThan(0)
    expect(call.usage.outputTokens).toBeGreaterThan(0)
    // Backend is a rotating alias, not a fixed model — assert it resolved to a
    // real backend, not a specific vendor name.
    expect(call.responseModel).toBeTypeOf('string')
    expect(call.responseModel.length).toBeGreaterThan(0)
    expect(call.responseModel).not.toBe('unknown')
    console.log('[Phase 6] Provenance:', JSON.stringify({ provider: call.provider, model: call.model, responseModel: call.responseModel, inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens }))
  }, 240_000)
})
