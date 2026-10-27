/* Audit script: finds all addBenchmark calls in test files and checks for
   OLD API patterns. Uses the TypeScript compiler API for accurate parsing. */
const ts = require('typescript')
const fs = require('fs')
const path = require('path')

const testDir = '/home/administrator/agent-workspace/dsh-custom/plugins/dsh-evolution/test'
const files = fs.readdirSync(testDir).filter(f => f.endsWith('.spec.ts')).sort()
// Also scan helpers/ subdirectory for .ts files
const helpersDir = path.join(testDir, 'helpers')
let helperFiles = []
try {
  helperFiles = fs.readdirSync(helpersDir).filter(f => f.endsWith('.ts')).map(f => 'helpers/' + f)
} catch { /* no helpers dir */ }
const allTestFiles = [...files, ...helperFiles]

// ── Helpers ──────────────────────────────────────────────

function propNameText(prop) {
  if (!prop.name) return null
  if (ts.isIdentifier(prop.name)) return prop.name.text
  if (ts.isStringLiteral(prop.name)) return prop.name.text
  return null // computed property name
}

function getProps(obj) {
  const map = {}
  const spreads = []
  for (const prop of obj.properties) {
    // Check for spread assignment FIRST (spreads have no name)
    if (ts.isSpreadAssignment(prop)) {
      spreads.push(prop.expression.getText())
      continue
    }
    const name = propNameText(prop)
    if (!name) continue
    if (ts.isPropertyAssignment(prop)) {
      map[name] = { kind: 'assignment', initializer: prop.initializer }
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      map[name] = { kind: 'shorthand' }
    }
  }
  return { map, spreads }
}

function getStringLiteral(init) {
  if (ts.isStringLiteral(init)) return init.text
  if (ts.isNoSubstitutionTemplateLiteral && ts.isNoSubstitutionTemplateLiteral(init)) return init.text
  return null
}

function nodeText(code, node) {
  return code.substring(node.getStart(), node.getEnd()).replace(/\s+/g, ' ').trim()
}

// ── Per-file analysis ────────────────────────────────────

function analyzeFile(relPath, absPath, content) {
  const sf = ts.createSourceFile(absPath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  const findings = []

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const called = node.expression
      if (ts.isPropertyAccessExpression(called) && called.name.text === 'addBenchmark') {
        const args = node.arguments
        let firstArg = args[0]
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1
        const storeVar = called.expression.getText(sf)

        // Unwrap `as` type assertions: `{ ... } as never` → AsExpression wrapping ObjectLiteralExpression
        if (firstArg && ts.isAsExpression(firstArg)) {
          firstArg = firstArg.expression
        }

        if (firstArg && ts.isObjectLiteralExpression(firstArg)) {
          const { map: props, spreads } = getProps(firstArg)
          const modeProp = props['mode']
          const modeInit = modeProp ? modeProp.initializer : undefined
          const modeStr = modeInit ? getStringLiteral(modeInit) : null
          const isLive = modeStr === 'live'
          const hasCommand = 'command' in props
          const hasProvenance = 'provenance' in props
          const hasCreatedAtInObj = 'createdAt' in props
          const hasSecondArg = args.length >= 2
          // Check if spread text mentions command/provenance (conditional spreads)
          const spreadMentions = spreads.map(s => s.toLowerCase()).join(' ')
          const spreadHasCommand = spreadMentions.includes('command')
          const spreadHasProvenance = spreadMentions.includes('provenance')
          const spreadHasCreatedAt = spreadMentions.includes('createdat')

          const issues = []
          if (hasCreatedAtInObj) issues.push('createdAt-in-object')
          if (isLive && !hasCommand) issues.push('missing-command-for-live')
          if (isLive && !hasProvenance) issues.push('missing-provenance-for-live')
          if (!hasSecondArg) issues.push('no-second-arg')

          findings.push({
            file: relPath,
            line,
            col: sf.getLineAndCharacterOfPosition(node.getStart()).character + 1,
            storeVar,
            mode: modeStr || (modeInit ? 'computed/other' : 'unset'),
            isLive,
            hasCommand,
            hasProvenance,
            hasCreatedAtInObj,
            hasSecondArg,
            secondArgText: hasSecondArg ? nodeText(content, args[1]) : null,
            hasSpreads: spreads.length > 0,
            spreads,
            spreadHasCommand,
            spreadHasProvenance,
            spreadHasCreatedAt,
            issues,
            hasIssues: issues.length > 0,
            callSnippet: nodeText(content, node).substring(0, 300),
          })
        } else if (firstArg && ts.isIdentifier(firstArg)) {
          // First arg is a variable (e.g., helper function passes a pre-built object)
          const hasSecondArg = args.length >= 2
          const issues = []
          if (!hasSecondArg) issues.push('no-second-arg')
          findings.push({
            file: relPath,
            line,
            col: sf.getLineAndCharacterOfPosition(node.getStart()).character + 1,
            storeVar,
            mode: 'variable-arg',
            isLive: false,
            hasCommand: 'unknown',
            hasProvenance: 'unknown',
            hasCreatedAtInObj: 'unknown',
            hasSecondArg,
            secondArgText: hasSecondArg ? nodeText(content, args[1]) : null,
            hasSpreads: false,
            spreads: [],
            spreadHasCommand: false,
            spreadHasProvenance: false,
            spreadHasCreatedAt: false,
            issues,
            hasIssues: issues.length > 0,
            callSnippet: nodeText(content, node).substring(0, 300),
          })
        } else if (firstArg) {
          // First arg exists but is not an object literal or identifier
          findings.push({
            file: relPath,
            line,
            col: sf.getLineAndCharacterOfPosition(node.getStart()).character + 1,
            storeVar,
            mode: 'unknown',
            issues: ['first-arg-not-object-literal'],
            hasIssues: true,
            callSnippet: nodeText(content, node).substring(0, 300),
          })
        } else {
          // No arguments at all (e.g. in a comment that survived)
          findings.push({
            file: relPath,
            line,
            storeVar,
            mode: 'unknown',
            issues: ['no-arguments'],
            hasIssues: false,
            callSnippet: nodeText(content, node).substring(0, 200),
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sf)
  return findings
}

// ── Main ─────────────────────────────────────────────────

const allFindings = {}
const summary = { totalCalls: 0, flagged: 0, byIssue: {} }

for (const file of allTestFiles) {
  const relPath = 'test/' + file
  const fpath = path.join(testDir, file)
  const content = fs.readFileSync(fpath, 'utf8')
  const findings = analyzeFile(relPath, fpath, content)
  if (findings.length > 0) {
    allFindings[relPath] = findings
    for (const f of findings) {
      summary.totalCalls++
      if (f.hasIssues) {
        summary.flagged++
        for (const issue of f.issues) {
          summary.byIssue[issue] = (summary.byIssue[issue] || 0) + 1
        }
      }
    }
  }
}

const reportPath = path.join(testDir, 'audit-results.json')
fs.writeFileSync(reportPath, JSON.stringify({ summary, allFindings }, null, 2))
console.log('=== Full results written to', reportPath, '===')
console.log('\n=== SUMMARY ===')
console.log(JSON.stringify(summary, null, 2))
console.log('\n=== DETAILED FINDINGS ===')
for (const [file, findings] of Object.entries(allFindings)) {
  const flagged = findings.filter(f => f.hasIssues)
  if (flagged.length > 0) {
    console.log(`\n--- ${file} (${flagged.length}/${findings.length} flagged) ---`)
    for (const f of flagged) {
      console.log(JSON.stringify(f, null, 2))
    }
  }
}
