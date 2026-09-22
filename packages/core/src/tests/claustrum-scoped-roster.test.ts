import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStorage,
  addAccountPersistent,
  getAccountStatePath,
  loadAccounts,
  type OAuthAccount,
  saveAccountState,
  saveAccounts,
  saveOAuthProfileState,
  setAccountEnabledPersistent,
  setClaustrumModePersistent,
} from '../accounts.ts'
import type { ProviderAccountUuid } from '../claude-code.ts'
import type { ClaustrumScopedAccount } from '../claustrum-scoped.ts'
import {
  projectClaustrumScopedRoster,
  refreshClaustrumScopedRoster,
} from '../claustrum-scoped-roster.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true })
})
const work: ClaustrumScopedAccount = {
  credentialId: 'oauth:anthropic:work',
  accountId: 'provider-work',
  state: 'active',
}
const main: ClaustrumScopedAccount = {
  credentialId: 'oauth:anthropic',
  accountId: 'provider-main',
  state: 'active',
}
const inventory = (
  accounts: readonly ClaustrumScopedAccount[],
  view = 'v',
) => ({ discover: async () => ({ accounts, view }) })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'scoped-roster-'))
  dirs.push(dir)
  const path = join(dir, 'accounts.json')
  const storage: AccountStorage = {
    version: 1,
    accounts: [
      {
        id: 'proxy',
        type: 'api',
        baseURL: 'https://proxy.invalid',
        apiKey: 'test-proxy-key',
      },
      {
        id: 'work',
        label: 'Work',
        type: 'oauth',
        enabled: true,
        refresh: 'old-local-refresh',
        access: 'old-local-access',
        anthropicAccountUuid: work.accountId as ProviderAccountUuid,
        quota: {
          checkedAt: 100,
          five_hour: { usedPercent: 10, remainingPercent: 90, checkedAt: 100 },
        },
      },
    ],
  }
  await saveAccounts(storage, path)
  await setClaustrumModePersistent('claustrum', path)
  return { path, storage: (await loadAccounts(path))! }
}

test('discovery preserves identity, preferences and API routes but removes local OAuth material', async () => {
  const { path } = await fixture()
  const roster = await refreshClaustrumScopedRoster({
    path,
    custody: inventory([work, main]),
  })
  expect(roster?.primary).toEqual(main)
  expect(roster?.accounts.map((account) => account.id)).toEqual(['work'])
  const saved = await loadAccounts(path)
  expect(saved?.accounts.map((account) => account.id)).toEqual([
    'proxy',
    'work',
  ])
  expect(saved?.accounts[1]).toMatchObject({
    refresh: '',
    claustrumScopedCredentialId: work.credentialId,
    anthropicAccountUuid: work.accountId,
    quota: { checkedAt: 100 },
  })
  expect(saved?.accounts[1]).not.toHaveProperty('access', 'old-local-access')
  for (const file of [path, getAccountStatePath(path)]) {
    const text = await readFile(file, 'utf8')
    expect(text).not.toContain('old-local-refresh')
    expect(text).not.toContain('old-local-access')
  }
})

test('stale writers cannot restore local secrets, removed members or disabled preferences', async () => {
  const { path, storage: stale } = await fixture()
  await refreshClaustrumScopedRoster({ path, custody: inventory([work]) })
  await setAccountEnabledPersistent('work', false, path)
  await saveAccountState(stale, path, { accounts: true })
  await saveAccounts(stale, path)
  expect((await loadAccounts(path))?.accounts[1]).toMatchObject({
    enabled: false,
    refresh: '',
    claustrumScopedCredentialId: work.credentialId,
  })
  expect(await readFile(getAccountStatePath(path), 'utf8')).not.toContain(
    'old-local-access',
  )
  await refreshClaustrumScopedRoster({ path, custody: inventory([]) })
  await saveAccounts(stale, path)
  expect(
    (await loadAccounts(path))?.accounts.map((account) => account.id),
  ).toEqual(['proxy'])
  const returned = await refreshClaustrumScopedRoster({
    path,
    custody: inventory([work]),
  })
  expect(returned?.accounts[0]?.enabled).toBe(false)
})

test('identity replacement does not inherit quota, profile or route identity', async () => {
  const { path } = await fixture()
  await refreshClaustrumScopedRoster({ path, custody: inventory([work]) })
  const result = await refreshClaustrumScopedRoster({
    path,
    custody: inventory([{ ...work, accountId: 'replacement' }]),
  })
  expect(result?.accounts[0]?.id).not.toBe('work')
  expect(result?.accounts[0]?.quota).toBeUndefined()
  expect(
    (await loadAccounts(path))?.accounts.some(
      (account) => account.id === 'work',
    ),
  ).toBe(false)
})

