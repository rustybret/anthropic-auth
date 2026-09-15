import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStorage,
  CacheKeepManager,
  FallbackAccountManager,
  PrimeManager,
  type PrimeManagerOptions,
  saveAccounts,
} from '@cortexkit/anthropic-auth-core'
import { adoptPrimeManager } from '../prime-manager-registry.ts'
import {
  createTimerTracking,
  type PluginTimerOverrides,
} from './timer-tracking'

// Spies installed on shared prototypes before the plugin factory runs;
// restored in afterEach so unrelated tests are not affected. They call through
// so timer-tracking assertions exercise the real teardown implementations.
const originalCacheKeepStop = CacheKeepManager.prototype.stop
const originalFallbackStop =
  FallbackAccountManager.prototype.stopBackgroundRefresh
const cacheKeepStopSpy = mock(function (this: CacheKeepManager) {
  return originalCacheKeepStop.call(this)
})
const fallbackStopSpy = mock(function (this: FallbackAccountManager) {
  return originalFallbackStop.call(this)
})

const timerTracking = createTimerTracking()
const { activeIntervals, disabledPluginTimerOverrides } = timerTracking

let tempDir: string
const originalFetch = globalThis.fetch

beforeEach(async () => {
  timerTracking.reset()
  cacheKeepStopSpy.mockClear()
  fallbackStopSpy.mockClear()
  CacheKeepManager.prototype.stop =
    cacheKeepStopSpy as unknown as typeof CacheKeepManager.prototype.stop
  FallbackAccountManager.prototype.stopBackgroundRefresh =
    fallbackStopSpy as unknown as typeof FallbackAccountManager.prototype.stopBackgroundRefresh
  const { installDefaultFetchMock } = await import('./test-fetch')
  installDefaultFetchMock()
  tempDir = await mkdtemp(join(tmpdir(), 'anthropic-dispose-test-'))
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(
    tempDir,
    'anthropic-auth.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = join(
    tempDir,
    'sidebar-state.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR = join(
    tempDir,
    'cachekeep-registry',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR = join(
    tempDir,
    'quota-header-feed',
  )
  await saveAccounts(baseStorage())
})

afterEach(async () => {
  try {
    CacheKeepManager.prototype.stop = originalCacheKeepStop
    FallbackAccountManager.prototype.stopBackgroundRefresh =
      originalFallbackStop
    const currentFetch = globalThis.fetch as typeof fetch | undefined
    if (currentFetch) globalThis.fetch = originalFetch
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
    delete process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE
    delete process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR
    delete process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  } finally {
    expect(activeIntervals.size).toBe(0)
  }
})

function baseStorage(): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    fallbackOn: [401, 403, 429],
    accounts: [],
    quota: {
      enabled: true,
      checkIntervalMinutes: 5,
      minimumRemaining: { five_hour: 10, seven_day: 20 },
      failClosedOnUnknownQuota: true,
    },
  }
}

function createMockClient() {
  return {
    auth: { set: mock(() => Promise.resolve()) },
    session: {
      promptAsync: mock((_input: unknown) => Promise.resolve()),
    },
  }
}

async function getPlugin(
  timerOverrides?: PluginTimerOverrides,
  directory?: string,
) {
  const { AnthropicAuthPlugin } = await import('../index')
  const defaultTimerOverrides = disabledPluginTimerOverrides()
  return (await (
    AnthropicAuthPlugin as unknown as (
      ctx: Parameters<typeof AnthropicAuthPlugin>[0],
      timers?: PluginTimerOverrides,
    ) => ReturnType<typeof AnthropicAuthPlugin>
  )(
    {
      // @ts-expect-error: minimal mock for testing
      client: createMockClient(),
      ...(directory && { directory }),
    },
    { ...defaultTimerOverrides, ...timerOverrides },
  )) as Promise<any>
}

describe('dispose stops per-instance background services', () => {
  test('dispose clears the fallback background refresh interval', async () => {
    const plugin = await getPlugin()
    // startBackgroundRefresh sets a real interval via runtimeTimers.setInterval;
    // disabledPluginTimerOverrides replaced those with no-op mocks, so the
    // call count is what proves the manager wired up its timer.
    expect(timerTracking.disabledIntervalCalls).toBeGreaterThanOrEqual(1)
    const intervalCallsBeforeDispose = timerTracking.disabledIntervalCalls

    await plugin.dispose?.()

    expect(fallbackStopSpy).toHaveBeenCalledTimes(1)
    // Disposing must not schedule any additional intervals for this instance.
    expect(timerTracking.disabledIntervalCalls).toBe(intervalCallsBeforeDispose)
  })

  test('dispose calls cacheKeepManager.stop', async () => {
    const plugin = await getPlugin()
    cacheKeepStopSpy.mockClear()

    await plugin.dispose?.()

    expect(cacheKeepStopSpy).toHaveBeenCalledTimes(1)
  })

  test('dispose clears tracked fallback and main refresh intervals', async () => {
    const plugin = await getPlugin({
      setInterval: timerTracking.trackedSetInterval,
      clearInterval: timerTracking.trackedClearInterval,
    })
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 8 * 60 * 60_000,
        }),
      { models: {} },
    )

    expect(activeIntervals.size).toBeGreaterThanOrEqual(2)

    await plugin.dispose?.()

    expect(activeIntervals.size).toBe(0)
  })
})

