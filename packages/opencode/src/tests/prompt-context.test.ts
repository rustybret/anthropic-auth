import { describe, expect, test } from 'bun:test'
import { resolvePromptContext } from '../prompt-context'

describe('resolvePromptContext', () => {
  test('falls back to empty-session metadata and normalizes modelID', async () => {
    const context = await resolvePromptContext(
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
        },
      },
      'session-empty',
    )

    expect(context).toEqual({
      agent: 'build',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
      variant: 'high',
    })
  })

  test('accepts the session metadata id model shape', async () => {
    const context = await resolvePromptContext(
      {
        session: {
          messages: async () => ({ data: [] }),
          get: async () => ({
            data: {
              model: {
                providerID: 'anthropic',
                id: 'claude-opus-4-1',
                variant: 'max',
              },
            },
          }),
        },
      },
      'session-empty',
    )

    expect(context).toEqual({
      model: { providerID: 'anthropic', modelID: 'claude-opus-4-1' },
      variant: 'max',
    })
  })

  test('prefers message history while retaining metadata fields it does not supply', async () => {
    const context = await resolvePromptContext(
      {
        session: {
          messages: async () => ({
            data: [
              {
                info: {
                  id: 'msg_2',
                  role: 'assistant',
                  agent: 'history-agent',
                  model: {
                    providerID: 'anthropic',
                    modelID: 'claude-sonnet-4-5',
                  },
                },
              },
            ],
          }),
          get: async () => ({
            data: {
              agent: 'metadata-agent',
              model: {
                providerID: 'anthropic',
                modelID: 'claude-opus-4-1',
                variant: 'high',
              },
            },
          }),
        },
      },
      'session-history',
    )

    expect(context).toEqual({
      agent: 'history-agent',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
      variant: 'high',
      latestAssistantMessageId: 'msg_2',
      latestUserMessageId: undefined,
    })
  })

  test('uses metadata when message history fails and returns null when both fail', async () => {
    const fallback = await resolvePromptContext(
      {
        session: {
          messages: async () => {
            throw new Error('unavailable')
          },
          get: async () => ({ data: { agent: 'metadata-agent' } }),
        },
      },
      'session-fallback',
    )
    expect(fallback).toEqual({
      agent: 'metadata-agent',
      latestAssistantMessageId: undefined,
      latestUserMessageId: undefined,
    })

    const missing = await resolvePromptContext(
      {
        session: {
          messages: async () => {
            throw new Error('unavailable')
          },
          get: async () => {
            throw new Error('unavailable')
          },
        },
      },
      'session-missing',
    )
    expect(missing).toBeNull()
  })
})
