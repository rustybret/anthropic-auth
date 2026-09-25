# Arcus v3 Release Process — opencode-anthropic-auth

## Overview

This document describes the canonical Arcus v3 release, packaging, and distribution pipeline for `opencode-anthropic-auth`. The package is distributed hermetically through Arcus v3 (`rustybret/arcus`) and managed via the blessed plugin composition (`arcus-blessed-plugins.json`).

### Key Characteristics:
- **Zero Binaries in Git**: All compiled archives (`.tar.zst`, `.zip`, `.pwr`) are published as GitHub Release assets and served via the Arcus artifact gateway (`arcus-auth.rustybret.com`).
- **Canonical Arcus Dist Release Organization**: Release outputs strictly follow the canonical Arcus dist standard:
  ```
  dist/<sequence>/<package_id>/<version>/
  ```
  Sequence is the true immutable timeline (strictly monotonic, > current, never resetting to 1). For multi-component suites, the lumped sequence must be the MAX across all components in the suite + 1:
  $$\text{suite\_seq} = \max(\text{all suite package sequences}) + 1$$
  Every component is assigned the unified suite sequence, establishing a compatibility lock and eliminating component sequence skew. Version is a display-only artifact. All packages are neatly organized in sequence, package, and version subdirectories (never dumped flat into the repository root).
