import {
  type ClaustrumClient,
  ClaustrumCredentialError,
  type ClaustrumReporterSource,
  type EnrollmentTokenFile,
} from '@cortexkit/claustrum-client'
import { CUSTODY_TOMBSTONE_PREFIX } from './claustrum.js'
import { readClaustrumEnrollmentToken } from './claustrum-enrollment.js'
import { parseJsonRedacted } from './json.js'

export type ClaustrumScopedClient = Pick<
  ClaustrumClient,
  'listScoped' | 'getScoped' | 'reportAuthFailureScoped' | 'close'
>
export interface ClaustrumScopedIdentity {
  readonly credentialId: string
  readonly accountId: string
}
export interface ClaustrumScopedAccount extends ClaustrumScopedIdentity {
  readonly state: string
  readonly email?: string
  readonly orgName?: string
}
export interface ClaustrumScopedAttempt extends ClaustrumScopedIdentity {
  /** Non-enumerable, memory-only bearer. Authorize again for every dispatch/retry. */
  readonly accessToken: string
  readonly recordVersion: number
  readonly expiresAtMs: number
}

/** Only a new version of the same account may replace an in-flight 401. */
export function isScopedCredentialRotation(
  served: ClaustrumScopedAttempt,
  current: ClaustrumScopedAttempt | undefined,
): current is ClaustrumScopedAttempt {
  return (
    current !== undefined &&
    current.credentialId === served.credentialId &&
    current.accountId === served.accountId &&
    current.recordVersion !== served.recordVersion
  )
}

const SERVING_MARGIN_MS = 300_000

function accessTokenFromMaterial(material: string): string {
  let access = material.trim()
  if (access.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = parseJsonRedacted(access)
    } catch {
      throw new Error('Claustrum returned invalid OAuth material')
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Claustrum returned invalid OAuth material')
    }
    const record = parsed as Record<string, unknown>
    const value = record.access_token ?? record.access
    access = typeof value === 'string' ? value : ''
  }
  if (
    !/^[\x21-\x7e]+$/.test(access) ||
    access.startsWith(CUSTODY_TOMBSTONE_PREFIX)
  ) {
    throw new Error('Claustrum returned invalid OAuth material')
  }
  return access
}

/**
 * Shared OpenCode/Pi scoped read plane. There is intentionally no credential cache,
 * handle fallback, or get single-flight: each outgoing attempt must be authorized
 * by the daemon, including attempts made after a successful earlier request.
 * Enrollment tokens are re-read per operation so operator reissue works on disk.
 */
export class ClaustrumScopedCustody {
  readonly #client: ClaustrumScopedClient
  readonly #readToken: () => Promise<EnrollmentTokenFile>
  readonly #now: () => number
  readonly #provenance = new WeakMap<ClaustrumScopedAttempt, string>()
  readonly #reports = new WeakMap<ClaustrumScopedAttempt, Promise<void>>()
  #closed = false

  constructor(options: {
    client: ClaustrumScopedClient
    tokenPath?: string
    readToken?: () => Promise<EnrollmentTokenFile>
    now?: () => number
  }) {
    const tokenPath = options.tokenPath
    if (options.readToken) {
      this.#readToken = options.readToken
    } else if (tokenPath) {
      this.#readToken = () => readClaustrumEnrollmentToken(tokenPath)
    } else {
      throw new Error('Claustrum enrollment token path is required')
    }
    this.#client = options.client
    this.#now = options.now ?? Date.now
  }

  #check(signal?: AbortSignal): void {
    if (this.#closed) throw new Error('Claustrum scoped custody is closed')
    signal?.throwIfAborted()
  }

