import { isClaudeFable51Model } from './models.ts'

export const THINKING_BINDING_CONTROLS_BETA =
  'thinking-binding-controls-2026-08-01'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isReplayableThinkingBlock(block: unknown) {
  if (!isRecord(block)) return false
  if (block.type === 'thinking') {
    return typeof block.signature === 'string' && block.signature.length > 0
  }
  if (block.type === 'redacted_thinking') {
    return typeof block.data === 'string' && block.data.length > 0
  }
  return false
}

export function hasReplayableThinkingBlocks(body: Record<string, unknown>) {
  if (!Array.isArray(body.messages)) return false
  return body.messages.some((message) => {
    if (!isRecord(message) || message.role !== 'assistant') return false
    return (
      Array.isArray(message.content) &&
      message.content.some(isReplayableThinkingBlock)
    )
  })
}

export function applyThinkingBindingControls(body: Record<string, unknown>) {
  if (!isClaudeFable51Model(body.model)) return false
  if (!hasReplayableThinkingBlocks(body)) return false
  if (!isRecord(body.thinking) || body.thinking.type === 'disabled')
    return false

  body.thinking.block_binding = {
    prefix_mismatch_behavior: 'drop_block',
  }
  return true
}

export function hasThinkingBindingControls(body: Record<string, unknown>) {
  if (!isRecord(body.thinking)) return false
  if (!isRecord(body.thinking.block_binding)) return false
  return body.thinking.block_binding.prefix_mismatch_behavior === 'drop_block'
}
