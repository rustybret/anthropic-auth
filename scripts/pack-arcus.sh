#!/usr/bin/env bash
set -euo pipefail

# pack-arcus.sh — Package OpenCode Anthropic Auth plugin for Arcus distribution
#
# Usage:
#   ./scripts/pack-arcus.sh [--outdir <path>]

OUTDIR="dist-arcus"
if [[ "${1:-}" == "--outdir" && -n "${2:-}" ]]; then
  OUTDIR="$2"
fi

mkdir -p "$OUTDIR"

echo "→ Building workspace packages..."
bun run build

echo "→ Packaging @cortexkit/opencode-anthropic-auth plugin..."
cd packages/opencode
TARBALL=$(npm pack --pack-destination="../../$OUTDIR" 2>/dev/null | tail -n 1)
cd ../..

TARBALL_PATH="$OUTDIR/$TARBALL"
SHA256=$(shasum -a 256 "$TARBALL_PATH" | awk '{print $1}')
VERSION=$(node -e "console.log(require('./packages/opencode/package.json').version)")

MANIFEST_FILE="$OUTDIR/anthropic-auth-$VERSION.json"

cat <<EOF > "$MANIFEST_FILE"
{
  "name": "opencode-anthropic-auth",
  "version": "$VERSION",
  "artifact": "$TARBALL",
  "sha256": "$SHA256",
  "url": "https://github.com/rustybret/anthropic-auth/releases/download/v$VERSION/$TARBALL"
}
EOF

echo ""
echo "  ✓ Plugin packaged for Arcus distribution:"
echo "    Artifact: $TARBALL_PATH"
echo "    SHA-256:  $SHA256"
echo "    Manifest: $MANIFEST_FILE"
echo ""
echo "  Next steps for Arcus publishing:"
echo "    1. Upload $TARBALL_PATH to GitHub Release v$VERSION in rustybret/anthropic-auth"
echo "    2. Commit manifest $MANIFEST_FILE to rustybret/arcus at manifests/plugins/anthropic-auth/$VERSION.json"
echo ""
