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

test('Opus 5.5 structured output keeps the tool available and fails closed if it is not called', async () => {
  harness = await E2EHarness.create()
  harness.script([
    { type: 'tool_use', name: 'mcp_StructuredOutput', input: { answer: 'ok' } },
  ])
  const successId = await harness.createSession()
  const success = await harness.sendPrompt(
    successId,
    'Return a JSON object with answer ok',
    45_000,
    'claude-opus-5-5',
    undefined,
    format,
  )
  const successInfo = (success.data as PromptResult | undefined)?.info
  expect(successInfo?.structured).toEqual({ answer: 'ok' })
  expect(successInfo?.error).toBeUndefined()

  const first = harness.anthropic
    .requests()
    .find(
      (request) =>
        request.body.model === 'claude-opus-5-5' &&
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
    'claude-opus-5-5',
    undefined,
    format,
  )
  const failureInfo = (failure.data as PromptResult | undefined)?.info
  expect(failureInfo?.structured).toBeUndefined()
  expect(JSON.stringify(failureInfo?.error)).toContain(
    'Model did not produce structured output',
  )
}, 90_000)
