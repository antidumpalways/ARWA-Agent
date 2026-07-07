# start-4-windows.ps1
# Opens 4 PowerShell windows with ARWA services.
# Run from PowerShell:  powershell -NoProfile -ExecutionPolicy Bypass -File start-4-windows.ps1

$ROOT = "C:\Users\Acer\Downloads\hack\ARWA-Agent\agent"

Write-Host "Killing any existing node processes..."
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

Write-Host "Launching 4 ARWA PowerShell windows..."

# Window 1: CSPR.trade MCP (port 3001)
$cmd1 = 'cd /d "' + $ROOT + '\node_modules\@make-software\cspr-trade-mcp" && set CSPR_TRADE_NETWORK=testnet && set CSPR_TRADE_TRANSPORT=http && set CSPR_TRADE_PORT=3001 && node dist\index.js'
Start-Process -FilePath "cmd.exe" -ArgumentList "/k title ARWA-1-MCP-CSPR.trade && $cmd1" -WindowStyle Normal

# Window 2: x402 Signal (port 4001)
$cmd2 = 'cd /d "' + $ROOT + '" && set PORT=4001 && node node_modules\tsx\dist\cli.mjs scripts\x402Server.ts'
Start-Process -FilePath "cmd.exe" -ArgumentList "/k title ARWA-2-x402-Signal && $cmd2" -WindowStyle Normal

# Window 3: ARWA Backend (port 4000) - KEY WINDOW
$cmd3 = 'cd /d "' + $ROOT + '" && set PORT=4000 && node node_modules\tsx\dist\cli.mjs src\server.ts'
Start-Process -FilePath "cmd.exe" -ArgumentList "/k title ARWA-3-Backend-LOGS_HERE && $cmd3" -WindowStyle Normal

# Window 4: Frontend (port 3000)
$cmd4 = 'cd /d "' + $ROOT + '" && node scripts\serve-frontend.js'
Start-Process -FilePath "cmd.exe" -ArgumentList "/k title ARWA-4-Frontend && $cmd4" -WindowStyle Normal

Write-Host ""
Write-Host "==========================================================="
Write-Host " 4 PowerShell windows launched."
Write-Host " Look for ARWA-1..ARWA-4 in your taskbar."
Write-Host " Browser: http://localhost:3000/?dashboard=1"
Write-Host "==========================================================="
Start-Sleep -Seconds 3
