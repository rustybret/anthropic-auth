import { describe, expect, test } from 'bun:test'
import { collectPiEffortHistory } from '../effort-history.ts'

const entry = (
  id: string,
  type: string,
  extra: Record<string, unknown> = {},
) => ({ id, type, ...extra })

describe('Pi Fable 5.1 effort history', () => {
  test('maps thinking-level changes to assistant boundaries', () => {
    const branch = [
      entry('t0', 'thinking_level_change', { thinkingLevel: 'minimal' }),
      entry('u1', 'message', { message: { role: 'user' } }),
      entry('a1', 'message', { message: { role: 'assistant' } }),
      entry('t1', 'thinking_level_change', { thinkingLevel: 'high' }),
      entry('u2', 'message', { message: { role: 'user' } }),
      entry('a2', 'message', { message: { role: 'assistant' } }),
      entry('t2', 'thinking_level_change', { thinkingLevel: 'xhigh' }),
      entry('tool', 'message', { message: { role: 'toolResult' } }),
    ]
    expect(collectPiEffortHistory(branch, branch)).toEqual([
      { afterAssistantMessages: 0, effort: 'low' },
      { afterAssistantMessages: 1, effort: 'high' },
      { afterAssistantMessages: 2, effort: 'xhigh' },
    ])
  })

  test('folds pre-compaction effort into the new prefix and tracks later changes', () => {
    const fullBranch = [
      entry('t0', 'thinking_level_change', { thinkingLevel: 'low' }),
      entry('u1', 'message', { message: { role: 'user' } }),
      entry('a1', 'message', { message: { role: 'assistant' } }),
      entry('t1', 'thinking_level_change', { thinkingLevel: 'high' }),
      entry('u2', 'message', { message: { role: 'user' } }),
      entry('a2', 'message', { message: { role: 'assistant' } }),
      entry('compact', 'compaction'),
      entry('t2', 'thinking_level_change', { thinkingLevel: 'xhigh' }),
      entry('u3', 'message', { message: { role: 'user' } }),
    ]
    const contextEntries = [
      fullBranch[6]!,
      fullBranch[3]!,
      fullBranch[4]!,
      fullBranch[5]!,
      fullBranch[7]!,
      fullBranch[8]!,
    ]
    expect(collectPiEffortHistory(contextEntries, fullBranch)).toEqual([
      { afterAssistantMessages: 0, effort: 'high' },
      { afterAssistantMessages: 1, effort: 'xhigh' },
    ])
  })
})
