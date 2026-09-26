import type {
  Context,
  Message,
  SystemMessage,
  Tool,
} from '@earendil-works/pi-ai'

/**
 * A transcript whose prompt and tool set are carried by its leading system
 * message, which is the shape Pi 0.86 hands to providers.
 */
export type Transcript = {
  messages: Message[]
}

/**
 * Replay a transcript's system messages into one leading prompt and tool set.
 *
 * Ported from pi-ai's `utils/transcript.ts`. Pi 0.86 exports these helpers from
 * its package root; Oh My Pi serves every legacy pi-scope import — including
 * this package's `@earendil-works/pi-ai` — from its own bundled
 * `@oh-my-pi/pi-ai` fork, which has no system-message replay at all. Importing
 * them there threw `Export named 'collapseSystemMessages' not found in module
 * 'omp-legacy-pi-bundled:@oh-my-pi/pi-ai'` while the extension loaded, so no
 * request was ever built. Host types are used for build-time shape only: nothing
 * here imports the host at runtime (see scripts/check-pi-dist-imports.ts).
 *
 * Only `system` messages are read, so a host whose transcript has none — an
 * OMP transcript puts the prompt in `Context.systemPrompt` and has no system
 * role — still resolves to the message built from that prompt and
 * `Context.tools`, which is what that host's own providers send.
 */
function contentText(content: SystemMessage['content']): string {
  if (typeof content === 'string') return content
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/** Render a system message as a complete prompt: its content followed by its sections. */
function systemMessageText(message: SystemMessage): string {
  const parts = [contentText(message.content)]
  for (const text of Object.values(message.sections ?? {})) {
    if (text !== null) parts.push(text)
  }
  return parts.filter((part) => part.length > 0).join('\n\n')
}

function isSystemMessage(message: Message): message is SystemMessage {
  return message.role === 'system'
}

/**
 * Build the leading system message for a prompt and tool set. Returns undefined when
 * both are empty, so an empty transcript stays empty.
 */
function createInitialSystemMessage(
  systemPrompt: string | undefined,
  tools: Tool[] | undefined,
): SystemMessage | undefined {
  const hasSystemPrompt = systemPrompt !== undefined && systemPrompt.length > 0
  const hasTools = tools !== undefined && tools.length > 0
  if (!hasSystemPrompt && !hasTools) return undefined
  return {
    role: 'system',
    content: systemPrompt ?? '',
    ...(hasTools ? { toolsAdded: tools } : {}),
    timestamp: 0,
  }
}

/** Fold `Context.systemPrompt` and `Context.tools` into a leading system message. */
export function normalizeContext(context: Context): Transcript {
  const initialMessage = createInitialSystemMessage(
    context.systemPrompt,
    context.tools,
  )
  const messages = initialMessage
    ? [initialMessage, ...context.messages]
    : context.messages
  return { messages }
}

/** Resolve the tools available after applying every transcript delta in order. */
export function getCurrentTools(messages: readonly Message[]): Tool[] {
  const tools = new Map<string, Tool>()
  for (const message of messages) {
    if (!isSystemMessage(message)) continue
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name)
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool)
  }
  return [...tools.values()]
}

/**
 * Replay every system message into one leading system message holding the current
 * prompt and tools. Later `content` is appended to the base prompt, `sections` are
 * patched by name, and tools are resolved with {@link getCurrentTools}.
 */
function getCurrentSystemMessage(
  messages: readonly Message[],
): SystemMessage | undefined {
  const content: string[] = []
  const sections = new Map<string, string>()
  let timestamp: number | undefined
  for (const message of messages) {
    if (!isSystemMessage(message)) continue
    timestamp ??= message.timestamp
    const text = contentText(message.content)
    if (text.length > 0) content.push(text)
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name)
      else sections.set(name, value)
    }
  }
  const tools = getCurrentTools(messages)
  if (timestamp === undefined && tools.length === 0) return undefined
  return {
    role: 'system',
    content: content.join('\n\n'),
    ...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
    ...(tools.length > 0 ? { toolsAdded: tools } : {}),
    timestamp: timestamp ?? 0,
  }
}

/** Render the current system prompt text after replaying every system message. */
export function getCurrentSystemPrompt(messages: readonly Message[]): string {
  const message = getCurrentSystemMessage(messages)
  return message ? systemMessageText(message) : ''
}

/**
 * Rebuild the transcript for APIs without mid-conversation system messages: the
 * replayed system message leads, and every later system message is dropped.
 */
export function collapseSystemMessages(transcript: Transcript): Transcript {
  const head = getCurrentSystemMessage(transcript.messages)
  const messages = transcript.messages.filter(
    (message) => message.role !== 'system',
  )
  return { messages: head ? [head, ...messages] : messages }
}
