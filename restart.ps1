# restart.ps1
# One-shot restart script for AgentChatBus.
# Usage (from project root):  .\restart.ps1
# Usage (custom port):        .\restart.ps1 -Port 8080
# Usage (network access):     .\restart.ps1 -Host 0.0.0.0  # Exposes to network (USE WITH CAUTION!)

param(
    [string]$Host = "0.0.0.0",  # Default: 0.0.0.0 binds to all network interfaces (CAUTION: security risk!)
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

Write-Host "🚀 Starting AgentChatBus on $Host:$Port..." -ForegroundColor Green
if ($Host -eq "0.0.0.0") {
    Write-Host "⚠️  WARNING: Binding to 0.0.0.0 exposes the API to all network interfaces!" -ForegroundColor Red
    Write-Host "   This may allow unauthorized access from other machines on your network." -ForegroundColor Red
    Write-Host "   For local-only access, use -Host 127.0.0.1" -ForegroundColor Red
}
$env:AGENTCHATBUS_HOST = $Host
$env:AGENTCHATBUS_PORT = $Port
.venv\Scripts\python -m src.main
