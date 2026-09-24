import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncVersionLock, workspaceLockErrors } from './workspace-lock.mjs'

const roots: string[] = []
const workspaces = [
  '',
  'packages/core',
  'packages/e2e-tests',
  'packages/opencode',
  'packages/pi',
] as const

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'anthropic-workspace-lock-'))
  roots.push(root)
  const manifests: Record<string, Record<string, unknown>> = {
    '': { name: 'repo', devDependencies: { 'jsonc-parser': '^3.3.1' } },
    'packages/core': {
      name: 'core',
      version: '1.22.0',
      dependencies: { 'xxhash-wasm': '^1.1.0' },
    },
    'packages/e2e-tests': {
      name: 'e2e',
      dependencies: { '@cortexkit/subc-client': '^0.13.1' },
    },
    'packages/opencode': {
      name: 'opencode',
      version: '1.22.0',
      dependencies: { '@cortexkit/anthropic-auth-core': '1.22.0' },
    },
    'packages/pi': {
      name: 'pi',
      version: '1.22.0',
      dependencies: { '@cortexkit/anthropic-auth-core': '1.22.0' },
      peerDependencies: { '@earendil-works/pi-ai': '>=0.86.1' },
    },
  }
  for (const workspace of workspaces) {
    const dir = join(root, workspace)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'package.json'),
      `${JSON.stringify(manifests[workspace], null, 2)}\n`,
    )
  }
  const lock = { lockfileVersion: 1, workspaces: manifests, packages: {} }
  const raw = `${JSON.stringify(lock, null, 2).replace('"packages": {}', '"packages": {},')}\n`
  await writeFile(join(root, 'bun.lock'), raw)
  return { root, raw, manifests }
}

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})

test('detects stale workspace versions and dependencies despite a valid JSONC lock', async () => {
  const { root } = await fixture()
  expect(workspaceLockErrors(root)).toEqual([])
  const core = join(root, 'packages/core/package.json')
  const opencode = join(root, 'packages/opencode/package.json')
  const pi = join(root, 'packages/pi/package.json')
  for (const path of [core, opencode, pi]) {
    const pkg = JSON.parse(await readFile(path, 'utf8')) as {
      version: string
      dependencies: Record<string, string>
    }
    pkg.version = '1.23.0'
    if (pkg.dependencies['@cortexkit/anthropic-auth-core']) {
      pkg.dependencies['@cortexkit/anthropic-auth-core'] = '1.23.0'
    }
    await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`)
  }
  expect(workspaceLockErrors(root)).toEqual([
    'packages/core.version: manifest 1.23.0 != lock 1.22.0',
    'packages/opencode.version: manifest 1.23.0 != lock 1.22.0',
    'packages/opencode.dependencies.@cortexkit/anthropic-auth-core: manifest 1.23.0 != lock 1.22.0',
    'packages/pi.version: manifest 1.23.0 != lock 1.22.0',
    'packages/pi.dependencies.@cortexkit/anthropic-auth-core: manifest 1.23.0 != lock 1.22.0',
  ])
})

test('surgically syncs five version fields without rewriting the rest of bun.lock', async () => {
  const { root, raw } = await fixture()
  const lockPath = join(root, 'bun.lock')
  const dry = syncVersionLock(root, '1.23.0', { dryRun: true })
  expect(dry).toHaveLength(5)
  expect(await readFile(lockPath, 'utf8')).toBe(raw)
  expect(syncVersionLock(root, '1.23.0')).toEqual(dry)
  const updated = await readFile(lockPath, 'utf8')
  expect(updated).toContain('"packages": {},') // Retains Bun's JSONC trailing comma.
  expect(updated).toContain('"@cortexkit/anthropic-auth-core": "1.23.0"')
  expect(updated).not.toContain('"@cortexkit/anthropic-auth-core": "1.22.0"')
  expect(syncVersionLock(root, '1.23.0')).toEqual([])
  expect(await readFile(lockPath, 'utf8')).toBe(updated)
})

test('rejects a missing workspace or undocumented direct dependency', async () => {
  const { root } = await fixture()
  const lockPath = join(root, 'bun.lock')
  const raw = await readFile(lockPath, 'utf8')
  await writeFile(
    lockPath,
    raw.replace('"packages/e2e-tests":', '"removed-e2e":'),
  )
  expect(workspaceLockErrors(root)).toContain(
    'packages/e2e-tests: workspace missing from bun.lock',
  )
  await writeFile(lockPath, raw)
  const corePath = join(root, 'packages/core/package.json')
  const core = JSON.parse(await readFile(corePath, 'utf8')) as {
    dependencies: Record<string, string>
  }
  core.dependencies['@cortexkit/subc-client'] = '^0.13.1'
  await writeFile(corePath, `${JSON.stringify(core)}\n`)
  expect(workspaceLockErrors(root)).toContain(
    'packages/core.dependencies.@cortexkit/subc-client: manifest ^0.13.1 != lock (absent)',
  )
})
