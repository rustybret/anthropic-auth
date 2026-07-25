import { describe, expect, test } from 'bun:test'

describe('plugin module exports', () => {
  test('does not expose a state-mutating test hook to the OpenCode loader', async () => {
    const pluginModule = await import('../index')

    expect('__setBootProfileHydrationForTest' in pluginModule).toBe(false)
  })
})
