import { describe, expect, test } from 'bun:test'
import {
  collectOpenCodeEffortHistory,
  parseEffortHistory,
  serializeEffortHistory,
} from '../effort-history.ts'

const user = (
  sessionID: string,
  modelID: string,
  variant?: string,
  providerID = 'anthropic',
) => ({
  info: {
    role: 'user',
    sessionID,
    model: { providerID, modelID, variant },
  },
})
const assistant = (sessionID: string) => ({
  info: { role: 'assistant', sessionID },
})

describe('OpenCode Fable 5.1 effort history', () => {
  test('collects effort changes at assistant-message boundaries', () => {
    expect(
      collectOpenCodeEffortHistory([
        user('ses_effort', 'claude-fable-5-1', 'low'),
        assistant('ses_effort'),
        user('ses_effort', 'claude-fable-5-1', 'high'),
        assistant('ses_effort'),
        user('ses_effort', 'claude-fable-5-1', 'high'),
        assistant('ses_effort'),
        user('ses_effort', 'claude-fable-5-1', 'max'),
      ]),
    ).toEqual({
      sessionId: 'ses_effort',
      transitions: [
        { afterAssistantMessages: 0, effort: 'low' },
        { afterAssistantMessages: 1, effort: 'high' },
        { afterAssistantMessages: 3, effort: 'max' },
      ],
    })
  })

  test('defaults absent Fable 5.1 variants to high and ignores other models', () => {
    expect(
      collectOpenCodeEffortHistory([
        user('ses_effort', 'claude-fable-5', 'low'),
        assistant('ses_effort'),
        user('ses_effort', 'claude-fable-5-1'),
        assistant('ses_effort'),
        user('ses_effort', 'claude-mythos-5-1', 'max'),
      ]),
    ).toEqual({
      sessionId: 'ses_effort',
      transitions: [{ afterAssistantMessages: 1, effort: 'high' }],
    })
  })

  test('folds the compaction effort and ignores reordered retained variants', () => {
    expect(
      collectOpenCodeEffortHistory([
        {
          info: {
            id: 'msg_300',
            role: 'user',
            sessionID: 'ses_compact',
            model: {
              providerID: 'anthropic',
              modelID: 'claude-fable-5-1',
              variant: 'high',
            },
          },
          parts: [{ type: 'compaction' }],
        },
        {
          info: { id: 'msg_301', role: 'assistant', sessionID: 'ses_compact' },
        },
        {
          info: {
            id: 'msg_100',
            role: 'user',
            sessionID: 'ses_compact',
            model: {
              providerID: 'anthropic',
              modelID: 'claude-fable-5-1',
              variant: 'low',
            },
          },
        },
        {
          info: { id: 'msg_101', role: 'assistant', sessionID: 'ses_compact' },
        },
        {
          info: {
            id: 'msg_400',
            role: 'user',
            sessionID: 'ses_compact',
            model: {
              providerID: 'anthropic',
              modelID: 'claude-fable-5-1',
              variant: 'xhigh',
            },
          },
        },
      ]),
    ).toEqual({
      sessionId: 'ses_compact',
      transitions: [
        { afterAssistantMessages: 0, effort: 'high' },
        { afterAssistantMessages: 2, effort: 'xhigh' },
      ],
    })
  })

  test('round-trips a compact request-scoped header', () => {
    const transitions = [
      { afterAssistantMessages: 0, effort: 'low' as const },
      { afterAssistantMessages: 35, effort: 'xhigh' as const },
      { afterAssistantMessages: 1_000, effort: 'max' as const },
    ]
    const serialized = serializeEffortHistory(transitions)
    expect(serialized).toBe('0l.zx.rsz')
    expect(parseEffortHistory(serialized)).toEqual(transitions)
  })

  test('rejects malformed and oversized request headers', () => {
    expect(parseEffortHistory('0l.bad')).toEqual([])
    expect(parseEffortHistory('1!h')).toEqual([])
    expect(
      serializeEffortHistory(
        Array.from({ length: 513 }, (_, afterAssistantMessages) => ({
          afterAssistantMessages,
          effort: 'high' as const,
        })),
      ),
    ).toBeNull()
  })
})
