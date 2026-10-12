import { afterEach, expect, test } from 'bun:test'
import { E2EHarness } from '../src/harness.ts'

let harness: E2EHarness | null = null

afterEach(async () => {
  const finished = harness
  harness = null
  await finished?.dispose()
})

const format = {
  type: 'json_schema' as const,
  schema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  },
}

type PromptResult = {
  info?: {
    structured?: unknown
    error?: { name?: string; message?: string }
  }
}

test.each(['claude-opus-5-5', 'claude-sonnet-5-5'])(
  '%s structured output keeps the tool available and fails closed if it is not called',
  async (modelId) => {
    harness = await E2EHarness.create()
    harness.script([
      { type: 'tool_use', name: 'mcp_StructuredOutput', input: { answer: 'ok' } },
    ])
    const successId = await harness.createSession()
    const success = await harness.sendPrompt(
      successId,
      'Return a JSON object with answer ok',
      45_000,
      modelId,
      undefined,
      format,
    )
    const successInfo = (success.data as PromptResult | undefined)?.info
    expect(successInfo?.structured).toEqual({ answer: 'ok' })
    expect(successInfo?.error).toBeUndefined()

    const first = harness.anthropic.requests().find(
      (request) =>
        request.body.model === modelId &&
        Array.isArray(request.body.tools) &&
        request.body.tools.some(
          (tool: { name?: string }) => tool.name === 'mcp_StructuredOutput',
        ),
    )
    expect(first).toBeDefined()
    expect(first?.body.tool_choice).toBeUndefined()
    expect(first?.body.thinking).toMatchObject({ type: 'adaptive' })

    harness.script([
      { type: 'text', text: 'A plain-text answer, not structured output.' },
    ])
    const failureId = await harness.createSession()
    const failure = await harness.sendPrompt(
      failureId,
      'Return a JSON object with answer ok',
      45_000,
      modelId,
      undefined,
      format,
    )
    const failureInfo = (failure.data as PromptResult | undefined)?.info
    expect(failureInfo?.structured).toBeUndefined()
    expect(JSON.stringify(failureInfo?.error)).toContain(
      'Model did not produce structured output',
    )
  },
  90_000,
)


test('Sonnet 5.5 xhigh variant keeps adaptive thinking and requested effort through OpenCode', async () => {
  harness = await E2EHarness.create()
  harness.script([{ type: 'text', text: 'yes' }])
  const sessionId = await harness.createSession()
  await harness.sendPrompt(
    sessionId,
    'Reply yes',
    45_000,
    'claude-sonnet-5-5',
    'xhigh',
  )

  const request = harness.anthropic.requests().find(
    (entry) => entry.body.model === 'claude-sonnet-5-5',
  )
  expect(request).toBeDefined()
  expect(request?.body.thinking).toMatchObject({
    type: 'adaptive',
    display: 'summarized',
  })
  expect(request?.body.output_config).toMatchObject({ effort: 'xhigh' })
}, 90_000)
