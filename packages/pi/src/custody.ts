import {
  type AccountCommandResult,
  CLAUSTRUM_PI_ENROLLMENT_NAME,
  type ClaustrumEnrollmentStatus,
  type ClaustrumMode,
  type ClaustrumScopedClient,
  ClaustrumScopedCustody,
  connectClaustrumScopedClient,
  getHostClaustrumEnrollmentPaths,
  readClaustrumEnrollmentStatus,
  resetClaustrumEnrollmentState,
  setClaustrumModePersistent,
} from '@cortexkit/anthropic-auth-core'
import {
  getPiAccountStoragePath,
  getPiClaustrumConnectionOptions,
  hasPiLocalAnthropicOAuth,
} from './paths.ts'

export async function requirePiEnrollment() {
  const status = await readClaustrumEnrollmentStatus(
    getHostClaustrumEnrollmentPaths('pi'),
    CLAUSTRUM_PI_ENROLLMENT_NAME,
  )
  if (
    status.state !== 'approved' ||
    status.proposedName !== CLAUSTRUM_PI_ENROLLMENT_NAME
  ) {
    throw new Error(
      'Pi requires its own approved Claustrum enrollment; run setup',
    )
  }
  return status
}

export interface PiCustodyCommands {
  transition(mode: ClaustrumMode): Promise<AccountCommandResult>
  status(): Promise<ClaustrumEnrollmentStatus>
  reset(): Promise<AccountCommandResult>
}

export function createPiCustodyCommands(options: {
  reconfigure: () => Promise<void>
  storagePath?: string
  connect?: () => Promise<ClaustrumScopedClient>
}): PiCustodyCommands {
  const storagePath = options.storagePath ?? getPiAccountStoragePath()
  const paths = () => getHostClaustrumEnrollmentPaths('pi')
  return {
    status: () =>
      readClaustrumEnrollmentStatus(paths(), CLAUSTRUM_PI_ENROLLMENT_NAME),
    async reset() {
      const result = await resetClaustrumEnrollmentState(
        paths(),
        CLAUSTRUM_PI_ENROLLMENT_NAME,
      )
      const messages = {
        reset:
          'Terminal enrollment state cleared. Run setup to enroll Pi again.',
        idle: 'Pi has no enrollment state to reset.',
        'refused-pending': 'Refused: Pi enrollment is still pending.',
        'refused-approved':
          'Refused: Pi already has an approved enrollment token.',
        busy: 'Pi enrollment is busy in another process.',
      }
      return { text: messages[result] }
    },
    async transition(mode) {
      if (mode === 'claustrum') {
        if (await hasPiLocalAnthropicOAuth()) {
          return {
            text: 'Refused: Pi still has a local Anthropic OAuth credential. Run `bunx @cortexkit/opencode-anthropic-auth setup` to approve its removal and enable Claustrum.',
          }
        }
        // A slash command never invokes the administrative CLI or approves itself.
        // Existing enrollment and grants must be verified before committing mode.
        await requirePiEnrollment()
        const client = await (options.connect?.() ??
          connectClaustrumScopedClient(
            getPiClaustrumConnectionOptions(storagePath),
          ))
        const custody = new ClaustrumScopedCustody({
          client,
          tokenPath: paths().tokenPath,
        })
        try {
          const inventory = await custody.discover()
          const active = inventory.accounts.filter(
            (account) => account.state === 'active',
          )
          if (!active.length)
            return {
              text: 'Refused: Claustrum has no accessible active Anthropic accounts.',
            }
          for (const account of active) await custody.authorize(account)
        } finally {
          custody.close()
        }
      }
      await setClaustrumModePersistent(mode, storagePath)
      await options.reconfigure()
      return {
        text:
          mode === 'claustrum'
            ? 'Pi now uses Claustrum for Anthropic authentication.'
            : 'Pi now uses local Anthropic authentication. Use /login anthropic if needed.',
      }
    },
  }
}
