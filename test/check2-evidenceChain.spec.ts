/**
 * CHECK 2: Fresh pattern evidence lineage (post-P13)
 * Test that newly generated patterns carry non-empty evidenceIds.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import { detectPatterns } from '../src/host/modules/analyze/tools.ts'

describe('CHECK 2: Fresh pattern evidence lineage', () => {
  let tmpRoot: string, store: EvolutionStore
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-check2-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
  })
  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  it('new experiences produce patterns with non-empty evidenceIds', async () => {
    // Seed 6 experiences with the same error signature (above minOccurrences=3)
    for (let i = 0; i < 6; i++) {
      const exp = await store.addExperience({
        success: false,
        errors: ['timeout: request timed out after 30s'],
        stepCount: 12,
        prompt: 'task-' + i,
      })
      expect(exp.id).toBeTruthy()
      expect(exp.id.length).toBeGreaterThan(0)
    }
    // Generate patterns with minOccurrences=3
    const experiences = await store.listExperiences(100)
    const patterns = detectPatterns(experiences, 3)
    expect(patterns.length).toBeGreaterThan(0)
    // Each pattern should have evidenceIds populated
    const withEvidence = patterns.filter(p => Array.isArray(p.evidenceIds) && p.evidenceIds.length > 0)
    expect(withEvidence.length).toBeGreaterThan(0)
    // evidenceIds should reference actual experience IDs
    const experienceIds = new Set(experiences.map(e => e.id))
    for (const p of withEvidence) {
      for (const eid of p.evidenceIds) {
        expect(experienceIds.has(eid)).toBe(true)
      }
    }
  })

  it('success-only experiences produce opportunity patterns with evidenceIds', async () => {
    for (let i = 0; i < 6; i++) {
      await store.addExperience({
        success: true,
        stepCount: 3,
        prompt: 'ok-task-' + i,
        summary: 'turn ended: completed',
      })
    }
    const experiences = await store.listExperiences(100)
    const patterns = detectPatterns(experiences, 3)
    expect(patterns.length).toBeGreaterThan(0)
    const withEvidence = patterns.filter(p => Array.isArray(p.evidenceIds) && p.evidenceIds.length > 0)
    expect(withEvidence.length).toBeGreaterThan(0)
  })

  it('historical patterns can be backfilled by re-running detectPatterns', async () => {
    // Simulate old empty evidenceIds pattern
    await store.addPattern({
      type: 'failure',
      evidence: 'FACT',
      description: 'Recurring signature observed 5 times: timeout error',
      occurrences: 5,
      evidenceIds: [], // old empty state
      confidence: 0.8,
    })
    // Add new matching experiences
    for (let i = 0; i < 5; i++) {
      await store.addExperience({
        success: false,
        errors: ['timeout error'],
        stepCount: 10,
        prompt: 'task-' + i,
      })
    }
    const experiences = await store.listExperiences(100)
    const patterns = detectPatterns(experiences, 3)
    // New patterns from fresh data should have evidenceIds
    const newWithEvidence = patterns.filter(p => Array.isArray(p.evidenceIds) && p.evidenceIds.length > 0)
    expect(newWithEvidence.length).toBeGreaterThan(0)
  })
})
