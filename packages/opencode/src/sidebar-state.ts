export interface QuotaWindow {
  usedPercent: number
  remainingPercent: number
  resetsAt?: string
}

export interface ScopedQuotaWindow extends QuotaWindow {
  id: string
  title: string
  modelId?: string
  modelName: string
}

export interface AccountQuota {
  five_hour?: QuotaWindow
  seven_day?: QuotaWindow
  scoped?: ScopedQuotaWindow[]
}

export interface SidebarAccountState {
  id: string
  label: string | undefined
  quota: AccountQuota | null
  enabled: boolean
  // True when the account's refresh token is permanently dead (400
  // invalid_grant) and it needs a re-login — distinct from a transient backoff.
  needsReauth: boolean
}

export interface FableRecoverySidebarState {
  sessionId: string
  mode: 'opus' | 'fable'
  remaining: number
  changedAt: number
}

export interface SidebarState {
  main: {
    quota: AccountQuota | null
    quotaBackedOff?: boolean
    quotaBackoffUntil?: number
    refreshBackedOff?: boolean
    refreshBackoffUntil?: number
  }
  fallbacks: SidebarAccountState[]
  activeId: string | undefined
  route: string
  relay: { enabled: boolean; transport: string } | null
  fastMode: boolean
  cacheKeep?: {
    enabled: boolean
    window?: string
    trackedSessions?: number
  }
  fableRecoveries?: FableRecoverySidebarState[]
  lastUpdated: number
}

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const STATE_FILE_ENV = 'OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE'
const DEFAULT_STATE_DIR = join(tmpdir(), 'opencode-anthropic-auth')
const DEFAULT_STATE_FILE = join(DEFAULT_STATE_DIR, 'sidebar-state.json')

export function getSidebarStateFile(): string {
  return process.env[STATE_FILE_ENV] || DEFAULT_STATE_FILE
}

