param(
    [string]$ListenHost = $(if ($env:AGENTCHATBUS_HOST) { $env:AGENTCHATBUS_HOST } else { "127.0.0.1" }),
    [int]$Port = $(if ($env:AGENTCHATBUS_PORT) { [int]$env:AGENTCHATBUS_PORT } else { 35765 })
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$EntryPoint = Join-Path $ScriptDir "dist\cli\index.js"

node $EntryPoint serve "--host=$ListenHost" "--port=$Port"
exit $LASTEXITCODE
