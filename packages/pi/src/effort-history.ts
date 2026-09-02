import {
  type AdaptiveEffort,
  type MidConversationEffortTransition,
  normalizeAdaptiveEffort,
} from '@cortexkit/anthropic-auth-core'

type SessionEntryLike = {
  id?: unknown
  type?: unknown
  thinkingLevel?: unknown
  message?: { role?: unknown }
}

function entryRole(entry: SessionEntryLike): unknown {
  if (entry.type === 'compaction' || entry.type === 'branch_summary') {
    return 'user'
  }
  if (entry.type === 'custom_message') return 'user'
  return entry.type === 'message' ? entry.message?.role : undefined
}

function appendTransition(
  transitions: MidConversationEffortTransition[],
  afterAssistantMessages: number,
  effort: AdaptiveEffort,
) {
  const previous = transitions.at(-1)
  if (previous?.effort === effort) return
  if (previous?.afterAssistantMessages === afterAssistantMessages) {
    previous.effort = effort
    return
  }
  transitions.push({ afterAssistantMessages, effort })
}

/** Build Pi's active, compaction-aware Fable 5.1 effort timeline. */
export function collectPiEffortHistory(
  contextEntries: readonly SessionEntryLike[],
  fullBranch: readonly SessionEntryLike[],
): MidConversationEffortTransition[] {
  let activeEffort: AdaptiveEffort = 'high'
  let assistantMessages = 0
  const transitions: MidConversationEffortTransition[] = []
  const first = contextEntries[0]
  const compactionIndex =
    first?.type === 'compaction'
      ? fullBranch.findIndex((entry) => entry.id === first.id)
      : -1

  if (compactionIndex >= 0) {
    for (let index = 0; index <= compactionIndex; index++) {
      const entry = fullBranch[index]
      if (entry?.type !== 'thinking_level_change') continue
      activeEffort = normalizeAdaptiveEffort(entry.thinkingLevel) ?? 'high'
    }
    appendTransition(transitions, 0, activeEffort)
  }

  const branchIndexById = new Map(
    fullBranch.map((entry, index) => [entry.id, index]),
  )
  for (const entry of contextEntries) {
    if (entry === first && entry.type === 'compaction') continue
    const branchIndex = branchIndexById.get(entry.id)
    const retainedBeforeCompaction =
      compactionIndex >= 0 &&
      typeof branchIndex === 'number' &&
      branchIndex < compactionIndex

    if (entry.type === 'thinking_level_change') {
      if (!retainedBeforeCompaction) {
        activeEffort = normalizeAdaptiveEffort(entry.thinkingLevel) ?? 'high'
      }
      continue
    }

    const role = entryRole(entry)
    if (role === 'assistant') {
      assistantMessages++
    } else if (
      role === 'user' ||
      role === 'toolResult' ||
      role === 'tool_result'
    ) {
      appendTransition(transitions, assistantMessages, activeEffort)
    }
  }

  return transitions
}
