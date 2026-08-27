import { describe, expect, it } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(__dirname, '..')
const scriptSource = resolve(repoRoot, 'scripts/fork-sync.sh')
const defaultExclusions =
  '# fixture\nkeep-deleted: dist-arcus/*\nkeep-deleted: captures/*\n'

function git(cwd: string, args: readonly string[]) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function configure(cwd: string) {
  git(cwd, ['config', 'user.email', 'fork-sync-test@example.invalid'])
  git(cwd, ['config', 'user.name', 'Fork Sync Test'])
}

function commit(cwd: string, message: string) {
  git(cwd, ['add', '-A'])
  git(cwd, ['commit', '-m', message])
}

function makeFixture(exclusions = defaultExclusions) {
  const root = mkdtempSync(join(tmpdir(), 'fork-sync-test-'))
  const upstreamBare = join(root, 'upstream.git')
  const originBare = join(root, 'origin.git')
  const seed = join(root, 'seed')
  const fork = join(root, 'fork')
  const upstreamWork = join(root, 'upstream-work')

  git(root, ['init', '--bare', '-b', 'main', upstreamBare])
  git(root, ['init', '--bare', '-b', 'main', originBare])
  mkdirSync(seed, { recursive: true })
  git(seed, ['init', '-b', 'main'])
  configure(seed)
  writeFileSync(join(seed, 'tracked.txt'), 'base\n')
  writeFileSync(join(seed, 'remove-me.txt'), 'base\n')
  writeFileSync(join(seed, 'package.json'), '{"scripts":{"build":"true"}}\n')
  mkdirSync(join(seed, 'scripts'), { recursive: true })
  writeFileSync(join(seed, 'scripts', 'fork-sync-exclusions'), exclusions)
  commit(seed, 'base')
  git(seed, ['remote', 'add', 'origin', originBare])
  git(seed, ['remote', 'add', 'upstream', upstreamBare])
  git(seed, ['push', 'origin', 'main'])
  git(seed, ['push', 'upstream', 'main'])
  git(root, ['clone', originBare, fork])
  configure(fork)
  git(fork, ['remote', 'add', 'upstream', upstreamBare])
  mkdirSync(join(fork, 'scripts'), { recursive: true })
  writeFileSync(
    join(fork, 'scripts', 'fork-sync.sh'),
    readFileSync(scriptSource),
  )
  chmodSync(join(fork, 'scripts', 'fork-sync.sh'), 0o755)
  writeFileSync(join(fork, 'scripts', 'fork-sync-exclusions'), exclusions)
  commit(fork, 'add fork-sync fixture support')
  git(root, ['clone', upstreamBare, upstreamWork])
  configure(upstreamWork)

  return {
    root,
    fork,
    upstreamWork,
    script: join(fork, 'scripts', 'fork-sync.sh'),
  }
}

function runSync(
  fixture: ReturnType<typeof makeFixture>,
  options: {
    bash?: string
    script?: string
    env?: Record<string, string>
  } = {},
) {
  const result = spawnSync(
    options.bash ?? 'bash',
    [options.script ?? fixture.script, 'upstream', 'main'],
    {
      cwd: fixture.fork,
      encoding: 'utf8',
      env: {
        ...process.env,
        FORK_SYNC_NO_PUSH: '1',
        FORK_SYNC_SKIP_BUILD: '1',
        ...options.env,
      },
    },
  )
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function upstreamCommit(
  fixture: ReturnType<typeof makeFixture>,
  file: string,
  content: string,
) {
  writeFileSync(join(fixture.upstreamWork, file), content)
  commit(fixture.upstreamWork, `upstream ${file}`)
  git(fixture.upstreamWork, ['push', 'origin', 'main'])
}

function forkCommit(
  fixture: ReturnType<typeof makeFixture>,
  file: string,
  content: string,
) {
  writeFileSync(join(fixture.fork, file), content)
  commit(fixture.fork, `fork ${file}`)
}

describe('fork-sync', () => {
  it('merges a clean upstream change without pushing', () => {
    const fixture = makeFixture()
    try {
      upstreamCommit(fixture, 'upstream.txt', 'upstream\n')
      const result = runSync(fixture)
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(
        'FORK_SYNC_SKIP_BUILD=1; skipping workspace build.',
      )
      expect(git(fixture.fork, ['log', '-1', '--format=%s'])).toContain(
        'chore(sync)',
      )
      expect(existsSync(join(fixture.fork, 'upstream.txt'))).toBe(true)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('reports unresolved conflicts with recovery guidance and leaves the merge open', () => {
    const fixture = makeFixture()
    try {
      forkCommit(fixture, 'tracked.txt', 'fork\n')
      upstreamCommit(fixture, 'tracked.txt', 'upstream\n')
      const result = runSync(fixture)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('tracked.txt')
      expect(result.stderr).toContain('git commit --no-edit')
      expect(existsSync(join(fixture.fork, '.git', 'MERGE_HEAD'))).toBe(true)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects reruns while a merge is already in progress', () => {
    const fixture = makeFixture()
    try {
      forkCommit(fixture, 'tracked.txt', 'fork\n')
      upstreamCommit(fixture, 'tracked.txt', 'upstream\n')
      git(fixture.fork, ['fetch', 'upstream', 'main'])
      try {
        git(fixture.fork, ['merge', 'upstream/main'])
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
      }
      const result = runSync(fixture)
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('merge is already in progress')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('handles an empty take-theirs manifest without an unbound-variable failure', () => {
    const fixture = makeFixture(
      '# no take-theirs entries\nkeep-deleted: captures/*\n',
    )
    try {
      forkCommit(fixture, 'tracked.txt', 'fork\n')
      upstreamCommit(fixture, 'tracked.txt', 'upstream\n')
      const result = runSync(fixture, { bash: '/bin/bash' })
      expect(result.status).toBe(1)
      expect(result.stderr).not.toContain('unbound variable')
      expect(result.stderr).toContain('git merge --abort')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('applies keep-deleted rules and commits the resolved merge', () => {
    const fixture = makeFixture('keep-deleted: remove-me.txt\n')
    try {
      rmSync(join(fixture.fork, 'remove-me.txt'))
      commit(fixture.fork, 'delete removable file')
      upstreamCommit(fixture, 'remove-me.txt', 'upstream\n')
      const result = runSync(fixture)
      expect(result.status).toBe(0)
      expect(existsSync(join(fixture.fork, 'remove-me.txt'))).toBe(false)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('accepts an already-synced repository and supports root override', () => {
    const fixture = makeFixture()
    const scriptHome = mkdtempSync(join(tmpdir(), 'fork-sync-script-'))
    try {
      upstreamCommit(fixture, 'upstream.txt', 'upstream\n')
      const first = runSync(fixture)
      expect(first.status).toBe(0)
      const second = runSync(fixture)
      expect(second.status).toBe(0)

      const overrideScript = join(scriptHome, 'fork-sync.sh')
      writeFileSync(overrideScript, readFileSync(scriptSource))
      chmodSync(overrideScript, 0o755)
      upstreamCommit(fixture, 'override.txt', 'override\n')
      const overridden = runSync(fixture, {
        script: overrideScript,
        env: { FORK_SYNC_ROOT: fixture.fork },
      })
      expect(overridden.status).toBe(0)
      expect(existsSync(join(fixture.fork, 'override.txt'))).toBe(true)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
      rmSync(scriptHome, { recursive: true, force: true })
    }
  })
})
