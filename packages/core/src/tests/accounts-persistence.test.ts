import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type AccountStorage,
  createEmptyStorage,
  FallbackAccountManager,
  getAccountStatePath,
  hasNoLocalCredential,
  loadAccounts,
  type OAuthAccount,
  saveAccountState,
  saveAccounts,
} from '../accounts.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

test('recognizes an OAuth account with no local credential', () => {
  expect(hasNoLocalCredential({})).toBe(true)
  expect(hasNoLocalCredential({ refresh: '' })).toBe(true)
  expect(hasNoLocalCredential({ refresh: 'refresh' })).toBe(false)
  expect(hasNoLocalCredential({ access: '' })).toBe(false)
})

test('preserves scoped mode when an unrelated writer saves account config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'accounts-persistence-'))
  directories.push(directory)
  const path = join(directory, 'anthropic-auth.json')
  const storage = createEmptyStorage()
  await saveAccounts(
    { ...storage, claustrum: { mode: 'claustrum', scopedRoster: true } },
    path,
  )
  await saveAccounts(storage, path)
  await expect(loadAccounts(path)).resolves.toMatchObject({
    claustrum: { mode: 'claustrum', scopedRoster: true },
  })
})

test('saveAccounts cannot persist a Claustrum mode change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'accounts-persistence-'))
  directories.push(directory)
  const path = join(directory, 'anthropic-auth.json')
  const storage = createEmptyStorage()

  await saveAccounts({ ...storage, claustrum: { mode: 'claustrum' } }, path)
  await saveAccounts({ ...storage, claustrum: { mode: 'local' } }, path)

  await expect(loadAccounts(path)).resolves.toMatchObject({
    claustrum: { mode: 'claustrum' },
  })
})

test('drops obsolete handle manifest settings on load', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'accounts-persistence-'))
  directories.push(directory)
  const path = join(directory, 'anthropic-auth.json')
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      accounts: [],
      claustrum: {
        mode: 'claustrum',
        handlesFile: '/obsolete',
        accounts: { old: { enabled: true } },
      },
    }),
  )
  const loaded = await loadAccounts(path)
  expect(loaded?.claustrum).toEqual({ mode: 'claustrum' })
})

test('keeps tombstone metadata when discarding a stale credential write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'accounts-persistence-'))
  directories.push(directory)
  const path = join(directory, 'anthropic-auth.json')
  const storedQuota = {
    checkedAt: 200,
    five_hour: { usedPercent: 20, remainingPercent: 80, checkedAt: 200 },
    seven_day: { usedPercent: 20, remainingPercent: 80, checkedAt: 200 },
  }
  await saveAccounts(
    {
      version: 1,
      accounts: [
        {
          id: 'work',
          type: 'oauth',
          access: '',
          refresh: 'claustrum-tombstone:v1:anthropic',
          expires: 0,
          quota: storedQuota,
        },
      ],
    },
    path,
  )

  await saveAccounts(
    {
      version: 1,
      accounts: [
        {
          id: 'work',
          type: 'oauth',
          access: 'stale-access',
          refresh: 'stale-refresh',
          expires: 100,
          quota: {
            checkedAt: 100,
            five_hour: {
              usedPercent: 90,
              remainingPercent: 10,
              checkedAt: 100,
            },
            seven_day: {
              usedPercent: 90,
              remainingPercent: 10,
              checkedAt: 100,
            },
          },
        },
      ],
    },
    path,
  )

  await expect(loadAccounts(path)).resolves.toMatchObject({
    accounts: [
      {
        id: 'work',
        access: '',
        refresh: 'claustrum-tombstone:v1:anthropic',
        quota: storedQuota,
      },
    ],
  })
})

test('main quota persistence ignores an unbound future observation timestamp', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'accounts-persistence-'))
  directories.push(directory)
  const path = join(directory, 'anthropic-auth.json')
  await saveAccounts(
    {
      version: 1,
      accounts: [],
      mainAccountId: 'account-a',
      quota: {
        mainQuota: {
          accountIdentity: 'account-a',
          checkedAt: 200,
          five_hour: {
            usedPercent: 20,
            remainingPercent: 80,
            checkedAt: 200,
          },
        },
        mainQuotaCheckedAt: 200,
        mainQuotaToken: 'lineage-a',
      },
    },
    path,
  )

  const stale = await loadAccounts(path)
  if (!stale?.quota) throw new Error('missing quota fixture')
  stale.quota.mainQuota = {
    accountIdentity: 'account-a',
    checkedAt: 100,
    five_hour: {
      usedPercent: 80,
      remainingPercent: 20,
      checkedAt: 100,
    },
  }
  stale.quota.mainQuotaCheckedAt = 999
  await saveAccountState(stale, path, { mainQuota: true })

  await expect(loadAccounts(path)).resolves.toMatchObject({
    quota: {
      mainQuota: {
        checkedAt: 200,
        five_hour: { usedPercent: 20 },
      },
      mainQuotaCheckedAt: 200,
    },
  })
})

test('legacy Claustrum config never refreshes or probes retained local OAuth material', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'accounts-incomplete-custody-'),
  )
  directories.push(directory)
  const path = join(directory, 'anthropic-auth.json')
  const account: OAuthAccount = {
    id: 'old',
    type: 'oauth',
    enabled: true,
    access: 'must-not-spend',
    refresh: 'must-not-refresh',
    expires: 0,
  }
  const storage: AccountStorage = {
    version: 1,
    accounts: [account],
    claustrum: { mode: 'claustrum' },
    quota: { enabled: true, checkIntervalMinutes: 5 },
  }
  await saveAccounts(storage, path)
  const statePath = getAccountStatePath(path)
  const beforeStateInode = (await stat(statePath).catch(() => null))?.ino
  const outbound: string[] = []
  const manager = new FallbackAccountManager({
    configPath: path,
    fetchImpl: (async (url: Parameters<typeof fetch>[0]) => {
      outbound.push(String(url))
      throw new Error('legacy local bearer must not reach the network')
    }) as unknown as typeof fetch,
  })
  await manager.refreshDueAccounts()
  await manager.refreshQuotaForDueAccounts()
  expect(
    (await manager.refreshQuotaForAllAccounts({ force: true })).errors,
  ).toEqual([])
  expect(await manager.getUsableFallbackAccounts()).toEqual([])
  await expect(manager.refreshAccountQuota(account, storage)).rejects.toThrow(
    'setup is incomplete',
  )
  expect(outbound).toEqual([])
  expect((await stat(statePath).catch(() => null))?.ino).toBe(beforeStateInode)
  expect((await loadAccounts(path))?.accounts[0]).toMatchObject({
    access: 'must-not-spend',
    refresh: 'must-not-refresh',
  })
})
