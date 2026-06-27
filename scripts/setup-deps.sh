#!/usr/bin/env bash
# Fetch the repo's vendored C++ dependencies into extern/.
#
# The entire extern/ directory is gitignored — nothing under it is committed;
# this script reproduces it from upstream, each dep pinned to a fixed version:
#
#   - extern/uWebSockets : git clone pinned to a release tag, + its uSockets dep
#   - extern/nlohmann    : nlohmann/json single header (downloaded)
#   - extern/boost       : header-only Boost subset (downloaded release tarball)
#
# sherpa-onnx is fetched separately by scripts/setup-sherpa-onnx.sh (it is
# platform-specific and called with different targets).
#
# Idempotent: each dep is skipped when already present at its pinned version.
# The build scripts call this automatically when a dep is missing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTERN="${ROOT}/extern"
mkdir -p "$EXTERN"

# ── uWebSockets (+ uSockets) ──────────────────────────────────────────────────
UWS_VERSION="v20.76.0"
UWS_DIR="${EXTERN}/uWebSockets"
UWS_MARKER="${UWS_DIR}/.subflow-version"
if [[ -f "$UWS_MARKER" ]] && [[ "$(cat "$UWS_MARKER")" == "$UWS_VERSION" ]]; then
    echo "uWebSockets ${UWS_VERSION} already present at ${UWS_DIR}"
else
    echo "Cloning uWebSockets ${UWS_VERSION} ..."
    rm -rf "$UWS_DIR"
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$UWS_VERSION" \
        https://github.com/uNetworking/uWebSockets.git "$UWS_DIR"
    # Only uSockets is needed to build — the fuzzing / h1spec / libdeflate nested
    # submodules are not, so we init uSockets explicitly (not --recursive).
    echo "Fetching uSockets (uWebSockets' dependency) ..."
    git -C "$UWS_DIR" submodule update --init --quiet uSockets
    echo "$UWS_VERSION" > "$UWS_MARKER"
    echo "uWebSockets ${UWS_VERSION} ready."
fi

# ── nlohmann/json (single header, downloaded) ─────────────────────────────────
NLOHMANN_VERSION="v3.11.3"
NLOHMANN_DIR="${EXTERN}/nlohmann"
NLOHMANN_HDR="${NLOHMANN_DIR}/json.hpp"
NLOHMANN_MARKER="${NLOHMANN_DIR}/.version"
NLOHMANN_URL="https://github.com/nlohmann/json/releases/download/${NLOHMANN_VERSION}/json.hpp"
if [[ -f "$NLOHMANN_HDR" ]] && [[ -f "$NLOHMANN_MARKER" ]] && [[ "$(cat "$NLOHMANN_MARKER")" == "$NLOHMANN_VERSION" ]]; then
    echo "nlohmann/json ${NLOHMANN_VERSION} header already present at ${NLOHMANN_HDR}"
else
    echo "Downloading nlohmann/json ${NLOHMANN_VERSION} single header ..."
    mkdir -p "$NLOHMANN_DIR"
    curl -L --fail --progress-bar -o "$NLOHMANN_HDR" "$NLOHMANN_URL"
    echo "$NLOHMANN_VERSION" > "$NLOHMANN_MARKER"
    echo "nlohmann/json ${NLOHMANN_VERSION} ready."
fi

# ── Boost headers (header-only subset, downloaded tarball) ─────────────────────
# Boost has no single git repo with a ready-to-use header tree (the superproject
# is ~166 nested submodules + a `b2 headers` generation step), so we pull the
# pre-assembled boost/ subtree from the official release tarball. Boost.Beast +
# Boost.Asio + Boost.System are header-only, so the same headers serve both the
# native Linux build and the MinGW Windows cross-compile.
BOOST_VERSION="1.86.0"
BOOST_USCORE="boost_${BOOST_VERSION//./_}"   # boost_1_86_0
BOOST_URL="https://archives.boost.io/release/${BOOST_VERSION}/source/${BOOST_USCORE}.tar.bz2"
BOOST_INCLUDE_DIR="${EXTERN}/boost/include"
BOOST_MARKER="${BOOST_INCLUDE_DIR}/.version"
if [[ -f "$BOOST_MARKER" ]] && [[ "$(cat "$BOOST_MARKER")" == "$BOOST_VERSION" ]]; then
    echo "Boost ${BOOST_VERSION} headers already present at ${BOOST_INCLUDE_DIR}/boost"
else
    echo "Downloading Boost ${BOOST_VERSION} (${BOOST_USCORE}.tar.bz2, headers only) ..."
    BOOST_TMP="$(mktemp -d)"
    trap 'rm -rf "$BOOST_TMP"' EXIT
    curl -L --fail --progress-bar -o "${BOOST_TMP}/boost.tar.bz2" "$BOOST_URL"
    echo "Extracting boost/ header tree ..."
    # Extract only the header directory to avoid unpacking the full ~1GB source tree.
    tar xjf "${BOOST_TMP}/boost.tar.bz2" -C "$BOOST_TMP" "${BOOST_USCORE}/boost"
    mkdir -p "$BOOST_INCLUDE_DIR"
    rm -rf "${BOOST_INCLUDE_DIR}/boost"
    mv "${BOOST_TMP}/${BOOST_USCORE}/boost" "${BOOST_INCLUDE_DIR}/boost"
    echo "${BOOST_VERSION}" > "$BOOST_MARKER"
    echo "Boost ${BOOST_VERSION} headers ready ($(du -sh "${BOOST_INCLUDE_DIR}/boost" 2>/dev/null | cut -f1))."
fi

echo "All extern/ dependencies ready."
