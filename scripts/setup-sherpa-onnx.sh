#!/usr/bin/env bash
# Download pre-built sherpa-onnx libraries and headers for the target platform.
# Usage:
#   ./scripts/setup-sherpa-onnx.sh              # auto-detect (native Linux)
#   ./scripts/setup-sherpa-onnx.sh linux-x64     # explicit target
#   ./scripts/setup-sherpa-onnx.sh win-x64       # Windows x64 (for MinGW cross-compile)
set -euo pipefail

SHERPA_ONNX_VERSION="1.13.4"
SHERPA_ONNX_TAG="v${SHERPA_ONNX_VERSION}"
GITHUB_RELEASE="https://github.com/k2-fsa/sherpa-onnx/releases/download/${SHERPA_ONNX_TAG}"
GITHUB_RAW="https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/${SHERPA_ONNX_TAG}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${ROOT}/extern/sherpa-onnx"

# ── Determine target ──────────────────────────────────────────────────────────
TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
    case "$(uname -s)-$(uname -m)" in
        Linux-x86_64)  TARGET="linux-x64" ;;
        Linux-aarch64) TARGET="linux-aarch64" ;;
        *)
            echo "Cannot auto-detect target for $(uname -s)-$(uname -m)."
            echo "Usage: $0 <linux-x64|linux-aarch64|win-x64>"
            exit 1
            ;;
    esac
fi

echo "Target: ${TARGET}"
echo "sherpa-onnx version: ${SHERPA_ONNX_VERSION}"

# ── Package names ─────────────────────────────────────────────────────────────
case "$TARGET" in
    linux-x64)
        PACKAGE="sherpa-onnx-${SHERPA_ONNX_TAG}-linux-x64-static-no-tts-lib.tar.bz2"
        EXTRACTED_DIR="sherpa-onnx-${SHERPA_ONNX_TAG}-linux-x64-static-no-tts-lib"
        LIB_SUBDIR="lib/linux-x64"
        ;;
    linux-aarch64)
        PACKAGE="sherpa-onnx-${SHERPA_ONNX_TAG}-linux-aarch64-static-no-tts-lib.tar.bz2"
        EXTRACTED_DIR="sherpa-onnx-${SHERPA_ONNX_TAG}-linux-aarch64-static-no-tts-lib"
        LIB_SUBDIR="lib/linux-aarch64"
        ;;
    win-x64)
        PACKAGE="sherpa-onnx-${SHERPA_ONNX_TAG}-win-x64-shared-MD-Release-no-tts-lib.tar.bz2"
        EXTRACTED_DIR="sherpa-onnx-${SHERPA_ONNX_TAG}-win-x64-shared-MD-Release-no-tts-lib"
        LIB_SUBDIR="lib/win-x64"
        ;;
    *)
        echo "Unknown target: ${TARGET}"
        echo "Supported: linux-x64, linux-aarch64, win-x64"
        exit 1
        ;;
esac

# ── Skip if already set up ────────────────────────────────────────────────────
MARKER="${DEST}/${LIB_SUBDIR}/.version"
if [[ -f "$MARKER" ]] && [[ "$(cat "$MARKER")" == "$SHERPA_ONNX_VERSION" ]]; then
    echo "sherpa-onnx ${SHERPA_ONNX_VERSION} for ${TARGET} already set up at ${DEST}/${LIB_SUBDIR}"
    exit 0
fi

# ── Download and extract libraries ────────────────────────────────────────────
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

echo "Downloading ${PACKAGE}..."
curl -L --fail --progress-bar -o "${TMPDIR}/${PACKAGE}" "${GITHUB_RELEASE}/${PACKAGE}"

echo "Extracting libraries..."
tar xjf "${TMPDIR}/${PACKAGE}" -C "$TMPDIR"

mkdir -p "${DEST}/${LIB_SUBDIR}"
cp -f "${TMPDIR}/${EXTRACTED_DIR}/lib/"* "${DEST}/${LIB_SUBDIR}/"

# Remove portaudio (we don't use it)
rm -f "${DEST}/${LIB_SUBDIR}/libsherpa-onnx-portaudio"*

echo "${SHERPA_ONNX_VERSION}" > "$MARKER"

# ── Download headers ──────────────────────────────────────────────────────────
INCLUDE_DIR="${DEST}/include/sherpa-onnx/c-api"
if [[ ! -f "${INCLUDE_DIR}/c-api.h" ]] || ! grep -q "${SHERPA_ONNX_VERSION}" "${INCLUDE_DIR}/.version" 2>/dev/null; then
    echo "Downloading headers..."
    mkdir -p "$INCLUDE_DIR"
    curl -sL --fail -o "${INCLUDE_DIR}/c-api.h" "${GITHUB_RAW}/sherpa-onnx/c-api/c-api.h"
    echo "${SHERPA_ONNX_VERSION}" > "${INCLUDE_DIR}/.version"
fi

# ── For Windows MinGW: generate import libraries from DLLs ───────────────────
if [[ "$TARGET" == "win-x64" ]]; then
    DLLTOOL="x86_64-w64-mingw32-dlltool"
    OBJDUMP="x86_64-w64-mingw32-objdump"
    GENDEF="x86_64-w64-mingw32-gendef"

    generate_implib_from_dll() {
        local dll="$1"
        local defname="${dll%.dll}.def"
        local implib="lib${dll%.dll}.dll.a"

        # Method 1: gendef (best, if available)
        if command -v "$GENDEF" &>/dev/null; then
            "$GENDEF" "$dll" 2>/dev/null
            if [[ -f "$defname" ]]; then
                "$DLLTOOL" -d "$defname" -l "$implib" -D "$dll"
                rm -f "$defname"
                echo "  Generated ${implib} (via gendef)"
                return 0
            fi
        fi

        # Method 2: objdump + dlltool
        if command -v "$OBJDUMP" &>/dev/null; then
            {
                echo "LIBRARY ${dll}"
                echo "EXPORTS"
                "$OBJDUMP" -p "$dll" 2>/dev/null \
                    | sed -n '/\[Ordinal\/Name Pointer\] Table/,/^$/p' \
                    | grep '+base' \
                    | sed 's/.* //'
            } > "$defname"
            if [[ -s "$defname" ]]; then
                "$DLLTOOL" -d "$defname" -l "$implib" -D "$dll"
                rm -f "$defname"
                echo "  Generated ${implib} (via objdump)"
                return 0
            fi
            rm -f "$defname"
        fi

        return 1
    }

    if command -v "$DLLTOOL" &>/dev/null; then
        echo "Generating MinGW import libraries..."
        pushd "${DEST}/${LIB_SUBDIR}" >/dev/null
        for dll in sherpa-onnx-c-api.dll onnxruntime.dll onnxruntime_providers_shared.dll; do
            if [[ -f "$dll" ]]; then
                generate_implib_from_dll "$dll" || echo "  Warning: could not generate import lib for ${dll}"
            fi
        done
        popd >/dev/null
    else
        echo "Warning: ${DLLTOOL} not found. MinGW will attempt direct DLL linking."
    fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "sherpa-onnx ${SHERPA_ONNX_VERSION} set up for ${TARGET}:"
echo "  Headers:   ${DEST}/include/"
echo "  Libraries: ${DEST}/${LIB_SUBDIR}/"
ls -lh "${DEST}/${LIB_SUBDIR}/" | grep -v '^total' | grep -v '.version'
