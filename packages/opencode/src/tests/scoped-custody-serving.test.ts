import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStorage,
  type ClaustrumScopedClient,
  isOAuthAccount,
  type OAuthAccount,
} from '@cortexkit/anthropic-auth-core'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import { AnthropicAuthPlugin } from '../index.ts'

const testDirs: string[] = []
const originalFetch = globalThis.fetch

afterEach(async () => {
  globalThis.fetch = originalFetch
  for (const d of testDirs.splice(0)) {
    await rm(d, { recursive: true, force: true })
  }
  delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  delete process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE
  delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
})

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const EMPTY_POST = {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'claude-sonnet-5',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hello' }],
  }),
}

const mainRow: ScopedInventoryRow = {
  id: 'oauth:anthropic',
  accountId: 'provider-main-uuid',
  categories: ['anthropic-native'],
  serves: ['anthropic'],
  credentialType: 'oauth',
  refreshAdapter: 'anthropic',
  operations: ['read'],
  state: 'active',
  recordVersion: 10,
  createdAtMs: null,
}

const workRow: ScopedInventoryRow = {
  id: 'oauth:anthropic:work',
  accountId: 'provider-work-uuid',
  categories: ['anthropic-native'],
  serves: ['anthropic'],
  credentialType: 'oauth',
  refreshAdapter: 'anthropic',
  operations: ['read'],
  state: 'active',
  recordVersion: 5,
  createdAtMs: null,
}

