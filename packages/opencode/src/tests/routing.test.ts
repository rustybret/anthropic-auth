import { describe, expect, test } from 'bun:test'
import {
  buildRoutingStatusSummary,
  executeRoutingCommand,
  getRoutingMode,
  parseRoutingCommandAction,
} from '@cortexkit/anthropic-auth-core'

function parseMode(summary: string) {
  const modeMatch = summary.match(
    /- Mode: `(main-first|fallback-first|sticky-balanced)`/,
  )
  if (!modeMatch)
    throw new Error(`Malformed /claude-routing summary:\n${summary}`)
  return modeMatch[1]
}

describe('claude-routing command state', () => {
  test('bare command reports main-first status by default', () => {
    const summary = buildRoutingStatusSummary()

    expect(summary).toContain('## Claude Routing Status')
    expect(parseMode(summary)).toBe('main-first')
  })

  test('mode changes render requested routing mode without mutating storage', () => {
    const reply = executeRoutingCommand({ argumentsText: 'fallback-first' })

    expect(reply).toContain('## Claude Routing Updated')
    expect(reply).toContain('Mode updated to `fallback-first`.')
    expect(parseMode(reply)).toBe('fallback-first')
    expect(getRoutingMode(null)).toBe('main-first')
  })

  test('invalid arguments return usage', () => {
    const reply = executeRoutingCommand({
      argumentsText: 'fallback',
      mode: 'fallback-first',
    })

    expect(reply).toContain('## Claude Routing Usage')
    expect(reply).toContain(
      'Usage: `/claude-routing`, `/claude-routing main-first`, `/claude-routing fallback-first`, `/claude-routing sticky-balanced`, or `/claude-routing reset`.',
    )
    expect(parseMode(reply)).toBe('fallback-first')
  })

  test('parses actions', () => {
    expect(parseRoutingCommandAction('')).toEqual({ type: 'status' })
    expect(parseRoutingCommandAction('main-first')).toEqual({
      type: 'mode',
      mode: 'main-first',
    })
    expect(parseRoutingCommandAction('fallback-first')).toEqual({
      type: 'mode',
      mode: 'fallback-first',
    })
    expect(parseRoutingCommandAction('mode fallback-first')).toEqual({
      type: 'mode',
      mode: 'fallback-first',
    })
    expect(parseRoutingCommandAction('sticky-balanced')).toEqual({
      type: 'mode',
      mode: 'sticky-balanced',
    })
    expect(parseRoutingCommandAction('reset')).toEqual({ type: 'reset' })
    expect(
      executeRoutingCommand({
        argumentsText: 'reset',
        mode: 'sticky-balanced',
      }),
    ).toContain('current session will be assigned again')
    expect(parseRoutingCommandAction('fallback')).toEqual({ type: 'usage' })
  })
})
