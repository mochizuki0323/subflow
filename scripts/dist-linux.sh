#!/usr/bin/env bash
# Build and package SubFlow for Linux (AppImage + deb + rpm).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "=== SubFlow Linux distribution build ==="

# 1. Build C++ backend
echo "--- Building C++ backend ---"
CC=/usr/bin/clang CXX=/usr/bin/clang++ cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel "$(nproc)"

# 2. Build frontend (TypeScript + Vite)
echo "--- Building frontend ---"
npm run build:frontend

# 3. CA bundle into build/bin (same as CI / dist-windows; optional for TLS, satisfies extraResources filter)
if [[ ! -f data/cacert.pem ]]; then
  echo "--- Downloading cacert.pem ---"
  mkdir -p data
  curl -fSL -o data/cacert.pem https://curl.se/ca/cacert.pem
fi
mkdir -p build/bin
cp -f data/cacert.pem build/bin/cacert.pem

# 4. Package with electron-builder (.rpm needs system rpmbuild, not only bundled fpm)
if ! command -v rpmbuild &>/dev/null; then
  echo "ERROR: rpmbuild not found (required to build .rpm)."
  echo "  Fedora/RHEL: sudo dnf install rpm-build"
  echo "  Debian/Ubuntu: sudo apt install rpm"
  exit 1
fi

echo "--- Packaging (AppImage + deb + rpm) ---"
npx electron-builder --linux AppImage deb rpm

# 5. Rename artifacts
node scripts/rename-release-artifacts.js 2>/dev/null || true

echo ""
echo "=== Done! Artifacts in release/ ==="
ls -lh release/*.AppImage release/*.deb release/*.rpm 2>/dev/null || true
