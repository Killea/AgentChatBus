function Write-Usage {
    Write-Host @"
Usage:
  .\github-bump-version.bat <version|patch|minor|major> [--dry-run] [--publish] [--remote <name>] [--branch <name>]

Examples:
  .\github-bump-version.bat 0.2.6
  .\github-bump-version.bat patch
  .\github-bump-version.bat patch --dry-run
  .\github-bump-version.bat 0.2.6 --publish
"@
}

function Fail([string]$Message) {
    Write-Error $Message
    exit 1
}

function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    Push-Location $WorkingDirectory
    try {
        Invoke-Expression $Command
        if ($LASTEXITCODE -ne 0) {
            Fail "Command failed in ${WorkingDirectory}: $Command"
        }
    } finally {
        Pop-Location
    }
}

function Get-JsonVersion([string]$Path) {
    return (Get-Content $Path -Raw | ConvertFrom-Json).version
}

function Get-PyprojectVersion([string]$Path) {
    $content = Get-Content $Path -Raw
    $match = [regex]::Match($content, '^version = "([^"]+)"$', [System.Text.RegularExpressions.RegexOptions]::Multiline)
    if (-not $match.Success) {
        Fail "Could not find version in $Path"
    }
    return $match.Groups[1].Value
}

function Get-BusVersion([string]$Path) {
    $content = Get-Content $Path -Raw
    $match = [regex]::Match($content, 'export const BUS_VERSION = "([^"]+)";')
    if (-not $match.Success) {
        Fail "Could not find BUS_VERSION in $Path"
    }
    return $match.Groups[1].Value
}

function Is-SemVer([string]$Value) {
    return $Value -match '^\d+\.\d+\.\d+$'
}

function Resolve-NextVersion([string]$CurrentVersion, [string]$Target) {
    if ($Target -in @("patch", "minor", "major")) {
        $parts = $CurrentVersion.Split(".")
        if ($parts.Count -ne 3) {
            Fail "Invalid current version: $CurrentVersion"
        }
        $major = [int]$parts[0]
        $minor = [int]$parts[1]
        $patch = [int]$parts[2]

        if ($Target -eq "patch") {
            return "$major.$minor.$($patch + 1)"
        }
        if ($Target -eq "minor") {
            return "$major.$($minor + 1).0"
        }
        return "$($major + 1).0.0"
    }

    if (-not (Is-SemVer $Target)) {
        Fail "Target must be a semver like 0.2.6 or one of patch/minor/major. Received: $Target"
    }

    return $Target
}

function Get-CurrentBranch([string]$RepoRoot) {
    $branch = git -C $RepoRoot branch --show-current
    if ($LASTEXITCODE -ne 0) {
        Fail "Failed to determine current git branch."
    }
    return ($branch | Out-String).Trim()
}

