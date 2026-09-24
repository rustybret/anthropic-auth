import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertNotCustodyTombstone,
  buildRefreshOperationError,
  CustodyTombstoneRefreshError,
  custodyTombstoneKey,
  custodyTombstoneOAuth,
  FallbackAccountManager,
  fetchOAuthAccountProfile,
  fetchOAuthQuotaSnapshot,
  getAccountStatePath,
  getFallbackReauthLabels,
  isCustodyTombstoneOAuth,
  isPermanentRefreshError,
  loadAccounts,
  refreshClaudeOAuthToken,
  saveAccounts,
} from '@cortexkit/anthropic-auth-core'

import { AnthropicAuthPlugin } from '../index'
import { setOAuthHeaders } from '../transform'
import { extractUrl, TOKEN_URL } from './test-fetch'

const fixtureDir = join(import.meta.dir, 'fixtures', 'claustrum-golden')
const tombstoneFixture = JSON.parse(
  readFileSync(join(fixtureDir, 'tombstone.json'), 'utf8'),
) as {
  fixtures: {
    api: { provider: string; entry: Record<string, unknown> }
    oauth: { provider: string; entry: Record<string, unknown> }
  }
}

const oauthFixture = tombstoneFixture.fixtures.oauth
const apiFixture = tombstoneFixture.fixtures.api
const originalFetch = globalThis.fetch

function createMockClient() {
  return {
    auth: { set: mock(() => Promise.resolve()) },
    session: { promptAsync: mock(() => Promise.resolve()) },
  }
}

function disabledTimerOverrides() {
  return {
    setInterval: mock(
      () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
    ) as unknown as typeof setInterval,
    clearInterval: mock(() => {}) as unknown as typeof clearInterval,
  }
}

