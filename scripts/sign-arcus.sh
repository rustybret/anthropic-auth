#!/bin/sh
# =============================================================================
# sign-arcus.sh - produce a SIGNED Arcus v2 release envelope for opencode-anthropic-auth
#
# Two modes:
#   (default)            sign a freshly packed payload tree via pack-arcus.sh
#   --migrate <v1.json>  sign a v2 envelope migrated from a legacy v1 manifest
#
# Key handling contract: the private key is only ever read from a FILE, from
# STDIN, or from a named ENVIRONMENT VARIABLE. It is never accepted as a
# command-line value, so it never lands in argv, /proc, shell history, or a CI
# command log. Material taken from stdin or the environment is materialized
# into a 0600 file inside a private temp directory that is removed on exit.
# =============================================================================
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH='' cd -- "${SCRIPT_DIR}/.." && pwd -P)
PLUGIN_DIR="${REPO_ROOT}/packages/opencode"

ARCUS_BIN=${ARCUS_BIN:-arcus}

PROJECT_NAME='opencode-anthropic-auth'
PACKAGE_ID='opencode-anthropic-auth'
SOURCE_ID='arcus'
SOFTWARE_TYPE='opencode-plugin'

OUTPUT_DIR="${REPO_ROOT}/dist-arcus"
MIGRATE_INPUT=''
SEQUENCE=${ARCUS_SEQUENCE:-}
VERSION=''
RELEASE_ID=''
KEY_FILE_OPT=''
KEY_ENV_OPT=''
ALLOW_INCOMPLETE=0
KEY_FILE=''
TMP_KEY_DIR=''

die() {
  printf 'sign-arcus: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$TMP_KEY_DIR" ] && [ -d "$TMP_KEY_DIR" ]; then
    rm -rf "$TMP_KEY_DIR"
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 130' HUP INT TERM

usage() {
  cat <<'USAGE'
Usage: sh scripts/sign-arcus.sh [options]

  --migrate PATH       Migrate and sign a legacy v1 manifest instead of packing.
  --sequence N         Publisher-allocated monotonic sequence (>=1). Required.
  --version X.Y.Z      Release version (pack mode).
  --release-id ID      Release identifier (pack mode).
  --output DIR         Output directory (default: dist-arcus).
  --key-file PATH      Ed25519 private key file. Use '-' to read stdin.
  --key-env NAME       Name of an environment variable holding the key.
  --allow-incomplete   Migrate mode: emit stampable sentinels for fields v1
                       cannot supply instead of failing closed.
  -h, --help           Show this help.

The key is NEVER passed as a command-line value; --key/--signing-key are
refused. Fallbacks, in order: --key-file, --key-env, ARCUS_SIGNING_KEY_FILE,
ARCUS_SIGNING_KEY, then ~/.config/arcus/signing.key, then stdin when not a terminal.
USAGE
}

need_value() {
  [ "$1" -ge 2 ] || die "$2 requires a value"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --migrate) need_value "$#" "$1"; MIGRATE_INPUT=$2; shift 2 ;;
    --migrate=*) MIGRATE_INPUT=${1#*=}; shift ;;
    --sequence) need_value "$#" "$1"; SEQUENCE=$2; shift 2 ;;
    --sequence=*) SEQUENCE=${1#*=}; shift ;;
    --version) need_value "$#" "$1"; VERSION=$2; shift 2 ;;
    --version=*) VERSION=${1#*=}; shift ;;
    --release-id) need_value "$#" "$1"; RELEASE_ID=$2; shift 2 ;;
    --release-id=*) RELEASE_ID=${1#*=}; shift ;;
    --output) need_value "$#" "$1"; OUTPUT_DIR=$2; shift 2 ;;
    --output=*) OUTPUT_DIR=${1#*=}; shift ;;
    --key-file) need_value "$#" "$1"; KEY_FILE_OPT=$2; shift 2 ;;
    --key-file=*) KEY_FILE_OPT=${1#*=}; shift ;;
    --key-env) need_value "$#" "$1"; KEY_ENV_OPT=$2; shift 2 ;;
    --key-env=*) KEY_ENV_OPT=${1#*=}; shift ;;
    --allow-incomplete) ALLOW_INCOMPLETE=1; shift ;;
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
  die "arcus CLI not found (set ARCUS_BIN); signing is fail-closed"

