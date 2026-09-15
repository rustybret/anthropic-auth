import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createEmptyStorage,
  QuotaHeaderFeedRegistry,
  saveAccounts,
} from '@cortexkit/anthropic-auth-core'
import type { Hooks } from '@opencode-ai/plugin'
import { AnthropicAuthPlugin } from '../index'
import { resetNotificationsForTest } from '../rpc/notifications'
import { discoverPortFile } from '../rpc/port-file'
import { getRpcDir } from '../rpc/rpc-dir'
import type { RpcServerHandle } from '../rpc/rpc-server'

type RpcGlobal = typeof globalThis & {
  __anthropicAuthRpcServers?: Map<string, RpcServerHandle>
}

let testRoot: string
let previousRpcDir: string | undefined
let previousAccountFile: string | undefined
let previousSidebarStateFile: string | undefined
let previousCacheKeepRegistryDir: string | undefined
let previousQuotaFeedDir: string | undefined
let startedRpcDirs: Set<string>
let createdPlugins: Hooks[]

const disabledPluginRuntimeOverrides = {
  setInterval: mock(
    () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
  ) as unknown as typeof setInterval,
  clearInterval: mock(() => {}) as unknown as typeof clearInterval,
}

function createMockClient(applyMarker?: string) {
  return {
    auth: { set: mock(() => Promise.resolve()) },
    session: {
      promptAsync: mock(() =>
        applyMarker
          ? Promise.reject(new Error(applyMarker))
          : Promise.resolve(),
      ),
    },
  }
}

async function getPlugin(
  directory: string,
  applyMarker?: string,
): Promise<Hooks> {
  const plugin = AnthropicAuthPlugin as unknown as (
    ctx: Parameters<typeof AnthropicAuthPlugin>[0],
    runtimeOverrides: typeof disabledPluginRuntimeOverrides,
  ) => ReturnType<typeof AnthropicAuthPlugin>
  startedRpcDirs.add(getRpcDir(directory))
  const hooks = await plugin(
    {
      // @ts-expect-error: minimal mock for testing
      client: createMockClient(applyMarker),
      directory,
    },
    disabledPluginRuntimeOverrides,
  )
  createdPlugins.push(hooks)
  return hooks
}

