import { CLAUDE_FABLE_5_MODEL_ID } from '@cortexkit/anthropic-auth-core'

export const FABLE_FALLBACK_MODEL_ID = 'claude-opus-4-8'
export const FABLE_FALLBACK_TURNS = 10

export type FableStandbyCacheAnchor = {
  fingerprint: string
  messageIndex: number
  messageCount: number
  oauthAccountId: string
}

const MAX_TRACKED_SESSIONS = 128
const SESSION_TTL_MS = 24 * 60 * 60_000

export type FableFallbackPlan = {
  sessionId: string
  requestedModel: string
  effectiveModel: string
  bodyText: string
  downgraded: boolean
  cycle?: number
  cacheAccountId?: string
  standbyCacheAnchor?: FableStandbyCacheAnchor
  requestSequence?: number
  completed?: boolean
}

type FableFallbackState = {
  model: string
  remaining: number
  cycle: number
  cacheAccountId?: string
  standbyCacheAnchor?: FableStandbyCacheAnchor
  nextRequestSequence: number
  standbyAnchorSequence: number
  updatedAt: number
}

function isFableModel(model: unknown): model is string {
  return (
    typeof model === 'string' &&
    (model === CLAUDE_FABLE_5_MODEL_ID ||
      model.startsWith(`${CLAUDE_FABLE_5_MODEL_ID}-`))
  )
}

function parseBody(bodyText: string) {
  try {
    const body = JSON.parse(bodyText) as Record<string, unknown>
    return typeof body.model === 'string' ? { body, model: body.model } : null
  } catch {
    return null
  }
}

export class FableFallbackManager {
  private readonly sessions = new Map<string, FableFallbackState>()
  private nextCycle = 1

  constructor(private readonly now: () => number = Date.now) {}

  private prune() {
    const now = this.now()
    for (const [sessionId, state] of this.sessions) {
      if (now - state.updatedAt >= SESSION_TTL_MS)
        this.sessions.delete(sessionId)
    }
    while (this.sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.sessions.keys().next().value
      if (typeof oldest !== 'string') break
      this.sessions.delete(oldest)
    }
  }

  plan(
    sessionId: string | null | undefined,
    bodyText: unknown,
  ): FableFallbackPlan | null {
    if (!sessionId || typeof bodyText !== 'string') return null
    const parsed = parseBody(bodyText)
    if (!parsed || !isFableModel(parsed.model)) return null

    this.prune()
    const state = this.sessions.get(sessionId)
    if (!state || state.remaining <= 0) {
      return {
        sessionId,
        requestedModel: parsed.model,
        effectiveModel: parsed.model,
        bodyText,
        downgraded: false,
        standbyCacheAnchor: state?.standbyCacheAnchor,
      }
    }

    state.updatedAt = this.now()
    state.nextRequestSequence++
    this.sessions.delete(sessionId)
    this.sessions.set(sessionId, state)
    parsed.body.model = FABLE_FALLBACK_MODEL_ID
    return {
      sessionId,
      requestedModel: state.model,
      effectiveModel: FABLE_FALLBACK_MODEL_ID,
      bodyText: JSON.stringify(parsed.body),
      downgraded: true,
      cycle: state.cycle,
      cacheAccountId: state.cacheAccountId,
      standbyCacheAnchor: state.standbyCacheAnchor,
      requestSequence: state.nextRequestSequence,
    }
  }

  activate(plan: FableFallbackPlan, cacheAccountId?: string): number {
    if (plan.downgraded || !isFableModel(plan.requestedModel)) {
      return this.remaining(plan.sessionId)
    }
    const state: FableFallbackState = {
      model: plan.requestedModel,
      remaining: FABLE_FALLBACK_TURNS,
      cycle: this.nextCycle++,
      cacheAccountId,
      standbyCacheAnchor: plan.standbyCacheAnchor,
      nextRequestSequence: 0,
      standbyAnchorSequence: 0,
      updatedAt: this.now(),
    }
    this.sessions.delete(plan.sessionId)
    this.sessions.set(plan.sessionId, state)
    this.prune()
    return state.remaining
  }

  complete(
    plan: FableFallbackPlan,
    standbyCacheAnchor?: FableStandbyCacheAnchor,
  ): { counted: boolean; remaining: number } {
    if (!plan.downgraded || plan.cycle == null || plan.completed) {
      return { counted: false, remaining: this.remaining(plan.sessionId) }
    }
    plan.completed = true
    const state = this.sessions.get(plan.sessionId)
    if (!state || state.cycle !== plan.cycle || state.remaining <= 0) {
      return { counted: false, remaining: state?.remaining ?? 0 }
    }

    state.remaining--
    if (
      standbyCacheAnchor &&
      plan.requestSequence != null &&
      plan.requestSequence >= state.standbyAnchorSequence
    ) {
      state.standbyCacheAnchor = standbyCacheAnchor
      state.standbyAnchorSequence = plan.requestSequence
    }
    state.updatedAt = this.now()
    // Retain the zero-remaining state so a later Fable refusal can bridge back
    // to this model-specific Opus cache boundary without continuously warming
    // Opus while Fable is healthy.
    this.sessions.delete(plan.sessionId)
    this.sessions.set(plan.sessionId, state)
    return { counted: true, remaining: state.remaining }
  }

  remaining(sessionId: string): number {
    this.prune()
    return this.sessions.get(sessionId)?.remaining ?? 0
  }
}
