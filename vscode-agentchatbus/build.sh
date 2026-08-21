#!/bin/bash
# AgentChatBus Extension Builder (Linux/macOS)
# Usage: ./build.sh [patch|minor|major|none]

set -e

# Change to the directory of this script
cd "$(dirname "$0")"

echo "========================================"
echo "  AgentChatBus Extension Builder"
echo "========================================"
echo

# Check for package.json to see if we are in the right folder
if [ ! -f "package.json" ]; then
    echo "[ERROR] package.json not found. Please ensure this script is in the vscode-agentchatbus root folder."
    exit 1
fi

# Execute the build script
echo "[INFO] Starting build and packaging process..."
echo

BUMP=${1:-patch}
bash scripts/build.sh "$BUMP"

echo
echo "[SUCCESS] Build completed successfully."
echo "[INFO] dist folder was cleared before packaging."
echo "[INFO] VSIX packages are written to the dist folder and copied to this folder."
echo
