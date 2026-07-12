import { describe, expect, test } from 'bun:test'
import {
  FABLE_FALLBACK_MODEL_ID,
  FABLE_FALLBACK_TURNS,
  FableFallbackManager,
} from '../fable-fallback'

function body(model = 'claude-fable-5') {
  return JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'hello' }],
  })
}

describe('FableFallbackManager', () => {
  test('leaves Fable unchanged until its content filter activates a session', () => {
    const manager = new FableFallbackManager()
    const plan = manager.plan('session-a', body())

    expect(plan).toMatchObject({
      requestedModel: 'claude-fable-5',
      effectiveModel: 'claude-fable-5',
      downgraded: false,
    })
    expect(JSON.parse(plan!.bodyText).model).toBe('claude-fable-5')
  })

  test('routes the next ten successful Fable requests to Opus 4.8', () => {
    const manager = new FableFallbackManager()
    const filtered = manager.plan('session-a', body())!
    expect(manager.activate(filtered, 'fable-account')).toBe(
      FABLE_FALLBACK_TURNS,
    )

    for (
      let remaining = FABLE_FALLBACK_TURNS - 1;
      remaining >= 0;
      remaining--
    ) {
      const plan = manager.plan('session-a', body())!
      expect(plan.downgraded).toBe(true)
      expect(plan.effectiveModel).toBe(FABLE_FALLBACK_MODEL_ID)
      expect(plan.cacheAccountId).toBe('fable-account')
      expect(JSON.parse(plan.bodyText).model).toBe(FABLE_FALLBACK_MODEL_ID)
      expect(manager.complete(plan)).toEqual({ counted: true, remaining })
    }

    const restored = manager.plan('session-a', body())!
    expect(restored.downgraded).toBe(false)
    expect(JSON.parse(restored.bodyText).model).toBe('claude-fable-5')
  })

  test('retains the newest Opus cache anchor across a restored Fable period', () => {
    const manager = new FableFallbackManager()
    manager.activate(manager.plan('session-a', body())!)

    for (let index = 0; index < FABLE_FALLBACK_TURNS; index++) {
      const plan = manager.plan('session-a', body())!
      expect(
        manager.complete(plan, {
          fingerprint: `anchor-${index}`,
          messageIndex: 10 + index * 2,
          messageCount: 11 + index * 2,
          oauthAccountId: 'opus-account',
        }).counted,
      ).toBe(true)
    }

    const restored = manager.plan('session-a', body())!
    expect(restored).toMatchObject({
      downgraded: false,
      standbyCacheAnchor: {
        fingerprint: 'anchor-9',
        messageIndex: 28,
        messageCount: 29,
        oauthAccountId: 'opus-account',
      },
    })

    manager.activate(restored, 'fable-account')
    const nextCycle = manager.plan('session-a', body())!
    expect(nextCycle).toMatchObject({
      downgraded: true,
      cacheAccountId: 'fable-account',
      standbyCacheAnchor: restored.standbyCacheAnchor,
    })
  })

  test('does not replace a newer compacted standby anchor with an older concurrent response', () => {
    const manager = new FableFallbackManager()
    manager.activate(manager.plan('session-a', body())!)
    const older = manager.plan('session-a', body())!
    const newer = manager.plan('session-a', body())!

    manager.complete(newer, {
      fingerprint: 'newer',
      messageIndex: 4,
      messageCount: 5,
      oauthAccountId: 'main',
    })
    manager.complete(older, {
      fingerprint: 'older',
      messageIndex: 10,
      messageCount: 11,
      oauthAccountId: 'main',
    })

    expect(
      manager.plan('session-a', body())?.standbyCacheAnchor?.fingerprint,
    ).toBe('newer')
  })

  test('does not count failed attempts or duplicate completions', () => {
    const manager = new FableFallbackManager()
    manager.activate(manager.plan('session-a', body())!)
    const failed = manager.plan('session-a', body())!

    expect(manager.remaining('session-a')).toBe(10)
    expect(manager.complete(failed)).toEqual({ counted: true, remaining: 9 })
    expect(manager.complete(failed)).toEqual({ counted: false, remaining: 9 })
  })

  test('keeps downgrade state isolated by session and ignores other models', () => {
    const manager = new FableFallbackManager()
    manager.activate(manager.plan('session-a', body())!)

    expect(manager.plan('session-a', body())?.downgraded).toBe(true)
    expect(manager.plan('session-b', body())?.downgraded).toBe(false)
    expect(manager.plan('session-a', body('claude-opus-4-8'))).toBeNull()
    expect(manager.plan(undefined, body())).toBeNull()
  })

  test('a new filter cycle does not let an older Opus response decrement it', () => {
    const manager = new FableFallbackManager()
    const initial = manager.plan('session-a', body())!
    manager.activate(initial)
    const oldOpus = manager.plan('session-a', body())!

    // Simulate a later Fable probe being filtered again while an old Opus request
    // is still in flight.
    const probe = { ...initial }
    manager.activate(probe)

    expect(manager.complete(oldOpus)).toEqual({ counted: false, remaining: 10 })
  })
})
