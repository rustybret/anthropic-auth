import { readdirSync, statSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

function errorCode(error: unknown): string {
  return error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : 'unknown'
}

export type ClaustrumEndpoint = {
  host: string
  port: number
}

export type ClaustrumDetection =
  | {
      status: 'available'
      schema: number
      wireVersion: number
      endpoints: ClaustrumEndpoint[]
    }
  | {
      status: 'absent'
      path: string
    }
  | {
      status: 'malformed'
      path: string
      reason: string
    }

export const PRODUCTION_CLAUSTRUM_CONNECTION_FILE_NAME = 'subc-connection.json'
const CLAUSTRUM_TEMP_PREFIX = 'subc-'
const CLAUSTRUM_TEMP_SUFFIX = '.connection.json'

function safeIsFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function listSubcTempConnectionFiles(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir) as string[]
  } catch {
    return []
  }
  const matches: string[] = []
  for (const name of entries) {
    if (typeof name !== 'string') continue
    if (
      !name.startsWith(CLAUSTRUM_TEMP_PREFIX) ||
      !name.endsWith(CLAUSTRUM_TEMP_SUFFIX)
    ) {
      continue
    }
    const candidate = join(dir, name)
    if (safeIsFile(candidate)) matches.push(candidate)
  }
  matches.sort()
  return matches
}

export function findExistingClaustrumConnectionPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const runtime = env.XDG_RUNTIME_DIR?.trim()
  if (runtime) {
    const candidate = join(runtime, PRODUCTION_CLAUSTRUM_CONNECTION_FILE_NAME)
    if (safeIsFile(candidate)) return candidate
  }
  const home = env.HOME?.trim()
  if (home) {
    const candidate = join(
      home,
      '.local',
      'share',
      'cortexkit',
      'run',
      PRODUCTION_CLAUSTRUM_CONNECTION_FILE_NAME,
    )
    if (safeIsFile(candidate)) return candidate
  }
  const uid = process.getuid?.() ?? userInfo().uid
  const linuxRun = `/run/user/${uid}/${PRODUCTION_CLAUSTRUM_CONNECTION_FILE_NAME}`
  if (safeIsFile(linuxRun)) return linuxRun

  const tempDir = env.TMPDIR?.trim() || tmpdir()
  const tempMatches = listSubcTempConnectionFiles(tempDir)
  if (tempMatches.length === 1) return tempMatches[0]

  return undefined
}

export function getDefaultClaustrumConnectionPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const existing = findExistingClaustrumConnectionPath(env)
  if (existing) return existing

  const runtime = env.XDG_RUNTIME_DIR?.trim()
  if (runtime && (process.platform !== 'darwin' || safeIsFile(runtime))) {
    return join(runtime, PRODUCTION_CLAUSTRUM_CONNECTION_FILE_NAME)
  }
  if (process.platform === 'darwin') {
    const home = env.HOME?.trim() || userInfo().homedir
    return join(
      home,
      '.local',
      'share',
      'cortexkit',
      'run',
      PRODUCTION_CLAUSTRUM_CONNECTION_FILE_NAME,
    )
  }
  const uid = process.getuid?.() ?? userInfo().uid
  return `/run/user/${uid}/${PRODUCTION_CLAUSTRUM_CONNECTION_FILE_NAME}`
}

export function resolveClaustrumConnectionPath(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    explicit?.trim() ||
    env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE?.trim() ||
    env.CLAUSTRUM_SUBC_CONNECTION?.trim() ||
    getDefaultClaustrumConnectionPath(env)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEndpoint(value: unknown): value is ClaustrumEndpoint {
  return (
    isRecord(value) &&
    typeof value.host === 'string' &&
    value.host.trim().length > 0 &&
    typeof value.port === 'number' &&
    Number.isInteger(value.port) &&
    value.port > 0 &&
    value.port <= 65_535
  )
}

export async function detectClaustrumConnection(
  explicitPath?: string,
): Promise<ClaustrumDetection> {
  const path = resolveClaustrumConnectionPath(explicitPath)
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT') return { status: 'absent', path }
    return {
      status: 'malformed',
      path,
      reason: `unreadable (${code})`,
    }
  }

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return {
      status: 'malformed',
      path,
      reason: 'invalid JSON',
    }
  }

  if (
    !isRecord(value) ||
    typeof value.schema !== 'number' ||
    !Number.isFinite(value.schema) ||
    typeof value.wire_version !== 'number' ||
    !Number.isFinite(value.wire_version) ||
    !Array.isArray(value.endpoints) ||
    value.endpoints.length === 0 ||
    !value.endpoints.every(isEndpoint)
  ) {
    return {
      status: 'malformed',
      path,
      reason:
        'connection file has an invalid schema, wire_version, or endpoints',
    }
  }

  return {
    status: 'available',
    schema: value.schema,
    wireVersion: value.wire_version,
    endpoints: value.endpoints.map((endpoint) => ({
      host: endpoint.host,
      port: endpoint.port,
    })),
  }
}

export const CUSTODY_TOMBSTONE_PREFIX = 'claustrum-tombstone:v1:'

export function custodyTombstoneKey(provider: string): string {
  return `${CUSTODY_TOMBSTONE_PREFIX}${provider}`
}

export function custodyTombstoneOAuth(provider: string): {
  type: 'oauth'
  access: ''
  refresh: string
  expires: 0
} {
  // An empty access value makes Claustrum's deployed sealer reject this loader marker.
  return {
    type: 'oauth',
    access: '',
    refresh: custodyTombstoneKey(provider),
    expires: 0,
  }
}

export function isCustodyTombstoneValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(CUSTODY_TOMBSTONE_PREFIX)
}

export function isCustodyTombstoneOAuth(
  auth: unknown,
  provider: string,
): boolean {
  if (!isRecord(auth) || auth.type !== 'oauth') return false
  return auth.refresh === custodyTombstoneKey(provider)
}

export class CustodyTombstoneRefreshError extends Error {
  readonly code = 'custody_tombstone_refresh'

  constructor(public readonly provider: string) {
    super(
      `${provider} OAuth credentials are vault-custodied; local token refresh is forbidden`,
    )
    this.name = 'CustodyTombstoneRefreshError'
  }
}

export class CustodyTombstoneLoginError extends Error {
  readonly code = 'custody_tombstone_login'

  constructor(public readonly provider: string) {
    super(`${provider} main slot is custodied; run /login to sign in locally`)
    this.name = 'CustodyTombstoneLoginError'
  }
}

export function assertNotCustodyTombstone(
  refreshToken: unknown,
  provider: string,
): void {
  if (isCustodyTombstoneValue(refreshToken)) {
    throw new CustodyTombstoneRefreshError(provider)
  }
}
