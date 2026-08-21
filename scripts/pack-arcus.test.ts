import { describe, expect, it } from 'bun:test'
import { execFileSync, execSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

describe('anthropic-auth arcus packaging & sync', () => {
  const repoRoot = resolve(__dirname, '..')
  const opencodePkg = JSON.parse(
    readFileSync(resolve(repoRoot, 'packages/opencode/package.json'), 'utf-8'),
  )

  it('defines fork-sync and arcus packaging scripts in package.json and omits upstream publish hooks', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(repoRoot, 'package.json'), 'utf-8'),
    )
    expect(pkg.scripts['fork-sync']).toBe('bash scripts/fork-sync.sh')
    expect(pkg.scripts['package:arcus']).toBe('bash scripts/pack-arcus.sh')
    expect(pkg.scripts['arcus:pack']).toBe('bash scripts/pack-arcus.sh')
    expect(pkg.scripts['arcus:test']).toBe(
      'bun test scripts/pack-arcus.test.ts',
    )
    expect(pkg.scripts.prepublishOnly).toBeUndefined()
    expect(pkg.scripts['pack:core:dry']).toBeUndefined()
  })

  it('ships executable scripts and exclusion manifest with correct permissions and keeps upstream release scripts deleted', () => {
    const forkSyncPath = resolve(repoRoot, 'scripts/fork-sync.sh')
    const packArcusPath = resolve(repoRoot, 'scripts/pack-arcus.sh')
    const exclusionsPath = resolve(repoRoot, 'scripts/fork-sync-exclusions')
    const docPath = resolve(repoRoot, 'docs/arcus-release-process.md')

    expect(existsSync(forkSyncPath)).toBe(true)
    expect(existsSync(packArcusPath)).toBe(true)
    expect(existsSync(exclusionsPath)).toBe(true)
    expect(existsSync(docPath)).toBe(true)

    // Ensure upstream publish scripts are purged
    expect(existsSync(resolve(repoRoot, 'scripts/release.sh'))).toBe(false)
    expect(existsSync(resolve(repoRoot, 'scripts/wait-release.sh'))).toBe(false)
    expect(existsSync(resolve(repoRoot, 'scripts/version-sync.mjs'))).toBe(
      false,
    )
    expect(
      existsSync(resolve(repoRoot, '.github/workflows/release.yaml')),
    ).toBe(false)

    // Check executable bit on scripts (0o111)
    const forkSyncStat = statSync(forkSyncPath)
    const packArcusStat = statSync(packArcusPath)
    expect((forkSyncStat.mode & 0o111) !== 0).toBe(true)
    expect((packArcusStat.mode & 0o111) !== 0).toBe(true)

    const exclusionsContent = readFileSync(exclusionsPath, 'utf-8')
    expect(exclusionsContent).toContain('keep-deleted:')
    expect(exclusionsContent).toContain('dist-arcus/*')
    expect(exclusionsContent).toContain('scripts/release.sh')
    expect(exclusionsContent).toContain('scripts/wait-release.sh')
    expect(exclusionsContent).toContain('scripts/version-sync.mjs')
    expect(exclusionsContent).toContain('.github/workflows/release.yaml')
  })

  it('builds package and generates a valid Arcus manifest and tarball in an isolated directory', () => {
    const testOutDir = mkdtempSync(join(tmpdir(), 'arcus-test-'))

    try {
      // Run pack-arcus script with --skip-build (build is verified in test suite)
      execFileSync(
        'bash',
        [
          resolve(repoRoot, 'scripts/pack-arcus.sh'),
          '--outdir',
          testOutDir,
          '--skip-build',
        ],
        { cwd: repoRoot, stdio: 'pipe' },
      )

      const expectedTarballName = `cortexkit-opencode-anthropic-auth-${opencodePkg.version}.tgz`
      const tarballPath = join(testOutDir, expectedTarballName)
      const manifestPath = join(testOutDir, 'arcus-manifest.json')

      expect(existsSync(tarballPath)).toBe(true)
      expect(existsSync(manifestPath)).toBe(true)

      const tarballStat = statSync(tarballPath)
      expect(tarballStat.size).toBeGreaterThan(10_000)

      // Validate manifest structure
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      expect(manifest.$schema).toBe(
        'https://raw.githubusercontent.com/rustybret/arcus/main/manifests/schema.json',
      )
      expect(manifest.name).toBe('opencode-anthropic-auth')
      expect(manifest.version).toBe(opencodePkg.version)
      expect(manifest.harness).toBe('opencode')
      expect(manifest.plugin).toBeDefined()
      expect(manifest.plugin.type).toBe('opencode-plugin')
      expect(manifest.plugin.name).toBe('@cortexkit/opencode-anthropic-auth')
      expect(manifest.plugin.version).toBe(opencodePkg.version)
      expect(manifest.plugin.asset.filename).toBe(expectedTarballName)
      expect(manifest.plugin.asset.url).toBe('PENDING_UPLOAD_URL')
      expect(manifest.plugin.asset.sha256).toBe('PENDING_BUILD_HASH')
      expect(manifest.plugin.asset.strip_components).toBe(1)
      expect(manifest.plugin.entrypoints.server).toBe('dist/index.js')
      expect(manifest.plugin.entrypoints.tui).toBe('src/tui/entry.mjs')
      expect(manifest.plugin.entrypoints.tui_compiled).toBe(
        'src/tui-compiled/tui.tsx',
      )

      // Unpack tarball and verify declared entrypoints exist inside
      const extractDir = join(testOutDir, 'extracted')
      mkdirSync(extractDir, { recursive: true })
      execSync(`tar -xzf "${tarballPath}" -C "${extractDir}"`)

      const packageDir = join(extractDir, 'package')
      expect(existsSync(packageDir)).toBe(true)

      // Entrypoints from manifest must exist in unpacked archive
      expect(
        existsSync(join(packageDir, manifest.plugin.entrypoints.server)),
      ).toBe(true)
      expect(
        existsSync(join(packageDir, manifest.plugin.entrypoints.tui)),
      ).toBe(true)
      expect(
        existsSync(join(packageDir, manifest.plugin.entrypoints.tui_compiled)),
      ).toBe(true)

      // Essential files and exports inside package
      expect(existsSync(join(packageDir, 'package.json'))).toBe(true)
      expect(existsSync(join(packageDir, 'dist/cli.js'))).toBe(true)
      expect(existsSync(join(packageDir, 'dist/sidebar-state.js'))).toBe(true)
      expect(existsSync(join(packageDir, 'dist/tui-preferences.js'))).toBe(true)
      expect(existsSync(join(packageDir, 'src/sidebar-state.ts'))).toBe(true)
      expect(existsSync(join(packageDir, 'src/tui-preferences.ts'))).toBe(true)
      expect(existsSync(join(packageDir, 'src/rpc/rpc-client.ts'))).toBe(true)
      expect(existsSync(join(packageDir, 'README.md'))).toBe(true)
      expect(existsSync(join(packageDir, 'LICENSE'))).toBe(true)

      // Verify no development or git artifacts leaked into package
      expect(existsSync(join(packageDir, '.git'))).toBe(false)
      expect(existsSync(join(packageDir, '.omo'))).toBe(false)
      expect(existsSync(join(packageDir, 'dist-arcus'))).toBe(false)
      expect(existsSync(join(packageDir, 'node_modules'))).toBe(false)
    } finally {
      rmSync(testOutDir, { recursive: true, force: true })
    }
  })

  it('supports --stamp-sha flag to embed computed SHA256 in manifest', () => {
    const testOutDir = mkdtempSync(join(tmpdir(), 'arcus-sha-test-'))

    try {
      execFileSync(
        'bash',
        [
          resolve(repoRoot, 'scripts/pack-arcus.sh'),
          '--outdir',
          testOutDir,
          '--skip-build',
          '--stamp-sha',
        ],
        { cwd: repoRoot, stdio: 'pipe' },
      )

      const manifestPath = join(testOutDir, 'arcus-manifest.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))

      expect(manifest.plugin.asset.sha256).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      rmSync(testOutDir, { recursive: true, force: true })
    }
  })

  it('supports positional and key-value --outdir= argument formats', () => {
    const testOutDirPos = mkdtempSync(join(tmpdir(), 'arcus-pos-'))
    const testOutDirEq = mkdtempSync(join(tmpdir(), 'arcus-eq-'))

    try {
      execFileSync(
        'bash',
        [
          resolve(repoRoot, 'scripts/pack-arcus.sh'),
          testOutDirPos,
          '--skip-build',
        ],
        { cwd: repoRoot, stdio: 'pipe' },
      )
      expect(existsSync(join(testOutDirPos, 'arcus-manifest.json'))).toBe(true)

      execFileSync(
        'bash',
        [
          resolve(repoRoot, 'scripts/pack-arcus.sh'),
          `--outdir=${testOutDirEq}`,
          '--skip-build',
        ],
        { cwd: repoRoot, stdio: 'pipe' },
      )
      expect(existsSync(join(testOutDirEq, 'arcus-manifest.json'))).toBe(true)
    } finally {
      rmSync(testOutDirPos, { recursive: true, force: true })
      rmSync(testOutDirEq, { recursive: true, force: true })
    }
  })
})
