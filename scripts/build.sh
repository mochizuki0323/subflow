#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Building SubFlow ==="

# Ensure vendored deps (uWebSockets/uSockets + nlohmann/json + Boost headers) are present
if [[ ! -f "$PROJECT_DIR/extern/uWebSockets/uSockets/src/libusockets.h" ]] \
    || [[ ! -f "$PROJECT_DIR/extern/nlohmann/json.hpp" ]] \
    || [[ ! -f "$PROJECT_DIR/extern/boost/include/boost/beast.hpp" ]]; then
    bash "$SCRIPT_DIR/setup-deps.sh"
fi

# Build C++ backend
echo "--- Building C++ backend ---"
cd "$PROJECT_DIR"
CC=/usr/bin/clang CXX=/usr/bin/clang++ cmake -B build
cmake --build build -j$(nproc)

# Build frontend
echo "--- Building frontend ---"
npm run build:frontend

echo "=== Build complete ==="
echo "Backend: build/bin/subflow-backend"
echo "Frontend: dist/"
echo ""
echo "Run with: npm start"
