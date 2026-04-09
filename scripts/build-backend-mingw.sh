#!/usr/bin/env bash
# Build subflow-backend.exe on Linux using MinGW-w64 (Windows x64 target).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v x86_64-w64-mingw32-g++ &>/dev/null; then
    echo "x86_64-w64-mingw32-g++ not found. Please install the MinGW-w64 cross compiler:"
    echo "  Fedora: sudo dnf install mingw64-gcc-c++ mingw64-winpthreads-static"
    echo "  Debian/Ubuntu: sudo apt install g++-mingw-w64-x86-64"
    exit 1
fi

if [[ -n "${MINGW_SYSROOT:-}" ]]; then
    :
elif [[ -d /usr/x86_64-w64-mingw32/sys-root/mingw ]]; then
    MINGW_SYSROOT=/usr/x86_64-w64-mingw32/sys-root/mingw
elif [[ -d /usr/x86_64-w64-mingw32 ]]; then
    MINGW_SYSROOT=/usr/x86_64-w64-mingw32
else
    echo "Cannot determine MinGW sysroot. Set MINGW_SYSROOT to the directory containing include/openssl and lib/."
    exit 1
fi

if [[ ! -f "${MINGW_SYSROOT}/include/openssl/opensslv.h" ]] && [[ ! -f "${MINGW_SYSROOT}/include/openssl/ssl.h" ]]; then
    echo "OpenSSL headers not found in ${MINGW_SYSROOT}."
    echo "Please install the MinGW OpenSSL development package:"
    echo "  Fedora: sudo dnf install mingw64-openssl mingw64-openssl-static"
    exit 1
fi

BUILD_DIR="${ROOT}/build-mingw"
TOOLCHAIN="${ROOT}/cmake/mingw-w64-toolchain.cmake"

# OPENSSL_STATIC options:
#   auto (default): use static when static OpenSSL + libz.a are available, else fall back to dynamic
#   ON: force static OpenSSL
#   OFF: force dynamic OpenSSL
: "${OPENSSL_STATIC:=auto}"
OPENSSL_USE_STATIC="OFF"
if [[ "${OPENSSL_STATIC}" == "ON" || "${OPENSSL_STATIC}" == "on" || "${OPENSSL_STATIC}" == "1" ]]; then
    OPENSSL_USE_STATIC="ON"
elif [[ "${OPENSSL_STATIC}" == "OFF" || "${OPENSSL_STATIC}" == "off" || "${OPENSSL_STATIC}" == "0" ]]; then
    OPENSSL_USE_STATIC="OFF"
else
    if [[ -f "${MINGW_SYSROOT}/lib/libssl.a" && -f "${MINGW_SYSROOT}/lib/libcrypto.a" && -f "${MINGW_SYSROOT}/lib/libz.a" ]]; then
        OPENSSL_USE_STATIC="ON"
    else
        OPENSSL_USE_STATIC="OFF"
    fi
fi

echo "OpenSSL link mode: ${OPENSSL_USE_STATIC} (OPENSSL_STATIC=${OPENSSL_STATIC})"

cmake -S "$ROOT" -B "$BUILD_DIR" \
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" \
    -DMINGW_SYSROOT="${MINGW_SYSROOT}" \
    -DOPENSSL_ROOT_DIR="${MINGW_SYSROOT}" \
    -DOPENSSL_USE_STATIC_LIBS="${OPENSSL_USE_STATIC}" \
    -DCMAKE_BUILD_TYPE=Release

# Limit parallel jobs to avoid OOM when MinGW/libuv/host compile concurrently. Override with BUILD_JOBS=4
: "${BUILD_JOBS:=2}"
if ! [[ "${BUILD_JOBS}" =~ ^[0-9]+$ ]] || [[ "${BUILD_JOBS}" -lt 1 ]]; then
    BUILD_JOBS=2
fi
NPROC="$(nproc 2>/dev/null || echo 4)"
if [[ "${BUILD_JOBS}" -gt "${NPROC}" ]]; then
    BUILD_JOBS="${NPROC}"
fi
echo "Parallel build jobs: ${BUILD_JOBS} (set BUILD_JOBS to override)"
cmake --build "$BUILD_DIR" --parallel "${BUILD_JOBS}"

echo ""
echo "Built: ${BUILD_DIR}/bin/subflow-backend.exe"
echo "To package with Electron: npm run dist:win:linux (copies this exe to build/bin/ first)"
