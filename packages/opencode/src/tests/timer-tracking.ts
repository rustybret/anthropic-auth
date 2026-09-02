import { mock } from 'bun:test'

export type PluginTimerOverrides = Partial<{
  setInterval: typeof globalThis.setInterval
  clearInterval: typeof globalThis.clearInterval
}>

export function createTimerTracking() {
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const activeIntervals = new Set<ReturnType<typeof setInterval>>()
  let disabledIntervalCalls = 0

  function disabledPluginTimerOverrides(): PluginTimerOverrides {
    return {
      // Background intervals must not outlive the test-scoped fetch mock they captured.
      setInterval: mock(() => {
        disabledIntervalCalls += 1
        return { unref() {} } as unknown as ReturnType<typeof setInterval>
      }) as unknown as typeof setInterval,
      clearInterval: mock(() => {}) as unknown as typeof clearInterval,
    }
  }

  const trackedSetInterval = mock((...args: Parameters<typeof setInterval>) => {
    const timer = originalSetInterval(...args)
    activeIntervals.add(timer)
    return timer
  }) as unknown as typeof setInterval
  const trackedClearInterval = mock(
    (timer: Parameters<typeof clearInterval>[0]) => {
      // Forward only handles this helper created; the disabled mock's fake
      // handle object must not reach the real clearInterval.
      if (activeIntervals.delete(timer as ReturnType<typeof setInterval>)) {
        originalClearInterval(timer)
      }
    },
  ) as unknown as typeof clearInterval

  return {
    originalSetInterval,
    originalClearInterval,
    activeIntervals,
    disabledPluginTimerOverrides,
    trackedSetInterval,
    trackedClearInterval,
    get disabledIntervalCalls() {
      return disabledIntervalCalls
    },
    reset() {
      disabledIntervalCalls = 0
      for (const timer of activeIntervals) originalClearInterval(timer)
      activeIntervals.clear()
    },
    async withTrackedInterval<T>(callback: () => T | Promise<T>): Promise<T> {
      const existingIntervals = new Set(activeIntervals)
      try {
        return await callback()
      } finally {
        for (const timer of activeIntervals) {
          if (!existingIntervals.has(timer)) trackedClearInterval(timer)
        }
      }
    },
  }
}
