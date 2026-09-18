/**
 * Legacy shared-root behavior: when no profile name is supplied, two stores
 * with the same fallbackRoot intentionally share state.  This test documents
 * that this legacy contract is preserved for backward compatibility.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'

describe('STATE ROOT SAME-ROOT LEGACY BEHAVIOR', () => {
  it('two stores with identical root SHARE state when profileName is omitted', async () => {
    const sharedRoot = await mkdtemp(join(tmpdir(), 'evo-legacy-share-'))
    try {
      const storeA = new EvolutionStore({ fallbackRoot: sharedRoot })
      await storeA.init()
      const storeB = new EvolutionStore({ fallbackRoot: sharedRoot })
      await storeB.init()

      // No profile name → same resolved root
      expect(storeA.getRoot()).toBe(storeB.getRoot())

      // Both write and read the same mutable namespace
      const exp = await storeA.addExperience({ success: true, prompt: 'legacy-shared' })
      expect(exp.id).toBeDefined()
      const visible = await storeB.listExperiences(100)
      expect(visible.length).toBe(1)
      expect(visible[0].prompt).toBe('legacy-shared')
    } finally {
      await rm(sharedRoot, { recursive: true, force: true })
    }
  })
})
