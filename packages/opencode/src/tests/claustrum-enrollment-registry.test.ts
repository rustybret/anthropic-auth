import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ClaustrumEnrollmentConnection,
  getClaustrumEnrollmentPaths,
} from '@cortexkit/anthropic-auth-core'
import {
  adoptClaustrumEnrollment,
  type ClaustrumEnrollmentAdoption,
  getOpenCodeClaustrumEnrollmentPaths,
} from '../claustrum-enrollment-registry.ts'

const tempDirs: string[] = []
const adoptions: ClaustrumEnrollmentAdoption[] = []

async function paths() {
  const directory = await mkdtemp(join(tmpdir(), 'enrollment-registry-'))
  tempDirs.push(directory)
  return getClaustrumEnrollmentPaths(
    join(directory, 'opencode-enrollment.json'),
  )
}

async function eventually(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition not reached')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

afterEach(async () => {
  for (const adoption of adoptions.splice(0)) adoption.release()
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('getOpenCodeClaustrumEnrollmentPaths', () => {
  test('uses one host-global OpenCode identity path rather than an account-store path', () => {
    expect(
      getOpenCodeClaustrumEnrollmentPaths(
        { XDG_STATE_HOME: '/state' },
        '/project',
      ),
    ).toEqual({
      tokenPath: '/state/cortexkit/anthropic-auth/opencode-enrollment.json',
      statePath:
        '/state/cortexkit/anthropic-auth/opencode-enrollment-state.json',
    })
    expect(
      getOpenCodeClaustrumEnrollmentPaths(
        {
          OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE:
            'private/token.json',
        },
        '/project',
      ),
    ).toEqual({
      tokenPath: '/project/private/token.json',
      statePath: '/project/private/token-state.json',
    })
  })
})

describe('adoptClaustrumEnrollment', () => {
  test('shares one ceremony and connection across project plugin instances', async () => {
    const enrollmentPaths = await paths()
    let connects = 0
    let closes = 0
    let proposals = 0
    let polls = 0
    const connection: ClaustrumEnrollmentConnection = {
      enrollPropose: async () => {
        proposals += 1
        return { requestId: 'request-shared' }
      },
      enrollPoll: async () => {
        polls += 1
        return { status: 'pending' }
      },
      close: () => {
        closes += 1
      },
    }
    const connect = async () => {
      connects += 1
      return connection
    }
    const statuses: string[] = []
    const first = adoptClaustrumEnrollment({
      paths: enrollmentPaths,
      connect,
      onStatus: (status) => statuses.push(status.state),
    })
    const second = adoptClaustrumEnrollment({ paths: enrollmentPaths, connect })
    adoptions.push(first, second)

    await eventually(() => first.status().state === 'pending')
    expect(connects).toBe(1)
    expect(proposals).toBe(1)
    expect(polls).toBe(1)
    expect(statuses).toContain('pending')

    first.release()
    expect(closes).toBe(0)
    second.release()
    expect(closes).toBe(1)
  })

  test('closes a late connection when the final adoption is released', async () => {
    const enrollmentPaths = await paths()
    let resolveConnection:
      | ((client: ClaustrumEnrollmentConnection) => void)
      | undefined
    let connects = 0
    let closes = 0
    const adoption = adoptClaustrumEnrollment({
      paths: enrollmentPaths,
      connect: () => {
        connects += 1
        return new Promise((resolve) => {
          resolveConnection = resolve
        })
      },
    })
    await eventually(() => connects === 1)
    adoption.release()
    resolveConnection?.({
      enrollPropose: async () => ({ requestId: 'late' }),
      enrollPoll: async () => ({ status: 'pending' }),
      close: () => {
        closes += 1
      },
    })
    await eventually(() => closes === 1)
    expect(adoption.status()).toEqual({ state: 'idle' })
  })

  test('does not connect when an approved token is already persisted', async () => {
    const enrollmentPaths = await paths()
    await writeFile(
      enrollmentPaths.tokenPath,
      `${JSON.stringify({ token: 'ab'.repeat(32), token_generation: 7 })}\n`,
      { mode: 0o600 },
    )
    let connects = 0
    const adoption = adoptClaustrumEnrollment({
      paths: enrollmentPaths,
      connect: async () => {
        connects += 1
        throw new Error('must not connect')
      },
    })
    adoptions.push(adoption)
    await eventually(() => adoption.status().state === 'approved')
    expect(adoption.status()).toEqual({
      state: 'approved',
      proposedName: 'anthropic-auth-opencode',
      tokenGeneration: 7,
    })
    expect(connects).toBe(0)
  })

  test('observes approval on an explicit reconciliation without enabling scoped serving', async () => {
    const enrollmentPaths = await paths()
    let approved = false
    const connection: ClaustrumEnrollmentConnection = {
      enrollPropose: async () => ({ requestId: 'request-approval' }),
      enrollPoll: async () =>
        approved
          ? {
              status: 'approved',
              name: 'anthropic-auth-opencode',
              token: 'cd'.repeat(32),
              tokenGeneration: 1,
            }
          : { status: 'pending' },
      close: () => {},
    }
    const adoption = adoptClaustrumEnrollment({
      paths: enrollmentPaths,
      connect: async () => connection,
    })
    adoptions.push(adoption)
    await eventually(() => adoption.status().state === 'pending')
    approved = true
    await adoption.reconcileNow()
    expect(adoption.status()).toEqual({
      state: 'approved',
      proposedName: 'anthropic-auth-opencode',
      approvedName: 'anthropic-auth-opencode',
      tokenGeneration: 1,
    })
    expect('listScoped' in connection).toBe(false)
    expect('getScoped' in connection).toBe(false)
  })
})
