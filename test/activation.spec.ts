/**
 * Step 13 — candidate → plugin activation.
 *
 * These tests drive the REAL boot path (`apply` from src/host/index.ts) against
 * a fake Cordis host that implements the verbs activation uses, so every
 * assertion is about runtime behaviour (which tools exist, what they return),
 * not about files on disk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import { makeFakeHost } from './helpers/fake-host.ts'
import type { FakeHost } from './helpers/fake-host.ts'
import type { ModuleDeps } from '../src/host/types.ts'

const BOOT = '../src/host/index.ts'

function depsFor(host: FakeHost, store: EvolutionStore, root: string): ModuleDeps {
  return {
    ctx: host.ctx,
    cfg: () => resolveConfig({ stateRoot: root }),
    store,
    log: () => {},
    warn: () => {},
  }
}

/** Boot the plugin the way the loader does: one apply() call. */
async function bootPlugin(host: FakeHost, root: string): Promise<void> {
  const mod = await import(BOOT)
  await mod.apply(host.ctx, { stateRoot: root })
}

async function seedBenchmarkedCandidate(store: EvolutionStore, entry: string) {
  const candidate = await store.addCandidate({
    parentVersion: 'v1', type: 'policy', name: 'verify-before-edit', description: 'd', reason: 'r',
    evidenceIds: [], patternIds: [],
    files: [{ path: 'src/index.ts', content: entry }],
    tests: [{ path: 'test/index.spec.ts', content: 'export const t = 1' }],
    benchmarkConfig: {
      successRate: { min: 0.8, weight: 1 }, avgScore: { min: 0.7, weight: 1 },
      errorRate: { max: 0.2, weight: 1 }, avgSteps: { max: 50, weight: 0.5 },
      avgDurationMs: { max: 60000, weight: 0.5 },
    },
    status: 'draft',
  })
  await store.addBenchmark({
    mode: 'live', candidateId: candidate.id, version: 'v1', baseline: 'v1', runs: 3,
    metrics: { successRate: 1, avgScore: 1, errorRate: 0, avgSteps: 0, avgDurationMs: 120 },
    passed: true, details: 'live evidence',
  })
  await store.updateCandidate(candidate.id, { status: 'benchmarked' })
  return candidate
}

const GOOD_ENTRY = 'export default function verify(): boolean { return true }\nconsole.log("CANDIDATE_ENTRY_RAN")\n'

