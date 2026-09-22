import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaustrumEnrollmentConnection } from '../claustrum-enrollment.ts'
import {
  adoptClaustrumEnrollment,
  type ClaustrumEnrollmentAdoption,
  getHostClaustrumEnrollmentPaths,
} from '../claustrum-enrollment-registry.ts'

const dirs: string[] = []
const leases: ClaustrumEnrollmentAdoption[] = []
afterEach(async () => {
  for (const lease of leases.splice(0)) lease.release()
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'host-enrollment-'))
  dirs.push(dir)
  const env = { XDG_STATE_HOME: dir }
  return {
    opencode: getHostClaustrumEnrollmentPaths('opencode', env),
    pi: getHostClaustrumEnrollmentPaths('pi', env),
  }
}

test('host token paths and environment overrides are separate', () => {
  const env = {
    XDG_STATE_HOME: '/state',
    PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: 'private/pi.json',
  }
  expect(getHostClaustrumEnrollmentPaths('pi', env, '/project').tokenPath).toBe(
    '/project/private/pi.json',
  )
  expect(
    getHostClaustrumEnrollmentPaths('opencode', env, '/project').tokenPath,
  ).toBe('/state/cortexkit/anthropic-auth/opencode-enrollment.json')
})

test('OpenCode and Pi propose independently and persist different secrets and tokens', async () => {
  const paths = await fixture()
  const proposed: string[] = []
  const hashes: string[] = []
  const closed: string[] = []
  for (const host of ['opencode', 'pi'] as const) {
    const name = `anthropic-auth-${host}`
    const connection: ClaustrumEnrollmentConnection = {
      enrollPropose: async (input) => {
        proposed.push(input.name)
        hashes.push(input.requestSecretHash)
        return { requestId: host }
      },
      enrollPoll: async () => ({
        status: 'approved',
        name,
        token: (host === 'pi' ? '01' : '02').repeat(32),
        tokenGeneration: 1,
      }),
      close: () => {
        closed.push(host)
      },
    }
    const lease = adoptClaustrumEnrollment({
      proposedName: name,
      paths: paths[host],
      connect: async () => connection,
      pollIntervalMs: 0,
    })
    leases.push(lease)
    await lease.reconcileNow()
    expect(lease.status()).toMatchObject({
      state: 'approved',
      proposedName: name,
    })
  }
  expect(proposed).toEqual(['anthropic-auth-opencode', 'anthropic-auth-pi'])
  expect(new Set(hashes).size).toBe(2)
  const piToken = JSON.parse(await readFile(paths.pi.tokenPath, 'utf8')).token
  const ocToken = JSON.parse(
    await readFile(paths.opencode.tokenPath, 'utf8'),
  ).token
  expect(piToken).not.toBe(ocToken)
  leases[0]?.release()
  expect(closed).toEqual(['opencode'])
  expect(leases[1]?.status().state).toBe('approved')
})

test('refuses to share a token path between different consumer names', async () => {
  const paths = await fixture()
  const connect = async (): Promise<ClaustrumEnrollmentConnection> => ({
    enrollPropose: async () => ({ requestId: 'r' }),
    enrollPoll: async () => ({ status: 'pending' }),
    close: () => {},
  })
  const lease = adoptClaustrumEnrollment({
    proposedName: 'anthropic-auth-opencode',
    paths: paths.opencode,
    connect,
    pollIntervalMs: 0,
  })
  leases.push(lease)
  await lease.reconcileNow()
  expect(() =>
    adoptClaustrumEnrollment({
      proposedName: 'anthropic-auth-pi',
      paths: paths.opencode,
      connect,
      pollIntervalMs: 0,
    }),
  ).toThrow('different consumer')
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

test('unknown transport errors cannot publish the enrollment request secret', async () => {
  const paths = await fixture()
  let requestSecret = ''
  const statuses: unknown[] = []
  const lease = adoptClaustrumEnrollment({
    proposedName: 'anthropic-auth-pi',
    paths: paths.pi,
    pollIntervalMs: 0,
    onStatus: (status) => statuses.push(status),
    connect: async () => ({
      enrollPropose: async () => ({ requestId: 'r' }),
      enrollPoll: async (input) => {
        requestSecret = input.requestSecret
        throw new Error(`request failed: ${requestSecret}`)
      },
      close: () => {},
    }),
  })
  leases.push(lease)
  await lease.reconcileNow()
  expect(requestSecret).toHaveLength(64)
  expect(lease.status()).toEqual({
    state: 'unavailable',
    proposedName: 'anthropic-auth-pi',
    code: 'unavailable',
  })
  expect(JSON.stringify(statuses)).not.toContain(requestSecret)
})

test('release after propose dispatch prevents a subsequent poll', async () => {
  const paths = await fixture()
  const started = deferred<void>()
  const proposal = deferred<{ requestId: string }>()
  let polls = 0
  const lease = adoptClaustrumEnrollment({
    proposedName: 'anthropic-auth-pi',
    paths: paths.pi,
    pollIntervalMs: 0,
    connect: async () => ({
      enrollPropose: async () => {
        started.resolve()
        return proposal.promise
      },
      enrollPoll: async () => {
        polls++
        return { status: 'pending' }
      },
      close: () => {},
    }),
  })
  leases.push(lease)
  const run = lease.reconcileNow()
  await started.promise
  lease.release()
  proposal.resolve({ requestId: 'r' })
  await run
  expect(polls).toBe(0)
  expect(JSON.parse(await readFile(paths.pi.statePath, 'utf8')).requestId).toBe(
    'r',
  )
})

test('release during an already dispatched poll still durably collects its one-shot token', async () => {
  const paths = await fixture()
  const started = deferred<void>()
  const outcome =
    deferred<Awaited<ReturnType<ClaustrumEnrollmentConnection['enrollPoll']>>>()
  const lease = adoptClaustrumEnrollment({
    proposedName: 'anthropic-auth-pi',
    paths: paths.pi,
    pollIntervalMs: 0,
    connect: async () => ({
      enrollPropose: async () => ({ requestId: 'r' }),
      enrollPoll: async () => {
        started.resolve()
        return outcome.promise
      },
      close: () => {},
    }),
  })
  leases.push(lease)
  const run = lease.reconcileNow()
  await started.promise
  lease.release()
  outcome.resolve({
    status: 'approved',
    name: 'anthropic-auth-pi',
    token: '03'.repeat(32),
    tokenGeneration: 1,
  })
  await run
  expect(JSON.parse(await readFile(paths.pi.tokenPath, 'utf8')).token).toBe(
    '03'.repeat(32),
  )
})
