#!/usr/bin/env bash
set -euo pipefail

# pack-arcus.sh — Package @cortexkit/opencode-anthropic-auth for Arcus
# distribution (rustybret/arcus).
#
# Produces:
#   1. dist-arcus/<npm-pack-tarball>.tgz  — the plugin archive (npm-pack
#      shaped: everything nested under a `package/` prefix)
#   2. dist-arcus/arcus-manifest.json     — a conforming manifest per
#      manifests/schema.json in rustybret/arcus, with asset.url/sha256 left
#      as placeholders. The cloudhome BuildKit arcus-release-upload job
#      stamps both from the real uploaded artifact — never precompute a
#      hash of a not-yet-uploaded file.
#
# Usage:
#   ./scripts/pack-arcus.sh [outdir]   (default: dist-arcus)

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
PLUGIN_DIR="$REPO_ROOT/packages/opencode"
OUTDIR="${1:-$REPO_ROOT/dist-arcus}"

mkdir -p "$OUTDIR"

echo "=== Arcus Package Build: anthropic-auth (opencode plugin) ==="

echo "-> Building workspace packages..."
cd "$REPO_ROOT"
bun run build

echo "-> Packaging @cortexkit/opencode-anthropic-auth..."
cd "$PLUGIN_DIR"
TARBALL=$(npm pack --pack-destination="$OUTDIR" 2>/dev/null | tail -n 1)
cd "$REPO_ROOT"

TARBALL_PATH="$OUTDIR/$TARBALL"
VERSION=$(node -e "console.log(require('./packages/opencode/package.json').version)")
MANIFEST_FILE="$OUTDIR/arcus-manifest.json"

cat <<EOF > "$MANIFEST_FILE"
{
  "\$schema": "https://raw.githubusercontent.com/rustybret/arcus/main/manifests/schema.json",
  "name": "opencode-anthropic-auth",
  "version": "$VERSION",
  "description": "Anthropic auth, quota, cache, and relay plugin for OpenCode",
  "harness": "opencode",
  "plugin": {
    "type": "opencode-plugin",
    "name": "@cortexkit/opencode-anthropic-auth",
    "version": "$VERSION",
    "asset": {
      "filename": "$TARBALL",
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
EOF

echo ""
echo "  Archive:  $TARBALL_PATH"
echo "  Manifest: $MANIFEST_FILE"
echo ""
echo "  BuildKit env for k8s/base/ops/buildkit/jobs/arcus-release-upload.yaml:"
echo "    ARCUS_ASSET_PATH=dist-arcus/$TARBALL"
echo "    ARCUS_MANIFEST_PATH=manifests/anthropic-auth/v$VERSION.json"
echo "    ARCUS_MANIFEST_SRC=dist-arcus/arcus-manifest.json"
echo ""
