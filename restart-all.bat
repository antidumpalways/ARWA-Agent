@echo off
REM Restart all 4 ARWA services. Run from anywhere.

set ROOT=C:\Users\Acer\Downloads\hack\ARWA-Agent\agent

echo Killing any existing node processes...
taskkill /F /IM node.exe 2>nul
timeout /t 2 >nul

echo Starting services...

REM MCP
start "ARWA-MCP" cmd /c "set CSPR_TRADE_NETWORK=testnet&& set CSPR_TRADE_TRANSPORT=http&& set CSPR_TRADE_PORT=3001&& cd /d %ROOT%\node_modules\@make-software\cspr-trade-mcp&& node dist\index.js"

REM x402
start "ARWA-x402" cmd /c "set PORT=4001&& cd /d %ROOT%&& node node_modules\tsx\dist\cli.mjs scripts\x402Server.ts"

REM Backend
start "ARWA-Backend" cmd /c "set PORT=4000&& cd /d %ROOT%&& node node_modules\tsx\dist\cli.mjs src\server.ts"

REM Frontend
start "ARWA-Frontend" cmd /c "cd /d %ROOT%&& node scripts\serve-frontend.js"

echo All services launched. Open browser to http://localhost:3000/?dashboard=1
timeout /t 3 >nul
