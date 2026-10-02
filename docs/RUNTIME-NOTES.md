# Verified host contracts (from LIVE runs)

Every item below was found by running the plugin inside a real DSH host
(profile `evo-live`, headless bundle, real configured model on the 9Router
route). None of them were visible to the mock-based unit tests, which is the
whole point of keeping this list.

## 1. Tool return values must be lossless JSON

The host snapshots every tool return value with `snapshotJsonValue`
(`packages/core/session/src/json.ts`). It REJECTS:

- a property whose value is `undefined`
- `NaN`, `Infinity`, `-Infinity`, and `-0`
- cyclic references, sparse arrays, non-plain objects

A rejection fails the entire tool call with
`value is not lossless JSON` **even though the tool body ran and returned**.
The caller never sees the result.

Consequence: optional fields must be OMITTED, never assigned `undefined`.
`neutralizeDeep` (src/lib/sanitize.ts) enforces this centrally; re-check it
with `.dev/verify-lossless-real.ts`, which imports the host's own validator.

## 2. Calling the configured model from a plugin

- Model selection: `ctx.get('agentDefaultModel').currentSelection()`.
- Runtime: `ctx.get('llm').stream(options)`. `get` is optional lookup, so no
  `inject` declaration is required for it.
- `options.messages[].content` must be an ARRAY of content blocks
  (`[{ type: 'text', text }]`), with `id` and `source` present. Passing the
  content as a plain string throws inside the adapter:
  `content.some is not a function`.
- Token accounting uses `inputTokens` / `outputTokens` (there is no
  `promptTokens` / `completionTokens` / `totalTokens`); a total must be
  computed.
- A failure is reported on the terminal `finish` chunk
  (`reason.kind` `error` / `aborted` with `reason.failure`), NOT thrown.
  Ignoring the finish reason yields a silent empty string.
- A thinking route can spend the whole output budget on reasoning and emit no
  text; retry once with a directive instead of reporting a parse failure.

## 3. Session events

- `ctx.on('session/event', (session, event) => …)`.
- A `turn/end` event carries ONLY `{ turn, reason }`. Prompt, step count and
  duration must be derived from `session.events`.
- Surface events such as `user/message` do NOT carry `turn`. Bracket the turn
  by sequence position (between its `turn/start` and `turn/end`) rather than
  assuming every event names its turn.
- `reason.kind` is one of `completed`, `aborted`, `blocked`, `error`,
  `max-tokens`, `interrupted`; only `completed` is a success.

## 4. Bubblewrap sandbox needs its own runtime

Binding only `/usr`, `/bin` and friends is not enough: a version-managed Node
(nvm/volta/fnm) lives outside those paths, so every candidate died with exit
127 before running. Bind `dirname(process.execPath)` read-only and put it
first on the sandbox `PATH`.

Node 24 executes `.ts` directly (type stripping), so a generated TypeScript
candidate can be benchmarked without a build step.

## 5. Profile patch syntax for overriding an inserted row

A row override is a TOP-LEVEL array element:

```yaml
- id: dsh-evolution
  config:
    evolution: { enabled: false }
```

A `- update:` wrapper is silently ignored — the bundle defaults stay in force.
Always confirm with `dsh --profile <name> --dump-config`, which prints
`# == <id>, patched by <file>` for every row that was actually overridden.

## 6. Candidate activation (Step 13)

The official dynamic-package runner (`ctx.dynamicCordisRunner`) cannot serve this
step: its README states the registry is process memory only — "Nothing here is
written to disk, and no definition is restored automatically". Boot discovery
therefore needs a persisted artifact plus a loader that runs at boot.

Contract used, all verified against the host:

- `ctx.plugin(module, config)` — mount a plugin module under the current fiber.
  Returns a fiber whose `dispose()` unregisters everything the plugin
  registered (Cordis scopes registrations to the fiber).
- `ctx.provide(name, value)` — expose a non-service value reachable by
  `ctx.get(name)`. Returns a disposer.
- A regular profile plugin receives the REAL Context, so both verbs are
  available. (`ctx.plugin` is withheld only from the dynamic-package façade.)

Artifact layout written at promotion, under the plugin's own state root:

