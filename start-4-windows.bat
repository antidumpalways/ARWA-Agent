@echo off
REM start-4-windows.bat
REM Opens 4 PowerShell windows with ARWA services.
REM Each window has a labeled title. Close any to stop that service.
REM Or run from PowerShell: Get-Process node ^| Stop-Process -Force

set ROOT=C:\Users\Acer\Downloads\hack\ARWA-Agent\agent

echo Killing any existing node processes...
taskkill /F /IM node.exe 2>nul
timeout /t 2 >nul

echo Launching 4 ARWA PowerShell windows...

REM Window 1: CSPR.trade MCP (port 3001)
start "ARWA-1-MCP" /D "%ROOT%\node_modules\@make-software\cspr-trade-mcp" cmd /k "set CSPR_TRADE_NETWORK=testnet&& set CSPR_TRADE_TRANSPORT=http&& set CSPR_TRADE_PORT=3001&& title ARWA-1-MCP-CSPR.trade && node dist\index.js"

REM Window 2: x402 Signal (port 4001)
start "ARWA-2-x402" /D "%ROOT%" cmd /k "set PORT=4001&& title ARWA-2-x402-Signal && node node_modules\tsx\dist\cli.mjs scripts\x402Server.ts"

REM Window 3: ARWA Backend (port 4000) - KEY WINDOW FOR DEMO
start "ARWA-3-Backend" /D "%ROOT%" cmd /k "set PORT=4000&& title ARWA-3-Backend-LOGS_HERE && node node_modules\tsx\dist\cli.mjs src\server.ts"

REM Window 4: Frontend (port 3000)
start "ARWA-4-Frontend" /D "%ROOT%" cmd /k "title ARWA-4-Frontend && node scripts\serve-frontend.js"

echo.
echo ===========================================================
echo  4 PowerShell windows launched.
echo  Look for ARWA-1..ARWA-4 in your taskbar.
echo  Browser: http://localhost:3000/?dashboard=1
echo.
echo  Deposit simulation now runs from the dashboard's
echo  "Trigger Deposit & Run Cycle" button (no separate
echo  Terminal 5 needed).
echo ===========================================================
timeout /t 3 >nul
