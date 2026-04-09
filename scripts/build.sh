#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Building SubFlow ==="

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
