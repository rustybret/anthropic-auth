import { describe, expect, test } from 'bun:test'
import {
  executeLaneStartCommand,
  parseLaneStartCommandAction,
} from '@cortexkit/anthropic-auth-core'

describe('claude-start command contract', () => {
  test('bare and whitespace-only input queues a start turn', () => {
    expect(parseLaneStartCommandAction('')).toEqual({ type: 'fire' })
    expect(parseLaneStartCommandAction('  \t')).toEqual({ type: 'fire' })
    expect(executeLaneStartCommand({ argumentsText: ' ' })).toEqual({
      action: { type: 'fire' },
      text: expect.stringContaining('Queued'),
    })
  })

  test('multiple or invalid arguments return usage', () => {
    expect(parseLaneStartCommandAction('automatic now')).toEqual({
      type: 'usage',
    })
    expect(parseLaneStartCommandAction('unknown')).toEqual({ type: 'usage' })
    const result = executeLaneStartCommand({ argumentsText: 'unknown' })
    expect(result.action).toEqual({ type: 'usage' })
    expect(result.text).toContain('Usage: `/claude-start`.')
  })
})
