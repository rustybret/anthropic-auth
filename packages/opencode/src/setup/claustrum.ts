import { join } from 'node:path'
import {
  type ClaustrumEnrollmentClient,
  ClaustrumEnrollmentManager,
  type ClaustrumScopedClient,
  connectClaustrumEnrollmentClient,
  connectClaustrumScopedClient,
  getHostClaustrumEnrollmentPaths,
  readClaustrumEnrollmentStatus,
  refreshClaustrumScopedRoster,
  setClaustrumModePersistent,
} from '@cortexkit/anthropic-auth-core'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import { defaultCommandRunner } from './command-runner.ts'
import { getOpenCodeConfigDir, getPiAgentDir } from './paths.ts'
import type { CommandRunner, HarnessKind } from './types.ts'

export interface SetupClaustrumOptions {
  paths?: { tokenPath: string; statePath: string }
  ckBinary?: string
  runner?: CommandRunner
  enrollmentClient?: ClaustrumEnrollmentClient & { close?: () => void }
  scopedClient?: ClaustrumScopedClient & { close?: () => void }
  env?: NodeJS.ProcessEnv
}

export interface SetupClaustrumResult {
  ok: boolean
  message: string
  discoveredAccounts: Array<{ credentialId: string; accountId: string }>
}

const CUSTODY_MIN_TTL_MS = 300_000 // 5 minutes

