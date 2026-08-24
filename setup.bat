@echo off
title LAPTOP TRACKER - Setup
color 0A
cls

echo ============================================
echo    LAPTOP TRACKER v2.0 - SETUP
echo ============================================
echo.
echo  This will:
echo  1. Start the cloud server (hosted)
echo  2. Generate a pair key
echo  3. Start the laptop agent
echo.
echo ============================================
echo.

:: Kill existing processes
taskkill /F /IM node.exe >nul 2>&1

:: Generate pair key
for /f "tokens=*" %%i in ('powershell -Command "[System.Guid]::NewGuid().ToString('N').Substring(0,8).ToUpper()"') do set PAIR_KEY=%%i

echo Generated Pair Key: %PAIR_KEY%
echo.
echo Save this key! You'll need it on your phone.
echo.

:: Start cloud server
echo [1/2] Starting cloud server...
set PORT=9999
start /B cmd /c "cd /d "%~dp0" && node cloud-server.js"
timeout /t 2 /nobreak >nul

:: Start laptop agent
echo [2/2] Starting laptop agent...
set CLOUD_SERVER=http://localhost:9999
start /B cmd /c "cd /d "%~dp0" && set PAIR_KEY=%PAIR_KEY%&& set CLOUD_SERVER=http://localhost:9999&& node agent.js"

echo.
echo ============================================
echo    BOTH SERVICES STARTED!
echo ============================================
echo.
echo  Open http://localhost:9999 on your phone
echo  Enter pair key: %PAIR_KEY%
echo.
echo  For public access, run in new terminal:
echo  ssh -R 80:localhost:9999 serveo.net
echo.
echo ============================================
echo.
pause
