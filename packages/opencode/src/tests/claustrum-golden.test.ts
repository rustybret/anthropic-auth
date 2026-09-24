import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyClaustrumGolden } from '../../../../scripts/check-claustrum-golden.ts'

const checkedIn = join(import.meta.dir, 'fixtures', 'claustrum-golden')
const dirs: string[] = []
const ref = '6a53dd54b7b02353c58be69a0289c1a99636e03e'

afterEach(async () => {
  for (const path of dirs.splice(0))
    await rm(path, { recursive: true, force: true })
})

async function fixture(change?: (source: Record<string, unknown>) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'claustrum-golden-test-'))
  dirs.push(dir)
  const source = JSON.parse(
    await readFile(join(checkedIn, 'SOURCE.json'), 'utf8'),
  ) as Record<string, unknown>
  change?.(source)
  await writeFile(join(dir, 'SOURCE.json'), JSON.stringify(source))
  const bytes = await readFile(join(checkedIn, 'tombstone.json'))
  await writeFile(join(dir, 'tombstone.json'), bytes)
  return { dir, bytes }
}

function producer(options: {
  relationship?: string
  bytes: Buffer
  http?: number
}) {
  const calls: string[] = []
  const authorizations: Array<string | null> = []
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input)
    calls.push(url)
    authorizations.push(new Headers(init?.headers).get('authorization'))
    if (url.includes('/compare/')) {
      return new Response(
        JSON.stringify({
          status: options.relationship ?? 'ahead',
          behind_by: 0,
        }),
        { status: options.http ?? 200 },
      )
    }
    if (url.includes('raw.githubusercontent.com')) {
      return new Response(options.bytes)
    }
    throw new Error(`Unexpected producer URL: ${url}`)
  }) as typeof fetch
  return { calls, authorizations, fetchImpl }
}

test('pins the canonical repository, ancestor SHA, exact path and bytes', async () => {
  const { dir, bytes } = await fixture()
  const { calls, fetchImpl } = producer({ bytes })
  expect(await verifyClaustrumGolden({ fixtureDir: dir, fetchImpl })).toBe(
    `tombstone.json: IDENTICAL (${ref})`,
  )
  expect(calls).toEqual([
    `https://api.github.com/repos/cortexkit/claustrum/compare/${ref}...master`,
    `https://raw.githubusercontent.com/cortexkit/claustrum/${ref}/packages/opencode/golden/tombstone.json`,
  ])
})

test.each([
  {
    name: 'fork substitution',
    change: (source: Record<string, unknown>) => {
      source.repo = 'other/claustrum'
    },
    error: 'repo must be',
  },
  {
    name: 'unrelated fixture path',
    change: (source: Record<string, unknown>) => {
      source.paths = { tombstone: 'fixtures/fake.json' }
    },
    error: 'canonical tombstone',
  },
  {
    name: 'obsolete handle fixture',
    change: (source: Record<string, unknown>) => {
      source.paths = {
        tombstone: 'packages/opencode/golden/tombstone.json',
        handles: 'packages/opencode/golden/handles.json',
      }
    },
    error: 'canonical tombstone',
  },
  {
    name: 'unqualified ref',
    change: (source: Record<string, unknown>) => {
      source.ref = 'master'
    },
    error: '40-hex SHA',
  },
])(
  'rejects $name before contacting the producer',
  async ({ change, error }) => {
    const { dir, bytes } = await fixture(change)
    const { calls, fetchImpl } = producer({ bytes })
    await expect(
      verifyClaustrumGolden({ fixtureDir: dir, fetchImpl }),
    ).rejects.toThrow(error)
    expect(calls).toEqual([])
  },
)

test.each(['diverged', 'behind'])(
  'rejects a ref %s canonical master without fetching the golden',
  async (relationship) => {
    const { dir, bytes } = await fixture()
    const { calls, fetchImpl } = producer({ relationship, bytes })
    await expect(
      verifyClaustrumGolden({ fixtureDir: dir, fetchImpl }),
    ).rejects.toThrow('not an ancestor')
    expect(calls).toHaveLength(1)
  },
)

test('fails closed when the provenance API is unavailable', async () => {
  const { dir, bytes } = await fixture()
  const { calls, fetchImpl } = producer({ http: 403, bytes })
  await expect(
    verifyClaustrumGolden({ fixtureDir: dir, fetchImpl }),
  ).rejects.toThrow('HTTP 403')
  expect(calls).toHaveLength(1)
})

test('rejects mutated local bytes even if canonical provenance passes', async () => {
  const { dir, bytes } = await fixture()
  await writeFile(join(dir, 'tombstone.json'), Buffer.from('tampered'))
  const { fetchImpl } = producer({ bytes })
  await expect(
    verifyClaustrumGolden({ fixtureDir: dir, fetchImpl }),
  ).rejects.toThrow('DRIFT')
})

test('sends a CI token only to the canonical GitHub comparison endpoint', async () => {
  const { dir, bytes } = await fixture()
  const { authorizations, fetchImpl } = producer({ bytes })
  await verifyClaustrumGolden({
    fixtureDir: dir,
    fetchImpl,
    githubToken: 'ghs_readonly_example',
  })
  expect(authorizations).toEqual(['Bearer ghs_readonly_example', null])
})

test('rejects an unsafe token value without repeating it or making a request', async () => {
  const { dir, bytes } = await fixture()
  const { calls, fetchImpl } = producer({ bytes })
  await expect(
    verifyClaustrumGolden({
      fixtureDir: dir,
      fetchImpl,
      githubToken: 'sensitive-value\r\ninjected-header',
    }),
  ).rejects.toThrow('Invalid GitHub token format')
  expect(calls).toEqual([])
})
