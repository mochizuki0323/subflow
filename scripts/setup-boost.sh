#!/usr/bin/env bash
# Vendor a header-only subset of Boost (just the `boost/` include tree) into
# extern/boost/include. Boost.Beast + Boost.Asio + Boost.System are all
# header-only, so the same headers serve both the native Linux build and the
# MinGW Windows cross-compile — no compiled Boost libraries are needed.
#
# Usage: ./scripts/setup-boost.sh
set -euo pipefail

BOOST_VERSION="1.86.0"
BOOST_USCORE="boost_${BOOST_VERSION//./_}"   # boost_1_86_0
BOOST_URL="https://archives.boost.io/release/${BOOST_VERSION}/source/${BOOST_USCORE}.tar.bz2"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${ROOT}/extern/boost"
INCLUDE_DIR="${DEST}/include"
MARKER="${INCLUDE_DIR}/.version"

# ── Skip if already set up ────────────────────────────────────────────────────
if [[ -f "$MARKER" ]] && [[ "$(cat "$MARKER")" == "$BOOST_VERSION" ]]; then
    echo "Boost ${BOOST_VERSION} headers already set up at ${INCLUDE_DIR}/boost"
    exit 0
fi

echo "Boost version: ${BOOST_VERSION}"
echo "Downloading ${BOOST_USCORE}.tar.bz2 (headers only will be kept)..."

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

curl -L --fail --progress-bar -o "${TMPDIR}/boost.tar.bz2" "$BOOST_URL"

echo "Extracting boost/ header tree..."
# Extract only the header directory to avoid unpacking the full ~1GB source tree.
tar xjf "${TMPDIR}/boost.tar.bz2" -C "$TMPDIR" "${BOOST_USCORE}/boost"

mkdir -p "$INCLUDE_DIR"
rm -rf "${INCLUDE_DIR}/boost"
mv "${TMPDIR}/${BOOST_USCORE}/boost" "${INCLUDE_DIR}/boost"

echo "${BOOST_VERSION}" > "$MARKER"

echo ""
echo "Boost ${BOOST_VERSION} headers set up:"
echo "  Headers: ${INCLUDE_DIR}/boost"
echo "  Size:    $(du -sh "${INCLUDE_DIR}/boost" 2>/dev/null | cut -f1)"
