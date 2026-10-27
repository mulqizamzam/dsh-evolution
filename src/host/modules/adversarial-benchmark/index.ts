import { JSON_OBJECT_OUTPUT, defineTool, registerToolSafe, text } from '../../dsh.ts'
import type { CandidateModule, ModuleDeps, ToolDefinition } from '../../types.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

type Finding = { severity: 'critical' | 'high' | 'medium'; rule: string; path: string; detail: string }

const RULES: Array<{ rule: string; severity: Finding['severity']; pattern: RegExp; detail: string }> = [
  { rule: 'path-traversal', severity: 'critical', pattern: /(?:\.\.\/|\.\.\\\\|path\.join\([^\n]{0,100}\.\.)/i, detail: 'Path traversal-shaped expression; verify path containment before filesystem access.' },
  { rule: 'dynamic-code-execution', severity: 'critical', pattern: /\b(?:eval\s*\(|new\s+Function\s*\()/, detail: 'Dynamic code execution can bypass review and make behavior difficult to constrain.' },
  { rule: 'embedded-secret', severity: 'critical', pattern: /(?:api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/i, detail: 'Possible hard-coded credential; remove it and load secrets from an approved host secret store.' },
  { rule: 'shell-execution', severity: 'high', pattern: /\b(?:execSync|execFileSync|spawnSync|child_process|shell: true)\b/, detail: 'Shell or process execution requires a narrowly scoped sandbox and explicit command policy.' },
  { rule: 'network-access', severity: 'high', pattern: /\b(?:fetch\s*\(|https?\.request\s*\(|WebSocket\s*\()/, detail: 'Network access can exfiltrate data; verify egress policy and destination allowlists.' },
  { rule: 'environment-secret-access', severity: 'high', pattern: /process\.env\s*(?:\[|\.)/, detail: 'Environment access may expose credentials; restrict the execution environment.' },
  { rule: 'filesystem-mutation', severity: 'medium', pattern: /\b(?:writeFile|writeFileSync|rmSync|unlinkSync|rmdirSync)\s*\(/, detail: 'Filesystem mutation requires path containment and a disposable test workspace.' },
]

export function runAdversarialStaticSuite(candidate: CandidateModule) {
  const files = [...candidate.files, ...candidate.tests]
  const findings: Finding[] = []
  for (const file of files) {
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0
      if (rule.pattern.test(file.content)) {
        findings.push({ severity: rule.severity, rule: rule.rule, path: file.path, detail: rule.detail })
      }
    }
  }
  if (candidate.tests.length === 0) {
    findings.push({
      severity: 'high',
      rule: 'missing-candidate-tests',
      path: '(candidate)',
      detail: 'No candidate test files are attached; behavioral claims cannot be independently checked.',
    })
  }
  const criticalCount = findings.filter(f => f.severity === 'critical').length
  const highCount = findings.filter(f => f.severity === 'high').length
  return {
    suite: 'static-adversarial-v1',
    status: criticalCount > 0 ? 'FAIL' : highCount > 0 ? 'REVIEW' : 'PASS',
    filesScanned: files.length,
    findingCount: findings.length,
    criticalCount,
    highCount,
    findings,
    limitations: [
      'Static heuristics can produce false positives and cannot prove runtime safety.',
      'Candidate code was not executed by this tool.',
      'Run live sandbox benchmarks and integrity checks before promotion.',
    ],
  }
}

export const name = 'adversarial-benchmark'

export function apply(deps: ModuleDeps): void {
  const tool: ToolDefinition = defineTool({
    name: 'evo_adversarial_benchmark',
    description: 'Run a deterministic static adversarial review of candidate files and tests for path traversal, dynamic code execution, embedded secrets, shell/network access, environment access, and filesystem mutation. Does not execute candidate code.',
    parameters: {
      type: 'object',
      properties: { candidateId: { type: 'string', description: 'Candidate id to review.' } },
      required: ['candidateId'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never) => {
      const a = (args ?? {}) as Record<string, unknown>
      const candidateId = typeof a.candidateId === 'string' ? a.candidateId : ''
      if (!candidateId) return neutralizeDeep({ ok: false, error: 'candidateId is required' })
      const candidate = await deps.store.getCandidate(candidateId)
      if (!candidate) return neutralizeDeep({ ok: false, error: 'no candidate ' + candidateId })
      return neutralizeDeep({ ok: true, candidateId, ...runAdversarialStaticSuite(candidate) })
    },
  } as never)
  const result = registerToolSafe(deps.ctx, tool)
  if (!result.ok) deps.warn('adversarial-benchmark: tool registration failed: ' + result.error)
  deps.log('adversarial-benchmark: registered evo_adversarial_benchmark')
}
