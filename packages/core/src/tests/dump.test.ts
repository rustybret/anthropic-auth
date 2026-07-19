import { afterEach, describe, expect, test } from 'bun:test'
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sweepDumpDirectory, writeDumpFile } from '../dump'

const dumpDirs: string[] = []
const dumpLinks: string[] = []
const originalDumpMaxBytes = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_MAX_BYTES
const originalDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR

function dumpArtifactName(
  id: number,
  kind: 'body' | 'meta' | 'relay' | 'request' = 'body',
) {
  return `2026-07-17T12-00-00-000Z-${String(id).padStart(6, '0')}-session-direct.${kind}.json`
}

afterEach(async () => {
  if (originalDumpMaxBytes === undefined) {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_MAX_BYTES
  } else {
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_MAX_BYTES = originalDumpMaxBytes
  }
  if (originalDumpDir === undefined) {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
  } else {
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = originalDumpDir
  }
  await Promise.all(
    dumpLinks.splice(0).map((path) => unlink(path).catch(() => {})),
  )
  await Promise.all(
    dumpDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

test('dump sweep deletes oldest files until the directory is under its cap', async () => {
  const dumpDir = await mkdtemp(
    join(tmpdir(), 'opencode-anthropic-auth-dumps-test-'),
  )
  dumpDirs.push(dumpDir)
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
  const oldFile = join(dumpDir, dumpArtifactName(1))
  const middleFile = join(dumpDir, dumpArtifactName(2, 'meta'))
  const newestFile = join(dumpDir, dumpArtifactName(3, 'request'))
  await mkdir(dumpDir, { recursive: true })
  await Promise.all([
    writeFile(oldFile, '12345678'),
    writeFile(middleFile, '12345678'),
    writeFile(newestFile, '12345678'),
  ])
  await utimes(oldFile, new Date(1_000), new Date(1_000))
  await utimes(middleFile, new Date(2_000), new Date(2_000))
  await utimes(newestFile, new Date(3_000), new Date(3_000))

  const result = await sweepDumpDirectory({
    dumpDir,
    maxBytes: 12,
    protectedPaths: [newestFile],
  })

  expect(result).toEqual({ removed: 2, freedBytes: 16 })
  expect(await readdir(dumpDir)).toEqual([dumpArtifactName(3, 'request')])
})

test('sweeps artifacts whose request counter has grown to seven digits', async () => {
  const dumpDir = await mkdtemp(
    join(tmpdir(), 'opencode-anthropic-auth-dumps-test-'),
  )
  dumpDirs.push(dumpDir)
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
  const artifact = join(
    dumpDir,
    '2026-07-17T12-00-00-000Z-1000000-session-direct.body.json',
  )
  await writeFile(artifact, '12345678')
  await utimes(artifact, new Date(1_000), new Date(1_000))

  expect(await sweepDumpDirectory({ dumpDir, maxBytes: 1 })).toEqual({
    removed: 1,
    freedBytes: 8,
  })
  expect(await readdir(dumpDir)).toEqual([])
})

describe('dump sweep safety guard', () => {
  test('refuses a configured symlinked dump directory without deleting target files', async () => {
    const targetDir = await mkdtemp(join(tmpdir(), 'target-dir-secret-'))
    dumpDirs.push(targetDir)
    const secretFile = join(targetDir, 'secret.txt')
    await writeFile(secretFile, 'do not delete me')
    const dumpDir = join(
      tmpdir(),
      `opencode-anthropic-auth-dumps-link-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    dumpLinks.push(dumpDir)
    await symlink(targetDir, dumpDir)
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir

    expect(await sweepDumpDirectory({ maxBytes: 1 })).toEqual({
      removed: 0,
      freedBytes: 0,
    })
    expect(await readdir(targetDir)).toEqual(['secret.txt'])
  })

  test('refuses a directory that is not configured for dumps', async () => {
    const dumpDir = await mkdtemp(join(tmpdir(), 'unrelated-dumps-test-'))
    dumpDirs.push(dumpDir)
    await writeFile(join(dumpDir, 'old.json'), '12345678')
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR

    expect(await sweepDumpDirectory({ dumpDir, maxBytes: 1 })).toEqual({
      removed: 0,
      freedBytes: 0,
    })
    expect(await readdir(dumpDir)).toEqual(['old.json'])
  })
})

test('enforces the cap in a configured custom dump directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'custom-dump-root-'))
  dumpDirs.push(root)
  const dumpDir = join(root, 'dumps')
  await mkdir(dumpDir)
  const oldDump = join(dumpDir, dumpArtifactName(1))
  const newDump = join(dumpDir, dumpArtifactName(2, 'meta'))
  const unrelatedFile = join(dumpDir, 'system.log')
  await Promise.all([
    writeFile(oldDump, '12345678'),
    writeFile(newDump, '12345678'),
    writeFile(unrelatedFile, 'unrelated file must survive'),
  ])
  await utimes(oldDump, new Date(1_000), new Date(1_000))
  await utimes(newDump, new Date(2_000), new Date(2_000))
  await utimes(unrelatedFile, new Date(500), new Date(500))
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir

  expect(await sweepDumpDirectory({ maxBytes: 8 })).toEqual({
    removed: 1,
    freedBytes: 8,
  })
  expect((await readdir(dumpDir)).sort()).toEqual(
    [dumpArtifactName(2, 'meta'), 'system.log'].sort(),
  )
})

test('disables dump sweeping when the configured cap is zero', async () => {
  const dumpDir = await mkdtemp(
    join(tmpdir(), 'opencode-anthropic-auth-dumps-test-'),
  )
  dumpDirs.push(dumpDir)
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
  const oldFile = join(dumpDir, dumpArtifactName(1))
  await writeFile(oldFile, '12345678')
  await utimes(oldFile, new Date(1_000), new Date(1_000))
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_MAX_BYTES = '0'

  expect(await sweepDumpDirectory({ dumpDir })).toEqual({
    removed: 0,
    freedBytes: 0,
  })
  expect(await readdir(dumpDir)).toEqual([dumpArtifactName(1)])
})

test('preserves files younger than the sweep newness floor', async () => {
  const dumpDir = await mkdtemp(
    join(tmpdir(), 'opencode-anthropic-auth-dumps-test-'),
  )
  dumpDirs.push(dumpDir)
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
  const recentFile = join(dumpDir, dumpArtifactName(1))
  const now = new Date('2026-07-17T12:00:00.000Z')
  await writeFile(recentFile, '12345678')
  await utimes(recentFile, now, now)

  expect(
    await sweepDumpDirectory({
      dumpDir,
      maxBytes: 1,
      now: now.getTime(),
    }),
  ).toEqual({ removed: 0, freedBytes: 0 })
  expect(await readdir(dumpDir)).toEqual([dumpArtifactName(1)])
})

test('preserves fresh partials and reclaims stale partials even under the cap', async () => {
  const dumpDir = await mkdtemp(
    join(tmpdir(), 'opencode-anthropic-auth-dumps-test-'),
  )
  dumpDirs.push(dumpDir)
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
  const now = new Date('2026-07-17T12:00:00.000Z')
  const freshPartial = join(dumpDir, `${dumpArtifactName(1)}.partial`)
  const stalePartial = join(
    dumpDir,
    `${dumpArtifactName(2)}.0123456789abcdef01234567.partial`,
  )
  await Promise.all([
    writeFile(freshPartial, '12345678'),
    writeFile(stalePartial, '12345678'),
  ])
  await utimes(freshPartial, now, now)
  await utimes(
    stalePartial,
    new Date(now.getTime() - 11 * 60 * 1000),
    new Date(now.getTime() - 11 * 60 * 1000),
  )

  expect(
    await sweepDumpDirectory({
      dumpDir,
      maxBytes: 100,
      now: now.getTime(),
    }),
  ).toEqual({
    removed: 1,
    freedBytes: 8,
  })
  expect(await readdir(dumpDir)).toEqual([`${dumpArtifactName(1)}.partial`])
})

test('does not follow a pre-planted predictable partial symlink', async () => {
  const dumpDir = await mkdtemp(
    join(tmpdir(), 'opencode-anthropic-auth-dumps-test-'),
  )
  const targetDir = await mkdtemp(join(tmpdir(), 'dump-partial-target-'))
  dumpDirs.push(dumpDir, targetDir)
  const targetFile = join(targetDir, 'target.txt')
  const finalFile = join(dumpDir, dumpArtifactName(1))
  await writeFile(targetFile, 'do not overwrite')
  await symlink(targetFile, `${finalFile}.partial`)

  await writeDumpFile(finalFile, 'safe dump content')

  expect(await readFile(targetFile, 'utf8')).toBe('do not overwrite')
  expect(await readFile(finalFile, 'utf8')).toBe('safe dump content')
  expect((await lstat(finalFile)).isSymbolicLink()).toBe(false)
})
