import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
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

  it('defines Arcus v2, fork-sync, and core lifecycle command scripts in package.json', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(repoRoot, 'package.json'), 'utf-8'),
    )
    expect(pkg.scripts.build).toBeDefined()
    expect(pkg.scripts.test).toBeDefined()
    expect(pkg.scripts.typecheck).toBeDefined()
    expect(pkg.scripts['fork-sync']).toBe('bash scripts/fork-sync.sh')
    expect(pkg.scripts['sync:fork']).toBe('bash scripts/fork-sync.sh')
    expect(pkg.scripts['build:arcus']).toBe(
      'bun run build && bash scripts/pack-arcus.sh',
    )
    expect(pkg.scripts['package:arcus']).toBe('bash scripts/pack-arcus.sh')
    expect(pkg.scripts['pack:arcus']).toBe('bash scripts/pack-arcus.sh')
    expect(pkg.scripts['publish:arcus']).toBe('bash scripts/publish-arcus.sh')
    expect(pkg.scripts['validate:arcus']).toBe('bash scripts/validate-arcus.sh')
    expect(pkg.scripts['sign:arcus']).toBe('bash scripts/sign-arcus.sh')
    expect(pkg.scripts['migrate:arcus']).toBe('bash scripts/migrate-arcus.sh')

    // Ensure legacy v1 aliases are pruned
    expect(pkg.scripts['arcus:pack']).toBeUndefined()
    expect(pkg.scripts['arcus:test']).toBeUndefined()
  })

  it('removes upstream CortexKit-specific publish and package dry-run scripts', () => {
    const rootPkg = JSON.parse(
      readFileSync(resolve(repoRoot, 'package.json'), 'utf-8'),
    )
    const opencodePkg = JSON.parse(
      readFileSync(
        resolve(repoRoot, 'packages/opencode/package.json'),
        'utf-8',
      ),
    )
    const piPkg = JSON.parse(
      readFileSync(resolve(repoRoot, 'packages/pi/package.json'), 'utf-8'),
    )

    expect(rootPkg.scripts['pack:opencode:dry']).toBeUndefined()
    expect(rootPkg.scripts['pack:pi:dry']).toBeUndefined()
    expect(rootPkg.scripts.prepublishOnly).toBeUndefined()
    expect(opencodePkg.scripts.prepublishOnly).toBeUndefined()
    expect(piPkg.scripts.prepublishOnly).toBeUndefined()
  })

  it('ships executable scripts for fork-sync and Arcus v2 pipeline and keeps upstream release scripts deleted', () => {
    const forkSyncPath = resolve(repoRoot, 'scripts/fork-sync.sh')
    const packArcusPath = resolve(repoRoot, 'scripts/pack-arcus.sh')
    const signArcusPath = resolve(repoRoot, 'scripts/sign-arcus.sh')
    const validateArcusPath = resolve(repoRoot, 'scripts/validate-arcus.sh')
    const publishArcusPath = resolve(repoRoot, 'scripts/publish-arcus.sh')
    const migrateArcusPath = resolve(repoRoot, 'scripts/migrate-arcus.sh')
    const exclusionsPath = resolve(repoRoot, 'scripts/fork-sync-exclusions')

    expect(existsSync(forkSyncPath)).toBe(true)
    expect(existsSync(packArcusPath)).toBe(true)
    expect(existsSync(signArcusPath)).toBe(true)
    expect(existsSync(validateArcusPath)).toBe(true)
    expect(existsSync(publishArcusPath)).toBe(true)
    expect(existsSync(migrateArcusPath)).toBe(true)
    expect(existsSync(exclusionsPath)).toBe(true)

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
    expect((statSync(forkSyncPath).mode & 0o111) !== 0).toBe(true)
    expect((statSync(packArcusPath).mode & 0o111) !== 0).toBe(true)
    expect((statSync(signArcusPath).mode & 0o111) !== 0).toBe(true)
    expect((statSync(validateArcusPath).mode & 0o111) !== 0).toBe(true)
    expect((statSync(publishArcusPath).mode & 0o111) !== 0).toBe(true)
    expect((statSync(migrateArcusPath).mode & 0o111) !== 0).toBe(true)
  })

  it('packs release and generates a signed Arcus v2 envelope and dual-window v1 manifest in an isolated directory', () => {
    const testOutDir = mkdtempSync(join(tmpdir(), 'arcus-v2-test-'))

    try {
      execFileSync(
        'sh',
        [
          resolve(repoRoot, 'scripts/pack-arcus.sh'),
          '--sequence',
          '9999',
          '--output',
          testOutDir,
          '--skip-build',
        ],
        { cwd: repoRoot, stdio: 'pipe' },
      )

      const expectedTarballName = `cortexkit-opencode-anthropic-auth-${opencodePkg.version}.tgz`
      const tarballPath = join(testOutDir, expectedTarballName)
      const v1ManifestPath = join(testOutDir, 'arcus-manifest.json')
      const v2EnvelopePath = join(
        testOutDir,
        'releases',
        `${opencodePkg.version}.json`,
      )

      expect(existsSync(tarballPath)).toBe(true)
      expect(existsSync(v1ManifestPath)).toBe(true)
      expect(existsSync(v2EnvelopePath)).toBe(true)

      // Validate legacy v1 manifest structure
      const v1Manifest = JSON.parse(readFileSync(v1ManifestPath, 'utf-8'))
      expect(v1Manifest.name).toBe('opencode-anthropic-auth')
      expect(v1Manifest.version).toBe(opencodePkg.version)
      expect(v1Manifest.harness).toBe('opencode')
      expect(v1Manifest.plugin?.type).toBe('opencode-plugin')
      expect(v1Manifest.plugin?.name).toBe('@cortexkit/opencode-anthropic-auth')
      expect(v1Manifest.plugin?.asset?.filename).toBe(expectedTarballName)
      expect(v1Manifest.plugin?.asset?.sha256).toMatch(/^[a-f0-9]{64}$/)

      // Validate v2 release envelope structure
      const v2Envelope = JSON.parse(readFileSync(v2EnvelopePath, 'utf-8'))
      expect(v2Envelope.signed?.schema_version).toBe(2)
      expect(v2Envelope.signed?.kind).toBe('release')
      expect(v2Envelope.signed?.package_id).toBe('opencode-anthropic-auth')
      expect(v2Envelope.signed?.version).toBe(opencodePkg.version)
      expect(v2Envelope.signed?.sequence).toBe(9999)
      expect(v2Envelope.signatures?.length).toBeGreaterThanOrEqual(1)

      // All 5 canonical targets must be present
      expect(Object.keys(v2Envelope.signed?.targets || {})).toEqual([
        'darwin-arm64',
        'darwin-x64',
        'linux-arm64',
        'linux-x64',
        'windows-x64',
      ])

      // Check target integrity fields
      const target = v2Envelope.signed.targets['darwin-arm64']
      expect(target.artifact.archive_sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(target.target_content_source.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(target.tree_signature.sha256).toMatch(/^[a-f0-9]{64}$/)

      // Distinctness invariant
      expect(target.artifact.archive_sha256).not.toBe(
        target.target_content_source.sha256,
      )
      expect(target.artifact.archive_sha256).not.toBe(
        target.tree_signature.sha256,
      )
      expect(target.target_content_source.sha256).not.toBe(
        target.tree_signature.sha256,
      )
    } finally {
      rmSync(testOutDir, { recursive: true, force: true })
    }
  }, 25000)
})
