# start-services.ps1
# Starts MCP, x402, Backend, Frontend as fully detached processes.
# Run from PowerShell:  powershell -NoProfile -ExecutionPolicy Bypass -File start-services.ps1

$ROOT = "C:\Users\Acer\Downloads\hack\ARWA-Agent\agent"

Write-Host "Killing any existing node processes..."
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

# Window 1: CSPR.trade MCP (port 3001)
Start-Process -FilePath "cmd.exe" `
  -ArgumentList "/k cd /d `"$ROOT\node_modules\@make-software\cspr-trade-mcp`" && set CSPR_TRADE_NETWORK=testnet && set CSPR_TRADE_TRANSPORT=http && set CSPR_TRADE_PORT=3001 && title ARWA-1-MCP-CSPR.trade && node dist/index.js" `
  -WorkingDirectory "$ROOT" `
  -WindowStyle Normal

# Window 2: x402 Signal (port 4001)
Start-Process -FilePath "cmd.exe" `
  -ArgumentList "/k cd /d `"$ROOT`" && set PORT=4001 && title ARWA-2-x402-Signal && node node_modules\tsx\dist\cli.mjs scripts\x402Server.ts" `
  -WorkingDirectory "$ROOT" `
  -WindowStyle Normal

# Window 3: ARWA Backend (port 4000) - KEY WINDOW
Start-Process -FilePath "cmd.exe" `
  -ArgumentList "/k cd /d `"$ROOT`" && set PORT=4000 && title ARWA-3-Backend-LOGS_HERE && node node_modules\tsx\dist\cli.mjs src\server.ts" `
  -WorkingDirectory "$ROOT" `
  -WindowStyle Normal

# Window 4: Frontend (port 3000)
Start-Process -FilePath "cmd.exe" `
  -ArgumentList "/k cd /d `"$ROOT`" && title ARWA-4-Frontend && node scripts\serve-frontend.js" `
  -WorkingDirectory "$ROOT" `
  -WindowStyle Normal

Write-Host ""
Write-Host "==========================================================="
Write-Host " 4 ARWA services started."
Write-Host " Look for ARWA-1..ARWA-4 windows in taskbar."
Write-Host " Browser: http://localhost:3000/?dashboard=1"
Write-Host "==========================================================="
