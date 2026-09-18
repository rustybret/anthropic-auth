import { createHash } from 'node:crypto'
import {
  type AccountStorage,
  type CustodyHandleAccount,
  type CustodyHandleManifest,
  custodyTombstoneOAuth,
  getClaustrumMode,
  isOAuthAccount,
  type OAuthAccount,
  type ProviderAccountUuid,
} from '@cortexkit/anthropic-auth-core'

const MAIN_CUSTODY_LABEL = 'main'

function bindingFingerprint(binding: CustodyHandleAccount): string {
  return createHash('sha256')
    .update(binding.label)
    .update('\0')
    .update(binding.credentialId)
    .digest('hex')
}

/**
 * Returns valid manifest bindings that are not yet represented by an OAuth
 * routing row. Existing disabled rows are intentionally retained: binding a
 * credential must not silently override a user's routing preference.
 */
export function pendingClaustrumEnrollments(
  storage: AccountStorage,
  manifest: CustodyHandleManifest | undefined,
): CustodyHandleAccount[] {
  if (getClaustrumMode(storage) !== 'claustrum' || !manifest) return []

  const oauthLabelCounts = new Map<string, number>()
  for (const account of storage.accounts) {
    if (!isOAuthAccount(account)) continue
    const label = account.label ?? account.id
    oauthLabelCounts.set(label, (oauthLabelCounts.get(label) ?? 0) + 1)
  }

  return manifest.accounts.filter((binding) => {
    if (
      binding.label === MAIN_CUSTODY_LABEL ||
      manifest.corruptLabels?.has(binding.label)
    ) {
      return false
    }
    return (oauthLabelCounts.get(binding.label) ?? 0) === 0
  })
}

/** Build the secret-free routing row for a provider-verified manifest binding. */
export function materializeClaustrumEnrollment(input: {
  storage: AccountStorage
  binding: CustodyHandleAccount
  providerAccountUuid: string
  now?: number
}): OAuthAccount {
  const fingerprint = bindingFingerprint(input.binding)
  const preferredId = input.binding.label
  const id = input.storage.accounts.some(
    (account) => account.id === preferredId,
  )
    ? `claustrum-${fingerprint}`
    : preferredId

  if (input.storage.accounts.some((account) => account.id === id)) {
    throw new Error(
      `Cannot materialize Claustrum account "${input.binding.label}": deterministic account id collision`,
    )
  }

  return {
    id,
    label: input.binding.label,
    enabled: true,
    addedAt: input.now ?? Date.now(),
    authLineageId: `claustrum-${fingerprint}`,
    anthropicAccountUuid: input.providerAccountUuid as ProviderAccountUuid,
    ...custodyTombstoneOAuth('anthropic'),
  }
}
