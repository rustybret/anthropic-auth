import { createHash } from 'node:crypto'
import {
  type AdaptiveEffort,
  isClaudeFable51Model,
  normalizeAdaptiveEffort,
} from '@cortexkit/anthropic-auth-core'

const MAX_EFFORT_MARKERS = 512
const MAX_TRACKED_EFFORT_PLANS = 1024
const MARKER_CHECK_HEX_LENGTH = 32
const SCOPE_HEX_LENGTH = 32
const MESSAGE_ID_PATTERN = '[A-Za-z0-9_-]{1,128}'
const LEGACY_MARKER_PREFIX = '<cortexkit-internal-effort '
const LEGACY_PLAN_MARKER_PREFIX = '<cortexkit-internal-effort-plan '
const INTERNAL_MARKER_WRAPPER_PATTERN = /^\s*(?:§[0-9]+§\s*)+$/

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

export const EFFORT_MARKER_PREFIX = '<cortexkit-internal-effort-v2 '
export const EFFORT_PLAN_REQUEST_HEADER = 'x-cortexkit-effort-plan'

export type OpenCodeEffortMarkerPlan = {
  scope: string
  baseline: AdaptiveEffort
  markerCount: number
  digest: string
  sessionId: string
  messageId: string
}

type RequestEffortPlan = {
  scope: string
  baseline: AdaptiveEffort
  markerCount: number
  digest: string
}

export class EffortMarkerCorrelationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EffortMarkerCorrelationError'
  }
}

type OpenCodeMessageInfo = {
  id?: unknown
  sessionID?: unknown
  role?: unknown
  model?: {
    providerID?: unknown
    modelID?: unknown
    variant?: unknown
  }
}

type MutableOpenCodePart = Record<string, unknown> & {
  type?: unknown
  text?: unknown
  ignored?: unknown
  mime?: unknown
}

type MutableOpenCodeMessage = {
  info?: OpenCodeMessageInfo
  parts?: MutableOpenCodePart[]
}

type ParsedTransitionMarker = {
  scope: string
  boundary: string
  effort: AdaptiveEffort
  token: string
}

