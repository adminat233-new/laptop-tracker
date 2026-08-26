@echo off
title Laptop Tracker - Public Tunnel
color 0B

echo ========================================
echo    CLOUDFLARE TUNNEL - PUBLIC ACCESS
echo ========================================
echo.
echo This will create a public URL for your laptop tracker.
echo.
echo 1. First, start the tracker server (run start.bat)
echo 2. Then run this script to get a public URL
echo.
echo ========================================
echo.

:: Check if cloudflared is installed
where cloudflared >nul 2>&1
if %errorlevel% neq 0 (
    echo [*] Cloudflared not found. Installing...
    echo.
    
    :: Download cloudflared
    echo [*] Downloading cloudflared...
    powershell -Command "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '%USERPROFILE%\cloudflared.exe'"
    
    if exist "%USERPROFILE%\cloudflared.exe" (
        echo [+] Cloudflared installed successfully!
        set CLOUDFLARED=%USERPROFILE%\cloudflared.exe
    ) else (
        echo [-] Failed to install cloudflared.
        echo [*] Manual install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/
        pause
        exit /b 1
    )
) else (
    set CLOUDFLARED=cloudflared
)

echo.
echo [*] Starting tunnel to localhost:9999...
echo [*] Your public URL will appear below:
echo.
echo ========================================
echo.

%CLOUDFLARED% tunnel --url http://localhost:9999

pause
