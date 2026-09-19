#!/usr/bin/env bash
# ==============================================================================
# Anthropic Auth Repository Setup & Toolchain Bootstrap
# ==============================================================================
# Verifies toolchain readiness (Bun, Git), bootstraps the Arcus publisher toolchain,
# repairs Arcus script symlinks, and installs workspace dependencies.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"

cd "${REPO_ROOT}"

echo "======================================================================"
echo " Anthropic Auth Repository Setup & Toolchain Bootstrap"
echo "======================================================================"
echo ""

# ------------------------------------------------------------------------------
# 1. Check Toolchain Dependencies
# ------------------------------------------------------------------------------
echo "==> 1/4 Verifying toolchain dependencies..."

check_tool() {
  local tool="$1"
  local install_hint="$2"
  local required="${3:-1}"

  if command -v "${tool}" >/dev/null 2>&1; then
    local version_info
    version_info="$("${tool}" --version 2>/dev/null | head -n 1 || echo "installed")"
    echo "  ✓ ${tool}: ${version_info}"
  else
    if [[ "${required}" == "1" ]]; then
      echo "  ✗ Missing required tool: ${tool}" >&2
      echo "    Install hint: ${install_hint}" >&2
      exit 1
    else
      echo "  • Optional tool missing: ${tool} (${install_hint})"
    fi
  fi
}

check_tool "git" "https://git-scm.com" 1
check_tool "bun" "curl -fsSL https://bun.sh/install | bash" 1
check_tool "arcus" "Install Arcus CLI (optional; can resolve from local build or ARCUS_BIN)" 0
echo ""

# ------------------------------------------------------------------------------
# 2. Arcus Publisher Toolchain
# ------------------------------------------------------------------------------
echo "==> 2/4 Bootstrapping Arcus publisher toolchain..."
if [[ -f "${REPO_ROOT}/packages/arcus/bootstrap.sh" ]]; then
  sh "${REPO_ROOT}/packages/arcus/bootstrap.sh"
  echo "  ✓ Arcus publisher toolchain bootstrapped."
else
  echo "  • packages/arcus/bootstrap.sh not found; skipping."
fi

# Verify and repair Arcus script symlinks
ARCUS_SCRIPTS=(
  "arcus-pipeline.sh"
  "sign-arcus.sh"
  "validate-arcus.sh"
  "publish-arcus.sh"
  "migrate-arcus.sh"
  "arcus-toolchain.json"
)
for script_name in "${ARCUS_SCRIPTS[@]}"; do
  script_path="${REPO_ROOT}/scripts/${script_name}"
  target_path="${REPO_ROOT}/packages/arcus/toolchain/scripts/${script_name}"
  if [[ ! -L "${script_path}" || ! -e "${script_path}" ]]; then
    if [[ -f "${target_path}" ]]; then
      ln -sf "../packages/arcus/toolchain/scripts/${script_name}" "${script_path}"
      echo "  ✓ Repaired symlink: scripts/${script_name}"
    else
      echo "  ✗ Warning: Arcus upstream script ${target_path} not found." >&2
    fi
  fi
done
echo "  ✓ Arcus script symlinks verified."
echo ""

# ------------------------------------------------------------------------------
# 3. Install Workspace Dependencies
# ------------------------------------------------------------------------------
echo "==> 3/4 Installing workspace dependencies..."
bun install
echo "  ✓ Workspace dependencies installed."
echo ""

# ------------------------------------------------------------------------------
# 4. Build Workspace Packages
# ------------------------------------------------------------------------------
echo "==> 4/4 Building workspace packages..."
bun run build
echo "  ✓ Workspace packages built."
echo ""

echo "======================================================================"
echo " Anthropic Auth workspace setup complete and ready for development."
echo " Commands:"
echo "   bun run test             Run workspace test suites"
echo "   bun run build            Build all workspace packages"
echo "   bun run pipeline:arcus   Run Arcus v2 packaging pipeline"
echo "   bun run pack:arcus       Package distribution for Arcus"
echo "======================================================================"
