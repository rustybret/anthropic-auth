import {
  type AdaptiveEffort,
  isClaudeFable51Model,
  type MidConversationEffortTransition,
  normalizeAdaptiveEffort,
} from '@cortexkit/anthropic-auth-core'

export const EFFORT_HISTORY_HEADER = 'x-cortexkit-effort-history'
const MAX_SERIALIZED_TRANSITIONS = 512

const EFFORT_CODES: Record<AdaptiveEffort, string> = {
  low: 'l',
  medium: 'm',
  high: 'h',
  xhigh: 'x',
  max: 'z',
}
const EFFORTS_BY_CODE = Object.fromEntries(
  Object.entries(EFFORT_CODES).map(([effort, code]) => [code, effort]),
) as Record<string, AdaptiveEffort>

type OpenCodeMessageInfo = {
  id?: unknown
  role?: unknown
  sessionID?: unknown
  model?: {
    providerID?: unknown
    modelID?: unknown
    variant?: unknown
  }
}

export function collectOpenCodeEffortHistory(
  messages: readonly {
    info?: OpenCodeMessageInfo
    parts?: readonly { type?: unknown }[]
  }[],
): {
  sessionId: string
  transitions: MidConversationEffortTransition[]
} | null {
  let sessionId: string | undefined
  let assistantMessages = 0
  let activeEffort: AdaptiveEffort | undefined
  const transitions: MidConversationEffortTransition[] = []
  const compaction = messages.findLast(
    (item) =>
      item.info?.role === 'user' &&
      item.parts?.some((part) => part.type === 'compaction'),
  )
  const compactionId =
    typeof compaction?.info?.id === 'string' ? compaction.info.id : undefined
  if (compaction) {
    activeEffort =
      normalizeAdaptiveEffort(compaction.info?.model?.variant) ?? 'high'
    transitions.push({ afterAssistantMessages: 0, effort: activeEffort })
  }

  for (const item of messages) {
    const info = item.info
    if (!info) continue
    if (typeof info.sessionID === 'string') sessionId = info.sessionID
    if (info.role === 'assistant') {
      assistantMessages++
      continue
    }
    if (info.role !== 'user') continue
    if (
      compactionId &&
      typeof info.id === 'string' &&
      info.id <= compactionId
    ) {
      continue
    }
    if (info.model?.providerID !== 'anthropic') continue
    if (!isClaudeFable51Model(info.model.modelID)) continue

    const effort = normalizeAdaptiveEffort(info.model.variant) ?? 'high'
    if (effort === activeEffort) continue
    transitions.push({ afterAssistantMessages: assistantMessages, effort })
    activeEffort = effort
  }

  return sessionId && transitions.length > 0 ? { sessionId, transitions } : null
}

export function serializeEffortHistory(
  transitions: readonly MidConversationEffortTransition[],
): string | null {
  if (
    transitions.length === 0 ||
    transitions.length > MAX_SERIALIZED_TRANSITIONS
  ) {
    return null
  }
  return transitions
    .map(
      ({ afterAssistantMessages, effort }) =>
        `${afterAssistantMessages.toString(36)}${EFFORT_CODES[effort]}`,
    )
    .join('.')
}

export function parseEffortHistory(
  value: string | null,
): MidConversationEffortTransition[] {
  if (!value) return []
  const entries = value.split('.')
  if (entries.length > MAX_SERIALIZED_TRANSITIONS) return []
  const transitions: MidConversationEffortTransition[] = []
  for (const entry of entries) {
    if (!/^[0-9a-z]+[lmhxz]$/.test(entry)) return []
    const effort = EFFORTS_BY_CODE[entry.at(-1) ?? '']
    const boundary = Number.parseInt(entry.slice(0, -1), 36)
    if (!effort || !Number.isSafeInteger(boundary) || boundary < 0) return []
    transitions.push({ afterAssistantMessages: boundary, effort })
  }
  return transitions
}
