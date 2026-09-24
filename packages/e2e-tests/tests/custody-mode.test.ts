/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  custodyTombstoneKey,
  isOAuthAccount,
  loadAccounts,
  setRoutingMode,
} from '@cortexkit/anthropic-auth-core'
import { E2EHarness } from '../src/harness.ts'
import {
  type FakeClaustrumCredential,
  startFakeClaustrumDaemon,
} from '../src/mock-claustrum.ts'

let harness: E2EHarness | null = null
const roots: string[] = []
const daemons: Array<{ stop: () => Promise<void> }> = []
async function disposeFixture() {
  // A timed-out hook may finish after the next test has installed its own
  // resources. Claim all of this test's slots before awaiting teardown so
  // its eventual completion cannot erase a newer harness or stop its daemon.
  const finished = harness
  harness = null
  const retiredDaemons = daemons.splice(0)
  const retiredRoots = roots.splice(0)
  await finished?.dispose()
  await Promise.all(retiredDaemons.map((daemon) => daemon.stop()))
  await Promise.all(
    retiredRoots.map((root) => rm(root, { recursive: true, force: true })),
  )
}
afterEach(disposeFixture)

const credential = (
  access: string,
  accountId: string,
  recordVersion: number,
): FakeClaustrumCredential => ({
  payload: access,
  account_id: accountId,
  record_version: recordVersion,
  expires_at_ms: Date.now() + 3_600_000,
})
const mainId = 'oauth:anthropic'
const workId = 'oauth:anthropic:work'

describe('zero-bind scoped custody', () => {
  it('discovers, authorizes and serves a new account without handles or a restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anthropic-auth-scoped-e2e-'))
    roots.push(root)
    const credentials: Record<string, FakeClaustrumCredential> = {
      [mainId]: credential('scoped-main', 'account-main', 11),
    }
    const daemon = await startFakeClaustrumDaemon({
      directory: root,
      scopedCredentials: credentials,
    })
    daemons.push(daemon)
    harness = await E2EHarness.create({
      childEnv: {
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE:
          daemon.connectionFile,
        OPENCODE_AUTH_CONTENT: JSON.stringify({
          anthropic: {
            type: 'oauth',
            access: '',
            refresh: custodyTombstoneKey('anthropic'),
            expires: 0,
          },
        }),
      },
      beforeSpawn: async (env) => {
        const path = join(env.configDir, 'anthropic-auth.json')
        await writeFile(
          path,
          JSON.stringify({
            version: 1,
            accounts: [],
            quota: { enabled: false },
            claustrum: {
              mode: 'claustrum',
              scopedRoster: true,
              primaryAccount: {
                credentialId: mainId,
                accountId: 'account-main',
                state: 'active',
              },
            },
          }),
          { mode: 0o600 },
        )
        await writeFile(
          join(env.configDir, 'claustrum-enrollment.json'),
          JSON.stringify({ token: 'aa'.repeat(32), token_generation: 1 }),
          { mode: 0o600 },
        )
      },
    })
    harness.script([
      { type: 'text', text: 'main served' },
      { type: 'text', text: 'new account served' },
    ])
    const first = await harness.createSession()
    await harness.sendPrompt(first, 'serve main')
    await harness.waitForSessionText(first, 'main served')
    expect(harness.anthropic.requests().at(-1)?.headers.authorization).toBe(
      'Bearer scoped-main',
    )
    expect(daemon.credentialGets).toContain(mainId)
    expect(daemon.scopedLists).toBeGreaterThan(0)
    credentials[workId] = credential('scoped-work', 'account-work', 12)
    const accountPath = join(
      harness.opencode.env.configDir,
      'anthropic-auth.json',
    )
    await harness.waitFor(
      async () => {
        const storage = await loadAccounts(accountPath)
        return storage?.accounts.some(
          (a) => isOAuthAccount(a) && a.claustrumScopedCredentialId === workId,
        )
          ? true
          : undefined
      },
      { timeoutMs: 15_000, label: 'new scoped account persisted' },
    )
    const beforeMode = await loadAccounts(accountPath)
    expect(
      beforeMode?.accounts.some(
        (a) => isOAuthAccount(a) && a.claustrumScopedCredentialId === workId,
      ),
      JSON.stringify({
        rows: beforeMode?.accounts.map((a) => [
          a.id,
          isOAuthAccount(a) ? a.claustrumScopedCredentialId : 'api',
        ]),
        raw: JSON.parse(await readFile(accountPath, 'utf8')).accounts?.map(
          (a: { id: string }) => a.id,
        ),
        scopedLists: daemon.scopedLists,
        vaultIds: Object.keys(credentials),
      }),
    ).toBe(true)
    await setRoutingMode('fallback-first', accountPath)
    const afterMode = await loadAccounts(accountPath)
    expect(
      afterMode?.accounts.some(
        (a) => isOAuthAccount(a) && a.claustrumScopedCredentialId === workId,
      ),
    ).toBe(true)
    const second = await harness.createSession()
    await harness.sendPrompt(second, 'serve new fallback')
    await harness.waitForSessionText(second, 'new account served')
    expect(harness.anthropic.requests().at(-1)?.headers.authorization).toBe(
      'Bearer scoped-work',
    )
    expect(daemon.credentialGets).toContain(workId)
    expect(harness.anthropic.tokenRequests()).toBe(0)
    const state = await readFile(
      join(harness.opencode.env.configDir, 'anthropic-auth-state.json'),
      'utf8',
    )
    expect(state).not.toContain('scoped-main')
    expect(state).not.toContain('scoped-work')
  }, 120_000)

  it('refuses legacy handle-mode even when a vault daemon has a healthy credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anthropic-auth-legacy-e2e-'))
    roots.push(root)
    const daemon = await startFakeClaustrumDaemon({
      directory: root,
      scopedCredentials: {
        [mainId]: credential('must-not-send', 'account-main', 1),
      },
    })
    daemons.push(daemon)
    harness = await E2EHarness.create({
      childEnv: {
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE:
          daemon.connectionFile,
        OPENCODE_AUTH_CONTENT: JSON.stringify({
          anthropic: {
            type: 'oauth',
            access: '',
            refresh: custodyTombstoneKey('anthropic'),
            expires: 0,
          },
        }),
      },
      beforeSpawn: async (env) => {
        await writeFile(
          join(env.configDir, 'anthropic-auth.json'),
          JSON.stringify({
            version: 1,
            accounts: [],
            claustrum: { mode: 'claustrum' },
          }),
          { mode: 0o600 },
        )
      },
    })
    const session = await harness.createSession()
    await harness.startPrompt(session, 'must fail before transport')
    try {
      await harness.waitForSessionStatusType(session, 'retry', 15_000)
      expect(harness.anthropic.requests()).toHaveLength(0)
      expect(daemon.credentialGets).toHaveLength(0)
      expect(daemon.enrollmentProposals).toHaveLength(0)
      await expect(
        readFile(
          join(
            harness.opencode.env.configDir,
            'claustrum-enrollment-state.json',
          ),
          'utf8',
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await harness.abortSession(session)
    }
  }, 120_000)
})