async function createTempStorage<T>(
  storage: Record<string, unknown>,
  callback: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'anthropic-custody-test-'))
  const path = join(directory, 'anthropic-auth.json')
  const previous = process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = path
  try {
    await saveAccounts(storage as never, path)
    return await callback(path)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
    else process.env.OPENCODE_ANTHROPIC_AUTH_FILE = previous
    await rm(directory, { recursive: true, force: true })
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Claustrum custody tombstones', () => {
  test('recognizes only provider-bound OAuth tombstones', () => {
    const provider = oauthFixture.provider
    const key = custodyTombstoneKey(provider)
    const productionTombstone = custodyTombstoneOAuth(provider)
    expect(oauthFixture.entry).toEqual(productionTombstone)
    const cases: Array<{ name: string; auth: unknown; recognized: boolean }> = [
      {
        name: 'production empty-access tombstone',
        auth: productionTombstone,
        recognized: true,
      },
      {
        name: 'vendored canonical empty-access tombstone',
        auth: oauthFixture.entry,
        recognized: true,
      },
      {
        name: 'noncanonical sentinel-access value is still refused at bearer boundaries',
        auth: { ...productionTombstone, access: key },
        recognized: true,
      },
      { name: 'API entry', auth: apiFixture.entry, recognized: false },
      {
        name: 'wrong-provider sentinel',
        auth: {
          ...productionTombstone,
          refresh: custodyTombstoneKey('openai'),
        },
        recognized: false,
      },
      {
        name: 'sentinel with prefix added',
        auth: { ...productionTombstone, refresh: `x${key}` },
        recognized: false,
      },
      {
        name: 'sentinel with suffix added',
        auth: { ...productionTombstone, refresh: `${key}x` },
        recognized: false,
      },
      {
        name: 'ordinary refresh token',
        auth: { ...productionTombstone, refresh: 'ordinary-refresh-token' },
        recognized: false,
      },
      {
        name: 'missing OAuth type',
        auth: { access: '', refresh: key, expires: 0 },
        recognized: false,
      },
    ]

    for (const entry of cases) {
      expect(isCustodyTombstoneOAuth(entry.auth, provider), entry.name).toBe(
        entry.recognized,
      )
    }
  })

  test('throws a non-provider-refresh error before the token endpoint', () => {
    let thrown: unknown
    try {
      assertNotCustodyTombstone(
        oauthFixture.entry.refresh,
        oauthFixture.provider,
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CustodyTombstoneRefreshError)
    expect(thrown).toMatchObject({
      code: 'custody_tombstone_refresh',
      provider: oauthFixture.provider,
    })
    expect(thrown).not.toHaveProperty('isRefreshError')
    expect(thrown).not.toHaveProperty('permanent')
    expect(thrown).not.toHaveProperty('status')
    expect(String(thrown)).toContain('local token refresh is forbidden')
  })

  test('keeps loader recognition contained by both irreversible boundaries', async () => {
    const provider = oauthFixture.provider
    const recognized = [custodyTombstoneOAuth(provider), oauthFixture.entry]
    const foreign = custodyTombstoneKey('openai')
    const values = [
      ...recognized.map((auth) => ({
        auth,
        value: String((auth as Record<string, unknown>).refresh),
        recognized: true,
      })),
      {
        auth: { type: 'oauth', access: '', refresh: foreign, expires: 0 },
        value: foreign,
        recognized: false,
      },
    ]
    const tokenEndpointCalls: string[] = []
    const fetchImpl = mock((input: unknown) => {
      tokenEndpointCalls.push(extractUrl(input as string | URL | Request))
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

    // Keep both depths in one table: separate tests drift apart invisibly.
    await expect(
      Promise.all(
        values.map(async ({ auth, value, recognized: expectedRecognition }) => {
          expect(isCustodyTombstoneOAuth(auth, provider)).toBe(
            expectedRecognition,
          )
          expect(() => assertNotCustodyTombstone(value, provider)).toThrow(
            CustodyTombstoneRefreshError,
          )
          await expect(
            refreshClaudeOAuthToken({ refreshToken: value, fetchImpl }),
          ).rejects.toBeInstanceOf(CustodyTombstoneRefreshError)
          expect(() => setOAuthHeaders(new Headers(), value)).toThrow(
            CustodyTombstoneRefreshError,
          )
        }),
      ),
    ).resolves.toBeArray()
    expect(tokenEndpointCalls).toEqual([])
  })

  test('refuses sentinel access during direct requests', async () => {
    const messageAuthorizations: string[] = []
    globalThis.fetch = mock((input: unknown, init?: RequestInit) => {
      const url = extractUrl(input as string | URL | Request)
      if (url.includes('/v1/messages')) {
        messageAuthorizations.push(
          new Headers(init?.headers).get('authorization') ?? '',
        )
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

    await createTempStorage(
      {
        version: 1,
        main: { type: 'opencode', provider: oauthFixture.provider },
        refresh: { enabled: false },
        quota: { enabled: false },
        accounts: [
          {
            id: 'fallback-1',
            type: 'oauth',
            access: 'fallback-access',
            refresh: 'fallback-refresh',
            expires: Date.now() + 60_000,
          },
        ],
      },
      async () => {
        const auth = {
          type: 'oauth',
          access: 'ordinary-access',
          refresh: 'ordinary-refresh',
          expires: Date.now() + 60_000,
        }
        const plugin = (await AnthropicAuthPlugin(
          // @ts-expect-error: minimal mock for testing
          { client: createMockClient() },
          disabledTimerOverrides(),
        )) as any
        const loaded = await plugin.auth.loader(() => Promise.resolve(auth), {
          models: {},
        } as never)
        auth.access = custodyTombstoneKey(oauthFixture.provider)

        await expect(
          loaded.fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            body: JSON.stringify({
              model: 'claude-sonnet-4-5',
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hello' }],
            }),
          }),
        ).rejects.toBeInstanceOf(CustodyTombstoneRefreshError)
        expect(messageAuthorizations).toEqual([])
        await plugin.dispose?.()
      },
    )
  })

  test('refuses a tombstone before the quota poll fetch', async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    ) as unknown as typeof fetch

    await expect(
      fetchOAuthQuotaSnapshot({
        accessToken: custodyTombstoneKey('openai'),
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(CustodyTombstoneRefreshError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('refuses a tombstone before the profile fetch', async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    ) as unknown as typeof fetch

    await expect(
      fetchOAuthAccountProfile({
        accessToken: custodyTombstoneKey('openai'),
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(CustodyTombstoneRefreshError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('refuses a tombstone before CacheKeep prewarm headers', () => {
    expect(() =>
      setOAuthHeaders(new Headers(), custodyTombstoneKey('openai'), {
        body: { model: 'claude-sonnet-4-5' },
      }),
    ).toThrow(CustodyTombstoneRefreshError)
  })

  test('refuses a tombstone before Prime fire headers', () => {
    expect(() =>
      setOAuthHeaders(new Headers(), custodyTombstoneKey('openai'), {
        body: { model: 'claude-haiku-4-5' },
      }),
    ).toThrow(CustodyTombstoneRefreshError)
  })

  test('holds a local main tombstone dark without network or refresh state', async () => {
    const fetchCalls: string[] = []
    globalThis.fetch = mock((input: unknown) => {
      const url = extractUrl(input as string | URL | Request)
      fetchCalls.push(url)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

    await createTempStorage(
      {
        version: 1,
        main: { type: 'opencode', provider: oauthFixture.provider },
        refresh: { enabled: false },
        quota: { enabled: false },
        accounts: [],
      },
      async (path) => {
        const plugin = (await AnthropicAuthPlugin(
          // @ts-expect-error: minimal mock for testing
          { client: createMockClient() },
          disabledTimerOverrides(),
        )) as any
        const loaded = await plugin.auth.loader(
          () => Promise.resolve(oauthFixture.entry as never),
          { models: {} } as never,
        )
        await expect(
          loaded.fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            body: '{}',
          }),
        ).rejects.toMatchObject({
          code: 'custody_state_mismatch',
          verdict: 'FAIL_CLOSED',
        })
        expect(fetchCalls.filter((url) => url === TOKEN_URL)).toHaveLength(0)

        const statePath = getAccountStatePath(path)
        if (existsSync(statePath)) {
          const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<
            string,
            unknown
          >
          expect(state).not.toHaveProperty('permanent')
          expect(state).not.toHaveProperty('needsReauth')
          expect(state).not.toHaveProperty('mainLastRefreshError')
          expect(state).not.toHaveProperty('backoff')
        }
        await plugin.dispose?.()
      },
    )
  })

  test('never sends a foreign-provider main tombstone to the token endpoint after expiry', async () => {
    const tokenCalls: string[] = []
    let currentAuth: Record<string, unknown> = {
      type: 'oauth',
      access: 'live-main-access',
      refresh: 'live-main-refresh',
      expires: Date.now() + 60_000,
    }
    globalThis.fetch = mock((input: unknown) => {
      const url = extractUrl(input as string | URL | Request)
      if (url === TOKEN_URL) tokenCalls.push(url)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

    await createTempStorage(
      {
        version: 1,
        main: { type: 'opencode', provider: oauthFixture.provider },
        refresh: { enabled: false },
        quota: { enabled: false },
        accounts: [
          {
            id: 'fallback-1',
            type: 'oauth',
            access: 'fallback-access',
            refresh: 'fallback-refresh',
            expires: Date.now() + 60_000,
          },
        ],
      },
      async () => {
        const plugin = (await AnthropicAuthPlugin(
          // @ts-expect-error: minimal mock for testing
          { client: createMockClient() },
          disabledTimerOverrides(),
        )) as any
        const loaded = await plugin.auth.loader(
          () => Promise.resolve(currentAuth as never),
          { models: {} } as never,
        )

        currentAuth = {
          ...custodyTombstoneOAuth('openai'),
          access: 'expired-main-access',
          expires: 0,
        }
        await expect(
          loaded.fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            body: '{}',
          }),
        ).rejects.toBeInstanceOf(CustodyTombstoneRefreshError)
        expect(tokenCalls).toEqual([])
        await plugin.dispose?.()
      },
    )
  })

  test('reconciles a real main without a resolved binding before serving OAuth', async () => {
    const fetchCalls: Array<{ url: string; authorization: string | null }> = []
    globalThis.fetch = mock((input: unknown, init?: RequestInit) => {
      const request = input instanceof Request ? input : undefined
      const headers = new Headers(init?.headers ?? request?.headers)
      fetchCalls.push({
        url: extractUrl(input as string | URL | Request),
        authorization: headers.get('authorization'),
      })
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

    await createTempStorage(
      {
        version: 1,
        main: { type: 'opencode', provider: oauthFixture.provider },
        claustrum: { mode: 'claustrum' },
        refresh: { enabled: true },
        quota: { enabled: true },
        accounts: [],
      },
      async (path) => {
        expect((await loadAccounts(path))?.claustrum?.mode).toBe('claustrum')
        const plugin = (await AnthropicAuthPlugin(
          // @ts-expect-error: minimal mock for testing
          { client: createMockClient() },
          disabledTimerOverrides(),
        )) as any
        const loaded = await plugin.auth.loader(
          () =>
            Promise.resolve({
              type: 'oauth' as const,
              access: 'real-local-access',
              refresh: 'real-local-refresh',
              expires: Date.now() + 60_000,
            }),
          { models: {} } as never,
        )

        const refused = await loaded.fetch(
          'https://api.anthropic.com/v1/messages',
          {
            method: 'POST',
            body: '{}',
          },
        )
        expect(refused.status).toBe(503)
        expect(await refused.text()).toContain('Claustrum')
        expect(fetchCalls).toEqual([])
        await plugin.dispose?.()
      },
    )
  })

  test('refuses Claude Pro/Max login before authorization while claustrum is committed', async () => {
    const authorizeImpl = mock(() =>
      Promise.resolve({
        url: 'https://example.test/authorize',
        redirectUri: 'http://localhost/callback',
        state: 'state',
        verifier: 'verifier',
      }),
    )
    const findProMaxMethod = (plugin: any) => {
      const method = plugin.auth.methods.find(
        (candidate: { label: string }) => candidate.label === 'Claude Pro/Max',
      )
      if (!method) throw new Error('missing Claude Pro/Max method')
      return method
    }
    const storage = (mode: 'claustrum' | 'local') => ({
      version: 1,
      main: { type: 'opencode', provider: oauthFixture.provider },
      claustrum: { mode },
      refresh: { enabled: false },
      quota: { enabled: false },
      accounts: [],
    })

    await createTempStorage(storage('claustrum'), async () => {
      const plugin = (await AnthropicAuthPlugin(
        // @ts-expect-error: minimal mock for testing
        { client: createMockClient() },
        { ...disabledTimerOverrides(), authorize: authorizeImpl } as any,
      )) as any
      await expect(findProMaxMethod(plugin).authorize()).rejects.toThrow(
        'Exit Claustrum mode first: /claude-account local',
      )
      expect(authorizeImpl).not.toHaveBeenCalled()
      await plugin.dispose?.()
    })

    await createTempStorage(storage('local'), async () => {
      const plugin = (await AnthropicAuthPlugin(
        // @ts-expect-error: minimal mock for testing
        { client: createMockClient() },
        { ...disabledTimerOverrides(), authorize: authorizeImpl } as any,
      )) as any
      await expect(findProMaxMethod(plugin).authorize()).resolves.toMatchObject(
        {
          url: 'https://example.test/authorize',
        },
      )
      expect(authorizeImpl).toHaveBeenCalledTimes(1)
      await plugin.dispose?.()
    })
  })

  test('fallback refresh rejects the tombstone without network or refresh classification', async () => {
    const fetchCalls: string[] = []
    const fetchImpl = mock((input: unknown) => {
      fetchCalls.push(extractUrl(input as string | URL | Request))
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
        }),
      )
    }) as unknown as typeof fetch
    const account = {
      id: 'fallback-tombstone',
      type: 'oauth' as const,
      access: 'expired-access',
      refresh: oauthFixture.entry.refresh as string,
      expires: 0,
    }
    const storage = {
      version: 1,
      main: { type: 'opencode', provider: oauthFixture.provider },
      refresh: {
        enabled: true,
        intervalMinutes: 10,
        refreshBeforeExpiryMinutes: 30,
      },
      quota: {
        enabled: true,
        checkIntervalMinutes: 5,
        minimumRemaining: { five_hour: 0, seven_day: 0 },
        failClosedOnUnknownQuota: false,
      },
      accounts: [account],
    }

    await createTempStorage(storage, async (path) => {
      const manager = new FallbackAccountManager({
        configPath: path,
        fetchImpl,
      })
      const refreshError = await manager
        .refreshAccount(account, storage as never)
        .catch((error: unknown) => error)
      expect(fetchCalls.filter((url) => url === TOKEN_URL)).toHaveLength(0)
      expect(refreshError).toBeInstanceOf(CustodyTombstoneRefreshError)
      await manager.refreshDueAccounts()
      await manager.refreshQuotaForDueAccounts()
      const loaded = await loadAccounts(path)
      expect(loaded?.accounts[0]?.type).toBe('oauth')
      if (loaded?.accounts[0]?.type === 'oauth') {
        expect(loaded.accounts[0].lastRefreshError).toBeUndefined()
        expect(loaded.accounts[0].lastQuotaRefreshError).toBeUndefined()
      }
      expect(getFallbackReauthLabels(loaded)).toEqual([])
      const classification = buildRefreshOperationError({
        error: new CustodyTombstoneRefreshError(oauthFixture.provider),
        now: 1,
        accountIdentity: account.id,
      })
      expect(isPermanentRefreshError(classification)).toBe(false)
      expect(classification.permanent).toBe(false)
    })
  })
})
