/**
 * Verify the SHIPPED patch layer against the REAL loader patch engine.
 *
 * Uses the harness' own `applyEntryPatches`
 * (vendor/include/src/index.ts) — the exact function that composes bundle and
 * profile patch layers at boot — instead of a local re-implementation.
 *
 * The failure this guards is silent: a patch layer whose shape the engine does
 * not accept is skipped with a warning and the bundle defaults stay in force,
 * so a documented kill switch can do nothing at all while looking correct.
 *
 * Run: node --experimental-strip-types .dev/verify-patch-shapes.ts
 */
import { readFileSync } from 'node:fs'

import { applyEntryPatches } from '/home/administrator/deepseek-harness/vendor/include/lib/index.js'
import yaml from '/home/administrator/deepseek-harness/vendor/include/node_modules/js-yaml/index.js'
import { resolveConfig } from '../src/host/config.ts'

const HOST = '/home/administrator/deepseek-harness/vendor/include'

const source = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

/**
 * Pull the kill-switch snippet out of the comment block that documents it, so
 * the check runs the instruction the file actually gives.
 */
function documentedKillSwitch(): unknown {
  const marker = source.indexOf('Kill switch')
  if (marker < 0) throw new Error('cordis.patch.yml no longer documents a kill switch')
  const lines: string[] = []
  let started = false
  for (const raw of source.slice(marker).split('\n').slice(1)) {
    if (!raw.startsWith('#')) break
    // The snippet is the indented run of comment lines, not the prose around it.
    const body = raw.replace(/^# ?/, '')
    if (!started) {
      if (!/^\s+- id:/.test(body)) continue
      started = true
    } else if (body.trim() !== '' && !/^\s/.test(body)) {
      break
    }
    lines.push(body)
  }
  // Trim blank lines only: the snippet's leading indentation aligns the keys,
  // so a plain trim() would corrupt it.
  while (lines.length && lines[0]?.trim() === '') lines.shift()
  while (lines.length && lines[lines.length - 1]?.trim() === '') lines.pop()
  const text = lines.join('\n')
  if (!text) throw new Error('kill-switch snippet is empty')
  return yaml.load(text)
}

let failures = 0
const check = (label: string, ok: boolean, extra = ''): void => {
  if (!ok) failures += 1
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label.padEnd(52) + extra)
}

// 1. The shipped bundle layer must insert its row with no diagnostic.
const layerWarnings: unknown[][] = []
const shipped = applyEntryPatches([], yaml.load(source) as never[], (m, ...a) => layerWarnings.push([m, ...a]))
check('bundle layer inserts one row, no warnings',
  layerWarnings.length === 0 && shipped.length === 1 && shipped[0].id === 'dsh-evolution',
  'rows=' + shipped.length + ' warnings=' + JSON.stringify(layerWarnings))

// 2. The kill switch the file documents must actually disarm the plugin.
const killWarnings: unknown[][] = []
const killed = applyEntryPatches(shipped, documentedKillSwitch() as never[], (m, ...a) => killWarnings.push([m, ...a]))
check('documented kill switch applies, no warnings', killWarnings.length === 0, JSON.stringify(killWarnings))
const resolved = resolveConfig(killed[0]?.config)
check('resolved evolution.enabled === false', resolved.evolution.enabled === false)
check('omitted fields fall back to schema defaults',
  resolved.evolution.analysis.minExperiences === 20 && resolved.benchmark.maxRuns === 10,
  'minExperiences=' + resolved.evolution.analysis.minExperiences + ' maxRuns=' + resolved.benchmark.maxRuns)

// 3. The shape this file used to document must stay rejected, so the defect
// cannot come back silently.
const oldWarnings: unknown[][] = []
const legacy = yaml.load('- update:\n    - id: dsh-evolution\n      config:\n        evolution: { enabled: false }\n') as never[]
const legacyOut = applyEntryPatches(shipped, legacy, (m, ...a) => oldWarnings.push([m, ...a]))
check('`update:` wrapper is still rejected by the engine',
  oldWarnings.length === 1 && legacyOut[0]?.config.evolution.enabled === true)

console.log(failures === 0
  ? '\nSHIPPED PATCH LAYER AND ITS DOCUMENTED KILL SWITCH BOTH WORK'
  : '\n' + failures + ' CHECK(S) FAILED  (engine at ' + HOST + ')')
process.exit(failures === 0 ? 0 : 1)
