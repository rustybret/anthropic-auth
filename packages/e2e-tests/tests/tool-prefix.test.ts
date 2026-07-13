/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from 'bun:test'
import { E2EHarness } from '../src/harness.ts'

let harness: E2EHarness | null = null

afterEach(async () => {
  await harness?.dispose()
  harness = null
})

describe('OpenCode Anthropic auth e2e', () => {
  it('strips mcp_ tool names even when Anthropic SSE chunks split the name field', async () => {
    harness = await E2EHarness.create()
    harness.script([
      {
        type: 'tool_use',
        name: 'mcp_Read',
        input: { filePath: harness.sampleFilePath() },
        splitToolNameChunk: true,
      },
      { type: 'text', text: 'read complete' },
    ])

    const sessionId = await harness.createSession()
    const result = await harness.sendPrompt(sessionId, 'read sample.txt')

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('unavailable tool')
    expect(serialized).not.toContain('mcp_Read')
    await harness.waitFor(
      () => harness!.anthropic.requests().length >= 2,
      { label: 'tool call and follow-up request captured' },
    )
    expect(
      harness.anthropic.requests().some((request) =>
        JSON.stringify(request.body).includes('hello from sample file'),
      ),
    ).toBe(true)
  }, 90_000)

  it('retries a Fable refusal with Opus and immediately prewarms Fable', async () => {
    harness = await E2EHarness.create({ hybridCache: true })
    harness.script([
      { type: 'refusal' },
      {
        type: 'text',
        text: 'recovered through opus',
        delayMs: 3_000,
      },
    ])

    const sessionId = await harness.createSession()
    let promptSettled = false
    const resultPromise = harness
      .sendPrompt(
        sessionId,
        'recover from the Fable content filter',
        60_000,
        'claude-fable-5',
      )
      .finally(() => {
        promptSettled = true
      })

    await harness.waitFor(
      () =>
        harness!.anthropic
          .requests()
          .filter((request) => request.body.max_tokens !== 0).length >= 2,
      { label: 'delayed Opus recovery request captured' },
    )
    await harness.waitForSessionText(sessionId, 'Switched to Opus 4.8')
    expect(promptSettled).toBe(false)

    const result = await resultPromise
    const serialized = JSON.stringify(result)
    expect(serialized).toContain('recovered through opus')
    expect(serialized).not.toContain('ContentFilterError')
    await harness.waitFor(
      () =>
        harness!.anthropic
          .requests()
          .some(
            (request) =>
              request.body.model === 'claude-fable-5' &&
              request.body.max_tokens === 0,
          ),
      { timeoutMs: 30_000, label: 'Fable cache prewarm captured' },
    )

    const sessionRequests = harness.anthropic.requests().filter((request) => {
      const serializedBody = JSON.stringify(request.body)
      return (
        request.body.max_tokens !== 0 &&
        !serializedBody.includes('Generate a title for this conversation')
      )
    })
    expect(sessionRequests.map((request) => request.body.model)).toEqual([
      'claude-fable-5',
      'claude-opus-4-8',
    ])
  }, 90_000)

  it('bridges back to a stale Opus cache after more than 20 Fable blocks', async () => {
    harness = await E2EHarness.create({ hybridCache: true })
    harness.script([
      { type: 'refusal' },
      ...Array.from({ length: 10 }, (_, index) => ({
        type: 'text' as const,
        text: `opus recovery ${index}`,
      })),
      ...Array.from({ length: 11 }, (_, index) => ({
        type: 'text' as const,
        text: `healthy Fable response ${index}`,
      })),
      { type: 'refusal' },
      { type: 'text', text: 'second Opus recovery' },
    ])

    const sessionId = await harness.createSession()
    await harness.sendPrompt(
      sessionId,
      'start first Fable recovery cycle',
      60_000,
      'claude-fable-5',
    )
    for (let index = 0; index < 9; index++) {
      await harness.sendPrompt(
        sessionId,
        `continue Opus cycle ${index}`,
        60_000,
        'claude-fable-5',
      )
    }
    await harness.waitForSessionText(sessionId, 'Returning to Fable 5')
    for (let index = 0; index < 11; index++) {
      await harness.sendPrompt(
        sessionId,
        `healthy Fable turn ${index}`,
        60_000,
        'claude-fable-5',
      )
    }
    const recovered = await harness.sendPrompt(
      sessionId,
      'trigger second Fable recovery cycle',
      60_000,
      'claude-fable-5',
    )
    expect(JSON.stringify(recovered)).toContain('second Opus recovery')

    const generationRequests = harness.anthropic.requests().filter((request) => {
      const serializedBody = JSON.stringify(request.body)
      return (
        request.body.max_tokens !== 0 &&
        !serializedBody.includes('Generate a title for this conversation')
      )
    })
    expect(generationRequests).toHaveLength(24)
    expect(generationRequests.slice(0, 11).map((request) => request.body.model)).toEqual([
      'claude-fable-5',
      ...Array.from({ length: 10 }, () => 'claude-opus-4-8'),
    ])
    expect(
      generationRequests.slice(11, 23).map((request) => request.body.model),
    ).toEqual(Array.from({ length: 12 }, () => 'claude-fable-5'))
    expect(generationRequests[23].body.model).toBe('claude-opus-4-8')

    const markedMessageIndexes = (body: Record<string, unknown>) => {
      const messages = Array.isArray(body.messages) ? body.messages : []
      return messages.flatMap((message, index) => {
        if (!message || typeof message !== 'object') return []
        const content = Array.isArray((message as { content?: unknown }).content)
          ? ((message as { content: unknown[] }).content ?? [])
          : []
        return content.some(
          (block) =>
            block != null &&
            typeof block === 'object' &&
            'cache_control' in block,
        )
          ? [index]
          : []
      })
    }
    const messageEndBlockPosition = (
      body: Record<string, unknown>,
      messageIndex: number,
    ) => {
      const messages = Array.isArray(body.messages) ? body.messages : []
      let blocks = 0
      for (let index = 0; index <= messageIndex; index++) {
        const message = messages[index]
        if (!message || typeof message !== 'object') continue
        const content = (message as { content?: unknown }).content
        blocks += Array.isArray(content) ? content.length : content == null ? 0 : 1
      }
      return blocks - 1
    }

    const lastFirstCycleOpus = generationRequests[10].body
    const secondCycleOpus = generationRequests[23].body
    const oldOpusTail = markedMessageIndexes(lastFirstCycleOpus).at(-1)
    const secondCycleMarkers = markedMessageIndexes(secondCycleOpus)
    expect(oldOpusTail).toBeNumber()
    expect(secondCycleMarkers).toContain(oldOpusTail!)
    expect(secondCycleMarkers.at(-1)).toBe(
      (secondCycleOpus.messages as unknown[]).length - 1,
    )
    expect(
      messageEndBlockPosition(secondCycleOpus, secondCycleMarkers.at(-1)!) -
        messageEndBlockPosition(secondCycleOpus, oldOpusTail!) +
        1,
    ).toBeGreaterThan(20)
    expect(
      (secondCycleOpus.system as Array<{ cache_control?: unknown }>).some(
        (block) => block.cache_control,
      ),
    ).toBe(false)
  }, 180_000)

  it('streams through websocket relay without closing before response', async () => {
    harness = await E2EHarness.create({ relay: 'websocket' })
    harness.script([{ type: 'text', text: 'relay ok' }])

    const sessionId = await harness.createSession()
    const result = await harness.sendPrompt(sessionId, 'hello via relay')

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('websocket closed')
    await harness.waitFor(() => (harness!.relay?.acceptedRequests() ?? 0) >= 1, {
      label: 'websocket relay accepted request',
    })
    await harness.waitFor(() => harness!.anthropic.requests().length >= 1, {
      label: 'upstream request captured',
    })
  }, 90_000)
})
