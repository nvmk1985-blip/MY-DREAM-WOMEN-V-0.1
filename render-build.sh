#!/bin/bash
set -e

echo ">>> Node: $(node --version), npm: $(npm --version)"

# Use system pnpm if available, otherwise install to writable user dir
if command -v pnpm &>/dev/null; then
  echo ">>> Using system pnpm: $(pnpm --version)"
  PNPM="pnpm"
else
  echo ">>> pnpm not found — installing to $HOME/.npm-global"
  npm install -g pnpm --prefix "$HOME/.npm-global"
  PNPM="$HOME/.npm-global/bin/pnpm"
  echo ">>> Installed pnpm: $($PNPM --version)"
fi

echo ">>> Installing workspace dependencies..."
$PNPM install --frozen-lockfile

echo ">>> Building API server..."
$PNPM --filter @workspace/api-server run build

echo ">>> Build complete!"
