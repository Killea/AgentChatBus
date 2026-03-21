<#
.SYNOPSIS
    Build and package the AgentChatBus VS Code extension with automatic version bumping.
    
.DESCRIPTION
    This script performs the following:
    1. Bumps the version (patch by default) in package.json.
    2. Runs 'npm run compile'.
    3. Packages the extension into a .vsix file.
    
.EXAMPLE
    .\build.ps1 -bump patch
#>

param (
    [ValidateSet("patch", "minor", "major", "none")]
    [string]$bump = "patch"
)

# Set working directory to the extension root (parent of the scripts folder)
$PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ExtensionRoot = Split-Path -Parent $PSScriptRoot
Set-Location -Path $ExtensionRoot

Write-Host "--- AgentChatBus Extension Builder ---" -ForegroundColor Cyan

# 1. Version Bumping
if ($bump -ne "none") {
    Write-Host "Bumping version ($bump)..." -ForegroundColor Yellow
    & npm version $bump --no-git-tag-version
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to bump version."
        exit $LASTEXITCODE
    }
}

# 1.5 Sync extension version -> repo version metadata
Write-Host "Syncing extension version into agentchatbus-ts and pyproject.toml..." -ForegroundColor Yellow
node .\scripts\sync-versions.mjs
if ($LASTEXITCODE -ne 0) {
    Write-Error "Version sync failed."
    exit $LASTEXITCODE
}

# 2. Compile
Write-Host "Compiling TypeScript..." -ForegroundColor Yellow
npm run compile
if ($LASTEXITCODE -ne 0) {
    Write-Error "Compilation failed."
    exit $LASTEXITCODE
}

# 3. Package
$distDir = Join-Path $ExtensionRoot "dist"
if (Test-Path $distDir) {
    Write-Host "Clearing dist directory..." -ForegroundColor Yellow
    Get-ChildItem -Path $distDir -Force | Remove-Item -Recurse -Force
} else {
    New-Item -ItemType Directory -Force -Path $distDir | Out-Null
}

$pkgInfo = Get-Content "package.json" | ConvertFrom-Json
$vsixPath = Join-Path $distDir "agentchatbus-$($pkgInfo.version).vsix"
$rootVsixPath = Join-Path $ExtensionRoot "agentchatbus-$($pkgInfo.version).vsix"

Write-Host "Packaging VSIX..." -ForegroundColor Yellow
& npx vsce package --out $vsixPath
if ($LASTEXITCODE -ne 0) {
    Write-Error "Packaging failed."
    exit $LASTEXITCODE
}

Write-Host "Copying VSIX to extension root..." -ForegroundColor Yellow
Copy-Item -Path $vsixPath -Destination $rootVsixPath -Force

Write-Host "`nSuccessfully built: $vsixPath" -ForegroundColor Green
Write-Host "Copied to: $rootVsixPath" -ForegroundColor Green
Write-Host "To install in VS Code: code --install-extension `"$vsixPath`""
Write-Host "To install in Cursor: cursor --install-extension `"$vsixPath`""
