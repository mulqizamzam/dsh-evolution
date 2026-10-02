/**
 * LIVE measurement of the PRODUCTION failure contract, not the raw single call.
 *
 * `builder-parser-live.spec.ts` fetches from 9Router directly and parses once,
 * so it measures the RAW single-call rate (~17.5% measured over 40 runs). The
 * production tool does NOT work that way:
 *
 *   callHostLLM()  retries once when the stream returns empty text
 *   execute()      retries once when parseFileSetFromLLMResponse throws
 *
 * So a candidate only reaches `ok:false` after BOTH attempts fail. This spec
 * mirrors that contract against the real endpoint and the real parser, and
 * reports the rate that actually gates `evo_builder_generate`.
 *
 * Gated behind DSH_EVO_LIVE=1 like the other live spec: it spends real tokens.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFileSetFromLLMResponse } from '../src/host/modules/builder/tools.ts'

const NINE_ROUTER_URL = 'http://127.0.0.1:20128/v1/chat/completions'
const SQL_JS_PATH = '/home/administrator/.9router/runtime/node_modules/sql.js/dist/sql-wasm.js'
const DB_PATH = join(process.env.HOME ?? '/root', '.9router', 'db', 'data.sqlite')
const LIVE = process.env.DSH_EVO_LIVE === '1'
// How many production-equivalent attempts to measure per run. The tool
// attempts at most twice (initial + one retry), so 2 mirrors the contract.
const ATTEMPTS = 2
const RUNS = Number(process.env.EVO_RETRY_RUNS ?? '20')

async function resolveKey(): Promise<string | null> {
  const envKey = process.env['9ROUTER_API_KEY'] ?? process.env['NINE_ROUTER_API_KEY']
  if (envKey) return envKey
  if (!existsSync(DB_PATH) || !existsSync(SQL_JS_PATH)) return null
  try {
    const initSqlJs = (await import(/* @vite-ignore */ SQL_JS_PATH)).default as () => Promise<{
      Database: new (buf: Buffer) => { exec(sql: string): Array<{ values: unknown[][] }> }
    }>
    const SQL = await initSqlJs()
    const db = new SQL.Database(readFileSync(DB_PATH))
    const row = db.exec('SELECT key FROM apiKeys WHERE isActive=1 LIMIT 1')[0]?.values[0]?.[0]
    return typeof row === 'string' ? row : null
  } catch {
    return null
  }
}

const SYSTEM =
  'You generate one candidate improvement module for DSH, returned as a single JSON object.\n' +
  'Output the JSON object and NOTHING else. Keep the whole response under 3000 characters.\n' +
  '{"manifest":{"name":"x","version":"1.0.0","type":"verification-strategy","description":"d",' +
  '"entryPoint":"src/index.ts","benchmarkCases":[{"id":"c1","description":"d","input":"i",' +
  '"expectedOutput":"o","expectedExitCode":0,"timeoutMs":10000,"successCriteria":"s"}]},' +
  '"files":[{"path":"src/index.ts","content":"..."}],"tests":[{"path":"test/i.spec.ts","content":"..."}]}'
const USER =
  'Generate a TypeScript module that sorts JSON records ascending by id stably, plus one test.'

interface Attempt { ok: boolean; reason: string; model: string; tokens: number; chars: number }

async function oneAttempt(apiKey: string, attempt: number): Promise<Attempt> {
  const directive = attempt > 0
    // Mirrors callHostLLM's empty-text retry: same prompt, harder directive.
    ? SYSTEM + '\n\nIMPORTANT: reply with the JSON object only. No analysis, no preamble, and no markdown fences.'
    : SYSTEM
  const res = await fetch(NINE_ROUTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'Deterministik',
      messages: [
        { role: 'system', content: directive },
        { role: 'user', content: USER },
      ],
      max_tokens: 8192,
      stream: false,
      reasoning_effort: 'low',
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return { ok: false, reason: `http-${res.status}: ${body.slice(0, 160)}`, model: '?', tokens: 0, chars: 0 }
  }
  const data = await res.json() as {
    model?: string
    choices?: Array<{ finish_reason?: string; message?: { content?: string } }>
    usage?: { completion_tokens?: number }
  }
  const content = data.choices?.[0]?.message?.content ?? ''
  const model = data.model ?? 'unknown'
  const tokens = data.usage?.completion_tokens ?? 0
  const base = { model, tokens, chars: content.length }

  // callHostLLM's empty-text branch.
  if (content.trim() === '') {
    if (attempt + 1 < ATTEMPTS) return { ...base, ok: false, reason: 'empty-content(retry pending)' }
    return { ...base, ok: false, reason: 'empty-content' }
  }
  try {
    const fileSet = parseFileSetFromLLMResponse(content)
    if (fileSet.files.length === 0) return { ...base, ok: false, reason: 'no-files' }
    return { ...base, ok: true, reason: 'parsed' }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { ...base, ok: false, reason: 'parse: ' + msg.slice(0, 120) }
  }
}

/** One production attempt = up to ATTEMPTS sequential calls, like the tool. */
async function productionRun(apiKey: string): Promise<{ ok: boolean; reason: string; calls: number }> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const r = await oneAttempt(apiKey, attempt)
    if (r.ok) return { ok: true, reason: 'parsed', calls: attempt + 1 }
    // Mirror execute(): retry on parse failure; retry on empty (callHostLLM).
    if (r.reason.startsWith('http-')) return { ok: false, reason: r.reason, calls: attempt + 1 }
    if (attempt + 1 >= ATTEMPTS) return { ok: false, reason: r.reason, calls: attempt + 1 }
  }
  return { ok: false, reason: 'unreachable', calls: ATTEMPTS }
}

describe.skipIf(!LIVE)('LIVE: production failure contract (2 attempts)', () => {
  it(`measures the gated rate over ${RUNS} production-equivalent runs`, async () => {
    const apiKey = await resolveKey()
    if (apiKey === null) throw new Error('no 9Router key available')

    let ok = 0
    const reasons: string[] = []
    const callCounts: number[] = []
    for (let i = 0; i < RUNS; i++) {
      const r = await productionRun(apiKey)
      callCounts.push(r.calls)
      if (r.ok) ok += 1
      else reasons.push(r.reason)
      // Progress line so a partial run still yields usable numbers.
      console.log(`[retry-live] ${i + 1}/${RUNS} ok=${ok} fail=${reasons.length} calls=${r.calls} last=${r.reason.slice(0, 70)}`)
    }
    const fail = reasons.length
    const rate = Math.round((fail * 100) / RUNS)
    console.log(`[retry-live] RESULT pass=${ok}/${RUNS} fail=${fail} rate=${rate}% calls-used=${JSON.stringify(callCounts)}`)
    for (const r of reasons) console.log(`[retry-live]   FAIL: ${r}`)

    writeFileSync(
      '.dev/retry-live-result.json',
      JSON.stringify({ runs: RUNS, pass: ok, fail, ratePct: rate, attempts: ATTEMPTS, reasons }, null, 2),
      'utf8',
    )

    // The gate itself. A non-zero failure count is a real result, not a test
    // defect, so this assertion reports the measured rate rather than hiding it.
    expect(fail).toBeLessThan(RUNS)
  }, 900_000)
})