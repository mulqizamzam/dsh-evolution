import type { EvolutionStore } from '../../src/host/store.ts'

/**
 * Seed experiences under a specific version for P12 degradation tests.
 * Each call returns the experience IDs created.
 */
export async function seedExperiencesForVersion(
  store: EvolutionStore,
  versionId: string,
  options: {
    successes?: number
    failures?: number
    stepCount?: number
    errors?: string[]
  } = {},
): Promise<string[]> {
  const ids: string[] = []
  const {
    successes = 0,
    failures = 0,
    stepCount = 10,
    errors = ['timeout: request timed out'],
  } = options

  for (let i = 0; i < successes; i++) {
    const rec = await store.addExperience({
      success: true,
      score: 0.9,
      stepCount,
      versionId,
      prompt: 'ok-task',
    })
    ids.push(rec.id)
  }
  for (let i = 0; i < failures; i++) {
    const rec = await store.addExperience({
      success: false,
      errors: errors.length > 0 ? errors.slice() : ['failure'],
      stepCount: stepCount + i,
      versionId,
      prompt: 'fail-task',
    })
    ids.push(rec.id)
  }
  return ids
}

/** Reset auto-guards between tests. */
export { resetAutoGuards } from '../../src/host/modules/auto-experience/index.ts'
export { autoGuardState } from '../../src/host/modules/auto-experience/index.ts'
export type { AutoCycleOutcome } from '../../src/host/modules/auto-experience/index.ts'
