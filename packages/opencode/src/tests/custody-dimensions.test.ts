import { expect, test } from 'bun:test'
import type {
  AccountStorage,
  ProviderAccountUuid,
} from '@cortexkit/anthropic-auth-core'
import {
  custodyStateFor,
  fallbackCustodyDimensions,
  isFallbackAccountVaultServed,
} from '../custody-dimensions.ts'

const scoped = (): AccountStorage => ({
  version: 1,
  claustrum: {
    mode: 'claustrum',
    scopedRoster: true,
    primaryAccount: {
      credentialId: 'oauth:anthropic',
      accountId: 'provider-main' as ProviderAccountUuid,
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
      anthropicAccountUuid: 'provider-work' as ProviderAccountUuid,
      claustrumScopedState: 'active',
    },
  ],
})

test('scoped ownership requires a secret-free credential identity and active state', () => {
  const storage = scoped()
  expect(fallbackCustodyDimensions(storage)).toEqual({
    fallbacks: 'T',
    evidence: 'V',
  })
  expect(custodyStateFor({ id: 'main', role: 'main' }, storage)).toBe(
    'on-vault-served',
  )
  expect(custodyStateFor({ id: 'work', role: 'fallback' }, storage)).toBe(
    'on-vault-served',
  )
  expect(isFallbackAccountVaultServed('work', storage)).toBe(true)
  const work = storage.accounts[0]
  if (work?.type !== 'oauth') throw new Error('missing OAuth fixture')
  work.refresh = 'leaked-local-refresh'
  expect(fallbackCustodyDimensions(storage)).toEqual({
    fallbacks: 'R',
    evidence: 'V',
  })
  expect(isFallbackAccountVaultServed('work', storage)).toBe(false)
})

test('legacy Claustrum configuration is never considered vault-served', () => {
  const storage = scoped()
  delete storage.claustrum!.scopedRoster
  expect(fallbackCustodyDimensions(storage)).toEqual({
    fallbacks: 'M',
    evidence: 'N',
  })
  expect(isFallbackAccountVaultServed('work', storage)).toBe(false)
  expect(custodyStateFor({ id: 'main', role: 'main' }, storage)).toBe(
    'unknown-identity',
  )
})
