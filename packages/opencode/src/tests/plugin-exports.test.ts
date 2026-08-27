import { describe, expect, test } from 'bun:test'

describe('plugin module exports', () => {
  test('exports only the plugin factory as a function', async () => {
    const pluginModule = await import('../index')
    const functionExports = Object.entries(pluginModule)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort()

    expect(functionExports).toEqual(['AnthropicAuthPlugin'])
  })

  test('does not expose a state-mutating test hook to the OpenCode loader', async () => {
    const pluginModule = await import('../index')

    expect('__setBootProfileHydrationForTest' in pluginModule).toBe(false)
  })
})
