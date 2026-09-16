/**
 * Regression tests for the REAL host `session/event` contract.
 *
 * The host emits `session/event` with (session, event) where a `turn/end`
 * event carries ONLY `{ turn, reason }`. These tests pin that contract so the
 * observer cannot silently regress to reading fields that do not exist.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvolutionStore } from '../src/host/store.ts'
import { resolveConfig } from '../src/host/config.ts'
import type { ModuleDeps, HostSessionEvent, HostSessionView } from '../src/host/types.ts'
import type { HostContextShape } from '../src/host/dsh.ts'
import { observeTurn, runAutoCycle, resetAutoGuards, autoGuardState } from '../src/host/modules/auto-experience/index.ts'

function makeCtx(): HostContextShape {
  return {
    tools: { register: () => {} },
    settings: { writable: true, register: () => ({ get: () => ({}) }) },
    agents: { get: () => undefined, roots: () => [] },
    get: () => undefined,
    on: () => () => {},
    effect: () => () => {},
  }
}

function makeDeps(store: EvolutionStore, root: string, overrides?: Record<string, unknown>): ModuleDeps {
  return {
    ctx: makeCtx(),
    cfg: () => resolveConfig({ stateRoot: root, ...overrides }),
    store,
    log: () => {},
    warn: () => {},
  }
}

/** Build a session log shaped exactly like the host's. */
function makeSession(events: HostSessionEvent[]): HostSessionView {
  return { header: { id: 'session-abc123' }, events }
}

