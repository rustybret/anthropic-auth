import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const CANONICAL_REPO = 'cortexkit/claustrum'
const CANONICAL_BRANCH = 'master'
const TOMBSTONE_PATH = 'packages/opencode/golden/tombstone.json'
const defaultFixtureDir = join(
  import.meta.dir,
  '..',
  'packages/opencode/src/tests/fixtures/claustrum-golden',
)

type Source = {
  repo: string
  ref: string
  paths: { tombstone: string }
}

function rejectSource(reason: string): never {
  throw new Error(`INVALID SOURCE.json: ${reason}`)
}

function readSource(value: unknown): Source {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return rejectSource('expected an object')
  }
  const record = value as Record<string, unknown>
  if (record.repo !== CANONICAL_REPO) {
    return rejectSource(`repo must be ${CANONICAL_REPO}`)
  }
  if (typeof record.ref !== 'string' || !/^[0-9a-f]{40}$/.test(record.ref)) {
    return rejectSource('ref must be a 40-hex SHA')
  }
  const paths = record.paths
  if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) {
    return rejectSource('paths must contain the canonical tombstone')
  }
  const entries = Object.entries(paths)
  if (
    entries.length !== 1 ||
    entries[0]?.[0] !== 'tombstone' ||
    entries[0]?.[1] !== TOMBSTONE_PATH
  ) {
    return rejectSource('paths must contain only the canonical tombstone')
  }
  return {
    repo: CANONICAL_REPO,
    ref: record.ref,
    paths: { tombstone: TOMBSTONE_PATH },
  }
}

export async function verifyClaustrumGolden(
  options: {
    fixtureDir?: string
    fetchImpl?: typeof fetch
    githubToken?: string
  } = {},
): Promise<string> {
  const fixtureDir = options.fixtureDir ?? defaultFixtureDir
  const fetchImpl = options.fetchImpl ?? fetch
  const source = readSource(
    JSON.parse(
      await readFile(join(fixtureDir, 'SOURCE.json'), 'utf8'),
    ) as unknown,
  )
  const local = await readFile(join(fixtureDir, 'tombstone.json')).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return rejectSource('vendored file is missing: tombstone.json')
      }
      throw error
    },
  )

  // Comparing an arbitrary fork with itself proves nothing. The pinned SHA
  // must be reachable from the canonical repository's default branch. CI uses
  // its read-only GitHub token to avoid shared-IP anonymous API limits; never
  // forward that token to the raw fixture host or echo it in diagnostics.
  const githubToken = options.githubToken ?? process.env.GITHUB_TOKEN
  if (
    githubToken !== undefined &&
    !/^[A-Za-z0-9._-]{1,4096}$/.test(githubToken)
  ) {
    throw new Error('Invalid GitHub token format for golden provenance check')
  }
  const compare = await fetchImpl(
    `https://api.github.com/repos/${CANONICAL_REPO}/compare/${source.ref}...${CANONICAL_BRANCH}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'cortexkit-anthropic-auth-golden-check',
        ...(githubToken && { authorization: `Bearer ${githubToken}` }),
      },
    },
  )
  if (!compare.ok) {
    throw new Error(
      `Failed to validate Claustrum golden provenance: HTTP ${compare.status}`,
    )
  }
  const relationship = (await compare.json()) as {
    status?: unknown
    behind_by?: unknown
  }
  if (
    !relationship ||
    !['ahead', 'identical'].includes(String(relationship.status)) ||
    relationship.behind_by !== 0
  ) {
    return rejectSource('ref is not an ancestor of canonical Claustrum master')
  }

  const url = `https://raw.githubusercontent.com/${CANONICAL_REPO}/${source.ref}/${TOMBSTONE_PATH}`
  const response = await fetchImpl(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch tombstone golden: HTTP ${response.status}`)
  }
  const remote = Buffer.from(await response.arrayBuffer())
  if (!local.equals(remote)) {
    throw new Error(`DRIFT: tombstone.json differs from ${url}`)
  }
  return `tombstone.json: IDENTICAL (${source.ref})`
}

if (import.meta.main) {
  try {
    console.log(await verifyClaustrumGolden())
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
