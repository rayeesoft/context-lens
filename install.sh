#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_NAME="context-lens"
PLUGIN_DEST="${HOME}/.gemini/config/plugins/${PLUGIN_NAME}"
PLIST_PATH="${HOME}/Library/LaunchAgents/dev.contextlens.menubar.plist"
APP_PATH="${HOME}/Applications/ContextLensBar.app"

WITH_MENUBAR=true
LAUNCH_APP=true
UNIVERSAL=false
UNINSTALL=false

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --no-menubar    Install Antigravity plugin only (skip building ContextLensBar.app)
  --no-launch     Build ContextLensBar.app without launching it afterward
  --universal     Build Universal macOS binary (arm64 + x86_64)
  --uninstall     Uninstall plugin, LaunchAgent, and ContextLensBar.app
  -h, --help      Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-menubar)
      WITH_MENUBAR=false
      shift
      ;;
    --no-launch)
      LAUNCH_APP=false
      shift
      ;;
    --universal)
      UNIVERSAL=true
      shift
      ;;
    --uninstall)
      UNINSTALL=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

find_agy() {
  local candidates=(
    "${HOME}/.local/bin/agy"
    "$(command -v agy 2>/dev/null || true)"
    "/opt/homebrew/bin/agy"
    "/usr/local/bin/agy"
  )
  for c in "${candidates[@]}"; do
    if [[ -n "$c" && -x "$c" ]]; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

if [[ "$UNINSTALL" == "true" ]]; then
  echo "[context-lens] Stopping ContextLensBar (if running)..."
  pkill -x ContextLensBar 2>/dev/null || true

  if [[ -f "$PLIST_PATH" ]]; then
    if command -v launchctl >/dev/null 2>&1; then
      launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
    fi
    rm -f "$PLIST_PATH"
    echo "[context-lens] Removed LaunchAgent: $PLIST_PATH"
  fi

  if [[ -d "$APP_PATH" ]]; then
    rm -rf "$APP_PATH"
    echo "[context-lens] Removed menu bar app: $APP_PATH"
  fi

  if AGY_BIN="$(find_agy)"; then
    echo "[context-lens] Uninstalling plugin via agy CLI..."
    "$AGY_BIN" plugin uninstall "$PLUGIN_NAME" || rm -rf "$PLUGIN_DEST"
  elif [[ -d "$PLUGIN_DEST" ]]; then
    rm -rf "$PLUGIN_DEST"
    echo "[context-lens] Removed plugin directory: $PLUGIN_DEST"
  fi

  echo "[context-lens] Uninstall complete."
  echo "Note: User configuration and quota caches under ~/.gemini/antigravity/plugin_data/${PLUGIN_NAME} were preserved."
  exit 0
fi

# 1. Verify Node.js >= 22.5
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js (>= 22.5) is required but was not found in PATH." >&2
  echo "Install via Homebrew: brew install node" >&2
  exit 1
fi

if ! node -e 'const [maj, min] = process.versions.node.split(".").map(Number); process.exit(maj > 22 || (maj === 22 && min >= 5) ? 0 : 1)'; then
  NODE_VER="$(node -v)"
  echo "Error: Node.js ${NODE_VER} is too old. Context Lens requires Node.js >= 22.5 (for built-in node:sqlite)." >&2
  echo "Upgrade via Homebrew: brew install node" >&2
  exit 1
fi

echo "[context-lens] Using Node.js $(node -v)"

# 2. Validate & install Antigravity plugin
if AGY_BIN="$(find_agy)"; then
  echo "[context-lens] Validating plugin with ${AGY_BIN}..."
  "$AGY_BIN" plugin validate "$REPO_ROOT" --strict
  echo "[context-lens] Installing plugin via agy CLI..."
  "$AGY_BIN" plugin install "$REPO_ROOT"
else
  echo "[context-lens] agy CLI not found; installing plugin files directly to ${PLUGIN_DEST}..."
  rm -rf "$PLUGIN_DEST"
  mkdir -p "$PLUGIN_DEST"
  cp "${REPO_ROOT}/plugin.json" "${REPO_ROOT}/hooks.json" "${REPO_ROOT}/README.md" "$PLUGIN_DEST/"
  cp -R "${REPO_ROOT}/assets" "${REPO_ROOT}/scripts" "${REPO_ROOT}/sidecars" "${REPO_ROOT}/skills" "$PLUGIN_DEST/"
  echo "[context-lens] Tip: Install and sign in to Antigravity CLI (agy) to enable automatic official cloud quota sync."
fi

# 3. Build & launch macOS menu bar app
if [[ "$(uname -s)" == "Darwin" && "$WITH_MENUBAR" == "true" ]]; then
  if ! command -v swiftc >/dev/null 2>&1 && [[ ! -x /usr/bin/swiftc ]]; then
    echo "Error: Xcode Command Line Tools (swiftc) not found." >&2
    echo "Run 'xcode-select --install', download prebuilt ContextLensBar from GitHub Releases, or rerun with --no-menubar." >&2
    exit 1
  fi

  BUILD_ARGS=()
  if [[ "$UNIVERSAL" == "true" ]]; then
    BUILD_ARGS+=(--universal)
  fi

  bash "${REPO_ROOT}/menubar/build.sh" "${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}"
  xattr -cr "$APP_PATH" 2>/dev/null || true

  if [[ "$LAUNCH_APP" == "true" ]]; then
    echo "[context-lens] Starting ContextLensBar.app..."
    pkill -x ContextLensBar 2>/dev/null || true
    sleep 0.2
    open -a "$APP_PATH"
  fi
fi

echo "[context-lens] Done."
