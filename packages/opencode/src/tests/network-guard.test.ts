import { describe, expect, mock, test } from 'bun:test'
import {
  QUOTA_URL as CORE_QUOTA_URL,
  TOKEN_URL as CORE_TOKEN_URL,
} from '@cortexkit/anthropic-auth-core'
import { assertLoopback } from './network-guard-utils'
import { createGuardedFetch, MAX_REDIRECTS } from './setup'
import {
  DEFAULT_FETCH_MOCK,
  installDefaultFetchMock,
  MESSAGES_URL,
} from './test-fetch'

describe('test network guard', () => {
  test('rejects non-loopback fetches with an actionable error', async () => {
    await expect(
      globalThis.fetch('https://example.invalid/provider'),
    ).rejects.toThrow(
      'Blocked non-loopback fetch to https://example.invalid/provider; stub globalThis.fetch in the test',
    )
  })

  test('rejects fetches whose URL cannot be parsed', async () => {
    await expect(globalThis.fetch({} as Request)).rejects.toThrow(
      'Blocked fetch with an unparseable URL; stub globalThis.fetch in the test',
    )
  })

  test('allows fetches to loopback servers', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response('ok'),
    })

    try {
      const response = await globalThis.fetch(
        `http://127.0.0.1:${server.port}/health`,
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('ok')
    } finally {
      server.stop(true)
    }
  })

  test('allows all IPv4 addresses in the loopback block', async () => {
    for (const host of ['127.0.0.2', '127.1.2.3']) {
      expect(() =>
        assertLoopback(new URL(`http://${host}/health`)),
      ).not.toThrow()
    }
  })

  test('rejects near-miss IPv4 addresses and loopback-looking hostnames', async () => {
    for (const host of ['128.0.0.1', '27.0.0.1', '127.0.0.1.evil.com']) {
      await expect(
        globalThis.fetch(`http://${host}:8443/provider`),
      ).rejects.toThrow(
        `Blocked non-loopback fetch to http://${host}:8443/provider; stub globalThis.fetch in the test`,
      )
    }
  })

  test('rejects a loopback redirect to a non-loopback URL', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.redirect('https://example.invalid/pwned', 302),
    })

    try {
      await expect(
        globalThis.fetch(`http://127.0.0.1:${server.port}/redirect`),
      ).rejects.toThrow(
        'Blocked non-loopback fetch to https://example.invalid/pwned; stub globalThis.fetch in the test',
      )
    } finally {
      server.stop(true)
    }
  })

  test('follows redirects that stay on loopback', async () => {
    let requests = 0
    const server = Bun.serve({
      port: 0,
      fetch: (request): Response => {
        requests += 1
        const path = new URL(request.url).pathname
        if (path === '/redirect') {
          return Response.redirect(
            new URL('/middle', request.url).toString(),
            302,
          )
        }
        if (path === '/middle') {
          return Response.redirect(
            new URL('/final', request.url).toString(),
            302,
          )
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              setTimeout(() => {
                controller.enqueue(
                  new TextEncoder().encode('final body intact'),
                )
                controller.close()
              }, 25)
            },
          }),
        )
      },
    })

    try {
      const response = await globalThis.fetch(
        `http://127.0.0.1:${server.port}/redirect`,
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('final body intact')
      expect(requests).toBe(3)
    } finally {
      server.stop(true)
    }
  })

  test('propagates abort signals through a non-switching redirect', async () => {
    let requests = 0
    let secondHopStarted!: () => void
    const secondHopReady = new Promise<void>((resolve) => {
      secondHopStarted = resolve
    })
    let responseTimer: ReturnType<typeof setTimeout> | undefined
    const server = Bun.serve({
      port: 0,
      fetch: (request): Response => {
        requests += 1
        if (requests === 1) {
          return Response.redirect(
            new URL('/second', request.url).toString(),
            307,
          )
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              secondHopStarted()
              responseTimer = setTimeout(() => {
                controller.enqueue(new TextEncoder().encode('done'))
                controller.close()
              }, 500)
            },
            cancel() {
              if (responseTimer) clearTimeout(responseTimer)
            },
          }),
        )
      },
    })

    try {
      const controller = new AbortController()
      const pending = globalThis.fetch(
        `http://127.0.0.1:${server.port}/first`,
        { method: 'POST', body: 'payload', signal: controller.signal },
      )
      await secondHopReady
      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      expect(requests).toBe(2)
    } finally {
      if (responseTimer) clearTimeout(responseTimer)
      server.stop(true)
    }
  })

  test('rejects after exceeding the loopback redirect cap', async () => {
    const redirectHops = 21
    const server = Bun.serve({
      port: 0,
      fetch: (request): Response => {
        const hop = Number(new URL(request.url).pathname.slice('/hop/'.length))
        if (hop >= redirectHops) return new Response('ok')
        return Response.redirect(
          new URL(`/hop/${hop + 1}`, request.url).toString(),
          302,
        )
      },
    })

    try {
      await expect(
        globalThis.fetch(`http://127.0.0.1:${server.port}/hop/0`),
      ).rejects.toThrow('Too many redirects while fetching')
    } finally {
      server.stop(true)
    }
  })

  test('allows a redirect chain at the loopback redirect cap boundary', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request): Response => {
        const hop = Number(new URL(request.url).pathname.slice('/hop/'.length))
        if (hop < MAX_REDIRECTS) {
          return Response.redirect(
            new URL(`/hop/${hop + 1}`, request.url).toString(),
            302,
          )
        }
        return new Response('ok')
      },
    })

    try {
      const response = await globalThis.fetch(
        `http://127.0.0.1:${server.port}/hop/0`,
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('ok')
    } finally {
      server.stop(true)
    }
  })

  test('rewrites 301 and 302 non-GET requests but preserves 307 and 308 requests', async () => {
    for (const status of [301, 302, 307, 308]) {
      for (const method of ['PUT', 'POST']) {
        const seen: Array<{ method: string; body: string }> = []
        const nativeFetch = Object.assign(
          async (request: Request) => {
            seen.push({
              method: request.method,
              body: await request.clone().text(),
            })
            if (seen.length === 1) {
              return new Response(null, {
                status,
                headers: { location: 'http://127.0.0.1/final' },
              })
            }
            return new Response('ok')
          },
          { preconnect: () => {} },
        ) as unknown as typeof globalThis.fetch

        const response = await createGuardedFetch(nativeFetch)(
          'http://127.0.0.1/first',
          { method, body: 'payload' },
        )

        expect(await response.text()).toBe('ok')
        const rewrites = status === 301 || status === 302
        expect(seen).toEqual([
          { method, body: 'payload' },
          {
            method: rewrites ? 'GET' : method,
            body: rewrites ? '' : 'payload',
          },
        ])
      }
    }
  })

  test('cancels intermediate redirect bodies but preserves the final body', async () => {
    let requests = 0
    let intermediateCancels = 0
    let finalCancels = 0
    const nativeFetch = Object.assign(
      async () => {
        requests += 1
        if (requests === 1) {
          return new Response(
            new ReadableStream({
              cancel() {
                intermediateCancels += 1
              },
            }),
            {
              status: 302,
              headers: { location: 'http://127.0.0.1/second' },
            },
          )
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('terminal body'))
              controller.close()
            },
            cancel() {
              finalCancels += 1
            },
          }),
        )
      },
      { preconnect: () => {} },
    ) as unknown as typeof globalThis.fetch

    const guardedFetch = createGuardedFetch(nativeFetch)
    const response = await guardedFetch('http://127.0.0.1/first')

    expect(await response.text()).toBe('terminal body')
    expect(requests).toBe(2)
    expect(intermediateCancels).toBe(1)
    expect(finalCancels).toBe(0)
  })

  test('rejects a non-loopback target after multiple loopback hops', async () => {
    let requests = 0
    const server = Bun.serve({
      port: 0,
      fetch: (request): Response => {
        requests += 1
        const path = new URL(request.url).pathname
        if (path === '/first') {
          return Response.redirect(
            new URL('/second', request.url).toString(),
            302,
          )
        }
        return Response.redirect('https://example.invalid/pwned', 302)
      },
    })

    try {
      await expect(
        globalThis.fetch(`http://127.0.0.1:${server.port}/first`),
      ).rejects.toThrow(
        'Blocked non-loopback fetch to https://example.invalid/pwned; stub globalThis.fetch in the test',
      )
      expect(requests).toBe(2)
    } finally {
      server.stop(true)
    }
  })

  // URL.hostname keeps the brackets on an IPv6 literal, so the allow-list entry
  // has to carry them too or every [::1] request reads as non-loopback.
  test('allows the IPv6 loopback literal', () => {
    expect(() => assertLoopback(new URL('http://[::1]/health'))).not.toThrow()
  })

  test('allows IPv4-mapped IPv6 loopback and blocks non-loopback variants', () => {
    for (const host of [
      '[::ffff:127.0.0.1]',
      '[::ffff:7f00:1]',
      '127.0.0.2',
      '127.1.2.3',
    ]) {
      expect(() =>
        assertLoopback(new URL(`http://${host}/health`)),
      ).not.toThrow()
    }
    for (const host of ['[::ffff:8.8.8.8]', '127.0.0.1.evil.com']) {
      expect(() => assertLoopback(new URL(`http://${host}/health`))).toThrow(
        'Blocked non-loopback fetch to',
      )
    }
  })

  test('allows one trailing dot on localhost but not ambiguous names', () => {
    expect(() =>
      assertLoopback(new URL('http://localhost./health')),
    ).not.toThrow()
    expect(() => assertLoopback(new URL('http://localhost../health'))).toThrow(
      'Blocked non-loopback fetch to',
    )
    expect(() =>
      assertLoopback(new URL('http://evil.localhost./health')),
    ).toThrow('Blocked non-loopback fetch to')
  })

  test('strips credentials across loopback origins but preserves same-origin redirects', async () => {
    const crossOriginHeaders: Record<string, string | null>[] = []
    const sameOriginHeaders: Record<string, string | null>[] = []
    const serverB = Bun.serve({
      port: 0,
      fetch: (request) => {
        const headers = new Headers(request.headers)
        crossOriginHeaders.push({
          authorization: headers.get('authorization'),
          'proxy-authorization': headers.get('proxy-authorization'),
          cookie: headers.get('cookie'),
          'x-api-key': headers.get('x-api-key'),
        })
        return new Response('cross-origin')
      },
    })
    const serverA = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url)
        if (url.pathname === '/same-target') {
          const headers = new Headers(request.headers)
          sameOriginHeaders.push({
            authorization: headers.get('authorization'),
            'proxy-authorization': headers.get('proxy-authorization'),
            cookie: headers.get('cookie'),
            'x-api-key': headers.get('x-api-key'),
          })
          return new Response('same-origin')
        }
        if (url.pathname === '/same-origin') {
          return Response.redirect(
            new URL('/same-target', request.url).toString(),
            307,
          )
        }
        return Response.redirect(
          new URL(
            `${url.pathname}-target`,
            `http://127.0.0.1:${serverB.port}`,
          ).toString(),
          url.pathname === '/cross-switch' ? 302 : 307,
        )
      },
    })

    try {
      const credentials = {
        Authorization: 'Bearer secret',
        'Proxy-Authorization': 'Basic secret',
        Cookie: 'session=secret',
        'x-api-key': 'secret',
      }
      for (const path of ['/cross-switch', '/cross-preserve']) {
        const response = await globalThis.fetch(
          `http://127.0.0.1:${serverA.port}${path}`,
          { method: 'POST', headers: credentials, body: 'payload' },
        )
        expect(await response.text()).toBe('cross-origin')
      }
      const sameOriginFetch = await globalThis.fetch(
        `http://127.0.0.1:${serverA.port}/same-origin`,
        { headers: credentials },
      )
      expect(await sameOriginFetch.text()).toBe('same-origin')
    } finally {
      serverA.stop(true)
      serverB.stop(true)
    }

    expect(crossOriginHeaders).toHaveLength(2)
    expect(crossOriginHeaders).toEqual([
      {
        authorization: null,
        'proxy-authorization': null,
        cookie: null,
        'x-api-key': null,
      },
      {
        authorization: null,
        'proxy-authorization': null,
        cookie: null,
        'x-api-key': null,
      },
    ])
    expect(sameOriginHeaders).toEqual([
      {
        authorization: 'Bearer secret',
        'proxy-authorization': 'Basic secret',
        cookie: 'session=secret',
        'x-api-key': 'secret',
      },
    ])
  })

  test('does not interfere with a test stub assigned to globalThis.fetch', async () => {
    const realFetch = globalThis.fetch
    const stub = mock(() => Promise.resolve(new Response('stubbed')))
    globalThis.fetch = stub as unknown as typeof globalThis.fetch

    try {
      const response = await globalThis.fetch(
        'https://api.anthropic.com/v1/messages',
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('stubbed')
      expect(stub).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('shared provider fixture handles OAuth token exchange locally', async () => {
    const realFetch = globalThis.fetch
    installDefaultFetchMock()

    try {
      const response = await globalThis.fetch(CORE_TOKEN_URL)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_grant' })
      const quotaResponse = await globalThis.fetch(CORE_QUOTA_URL)
      expect(quotaResponse.status).toBe(401)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('shared provider fixture rejects URLs that only share the messages prefix', async () => {
    const realFetch = globalThis.fetch
    installDefaultFetchMock()

    try {
      await expect(globalThis.fetch(`${MESSAGES_URL}/count`)).rejects.toThrow(
        `Unexpected test fetch: ${MESSAGES_URL}/count`,
      )
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('shared provider fixture recognises messages query parameters', async () => {
    const realFetch = globalThis.fetch
    installDefaultFetchMock()

    try {
      const response = await globalThis.fetch(`${MESSAGES_URL}?beta=true`)
      expect(response.status).toBe(401)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('default provider fixture guards preconnect in both directions', () => {
    const realFetch = globalThis.fetch
    installDefaultFetchMock()

    try {
      expect(() =>
        globalThis.fetch.preconnect('http://127.0.0.1:8080/provider'),
      ).not.toThrow()
      expect(() =>
        globalThis.fetch.preconnect('https://example.invalid:8443/provider'),
      ).toThrow(
        'Blocked non-loopback fetch to https://example.invalid:8443/provider; stub globalThis.fetch in the test',
      )
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('preconnect rejects non-loopback hosts', () => {
    expect(() =>
      globalThis.fetch.preconnect('https://example.invalid:8443/provider'),
    ).toThrow(
      'Blocked non-loopback fetch to https://example.invalid:8443/provider; stub globalThis.fetch in the test',
    )
  })

  test('preconnect allows loopback hosts', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response('ok'),
    })

    try {
      expect(() =>
        globalThis.fetch.preconnect(`http://127.0.0.1:${server.port}`),
      ).not.toThrow()
      const response = await globalThis.fetch(
        `http://127.0.0.1:${server.port}/health`,
      )
      expect(response.status).toBe(200)
    } finally {
      server.stop(true)
    }
  })

  test('preconnect no-ops on an impl without preconnect after the loopback check', () => {
    const bare = (async () =>
      new Response('ok')) as unknown as typeof globalThis.fetch
    const guarded = createGuardedFetch(bare)
    expect(() => guarded.preconnect('http://127.0.0.1:9')).not.toThrow()
    expect(() =>
      guarded.preconnect('https://example.invalid/provider'),
    ).toThrow(
      'Blocked non-loopback fetch to https://example.invalid/provider; stub globalThis.fetch in the test',
    )
  })

  test('restores the guard after a test leaves the default mock installed', () => {
    installDefaultFetchMock()
    expect(
      (globalThis.fetch as { [DEFAULT_FETCH_MOCK]?: true })[DEFAULT_FETCH_MOCK],
    ).toBe(true)
  })

  // Deliberately runs before "restores the network guard after a default fetch mock is left behind".
  test('restores the network guard after a default fetch mock is left behind', async () => {
    await expect(globalThis.fetch(MESSAGES_URL)).rejects.toThrow(
      `Blocked non-loopback fetch to ${MESSAGES_URL}; stub globalThis.fetch in the test`,
    )
  })
})