describe('scoped credential rotations in the OpenCode process', () => {
  it('replays only the refused turn when the vault rotates before the first 401 arrives', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'anthropic-auth-scoped-rotation-e2e-'),
    )
    roots.push(root)
    const main = credential('scoped-main-v1', 'account-main', 11)
    const daemon = await startFakeClaustrumDaemon({
      directory: root,
      scopedCredentials: { [mainId]: main },
    })
    daemons.push(daemon)
    harness = await E2EHarness.create({
      childEnv: {
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE:
          daemon.connectionFile,
        OPENCODE_AUTH_CONTENT: JSON.stringify({
          anthropic: {
            type: 'oauth',
            access: '',
            refresh: custodyTombstoneKey('anthropic'),
            expires: 0,
          },
        }),
      },
      beforeSpawn: async (env) => {
        await writeFile(
          join(env.configDir, 'anthropic-auth.json'),
          JSON.stringify({
            version: 1,
            accounts: [],
            quota: { enabled: false },
            claustrum: {
              mode: 'claustrum',
              scopedRoster: true,
              primaryAccount: {
                credentialId: mainId,
                accountId: main.account_id,
                state: 'active',
              },
            },
          }),
          { mode: 0o600 },
        )
        await writeFile(
          join(env.configDir, 'claustrum-enrollment.json'),
          JSON.stringify({ token: 'aa'.repeat(32), token_generation: 1 }),
          { mode: 0o600 },
        )
      },
    })
    harness.script([
      {
        type: 'error',
        status: 401,
        errorType: 'authentication_error',
        message: 'old record rejected',
        beforeRespond: () => {
          main.payload = 'scoped-main-v2'
          main.record_version = 12
        },
      },
      { type: 'text', text: 'rotated account served' },
    ])
    const session = await harness.createSession()
    await harness.sendPrompt(session, 'test one in-flight rotation')
    await harness.waitForSessionText(session, 'rotated account served')
    const requests = harness.anthropic
      .requests()
      .filter((request) => request.body.model === 'claude-sonnet-4-5')
    expect(requests.map((request) => request.headers.authorization)).toEqual([
      'Bearer scoped-main-v1',
      'Bearer scoped-main-v2',
    ])
    expect(daemon.reportAuthFailures).toEqual([])
    expect(
      daemon.credentialGets.filter((id) => id === mainId).length,
    ).toBeGreaterThanOrEqual(2)
  }, 120_000)
})

it('late fixture cleanup cannot dispose the next test’s harness, daemon or directory', async () => {
  const previousRoot = await mkdtemp(join(tmpdir(), 'anthropic-auth-retired-'))
  const nextRoot = await mkdtemp(join(tmpdir(), 'anthropic-auth-next-'))
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let previousStops = 0
  let nextStops = 0
  harness = {
    dispose: async () => {
      entered()
      await gate
    },
  } as unknown as E2EHarness
  roots.push(previousRoot)
  daemons.push({
    stop: async () => {
      previousStops++
    },
  })
  const retiring = disposeFixture()
  try {
    await started
    harness = {
      dispose: async () => {
        nextStops++
      },
    } as unknown as E2EHarness
    await writeFile(join(nextRoot, 'marker'), 'new fixture')
    roots.push(nextRoot)
    daemons.push({
      stop: async () => {
        nextStops++
      },
    })
    release()
    await retiring
    expect(previousStops).toBe(1)
    expect(nextStops).toBe(0)
    expect(harness).not.toBeNull()
    expect(await readFile(join(nextRoot, 'marker'), 'utf8')).toBe('new fixture')
  } finally {
    release()
    await retiring
    await rm(previousRoot, { recursive: true, force: true })
    if (!roots.includes(nextRoot))
      await rm(nextRoot, { recursive: true, force: true })
    // The registered afterEach owns the next fake fixture when installed.
  }
})
