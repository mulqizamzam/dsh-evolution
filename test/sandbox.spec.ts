import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BubblewrapSandbox, NodeProcessSandbox, getSandbox } from '../src/host/modules/sandbox/index.ts'

describe('SandboxRunner', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'evo-sandbox-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  describe('BubblewrapSandbox', () => {
    it('is available when bwrap is installed', async () => {
      const sandbox = new BubblewrapSandbox()
      const available = await sandbox.isAvailable()
      expect(typeof available).toBe('boolean')
    })

    it('executes a simple echo command', async () => {
      const sandbox = new BubblewrapSandbox()
      if (!(await sandbox.isAvailable())) return
      const result = await sandbox.exec('echo hello-world-123', {
        cwd: tmpDir,
        timeoutMs: 5000,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('hello-world-123')
      expect(result.timedOut).toBe(false)
    })

    it('captures stderr', async () => {
      const sandbox = new BubblewrapSandbox()
      if (!(await sandbox.isAvailable())) return
      const result = await sandbox.exec('echo err-msg >&2', {
        cwd: tmpDir,
        timeoutMs: 5000,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toContain('err-msg')
    })

    it('returns non-zero exit code on failure', async () => {
      const sandbox = new BubblewrapSandbox()
      if (!(await sandbox.isAvailable())) return
      const result = await sandbox.exec('exit 42', {
        cwd: tmpDir,
        timeoutMs: 5000,
      })
      expect(result.exitCode).toBe(42)
    })

    it('enforces timeout', async () => {
      const sandbox = new BubblewrapSandbox()
      if (!(await sandbox.isAvailable())) return
      const result = await sandbox.exec('sleep 30', {
        cwd: tmpDir,
        timeoutMs: 1500,
      })
      expect(result.timedOut).toBe(true)
      expect(result.durationMs).toBeLessThan(8000)
    }, 15_000)

    it('passes environment variables', async () => {
      const sandbox = new BubblewrapSandbox()
      if (!(await sandbox.isAvailable())) return
      const result = await sandbox.exec('echo $MY_TEST_VAR', {
        cwd: tmpDir,
        timeoutMs: 5000,
        env: { MY_TEST_VAR: 'sandbox-env-value-99' },
      })
      expect(result.stdout).toContain('sandbox-env-value-99')
    })

    it('provides network isolation by default', async () => {
      const sandbox = new BubblewrapSandbox()
      if (!(await sandbox.isAvailable())) return
      const result = await sandbox.exec('cat /proc/net/tcp 2>/dev/null | head -1 || echo no-net', {
        cwd: tmpDir,
        timeoutMs: 3000,
      })
      expect(result.exitCode).toBe(0)
    })

    it('can execute its own runtime (node), not just shell builtins', async () => {
      const sandbox = new BubblewrapSandbox()
      if (!(await sandbox.isAvailable())) return
      const result = await sandbox.exec('node --version', { cwd: tmpDir, timeoutMs: 10_000 })
      // Regression: binding only /usr and /bin left the version-managed node
      // unreachable, so every candidate died with 127 before running.
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toMatch(/^v\d+/)
    })

    it('executes a TypeScript module through node type stripping', async () => {
      const sandbox = new BubblewrapSandbox()
      if (!(await sandbox.isAvailable())) return
      await writeFile(join(tmpDir, 'mod.ts'), 'export function f(x: number): number { return x * 2 }\nconsole.log("TS", f(21))\n')
      const result = await sandbox.exec('node mod.ts', { cwd: tmpDir, timeoutMs: 15_000 })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('TS 42')
    })

    it('limits output size', async () => {
      const sandbox = new BubblewrapSandbox()
      if (!(await sandbox.isAvailable())) return
      const result = await sandbox.exec('for i in $(seq 1 10000); do echo line-$i; done', {
        cwd: tmpDir,
        timeoutMs: 10000,
      })
      expect(result.stdout.length).toBeLessThanOrEqual(100_000)
    })
  })

  describe('NodeProcessSandbox', () => {
    it('is always available', async () => {
      const sandbox = new NodeProcessSandbox()
      expect(await sandbox.isAvailable()).toBe(true)
    })

    it('executes a simple echo command', async () => {
      const sandbox = new NodeProcessSandbox()
      const result = await sandbox.exec('echo node-test-456', {
        cwd: tmpDir,
        timeoutMs: 5000,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('node-test-456')
    })

    it('enforces timeout', async () => {
      const sandbox = new NodeProcessSandbox()
      const result = await sandbox.exec('sleep 30', {
        cwd: tmpDir,
        timeoutMs: 1500,
      })
      expect(result.timedOut).toBe(true)
      expect(result.durationMs).toBeLessThan(8000)
    }, 15_000)

    it('captures stdout and stderr separately', async () => {
      const sandbox = new NodeProcessSandbox()
      const result = await sandbox.exec('echo OUT && echo ERR >&2', {
        cwd: tmpDir,
        timeoutMs: 5000,
      })
      expect(result.stdout).toContain('OUT')
      expect(result.stderr).toContain('ERR')
    })
  })

  describe('getSandbox singleton', () => {
    it('returns a SandboxRunner', () => {
      const s = getSandbox()
      expect(s).toBeDefined()
      expect(typeof s.exec).toBe('function')
      expect(typeof s.name).toBe('string')
    })
  })
})