async function applyViaRpc(
  entry: { port: number; token: string },
  sessionId: string,
) {
  const response = await fetch(`http://127.0.0.1:${entry.port}/rpc/apply`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${entry.token}`,
    },
    body: JSON.stringify({
      command: 'claude-start',
      arguments: '',
      sessionId,
    }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as { text: string }
}

async function stopRpcServers() {
  const rpcGlobal = globalThis as RpcGlobal
  const servers = rpcGlobal.__anthropicAuthRpcServers
  const handles = new Set<RpcServerHandle>(servers?.values() ?? [])
  await Promise.all([...handles].map((server) => server.stop()))
  if (servers) {
    servers.clear()
    rpcGlobal.__anthropicAuthRpcServers = undefined
  }
}

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'aa-rpc-multi-project-'))
  startedRpcDirs = new Set()
  createdPlugins = []
  previousRpcDir = process.env.OPENCODE_ANTHROPIC_AUTH_RPC_DIR
  previousAccountFile = process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  previousSidebarStateFile =
    process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE
  previousCacheKeepRegistryDir =
    process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR
  previousQuotaFeedDir = process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR
  process.env.OPENCODE_ANTHROPIC_AUTH_RPC_DIR = '.rpc'
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(
    testRoot,
    'anthropic-auth.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = join(
    testRoot,
    'sidebar-state.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR = join(
    testRoot,
    'cachekeep-registry',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR = join(
    testRoot,
    'quota-header-feed',
  )
  await stopRpcServers()
})

afterEach(async () => {
  try {
    for (const plugin of createdPlugins.reverse()) await plugin.dispose?.()
    for (const rpcDir of startedRpcDirs) {
      expect(
        (globalThis as RpcGlobal).__anthropicAuthRpcServers?.get(rpcDir),
      ).toBeUndefined()
      expect(await discoverPortFile(rpcDir)).toBeNull()
    }
  } finally {
    await stopRpcServers()
    if (previousRpcDir === undefined) {
      delete process.env.OPENCODE_ANTHROPIC_AUTH_RPC_DIR
    } else {
      process.env.OPENCODE_ANTHROPIC_AUTH_RPC_DIR = previousRpcDir
    }
    if (previousAccountFile === undefined) {
      delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
    } else {
      process.env.OPENCODE_ANTHROPIC_AUTH_FILE = previousAccountFile
    }
    if (previousSidebarStateFile === undefined) {
      delete process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE
    } else {
      process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE =
        previousSidebarStateFile
    }
    if (previousCacheKeepRegistryDir === undefined) {
      delete process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR
    } else {
      process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR =
        previousCacheKeepRegistryDir
    }
    if (previousQuotaFeedDir === undefined) {
      delete process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR
    } else {
      process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR = previousQuotaFeedDir
    }
    await rm(testRoot, { recursive: true, force: true })
    resetNotificationsForTest()
  }
})

describe('RPC server lifecycle', () => {
  test('dispose stops and removes its server when feed cleanup rejects', async () => {
    await saveAccounts({
      ...createEmptyStorage(),
      quotaHeaderFeed: { enabled: true },
    })
    const originalDispose = QuotaHeaderFeedRegistry.prototype.dispose
    QuotaHeaderFeedRegistry.prototype.dispose = async () => {
      throw new Error('feed disposal failed')
    }
    try {
      const directory = join(testRoot, 'project')
      const plugin = await getPlugin(directory)
      const rpcDir = getRpcDir(directory)
      const entry = await discoverPortFile(rpcDir)

      expect(entry).not.toBeNull()
      await plugin.dispose?.()

      expect(await discoverPortFile(rpcDir)).toBeNull()
      expect(
        (globalThis as RpcGlobal).__anthropicAuthRpcServers?.get(rpcDir),
      ).toBeUndefined()
      await expect(
        fetch(`http://127.0.0.1:${entry?.port}/health`),
      ).rejects.toThrow()
    } finally {
      QuotaHeaderFeedRegistry.prototype.dispose = originalDispose
    }
  })

  test('keeps RPC servers live for distinct project directories', async () => {
    const directoryA = join(testRoot, 'project-a')
    const directoryB = join(testRoot, 'project-b')

    await getPlugin(directoryA)
    await getPlugin(directoryB)

    const entryA = await discoverPortFile(getRpcDir(directoryA))
    const entryB = await discoverPortFile(getRpcDir(directoryB))

    expect(entryA).not.toBeNull()
    expect(entryB).not.toBeNull()
    expect(entryA?.port).not.toBe(entryB?.port)
  })

  test('each project RPC server applies through its own plugin instance', async () => {
    const directoryA = join(testRoot, 'project-a')
    const directoryB = join(testRoot, 'project-b')
    await getPlugin(directoryA, 'applied by project-a')
    await getPlugin(directoryB, 'applied by project-b')

    const entryA = await discoverPortFile(getRpcDir(directoryA))
    const entryB = await discoverPortFile(getRpcDir(directoryB))

    expect(entryA).not.toBeNull()
    expect(entryB).not.toBeNull()
    if (!entryA || !entryB) return
    expect(
      JSON.parse(
        await readFile(
          join(getRpcDir(directoryA), `port-${process.pid}.json`),
          'utf8',
        ),
      ),
    ).toMatchObject({ port: entryA.port, token: entryA.token })
    expect(
      JSON.parse(
        await readFile(
          join(getRpcDir(directoryB), `port-${process.pid}.json`),
          'utf8',
        ),
      ),
    ).toMatchObject({ port: entryB.port, token: entryB.token })

    expect((await applyViaRpc(entryA, 'session-a')).text).toContain(
      'applied by project-a',
    )
    expect((await applyViaRpc(entryB, 'session-b')).text).toContain(
      'applied by project-b',
    )
  })

  test('dispose stops its directory while another project remains live', async () => {
    const directoryA = join(testRoot, 'project-a')
    const directoryB = join(testRoot, 'project-b')
    const pluginA = await getPlugin(directoryA)
    const pluginB = await getPlugin(directoryB)
    const entryB = await discoverPortFile(getRpcDir(directoryB))

    expect(entryB).not.toBeNull()
    expect(pluginA.dispose).toBeFunction()
    await pluginA.dispose?.()

    expect(await discoverPortFile(getRpcDir(directoryA))).toBeNull()
    expect((await discoverPortFile(getRpcDir(directoryB)))?.port).toBe(
      entryB?.port,
    )
    expect(
      (await fetch(`http://127.0.0.1:${entryB?.port}/health`)).status,
    ).toBe(200)
    await pluginB.dispose?.()
  })

  test('late disposal cannot remove a same-directory successor port file', async () => {
    const directory = join(testRoot, 'project')
    const first = await getPlugin(directory)
    const second = await getPlugin(directory)
    const successor = await discoverPortFile(getRpcDir(directory))
    const successorHandle = (
      globalThis as RpcGlobal
    ).__anthropicAuthRpcServers?.get(getRpcDir(directory))

    expect(successor).not.toBeNull()
    expect(successorHandle).toBeDefined()
    await first.dispose?.()

    expect(
      (globalThis as RpcGlobal).__anthropicAuthRpcServers?.get(
        getRpcDir(directory),
      ),
    ).toBe(successorHandle)
    expect((await discoverPortFile(getRpcDir(directory)))?.port).toBe(
      successor?.port,
    )
    await second.dispose?.()
  })

  test('a dispose whose entry was replaced does not stop the successor server', async () => {
    const directory = join(testRoot, 'project')
    const first = await getPlugin(directory)
    const rpcGlobal = globalThis as RpcGlobal
    const rpcDir = getRpcDir(directory)
    const firstHandle = rpcGlobal.__anthropicAuthRpcServers?.get(rpcDir)
    const successorHandle: RpcServerHandle = {
      port: firstHandle?.port ?? 0,
      token: firstHandle?.token ?? '',
      stop: mock(async () => {}),
    }

    expect(firstHandle).toBeDefined()
    if (!firstHandle) return
    const stopSpy = mock(firstHandle.stop)
    firstHandle.stop = stopSpy
    rpcGlobal.__anthropicAuthRpcServers?.set(rpcDir, successorHandle)

    await first.dispose?.()

    // D2's port-file check would otherwise mask loss of D1.
    expect(stopSpy).not.toHaveBeenCalled()
    expect(rpcGlobal.__anthropicAuthRpcServers?.get(rpcDir)).toBe(
      successorHandle,
    )
    // Dispose refused to stop D1 by design; the spy wraps the real stop, so
    // invoking it clears the dangling server and its port file before afterEach.
    await stopSpy()
    rpcGlobal.__anthropicAuthRpcServers?.delete(rpcDir)
  })

  test('a disposed project can start a discoverable RPC server again', async () => {
    const directory = join(testRoot, 'project')
    const first = await getPlugin(directory)

    await first.dispose?.()

    const replacement = await getPlugin(directory)
    const entry = await discoverPortFile(getRpcDir(directory))
    expect(entry).not.toBeNull()
    expect((await fetch(`http://127.0.0.1:${entry?.port}/health`)).status).toBe(
      200,
    )
    await replacement.dispose?.()
  })
})
