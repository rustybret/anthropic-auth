import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { RpcServerHandle } from '../rpc/rpc-server'
import { adoptRpcServer } from '../rpc/server-registry'

type RpcGlobal = typeof globalThis & {
  __anthropicAuthRpcServers?: Map<string, RpcServerHandle>
  __anthropicAuthRpcServersPending?: Map<string, Promise<void>>
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function handle(port: number) {
  return {
    port,
    token: `token-${port}`,
    stop: mock(async () => {}),
  } satisfies RpcServerHandle
}

const testKeys = new Set<string>()

function testKey(label: string): string {
  const key = `rpc-server-registry-test-${label}-${crypto.randomUUID()}`
  testKeys.add(key)
  return key
}

afterEach(async () => {
  const rpcGlobal = globalThis as RpcGlobal
  for (const key of testKeys) {
    await rpcGlobal.__anthropicAuthRpcServers?.get(key)?.stop()
    rpcGlobal.__anthropicAuthRpcServers?.delete(key)
    rpcGlobal.__anthropicAuthRpcServersPending?.delete(key)
  }
  testKeys.clear()
})

describe('RPC server registry', () => {
  test('serializes same-directory replacement and fences predecessor release', async () => {
    const key = testKey('same-directory')
    const firstEntered = deferred()
    const allowFirst = deferred()
    const first = handle(1)
    const second = handle(2)
    let secondCreateCalls = 0

    const firstPromise = adoptRpcServer(key, async () => {
      firstEntered.resolve()
      await allowFirst.promise
      return first
    })
    await firstEntered.promise
    const secondPromise = adoptRpcServer(key, async () => {
      secondCreateCalls += 1
      return second
    })

    await Promise.resolve()
    expect(secondCreateCalls).toBe(0)
    allowFirst.resolve()
    const [firstAdoption, secondAdoption] = await Promise.all([
      firstPromise,
      secondPromise,
    ])

    expect(secondCreateCalls).toBe(1)
    expect(first.stop).toHaveBeenCalledTimes(1)
    expect((globalThis as RpcGlobal).__anthropicAuthRpcServers?.get(key)).toBe(
      second,
    )

    await firstAdoption.release()
    expect(second.stop).not.toHaveBeenCalled()
    await secondAdoption.release()
    expect(second.stop).toHaveBeenCalledTimes(1)
  })

  test('does not serialize different project directories', async () => {
    const firstKey = testKey('project-a')
    const secondKey = testKey('project-b')
    const firstEntered = deferred()
    const allowFirst = deferred()
    const first = handle(1)
    const second = handle(2)

    const firstPromise = adoptRpcServer(firstKey, async () => {
      firstEntered.resolve()
      await allowFirst.promise
      return first
    })
    await firstEntered.promise

    const secondAdoption = await adoptRpcServer(secondKey, async () => second)
    expect(secondAdoption.server).toBe(second)

    allowFirst.resolve()
    const firstAdoption = await firstPromise
    await firstAdoption.release()
    await secondAdoption.release()
  })
})
