import { expect, test } from 'bun:test'
import type { AccountStorage } from '@cortexkit/anthropic-auth-core'
import { custodyStateFor } from '../custody-dimensions.ts'

test('projects a vault-served main without identity evidence as unknown', () => {
  const storage: AccountStorage = {
    version: 1,
    claustrum: { mode: 'claustrum' },
    accounts: [],
  }

  expect(
    custodyStateFor({ id: 'main', role: 'main' }, storage, {
      getCache: () => ({
        peek: () => ({
          payload: '{"access_token":"vault-main"}',
          expiresAtMs: 60_000,
          recordVersion: 1,
        }),
      }),
      now: () => 0,
      resolveAccountCustodyHandle: () => ({
        status: 'unresolved',
        reason: 'missing-entry',
      }),
      usableAccessToken: () => 'vault-main',
      hasIdentityMismatch: () => false,
      isBlocked: () => false,
      isReauth: () => false,
      getManifest: () => ({
        version: 1,
        provider: 'anthropic',
        serve: 'anthropic-auth',
        accounts: [
          {
            label: 'main',
            handle: 'ckh_main',
            credentialId: 'oauth:anthropic:main',
          },
        ],
        superseded: new Set(),
      }),
    }),
  ).toBe('unknown-identity')
})
