#!/bin/sh
set -eu

# Resolve project repository root (directory containing packages/arcus)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -d "${SCRIPT_DIR}/../../packages/arcus" ]; then
  REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
elif [ -d "${SCRIPT_DIR}/packages/arcus" ]; then
  REPO_ROOT="${SCRIPT_DIR}"
else
  REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
fi

cd "${REPO_ROOT}"

# 1. Check for arcus CLI on PATH
if ! command -v arcus >/dev/null 2>&1; then
  echo "Error: arcus CLI not found on PATH." >&2
  echo "Please install Arcus via: curl -sSf https://arcus-auth.rustybret.com/install.sh | sh" >&2
  exit 1
fi

# 2. Install / update the arcus-publisher package
echo "==> Ensuring arcus-publisher toolchain is installed..."
arcus install arcus-publisher >/dev/null 2>&1 || true

# 3. Determine install root
INSTALL_ROOT=""
if [ -n "${ARCUS_INSTALL_ROOT:-}" ]; then
  INSTALL_ROOT="${ARCUS_INSTALL_ROOT}"
fi

if [ -z "${INSTALL_ROOT}" ] && command -v jq >/dev/null 2>&1; then
  INSTALL_ROOT=$(arcus doctor --json 2>/dev/null | jq -r '(.probes[]? | select(.id=="host-runtime") | .details) // empty' | sed -n 's/.*install directory ready (\([^)]*\)).*/\1/p' || true)
fi

if [ -z "${INSTALL_ROOT}" ]; then
  case "$(uname -s)" in
    Darwin)
      INSTALL_ROOT="${HOME}/Applications/Arcus"
      if [ ! -d "${INSTALL_ROOT}" ] && [ -d "${HOME}/Library/Application Support/Arcus/games" ]; then
        INSTALL_ROOT="${HOME}/Library/Application Support/Arcus/games"
      fi
      ;;
    *)
      INSTALL_ROOT="${HOME}/.local/share/arcus/packages"
      if [ ! -d "${INSTALL_ROOT}" ] && [ -d "${HOME}/.local/share/arcus/games" ]; then
        INSTALL_ROOT="${HOME}/.local/share/arcus/games"
      fi
      ;;
  esac
fi

PUBLISHER_ROOT="${INSTALL_ROOT}/arcus-publisher"

# Bind to the stable 'current' pointer, never to a tree_instance_id.
#
# managed_tree_path embeds a tree_instance_id that is regenerated on every
# activation, so a link built from it keeps resolving the sequence that was
# active at bootstrap time and silently survives later updates as a stale
# toolchain. 'current' is rewritten by each activation, so the link tracks
# whatever is active without re-running this script.
PUBLISHER_DIR="${PUBLISHER_ROOT}/.arcus/current"
if [ ! -d "${PUBLISHER_DIR}" ]; then
  # Fallback for hosts that could not create the pointer (unprivileged Windows)
  # or for installs activated before the pointer existed.
  RECEIPT="${PUBLISHER_ROOT}/.arcus/receipt.json"
  PUBLISHER_DIR="${PUBLISHER_ROOT}"
  if [ -f "${RECEIPT}" ] && command -v jq >/dev/null 2>&1; then
    MANAGED_PATH=$(jq -r ".managed_tree_path // empty" "${RECEIPT}")
    if [ -n "${MANAGED_PATH}" ] && [ -d "${PUBLISHER_ROOT}/${MANAGED_PATH}" ]; then
      PUBLISHER_DIR="${PUBLISHER_ROOT}/${MANAGED_PATH}"
      echo "==> WARNING: no 'current' pointer; linking to ${MANAGED_PATH}."
      echo "    Re-run this script after each 'arcus install arcus-publisher'."
    fi
  fi
fi

# 4. Create toolchain symlink under packages/arcus
mkdir -p "${REPO_ROOT}/packages/arcus"
ln -sfn "${PUBLISHER_DIR}" "${REPO_ROOT}/packages/arcus/toolchain"

echo "==> Symlink created:"
echo "    packages/arcus/toolchain -> ${PUBLISHER_DIR}"

# 5. Validate installed toolchain if available
if [ -d "${REPO_ROOT}/packages/arcus/toolchain/scripts" ]; then
  arcus manifest verify-toolchain --root "${REPO_ROOT}/packages/arcus/toolchain/scripts"
fi

# 6. Ensure arcus.json exists and declares the canonical gateway endpoint
CONFIG_PATH=""
if [ -f "${REPO_ROOT}/packages/arcus/arcus.json" ]; then
  CONFIG_PATH="${REPO_ROOT}/packages/arcus/arcus.json"
elif [ -f "${REPO_ROOT}/arcus.json" ]; then
  CONFIG_PATH="${REPO_ROOT}/arcus.json"
fi

DEFAULT_GATEWAY="https://arcus-auth.rustybret.com"

if [ -z "${CONFIG_PATH}" ]; then
  CONFIG_PATH="${REPO_ROOT}/packages/arcus/arcus.json"
  PKG_NAME="$(basename "${REPO_ROOT}")"
  cat > "${CONFIG_PATH}" <<EOF
{
  "\$schema": "https://arcus.rustybret.com/schemas/arcus-project.schema.json",
  "package_id": "${PKG_NAME}",
  "software_type": "source_snapshot",
  "channel": "stable",
  "source_id": "arcus",
  "gateway": "${DEFAULT_GATEWAY}"
}
EOF
  echo "==> Scaffolded ${CONFIG_PATH} with gateway: ${DEFAULT_GATEWAY}"
elif command -v jq >/dev/null 2>&1; then
  GW_VAL=$(jq -r '.gateway // empty' "${CONFIG_PATH}" 2>/dev/null || true)
  if [ -z "${GW_VAL}" ]; then
    TMP_CFG=$(mktemp "${CONFIG_PATH}.tmp.XXXXXX")
    jq --arg gw "${DEFAULT_GATEWAY}" '. + {gateway: $gw}' "${CONFIG_PATH}" > "${TMP_CFG}" && mv "${TMP_CFG}" "${CONFIG_PATH}"
    echo "==> Configured gateway in ${CONFIG_PATH}: ${DEFAULT_GATEWAY}"
  fi
fi

echo "==> Arcus publisher bootstrap complete."
