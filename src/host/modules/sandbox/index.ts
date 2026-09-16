import { spawn, execSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname } from 'node:path'
import { constants } from 'node:fs'
import { registerToolSafe } from '../../dsh.ts'
import type { ModuleDeps, SandboxRunner, SandboxExecOptions, SandboxExecResult } from '../../types.ts'
import { sandboxTools } from './tools.ts'

export const name = 'sandbox'
export const TOOLS = ['evo_sandbox_exec'] as const
export const readEndpoints = {}
export const writeEndpoints = {}

// ── BubblewrapSandbox ──

const ESSENTIAL_BINDS = ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc/ld.so.cache', '/etc/ssl', '/etc/resolv.conf']
const MAX_OUTPUT = 100_000

/**
 * Directory holding the Node binary running this process. A version manager
 * (nvm/volta/fnm) puts it outside the system paths, so an isolated sandbox that
 * binds only /usr and /bin cannot execute `node` at all — the candidate would
 * fail with 127 before any code ran. Bind it read-only and put it on PATH.
 */
const NODE_BIN_DIR = dirname(process.execPath)

export class BubblewrapSandbox implements SandboxRunner {
  name = 'bubblewrap'

  async isAvailable(): Promise<boolean> {
    try {
      await access('/usr/bin/bwrap', constants.X_OK)
      execSync('bwrap --version', { timeout: 2000, stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }

  async exec(command: string, options: SandboxExecOptions): Promise<SandboxExecResult> {
    const args: string[] = []
    args.push('--clearenv')

    // Essential read-only system binds
    for (const mount of ESSENTIAL_BINDS) {
      try {
        await access(mount)
        args.push('--ro-bind', mount, mount)
      } catch {
        // skip missing paths
      }
    }

    // The interpreter must be reachable, or every candidate dies with 127.
    try {
      await access(NODE_BIN_DIR)
      args.push('--ro-bind', NODE_BIN_DIR, NODE_BIN_DIR)
    } catch {
      // Fall through: a system-installed node is already covered by /usr or /bin.
    }

    // tmpfs for /tmp, /proc, /dev
    args.push('--tmpfs', '/tmp')
    args.push('--proc', '/proc')
    args.push('--dev', '/dev')

    // Working directory bind
    if (options.cwd) {
      args.push('--bind', options.cwd, options.cwd)
      args.push('--chdir', options.cwd)
    }

    // Extra mounts from caller
    for (const m of options.readOnlyMounts ?? []) {
      args.push('--ro-bind', m, m)
    }
    for (const m of options.readWriteMounts ?? []) {
      args.push('--bind', m, m)
    }

    // PID namespace isolation
    args.push('--unshare-pid')

    // Network isolation unless allowed
    if (!options.allowNetwork) {
      args.push('--unshare-net')
    }

    // Set environment variables
    for (const [key, value] of Object.entries(options.env ?? {})) {
      args.push('--setenv', key, value)
    }

    // Minimal PATH inside the sandbox, runtime first.
    args.push('--setenv', 'PATH', NODE_BIN_DIR + ':/usr/local/bin:/usr/bin:/bin')

    // Run the command through /bin/sh
    args.push('/bin/sh', '-c', command)

    return spawnWithTimeout('bwrap', args, options)
  }
}

// ── NodeProcessSandbox (fallback) ──

export class NodeProcessSandbox implements SandboxRunner {
  name = 'node-process'

  async isAvailable(): Promise<boolean> {
    return true
  }

  async exec(command: string, options: SandboxExecOptions): Promise<SandboxExecResult> {
    // Inherit host PATH so that node, npm, and other dev tools are accessible
    // when the user is in a development environment (nvm, volta, fnm etc.).
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: options.cwd ?? '/tmp',
      ...options.env,
    }

    return spawnWithTimeout('/bin/sh', ['-c', command], options, env)
  }
}

// ── shared spawn helper ──

function spawnWithTimeout(
  bin: string,
  args: string[],
  options: SandboxExecOptions,
  env?: Record<string, string>,
): Promise<SandboxExecResult> {
  return new Promise((resolve) => {
    const start = Date.now()
    let timedOut = false
    let settled = false
    let stdout = ''
    let stderr = ''

    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env,
    })

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    const finish = (code: number | null, signal?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const durationMs = Date.now() - start
      const oomKilled = stderr.includes('Out of memory') || (signal === 'SIGKILL' && !timedOut)
      resolve({
        exitCode: code,
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT),
        timedOut,
        oomKilled,
        durationMs,
        signal: signal ?? undefined,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.pid !== undefined ? process.kill(-child.pid, 'SIGKILL') : child.kill('SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      // Safety net: force-resolve if process tree is stubborn
      setTimeout(() => finish(null, 'SIGKILL'), 500)
    }, options.timeoutMs)

    child.on('close', (code, signal) => finish(code, signal ?? undefined))
    child.on('error', (error: Error) => {
      // A failed spawn (missing binary, EACCES) must not be indistinguishable
      // from a command that ran and printed nothing.
      stderr += 'sandbox spawn failed: ' + error.message
      finish(null)
    })
  })
}

// ── Singleton + module apply ──

let _sandbox: SandboxRunner | undefined

export function getSandbox(): SandboxRunner {
  if (!_sandbox) _sandbox = new BubblewrapSandbox()
  return _sandbox
}

export function apply(deps: ModuleDeps): void {
  const sandbox = new BubblewrapSandbox()
  _sandbox = sandbox

  for (const tool of sandboxTools(deps, sandbox)) {
    registerToolSafe(deps.ctx, tool as never)
  }
  deps.log('sandbox: registered evo_sandbox_exec')
}