[ -n "$SEQUENCE" ] ||
  die "--sequence (or ARCUS_SEQUENCE) is required: the publisher allocates the monotonic v2 sequence"
case "$SEQUENCE" in
  ''|*[!0-9]*) die "--sequence must be a positive integer, got '$SEQUENCE'" ;;
esac
[ "$SEQUENCE" -ge 1 ] || die "--sequence must be >= 1, got '$SEQUENCE'"

# Materialize key
if [ -n "$KEY_FILE_OPT" ]; then
  if [ "$KEY_FILE_OPT" = '-' ]; then
    TMP_KEY_DIR=$(mktemp -d "${TMPDIR:-/tmp}/arcus-sign.XXXXXX")
    chmod 0700 "$TMP_KEY_DIR"
    KEY_FILE="${TMP_KEY_DIR}/signing.key"
    cat > "$KEY_FILE"
    chmod 0600 "$KEY_FILE"
  else
    KEY_FILE="$KEY_FILE_OPT"
  fi
elif [ -n "$KEY_ENV_OPT" ]; then
  eval "KEY_VAL=\${$KEY_ENV_OPT:-}"
  [ -n "$KEY_VAL" ] || die "environment variable '$KEY_ENV_OPT' is empty or unset"
  TMP_KEY_DIR=$(mktemp -d "${TMPDIR:-/tmp}/arcus-sign.XXXXXX")
  chmod 0700 "$TMP_KEY_DIR"
  KEY_FILE="${TMP_KEY_DIR}/signing.key"
  printf '%s' "$KEY_VAL" > "$KEY_FILE"
  chmod 0600 "$KEY_FILE"
  unset KEY_VAL
elif [ -n "${ARCUS_SIGNING_KEY_FILE:-}" ]; then
  KEY_FILE="$ARCUS_SIGNING_KEY_FILE"
elif [ -n "${ARCUS_SIGNING_KEY:-}" ]; then
  TMP_KEY_DIR=$(mktemp -d "${TMPDIR:-/tmp}/arcus-sign.XXXXXX")
  chmod 0700 "$TMP_KEY_DIR"
  KEY_FILE="${TMP_KEY_DIR}/signing.key"
  printf '%s' "$ARCUS_SIGNING_KEY" > "$KEY_FILE"
  chmod 0600 "$KEY_FILE"
elif [ -f "${HOME}/.config/arcus/signing.key" ]; then
  KEY_FILE="${HOME}/.config/arcus/signing.key"
elif [ ! -t 0 ]; then
  TMP_KEY_DIR=$(mktemp -d "${TMPDIR:-/tmp}/arcus-sign.XXXXXX")
  chmod 0700 "$TMP_KEY_DIR"
  KEY_FILE="${TMP_KEY_DIR}/signing.key"
  cat > "$KEY_FILE"
  chmod 0600 "$KEY_FILE"
else
  die "no signing key: supply --key-file, --key-file -, --key-env, or set ARCUS_SIGNING_KEY_FILE"
fi

[ -f "$KEY_FILE" ] || die "signing key file $KEY_FILE not found"

if [ -n "$MIGRATE_INPUT" ]; then
  [ -f "$MIGRATE_INPUT" ] || die "v1 manifest not found: $MIGRATE_INPUT"
  mkdir -p "$OUTPUT_DIR"
  ARGS="--source-id $SOURCE_ID --sequence $SEQUENCE --strategy $SOFTWARE_TYPE --sign-with $KEY_FILE --out-dir $OUTPUT_DIR"
  if [ "$ALLOW_INCOMPLETE" -eq 1 ]; then
    ARGS="$ARGS --allow-incomplete"
  fi
  # shellcheck disable=SC2086
  "$ARCUS_BIN" manifest migrate "$MIGRATE_INPUT" $ARGS
else
  # Delegate to pack-arcus.sh with the materialized key file
  PACK_ARGS="--sequence $SEQUENCE --output $OUTPUT_DIR --key-file $KEY_FILE"
  if [ -n "$VERSION" ]; then
    PACK_ARGS="$PACK_ARGS --version $VERSION"
  fi
  if [ -n "$RELEASE_ID" ]; then
    PACK_ARGS="$PACK_ARGS --release-id $RELEASE_ID"
  fi
  # shellcheck disable=SC2086
  sh "${SCRIPT_DIR}/pack-arcus.sh" $PACK_ARGS
fi
