import { mock } from 'bun:test'
import { QUOTA_URL, TOKEN_URL } from '@cortexkit/anthropic-auth-core'
import { assertPreconnectUrl, fetchUrl } from './network-guard-utils'

export const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
export const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
export const DEFAULT_FETCH_MOCK = Symbol('anthropic-auth.default-fetch-mock')
export { QUOTA_URL, TOKEN_URL }

const messagesURL = new URL(MESSAGES_URL)

export type TestFetchInput = Parameters<typeof globalThis.fetch>[0]

export function extractUrl(input: TestFetchInput): string {
  const parsed = fetchUrl(input)
  if (parsed) return parsed.href
  if (typeof input === 'string') return input
  return input instanceof URL ? input.toString() : input.url
}

function isMessagesURL(url: string) {
  try {
    const parsed = new URL(url)
    return (
      parsed.origin === messagesURL.origin &&
      parsed.pathname === messagesURL.pathname
    )
  } catch {
    return false
  }
}

export function installDefaultFetchMock() {
  const fetchMock = Object.assign(
    mock((input: TestFetchInput) => {
      const url = extractUrl(input)
      if (url === TOKEN_URL) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }
      if (url === PROFILE_URL) {
        return Promise.resolve(new Response('unauthorized', { status: 401 }))
      }
      if (url === QUOTA_URL) {
        return Promise.resolve(new Response('unauthorized', { status: 401 }))
      }
      if (isMessagesURL(url)) {
        return Promise.resolve(new Response('unauthorized', { status: 401 }))
      }
      return Promise.reject(new Error(`Unexpected test fetch: ${url}`))
    }),
    {
      preconnect: (
        input: Parameters<typeof globalThis.fetch.preconnect>[0],
      ) => {
        assertPreconnectUrl(input)
      },
    },
  ) as unknown as typeof fetch & {
    [DEFAULT_FETCH_MOCK]?: true
  }
  Object.defineProperty(fetchMock, DEFAULT_FETCH_MOCK, { value: true })
  globalThis.fetch = fetchMock
}