function Ensure-PublishPreconditions(
    [string]$RepoRoot,
    [string]$Remote,
    [string]$Branch,
    [string]$NextVersion
) {
    $status = git -C $RepoRoot status --porcelain
    if ($LASTEXITCODE -ne 0) {
        Fail "Failed to read git worktree status."
    }
    if (($status | Out-String).Trim()) {
        Fail "Publish mode requires a clean git worktree before bumping. Commit or stash existing changes first."
    }

    $remotes = git -C $RepoRoot remote
    if ($LASTEXITCODE -ne 0) {
        Fail "Failed to read git remotes."
    }
    $remoteList = @($remotes | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($Remote -notin $remoteList) {
        Fail "Remote '$Remote' does not exist. Available remotes: $($remoteList -join ', ')"
    }

    $existingTag = git -C $RepoRoot tag --list "v$NextVersion"
    if ($LASTEXITCODE -ne 0) {
        Fail "Failed to inspect existing git tags."
    }
    if (($existingTag | Out-String).Trim() -eq "v$NextVersion") {
        Fail "Tag v$NextVersion already exists."
    }

    if (-not $Branch) {
        Fail "Branch name is missing."
    }
}

function Verify-SynchronizedVersion(
    [string]$ExpectedVersion,
    [string]$ExtensionPackagePath,
    [string]$TsPackagePath,
    [string]$PyprojectPath,
    [string]$TsEnvPath
) {
    $extensionVersion = Get-JsonVersion $ExtensionPackagePath
    $tsVersion = Get-JsonVersion $TsPackagePath
    $pyprojectVersion = Get-PyprojectVersion $PyprojectPath
    $tsEnvVersion = Get-BusVersion $TsEnvPath

    $mismatches = @()
    if ($extensionVersion -ne $ExpectedVersion) { $mismatches += "vscode-agentchatbus/package.json=$extensionVersion" }
    if ($tsVersion -ne $ExpectedVersion) { $mismatches += "agentchatbus-ts/package.json=$tsVersion" }
    if ($pyprojectVersion -ne $ExpectedVersion) { $mismatches += "deprecated_src/python_standalone/pyproject.toml=$pyprojectVersion" }
    if ($tsEnvVersion -ne $ExpectedVersion) { $mismatches += "agentchatbus-ts/src/core/config/env.ts=$tsEnvVersion" }

    if ($mismatches.Count -gt 0) {
        Fail "Version synchronization failed. Expected $ExpectedVersion. Found: $($mismatches -join ', ')"
    }
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot = Split-Path -Parent $ScriptDir
$ExtensionRoot = Join-Path $RepoRoot "vscode-agentchatbus"
$ExtensionPackagePath = Join-Path $ExtensionRoot "package.json"
$TsPackagePath = Join-Path $RepoRoot "agentchatbus-ts\package.json"
$PyprojectPath = Join-Path $RepoRoot "deprecated_src\python_standalone\pyproject.toml"
$TsEnvPath = Join-Path $RepoRoot "agentchatbus-ts\src\core\config\env.ts"

$Target = ""
$DryRun = $false
$Publish = $false
$Help = $false
$Remote = "origin"
$Branch = ""

for ($i = 0; $i -lt $args.Count; $i++) {
    $arg = $args[$i]
    switch ($arg) {
        "--dry-run" { $DryRun = $true; continue }
        "--publish" { $Publish = $true; continue }
        "--help" { $Help = $true; continue }
        "-h" { $Help = $true; continue }
        "/?" { $Help = $true; continue }
        "--remote" {
            if ($i + 1 -ge $args.Count) { Fail "--remote requires a value" }
            $i += 1
            $Remote = $args[$i]
            continue
        }
        "--branch" {
            if ($i + 1 -ge $args.Count) { Fail "--branch requires a value" }
            $i += 1
            $Branch = $args[$i]
            continue
        }
        default {
            if (-not $Target) {
                $Target = $arg
                continue
            }
            Fail "Unexpected argument: $arg"
        }
    }
}

if ($Help -or -not $Target) {
    Write-Usage
    if ($Help) { exit 0 }
    exit 1
}

$CurrentVersion = [string](Get-JsonVersion $ExtensionPackagePath)
if (-not (Is-SemVer $CurrentVersion)) {
    Fail "Current extension version is invalid: $CurrentVersion"
}

$NextVersion = Resolve-NextVersion $CurrentVersion $Target
if (-not $Branch) {
    $Branch = Get-CurrentBranch $RepoRoot
}

Write-Host "[bump-version] current version: $CurrentVersion"
Write-Host "[bump-version] target version: $NextVersion"
Write-Host "[bump-version] mode: $(if ($Target -in @('patch','minor','major')) { 'bump' } else { 'set' })"
Write-Host "[bump-version] publish: $(if ($Publish) { 'yes' } else { 'no' })"
Write-Host "[bump-version] remote: $Remote"
Write-Host "[bump-version] branch: $Branch"

if ($DryRun) {
    Write-Host "[bump-version] dry run only, no files were changed."
    Write-Host ""
    Write-Host "Planned commands:"
    Write-Host "  1. cd vscode-agentchatbus && npm version $Target --no-git-tag-version"
    Write-Host "  2. node .\vscode-agentchatbus\scripts\sync-versions.mjs"
    if ($Publish) {
        Write-Host "  3. git add <version files>"
        Write-Host "  4. git commit -m `"bump version to $NextVersion`""
        Write-Host "  5. git tag -a v$NextVersion -m `"Release v$NextVersion`""
        Write-Host "  6. git push $Remote $Branch"
        Write-Host "  7. git push $Remote v$NextVersion"
        Write-Host ""
        Write-Host "Result:"
        Write-Host "  Pushing the tag will trigger the GitHub release workflow."
        exit 0
    }
    Write-Host ""
    Write-Host "Suggested follow-up:"
    Write-Host "  git commit -am `"bump version to $NextVersion`""
    Write-Host "  git tag v$NextVersion"
    exit 0
}

if ($Publish) {
    Ensure-PublishPreconditions -RepoRoot $RepoRoot -Remote $Remote -Branch $Branch -NextVersion $NextVersion
}

Invoke-Step -Command "npm version $Target --no-git-tag-version" -WorkingDirectory $ExtensionRoot
Invoke-Step -Command "node .\scripts\sync-versions.mjs" -WorkingDirectory $ExtensionRoot

Verify-SynchronizedVersion `
    -ExpectedVersion $NextVersion `
    -ExtensionPackagePath $ExtensionPackagePath `
    -TsPackagePath $TsPackagePath `
    -PyprojectPath $PyprojectPath `
    -TsEnvPath $TsEnvPath

Write-Host "[bump-version] synchronized versions successfully."

if ($Publish) {
    Invoke-Step -Command "git add vscode-agentchatbus/package.json" -WorkingDirectory $RepoRoot
    Invoke-Step -Command "git add vscode-agentchatbus/package-lock.json" -WorkingDirectory $RepoRoot
    Invoke-Step -Command "git add agentchatbus-ts/package.json" -WorkingDirectory $RepoRoot
    Invoke-Step -Command "git add agentchatbus-ts/package-lock.json" -WorkingDirectory $RepoRoot
    Invoke-Step -Command "git add agentchatbus-ts/src/core/config/env.ts" -WorkingDirectory $RepoRoot
    Invoke-Step -Command "git add deprecated_src/python_standalone/pyproject.toml" -WorkingDirectory $RepoRoot
    Invoke-Step -Command "git commit -m `"bump version to $NextVersion`"" -WorkingDirectory $RepoRoot
    Invoke-Step -Command "git tag -a v$NextVersion -m `"Release v$NextVersion`"" -WorkingDirectory $RepoRoot
    Invoke-Step -Command "git push $Remote $Branch" -WorkingDirectory $RepoRoot
    Invoke-Step -Command "git push $Remote v$NextVersion" -WorkingDirectory $RepoRoot
    Write-Host "[bump-version] pushed commit and tag successfully."
    Write-Host "[bump-version] GitHub release workflow should now run for v$NextVersion."
    exit 0
}

Write-Host ""
Write-Host "Next commands:"
Write-Host "  git status --short"
Write-Host "  git commit -am `"bump version to $NextVersion`""
Write-Host "  git tag v$NextVersion"
Write-Host "  git push $Remote $Branch --follow-tags"
