import { expect, test } from 'bun:test'
import type { AccountStorage } from '@cortexkit/anthropic-auth-core'
import {
  custodyStateFor,
  fallbackCustodyDimensions,
} from '../custody-dimensions.ts'

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

test('scoped roster with active primary and vault-owned fallbacks evaluates to CLAUSTRUM_SERVE without handles', () => {
  const storage: AccountStorage = {
    version: 1,
    claustrum: {
      mode: 'claustrum',
      scopedRoster: true,
      primaryAccount: {
        credentialId: 'oauth:anthropic:main',
        accountId: 'provider-main' as any,
        state: 'active',
      },
    },
    accounts: [
      {
        id: 'work',
        type: 'oauth',
        enabled: true,
        refresh: '',
        claustrumScopedCredentialId: 'oauth:anthropic:work',
        anthropicAccountUuid: 'provider-work' as any,
        claustrumScopedState: 'active',
      },
    ],
  }

  const dims = fallbackCustodyDimensions(storage, {
    getCache: () => null,
    now: () => 0,
    resolveAccountCustodyHandle: () => {
      throw new Error(
        'handle resolution must not be called when scopedRoster is true',
      )
    },
    usableAccessToken: () => undefined,
  })

  expect(dims).toEqual({ fallbacks: 'T', evidence: 'V' })
  expect(
    custodyStateFor({ id: 'main', role: 'main' }, storage, {} as any),
  ).toBe('on-vault-served')
  expect(
    custodyStateFor({ id: 'work', role: 'fallback' }, storage, {} as any),
  ).toBe('on-vault-served')
})

test('scoped roster with a fallback retaining a local secret evaluates to R and alerts', () => {
  const storage: AccountStorage = {
    version: 1,
    claustrum: {
      mode: 'claustrum',
      scopedRoster: true,
      primaryAccount: {
        credentialId: 'oauth:anthropic:main',
        accountId: 'provider-main' as any,
        state: 'active',
      },
    },
    accounts: [
      {
        id: 'work',
        type: 'oauth',
        enabled: true,
        refresh: 'leaked-local-refresh',
        claustrumScopedCredentialId: 'oauth:anthropic:work',
        anthropicAccountUuid: 'provider-work' as any,
        claustrumScopedState: 'active',
      },
    ],
  }

  const dims = fallbackCustodyDimensions(storage, {
    getCache: () => null,
    now: () => 0,
    resolveAccountCustodyHandle: () => ({
      status: 'unresolved',
      reason: 'missing-entry',
    }),
    usableAccessToken: () => undefined,
  })

  expect(dims).toEqual({ fallbacks: 'R', evidence: 'V' })
})
