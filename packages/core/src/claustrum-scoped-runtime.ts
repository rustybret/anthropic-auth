import {
  ClaustrumClient,
  type ClaustrumClientOptions,
} from '@cortexkit/claustrum-client'
import {
  fetchOAuthQuotaSnapshot,
  getClaustrumMode,
  isOAuthAccount,
  loadAccounts,
} from './accounts.js'
import type { ProviderAccountUuid } from './claude-code.js'
import { resolveClaustrumConnectionPath } from './claustrum.js'
import {
  type ClaustrumScopedAttempt,
  type ClaustrumScopedClient,
  ClaustrumScopedCustody,
  decideScopedRetryAfter401,
} from './claustrum-scoped.js'
import {
  type ClaustrumScopedRoster,
  refreshClaustrumScopedRoster,
} from './claustrum-scoped-roster.js'
import { fetchOAuthAccountProfile } from './oauth-profile.js'

export { ClaustrumCredentialError as ClaustrumScopedCredentialError } from '@cortexkit/claustrum-client'

export function connectClaustrumScopedClient(
  options: ClaustrumClientOptions = {},
): Promise<ClaustrumScopedClient> {
  return ClaustrumClient.connect({
    ...options,
    connectionFile: options.connectionFile ?? resolveClaustrumConnectionPath(),
  })
}

/** Host-owned lifecycle for metadata discovery. Bearer material is never cached. */
export interface ClaustrumScopedRuntimeOptions {
  storagePath: string
  tokenPath: string
  connect: () => Promise<ClaustrumScopedClient>
  /** Fired once per discovery change (including the initial snapshot),
   * keyed by the inventory view digest. Repeat polls with an identical
   * view do not notify. */
  onRoster?: (roster: ClaustrumScopedRoster) => void
  onError?: () => void
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
  pollIntervalMs?: number
}

export class ClaustrumScopedRuntime {
  readonly #options: ClaustrumScopedRuntimeOptions
  readonly #shutdown = new AbortController()
  #custody?: ClaustrumScopedCustody
  #connecting?: Promise<ClaustrumScopedCustody>
  #refreshing?: Promise<ClaustrumScopedRoster | undefined>
  #roster?: ClaustrumScopedRoster
  #timer?: ReturnType<typeof setTimeout>
  #started = false

  constructor(options: ClaustrumScopedRuntimeOptions) {
    this.#options = options
  }