```
versions/<versionId>/manifest.json   metadata + tool name + content hash
versions/<versionId>/plugin.js       HOST-AUTHORED plugin (no candidate code)
versions/<versionId>/files/<...>     candidate sources, DATA only
```

`plugin.js` imports nothing and delegates every execution to the
`evolutionRuntime` service, so candidate code only ever runs inside the sandbox.

Activation order and refusals:

1. `refreshActivation` reads the active version (boot, promotion, rollback).
2. `validateArtifact` — schema, tool-name shape, entry point present.
3. Pre-flight in the sandbox: `node --check plugin.js` and the version's test
   command must both exit 0.
4. `ctx.plugin(module, config)` mounts it.
5. Promotion materialises and pre-flights BEFORE `createVersion`, so a candidate
   that cannot activate never becomes the active version.
6. Rollback disposes the mounted fiber immediately; a later boot mounts whatever
   the active version is (or nothing, with an explicit reason).

## 7. Fresh-experience gate — bounded read window (known limitation)

**Date**: 2026-09-19 (Mission C.1 sequential probe)
**Severity**: Known limitation — not a defect; preserves intentional semantics.
**Files involved** (read-only — source/tests unchanged):
- `src/host/modules/auto-experience/index.ts:353` (bounded read)
- `src/host/modules/auto-experience/index.ts:359-362` (fresh-experience gate)
- `src/host/modules/auto-experience/index.ts:376` (window baseline capture)
- `src/host/store.ts:129-130` → `src/lib/fsx.ts:43-63` (`listDir` mtime-descending, truncated to `limit`)

### Mechanism

The autonomous cycle reads experiences through a bounded window:

```typescript
const experiences = await deps.store.listExperiences(cfg.analysis.minExperiences * 4)
```

`listExperiences(limit)` calls `listDir(dir, limit)`, which stats every file in the
experience directory (O(N) cost), sorts by mtime descending, and truncates to `limit`
records. The gate then compares observed growth against the window:

```typescript
if (guards.lastCycleExperienceCount >= 0
  && experiences.length - guards.lastCycleExperienceCount < cfg.analysis.minExperiences) {
  return { ran: false, reason: 'waiting for more new experiences' }
}
```

After a productive cycle, `guards.lastCycleExperienceCount = experiences.length`
captures the window count as the baseline for the next cycle.

### Why it saturates

Once the total number of stored experiences exceeds the window size
(`minExperiences * 4`), every subsequent call returns exactly `window` records —
the newest by mtime, regardless of how many new records were added.
`lastCycleExperienceCount` was set to `window` on the previous cycle, so:

```
delta = experiences.length - lastCycleExperienceCount
      = window - window
      = 0  <  minExperiences  →  gate blocks permanently
```

With `minExperiences = 5`, the window is 20. After 4 productive cycles
(total = 5 + 4×5 = 25 ≥ 20), the cycle-5 attempt returns reason (b) and all
subsequent attempts do likewise.

### Observable effect

Mission C.1 Phase B (`test/sequential-improvements.spec.ts:220+`) overrides
`maxCyclesPerProcess` to 10 and supplies fresh unique error signatures between
each cycle. Progression stops at cycle 5 with:

```
reason: 'b) fresh-experience requirement'
```

This is **not**:
- (a) cap exhaustion — `cyclesRun` is far below `maxCyclesPerProcess`
- (c) pattern dedup — fresh unique signatures are supplied each cycle

The probe explicitly classifies this stop reason at lines 281-302, with the
comment: *"do not inflate the window to hide it."*

### Why this is not operator config

The read window is derived internally (`minExperiences * 4`), not read from a
standalone config key. Enlarging the multiplier only moves the saturation point
(total ≥ window) and increases per-call record reads — it does not eliminate the
bounded-delta defect; it merely postpones it. The per-call cost includes O(N)
stat calls across the full experience directory (`fsx.ts:43-63`), which is
independent of window size.

If future roadmaps require more than ~4 sequential autonomous cycles per process,
the bounded read semantics need a dedicated mission — not a config-table entry.

### Preserved intentionally

This behavior was surfaced by Mission C.1 and preserved per the 2026-09-19
directive. The bounded window is a deliberate trade-off: it bounds per-cycle I/O
and limits pattern-detection scope to recent evidence, which matches the intended
autonomous evolution semantics (recent-relevance bias).
