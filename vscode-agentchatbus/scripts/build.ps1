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

# 2. Compile
Write-Host "Compiling TypeScript..." -ForegroundColor Yellow
npm run compile
if ($LASTEXITCODE -ne 0) {
    Write-Error "Compilation failed."
    exit $LASTEXITCODE
}

# 3. Package
Write-Host "Packaging VSIX..." -ForegroundColor Yellow
& npx vsce package
if ($LASTEXITCODE -ne 0) {
    Write-Error "Packaging failed."
    exit $LASTEXITCODE
}

$pkgInfo = Get-Content "package.json" | ConvertFrom-Json
Write-Host "`nSuccessfully built: agentchatbus-$($pkgInfo.version).vsix" -ForegroundColor Green
Write-Host "To install: code --install-extension agentchatbus-$($pkgInfo.version).vsix"