describe('candidate -> plugin activation', () => {
  let root: string
  let store: EvolutionStore

  beforeEach(async () => {
    // Activation state is per host process; each test simulates a fresh host.
    const { resetActivation } = await import('../src/host/modules/activation/loader.ts')
    resetActivation()
    root = await mkdtemp(join(tmpdir(), 'evo-activation-'))
    store = new EvolutionStore({ fallbackRoot: root })
    await store.init()
    await store.createVersion({ label: 'baseline', modules: [] })
  })

  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('nothing is activated before a promotion', async () => {
    const host = makeFakeHost()
    await bootPlugin(host, root)

    expect(host.tools().filter(t => t.startsWith('evo_active_'))).toEqual([])
    const status = await host.call('evo_activation_status') as { mountedTool: string | null; reason: string }
    expect(status.mountedTool).toBe(null)
    expect(String(status.reason)).toContain('no promoted module')
    await access(join(root, 'versions', 'v1', 'plugin.js')).then(
      () => { throw new Error('v1 should have no artifact') },
      () => { /* expected */ },
    )
  })

  it('promotion produces a loadable artifact and mounts it', async () => {
    const candidate = await seedBenchmarkedCandidate(store, GOOD_ENTRY)
    const host = makeFakeHost()
    await bootPlugin(host, root)
    const deps = depsFor(host, store, root)

    const { promoteTools } = await import('../src/host/modules/promote/tools.ts')
    const result = await promoteTools(deps).find(t => t.name === 'evo_promote')!
      .execute({ candidateId: candidate.id, reason: 'activation test' } as never, { signal: AbortSignal.timeout(120_000) }) as {
        ok: boolean; version: { id: string }; activation: { mountedTool: string | null }
      }

    expect(result.ok).toBe(true)
    expect(result.activation.mountedTool).toBe('evo_active_verify_before_edit')

    // Artifact on disk…
    const dir = join(root, 'versions', result.version.id)
    await access(join(dir, 'manifest.json'))
    await access(join(dir, 'plugin.js'))
    await access(join(dir, 'files', 'src', 'index.ts'))

    // …and really mounted in the runtime.
    expect(host.tools()).toContain('evo_active_verify_before_edit')

    // The generated plugin holds no candidate code.
    const pluginSource = await readFile(join(dir, 'plugin.js'), 'utf8')
    expect(pluginSource).not.toContain('CANDIDATE_ENTRY_RAN')
    expect(pluginSource).not.toContain('export default function verify')

    // Calling the mounted tool EXECUTES the candidate in the sandbox.
    const run = await host.call('evo_active_verify_before_edit') as {
      ok: boolean; passed: boolean; exitCode: number | null; stdout: string; versionId: string; sandbox: string
    }
    expect(run.ok).toBe(true)
    expect(run.passed).toBe(true)
    expect(run.exitCode).toBe(0)
    expect(run.stdout).toContain('CANDIDATE_ENTRY_RAN')
    expect(run.versionId).toBe(result.version.id)
  })

  it('a FRESH host boot activates the promoted version with no promotion call', async () => {
    const candidate = await seedBenchmarkedCandidate(store, GOOD_ENTRY)
    const promotingHost = makeFakeHost()
    await bootPlugin(promotingHost, root)
    const deps = depsFor(promotingHost, store, root)
    const { promoteTools } = await import('../src/host/modules/promote/tools.ts')
    await promoteTools(deps).find(t => t.name === 'evo_promote')!
      .execute({ candidateId: candidate.id, reason: 'r' } as never, { signal: AbortSignal.timeout(120_000) })

    // New process, new host, same state root: nothing but boot.
    const freshHost = makeFakeHost()
    expect(freshHost.tools()).toEqual([])
    await bootPlugin(freshHost, root)

    expect(freshHost.tools()).toContain('evo_active_verify_before_edit')
    const status = await freshHost.call('evo_activation_status') as { mountedVersionId: string; mountedTool: string }
    expect(status.mountedTool).toBe('evo_active_verify_before_edit')
    expect(status.mountedVersionId).toBe('v2')

    const run = await freshHost.call('evo_active_verify_before_edit') as { passed: boolean; stdout: string }
    expect(run.passed).toBe(true)
    expect(run.stdout).toContain('CANDIDATE_ENTRY_RAN')
  })

  it('rollback deactivates the mounted plugin immediately', async () => {
    const candidate = await seedBenchmarkedCandidate(store, GOOD_ENTRY)
    const host = makeFakeHost()
    await bootPlugin(host, root)
    const deps = depsFor(host, store, root)
    const { promoteTools } = await import('../src/host/modules/promote/tools.ts')

    await promoteTools(deps).find(t => t.name === 'evo_promote')!
      .execute({ candidateId: candidate.id, reason: 'r' } as never, { signal: AbortSignal.timeout(120_000) })
    expect(host.tools()).toContain('evo_active_verify_before_edit')

    const rolled = await promoteTools(deps).find(t => t.name === 'evo_rollback')!
      .execute({ versionId: 'v1' } as never, { signal: AbortSignal.timeout(60_000) }) as {
        ok: boolean; activation: { mountedTool: string | null; reason: string }
      }
    expect(rolled.ok).toBe(true)
    expect(rolled.activation.mountedTool).toBe(null)
    expect(host.tools()).not.toContain('evo_active_verify_before_edit')

    // And a fresh boot of the rolled-back state mounts nothing.
    const freshHost = makeFakeHost()
    await bootPlugin(freshHost, root)
    expect(freshHost.tools().filter(t => t.startsWith('evo_active_'))).toEqual([])
  })

  it('a candidate whose entry does not parse is refused and never becomes a version', async () => {
    const broken = await seedBenchmarkedCandidate(store, 'this is not valid javascript (((\n')
    const host = makeFakeHost()
    await bootPlugin(host, root)
    const deps = depsFor(host, store, root)

    const { promoteTools } = await import('../src/host/modules/promote/tools.ts')
    const result = await promoteTools(deps).find(t => t.name === 'evo_promote')!
      .execute({ candidateId: broken.id, reason: 'r' } as never, { signal: AbortSignal.timeout(120_000) }) as {
        ok: boolean; error: string; activationReason?: string
      }

    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('pre-flight')
    expect(host.tools().filter(t => t.startsWith('evo_active_'))).toEqual([])

    // No new version was created; v1 is still the only one and still active.
    const versions = await store.listVersions()
    expect(versions).toHaveLength(1)
    expect((await store.getActiveVersion())!.id).toBe('v1')
  })

  it('a corrupted artifact is refused at boot instead of being loaded', async () => {
    const candidate = await seedBenchmarkedCandidate(store, GOOD_ENTRY)
    const host = makeFakeHost()
    await bootPlugin(host, root)
    const deps = depsFor(host, store, root)
    const { promoteTools } = await import('../src/host/modules/promote/tools.ts')
    const promoted = await promoteTools(deps).find(t => t.name === 'evo_promote')!
      .execute({ candidateId: candidate.id, reason: 'r' } as never, { signal: AbortSignal.timeout(120_000) }) as { version: { id: string } }

    // Corrupt the generated plugin after promotion.
    await writeFile(join(root, 'versions', promoted.version.id, 'plugin.js'), 'this is not valid ((( \n', 'utf8')

    const freshHost = makeFakeHost()
    await bootPlugin(freshHost, root)
    expect(freshHost.tools().filter(t => t.startsWith('evo_active_'))).toEqual([])
    const status = await freshHost.call('evo_activation_status') as { reason: string | null }
    expect(String(status.reason)).toContain('pre-flight refused')
  })

  it('a tampered manifest is refused', async () => {
    const candidate = await seedBenchmarkedCandidate(store, GOOD_ENTRY)
    const host = makeFakeHost()
    await bootPlugin(host, root)
    const deps = depsFor(host, store, root)
    const { promoteTools } = await import('../src/host/modules/promote/tools.ts')
    const promoted = await promoteTools(deps).find(t => t.name === 'evo_promote')!
      .execute({ candidateId: candidate.id, reason: 'r' } as never, { signal: AbortSignal.timeout(120_000) }) as { version: { id: string } }

    const manifestPath = join(root, 'versions', promoted.version.id, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.entryPoint = 'src/does-not-exist.ts'
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')

    const freshHost = makeFakeHost()
    await bootPlugin(freshHost, root)
    expect(freshHost.tools().filter(t => t.startsWith('evo_active_'))).toEqual([])
    const status = await freshHost.call('evo_activation_status') as { reason: string | null }
    expect(String(status.reason)).toContain('not loadable')
  })
})
