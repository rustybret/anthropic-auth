import { afterEach, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAnthropic } from '@ai-sdk/anthropic'
import {
  custodyTombstoneOAuth,
  saveAccounts,
} from '@cortexkit/anthropic-auth-core'

import { AnthropicAuthPlugin } from '../index'
import {
  connectorFor,
  credentialResponse,
  ruledMainHandle,
  writeManifest,
} from './custody-ruled-row.fixture'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

async function withFixtureEnvironment<T>(
  fn: (directory: string, accountPath: string) => Promise<T>,
): Promise<T> {
  const originalAccountPath = process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  const originalManifestPath = process.env.CLAUSTRUM_OPENCODE_HANDLES
  const directory = await mkdtemp(join(tmpdir(), 'anthropic-loader-sdk-'))
  const accountPath = join(directory, 'accounts.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath
  try {
    return await fn(directory, accountPath)
  } finally {
    if (originalAccountPath === undefined) {
      delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
    } else {
      process.env.OPENCODE_ANTHROPIC_AUTH_FILE = originalAccountPath
    }
    if (originalManifestPath === undefined) {
      delete process.env.CLAUSTRUM_OPENCODE_HANDLES
    } else {
      process.env.CLAUSTRUM_OPENCODE_HANDLES = originalManifestPath
    }
    await rm(directory, { recursive: true, force: true })
  }
}

test('restores custody environment after fixture setup throws', async () => {
  const originalAccountPath = process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  const originalManifestPath = process.env.CLAUSTRUM_OPENCODE_HANDLES

  await expect(
    withFixtureEnvironment(async (directory) => {
      await writeManifest(directory, [
        { label: 'main', handle: ruledMainHandle },
      ])
      throw new Error('fixture setup failed')
    }),
  ).rejects.toThrow('fixture setup failed')

  expect(process.env.OPENCODE_ANTHROPIC_AUTH_FILE).toBe(originalAccountPath)
  expect(process.env.CLAUSTRUM_OPENCODE_HANDLES).toBe(originalManifestPath)
})

test('routes RESUME_TAKEOVER through the Anthropic SDK fetch refusal', async () => {
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error('unexpected network request')
    },
    { preconnect: () => {} },
  ) as unknown as typeof fetch

  await withFixtureEnvironment(async (directory, accountPath) => {
    const workAltHandle = `ckh_${'W'.repeat(43)}`
    await saveAccounts(
      {
        version: 1,
        claustrum: { mode: 'claustrum' },
        accounts: [
          {
            id: 'work-alt',
            label: 'work-alt',
            type: 'oauth',
            access: 'expired-local-access',
            refresh: 'expired-local-refresh',
            expires: 0,
          },
        ],
      },
      accountPath,
    )
    await writeManifest(directory, [
      { label: 'main', handle: ruledMainHandle },
      { label: 'work-alt', handle: workAltHandle },
    ])
    const plugin = (await (
      AnthropicAuthPlugin as unknown as (
        context: Parameters<typeof AnthropicAuthPlugin>[0],
        overrides: Record<string, unknown>,
      ) => ReturnType<typeof AnthropicAuthPlugin>
    )(
      {
        client: {
          auth: { set: mock(() => Promise.resolve()) },
          session: { promptAsync: mock(() => Promise.resolve()) },
        },
      } as never,
      {
        setInterval: mock(() => ({ unref() {} })) as never,
        clearInterval: mock(() => {}) as never,
        claustrumConnector: connectorFor([], (method, params) => {
          if (method !== 'credential.get') return { result: {} }
          return credentialResponse(
            params.handle === ruledMainHandle
              ? 'vault-main-access'
              : 'vault-work-alt-access',
            1,
            Date.now() + 60_000,
            undefined,
            undefined,
          )
        }),
      },
    )) as any
    try {
      const loaded = (await plugin.auth.loader(
        () => Promise.resolve(custodyTombstoneOAuth('anthropic') as never),
        { models: {} },
      )) as { apiKey?: string; fetch: typeof fetch }
      let fetchCalls = 0
      const model = createAnthropic({
        apiKey: loaded.apiKey,
        fetch: Object.assign(
          async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            fetchCalls += 1
            return loaded.fetch(input, init)
          },
          { preconnect: () => {} },
        ) as unknown as typeof fetch,
      })('claude-sonnet-4-5')

      await expect(
        model.doStream({
          abortSignal: undefined,
          frequencyPenalty: undefined,
          headers: undefined,
          maxOutputTokens: 1,
          presencePenalty: undefined,
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
          providerOptions: undefined,
          responseFormat: undefined,
          seed: undefined,
          stopSequences: undefined,
          temperature: undefined,
          toolChoice: undefined,
          tools: undefined,
          topK: undefined,
          topP: undefined,
        } as never),
      ).rejects.toMatchObject({
        code: 'custody_state_mismatch',
        verdict: 'RESUME_TAKEOVER',
      })
      expect(fetchCalls).toBe(1)
    } finally {
      await plugin.dispose?.()
    }
  })
})
