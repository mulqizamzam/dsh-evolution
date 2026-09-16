import { JSON_OBJECT_OUTPUT, defineTool, text } from '../../dsh.ts'
import type { ModuleDeps, SandboxExecOptions, SandboxRunner, ToolDefinition } from '../../types.ts'
import { neutralizeDeep } from '../../../lib/sanitize.ts'

const RENDER = (_args: Record<string, unknown>, value: never): Array<{ type: 'text'; text: string }> => text(value)

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000

export function sandboxTools(deps: ModuleDeps, runner: SandboxRunner): ToolDefinition[] {
  return [
    defineTool({
      name: 'evo_sandbox_exec',
      description: 'Execute a shell command inside a sandboxed environment. Uses bubblewrap (bwrap) when available for filesystem and namespace isolation; falls back to a constrained child process. Returns stdout, stderr, exit code, and timing metadata.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to execute.',
          },
          cwd: {
            type: 'string',
            description: 'Working directory for the command. Defaults to /tmp.',
          },
          timeoutMs: {
            type: 'number',
            description: 'Execution timeout in milliseconds. Capped at 120000. Defaults to 30000.',
          },
          allowNetwork: {
            type: 'boolean',
            description: 'If true, network access is not restricted. Default false.',
          },
          env: {
            type: 'object',
            description: 'Additional environment variables as key-value pairs.',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['command'],
      },
      output: {
        schema: JSON_OBJECT_OUTPUT,
        render: RENDER,
      },
      execute: async (args: never) => {
        const a = (args ?? {}) as Record<string, unknown>
        const command = typeof a.command === 'string' ? a.command : ''
        if (!command) {
          return neutralizeDeep({ ok: false, error: 'command is required and must be a non-empty string' })
        }

        const cwd = typeof a.cwd === 'string' && a.cwd.length > 0 ? a.cwd : '/tmp'
        const rawTimeout = typeof a.timeoutMs === 'number' ? Math.floor(a.timeoutMs) : DEFAULT_TIMEOUT_MS
        const timeoutMs = Math.min(Math.max(rawTimeout, 1000), MAX_TIMEOUT_MS)
        const allowNetwork = a.allowNetwork === true

        let env: Record<string, string> | undefined
        if (a.env && typeof a.env === 'object' && !Array.isArray(a.env)) {
          env = {}
          for (const [k, v] of Object.entries(a.env as Record<string, unknown>)) {
            if (typeof v === 'string') env[k] = v
          }
        }

        const options: SandboxExecOptions = {
          cwd,
          timeoutMs,
          allowNetwork,
          env,
        }

        deps.log('sandbox: exec "' + command.slice(0, 120) + '" in ' + cwd)

        const result = await runner.exec(command, options)

        return neutralizeDeep({
          ok: true,
          sandbox: runner.name,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          oomKilled: result.oomKilled,
          durationMs: result.durationMs,
          signal: result.signal,
        })
      },
    } as never),
  ]
}
