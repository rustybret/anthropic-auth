import { afterEach, expect, mock, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAnthropic } from '@ai-sdk/anthropic'
import { AnthropicAuthPlugin } from '../index.ts'

const originalFetch = globalThis.fetch
const originalPath = process.env.OPENCODE_ANTHROPIC_AUTH_FILE

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalPath === undefined)
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  else process.env.OPENCODE_ANTHROPIC_AUTH_FILE = originalPath
})

test('stock Anthropic SDK reaches the custom fetch and refuses an obsolete custody roster before upstream I/O', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anthropic-sdk-scoped-refusal-'))
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(root, 'anthropic-auth.json')
  await writeFile(
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE,
    JSON.stringify({
      version: 1,
      claustrum: { mode: 'claustrum' },
      accounts: [
        {
          id: 'old',
          type: 'oauth',
          enabled: true,
          access: 'must-not-spend',
          refresh: 'must-not-refresh',
          expires: Date.now() + 3_600_000,
        },
      ],
    }),
    { mode: 0o600 },
  )
  const upstream = mock(() => {
    throw new Error('no network call permitted')
  })
  globalThis.fetch = upstream as unknown as typeof fetch
  const plugin = await AnthropicAuthPlugin(
    { directory: root } as never,
    {
      setInterval: mock(() => ({ unref() {} })) as never,
      clearInterval: mock(() => {}) as never,
    } as never,
  )
  try {
    const loader = (await (plugin as any).auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: '',
          refresh: 'claustrum-tombstone:v1:anthropic',
          expires: 0,
        }),
      { models: {} },
    )) as { apiKey?: string; fetch: typeof fetch }
    // Without an apiKey property the SDK aborts before calling our fetch; this
    // test would fail for that regression even if the plugin's own fetch refused.
    expect(loader).toHaveProperty('apiKey', '')
    let customFetches = 0
    const anthropic = createAnthropic({
      apiKey: loader.apiKey,
      fetch: ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        customFetches++
        return loader.fetch(input, init)
      }) as typeof fetch,
    })('claude-sonnet-4-5')
    await expect(
      anthropic.doStream({
        abortSignal: undefined,
        frequencyPenalty: undefined,
        headers: undefined,
        maxOutputTokens: 1,
        presencePenalty: undefined,
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        providerOptions: undefined,
        seed: undefined,
        stopSequences: undefined,
        temperature: undefined,
        toolChoice: undefined,
        tools: undefined,
        topK: undefined,
        topP: undefined,
      }),
    ).rejects.toThrow()
    expect(customFetches).toBe(1)
    expect(upstream).not.toHaveBeenCalled()
  } finally {
    await plugin.dispose?.()
    await rm(root, { recursive: true, force: true })
  }
})
