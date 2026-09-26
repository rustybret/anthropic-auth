import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findHostImportViolations,
  verifyPiDistRuntimeImports,
} from './check-pi-dist-imports.ts'

const ALLOWED = `import { calculateCost, createAssistantMessageEventStream } from '@earendil-works/pi-ai'`

function violations(source: string) {
  return findHostImportViolations(source, 'stream.js')
}

describe('Pi dist host-import guard', () => {
  test('accepts the allowed names, including quoted and aliased forms', () => {
    expect(violations(ALLOWED)).toEqual([])
    expect(
      violations(
        `import { "calculateCost" as cost } from '@earendil-works/pi-ai'`,
      ),
    ).toEqual([])
    expect(
      violations(`import { calculateCost as c } from '@oh-my-pi/pi-ai'`),
    ).toEqual([])
  })

  test('rejects a disallowed name in a second clause for the same specifier', () => {
    expect(
      violations(
        `${ALLOWED}\nimport { collapseSystemMessages } from '@earendil-works/pi-ai'`,
      ),
    ).toEqual([
      "stream.js: '@earendil-works/pi-ai' exports 'collapseSystemMessages' to this build, but the host's compat surface is not guaranteed to",
    ])
  })

  test('rejects a quoted unsupported name beside allowed imports', () => {
    expect(
      violations(
        `${ALLOWED}\nimport { "collapseSystemMessages" as collapse } from '@earendil-works/pi-ai'`,
      ),
    ).toEqual([
      "stream.js: '@earendil-works/pi-ai' exports 'collapseSystemMessages' to this build, but the host's compat surface is not guaranteed to",
    ])
  })

  test('rejects side-effect imports, even beside named ones', () => {
    expect(violations(`${ALLOWED}\nimport '@earendil-works/pi-ai'`)).toEqual([
      "stream.js: side-effect import of '@earendil-works/pi-ai' loads the host's copy",
    ])
  })

  test('rejects default, namespace, star re-export and dynamic imports', () => {
    for (const source of [
      `import piAi from '@earendil-works/pi-ai'`,
      `import * as piAi from '@earendil-works/pi-ai'`,
      `import piAi, { calculateCost } from '@earendil-works/pi-ai'`,
      `export * from '@earendil-works/pi-ai'`,
      `export * as piAi from '@earendil-works/pi-ai'`,
      `export async function load() { return import('@earendil-works/pi-ai') }`,
    ]) {
      expect(violations(source)).toContain(
        "stream.js: '@earendil-works/pi-ai' must be imported only by name, not as a namespace, default or dynamic import",
      )
    }
  })

  test('rejects template-literal and computed dynamic import specifiers that evade static host checks', () => {
    expect(
      violations(
        'export async function load() { return import(`@earendil-works/pi-ai`) }',
      ),
    ).toContain(
      'stream.js: runtime dynamic import cannot be verified against the host SDK allowlist',
    )
    expect(
      violations('export async function load(name) { return import(name) }'),
    ).toContain(
      'stream.js: runtime dynamic import cannot be verified against the host SDK allowlist',
    )
  })

  test('rejects a disallowed name re-exported from the host', () => {
    expect(
      violations(`export { normalizeContext } from '@earendil-works/pi-ai'`),
    ).toEqual([
      "stream.js: '@earendil-works/pi-ai' exports 'normalizeContext' to this build, but the host's compat surface is not guaranteed to",
    ])
  })

  test('rejects any runtime import from another host package root', () => {
    for (const specifier of [
      '@earendil-works/pi-tui',
      '@earendil-works/pi-coding-agent',
      '@mariozechner/pi-tui',
    ]) {
      expect(violations(`import { x } from '${specifier}'`)).toEqual([
        `stream.js: runtime import from '${specifier}' — port what is needed locally (see packages/pi/src/transcript.ts)`,
      ])
    }
  })

  test('holds the legacy pi-ai scope to the same allowlist', () => {
    expect(
      violations(`import { calculateCost } from '@mariozechner/pi-ai'`),
    ).toEqual([])
    expect(
      violations(`import { normalizeContext } from '@mariozechner/pi-ai'`),
    ).toEqual([
      "stream.js: '@mariozechner/pi-ai' exports 'normalizeContext' to this build, but the host's compat surface is not guaranteed to",
    ])
  })

  // The guard reads emitted JavaScript, where TypeScript has already erased
  // type-only imports, so they never reach it.
  test('ignores non-host packages and import text in comments or strings', () => {
    expect(
      violations(
        [
          `import { loadAccounts } from '@cortexkit/anthropic-auth-core'`,
          `// import { collapseSystemMessages } from '@earendil-works/pi-ai'`,
          `const text = "import { normalizeContext } from '@earendil-works/pi-ai'"`,
        ].join('\n'),
      ),
    ).toEqual([])
  })

  test('CI and release verify the built Pi import surface before publication', async () => {
    const root = join(import.meta.dir, '..')
    for (const workflow of [
      '.github/workflows/ci.yml',
      '.github/workflows/release.yaml',
    ]) {
      const target = join(root, workflow)
      if (!existsSync(target)) continue
      const source = await readFile(target, 'utf8')
      const build = source.indexOf('bun run build')
      const test = source.indexOf(
        'bun test scripts/check-pi-dist-imports.test.ts',
      )
      const guard = source.indexOf('bun run check:pi-dist-imports')
      if (test === -1 && guard === -1) continue
      expect(build).toBeGreaterThan(-1)
      expect(test).toBeGreaterThan(build)
      expect(guard).toBeGreaterThan(test)
      if (workflow.endsWith('release.yaml')) {
        expect(guard).toBeLessThan(source.indexOf('publish-npm:'))
      }
    }
  })

  test('fails when the dist directory holds no JavaScript', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'pi-dist-guard-'))
    try {
      await expect(verifyPiDistRuntimeImports(empty)).rejects.toThrow(
        'No JavaScript',
      )
      await writeFile(join(empty, 'index.js'), ALLOWED)
      await expect(verifyPiDistRuntimeImports(empty)).resolves.toContain(
        '1 files',
      )
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})
