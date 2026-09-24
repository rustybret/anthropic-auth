import {
  type AccountStorage,
  type CustodyStatusState,
  getClaustrumMode,
  hasNoLocalCredential,
  isCustodyTombstoneOAuth,
  isOAuthAccount,
  type OAuthAccount,
} from '@cortexkit/anthropic-auth-core'

/** Only the enrolled scoped roster can establish vault ownership. */
export function isFallbackAccountVaultServed(
  accountId: string,
  storage: AccountStorage | null,
): boolean {
  if (
    getClaustrumMode(storage) !== 'claustrum' ||
    !storage?.claustrum?.scopedRoster
  )
    return false
  const account = storage.accounts.find(
    (candidate) => candidate.id === accountId,
  )
  return Boolean(
    account &&
      isOAuthAccount(account) &&
      account.enabled !== false &&
      account.claustrumScopedCredentialId &&
      account.anthropicAccountUuid &&
      account.claustrumScopedState === 'active' &&
      hasNoLocalCredential(account),
  )
}

export function fallbackCustodyDimensions(storage: AccountStorage | null) {
  if (getClaustrumMode(storage) !== 'claustrum')
    return { fallbacks: 'R' as const, evidence: 'V' as const }
  if (!storage?.claustrum?.scopedRoster)
    return { fallbacks: 'M' as const, evidence: 'N' as const }
  const accounts = storage.accounts.filter(
    (account): account is OAuthAccount =>
      account.enabled !== false && isOAuthAccount(account),
  )
  return {
    fallbacks: accounts.every((account) =>
      Boolean(
        account.claustrumScopedCredentialId &&
          account.anthropicAccountUuid &&
          hasNoLocalCredential(account),
      ),
    )
      ? ('T' as const)
      : ('R' as const),
    evidence: 'V' as const,
  }
}

export function mainCustodyDimension(auth: {
  type: string
  access?: string
  refresh?: string
}) {
  if (isCustodyTombstoneOAuth(auth, 'anthropic')) return 'T' as const
  if (auth.type === 'oauth' && auth.access && auth.refresh) return 'R' as const
  return 'X' as const
}

export function custodyStateFor(
  account: { id: string; role: 'main' | 'fallback' },
  storage: AccountStorage | null,
): CustodyStatusState {
  if (account.role === 'main') {
    if (getClaustrumMode(storage) !== 'claustrum') return 'na'
    const primary = storage?.claustrum?.scopedRoster
      ? storage.claustrum.primaryAccount
      : undefined
    if (!primary) return 'unknown-identity'
    if (primary.state === 'needs_reauth') return 'on-vault-reauth'
    return primary.state === 'active' ? 'on-vault-served' : 'on-cold'
  }
  if (getClaustrumMode(storage) !== 'claustrum') return 'off'
  const fallback = storage?.accounts.find(
    (candidate) => candidate.id === account.id,
  )
  if (
    !fallback ||
    !isOAuthAccount(fallback) ||
    !fallback.claustrumScopedCredentialId ||
    !fallback.anthropicAccountUuid ||
    !hasNoLocalCredential(fallback)
  )
    return 'off'
  if (fallback.claustrumScopedState === 'needs_reauth') return 'on-vault-reauth'
  return isFallbackAccountVaultServed(account.id, storage)
    ? 'on-vault-served'
    : 'on-cold'
}
