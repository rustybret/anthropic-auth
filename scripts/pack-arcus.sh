#!/bin/sh
# =============================================================================
# pack-arcus.sh - Arcus v2 packaging for opencode-anthropic-auth (OpenCode plugin)
#
#   software type : opencode-plugin
#   package_id    : opencode-anthropic-auth
#   source_id     : arcus
#
# Emits <output>/releases/<release_id>.json (a signed v2 release envelope) plus
# three DISTINCT digests - artifact.archive_sha256, target_content_source.sha256
# and tree_signature.sha256 across all five canonical targets.
#
# The publisher sequence is an INPUT, never inferred: v2 clients reject a
# non-monotonic sequence, so the caller owns allocation.
#
# Signing key material is NEVER read from argv. Pass a key file path, stdin, or
# an environment variable NAME.
# =============================================================================
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH='' cd -- "${SCRIPT_DIR}/.." && pwd -P)
PLUGIN_DIR="${REPO_ROOT}/packages/opencode"

ARCUS_BIN=${ARCUS_BIN:-arcus}

PROJECT_NAME='opencode-anthropic-auth'
PACKAGE_ID='opencode-anthropic-auth'
SOURCE_ID='arcus'
CHANNEL='stable'
SOFTWARE_TYPE='opencode-plugin'
GITHUB_REPO='rustybret/anthropic-auth'
ARCHIVE_FORMAT='tar.zst'
PLUGIN_PACKAGE_NAME='@cortexkit/opencode-anthropic-auth'

OUTPUT_DIR="${REPO_ROOT}/dist-arcus"
PAYLOAD_DIR=''
VERSION=''
RELEASE_ID=''
SEQUENCE=${ARCUS_SEQUENCE:-}
KEY_FILE_OPT=''
KEY_ENV_OPT=''
SKIP_BUILD=0
SKIP_VALIDATE=0

die() {
  printf 'pack-arcus: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'pack-arcus: warning: %s\n' "$*" >&2
}

usage() {
  cat <<'USAGE'
Usage: sh scripts/pack-arcus.sh --sequence N [options]

  --sequence N        Publisher-allocated monotonic sequence (>=1). Required.
                      May also be supplied as ARCUS_SEQUENCE.
  --version X.Y.Z     Release version (default: packages/opencode/package.json).
  --release-id ID     Release identifier (default: <version> or <package_id>-<version>).
  --channel NAME      Distribution channel (default: stable).
  --payload DIR       Use a pre-staged payload directory (skips staging).
  --output DIR        Output directory (default: dist-arcus).
  --format FMT        Archive format: tar.zst, tar.gz, or zip (default: tar.zst).
  --key-file PATH     Ed25519 private key file. Use '-' to read stdin.
  --key-env NAME      Name of an environment variable holding the key.
  --skip-build        Do not run the project build step.
  --skip-validate     Do not run validate-arcus.sh on the emitted envelope.
  -h, --help          Show this help.

Key material is never accepted as a command-line VALUE. Supply --key-file,
--key-file - (stdin), --key-env NAME, ARCUS_SIGNING_KEY_FILE, or ARCUS_SIGNING_KEY.
USAGE
}

