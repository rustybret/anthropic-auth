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
const manifestSource = resolve(repoRoot, 'scripts/fork-sync-exclusions')
const script = readFileSync(scriptSource, 'utf-8')
const manifest = readFileSync(manifestSource, 'utf-8')

/** Script text with comment-only lines removed, for assertions about behavior
 *  rather than documentation. The comments deliberately quote the wrong bun
 *  flag spelling to explain why it is wrong. */
const scriptCode = script
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

const defaultExclusions =
  '# fixture\nkeep-deleted: dist-arcus/*\nkeep-deleted: captures/*\nregenerate: bun.lock\n'

describe('fork-sync exclusion manifest', () => {
  it('parses to the three supported action verbs only', () => {
    const verbs = manifest
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter((line) => line.length > 0)
      .map((line) => line.split(':')[0] ?? '')

    expect(verbs.length).toBeGreaterThan(0)
    for (const verb of verbs) {
      expect(['keep-deleted', 'take-theirs', 'regenerate']).toContain(verb)
    }
  })

  it('documents the verb generically so the spec text matches other forks', () => {
    const lines = manifest.split('\n')
    const firstRule = lines.findIndex(
      (line) => line.trim().length > 0 && !line.trimStart().startsWith('#'),
    )
    const header = lines
      .slice(0, firstRule === -1 ? lines.length : firstRule)
      .join('\n')
    expect(header).toMatch(/basename/i)
    expect(header).toMatch(/ecosystem/i)
    expect(header).not.toMatch(/bun install/i)
  })

  it('routes bun.lock through regenerate, never take-theirs', () => {
    const rules = manifest
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter((line) => line.length > 0)

    expect(rules).toContain('regenerate: bun.lock')
    expect(rules.some((r) => /^take-theirs:\s*bun\.lock$/.test(r))).toBe(false)
  })
})

describe('fork-sync.sh structure and behavior', () => {
  it('is syntactically valid bash', () => {
    const result = spawnSync('bash', ['-n', scriptSource], {
      encoding: 'utf-8',
    })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('handles every verb the manifest is allowed to use', () => {
    for (const verb of ['keep-deleted', 'take-theirs', 'regenerate']) {
      expect(script).toContain(`${verb}:*)`)
    }
  })

  it('normalizes manifest values before using them as git pathspecs', () => {
    for (const verb of ['keep-deleted', 'take-theirs', 'regenerate']) {
      const pattern = new RegExp(
        `${verb}:\\*\\)\\s*\\w+\\+=\\("\\$\\(trim "\\$\\{line#${verb}:\\}"\\)"\\)`,
      )
      expect(script).toMatch(pattern)
    }
  })

  it('regenerates the lockfile with a bun flag spelling that actually parses', () => {
    expect(scriptCode).toContain('bun install --no-frozen-lockfile')
    expect(scriptCode).not.toContain('--frozen-lockfile=false')
  })

  it('dispatches regeneration on basename, per the cross-fork standard', () => {
    expect(scriptCode).toContain('ecosystem_for')
    expect(scriptCode).toMatch(/bun\.lock \| bun\.lockb\)/)
    expect(scriptCode).toMatch(/Cargo\.lock\)/)
    expect(scriptCode).toContain('basename')
  })

  it('hard-errors on an unknown regenerate target instead of guessing', () => {
    expect(scriptCode).toMatch(/no rebuild command is known for regenerate/)
    const ecoBlock = scriptCode.slice(
      scriptCode.indexOf('regenerate_targets()'),
      scriptCode.indexOf('# --- 1. fetch'),
    )
    expect(ecoBlock).toContain('exit 1')
  })

  it('stays merge-only: never rebases or force-pushes', () => {
    expect(scriptCode).not.toMatch(/git\s+(-C\s+"\$ROOT"\s+)?rebase\b/)
    expect(scriptCode).not.toMatch(/push\s+.*(--force|-f)\b/)
  })
})

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
  writeFileSync(
    join(seed, 'package.json'),
    `${JSON.stringify(
      {
        name: 'fixture-root',
        workspaces: ['packages/*'],
        scripts: { build: 'true' },
      },
      null,
      2,
    )}\n`,
  )
  mkdirSync(join(seed, 'packages', 'pkg-a'), { recursive: true })
  writeFileSync(
    join(seed, 'packages', 'pkg-a', 'package.json'),
    JSON.stringify({ name: '@fixture/pkg-a', version: '1.0.0' }, null, 2) +
      '\n',
  )
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

describe('fork-sync integration', () => {
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

  it('applies regenerate rules for lockfile conflicts and commits the resolved merge', () => {
    const fixture = makeFixture('regenerate: bun.lock\n')
    try {
      writeFileSync(join(fixture.fork, 'bun.lock'), 'lockfile-fork\n')
      commit(fixture.fork, 'fork bun.lock')
      upstreamCommit(fixture, 'bun.lock', 'lockfile-upstream\n')
      const result = runSync(fixture)
      expect(result.status).toBe(0)
      expect(existsSync(join(fixture.fork, 'bun.lock'))).toBe(true)
      expect(git(fixture.fork, ['log', '-1', '--format=%s'])).toContain(
        'chore(sync)',
      )
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