describe('prime manager adoption leases', () => {
  const storageOptions = (path: string): PrimeManagerOptions => ({
    storagePath: path,
    getAccountFingerprint: async () => '0123456789abcdef',
    loadStorage: async () => null,
    refreshQuota: async () => ({
      quota: {
        usedPercent: 0,
        remainingPercent: 100,
        checkedAt: Date.now(),
      },
      fresh: true,
    }),
    sendPrime: async () => ({ ok: true, status: 200, ms: 1 }),
    recordSuccess: async () => ({
      count: 1,
      inputTokens: 0,
      outputTokens: 0,
      since: Date.now(),
    }),
  })

  test('releasing one of two slots keeps the shared manager alive for the sibling', () => {
    const path = join(
      tmpdir(),
      `prime-shared-${Date.now()}-${Math.random()}.json`,
    )
    const first = adoptPrimeManager(
      path,
      () => new PrimeManager(storageOptions(path)),
      { slot: 'slot-a', rebind: () => {} },
    )
    const second = adoptPrimeManager(
      path,
      () => {
        throw new Error('same-path adoption should not construct a duplicate')
      },
      { slot: 'slot-b', rebind: () => {} },
    )
    expect(second.manager).toBe(first.manager)
    first.manager.start()

    first.release()

    expect(first.manager.isStopped()).toBe(false)
    second.release()
    expect(first.manager.isStopped()).toBe(true)
  })

  test('releasing the last slot evicts and stops the manager', () => {
    const path = join(
      tmpdir(),
      `prime-last-slot-${Date.now()}-${Math.random()}.json`,
    )
    const adoption = adoptPrimeManager(
      path,
      () => new PrimeManager(storageOptions(path)),
      { slot: 'slot-solo', rebind: () => {} },
    )
    adoption.manager.start()

    adoption.release()

    expect(adoption.manager.isStopped()).toBe(true)
    let constructed = 0
    const replacement = adoptPrimeManager(
      path,
      () => {
        constructed += 1
        return new PrimeManager(storageOptions(path))
      },
      { slot: 'slot-solo', rebind: () => {} },
    )
    expect(constructed).toBe(1)
    replacement.release()
  })

  test('releasing a lease twice is a no-op', () => {
    const path = join(
      tmpdir(),
      `prime-idempotent-${Date.now()}-${Math.random()}.json`,
    )
    const adoption = adoptPrimeManager(
      path,
      () => new PrimeManager(storageOptions(path)),
      { slot: 'slot-known', rebind: () => {} },
    )
    adoption.manager.start()

    adoption.release()
    expect(() => adoption.release()).not.toThrow()
    expect(adoption.manager.isStopped()).toBe(true)
  })

  test('a late release cannot clobber a same-path successor lease', () => {
    const path = join(
      tmpdir(),
      `prime-same-path-${Date.now()}-${Math.random()}.json`,
    )
    const predecessor = adoptPrimeManager(
      path,
      () => new PrimeManager(storageOptions(path)),
      { slot: 'D', rebind: () => {} },
    )
    predecessor.manager.start()
    const successor = adoptPrimeManager(
      path,
      () => {
        throw new Error('same-path adoption should not construct a duplicate')
      },
      { slot: 'D', rebind: () => {} },
    )

    predecessor.release()

    expect(successor.manager.isStopped()).toBe(false)
    successor.release()
    expect(successor.manager.isStopped()).toBe(true)
  })

  test('a late release cannot clobber a different-path successor lease', () => {
    const pathX = join(
      tmpdir(),
      `prime-late-x-${Date.now()}-${Math.random()}.json`,
    )
    const pathY = join(
      tmpdir(),
      `prime-late-y-${Date.now()}-${Math.random()}.json`,
    )
    const pathZ = join(
      tmpdir(),
      `prime-late-z-${Date.now()}-${Math.random()}.json`,
    )

    const initialX = adoptPrimeManager(
      pathX,
      () => new PrimeManager(storageOptions(pathX)),
      { slot: 'D', rebind: () => {} },
    )
    initialX.manager.start()
    const managerY = adoptPrimeManager(
      pathY,
      () => new PrimeManager(storageOptions(pathY)),
      { slot: 'D', rebind: () => {} },
    )
    managerY.manager.start()
    expect(initialX.manager.isStopped()).toBe(true)

    initialX.release()

    const managerZ = adoptPrimeManager(
      pathZ,
      () => new PrimeManager(storageOptions(pathZ)),
      { slot: 'D', rebind: () => {} },
    )
    managerZ.manager.start()
    expect(managerY.manager.isStopped()).toBe(true)

    let constructedUnderY = 0
    const reentryY = adoptPrimeManager(
      pathY,
      () => {
        constructedUnderY += 1
        return new PrimeManager(storageOptions(pathY))
      },
      { slot: 're-entry', rebind: () => {} },
    )
    expect(constructedUnderY).toBe(1)

    managerZ.release()
    reentryY.release()
  })
})