need_value() {
  [ "$1" -ge 2 ] || die "$2 requires a value"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --sequence) need_value "$#" "$1"; SEQUENCE=$2; shift 2 ;;
    --sequence=*) SEQUENCE=${1#*=}; shift ;;
    --version) need_value "$#" "$1"; VERSION=$2; shift 2 ;;
    --version=*) VERSION=${1#*=}; shift ;;
    --release-id) need_value "$#" "$1"; RELEASE_ID=$2; shift 2 ;;
    --release-id=*) RELEASE_ID=${1#*=}; shift ;;
    --channel) need_value "$#" "$1"; CHANNEL=$2; shift 2 ;;
    --channel=*) CHANNEL=${1#*=}; shift ;;
    --payload) need_value "$#" "$1"; PAYLOAD_DIR=$2; shift 2 ;;
    --payload=*) PAYLOAD_DIR=${1#*=}; shift ;;
    --output) need_value "$#" "$1"; OUTPUT_DIR=$2; shift 2 ;;
    --output=*) OUTPUT_DIR=${1#*=}; shift ;;
    --format) need_value "$#" "$1"; ARCHIVE_FORMAT=$2; shift 2 ;;
    --format=*) ARCHIVE_FORMAT=${1#*=}; shift ;;
    --key-file) need_value "$#" "$1"; KEY_FILE_OPT=$2; shift 2 ;;
    --key-file=*) KEY_FILE_OPT=${1#*=}; shift ;;
    --key-env) need_value "$#" "$1"; KEY_ENV_OPT=$2; shift 2 ;;
    --key-env=*) KEY_ENV_OPT=${1#*=}; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-validate) SKIP_VALIDATE=1; shift ;;
    --key|--key=*|--signing-key|--signing-key=*|--private-key|--private-key=*)
      die "refusing ${1%%=*}: key material must never appear in argv; use --key-file PATH, --key-file - (stdin), or --key-env NAME" ;;
    -h|--help) usage; exit 0 ;;
    *) die "unrecognized argument '$1'" ;;
  esac
done

if ! command -v "$ARCUS_BIN" >/dev/null 2>&1; then
  for candidate in \
    "${HOME}/.local/bin/arcus" \
    "${HOME}/.arcus/bin/arcus" \
    "/usr/local/bin/arcus" \
    "${REPO_ROOT}/../arcus/bin/arcus" \
    "/Volumes/Topper2TB/Git/arcus/bin/arcus"; do
    if [ -x "$candidate" ]; then
      ARCUS_BIN="$candidate"
      break
    fi
  done
fi

command -v "$ARCUS_BIN" >/dev/null 2>&1 ||
  die "arcus CLI not found (set ARCUS_BIN); v2 packaging is fail-closed"

[ -n "$SEQUENCE" ] ||
  die "--sequence (or ARCUS_SEQUENCE) is required: the publisher allocates the monotonic v2 sequence"
case "$SEQUENCE" in
  ''|*[!0-9]*) die "--sequence must be a positive integer, got '$SEQUENCE'" ;;
esac
[ "$SEQUENCE" -ge 1 ] || die "--sequence must be >= 1, got '$SEQUENCE'"

if [ -z "$VERSION" ]; then
  if [ -f "${PLUGIN_DIR}/package.json" ]; then
    VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${PLUGIN_DIR}/package.json" | head -n 1)
  elif [ -f "${REPO_ROOT}/VERSION" ]; then
    VERSION=$(tr -d ' \t\r\n' < "${REPO_ROOT}/VERSION")
  elif [ -f "${REPO_ROOT}/package.json" ]; then
    VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${REPO_ROOT}/package.json" | head -n 1)
  fi
