import { expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import { E2EHarness } from '../src/harness.ts'
import {
  terminateChildProcess,
  waitForOpencodeListening,
  waitForOpencodeProjectReady,
  waitForOpencodeReady,
} from '../src/opencode-runner.ts'

const noLogs = () => ({ stdout: '', stderr: '' })

test('readiness fails on terminal child exit instead of polling until its deadline', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('not ready', { status: 503 }),
  })
  const child = spawn(process.execPath, ['-e', 'process.exit(23)'], {
    stdio: 'ignore',
  })
  try {
    await expect(
      waitForOpencodeReady(child, server.url.href.replace(/\/$/, ''), noLogs),
    ).rejects.toThrow('code=23')
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
  } finally {
    await terminateChildProcess(child)
    await server.stop(true)
  }
})

test('readiness rejects an already exited process without issuing a health request', async () => {
  let requests = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => {
      requests++
      return new Response('healthy')
    },
  })
  const child = spawn(process.execPath, ['-e', 'process.exit(17)'], {
    stdio: 'ignore',
  })
  try {
    await once(child, 'exit')
    await expect(
      waitForOpencodeReady(child, server.url.href.replace(/\/$/, ''), noLogs),
    ).rejects.toThrow('code=17')
    expect(requests).toBe(0)
  } finally {
    await terminateChildProcess(child)
    await server.stop(true)
  }
})

test('successful readiness removes temporary child listeners', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json({ healthy: true }),
  })
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  try {
    await waitForOpencodeReady(
      child,
      server.url.href.replace(/\/$/, ''),
      noLogs,
    )
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
  } finally {
    await terminateChildProcess(child)
    await server.stop(true)
  }
})

test('listener discovery waits for a complete child announcement, including fragmented port digits', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    exitCode: null,
    signalCode: null,
  }) as unknown as ChildProcess
  let stdout =
    'unrelated http://127.0.0.1:9999\nopencode server listening on http://127.0.0.1:321'
  let settled = false
  const pending = waitForOpencodeListening(child, () => stdout)
  void pending.then(
    () => {
      settled = true
    },
    () => {},
  )
  try {
    child.stdout?.emit('data', Buffer.from(stdout))
    await Promise.resolve()
    expect(settled).toBe(false)
    stdout += '23\n'
    child.stdout?.emit('data', Buffer.from('23\n'))
    expect(await pending).toEqual({
      url: 'http://127.0.0.1:32123',
      port: 32123,
    })
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.stdout?.listenerCount('data')).toBe(0)
  } finally {
    child.emit('exit', 1, null)
    await pending.catch(() => {})
  }
})

test('the announced endpoint belongs to the spawned child, without a parent port reservation', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ pid: process.pid }) }); console.log('opencode server listening on http://127.0.0.1:' + server.port)`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stdout = ''
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk)
  })
  try {
    const endpoint = await waitForOpencodeListening(child, () => stdout)
    const payload: unknown = await (await fetch(endpoint.url)).json()
    if (!payload || typeof payload !== 'object' || !('pid' in payload))
      throw new Error('announced listener did not return a process ID')
    expect(payload.pid).toBe(child.pid)
  } finally {
    await terminateChildProcess(child)
  }
})

test('listener discovery fails immediately when the child exits without announcing', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(19)'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await expect(waitForOpencodeListening(child, () => '')).rejects.toThrow(
      'code=19',
    )
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.stdout?.listenerCount('data')).toBe(0)
  } finally {
    await terminateChildProcess(child)
  }
})

test('harness polling awaits an asynchronous predicate rather than accepting its Promise as true', async () => {
  const harness = Object.create(E2EHarness.prototype) as E2EHarness
  let attempts = 0
  const found = await harness.waitFor(
    async () => {
      attempts++
      await Promise.resolve()
      return attempts === 3 ? 'committed-roster' : undefined
    },
    { intervalMs: 1, timeoutMs: 200 },
  )
  expect(found).toBe('committed-roster')
  expect(attempts).toBe(3)
})

test('project readiness waits for lazy config bootstrap, not just an open listener', async () => {
  let entered!: () => void
  let release!: () => void
  const reached = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const requested: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      requested.push(url.pathname + url.search)
      if (url.pathname !== '/config')
        return new Response('unexpected request', { status: 404 })
      entered()
      await gate
      return Response.json({ configured: true })
    },
  })
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  const directory = '/private/tmp/anthropic auth-work'
  let settled = false
  const pending = waitForOpencodeProjectReady(
    child,
    server.url.href.replace(/\/$/, ''),
    directory,
  )
  void pending.then(
    () => {
      settled = true
    },
    () => {},
  )
  try {
    await reached
    expect(settled).toBe(false)
    release()
    await pending
    expect(requested).toEqual([
      `/config?directory=${encodeURIComponent(directory)}`,
    ])
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
  } finally {
    release()
    await terminateChildProcess(child)
    await server.stop(true)
  }
})

test('project readiness rejects an exited child before contacting any listener', async () => {
  let requests = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => {
      requests++
      return Response.json({ configured: true })
    },
  })
  const child = spawn(process.execPath, ['-e', 'process.exit(17)'], {
    stdio: 'ignore',
  })
  try {
    await once(child, 'exit')
    await expect(
      waitForOpencodeProjectReady(
        child,
        server.url.href.replace(/\/$/, ''),
        '/tmp/work',
      ),
    ).rejects.toThrow('code=17')
    expect(requests).toBe(0)
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
  } finally {
    await terminateChildProcess(child)
    await server.stop(true)
  }
})
