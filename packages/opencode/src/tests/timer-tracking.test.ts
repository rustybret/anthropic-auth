import { expect, test } from 'bun:test'
import { createTimerTracking } from './timer-tracking'

test('reset disarms leaked tracked intervals before dropping their handles', async () => {
  const tracking = createTimerTracking()
  let ticks = 0
  const timer = tracking.trackedSetInterval(() => {
    ticks += 1
  }, 10)

  try {
    expect(tracking.activeIntervals.size).toBe(1)

    tracking.reset()
    expect(tracking.activeIntervals.size).toBe(0)
    const ticksAfterReset = ticks
    await Bun.sleep(35)

    expect(ticks).toBe(ticksAfterReset)
  } finally {
    tracking.originalClearInterval(timer)
  }
})
