import { describe, expect, test } from 'bun:test'
import { formatQuotaMoney as formatCoreQuotaMoney } from '@cortexkit/anthropic-auth-core'

import { formatQuotaMoney } from '../tui'

describe('formatQuotaMoney', () => {
  test('core and TUI surfaces use identical currency formatting', () => {
    const money = { amountMinor: 10035, currency: 'USD', exponent: 2 }

    expect(formatQuotaMoney(money)).toBe(formatCoreQuotaMoney(money))
    expect(formatQuotaMoney(money)).toBe('$100.35')
  })

  test('falls back for malformed currency and exponent metadata', () => {
    const money = { amountMinor: 10035, currency: 'ZZZZ', exponent: 50 }

    expect(formatQuotaMoney(money)).toBe(formatCoreQuotaMoney(money))
    expect(formatQuotaMoney(money)).toBe('10035 ZZZZ')
  })
})
