@echo off
REM start-all.bat - launch all 4 ARWA services in background windows.
REM Each service runs in its own minimized CMD window.
REM Browser once up: http://localhost:3000/?dashboard=1

cd /d "C:\Users\Acer\Downloads\hack\ARWA-Agent\agent"

echo Starting ARWA services (4 background windows will appear)...

REM 1. CSPR.trade MCP (port 3001)
start "ARWA-MCP" /MIN cmd /c "set CSPR_TRADE_NETWORK=testnet& set CSPR_TRADE_TRANSPORT=http& set CSPR_TRADE_PORT=3001& node node_modules\@make-software\cspr-trade-mcp\dist\index.js"

REM 2. x402 Signal (port 4001)
start "ARWA-x402" /MIN cmd /c "set PORT=4001& node node_modules\tsx\dist\cli.mjs scripts\x402Server.ts"

REM 3. ARWA Backend (port 4000)
start "ARWA-Backend" /MIN cmd /c "set PORT=4000& node node_modules\tsx\dist\cli.mjs src\server.ts"

REM 4. Frontend (port 3000)
start "ARWA-Frontend" /MIN cmd /c "node scripts\serve-frontend.js"

echo.
echo ============================================
echo  All 4 services launched in background.
echo  Open browser:  http://localhost:3000/?dashboard=1
echo.
echo  Close the 4 background CMD windows to stop,
echo  OR run from PowerShell:
echo    Get-Process node ^| Stop-Process -Force
echo ============================================
timeout /t 5 >nul