  async #token(signal?: AbortSignal): Promise<string> {
    this.#check(signal)
    const value = await this.#readToken()
    this.#check(signal)
    if (
      !/^[0-9a-f]{64}$/.test(value.token) ||
      !Number.isSafeInteger(value.token_generation) ||
      value.token_generation < 1
    ) {
      throw new Error('Invalid Claustrum enrollment token')
    }
    return value.token
  }

  async #call<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.#check(signal)
    let result: T
    let removeAbortListener: (() => void) | undefined
    try {
      const pending = operation()
      result = signal
        ? await Promise.race([
            pending,
            new Promise<never>((_resolve, reject) => {
              const abort = () => reject(signal.reason)
              signal.addEventListener('abort', abort, { once: true })
              removeAbortListener = () =>
                signal.removeEventListener('abort', abort)
              if (signal.aborted) abort()
            }),
          ])
        : await pending
    } catch (error) {
      this.#check(signal)
      // Preserve producer-owned classifications, never arbitrary transport text
      // which may echo request params containing the enrollment bearer.
      if (error instanceof ClaustrumCredentialError) throw error
      throw new Error('Claustrum scoped operation unavailable')
    } finally {
      removeAbortListener?.()
    }
    this.#check(signal)
    return result
  }

  async discover(signal?: AbortSignal): Promise<{
    view: string
    accounts: readonly ClaustrumScopedAccount[]
  }> {
    const token = await this.#token(signal)
    const inventory = await this.#call(
      () => this.#client.listScoped(token),
      signal,
    )
    const seen = new Set<string>()
    const accounts: ClaustrumScopedAccount[] = []
    for (const row of inventory.rows) {
      if (
        row.refreshAdapter !== 'anthropic' ||
        row.credentialType !== 'oauth' ||
        !row.operations.includes('read')
      )
        continue
      if (!row.id || !row.accountId?.trim() || seen.has(row.id)) {
        throw new Error(
          'Claustrum inventory has missing or ambiguous account identity',
        )
      }
      seen.add(row.id)
      accounts.push(
        Object.freeze({
          credentialId: row.id,
          accountId: row.accountId,
          state: row.state,
          ...(row.email !== undefined && { email: row.email }),
          ...(row.orgName !== undefined && { orgName: row.orgName }),
        }),
      )
    }
    return { view: inventory.view, accounts: Object.freeze(accounts) }
  }

  async authorize(
    identity: ClaustrumScopedIdentity,
    signal?: AbortSignal,
  ): Promise<ClaustrumScopedAttempt> {
    if (!identity.credentialId || !identity.accountId)
      throw new Error('Claustrum dispatch requires account identity')
    // Capture caller fields before yielding so mutation cannot change the fence.
    const { credentialId, accountId } = identity
    const token = await this.#token(signal)
    const served = await this.#call(
      () =>
        this.#client.getScoped({
          credentialId,
          enrollmentToken: token,
          minTtlMs: SERVING_MARGIN_MS,
        }),
      signal,
    )
    if (
      served.credentialId !== credentialId ||
      served.accountId !== accountId
    ) {
      throw new Error('Claustrum served credential identity changed')
    }
    if (
      !Number.isSafeInteger(served.recordVersion) ||
      served.recordVersion < 0 ||
      served.expiresAtMs === null ||
      !Number.isFinite(served.expiresAtMs) ||
      served.expiresAtMs - this.#now() < SERVING_MARGIN_MS
    ) {
      throw new Error('Claustrum served credential has insufficient validity')
    }
    const accessToken = accessTokenFromMaterial(served.material)
    const attempt = Object.freeze(
      Object.defineProperty(
        {
          credentialId,
          accountId,
          recordVersion: served.recordVersion,
          expiresAtMs: served.expiresAtMs,
        },
        'accessToken',
        { value: accessToken, enumerable: false },
      ),
    ) as ClaustrumScopedAttempt
    this.#provenance.set(attempt, token)
    return attempt
  }

  async reportFailure(
    attempt: ClaustrumScopedAttempt,
    status: number,
    reporterSource: ClaustrumReporterSource,
  ): Promise<void> {
    if (status !== 401) return
    this.#check()
    const token = this.#provenance.get(attempt)
    if (!token)
      throw new Error(
        'Claustrum failure report requires an original dispatch receipt',
      )
    const pending = this.#reports.get(attempt)
    if (pending) return pending
    const report = this.#call(() =>
      this.#client.reportAuthFailureScoped({
        credentialId: attempt.credentialId,
        enrollmentToken: token,
        providerStatus: 401,
        recordVersion: attempt.recordVersion,
        reporterSource,
      }),
    )
    this.#reports.set(attempt, report)
    try {
      await report
    } catch (error) {
      this.#reports.delete(attempt)
      throw error
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#client.close()
  }
}