export const DEFAULT_SIDEBAR_STATE: SidebarState = {
  main: { quota: null },
  fallbacks: [],
  activeId: undefined,
  route: 'main',
  relay: null,
  fastMode: false,
  lastUpdated: 0,
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function normalizeQuotaWindow(value: unknown): QuotaWindow | undefined {
  if (!isRecord(value)) return undefined
  const usedPercent = Number(value.usedPercent)
  const remainingPercent = Number(value.remainingPercent)
  if (!Number.isFinite(usedPercent) || !Number.isFinite(remainingPercent)) {
    return undefined
  }
  return {
    usedPercent,
    remainingPercent,
    resetsAt: typeof value.resetsAt === 'string' ? value.resetsAt : undefined,
  }
}

function normalizeAccountQuota(value: unknown): AccountQuota | null {
  if (!isRecord(value)) return null
  const quota: AccountQuota = {}
  const fiveHour = normalizeQuotaWindow(value.five_hour)
  const sevenDay = normalizeQuotaWindow(value.seven_day)
  if (fiveHour) quota.five_hour = fiveHour
  if (sevenDay) quota.seven_day = sevenDay

  if (Array.isArray(value.scoped)) {
    const scoped = value.scoped
      .map((entry): ScopedQuotaWindow | undefined => {
        if (!isRecord(entry)) return undefined
        const window = normalizeQuotaWindow(entry)
        if (!window) return undefined
        if (typeof entry.id !== 'string' || !entry.id.trim()) return undefined
        if (typeof entry.title !== 'string' || !entry.title.trim()) {
          return undefined
        }
        if (typeof entry.modelName !== 'string' || !entry.modelName.trim()) {
          return undefined
        }
        const modelId =
          typeof entry.modelId === 'string' && entry.modelId.trim()
            ? entry.modelId.trim()
            : undefined
        return {
          ...window,
          id: entry.id.trim(),
          title: entry.title.trim(),
          ...(modelId && { modelId }),
          modelName: entry.modelName.trim(),
        }
      })
      .filter((entry): entry is ScopedQuotaWindow => entry != null)
    // Preserve empty `[]` so a sidebar reader can distinguish "scoped owned
    // by anthropic-auth, none visible" from "no quota data at all". The OUTER
    // Array.isArray guard means pre-feature inputs without a `scoped` key are
    // not affected — only inputs that already carried an array reach this line.
    quota.scoped = scoped
  }

  return Object.keys(quota).length ? quota : null
}

export function normalizeSidebarState(raw: unknown): SidebarState {
  if (!isRecord(raw)) return { ...DEFAULT_SIDEBAR_STATE }

  const main: SidebarState['main'] = { quota: null }
  if (isRecord(raw.main)) {
    const m = raw.main
    main.quota = normalizeAccountQuota(m.quota)
    if (typeof m.quotaBackedOff === 'boolean')
      main.quotaBackedOff = m.quotaBackedOff
    if (typeof m.quotaBackoffUntil === 'number')
      main.quotaBackoffUntil = m.quotaBackoffUntil
    if (typeof m.refreshBackedOff === 'boolean')
      main.refreshBackedOff = m.refreshBackedOff
    if (typeof m.refreshBackoffUntil === 'number')
      main.refreshBackoffUntil = m.refreshBackoffUntil
  }

  const fallbacks: SidebarAccountState[] = Array.isArray(raw.fallbacks)
    ? raw.fallbacks
        .filter(isRecord)
        .filter((entry) => typeof entry.id === 'string')
        .map((entry) => ({
          id: entry.id as string,
          label: typeof entry.label === 'string' ? entry.label : undefined,
          quota: normalizeAccountQuota(entry.quota),
          enabled: typeof entry.enabled === 'boolean' ? entry.enabled : false,
          needsReauth:
            typeof entry.needsReauth === 'boolean' ? entry.needsReauth : false,
        }))
    : []

  let relay: SidebarState['relay'] = null
  if (isRecord(raw.relay)) {
    const r = raw.relay
    if (typeof r.enabled === 'boolean' && typeof r.transport === 'string') {
      relay = { enabled: r.enabled, transport: r.transport }
    }
  }

  let cacheKeep: SidebarState['cacheKeep']
  if (isRecord(raw.cacheKeep)) {
    const ck = raw.cacheKeep
    if (typeof ck.enabled === 'boolean') {
      cacheKeep = {
        enabled: ck.enabled,
        window: typeof ck.window === 'string' ? ck.window : undefined,
        trackedSessions:
          typeof ck.trackedSessions === 'number'
            ? ck.trackedSessions
            : undefined,
      }
    }
  }

  const fableRecoveries: FableRecoverySidebarState[] = Array.isArray(
    raw.fableRecoveries,
  )
    ? raw.fableRecoveries
        .filter(isRecord)
        .flatMap((recovery): FableRecoverySidebarState[] => {
          if (
            typeof recovery.sessionId !== 'string' ||
            (recovery.mode !== 'opus' && recovery.mode !== 'fable') ||
            typeof recovery.remaining !== 'number' ||
            !Number.isFinite(recovery.remaining) ||
            typeof recovery.changedAt !== 'number' ||
            !Number.isFinite(recovery.changedAt)
          )
            return []
          return [
            {
              sessionId: recovery.sessionId,
              mode: recovery.mode,
              remaining: Math.max(0, Math.floor(recovery.remaining)),
              changedAt: recovery.changedAt,
            },
          ]
        })
    : []

  return {
    main,
    fallbacks,
    activeId: typeof raw.activeId === 'string' ? raw.activeId : undefined,
    route:
      typeof raw.route === 'string' ? raw.route : DEFAULT_SIDEBAR_STATE.route,
    relay,
    fastMode:
      typeof raw.fastMode === 'boolean'
        ? raw.fastMode
        : DEFAULT_SIDEBAR_STATE.fastMode,
    cacheKeep,
    fableRecoveries: fableRecoveries.length > 0 ? fableRecoveries : undefined,
    lastUpdated: typeof raw.lastUpdated === 'number' ? raw.lastUpdated : 0,
  }
}

let writeChain: Promise<void> = Promise.resolve()

export async function getSidebarState(): Promise<SidebarState> {
  try {
    const raw = await readFile(getSidebarStateFile(), 'utf8')
    return normalizeSidebarState(JSON.parse(raw))
  } catch {
    return DEFAULT_SIDEBAR_STATE
  }
}

export async function setSidebarState(
  state: SidebarState,
  stateFile = getSidebarStateFile(),
): Promise<void> {
  writeChain = writeChain
    .then(async () => {
      await mkdir(dirname(stateFile), { recursive: true })
      await writeFile(stateFile, JSON.stringify(state), 'utf8')
    })
    .catch(() => {
      // Best-effort — sidebar is non-critical
    })

  return writeChain
}

export async function drainSidebarWrites(): Promise<void> {
  return writeChain
}

// Resolve the currently-active account from activeId for the collapsed sidebar
// view. activeId === 'main' (or undefined/unmatched/disabled) → the main
// account; otherwise the enabled fallback whose id matches.
export function resolveActiveAccount(state: SidebarState): {
  id: string
  name: string
  quota: AccountQuota | null
} {
  const activeId = state.activeId
  if (activeId && activeId !== 'main') {
    // `account.enabled` is defensive: writeSidebarState already filters disabled
    // accounts out of state.fallbacks, so in normal operation every entry is
    // enabled. Kept so this pure helper stays correct for any caller and is
    // exercised directly by the unit tests.
    const fallback = state.fallbacks?.find(
      (account) => account.enabled && account.id === activeId,
    )
    if (fallback) {
      return {
        id: fallback.id,
        name: fallback.label ?? fallback.id,
        quota: fallback.quota,
      }
    }
  }
  return { id: 'main', name: 'main', quota: state.main?.quota ?? null }
}

export function formatScopedQuotaLabel(title: string) {
  const label = title.replace(/\s+only$/i, '').trim()
  return /^fable$/i.test(label) ? 'Fa' : label
}

export function getFableRecoverySummary(
  state: SidebarState,
  sessionId: string,
): string | undefined {
  const recovery = state.fableRecoveries?.find(
    (candidate) => candidate.sessionId === sessionId,
  )
  if (!recovery) return undefined
  if (recovery.mode === 'fable') return 'Fable 5 · restored'
  return `Opus 4.8 · ${recovery.remaining} left`
}

export function getCollapsedQuotaSummary(quota: AccountQuota | null): {
  fiveHourUsedPercent: number | null
  sevenDayUsedPercent: number | null
  scopedUsedPercents: number[]
  text: string | null
} {
  const fiveHourUsedPercent = quota?.five_hour?.usedPercent ?? null
  const sevenDayUsedPercent = quota?.seven_day?.usedPercent ?? null
  const scoped = quota?.scoped ?? []
  const scopedUsedPercents = scoped.map((window) => window.usedPercent)
  if (
    fiveHourUsedPercent == null &&
    sevenDayUsedPercent == null &&
    scoped.length === 0
  ) {
    return {
      fiveHourUsedPercent,
      sevenDayUsedPercent,
      scopedUsedPercents,
      text: null,
    }
  }

  const scopedSegments = scoped.map(
    (window) =>
      `${formatScopedQuotaLabel(window.title)}: ${Math.round(window.usedPercent)}%`,
  )
  const primarySegments =
    fiveHourUsedPercent == null && sevenDayUsedPercent == null
      ? []
      : [
          `5h: ${fiveHourUsedPercent == null ? '—' : `${Math.round(fiveHourUsedPercent)}%`}`,
          `7d: ${sevenDayUsedPercent == null ? '—' : `${Math.round(sevenDayUsedPercent)}%`}`,
        ]

  return {
    fiveHourUsedPercent,
    sevenDayUsedPercent,
    scopedUsedPercents,
    text: [...primarySegments, ...scopedSegments].join(' '),
  }
}

export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000

const PACING_MIN_ELAPSED_MS = 5 * 60 * 1000
const PACING_MIN_ELAPSED_FRACTION = 0.01
const ON_PACE_DELTA = 1

export interface QuotaPacing {
  pacePercent: number
  deltaPercent: number
  state: 'deficit' | 'reserve' | 'on-pace'
  runsOutAt: string | null
}

// Even-burn pacing for a quota window. The window start is inferred from the
// reset timestamp minus the window length. Two metrics: deltaPercent compares
// usage against a uniform burn-down (positive = deficit), and runsOutAt
// projects the current average burn rate forward — null means the window
// lasts until reset at that rate. Returns null when there is no reset
// timestamp or the elapsed time is too small to give a meaningful rate.
export function computeQuotaPacing(
  window: QuotaWindow,
  windowMs: number,
  now: number,
): QuotaPacing | null {
  if (!window.resetsAt) return null
  const resetsAt = new Date(window.resetsAt).getTime()
  if (!Number.isFinite(resetsAt)) return null
  const start = resetsAt - windowMs
  const elapsed = now - start
  if (elapsed < PACING_MIN_ELAPSED_MS) return null
  if (elapsed < windowMs * PACING_MIN_ELAPSED_FRACTION) return null
  if (elapsed >= windowMs) return null

  const used = window.usedPercent
  const pacePercent = Math.min(Math.max((elapsed / windowMs) * 100, 0), 100)
  const deltaPercent = used - pacePercent
  const state =
    Math.abs(deltaPercent) < ON_PACE_DELTA
      ? 'on-pace'
      : deltaPercent > 0
        ? 'deficit'
        : 'reserve'

  let runsOutAt: string | null = null
  if (used > 0) {
    const msToFull = (elapsed * 100) / used
    const runOut = start + msToFull
    if (runOut < resetsAt) runsOutAt = new Date(runOut).toISOString()
  }

  return { pacePercent, deltaPercent, state, runsOutAt }
}
