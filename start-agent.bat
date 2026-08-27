@echo off
:: FIND Agent Auto-Start - kills old processes and starts fresh
taskkill /F /IM node.exe /FI "WINDOWTITLE eq find-agent*" >nul 2>&1
timeout /t 1 /nobreak >nul

:: Kill any existing agent processes (by command line)
for /f "tokens=2" %%a in ('tasklist /fi "imagename eq node.exe" /v /fo list ^| findstr "PID"') do (
    wmic process where "ProcessId=%%a" get CommandLine 2>nul | findstr "agent.js" >nul && taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

:: Start the agent
cd /d "%~dp0"
node agent.js
