# restart.ps1
# One-shot restart script for AgentChatBus.
# Usage (from project root):  .\restart.ps1
# Usage (custom port):        .\restart.ps1 -Port 8080

param(
    [int]$Port = 39765
)

Set-Location $PSScriptRoot

Write-Host "🛑 Stopping AgentChatBus (port $Port)..." -ForegroundColor Yellow

# Kill the entire process tree of any Python running src.main
# (uvicorn --reload spawns a reloader parent + child worker; taskkill /T kills both)
$pids = Get-Process python -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*src.main*" } |
    Select-Object -ExpandProperty Id

foreach ($p in $pids) {
    taskkill /PID $p /F /T 2>$null | Out-Null
}

# Also free the port in case a stray process is still holding it
Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess |
    ForEach-Object { taskkill /PID $_ /F /T 2>$null | Out-Null }

Start-Sleep -Milliseconds 800

Write-Host "🚀 Starting AgentChatBus on port $Port..." -ForegroundColor Green
$env:AGENTCHATBUS_PORT = $Port
.venv\Scripts\python -m src.main