describe('observeTurn: real host event contract', () => {
  it('turn/end carries only {turn, reason} — derivation must not depend on other fields', () => {
    const session = makeSession([
      { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
      { type: 'user/message', seq: 2, time: 1010, data: { content: [{ type: 'text', text: 'fix the bug' }], source: { kind: 'user' } } },
      { type: 'step/start', seq: 3, time: 1020, data: { turn: 1, step: 1 } },
      { type: 'step/end', seq: 4, time: 1500, data: { turn: 1, step: 1 } },
      { type: 'step/start', seq: 5, time: 1600, data: { turn: 1, step: 2 } },
      { type: 'step/end', seq: 6, time: 2000, data: { turn: 1, step: 2 } },
      { type: 'turn/end', seq: 7, time: 3000, data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    const turnEnd = session.events[session.events.length - 1]

    const observed = observeTurn(session, turnEnd)
    expect(observed).not.toBeNull()
    expect(observed!.turn).toBe(1)
    expect(observed!.success).toBe(true)
    expect(observed!.reasonKind).toBe('completed')
    expect(observed!.stepCount).toBe(2)
    expect(observed!.durationMs).toBe(2000)          // 3000 - 1000 from turn/start
    expect(observed!.prompt).toBe('fix the bug')
    expect(observed!.sessionId).toBe('session-abc123')
    expect(observed!.errors).toBeUndefined()
  })

  it('records a failed turn with the structured error message', () => {
    const session = makeSession([
      { type: 'turn/start', seq: 1, time: 500, data: { turn: 4 } },
      { type: 'turn/end', seq: 2, time: 900, data: { turn: 4, reason: { kind: 'error', error: { message: 'llm exploded', code: 'LLM_ERROR' } } } },
    ])
    const observed = observeTurn(session, session.events[1])!
    expect(observed.success).toBe(false)
    expect(observed.reasonKind).toBe('error')
    expect(observed.errors).toEqual(['llm exploded'])
    expect(observed.stepCount).toBe(0)
  })

  it('treats aborted / blocked / max-tokens as non-success with a reason', () => {
    for (const kind of ['aborted', 'blocked', 'max-tokens'] as const) {
      const session = makeSession([
        { type: 'turn/start', seq: 1, time: 100, data: { turn: 2 } },
        { type: 'turn/end', seq: 2, time: 200, data: { turn: 2, reason: { kind } } },
      ])
      const observed = observeTurn(session, session.events[1])!
      expect(observed.success).toBe(false)
      expect(observed.reasonKind).toBe(kind)
      expect(observed.errors!.length).toBe(1)
    }
  })

  it('ignores non-turn/end events', () => {
    const session = makeSession([{ type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } }])
    expect(observeTurn(session, session.events[0])).toBeNull()
  })

  it('collects tool call names without storing payloads', () => {
    const session = makeSession([
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
      { type: 'tool/call', seq: 2, time: 2, data: { turn: 1, name: 'read', arguments: { huge: 'x'.repeat(10000) } } },
      { type: 'tool/call', seq: 3, time: 3, data: { turn: 1, name: 'bash', arguments: { cmd: 'ls' } } },
      { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    const observed = observeTurn(session, session.events[3])!
    expect(observed.toolCallNames).toEqual(['read', 'bash'])
  })

  it('only counts steps and prompts belonging to the ended turn', () => {
    const session = makeSession([
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: 'old turn prompt' }], source: { kind: 'user' } } },
      { type: 'step/start', seq: 3, time: 3, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 5, time: 5, data: { turn: 2 } },
      { type: 'user/message', seq: 6, time: 6, data: { content: [{ type: 'text', text: 'new turn prompt' }], source: { kind: 'user' } } },
      { type: 'step/start', seq: 7, time: 7, data: { turn: 2, step: 1 } },
      { type: 'step/start', seq: 8, time: 8, data: { turn: 2, step: 2 } },
      { type: 'step/start', seq: 9, time: 9, data: { turn: 2, step: 3 } },
      { type: 'turn/end', seq: 10, time: 10, data: { turn: 2, reason: { kind: 'completed' } } },
    ])
    const observed = observeTurn(session, session.events[9])!
    expect(observed.turn).toBe(2)
    expect(observed.stepCount).toBe(3)
    expect(observed.prompt).toBe('new turn prompt')
  })

  it('ignores plugin-injected user/message when choosing the prompt', () => {
    const session = makeSession([
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: 'human task' }], source: { kind: 'user' } } },
      { type: 'user/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: 'injected context' }], source: { kind: 'plugin', plugin: 'other' } } },
      { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    const observed = observeTurn(session, session.events[3])!
    expect(observed.prompt).toBe('human task')
  })
})

describe('runAutoCycle: threshold and loop safety', () => {
  let tmpRoot: string
  let store: EvolutionStore

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'evo-auto-'))
    store = new EvolutionStore({ fallbackRoot: tmpRoot })
    await store.init()
    resetAutoGuards()
  })

  afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

  it('does nothing below minExperiences', async () => {
    for (let i = 0; i < 5; i++) await store.addExperience({ success: false, errors: ['timeout'], prompt: 'x' })
    const outcome = await runAutoCycle(makeDeps(store, tmpRoot))
    expect(outcome.ran).toBe(false)
    expect(outcome.reason).toContain('not enough experiences')
  })

  it('records patterns once the threshold is reached, without generating', async () => {
    for (let i = 0; i < 20; i++) {
      await store.addExperience({ success: false, errors: ['timeout: request timed out'], stepCount: 12, prompt: 'complex' })
    }
    const deps = makeDeps(store, tmpRoot)
    const outcome = await runAutoCycle(deps)
    expect(outcome.ran).toBe(true)
    expect(outcome.patterns).toBeGreaterThan(0)
    expect(outcome.reason).toContain('generation disabled')
    expect((await store.listPatterns()).length).toBeGreaterThan(0)
  })

  it('will not re-run until enough NEW experiences accumulate', async () => {
    for (let i = 0; i < 20; i++) {
      await store.addExperience({ success: false, errors: ['sig-a'], stepCount: 5, prompt: 'a' })
    }
    const deps = makeDeps(store, tmpRoot)
    const first = await runAutoCycle(deps)
    expect(first.ran).toBe(true)
    const second = await runAutoCycle(deps)
    expect(second.ran).toBe(false)
    expect(second.reason).toContain('waiting for more new experiences')
  })

  it('respects the per-process cycle cap', async () => {
    const deps = makeDeps(store, tmpRoot, { evolution: { maxCyclesPerProcess: 1 } })
    for (let i = 0; i < 40; i++) {
      await store.addExperience({ success: false, errors: ['sig-' + (i % 2)], stepCount: 5, prompt: 'p' })
    }
    const first = await runAutoCycle(deps)
    expect(first.ran).toBe(true)
    expect(autoGuardState().cyclesRun).toBe(1)

    const second = await runAutoCycle(deps)
    expect(second.ran).toBe(false)
    expect(second.reason).toContain('cap reached')
  })

  it('does not start a second cycle while one is in flight', async () => {
    for (let i = 0; i < 20; i++) await store.addExperience({ success: false, errors: ['sig'], stepCount: 5, prompt: 'p' })
    const deps = makeDeps(store, tmpRoot)
    const [a, b] = await Promise.all([runAutoCycle(deps), runAutoCycle(deps)])
    const bothRan = a.ran && b.ran
    expect(bothRan).toBe(false)
  })

  it('honours the master switch', async () => {
    for (let i = 0; i < 20; i++) await store.addExperience({ success: false, errors: ['sig'], stepCount: 5, prompt: 'p' })
    const deps = makeDeps(store, tmpRoot, { evolution: { autoTrigger: false } })
    const outcome = await runAutoCycle(deps)
    expect(outcome.ran).toBe(false)
    expect(outcome.reason).toContain('disabled')
  })
})
