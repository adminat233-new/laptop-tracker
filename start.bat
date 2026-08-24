@echo off
title Laptop Tracker - Public Access
color 0A

echo ========================================
echo    LAPTOP TRACKER - PUBLIC ACCESS
echo ========================================
echo.

:: Set custom PIN (change this)
if not defined TRACKER_PIN set TRACKER_PIN=1234
if not defined PORT set PORT=7777

echo [*] Starting server on port %PORT%...
echo [*] PIN: %TRACKER_PIN%
echo.

:: Start the server in background
start /B node server.js

:: Wait for server to start
timeout /t 3 /nobreak >nul

echo ========================================
echo    SERVER STARTED!
echo ========================================
echo.
echo  LOCAL URL:   http://localhost:%PORT%
echo  NETWORK URL: Check console output above
echo.
echo  To make PUBLIC, run this in another terminal:
echo  cloudflared tunnel --url http://localhost:%PORT%
echo.
echo  Or use ngrok:
echo  ngrok http %PORT%
echo.
echo ========================================
echo  Press any key to stop server...
echo ========================================
pause >nul

:: Kill node processes
taskkill /F /IM node.exe >nul 2>&1
echo Server stopped.
