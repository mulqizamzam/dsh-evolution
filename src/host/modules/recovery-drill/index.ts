import { JSON_OBJECT_OUTPUT, defineTool, registerToolSafe, text } from '../../dsh.ts'
import type { ModuleDeps, ToolDefinition } from '../../types.ts'
import { getSandbox } from '../sandbox/index.ts'
import { artifactFilesDir, readArtifactManifest, validateArtifact } from '../activation/artifact.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

export const name = 'recovery-drill'

export function apply(deps: ModuleDeps): void {
  const tool: ToolDefinition = defineTool({
    name: 'evo_recovery_drill',
    description: 'Run a non-mutating recovery-readiness drill: verify a previous version artifact and execute its recorded test command in the host sandbox. It never changes the active version or invokes rollback.',
    parameters: {
      type: 'object',
      properties: {
        targetVersionId: { type: 'string', description: 'Optional previous version id to inspect. Defaults to the newest non-active version with an artifact.' },
      },
      required: [],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: RENDER },
    execute: async (args: never) => {
      const a = (args ?? {}) as Record<string, unknown>
      const active = await deps.store.getActiveVersion()
      const versions = await deps.store.listVersions(200)
      const requested = typeof a.targetVersionId === 'string' && a.targetVersionId ? a.targetVersionId : undefined
      const target = requested
        ? await deps.store.getVersion(requested)
        : versions.find(v => v.id !== active?.id && v.modules.length > 0)
      if (requested && !target) return neutralizeDeep({ ok: false, error: 'no version ' + requested })
      if (!target) {
        return neutralizeDeep({
          ok: true,
          drill: 'INCONCLUSIVE',
          activeVersionId: active?.id ?? null,
          targetVersionId: null,
          reason: 'No non-active version with a recoverable artifact was found.',
          mutationPerformed: false,
        })
      }
      if (target.id === active?.id) {
        return neutralizeDeep({ ok: false, error: 'recovery target is the active version; choose a previous version', mutationPerformed: false })
      }
      if (target.modules.length === 0) {
        return neutralizeDeep({
          ok: true,
          drill: 'PASS',
          activeVersionId: active?.id ?? null,
          targetVersionId: target.id,
          artifactRequired: false,
          reason: 'Target is a baseline version with no promoted module; no artifact is expected.',
          mutationPerformed: false,
        })
      }
      const root = deps.store.getRoot()
      const validation = await validateArtifact(root, target.id)
      if (!validation.valid) {
        return neutralizeDeep({
          ok: true,
          drill: 'FAIL',
          activeVersionId: active?.id ?? null,
          targetVersionId: target.id,
          artifactValid: false,
          validationErrors: validation.errors,
          mutationPerformed: false,
        })
      }
      const manifest = await readArtifactManifest(root, target.id)
      if (!manifest) {
        return neutralizeDeep({
          ok: true,
          drill: 'FAIL',
          activeVersionId: active?.id ?? null,
          targetVersionId: target.id,
          artifactValid: true,
          testPassed: false,
          reason: 'Artifact manifest disappeared after validation.',
          mutationPerformed: false,
        })
      }
      const sandbox = getSandbox()
      if (!(await sandbox.isAvailable())) {
        return neutralizeDeep({
          ok: true,
          drill: 'INCONCLUSIVE',
          activeVersionId: active?.id ?? null,
          targetVersionId: target.id,
          artifactValid: true,
          sandboxAvailable: false,
          reason: 'Sandbox unavailable; recovery test was not executed.',
          mutationPerformed: false,
        })
      }
      const result = await sandbox.exec(manifest.testCommand, {
        cwd: artifactFilesDir(root, target.id),
        timeoutMs: 30_000,
        allowNetwork: false,
      })
      const testPassed = result.exitCode === 0 && !result.timedOut && !result.oomKilled
      return neutralizeDeep({
        ok: true,
        drill: testPassed ? 'PASS' : 'FAIL',
        activeVersionId: active?.id ?? null,
        targetVersionId: target.id,
        artifactValid: true,
        sandboxAvailable: true,
        testPassed,
        testCommand: manifest.testCommand,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        oomKilled: result.oomKilled,
        durationMs: result.durationMs,
        stdout: result.stdout.slice(0, 3000),
        stderr: result.stderr.slice(0, 3000),
        mutationPerformed: false,
        note: 'This drill validates a recovery target but does not activate it or prove that the host-level rollback operation itself will succeed.',
      })
    },
  } as never)
  const result = registerToolSafe(deps.ctx, tool)
  if (!result.ok) deps.warn('recovery-drill: tool registration failed: ' + result.error)
  deps.log('recovery-drill: registered evo_recovery_drill')
}
