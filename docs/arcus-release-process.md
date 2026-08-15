# Arcus Release Process — @cortexkit/opencode-anthropic-auth

## Overview

This document describes the end-to-end release pipeline for publishing `@cortexkit/opencode-anthropic-auth` via the Arcus private package distribution system (`rustybret/arcus`). The process ensures:

- **Zero binary blobs in git**: Compiled `.tgz` archives are published as GitHub Release assets only.
- **SHA-256 integrity**: Every release manifest records a checksum so consumers can verify.
- **Monorepo-friendly**: Works from the `anthropic-auth` workspace root; no separate repo checkout needed for the build.

---

## 1. Prepare the Workspace

From the `anthropic-auth` repo root:

```bash
# Ensure local packages are built and up to date
bun run build

# Install dependencies (if not already installed)
bun install
```

---

## 2. Package the Plugin

Run the included packaging script. This performs the build, creates the `.tgz` tarball, calculates its SHA-256 checksum, and emits an Arcus-compatible manifest JSON.

```bash
./scripts/pack-arcus.sh --outdir dist-arcus
```

**What this does:**

| Step | Action |
|------|--------|
| `bun run build` | Compiles all workspace packages (`core`, `opencode`, `pi`) and generates `dist/` |
| `npm pack` | Creates `cortexkit-opencode-anthropic-auth-<version>.tgz` in `dist-arcus/` |
| `shasum -a 256` | Computes the SHA-256 hash of the tarball |
| Manifest JSON | Writes `anthropic-auth-<version>.json` with name, version, asset filename, URL template, and SHA-256 |

**Output files (in `dist-arcus/`):**

```
dist-arcus/
├─ cortexkit-opencode-anthropic-auth-1.19.0.tgz     ← binary asset (NOT committed to git)
└─ anthropic-auth-1.19.0.json                       ← Arcus manifest (commit this)
```

**Generated manifest example** (`anthropic-auth-1.19.0.json`):

```json
{
  "$schema": "https://raw.githubusercontent.com/rustybret/arcus/main/manifests/schema.json",
  "name": "opencode-anthropic-auth",
  "version": "1.19.0",
  "description": "Anthropic auth, quota, cache, and relay plugin for OpenCode",
  "harness": "opencode",
  "plugin": {
    "type": "opencode-plugin",
    "name": "@cortexkit/opencode-anthropic-auth",
    "version": "1.19.0",
    "asset": {
      "filename": "cortexkit-opencode-anthropic-auth-1.19.0.tgz",
      "url": "PENDING_UPLOAD_URL",
      "sha256": "PENDING_BUILD_HASH",
      "strip_components": 1
    },
    "entrypoints": {
      "server": "dist/index.js",
      "tui": "src/tui/entry.mjs",
      "tui_compiled": "src/tui-compiled/tui.tsx"
    }
  }
}
```

> **Note**: The `url` field (`PENDING_UPLOAD_URL`) is a placeholder — see Step 4 for the actual upload.

---

## 3. Verify the Artifact

Inspect the generated manifest and tarball:

```bash
# Check manifest JSON syntax
cat dist-arcus/anthropic-auth-1.19.0.json

# Verify the tarball can be unpacked
tar tzf dist-arcus/cortexkit-opencode-anthropic-auth-1.19.0.tgz | head -5

# Confirm SHA-256 matches
shasum -a 256 dist-arcus/cortexkit-opencode-anthropic-auth-1.19.0.json  # manifest file hash
shasum -a 256 dist-arcus/cortexkit-opencode-anthropic-auth-1.19.0.tgz   # artifact hash
```

---

## 4. Publish to GitHub Releases

The `.tgz` tarball **MUST NOT** be committed to the `anthropic-auth` git repo. It is published as a GitHub Release asset.

```bash
# From the anthropic-auth repo root (or via GitHub CLI on any machine with access)

# 1. Create / verify the release tag
git tag -l  # e.g. v1.19.0 should exist

# 2. Upload the tarball as a Release asset
#    (requires GITHUB_TOKEN or PAT with repo scope)
gh release upload v1.19.0 dist-arcus/cortexkit-opencode-anthropic-auth-1.19.0.tgz \
  --repo rustybret/anthropic-auth

# 3. Update the manifest URL placeholder
#    Edit dist-arcus/anthropic-auth-1.19.0.json and replace:
#      "url": "PENDING_UPLOAD_URL"
#    with the actual uploaded URL, e.g.:
#      "url": "https://github.com/rustybret/anthropic-auth/releases/download/v1.19.0/cortexkit-opencode-anthropic-auth-1.19.0.tgz"
```

**Alternative: One-liner upload (if GITHUB_TOKEN is set as a build arg):**

```bash
# Inside a Docker build or CI with GITHUB_TOKEN env var:
gh release upload v$VERSION dist-arcus/cortexkit-opencode-anthropic-auth-$VERSION.tgz \
  --repo rustybret/anthropic-auth
```

---

## 5. Update Arcus Index (`rustybret/arcus`)

The consumer-facing Arcus repo (`rustybret/arcus`) tracks plugin manifests. After Step 4, commit the manifest to the appropriate path.

