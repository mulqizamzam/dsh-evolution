/**
 * LIVE proof that parseFileSetFromLLMResponse recovers a REAL model
 * response, not just a hand-written fixture.
 *
 * The fixture in builder-parser.spec.ts pins the parser contract (including
 * the illegal-escape repair). This file pins the end-to-end claim: a live
 * 9Router response parses into a usable candidate.
 *
 * Note: whether an illegal escape APPEARS in any given run is model-dependent
 * (a probe of 2 live runs found 0). The escape repair is therefore
 * defence-in-depth, exercised by the pinned fixture in builder-parser.spec.ts.
 *
 * Skips itself when 9Router or its key is unavailable, so the suite stays
 * runnable offline. Runs only in the plain environment (`DSH_EVO_LIVE=1`)
 * because it spends real tokens; the owner turns it on deliberately.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseFileSetFromLLMResponse } from '../src/host/modules/builder/tools.ts'

const NINE_ROUTER_URL = 'http://127.0.0.1:20128/v1/chat/completions'
const SQL_JS_PATH = '/home/administrator/.9router/runtime/node_modules/sql.js/dist/sql-wasm.js'
const DB_PATH = join(process.env.HOME ?? '/root', '.9router', 'db', 'data.sqlite')

const LIVE = process.env.DSH_EVO_LIVE === '1'

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
    const row = db.exec('SELECT key FROM apiKeys WHERE isActive=1 LIMIT 1')[0]?.values?.[0]?.[0]
    return typeof row === 'string' ? row : null
  } catch {
    return null
  }
}

describe.skipIf(!LIVE)('LIVE: real model response survives invalid escapes', () => {
  it('parses a complete live model response (defence-in-depth: also survives illegal escapes if they appear)', async () => {
    const apiKey = await resolveKey()
    if (apiKey === null) {
      throw new Error('no 9Router key available — cannot run the live proof')
    }

    const res = await fetch(NINE_ROUTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'Deterministik',
        messages: [
          {
            role: 'system',
            content: 'You are a TypeScript module generator. Respond with ONLY a JSON object matching: {"manifest":{...},"files":[{"path":"src/index.ts","content":"..."}],"tests":[{"path":"test/x.spec.ts","content":"..."}]}. No prose, no markdown fences.',
          },
          {
            role: 'user',
            content: 'Generate a TypeScript module that sorts JSON records ascending by id stably, plus a test.',
          },
        ],
        max_tokens: 8192,
        stream: false,
        reasoning_effort: 'low',
      }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as {
      model?: string
      choices?: Array<{ finish_reason?: string; message?: { content?: string } }>
      usage?: { completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } }
    }

    const content = data.choices?.[0]?.message?.content ?? ''
    expect(content.length).toBeGreaterThan(0)

    // Pin the cause: reasoning must not have consumed the whole budget, which
    // is what produced an empty answer before reasoning was pinned off.
    const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens ?? 0
    expect(reasoningTokens).toBeLessThan(data.usage?.completion_tokens ?? Infinity)

    // On failure, persist the exact bytes. The parse error alone is not
    // diagnosable: three live runs produced three DIFFERENT failure lengths
    // (27620, 11308, 1685), so the cause has to be read from the response.
    try {
      const fileSet = parseFileSetFromLLMResponse(content)
      expect(fileSet.files.length).toBeGreaterThan(0)
      expect(fileSet.manifest.name).not.toBe('')
      for (const file of [...fileSet.files, ...fileSet.tests]) {
        expect(file.path).not.toBe('')
        expect(typeof file.content).toBe('string')
      }
    } catch (error) {
      const stamp = Date.now()
      writeFileSync(
        `.dev/live-fail-${stamp}-len${content.length}.txt`,
        'finish_reason=' + (data.choices?.[0]?.finish_reason ?? '?')
          + '\nmodel=' + (data.model ?? '?')
          + '\ncompletion_tokens=' + (data.usage?.completion_tokens ?? '?')
          + '\n---\n' + content,
      )
      throw error
    }
  }, 300_000)
})
