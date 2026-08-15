import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('anthropic-auth arcus packaging & sync', () => {
  const repoRoot = resolve(__dirname, '..')

  it('defines fork-sync and package:arcus in package.json', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(repoRoot, 'package.json'), 'utf-8'),
    )
    expect(pkg.scripts['fork-sync']).toBeDefined()
    expect(pkg.scripts['package:arcus']).toBeDefined()
  })

  it('ships an executable scripts/fork-sync.sh and exclusion manifest', () => {
    expect(existsSync(resolve(repoRoot, 'scripts/fork-sync.sh'))).toBe(true)
    expect(existsSync(resolve(repoRoot, 'scripts/fork-sync-exclusions'))).toBe(
      true,
    )
  })

  it('produces a valid Arcus manifest structure', () => {
    const manifestPath = resolve(repoRoot, 'dist-arcus/arcus-manifest.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      expect(manifest.harness).toBe('opencode')
      expect(manifest.plugin?.type).toBe('opencode-plugin')
      expect(manifest.plugin?.name).toBe('@cortexkit/opencode-anthropic-auth')
      expect(manifest.plugin?.entrypoints?.server).toBe('dist/index.js')
    }
  })
})
