/**
 * Resolve prompt context for synthetic OpenCode user messages.
 *
 * OpenCode records even ignored/noReply prompt messages as user messages. If a
 * plugin sends one without the previous model/variant, OpenCode's next prompt
 * can inherit the synthetic message's default model/variant and change usage or
 * cache attribution. Resolve the most recent assistant context and message IDs
 * so hidden replies preserve model state and active-run notifications can be
 * ordered before the assistant without becoming pending user work.
 */
export interface ResolvedPromptContext {
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
  latestAssistantMessageId?: string
  latestUserMessageId?: string
}

interface RawInfo {
  role?: string
  agent?: string
  variant?: string
  providerID?: string
  modelID?: string
  model?: { providerID?: string; modelID?: string; variant?: string }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function extractMessages(response: unknown): unknown[] {
  if (Array.isArray(response)) return response
  if (isRecord(response) && Array.isArray(response.data)) return response.data
  return []
}

function getMessageInfo(message: unknown) {
  if (!isRecord(message) || !isRecord(message.info)) return undefined
  return message.info
}

function getRole(message: unknown): string | undefined {
  const info = getMessageInfo(message)
  return typeof info?.role === 'string' ? info.role : undefined
}

function getMessageId(message: unknown): string | undefined {
  const info = getMessageInfo(message)
  return typeof info?.id === 'string' ? info.id : undefined
}

function extractFromMessage(message: unknown): ResolvedPromptContext | null {
  if (!isRecord(message) || !isRecord(message.info)) return null
  const info = message.info as RawInfo
  const modelInfo = isRecord(info.model) ? info.model : undefined

  const agent = typeof info.agent === 'string' ? info.agent : undefined
  const providerID =
    typeof modelInfo?.providerID === 'string'
      ? modelInfo.providerID
      : typeof info.providerID === 'string'
        ? info.providerID
        : undefined
  const modelID =
    typeof modelInfo?.modelID === 'string'
      ? modelInfo.modelID
      : typeof info.modelID === 'string'
        ? info.modelID
        : undefined
  const variant =
    typeof modelInfo?.variant === 'string'
      ? modelInfo.variant
      : typeof info.variant === 'string'
        ? info.variant
        : undefined

  if (!agent && (!providerID || !modelID) && !variant) return null
  const context: ResolvedPromptContext = {}
  if (agent) context.agent = agent
  if (providerID && modelID) context.model = { providerID, modelID }
  if (variant) context.variant = variant
  return context
}

function mergeContexts(
  base: ResolvedPromptContext,
  patch: ResolvedPromptContext,
): ResolvedPromptContext {
  return {
    agent: base.agent ?? patch.agent,
    model: base.model ?? patch.model,
    variant: base.variant ?? patch.variant,
    latestAssistantMessageId:
      base.latestAssistantMessageId ?? patch.latestAssistantMessageId,
    latestUserMessageId: base.latestUserMessageId ?? patch.latestUserMessageId,
  }
}

function isComplete(context: ResolvedPromptContext) {
  return Boolean(context.agent && context.model && context.variant)
}

export async function resolvePromptContext(
  client: unknown,
  sessionId: string,
): Promise<ResolvedPromptContext | null> {
  if (!client || !sessionId) return null
  const typedClient = client as {
    session?: {
      messages?: (input: {
        path: { id: string }
        query?: { limit?: number }
      }) =>
        | Promise<{ data?: unknown[] } | unknown[]>
        | { data?: unknown[] }
        | unknown[]
    }
  }
  if (typeof typedClient.session?.messages !== 'function') return null

  let messages: unknown[] = []
  try {
    messages = extractMessages(
      await Promise.resolve(
        typedClient.session.messages({
          path: { id: sessionId },
          query: { limit: 100 },
        }),
      ),
    )
  } catch {
    return null
  }
  if (messages.length === 0) return null

  let latestAssistantMessageId: string | undefined
  let latestUserMessageId: string | undefined
  for (const message of messages) {
    const id = getMessageId(message)
    if (!id) continue
    const role = getRole(message)
    if (
      role === 'assistant' &&
      (!latestAssistantMessageId || id > latestAssistantMessageId)
    ) {
      latestAssistantMessageId = id
    }
    if (role === 'user' && (!latestUserMessageId || id > latestUserMessageId)) {
      latestUserMessageId = id
    }
  }

  let result: ResolvedPromptContext = {
    latestAssistantMessageId,
    latestUserMessageId,
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    if (getRole(messages[index]) !== 'assistant') continue
    const context = extractFromMessage(messages[index])
    if (!context) continue
    result = mergeContexts(result, context)
    if (isComplete(result)) return result
  }

  for (let index = messages.length - 1; index >= 0; index--) {
    const context = extractFromMessage(messages[index])
    if (!context) continue
    result = mergeContexts(result, context)
    if (isComplete(result)) return result
  }

  if (
    !result.agent &&
    !result.model &&
    !result.variant &&
    !result.latestAssistantMessageId &&
    !result.latestUserMessageId
  ) {
    return null
  }
  return result
}
