import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
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
    const mockBinDir = mkdtempSync(join(tmpdir(), 'arcus-mock-bin-'))
    const mockArcus = join(mockBinDir, 'arcus')

    // Provide a mock arcus binary if arcus CLI is not installed on the system
    const hasArcus =
      existsSync('/usr/local/bin/arcus') ||
      existsSync(`${process.env.HOME}/.local/bin/arcus`)
    const env = { ...process.env }
    if (!hasArcus && !process.env.ARCUS_BIN) {
      const mockScript = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
if (args[0] === 'pack') {
  let output = 'dist-arcus';
  let releaseId = '${opencodePkg.version}';
  let sequence = 9999;
  let pkgId = 'opencode-anthropic-auth';
  let version = '${opencodePkg.version}';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) output = args[i + 1];
    if (args[i] === '--release-id' && args[i + 1]) releaseId = args[i + 1];
    if (args[i] === '--sequence' && args[i + 1]) sequence = Number(args[i + 1]);
    if (args[i] === '--package-id' && args[i + 1]) pkgId = args[i + 1];
    if (args[i] === '--version' && args[i + 1]) version = args[i + 1];
  }
  const relDir = path.join(output, 'releases');
  fs.mkdirSync(relDir, { recursive: true });
  const targets = {};
  for (const t of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'windows-x64']) {
    targets[t] = {
      artifact: { archive_sha256: 'a'.repeat(64) },
      target_content_source: { sha256: 'b'.repeat(64) },
      tree_signature: { sha256: 'c'.repeat(64) }
    };
  }
  const envelope = {
    signed: {
      schema_version: 2,
      kind: 'release',
      package_id: pkgId,
      version: version,
      sequence: sequence,
      targets: targets
    },
    signatures: ['mock-signature']
  };
  fs.writeFileSync(path.join(relDir, releaseId + '.json'), JSON.stringify(envelope, null, 2));
  console.log(JSON.stringify({ status: 'ok' }));
  process.exit(0);
} else if (args[0] === 'manifest' && args[1] === 'validate') {
  process.exit(0);
}
process.exit(0);
`
      writeFileSync(mockArcus, mockScript, { mode: 0o755 })
      env.ARCUS_BIN = mockArcus
    }

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
        { cwd: repoRoot, stdio: 'pipe', env },
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
      rmSync(mockBinDir, { recursive: true, force: true })
    }
  }, 25000)
})
