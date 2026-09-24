import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStorage,
  detectClaustrumConnection,
  executeAccountCommand,
  getDefaultClaustrumConnectionPath,
} from '@cortexkit/anthropic-auth-core'

let tempDir: string

const baseStorage = (): AccountStorage => ({
  version: 1,
  main: { type: 'opencode', provider: 'anthropic' },
  accounts: [
    {
      id: 'account-a',
      type: 'oauth',
      refresh: 'refresh-a',
      enabled: true,
    },
    {
      id: 'account-b',
      type: 'oauth',
      refresh: 'refresh-b',
      enabled: true,
    },
  ],
})

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'anthropic-auth-claustrum-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('Claustrum connection detection', () => {
  test('reports an available connection without projecting its bearer key', async () => {
    const path = join(tempDir, 'subc-connection.json')
    await writeFile(
      path,
      JSON.stringify({
        schema: 1,
        wire_version: 2,
        key: 'bearer-secret',
        endpoints: [
          { host: '127.0.0.1', port: 8757 },
          { host: '[::1]', port: 8757 },
        ],
      }),
    )

    const result = await detectClaustrumConnection(path)

    expect(result).toEqual({
      status: 'available',
      schema: 1,
      wireVersion: 2,
      endpoints: [
        { host: '127.0.0.1', port: 8757 },
        { host: '[::1]', port: 8757 },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('bearer-secret')
    expect('key' in result).toBe(false)
  })

  test('reports an absent connection file distinctly', async () => {
    const result = await detectClaustrumConnection(
      join(tempDir, 'missing.json'),
    )

    expect(result.status).toBe('absent')
  })

  test('reports an unreadable connection file without parser text', async () => {
    const path = join(tempDir, 'unreadable.json')
    await writeFile(path, '{}')
    await chmod(path, 0o000)

    const result = await detectClaustrumConnection(path)

    expect(result.status).toBe('malformed')
    expect(result).toMatchObject({ reason: 'unreadable (EACCES)' })
    expect(JSON.stringify(result)).not.toContain('invalid JSON')
  })

  test('reports malformed JSON and invalid shape distinctly from absence', async () => {
    const path = join(tempDir, 'malformed.json')
    await writeFile(path, '{"schema":1,"wire_version":"2"}')

    const result = await detectClaustrumConnection(path)

    expect(result.status).toBe('malformed')
  })

  test('does not expose parser text from malformed secret-bearing JSON', async () => {
    const path = join(tempDir, 'secret-bearing-malformed.json')
    const canary = 'CANARYSECRET'
    await writeFile(path, `{"schema":1,"key":ckh_${canary}}`)

    const result = await detectClaustrumConnection(path)

    expect(result.status).toBe('malformed')
    expect(JSON.stringify(result)).not.toContain(canary)
  })

  test('rejects an empty endpoint list as malformed', async () => {
    const path = join(tempDir, 'empty-endpoints.json')
    await writeFile(
      path,
      JSON.stringify({ schema: 1, wire_version: 2, endpoints: [] }),
    )

    const result = await detectClaustrumConnection(path)

    expect(result.status).toBe('malformed')
  })

  test('rejects an endpoint with an invalid port as malformed', async () => {
    const path = join(tempDir, 'invalid-endpoint.json')
    await writeFile(
      path,
      JSON.stringify({
        schema: 1,
        wire_version: 2,
        endpoints: [{ host: '127.0.0.1', port: '8757' }],
      }),
    )

    const result = await detectClaustrumConnection(path)

    expect(result.status).toBe('malformed')
  })

  test('reads the explicitly configured connection path', async () => {
    const configuredPath = join(tempDir, 'configured.json')
    await writeFile(
      configuredPath,
      JSON.stringify({
        schema: 7,
        wire_version: 9,
        endpoints: [{ host: 'vault.test', port: 1234 }],
      }),
    )

    const result = await detectClaustrumConnection(configuredPath)

    expect(result).toEqual({
      status: 'available',
      schema: 7,
      wireVersion: 9,
      endpoints: [{ host: 'vault.test', port: 1234 }],
    })
  })

  test('resolves an existing connection file from HOME or XDG_RUNTIME_DIR', async () => {
    const customHome = join(tempDir, 'home')
    const customRunDir = join(customHome, '.local', 'share', 'cortexkit', 'run')
    await mkdir(customRunDir, { recursive: true })
    const homeConn = join(customRunDir, 'subc-connection.json')
    await writeFile(homeConn, '{}')

    expect(getDefaultClaustrumConnectionPath({ HOME: customHome })).toBe(
      homeConn,
    )

    const customRuntime = join(tempDir, 'runtime')
    await mkdir(customRuntime, { recursive: true })
    const runtimeConn = join(customRuntime, 'subc-connection.json')
    await writeFile(runtimeConn, '{}')

    expect(
      getDefaultClaustrumConnectionPath({
        HOME: customHome,
        XDG_RUNTIME_DIR: customRuntime,
      }),
    ).toBe(runtimeConn)
  })

  test('derives the default connection path from the current uid on linux fallback', async () => {
    const originalGetuid = process.getuid
    const originalPlatform = process.platform
    Object.defineProperty(process, 'getuid', { value: () => 4242 })
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      expect(
        getDefaultClaustrumConnectionPath({
          HOME: join(tempDir, 'empty-home'),
          TMPDIR: join(tempDir, 'empty-tmp'),
          XDG_RUNTIME_DIR: undefined,
        }),
      ).toBe('/run/user/4242/subc-connection.json')
    } finally {
      Object.defineProperty(process, 'getuid', { value: originalGetuid })
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })
})

test('projects scoped custody without a handle gate', async () => {
  const result = await executeAccountCommand({
    argumentsText: '',
    storage: {
      ...baseStorage(),
      claustrum: { mode: 'claustrum', scopedRoster: true },
      accounts: [
        {
          id: 'account-a',
          label: 'Work',
          type: 'oauth',
          refresh: '',
          claustrumScopedCredentialId: 'oauth:anthropic:work',
          anthropicAccountUuid: 'account-a' as never,
          claustrumScopedState: 'active',
        },
      ],
    },
    statusProjection: {
      claustrumDetection: 'available',
      accounts: [
        {
          id: 'main',
          label: 'OpenCode anthropic',
          role: 'main',
          enabled: true,
          quotaPercent: null,
          claustrumGate: 'on',
          vaultServed: true,
          vaultReauth: false,
          custodyState: 'on-vault-served',
        },
        {
          id: 'account-a',
          label: 'Work',
          role: 'fallback',
          enabled: true,
          quotaPercent: null,
          claustrumGate: 'on',
          vaultServed: true,
          vaultReauth: false,
          custodyState: 'on-vault-served',
        },
      ],
    },
  })
  expect(result.text).toContain('Custody mode: claustrum')
  expect(result.text).toContain('Work')
  expect(result.text).toContain('vault-served')
  expect(result.text).not.toContain('handle')
})
