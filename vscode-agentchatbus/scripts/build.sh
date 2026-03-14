#!/bin/bash

# Build and package AgentChatBus with version bumping
# Usage: ./build.sh [patch|minor|major|none]

BUMP=${1:-patch}

# Move to extension root
cd "$(dirname "$0")/.."

echo "--- AgentChatBus Extension Builder ---"

if [ "$BUMP" != "none" ]; then
    echo "Bumping version ($BUMP)..."
    npm version $BUMP --no-git-tag-version || exit 1
fi

echo "Compiling TypeScript..."
npm run compile || exit 1

echo "Packaging VSIX..."
npx vsce package || exit 1

VERSION=$(node -p "require('./package.json').version")
echo -e "\nSuccessfully built: agentchatbus-$VERSION.vsix"
echo "To install: code --install-extension agentchatbus-$VERSION.vsix"
