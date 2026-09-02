const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])

function isIpv4Loopback(hostname: string) {
  const octets = hostname.split('.')
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets
      .slice(1)
      .every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  )
}

function mappedIpv4Hostname(hostname: string) {
  const match = hostname.match(/^\[::ffff:([^\]]+)\]$/i)
  if (!match) return undefined

  const tail = match[1]
  if (!tail) return undefined

  // URL parsing canonicalizes mapped addresses to the 2-hextet form
  // ([::ffff:127.0.0.1] -> [::ffff:7f00:1]), so only hextets arrive here.
  const hextets = tail.split(':')
  if (
    hextets.length !== 2 ||
    hextets.some((hextet) => !/^[\da-f]{1,4}$/i.test(hextet))
  ) {
    return undefined
  }
  const [highHextet, lowHextet] = hextets
  if (!highHextet || !lowHextet) return undefined
  const high = Number.parseInt(highHextet, 16)
  const low = Number.parseInt(lowHextet, 16)
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
}

export function fetchUrl(input: Parameters<typeof globalThis.fetch>[0]) {
  try {
    if (typeof input === 'string') return new URL(input)
    if (input instanceof URL) return input
    return new URL(input.url)
  } catch {
    return undefined
  }
}

export function assertLoopback(url: URL) {
  const hostname = url.hostname.endsWith('.')
    ? url.hostname.slice(0, -1)
    : url.hostname
  const isLoopback =
    LOOPBACK_HOSTS.has(hostname) ||
    isIpv4Loopback(hostname) ||
    isIpv4Loopback(mappedIpv4Hostname(hostname) ?? '')
  if (!isLoopback) {
    throw new Error(
      `Blocked non-loopback fetch to ${url}; stub globalThis.fetch in the test`,
    )
  }
}

export function assertPreconnectUrl(
  input: Parameters<typeof globalThis.fetch.preconnect>[0],
) {
  const url = fetchUrl(
    input as unknown as Parameters<typeof globalThis.fetch>[0],
  )
  if (!url) {
    throw new Error(
      'Blocked fetch with an unparseable URL; stub globalThis.fetch in the test',
    )
  }
  assertLoopback(url)
  return url
}
