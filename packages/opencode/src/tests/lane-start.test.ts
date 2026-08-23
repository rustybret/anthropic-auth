import { describe, expect, test } from 'bun:test'
import {
  fireLaneStart,
  LANE_START_REQUEST_HEADER,
  LANE_START_TEXT,
  LaneStartTracker,
} from '../lane-start'

function startParts() {
  return [{ type: 'text', text: LANE_START_TEXT, synthetic: true }]
}

describe('fireLaneStart', () => {
  test('sends the exact visible synthetic prompt with resolved context', async () => {
    const calls: unknown[] = []
    await fireLaneStart(
      {
        session: {
          messages: async () => ({ data: [] }),
          get: async () => ({
            data: {
              agent: 'build',
              model: {
                providerID: 'anthropic',
                modelID: 'claude-sonnet-4-5',
                variant: 'high',
              },
            },
          }),
          promptAsync: async (request: unknown) => calls.push(request),
        },
      },
      'session-a',
    )

    expect(calls).toEqual([
      {
        path: { id: 'session-a' },
        body: {
          noReply: false,
          parts: startParts(),
          agent: 'build',
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
          variant: 'high',
        },
      },
    ])
  })

  test('rejects when the plugin client cannot create the prompt', async () => {
    await expect(fireLaneStart({ session: {} }, 'session-a')).rejects.toThrow(
      'OpenCode plugin client does not support session.promptAsync',
    )
  })
})

describe('LaneStartTracker', () => {
  test('binds only the exact synthetic marker and consumes the matching header once', () => {
    const tracker = new LaneStartTracker()
    expect(
      tracker.observeSyntheticMessage({
        sessionId: 'session-a',
        messageId: 'start-a',
        parts: startParts(),
      }),
    ).toBe(true)
    expect(
      tracker.observeSyntheticMessage({
        sessionId: 'session-a',
        messageId: 'real-a',
        parts: [{ type: 'text', text: LANE_START_TEXT }],
      }),
    ).toBe(false)

    const headers: Record<string, string> = {}
    expect(
      tracker.markHeaders({
        sessionId: 'session-a',
        messageId: 'real-a',
        headers,
      }),
    ).toBe(false)
    expect(headers).toEqual({})
    expect(
      tracker.markHeaders({
        sessionId: 'session-a',
        messageId: 'start-a',
        headers,
      }),
    ).toBe(true)
    expect(headers).toEqual({ [LANE_START_REQUEST_HEADER]: '1' })
    expect(
      tracker.markHeaders({
        sessionId: 'session-a',
        messageId: 'start-a',
        headers: {},
      }),
    ).toBe(false)
  })

  test('does not cross-mark concurrent sessions or an interleaved real turn', () => {
    const tracker = new LaneStartTracker()
    tracker.observeSyntheticMessage({
      sessionId: 'session-a',
      messageId: 'start-a',
      parts: startParts(),
    })
    tracker.observeSyntheticMessage({
      sessionId: 'session-b',
      messageId: 'start-b',
      parts: startParts(),
    })

    expect(
      tracker.markHeaders({
        sessionId: 'session-a',
        messageId: 'real-a',
        headers: {},
      }),
    ).toBe(false)
    expect(
      tracker.markHeaders({
        sessionId: 'session-b',
        messageId: 'start-a',
        headers: {},
      }),
    ).toBe(false)
    expect(
      tracker.markHeaders({
        sessionId: 'session-a',
        messageId: 'start-a',
        headers: {},
      }),
    ).toBe(true)
    expect(
      tracker.markHeaders({
        sessionId: 'session-b',
        messageId: 'start-b',
        headers: {},
      }),
    ).toBe(true)
  })

  test('tracks multiple starts, evicts the oldest pending ID, and clears one session', () => {
    const tracker = new LaneStartTracker()
    for (let index = 0; index <= 1000; index++) {
      tracker.observeSyntheticMessage({
        sessionId: 'session-a',
        messageId:
          index === 0 ? 'first' : index === 1 ? 'second' : `start-${index}`,
        parts: startParts(),
      })
    }
    expect(
      tracker.markHeaders({
        sessionId: 'session-a',
        messageId: 'first',
        headers: {},
      }),
    ).toBe(false)
    expect(
      tracker.markHeaders({
        sessionId: 'session-a',
        messageId: 'second',
        headers: {},
      }),
    ).toBe(true)
    tracker.observeSyntheticMessage({
      sessionId: 'session-a',
      messageId: 'second',
      parts: startParts(),
    })
    tracker.observeSyntheticMessage({
      sessionId: 'session-b',
      messageId: 'other',
      parts: startParts(),
    })
    tracker.clearSession('session-a')
    expect(
      tracker.markHeaders({
        sessionId: 'session-a',
        messageId: 'second',
        headers: {},
      }),
    ).toBe(false)
    expect(
      tracker.markHeaders({
        sessionId: 'session-b',
        messageId: 'other',
        headers: {},
      }),
    ).toBe(true)
  })
})
