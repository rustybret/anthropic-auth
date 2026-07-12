export type MockUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export type MockResponse =
  | {
      type: 'text'
      text: string
      usage?: MockUsage
    }
  | {
      type: 'tool_use'
      id?: string
      name: string
      input: Record<string, unknown>
      splitToolNameChunk?: boolean
      usage?: MockUsage
    }
  | {
      type: 'refusal'
      usage?: MockUsage
    }
  | {
      type: 'error'
      status: number
      errorType: string
      message: string
    }

export type CapturedAnthropicRequest = {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

const DEFAULT_USAGE: MockUsage = {
  input_tokens: 100,
  output_tokens: 20,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

export class MockAnthropicServer {
  private server: ReturnType<typeof Bun.serve> | null = null
  private queue: MockResponse[] = []
  private captured: CapturedAnthropicRequest[] = []

  async start() {
    this.server = Bun.serve({
      port: 0,
      fetch: (request) => this.handle(request),
    })
    const port = this.server.port
    if (!port) throw new Error('mock Anthropic server failed to bind')
    return { port, baseURL: `http://127.0.0.1:${port}` }
  }

  async stop() {
    this.server?.stop(true)
    this.server = null
  }

  script(responses: MockResponse[]) {
    this.queue = [...responses]
  }

  requests() {
    return [...this.captured]
  }

  private async handle(request: Request) {
    const url = new URL(request.url)
    if (
      request.method !== 'POST' ||
      (url.pathname !== '/v1/messages' && url.pathname !== '/messages')
    ) {
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }

    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => {
      headers[key] = value
    })
    this.captured.push({ url: request.url, headers, body })

    if (
      JSON.stringify(body).includes('Generate a title for this conversation')
    ) {
      return new Response(
        createSseStream({ type: 'text', text: 'test title' }, body),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        },
      )
    }

    // CacheKeep and Fable recovery prewarms must not consume the scripted
    // generation sequence. They are zero-output maintenance requests that run
    // asynchronously between normal model turns.
    if (body.max_tokens === 0) {
      return new Response(
        createSseStream(
          {
            type: 'text',
            text: '',
            usage: { ...DEFAULT_USAGE, output_tokens: 0 },
          },
          body,
        ),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        },
      )
    }

    const response = this.queue.shift() ?? {
      type: 'text' as const,
      text: 'ok',
    }
    if (response.type === 'error') {
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: response.errorType, message: response.message },
        }),
        {
          status: response.status,
          headers: { 'content-type': 'application/json' },
        },
      )
    }

    return new Response(createSseStream(response, body), {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    })
  }
}

function createSseStream(
  response: Exclude<MockResponse, { type: 'error' }>,
  requestBody: Record<string, unknown>,
) {
  const encoder = new TextEncoder()
  const usage = response.usage ?? DEFAULT_USAGE
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
  const model =
    typeof requestBody.model === 'string' ? requestBody.model : 'mock-model'

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        )
      }
      const sendRaw = (text: string) => controller.enqueue(encoder.encode(text))

      send('message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: usage.input_tokens,
            output_tokens: 0,
            cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          },
        },
      })

      if (response.type === 'refusal') {
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'refusal', stop_sequence: null },
          usage: { output_tokens: usage.output_tokens },
        })
      } else if (response.type === 'tool_use') {
        const startFrame = `event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: response.id ?? 'toolu_read_1',
            name: response.name,
            input: {},
          },
        })}\n\n`
        if (response.splitToolNameChunk) {
          const splitAt = startFrame.indexOf('"name":"') + '"na'.length
          sendRaw(startFrame.slice(0, splitAt))
          sendRaw(startFrame.slice(splitAt))
        } else {
          sendRaw(startFrame)
        }
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify(response.input),
          },
        })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: usage.output_tokens },
        })
      } else {
        send('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        })
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: response.text },
        })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: usage.output_tokens },
        })
      }

      send('message_stop', { type: 'message_stop' })
      controller.close()
    },
  })
}