fi
[ -n "$VERSION" ] || die "--version is required (no version found in packages/opencode/package.json)"
VERSION=${VERSION#v}

if [ -z "$RELEASE_ID" ]; then
  RELEASE_ID="$VERSION"
fi
[ -n "$RELEASE_ID" ] || die "could not derive a release_id from ${PACKAGE_ID} ${VERSION}"

stage_payload() {
  if [ "$SKIP_BUILD" -eq 0 ]; then
    printf 'pack-arcus: building workspace packages...\n'
    if command -v bun >/dev/null 2>&1; then
      ( cd "$REPO_ROOT" && bun run build ) || die "bun run build failed"
    else
      ( cd "$REPO_ROOT" && npm run build ) || die "npm run build failed"
    fi
  fi

  [ -d "${PLUGIN_DIR}/dist" ] || die "plugin build output not found at ${PLUGIN_DIR}/dist"

  mkdir -p "${PAYLOAD_DIR}/dist" "${PAYLOAD_DIR}/src"

  # Copy built dist
  cp -R "${PLUGIN_DIR}/dist/." "${PAYLOAD_DIR}/dist/"

  # Copy required runtime source files (excluding tests)
  cp "${PLUGIN_DIR}/src/tui.tsx" "${PAYLOAD_DIR}/src/"
  cp "${PLUGIN_DIR}/src/sidebar-state.ts" "${PAYLOAD_DIR}/src/"
  cp "${PLUGIN_DIR}/src/tui-preferences.ts" "${PAYLOAD_DIR}/src/"

  mkdir -p "${PAYLOAD_DIR}/src/tui" "${PAYLOAD_DIR}/src/tui-compiled" "${PAYLOAD_DIR}/src/rpc"
  cp -R "${PLUGIN_DIR}/src/tui/." "${PAYLOAD_DIR}/src/tui/"
  cp -R "${PLUGIN_DIR}/src/tui-compiled/." "${PAYLOAD_DIR}/src/tui-compiled/"
  cp -R "${PLUGIN_DIR}/src/rpc/." "${PAYLOAD_DIR}/src/rpc/"

  # Copy plugin package.json and metadata
  cp "${PLUGIN_DIR}/package.json" "${PAYLOAD_DIR}/package.json"
  if [ -f "${REPO_ROOT}/README.md" ]; then
    cp "${REPO_ROOT}/README.md" "${PAYLOAD_DIR}/README.md"
  fi
  if [ -f "${REPO_ROOT}/LICENSE" ]; then
    cp "${REPO_ROOT}/LICENSE" "${PAYLOAD_DIR}/LICENSE"
  fi

  [ -f "${PAYLOAD_DIR}/dist/index.js" ] || die "required entrypoint dist/index.js missing from staged payload"
  [ -f "${PAYLOAD_DIR}/src/tui/entry.mjs" ] || die "required entrypoint src/tui/entry.mjs missing from staged payload"
  [ -f "${PAYLOAD_DIR}/src/tui-compiled/tui.tsx" ] || die "required entrypoint src/tui-compiled/tui.tsx missing from staged payload"

  # Generate legacy v1 npm pack tarball and stamp real sha256 into arcus-manifest.json
  cd "$PLUGIN_DIR"
  TARBALL=$(npm pack --pack-destination="$OUTPUT_DIR" 2>/dev/null | tail -n 1)
  cd "$REPO_ROOT"

  V1_SHA256="0000000000000000000000000000000000000000000000000000000000000000"
  if [ -f "${OUTPUT_DIR}/${TARBALL}" ]; then
    V1_SHA256=$(shasum -a 256 "${OUTPUT_DIR}/${TARBALL}" | awk '{print $1}')
  fi

  cat <<EOF > "${OUTPUT_DIR}/arcus-manifest.json"
{
  "\$schema": "https://raw.githubusercontent.com/rustybret/arcus/main/manifests/schema.json",
  "name": "${PROJECT_NAME}",
  "version": "${VERSION}",
  "description": "Anthropic auth, quota, cache, and relay plugin for OpenCode",
  "harness": "opencode",
  "plugin": {
    "type": "opencode-plugin",
    "name": "${PLUGIN_PACKAGE_NAME}",
    "version": "${VERSION}",
    "hydrate": false,
    "asset": {
      "filename": "${TARBALL}",
      "url": "https://github.com/${GITHUB_REPO}/releases/download/v${VERSION}/${TARBALL}",
      "sha256": "${V1_SHA256}",
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
}

mkdir -p "$OUTPUT_DIR"
if [ -z "$PAYLOAD_DIR" ]; then
  PAYLOAD_DIR="${OUTPUT_DIR}/payload"
  rm -rf "$PAYLOAD_DIR"
  mkdir -p "$PAYLOAD_DIR"
  stage_payload
fi
[ -d "$PAYLOAD_DIR" ] || die "payload directory ${PAYLOAD_DIR} does not exist"

# Key selection
resolve_key_flags() {
  if [ -n "$KEY_FILE_OPT" ]; then
    printf '%s' "--key-file $KEY_FILE_OPT"
  elif [ -n "$KEY_ENV_OPT" ]; then
    printf '%s' "--key-env $KEY_ENV_OPT"
  elif [ -n "${ARCUS_SIGNING_KEY_FILE:-}" ]; then
    printf '%s' "--key-file $ARCUS_SIGNING_KEY_FILE"
  elif [ -n "${ARCUS_SIGNING_KEY:-}" ]; then
    printf '%s' "--key-env ARCUS_SIGNING_KEY"
  elif [ -f "${HOME}/.config/arcus/signing.key" ]; then
    printf '%s' "--key-file ${HOME}/.config/arcus/signing.key"
  elif [ ! -t 0 ]; then
    printf '%s' "--key-file -"
  else
    die "no signing key: pass --key-file PATH, --key-file - (stdin), --key-env NAME, or set ARCUS_SIGNING_KEY_FILE / ARCUS_SIGNING_KEY"
  fi
}

KEY_FLAGS=$(resolve_key_flags)

REPORT="${OUTPUT_DIR}/pack-report.json"

printf 'pack-arcus: packing %s %s (release %s, sequence %s, channel %s) across 5 canonical targets\n' \
  "$PACKAGE_ID" "$VERSION" "$RELEASE_ID" "$SEQUENCE" "$CHANNEL"

# Pack for all 5 canonical target platforms
# shellcheck disable=SC2086
"$ARCUS_BIN" pack --json \
  --target-input "darwin-arm64=${PAYLOAD_DIR}" \
  --target-input "darwin-x64=${PAYLOAD_DIR}" \
  --target-input "linux-arm64=${PAYLOAD_DIR}" \
  --target-input "linux-x64=${PAYLOAD_DIR}" \
  --target-input "windows-x64=${PAYLOAD_DIR}" \
  --output "$OUTPUT_DIR" \
  --source-id "$SOURCE_ID" \
  --package-id "$PACKAGE_ID" \
  --release-id "$RELEASE_ID" \
  --version "$VERSION" \
  --sequence "$SEQUENCE" \
  --channel "$CHANNEL" \
  --format "$ARCHIVE_FORMAT" \
  --strategy "$SOFTWARE_TYPE" \
  --action-executable "dist/index.js" \
  $KEY_FLAGS > "$REPORT" ||
  die "arcus pack failed (report: ${REPORT})"

# Clean up staged payload directory
if [ -d "$PAYLOAD_DIR" ]; then
  rm -rf "$PAYLOAD_DIR"
fi

ENVELOPE="${OUTPUT_DIR}/releases/${RELEASE_ID}.json"
[ -f "$ENVELOPE" ] || die "expected release envelope not found at ${ENVELOPE}"

# Verification of digest distinctness
ARCHIVE_HASH=$(sed -n 's/.*"archive_sha256"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ENVELOPE" | head -n 1)
CONTENT_HASH=$(sed -n 's/.*"target_content_source".*"sha256"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ENVELOPE" | head -n 1)
TREE_HASH=$(sed -n 's/.*"tree_signature".*"sha256"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ENVELOPE" | head -n 1)

if [ -n "$ARCHIVE_HASH" ] && [ "$ARCHIVE_HASH" = "$CONTENT_HASH" ]; then
  die "digest collision: archive_sha256 equals content_source sha256 ($ARCHIVE_HASH)"
fi
if [ -n "$ARCHIVE_HASH" ] && [ "$ARCHIVE_HASH" = "$TREE_HASH" ]; then
  die "digest collision: archive_sha256 equals tree_signature sha256 ($ARCHIVE_HASH)"
fi
if [ -n "$CONTENT_HASH" ] && [ "$CONTENT_HASH" = "$TREE_HASH" ]; then
  die "digest collision: content_source sha256 equals tree_signature sha256 ($CONTENT_HASH)"
fi

printf 'pack-arcus: successfully generated signed v2 envelope:\n'
printf '  Envelope: %s\n' "$ENVELOPE"
printf '  Sequence: %s\n' "$SEQUENCE"
printf '  Version:  %s\n' "$VERSION"

if [ "$SKIP_VALIDATE" -eq 0 ]; then
  if [ -f "${SCRIPT_DIR}/validate-arcus.sh" ]; then
    printf 'pack-arcus: running validation...\n'
    sh "${SCRIPT_DIR}/validate-arcus.sh" "$ENVELOPE"
  fi
fi
