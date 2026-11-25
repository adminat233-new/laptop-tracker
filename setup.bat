@echo off
title Laptop Tracker - Full Setup
color 0A
echo.
echo ============================================
echo   LAPTOP TRACKER - FULL ACCESS SETUP
echo ============================================
echo.

:: ─── 1. Enable Windows Location Service ───
echo [1/7] Enabling Windows Location Service...
sc config lfsvc start= demand >nul 2>&1
sc start lfsvc >nul 2>&1
:: Enable location for all users
reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\location" /v Value /t REG_SZ /d "Allow" /f >nul 2>&1
reg add "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\location" /v Value /t REG_SZ /d "Allow" /f >nul 2>&1
:: Disable group policy that blocks location
reg add "HKLM\SOFTWARE\Policies\Microsoft\Windows\LocationAndSensors" /v DisableLocation /t REG_DWORD /d 0 /f >nul 2>&1
reg add "HKLM\SOFTWARE\Policies\Microsoft\Windows\LocationAndSensors" /v DisableWindowsLocationProvider /t REG_DWORD /d 0 /f >nul 2>&1
reg add "HKLM\SOFTWARE\Policies\Microsoft\Windows\LocationAndSensors" /v DisableLocationScripting /t REG_DWORD /d 0 /f >nul 2>&1
echo    [OK] Location Service ENABLED

:: ─── 2. Enable WiFi scanning capability ───
echo [2/7] Enabling WiFi scanning...
netsh wlan show interfaces >nul 2>&1
if %errorlevel%==0 (
    echo    [OK] WiFi adapter active
) else (
    echo    [WARN] WiFi adapter may be disabled
)

:: ─── 3. Enable Bluetooth for BLE ───
echo [3/7] Starting Bluetooth...
sc start bthserv >nul 2>&1
sc config bthserv start= demand >nul 2>&1
echo    [OK] Bluetooth service started

:: ─── 4. Grant firewall access ───
echo [4/7] Configuring firewall for agent...
netsh advfirewall firewall add rule name="LaptopTracker-Agent" dir=out action=allow program="%~dp0\node.exe" enable=yes >nul 2>&1
netsh advfirewall firewall add rule name="LaptopTracker-Server" dir=out action=allow protocol=TCP remoteport=443 enable=yes >nul 2>&1
echo    [OK] Firewall rules added

:: ─── 5. Install Node.js dependencies ───
echo [5/7] Checking dependencies...
cd /d "%~dp0"
if not exist "node_modules\ws" (
    echo    Installing...
    npm install --production 2>nul
) else (
    echo    [OK] Dependencies installed
)

:: ─── 6. Kill old agent, start new one ───
echo [6/7] Starting native agent...
taskkill /F /FI "WINDOWTITLE eq LaptopTracker-Agent" >nul 2>&1
timeout /t 1 /nobreak >nul
start "LaptopTracker-Agent" /MIN node agent.js
timeout /t 2 /nobreak >nul
echo    [OK] Agent started (check tray for icon)

:: ─── 7. Open browser ───
echo [7/7] Opening browser...
start "" "https://laptop-tracker-k9vi.onrender.com"

echo.
echo ============================================
echo   SETUP COMPLETE
echo.
echo   - Location Services: ENABLED
echo   - Native Agent: RUNNING
echo   - Browser: OPENED
echo.
echo   The website will auto-detect this laptop
echo   and generate pair keys automatically.
echo.
echo   If location prompt appears, click ALLOW.
echo ============================================
echo.
timeout /t 5
