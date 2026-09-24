import { createHash } from 'node:crypto'
import {
  type AccountStorage,
  acquireRefreshFileLock,
  type FallbackAccount,
  getClaustrumMode,
  isOAuthAccount,
  loadAccounts,
  mutateAccountsPersistent,
  type OAuthAccount,
} from './accounts.js'
import type { ProviderAccountUuid } from './claude-code.js'
import type {
  ClaustrumScopedAccount,
  ClaustrumScopedCustody,
} from './claustrum-scoped.js'

export class ClaustrumRosterBusyError extends Error {
  readonly code = 'claustrum_roster_busy'
  constructor() {
    super('Claustrum account discovery is already in progress')
  }
}

export interface ClaustrumScopedRoster {
  /** The vault's conventional default record; absent when only labeled accounts exist. */
  primary?: ClaustrumScopedAccount
  accounts: readonly OAuthAccount[]
  storage: AccountStorage
  view: string
}

function preferredLabel(credentialId: string): string | undefined {
  const parts = credentialId.split(':')
  return parts.length >= 3 && parts[2]?.trim()
    ? parts.slice(2).join(':').trim()
    : undefined
}

function routeId(account: ClaustrumScopedAccount): string {
  const label = preferredLabel(account.credentialId)
  if (label) return label
  return `scoped-${createHash('sha256').update(account.accountId).digest('hex')}`
}

function representativeRows(
  storage: AccountStorage,
  rows: readonly ClaustrumScopedAccount[],
): ClaustrumScopedAccount[] {
  const credentials = new Set<string>()
  const byIdentity = new Map<string, ClaustrumScopedAccount[]>()
  for (const row of rows) {
    if (
      !row.credentialId.trim() ||
      !row.accountId.trim() ||
      credentials.has(row.credentialId)
    ) {
      throw new Error('Claustrum returned an ambiguous account inventory')
    }
    credentials.add(row.credentialId)
    const group = byIdentity.get(row.accountId) ?? []
    group.push(row)
    byIdentity.set(row.accountId, group)
  }
  return [...byIdentity.values()]
    .map((group) => {
      const existing = storage.accounts.find(
        (account): account is OAuthAccount =>
          isOAuthAccount(account) &&
          account.anthropicAccountUuid === group[0]?.accountId,
      )
      // Multiple login records for one provider account are not extra quota.
      // Keep its established binding where possible, except that the conventional
      // default owns the primary slot rather than appearing a second time below.
      const ordered = group.toSorted((left, right) =>
        left.credentialId.localeCompare(right.credentialId),
      )
      const active = ordered.filter((entry) => entry.state === 'active')
      const choices = active.length ? active : ordered
      const row =
        choices.find((entry) => entry.credentialId === 'oauth:anthropic') ??
        choices.find(
          (entry) =>
            entry.credentialId === existing?.claustrumScopedCredentialId,
        ) ??
        choices[0]
      if (!row)
        throw new Error('Claustrum returned an empty account identity group')
      return row
    })
    .sort((left, right) => left.credentialId.localeCompare(right.credentialId))
}

/** Pure identity projection; callers must serialize discovery before persisting it. */
export function projectClaustrumScopedRoster(
  storage: AccountStorage,
  rows: readonly ClaustrumScopedAccount[],
  view: string,
  now = Date.now(),
): ClaustrumScopedRoster {
  if (
    new Set(storage.accounts.map((account) => account.id)).size !==
    storage.accounts.length
  ) {
    throw new Error('Account configuration contains duplicate route identities')
  }
  const selected = representativeRows(storage, rows)
  const primaryIdentity = rows.find(
    (row) => row.credentialId === 'oauth:anthropic',
  )?.accountId
  const primary = selected.find((row) => row.accountId === primaryIdentity)
  const disabled = new Set(storage.claustrum?.disabledAccountIdentities ?? [])
  for (const account of storage.accounts) {
    if (!isOAuthAccount(account) || !account.anthropicAccountUuid) continue
    if (account.enabled === false) disabled.add(account.anthropicAccountUuid)
    else disabled.delete(account.anthropicAccountUuid)
  }
  const unused = new Set(
    storage.accounts.filter(isOAuthAccount).map((account) => account.id),
  )
  const reserved = new Set(storage.accounts.map((account) => account.id))
  const next = selected
    .filter((row) => row !== primary)
    .map((row): OAuthAccount => {
      const existing = storage.accounts.find(
        (account): account is OAuthAccount =>
          isOAuthAccount(account) &&
          unused.has(account.id) &&
          account.anthropicAccountUuid === row.accountId,
      )
      let id = existing?.id ?? routeId(row)
      // Existing API routes are unrelated and cannot be replaced by discovery.
      while ((id !== existing?.id && reserved.has(id)) || id === 'main')
        id = `scoped-${id}`
      reserved.add(id)
      if (existing) unused.delete(existing.id)
      return {
        id,
        label:
          existing?.label ??
          preferredLabel(row.credentialId) ??
          row.email ??
          row.credentialId,
        type: 'oauth',
        enabled: existing
          ? existing.enabled !== false
          : !disabled.has(row.accountId),
        addedAt: existing?.addedAt ?? now,
        anthropicAccountUuid: row.accountId as ProviderAccountUuid,
        claustrumScopedCredentialId: row.credentialId,
        claustrumScopedState: row.state,
        authLineageId: `scoped:${createHash('sha256').update(row.accountId).digest('hex')}`,
        refresh: '',
        // Provider identity, not rotating bearer material, owns these observations.
        quota: existing?.quota,
        profile: existing?.profile,
        prime: existing?.prime,
        lastUsed: existing?.lastUsed,
        lastQuotaRefreshError: existing?.lastQuotaRefreshError,
      }
    })
  const byId = new Map(next.map((account) => [account.id, account]))
  const ordered = storage.accounts.flatMap<FallbackAccount>((account) => {
    if (!isOAuthAccount(account)) return [account]
    const replacement = byId.get(account.id)
    if (!replacement) return []
    byId.delete(account.id)
    return [replacement]
  })
  ordered.push(...byId.values())
  const projected: AccountStorage = {
    ...storage,
    claustrum: {
      ...storage.claustrum,
      scopedRoster: true,
      rosterView: view,
      primaryAccount: primary
        ? {
            credentialId: primary.credentialId,
            accountId: primary.accountId as ProviderAccountUuid,
            state: primary.state,
          }
        : undefined,
      disabledAccountIdentities: [...disabled].sort(),
    },
    accounts: ordered,
  }
  return { primary, accounts: next, storage: projected, view }
}

