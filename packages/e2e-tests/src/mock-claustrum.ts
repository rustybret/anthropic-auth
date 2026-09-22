import { chmod, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import {
  buildFlags,
  buildFrame,
  computeProof,
  decodeHeader,
  encodeFrame,
  FrameType,
  HEADER_LEN,
  PROTOCOL_VERSION,
  Priority,
  SERVER_PROOF_DOMAIN,
} from '@cortexkit/subc-client'

const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const daemonId = Uint8Array.from({ length: 16 }, (_, index) => 200 + index)

export type FakeClaustrumCredential = {
  payload: string | Uint8Array | number[]
  account_id: string
  credential_id?: string
  record_version: number
  expires_at_ms: number
  cold?: boolean
}

export type FakeClaustrumEnrollmentProposal = {
  proposed_name?: string
  request_secret_hash?: string
}

export type FakeClaustrumAuthFailure = {
  handle?: string
  provider_status?: number
  record_version?: number
  reporter_source?: string
}

export type FakeClaustrumDaemon = {
  connectionFile: string
  credentialGets: string[]
  reportAuthFailures: FakeClaustrumAuthFailure[]
  enrollmentProposals: FakeClaustrumEnrollmentProposal[]
  waitForCredentialGet: (handle: string) => Promise<void>
  waitForEnrollmentProposal: () => Promise<void>
  stop: () => Promise<void>
}

export async function startFakeClaustrumDaemon(input: {
  directory: string
  credentials: Record<string, FakeClaustrumCredential>
  connectionFile?: string
}): Promise<FakeClaustrumDaemon> {
  const sockets = new Set<Socket>()
  const credentialGets: string[] = []
  const credentialGetWaiters = new Map<string, Set<() => void>>()
  const reportAuthFailures: FakeClaustrumAuthFailure[] = []
  const enrollmentProposals: FakeClaustrumEnrollmentProposal[] = []
  const enrollmentProposalWaiters = new Set<() => void>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buffer = Buffer.alloc(0)
    let phase: 'hello' | 'auth' | 'frames' = 'hello'
    let routeChannel: number | undefined

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([
        buffer,
        typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
      ])
      for (;;) {
        if (phase !== 'frames') {
          if (buffer.length < 4) return
          const length = buffer.readUInt32LE(0)
          if (buffer.length < 4 + length) return
          const body = JSON.parse(
            buffer.subarray(4, 4 + length).toString('utf8'),
          ) as Record<string, unknown>
          buffer = buffer.subarray(4 + length)
          if (phase === 'hello') {
            const clientNonce = Uint8Array.from(body.client_nonce as number[])
            const serverNonce = Uint8Array.from(
              { length: 32 },
              (_, index) => 100 + index,
            )
            writeHandshakeMessage(socket, {
              daemon_id: Array.from(daemonId),
              server_nonce: Array.from(serverNonce),
              daemon_ver: 'fake-daemon',
              server_proof: Array.from(
                computeProof(
                  key,
                  SERVER_PROOF_DOMAIN,
                  clientNonce,
                  serverNonce,
                  daemonId,
                ),
              ),
            })
            phase = 'auth'
          } else {
            phase = 'frames'
          }
          continue
        }

        if (buffer.length < HEADER_LEN) return
        const header = decodeHeader(buffer.subarray(0, HEADER_LEN))
        if (buffer.length < HEADER_LEN + header.len) return
        const body = buffer.subarray(HEADER_LEN, HEADER_LEN + header.len)
        buffer = buffer.subarray(HEADER_LEN + header.len)
        if (header.ty !== FrameType.Request) continue
        const request = JSON.parse(body.toString('utf8')) as {
          method?: string
          op?: string
          params?: Record<string, unknown>
        }
        if (header.channel === 0) {
          if (request.op === 'route.open') routeChannel = 7
          writeResponse(socket, header, { route_channel: 7, route_epoch: 1 })
          continue
        }
        if (header.channel !== routeChannel) {
          writeResponse(
            socket,
            header,
            { code: 'unknown_channel' },
            FrameType.Error,
          )
          continue
        }
        if (request.method === 'auth.enroll_propose') {
          enrollmentProposals.push({
            proposed_name:
              typeof request.params?.proposed_name === 'string'
                ? request.params.proposed_name
                : undefined,
            request_secret_hash:
              typeof request.params?.request_secret_hash === 'string'
                ? request.params.request_secret_hash
                : undefined,
          })
          writeResponse(socket, header, {
            result: { request_id: 'fake-enrollment-request' },
          })
          for (const resolve of enrollmentProposalWaiters) resolve()
          enrollmentProposalWaiters.clear()
          continue
        }
        if (request.method === 'auth.enroll_poll') {
          writeResponse(socket, header, { result: { status: 'pending' } })
          continue
        }
        if (request.method === 'credential.get') {
          const handle = request.params?.handle
          const credential =
            typeof handle === 'string' ? input.credentials[handle] : undefined
          if (typeof handle === 'string') credentialGets.push(handle)
          if (credential?.cold) {
            writeResponse(socket, header, {
              result: { error: { code: 'cold', class: 'transient' } },
            })
            if (typeof handle === 'string') {
              for (const resolve of credentialGetWaiters.get(handle) ?? [])
                resolve()
              credentialGetWaiters.delete(handle)
            }
            continue
          }
          writeResponse(socket, header, {
            result: credential
              ? {
                  payload: payloadBytes(credential.payload),
                  account_id: credential.account_id,
                  credential_id: credential.credential_id,
                  record_version: credential.record_version,
                  expires_at_ms: credential.expires_at_ms,
                }
              : { error: { code: 'not_found', class: 'permanent' } },
          })
          if (typeof handle === 'string') {
            for (const resolve of credentialGetWaiters.get(handle) ?? [])
              resolve()
            credentialGetWaiters.delete(handle)
          }
          continue
        }
        if (request.method === 'credential.report_auth_failure') {
          reportAuthFailures.push({
            handle:
              typeof request.params?.handle === 'string'
                ? request.params.handle
                : undefined,
            provider_status:
              typeof request.params?.provider_status === 'number'
                ? request.params.provider_status
                : undefined,
            record_version:
              typeof request.params?.record_version === 'number'
                ? request.params.record_version
                : undefined,
            reporter_source:
              typeof request.params?.reporter_source === 'string'
                ? request.params.reporter_source
                : undefined,
          })
        }
        writeResponse(socket, header, { result: {} })
      }
    })
  })
  await listen(server)
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('fake Claustrum daemon has no TCP address')
  const connectionFile =
    input.connectionFile ?? join(input.directory, 'claustrum-connection.json')
  await writeConnectionFile(connectionFile, address.port)

  return {
    connectionFile,
    credentialGets,
    reportAuthFailures,
    enrollmentProposals,
    async waitForCredentialGet(handle: string) {
      if (credentialGets.includes(handle)) return
      await new Promise<void>((resolve) => {
        const waiters = credentialGetWaiters.get(handle) ?? new Set()
        waiters.add(resolve)
        credentialGetWaiters.set(handle, waiters)
      })
    },
    async waitForEnrollmentProposal() {
      if (enrollmentProposals.length > 0) return
      await new Promise<void>((resolve) => {
        enrollmentProposalWaiters.add(resolve)
      })
    },
    async stop() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function payloadBytes(payload: FakeClaustrumCredential['payload']): number[] {
  if (typeof payload === 'string')
    return Array.from(new TextEncoder().encode(payload))
  return Array.from(payload)
}

function writeHandshakeMessage(socket: Socket, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32LE(body.length)
  socket.write(Buffer.concat([prefix, body]))
}

function writeResponse(
  socket: Socket,
  header: ReturnType<typeof decodeHeader>,
  value: unknown,
  type: FrameType = FrameType.Response,
): void {
  const frame = buildFrame(
    type,
    buildFlags(false, Priority.Interactive, false),
    header.channel,
    header.epoch,
    header.corr,
    new TextEncoder().encode(JSON.stringify(value)),
  )
  socket.write(Buffer.from(encodeFrame(frame)))
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
}

async function writeConnectionFile(path: string, port: number): Promise<void> {
  // Mirrors the production-test wire fixture because test files are not package APIs.
  await writeFile(
    path,
    JSON.stringify({
      schema: 1,
      wire_version: PROTOCOL_VERSION,
      endpoints: [{ host: '127.0.0.1', port }],
      key: Array.from(key),
      daemon_id: Array.from(daemonId),
      pid: process.pid,
      daemon_ver: 'fake-daemon',
    }),
    { mode: 0o600 },
  )
  await chmod(path, 0o600)
}
