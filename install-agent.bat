@echo off
setlocal enabledelayedexpansion
title Laptop Tracker Agent Installer
color 0A

echo ============================================
echo    Laptop Tracker Agent - Windows Installer
echo ============================================
echo.

:: Check for Node.js
echo [1/5] Checking for Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed or not in PATH.
    echo Download from: https://nodejs.org/
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo Found Node.js %NODE_VER%

:: Check for npm
where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: npm is not installed.
    pause
    exit /b 1
)

:: Set agent directory
set AGENT_DIR=%~dp0
set AGENT_DIR=%AGENT_DIR:~0,-1%

echo.
echo [2/5] Installing dependencies...
cd /d "%AGENT_DIR%"
call npm install ws --save 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Failed to install ws package.
    echo Try running: npm install ws --save
    pause
    exit /b 1
)
echo Dependencies installed.

:: Check for optional ffmpeg
echo.
echo [3/5] Checking optional components...
where ffmpeg >nul 2>&1
if %errorlevel% equ 0 (
    echo ffmpeg found - camera capture enabled
) else (
    echo ffmpeg not found - camera capture disabled
    echo          Install from: https://ffmpeg.org/download.html
)

:: Create startup script
echo.
echo [4/5] Creating startup script...
(
    echo @echo off
    echo cd /d "%AGENT_DIR%"
    echo node agent.js
    echo pause
) > "%AGENT_DIR%\start-agent.bat"
echo Created start-agent.bat

:: Register as scheduled task (auto-start on login)
echo.
echo [5/5] Registering auto-start task...
schtasks /delete /tn "LaptopTrackerAgent" /f >nul 2>&1
schtasks /create /tn "LaptopTrackerAgent" /tr "node \"%AGENT_DIR%\agent.js\"" /sc onlogon /rl highest /f >nul 2>&1
if %errorlevel% equ 0 (
    echo Auto-start task registered successfully.
) else (
    echo WARNING: Could not register auto-start task.
    echo          Run as Administrator for auto-start support.
)

:: Optional: Install as Windows Service via NSSM
echo.
echo To install as a Windows service, run this as Administrator:
echo   nssm install LaptopTracker "%AGENT_DIR%\start-agent.bat"
echo   nssm start LaptopTracker
echo.

echo ============================================
echo    Installation Complete!
echo ============================================
echo.
echo To start the agent now, run:
echo   start-agent.bat
echo.
echo Or run directly:
echo   node agent.js
echo.
echo Environment variables:
echo   SERVER_URL  - WebSocket server URL
echo               (default: wss://laptop-tracker-k9vi.onrender.com)
echo.
pause
