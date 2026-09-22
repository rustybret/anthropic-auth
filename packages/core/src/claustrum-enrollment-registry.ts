import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  type ClaustrumEnrollmentConnection,
  ClaustrumEnrollmentManager,
  type ClaustrumEnrollmentPaths,
  type ClaustrumEnrollmentStatus,
  getClaustrumEnrollmentPaths,
} from './claustrum-enrollment.js'

const REGISTRY_SYMBOL = Symbol.for(
  'cortexkit.anthropic-auth.claustrum-enrollments.v2',
)
const PENDING_POLL_MS = 5_000
const RETRY_POLL_MS = 60_000
const UNAVAILABLE_RETRY_MS = 5_000

type Timer = ReturnType<typeof setTimeout>

type Entry = {
  readonly key: string
  readonly proposedName: string
  readonly leases: Map<symbol, (status: ClaustrumEnrollmentStatus) => void>
  readonly manager: ClaustrumEnrollmentManager
  readonly connect: () => Promise<ClaustrumEnrollmentConnection>
  readonly setTimeoutImpl: typeof setTimeout
  readonly clearTimeoutImpl: typeof clearTimeout
  readonly pollIntervalMs: number
  client?: ClaustrumEnrollmentConnection
  clientPromise?: Promise<ClaustrumEnrollmentConnection>
  status: ClaustrumEnrollmentStatus
  run?: Promise<void>
  timer?: Timer
  closed: boolean
}

type Registry = Map<string, Entry>

type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_SYMBOL]?: Registry
}

export function getHostClaustrumEnrollmentPaths(
  host: 'opencode' | 'pi',
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): ClaustrumEnrollmentPaths {
  const configured =
    env[
      `${host.toUpperCase()}_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE`
    ]?.trim()
  const tokenPath = configured
    ? isAbsolute(configured)
      ? configured
      : resolve(cwd, configured)
    : join(
        env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
        'cortexkit',
        'anthropic-auth',
        `${host}-enrollment.json`,
      )
  return getClaustrumEnrollmentPaths(tokenPath)
}

function registry(): Registry {
  const global = globalThis as GlobalWithRegistry
  if (!global[REGISTRY_SYMBOL]) global[REGISTRY_SYMBOL] = new Map()
  return global[REGISTRY_SYMBOL]
}

function notify(entry: Entry, status: ClaustrumEnrollmentStatus): void {
  entry.status = status
  for (const listener of entry.leases.values()) listener(status)
}

function schedule(entry: Entry, delayMs: number): void {
  if (entry.closed || entry.timer) return
  entry.timer = entry.setTimeoutImpl(() => {
    entry.timer = undefined
    void run(entry)
  }, delayMs)
  if (
    typeof entry.timer === 'object' &&
    entry.timer &&
    'unref' in entry.timer
  ) {
    entry.timer.unref()
  }
}

function nextDelay(
  status: ClaustrumEnrollmentStatus,
  pollIntervalMs: number,
): number | undefined {
  if (
    pollIntervalMs === 0 ||
    status.state === 'approved' ||
    status.state === 'denied' ||
    status.state === 'blocked'
  ) {
    return undefined
  }
  if (status.state === 'pending') {
    return status.retryCode ? RETRY_POLL_MS : pollIntervalMs
  }
  return UNAVAILABLE_RETRY_MS
}

async function getClient(entry: Entry): Promise<ClaustrumEnrollmentConnection> {
  if (entry.closed) throw new Error('Claustrum enrollment registry is closed')
  if (entry.client) return entry.client
  if (!entry.clientPromise) {
    entry.clientPromise = entry
      .connect()
      .then((client) => {
        if (entry.closed) {
          client.close()
          throw new Error('Claustrum enrollment registry is closed')
        }
        entry.client = client
        return client
      })
      .finally(() => {
        entry.clientPromise = undefined
      })
  }
  return entry.clientPromise
}

