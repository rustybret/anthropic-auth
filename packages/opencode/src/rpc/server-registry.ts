import type { RpcServerHandle } from './rpc-server'

type RpcServerGlobal = typeof globalThis & {
  __anthropicAuthRpcServers?: Map<string, RpcServerHandle>
  __anthropicAuthRpcServersPending?: Map<string, Promise<void>>
}

export interface RpcServerAdoption {
  server: RpcServerHandle
  release: () => Promise<void>
}

/**
 * Serializes same-directory replacement and returns an identity-fenced lease.
 * Distinct project directories remain independent.
 */
export async function adoptRpcServer(
  rpcDir: string,
  create: () => Promise<RpcServerHandle>,
): Promise<RpcServerAdoption> {
  const rpcGlobal = globalThis as RpcServerGlobal
  const servers =
    rpcGlobal.__anthropicAuthRpcServers ?? new Map<string, RpcServerHandle>()
  const pending =
    rpcGlobal.__anthropicAuthRpcServersPending ??
    new Map<string, Promise<void>>()
  rpcGlobal.__anthropicAuthRpcServers = servers
  rpcGlobal.__anthropicAuthRpcServersPending = pending

  const predecessor = pending.get(rpcDir) ?? Promise.resolve()
  let server: RpcServerHandle | undefined
  const start = predecessor
    .catch(() => {})
    .then(async () => {
      const previous = servers.get(rpcDir)
      if (previous) {
        await previous.stop()
        if (servers.get(rpcDir) === previous) servers.delete(rpcDir)
      }
      server = await create()
      servers.set(rpcDir, server)
    })
  pending.set(rpcDir, start)

  try {
    await start
  } finally {
    if (pending.get(rpcDir) === start) pending.delete(rpcDir)
  }
  const adoptedServer = server
  if (!adoptedServer) throw new Error('RPC server failed to start')

  return {
    server: adoptedServer,
    release: async () => {
      if (servers.get(rpcDir) !== adoptedServer) return
      await adoptedServer.stop()
      if (servers.get(rpcDir) === adoptedServer) servers.delete(rpcDir)
    },
  }
}
