import { describe, expect, test } from 'bun:test'
import {
  type AccountStorage,
  type CustodyHandleManifest,
  custodyTombstoneKey,
} from '@cortexkit/anthropic-auth-core'
import {
  materializeClaustrumEnrollment,
  pendingClaustrumEnrollments,
} from '../custody-enrollment.ts'

const handle = `ckh_${'A'.repeat(43)}`

function storage(accounts: AccountStorage['accounts'] = []): AccountStorage {
  return {
    version: 1,
    accounts,
    claustrum: { mode: 'claustrum' },
  }
}

function manifest(
  accounts: CustodyHandleManifest['accounts'],
  corruptLabels: ReadonlySet<string> = new Set(),
): CustodyHandleManifest {
  return {
    version: 1,
    provider: 'anthropic',
    serve: 'anthropic-auth',
    accounts,
    superseded: new Set(),
    corruptLabels,
  }
}

describe('Claustrum manifest enrollment', () => {
  test('plans only unmaterialized, non-main, non-corrupt bindings while preserving disabled and unlabeled rows', () => {
    const bindings = [
      { label: 'main', handle, credentialId: 'oauth:anthropic' },
      {
        label: 'existing',
        handle: `ckh_${'B'.repeat(43)}`,
        credentialId: 'oauth:anthropic:existing',
      },
      {
        label: 'disabled',
        handle: `ckh_${'E'.repeat(43)}`,
        credentialId: 'oauth:anthropic:disabled',
      },
      {
        label: 'unlabeled',
        handle: `ckh_${'U'.repeat(43)}`,
        credentialId: 'oauth:anthropic:unlabeled',
      },
      {
        label: 'new-account',
        handle: `ckh_${'C'.repeat(43)}`,
        credentialId: 'oauth:anthropic:new-account',
      },
      {
        label: 'corrupt',
        handle: `ckh_${'D'.repeat(43)}`,
        credentialId: 'oauth:anthropic:corrupt',
      },
    ]
    const current = storage([
      {
        id: 'existing-id',
        label: 'existing',
        type: 'oauth',
        refresh: custodyTombstoneKey('anthropic'),
      },
      {
        id: 'disabled-id',
        label: 'disabled',
        type: 'oauth',
        refresh: custodyTombstoneKey('anthropic'),
        enabled: false,
      },
      {
        id: 'unlabeled',
        type: 'oauth',
        refresh: custodyTombstoneKey('anthropic'),
      },
    ])

    expect(
      pendingClaustrumEnrollments(
        current,
        manifest(bindings, new Set(['corrupt'])),
      ).map((binding) => binding.label),
    ).toEqual(['new-account'])

    expect(
      pendingClaustrumEnrollments(
        { ...current, claustrum: { mode: 'local' } },
        manifest(bindings),
      ),
    ).toEqual([])
  })

  test('materializes a deterministic secret-free tombstone row', () => {
    const binding = {
      label: 'work',
      handle,
      credentialId: 'oauth:anthropic:work',
    }
    const first = materializeClaustrumEnrollment({
      storage: storage(),
      binding,
      providerAccountUuid: 'provider-work',
      now: 123,
    })
    const second = materializeClaustrumEnrollment({
      storage: storage(),
      binding,
      providerAccountUuid: 'provider-work',
      now: 123,
    })

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      id: 'work',
      label: 'work',
      enabled: true,
      addedAt: 123,
      type: 'oauth',
      access: '',
      refresh: custodyTombstoneKey('anthropic'),
      expires: 0,
      anthropicAccountUuid: 'provider-work',
    })
    expect(first.authLineageId).toStartWith('claustrum-')
    expect(JSON.stringify(first)).not.toContain(handle)
  })

  test('uses a deterministic collision-safe id without replacing an API route', () => {
    const binding = {
      label: 'work',
      handle,
      credentialId: 'oauth:anthropic:work',
    }
    const current = storage([
      {
        id: 'work',
        label: 'proxy',
        type: 'api',
        apiKey: 'not-a-real-key',
        baseURL: 'https://example.test',
      },
    ])

    const account = materializeClaustrumEnrollment({
      storage: current,
      binding,
      providerAccountUuid: 'provider-work',
    })

    expect(account.id).toMatch(/^claustrum-[a-f0-9]{64}$/)
    expect(account.id).not.toBe('work')
  })
})