async function run(entry: Entry): Promise<void> {
  if (entry.closed) return
  if (entry.run) return entry.run
  entry.run = (async () => {
    let status: ClaustrumEnrollmentStatus
    try {
      status = await entry.manager.reconcile()
    } catch {
      status = {
        state: 'unavailable',
        proposedName: entry.proposedName,
        // Unknown transport/storage errors may echo one-shot bearer material.
        code: 'unavailable',
      }
      // A transport or filesystem failure is not a durable ceremony verdict. Keep
      // retrying while the process is alive; only the manager persists protocol-terminal
      // outcomes such as denied, superseded, or already_consumed.
      if (entry.closed) return
      notify(entry, status)
      if (entry.pollIntervalMs !== 0) schedule(entry, UNAVAILABLE_RETRY_MS)
      return
    }
    if (entry.closed) return
    notify(entry, status)
    const delay = nextDelay(status, entry.pollIntervalMs)
    if (delay !== undefined) schedule(entry, delay)
  })().finally(() => {
    entry.run = undefined
  })
  return entry.run
}

export interface ClaustrumEnrollmentAdoption {
  status(): ClaustrumEnrollmentStatus
  reconcileNow(): Promise<void>
  resetTerminal(): Promise<
    'reset' | 'idle' | 'refused-pending' | 'refused-approved' | 'busy'
  >
  release(): void
}

export function adoptClaustrumEnrollment(options: {
  proposedName: string
  paths: ClaustrumEnrollmentPaths
  connect: () => Promise<ClaustrumEnrollmentConnection>
  onStatus?: (status: ClaustrumEnrollmentStatus) => void
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
  pollIntervalMs?: number
}): ClaustrumEnrollmentAdoption {
  const key = resolve(options.paths.tokenPath)
  const entries = registry()
  let entry = entries.get(key)
  if (entry && entry.proposedName !== options.proposedName) {
    throw new Error(
      'Claustrum enrollment path is already owned by a different consumer',
    )
  }
  if (!entry) {
    const connect = options.connect
    const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout
    const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout
    const lazyClient = {
      enrollPropose: async (input: {
        name: string
        requestSecretHash: string
      }) => {
        const current = entry as Entry
        const client = await getClient(current)
        if (current.closed)
          throw new Error('Claustrum enrollment registry is closed')
        return client.enrollPropose(input)
      },
      enrollPoll: async (input: {
        requestId: string
        requestSecret: string
      }) => {
        const current = entry as Entry
        const client = await getClient(current)
        if (current.closed)
          throw new Error('Claustrum enrollment registry is closed')
        // Once a poll has been sent, let the manager durably collect its one-shot
        // approval even if release wins meanwhile. Only later calls are fenced.
        return client.enrollPoll(input)
      },
    }
    entry = {
      key,
      proposedName: options.proposedName,
      leases: new Map(),
      manager: new ClaustrumEnrollmentManager({
        client: lazyClient,
        paths: options.paths,
        proposedName: options.proposedName,
      }),
      connect,
      setTimeoutImpl,
      clearTimeoutImpl,
      pollIntervalMs: options.pollIntervalMs ?? PENDING_POLL_MS,
      status: { state: 'idle' },
      closed: false,
    }
    entries.set(key, entry)
  }

  const lease = Symbol(key)
  entry.leases.set(lease, options.onStatus ?? (() => {}))
  options.onStatus?.(entry.status)
  void run(entry)
  let released = false
  return {
    status: () => entry?.status ?? { state: 'idle' },
    reconcileNow: () => (entry ? run(entry) : Promise.resolve()),
    resetTerminal: async () => {
      if (!entry) return 'idle'
      const result = await entry.manager.resetTerminal()
      if (result === 'reset') {
        notify(entry, { state: 'idle' })
        await run(entry)
      }
      return result
    },
    release: () => {
      if (released || !entry) return
      released = true
      entry.leases.delete(lease)
      if (entry.leases.size > 0) return
      entry.closed = true
      if (entry.timer) {
        entry.clearTimeoutImpl(entry.timer)
        entry.timer = undefined
      }
      entry.client?.close()
      entries.delete(key)
    },
  }
}
