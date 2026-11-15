#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

OUT_DIR="${HOME}/Applications"
UNIVERSAL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      if [[ $# -lt 2 ]]; then
        echo "Error: --out requires a directory path" >&2
        exit 1
      fi
      OUT_DIR="$2"
      shift 2
      ;;
    --universal)
      UNIVERSAL=true
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--out <output-dir>] [--universal]"
      exit 0
      ;;
    *)
      echo "Error: Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# Expand leading ~ if passed explicitly
OUT_DIR="${OUT_DIR/#\~/$HOME}"
mkdir -p "${OUT_DIR}"

APP_PATH="${OUT_DIR}/ContextLensBar.app"
STAGE_PATH="${OUT_DIR}/.ContextLensBar.app.staging.$$"
trap 'rm -rf "${STAGE_PATH}"' EXIT
rm -rf "${STAGE_PATH}"

CONTENTS="${STAGE_PATH}/Contents"
MACOS_DIR="${CONTENTS}/MacOS"
RES_DIR="${CONTENTS}/Resources"
mkdir -p "${MACOS_DIR}" "${RES_DIR}/scripts" "${RES_DIR}/sidecars/dashboard"

cp "${SCRIPT_DIR}/Info.plist" "${CONTENTS}/Info.plist"
cp \
  "${PLUGIN_ROOT}/scripts/analyzer.mjs" \
  "${PLUGIN_ROOT}/scripts/cli-quota-sync.mjs" \
  "${PLUGIN_ROOT}/scripts/quota.mjs" \
  "${RES_DIR}/scripts/"
cp \
  "${PLUGIN_ROOT}/sidecars/dashboard/main.mjs" \
  "${PLUGIN_ROOT}/sidecars/dashboard/index.html" \
  "${PLUGIN_ROOT}/sidecars/dashboard/styles.css" \
  "${PLUGIN_ROOT}/sidecars/dashboard/app.js" \
  "${RES_DIR}/sidecars/dashboard/"

SWIFT_FRAMEWORKS=(-swift-version 5 -O -framework AppKit -framework SwiftUI)

if [[ "${UNIVERSAL}" == "true" ]]; then
  echo "[context-lens] Compiling ContextLensBar (Universal: arm64 + x86_64)..."
  /usr/bin/swiftc "${SWIFT_FRAMEWORKS[@]}" -target arm64-apple-macos13.0 "${SCRIPT_DIR}/ContextLensBar.swift" -o "${MACOS_DIR}/ContextLensBar.arm64"
  /usr/bin/swiftc "${SWIFT_FRAMEWORKS[@]}" -target x86_64-apple-macos13.0 "${SCRIPT_DIR}/ContextLensBar.swift" -o "${MACOS_DIR}/ContextLensBar.x86_64"
  /usr/bin/lipo -create -output "${MACOS_DIR}/ContextLensBar" "${MACOS_DIR}/ContextLensBar.arm64" "${MACOS_DIR}/ContextLensBar.x86_64"
  rm -f "${MACOS_DIR}/ContextLensBar.arm64" "${MACOS_DIR}/ContextLensBar.x86_64"
else
  HOST_ARCH="$(uname -m)"
  if [[ "${HOST_ARCH}" != "arm64" && "${HOST_ARCH}" != "x86_64" ]]; then
    echo "Error: Unsupported macOS architecture: ${HOST_ARCH}" >&2
    exit 1
  fi
  echo "[context-lens] Compiling ContextLensBar (${HOST_ARCH})..."
  /usr/bin/swiftc "${SWIFT_FRAMEWORKS[@]}" -target "${HOST_ARCH}-apple-macos13.0" "${SCRIPT_DIR}/ContextLensBar.swift" -o "${MACOS_DIR}/ContextLensBar"
fi

chmod +x "${MACOS_DIR}/ContextLensBar"

rm -rf "${APP_PATH}"
mv "${STAGE_PATH}" "${APP_PATH}"

echo "[context-lens] Signing app bundle (ad-hoc)..."
codesign --force --deep --sign - "${APP_PATH}"

echo "[context-lens] Built: ${APP_PATH}"
