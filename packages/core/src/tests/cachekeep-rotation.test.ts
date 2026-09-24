import { expect, test } from 'bun:test'
import { CacheKeepManager } from '../cachekeep.ts'

const bodyText = JSON.stringify({
  model: 'claude-haiku-4-5',
  max_tokens: 128,
  system: [
    {
      type: 'text',
      text: 'stable prompt',
      cache_control: { type: 'ephemeral' },
    },
  ],
  messages: [{ role: 'user', content: 'warm' }],
})

test('CacheKeep retries an in-flight 401 once with a new scoped receipt before reporting', async () => {
  const sent: string[] = []
  const reported: Array<{ status: number; version: number }> = []
  let servedVersion = 1
  const manager = new CacheKeepManager({
    loadStorage: async () => null,
    prepareHeaders: async (headers) => {
      headers.set('authorization', 'Bearer scoped-v1')
      return headers
    },
    retryOnUnauthorized: async ({ headers }) => {
      servedVersion = 2
      const rotated = new Headers(headers)
      rotated.set('authorization', 'Bearer scoped-v2')
      return rotated
    },
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      const authorization =
        new Headers(init?.headers).get('authorization') ?? ''
      sent.push(authorization)
      return new Response(
        authorization === 'Bearer scoped-v1' ? 'old token' : 'ok',
        {
          status: authorization === 'Bearer scoped-v1' ? 401 : 200,
        },
      )
    }) as typeof fetch,
    onResponse: ({ status }) => {
      reported.push({ status, version: servedVersion })
    },
  })
  try {
    expect(
      await manager.prewarmNow({
        sessionId: 'rotation-test',
        url: 'https://api.anthropic.com/v1/messages',
        headers: new Headers(),
        bodyText,
      }),
    ).toMatchObject({ ok: true })
    expect(sent).toEqual(['Bearer scoped-v1', 'Bearer scoped-v2'])
    expect(reported).toEqual([{ status: 200, version: 2 }])
  } finally {
    manager.stop()
  }
})

test('CacheKeep reports a genuine second 401 against the final receipt without a third send', async () => {
  const sent: string[] = []
  const reported: number[] = []
  let version = 1
  const manager = new CacheKeepManager({
    loadStorage: async () => null,
    prepareHeaders: (headers) => {
      headers.set('authorization', 'Bearer scoped-v1')
      return headers
    },
    retryOnUnauthorized: ({ headers }) => {
      version = 2
      const rotated = new Headers(headers)
      rotated.set('authorization', 'Bearer scoped-v2')
      return rotated
    },
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get('authorization') ?? '')
      return new Response('still rejected', { status: 401 })
    }) as typeof fetch,
    onResponse: ({ status }) => {
      if (status === 401) reported.push(version)
    },
  })
  try {
    expect(
      await manager.prewarmNow({
        sessionId: 'still-rejected',
        url: 'https://api.anthropic.com/v1/messages',
        headers: new Headers(),
        bodyText,
      }),
    ).toMatchObject({ ok: false, status: 401 })
    expect(sent).toEqual(['Bearer scoped-v1', 'Bearer scoped-v2'])
    expect(reported).toEqual([2])
  } finally {
    manager.stop()
  }
})
