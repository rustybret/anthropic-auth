/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanupE2ERun,
  createIsolatedEnv,
  removeE2ETempDir,
  spawnOpencode,
  sweepStaleE2ETempDirs,
  terminateChildProcess,
} from '../src/opencode-runner.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), 'anthropic-auth-e2e-hygiene-test-'))
  roots.push(root)
  return root
}

function unresponsiveChild(pid?: number) {
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    pid?: number
    kill: () => boolean
  }
  child.exitCode = null
  child.signalCode = null
  child.pid = pid
  child.kill = () => true
  return child as unknown as ChildProcess
}

describe('e2e temporary directory hygiene', () => {
  it('removes only stale sibling run directories without following symlinks', async () => {
    const root = await createRoot()
    const oldDir = join(root, 'anthropic-auth-e2e-old')
    const newDir = join(root, 'anthropic-auth-e2e-new')
    const symlinkTarget = join(root, 'symlink-target')
    const staleTime = new Date('2026-07-15T00:00:00.000Z')
    const now = new Date('2026-07-17T00:00:00.000Z')

    await Promise.all([
      mkdir(oldDir),
      mkdir(newDir),
      mkdir(symlinkTarget),
    ])
    await symlink(symlinkTarget, join(root, 'anthropic-auth-e2e-link'))
    await utimes(oldDir, staleTime, staleTime)
    await utimes(newDir, now, now)

    await sweepStaleE2ETempDirs({ root, now: now.getTime() })

    expect((await readdir(root)).sort()).toEqual([
      'anthropic-auth-e2e-link',
      'anthropic-auth-e2e-new',
      'symlink-target',
    ])
    expect((await lstat(symlinkTarget)).isDirectory()).toBe(true)
  })

  it('removes an old same-process run directory that is no longer active', async () => {
    const root = await createRoot()
    const orphanDir = join(root, 'anthropic-auth-e2e-orphan')
    const staleTime = new Date('2026-07-15T00:00:00.000Z')
    const now = new Date('2026-07-17T00:00:00.000Z')
    await mkdir(orphanDir)
    await writeFile(join(orphanDir, 'run.pid'), String(process.pid))
    await utimes(orphanDir, staleTime, staleTime)

    await sweepStaleE2ETempDirs({ root, now: now.getTime() })

    expect(await readdir(root)).toEqual([])
  })

  it('keeps an old same-process run directory while it is active', async () => {
    const root = await createRoot()
    const env = createIsolatedEnv(root)
    const staleTime = new Date('2026-07-15T00:00:00.000Z')
    const now = new Date('2026-07-17T00:00:00.000Z')
    await utimes(env.tempDir, staleTime, staleTime)

    await sweepStaleE2ETempDirs({ root, now: now.getTime() })

    expect(await readdir(root)).toEqual([env.tempDir.split('/').at(-1)])
    await removeE2ETempDir(env.tempDir, { root })
  })

  it('removes an old run directory owned by an exited process', async () => {
    const root = await createRoot()
    const deadDir = join(root, 'anthropic-auth-e2e-dead')
    const staleTime = new Date('2026-07-15T00:00:00.000Z')
    const now = new Date('2026-07-17T00:00:00.000Z')
    const child = Bun.spawn(['true'])
    const deadPid = child.pid
    await child.exited
    await mkdir(deadDir)
    await writeFile(join(deadDir, 'run.pid'), String(deadPid))
    await utimes(deadDir, staleTime, staleTime)

    await sweepStaleE2ETempDirs({ root, now: now.getTime() })

    expect(await readdir(root)).toEqual([])
  })

  it('removes a verified run directory unless the keep escape hatch is enabled', async () => {
    const root = await createRoot()
    const removedDir = join(root, 'anthropic-auth-e2e-remove')
    const keptDir = join(root, 'anthropic-auth-e2e-keep')
    await Promise.all([mkdir(removedDir), mkdir(keptDir)])

    expect(await removeE2ETempDir(removedDir, { root })).toBe(true)
    expect(
      await removeE2ETempDir(keptDir, { root, keep: true }),
    ).toBe(false)
    expect((await readdir(root)).sort()).toEqual(['anthropic-auth-e2e-keep'])
  })

  it('refuses to remove paths outside the expected prefix', async () => {
    const root = await createRoot()
    const unrelated = join(root, 'unrelated')
    await mkdir(unrelated)

    expect(await removeE2ETempDir(unrelated, { root })).toBe(false)
    expect((await lstat(unrelated)).isDirectory()).toBe(true)
  })

  it('waits for a child process to exit after requesting termination', async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null
      signalCode: NodeJS.Signals | null
      killSignals: NodeJS.Signals[]
      kill: (signal: NodeJS.Signals) => boolean
    }
    child.exitCode = null
    child.signalCode = null
    child.killSignals = []
    child.kill = (signal) => {
      child.killSignals.push(signal)
      return true
    }
    let resolved = false

    const termination = terminateChildProcess(child as unknown as ChildProcess).then(
      () => {
        resolved = true
      },
    )
    await Bun.sleep(0)

    expect(child.killSignals).toEqual(['SIGTERM'])
    expect(resolved).toBe(false)
    child.exitCode = 0
    child.emit('exit', 0, null)
    await termination
    expect(resolved).toBe(true)
  })

  it('waits for exit after escalating termination to SIGKILL', async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null
      signalCode: NodeJS.Signals | null
      killSignals: NodeJS.Signals[]
      kill: (signal: NodeJS.Signals) => boolean
    }
    child.exitCode = null
    child.signalCode = null
    child.killSignals = []
    child.kill = (signal) => {
      child.killSignals.push(signal)
      return true
    }
    let resolved = false

    const termination = terminateChildProcess(child as unknown as ChildProcess, {
      termTimeoutMs: 5,
      killExitTimeoutMs: 100,
    }).then(() => {
      resolved = true
    })
    await Bun.sleep(20)

    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(resolved).toBe(false)
    child.signalCode = 'SIGKILL'
    child.emit('exit', null, 'SIGKILL')
    await termination
    expect(resolved).toBe(true)
  })

  it('reports an unconfirmed exit after the SIGKILL fallback expires', async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null
      signalCode: NodeJS.Signals | null
      kill: () => boolean
    }
    child.exitCode = null
    child.signalCode = null
    child.kill = () => true

    const exited = await terminateChildProcess(child as unknown as ChildProcess, {
      termTimeoutMs: 5,
      killExitTimeoutMs: 5,
    })

    expect(exited).toBe(false)
  })

  it('leaves the temp directory when child exit cannot be confirmed', async () => {
    const root = await createRoot()
    const env = createIsolatedEnv(root)
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null
      signalCode: NodeJS.Signals | null
      kill: () => boolean
    }
    child.exitCode = null
    child.signalCode = null
    child.kill = () => true

    expect(
      await cleanupE2ERun({
        child: child as unknown as ChildProcess,
        tempDir: env.tempDir,
        root,
        terminationOptions: { termTimeoutMs: 5, killExitTimeoutMs: 5 },
      }),
    ).toBe(false)
    const staleTime = new Date('2026-07-15T00:00:00.000Z')
    const now = new Date('2026-07-17T00:00:00.000Z')
    await utimes(env.tempDir, staleTime, staleTime)

    await sweepStaleE2ETempDirs({ root, now: now.getTime() })

    expect(await readdir(root)).toEqual([env.tempDir.split('/').at(-1)])
    await removeE2ETempDir(env.tempDir, { root })
  })

  it('reclaims an unconfirmed-exit directory after the child is dead', async () => {
    const root = await createRoot()
    const env = createIsolatedEnv(root)
    const child = Bun.spawn(['true'])
    const deadPid = child.pid
    await child.exited

    expect(
      await cleanupE2ERun({
        child: unresponsiveChild(deadPid),
        tempDir: env.tempDir,
        root,
        terminationOptions: { termTimeoutMs: 5, killExitTimeoutMs: 5 },
      }),
    ).toBe(false)
    const staleTime = new Date('2026-07-15T00:00:00.000Z')
    const now = new Date('2026-07-17T00:00:00.000Z')
    await utimes(env.tempDir, staleTime, staleTime)

    await sweepStaleE2ETempDirs({ root, now: now.getTime() })

    expect(await readdir(root)).toEqual([])
  })

  it('protects an unconfirmed-exit directory while the child is alive', async () => {
    const root = await createRoot()
    const env = createIsolatedEnv(root)
    const child = Bun.spawn(['sleep', '30'])

    try {
      expect(
        await cleanupE2ERun({
          child: unresponsiveChild(child.pid),
          tempDir: env.tempDir,
          root,
          terminationOptions: { termTimeoutMs: 5, killExitTimeoutMs: 5 },
        }),
      ).toBe(false)
      const staleTime = new Date('2026-07-15T00:00:00.000Z')
      const now = new Date('2026-07-17T00:00:00.000Z')
      await utimes(env.tempDir, staleTime, staleTime)

      await sweepStaleE2ETempDirs({ root, now: now.getTime() })

      expect(await readdir(root)).toEqual([env.tempDir.split('/').at(-1)])
    } finally {
      child.kill()
      await child.exited
      await removeE2ETempDir(env.tempDir, { root })
    }
  })

  it('refuses child pid handoff through a planted run.pid symlink', async () => {
    const root = await createRoot()
    const env = createIsolatedEnv(root)
    const targetFile = join(root, 'handoff-target.txt')
    const runPidFile = join(env.tempDir, 'run.pid')
    await writeFile(targetFile, 'do not overwrite')
    await unlink(runPidFile)
    await symlink(targetFile, runPidFile)
    const child = Bun.spawn(['true'])
    const deadPid = child.pid
    await child.exited

    expect(
      await cleanupE2ERun({
        child: unresponsiveChild(deadPid),
        tempDir: env.tempDir,
        root,
        terminationOptions: { termTimeoutMs: 5, killExitTimeoutMs: 5 },
      }),
    ).toBe(false)
    expect(await Bun.file(targetFile).text()).toBe('do not overwrite')
    const staleTime = new Date('2026-07-15T00:00:00.000Z')
    const now = new Date('2026-07-17T00:00:00.000Z')
    await utimes(env.tempDir, staleTime, staleTime)

    await sweepStaleE2ETempDirs({ root, now: now.getTime() })

    expect((await readdir(root)).sort()).toEqual(
      [env.tempDir.split('/').at(-1), 'handoff-target.txt'].sort(),
    )
    await removeE2ETempDir(env.tempDir, { root })
  })

  it('refuses child pid handoff through a symlinked temp directory', async () => {
    const root = await createRoot()
    const env = createIsolatedEnv(root)
    const externalDir = await mkdtemp(join(tmpdir(), 'e2e-pid-target-'))
    roots.push(externalDir)
    const externalRunPid = join(externalDir, 'run.pid')
    await writeFile(externalRunPid, 'do not overwrite')
    await rm(env.tempDir, { recursive: true, force: true })
    await symlink(externalDir, env.tempDir)
    const child = Bun.spawn(['true'])
    const deadPid = child.pid
    await child.exited

    expect(
      await cleanupE2ERun({
        child: unresponsiveChild(deadPid),
        tempDir: env.tempDir,
        root,
        terminationOptions: { termTimeoutMs: 5, killExitTimeoutMs: 5 },
      }),
    ).toBe(false)
    expect(await Bun.file(externalRunPid).text()).toBe('do not overwrite')

    await unlink(env.tempDir)
    await mkdir(env.tempDir)
    await writeFile(join(env.tempDir, 'run.pid'), String(process.pid))
    const staleTime = new Date('2026-07-15T00:00:00.000Z')
    const now = new Date('2026-07-17T00:00:00.000Z')
    await utimes(env.tempDir, staleTime, staleTime)
    await sweepStaleE2ETempDirs({ root, now: now.getTime() })

    expect(await readdir(root)).toEqual([env.tempDir.split('/').at(-1)])
    await removeE2ETempDir(env.tempDir, { root })
  })

  it('removes the temp directory when setup fails before spawning a child', async () => {
    let tempDir = ''

    await expect(
      spawnOpencode({
        anthropicBaseURL: 'http://127.0.0.1:1',
        beforeSpawn: (env) => {
          tempDir = env.tempDir
          throw new Error('setup failed')
        },
      }),
    ).rejects.toThrow('setup failed')

    expect(tempDir).not.toBe('')
    expect(await Bun.file(tempDir).exists()).toBe(false)
  })

  it('surfaces spawn errors and removes the temp directory', async () => {
    const originalPath = process.env.PATH
    let tempDir = ''
    process.env.PATH = ''

    try {
      await expect(
        spawnOpencode({
          anthropicBaseURL: 'http://127.0.0.1:1',
          beforeSpawn: (env) => {
            tempDir = env.tempDir
          },
        }),
      ).rejects.toThrow(/Executable not found|ENOENT|spawn opencode/)
    } finally {
      process.env.PATH = originalPath
    }

    expect(tempDir).not.toBe('')
    expect(await Bun.file(tempDir).exists()).toBe(false)
  })
})
