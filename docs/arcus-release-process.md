# Arcus v3 Release Process — opencode-anthropic-auth

## Overview

This document describes the modern Arcus v3 release and distribution pipeline for `opencode-anthropic-auth` within the private package fleet. The package is distributed hermetically through Arcus v3 (`rustybret/arcus`) and managed via the blessed plugin composition (`arcus-blessed-plugins.json`).

### Key Characteristics:
- **Zero Binaries in Git**: All compiled archives (`.tar.zst`, `.zip`, `.pwr`) are published as GitHub Release assets or served via the Arcus artifact gateway (`arcus-auth.rustybret.com`).
- **Cryptographic Signature Verification**: Every release manifest is cryptographically signed using Ed25519 and validated via `arcus manifest validate --with-envelope`.
- **5 Canonical Targets**: Releases provide distinct, verified multi-arch artifacts across `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, and `windows-x64`.
- **Consumer Template Architecture**: Toolchain scripts are symlinked directly to `packages/arcus/toolchain/scripts/*` via `packages/arcus/bootstrap.sh` and `arcus install arcus-publisher`. Git submodules of Arcus are strictly prohibited (Arcus R4).
- **Automated CI Build & Publish**: The canonical publishing path is driven automatically by Cloudhome BuildKit CI (`arcus-release-upload`), landing signed manifests in `rustybret/arcus` and triggering verification by `uc-studio`.

---

## 1. Toolchain & Consumer Template Architecture

The repository integrates Arcus via the **Arcus Consumer Template (`packages/arcus`)**:

```
anthropic-auth/
├── packages/
│   └── arcus/                  # Arcus consumer template (bootstrap.sh, arcus.json)
│       └── toolchain/          # -> Symlink to installed arcus-publisher
├── scripts/
│   ├── setup.sh                # Fresh clone bootstrap script
│   ├── pack-arcus.sh           # Specialized OpenCode plugin target packager
│   ├── pack-arcus.test.ts      # Automated verification tests
│   ├── arcus-pipeline.sh       # -> ../packages/arcus/toolchain/scripts/arcus-pipeline.sh
│   ├── sign-arcus.sh           # -> ../packages/arcus/toolchain/scripts/sign-arcus.sh
│   ├── validate-arcus.sh       # -> ../packages/arcus/toolchain/scripts/validate-arcus.sh
│   ├── publish-arcus.sh        # -> ../packages/arcus/toolchain/scripts/publish-arcus.sh
│   ├── migrate-arcus.sh        # -> ../packages/arcus/toolchain/scripts/migrate-arcus.sh
│   └── arcus-toolchain.json    # -> ../packages/arcus/toolchain/scripts/arcus-toolchain.json
```

### Fresh Clone Bootstrap
On a fresh clone, run the repository bootstrap script:

```bash
git clone https://github.com/rustybret/anthropic-auth.git
cd anthropic-auth
bun run setup
```

`bun run setup` (or `bash scripts/setup.sh` / `sh packages/arcus/bootstrap.sh`) will automatically:
1. Ensure the `arcus-publisher` toolchain is installed via `arcus install arcus-publisher`.
2. Symlink `packages/arcus/toolchain` and `.opencode/skills/arcus-publisher`.
3. Verify and repair all pipeline script symlinks.
4. Install workspace dependencies (`bun install`).
5. Verify the workspace build (`bun run build`).

---

## 2. Local Packaging & Pipeline Verification

Before releasing, developers can verify the packaging pipeline and run hermetic self-tests locally:

```bash
# Run self-tests across all pipeline scripts and package test assertions
bun run test:arcus
# or
bun run pipeline:arcus self-test

# Package 5 canonical targets into dist-arcus/
bun run pack:arcus
```

### Packaging Driver (`scripts/pack-arcus.sh`)
`scripts/pack-arcus.sh` acts as the target-assembly driver for `@cortexkit/opencode-anthropic-auth`:
- **Sequence Auto-Allocation**: When `--sequence` is omitted, it invokes `arcus manifest allocate-sequence` against the local Arcus catalog to assign the next monotonic sequence number.
- **Dynamic Binary Discovery**: Resolves the `arcus` CLI binary from `$PATH`, candidate local build trees, or `ARCUS_BIN`.
- **Argv Key Guard**: Prevents leaking private keys in command-line arguments (rejects raw key values passed via `--key`, `--signing-key`, or `--private-key`; accepts `--key-env`, `--key-file`, or stdin).
- **Hermetic Self-Test**: Supports `--self-test` to validate argument parsing, exit codes, and sequence logic safely.
- **5 Canonical Targets**: Stages standalone release archives with distinct digest triples (`sha256`, target content source digest, and size) for each target architecture.

---

## 3. Canonical Release Workflow (Cloudhome BuildKit CI)

Manual pack, sign, and publish operations from local workstations are discouraged for official releases. Official releases follow the canonical Cloudhome BuildKit CI pipeline:

```
[Developer]
    │
    ▼ (git tag -a v1.22.0 && git push origin v1.22.0)
[GitHub: rustybret/anthropic-auth]
    │
    ▼ (Webhook via Cloudflare Tunnel)
[Cloudhome Build Dispatcher]
    │ (Job: arcus-release-upload)
    ▼
[Cloudhome BuildKit Runner]
    ├─ Clones rustybret/anthropic-auth @ release tag
    ├─ Builds workspace packages (bun run build)
    ├─ Clones rustybret/arcus
    ├─ Executes arcus-pipeline.sh pack & sign with fleet key
    ├─ Validates signed envelope (arcus manifest validate --with-envelope)
    ├─ Commits signed manifest to rustybret/arcus manifests/v2/opencode-anthropic-auth/releases/
    └─ Uploads release archives to GitHub Release (gh release upload)
    │
    ▼
[Fleet Steward: uc-studio]
    ├─ Downloads signed manifest and candidate artifacts
    ├─ Evaluates 4-gate verification:
    │   1. Authenticated download verification
    │   2. SHA-256 digest match against manifest
    │   3. Hydration check (hydrate_required: false)
    │   4. Delta & regression checks
    └─ Promotes version & sequence in arcus-blessed-plugins.json
```

---

## 4. Release Checklist

| Step | Action | Verification |
|------|--------|--------------|
| **1. Upstream Sync** | `bun run fork-sync` | Upstream `cortexkit/anthropic-auth` merged, dependencies hydrated, build passes |
| **2. Code Quality** | `bun run typecheck && bun run test` | All packages compile; full test suite passes |
| **3. Pipeline Test** | `bun run test:arcus` | All script self-tests and pack tests pass (0 failures) |
| **4. Version Bump** | Update `packages/opencode/package.json` | Correct SemVer set |
| **5. Commit & Push** | `git commit -m "release: vX.Y.Z" && git push origin main` | Remote `origin/main` up to date |
| **6. Tag Release** | `git tag -a vX.Y.Z -m "Release vX.Y.Z" && git push origin vX.Y.Z` | Tag visible on GitHub |
| **7. CI Upload** | Monitor Cloudhome BuildKit `arcus-release-upload` | Descriptor committed to `rustybret/arcus` |
| **8. Blessed Promotion** | Notify `uc-studio` with release ID and sequence | Updated in `arcus-blessed-plugins.json` |
