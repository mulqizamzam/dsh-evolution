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
