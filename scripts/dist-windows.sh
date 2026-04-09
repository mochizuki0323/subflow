#!/usr/bin/env bash
# Cross-compile and package SubFlow for Windows (portable exe + zip archive) from Linux.
# Requires: MinGW-w64 cross compiler, OpenSSL for MinGW
#   Fedora: sudo dnf install mingw64-gcc-c++ mingw64-openssl mingw64-winpthreads-static
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "=== SubFlow Windows cross-compilation build ==="

# 1. Ensure cacert.pem exists (required for Deepgram TLS on Windows)
if [[ ! -f data/cacert.pem ]]; then
    echo "--- Downloading cacert.pem ---"
    mkdir -p data
    curl -fSL -o data/cacert.pem https://curl.se/ca/cacert.pem
fi

# 2. Build Windows backend via MinGW
echo "--- Building C++ backend (MinGW) ---"
OPENSSL_STATIC=1 bash scripts/build-backend-mingw.sh

# 3. Sync MinGW exe + DLLs to build/bin
echo "--- Syncing MinGW artifacts ---"
bash scripts/sync-mingw-exe-to-build-bin.sh

# 4. Build frontend (TypeScript + Vite)
echo "--- Building frontend ---"
npm run build:frontend

# 5. Package with electron-builder (Windows portable + zip)
echo "--- Packaging (Windows portable + zip) ---"
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win portable zip --x64

# 6. Rename artifacts
node scripts/rename-release-artifacts.js 2>/dev/null || true

echo ""
echo "=== Done! Artifacts in release/ ==="
ls -lh release/*.exe release/*.zip 2>/dev/null || true