/**
 * The lease covers LIST and commit, not just the file write: opaque view hashes
 * cannot tell a delayed old response from a newer one. A lost lease is checked
 * while holding the config lock, before any authoritative membership write.
 * Neither local mode nor a failed list can publish an empty inventory.
 */
export async function refreshClaustrumScopedRoster(options: {
  path: string
  custody: Pick<ClaustrumScopedCustody, 'discover'>
  signal?: AbortSignal
  now?: () => number
}): Promise<ClaustrumScopedRoster | undefined> {
  options.signal?.throwIfAborted()
  if (getClaustrumMode(await loadAccounts(options.path)) !== 'claustrum')
    return undefined
  const lease = await acquireRefreshFileLock({
    name: 'scoped-roster',
    path: options.path,
    ttlMs: 30_000,
    renew: true,
  })
  if (!lease) {
    // A peer owns the only LIST/commit lease. Its last committed, secret-free
    // roster is still authoritative for dispatch: getScoped revalidates the
    // selected account and record version before every physical send.
    const persisted = await loadAccounts(options.path)
    options.signal?.throwIfAborted()
    if (
      getClaustrumMode(persisted) !== 'claustrum' ||
      persisted?.claustrum?.scopedRoster !== true ||
      !persisted.claustrum.primaryAccount?.credentialId ||
      !persisted.claustrum.primaryAccount.accountId
    ) {
      throw new ClaustrumRosterBusyError()
    }
    const primary = persisted.claustrum.primaryAccount
    const accounts = persisted.accounts.filter(
      (account): account is OAuthAccount =>
        isOAuthAccount(account) && Boolean(account.claustrumScopedCredentialId),
    )
    // Older rosters predate the persisted producer cursor; derive a stable
    // one only for those stores. New commits reuse the exact producer view so
    // competing instances do not alternate their onRoster notifications.
    const view =
      persisted.claustrum.rosterView ??
      `persisted:${createHash('sha256')
        .update(
          JSON.stringify([
            primary.credentialId,
            primary.accountId,
            primary.state,
            accounts.map((account) => [
              account.id,
              account.claustrumScopedCredentialId,
              account.anthropicAccountUuid,
              account.claustrumScopedState,
              account.enabled,
            ]),
          ]),
        )
        .digest('hex')}`
    return { primary, accounts, storage: persisted, view }
  }
  try {
    if (getClaustrumMode(await loadAccounts(options.path)) !== 'claustrum')
      return undefined
    const inventory = await options.custody.discover(options.signal)
    options.signal?.throwIfAborted()
    const result = await mutateAccountsPersistent<
      ClaustrumScopedRoster | undefined
    >(
      options.path,
      (current) => {
        if (getClaustrumMode(current) !== 'claustrum')
          return { storage: current, result: undefined, save: false }
        const roster = projectClaustrumScopedRoster(
          current,
          inventory.accounts,
          inventory.view,
          options.now?.(),
        )
        const retained = new Set(
          roster.storage.accounts.map((account) => account.id),
        )
        const removedAccountIds = current.accounts
          .filter(
            (account) => isOAuthAccount(account) && !retained.has(account.id),
          )
          .map((account) => account.id)
        return {
          storage: roster.storage,
          result: roster,
          options: { removedAccountIds, preserveExistingAccountOrder: false },
          save: JSON.stringify(current) !== JSON.stringify(roster.storage),
        }
      },
      {
        assertAuthority: async () => {
          options.signal?.throwIfAborted()
          await lease.assertOwned()
        },
      },
    )
    if (!result) return undefined
    const persisted = await loadAccounts(options.path)
    options.signal?.throwIfAborted()
    await lease.assertOwned()
    if (!persisted || getClaustrumMode(persisted) !== 'claustrum')
      return undefined
    return {
      ...result,
      storage: persisted,
      accounts: persisted.accounts.filter(
        (account): account is OAuthAccount =>
          isOAuthAccount(account) &&
          Boolean(account.claustrumScopedCredentialId),
      ),
    }
  } finally {
    await lease.release()
  }
}
