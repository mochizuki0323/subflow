#!/usr/bin/env bash
# Build the standalone Parakeet inference server (Linux x64).
#
# Prerequisite: the repo's vendored sherpa-onnx must be set up:
#   ./scripts/setup-sherpa-onnx.sh linux-x64
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$ROOT/.." && pwd)"

if [[ ! -f "$REPO_ROOT/extern/sherpa-onnx/include/sherpa-onnx/c-api/c-api.h" ]]; then
    echo "sherpa-onnx is not set up."
    echo "Run: $REPO_ROOT/scripts/setup-sherpa-onnx.sh linux-x64"
    exit 1
fi

BUILD_DIR="$ROOT/build"
: "${BUILD_JOBS:=$(nproc 2>/dev/null || echo 4)}"

cmake -S "$ROOT" -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD_DIR" --parallel "$BUILD_JOBS"

echo ""
echo "Built: $BUILD_DIR/bin/subflow-parakeet-server"
echo "Run:   $BUILD_DIR/bin/subflow-parakeet-server --help"