```bash
# From rustybret/arcus repo root

# 1. Create the manifests/plugins directory structure if needed
mkdir -p manifests/plugins/anthropic-auth

# 2. Copy (or symlink) the manifest from the source repo
cp /path/to/anthropic-auth/dist-arcus/anthropic-auth-1.19.0.json manifests/plugins/anthropic-auth/1.19.0.json

# 3. Commit and push
git add manifests/plugins/anthropic-auth/1.19.0.json
git commit -m "plugin: add @cortexkit/opencode-anthropic-auth v1.19.0"
git push origin main
```

**Expected manifest path in `rustybret/arcus`:**

```
manifests/plugins/anthropic-auth/1.19.0.json
```

This file is referenced by consumer `arcus.json` manifests (see Step 6).

---

## 6. Consumer `arcus.json` Update

Consumer repositories (e.g., `cloudhome`, `uc-studio`, workspace base images) include `anthropic-auth` in their `arcus.json` manifest:

```json
{
  "version": 1,
  "submodule": "submodules/arcus",
  "skills": [
    {
      "name": "opencode-anthropic-auth",
      "path": "manifests/plugins/anthropic-auth/1.19.0.json"
    }
  ]
}
```

**Consumption workflow** (per consumer):

```bash
# 1. Verify / initialize the arcus submodule
git submodule update --init submodules/arcus

# 2. Pull the latest skills/manifests
just pull arcus     # or: ./scripts/arcus-pull.sh

# 3. Verify materialized manifest exists
cat submodules/arcus/manifests/plugins/anthropic-auth/1.19.0.json

# 4. (Unity projects) Reference the UPM package if needed
#    Packages/manifest.json: "com.supermcp.unity-bridge": "file:../../submodules/arcus/packages/unity/..."
```

---

## 7. Auto-Sync & Auto-Upgrade in Workspaces

For Docker-based OpenCode workspaces (e.g., `cloudhome` deployment):

**Build-time** (`Dockerfile`):

```dockerfile
# During image build — fetch latest plugin via Arcus
ARG GITHUB_TOKEN
RUN just pull arcus  # clones rustybret/arcus, runs arcus-pull.sh
```

**Runtime** (`docker/workspaces/opencode-entrypoint.sh`):

```bash
# On container boot, seed plugins directory
if [[ ! -f ${HOME}/.config/opencode/plugins/cortexkit-opencode-anthropic-auth.tgz ]]; then
  just pull arcus     # ensures latest manifest is fetched
  # Download the tarball from the GitHub Release URL recorded in the manifest
  TARBALL_URL=$(jq -r '.plugin.asset.url' ${HOME}/.arcus/manifests/plugins/anthropic-auth/1.19.0.json)
  curl -L -o ${HOME}/.config/opencode/plugins/cortexkit-opencode-anthropic-auth.tgz "$TARBALL_URL"
fi
```

**Persistent user OAuth state**:

- `~/.config/opencode/anthropic-auth.json` and sidecar files (`anthropic-auth-state.json`, `anthropic-auth-routing-state.json`) should be persisted on a PVC across workspace restarts.
- OpenCode reads config from this path; the plugin writes token/quota state here.

---

## 8. Safety Gates & Checklist

| Gate | Command / Action | Pass condition |
|------|-----------------|----------------|
| **Build** | `bun run build` | Exit code 0 |
| **Typecheck** | `bun run typecheck` | Exit code 0 |
| **Tests** | `bun test` | 0 failures |
| **Packaging** | `./scripts/pack-arcus.sh --outdir dist-arcus` | Manifest + tarball generated |
| **Git sanity** | `git status --porcelain` | Only `dist-arcus/` and `scripts/pack-arcus.sh` are new/modified (no `.tgz` in git) |
| **Release tag** | `git rev-parse v<version>` | Tag exists |
| **GitHub Release** | `gh release view v<version> --repo rustybret/anthropic-auth` | Tarball asset listed |
| **Arcus manifest** | `cat manifests/plugins/anthropic-auth/<version>.json` | Valid JSON, SHA-256 matches tarball |
| **Consumer pull** | `just pull arcus` on consumer repo | Manifest materializes, no errors |

**Never commit:** `.tgz` archives, `node_modules/`, `dist/` (except what's tracked in `.gitignore`), or any build outputs to the `anthropic-auth` git repo. Always publish heavy binaries to **GitHub Release assets**.

---

## 9. Version Bump Workflow (minor/patch)

When releasing a new version (e.g., `1.19.0 → 1.20.0`):

1. Update version in `packages/opencode/package.json` (and `packages/core/package.json` if core changes).
2. Run `bun run build`.
3. Run `./scripts/pack-arcus.sh --outdir dist-arcus`.
4. Follow Steps 3–7 above, replacing `<version>` with the new version.
5. Tag the release: `git tag v1.20.0 && git push origin v1.20.0`.
6. Announce / coordinate with cross-project targets (cloudhome, uc-studio, etc.) via `project_message`.

---

## Appendix: Related Scripts

| Script | Purpose |
|--------|---------|
| `scripts/pack-arcus.sh` | Build + package + manifest generation (primary release tool) |
| `scripts/pack-arcus.test.ts` | Unit test skeleton for packaging script |
| `scripts/fork-sync.sh` | Merge upstream changes into fork (conflict resolution via `fork-sync-exclusions`) |
| `scripts/fork-sync-exclusions` | Standing conflict-class rules (keep-deleted / take-theirs) |
| `scripts/version-sync.mjs` | Cross-package version sync helper |
| `scripts/release.sh` | Full release pipeline (lint → typecheck → test → build → tag → push) |