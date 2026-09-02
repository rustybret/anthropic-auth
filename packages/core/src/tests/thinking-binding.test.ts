import { describe, expect, test } from 'bun:test'
import {
  applyThinkingBindingControls,
  hasReplayableThinkingBlocks,
  hasThinkingBindingControls,
} from '../thinking-binding.ts'

const bodyWith = (model: string, block?: Record<string, unknown>) => ({
  model,
  thinking: { type: 'adaptive', display: 'summarized' },
  messages: [
    { role: 'user', content: 'summary' },
    ...(block
      ? [
          {
            role: 'assistant',
            content: [block, { type: 'text', text: 'answer' }],
          },
          { role: 'user', content: 'continue' },
        ]
      : []),
  ],
})

describe('Fable 5.1 thinking binding controls', () => {
  test('does nothing when no replayable thinking block exists', () => {
    const body = bodyWith('claude-fable-5-1')

    expect(applyThinkingBindingControls(body)).toBe(false)
    expect(hasThinkingBindingControls(body)).toBe(false)
  })

  test('adds drop_block for signed Fable 5.1 thinking history', () => {
    const body = bodyWith('claude-fable-5-1', {
      type: 'thinking',
      thinking: 'reasoning',
      signature: 'signature',
    })

    expect(hasReplayableThinkingBlocks(body)).toBe(true)
    expect(applyThinkingBindingControls(body)).toBe(true)
    expect(body.thinking.block_binding).toEqual({
      prefix_mismatch_behavior: 'drop_block',
    })
    expect(hasThinkingBindingControls(body)).toBe(true)
  })

  test('recognizes redacted Fable 5.1 thinking history', () => {
    const body = bodyWith('claude-fable-5-1', {
      type: 'redacted_thinking',
      data: 'redacted-payload',
    })

    expect(applyThinkingBindingControls(body)).toBe(true)
    expect(hasThinkingBindingControls(body)).toBe(true)
  })

  test('does not apply Fable prefix controls to Mythos 5.1 or older models', () => {
    for (const model of ['claude-mythos-5-1', 'claude-fable-5']) {
      const body = bodyWith(model, {
        type: 'thinking',
        thinking: 'reasoning',
        signature: 'signature',
      })
      expect(applyThinkingBindingControls(body)).toBe(false)
      expect(hasThinkingBindingControls(body)).toBe(false)
    }
  })
})