test('duplicate login records never create duplicate quota weight, including primary aliases', () => {
  const storage: AccountStorage = { version: 1, accounts: [] }
  const result = projectClaustrumScopedRoster(
    storage,
    [
      main,
      { ...main, credentialId: 'oauth:anthropic:duplicate' },
      work,
      { ...work, credentialId: 'alias' },
    ],
    'v',
  )
  expect(result.primary?.accountId).toBe(main.accountId)
  expect(result.accounts).toHaveLength(1)
  expect(String(result.accounts[0]?.anthropicAccountUuid)).toBe(work.accountId)
  const alias = projectClaustrumScopedRoster(
    storage,
    [
      { ...main, state: 'needs_reauth' },
      { ...main, credentialId: 'working-alias' },
    ],
    'v',
  )
  expect(alias.primary?.credentialId).toBe('working-alias')
  expect(alias.accounts).toHaveLength(0)
})

test('fresh config mutation during discovery is preserved at commit', async () => {
  const { path } = await fixture()
  const started = deferred<void>()
  const reply = deferred<{ accounts: ClaustrumScopedAccount[]; view: string }>()
  const pending = refreshClaustrumScopedRoster({
    path,
    custody: {
      discover: async () => {
        started.resolve()
        return reply.promise
      },
    },
  })
  await started.promise
  await setAccountEnabledPersistent('work', false, path)
  reply.resolve({ accounts: [work], view: 'v' })
  expect((await pending)?.accounts[0]?.enabled).toBe(false)
  expect((await loadAccounts(path))?.accounts[1]?.enabled).toBe(false)
})

test('a delayed discovery that lost its lease cannot overwrite a successor inventory', async () => {
  const { path } = await fixture()
  const started = deferred<void>()
  const reply = deferred<{ accounts: ClaustrumScopedAccount[]; view: string }>()
  const old = refreshClaustrumScopedRoster({
    path,
    custody: {
      discover: async () => {
        started.resolve()
        return reply.promise
      },
    },
  })
  // Attach rejection handling before releasing the delayed operation.
  const outcome = old.then(
    () => ({ rejected: false, message: '' }),
    (error: unknown) => ({
      rejected: true,
      message: error instanceof Error ? error.message : String(error),
    }),
  )
  await started.promise
  await rm(`${path}.scoped-roster.lock`, { recursive: true })
  await refreshClaustrumScopedRoster({ path, custody: inventory([], 'newer') })
  reply.resolve({ accounts: [work], view: 'older' })
  expect(await outcome).toEqual({
    rejected: true,
    message: 'Account file lock ownership was lost',
  })
  expect(
    (await loadAccounts(path))?.accounts.map((account) => account.id),
  ).toEqual(['proxy'])
})

test('discovery failure and switching to local during discovery never delete accounts', async () => {
  const { path } = await fixture()
  const before = await readFile(path, 'utf8')
  await expect(
    refreshClaustrumScopedRoster({
      path,
      custody: {
        discover: async () => {
          throw new Error('daemon unavailable')
        },
      },
    }),
  ).rejects.toThrow('daemon unavailable')
  expect(await readFile(path, 'utf8')).toBe(before)
  const started = deferred<void>()
  const reply = deferred<{ accounts: ClaustrumScopedAccount[]; view: string }>()
  const pending = refreshClaustrumScopedRoster({
    path,
    custody: {
      discover: async () => {
        started.resolve()
        return reply.promise
      },
    },
  })
  await started.promise
  await setClaustrumModePersistent('local', path)
  reply.resolve({ accounts: [], view: 'v' })
  expect(await pending).toBeUndefined()
  expect(
    (await loadAccounts(path))?.accounts.map((account) => account.id),
  ).toEqual(['proxy', 'work'])
  let calls = 0
  await refreshClaustrumScopedRoster({
    path,
    custody: {
      discover: async () => {
        calls++
        return { accounts: [], view: 'v' }
      },
    },
  })
  expect(calls).toBe(0)
})

test('config-owned identity wins over mismatched runtime state even between split writes', async () => {
  const { path } = await fixture()
  await refreshClaustrumScopedRoster({ path, custody: inventory([work]) })
  const statePath = getAccountStatePath(path)
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  state.accounts.work = {
    access: 'untrusted-old-access',
    refresh: 'untrusted-old-refresh',
    claustrumScopedCredentialId: 'other-credential',
    anthropicAccountUuid: 'other-account',
    quota: { checkedAt: Date.now() + 100_000 },
  }
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 })
  const loaded = await loadAccounts(path)
  expect(loaded?.accounts[1]).toMatchObject({
    claustrumScopedCredentialId: work.credentialId,
    anthropicAccountUuid: work.accountId,
    refresh: '',
  })
  expect(JSON.stringify(loaded)).not.toContain('untrusted-old-')
  expect(
    (loaded?.accounts[1] as OAuthAccount | undefined)?.quota,
  ).toBeUndefined()
  await refreshClaustrumScopedRoster({ path, custody: inventory([work]) })
  expect(await readFile(statePath, 'utf8')).not.toContain('untrusted-old-')
})

test('an API route with the same display label cannot evict a scoped OAuth route', async () => {
  const { path, storage: stale } = await fixture()
  await refreshClaustrumScopedRoster({ path, custody: inventory([work]) })
  const proxy = stale.accounts[0]
  if (!proxy) throw new Error('missing proxy fixture')
  proxy.label = 'Work'
  await saveAccounts(stale, path)
  expect(
    (await loadAccounts(path))?.accounts.map((account) => account.id),
  ).toEqual(['proxy', 'work'])
})