type ParsedUserMessage = {
  value: unknown
  transitions: ParsedTransitionMarker[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFableUser(item: MutableOpenCodeMessage | undefined): boolean {
  return (
    item?.info?.role === 'user' &&
    item.info.model?.providerID === 'anthropic' &&
    isClaudeFable51Model(item.info.model.modelID)
  )
}

function hasLowerableUserPart(item: MutableOpenCodeMessage): boolean {
  return (
    item.parts?.some((part) => {
      if (part.type === 'text') {
        return part.ignored !== true && part.text !== ''
      }
      if (part.type === 'file') {
        return (
          part.mime !== 'text/plain' && part.mime !== 'application/x-directory'
        )
      }
      return part.type === 'compaction' || part.type === 'subtask'
    }) ?? false
  )
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function markerScope(sessionId: string): string {
  return digest(`scope:${sessionId}`).slice(0, SCOPE_HEX_LENGTH)
}

function markerCheck(payload: string): string {
  return digest(`cortexkit-effort-v2:${payload}`).slice(
    0,
    MARKER_CHECK_HEX_LENGTH,
  )
}

function transitionMarker(
  scope: string,
  boundary: string,
  effort: AdaptiveEffort,
): string {
  const effortCode = EFFORT_CODES[effort]
  const payload = `transition:${scope}:${boundary}:${effortCode}`
  return `${EFFORT_MARKER_PREFIX}scope="${scope}" boundary="${boundary}" effort="${effortCode}" check="${markerCheck(payload)}"/>`
}

function parseTransitionMarker(text: string): ParsedTransitionMarker | null {
  const match = text.match(
    new RegExp(
      `^${EFFORT_MARKER_PREFIX}scope="([0-9a-f]{${SCOPE_HEX_LENGTH}})" boundary="(${MESSAGE_ID_PATTERN})" effort="([lmhxz])" check="([0-9a-f]{${MARKER_CHECK_HEX_LENGTH}})"/>$`,
    ),
  )
  if (!match) return null
  const [, scope, boundary, effortCode, check] = match
  const effort = EFFORTS_BY_CODE[effortCode ?? '']
  if (!scope || !boundary || !effortCode || !check || !effort) return null
  const payload = `transition:${scope}:${boundary}:${effortCode}`
  if (markerCheck(payload) !== check) return null
  return { scope, boundary, effort, token: text }
}

function isInternalMarkerWrapperOnly(text: string): boolean {
  return text.trim() === '' || INTERNAL_MARKER_WRAPPER_PATTERN.test(text)
}

function legacyMarkerPattern(): RegExp {
  return new RegExp(
    `(?:${LEGACY_PLAN_MARKER_PREFIX}nonce="[^"]+" baseline="[^"]+" count="[^"]+" sig="[0-9a-f]+"/>|${LEGACY_MARKER_PREFIX}nonce="[^"]+" effort="[^"]+" sig="[0-9a-f]+"/>)`,
    'g',
  )
}

function transitionMarkerPattern(): RegExp {
  return new RegExp(
    `${EFFORT_MARKER_PREFIX}scope="[0-9a-f]{${SCOPE_HEX_LENGTH}}" boundary="${MESSAGE_ID_PATTERN}" effort="[lmhxz]" check="[0-9a-f]{${MARKER_CHECK_HEX_LENGTH}}"/>`,
    'g',
  )
}

function stripMarkers(
  text: string,
  onTransition?: (transition: ParsedTransitionMarker) => void,
): { text: string; removed: number } {
  let removed = 0
  let stripped = text
  const withoutLegacy = text.replace(legacyMarkerPattern(), '')
  if (
    withoutLegacy !== text &&
    INTERNAL_MARKER_WRAPPER_PATTERN.test(withoutLegacy)
  ) {
    removed += [...text.matchAll(legacyMarkerPattern())].length
    stripped = withoutLegacy
  }
  stripped = stripped.replace(transitionMarkerPattern(), (token) => {
    const transition = parseTransitionMarker(token)
    if (!transition) return token
    onTransition?.(transition)
    removed++
    return ''
  })
  return { text: stripped, removed }
}

function removeInternalMarkers(messages: MutableOpenCodeMessage[]): void {
  for (const message of messages) {
    if (!Array.isArray(message.parts)) continue
    message.parts = message.parts.flatMap((part) => {
      if (
        part.type !== 'text' ||
        typeof part.text !== 'string' ||
        !part.text.includes('<cortexkit-internal-effort')
      ) {
        return [part]
      }
      const stripped = stripMarkers(part.text)
      if (stripped.removed === 0) return [part]
      if (isInternalMarkerWrapperOnly(stripped.text)) return []
      part.text = stripped.text
      return [part]
    })
  }
}

function planDigest(
  scope: string,
  baseline: AdaptiveEffort,
  markerCount: number,
  transitionTokens: readonly string[],
): string {
  const planToken = `plan:${scope}:${EFFORT_CODES[baseline]}:${markerCount.toString(36)}`
  return digest([planToken, ...transitionTokens].join('\n'))
}

export function encodeOpenCodeEffortPlan(
  plan: OpenCodeEffortMarkerPlan,
): string {
  return [
    'v2',
    plan.scope,
    EFFORT_CODES[plan.baseline],
    plan.markerCount.toString(36),
    plan.digest,
  ].join('.')
}

function parseRequestEffortPlan(
  value: string | undefined,
): RequestEffortPlan | null {
  if (!value) return null
  const match = value.match(
    /^v2\.([0-9a-f]{32})\.([lmhxz])\.([0-9a-z]+)\.([0-9a-f]{64})$/,
  )
  if (!match) return null
  const [, scope, baselineCode, countCode, planHash] = match
  const baseline = EFFORTS_BY_CODE[baselineCode ?? '']
  const markerCount = Number.parseInt(countCode ?? '', 36)
  if (
    !scope ||
    !baseline ||
    !planHash ||
    !Number.isSafeInteger(markerCount) ||
    markerCount < 0 ||
    markerCount > MAX_EFFORT_MARKERS
  ) {
    return null
  }
  return { scope, baseline, markerCount, digest: planHash }
}

/**
 * Annotate effort-changing user turns before OpenCode lowers its internal
 * message records. Markers are stable by session/message identity so later
 * transforms may persist and restore them without changing request lineage.
 */
export function markOpenCodeEffortTransitions(
  messages: MutableOpenCodeMessage[],
): OpenCodeEffortMarkerPlan | null {
  const currentUser = messages.findLast((item) => item.info?.role === 'user')
  if (!currentUser || !isFableUser(currentUser)) return null

  removeInternalMarkers(messages)
  if (!Array.isArray(currentUser.parts) || !hasLowerableUserPart(currentUser)) {
    return null
  }
  const sessionId = currentUser.info?.sessionID
  const messageId = currentUser.info?.id
  if (typeof sessionId !== 'string' || typeof messageId !== 'string') {
    throw new EffortMarkerCorrelationError(
      'Cannot correlate Fable 5.1 effort markers without session and message IDs',
    )
  }
  const scope = markerScope(sessionId)

  const compaction = messages.findLast(
    (item) =>
      item.info?.role === 'user' &&
      item.parts?.some((part) => part.type === 'compaction'),
  )
  const compactionId =
    typeof compaction?.info?.id === 'string' ? compaction.info.id : undefined
  let baseline: AdaptiveEffort | undefined
  let activeEffort: AdaptiveEffort | undefined
  if (compaction && isFableUser(compaction)) {
    baseline =
      normalizeAdaptiveEffort(compaction.info?.model?.variant) ?? 'high'
    activeEffort = baseline
  }

  const transitionTokens: string[] = []
  for (const item of messages) {
    const info = item.info
    if (info?.role !== 'user') continue
    if (
      compactionId &&
      typeof info.id === 'string' &&
      info.id <= compactionId
    ) {
      continue
    }
    if (!isFableUser(item) || !hasLowerableUserPart(item)) continue

    const effort = normalizeAdaptiveEffort(info.model?.variant) ?? 'high'
    if (!baseline) {
      baseline = effort
      activeEffort = effort
      continue
    }
    if (effort === activeEffort) continue
    if (transitionTokens.length >= MAX_EFFORT_MARKERS) {
      throw new EffortMarkerCorrelationError(
        'Too many Fable 5.1 effort changes in the active context',
      )
    }
    if (!Array.isArray(item.parts) || typeof info.id !== 'string') {
      throw new EffortMarkerCorrelationError(
        'Cannot mark a Fable 5.1 effort change without message identity',
      )
    }
    const token = transitionMarker(scope, info.id, effort)
    item.parts.push({ type: 'text', text: token })
    transitionTokens.push(token)
    activeEffort = effort
  }

  if (!baseline) return null
  return {
    scope,
    baseline,
    markerCount: transitionTokens.length,
    digest: planDigest(
      scope,
      baseline,
      transitionTokens.length,
      transitionTokens,
    ),
    sessionId,
    messageId,
  }
}

function consumeInternalMarkers(body: Record<string, unknown>): {
  messages: ParsedUserMessage[]
} {
  const values = Array.isArray(body.messages) ? body.messages : []
  const messages: ParsedUserMessage[] = []

  for (const value of values) {
    const transitions: ParsedTransitionMarker[] = []
    if (!isRecord(value) || value.role !== 'user') {
      messages.push({ value, transitions })
      continue
    }

    const stripText = (text: string) =>
      stripMarkers(text, (transition) => transitions.push(transition))

    if (typeof value.content === 'string') {
      const stripped = stripText(value.content)
      value.content =
        stripped.removed > 0 && isInternalMarkerWrapperOnly(stripped.text)
          ? ''
          : stripped.text
    } else if (Array.isArray(value.content)) {
      value.content = value.content.flatMap((block) => {
        if (
          !isRecord(block) ||
          block.type !== 'text' ||
          typeof block.text !== 'string'
        ) {
          return [block]
        }
        const stripped = stripText(block.text)
        if (
          stripped.removed > 0 &&
          isInternalMarkerWrapperOnly(stripped.text)
        ) {
          return []
        }
        return [{ ...block, text: stripped.text }]
      })
    }
    messages.push({ value, transitions })
  }

  body.messages = messages.map((message) => message.value)
  return { messages }
}

/** Consume request-correlated markers and insert Anthropic effort system messages. */
export function applyOpenCodeEffortMarkers(
  body: Record<string, unknown>,
  enabled: boolean,
  requestPlanHeader?: string,
): { found: number; inserted: number } {
  if (!Array.isArray(body.messages)) return { found: 0, inserted: 0 }
  const requestPlan = parseRequestEffortPlan(requestPlanHeader)
  if (requestPlanHeader && !requestPlan) {
    throw new EffortMarkerCorrelationError(
      'Missing or invalid internal Fable 5.1 effort request plan',
    )
  }

  const hasCandidate = body.messages.some((value) => {
    if (!isRecord(value) || value.role !== 'user') return false
    if (
      typeof value.content === 'string' &&
      value.content.includes('<cortexkit-internal-effort')
    ) {
      return true
    }
    return (
      Array.isArray(value.content) &&
      value.content.some(
        (block) =>
          isRecord(block) &&
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.includes('<cortexkit-internal-effort'),
      )
    )
  })

  if (!hasCandidate) {
    if (!requestPlan) return { found: 0, inserted: 0 }
    if (requestPlan.markerCount !== 0) {
      throw new EffortMarkerCorrelationError(
        `Fable 5.1 effort marker correlation failed: expected ${requestPlan.markerCount}, found 0`,
      )
    }
    if (
      requestPlan.digest !==
      planDigest(requestPlan.scope, requestPlan.baseline, 0, [])
    ) {
      throw new EffortMarkerCorrelationError(
        'Fable 5.1 effort marker request plan mismatch',
      )
    }
    if (enabled && isClaudeFable51Model(body.model)) {
      const outputConfig = isRecord(body.output_config)
        ? { ...body.output_config }
        : {}
      outputConfig.effort = requestPlan.baseline
      body.output_config = outputConfig
    }
    return { found: 0, inserted: 0 }
  }

  const consumed = consumeInternalMarkers(body)
  const transitions = consumed.messages.flatMap(
    (message) => message.transitions,
  )
  const found = transitions.length
  if (!requestPlan) {
    // Marker-shaped user text without a trusted internal plan remains untouched.
    if (found === 0) return { found: 0, inserted: 0 }
    throw new EffortMarkerCorrelationError(
      'Missing or invalid internal Fable 5.1 effort request plan',
    )
  }

  for (const message of consumed.messages) {
    if (message.transitions.length > 1) {
      throw new EffortMarkerCorrelationError(
        'Multiple internal Fable 5.1 effort markers on one user boundary',
      )
    }
    const transition = message.transitions[0]
    if (transition && transition.scope !== requestPlan.scope) {
      throw new EffortMarkerCorrelationError(
        'Fable 5.1 effort marker scope mismatch',
      )
    }
  }
  if (found !== requestPlan.markerCount) {
    throw new EffortMarkerCorrelationError(
      `Fable 5.1 effort marker correlation failed: expected ${requestPlan.markerCount}, found ${found}`,
    )
  }
  const actualDigest = planDigest(
    requestPlan.scope,
    requestPlan.baseline,
    requestPlan.markerCount,
    transitions.map((transition) => transition.token),
  )
  if (requestPlan.digest !== actualDigest) {
    throw new EffortMarkerCorrelationError(
      'Fable 5.1 effort marker request plan mismatch',
    )
  }

  const applyConfig = enabled && isClaudeFable51Model(body.model)
  let inserted = 0
  const rewritten: unknown[] = []
  for (const message of consumed.messages) {
    const transition = message.transitions[0]
    if (transition && applyConfig) {
      rewritten.push({
        role: 'system',
        content: [],
        output_config: { effort: transition.effort },
      })
      inserted++
    }
    rewritten.push(message.value)
  }
  body.messages = rewritten
  if (applyConfig) {
    const outputConfig = isRecord(body.output_config)
      ? { ...body.output_config }
      : {}
    outputConfig.effort = requestPlan.baseline
    body.output_config = outputConfig
  }
  return { found, inserted }
}

export class OpenCodeEffortPlanTracker {
  private readonly plans = new Map<string, string>()

  record(plan: OpenCodeEffortMarkerPlan): void {
    const key = this.key(plan.sessionId, plan.messageId)
    this.plans.delete(key)
    this.plans.set(key, encodeOpenCodeEffortPlan(plan))
    while (this.plans.size > MAX_TRACKED_EFFORT_PLANS) {
      const oldest = this.plans.keys().next().value
      if (typeof oldest !== 'string') break
      this.plans.delete(oldest)
    }
  }

  clear(sessionId: string, messageId: string): void {
    this.plans.delete(this.key(sessionId, messageId))
  }

  markHeaders(input: {
    sessionId: string
    messageId: string
    headers: Record<string, string>
  }): boolean {
    const key = this.key(input.sessionId, input.messageId)
    const plan = this.plans.get(key)
    if (!plan) return false
    input.headers[EFFORT_PLAN_REQUEST_HEADER] = plan
    this.plans.delete(key)
    return true
  }

  private key(sessionId: string, messageId: string): string {
    return `${sessionId}\u0000${messageId}`
  }
}
