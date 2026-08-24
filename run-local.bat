@echo off
title LAPTOP TRACKER - Full Control
color 0A
cls

echo ============================================
echo    LAPTOP TRACKER - REAL HARDWARE CONTROL
echo ============================================
echo.
echo  This runs LOCALLY on your laptop for:
echo  - Real CPU/RAM/Battery stats
echo  - Real alarm sounds through speakers
echo  - Real lock/shutdown control
echo  - Real location tracking
echo.
echo ============================================
echo.

:: Kill any existing node processes
taskkill /F /IM node.exe >nul 2>&1

:: Set PIN
set TRACKER_PIN=1234

echo [1/2] Starting local server on port 9999...
start /B cmd /c "cd /d "%~dp0" && node server.js"

:: Wait for server to start
timeout /t 3 /nobreak >nul

echo [2/2] Starting public tunnel...
echo.
echo ============================================
echo    YOUR PUBLIC URL (use on phone):
echo ============================================
echo.

:: Start SSH tunnel to serveo.net
ssh -o StrictHostKeyChecking=no -R 80:localhost:9999 serveo.net

pause