test('a replacement cannot reuse an unrelated pre-existing route id', () => {
  const fresh = projectClaustrumScopedRoster(
    { version: 1, accounts: [] },
    [work],
    'v',
  )
  const id = fresh.accounts[0]?.id
  if (!id) throw new Error('missing generated route id')
  const result = projectClaustrumScopedRoster(
    {
      version: 1,
      accounts: [
        {
          id,
          type: 'oauth',
          refresh: 'local-refresh',
          anthropicAccountUuid: 'another-identity' as ProviderAccountUuid,
        },
      ],
    },
    [work],
    'v',
  )
  expect(result.accounts[0]?.id).not.toBe(id)
  expect(result.accounts[0]?.quota).toBeUndefined()
})

test('replacing the scoped primary invalidates old observations and fences delayed old-account writes', async () => {
  const { path } = await fixture()
  await refreshClaustrumScopedRoster({ path, custody: inventory([main, work]) })
  const old = await loadAccounts(path)
  if (!old) throw new Error('Missing fixture storage')
  old.quota = {
    ...old.quota,
    mainQuota: { accountIdentity: main.accountId, checkedAt: 100 },
  }
  await saveAccountState(old, path, { mainQuota: true })
  const replacement = { ...main, accountId: 'replacement-main' }
  await refreshClaustrumScopedRoster({
    path,
    custody: inventory([replacement, work]),
  })
  const current = await loadAccounts(path)
  if (!current) throw new Error('Missing replacement storage')
  expect(current.quota?.mainQuota).toBeUndefined()
  current.quota = {
    ...current.quota,
    mainQuota: { accountIdentity: replacement.accountId, checkedAt: 200 },
  }
  await saveAccountState(current, path, { mainQuota: true })
  old.quota.mainQuota = { accountIdentity: main.accountId, checkedAt: 999 }
  await saveAccountState(old, path, { mainQuota: true })
  expect((await loadAccounts(path))?.quota?.mainQuota).toMatchObject({
    accountIdentity: replacement.accountId,
    checkedAt: 200,
  })
})

test('delayed main profile hydration cannot overwrite a replacement account tier', async () => {
  const { path } = await fixture()
  await refreshClaustrumScopedRoster({ path, custody: inventory([main]) })
  const profile = (tier: string, checkedAt: number) => ({
    tier,
    checkedAt,
    orgType: 'individual',
  })
  expect(
    await saveOAuthProfileState(
      {
        accountId: 'main',
        accountIdentity: main.accountId,
        profile: profile('Old', 100),
      },
      path,
    ),
  ).toBe(true)
  await refreshClaustrumScopedRoster({
    path,
    custody: inventory([{ ...main, accountId: 'replacement-main' }]),
  })
  expect(
    await saveOAuthProfileState(
      {
        accountId: 'main',
        accountIdentity: 'replacement-main',
        profile: profile('New', 200),
      },
      path,
    ),
  ).toBe(true)
  expect(
    await saveOAuthProfileState(
      {
        accountId: 'main',
        accountIdentity: main.accountId,
        profile: profile('Old', 999),
      },
      path,
    ),
  ).toBe(false)
  expect(
    JSON.parse(await readFile(getAccountStatePath(path), 'utf8')).main.profile
      .tier,
  ).toBe('New')
})

test('a stale scoped settings save cannot erase a verified local login after leaving custody', async () => {
  const { path } = await fixture()
  await refreshClaustrumScopedRoster({ path, custody: inventory([work]) })
  const stale = await loadAccounts(path)
  if (!stale) throw new Error('Missing fixture storage')
  await setClaustrumModePersistent('local', path)
  await addAccountPersistent(
    {
      id: 'work',
      label: 'Work',
      type: 'oauth',
      access: 'new-local-access',
      refresh: 'new-local-refresh',
      expires: Date.now() + 3_600_000,
      authLineageId: 'new-local-lineage',
    },
    path,
  )
  await saveAccounts(stale, path)
  const account = (await loadAccounts(path))?.accounts.find(
    (entry) => entry.id === 'work',
  ) as OAuthAccount | undefined
  expect(account?.access).toBe('new-local-access')
  expect(account?.refresh).toBe('new-local-refresh')
  expect(account?.claustrumScopedCredentialId).toBeUndefined()
})

test('a current locally enabled account overrides an older archived exclusion when entering custody', () => {
  const result = projectClaustrumScopedRoster(
    {
      version: 1,
      claustrum: {
        mode: 'local',
        scopedRoster: true,
        disabledAccountIdentities: [work.accountId],
      },
      accounts: [
        {
          id: 'work',
          type: 'oauth',
          refresh: 'local-refresh',
          anthropicAccountUuid: work.accountId as ProviderAccountUuid,
        },
      ],
    },
    [work],
    'v',
  )
  expect(result.accounts[0]?.enabled).toBe(true)
  expect(result.storage.claustrum?.disabledAccountIdentities).not.toContain(
    work.accountId,
  )
})
