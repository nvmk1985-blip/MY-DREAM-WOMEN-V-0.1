#!/bin/bash
# Render build script — dist is pre-built and committed to git
# All dependencies are bundled by esbuild (no runtime npm install needed)
# Built: 2026-06-12 13:00 UTC
set -e
echo "==> Node: $(node --version)"
echo "==> Pre-built dist:"
ls -lh artifacts/api-server/dist/
echo "==> Render build complete"
