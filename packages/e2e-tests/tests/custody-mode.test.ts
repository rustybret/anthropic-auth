/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  custodyCredentialId,
  custodyTombstoneKey,
  type FallbackAccount,
  isOAuthAccount,
  loadAccounts,
  saveAccounts,
  setClaustrumModePersistent,
  setRoutingMode,
  writeCustodyHandleManifestEntry,
} from '@cortexkit/anthropic-auth-core'
import { E2EHarness } from '../src/harness.ts'
import { startFakeClaustrumDaemon } from '../src/mock-claustrum.ts'

let harness: E2EHarness | null = null
const roots: string[] = []
const daemons: Array<{ stop: () => Promise<void> }> = []

afterEach(async () => {
  await harness?.dispose()
  harness = null
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('custody mode', () => {
  it('serves main and fallback credentials from the vault', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anthropic-auth-e2e-custody-'))
    roots.push(root)
    const mainHandle = `ckh_${'M'.repeat(43)}`
    const fallbackHandle = `ckh_${'F'.repeat(43)}`
    const manifestPath = join(root, 'claustrum-handles.json')
    const daemon = await startFakeClaustrumDaemon({
      directory: root,
      credentials: {
        [mainHandle]: {
          payload: JSON.stringify({ access_token: 'vault-main' }),
          account_id: 'account-main',
          record_version: 11,
          expires_at_ms: Date.now() + 60 * 60 * 1000,
        },
        [fallbackHandle]: {
          payload: JSON.stringify({ access_token: 'vault-fallback' }),
          account_id: 'account-fallback',
          record_version: 12,
          expires_at_ms: Date.now() + 60 * 60 * 1000,
        },
      },
    })
    daemons.push(daemon)
    await expect(
      writeCustodyHandleManifestEntry({
        path: manifestPath,
        entry: {
          label: 'main',
          handle: mainHandle,
          credentialId: custodyCredentialId('main'),
        },
      }),
    ).resolves.toEqual({ status: 'written' })
    await expect(
      writeCustodyHandleManifestEntry({
        path: manifestPath,
        entry: {
          label: 'work-alt',
          handle: fallbackHandle,
          credentialId: custodyCredentialId('work-alt'),
        },
      }),
    ).resolves.toEqual({ status: 'written' })

    harness = await E2EHarness.create({
      childEnv: {
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE:
          daemon.connectionFile,
        CLAUSTRUM_OPENCODE_HANDLES: manifestPath,
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
        const accountPath = join(env.configDir, 'anthropic-auth.json')
        await saveAccounts(
          {
            version: 1,
            accounts: [
              {
                id: 'work-alt',
                label: 'work-alt',
                type: 'oauth',
                enabled: true,
              },
            ],
            claustrum: { handlesFile: manifestPath },
          } as never,
          accountPath,
        )
        await setClaustrumModePersistent('claustrum', accountPath)
      },
    })
    harness.script([
      { type: 'text', text: 'main served' },
      { type: 'text', text: 'fallback served' },
    ])

    const mainSession = await harness.createSession()
    await harness.sendPrompt(mainSession, 'use the main vault credential')
    await harness.waitForSessionText(mainSession, 'main served')
    expect(harness.anthropic.requests().at(-1)?.headers.authorization).toBe(
      'Bearer vault-main',
    )

    const accountPath = join(
      harness.opencode.env.configDir,
      'anthropic-auth.json',
    )
    await setRoutingMode('fallback-first', accountPath)
    const fallbackSession = await harness.createSession()
    await harness.sendPrompt(
      fallbackSession,
      'use the fallback vault credential',
    )
    await harness.waitForSessionText(fallbackSession, 'fallback served')
    expect(harness.anthropic.requests().at(-1)?.headers.authorization).toBe(
      'Bearer vault-fallback',
    )
    expect(harness.anthropic.tokenRequests()).toBe(0)

    const pluginLog = await readFile(
      join(harness.opencode.env.tempDir, 'opencode-anthropic-auth.log'),
      'utf8',
    ).catch(() => '')
    const publicOutput = `${harness.opencode.stdout()}\n${harness.opencode.stderr()}\n${pluginLog}`
    expect(publicOutput).not.toContain(mainHandle)
    expect(publicOutput).not.toContain(fallbackHandle)
  }, 120_000)

  it('enrolls and serves a newly bound fallback without restarting OpenCode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anthropic-auth-e2e-custody-'))
    roots.push(root)
    const mainHandle = `ckh_${'M'.repeat(43)}`
    const addedHandle = `ckh_${'N'.repeat(43)}`
    const manifestPath = join(root, 'claustrum-handles.json')
    const daemon = await startFakeClaustrumDaemon({
      directory: root,
      credentials: {
        [mainHandle]: {
          payload: JSON.stringify({ access_token: 'vault-main' }),
          account_id: 'account-main',
          credential_id: custodyCredentialId('main'),
          record_version: 31,
          expires_at_ms: Date.now() + 60 * 60 * 1000,
        },
        [addedHandle]: {
          payload: JSON.stringify({ access_token: 'vault-added' }),
          account_id: 'account-added',
          credential_id: custodyCredentialId('added'),
          record_version: 32,
          expires_at_ms: Date.now() + 60 * 60 * 1000,
        },
      },
    })
    daemons.push(daemon)
    await writeCustodyHandleManifestEntry({
      path: manifestPath,
      entry: {
        label: 'main',
        handle: mainHandle,
        credentialId: custodyCredentialId('main'),
      },
    })

    harness = await E2EHarness.create({
      childEnv: {
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE:
          daemon.connectionFile,
        CLAUSTRUM_OPENCODE_HANDLES: manifestPath,
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
        const accountPath = join(env.configDir, 'anthropic-auth.json')
        await saveAccounts(
          {
            version: 1,
            accounts: [],
            claustrum: { handlesFile: manifestPath },
          },
          accountPath,
        )
        await setClaustrumModePersistent('claustrum', accountPath)
        await setRoutingMode('fallback-first', accountPath)
      },
    })
    harness.script([
      { type: 'text', text: 'main ready' },
      { type: 'text', text: 'new account served' },
    ])
    const initialSession = await harness.createSession()
    await harness.sendPrompt(initialSession, 'initialize the active plugin')
    await harness.waitForSessionText(initialSession, 'main ready')
    expect(harness.anthropic.requests().at(-1)?.headers.authorization).toBe(
      'Bearer vault-main',
    )

    await expect(
      writeCustodyHandleManifestEntry({
        path: manifestPath,
        entry: {
          label: 'added',
          handle: addedHandle,
          credentialId: custodyCredentialId('added'),
        },
      }),
    ).resolves.toEqual({ status: 'written' })
    await Promise.race([
      daemon.waitForCredentialGet(addedHandle),
      Bun.sleep(5_000).then(() => {
        throw new Error('new manifest binding was not verified')
      }),
    ])

    const accountPath = join(
      harness.opencode.env.configDir,
      'anthropic-auth.json',
    )
    const enrollmentDeadline = Date.now() + 5_000
    let addedAccount: FallbackAccount | undefined
    while (Date.now() < enrollmentDeadline) {
      const storage = await loadAccounts(accountPath)
      addedAccount = storage?.accounts.find(
        (account) => account.label === 'added',
      )
      if (
        addedAccount &&
        isOAuthAccount(addedAccount) &&
        addedAccount.refresh === custodyTombstoneKey('anthropic')
      ) {
        break
      }
      await Bun.sleep(20)
    }
    expect(addedAccount).toMatchObject({
      id: 'added',
      label: 'added',
      enabled: true,
      type: 'oauth',
      access: '',
      refresh: custodyTombstoneKey('anthropic'),
      anthropicAccountUuid: 'account-added',
    })
    expect(JSON.stringify(addedAccount)).not.toContain(addedHandle)

    const session = await harness.createSession()
    await harness.sendPrompt(session, 'use the newly bound vault credential')
    await harness.waitForSessionText(session, 'new account served')
    expect(harness.anthropic.requests().at(-1)?.headers.authorization).toBe(
      'Bearer vault-added',
    )
    expect(harness.anthropic.tokenRequests()).toBe(0)
  }, 120_000)

  it('keeps an initially cold vault main fail-closed while fallback-first serves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anthropic-auth-e2e-custody-'))
    roots.push(root)
    const mainHandle = `ckh_${'C'.repeat(43)}`
    const fallbackHandle = `ckh_${'G'.repeat(43)}`
    const manifestPath = join(root, 'claustrum-handles.json')
    const daemon = await startFakeClaustrumDaemon({
      directory: root,
      credentials: {
        [mainHandle]: {
          payload: JSON.stringify({ access_token: 'unavailable-main' }),
          account_id: 'account-main',
          record_version: 21,
          expires_at_ms: Date.now() + 60 * 60 * 1000,
          cold: true,
        },
        [fallbackHandle]: {
          payload: JSON.stringify({ access_token: 'vault-fallback' }),
          account_id: 'account-fallback',
          record_version: 22,
          expires_at_ms: Date.now() + 60 * 60 * 1000,
        },
      },
    })
    daemons.push(daemon)
    await writeCustodyHandleManifestEntry({
      path: manifestPath,
      entry: {
        label: 'main',
        handle: mainHandle,
        credentialId: custodyCredentialId('main'),
      },
    })
    await writeCustodyHandleManifestEntry({
      path: manifestPath,
      entry: {
        label: 'work-alt',
        handle: fallbackHandle,
        credentialId: custodyCredentialId('work-alt'),
      },
    })
    harness = await E2EHarness.create({
      childEnv: {
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE:
          daemon.connectionFile,
        CLAUSTRUM_OPENCODE_HANDLES: manifestPath,
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
        const accountPath = join(env.configDir, 'anthropic-auth.json')
        await saveAccounts(
          {
            version: 1,
            accounts: [
              {
                id: 'work-alt',
                label: 'work-alt',
                type: 'oauth',
                enabled: true,
              },
            ],
            claustrum: { handlesFile: manifestPath },
          } as never,
          accountPath,
        )
        await setClaustrumModePersistent('claustrum', accountPath)
        await setRoutingMode('fallback-first', accountPath)
      },
    })
    const mainSession = await harness.createSession()
    const mainResult = await harness.sendPrompt(
      mainSession,
      'use the cold main',
    )
    expect(JSON.stringify(mainResult)).toContain(
      'custody state mismatch: FAIL_CLOSED',
    )
    expect(harness.anthropic.requests()).toHaveLength(0)
    expect(harness.anthropic.tokenRequests()).toBe(0)
    expect(JSON.stringify(harness.anthropic.requests())).not.toContain(
      custodyTombstoneKey('anthropic'),
    )

    // C|T|T|N is a global startup verdict, so a healthy fallback remains dark.
    const accountPath = join(
      harness.opencode.env.configDir,
      'anthropic-auth.json',
    )
    await setRoutingMode('fallback-first', accountPath)
    const fallbackSession = await harness.createSession()
    const fallbackResult = await harness.sendPrompt(
      fallbackSession,
      'use the warm fallback after a cold boot',
    )
    expect(JSON.stringify(fallbackResult)).toContain(
      'custody state mismatch: FAIL_CLOSED',
    )
    expect(harness.anthropic.requests()).toHaveLength(0)
  }, 120_000)

  it('fails closed when a previously warm main becomes cold after a served 401', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anthropic-auth-e2e-custody-'))
    roots.push(root)
    const mainHandle = `ckh_${'L'.repeat(43)}`
    const manifestPath = join(root, 'claustrum-handles.json')
    const credentials = {
      [mainHandle]: {
        payload: JSON.stringify({ access_token: 'vault-main-late-cold' }),
        account_id: 'account-main',
        record_version: 31,
        expires_at_ms: Date.now() + 60 * 60 * 1000,
        cold: false,
      },
    }
    const daemon = await startFakeClaustrumDaemon({
      directory: root,
      credentials,
    })
    daemons.push(daemon)
    await writeCustodyHandleManifestEntry({
      path: manifestPath,
      entry: {
        label: 'main',
        handle: mainHandle,
        credentialId: custodyCredentialId('main'),
      },
    })
    harness = await E2EHarness.create({
      childEnv: {
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE:
          daemon.connectionFile,
        CLAUSTRUM_OPENCODE_HANDLES: manifestPath,
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
        const accountPath = join(env.configDir, 'anthropic-auth.json')
        await saveAccounts(
          {
            version: 1,
            accounts: [],
            claustrum: { handlesFile: manifestPath },
          },
          accountPath,
        )
        await setClaustrumModePersistent('claustrum', accountPath)
      },
    })

    // Let the first provider turn warm v31, then make the daemon cold after
    // it has answered credential.get. That turn still uses the resident
    // credential; its 401 invalidates v31, and the next lookup observes cold.
    harness.script([
      {
        type: 'error',
        status: 401,
        errorType: 'authentication_error',
        message: 'expired vault access',
      },
    ])
    const firstSession = await harness.createSession()
    const firstPrompt = harness.sendPrompt(
      firstSession,
      'invalidate the warm main record',
    )
    await daemon.waitForCredentialGet(mainHandle)
    credentials[mainHandle]!.cold = true
    await firstPrompt
    expect(harness.anthropic.requests()).toHaveLength(2)
    expect(
      harness.anthropic
        .requests()
        .every(
          (request) =>
            request.headers.authorization === 'Bearer vault-main-late-cold',
        ),
    ).toBe(true)
    await harness.waitFor(() => daemon.reportAuthFailures.length === 1, 15_000)
    expect(daemon.reportAuthFailures).toContainEqual({
      handle: mainHandle,
      provider_status: 401,
      record_version: 31,
      reporter_source: 'direct',
    })

    const secondSession = await harness.createSession()
    await harness.startPrompt(
      secondSession,
      'the main vault record is now cold',
    )
    try {
      await harness.waitForSessionStatusType(secondSession, 'retry', 15_000)
      expect(harness.anthropic.requests()).toHaveLength(2)
    } finally {
      await harness.abortSession(secondSession)
    }
    expect(harness.anthropic.tokenRequests()).toBe(0)
  }, 120_000)

  it('reports a fallback 401 against its own served vault record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anthropic-auth-e2e-custody-'))
    roots.push(root)
    const mainHandle = `ckh_${'R'.repeat(43)}`
    const fallbackHandle = `ckh_${'S'.repeat(43)}`
    const manifestPath = join(root, 'claustrum-handles.json')
    const daemon = await startFakeClaustrumDaemon({
      directory: root,
      credentials: {
        [mainHandle]: {
          payload: JSON.stringify({ access_token: 'vault-main' }),
          account_id: 'account-main',
          record_version: 40,
          expires_at_ms: Date.now() + 60 * 60 * 1000,
        },
        [fallbackHandle]: {
          payload: JSON.stringify({ access_token: 'vault-fallback' }),
          account_id: 'account-fallback',
          record_version: 41,
          expires_at_ms: Date.now() + 60 * 60 * 1000,
        },
      },
    })
    daemons.push(daemon)
    await writeCustodyHandleManifestEntry({
      path: manifestPath,
      entry: {
        label: 'main',
        handle: mainHandle,
        credentialId: custodyCredentialId('main'),
      },
    })
    await writeCustodyHandleManifestEntry({
      path: manifestPath,
      entry: {
        label: 'work-alt',
        handle: fallbackHandle,
        credentialId: custodyCredentialId('work-alt'),
      },
    })
    harness = await E2EHarness.create({
      childEnv: {
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE:
          daemon.connectionFile,
        CLAUSTRUM_OPENCODE_HANDLES: manifestPath,
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
        const accountPath = join(env.configDir, 'anthropic-auth.json')
        await saveAccounts(
          {
            version: 1,
            accounts: [
              {
                id: 'work-alt',
                label: 'work-alt',
                type: 'oauth',
                enabled: true,
              },
            ],
            claustrum: { handlesFile: manifestPath },
          } as never,
          accountPath,
        )
        await setClaustrumModePersistent('claustrum', accountPath)
        await setRoutingMode('fallback-first', accountPath)
      },
    })
    harness.script([
      {
        type: 'error',
        status: 401,
        errorType: 'authentication_error',
        message: 'fallback credential rejected',
      },
    ])

    const session = await harness.createSession()
    await harness.sendPrompt(session, 'use the fallback vault credential')
    await harness.waitFor(() => daemon.reportAuthFailures.length === 1, 15_000)
    expect(harness.anthropic.requests()[0]?.headers.authorization).toBe(
      'Bearer vault-fallback',
    )
    expect(daemon.reportAuthFailures).toEqual([
      {
        handle: fallbackHandle,
        provider_status: 401,
        record_version: 41,
        reporter_source: 'direct',
      },
    ])
  }, 120_000)
})