describe('OpenCode scoped custody serving', () => {
  test('serves requests using scoped receipts and dynamically adopts newly logged-in accounts without restart', async () => {
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    const root = await mkdtemp(join(tmpdir(), 'opencode-scoped-serving-'))
    testDirs.push(root)

    const storagePath = join(root, 'anthropic-auth.json')
    const tokenPath = join(root, 'opencode-enrollment.json')
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE = storagePath
    process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = tokenPath

    await writeFile(
      tokenPath,
      JSON.stringify({ token: 'aa'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )

    const initialStorage: AccountStorage = {
      version: 1,
      claustrum: {
        mode: 'claustrum',
        scopedRoster: true,
        primaryAccount: {
          credentialId: mainRow.id,
          accountId: mainRow.accountId as any,
          state: 'active',
        },
      },
      accounts: [
        {
          id: 'work',
          label: 'work',
          type: 'oauth',
          enabled: true,
          refresh: '',
          claustrumScopedCredentialId: workRow.id,
          anthropicAccountUuid: workRow.accountId as any,
          claustrumScopedState: 'active',
        },
      ],
    }
    await writeFile(storagePath, JSON.stringify(initialStorage, null, 2), {
      mode: 0o600,
    })

    const rows = [mainRow, workRow]
    const gets: Array<{ credentialId: string }> = []
    const reports: Array<{
      credentialId: string
      recordVersion: number
      providerStatus: number
    }> = []

    const scopedClient: ClaustrumScopedClient = {
      listScoped: async () => ({
        view: `view-${rows.length}`,
        rows: [...rows],
      }),
      getScoped: async (input) => {
        gets.push(input)
        const row = rows.find((r) => r.id === input.credentialId)
        return {
          credentialId: input.credentialId,
          accountId: row?.accountId ?? 'unknown',
          material: `scoped-access-${input.credentialId}`,
          recordVersion: row?.recordVersion ?? 1,
          expiresAtMs: Date.now() + 3_600_000,
        }
      },
      reportAuthFailureScoped: async (input) => {
        reports.push(input)
      },
      close: () => {},
    }

    const authorizations: string[] = []
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/oauth/usage')) {
        return Response.json({
          five_hour: { utilization: 10 },
          seven_day: { utilization: 10 },
        })
      }
      if (url.includes('/v1/messages')) {
        authorizations.push(
          new Headers(init?.headers).get('authorization') ?? '',
        )
        return new Response(
          '{"id":"msg_1","type":"message","content":[{"type":"text","text":"hello"}]}',
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const plugin = await AnthropicAuthPlugin(
      {
        directory: root,
      } as any,
      { claustrumScopedConnect: async () => scopedClient } as any,
    )

    try {
      const result = await (plugin as any).auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth',
            access: '',
            refresh: 'claustrum-tombstone:v1:anthropic',
            expires: 0,
          }),
        { models: {} } as any,
      )

      // 1. Initial request dispatches with main scoped credential
      const firstResponse = await result.fetch(MESSAGES_URL, EMPTY_POST)
      expect(firstResponse.status).toBe(200)
      expect(authorizations).toHaveLength(1)
      expect(authorizations[0]).toBe('Bearer scoped-access-oauth:anthropic')
      expect(gets.some((g) => g.credentialId === 'oauth:anthropic')).toBe(true)

      // 2. Simulate user adding a 3rd account via `ck auth login`
      const personalRow: ScopedInventoryRow = {
        id: 'oauth:anthropic:personal',
        accountId: 'provider-personal-uuid',
        categories: ['anthropic-native'],
        serves: ['anthropic'],
        credentialType: 'oauth',
        refreshAdapter: 'anthropic',
        operations: ['read'],
        state: 'active',
        recordVersion: 1,
        createdAtMs: null,
      }
      rows.push(personalRow)

      // Trigger discovery refresh (simulating background poll)
      const runtime = (plugin as any).__scopedRuntime
      expect(runtime).toBeDefined()
      await runtime.refresh()

      // 3. Verify storage was updated with the new account
      const { loadAccounts } = await import('@cortexkit/anthropic-auth-core')
      const updatedStorage = await loadAccounts(storagePath)
      const personalAccount = updatedStorage?.accounts.find(
        (a): a is OAuthAccount =>
          isOAuthAccount(a) &&
          a.anthropicAccountUuid === 'provider-personal-uuid',
      )
      expect(personalAccount).toBeDefined()
      expect(personalAccount?.claustrumScopedCredentialId).toBe(
        'oauth:anthropic:personal',
      )
      expect(personalAccount?.claustrumScopedState).toBe('active')
    } finally {
      await plugin.dispose?.()
    }
  })

  test('reports upstream 401 auth failure to Claustrum with exact served record version', async () => {
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    const root = await mkdtemp(join(tmpdir(), 'opencode-scoped-401-'))
    testDirs.push(root)

    const storagePath = join(root, 'anthropic-auth.json')
    const tokenPath = join(root, 'opencode-enrollment.json')
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE = storagePath
    process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = tokenPath

    await writeFile(
      tokenPath,
      JSON.stringify({ token: 'bb'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )

    const initialStorage: AccountStorage = {
      version: 1,
      claustrum: {
        mode: 'claustrum',
        scopedRoster: true,
        primaryAccount: {
          credentialId: mainRow.id,
          accountId: mainRow.accountId as any,
          state: 'active',
        },
      },
      accounts: [],
    }
    await writeFile(storagePath, JSON.stringify(initialStorage, null, 2), {
      mode: 0o600,
    })

    const reports: Array<{
      credentialId: string
      recordVersion: number
      providerStatus: number
    }> = []
    const scopedClient: ClaustrumScopedClient = {
      listScoped: async () => ({ view: 'v1', rows: [mainRow] }),
      getScoped: async (input) => ({
        credentialId: input.credentialId,
        accountId: mainRow.accountId,
        material: 'revoked-token',
        recordVersion: 10,
        expiresAtMs: Date.now() + 3_600_000,
      }),
      reportAuthFailureScoped: async (input) => {
        reports.push(input)
      },
      close: () => {},
    }

    globalThis.fetch = (async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/oauth/usage')) {
        return Response.json({
          five_hour: { utilization: 10 },
          seven_day: { utilization: 10 },
        })
      }
      return new Response(
        '{"type":"error","error":{"type":"authentication_error"}}',
        {
          status: 401,
          headers: { 'content-type': 'application/json' },
        },
      )
    }) as typeof fetch

    const plugin = await AnthropicAuthPlugin(
      { directory: root } as any,
      { claustrumScopedConnect: async () => scopedClient } as any,
    )

    try {
      const result = await (plugin as any).auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth',
            access: '',
            refresh: 'claustrum-tombstone:v1:anthropic',
            expires: 0,
          }),
        { models: {} } as any,
      )

      await result.fetch(MESSAGES_URL, EMPTY_POST).catch(() => {})

      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        credentialId: 'oauth:anthropic',
        recordVersion: 10,
        providerStatus: 401,
      })
    } finally {
      await plugin.dispose?.()
    }
  })
})