export async function setupClaustrumForHost(
  host: HarnessKind,
  options: SetupClaustrumOptions = {},
): Promise<SetupClaustrumResult> {
  const runner = options.runner ?? defaultCommandRunner
  const ck = options.ckBinary ?? 'ck'
  const env = options.env ?? process.env
  const proposedName = `anthropic-auth-${host}`
  const paths = options.paths ?? getHostClaustrumEnrollmentPaths(host, env)

  // 1. Check enrollment status before opening any daemon connection, so an
  // already-approved token never requires a live enrollment client (CI and
  // isolated tests provide only a scoped mock and no daemon).
  let status = await readClaustrumEnrollmentStatus(paths, proposedName)
  let enrollClient:
    | (ClaustrumEnrollmentClient & { close?: () => void })
    | undefined = options.enrollmentClient
  let ownedEnrollClient = false
  const ensureEnrollClient = async () => {
    if (!enrollClient) {
      enrollClient = await connectClaustrumEnrollmentClient()
      ownedEnrollClient = true
    }
    return enrollClient
  }

  try {
    const recoverableRequestCodes = new Set([
      'superseded',
      'not_found',
      'already_consumed',
    ])
    if (
      status.state === 'idle' ||
      status.state === 'pending' ||
      (status.state === 'blocked' && recoverableRequestCodes.has(status.code))
    ) {
      // Setup, unlike a plugin boot or status view, is an explicit enrollment
      // action. Reconcile even an existing request before asking ck to approve
      // it; a crash between secret persistence and propose must also resume.
      const manager = new ClaustrumEnrollmentManager({
        client: await ensureEnrollClient(),
        paths,
        proposedName,
      })
      status = await manager.reconcile()
      if (
        status.state === 'blocked' &&
        recoverableRequestCodes.has(status.code)
      ) {
        // The daemon proved this request ID dead. Clear it only through the
        // locked terminal reset, then issue at most one new proposal for this
        // user-invoked setup. Denials and other blocked causes stay terminal.
        const reset = await manager.resetTerminal()
        if (reset !== 'reset') {
          return {
            ok: false,
            message: `Enrollment changed during setup (state: ${reset}); retry setup`,
            discoveredAccounts: [],
          }
        }
        status = await manager.reconcile()
      }
    }

    // 2. If pending, approve via ck CLI
    if (status.state === 'pending' && status.requestId) {
      const approveRes = await runner.run(
        ck,
        [
          'auth',
          'enroll',
          'approve',
          '--request-id',
          status.requestId,
          '--name',
          proposedName,
        ],
        { env },
      )
      if (approveRes.exitCode !== 0) {
        return {
          ok: false,
          message: `Failed to approve enrollment via ck: ${approveRes.stderr.trim() || `exit ${approveRes.exitCode}`}`,
          discoveredAccounts: [],
        }
      }

      const manager = new ClaustrumEnrollmentManager({
        client: await ensureEnrollClient(),
        paths,
        proposedName,
      })
      status = await manager.reconcile()
    }

    if (status.state !== 'approved') {
      return {
        ok: false,
        message: `Enrollment did not complete (state: ${status.state})`,
        discoveredAccounts: [],
      }
    }

    // 3. Grant category:anthropic-native read access
    const grantRes = await runner.run(
      ck,
      [
        'auth',
        'grant',
        '--principal',
        `enrolled:${proposedName}`,
        '--selector-kind',
        'category',
        '--selector',
        'anthropic-native',
        '--operation',
        'read',
      ],
      { env },
    )
    if (grantRes.exitCode !== 0) {
      return {
        ok: false,
        message: `Failed to grant anthropic-native access: ${grantRes.stderr.trim() || `exit ${grantRes.exitCode}`}`,
        discoveredAccounts: [],
      }
    }

    // 4. Verify discovery and account reach
    const { readClaustrumEnrollmentToken } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    const tokenFile = await readClaustrumEnrollmentToken(paths.tokenPath)

    const scopedClient =
      options.scopedClient ?? (await connectClaustrumScopedClient())

    try {
      const inventory = await scopedClient.listScoped(tokenFile.token)
      const rows = inventory.rows.filter(
        (r: ScopedInventoryRow) =>
          r.refreshAdapter === 'anthropic' &&
          r.categories?.includes('anthropic-native') &&
          r.operations?.includes('read') &&
          r.state === 'active',
      )

      if (rows.length === 0) {
        return {
          ok: false,
          message: 'No active Anthropic accounts found in Claustrum vault',
          discoveredAccounts: [],
        }
      }

      const now = Date.now()
      const verifiedAccounts: Array<{
        credentialId: string
        accountId: string
      }> = []

      for (const row of rows) {
        let receipt:
          | Awaited<ReturnType<ClaustrumScopedClient['getScoped']>>
          | undefined
        try {
          receipt = await scopedClient.getScoped({
            credentialId: row.id,
            enrollmentToken: tokenFile.token,
            minTtlMs: CUSTODY_MIN_TTL_MS,
          })
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error)
          return {
            ok: false,
            message: `Scoped retrieval failed for ${row.id}: ${msg}`,
            discoveredAccounts: [],
          }
        }

        // Strict verification: require exact IDs and finite valid expiry >= 5m
        if (
          !receipt ||
          typeof receipt.credentialId !== 'string' ||
          receipt.credentialId !== row.id ||
          typeof receipt.accountId !== 'string' ||
          receipt.accountId !== row.accountId ||
          typeof receipt.expiresAtMs !== 'number' ||
          !Number.isFinite(receipt.expiresAtMs) ||
          receipt.expiresAtMs < now + CUSTODY_MIN_TTL_MS ||
          typeof receipt.material !== 'string' ||
          !receipt.material.trim()
        ) {
          return {
            ok: false,
            message: `Invalid or incomplete credential served for ${row.id}`,
            discoveredAccounts: [],
          }
        }

        verifiedAccounts.push({
          credentialId: row.id,
          accountId: receipt.accountId,
        })
      }

      // 5. Update host account storage with scoped roster
      const hostStorageDir =
        host === 'opencode' ? getOpenCodeConfigDir(env) : getPiAgentDir(env)
      const storagePath = join(hostStorageDir, 'anthropic-auth.json')

      await setClaustrumModePersistent('claustrum', storagePath)

      const { ClaustrumScopedCustody } = await import(
        '@cortexkit/anthropic-auth-core'
      )
      const custody = new ClaustrumScopedCustody({
        client: scopedClient,
        readToken: async () => tokenFile,
      })

      const roster = await refreshClaustrumScopedRoster({
        path: storagePath,
        custody,
      })

      if (!roster) {
        return {
          ok: false,
          message: `Failed to commit scoped roster for ${host}`,
          discoveredAccounts: [],
        }
      }

      return {
        ok: true,
        message: `Configured Claustrum custody with ${verifiedAccounts.length} Anthropic account(s)`,
        discoveredAccounts: verifiedAccounts,
      }
    } finally {
      if (!options.scopedClient) {
        scopedClient.close?.()
      }
    }
  } finally {
    if (ownedEnrollClient) {
      enrollClient?.close?.()
    }
  }
}
