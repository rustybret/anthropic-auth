import { expect, test } from 'bun:test'
import { refreshClaudeOAuthToken } from '../auth.ts'

test.each(['', '   '])(
  'missing local refresh material is rejected before any token endpoint call: %j',
  async (refreshToken) => {
    let calls = 0
    await expect(
      refreshClaudeOAuthToken({
        refreshToken,
        fetchImpl: Object.assign(
          async () => {
            calls++
            throw new Error('Unexpected token request')
          },
          { preconnect: fetch.preconnect },
        ),
      }),
    ).rejects.toThrow('credential is unavailable')
    expect(calls).toBe(0)
  },
)
