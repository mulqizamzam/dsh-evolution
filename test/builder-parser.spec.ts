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