- **Cryptographic Signature Verification**: Every release manifest is cryptographically signed using Ed25519 and validated via `arcus manifest validate --with-envelope`.
- **5 Canonical Targets**: Releases provide distinct, verified multi-arch artifacts across `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, and `windows-x64` satisfying distinct digest triples (`archive_sha256 != content_source_sha256 != tree_signature_sha256`).
- **Consumer Template Architecture**: Toolchain scripts are symlinked directly to `packages/arcus/toolchain/scripts/*` via `packages/arcus/bootstrap.sh` and `arcus install arcus-publisher`. Git submodules of Arcus are strictly prohibited (Arcus R4).
- **Authenticated HTTPS Publishing**: Submissions are delivered to the Arcus gateway via `arcus publish submit` and tracked via `arcus publish status` over authenticated HTTPS (`https://arcus-auth.rustybret.com`).

---

## 1. Toolchain & Consumer Template Architecture

The repository integrates Arcus via the **Arcus Consumer Template (`packages/arcus`)**:

```
anthropic-auth/
├── packages/
│   └── arcus/                  # Arcus consumer template (bootstrap.sh, arcus.json)
│       └── toolchain/          # -> Symlink to installed arcus-publisher
├── dist/                       # Git-ignored canonical Arcus distribution directory
│   └── <sequence>/             # Sequence as true immutable timeline
│       └── opencode-anthropic-auth/ # Package / component
│           └── <version>/      # Display-only version
│               ├── opencode-anthropic-auth-<ver>-<target>.tar.zst
│               ├── opencode-anthropic-auth-<ver>-<target>.pwr
│               ├── opencode-anthropic-auth-<ver>-<target>-content.zip
│               ├── release.json
│               ├── release.index-policy.json
│               ├── assets.sha256
│               ├── toolchain.json
│               ├── submission.json
│               ├── pack-report.json
│               ├── arcus-manifest.json
│               └── releases/
│                   └── <release_id>.json
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

## 2. Packaging & Dist Directory Standard

Packaging produces self-contained, validated release envelopes and archives organized by version and sequence:

```bash
# Verify pipeline self-tests and packaging assertions
bun run test:arcus

# Package into tidy dist/<version>/<sequence>/opencode-anthropic-auth/
bun run pack:arcus
```

### Packaging Driver (`scripts/pack-arcus.sh`)
`scripts/pack-arcus.sh` acts as the target-assembly driver for `@cortexkit/opencode-anthropic-auth`:
- **Standard Dist Hierarchy**: Automatically defaults output to `dist/<version>/<sequence>/<package_id>/`.
- **Sequence Auto-Allocation**: When `--sequence` is omitted, it invokes `arcus manifest allocate-sequence` against the local Arcus catalog to assign the next monotonic sequence number.
- **Dynamic Binary Discovery**: Resolves the `arcus` CLI binary from `$PATH`, candidate local build trees, or `ARCUS_BIN`.
- **Argv Key Guard**: Prevents leaking private keys in command-line arguments (rejects raw key values passed via `--key`, `--signing-key`, or `--private-key`; accepts `--key-env`, `--key-file`, or stdin).
- **Hermetic Self-Test**: Supports `--self-test` to validate argument parsing, exit codes, and sequence logic safely.
- **5 Canonical Targets**: Stages standalone release archives with distinct digest triples (`sha256`, target content source digest, and size) for each target architecture.
- **POSIX Executable Permissions**: Enforces executable mode (`0755`) on entry points (`dist/index.js`, `dist/cli.js`).

---

## 3. Gateway Submission & Publishing Workflow

Arcus V3 replaces legacy direct repository writes with an **immutable submission bundle pipeline** and **gateway-authoritative catalog management** over authenticated HTTPS.

### The `arcus publish` CLI Surface

The modern `arcus publish` command suite manages release submissions:

```text
Publish releases to an Arcus gateway over authenticated HTTPS

Usage:
  arcus publish [command]

Available Commands:
  status      Query the status and verification diagnostics of a release submission
  submit      Submit an immutable release bundle to the gateway for automated testing and hydration

Flags:
  -h, --help   help for publish

Global Flags:
      --json      Output results in JSON format
  -v, --verbose   Enable verbose output
```

### Step-by-Step Publishing Flow:

1. **Emit Submission Bundle**:
   Publishing scripts (`scripts/publish-arcus.sh` or `arcus-pipeline.sh publish`) generate a self-contained submission bundle:
   ```
   dist/arcus/opencode-anthropic-auth-<release_id>/
   ├── release.json               # Signed RFC 8785 Schema V3 envelope
   ├── release.index-policy.json  # Optional channel routing policy
   ├── assets.sha256              # Signed cryptographic artifact ledger
   ├── toolchain.json             # Publisher toolchain provenance
   ├── submission.json            # Intake manifest (submission.schema.json)
   └── <artifact_archives>        # .tar.zst, .pwr, -content.zip per target
   ```

2. **Submit to Gateway**:
   Submit the immutable release bundle to the Arcus gateway over authenticated HTTPS:
   ```bash
   arcus publish submit \
     --bundle dist/arcus/opencode-anthropic-auth-<release_id>/ \
     --gateway https://arcus-auth.rustybret.com \
     --wait
   ```

3. **Check Submission Status**:
   Inspect verification status, gate results, and hydration diagnostics:
   ```bash
   arcus publish status <submission_id> --gateway https://arcus-auth.rustybret.com
   ```

4. **Gateway Ingestion & Hydration**:
   The gateway catalog authority evaluates the 8-point acceptance gate:
   - Toolchain version floor (`>= 0.4.0`)
   - Ed25519 signature verification against publisher public key
   - Monotonic sequence check against live index
   - Distinct digest triple verification
   - POSIX executable bit verification on action targets
   - Hydrates artifacts to storage and re-signs `manifests/v3/index.json`.

---

## 4. Agent Release Checklist

| Step | Action | Command / Verification |
|------|--------|------------------------|
| **1. Upstream Sync** | Merge upstream `cortexkit/anthropic-auth` | `bun run fork-sync` |
| **2. Code Quality** | Verify compilation and unit tests | `bun run typecheck && bun run test` |
| **3. Pipeline Test** | Verify Arcus pipeline scripts & test gates | `bun run test:arcus` |
| **4. Build & Pack** | Pack into `dist/<version>/<seq>/<package>` | `bun run pack:arcus` |
| **5. Validate** | Validate signed envelope | `arcus manifest validate --with-envelope dist/<ver>/<seq>/opencode-anthropic-auth/releases/<id>.json` |
| **6. Upload Assets** | Upload GitHub release assets | `gh release upload v<version> dist/<ver>/<seq>/opencode-anthropic-auth/*` |
| **7. Gateway Submit** | Submit release bundle to gateway | `arcus publish submit --bundle dist/arcus/opencode-anthropic-auth-<id>/` |
| **8. Verify Status** | Confirm gateway hydration | `arcus publish status <submission_id>` |
| **9. Local Plugin Sync**| Refresh local OpenCode plugin | `cp -R packages/opencode/dist/* ~/.config/opencode/plugins/opencode-anthropic-auth/dist/` |
