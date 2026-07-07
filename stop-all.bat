@echo off
REM stop-all.bat
REM Closes all 4 ARWA windows and kills node processes.

echo Stopping all ARWA services...

REM Close the named PowerShell windows
taskkill /F /FI "WINDOWTITLE eq ARWA-1-MCP*" 2>nul
taskkill /F /FI "WINDOWTITLE eq ARWA-2-x402*" 2>nul
taskkill /F /FI "WINDOWTITLE eq ARWA-3-Backend*" 2>nul
taskkill /F /FI "WINDOWTITLE eq ARWA-4-Frontend*" 2>nul
taskkill /F /FI "WINDOWTITLE eq ARWA-5-Simulator*" 2>nul

REM Kill all node processes
taskkill /F /IM node.exe /T 2>nul

echo All ARWA services stopped.
timeout /t 2 >nul
