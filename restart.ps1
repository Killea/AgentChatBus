# restart.ps1
# One-shot restart script for AgentChatBus.
# Usage (from project root):  .\restart.ps1
# Usage (custom port):        .\restart.ps1 -Port 8080

param(
    [int]$Port = 39765
)

Set-Location $PSScriptRoot

Write-Host "🛑 Stopping AgentChatBus (port $Port)..." -ForegroundColor Yellow

# Kill any Python process running src.main
Get-Process python -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*src.main*" } |
    Stop-Process -Force -ErrorAction SilentlyContinue

# Kill anything still holding the port
Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess |
    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }

Start-Sleep -Milliseconds 500

Write-Host "🚀 Starting AgentChatBus on port $Port..." -ForegroundColor Green
$env:AGENTCHATBUS_PORT = $Port
.venv\Scripts\python -m src.main