  #assertOpen(signal?: AbortSignal) {
    this.#shutdown.signal.throwIfAborted()
    signal?.throwIfAborted()
  }

  #wait<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
    const combined = AbortSignal.any([
      this.#shutdown.signal,
      ...(signal ? [signal] : []),
    ])
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => combined.removeEventListener('abort', abort)
      const abort = () => {
        cleanup()
        reject(combined.reason)
      }
      combined.addEventListener('abort', abort, { once: true })
      // Observe the operation even after cancellation: shared metadata work may
      // finish for other callers, and a late connector must still be closed.
      pending.then(
        (value) => {
          cleanup()
          if (combined.aborted) reject(combined.reason)
          else resolve(value)
        },
        (error: unknown) => {
          cleanup()
          reject(error)
        },
      )
      if (combined.aborted) abort()
    })
  }

  async #getCustody(): Promise<ClaustrumScopedCustody> {
    this.#assertOpen()
    if (this.#custody) return this.#custody
    if (!this.#connecting) {
      this.#connecting = this.#options
        .connect()
        .then((client) => {
          if (this.#shutdown.signal.aborted) {
            client.close()
            this.#assertOpen()
          }
          this.#custody = new ClaustrumScopedCustody({
            client,
            tokenPath: this.#options.tokenPath,
          })
          return this.#custody
        })
        .finally(() => {
          this.#connecting = undefined
        })
    }
    return this.#wait(this.#connecting)
  }

  snapshot(): ClaustrumScopedRoster | undefined {
    return this.#roster
  }

  refresh(): Promise<ClaustrumScopedRoster | undefined> {
    this.#assertOpen()
    if (this.#refreshing) return this.#refreshing
    this.#refreshing = (async () => {
      if (
        getClaustrumMode(await loadAccounts(this.#options.storagePath)) !==
        'claustrum'
      ) {
        this.#roster = undefined
        this.#custody?.close()
        this.#custody = undefined
        return undefined
      }
      const custody = await this.#getCustody()
      const roster = await refreshClaustrumScopedRoster({
        path: this.#options.storagePath,
        custody,
        signal: this.#shutdown.signal,
      })
      this.#assertOpen()
      const changed = roster?.view !== this.#roster?.view
      this.#roster = roster
      // Notify only on discovery changes (including the initial snapshot).
      // The poll loop runs every few seconds; unconditional notification
      // would make every plugin instance rewrite shared state files on each
      // tick, clobbering fresher cross-process data (e.g. CacheKeep counts).
      if (roster && changed) this.#options.onRoster?.(roster)
      return roster
    })().finally(() => {
      this.#refreshing = undefined
    })
    return this.#refreshing
  }

  start(): void {
    if (this.#started) return
    this.#assertOpen()
    this.#started = true
    const tick = async () => {
      try {
        await this.refresh()
      } catch {
        if (!this.#shutdown.signal.aborted) this.#options.onError?.()
      }
      if (this.#shutdown.signal.aborted) return
      const delay = this.#options.pollIntervalMs ?? 5_000
      if (delay <= 0) return
      this.#timer = (this.#options.setTimeoutImpl ?? setTimeout)(() => {
        this.#timer = undefined
        void tick()
      }, delay)
      this.#timer.unref?.()
    }
    void tick()
  }

  async authorize(
    routeId: string,
    signal?: AbortSignal,
  ): Promise<ClaustrumScopedAttempt> {
    this.#assertOpen(signal)
    const roster = this.#roster ?? (await this.#wait(this.refresh(), signal))
    const current = await loadAccounts(this.#options.storagePath)
    this.#assertOpen(signal)
    if (!roster || getClaustrumMode(current) !== 'claustrum')
      throw new Error('Claustrum scoped custody is not active')
    let credentialId: string | undefined
    let accountId: string | undefined
    if (routeId === 'main') {
      const primary = current?.claustrum?.primaryAccount
      if (
        roster.primary?.state !== 'active' ||
        primary?.state !== 'active' ||
        primary.accountId !== roster.primary.accountId ||
        primary.credentialId !== roster.primary.credentialId
      )
        throw new Error('Claustrum primary account is unavailable or changed')
      credentialId = roster.primary.credentialId
      accountId = roster.primary.accountId
      if (current?.claustrum?.disabledAccountIdentities?.includes(accountId)) {
        throw new Error('Claustrum primary account is disabled')
      }
    } else {
      const observed = roster.accounts.find((account) => account.id === routeId)
      const configured = current?.accounts.find(
        (account) => account.id === routeId,
      )
      if (
        !observed ||
        !configured ||
        !isOAuthAccount(configured) ||
        configured.enabled === false ||
        configured.claustrumScopedState !== 'active' ||
        configured.claustrumScopedCredentialId !==
          observed.claustrumScopedCredentialId ||
        configured.anthropicAccountUuid !== observed.anthropicAccountUuid
      ) {
        throw new Error('Claustrum route is disabled, removed or changed')
      }
      credentialId = observed.claustrumScopedCredentialId
      accountId = observed.anthropicAccountUuid
    }
    if (!credentialId || !accountId)
      throw new Error('Claustrum route has no verified identity')
    return (await this.#wait(this.#getCustody(), signal)).authorize(
      { credentialId, accountId },
      AbortSignal.any([this.#shutdown.signal, ...(signal ? [signal] : [])]),
    )
  }

  async reportFailure(
    attempt: ClaustrumScopedAttempt,
    status: number,
    source: 'direct' | 'relay_status_field' | 'relay_message_parse',
  ): Promise<void> {
    this.#assertOpen()
    if (!this.#custody)
      throw new Error('Claustrum dispatch receipt has no active owner')
    await this.#custody.reportFailure(attempt, status, source)
  }

  async fetchQuota(routeId: string, fetchImpl: typeof fetch = fetch) {
    const attempt = await this.authorize(routeId)
    return fetchOAuthQuotaSnapshot({
      accessToken: attempt.accessToken,
      fetchImpl: this.#fetchForAttempt(routeId, attempt, fetchImpl),
    })
  }

  async fetchProfile(
    routeId: string,
    fetchImpl: typeof fetch = fetch,
    signal?: AbortSignal,
  ) {
    const attempt = await this.authorize(routeId, signal)
    return fetchOAuthAccountProfile({
      accessToken: attempt.accessToken,
      accountIdentity: attempt.accountId,
      providerAccountUuid: attempt.accountId as ProviderAccountUuid,
      signal,
      fetchImpl: this.#fetchForAttempt(routeId, attempt, fetchImpl),
    })
  }

  #fetchForAttempt(
    routeId: string,
    attempt: ClaustrumScopedAttempt,
    fetchImpl: typeof fetch,
  ): typeof fetch {
    return Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        this.#assertOpen()
        const signal = AbortSignal.any([
          this.#shutdown.signal,
          ...(init?.signal ? [init.signal] : []),
        ])
        let response = await fetchImpl(input, { ...init, signal })
        let served = attempt
        if (response.status === 401 && !signal.aborted) {
          let current: ClaustrumScopedAttempt | undefined
          try {
            current = await this.authorize(routeId, signal)
          } catch {
            // No verified replacement: retain the response and report the
            // exact receipt used by this physical request below.
          }
          if (decideScopedRetryAfter401('quota-profile', served, current)) {
            await response.body?.cancel().catch(() => {})
            const headers = new Headers(init?.headers)
            headers.set('authorization', `Bearer ${current.accessToken}`)
            served = current
            // The quota/profile requests are bodyless GETs. A transport
            // failure on the second attempt is not an OAuth rejection.
            response = await fetchImpl(input, { ...init, headers, signal })
          }
        }
        if (response.status === 401) {
          await this.reportFailure(served, 401, 'direct').catch(() =>
            this.#options.onError?.(),
          )
        }
        return response
      },
      { preconnect: fetchImpl.preconnect },
    )
  }

  close(): void {
    if (this.#shutdown.signal.aborted) return
    this.#shutdown.abort(new Error('Claustrum scoped runtime is closed'))
    if (this.#timer)
      (this.#options.clearTimeoutImpl ?? clearTimeout)(this.#timer)
    this.#timer = undefined
    this.#custody?.close()
    this.#roster = undefined
  }
}
